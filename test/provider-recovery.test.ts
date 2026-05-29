import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProviderError } from '../src/shared/errors.js'
import { classifyProviderRecovery } from '../src/runtime/providerRecovery.js'

test('classifyProviderRecovery tags max output token failures', () => {
  const details = classifyProviderRecovery(
    new ProviderError('anthropic', 400, '{"error":{"message":"stop_reason max_tokens"}}'),
  )
  assert.equal(details?.kind, 'max_output_tokens')
  assert.equal(details?.recoveryReason, 'ESCALATED_MAX_TOKENS')
  assert.equal(details?.retryable, true)
})

test('classifyProviderRecovery tags context window failures', () => {
  const details = classifyProviderRecovery(
    new ProviderError('openai', 400, '{"error":{"code":"context_length_exceeded","message":"prompt_too_long"}}'),
  )
  assert.equal(details?.kind, 'context_window')
  assert.equal(details?.recoveryReason, 'ESCALATED_CONTEXT_WINDOW')
})

test('classifyProviderRecovery tags auth and billing failures as non-retryable', () => {
  const details = classifyProviderRecovery(
    new ProviderError('openai', 402, '{"error":{"message":"Insufficient Balance"}}'),
  )
  assert.equal(details?.kind, 'auth_or_billing')
  assert.equal(details?.recoveryReason, 'PROVIDER_AUTH_OR_BILLING')
  assert.equal(details?.retryable, false)
})

test('classifyProviderRecovery tags provider protocol replay mismatches', () => {
  const details = classifyProviderRecovery(
    new ProviderError(
      'deepseek',
      400,
      '{"error":{"message":"The `reasoning_content` in the thinking mode must be passed back to the API."}}',
    ),
  )
  assert.equal(details?.kind, 'provider_protocol')
  assert.equal(details?.recoveryReason, 'PROVIDER_PROTOCOL_REPLAY_MISMATCH')
  assert.equal(details?.retryable, false)
})
