# Reference Document Template

> State: Draft | Active Plan | Partially Landed | Closed Reference | Index | Guide
> Track: Runtime | Context | Tools | Agent | Prompt | Memory | Go TUI | Distribution
> Priority: P0 | P1 | P2 | Watch | N/A
> Source of truth: TODO | active TODO | DONE | WORK_LOG | source files | tests
> Related: `example.md`

## Purpose

Describe why this document exists and what decision, boundary, or implementation line it governs.

## Current State

Summarize what is already implemented, what is only planned, and what evidence supports that status. Prefer links to source files, tests, TODO entries, DONE entries, or WORK_LOG entries.

## Problem Statement

Define the actual problem. If the plan comes from a real session regression, include the session id and the observable failure. If it is exploratory, explicitly mark it as a draft.

## Goals

- State the concrete outcomes this plan is meant to produce.
- Keep goals testable or reviewable.
- Avoid mixing completed facts with future work.

## Non-goals

- State what this plan must not change.
- State ownership boundaries, especially Nexus/runtime/client/provider/tool boundaries.
- State which adjacent systems are intentionally out of scope.

## Design

Describe the proposed architecture, protocol, data shape, UI behavior, or implementation sequence. Keep this section in English for consistency across the reference library.

## Phases

| Phase | Status | Scope | Exit criteria |
| --- | --- | --- | --- |
| Phase 0 | Draft | Define the first slice. | A small, testable checkpoint. |

## Verification

List the tests, smoke runs, manual checks, or real-session replay needed before moving a phase to `Closed Reference`.

## Document Ownership

- Current priority lives in [../TODO.md](../TODO.md) or [../active/](../active/).
- Completed facts move to [../DONE.md](../DONE.md).
- Detailed factual history goes to [../WORK_LOG.md](../WORK_LOG.md).
- This document keeps only durable architecture boundaries, phase plans, and regression context.

## 中文概述

### 背景

用简短中文说明为什么需要这份规划。

### 核心做法

用中文概括英文主体里的关键路径，避免重复整篇细节。

### 当前状态

说明当前是草案、部分落地、已收口，还是仅作为参考索引。

### 下一步

列出最小、最可验证的下一步，而不是泛化重写。
