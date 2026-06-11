# BabeL-O — Agent Guide

Nexus-first generalized AI agent runtime. CLI (`bbl`) talks to a headless Fastify
daemon (`Nexus`) over REST + WebSocket. Runtimes are pluggable (`LocalCodingRuntime`
for deterministic, `LLMCodingRuntime` for any LLM adapter). Go TUI client is the
production interface; TypeScript TUI is the developer playground.

> **Design rule:** *Nexus owns execution. CLI owns interaction.*
> Never leak runtime concerns into the CLI module — the dependency-boundary audit
> (`npm run deps:audit`) will fail the build.

---

## 1. Essential Commands

| Task | Command |
| --- | --- |
| Install deps (locked) | `npm ci` |
| Run source CLI in dev | `npm run cli -- chat dev` |
| Start embedded Nexus daemon | `npm run start` |
| Build TS → `dist/` | `npm run build` |
| Build standalone SEA binary | `npm run build:binary` |
| Build + smoke test | `npm run build:smoke` |
| Run full test suite | `npm test` |
| Typecheck only | `npm run typecheck` |
| Format check (no auto-fix) | `npm run format:check` |
| Lint = typecheck + format + deps audit | `npm run lint` |
| Coverage report | `npm run coverage` |
| Performance benchmark | `npm run benchmark` |
| Provider smoke (offline dry run) | `npm run test:providers:smoke` |
| MCP official smoke | `npm run test:mcp:official` |
| Go runner tests | `cd runners/go-runner && go test ./...` |
| Go TUI tests | `cd clients/go-tui && go test ./...` |
| Go TUI build (dev) | `cd clients/go-tui && make dev` |
| Go TUI build (release) | `cd clients/go-tui && make build` |
| Install latest release binary | `curl -fsSL https://raw.githubusercontent.com/SuTang-vain/BabeL-O/main/scripts/install.sh \| bash` |
| Install specific version | `... \| BBL_VERSION=vX.Y.Z bash` |

**Runtime requirements:** Node.js >= 22 (ESM + native `node:sqlite`), Go 1.23
for the TUI/runner. Docker is optional for sandboxed shell execution.

**Test isolation:** the canonical `npm test` script forces
`BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json` and `NODE_ENV=test`. Do not
rely on the user's real `~/.babel-o/config.json` from any test.

---

## 2. Architecture

```
┌──────────────────┐   HTTP / WS    ┌────────────────────────┐
│ CLI  src/cli/    │ ─────────────► │ Nexus  src/nexus/      │
│  - program.ts    │                │  - server.ts (Fastify) │
│  - renderEvents  │                │  - app.ts (routes)     │
│  - NexusClient   │                │  - createRuntime.ts    │
│  - embedded.ts   │                │  - agentLoop.ts        │
│  - commands/*    │                │  - agents/* (spawn)    │
└──────────────────┘                │  - storageBridge.ts    │
                                    └───────────┬────────────┘
                                                │ uses
            ┌───────────────────────────────────┴────────────────────────┐
            ▼                                                                ▼
   ┌────────────────┐   ┌────────────────────┐   ┌────────────────────┐ ┌──────────────┐
   │ Runtime Layer  │   │ Core Services      │   │ LLM Adapters       │ │ Storage      │
   │  src/runtime/  │   │  - tools/builtin   │   │  src/providers/    │ │ SqliteStorage│
   │  - LLMCoding   │   │  - mcp/* (stdio)   │   │  Anthropic/OpenAI/ │ │ MemoryStorage│
   │  - LocalCoding │   │  - skills/ (md)    │   │  Local adapters    │ └──────────────┘
   │  - contextMgr  │   │  - hooks.ts        │   │  registry.ts       │
   │  - compactors  │   └────────────────────┘   └────────────────────┘
   └────────────────┘
```

**Data flow** for a single user turn:

1. `src/cli/program.ts` parses `bbl <cmd>` (Commander). Each command lives in
   `src/cli/commands/*.ts` and is registered via `registerXCommand(program)`.
2. `chat` / `run` calls `runSessionFlow(prompt, cwd, url, rl, abortCtrl)`
   (`src/cli/runSessionFlow.ts`) which either hits a remote Nexus via
   `NexusClient` or spawns an in-process `EmbeddedNexusClient`
   (`src/cli/embedded.ts`).
3. `createDefaultNexusRuntime` (`src/nexus/createRuntime.ts`) wires the tool
   registry, optional MCP servers, optional EverCore sidecar, agent scheduler,
   storage (defaults to `~/.babel-o/db.sqlite`, falls back to memory under
   `NODE_ENV === 'test'`), and a `LocalCodingRuntime` or `LLMCodingRuntime`
   depending on `settings.providerId`.
4. The runtime streams `NexusEvent`s (`src/shared/events.ts` — Zod schemas
   versioned as `2026-05-21.babel-o.v1`).
5. CLI renders events via `src/cli/renderEvents.ts` (Chalk, no React/Ink).

**Tool risk model:** `read < write < execute < task`. Tools declare static
`risk`; `Bash` overrides per-input via `riskForInput` (read-only subcommands
downgrade to `read`). `permissionMode: 'strict'` hard-denies non-allowlisted
tools; `'soft-deny'` lets them reach `permission_request` so the Go TUI can
prompt the user (Phase B of `docs/nexus/reference/go-tui-permission-policy-governance-plan.md`).

---

## 3. Directory Map

```
src/
├── nexus/                  Fastify daemon, agent loop, sub-agents, scheduler
│   ├── server.ts           Entry: validates env, builds app, calls listen()
│   ├── app.ts              createNexusApp: registers REST + WS routes
│   ├── createRuntime.ts    Wires tools + storage + runtime + scheduler
│   ├── agentLoop.ts        Streaming agent loop, tool scheduling, hooks
│   ├── runtimeAgentStep.ts Per-step LLM call / tool dispatch
│   ├── agents/             Sub-agent system (AgentScheduler, AgentTools, etc.)
│   ├── storageBridge.ts    SQLite + WAL JSONL append log
│   └── everCoreConfig.ts   Optional EverCore sidecar integration
├── runtime/                LLMCodingRuntime, LocalCodingRuntime, compaction
│   ├── contextAssembler.ts  Builds the prompt payload each turn
│   ├── compact.ts + compactors/  Token-budget-driven history compaction
│   ├── remoteRunner.ts     Optional Go-based tool runner
│   ├── hooks.ts            UserPromptSubmit / PreToolUse / ... event bus
│   └── providerRecovery.ts Fallback chain across providers
├── cli/
│   ├── program.ts          Commander bootstrap (registers all commands)
│   ├── NexusClient.ts      HTTP + WS client to remote Nexus
│   ├── embedded.ts         In-process NexusClient (no network)
│   ├── renderEvents.ts     Streams NexusEvent → terminal output
│   ├── runSessionFlow.ts   Shared between `bbl run` and `bbl chat`
│   ├── commands/           chat, run, nexus, sessions, tools, config, agents,
│   │                       models, optimize, go, inspectSession, help
│   ├── inboxOverlay.ts     /inbox SessionChannel UI
│   ├── channelSend.ts      /channel send preview-then-confirm flow
│   └── collaborateOverlay.ts /collaborate unified hub
├── tools/builtin/          read, write, edit, bash (with classifier), glob,
│                           grep, listDir, task, pathDrift, pathSafety
├── providers/              adapters/ (Anthropic, OpenAI, Local, sse util),
│                           registry.ts (providerRegistry + modelRegistry)
├── mcp/                    JSON-RPC stdio MCP client + adapter → tool registry
├── skills/                 Built-in `.md` skill files (frontmatter-driven)
│   └── built-in/           coding, debugging, git, optimization, testing
├── storage/                Storage interface, MemoryStorage, SqliteStorage
│                           (uses Node 22+ native `node:sqlite`)
├── shared/                 Cross-cutting: events, config, session, sessionChannel,
│                           toolTrace, agentJob, errors, id, logger, version
└── types/                  Ambient TS declarations

clients/go-tui/             Go TUI client (Bubble Tea). Production release target.
runners/go-runner/          Optional Go tool runner (remote bash/file tools).
scripts/                    Build, install, audit, benchmark, smoke scripts.
test/                       80+ test files, all using `tsx --test`.
```

**Configuration precedence** (per the storage-path comments in
`src/nexus/createRuntime.ts`):
1. Explicit CLI arg / function arg
2. `BABEL_O_CONFIG_DIR` env
3. `BABEL_O_CONFIG_FILE` env (its parent dir is used)
4. `~/.babel-o/` (real user config)

User-facing config is read/written at `~/.babel-o/config.json`. Tests must
never read or write this — guard with `BABEL_O_CONFIG_FILE` and
`NODE_ENV === 'test'`.

---

## 4. Adding to the Codebase

### Adding a CLI command

1. Create `src/cli/commands/<name>.ts` exporting `registerXCommand(program: Command)`.
2. Import + call in `src/cli/program.ts`. Keep registration order stable so
   `bbl --help` ordering is predictable.
3. If it talks to Nexus, prefer extending `NexusClient` and `EmbeddedNexusClient`
   in lockstep (shared method names) — both classes must expose the same
   surface so `chat` / `run` can use either transparently.

### Adding a runtime event

1. Define a Zod schema in `src/shared/events.ts` (extend `baseEventFields` +
   `contextPolicyFields` where relevant).
2. Bump `NEXUS_EVENT_SCHEMA_VERSION` if the change is breaking.
3. Emit it from the runtime (`src/nexus/runtimeAgentStep.ts` or
   `agentLoop.ts`).
4. Render it in `src/cli/renderEvents.ts` (and the Go TUI renderer in
   `clients/go-tui/internal/tui/`).
5. Add a unit test in `test/<area>.test.ts` (see `test/agent-loop.test.ts` for
   the canonical pattern).

### Adding a tool

1. Implement in `src/tools/builtin/<name>.ts` exposing the `Tool<TInput, TOutput>`
   interface (`src/tools/Tool.ts`).
2. Declare `risk: 'read' | 'write' | 'execute' | 'task'`. Add `riskForInput`
   for tools whose risk varies by argument (see `bashClassifier.ts`).
3. Register in `createDefaultToolRegistry()` (`src/tools/registry.ts`).
4. Add a test file `test/<name>-tool.test.ts`.
5. Update `bbl tools list` / `bbl tools audit` only if the audit shape changes.

### Adding a provider / model

1. Edit `src/providers/registry.ts` — append to `providerRegistry` and
   `modelRegistry`. Use one of the existing adapter kinds
   (`anthropic-compatible`, `openai-compatible`, `openai-responses`, `local`).
2. Model id format is `provider/model` (e.g. `anthropic/claude-3-5-sonnet`).
3. Verify with `npm run test:providers:smoke` (dry run) before adding live tests.

### Adding a skill

Drop a `.md` file in `src/skills/built-in/` with YAML frontmatter:

```yaml
---
id: my-skill
name: My Skill
triggers: [keyword1, keyword2]
priority: 10
---
```

`priority` is numeric (higher wins). The matcher
(`src/skills/matcher.ts`) loads via the dynamic import used by the
standalone binary build — see `npm run build` (copies `src/skills/built-in`
into `dist/skills/`).

---

## 5. Conventions & Style

- **Module system:** Native ESM only (`"type": "module"`). All internal imports
  use explicit `.js` extension even for `.ts` source (NodeNext resolution).
- **TypeScript:** strict mode on, `noEmit: true` in dev. `tsconfig.build.json`
  enables emit for `npm run build` only.
- **Schemas:** Zod for everything cross-module (`src/shared/events.ts`,
  `src/shared/sessionChannel.ts`, `src/shared/task.ts`, etc.). Prefer Zod
  inference over manual interfaces for event/task types.
- **Logging:** Use `src/shared/logger.ts`, never `console.log` in
  `src/runtime/` or `src/nexus/` (CLI commands are fine to use it for
  user-facing banners).
- **Formatting:** No formatter is configured — `scripts/check-format.js` is a
  tiny linter that enforces: no CRLF, no trailing whitespace, files end in
  newline, valid JSON. Match surrounding style. Do not add Prettier.
- **Dependency ownership:** `scripts/audit-dependency-boundary.js` enforces
  that `chalk`, `commander`, `ws` are CLI-only and never imported by
  `src/runtime/`. `runtime/` may only use `fastify`, `@fastify/websocket`,
  `minimatch`, `zod`, `@vscode/ripgrep`, plus Node built-ins. If you add a dep,
  classify it in the `dependencyOwnership` table in that script.
- **Comments:** No "what" comments. Brief "why" comments are encouraged at
  non-obvious decision points. Many existing comments reference the design
  plan under `docs/nexus/reference/` — keep that trail intact.
- **Naming:** PascalCase types, camelCase functions, SCREAMING_SNAKE_CASE
  env vars. CLI flags are kebab-case. File names match the primary export.
- **Test names:** `<unit>.test.ts` colocated in `test/` (not `__tests__/`).
  Use `node:test` + `tsx --test`. Each test file is listed explicitly in the
  `test` script (no glob) to keep concurrency predictable.
- **No remote writes.** Don't push, don't open PRs, don't run `npm publish`.

---

## 6. Important Gotchas

- **`bbl chat` requires a TTY.** Hard assertion at the top of
  `src/cli/commands/chat.ts`. Use `bbl run "<prompt>"` for non-interactive use.
- **CLI bin shim** (`bin/bbl.js`) picks between `dist/cli/program.js` (prod) and
  `tsx src/cli/program.ts` (dev) by file presence. After `npm run build`, the
  shim transparently uses compiled output even when running from a source tree.
- **Storage path is sticky per process.** `embeddedClient` in `chat.ts` hard-codes
  `~/.babel-o/db.sqlite` so embedded Nexus sessions survive across `bbl chat`
  invocations. Don't pass `:memory:` to embedded mode or you lose history.
- **Standalone binary needs Node 26+ for SEA.** `scripts/build-binary.js`
  downloads a real Node 26.x into `.cache/node-sea/` if the local binary is
  stripped (common with Homebrew) or too old. The build will fail loudly if it
  can't reach `nodejs.org/dist/index.json`.
- **Permission policy has two modes:** `strict` (default — hard-deny tools not
  in the allowlist, no prompt) and `soft-deny` (emit `permission_request` so
  the Go TUI permission panel can prompt). The Go TUI sends
  `policy: 'soft-deny'` per-request even though the server default is `strict`.
  See `src/nexus/server.ts` `parsePolicyMode()` for the env-var override.
- **Workspace path safety** (`src/tools/builtin/pathSafety.ts`) is enforced
  server-side. Symlink resolution is required — never bypass it. Docker
  execution also enforces the same checks.
- **SessionChannel messages are context, never instructions.** The agent loop
  must never auto-execute actions from inbox/collaborate content. The
  preview-then-confirm flow in `src/cli/channelSend.ts` is mandatory for
  outbound channel messages.
- **Test isolation invariant:** Tests must never read or write the user's
  real `~/.babel-o/config.json` (memory `babel-o-test-config-isolation`).
  `createDefaultNexusRuntime` returns `MemoryStorage` automatically when
  `NODE_ENV === 'test'` and no explicit path is given — preserve this.
- **CLI proxy / `--url` flag.** When `bbl chat --url <url>` is set, the CLI
  connects to that Nexus instance instead of embedding. Many CLI commands
  (`sessions`, `tools audit`, `agents`) accept a remote URL this way.
- **The `__server` hidden command** (`src/cli/program.ts`) is the only way the
  `bbl nexus start` subcommand can spawn a daemon — it imports
  `src/nexus/server.ts` from a re-invocation of the same CLI binary. Don't
  refactor that to a separate file path or the daemon-spawn logic breaks.
- **Go TUI is the production client.** TS `bbl chat` is for contributors. New
  user-facing flows should land in `clients/go-tui/` (Go) before they ship in
  a release. The TS CLI is intentionally minimal.
- **WAL storage bridge.** `src/nexus/storageBridge.ts` writes a JSONL log
  alongside the SQLite DB for crash recovery. Don't delete the `.wal.jsonl`
  file — it is replayed on startup.
- **Go-runner is optional.** Tools can run in `local` / `docker` / `remote`
  modes. The remote mode requires `BABEL_O_RUN_GO_RUNNER_SMOKE=1`-style env
  flags to enable in tests. See `runners/go-runner/`.
- **`bbl go` binary discovery** (per `go-tui-release.yml` comments) follows
  this precedence: `--binary` flag → `BABEL_O_GO_TUI_BINARY` env →
  package-bundled `bin/go-tui-<os>-<arch>` → XDG `~/.local/share/babel-o/bin/`
  → source fallback `go run ./cmd/go-tui`.

---

## 7. Testing

- **Framework:** `node:test` (built-in) driven by `tsx --test`. Each file is
  listed explicitly in `package.json#scripts.test` with
  `--test-concurrency=1` to avoid shared-storage races.
- **Environment:** `NODE_ENV=test` + `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json`
  are forced by the script. Add new env-required test files to that list
  rather than calling the test entrypoint directly.
- **Smoke tests** (live, opt-in via env flag):
  - `test:tui:pty` — `BABEL_O_RUN_PTY_SMOKE=1`
  - `test:go-tui:smoke` — `BABEL_O_RUN_GO_TUI_SMOKE=1`
  - `test:go-runner:smoke` — `BABEL_O_RUN_GO_RUNNER_SMOKE=1`
- **Large file warnings:** `test/runtime.test.ts` is 248 KB and
  `test/agent-loop.test.ts` is 94 KB — they are slow but expected. Do not
  split them without strong justification.
- **Dependency-boundary test:** `test/architecture-boundary.test.ts` and
  `npm run deps:audit` enforce the CLI ↔ runtime import rule. New deps must
  appear in `scripts/audit-dependency-boundary.js#dependencyOwnership`.
- **Coverage:** `npm run coverage` runs `scripts/coverage-report.js`. Output
  goes to `coverage/` (gitignored).

---

## 8. Reference Material

- `docs/DEVELOPMENT.md` — branch responsibilities, dev-mode workflow.
- `docs/nexus/reference/` — long-form design plans (governance, observability,
  perms, Go TUI rewrite, etc.). Comments in source code often cite these by
  filename — keep that trail intact.
- `docs/nexus/DONE.md` — completed phase summaries.
- `docs/releases/v0.3.2.md` — release notes; new releases append a new file.
- `README.md` / `README.zh-CN.md` — user-facing feature docs.
- `clients/go-tui/README.md` — Go TUI internals.
- The `package.json#files` whitelist defines what `npm publish` ships — keep
  the Go TUI `!clients/go-tui/internal/tui/*_test.go` exclusion line.

---

## 9. Quick Sanity Checks

Before pushing a change:

1. `npm run lint` (typecheck + format + dep audit)
2. `npm test` (full suite; long-running)
3. `npm run build:smoke` (compile + run prod smoke)

If you touched the embedded Nexus default storage path, the permission
policy mode, or SessionChannel routing, also smoke-test `bbl chat dev`
and `bbl run "<simple prompt>"` against a scratch directory.
