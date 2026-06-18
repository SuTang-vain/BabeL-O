# Prompt And Model Governance Index

> State: Index
> Track: Prompt / Intent / Provider / Model Catalog
> Priority: P1 Watch
> Source of truth: `docs/nexus/TODO.md`, `docs/nexus/active/TODO_provider_registry.md`, `docs/nexus/active/TODO_runtime.md`, `docs/nexus/DONE.md`, `docs/nexus/WORK_LOG.md`, `src/runtime/intentGuidance.ts`, `src/runtime/systemPromptBuilder.ts`, `src/runtime/contextAssembler.ts`, `src/providers/registry.ts`, `src/shared/config.ts`, `src/runtime/cacheAwareCompactPolicy.ts`
> Related: [intent-guidance-and-prompt-governance-optimization-plan.md](../proposals/intent-guidance-and-prompt-governance-optimization-plan.md), [fable-prompt-architecture-reference-governance-plan.md](../proposals/fable-prompt-architecture-reference-governance-plan.md), [model-catalog-and-context-metadata-governance-plan.md](./model-catalog-and-context-metadata-governance-plan.md), [evidence-governance-index.md](./evidence-governance-index.md), [context-governance-index.md](./context-governance-index.md), [memory-governance-plan.md](./memory-governance-plan.md)

## Purpose

This document is the reader entry point for BabeL-O prompt, intent, and model metadata governance. It does not replace the detailed plans. Its job is to keep the boundary clear:

- prompt architecture explains stable contracts;
- deterministic runtime policy decides tool visibility, evidence mode, and response mode;
- provider/model metadata decides capability and context-window facts;
- external prompt references are design inputs, not source text;
- automatic model switching and silent fallback remain out of scope unless explicitly re-opened.

## Ownership Map

| Document | Role | Reading rule |
| --- | --- | --- |
| [intent-guidance-and-prompt-governance-optimization-plan.md](../proposals/intent-guidance-and-prompt-governance-optimization-plan.md) | User intent classification, deterministic policy normalization, structured Turn Policy, and suppression/retry boundaries. | Use when tool visibility, respond-only behavior, capability questions, or current-state verification drift. |
| [fable-prompt-architecture-reference-governance-plan.md](../proposals/fable-prompt-architecture-reference-governance-plan.md) | Prompt architecture reference extracted from an external Fable/Claude-style prompt, with incompatible product assumptions rejected. | Use as sectioning/design inspiration only; never copy product identity, paths, tool syntax, or accident-specific wording. |
| [model-catalog-and-context-metadata-governance-plan.md](./model-catalog-and-context-metadata-governance-plan.md) | Provider/model metadata, custom model declarations, context-window semantics, cache-aware compact metadata, and future catalog resolver policy. | Use when model capabilities, context limits, unknown/custom models, or provider diagnostics need a factual source. |

## Governance Rules

### 1. Prompt explains policy; runtime enforces policy

System prompt text should help the model follow BabeL-O rules, but it must not be the only enforcement mechanism. Tool visibility, response mode, evidence mode, stale-task mode, memory capability, and provider capability decisions must be represented by runtime-owned structured policy and tests.

### 2. No accident-specific hidden prompt patches

Do not fix one session drift by injecting hidden natural-language instructions tied to a specific Chinese phrase, provider output, session id, or accident. Stable cue predicates, classifier examples, Turn Policy fields, and regression tests are allowed. Accident-specific prompt prose is not.

### 3. Current-state verification needs evidence

Pure capability questions may receive a concise direct answer. Requests to check whether a capability is currently enabled, configured, healthy, or usable need runtime/tool-backed verification unless the runtime already exposes a trusted diagnostic fact.

### 4. External prompt references are architecture references only

Fable/Claude-style prompts can inform sectioning, capability contracts, and dynamic fact boundaries. They must not import incompatible product identity, filesystem paths, Artifacts/antml semantics, consumer web rules, or unrelated tool protocols into BabeL-O.

### 5. Model metadata is a catalog fact

Context window, default max tokens, structured output, tool calling, streaming, and JSON support should come from an auditable model catalog resolver or explicit user metadata. Unknown model metadata should be shown as unknown with conservative runtime fallback, not misrepresented as a real 8192-token model limit.

### 6. No silent provider/model switching

Automatic model selection, default role-model recommendation, silent provider fallback, and hidden profile switching remain delayed. Explicit user choice, configuration, and diagnostics are allowed; silent execution changes are not.

### 7. Prompt, context, memory, and evidence must agree

Prompt contracts cannot claim capabilities that context assembly, memory governance, tool registry, or provider metadata cannot support. If a capability is unavailable or unhealthy, the model-visible prompt should say less, not invent optimistic state.

## Current State

BabeL-O already has a strong foundation:

- structured `Turn Policy` fields instead of freeform dynamic guidance;
- static system prompt rules explaining how to interpret Turn Policy;
- focused regressions for self-diagnosis, capability questions, respond-only behavior, and tool suppression;
- provider registry and `bbl models inspect` diagnostics;
- cache-aware compact policy based on declared model metadata;
- explicit decision to delay automatic model selection, role-model recommendation, and silent fallback execution.

The remaining issue is governance consistency. Prompt work, model metadata work, context policy, and memory capability exposure must stay aligned instead of drifting into separate hidden heuristics.

## Open Watch Items

| Item | Owner document | Status |
| --- | --- | --- |
| Current-state verification vs pure capability question classification | [intent-guidance-and-prompt-governance-optimization-plan.md](../proposals/intent-guidance-and-prompt-governance-optimization-plan.md) | Watch; strengthen only through regressions. |
| Prompt sectioning and capability contract cleanup | [fable-prompt-architecture-reference-governance-plan.md](../proposals/fable-prompt-architecture-reference-governance-plan.md) | Draft/reference; do not copy source prompt text. |
| Local custom model metadata | [model-catalog-and-context-metadata-governance-plan.md](./model-catalog-and-context-metadata-governance-plan.md) | Active Plan; prioritize local auditable metadata before remote catalog. |
| Unknown model context semantics | [model-catalog-and-context-metadata-governance-plan.md](./model-catalog-and-context-metadata-governance-plan.md) | Active Plan; represent unknown as unknown plus conservative fallback. |
| Remote catalog update flow | [model-catalog-and-context-metadata-governance-plan.md](./model-catalog-and-context-metadata-governance-plan.md) | P3 / optional; must remain cacheable, auditable, and disableable. |

## Verification Expectations

Prompt/model governance changes should be validated with the relevant slice from:

- intent guidance normalization and Turn Policy regression tests;
- system prompt builder and context assembler tests;
- provider registry/model inspect tests;
- cache-aware compact policy tests;
- provider smoke only when adapter-visible behavior changes;
- `npm run docs:check` after documentation or canonical-reference changes.

## 中文概述

### 背景

Prompt / Intent / Model 组容易发生口径漂移：一边想用 prompt 修模型行为，一边又需要 runtime policy、tool visibility、model metadata 和 context window 都保持事实一致。

### 核心做法

本文件建立统一入口：prompt 只解释稳定规则；runtime 决定 Turn Policy 与工具可见性；model catalog 提供模型能力和上下文窗口事实；外部 prompt 只能作为结构参考，不能复制内容。

### 当前状态

BabeL-O 已经从动态自然语言 guidance 转向结构化 Turn Policy，也已有 provider/model diagnostics。当前重点是防止后续又退回事故特定隐藏提示词、错误模型上下文假设或 silent model fallback。

### 下一步

优先推进本地可审计 model metadata 与 current-state verification regressions。自动模型选择、默认 role-model 推荐和远程 catalog 更新继续保持延后，除非用户明确要求或真实回归证明必要。
