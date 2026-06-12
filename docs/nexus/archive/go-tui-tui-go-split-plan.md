# Go TUI `tui.go` 拆分计划

> Status: **Landed / P2 maintenance**
> Priority: Watch / Stable Go TUI maintenance — 文件级机械拆分已收口；Phase 5 `Update` 分段仅在后续出现明确维护痛点或 regression 时再评估
> 关联: [go-tui-rewrite-plan.md](./go-tui-rewrite-plan.md)、[go-tui-session-observability-governance-plan.md](./go-tui-session-observability-governance-plan.md)、[go-tui-model-persistence-plan.md](../archive/go-tui-model-persistence-plan.md)

---

## 1. 背景

Go TUI 已作为 `bbl chat` 的 stable opt-in alternative 进入维护期；本计划记录了核心包从单个超大 `tui.go` 拆成同 package 职责文件的维护性收口。

- 拆分前 `clients/go-tui/internal/tui/tui.go` 约 **10,243 行**；拆分后为 **3,548 行**。
- 同包内已形成职责文件：`api.go`、`stream.go`、`chrome.go`、`transcript.go`、`text.go`、`selection.go`、`events.go`、`context.go`、`slash.go`、`permission.go` 与 `overlay_*.go`。
- `tui.go` 继续承载：配置/DTO 类型、Bubble Tea `model` root、`Run` / `newModel` / `Init` / `Update` / `View` 总装、核心 mode routing 与 `consumeNexusEvent` 主副作用顺序。

该工作不是 P0/P1 regression，而是稳定维护期的机械整理；收口后后续 Go TUI 小改动可在局部职责文件中完成，降低 review、merge conflict 与视觉回归定位成本。

---

## 2. 目标

1. **降低单文件复杂度**：把 `tui.go` 从“所有实现都在一个文件”拆为同 package 下的职责文件。
2. **保持行为不变**：第一阶段只做机械移动，不改函数签名、不改状态字段、不改事件语义。
3. **保留 Nexus-first 边界**：Go TUI 仍只拥有 terminal interaction / layout / keyboard routing / local rendering，不拥有 Nexus/runtime/context/AgentScheduler/provider/storage/permission 决策。
4. **降低后续改动冲突**：让 `/model`、session observability、permission panel、overlay、stream/client helper 等后续维护在局部文件内完成。
5. **保持测试可验证**：每个拆分阶段都能用 Go 白盒状态机测试和现有 TS smoke/format/typecheck 守住。

---

## 3. 非目标

- **不**重写 Go TUI 架构。
- **不**把 Go TUI 拆成多个 package；第一阶段继续使用 `package tui`，避免引入导出 API、循环依赖和测试迁移成本。
- **不**拆 `model` struct 的所有权；`model` 仍作为 Bubble Tea state root。
- **不**优先拆 `Update` 主状态机；该区域与 single input owner、permission、slash palette、overlay、stream event、model picker 深度耦合，应等文件级机械拆分稳定后再评估。
- **不**改变 `/model`、permission policy、soft timeout、SessionChannel、embedded Nexus session 等任何 runtime 行为。
- **不**新增功能、不补 UX、不顺手修 unrelated bug。
- **不**强制引入新的 formatter/linter/codegen。

---

## 4. 当前结构热点

### 4.1 文件规模

拆分收口后的 `clients/go-tui/internal/tui/` 中主要规模分布：

```text
3548  tui.go
 732  context.go
 707  slash.go
 704  transcript.go
 524  selection.go
 514  api.go
 514  text.go
 455  overlay_inbox.go
 438  chrome.go
 360  stream.go
 330  permission.go
 300  overlay_models.go
 244  overlay_agents.go
 235  overlay_sessions.go
 188  overlay_tools.go
 182  overlay_tasks.go
 119  overlay_activity.go
```

`dialog.go` / `model_pick_dialog.go` 等小文件先例已扩展到 API、stream、render、overlay、text、selection、event、context、slash、permission 等职责边界；仍保持同一个 `package tui`，未引入跨 package 抽象。

### 4.2 `tui.go` 内部职责簇

可直接移动的低耦合区域：

- Nexus HTTP command / client helper：`fetchRuntimeConfig`、`fetchRuntimeProfiles`、`fetchRuntimeModels`、`selectRuntimeProfile`、`selectRuntimeModel`、`nexusJSON`、`nexusRawJSON`、`apiURL`、HTTP error friendly formatter。
- WebSocket stream / session bootstrap：`startStream`、`waitForStreamEvent`、`runStream`、`ensureStreamSession`、`allocateServerSession`、`appendClientSessionLog`、`streamURL`。
- Overlay render helpers：Inbox、Agent、TaskBoard、Activity、ToolAudit、ModelRegistry、Session panel、Slash palette、Help/Profile/Quit/Context overlays。
- Transcript rendering：`renderTranscript`、`renderTranscriptItemCached`、`formatLine`、tool transcript preview、event summary formatter。
- Terminal text helpers：`wrapPlain`、`truncatePlain`、`truncateVisible`、`visualWidth`、`padRight`、column/join helpers。
- Selection / mouse helpers：selection state machine、OSC 52 copy、mouse escape parsing。

高耦合、暂缓移动或仅在后续阶段拆的区域：

- `model` struct 字段分组。
- `Update` 主状态机。
- `consumeNexusEvent` 与 permission/event side effects。
- `newModel` 初始化与 `View` / `resize` / `nonTranscriptChromeHeight` 的总装逻辑。

---

## 5. 目标文件布局

第一轮拆分后，`clients/go-tui/internal/tui/` 推荐形成如下职责边界：

```text
clients/go-tui/internal/tui/
  tui.go                    # Config/DTO、model root、Run/newModel/Init/Update/View 总装、核心 mode routing、consumeNexusEvent
  api.go                    # Nexus HTTP helpers + runtime/config/models/profiles/tasks/inbox/tools cmds
  stream.go                 # WebSocket stream、execute request、session allocation/logging
  events.go                 # activity/sub-agent/context usage event helper（consumeNexusEvent 主顺序仍留 tui.go）
  transcript.go             # transcript item rendering、tool output summary、formatNexusEvent
  context.go                # context overlay、context/compact/runtime formatter、JSON field helper
  slash.go                  # slash command registry、filter/highlight、palette render、direct submit helper
  permission.go             # permission state helper、decision/editor helper、permission render glue
  overlay_inbox.go          # Inbox overlay + event cards
  overlay_agents.go         # Agents / sub-agent overlay
  overlay_tasks.go          # Task board overlay
  overlay_activity.go       # Activity overlay
  overlay_tools.go          # Tool audit overlay
  overlay_models.go         # Runtime models/config overlay + /model picker glue
  overlay_sessions.go       # Session panel render / command helpers
  chrome.go                 # header、top card、footer、input/composer stack、runtime wave
  selection.go              # in-app selection、mouse routing、OSC 52 copy
  text.go                   # wrapping、truncation、visible width、padding helpers
  welcome.go                # welcome card renderer
```

说明：

- 文件名保持 feature-oriented，避免 `utils.go` 继续膨胀。
- 所有文件仍使用 `package tui`，无需导出大部分 symbol。
- `tui.go` 保留 Bubble Tea 生命周期入口和 state machine，避免第一阶段产生行为漂移。
- 已存在的 `dialog.go`、`model_pick_dialog.go`、`permission_dialog.go`、`help_dialog.go`、`quit_dialog.go` 等继续保留，不回并。

---

## 6. 分阶段推进

### Phase 0 — 文档与边界确认

状态：**已完成**。

任务：

- 记录 `tui.go` 拆分动机、非目标、文件布局和验证门禁。
- 在 reference index / 总控文档索引中挂接，避免成为孤立规划。
- 明确优先级为 P2 maintenance，不压过真实 session regression。

收口标准：

- 文档存在于 `docs/nexus/reference/`。
- `docs/nexus/reference/README.md` 和 `docs/nexus/TODO.md` 文档索引可发现。

### Phase 1 — API / Stream 机械移动

状态：**已完成**（`api.go` / `stream.go`）。

目标：先拆最靠近 IO 边界、最容易验证、对 UI state 侵入最小的代码。

任务：

- 新建 `api.go`，移动：
  - `fetchRuntimeConfig`
  - `fetchRuntimeProfiles`
  - `fetchRuntimeModels`
  - `selectRuntimeProfile`
  - `selectRuntimeModel`
  - `fetchContextAnalysis`
  - `triggerCompact`
  - `fetchInbox`
  - `ackInboxMessage`
  - `fetchSessionAgents`
  - `fetchSessionTasks`
  - `checkRuntimeVersion`
  - `fetchToolAudit`
  - `nexusJSON`
  - `nexusRawJSON`
  - `errNotModified`
  - `apiURL`
  - `summarizeHTTPError`
  - `friendlyNexusError`
  - `friendlyNexusErrorWithContext`
- 新建 `stream.go`，移动：
  - `startStream`
  - `waitForStreamEvent`
  - `resolveGoTuiTimeout`
  - `looksLikeLongContextPrompt`
  - `buildExecuteRequest`
  - `buildExecuteRequestWithTimeout`
  - `ensureStreamSession`
  - `runStream`
  - `allocateServerSession`
  - `appendClientSessionLog`
  - `resolveClientConfigDir`
  - `streamURL`

收口标准：

- 只移动代码，不改逻辑。
- `go -C clients/go-tui test ./...` 通过。
- `go -C clients/go-tui vet ./...` 通过。

### Phase 2 — Render / Overlay 机械移动

状态：**已完成**（`chrome.go`、`welcome.go`、`transcript.go`、`context.go`、`slash.go`、`permission.go` 与 `overlay_*.go`）。

目标：把 read-only renderer 从主状态机文件中移出，降低视觉/布局维护冲突。

任务：

- 新建或填充 `chrome.go`：header、top card、footer、input/composer stack、runtime wave。
- 新建或填充 `overlay_*.go`：Inbox、Agents、Tasks、Activity、ToolAudit、Models、Sessions。
- 新建 `transcript.go`：transcript rendering、tool output summary、event summary formatter。
- 保留 `View()` 和 `viewString()` 在 `tui.go`，只调用拆出的 renderer。

收口标准：

- 只移动 renderer / formatter，不改变输出字符串。
- Go TUI unit tests 通过。
- 如启用 PTY smoke，cleaned transcript 不出现新增差异；若未启用，说明未运行原因。

### Phase 3 — Text / Selection helper 机械移动

状态：**已完成**（`text.go` / `selection.go`）。

目标：把通用 terminal text 和 mouse selection 基础设施独立出来，为后续 markdown/rendering 优化减少冲突。

任务：

- 新建 `text.go`：visible width、wrap、truncate、pad、divider、column join 等纯函数。
- 新建 `selection.go`：in-app selection、mouse escape parsing、OSC 52 copy、selection extraction。
- 确认 `highlight.go` / `streaming_markdown.go` 与 `text.go` 的职责不重叠；不把 markdown renderer 逻辑塞进 `text.go`。

收口标准：

- 纯函数测试保持通过。
- 不改变 CJK、ANSI、long path、narrow terminal 的现有行为。

### Phase 4 — Event side-effect 分组（谨慎）

状态：**已完成低风险 helper 拆分**（`events.go`）；`consumeNexusEvent` 主顺序继续保留在 `tui.go`。

目标：在前三阶段稳定后，评估是否拆 `consumeNexusEvent` 和相关 event state update。

任务：

- 新建 `events.go`，移动低风险 helper：
  - `recordActivityEvent`
  - `recordSubAgentEvent`
  - `subAgentStatusFromTaskSessionEvent`
  - `contextUsageSnapshotFromContextUsageEvent`
  - `contextUsageSnapshotFromExecutionMetrics`
  - `formatExecuteSummary`
  - event field extraction helpers
- `consumeNexusEvent` 可先留在 `tui.go`，只移动被调用 helper。
- 若后续继续拆 `consumeNexusEvent`，必须按 event type 保持状态副作用顺序，不能把 permission/result/error terminal state reset 顺序打散。

收口标准：

- permission request / response / result / error mode transition 单测通过。
- soft timeout footer / watchdog friendly error 单测通过。
- Agent/sub-agent/activity/inbox 自动刷新行为不变。

### Phase 5 — `Update` 分段 handler（可选，非第一轮）

状态：**未执行 / 保留为后续可选**。当前文件级拆分已达到低于 4k 行目标；没有真实 regression 或明确维护痛点时不拆 `Update`。

目标：仅当机械拆分后仍出现 `Update` 维护瓶颈时再评估。

候选方向：

- `handleKeyPress(msg tea.KeyPressMsg) (model, tea.Cmd)`。
- `handleOverlayKey(key string) (model, tea.Cmd, bool)`。
- `handleModelPickerKey(key string) (model, tea.Cmd, bool)`。
- `handlePermissionKey(key string) (model, tea.Cmd, bool)`。
- `handleRuntimeMsg(msg tea.Msg) (model, tea.Cmd, bool)`。

风险：

- single input owner 语义容易漂移。
- `modePermission` grace period、slash palette、model picker in-flight、session panel、history recall 等分支共享状态多。
- Bubble Tea `model` value receiver / pointer receiver 混用时容易引入复制语义 bug。

收口标准：

- 只在有明确维护收益或真实 bug 驱动时做。
- 必须先补足对应 mode transition regression，再拆。

---

## 7. 迁移规则

每个拆分 PR / commit 必须遵守：

1. **一类职责一轮移动**：不要在同一轮同时移动 API、render、stream、text 和 Update。
2. **不改逻辑**：机械移动阶段不改字符串、不改状态字段、不改函数签名。
3. **不新增导出 API**：同 package 内无需首字母大写；除非已有外部调用需求。
4. **不创建 `utils.go` 垃圾桶**：helper 必须归到具体职责文件。
5. **不把 tests 一次性大拆**：`tui_test.go` 可稍后按同样 feature 文件拆；第一轮保持测试稳定优先。
6. **移动前后用 `gofmt`**：只接受 formatter 产生的机械 diff。
7. **每轮单独验证**：失败时回滚本轮，不在同一轮顺手修 unrelated failure。

---

## 8. 测试与验证

最低验证：

```bash
go -C clients/go-tui test ./...
go -C clients/go-tui vet ./...
```

建议验证：

```bash
npm run typecheck
npm run format:check
```

涉及 PTY/visual 相关区域时可选：

```bash
BABEL_O_RUN_GO_TUI_SMOKE=1 npm run test:go-tui:smoke
```

若只做 Go 文件机械移动，TS 全量 `npm test` 不是必须；若同时触碰 CLI wrapper、Nexus API 或 smoke driver，则补对应 TS focused tests。

---

## 9. 风险与对策

| 风险 | 概率 | 影响 | 对策 |
| --- | --- | --- | --- |
| 机械移动时漏 import / 重复 import | 中 | 低 | 每轮 `gofmt` + `go test` / `go vet` |
| renderer 移动时误改输出字符串 | 中 | 中 | Phase 2 只移动，不顺手 polish；必要时跑 PTY smoke |
| `Update` 分段后 input owner 漂移 | 中 | 高 | Phase 5 延后，拆前先补 mode transition tests |
| `model` value/pointer receiver 复制语义被破坏 | 低 | 高 | 不改 receiver；移动函数时保持原签名 |
| 新文件边界变成新的 `utils.go` | 中 | 中 | 文件按 feature 命名，review 时拒绝无归属 helper |
| 大规模 diff 难 review | 高 | 中 | 一轮只移动一个职责簇，commit message 标注 mechanical move |

---

## 10. 建议执行顺序

推荐最小安全序列：

1. Phase 1A：只移动 `api.go`。
2. Phase 1B：只移动 `stream.go`。
3. Phase 2A：移动 `chrome.go`。
4. Phase 2B：移动 `overlay_models.go` + `/model` picker render glue。
5. Phase 2C：移动 Inbox / Agents / Tasks / Activity / Tools overlays。
6. Phase 2D：移动 `transcript.go`。
7. Phase 3A：移动 `text.go`。
8. Phase 3B：移动 `selection.go`。
9. Phase 4：只移动 event helper；是否移动 `consumeNexusEvent` 另行评估。
10. Phase 5：只有在新增 regression 或维护痛点明确时再拆 `Update`。

每一步完成后再决定是否继续，不把“拆完整个文件”作为单次任务目标。

---

## 11. 收口标准

本计划已标记为 landed，收口事实：

- `tui.go` 从 10,243 行降低到 3,548 行，低于 4k 优先目标。
- `api.go` / `stream.go` / `chrome.go` / `transcript.go` / `text.go` / `selection.go` / `events.go` / `context.go` / `slash.go` / `permission.go` / selected `overlay_*.go` 职责明确。
- `go -C clients/go-tui test ./...` 通过。
- `go -C clients/go-tui vet ./...` 通过。
- 文档已更新到 `DONE.md` / `WORK_LOG.md`，并在 `TODO.md` 中保持 Watch/maintenance 状态；未升级为 P1 功能主线。

---

## 12. 关联文件

- `clients/go-tui/internal/tui/tui.go` — 当前拆分目标，Bubble Tea core package 主聚合文件。
- `clients/go-tui/internal/tui/tui_test.go` — 当前白盒状态机测试主文件，第一轮不强制拆。
- `clients/go-tui/internal/tui/dialog.go` — 现有小文件拆分先例。
- `clients/go-tui/internal/tui/model_pick_dialog.go` — `/model` picker dialog 组件先例。
- `clients/go-tui/internal/tui/permission_dialog.go` — permission panel 组件先例。
- `clients/go-tui/internal/tui/highlight.go` — 高亮 / renderer helper 小文件先例。
- `clients/go-tui/internal/tui/streaming_markdown.go` — markdown renderer 小文件先例。
- `docs/nexus/reference/go-tui-rewrite-plan.md` — Go TUI 长期边界与 stable client 规划。
- `docs/nexus/reference/go-tui-markdown-rendering-optimization-plan.md` — 后续 transcript/markdown 优化可能与 `transcript.go` / `text.go` 拆分交汇。
- `docs/nexus/active/TODO_tui.md` — Go TUI stable maintenance 当前状态。
