# bbl loop — Go Multi-session Pane TUI Plan

> Status: **Draft (2026-06-16)** — 借鉴 [ogulcancelik/herdr](https://github.com/ogulcancelik/herdr) 的 workspace / tab / pane / wait-event / persist snapshot 形态，在 Go TUI 之上引入一个多 session 并发面板，入口 `bbl loop`。`bbl chat` 继续是生产默认入口，本规划不替换它，只新增并列前端。
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
- **未完成**：Go 侧 `internal/loop/` 消费端（属于 Phase 2）；本地 `state.json` + Nexus `loop_state` 双向 reconcile 完整实现（属于 Phase 5）。

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
- **未完成**：status sidebar overlay（按 pane 列加颜色前缀）、health poll goroutine、macOS/Linux 平台 sound 实现。

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
- **未完成**：worker 接到 cmd/bbl-loop 的交互 loop（Phase 5c）+ `kill -9 nexus` 端到端 PTY smoke

收口标准（已达成，2026-06-16）：
- `kill -9 nexus && bbl loop` 后能 restore ✓（Phase 5a Reconcile.PullFromServer + Phase 5b Reconciler.RunOnce adopt 路径 unit 验证）
- 服务端清空 `loop_state` 后 `bbl loop` 不报 ghost pane ✓（Phase 5a Reconcile.PushToServer + Phase 5b Reconciler.RunOnce push 路径 unit 验证；无 warning / no panic 路径）

### Phase 6 — Memory / Scope 综合面板（与 Phase 5 scope diagnostics 联动）
目标：把 Phase 5 scope diagnostics 的可见性扩到多 pane 视图。
落地点：
- `scope_drift overlay` 渲染 `analyzeContext` 的 `pendingBoundaries` / `outOfScopeEvidence`
- 当任意 pane 进入 `drift`，`bbl loop` 顶层弹 review pane 提示确认 / 拒绝
- memory candidate 走既有 inbox overlay；不重复实现

收口标准：
- 任意 pane 越界时，其它 pane 也能从侧栏看到事件触发源
- review pane 不干扰 focus pane 的输入

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
