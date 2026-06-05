import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runMockAgentLoopBenchmark } from '../src/nexus/agentLoopBenchmark.js'
import { runRetryPolicyBenchmark } from '../src/nexus/retryPolicyBenchmark.js'

test('retry policy benchmark reports retry cost and failure diagnostics without live provider', async () => {
  const agentLoop = await runMockAgentLoopBenchmark()
  const result = await runRetryPolicyBenchmark({ agentLoop })

  assert.equal(result.type, 'retry_policy_benchmark')
  assert.equal(result.schemaVersion, 1)
  assert.equal(result.live, false)
  assert.equal(result.scenarios.length, 5)

  const scenarios = Object.fromEntries(result.scenarios.map(scenario => [scenario.name, scenario]))
  assert.deepEqual(Object.keys(scenarios).sort(), [
    'empty_response_retry_exhausted',
    'provider_unavailable_retry_exhausted',
    'rate_limit_retry_success',
    'schema_mismatch_repair_success',
    'tool_protocol_error_no_auto_retry',
  ])

  assert.equal(scenarios.rate_limit_retry_success?.failureType, 'rate_limit')
  assert.equal(scenarios.rate_limit_retry_success?.policyMode, 'retry_same_model')
  assert.equal(scenarios.rate_limit_retry_success?.retryable, true)
  assert.equal(scenarios.rate_limit_retry_success?.attempts, 2)
  assert.equal(scenarios.rate_limit_retry_success?.retryCount, 1)
  assert.equal(scenarios.rate_limit_retry_success?.finalSuccess, true)
  assert.ok((scenarios.rate_limit_retry_success?.retryOverheadTokens ?? 0) > 0)

  assert.equal(scenarios.provider_unavailable_retry_exhausted?.failureType, 'provider_unavailable')
  assert.equal(scenarios.provider_unavailable_retry_exhausted?.policyMode, 'retry_same_model')
  assert.equal(scenarios.provider_unavailable_retry_exhausted?.retryable, true)
  assert.equal(scenarios.provider_unavailable_retry_exhausted?.attempts, 3)
  assert.equal(scenarios.provider_unavailable_retry_exhausted?.retryCount, 2)
  assert.equal(scenarios.provider_unavailable_retry_exhausted?.finalSuccess, false)
  assert.equal(scenarios.provider_unavailable_retry_exhausted?.finalErrorCode, 'HTTP_503')

  assert.equal(scenarios.empty_response_retry_exhausted?.domain, 'runtime')
  assert.equal(scenarios.empty_response_retry_exhausted?.failureType, 'empty_response')
  assert.equal(scenarios.empty_response_retry_exhausted?.policyMode, 'output_retry')
  assert.equal(scenarios.empty_response_retry_exhausted?.attempts, 3)
  assert.equal(scenarios.empty_response_retry_exhausted?.finalErrorCode, 'EMPTY_PROVIDER_RESPONSE')

  assert.equal(scenarios.schema_mismatch_repair_success?.failureType, 'schema_mismatch')
  assert.equal(scenarios.schema_mismatch_repair_success?.policyMode, 'structured_output_repair')
  assert.equal(scenarios.schema_mismatch_repair_success?.retryCount, 1)
  assert.equal(scenarios.schema_mismatch_repair_success?.finalSuccess, true)

  assert.equal(scenarios.tool_protocol_error_no_auto_retry?.failureType, 'tool_protocol_error')
  assert.equal(scenarios.tool_protocol_error_no_auto_retry?.policyMode, 'no_auto_fallback')
  assert.equal(scenarios.tool_protocol_error_no_auto_retry?.retryable, false)
  assert.equal(scenarios.tool_protocol_error_no_auto_retry?.attempts, 1)
  assert.equal(scenarios.tool_protocol_error_no_auto_retry?.finalErrorCode, 'HTTP_400')

  assert.equal(result.totals.scenarioCount, 5)
  assert.equal(result.totals.successCount, 2)
  assert.equal(result.totals.failedCount, 3)
  assert.equal(result.totals.successRate, 0.4)
  assert.equal(result.totals.attempts, 11)
  assert.equal(result.totals.retryCount, 6)
  assert.ok(result.totals.retryOverheadTokens > 0)
  assert.equal(result.totals.byFailureType.rate_limit.successes, 1)
  assert.equal(result.totals.byFailureType.provider_unavailable.failures, 1)
  assert.equal(result.totals.byFailureType.empty_response.retryCount, 2)
  assert.equal(result.totals.byFailureType.schema_mismatch.successes, 1)
  assert.equal(result.totals.byFailureType.tool_protocol_error.retryCount, 0)

  assert.equal(result.agentLoop.source, 'mock_agent_loop_benchmark')
  assert.equal(result.agentLoop.schemaVersion, agentLoop.schemaVersion)
  assert.equal(result.agentLoop.scenarioCount, agentLoop.scenarios.length)
  assert.equal(result.agentLoop.retryCount, agentLoop.totals.retryCount)
  assert.equal(result.agentLoop.retryOverheadAttempts, agentLoop.totals.cost.retryOverhead.attempts)
  assert.equal(result.agentLoop.retryOverheadTokens, agentLoop.totals.cost.retryOverhead.totalTokens)
  assert.deepEqual(result.agentLoop.failureTypes, agentLoop.totals.failureTypes)
})
