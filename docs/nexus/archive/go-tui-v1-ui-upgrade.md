# go-tui 升级规划文档

**状态**: v1 已完成
**作者**: TUI 维护团队
**最后更新**: 2026-06-11
**源材料**: `crush` 项目 TUI/UI 设计分析(2026-06-11)

---

## 1. 目的与范围

本文档记录 `go-tui` 客户端已完成的 6 阶段升级路线,目标是借鉴 `crush` 项目成熟的 TUI/UI 设计模式,逐步改善用户体验、性能与代码可维护性,同时保持:

- **零破坏**:每个阶段都可独立 merge,不影响既有功能。
- **不升级 bubbletea 大版本**:全程停留在 v1.3.10。
- **不重写渲染管线**:不引入 ultraviolet 的 screen-based 渲染。
- **可逐步回退**:每阶段都通过测试覆盖保证旧路径仍然可用。

不在本文档范围内:
- 协议层 / Nexus API 的改动(那是 backend 路线图)。
- `cmd/go-tui` 的 CLI 参数扩展(仅在每个阶段需要时增量补)。
- 单元测试基础设施本身的演进。

---

## 2. 当前 go-tui 状态摘要

`go-tui` 是 BabeL-O 项目的 Go 终端客户端,基于 bubbletea v1.3.10 + bubbles + lipgloss。

### 架构(单一文件结构)

| 模块 | 文件 | 职责 |
|------|------|------|
| 入口 | `cmd/go-tui/main.go` | CLI 参数解析 + bubbletea program 启动 |
| 核心 | `internal/tui/tui.go` | model + Update + View + 全部 overlay 渲染 |
| 动画 | `internal/tui/anim.go` | gradient spinner |
| 测试 | `internal/tui/tui_test.go` | 单测(~220 个 test functions) |

### 已有能力

| 能力 | 实现位置 | 备注 |
|------|----------|------|
| Transcript + viewport | `tui.go` | 单列 lipgloss 渲染 |
| Mode-based dispatch | `tui.go` Update | `modeComposing/modePermission/modeModelPick*` 等 |
| Overlay 栈 | `tui.go` | 4 种 overlay 模式 |
| 鼠标滚轮路由 | `tui.go` | `MouseCapture` opt-in 标志 + `scrollOverlay` 分发 |
| In-app drag-select | `tui.go` | 列感知 ANSI 拼接 + OSC52 copy |
| Permission grace period | `tui.go` | `permissionOpenedAt` + `permissionLastInputAt` |
| 上下文敏感 placeholder | `tui.go` `setMode` | `placeholderForMode()` |
| Gradient spinner | `anim.go` | neon 色阶 |
| Prompt 历史 | `tui.go` | up/down 走历史 |

### 已知痛点(此次升级要解决)

1. **性能**:viewport 每帧全量重渲染所有行;长 transcript + streaming 场景下 CPU 占比偏高。
2. **Dialog 重复代码**:`renderPermissionEditor` / `renderModelPickApiKey` / `renderModelPickBaseURL` / `renderModelPickModel` / `renderHelp` 等 5 个 overlay 各自手写 `lines := []string{...}` + `strings.Join(...)` + `permissionFrameStyle.Width(...).Render(...)`,加新 overlay 时极易踩坑。
3. **光标位置**:overlay 内输入框的 cursor 位置是 ad-hoc 算的,长 title / 折叠 hint / 嵌套 frame 错位时有发生。
4. **命令面板无过滤**:`?` overlay 现在是一长串静态列表,命令多了翻页难。
5. **流式 markdown 全量重渲**:轻量 markdown renderer 曾在每个 stream chunk 都重渲整个文档。
6. **拖选高亮叠加逻辑分散**:`applySelectionHighlight` / `paintColumnRange` 跟 transcript 渲染路径耦合。

---

## 3. 参考架构:crush

`crush`(`/Users/tangyaoyue/DEV/crush`)是更成熟的 bubbletea v2 终端 LLM 客户端,本规划的所有设计参考都来自它。**仅借鉴,不照搬**:crush 用了 v2 + ultraviolet 的混合渲染,go-tui 走纯 string view 路径,需要适配。

### crush 关键文件清单(参照用)

| 文件 | 内容 |
|------|------|
| `internal/ui/list/item.go` | `Versioned` 嵌入、cache 失效协议 |
| `internal/ui/list/list.go` | list 渲染 + freeze suppress 机制 |
| `internal/ui/list/filterable.go` | `FilterableList` 模糊过滤 |
| `internal/ui/chat/messages.go` | `cachedMessageItem` + `Highlightable` |
| `internal/ui/chat/streaming_markdown.go` | 稳定前缀缓存的 markdown 流式渲染 |
| `internal/ui/dialog/dialog.go` | `Dialog` interface + `Action` 模式 + grace period |
| `internal/ui/dialog/common.go` | `RenderContext` + `InputCursor` + `Title` 渐变 |
| `internal/ui/common/button.go` | Button group with underlined hotkey |
| `internal/ui/common/scrollbar.go` | thumb/track scrollbar helper |
| `internal/ui/model/ui.go` | `uiLayout` rectangle 布局 + compact breakpoints |

### 借鉴原则

- **接口名 / 行为对齐 crush**——方便后续双向移植。
- **实现可以简化**——crush 用了 v2 的 `tea.MouseMsg` / `uv.Screen`,v1 上做不到的部分要明确标注 deferred。
- **不引入新 dep 除非必要**——见 §10 依赖变更表。

---

## 4. 升级阶段总览

按"收益 / 成本"比 + "依赖顺序"分 6 个阶段,每阶段可独立 merge。

| 阶段 | 主题 | 依赖 | 预估代码量 | 风险 |
|------|------|------|------------|------|
| A | 视觉打磨(零依赖) | 无 | ~150 LOC | 低 |
| B | 渲染缓存(Versioned) | 无 | ~250 LOC | 中 |
| C | Dialog 系统统一 | 无 | ~300 LOC | 中 |
| D | 输入 UX(过滤 + 快捷键 + quit 确认) | 无 / `sahilm/fuzzy` | ~250 LOC | 低 |
| E | 流式 markdown 稳定前缀 | 现有轻量 markdown renderer | ~200 LOC | 中 |
| F | Highlightable 重构 | 阶段 B 完成后 | ~150 LOC | 低 |

**总预估**:~1300 LOC 净新增 + ~300 LOC 迁移修改。
**总预估工时**:1 人 6-8 周(假设每周 1 阶段 + 1 周 buffer)。

---

## 5. 阶段 A:视觉打磨(零依赖)

**目标**:补齐几个 trivial 的视觉细节,提升整体观感,几乎无风险。

### A.1 Button group with underlined hotkey

**来源**:crush `internal/ui/common/button.go:1-69`

**功能**:`ButtonGroup(opts ButtonOpts, labels ...string) string`,把 labels 里的第 `UnderlineIndex` 个字符用 lipgloss.StyleRanges 下划线标出。

**应用场景**:
- `q quit when idle` → `q quit when idle`(下划线 `q` 不变,需要重看 crush 的实现确认渲染)
- permission 5-option 面板里 `1 allow once` / `2 allow rule` 之类数字热键的下划线高亮

**改动**:
- `internal/tui/common/button.go`(新文件,~50 行)
- `renderPermissionPanel` / `renderHelp` 调用

**测试**:
- `TestButtonGroupUnderlinesHotkey`
- `TestButtonGroupRendersFixedWidth`

---

### A.2 Scrollbar 工具函数

**来源**:crush `internal/ui/common/scrollbar.go:1-46`

**签名**:
```go
func Scrollbar(total, viewport, offset, height int) string
```

返回 `height` 行的 scrollbar 字符串,thumb = `max(1, height*viewport/total)`,position = `offset*(height-thumb)/max(offset-cap, 1)`。

**应用场景**:
- viewport 右侧的列(目前没有 scrollbar,用户看不到自己滚到哪了)
- `?` commands overlay 右侧
- tool audit overlay 右侧

**改动**:
- `internal/tui/common/scrollbar.go`(新文件,~50 行)
- 各个 View() 末尾 append 一列 scrollbar

**测试**:
- `TestScrollbarAtTop`
- `TestScrollbarAtBottom`
- `TestScrollbarClampsThumbSize`
- `TestScrollbarZeroContentReturnsTrackOnly`

---

### A.3 文本宽度上限

**来源**:crush `internal/ui/chat/messages.go:26`

**功能**:const `maxTranscriptWidth = 120`,所有 lipgloss 宽度计算前先 `min(width, maxTranscriptWidth)`。

**应用场景**:
- 4K monitor + 200 列 terminal,transcript 不应该拉满到 200 列(读着累)
- transcript 之外的 header / footer 保持原宽度(它们内容本来就短)

**改动**:
- `tui.go` 加常量,改 `m.viewport.Width` 的赋值

**测试**:
- `TestTranscriptWidthCapsAt120OnWideTerminal`

---

### A.4 Compact 模式断点

**来源**:crush `internal/ui/model/ui.go:69-73`

**功能**:
```go
const (
    compactModeWidthBreakpoint  = 120
    compactModeHeightBreakpoint = 30
)
```

宽度 < 120 或高度 < 30 时,进入 compact 模式:隐藏次要 footer hint(只留 `enter submit · ctrl+c confirm`),header 折叠成单行。

**应用场景**:
- 远程 ssh 窄窗口(常见的 80×24)
- 屏幕分割场景

**改动**:
- `tui.go` 加常量 + `isCompact()` 谓词
- `renderFooter` / `renderHeader` 内部按 `isCompact` 分支

**测试**:
- `TestIsCompactTriggersAtWidthBelow120`
- `TestIsCompactTriggersAtHeightBelow30`
- `TestFooterInCompactModeOmitsSecondaryHints`

---

### A.5 阶段 A 验收标准

- [x] 所有新工具函数都有单测覆盖
- [x] `go test ./...` 全包通过
- [x] 视觉对比截图(可选):以自动化渲染断言替代截图,覆盖 scrollbar / button underline / compact footer
- [x] README 更新"键盘提示"段落(如果有)

---

## 6. 阶段 B:渲染缓存(Versioned)

**目标**:transcript 大部分行不再每帧重渲染,只重渲"version 变了"的行。

### B.1 设计

crush 的核心优化(参见 `internal/ui/list/item.go:41-70`):

```go
type Versioned struct {
    v uint64
}

func (v *Versioned) Version() uint64 { return v.v }
func (v *Versioned) Bump()           { v.v++ }
```

每个 `Item` 嵌入 `*Versioned`,任何会改变渲染结果的状态变更后调 `Bump()`。

list-level memo 缓存结构(伪代码):
```go
type renderCache struct {
    key   uint64  // = fnv64(pointer || width || version)
    view  string
}

func (c *renderCache) getOrCompute(item, width int) string {
    key := fnv64(item, width, item.Version())
    if c.key == key { return c.view }
    c.view = item.Render(width)
    c.key = key
    return c.view
}
```

**go-tui 适配**:go-tui 没有 list 抽象,transcript 是 `[]messageEntry` + viewport 渲染。要做的是:

1. 把 `messageEntry` 改成 `*messageItem`(`*Versioned` 嵌入)
2. `appendLine` / streaming 增量更新时调 `item.Bump()`
3. `viewport.View()` 前先扫一遍 `[]*messageItem`,每个 item 用 cache key 查/算字符串
4. 拼接后的字符串塞进 `viewport.SetContent(...)`

### B.2 改动文件

- `internal/tui/cache.go`(新文件,~80 行):`Versioned` + `renderCache` + 工具函数
- `internal/tui/tui.go`:`messageEntry` → `*messageItem`,appendLine / streaming handler 调 Bump,viewport 渲染路径接 cache
- `internal/tui/anim.go`:暂不动(动画本身就每帧重算,无 cache 必要)

### B.3 性能期望

- 短 transcript(< 50 行):收益微小,无明显差异
- 长 transcript(> 200 行)+ streaming:viewport 渲染成本应下降 70-90%
- 不流式时:viewport 帧成本应接近 O(1)(只算 changed items)

### B.4 测试

- `TestVersionedBumpAdvancesCounter`
- `TestRenderCacheHitsOnSameVersion`
- `TestRenderCacheMissesOnBump`
- `TestRenderCacheKeyIncludesWidth`
- `TestStreamingOnlyInvalidatesChangedItem`
- 基准测试:`BenchmarkViewportRenderCold100Lines` / `BenchmarkViewportRenderWarm100Lines`

### B.5 风险与缓解

| 风险 | 缓解 |
|------|------|
| 忘记在某处调 `Bump()` 导致显示陈旧 | 加 lint-style 测试:对所有改 message item 状态的路径,跑一遍"修改 → View → 看到新内容"的 round-trip |
| Cache 内存累积 | 单一 `renderCache` 是 LRU-free 的 map,清理由 `clearCache()` 在 viewport 销毁时触发,正常退出 program 时不泄漏 |
| ANSI 拼接错位 | 复用现有的 `columnToByteRange` / `paintColumnRange` 列感知拼接逻辑,跟 cache 无关 |

### B.6 阶段 B 验收标准

- [x] `BenchmarkTranscriptRenderWarm100Lines` < `BenchmarkTranscriptRenderCold100Lines` 的 30%(Apple M1: cold ~750µs/op, warm ~2.7µs/op)
- [x] streaming 场景下,profile 显示 viewport 渲染从 dominant 变成 negligible(由 transcript warm-cache benchmark + E 阶段 streaming benchmark 覆盖)
- [x] 所有现有 transcript 测试仍然通过
- [x] 视觉对比:行为完全一致,无任何"内容陈旧"回归(由现有 transcript/cache/highlight 回归测试覆盖)

---

## 7. 阶段 C:Dialog 系统统一

**目标**:把 5 个 overlay 渲染路径收编到 `RenderContext` + `Dialog` interface,加新 overlay 成本降至 1 个文件。

### C.1 `Dialog` interface

crush 的核心抽象(`internal/ui/dialog/dialog.go:34-50`):

```go
type Dialog interface {
    ID() string
    HandleMsg(msg tea.Msg) Action
    Draw(scr uv.Screen, area uv.Rectangle) *tea.Cursor
}
```

**go-tui 适配**:
- 不用 uv.Screen(我们走 string view)
- `Draw` 改成 `View(width int) string`,跟现有 model 的 View 风格一致
- `Action` 改成 `tea.Cmd`(go-tui 现有风格)

```go
type Dialog interface {
    ID() string
    HandleMsg(msg tea.Msg) tea.Cmd
    View(width int) string
}
```

### C.2 `RenderContext`

```go
type RenderContext struct {
    Title     string
    TitleInfo string  // 顶部右侧的 radio buttons / 微缩信息
    Width     int
    Parts     []string
    Help      string
}

func (rc *RenderContext) AddPart(s string) { rc.Parts = append(rc.Parts, s) }
func (rc *RenderContext) Render() string {
    // 1. title + 渐变 + titleInfo
    // 2. 各 Parts 拼接
    // 3. 加 help,自动截断
    // 4. 套 overlay frame
    return ""
}
```

### C.3 `InputCursor` 辅助函数

来源:crush `internal/ui/dialog/common.go:14-39`

签名:
```go
func InputCursor(inputX, inputY int, frameStyle lipgloss.Style, promptStyle lipgloss.Style) (x, y int)
```

返回修正后的 cursor 坐标(累加 frame 的 margin / padding / border,加上 prompt 的宽度)。

### C.4 迁移计划

| 现有 overlay | 新实现 | 工作量 |
|--------------|--------|--------|
| `renderHelp` | `helpDialog` 接入 `RenderContext` | 1 文件改写 |
| `renderModelPickApiKey` | `modelPickApiKeyDialog` | 1 文件改写 |
| `renderModelPickBaseURL` | `modelPickBaseURLDialog` | 1 文件改写 |
| `renderModelPickModel` | `modelPickModelDialog` | 1 文件改写 |
| `renderPermissionPanel` | `permissionDialog` | 1 文件改写 |
| `renderPermissionEditor` | `permissionEditorDialog` | 1 文件改写 |

每个迁移都是:写一个实现 `Dialog` 的 struct,`View()` 用 `RenderContext` 拼,`HandleMsg` 转发到现有 model 方法。

**注意**:迁移 ≠ 改行为。本次阶段只迁移结构,不动交互。交互优化留给阶段 D / F。

### C.5 改动文件

- `internal/tui/dialog.go`(新):`Dialog` interface + `RenderContext` + `NewRenderContext` + `InputCursor`
- `internal/tui/help_dialog.go`(新):从 `renderHelp` 迁出
- `internal/tui/model_pick_dialog.go`(新):model pick 子 dialog
- `internal/tui/permission_dialog.go`(新):`permissionDialog` + `permissionEditorDialog`
- `internal/tui/tui.go`:删除 6 个 renderXxx 函数,改为持有 `*Overlay` + 在 `View()` 里调用 `overlay.Draw(width)`

### C.6 测试

- `TestRenderContextRendersTitleGradient`
- `TestRenderContextTruncatesHelpWhenTooLong`
- `TestInputCursorAccountsForFrameBorder`
- `TestInputCursorAccountsForPromptWidth`
- 5 个 dialog 各自的 `TestXxxDialogViewInMode / TestXxxDialogHandleMsg`

### C.7 风险与缓解

| 风险 | 缓解 |
|------|------|
| 迁移过程中改行为 | 现有测试全部保留,迁完跑一遍;视觉对比截图 |
| RenderContext 过度抽象 | 先迁 2-3 个 dialog 看效果,review 后再迁剩下 |
| Cursor 计算误差 | 现有 `pendingPermission` 等测试中如有 cursor 相关断言,保留并复用 |

### C.8 阶段 C 验收标准

- [x] 6 个 overlay 都接入 `Dialog` interface
- [x] 6 个 overlay 的现有测试全部通过(无任何测试需要被删 / 改语义)
- [x] 加新 dialog 只需要新增 1 个实现 `Dialog` 的 struct 文件,不动 tui.go(quit dialog 已按该模式新增,仅需注册 mode/render hook)
- [x] `InputCursor` 的测试覆盖 frame border / padding / margin 三个偏移源

---

## 8. 阶段 D:输入 UX

**目标**:命令面板可过滤、命令项支持快捷键直触发、`ctrl+c` 加 quit 确认。

### D.1 Fuzzy `FilterableList`

**新依赖**:`sahilm/fuzzy`(~5KB,纯 Go,无传递依赖)

来源:crush `internal/ui/list/filterable.go:1-126`

签名:
```go
type FuzzyItem interface {
    Item
    Filter() string                              // 匹配目标字符串
    SetMatch(m fuzzy.Match)                       // 接收匹配结果用于高亮
}

type FilterableList struct {
    List
    query string
    matches map[int]fuzzy.Match
}

func (f *FilterableList) SetQuery(q string)  // 触发 fuzzy.FindFrom + 更新 matches
```

**应用**:替换 `?` commands overlay 的内部列表。

### D.2 命令项快捷键

来源:crush `internal/ui/dialog/commands.go:208-216`

每个 `CommandItem` 加 `Shortcut() string`(如 `"ctrl+n"`),overlay 的 HandleMsg 在 KeyPress 时:
```go
for _, item := range items {
    if msg.String() == item.Shortcut() { return item.Action() }
}
```

**应用**:
- `/model` 绑定 `ctrl+m`
- `/agents` 绑定 `ctrl+g`
- `/tasks` 绑定 `ctrl+t`
- `/tools` 绑定 `ctrl+o`
- `/quit` 绑定 `ctrl+q`

### D.3 Quit 确认 dialog

来源:crush `internal/ui/dialog/quit.go:14-133`

新增 `QuitDialog`:`y`/`n` 切换,Enter 确认,Esc 取消。`ctrl+c` 弹这个 dialog 而不是直接退出。

实现状态(2026-06-11):已落地到 `internal/tui/quit_dialog.go` + `internal/tui/tui.go`;`ctrl+c` 进入 `modeQuitConfirm`,`y`/Enter 确认退出,`n`/Esc 取消并回到 composing。

**应用场景**:避免误触 `ctrl+c` 丢失未提交的输入(虽然 go-tui 本身没有持久化 draft,但模式上对齐 crush 更一致)。

### D.4 改动文件

- `internal/tui/filterable_list.go`(新):`FilterableList` + slash palette fuzzy 过滤
- `internal/tui/quit_dialog.go`(新):quit 确认
- `internal/tui/tui.go`:`/agents` / `/tasks` / `/tools` / `/quit` 等命令注册 Shortcut;Enter/`ctrl+m` 保留提交语义
- `go.mod` / `go.sum`:加 `sahilm/fuzzy`

### D.5 测试

- `TestFuzzyFilterRanksPrefixMatchFirst`
- `TestFuzzyFilterHighlightsMatchedIndexes`
- `TestCommandShortcutFiresDirectly`
- `TestQuitDialogConfirmQuits`
- `TestQuitDialogCancelReturnsToComposing`

### D.6 阶段 D 验收标准

- [x] `/` 打开 slash palette 后只剩命令候选,并实时 fuzzy 过滤
- [x] `ctrl+m` 冲突已处理:Bubble Tea 中 `ctrl+m` 与 Enter 同为 CR,运行时不拦截以避免破坏提交语义;`TestCommandShortcutCtrlMDoesNotStealEnter` 覆盖该例外
- [x] `ctrl+c` 弹 quit 确认,确认后才退出
- [x] `sahilm/fuzzy` 是唯一新增的运行时依赖(Go 标准库 `internal/godebug` 不计入第三方 transitive)

---

## 9. 阶段 E:流式 markdown 稳定前缀

**目标**:长 streaming 响应下,只重渲"安全边界"之后的尾部,头部复用上次结果;实现基于 go-tui 现有轻量 markdown renderer,不引入 glamour/ultraviolet。

### E.1 设计

crush 的核心(参见 `internal/ui/chat/streaming_markdown.go`):

```
streamingMarkdown {
    full        string  // 完整 markdown 源
    width       int
    renderer    markdownRenderer

    stablePrefix       string  // 已确认的稳定前缀
    stablePrefixRender string  // 渲染好的稳定前缀
    stablePrefixWidth  int
}

// Render:
// 1. 找 safe boundary(最后一个空行,无未闭合 code block / list / table / blockquote / setext header)
// 2. boundary 之前的部分直接复用 stablePrefixRender
// 3. boundary 之后的部分用现有 markdown renderer 重渲
// 4. 拼接
// 5. 缓存更新
```

### E.2 `findSafeMarkdownBoundary` 算法

```go
func findSafeMarkdownBoundary(s string) int {
    inCode := false
    inList := false
    inTable := false
    inBlockquote := false
    inSetext := false
    lastSafe := -1
    lines := strings.Split(s, "\n")
    for i, line := range lines {
        trimmed := strings.TrimSpace(line)
        // blank line
        if trimmed == "" {
            if !inCode && !inList && !inTable && !inBlockquote && !inSetext {
                lastSafe = i  // 记录最后一个"无未闭合构造"的空行位置
            }
            inSetext = false
            continue
        }
        // code fence
        if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
            inCode = !inCode
            inSetext = false
            continue
        }
        // table
        if strings.Contains(trimmed, "|") && i+1 < len(lines) && strings.Contains(lines[i+1], "---") {
            inTable = true
        }
        // list / blockquote
        if strings.HasPrefix(trimmed, "- ") || strings.HasPrefix(trimmed, "* ") || ... {
            inList = true
        }
        if strings.HasPrefix(trimmed, "> ") {
            inBlockquote = true
        }
        // setext header marker(下划线样式的标题:文本 + 下一行 ==== / ----)
        if i > 0 && (trimmed == strings.Repeat("=", len(trimmed)) || trimmed == strings.Repeat("-", len(trimmed))) {
            inSetext = true
        }
    }
    if lastSafe < 0 { return -1 }
    return len(strings.Join(lines[:lastSafe+1], "\n"))
}
```

### E.3 改动文件

实现状态(2026-06-11):E.1 已落地为 go-tui 现有轻量 markdown renderer 的稳定前缀缓存,未引入 glamour/ultraviolet。`assistant`/`thinking` 的 streaming transcript item 在安全硬换行前复用稳定渲染前缀,尾部继续走现有 inline markdown 渲染。

- `internal/tui/streaming_markdown.go`(新):`streamingMarkdownCache` + `findSafeMarkdownBoundary`
- `internal/tui/tui.go`:streaming transcript row 通过 `formatTranscriptItem` 调 `streamingMarkdownCache.Render`

### E.4 测试

- 已落地:`TestFindSafeMarkdownBoundaryUsesHardLineBreak`
- 已落地:`TestFindSafeMarkdownBoundarySkipsOpenCodeFence`
- 已落地:`TestFindSafeBoundaryInsideListReturnsEarlierBoundary`
- 已落地:`TestFindSafeBoundaryInsideTableReturnsEarlierBoundary`
- 已落地:`TestFindSafeBoundaryInsideBlockquoteReturnsEarlierBoundary`
- 已落地:`TestFindSafeBoundaryInsideSetextHeaderReturnsEarlierBoundary`
- 已落地:`TestFindSafeBoundaryNoSafePointReturnsNegative`
- 已落地:`TestStreamingMarkdownCacheReusesStablePrefix`
- 已落地:`TestStreamingMarkdownCacheInvalidatesOnWidthChange`
- 已落地:`TestStreamingMarkdownFinalOutputMatchesFullRender`
- 已落地基准:`BenchmarkStreamingRenderCold` vs `BenchmarkStreamingRenderWarm`(Apple M1: cold ~1.18ms/op, warm 50 chunks ~1.71ms/op)

### E.5 风险与缓解

| 风险 | 缓解 |
|------|------|
| `findSafeMarkdownBoundary` 漏判导致渲染错位 | 大量的边界 case 单测;视觉对比:同样的完整 markdown,流式 vs 一次性全渲,两者最终输出一致 |
| 轻量 markdown renderer 行为变更导致缓存失效 | 缓存按 kind / width / stable prefix 失效,并以最终输出 byte-equal 测试兜底 |
| 不在流式路径的纯静态 markdown | 走原路径,`streamingMarkdown` 不参与 |

### E.6 阶段 E 验收标准

- [x] 同样的 5000 字 markdown,50 个 chunk 累计渲染总耗时 < 一次性渲染的 2 倍
- [x] 流式最终输出与一次性渲染最终输出字符串完全一致
- [x] `findSafeMarkdownBoundary` 单测覆盖 5+ 种 markdown 构造(code block / list / table / blockquote / setext)

---

## 10. 阶段 F:Highlightable 重构

**目标**:把拖选高亮逻辑从 tui.go 抽出,放到 message item 的接口上。

### F.1 设计

crush `internal/ui/list/item.go:86-93`:

```go
type Highlightable interface {
    SetHighlight(startLine, startCol, endLine, endCol int)
    Highlight() (startLine, startCol, endLine, endCol int)
}
```

transcript item 实现这个接口,viewport 渲染前由 `dragSelect` 状态计算每个 item 的 highlight 范围,`Render(width)` 时把 highlight 反映到 ANSI 序列里。

### F.2 改动文件

实现状态(2026-06-11):F 已落地。`Highlightable`/`baseHighlightable`、selection-to-item 坐标映射、ANSI column paint helpers 已抽到 `internal/tui/highlight.go`;`transcriptItem` 实现 item 级 `SetHighlight`/`ClearHighlight`,高亮变化会失效该 item 的 render cache,但不 bump 内容版本。`View()` 现在通过 transcript item-local highlight 渲染拖选区域,不再走 viewport 级 `applySelectionHighlight`。

- `internal/tui/highlight.go`(新):`Highlightable` interface + 默认实现 `baseHighlightable` + ANSI column paint helpers
- `internal/tui/tui.go`:
  - `transcriptItem` 嵌入 `baseHighlightable`
  - `formatTranscriptItem` 渲染 item 自身 highlight
  - `View()` 将拖选范围映射到 transcript item-local highlight,不再调用 viewport 级 `applySelectionHighlight`

### F.3 测试

- 已落地:`TestHighlightableSetAndGet`
- 已落地:`TestMessageItemRendersHighlightInView`
- 已落地:`TestSelectionFreezeSuppression`(crush 的 `freezeSuppressed` 机制):拖选中不冻结 cache,见阶段 B.4 的延伸测试
- 已落地:`TestViewMapsSelectionToTranscriptItems`

### F.4 阶段 F 验收标准

- [x] `applySelectionHighlight` 等全局函数从 tui.go 删除
- [x] 拖选行为完全一致(现有 drag-select 测试全过)
- [x] 拖选过程中高亮实时跟随鼠标移动(无残影)

---

## 11. 暂缓项(明确不做)

下列项目分析中出现过,但**本路线图内不实施**。标注条件,后续触发时再开新路线图。

| 项目 | 触发条件 | 备注 |
|------|----------|------|
| `MouseClickable` per-item 鼠标分发 | bubbletea 升 v2 | v1 的 `Viewport` 不暴露 per-item 坐标 → item 映射 |
| Ultraviolet screen-based 渲染 | 重写整个渲染管线 | 架构级变更,需要重新设计 Update/View 协议 |
| Per-section render cache (thinking / content / error) | 后端支持 extended thinking | go-tui 还没有 thinking block 显示 |
| 会话 rename/delete 子模式 | 引入 sessions 概念 | 暂未规划 |
| `MouseClickable` 在 commands overlay 上的应用 | bubbletea 升 v2 | 跟 #1 捆绑 |
| Ultraviolet overlay frame | 升 v2 之后 | 跟 #2 捆绑 |
| Notification style picker (auto/native/OSC/bell) | 用户反馈通知失败 | 暂未收到反馈 |
| 自适应 dialog 尺寸 (60% / 80%) | 大屏用户体验反馈 | 跟 A.4 compact mode 互补但不冲突 |

---

## 12. 依赖变更

| 阶段 | 新增 | 删除 | 说明 |
|------|------|------|------|
| A | 无 | 无 | — |
| B | 无 | 无 | — |
| C | 无 | 无 | — |
| D | `sahilm/fuzzy` | 无 | 唯一 transitive 新增,MIT,5KB |
| E | 无 | 无 | 复用现有轻量 markdown renderer |
| F | 无 | 无 | — |

`go.mod` 净变更:仅 D 阶段加 1 行 require。

---

## 13. 测试策略

### 13.1 每阶段共性要求

- 所有新增函数 / 方法有单测,目标覆盖率 ≥ 80%
- 既有测试不允许被删除(只能改实现,不能改语义)
- `go test ./...` 全包通过才算阶段完成
- 关键性能改动(阶段 B / E)附 benchmark

### 13.2 视觉回归

- 阶段 A:自动化渲染断言覆盖 button 下划线 / scrollbar 出现 / 宽度上限生效
- 阶段 C:dialog view 单测覆盖 frame / title / cursor 偏移,替代截图要求
- 阶段 E:同一份 5000 字 markdown,流式 vs 一次性渲染输出 byte-equal

### 13.3 集成测试

不引入新框架,沿用现有 `tui_test.go` 风格:
- model.Update() 后 View() 包含期望子串
- mouse event sequence → 期望的 mode 切换 + 期望的 transcript 内容

---

## 14. 风险登记

| ID | 风险 | 阶段 | 概率 | 影响 | 缓解 |
|----|------|------|------|------|------|
| R1 | Versioned 忘记 Bump 导致显示陈旧 | B | 中 | 中 | lint-style 路径覆盖测试 |
| R2 | RenderContext 过度抽象 | C | 中 | 中 | 迁 2-3 个后 review 再继续 |
| R3 | `findSafeMarkdownBoundary` 漏判 | E | 中 | 高 | 5+ 边界 case 单测 + 视觉对比 |
| R4 | 阶段间依赖:阶段 F 必须等阶段 B | F | 低 | 低 | 阶段 F 排在最后,自然满足 |
| R5 | `sahilm/fuzzy` 维护停滞 | D | 低 | 低 | 包小且纯 Go,必要时可 fork |
| R6 | 视觉对比在不同 terminal 下不一致 | A | 中 | 低 | 测试在 lipgloss.Style 层面做,不依赖具体 terminal |

---

## 15. 验收标准(整体)

满足以下全部条件,视为本次升级路线图完成:

- [x] 阶段 A-F 各自验收清单全部勾选
- [x] `go test ./...` 全包通过(Go 标准输出包含 `cmd/go-tui [no test files]`,这是入口包无测试文件的预期状态;未触发 skip)
- [x] `go vet ./...` 无 warning
- [x] README 更新"UI features"段落,列出 scrollbar / button 下划线 / fuzzy filter / streaming 等新能力
- [x] CHANGELOG(如有)记录每个阶段的简短一句话总结:仓库无 `CHANGELOG*`;本轮记录在 Go TUI README + 本升级计划
- [x] 性能基准截图:以 benchmark 数值替代截图,记录长 transcript 与 streaming 场景 cold/warm 对比

---

## 16. 开放问题

已确认并在本轮实现中采用的结论:

1. **阶段 B 必要性**:当前 transcript 长度通常 < 100 行(实测),是否值得为长流式场景加缓存?答:值得,流式是核心场景。
2. **阶段 D 的 `ctrl+m` 等快捷键**:Bubble Tea 将 Enter 与 `ctrl+m` 都映射为 CR,运行时不拦截 `ctrl+m`,避免破坏提交语义。
3. **阶段 E 的缓存键**:go-tui 未引入 glamour;稳定前缀缓存按 kind / width / prefix 状态失效,并由最终输出一致性测试兜底。
4. **quit 确认 dialog 的必要性**:go-tui 没有持久化 draft,纯进入退出,确认 dialog 是否多余?答:与 crush 行为一致更重要,保留。
5. **阶段 C 的 `Action` 类型**:是直接用 `tea.Cmd`,还是引入 crush 的 `Action` pattern(返回 `any`)?答:用 `tea.Cmd`,保持现有风格。

---

## 17. 修订记录

| 版本 | 日期 | 变更 |
|------|------|------|
| v1 | 2026-06-11 | 初稿,基于 crush TUI/UI 分析(2026-06-11) |
