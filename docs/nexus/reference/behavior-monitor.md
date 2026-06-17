# Behavior Monitor — 设计文档

> 状态：v1 草案 — Server 侧 Phase 1/2 已落地（2026-06-16），Go 端 mirror 留作 PR-17（独立 repo）
> 范围：把 `sessionMemoryLite` 的"natural_pause 频繁写日志"问题，重新定位为"agent 行为轨迹 + 跨 session 自检复盘"系统
> 替代：`sessionMemoryLite` 的 `natural_pause` 决策分支（保留 `forced` / `growth_threshold`）

**Server 侧落地清单**（按 PR）：
- PR-1 (2026-06-14): `BABEL_O_NATURAL_PAUSE_SUPPRESS` env flag 默认压制 `natural_pause`
- PR-2 (2026-06-14): `src/runtime/behaviorTrace.ts` 5 类 trigger + 队列 + flush
- PR-3 (2026-06-14): `wrapWithBehaviorTraceTap()` 包装 runtime error path
- PR-5 (2026-06-15): `src/nexus/behaviorMonitor.ts` 跨 session 3 类触发器 (hot-path/tool-storm/scope-drift-wave)
- PR-6 (2026-06-16): `applyBehaviorHint()` 投影 PaneStatus 新 `behaviorHint` 态 (priority 6)
- PR-14 (2026-06-16): `/v1/runtime/loop/health` 暴露 `pendingHints` / `lastHintAt` / `lastHintPattern`

**Go 端**：`bbl-loop` 独立 repo（PR-17），不阻塞 server 侧。

---

## 0. 术语与边界

| 术语 | 含义 |
|---|---|
| **行为轨迹（behavior trace）** | 一条结构化的"agent 在某时刻做了什么 / 遇到什么异常"记录 |
| **触发器（trigger）** | 何时写一条轨迹 |
| **自评（self-assessment）** | 轨迹条目里"当时为什么这么做 / 失败原因"字段，由规则或 LLM 生成 |
| **跨 session 监控（cross-session monitor）** | Nexus 端常驻的、跨多个 session 聚合事件的模块 |
| **实时提示（live hint）** | Nexus 在检测到高频 pattern 后，向**在飞 session** 注入的轻量建议 |
| **推荐（recommendation）** | 跨 session 模式的优化建议，写入 `recommendations.md`，下次 session 启动时读回 system prompt |

**边界**：
- 不动 Plan C 长期记忆（`MemoryProvider` 协议化重构）
- 不动 `compact.ts`（结构压缩路径）
- 不动 `.babel-o/memory.md`（项目级持久记忆）
- 不动 `loadProjectMemory` / `sessionMemoryLite.forced`（/compact 时的轻量上下文仍走 session-memory.md）
- **唯一改动**：`sessionMemoryLite.natural_pause` 决策路径淡出，由 `behaviorTrace` 接替

---

## 1. 背景与动机

### 1.1 现状

`sessionMemoryLite.ts:223` 的 `natural_pause` 决策：

```ts
if (latestUserIndex >= 0 && !latestTurnHasTools && eventCount > 0) {
  return { shouldUpdate: true, reason: 'natural_pause', ... }
}
```

**问题**：
- 每次 user 轮（无工具）都触发 → 体感"几乎每次交互都在压"
- 写入 `.babel-o/session-memory.md`（markdown 摘要）
- **没有任何代码读这个文件**（grep 结果：除 sessionMemoryLite.ts 自身 + 测试 + diagnostics 字段外，无消费者）
- 即"数据已写但无处可用"

### 1.2 重新定位

同一份数据（事件流统计、工具计数、文件引用、异常码）——**重新解读为"agent 行为轨迹"**：

| 旧解读 | 新解读 |
|---|---|
| 长期记忆 | 行为轨迹 |
| 写给模型看 | 写给运维 / 自检看 |
| 每次 user 轮都写 | 异常 / 段尾 / 用户介入时写 |
| markdown 摘要 | 结构化 JSONL |
| 无消费者 | 跨 session 聚合 + 实时反馈 |

### 1.3 关键架构事实

**Nexus 是常驻服务，session 是它托管的瞬态实例**——这意味着：

- 跨 session 模式检测**天然在 Nexus 端做**（看多个 session 的事件流）
- 实时反馈**天然支持**（Nexus 通过 SessionChannel 跟 session 双向通信）
- 自检回路**可以实时闭环**（不必等下次 session 启动）

---

## 2. 目标与非目标

### 2.1 目标

| ID | 目标 | 验收 |
|---|---|---|
| G1 | session 内行为异常 / 段尾自动落轨迹 | `behavior-trace.jsonl` 在异常驱动下增长 |
| G2 | Nexus 端跨 session 模式检测 | `bbl behavior pattern` 报出 ≥ 1 个真实模式（在测试 fixture 上） |
| G3 | 在飞 session 实时提示（默认开启 + 通知用户） | 集成测试：3 session 命中同 pattern，活跃 session 收到 hint |
| G4 | 零默认 LLM 成本 | 写时 + Nexus 实时检测 = 纯规则版，0 LLM 调用 |
| G5 | 三路输出（CLI / REST / WebSocket） | 三个 surface 都能查到同一份数据 |

### 2.2 非目标

| ID | 不做 |
|---|---|
| N1 | 不替代 Plan C 长期记忆 |
| N2 | 不替代 `compact.ts` |
| N3 | 不内嵌 LLM 推理引擎（用现有 provider） |
| N4 | 不动 `sessionMemoryLite.forced` 路径（/compact 时仍用） |
| N5 | 不动 `.babel-o/memory.md` |
| N6 | 不引入新品牌词（用户面用 "行为轨迹" / "behavior trace"） |
| N7 | 不复活自动 model selection |

---

## 3. 架构总览

```
┌────────────────────────────────────────────────────────────────────┐
│                         Nexus 进程（常驻）                          │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  BehaviorMonitor（新增）                                   │    │
│  │  ├─ crossSessionAggregator     跨 session 事件聚合        │    │
│  │  ├─ patternDetector            跨 session 3 类触发器      │    │
│  │  ├─ hintDispatcher             实时提示分发               │    │
│  │  └─ liveStreamHub              WebSocket 推送             │    │
│  └──────────────────────────────────────────────────────────┘    │
│          ▲           │                                            │
│          │ 订阅      │ 注入 hint                                   │
│          │           ▼                                            │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  SessionChannel（已存在）  ──  eventBus  ──  /v1/runtime   │    │
│  │  └─ /v1/runtime/loop/health    现有 pane 状态投影           │    │
│  │     └─ + StatusBehaviorHint  态（§6.5）                   │    │
│  └──────────────────────────────────────────────────────────┘    │
│          ▲                                                         │
└──────────┼─────────────────────────────────────────────────────────┘
           │ 租约 1+1+1...
           ▼
    ┌──────────┐  ┌──────────┐  ┌──────────┐
    │session A │  │session B │  │session C │  ← 各 session runtime
    │ ┌──────┐ │  │ ┌──────┐ │  │ ┌──────┐ │
    │ │bhvTrc│ │  │ │bhvTrc│ │  │ │bhvTrc│ │  ← 行为轨迹捕获
    │ └──────┘ │  │ └──────┘ │  │ └──────┘ │
    │   │jsonl │  │   │jsonl │  │   │jsonl │
    │   ▼      │  │   ▼      │  │   ▼      │
    │ .babel-o/│  │ .babel-o/│  │ .babel-o/│
    │  behavior│  │  behavior│  │  behavior│
    │  -trace  │  │  -trace  │  │  -trace  │
    │  .jsonl  │  │  .jsonl  │  │  .jsonl  │
    └──────────┘  └──────────┘  └──────────┘
           │              │              │
           └──────────────┼──────────────┘
                          │
        ┌─────────────────┴──────────────────┐
        ▼                                    ▼
   ┌──────────────────┐               ┌──────────────────┐
   │  bbl behavior    │               │  bbl loop        │
   │  review/stats/   │               │  (Go TUI 多面板)  │
   │  pattern/live    │               │  + Behavior Tab  │
   │  (CLI)           │               │  (Phase 2)       │
   └──────────────────┘               └──────────────────┘
```

---

## 4. 数据模型

### 4.1 轨迹条目 schema

```typescript
// 写入 .babel-o/behavior-trace.jsonl 的单条
type BehaviorTraceEntry = {
  schemaVersion: '2026-06-16.behavior-trace.v1'
  // 标识
  traceId: string                    // ULID
  sessionId: string
  cwd: string
  timestamp: string                  // ISO 8601

  // 触发信息
  trigger: BehaviorTrigger
  triggerConfidence: number           // 0-1, 规则版给启发式分数

  // 决策上下文（关键创新点）
  context: {
    recentEvents: NexusEvent[]       // 最近 20 个
    toolSequence: string[]           // ['Read', 'Edit', 'Read', 'Edit']
    fileRefStack: string[]
    userIntentGuidance: string       // 当前用户意图（来自 contextAnalysis）
    retryCount: number               // 同 tool_use_id 重试
    timeInSessionMs: number
    tokensSinceLastTrace: number
  }

  // 异常描述
  anomaly: {
    errorCode?: string
    errorMessage?: string
    denialReason?: string
    driftPath?: string
    expectedScope?: string
    userRedirectSignal?: string
  }

  // 自评（规则版写时填，LLM 版离线补）
  selfAssessment?: {
    likelyCause: string              // 'path-not-found' | 'wrong-tool-choice' | ...
    confidence: number               // 0-1
    suggestedFix: string             // 'consider glob before read'
    source: 'rule' | 'llm' | ''
  }
}

type BehaviorTrigger =
  // session 内（5 类）
  | 'error'
  | 'denial'
  | 'scope-drift'
  | 'trajectory-end'
  | 'user-redirect'
  // 跨 session（3 类，由 Nexus 端 BehaviorMonitor 写入）
  | 'hot-path'
  | 'tool-storm'
  | 'scope-drift-wave'
```

### 4.2 文件格式

**文件**：`<cwd>/.babel-o/behavior-trace.jsonl`

- **格式**：JSONL（每行一个 `BehaviorTraceEntry`）
- **append-only**：不 trim（外部用 logrotate 策略）
- **不替代** `.babel-o/session-memory.md`（后者继续供 /compact 使用）
- **`.gitignore` 建议**：`behavior-trace.jsonl` 加入 `.gitignore`（个人级，不入仓）

### 4.3 阈值与默认值

| 参数 | 默认 | env | 备注 |
|---|---|---|---|
| trajectory-end 间隔 | 20 tool calls | `BABEL_O_BEHAVIOR_TRAJECTORY_INTERVAL` | 范围 [5, 100] |
| self-assessment 模式 | `rule` | `BABEL_O_BEHAVIOR_SELF_ASSESS` | `rule` \| `llm` \| `off` |
| 跨 session hot-path 阈值 | 3 个 session / 5 分钟 | `BABEL_O_BEHAVIOR_HOT_PATH_THRESHOLD` | |
| 跨 session tool-storm 阈值 | 30 次/分钟 | `BABEL_O_BEHAVIOR_TOOL_STORM_THRESHOLD` | |
| live hint 默认 | **开启** | `BABEL_O_BEHAVIOR_LIVE_HINTS` | `true` \| `false` |
| live hint 通知 | **显式通知用户** | 不可关 | 与 `BABEL_O_BEHAVIOR_LIVE_HINTS` 独立 |
| live hint 最低 confidence | 0.8 | `BABEL_O_BEHAVIOR_HINT_MIN_CONFIDENCE` | |
| live hint 频率上限 | 1 次 / 5 分钟 / session | 硬编码 | 防注入风暴 |

---

## 5. session 内捕获

### 5.1 文件

**新增**：`src/runtime/behaviorTrace.ts`（~250 行）

### 5.2 触发器检测（5 类）

| 触发 | 检测位置 | 触发条件 |
|---|---|---|
| `error` | `LLMCodingRuntime` 收到 `error` 事件 | 1 turn 内 yield 一次 |
| `denial` | `LLMCodingRuntime` 收到 `permission_response.approved === false` | 1 turn 内 yield 一次 |
| `scope-drift` | `LLMCodingRuntime` 解析 `tool_started.input.path` | 路径不在 `taskScope` 声明下 |
| `trajectory-end` | `BehaviorTraceAccumulator` 计数 `tool_started` | 每 N 个 yield 一次（默认 20） |
| `user-redirect` | `LLMCodingRuntime` 解析 `user_message.text` | 匹配正则 `^(不\|错\|重新\|其实\|wait\|wrong\|no )` |

### 5.3 自评规则（rule 版，零 LLM）

```typescript
// src/runtime/behaviorTrace.ts
function deriveRuleSelfAssessment(
  trigger: BehaviorTrigger,
  context: BehaviorContext,
  anomaly: BehaviorAnomaly,
): SelfAssessment {
  if (anomaly.errorCode === 'TOOL_NOT_FOUND' && context.retryCount >= 2) {
    return {
      likelyCause: 'repeated-read-after-not-found',
      confidence: 0.8,
      suggestedFix: 'use glob search or path validation before read',
      source: 'rule',
    }
  }
  if (anomaly.denialReason === 'protected_path') {
    return {
      likelyCause: 'scope-violation',
      confidence: 0.95,
      suggestedFix: 'check task scope before edit',
      source: 'rule',
    }
  }
  if (trigger === 'scope-drift') {
    return {
      likelyCause: 'scope-drift',
      confidence: 0.85,
      suggestedFix: 'tighten task scope declaration',
      source: 'rule',
    }
  }
  return { likelyCause: 'unknown', confidence: 0, suggestedFix: '', source: 'rule' }
}
```

### 5.4 写入路径

```typescript
// 在 LLMCodingRuntime 已有事件 yield 处插桩（不增加新事件，仅旁路）
LLMCodingRuntime:xxx.on(event) {
  if (shouldCapture(event, accumulator)) {
    queueWriteTraceEntry(accumulator.snapshot(event))
  }
}

// queueWriteTraceEntry 走与 sessionMemoryLite 相同的串行队列模式
// 但不依赖 .babel-o/session-memory.md，写入 .babel-o/behavior-trace.jsonl
```

### 5.5 串行化与防抖

- **串行**：复用 `sessionMemoryQueue` 模式（Promise 链式）
- **防抖**：trajectory-end 触发条件本身是计数器（每 N 个工具），无需额外防抖
- **异常驱动触发**（error / denial）：在同一个 turn 内多次同类型异常只写**合并**条目（取最后一条 + 计数）

---

## 6. Nexus 端 behaviorMonitor

### 6.1 文件

**新增**：`src/nexus/behaviorMonitor.ts`（~300 行）

### 6.2 数据流

```
SessionChannel eventBus
       │ 订阅
       ▼
crossSessionAggregator
       │ 维护滚动窗口（默认 5 分钟 / 最近 100 session）
       ▼
patternDetector
       │ 3 类跨 session 触发器
       ▼
hot-path / tool-storm / scope-drift-wave
       │
       ├─→ 写一条 BehaviorTraceEntry（标注 source=Nexus）
       │
       └─→ hintDispatcher
              │
              ▼
       ┌──────────────────────────┐
       │ 安全窗口判定              │
       │ - 不在 tool execution 中  │
       │ - 不在用户等待响应中      │
       │ - session 未在静默模式    │
       │ - session 距上次 hint ≥5m │
       └──────────────────────────┘
              │
              ▼
       通过 SessionChannel 注入 system event
              │
              ▼
       contextAssembler 读取（已有 system event 注入路径）
              │
              ▼
       注入 model context 末尾
```

### 6.3 跨 session 3 类触发器

#### hot-path
**含义**：同一文件/路径 glob 在 N 个 session 中都被错误处理
```typescript
{
  trigger: 'hot-path',
  pattern: 'src/runtime/sessionMemoryLite.ts',
  sessionIds: ['s-001', 's-014', 's-022'],
  occurrenceCount: 8,
  windowMs: 5 * 60_000,
}
```

#### tool-storm
**含义**：同一 tool 在 M 分钟内被同一 session 调 > K 次
```typescript
{
  trigger: 'tool-storm',
  toolName: 'Read',
  sessionId: 's-014',
  callsPerMinute: 35,
}
```

#### scope-drift-wave
**含义**：短时间内多 session 都漂出同一 scope
```typescript
{
  trigger: 'scope-drift-wave',
  driftTarget: 'src/cli/commands/*',
  sessionIds: ['s-002', 's-007', 's-009'],
  windowMs: 3 * 60_000,
}
```

### 6.4 资源模型

- 复用 `everCoreRuntimeManager` 的 5min idle TTL
- 跨 session 状态（滚动窗口 / sessionId 集合 / 计数器）以**纯内存 Map** 持有
- Nexus shutdown 时 `monitor.shutdown()` 清理
- **不持久化**——重启即清空（避免 stale pattern）

---

## 6.5 `bbl loop` 集成

> **关键事实**：`bbl loop` 是**多面板 TUI 驱动**（workspaces/tabs/panes 树），每 pane 绑定一个 session。**PaneStatus 是 server 投影**——`loopDiagnostics.ts:64 derivePaneStatus` 是 source of truth，Go 端 `LoopModel.PaneStatus`（`clients/go-tui/internal/loop/model.go:25`）只是渲染端镜像。这跟 BehaviorMonitor "Nexus 端做跨 session 决策" 的架构**天然契合**。

### 6.5.1 现有 PaneStatus（6 态，server 投影）

```go
// clients/go-tui/internal/loop/model.go:25-34
const (
  StatusIdle PaneStatus = iota
  StatusWorking
  StatusBlocked
  StatusWaiting
  StatusDrift
  StatusDone
)
```

```ts
// src/runtime/loopDiagnostics.ts:37-44
const STATUS_PRIORITY: Record<PaneStatus, number> = {
  blocked: 5, drift: 4, waiting: 3, done: 2, working: 1, idle: 0,
}
```

→ 用户在 `bbl loop` 多面板里**一眼看到**所有 session 的状态。**这套投影机制是 BehaviorMonitor hint 注入的天然管道**。

### 6.5.2 P1 集成：新增 `StatusBehaviorHint` 态

> **状态**：
> - ✅ Server 端 `applyBehaviorHint()` + `STATUS_PRIORITY.behaviorHint: 6` 已落地（PR-6, 2026-06-16）
> - ✅ HTTP 响应 `pendingHints` / `lastHintAt` / `lastHintPattern` 3 个新字段已落地（PR-14, 2026-06-16）
> - ⏸ Go 端 `model.go` 改 enum + `chrome.go` 渲染 — 留作 Go mirror（独立 repo）

**服务端**（`src/runtime/loopDiagnostics.ts`）：
```ts
case 'behavior_hint':
  pendingHints += 1
  if (STATUS_PRIORITY.behaviorHint >= STATUS_PRIORITY[winner]) {
    winner = 'behaviorHint'
  }
  break

// STATUS_PRIORITY 加：
// behaviorHint: 6  // 最高优先级
```

**HTTP 响应**（`/v1/runtime/loop/health`，`src/nexus/app.ts:931`）：
```ts
panes.push({
  sessionId,
  agent: 'bbl',
  status: status.status,         // 可能是 'behaviorHint'
  pendingHints: status.pendingHints,  // ★ 新增
  lastHintAt: status.lastHintAt,        // ★ 新增
  lastHintPattern: status.lastHintPattern,  // ★ 新增
  // ... 现有字段保持
})
```

**Go 端**（`clients/go-tui/internal/loop/model.go`）：
```go
const (
  StatusIdle PaneStatus = iota
  StatusWorking
  StatusBlocked
  StatusWaiting
  StatusDrift
  StatusDone
  StatusBehaviorHint  // ★ 新增；String() 渲染为 "behavior_hint"
)
```

**渲染**（`internal/loop/chrome.go`）：
- `StatusBehaviorHint` 时 pane 边框颜色 = 黄
- 状态行显示 `[hint] pattern: <lastHintPattern>`
- 通知气泡（`internal/loop/notifications/`）触发"view_trace" action

### 6.5.3 集成点矩阵

| 集成点 | 优先级 | 改动 | 阶段 | 状态 |
|---|---|---|---|---|
| **A. PaneStatus 加 `StatusBehaviorHint`** | P1 高 | `loopDiagnostics.ts` +15 行 / `model.go` +3 行 / `chrome.go` +20 行 | P1 | ✅ Server 端落地（PR-6 + PR-14, 2026-06-16）；⏸ Go 端 mirror 留作 PR-17（独立 repo） |
| **B. 复用 `internal/loop/notifications/`** | P2 中 | notifications 包接入 `behavior_hint` 消息类型 | P2 | ⏸ 待 Go 端 |
| **C. reconcile_worker 订阅 WebSocket** | P2 中 | `reconcile_worker.go` 双向：HTTP 轮询 + WS 推送 | P2 | ⏸ 待 Go 端 |
| **D. 新增 "Behavior" Tab** | P2 低 | `LoopModel` 增 tab 类型；新增 `BehaviorPaneModel` | P2（独立工作） | ⏸ 待 Go 端 |
| **E. cross-session pattern 可视化** | P2 杀手锏 | 多 pane + 模式栏组合渲染 | P2 | ⏸ 待 Go 端 |

### 6.5.4 Phase 2 行为面板（独立工作，不阻塞 P1）

```
Workspace: ws-default
  Tab: Sessions
    Pane: [session-A] [session-B] [session-C]
  Tab: Behavior  ← ★ Phase 2 新增
    Pane: [live entries]  [cross-session patterns]  [recommendations]
```

**渲染示例**（跨 session pattern 视图）：

```
┌─ session-A ──┬─ session-B ──┬─ session-C ──┐
│ [working]    │ [hint]       │ [drift]      │
│              │ path-not-    │              │
│              │  found on    │              │
│              │  session-    │              │
│              │  Memory...   │              │
└──────────────┴──────────────┴──────────────┘
┌─ cross-session patterns ──────────────────────┐
│ ⚠ hot-path: src/runtime/sessionMemoryLite.ts  │
│   3 sessions hit this in last 5min             │
│   → consider: glob first                       │
└───────────────────────────────────────────────┘
```

→ **多面板布局 + 跨 session 模式 + 实时 hint**——自检自优化的可视化兑现。

### 6.5.5 P1 集成改动预算

> **实际落地（2026-06-16）**:
> - Server 端步骤 1+2+3 已完成 (PR-6 + PR-14)
> - Node 测试：35 unit (PR-6 + PR-14) + 5 e2e (PR-14) = 40 测试
> - Go 端步骤 4+5+6 ⏸ 留作 PR-17 (独立 repo `bbl-loop`)

| 步骤 | 文件 | 估算行数 | 风险 | 状态 |
|---|---|---|---|---|
| 1. `loopDiagnostics.ts` | 改 | +15 | 低 | ✅ PR-6 (2026-06-16) |
| 2. `nexus/app.ts` (loop/health) | 改 | +15 | 低 | ✅ PR-14 (2026-06-16) |
| 3. `shared/events.ts` (`behavior_hint` 事件类型) | 改 | +5 | 低 | ✅ (PR-6 一并) |
| 4. Go `model.go` PaneStatus | 改 | +3 | 低 | ⏸ PR-17 (Go mirror) |
| 5. Go `chrome.go` 渲染 hint | 改 | +20 | 低 | ⏸ PR-17 (Go mirror) |
| 6. 测试（Node + Go） | 新 | ~150 | 0 | ✅ Node 40 测试; ⏸ Go 测试待 PR-17 |
| **总计** | | **~210 行 / 1-2 天** | **bbl loop 现有 6 态完全不变 (INV-12 守恒)** | 50% 落地 (server 侧) |

### 6.5.6 不变量（bbl loop 集成专属）

| ID | 不变量 |
|---|---|
| INV-12 | **6 态行为不变**——`StatusBehaviorHint` 是新增，**不改现有 6 态的优先级与判定逻辑** |
| INV-13 | **`StatusBehaviorHint` 优先级最高**（6）——被 hint 的 session 最值得关注 |
| INV-14 | **不破坏 notifications 包既有契约**——behavior_hint 作为新 `NotificationItemType` 加入，不改现有类型 |
| INV-15 | **Go 端 PaneStatus 是 server 投影的镜像**——Go 端 enum 与 server `loopDiagnostics.ts` 保持一一对应；任何新增 PaneStatus 必须**两边同步**

---

## 7. 实时提示通道（live hint）

### 7.1 注入协议

```typescript
// SessionChannel 新增 message type
type BehaviorHintMessage = {
  type: 'behavior_hint'
  sessionId: string
  hint: {
    pattern: string                  // 'hot-path: src/runtime/sessionMemoryLite.ts'
    occurrences: number
    windowMs: number
    affectedSessions: number
    suggestedAction: string          // 'use glob before read'
    confidence: number
  }
  notificationRequired: true          // 强制显式通知
}
```

### 7.2 contextAssembler 读取

```typescript
// 在已有 system event 注入路径添加 case
case 'behavior_hint':
  return [
    `<!-- Behavior Monitor: live hint -->`,
    `Pattern: ${hint.pattern}`,
    `Other sessions in last ${hint.windowMs/1000}s: ${hint.affectedSessions}`,
    `Suggestion: ${hint.suggestedAction}`,
    `Confidence: ${hint.confidence}`,
    `Source: Nexus BehaviorMonitor`,
  ].join('\n')
```

### 7.3 用户通知机制

> **Q3 决策**："默认开启 + 通知用户"——hint 注入到 model context 时，**必须在用户 UI（TUI / log）同步打印一行显著提示**：

```
[Behavior Monitor] 实时提示已注入 → session-014
  Pattern: hot-path on src/runtime/sessionMemoryLite.ts
  Reason: 3 other sessions hit path-not-found in last 5 min
  Action: 建议先用 glob 列出文件
  Disable: BABEL_O_BEHAVIOR_LIVE_HINTS=false
```

**关键不变量**：
- 用户**永远在循环里**——不静默注入
- 通知内容包含 `pattern` / `reason` / `action` / `disable` 4 项
- 单次 session 注入频率硬上限 1 / 5min（防风暴）

### 7.4 安全窗口判定

`hintDispatcher.dispatch(hint, targetSession)` 必须满足**全部**：

1. `targetSession.status === 'between_turns'`
2. `targetSession.currentPhase !== 'tool_execution'`
3. `!targetSession.silentMode`
4. `now - targetSession.lastHintAt >= 5 * 60 * 1000`
5. `hint.confidence >= 0.8`

任一不满足 → **丢弃**，不重试（避免积压）。

---

## 8. CLI 表面

**新增**：`src/cli/commands/behavior.ts`（~250 行）

### 8.1 子命令

| 命令 | 功能 |
|---|---|
| `bbl behavior review [--since 7d] [--trigger error]` | 列最近 N 条轨迹，支持 trigger 过滤 |
| `bbl behavior stats [--since 7d]` | 聚合：触发频次 / 错误模式 / 工具失败率 / 跨 session hot-path top 10 |
| `bbl behavior pattern [--since 7d] [--analyze]` | 找 pattern；`--analyze` 调 haiku/opus 深度分析；输出到 stdout 或 `--write recommendations.md` |
| `bbl behavior live` | TUI 实时面板：当前活跃 session / 最近轨迹 / 活跃 hints |

### 8.2 输出格式

`bbl behavior stats` 示例：

```
Behavior Stats (last 7 days)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Sessions: 47
Total trace entries: 312

By trigger:
  error              42  (13.5%)
  denial             18  (5.8%)
  scope-drift        11  (3.5%)
  trajectory-end     89  (28.5%)
  user-redirect      23  (7.4%)
  hot-path (cross)    8  (2.6%)
  tool-storm (cross)  3  (1.0%)
  scope-drift-wave    2  (0.6%)

Top error codes:
  TOOL_NOT_FOUND           28
  PERMISSION_DENIED        18
  CONTEXT_LIMIT_EXCEEDED    7

Top hot-paths:
  src/runtime/sessionMemoryLite.ts  8 occurrences / 3 sessions
  src/nexus/app.ts                  5 occurrences / 2 sessions
```

### 8.3 推荐输出（`pattern --analyze`）

```
Patterns detected (last 7 days)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Pattern 1: path-not-found on sessionMemoryLite.ts
  Occurrences: 8 (3 sessions)
  Likely cause: 文件路径含 dynamic segment，agent 猜错
  Suggested fix: pre-task path discovery via glob
  Confidence: 0.85

Pattern 2: scope-drift on cli/commands/* during runtime refactor
  Occurrences: 5 (4 sessions)
  Likely cause: task scope 声明过宽
  Suggested fix: tighten task scope to specific subdirectory

Write to recommendations.md? [y/N]
```

---

## 9. REST + WebSocket 表面

### 9.1 REST（新增 `src/nexus/app.ts` 路由）

| 路径 | 方法 | 功能 |
|---|---|---|
| `/v1/behavior/entries` | GET | 列轨迹（带 `since` / `trigger` / `sessionId` 过滤） |
| `/v1/behavior/stats` | GET | 聚合统计（对应 CLI `stats`） |
| `/v1/behavior/patterns` | GET | 跨 session 模式（对应 CLI `pattern`） |
| `/v1/behavior/recommendations` | GET / POST | 读 / 写 `recommendations.md` |
| `/v1/behavior/observe` | WS | 实时推送：轨迹写入 / hint 注入 / pattern 检测 |

### 9.2 WebSocket 协议

```typescript
// client → server
{ type: 'subscribe', channels: ['entries', 'hints', 'patterns'] }

// server → client
{ type: 'entry', entry: BehaviorTraceEntry }
{ type: 'hint', hint: BehaviorHintMessage }
{ type: 'pattern', pattern: CrossSessionPattern }
```

---

## 10. 配置与默认值

| env var | 默认 | 含义 |
|---|---|---|
| `BABEL_O_BEHAVIOR_TRACE_ENABLED` | `true` | 总开关 |
| `BABEL_O_BEHAVIOR_TRAJECTORY_INTERVAL` | `20` | trajectory-end 工具间隔 |
| `BABEL_O_BEHAVIOR_SELF_ASSESS` | `rule` | `rule` \| `llm` \| `off` |
| `BABEL_O_BEHAVIOR_HOT_PATH_THRESHOLD` | `3` | hot-path 跨 session 阈值 |
| `BABEL_O_BEHAVIOR_TOOL_STORM_THRESHOLD` | `30` | tool-storm calls/min |
| `BABEL_O_BEHAVIOR_LIVE_HINTS` | **`true`** | 实时提示开关 |
| `BABEL_O_BEHAVIOR_HINT_MIN_CONFIDENCE` | `0.8` | hint 最低 confidence |
| `BABEL_O_BEHAVIOR_RECOMMENDATIONS_FILE` | `.babel-o/recommendations.md` | 推荐输出路径 |

**`BABEL_O_BEHAVIOR_LIVE_HINTS` 默认 `true` 是有意为之**（Q3 决策）——自检价值的核心兑现，依赖用户能即时看到提示；但配合"通知用户"机制保持透明。

---

## 11. 测试策略

### 11.1 session 内捕获测试

- `test/behavior-trace.test.ts`（~300 行）
- 覆盖：5 类触发器 / 规则自评 / 文件写入 / 串行化 / 异常合并

### 11.2 Nexus 端监控测试

- `test/behavior-monitor.test.ts`（~350 行）
- 覆盖：3 类跨 session 触发器 / 实时 hint 注入 / 安全窗口判定 / 频率上限
- 用 in-memory `SessionChannel` fixture，**不写真实 session**

### 11.3 集成测试

- `test/behavior-integration.test.ts`（~200 行）
- 3 个 session 同时跑模拟事件，验证 hot-path 检测 + hint 注入到活跃 session
- **测试隔离**（[[babel-o-test-config-isolation]]）：tmp dir / 强制 `:memory:` storage

### 11.4 CLI 表面

- `test/cli-behavior.test.ts`（~200 行）
- 覆盖 4 个子命令的输出格式 + 过滤参数

### 11.5 回归保护

- `test/sessionMemoryLite-regression.test.ts`（~100 行）
- 确保 `forced` / `growth_threshold` 路径行为不变
- 确保 `.babel-o/session-memory.md` 写入路径不受影响

---

## 12. 不变量与红线

| ID | 不变量 | 来源 |
|---|---|---|
| INV-1 | **never auto-switch model** | [[babel-o-model-catalog-governance]] |
| INV-2 | **never inject hint without confidence ≥ 0.8** | 本设计 |
| INV-3 | **never inject mid-tool-execution** | 本设计 |
| INV-4 | **never silent-inject**——必须显式通知用户 | Q3 决策 |
| INV-5 | **single-session injection 频率 ≤ 1 / 5min** | 本设计 |
| INV-6 | **user review required** before recommendations → next session prompt | Q3 决策 |
| INV-7 | **soft timeouts** on `bbl behavior pattern --analyze` | [[babel-o-soft-recoverable-timeouts]] |
| INV-8 | **测试隔离**——不写真实 `~/.babel-o/...` 路径 | [[babel-o-test-config-isolation]] |
| INV-9 | **正交工具**——4 个 CLI 子命令各司其职 | [[feedback-tool-boundary-granularity]] |
| INV-10 | **P0 回归 first**——不动 `forced` / `growth_threshold` | [[feedback-babel-o-p0-regression-focus]] |
| INV-11 | **不复活** sessionMemoryLite 的 `natural_pause` 频繁触发 | 本设计动机 |
| INV-12 | **6 态行为不变**——`StatusBehaviorHint` 是新增，**不改现有 6 态的优先级与判定逻辑** | §6.5 bbl loop 集成 |
| INV-13 | **`StatusBehaviorHint` 优先级最高**（6）——被 hint 的 session 最值得关注 | §6.5 |
| INV-14 | **不破坏 notifications 包既有契约**——`behavior_hint` 作为新 `NotificationItemType` 加入，不改现有类型 | §6.5 |
| INV-15 | **Go 端 PaneStatus 是 server 投影的镜像**——Go 端 enum 与 server `loopDiagnostics.ts` 保持一一对应；任何新增 PaneStatus 必须**两边同步** | §6.5 |

---

## 13. 迁移路径

### Phase 1: 并行上线（零行为变化）
- 新增 `behaviorTrace.ts` + `behaviorMonitor.ts`
- 新增 4 个 CLI 子命令
- 新增 REST + WebSocket 路由
- **sessionMemoryLite 行为完全不变**
- 默认 `BABEL_O_BEHAVIOR_TRACE_ENABLED=true`，用户可关

### Phase 2: sessionMemoryLite.natural_pause 标记 deprecated
- 在 JSDoc 加 `@deprecated since 2026-06-16`
- 加 env `BABEL_O_SESSION_MEMORY_LITE_NATURAL_PAUSE` 控制（默认 `true` 保持现状）
- 更新 test fixture 注明"deprecated path"

### Phase 3: 默认切换
- `BABEL_O_SESSION_MEMORY_LITE_NATURAL_PAUSE` 默认 `false`
- `natural_pause` 不再自动触发，需 opt-in
- 更新 test:1891、:3366 的 expected 行为

### Phase 4: 移除
- 完全删除 `natural_pause` 决策分支
- 删除对应 test
- 文档迁移

> **当前不承诺 Phase 3/4 时间表**——视 Phase 1/2 实际使用数据决定。

---

## 14. ADR 决策记录

### ADR-1: 重新定位为"行为轨迹"而非"长期记忆"

**Context**: 现有 `natural_pause` 写入 `.babel-o/session-memory.md`，但无代码读这个文件。

**Decision**: 重新定位为"行为轨迹 + 自检复盘"，而非"长期记忆"。

**Consequences**:
- (+) 数据真正被消费（CLI / REST / 跨 session 监控）
- (+) 与 `compact.ts` / Plan C 长期记忆正交
- (-) "memory" 命名让位给 Plan C，未来用户面叙述要清晰区分

### ADR-2: Nexus 常驻架构做跨 session 监控

**Context**: 单 session 看不到跨 session 模式；Nexus 已是常驻服务。

**Decision**: 在 Nexus 端新增 `BehaviorMonitor`，订阅 `SessionChannel` eventBus，做跨 session 聚合 + 实时 hint 注入。

**Consequences**:
- (+) 兑现"自检 + 自优化"实时闭环
- (+) 复用 `everCoreRuntimeManager` 资源模型
- (-) Nexus 端新增内存状态（需 5min 滚动窗口）
- (-) 注入 hint 是侵入式操作（必须配强安全窗口 + 通知）

### ADR-3: 实时 hint 默认开启 + 通知用户

**Context**: hint 价值取决于"agent 当时就能用上"；但 INV-1 反对"auto-switch"。

**Decision**: `BABEL_O_BEHAVIOR_LIVE_HINTS` 默认 `true`，但每次注入必须**显式通知用户**（TUI / log 显著打印一行）。

**Consequences**:
- (+) hint 价值最大化
- (+) 用户永远在循环里（透明）
- (+) 配合 INV-2/3/4/5 多道闸
- (-) 与 [[babel-o-model-catalog-governance]] "never auto-switch" 精神有张力——但 hint 不是 model selection，且有"通知"作软门控
- (-) 默认开启 = 必须保证 hint 质量（confidence ≥ 0.8 + 安全窗口）

### ADR-4: 零默认 LLM 成本（rule 版自评）

**Context**: 写时调 LLM 持续增成本；离线 batch 调 LLM 用户可控。

**Decision**: 默认 `BABEL_O_BEHAVIOR_SELF_ASSESS=rule`（零 LLM 成本）；用户可显式 `--analyze` 触发 haiku 离线分析。

**Consequences**:
- (+) 零默认成本，行为可接受
- (+) 规则版覆盖 80% 常见 pattern
- (-) 规则未覆盖的 pattern 需要 LLM 补（但用户主动触发）

### ADR-5: 4 个 CLI 子命令 vs 单一命令

**Context**: 工具边界原则（[[feedback-tool-boundary-granularity]]）要求正交、清晰边界。

**Decision**: 拆为 `review` / `stats` / `pattern` / `live` 4 个子命令，各自单一职责。

**Consequences**:
- (+) 用户认知负担小（`bbl behavior <子命令>`）
- (+) 易于测试（每个子命令独立 fixture）
- (-) 多 4 个 help 文本需要维护

### ADR-6: JSONL vs Markdown 存储

**Context**: `.babel-o/session-memory.md` 是 markdown 摘要（设计给"人看"）；新系统是结构化数据（设计给"工具消费"）。

**Decision**: 用 JSONL（每行一条 `BehaviorTraceEntry`），append-only。

**Consequences**:
- (+) 易于 grep / jq / Python pandas
- (+) 第三方工具能消费
- (+) append-only = 简单
- (-) 不直接给人看（但 `bbl behavior review` 提供美化输出）

---

## 15. 改动预算

| 步骤 | 文件 | 行数 | 风险 |
|---|---|---|---|
| 1. `behaviorTrace.ts` | 新 | ~250 | 0（新增） |
| 2. `behaviorMonitor.ts` | 新 | ~300 | 0（新增） |
| 3. `behaviorChannel.ts` | 新 | ~100 | 0（新增） |
| 4. `LLMCodingRuntime.ts` | 改 | +30 | 低（旁路插桩） |
| 5. `nexus/app.ts` | 改 | +50 | 低（新增路由） |
| 6. `everCoreRuntimeManager.ts` | 改 | +20 | 低（注册回调） |
| 7. `cli/commands/behavior.ts` | 新 | ~250 | 0 |
| 8. `test/behavior-trace.test.ts` | 新 | ~300 | 0 |
| 9. `test/behavior-monitor.test.ts` | 新 | ~350 | 0 |
| 10. `test/behavior-integration.test.ts` | 新 | ~200 | 0 |
| 11. `test/cli-behavior.test.ts` | 新 | ~200 | 0 |
| 12. `test/sessionMemoryLite-regression.test.ts` | 新 | ~100 | 0 |
| 13. `docs/nexus/reference/behavior-monitor.md` | 新 | ~600 | 0 |
| **Subtotal (Node)** | | **~2750 行 / 7-8 工作日** | |
| | | | |
| **bbl loop 集成（P1）** | | | |
| 14. `loopDiagnostics.ts` | 改 | +15 | 低 |
| 15. `nexus/app.ts` (loop/health) | 改 | +15 | 低 |
| 16. `shared/events.ts` (`behavior_hint` 事件) | 改 | +5 | 低 |
| 17. Go `model.go` PaneStatus | 改 | +3 | 低 |
| 18. Go `chrome.go` 渲染 hint | 改 | +20 | 低 |
| 19. 测试（Node + Go） | 新 | ~150 | 0 |
| **Subtotal (P1 集成)** | | **~210 行 / 1-2 工作日** | **6 态完全不变** |
| | | | |
| **bbl loop 集成（P2，独立工作）** | | | |
| 20. Go `notifications/` 接入 | 改 | +30 | 中 |
| 21. Go `reconcile_worker.go` WS 订阅 | 改 | +50 | 中 |
| 22. Go `BehaviorPaneModel` | 新 | ~200 | 0 |
| 23. Go `cross-session` 视图 | 新 | ~150 | 0 |
| **Subtotal (P2 集成)** | | **~430 行 / 2-3 工作日** | |
| | | | |
| **总计** | | **~3390 行 / 11-13 工作日** | **不破坏现有** |

---

## 16. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 跨 session 内存状态膨胀 | 低 | 中 | 滚动窗口 5min + sessionId LRU 上限 100 |
| hint 注入干扰 agent 决策 | 中 | 中 | INV-2/3/4/5 多道闸 + 用户通知 |
| 规则版自评误判 | 中 | 低 | 置信度字段暴露，用户可人工 override |
| `bbl behavior pattern --analyze` 长时间 hang | 中 | 低 | 软超时（[[babel-o-soft-recoverable-timeouts]]）+ Ctrl-C 安全 |
| 与 Plan C 长期记忆未来冲突 | 低 | 中 | ADR-1 明确边界 + INV-11 红线 |
| WebSocket 连接数过多打垮 Nexus | 低 | 中 | 单 session 单连接 + 5min idle 自动断开 |

---

## 17. 开放问题

1. **跨 session 模式持久化**：当前 5min 滚动窗口是纯内存，Nexus 重启清空。是否需要持久化到 `behavior-patterns.jsonl`（append-only，外部 logrotate）？→ 待 Phase 1 上线后看实际使用决定。
2. **hint 注入位置**：当前是 system event 末尾。是否应允许在 user turn 前的"准备阶段"注入（更可见但更侵入）？→ Q3 决策已选"system event 末尾 + 通知用户"，待实际验证。
3. **LLM 自评的 prompt 模板**：rule 版的规则集谁维护？是否提供 `BABEL_O_BEHAVIOR_RULES_FILE` 让用户扩展？→ Phase 1 暂不实现，Phase 2 视需求。
4. **与 `taskScope` 声明系统的耦合**：scope-drift 触发器依赖 `taskScope` 字段。如果用户没声明 scope，触发器不工作。是否需要 fallback（用 cwd 推断）？→ Phase 1 暂不实现。

---

## 18. 参考

- `src/runtime/sessionMemoryLite.ts` — 现有实现，本次重构的对象
- `src/runtime/sessionSummary.ts` — 抽取逻辑（部分复用）
- `src/runtime/compact.ts` — /compact 路径（保留）
- `src/runtime/loopDiagnostics.ts` — PaneStatus 服务端投影（§6.5 集成点）
- `src/nexus/everCoreRuntimeManager.ts` — 资源模型（复用）
- `src/nexus/app.ts:931` `/v1/runtime/loop/health` — 现有 health 端点（§6.5 扩展点）
- `src/cli/commands/loop.ts` — `bbl loop` CLI 入口
- `clients/go-tui/internal/loop/model.go:25` — PaneStatus enum（§6.5 镜像）
- `clients/go-tui/internal/loop/notifications/` — 通知包（§6.5 复用）
- `clients/go-tui/internal/loop/reconcile_worker.go` — 轮询/订阅（§6.5 P2 扩展点）
- `docs/nexus/CONTEXT_UPGRADE_ROADMAP.md` — 上下文升级大图
- `/Users/tangyaoyue/Desktop/BabeL-O-Memory-NativeTool-Plan-C.md` — Plan C 长期记忆（边界外）
- [[babel-o-model-catalog-governance]] — never auto-switch
- [[babel-o-soft-recoverable-timeouts]] — 软超时
- [[feedback-tool-boundary-granularity]] — 正交工具
- [[babe-l-o-memoryos-naming]] — 命名规范
- [[babel-o-test-config-isolation]] — 测试隔离
- [[feedback-babel-o-p0-regression-focus]] — P0 回归 first
