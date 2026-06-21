# Long-Running Context Assembly — 设计文档

> State: Active Plan
> Track: Long-running Context / Working Set / Resume Pack
> Priority: P1 Watch
> Source of truth: [../TODO.md](../TODO.md), [../active/TODO_runtime.md](../active/TODO_runtime.md), [../DONE.md](../DONE.md), [../WORK_LOG.md](../WORK_LOG.md), `src/runtime/contextAssembler.ts`, `src/runtime/contextAnalysis.ts`, `src/runtime/workingSet*`, `src/runtime/loadWorkingSetOverride.ts`, `src/runtime/applyWorkingSetUpdate.ts`, `src/nexus/contextBroadcaster.ts`, `src/nexus/workingSetBroadcaster.ts`, `src/nexus/routers/sessionResumePreviewRouter.ts`, `clients/go-tui/internal/loop/api/context_observer.go`, `clients/go-tui/internal/loop/context_observer.go`
> Governance: Indexed by [context-governance-index.md](./context-governance-index.md). This document owns long-running context assembly planning; current implementation truth remains in runtime code and tests.

> 状态（2026-06-20 收盘 + 2026-06-21 doc lifecycle 迁移）：R0/R1/R2/R3/R4/R5/R6/R7 全部收口，本 plan 已从 `proposals/` 迁移到 `reference/` 并升级到 `Active Plan`。**R0**（storage 注入 + continuity 接线）、**R1**（cwd drift 治理）、**R2**（persisted working set 接入 executeStream hot path，含独立 `loadWorkingSetOverride.ts` + `applyWorkingSetUpdate.ts` 模块）、**R3**（REST PUT ↔ `/v1/working-set/observe` 共享 broadcaster tracker）、**R4**（`/v1/context/observe` 真实 runtime e2e + redacted payload by default）、**R5**（resume preview as product path，`LLMCodingRuntime.resumePreview()` + `/v1/sessions/:sessionId/resume-preview` route，`hasContinuationSnapshot: false` 硬编码）、**R6**（Go TUI runtime-owned rendering——`api/context_observer.go` + `loop/context_observer.go` 默认开启，订阅 `/v1/context/observe` + reconnect 2s→5s→15s backoff，`ContextObservation` state 由 observer 事件单向驱动，`FormatCtxObservationLine` 在 not-observed/connected/disconnected/full-mode/null-context 五条路径上提供文案兜底）全部关闭并有 focused regression。**R7** Replay Gate 全部关闭：c1-c3 + c4 + c4' + c5 + c6（cwd drift / continuity / context tool storage / working-set hot path / REST-PUT 共享 / resume preview / observer redacted e2e）**全部关闭**。
> 范围：利用 Nexus 常驻能力，重新设计上下文组装架构，支持 session/task 长时间持久运行
> 替代：旧"压缩 = 上下文管理"模型，升级为"Nexus 组装 = 上下文管理"
> Governance: Indexed by [context-governance-index.md](../reference/context-governance-index.md). This document owns working-set, resume, assembly, and long-running session state; it does not supersede compact or memory governance.

**落地清单**（按 PR）：

| Phase | 内容 | PR | 日期 |
|---|---|---|---|
| Phase 1 | WorkingSetTracker in-memory | PR-4a | 2026-06-14 |
| Phase 1 | WorkingSetTracker persistence | PR-4b | 2026-06-14 |
| Phase 2 | contextTools (3 pure fns) | PR-7 | 2026-06-15 |
| Phase 2 | contextTools ToolRegistry | PR-8 | 2026-06-15 |
| Phase 2 | CLI `bbl context working-set` | PR-9 | 2026-06-15 |
| Phase 2 | CLI `bbl context history` | PR-10 | 2026-06-15 |
| Phase 2 | REST `/v1/context/history` | PR-11 | 2026-06-15 |
| Phase 2 | REST `/v1/context/working-set` + `:sessionId` | PR-12 | 2026-06-15 |
| Phase 2 | CLI `bbl context resume` (dry-run) | PR-13 | 2026-06-15 |
| Phase 3 | CLI `bbl context assemble` | PR-15 | 2026-06-16 |
| Phase 3 | REST `POST /v1/context/assemble` | PR-18 | 2026-06-16 |
| Phase 3 | REST `GET /v1/context/working-set/workspace/:wsId` | PR-20 | 2026-06-16 |
| Phase 3 | WorkingSetTracker event bus（`working_set_updated`） | PR-26 | 2026-06-17 |
| Phase 3 | WebSocket `/v1/working-set/observe` + shared broadcaster | PR-27 | 2026-06-17 |
| Phase 3 | CLI `bbl context working-set-edit`（write op, 用户批准 2026-06-17） | PR-19 | 2026-06-17 |
| Phase 3 | `ContextAssemblerOptions` include* flags + `resumeSession()` helper | PR-28a/28b | 2026-06-17 |
| Phase 3 | `WorkingSetTracker.applyEvent` + `getWorkspaceWorkingSet` | PR-30 | 2026-06-17 |
| Phase 3 | `liveHints` section reads `behavior-trace.jsonl` (nexus 5min) | PR-31 | 2026-06-17 |
| Phase 3 | `projectMemory` section reads `.babel-o/memory.md` | PR-32 | 2026-06-17 |

**当前真实状态（2026-06-18 audit）**：
- ✅ 已有 primitives：`WorkingSetTracker` / `PersistedWorkingSetTracker`、`assembleContext()`、CLI preview、REST GET/PUT/assemble endpoints、`/v1/working-set/observe`、`/v1/context/observe` skeleton、`LLMCodingRuntime.resume()`。
- ⚠️ 未闭环：正常 `LLMCodingRuntime.executeStream()` 没有把 `PersistedWorkingSetTracker` 的 working set 作为 `workingSetOverride` 注入 active context；`/v1/working-set/observe` 与 REST PUT 没有共享同一个 tracker mutation path；`/v1/context/observe` 需要 real-runtime e2e 证明而不是只靠 simulated publish；context recall tools 被 Phase C2 storage propagation bug 阻断。
- ❌ 真实 session 证据不支持“session 重启后 0 信息丢失 / working set 始终在 active context / 跨 session working set 共享已生产可用”的结论。`session_981cc5c2`、`session_cf361f04`、`session_10320709` 均没有持久化 `working_set_updated` / `assembled` 事件；`contextSearch` / `contextRecent` 多次返回 `CONTEXT_STORAGE_UNAVAILABLE`；`session_root_continuity` 在这些样本中为 0。

**剩余项（2026-06-18 audit 快照，2026-06-20 收盘后全部关闭）**：
- ✅ R0/R1 prerequisite：[context-cwd-drift-and-recall-governance-plan.md](../reference/context-cwd-drift-and-recall-governance-plan.md) Phase C2 storage propagation + Nexus continuity wiring 已收口。
- ✅ R2：persisted working set 接入正常 `executeStream` hot path，每个成功工具事件后安全更新 / flush / inject。
- ✅ R3：REST PUT 与 `/v1/working-set/observe` 共享 broadcaster tracker，真实 REST→WS e2e 已落。
- ✅ R4：`/v1/context/observe` 通过真实 runtime execution e2e 验证 assembled frame。
- ✅ R5：bounded assembled-context observer payload + `redactContext('summary')` 默认；`?full=1` opt-in。
- ✅ R6：Go TUI 只消费 runtime-owned observer facts（`/v1/context/observe` 客户端 + state-machine test 全套落地）。

---

## 0. 术语与边界

| 术语 | 含义 |
|---|---|
| **Working Set** | session 当前任务的"心智状态"；目标态是进入 active context 且永不被 microcompact，当前生产热路径闭环见 §19 / §20 |
| **Recent Context** | session 最近 N 个事件——按 token 预算切片注入 |
| **On-Demand Context** | 按需拉取的历史 / 长期记忆 / 项目记忆——不进 active context，只返回值 |
| **ContextAssembler** | Nexus 端模块，负责组装三层 context |
| **WorkingSetTracker** | Nexus 端模块，追踪每 session 的 working set |
| **Session Resume** | session 重启 / 恢复时，从 Nexus 重建 working set |
| **microcompact** | 轻量压缩（去重 / 截断），不写边界事件 |
| **Behavior Trace** | `.babel-o/behavior-trace.jsonl`（见 behavior-monitor.md） |

**边界**：
- 不动 Plan C 长期记忆（`MemoryProvider` 协议化重构）
- 不动 behavior monitor（独立模块）
- 不动 `compact.ts`（保留为 hard compact 路径，用户触发）
- 不动 `.babel-o/memory.md`（项目级手动维护）
- `sessionMemoryLite.ts` 的 `natural_pause` 决策路径**已退役 (2026-06-20, ADR-5 retired)**；5-reason contract 收敛为 `disabled / duplicate_turn / growth_threshold / forced / insufficient_signal`

---

## 1. 背景与动机

### 1.1 现状

**单 session 上下文管理的 4 个痛点**（用户原始反馈）：

1. **压缩太激进**：`natural_pause` 每 user 轮都写 `session-memory.md`，体感"几乎每次都在压"
2. **长时 session 上下文丢失**：几小时 / 几天任务，重要信息被压掉
3. **session 重启上下文断裂**：用户切换 / 崩溃后回来，模型不记得刚才在干啥
4. **跨 session 协同困难**：同一 workspace 多个 session 状态不一致

### 1.2 根因诊断

```
旧模型：session = state owner
├─ session 自己管自己的事件流
├─ session 自己决定何时压缩
├─ session 自己写摘要（natural_pause）
└─ session 死了 = 状态全没
```

**关键错误**：把"上下文管理"和"session 生命周期"绑在一起。session 是临时的，状态应该是持久的。

### 1.3 重新理解

```
新模型：Nexus = state owner, session = view
├─ Nexus 持久化所有事件 / 行为轨迹 / 长期记忆
├─ Nexus 维护 per-session working set
├─ session = Nexus 的一个"窗口"
├─ session 重启 = 重新 attach 到 Nexus state
└─ 多个 session 可共享同一 workspace working set
```

**核心洞察**：**session 死了，状态没死**。context 不是"积累"出来的，而是"组装"出来的。

---

## 2. 目标与非目标

### 2.1 目标

| ID | 目标 | 验收 |
|---|---|---|
| G1 | 目标态：Working set 始终进入 active context，**永不被 microcompact** | R2/R7 集成测试：100 turn 后 persisted working set 仍完整并进入 provider-visible context |
| G2 | 目标态：session 重启后上下文可重建，升级为"0 信息丢失"前必须有真实 replay 证据 | R5/R7 resume 测试：working set / recent / continuity 完整重建并标明不可恢复缺口 |
| G3 | Active context 永不超过 budget | 单测：budget 超时自动 microcompact |
| G4 | 历史可查不需全装 | on-demand 工具测试：`context.search` / `context.summarize` |
| G5 | 跨 session 共享 working set | R3/R6/R7 多 session 集成测试：A 改动 → B 收到 runtime-owned 通知 |
| G6 | natural_pause 体感消失 | 用户报告：每 user 轮不再看到"压缩"提示 |
| G7 | 零默认 LLM 成本 | 写入路径全部 extractive / rule-based |

### 2.2 非目标

| ID | 不做 |
|---|---|
| N1 | 不替代 Plan C 长期记忆 |
| N2 | 不替代 behavior monitor |
| N3 | 不内嵌 LLM 推理（用现有 provider） |
| N4 | 不实现"自动 compact"（只发 hint） |
| N5 | 不动 `compact.ts`（hard compact 保留） |
| N6 | 不动 `.babel-o/memory.md` |
| N7 | 不复活自动 model selection |

---

## 3. 架构总览

### 3.1 三层上下文模型

```
┌──────────────────────────────────────────────────────────┐
│  Layer 1: Working Set（目标态：始终进入 active context） │
│  ├─ 当前 task scope / 活跃文件 / 当前目标                  │
│  ├─ 始终注入，**永不压缩**                                │
│  ├─ 由 Nexus WorkingSetTracker 维护                       │
│  └─ 容量：~1-2k tokens                                   │
├──────────────────────────────────────────────────────────┤
│  Layer 2: Recent Context（最近 N 个事件）                 │
│  ├─ 最近 1-2 小时的 relevant 事件                         │
│  ├─ 注入到 active context（受 token 预算约束）             │
│  ├─ 由 Nexus 从 event store 切片 + microcompact          │
│  └─ 容量：~2-10k tokens                                  │
├──────────────────────────────────────────────────────────┤
│  Layer 3: On-Demand Context（按需拉取）                   │
│  ├─ 工具调用：context.search / context.summarize          │
│  ├─ 行为轨迹：context.trace(scope, since)                 │
│  ├─ 长期记忆：context.ltm(query)                          │
│  ├─ **不进 active context**，只返回值                      │
│  └─ 容量：不限（只返回需要的）                            │
└──────────────────────────────────────────────────────────┘
```

### 3.2 架构图

```
                    ┌─────────────────────────────────────┐
                    │         Nexus（长时常驻）             │
                    │                                     │
                    │  ┌─────────────────────────────┐   │
                    │  │ ContextAssembler (新)       │   │
                    │  │  - assemble(scope, budget)  │   │
                    │  │  - microcompact             │   │
                    │  └─────────────────────────────┘   │
                    │                                     │
                    │  ┌─────────────────────────────┐   │
                    │  │ WorkingSetTracker (新)      │   │
                    │  │  - per-session working set  │   │
                    │  │  - rebuild from event tail  │   │
                    │  │  - always injected          │   │
                    │  └─────────────────────────────┘   │
                    │                                     │
                    │  ┌─────────────────────────────┐   │
                    │  │ BehaviorMonitor (有)        │   │
                    │  │  - cross-session patterns   │   │
                    │  │  - live hints               │   │
                    │  └─────────────────────────────┘   │
                    │                                     │
                    │  ┌─────────────────────────────┐   │
                    │  │ LongTermMemory (Plan C)     │   │
                    │  │  - preferences / facts      │   │
                    │  └─────────────────────────────┘   │
                    │                                     │
                    │  ┌─────────────────────────────┐   │
                    │  │ EventStore (SqliteStorage)  │   │
                    │  │  - full event history       │   │
                    │  │  - indexed by sessionId     │   │
                    │  └─────────────────────────────┘   │
                    │                                     │
                    │  ┌─────────────────────────────┐   │
                    │  │ .babel-o/behavior-trace     │   │
                    │  │ .jsonl (持久化轨迹)         │   │
                    │  └─────────────────────────────┘   │
                    └────────────────┬────────────────────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              │                      │                      │
              ▼                      ▼                      ▼
      ┌──────────────┐        ┌──────────────┐        ┌──────────────┐
      │  session A   │        │  session B   │        │  session C   │
      │  (active)    │        │  (resuming)  │        │  (idle)      │
      │              │        │              │        │              │
      │  active ctx: │        │  asks Nexus  │        │  state saved │
      │  working set │        │  to rebuild  │        │  on Nexus    │
      │  + recent    │        │  working set │        │              │
      │  + on-demand │        │  + recent    │        │              │
      └──────────────┘        └──────────────┘        └──────────────┘
```

### 3.3 数据流：新 turn 触发

```
新 turn 触发（来自 session 内部或外部）
    │
    ▼
ContextAssembler.assemble({scope: 'standard', maxTokens: 8k})
    │
    ├─→ WorkingSetTracker.get(sessionId)         [Layer 1, ~1.5k tokens]
    │      │
    │      ▼
    │   pinned sections
    │
    ├─→ EventStore.recentEvents(sessionId, 1h)    [Layer 2, ~3k tokens]
    │      │
    │      ▼
    │   microcompact(recentEvents)                // 去重 / 截断
    │      │
    │      ▼
    │   选 last N 件进 active context
    │
    ├─→ (if includeBehaviorTrace)  BehaviorTrace.recent(since: 24h) → 摘要 [~1k]
    │
    ├─→ (if includeLongTerm)       longTermMemory.search(query=intent) [~1k]
    │
    ├─→ (if includeProjectMemory)  .babel-o/memory.md [~0.5k]
    │
    ▼
AssembledContext { sections, budget, meta }
    │
    ▼
注入到 model context
```

---

## 4. 数据模型

### 4.1 Working Set schema

```typescript
// src/nexus/workingSetTracker.ts
type WorkingSet = {
  sessionId: string
  workspaceId: string         // 跨 session 共享键
  version: number              // 每次更新 +1
  updatedAt: string            // ISO 8601

  // Task 状态
  task: {
    title: string              // 1 行
    scope: string[]            // 声明的文件路径
    currentGoal: string        // 1-2 行
    completedSteps: string[]   // 最近 5 步
  }

  // 活跃文件（带使用频次）
  activeFiles: Array<{
    path: string
    touches: number            // 读写次数
    lastTouch: string
    pinned: boolean            // true = 永不被 microcompact 掉
  }>

  // 当前 session 的"心智状态"
  currentIntent: 'implementing' | 'debugging' | 'refactoring' | 'exploring' | 'reviewing' | 'idle'
  pendingDecisions: Array<{
    question: string
    options: string[]
    chosen?: string
  }>

  // 重建元数据
  rebuildSource: 'event_tail' | 'manual' | 'inherited'
  lastEventRev: number
}
```

### 4.2 Context Section schema

```typescript
// src/nexus/contextAssembler.ts
type ContextSection = {
  kind: 'workingSet' | 'recentEvents' | 'behaviorTrace' | 'longTerm' | 'project' | 'liveHint'
  content: string              // 已格式化的 markdown / 结构化
  tokens: number               // 估算
  pinned: boolean              // true = 永不被压缩 / 必注入
  source: string               // 溯源（debug 用）
}

type AssembledContext = {
  sessionId: string
  scope: 'minimal' | 'standard' | 'full' | 'task' | 'workspace'
  sections: ContextSection[]   // 顺序：pinned first, then by priority
  budget: {
    used: number
    max: number
    overflow: 'drop' | 'microcompact' | 'none'
    droppedSections: ContextSection[]
  }
  meta: {
    workingSetVersion: number
    lastEventRev: number
    traceEntriesConsidered: number
    assembledAt: string
    assembleLatencyMs: number
  }
}
```

### 4.3 Scope 语义

| scope | 包含 | 适用场景 |
|---|---|---|
| `minimal` | 仅 working set | /compact 后 / 极限 budget（< 2k） |
| `standard` | working set + recent events | **默认**新 turn |
| `full` | + behavior trace 摘要 + long-term + project | /compact 边界 / 显式 reset |
| `task` | 仅当前 task 相关 | 多 task 切换时 |
| `workspace` | + 跨 session 数据 | session 重启 / 恢复 |

### 4.4 容量预算

| Layer | 默认容量 | 优先级 | pinned | 状态 |
|---|---|---|---|---|
| Working Set | 1500 tokens | 1（最高） | ✅ | ✅ PR-15/18 |
| Recent Events | 3000 tokens | 2 | ❌ | ✅ PR-15/18 |
| Behavior Trace 摘要 | 1000 tokens | 3 | ❌ | ✅ PR-15/18 |
| Long-Term Memory | 1000 tokens | 4 | ❌ | ⏸ Plan C deferred, 需 MemoryProvider |
| Project Memory | 500 tokens | 5 | ❌ | ✅ PR-32 (CLI/REST preview 读 `.babel-o/memory.md`) |
| Live Hints | 500 tokens | 6（动态） | ❌ | ✅ PR-31 (CLI/REST preview 读 behavior-trace nexus 5min) |
| **总计** | **7500 tokens**（max 8000） | | |

**溢出处理**：超 budget → `microcompact` 缩减 Layer 2 → 仍超 → 砍 Layer 3 → 仍超 → 报错（不静默丢 pinned）。

---

## 5. Nexus 端模块

### 5.1 WorkingSetTracker

**文件**（2026-06-20 audit：tracker 真实实现已迁移到 runtime 目录，nexus 路径退化为 facade）：
- 内存版：`src/runtime/workingSetTracker.ts`（370 行，真实实现）
- 持久化版：`src/runtime/persistedWorkingSetTracker.ts`（154 行，extends 内存版）
- 兼容 facade：`src/nexus/workingSetTracker.ts` / `src/nexus/persistedWorkingSetTracker.ts`（各 3 行 `export *`，仅供未迁移的 legacy 导入路径使用，不要再加新逻辑）
- Hot-path 写入辅助：`src/runtime/applyWorkingSetUpdate.ts`（83 行，executeStream 成功工具事件 → tracker）
- Hot-path 加载辅助：`src/runtime/loadWorkingSetOverride.ts`（118 行，executeStream 起手 load + format → workingSetOverride）

**状态**：✅ 内存版 + 持久化版均已落地（PR-4a + PR-4b, 2026-06-14；2026-06 后期迁移到 `src/runtime/`，nexus 旧路径变 facade），CLI 3 个子命令 (working-set/history/resume) 已落地 (PR-9/10/13, 2026-06-15), REST 3 个 endpoint (list/get/workspace-aggregate) 已落地 (PR-11/12/20, 2026-06-15/16)。✅ event bus (`WorkingSetEventBus`, `working_set_updated` 事件) 已落地 (PR-26, 2026-06-17)，WebSocket `/v1/working-set/observe` 推送已落地 (PR-27, 2026-06-17)。✅ `applyEvent` 事件驱动更新已落地 (PR-30, 2026-06-17)，`getWorkspaceWorkingSet` workspace 聚合已落地 (PR-30, 2026-06-17)。✅ R2 hot-path 写/读两路分别由 `applyWorkingSetUpdate.ts` / `loadWorkingSetOverride.ts` 模块拥有（PR-R2 落地, 2026-06-18+）。

**职责**：
- 维护每 session working set（内存 + 持久化）
- 监听 `tool_started` / `task_created` / `scope_boundary_*` 事件自动更新
- 提供 `get / update / rebuild / share` API
- 跨 session 通过 `workspaceId` 共享
- 通过 event bus 推送 `working_set_updated` / `working_set_reset` 事件 (PR-26)

**核心 API**（实际实现, src/runtime/workingSetTracker.ts）：

```typescript
class WorkingSetTracker {
  // ─── 读 ───
  get(sessionId: string): WorkingSet | null
  has(sessionId: string): boolean
  entries(): Array<[string, WorkingSet]>
  size(): number

  // ─── 写 (in-memory) ───
  update(sessionId: string, patch: WorkingSetPatch): WorkingSet     // 自动 emit working_set_updated
  rebuild(sessionId: string, workspaceId: string, entries: WorkingSetEntry[]): WorkingSet
  reset(sessionId: string): void                                       // 自动 emit working_set_reset
  applyEvent(sessionId: string, event: NexusEvent, cwd: string): WorkingSet | null  // 事件驱动 (PR-30)

  // ─── 跨 session workspace 聚合 (PR-30) ───
  linkToWorkspace(sessionId: string, workspaceId: string): void
  unlinkFromWorkspace(sessionId: string, workspaceId: string): void
  sessionsInWorkspace(workspaceId: string): string[]
  workspaceCount(): number
  getWorkspaceWorkingSet(workspaceId: string): WorkingSet | null       // 聚合所有 session entries

  // ─── Event Bus (PR-26) ───
  subscribe(handler: WorkingSetEventHandler): () => void               // 返回 unsubscribe
  subscriberCount(): number

  // ─── 派生 (PR-4a 内部) ───
  deriveEntriesFromEvents(events: NexusEvent[], cwd: string): WorkingSetEntry[]  // 自由函数
}
```

**持久化路径**（src/runtime/persistedWorkingSetTracker.ts，extends WorkingSetTracker）：

```typescript
class PersistedWorkingSetTracker extends WorkingSetTracker {
  async load(): Promise<void>                  // 整个文件 → 内存, 无 sessionId 参数
  async flush(): Promise<void>                 // 整个文件 → 磁盘, 替代 doc 的 per-session persist
  get fileLocation(): string                   // 调试用
}
```

**注意 (与早期 doc 草稿差异)**：
- `applyEvent` 多 `cwd` 参数（PR-30 落地, 用于过滤文件路径）
- `rebuild` 接收 `workspaceId` + `entries` 而非 `fromEventTail`（PR-4a; caller 自己 derive）
- 持久化是 file-level（`load()` / `flush()`）而非 per-session

**持久化路径**：`<cwd>/.babel-o/working-set.json`（per-cwd，因为 workspace 跟 cwd 绑定）

### 5.2 ContextAssembler

**文件**：
- Runtime 版本：`src/runtime/contextAssembler.ts`（实际 ~700 行，含 `assembleContext()` 入口 + 完整 budget 分配）
- CLI/REST preview 版本：`src/nexus/contextAssemblePreview.ts`（**独立模块**，PR-25 提取后）。提供 `buildAssemblePreview()` + 6 个 `build*Section` builder 函数

**状态**：✅ runtime `assembleContext` 已落地（Phase 1/2），CLI preview 已落地（PR-15, 2026-06-16），REST endpoint 已落地（PR-18, 2026-06-16），4 个 `include*` flags 已落地（PR-28a, 2026-06-17）。CLI/REST preview 5/6 层真实读 (Long-Term 仍 stub, Plan C deferred)。

**职责**：
- 接收 assemble 请求
- 拉 working set（pinned）
- 拉 recent events + microcompact
- 拉可选 layer 3 源（behaviorTrace / longTerm / projectMemory / liveHints）
- 预算管理
- 输出 AssembledContext

**核心 API**（**实际实现**，**自由函数**而非 class method）：

```typescript
// ─── Runtime 入口 (src/runtime/contextAssembler.ts) ───
export async function assembleContext(
  options: ContextAssemblerOptions
): Promise<AssembledContext>

// ─── 预算分配 (PR-4a) ───
export function allocateBudget(modelId: string): ContextBudget

// ─── Memory 截断 (PR-4a) ───
export function truncateMemoryContent(raw: string): MemoryTruncation
```

**`ContextAssemblerOptions` (实际类型, src/runtime/contextAssembler.ts)**：

```typescript
type ContextAssemblerOptions = {
  runtimeOptions: RuntimeExecuteOptions         // 含 sessionId, cwd, prompt, signal 等
  events: NexusEvent[]                          // 预先查好的事件流 (caller 负责 fetch)
  modelId: string
  buildSystemPrompt: (options, projectMemory?, sessionSummary?, activeSkills?) => string
  mapEventsToMessages: (events, initialPrompt) => ModelMessage[]
  memoryProvider?: MemoryProvider
  sessionInbox?: SessionMessage[]
  workingSetOverride?: string                   // PR-4a: 跳过 derive, 用传入的字符串
  // PR-28a: 4 个 include flags (默认 undefined = 当前行为)
  includeBehaviorTrace?: boolean
  includeLongTerm?: boolean
  includeProjectMemory?: boolean
  includeLiveHints?: boolean                     // flag exists; hot-path forwarding/consumption tracked by R2/R4/R6
}
```

**CLI/REST preview builder (src/nexus/contextAssemblePreview.ts)**：

```typescript
// 一次性产出全部 sections + budget + meta
export async function buildAssemblePreview(
  options: AssemblePreviewOptions
): Promise<AssembledContextPreview>

// 单 section builder (doc 早期提到的 get*Section 在这里是同名函数, 但不是 class method)
function buildWorkingSetSection(wsVersion, entries): AssembledSection
function buildRecentEventsSection(sessionId, traces): AssembledSection
function buildBehaviorTraceSection(traces): AssembledSection
function buildLongTermStub(): AssembledSection                  // stub, Plan C deferred
async function buildProjectSection(cwd): AssembledSection       // PR-32
function buildLiveHintSection(traces, cooldownMs=5min): AssembledSection  // PR-31
```

**AssemblePreviewOptions (CLI/REST 简化版, PR-15 落地)**：

```typescript
type AssemblePreviewOptions = {
  cwd: string
  sessionId?: string
  scope: 'minimal' | 'standard' | 'full' | 'task' | 'workspace'
  maxTokens: number
  includeBehaviorTrace?: boolean
  includeLongTerm?: boolean
  includeProjectMemory?: boolean
  includeLiveHints?: boolean
}
```

**注意 (与早期 doc 草稿差异)**：
- 实际是**自由函数**, 不是 `class ContextAssembler { assemble() }`
- 5 个 `get*Section` **不存在作为 class method**; 实际是 `contextAssemblePreview.ts` 里的独立 builder 函数
- `AssembleOptions` (doc 简版) vs `ContextAssemblerOptions` (实际) 字段完全不同, 实际 API 用 `runtimeOptions + events + modelId`, doc 简版只用 `sessionId + workspaceId + scope`

### 5.3 microcompact（轻量压缩）

**文件**：`src/runtime/compactors/microCompact.ts`（137 行；2026-06-20 audit：实际路径在 `runtime/compactors/`，非早期 doc 草稿想象的 `src/nexus/microcompact.ts`）

**导出**：`microcompactEvents(events, budget)` / `microcompactEventsWithMetrics(events, budget)`（自由函数，不是 class method）；`budget.microcompactToolOutputChars` 控制截断阈值（与 doc 草稿写死 4k/2k 不同，由 `allocateBudget(modelId)` 动态分配）。

**职责**：对 recent events 数组做轻量压缩，**不写边界事件**，**不丢事件**。

**操作**：
- **去重**：`tool_started` + `tool_completed` 同 `toolUseId` 只留 `tool_completed`（去 `tool_started` 噪音）
- **截断**：`tool_completed` 输出 > 4k chars → 截到 2k + 标记 `truncated: true`
- **聚合**：连续 `assistant_delta` 合并为单条（已是 `assistant_text` 的话）
- **去噪音**：过滤 `permission_response` 等非内容事件

**与 hard compact (`compact.ts`) 区别**：

| 维度 | microcompact | hard compact |
|---|---|---|
| 写边界事件 | ❌ | ✅ `compact_boundary` |
| 丢老事件 | ❌ | ✅ |
| 触发 | 每次 assemble | 显式 / 撞墙 |
| 频率 | 每次新 turn | 罕见 |
| 代价 | O(n) 纯字符串 | O(n) + 持久化 |

---

## 6. Session 端集成

### 6.1 LLMCodingRuntime 集成点

**改动**：`src/runtime/LLMCodingRuntime.ts`（~50 行）

```typescript
// 在 turn 入口处
async startTurn(opts) {
  // 旧：直接构造 context
  // 新：从 Nexus 拉 assembled context
  const assembled = await this.nexus.contextAssembler.assemble({
    sessionId: opts.sessionId,
    scope: 'standard',
    maxTokens: 8000,
    includeBehaviorTrace: true,
    includeLongTerm: true,
    includeProjectMemory: true,
    includeLiveHints: true,
  })

  // 注入到 model context
  for (const section of assembled.sections) {
    this.injectSystemSection(section)
  }

  // ... 后续 turn 逻辑
}
```

### 6.2 Session Resume 流程

**状态**：✅ **落地** (2026-06-17)。PR-A4 添加 `LLMCodingRuntime.resume({ sessionId, cwd })` class method (`src/runtime/LLMCodingRuntime.ts:1210-`)。**R5 (2026-06-20)** 在同一文件 (`:1358-`) 追加 `LLMCodingRuntime.resumePreview({ sessionId, cwd })` 纯 read-only projection — 走 `loadWorkingSetOverride` + `assembleContext`（含 `includeLiveHints: false`），不订阅 hint、不写状态、不真正 resume provider；返回 `{ cwd, workingSet, assembledSectionIds, budget, liveHintsSubscribed: false, hasContinuationSnapshot: false }`，由 `src/nexus/routers/sessionResumePreviewRouter.ts` (88 行) 暴露为 `POST /v1/sessions/:sessionId/resume-preview`。`resumeSession()` 独立 helper (`src/runtime/sessionResume.ts`, PR-28b) 保留为 legacy 路径, CLI/REST 后续迁移到 class method. 完整 `resume()` 细节:
- step 1: `workingSetTracker.load()` + `get(sessionId)`; 不存在时从 `storage.listEvents` 拉事件尾并 `rebuild(sessionId, '', deriveEntriesFromEvents(events, cwd))`.
- step 2: 调 `refreshRuntimeContextState(...)` 走 full `assembleContext` pass; 带 `workingSetOverride` + 4 个 `include*` flags (`includeLiveHints: !!behaviorMonitor`).
- step 3: `behaviorMonitor.subscribe(sessionId, hint => ...)` 监听 live hints; `canAcceptHint` + `injectSystemSection` 是 runtime 侧的 no-op stub (INV-4: 不静默注入到 model prompt).
- production: `createDefaultNexusRuntime()` 自动 wire `resumeDeps` (per-cwd `PersistedWorkingSetTracker` + `BehaviorMonitor` + 闭包). Explore agent (`AgentScheduler.ts`) 不动 — 它是 short-lived.

```typescript
// src/runtime/LLMCodingRuntime.ts  (PR-A4, 2026-06-17 已落地)
async resume(opts: { sessionId: string; cwd: string }) {
  if (!this.resumeDeps) {
    throw new Error('resume() requires resumeDeps; configure via createDefaultNexusRuntime()')
  }
  const { workingSetTracker, behaviorMonitor, buildSystemPrompt, mapEventsToMessages } =
    this.resumeDeps

  // 1. 从持久化加载 working set（不存在则从事件流重建）
  await workingSetTracker.load()
  let workingSet = workingSetTracker.get(opts.sessionId)
  let rebuilt = false
  let events: NexusEvent[] = []
  if (!workingSet) {
    rebuilt = true
    const result = await this.storage.listEvents(opts.sessionId, { order: 'desc', limit: 1000 })
    events = [...(result?.events ?? [])].reverse() // ascending for assembler
    const entries = deriveEntriesFromEvents(events, opts.cwd)
    workingSet = workingSetTracker.rebuild(opts.sessionId, '', entries)
  } else {
    const result = await this.storage.listEvents(opts.sessionId, { order: 'desc', limit: 1000 })
    events = [...(result?.events ?? [])].reverse()
  }

  // 2. 拉全 workspace context（full assembleContext pass）
  const settings = this.configManager.resolveSettings()
  const runtimeOptions: RuntimeExecuteOptions = {
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    prompt: '',
    model: settings.modelId,
  }
  const workingSetOverride = formatWorkingSet(/* map entries to shape */)
  const refreshState = await refreshRuntimeContextState({
    runtimeOptions,
    events,
    modelId: settings.modelId,
    buildSystemPrompt,
    mapEventsToMessages,
    tools: () => [],
    warningPercent: 70,
    compactPercent: 90,
    suppressToolsForIntent: () => false,
    memoryProvider: this.memoryProvider,
    sessionInbox: [],
    workingSetOverride,
    includeBehaviorTrace: true,
    includeLongTerm: true,
    includeProjectMemory: true,
    includeLiveHints: !!behaviorMonitor,
  })
  const assembled = refreshState.assembledContext

  // 3. 订阅 live hints（resume 完成后才开）
  let unsubscribeHints = (): void => { /* no-op when no monitor */ }
  if (behaviorMonitor) {
    unsubscribeHints = behaviorMonitor.subscribe(opts.sessionId, (hint) => {
      if (this.canAcceptHint()) {
        const text = formatHint(hint)
        this.injectSystemSection(text, opts.sessionId)
      }
    })
  }

  return { workingSet, rebuilt, assembled, unsubscribeHints }
}
```

### 6.3 跨 Session Working Set

```typescript
// 同 workspaceId 的 session 共享 working set
class WorkingSetTracker {
  private workspaceIndex = new Map<string, Set<string>>()  // workspaceId → sessionIds

  linkToWorkspace(sessionId: string, workspaceId: string) {
    if (!this.workspaceIndex.has(workspaceId)) {
      this.workspaceIndex.set(workspaceId, new Set())
    }
    this.workspaceIndex.get(workspaceId)!.add(sessionId)
  }

  // 通知所有同 workspace session
  private broadcastChange(workspaceId: string, ws: WorkingSet) {
    const sessions = this.workspaceIndex.get(workspaceId) ?? new Set()
    for (const sid of sessions) {
      // 通过 SessionChannel 推送 ws update 事件
      this.eventBus.emit({ type: 'working_set_updated', sessionId: sid, ws })
    }
  }
}
```

---

## 7. 工具与 API

### 7.1 on-demand 工具（model 主动调用）

> **状态**（2026-06-20 Bug 1.1 修复后修订）：✅ 4 个 tool 双层落地：**数据层** 4 个纯函数 (`searchEvents` / `summarizeWindow` / `recentEvents` / `searchSessionsMetadata`) 在 `src/tools/contextTools.ts` (PR-7, 2026-06-15; cross-session metadata search 补于 2026-06-20)；**builtin tool wrapper** 4 个独立模块 `src/tools/builtin/contextSearch.ts` / `contextSummarize.ts` / `contextRecent.ts` / `contextSessions.ts` 注册到 ToolRegistry (PR-8, 2026-06-15; `contextSessions` 补于 2026-06-20)。CLI `bbl context history` (PR-10) 复用 `searchEvents` / `summarizeWindow`。REST `/v1/context/history` (PR-11) 同样复用。R0 (storage propagation) 收口后，`contextSearch` / `contextRecent` / `contextSessions` 在 storage-backed runtime 不再返回 `CONTEXT_STORAGE_UNAVAILABLE`。

**Bug 1.1 修复缘由（2026-06-20，session_ea4f1793 真实回归）**：原始 3 工具的 `contextSearch` / `contextRecent` 只能搜索/读取**当前 session 的事件流**——当用户问"列出最近 5 个 session 的 ID 与 lastUserInput"时，模型用 `contextSearch{query: "sessionId lastUserInput"}` 命中 0 结果（因为只在当前 session 内搜），随后在 `assistant_delta` 里编造"无法获取，需要 sqlite3 查询"的 fallback 回答。新工具 `contextSessions` 直接走 `storage.listSessions()` 跨 session 元数据搜索，弥补这条缺口。session_816269a1 真实验证：模型一次 `contextSessions{limit:5}` 返回正确的 5 session 列表。

新增 4 个 tool（数据层 `src/tools/contextTools.ts` + builtin wrapper `src/tools/builtin/context*.ts`）：

| 工具 | 用途 | 拉取源 | 范围 |
|---|---|---|---|
| `context.search(query, since?)` | 全文搜索过往事件 | EventStore | 单 session |
| `context.summarize(scope, since?)` | 抽取某时段的摘要 | behavior-trace.jsonl | 单 session |
| `context.recent(n)` | 最近 N 个事件 | EventStore | 单 session |
| `context.sessions(query?, cwd?, phase?, sinceMs?, limit?)` | 跨 session 元数据搜索 | `storage.listSessions()` | 全部 sessions |

**示例**：
```typescript
// 模型调用
const result = await context.search({
  query: "sessionMemoryLite natural_pause 修改",
  since: "24h"
})
// 返回：相关事件 + 来源溯源
```

**关键不变量**：
- 这些工具**不进入** active context，只返回值
- 调用本身有成本（检索 + 摘要），但模型按需触发
- 单次调用最大 5k tokens 返回

### 7.2 CLI 子命令

`bbl context` 命令族扩展：

| 命令 | 功能 | 状态 |
|---|---|---|
| `bbl context show` | 现有：显示当前 context | ✅ 已有（`bbl sessions show`） |
| `bbl context assemble --scope <s>` | **新**：手动触发组装并显示 | ✅ 已落地（PR-15, 2026-06-16） |
| `bbl context working-set` | **新**：显示当前 session working set | ✅ 已落地（PR-9, 2026-06-15） |
| `bbl context working-set --edit` | **新**：手动编辑 working set | ✅ 已落地（PR-19, 2026-06-17, 用户显式批准 write op） |
| `bbl context history --since 24h` | **新**：拉历史事件 + 摘要 | ✅ 已落地（PR-10, 2026-06-15） |
| `bbl context resume` | **新**：模拟 resume 流程（debug） | ✅ 已落地（PR-13, 2026-06-15） |

### 7.3 REST + WebSocket

**Router 拓扑**（2026-06-20 audit 补：路由实现已拆到 `src/nexus/routers/` 子目录，每条路由独立模块）：
- `contextAssembleRouter.ts` — POST `/v1/context/assemble`
- `contextWorkingSetReadRouter.ts` — GET working-set / workspace
- `contextWorkingSetWriteRouter.ts` — PUT working-set（R3 走 `WorkingSetBroadcaster.mutate`）
- `contextHistoryRouter.ts` — GET `/v1/context/history`
- `contextObserveRouter.ts` — WS `/v1/context/observe`（R4 redacted summary 默认）
- `sessionResumePreviewRouter.ts` — POST `/v1/sessions/:sessionId/resume-preview`（R5）
- WS `/v1/working-set/observe` 由 `WorkingSetBroadcaster` 直接挂到 app（不在独立 router 文件）

**新增 REST**：

| 路径 | 方法 | 功能 | 状态 |
|---|---|---|---|
| `/v1/context/assemble` | POST | 手动触发组装（带 options） | ✅ 已落地（PR-18, 2026-06-16） |
| `/v1/context/working-set` | GET | 列所有 session 的 working set | ✅ 已落地（PR-12, 2026-06-15） |
| `/v1/context/working-set/:sessionId` | GET | 读单个 session 的 working set | ✅ 已落地（PR-12, 2026-06-15） |
| `/v1/context/working-set/:sessionId` | PUT | 写 working set | ✅ 已落地（R3 收口, 2026-06-18, `WorkingSetBroadcaster.mutate(cwd, fn)` 让 PUT 与 `/v1/working-set/observe` 共享 per-cwd tracker） |
| `/v1/context/working-set/workspace/:wsId` | GET | 读 workspace 共享 working set（聚合） | ✅ 已落地（PR-20, 2026-06-16） |
| `/v1/context/history` | GET | 拉历史事件（带过滤） | ✅ 已落地（PR-11, 2026-06-15） |
| `/v1/sessions/:sessionId/resume-preview` | POST | resume read-only projection（R5） | ✅ 已落地（R5, 2026-06-20, `src/nexus/routers/sessionResumePreviewRouter.ts`） |

**新增 WebSocket**：

```
// /v1/working-set/observe — working set 变更推送（PR-27, 已落地）
{ type: 'working_set_updated', sessionId, ws }   // ✅ WorkingSetTracker event bus → shared broadcaster → WS fan-out（PR-26 + PR-27；REST PUT 共享 tracker/e2e 见 R3）

// /v1/context/observe — assembled context 实时推送（R4 收口, 2026-06-20）
{ type: 'assembled', sessionId, context }         // ✅ `redactContext` 默认 summary 模式（剥离 systemPrompt + messages）, `?full=1` opt-in verbatim; 真实 `executeStream` e2e 见 `test/r4-context-observe-runtime-e2e.test.ts`
```

---

## 8. 压缩策略的降级

### 8.1 新定位

在 Nexus 常驻模型下，**压缩不再是上下文管理的命脉**——它是"budget 紧时的优化工具"。

### 8.2 三类压缩的关系

```
┌────────────────────────────────────────────────────────┐
│  microcompact（高频，每 turn）                          │
│  ├─ 触发：ContextAssembler.assemble() 时                │
│  ├─ 行为：去重 / 截断 recent events                    │
│  └─ 代价：O(n) 纯字符串，不写事件                      │
├────────────────────────────────────────────────────────┤
│  hard compact（低频，用户触发 / Nexus 提示）            │
│  ├─ 触发：/compact 命令 / Nexus 发 live hint 建议     │
│  ├─ 行为：完整 compact_boundary + 写 behavior-trace   │
│  └─ 代价：O(n) + 持久化                                │
├────────────────────────────────────────────────────────┤
│  ~~natural_pause~~（已退役 2026-06-20, ADR-5 retired） │
│  ├─ 历史：每 user 轮触发 → 写 session-memory.md      │
│  ├─ 退役原因：信号源被 working set + behaviorTrace    │
│  │            (`trajectory-end` / `user-redirect`) 接管 │
│  └─ 治理护栏：INV-11 跨 5 处源码/test 保留          │
└────────────────────────────────────────────────────────┘
```

### 8.3 hard compact 的改进

```typescript
// compact.ts 改
const compactResult = await compact({...})

// 同步写 behavior-trace（与硬压缩同步）
await writeBehaviorTraceEntry({
  trigger: 'forced',
  reason: 'compact',
  anomaly: { errorCode: 'CONTEXT_COMPACT' },
  context: extractContextFromEvents(omittedEvents),
  selfAssessment: deriveRuleSelfAssessment('forced', ...),
})
```

**好处**：compact 事件**也是**行为轨迹的一部分——审计完整、跨 session 可查。

### 8.4 Nexus 主动 hint 阈值

```typescript
// behaviorMonitor.ts
if (session.tokenUsageRatio > 0.8 && !session.lastCompactHintAt) {
  hintDispatcher.dispatch({
    type: 'behavior_hint',
    pattern: 'context-near-limit',
    suggestedAction: 'consider /compact',
    confidence: 0.9,
  })
}
```

**关键不变量**：**never auto-compact**——只发 hint，不实际 compact。

---

## 9. 与现有系统关系

| 现有系统 | 关系 |
|---|---|
| **Plan C 长期记忆** | Layer 3 `longTerm` 来源——通过 `longTermMemory.search(query=intent)` 接入 |
| **behavior monitor** | 平行模块——行为轨迹是 Layer 3 `behaviorTrace` 来源 + 跨 session 提示 |
| **`compact.ts`** | 保留 hard compact 路径——被 ContextAssembler 的 `overflow` 触发 |
| **`sessionMemoryLite.ts`** | 保留模块——`forced` 给 hard compact 用；`growth_threshold` 改成 microcompact 触发；`natural_pause` 已退役 (2026-06-20, ADR-5)，5-reason contract 收敛为 `disabled / duplicate_turn / growth_threshold / forced / insufficient_signal` |
| **`.babel-o/memory.md`** | Layer 3 `project` 来源——通过 `loadProjectMemory(cwd)` 接入 |
| **`everCoreRuntimeManager`** | 复用——WorkingSetTracker 通过其租约机制持久化 |

---

## 10. 配置与默认值

| env var | 默认 | 含义 |
|---|---|---|
| `BABEL_O_CONTEXT_ASSEMBLY_ENABLED` | `true` | 总开关 |
| `BABEL_O_CONTEXT_MAX_TOKENS` | `8000` | active context 总预算 |
| `BABEL_O_CONTEXT_WORKING_SET_TOKENS` | `1500` | Layer 1 容量 |
| `BABEL_O_CONTEXT_RECENT_TOKENS` | `3000` | Layer 2 容量 |
| `BABEL_O_CONTEXT_TRACE_TOKENS` | `1000` | Layer 3 behaviorTrace 容量 |
| `BABEL_O_CONTEXT_LONG_TERM_TOKENS` | `1000` | Layer 3 longTerm 容量 |
| `BABEL_O_CONTEXT_PROJECT_TOKENS` | `500` | Layer 3 project 容量 |
| `BABEL_O_CONTEXT_LIVE_HINT_TOKENS` | `500` | Layer 3 liveHint 容量 |
| `BABEL_O_CONTEXT_RECENT_WINDOW_MS` | `3600000` | 1 hour |
| `BABEL_O_CONTEXT_TRACE_WINDOW_MS` | `86400000` | 24 hour |
| `BABEL_O_CONTEXT_COMPACT_HINT_RATIO` | `0.8` | token usage 比例触发 compact hint |
| `BABEL_O_CONTEXT_CROSS_SESSION` | `true` | 跨 session working set 共享 |

---

## 11. 测试策略

> **2026-06-20 audit 注**：本节列出的预期测试文件名与仓库现状不完全一致。真实分布如下；新增段（R0-R7）有独立 focused regression 见 §20。

### 11.1 WorkingSetTracker 测试

- `test/working-set-tracker.test.ts` + `test/working-set-tracker-apply-event.test.ts` + `test/working-set-tracker-persist.test.ts`（三件套，分别覆盖核心 API / `applyEvent` / 持久化）
- 覆盖：applyEvent / get / update / rebuild / persist / load / share

### 11.2 ContextAssembler 测试

- `test/context-assembler.test.ts`
- 覆盖：5 个 scope / budget overflow / microcompact / Layer 3 各源 / 顺序保证

### 11.3 microcompact 测试

- 合并到 `test/context-assembler.test.ts`（无独立 `test/microcompact.test.ts`，导入 `microcompactEvents` / `microcompactEventsWithMetrics` 直接 assert）
- 覆盖：去重 / 截断 / 聚合 / 噪音过滤

### 11.4 Session Resume 测试

- `test/session-resume.test.ts`（resume() class method）
- `test/inspect-session-resume.test.ts`（CLI inspect-session resume 路径）
- `test/r5-resume-preview.test.ts`（R5 read-only projection + REST route）
- 覆盖：working set 重建 / context 恢复 / live hint 订阅 / preview 不真正 resume

### 11.5 跨 Session / 实时观察测试

- `test/working-set-event-bus.test.ts`（PR-26 event bus）
- `test/working-set-observe-websocket.test.ts`（PR-27 WS 推送）
- `test/context-observe-websocket.test.ts`（observer skeleton）
- `test/r3-rest-put-observe.test.ts`（R3 REST PUT ↔ WS 共享 tracker）
- `test/r4-context-observe-runtime-e2e.test.ts`（R4 真实 runtime e2e + redacted）
- 覆盖：workspace 共享 / 事件广播 / 状态一致性 / redacted payload

### 11.6 端到端集成

- `test/r7-replay-gate.test.ts`（15/15，对 3 个 fixture session SQLite 关门）
- 目标态场景：100 turn 模拟 → working set 不丢 / 重启后上下文可重建 / budget 不超；升级为"0 信息丢失"前必须通过 R7 real replay gate
- **测试隔离**（[[babel-o-test-config-isolation]]）：tmp dir / 强制 `:memory:` storage

### 11.7 CLI 表面

- `test/context-cli.test.ts` + `test/context-assemble-cli.test.ts` + `test/context-history-cli.test.ts` + `test/context-resume-cli.test.ts` + `test/context-working-set-edit-cli.test.ts`（拆分到每个子命令一个 spec 文件）

**测试隔离总则**（[[babel-o-test-config-isolation]]）：所有持久化路径强制 tmp，working-set.json / behavior-trace.jsonl 都用 tmp dir。

---

## 12. 不变量与红线

| ID | 不变量 | 价值 |
|---|---|---|
| INV-L1 | **Working set 永不被压缩** | 当前任务状态绝对保留 |
| INV-L2 | **Session 死了状态没死** | 重启无缝恢复 |
| INV-L3 | **Active context 永远 ≤ budget** | 不撞墙 |
| INV-L4 | **历史可查不需全装** | token 高效 |
| INV-L5 | **跨 session 共享 working set** | 多 session 协同 |
| INV-L6 | **Live hint 补充不替代** | 主动 + 按需 双轨 |
| INV-L7 | **never auto-compact** | 用户拍板 |
| INV-L8 | **microcompact 不写事件** | 不污染事件流 |
| INV-L9 | **working set ≤ 2k tokens** | 不爆 budget |
| INV-L10 | **resume 时间 ≤ 3s** | 不阻塞用户 |
| INV-L11 | **Pinned sections 永不被砍** | 透明度可预测 |
| INV-L12 | **on-demand 工具不进 active context** | 上下文不污染 |

---

## 13. 迁移路径

> **2026-06-20 audit 注（natural_pause retired）**：本节为原始迁移规划保留，**Phase 1/2 实际已落地**（具体 PR 见 §18.5 历史记录），**Phase 4/5 已被 §20 R0-R7 跟进计划取代** — 真实推进以 §20 为准；2026-06-20 `natural_pause` decision branch 已**退役**（ADR-5 retired，见 §14）：5-reason contract 收敛为 `disabled / duplicate_turn / growth_threshold / forced / insufficient_signal`，对应信号由 working set + behaviorTrace (`trajectory-end` / `user-redirect`) 接管；测试同步删除/改写，INV-11 注释保留为治理护栏。本节路径与 §18 落地清单 + §20 R0-R7 行计划交叉对照阅读，不要按本节字面顺序执行。

### Phase 1: WorkingSetTracker + ContextAssembler 上线（已落地, PR-4a/4b/15/18 / 2026-06-14~16）
- 实际位置：`src/runtime/workingSetTracker.ts` / `src/runtime/contextAssembler.ts` / `src/runtime/compactors/microCompact.ts`（非原计划的 `src/nexus/*.ts`）
- `LLMCodingRuntime.executeStream()` hot-path 注入 working set 在 R2 (2026-06-18) 收口
- **新模型启用，原 natural_pause 路径已退役**（ADR-5 retired 2026-06-20）

### Phase 2: on-demand 工具 + Session Resume（已落地, PR-7/8 + PR-A4 + PR-30 / 2026-06-15~17）
- 已新增 `context.search / summarize / recent` 3 工具（数据层 + builtin wrapper）
- `LLMCodingRuntime.resume()` 已实现 (PR-A4) + `resumePreview()` (R5, 2026-06-20)
- 跨 session working set 共享 (`linkToWorkspace` / `getWorkspaceWorkingSet` PR-30)

### Phase 4: 跨 Session 协同 + 时间窗 context（全部落地）
- 多 session working set 广播 ✅（PR-26/27 event bus + WS）
- "show me last 24h" 完整命令 ✅（`bbl context history --since` / `/v1/context/history`，PR-10/11）
- `bbl context` 子命令全套 ✅（PR-9/10/13/15/19）
- Go TUI 渲染侧 ✅（§20 R6 收口: `context_observer.go` + `FormatCtxObservationLine` 5 状态）

### Phase 5: behavior monitor 接入（全部落地）
- 行为轨迹作为 Layer 3 `behaviorTrace` 来源 ✅（PR-31 liveHints + nexus 5min）
- Live hints 增强 ✅ Go TUI 渲染 ✅（PR-17a/17b StatusBehaviorHint chrome 渲染 + §20 R6 context_observer 完整消费）

---

## 14. ADR 决策记录

### ADR-1: Nexus = state owner, session = view

**Context**: 旧模型把上下文管理绑在 session 生命周期上，导致 session 死了状态就死。

**Decision**: 重新设计——Nexus 持有持久状态，session 是 Nexus 的 view。

**Consequences**:
- (+) session 重启无缝恢复
- (+) 长时 session/task 持久运行成为可能
- (+) 跨 session 协同简单
- (-) 状态归属权转移——session 失去部分自主性
- (-) Nexus 端责任增加

### ADR-2: 三层上下文模型（Working Set + Recent + On-Demand）

**Context**: 单层"积累历史"模型无法支持长时运行。

**Decision**: 三层模型——Working Set 始终在 / Recent 按 budget 切片 / On-Demand 拉取。

**Consequences**:
- (+) Working set 永不丢
- (+) Active context 永远可控
- (+) 历史可查不需全装
- (-) 复杂度增加（3 个独立模块）
- (-) 容量预算需要精细调优

### ADR-3: microcompact vs hard compact 分工

**Context**: 旧模型只有 hard compact（cost 高、频次低、不灵活）。

**Decision**: 拆为两层——microcompact（高频、轻量、不写事件）+ hard compact（低频、显式、写边界）。

**Consequences**:
- (+) 每 turn 都能做轻量优化
- (-) 两个压缩路径需要清晰边界
- (-) microcompact 行为必须可预测（INV-L8）

### ADR-4: Working Set 在 active context 永远 pinned

**Context**: Working set 是"心智状态"，丢任何一部分都意味着 session 失去连续性。

**Decision**: Working set 永不被压缩 / 永不被砍 / 容量上限 2k tokens。

**Consequences**:
- (+) 任务连续性绝对保证
- (-) Working set 内容必须严格控量
- (-) 需要严格的更新逻辑避免膨胀

### ADR-5: natural_pause 退役 (Retired 2026-06-20)

**Context (history)**: 用户最初反馈"natural_pause 太激进"——`natural_pause` 在每个非工具 user 轮自动写 `session-memory.md`，体感"几乎每次都在压"。P0 (2026-06-14, PR-1) 加 `BABEL_O_NATURAL_PAUSE_SUPPRESS` env flag 默认压制换得短期缓解；ADR-5 承诺"待 P0/P1/P2 完成后看实际数据再决定删除 / opt-in / 保留"。

**Decision (retired 2026-06-20)**: 删除 `natural_pause` 决策分支 + `BABEL_O_NATURAL_PAUSE_SUPPRESS` env flag + `SessionMemoryLiteReason` enum 对应值 + `shared/events.ts` zod schema 对应值。5-reason contract 收敛为 `disabled / duplicate_turn / growth_threshold / forced / insufficient_signal`。原信号源（每轮非工具轨迹切片）由 working set + behaviorTrace 的 `trajectory-end` / `user-redirect` 触发器接管。`behaviorTrace.ts` / `behaviorMonitor.ts` / `behaviorTraceTap.ts` / `LLMCodingRuntime.ts` / `behavior-trace.test.ts` 5 处 `INV-11: do not revive natural_pause` 注释**保留**为治理护栏——禁止任何后续 commit 复活该分支。

**Consequences**:
- (+) 移除 30+ 行 dormant branch + 1 个 env flag + 1 个 enum value
- (+) 5-reason contract 测试覆盖完整（`growth_threshold` / `forced` / `duplicate_turn` / `disabled` / `insufficient_signal` 各自有独立断言）
- (+) 治理债收敛：INV-11 注释从"延后决策"变为"主动护栏"
- (-) 旧 fixture 含 `decisionReason: 'natural_pause'` 的事件需改用 `growth_threshold`（已在 test 中改写）
- (-) 不再有"每 user 轮自动压缩"的合法路径——working set + behaviorTrace 100% 接管

### ADR-6: on-demand 工具不进 active context

**Context**: 模型主动拉取历史的工具，不能污染 active context。

**Decision**: `context.search / summarize / recent` 只返回值，不进 context。

**Consequences**:
- (+) 上下文纯度保证
- (-) 模型需要显式调用

### ADR-7: 跨 session working set 通过 workspaceId

**Context**: 同 workspace 多个 session 需要协同。

**Decision**: 通过 `workspaceId` 共享 working set + 事件广播。

**Consequences**:
- (+) 多 session 协同可行
- (-) workspaceId 必须是稳定标识（默认 cwd，但允许 override）

---

## 15. 改动预算

| 阶段 | 模块 | 行数 | 工期 | 优先级 |
|---|---|---|---|---|
| **P0** | env flag 压制 | ~10 | 0.5 天 | 🔴 |
| **P1.a** | `workingSetTracker.ts` | ~300 | 1.5 天 | 🔴 |
| **P1.b** | `contextAssembler.ts` | ~400 | 2 天 | 🔴 |
| **P1.c** | `microcompact.ts` | ~200 | 0.5 天 | 🔴 |
| **P1.d** | `LLMCodingRuntime` 集成 | +50 | 0.5 天 | 🔴 |
| **P1.e** | 测试 | ~600 | 1 天 | 🔴 |
| **P2.a** | `contextTools.ts` 3 工具 | ~250 | 1.5 天 | 🟡 |
| **P2.b** | `LLMCodingRuntime.resume()` | ~200 | 1 天 | 🟡 |
| **P2.c** | 跨 session 共享 | ~150 | 1 天 | 🟡 |
| **P2.d** | 测试 | ~500 | 1.5 天 | 🟡 |
| **P3** | ~~natural_pause 清理~~（已退役 2026-06-20，见 ADR-5） | — | — | ✅ |
| **P4** | `bbl context` 扩展 | ~250 | 1.5 天 | 🟢 |
| **P5** | behavior monitor 接入 | ~200 | 1.5 天 | 🟢 |
| **总计** | | **~3160 行 / 14.5 工作日** | | |

---

## 16. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| Working set 膨胀超 2k | 中 | 中 | INV-L9 + 严格 update 逻辑 + `bbl context working-set --edit` 手动修剪 |
| microcompact 改变事件语义 | 低 | 高 | INV-L8（不写事件）+ 完整 unit test + diff 模式 |
| resume 慢 (>3s) | 中 | 中 | 工作集已持久化 + cache + INV-L10 硬约束 |
| 跨 session 同步冲突 | 中 | 中 | workspaceId 锁 + 乐观更新 + 冲突日志 |
| ~~与 natural_pause 双轨混乱~~ | — | — | 已退役 (2026-06-20, ADR-5 retired)；5-reason contract + INV-11 护栏收口 |
| Layer 3 各源失败 | 中 | 中 | 单源失败降级到标准 scope，不阻塞 turn |

---

## 17. 开放问题

1. **Working set 持久化策略**：每 session 一个 json 文件？还是共享 sqlite 表？→ P1.a 决策
2. **跨 session 共享粒度**：所有 session 共享？按 task 共享？→ P2.c 决策
3. **microcompact 是否计入 trace**：microcompact 改了 events 数组但没写事件，trace 看到的还是原始 events。是否需要写 `microcompact_summary` 到 trace？→ P1.c 决策
4. **on-demand 工具权限**：模型主动调用 `context.search` 是否需要 approval？→ P2.a 决策
5. ~~P0 完成后 natural_pause 数据~~（已退役 2026-06-20，ADR-5）：旧 `.babel-o/session-memory.md` 文件保留现状，不主动迁移；用户 `bbl context` 命令族可读；自动迁移会污染事件流。

---

## 18. 历史 Follow-up Register（2026-06-18 audit 后以 §19 / §20 为准）

本节保留 2026-06-17 的执行登记，用于追溯。2026-06-18 源码 + session reality audit 后，后续执行以 §19 / §20 的 R0-R7 为准。

### 18.1 Server-side (Track A) gated / deferred

| 编号 | 项目 | 阻塞 | 建议 |
|---|---|---|---|
| **A1** | `PUT /v1/context/working-set/:sessionId` (write op REST) | Route 已存在，但当前 REST PUT mutation path 与 `/v1/working-set/observe` broadcaster tracker 不是同一条共享路径；需要 R3 证明 REST write → persisted file → WS event → GET 一致 | Follow R3 |
| **A2** | WebSocket `/v1/context/observe` (`assembled` 事件) | Route + broadcaster + runtimePipeline publish hook 已存在，但 primary e2e 仍偏 skeleton/manual publish；需要真实 `executeStream()` 触发、redacted payload 默认值和 reconnect snapshot 验证 | Follow R4 |
| **A3** | `Long-Term Memory` section (CLI/REST preview 第 4 层) | Runtime MemoryProvider capability 已存在；CLI/REST preview 的长期层仍不得成为新事实源，继续由 memory governance 管 | 不在 Track A 扩权 |
| **A4** | §6.2 `LLMCodingRuntime.resume()` class method (含 step 2 + 3) | `LLMCodingRuntime.resume()` class method 已存在；缺的是产品/API 可观察 resume-preview 路径，以及对 `hasContinuationSnapshot=false` 的诚实表达 | Follow R5 |
| **A5** | §5.2 5 个 `get*Section` class methods (按早期 doc 草稿) | **不实现** (实际是 `contextAssemblePreview.ts` 的 builder 函数). PR-34b 已修正 doc | 已落定 (doc 修正) |

### 18.2 Go TUI (Track B) gated / deferred

| 编号 | 项目 | 阻塞 | 建议 |
|---|---|---|---|
| **B1** | PR-17c: Go TUI 订阅 `/v1/working-set/observe` WebSocket | 需在 `internal/loop/reconcile_worker.go` 加 WS 客户端. user 正在改 reconcile_worker (Phase 6'), 建议叠加而非冲突 | 显式说"做 PR-17c"后启动 |
| **B2** | Go TUI `StatusBehaviorHint` 已在 chrome 渲染 (PR-17b). **未做**: 通知气泡触发 "view_trace" action | 跨 Go repo, 需 `internal/loop/notifications/` | 独立 PR |

### 18.3 用户驱动 WIP（不在本 doc 推进范围）

| 编号 | 项目 | 状态 |
|---|---|---|
| **U1** | `clients/go-tui/internal/loop/phase6*_test.go` (3 个新 test 文件) | 用户未提交, WIP |
| **U2** | `clients/go-tui/internal/loop/transcript.go` + `transcript_events.go` | 用户未提交, WIP |
| **U3** | `clients/go-tui/internal/loop/wait_tick.go` + `wait_tick_test.go` (6c waitForEvent 长轮询) | 用户未提交, WIP |
| **U4** | `clients/go-tui/internal/loop/session_reachability_e2e_test.go` | 用户未提交, WIP |

**注**: U1-U4 是 Phase 6' 实时显示活跃 session 的 in-progress work. 跟本 doc 推进**无直接依赖**; 用户完成后再 commit 即可.

### 18.4 优先级建议

按 2026-06-20 audit 后的真实阻塞排序（**R0-R7 全部已收口**，**plan 等待 governance 把本文从 `proposals/` 迁到 `reference/` 后升级为 `Active Reference`**）：

1. ✅ **R0 storage propagation + continuity wiring** — 先让 context recall tools 在 storage-backed runtime 可用。（2026-06-18 收口：`test/runtime-storage-propagation.test.ts` 5/5）
2. ✅ **R1 CWD drift guard** — 避免 `/` / `~/Library` 这类污染根写进 persisted working set。（2026-06-18 收口：Bug 1 Layer A+B + Bug 4 + `test/resolve-cwd-fallback.test.ts` + `test/dual-site-resolver.test.ts`）
3. ✅ **R2 executeStream hot-path working-set injection** — 这是 Nexus-owned context 真正成立的核心。（2026-06-18 收口：`test/runtime-working-set-hot-path.test.ts` 7/7）
4. ✅ **R3 REST PUT + observe shared tracker** — 让手动编辑成为 live state。（2026-06-18 收口：`test/r3-rest-put-observe.test.ts` 6/6；PUT 走 `WorkingSetBroadcaster.mutate` 共享 per-cwd tracker）
5. ✅ **R4 real runtime `/v1/context/observe` e2e** — 用真实执行证明 assembled frame（2026-06-20 收口：`test/r4-context-observe-runtime-e2e.test.ts` 9/9；`redactContext` 默认 summary 模式，`?full=1` opt-in verbatim）
6. ✅ **R5 resume-preview product path** — 把 resume 从 class method 变成可观察能力（2026-06-20 收口：`test/r5-resume-preview.test.ts` 6/6；`LLMCodingRuntime.resumePreview` 纯 read-only projection + `/v1/sessions/:sessionId/resume-preview` route + `hasContinuationSnapshot: false` 硬编码）
7. ✅ **R6 Go TUI runtime-owned rendering** — TUI 只消费事实，不推导事实（2026-06-20 收口：`api/context_observer.go` + `loop/context_observer.go` 默认开启，订阅 `/v1/context/observe` redacted payload；`api/context_observer_test.go` 7/7 transport tests + `loop/context_observer_test.go` 7/7 state-machine tests with 15 subcases；S1-S5 五条状态机路径 + backoff + format helper 全部锁定）。
8. ✅ **R7 real session replay gate** — 用三个失败 session 关门验收（2026-06-20 收口：`test/r7-replay-gate.test.ts` 15/15）。

### 18.5 历史记录 (本 doc 推进已完成)

| 阶段 | 内容 | 状态 |
|---|---|---|
| Phase 1 | WorkingSetTracker in-memory + persistence | ✅ PR-4a/4b (2026-06-14) |
| Phase 2 | contextTools (3 pure fns) + ToolRegistry | ✅ PR-7/8 (2026-06-15) |
| Phase 2 | CLI working-set / history / resume | ✅ PR-9/10/13 (2026-06-15) |
| Phase 2 | REST history / working-set×3 / workspace-aggregate | ✅ PR-11/12/20 (2026-06-15/16) |
| Phase 3 | CLI bbl context assemble | ✅ PR-15 (2026-06-16) |
| Phase 3 | REST POST /v1/context/assemble | ✅ PR-18 (2026-06-16) |
| Phase 3 | WorkingSetTracker event bus (working_set_updated) | ✅ PR-26 (2026-06-17) |
| Phase 3 | WebSocket /v1/working-set/observe + shared broadcaster | ✅ PR-27 (2026-06-17) |
| Phase 3 | CLI bbl context working-set-edit (write op, 用户批准) | ✅ PR-19 (2026-06-17) |
| Phase 3 | WorkingSetTracker.applyEvent + getWorkspaceWorkingSet | ✅ PR-30 (2026-06-17) |
| Phase 3 | ContextAssemblerOptions include* flags | ✅ PR-28a (2026-06-17) |
| Phase 3 | resumeSession() helper (doc §6.2 partial) | ✅ PR-28b (2026-06-17) |
| Phase 3 | LLMCodingRuntime.resume() class method (3 steps) + BehaviorMonitor.subscribe + formatHint + createRuntime wire + doc fix | ✅ PR-A4 (2026-06-17) |
| Phase 3 | liveHints section reads behavior-trace.jsonl (nexus 5min) | ✅ PR-31 (2026-06-17) |
| Phase 3 | projectMemory section reads .babel-o/memory.md | ✅ PR-32 (2026-06-17) |
| Phase 3 | Doc 修正 + future work 列表 (本节) | ✅ PR-33/34 (2026-06-17) |
| Phase 3 | Go TUI StatusBehaviorHint 7th 态 + chrome 渲染 | ✅ PR-17a/17b (2026-06-17) |
| 修复 | tool-prompt regression (8 个 builtin tools 加 prompt) | ✅ PR-22 (2026-06-17) |
| 修复 | runtime-loop / runtime-llm pre-existing test | ✅ PR-23 (2026-06-17) |
| 修复 | buildAssemblePreview 提取 + caller 更新 | ✅ PR-25 (2026-06-17) |
| 修复 | liveHints section in runtime assembleContext | ✅ flag 落地；R4 (observer redacted e2e) + R6 (Go TUI consumer) 双侧收口 |
| 修复 | runtime-loop test 共享 storage isolation | ⏸ PR-24 stopped (3 approaches failed) |
| R0 收口 | storage 注入 + continuity wiring (Bug 2/3) + `runtime-storage-propagation.test.ts` 5/5 + `dual-site-resolver.test.ts` | ✅ PR-R0 (2026-06-18) |
| R1 收口 | Bug 1 Layer A (quote-delimited span) + Layer B (`isAcceptablePromptCwd`) + Bug 4 (dual cwd resolver 统一) | ✅ PR-R1 (2026-06-18) |
| R2 收口 | persisted working set 接入 `executeStream` hot path: `loadWorkingSetOverride.ts` (118 行) + `applyWorkingSetUpdate.ts` (83 行) + `runtime-working-set-hot-path.test.ts` 7/7 | ✅ PR-R2 (2026-06-18) |
| R3 收口 | REST PUT + `/v1/working-set/observe` 共享 per-cwd tracker via `WorkingSetBroadcaster.mutate(cwd, fn)` | ✅ PR-R3 (2026-06-18) |
| R4 收口 | `/v1/context/observe` 真实 `executeStream` e2e + `redactContext(ctx, mode='summary')` 默认剥离 systemPrompt+messages + `?full=1` opt-in | ✅ PR-R4 (2026-06-20) |
| R5 收口 | `LLMCodingRuntime.resumePreview()` + `/v1/sessions/:sessionId/resume-preview` route + `hasContinuationSnapshot: false` 硬编码 + `LocalCodingRuntime` 无能力 → 501 `RESUME_PREVIEW_UNSUPPORTED` | ✅ PR-R5 (2026-06-20) |
| R6 收口 | Go TUI runtime-owned rendering: `api/context_observer.go` (175 行 transport) + `loop/context_observer.go` (~590 行 state-machine) + `InteractiveModel.Init()` 默认启动 + `FormatCtxObservationLine` 5 状态兜底 + 14 个 Go test (7 transport + 7 state-machine with 15 subcases) | ✅ PR-R6 (2026-06-20) |
| R7 收口 | 真实 session replay gate: `r7-fixture.sqlite` (3 fixture sessions) + `r7-replay-gate.test.ts` 15/15; c1-c6 全关 | ✅ PR-R7 (2026-06-20) |

---

## 19. 2026-06-18 Reality Audit — Runtime Hot Path Not Yet Closed

This section supersedes the older "server side all landed" wording for execution planning. The primitives exist, but the user-visible promise is not yet true.

### 19.1 Source Audit Summary

Implemented primitives:

- `src/nexus/workingSetTracker.ts`
  - `WorkingSetTracker.get/update/rebuild/reset/subscribe`.
  - `applyEvent(sessionId, event, cwd)` derives file entries from `tool_started`.
  - `getWorkspaceWorkingSet(workspaceId)` aggregates entries across linked sessions.
- `src/nexus/persistedWorkingSetTracker.ts`
  - File-backed `<cwd>/.babel-o/working-set.json` persistence.
- `src/runtime/contextAssembler.ts`
  - `assembleContext()` builds system prompt, recent messages, microcompact metrics, dynamic budgets, working-set block, memory capability block, and diagnostics.
  - `workingSetOverride` exists, but is optional; when omitted the assembler derives a transient working set from the current event slice.
- `src/runtime/runtimePipeline.ts`
  - `refreshRuntimeContextState()` calls `assembleContext()` and publishes to the module-level context broadcaster.
- `src/nexus/app.ts`
  - REST GET/PUT working-set endpoints exist.
  - REST `POST /v1/context/assemble` exists.
  - `/v1/working-set/observe` exists.
  - `/v1/context/observe` exists.
- `src/runtime/LLMCodingRuntime.ts`
  - `resume()` exists and passes `workingSetOverride` during the resume-specific assemble pass.

Not closed:

- Normal `LLMCodingRuntime.executeStream()` does **not** load `PersistedWorkingSetTracker` or pass `workingSetOverride` into its hot-path `refreshRuntimeContextState()` calls.
- `refreshRuntimeContextState()` accepts `ContextAssemblerOptions` but currently forwards only runtime options, events, memory provider, and session inbox. It drops `workingSetOverride` / `include*` fields instead of forwarding the full option set.
- `WorkingSetTracker.applyEvent()` is not wired into the runtime event stream after successful tool execution.
- REST PUT creates a fresh `PersistedWorkingSetTracker`; `/v1/working-set/observe` subscribes to a broadcaster-owned tracker. Without shared mutation wiring, a REST PUT can persist to disk but not notify an already connected WS subscriber.
- `/v1/context/observe` has route + broadcaster mechanics, but current tests mainly simulate `publish()`. It still needs real `executeStream()` e2e proof.
- Context recall tools are blocked by Phase C2 storage propagation; a storage-backed session can persist events but still return `CONTEXT_STORAGE_UNAVAILABLE` to `contextSearch` / `contextRecent`.

### 19.2 Real Session Evidence

SQLite source: `~/.babel-o/db.sqlite`.

| Session | Events | Evidence |
| --- | ---: | --- |
| `session_981cc5c2-230c-40d1-953c-b956e9dbaaf7` | 19666 | `task_scope_declared` exists, but later turns drift to `/`; `contextSearch` first fails schema at `maxTokens=8000`, then `contextSearch` / `contextRecent` return `CONTEXT_STORAGE_UNAVAILABLE`; no `working_set_updated`, no persisted `assembled` event, no `session_root_continuity`. |
| `session_cf361f04-7ab1-43a5-907a-41a808942686` | 23678 | Scope drifts from project root to `/` and then `/Users/tangyaoyue/Library`; multiple `contextSearch` / `contextRecent` failures return `CONTEXT_STORAGE_UNAVAILABLE`; no `working_set_updated`, no persisted `assembled` event, no `session_root_continuity`. |
| `session_10320709-2b06-405f-8f51-d954435d4a70` | 15914 | First six `task_scope_declared` events use `/Users/tangyaoyue/Library`; three context tools fail with `CONTEXT_STORAGE_UNAVAILABLE`; no `working_set_updated`, no persisted `assembled` event, no `session_root_continuity`. |

Important interpretation:

- `context_usage` events prove runtime context estimation exists.
- `task_scope_declared` events prove task-scope declaration exists.
- They do **not** prove Nexus-owned working set is in active context.
- Missing persisted `assembled` events is expected for the current observer design, but it also means session history cannot currently audit what was broadcast.
- Missing `.babel-o/working-set.json` in the audited workspace paths means these sessions did not leave working-set persistence evidence.

### 19.3 Corrected Implementation Claim

The current implementation should be described as:

> Context assembly primitives, CLI/REST preview, working-set storage primitives, resume helper/method, and observer skeletons are partially landed. The production runtime hot path has not yet made persisted Nexus working set the authoritative active-context source, and real sessions do not yet prove zero-loss resume or cross-session working-set sharing.

Do not claim:

- "Track A server side fully landed."
- "Working set is always in active context" for production `executeStream`.
- "Session restart has zero information loss."
- "Cross-session working set sharing is production proven."
- "`/v1/context/observe` is fully validated" without real-runtime e2e.

---

## 20. Follow-up Execution Plan — Close The Long-Running Context Loop

### Phase R0 — Prerequisite: Storage Propagation And Continuity Wiring

**Goal**: Make context recall tools usable in storage-backed sessions and make session continuity events appear on real Nexus HTTP/WS turns.

Owner document:

- `docs/nexus/reference/context-cwd-drift-and-recall-governance-plan.md` §11 / §12.

Implementation:

- `src/runtime/LLMCodingRuntime.ts`
  - Normalize `RuntimeExecuteOptions.storage` from `this.storage` at the start of `runExecuteStreamInner`.
- `src/nexus/app.ts`
  - Add `storage: options.storage` to HTTP and WebSocket `runtime.executeStream()` calls.
  - Add `storedSessionCwd` and `latestTaskPrimaryRoot` to both execute paths.
- `src/runtime/runtimeToolLoop.ts`
  - Defensive merge before `executeToolSafely`: `storage: runtimeOptions.storage ?? options.storage`.

Tests:

- `test/runtime-storage-propagation.test.ts`
  - `LLMCodingRuntime` with `MemoryStorage`, omitted `RuntimeExecuteOptions.storage`, provider calls `contextRecent`; expected not `CONTEXT_STORAGE_UNAVAILABLE`.
  - runtimeToolLoop receives side-channel storage and preserves it into `ToolContext`.
  - no-storage registry still hides context tools.
- `test/nexus-runtime-wiring.test.ts`
  - HTTP execute path passes storage and continuity fields.
  - WS execute path passes storage and continuity fields.

Acceptance:

- Replaying a storage-backed regression fixture from `session_10320709` can call `contextRecent` successfully.
- New real run emits at least one `session_root_continuity` event when stored session metadata exists.
- No provider-visible context tool returns `CONTEXT_STORAGE_UNAVAILABLE` when the session has persisted events and storage is attached.

### Phase R1 — Stabilize CWD Drift Before Working-Set Persistence

**Goal**: Prevent bad prompt path extraction from writing polluted working-set roots such as `/Users/tangyaoyue/Library`.

Implementation:

- `src/runtime/systemPromptBuilder.ts`
  - Tighten dirname fallback for system/home directories.
  - Add guard for truncated iCloud-style 4-segment candidates.
- `src/runtime/sessionRootContinuity.ts`
  - Reject non-project-like prompt roots unless explicitly accepted.

Tests:

- `test/resolve-cwd-fallback.test.ts`
  - iCloud `Mobile Documents` prompt does not resolve cwd to `~/Library`.
  - existing project root remains accepted.
  - continuity decision keeps session/project root when prompt path is a system-directory fallback.

Acceptance:

- `session_cf361f04` / `session_10320709` style prompts no longer produce `/` or `~/Library` as task root.
- Working-set updates refuse paths outside current task root unless a scope-boundary confirmation exists.

### Phase R2 — Wire Persisted Working Set Into ExecuteStream Hot Path

**Goal**: Normal turns use Nexus-owned persisted working set, not only transient `deriveWorkingSet(events)`.

Implementation:

- `src/runtime/LLMCodingRuntime.ts`
  - Add a small helper, e.g. `loadWorkingSetOverride(sessionId, cwd)`.
  - Use `resumeDeps.workingSetTracker` when present:
    - load tracker once if needed;
    - get existing session working set;
    - if absent, rebuild from recent event tail with `deriveEntriesFromEvents`;
    - format as `workingSetOverride`;
    - pass `workingSetOverride` into every `refreshRuntimeContextState()` call.
  - Update tracker after successful tool events via `applyEvent()`, then flush.
  - Do not update on denied tools, failed parse-only pseudo calls, or out-of-scope paths.
- `src/runtime/runtimePipeline.ts`
  - Forward `workingSetOverride` and include flags into `assembleContext()` rather than dropping them.
- `src/nexus/createRuntime.ts`
  - Keep one per-cwd `PersistedWorkingSetTracker` in `resumeDeps`; document that this is the runtime working-set owner.

Tests:

- `test/runtime-working-set-hot-path.test.ts`
  - Existing `.babel-o/working-set.json` entry appears in the initial provider system prompt.
  - A successful `Read` / `Grep` / `Glob` path updates working set and persists it.
  - Failed or denied tool calls do not mutate working set.
  - Restarting runtime with same cwd reloads working set and injects it on the next turn.
  - Working-set block is bounded and stable.

Acceptance:

- A real run touching a workspace file creates `<cwd>/.babel-o/working-set.json`.
- Next turn includes a provider-visible `Working Set:` block derived from persisted tracker state.
- Working-set persistence is observable with `bbl context working-set`.

### Phase R3 — Unify REST PUT And Working-Set Observe

**Goal**: `PUT /v1/context/working-set/:sessionId` and `/v1/working-set/observe` operate on the same per-cwd tracker instance.

Implementation:

- `src/nexus/app.ts`
  - Change REST PUT helper path to accept an optional `WorkingSetBroadcaster` or tracker provider.
  - When app has `workingSetBroadcaster`, mutate `broadcaster.getOrCreateTracker(cwd).tracker` instead of a fresh tracker.
  - Flush after mutation.
- `src/nexus/workingSetBroadcaster.ts`
  - Add a helper like `mutate(cwd, fn)` that awaits load once, runs mutation, and flushes.

Tests:

- `test/context-working-set-rest-put.test.ts`
  - PUT persists and returns updated state.
  - PUT emits `working_set_updated` to a connected `/v1/working-set/observe` client.
  - Multiple subscribers receive the PUT event.

Acceptance:

- One e2e test proves REST write -> persisted file -> WS event -> GET reads same version.

### Phase R4 — Prove Context Observe With Real Runtime Execution

**Goal**: `/v1/context/observe` is not just a broadcaster skeleton; it receives assembled context from actual runtime turns.

Implementation:

- Keep `ContextBroadcaster.publish()` non-persistent and fire-and-forget.
- Add a redacted observer payload mode before exposing full context broadly:
  - full payload only for local/debug or explicit query flag;
  - default payload includes counts, budgets, section ids, and selected diagnostics, not full prompt text.

Tests:

- `test/context-observe-runtime-e2e.test.ts`
  - Start Nexus app with `LLMCodingRuntime` or deterministic runtime capable of calling `refreshRuntimeContextState`.
  - Connect `/v1/context/observe?cwd=...&sessionId=...`.
  - Execute one turn.
  - Assert `assembled` frame arrives from real runtime.
  - Reconnect and assert `assembled_snapshot` has the latest context summary.

Acceptance:

- No reliance on manual `defaultContextBroadcaster.publish()` for the primary e2e.
- Observer never blocks execution and cleans up subscribers.
- Redaction defaults are documented and tested.

### Phase R5 — Session Resume As Product Path, Not Only Unit Method

**Goal**: Make resume observable and usable from Nexus/CLI without pretending continuation snapshots exist.

Implementation:

- Add a read-only API such as `POST /v1/sessions/:sessionId/resume-preview` or integrate into existing inspect/context route.
- It should call `LLMCodingRuntime.resume()` or a pure projection equivalent and return:
  - working set loaded/rebuilt;
  - assembled section ids and budgets;
  - whether live hints were subscribed;
  - explicit `hasContinuationSnapshot: false` unless durable continuation is implemented.
- Do not resume provider execution automatically in this phase.

Tests:

- route returns rebuilt=false for pre-seeded working-set file.
- route returns rebuilt=true and derived entries for event-tail fixture.
- route never mutates unrelated sessions.

Acceptance:

- Operator can inspect what a resumed session would inherit.
- Docs stop saying "0 information loss" until a real restart e2e passes.

### Phase R6 — Go TUI Integration

**状态**：✅ **2026-06-20 收口**。`clients/go-tui/internal/loop/api/context_observer.go`（transport, 175 行）+ `clients/go-tui/internal/loop/context_observer.go`（state-machine, ~590 行）+ `InteractiveModel.Init()` 默认启动 + `FormatCtxObservationLine` 5 状态兜底。`go test ./internal/loop/...` ok，14 个 Go test（7 transport + 7 state-machine with 15 subcases）全绿。

**Goal**: Go TUI displays runtime-owned context facts without deriving them itself.

Implementation:

- Subscribe to `/v1/working-set/observe` for small status updates.
- Optionally subscribe to `/v1/context/observe` redacted payload for context section/budget status.
- Render:
  - working-set version/count;
  - last assembled timestamp;
  - context usage source (`runtime context_usage`, not model narration);
  - unavailable states when no observer data exists.

Tests:

- Go state-machine tests for observer frames.
- no observer / disconnected observer states.
- text does not claim working-set injection unless frame confirms it.

Acceptance:

- TUI says "not observed" rather than inventing context facts.
- Runtime remains the source of truth.

### Phase R7 — Real Regression Replay Gate

**状态**：✅ **2026-06-20 收口**。`test/r7-replay-gate.test.ts` 15/15 全绿，覆盖 c1 cwd drift / c2 continuity / c3 storage / c4 working-set hot path / c4' REST-PUT↔WS 共享 / c5 resume preview / c6 observer redacted e2e。fixture snapshot 保存在 `test/fixtures/r7-fixture.sqlite`（3 个历史 session 冻结）。

**Goal**: Prove the loop against the three real sessions that exposed current failures.

Fixtures:

- `session_981cc5c2-230c-40d1-953c-b956e9dbaaf7`
- `session_cf361f04-7ab1-43a5-907a-41a808942686`
- `session_10320709-2b06-405f-8f51-d954435d4a70`

Required assertions:

- No turn resolves task root to `/` or `~/Library` unless explicitly user-approved.
- `session_root_continuity` exists when session metadata is present.
- `contextRecent` works in storage-backed runtime.
- working-set file is created/updated for in-scope tool paths.
- resumed preview includes working set and bounded recent context.
- observer e2e receives a redacted assembled update for a real turn.

Only after R0-R7 pass should this plan upgrade from `Partially Landed` to `Active Reference` or move completed pieces to `history/`.

### 20.1 Execution Order

R0/R1 是 R2 的前置闸门——不先收口 storage propagation / continuity wiring / cwd drift，persisted working set 就会被污染根（`~/Library`）写脏、context recall 工具持续 `CONTEXT_STORAGE_UNAVAILABLE`，R2 的「Nexus-owned working set 进入 active context」承诺无法验证。`session_981cc5c2` / `session_cf361f04` / `session_10320709` 三个真实 session 同时印证：全部 0 个 `working_set_updated` + 0 个 `session_root_continuity` + context tool 失败。

R0/R1 的 bug 级细节由 [context-cwd-drift-and-recall-governance-plan.md §12 + §13](../reference/context-cwd-drift-and-recall-governance-plan.md) 拥有。§13 二次复盘（直接读 SQLite events 表）把 R0/R1 拆成 4 个独立 bug + 修正优先级：

**P0 前置闸门（按此顺序，每段独立 PR + focused regression test）：**

1. **R1 / Bug 1 Layer A [P0]** — `extractAbsolutePaths` quote-delimited span 优先识别（`'...'`/`"..."`/backtick 整段实存则绕过普通空格切断）。修 cwd 漂移根因：真实 prompt 用普通空格（非 `\ ` escape），Phase A Follow-up ④ 的 SPACE_MARK 哨兵修错了目标。~15 行 + 4 test。**最优先**——阻断整条 drift 链。
2. **R1 / Bug 1 Layer B [P0]** — 共享 `isAcceptablePromptCwd` 守卫在 Site A（`app.ts:resolveExplicitPromptCwd`）+ Site B（`runtime:resolveCwdFromPrompt`）拒绝 homedir/`~/Library`/`~/Documents`/`~/Desktop`/`~/Downloads`/`/Users`。~10 行 + 3 test。Layer A 漏网时的 defense-in-depth。
3. **R0 / Bug 3 [P0]** — `LLMCodingRuntime.runExecuteStreamInner` 起手注入 `this.storage` + Nexus HTTP/WS `executeStream` 传 `storage` + `runtimeToolLoop` defensive merge。~8 行 + 5 test。锁住 3 个 `CONTEXT_STORAGE_UNAVAILABLE`。
4. **R0 / Bug 2 [P0]** — `sessions.origin_cwd` 不可变列（launcher `body.cwd` 写入一次，不随 `session.cwd` 漂移）+ `app.ts:2695` 传 `storedSessionCwd=origin_cwd` + `latestTaskPrimaryRoot`。~20 行 + 3 test。**§13 修正**：`session.cwd` 本身已漂，单纯传 `session.cwd` 会传漂移值。

**P1 Nexus-owned context 真正成立：**

5. **R1 / Bug 4 [P1]** — 统一 dual cwd resolution sites（删 `resolveExplicitPromptCwd` 让 runtime+PhaseB 决策，或把 Phase B continuity 上移到 `resolveRequestCwd`）；`session.cwd` 不被 external prompt 覆写。~30 行 refactor + 4 test。跨 turn drift 持续的架构层根因。
6. **R2 [P1]** — persisted working set 接入 `executeStream` hot path：`loadWorkingSetOverride(sessionId,cwd)` + 成功工具事件后 `applyEvent()`+flush + `refreshRuntimeContextState()` 转发 `workingSetOverride`。**Nexus-owned context 承诺的兑现点**。

**P1 Watch 可观测性与产品路径（依赖 R2，可并行小切片）：**

7. ✅ **R3 [2026-06-18 已收口]** — REST PUT + `/v1/working-set/observe` 共享 per-cwd tracker——`WorkingSetBroadcaster.mutate(cwd, fn)` 让 PUT 走 broadcaster-owned tracker，subscriber 自动收到 `working_set_updated`。`test/r3-rest-put-observe.test.ts` 6/6 覆盖 R3 acceptance e2e。
8. ✅ **R4 [2026-06-20 已收口]** — `/v1/context/observe` 真实 `executeStream` e2e + redacted payload——`nexus/contextBroadcaster.ts` 新增 `redactContext(ctx, mode='summary')` 剥离 `systemPrompt` + `messages`；observer route 默认 summary 模式，`?full=1` opt-in verbatim。`test/r4-context-observe-runtime-e2e.test.ts` 9/9 覆盖：redact contract / broadcaster publish / unsubscribe 清理 / 真实 `LLMCodingRuntime.executeStream` e2e (无手动 publish) / reconnect → assembled_snapshot。
9. ✅ **R5 [2026-06-20 已收口]** — resume preview as product path——`LLMCodingRuntime.resumePreview({ sessionId, cwd })` 纯 read-only projection（load/rebuild working set + assemble context with `includeLiveHints: false`），返回 `{ cwd, workingSet, assembledSectionIds, budget, liveHintsSubscribed: false, hasContinuationSnapshot: false }`。`/v1/sessions/:sessionId/resume-preview` route 调 `runtime.resumePreview?.()`；`LocalCodingRuntime` 无 resume → 501 `RESUME_PREVIEW_UNSUPPORTED`（默认-on policy：缺能力显式报错，不静默回退）。`test/r5-resume-preview.test.ts` 6/6 覆盖：404 / 400 / 501 / pre-seeded rebuilt=false / event-tail rebuilt=true / 调 preview 前后 storage 状态不变（read-only 验证）。`hasContinuationSnapshot: false` 硬编码，docs 不再承诺"0 information loss" 直到 R0-R7 全过。
10. ✅ **R6 [2026-06-20 已收口]** Go TUI 只消费 runtime-owned observer facts，不自行推导 context truth。落地：`clients/go-tui/internal/loop/api/context_observer.go`（client-side WS subscriber，redacted payload schema：`assembled_snapshot` / `assembled` / `error` 三种 frame 的 typed envelope，`ObserveOpts.RedactionMode` 默认 summary、`"full"` opt-in 但 loop renderer 仍忽略 verbatim 字段）+ `clients/go-tui/internal/loop/context_observer.go`（loop-level `ContextObserver`：reconnect 2s→5s→15s backoff、tea.Cmd plumbing、per-cwd `ContextObservation` map、`applyCtxObservationFrame` / `markCtxObservationDisconnected` / `GetCtxObservation` / `FormatCtxObservationLine` 五个 helper），observer 默认在 `InteractiveModel.Init()` 启动。**runtime-owned 契约**：renderer 永远不从模型自身状态推导 context truth；frame 永远不到时显示 `context: not observed`；server 一旦发 `redaction:"full"`，loop 仍 fallback 到 `context: full mode (debug)` 而不是显示 verbatim prompt。**Tests**：`api/context_observer_test.go` 7 个 transport tests（snapshot+assembled / error frame / close idempotent / null context / sessionId query param / full mode query param / unknown frame type recovery） + `loop/context_observer_test.go` 7 个 state-machine tests with 15 subcases（S1 not-observed / S2 late connect / S3 reconnect 替换状态 / S4 schema mismatch 三种子情形 / S5 partial payload 两种 fallback / backoff 序列 / format helper）。

**P2 验收闸门 + 治理延后：**

11. ✅ **R7 [2026-06-20 已收口]** — 真实 session replay gate——用 `session_981cc5c2` / `session_cf361f04` / `session_10320709` 三个 fixture 关门验收。**当前状态**：c1 (cwd drift) + c2 (Phase B continuity) + c3 (context tool storage) + c4 (working-set hot path) + c4' (REST PUT ↔ WS observer 共享) + c5 (resume preview product path) + c6 (observer redacted e2e) **全部关闭**（R4 关 c6 + R5 关 c5）。fixture snapshot 保存在 `test/fixtures/r7-fixture.sqlite`，`test/r7-replay-gate.test.ts` 15/15 覆盖。**R6 已关闭后 R0-R7 全部收口**——本 plan 等待 governance 把它从 `proposals/` 迁移到 `reference/`（独立 doc lifecycle slice）后即可正式升级为 `Active Reference`。
12. cwd-drift Phase D（`ContextEstimateCalibration`）/ E（`ROOT_SCAN_REQUIRES_CONFIRMATION`）/ F（`UserArtifactContinuity`）——等真实 regression 触发再推进。
13. **Glob permission-denied 降级为 partial result**（独立工具鲁棒性 follow-up，入 tool-governance-plan）——session_10320709 的 8 个 GLOB_FAILED 全因 ripgrep 撞 `~/Library/Caches` 权限拒绝整段失败，非本 plan 范围但同源 drift 暴露。

**执行原则**：R0/R1 先于 R2（污染根 + storage 缺失会让 R2 写脏、验收假阳性）；Bug 1 Layer A 是 P0 之首（cwd 漂移 load-bearing fix，SPACE_MARK 修错目标）；每段独立 PR + focused regression test，按 1→13 顺序推进；不引入第二 source of truth、不重写 Phase A/B/C 主体、不主动开 Phase D/E/F。

**2026-06-20 收盘**：R0 / R1 / R2 / R3 / R4 / R5 / R6 / R7 全部收口。本 plan 等待 governance 把它从 `proposals/` 迁移到 `reference/` 后即可正式升级为 `Active Reference`（独立 doc lifecycle slice，不阻塞此 plan 的功能闭环）。

### 20.2 Non-goals For This Follow-up

- Do not add a new long-term memory authority; MemoryProvider / EverCore remains governed by memory docs.
- Do not make behavior trace authoritative context.
- Do not persist full assembled prompts by default.
- Do not let CLI or Go TUI infer context truth.
- Do not claim durable execution resume until continuation snapshots exist.

### 20.3 中文概述

这次审计结论是：`long-running-context-assembly.md` 里的基础设施不少已经写出来了，但“长会话上下文真的由 Nexus 组装并稳定进入模型上下文”还没有闭环。当前最要紧不是继续扩展工具面，而是先修 `contextSearch/contextRecent` 的 storage 断链、cwd 漂移、session continuity 接线，然后把持久化 working set 接进 `LLMCodingRuntime.executeStream()` 的正常热路径。只有真实 session 能证明 working set 文件被创建、下一轮被注入、observer 收到真实 runtime assembled frame、resume preview 能复原上下文，才可以把这条线从 partially landed 升级为真正可用。

---

## 21. 参考

- `src/runtime/sessionMemoryLite.ts` — 现有压缩逻辑（P3 决策）
- `src/runtime/compact.ts` — hard compact 保留
- `src/nexus/everCoreRuntimeManager.ts` — 资源模型复用
- `src/nexus/app.ts:931` — `/v1/runtime/loop/health`（与 P2 行为面板集成）
- `src/runtime/loopDiagnostics.ts` — PaneStatus 投影
- `clients/go-tui/internal/loop/model.go:25` — PaneStatus enum
- `docs/nexus/reference/behavior-monitor.md` — 平行模块（Layer 3 源 + live hints）
- `docs/nexus/CONTEXT_UPGRADE_ROADMAP.md` — 上下文升级大图
- `/Users/tangyaoyue/Desktop/BabeL-O-Memory-NativeTool-Plan-C.md` — Plan C 长期记忆（边界外）
- [[babel-o-model-catalog-governance]] — never auto-switch
- [[babel-o-soft-recoverable-timeouts]] — 软超时
- [[feedback-tool-boundary-granularity]] — 正交工具
- [[babe-l-o-memoryos-naming]] — 命名规范
- [[babel-o-test-config-isolation]] — 测试隔离
- [[feedback-babel-o-p0-regression-focus]] — P0 回归 first

## 中文概述

### 背景

长任务需要 working set、resume pack、context assembly API 和用户可见诊断，避免模型在长会话中丢失当前任务边界。

### 边界

本文不能把 plan-only 能力写成已实现。所有状态必须回到 runtime 源码、测试、TODO、DONE 和 WORK_LOG 核对。

### 当前状态

作为 Partially Landed 文档保留。后续应优先补可验证的 context analysis、working set 与 resume 行为，而不是继续扩大文档范围。
