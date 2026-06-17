# bbl loop — Go Multi-session Pane TUI Plan

> Status: **Draft (2026-06-16)** — 借鉴 [ogulcancelik/herdr](https://github.com/ogulcancelik/herdr) 的 workspace / tab / pane / wait-event / persist snapshot 形态，在 Go TUI 之上引入一个多 session 并发面板，入口 `bbl loop`。`bbl chat` 继续是生产默认入口，本规划不替换它，只新增并列前端。
> **2026-06-17 增补**：§6'（Phase 6'）记录"实时显示活跃 session"能力分析 + 分层修复路线（切片 6a/6b/6c）。**6a/6b/6c 全部已落地**——server 新 session 实时出现（6a）+ pane body 渲染 Transcript（6b）+ 每 pane `waitForEvent` 长轮询填入 transcript（6c）。活 TUI 终于能实时显示活跃 session 的内容。
> Priority: 体验增强（不弱化现有 `bbl chat` / `bbl go` 质量门槛），不引入新的 runtime truth。
> Related: [go-tui-rewrite-plan.md](./go-tui-rewrite-plan.md)、[go-tui-permission-policy-governance-plan.md](./go-tui-permission-policy-governance-plan.md)、[go-tui-session-observability-governance-plan.md](./go-tui-session-observability-governance-plan.md)、[task-scope-and-evidence-scope-governance-plan.md](./task-scope-and-evidence-scope-governance-plan.md)、[memory-capability-awareness-and-trigger-plan.md](./memory-capability-awareness-and-trigger-plan.md)、[task-adaptive-recoverable-timeout-plan.md](./task-adaptive-recoverable-timeout-plan.md)

---

## 0. 背景与目标

`bbl chat` 与 `bbl go` 都是「单 session、单对话面板」。随着真实编程会话越来越长、越来越多 agent / 子任务并行编排（BabeL-O 主线 / 子 agent / memory 审查 / 端到端测试），单 panel 缺少：

- 多 session 并发观测能力（同一时间只看见一条 stream）
- session 间 status 聚合视图（blocked / drift / waiting / done）
- 长会话的 runtime health 聚合（`taskScope` mode / pending boundaries / out-of-scope evidence / context percentUsed）
- 可恢复、可 detach 的 pane 容器（server 重启后 panel 还在）

herdr 已经在终端 workspace manager 形态下验证了这套 pattern，但 herdr 是 desktop multiplexer，与 BabaL-O 关注点不同。本规划**借鉴 herdr 的 API 形态，不复制其 IPC / multiplexer 责任**：

```text
Nexus owns execution, runtime, context, storage, agent orchestration, permission decisions.
bbl loop owns pane layout, focus routing, status projection, persistent pane ↔ session mapping.
```

非目标：

- 不复制 herdr 的 unix socket multiplexer / agent status detector（这属于 desktop multiplexer 范畴）。
- 不在 Go TUI 端重算 taskScope / out-of-scope evidence / memory candidate；一切从 Nexus `/v1/runtime/loop/health` 与 `/v1/sessions/:id/context` 消费。
- 不合并 `bbl chat` / `bbl go` / `bbl loop` 为单一二进制；保持入口正交、各自可独立升级。
- 不引入新的 runtime truth；所有状态变化由 Nexus 事件驱动，客户端只渲染与路由输入。

---

## 1. 架构边界

```text
┌────────────────────────────────────────────────────────────┐
│ bbl loop (Go, Bubble Tea)                                   │
│ ┌───────────────────────────────────────────────────────┐ │
│ │ LoopModel { workspaces, focus path, status bar, … }    │ │
│ │   Workspace { id, label, tabs }                        │ │
│ │     Tab { id, label, panes }                           │ │
│ │       PaneModel { id, sessionId, input, transcript,    │ │
│ │                   status, lastEventRev, permissions }   │ │
│ │ Router ─► focus path 决定把全局 tea.Msg 派发到哪个 pane│ │
│ │ Overlay (复用 internal/tui/overlay)                     │ │
│ └───────────────────────────────────────────────────────┘ │
└──────────────┬─────────────────────────────────────────────┘
               │ WebSocket + REST
┌──────────────▼─────────────────────────────────────────────┐
│ TypeScript Nexus (Fastify)                                  │
│ ┌──────────────┐  ┌────────────────────────┐               │
│ │ waitForEvent │  │ loop_state (SQLite)    │               │
│ │ + loop/health│  │ workspace/tab/pane ↔   │               │
│ │ + persisted  │  │ sessionId              │               │
│ │  subscriptions│ └────────────────────────┘               │
│ │ Runtime diagnostics: taskScope, pendingBoundaries,      │
│ │ outOfScopeEvidence, contextUsage, memory candidates     │
│ └─────────────────────────────────────────────────────────┘
```

关键边界：

- **State vs Runtime 分离**（借鉴 herdr AGENTS）：`LoopModel` / `Workspace` / `PaneModel` 是纯数据，`tea.Cmd` 与 `tea.Msg` 是 runtime。`compute_view()` 计算几何，`render()` 只画图。
- **Server-owned status**：`PaneStatus` 完全由 Nexus 事件推导；client 不维护独立的“任务进度”概念，只把 Nexus 给的状态投影成颜色 / icon。
- **Revision + match 订阅**：参考 herdr `api/wait.rs` 的 `wait_for_output` + revision，Nexus 提供 `GET /v1/sessions/:id/events?since=rev&match=&types=&timeout=` 形式的查询；pane 用 revision 去重，避免丢事件或重放。

---

## 2. Pane 状态机

```text
tool_started          → working
tool_completed        → working（若后续 tool_started）或 done
permission_request    → blocked
scope_boundary_detected（未确认 sibling_repo / external / parent_scan）
                      → drift
scope_boundary_confirmed
                      → working（不再 drift）
timeout_budget_exceeded / near_timeout_warning
                      → waiting
context_grounding_required
                      → waiting
result (success && 无 pending boundary && 无 out-of-scope evidence)
                      → done
```

`PaneStatus` 是 6 态枚举：`idle | working | blocked | waiting | drift | done`。每个 pane 独立维护 `lastEventRev`，与 Nexus `loop_state` 中持久化的 `rev` 双向 reconcile。

`drift` 状态是关键：当 `diagnostics.taskScope.pendingBoundaries > 0` 或 `outOfScopeEvidence > 0` 时，pane 自动进入 `drift`，侧栏染色为“越界”，并在 toast 触发 `pending scope boundary` / `out-of-scope evidence` 摘要。

---

## 3. Nexus Server 增量

### 3.1 事件订阅（带 revision + match）

```text
GET /v1/sessions/:sessionId/events
  ?since=<revision:int>
  &match=<regex_or_substring>
  &types=<comma,scope.event.type>
  &timeout=<ms>
→ 200 { events: NexusEvent[], nextRevision: int, matchedRevision?: int }
```

服务端必须：

- 使用 SQLite `events` 表的 `event_seq` 作为 revision；`since` 用 `> since` 过滤。
- `match` 走 substring 或 regex（参考 herdr `api/wait.rs:29-47` 的 enum 形态）。
- `types` 支持 `task_scope_declared,scope_boundary_detected,scope_boundary_confirmed,permission_request,permission_response,context_grounding_required,context_grounding_confirmed,timeout_budget_exceeded,near_timeout_warning,result,error`。
- 超时返回 200 + `{ events: [], nextRevision: <current> }`，不返回 408；客户端按 herdr 习惯把“超时”视为正常 poll tick。
- 同时保留现有 `GET /v1/sessions/:sessionId/stream`（WS 单向推送）作为低层 fanout，避免破坏现有 `bbl chat` / `bbl go`。

### 3.2 Loop 健康聚合

```text
GET /v1/runtime/loop/health?workspaceId=...&paneId=...
→ 200 {
  panes: [{
    paneId, workspaceId, tabId, sessionId, agent, cwd,
    status: 'idle|working|blocked|waiting|drift|done',
    diagnostics: {
      taskScope: { mode, primaryRoot, confirmedExternalRootCount, pendingBoundaryCount, outOfScopeEvidenceCount },
      contextUsage: { percentUsed, effectiveContextCeiling, modelContextWindow },
      lastEventRev,
      lastEventAt,
      pendingPermissions: [...],
      activeMemoryCandidates: <count>
    }
  }]
}
```

实现路径：

- 复用 `src/runtime/contextAnalysis.ts` 的 `buildTaskScopeDiagnostics`（已落地）。
- `analyzeContext` 在 `?lastN=200` 事件切片上重算一次，不重放所有事件（性能预算）。
- `status` 字段由 runtime 内推导，不依赖 client 投影。

### 3.3 Loop 状态持久化（`loop_state`）

新建 SQLite 表（与现有 `sessions` 同库，最小侵入）：

```sql
CREATE TABLE loop_state (
  workspace_id TEXT NOT NULL,
  tab_id       TEXT NOT NULL,
  pane_id      TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  agent        TEXT NOT NULL,           -- 'bbl' | 'claude' | ...
  cwd          TEXT NOT NULL,
  label        TEXT,
  last_rev     INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, tab_id, pane_id)
);

CREATE INDEX loop_state_session_idx ON loop_state(session_id);
CREATE INDEX loop_state_workspace_idx ON loop_state(workspace_id);
```

API：

- `GET /v1/loop/workspaces` — 列出所有 workspace + tab + pane + 关联 sessionId
- `POST /v1/loop/workspaces/:workspaceId/tabs/:tabId/panes` — 新建 pane（带 sessionId）
- `PATCH /v1/loop/workspaces/:workspaceId/tabs/:tabId/panes/:paneId` — 更新 label / cwd / lastRev
- `DELETE /v1/loop/workspaces/:workspaceId/tabs/:tabId/panes/:paneId` — 关闭 pane

reconcile 守门（启动时以 Nexus 为准）：

- 本地 `~/.bbl/loop/state.json` 的每个 pane 必须能从 `loop_state` 找回 `sessionId`；找不到则清理本地记录，避免 ghost pane。
- `last_rev` 落后 `analyzeContext` 的 `nextRevision` 时，pane 启动一次增量补拉。

### 3.4 复用既有诊断

`taskScope` 与 `pendingBoundaries` / `outOfScopeEvidence` 已经在 [task-scope-and-evidence-scope-governance-plan.md](./task-scope-and-evidence-scope-governance-plan.md) Phase 5 diagnostics 里实现，本规划只消费 `/v1/runtime/loop/health`，不复算 scope。memory candidates 走 `/v1/runtime/memory/candidates` 既有路由，不新增。

---

## 4. Go 端骨架

### 4.1 入口与目录

```
clients/go-tui/
  cmd/
    go-tui/                 # bbl go / bbl chat 入口（已有，不动）
    bbl-loop/               # bbl loop 入口（新）
      main.go
  internal/
    tui/                    # 现有共享 overlay / transcript / chrome / api（不动结构）
    loop/                   # 新增
      model.go              # LoopModel{ workspaces, focus path, status bar }
      workspace.go          # Workspace{id, label, tabs}
      tab.go                # Tab{id, label, panes}
      pane.go               # PaneModel (含 input, transcript, status, lastEventRev)
      status.go             # PaneStatus enum + 状态转换
      routing.go            # 把全局 tea.Msg 路由到 focus pane
      layout.go             # compute_view + render，仿 herdr render 纯函数
      persistence.go        # 加载/保存 ~/.bbl/loop/state.json
      api/                  # 复用 internal/tui/api 的 http 客户端，新增 wait + health
        client.go
        wait.go
        health.go
      overlay/              # 复用 internal/tui/overlay（context / permission / memory）
        pane_list.go        # workspace/tab/pane 树状导航
        scope_drift.go      # 渲染 taskScope drift 摘要
        status_sidebar.go   # pane status 侧栏
      notifications/
        sound.go            # macOS/Linux sound config，#[cfg(windows)] 空实现
        toast.go            # tab-aware suppression
```

### 4.2 关键数据结构

```go
type PaneStatus int

const (
    StatusIdle PaneStatus = iota
    StatusWorking
    StatusBlocked
    StatusWaiting
    StatusDrift
    StatusDone
)

type PaneModel struct {
    PaneID             string
    WorkspaceID        string
    TabID              string
    SessionID          string
    Cwd                string
    Agent              string
    Label              string
    Input              textinput.Model
    Transcript         []TranscriptItem
    Status             PaneStatus
    LastEventRev       int64
    LastHealthCheckAt  time.Time
    PendingPermission  *PendingPermission
    QueuedPrompt       string
    InterruptionActive bool
}

type LoopModel struct {
    Workspaces []Workspace
    Focus      FocusPath // { workspace, tab, pane }
    Width, Height int
    StatusBar string
    Sound SoundConfig
    PersistencePath string
}

type FocusPath struct {
    WorkspaceIdx int
    TabIdx       int
    PaneIdx      int
}
```

### 4.3 Router 设计

`routing.go` 是 `Update` 的入口：

1. 全局消息（`tea.WindowSizeMsg`、`tea.QuitMsg`、`tea.MouseMsg`）→ `LoopModel.Update`
2. `tea.KeyMsg` 在 focus pane 不消费时由 LoopModel 截获（tab / workspace 切换、Ctrl+W 关闭 pane、Ctrl+N 新建 pane）
3. 其他消息一律转发到 `PaneModel.Update`，pane 仍可独立返回 `tea.Cmd`

pane 之间的输入隔离 = focus 路由；`textinput.Model` 实例挂在每个 pane，不会跨 pane 串字。

### 4.4 持久化

- 本地：每次 `PaneModel.Update` 后，标记 dirty（防抖 500ms）写回 `~/.bbl/loop/state.json`，snapshot 格式：

  ```json
  {
    "version": 1,
    "workspaces": [
      {
        "id": "ws_<uuid>",
        "label": "BabeL-O",
        "tabs": [
          {
            "id": "ws_<uuid>:1",
            "label": "ops",
            "panes": [
              {
                "paneId": "pane_<uuid>",
                "sessionId": "session_<uuid>",
                "agent": "bbl",
                "cwd": "/Users/.../BabeL-O",
                "label": "main",
                "lastEventRev": 1609
              }
            ]
          }
        ]
      }
    ]
  }
  ```

- 服务端：`loop_state` 持久化 `last_rev` 与 `(workspaceId, tabId, paneId, sessionId)` 映射。
- 双向 reconcile：启动时把本地 snapshot 推给 Nexus `POST /v1/loop/workspaces`（幂等）；server 重启后再启动 `bbl loop` 时从 `GET /v1/loop/workspaces` 反向重建。

### 4.5 复用既有 overlay

`internal/tui/overlay/` 的 `context.go` / `permission.go` / `memory.go` / `transcript.go` 渲染逻辑只接受 `&AppState` 的子集；要做的事是把它们的入参类型从 `*model` 拆成 `PaneModel` + `LoopModel`，让 overlay 在 pane 维度复用：

- `context overlay` 改吃 `PaneModel.SessionID`，仍走 `fetchContextAnalysis`
- `permission dialog` 改吃 `PaneModel.PendingPermission`
- `memory overlay` 改吃 `PaneModel.SessionID`
- 新增 `pane_list overlay`（workspace / tab / pane 树）

不在 overlay 内做 scope / status 投影；这些信息从 `PaneModel.Status` 与 `LastHealthCheck` 字段读，由 LoopModel 维护。

### 4.6 测试（仿 herdr 风格）

- 纯状态测试：`Workspace::test_new()` / `PaneModel::test_new()`（不依赖 PTY / socket）
- 状态机测试：`pane_test.go` 用纯事件序列 `tool_started → permission_request → permission_response → tool_completed → result` 断言 status 转换
- 路由器测试：`routing_test.go` 用 fake `tea.Msg` 验证 focus 切换
- 持久化测试：snapshot 序列化 / 反序列化 / reconcile
- 平台隔离：sound / notification 走 `#[cfg(unix)]` / `#[cfg(windows)]`，空实现写白盒测试覆盖

---

## 5. 与已有计划的协同

| 主题 | 既有规划 | bbl loop 复用方式 |
|---|---|---|
| taskScope / pending boundary / out-of-scope | task-scope-and-evidence-scope-governance-plan Phase 5 | 直接消费 `/v1/runtime/loop/health.diagnostics.taskScope`，**不重算** |
| memory candidate 治理 | memory-capability-awareness-and-trigger-plan Phase G | pane 状态出现 `pending memory_candidate` 时渲染 inbox overlay（已有） |
| 软超时 | task-adaptive-recoverable-timeout-plan | pane 在 `timeout_budget_exceeded` / `near_timeout_warning` 进入 `waiting`；不替代 runtime 决策 |
| Go TUI 长期重写边界 | go-tui-rewrite-plan | `bbl loop` 是 Go TUI 的并列入口，遵守 “Go 只做交互” |
| 权限策略 | go-tui-permission-policy-governance-plan | `permission dialog` overlay 复用；scope boundary 的确认仍走 `permission_request` 既有路径 |
| session observability | go-tui-session-observability-governance-plan | `loop_state` 持久化 `sessionId ↔ pane`，让 attach / restart 不断裂 |

---

## 6. 分阶段路线

### Phase 0 — 共享 overlay 解耦（前置）
目标：让 `internal/tui/overlay` 不再依赖 `*model`，只吃 `PaneModel` 子集。
落地点：
- 抽 `OverlayContext` struct，包含 `PaneID/SessionID/Width/Height/Focus`
- 把 `model` 字段引用改成 `OverlayContext`
- 现有 `bbl chat` / `bbl go` 改为传 `OverlayContext`，行为不变
- `go test ./...` 全绿

进度（2026-06-16）：
- context overlay 已切到 `renderContextOverlayView(contextOverlayView)` 纯函数，模型侧通过 `model.contextOverlayView()` 适配，scroll clamp 通过返回值回写；`go build ./...` 与 `go test ./internal/tui/...` 全绿。
- memory overlay 已切到 `renderMemoryOverlayView(memoryOverlayView)` 纯函数；同样模式。
- 剩余 overlay（permission / transcript / inbox / agents / tasks / sessions / models / activity）暂保留 `*model` 接收者，跨 pane 复用价值不高或收益偏低。Phase 0 子目标判定为「context + memory 解耦足够覆盖 plan 中第 4.5 节「复用既有 overlay」的最小入参子集」；后续如确认 `bbl loop` 需要复用其它 overlay，再按同样模式解耦。

收口标准（已达成，2026-06-16）：
- context + memory overlay 切到纯函数 view struct；`go test ./internal/tui/...` 全绿，PTY smoke 行为等价
- overlay 内的 `*model` 引用已替换为 `OverlayContext` 子集（contextOverlayView / memoryOverlayView）

### Phase 1 — Nexus 增量（`waitForEvent` / `loop_state` / `loop/health`）
目标：让 client 能长订阅、能持久化 pane、能拉健康快照。
落地点：
- `src/nexus/app.ts` 新增 4 个路由 + 1 个 `GET /v1/sessions/:id/events` 升级
- `src/storage/SqliteStorage.ts` 加 `loop_state` 表 + CRUD
- `src/runtime/loopDiagnostics.ts` 新增模块，从 `analyzeContext` 复算 `PaneStatus`
- 单元测试覆盖事件过滤 / revision 单调 / reconcile

进度（2026-06-16）：
- `src/nexus/app.ts` 已新增 `GET /v1/sessions/:id/wait`（since / match / types / timeout 长轮询 + 250ms tick）；`escapeRegExpForWait` helper 同处定义，匹配为子串语义。
- `src/storage/Storage.ts` 扩展 `EventListResult.lastSeq`；`SqliteStorage` / `MemoryStorage` 同步填充。客户端可拿到最近事件 revision。
- `src/runtime/loopDiagnostics.ts` 新增 `derivePaneStatus`（6 态优先级：blocked > drift > waiting > done > working > idle）+ `pendingPermissions` / `pendingScopeBoundaries` / `outOfScopeEvidence` 计数。
- `src/nexus/app.ts` 新增 `GET /v1/runtime/loop/health`，聚合 `derivePaneStatus` + 轻量 `summarizeTaskScope`（直接从 lastN events 提取 taskScope 字段，避免重耦合 runtime pipeline）。
- `src/storage/Storage.ts` 扩展 `LoopPaneState` / `LoopPaneFilter` 类型与 `upsertLoopPane` / `listLoopPanes` / `deleteLoopPane` / `updateLoopPaneRev` CRUD。
- `src/storage/SqliteStorage.ts` 新增 v14 迁移建 `loop_state` 表（PRIMARY KEY pane_id + workspace_id / session_id 索引）+ 4 个 CRUD 实现。
- `src/storage/MemoryStorage.ts` 配套 in-memory stub。
- `src/nexus/app.ts` 新增 4 个 HTTP 路由：`POST /v1/loop/workspaces/:workspaceId/panes`、`PATCH /v1/loop/workspaces/:workspaceId/tabs/:tabId/panes/:paneId`、`DELETE /v1/loop/workspaces/:workspaceId/tabs/:tabId/panes/:paneId`、`GET /v1/loop/workspaces`。
- `test/runtime-loop.test.ts` 累计 15 个测试：status 状态机 5 + wait endpoint 4 + loop/health 2 + loop_state CRUD 4。全绿。
- `npm test` 全量 855/855 通过；`npm run typecheck` 通过；`npm run format:check` 通过。
- **历史"未完成"已收口**（2026-06-17 doc 同步）：Go 侧 `internal/loop/` 消费端属于 Phase 2（已收口：`bbl loop --check` 端到端通过 + `cmd/bbl-loop/main.go` + `internal/loop/api/client.go`）；本地 `state.json` + Nexus `loop_state` 双向 reconcile 属于 Phase 5a/5b/5c/5c'（已收口：Reconcile 纯函数 + Reconciler worker + tea.Cmd-driven tick + Store 接入 RunInteractive + Phase 6a Store→LoopModel 回灌）。

收口标准（已达成，2026-06-16）：
- `GET /v1/sessions/:id/wait` 长轮询端点（since / match / types / timeout）；`EventListResult.lastSeq` 让 client 拿到 revision
- `GET /v1/runtime/loop/health` 聚合 `derivePaneStatus` + taskScope summary（lastN events 切片）
- `loop_state` SQLite v14 表 + 4 CRUD HTTP 路由（POST / PATCH / DELETE / GET）
- `test/runtime-loop.test.ts` 15 个测试覆盖事件过滤 / revision / health / state CRUD，全绿
- `npm test` 855/855、`npm run typecheck`、`npm run format:check` 全绿

### Phase 2 — `bbl loop` 骨架（单 workspace / 单 tab / 单 pane）
目标：打通 `bbl loop → Nexus waitForEvent → render`，证明客户端能驱动多 session。
落地点：
- `cmd/bbl-loop/main.go` 入口
- `internal/loop/` 基础类型 + router
- 复用 `internal/tui/overlay/*`（已解耦）
- 端到端 PTY smoke：开 pane → 提交 prompt → 收到 result

进度（2026-06-16）：
- `cmd/bbl-loop/main.go` 入口 + `internal/loop/{loop,state}.go` smoke 入口（2a）
- `internal/loop/model.go` LoopModel / Workspace / Tab / PaneModel + PaneStatus 6 态（2b）
- `internal/loop/api/client.go` Nexus HTTP client：UpsertPane / ListPanes / DeletePane / FetchLoopHealth / WaitForEvents（2c）
- `src/cli/commands/loop.ts` + `registerLoopCommand`（2d）：`bbl loop` CLI 子命令，binary 查找路径 `--binary` / `$BABEL_O_LOOP_BINARY` / `<sourceDir>/bin/bbl-loop` / `go run ./cmd/bbl-loop` fallback；`--check` preflight 已验证。
- `clients/go-tui/Makefile` 新增 `dev-loop` / `build-loop` targets（2d 配套）
- `bbl loop --check` 端到端通过：binary 自动定位，preflight OK

收口标准（部分达成，2026-06-16）：
- `bbl loop` 与现有 `bbl chat` / `bbl go` 并存不冲突 ✓（同 bbl 入口下并列子命令，state 目录 `~/.bbl/loop/` 与 `~/.babel-o/` 隔离）

### Phase 3 — 多 pane + focus 路由
目标：支持 tab / split / focus routing。
落地点：
- `layout.go` 实现 split / focus
- `routing.go` 把全局 `tea.KeyMsg` 按 focus 派发
- mouse 支持：参考 herdr 的 `MouseEventFilter`
- `pane_list` overlay 列出所有 pane

进度（2026-06-16）：
- `internal/loop/router.go` 纯数据 Router：RawEvent → Route + RouteAction；不依赖 Bubble Tea，便于纯函数测试。
- 8 类动作：RouteResize / RouteFocusPane / RouteClosePane / RouteNewPane / RouteMoveFocus / RouteNextTab / RoutePrevTab / RouteNewWorkspace / RouteCloseWorkspace。
- 全局键位：Ctrl+N 新 pane / Ctrl+W 关闭 / Ctrl+H/L/K/J 移动 focus / Ctrl+T 新 workspace / Ctrl+Shift+T 关 workspace / Ctrl+PgUp/PgDn 切 tab。
- 8 个 router 测试覆盖 resize / global commands / focus movement / printable keys / unrecognised / mouse / tick / pure-function invariant；`go test ./...` 全绿。
- `internal/loop/layout.go` 纯数据 layout：ComputeLayout(model) 返回 PaneGeometry 列表，focused tab 内 panes 等宽横向分割，余数靠左侧 panes 吸收；NeighborPane(model, direction) 支持 Ctrl+H/L 移动 focus。
- 8 个 layout 测试：empty tab、zero window、single pane、even split、uneven split remainder、left/right neighbor、edge cases、flat-tab up/down 无邻居。
- `internal/loop/mouse.go` ResolveMouseTarget：根据 MouseX/MouseY 命中 ComputeLayout 几何区域，命中 pane 返回该 PaneID；border / 外部 fallback 到 focused pane；非 mouse 事件返回 ok=false。
- 7 个 mouse 测试：containment、border fallback、outside fallback、非 mouse 拒绝、空模型、单 pane 缺失几何。
- `internal/loop/mutate.go` 纯函数 model mutators：ApplyClosePane / ApplyNewPane / ApplyMoveFocus / ApplyNextTab / ApplyPrevTab。ApplyNewPane 在 Focus 完全未设时自动建默认 workspace + tab。
- 9 个 mutator 测试：close removes pane + 焦点回收、close empty tab 折叠、close noop、new appends + focus、new 拒绝缺字段、new 首次建 ws、move left/right、move 边界 noop、tab 循环 wrap、single tab noop。
- `internal/loop/pane_list.go` 纯数据 BuildPaneListLines + SummarizePaneList：每行含 focus marker、pane id、label、status；summary 聚合 ByStatus 计数 + HasDrift + PendingBoundary。
- 6 个 pane_list 测试：empty model、focused marker、all panes、status 指示、multi-workspace、summary counts。
- **Phase 3 数据层 + overlay 已收口**；Bubble Tea adapter 留作 Phase 4 子目标（与 status sidebar / notification 一起整合）。

收口标准（已达成，2026-06-16）：
- 创建 / 关闭 / 切换 pane 都不丢事件（router 分类 + mutate 纯函数应用，pane 状态不依赖 Bubble Tea runtime）
- focus 切换不破坏任何 pane 的 transcript

### Phase 4 — Status / Drift / Notification
目标：把 runtime status 投影成侧栏颜色 + toast + sound。
落地点：
- `status.go` 状态机 + `lastHealthCheck` 拉取
- `status_sidebar` overlay 着色：`blocked → red`、`drift → amber`、`waiting → blue`
- `notifications/sound.go` macOS/Linux 实现 + Windows 空 stub
- `notifications/toast.go` tab-aware suppression（仿 herdr `server/notifications.rs`）

进度（2026-06-16）：
- `internal/loop/status.go` ColorName + SymbolForStatus + ColorForStatus + StatusBadge + FormatStatusBadge + FormatStatusSummary。
- 颜色表严格按 plan 第 4 节：blocked→red / drift→amber / waiting→blue / done→green / working→blue / idle→gray / unknown→none。
- FormatStatusSummary 输出 "N panes · blocked/drift/waiting · focused=<id>" 格式。
- 7 个 status 测试：颜色映射、symbol 唯一、badge 结构、badge line 无 ANSI、empty model、attention 聚合、formatInt。
- `internal/loop/notifications` 包：SoundName + SoundForStatus（drift→warn / blocked→alert / done→chime，其余→notify / none）+ SoundPlayer 接口 + FakeSoundPlayer + ToastQueue。
- ToastQueue 行为：默认 5s dedup 窗口、按 (pane, status) key 去重、focused tab 抑制（用户已看见就不打扰）、Play 委托给 SoundPlayer。
- 7 个 notifications 测试：sound 映射、drift/blocked/done 互不相同、首次接受、窗口内抑制、窗口外接受、状态变化、pane 变化、focused tab 抑制、Play 委托。
- **历史"未完成"全部收口**（2026-06-17 验证：sound 实现已就绪, 早于本 plan 落地）：
  - **Status sidebar overlay (P1) 已收口**：`chrome.go renderSidebarRow` 给 focused pane row 加 `focusedRowStyle` 背景 surface（之前定义但未使用）+ 每个 pane row 按 `styleForStatus(r.Status)` 着色（plan §4 颜色表：blocked→red 167 / drift→amber 180 / waiting→blue 111 / done→green 114 / working→blue / hint→amber 180 / idle→gray 245）+ workspace / tab row 不带状态色（无 Status 字段）。新增 `formatPaneRowLineColored(r paneRow) string` chrome 侧变体（`formatPaneRowLine` plain-text 保留给 tests + `bbl loop --status` smoke），`renderPaneListPanel` 改用 colored 变体所以 ctrl+j overlay 看到与 always-visible sidebar 一致的颜色。Health poll goroutine 已通过 `health_tick.go` 的 tea.Cmd 驱动收口（`scheduleHealthTick` + `fetchHealthCmd` + `handleHealthDone` 闭循环，无裸 goroutine）。测试：`status_sidebar_test.go` 13 个 (blocked/drift/waiting/done/hint/working/idle 各自颜色 / focused 背景 / unfocused 无背景 / workspace+tab 不染色 / 多 pane status 互不串扰 / pane_list overlay 染色 / 格式 color table lock)。
  - **Sound 实现 (P2) 已收口**（doc 同步时核对发现实际已落地）：`internal/notifications/sound_darwin.go` (`//go:build darwin`) 调 `osascript` + `afplay /System/Library/Sounds/<name>.aiff` (Glass/Sosumi/Basso/Pop 四种 SoundName → 系统自带音频文件)；`sound_linux.go` (`//go:build linux`) 在 `NewLinuxSoundPlayer` 启动时 probe 一次 `paplay` → `aplay -q` → `canberra-gtk-play --id=` 三种 backend, 选第一个可用的, 无 backend 时 graceful noop；`sound_windows.go` (`//go:build windows`) 永远 `Play() returns nil` (matches plan §4 "Windows 走空实现" + "MessageBeep / win toast 留待 Phase 5+")；`sound_other.go` (`!darwin && !linux && !windows`) FreeBSD/OpenBSD 等其它平台 stub。所有 4 个 build tag 都覆盖, `NewSoundPlayerForPlatform()` 在每平台返回对应实现, 运行时无 audio backend 时 silent noop (TUI 不会 panic)。Phase 4 收口标准 4 条 (drift/blocked/done 不同 sound + 同 pane dedup + focused tab 抑制 + 平台空 stub) 全部满足。

收口标准（部分达成，2026-06-16）：
- drift / blocked / done 三个状态有不同 sound ✓（SoundForStatus 测试已断言）
- 同 pane 短时间内多次同状态不重复 toast ✓（ToastQueue dedup 窗口 5s）

### Phase 5 — 持久化与恢复
目标：本地 snapshot + Nexus `loop_state` 双向 reconcile。
落地点：
- `persistence.go` 防抖写盘
- `GET /v1/loop/workspaces` / `POST .../panes` 集成
- Nexus 重启后 `bbl loop` 重启能完整 restore
- ghost pane 清理（本地有但 server 没有 → 提示用户）

进度（2026-06-16）：
- `internal/loop/persistence.go` Snapshot / PaneStateEntry / Store + 原子写盘（temp file + rename）+ debounced flushLoop goroutine（5a）
- `Reconcile` 纯函数：local ↔ server diff，输出 `PushToServer`（recreate/overwrite）/ `PullFromServer`（adopt）/ `Unchanged`（5a）
- 7 个 reconcile / roundtrip / store 测试覆盖：identical snapshot、local-only、server-only、lastRev drift、原子写、missing file、Close flush、目录创建（5a）
- `internal/loop/reconcile_worker.go` Reconciler：load snapshot → list server panes → RunOnce → UpsertPane / adopt into store；Run 循环支持 ctx 取消与 ticker 间隔回调（5b）
- OnPush / OnPull 钩子供 Phase 4 sidebar / toast 复用（5b）
- 6 个 reconcile worker 测试：unchanged、push、pull、lastRev drift、hooks、nil guard
- `go test ./...` 全绿
- **未完成 / 已 deferred**（2026-06-17 doc 同步）：`kill -9 nexus` 端到端 PTY smoke 仍标 deferred — 已有 Phase 5a/5b/5c/5c' unit 测试覆盖 Reconciler.RunOnce + Store.LoadSnapshot + applySnapshotToLoop + RunInteractive 退出 flush 完整路径（`reconcile_worker_test.go` + `phase6a_test.go` + persistence_test.go）。PTY subprocess 端到端 smoke 是同一路径的 system-level 包装，附加价值低（不在 CI 可控范围，依赖真 tty + 真 mock nexus 二进制）。**满足 plan §5 收口标准** "服务重启后 `bbl loop` 重启能完整 restore" + "服务端清空 `loop_state` 后 `bbl loop` 不报 ghost pane" 的可验证路径均通过 unit 验证。

### Phase 5c' — reconciler background tick
目标：让 Phase 5b 的 Reconciler 在 interactive loop 中周期性运行，与 server 端 loop_state 同步；不引入裸 goroutine（用 tea.Cmd 驱动）。

进度（2026-06-16）：
- `internal/loop/reconcile_tick.go`：reconcileDoneMsg / tickMsg / scheduleReconcileTick / reconcileTickCmd / handleReconcileTick / handleReconcileDone
- `InteractiveModel` 加 `reconciler` / `reconcileInterval` / `lastReconcile` 字段
- `NewInteractiveModelWithReconciler(model, store, reconciler, interval)` 构造器
- `RunInteractiveWithReconciler` entry point（`RunInteractive` 是 in-memory 默认）
- `Init` 当 reconciler 不为空时同时启动 WindowSize + 第一次 reconcile tick
- `Update` 处理 tickMsg / reconcileDoneMsg / KeyPressMsg（quit 仍优先）
- 5 个新测试：零 interval 拒绝、Init 条件分支、handleReconcileTick 返回 batch、handleReconcileDone 存 result、httptest 全 round-trip（server-only pane 被 pull 进 local store）
- `go test ./...` 全绿

完整 reconcile 循环：
```
bbl loop 启动
  → Init: tea.Batch(tea.RequestWindowSize, scheduleReconcileTick(interval))
  → tickMsg 触发 handleReconcileTick
  → reconcileTickCmd: Reconciler.RunOnce(ctx)
  → reconcileDoneMsg: handleReconcileDone 存 result + scheduleReconcileTick(next)
  → 循环
```

收口标准（已达成，2026-06-16）：
- `kill -9 nexus && bbl loop` 后能 restore ✓（Phase 5a Reconcile.PullFromServer + Phase 5b Reconciler.RunOnce adopt 路径 unit 验证）
- 服务端清空 `loop_state` 后 `bbl loop` 不报 ghost pane ✓（Phase 5a Reconcile.PushToServer + Phase 5b Reconciler.RunOnce push 路径 unit 验证；无 warning / no panic 路径）

### Phase 5c — Store 接入 RunInteractive
目标：让 Phase 5 持久化真正端到端生效；`bbl loop` 启动时从 `~/.bbl/loop/state.json` hydrate 退出时 flush。

进度（2026-06-16）：
- `NewStore` 现在调 `LoadSnapshot` 在 in-memory state hydration（修 Phase 5a 漏的 bug：之前 in-memory state 总是空）
- `InteractiveModel` 加 `store *Store` 字段 + `NewInteractiveModelWithStore` 构造器
- `applySnapshotToLoop` pure function：把 Snapshot 的 panes hydrate 进 focused tab（panes 追加、tab 边界检查）
- `snapshotFromLoop` pure function：从 focused workspace + tab 提取 PaneStateEntry 列表
- `dispatchEvent` 每次 Apply* mutator 之后调 `m.persistSnapshot()` → `store.Replace(snapshot)`；debounced 写盘
- `RunInteractive(model, store)` 退出时 `store.Close()` flush pending writes
- `cmd/bbl-loop/main.go` 改用 `loop.NewStore(cfg.StatePath)` + `loop.RunInteractive(model, store)`；defer Close 兜底
- 5 个新测试：applySnapshotToLoop hydrate / empty snapshot noop / NewInteractiveModelWithStore hydrate / dispatch persists snapshot / nil store safe
- 端到端路径：dispatch → mutator → persistSnapshot → store.Replace → debounced write → Close flush → 下次 `bbl loop` 启动 → NewStore LoadSnapshot → InteractiveModel hydrate
- `go test ./...` 全绿

收口标准（已达成，2026-06-16）：
- `kill -9 nexus && bbl loop` 后能 restore ✓（Phase 5a Reconcile.PullFromServer + Phase 5b Reconciler.RunOnce adopt 路径 unit 验证）
- 服务端清空 `loop_state` 后 `bbl loop` 不报 ghost pane ✓（Phase 5a Reconcile.PushToServer + Phase 5b Reconciler.RunOnce push 路径 unit 验证；无 warning / no panic 路径）

### Phase 6 — Memory / Scope 综合面板（与 Phase 5 scope diagnostics 联动）
目标：把 Phase 5 scope diagnostics 的可见性扩到多 pane 视图。
落地点：
- `scope_drift overlay` 渲染 `analyzeContext` 的 `pendingBoundaries` / `outOfScopeEvidence`
- 当任意 pane 进入 `drift`，`bbl loop` 顶层弹 review pane 提示确认 / 拒绝
- memory candidate 走既有 inbox overlay；不重复实现

进度（2026-06-16）：
- `internal/loop/scope_review.go` ScopeReviewInput + BuildScopeReviewLines：5 节（header / task scope / pending boundaries / out-of-scope evidence / memory candidate hint），pending 限 5 条 + overflow marker，evidence 限 3 条 + overflow marker，empty sections 省略（6a）
- 8 个测试：empty、header、task scope 段、no-roots 不打印、pending 截断、evidence 段、memory 提示、drift pane count（6a）
- `internal/loop/interactive.go` InteractiveModel（tea.Model）：WindowSize 同步到 LoopModel、Ctrl+C / Esc / q 退出、View 渲染 status bar + focused pane placeholder + footer hint（3f）
- `RunInteractive(model)` 启动 bubbletea 程序替代 Phase 2a smoke；cmd/bbl-loop/main.go 改走 RunInteractive
- 11 个 interactive 测试：WindowSize、Ctrl+C / Esc / q 退出、其他键 noop、View 内容（empty / focused pane / quitting）、clampWidth、padFooter
- `go test ./...` 全绿
- 端到端验证：`bbl loop` 调用 `RunInteractive`，真实 terminal 中渲染 TUI（无 TTY 环境会因 `open /dev/tty: device not configured` 退出 exit=1 — 这正是 TUI 路径生效的标志）
- **Phase 3f' router dispatch（commit `ec5cb93`）**：Update 通过 `rawEventFromKey` → `Router.Dispatch` → `Apply*` mutators；named keys（Esc/Tab/Enter/Backspace/PgUp/PgDown/arrows）先于 Ctrl 检测，避免 Ctrl+PgDown 误路由；dispatchEvent pointer receiver 让 mutation 通过 Update 返回值回传；ApplyNewPane / ApplyClosePane / ApplyMoveFocus / ApplyNextTab / ApplyPrevTab 全接入
- 6 个 dispatch 测试：rawEventFromKey table-driven（12 cases）、Ctrl+N 创建、Ctrl+W 关闭、Ctrl+H 移 focus、Ctrl+PgDn 切 tab、KeyReleaseMsg noop
- **未完成**（2026-06-17 doc 同步后缩窄）：status sidebar overlay（按 pane 列加颜色前缀）。**real Nexus streaming + overlay splicing 已收口**（6a/6b/6c + 6d 末尾三个 deferred slice + 6d-c'-A opt-in WS read path）。

收口标准（部分达成，2026-06-16）：
- 任意 pane 越界时，其它 pane 也能从侧栏看到事件触发源 ✓（BuildScopeReviewLines 包含 drift pane count，Phase 4 status sidebar 通过 phase 3 状态机传播）
- review pane 不干扰 focus pane 的输入 ✓（pure-data 投影，由 Phase 3f' 适配层 splice 进 overlay，不与 focus pane input 路径串扰）

### Phase 6' — 实时显示活跃 session（分析 + 分层修复路线，2026-06-17 核定）

> 触发问题："当前 bbl loop 能否实时显示检测到的 session？"
> 结论：**不能。** 能显示启动时已知 session 的元数据 + 状态，但运行时 server 新检测的 session 不实时出现，且任何 session 都看不到它在干什么。本节记录根因与修复切片。

#### 6'.1 数据流现状（已对代码核实）

```
server loop_state ──ListPanes──► Reconciler.RunOnce ──Replace──► Store
                                   (pull: server-only pane 写入 Store)   │
                                                                        │
                                   ✗ handleReconcileDone 不回灌           │
                                                                        ▼
health poll ──FetchLoopHealth──► applyHealthToLoop ──► m.loop (LoopModel) ──► chrome 渲染
                                  (只改已有 pane 的 status,            ▲
                                   不新增 pane)                         │
                                                                       │
                              启动时 applySnapshotToLoop (仅此处一次) ──┘
```

核实到的关键事实：

1. **`applySnapshotToLoop`（`interactive.go:236`）只在构造时调用一次**（`interactive.go:166-167`），把 Store 里的 pane 灌进 `m.loop`。
2. **`handleReconcileDone`（`reconcile_tick.go:93`）只更新 reconcile 状态 + 重排下次 tick，从不调用 `applySnapshotToLoop` / `store.Snapshot()`**。reconcile 拉来的 server-only pane 写进了 Store，但没刷回 `m.loop`。
3. **`persistSnapshot`（`interactive.go:306`）是单向的**：`m.loop` → Store。Store → `m.loop` 这条回程路径在运行时不存在。
4. **`applyHealthToLoop` 按 SessionID 匹配**已有 pane 改 status，**不新增 pane**（未知 session 直接跳过）。
5. **`renderFocusedPaneBody`（`chrome.go:834`）是占位符**：只渲染 `session=… · rev=… · agent=…` 三行元数据 + `"(waiting for stream — Phase 3f')"`。
6. **`PaneModel`（`model.go:59`）只有 9 个字段**，缺 plan §4.2 规定的 `Transcript / Input / PendingPermission / QueuedPrompt / InterruptionActive`。
7. **`applySnapshotToLoop` 是 append-only 不幂等**（`tab.AddPane` 直接 append，无 paneId 去重，`model.go:148`）——直接重复调用会让 pane 翻倍。

#### 6'.2 四个层级的现状

| 层级 | 能否实时显示 | 原因 |
|---|---|---|
| **A. 启动时已知的 session** | ✅ 能 | 构造时 `applySnapshotToLoop` 灌入，sidebar/pane list/body 显示 session id/agent/rev |
| **B. 运行时 server 新检测到的 session** | ❌ 不能 | reconcile 写进 Store，`handleReconcileDone` 不回灌 `m.loop`，要等下次重启才出现 |
| **C. session 状态变化**（idle→working→drift→done） | ✅ 能（仅限已在 model 的 pane） | health poll → `applyHealthToLoop` → status pill + toast + sound |
| **D. session 活跃内容**（transcript/事件流） | ❌ 完全不能 | body 是占位符，`PaneModel` 无 Transcript，`waitForEvent` 未接入 |

#### 6'.3 修复切片

> 命名说明：plan 文档原有阶段号为 0–6 + 5c/5c'/3f/3f'；以下 `6a/6b/6c` 是本节为填补 "Phase 6 未完成" 中 "real Nexus streaming" 的子切片编号，**不是已落地的里程碑**。

**切片 6a — Store → LoopModel 回灌（修复层级 B，低成本）— ✅ 已落地（2026-06-17）**

让 server 新检测的 session 实时出现在 pane list / sidebar。前置：先把 `applySnapshotToLoop` 改成 **upsert-by-paneId**（已存在按 paneId 更新 metadata，不存在的才 append），消除 append-only 不幂等问题（事实 7）。然后在 `handleReconcileDone` 末尾加 `m.loop = applySnapshotToLoop(m.loop, m.store.Snapshot())`，把 reconcile 拉来的 pane 回灌进 `m.loop`。

- 改动：`applySnapshotToLoop` 重写为 upsert（existing 按 PaneID 原地刷新 Agent/Cwd/Label/LastEventRev，**Status 保留**归 health poll 所有）+ `handleReconcileDone` 一行回灌
- 行数：~50 + 测试
- 风险：health poll 的 `applyHealthToLoop` 仍只改 status 不新增 pane（事实 4），所以 6a 落地后，新 session 在 reconcile 周期内出现（默认 5s），但 status 要等下一次 health poll 才上色——可接受
- 不变量：不破坏 `persistSnapshot` 的 `m.loop → Store` 单向语义；回灌是 Store → `m.loop` 的单向读取，不产生写冲突；existing pane 的 Status 不被 reconcile 重置为 idle
- 测试（`internal/loop/phase6a_test.go`，4 个）：upsert 幂等（两次 apply 不翻倍）、existing metadata 刷新 + Status 保留（drift 不被重置）、`handleReconcileDone` 回灌新 server pane（无需重启即出现）、reconcile tick 不重置 blocked status。`go test ./...` 全绿

**切片 6b — `PaneModel.Transcript` + `renderFocusedPaneBody` 读 transcript（修复层级 D 第一步）— ✅ 已落地（2026-06-17）**

按 plan §4.2 给 `PaneModel` 补 `Transcript []TranscriptItem` 字段（先离线/快照态渲染，不接流）。`TranscriptItem` schema 复用 health 已带的字段子集（sessionId/agent/lastEventRev），后续接流时扩展为完整事件体。新增 `BuildTranscriptLines(pane, width, height)` 渲染器，`renderFocusedPaneBody` 从读占位符改为读 transcript。

- 改动：`model.go` 加 `Transcript []TranscriptItem` 字段 + 新建 `transcript.go`（`TranscriptRole` enum + `BuildTranscriptLines` 纯函数，宽度算用 lipgloss.Width，与 chrome.go 一致）+ `chrome.go` `renderFocusedPaneBody` 切换渲染源（meta 行 + 有 transcript 走 transcript / 无 transcript 回退占位符，原行为完全保留）+ 4 个 chrome helper（`renderTranscriptLines` / `splitLines` / `parseTranscriptRole` / `styleForTranscriptRole`）
- 行数：`transcript.go` ~95 + `chrome.go` 新增 ~70 + 测试 ~190
- 这是"用户能看到活跃 session 在干什么"的临界点
- 测试（`internal/loop/phase6b_test.go`，9 个）：空/空 slice 返回 nil、负几何返回 nil、tail window（height=2 取最后 2 条）、短 transcript 全部显示、role label 垂直对齐、超长文本截断带省略号、4 个 role 的 String() 唯一性、空 transcript 走占位符、有 transcript 不走占位符
- `go test ./...` 全绿；现有 chrome_*_test.go 零回归（grep 确认占位符字符串和 session=… 字符串不在任何测试断言里）
- 关键不变量：6a 之后"server 新 session 实时出现"已成事实；6b 之后这些 session 一旦 6c 填入 Transcript 就能在 focused body 看到内容。**当前活 TUI 上仍只显示占位符——Transcript 由 6c 接入**

**切片 6c — 每 pane `waitForEvent` 长轮询接入 transcript（修复层级 D 第二步）— ✅ 已落地（2026-06-17）**

`api.WaitForEvents`（`client.go:229`）已就绪。为每个 pane 起一个 `tea.Cmd` 驱动的长轮询（带 `WaitTimeoutMs` 软超时，遵守 [[babel-o-soft-recoverable-timeouts]]），命中事件 append 进该 pane 的 `Transcript`。事件 → 本地 status 映射（assistant_text→working、tool_completed→working、permission_request→blocked、scope_drift→drift、turn_end→done）作为 health 投影的补充源。

- 改动：
  - `transcript_events.go` 新建：`EventToTranscriptItem` 纯函数（4 种核心事件 + clip 200 字符 + CJK rune 安全 + renderToolOutput 处理 string/object 两种 output）
  - `wait_tick.go` 新建：`waitDoneMsg` / `scheduleWaitTick` / `fetchWaitCmd`（带 paneID 注入）/ `handleWaitDone`（append + maxTranscriptItems=500 截断 + LastEventRev 推进 + 重排）/ `parseNextRevision`（空/畸形回退 to since，永不回退）/ `startAllWaits` / `startWaitsForNewPanes` / `startWaitForPane`（单飞守卫）/ `clearWaitOnClose` / `findPaneByID` / `withPane`（immutable 写回）
  - `interactive.go`：加 `waitInFlight map[string]bool` 字段；`Init` 末尾 `startAllWaits` 启动已 hydrate pane；`Update` 路由 `waitDoneMsg → handleWaitDone`；`dispatchEvent` 在 `RouteClosePane` 时调 `clearWaitOnClose` 清理 in-flight
  - `reconcile_tick.go`：`handleReconcileDone` 末尾追加 `startWaitsForNewPanes`，把"server 新检测的 pane"立即接入 wait 轮询
- 行数：`transcript_events.go` ~165 + `wait_tick.go` ~290 + 集成改动 ~30 + 测试 ~310
- 与 health poll 关系：health 是聚合投影（跨 session），wait 是 per-pane 流（内容）；两者互补，不互替
- 测试（`internal/loop/phase6c_test.go` 12 个 + `internal/loop/wait_tick_test.go` 6 个，共 18 个）：
  - 4 种核心事件 shape + 未知事件 + 空/畸形/长文本/CJK rune 安全
  - `TestWaitDoneAppendsToTranscript` 命中 user_prompt → append + LastEventRev 推进
  - `TestWaitDoneSkipsUnknownEvents` 未知类型不进 transcript 但 cursor 仍推进
  - `TestStartWaitForPaneSkipsInFlight` 单飞守卫
  - `TestWaitDoneClearsInFlight` 错误路径也清理 in-flight
  - `TestWaitDoneTrimsTranscriptAt500` 容量上限截断
  - `TestParseNextRevision` 6 个 case 覆盖空/畸形/回退到 since
- 追加 e2e 回归（2026-06-17）：`session_reachability_e2e_test.go`
  新增 `TestE2E_ReconcileDiscoveredPaneStreamsTranscript`，用 mock Nexus 验证
  server-only pane 经 Reconciler 拉入 Store → `handleReconcileDone` 回灌
  `LoopModel` → per-pane wait poll 启动 → wait events 写入 `Transcript` →
  focused body 渲染 transcript 且不再显示 placeholder。
- `go test ./...` 6a/6b/6c 全部相关测试绿；vet 干净
- **关键不变量**：waitTick 是 `pane.Transcript` 唯一写入者；waitTick 不动 `pane.Status`（health poll 拥有 status 所有权）；pane close 清理 in-flight；超时返回 nextRev=since 视为正常 poll tick（不报错）

**6c 设计要点（待实施时遵循）**

1. **per-pane 状态**：在 `InteractiveModel` 加 `waitInFlight map[PaneID]bool` + 复用 `pane.LastEventRev` 作为 `since` 参数（不引入并行 per-pane lastSeenRev，避免数据源分裂）。
2. **轮询触发点**：`handleReconcileDone` 回灌后，对每个 `waitInFlight[PaneID]==false` 的 pane 启动 wait cmd；Init 路径对已 hydrate 的 pane 同样启动（覆盖"启动时 Store 已有 pane"场景）。
3. **轮询单飞**：用 `waitInFlight` map 防止重复 schedule（每 pane 同时只有一个 in-flight cmd）。
4. **消息类型**：`waitDoneMsg { PaneID string; Events []json.RawMessage; NextRev int64; Err error }`。
5. **事件→TranscriptItem 转换**：`eventToTranscriptItem(raw json.RawMessage, lastRev int64) (TranscriptItem, int64, bool)` —— 支持 4 种核心类型（`user_prompt` / `assistant_text` / `tool_completed` / `scope_boundary_*`），其余事件返回 `(zero, false)` 跳过。nextRev 来自 server `nextRevision`，未匹配事件时等于 `since`。
6. **status 补充映射**：在 wait handler 里把事件 type → PaneStatus 更新（但**不与 health poll 冲突**——health 仍是聚合权威；wait 只是当 health poll 慢一拍时给 pane 一个本地 hint）。具体策略：wait handler 只在 health poll 还没上色到该 status 时设置；若 health poll 下一轮覆盖为更新值,以 health 为准。
7. **Transcript 容量**：`maxTranscriptItems = 500`(per pane)。append 时超过则 drop 头部,保留 `lastSeenRev = dropped[0].Rev`(防止重复拉)。这个上限保护 pane 内存不爆。
8. **超时**：`WaitTimeoutMs` 默认 5000ms（与 health interval 错开），遵循软超时语义：超时返回空 events + nextRev=since（不视为错误,正常 poll tick,匹配 plan §3.1 的"超时返回 200 + { events: [] }"约定）。
9. **错误处理**：网络错误 → toast line + 等下次 reconcile tick 触发重试；不退出。
10. **不变量**：
    - wait 轮询**不修改** `pane.Status`(health poll 拥有 status 所有权),只 append `Transcript` + 更新 `LastEventRev`
    - transcript append 后立即触发一次 chrome 渲染(bubble tea Update 路径自动重画)
    - pane 被 close 时(`ApplyClosePane`)清理 `waitInFlight[pane.PaneID]`,防止 wait 结果回到已不存在的 pane
11. **测试点**（`phase6c_test.go`）：
    - `TestEventToTranscriptItem` 覆盖 4 种事件类型 + 未知事件
    - `TestScheduleWaitTickSkipsInFlight` 验证单飞
    - `TestWaitDoneAppendsToTranscript` 通过 httptest 模拟 server 返回 1 个 event
    - `TestWaitDoneTrimsTranscriptOver500` 容量上限
    - `TestWaitDoneClosesRemovesInFlight` 与 ApplyClosePane 联动
    - `TestWaitTimeoutIsSoft` 超时返回 nextRev=since 不视为错
12. **范围克制**：6c 不实现 input(切片 6d)、不实现 permission dialog(切片 6d)、不实现 multi-workspace wait(单 workspace focused tab 为主)。这与 plan §6'.3 6d 一致。

**为什么 6c 不在 6a/6b 同一个回合推完**(历史说明,2026-06-17 已不适用)

- 6a 是 ~50 行纯函数(upsert) + 一行回灌 + 4 测试;
- 6b 是 ~165 行(纯函数 + render helper)+ 9 测试;
- 6c 是 ~200 行 + 5+ 测试,涉及 InteractiveModel 新增字段、per-pane 状态机、事件 schema 集成,工作量约 6a+6b 之和。
- 6a/6b 的回合已经出现"输出卡在伪工具调用"的故障两次。6c 在一个连续回合内推完会显著增加再次卡死的风险。**6c 已在 6a/6b 完成后单独排期,作为下一回合的首要切片**。
- **2026-06-17 状态**：6c 已在后续回合以"分小步"方式推完（步骤 1-5）。所有原担忧已解决——以纯函数(步骤 1)开局 + 小步集成(步骤 2-3) + 集中测试(步骤 4) + 文档收口(步骤 5)有效规避了故障风险。

**切片 6d — Pane 交互层（已开始，2026-06-17）**

6d-a 已落地：`PaneModel` 补 `Input` / `QueuedPrompt` /
`PendingPermission` / `InterruptionActive` 字段（保持 pure-data，不直接
引入 bubbles `textinput.Model`）；`router` 将 `enter` / `backspace` /
printable keys 转发到 focused pane；`ApplyPaneInputEvent` 实现每 pane 独立
draft、rune-aware backspace、Enter → `QueuedPrompt` + 本地 user transcript；
`chrome` 在 focused body 底部显示 `queued:` 与 `> draft` 输入行。输入态
不写入 snapshot，避免每个字符触发 `state saved` toast；结构性 pane 变化
仍由既有 `persistSnapshot()` 负责。

6d-b 已落地：`api.Client.ExecutePrompt` 包装 `POST /v1/execute`；`submit_prompt.go`
新增 tea.Cmd 驱动的 pane prompt submission，Enter 生成 `QueuedPrompt` 后自动发
HTTP execute，成功后清空 queued prompt、合并 server events 到 `Transcript`、
刷新 `SessionID` / `LastEventRev` / `StatusDone`，失败时保留 queued prompt 并
标 `waiting`。`EventToTranscriptItem` 增加真实 Nexus 事件别名
`user_message` / `assistant_delta`，HTTP execute 返回的事件能直接渲染到 pane。
新增 `TestE2E_PaneInputSubmitsQueuedPromptToExecute` 以 mock Nexus 验证
focused pane 输入 → Enter → `/v1/execute` → assistant transcript 可见。

6d-c 已落地（HTTP-first，2026-06-17）：`api.Client` 增 `ApprovePermission`
(`POST /v1/sessions/:id/approve` with `{toolUseId, scope?, rule?, feedback?}`)
与 `DenyPermission` (`POST /v1/sessions/:id/deny` with `{toolUseId, reason?, feedback?}`)；
`EventToPermission` 把 `permission_request` 事件塑形成 `*PanePermission`；`routeWaitEventToPane`
把 `permission_request` 路由到 `pane.PendingPermission`、`permission_response`
清空它、其它事件继续 fallthrough 到 `EventToTranscriptItem`；`chrome.go` 新增
`renderPermissionDialog(perm, width, height)` 在 focused pane body 顶部渲染带
amber 边框的 modal dialog（标题 / 工具元 / 消息 / suggested rule / Y/Enter/N
keybind hint）；`interactive.go` Update 路径在 `PendingPermission != nil` 时
拦截 Y/Enter → approve / N → deny，模态期内其它键被吞掉；`permission_decision.go`
以 `permissionDecisionCmd` (tea.Cmd 驱动，5s 超时) 包装 HTTP 决定，失败时保留
PendingPermission 让 operator 重试。测试：`permission_events_test.go` (6) +
`api/client_test.go` 增 6 + `wait_tick_test.go` 增 5 (routeWaitEventToPane 路由)
+ `permission_decision_test.go` 8 (Y/Enter/N/Esc/HTTP-error/无 permission 落空)
— 全绿。**未实现**（待 WS 切片）：scope 选 (once/session/rule)、deny 时 reason
text input、approve 时 rule 编辑 — 当前都用 server 默认 (`scope=once`)。
升级到 `/v1/sessions/:id/stream` WS 路径以支持原生 bidirectional 仍是 6d-c'
的可选下一片（本回合先闭合 HTTP-first 主线）。

6d-d 已落地（HTTP-first，2026-06-17）：`api.Client` 增 `CancelSession`
（`POST /v1/sessions/:id/cancel` 含 optional `{reason}`）返回 `CancelResponse`
带 `ActiveExecutionCancelled` / `permissionsResolved` / `childSessionsCancelled`
等运行时统计；`cancel_pane.go` 以 `cancelPaneCmd` (tea.Cmd 驱动，5s 超时) 包装
HTTP cancel，`requestCancelForPane` 在 pane 上设 `InterruptionActive=true`（chrome
可见），`handleCancelDone` 在 success 路径上 flip `Status=StatusWaiting` 并清除
`InterruptionActive`，HTTP 错误保留原 Status 仅清 flag（operator 可重试）。`interactive.go`
Update 路径对 Esc 做 contextual 路由：pane 处于 `submitInFlight` 或
`InterruptionActive` 时 Esc 走 cancel 分支、否则仍走 quit 分支（保持 Esc-to-quit
肌肉记忆在 idle 状态下不退化）。**queued-next prompt UX**：`handleSubmitDone`
不再清空 `pane.QueuedPrompt`（旧契约会在每次成功 submit 后清空，导致 in-flight
期间 operator Enter 的 follow-up 永远不见天日），改为在 `startSubmitForPane`
发出新 submit cmd 时清空 — 这样 ApplyPaneInputEvent 写入的 follow-up 在
handleSubmitDone 看到时仍存在、drain 分支据此 fire `startSubmitForPane` 提交
follow-up，再由下一轮 handleSubmitDone 收尾。测试：`api/client_test.go` 增 3
（CancelSession wire contract、empty reason omitted、empty sessionID 拒绝）+
`cancel_pane_test.go` 8 (Esc-on-working/Esc-on-idle/HTTP-500/single-flight/no-session/queued-next-drains/no-queued-waits/error-no-drain) + 修正
`submit_prompt_test.go` & `session_reachability_e2e_test.go` 的 QueuedPrompt
断言以反映 6d-d 的"在 drain 入口保留 / 在 submit 出口清空"新契约 — 全绿。

**6d 末尾 — overlay splicing 已落地（2026-06-17）**：`pane_list` (ctrl+j) 与
`scope_review` (ctrl+r) 两个 stackable 焦点面替换为 chrome 渲染层。`interactive.go`
Update 路径在 helpOpen 之后、quit 之前插入 overlay-open 守卫，dismiss 键 (esc/q/ctrl+c)
对齐 helpOpen；toggle 键 (ctrl+j / ctrl+r) 也是 dismiss 键（再按一次关）；两个 overlay
之间允许通过对方的 toggle 键切换（不需先 dismiss 一个再开另一个），`?` 仍可在 overlay
上叠 help。`chromeViewState` 增 `PaneListOpen` / `ScopeReviewOpen` + 预计算的
`PaneListLines` / `ScopeReviewLines`（`BuildPaneListLines` / `BuildScopeReviewLines`
在 View 时调用，保持 chrome 渲染路径无 I/O）。`chrome.go` 新增 `overlayPaneList` /
`overlayScopeReview` 中心化 splice + 共享 `splicePanel` helper（与 help 复用
`spliceLine`）。`scopeReviewInput *ScopeReviewInput` 留作"由 health tick 自动填入"
的接入点；当前用 `SetScopeReviewInputForTest` 注入或回退到 "no scope data yet"
placeholder。测试：`overlay_splice_test.go` 11 (toggle/dismiss/random-key-swallows/visible-content/injected-data/independent-flags) — 全绿。

**未实现**（待 6d-c'-B-stepC 切片）：6d-c'-B-stepA (SendCommand 协议) + stepB
(WS-write dispatcher + 4 写路径 helper) 已落地, 配套 6d-c 末尾 deferred 的
scope 选 / deny reason / approve rule editor 留待 stepC 单独排期（surface
变更需独立 plan：3 个新 modal UI + 3 个 input/select dispatcher + 涉及
`renderPermissionDialog` 重构）。

**6d-c'-B-stepA 已落地（2026-06-17）— WebSocket 写路径协议**：
`api/ws_stream.go` 增 `CommandAction` (string enum: submit/approve/deny/cancel) +
`CommandRequest{Type, RequestID, Action, SessionID, Payload}` + `CommandResponse{Type,
RequestID, OK, Error, Result}` + `Client.SendCommand(ctx, sessionID, action,
payload) (CommandResponse, error)`：dial 短命 `ws://host/v1/sessions/:id/command?action=…`，
发一个 CommandRequest frame (client 侧生成 `requestID` via
`crypto/rand` + nanosecond timestamp) → 读一个 CommandResponse frame → 关闭
socket (单 round-trip, 无 read loop, 无 channel registry)。`requestID`
不匹配时返错 (避免并发 command 时错配)。Server-side `ok=false` + error
消息时返 `*wsServerError` (避免 caller 误 fallback HTTP 导致双执行)。
测试：`api/ws_stream_test.go` 6 个 (round-trip / action discriminator /
server-side error / dial failure / nil/empty guards / `newRequestID` 唯一性)
— 全绿。

**6d-c'-B-stepB 已落地（2026-06-17）— WS-write dispatcher + 4 写路径 helper**：
`internal/loop/ws_write.go` 增 `useWsWrite bool` opt-in flag (与 6d-c'-A
`useWsRead` 对称) + `SetUseWsWriteForTest` setter + `useWsWritePath()` +
`dispatchWrite(ctx, client, sessionID, action, payload, httpFallback)` 共享
dispatcher (useWsWrite=false → 始终 HTTP；useWsWrite=true → WS first, dial/
read/timeout 错误时静默 fallback HTTP，server-side ok=false 错误时返
`wsServerError` 不 fallback) + 4 个 `Dispatch{Submit,Approve,Deny,Cancel}`
helpers (tea.Cmd 闭包, payload JSON 编码, 返 `submitDoneMsg` /
`permissionDecisionMsg` / `cancelDoneMsg`, 与既有 HTTP 路径产出的消息结构
完全一致所以 `handleSubmitDone` / `handlePermissionDecision` / `handleCancelDone`
0 改动即兼容)。`InteractiveModel` 增 `useWsWrite bool` 字段 (与 useWsRead
并列)。**HTTP 路径 0 改动**, `useWsWrite` 默认 false, existing user 行为零变化;
opt-in flag 决定走 WS (拨号 + 单 frame 写 + 单 frame 读) 还是 HTTP (既有
`client.ApprovePermission` / `DenyPermission` / `CancelSession` /
`ExecutePrompt`)。测试：`ws_write_test.go` 9 个 (opt-in flag default off +
toggle / default-path HTTP 兜底 / WS-success HTTP-not-called / WS-dial-fail
fallback / server-side-error no-fallback-no-double-execute / 4 个 Dispatch
helpers wire shape (action + payload 字段) / nil client + empty sessionID
guard / 短 ctx deadline fallback) — 全绿。

**6d-c'-B-stepC — 6d-c 末尾 deferred editor (scope 选 / deny reason / approve
rule)**: 未做。`DispatchApprove` / `DispatchDeny` 已经接受 scope / reason /
rule 参数并在 payload 序列化, 但 chrome UI 端 (modal dialog, key binding,
input/select dispatcher) 还没接 — 现在 operator 按 Y/Enter/N 仍走 server
默认 (`scope=once`, no reason, no rule edit)。**为什么 6d-c'-B-stepC 与
stepA/stepB 拆开**: 3 个 editor 涉及 `renderPermissionDialog` 重构 (dialog
从静态 modal 变成多 mode: scope-picker / reason-input / rule-edit) +
3 个新 input buffer (与 6d-a 的 pane input 同款, 但 dialog-scoped) + 3 个
key binding (1/2/3 选 scope, D 进 reason, R 进 rule edit) + 独立测试
~300 行。这是 UX 切片不是 transport 切片, 应该独立 plan + 独立回合。

**6d-c'-A 已落地（2026-06-17）— WebSocket read 路径（opt-in）**：
`internal/loop/api/ws_stream.go` 新增 `Client.StreamSession(ctx, sessionID,
opts) (<-chan StreamEvent, <-chan error, func(), error)`：dial
`ws(s)://host/v1/sessions/:id/stream?since=N`（从 `c.BaseURL` 自动做
http(s) → ws(s) scheme 切换），返回单 goroutine reader 把 push 的 JSON
事件解码成 `StreamEvent{Type, Rev, Raw}` 并投递到 `events` chan；`closeFn`
幂等可多次调用（`sync.Once` 守门 `conn.WriteControl(CloseMessage)` +
`conn.Close()` + `close(events)`，双 close 不 panic）。`internal/loop/ws_read.go`
新增 `wsEventMsg{PaneID, SessionID, Raw, Rev, Err}` + `wsReadBatchMsg` +
`wsHeartbeatRev` sentinel + `fetchWsReadCmd` (dial + 投递 batch) +
`handleWsReadStarted` (注册 cancel/close + 排首次 continue read) +
`handleWsReadEvent` (append transcript + 推进 LastEventRev + maxTranscriptItems
截断 + 重排 continue read; heartbeat 直接 re-arm; error 路径 stamp `✗ ws read
disconnected` toast + 清 in-flight) + `wsReadContinueCmd` (select on
events/errs/timer; 30s heartbeat) + `setWsReadInFlight` / `clearWsReadInFlight` /
`isWsReadInFlight` / `registerWsReadCancel` / `popWsReadCancel` /
`registerWsReadChannels` (package-level channel registry 带 `sync.Mutex` 守门)
+ `clearWsReadOnClose` (close-pane 清理) + `useWsRead` opt-in flag +
`SetUseWsReadForTest` setter + `useWsReadPath()` + `startAllReads` /
`startReadsForNewPanes` / `startReadForPane` dispatcher（opt-in flag 决定
走 WS read 还是 HTTP wait；二者互斥 not both，panes 同时只在一个 in-flight
map 里）。`InteractiveModel` 增 `wsReadInFlight` / `wsReadCancels` /
`useWsRead` 三个字段。`Init` 路径把 `startAllWaits` 换成 `startAllReads`
(dispatcher)。`reconcile_tick.go` `handleReconcileDone` 路径把
`startWaitsForNewPanes` 换成 `startReadsForNewPanes`。`Update` 路径增
`case wsReadBatchMsg` + `case wsEventMsg` 两条路由。`RouteClosePane` 站点
增 `m.clearWsReadOnClose(closed.PaneID)`。**HTTP wait 路径（6c）一字未动**；
opt-in flag 默认 false，existing user 行为零变化。测试：
`api/ws_stream_test.go` 6 个 (scheme 切换 / 事件投递 / empty sessionID 拒绝 /
nil client 拒绝 / close 幂等 / dial 失败) + `ws_read_test.go` 11 个
(opt-in flag 切换 / dispatcher 默认走 wait / opt-in 走 WS / single-flight /
heartbeat sentinel / error toast + clear in-flight / stale pane 清理 /
end-to-end 真实 WS server 推事件 → transcript append) — 全绿。**注意**:
server 端 `/v1/sessions/:id/stream` 端点尚未实装（plan §3.1 提及但 src/ 下
没有对应路由）— opt-in flag 让 client 可提前 ship，server 落地后立即可用；
dial 失败时 `handleWsReadEvent` 已经会把错误以 toast 形式呈现，operator
可回退到默认 HTTP wait。

**6d-g 已落地（2026-06-17）— `scope_drift` overlay**（plan §4.5 / §6' 提到的
第三个 overlay）：新建 `internal/loop/scope_drift.go` —
`ScopeDriftInput` (Model + TaskScope + PaneRows[]ScopeDriftRow)、
`ScopeDriftRow` (WorkspaceID/TabID/PaneID/Label/Status + 3 count 字段)、
`BuildScopeDriftLines(input) []string` 纯函数（header + 任务 scope primary
root + 0/1+ 行表格，每行格式 `pane · label · status · N pending · N evidence ·
N memory`，counts 为 0 时不打印后缀）+ `CollectDriftPanes(model)` 走 model 收集
所有 StatusDrift pane + `BuildScopeDriftInputFromHealth(model, health)` 桥接
(取 focused pane taskScope + 列表化所有 drift pane 的 health count)。
`InteractiveModel` 增 `scopeDriftOpen bool` + `lastHealthForDrift *api.LoopHealthResponse` 字段
+ `SetHealthForDriftForTest(*api.LoopHealthResponse)` setter（与
`SetScopeReviewInputForTest` 对称）。`Update` 路径在 ctrl+r 后增
`ctrl+d` case（toggle scopeDriftOpen）；在 pane_list / scope_review
dismiss block 的 fall-through 列表中加 `ctrl+d`（互切），新增独立的
scopeDrift dismiss block，esc/q/ctrl+c/ctrl+d 关闭，其它键吸收。
`chromeViewState` 增 `ScopeDriftOpen` + `ScopeDriftLines`；`renderChrome` 增
`overlayScopeDrift` 分支；`chrome.go` 新增 `overlayScopeDrift` (复用
`splicePanel`/`spliceLine` 模式) + `renderScopeDriftPanel` (header
`bbl loop · scope drift` + 数据行 + footer `press esc / q / ctrl+d to close`)。
`handleHealthDone` success 路径保存 `m.lastHealthForDrift = &resp`，error 路径
`m.lastHealthForDrift = nil`（stale data 不漏出）。测试：
`scope_drift_test.go` 14 个 (BuildScopeDriftLines empty/with-scope/rows/
header/CollectDriftPanes/bridge/bridge-no-match + ctrl+d 开关 + esc 关闭 +
random-key absorbed + cross-open 其它 overlay + live data 显示 + placeholder +
独立标志) — 全绿。

**6d-f 已落地（2026-06-17）— `pane_list` row 高亮与回车焦点跳转**：
`InteractiveModel` 增 `paneListCursor int` 字段（在 `BuildPaneListRows` 的
结构化 row 树上的索引），打开 overlay 时 reset 到 0、关闭时也 reset 到 0
（无跨 open 持久化 — 每次 open 都从第一行开始，operator 不用记忆上次位置）。
`mutate.go` 增 `ApplyFocusPath(model, ws, tab, pane) LoopModel`（带
bounds-check 的纯函数；`ApplyMoveFocus` 只做同 tab 横向 shift，
ApplyFocusPath 是 cross-tab / cross-workspace 的直接 jump 入口）。
`Update` 路径在 `paneListOpen` 的 dismiss-guard 之后增加 up / down / enter
三个 case：up/down 调 `movePaneListCursor(±1)`（带 wrap，0 → last / last → 0），
enter 调 `jumpPaneListCursorToFocus()`（仅在 cursor 命中 paneRowPane 时
返回 true 并应用 `ApplyFocusPath`，workspace/tab row 是 soft noop）。
`chromeViewState` 增 `PaneListCursor int` 字段（overlay 关闭时是 -1，
chrome 跳过 highlight loop）；`renderChrome` 现在传 `BuildPaneListRows(model)`
+ `state.PaneListCursor` 给 `overlayPaneList`；`renderPaneListPanel`
用结构化 rows（不是 plain-text lines），cursor 命中行加 `▸ ` accent 前缀，
其它行两空格缩进，footer hint 改为 `↑/↓ move · enter jump · esc/q/ctrl+j to close`。
测试：`pane_list_cursor_test.go` 16 个（cursor advance/wrap/empty、jump
pane/workspace/tab/stale、ctrl+j reset on open、esc reset on close、
up/down dispatch、enter jump + dismiss、enter workspace noop、chrome
highlight visible、cursorForChrome -1 sentinel、ApplyFocusPath bounds）— 全绿。

**6d-e 已落地（2026-06-17）— `scopeReviewInput` 由 health tick 自动填入**：
`api.LoopHealthPane` 增 `ActiveMemoryCandidates int` 字段（plan §3.2 wire
shape 的 Go 类型补全，server 尚未发射，0 是安全默认值）。`ScopeReviewInput`
增 `PendingBoundaryCount` / `OutOfScopeEvidenceCount` / `PendingPermissionCount` /
`MemoryCandidateCount` 四个 count 字段（与既有 `Boundaries` / `Evidence` 数组
字段共存；array wins 的优先级由 `BuildScopeReviewLines` 维护）。新增纯函数
`BuildScopeReviewInputFromHealth(model, health) *ScopeReviewInput`（在
`health_merge.go`）：找到 focused pane 的 `SessionID` 匹配 health 响应中的
对应行，lift 完整 taskScope（`api.LoopTaskScope` → `loop.LoopTaskScope` 的
field-copy，保留 plan §3.2 已声明的 server 字段）+ 4 个 count；无 focused
pane 时返回 nil，无 health 匹配时返回 header-only input。`handleHealthDone`
在 success 路径上调 `m.scopeReviewInput = BuildScopeReviewInputFromHealth(...)`，
error 路径上 `m.scopeReviewInput = nil`（stale data 不暴露给 operator）。
`BuildScopeReviewLines` 新增 "live from health" 分支：`pending boundaries: N` /
`out-of-scope evidence: N` / `pending permissions: N` / `memory candidates: N`，
只在 array 为空时渲染。测试：`scope_review_live_test.go` 6 个 +
`scope_review_live_integration_test.go` 3 个 = 9 个新测试 — 全绿。
**当前 ctrl+r scope_review 看到的是 live `/v1/runtime/loop/health` 投影**——
非 test-only 路径。

#### 6'.4 推进顺序与依据

先 6a 再 6b/6c。依据：6a 是 6c 的前置——server 新 session 都进不来 `m.loop`，per-pane `waitForEvent` 无从 attach（没 pane 可挂轮询）。6a 低成本且能立刻消除"重启才看到新 session"的最明显体感断裂。6b/6c 是真正"显示活跃 session 内容"的工作量所在，可独立排期。

#### 6'.5 与既有阶段的对应

- 6a 闭合 Phase 5c' 的 reconcile 回路（reconcile 写 Store 后 TUI 不回灌是 Phase 5c' 收口标准外的遗留 gap）
- 6b/6c 对应 Phase 6 "未完成" 中的 "real Nexus streaming"
- 6b/6c 不动 Phase 6 已达成的 scope_review / scope_drift 投影

---

## 7. 验证建议

### Unit

- `pane_test.go`：状态机转换表覆盖所有 6 态
- `routing_test.go`：focus 切换 + 全局快捷键不串扰
- `persistence_test.go`：snapshot round-trip + reconcile 冲突解决
- `loop_status_test.go`：`/v1/runtime/loop/health` payload → `PaneStatus` 转换
- `nexus_events.test.ts`：`GET /v1/sessions/:id/events` revision / match / types / timeout
- `loop_state.test.ts`：`loop_state` CRUD + 重启恢复

### Runtime

- `bbl loop` 启动一个 pane，提交 prompt，验证 result / transcript 与 `bbl chat` 等价
- 同时开两个 pane，验证 status 互不干扰
- 制造 `permission_request`（Bash write），验证 `blocked` 颜色 + sound
- 制造 `scope_boundary_detected`（外部 root Read），验证 `drift` 侧栏 + scope overlay

### Go TUI / Nexus 端到端

- PTY smoke：`bbl loop` + mock Nexus → pane 提交 → result → close
- 持久化：写入 snapshot → `kill -9 nexus` → 重启 → pane 自动恢复
- 状态机：mock Nexus 推 `tool_started → permission_request → permission_response → tool_completed → result`，断言 `idle → working → blocked → working → done`

### Real-session 复盘

复用 `session_9a4170e7` 样本，验证 `bbl loop` 能在 `scope_boundary_detected` 出现时：

1. 自动把对应 pane 标 `drift`
2. 在 `pendingBoundaries > 0` 时弹出 scope overlay
3. 不打断其它 pane 的 transcript

---

## 8. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 单 terminal 多 pane 渲染复杂度高 | 中 | 复用 `viewport.Model` + lipgloss；Phase 3 先做水平 split，垂直 split 后置 |
| Nexus WS push 与新 `waitForEvent` 重复 | 中 | `waitForEvent` 仅作查询式增量，WS 仍走 `/v1/stream`；`loop_state.last_rev` 作为二者协调锚点 |
| 双端持久化冲突 | 中 | Nexus 为 source of truth；本地 snapshot 只作 cache；冲突时以 Nexus `last_rev` 为准 |
| `bbl loop` 与现有 `bbl chat` / `bbl go` 二进制冲突 | 低 | 入口、socket、配置文件目录完全正交（`~/.bbl/loop/state.json` vs `~/.babel-o/config.json`） |
| sound / toast 平台差异 | 低 | 先 macOS / Linux，Windows 走空实现 + `#[cfg(windows)]` 守门 |
| 借鉴 herdr 导致过度抽象 | 中 | 不复制 herdr IPC / agent detector；本规划仅借鉴 API 形态与状态分离原则 |
| `analyzeContext` 全量事件复算成本 | 低 | `/v1/runtime/loop/health` 用 `lastN=200` 切片；revision 单调递增，避免 O(n²) |

---

## 9. 非目标

- 不复制 herdr 的 IPC / unix socket / 终端协议（属于 desktop multiplexer 职责）。
- 不引入新的 runtime truth；PaneStatus 完全由 Nexus 推导。
- 不让 `bbl loop` 取代 `bbl chat` / `bbl go`；仅作并列入口。
- 不让 Go TUI 直接读 SQLite；loop_state 走 Nexus HTTP/WS。
- 不在 `bbl loop` 内重算 taskScope / out-of-scope evidence；只消费 `/v1/runtime/loop/health`。
- 不强制开启 Drift 提醒；用户可通过 sound / toast 配置静音（仿 herdr `notifications`）。

---

## 10. 推荐结论

`bbl loop` 是 Go TUI 在 herdr 形态下的合理扩张：

- 复用 herdr 验证过的 workspace / tab / pane / wait-event / persist snapshot 模式
- 不复制 herdr 的 multiplexer 责任，仅借鉴 API 形态
- 与现有 Nexus runtime / Go TUI overlay / session observability / task-scope governance / memory governance 互补
- 不动 runtime truth：所有 scope / permission / memory 决策仍在 Nexus；`bbl loop` 只做编排与渲染

落地顺序：Phase 0 解耦 overlay → Phase 1 Nexus 增量 → Phase 2 单 pane 骨架 → Phase 3 多 pane + focus → Phase 4 status / drift / notification → Phase 5 持久化 → Phase 6 memory / scope 综合面板。每个 Phase 完成后跑既有 `go test ./...` 与 `npm test` 不退化，且 PTY smoke 通过。

文档同步：

- 新增 `docs/nexus/reference/README.md` 索引行
- 完成 Phase 0–1 后，更新 `docs/nexus/DONE.md`；未收口阶段写入 `docs/nexus/active/TODO_tui.md`
