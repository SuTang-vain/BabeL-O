# Nexus

> Module reference · stable public contract · see linked governance docs for deep architecture

[简体中文](nexus.zh-CN.md)

## Role

Nexus is the execution host. It owns the Fastify REST + WebSocket API, session /
event / task / audit storage orchestration, runtime harness creation, agent
scheduling, and the tool-permission and task-scope gates. Clients (`bbl go`,
`bbl run`, or any API consumer) connect to Nexus; Nexus owns execution truth and
clients only render interaction.

## Public contract

- **`NexusRuntime.executeStream(...)` → `AsyncIterable<NexusEvent>`** — the
  canonical execution contract. Every client (`bbl run`, `bbl go`, API consumer)
  stays on the same event protocol regardless of which runtime implementation is
  selected. The harness is assembled in `createRuntime.ts`; the streaming
  implementation lives in `src/runtime` (`LLMCodingRuntime` for real LLMs,
  `LocalCodingRuntime` for deterministic / test paths).
- **HTTP + WebSocket API under `/v1/...`** — routes live as small modules in
  `src/nexus/routers/` and are registered by `routerRegistrar.ts`. The server
  entry (`server.ts`) runs security validation (`validateSecurityConfig`) and
  environment parsing before the app is assembled in `app.ts`.
- **`createDefaultNexusRuntime`** — the harness factory that wires builtin tools,
  MCP tools, agent tools, storage, MemoryOS / EverCore, policy, and runtime
  selection into one `NexusRuntime`.

## Allowed dependencies

Nexus sits at the top of the execution layer and may import `runtime`, `tools`,
`mcp`, `storage`, `providers`, `shared`, and its own `agents/` subtree. The
layer-direction gates (`deps:audit`, enforced in CI) forbid the reverse:

- `runtime` → `nexus` is **forbidden** (the runtime engine must not depend on the
  host).
- `nexus` → `cli` / `clients` is **forbidden** (Nexus must not depend on any
  interaction layer).

See
[Layer-direction audit](../../nexus/reference/layer-direction-audit-enforcement-plan.md)
and
[Module coupling governance](../../nexus/reference/module-coupling-decoupling-and-re-aggregation-plan.md)
for the full heat map and reverse-import allowlists.

## Extension points

- **Add an HTTP / WebSocket route** — create a router module in
  `src/nexus/routers/` and register it in `routerRegistrar.ts`. Keep `app.ts`
  thin; the north-star is that routing slices stay small and independently
  testable.
- **Add or change agent behavior** — extend `src/nexus/agents/` and the
  `agentLoop*.ts` family. Four roles exist today: planner, executor, critic,
  optimizer. Sub-agents recurse through `runAgentLoop` with a forked context and
  a bounded tool set.
- **Hook execution** — middleware-style runtime hooks
  (`src/runtime/hooks.ts`) are wired by the harness and can deny a tool, rewrite
  tool input, provide a permission decision, or add retry hints.
- **Persisted state** — new persisted state goes through the storage repository
  pattern in `src/storage` and the async `storageBridge` WAL path; Nexus
  orchestrates but does not write storage formats directly.

## Related governance

- [Module coupling governance](../../nexus/reference/module-coupling-decoupling-and-re-aggregation-plan.md) — coupling heat map, `app.ts` router split, singleton-to-injection.
- [Layer-direction audit](../../nexus/reference/layer-direction-audit-enforcement-plan.md) — direction-aware dependency gates.
- [Agent runtime maturity](../../nexus/reference/agent-runtime-architecture-maturity-plan.md) — trace, eval, durable resume gaps.
- [Runtime tool-loop governance](../../nexus/reference/runtime-tool-loop-governance-plan.md) — tool-loop continuity and bounded final checks.
- [Development process stability](../../nexus/reference/development-process-stability-governance-plan.md) — PR review levels for high-risk nexus changes.
