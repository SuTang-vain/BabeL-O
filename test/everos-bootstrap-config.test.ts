import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { resolveEverCoreConfigInputFromEnv } from '../src/nexus/everCoreConfig.js'
import { hasExplicitEverCoreEnv, loadEverOSBootstrapDefaults } from '../src/nexus/everosBootstrapConfig.js'
import { createEverOSBootstrapState, updateEverOSBootstrapState } from '../src/shared/everosBootstrapStore.js'

function makeEnv(): { env: NodeJS.ProcessEnv; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'babel-o-everos-bootstrap-config-'))
  const env = {
    BABEL_O_CONFIG_FILE: join(dir, 'config.json'),
    BABEL_O_EVEROS_BOOTSTRAP_FILE: join(dir, 'everos-bootstrap.json'),
  } as NodeJS.ProcessEnv
  return { env, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('EverOS bootstrap ready state synthesizes managed EverCore defaults', async () => {
  const { env, cleanup } = makeEnv()
  try {
    await updateEverOSBootstrapState(() => createEverOSBootstrapState({
      optedIn: true,
      buildStatus: 'ready',
      managedCommand: '/tmp/everos',
      dataDir: '/tmp/everos-data',
    }), { env })

    const defaults = loadEverOSBootstrapDefaults(env)
    assert.equal(defaults?.input.mode, 'managed')
    assert.equal(defaults?.input.managedCommand, '/tmp/everos')
    assert.equal(defaults?.input.managedDataDir, '/tmp/everos-data')

    const input = resolveEverCoreConfigInputFromEnv(env)
    assert.equal(input.mode, 'managed')
    assert.equal(input.managedCommand, '/tmp/everos')
    assert.equal(input.managedDataDir, '/tmp/everos-data')
  } finally {
    cleanup()
  }
})

test('explicit EverCore env wins over ready bootstrap state', async () => {
  const { env, cleanup } = makeEnv()
  try {
    await updateEverOSBootstrapState(() => createEverOSBootstrapState({
      optedIn: true,
      buildStatus: 'ready',
      managedCommand: '/tmp/everos',
      dataDir: '/tmp/everos-data',
    }), { env })

    const explicit = { ...env, BABEL_O_EVERCORE_MODE: 'external', BABEL_O_EVERCORE_BASE_URL: 'http://127.0.0.1:9000' }
    assert.equal(hasExplicitEverCoreEnv(explicit), true)
    assert.equal(loadEverOSBootstrapDefaults(explicit), undefined)
    const input = resolveEverCoreConfigInputFromEnv(explicit)
    assert.equal(input.mode, 'external')
    assert.equal(input.baseUrl, 'http://127.0.0.1:9000')
    assert.equal(input.managedCommand, undefined)
  } finally {
    cleanup()
  }
})

test('ollama embeddingPassthrough injects managedEmbedding* with builtin apiKey', async () => {
  const { env, cleanup } = makeEnv()
  try {
    await updateEverOSBootstrapState(() => createEverOSBootstrapState({
      optedIn: true,
      buildStatus: 'ready',
      managedCommand: '/tmp/everos',
      dataDir: '/tmp/everos-data',
      embeddingPassthrough: { source: 'ollama', model: 'bge-m3', baseUrl: 'http://localhost:11434/v1' },
    }), { env })

    const defaults = loadEverOSBootstrapDefaults(env)
    assert.equal(defaults?.input.managedEmbeddingModel, 'bge-m3')
    assert.equal(defaults?.input.managedEmbeddingBaseUrl, 'http://localhost:11434/v1')
    // ollama's apiKey is the non-secret literal, re-derived at inject time.
    assert.equal(defaults?.input.managedEmbeddingApiKey, 'ollama')

    const input = resolveEverCoreConfigInputFromEnv(env)
    assert.equal(input.managedEmbeddingModel, 'bge-m3')
    assert.equal(input.managedEmbeddingBaseUrl, 'http://localhost:11434/v1')
    assert.equal(input.managedEmbeddingApiKey, 'ollama')
  } finally {
    cleanup()
  }
})

test('custom embeddingPassthrough leaves apiKey to env (not persisted)', async () => {
  const { env, cleanup } = makeEnv()
  try {
    await updateEverOSBootstrapState(() => createEverOSBootstrapState({
      optedIn: true,
      buildStatus: 'ready',
      managedCommand: '/tmp/everos',
      dataDir: '/tmp/everos-data',
      embeddingPassthrough: { source: 'custom', model: 'text-embedding-3-small', baseUrl: 'https://api.openai.com/v1' },
    }), { env })

    const defaults = loadEverOSBootstrapDefaults(env)
    assert.equal(defaults?.input.managedEmbeddingModel, 'text-embedding-3-small')
    assert.equal(defaults?.input.managedEmbeddingBaseUrl, 'https://api.openai.com/v1')
    // Custom source must NOT synthesize an apiKey — the operator supplies
    // BABEL_O_EVERCORE_EMBEDDING_API_KEY at runtime (no plaintext secret).
    assert.equal(defaults?.input.managedEmbeddingApiKey, undefined)

    // Env override wins over the persisted model/baseUrl.
    const withEnv = { ...env, BABEL_O_EVERCORE_EMBEDDING_MODEL: 'override-model', BABEL_O_EVERCORE_EMBEDDING_API_KEY: 'sk-from-env' }
    const input = resolveEverCoreConfigInputFromEnv(withEnv)
    assert.equal(input.managedEmbeddingModel, 'override-model')
    assert.equal(input.managedEmbeddingApiKey, 'sk-from-env')
    assert.equal(input.managedEmbeddingBaseUrl, 'https://api.openai.com/v1')
  } finally {
    cleanup()
  }
})

test('failed and opted-out bootstrap states do not enable EverCore', async () => {  const { env, cleanup } = makeEnv()
  try {
    await updateEverOSBootstrapState(() => createEverOSBootstrapState({
      optedOut: true,
      buildStatus: 'opted_out',
    }), { env })
    assert.equal(loadEverOSBootstrapDefaults(env), undefined)
    assert.equal(resolveEverCoreConfigInputFromEnv(env).mode, undefined)

    await updateEverOSBootstrapState(() => createEverOSBootstrapState({
      optedIn: true,
      buildStatus: 'failed',
      errorCode: 'EVEROS_BOOTSTRAP_BUILD_FAILED',
      errorMessage: 'boom',
    }), { env })
    assert.equal(loadEverOSBootstrapDefaults(env), undefined)
    assert.equal(resolveEverCoreConfigInputFromEnv(env).mode, undefined)
  } finally {
    cleanup()
  }
})
