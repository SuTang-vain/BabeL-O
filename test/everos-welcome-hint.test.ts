import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  formatEverCoreWelcomeHint,
  suggestEverCoreFixAction,
} from '../src/cli/everosWelcomeHint.js'
import {
  createEverOSBootstrapState,
  readEverOSBootstrapStateSync,
} from '../src/shared/everosBootstrapStore.js'

function makeTempEnv(): { env: NodeJS.ProcessEnv; bootstrapFile: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'babel-o-everos-welcome-'))
  const bootstrapFile = join(dir, 'everos-bootstrap.json')
  return {
    bootstrapFile,
    env: {
      ...process.env,
      BABEL_O_CONFIG_FILE: join(dir, 'config.json'),
      BABEL_O_EVEROS_BOOTSTRAP_FILE: bootstrapFile,
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/**
 * Write a state to the test bootstrap file and read it back via
 * the test env so the welcome-hint helper can use it. Returns
 * the `readEverOSBootstrapStateSync` result, which the tests
 * pass to `formatEverCoreWelcomeHint({ bootstrap })` to avoid
 * filesystem lookups in the default env.
 */
function seedState(env: NodeJS.ProcessEnv, bootstrapFile: string, partial: object) {
  writeFileSync(bootstrapFile, JSON.stringify(createEverOSBootstrapState(partial)), 'utf8')
  return readEverOSBootstrapStateSync({ env })
}

test('welcome hint: not configured (no file) shows dim tip', () => {
  const { env, cleanup } = makeTempEnv()
  try {
    // No file is written; pass the read result from the temp env
    // so the test does not depend on the host's
    // BABEL_O_EVEROS_BOOTSTRAP_FILE.
    const read = readEverOSBootstrapStateSync({ env })
    assert.equal(read.ok, true)
    const hint = formatEverCoreWelcomeHint({ bootstrap: read })
    assert.ok(hint)
    assert.equal(hint.severity, 'info')
    assert.match(hint.text, /not configured/)
    assert.match(hint.text, /bbl memory setup/)
  } finally {
    cleanup()
  }
})

test('welcome hint: failed bootstrap surfaces yellow warning with fix action', () => {
  const { env, bootstrapFile, cleanup } = makeTempEnv()
  try {
    const read = seedState(env, bootstrapFile, {
      optedIn: true,
      buildStatus: 'failed',
      errorCode: 'EVEROS_BOOTSTRAP_UV_MISSING',
      errorMessage: 'uv is required',
    })
    assert.equal(read.ok, true)
    const hint = formatEverCoreWelcomeHint({ bootstrap: read })
    assert.ok(hint)
    assert.equal(hint.severity, 'warning')
    assert.match(hint.text, /setup failed/)
    assert.match(hint.text, /EVEROS_BOOTSTRAP_UV_MISSING/)
    assert.match(hint.text, /Install uv/)
  } finally {
    cleanup()
  }
})

test('welcome hint: ready + mcpToolsEnabled=false shows read-only hint', () => {
  const { env, bootstrapFile, cleanup } = makeTempEnv()
  try {
    const read = seedState(env, bootstrapFile, {
      optedIn: true,
      buildStatus: 'ready',
      managedCommand: '/tmp/everos',
      dataDir: '/tmp/data',
    })
    const hint = formatEverCoreWelcomeHint({ bootstrap: read, mcpToolsEnabled: false })
    assert.ok(hint)
    assert.equal(hint.severity, 'info')
    assert.match(hint.text, /ready/)
    assert.match(hint.text, /bbl memory enable-tools/)
  } finally {
    cleanup()
  }
})

test('welcome hint: ready + mcpToolsEnabled=true returns null (no action needed)', () => {
  const { env, bootstrapFile, cleanup } = makeTempEnv()
  try {
    const read = seedState(env, bootstrapFile, {
      optedIn: true,
      buildStatus: 'ready',
      managedCommand: '/tmp/everos',
      dataDir: '/tmp/data',
    })
    const hint = formatEverCoreWelcomeHint({ bootstrap: read, mcpToolsEnabled: true })
    assert.equal(hint, null)
  } finally {
    cleanup()
  }
})

test('welcome hint: in-flight build shows dim progress', () => {
  const { env, bootstrapFile, cleanup } = makeTempEnv()
  try {
    for (const status of ['cloning', 'building', 'checking_prereqs'] as const) {
      const read = seedState(env, bootstrapFile, {
        buildStatus: status,
        lastCheckedAt: new Date().toISOString(),
      })
      const hint = formatEverCoreWelcomeHint({ bootstrap: read })
      assert.ok(hint, `expected hint for ${status}`)
      assert.equal(hint.severity, 'info')
      assert.match(hint.text, new RegExp(status))
    }
  } finally {
    cleanup()
  }
})

test('welcome hint: opted_out shows opt-back-in tip', () => {
  const { env, bootstrapFile, cleanup } = makeTempEnv()
  try {
    const read = seedState(env, bootstrapFile, {
      optedOut: true,
      buildStatus: 'opted_out',
    })
    const hint = formatEverCoreWelcomeHint({ bootstrap: read })
    assert.ok(hint)
    assert.equal(hint.severity, 'info')
    assert.match(hint.text, /opted out/)
  } finally {
    cleanup()
  }
})

test('welcome hint: external mode shows env setup tip', () => {
  const { env, bootstrapFile, cleanup } = makeTempEnv()
  try {
    const read = seedState(env, bootstrapFile, {
      buildStatus: 'external',
    })
    const hint = formatEverCoreWelcomeHint({ bootstrap: read })
    assert.ok(hint)
    assert.equal(hint.severity, 'info')
    assert.match(hint.text, /BABEL_O_EVERCORE_MODE=external/)
  } finally {
    cleanup()
  }
})

test('welcome hint: invalid state file surfaces yellow warning', () => {
  const { env, bootstrapFile, cleanup } = makeTempEnv()
  try {
    writeFileSync(bootstrapFile, '{ "version": 2, "buildStatus": "this-is-not-a-real-status" }', 'utf8')
    const read = readEverOSBootstrapStateSync({ env })
    assert.equal(read.ok, false, 'expected invalid state to be reported as ok=false')
    if (read.ok) return
    const hint = formatEverCoreWelcomeHint({ bootstrap: read })
    assert.ok(hint)
    assert.equal(hint.severity, 'warning')
    assert.match(hint.text, /bootstrap state invalid/)
  } finally {
    cleanup()
  }
})

test('welcome hint: pass explicit bootstrap avoids disk access', () => {
  const hint = formatEverCoreWelcomeHint({
    bootstrap: { ok: true, path: '/in-memory.json', exists: false },
  })
  assert.ok(hint)
  assert.equal(hint.severity, 'info')
  assert.match(hint.text, /not configured/)
})

test('suggestEverCoreFixAction covers all known error codes', () => {
  const codes = [
    'EVEROS_BOOTSTRAP_GIT_MISSING',
    'EVEROS_BOOTSTRAP_PYTHON_MISSING',
    'EVEROS_BOOTSTRAP_UV_MISSING',
    'EVEROS_BOOTSTRAP_PACKAGE_MANAGER_UNSUPPORTED',
    'EVEROS_BOOTSTRAP_CLONE_FAILED',
    'EVEROS_BOOTSTRAP_BUILD_FAILED',
    'EVEROS_BOOTSTRAP_CONCURRENT_INSTALL_IN_PROGRESS',
  ] as const
  for (const code of codes) {
    const msg = suggestEverCoreFixAction({ version: 2, errorCode: code })
    assert.ok(msg.length > 0, `expected non-empty fix for ${code}`)
    assert.match(msg, /bbl memory setup/)
  }
})

test('suggestEverCoreFixAction falls back to a generic retry message for unknown codes', () => {
  const msg = suggestEverCoreFixAction({ version: 2, errorCode: null })
  assert.match(msg, /bbl memory setup --retry/)
})

test('readEverOSBootstrapStateSync round-trips the state we wrote for the welcome hint', () => {
  const { env, bootstrapFile, cleanup } = makeTempEnv()
  try {
    const read = seedState(env, bootstrapFile, {
      optedIn: true,
      buildStatus: 'ready',
      managedCommand: '/x/everos',
      dataDir: '/x/data',
    })
    assert.equal(read.ok, true)
    if (!read.ok) return
    assert.equal(read.state?.managedCommand, '/x/everos')
    const hint = formatEverCoreWelcomeHint({ bootstrap: read, mcpToolsEnabled: false })
    assert.ok(hint)
    assert.match(hint.text, /ready/)
  } finally {
    cleanup()
  }
})
