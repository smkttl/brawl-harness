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
});
