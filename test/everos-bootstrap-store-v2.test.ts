import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  EVEROS_BOOTSTRAP_VERSION,
  createEverOSBootstrapState,
  defaultEverOSDataDir,
  parseAutoBootstrapPolicy,
  readEverOSBootstrapState,
  readEverOSBootstrapStateSync,
  updateEverOSBootstrapState,
  writeEverOSBootstrapState,
} from '../src/shared/everosBootstrapStore.js'

function makeTempEnv(): { env: NodeJS.ProcessEnv; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'babel-o-everos-v2-'))
  return {
    env: {
      ...process.env,
      BABEL_O_CONFIG_FILE: join(dir, 'config.json'),
      BABEL_O_EVEROS_BOOTSTRAP_FILE: join(dir, 'everos-bootstrap.json'),
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('v1 file on disk is read and migrated to v2 with defaults applied', async () => {
  const { env, cleanup } = makeTempEnv()
  try {
    const path = env.BABEL_O_EVEROS_BOOTSTRAP_FILE!
    writeFileSync(path, JSON.stringify({
      version: 1,
      optedIn: true,
      buildStatus: 'ready',
      sourceRepo: 'https://example.com/repo.git',
      managedCommand: '/tmp/everos',
      dataDir: '/tmp/data',
    }), 'utf8')
    const result = readEverOSBootstrapStateSync({ env })
    assert.equal(result.ok, true)
    if (!result.ok) return
    const state = result.state!
    assert.equal(state.version, EVEROS_BOOTSTRAP_VERSION)
    assert.equal(state.autoBootstrapPolicy, 'prompt')
    assert.equal(state.fallbackBuildTool, 'uv')
    assert.equal(state.optedIn, true)
    assert.equal(state.buildStatus, 'ready')
    assert.equal(state.managedCommand, '/tmp/everos')
    assert.equal(state.llmPassthrough, undefined)
  } finally {
    cleanup()
  }
})

test('readEverOSBootstrapState (async) returns the same v2 shape for legacy v1 input', async () => {
  const { env, cleanup } = makeTempEnv()
  try {
    const path = env.BABEL_O_EVEROS_BOOTSTRAP_FILE!
    writeFileSync(path, JSON.stringify({ version: 1, optedOut: true }), 'utf8')
    const result = await readEverOSBootstrapState({ env })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.state?.version, EVEROS_BOOTSTRAP_VERSION)
    assert.equal(result.state?.autoBootstrapPolicy, 'prompt')
    assert.equal(result.state?.fallbackBuildTool, 'uv')
    assert.equal(result.state?.optedOut, true)
  } finally {
    cleanup()
  }
})

test('updateEverOSBootstrapState writes v2 with policy + fallback fields', async () => {
  const { env, cleanup } = makeTempEnv()
  try {
    const next = await updateEverOSBootstrapState(current => createEverOSBootstrapState({
      ...current,
      autoBootstrapPolicy: 'on',
      fallbackBuildTool: 'pip',
      llmPassthrough: { protocol: 'openai-compatible', model: 'gpt-4o-mini', source: 'active_provider_settings' },
    }), { env })
    assert.equal(next.version, EVEROS_BOOTSTRAP_VERSION)
    assert.equal(next.autoBootstrapPolicy, 'on')
    assert.equal(next.fallbackBuildTool, 'pip')
    assert.deepEqual(next.llmPassthrough, {
      protocol: 'openai-compatible',
      model: 'gpt-4o-mini',
      source: 'active_provider_settings',
    })

    const reread = readEverOSBootstrapStateSync({ env })
    assert.equal(reread.ok, true)
    if (!reread.ok) return
    assert.equal(reread.state?.autoBootstrapPolicy, 'on')
    assert.equal(reread.state?.fallbackBuildTool, 'pip')
  } finally {
    cleanup()
  }
})

test('writeEverOSBootstrapState preserves v2 fields across reload', async () => {
  const { env, cleanup } = makeTempEnv()
  try {
    await writeEverOSBootstrapState({
      version: EVEROS_BOOTSTRAP_VERSION,
      autoBootstrapPolicy: 'off',
      fallbackBuildTool: 'none',
      buildStatus: 'opted_out',
    }, { env })
    const reread = readEverOSBootstrapStateSync({ env })
    assert.equal(reread.ok, true)
    if (!reread.ok) return
    assert.equal(reread.state?.autoBootstrapPolicy, 'off')
    assert.equal(reread.state?.fallbackBuildTool, 'none')
  } finally {
    cleanup()
  }
})

test('parseAutoBootstrapPolicy: env wins over state', () => {
  assert.equal(parseAutoBootstrapPolicy({
    env: { BABEL_O_EVERCORE_AUTO_BOOTSTRAP: '1' },
    state: { version: 2, autoBootstrapPolicy: 'off' },
  }), 'on')
  assert.equal(parseAutoBootstrapPolicy({
    env: { BABEL_O_EVERCORE_AUTO_BOOTSTRAP: 'true' },
    state: { version: 2, autoBootstrapPolicy: 'off' },
  }), 'on')
  assert.equal(parseAutoBootstrapPolicy({
    env: { BABEL_O_EVERCORE_AUTO_BOOTSTRAP: '0' },
    state: { version: 2, autoBootstrapPolicy: 'on' },
  }), 'off')
  assert.equal(parseAutoBootstrapPolicy({
    env: { BABEL_O_EVERCORE_AUTO_BOOTSTRAP: 'off' },
    state: { version: 2, autoBootstrapPolicy: 'on' },
  }), 'off')
})

test('parseAutoBootstrapPolicy: state wins when env absent', () => {
  assert.equal(parseAutoBootstrapPolicy({
    env: {},
    state: { version: 2, autoBootstrapPolicy: 'on' },
  }), 'on')
  assert.equal(parseAutoBootstrapPolicy({
    env: {},
    state: { version: 2, autoBootstrapPolicy: 'off' },
  }), 'off')
})

test('parseAutoBootstrapPolicy: defaults to prompt when neither env nor state set', () => {
  assert.equal(parseAutoBootstrapPolicy({ env: {} }), 'prompt')
  assert.equal(parseAutoBootstrapPolicy({}), 'prompt')
  assert.equal(parseAutoBootstrapPolicy({
    env: { BABEL_O_EVERCORE_AUTO_BOOTSTRAP: 'garbage' },
  }), 'prompt')
})

test('v1 file with autoBootstrapPolicy explicit in JSON is preserved as-is (no overwrite)', async () => {
  const { env, cleanup } = makeTempEnv()
  try {
    const path = env.BABEL_O_EVEROS_BOOTSTRAP_FILE!
    writeFileSync(path, JSON.stringify({
      version: 1,
      autoBootstrapPolicy: 'on',
      buildStatus: 'ready',
    }), 'utf8')
    const result = readEverOSBootstrapStateSync({ env })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.state?.autoBootstrapPolicy, 'on')
  } finally {
    cleanup()
  }
})

test('defaultEverOSDataDir still resolves when bootstrap file is overridden by env', () => {
  const { env, cleanup } = makeTempEnv()
  try {
    const dir = defaultEverOSDataDir(env)
    assert.match(dir, /everos\/data$/)
  } finally {
    cleanup()
  }
})
