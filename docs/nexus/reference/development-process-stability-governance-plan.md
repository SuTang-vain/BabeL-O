# Development Process Stability Governance Plan

> State: Active Plan
> Track: Cleanup / CI / Review / Test Governance
> Priority: P1
> Source of truth: [../TODO.md](../TODO.md), [../active/TODO_cleanup.md](../active/TODO_cleanup.md), [../active/TODO_runtime.md](../active/TODO_runtime.md), [../WORK_LOG.md](../WORK_LOG.md), [../DONE.md](../DONE.md), `package.json`, `.github/workflows/ci.yml`, `scripts/check-nexus-docs.js`, `scripts/audit-dependency-boundary.js`, `test/`
> Governance: This document owns development-process stability rules. It must not change runtime ownership, session truth, or product behavior by policy alone; implementation facts still move through TODO, WORK_LOG, DONE, source, and tests.
> Related: [tool-governance-plan.md](./tool-governance-plan.md), [runtime-tool-loop-governance-plan.md](./runtime-tool-loop-governance-plan.md), [agent-runtime-architecture-maturity-plan.md](./agent-runtime-architecture-maturity-plan.md), [context-cwd-drift-and-recall-governance-plan.md](./context-cwd-drift-and-recall-governance-plan.md)

## 1. Purpose

BabeL-O has a strong verification culture: typecheck, check-only formatting, dependency-boundary audit, documentation lifecycle checks, build smoke, a large deterministic test suite, optional Go/PTY smoke gates, benchmark scripts, and regression-first runtime planning.

The remaining stability risk is not a lack of effort. It is change density:

- runtime/context/storage patches often land close to documentation migrations;
- real-session regressions can span several files, phases, and tests;
- default tests are broad enough that a flaky test can weaken trust in the whole gate;
- commit history shows many small landed slices, but there is no explicit review or quarantine policy that says which changes must be split or held.

This plan defines three process stabilizers:

1. PR review as a required governance layer for risky changes.
2. Commit and PR granularity limits based on semantic scope, not arbitrary daily quotas.
3. Flaky test isolation so the default gate remains trustworthy.

Coupling work under [module-coupling-decoupling-and-re-aggregation-plan.md](./module-coupling-decoupling-and-re-aggregation-plan.md) defaults to at least `review-standard`. Coupling PRs that touch runtime, storage, shared events, permissions, CI, release, or dependency-boundary scripts are `review-high-risk` and must include a before / after coupling audit fingerprint.

## 2. Current State

Already strong:

- `npm run lint` combines typecheck, format check, and dependency-boundary audit.
- `npm test` is deterministic by default: `NODE_ENV=test`, a fixed `BABEL_O_CONFIG_FILE`, and serial test execution.
- `.github/workflows/ci.yml` runs typecheck, format, dependency audit, `npm test`, and build smoke.
- Optional environment-gated smoke tests exist for Go TUI, Go runner, provider smoke, and PTY paths.
- Documentation lifecycle is enforced by `npm run docs:check`.
- Runtime planning is regression-first: real session ids, focused tests, and source ownership are recorded in TODO / WORK_LOG.

Still open:

- No repository-level PR review rubric is recorded in the docs library.
- No semantic size rule says when runtime, docs, tests, product UX, and storage changes must split into separate PRs.
- Flaky or environment-sensitive tests are described ad hoc in work logs, but there is no quarantine index, quarantine script, owner, or exit condition.
- CI has a single default pass/fail meaning for most tests, so a known flaky failure can erode confidence in unrelated changes.

## 3. Problem Statement

The project is now in a high-change phase where engineering process needs to protect the existing architecture:

```text
Good tests + high commit velocity + no explicit review/quarantine policy
=> hard to tell whether a red build means a real regression or known noise.
```

This is especially risky for:

- `src/runtime/LLMCodingRuntime.ts`;
- `src/runtime/runtimeToolLoop.ts`;
- `src/runtime/taskScope.ts`;
- `src/runtime/systemPromptBuilder.ts`;
- `src/nexus/app.ts`;
- `src/storage/*`;
- `src/shared/events.ts`;
- Go TUI permission/session state machine files;
- scripts that define package, CI, docs, release, or dependency boundaries.

The target is not slower development. The target is higher signal per change.

## 4. Goals

- Make review required for changes that can alter runtime truth, session persistence, permissions, task scope, context assembly, tool execution, or release behavior.
- Keep commit history readable by limiting each PR to one semantic slice.
- Preserve high velocity by allowing many small PRs rather than one large mixed PR.
- Keep `npm test` and CI trustworthy by moving known flaky or environment-sensitive cases into a named quarantine / smoke tier.
- Make every process rule reviewable in documentation, not only in maintainer memory.

## 5. Non-goals

- Do not impose an arbitrary daily commit-count cap.
- Do not require heavyweight review for docs-only typo fixes, release-note corrections, or narrow comments.
- Do not block emergency P0 regression fixes on perfect process polish; emergency fixes still need post-merge review notes and follow-up tests.
- Do not let process docs override runtime architecture boundaries.
- Do not hide flaky tests permanently; quarantine is a temporary isolation state with an owner and exit condition.
- Do not require Go, live provider keys, or network access in the default `npm test` path.

## 6. Part A: PR Review Governance

### 6.1 Review Levels

| Level | Applies to | Required review |
| --- | --- | --- |
| `review-light` | docs index updates, comments, typo fixes, release-note copy | Author self-check plus CI. |
| `review-standard` | normal source changes, tests, CLI behavior, docs plan changes | One reviewer or maintainer second-pass. |
| `review-high-risk` | runtime loop, task scope, storage, permissions, events schema, provider replay, Nexus session routing, CI/release scripts | One reviewer plus explicit regression evidence. |
| `review-emergency` | urgent P0 fix to unblock a broken mainline | May merge fast, but must add a follow-up review note and regression test issue before closing. |

### 6.2 High-Risk Review Checklist

A high-risk PR must answer:

- What exact behavior changed?
- What source files own that behavior?
- Which user-visible or runtime-visible event changes, if any?
- Which regression or real-session evidence motivated the change?
- What focused tests prove the old failure is blocked?
- Which full or partial verification commands ran?
- What was intentionally left out?
- Does the change affect Nexus/runtime/client ownership boundaries?

### 6.3 Required PR Template Fields

The eventual PR template should include:

```text
Risk level:
Scope:
Behavior changed:
Regression evidence:
Verification:
Docs updated:
Flaky/quarantine impact:
Rollback notes:
```

### 6.4 Review Ownership

- Runtime truth review belongs to runtime/Nexus maintainers.
- Go TUI review can verify rendering and input state, but cannot approve a client-owned reinterpretation of runtime facts.
- Docs review can approve lifecycle placement, but cannot mark implementation complete without source or verification evidence.
- CI/release review must include rollback or manual recovery notes.

## 7. Part B: Commit And PR Granularity

### 7.1 Rule

Limit by semantic unit, not by day:

```text
One PR should close one regression slice, one feature slice, or one documentation lifecycle move.
```

Multiple small PRs in one day are acceptable when each has a clean scope and verification trail.

### 7.2 Split Triggers

Split the work when any of these are true:

- runtime behavior and broad documentation migration both change;
- storage schema and UI rendering both change;
- event schema and provider adapter behavior both change;
- Go TUI state machine and Nexus runtime behavior both change;
- tests add a new harness and production code changes unrelated behavior;
- a PR touches more than one high-risk ownership boundary;
- the reviewer cannot describe the PR in one sentence without using "and then".

### 7.3 Acceptable Combined Slices

These can stay together:

- a bug fix plus the focused regression test that proves it;
- a new event field plus schema test and renderer fallback for that same field;
- a docs plan update plus TODO index row for the same plan;
- a cleanup refactor plus no-op verification, when behavior is intentionally unchanged.

### 7.4 Suggested Commit Shapes

- `fix(runtime): block cwd fallback into system dirs`
- `test(runtime): cover storage propagation for context tools`
- `docs(context): record session_10320709 follow-up`
- `chore(ci): add flaky quarantine runner`

Avoid commits that mix unrelated nouns:

```text
feat: update runtime, docs, tui, ci and tests
```

### 7.5 Daily Velocity Guidance

Do not cap daily commits mechanically. Instead:

- prefer 3 to 8 reviewable commits over one large mixed commit;
- stop and open a checkpoint PR when a change crosses a second ownership boundary;
- use a follow-up PR for polish discovered during review;
- keep WORK_LOG entries factual and tied to verification, not as a substitute for review.

## 8. Part C: Flaky Test Isolation

### 8.1 Test Tiers

| Tier | Command target | CI meaning |
| --- | --- | --- |
| `required` | `npm test`, `npm run typecheck`, `npm run format:check`, `npm run deps:audit`, `npm run build:smoke` | Must pass before merge. |
| `quarantine` | `npm run test:quarantine` | Runs known flaky tests; failure is reported but does not invalidate unrelated required gates until the quarantine exit date. |
| `smoke-gated` | Go TUI, Go runner, provider live, PTY, network-sensitive or long-running tests behind env flags | Explicit opt-in or scheduled. |
| `nightly` | full smoke matrix, benchmark comparison, live provider smoke if configured | Trend and early warning, not every PR. |

### 8.2 Quarantine Entry Criteria

A test may enter quarantine only when:

- it has failed at least twice under the same observable symptom;
- a maintainer records the command, failure output summary, and environment;
- the suspected cause is external timing, platform state, node test-runner serialization, PTY race, network/provider behavior, or shared mutable state;
- a focused issue or TODO entry names the owner and exit condition.

### 8.3 Quarantine Record Shape

The quarantine index should eventually live in `docs/nexus/active/TODO_cleanup.md` or a small machine-readable file if scripts need it.

```text
Test file:
Test name:
Tier:
First observed:
Last observed:
Symptom:
Likely cause:
Owner:
Exit condition:
Replacement coverage:
```

### 8.4 Exit Criteria

A quarantined test leaves quarantine when:

- the root cause is fixed;
- the test passes at least 10 consecutive local or CI runs, or one week of scheduled runs;
- it no longer depends on real user config, global cwd, wall-clock timing, uncontrolled network, or shared process state;
- required deterministic coverage exists in the default test suite.

### 8.5 Default Suite Protection

The default `npm test` suite must remain:

- offline by default;
- deterministic by default;
- isolated from user `~/.babel-o/config.json`;
- free of live provider keys;
- free of optional Go toolchain requirements;
- free of known flaky tests that have not been repaired.

## 9. Phases

| Phase | Status | Scope | Exit criteria |
| --- | --- | --- | --- |
| Phase 0 | Closed 2026-06-18 | Document the policy and index it in the docs library. | This plan is present in `reference/`, indexed, and linked from TODO / cleanup. |
| Phase 1 | Closed 2026-06-18 | Add PR template and review levels. | `.github/PULL_REQUEST_TEMPLATE.md` exists with risk/scope/verification/flaky fields; `CONTRIBUTING.md` and `GOVERNANCE.md` document review levels. |
| Phase 2 | Closed 2026-06-18 | Add semantic PR-size guidance to contributor docs. | `CONTRIBUTING.md` explains split triggers and accepted combined slices without imposing a daily commit-count cap. |
| Phase 3 | Closed 2026-06-18 | Implement flaky quarantine inventory and command. | `test/quarantine.json` records known flaky/environment-sensitive entries; `npm run test:quarantine` lists them and `npm run test:quarantine -- --run` runs them explicitly. v1 does not remove broad default coverage until each root cause has deterministic replacement coverage. |
| Phase 4 | Open | Add CI reporting for quarantine without blocking required gates. | CI uploads quarantine logs or summary when configured; required gates stay deterministic. |
| Phase 5 | Watch | Add scheduled smoke/nightly lanes. | Optional Go/provider/PTY/benchmark lanes run on schedule or explicit dispatch and report trends. |

## 10. Verification

Before marking a phase closed:

- `npm run docs:check` must pass after documentation changes.
- `npm run format:check` must pass.
- `npm run deps:audit` must pass when scripts, dependencies, or package metadata change.
- `npm test` must pass for default-suite changes.
- New quarantine behavior must be tested with at least one synthetic quarantined fixture before moving real tests.
- CI changes must include a dry-run or documented expected GitHub Actions behavior.

## 11. Document Ownership

- Current scheduling lives in [../TODO.md](../TODO.md) and [../active/TODO_cleanup.md](../active/TODO_cleanup.md).
- Runtime-specific regressions still live in [../active/TODO_runtime.md](../active/TODO_runtime.md).
- Completed implementation facts move to [../DONE.md](../DONE.md).
- Detailed factual history and verification commands go to [../WORK_LOG.md](../WORK_LOG.md).
- This document keeps only durable process policy, phase boundaries, and review/quarantine semantics.

## 中文概述

### 背景

这个项目的自动化守门已经很强，但当前仍处在高频 runtime/context 修复阶段。风险不是“没有测试”，而是变更密度高、真实回归链长、默认测试一旦混入 flaky 就会削弱整条 CI 的可信度。

### 核心做法

三件事一起做：第一，引入按风险分级的 PR review；第二，限制单个 PR/commit 的语义范围，而不是机械限制一天提交几个；第三，把 flaky 或环境敏感测试隔离到 quarantine / smoke / nightly 层，让默认 `npm test` 继续保持确定性。

### 当前状态

这是 Active Plan。Phase 0 是把规则写入文档库并建立索引；后续还需要补 PR 模板、贡献文档、quarantine 清单和对应脚本。

### 下一步

最小下一步是新增 `.github/PULL_REQUEST_TEMPLATE.md`，再给 `TODO_cleanup.md` 建一个 flaky quarantine 表格，先登记已经观察到的 pre-existing flaky，再补 `npm run test:quarantine`。
