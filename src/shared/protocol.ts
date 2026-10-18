export const ROLES = ["oracle", "executor", "speaker"] as const;
export type Role = (typeof ROLES)[number];

export const MODES = ["productive", "fun"] as const;
export type Mode = (typeof MODES)[number];

export const SANDBOX_MODES = ["enabled", "disabled", "auto-review"] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

export const PROVIDER_KINDS = ["chat", "responses"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export type ReasoningEffort =
  | "provider-default"
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export const REASONING_EFFORTS = [
  "provider-default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh"
] as const satisfies readonly ReasoningEffort[];

export type SessionStatus =
  | "idle"
  | "queued"
  | "running"
  | "awaiting_consensus"
  | "awaiting_user"
  | "paused"
  | "interrupted"
  | "completed"
  | "failed";

export type ToolName =
  | "workspace_list"
  | "workspace_read"
  | "workspace_search"
  | "workspace_write"
  | "workspace_patch"
  | "shell_exec";

export type AgentStatus = "idle" | "thinking" | "waiting" | "running_tool" | "paused";

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  api: ProviderKind;
  apiKey?: string;
  apiKeyEnv?: string;
  headers: Record<string, string>;
  models: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PublicProviderConfig extends Omit<ProviderConfig, "apiKey"> {
  hasApiKey: boolean;
}

export interface AgentConfig {
  role: Role;
  providerId: string | null;
  model: string;
  reasoningEffort: ReasoningEffort;
}

export interface HarnessConfig {
  providers: PublicProviderConfig[];
  agents: Record<Role, AgentConfig>;
  debateRounds: number;
  shellTimeoutMs: number;
  maxRunMs: number;
  dataDir: string;
  workspace: string;
}

export interface WorkOrder {
  id: string;
  sessionId: string;
  objective: string;
  constraints: string[];
  acceptanceCriteria: string[];
  status: "proposed" | "active" | "submitted" | "reviewed" | "rejected";
  createdAt: string;
  updatedAt: string;
}

export interface ActionProposal {
  id: string;
  sessionId: string;
  action: ToolName;
  args: Record<string, unknown>;
  digest: string;
  round: number;
  status: "pending" | "approved" | "rejected" | "executed" | "stale" | "failed";
  votes: Record<Role, "approve" | "reject" | null>;
  createdAt: string;
  updatedAt: string;
}

export type TranscriptType =
  | "user_message"
  | "speaker_message"
  | "agent_message"
  | "steer"
  | "plan"
  | "work_order"
  | "proposal"
  | "vote"
  | "tool_call"
  | "tool_result"
  | "thinking_summary"
  | "usage"
  | "status"
  | "error";

export interface TranscriptEvent {
  id: number;
  sessionId: string;
  seq: number;
  role: Role | "system" | "user";
  type: TranscriptType;
  content: string;
  data?: Record<string, unknown>;
  createdAt: string;
}

export interface Session {
  id: string;
  title: string;
  mode: Mode;
  sandboxMode: SandboxMode;
  status: SessionStatus;
  workspace: string;
  activeWorkOrderId: string | null;
  failure: string | null;
  lastSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentState {
  sessionId: string;
  role: Role;
  status: AgentStatus;
  summary: string;
  lastError: string | null;
  updatedAt: string;
}

export interface SessionDetail {
  session: Session;
  agents: AgentState[];
  workOrders: WorkOrder[];
  activeProposal: ActionProposal | null;
  events: TranscriptEvent[];
}

export interface CreateSessionInput {
  title?: string;
  mode?: Mode;
  sandboxMode?: SandboxMode;
  workspace: string;
}

export interface SendMessageInput {
  content: string;
}

export interface SteerInput {
  from: Role;
  to: Role;
  content: string;
  urgent: boolean;
}

export interface ProviderDraft {
  name: string;
  baseUrl: string;
  api: ProviderKind;
  apiKey?: string;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  models?: string[];
}

export interface PublicHarnessConfig extends Omit<HarnessConfig, "providers"> {
  providers: PublicProviderConfig[];
}

export interface AgentUpdate {
  providerId: string | null;
  model: string;
  reasoningEffort: ReasoningEffort;
}

export interface ApiError {
  error: string;
  detail?: string;
}

export type StreamEnvelope =
  | { type: "snapshot"; snapshot: SessionDetail }
  | { type: "event"; event: TranscriptEvent }
  | { type: "session"; session: Session }
  | { type: "agent"; agent: AgentState }
  | { type: "proposal"; proposal: ActionProposal | null }
  | { type: "heartbeat"; at: string };

export const ROLE_LABELS: Record<Role, string> = {
  oracle: "Oracle",
  executor: "Executor",
  speaker: "Speaker"
};
