# Storage Interface Segregation and Repository Abstraction Reference

> State: Active Plan
> Track: Storage
> Priority: P2 — 48-method monolithic interface violates ISP; partial repository extraction left `MemoryStorage` unable to reuse repositories
> Source of truth: [../TODO.md](../TODO.md), [../active/TODO_runtime.md](../active/TODO_runtime.md), [../DONE.md](../DONE.md), [../WORK_LOG.md](../WORK_LOG.md), `src/storage/Storage.ts`, `src/storage/SqliteStorage.ts`, `src/storage/MemoryStorage.ts`, `src/storage/EventRepository.ts`, `src/storage/TaskRepository.ts`, `src/storage/AuditRepository.ts`, `src/storage/ToolTraceRepository.ts`, `src/storage/SessionChannelRepository.ts`
> Governance: Indexed by [README.md](../README.md). Canonical owner of "the storage interface is segregated by domain and repositories are polymorphic across backends." Coupling-debt inventory stays in [module-coupling-decoupling-and-re-aggregation-plan.md](../reference/module-coupling-decoupling-and-re-aggregation-plan.md) (Phase 9 Stream G).
> Related: [module-coupling-decoupling-and-re-aggregation-plan.md](../reference/module-coupling-decoupling-and-re-aggregation-plan.md), [daemon-graceful-shutdown-and-orphan-reaper-plan.md](../proposals/daemon-graceful-shutdown-and-orphan-reaper-plan.md)

## Purpose

`NexusStorage` is a single 48-method interface spanning 10 logical domains. The repository extraction (Phase 9 Stream G in the coupling plan) pulled 5 domain classes out of `SqliteStorage` but made them SQLite-specific (they take `DatabaseSync`), so `MemoryStorage` cannot reuse them and there is no shared `Repository<T>` interface. This document is the durable reference for finishing the segregation: split the interface by domain and make repositories polymorphic.

## Current State

- `NexusStorage` (`Storage.ts:124-171`) is one flat interface with 48 methods across sessions, events, tasks, agent jobs, tool traces, session channels, session messages, permission audits, execution metrics, loop panes. Any implementor must implement all 48.
- The interface imports only from `src/shared/` — clean layer direction.
- 5 extracted repositories (`EventRepository`, `TaskRepository`, `AuditRepository`, `ToolTraceRepository`, `SessionChannelRepository`) each take `DatabaseSync` in their constructor — **SQLite-specific**. `MemoryStorage` (387 lines) re-implements the same 48 methods with `Map` + `structuredClone`, no repositories, no shared interface.
- No shared `Repository<T>` interface — each repository is a standalone class with its own signatures. Domain methods cannot be used polymorphically across `SqliteStorage` / `MemoryStorage`.
- `SqliteStorage` is still 1255+ lines: schema + 15 version migrations + sequence backfill + the un-extracted domains (sessions, agent jobs, execution metrics, loop panes) + thin delegation wrappers over the 5 extracted repositories.
- Runtime modules depend on the whole 48-method `NexusStorage` type even when they use a subset (e.g. `emitMemoryRetrieval.ts` needs only `appendEvent`).

## Problem Statement

A 48-method interface forces every consumer/mock to depend on everything, hiding what a module actually needs. SQLite-only repositories mean the in-memory backend diverges by re-implementing each domain from scratch — a maintenance hazard and a test-fidelity risk (the in-memory path can drift from the SQLite path). The partial extraction is documented debt (Phase 9 is "In Progress" in the coupling plan).

## Goals

- `NexusStorage` is composed of per-domain sub-interfaces (`SessionStore`, `EventStore`, `TaskStore`, `AgentJobStore`, `ToolTraceStore`, `SessionChannelStore`, `AuditStore`, `MetricsStore`, `LoopPaneStore`). `NexusStorage` extends all of them for back-compat.
- Each domain has a `Repository<T>`-style interface that both `SqliteStorage` (via the extracted SQLite repository) and `MemoryStorage` implement, so domain behavior is polymorphic and testable against one contract.
- Runtime modules can depend on the narrow sub-interface they actually use (e.g. `EventStore`).
- `SqliteStorage` shrinks toward a composition root that wires repositories, schema, and migrations; `MemoryStorage` delegates to in-memory repository implementations of the same interfaces.

## Non-goals

- Do not change the on-disk schema or migration history.
- Do not change `node:sqlite` `DatabaseSync` (async I/O is a separate concern).
- Do not change the storageBridge WAL.
- Do not introduce a new ORM/query-builder dependency.

## Design

### Phase 1 — Domain sub-interfaces

1. In `Storage.ts`, split `NexusStorage` into per-domain interfaces. Keep `NexusStorage` as `extends SessionStore, EventStore, TaskStore, ...` for back-compat so existing callers compile unchanged.
2. Each sub-interface groups the methods of one domain (e.g. `EventStore { listEvents, appendEvent, ... }`).

### Phase 2 — Polymorphic repository interfaces

1. For each extracted SQLite repository, define a backend-neutral interface (e.g. `EventRepository` interface with `listEvents` / `appendEvent`). The existing SQLite class implements it; add an in-memory implementation used by `MemoryStorage`.
2. `SqliteStorage` and `MemoryStorage` both expose the same repository interfaces. Domain logic lives once per backend behind the interface.

### Phase 3 — Narrow consumer dependencies

1. Migrate runtime/nexus modules that use a subset to depend on the narrow sub-interface (`EventStore` instead of `NexusStorage`). Mechanical, per-module PRs.

### Phase 4 — Finish `SqliteStorage` extraction

1. Extract the remaining inline domains (sessions, agent jobs, execution metrics, loop panes) into repositories following the Phase 9 pattern. `SqliteStorage` becomes a composition root + schema/migration owner.

## Phases

| Phase | Status | Scope | Exit criteria |
| --- | --- | --- | --- |
| Phase 1 | Draft | Per-domain sub-interfaces; `NexusStorage` extends them. | All existing callers compile; `npm test` green. |
| Phase 2 | Draft | Polymorphic repository interfaces; in-memory implementations. | `MemoryStorage` delegates to in-memory repositories; a shared `test/storage-repository-contract.test.ts` runs against both backends. |
| Phase 3 | Draft | Narrow consumer dependencies. | Targeted modules import `EventStore` etc.; `npm run coupling:audit` reflects narrower deps. |
| Phase 4 | Draft | Finish `SqliteStorage` domain extraction. | `SqliteStorage` is a composition root; `wc -l` significantly reduced. |

## Verification

- `npm test` (existing `test/storage*.test.ts`, `test/storage-event-repository.test.ts`, `test/storage-task-repository.test.ts` green).
- New `test/storage-repository-contract.test.ts` (same assertions against SQLite + Memory).
- `npm run build:smoke`.

## Document Ownership

- Current priority lives in [../TODO.md](../TODO.md) and [../active/TODO_runtime.md](../active/TODO_runtime.md).
- Completed facts move to [../DONE.md](../DONE.md); factual history to [../WORK_LOG.md](../WORK_LOG.md).
- This document extends Phase 9 (Stream G) of [module-coupling-decoupling-and-re-aggregation-plan.md](../reference/module-coupling-decoupling-and-re-aggregation-plan.md).

## 中文概述

### 背景

`NexusStorage` 是 48 方法单接口跨 10 域；5 个已抽取 Repository 都接 `DatabaseSync`、是 SQLite 专属，`MemoryStorage` 无法复用、只能从零重写 48 方法，无共享 `Repository<T>` 接口，域方法无法跨后端多态。`SqliteStorage` 仍 1255+ 行。

### 核心做法

Phase 1 按域拆 sub-interface，`NexusStorage` extends 它们保兼容；Phase 2 给每个 Repository 定后端中立接口，`MemoryStorage` 用内存实现委托；Phase 3 让只用到子集的 runtime 模块依赖窄接口；Phase 4 抽完 `SqliteStorage` 剩余内联域。

### 当前状态

Active Plan 草案，承接 coupling plan Phase 9 (Stream G) 已开的头。P2 优先级，不阻塞 P0/P1。

### 下一步

最小切片：Phase 1 纯接口拆分 + `NexusStorage extends` 保兼容，零行为变更，先让消费者能声明窄依赖。
