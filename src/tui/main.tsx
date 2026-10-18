import { Box, Text, render, useApp, useInput } from "ink";
import { useEffect, useState } from "react";
import {
  ROLES,
  ROLE_LABELS,
  type Role,
  type SessionDetail,
  type TranscriptEvent
} from "../shared/protocol.js";
import { applyEnvelope, HarnessClient } from "../client/api.js";

interface Props {
  client: HarnessClient;
  initialSessionId?: string;
}

type Screen = "chat" | "transcript" | "help";

function App({ client, initialSessionId }: Props) {
  const { exit } = useApp();
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [screen, setScreen] = useState<Screen>("chat");
  const [input, setInput] = useState("");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [roleFilter, setRoleFilter] = useState<Role | "all">("all");

  useEffect(() => {
    void (async () => {
      try {
        if (initialSessionId) {
          setDetail(await client.session(initialSessionId));
          return;
        }
        const sessions = await client.sessions();
        if (sessions[0]) setDetail(await client.session(sessions[0].id));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
  }, [client, initialSessionId]);

  useEffect(() => {
    if (!detail) return;
    return client.stream(
      detail.session.id,
      detail.events.at(-1)?.seq ?? 0,
      (event) => setDetail((current) => applyEnvelope(current, event)),
      (cause) => setError(cause.message)
    );
  }, [client, detail?.session.id]);

  const ask = async () => {
    if (!detail || !input.trim()) return;
    try {
      if (["awaiting_consensus", "awaiting_user"].includes(detail.session.status)) {
        await client.guidance(detail.session.id, input);
      } else {
        await client.send(detail.session.id, input);
      }
      setInput("");
      setEditing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  useInput((char, key) => {
    if (editing) {
      if (key.escape) {
        setEditing(false);
        setInput("");
      } else if (key.return) {
        void ask();
      } else if (key.backspace || key.delete) {
        setInput((current) => current.slice(0, -1));
      } else if (char && !key.ctrl && !key.meta) {
        setInput((current) => current + char);
      }
      return;
    }
    if (char === "q") exit();
    if (char === "i") setEditing(true);
    if (char === "c") setScreen("chat");
    if (char === "t") setScreen("transcript");
    if (char === "?") setScreen("help");
    if (char === "f") {
      const index = roleFilter === "all" ? 0 : ROLES.indexOf(roleFilter);
      setRoleFilter(index >= ROLES.length - 1 ? "all" : ROLES[index + 1] ?? "all");
    }
    if (char === "p" && detail) {
      void client.pause(detail.session.id).catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause))
      );
    }
    if (char === "r" && detail) {
      void client.resume(detail.session.id).catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause))
      );
    }
  });

  if (!detail) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>BRAWL HARNESS</Text>
        <Text>{error ? `Unable to attach: ${error}` : "Attaching to the local backend..."}</Text>
      </Box>
    );
  }

  if (screen === "help") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Keys</Text>
        <Text>i  compose a message to Speaker</Text>
        <Text>t  transcript   c  conversation</Text>
        <Text>f  cycle role transcript filter</Text>
        <Text>p  pause        r  resume</Text>
        <Text>q  detach (the backend keeps working)</Text>
        <Text>Esc returns or closes the composer.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>
          BRAWL / {detail.session.mode.toUpperCase()} / SANDBOX {detail.session.sandboxMode.toUpperCase()}
        </Text>
        <Text color={statusColor(detail.session.status)}>{detail.session.status}</Text>
      </Box>
      <Text dimColor>{detail.session.title}</Text>
      <Box marginY={1} gap={1}>
        {ROLES.map((role) => {
          const agent = detail.agents.find((item) => item.role === role);
          return (
            <Box key={role} borderStyle="single" paddingX={1} flexDirection="column" width="33%">
              <Text color={roleColor(role)} bold>{ROLE_LABELS[role]}</Text>
              <Text dimColor>{agent?.status ?? "idle"}</Text>
              <Text wrap="truncate">{agent?.summary || roleTagline(role)}</Text>
            </Box>
          );
        })}
      </Box>

      {screen === "chat" ? (
        <Chat detail={detail} />
      ) : (
        <Transcript detail={detail} filter={roleFilter} />
      )}

      {error && <Text color="red">{error}</Text>}
      {detail.activeProposal && (
        <Box borderStyle="round" borderColor={roleColor("oracle")} marginY={1} paddingX={1}>
          <Text>
            Pending fun-mode gate: {detail.activeProposal.action} ·{" "}
            {ROLES.map((role) => `${role}:${detail.activeProposal?.votes[role] ?? "-"}`).join(" ")}
          </Text>
        </Box>
      )}
      {editing ? (
        <Box borderStyle="bold" borderColor="green" paddingX={1}>
          <Text color="green">Speak › </Text>
          <Text>{input || " "}</Text>
        </Box>
      ) : (
        <Text dimColor>i compose · t transcript · p pause · r resume · ? help · q detach</Text>
      )}
    </Box>
  );
}

function Chat({ detail }: { detail: SessionDetail }) {
  const events = detail.events
    .filter((event) => ["user_message", "agent_message", "plan", "work_order"].includes(event.type))
    .slice(-14);
  return (
    <Box flexDirection="column" minHeight={12}>
      {events.map((event, index) => (
        <Box key={event.id} marginBottom={1} flexDirection="column">
          <Text color={event.role === "user" ? "white" : roleColor(event.role)} bold>
            {event.role === "user" ? "You" : event.role === "system" ? "Harness" : ROLE_LABELS[event.role]}
          </Text>
          <Text wrap="wrap">{plainPreview(event, index === events.length - 1 ? 2_500 : 500)}</Text>
        </Box>
      ))}
      {events.length === 0 && <Text dimColor>Tell Speaker what to build.</Text>}
    </Box>
  );
}

function Transcript({
  detail,
  filter
}: {
  detail: SessionDetail;
  filter: Role | "all";
}) {
  const events = detail.events.filter((event) => filter === "all" || event.role === filter).slice(-20);
  return (
    <Box flexDirection="column">
      <Text bold>TRANSCRIPT · {filter}</Text>
      {events.map((event) => (
        <Box key={event.id} flexDirection="column" marginBottom={1}>
          <Text color={event.role === "system" || event.role === "user" ? "white" : roleColor(event.role)}>
            {String(event.seq).padStart(3, "0")} {event.role} [{event.type}]
          </Text>
          <Text wrap="wrap">{plainPreview(event, 800)}</Text>
        </Box>
      ))}
    </Box>
  );
}

function plainPreview(event: TranscriptEvent, max: number): string {
  const source = event.content
    .replace(/```[\s\S]*?```/g, "[code block]")
    .replace(/[#*_>`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return source.length > max ? `${source.slice(0, max)}...` : source;
}

function roleColor(role: Role | "system" | "user"): string {
  if (role === "oracle") return "#d47750";
  if (role === "executor") return "#55b7a2";
  if (role === "speaker") return "#7198dd";
  return "white";
}

function statusColor(status: SessionDetail["session"]["status"]): string {
  if (["running", "queued"].includes(status)) return "green";
  if (["awaiting_consensus", "awaiting_user"].includes(status)) return "yellow";
  if (status === "failed") return "red";
  return "gray";
}

function roleTagline(role: Role): string {
  return role === "oracle" ? "Decision" : role === "executor" ? "Work" : "User voice";
}

export function runTui(input: Props): void {
  render(<App {...input} />);
}
