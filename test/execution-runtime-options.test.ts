import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildRuntimeExecuteOptions } from '../src/nexus/executionRuntimeOptions.js'
import type { ExecuteBody, PreparedExecution } from '../src/nexus/executionPreparation.js'
import type { RemoteToolRunner } from '../src/runtime/remoteRunner.js'
import type { NexusStorage } from '../src/storage/Storage.js'

test('buildRuntimeExecuteOptions preserves Nexus execution inputs for runtime.executeStream', () => {
  const abortController = new AbortController()
  const timeoutController = new AbortController()
  const timeout = setTimeout(() => {}, 1_000)
  const storage = { marker: 'storage' } as unknown as NexusStorage
  const remoteRunner = { marker: 'runner' } as unknown as RemoteToolRunner
  const body: ExecuteBody = {
    prompt: 'read README',
    cwd: '/workspace',
    maxToolOutputBytes: 1234,
    skipPermissionCheck: true,
    requestId: 'body-request-id',
    model: 'local/coding-runtime',
    budget: 42,
    executionEnvironment: 'remote',
    allowedTools: ['Read'],
  }
  const prepared: PreparedExecution = {
    sessionId: 'session-runtime-options',
    session: {} as PreparedExecution['session'],
    cwd: '/workspace/resolved',
    body,
    requestId: 'req-runtime-options',
    abortController,
    timeoutController,
    timeout,
    timeoutDecision: {
      policy: 'soft',
      softTimeoutMs: 2_000,
      watchdogTimeoutMs: 5_000,
      maxSoftTimeoutExtensions: 1,
      softTimeoutExtensionMs: 2_000,
    },
    policyMode: 'soft-deny',
    allowedTools: ['Read', 'Bash'],
    allowedPaths: ['/workspace/allowed'],
    watchdog: { fired: false },
    storedSessionCwd: '/workspace/origin',
    latestTaskPrimaryRoot: '/workspace/primary',
  }

  try {
    const out = buildRuntimeExecuteOptions({
      body,
      prepared,
      maxToolOutputBytes: 200_000,
      bashMaxBufferBytes: 1_000_000,
      storage,
      remoteRunner,
    })

    assert.equal(out.sessionId, prepared.sessionId)
    assert.equal(out.prompt, body.prompt)
    assert.equal(out.cwd, prepared.cwd)
    assert.equal(out.signal, abortController.signal)
    assert.equal(out.timeoutSignal, timeoutController.signal)
    assert.equal(out.maxToolOutputBytes, body.maxToolOutputBytes)
    assert.equal(out.bashMaxBufferBytes, 1_000_000)
    assert.equal(out.skipPermissionCheck, true)
    assert.equal(out.requestId, prepared.requestId)
    assert.equal(out.model, body.model)
    assert.equal(out.budget, body.budget)
    assert.equal(out.executionEnvironment, body.executionEnvironment)
    assert.equal(out.remoteRunner, remoteRunner)
    assert.deepEqual(out.allowedPaths, ['/workspace/allowed'])
    assert.equal(out.policyMode, 'soft-deny')
    assert.equal(out.storage, storage)
    assert.equal(out.storedSessionCwd, '/workspace/origin')
    assert.equal(out.latestTaskPrimaryRoot, '/workspace/primary')
    assert.deepEqual(out.allowedTools, ['Read', 'Bash'])
  } finally {
    clearTimeout(timeout)
  }
})

test('buildRuntimeExecuteOptions falls back to server maxToolOutputBytes and omits absent optional continuity fields', () => {
  const abortController = new AbortController()
  const timeoutController = new AbortController()
  const timeout = setTimeout(() => {}, 1_000)
  const storage = {} as NexusStorage
  const body: ExecuteBody = {
    prompt: 'hello',
    executionEnvironment: 'local',
  }
  const prepared: PreparedExecution = {
    sessionId: 'session-runtime-options-defaults',
    session: {} as PreparedExecution['session'],
    cwd: '/workspace',
    body,
    requestId: 'req-runtime-options-defaults',
    abortController,
    timeoutController,
    timeout,
    timeoutDecision: {
      policy: 'fatal',
      softTimeoutMs: 30_000,
      watchdogTimeoutMs: 30_000,
      maxSoftTimeoutExtensions: 0,
      softTimeoutExtensionMs: 30_000,
    },
    policyMode: 'strict',
    watchdog: { fired: false },
  }

  try {
    const out = buildRuntimeExecuteOptions({
      body,
      prepared,
      maxToolOutputBytes: 200_000,
      bashMaxBufferBytes: 1_000_000,
      storage,
    })

    assert.equal(out.maxToolOutputBytes, 200_000)
    assert.equal(out.storage, storage)
    assert.equal('storedSessionCwd' in out, false)
    assert.equal('latestTaskPrimaryRoot' in out, false)
    assert.equal('allowedTools' in out, false)
  } finally {
    clearTimeout(timeout)
  }
})
