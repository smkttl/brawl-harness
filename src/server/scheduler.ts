import { randomUUID } from "node:crypto";
import type {
  ActionProposal,
  AgentConfig,
  AgentState,
  Mode,
  ProviderConfig,
  Role,
  Session,
  StreamEnvelope,
  ToolName,
  WorkOrder
} from "../shared/protocol.js";
import { BrawlError } from "../shared/errors.js";
import { systemPrompt, type PromptContext } from "../shared/context.js";
import type { ConfigStore, RuntimeOptions } from "./config.js";
import type { SessionEvents } from "./events.js";
import {
  complete,
  type ProviderMessage,
  type ProviderTool
} from "./provider.js";
import type { Store } from "./store.js";
import { inspectBubblewrap } from "./sandbox.js";
import { inspectForApproval, WorkspaceTools, type ToolResult } from "./tools.js";
import { resolveSessionWorkspace } from "./workspace.js";

interface RunHandle {
  sessionId: string;
  controller: AbortController;
  startedAt: number;
}

interface AgentActor {
  sessionId: string;
  role: Role;
  history: ProviderMessage[];
  queued: UserCommand[];
}

interface UserCommand {
  id: string;
  content?: string;
  guide?: string;
  instruction?: string;
}

interface DispatchToolOptions {
  debate?: boolean;
  voteRevisionDeniers?: Role[];
}

const ROLES = ["oracle", "executor", "speaker"] as const;

const META_TOOLS: ProviderTool[] = [
  {
    name: "send_steer",
    description: "Send a normal steering message to another agent. It is delivered at their next boundary.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", enum: ["oracle", "executor", "speaker"] },
        content: { type: "string" },
        urgent: { type: "boolean", default: false }
      },
      required: ["to", "content"]
    }
  },
  {
    name: "submit_plan",
    description: "Record the current decision plan for the team and user.",
    parameters: {
      type: "object",
      properties: { content: { type: "string" } },
      required: ["content"]
    }
  },
  {
    name: "submit_work_order",
    description: "Create the active productive work order for Executor.",
    parameters: {
      type: "object",
      properties: {
        objective: { type: "string" },
        constraints: { type: "array", items: { type: "string" } },
        acceptanceCriteria: { type: "array", items: { type: "string" } }
      },
      required: ["objective", "constraints", "acceptanceCriteria"]
    }
  },
  {
    name: "submit_review",
    description:
      "Submit the mandatory structured verdict for a completed Oracle review.",
    parameters: {
      type: "object",
      properties: {
        workOrderId: { type: "string" },
        decision: { type: "string", enum: ["approve", "reject"] },
        feedback: { type: "string" },
        failedCriteria: {
          type: "array",
          items: { type: "string" }
        }
      },
      required: ["workOrderId", "decision", "feedback", "failedCriteria"]
    }
  },
  {
    name: "cast_vote",
    description: "Approve or reject the exact pending fun-mode action proposal.",
    parameters: {
      type: "object",
      properties: {
        proposalId: { type: "string" },
        vote: { type: "string", enum: ["approve", "reject"] },
        rationale: { type: "string" }
      },
      required: ["proposalId", "vote", "rationale"]
    }
  },
  {
    name: "ask_user",
    description: "Pause the session and ask the user a concise question that blocks safe progress.",
    parameters: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"]
    }
  }
];

const WORKSPACE_TOOLS: ProviderTool[] = [
  {
    name: "workspace_list",
    description: "List files and directories inside the configured workspace.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        limit: { type: "integer" }
      }
    }
  },
  {
    name: "workspace_read",
    description: "Read a UTF-8 file inside the configured workspace.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        maxChars: { type: "integer" }
      },
      required: ["path"]
    }
  },
  {
    name: "workspace_search",
    description: "Search file contents with ripgrep inside the workspace.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        path: { type: "string" },
        limit: { type: "integer" }
      },
      required: ["query"]
    }
  },
  {
    name: "workspace_write",
    description: "Atomically replace or create a workspace file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "workspace_patch",
    description: "Apply an apply_patch envelope within the workspace.",
    parameters: {
      type: "object",
      properties: { patch: { type: "string" } },
      required: ["patch"]
    }
  },
  {
    name: "shell_exec",
    description:
      "Run a shell command in the workspace. execution=sandboxed runs in Bubblewrap by default; execution=host requests reviewed host execution and requires hostReason.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeoutMs: { type: "integer" },
        execution: { type: "string", enum: ["sandboxed", "host"], default: "sandboxed" },
        hostReason: { type: "string" }
      },
      required: ["command"]
    }
  }
];

export class Scheduler {
  private readonly store: Store;
  private readonly configStore: ConfigStore;
  private readonly events: SessionEvents;
  private readonly runtime: RuntimeOptions;
  private readonly runs = new Map<string, RunHandle>();
  private readonly roleTurns = new Map<string, { controller: AbortController; messages: ProviderMessage[] }>();
  private readonly actors = new Map<string, AgentActor>();
  private readonly activeTurns = new Set<string>();
  private readonly stopping = new Set<string>();
  private readonly planAttempted = new Set<string>();
  private readonly missingReviewRetry = new Set<string>();

  constructor(input: {
    store: Store;
    configStore: ConfigStore;
    events: SessionEvents;
    runtime: RuntimeOptions;
  }) {
    this.store = input.store;
    this.configStore = input.configStore;
    this.events = input.events;
    this.runtime = input.runtime;
  }

  isRunning(sessionId: string): boolean {
    const handle = this.runs.get(sessionId);
    return Boolean(handle && !handle.controller.signal.aborted);
  }

  async start(sessionId: string, firstMessage: string | null, mode: Mode): Promise<void> {
    if (this.runs.has(sessionId)) throw new BrawlError("Session is already running", 409);
    const session = this.requireSession(sessionId);
    await resolveSessionWorkspace(this.runtime.workspace, session.workspace);
    if (!this.configReady()) {
      throw new BrawlError("Configure a provider and model for all three agents first", 409);
    }
    const controller = new AbortController();
    this.runs.set(sessionId, { sessionId, controller, startedAt: Date.now() });
    this.stopping.delete(sessionId);
    this.store.setStatus(sessionId, "queued");
    this.publishSession(sessionId);
    if (firstMessage) this.onUserMessage(sessionId, firstMessage);
    void this.runSession(sessionId, controller.signal, mode).catch(() => undefined).finally(() => {
      this.runs.delete(sessionId);
      const current = this.store.getSession(sessionId);
      if (
        current &&
        ["queued", "running", "awaiting_consensus"].includes(current.status)
      ) {
        this.store.setStatus(sessionId, "interrupted", "The agent run ended without a durable result.");
        this.publishSession(sessionId);
      }
    });
  }

  async resume(sessionId: string, mode: Mode): Promise<void> {
    const session = this.requireSession(sessionId);
    await resolveSessionWorkspace(this.runtime.workspace, session.workspace);
    if (!["interrupted", "awaiting_user", "paused"].includes(session.status)) {
      throw new BrawlError(`Cannot resume from ${session.status}`, 409);
    }
    if (session.sandboxMode !== "disabled") {
      const sandbox = await inspectBubblewrap();
      if (!sandbox.available) {
        throw new BrawlError(
          `Sandbox unavailable: ${sandbox.error ?? "Bubblewrap cannot execute"}`,
          409
        );
      }
    }
    if (mode === "fun" && session.sandboxMode === "auto-review") {
      throw new BrawlError("auto-review sandbox mode is only available in productive mode", 409);
    }
    await this.start(sessionId, null, mode);
  }

  pause(sessionId: string): void {
    const handle = this.runs.get(sessionId);
    if (!handle) {
      const session = this.requireSession(sessionId);
      if (session.status === "idle" || session.status === "completed") {
        this.store.setStatus(sessionId, "paused");
        this.publishSession(sessionId);
      }
      return;
    }
    this.stopping.add(sessionId);
    handle.controller.abort(new Error("Paused by user"));
  }

  stop(sessionId: string): void {
    this.stopping.add(sessionId);
    this.runs.get(sessionId)?.controller.abort(new Error("Stopped by user"));
  }

  userMessage(sessionId: string, content: string, id = randomUUID()): void {
    this.requireSession(sessionId);
    if (!content.trim()) throw new BrawlError("Message cannot be empty");
    this.onUserMessage(sessionId, content, id);
  }

  steer(sessionId: string, from: Role, to: Role, content: string, urgent: boolean): void {
    this.requireSession(sessionId);
    if (from === to) throw new BrawlError("An agent cannot steer itself");
    if (!content.trim()) throw new BrawlError("Steer message cannot be empty");
    if (urgent) {
      this.abortRole(sessionId, to);
    }
    this.store.queuePendingMessage({ sessionId, from, to, content, urgent });
    this.emit(sessionId, {
      role: from,
      type: "steer",
      content,
      data: { to, urgent }
    });
  }

  userGuidance(sessionId: string, content: string): void {
    const session = this.requireSession(sessionId);
    if (session.status !== "awaiting_consensus" && session.status !== "awaiting_user") {
      if (this.isRunning(sessionId)) throw new BrawlError("Session is already working", 409);
    }
    const id = randomUUID();
    this.store.appendEvent({
      sessionId,
      role: "user",
      type: "user_message",
      content
    });
    const base = this.actor(sessionId, "speaker");
    base.queued.push({ id, guide: content });
    if (session.status === "awaiting_user" && this.isRunning(sessionId)) {
      this.store.setStatus(sessionId, "running");
      this.publishSession(sessionId);
    }
    if (this.isRunning(sessionId)) return;
    void this.start(sessionId, null, session.mode);
  }

  private onUserMessage(sessionId: string, content: string, id = randomUUID()): void {
    this.store.appendEvent({
      sessionId,
      role: "user",
      type: "user_message",
      content
    });
    const session = this.requireSession(sessionId);
    if (!session.title || session.title === "New session") {
      this.store.updateSession(sessionId, {
        title: content.trim().replace(/\s+/g, " ").slice(0, 80)
      });
    }
    this.actor(sessionId, "speaker").queued.push({ id, content });
    this.planAttempted.delete(sessionId);
    this.publishSession(sessionId);
  }

  private async runSession(
    sessionId: string,
    signal: AbortSignal,
    mode: Mode
  ): Promise<void> {
    const timer = setTimeout(() => {
      this.store.appendEvent({
        sessionId,
        role: "system",
        type: "error",
        content: `Run exceeded ${Math.round(this.configStore.get().maxRunMs / 60_000)} minute limit.`
      });
      this.stop(sessionId);
    }, this.configStore.get().maxRunMs);
    let completed = false;
    try {
      this.store.setStatus(sessionId, "running");
      this.publishSession(sessionId);
      while (!signal.aborted) {
        const current = this.requireSession(sessionId);
        const active = this.store.activeWorkOrder(sessionId);
        const queuedRoles = ROLES.filter((role) => this.actor(sessionId, role).queued.length > 0);
        if (queuedRoles.length > 0) {
          await Promise.all(queuedRoles.map((role) => this.runAgent(sessionId, role, signal, mode, null)));
          if (this.requireSession(sessionId).status === "awaiting_user") {
            completed = true;
            break;
          }
          continue;
        }
        const steeredRoles = [...new Set(this.store.pendingMessages(sessionId).map((item) => item.to))];
        if (steeredRoles.length > 0) {
          await Promise.all(steeredRoles.map((role) => this.runAgent(sessionId, role, signal, mode, null)));
          continue;
        }
        if (current.status === "awaiting_user") {
          completed = true;
          break;
        }
        if (current.mode === "productive" && !active && !this.planAttempted.has(sessionId)) {
          this.planAttempted.add(sessionId);
          await this.runAgent(sessionId, "oracle", signal, mode, "Plan the task and create the first scoped work order.");
          continue;
        }
        if (current.mode === "productive" && active?.status === "active") {
          await this.runAgent(
            sessionId,
            "executor",
            signal,
            mode,
            `Execute active work order ${active.id}: ${active.objective}`
          );
          continue;
        }
        if (current.mode === "productive" && active?.status === "submitted") {
          if (this.missingReviewRetry.has(active.id)) {
            this.store.setStatus(
              sessionId,
              "awaiting_user",
              "Oracle did not provide a structured review verdict."
            );
            this.actor(sessionId, "speaker").queued.push({
              id: randomUUID(),
              instruction:
                "Explain that Oracle did not provide a structured review verdict and ask the user how to proceed. Do not claim the work was accepted."
            });
            this.missingReviewRetry.delete(active.id);
            continue;
          }
          await this.runAgent(
            sessionId,
            "oracle",
            signal,
            mode,
            `Review the evidence submitted for work order ${active.id}.`
          );
          continue;
        }
        const proposal = this.store.activeProposal(sessionId);
        if (current.mode === "fun" && proposal) {
          const outcome = await this.runProposalRound(sessionId, proposal, signal, mode);
          if (outcome === "continue") continue;
          if (outcome === "awaiting_user") {
            await this.runAgent(sessionId, "speaker", signal, mode, null);
            completed = true;
            break;
          }
        }
        if (current.mode === "fun" && !proposal && active?.status === "active") {
          await this.runAgent(
            sessionId,
            "executor",
            signal,
            mode,
            `Execute the active work order ${active.id} by proposing the next workspace action. All actions require unanimous approval.`
          );
          continue;
        }
        if (current.mode === "fun" && !proposal && active?.status === "submitted") {
          await this.runAgent(
            sessionId,
            "oracle",
            signal,
            mode,
            `Review the evidence submitted for fun-mode work order ${active.id}.`
          );
          continue;
        }
        if (current.mode === "fun" && !proposal && !active && !this.planAttempted.has(sessionId)) {
          this.planAttempted.add(sessionId);
          await this.runAgent(
            sessionId,
            "oracle",
            signal,
            mode,
            "Use Speaker's relayed requirements to create a scoped work order for Executor. Ask Speaker to resolve material ambiguity before planning further."
          );
          continue;
        }
        if (this.anyPendingSteer(sessionId)) {
          this.store.setStatus(sessionId, "awaiting_user", "Agents still have steering to process.");
          this.publishSession(sessionId);
          completed = true;
          break;
        }
        completed = true;
        this.store.setStatus(
          sessionId,
          this.store.activeProposal(sessionId) ? "awaiting_consensus" : "idle"
        );
        this.publishSession(sessionId);
        break;
      }
      if (!completed && this.stopping.has(sessionId)) {
        this.store.setStatus(sessionId, "paused");
        this.publishSession(sessionId);
      }
    } catch (error) {
      if (!signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        this.store.setStatus(sessionId, "failed", message);
        this.store.appendEvent({ sessionId, role: "system", type: "error", content: message });
        this.publishSession(sessionId);
      } else if (this.stopping.has(sessionId)) {
        this.store.setStatus(sessionId, "paused");
        this.publishSession(sessionId);
      } else {
        this.store.setStatus(sessionId, "interrupted", "Session was interrupted.");
        this.publishSession(sessionId);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      for (const role of ROLES) {
        this.setAgent(sessionId, role, "idle", undefined);
      }
    }
  }

  private async runAgent(
    sessionId: string,
    role: Role,
    runSignal: AbortSignal,
    mode: Mode,
    instruction: string | null,
    options: DispatchToolOptions = {}
  ): Promise<void> {
    const key = `${sessionId}:${role}`;
    if (this.activeTurns.has(key)) throw new BrawlError(`${role} is already active`);
    this.activeTurns.add(key);
    const controller = new AbortController();
    this.roleTurns.set(key, { controller, messages: [] });
    const abort = () => controller.abort(runSignal.reason);
    runSignal.addEventListener("abort", abort, { once: true });
    const actor = this.actor(sessionId, role);
    let boundaryReached = false;
    try {
      const config = this.agentConfig(role);
      const provider = this.requireProvider(config.providerId);
      const session = this.requireSession(sessionId);
      const workOrder = this.store.activeWorkOrder(sessionId);
      const proposal = this.store.activeProposal(sessionId);
      const promptContext: PromptContext = {
        session,
        config,
        mode,
        activeWorkOrder: workOrder,
        proposal,
        round: proposal?.round ?? 0,
        maxRounds: this.configStore.get().debateRounds,
        workspace: session.workspace
      };
      this.setAgent(sessionId, role, "thinking", instruction ?? "Working");
      const queuedWork = actor.queued.shift();
      const turnInstruction = instruction ?? queuedWork?.instruction ?? null;
      const speakerQuestion = queuedWork?.content ?? queuedWork?.guide ?? null;
      if (speakerQuestion && role === "speaker") {
        this.emit(sessionId, {
          role: "speaker",
          type: "status",
          content: "Reading the user's message."
        });
        actor.history.push({
          role: "user",
          content: queuedWork?.guide
            ? `The user answered the open question or deadlock:\n${speakerQuestion}\nRelay this guidance to the team and continue.`
            : `A new user message:\n${speakerQuestion}`
        });
      } else if (turnInstruction) {
        this.emit(sessionId, {
          role,
          type: "status",
          content: turnInstruction.slice(0, 2_000)
        });
        actor.history.push({ role: "user", content: turnInstruction });
      }
      const messages: ProviderMessage[] = [
        { role: "system", content: systemPrompt(role, promptContext) },
        ...actor.history,
        ...this.consumeSteers(sessionId, role)
      ];
      const turnState = this.roleTurns.get(key);
      if (turnState) turnState.messages = messages;
      for (let iteration = 0; iteration < 12; iteration++) {
        controller.signal.throwIfAborted();
        this.setAgent(sessionId, role, "thinking", iteration === 0 ? "Thinking" : "Continuing");
        this.ensureProposalDeliberation(sessionId, mode, role);
        const pendingSteer = this.store.consumePendingMessage(sessionId, role);
        if (pendingSteer) {
          const content = `Steer from teammate${pendingSteer.urgent ? " (urgent)" : ""}:\n${pendingSteer.content}`;
          messages.push({ role: "user", content });
          if (pendingSteer.urgent) {
            controller.abort(new Error("Urgent steering"));
            controller.signal.throwIfAborted();
          }
        }
        let reasoning = "";
        this.emit(sessionId, {
          role,
          type: "status",
          content: "Requesting the next model response."
        });
        const reply = await complete({
          provider,
          config,
          messages,
          tools: this.toolsFor(role),
          signal: controller.signal,
          onDelta: (kind, delta) => {
            if (kind === "reasoning") reasoning += delta;
          }
        });
        if (reasoning || reply.reasoningSummary) {
          this.emit(sessionId, {
            role,
            type: "thinking_summary",
            content: reply.reasoningSummary || reasoning,
            data: { source: "provider", label: "Provider reasoning summary" }
          });
        }
        if (reply.usage.input || reply.usage.output || reply.usage.reasoning) {
          this.emit(sessionId, {
            role,
            type: "usage",
            content: `${reply.usage.input} input / ${reply.usage.output} output / ${reply.usage.reasoning} reasoning tokens`,
            data: reply.usage
          });
        }
        if (reply.text.trim()) this.emit(sessionId, { role, type: "agent_message", content: reply.text });
        if (reply.text || reply.toolCalls.length > 0) {
          actor.history.push({
            role: "assistant",
            content: reply.text,
            ...(reply.toolCalls.length > 0 ? { toolCalls: reply.toolCalls } : {})
          });
          messages.push(actor.history.at(-1)!);
        }
        boundaryReached = true;

        if (reply.toolCalls.length === 0) {
          if (
            role === "executor" &&
            workOrder?.status === "active" &&
            (mode === "productive" || !this.store.activeProposal(sessionId))
          ) {
            this.store.updateWorkOrder(workOrder.id, "submitted");
          }
          if (
            role === "oracle" &&
            workOrder?.status === "submitted"
          ) {
            if (!this.missingReviewRetry.has(workOrder.id)) {
              this.missingReviewRetry.add(workOrder.id);
              actor.history.push({
                role: "user",
                content:
                  "The review verdict is missing. You must call submit_review for this work order with decision, feedback, and failedCriteria. Do not answer in prose only."
              });
              messages.push(actor.history.at(-1)!);
              continue;
            }
            break;
          }
          if (role === "oracle" && mode === "productive" && !this.store.activeWorkOrder(sessionId)) {
            this.actor(sessionId, "speaker").queued.push({
              id: randomUUID(),
              instruction: "Summarize the task for the user and ask only questions that materially block progress."
            });
          }
          if (role === "speaker" && mode === "productive" && workOrder) {
            this.actor(sessionId, "oracle").queued.push({
              id: randomUUID(),
              instruction: `Continue work order ${workOrder.id} using the user-facing context Speaker has gathered.`
            });
          }
          if (
            role === "speaker" &&
            speakerQuestion &&
            reply.text.trim() &&
            this.requireSession(sessionId).status !== "awaiting_user"
          ) {
            this.steer(
              sessionId,
              "speaker",
              "oracle",
              `Speaker handoff. User context: ${speakerQuestion}\nSpeaker interpretation and clarifications: ${reply.text}`,
              false
            );
          }
          break;
        }

        for (const call of reply.toolCalls) {
          const result = await this.dispatchTool(
            sessionId,
            role,
            call.name,
            call.arguments,
            controller.signal,
            mode,
            options
          );
          actor.history.push({
            role: "tool",
            toolCallId: call.id,
            toolName: call.name,
            content: result
          });
          messages.push(actor.history.at(-1) as ProviderMessage);
          messages.push({
            role: "user",
            content: `Tool ${call.name} result is above. Continue.`
          });
          if (call.name === "send_steer") break;
          if (this.requireSession(sessionId).status === "awaiting_user") break;
        }
        if (this.isSessionSatisfied(sessionId)) break;
      }
      if (!boundaryReached) throw new BrawlError(`${role} made no progress`);
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      this.store.appendEvent({
        sessionId,
        role,
        type: "error",
        content: message
      });
      this.setAgent(sessionId, role, "idle", undefined, message);
      throw error;
    } finally {
      runSignal.removeEventListener("abort", abort);
      this.activeTurns.delete(key);
      this.roleTurns.delete(key);
    }
  }

  private async dispatchTool(
    sessionId: string,
    role: Role,
    name: string,
    rawArgs: string,
    signal: AbortSignal,
    mode: Mode,
    options: DispatchToolOptions = {}
  ): Promise<string> {
    let args: Record<string, unknown>;
    try {
      args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
    } catch {
      return JSON.stringify({ ok: false, output: "Tool arguments were not valid JSON" });
    }
    if (name === "send_steer") {
      const to = String(args.to ?? "");
      if (!ROLES.includes(to as Role) || to === role) {
        return JSON.stringify({ ok: false, output: "Invalid steering target" });
      }
      this.steer(sessionId, role, to as Role, String(args.content ?? ""), Boolean(args.urgent));
      return JSON.stringify({ ok: true, output: `Steer delivered to ${to}` });
    }
    if (name === "submit_plan") {
      if (role !== "oracle") return JSON.stringify({ ok: false, output: "Only Oracle can submit the team plan" });
      const content = String(args.content ?? "").trim();
      if (!content) return JSON.stringify({ ok: false, output: "Plan cannot be empty" });
      this.emit(sessionId, { role, type: "plan", content });
      return JSON.stringify({ ok: true, output: "Plan recorded" });
    }
    if (name === "submit_work_order") {
      if (role !== "oracle") return JSON.stringify({ ok: false, output: "Only Oracle can create work orders" });
      const objective = String(args.objective ?? "").trim();
      if (!objective) return JSON.stringify({ ok: false, output: "Objective is required" });
      const order = this.store.createWorkOrder({
        sessionId,
        objective,
        constraints: stringList(args.constraints),
        acceptanceCriteria: stringList(args.acceptanceCriteria)
      });
      this.emit(sessionId, {
        role,
        type: "work_order",
        content: objective,
        data: { workOrder: order }
      });
      return JSON.stringify({ ok: true, output: `Created work order ${order.id}`, workOrder: order });
    }
    if (name === "submit_review") {
      if (role !== "oracle") {
        return JSON.stringify({ ok: false, output: "Only Oracle can submit a review" });
      }
      const workOrderId = String(args.workOrderId ?? "");
      const order = this.store.workOrdersById(workOrderId);
      if (!order || order.sessionId !== sessionId || order.status !== "submitted") {
        return JSON.stringify({ ok: false, output: "Work order is not awaiting review" });
      }
      const decision = args.decision === "approve" ? "approve" : args.decision === "reject" ? "reject" : null;
      const feedback = String(args.feedback ?? "").trim();
      const failedCriteria = stringList(args.failedCriteria);
      if (!decision || !feedback) {
        return JSON.stringify({
          ok: false,
          output: "Review decision and feedback are required"
        });
      }
      if (decision === "reject" && failedCriteria.length === 0) {
        return JSON.stringify({
          ok: false,
          output: "A rejected review must identify at least one failed criterion"
        });
      }
      this.missingReviewRetry.delete(workOrderId);
      if (decision === "approve") {
        await this.finishReview(sessionId, order, feedback, failedCriteria);
      } else {
        this.rejectReview(sessionId, order, feedback, failedCriteria);
      }
      return JSON.stringify({ ok: true, output: `Recorded ${decision} review` });
    }
    if (name === "cast_vote") {
      if (mode !== "fun") return JSON.stringify({ ok: false, output: "Votes are only used in fun mode" });
      const proposal = this.store.getProposal(String(args.proposalId ?? ""));
      if (!proposal || proposal.sessionId !== sessionId || proposal.status !== "pending") {
        return JSON.stringify({ ok: false, output: "Proposal is not pending" });
      }
      const previousVote = proposal.votes[role];
      if (previousVote !== null && !options.voteRevisionDeniers?.includes(role)) {
        return JSON.stringify({
          ok: false,
          output: options.debate
            ? "Only an agent who rejected the proposal may revise its vote"
            : "You have already voted in this debate round"
        });
      }
      const vote = args.vote === "approve" ? "approve" : "reject";
      const rationale = String(args.rationale ?? "").trim();
      if (!rationale) return JSON.stringify({ ok: false, output: "Vote rationale is required" });
      if (vote === previousVote) {
        return JSON.stringify({
          ok: true,
          output: `Your ${vote} vote stands. No revision was needed.`
        });
      }
      const updated = this.store.recordVote(proposal.id, role, vote);
      this.emit(sessionId, {
        role,
        type: "vote",
        content: `${previousVote === null ? "" : "revised "}${vote}: ${rationale}`,
        data: { proposalId: proposal.id, vote, rationale, revision: previousVote !== null }
      });
      this.events.publish(sessionId, { type: "proposal", proposal: updated });
      this.publishSession(sessionId);
      return JSON.stringify({ ok: true, output: `Recorded ${vote} vote` });
    }
    if (name === "ask_user") {
      if (role !== "speaker") return JSON.stringify({ ok: false, output: "Only Speaker can ask the user" });
      const question = String(args.question ?? "").trim();
      if (!question) return JSON.stringify({ ok: false, output: "Question cannot be empty" });
      this.store.setStatus(sessionId, "awaiting_user", "Waiting for Speaker's clarification question.");
      this.emit(sessionId, {
        role,
        type: "speaker_message",
        content: question,
        data: { question, kind: "clarification" }
      });
      this.emit(sessionId, { role, type: "status", content: "Waiting for the user's answer." });
      this.publishSession(sessionId);
      return JSON.stringify({ ok: true, output: "The session is paused until the user responds" });
    }
    if (mode === "fun" && options.debate && isWorkspaceTool(name)) {
      return JSON.stringify({
        ok: false,
        output: "Workspace actions are unavailable during the fun-mode rebuttal"
      });
    }
    if (role !== "executor" || !isWorkspaceTool(name)) {
      return JSON.stringify({ ok: false, output: `${role} cannot use ${name}` });
    }
    const workOrder = this.store.activeWorkOrder(sessionId);
    if (mode === "productive" && !workOrder) {
      return JSON.stringify({ ok: false, output: "Oracle must create an active work order first" });
    }
    if (mode === "fun" && this.store.activeProposal(sessionId)) {
      return JSON.stringify({ ok: false, output: "Wait for the pending action to be resolved before proposing another" });
    }
    const action = name as ToolName;
    const workspace = await resolveSessionWorkspace(
      this.runtime.workspace,
      this.requireSession(sessionId).workspace
    );
    const immutableArgs = await inspectForApproval(
      new WorkspaceTools(workspace, this.configStore.get().shellTimeoutMs),
      action,
      args
    );
    const sandboxMode = this.requireSession(sessionId).sandboxMode;
    const hostExecution = action === "shell_exec" && immutableArgs.execution === "host";
    if (hostExecution && !String(immutableArgs.hostReason ?? "").trim()) {
      const result: ToolResult = {
        ok: false,
        output: "Host execution requires a non-empty hostReason"
      };
      this.recordTool(sessionId, role, action, immutableArgs, result);
      return JSON.stringify(result);
    }
    if (hostExecution && sandboxMode === "enabled") {
      const result: ToolResult = {
        ok: false,
        output: "Host execution is unavailable in enabled sandbox mode"
      };
      this.recordTool(sessionId, role, action, immutableArgs, result);
      return JSON.stringify(result);
    }
    const tools = new WorkspaceTools(
      workspace,
      this.configStore.get().shellTimeoutMs,
      sandboxMode === "enabled" ? "enabled" : "disabled",
      { allowHostExecution: sandboxMode === "auto-review" && hostExecution }
    );
    if (mode === "productive") {
      let result: ToolResult;
      if (action === "shell_exec" && sandboxMode === "auto-review" && hostExecution) {
        const review = await this.reviewShellCommand(
          sessionId,
          workOrder,
          immutableArgs,
          signal
        );
        if (!review.allow) {
          result = {
            ok: false,
            output: `Sandbox review refused: ${review.reason}`,
            data: { sandboxReview: "refused", reason: review.reason }
          };
        } else {
          result = await tools.execute(action, immutableArgs, signal);
        }
      } else {
        result = await tools.execute(action, immutableArgs, signal);
      }
      this.recordTool(sessionId, role, action, immutableArgs, result);
      return JSON.stringify(result);
    }
    const proposal = this.store.createProposal({
      sessionId,
      action,
      args: immutableArgs,
      digest: tools.digest(action, immutableArgs),
      round: 1
    });
    this.emit(sessionId, {
      role,
      type: "proposal",
      content: `${action} ${JSON.stringify(immutableArgs).slice(0, 800)}`,
      data: { proposal }
    });
    this.events.publish(sessionId, { type: "proposal", proposal });
    this.store.setStatus(sessionId, "awaiting_consensus");
    this.publishSession(sessionId);
    this.queueAgent(sessionId, "oracle");
    this.queueAgent(sessionId, "speaker");
    this.queueAgent(sessionId, "executor");
    return JSON.stringify({
      ok: true,
      output: "Action proposed. All three roles must approve before execution.",
      proposalId: proposal.id
    });
  }

  private async executeApproved(
    sessionId: string,
    proposal: ActionProposal,
    signal: AbortSignal
  ): Promise<void> {
    const current = this.store.getProposal(proposal.id);
    if (!current || current.status !== "pending" || current.digest !== proposal.digest) return;
    this.store.updateProposal(current.id, { status: "executed" });
    this.events.publish(sessionId, { type: "proposal", proposal: null });
    const session = this.requireSession(sessionId);
    const workspace = await resolveSessionWorkspace(this.runtime.workspace, session.workspace);
    const hostExecution =
      current.action === "shell_exec" && current.args.execution === "host";
    const tools = new WorkspaceTools(
      workspace,
      this.configStore.get().shellTimeoutMs,
      session.sandboxMode === "enabled" ? "enabled" : "disabled",
      {
        allowHostExecution:
          session.sandboxMode === "auto-review" && hostExecution
      }
    );
    let result: ToolResult;
    if (
      current.action === "shell_exec" &&
      session.sandboxMode === "auto-review" &&
      hostExecution
    ) {
      const review = await this.reviewShellCommand(
        sessionId,
        this.store.activeWorkOrder(sessionId),
        current.args,
        signal
      );
      result = review.allow
        ? await tools.execute(current.action, current.args, signal)
        : {
            ok: false,
            output: `Sandbox review refused: ${review.reason}`,
            data: { sandboxReview: "refused", reason: review.reason }
          };
    } else {
      result = await tools.execute(current.action, current.args, signal);
    }
    if (!result.ok) {
      this.store.updateProposal(current.id, { status: "failed" });
    }
    this.recordTool(sessionId, "executor", current.action, current.args, result);
    this.store.setStatus(sessionId, "running");
    this.publishSession(sessionId);
  }

  private recordTool(
    sessionId: string,
    role: Role,
    action: ToolName,
    args: Record<string, unknown>,
    result: ToolResult
  ): void {
    this.emit(sessionId, {
      role,
      type: "tool_call",
      content: `${action} ${JSON.stringify(args).slice(0, 1_000)}`,
      data: { action, args }
    });
    this.emit(sessionId, {
      role,
      type: "tool_result",
      content: result.output,
      data: { ok: result.ok, ...result.data }
    });
  }

  private async reviewShellCommand(
    sessionId: string,
    workOrder: WorkOrder | null,
    args: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<{ allow: boolean; reason: string }> {
    if (!workOrder || workOrder.status !== "active") {
      return {
        allow: false,
        reason: "Oracle is required to have an active work order before command review"
      };
    }
    const config = this.agentConfig("oracle");
    const provider = this.requireProvider(config.providerId);
    const command = String(args.command ?? "");
    const timeoutMs = args.timeoutMs ?? this.configStore.get().shellTimeoutMs;
    const hostReason = String(args.hostReason ?? "").trim();
    const context = this.store
      .events(sessionId)
      .filter(
        (event) =>
          ["user_message", "speaker_message", "agent_message", "plan", "work_order"].includes(
            event.type
          )
      )
      .slice(-30)
      .map((event) => `${event.role}/${event.type}: ${event.content}`)
      .join("\n\n")
      .slice(-30_000);
    const messages: ProviderMessage[] = [
      {
        role: "system",
        content: `You are Oracle, acting as an ephemeral sandbox reviewer. Decide whether one exact shell command is safe to run and aligns with the user's intent and active work order.
This review is not a planning turn. You have no tools and no history outside the supplied context.
The Executor explicitly requested host execution. Approve only when the command needs capabilities that the sandbox blocks and the stated reason justifies running it outside Bubblewrap. Deny commands that escape the workspace without necessity, alter system configuration, invoke sudo or privilege escalation, expose credentials, persist outside the workspace, or exceed the stated intent.
Return only JSON in the form {"allow":true,"reason":"brief reason"} or {"allow":false,"reason":"specific denial reason"}.
A denial must include a non-empty reason.`
      },
      {
        role: "user",
        content: `Visible session context:
${context || "(none)"}

Active work order:
${workOrder.id}: ${workOrder.objective}
Constraints: ${workOrder.constraints.join("; ") || "(none)"}
Acceptance criteria: ${workOrder.acceptanceCriteria.join("; ") || "(none)"}

Exact shell_exec request:
${command}
Timeout: ${String(timeoutMs)}
Requested execution: host (outside Bubblewrap)
Executor's host-access reason:
${hostReason}

Approve only if this exact command truly needs host capabilities that Bubblewrap blocks, remains aligned with the work order and user intent, and does not access secrets or perform unrelated system changes.`
      }
    ];
    try {
      const reply = await complete({
        provider,
        config,
        messages,
        tools: [],
        signal,
        onDelta: () => undefined
      });
      return parseSandboxReview(reply.text);
    } catch (error) {
      if (signal.aborted) throw error;
      return {
        allow: false,
        reason: `Sandbox review failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  private async finishReview(
    sessionId: string,
    workOrder: WorkOrder,
    feedback: string,
    failedCriteria: string[]
  ): Promise<void> {
    const reviewed = this.store.recordReview(workOrder.id, {
      decision: "approve",
      feedback,
      failedCriteria
    });
    this.emit(sessionId, {
      role: "oracle",
      type: "review",
      content: feedback,
      data: { workOrder: reviewed, decision: "approve" }
    });
    const evidence = this.store
      .events(sessionId)
      .filter((event) => event.type === "tool_result")
      .map((event) => `${event.role}: ${event.content}`)
      .join("\n\n")
      .slice(-8_000);
    this.actor(sessionId, "speaker").queued.push({
      id: randomUUID(),
      instruction: `Summarize the reviewed work for the user. Confirm only evidence-backed outcomes and list remaining risks or questions.\nWork order: ${workOrder.objective}\nAcceptance criteria: ${workOrder.acceptanceCriteria.join("; ")}\nVerified tool evidence:\n${evidence || "No tool results were recorded."}`
    });
  }

  private rejectReview(
    sessionId: string,
    workOrder: WorkOrder,
    feedback: string,
    failedCriteria: string[]
  ): void {
    const rejected = this.store.recordReview(workOrder.id, {
      decision: "reject",
      feedback,
      failedCriteria
    });
    this.emit(sessionId, {
      role: "oracle",
      type: "review",
      content: feedback,
      data: { workOrder: rejected, decision: "reject" }
    });
    this.actor(sessionId, "executor").queued.push({
      id: randomUUID(),
      instruction:
        `Oracle rejected work order ${workOrder.id}. Address every failed criterion and resubmit with evidence.\n` +
        `Feedback: ${feedback}\nFailed criteria: ${failedCriteria.join("; ")}`
    });
    this.publishSession(sessionId);
  }

  private isSessionSatisfied(sessionId: string): boolean {
    const active = this.store.activeWorkOrder(sessionId);
    return Boolean(
      !active &&
      !this.store.activeProposal(sessionId) &&
      this.actor(sessionId, "speaker").queued.length === 0
    );
  }

  private consumeSteers(sessionId: string, role: Role): ProviderMessage[] {
    const messages: ProviderMessage[] = [];
    while (true) {
      const next = this.store.consumePendingMessage(sessionId, role);
      if (!next) break;
      messages.push({
        role: "user",
        content: `Steer from teammate${next.urgent ? " (urgent)" : ""}:\n${next.content}`
      });
    }
    return messages;
  }

  private processPendingSteers(sessionId: string, mode: Mode): void {
    const session = this.requireSession(sessionId);
    const pending = this.store.pendingMessages(sessionId);
    for (const item of pending) {
      const role = item.to;
      if (mode === "productive") {
        this.actor(sessionId, "speaker").queued.push({
          id: randomUUID(),
          instruction: `A teammate steered ${role}: ${item.content}\nDecide how to relay this to the user or the team.`
        });
        this.store.consumePendingMessage(sessionId, role);
      } else if (session.status === "awaiting_consensus") {
        this.store.consumePendingMessage(sessionId, role);
      }
    }
  }

  private queueAgent(sessionId: string, role: Role): void {
    const key = `${sessionId}:${role}`;
    if (!this.activeTurns.has(key)) {
      this.setAgent(sessionId, role, "waiting", "Reviewing the action proposal");
    }
  }

  private ensureProposalDeliberation(sessionId: string, mode: Mode, role: Role): void {
    if (mode !== "fun") return;
    const session = this.requireSession(sessionId);
    if (session.status !== "awaiting_consensus") return;
    const proposal = this.store.activeProposal(sessionId);
    if (proposal && role === "executor") {
      this.setAgent(sessionId, role, "waiting", `Evaluating proposal round ${proposal.round}`);
    }
  }

  private async runProposalRound(
    sessionId: string,
    proposal: ActionProposal,
    signal: AbortSignal,
    mode: Mode
  ): Promise<"continue" | "awaiting_user" | "done"> {
    const missing = ROLES.filter((role) => proposal.votes[role] === null);
    if (missing.length > 0) {
      const instruction =
        `Fun-mode deliberation for proposal ${proposal.id}, round ${proposal.round}/${this.configStore.get().debateRounds}. ` +
        `Evaluate the exact ${proposal.action} proposal with arguments ${JSON.stringify(proposal.args)}. ` +
        "Persuade the other agents, then use cast_vote with your explicit approve or reject decision and rationale.";
      await Promise.all(missing.map((role) => this.runAgent(sessionId, role, signal, mode, instruction)));
    }

    const current = this.store.getProposal(proposal.id);
    if (!current || current.status !== "pending") return "done";
    if (Object.values(current.votes).every((vote) => vote === "approve")) {
      await this.executeApproved(sessionId, current, signal);
      return "continue";
    }

    if (Object.values(current.votes).some((vote) => vote === null)) {
      this.actor(sessionId, "speaker").queued.push({
        id: randomUUID(),
        instruction:
          "Some fun-mode votes were not recorded. Tell the user which roles are still undecided and ask for guidance before continuing."
      });
      this.store.setStatus(
        sessionId,
        "awaiting_user",
        "The team did not cast all votes. Provide guidance to continue the debate."
      );
      this.publishSession(sessionId);
      return "awaiting_user";
    }

    await this.runExecutorRebuttal(sessionId, current, signal, mode);

    const revised = this.store.getProposal(current.id);
    if (!revised || revised.status !== "pending") return "done";
    if (Object.values(revised.votes).every((vote) => vote === "approve")) {
      await this.executeApproved(sessionId, revised, signal);
      return "continue";
    }

    if (current.round < this.configStore.get().debateRounds) {
      const next = this.store.advanceProposalRound(current.id);
      this.events.publish(sessionId, { type: "proposal", proposal: next });
      this.emit(sessionId, {
        role: "system",
        type: "status",
        content: `Proposal ${current.id} moved to debate round ${next.round}; every role must cast a vote.`
      });
      return "continue";
    }

    this.store.updateProposal(current.id, { status: "rejected" });
    this.events.publish(sessionId, { type: "proposal", proposal: null });
    this.actor(sessionId, "speaker").queued.push({
      id: randomUUID(),
      instruction:
        "The fun-mode debate ended without unanimous approval. Explain the deadlock and ask the user for direction before any revised action."
    });
    this.store.setStatus(
      sessionId,
      "awaiting_user",
      "The action was not unanimously approved before the debate limit."
    );
    this.publishSession(sessionId);
    return "awaiting_user";
  }

  private async runExecutorRebuttal(
    sessionId: string,
    proposal: ActionProposal,
    signal: AbortSignal,
    mode: Mode
  ): Promise<void> {
    const deniers = ROLES.filter((role) => proposal.votes[role] === "reject");
    if (deniers.length === 0) return;

    const rationales = this.voteRationales(sessionId, proposal.id);
    const denialSummary = deniers
      .map((role) => `${role}: ${rationales[role] ?? "No rationale was recorded."}`)
      .join("\n");
    const maxRounds = this.configStore.get().debateRounds;
    this.emit(sessionId, {
      role: "system",
      type: "status",
      content:
        `Executor gets a rebuttal in proposal round ${proposal.round}/${maxRounds} ` +
        `against ${deniers.join(", ")}.`
    });

    const debateStart = this.store.events(sessionId).at(-1)?.seq ?? 0;
    await this.runAgent(
      sessionId,
      "executor",
      signal,
      mode,
      `Fun-mode rebuttal for proposal ${proposal.id}, round ${proposal.round}/${maxRounds}. ` +
        `The following roles rejected the immutable ${proposal.action} proposal:\n${denialSummary}\n` +
        "Use send_steer to directly persuade each denier with concrete evidence. Do not propose or execute " +
        "workspace actions during this rebuttal.",
      { debate: true }
    );
    const debateEvents = this.store
      .events(sessionId)
      .filter(
        (event) =>
          event.seq > debateStart &&
          event.role === "executor" &&
          (event.type === "agent_message" || event.type === "steer")
      )
      .map((event) => event.content)
      .join("\n\n")
      .slice(-8_000);

    await Promise.all(
      deniers.map((role) =>
        this.runAgent(
          sessionId,
          role,
          signal,
          mode,
          `Fun-mode vote response for proposal ${proposal.id}, round ${proposal.round}/${maxRounds}. ` +
            `Your rejection reason was: ${rationales[role] ?? "No rationale was recorded."}\n` +
            `Executor's rebuttal:\n${debateEvents || "Review Executor's steering message before deciding."}\n` +
            "You may retain your rejection by making no cast_vote call. If Executor's evidence changes your " +
            "decision, use cast_vote again for this same proposal with your revised vote and rationale. " +
            "Do not propose or execute workspace actions during this rebuttal.",
          {
            debate: true,
            voteRevisionDeniers: deniers
          }
        )
      )
    );
  }

  private voteRationales(sessionId: string, proposalId: string): Partial<Record<Role, string>> {
    const rationales: Partial<Record<Role, string>> = {};
    for (const event of this.store.events(sessionId)) {
      if (event.type !== "vote" || event.role === "system" || event.role === "user") continue;
      if (event.data?.proposalId !== proposalId) continue;
      const rationale = event.data?.rationale;
      if (typeof rationale === "string") rationales[event.role] = rationale;
    }
    return rationales;
  }

  private anyPendingSteer(sessionId: string): boolean {
    return this.store.pendingMessages(sessionId).length > 0;
  }

  private actor(sessionId: string, role: Role): AgentActor {
    const key = `${sessionId}:${role}`;
    let actor = this.actors.get(key);
    if (!actor) {
      actor = { sessionId, role, history: [], queued: [] };
      this.actors.set(key, actor);
    }
    return actor;
  }

  private toolsFor(role: Role): ProviderTool[] {
    return role === "executor" ? [...META_TOOLS, ...WORKSPACE_TOOLS] : [...META_TOOLS];
  }

  private requireProvider(id: string | null): ProviderConfig {
    if (!id) throw new BrawlError("Agent has no provider configured", 409);
    const provider = this.configStore.provider(id);
    if (!provider) throw new BrawlError(`Provider ${id} is not configured`, 409);
    return provider;
  }

  private agentConfig(role: Role): AgentConfig {
    return this.configStore.get().agents[role];
  }

  private configReady(): boolean {
    const config = this.configStore.get();
    return ROLES.every((role) => {
      const agent = config.agents[role];
      return Boolean(agent.providerId && agent.model && config.providers.some((p) => p.id === agent.providerId));
    });
  }

  private requireSession(sessionId: string): Session {
    const session = this.store.getSession(sessionId);
    if (!session) throw new BrawlError("Session not found", 404);
    return session;
  }

  private setAgent(
    sessionId: string,
    role: Role,
    status: AgentState["status"],
    summary: string | undefined,
    lastError?: string
  ): void {
    const agent = this.store.updateAgent(sessionId, role, {
      status,
      ...(summary === undefined ? {} : { summary }),
      ...(lastError === undefined ? {} : { lastError })
    });
    this.events.publish(sessionId, { type: "agent", agent });
  }

  private abortRole(sessionId: string, role: Role): void {
    const turn = this.roleTurns.get(`${sessionId}:${role}`);
    if (turn) {
      turn.controller.abort(new Error("Urgent steering"));
    }
    this.setAgent(sessionId, role, "waiting", "Urgent steering queued");
  }

  private emit(
    sessionId: string,
    input: {
      role: Parameters<Store["appendEvent"]>[0]["role"];
      type: Parameters<Store["appendEvent"]>[0]["type"];
      content: string;
      data?: Record<string, unknown>;
    }
  ): void {
    const event = this.store.appendEvent({ sessionId, ...input });
    this.events.publish(sessionId, { type: "event", event });
  }

  private publishSession(sessionId: string): void {
    const session = this.store.getSession(sessionId);
    if (!session) return;
    const envelope: StreamEnvelope = { type: "session", session };
    this.events.publish(sessionId, envelope);
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function isWorkspaceTool(value: string): value is ToolName {
  return [
    "workspace_list",
    "workspace_read",
    "workspace_search",
    "workspace_write",
    "workspace_patch",
    "shell_exec"
  ].includes(value);
}

function parseSandboxReview(text: string): { allow: boolean; reason: string } {
  const trimmed = text.trim();
  const json = trimmed.match(/\{[\s\S]*\}/)?.[0] ?? "";
  try {
    const value = JSON.parse(json) as { allow?: unknown; reason?: unknown };
    if (typeof value.allow !== "boolean") {
      return { allow: false, reason: "Oracle returned a malformed sandbox review" };
    }
    const reason = typeof value.reason === "string" ? value.reason.trim() : "";
    if (!value.allow && !reason) {
      return { allow: false, reason: "Oracle denied the command without a reason" };
    }
    return {
      allow: value.allow,
      reason: reason || "Command approved by Oracle"
    };
  } catch {
    return { allow: false, reason: "Oracle returned malformed sandbox review JSON" };
  }
}
