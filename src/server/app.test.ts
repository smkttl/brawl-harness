import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { resolveRuntime } from "./config.js";
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
      expect(config.providers[0]).not.toHaveProperty("headers");
      expect(config.providers[0].hasHeaders).toBe(false);
    } finally {
      await app.close();
      context.store.close();
    }
  });

  it("allows the web shell without a token but enforces same-origin writes", async () => {
    const fixture = await makeHarnessFixture();
    const runtime = resolveRuntime({
      dataDir: fixture.dataDir,
      workspace: fixture.workspace,
      apiToken: "secret",
      authDisabled: false
    });
    const { app, context } = await buildApp(runtime);
    try {
      const shell = await app.inject({
        method: "GET",
        url: "/assets/app.js",
        headers: { host: "harness.example:15765" }
      });
      expect(shell.statusCode).not.toBe(401);

      const foreignOrigin = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: {
          authorization: "Bearer secret",
          host: "harness.example:15765",
          origin: "https://attacker.example"
        },
        payload: { mode: "productive", workspace: fixture.workspace }
      });
      expect(foreignOrigin.statusCode).toBe(403);

      const sameOrigin = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: {
          authorization: "Bearer secret",
          host: "harness.example:15765",
          origin: "http://harness.example:15765"
        },
        payload: { mode: "productive", workspace: fixture.workspace }
      });
      expect(sameOrigin.statusCode).toBe(200);
    } finally {
      await app.close();
      context.store.close();
    }
  });

  it("discovers models from the browser request shape", async () => {
    const fixture = await makeHarnessFixture();
    globalThis.fetch = (async (input: string | URL | Request) => {
      expect(String(input)).toBe("http://mock.invalid/v1/models");
      return new Response(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] }), {
        status: 200
      });
    }) as typeof fetch;
    const { app, context } = await buildApp(
      resolveRuntime({
        dataDir: fixture.dataDir,
        workspace: fixture.workspace,
        apiToken: "secret",
        authDisabled: false
      })
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/providers/${fixture.providerId}/models`,
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
          host: "harness.example:15765",
          origin: "https://harness.example:15765"
        },
        payload: {}
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ models: ["model-a", "model-b"] });
    } finally {
      await app.close();
      context.store.close();
    }
  });

  it("pauses, resumes, and deletes a session from the browser request shapes", async () => {
    const fixture = await makeHarnessFixture();
    const { app, context } = await buildApp(
      resolveRuntime({
        dataDir: fixture.dataDir,
        workspace: fixture.workspace,
        apiToken: "secret",
        authDisabled: false
      })
    );
    const headers = {
      authorization: "Bearer secret",
      host: "harness.example:15765",
      origin: "https://harness.example:15765"
    };
    try {
      const created = (
        await app.inject({
          method: "POST",
          url: "/api/sessions",
          headers,
          payload: { mode: "productive", workspace: fixture.workspace, sandboxMode: "disabled" }
        })
      ).json();
      const id = created.session.id as string;

      const paused = await app.inject({
        method: "POST",
        url: `/api/sessions/${id}/pause`,
        headers
      });
      expect(paused.statusCode).toBe(200);
      expect(context.store.getSession(id)?.status).toBe("paused");

      const resumed = await app.inject({
        method: "POST",
        url: `/api/sessions/${id}/resume`,
        headers
      });
      expect(resumed.statusCode).toBe(200);
      context.scheduler.stop(id);

      const deleted = await app.inject({
        method: "DELETE",
        url: `/api/sessions/${id}`,
        headers
      });
      expect(deleted.statusCode).toBe(200);
      expect(context.store.getSession(id)).toBeNull();
      expect(context.store.events(id)).toEqual([]);
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
      expect(
        detail.events.some(
          (event) =>
            event.role === "speaker" &&
            event.type === "speaker_message" &&
            event.content === "Which project should I update?"
        )
      ).toBe(true);
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
    let sessionId = "";
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
      if (role === "oracle") {
        reviewed = true;
        return [
          submitReviewReply({
            workOrderId: context.store.workOrders(sessionId)[0]!.id
          })
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
      sessionId = id;
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
    const initialVoters = new Set<Role>();
    let sessionId = "";
    const built = await buildApp(
      resolveRuntime({
        dataDir: fixture.dataDir,
        workspace: fixture.workspace,
        apiToken: "secret",
        authDisabled: false
      })
    );
    const { app, context } = built;
    globalThis.fetch = mockFetch((role, body) => {
      const serialized = JSON.stringify(body.messages);
      if (
        serialized.includes("Fun-mode deliberation for proposal") &&
        !initialVoters.has(role)
      ) {
        const proposalId = serialized.match(/proposal ([0-9a-f-]{36})/)?.[1];
        if (!proposalId) throw new Error("Proposal id missing from deliberation prompt");
        initialVoters.add(role);
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
      if (
        role === "oracle" &&
        (serialized.includes("Review the evidence submitted") ||
          serialized.includes("Review the evidence submitted for fun-mode"))
      ) {
        return [submitReviewReply({ workOrderId: context.store.workOrders(sessionId)[0]!.id })];
      }
      return [chatReply({ text: "The requested work is complete." })];
    });
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
      sessionId = id;
      await app.inject({
        method: "POST",
        url: `/api/sessions/${id}/messages`,
        headers,
        payload: { content: "Read the README." }
      });
      try {
        await waitFor(() => context.store.getSession(sessionId)?.status === "idle", 3_000);
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
    let rebuttalServed = false;
    let revisionServed = false;
    const built = await buildApp(
      resolveRuntime({
        dataDir: fixture.dataDir,
        workspace: fixture.workspace,
        apiToken: "secret",
        authDisabled: false
      })
    );
    const { context } = built;
    let sessionId = "";
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
        !rebuttalServed
      ) {
        rebuttalServed = true;
        return [
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
          })
        ];
      }
      if (
        role === "speaker" &&
        serialized.includes("Fun-mode vote response for proposal") &&
        !revisionServed
      ) {
        if (!proposalId) throw new Error("Proposal id missing from vote response prompt");
        revisionServed = true;
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
      if (
        role === "oracle" &&
        (serialized.includes("Review the evidence submitted") ||
          serialized.includes("Review the evidence submitted for fun-mode"))
      ) {
        return [
          submitReviewReply({
            workOrderId: context.store.workOrders(sessionId)[0]!.id
          })
        ];
      }
      return originalResponder(role);
    });
    const { app } = await buildApp(
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
      sessionId = id;
      await app.inject({
        method: "POST",
        url: `/api/sessions/${id}/messages`,
        headers,
        payload: { content: "Read the README." }
      });
      try {
        await waitFor(
          () => context.store.events(id).some((event) => event.type === "tool_result"),
          5_000
        );
      } catch {
        throw new Error(
          JSON.stringify({
            session: context.store.getSession(id),
            events: context.store.events(id).slice(-20).map((event) => ({
              role: event.role,
              type: event.type,
              content: event.content.slice(0, 500)
            }))
          }, null, 2)
        );
      }
      try {
        await waitFor(() => context.store.getSession(id)?.status === "idle", 5_000);
      } catch {
        throw new Error(
          JSON.stringify({
            session: context.store.getSession(id),
            events: context.store.events(id).slice(-20).map((event) => ({
              role: event.role,
              type: event.type,
              content: event.content.slice(0, 500)
            }))
          }, null, 2)
        );
      }

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
      if (role === "speaker" && serialized.includes("debate ended")) {
        return [chatReply({ text: "The team could not agree. Should I ask them to retry the read?" })];
      }
      const deliberation = [
        ...serialized.matchAll(
          /Fun-mode deliberation for proposal ([0-9a-f-]{36}), round (\d+)/g
        )
      ].at(-1);
      const sinceDeliberation = deliberation
        ? serialized.slice(deliberation.index ?? 0)
        : "";
      if (
        deliberation &&
        !sinceDeliberation.includes("Tool cast_vote result is above. Continue.")
      ) {
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
      await waitFor(
        () =>
          context.store.getSession(id)?.status === "awaiting_user" &&
          context.store
            .sessionDetail(id)!
            .events.some(
              (event) => event.role === "speaker" && event.content.includes("could not agree")
            ),
        5_000
      );
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

  it("defaults sandbox mode and rejects invalid mode combinations or running changes", async () => {
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
      const created = (
        await app.inject({
          method: "POST",
          url: "/api/sessions",
          headers,
          payload: { mode: "productive", workspace: fixture.workspace }
        })
      ).json();
      const id = created.session.id as string;
      expect(created.session.sandboxMode).toBe("enabled");

      const invalid = await app.inject({
        method: "PATCH",
        url: `/api/sessions/${id}`,
        headers,
        payload: { mode: "fun", sandboxMode: "auto-review" }
      });
      expect(invalid.statusCode).toBe(400);

      vi.spyOn(context.scheduler, "isRunning").mockReturnValue(true);
      const running = await app.inject({
        method: "PATCH",
        url: `/api/sessions/${id}`,
        headers,
        payload: { sandboxMode: "disabled" }
      });
      expect(running.statusCode).toBe(409);

      vi.restoreAllMocks();
      const changed = await app.inject({
        method: "PATCH",
        url: `/api/sessions/${id}`,
        headers,
        payload: { sandboxMode: "auto-review" }
      });
      expect(changed.statusCode).toBe(200);
      expect(changed.json().sandboxMode).toBe("auto-review");
    } finally {
      await app.close();
      context.store.close();
    }
  });
});
