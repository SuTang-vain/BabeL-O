# Unify Embedded CLI Path Plan

> State: Draft
> Track: CLI / Nexus
> Priority: P0 — the embedded path is a second, divergent Nexus orchestration that silently violates rule #1
> Source of truth: [../TODO.md](../TODO.md), [../active/TODO_runtime.md](../active/TODO_runtime.md), [../DONE.md](../DONE.md), [../WORK_LOG.md](../WORK_LOG.md), `src/cli/runSessionFlow.ts`, `src/cli/embedded.ts`, `src/cli/NexusClient.ts`, `src/nexus/app.ts`, `src/nexus/createRuntime.ts`
> Governance: Indexed by [README.md](../README.md). Canonical owner of "the CLI has one client surface, not two divergent ones." Coupling enforcement is owned by [layer-direction-audit-enforcement-plan.md](../reference/layer-direction-audit-enforcement-plan.md); coupling debt by [module-coupling-decoupling-and-re-aggregation-plan.md](../reference/module-coupling-decoupling-and-re-aggregation-plan.md).
> Related: [layer-direction-audit-enforcement-plan.md](../reference/layer-direction-audit-enforcement-plan.md), [module-coupling-decoupling-and-re-aggregation-plan.md](../reference/module-coupling-decoupling-and-re-aggregation-plan.md)

## Purpose

"Nexus owns execution, CLI owns interaction" must hold for **both** the remote path and the embedded (in-process) path. Today it holds only for the remote path. The embedded path reimplements session lifecycle orchestration inside the CLI and reaches directly into runtime/storage internals. This plan unifies the two client surfaces so the CLI is a thin delegate whether it talks to a remote daemon or an in-process one.

## Current State

- Remote path (`url` provided): `runSessionFlow.ts:45-152` goes through WebSocket + `NexusClient` HTTP; the CLI only renders permission prompts and relays responses. Clean.
- Embedded path: `runSessionFlow.ts:153-308` directly imports `../runtime/hooks.js` (`:11`), `../runtime/systemPromptBuilder.js` (`:12`), `../nexus/createRuntime.js` (`:156`), `../nexus/everCoreRuntimeManager.js` (`:157`), `../nexus/remoteRunnerConfig.js` (`:158`); directly calls `runtime.executeStream(...)` (`:261`); monkey-patches `storage.appendEvent` (`:185-201`); directly manipulates `storage.getSession`/`saveSession` (`:203-224`); resolves permissions via `PendingPermissionRegistry` (`:191-197,431-437`); reimplements outcome resolution via `resolveFinalSessionOutcome` (`:333-393`). This is a **second, divergent implementation** of Nexus orchestration.
- `EmbeddedNexusClient` (`embedded.ts:289-341`) uses the clean `app.inject` pattern — but **rebuilds the entire Nexus app + runtime + storage + EverCore on every `injectJson` call** (`createDefaultNexusRuntime` + `createNexusApp`), then `app.close()` + `storage.close()` in `finally`. Request-scoped factory, not a long-lived in-process Nexus.
- `NexusClient` and `EmbeddedNexusClient` duplicate ~15 method signatures and URL paths (`memorySearch`, `listSessions`, `listSessionEvents`, `compactSession`, `analyzeContext`, `closeSession`, …) but are **not interface-compatible**: `NexusClient.execute(body:{prompt,cwd?,sessionId?})` (`NexusClient.ts:183-197`) vs `EmbeddedNexusClient.execute(prompt:string, cwd:string)` (`embedded.ts:94-96`). No shared interface — drift already present.
- `src/cli/commands/context.ts` bypasses Nexus entirely, reading runtime-owned state directly (documented intentional offline at `:7`).

## Problem Statement

Two divergent orchestration paths mean: a fix to session lifecycle (event appending, hook execution, outcome resolution, permission resolution) must be applied twice, and the embedded copy is uncovered by the boundary audit (see [layer-direction-audit-enforcement-plan.md](../reference/layer-direction-audit-enforcement-plan.md)). The per-call rebuild in `EmbeddedNexusClient` is also a performance/resource smell. The incompatible `execute` signatures are already-live drift.

## Goals

- One client interface (`NexusClientInterface`) shared by `NexusClient` (HTTP/WS) and `EmbeddedNexusClient` (in-process via `app.inject`).
- The embedded path runs `runtime.executeStream` **only** through the Nexus app (HTTP `app.inject` or an equivalent in-process route call), never by the CLI reaching into `runtime`/`storage` directly.
- A long-lived in-process Nexus for the embedded path (built once per CLI invocation, not per request) so storage/tools/EverCore are not rebuilt per call.
- The `execute` signature is unified.
- `context.ts` offline capability is preserved but routed through a documented read-only Nexus surface (or explicitly allowlisted as an offline exception by the layer-direction audit).

## Non-goals

- Do not remove the embedded mode — it is required for single-binary / no-daemon UX.
- Do not change the remote `NexusClient` wire protocol.
- Do not merge `context.ts` into Nexus if it is genuinely offline; just make the exception explicit and audited.
- Concurrency / synchronous-SQLite concerns are out of scope here (separate proposal).

## Design

### Phase 1 — Shared client interface

1. Extract `src/cli/NexusClientInterface.ts` (or extend an existing types module) declaring every method both clients share, with a single `execute(body: { prompt, cwd?, sessionId? })` signature. Align `EmbeddedNexusClient.execute` to this signature.
2. Both `NexusClient` and `EmbeddedNexusClient` `implements` it. A compile-time check prevents signature drift.
3. Add `test/nexus-client-interface-conformance.test.ts` asserting both implement the interface (type-level) and the shared methods return the same shapes for a mock request.

### Phase 2 — Long-lived embedded Nexus

1. `EmbeddedNexusClient` builds the app + runtime + storage **once** at construction (or on first use), keeps a reference, and `app.inject`s each request against that single app. `close()` tears it down at CLI exit (fold into the daemon shutdown wiring from [daemon-graceful-shutdown-and-orphan-reaper-plan.md](../reference/daemon-graceful-shutdown-and-orphan-reaper-plan.md)).
2. Eliminate the per-`injectJson` `createDefaultNexusRuntime` + `createNexusApp` + `app.close()` + `storage.close()` cycle.

### Phase 3 — Route embedded execution through the app

1. Move the embedded path in `runSessionFlow.ts:153-308` off direct `runtime.executeStream` / `storage` / `PendingPermissionRegistry` access. The CLI calls the client interface (which, for embedded, `app.inject`s `/v1/execute` or `/v1/stream`), exactly as the remote path does.
2. The session-lifecycle orchestration (event append, hook execution, outcome resolution) lives **only** in the Nexus execute-route modules (`executionStreamLoop.ts`, `executionFinalization.ts`, etc.). Delete the duplicated orchestration from `runSessionFlow.ts`.
3. Permission rendering stays in the CLI (it owns interaction); the permission *resolution* stays in Nexus. The CLI renders `permission_request` events and sends `permission_response` back through the client interface — same as remote.

### Phase 4 — `context.ts` exception

1. Either expose a read-only `/v1/context/preview` route in Nexus and route `context.ts` through it, or formally add `context.ts`'s runtime imports to the layer-direction allowlist ([layer-direction-audit-enforcement-plan.md](../reference/layer-direction-audit-enforcement-plan.md)) with the "intentional offline capability" justification already documented at `context.ts:7`. Decide per cost; default to allowlist if the offline requirement is load-bearing.

## Phases

| Phase | Status | Scope | Exit criteria |
| --- | --- | --- | --- |
| Phase 1 | Draft | Shared `NexusClientInterface`; unify `execute` signature. | Both clients implement it; conformance test passes; no signature drift possible at compile time. |
| Phase 2 | Draft | Long-lived embedded Nexus (build once, `app.inject` per request). | `EmbeddedNexusClient` no longer rebuilds app/runtime/storage per call; `test/embedded-nexus-lifecycle.test.ts` asserts single construction. |
| Phase 3 | Draft | Embedded path routes through the app; delete duplicated orchestration in `runSessionFlow.ts`. | `runSessionFlow.ts` has zero `runtime/*` / `storage/*` / `PendingPermissionRegistry` direct imports; embedded + remote paths produce identical event sequences for a fixture turn. |
| Phase 4 | Draft | `context.ts` routed or formally allowlisted. | `context.ts` either goes through Nexus or carries an audited allowlist entry. |

## Verification

- `npm test` (new conformance + lifecycle + event-sequence-parity tests green; existing execute/agent regressions unaffected).
- `npm run deps:audit` + layer-direction audit (Phase 1 of [layer-direction-audit-enforcement-plan.md](../reference/layer-direction-audit-enforcement-plan.md)) confirms `runSessionFlow.ts` no longer imports `runtime/*` / `storage/*` directly.
- `npm run build:smoke`.
- Manual: `bbl run "hello"` (embedded) and a remote `bbl run` produce the same event stream.

## Document Ownership

- Current priority lives in [../TODO.md](../TODO.md) and [../active/TODO_runtime.md](../active/TODO_runtime.md).
- Completed facts move to [../DONE.md](../DONE.md); factual history to [../WORK_LOG.md](../WORK_LOG.md).
- Enforcement of the resulting boundary is owned by [layer-direction-audit-enforcement-plan.md](../reference/layer-direction-audit-enforcement-plan.md).

## 中文概述

### 背景

"Nexus owns execution" 只在远程 HTTP/WS 路径成立；嵌入式路径在 `runSessionFlow.ts` 里直触 `runtime.executeStream`/`storage`/`PendingPermissionRegistry`，是事实上的第二份编排实现，且 `NexusClient` 与 `EmbeddedNexusClient` 不接口兼容（`execute` 签名已漂移），`EmbeddedNexusClient` 还每次请求重建整套 app+runtime+storage。

### 核心做法

Phase 1 抽共享 `NexusClientInterface` 统一 `execute` 签名；Phase 2 让嵌入式 Nexus 常驻（建一次、`app.inject` 复用）；Phase 3 把嵌入式执行路由回 app、删掉 `runSessionFlow` 里的重复编排；Phase 4 处理 `context.ts` 离线例外（路由或显式 allowlist）。

### 当前状态

草案。需先进 `proposals/`，与 [layer-direction-audit-enforcement-plan.md](../reference/layer-direction-audit-enforcement-plan.md) 配套——审计先把当前边界固化，本计划再把嵌入式路径收敛回单一编排。

### 下一步

最小切片：Phase 1 共享接口 + 统一 `execute` 签名 + conformance 测试，零行为变更，先消除漂移源。
