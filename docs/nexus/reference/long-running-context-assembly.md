# Long-Running Context Assembly — 设计文档

> 状态：v1 草案 — Track A Phase 0/1/2/3 server 侧全部落地（2026-06-16），CLI 4 个子命令 + REST 5 个 endpoint 已上线
> 范围：利用 Nexus 常驻能力，重新设计上下文组装架构，支持 session/task 长时间持久运行
> 替代：旧"压缩 = 上下文管理"模型，升级为"Nexus 组装 = 上下文管理"

**落地清单**（按 PR）：

| Phase | 内容 | PR | 日期 |
|---|---|---|---|
| P0 | `BABEL_O_NATURAL_PAUSE_SUPPRESS` env flag | PR-1 | 2026-06-14 |
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

**剩余项**：
- ⏸ `bbl context working-set --edit` (write op, 待显式批准 — PR-19)
- ⏸ `PUT /v1/context/working-set/:sessionId` (write op, 同上)
- ⏸ WebSocket `/v1/context/observe` (待 runtime 集成)
- ⏸ `working_set_updated` WS 事件 (待 WorkingSetTracker event bus)

---

## 0. 术语与边界

| 术语 | 含义 |
|---|---|
| **Working Set** | session 当前任务的"心智状态"——始终在 active context，永不压缩 |
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
- **唯一改动**：`sessionMemoryLite.ts` 的 `natural_pause` 决策路径**保留但被压制**（P0 完成后决定去留）

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
| G1 | Working set 始终在 active context，**永不压缩** | 集成测试：100 turn 后 working set 仍完整 |
| G2 | session 重启后 0 信息丢失 | session resume 测试：working set / recent 完整重建 |
| G3 | Active context 永不超过 budget | 单测：budget 超时自动 microcompact |
| G4 | 历史可查不需全装 | on-demand 工具测试：`context.search` / `context.summarize` |
| G5 | 跨 session 共享 working set | 多 session 集成测试：A 改动 → B 收到通知 |
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
│  Layer 1: Working Set（始终在 active context）            │
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

| Layer | 默认容量 | 优先级 | pinned |
|---|---|---|---|
| Working Set | 1500 tokens | 1（最高） | ✅ |
| Recent Events | 3000 tokens | 2 | ❌ |
| Behavior Trace 摘要 | 1000 tokens | 3 | ❌ |
| Long-Term Memory | 1000 tokens | 4 | ❌ |
| Project Memory | 500 tokens | 5 | ❌ |
| Live Hints | 500 tokens | 6（动态） | ❌ |
| **总计** | **7500 tokens**（max 8000） | | |

**溢出处理**：超 budget → `microcompact` 缩减 Layer 2 → 仍超 → 砍 Layer 3 → 仍超 → 报错（不静默丢 pinned）。

---

## 5. Nexus 端模块

### 5.1 WorkingSetTracker

**文件**：
- 内存版：`src/nexus/workingSetTracker.ts`（~170 行）
- 持久化版：`src/nexus/persistedWorkingSetTracker.ts`（~150 行）

**状态**：✅ 内存版 + 持久化版均已落地（PR-4a + PR-4b, 2026-06-14），CLI 3 个子命令 (working-set/history/resume) 已落地 (PR-9/10/13, 2026-06-15), REST 3 个 endpoint (list/get/workspace-aggregate) 已落地 (PR-11/12/20, 2026-06-15/16)

**职责**：
- 维护每 session working set（内存 + 持久化）
- 监听 `tool_started` / `task_created` / `scope_boundary_*` 事件自动更新
- 提供 `get / update / rebuild / share` API
- 跨 session 通过 `workspaceId` 共享

**核心 API**：

```typescript
class WorkingSetTracker {
  // 获取
  get(sessionId: string): WorkingSet | null

  // 增量更新（事件驱动）
  applyEvent(sessionId: string, event: NexusEvent): void

  // 显式更新
  update(sessionId: string, patch: Partial<WorkingSet>): WorkingSet

  // 从事件流重建
  rebuild(sessionId: string, fromEventTail: NexusEvent[]): WorkingSet

  // 跨 session 共享（同 workspace）
  getWorkspaceWorkingSet(workspaceId: string): WorkingSet | null
  linkToWorkspace(sessionId: string, workspaceId: string): void

  // 持久化
  persist(sessionId: string): Promise<void>
  load(sessionId: string): Promise<WorkingSet | null>
}
```

**持久化路径**：`<cwd>/.babel-o/working-set.json`（per-cwd，因为 workspace 跟 cwd 绑定）

### 5.2 ContextAssembler

**文件**：
- Runtime 版本：`src/runtime/contextAssembler.ts`（实际 ~700 行，含 assembleContext 入口 + 完整 budget 分配）
- CLI/REST preview 版本：复用同一个 runtime 模块；CLI/REST 还提供 `buildAssemblePreview()`（`src/cli/commands/context.ts` 纯函数）做离线路径的 read-only 投影

**状态**：✅ runtime `assembleContext` 已落地（Phase 1/2），CLI preview 已落地（PR-15, 2026-06-16），REST endpoint 已落地（PR-18, 2026-06-16）

**职责**：
- 接收 assemble 请求
- 拉 working set（pinned）
- 拉 recent events + microcompact
- 拉可选 layer 3 源
- 预算管理
- 输出 AssembledContext

**核心 API**：

```typescript
class ContextAssembler {
  // 主入口
  assemble(opts: AssembleOptions): Promise<AssembledContext>

  // 单独拉 working set
  getWorkingSetSection(sessionId: string): ContextSection

  // 单独拉 recent
  getRecentEventsSection(sessionId: string, opts: { sinceMs: number, maxTokens: number }): Promise<ContextSection>

  // 单独拉 trace
  getBehaviorTraceSection(cwd: string, opts: { sinceMs: number, maxTokens: number }): Promise<ContextSection>

  // 单独拉 long-term
  getLongTermSection(query: string, maxTokens: number): Promise<ContextSection>

  // 单独拉 project
  getProjectMemorySection(cwd: string, maxTokens: number): Promise<ContextSection>
}

type AssembleOptions = {
  sessionId: string
  workspaceId?: string
  scope: 'minimal' | 'standard' | 'full' | 'task' | 'workspace'
  maxTokens: number
  includeBehaviorTrace: boolean
  includeLongTerm: boolean
  includeProjectMemory: boolean
  includeLiveHints: boolean
}
```

### 5.3 microcompact（轻量压缩）

**文件**：`src/nexus/microcompact.ts`（~200 行）

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

```typescript
// src/runtime/LLMCodingRuntime.ts
async resume(opts: { sessionId: string; cwd: string }) {
  // 1. 从持久化加载 working set
  const ws = await this.workingSetTracker.load(opts.sessionId)
  if (!ws) {
    // 首次或损坏 → 从事件流重建
    const events = await this.storage.listEvents(opts.sessionId, { limit: 100, order: 'desc' })
    ws = this.workingSetTracker.rebuild(opts.sessionId, events)
  }

  // 2. 拉全 workspace context
  const assembled = await this.nexus.contextAssembler.assemble({
    sessionId: opts.sessionId,
    workspaceId: ws.workspaceId,
    scope: 'workspace',
    maxTokens: 8000,
    includeBehaviorTrace: true,
    includeLongTerm: true,
    includeProjectMemory: true,
    includeLiveHints: false,    // resume 时不要 hint，先恢复稳态
  })

  // 3. 订阅 live hints（resume 完成后才开）
  this.behaviorMonitor.subscribe(opts.sessionId, hint => {
    if (this.canAcceptHint()) {
      this.injectSystemSection(formatHint(hint))
    }
  })

  return assembled
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

> **状态**：✅ 3 个 tool (`context.search` / `context.summarize` / `context.recent`) 已在 `src/tools/contextTools.ts` 落地 (PR-7, 2026-06-15) 并注册到 ToolRegistry (PR-8, 2026-06-15)。CLI `bbl context history` (PR-10) 复用 `searchEvents` / `summarizeWindow`。REST `/v1/context/history` (PR-11) 同样复用。

新增 3 个 tool，在 `src/tools/contextTools.ts`：

| 工具 | 用途 | 拉取源 |
|---|---|---|
| `context.search(query, since?)` | 全文搜索过往事件 | EventStore |
| `context.summarize(scope, since?)` | 抽取某时段的摘要 | behavior-trace.jsonl |
| `context.recent(n)` | 最近 N 个事件 | EventStore |

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
| `bbl context working-set --edit` | **新**：手动编辑 working set | ⏸ write op, 待显式批准（PR-19） |
| `bbl context history --since 24h` | **新**：拉历史事件 + 摘要 | ✅ 已落地（PR-10, 2026-06-15） |
| `bbl context resume` | **新**：模拟 resume 流程（debug） | ✅ 已落地（PR-13, 2026-06-15） |

### 7.3 REST + WebSocket

**新增 REST**：

| 路径 | 方法 | 功能 | 状态 |
|---|---|---|---|
| `/v1/context/assemble` | POST | 手动触发组装（带 options） | ✅ 已落地（PR-18, 2026-06-16） |
| `/v1/context/working-set` | GET | 列所有 session 的 working set | ✅ 已落地（PR-12, 2026-06-15） |
| `/v1/context/working-set/:sessionId` | GET | 读单个 session 的 working set | ✅ 已落地（PR-12, 2026-06-15） |
| `/v1/context/working-set/:sessionId` | PUT | 写 working set | ⏸ write op, 待显式批准 |
| `/v1/context/working-set/workspace/:wsId` | GET | 读 workspace 共享 working set（聚合） | ✅ 已落地（PR-20, 2026-06-16） |
| `/v1/context/history` | GET | 拉历史事件（带过滤） | ✅ 已落地（PR-11, 2026-06-15） |

**新增 WebSocket**：

```
// 现有 /v1/behavior/observe 扩展
{ type: 'working_set_updated', sessionId, ws }   // ⏸ 待 WorkingSetTracker event bus 落地

// 新增 /v1/context/observe
{ type: 'assembled', sessionId, context }         // ⏸ 待 runtime 集成（PR-X, deferred）
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
│  natural_pause（保留但被压制，P0 完成后决定）          │
│  ├─ 现状：每 user 轮触发                                │
│  ├─ 被压制：P0 后无意义（数据全在 behavior-trace）     │
│  └─ 待决策：删除 / opt-in / 保留                        │
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
| **`sessionMemoryLite.ts`** | 保留模块——`forced` 给 hard compact 用；`growth_threshold` 改成 microcompact 触发；`natural_pause` **P0 完成后决定** |
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
| `BABEL_O_NATURAL_PAUSE_SUPPRESS` | `false` | **P0 完成后开启**——压制 natural_pause |

---

## 11. 测试策略

### 11.1 WorkingSetTracker 测试

- `test/working-set-tracker.test.ts`（~250 行）
- 覆盖：applyEvent / get / update / rebuild / persist / load / share

### 11.2 ContextAssembler 测试

- `test/context-assembler.test.ts`（~350 行）
- 覆盖：5 个 scope / budget overflow / microcompact / Layer 3 各源 / 顺序保证

### 11.3 microcompact 测试

- `test/microcompact.test.ts`（~200 行）
- 覆盖：去重 / 截断 / 聚合 / 噪音过滤

### 11.4 Session Resume 测试

- `test/session-resume.test.ts`（~200 行）
- 覆盖：working set 重建 / context 恢复 / live hint 订阅

### 11.5 跨 Session 测试

- `test/cross-session-ws.test.ts`（~200 行）
- 覆盖：workspace 共享 / 事件广播 / 状态一致性

### 11.6 端到端集成

- `test/long-running-integration.test.ts`（~250 行）
- 场景：100 turn 模拟 → working set 不丢 / 重启后 0 信息丢失 / budget 不超
- **测试隔离**（[[babel-o-test-config-isolation]]）：tmp dir / 强制 `:memory:` storage

### 11.7 CLI 表面

- `test/cli-context.test.ts`（~150 行）

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

### Phase 0: 紧急修复核心问题（独立工作，1-2 天）
- 加 `BABEL_O_NATURAL_PAUSE_SUPPRESS=true` 默认
- 不动代码逻辑，只压制触发
- 用户立刻感觉"不再每轮压缩"

### Phase 1: WorkingSetTracker + ContextAssembler 上线（3-4 天）
- 新增 `src/nexus/workingSetTracker.ts`（~300 行）
- 新增 `src/nexus/contextAssembler.ts`（~400 行）
- 新增 `src/nexus/microcompact.ts`（~200 行）
- `LLMCodingRuntime.startTurn` 改为从 Nexus 拉 assembled context
- **新模型启用，旧 natural_pause 路径保留**（双轨运行）

### Phase 2: on-demand 工具 + Session Resume（2-3 天）
- 新增 `context.search / summarize / recent` 3 工具
- `LLMCodingRuntime.resume()` 完整实现
- 跨 session working set 共享
- **P0 完成，决定 natural_pause 去留**

### Phase 3: natural_pause 清理（0.5-1 天）
- **若决定删除**：删 `natural_pause` 决策分支 + 对应 test
- **若决定 opt-in**：加 `BABEL_O_SESSION_MEMORY_LITE_NATURAL_PAUSE` env flag
- **若决定保留**：继续 P1 双轨

### Phase 4: 跨 Session 协同 + 时间窗 context（2-3 天）
- 多 session working set 广播
- "show me last 24h" 完整命令
- `bbl context` 子命令全套

### Phase 5: behavior monitor 接入（独立工作）
- 行为轨迹作为 Layer 3 `behaviorTrace` 来源
- Live hints 增强

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

### ADR-5: natural_pause 保留但 P0 完成后决定

**Context**: 用户最初反馈"natural_pause 太激进"。

**Decision**: 保留代码 + `BABEL_O_NATURAL_PAUSE_SUPPRESS` env 压制；待 P0/P1/P2 完成后看实际数据再决定删除 / opt-in / 保留。

**Consequences**:
- (+) 零风险过渡
- (+) 决策基于实际数据
- (-) 短期增加代码体积

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
| **P3** | natural_pause 清理 | ~50 | 0.5 天 | 🟢 |
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
| 与 natural_pause 双轨混乱 | 中 | 低 | P0 压制 + P3 清理（基于数据决策） |
| Layer 3 各源失败 | 中 | 中 | 单源失败降级到标准 scope，不阻塞 turn |

---

## 17. 开放问题

1. **Working set 持久化策略**：每 session 一个 json 文件？还是共享 sqlite 表？→ P1.a 决策
2. **跨 session 共享粒度**：所有 session 共享？按 task 共享？→ P2.c 决策
3. **microcompact 是否计入 trace**：microcompact 改了 events 数组但没写事件，trace 看到的还是原始 events。是否需要写 `microcompact_summary` 到 trace？→ P1.c 决策
4. **on-demand 工具权限**：模型主动调用 `context.search` 是否需要 approval？→ P2.a 决策
5. **P0 完成后 natural_pause 数据**：自然废弃后，旧 `.babel-o/session-memory.md` 文件怎么办？自动转 behavior-trace？保留？→ P3 决策

---

## 18. 参考

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
