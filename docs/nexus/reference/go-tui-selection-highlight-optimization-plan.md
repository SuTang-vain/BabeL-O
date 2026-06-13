# Go TUI 选中文本高亮与剪贴板复制优化记录

> **Status**: Resolved / Closed — Go TUI `--mouse` 选中但高亮不覆盖问题已通过窄范围 ultraviolet cell-buffer selection highlight 收口；Phase 5 已评估，暂不迁移 `tea.SetClipboard`。
> **Date**: 2026-06-13
> **Scope**: `clients/go-tui` 文本选区、高亮渲染、OSC 52 / clipboard 复制反馈。
> **Non-goals**: 不把整体 Go TUI 渲染管线迁移为 screen-based rendering；不升级 Bubble Tea 大版本；不改变 Nexus/runtime/context ownership；不接管 TypeScript TUI 的终端原生选区。

## 1. 背景

Go TUI 当前在开启 `--mouse` / `MouseCapture` 后会接管终端鼠标事件，终端原生 drag-select 不再可靠。因此项目实现了 in-app selection：用户在 transcript viewport 中左键拖动，Go TUI 记录 viewport-content line/col，拖动时渲染灰色背景，release 时通过 OSC 52 和 native clipboard fallback 写入剪贴板。

用户反馈的真实问题：**实际已经选中了并能复制，但视觉上偶发没有高亮/高亮不覆盖**。该问题已解决：selection highlight 主绘制路径改为窄范围 `ultraviolet.ScreenBuffer` cell-level reverse highlight，复制路径和高亮状态也通过回归测试锁住一致性。

当前 BabeL-O 关键实现：

- `clients/go-tui/internal/tui/selection.go`
  - `handleSelectionMouse`：press/motion/release 状态机。
  - `extractSelectedText`：从 `fullViewportContent()` 提取纯文本。
  - `buildOSC52Sequence` / `osC52CopyCmd`：OSC 52 + `clipboard.WriteAll`。
- `clients/go-tui/internal/tui/highlight.go`
  - `highlightedViewportView`：根据 `normalizedSelection()` 重建带高亮的 viewport 内容。
  - `renderHighlightRange`：使用 `ultraviolet.ScreenBuffer` 对选区 cell 设置 `uv.AttrReverse`。
  - `paintColumnRange`：保留为低层工具/回归样本，不再作为 selection highlight 主路径。
- `clients/go-tui/internal/tui/tui.go`
  - `Update` 中分发 `tea.MouseClickMsg` / `tea.MouseMotionMsg` / `tea.MouseReleaseMsg`。

## 2. 原风险点

### 2.1 复制内容与视觉高亮不完全共享同一渲染链路

复制路径使用：

```go
plain := stripANSICodes(m.fullViewportContent())
```

高亮路径使用：

```go
content := m.fullViewportContentWithSelection(sl, sc, el, ec)
viewport := m.viewport
viewport.SetContent(content)
return viewport.View()
```

平时屏幕显示来自 `m.viewport.View()` 中已有 content；高亮时重新构造 content，再塞入临时 viewport。只要 `fullViewportContent()` / `fullViewportContentWithSelection()` 与真实 viewport content、item cache、scroll offset、wrap 行数或 ANSI 样式存在轻微 drift，就可能出现“复制有效但高亮不可见/不对齐”。

### 2.2 高亮在 release 时被立即清空

当前 release 分支在成功提取文本后立即：

```go
m.clearSelection()
return *m, tea.Sequence(osC52CopyCmd(text), expireCopyToastCmd(m.copyToastShownAt))
```

这会让用户释放鼠标后的下一帧立刻没有高亮，只剩 footer toast。若用户主要观察 release 后状态，就会感知为“选中了但没有高亮”。

### 2.3 高亮以整块字符串插 ANSI 为主，容易受 ANSI/wrap/padding 影响

`paintColumnRange` 是 ANSI-aware 的，但它仍依赖：

- 渲染后字符串行号与 viewport 视觉行完全一致；
- column width 计算和终端一致；
- ANSI/OSC/CSI 解析覆盖所有样式序列；
- transcript item cache 失效及时；
- welcome card 与 transcript 间隔行数稳定。

这比 per-item/cell-level highlight 更脆弱。

### 2.4 `highlightedViewportView` 每帧先全清再重建

当前逻辑：

```go
m.clearTranscriptHighlights()
if !ok { return m.viewport.View() }
content := m.fullViewportContentWithSelection(...)
```

`clearTranscriptHighlights()` 会修改 transcript item 指针并 invalidate cache，然后同一帧再按全局行号重新 apply。若某些路径提前返回、cache invalidate 不完整，或 selection range 对不上 item 局部行列，可能出现闪烁/漏高亮。

## 3. Crush 对照结论

Crush 的实现位置：

- `/Users/tangyaoyue/DEV/crush/internal/ui/model/ui.go`
  - Bubble Tea mouse event 进入后先转换为 chat-local 坐标。
  - release 后延迟发 `copyChatHighlightMsg`，避免 single-click/double-click 与 drag-copy 冲突。
- `/Users/tangyaoyue/DEV/crush/internal/ui/model/chat.go`
  - `HandleMouseDown` / `HandleMouseDrag` / `HandleMouseUp` 只维护 mouse state。
  - `applyHighlightRange` 每帧把 mouse state 转为 per-item highlight range。
  - `HighlightContent` 从每个 item 的 highlight range 提取剪贴板文本。
- `/Users/tangyaoyue/DEV/crush/internal/ui/chat/messages.go`
  - `highlightableMessageItem.SetHighlight` 在高亮范围变化时 bump item version。
- `/Users/tangyaoyue/DEV/crush/internal/ui/list/list.go`
  - `renderItemEntry` 先运行 render callbacks，再检查 cache version。
- `/Users/tangyaoyue/DEV/crush/internal/ui/list/highlight.go`
  - 用 `uv.ScreenBuffer` 做 cell-level highlight。
- `/Users/tangyaoyue/DEV/crush/internal/ui/common/common.go`
  - `CopyToClipboardWithCallback` 使用 `tea.SetClipboard(text)` + `clipboard.WriteAll(text)` + success toast。

核心模式：

```text
mouse down/drag state
  ↓
每帧 list render callback: applyHighlightRange
  ↓
per-item SetHighlight(startLine, startCol, endLine, endCol)
  ↓
SetHighlight 检测变化并 Bump version
  ↓
list cache miss，item Render 输出带高亮内容
  ↓
release 后延迟 copy，再 ClearMouse
```

Crush 避免“实际选中了但无高亮”的关键不是 OSC 52，而是：**高亮状态变更和 item cache version 强绑定，并且高亮注入发生在 item render 前，而不是最终 viewport 字符串之后。**

## 4. 设计原则

1. **Mouse selection state 是唯一真源**：press/motion/release 只维护 selection state，不在多个内容源之间重复推导。
2. **高亮必须跟当前渲染链路绑定**：selection range 应在 transcript item 渲染前转换为 item-local highlight，而不是在 viewport 完成后整块 patch。
3. **cache invalidation 必须显式**：highlight range 变化必须 invalidate 对应 item cache；无变化不应反复 invalidation。
4. **release 后不要立刻抹掉用户反馈**：复制成功前或至少下一帧应保留视觉反馈。
5. **窄范围引入 ultraviolet**：只在 selection highlight 绘制阶段使用 `ultraviolet.ScreenBuffer` 做 cell-level reverse highlight；Go TUI 其它 transcript/viewport/overlay 渲染仍保持现有 string/lipgloss 路径，不迁移为全局 screen renderer。

## 5. 当前收口记录

2026-06-13 已落地：

- Phase 0：新增/强化回归测试，覆盖 release 后仍可见高亮、复制文本与可见高亮范围一致、selection highlight 过期只清理匹配 copy、宽字符/emoji 与 nested ANSI 高亮稳定性。
- Phase 1：成功复制后不再立即 `clearSelection()`；保留最后选区约 300ms，并通过 `selectionHighlightExpiredMsg` 按 `copiedAt + selection anchors` 精确清理，避免旧 tick 清掉新选区。
- Phase 2：`transcriptItem.SetHighlight` / `ClearHighlight` no-op 化；`highlightedViewportView()` 不再在有选区时每帧先全清，改为 `applySelectionToTranscriptItems` 只更新范围内 item 并清理离开范围的 item，减少 cache churn。
- Phase 3：release copy 测试锁定 `lastSelectionCopy` 与同一可见 selection range 一致；保留 `extractSelectedText` + plain text stripping，未引入新 clipboard 文本来源。
- Phase 4：selection highlight 绘制切换为窄范围 `ultraviolet.ScreenBuffer` cell-level reverse highlight，解决字符串插入背景色在复杂 ANSI/wrap/cell 场景下覆盖不完整的问题；旧 `paintColumnRange` 仅保留为低层工具/回归覆盖，不作为主 selection highlight 路径。
- Phase 5：暂不迁移到 `tea.SetClipboard`。当前手写 OSC 52 builder 已有明确 base64/BEL 回归，继续使用 `tea.Printf(buildOSC52Sequence(text)) + clipboard.WriteAll(text)`，避免在 Bubble Tea v1.3.10 上引入行为差异。

## 6. 已实施阶段

### Phase 0 — 补充回归测试

目标：捕获“已选中但无高亮”的失败形态。

已覆盖：

- 鼠标 press + motion 后，`viewString()` / `highlightedViewportView()` 必须包含 cell-level selection highlight（当前为 ultraviolet reverse attribute，而非旧 `selectionBackgroundStart`）。
- 多行 transcript selection 必须在首行、尾行或中间行出现高亮 ANSI。
- release 后至少一个可控窗口内仍可看到高亮，或明确断言 release 后 toast + lastSelectionCopy 同步。
- 高亮内容与 `extractSelectedText` 对同一 selection range 取到的文本一致。
- Bash output preview / markdown assistant / welcome card 三类内容分别覆盖。

### Phase 1 — 最小 UX 修复：延迟清理 selection

目标：降低“release 后看不到高亮”的感知问题。

已落地：release 成功复制后不再立即 `m.clearSelection()`，而是新增 delayed clear message：

```go
type selectionHighlightExpiredMsg struct { copiedAt time.Time /* + selection anchors */ }
```

release 成功后：

```go
return *m, tea.Sequence(
  osC52CopyCmd(text),
  expireCopyToastCmd(m.copyToastShownAt),
  expireSelectionHighlightCmd(m.copyToastShownAt),
)
```

保留高亮 150ms~500ms，或至少保留到下一帧。这样即使复制已成功，用户仍能看到最后选区。

注意：

- 新 press 应立即覆盖旧 selection。
- overlay / mode 切换时仍应清 selection。
- 不要让旧 selection 阻挡新 transcript streaming。

### Phase 2 — 让 transcript item highlight 变成稳定 render 前状态

目标：接近 Crush 的 per-item highlight 模式，但仍保持 string renderer。

已落地：

1. 在 `transcriptItem.SetHighlight` 中增加“范围未变则 no-op”判断，避免每帧重复 invalidate。
2. 全局 selection range 到 per-item range 的转换集中在 `applySelectionToTranscriptItems`，由该函数在渲染前更新范围内 item 并清理离开范围的 item。
3. `highlightedViewportView()` 不再在有选区时先全清 transcript highlights；无选区时才清理。
4. 对不在 selection range 内的 item 调 `ClearHighlight()`，且 `ClearHighlight()` no-op 化，只有状态变化才 invalidate。

### Phase 3 — 统一复制文本与高亮 range 的来源

目标：减少“copy path 有文本、highlight path 无视觉”的 divergence。

已落地：

- 保留 `extractSelectedText` + `stripANSICodes` 作为剪贴板纯文本来源。
- release copy 回归锁定 `lastSelectionCopy` 与同一可见 selection range 一致，覆盖正向/反向拖选。
- welcome card selection 仍保持现有全局字符串路径；transcript highlight 由 Phase 2/4 的 per-item + cell-buffer 路径负责。

### Phase 4 — 改善高亮绘制稳定性

目标：窄范围引入 ultraviolet cell buffer，让 selection highlight 覆盖真实终端 cell，而不是继续依赖字符串插入 ANSI 背景色。

已落地：

- 主 selection highlight 路径使用 `uv.NewScreenBuffer` + `uv.NewStyledString(view).Draw(...)`，对选区 cell 设置 `uv.AttrReverse`。
- 保留 `paintColumnRange` 作为低层工具和回归样本，但不再作为 `renderHighlightRange` 的主实现。
- 覆盖 CJK double-width、emoji、nested ANSI、反向拖选、release 后短暂高亮与复制文本一致性。

### Phase 5 — 复制命令对齐 Bubble Tea 标准能力

Crush 用：

```go
tea.SetClipboard(text)
clipboard.WriteAll(text)
```

BabeL-O 当前手写 OSC 52：

```go
tea.Printf("%s", buildOSC52Sequence(text))
clipboard.WriteAll(text)
```

评估结论：暂不切到 `tea.SetClipboard(text)`。

- 优点：语义更清晰，交给 Bubble Tea 维护 OSC 52 细节。
- 风险：当前 `buildOSC52Sequence` 已有测试/行为稳定；迁移需确认 Bubble Tea v1.3.10 行为一致。

本阶段不是修复高亮覆盖 bug 的前置条件；当前保留手写 OSC 52 builder + native clipboard fallback。

## 7. 验证矩阵

必须覆盖：

- Go unit tests：selection state、range normalization、highlight ANSI 存在、copy text 一致。
- Go TUI mouse tests：press/motion/release 后状态变化与 view 输出。
- `go test ./...`。
- 如改动 Bubble Tea clipboard：增加 OSC 52 sequence 或 command 行为回归。

建议人工验收：

1. `bbl go --mouse` 启动。
2. 在 assistant markdown、多行 Bash output、普通 status line 上拖选。
3. 拖动过程中有明显高亮。
4. release 后短时间仍能看到最后高亮或明确 toast。
5. 剪贴板内容无 ANSI 控制字节。
6. overlay 打开时拖动不会选中背后的 transcript。

## 8. 非目标与风险

非目标：

- 不把 Go TUI 整体改为 Crush 的 ultraviolet screen renderer；仅 selection highlight 使用 cell buffer。
- 不升级 Bubble Tea 大版本。
- 不扩展到任意 overlay 文本选择；先守住 transcript viewport。
- 不改变 TypeScript CLI 行为。

风险：

- 高亮保留时间过长可能干扰 streaming transcript 的视觉更新。
- per-item range 计算若与 blank line / transcript gap 处理不一致，会造成 off-by-one。
- `SetHighlight` no-op 化需要确保清理旧 highlight 时仍能 invalidate。
- 主题色调整可能影响低对比终端。

## 9. 后续观察项

当前推荐继续观察真实 `bbl go --mouse` 使用反馈，只有再次出现以下情况时重开实现项：

1. release 后 300ms 保留窗口仍不足以让用户确认选区。
2. transcript blank-line / wrapped markdown / Bash preview 继续出现 off-by-one 高亮。
3. `uv.AttrReverse` 在个别终端主题下对比度不足，需要换成主题化 foreground/background cell style。
4. Bubble Tea v1.3.10 的 `tea.SetClipboard` 被验证与现有 OSC 52 builder 完全等价，且维护收益超过迁移风险。

仍不建议立即做：

- 大规模重写 viewport/render pipeline。
- 把 selection 扩展到所有 overlay。
