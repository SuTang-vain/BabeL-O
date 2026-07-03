# Runtime

> Module reference · stable public contract · see linked governance docs for deep architecture

[简体中文](runtime.zh-CN.md)

## Role

Runtime is the execution engine. It owns the streaming execution loop (`executeStream`), context assembly and compaction, tool dispatch and permission gating, provider interaction, scope derivation, intent guidance, session continuity, and the middleware hook system. Runtime implements the `NexusRuntime` contract that Nexus constructs and clients consume; it is the single source of execution truth and is strictly forbidden from importing any Nexus host code.

## Public contract

- **`NexusRuntime.executeStream(options)` → `AsyncIterable<NexusEvent>`** — the canonical streaming execution contract. Defined in `Runtime.ts`; implemented by `LLMCodingRuntime` (real LLM, production path) and `LocalCodingRuntime` (deterministic, local-intent, and test path). Both implementations produce identically-shaped event streams.
- **`RuntimeExecuteOptions`** — the comprehensive per-request parameter surface: provider selection, signal/abort, tool policy (`allowedTools`, `policyMode`), hook config, cwd continuity fields, execution environment, budget, and remote-runner wiring.
- **`RuntimeToolAuditEntry`** — the tool-audit shape returned by `listTools()`: name, description, risk, allowed status, input schema, source origin (builtin vs MCP), and approval metadata.
- **`ToolPolicy`** — the per-input policy gate exported from `LocalCodingRuntime.ts` with three modes (`allow_all`, `allowlist`, `session_rules`). Applied per-turn via `buildPerRequestAllowedToolsPolicy` and overridable through `RuntimeExecuteOptions.allowedTools`.
- **`RuntimeHook`** — middleware-style hook contract (`hooks.ts`). Hooks subscribe to named lifecycle events (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `PreInvocation`, `PostInvocation`, `SessionEnd`) and can deny, rewrite, augment, or retry-hint any tool call. Seven built-in hooks ship with the runtime; callers supply additional hooks or configure builtin overrides through `HooksConfig`.

## Allowed dependencies

Runtime may import `shared/`, `tools/`, `providers/`, `storage/`, and `skills/`. The layer-direction gates (`deps:audit`, enforced in CI) strictly forbid:

- `runtime` → `nexus` is **forbidden** (the runtime must not depend on the host layer — no import of `../nexus/`).
- `runtime` → `cli` / `clients` is **forbidden** (the runtime must not depend on any interaction layer).

See [Layer-direction audit](../../nexus/reference/layer-direction-audit-enforcement-plan.md) for the full heat map and allowlist rules.

## Extension points

- **Add a runtime hook** — implement the `RuntimeHook` interface (`hooks.ts`), subscribe to one or more `HookEventName` lifecycle points, and pass the hook via `RuntimeExecuteOptions.runtimeHooks`. Hooks can deny a tool (with reason), rewrite tool input, provide a permission decision, add retry hints, or emit summary diagnostics.
- **Add a new runtime implementation** — implement `NexusRuntime.executeStream()`. The contract is a single async iterable method plus an optional `listTools()` helper. The runtime is then wired into the harness factory (`createRuntime.ts` in nexus) for production use.
- **Extend the tool loop** — the tool-dispatch pipeline (`runtimeToolLoop.ts`, `toolExecutor.ts`) is composed from independent stages (effective-risk resolution, policy check, hooks, scope-boundary preflight, tool execution with timeout/remote-runner, result budget enforcement). Stages can be replaced or extended without touching the main LLM provider loop.
- **Extend context compaction** — the compact chain (`compact.ts`, `compactPostRestore.ts`, `cacheAwareCompactPolicy.ts`) and context assembly (`contextAssembler.ts`) are modular. New compactors go in `src/runtime/compactors/` and are plugged into the assembly pipeline.

## Related governance

- [Runtime tool-loop governance](../../nexus/reference/runtime-tool-loop-governance-plan.md) — recoverable tool errors, bounded loop finalization, tool-call text suppression, and final-answer guarantees after tool failures.
- [Runtime tool permission flow reference](../../nexus/reference/runtime-tool-permission-flow-reference.md) — canonical shared permission flow (risk resolution, policy, hooks, scope-boundary, pending registry, audit, events) extracted from both runtimes.
- [Context governance index](../../nexus/reference/context-governance-index.md) — reader entry point for context assembly, working set, behavior trace, memory, cache observability, and tool-loop recovery ownership.
- [Intent guidance and prompt governance optimization plan](../../nexus/reference/intent-guidance-and-prompt-governance-optimization-plan.md) — runtime-owned intent classification, deterministic Turn Policy normalization, and capability/verification split.
- [Task scope and evidence scope governance plan](../../nexus/reference/task-scope-and-evidence-scope-governance-plan.md) — runtime-owned task scope derivation, scope boundary classification, and out-of-scope evidence diagnostics.
