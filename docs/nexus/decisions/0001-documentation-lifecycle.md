# 0001. Documentation Lifecycle Split

> State: Accepted
> Date: 2026-06-17
> Governance: Indexed by [README.md](./README.md). This decision defines the documentation lifecycle boundary for `docs/nexus`.

## Context

`docs/nexus/reference/` had become overloaded. It contained active architecture references, draft proposals, partially landed plans, closed implementation records, indexes, and guides. Even after adding indexes and templates, the directory still had too many standalone documents and required readers to inspect state headers to know whether a file still drove development.

The project needs fewer reader-facing surfaces and stronger lifecycle rules. Current priorities should remain in `TODO.md` and `active/`; durable architecture should remain in `reference/`; completed history should not stay as independent reference documents.

## Decision

Split Nexus documentation into lifecycle-specific directories:

- `active/`: current implementation TODO detail.
- `reference/`: long-lived architecture references, indexes, and guides.
- `proposals/`: draft or partially landed plans that may still change.
- `history/`: compact ledgers for completed or watch-only implementation context.
- `decisions/`: short architecture decision records.
- `archive/`: stale, superseded, or source planning documents retained for traceability.
- `releases/`: release notes and version-facing change summaries.

Closed reference documents are consolidated into history ledgers instead of remaining as standalone reference files. Draft and partially landed documents move to proposals until they graduate, close, or become stale.

## Consequences

- `reference/` becomes smaller and easier to scan.
- Closed implementation context remains available, but no longer competes with active architecture references.
- Future documents need an explicit lifecycle target before being added.
- Link maintenance requires stronger checks across `reference/`, `proposals/`, `history/`, `archive/`, and `releases/`.

## 中文概述

### 背景

`reference/` 同时承载长期架构、草案、半完成计划和已收口记录，数量过多且阅读成本高。

### 决策

将文档按生命周期拆分为 `active/`、`reference/`、`proposals/`、`history/`、`decisions/`、`archive/` 和 `releases/`。

### 影响

长期 reference 会明显变少；已完成内容进入 history ledger；新草案先进入 proposals，不能直接污染 reference。
