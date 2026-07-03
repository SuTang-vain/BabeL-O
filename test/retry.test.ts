import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { withRetry } from '../src/providers/retry.js'
import { readProviderAutoRetryPolicy } from '../src/runtime/providerRetry.js'
import { ProviderError } from '../src/shared/errors.js'

describe('withRetry', () => {
  test('succeeds on first attempt', async () => {
    let calls = 0
    const result = await withRetry(async () => {
      calls += 1
      return 'ok'
    }, { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 10, retryableStatuses: [429] })
    assert.equal(result, 'ok')
    assert.equal(calls, 1)
  })

  test('retries on retryable ProviderError and succeeds', async () => {
    let calls = 0
    const result = await withRetry(async () => {
      calls += 1
      if (calls === 1) throw new ProviderError('test', 429, 'rate limited')
      return 'ok'
    }, { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 10, retryableStatuses: [429] })
    assert.equal(result, 'ok')
    assert.equal(calls, 2)
  })

  test('throws after exhausting retries', async () => {
    let calls = 0
    await assert.rejects(
      () => withRetry(async () => {
        calls += 1
        throw new ProviderError('test', 429, 'rate limited')
      }, { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 10, retryableStatuses: [429] }),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError)
        assert.equal(err.httpStatus, 429)
        return true
      },
    )
    assert.equal(calls, 3)
  })

  test('does not retry non-retryable status', async () => {
    let calls = 0
    await assert.rejects(
      () => withRetry(async () => {
        calls += 1
        throw new ProviderError('test', 400, 'bad request')
      }, { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 10, retryableStatuses: [429, 500] }),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError)
        assert.equal(err.httpStatus, 400)
        return true
      },
    )
    assert.equal(calls, 1)
  })

  test('does not retry non-ProviderError', async () => {
    let calls = 0
    await assert.rejects(
      () => withRetry(async () => {
        calls += 1
        throw new Error('network failure')
      }, { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 10, retryableStatuses: [429] }),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.equal(err.message, 'network failure')
        return true
      },
    )
    assert.equal(calls, 1)
  })

  test('retries multiple retryable status codes', async () => {
    let calls = 0
    const result = await withRetry(async () => {
      calls += 1
      if (calls === 1) throw new ProviderError('test', 500, 'internal error')
      if (calls === 2) throw new ProviderError('test', 503, 'unavailable')
      return 'ok'
    }, { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 10, retryableStatuses: [429, 500, 502, 503, 529] })
    assert.equal(result, 'ok')
    assert.equal(calls, 3)
  })

  test('retries 504 timeout errors by default', async () => {
    let calls = 0
    const result = await withRetry(async () => {
      calls += 1
      if (calls === 1) throw new ProviderError('minimax', 504, '{"type":"error","error":{"type":"timeout_error","message":"请求处理超时，请稍后重试 (2066)"}}')
      return 'ok'
    })
    assert.equal(result, 'ok')
    assert.equal(calls, 2)
  })
})

describe('readProviderAutoRetryPolicy', () => {
  test('uses default provider auto retry policy without config or env overrides', () => {
    assert.deepEqual(readProviderAutoRetryPolicy({}), {
      enabled: true,
      maxRetries: 10,
      delayMs: 30_000,
    })
  })

  test('uses saved config provider auto retry policy', () => {
    assert.deepEqual(readProviderAutoRetryPolicy({}, {
      enabled: false,
      maxRetries: 4,
      delayMs: 2500,
    }), {
      enabled: false,
      maxRetries: 4,
      delayMs: 2500,
    })
  })

  test('lets env overrides take precedence over saved provider auto retry config', () => {
    assert.deepEqual(readProviderAutoRetryPolicy({
      BABEL_O_PROVIDER_AUTO_RETRY_ENABLED: '1',
      BABEL_O_PROVIDER_AUTO_RETRY_MAX_RETRIES: '8',
      BABEL_O_PROVIDER_AUTO_RETRY_DELAY_MS: '1200',
    }, {
      enabled: false,
      maxRetries: 4,
      delayMs: 2500,
    }), {
      enabled: true,
      maxRetries: 8,
      delayMs: 1200,
    })
  })

  test('falls back when saved provider auto retry config values are invalid', () => {
    assert.deepEqual(readProviderAutoRetryPolicy({}, {
      maxRetries: -1,
      delayMs: 1.5,
    }), {
      enabled: true,
      maxRetries: 10,
      delayMs: 30_000,
    })
  })
})
