import {
  startTransition,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useRef,
  useState
} from "react";
import MarkdownIt from "markdown-it";
import {
  ROLES,
  REASONING_EFFORTS,
  ROLE_LABELS,
  SANDBOX_MODES,
  type ActionProposal,
  type AgentState,
  type Mode,
  type ProviderDraft,
  type PublicHarnessConfig,
  type Role,
  type SandboxMode,
  type Session,
  type SessionDetail,
  type StreamEnvelope,
  type TranscriptEvent
} from "../shared/protocol.js";
import { api, connectSession, getToken, setToken } from "./api.js";

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });

type View = "chat" | "transcript" | "settings";

export function App() {
  const [config, setConfig] = useState<PublicHarnessConfig | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<View>("chat");
  const [error, setError] = useState<string | null>(null);
  const [token, setLocalToken] = useState(getToken());
  const [workspace, setWorkspace] = useState("");
  const [sandboxMode, setSandboxMode] = useState<SandboxMode>("enabled");
  const [capabilities, setCapabilities] = useState<{
    sandboxModes: SandboxMode[];
    sandboxAvailable: boolean;
  } | null>(null);
  const [creating, setCreating] = useState(false);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const refresh = async () => {
    try {
      const [nextConfig, nextSessions, nextCapabilities] = await Promise.all([
        api.config(),
        api.sessions(),
        api.capabilities()
      ]);
      setConfig(nextConfig);
      setCapabilities({
        sandboxModes: nextCapabilities.sandboxModes,
        sandboxAvailable: nextCapabilities.sandbox.available
      });
      setSessions(nextSessions.sessions);
      setWorkspace((current) => current || nextConfig.workspace);
      const id =
        selectedIdRef.current && nextSessions.sessions.some((s) => s.id === selectedIdRef.current)
          ? selectedIdRef.current
          : nextSessions.sessions[0]?.id;
      if (id && id !== selectedIdRef.current) setSelectedId(id);
      if (id) setDetail(await api.session(id));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const refreshEvent = useEffectEvent(refresh);
  useEffect(() => {
    void refreshEvent();
  }, [token]);

  useEffect(() => {
    if (!selectedId || !detail) return;
    const after = 0;
    return connectSession(
      selectedId,
      after,
      (event) => setDetail((current) => applyEnvelope(current, event)),
      (cause) => setError(cause.message)
    );
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    const timer = setInterval(() => {
      api.sessions().then((next) => {
        startTransition(() => setSessions(next.sessions));
      }).catch(() => undefined);
    }, 8_000);
    return () => clearInterval(timer);
  }, [selectedId]);

  const chooseSession = async (id: string) => {
    try {
      setSelectedId(id);
      setDetail(await api.session(id));
      setView("chat");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const createSession = async (mode: Mode) => {
    try {
      setCreating(true);
      const effectiveSandbox =
        mode === "fun" && sandboxMode === "auto-review" ? "enabled" : sandboxMode;
      const created = await api.createSession({
        workspace,
        mode,
        sandboxMode: effectiveSandbox
      });
      const next = await api.sessions();
      setSessions(next.sessions);
      setSelectedId(created.session.id);
      setDetail(created);
      setView("chat");
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  };

  if (!config) {
    return (
      <main className="gate">
        <div className="gate-mark">B/H</div>
        <p className="eyebrow">Local three-agent coding room</p>
        <h1>Brawl Harness</h1>
        <p className="lede">
          Oracle decides. Executor builds. Speaker keeps the conversation readable.
        </p>
        <form
          className="token-form"
          onSubmit={(event) => {
            event.preventDefault();
            setToken(token);
            window.location.reload();
          }}
        >
          <label htmlFor="token">Backend access token</label>
          <input
            id="token"
            type="password"
            value={token}
            onChange={(event) => setLocalToken(event.target.value)}
            placeholder="Paste BRAWL_API_TOKEN"
            autoComplete="current-password"
          />
          <button type="submit">Enter room</button>
        </form>
        {error && <p className="error-banner">{error}</p>}
      </main>
    );
  }

  return (
    <div className="shell">
      <aside className={`rail ${view === "settings" ? "rail-muted" : ""}`}>
        <div className="brand" onClick={() => setView("chat")} role="button" tabIndex={0}>
          <span className="brand-glyph">B/H</span>
          <span>Brawl</span>
        </div>
        <button className="new-session" onClick={() => void createSession("productive")}>
          <span>+</span> Productive job
        </button>
        <div className="session-list">
          {sessions.map((session) => (
            <button
              key={session.id}
              className={`session-item ${selectedId === session.id ? "active" : ""}`}
              onClick={() => void chooseSession(session.id)}
            >
              <span className={`status-dot ${session.status}`} />
              <span className="session-copy">
                <strong>{session.title}</strong>
                <small>
                  {session.mode} · {relativeTime(session.updatedAt)}
                </small>
              </span>
            </button>
          ))}
        </div>
        <div className="rail-footer">
          <button onClick={() => setView("settings")}>Providers & agents</button>
          <span className="local-pill">LOCAL</span>
        </div>
      </aside>

      <main className="main">
        {view === "settings" ? (
          <Settings
            config={config}
            onRefresh={async () => {
              setConfig(await api.config());
            }}
            onError={setError}
          />
        ) : detail ? (
          <Workspace
            detail={detail}
            view={view}
            setView={setView}
            onError={setError}
            onSessionsChanged={refresh}
          />
        ) : (
          <EmptyRoom
            workspace={workspace}
            setWorkspace={setWorkspace}
            sandboxMode={sandboxMode}
            setSandboxMode={setSandboxMode}
            sandboxModes={capabilities?.sandboxModes ?? [...SANDBOX_MODES]}
            sandboxAvailable={capabilities?.sandboxAvailable ?? true}
            create={createSession}
            creating={creating}
            onCreateMode={createSession}
          />
        )}
      </main>
      {error && (
        <button className="toast" onClick={() => setError(null)}>
          {error} <span>Dismiss</span>
        </button>
      )}
    </div>
  );
}

function EmptyRoom({
  workspace,
  setWorkspace,
  sandboxMode,
  setSandboxMode,
  sandboxModes,
  sandboxAvailable,
  creating,
  onCreateMode
}: {
  workspace: string;
  setWorkspace: (value: string) => void;
  sandboxMode: SandboxMode;
  setSandboxMode: (value: SandboxMode) => void;
  sandboxModes: SandboxMode[];
  sandboxAvailable: boolean;
  create: (mode: Mode) => void;
  creating: boolean;
  onCreateMode: (mode: Mode) => void;
}) {
  return (
    <section className="empty-room">
      <p className="eyebrow">No live session</p>
      <h1>Put three minds in one room.</h1>
      <p>
        Productive mode assigns work and checks the evidence. Fun mode makes every step a
        fight until all three agree.
      </p>
      <div className="launch-card">
        <label htmlFor="workspace">Workspace path</label>
        <input id="workspace" value={workspace} onChange={(event) => setWorkspace(event.target.value)} />
        <label htmlFor="sandbox">Shell isolation</label>
        <select
          id="sandbox"
          value={sandboxMode}
          onChange={(event) => setSandboxMode(event.target.value as SandboxMode)}
        >
          {sandboxModes.map((value) => (
            <option key={value} value={value}>
              {sandboxModeLabel(value)}
            </option>
          ))}
        </select>
        {!sandboxAvailable && (
          <small className="sandbox-unavailable">
            Bubblewrap cannot start on this host. Enabled sessions will fail closed.
          </small>
        )}
        <div className="launch-actions">
          <button disabled={creating} className="primary" onClick={() => onCreateMode("productive")}>
            Start productive
          </button>
          <button disabled={creating} className="secondary" onClick={() => onCreateMode("fun")}>
            Start a quarrel
          </button>
        </div>
      </div>
    </section>
  );
}

function Workspace({
  detail,
  view,
  setView,
  onError,
  onSessionsChanged
}: {
  detail: SessionDetail;
  view: View;
  setView: (view: View) => void;
  onError: (error: string) => void;
  onSessionsChanged: () => Promise<void>;
}) {
  const session = detail.session;
  const agentMap = new Map(detail.agents.map((agent) => [agent.role, agent]));

  const control = async (action: "pause" | "resume") => {
    try {
      if (action === "pause") await api.pause(session.id);
      else await api.resume(session.id);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const switchMode = async (mode: Mode) => {
    try {
      await api.updateSession(session.id, { mode });
      await onSessionsChanged();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const switchSandbox = async (sandbox: SandboxMode) => {
    try {
      await api.updateSession(session.id, { sandboxMode: sandbox });
      await onSessionsChanged();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="workspace">
      <header className="workspace-header">
        <div>
          <p className="eyebrow">Session / {session.mode}</p>
          <h1>{session.title}</h1>
          <small className="sandbox-readout">{sandboxModeLabel(session.sandboxMode)}</small>
        </div>
        <div className="workspace-actions">
          <div className="mode-control">
            <button className={session.mode === "productive" ? "active" : ""} onClick={() => void switchMode("productive")}>
              Productive
            </button>
            <button className={session.mode === "fun" ? "active" : ""} onClick={() => void switchMode("fun")}>
              Fun
            </button>
          </div>
          <select
            className="sandbox-control"
            aria-label="Sandbox mode"
            value={session.sandboxMode}
            disabled={["queued", "running", "awaiting_consensus"].includes(session.status)}
            onChange={(event) => void switchSandbox(event.target.value as SandboxMode)}
          >
            <option value="enabled">Sandbox enabled</option>
            <option value="disabled">Sandbox disabled</option>
            {session.mode === "productive" && <option value="auto-review">Auto review</option>}
          </select>
          <button className="icon-action" onClick={() => void control("pause")}>
            Pause
          </button>
          {["paused", "interrupted", "awaiting_user"].includes(session.status) && (
            <button className="icon-action" onClick={() => void control("resume")}>
              Resume
            </button>
          )}
        </div>
      </header>

      <div className="agent-strip">
        {ROLES.map((role) => {
          const agent = agentMap.get(role);
          return agent ? (
            <AgentCard key={role} role={role} agent={agent} />
          ) : (
            <AgentCard key={role} role={role} />
          );
        })}
      </div>

      <nav className="workspace-tabs">
        <button className={view === "chat" ? "active" : ""} onClick={() => setView("chat")}>
          Conversation
        </button>
        <button className={view === "transcript" ? "active" : ""} onClick={() => setView("transcript")}>
          Full transcript <span>{detail.events.length}</span>
        </button>
      </nav>

      {view === "chat" ? (
        <Conversation detail={detail} onError={onError} />
      ) : (
        <Transcript detail={detail} />
      )}
    </div>
  );
}

function AgentCard({ role, agent }: { role: Role; agent?: AgentState }) {
  return (
    <article className={`agent-card role-${role}`}>
      <div className="agent-top">
        <span className="agent-monogram">{role.slice(0, 1).toUpperCase()}</span>
        <div>
          <strong>{ROLE_LABELS[role]}</strong>
          <small>{role === "oracle" ? "Decision" : role === "executor" ? "Work" : "User voice"}</small>
        </div>
        <span className={`agent-state ${agent?.status ?? "idle"}`}>{agent?.status ?? "idle"}</span>
      </div>
      <p>{agent?.summary || statusSummary(role, agent?.status)}</p>
    </article>
  );
}

function Conversation({
  detail,
  onError
}: {
  detail: SessionDetail;
  onError: (error: string) => void;
}) {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const visible = detail.events.filter((event) =>
    ["user_message", "agent_message", "plan", "work_order", "status", "error"].includes(event.type)
  );
  const guidance =
    detail.session.status === "awaiting_consensus" || detail.session.status === "awaiting_user";

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [visible.length]);

  const send = async () => {
    if (!message.trim() || sending) return;
    try {
      setSending(true);
      if (guidance) await api.guidance(detail.session.id, message);
      else await api.send(detail.session.id, message);
      setMessage("");
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="conversation">
      {detail.activeProposal && (
        <ProposalCard proposal={detail.activeProposal} />
      )}
      <div className="message-scroll" ref={scroller}>
        {visible.length === 0 && (
          <div className="conversation-empty">
            <span>Three agents are listening.</span>
            <p>Describe the job. Speaker will resolve ambiguity and keep you in the loop.</p>
          </div>
        )}
        {visible.map((event) => (
          <Message key={event.id} event={event} />
        ))}
        {detail.session.failure && <div className="failure-note">{detail.session.failure}</div>}
      </div>
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder={guidance ? "Answer Speaker or break the deadlock…" : "Tell Speaker what the team should work on…"}
          rows={3}
        />
        <div className="composer-footer">
          <span>Only Speaker receives your message</span>
          <button type="submit" disabled={sending || !message.trim()}>
            {sending ? "Sending" : guidance ? "Answer" : "Send"}
          </button>
        </div>
      </form>
    </section>
  );
}

function Message({ event }: { event: TranscriptEvent }) {
  const label =
    event.role === "user"
      ? "You"
      : event.role === "system"
        ? "Harness"
        : ROLE_LABELS[event.role];
  const isSpeaker = event.role === "speaker";
  const isUser = event.role === "user";
  return (
    <article className={`message ${isSpeaker ? "from-speaker" : ""} ${isUser ? "from-user" : ""}`}>
      <div className="message-meta">
        <span>{label}</span>
        <time>{formatTime(event.createdAt)}</time>
      </div>
      {event.type === "work_order" && <span className="event-tag">Work order</span>}
      {event.type === "plan" && <span className="event-tag">Plan</span>}
      <div
        className="message-body"
        dangerouslySetInnerHTML={{ __html: markdown.render(event.content) }}
      />
    </article>
  );
}

function ProposalCard({ proposal }: { proposal: ActionProposal }) {
  return (
    <aside className="proposal-card">
      <div>
        <span className="eyebrow">Fun mode gate · round {proposal.round}</span>
        <strong>{proposal.action.replaceAll("_", " ")}</strong>
      </div>
      <div className="vote-row">
        {ROLES.map((role) => (
          <span key={role} className={`vote ${proposal.votes[role] ?? "pending"}`}>
            {ROLE_LABELS[role]} · {proposal.votes[role] ?? "waiting"}
          </span>
        ))}
      </div>
      <pre>{JSON.stringify(proposal.args, null, 2).slice(0, 4_000)}</pre>
    </aside>
  );
}

function Transcript({ detail }: { detail: SessionDetail }) {
  const [role, setRole] = useState<Role | "all">("all");
  const [type, setType] = useState("all");
  const deferredRole = useDeferredValue(role);
  const deferredType = useDeferredValue(type);
  const types = [...new Set(detail.events.map((event) => event.type))];
  const events = detail.events.filter(
    (event) =>
      (deferredRole === "all" || event.role === deferredRole) &&
      (deferredType === "all" || event.type === deferredType)
  );
  const exported = events
    .map(
      (event) =>
        `## ${new Date(event.createdAt).toLocaleString()} · ${event.role} · ${event.type}\n\n${event.content}`
    )
    .join("\n\n");
  return (
    <section className="transcript">
      <div className="transcript-tools">
        <div className="filter-group">
          <button className={role === "all" ? "active" : ""} onClick={() => setRole("all")}>All roles</button>
          {ROLES.map((item) => (
            <button key={item} className={role === item ? "active" : ""} onClick={() => setRole(item)}>
              {ROLE_LABELS[item]}
            </button>
          ))}
        </div>
        <select value={type} onChange={(event) => setType(event.target.value)} aria-label="Event type">
          <option value="all">All events</option>
          {types.map((item) => <option key={item} value={item}>{item.replaceAll("_", " ")}</option>)}
        </select>
        <button
          className="export-button"
          onClick={() => {
            const blob = new Blob([exported], { type: "text/markdown" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `${detail.session.title.replace(/\W+/g, "-")}-transcript.md`;
            link.click();
            URL.revokeObjectURL(url);
          }}
        >
          Export
        </button>
      </div>
      <div className="transcript-list">
        {events.map((event) => (
          <div key={event.id} className={`transcript-row role-${event.role}`}>
            <div className="transcript-index">{String(event.seq).padStart(3, "0")}</div>
            <div className="transcript-content">
              <div className="transcript-meta">
                <strong>{event.role}</strong>
                <span className={`type-chip ${event.type}`}>{event.type.replaceAll("_", " ")}</span>
                <time>{formatTime(event.createdAt)}</time>
              </div>
              <pre>{event.content}</pre>
              {event.data && <details><summary>Structured data</summary><pre>{JSON.stringify(event.data, null, 2)}</pre></details>}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Settings({
  config,
  onRefresh,
  onError
}: {
  config: PublicHarnessConfig;
  onRefresh: () => Promise<void>;
  onError: (error: string) => void;
}) {
  const [draft, setDraft] = useState<ProviderDraft>({
    name: "",
    baseUrl: "https://api.openai.com/v1",
    api: "chat",
    headers: {},
    models: []
  });
  const [limitDraft, setLimitDraft] = useState({
    debateRounds: config.debateRounds,
    shellTimeoutMs: config.shellTimeoutMs,
    maxRunMs: config.maxRunMs
  });

  const run = async (work: () => Promise<unknown>) => {
    try {
      await work();
      await onRefresh();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <section className="settings">
      <header className="settings-header">
        <p className="eyebrow">Room configuration</p>
        <h1>Providers, roles, and limits</h1>
        <p>Each endpoint stays on this backend. Keys are never returned to the browser.</p>
      </header>

      <div className="settings-grid">
        <section className="panel provider-panel">
          <div className="panel-heading">
            <div><span className="panel-number">01</span><h2>Endpoints</h2></div>
            <span>{config.providers.length} configured</span>
          </div>
          {config.providers.map((provider) => (
            <article className="provider-row" key={provider.id}>
              <div>
                <strong>{provider.name}</strong>
                <span>{provider.api} · {provider.apiKeyEnv ? `$${provider.apiKeyEnv}` : provider.hasApiKey ? "key stored" : "no key"}</span>
              </div>
              <code>{provider.baseUrl}</code>
              <button
                onClick={() => void run(async () => {
                  const result = await api.discoverModels(provider.id);
                  window.alert(result.models.length ? result.models.join("\n") : "No models returned");
                })}
              >
                Discover
              </button>
              <button className="quiet-danger" onClick={() => void run(() => api.deleteProvider(provider.id))}>Remove</button>
            </article>
          ))}
          <form
            className="provider-form"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await api.createProvider(draft);
                setDraft({ ...draft, name: "", apiKey: "", apiKeyEnv: "", models: [] });
              });
            }}
          >
            <label>Display name<input required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="OpenAI" /></label>
            <label>Base URL<input required value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} /></label>
            <label>API<select value={draft.api} onChange={(event) => setDraft({ ...draft, api: event.target.value as "chat" | "responses" })}><option value="chat">Chat Completions</option><option value="responses">Responses</option></select></label>
            <label>API key<input type="password" value={draft.apiKey ?? ""} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} placeholder="Stored server-side" /></label>
            <label>Or key env var<input value={draft.apiKeyEnv ?? ""} onChange={(event) => setDraft({ ...draft, apiKeyEnv: event.target.value })} placeholder="OPENAI_API_KEY" /></label>
            <button type="submit">Add endpoint</button>
          </form>
        </section>

        <section className="panel">
          <div className="panel-heading">
            <div><span className="panel-number">02</span><h2>Agent assignments</h2></div>
          </div>
          {ROLES.map((role) => {
            const agent = config.agents[role];
            const provider = config.providers.find((item) => item.id === agent.providerId);
            return (
              <div className={`assignment role-${role}`} key={role}>
                <div className="assignment-title">
                  <span>{role.slice(0, 1).toUpperCase()}</span>
                  <div><strong>{ROLE_LABELS[role]}</strong><small>{role === "oracle" ? "Plans and reviews" : role === "executor" ? "Uses workspace tools" : "Talks to you"}</small></div>
                </div>
                <select
                  value={agent.providerId ?? ""}
                  onChange={(event) => void run(() => api.updateAgent(role, { ...agent, providerId: event.target.value || null }))}
                >
                  <option value="">Choose endpoint</option>
                  {config.providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
                <input
                  defaultValue={agent.model}
                  placeholder="Model ID"
                  list={`models-${role}`}
                  onBlur={(event) => {
                    if (event.target.value !== agent.model) void run(() => api.updateAgent(role, { ...agent, model: event.target.value }));
                  }}
                />
                <datalist id={`models-${role}`}>
                  {(provider?.models ?? []).map((model) => <option key={model} value={model} />)}
                </datalist>
                <select
                  value={agent.reasoningEffort}
                  onChange={(event) => void run(() => api.updateAgent(role, { ...agent, reasoningEffort: event.target.value as typeof agent.reasoningEffort }))}
                >
                  {REASONING_EFFORTS.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
                </select>
              </div>
            );
          })}
        </section>

        <section className="panel limits-panel">
          <div className="panel-heading">
            <div><span className="panel-number">03</span><h2>Safety limits</h2></div>
          </div>
          <label>Debate rounds<input type="number" min={1} max={30} value={limitDraft.debateRounds} onChange={(event) => setLimitDraft({ ...limitDraft, debateRounds: Number(event.target.value) })} /></label>
          <label>Shell timeout (ms)<input type="number" min={1000} value={limitDraft.shellTimeoutMs} onChange={(event) => setLimitDraft({ ...limitDraft, shellTimeoutMs: Number(event.target.value) })} /></label>
          <label>Session run limit (ms)<input type="number" min={10000} value={limitDraft.maxRunMs} onChange={(event) => setLimitDraft({ ...limitDraft, maxRunMs: Number(event.target.value) })} /></label>
          <button onClick={() => void run(() => api.updateLimits(limitDraft))}>Save limits</button>
          <p className="workspace-readout"><strong>Default workspace</strong><code>{config.workspace}</code></p>
        </section>
      </div>
    </section>
  );
}

function applyEnvelope(current: SessionDetail | null, envelope: StreamEnvelope): SessionDetail | null {
  if (!current && envelope.type === "snapshot") return envelope.snapshot;
  if (!current) return current;
  if (envelope.type === "snapshot") return envelope.snapshot;
  if (envelope.type === "session") return { ...current, session: envelope.session };
  if (envelope.type === "agent") {
    const found = current.agents.some((agent) => agent.role === envelope.agent.role);
    return {
      ...current,
      agents: found
        ? current.agents.map((agent) => agent.role === envelope.agent.role ? envelope.agent : agent)
        : [...current.agents, envelope.agent]
    };
  }
  if (envelope.type === "proposal") return { ...current, activeProposal: envelope.proposal };
  if (envelope.type === "event") {
    if (current.events.some((event) => event.id === envelope.event.id)) return current;
    return {
      ...current,
      session: { ...current.session, lastSeq: Math.max(current.session.lastSeq, envelope.event.seq) },
      events: [...current.events, envelope.event]
    };
  }
  return current;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function relativeTime(value: string): string {
  const delta = Date.now() - new Date(value).getTime();
  if (delta < 60_000) return "now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  return `${Math.floor(delta / 86_400_000)}d`;
}

function statusSummary(role: Role, status?: string): string {
  if (status === "thinking") return "Weighing the next move.";
  if (status === "running_tool") return "Working in the workspace.";
  if (status === "waiting") return "Waiting for a teammate.";
  if (role === "oracle") return "Ready to decide.";
  if (role === "executor") return "Ready for the work order.";
  return "Ready to talk.";
}

function sandboxModeLabel(mode: SandboxMode): string {
  if (mode === "auto-review") return "Auto review: Oracle checks each shell command";
  if (mode === "enabled") return "Sandbox enabled: Bubblewrap isolates shell commands";
  return "Sandbox disabled: shell commands run without process isolation";
}
