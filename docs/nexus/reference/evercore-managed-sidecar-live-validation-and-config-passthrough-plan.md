# EverCore Managed Sidecar Live Validation and Config Passthrough Plan

> State: Closed Reference
> Track: Memory / Nexus / Runtime
> Priority: P1 — `bbl memory status` / `bbl doctor` / `/v1/runtime/status.everCore` all report "ready" / "configured: yes" while the managed sidecar exits immediately on startup; `memory_search` returns `EVERCORE_MEMORY_UNAVAILABLE`; `capability.longTermMemory: false`. **Root cause (2026-07-01 live capture): the sidecar dies because `everos init` was never run, so `everos.toml` does not exist; the spawner also never passes `--root <dataDir>` / `EVEROS_ROOT`, so `everos` looks in `~/.everos/` and exits `code=1` before any LLM/embedding lifespan runs.** The earlier hypothesis "LLM passthrough chain drops `providerSettings`" is **disproven** — `EVEROS_LLM__*` env is correctly injected end-to-end.
> Source of truth: [../TODO.md](../TODO.md), [../active/TODO_runtime.md](../active/TODO_runtime.md), [../DONE.md](../DONE.md), [../WORK_LOG.md](../WORK_LOG.md), `src/nexus/everCoreConfig.ts`, `src/nexus/everCoreSidecar.ts`, `src/nexus/everCoreRuntimeManager.ts`, `src/nexus/everosBootstrapConfig.ts`, `src/runtime/everosBootstrap.ts`, `src/cli/commands/memory.ts`, `src/cli/commands/doctor.ts`, `src/cli/commands/nexus.ts`, `src/providers/registry.ts`, `src/shared/config.ts`, `test/everCoreMcpTools.test.ts`
> Governance: Indexed by [README.md](../README.md) and [memory-governance-plan.md](./memory-governance-plan.md). This plan is the **sidecar lifecycle** follow-up to `memory-governance-plan.md`: the latter owns memory capability / lifecycle / sidecar startup **design**; this plan owns the **reproducibility + health-reporting** gap that the design left open. Memory MCP tools, save/recall governance, and candidate policy stay owned by `memory-governance-plan.md`; cache observability stays owned by [cache-observability-and-nexus-realtime-detection-plan.md](./cache-observability-and-nexus-realtime-detection-plan.md); soft-recoverable-timeout stays owned by [development-process-stability-governance-plan.md](./development-process-stability-governance-plan.md).
> Related: [memory-governance-plan.md](./memory-governance-plan.md), [cache-observability-and-nexus-realtime-detection-plan.md](./cache-observability-and-nexus-realtime-detection-plan.md), [daemon-graceful-shutdown-and-orphan-reaper-plan.md](./daemon-graceful-shutdown-and-orphan-reaper-plan.md), [provider-recovery-and-model-catalog-governance-plan.md](../proposals/provider-recovery-and-model-catalog-governance-plan.md), [intent-guidance-and-prompt-governance-optimization-plan.md](./intent-guidance-and-prompt-governance-optimization-plan.md), archived [../archive/everos-first-run-onboarding-optimization-plan.md](../archive/everos-first-run-onboarding-optimization-plan.md), archived [../archive/everos-zero-friction-memory-startup-optimization-plan.md](../archive/everos-zero-friction-memory-startup-optimization-plan.md)

## Purpose

`reference/memory-governance-plan.md` marks Phase E/F (managed EverCore + Provider Protocol Convergence) as closed: "**已落地并完成首轮 live validation**：用当前 MiniMax Anthropic-compatible provider 跑通本地 EverOS `/health`、memory add、flush 与 keyword search" (close date 2026-06-17, real sample `session_b7f64aa1`-class setup).

Source verification on 2026-06-30 **failed to reproduce** that live validation. A 2026-07-01 follow-up captured the sidecar's actual stderr and **corrected the root cause**: the sidecar does not die from an LLM passthrough break — it dies because `everos init` was never run and the spawner never tells `everos` where to find its config. The earlier 2026-06-30 hypothesis (passthrough drops `providerSettings`) was inferred from the public `EVERCORE_MANAGED_HEALTH_CHECK_FAILED` surface without the sidecar stderr; the stderr was being swallowed by `stdio: 'ignore'` in `everCoreSidecar.ts`. This plan makes the live-validation claim reproducible and the health surfaces honest, without re-architecting the memory system itself.

## Current State (source-verified 2026-07-01)

### Reproduction: `bbl nexus start` on a fully-bootstrapped machine

- `bbl memory status` reports `status: ready, optedIn: yes, lastBuildAt: 2026-06-20T05:01:31.661Z`; `~/.babel-o/everos-bootstrap.json` records `buildStatus: "ready"` with `sourceCommit: dbfe3483…` and `dataDir: /var/folders/r0/…/T/everos/data`. (Note: the 2026-06-30 draft referenced `/tmp/everos-bootstrap.json`; the real path is `~/.babel-o/everos-bootstrap.json`.)
- `bbl doctor --memory-only` reports `mode: ready, configured: yes` (the "ready" comes from bootstrap build status, not from a sidecar health probe).
- `node bin/bbl.js nexus start --port 17831 --cwd /Users/tangyaoyue` boots and exposes `/v1/runtime/status`:
  - `everCore.configured: true`, `enabled: true`, `mode: "managed"`, `url: "http://127.0.0.1:53922/"` — but
  - `everCore.healthy: false`, `everCore.errorCode: "EVERCORE_MANAGED_HEALTH_CHECK_FAILED"`,
  - `everCore.sidecar.running: false`, `sidecar.healthy: false`, `sidecar.errorCode: "EVERCORE_MANAGED_HEALTH_CHECK_FAILED"`,
  - `everCore.sidecar.errorMessage: "EverCore sidecar exited before healthy: code=1 signal=null."`
- `POST /v1/runtime/memory/search {"query":"…","topK":2}` returns `{ type: "error", code: "EVERCORE_MEMORY_UNAVAILABLE", message: "Long-term memory is not available for this runtime." }`.
- `GET /v1/runtime/memory/status` reports `capability.available: false`, `capability.longTermMemory: false`.

### LLM passthrough chain — **verified intact (2026-07-01)**

A diagnostic script invoking `configureEverCore` with a custom `managedSpawn` hook captured the exact env passed to the `everos` child:

```
providerSettings (ConfigManager.resolveSettings):
  providerId=minimax, modelId=minimax/MiniMax-M3,
  apiKey=<125 chars>, baseUrl=https://api.minimaxi.com/anthropic,
  apiKeySource=provider_config, baseUrlSource=provider_config

resolved EverCoreConfigInput:
  mode=managed, hasProviderSettings=true,
  managedCommand=<dataDir>/.venv/bin/everos, managedDataDir=<dataDir>,
  hasManagedLlmApiKey=false (no BABEL_O_EVERCORE_LLM_* set)

EVEROS_* env passed to sidecar (passthrough proof):
  EVEROS_LLM__PROTOCOL  = <20 chars>   # anthropic-compatible
  EVEROS_LLM__API_KEY   = <125 chars>  # from providerSettings.apiKey
  EVEROS_LLM__BASE_URL  = <34 chars>   # https://api.minimaxi.com/anthropic
  EVEROS_LLM__MODEL     = <10 chars>   # MiniMax-M3
  EVEROS_MEMORY__ROOT   = <dataDir>
  EVEROS_API__HOST/PORT = set
```

The intended chain (`server.ts:73` → `everCoreRuntimeManager.acquireFromEnv` → `everCoreConfig.resolveEverCoreConfigInputFromEnv` → `applyEverOSBootstrapDefaults` → `configureEverCore` → `resolveManagedEverCoreLlmConfig` → `everCoreSidecar.buildEverCoreLlmEnv`) **works**. `applyEverOSBootstrapDefaults` does **not** drop `providerSettings` — `{...defaults.input, ...input}` preserves it (`defaults.input` only carries `mode/managedCommand/managedDataDir/mcpToolsEnabled`). The 2026-06-30 hypothesis (a), the `mode: 'managed'` bypass (b), and the `CacheEntry` stale-on-first-start (c) are all **disproven**: on `server.ts` startup `defaultEverCoreRuntimeManager.entry` is empty, so `configure(input)` runs fresh; `mode==='managed'` does call `resolveManagedEverCoreLlmConfig(input)` (`everCoreConfig.ts:184`); and `getProvider('minimax')` returns `adapter: 'anthropic-compatible'` without throwing.

### Real root cause — captured sidecar stderr

The same diagnostic captured the sidecar's stderr (possible because the hook swapped `stdio: 'ignore'` for `stdio: ['ignore','pipe','pipe']`):

```
Error: /Users/tangyaoyue/.everos/everos.toml not found.
Run `everos init` first to create configuration files.
```

Two concrete defects combine to produce this:

1. **`bbl memory setup` (`everosBootstrap`) never runs `everos init`.** It builds the `everos` binary and records `dataDir`, but `~/.everos/` does not exist and `<dataDir>/everos.toml` is never created. (`<dataDir>/ome.toml` exists, but it is materialised by `MemoryRoot.ensure()` at server start — it is the OME strategy override file, not the main `everos.toml`.)
2. **`everCoreSidecar.ts:179` spawns `everos server start` without `--root <dataDir>` and without `EVEROS_ROOT` env.** It sets `EVEROS_MEMORY__ROOT=<dataDir>`, but `everos server start --help` shows the memory-root and the config-root are different knobs — `--root` / `EVEROS_ROOT` resolves the config root (default `~/.everos`), where `everos` looks for `everos.toml`. So `everos` looks in `~/.everos/`, finds nothing, and exits `code=1` **before any LLM/embedding lifespan runs**.

`everos init --root <dir>` writes `<dir>/everos.toml`; `everos server start --root <dir>` reads from `<dir>` (env: `EVEROS_ROOT`). Both honour `--root`, so the fix is to make init and spawn agree on `<dataDir>`.

### Second-order gap — embedding (will surface after the init gap is fixed)

Even after `everos.toml` exists, the sidecar is expected to die in the embedding lifespan. `everos init --print` shows the `[embedding]` template has **no shipped default** — "model / api_key / base_url have no shipped defaults — must be set (env or user toml) before the embedding capability is used." `buildEverCoreLlmEnv` only sets `EVEROS_LLM__*`; it does **not** set `EVEROS_EMBEDDING__*`. The MiniMax provider does not offer an embedding endpoint, so the embedding source is a **product decision** (local ollama / cloud / user-supplied), not a pure-code fix. This is scoped as Phase 4 and requires explicit owner input before implementation.

### Why the three reporting surfaces disagree

- `bbl memory status` (CLI): "ready" — sourced from `~/.babel-o/everos-bootstrap.json` `buildStatus`, which only reflects binary build success, not sidecar runnability.
- `bbl doctor --memory-only`: "ready" / "configured: yes" — also bootstrap-sourced.
- `GET /v1/runtime/status` `everCore.healthy: false` — the only honest runtime surface, but the CLI surfaces never call it.
- `GET /v1/runtime/memory/status` `capability.longTermMemory: false` — downstream of the same dead `memoryProvider`.

The operator cannot tell from the CLI whether long-term memory is actually working. They have to either `bbl nexus start` themselves and probe `/v1/runtime/memory/status`, or notice that the model is silently dropping recall requests.

## Problem Statement

The memory subsystem in `reference/memory-governance-plan.md` is documented as ready and validated, but the operator-visible path is broken: the managed sidecar cannot start, `memory_search` returns `EVERCORE_MEMORY_UNAVAILABLE`, `capability.longTermMemory: false`. The 2026-06-30 draft attributed this to an LLM passthrough break; **2026-07-01 live capture disproved that** — `EVEROS_LLM__*` is correctly injected, and the real failure is `everos init` never running + the spawner not passing `--root`. The `stdio: 'ignore'` setting hid the real error and produced the misdiagnosis. This violates two governance principles:

- "Memory capability block" contract: `memory-governance-plan.md` promises memory is capability-aware, but `longTermMemory: false` is the runtime truth the user sees.
- "Phase E live validation" claim: the documented integration that supposedly exercised the sidecar is not reproducible on a fresh bootstrap.

A new operator who follows the `bbl memory setup` flow and runs `bbl memory status` will see "ready" and assume the system works. They will only discover it does not when their `memory_search` calls return `EVERCORE_MEMORY_UNAVAILABLE`. The "ready" surface is a **misreport** and the lack of an actionable error chain is a **real bug**, not a documentation drift.

## Goals

- Reproduce the sidecar startup end-to-end against the documented config so the Phase E live validation claim becomes true again.
- Make `bbl memory status` and `bbl doctor` honest about sidecar health: report `ready` only when the sidecar is actually ready, or surface the cascading failure reason in the same surface.
- **Auto-trigger `everos init --root <dataDir>`** on sidecar startup when `<dataDir>/everos.toml` is missing, and pass `--root <dataDir>` (or `EVEROS_ROOT`) to the spawn so init and server agree on the config root. (This is the highest-leverage root cause; the LLM passthrough chain needs no change.)
- Surface cascading error reasons in `/v1/runtime/status.everCore.sidecar.lastStartupError` (typed `errorCode`) so the operator can act on the real cause (init vs embedding vs LLM). Capture the sidecar stderr instead of relying on a non-existent `everos.log`.
- Keep the changes inside the **sidecar lifecycle + status-reporting** scope. Do not redesign the memory abstraction, the `MemoryProvider` interface, the save/recall governance, or the cache observability.

## Non-goals

- Do not change `MemoryProvider` / `NoopMemoryProvider` / `EverCoreMemoryProvider` interfaces or the search/format logic in `src/runtime/memoryProvider.ts`.
- Do not change the candidate governance or the `memory_search` / `memory_save_note` / `memory_flush_session` MCP tool behavior in `src/tools/everCoreMcpTools.ts`.
- Do not change cache observability scope (`cache-observability-and-nexus-realtime-detection-plan.md`).
- Do not change soft-recoverable-timeout semantics (`runtime-tool-loop-governance-plan.md` + `development-process-stability-governance-plan.md`).
- Do not add new model providers or change provider adapter mapping; the LLM passthrough fix is a no-op (it already works).
- Do not change the sidecar managed-process model (subprocess + health probe) — the fix is in the config-root + init + stderr-capture chain, not in the process lifecycle.
- Do not introduce a new testing approach; use the existing `test/everCoreMcpTools.test.ts` + `test/sidecar*.test.ts` style (or add new ones in the same style).

## Design

### Phase 1 — Reproduce the documented live validation, then add a regression test

1. Run a clean repro on the current develop branch (done 2026-07-01; see Current State). Capture the sidecar stderr as the regression evidence — the failure is `everos.toml not found`, **not** `LLMNotConfiguredError`.
2. Add `test/evercore-sidecar-live.test.ts` (or extend `test/everCoreMcpTools.test.ts`) that:
   - Drives `configureEverCore` with a custom `managedSpawn` that captures stderr (mirrors the 2026-07-01 diagnostic).
   - Asserts that **without** the Phase 2 fix, the sidecar fails with a **typed** `errorCode` matching the captured stderr (`EVERCORE_MANAGED_INIT_NOT_RUN`), not the generic `EVERCORE_MANAGED_HEALTH_CHECK_FAILED`.
   - Asserts that **with** the Phase 2 fix (auto-init + `--root`), the sidecar progresses past the init layer and either becomes healthy or fails with `EVERCORE_MANAGED_EMBEDDING_NOT_CONFIGURED` (Phase 4 gap).
   - Skips automatically with `npm run test:quarantine` if a real `everos` binary is not available.

### Phase 2 — Auto-init `everos.toml` + pass `--root` (highest-leverage root cause)

The LLM passthrough chain needs no change (verified intact). The real fix is config-root consistency:

1. In `src/nexus/everCoreSidecar.ts`, **before** spawning `everos server start`, check `<dataDir>/everos.toml` existence. If missing, run `everos init --root <dataDir> --force` via the same spawn mechanism. Record the init result; if init fails, populate `sidecarStatus.lastStartupError` with `errorCode: EVERCORE_MANAGED_INIT_NOT_RUN` and skip the server spawn.
2. Pass `--root <dataDir>` to the `everos server start` args (or set `EVEROS_ROOT=<dataDir>` in the spawn env) so the server reads the same `<dataDir>/everos.toml` that init wrote. Today the spawn only sets `EVEROS_MEMORY__ROOT`, which is a different knob.
3. Unit test `test/evercore-config-passthrough.test.ts` (new) asserts the passthrough is intact (regression guard against re-introducing the disproven hypothesis):
   - With `BABEL_O_EVERCORE_MODE=managed` and no `BABEL_O_EVERCORE_LLM_*` set, but `providerSettings` set to `minimax`, `resolveManagedEverCoreLlmConfig({ providerSettings, ... })` returns `{ protocol: 'anthropic-compatible', apiKey, baseUrl, model }`.
   - The spawn args include `--root <dataDir>` and the env includes `EVEROS_ROOT=<dataDir>` (or equivalent).
   - When `<dataDir>/everos.toml` is missing, the spawner invokes `everos init --root <dataDir> --force` before `everos server start`.

### Phase 3 — Capture sidecar stderr as typed `lastStartupError`

`dataDir/everos.log` does not exist (`stdio: 'ignore'` discards the child's output and `everos` does not write a log file there). The 2026-06-30 draft's "tail `dataDir/everos.log`" step is **not viable**; capture stderr instead.

1. In `everCoreSidecar.ts`, change the spawn `stdio` from `'ignore'` to `['ignore', 'pipe', 'pipe']` (or pipe stderr only) and collect the child's stderr into a bounded buffer.
2. When the sidecar exits with `code=1` within the startup timeout, match the captured stderr against known cascade signatures and populate `sidecarStatus.lastStartupError` with a typed `errorCode`:
   - `everos.toml not found` / `Run 'everos init' first` → `EVERCORE_MANAGED_INIT_NOT_RUN`
   - `Embedding model is not configured` → `EVERCORE_MANAGED_EMBEDDING_NOT_CONFIGURED`
   - `LLMNotConfiguredError` → `EVERCORE_MANAGED_LLM_NOT_CONFIGURED`
3. Expose `lastStartupError` through `GET /v1/runtime/status.everCore.sidecar` so the operator can see the actual reason. Keep the raw stderr out of the public surface (it may contain paths/config hints); expose only the typed `errorCode` + a short, safe `errorMessage`.
4. The custom `spawn` hook (`managedSpawn`) already lets tests inject a fake child; extend the existing `EverCoreSpawn` type so the pipe + stderr-collection path is testable without a real `everos`.

### Phase 4 — Make CLI status surfaces honest

1. In `src/cli/commands/memory.ts` (the `bbl memory status` handler) and `src/cli/commands/doctor.ts` (the memory section), probe the sidecar's actual health instead of echoing `bootstrap.buildStatus`. Either call `/v1/runtime/memory/status` against a running nexus, or read `sidecar-registry.json` + `fetchHealth` directly.
2. Display `mode: ready, sidecar: <healthy | unhealthy: <errorCode>>` instead of just `mode: ready`. When no nexus is running and the registry is absent/stale, say so explicitly — do **not** report "ready" from build status alone.

### Phase 5 — Embedding config (✅ done, commit `9fec83e`)

Implemented as a backend-agnostic config surface (no hard lock-in to ollama/cloud):

1. `buildEverCoreEmbeddingEnv` in `everCoreSidecar.ts` injects `EVEROS_EMBEDDING__{MODEL,API_KEY,BASE_URL}` into the spawn env (mirrors `buildEverCoreLlmEnv`). EverOS' `EmbeddingSettings` is OpenAI-compatible and requires all three at lifespan startup.
2. `managedEmbeddingModel/ApiKey/BaseUrl` on `EverCoreConfigInput` (read from `BABEL_O_EVERCORE_EMBEDDING_*` env); `resolveManagedEverCoreEmbeddingConfig` is **explicit-only** — no `providerSettings` fallback, because MiniMax (and most chat-only providers) expose no embedding endpoint.
3. `embeddingPassthrough { source: 'ollama' | 'custom', model?, baseUrl? }` on `EverOSBootstrapState` is the primary source for `bbl memory setup`-driven config; `applyEverOSBootstrapDefaults` injects `managedEmbedding*` from it. The apiKey is deliberately **not** persisted: ollama re-derives the non-secret literal `'ollama'`; custom expects `BABEL_O_EVERCORE_EMBEDDING_API_KEY` env at runtime (no plaintext cloud secret in bootstrap state).
4. `bbl memory setup` prompts for the source (ollama recommended / custom / skip) on fresh setup **and** on an already-ready machine missing embedding; `bbl memory status` prints the config or a `not configured — run bbl memory setup` fix hint.

Live verification (2026-07-01): the real `everos` binary reaches `/health` = healthy with LLM + embedding env present, closing the `EVERCORE_MANAGED_EMBEDDING_NOT_CONFIGURED` cascade. A full `memory_search` round-trip still needs a real embedding endpoint (ollama/cloud) — that is the operator/CI step documented in `DONE.md`, not a code gap.

### Phase 6 — Promote the Phase E live-validation claim to be reproducible (✅ done)

1. `test/memory-live-smoke.test.ts` + `npm run test:memory-live` (env-gated by `BABEL_O_RUN_MEMORY_LIVE_SMOKE=1`, non-default — mirrors `test:go-tui:smoke`) drive the real `everos` binary (located via the local bootstrap state) in a temp dataDir and assert the sidecar reaches `/health` with stubbed LLM + embedding env. This is the deterministic tier guarding the cascade closed by Phases 2-5. Verified: `ok 1` with the gate set, `skipped 1` without.
2. This plan graduates `proposals/` → `reference/` per [decisions/0001-documentation-lifecycle.md](../decisions/0001-documentation-lifecycle.md); `memory-governance-plan.md` cross-references the smoke tier and the graduated plan.
3. The 2026-06-30 passthrough-break hypothesis is explicitly disproven in Current State above and in `DONE.md`.

## Phases

| Phase | Status | Scope | Exit criteria |
| --- | --- | --- | --- |
| Phase 1 | ✅ Done (2026-07-01) | Reproduce + regression test. | The 2026-07-01 live capture (sidecar stderr = `everos.toml not found`) is recorded under Current State; `test/runtime.test.ts` asserts the typed `errorCode` (`EVERCORE_MANAGED_INIT_NOT_RUN` / `EVERCORE_MANAGED_EMBEDDING_NOT_CONFIGURED`) rather than the generic `EVERCORE_MANAGED_HEALTH_CHECK_FAILED`. |
| Phase 2 | ✅ Done (commit `9d3c5d0`) | Auto-init `everos.toml` + pass `--root`. | `everCoreSidecar.ts` runs `everos init --root <dataDir> --force` when `everos.toml` is missing and spawns `everos server start --root <dataDir>`; `test/runtime.test.ts` asserts `--root` in args, `EVEROS_ROOT=<dataDir>` in env, and the init run. |
| Phase 3 | ✅ Done (commit `9d3c5d0`) | Capture sidecar stderr as typed `lastStartupError`. | `stdio` is `['ignore','pipe','pipe']`; `classifySidecarStartupError` maps the captured output to typed `errorCode`s; `sidecarStatus.lastStartupError` carries them; raw stderr is truncated (tail 400, ANSI-stripped) and not leaked verbatim. |
| Phase 4 | ✅ Done (commit `d464b9d`) | CLI status surfaces honest. | `bbl memory status` and `bbl doctor --memory-only` probe `sidecar-registry.json` + `/health` (`probeEverCoreSidecarHealth`) and print `sidecar: <healthy \| unhealthy \| not_running>` instead of echoing `buildStatus`. |
| Phase 5 | ✅ Done (commit `9fec83e`) | Embedding config. | `buildEverCoreEmbeddingEnv` injects `EVEROS_EMBEDDING__{MODEL,API_KEY,BASE_URL}`; `embeddingPassthrough` (source `ollama` \| `custom`, no persisted apiKey) is injected by `applyEverOSBootstrapDefaults`; `bbl memory setup` prompts for the source. Live: the real sidecar reaches `/health` with embedding env present. |
| Phase 6 | ✅ Done (this graduation) | Promote Phase E claim to be reproducible. | `npm run test:memory-live` runs the cascade end-to-end against the real `everos` binary in a temp dataDir and asserts `/health` (env-gated, non-default); this plan graduates `proposals/` → `reference/`; `memory-governance-plan.md` cross-references the smoke tier. |

## Verification

- `npm test` (existing memory + sidecar regressions green).
- New `test/evercore-config-passthrough.test.ts` + `test/evercore-sidecar-live.test.ts` (the latter in `test/quarantine.json` if it requires a real `everos` bootstrap).
- `npm run typecheck` + `npm run format:check` + `npm run docs:check` clean.
- Manual repro (Phase 1 + 6): documented in `DONE.md` with exact commands + outputs, including the captured sidecar stderr.

## PR granularity

Per [development-process-stability-governance-plan.md](./development-process-stability-governance-plan.md) §6.1, this is **`review-standard`** (no runtime state machine change; only sidecar startup pre-check, config-root wiring, stderr capture, and status surfacing). Commits, one Phase each (Phase 5 gated on owner input):

- `chore(memory): reproduce sidecar live validation + add regression test` (Phase 1)
- `fix(evercore): auto-init everos.toml + pass --root to sidecar spawn` (Phase 2)
- `feat(evercore): capture sidecar stderr as typed lastStartupError errorCode` (Phase 3)
- `fix(memory): bbl memory status / doctor reflect sidecar health not bootstrap` (Phase 4)
- `feat(evercore): embedding config passthrough + bootstrap prompt` (Phase 5, gated)
- `docs(memory): promote Phase E live-validation claim to smoke test` (Phase 6)

## Document Ownership

- Current priority lives in [../TODO.md](../TODO.md) and [../active/TODO_runtime.md](../active/TODO_runtime.md).
- Completed facts move to [../DONE.md](../DONE.md); factual history to [../WORK_LOG.md](../WORK_LOG.md).
- When Phase 1-4 + 6 close (Phase 5 tracked separately), this plan graduates from `proposals/` to `reference/` per [decisions/0001-documentation-lifecycle.md](../decisions/0001-documentation-lifecycle.md) §Decision, and the canonical memory governance owner ([memory-governance-plan.md](./memory-governance-plan.md)) absorbs the live-validation ownership — the graduated plan stays as the **reproducibility follow-up** for as long as the memory subsystem has any operational risk worth tracking in a dedicated doc.

## 中文概述

### 背景

`reference/memory-governance-plan.md` 标 Phase E/F "EverCore + Provider Protocol Convergence 已完成首轮 live validation"，但 2026-06-30 真实复现失败：`bbl nexus start` 后 managed sidecar 启动即死 (`EVERCORE_MANAGED_HEALTH_CHECK_FAILED`)，`memory_search` 返回 `EVERCORE_MEMORY_UNAVAILABLE`，`capability.longTermMemory: false`。三个报告面（`bbl memory status` / `bbl doctor` / `/v1/runtime/status.everCore`）都报 "ready" / "configured: yes"，但 sidecar 实际未存活 —— 误报而非文档漂移。

### 根因订正（2026-07-01 实测）

2026-06-30 草案臆断 "LLM passthrough 链断了（`providerSettings` 在某处丢失）"。**2026-07-01 用自定义 `managedSpawn` 钩子捕获了 sidecar 实际 env 与 stderr，推翻该假设**：

- **passthrough 链完全正常**：`EVEROS_LLM__PROTOCOL/API_KEY/BASE_URL/MODEL` 全部正确注入 sidecar（minimax → anthropic-compatible，apiKey 125 chars）。`applyEverOSBootstrapDefaults` 没丢 `providerSettings`；`mode: 'managed'` 没绕过 `resolveManagedEverCoreLlmConfig`；首次启动无 stale cache。
- **真正根因**：sidecar stderr = `Error: /Users/tangyaoyue/.everos/everos.toml not found. Run 'everos init' first.`。两个缺陷叠加：(1) `bbl memory setup` 从未跑 `everos init`，`~/.everos/` 与 `<dataDir>` 都没 `everos.toml`；(2) `everCoreSidecar.ts:179` spawn `everos server start` 既没传 `--root <dataDir>` 也没设 `EVEROS_ROOT`（只设了 `EVEROS_MEMORY__ROOT`，是不同的 knob），所以 everos 用默认 `~/.everos/`，找不到配置就 `code=1` 退出，**根本到不了 LLM/embedding lifespan**。
- **第二层（修好 init 后暴露）**：`everos init --print` 显示 `[embedding]` 段无默认值，`buildEverCoreLlmEnv` 不设 `EVEROS_EMBEDDING__*`，minimax 不提供 embedding —— embedding 来源是产品决策，需 owner 拍板。
- **`stdio: 'ignore'` 吞掉了 stderr**，导致 2026-06-30 只看到 `code=1` 就误判为 passthrough 断裂。`dataDir/everos.log` 不存在，草案"tail everos.log"方案不可行，改为捕获 stderr。

### 核心做法

六 Phase：(1) 真实复现 + 回归测试（断言 typed `errorCode` = `EVERCORE_MANAGED_INIT_NOT_RUN`，而非 LLM）；(2) sidecar spawn 前自动 `everos init --root <dataDir> --force` + spawn 传 `--root <dataDir>`（**核心修复，passthrough 不动**）；(3) `stdio` 改 pipe 捕获 stderr，匹配 cascade 签名填 typed `errorCode` + `lastStartupError`，经 `/v1/runtime/status` 暴露；(4) `bbl memory status` / `bbl doctor` 探测 sidecar 真实健康而非 bootstrap build 状态；(5) embedding 配置（**需 owner 决策 embedding 来源**，gated）；(6) Phase E "live validation" 改为可重放的 `test:memory-live` smoke，plan 毕业到 `reference/`。

### 当前状态

**已毕业（2026-07-01）**：六 Phase 全部落地并验证。commits：`9d3c5d0`（Phase 2+3 auto-init + `--root` + stderr 捕获）、`d464b9d`（Phase 4 CLI 状态诚实）、`9fec83e`（Phase 5 embedding 透传 + setup 提示）、本 graduation（Phase 6 smoke tier + 毕业到 `reference/`）。live 验证：真实 `everos` 二进制在 LLM + embedding env 齐备时到达 `/health`=healthy；`npm run test:memory-live`（env-gated）跑通全 cascade。全量测试 1236/1236，typecheck/format/layer-audit 全绿。

### 下一步

Plan 已毕业到 `reference/`，live-validation 归属让给 `memory-governance-plan.md`，本 plan 留作 sidecar lifecycle 的**复现性 follow-up**。唯一未闭环：`memory_search` 全链路 round-trip 需真实 embedding 端点（ollama/cloud），属 operator/CI 步骤（见 `DONE.md`），非代码缺口。
