# SessionChannel TUI Relationship Visibility Plan

## 目标

SessionChannel 已经让不同 session 之间可以通过 typed side-channel 交换协作上下文。TUI 后续要解决的问题不是把多个 session 的 transcript 混成一个聊天流，而是让用户在当前 `bbl chat` 和 session 管理界面中清楚看到：

1. 当前 session 与哪些 session 有联系。
2. 这些联系是什么类型。
3. 哪些联系有未读或高优先级事件。
4. 应该从哪里打开详情、确认、引用或继续协作。

推荐方案是分层组合，而不是单一大面板：默认用状态栏保持轻量可见；列表用 badge 提供扫描能力；结构关系用树视图表达；事件详情用 activity overlay 承接；复杂关系图只作为 debug / overview 入口。

## 当前基线

已落地能力：

- `bbl chat` boxed input footer 显示 SessionChannel linked / unread 状态。
- `/inbox` / `/inbox all` 可打开 side-channel overlay。
- Inbox overlay 支持 open/read、ack、quote into current prompt。
- quote 只预填当前 prompt，必须由用户审阅后手动提交。
- 主对话只对关键 unread message 渲染 compact event card。
- 真实 PTY smoke 已覆盖 unread footer、Inbox overlay、ack、quote、主对话事件卡片、focus ownership 与 resize/navigation 稳定性。

当前边界：

- TUI 仍是 consumption-side 入口；发起跨 session message 仍通过 Nexus API 或 AgentScheduler parent-child channel。
- Full message handling 仍以 `/inbox` 为主，不把跨 session 消息直接渲染成当前用户输入。
- SessionChannel message 是 collaboration context，不是直接用户指令。

## 非目标

- 不实现 raw transcript sharing UI。
- 不把其他 session 的消息正文长期插入主聊天流。
- 不允许一个 session 静默改变另一个 session 的 cwd、provider、profile、permission 或执行状态。
- 不把 memory candidate 做成默认自动写入长期记忆的按钮。
- 不把图谱视图做成默认主导航；它只适合复杂关系调试和概览。

## 推荐组合

### 1. 状态栏指示器：默认常驻入口

状态栏是最适合默认展示的关系信号，因为它可见、低打扰、不会抢占输入区，也不会让跨 session 内容看起来像当前对话。

示例：

```text
? for shortcuts · [3 conns: main, db, ui] · inbox: 1 unread · high: blocked
```

展示信息：

- linked session 数量。
- 主要连接对象的短名。
- unread 数量。
- high-priority message 摘要。
- 当前最高优先级 message type，例如 `blocked` / `handoff` / `request_review`。

交互：

- 默认只显示摘要，不显示正文。
- 有未读时提示用户打开 `/inbox`。
- 后续若加入快捷键，只能打开 overlay，不自动 ack、不自动 quote、不自动发送。

### 2. Session 列表 badge / marker：扫描所有 session

Session 列表需要快速暴露“哪些 session 与当前工作有关”。Badge 比长文本更适合列表行尾。

示例：

```text
session-main        active     ⇄ backend-api · !2
session-backend     completed  ← main · handoff
session-db          running    → main · blocked
session-ui          idle       ↗ main · finding
```

符号建议：

```text
→ spawned child / current links to child
← parent / source session
⇄ workspace_pair / synced collaboration
↗ referenced evidence or lightweight relation
! unread
!! high-priority unread
```

规则：

- 一行只展示最重要的 1-2 个关系摘要，避免横向撑爆。
- 详情入口仍指向 `/inbox`、`/sessions tree` 或 activity overlay。
- Badge 不能替代 ack / quote / send confirmation。

### 3. 父子树视图：表达派生链和 AgentScheduler 结构

树视图适合表达 parent-child / spawned agent 结构，但不应该强行承载所有 channel graph edge。

建议命令：

```text
/sessions tree
/agents tree
```

示例：

```text
● main               !1
  ├─ ● backend-api   blocked
  │    └─ ● db-migration
  └─ ● frontend-ui   handoff
```

展示信息：

- parent-child 层级。
- 每个节点的 session phase / agent status。
- unread / high-priority 摘要。
- blocked / handoff / request_review 等关键 message type。

约束：

- Tree 只表达结构关系；workspace_pair、referenced、broadcast 等非树关系可用 badge 或附加行显示。
- 不在树节点中展示完整消息正文。
- 从树节点进入详情时应打开 inbox/activity overlay，而不是直接把消息注入 prompt。

### 4. Activity Feed Overlay：审阅近期跨 session 事件

Activity feed 适合查看最近发生了什么，但不适合常驻为底部滚动 ticker。它应该是 bounded overlay。

建议命令：

```text
/activity
/sessions activity
```

示例：

```text
Recent SessionChannel activity
[02:14] backend-api  → main      blocked       "Needs validation"
[02:17] db-migration → main      handoff       "Migration ready"
[02:20] frontend-ui  → main      finding high  "UI mismatch"
```

规则：

- 默认限制条数，例如最近 20 条。
- 支持按 unread / priority / channel kind 过滤。
- 可从单条事件执行 open/read、ack、quote。
- quote 仍只预填 prompt，并要求用户手动提交。
- overlay 必须继续遵守唯一 input owner，不与 slash palette、permission panel、history search 抢焦点。

### 5. Inline Message Preview：只做摘要，不做主路径

不建议把完整跨 session 消息正文放在输入区上方作为主路径，因为这会弱化“当前用户输入”和“其他 session 协作上下文”的边界。

可接受的轻量摘要：

```text
! backend-api: blocked · open /inbox
```

不可接受的默认行为：

- 直接展示完整正文并让它看起来像当前聊天历史。
- 自动把正文注入 prompt。
- 自动触发工具调用或 ack。
- 在用户未确认时把 message 当作当前 session 的指令执行。

### 6. Graph View：debug-only 概览

Graph view 适合复杂多 session 调试，不适合作为默认 UX。

建议命令：

```text
/channels graph
/sessions graph
```

示例：

```text
main ⇄ backend-api
 │       └─ db-migration
 └─ frontend-ui ↗ design-review
```

规则：

- 默认隐藏，只在命令触发时展示。
- 只做 overview/debug，不承载主要 ack / quote / send flow。
- 当关系过多时必须降级为列表摘要，避免不可读 ASCII 图。

## 发起侧 UX 的后续方向

关系可见化应先于完整发送 UI。当前 TUI 没有直接发起 SessionChannel message 的命令；后续若加入，建议分两步：

1. `/inbox` 内 reply：从已存在 message/context 出发，最小化目标选择成本。
2. `/channel send <sessionId|channelId>`：用于主动创建或发送 typed message。

发送流程必须具备：

- 明确 message type，例如 `question`、`finding`、`request_review`、`request_validation`、`blocked`、`handoff`。
- 明确 target session 或 channel。
- 支持 evidence refs，且高影响 message 应要求 evidence。
- 发送前显示 confirmation preview。
- 不复用主 prompt 的 Enter 自动提交语义。
- 不自动切换 cwd/provider/profile/permission。

## 实施顺序

### Phase 1：状态栏增强 + Session 列表 badge

优先级最高，因为它们能用最低交互成本提供“有联系 / 有未读 / 有阻塞”的全局感知。

收口标准：

- `bbl chat` footer 能稳定展示 connection summary、unread、high-priority 摘要。
- session list 能展示关系 badge / unread marker。
- 长路径、窄宽度、CJK、resize 场景不破坏布局。
- PTY smoke 覆盖 unread/high-priority badge 的关键路径。

### Phase 2：`/sessions tree` / `/agents tree`

用于 parent-child / AgentScheduler 派生链可视化。

收口标准：

- 能展示 parent-child session tree。
- 节点可显示 unread / blocked / handoff 摘要。
- 非树关系不会被错误塞进层级结构。
- 可从树节点进入 inbox/activity 详情。

### Phase 3：Activity Feed Overlay

用于审阅近期跨 session 事件。

收口标准：

- overlay bounded、可滚动、可过滤。
- 支持 open/read、ack、quote into prompt。
- 不与 slash palette、permission panel、history search 抢焦点。
- PTY smoke 覆盖 overlay focus ownership 与 quote 不自动提交。

### Phase 4：Graph View Debug

只在复杂 session topology 需要时实现。

收口标准：

- `/channels graph` 或 `/sessions graph` 能展示简洁关系图。
- 关系过多时降级为列表摘要。
- 明确标注 debug / overview，不作为主操作入口。

## 语义边界

无论使用哪种展示层，都必须守住以下边界：

- SessionChannel 是 side-channel，不是主聊天 transcript。
- 其他 session 的 message 只能作为 collaboration context 展示。
- quote 只预填 prompt，用户必须审阅并手动提交。
- ack 只改变 inbox message 状态。
- 关系可见化不能静默改变任何 session 的 cwd、provider、profile、permission 或 execution state。
- memory candidate 只展示 review-only governance metadata；写入长期记忆必须另走独立 approval / permission 规划。
