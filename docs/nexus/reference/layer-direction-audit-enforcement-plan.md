# Layer-Direction Audit Enforcement Plan

> State: Active Plan
> Track: Nexus / Runtime / CLI / Tools
> Priority: P0 — the first design rule ("Nexus owns execution, CLI owns interaction") is enforced on paper only; the audit that claims to guard it does not
> Source of truth: [../TODO.md](../TODO.md), [../active/TODO_cleanup.md](../active/TODO_cleanup.md), [../DONE.md](../DONE.md), [../WORK_LOG.md](../WORK_LOG.md), `scripts/audit-dependency-boundary.js`, `scripts/audit-coupling.js`, `test/architecture-boundary.test.ts`, `src/cli/runSessionFlow.ts`, `src/cli/embedded.ts`, `src/cli/commands/context.ts`
> Governance: Indexed by [README.md](./README.md). Canonical owner of "how is the layer boundary actually enforced." Coupling-debt inventory stays in [module-coupling-decoupling-and-re-aggregation-plan.md](./module-coupling-decoupling-and-re-aggregation-plan.md).
> Related: [module-coupling-decoupling-and-re-aggregation-plan.md](./module-coupling-decoupling-and-re-aggregation-plan.md), [unify-embedded-cli-path-plan.md](../proposals/unify-embedded-cli-path-plan.md)

## Purpose

The project's first design rule is *"Nexus owns execution. CLI owns interaction. Never leak runtime concerns into the CLI module — the dependency-boundary audit (`npm run deps:audit`) will fail the build."* This plan governs the gap between that rule and what the audits actually check. Today the audits enforce **package-level** ownership but **not layer direction**, so `cli → runtime` / `cli → nexus` reverse imports pass silently and the "boundary test" does not test the boundary.

## Current State

Factual mapping of cross-layer edges based on codebase audit:

- **`cli` → `nexus`** (24 edges across 9 files):
  - `src/cli/NexusClient.ts` imports `src/nexus/agents/types.ts`
  - `src/cli/commands/agents.ts` imports `src/nexus/agents/types.ts`
  - `src/cli/commands/context.ts` imports `src/nexus/contextAssemblePreview.ts`
  - `src/cli/commands/firstRun.ts` imports `src/nexus/everosBootstrapConfig.ts`
  - `src/cli/commands/go.ts` imports `src/nexus/createRuntime.ts`
  - `src/cli/commands/optimize.ts` imports `src/nexus/agentLoop.ts`, `src/nexus/createRuntime.ts`, `src/nexus/remoteRunnerConfig.ts`, `src/nexus/storageBridge.ts`, `src/nexus/runtimeAgentStep.ts`, `src/nexus/agentRoles.ts`, `src/nexus/taskSession.ts`, `src/nexus/agentLoopSmoke.ts`
  - `src/cli/embedded.ts` imports `src/nexus/app.ts`, `src/nexus/createRuntime.ts`, `src/nexus/contextBroadcaster.ts`, `src/nexus/remoteRunnerConfig.ts`, `src/nexus/everCoreRuntimeManager.ts`
  - `src/cli/program.ts` imports `src/nexus/server.ts`
  - `src/cli/runSessionFlow.ts` imports `src/nexus/createRuntime.ts`, `src/nexus/everCoreRuntimeManager.ts`, `src/nexus/remoteRunnerConfig.ts`
- **`cli` → `runtime`** (15 edges across 8 files):
  - `src/cli/commands/context.ts` imports `src/runtime/persistedWorkingSetTracker.ts`, `src/runtime/behaviorTrace.ts`, `src/runtime/workingSetTracker.ts`
  - `src/cli/commands/inspectSession.ts` imports `src/runtime/agentTrace.ts`, `src/runtime/runCheckpoint.ts`
  - `src/cli/everosAutoBootstrap.ts` imports `src/runtime/everosPrerequisites.ts`, `src/runtime/everosBackgroundBootstrap.ts`
  - `src/cli/everosBackgroundBootstrap.ts` imports `src/runtime/everosBackgroundBootstrap.ts`
  - `src/cli/everosBootstrap.ts` imports `src/runtime/everosBootstrap.ts`
  - `src/cli/everosFallbackBuild.ts` imports `src/runtime/everosFallbackBuild.ts`
  - `src/cli/everosPrerequisites.ts` imports `src/runtime/everosPrerequisites.ts`
  - `src/cli/runSessionFlow.ts` imports `src/runtime/hooks.ts`, `src/runtime/systemPromptBuilder.ts`
- **`cli` → `providers`** (2 edges):
  - `src/cli/commands/config.ts` imports `src/providers/registry.ts`
  - `src/cli/commands/models.ts` imports `src/providers/registry.ts`
- **`cli` → `tools`** (1 edge):
  - `src/cli/commands/context.ts` imports `src/tools/contextTools.ts`
- **`shared` → `providers`** (1 edge, layering violation):
  - `src/shared/config.ts` imports `src/providers/registry.ts`

Audit gaps and testing limitations:
- `scripts/audit-dependency-boundary.js` (CI-wired via `ci.yml` lint step) checks direct dependencies and dev dependency leaks, but **does not check import direction between `src/` layers.**
- `scripts/audit-coupling.js` computes reverse imports but **never sets `process.exitCode`** and is not wired into CI. It remains a report dashboard rather than a gate.
- `test/architecture-boundary.test.ts` checks only basic client routes, config caching, version consistency, and command registration. It **does not assert import directions or layer boundaries.**

## Problem Statement

A rule that an audit does not check is a rule that decays. The coupling plan ([module-coupling-decoupling-and-re-aggregation-plan.md](./module-coupling-decoupling-and-re-aggregation-plan.md)) tracks these edges as exceptions, but without machine-enforced gates, new developers or agents can introduce arbitrary cross-layer imports without triggering build failures.

## Goals

- A machine-enforced allowlist of permitted cross-layer imports, with everything else failing CI.
- `cli → runtime` and `cli → nexus` imports are limited to an explicitly enumerated, reviewed set.
- The "architecture boundary test" actually tests architecture (import direction), not just a happy-path smoke.
- The audit failure message names the offending file + import path so the fix is obvious.

## Non-goals

- Do not re-architect the CLI in this plan — the embedded-path unification is owned by [unify-embedded-cli-path-plan.md](../proposals/unify-embedded-cli-path-plan.md). This plan only makes the *current* intended boundary enforceable, so that unification (and future changes) cannot silently regress.
- Do not replace `audit-coupling.js`'s metrics role — keep it as a dashboard; this plan adds a *gate*, not another report.
- Do not forbid all `cli → nexus` imports — the embedded client legitimately needs a single composition entry point. The plan defines the allowed entry surface.

## Design

### Phase 1 — Direction-aware dependency audit

Extend `scripts/audit-dependency-boundary.js` (or add `scripts/audit-layer-direction.js` wired into `deps:audit`) to:

1. Define layer ownership per source file: a file under `src/cli/**` is `cli`; `src/nexus/**` is `nexus`; `src/runtime/**` is `runtime`; `src/storage/**`, `src/providers/**`, `src/tools/**`, `src/shared/**`, `src/skills/**`, `src/mcp/**` are leaf domains.
2. For every `import ... from '.../relative'` in `src/**`, resolve the target file and record `(fromLayer, toLayer)`.
3. Maintain an explicit **allowlist** of permitted reverse / cross edges. Seed it from the current coupling-plan inventory:
   - `cli → nexus`: allowed only through a single entry surface (target: the unification in [unify-embedded-cli-path-plan.md](../proposals/unify-embedded-cli-path-plan.md) — `nexus/index.ts` or `nexus/createRuntime.ts` + `nexus/app.ts`). All other `cli → nexus` targets fail.
   - `cli → runtime`: allowlisted to the current narrow set (`runtime/hooks`, `runtime/systemPromptBuilder`) — each entry must be justified in the allowlist file with a one-line reason.
   - `cli → tools`, `cli → providers`, `cli → storage`: flagged for review (ideally none beyond diagnostics).
4. Any cross-layer edge not in the allowlist → exit 1 with `{file}:{importPath} violates layer direction ({from}→{to}); add to allowlist with justification or refactor`.
5. The allowlist is a checked-in JSON file (`scripts/layer-direction-allowlist.json`) so additions show up in code review.

### Phase 2 — Make `architecture-boundary.test.ts` test architecture

Replace/extend the smoke assertions with import-direction assertions:
- Walk `src/**` (using the resolved mapping) and assert no `cli → runtime` / `cli → nexus` edge outside the allowlist.
- Assert the reverse-direction counts reported by `audit-coupling.js` (`runtimeToNexus`, `nexusToCli`) are `[]` (these are already tracked as closed in the coupling plan — make them regression-asserted, not just reported).

### Phase 3 — Promote `audit-coupling.js` to a soft gate

Add a `--fail-on` mode to `audit-coupling.js` that exits non-zero when `runtimeToNexus` or `nexusToCli` is non-empty. Wire `coupling:audit` into CI as a non-blocking advisory first, then promote to blocking once green.

## Phases

| Phase | Status | Scope | Exit criteria |
| --- | --- | --- | --- |
| Phase 1 | Adopted 2026-06-21 | Direction-aware dependency audit + checked-in allowlist, wired into `npm run deps:audit` / CI. New `scripts/audit-layer-direction.js` (282 files scanned, 1095 cross-module imports checked) loads `scripts/layer-direction-allowlist.json` (19 files, 40 allowlisted targets) and rejects any reverse edge not in the allowlist. Wired into `npm run deps:audit` via `package.json` so a new forbidden `cli → runtime` import fails CI with the offending file/path. The audit enforces 6 rules: (1) `cli → {nexus,runtime,providers,tools,storage}`; (2) `runtime → nexus`; (3) `nexus → cli`; (4) `shared → outside`; (5) bottom-layer → `{cli,nexus}`; (6) bottom-layer → `runtime`. Rule 4 is the gate for the existing legitimate `src/shared/config.ts → src/providers/registry.ts` edge — the one allowlist entry under `src/shared/config.ts`. | `node scripts/audit-layer-direction.js` reports `SUCCESS: No layer direction violations found!` on current tree; deleting the `src/shared/config.ts` allowlist entry flips the audit to a violation. Synthesizing a `shared → runtime` edge (e.g. `import '../runtime/hooks.js'` from a shared file) is correctly flagged `Direction: shared ➔ runtime is forbidden`. The mechanism is part of the long-lived architecture — the allowlist continues to evolve but the gate itself stays. |
| Phase 2 | Adopted 2026-06-21 | `architecture-boundary.test.ts` asserts import direction, not just `app.inject` smoke. Three regression-asserting tests: (a) `layer direction audit passes successfully with zero violations` runs the script and asserts the success marker; (b) `coupling audit reports no reverse runtime-to-nexus or nexus-to-cli imports` parses `audit-coupling.js` JSON and asserts the two reverse arrays are `[]`; (c) `layer direction audit exits 0 on a clean tree (shared -> outside already gated by rule 4)` execSyncs `audit-layer-direction.js` and lets non-zero exit fail the test, closing the loop on the rule 4 gate. | All three pass on current tree (`npx tsx --test test/architecture-boundary.test.ts` → 8/8 pass); introducing a new `cli → runtime` edge fails (a), a new `shared → outside` edge fails (c). Together with Phase 1, this fixes the original architecture-review finding: the boundary audit now actually audits the boundary. |
| Phase 3 | Adopted 2026-06-21 (blocking) | `audit-coupling.js --fail-on` is now a **blocking** CI gate. The metrics dashboard stays informational; `--fail-on` exits non-zero when `runtimeToNexus` or `nexusToCli` is non-empty. Wired as `npm run coupling:audit:gate`. CI runs it under the `coupling-gate` job — `continue-on-error` was removed; failure emits a PR summary and fails the workflow. Scope is intentionally tight: `runtime → nexus` and `nexus → cli` only — these are the two directions the `coupling audit --fail-on exits 0 on a clean tree` test asserts as `[]`. The `shared → outside` direction is **already** a blocking gate (Phase 1 rule 4 + the `layer direction audit exits 0 on a clean tree` test + `npm run deps:audit` `&&` short-circuit + the `deps:audit` CI step), so it does not need to be re-gated here. This keeps the reverse-edge gate cohesion: one allowlist, one audit script per direction group, no overlapping `--fail-on` flags. | On a clean tree `node scripts/audit-coupling.js --fail-on` exits 0 and emits `✅ --fail-on: no reverse runtime->nexus or nexus->cli imports`. Synthesizing a `runtime → nexus` edge (e.g. `import '../nexus/server.js'` from a runtime file) flips it to exit 1 with `❌ --fail-on: reverse imports detected: runtime -> nexus: N edge(s)`. The architecture-boundary test `coupling audit --fail-on exits 0 on a clean tree` keeps the gate honest (`npx tsx --test test/architecture-boundary.test.ts` → 8/8 pass); CI failure of `coupling-gate` blocks the PR. |

## Verification

- `npm run deps:audit` fails when a deliberately-bad `cli → runtime` import is added; passes on current tree with the seeded allowlist.
- `npm test` (architecture-boundary) fails on a synthetic reverse import.
- `npm run coupling:audit` still emits the dashboard; `--fail-on` mode green.
- `npm run build:smoke`.

## Document Ownership

- Current priority lives in [../TODO.md](../TODO.md) and [../active/TODO_cleanup.md](../active/TODO_cleanup.md).
- Coupling-debt inventory + closed phases stay in [module-coupling-decoupling-and-re-aggregation-plan.md](./module-coupling-decoupling-and-re-aggregation-plan.md).
- This document owns the *enforcement mechanism*; that document owns the *debt and its remediation*.

## 中文概述

### 背景

第一条设计铁律 "Nexus owns execution, CLI owns interaction" 声称由 `deps:audit` 守门，但 `audit-dependency-boundary.js` 只查包级归属、不查层方向；`audit-coupling.js` 只出报表不设 exitCode、不进 CI；`architecture-boundary.test.ts` 只测 `app.inject` 干净子路径。结果 `runSessionFlow` 嵌入式路径直触 runtime/storage 这类越界完全不被覆盖。

### 核心做法

按 [../decisions/0001-documentation-lifecycle.md](../decisions/0001-documentation-lifecycle.md) §Decision，本文档**不是 proposals 推进后的下一阶段，而是已采纳的长期架构规范**，持续驱动实现。规范下的实施切片：

- **Phase 1 — 已采纳（2026-06-21）**：方向感知审计 `scripts/audit-layer-direction.js`（282 文件 / 1095 imports / 0 violations）+ checked-in `scripts/layer-direction-allowlist.json`（19 文件 / 40 允许目标）+ 接入 `npm run deps:audit`。审计覆盖 6 条规则，其中 **Rule 4 `shared → outside` 已是 blocking 闸**（当前唯一合法边 `src/shared/config.ts → src/providers/registry.ts` 在 allowlist 内）。不在 allowlist 的反向边直接 fail CI。
- **Phase 2 — 已采纳（2026-06-21）**：`architecture-boundary.test.ts` 新增 3 条反向边闸断言（layer 审计零违规 + coupling 审计 `runtimeToNexus` / `nexusToCli` 均为空数组 + **layer 审计 `shared → outside` Rule 4 闸回归断言**）；后扩展为 4 条反向边闸 + 2 条 canonical-shape 不变式（`runtime → providers` 必须 type-only 或 registry-only；`nexus → storage` 必须 NexusStorage-type-only + composition-root 例外）；**10/10 pass**。架构边界测试从此真正测试架构与 canonical 形态。
- **Phase 3 — 已采纳（2026-06-21，blocking）**：`audit-coupling.js` 加 `--fail-on`，`npm run coupling:audit:gate` 在 CI 的 `coupling-gate` job 跑（`continue-on-error` 已去掉，违规即阻断 workflow 并发 PR summary）。范围刻意只覆盖 `runtime → nexus` / `nexus → cli` 两个高优先级反向边；`shared → outside` **不**在这里重复加 `--fail-on`——它已经被 Phase 1 Rule 4 + Phase 2 回归测试 + `deps:audit` 的 `&&` 短链 + CI 的 `deps:audit` job 覆盖为 blocking。保持单一 allowlist、单一反向边强制闸，跨方向不重复加闸，避免散开。

根据源码深度审计，已明确并登记以下跨层边作为 allowlist 种子：
* `cli` -> `nexus` (24 条)
* `cli` -> `runtime` (15 条)
* `cli` -> `providers` (2 条)
* `cli` -> `tools` (1 条)
* `shared` -> `providers` (1 条，反向导入)

### 当前状态

长期架构规范全部三个实施切片均已采纳并落地为 blocking 强制闸，按方向分组、单一 allowlist、跨方向不重复加闸：

- **`cli → {nexus,runtime,providers,tools,storage}`** + **`runtime → nexus`** + **`nexus → cli`** + **`shared → outside`**（Phase 1 Rule 4）：全部由 `audit-layer-direction.js` 统一执行，allowlist 在 `scripts/layer-direction-allowlist.json`；接入 `npm run deps:audit` → CI `deps:audit` step。
- **`runtime → nexus`** + **`nexus → cli`**（Phase 3）：`audit-coupling.js --fail-on` 重复覆盖此两方向作为独立 dashboard 闸（语义侧重"反向边列表为空"），CI `coupling-gate` job 跑。
- `shared → outside` 不在 `audit-coupling.js --fail-on` 范围，避免与 layer-direction 审计的 allowlist 机制重复——同一规范内的两条不同路径（layer-direction 侧重 allowlist、coupling 侧重空数组）形成双向闭合。

**Canonical-shape invariants**（canonical 形态方向——已存在性调查后不需新建闸、改为回归断言记录合法形态）：

- **`runtime → providers`**（30 edges / 27 files）：100% 是 `import type`（adapters 子模块）或 `getAdapter`/`getModel`（registry 子模块）；没有具体 adapter 的值依赖。canonical 形态 = runtime 通过抽象使用 providers，**不**直接接具体 provider 实现。
- **`nexus → storage`**（20 edges / 19 files）：17/19 是 `import type { NexusStorage }`（抽象），仅 2/19（`createRuntime.ts` composition root + `agentLoopBenchmark.ts` test infrastructure）import 具体 `MemoryStorage`/`SqliteStorage`。canonical 形态 = nexus 通过 `NexusStorage` 接口使用 storage，具体 backend 选型只在 composition root。

测试层 10/10 pass：4 条反向边闸断言（layer 审计 + coupling 数组 + layer 退出 + coupling `--fail-on` 退出）+ 2 条 canonical-shape 不变式（`runtime → providers` + `nexus → storage`）。合成 `runtime → nexus` / `shared → outside` 边与具体 adapter / 具体 storage 注入均能触发对应测试 fail。`npm run deps:audit`（layer 方向 + 依赖归属 + `npm ls`）与 `npm run coupling:audit:gate` 同步 blocking；canonical-shape 测试与反向边闸正交——前者防"具体依赖出现"，后者防"反向边出现"。

### 下一步

下一段实施切片在同一长期规范下：

- （a）**观察 noise**（无需新代码）：跑若干 PR 确认 `coupling-gate` 与 `deps:audit` 与 canonical-shape 不变式零误报。
- （b）**canonical-shape 扩展候选**：审视其他高密度方向是否也有 canonical 形态需要回归断言。当前 `runtime → providers` 与 `nexus → storage` 形态清晰；其他方向（如 `nexus → tools` 11 edges / 8 files、`tools → runtime` 4 edges / 3 files）建议按相同"已存在性调查 → canonical 形态 → 回归断言"流程审视，避免散开加闸。
- （c）**审计脚本输出聚合**（可选）：`deps:audit` 与 `coupling:audit:gate` 当前各出一份独立报告；可考虑合并成单一 summary，但属于可读性优化，不改变 gate 本身。canonical-shape 断言目前是 in-test 逻辑，可考虑也抽到 `scripts/` 下让 CI 单独跑、测试只做回归——但这会引入新文件，与"不散开"原则冲突，目前保持 in-test 形态。
