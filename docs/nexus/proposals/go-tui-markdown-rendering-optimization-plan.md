# Go TUI Markdown Rendering Optimization Plan

> State: Draft
> Status: Phase 0 compile spike was attempted once on 2026-06-11; Glamour / Chroma dependency download was blocked by network timeout, and BabeL-O code was not changed.
> Priority: P2 — Go TUI reading experience / code-block readability improvement; no P0 regression currently drives it, so land it gradually through compile spike + assistant-only rendering.
> Related: `bbl go` transcript rendering, assistant streaming delta, render cache, ANSI selection/copy safety
> Governance: Indexed by [go-client-distribution-governance-index.md](../reference/go-client-distribution-governance-index.md). This document owns transcript rendering polish only; it must not change event semantics.

---

## 1. Background

BabeL-O Go TUI transcript rendering already has basic layout, CJK width handling, and per-item render cache, but Markdown support is still a lightweight handwritten implementation:

- `clients/go-tui/internal/tui/tui.go:6576` — `renderTranscript` iterates transcript items and hits per-item cache by `(width, version)`.
- `clients/go-tui/internal/tui/tui.go:6614` — `formatLine` renders user / assistant / tool / status by kind.
- `clients/go-tui/internal/tui/tui.go:6647` — assistant / thinking currently runs `wrapPlain` first, then adds two-space indentation line by line.
- `clients/go-tui/internal/tui/tui.go:8151` — `renderInlineMarkdown` only supports `` `code` ``, `**bold**` / `__bold__`, and `*italic*` / `_italic_`.
- `clients/go-tui/internal/tui/tui.go:8234` — `wrapPlain` folds paragraphs and wraps plain text first, which is unfriendly to block Markdown such as fenced code blocks, lists, tables, and blockquotes.
- `clients/go-tui/internal/tui/cache.go:30` — existing per-item render cache can support a heavier renderer, but streaming tail still needs caution.

User-facing issue: when the model outputs Markdown, especially code blocks and lists, Go TUI can only show approximate plain text. Fenced code blocks in complex answers have no language highlighting, and tables / quotes / list hierarchy are not structurally presented, making readability weaker than mature TUIs such as Crush.

---

## 2. Crush Comparison

Crush renders Markdown through: **Glamour renders Markdown → Chroma highlights code blocks → Lip Gloss outputs ANSI styles**.

Key reference points:

- `/Users/tangyaoyue/DEV/crush/internal/ui/common/markdown.go:45` — `MarkdownRenderer(sty, width)` creates and width-caches `glamour.TermRenderer`.
- `/Users/tangyaoyue/DEV/crush/internal/ui/common/markdown.go:51` — renderer uses `WithStyles`, `WithWordWrap`, and `WithChromaFormatter`.
- `/Users/tangyaoyue/DEV/crush/internal/ui/common/markdown.go:64` — `QuietMarkdownRenderer` is used for muted thinking / reasoning styles.
- `/Users/tangyaoyue/DEV/crush/internal/ui/common/markdown.go:130` — `LockMarkdownRenderer`; shared Glamour renderer is not concurrency-safe, so concurrent tests must serialize it.
- `/Users/tangyaoyue/DEV/crush/internal/ui/xchroma/chroma.go:14` — custom Chroma formatter: token style → `lipgloss.NewStyle()` → ANSI.
- `/Users/tangyaoyue/DEV/crush/internal/ui/styles/quickstyle.go:126` — Markdown theme configuration.
- `/Users/tangyaoyue/DEV/crush/internal/ui/styles/quickstyle.go:234` — code block / Chroma token styles.
- `/Users/tangyaoyue/DEV/crush/internal/ui/chat/assistant.go:511` — assistant body enters the Markdown renderer.
- `/Users/tangyaoyue/DEV/crush/internal/ui/chat/user.go:76` — user messages can also use the Markdown renderer.
- `/Users/tangyaoyue/DEV/crush/internal/ui/chat/streaming_markdown.go:10` — streaming stable-prefix cache avoids full Glamour render for every delta.
- `/Users/tangyaoyue/DEV/crush/internal/ui/chat/streaming_markdown.go:192` — `findSafeMarkdownBoundary` avoids splitting in the middle of code fence / list / table / blockquote.

The reusable part is the architecture shape, not a direct copy of the full code. Crush already uses `charm.land/*/v2` packages; BabeL-O Go TUI currently remains on the `github.com/charmbracelet/*` v1 line.

---

## 3. Target Behavior

1. **Assistant body supports full Markdown block rendering**: heading, paragraph, list, blockquote, table, inline code, bold, italic, and fenced code block should at least display correctly.
2. **Fenced code blocks have language highlighting**: use Chroma to identify languages such as ` ```ts ` / ` ```go ` and output terminal ANSI styles.
3. **Transcript layout does not jump**: assistant / thinking keep the two-space visual indentation; user / tool / status lines are not affected in the first phase.
4. **Performance does not regress to unusable**: keep the existing per-item render cache; if long streaming replies stutter, add Crush-style stable-prefix cache.
5. **ANSI semantics stay safe**: selection highlight, copy, `stripANSICodes`, and width calculation must not be broken by Markdown ANSI output.
6. **Failures fall back**: if Markdown renderer initialization or rendering fails, fall back to current `wrapPlain + renderInlineMarkdown` behavior.

---

## 4. Non-goals

- Do not migrate Go TUI to Bubble Tea / Lip Gloss v2.
- Do not replace the whole `formatLine`; only replace assistant / thinking body in the first phase.
- Do not change non-transcript-body rendering such as tool result / permission / status / profile picker.
- Do not change Markdown behavior outside `bbl go` (the TypeScript `bbl chat` was removed in v0.3.7).
- Do not implement full streaming stable-prefix cache in the first phase; use existing per-item cache + benchmark to decide whether it is needed.
- Do not copy Crush style structs directly into BabeL-O; extract only the renderer façade and necessary theme mapping.

---

## 5. Technical Feasibility

### 5.1 Dependency Choice

BabeL-O Go TUI currently depends on:

- `clients/go-tui/go.mod:6` — `github.com/charmbracelet/bubbles v1.0.0`
- `clients/go-tui/go.mod:7` — `github.com/charmbracelet/bubbletea v1.3.10`
- `clients/go-tui/go.mod:8` — `github.com/charmbracelet/lipgloss v1.1.0`

Crush currently depends on:

- `/Users/tangyaoyue/DEV/crush/go.mod:11` — `charm.land/glamour/v2`
- `/Users/tangyaoyue/DEV/crush/go.mod:12` — `charm.land/lipgloss/v2`
- `/Users/tangyaoyue/DEV/crush/go.mod:19` — `github.com/alecthomas/chroma/v2`

Recommended first step is a compile spike:

| Option | Approach | Recommendation |
|------|------|--------|
| A | Use `github.com/charmbracelet/glamour` (old import path) + current `github.com/charmbracelet/lipgloss` v1 | Preferred, smallest dependency disturbance |
| B | Use `charm.land/glamour/v2` without introducing Lip Gloss v2 into the UI main path | Backup, requires type-isolation validation |
| C | Migrate Bubble Tea / Lip Gloss v2 together | Not recommended, outside this optimization slice |

### 5.2 Rendering Entry

Suggested new file:

```text
clients/go-tui/internal/tui/markdown.go
```

Responsibilities:

- Wrap `renderAssistantMarkdown(text string, width int, quiet bool) string`
- Cache renderers by `width + quiet/theme` key
- Provide renderer mutex to avoid shared Glamour renderer state pollution in concurrent tests
- Provide fallback to `wrapPlain` + `renderInlineMarkdown` when rendering fails
- Trim Glamour margins consistently to avoid extra leading/trailing blank lines in transcripts

In `formatLine`, change assistant / thinking branches from:

```text
wrapPlain(text, width-2) → split lines → renderInlineMarkdown → prefix "  "
```

to:

```text
renderAssistantMarkdown(text, width-2, kind == "thinking") → indentRenderedBlock("  ")
```

Important: do not call `wrapPlain` before entering the Markdown renderer, otherwise fenced code blocks / lists / tables are already damaged.

---

## 6. Phased Rollout

### Phase 0: Compile Spike

Status: attempted once; dependency download was blocked (2026-06-11).

- Temporarily introduce Glamour + Chroma dependencies in `clients/go-tui`.
- Add a minimal `markdown.go` and run only one renderer smoke test.
- Verify that `go test ./...` and `go vet ./...` pass.
- Decide whether to use old `github.com/charmbracelet/glamour` or `charm.land/glamour/v2`.

Observed result on 2026-06-11:

- `go list -m -versions github.com/charmbracelet/glamour` → `proxy.golang.org` timeout, so the old import path version list could not be fetched.
- `go list -m -versions charm.land/glamour/v2` → `sum.golang.org` checksum timeout.
- `GOSUMDB=off go list -m -json charm.land/glamour/v2@v2.0.0` → local download metadata was readable, confirming v2.0.0 metadata exists.
- `GOSUMDB=off go mod download -json charm.land/glamour/v2@v2.0.0 github.com/alecthomas/chroma/v2@v2.26.1` → still timed out through `proxy.golang.org`, so source was not unpacked into module cache.
- Because source could not be downloaded, this attempt did not modify `clients/go-tui/go.mod` / `go.sum`, avoiding an uncompilable dependency state.

Exit criteria: dependency path is confirmed and Bubble Tea / Lip Gloss v2 migration is not triggered.

Prerequisite for next attempt: Go module cache contains source for `charm.land/glamour/v2@v2.0.0` or old `github.com/charmbracelet/glamour`, or network access to Go proxy / direct VCS works.

### Phase 1: Assistant-only Renderer Façade

Status: not started.

- Add `clients/go-tui/internal/tui/markdown.go`.
- Implement renderer cache + mutex + fallback.
- Replace only the assistant / thinking branches in `formatLine`.
- Keep existing user / tool / status rendering logic.

Exit criteria: ordinary assistant text, headings, and inline code remain visually compatible with the current UI; fallback works on error.

### Phase 2: Code Block Highlighting And Theme

Status: not started.

- Introduce a Chroma formatter or use Glamour built-in Chroma formatter.
- Build BabeL-O theme mapping: assistant foreground, muted, title, code block, inline code.
- Fenced code blocks support common languages such as `go` / `ts` / `json` / `bash`.
- Unknown languages fall back to plain code block.

Exit criteria: code blocks have stable ANSI output and do not affect terminal width / selection.

### Phase 3: Tests And Performance Gates

Status: not started.

Add / update Go tests:

- `TestRenderAssistantMarkdownHeading`
- `TestRenderAssistantMarkdownList`
- `TestRenderAssistantMarkdownFence`
- `TestRenderAssistantMarkdownOpenFenceFallback`
- `TestRenderAssistantMarkdownCJKWidth`
- `TestRenderAssistantMarkdownCacheStable`
- `TestRenderAssistantMarkdownStripANSISafe`

Add benchmarks:

- 100 transcript items, cold render
- 100 transcript items, warm render
- 1 streaming tail, bumped delta by delta

Exit criteria: warm cache remains significantly faster than cold render; long streaming does not visibly stutter.

### Phase 4: Streaming Stable-prefix Cache (As Needed)

Status: not started; depends on Phase 3 benchmark.

Implement only if Phase 3 proves full Glamour rendering of streaming tail is too heavy.

Can reference Crush:

- stable prefix string
- stable prefix rendered output
- width binding
- safe boundary detector
- conservatively refuse splitting inside open fence / list / table / blockquote

Exit criteria: streaming delta only re-renders trailing partial, while output remains visually equivalent to full render.

### Phase 5: Documentation And Closure

Status: not started.

- Update `docs/nexus/DONE.md` with actual dependency path, test commands, and performance conclusion.
- If Phase 4 remains open, add the open item to `docs/nexus/active/TODO_tui.md`.
- Change this document Status to landed or partially landed.

---

## 7. Risks And Mitigations

| Risk | Probability | Impact | Mitigation |
|------|------|------|------|
| Glamour dependency introduces Lip Gloss v2 and conflicts with current v1 UI types | Medium | High | Run Phase 0 compile spike first; prefer old import path |
| Markdown renderer outputs extra margins and breaks transcript spacing | High | Medium | Trim inside the façade and cover with `renderTranscript` golden tests |
| Full render for every streaming delta stutters | Medium | Medium | Keep per-item cache + benchmark first; implement Phase 4 if needed |
| ANSI highlighting breaks selection copy / width calculation | Medium | High | Cover `stripANSICodes`, selection highlight, and CJK width tests |
| Output jumps when code fence is not closed | Medium | Medium | Use open-fence fallback or safe-boundary strategy; do not force half-fence highlighting |
| User prompt Markdown rendering changes input echo unexpectedly | Medium | Low | Assistant-only in first phase; keep user as `> prompt` plain-text style |
| Code block theme becomes too colorful and hurts readability | Medium | Low | Use low-saturation colors and prioritize token-class distinction over IDE-like effects |

---

## 8. Verification Commands

Expected after implementation:

```bash
cd clients/go-tui
go test ./...
go vet ./...
go build -o bin/go-tui ./cmd/go-tui
```

If changes are limited to Go TUI, full TS tests are not required. If Nexus protocol or package scripts also change, add:

```bash
npm test
npx tsc --noEmit
```

Manual acceptance sample:

```text
Ask assistant to output:

# Title

- item A
- item B

```go
func main() {
    fmt.Println("hello")
}
```

> quote
```

Expected: heading is emphasized, list has structure, Go code block has highlighting, quote has visual indentation, and copied text has no invisible corruption.

---

## 9. Recommendation

BabeL-O can absorb Crush-style Markdown rendering improvements, but should proceed through **assistant-only + renderer façade + compile spike + benchmark gate**.

Do not replace the entire transcript renderer at once, and do not migrate Bubble Tea / Lip Gloss v2 just for Markdown optimization. The safest path is: first give assistant body full Markdown block rendering and fenced code block highlighting; if benchmarks show streaming pressure, then add Crush-style stable-prefix cache.

## 中文概述

### 背景

Go TUI 当前 Markdown 渲染仍偏轻量，代码块、表格、引用和列表层级的阅读体验弱于成熟 TUI。

### 边界

本文只治理 transcript rendering polish，不改变 Nexus event 语义，也不让 renderer 解释工具或 runtime 状态。

### 当前状态

作为 Draft 保留。Glamour / Chroma 等依赖引入需要先通过 compile spike、性能和 selection/copy 安全验证。
