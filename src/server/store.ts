import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type {
  ActionProposal,
  AgentState,
  Role,
  SandboxMode,
  Session,
  SessionDetail,
  SessionStatus,
  TranscriptEvent,
  TranscriptType,
  WorkOrder
} from "../shared/protocol.js";

type Row = Record<string, unknown>;

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        workspace TEXT NOT NULL,
        active_work_order_id TEXT,
        failure TEXT,
        last_seq INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_states (
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        last_error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, role),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        data TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (session_id, seq),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS events_session_seq ON events(session_id, seq);
      CREATE TABLE IF NOT EXISTS work_orders (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        objective TEXT NOT NULL,
        constraints TEXT NOT NULL,
        acceptance_criteria TEXT NOT NULL,
        status TEXT NOT NULL,
        review_decision TEXT,
        review_feedback TEXT,
        review_failed_criteria TEXT,
        reviewed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        action TEXT NOT NULL,
        args TEXT NOT NULL,
        digest TEXT NOT NULL,
        round INTEGER NOT NULL,
        status TEXT NOT NULL,
        votes TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS commands (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        action TEXT NOT NULL,
        args TEXT NOT NULL,
        phase TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        from_role TEXT NOT NULL,
        to_role TEXT NOT NULL,
        content TEXT NOT NULL,
        urgent INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    const sessionColumns = this.db.prepare("PRAGMA table_info(sessions)").all() as Row[];
    if (!sessionColumns.some((column) => column.name === "sandbox_mode")) {
      this.db.exec(
        "ALTER TABLE sessions ADD COLUMN sandbox_mode TEXT NOT NULL DEFAULT 'enabled'"
      );
    }
    this.db.exec(
      "UPDATE sessions SET sandbox_mode='enabled' " +
        "WHERE mode='fun' AND sandbox_mode='auto-review'"
    );
    this.db.exec(
      "UPDATE sessions SET sandbox_mode='enabled' " +
        "WHERE sandbox_mode NOT IN ('enabled', 'disabled', 'auto-review')"
    );
    const workOrderColumns = this.db.prepare("PRAGMA table_info(work_orders)").all() as Row[];
    if (!workOrderColumns.some((column) => column.name === "review_decision")) {
      this.db.exec("ALTER TABLE work_orders ADD COLUMN review_decision TEXT");
    }
    if (!workOrderColumns.some((column) => column.name === "review_feedback")) {
      this.db.exec("ALTER TABLE work_orders ADD COLUMN review_feedback TEXT");
    }
    if (!workOrderColumns.some((column) => column.name === "review_failed_criteria")) {
      this.db.exec("ALTER TABLE work_orders ADD COLUMN review_failed_criteria TEXT");
    }
    if (!workOrderColumns.some((column) => column.name === "reviewed_at")) {
      this.db.exec("ALTER TABLE work_orders ADD COLUMN reviewed_at TEXT");
    }
  }

  close(): void {
    this.db.close();
  }

  createSession(input: {
    title: string;
    mode: Session["mode"];
    sandboxMode: Session["sandboxMode"];
    workspace: string;
  }): Session {
    const now = new Date().toISOString();
    const session: Session = {
      id: randomUUID(),
      title: input.title,
      mode: input.mode,
      sandboxMode: input.sandboxMode,
      status: "idle",
      workspace: input.workspace,
      activeWorkOrderId: null,
      failure: null,
      lastSeq: 0,
      createdAt: now,
      updatedAt: now
    };
    this.db
      .prepare(
        `INSERT INTO sessions
         (id, title, mode, sandbox_mode, status, workspace, active_work_order_id, failure, last_seq, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        session.id,
        session.title,
        session.mode,
        session.sandboxMode,
        session.status,
        session.workspace,
        null,
        null,
        0,
        now,
        now
      );
    for (const role of ["oracle", "executor", "speaker"] as const) {
      this.db
        .prepare(
          `INSERT INTO agent_states (session_id, role, status, summary, last_error, updated_at)
           VALUES (?, ?, 'idle', '', NULL, ?)`
        )
        .run(session.id, role, now);
    }
    return session;
  }

  listSessions(): Session[] {
    return (this.db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC").all() as Row[]).map(
      mapSession
    );
  }

  getSession(id: string): Session | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Row | undefined;
    return row ? mapSession(row) : null;
  }

  deleteSession(id: string): boolean {
    const result = this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    return result.changes > 0;
  }

  sessionDetail(id: string, afterSeq = 0): SessionDetail | null {
    const session = this.getSession(id);
    if (!session) return null;
    return {
      session,
      agents: this.agentStates(id),
      workOrders: this.workOrders(id),
      activeProposal: this.activeProposal(id),
      events: this.events(id, afterSeq)
    };
  }

  updateSession(id: string, patch: Partial<Pick<Session, "title" | "mode" | "sandboxMode" | "status" | "workspace" | "activeWorkOrderId" | "failure">>): Session {
    const current = this.getSession(id);
    if (!current) throw new Error(`Unknown session ${id}`);
    const next = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString()
    };
    this.db
      .prepare(
        `UPDATE sessions SET title=?, mode=?, sandbox_mode=?, status=?, workspace=?, active_work_order_id=?, failure=?, updated_at=?
         WHERE id=?`
      )
      .run(
        next.title,
        next.mode,
        next.sandboxMode,
        next.status,
        next.workspace,
        next.activeWorkOrderId,
        next.failure,
        next.updatedAt,
        id
      );
    return next;
  }

  setStatus(id: string, status: SessionStatus, failure: string | null = null): Session {
    return this.updateSession(id, { status, failure });
  }

  appendEvent(input: {
    sessionId: string;
    role: TranscriptEvent["role"];
    type: TranscriptType;
    content: string;
    data?: Record<string, unknown>;
  }): TranscriptEvent {
    const now = new Date().toISOString();
    return this.transaction(() => {
      const session = this.getSession(input.sessionId);
      if (!session) throw new Error(`Unknown session ${input.sessionId}`);
      const seq = session.lastSeq + 1;
      this.db
        .prepare(
          `INSERT INTO events (session_id, seq, role, type, content, data, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.sessionId,
          seq,
          input.role,
          input.type,
          input.content,
          input.data ? JSON.stringify(input.data) : null,
          now
        );
      this.db
        .prepare("UPDATE sessions SET last_seq=?, updated_at=? WHERE id=?")
        .run(seq, now, input.sessionId);
      const id = Number(
        (this.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id
      );
      const event: TranscriptEvent = {
        id,
        sessionId: input.sessionId,
        seq,
        role: input.role,
        type: input.type,
        content: input.content,
        createdAt: now
      };
      if (input.data) event.data = input.data;
      return event;
    });
  }

  events(sessionId: string, afterSeq = 0, limit = 2_000): TranscriptEvent[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM events WHERE session_id=? AND seq>? ORDER BY seq ASC LIMIT ?`
        )
        .all(sessionId, afterSeq, limit) as Row[]
    ).map(mapEvent);
  }

  agentStates(sessionId: string): AgentState[] {
    return (
      this.db
        .prepare("SELECT * FROM agent_states WHERE session_id=? ORDER BY rowid ASC")
        .all(sessionId) as Row[]
    ).map(mapAgentState);
  }

  updateAgent(
    sessionId: string,
    role: Role,
    patch: Partial<Pick<AgentState, "status" | "summary" | "lastError">>
  ): AgentState {
    const current = this.agentStates(sessionId).find((agent) => agent.role === role);
    if (!current) throw new Error(`Unknown agent ${role}`);
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.db
      .prepare(
        `UPDATE agent_states SET status=?, summary=?, last_error=?, updated_at=?
         WHERE session_id=? AND role=?`
      )
      .run(next.status, next.summary, next.lastError, next.updatedAt, sessionId, role);
    return next;
  }

  createWorkOrder(
    input: Omit<
      WorkOrder,
      | "id"
      | "createdAt"
      | "updatedAt"
      | "status"
      | "reviewDecision"
      | "reviewFeedback"
      | "reviewFailedCriteria"
      | "reviewedAt"
    >
  ): WorkOrder {
    const now = new Date().toISOString();
    const order: WorkOrder = {
      ...input,
      id: randomUUID(),
      status: "active",
      reviewDecision: null,
      reviewFeedback: null,
      reviewFailedCriteria: [],
      reviewedAt: null,
      createdAt: now,
      updatedAt: now
    };
    this.db
      .prepare(
        `INSERT INTO work_orders
         (id, session_id, objective, constraints, acceptance_criteria, status,
          review_decision, review_feedback, review_failed_criteria, reviewed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        order.id,
        order.sessionId,
        order.objective,
        JSON.stringify(order.constraints),
        JSON.stringify(order.acceptanceCriteria),
        order.status,
        null,
        null,
        null,
        null,
        now,
        now
      );
    this.db
      .prepare("UPDATE work_orders SET status='reviewed' WHERE session_id=? AND id<>? AND status='active'")
      .run(input.sessionId, order.id);
    this.updateSession(input.sessionId, { activeWorkOrderId: order.id });
    return order;
  }

  updateWorkOrder(id: string, status: WorkOrder["status"]): WorkOrder {
    const current = this.workOrdersById(id);
    if (!current) throw new Error(`Unknown work order ${id}`);
    const now = new Date().toISOString();
    const next: WorkOrder = {
      ...current,
      status,
      ...(status === "submitted" || status === "active"
        ? {
            reviewDecision: null,
            reviewFeedback: null,
            reviewFailedCriteria: [],
            reviewedAt: null
          }
        : {}),
      updatedAt: now
    };
    this.db
      .prepare(
        `UPDATE work_orders SET status=?, review_decision=?, review_feedback=?,
         review_failed_criteria=?, reviewed_at=?, updated_at=? WHERE id=?`
      )
      .run(
        next.status,
        next.reviewDecision,
        next.reviewFeedback,
        JSON.stringify(next.reviewFailedCriteria),
        next.reviewedAt,
        next.updatedAt,
        id
      );
    if (status === "reviewed" || status === "rejected") {
      const session = this.getSession(current.sessionId);
      if (session?.activeWorkOrderId === id) {
        this.updateSession(current.sessionId, { activeWorkOrderId: null });
      }
    }
    return next;
  }

  recordReview(
    id: string,
    input: {
      decision: "approve" | "reject";
      feedback: string;
      failedCriteria: string[];
    }
  ): WorkOrder {
    const current = this.workOrdersById(id);
    if (!current) throw new Error(`Unknown work order ${id}`);
    const now = new Date().toISOString();
    const approved = input.decision === "approve";
    const next: WorkOrder = {
      ...current,
      status: approved ? "reviewed" : "active",
      reviewDecision: input.decision,
      reviewFeedback: input.feedback,
      reviewFailedCriteria: input.failedCriteria,
      reviewedAt: now,
      updatedAt: now
    };
    this.db
      .prepare(
        `UPDATE work_orders SET status=?, review_decision=?, review_feedback=?,
         review_failed_criteria=?, reviewed_at=?, updated_at=? WHERE id=?`
      )
      .run(
        next.status,
        next.reviewDecision,
        next.reviewFeedback,
        JSON.stringify(next.reviewFailedCriteria),
        next.reviewedAt,
        next.updatedAt,
        id
      );
    if (approved) {
      const session = this.getSession(current.sessionId);
      if (session?.activeWorkOrderId === id) {
        this.updateSession(current.sessionId, { activeWorkOrderId: null });
      }
    }
    return next;
  }

  workOrders(sessionId: string): WorkOrder[] {
    return (
      this.db
        .prepare("SELECT * FROM work_orders WHERE session_id=? ORDER BY created_at ASC")
        .all(sessionId) as Row[]
    ).map(mapWorkOrder);
  }

  activeWorkOrder(sessionId: string): WorkOrder | null {
    const session = this.getSession(sessionId);
    return session?.activeWorkOrderId ? this.workOrdersById(session.activeWorkOrderId) : null;
  }

  workOrdersById(id: string): WorkOrder | null {
    const row = this.db.prepare("SELECT * FROM work_orders WHERE id=?").get(id) as Row | undefined;
    return row ? mapWorkOrder(row) : null;
  }

  createProposal(input: {
    sessionId: string;
    action: ActionProposal["action"];
    args: Record<string, unknown>;
    digest: string;
    round: number;
  }): ActionProposal {
    const now = new Date().toISOString();
    const proposal: ActionProposal = {
      ...input,
      id: randomUUID(),
      status: "pending",
      votes: { oracle: null, executor: null, speaker: null },
      createdAt: now,
      updatedAt: now
    };
    this.db
      .prepare(
        `INSERT INTO proposals
         (id, session_id, action, args, digest, round, status, votes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        proposal.id,
        proposal.sessionId,
        proposal.action,
        JSON.stringify(proposal.args),
        proposal.digest,
        proposal.round,
        proposal.status,
        JSON.stringify(proposal.votes),
        now,
        now
      );
    return proposal;
  }

  advanceProposalRound(id: string): ActionProposal {
    const current = this.getProposal(id);
    if (!current) throw new Error(`Unknown proposal ${id}`);
    return this.updateProposal(id, {
      round: current.round + 1,
      votes: { oracle: null, executor: null, speaker: null }
    });
  }

  getProposal(id: string): ActionProposal | null {
    const row = this.db.prepare("SELECT * FROM proposals WHERE id=?").get(id) as Row | undefined;
    return row ? mapProposal(row) : null;
  }

  activeProposal(sessionId: string): ActionProposal | null {
    const row = this.db
      .prepare("SELECT * FROM proposals WHERE session_id=? AND status='pending' ORDER BY created_at DESC LIMIT 1")
      .get(sessionId) as Row | undefined;
    return row ? mapProposal(row) : null;
  }

  updateProposal(
    id: string,
    patch: Partial<Pick<ActionProposal, "status" | "votes" | "round">>
  ): ActionProposal {
    const current = this.getProposal(id);
    if (!current) throw new Error(`Unknown proposal ${id}`);
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.db
      .prepare("UPDATE proposals SET status=?, votes=?, round=?, updated_at=? WHERE id=?")
      .run(next.status, JSON.stringify(next.votes), next.round, next.updatedAt, id);
    return next;
  }

  recordVote(id: string, role: Role, vote: "approve" | "reject"): ActionProposal {
    const current = this.getProposal(id);
    if (!current) throw new Error(`Unknown proposal ${id}`);
    if (current.status !== "pending") return current;
    const votes = { ...current.votes, [role]: vote };
    return this.updateProposal(id, { votes });
  }

  queueCommand(input: {
    sessionId: string;
    action: string;
    args: Record<string, unknown>;
    phase: string;
  }): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO commands (id, session_id, action, args, phase, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.sessionId, input.action, JSON.stringify(input.args), input.phase, now, now);
    return id;
  }

  command(id: string): { id: string; sessionId: string; action: string; args: Record<string, unknown>; phase: string } | null {
    const row = this.db.prepare("SELECT * FROM commands WHERE id=?").get(id) as Row | undefined;
    return row
      ? {
          id: String(row.id),
          sessionId: String(row.session_id),
          action: String(row.action),
          args: JSON.parse(String(row.args)) as Record<string, unknown>,
          phase: String(row.phase)
        }
      : null;
  }

  updateCommand(id: string, phase: string): void {
    this.db
      .prepare("UPDATE commands SET phase=?, updated_at=? WHERE id=?")
      .run(phase, new Date().toISOString(), id);
  }

  restoreInterruptedSessions(): void {
    this.db
      .prepare(
        `UPDATE sessions SET status='interrupted', failure='Backend stopped before a durable outcome was recorded.', updated_at=?
         WHERE status IN ('queued', 'running', 'awaiting_consensus')`
      )
      .run(new Date().toISOString());
    this.db
      .prepare("UPDATE proposals SET status='stale', updated_at=? WHERE status='pending'")
      .run(new Date().toISOString());
  }

  queuePendingMessage(input: {
    sessionId: string;
    from: Role;
    to: Role;
    content: string;
    urgent: boolean;
  }): void {
    this.db
      .prepare(
        `INSERT INTO pending_messages (id, session_id, from_role, to_role, content, urgent, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        randomUUID(),
        input.sessionId,
        input.from,
        input.to,
        input.content,
        input.urgent ? 1 : 0,
        new Date().toISOString()
      );
  }

  consumePendingMessage(sessionId: string, to: Role): { content: string; urgent: boolean } | null {
    const row = this.db
      .prepare(
        "SELECT id, content, urgent FROM pending_messages WHERE session_id=? AND to_role=? ORDER BY created_at ASC LIMIT 1"
      )
      .get(sessionId, to) as Row | undefined;
    if (!row) return null;
    this.db.prepare("DELETE FROM pending_messages WHERE id=?").run(String(row.id));
    return { content: String(row.content), urgent: Number(row.urgent) === 1 };
  }

  pendingMessages(sessionId: string): Array<{ from: Role; to: Role; content: string; urgent: boolean }> {
    return (
      this.db
        .prepare(
          "SELECT from_role, to_role, content, urgent FROM pending_messages WHERE session_id=? ORDER BY created_at ASC"
        )
        .all(sessionId) as Row[]
    ).map((row) => ({
      from: String(row.from_role) as Role,
      to: String(row.to_role) as Role,
      content: String(row.content),
      urgent: Number(row.urgent) === 1
    }));
  }

  transaction<T>(work: () => T): T {
    this.db.exec("SAVEPOINT brawl_tx");
    try {
      const result = work();
      this.db.exec("RELEASE brawl_tx");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK TO brawl_tx");
      this.db.exec("RELEASE brawl_tx");
      throw error;
    }
  }
}

function mapSession(row: Row): Session {
  return {
    id: String(row.id),
    title: String(row.title),
    mode: String(row.mode) as Session["mode"],
    sandboxMode: sandboxMode(row.sandbox_mode),
    status: String(row.status) as SessionStatus,
    workspace: String(row.workspace),
    activeWorkOrderId: row.active_work_order_id ? String(row.active_work_order_id) : null,
    failure: row.failure ? String(row.failure) : null,
    lastSeq: Number(row.last_seq),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function sandboxMode(value: unknown): SandboxMode {
  return value === "disabled" || value === "auto-review" ? value : "enabled";
}

function mapEvent(row: Row): TranscriptEvent {
  const event: TranscriptEvent = {
    id: Number(row.id),
    sessionId: String(row.session_id),
    seq: Number(row.seq),
    role: String(row.role) as TranscriptEvent["role"],
    type: String(row.type) as TranscriptType,
    content: String(row.content),
    createdAt: String(row.created_at)
  };
  if (row.data) event.data = JSON.parse(String(row.data)) as Record<string, unknown>;
  return event;
}

function mapAgentState(row: Row): AgentState {
  return {
    sessionId: String(row.session_id),
    role: String(row.role) as Role,
    status: String(row.status) as AgentState["status"],
    summary: String(row.summary),
    lastError: row.last_error ? String(row.last_error) : null,
    updatedAt: String(row.updated_at)
  };
}

function mapWorkOrder(row: Row): WorkOrder {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    objective: String(row.objective),
    constraints: JSON.parse(String(row.constraints)) as string[],
    acceptanceCriteria: JSON.parse(String(row.acceptance_criteria)) as string[],
    status: String(row.status) as WorkOrder["status"],
    reviewDecision:
      row.review_decision === "approve" || row.review_decision === "reject"
        ? row.review_decision
        : null,
    reviewFeedback: row.review_feedback ? String(row.review_feedback) : null,
    reviewFailedCriteria: row.review_failed_criteria
      ? (JSON.parse(String(row.review_failed_criteria)) as string[])
      : [],
    reviewedAt: row.reviewed_at ? String(row.reviewed_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapProposal(row: Row): ActionProposal {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    action: String(row.action) as ActionProposal["action"],
    args: JSON.parse(String(row.args)) as Record<string, unknown>,
    digest: String(row.digest),
    round: Number(row.round),
    status: String(row.status) as ActionProposal["status"],
    votes: JSON.parse(String(row.votes)) as ActionProposal["votes"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}
