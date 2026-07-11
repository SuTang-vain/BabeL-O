import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildRuntimeErrorEvent } from '../src/runtime/pipeline/events.js'

describe('buildRuntimeErrorEvent integration', () => {
  it('includes hint and docsUrl for REQUEST_TIMEOUT', () => {
    const event = buildRuntimeErrorEvent({
      sessionId: 'test-session',
      code: 'REQUEST_TIMEOUT',
      message: 'turn exceeded 180000ms',
    })

    assert.equal(event.type, 'error')
    assert.equal(event.code, 'REQUEST_TIMEOUT')
    assert.ok(event.hint)
    assert.ok(event.hint?.includes('summarize'))
    assert.ok(event.docsUrl)
    assert.ok(event.docsUrl?.includes('REQUEST_TIMEOUT'))
  })

  it('includes hint for CONTEXT_BLOCKING', () => {
    const event = buildRuntimeErrorEvent({
      sessionId: 'test-session',
      code: 'CONTEXT_BLOCKING',
      message: 'context limit exceeded',
    })

    assert.equal(event.code, 'CONTEXT_BLOCKING')
    assert.ok(event.hint)
    assert.ok(event.hint?.includes('compact'))
  })

  it('includes hint for PROVIDER_AUTH_FAILED', () => {
    const event = buildRuntimeErrorEvent({
      sessionId: 'test-session',
      code: 'PROVIDER_AUTH_FAILED',
      message: 'invalid API key',
    })

    assert.equal(event.code, 'PROVIDER_AUTH_FAILED')
    assert.ok(event.hint)
    assert.ok(event.hint?.includes('API key'))
  })

  it('preserves details when provided', () => {
    const event = buildRuntimeErrorEvent({
      sessionId: 'test-session',
      code: 'REQUEST_TIMEOUT',
      message: 'timeout',
      details: { timeoutMs: 180000 },
    })

    assert.ok(event.details)
    assert.deepEqual(event.details, { timeoutMs: 180000 })
  })

  it('handles unknown error codes gracefully', () => {
    const event = buildRuntimeErrorEvent({
      sessionId: 'test-session',
      code: 'UNKNOWN_ERROR',
      message: 'something went wrong',
    })

    assert.equal(event.code, 'UNKNOWN_ERROR')
    assert.equal(event.message, 'something went wrong')
    assert.equal(event.hint, undefined)
    assert.equal(event.docsUrl, undefined)
  })
})
