# Daemon Graceful Shutdown and Startup Orphan Reaper Plan

> State: Draft
> Track: Nexus / Runtime / Storage
> Priority: P0 — directly contradicts the "durable sessions" product claim and the soft-recoverable-timeout principle
> Source of truth: [../TODO.md](../TODO.md), [../active/TODO_runtime.md](../active/TODO_runtime.md), [../DONE.md](../DONE.md), [../WORK_LOG.md](../WORK_LOG.md), `src/nexus/server.ts`, `src/nexus/createRuntime.ts`, `src/nexus/storageBridge.ts`, `src/nexus/agents/AgentScheduler.ts`, `src/storage/SqliteStorage.ts`
> Governance: Indexed by [README.md](../README.md). Canonical owner of daemon lifecycle / orphan reaping. Coupling boundaries stay in [module-coupling-decoupling-and-re-aggregation-plan.md](../reference/module-coupling-decoupling-and-re-aggregation-plan.md); soft-recoverable-timeout semantics stay in [runtime-tool-loop-governance-plan.md](../reference/runtime-tool-loop-governance-plan.md).
> Related: [module-coupling-decoupling-and-re-aggregation-plan.md](../reference/module-coupling-decoupling-and-re-aggregation-plan.md), [runtime-tool-loop-governance-plan.md](../reference/runtime-tool-loop-governance-plan.md)

## Purpose

The Nexus daemon ("Nexus owns execution, session is a view") must survive a hard kill and restart without losing or strandling state. Today it does not. This plan governs the gap between the durable-session product claim and the actual shutdown / recovery behavior, and makes recovery automatic and recoverable rather than fatal.

## Current State

- `src/nexus/server.ts` registers an `onClose` hook (`server.ts:115-117`) that **only** shuts down `defaultEverCoreRuntimeManager`. There is **no `SIGTERM` / `SIGINT` handler**, no `app.close()` call, and **`storage.close()` is never invoked** on shutdown.
- `storage.close` is overridden at `createRuntime.ts:169-176` to flush `storageBridge` and dispose tools — but that flush path is **never triggered** because nothing calls `storage.close()` during daemon teardown.
- `storageBridge` has a genuine WAL: append-on-enqueue (`storageBridge.ts:322-345`), ack-on-flush, replay-on-start (`:407-434`). WAL is assembled at `createRuntime.ts:144` (`configureStorageBridgeWal(\`${resolvedStoragePath.path}.wal.jsonl\`, ...)`), and that call internally triggers `replayWal` (`storageBridge.ts:152`) to complete replay-on-start. On a clean flush this survives; on a hard kill only the already-appended WAL records survive — the in-memory queue is dropped.
- No crash recovery / orphan reaper on startup. `AgentScheduler.loadPersistedJobs` (`AgentScheduler.ts:236`) rehydrates job records but **never transitions stale `running` jobs to `failed`**. Sessions left in `executing` phase by a crashed daemon stay `executing` forever.
- `/v1/execute` writes events directly to SQLite via `processRuntimeExecutionEvent` — the actual `storage.appendEvent` call lives at `executionEventProcessing.ts:35` (and `:41` for the cache-health companion event), invoked from the runtime generator loop at `executionStreamLoop.ts:39`; agent-loop path uses in-process `taskSessions` / `taskQueues` Maps as source of truth (`taskSession.ts:21`, `taskQueue.ts:15`, consumed by `agentLoop.ts:28` and peers) with write-behind — these are lost on death, only mitigated by WAL replay for ops that reached the WAL buffer.

This means: after a crash or `kill`, a reconnecting client sees a session stuck in `executing` and agent jobs stuck in `running`, with no automatic recovery.

## Problem Statement

The "session is a view / durable sessions" claim (`ARCHITECTURE.md`, `PROJECT_IDENTITY.md` §2.2) requires that a daemon death is recoverable. Today the daemon exits without draining the storage bridge, without closing the Fastify app, and without reaping orphaned executions on restart. This is a real-session regression class, not theoretical: any `kill -9` / OOM / reboot leaves the persisted state inconsistent and the UI frozen on a stale `executing` badge.

This also violates the soft-recoverable-timeout principle: a shutdown should be a recoverable interruption, not a fatal cutoff that strands state.

## Goals

- On `SIGTERM` / `SIGINT`: flush `storageBridge`, dispose tools, close Fastify + storage, then exit. The WAL queue reaches disk.
- On startup: a reaper transitions any persisted `executing` session and `running` agent job left by a prior crash into a recoverable terminal state (`interrupted` / `failed`) with a structured reason, so reconnecting clients see a clean terminal state instead of a frozen `executing`.
- No silent data loss for ops that were already enqueued into the storageBridge WAL.
- Recovery is automatic and observable (emits / logs a reaper event).

## Non-goals

- Do not change the in-process `taskSessions` / `taskQueues` source-of-truth design for the agent-loop path — that is owned by [P1-7 unify-agent-models proposal](./unify-agent-execution-models-plan.md).
- Do not replace `node:sqlite` `DatabaseSync` with async I/O here — that is owned by the concurrency-model proposal (to be filed).
- Do not add cross-process coordination (distributed locks). Single-daemon assumption stays.
- Do not change the WAL format.

## Design

### Phase 1 — Graceful shutdown wiring

1. In `src/nexus/server.ts`, register `process.on('SIGTERM' | 'SIGINT', shutdown)` where `shutdown`:
   - Sets a `shuttingDown` flag that causes `/v1/execute` / `/v1/stream` to reject new leases with a `503` in the `{ type: 'error', code, message }` envelope shape defined by `registerErrorHandler` in `middleware.ts:45-66`, using a new `SHUTTING_DOWN` code (this code does not exist in the tree today — Phase 1 introduces it; it is not a reuse of an existing literal).
   - Awaits in-flight `ExecutionGate` leases to drain with a bounded grace budget (default 5s, configurable via `RuntimeEnv`), then forces a cancel.
   - Calls `app.close()` (stops accepting new connections, drains WS).
   - Calls `storage.close()` — which already flushes `storageBridge` and disposes tools (`createRuntime.ts:169-176`). Verify the override path actually runs in this flow; if not, re-wire so it does.
   - Calls `defaultEverCoreRuntimeManager.shutdown()` (the only thing the current `onClose` hook does — fold it into `shutdown`).
   - `process.exit(0)`.
2. Keep `onClose` as a Fastify-only cleanup hook for the `app.close()`-driven path, but do not rely on it as the sole signal-driven teardown.
3. Idempotent: a second signal forces `process.exit(1)` immediately.

### Phase 2 — Startup orphan reaper

1. A new `src/nexus/startupReaper.ts` (or a method on `createDefaultNexusRuntime`) runs once after storage is open and before the server accepts traffic:
   - `UPDATE sessions SET phase = 'interrupted', terminal_reason = 'daemon_restart_orphan' WHERE phase = 'executing'` (and equivalent for any in-flight sub-state).
   - For agent jobs: `AgentScheduler.loadPersistedJobs` already rehydrates; add a transition step that moves any rehydrated job whose persisted status is `running` to `failed` with `reason: 'orphaned_on_restart'`, and finalizes the child session to a terminal state. Emit a `agent_job_orphaned` diagnostic event.
   - Emit a structured startup log + a `daemon_recovery` event with counts.
2. The reaper is **non-fatal**: if it fails (e.g. schema mismatch), log and continue starting — do not block daemon boot.

### Phase 3 — Verification hooks

- A new test `test/daemon-graceful-shutdown.test.ts`: spawn a Nexus process, start a `/v1/execute`, send `SIGTERM`, assert the WAL file's in-flight ops are flushed and the process exits 0.
- A new test `test/daemon-orphan-reaper.test.ts`: seed a session in `executing` + a `running` agent job, boot the daemon, assert both are reaped to terminal state.

## Phases

| Phase | Status | Scope | Exit criteria |
| --- | --- | --- | --- |
| Phase 1 | Draft | Signal-driven graceful shutdown: SIGTERM/SIGINT → drain leases → app.close() → storage.close() → exit. | `test/daemon-graceful-shutdown.test.ts` asserts WAL flush + exit 0 on SIGTERM; no in-memory queue loss for enqueued ops. |
| Phase 2 | Draft | Startup orphan reaper for `executing` sessions + `running` agent jobs. | `test/daemon-orphan-reaper.test.ts` asserts reaped terminal state on boot after a simulated crash. |
| Phase 3 | Draft | Verification + WORK_LOG/DONE record; no behavior change beyond lifecycle. | `npm test` green; `npm run build:smoke` green; real-session replay of a `kill -9` reconnect shows clean terminal state. |

## Verification

- `npm test` (new lifecycle tests green + existing execute/agent regressions unaffected).
- `npm run build:smoke`.
- Manual: `npm run start`, start a long `/v1/execute`, `kill -TERM <pid>`, restart, reconnect — session shows `interrupted`, not frozen `executing`.
- Manual: kill agent job mid-flight, restart, reconnect — job shows `failed (orphaned_on_restart)`.

## Document Ownership

- Current priority lives in [../TODO.md](../TODO.md) and [../active/TODO_runtime.md](../active/TODO_runtime.md).
- Completed facts move to [../DONE.md](../DONE.md); factual history to [../WORK_LOG.md](../WORK_LOG.md).
- This document keeps only the durable lifecycle boundary, phase plan, and regression context.

## 中文概述

### 背景

Nexus 宣称 "session is a view / durable session"，但 `server.ts` 无 SIGTERM/SIGINT handler、不调用 `app.close()` / `storage.close()`，`storageBridge` 的 flush 路径在硬 kill 时不会触发；启动也无 orphan reaper，崩溃遗留的 `executing` session 与 `running` agent job 永远卡死。这与 durable 卖点正面冲突，也违反软可恢复超时原则。

### 核心做法

Phase 1 给 daemon 装信号驱动优雅关停（drain lease → app.close → storage.close flush → exit）；Phase 2 启动时 reaper 把遗留 `executing`/`running` 转 `interrupted`/`failed(orphaned_on_restart)`；reaper 非致命，失败只记日志不阻塞启动。

### 当前状态

草案。尚未实现。需先进 `proposals/`，落地后毕业到 `reference/` 或合并进 `history/`。

### 下一步

最小可验证切片：Phase 1 的 SIGTERM → `storage.close()` flush 一条，配套 `test/daemon-graceful-shutdown.test.ts`。
