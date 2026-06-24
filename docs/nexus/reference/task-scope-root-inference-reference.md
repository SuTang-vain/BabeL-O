# Task Scope Root Inference Reference

> State: Active Plan
> Track: Runtime / Evidence
> Priority: P1 — false-positive scope boundaries on non-JS/Go projects erode trust in the P0 task-scope guardrail
> Source of truth: [../TODO.md](../TODO.md), [../active/TODO_runtime.md](../active/TODO_runtime.md), [../DONE.md](../DONE.md), [../WORK_LOG.md](../WORK_LOG.md), `src/runtime/taskScope.ts`
> Governance: Indexed by [README.md](../README.md) and [evidence-governance-index.md](./evidence-governance-index.md). Canonical owner of "how a project root and a bash-target path are inferred for scope-boundary classification." The scope-boundary event model and confirmation flow stay in [task-scope-and-evidence-scope-governance-plan.md](./task-scope-and-evidence-scope-governance-plan.md).
> Related: [task-scope-and-evidence-scope-governance-plan.md](./task-scope-and-evidence-scope-governance-plan.md), [evidence-governance-index.md](./evidence-governance-index.md), [tool-governance-plan.md](./tool-governance-plan.md)

## Purpose

`taskScope.ts` is the P0 guardrail that prevents read-only tools from pulling out-of-scope evidence (the `session_ef76f50a-` regression). Its accuracy depends on two parsers: `inferProjectRoot()` (which paths count as "in scope") and `extractBashTargetPaths()` (which paths a Bash command targets). Both have known gaps that produce false positives (internal paths flagged as external) and false negatives (redirected targets missed). This document is the durable reference for those parsers' correctness boundaries.

## Current State

- `inferProjectRoot()` (`taskScope.ts:354-367`) walks up the filesystem looking for project-root markers. It recognizes **only** `.git`, `package.json`, `go.mod`. The fallthrough at `:364` returns `resolve(path)` when no marker is found.
- Consequence: a project rooted only by `Cargo.toml`, `pyproject.toml`, `setup.py`, `Gemfile`, `pom.xml`, `build.gradle`, `project.clj`, `mix.exs`, `composer.json`, `pubspec.yaml`, `CMakeLists.txt`, or `deno.json` is **not recognized** as a root. `isWithinRoot()` comparisons against the fallback `resolve(path)` then flag internal paths as external → false-positive `scope_boundary_detected` events → spurious permission prompts.
- `extractBashTargetPaths()` (`taskScope.ts:225-251`) tokenizes the command and matches a fixed set of command names (`cd`, `git -C`, `find`, `ls`, `cat`, `head`, `tail`, `rg`, `grep`). It is a shallow parser: it misses command substitution, pipelines' target side, and **redirection**.
- `isShellOperator()` (`taskScope.ts:350-352`) handles `&&`, `||`, `;`, `|` but **not** `>`, `>>`, `<`, `<<`. So `cat foo > /external/path` does not surface `/external/path` as a target — a false negative on the write-redirect side (the write itself is still gated by the Bash classifier, but the *scope* signal is wrong).

## Problem Statement

The scope guardrail's value collapses if it false-positives on common project layouts (Rust, Python, Ruby, JVM, Elixir, PHP, Flutter, C/C++) — users disable it. And false negatives on redirection mean the scope signal under-reports write targets. Both are correctness gaps in the parsers, not in the event model.

## Goals

- `inferProjectRoot()` recognizes the common root-marker set across language ecosystems.
- `extractBashTargetPaths()` recognizes redirection targets (`>`, `>>`, `<`, `<<`) and is honest about what it cannot parse (command substitution, complex pipelines).
- No new false positives introduced for the JS/Go projects already covered.
- The marker list and shell-operator list are data-driven (a constant table), not scattered conditionals, so adding a marker is a one-line change.

## Non-goals

- Do not build a real shell parser (shells is out of scope; the Bash *risk* classifier already handles dangerous patterns). This is about *path-target extraction* for scope, not security.
- Do not change the `task_scope_declared` / `scope_boundary_detected` / `scope_boundary_confirmed` event schema.
- Do not change the confirmation flow or the cross-project intent pattern.

## Design

### Phase 1 — Root-marker table

1. Replace the inline marker checks in `inferProjectRoot()` with a `PROJECT_ROOT_MARKERS` constant table: `.git` (any), and the ecosystem files (`package.json`, `go.mod`, `Cargo.toml`, `pyproject.toml`, `setup.py`, `Gemfile`, `pom.xml`, `build.gradle`, `build.gradle.kts`, `settings.gradle`, `project.clj`, `mix.exs`, `composer.json`, `pubspec.yaml`, `CMakeLists.txt`, `deno.json`, `pnpm-workspace.yaml`, `turbo.json`).
2. `.git` remains the strongest signal (a bare `git -C` repo). For the rest, presence of the file marks the root.
3. Keep the `resolve(path)` fallthrough but only after exhausting the table; document that the fallthrough produces best-effort (not authoritative) root inference.

### Phase 2 — Redirection-aware bash target extraction

1. Extend `isShellOperator()` to include `>`, `>>`, `<`, `<<` (and `&>`, `2>`).
2. In `extractBashTargetPaths()`, when a redirection operator is seen, treat the following token as a target path (resolve relative to cwd) and surface it. This catches `cat foo > /external/path` and `tee /external/path`.
3. Explicitly document the non-goals in the function docstring: command substitution `$()` and process substitution `<()` are **not** parsed (path comes from runtime evaluation, not static text); the function returns only statically-extractable targets.

### Phase 3 — Regression corpus

1. Extend `test/bash-classifier.test.ts` / a new `test/task-scope-root-inference.test.ts` with: one project per ecosystem marker (assert recognized as root), redirection target extraction cases, and a no-false-positive case for a JS project.

## Phases

| Phase | Status | Scope | Exit criteria |
| --- | --- | --- | --- |
| Phase 1 | Draft | `PROJECT_ROOT_MARKERS` table; multi-ecosystem recognition. | Test asserts each ecosystem marker resolves to the expected root; JS/Go cases unchanged. |
| Phase 2 | Draft | Redirection-aware `extractBashTargetPaths`; honest non-goal docstring. | Test asserts `>`/`>>`/`<`/`<<` targets surfaced; `$()` documented as unsupported. |
| Phase 3 | Draft | Regression corpus. | Corpus test green; existing scope-boundary regressions unchanged. |

## Verification

- `npm test` (existing `test/runtime.test.ts` scope ordering, `test/runtime-llm.test.ts`, `test/bash-classifier.test.ts`, `test/classifier.test.ts` green).
- New `test/task-scope-root-inference.test.ts`.
- `npm run build:smoke`.

## Document Ownership

- Current priority lives in [../TODO.md](../TODO.md) and [../active/TODO_runtime.md](../active/TODO_runtime.md).
- Completed facts move to [../DONE.md](../DONE.md); factual history to [../WORK_LOG.md](../WORK_LOG.md).
- The scope event model and confirmation flow stay in [task-scope-and-evidence-scope-governance-plan.md](./task-scope-and-evidence-scope-governance-plan.md).

## 中文概述

### 背景

`taskScope.ts` 是 P0 证据范围护栏，但 `inferProjectRoot` 只认 `.git/package.json/go.mod`，Rust/Python/Ruby/JVM 等项目根识别失败 → 内部路径被误判外部 → 假阳性权限弹窗；`extractBashTargetPaths` 不处理 `>`/`>>`/`<`/`<<` 重定向 → 写目标假阴性。

### 核心做法

Phase 1 把 root marker 改成数据驱动的常量表（覆盖主流生态）；Phase 2 让 bash 目标提取识别重定向操作符并诚实声明 `$()`/`<()` 不解析；Phase 3 补跨生态 + 重定向回归语料。

### 当前状态

Active Plan 草案。事件模型不动，只修两个解析器的正确性边界。

### 下一步

最小切片：Phase 1 的 `PROJECT_ROOT_MARKERS` 表 + 每生态一条断言，零行为变更（仅扩充识别）。
