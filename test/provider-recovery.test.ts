import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProviderError } from '../src/shared/errors.js'
import { classifyProviderRecovery, planProviderFallbackAction } from '../src/runtime/providerRecovery.js'

test('classifyProviderRecovery tags max output token failures', () => {
  const details = classifyProviderRecovery(
    new ProviderError('anthropic', 400, '{"error":{"message":"stop_reason max_tokens"}}'),
  )
  assert.equal(details?.kind, 'max_output_tokens')
  assert.equal(details?.recoveryReason, 'ESCALATED_MAX_TOKENS')
  assert.equal(details?.retryable, true)
  assert.equal(details?.fallbackPolicy.mode, 'manual_confirm')
  assert.equal(details?.fallbackPolicy.allowSilentModelSwitch, false)
})

test('classifyProviderRecovery tags OpenAI length finish failures as max output', () => {
  const details = classifyProviderRecovery(
    new ProviderError('openai', 400, '{"choices":[{"finish_reason":"length"}]}'),
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
  assert.equal(details?.fallbackPolicy.mode, 'compact_then_retry')
  assert.equal(details?.fallbackPolicy.allowSilentModelSwitch, false)
})

test('classifyProviderRecovery tags provider-specific context window failures', () => {
  const cases = [
    ['minimax', '{"base_resp":{"status_code":1004,"status_msg":"tokens exceed context size limit"}}'],
    ['deepseek', '{"error":{"code":"context_length_exceeded","message":"Input context too long"}}'],
    ['zhipu', '{"error":{"code":1301,"message":"The token count exceeds context window"}}'],
  ] as const

  for (const [providerId, rawMessage] of cases) {
    const details = classifyProviderRecovery(new ProviderError(providerId, 400, rawMessage))
    assert.equal(details?.kind, 'context_window', providerId)
    assert.equal(details?.recoveryReason, 'ESCALATED_CONTEXT_WINDOW', providerId)
    assert.equal(details?.fallbackPolicy.mode, 'compact_then_retry', providerId)
  }
})

test('classifyProviderRecovery tags auth and billing failures as non-retryable', () => {
  const details = classifyProviderRecovery(
    new ProviderError('openai', 402, '{"error":{"message":"Insufficient Balance"}}'),
  )
  assert.equal(details?.kind, 'auth_or_billing')
  assert.equal(details?.recoveryReason, 'PROVIDER_AUTH_OR_BILLING')
  assert.equal(details?.retryable, false)
  assert.equal(details?.fallbackPolicy.mode, 'fix_configuration')
  assert.equal(details?.fallbackPolicy.allowSilentModelSwitch, false)
})

test('ProviderError preserves provider-specific error metadata', () => {
  const error = new ProviderError('openai', 401, JSON.stringify({
    error: {
      code: 'invalid_api_key',
      type: 'authentication_error',
      message: 'Incorrect API key provided.',
    },
    request_id: 'req_provider_789',
  }))

  assert.deepEqual(error.metadata, {
    code: 'invalid_api_key',
    type: 'authentication_error',
    message: 'Incorrect API key provided.',
    requestId: 'req_provider_789',
  })
  assert.match(error.message, /code=invalid_api_key/)
  assert.match(error.message, /request_id=req_provider_789/)
})

test('ProviderError normalizes auth failures with a configuration hint', () => {
  const error = new ProviderError('minimax', 401, JSON.stringify({
    error: {
      type: 'authentication_error',
      message: 'Please carry the API secret key',
    },
    request_id: 'req_auth_123',
  }))

  assert.match(error.message, /Provider 'minimax' returned 401/)
  assert.match(error.message, /no\/invalid API key/)
  assert.match(error.message, /bbl config add minimax <KEY>/)
  assert.match(error.message, /request_id=req_auth_123/)
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
  assert.equal(details?.fallbackPolicy.mode, 'no_auto_fallback')
  assert.equal(details?.fallbackPolicy.allowSilentModelSwitch, false)
})

test('planProviderFallbackAction returns an auditable non-executing action', () => {
  const recovery = classifyProviderRecovery(
    new ProviderError('openai', 400, '{"error":{"code":"context_length_exceeded"}}'),
  )
  assert.ok(recovery)

  const plan = planProviderFallbackAction({
    provider: {
      providerId: 'openai',
      providerName: 'OpenAI-compatible',
      adapter: 'openai-compatible',
      authMode: 'bearer',
      authConfigured: true,
      authSource: 'env',
      baseUrl: 'https://api.openai.com/v1',
      baseUrlSource: 'provider_default',
      modelId: 'openai/gpt-4o',
      modelName: 'GPT-4o',
      modelSource: 'default',
      contextWindow: 128000,
      defaultMaxTokens: 16384,
      capabilities: {
        toolCalling: true,
        jsonOutput: true,
        structuredOutput: true,
        streaming: true,
      },
      modelDeclared: true,
      capabilitySource: 'registry',
      suitability: {
        longContext: true,
        toolCalling: true,
        structuredOutput: true,
        streaming: true,
        agentLoopRoles: {
          planner: { role: 'planner', suitable: true, missingCapabilities: [] },
          executor: { role: 'executor', suitable: true, missingCapabilities: [] },
          critic: { role: 'critic', suitable: true, missingCapabilities: [] },
          optimizer: { role: 'optimizer', suitable: true, missingCapabilities: [] },
        },
      },
    },
    recovery,
  })

  assert.equal(plan.type, 'provider_fallback_plan')
  assert.equal(plan.fallbackPolicy.mode, 'compact_then_retry')
  assert.equal(plan.fallbackPolicy.allowSilentModelSwitch, false)
  assert.equal(plan.diagnostic.domain, 'provider')
  assert.equal(plan.diagnostic.name, 'provider_fallback_plan')
  assert.equal(plan.diagnostic.details.recoveryKind, 'context_window')
  assert.equal(plan.diagnostic.action?.allowSilentModelSwitch, false)
  assert.equal(plan.action.requiresUserConfirmation, true)
  assert.equal(plan.action.willSwitchModel, false)
  assert.equal(plan.action.willSwitchProvider, false)
  assert.equal(plan.action.willMutateConfig, false)
  assert.equal(plan.action.willCallProvider, false)
  assert.equal(plan.action.willCreateSession, false)
})

test('planProviderFallbackAction preserves explicit retry_same_model recovery kind', () => {
  const plan = planProviderFallbackAction({
    provider: {
      providerId: 'openai',
      providerName: 'OpenAI-compatible',
      adapter: 'openai-compatible',
      authMode: 'bearer',
      authConfigured: true,
      authSource: 'env',
      baseUrl: 'https://api.openai.com/v1',
      baseUrlSource: 'provider_default',
      modelId: 'openai/gpt-4o',
      modelName: 'GPT-4o',
      modelSource: 'default',
      contextWindow: 128000,
      defaultMaxTokens: 16384,
      capabilities: {
        toolCalling: true,
        jsonOutput: true,
        structuredOutput: true,
        streaming: true,
      },
      modelDeclared: true,
      capabilitySource: 'registry',
      suitability: {
        longContext: true,
        toolCalling: true,
        structuredOutput: true,
        streaming: true,
        agentLoopRoles: {
          planner: { role: 'planner', suitable: true, missingCapabilities: [] },
          executor: { role: 'executor', suitable: true, missingCapabilities: [] },
          critic: { role: 'critic', suitable: true, missingCapabilities: [] },
          optimizer: { role: 'optimizer', suitable: true, missingCapabilities: [] },
        },
      },
    },
    recoveryKind: 'rate_limit',
  })

  assert.equal(plan.fallbackPolicy.mode, 'retry_same_model')
  assert.equal(plan.diagnostic.details.recoveryKind, 'rate_limit')
})
