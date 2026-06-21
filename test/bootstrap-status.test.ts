import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildEverCoreStatus, buildEverOSBootstrapStatus } from '../src/nexus/bootstrapStatus.js'
import {
  createEverOSBootstrapState,
  EVEROS_BOOTSTRAP_FILE_ENV,
  updateEverOSBootstrapState,
} from '../src/shared/everosBootstrapStore.js'
import type { EverCoreStatus } from '../src/nexus/everCoreConfig.js'

function makeEnv(): { env: NodeJS.ProcessEnv; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'babel-o-bootstrap-status-'))
  const env = {
    BABEL_O_CONFIG_FILE: join(dir, 'config.json'),
    [EVEROS_BOOTSTRAP_FILE_ENV]: join(dir, 'everos-bootstrap.json'),
  } as NodeJS.ProcessEnv
  return { env, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('buildEverCoreStatus returns the override reference when one is provided', () => {
  const override: EverCoreStatus = {
    configured: true,
    enabled: true,
    healthy: true,
    mode: 'managed',
    uploadOnSessionEnd: true,
    mcpToolsEnabled: false,
    namespace: {
      layer: 'project_memory',
      isolationKey: 'projectId',
      sessionScoped: false,
      projectIdSource: 'default',
    },
  }
  const fn = buildEverCoreStatus(override)
  const a = fn()
  const b = fn()
  // The override case is a reference return — every call must return
  // the exact same object instance, not a clone.
  assert.equal(a, override)
  assert.equal(b, override)
})

test('buildEverCoreStatus returns the disabled default when no override is given', () => {
  const fn = buildEverCoreStatus()
  const snap = fn()
  assert.equal(snap.configured, false)
  assert.equal(snap.enabled, false)
  assert.equal(snap.healthy, true)
  assert.equal(snap.mode, 'disabled')
  assert.equal(snap.uploadOnSessionEnd, false)
  assert.equal(snap.mcpToolsEnabled, false)
  assert.equal(snap.namespace?.layer, 'project_memory')
  assert.equal(snap.namespace?.isolationKey, 'projectId')
})

test('buildEverOSBootstrapStatus returns not_configured when the bootstrap file does not exist', () => {
  const { env, cleanup } = makeEnv()
  try {
    // No file written — readEverOSBootstrapStateSync should return ok=true / exists=false.
    const fn = buildEverOSBootstrapStatus()
    // We can't pass env into the factory (it reads the global env at call time),
    // so we exercise the synchronous read with the env override by setting
    // process.env during the test instead.
    const prev = process.env[EVEROS_BOOTSTRAP_FILE_ENV]
    process.env[EVEROS_BOOTSTRAP_FILE_ENV] = env[EVEROS_BOOTSTRAP_FILE_ENV]
    try {
      const snap = fn()
      assert.equal(snap.configured, false)
      assert.equal(snap.status, 'not_configured')
      assert.equal(typeof snap.path, 'string')
    } finally {
      if (prev === undefined) {
        delete process.env[EVEROS_BOOTSTRAP_FILE_ENV]
      } else {
        process.env[EVEROS_BOOTSTRAP_FILE_ENV] = prev
      }
    }
  } finally {
    cleanup()
  }
})

test('buildEverOSBootstrapStatus returns invalid when the bootstrap file is malformed', () => {
  const { env, cleanup } = makeEnv()
  try {
    // Write a malformed JSON file so parseEverOSBootstrapState surfaces an error.
    writeFileSync(env[EVEROS_BOOTSTRAP_FILE_ENV] as string, '{ this is not valid json')

    const fn = buildEverOSBootstrapStatus()
    const prev = process.env[EVEROS_BOOTSTRAP_FILE_ENV]
    process.env[EVEROS_BOOTSTRAP_FILE_ENV] = env[EVEROS_BOOTSTRAP_FILE_ENV]
    try {
      const snap = fn()
      assert.equal(snap.configured, false)
      assert.equal(snap.status, 'invalid')
      assert.equal(snap.errorCode, 'EVEROS_BOOTSTRAP_STATE_INVALID')
      assert.equal(typeof snap.errorMessage, 'string')
    } finally {
      if (prev === undefined) {
        delete process.env[EVEROS_BOOTSTRAP_FILE_ENV]
      } else {
        process.env[EVEROS_BOOTSTRAP_FILE_ENV] = prev
      }
    }
  } finally {
    cleanup()
  }
})

test('buildEverOSBootstrapStatus returns configured snapshot when bootstrap state is ready', async () => {
  const { env, cleanup } = makeEnv()
  try {
    await updateEverOSBootstrapState(() => createEverOSBootstrapState({
      optedIn: true,
      buildStatus: 'ready',
      managedCommand: '/tmp/everos',
      dataDir: '/tmp/everos-data',
      sourceRepo: 'git@example.com:babel-o/everos.git',
      sourceRef: 'main',
    }), { env })

    const fn = buildEverOSBootstrapStatus()
    const prev = process.env[EVEROS_BOOTSTRAP_FILE_ENV]
    process.env[EVEROS_BOOTSTRAP_FILE_ENV] = env[EVEROS_BOOTSTRAP_FILE_ENV]
    try {
      const snap = fn()
      assert.equal(snap.configured, true)
      assert.equal(snap.status, 'ready')
      assert.equal(snap.optedIn, true)
      assert.equal(snap.managedCommand, '/tmp/everos')
      assert.equal(snap.dataDir, '/tmp/everos-data')
      assert.equal(snap.sourceRepo, 'git@example.com:babel-o/everos.git')
      assert.equal(snap.sourceRef, 'main')
    } finally {
      if (prev === undefined) {
        delete process.env[EVEROS_BOOTSTRAP_FILE_ENV]
      } else {
        process.env[EVEROS_BOOTSTRAP_FILE_ENV] = prev
      }
    }
  } finally {
    cleanup()
  }
})
