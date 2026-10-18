import type {
  CreateSessionInput,
  PublicHarnessConfig,
  Role,
  Session,
  SessionDetail,
  SandboxMode,
  StreamEnvelope
} from "../shared/protocol.js";
import { createSseParser } from "../shared/stream.js";

export interface ClientOptions {
  baseUrl: string;
  token: string;
}

export class HarnessClient {
  readonly baseUrl: string;
  readonly token: string;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
  }

  async config(): Promise<PublicHarnessConfig> {
    return this.request("/api/config");
  }

  async workspaceDirectories(path: string): Promise<{ path: string; directories: string[] }> {
    return this.request(`/api/workspace/directories?path=${encodeURIComponent(path)}`);
  }

  async sessions(): Promise<Session[]> {
    return (await this.request<{ sessions: Session[] }>("/api/sessions")).sessions;
  }

  async session(id: string): Promise<SessionDetail> {
    return this.request(`/api/sessions/${id}`);
  }

  async createSession(input: CreateSessionInput): Promise<SessionDetail> {
    return this.request("/api/sessions", {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  async send(id: string, content: string): Promise<void> {
    await this.request(`/api/sessions/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content })
    });
  }

  async guidance(id: string, content: string): Promise<void> {
    await this.request(`/api/sessions/${id}/guidance`, {
      method: "POST",
      body: JSON.stringify({ content })
    });
  }

  async pause(id: string): Promise<void> {
    await this.request(`/api/sessions/${id}/pause`, { method: "POST" });
  }

  async resume(id: string): Promise<void> {
    await this.request(`/api/sessions/${id}/resume`, { method: "POST" });
  }

  async updateMode(id: string, mode: Session["mode"]): Promise<void> {
    await this.request(`/api/sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ mode })
    });
  }

  async updateSandboxMode(id: string, sandboxMode: SandboxMode): Promise<Session> {
    return this.request<Session>(`/api/sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ sandboxMode })
    });
  }

  async updateAgent(
    role: Role,
    input: Pick<PublicHarnessConfig["agents"][Role], "providerId" | "model" | "reasoningEffort">
  ): Promise<void> {
    await this.request(`/api/agents/${role}`, {
      method: "PUT",
      body: JSON.stringify(input)
    });
  }

  stream(
    id: string,
    after: number,
    onEvent: (event: StreamEnvelope) => void,
    onError: (error: Error) => void
  ): () => void {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${this.baseUrl}/api/sessions/${id}/stream?after=${after}`, {
          headers: { authorization: `Bearer ${this.token}` },
          signal: controller.signal
        });
        if (!response.ok || !response.body) throw new Error(`Stream failed (${response.status})`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const parser = createSseParser((data) => {
          onEvent(JSON.parse(data) as StreamEnvelope);
        });
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            parser(decoder.decode(), true);
            break;
          }
          parser(decoder.decode(value, { stream: true }));
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          onError(error instanceof Error ? error : new Error(String(error)));
        }
      }
    })();
    return () => controller.abort();
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`,
        ...init.headers
      }
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string; detail?: string };
      throw new Error(body.detail || body.error || `Request failed (${response.status})`);
    }
    return (await response.json()) as T;
  }
}

export function applyEnvelope(
  current: SessionDetail | null,
  envelope: StreamEnvelope
): SessionDetail | null {
  if (!current) return envelope.type === "snapshot" ? envelope.snapshot : current;
  if (envelope.type === "snapshot") return envelope.snapshot;
  if (envelope.type === "session") return { ...current, session: envelope.session };
  if (envelope.type === "agent") {
    return {
      ...current,
      agents: current.agents.some((agent) => agent.role === envelope.agent.role)
        ? current.agents.map((agent) =>
            agent.role === envelope.agent.role ? envelope.agent : agent
          )
        : [...current.agents, envelope.agent]
    };
  }
  if (envelope.type === "proposal") {
    return { ...current, activeProposal: envelope.proposal };
  }
  if (envelope.type === "event") {
    if (current.events.some((event) => event.id === envelope.event.id)) return current;
    return {
      ...current,
      session: {
        ...current.session,
        lastSeq: Math.max(current.session.lastSeq, envelope.event.seq)
      },
      events: [...current.events, envelope.event]
    };
  }
  return current;
}
