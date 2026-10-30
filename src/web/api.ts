import type {
  AgentUpdate,
  CreateSessionInput,
  HarnessConfig,
  ProviderDraft,
  PublicHarnessConfig,
  PublicProviderConfig,
  Role,
  SandboxMode,
  Session,
  SessionDetail,
  StreamEnvelope
} from "../shared/protocol.js";
import { createSseParser } from "../shared/stream.js";

const tokenKey = "brawl-api-token";

export function getToken(): string {
  return localStorage.getItem(tokenKey) ?? "";
}

export function setToken(token: string): void {
  localStorage.setItem(tokenKey, token);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      authorization: `Bearer ${getToken()}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers
    }
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({ error: response.statusText }))) as {
      error?: string;
      detail?: string;
    };
    throw new Error(body.detail || body.error || `Request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

export const api = {
  config: () => request<PublicHarnessConfig>("/api/config"),
  capabilities: () =>
    request<{
      efforts: string[];
      providers: string[];
      sandboxModes: SandboxMode[];
      sandbox: {
        available: boolean;
        version: string | null;
        error: string | null;
      };
      workspace: string;
    }>("/api/capabilities"),
  workspaceDirectories: (path: string) =>
    request<{ path: string; directories: string[] }>(
      `/api/workspace/directories?path=${encodeURIComponent(path)}`
    ),
  sessions: () => request<{ sessions: Session[] }>("/api/sessions"),
  session: (id: string) => request<SessionDetail>(`/api/sessions/${id}`),
  createSession: (input: CreateSessionInput) =>
    request<SessionDetail>("/api/sessions", { method: "POST", body: JSON.stringify(input) }),
  send: (id: string, content: string) =>
    request<{ ok: true }>(`/api/sessions/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content })
    }),
  guidance: (id: string, content: string) =>
    request<{ ok: true }>(`/api/sessions/${id}/guidance`, {
      method: "POST",
      body: JSON.stringify({ content })
    }),
  pause: (id: string) =>
    request<{ ok: true }>(`/api/sessions/${id}/pause`, { method: "POST", body: "{}" }),
  resume: (id: string) =>
    request<{ ok: true }>(`/api/sessions/${id}/resume`, { method: "POST", body: "{}" }),
  deleteSession: (id: string) =>
    request<{ ok: true }>(`/api/sessions/${id}`, { method: "DELETE" }),
  updateSession: (
    id: string,
    input: Partial<Pick<Session, "mode" | "sandboxMode" | "title">>
  ) =>
    request<Session>(`/api/sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    }),
  createProvider: (input: ProviderDraft) =>
    request<PublicProviderConfig>("/api/providers", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  updateProvider: (id: string, input: Partial<ProviderDraft>) =>
    request<PublicProviderConfig>(`/api/providers/${id}`, {
      method: "PUT",
      body: JSON.stringify(input)
    }),
  deleteProvider: (id: string) =>
    request<{ ok: true }>(`/api/providers/${id}`, { method: "DELETE" }),
  discoverModels: (id: string) =>
    request<{ models: string[] }>(`/api/providers/${id}/models`, {
      method: "POST",
      body: "{}"
    }),
  updateAgent: (role: Role, input: AgentUpdate) =>
    request<PublicHarnessConfig>(`/api/agents/${role}`, {
      method: "PUT",
      body: JSON.stringify(input)
    }),
  updateLimits: (input: Partial<Pick<HarnessConfig, "debateRounds" | "shellTimeoutMs" | "maxRunMs">>) =>
    request<PublicHarnessConfig>("/api/config/limits", {
      method: "PUT",
      body: JSON.stringify(input)
    })
};

export function connectSession(
  id: string,
  after: number,
  onEvent: (event: StreamEnvelope) => void,
  onError: (error: Error) => void
): () => void {
  const controller = new AbortController();
  void (async () => {
    try {
      const response = await fetch(`/api/sessions/${id}/stream?after=${after}`, {
        headers: { authorization: `Bearer ${getToken()}` },
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
      if (!controller.signal.aborted) onError(error instanceof Error ? error : new Error(String(error)));
    }
  })();
  return () => controller.abort();
}
