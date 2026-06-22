# Provider Recovery and Model Catalog Governance Plan

> State: Draft
> Track: Provider / Runtime
> Priority: P2 — recovery scaffolding is 3× larger than its actual behavior; the stated catalog rule "user_config > builtin > undeclared" is only half implemented
> Source of truth: [../TODO.md](../TODO.md), [../active/TODO_provider_registry.md](../active/TODO_provider_registry.md), [../DONE.md](../DONE.md), [../WORK_LOG.md](../WORK_LOG.md), `src/runtime/providerRecovery.ts`, `src/runtime/LLMCodingRuntime.ts`, `src/runtime/executeProviderRecoveryDecision.ts`, `src/providers/registry.ts`, `src/shared/config.ts`
> Governance: Indexed by [README.md](../README.md) and [prompt-model-governance-index.md](../reference/prompt-model-governance-index.md). Canonical owner of "provider recovery behavior matches its scaffolding, and the model-catalog precedence rule is what the code actually does." No-silent-switching stays in [prompt-model-governance-index.md](../reference/prompt-model-governance-index.md); model metadata governance in [model-catalog-and-context-metadata-governance-plan.md](../reference/model-catalog-and-context-metadata-governance-plan.md).
> Related: [prompt-model-governance-index.md](../reference/prompt-model-governance-index.md), [model-catalog-and-context-metadata-governance-plan.md](../reference/model-catalog-and-context-metadata-governance-plan.md), [module-coupling-decoupling-and-re-aggregation-plan.md](../reference/module-coupling-decoupling-and-re-aggregation-plan.md)

## Purpose

Two related governance gaps: (1) `providerRecovery.ts` defines a rich fallback type system (`ProviderFallbackPolicy` / `ProviderFallbackAction` / `ProviderFallbackDiagnosticEnvelope`) but the runtime only ever compacts-and-retries the same model for `context_window`; every other path yields for user intervention — the scaffolding is ~3× the behavior. (2) The documented model-catalog precedence is "user_config > builtin > undeclared, never auto-switch," but `registry.ts` only implements "builtin > undeclared, never auto-switch" — user config has no capability field, and `normalizeBabeLXModelId` silently auto-switches during BabeL-X import. This plan decides, per gap, whether to **implement** the documented behavior or **correct the documentation** to match code.

## Current State

- `providerRecovery.ts` (347 lines) classifies errors into `max_output_tokens` / `context_window` / `rate_limit` / `auth_or_billing` / `provider_protocol` / `provider_unavailable` / `unknown` (`:59-190`) and maps each to a `ProviderFallbackPolicy` (`:296-342`). Every policy sets `allowSilentModelSwitch: false`.
- `planProviderFallbackAction()` (`:192-226`) always sets `requiresUserConfirmation: true` and `status: 'needs_user_confirmation' | 'blocked'`. The runtime never auto-retries with a different model/provider.
- Runtime recovery: `executeProviderRecoveryDecision.ts` (imported at `LLMCodingRuntime.ts:847-912`) handles only `context_window` (compact + retry same model). Other kinds yield blocking events or rethrow.
- `matchesAny()` (`:344-346`) is a naive substring check — can false-positive (e.g. "input tokens" in a user message).
- Model catalog: `inspectModelCapabilities` (`registry.ts:1043-1084`) checks `modelRegistry` (builtin) then `createUndeclaredModelDefinition` (`:1086-1098`) with all-`false` capabilities; `capabilityWarning` (`:1065-1067`) says capabilities are "not hard-blocked" for undeclared. `getModel` (`:1035-1041`) throws `UnknownModelError` — never substitutes. `willAutoSwitch: false` is a literal type (`shared/config.ts:96`).
- **Gap A:** user config (`BabelOConfig` / `ProfileConfig` / `ProviderConfig`, `config.ts:36-50,168-184`) has **no capability field** (contextWindow, maxTokens, toolCalling). Users select model id/provider/baseUrl (routing) but cannot declare capability metadata. So "user_config > builtin" is absent — `registry.ts` never consults user config because there is nothing to consult.
- **Gap B:** `normalizeBabeLXModelId` (`config.ts:343-349`) silently substitutes `provider.defaultModel` when a BabeL-X-imported model is not in the registry (`:348`) — a real auto-switch, scoped to the BabeL-X config-import migration path.

## Problem Statement

Scaffolding-without-behavior is debt: readers and future contributors assume fallback works and build on it. A documented precedence rule that the code does not implement is a governance lie — and the one real auto-switch (`normalizeBabeLXModelId`) directly contradicts the "never auto-switch" memory ([[babel-o-model-catalog-governance]]).

## Goals

- **For recovery:** either implement genuine cross-provider fallback for the recoverable kinds (`rate_limit`, `provider_unavailable`) — with explicit user opt-in, never silent — or trim the scaffolding to match the actual compact-retry-only behavior and document the rest as "user intervention required."
- **For catalog:** either add a user-config capability-override field (making "user_config > builtin" real) or correct the governance wording to "builtin > undeclared" and make the BabeL-X auto-switch explicit, opt-in, and logged.
- No silent model switching anywhere by default.

## Non-goals

- Do not make silent auto-fallback the default — the conservative `allowSilentModelSwitch: false` is correct for a coding agent.
- Do not change the error classification taxonomy (it is reasonable).
- Do not change `getModel` throwing on unknown models.

## Design

### Phase 1 — Recovery: decide implement-vs-trim

Decision gate (pick one per kind):

| Kind | Recommendation | Rationale |
| --- | --- | --- |
| `context_window` | Keep (compact + retry same model) — already works. | No change. |
| `max_output_tokens` | Trim: document as "user intervention; suggest continue." | Auto-retry without context change is unsafe. |
| `rate_limit` | Implement: auto-retry with backoff on same provider, then surface to user (not switch provider). | Recoverable; same-model backoff is safe. |
| `provider_unavailable` | Implement: fall back to a user-declared backup provider **only if** the user configured one, with an event. | Opt-in, declared, visible. |
| `auth_or_billing` | Trim: surface immediately; no retry. | Not recoverable automatically. |
| `provider_protocol` | Trim: suggest compact/normalize; user intervention. | Already the intent. |

If a kind is "trim," delete its unused policy/action fields and replace with a single `requiresUserIntervention` envelope. If "implement," wire the runtime to act (backoff for rate_limit; declared-backup-provider for provider_unavailable) and emit a `provider_recovery_action` event.

### Phase 2 — Catalog: user-config capability field OR wording correction

**Option A (implement "user_config > builtin"):** add an optional `capabilities?: Partial<ModelCapabilities>` to `ProviderConfig` / `ProfileConfig` (`config.ts`); `inspectModelCapabilities` consults user-config capabilities first, then builtin, then undeclared. Validate on `bbl models inspect`.

**Option B (correct wording):** update [model-catalog-and-context-metadata-governance-plan.md](../reference/model-catalog-and-context-metadata-governance-plan.md) and `AGENTS.md` §5 to state "builtin > undeclared" as the implemented precedence; mark "user_config override" as a future proposal.

Recommend **Option A** if capability drift is observed in real sessions; **Option B** if not. Default to **Option B** (cheaper, honest) unless evidence demands A.

### Phase 3 — Make the BabeL-X auto-switch explicit

1. `normalizeBabeLXModelId` (`config.ts:343-349`) currently silently substitutes. Change to: emit a `config_import_model_substituted` warning (logged + surfaced in `bbl models` / `bbl doctor`) naming the original id and the substitute, and require the substitution to be opt-in via a config flag (`babelX.import.allowModelSubstitution`, default `false` → fail loud with a remediation hint instead of substituting).
2. This resolves the contradiction with [[babel-o-model-catalog-governance]] "never auto-switch."

## Phases

| Phase | Status | Scope | Exit criteria |
| --- | --- | --- | --- |
| Phase 1 | Draft | Recovery: trim unused scaffolding; implement rate_limit backoff + declared-backup-provider fallback. | `providerRecovery.ts` size matches behavior; new `test/provider-recovery.test.ts` covers backoff + backup-provider; `npm test` green. |
| Phase 2 | Draft | Catalog: Option A (user-config capabilities) or Option B (wording correction). | Either user-config capabilities are consulted in `inspectModelCapabilities`, or governance docs state the implemented precedence. |
| Phase 3 | Draft | BabeL-X auto-switch made explicit/opt-in/logged. | `normalizeBabeLXModelId` no longer silently substitutes by default; warning emitted; `test/config-profile-cli.test.ts` extended. |

## Verification

- `npm test` (existing `test/provider-recovery.test.ts`, `test/providers.test.ts`, `test/provider-recovery-benchmark.test.ts`, `test/retry.test.ts`, `test/config-profile-cli.test.ts` green).
- `npm run test:providers:smoke`.
- `npm run build:smoke`.

## Document Ownership

- Current priority lives in [../TODO.md](../TODO.md) and [../active/TODO_provider_registry.md](../active/TODO_provider_registry.md).
- Completed facts move to [../DONE.md](../DONE.md); factual history to [../WORK_LOG.md](../WORK_LOG.md).
- No-silent-switching boundary stays in [prompt-model-governance-index.md](../reference/prompt-model-governance-index.md).

## 中文概述

### 背景

`providerRecovery.ts`(347 行) 定义了丰富 fallback 类型，但运行时只对 `context_window` 做 compact-retry，其余全交用户，脚手架 3 倍于行为。模型目录治理规则写的是 "user_config > builtin > undeclared, never auto-switch"，但 user config 根本没有 capability 字段，且 `normalizeBabeLXModelId` 在 BabeL-X 导入路径静默自动切换——与 memoryos 记忆冲突。

### 核心做法

Phase 1 按 kind 决定 implement-vs-trim：rate_limit 加同 provider 退避重试、provider_unavailable 加用户声明的备用 provider 回退（均显式可见、非静默），其余 trim 成"需用户介入"；Phase 2 给 user config 加 capability 字段（实现 user_config>builtin）或直接修正治理措辞为 builtin>undeclared；Phase 3 让 BabeL-X 自动切换变成显式 opt-in + 日志 + 默认 fail loud。

### 当前状态

草案。P2 优先级——不阻塞 P0/P1，但治理规则与代码不一致属于诚信债务，应在下一次 provider 主线推进时收口。

### 下一步

最小切片：Phase 3 的 BabeL-X 自动切换改默认 fail loud + 警告，零依赖、直接消除与"never auto-switch"的冲突。
