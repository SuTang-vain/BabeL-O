# EverCore Managed Sidecar Live Validation and Config Passthrough Plan

> State: Draft
> Track: Memory / Nexus / Runtime
> Priority: P1 — `bbl memory status` / `bbl doctor` / `/v1/runtime/status.everCore` all report "ready" while the managed sidecar exits immediately on startup; `memory_search` returns `EVERCORE_MEMORY_UNAVAILABLE`; `capability.longTermMemory: false` despite 4 memory code paths (Phase A-G + L1-L6 + 4-iteration README setup flow) all marked ✅ in `reference/memory-governance-plan.md`. The plan source-of-truth claim "Phase E/F 已完成首轮 live validation" is no longer reproducible.
> Source of truth: [../TODO.md](../TODO.md), [../active/TODO_runtime.md](../active/TODO_runtime.md), [../DONE.md](../DONE.md), [../WORK_LOG.md](../WORK_LOG.md), `src/nexus/everCoreConfig.ts`, `src/nexus/everCoreSidecar.ts`, `src/nexus/everCoreRuntimeManager.ts`, `src/runtime/everosBootstrap.ts`, `src/cli/commands/memory.ts`, `src/cli/commands/doctor.ts`, `src/cli/commands/nexus.ts`, `src/providers/registry.ts`, `src/shared/config.ts`, `src/nexus/server.ts`, `src/runtime/everosBackgroundBootstrap.ts`, `test/everCoreMcpTools.test.ts`
> Governance: Indexed by [README.md](../README.md) and [memory-governance-plan.md](../reference/memory-governance-plan.md). This plan is the **sidecar lifecycle** follow-up to `memory-governance-plan.md`: the latter owns memory capability / lifecycle / sidecar startup **design**; this plan owns the **reproducibility + health-reporting** gap that the design left open. Memory MCP tools, save/recall governance, and candidate policy stay owned by `memory-governance-plan.md`; cache observability stays owned by [cache-observability-and-nexus-realtime-detection-plan.md](../reference/cache-observability-and-nexus-realtime-detection-plan.md); soft-recoverable-timeout stays owned by [development-process-stability-governance-plan.md](../reference/development-process-stability-governance-plan.md).
> Related: [memory-governance-plan.md](../reference/memory-governance-plan.md), [cache-observability-and-nexus-realtime-detection-plan.md](../reference/cache-observability-and-nexus-realtime-detection-plan.md), [daemon-graceful-shutdown-and-orphan-reaper-plan.md](../reference/daemon-graceful-shutdown-and-orphan-reaper-plan.md), [provider-recovery-and-model-catalog-governance-plan.md](./provider-recovery-and-model-catalog-governance-plan.md), [intent-guidance-and-prompt-governance-optimization-plan.md](../reference/intent-guidance-and-prompt-governance-optimization-plan.md), archived [../archive/everos-first-run-onboarding-optimization-plan.md](../archive/everos-first-run-onboarding-optimization-plan.md), archived [../archive/everos-zero-friction-memory-startup-optimization-plan.md](../archive/everos-zero-friction-memory-startup-optimization-plan.md)

## Purpose

`reference/memory-governance-plan.md` marks Phase E/F (managed EverCore + Provider Protocol Convergence) as closed: "**已落地并完成首轮 live validation**：用当前 MiniMax Anthropic-compatible provider 跑通本地 EverOS `/health`、memory add、flush 与 keyword search" (close date 2026-06-17, real sample `session_b7f64aa1`-class setup).

Source verification on 2026-06-30 **fails to reproduce** that live validation. The managed sidecar exits before healthy with `EVERCORE_MANAGED_HEALTH_CHECK_FAILED` because the LLM passthrough chain drops `providerSettings` between `nexus/server.ts:73` (`const providerSettings = ConfigManager.getInstance().resolveSettings()`) and `src/nexus/everCoreSidecar.ts:186` (`buildEverCoreLlmEnv(options.llm)`), and the bootstrap path never writes `dataDir/everos.toml` so a second independent config requirement (embedding model) also fails. The discrepancy is masked by three surfaces reporting "ready" / "configured: yes" / "healthy: yes" while the sidecar is in fact dead.

This plan makes the live-validation claim reproducible and the health surfaces honest, without re-architecting the memory system itself. Three failures are scoped: (1) the sidecar startup cascade leaves the operator without a working memory system on the documented config; (2) the health surfaces over-report; (3) the bootstrap state does not reflect the sidecar's runtime health.

## Current State (source-verified 2026-06-30)

### Reproduction: `bbl nexus start` on a fully-bootstrapped machine

- `bbl memory status` reports `status: ready, optedIn: yes, lastBuildAt: 2026-06-26T09:21:49.076Z`; `/tmp/everos-bootstrap.json` records `buildStatus: "ready"` with `sourceCommit: b7d15f7…` and `dataDir: /var/folders/r0/2xc529t10dz2lk4749f0rh540000gn/T/babel-o-phase2-bcd-x1OHkx/everos/data`.
- `bbl doctor --memory-only` reports `mode: ready, configured: yes` (the "ready" comes from bootstrap build status, not from a sidecar health probe).
- `npx bbl nexus start --port 17824 --cwd /Users/tangyaoyue` boots and exposes `/v1/runtime/status`:
  - `everCore.configured: true`, `enabled: true`, `mode: "managed"`, `url: "http://127.0.0.1:63529/"` — but
  - `everCore.healthy: false`, `everCore.errorCode: "EVERCORE_MANAGED_HEALTH_CHECK_FAILED"`,
  - `everCore.sidecar.running: false`, `sidecar.healthy: false`, `sidecar.errorCode: "EVERCORE_MANAGED_HEALTH_CHECK_FAILED"`,
  - `everCore.sidecar.errorMessage: "EverCore sidecar exited before healthy: code=1 signal=null."`
- `POST /v1/runtime/memory/search {"query":"…","topK":2}` returns `{ type: "error", code: "EVERCORE_MEMORY_UNAVAILABLE", message: "Long-term memory is not available for this runtime." }`.
- `GET /v1/runtime/memory/status` reports `capability.available: false`, `capability.longTermMemory: false`.

The sidecar pid is recorded (~50505 in the reproduction) but the process exits before `/health` responds.

### Sidecar startup cascade (3 distinct failure modes, observed in sequence)

The EverOS server process goes through three startup lifespans (per `everos/src/everos/entrypoints/api/lifespans/`); each can fail independently and the operator currently sees only the last one.

1. **LLM lifespan** (`lifespans/llm.py:29 → component/llm/client.py:46`):
   `LLMNotConfiguredError: LLM is required; set EVEROS_LLM__API_KEY + EVEROS_LLM__BASE_URL`.
2. **Embedding lifespan** (`lifespans/cascade.py:41 → component/embedding/factory.py:36`):
   `ValueError: Embedding model is not configured (set EVEROS_EMBEDDING__MODEL or [embedding] model in user toml)`. Reached only after LLM env is satisfied.
3. **Sidecar process exit** (`EVERCORE_MANAGED_HEALTH_CHECK_FAILED`): the managed-sidecar spawner logs `everos child process exited code=1` and the runtime never reaches `/health`.

The third error is the **only one** the operator sees. The first two are buried in `everos.log` (which the managed-sidecar manager writes to its private dataDir log) and not surfaced through `/v1/runtime/status`.

### LLM passthrough chain (suspected break point)

The intended chain is:
1. `src/nexus/server.ts:73`: `const providerSettings = ConfigManager.getInstance().resolveSettings()` — captures `minimax/anthropic-compatible` provider settings.
2. `src/nexus/server.ts:74`: `defaultEverCoreRuntimeManager.acquireFromEnv(process.env, { cwd, providerSettings })` — passes `providerSettings` in.
3. `src/nexus/everCoreRuntimeManager.ts:62`: `acquireFromEnv(...) → this.acquire(resolveEverCoreConfigInputFromEnv(env, options))` — forwards `options` (which carries `providerSettings`).
4. `src/nexus/everCoreConfig.ts:113-117`: `resolveEverCoreConfigInputFromEnv(env, options) → applyEverOSBootstrapDefaults({ ..., providerSettings: options.providerSettings }, env)`.
5. `src/nexus/everCoreConfig.ts:286-302` `resolveManagedEverCoreLlmConfig(input)`:
   - If explicit `BABEL_O_EVERCORE_LLM_*` is set, use that.
   - Else if `input.providerSettings` is set: `getProvider(settings.providerId).adapter` → `resolveEverCoreLlmProtocol(adapter)` → `anthropic-compatible`; return `{ protocol, apiKey, baseUrl, model }` from `settings.apiKey/baseUrl/modelId`.
6. `src/nexus/everCoreConfig.ts:184`: `llm: resolveManagedEverCoreLlmConfig(input)` is passed to `startManagedEverCoreSidecar({ ... llm, ... })`.
7. `src/nexus/everCoreSidecar.ts:186`: `buildEverCoreLlmEnv(options.llm)` — only fires if `options.llm` is truthy.

Step 5 is the suspect: when `BABEL_O_EVERCORE_LLM_*` is not set, the `providerSettings` branch must be the live source. Source-walk shows `getProvider('minimax')` returns the registered provider (verified in `src/providers/registry.ts:224` — `adapter: 'anthropic-compatible'`), so `resolveEverCoreLlmProtocol('anthropic-compatible')` returns `'anthropic-compatible'`. The branch **should** return a non-`undefined` config.

Empirical evidence contradicts that: the sidecar still exits with `LLMNotConfiguredError`, so `options.llm` is reaching `buildEverCoreLlmEnv` as `undefined`. The break is somewhere in the chain above; a focused trace is required. Likely candidates:
- `applyEverOSBootstrapDefaults` may drop `providerSettings` during the merge with `everosBootstrapConfig.ts` defaults.
- The `mode: 'managed'` resolution path in `configureEverCore` may route around `resolveManagedEverCoreLlmConfig` entirely (e.g. when `managed` is set by `mode: 'managed'` but `BABEL_O_EVERCORE_MODE` differs).
- `defaultEverCoreRuntimeManager.acquire` may cache an `entry` whose `providerSettings` was bound at first call and is stale on subsequent calls (the `CacheEntry` fingerprint in `everCoreRuntimeManager.ts` includes `providerSettings`; verify the fingerprint is stable across the `acquire` chain).

### Embedding model — independent gap

Even after the LLM env is satisfied (manually tested with `EVEROS_LLM__PROTOCOL/API_KEY/BASE_URL/MODEL` set, the next lifespan fails on `Embedding model is not configured`). The `everos.toml` template (auto-generated by `everos init`) does not set `EVEROS_EMBEDDING__MODEL`. There is no source-of-truth default; the operator is expected to provide one. The current setup flow (`runEverOSMemorySetup`) does not prompt for it. This is a real second-order gap, not just a misreport.

### `everos init` is never auto-triggered

The managed-sidecar lifecycle calls `spawn` directly (via `everCoreSidecar.ts:181-191`) and never checks `dataDir/everos.toml` existence. When the user does a `bbl memory setup` flow that successfully builds the binary, the bootstrap **does not** run `everos init` — so even before any LLM issue, the sidecar would still die with a missing-config error. The user's "ready" status is purely `buildStatus: "ready"`, not "sidecar can start".

### The three reporting surfaces disagree

- `bbl memory status` (CLI): "ready" — sourced from bootstrap state, not sidecar.
- `bbl doctor --memory-only`: "ready" / "configured: yes" — also bootstrap-sourced.
- `GET /v1/runtime/status` `everCore.healthy: true` (in some paths) — but in the reproduction, `everCore.healthy: false`. The CLI surfaces do not call the runtime; the runtime is inconsistent with the bootstrap state.
- `GET /v1/runtime/memory/status` `capability.longTermMemory: false` — the only honest surface, but it is downstream of the same `memoryProvider` that bails out with `EVERCORE_MEMORY_UNAVAILABLE`.

The operator cannot tell from the CLI whether long-term memory is actually working. They have to either `npx bbl nexus start` themselves and probe `/v1/runtime/memory/status`, or notice that the model is silently dropping recall requests.

## Problem Statement

The memory subsystem in `reference/memory-governance-plan.md` is documented as ready and validated, but the operator-visible path is in fact broken: managed sidecar cannot start, `memory_search` returns `EVERCORE_MEMORY_UNAVAILABLE`, `capability.longTermMemory: false`. Three failure modes (LLM passthrough drop, missing embedding config, missing `everos init`) all conspire but only the third is reported through the public status surface. This violates two governance principles:

- "Memory capability block" contract: `memory-governance-plan.md` promises memory is capability-aware, but `longTermMemory: false` is the runtime truth the user sees.
- "Phase E live validation" claim: the documented `bbl go` style integration that supposedly exercised the sidecar is not reproducible on a fresh bootstrap.

A new operator who follows the `bbl memory setup` flow and runs `bbl memory status` will see "ready" and assume the system works. They will only discover it does not when their `memory_search` calls return `EVERCORE_MEMORY_UNAVAILABLE`. The "ready" surface is a **misreport** and the lack of an actionable error chain is a **real bug**, not a documentation drift.

## Goals

- Reproduce the sidecar startup end-to-end against the documented config so the Phase E live validation claim becomes true again.
- Make `bbl memory status` and `bbl doctor` honest about sidecar health: report `ready` only when the sidecar is actually ready, or surface the cascading failure reason in the same surface.
- Fix the LLM passthrough break (the highest-leverage root cause; even if the embedding and init gaps also need fixing, the LLM passthrough is what stops the sidecar from reaching the embedding lifespan).
- Auto-trigger `everos init` on bootstrap when `dataDir/everos.toml` is missing, so the operator does not need to know to run it manually.
- Surface cascading error reasons in `/v1/runtime/status.everCore.sidecar.lastStartupError` so the operator can act on the real cause (LLM vs embedding vs init).
- Keep the changes inside the **sidecar lifecycle + status-reporting** scope. Do not redesign the memory abstraction, the `MemoryProvider` interface, the save/recall governance, or the cache observability.

## Non-goals

- Do not change `MemoryProvider` / `NoopMemoryProvider` / `EverCoreMemoryProvider` interfaces or the search/format logic in `src/runtime/memoryProvider.ts`.
- Do not change the candidate governance or the `memory_search` / `memory_save_note` / `memory_flush_session` MCP tool behavior in `src/tools/everCoreMcpTools.ts`.
- Do not change cache observability scope (`cache-observability-and-nexus-realtime-detection-plan.md`).
- Do not change soft-recoverable-timeout semantics (`runtime-tool-loop-governance-plan.md` + `development-process-stability-governance-plan.md`).
- Do not add new model providers or change provider adapter mapping; the LLM passthrough fix stays within `minimax → anthropic-compatible`.
- Do not change the sidecar managed-process model (subprocess + health probe) — the fix is in the env-construction chain, not in the process lifecycle.
- Do not introduce a new testing approach; use the existing `test/everCoreMcpTools.test.ts` + `test/sidecar*.test.ts` (or add a new one in the same style).

## Design

### Phase 1 — Reproduce the documented live validation, then add a regression test

1. Run a clean repro on the current develop branch:
   - `rm -rf /tmp/everos-bootstrap.json /var/folders/.../everos/{source,data}`.
   - `npx bbl memory setup --yes --auto-install-prerequisites`.
   - Wait for `bbl memory status` to report `status: ready`.
   - `npx bbl nexus start --port 17830 --cwd /Users/tangyaoyue`.
   - `curl /v1/runtime/memory/status` — expect `capability.longTermMemory: true` (the current claim).
   - **Result**: confirmation that Phase 1 is needed because the claim does not reproduce. If it does reproduce, document the exact env config and skip to Phase 3.
2. If Phase 1.1 fails (the expected outcome): capture the cascade in `everos.log` and `nexus.log`, attach to this plan as the regression evidence.
3. Add `test/evercore-sidecar-live.test.ts` (or extend `test/everCoreMcpTools.test.ts` if more appropriate) that:
   - Sets up a minimal `bbl memory setup` + `bbl nexus start` end-to-end.
   - Asserts `POST /v1/runtime/memory/search` returns a non-empty `content` for a known fixture query, OR a typed `EVERCORE_MEMORY_UNAVAILABLE` with a **specific** `errorCode` (NOT the current "fetch failed" / "exited before healthy" generic).
   - Skips automatically with `npm run test:quarantine` if a real bootstrap is not available (mirrors `test/quarantine.json` discipline).

### Phase 2 — Fix the LLM passthrough break (highest-leverage root cause)

1. Add a single debug log at `src/nexus/everCoreConfig.ts:286` (inside `resolveManagedEverCoreLlmConfig`):
   `console.warn('[evercore] resolveManagedEverCoreLlmConfig: providerSettings?', !!settings, 'protocol=', protocol, 'apiKey-len=', apiKey.length)`. Run `npx bbl nexus start` and verify the log fires. If it doesn't fire, the break is upstream; instrument the next upstream call until the log appears.
2. Once the break is localized, choose one of:
   - **Fix the passthrough**: ensure `providerSettings` flows through to `options.llm` (the intended design).
   - **Document the explicit config requirement**: if the passthrough is actually disabled by design, document that `BABEL_O_EVERCORE_LLM_*` must be set explicitly when `BABEL_O_EVERCORE_MODE=managed`, and the bootstrap prompt should say so.
3. Whichever fix is chosen, the unit test `test/evercore-config-passthrough.test.ts` (new) asserts:
   - With `BABEL_O_EVERCORE_MODE=managed` and no `BABEL_O_EVERCORE_LLM_*` set, but `providerSettings` set to `minimax`, `resolveManagedEverCoreLlmConfig({ providerSettings, ... })` returns `{ protocol: 'anthropic-compatible', apiKey, baseUrl, model }`.
   - With `BABEL_O_EVERCORE_LLM_API_KEY` set, it wins over `providerSettings`.
4. Update `everCoreConfig.ts:286` to remove the debug log once the fix is verified.

### Phase 3 — Auto-trigger `everos init` and surface cascading errors

1. In `src/nexus/everCoreSidecar.ts:181-191` (the `spawn` call), **before** spawning, check `dataDir/everos.toml` and `dataDir/ome.toml` existence. If missing, run `everos init --root $dataDir --force` via the same `spawn` mechanism (or a separate one). Log the init result into `everCoreSidecarStatus.lastStartupError` if it fails.
2. In `src/nexus/everCoreConfig.ts:184` (the call to `startManagedEverCoreSidecar`), capture the cascading error reason from `everos.log` if the sidecar exits with code=1 within the startup timeout. Specifically, tail `dataDir/everos.log` and match on `LLMNotConfiguredError` / `Embedding model is not configured` / `everos.toml not found` to populate `sidecarStatus.lastStartupError` with a typed `errorCode`:
   - `EVERCORE_MANAGED_LLM_NOT_CONFIGURED`
   - `EVERCORE_MANAGED_EMBEDDING_NOT_CONFIGURED`
   - `EVERCORE_MANAGED_INIT_NOT_RUN`
3. Expose `lastStartupError` through `GET /v1/runtime/status.everCore.sidecar` so the operator can see the actual reason.
4. In `src/cli/commands/memory.ts` (the `bbl memory status` handler) and `src/cli/commands/doctor.ts` (the memory section), **call** `/v1/runtime/memory/status` against a running nexus (or `providerSettings`-driven standalone) and reflect the sidecar health in the displayed message:
   - `mode: ready, sidecar: <healthy|unhealthy: reason>` — instead of just `mode: ready`.
5. Update `bbl memory setup` flow (`src/runtime/everosBootstrap.ts`) to **prompt** for the LLM endpoint / embedding endpoint if `BABEL_O_EVERCORE_LLM_*` and `BABEL_O_EVERCORE_EMBEDDING_*` are unset when bootstrap is interactive (i.e. the first-run path). The non-interactive / auto-bootstrap path should write a minimum-viable `everos.toml` to `dataDir` so the sidecar can start, and surface the bootstrap state in the welcome card.

### Phase 4 — Promote the Phase E live-validation claim to be reproducible

1. Once Phase 1, 2, 3 all pass: re-run the documented "first-round live validation" scenario (`bbl memory setup` + `bbl nexus start` + `memory_search` returns non-empty for a known query) and capture the exact commands + outputs in `DONE.md`.
2. Add a `test:memory-live` smoke tier to `package.json` that runs the full repro against a temp `BABEL_O_CONFIG_FILE`, similar to `test:go-tui:smoke`. Mark it as gated / non-default.
3. Update `reference/memory-governance-plan.md` Phase E "live validation" line to point at the new smoke test instead of being free-form prose.

## Phases

| Phase | Status | Scope | Exit criteria |
| --- | --- | --- | --- |
| Phase 1 | Draft | Reproduce the documented live validation; add regression test. | `bbl memory setup` + `bbl nexus start` + `memory_search` round-trip works OR `test/evercore-sidecar-live.test.ts` documents the specific `errorCode` and the operator-actionable next step. |
| Phase 2 | Draft | Fix LLM passthrough break. | `test/evercore-config-passthrough.test.ts` proves `providerSettings` flows through to `options.llm` in the documented `minimax → managed` scenario. |
| Phase 3 | Draft | Auto-trigger `everos init`; surface cascading errors. | `dataDir/everos.toml` is created on bootstrap if missing; `lastStartupError` is populated; CLI surfaces report the actual sidecar health, not a stale "ready". |
| Phase 4 | Draft | Promote Phase E claim to be reproducible. | `npm run test:memory-live` runs end-to-end; `memory-governance-plan.md` Phase E row references the new smoke test. |

## Verification

- `npm test` (existing memory + sidecar regressions green).
- New `test/evercore-config-passthrough.test.ts` + `test/evercore-sidecar-live.test.ts` (the latter in `test/quarantine.json` if it requires a real bootstrap).
- `npm run typecheck` + `npm run format:check` + `npm run docs:check` clean.
- Manual repro (Phase 1 + 4): documented in `DONE.md` with exact commands + outputs.

## PR granularity

Per [development-process-stability-governance-plan.md](../reference/development-process-stability-governance-plan.md) §6.1, this is **`review-standard`** (no runtime state machine change; only sidecar startup pre-check, status surfacing, and config-passthrough fix). Four commits, one Phase each:

- `chore(memory): reproduce sidecar live validation + add regression test` (Phase 1)
- `fix(evercore): LLM passthrough break in managed-sidecar config` (Phase 2)
- `feat(evercore): auto-init + cascading error surfacing in sidecar status` (Phase 3)
- `docs(memory): promote Phase E live-validation claim to smoke test` (Phase 4)

## Document Ownership

- Current priority lives in [../TODO.md](../TODO.md) and [../active/TODO_runtime.md](../active/TODO_runtime.md).
- Completed facts move to [../DONE.md](../DONE.md); factual history to [../WORK_LOG.md](../WORK_LOG.md).
- When all four Phases close, this plan graduates from `proposals/` to `reference/` per [decisions/0001-documentation-lifecycle.md](../decisions/0001-documentation-lifecycle.md) §Decision, and the canonical memory governance owner ([memory-governance-plan.md](../reference/memory-governance-plan.md)) absorbs the live-validation ownership — the graduated plan stays as the **reproducibility follow-up** for as long as the memory subsystem has any operational risk worth tracking in a dedicated doc.

## 中文概述

### 背景

`reference/memory-governance-plan.md` 标 Phase E/F "EverCore + Provider Protocol Convergence 已完成首轮 live validation"，但 2026-06-30 真实复现失败：`bbl nexus start` 后 managed sidecar 启动即死 (`EVERCORE_MANAGED_HEALTH_CHECK_FAILED`)，`POST /v1/runtime/memory/search` 返回 `EVERCORE_MEMORY_UNAVAILABLE`，`capability.longTermMemory: false`。三个报告面（`bbl memory status` / `bbl doctor` / `/v1/runtime/status.everCore`）都报 "ready" 或 "configured: yes"，但 sidecar 实际未存活 —— 这是误报而不是文档漂移。三层 cascade 失败只有最后一层（"sidecar exited code=1"）被公开，LLM 缺失和 embedding 缺失都被埋在私有 `everos.log` 里。`providerSettings → options.llm` 的 LLM passthrough 链在某处断了（`src/nexus/everCoreConfig.ts:286` 的 `resolveManagedEverCoreLlmConfig` 设计上能从 minimax/anthropic-compatible 推到 sidecar spawn env，但实际 sidecar 没收到 `EVEROS_LLM__*` env）。

### 核心做法

四 Phase：(1) 真实复现 + 加回归测试 `test/evercore-sidecar-live.test.ts`；(2) 修 LLM passthrough 链断点（用一次性 debug log 定位上游），加 `test/evercore-config-passthrough.test.ts`；(3) sidecar 启动前自动 `everos init`，把 cascade 错误原因 tail 出来 populate `lastStartupError` + typed `errorCode`（`EVERCORE_MANAGED_LLM_NOT_CONFIGURED` / `_EMBEDDING_NOT_CONFIGURED` / `_INIT_NOT_RUN`），让 CLI 表面反映真实 sidecar 健康而不是 bootstrap build 状态；(4) 把 Phase E 的 "live validation" 改成可重放的 `test:memory-live` smoke tier，并把 plan 从 `proposals/` 毕业到 `reference/`。

### 当前状态

草案。**前置触发条件**：开 P1 repro + debug log 之后，passthrough 断点的真实位置会被定位（可能是 `applyEverOSBootstrapDefaults` 合并时丢了 `providerSettings`，也可能是 `mode: managed` 解析路径绕过了 `resolveManagedEverCoreLlmConfig`）。修法取决于定位结果，保留两种 fallback：(a) 修 passthrough 让 `providerSettings` 自动注入；(b) 文档化显式 `BABEL_O_EVERCORE_LLM_*` 是 managed 模式的硬要求并在 bootstrap prompt 里强制问。

### 下一步

按 Phase 1/2/3/4 顺序开 4 个 commit，全部 review-standard，3 个新测试 + 1 个文档毕业。Plan 毕业到 `reference/` 后把 live-validation 归属让给 `memory-governance-plan.md`，本 plan 留下作为 sidecar lifecycle 的**复现性 follow-up**。
