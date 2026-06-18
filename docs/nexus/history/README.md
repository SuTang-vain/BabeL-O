# Nexus History Ledgers

> State: Index
> Governance: This directory consolidates closed implementation references. It is not a current priority queue.

This directory keeps compact history ledgers for completed or watch-only implementation lines. It replaces the old pattern where every closed plan stayed as a standalone `reference/` document.

## Ledgers

| Ledger | Scope |
| --- | --- |
| [go-tui-history.md](./go-tui-history.md) | Go TUI rewrite, `bbl loop`, permission policy, selection highlight, and related closed client UX decisions. |
| [context-and-agent-history.md](./context-and-agent-history.md) | Context Manager, compact, sub-agent, AgentScheduler, SessionChannel, and session collaboration closure history. |
| [evidence-and-runtime-history.md](./evidence-and-runtime-history.md) | Provider replay, evidence scope, finalization, timeout, and path-drift closure history. |

## Rules

- History ledgers preserve closed context; they do not reopen implementation priority.
- New regressions should create a focused active TODO or proposal, then link back to the relevant history ledger.
- Do not add a new standalone closed reference unless it is expected to become an ADR or a reusable reference.

## 中文概述

### 作用

`history/` 用来合并已收口的长规划，减少 `reference/` 中的历史噪音。

### 规则

已完成事项进入 history ledger；新的开发优先级仍写入 `TODO.md` 或 `active/`。
