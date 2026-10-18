# AGENTS.md

## Project shape

- `src/server/` contains the Fastify API, SQLite store, provider adapters, scheduler, and workspace tools.
- `src/shared/` contains protocol types, SSE parsing, and role/mode prompts shared by all clients.
- `src/web/` is the Vite/React frontend.
- `src/tui/` and `src/cli.ts` are the terminal frontend and detached-server/client commands.

## Role invariants

- Oracle is the decision authority. It submits plans, creates work orders, and reviews Executor evidence.
- Executor is the only role with workspace tools. Productive tools require an active Oracle work order.
- Speaker is the only role that receives user messages and produces user-facing summaries. It uses `ask_user` for material ambiguity.
- Any role may use `send_steer`; steering is queued and delivered at the recipient's next model boundary.
- Never expose provider credentials or raw chain-of-thought. Transcript events may contain provider-safe summaries, usage, tool calls/results, and visible messages only.
- The sandbox mode is fixed for the duration of a running session. `enabled` and productive-mode `auto-review` must fail closed when Bubblewrap cannot execute.

## Mode behavior

- Productive mode follows Oracle -> Executor -> Oracle review -> Speaker summary.
- Fun mode uses competitive/quarrelsome prompts. Executor proposals are immutable and require explicit rationale-backed votes from all three roles. After a complete non-unanimous vote, Executor gets one evidence-based rebuttal turn and each denier may retain or revise their vote. No workspace action executes without unanimous approval.
- Incomplete voting pauses at `awaiting_user`; exhausted debate asks Speaker to explain the deadlock. Do not silently turn a missing vote into a rejection.

## Sandbox behavior

- `enabled` runs only `shell_exec` through Bubblewrap with private user, mount, PID, IPC, UTS, cgroup, and network namespaces.
- Expose only a read-only minimal runtime (`/usr`, `/lib`, `/lib64`), a writable workspace at `/workspace`, and private `/tmp`, `/proc`, and `/dev`. Never expose host `/home`, `/root`, `/etc`, `/var`, credentials, or the Docker socket.
- `disabled` bypasses process isolation only. Workspace file tools must remain inside the configured workspace.
- `auto-review` is available only in productive mode and applies only to `shell_exec`. It calls Oracle with visible session/work-order context and no actor history or tools.
- Successful auto-reviews leave no transcript or history event. Refusals, malformed responses, provider failures, missing reasons, and timeouts deny safely and record only a failed Executor `tool_result` with `sandboxReview: "refused"`.
- Do not use a binary-presence check as the readiness signal. Run the host probe at `scripts/probe-bwrap.sh` and fail closed if the real Bubblewrap process cannot start.

## Persistence and lifecycle

- SQLite is the source of truth for sessions, agent state, transcript events, work orders, proposals, and pending steering.
- Backend runs must continue when clients disconnect. Pause/stop aborts active model calls; restart recovery marks in-flight sessions interrupted and pending proposals stale.
- Keep credentials, SQLite files, logs, coverage, and build output out of Git. See `.gitignore`.

## Safe changes

- Keep all workspace paths inside the configured workspace and preserve approval/stale-write checks in `src/server/tools.ts`.
- Keep API secrets server-side; public config must use `redactProvider`.
- When changing provider request formats, test both Chat Completions and Responses streaming paths.
- Add scheduler tests for every new state transition, especially fun-mode vote and resume behavior.
- Use `apply_patch` for manual edits and preserve unrelated user changes.

## Verification

Run `npm run typecheck`, `npm test`, `npm run lint`, and `npm run build` before committing. Use conventional commits: `type(scope): description`.
