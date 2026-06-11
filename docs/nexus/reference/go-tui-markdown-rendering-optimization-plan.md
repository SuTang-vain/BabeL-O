# Go TUI Markdown 渲染优化规划

> Status: Phase 0 compile spike 已尝试一次（2026-06-11），Glamour / Chroma 依赖下载受网络超时阻塞；BabeL-O 代码未改
> Priority: P2 — Go TUI 阅读体验 / 代码块可读性优化；当前没有 P0 regression 驱动，按 compile spike + assistant-only 渐进落地
> 关联: `bbl go` transcript 渲染、assistant streaming delta、render cache、ANSI selection/copy 安全

---

## 1. 背景

BabeL-O Go TUI 当前 transcript 渲染已经具备基础布局、CJK 宽度处理和 per-item render cache，但 Markdown 支持仍是轻量手写实现：

- `clients/go-tui/internal/tui/tui.go:6576` — `renderTranscript` 遍历 transcript item，并用 `(width, version)` 命中 per-item cache。
- `clients/go-tui/internal/tui/tui.go:6614` — `formatLine` 按 kind 渲染 user / assistant / tool / status。
- `clients/go-tui/internal/tui/tui.go:6647` — assistant / thinking 目前先 `wrapPlain`，再逐行加两个空格缩进。
- `clients/go-tui/internal/tui/tui.go:8151` — `renderInlineMarkdown` 只支持 `` `code` ``、`**bold**` / `__bold__`、`*italic*` / `_italic_`。
- `clients/go-tui/internal/tui/tui.go:8234` — `wrapPlain` 会先折叠段落并做纯文本换行；这对 fenced code block、list、table、blockquote 这类 block markdown 不友好。
- `clients/go-tui/internal/tui/cache.go:30` — 已有 per-item render cache，可承接更重的 renderer，但 streaming tail 仍需谨慎。

用户体感问题：模型输出 Markdown 时，尤其是代码块和列表，Go TUI 只能显示近似纯文本。复杂回答中的 fenced code block 没有语言高亮，表格 / 引用 / 列表层级也没有结构化呈现，阅读体验弱于 Crush 一类成熟 TUI。

---

## 2. Crush 对照实现

Crush 的 Markdown 渲染链路是：**Glamour 渲染 Markdown → Chroma 做代码块高亮 → Lip Gloss 输出 ANSI 样式**。

关键参考点：

- `/Users/tangyaoyue/DEV/crush/internal/ui/common/markdown.go:45` — `MarkdownRenderer(sty, width)` 创建并按 width 缓存 `glamour.TermRenderer`。
- `/Users/tangyaoyue/DEV/crush/internal/ui/common/markdown.go:51` — renderer 使用 `WithStyles`、`WithWordWrap`、`WithChromaFormatter`。
- `/Users/tangyaoyue/DEV/crush/internal/ui/common/markdown.go:64` — `QuietMarkdownRenderer` 用于 thinking / reasoning 的低调样式。
- `/Users/tangyaoyue/DEV/crush/internal/ui/common/markdown.go:130` — `LockMarkdownRenderer`；共享 Glamour renderer 不并发安全，测试并发时必须串行。
- `/Users/tangyaoyue/DEV/crush/internal/ui/xchroma/chroma.go:14` — 自定义 Chroma formatter：token style → `lipgloss.NewStyle()` → ANSI。
- `/Users/tangyaoyue/DEV/crush/internal/ui/styles/quickstyle.go:126` — Markdown 主题配置。
- `/Users/tangyaoyue/DEV/crush/internal/ui/styles/quickstyle.go:234` — code block / Chroma token 样式。
- `/Users/tangyaoyue/DEV/crush/internal/ui/chat/assistant.go:511` — assistant 正文进入 Markdown renderer。
- `/Users/tangyaoyue/DEV/crush/internal/ui/chat/user.go:76` — user 消息也可走 Markdown renderer。
- `/Users/tangyaoyue/DEV/crush/internal/ui/chat/streaming_markdown.go:10` — streaming stable-prefix cache，避免每个 delta 全量 Glamour render。
- `/Users/tangyaoyue/DEV/crush/internal/ui/chat/streaming_markdown.go:192` — `findSafeMarkdownBoundary` 避免切在 code fence / list / table / blockquote 中间。

可复用的是架构形态，不是整套代码原样搬运。Crush 已经使用 `charm.land/*/v2` 包；BabeL-O Go TUI 当前仍是 `github.com/charmbracelet/*` v1 系列。

---

## 3. 目标行为

1. **Assistant 正文支持完整 Markdown block 渲染**：heading、paragraph、list、blockquote、table、inline code、bold、italic、fenced code block 至少正确显示。
2. **Fenced code block 有语言高亮**：通过 Chroma 识别 ` ```ts ` / ` ```go ` 等语言，并输出终端 ANSI 样式。
3. **Transcript 布局不突变**：assistant / thinking 仍保持两空格视觉缩进；user / tool / status 行不受首阶段影响。
4. **性能不倒退到不可用**：保留现有 per-item render cache；长 streaming 回复如果出现卡顿，再引入 Crush 式 stable-prefix cache。
5. **ANSI 语义安全**：selection highlight、copy、`stripANSICodes`、宽度计算不能被 Markdown ANSI 输出破坏。
6. **失败可回退**：Markdown renderer 初始化或 render 出错时回到当前 `wrapPlain + renderInlineMarkdown` 行为。

---

## 4. 非目标

- 不迁移 Go TUI 到 Bubble Tea / Lip Gloss v2。
- 不替换整个 `formatLine`；首阶段只替换 assistant / thinking 正文。
- 不改变 tool result / permission / status / profile picker 等非 transcript 正文渲染。
- 不改 TypeScript `bbl chat` 的 Markdown 行为。
- 不在首阶段实现完整 streaming stable-prefix cache；先通过现有 per-item cache + benchmark 判断是否必要。
- 不把 Crush 的 style struct 原样复制到 BabeL-O；只抽取 renderer façade 和必要主题映射。

---

## 5. 技术可行性

### 5.1 依赖选择

BabeL-O Go TUI 当前依赖：

- `clients/go-tui/go.mod:6` — `github.com/charmbracelet/bubbles v1.0.0`
- `clients/go-tui/go.mod:7` — `github.com/charmbracelet/bubbletea v1.3.10`
- `clients/go-tui/go.mod:8` — `github.com/charmbracelet/lipgloss v1.1.0`

Crush 当前依赖：

- `/Users/tangyaoyue/DEV/crush/go.mod:11` — `charm.land/glamour/v2`
- `/Users/tangyaoyue/DEV/crush/go.mod:12` — `charm.land/lipgloss/v2`
- `/Users/tangyaoyue/DEV/crush/go.mod:19` — `github.com/alecthomas/chroma/v2`

推荐先做 compile spike：

| 方案 | 做法 | 推荐度 |
|------|------|--------|
| A | 使用 `github.com/charmbracelet/glamour`（旧 import path）+ 当前 `github.com/charmbracelet/lipgloss` v1 | 首选，最小依赖扰动 |
| B | 使用 `charm.land/glamour/v2`，但不引入 Lip Gloss v2 到 UI 主路径 | 备选，需验证类型隔离 |
| C | 同步迁移 Bubble Tea / Lip Gloss v2 | 不推荐，超出本优化切片 |

### 5.2 渲染入口

新增文件建议：

```text
clients/go-tui/internal/tui/markdown.go
```

职责：

- 封装 `renderAssistantMarkdown(text string, width int, quiet bool) string`
- 缓存 renderer：按 `width + quiet/theme` key
- 提供 renderer mutex：避免共享 Glamour renderer 在并发测试中状态污染
- 提供 fallback：render 失败时退回 `wrapPlain` + `renderInlineMarkdown`
- 统一 trim Glamour margin，避免 transcript 出现额外首尾空行

`formatLine` 中 assistant / thinking 分支从：

```text
wrapPlain(text, width-2) → split lines → renderInlineMarkdown → prefix "  "
```

改为：

```text
renderAssistantMarkdown(text, width-2, kind == "thinking") → indentRenderedBlock("  ")
```

注意：不能在进入 Markdown renderer 前调用 `wrapPlain`，否则 fenced code block / list / table 已经被破坏。

---

## 6. 分阶段推进

### Phase 0：compile spike

状态：已尝试一次，依赖下载阻塞（2026-06-11）

- 在 `clients/go-tui` 临时引入 Glamour + Chroma 依赖。
- 新增最小 `markdown.go`，只跑一个 renderer smoke test。
- 验证 `go test ./...` 和 `go vet ./...` 能通过。
- 决定使用旧 `github.com/charmbracelet/glamour` 还是 `charm.land/glamour/v2`。

2026-06-11 实测结果：

- `go list -m -versions github.com/charmbracelet/glamour` → `proxy.golang.org` 超时，旧 import path 版本列表不可取。
- `go list -m -versions charm.land/glamour/v2` → `sum.golang.org` 校验超时。
- `GOSUMDB=off go list -m -json charm.land/glamour/v2@v2.0.0` → 可读到本地 download metadata，确认 v2.0.0 元数据存在。
- `GOSUMDB=off go mod download -json charm.land/glamour/v2@v2.0.0 github.com/alecthomas/chroma/v2@v2.26.1` → 仍因 `proxy.golang.org` 超时，源码未能解压到 module cache。
- 因源码未能下载，本轮不修改 `clients/go-tui/go.mod` / `go.sum`，避免写入无法编译的依赖状态。

收口标准：依赖路径确定，且没有触发 Bubble Tea / Lip Gloss v2 迁移。

下一次推进前置条件：Go module cache 中可见 `charm.land/glamour/v2@v2.0.0`（或旧 `github.com/charmbracelet/glamour`）源码目录，或网络可正常访问 Go proxy / direct VCS。

### Phase 1：assistant-only renderer façade

状态：未启动

- 新增 `clients/go-tui/internal/tui/markdown.go`。
- 实现 renderer cache + mutex + fallback。
- 只替换 `formatLine` 的 assistant / thinking 分支。
- 保留 user / tool / status 原渲染逻辑。

收口标准：普通 assistant 文本、heading、inline code 与现有视觉基本兼容；错误时可回退。

### Phase 2：code block 高亮与主题

状态：未启动

- 引入 Chroma formatter 或使用 Glamour 内置 Chroma formatter。
- 建立 BabeL-O 主题映射：assistant foreground、muted、title、code block、inline code。
- fenced code block 支持 `go` / `ts` / `json` / `bash` 等常见语言。
- 未知语言 fallback 到 plain code block。

收口标准：代码块有稳定 ANSI 输出，不影响 terminal width / selection。

### Phase 3：测试与性能守门

状态：未启动

新增 / 更新 Go tests：

- `TestRenderAssistantMarkdownHeading`
- `TestRenderAssistantMarkdownList`
- `TestRenderAssistantMarkdownFence`
- `TestRenderAssistantMarkdownOpenFenceFallback`
- `TestRenderAssistantMarkdownCJKWidth`
- `TestRenderAssistantMarkdownCacheStable`
- `TestRenderAssistantMarkdownStripANSISafe`

新增 benchmark：

- 100 条 transcript cold render
- 100 条 transcript warm render
- 1 条 streaming tail 逐 delta bump

收口标准：warm cache 仍明显快于 cold render；长 streaming 不出现肉眼可感知卡顿。

### Phase 4：streaming stable-prefix cache（按需）

状态：未启动（依赖 Phase 3 benchmark）

只有在 Phase 3 证明 Glamour 全量渲染 streaming tail 过重时才实施。

可参考 Crush：

- stable prefix 字符串
- stable prefix rendered output
- width 绑定
- safe boundary detector
- open fence / list / table / blockquote 保守拒绝切分

收口标准：streaming delta 只重渲染 trailing partial，同时输出与 full render 视觉等价。

### Phase 5：文档与收口

状态：未启动

- 更新 `docs/nexus/DONE.md`，记录实际依赖路径、测试命令、性能结论。
- 若遗留 Phase 4，则在 `docs/nexus/active/TODO_tui.md` 增加未收口项。
- 本文 Status 改为已落地或部分落地。

---

## 7. 风险与对策

| 风险 | 概率 | 影响 | 对策 |
|------|------|------|------|
| Glamour 依赖引入 Lip Gloss v2，和现有 v1 UI 类型冲突 | 中 | 高 | Phase 0 compile spike 先行；首选旧 import path |
| Markdown renderer 输出额外 margin，破坏 transcript 间距 | 高 | 中 | façade 内统一 trim，并在 `renderTranscript` golden test 覆盖 |
| streaming 每个 delta 全量 render 卡顿 | 中 | 中 | 先保留 per-item cache + benchmark；必要时做 Phase 4 |
| ANSI 高亮破坏选择复制 / 宽度计算 | 中 | 高 | 覆盖 `stripANSICodes`、selection highlight、CJK width 测试 |
| code fence 未闭合时输出跳变 | 中 | 中 | open fence fallback 或 safe-boundary 策略，不强行半截高亮 |
| user prompt Markdown 渲染造成输入回显突变 | 中 | 低 | 首阶段 assistant-only；user 保持 `> prompt` 纯文本风格 |
| 代码块主题太花，降低可读性 | 中 | 低 | 使用低饱和色，优先区分 token 类别而不是追求 IDE 效果 |

---

## 8. 验证命令

实施完成后预期：

```bash
cd clients/go-tui
go test ./...
go vet ./...
go build -o bin/go-tui ./cmd/go-tui
```

如果改动仅限 Go TUI，不要求同步跑完整 TS 测试；若同时改了 Nexus 协议或 package 脚本，再补：

```bash
npm test
npx tsc --noEmit
```

手动验收样例：

```text
让 assistant 输出：

# 标题

- item A
- item B

```go
func main() {
    fmt.Println("hello")
}
```

> quote
```

预期：heading 有强调，list 有结构，Go code block 有高亮，quote 有视觉缩进，复制文本不会带不可见损坏。

---

## 9. 推荐结论

可以把 Crush 的 Markdown 渲染优化吸收到 BabeL-O，但应按 **assistant-only + renderer façade + compile spike + benchmark gate** 推进。

不建议一口气替换整个 transcript renderer，也不建议为了 Markdown 优化迁移 Bubble Tea / Lip Gloss v2。当前最稳路径是：先让 assistant 正文获得完整 Markdown block 渲染和 fenced code block 高亮；如果 benchmark 显示 streaming 压力明显，再引入 Crush 式 stable-prefix cache。
