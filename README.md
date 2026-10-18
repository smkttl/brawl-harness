# Brawl Harness

Brawl Harness is a local three-agent coding room. **Oracle** decides and reviews, **Executor** performs workspace work, and **Speaker** is the only agent that talks to the user. The backend owns the run, so a browser, TUI, or CLI can detach without stopping an in-flight session.

## Quick start

Requirements: Node.js 24 or newer and an OpenAI-compatible provider.

```bash
npm install
cp .env.example .env
export BRAWL_API_TOKEN="choose-a-local-token"
npm run dev
```

Open `http://127.0.0.1:8787`. Enter the same token in the web gate, open **Providers & agents**, add an endpoint, discover its models, and assign a provider/model/reasoning effort to each role. The backend writes its config and SQLite database under `BRAWL_DATA_DIR` (default `~/.brawl`).

For a production build:

```bash
npm run build
node dist/server/index.js
```

The API requires `BRAWL_API_TOKEN` unless `BRAWL_AUTH_DISABLED=true` is explicitly set. Keep the unauthenticated option limited to a trusted local machine.

## Interfaces

The web UI provides session creation, mode switching, live conversation, full transcript filters, Markdown export, provider/model assignment, reasoning-effort selection, and pause/resume controls.

The terminal client keeps the backend separate from the UI:

```bash
npm run brawl -- server start --detach --workspace /path/to/repo
npm run brawl -- chat --mode productive "Add tests for the parser"
npm run brawl -- sessions
npm run brawl -- tui --session <session-id>
npm run brawl -- server status
npm run brawl -- server stop
```

The detached server continues work after the TUI or browser exits. Session state, events, work orders, proposals, and pending steering messages are durable in SQLite. A backend restart marks interrupted work and stale pending proposals instead of silently executing them.

## Modes

### Productive

Speaker resolves material ambiguity and relays user context. Oracle records a plan and creates a scoped work order with constraints and acceptance criteria. Executor can use the workspace tools only within that work order. Oracle reviews submitted evidence before Speaker reports completion.

### Fun

Prompts make each role competitive and explicitly warn Executor and Speaker that the other agents may be messing around. Executor proposes immutable workspace actions. Every action requires an explicit rationale-backed approval from Oracle, Executor, and Speaker. Missing votes pause the session for guidance; unanimous approval is the only path to execution, and the debate limit rejects unresolved actions.

## Transcript

Conversation view shows user-facing messages and progress. Transcript view includes role messages, plans, work orders, steering, proposals, votes, tool calls/results, statuses, usage, and provider-supplied reasoning summaries when available. Raw model chain-of-thought is never stored or displayed. Transcript data is an operational audit trail, not a promise that private provider internals are available.

## Provider configuration

Providers support OpenAI-compatible Chat Completions (`chat`) and Responses (`responses`) endpoints. Each provider may use a stored key or an environment variable such as `OPENAI_API_KEY`; secrets are written with restrictive permissions and are redacted from API responses. Each role independently selects its provider, model ID, and reasoning effort. Custom headers are kept server-side.

The configured workspace is trusted local execution under the current OS user. File tools reject paths outside it, inspect writes before approval, guard against stale-file overwrites, and apply shell timeouts. Do not point the harness at a workspace containing secrets unless the configured providers and local account are trusted.

## Development

```bash
npm run typecheck
npm test
npm run lint
npm run build
```

The repository uses conventional commits such as `feat(scheduler): gate fun actions on unanimous votes`.
