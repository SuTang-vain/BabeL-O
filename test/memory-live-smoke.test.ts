import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configureEverCore } from '../src/nexus/everCoreConfig.js'
import { readEverOSBootstrapStateSync } from '../src/shared/everosBootstrapStore.js'

/**
 * Phase 6 live-validation smoke tier.
 *
 * Gated by `BABEL_O_RUN_MEMORY_LIVE_SMOKE=1` so it is opt-in (not in the
 * default `npm test` path) — mirrors `test:go-tui:smoke`. It drives the
 * full managed-sidecar startup cascade against the REAL `everos` binary
 * located via the local bootstrap state, in a temp dataDir:
 *
 *   1. `everos init --root <tempDataDir>` (Fix A, auto) writes everos.toml
 *   2. `everos server start --root <tempDataDir>` (Fix A) reads it
 *   3. `EVEROS_LLM__*` (passthrough intact) + `EVEROS_EMBEDDING__*`
 *      (Fix B) reach the child env
 *   4. `/health` returns 200 → sidecar healthy (cascade closed)
 *
 * LLM + embedding endpoints are STUBBED: the EverOS lifespan validates
 * config presence, not connectivity, so `/health` passes without real
 * keys/endpoints. This is the deterministic tier that guards the cascade
 * closed by the `evercore-managed-sidecar-live-validation-and-config-
 * passthrough-plan`. A full `memory_search` round-trip needs a real
 * embedding endpoint (local ollama / cloud) and is an operator/CI step
 * documented in `docs/nexus/DONE.md` — set
 * `BABEL_O_EVERCORE_EMBEDDING_{MODEL,API_KEY,BASE_URL}` + real provider
 * settings to exercise it.
 *
 * Skips when the gate is unset OR the `everos` binary is not bootstrapped.
 */

const RUN = process.env.BABEL_O_RUN_MEMORY_LIVE_SMOKE === '1'
const bootstrap = readEverOSBootstrapStateSync()
const bootstrapped = Boolean(
  bootstrap.ok && bootstrap.state?.buildStatus === 'ready' && bootstrap.state.managedCommand,
)
const skipReason = !RUN
  ? 'set BABEL_O_RUN_MEMORY_LIVE_SMOKE=1 to opt in'
  : !bootstrapped
    ? 'everos binary not bootstrapped — run `bbl memory setup`'
    : undefined

test('memory-live: managed sidecar reaches /health (init + --root + LLM + embedding cascade closed)', { skip: skipReason ?? false }, async () => {
  const managedCommand = bootstrap.ok ? bootstrap.state?.managedCommand : undefined
  if (!managedCommand) {
    throw new Error('everos managedCommand missing despite bootstrap check')
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'babel-o-memory-live-'))
  try {
    const configured = await configureEverCore({
      mode: 'managed',
      managedCommand,
      managedDataDir: dataDir,
      managedHost: '127.0.0.1',
      managedStartupTimeoutMs: 20_000,
      managedHealthIntervalMs: 200,
      // Stub LLM (anthropic-compatible shape) — lifespan validates presence.
      managedLlmProtocol: 'anthropic-compatible',
      managedLlmApiKey: 'stub-key',
      managedLlmBaseUrl: 'https://stub.invalid/anthropic',
      managedLlmModel: 'stub-model',
      // Stub embedding endpoint — lifespan stores config; /health passes.
      managedEmbeddingModel: 'bge-m3',
      managedEmbeddingApiKey: 'stub-key',
      managedEmbeddingBaseUrl: 'http://127.0.0.1:1/v1',
    })
    try {
      assert.equal(
        configured.status.healthy,
        true,
        `sidecar not healthy: ${configured.status.errorCode ?? ''} ${configured.status.errorMessage ?? ''}`,
      )
      assert.equal(configured.status.mode, 'managed')
      assert.equal(configured.status.sidecar?.running, true)
      assert.equal(configured.status.sidecar?.lastStartupError, undefined)
    } finally {
      await configured.dispose?.()
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})
