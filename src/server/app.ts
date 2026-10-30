import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { BrawlError } from "../shared/errors.js";
import {
  MODES,
  SANDBOX_MODES,
  PROVIDER_KINDS,
  REASONING_EFFORTS,
  ROLES,
  type AgentUpdate,
  type CreateSessionInput,
  type ProviderConfig,
  type ProviderDraft,
  type ReasoningEffort,
  type Session,
  type SendMessageInput,
  type StreamEnvelope
} from "../shared/protocol.js";
import { ConfigStore, redactProvider, type RuntimeOptions } from "./config.js";
import { SessionEvents } from "./events.js";
import { discoverModels, supportedEfforts } from "./provider.js";
import { Scheduler } from "./scheduler.js";
import { inspectBubblewrap } from "./sandbox.js";
import { Store } from "./store.js";
import {
  canonicalWorkspaceRoot,
  listWorkspaceDirectories,
  resolveSessionWorkspace
} from "./workspace.js";

export interface AppContext {
  runtime: RuntimeOptions;
  store: Store;
  configStore: ConfigStore;
  events: SessionEvents;
  scheduler: Scheduler;
}

export async function buildApp(runtime: RuntimeOptions, opts: { logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 2_000_000 });
  runtime.workspace = await canonicalWorkspaceRoot(runtime.workspace);
  const store = new Store(join(runtime.dataDir, "brawl.sqlite"));
  for (const session of store.listSessions()) {
    try {
      const workspace = await resolveSessionWorkspace(runtime.workspace, session.workspace);
      if (workspace !== session.workspace) {
        store.updateSession(session.id, { workspace });
      }
    } catch (error) {
      store.setStatus(
        session.id,
        "failed",
        `Unsafe or invalid workspace: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  store.restoreInterruptedSessions();
  const configStore = new ConfigStore(runtime.configPath, runtime.workspace);
  const events = new SessionEvents();
  const scheduler = new Scheduler({ store, configStore, events, runtime });
  const context: AppContext = { runtime, store, configStore, events, scheduler };
  if (!runtime.apiToken && !runtime.authDisabled) {
    throw new Error("Set BRAWL_API_TOKEN or explicitly set BRAWL_AUTH_DISABLED=true");
  }

  app.setErrorHandler((error, _request, reply) => {
    const status =
      error instanceof BrawlError
        ? error.statusCode
        : error instanceof z.ZodError
          ? 400
          : 500;
    const message = error instanceof Error ? error.message : String(error);
    reply.status(status).send({
      error: status === 500 ? "Internal server error" : message,
      ...(status === 500 ? {} : { detail: message })
    });
  });

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const pathname = request.url.split("?", 1)[0] ?? "";
    if (pathname === "/health" || !pathname.startsWith("/api/")) return;
    if (runtime.authDisabled) return;
    const header = request.headers.authorization;
    if (header !== `Bearer ${runtime.apiToken}`) {
      await reply.status(401).send({ error: "Unauthorized" });
      return reply;
    }
    if (request.method !== "GET" && request.headers.origin) {
      let originHost: string | null = null;
      try {
        originHost = new URL(request.headers.origin).host;
      } catch {
        // A malformed Origin cannot match the request host.
      }
      if (!originHost || originHost !== request.headers.host) {
        await reply.status(403).send({ error: "Origin not allowed" });
        return reply;
      }
    }
  });

  app.get("/health", async () => ({ ok: true }));
  app.get("/api/config", async () => configStore.publicView());
  app.get("/api/capabilities", async () => {
    const bubblewrap = await inspectBubblewrap();
    return {
      efforts: supportedEfforts(),
      providers: PROVIDER_KINDS,
      sandboxModes: SANDBOX_MODES,
      sandbox: bubblewrap,
      workspace: runtime.workspace
    };
  });

  app.post("/api/providers", async (request) => {
    const draft = providerSchema.parse(request.body) as ProviderDraft;
    if (hasCredentialHeaders(draft.headers)) {
      throw new BrawlError("Provider credentials must use apiKey or apiKeyEnv, not custom headers");
    }
    const now = new Date().toISOString();
    const provider: ProviderConfig = {
      ...draft,
      id: crypto.randomUUID(),
      headers: draft.headers ?? {},
      models: draft.models ?? [],
      createdAt: now,
      updatedAt: now
    };
    const next = configStore.get();
    next.providers.push(provider);
    configStore.save(next);
    return redactProvider(provider);
  });

  app.put("/api/providers/:id", async (request) => {
    const { id } = request.params as { id: string };
    const draft = providerSchema.partial().parse(request.body) as Partial<ProviderDraft>;
    const next = configStore.get();
    const current = next.providers.find((provider) => provider.id === id);
    if (!current) throw new BrawlError("Provider not found", 404);
    const { headers, ...fields } = draft;
    if (hasCredentialHeaders(headers)) {
      throw new BrawlError("Provider credentials must use apiKey or apiKeyEnv, not custom headers");
    }
    Object.assign(current, fields, {
      ...(headers === undefined ? {} : { headers }),
      updatedAt: new Date().toISOString()
    });
    configStore.save(next);
    return redactProvider(current);
  });

  app.delete("/api/providers/:id", async (request) => {
    const { id } = request.params as { id: string };
    const next = configStore.get();
    if (next.providers.some((provider) => provider.id === id)) {
      next.providers = next.providers.filter((provider) => provider.id !== id);
      for (const role of ROLES) {
        if (next.agents[role].providerId === id) next.agents[role].providerId = null;
      }
      configStore.save(next);
    }
    return { ok: true };
  });

  app.post("/api/providers/:id/models", async (request) => {
    const { id } = request.params as { id: string };
    const provider = configStore.provider(id);
    if (!provider) throw new BrawlError("Provider not found", 404);
    const models = await discoverModels(provider);
    const next = configStore.get();
    const stored = next.providers.find((item) => item.id === id);
    if (stored) stored.models = models;
    configStore.save(next);
    return { models };
  });

  app.put("/api/agents/:role", async (request) => {
    const role = String((request.params as { role: string }).role);
    if (!ROLES.includes(role as (typeof ROLES)[number])) throw new BrawlError("Invalid role");
    const input = agentSchema.parse(request.body) as AgentUpdate;
    if (input.providerId && !configStore.provider(input.providerId)) {
      throw new BrawlError("Provider not found", 404);
    }
    configStore.setAgent(role as (typeof ROLES)[number], input);
    return configStore.publicView();
  });

  app.put("/api/config/limits", async (request) => {
    const parsed = limitsSchema.parse(request.body);
    const input = Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => value !== undefined)
    );
    configStore.setLimits(input);
    return configStore.publicView();
  });

  app.get("/api/sessions", async () => ({ sessions: store.listSessions() }));
  app.get("/api/workspace/directories", async (request) => {
    const input = z
      .object({ path: z.string().default(".") })
      .parse(request.query);
    return listWorkspaceDirectories(runtime.workspace, input.path);
  });
  app.post("/api/sessions", async (request) => {
    const input = sessionSchema.parse(request.body) as CreateSessionInput;
    const mode = input.mode ?? "productive";
    if (mode === "fun" && input.sandboxMode === "auto-review") {
      throw new BrawlError("auto-review sandbox mode is only available in productive mode");
    }
    const workspace = await resolveSessionWorkspace(
      runtime.workspace,
      input.workspace || runtime.workspace
    );
    const session = store.createSession({
      title: input.title || "New session",
      mode,
      sandboxMode: input.sandboxMode ?? "enabled",
      workspace
    });
    return store.sessionDetail(session.id);
  });
  app.get("/api/sessions/:id", async (request) => {
    const { id } = request.params as { id: string };
    const detail = store.sessionDetail(id);
    if (!detail) throw new BrawlError("Session not found", 404);
    return detail;
  });
  app.delete("/api/sessions/:id", async (request) => {
    const { id } = request.params as { id: string };
    if (!store.getSession(id)) throw new BrawlError("Session not found", 404);
    scheduler.stop(id);
    if (!store.deleteSession(id)) throw new BrawlError("Session not found", 404);
    events.publish(id, { type: "session_deleted", sessionId: id });
    return { ok: true };
  });
  app.post("/api/sessions/:id/messages", async (request) => {
    const { id } = request.params as { id: string };
    const input = messageSchema.parse(request.body) as SendMessageInput;
    const session = store.getSession(id);
    if (!session) throw new BrawlError("Session not found", 404);
    if (!scheduler.isRunning(id)) {
      await scheduler.start(id, input.content, session.mode);
    } else {
      scheduler.userMessage(id, input.content);
    }
    return { ok: true };
  });
  app.post("/api/sessions/:id/guidance", async (request) => {
    const { id } = request.params as { id: string };
    const input = messageSchema.parse(request.body) as SendMessageInput;
    scheduler.userGuidance(id, input.content);
    return { ok: true };
  });
  app.post("/api/sessions/:id/pause", async (request) => {
    const { id } = request.params as { id: string };
    scheduler.pause(id);
    return { ok: true };
  });
  app.post("/api/sessions/:id/resume", async (request) => {
    const { id } = request.params as { id: string };
    const session = store.getSession(id);
    if (!session) throw new BrawlError("Session not found", 404);
    await scheduler.resume(id, session.mode);
    return { ok: true };
  });
  app.patch("/api/sessions/:id", async (request) => {
    const { id } = request.params as { id: string };
    const input = z
      .object({
        mode: z.enum(MODES).optional(),
        sandboxMode: z.enum(SANDBOX_MODES).optional(),
        title: z.string().min(1).max(120).optional()
      })
      .parse(request.body);
    const session = store.getSession(id);
    if (!session) throw new BrawlError("Session not found", 404);
    if (scheduler.isRunning(id)) {
      throw new BrawlError("Pause before changing mode or sandbox settings", 409);
    }
    const nextMode = input.mode ?? session.mode;
    const nextSandboxMode = input.sandboxMode ?? session.sandboxMode;
    if (nextMode === "fun" && nextSandboxMode === "auto-review") {
      throw new BrawlError("auto-review sandbox mode is only available in productive mode");
    }
    const patch: Partial<Pick<Session, "mode" | "sandboxMode" | "title">> = {};
    if (input.mode !== undefined) patch.mode = input.mode;
    if (input.sandboxMode !== undefined) patch.sandboxMode = input.sandboxMode;
    if (input.title !== undefined) patch.title = input.title;
    const next = store.updateSession(id, patch);
    store.appendEvent({
      sessionId: id,
      role: "system",
      type: "status",
      content: `Session changed: ${JSON.stringify(input)}`
    });
    return next;
  });
  app.get("/api/sessions/:id/stream", async (request, reply) => {
    const { id } = request.params as { id: string };
    const after = Number((request.query as { after?: string }).after ?? 0);
    if (!store.getSession(id)) throw new BrawlError("Session not found", 404);
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    let closed = false;
    let ready = false;
    let lastSeqSent = after;
    const buffered: StreamEnvelope[] = [];
    const send = (data: StreamEnvelope) => {
      if (closed) return;
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    const deliver = (data: StreamEnvelope) => {
      if (data.type === "event") {
        if (data.event.seq <= lastSeqSent) return;
        lastSeqSent = data.event.seq;
      }
      send(data);
    };
    const unsubscribe = events.subscribe(id, (data) => {
      if (!ready) buffered.push(data);
      else deliver(data);
    });
    const heartbeat = setInterval(
      () => send({ type: "heartbeat", at: new Date().toISOString() }),
      15_000
    );
    request.raw.on("close", () => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    });
    if (after === 0) {
      const detail = store.sessionDetail(id, 0);
      if (!detail) {
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        reply.raw.end();
        return;
      }
      send({ type: "snapshot", snapshot: detail });
      lastSeqSent = detail.session.lastSeq;
    } else {
      for (const event of store.events(id, after)) {
        if (event.seq <= lastSeqSent) continue;
        lastSeqSent = event.seq;
        send({ type: "event", event });
      }
    }
    ready = true;
    buffered.sort((left, right) => envelopeSeq(left) - envelopeSeq(right));
    for (const data of buffered.splice(0)) deliver(data);
  });

  const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../web");
  if (existsSync(webRoot)) {
    const fastifyStatic = await import("@fastify/static").catch(() => null);
    if (fastifyStatic) {
      await app.register(fastifyStatic.default, { root: webRoot });
      app.setNotFoundHandler(async (request, reply) => {
        if (request.url.startsWith("/api/")) {
          return reply.status(404).send({ error: "Not found" });
        }
        return reply.sendFile("index.html");
      });
    }
  }

  return { app, context };
}

const providerSchema = z.object({
  name: z.string().min(1).max(80),
  baseUrl: z.string().url(),
  api: z.enum(PROVIDER_KINDS),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().min(1).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  models: z.array(z.string()).optional()
});

const agentSchema = z.object({
  providerId: z.string().nullable(),
  model: z.string(),
  reasoningEffort: z.enum(REASONING_EFFORTS) as z.ZodType<ReasoningEffort>
});

const limitsSchema = z.object({
  debateRounds: z.number().int().min(1).max(30).optional(),
  shellTimeoutMs: z.number().int().min(1_000).max(3_600_000).optional(),
  maxRunMs: z.number().int().min(10_000).max(86_400_000).optional()
});

const sessionSchema = z.object({
  title: z.string().max(120).optional(),
  mode: z.enum(MODES).optional(),
  sandboxMode: z.enum(SANDBOX_MODES).optional(),
  workspace: z.string().min(1)
});

const messageSchema = z.object({ content: z.string().min(1).max(200_000) });

function envelopeSeq(envelope: StreamEnvelope): number {
  return envelope.type === "event" ? envelope.event.seq : Number.MAX_SAFE_INTEGER;
}

function hasCredentialHeaders(headers: Record<string, string> | undefined): boolean {
  return Object.keys(headers ?? {}).some((name) =>
    /^(authorization|proxy-authorization|x-api-key|api-key)$/i.test(name)
  );
}
