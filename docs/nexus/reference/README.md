# Nexus Reference Index

This directory stores long-lived architecture references for BabeL-O / Nexus. It is intentionally smaller than before: draft work now lives in [../proposals/](../proposals/), closed implementation context lives in [../history/](../history/), and architecture decisions live in [../decisions/](../decisions/).

Current scheduling lives in [../TODO.md](../TODO.md), active task detail lives in [../active/](../active/), completed implementation evidence lives in [../DONE.md](../DONE.md), and factual work history lives in [../WORK_LOG.md](../WORK_LOG.md).

## Reference States

| State | Meaning |
| --- | --- |
| `Active Plan` | Still drives implementation sequencing or open architectural decisions. |
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
| [github-discussions-setup-guide.md](./github-discussions-setup-guide.md) | Guide | Owner checklist for enabling GitHub Discussions, creating initial categories, and verifying README/GOVERNANCE community links for Product W4.2. |

## Runtime, Context, And Agent Architecture

| Document | State | Role |
| --- | --- | --- |
| [agent-session-skill-governance-index.md](./agent-session-skill-governance-index.md) | Index | Reader entry point for agent runtime maturity, typed session collaboration, TUI relationship visibility, and the skill product loop. |
| [agent-runtime-architecture-maturity-plan.md](./agent-runtime-architecture-maturity-plan.md) | Active Plan | Defines trace, eval, durable resume, MCP context primitive, memory quality, and loop taxonomy gaps for the next runtime maturity slice. |
| [context-governance-index.md](./context-governance-index.md) | Index | Reader entry point for context governance ownership across compact, working set, behavior trace, cache observability, memory, and tool-loop recovery. |
| [context-cwd-drift-and-recall-governance-plan.md](./context-cwd-drift-and-recall-governance-plan.md) | Active Plan | Real-session regression plan for prompt-derived cwd drift, context-estimate calibration, storage-backed session recall tools, Nexus continuity wiring, and user-artifact continuity. Phase A / A Follow-up / B / C1 are closed; Phase C2 / D / E / F remain open, with `session_10320709` as the current P0 follow-up. |
| [cache-observability-and-nexus-realtime-detection-plan.md](./cache-observability-and-nexus-realtime-detection-plan.md) | Active Plan | Cache health observability, honest unavailable states for non-prompt cache families, and Nexus realtime detection integration phases. |

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

## Go Client And Distribution

| Document | State | Role |
| --- | --- | --- |
| [go-client-distribution-governance-index.md](./go-client-distribution-governance-index.md) | Index | Reader entry point for Go TUI, `bbl loop`, optional Go Runner, launcher, portable package, and release-channel boundaries. |
| [distribution-guide.md](./distribution-guide.md) | Guide | Operational guide for lightweight portable packages, install script behavior, release assets, and user-side checks. |
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
- Every reference document must be `Active Plan`, `Index`, or `Guide`.
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
