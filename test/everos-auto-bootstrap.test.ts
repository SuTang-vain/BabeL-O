import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { decideAutoBootstrap } from '../src/cli/everosAutoBootstrap.js'

function makeTempEnv(extra: NodeJS.ProcessEnv = {}): { env: NodeJS.ProcessEnv; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'babel-o-everos-auto-'))
  return {
    env: {
      ...process.env,
      BABEL_O_CONFIG_FILE: join(dir, 'config.json'),
      BABEL_O_EVEROS_BOOTSTRAP_FILE: join(dir, 'everos-bootstrap.json'),
      ...extra,
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('policy=off in env: never attempts bootstrap, even when state is unconfigured', async () => {
  const { env, cleanup } = makeTempEnv({ BABEL_O_EVERCORE_AUTO_BOOTSTRAP: '0' })
  try {
    const decision = await decideAutoBootstrap({ env })
    assert.equal(decision.attempt, false)
    if (decision.attempt) return
    assert.equal(decision.reason, 'policy_off')
  } finally {
    cleanup()
  }
})

test('opted_out state short-circuits even with policy=on', async () => {
  const { env, cleanup } = makeTempEnv({ BABEL_O_EVERCORE_AUTO_BOOTSTRAP: '1' })
  try {
    writeFileSync(env.BABEL_O_EVEROS_BOOTSTRAP_FILE!, JSON.stringify({
      version: 2,
      optedOut: true,
      buildStatus: 'opted_out',
    }), 'utf8')
    const decision = await decideAutoBootstrap({ env })
    assert.equal(decision.attempt, false)
    if (decision.attempt) return
    assert.equal(decision.reason, 'state_opted_out')
  } finally {
    cleanup()
  }
})

test('ready state short-circuits (no need to re-bootstrap)', async () => {
  const { env, cleanup } = makeTempEnv({ BABEL_O_EVERCORE_AUTO_BOOTSTRAP: '1' })
  try {
    writeFileSync(env.BABEL_O_EVEROS_BOOTSTRAP_FILE!, JSON.stringify({
      version: 2,
      buildStatus: 'ready',
      managedCommand: '/tmp/everos',
      dataDir: '/tmp/data',
    }), 'utf8')
    const decision = await decideAutoBootstrap({ env })
    assert.equal(decision.attempt, false)
    if (decision.attempt) return
    assert.equal(decision.reason, 'state_ready')
  } finally {
    cleanup()
  }
})

test('external state short-circuits', async () => {
  const { env, cleanup } = makeTempEnv({ BABEL_O_EVERCORE_AUTO_BOOTSTRAP: '1' })
  try {
    writeFileSync(env.BABEL_O_EVEROS_BOOTSTRAP_FILE!, JSON.stringify({
      version: 2,
      buildStatus: 'external',
    }), 'utf8')
    const decision = await decideAutoBootstrap({ env })
    assert.equal(decision.attempt, false)
    if (decision.attempt) return
    assert.equal(decision.reason, 'state_external')
  } finally {
    cleanup()
  }
})

test('in-flight state short-circuits (another bbl is already bootstrapping)', async () => {
  const { env, cleanup } = makeTempEnv({ BABEL_O_EVERCORE_AUTO_BOOTSTRAP: '1' })
  try {
    writeFileSync(env.BABEL_O_EVEROS_BOOTSTRAP_FILE!, JSON.stringify({
      version: 2,
      buildStatus: 'cloning',
    }), 'utf8')
    const decision = await decideAutoBootstrap({ env })
    assert.equal(decision.attempt, false)
    if (decision.attempt) return
    assert.equal(decision.reason, 'in_flight')
  } finally {
    cleanup()
  }
})

test('unconfigured + policy=on: attempts bootstrap, reason=not_configured', async () => {
  const { env, cleanup } = makeTempEnv({ BABEL_O_EVERCORE_AUTO_BOOTSTRAP: '1' })
  try {
    // git missing → prereqs check fails → decision becomes skip.
    // We can't easily satisfy the prereq gate in CI without
    // mocking, so we just assert the decision shape.
    const decision = await decideAutoBootstrap({ env })
    // Either we get a real attempt (if git is present on the test
    // host) or we get a prereqs_missing skip. Both are valid
    // outcomes; the important assertion is that we don't bail with
    // policy_off / state_* / in_flight.
    if (decision.attempt) {
      assert.equal(decision.reason, 'not_configured')
    } else {
      assert.equal(decision.reason, 'prereqs_missing')
    }
  } finally {
    cleanup()
  }
})

test('failed state + policy=on: triggers auto-retry (when prereqs available)', async () => {
  const { env, cleanup } = makeTempEnv({ BABEL_O_EVERCORE_AUTO_BOOTSTRAP: '1' })
  try {
    writeFileSync(env.BABEL_O_EVEROS_BOOTSTRAP_FILE!, JSON.stringify({
      version: 2,
      buildStatus: 'failed',
      errorCode: 'EVEROS_BOOTSTRAP_UV_MISSING',
    }), 'utf8')
    const decision = await decideAutoBootstrap({ env })
    if (decision.attempt) {
      assert.equal(decision.reason, 'auto_retry_after_failure')
    } else {
      assert.equal(decision.reason, 'prereqs_missing')
    }
  } finally {
    cleanup()
  }
})

test('default policy is prompt: never auto-attempts', async () => {
  const { env, cleanup } = makeTempEnv()
  try {
    const decision = await decideAutoBootstrap({ env })
    assert.equal(decision.attempt, false)
    if (decision.attempt) return
    assert.equal(decision.reason, 'policy_off')
  } finally {
    cleanup()
  }
})
