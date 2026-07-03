# Go Client And Distribution Governance Index

> State: Index
> Track: Go TUI / Go Runner / Distribution
> Priority: P1 Watch
> Source of truth: `docs/nexus/TODO.md`, `docs/nexus/active/TODO_tui.md`, `docs/nexus/active/TODO_runtime.md`, `docs/nexus/active/TODO_cleanup.md`, `docs/nexus/DONE.md`, `docs/nexus/WORK_LOG.md`, `clients/go-tui/`, `src/cli/commands/go.ts`, `scripts/install.sh`, `scripts/package-portable.mjs`, `docs/releases/`
> Related: [go-tui-history.md](../history/go-tui-history.md), [go-tui-history.md](../history/go-tui-history.md), [go-tui-session-observability-governance-plan.md](../proposals/go-tui-session-observability-governance-plan.md), [go-tui-history.md](../history/go-tui-history.md), [go-tui-markdown-rendering-optimization-plan.md](../proposals/go-tui-markdown-rendering-optimization-plan.md), [go-tui-history.md](../history/go-tui-history.md), [go-runner-plan.md](../proposals/go-runner-plan.md), [distribution-strategy-plan.md](./distribution-strategy-plan.md), [distribution-guide.md](../../guides/distribution-guide.md)

## Purpose

This document is the reader entry point for BabeL-O Go client, optional Go runner, and distribution governance. It keeps three similar-looking but separate lines from drifting together:

- Go TUI / `bbl go` and `bbl loop` are clients.
- Go Runner is an optional approved-tool execution backend.
- Distribution decides how users install and launch the product.

None of these lines moves provider loops, context assembly, session truth, permission decisions, AgentScheduler, or storage ownership out of TypeScript Nexus.

## Ownership Map

| Document | Role | Reading rule |
| --- | --- | --- |
| [go-tui-history.md](../history/go-tui-history.md) | Long-term Go TUI client boundary (sole production TUI since v0.3.7, when the TS TUI `bbl chat` was removed). | Use for `bbl go` ownership, TUI protocol boundaries, keyboard/layout/rendering expectations, and why Go TUI must not own runtime truth. |
| [go-tui-history.md](../history/go-tui-history.md) | Multi-session pane client experience over Nexus sessions/events/health. | Use for `bbl loop`, pane state, focus routing, status projection, and multi-session visualization. |
| [go-tui-session-observability-governance-plan.md](../proposals/go-tui-session-observability-governance-plan.md) | Session inspectability, embedded Nexus persistence, client/server session-id mapping, and Go TUI replayability. | Use when Go sessions cannot be inspected or reverse-resolved. |
| [go-tui-history.md](../history/go-tui-history.md) | Go TUI permission panel, soft-deny routing, approval scopes, and feedback/editor UX. | Use for interactive permission routing. Permission policy remains runtime-owned. |
| [go-tui-markdown-rendering-optimization-plan.md](../proposals/go-tui-markdown-rendering-optimization-plan.md) | Transcript Markdown rendering and syntax highlighting roadmap. | Use for renderer improvements only; it must not change event semantics. |
| [go-tui-history.md](../history/go-tui-history.md) | Mouse selection highlight and clipboard regression record. | Closed reference for a UI rendering regression. |
| [go-runner-plan.md](../proposals/go-runner-plan.md) | Optional Go RemoteToolRunner execution backend. | Use for approved-tool execution mechanics, sandbox/process/cancel/output-budget behavior, and defense-in-depth path enforcement. |
| [distribution-strategy-plan.md](./distribution-strategy-plan.md) | Product distribution strategy across portable packages, npm, Homebrew, and future Go launcher. | Use for channel direction and release asset shape. |
| [distribution-guide.md](../../guides/distribution-guide.md) | Operational release/install/debug guide. | Use for current install commands, release checks, and support procedures. |

## Governance Rules

### 1. Go TUI is a client

Go TUI owns terminal layout, keyboard routing, transcript rendering, overlays, local input state, and permission UI. It does not own provider calls, context assembly, compact, tool execution, permissions, storage truth, or agent orchestration.

### 2. `bbl loop` is a pane client, not a scheduler

`bbl loop` may visualize multiple sessions, panes, statuses, permissions, and transcripts. It must consume Nexus events and health endpoints. It must not schedule work independently, infer runtime state from local UI, or become a second AgentScheduler.

### 3. Go Runner is execution substrate only

Go Runner can execute approved tool calls behind a RemoteToolRunner protocol. TypeScript Nexus still decides which tool is allowed, which session owns the call, which permissions apply, and how results are stored and replayed.

### 4. Distribution must match product truth

Installer, release assets, README, release notes, and `bbl go --check` should agree about the current user path. If `bbl go` is the official user entrypoint for a release line, package assets and smoke checks must prove it can start or diagnose itself.

### 5. Do not require Go toolchain for normal users

Development can use local Go builds. User-facing distribution should prefer prebuilt assets or portable packages. Requiring a local Go toolchain is acceptable only for contributors or explicit fallback/debug paths.

### 6. Do not conflate launcher and runtime

A future Go launcher may locate or launch the Go TUI and Node/Nexus payload. That does not make Go the runtime owner. Launcher work must preserve Nexus-first execution boundaries.

### 7. UI improvements need protocol support

If Go TUI needs richer state, add or stabilize Nexus events/API/diagnostics first. Do not scrape SQLite, parse provider/tool internals, or duplicate runtime logic inside the client.

## Current State

The current Go/distribution line is mixed but directionally stable:

- `bbl go` is the sole production TUI as of v0.3.7 (the TypeScript `bbl chat` was removed).
- `bbl loop` is an active multi-pane client plan with several landed slices.
- Go TUI permission, session observability, selection highlight, model persistence, timeout, and split-file histories are documented across reference/archive.
- Go Runner has partially landed read-only/restricted execution backend phases but remains optional.
- v0.3.5+ distribution direction favors lightweight portable packages, with a future Go launcher as the target architecture.

The main governance risk is wording drift: some documents describe Go TUI as a product entrypoint, while others correctly call it opt-in/stable alternative. Product-facing docs should be release-line specific and supported by install assets and smoke checks.

## Open Watch Items

| Item | Owner document | Status |
| --- | --- | --- |
| `bbl loop` multi-pane UX polish and PTY smoke | [go-tui-history.md](../history/go-tui-history.md), [active/TODO_tui.md](../active/TODO_tui.md) | Active/Watch. |
| Go TUI session inspectability and reverse-resolve coverage | [go-tui-session-observability-governance-plan.md](../proposals/go-tui-session-observability-governance-plan.md) | Partially landed; keep regression-first. |
| Markdown renderer upgrade | [go-tui-markdown-rendering-optimization-plan.md](../proposals/go-tui-markdown-rendering-optimization-plan.md) | Draft; dependency and benchmark gated. |
| Go RemoteRunner promotion | [go-runner-plan.md](../proposals/go-runner-plan.md) | Partially landed optional backend; not default runtime path. |
| Go launcher migration | [distribution-strategy-plan.md](./distribution-strategy-plan.md) | Long-term target; portable packages remain current path. |

## Verification Expectations

Go client and distribution changes should be validated with the relevant slice from:

- Go TUI unit tests and focused white-box state machine tests;
- PTY/visual smoke for user-facing terminal behavior;
- `bbl go --check --no-start-nexus` for install readiness;
- Nexus API/event contract tests when UI depends on new state;
- portable package build/smoke for distribution changes;
- `npm run docs:check` for reference/archive/release link health.

## 中文概述

### 背景

Go 相关文档容易混在一起：Go TUI 是终端客户端，`bbl loop` 是多 session 面板客户端，Go Runner 是可选执行后端，Distribution 是发布安装策略。它们都和 Go 有关，但职责完全不同。

### 核心做法

本文件建立统一入口：Go TUI/loop 只拥有交互和渲染；Go Runner 只执行已批准工具；Distribution 只决定用户如何安装和启动；Nexus 仍拥有 runtime、context、权限、storage、provider loop 和 agent orchestration。

### 当前状态

`bbl go` 已是稳定可选客户端，`bbl loop` 是活跃体验主线，Go Runner 是可选执行底座，v0.3.5+ 分发方向以 lightweight portable package 为当前主路径，Go launcher 是长期目标。

### 下一步

继续守住边界：新增 UI 能力先补 Nexus event/API；Go Runner 不变成 agent/runtime；发布文档必须和真实 release assets、install.sh、`bbl go --check` 自检一致。
