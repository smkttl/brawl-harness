import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore, resolveRuntime } from "./config.js";
import { SessionEvents } from "./events.js";
import { Scheduler } from "./scheduler.js";
import { Store } from "./store.js";
import {
  chatReply,
  makeHarnessFixture,
  mockFetch,
  submitReviewReply,
  waitFor
} from "./test-helpers.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("scheduler", () => {
  it("answers every tool call when a boundary tool is batched with another call", async () => {
    const fixture = await makeHarnessFixture();
    const store = new Store(join(fixture.dataDir, "brawl.sqlite"));
    const session = store.createSession({
      title: "Tool call pairing",
      mode: "fun",
      sandboxMode: "disabled",
      workspace: fixture.workspace
    });
    let sawCompletePayload = false;
    let lastToolIds: string[] = [];
    let lastRequestedIds: string[] = [];
    globalThis.fetch = mockFetch((role, body) => {
      const toolMessages = (body.messages as Array<{ role: string; tool_call_id?: string }>).filter(
        (message) => message.role === "tool"
      );
      const assistant = (body.messages as Array<{
        role: string;
        tool_calls?: Array<{ id: string }>;
      }>).find((message) => message.role === "assistant" && message.tool_calls?.length);
      if (assistant) {
        const requested = assistant.tool_calls!.map((call) => call.id).sort();
        const answered = toolMessages.map((message) => message.tool_call_id!).sort();
        lastRequestedIds = requested;
        lastToolIds = answered;
        sawCompletePayload = true;
      }
      if (role === "speaker" && !sawCompletePayload) {
        return [
          chatReply({
            calls: [
              {
                id: "call-steer",
                name: "send_steer",
                arguments: {
                  to: "oracle",
                  content: "Use the user's exact request.",
                  urgent: true
                }
              },
              {
                id: "call-plan",
                name: "submit_plan",
                arguments: { content: "This call must not run after the steering boundary." }
              }
            ]
          })
        ];
      }
      return [chatReply({ text: "Acknowledged." })];
    });
    const runtime = resolveRuntime({
      dataDir: fixture.dataDir,
      workspace: fixture.workspace,
      apiToken: "secret",
      authDisabled: false
    });
    const scheduler = new Scheduler({
      store,
      configStore: new ConfigStore(runtime.configPath, fixture.workspace),
      events: new SessionEvents(),
      runtime
    });
    try {
      await scheduler.start(session.id, "Create a file.", "productive");
      await waitFor(() => sawCompletePayload, 5_000);
      expect(lastToolIds).toEqual(lastRequestedIds);
      expect(
        store.events(session.id).some(
          (event) => event.type === "plan" && event.content.includes("must not run")
        )
      ).toBe(false);
    } finally {
      scheduler.stop(session.id);
      store.close();
    }
  });

  it("runs the steered role instead of ending with pending steering", async () => {
    const fixture = await makeHarnessFixture();
    const store = new Store(join(fixture.dataDir, "brawl.sqlite"));
    const session = store.createSession({
      title: "Steer delivery",
      mode: "fun",
      sandboxMode: "disabled",
      workspace: fixture.workspace
    });
    let oracleCalls = 0;
    let speakerCalls = 0;
    globalThis.fetch = mockFetch((role, body) => {
      const serialized = JSON.stringify(body.messages);
      if (role === "speaker" && !serialized.includes("Relay the user's exact requirements")) {
        return [chatReply({ text: "The user said: write a hello file." })];
      }
      if (role === "oracle" && oracleCalls++ === 0) {
        return [
          chatReply({
            calls: [
              {
                name: "send_steer",
                arguments: {
                  to: "speaker",
                  content: "Relay the user's exact requirements before anyone plans.",
                  urgent: true
                }
              }
            ]
          })
        ];
      }
      if (role === "speaker" && speakerCalls++ === 0) {
        expect(serialized).toContain("Relay the user's exact requirements");
        return [chatReply({ text: "Oracle asks me to relay this: write a hello file." })];
      }
      return [chatReply({ text: "Acknowledged." })];
    });
    const runtime = resolveRuntime({
      dataDir: fixture.dataDir,
      workspace: fixture.workspace,
      apiToken: "secret",
      authDisabled: false
    });
    const scheduler = new Scheduler({
      store,
      configStore: new ConfigStore(runtime.configPath, fixture.workspace),
      events: new SessionEvents(),
      runtime
    });
    try {
      await scheduler.start(session.id, "Write a hello file.", "fun");
      await waitFor(
        () =>
          store.events(session.id).some(
            (event) =>
              event.role === "speaker" &&
              event.type === "agent_message" &&
              event.content.includes("write a hello file")
          ),
        5_000
      );
      expect(
        store.events(session.id).some(
          (event) => event.role === "oracle" && event.type === "steer"
        )
      ).toBe(true);
    } finally {
      scheduler.stop(session.id);
      store.close();
    }
  });

  it("completes a productive work order and records imported evidence", async () => {
    const fixture = await makeHarnessFixture();
    let oracleCalls = 0;
    let executorCalls = 0;
    let speakerCalls = 0;
    const store = new Store(join(fixture.dataDir, "brawl.sqlite"));
    const session = store.createSession({
      title: "Read fixture",
      mode: "productive",
      sandboxMode: "enabled",
      workspace: fixture.workspace
    });
    globalThis.fetch = mockFetch((role) => {
      if (role === "oracle" && oracleCalls++ === 0) {
        return [
          chatReply({
            calls: [
              {
                name: "submit_work_order",
                arguments: {
                  objective: "Read README and report its first word.",
                  constraints: ["Do not edit files."],
                  acceptanceCriteria: ["The report names the first word."]
                }
              }
            ]
          }),
          chatReply({ text: "Plan accepted." })
        ];
      }
      if (role === "executor" && executorCalls++ === 0) {
        return [
          chatReply({
            calls: [{ name: "workspace_read", arguments: { path: "README.md" } }]
          }),
          chatReply({ text: "The first word is Fixture." })
        ];
      }
      if (role === "oracle") {
        return [submitReviewReply({ workOrderId: store.workOrders(session.id)[0]!.id })];
      }
      if (role === "speaker" && speakerCalls++ === 0) {
        return [chatReply({ text: "The README starts with **Fixture**." })];
      }
      return [chatReply({ text: "Complete." })];
    });
    const runtime = resolveRuntime({
      dataDir: fixture.dataDir,
      workspace: fixture.workspace,
      apiToken: "secret",
      authDisabled: false
    });
    const configStore = new ConfigStore(runtime.configPath, fixture.workspace);
    const scheduler = new Scheduler({
      store,
      configStore,
      events: new SessionEvents(),
      runtime
    });
    try {
      await scheduler.start(session.id, "What is the first word in README.md?", "productive");
      await waitFor(() => store.getSession(session.id)?.status === "idle");
      const detail = store.sessionDetail(session.id)!;
      expect(detail.workOrders[0]?.status).toBe("reviewed");
      expect(
        detail.events.some(
          (event) => event.type === "tool_result" && event.content.includes("Fixture")
        )
      ).toBe(true);
      expect(
        detail.events.some(
          (event) => event.role === "speaker" && event.content.includes("Fixture")
        )
      ).toBe(true);
    } finally {
      scheduler.stop(session.id);
      store.close();
    }
  });

  it("runs ordinary auto-review commands without calling Oracle", async () => {
    const fixture = await makeHarnessFixture();
    let oracleCalls = 0;
    let executorCalls = 0;
    const store = new Store(join(fixture.dataDir, "brawl.sqlite"));
    const session = store.createSession({
      title: "Auto review approval",
      mode: "productive",
      sandboxMode: "auto-review",
      workspace: fixture.workspace
    });
    globalThis.fetch = mockFetch((role, body) => {
      if (role === "oracle") {
        oracleCalls += 1;
        if (String(body.messages?.[0]?.content ?? "").includes("ephemeral sandbox reviewer")) {
          throw new Error("Ordinary sandboxed commands must not be reviewed");
        }
        if (oracleCalls === 1) {
          return [
            chatReply({
              calls: [
                {
                  name: "submit_work_order",
                  arguments: {
                    objective: "Run a harmless workspace command.",
                    constraints: ["Use only workspace files."],
                    acceptanceCriteria: ["Command succeeds."]
                  }
                }
              ]
            })
          ];
        }
        return [submitReviewReply({ workOrderId: store.workOrders(session.id)[0]!.id })];
      }
      if (role === "executor" && executorCalls++ === 0) {
        return [
          chatReply({
            calls: [
              {
                name: "shell_exec",
                arguments: {
                  command: "printf reviewed > reviewed.txt",
                  execution: "sandboxed"
                }
              }
            ]
          }),
          chatReply({ text: "The reviewed command succeeded." })
        ];
      }
      return [chatReply({ text: "Complete." })];
    });
    const runtime = resolveRuntime({
      dataDir: fixture.dataDir,
      workspace: fixture.workspace,
      apiToken: "secret",
      authDisabled: false
    });
    const scheduler = new Scheduler({
      store,
      configStore: new ConfigStore(runtime.configPath, fixture.workspace),
      events: new SessionEvents(),
      runtime
    });
    try {
      await scheduler.start(session.id, "Create reviewed.txt.", "productive");
      await waitFor(() => store.getSession(session.id)?.status === "idle");
      const detail = store.sessionDetail(session.id)!;
      expect(detail.events.filter((event) => event.type === "tool_call")).toHaveLength(1);
      expect(detail.events.filter((event) => event.type === "tool_result")).toHaveLength(1);
      expect(detail.events.some((event) => event.content.includes("ephemeral Oracle sandbox reviewer"))).toBe(false);
      expect(detail.events.some((event) => event.content.includes("Read-only command."))).toBe(false);
      expect(await readFile(join(fixture.workspace, "reviewed.txt"), "utf8")).toBe("reviewed");
    } finally {
      scheduler.stop(session.id);
      store.close();
    }
  });

  it("refuses a denied command and records only the refusal", async () => {
    const fixture = await makeHarnessFixture();
    let oracleCalls = 0;
    let executorCalls = 0;
    const store = new Store(join(fixture.dataDir, "brawl.sqlite"));
    const session = store.createSession({
      title: "Auto review denial",
      mode: "productive",
      sandboxMode: "auto-review",
      workspace: fixture.workspace
    });
    globalThis.fetch = mockFetch((role, body) => {
      if (role === "oracle") {
        oracleCalls += 1;
        if (String(body.messages?.[0]?.content ?? "").includes("ephemeral sandbox reviewer")) {
          return [chatReply({ text: '{"allow":false,"reason":"Network access is outside the work order."}' })];
        }
        if (oracleCalls === 1) {
          return [
            chatReply({
              calls: [
                {
                  name: "submit_work_order",
                  arguments: {
                    objective: "Check the workspace only.",
                    constraints: ["No network."],
                    acceptanceCriteria: ["Report any refused command."]
                  }
                }
              ]
            })
          ];
        }
        return [submitReviewReply({ workOrderId: store.workOrders(session.id)[0]!.id })];
      }
      if (role === "executor" && executorCalls++ === 0) {
        return [
          chatReply({
            calls: [
              {
                name: "shell_exec",
                arguments: {
                  command: "printf denied > denied.txt",
                  execution: "host",
                  hostReason: "The work order needs host execution."
                }
              }
            ]
          }),
          chatReply({ text: "The command was refused." })
        ];
      }
      return [chatReply({ text: "Complete." })];
    });
    const runtime = resolveRuntime({
      dataDir: fixture.dataDir,
      workspace: fixture.workspace,
      apiToken: "secret",
      authDisabled: false
    });
    const scheduler = new Scheduler({
      store,
      configStore: new ConfigStore(runtime.configPath, fixture.workspace),
      events: new SessionEvents(),
      runtime
    });
    try {
      await scheduler.start(session.id, "Do not access the network.", "productive");
      await waitFor(() => store.getSession(session.id)?.status === "idle");
      const result = store
        .events(session.id)
        .find((event) => event.type === "tool_result");
      expect(result?.data).toMatchObject({
        ok: false,
        sandboxReview: "refused",
        reason: "Network access is outside the work order."
      });
      expect(result?.content).toContain("Sandbox review refused");
      await expect(readFile(join(fixture.workspace, "denied.txt"))).rejects.toThrow();
    } finally {
      scheduler.stop(session.id);
      store.close();
    }
  });

  it.each([
    ["malformed", () => [chatReply({ text: "not json" })], "malformed sandbox review"],
    ["missing reason", () => [chatReply({ text: '{"allow":false}' })], "denied the command without a reason"],
    ["provider error", () => {
      throw new Error("provider unavailable");
    }, "Sandbox review failed"]
  ])("fails closed on %s review responses", async (_label, reviewResponse, expected) => {
    const fixture = await makeHarnessFixture();
    let oracleCalls = 0;
    let executorCalls = 0;
    const store = new Store(join(fixture.dataDir, "brawl.sqlite"));
    const session = store.createSession({
      title: "Fail closed",
      mode: "productive",
      sandboxMode: "auto-review",
      workspace: fixture.workspace
    });
    globalThis.fetch = mockFetch((role, body) => {
      if (role === "oracle") {
        oracleCalls += 1;
        if (String(body.messages?.[0]?.content ?? "").includes("ephemeral sandbox reviewer")) {
          return reviewResponse();
        }
        if (oracleCalls === 1) {
          return [
            chatReply({
              calls: [
                {
                  name: "submit_work_order",
                  arguments: {
                    objective: "Run a workspace command.",
                    constraints: [],
                    acceptanceCriteria: ["A command result is recorded."]
                  }
                }
              ]
            })
          ];
        }
        return [submitReviewReply({ workOrderId: store.workOrders(session.id)[0]!.id })];
      }
      if (role === "executor" && executorCalls++ === 0) {
        return [
          chatReply({
            calls: [{
              name: "shell_exec",
              arguments: {
                command: "printf fail-closed > ran.txt",
                execution: "host",
                hostReason: "The command needs host execution."
              }
            }]
          }),
          chatReply({ text: "Command refused." })
        ];
      }
      return [chatReply({ text: "Complete." })];
    });
    const runtime = resolveRuntime({
      dataDir: fixture.dataDir,
      workspace: fixture.workspace,
      apiToken: "secret",
      authDisabled: false
    });
    const scheduler = new Scheduler({
      store,
      configStore: new ConfigStore(runtime.configPath, fixture.workspace),
      events: new SessionEvents(),
      runtime
    });
    try {
      await scheduler.start(session.id, "Test safe failure.", "productive");
      await waitFor(() => store.getSession(session.id)?.status === "idle");
      const result = store.events(session.id).find((event) => event.type === "tool_result");
      expect(result?.content).toContain("Sandbox review refused");
      expect(result?.content).toContain(expected);
      await expect(readFile(join(fixture.workspace, "ran.txt"))).rejects.toThrow();
    } finally {
      scheduler.stop(session.id);
      store.close();
    }
  });
});
