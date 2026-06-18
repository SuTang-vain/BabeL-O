# Go TUI History Ledger

> State: History
> Governance: Indexed by [README.md](./README.md). This ledger consolidates closed reference documents so active architecture references stay small.

This history ledger preserves closed implementation context without keeping every completed plan as a standalone reference document. Current priorities remain in [../TODO.md](../TODO.md) and active implementation detail remains in [../active/](../active/).

## Consolidated Sources

| Closed item                                                            | Original file                                     | Closure status                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Go TUI Long-Term Rewrite Plan                                          | `go-tui-rewrite-plan.md`                          | **Stable alternative to `bbl chat` (promoted 2026-06-10 via Phase 9)**                                                                                                                                                                                                                 |
| bbl loop — Go Multi-session Pane TUI Plan                              | `go-tui-loop-multipane-plan.md`                   | **Core landed / Watch（2026-06-17）** — Phase 0–6' 的多 pane、wait-event、persist snapshot、permission / scope / inbox 可视化主路径已落地。真实 session identity、replay、PTY smoke、文档同步继续按 [../TODO.md](../TODO.md) 和 [../active/TODO_tui.md](../active/TODO_tui.md) Watch。 |
| Go TUI Permission Policy / Bash Hard-Deny 治理规划                     | `go-tui-permission-policy-governance-plan.md`     | Phase A + B + C + D + E 全部已落地（治理收口）；Phase A.1 增强权限面板 Round 1（多选项 + session scope）+ Round 2（inline rule / feedback editor）均已落地；Phase B 推进（CLI 软拒绝透传 `BABEL_O_CLI_POLICY_MODE`）已落地                                                             |
| Go TUI Text Selection Highlight And Clipboard Copy Optimization Record | `go-tui-selection-highlight-optimization-plan.md` | Resolved / Closed — the Go TUI `--mouse` selection-without-visible-highlight regression is closed through a narrow `ultraviolet` cell-buffer selection highlight. Phase 5 evaluated `tea.SetClipboard` and intentionally keeps the current OSC 52 path for now.                        |

## Go TUI Long-Term Rewrite Plan

**Original file**: `go-tui-rewrite-plan.md`

**Closed status**: **Stable alternative to `bbl chat` (promoted 2026-06-10 via Phase 9)**

Go TUI 重写不是把 BabeL-O 改写成 Go 项目，也不是替代 Nexus-first 架构。它的目标是验证并逐步建设一个更稳定、更易做终端布局、更适合长会话交互的独立 TUI 客户端：

````text
TypeScript Nexus owns execution, runtime, context, storage, agent orchestration and permission decisions.

## 中文概述

### 背景

Go TUI 重写用于验证更稳定的终端布局、键盘路由、overlay 和事件渲染体验。

### 边界

Go TUI 是 stable opt-in client，不替代 TypeScript Nexus，也不拥有 runtime、context、storage、provider loop、AgentScheduler 或权限决策。

### 当前状态

Phase 9 后作为 Closed Reference 保留。后续新增能力应优先补 Nexus API/event schema，再由 Go TUI 消费。

---

## bbl loop — Go Multi-session Pane TUI Plan

**Original file**: `go-tui-loop-multipane-plan.md`

**Closed status**: **Core landed / Watch（2026-06-17）** — Phase 0–6' 的多 pane、wait-event、persist snapshot、permission / scope / inbox 可视化主路径已落地。`bbl chat` 继续是生产默认入口，本规划不替换它，只新增并列前端；真实 session identity、replay、PTY smoke、文档同步仍按 active TODO 继续守门。

`bbl chat` 与 `bbl go` 都是「单 session、单对话面板」。随着真实编程会话越来越长、越来越多 agent / 子任务并行编排（BabeL-O 主线 / 子 agent / memory 审查 / 端到端测试），单 panel 缺少：
- 多 session 并发观测能力（同一时间只看见一条 stream）
- session 间 status 聚合视图（blocked / drift / waiting / done）

## 中文概述

### 背景

`bbl loop` 规划多 session pane TUI，用于同时观察多个 session 的 transcript、状态、权限和协作信号。

### 边界

它是 pane client，不是 scheduler。所有执行、上下文、权限和 session truth 仍来自 Nexus API/event。

### 当前状态

本文作为 History Ledger 保留核心设计背景；当前打开项迁移到 TODO / active 文档。后续只在真实 session 显示回归、replay/PTY smoke drift 或 Nexus API 契约变化时重新开实现项。

---

## Go TUI Permission Policy / Bash Hard-Deny 治理规划

**Original file**: `go-tui-permission-policy-governance-plan.md`

**Closed status**: Phase A + B + C + D + E 全部已落地（治理收口）；Phase A.1 增强权限面板 Round 1（多选项 + session scope）+ Round 2（inline rule / feedback editor）均已落地；Phase B 推进（CLI 软拒绝透传 `BABEL_O_CLI_POLICY_MODE`）已落地

`session_go_1781076550805204000` 暴露了一类与 execute-timeout 不同的真实问题：用户在 Go TUI 启动 code review 任务，模型在开场白决定先 `git status` 摸清 working tree 状态，Nexus policy 评估后直接 hard-deny `Bash`，**未发出 `permission_request`**。Go TUI 端的 `a/y/n/r/esc` 权限面板永远没机会弹出，session 在 8 秒内 failed，模型只输出了 131 tokens 的开场白就结束。
完整事件流（来自 `GET /v1/sessions/session_go_1781076550805204000?recentEventLimit=200`）：
```text

## 中文概述

### 背景

真实 Go TUI 会话暴露过 Bash hard-deny 截胡 permission_request 的问题，用户无法通过权限面板介入。

### 边界

本文治理 Go TUI permission UX 和 soft-deny routing；最终权限策略仍由 Nexus/runtime policy 拥有。

### 当前状态

主要治理阶段已收口，作为 Closed Reference 保留。后续如出现新的权限漂移，应重新开 regression 项，而不是扩大本文状态。

---

## Go TUI Text Selection Highlight And Clipboard Copy Optimization Record

**Original file**: `go-tui-selection-highlight-optimization-plan.md`

**Closed status**: Resolved / Closed — the Go TUI `--mouse` selection-without-visible-highlight regression is closed through a narrow `ultraviolet` cell-buffer selection highlight. Phase 5 evaluated `tea.SetClipboard` and intentionally keeps the current OSC 52 path for now.

When Go TUI runs with `--mouse` / `MouseCapture`, the application receives terminal mouse events directly and native terminal drag selection is no longer reliable. BabeL-O therefore implements in-app transcript selection: press and drag inside the transcript viewport, track viewport-content line/column anchors, render a visible selection background while dragging, and copy the selected plain text through OSC 52 plus native clipboard fallback on release.
The reported issue was specific: selection and copy already worked, but the visible highlight was sometimes missing or incomplete. This is now resolved. The main selection highlight path uses a narrow `ultraviolet.ScreenBuffer` cell-level reverse highlight, and regression tests now lock copy behavior and visible selection range together.
The relevant implementation surface is:

## 中文概述

### 背景

Go TUI 开启 mouse capture 后终端原生选择不可靠，因此需要 in-app selection、高亮和剪贴板复制路径。

### 边界

本文只记录 selection highlight / clipboard regression，不改变整体渲染架构、不升级 Bubble Tea 大版本，也不影响 Nexus/runtime ownership。

### 当前状态

问题已通过 cell-buffer selection highlight 收口，作为 Closed Reference 保留用于防回归。

## 中文概述

### 背景

本文件把已收口的 reference 长文合并为领域历史账本，减少 reference 目录中的长期噪音。

### 当前状态

原始长文已不再作为独立 reference 维护；后续只在真实回归或新决策出现时更新本 history ledger 或新增 ADR。
````
