# Tools

> Module reference · stable public contract · see linked governance docs for deep architecture

[简体中文](tools.zh-CN.md)

## Role

The tools module owns the model-visible tool surface: `ToolDefinition` interface, builtin tool implementations, the tool registry, path-safety guards, bash risk classification, tool-output truncation, and the context-retrieval pure functions. Every tool is a first-class object with a static risk level, a Zod input schema, an optional model-facing schema, an optional per-input risk override (`riskForInput`), and an `execute` function. The registry (`createDefaultToolRegistry`) assembles 19 builtin tools covering file discovery, source understanding, mutation, execution, task lifecycle, web search, context retrieval, and skill lifecycle.

## Public contract

- **`ToolDefinition`** (`src/tools/Tool.ts`) — the stable interface every tool implements. Fields: `name`, `description`, `risk` (`'read' | 'write' | 'execute' | 'task'`), `inputSchema` (Zod), optional `modelInputSchema`, optional `riskForInput` (per-input override), `execute(input, context)`. The `ToolContext` carries `cwd`, `sessionId`, optional `signal`, `maxOutputBytes`, `bashMaxBufferBytes`, `allowedPaths`, and optional `storage` reference.

- **`createDefaultToolRegistry`** (`src/tools/registry.ts`) — the canonical registry factory. Wires 19 builtin tools (ListDir, Glob, Grep, Read, Write, Edit, Bash, TaskCreate, WebSearch, contextSearch, contextSummarize, contextRecent, contextSessions, SkillList, SkillShow, SkillValidate, SkillDraft, SkillSave). Accepts an optional `storage: null` sentinel to drop context tools from the registry.

- **Read** (`src/tools/builtin/read.ts`) — source-understanding tool. Supports `lineOffset`/`lineLimit` (source lines), `byteOffset`/`byteLimit` (byte windows), `mode` (`'auto' | 'full' | 'preview'`). Maintains a session-scoped read ledger that detects repeated reads of large files and emits guidance. Risk: `read`.

- **Write / Edit** (`src/tools/builtin/write.ts`, `src/tools/builtin/edit.ts`) — mutation tools. Write creates or overwrites files; Edit applies line-range replacements. Risk: `write`.

- **Bash** (`src/tools/builtin/bash.ts`) — command execution tool. Risk: `execute` (static audit identity). Uses `riskForInput` backed by `classifyBashRisk` (`src/tools/builtin/bashClassifier.ts`) for per-input downgrade to `'read'` when the command is a read-only subcommand (ls, cat, `git status`, etc.) without dangerous patterns (redirects, pipes, chains, known destructive commands). Path resolution goes through `resolveInsideWorkspace` (`src/tools/builtin/pathSafety.ts`) which enforces the `NEXUS_ALLOWED_WORKSPACES` allowlist.

- **Path safety** (`src/tools/builtin/pathSafety.ts`) — workspace-boundary enforcement. `resolveInsideWorkspace` resolves the requested path relative to cwd, checks it against `NEXUS_ALLOWED_WORKSPACES` via `realpathSync`, and throws `WorkspacePathError` on escape. `buildPathDriftDiagnostic` (`src/tools/builtin/pathDrift.ts`) detects path-drift patterns (missing workspace-parent segment, sibling-root confusion) when a file does not exist at the requested path.

- **`classifyBashRisk`** (`src/tools/builtin/bashClassifier.ts`) — pure-function bash command classifier. Two-layer design: (1) read-only subcommand allowlist (ls, cat, git status, etc.) and (2) dangerous-pattern regex sweep (redirects, pipes, chained operators, known destructive commands). Quote-aware masking prevents false positives from shell operators inside string literals.

- **Tool-output truncation** (`src/tools/output.ts`) — `truncateToolOutput` caps string and JSON output by byte length, returning a `TruncatedOutput` envelope with `truncated` and `originalBytes` fields when the limit is exceeded.

## Allowed dependencies

The tools module may import `shared` for types, errors, IDs, and config. Type-only imports from `storage` (`NexusStorage`) are permitted for the tool context and registry. Imports from `runtime` (e.g. `behaviorTrace.ts` in `contextTools.ts`) and `skills` (e.g. `registry.ts` in `skillTool.ts`) are bounded to specific builtin tools and should not be treated as general dependency licenses. The layer-direction audit (`deps:audit`) enforces that no tool file may import `nexus` or `cli`.

## Extension points

- **Add a new builtin tool** — create a file in `src/tools/builtin/` exporting a `ToolDefinition`, then register it in `createDefaultToolRegistry` in `src/tools/registry.ts`. Follow the existing risk classification and evidence-semantics patterns from the tool governance plan.

- **Add an MCP tool** — MCP tools are registered through the MCP bridge, not the builtin tool registry. The tool surface is extended by configuring an MCP server and importing its tool definitions via the MCP connector.

- **Customize tool policy** — the three `ToolPolicy` constructors (`allowAllTools`, `denyByDefaultTools`, `allowlistedTools`) live in `src/runtime/LocalCodingRuntime.ts` and are composed by the runtime harness (`createRuntime.ts`). The `denyByDefault` policy auto-allows only `read` and `task` risk tools; every `write` or `execute` call requires a permission decision.

- **Override per-input risk** — implement `riskForInput` on a `ToolDefinition`. The Bash tool uses this pattern to downgrade `'execute'` to `'read'` for safe subcommands, skipping the approval gate while keeping the static risk at `'execute'` for audit clarity.

- **Extend path-safety checks** — the `NEXUS_ALLOWED_WORKSPACES` environment variable is the admin-controlled workspace boundary. `resolveInsideWorkspace` and `buildPathDriftDiagnostic` provide the two guardrails (escape prevention and drift detection). Task-scope boundary detection for out-of-scope evidence is handled by the runtime's `taskScope.ts`, not the tools module.

## Related governance

- [Tool governance](../../nexus/reference/tool-governance-plan.md) — canonical tool classes, evidence semantics, native/MCP coexistence, new-tool admission gates.
- [Runtime tool-loop governance](../../nexus/reference/runtime-tool-loop-governance-plan.md) — recoverable tool errors, tool-call-shaped text suppression, loop budget, bounded final checks.
- [Evidence governance index](../../nexus/reference/evidence-governance-index.md) — five evidence dimensions (existence, coverage, scope, freshness, replay validity) for tool results.
- [Task scope and evidence scope governance](../../nexus/reference/task-scope-and-evidence-scope-governance-plan.md) — scope-boundary classification for read-only tools, the P0 guardrail against out-of-scope evidence.
- [Runtime tool permission flow](../../nexus/reference/runtime-tool-permission-flow-reference.md) — effective-risk resolution, policy check, hooks, scope-boundary preflight, pending registry, audit events.
