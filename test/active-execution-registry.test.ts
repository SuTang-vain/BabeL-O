import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ActiveExecutionRegistry } from '../src/nexus/activeExecutionRegistry.js'

test('ActiveExecutionRegistry lease release is idempotent and clears only its request', () => {
  const registry = new ActiveExecutionRegistry()
  const firstAbortController = new AbortController()
  const secondAbortController = new AbortController()

  const firstLease = registry.register('session-1', {
    requestId: 'req-1',
    abortController: firstAbortController,
    transport: 'http',
    startedAt: '2026-06-19T00:00:00.000Z',
  })
  assert.deepEqual(registry.snapshot('session-1'), {
    requestId: 'req-1',
    transport: 'http',
    startedAt: '2026-06-19T00:00:00.000Z',
  })

  registry.register('session-1', {
    requestId: 'req-2',
    abortController: secondAbortController,
    transport: 'websocket',
    startedAt: '2026-06-19T00:00:01.000Z',
  })
  firstLease.release()
  firstLease.release()

  assert.deepEqual(registry.snapshot('session-1'), {
    requestId: 'req-2',
    transport: 'websocket',
    startedAt: '2026-06-19T00:00:01.000Z',
  })
})

test('ActiveExecutionRegistry lease release clears the current execution and cancel aborts it', () => {
  const registry = new ActiveExecutionRegistry()
  const abortController = new AbortController()
  const lease = registry.register('session-1', {
    requestId: 'req-1',
    abortController,
    transport: 'websocket',
    startedAt: '2026-06-19T00:00:00.000Z',
  })

  assert.deepEqual(registry.cancel('session-1'), {
    requestId: 'req-1',
    transport: 'websocket',
  })
  assert.equal(abortController.signal.aborted, true)

  lease.release()
  assert.equal(registry.snapshot('session-1'), null)
  assert.equal(registry.cancel('session-1'), null)
})
