# Architecture Optimization Assessment Plan

> State: Active Plan
> Track: Runtime / Nexus / Tools / Skills / CLI
> Priority: P1
> Source of truth: [../TODO.md](../TODO.md), [../active/TODO_runtime.md](../active/TODO_runtime.md), [../active/TODO_cleanup.md](../active/TODO_cleanup.md), `src/runtime/contextAssembler.ts`, `src/runtime/runtimeToolLoop.ts`, `src/runtime/LLMCodingRuntime.ts`, `src/runtime/LocalCodingRuntime.ts`, `src/nexus/agentLoop.ts`, `src/skills/`, `src/shared/errors.ts`, `scripts/audit-layer-direction.js`, `scripts/audit-coupling.js`, `test/`
> Governance: Indexed by [README.md](./README.md). This document assesses architecture health and recommends optimization slices not already owned by existing reference plans. It must not duplicate [module-coupling-decoupling-and-re-aggregation-plan.md](./module-coupling-decoupling-and-re-aggregation-plan.md) (coupling debt), [runtime-tool-permission-flow-reference.md](./runtime-tool-permission-flow-reference.md) (tool permission dedup), [agent-runtime-architecture-maturity-plan.md](./agent-runtime-architecture-maturity-plan.md) (agent maturity), or [layer-direction-audit-enforcement-plan.md](./layer-direction-audit-enforcement-plan.md) (audit enforcement).
> Related: [module-coupling-decoupling-and-re-aggregation-plan.md](./module-coupling-decoupling-and-re-aggregation-plan.md), [runtime-tool-permission-flow-reference.md](./runtime-tool-permission-flow-reference.md), [layer-direction-audit-enforcement-plan.md](./layer-direction-audit-enforcement-plan.md), [agent-runtime-architecture-maturity-plan.md](./agent-runtime-architecture-maturity-plan.md), [task-scope-root-inference-reference.md](./task-scope-root-inference-reference.md), [storage-interface-segregation-reference.md](./storage-interface-segregation-reference.md)

## Purpose

This document provides a holistic architecture health assessment for BabeL-O as of v0.4.1, identifies optimization opportunities that are NOT already owned by existing Active Plans, and proposes concrete implementation slices. It serves as the reader's entry point for understanding where the architecture is strong, where it needs attention, and which existing plan owns each concern.

## Current State

BabeL-O v0.4.1 has a clean, well-layered architecture with machine-enforced boundaries. The project ships with two automated audit scripts (`audit-layer-direction.js` scanning 1165 cross-module imports, and `audit-coupling.js` reporting reverse imports) plus `architecture-boundary.test.ts` with 10 regression-asserting tests. Key metrics:

- **Layer enforcement**: 6 direction rules with checked-in allowlist. 1 known violation (`shared/config.ts → cli/secrets/index.ts`, allowlisted).
- **Coupling audit**: `runtimeToNexus: []`, `nexusToCli: []` — both reverse directions are clean.
- **Canonical-shape invariants**: `runtime → providers` (30 edges, 100% type-only or registry), `nexus → storage` (20 edges, 85% interface-only).
- **Singleton debt**: `ConfigManager.getInstance()` still has ~22 legacy callsites; `defaultContextBroadcaster` has 7 Nexus-side references.
- **File size health**: `LLMCodingRuntime.ts` 1493 lines (post-Phase 3B+), `nexus/app.ts` 191 lines (post-Phase 4A+), `SqliteStorage.ts` 968 lines (post-Stream G). `contextAssembler.ts` ~500 lines, `agentLoop.ts` ~1800 lines, `runtimeToolLoop.ts` ~900 lines.

## Architecture Strengths

Before listing optimization targets, it is important to acknowledge what is already working well. These are the architectural decisions that should be protected during any refactoring.

### S1. Layered architecture with machine-enforced gates

The project adheres to a strict `shared → domain → runtime → nexus → cli` dependency direction enforced by CI-wired audit scripts. Every cross-layer import must be in the checked-in `scripts/layer-direction-allowlist.json`. This is exceptional — most OSS projects at this scale have no automated layer enforcement at all.

### S2. Interface-based decoupling at every boundary

`NexusRuntime`, `NexusStorage`, `ToolPolicy`, `MemoryProvider`, `AgentScheduler`, `RemoteToolRunner` — every cross-module dependency uses a typed interface, not a concrete class. The composition root in `server.ts` wires implementations once, making the system testable and replaceable.

### S3. Four-layer permission gating

```
Policy block (allowlist/denylist)
  → Turn authorization (user intent level)
    → Task scope boundary (cross-project detection)
      → Interactive user permission (prompt flow)
```

Each gate is independent. `taskScope.ts` detects three boundary kinds (parent_scan, sibling_repo, external_absolute_path). The Bash tool's `riskForInput()` enables command-level risk reclassification (e.g. `git status` → read, `rm -rf` → destructive). Few agent runtimes have this level of permission granularity.

### S4. Adaptive context management

The context assembly pipeline (`contextAssembler.ts`) implements headroom-aware window selection: at low token usage (<70% of model ceiling), it preserves all history and full-size tool_results; at high usage, it applies microcompact + snip compression. This avoids the common "model forgets previous turns" failure mode at single-digit context usage.

### S5. Comprehensive observability

Five independent trace systems (behavior trace, agent trace, tool trace, execution metrics, permission audit) provide debugging surface area for every runtime failure mode. The `BehaviorMonitor` implements three cross-session detectors (hot-path, tool-storm, scope-drift-wave) that catch anomalies across sessions without requiring the developer to replay individual runs.

### S6. Self-auditing build pipeline

`npm run deps:audit` runs three checks (layer direction + dependency boundary + `npm ls`), `npm run coupling:audit:gate` blocks reverse imports in CI, and `architecture-boundary.test.ts` regression-asserts both gates plus canonical-shape invariants. No developer needs to remember architecture rules — the build remembers for them.

## Optimization Targets

The sections below identify optimization opportunities that are NOT already owned by existing Active Plans. Each target is ranked by impact/effort ratio and includes a concrete scope statement.

### T1. Skills provider abstraction in `contextAssembler.ts`

**Impact**: Medium (decouples skills discovery from the hot path)
**Effort**: Low (introduce one interface, move one import)
**Current state**: `contextAssembler.ts` directly imports `skills/loader.ts` and `skills/matcher.ts`, then synchronously calls `loadAllSkills()` and `matchSkills()` inside `assembleContext()`. This means every context assembly run pays the cost of skill loading and matching, even when no skills match the prompt.

**Problem**: If the skills framework evolves to be remote-loaded (e.g. OCI registry, marketplace), the synchronous filesystem assumption breaks. The current coupling also makes it harder to test `assembleContext()` in isolation — every test must either mock the skills filesystem or accept real skill files being loaded.

**Recommendation**: Extract a `SkillProvider` interface:

```ts
export type SkillMatchResult = {
  id: string
  name: string
  content: string
}

export interface SkillProvider {
  matchPrompt(prompt: string, cwd: string): Promise<SkillMatchResult[]>
}
```

Default implementation delegates to existing `loadAllSkills` + `matchSkills`. Pass through `ContextAssemblerOptions` so callers can inject test doubles. `assembleContext()` no longer imports from `skills/` directly.

**Relation to existing plans**: Not covered by any Active Plan. The skill-execution governance plan ([skill-execution-and-automated-normalized-skill-generation-governance-plan.md](./skill-execution-and-automated-normalized-skill-generation-governance-plan.md)) focuses on the skill product loop (tools, CLI, validation), not on runtime integration boundaries.

### T2. Error handling consistency across layers

**Impact**: Medium (simplifies debugging, reduces ad-hoc error handling)
**Effort**: Medium (define error types, migrate 3-5 files at a time)
**Current state**: The project lacks a unified error handling strategy. Errors are produced through `buildRuntimeErrorEvent()` (which wraps them as NexusEvents) and consumed through try/catch blocks that convert them into tool_result envelopes or terminal outcomes. The `shared/errors.ts` module provides only `errorMessage()` (serialize any thrown value to string) and `ErrorCode` enum.

**Problem**: Different layers handle errors differently. `runtimeToolLoop.ts` wraps tool execution errors with `buildRuntimeErrorEvent()` and returns terminal outcomes. `LLMCodingRuntime.ts` catch-block delegates to `executeProviderRecoveryDecision()`. `LocalCodingRuntime.ts` has its own inline error handling. A new developer adding error handling in a new module has no pattern to follow.

**Recommendation**: Define a lightweight error hierarchy:

```ts
class BabeLError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode,
    readonly recoverable: boolean,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'BabeLError'
  }
}

class ToolExecutionError extends BabeLError { /* ... */ }
class ProviderError extends BabeLError { /* ... */ }
class PermissionDeniedError extends BabeLError { /* ... */ }
```

The top-level error boundary in `executeStream()` converts any `BabeLError` into the appropriate NexusEvent. Non-BabeLErrors are wrapped as `INTERNAL_ERROR`. This gives every layer a consistent pattern: throw a typed error, let the boundary handle event production.

**Relation to existing plans**: Not covered. The coupling plan focuses on import direction and class decomposition, not on error modeling. The agent runtime maturity plan focuses on trace/eval/resume, not on error architecture.

### T3. Agent loop file decomposition

**Impact**: Medium (improves reviewability of agent orchestration)
**Effort**: Medium (split one large file into role-specific modules)
**Current state**: `agentLoop.ts` is ~1800 lines containing the full Planner → Executor → Critic → Optimizer loop, sub-agent lifecycle management, worktree isolation, and task queue orchestration.

**Problem**: Unlike `LLMCodingRuntime.ts` and `nexus/app.ts` (both already decomposed), `agentLoop.ts` remains monolithic. Every agent behavior change — whether it touches Planner review approval, Executor tool routing, Critic scoring, or worktree merge conflict recovery — has to navigate the same file.

**Recommendation**: Split by agent role:

- `agentLoop/index.ts` — thin re-export facade
- `agentLoop/plannerStep.ts` — `runPlannerStep()`, Planner role definition, review approval flow
- `agentLoop/executorStep.ts` — `runExecutorStep()`, Executor role, sub-task execution
- `agentLoop/criticStep.ts` — `runCriticStep()`, Critic role, review decisions
- `agentLoop/optimizerStep.ts` — `runOptimizerStep()`, Optimizer role, in-place optimization
- `agentLoop/subAgentLifecycle.ts` — sub-agent creation, approval inheritance, summarization
- `agentLoop/worktreeOps.ts` — worktree create/commit/remove/prune (already partially in `agentLoopWorktree.ts`)

The current `agentLoopWorktree.ts` and `agentLoopSubAgents.ts` helpers prove this split is already architecturally intended — the remaining work is moving the orchestration functions out of the monolithic file.

**Relation to existing plans**: Not explicitly covered. The coupling plan's Phase 4A+ already decomposed `app.ts` into routers; this is the analogous operation for `agentLoop.ts`. The agent runtime maturity plan focuses on feature gaps (trace, eval, resume), not on code organization.

### T4. Context assembler step decomposition

**Impact**: Medium (improves testability of individual assembly steps)
**Effort**: Medium-High (extract 5-7 composable functions from one large function)
**Current state**: `contextAssembler.ts` ~500 lines. The `assembleContext()` function executes ~20 sequential steps: budget allocation, memory loading, agentMd loading, git context, compact boundary detection, event selection, microcompacting, snipping, message mapping, memory provider retrieval, skills matching, post-compact state derivation, session inbox formatting, dynamic budget enforcement, and system prompt assembly.

**Problem**: Testing any individual step (e.g. "does dynamic budget enforcement correctly truncate project memory?") requires mocking the entire dependency graph of 15+ modules. The function is correct but its test surface is too wide.

**Recommendation**: Extract composable steps as standalone functions that take explicit inputs and return explicit outputs:

```ts
async function loadMemoryLayer(cwd: string, runtimeOptions: RuntimeExecuteOptions): Promise<MemoryLayer>
async function loadSkillsLayer(cwd: string, prompt: string): Promise<SkillsLayer>
function selectEventsForBudget(events: NexusEvent[], budget: ContextBudget): SelectedEventWindow
function compressEventWindow(events: NexusEvent[], budget: ContextBudget, headroom: boolean): CompressedWindow
function assemblePromptSections(layers: AssembledLayers): SystemPromptSection[]
```

Each function is independently testable. `assembleContext()` becomes a thin orchestrator that sequences these steps. This is consistent with how `runtimePipeline.ts` was split into `src/runtime/pipeline/{turn,events,context,contextRefresh,cache,loop,providerTurn,localIntent}.ts` in Phase 3A of the coupling plan.

**Relation to existing plans**: Not explicitly covered. The coupling plan's Stream C decomposes `LLMCodingRuntime` class, but `contextAssembler.ts` (a standalone function, not a class method) was not in scope. The context governance index tracks context behavior, not code organization.

## Design

The four targets above are independent, can be executed in any order, and do not require coordination with each other. The recommended execution order maximizes impact-per-effort:

| Priority | Target | Rationale |
| --- | --- | --- |
| First | T1 — SkillsProvider interface | Lowest effort, highest decoupling payoff. One interface, one injection point, no behavior change. |
| Second | T3 — Agent loop decomposition | Builds on the proven `app.ts` router-split pattern. Role-specific files make agent behavior changes reviewable in isolation. |
| Third | T4 — Context assembler steps | Follows the `runtimePipeline.ts` submodule-split pattern. Makes each assembly step independently testable. |
| Fourth | T2 — Error handling consistency | Highest impact but also highest effort. Requires migrating error sites across 3+ layers. Best done after the other targets are stable so the error boundary has clean entry points. |

### Overlap with existing plans

This document intentionally does NOT propose work already owned by other Active Plans:

| Concern | Owned by | This document's position |
| --- | --- | --- |
| Layer direction violations (`shared → cli`) | [layer-direction-audit-enforcement-plan.md](./layer-direction-audit-enforcement-plan.md) | Already allowlisted; not an optimization target |
| Reverse `runtime → nexus` imports | [module-coupling-decoupling-and-re-aggregation-plan.md](./module-coupling-decoupling-and-re-aggregation-plan.md) | Already closed (`runtimeToNexus: []`) |
| `LLMCodingRuntime` class decomposition | [module-coupling-decoupling-and-re-aggregation-plan.md](./module-coupling-decoupling-and-re-aggregation-plan.md) Stream C | Phase 3B+ in progress; not duplicated here |
| `nexus/app.ts` router split | [module-coupling-decoupling-and-re-aggregation-plan.md](./module-coupling-decoupling-and-re-aggregation-plan.md) Phase 4A+ | Closed (191 lines); not duplicated here |
| Duplicated tool permission flow in two runtimes | [runtime-tool-permission-flow-reference.md](./runtime-tool-permission-flow-reference.md) | Owned by that plan; referenced here as context |
| `SqliteStorage` repository decomposition | [module-coupling-decoupling-and-re-aggregation-plan.md](./module-coupling-decoupling-and-re-aggregation-plan.md) Stream G | Closed (968 lines); not duplicated here |
| Singleton → injection migration | [module-coupling-decoupling-and-re-aggregation-plan.md](./module-coupling-decoupling-and-re-aggregation-plan.md) Stream B | Phase 2D pending; not duplicated here |
| `runtimePipeline.ts` factory split | [module-coupling-decoupling-and-re-aggregation-plan.md](./module-coupling-decoupling-and-re-aggregation-plan.md) Phase 3A | Closed; provides the pattern used in T4 |
| Agent trace/eval/resume gaps | [agent-runtime-architecture-maturity-plan.md](./agent-runtime-architecture-maturity-plan.md) | Feature gaps, not code organization; not duplicated here |
| Task scope root inference correctness | [task-scope-root-inference-reference.md](./task-scope-root-inference-reference.md) | Defines correctness rules; not an overlap with organization targets |
| Storage interface segregation | [storage-interface-segregation-reference.md](./storage-interface-segregation-reference.md) | Post-Stream G extension; not an overlap with this document |

## Phases

### Phase 1 — SkillsProvider abstraction (T1)

| Step | Scope | Exit criteria |
| --- | --- | --- |
| 1a | Define `SkillProvider` interface in `src/skills/provider.ts` with `matchPrompt(prompt, cwd) → SkillMatchResult[]` | Interface compiles; no behavior change yet |
| 1b | Implement `FilesystemSkillProvider` that delegates to existing `loadAllSkills` + `matchSkills` | Existing skill loading tests pass through the new provider |
| 1c | Add `skillProvider?: SkillProvider` to `ContextAssemblerOptions`; default to `FilesystemSkillProvider` | `assembleContext()` no longer imports from `skills/loader.ts` or `skills/matcher.ts` directly |
| 1d | Verify: inject a stub `SkillProvider` that returns fixed results; confirm context assembly uses stub output | New test proves the injection works; existing skill tests still pass |

### Phase 2 — Agent loop decomposition (T3)

| Step | Scope | Exit criteria |
| --- | --- | --- |
| 2a | Extract `runPlannerStep()` into `agentLoop/plannerStep.ts`. Export `PlannerTaskPlan` and `PlannerReviewDecision` types. | `agentLoop.ts` imports `runPlannerStep()` from the new module; existing Planner tests pass |
| 2b | Extract `runExecutorStep()` into `agentLoop/executorStep.ts`. Export `ExecutorAgentResult` type. | `agentLoop.ts` imports `runExecutorStep()` from the new module; existing Executor tests pass |
| 2c | Extract sub-agent lifecycle functions into `agentLoop/subAgentLifecycle.ts`. Consolidate with existing `agentLoopSubAgents.ts` helpers. | `agentLoop.ts` imports sub-agent functions from the new module; existing sub-agent tests pass |
| 2d | Extract Critic + Optimizer steps into `agentLoop/criticStep.ts` and `agentLoop/optimizerStep.ts` | All agent loop tests pass through the decomposed modules |
| 2e | Create `agentLoop/index.ts` re-export facade for backwards compatibility | Import paths do not change; all existing callers compile without modification |

### Phase 3 — Context assembler step decomposition (T4)

| Step | Scope | Exit criteria |
| --- | --- | --- |
| 3a | Extract memory layer loading (`loadProjectMemory` + `loadAgentMdFiles` + `collectGitContext` + budget enforcement) into `assembleMemoryLayer()` | Independent test: mock filesystem, verify memory truncation budget |
| 3b | Extract event selection + compaction + snipping pipeline into `assembleEventWindow()` | Independent test: verify headroom-aware selection preserves all turns at low usage |
| 3c | Extract session-level assembly (memory provider, skills, post-compact state, session inbox, resume nudge) into `assembleSessionLayer()` | Independent test: inject stub providers, verify prompt sections |
| 3d | Refactor `assembleContext()` to sequence these three steps | All existing context assembly tests pass; the function body is ~30 lines of orchestration |
| 3e | Extract `eventIdentity`, `hashEventIdentities`, `isRecoveryBoundaryError` into `src/runtime/eventIdentity.ts` | These utilities are testable without importing `contextAssembler.ts` |

### Phase 4 — Error handling consistency (T2)

| Step | Scope | Exit criteria |
| --- | --- | --- |
| 4a | Define `BabeLError` base class + `ToolExecutionError`, `ProviderError`, `PermissionDeniedError` in `src/shared/errors.ts` | TypeScript compiles; existing `ErrorCode` enum unchanged |
| 4b | Add `toNexusEvent()` method on each error class that returns the appropriate NexusEvent shape | Unit tests verify each error class produces the correct event type |
| 4c | Migrate `runtimeToolLoop.ts` error sites to throw typed errors; add error boundary in `executeStream` | Existing tool error tests pass; new test proves INTERNAL_ERROR wrapping for unknown errors |
| 4d | Migrate `LocalCodingRuntime.ts` error sites to use the same typed errors | Existing local runtime tests pass; error shape is consistent with LLM path |
| 4e | Migrate provider-level errors (retry, recovery, adapter) to use `ProviderError` | Existing provider recovery tests pass |

## Verification

For each phase:

- `npm run typecheck` must pass at every step (phases are additive, not destructive).
- `npm test` must keep all existing tests green. Each phase adds focused unit tests for the extracted module.
- `npm run deps:audit` and `npm run coupling:audit:gate` must remain green — no new cross-layer imports.
- `npm run build:smoke` must pass at phase completion boundaries.
- Each phase produces exactly one PR. Phases within a target can be merged independently (steps are additive).

## Document Ownership

- Current priority lives in [../TODO.md](../TODO.md). Before starting any phase, add a TODO entry linking back to this document.
- This document is deliberately a high-level assessment and phase map. Implementation detail (specific function signatures, test cases, edge-case handling) is owned by the PRs.
- Phase completion evidence (test counts, line count before/after, audit fingerprints) goes to [../WORK_LOG.md](../WORK_LOG.md).
- If a phase exposes coupling debt (e.g. T1 reveals that skills loader has a hidden dependency on config), file it in [module-coupling-decoupling-and-re-aggregation-plan.md](./module-coupling-decoupling-and-re-aggregation-plan.md), not in this document.
- If a phase exposes a runtime behavior gap (e.g. T3 reveals that the Critic step never fires for failed Executor runs), file it in [agent-runtime-architecture-maturity-plan.md](./agent-runtime-architecture-maturity-plan.md) or [active/TODO_runtime.md](../active/TODO_runtime.md).

## 中文概述

### 背景

BabeL-O v0.4.1 已经具备高质量的架构基础：严格分层 + CI 强制闸、全接口解耦、四层权限门控、自适应上下文管理、五路可观测性、自审计构建流水线。六项架构优势（S1-S6）均处于可验证状态。

同时，在 2026-06 至 2026-07 的密集治理周期中，`module-coupling-decoupling-and-re-aggregation-plan.md` 已完成 Phase 0.5/1A/1B/2A/2B/2C/3A、Phase 3B+ 过半、Phase 4A+ 全部收口、Stream G 全部收口；`layer-direction-audit-enforcement-plan.md` 三阶段均已采纳为 blocking；`nexus/app.ts` 从 6170 缩减至 191 行。这个优化节奏说明项目有很强的执行能力，但已有治理计划已经覆盖了大部分显而易见的耦合和分层问题。

### 核心做法

本文档从 2026-07 架构审计中提取了 4 个**未被已有 Active Plan 覆盖**的优化目标，按投入产出比排序：

- **T1 — SkillsProvider 抽象**（低投入、中型收益）：用一个接口解耦 `contextAssembler.ts` 对 `skills/loader.ts` 的直接文件系统依赖。这是当前热路径上最便宜的一次解耦。
- **T3 — Agent 循环文件拆分**（中型投入、中型收益）：把 ~1800 行 `agentLoop.ts` 按 Planner/Executor/Critic/Optimizer 角色拆成独立模块，复用已成功落地的 `app.ts` router-split 模式。
- **T4 — Context Assembler 步骤拆分**（中高投入、中型收益）：把 `assembleContext()` 的 ~20 步压缩成 3 个可独立测试的组装步骤，复用已成功的 `runtimePipeline.ts` submodule-split 模式。
- **T2 — 错误处理一致性**（最高投入、最高收益）：定义 `BabeLError` 基类和三个子类，在 `executeStream()` 边界统一转换，消除各层 ad-hoc 错误处理。

每项都是一个小切片的累进——不改行为、不改接口、不破公共协议，只改内部代码组织。

### 与已有治理的关系

本文档明确不重复已有 Active Plan 的职责范围。耦合计划（module coupling）管导入方向和类拆分，本计划管它没覆盖到的热路径隔离（Skills）和文件组织（agentLoop, contextAssembler）；Agent 成熟度计划管功能缺口（trace/eval），本计划管代码组织；工具权限计划管权限流程去重，本计划管错误类型建模。详见 Design 节的对照表。

### 当前状态

四个目标均为 Draft，尚未开始实施。文档本身处于 Active Plan 状态，作为接下来架构优化切片的排序依据。

### 下一步

1. 如需推进，先在 [../TODO.md](../TODO.md) 中登记一行 P1 条目链接回本文档。
2. 按 Phase 1-4 顺序开独立 PR。每个 Phase 内的 Step 可独立合入（增量、非破坏性）。
3. Phase 完成证据写入 [../WORK_LOG.md](../WORK_LOG.md)，完成后的 Phase 在本表标记为 Closed。
4. 如优化过程中暴露出新的耦合或行为缺口，文件到对应的已有治理计划，不在本计划内追加新目标。
