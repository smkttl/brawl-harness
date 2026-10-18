import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore, resolveRuntime } from "./config.js";
import { SessionEvents } from "./events.js";
import { Scheduler } from "./scheduler.js";
import { Store } from "./store.js";
import { chatReply, makeHarnessFixture, mockFetch, waitFor } from "./test-helpers.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("scheduler", () => {
  it("completes a productive work order and records imported evidence", async () => {
    const fixture = await makeHarnessFixture();
    let oracleCalls = 0;
    let executorCalls = 0;
    let speakerCalls = 0;
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
      if (role === "oracle") return [chatReply({ text: "The evidence meets the criteria." })];
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
    const store = new Store(join(fixture.dataDir, "brawl.sqlite"));
    const configStore = new ConfigStore(runtime.configPath, fixture.workspace);
    const scheduler = new Scheduler({
      store,
      configStore,
      events: new SessionEvents(),
      runtime
    });
    const session = store.createSession({
      title: "Read fixture",
      mode: "productive",
      sandboxMode: "enabled",
      workspace: fixture.workspace
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

  it("runs an auto-reviewed command without storing a successful review", async () => {
    const fixture = await makeHarnessFixture();
    let oracleCalls = 0;
    let executorCalls = 0;
    globalThis.fetch = mockFetch((role, body) => {
      if (role === "oracle") {
        oracleCalls += 1;
        if (String(body.messages?.[0]?.content ?? "").includes("ephemeral sandbox reviewer")) {
          return [chatReply({ text: '{"allow":true,"reason":"Read-only command."}' })];
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
        return [chatReply({ text: "The command evidence satisfies the work order." })];
      }
      if (role === "executor" && executorCalls++ === 0) {
        return [
          chatReply({
            calls: [
              {
                name: "shell_exec",
                arguments: { command: "printf reviewed > reviewed.txt" }
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
    const store = new Store(join(fixture.dataDir, "brawl.sqlite"));
    const scheduler = new Scheduler({
      store,
      configStore: new ConfigStore(runtime.configPath, fixture.workspace),
      events: new SessionEvents(),
      runtime
    });
    const session = store.createSession({
      title: "Auto review approval",
      mode: "productive",
      sandboxMode: "auto-review",
      workspace: fixture.workspace
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
        return [chatReply({ text: "The refusal is expected." })];
      }
      if (role === "executor" && executorCalls++ === 0) {
        return [
          chatReply({
            calls: [
              {
                name: "shell_exec",
                arguments: { command: "printf denied > denied.txt" }
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
    const store = new Store(join(fixture.dataDir, "brawl.sqlite"));
    const scheduler = new Scheduler({
      store,
      configStore: new ConfigStore(runtime.configPath, fixture.workspace),
      events: new SessionEvents(),
      runtime
    });
    const session = store.createSession({
      title: "Auto review denial",
      mode: "productive",
      sandboxMode: "auto-review",
      workspace: fixture.workspace
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
        return [chatReply({ text: "Review complete." })];
      }
      if (role === "executor" && executorCalls++ === 0) {
        return [
          chatReply({
            calls: [{ name: "shell_exec", arguments: { command: "printf fail-closed > ran.txt" } }]
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
    const store = new Store(join(fixture.dataDir, "brawl.sqlite"));
    const scheduler = new Scheduler({
      store,
      configStore: new ConfigStore(runtime.configPath, fixture.workspace),
      events: new SessionEvents(),
      runtime
    });
    const session = store.createSession({
      title: "Fail closed",
      mode: "productive",
      sandboxMode: "auto-review",
      workspace: fixture.workspace
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
