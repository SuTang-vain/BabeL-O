# Storage

> Module reference · stable public contract · bottom-layer persistence with two backends (SQLite + in-memory), Repository pattern, and async WAL crash recovery

[简体中文](storage.zh-CN.md)

## Role

Storage is the bottom-layer persistence module. It owns the `NexusStorage` interface
(48 methods across 10 domains), the `SqliteStorage` backend (`node:sqlite`
`DatabaseSync` with WAL mode, schema version 15, ~10 tables, 8 extracted
repositories), and the `MemoryStorage` backend (`Map` + `structuredClone`, all
48 methods re-implemented inline). Nexus orchestrates storage in
`createDefaultNexusRuntime`; the `storageBridge` (`src/nexus/storageBridge.ts`)
provides an async WAL persistence queue (JSONL format, `replayWal` crash
recovery, `flushWalBuffer` periodic persistence) that decouples event writes
from synchronous SQLite I/O.

## Public contract

- **`NexusStorage`** (`src/storage/Storage.ts`) — the canonical 48-method async
  interface spanning sessions, events, tasks, agent jobs, tool traces, session
  channels + messages, permission audits, execution metrics, and loop panes.
  Every backend implements all 48 methods. Carries an optional `close()` for
  graceful shutdown.
- **`SqliteStorage`** (`src/storage/SqliteStorage.ts`) — production backend.
  Opens a `DatabaseSync` at a configurable path; creates tables and runs schema
  migrations (v1–v15) on construction. WAL journal mode (`PRAGMA journal_mode =
  WAL`). The inline session, tool-trace, and audit operations are being
  progressively extracted into domain repositories; 8 repositories are deployed
  today (`EventRepository`, `TaskRepository`, `AuditRepository`,
  `ToolTraceRepository`, `SessionChannelRepository`, `AgentJobRepository`,
  `ExecutionMetricsRepository`, `LoopPaneRepository`), each taking
  `DatabaseSync`.
- **`MemoryStorage`** (`src/storage/MemoryStorage.ts`) — in-memory backend for
  tests and ephemeral runs. All methods backed by `Map` + `structuredClone`. No
  repositories; re-implements 48 methods inline.
- **`storageBridge`** (`src/nexus/storageBridge.ts`) — Nexus-owned async WAL
  persistence layer. `persistTaskSessionMutation` / `persistNexusTask` enqueue
  operations; `flushStorageBridge` drains the queue and flushes the WAL buffer.
  On startup, `replayWal` replays un-acknowledged JSONL records to recover
  operations from a prior crash. The WAL path is assembled at
  `configureStorageBridgeWal` in `createRuntime.ts`.
- **`close()`** — `SqliteStorage.close()` calls `this.db.close()`. The graceful
  shutdown path (`SIGTERM`/`SIGINT` handler in `server.ts`) calls
  `storage.close()` which flushes the `storageBridge` before closing the
  database handle.

## Allowed dependencies

Storage sits at the bottom of the dependency graph and may import only
`src/shared/` for event, session, task, and trace types. The layer-direction
audit (`npm run deps:audit`, wired in CI) enforces:

- Storage must **not** import `nexus`, `runtime`, `cli`, or `clients`.
- Storage must **not** import `tools`, `providers`, or `mcp`.

The reverse direction (`nexus → storage`, `runtime → storage`) is permitted and
expected: 19 of 20 `nexus → storage` edges are `import type { NexusStorage }`,
with only the composition root (`createRuntime.ts`) importing concrete backends.

See
[Layer-direction audit](../../nexus/reference/layer-direction-audit-enforcement-plan.md)
and
[Storage interface segregation](../../nexus/reference/storage-interface-segregation-reference.md)
for the canonical-shape invariant and the ISP remediation plan.

## Extension points

- **Add a new domain to storage** — create a new repository class in
  `src/storage/` (following the `EventRepository` / `TaskRepository` pattern),
  add the domain methods to `NexusStorage`, implement in both `SqliteStorage`
  (via the new repository) and `MemoryStorage` (inline). Wire the repository in
  `SqliteStorage`'s constructor. This path also requires a schema migration
  (increment `PRAGMA user_version`).
- **Add a new storage backend** — implement `NexusStorage` in a new class.
  Used today for testing (`MemoryStorage`) and ephemeral runs.
- **storageBridge WAL** — the WAL path is configured per-storage-bridge
  instance. The JSONL schema (`2026-05-24.storage-bridge-wal.v1`) supports
  `op` and `ack` record types; `replayWal` re-enqueues un-acknowledged ops on
  startup. New operation types require adding a variant to
  `PersistOperationPayload`.

## Related governance

- [Storage interface segregation](../../nexus/reference/storage-interface-segregation-reference.md) — 48-method interface ISP violation, per-domain sub-interface plan, polymorphic repository plan.
- [Daemon graceful shutdown](../../nexus/reference/daemon-graceful-shutdown-and-orphan-reaper-plan.md) — `storage.close()` flush path, WAL recovery lifecycle, startup orphan reaper.
- [Layer-direction audit](../../nexus/reference/layer-direction-audit-enforcement-plan.md) — import-direction gates that keep storage a bottom-layer leaf.
- [Module coupling governance](../../nexus/reference/module-coupling-decoupling-and-re-aggregation-plan.md) — Phase 9 Stream G: repository extraction from `SqliteStorage`, coupling heat map.
- [Memory governance](../../nexus/reference/memory-governance-plan.md) — storage authority model (SQLite session events are authoritative for what BabeL-O did).
