import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  DEFAULT_EVEROS_BACKGROUND_TIMEOUT_MS,
  EVEROS_BACKGROUND_BOOTSTRAP_TIMEOUT_ENV,
  isEverOSBackgroundBootstrapInFlight,
  startEverOSBackgroundBootstrap,
} from '../src/runtime/everosBackgroundBootstrap.js'
import {
  EVEROS_BOOTSTRAP_VERSION,
  readEverOSBootstrapState,
  readEverOSBootstrapStateSync,
} from '../src/shared/everosBootstrapStore.js'

function makeTempEnv(): { env: NodeJS.ProcessEnv; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'babel-o-everos-bg-'))
  return {
    env: {
      ...process.env,
      BABEL_O_CONFIG_FILE: join(dir, 'config.json'),
      BABEL_O_EVEROS_BOOTSTRAP_FILE: join(dir, 'everos-bootstrap.json'),
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function makeFailingRunner() {
  return (command: string, _args: string[]) => {
    if (command === 'git') return Promise.resolve({ code: 127, stdout: '', stderr: 'git not found' })
    return Promise.resolve({ code: 0, stdout: '', stderr: '' })
  }
}

function makeSucceedingRunner() {
  return (command: string, _args: string[]) => {
    if (command === 'git') return Promise.resolve({ code: 0, stdout: '', stderr: '' })
    if (command === 'uv') return Promise.resolve({ code: 0, stdout: '', stderr: '' })
    return Promise.resolve({ code: 0, stdout: '', stderr: '' })
  }
}

test('background worker does not throw on failure; returns ok=false with errorCode', async () => {
  const { env, cleanup } = makeTempEnv()
  try {
    const handle = startEverOSBackgroundBootstrap({
      env,
      runner: makeFailingRunner(),
      assumeYes: true,
      nonInteractive: true,
    })
    const result = await handle.promise
    assert.equal(result.ok, false)
    assert.ok(result.errorCode)
    assert.equal(handle.settled(), true)
  } finally {
    cleanup()
  }
})

test('background worker records failed state with non-throwing errorCode on git missing', async () => {
  const { env, cleanup } = makeTempEnv()
  try {
    const handle = startEverOSBackgroundBootstrap({
      env,
      runner: makeFailingRunner(),
      assumeYes: true,
      nonInteractive: true,
    })
    const result = await handle.promise
    assert.equal(result.ok, false)
    const reread = readEverOSBootstrapStateSync({ env })
    assert.equal(reread.ok, true)
    if (!reread.ok) return
    assert.equal(reread.state?.buildStatus, 'failed')
    assert.equal(reread.state?.errorCode, 'EVEROS_BOOTSTRAP_GIT_MISSING')
    assert.equal(reread.state?.version, EVEROS_BOOTSTRAP_VERSION)
  } finally {
    cleanup()
  }
})

test('cancel() resolves the promise with a failed result and a cancel reason in errorMessage', async () => {
  const { env, cleanup } = makeTempEnv()
  try {
    const handle = startEverOSBackgroundBootstrap({
      env,
      runner: makeFailingRunner(),
      assumeYes: true,
      nonInteractive: true,
      timeoutMs: 10_000,
    })
    handle.cancel('user pressed Ctrl-C')
    const result = await handle.promise
    assert.equal(result.ok, false)
    const reread = readEverOSBootstrapStateSync({ env })
    assert.equal(reread.ok, true)
    if (!reread.ok) return
    assert.equal(reread.state?.buildStatus, 'failed')
    assert.match(reread.state?.errorMessage ?? '', /Ctrl-C|cancelled/)
  } finally {
    cleanup()
  }
})

test('cancel() is idempotent and safe after settlement', async () => {
  const { env, cleanup } = makeTempEnv()
  try {
    const handle = startEverOSBackgroundBootstrap({
      env,
      runner: makeFailingRunner(),
      assumeYes: true,
      nonInteractive: true,
    })
    await handle.promise
    handle.cancel('late cancel')
    assert.equal(handle.settled(), true)
  } finally {
    cleanup()
  }
})

test('timeout env var is respected when present', async () => {
  const { env, cleanup } = makeTempEnv()
  try {
    env[EVEROS_BACKGROUND_BOOTSTRAP_TIMEOUT_ENV] = '50'
    const handle = startEverOSBackgroundBootstrap({
      env,
      runner: async (command: string) => {
        // never-resolving runner: forces the worker to hit the
        // timeout.
        if (command === 'git') return new Promise(() => {})
        return { code: 0, stdout: '', stderr: '' }
      },
      assumeYes: true,
      nonInteractive: true,
    })
    const result = await handle.promise
    assert.equal(result.ok, false)
    const reread = readEverOSBootstrapStateSync({ env })
    assert.equal(reread.ok, true)
    if (!reread.ok) return
    assert.match(reread.state?.errorMessage ?? '', /50ms timeout/)
  } finally {
    cleanup()
  }
})

test('default timeout is 120s when no env or override is given', () => {
  assert.equal(DEFAULT_EVEROS_BACKGROUND_TIMEOUT_MS, 120_000)
})

test('isEverOSBackgroundBootstrapInFlight is false for missing state', async () => {
  const { env, cleanup } = makeTempEnv()
  try {
    assert.equal(await isEverOSBackgroundBootstrapInFlight(env), false)
  } finally {
    cleanup()
  }
})

test('isEverOSBackgroundBootstrapInFlight is true for in-flight states', async () => {
  const { env, cleanup } = makeTempEnv()
  try {
    const path = env.BABEL_O_EVEROS_BOOTSTRAP_FILE!
    writeFileSync(path, JSON.stringify({
      version: 2,
      buildStatus: 'cloning',
      lastCheckedAt: new Date().toISOString(),
    }), 'utf8')
    assert.equal(await isEverOSBackgroundBootstrapInFlight(env), true)
  } finally {
    cleanup()
  }
})

test('isEverOSBackgroundBootstrapInFlight is false for terminal states', async () => {
  const { env, cleanup } = makeTempEnv()
  try {
    const path = env.BABEL_O_EVEROS_BOOTSTRAP_FILE!
    for (const status of ['ready', 'failed', 'opted_out', 'external', 'not_started'] as const) {
      writeFileSync(path, JSON.stringify({ version: 2, buildStatus: status }), 'utf8')
      assert.equal(await isEverOSBackgroundBootstrapInFlight(env), false, `expected ${status} to be terminal`)
    }
  } finally {
    cleanup()
  }
})

test('background worker preserves v2 fields during failure writes', async () => {
  const { env, cleanup } = makeTempEnv()
  try {
    const path = env.BABEL_O_EVEROS_BOOTSTRAP_FILE!
    writeFileSync(path, JSON.stringify({
      version: 2,
      autoBootstrapPolicy: 'on',
      fallbackBuildTool: 'uv',
      optedIn: true,
      buildStatus: 'cloning',
    }), 'utf8')
    const handle = startEverOSBackgroundBootstrap({
      env,
      runner: makeFailingRunner(),
      assumeYes: true,
      nonInteractive: true,
    })
    const result = await handle.promise
    assert.equal(result.ok, false)
    const reread = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(reread.version, 2)
    assert.equal(reread.autoBootstrapPolicy, 'on')
    assert.equal(reread.fallbackBuildTool, 'uv')
    assert.equal(reread.optedIn, true)
    assert.equal(reread.buildStatus, 'failed')
  } finally {
    cleanup()
  }
})
