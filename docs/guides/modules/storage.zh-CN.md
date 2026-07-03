# Storage

> 模块参考 · 稳定公开契约 · 底层持久化，提供 SQLite 与内存双后端、Repository 模式与异步 WAL 崩溃恢复

[English](storage.md)

## 角色

Storage 是底层持久化模块。它拥有 `NexusStorage` 接口（48 方法 / 10 域）、
`SqliteStorage` 后端（`node:sqlite` `DatabaseSync`，WAL 模式，schema version 15，
约 10 张表，8 个已抽取的 Repository）以及 `MemoryStorage` 后端（`Map` +
`structuredClone`，48 方法全部内联实现）。Nexus 在 `createDefaultNexusRuntime`
中编排 storage；`storageBridge`（`src/nexus/storageBridge.ts`）提供异步 WAL
持久化队列（JSONL 格式，`replayWal` 崩溃恢复，`flushWalBuffer` 周期性落盘），
将事件写入与同步 SQLite I/O 解耦。

## 公开契约

- **`NexusStorage`**（`src/storage/Storage.ts`）— 规范 48 方法异步接口，覆盖
  sessions、events、tasks、agent jobs、tool traces、session channels +
  messages、permission audits、execution metrics、loop panes。每个后端均实现
  全部 48 方法。带可选 `close()` 用于优雅关停。
- **`SqliteStorage`**（`src/storage/SqliteStorage.ts`）— 生产后端。在给定路径
  打开 `DatabaseSync`；构造时创建表并运行 schema 迁移（v1–v15）。WAL 日志模式
  （`PRAGMA journal_mode = WAL`）。内联的 session、tool-trace、audit 操作正
  逐步抽取为域 Repository；当前已部署 8 个 Repository（`EventRepository`、
  `TaskRepository`、`AuditRepository`、`ToolTraceRepository`、
  `SessionChannelRepository`、`AgentJobRepository`、
  `ExecutionMetricsRepository`、`LoopPaneRepository`），各接收 `DatabaseSync`。
- **`MemoryStorage`**（`src/storage/MemoryStorage.ts`）— 内存后端，用于测试和
  临时运行。所有方法基于 `Map` + `structuredClone`。无 Repository，48 方法
  全部内联实现。
- **`storageBridge`**（`src/nexus/storageBridge.ts`）— Nexus 拥有的异步 WAL
  持久化层。`persistTaskSessionMutation` / `persistNexusTask` 将操作入队；
  `flushStorageBridge` 排空队列并刷写 WAL 缓冲区。启动时 `replayWal` 重放
  未确认的 JSONL 记录以恢复崩溃前未完成的操作。WAL 路径在 `createRuntime.ts`
  的 `configureStorageBridgeWal` 中组装。
- **`close()`** — `SqliteStorage.close()` 调用 `this.db.close()`。优雅关停
  路径（`server.ts` 中的 SIGTERM/SIGINT handler）先调用 `storage.close()` 刷
  写 `storageBridge`，再关闭数据库句柄。

## 允许的依赖

Storage 位于依赖图最底层，仅可导入 `src/shared/`（事件、session、task、trace
类型）。层方向审计（`npm run deps:audit`，接入 CI）强制执行：

- Storage **不得** 导入 `nexus`、`runtime`、`cli` 或 `clients`。
- Storage **不得** 导入 `tools`、`providers` 或 `mcp`。

反向方向（`nexus → storage`、`runtime → storage`）是允许且预期的：20 条
`nexus → storage` 边中 19 条为 `import type { NexusStorage }`，仅组合根
（`createRuntime.ts`）导入具体后端。

参见
[层方向审计](../../nexus/reference/layer-direction-audit-enforcement-plan.md)
与
[Storage 接口分离](../../nexus/reference/storage-interface-segregation-reference.md)
了解 canonical-shape 不变式与 ISP 修复计划。

## 扩展点

- **为 storage 添加新域** — 在 `src/storage/` 中创建新的 Repository 类（遵循
  `EventRepository` / `TaskRepository` 模式），在 `NexusStorage` 中添加域方法，
  在 `SqliteStorage`（通过新 Repository）和 `MemoryStorage`（内联）中实现。
  在 `SqliteStorage` 构造函数中注册 Repository。此路径还需添加 schema 迁移
  （递增 `PRAGMA user_version`）。
- **添加新 storage 后端** — 在新类中实现 `NexusStorage`。当前用于测试
  （`MemoryStorage`）和临时运行。
- **storageBridge WAL** — WAL 路径按 storage-bridge 实例配置。JSONL schema
  （`2026-05-24.storage-bridge-wal.v1`）支持 `op` 和 `ack` 记录类型；
  `replayWal` 在启动时重新入队未确认的操作。新增操作类型需向
  `PersistOperationPayload` 添加变体。

## 相关治理文档

- [Storage 接口分离](../../nexus/reference/storage-interface-segregation-reference.md) — 48 方法接口 ISP 违规、按域拆分子接口计划、多态 Repository 计划。
- [Daemon 优雅关停](../../nexus/reference/daemon-graceful-shutdown-and-orphan-reaper-plan.md) — `storage.close()` 刷写路径、WAL 恢复生命周期、启动孤儿 reaper。
- [层方向审计](../../nexus/reference/layer-direction-audit-enforcement-plan.md) — 确保 storage 作为底层叶模块的导入方向门。
- [模块耦合治理](../../nexus/reference/module-coupling-decoupling-and-re-aggregation-plan.md) — Phase 9 Stream G：从 `SqliteStorage` 抽取 Repository、耦合热力图。
- [Memory 治理](../../nexus/reference/memory-governance-plan.md) — storage 权威模型（SQLite session events 对"BabeL-O 做过什么"具有权威性）。
