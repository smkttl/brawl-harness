import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { resolveRuntime } from "./config.js";
import { chatReply, makeHarnessFixture, mockFetch, waitFor } from "./test-helpers.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("backend", () => {
  it("fixture sanity", async () => {
    const fixture = await makeHarnessFixture();
    expect(fixture.workspace).toBeTruthy();
  });

  it("keeps the machine interface authenticated and local sessions isolated", async () => {
    const fixture = await makeHarnessFixture();
    const runtime = resolveRuntime({
      dataDir: fixture.dataDir,
      workspace: fixture.workspace,
      apiToken: "secret",
      authDisabled: false
    });
    const { app, context } = await buildApp(runtime);
    try {
      const unauthorized = await app.inject({ method: "GET", url: "/api/sessions" });
      expect(unauthorized.statusCode).toBe(401);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: { authorization: "Bearer secret" },
        payload: { mode: "productive", workspace: fixture.workspace }
      });
      expect(created.statusCode).toBe(200);
      const body = created.json();
      expect(body.session.workspace).toBe(fixture.workspace);
      expect(body.agents).toHaveLength(3);
      const config = (
        await app.inject({
          method: "GET",
          url: "/api/config",
          headers: { authorization: "Bearer secret" }
        })
      ).json();
      expect(config.providers[0]).not.toHaveProperty("apiKey");
    } finally {
      await app.close();
      context.store.close();
    }
  });

  it("pauses for Speaker clarification before planning an ambiguous request", async () => {
    const fixture = await makeHarnessFixture();
    let oracleCalls = 0;
    globalThis.fetch = mockFetch((role, body) => {
      if (role === "speaker" && !JSON.stringify(body.messages).includes("Tool ask_user result")) {
        return [
          chatReply({
            text: "Before I direct the team, which project should I update?",
            calls: [{ name: "ask_user", arguments: { question: "Which project should I update?" } }]
          })
        ];
      }
      if (role === "oracle") oracleCalls += 1;
      return [chatReply({ text: "Waiting for your answer." })];
    });
    const { app, context } = await buildApp(
      resolveRuntime({
        dataDir: fixture.dataDir,
        workspace: fixture.workspace,
        apiToken: "secret",
        authDisabled: false
      })
    );
    const headers = { authorization: "Bearer secret" };
    try {
      const created = (
        await app.inject({
          method: "POST",
          url: "/api/sessions",
          headers,
          payload: { mode: "productive", workspace: fixture.workspace }
        })
      ).json();
      const id = created.session.id as string;
      await app.inject({
        method: "POST",
        url: `/api/sessions/${id}/messages`,
        headers,
        payload: { content: "Update the project." }
      });
      await waitFor(() => context.store.getSession(id)?.status === "awaiting_user");
      const detail = context.store.sessionDetail(id)!;
      expect(oracleCalls).toBe(0);
      expect(detail.events.some((event) => event.role === "speaker" && event.type === "agent_message" && event.content.includes("which project"))).toBe(true);
      expect(detail.events.some((event) => event.role === "speaker" && event.type === "status" && event.content.includes("Waiting for the user's answer"))).toBe(true);
    } finally {
      context.scheduler.stop(context.store.listSessions()[0]?.id ?? "");
      await app.close();
      context.store.close();
    }
  });

  it("flows a work order from planning to execution", async () => {
    // This test exercises the real asynchronous scheduler and mocked provider stream.
    const fixture = await makeHarnessFixture();
    let oracleCalls = 0;
    let executorCalls = 0;
    let speakerCalls = 0;
    let reviewed = false;
    globalThis.fetch = mockFetch((role) => {
      if (role === "oracle" && oracleCalls++ === 0) {
        return [
          chatReply({
            text: "I will inspect the workspace first.",
            summary: "This private reasoning must not be in the transcript.",
            calls: [
              {
                name: "submit_plan",
                arguments: { content: "Read the README, then report its first word." }
              },
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
            text: "I need to read the file.",
            calls: [{ name: "workspace_read", arguments: { path: "README.md" } }]
          }),
          chatReply({ text: "The first word is Fixture. Verification: read README.md." })
        ];
      }
      if (role === "oracle") {
        reviewed = true;
        return [chatReply({ text: "Evidence satisfies the acceptance criterion." })];
      }
      if (role === "speaker" && speakerCalls++ === 0) {
        return [chatReply({ text: "The README starts with **Fixture**. The workspace was not edited." })];
      }
      if (role === "speaker") return [chatReply({ text: "Complete." })];
      return [chatReply({ text: "No further action." })];
    });
    const runtime = resolveRuntime({
      dataDir: fixture.dataDir,
      workspace: fixture.workspace,
      apiToken: "secret",
      authDisabled: false
    });
    const { app, context } = await buildApp(runtime);
    const headers = { authorization: "Bearer secret" };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const created = (
        await app.inject({
          method: "POST",
          url: "/api/sessions",
          headers,
          payload: { mode: "productive", workspace: fixture.workspace }
        })
      ).json();
      const id = created.session.id as string;
      await context.scheduler.start(id, "What is the first word in README.md?", "productive");
      try {
        await waitFor(() => context.store.getSession(id)?.status === "idle");
      } catch {
        throw new Error(
          JSON.stringify({
            session: context.store.getSession(id),
            events: context.store.events(id).map((event) => `${event.role}:${event.type}:${event.content.slice(0, 180)}`),
            orders: context.store.workOrders(id),
            proposal: context.store.activeProposal(id)
            ,
            unhandled: unhandled.map(String)
          })
        );
      }
      const detail = context.store.sessionDetail(id)!;
      expect(detail.workOrders[0]?.status).toBe("reviewed");
      expect(detail.events.some((event) => event.type === "tool_result" && event.content.includes("Fixture"))).toBe(true);
      expect(detail.events.some((event) => event.role === "speaker" && event.content.includes("Fixture"))).toBe(true);
      expect(detail.events.some((event) => event.type === "thinking_summary" && event.content.includes("private reasoning"))).toBe(false);
      expect(reviewed).toBe(true);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      context.scheduler.stop((context.store.listSessions()[0]?.id) ?? "");
      await app.close();
      context.store.close();
    }
  });

  it("requires three explicit approvals and executes a fun action exactly once", async () => {
    const fixture = await makeHarnessFixture();
    let oracleCalls = 0;
    let executorCalls = 0;
    let speakerCalls = 0;
    globalThis.fetch = mockFetch((role, body) => {
      const serialized = JSON.stringify(body.messages);
      if (
        serialized.includes("Fun-mode deliberation for proposal") &&
        !serialized.includes("Tool cast_vote result is above. Continue.")
      ) {
        const proposalId = serialized.match(/proposal ([0-9a-f-]{36})/)?.[1];
        if (!proposalId) throw new Error("Proposal id missing from deliberation prompt");
        return [
          chatReply({
            calls: [
              {
                name: "cast_vote",
                arguments: {
                  proposalId,
                  vote: "approve",
                  rationale: `${role} approves the read-only action.`
                }
              }
            ]
          })
        ];
      }
      if (role === "oracle" && oracleCalls++ === 0) {
        return [
          chatReply({
            calls: [
              {
                name: "submit_work_order",
                arguments: {
                  objective: "Inspect README",
                  constraints: [],
                  acceptanceCriteria: ["Report content"]
                }
              }
            ]
          }),
          chatReply({ text: "I am obviously the only one who understands this." })
        ];
      }
      if (role === "speaker" && speakerCalls++ === 0) {
        return [chatReply({ text: "Tell me what to inspect." })];
      }
      if (role === "executor" && executorCalls++ === 0) {
        return [
          chatReply({
            calls: [{ name: "workspace_read", arguments: { path: "README.md" } }]
          }),
          chatReply({ text: "I have proposed the requested read." })
        ];
      }
      return [chatReply({ text: "The requested work is complete." })];
    });
    const runtime = resolveRuntime({
      dataDir: fixture.dataDir,
      workspace: fixture.workspace,
      apiToken: "secret",
      authDisabled: false
    });
    const { app, context } = await buildApp(runtime);
    const headers = { authorization: "Bearer secret" };
    try {
      const created = (
        await app.inject({
          method: "POST",
          url: "/api/sessions",
          headers,
          payload: { mode: "fun", workspace: fixture.workspace }
        })
      ).json();
      const id = created.session.id as string;
      await app.inject({
        method: "POST",
        url: `/api/sessions/${id}/messages`,
        headers,
        payload: { content: "Read the README." }
      });
      try {
        await waitFor(() => context.store.getSession(id)?.status === "idle", 5_000);
      } catch {
        throw new Error(
          JSON.stringify({
            session: context.store.getSession(id),
            agents: context.store.agentStates(id),
            events: context.store.events(id).map((event) => ({
              role: event.role,
              type: event.type,
              seq: event.seq,
              content: event.content.slice(0, 300),
              data: event.data
            }))
          })
        );
      }
      const detail = context.store.sessionDetail(id)!;
      const proposalEvent = detail.events.find((event) => event.type === "proposal");
      const proposal =
        proposalEvent?.data?.proposal &&
        typeof proposalEvent.data.proposal === "object" &&
        "id" in proposalEvent.data.proposal
          ? (proposalEvent.data.proposal as { id?: string })
          : undefined;
      const proposalId = proposal?.id;
      expect(proposalId).toBeTruthy();
      expect(context.store.getProposal(proposalId!)?.status).toBe("executed");
      expect(detail.events.filter((event) => event.type === "vote")).toHaveLength(3);
      expect(detail.events.filter((event) => event.type === "tool_call")).toHaveLength(1);
      expect(detail.events.filter((event) => event.type === "tool_result")).toHaveLength(1);
      expect(detail.events.some((event) => event.type === "tool_result" && event.content.includes("Fixture"))).toBe(true);
    } finally {
      context.scheduler.stop((context.store.listSessions()[0]?.id) ?? "");
      await app.close();
      context.store.close();
    }
  });

  it("lets Executor persuade a denier to revise a fun-mode vote", async () => {
    const fixture = await makeHarnessFixture();
    let oracleCalls = 0;
    let executorCalls = 0;
    const initialVoters = new Set<string>();
    const originalResponder = (role: string) => {
      if (role === "oracle" && oracleCalls++ === 0) {
        return [
          chatReply({
            calls: [
              {
                name: "submit_work_order",
                arguments: {
                  objective: "Inspect README",
                  constraints: [],
                  acceptanceCriteria: ["Report content"]
                }
              }
            ]
          })
        ];
      }
      if (role === "executor" && executorCalls++ === 0) {
        return [
          chatReply({
            calls: [{ name: "workspace_read", arguments: { path: "README.md" } }]
          }),
          chatReply({ text: "Read action proposed." })
        ];
      }
      return [chatReply({ text: "Continuing with the recorded decision." })];
    };
    globalThis.fetch = mockFetch((role, body) => {
      const serialized = JSON.stringify(body.messages);
      const proposalId = serialized.match(/proposal ([0-9a-f-]{36})/)?.[1];
      const isInitialVote =
        serialized.includes("Fun-mode deliberation for proposal") &&
        !serialized.includes("Fun-mode rebuttal for proposal") &&
        !serialized.includes("Fun-mode vote response for proposal") &&
        !initialVoters.has(role);
      if (isInitialVote) {
        if (!proposalId) throw new Error("Proposal id missing from deliberation prompt");
        initialVoters.add(role);
        return [
          chatReply({
            calls: [
              {
                name: "cast_vote",
                arguments: {
                  proposalId,
                  vote: role === "speaker" ? "reject" : "approve",
                  rationale:
                    role === "speaker"
                      ? "The read has not explained why it is necessary."
                      : `${role} approves the read-only action.`
                }
              }
            ]
          })
        ];
      }
      if (
        role === "executor" &&
        serialized.includes("Fun-mode rebuttal for proposal") &&
        !serialized.includes("Workspace actions are unavailable during the fun-mode rebuttal")
      ) {
        return [
          chatReply({
            calls: [{ name: "workspace_read", arguments: { path: "README.md" } }]
          }),
          chatReply({
            calls: [
              {
                name: "send_steer",
                arguments: {
                  to: "speaker",
                  content: "The read is necessary to verify the documented behavior before editing."
                }
              }
            ]
          }),
          chatReply({ text: "My case is in the evidence and the steering message." })
        ];
      }
      if (
        role === "speaker" &&
        serialized.includes("Fun-mode vote response for proposal") &&
        !serialized.includes("Tool cast_vote result is above. Continue.")
      ) {
        if (!proposalId) throw new Error("Proposal id missing from vote response prompt");
        return [
          chatReply({
            calls: [
              {
                name: "cast_vote",
                arguments: {
                  proposalId,
                  vote: "approve",
                  rationale: "Executor explained why the read is necessary for verification."
                }
              }
            ]
          })
        ];
      }
      return originalResponder(role);
    });
    const { app, context } = await buildApp(
      resolveRuntime({
        dataDir: fixture.dataDir,
        workspace: fixture.workspace,
        apiToken: "secret",
        authDisabled: false
      })
    );
    const headers = { authorization: "Bearer secret" };
    try {
      const created = (
        await app.inject({
          method: "POST",
          url: "/api/sessions",
          headers,
          payload: { mode: "fun", workspace: fixture.workspace }
        })
      ).json();
      const id = created.session.id as string;
      await app.inject({
        method: "POST",
        url: `/api/sessions/${id}/messages`,
        headers,
        payload: { content: "Read the README." }
      });
      await waitFor(
        () => context.store.events(id).some((event) => event.type === "tool_result"),
        5_000
      );

      const detail = context.store.sessionDetail(id)!;
      const votes = detail.events.filter((event) => event.type === "vote");
      const proposalId = votes
        .map((event) => event.data?.proposalId)
        .find((value): value is string => typeof value === "string");
      const rebuttal = detail.events.find((event) =>
        event.content.includes("Executor gets a rebuttal in proposal round 1/2")
      );
      const revisedVote = votes.find((event) => event.content.startsWith("revised approve:"));

      expect(context.store.getProposal(proposalId!)?.status).toBe("executed");
      expect(rebuttal).toBeTruthy();
      expect(revisedVote?.role).toBe("speaker");
      expect(rebuttal!.seq).toBeLessThan(revisedVote!.seq);
      expect(
        detail.events.some(
          (event) =>
            event.role === "executor" &&
            event.type === "steer" &&
            event.content.includes("verify the documented behavior")
        )
      ).toBe(true);
      expect(detail.events.some((event) => event.content.includes("moved to debate round 2"))).toBe(false);
      expect(detail.events.filter((event) => event.type === "tool_call")).toHaveLength(1);
    } finally {
      context.scheduler.stop(context.store.listSessions()[0]?.id ?? "");
      await app.close();
      context.store.close();
    }
  });

  it("waits for user guidance when the fun debate limit expires", async () => {
    const fixture = await makeHarnessFixture();
    let oracleCalls = 0;
    let executorCalls = 0;
    globalThis.fetch = mockFetch((role, body) => {
      const serialized = JSON.stringify(body.messages);
      const deliberation = serialized.match(/Fun-mode deliberation for proposal ([0-9a-f-]{36}), round (\d+)/);
      if (deliberation && !serialized.includes("Tool cast_vote result is above. Continue.")) {
        return [
          chatReply({
            calls: [
              {
                name: "cast_vote",
                arguments: {
                  proposalId: deliberation[1],
                  vote: "reject",
                  rationale: `${role} requests a safer debate round ${deliberation[2]}.`
                }
              }
            ]
          })
        ];
      }
      if (role === "oracle" && oracleCalls++ === 0) {
        return [
          chatReply({
            calls: [
              {
                name: "submit_work_order",
                arguments: {
                  objective: "Inspect README",
                  constraints: [],
                  acceptanceCriteria: ["Report content"]
                }
              }
            ]
          })
        ];
      }
      if (role === "executor" && executorCalls++ === 0) {
        return [
          chatReply({
            calls: [{ name: "workspace_read", arguments: { path: "README.md" } }]
          }),
          chatReply({ text: "Read action proposed." })
        ];
      }
      if (role === "speaker" && serialized.includes("debate ended")) {
        return [chatReply({ text: "The team could not agree. Should I ask them to retry the read?" })];
      }
      return [chatReply({ text: "The action needs another review." })];
    });
    const runtime = resolveRuntime({
      dataDir: fixture.dataDir,
      workspace: fixture.workspace,
      apiToken: "secret",
      authDisabled: false
    });
    const { app, context } = await buildApp(runtime);
    const headers = { authorization: "Bearer secret" };
    try {
      const created = (
        await app.inject({
          method: "POST",
          url: "/api/sessions",
          headers,
          payload: { mode: "fun", workspace: fixture.workspace }
        })
      ).json();
      const id = created.session.id as string;
      await app.inject({
        method: "POST",
        url: `/api/sessions/${id}/messages`,
        headers,
        payload: { content: "Read the README." }
      });
      await waitFor(() => context.store.getSession(id)?.status === "awaiting_user", 5_000);
      const detail = context.store.sessionDetail(id)!;
      expect(detail.events.filter((event) => event.type === "vote")).toHaveLength(6);
      expect(
        detail.events.filter((event) =>
          event.content.includes("Executor gets a rebuttal in proposal round")
        )
      ).toHaveLength(2);
      expect(detail.events.some((event) => event.role === "speaker" && event.content.includes("could not agree"))).toBe(true);
      expect(detail.events.filter((event) => event.type === "tool_call")).toHaveLength(0);
      expect(detail.activeProposal).toBeNull();
      expect(detail.workOrders[0]?.status).toBe("active");
    } finally {
      context.scheduler.stop(context.store.listSessions()[0]?.id ?? "");
      await app.close();
      context.store.close();
    }
  });

  it("rejects invalid modes and non-existent sessions at the API boundary", async () => {
    const fixture = await makeHarnessFixture();
    const { app, context } = await buildApp(
      resolveRuntime({
        dataDir: fixture.dataDir,
        workspace: fixture.workspace,
        apiToken: "secret",
        authDisabled: false
      })
    );
    const headers = { authorization: "Bearer secret" };
    try {
      const invalid = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers,
        payload: { mode: "chaos", workspace: fixture.workspace }
      });
      expect(invalid.statusCode).toBe(400);
      const missing = await app.inject({
        method: "GET",
        url: "/api/sessions/not-a-session",
        headers
      });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
      context.store.close();
    }
  });
});
