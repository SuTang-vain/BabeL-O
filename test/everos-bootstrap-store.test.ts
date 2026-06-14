import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  EVEROS_BOOTSTRAP_VERSION,
  createEverOSBootstrapState,
  readEverOSBootstrapState,
  resetEverOSBootstrapState,
  resolveEverOSBootstrapFile,
  updateEverOSBootstrapState,
} from '../src/shared/everosBootstrapStore.js'

function makeTempBootstrap(): { env: NodeJS.ProcessEnv; file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'babel-o-everos-bootstrap-store-'))
  const file = join(dir, 'everos-bootstrap.json')
  return {
    file,
    env: {
      ...process.env,
      BABEL_O_CONFIG_FILE: join(dir, 'config.json'),
      BABEL_O_EVEROS_BOOTSTRAP_FILE: file,
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('EverOS bootstrap store reads missing state without creating files', async () => {
  const { env, file, cleanup } = makeTempBootstrap()
  try {
    assert.equal(resolveEverOSBootstrapFile(env), file)
    const read = await readEverOSBootstrapState({ env })
    assert.equal(read.ok, true)
    assert.equal(read.exists, false)
  } finally {
    cleanup()
  }
})

test('EverOS bootstrap store reports invalid JSON as non-throwing diagnostics', async () => {
  const { env, file, cleanup } = makeTempBootstrap()
  try {
    writeFileSync(file, '{not-json')
    const read = await readEverOSBootstrapState({ env })
    assert.equal(read.ok, false)
    if (!read.ok) {
      assert.equal(read.errorCode, 'EVEROS_BOOTSTRAP_STATE_INVALID')
      assert.match(read.errorMessage, /JSON|Unexpected|property/i)
    }
  } finally {
    cleanup()
  }
})

test('EverOS bootstrap store writes normalized state atomically with private mode', async () => {
  const { env, file, cleanup } = makeTempBootstrap()
  try {
    const state = await updateEverOSBootstrapState(() => createEverOSBootstrapState({
      optedIn: true,
      buildStatus: 'ready',
      managedCommand: '/tmp/everos',
      dataDir: '/tmp/everos-data',
    }), { env })
    assert.equal(state.version, EVEROS_BOOTSTRAP_VERSION)
    assert.equal(state.buildStatus, 'ready')

    const raw = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(raw.version, EVEROS_BOOTSTRAP_VERSION)
    assert.equal(raw.managedCommand, '/tmp/everos')
    const mode = statSync(file).mode & 0o777
    assert.equal(mode, 0o600)
  } finally {
    cleanup()
  }
})

test('EverOS bootstrap store serializes concurrent updates without corrupting JSON', async () => {
  const { env, file, cleanup } = makeTempBootstrap()
  try {
    await Promise.all(Array.from({ length: 5 }, (_, index) => updateEverOSBootstrapState(current => createEverOSBootstrapState({
      ...current,
      optedIn: true,
      buildStatus: 'not_started',
      sourceCommit: `${current?.sourceCommit ?? ''}${index}`,
    }), { env })))

    const read = await readEverOSBootstrapState({ env })
    assert.equal(read.ok, true)
    assert.equal(read.exists, true)
    assert.equal(read.ok ? read.state?.sourceCommit?.length : undefined, 5)
    assert.doesNotThrow(() => JSON.parse(readFileSync(file, 'utf8')))
  } finally {
    cleanup()
  }
})

test('EverOS bootstrap reset removes state file', async () => {
  const { env, file, cleanup } = makeTempBootstrap()
  try {
    await updateEverOSBootstrapState(() => createEverOSBootstrapState({ optedOut: true, buildStatus: 'opted_out' }), { env })
    assert.equal((await resetEverOSBootstrapState({ env })), true)
    const read = await readEverOSBootstrapState({ env })
    assert.equal(read.ok, true)
    assert.equal(read.exists, false)
    assert.throws(() => readFileSync(file, 'utf8'))
  } finally {
    cleanup()
  }
})
