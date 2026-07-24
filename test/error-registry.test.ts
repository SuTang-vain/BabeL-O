import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { humanizeError, listErrorCodes, isKnownErrorCode, ERROR_REGISTRY } from '../src/nexus/errorRegistry.js'

describe('errorRegistry', () => {
  describe('humanizeError', () => {
    it('returns hint and docsUrl for registered error codes', () => {
      const result = humanizeError('REQUEST_TIMEOUT', 'turn exceeded 180000ms')
      assert.equal(result.code, 'REQUEST_TIMEOUT')
      assert.equal(result.message, 'turn exceeded 180000ms')
      assert.ok(result.hint)
      assert.ok(result.hint?.includes('summarize'))
      assert.ok(result.docsUrl)
    })

    it('returns original message for unregistered error codes', () => {
      const result = humanizeError('UNKNOWN_ERROR', 'something went wrong')
      assert.equal(result.code, 'UNKNOWN_ERROR')
      assert.equal(result.message, 'something went wrong')
      assert.equal(result.hint, undefined)
      assert.equal(result.docsUrl, undefined)
    })

    it('injects context for tombstoned_profile', () => {
      const result = humanizeError('tombstoned_profile', 'profile is tombstoned', { profile: 'my-profile' })
      assert.ok(result.hint?.includes('my-profile'))
      assert.ok(result.hint?.includes('restore'))
    })

    it('injects context for unknown_profile', () => {
      const result = humanizeError('unknown_profile', 'profile not found', { profile: 'bad-profile' })
      assert.ok(result.hint?.includes('bad-profile'))
      assert.ok(result.hint?.includes('config list'))
    })

    it('injects context for missing_provider_api_key', () => {
      const result = humanizeError('missing_provider_api_key', 'no key', { provider: 'anthropic', model: 'claude-3' })
      assert.ok(result.hint?.includes('anthropic'))
      assert.ok(result.hint?.includes('claude-3'))
    })

    it('injects context for unknown_provider', () => {
      const result = humanizeError('unknown_provider', 'bad provider', { provider: 'unknown-ai' })
      assert.ok(result.hint?.includes('unknown-ai'))
    })

    it('handles missing details gracefully', () => {
      const result = humanizeError('tombstoned_profile', 'profile is tombstoned')
      assert.ok(result.hint)
    })

    it('handles null details gracefully', () => {
      const result = humanizeError('tombstoned_profile', 'profile is tombstoned', null)
      assert.ok(result.hint)
    })
  })

  describe('ERROR_REGISTRY', () => {
    it('contains all required error codes from TODO_product_30day', () => {
      const requiredCodes = [
        'REQUEST_TIMEOUT',
        'CONTEXT_BLOCKING',
        'PROVIDER_AUTH_FAILED',
        'WORKTREE_CONFLICT',
        'TOOL_RESULT_BUDGET_EXCEEDED',
      ]

      for (const code of requiredCodes) {
        assert.ok(ERROR_REGISTRY[code], `Missing required error code: ${code}`)
        assert.ok(ERROR_REGISTRY[code].hint, `Missing hint for ${code}`)
      }
    })

    it('all registered errors have hints', () => {
      for (const [code, def] of Object.entries(ERROR_REGISTRY)) {
        assert.ok(def.hint, `Missing hint for ${code}`)
        assert.ok(def.hint.length > 10, `Hint too short for ${code}`)
      }
    })
  })

  describe('listErrorCodes', () => {
    it('returns array of error codes', () => {
      const codes = listErrorCodes()
      assert.ok(Array.isArray(codes))
      assert.ok(codes.length > 0)
      assert.ok(codes.includes('REQUEST_TIMEOUT'))
    })
  })

  describe('isKnownErrorCode', () => {
    it('returns true for known error codes', () => {
      assert.equal(isKnownErrorCode('REQUEST_TIMEOUT'), true)
      assert.equal(isKnownErrorCode('CONTEXT_BLOCKING'), true)
    })

    it('returns false for unknown error codes', () => {
      assert.equal(isKnownErrorCode('UNKNOWN_ERROR'), false)
      assert.equal(isKnownErrorCode('random_string'), false)
    })
  })
})
