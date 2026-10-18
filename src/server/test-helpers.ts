import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderKind, Role } from "../shared/protocol.js";

export async function makeHarnessFixture(api: ProviderKind = "chat") {
  const root = await mkdtemp(join(tmpdir(), "brawl-test-"));
  const workspace = join(root, "workspace");
  const dataDir = join(root, "data");
  await mkdir(workspace, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(workspace, "README.md"), "# Fixture\n");
  const providerId = "provider-test";
  const config = {
    providers: [
      {
        id: providerId,
        name: "Mock",
        baseUrl: "http://mock.invalid/v1",
        api,
        headers: {},
        models: ["mock-model"],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ],
    agents: {
      oracle: { role: "oracle", providerId, model: "mock-model", reasoningEffort: "high" },
      executor: { role: "executor", providerId, model: "mock-model", reasoningEffort: "medium" },
      speaker: { role: "speaker", providerId, model: "mock-model", reasoningEffort: "low" }
    },
    debateRounds: 2,
    shellTimeoutMs: 10_000,
    maxRunMs: 60_000,
    dataDir,
    workspace
  };
  await writeFile(join(dataDir, "config.yaml"), JSON.stringify(config));
  return { root, workspace, dataDir, providerId };
}

export function chatReply(input: {
  text?: string;
  calls?: Array<{ id?: string; name: string; arguments: Record<string, unknown> }>;
  summary?: string;
  usage?: { input: number; output: number; reasoning: number };
}) {
  const calls = input.calls ?? [];
  const deltas: any[] = [];
  if (input.summary) deltas.push({ delta: { reasoning_content: input.summary } });
  if (input.text) deltas.push({ delta: { content: input.text } });
  calls.forEach((call, index) => {
    deltas.push({
      delta: {
        tool_calls: [
          {
            index,
            id: call.id ?? `call-${index}`,
            function: {
              name: call.name,
              arguments: JSON.stringify(call.arguments)
            }
          }
        ]
      }
    });
  });
  deltas.push({ delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" });
  if (input.usage) deltas.push({ delta: {}, usage: input.usage });
  return [
    ...deltas.map((value) => ({ choices: [value] })),
    "[DONE]"
  ];
}

export function submitReviewReply(input: {
  workOrderId: string;
  decision?: "approve" | "reject";
  feedback?: string;
  failedCriteria?: string[];
}) {
  return chatReply({
    calls: [{
      name: "submit_review",
      arguments: {
        workOrderId: input.workOrderId,
        decision: input.decision ?? "approve",
        feedback: input.feedback ?? "The evidence satisfies the acceptance criteria.",
        failedCriteria: input.failedCriteria ?? []
      }
    }]
  });
}

export function mockFetch(
  responder: (role: Role, body: any) => any[],
  onRequest?: (role: Role, body: any) => void
): typeof fetch {
  const queuedResponses = new Map<Role, any[][]>();
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as any;
    const messages = JSON.stringify(body.messages ?? body.input ?? []);
    const role: Role = messages.includes("You are Oracle")
      ? "oracle"
      : messages.includes("You are Executor")
        ? "executor"
        : "speaker";
    onRequest?.(role, body);
    const queued = queuedResponses.get(role);
    let values = queued?.shift();
    if (!values) {
      const response = responder(role, body);
      if (Array.isArray(response[0])) {
        values = response[0] as any[];
        const remaining = response.slice(1) as any[][];
        if (remaining.length > 0) queuedResponses.set(role, remaining);
        else queuedResponses.delete(role);
      } else {
        values = response;
      }
    }
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const value of values) {
          const data = typeof value === "string" ? value : JSON.stringify(value);
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        }
        controller.close();
      }
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
}

export async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
