# Nexus Reference Index

This directory stores long-lived architecture references for BabeL-O / Nexus. It is intentionally smaller than before: draft work now lives in [../proposals/](../proposals/), closed implementation context lives in [../history/](../history/), and architecture decisions live in [../decisions/](../decisions/).

Current scheduling lives in [../TODO.md](../TODO.md), active task detail lives in [../active/](../active/), completed implementation evidence lives in [../DONE.md](../DONE.md), and factual work history lives in [../WORK_LOG.md](../WORK_LOG.md).

## Reference States

| State | Meaning |
| --- | --- |
| `Active Plan` | Still drives implementation sequencing or open architectural decisions. |
| `Closed Reference` | Implementation has fully closed; retained as a durable architecture reference rather than moved to `history/`. |
| `Index` | A reader map that consolidates terminology and cross-document ownership. |
| `Guide` | Operational guidance rather than architecture planning. |

Draft, partially landed, and closed documents should not remain here. Use [../proposals/](../proposals/) for unstable plans, [../history/](../history/) for closed implementation context, and [../decisions/](../decisions/) for compact ADRs.

## Library Governance

| Document | State | Role |
| --- | --- | --- |
| [REFERENCE_TEMPLATE.md](./REFERENCE_TEMPLATE.md) | Guide | Standard template for new reference documents. It keeps the planning body in English and reserves a concise final Chinese summary for local readability. |

## Development Process Governance

| Document | State | Role |
| --- | --- | --- |
| [development-process-stability-governance-plan.md](./development-process-stability-governance-plan.md) | Active Plan | Defines PR review levels, semantic PR/commit granularity, and flaky test quarantine tiers so high-velocity runtime development keeps trustworthy gates. |
| [module-coupling-decoupling-and-re-aggregation-plan.md](./module-coupling-decoupling-and-re-aggregation-plan.md) | Active Plan | Canonical coupling governance entry point: layer heat map, reverse `runtime → nexus` cleanup, singleton-to-injection, `LLMCodingRuntime` decomposition, `nexus/app.ts` router split, `runtimePipeline.ts` factory cluster, `shared/events.ts` codegen, and `process.env` consolidation. |
| [layer-direction-audit-enforcement-plan.md](./layer-direction-audit-enforcement-plan.md) | Active Plan | Defines direction-aware internal dependency gates, allowlists for reverse imports, and CI-wired architecture tests. |
| [github-discussions-setup-guide.md](./github-discussions-setup-guide.md) | Guide | Owner checklist for enabling GitHub Discussions, creating initial categories, and verifying README/GOVERNANCE community links for Product W4.2. |

## Runtime, Context, And Agent Architecture

| Document | State | Role |
| --- | --- | --- |
| [agent-session-skill-governance-index.md](./agent-session-skill-governance-index.md) | Index | Reader entry point for agent runtime maturity, typed session collaboration, TUI relationship visibility, and the skill product loop. |
| [agent-runtime-architecture-maturity-plan.md](./agent-runtime-architecture-maturity-plan.md) | Active Plan | Defines trace, eval, durable resume, MCP context primitive, memory quality, and loop taxonomy gaps for the next runtime maturity slice. |
| [context-governance-index.md](./context-governance-index.md) | Index | Reader entry point for context governance ownership across compact, working set, behavior trace, cache observability, memory, and tool-loop recovery. |
| [context-cwd-drift-and-recall-governance-plan.md](./context-cwd-drift-and-recall-governance-plan.md) | Active Plan | Real-session regression plan for prompt-derived cwd drift, context-estimate calibration, storage-backed session recall tools, Nexus continuity wiring, and user-artifact continuity. Phase A / A Follow-up / B / C1 are closed; Phase C2 / D / E / F remain open, with `session_10320709` as the current P0 follow-up. |
| [cache-observability-and-nexus-realtime-detection-plan.md](./cache-observability-and-nexus-realtime-detection-plan.md) | Active Plan | Cache health observability, honest unavailable states for non-prompt cache families, and Nexus realtime detection integration phases. |
| [long-running-context-assembly.md](./long-running-context-assembly.md) | Closed Reference | Long-running context assembly: Nexus-owned working set, resume pack, context assembly REST/CLI/WS, persisted working-set hot path injection, redacted `/v1/context/observe`, resume preview product path, Go TUI runtime-owned rendering, and R0-R7 real-session replay gate. R0 / R1 / R2 / R3 / R4 / R5 / R6 / R7 all closed as of 2026-06-20; promoted from `proposals/` to `reference/` on 2026-06-21. |
| [runtime-tool-permission-flow-reference.md](./runtime-tool-permission-flow-reference.md) | Active Plan | Extract one shared tool-permission flow (effective-risk → policy → hooks → scope-boundary → pending registry → audit → events) used by both `LLMCodingRuntime` and `LocalCodingRuntime`, eliminating the duplicated permission/risk/policy code. (Architecture review P1-4.) |
| [task-scope-root-inference-reference.md](./task-scope-root-inference-reference.md) | Active Plan | Correctness boundaries for `inferProjectRoot` (multi-ecosystem root-marker table) and `extractBashTargetPaths` (redirection-aware, honest about `$()` non-support) so the P0 task-scope guardrail stops false-positiving on non-JS/Go projects. (Architecture review P1-6.) |
| [storage-interface-segregation-reference.md](./storage-interface-segregation-reference.md) | Active Plan | Segregate the 48-method `NexusStorage` into per-domain sub-interfaces and make repositories polymorphic across SQLite / Memory backends; extends coupling-plan Phase 9 (Stream G). (Architecture review P2-9.) |
| [streaming-pipeline-realtime-rendering-fix.md](./streaming-pipeline-realtime-rendering-fix.md) | Guide | Three-layer fix (Path 0 / Path 1 / Path 2) postmortem that took the streaming pipeline from "single batched dump at end of turn" to "word-by-word real-time rendering". Closed 2026-06-21 against real session `session_ff3a874d`. WS time trace: before 86 ms span → after 3546 ms span. Bisect targets listed in the doc for any future regression. |
| [context-search-algorithm-robustness-plan.md](./context-search-algorithm-robustness-plan.md) | Active Plan | `contextSearch` retrieval algorithm (tokenized AND-substring) and robustness: `eventTypeFilter` SQL pushdown via `EventListOptions.eventTypes`, 10k-row cap bypass, `eventsScanned`/`eventsCapped` diagnostics, and tool-prompt contract alignment. Phase 0/1 closed 2026-06-21 against `session_06308b17` (5 calls, 4 empty → all non-empty); Phase 2 (CJK bigram) gated, Phase 3 (this graduation) closed. |
| [adaptive-context-window-selection-plan.md](./adaptive-context-window-selection-plan.md) | Closed Reference | Headroom-aware `selectRecentEvents` + `microcompact`/`snip` gating: preserve full history and large tool_results below the warning threshold instead of fixed turn+event+char caps every assembly. Phase 1 closed against `session_cd42cb65` (1/11 → 11/11 turns retained at ~3% usage); Phase 2 closed against `session_75d74b74` (0 → 7 large tool_results preserved at 22% usage; microcompact tokensSaved 39,866 → 14,127 via dedup only). Compact-boundary threshold path untouched. |
| [skill-execution-and-automated-normalized-skill-generation-governance-plan.md](./skill-execution-and-automated-normalized-skill-generation-governance-plan.md) | Active Plan | Skill product loop: schema, registry, explicit skill tools, draft/save boundaries, Go TUI `/skill list|show|validate` slash family, and generation constraints. P0-P3 closed 2026-06-22; PR #11 `feat(go-tui): /skill slash family` merged. Only P4 (`/skill run` composer injection semantics) remains Open as the post-graduation follow-up. |
| [task-scope-and-evidence-scope-governance-plan.md](./task-scope-and-evidence-scope-governance-plan.md) | Closed Reference | Task scope, evidence scope, boundary confirmation, and out-of-scope diagnostics (`src/runtime/taskScope.ts` 404 lines). Phase 0-4 + Phase 5 Diagnostics Slice landed 2026-06-13 against `session_ef76f50a`. |
| [provider-stream-silent-hang-abort-propagation-plan.md](./provider-stream-silent-hang-abort-propagation-plan.md) | Active Plan | Provider/runtime stream abort propagation, single-source hard watchdog, `activeAgeMs` false-positive reset, Nexus iterator abort race settlement, reasoning-only pre-PostInvocation `EMPTY_PROVIDER_RESPONSE`, Go TUI backend-loss settlement, startup stale-`executing` recovery. P0 core Phase 1-6 closed 2026-06-22; only optional BehaviorMonitor `activeAgeMs` push detector remains P2 Watch. |
| [behavior-monitor.md](./behavior-monitor.md) | Active Plan | Behavior trace, cross-session monitor, live hint projection (`src/runtime/behaviorMonitor.ts` 674 lines, `LLMCodingRuntime.ts:1133/1151/1245/1259` live-hint subscribe), Go loop visualization follow-up. Server-side Phase 1/2 + ingest wiring closed 2026-06-17; Go loop mirror remains Open (independent repo). |
| [intent-guidance-and-prompt-governance-optimization-plan.md](./intent-guidance-and-prompt-governance-optimization-plan.md) | Active Plan | Intent guidance, deterministic policy normalization, prompt-governance guardrails. Three governance principles (no accident-specific hardcoded prompts, deterministic Turn Policy ownership, capability/verification split) enforced through `systemPromptBuilder.ts` / `runtimePipeline.ts` / `intentGuidance.ts`. Canonical owner of intent guidance regressions. |
| [daemon-graceful-shutdown-and-orphan-reaper-plan.md](./daemon-graceful-shutdown-and-orphan-reaper-plan.md) | Closed Reference | SIGTERM/SIGINT graceful shutdown with `storage.close()` flush + startup orphan reaper for stale `executing` sessions / `running` agent jobs. Phase 1-3 closed 2026-06-22/23; `test/daemon-graceful-shutdown.test.ts` 6/6 + `test/daemon-orphan-reaper.test.ts` 5/5. |
| [context-selection-dead-code-and-threshold-dedup-plan.md](./context-selection-dead-code-and-threshold-dedup-plan.md) | Active Plan | `contextManager.ts` dead scoring scaffold removal (329 lines, 11 0-external-importer symbols, `score` field dropped at projection) + single `computeContextThresholds` source for `tokenEstimator` / `cacheAwareCompactPolicy` / `computeBlockingLimit`. Source-verified 2026-06-24: 4 threshold sites; `tokenEstimator.ts:88-89` `?? 70/85` fallback is dead in current runtime path (4 callers all pass `cacheAwareCompactPolicy.warning/compactThresholdPercent`); 70/90/80/93 defaults are intentional under test. Three Phase commits: Phase 1 remove dead scaffold; Phase 2 single threshold source; Phase 3 consistency test. |

## Evidence, Scope, And Session Governance

| Document | State | Role |
| --- | --- | --- |
| [evidence-governance-index.md](./evidence-governance-index.md) | Index | Reader entry point for replay safety, evidence coverage, task scope, path drift, finalization, and timeout evidence boundaries. |

## Tool And Runtime Loop Governance

| Document | State | Role |
| --- | --- | --- |
| [tool-governance-plan.md](./tool-governance-plan.md) | Active Plan | Canonical tool governance entry point for tool classes, evidence semantics, native/MCP coexistence, new-tool admission gates, and recoverable failure semantics. |
| [runtime-tool-loop-governance-plan.md](./runtime-tool-loop-governance-plan.md) | Active Plan | Canonical runtime tool-loop continuity entry point for recoverable tool errors, text-shaped tool-call suppression, loop budget diagnostics, and bounded final checks. |

## Prompt, Intent, And Model Governance

| Document | State | Role |
| --- | --- | --- |
| [prompt-model-governance-index.md](./prompt-model-governance-index.md) | Index | Reader entry point for prompt contracts, Turn Policy, runtime-owned intent policy, model metadata, context-window facts, and no-silent-switching boundaries. |
| [model-catalog-and-context-metadata-governance-plan.md](./model-catalog-and-context-metadata-governance-plan.md) | Active Plan | Defines provider/model metadata, context-window semantics, cache-aware compact metadata, and future catalog governance. |

## Memory And Session Collaboration

| Document | State | Role |
| --- | --- | --- |
| [memory-governance-plan.md](./memory-governance-plan.md) | Active Plan | Canonical memory governance entry point for authority model, capability exposure, EverCore/EverOS lifecycle, startup UX, and opt-in write boundaries. |
| [evercore-managed-sidecar-live-validation-and-config-passthrough-plan.md](./evercore-managed-sidecar-live-validation-and-config-passthrough-plan.md) | Closed Reference | Sidecar lifecycle reproducibility follow-up to `memory-governance-plan.md`: the managed `everos` sidecar died on startup (`everos init` never run + `--root` not passed + embedding unconfigured + `stdio:'ignore'` hiding the stderr) while `bbl memory status` / `bbl doctor` misreported "ready". All six phases closed (2026-07-01): auto-init + `--root`, stderr→typed `lastStartupError`, honest CLI health probes, embedding passthrough (`EVEROS_EMBEDDING__*` + `bbl memory setup` prompt), and the `npm run test:memory-live` smoke tier. Promoted from `proposals/` to `reference/`. |

## Go Client And Distribution

| Document | State | Role |
| --- | --- | --- |
| [go-client-distribution-governance-index.md](./go-client-distribution-governance-index.md) | Index | Reader entry point for Go TUI, `bbl loop`, optional Go Runner, launcher, portable package, and release-channel boundaries. |
| [distribution-strategy-plan.md](./distribution-strategy-plan.md) | Active Plan | Defines short-, mid-, and long-term distribution strategy across portable packages, npm wrapper, Go TUI assets, and launcher migration. |

## Lifecycle Directories

| Directory | Role |
| --- | --- |
| [../proposals/](../proposals/) | Draft and partially landed plans that are not yet stable references. |
| [../history/](../history/) | Consolidated ledgers for closed implementation context. |
| [../decisions/](../decisions/) | Compact architecture decision records. |
| [../archive/](../archive/) | Superseded, stale, or source planning documents retained for traceability. |

## Authoring Rules

- New reference documents should follow [REFERENCE_TEMPLATE.md](./REFERENCE_TEMPLATE.md).
- The planning body should be written in English for consistency.
- Keep Chinese text in a final section named `中文概述`.
- Every reference document must be `Active Plan`, `Closed Reference`, `Index`, or `Guide`. Use `Closed Reference` when a plan's implementation has fully closed but it is retained as durable architecture (per [../decisions/0001-documentation-lifecycle.md](../decisions/0001-documentation-lifecycle.md)); step-by-step build logs still go to [../history/](../history/).
- Draft or partially landed work starts in [../proposals/](../proposals/).
- Closed implementation context must be summarized into [../history/](../history/) or [../DONE.md](../DONE.md), not kept as a standalone reference file.
- Architecture-wide decisions should be short ADRs in [../decisions/](../decisions/).
- A reference document must not silently override [../TODO.md](../TODO.md), [../active/](../active/), [../DONE.md](../DONE.md), or [../WORK_LOG.md](../WORK_LOG.md).

## 中文概述

### 背景

`reference/` 曾经承担过长期架构、草案、半完成计划和已收口记录，数量过多。

### 做法

现在 `reference/` 只保留长期有效的架构入口、索引和指南；草案进入 `proposals/`，已完成历史进入 `history/`，关键治理决策进入 `decisions/`。

### 当前状态

Reference 数量已显著压缩，读者可以先从本索引进入长期架构，再按需要跳转到 proposals、history 或 decisions。
