import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runMockAgentLoopBenchmark } from '../src/nexus/agentLoopBenchmark.js'

test('mock AgentLoop benchmark reports cost and failure metrics without live provider', async () => {
  const result = await runMockAgentLoopBenchmark()

  assert.equal(result.type, 'agent_loop_benchmark')
  assert.equal(result.live, false)
  assert.equal(result.schemaVersion, 2)
  assert.ok(result.totalDurationMs >= 0)
  assert.equal(result.scenarios.length, 3)

  const success = result.scenarios.find(scenario => scenario.name === 'critic_retry_success')
  assert.ok(success)
  assert.equal(success.finalPhase, 'completed')
  assert.equal(success.roleCalls.planner, 1)
  assert.equal(success.roleCalls.executor, 2)
  assert.equal(success.roleCalls.critic, 2)
  assert.equal(success.failureTypes.critic_rejected, 1)
  assert.equal(success.retryCount, 1)
  assert.equal(success.cost.retryOverhead.attempts, 1)
  assert.ok(success.cost.retryOverhead.totalTokens > 0)
  assert.ok(success.cost.byRole.executor.inputTokens > 0)
  assert.ok(success.cost.byRole.critic.outputTokens > 0)

  const subAgent = result.scenarios.find(scenario => scenario.name === 'subagent_delegation_success')
  assert.ok(subAgent)
  assert.equal(subAgent.finalPhase, 'completed')
  assert.equal(subAgent.subAgentSessionCount, 2)
  assert.equal(subAgent.roleCalls.executor, 4)
  assert.equal(subAgent.cost.subAgent.sessionCount, 2)
  assert.equal(subAgent.cost.subAgent.roleCalls.executor, 2)
  assert.ok(subAgent.cost.subAgent.totalTokens > 0)

  const failure = result.scenarios.find(scenario => scenario.name === 'executor_failure_limit')
  assert.ok(failure)
  assert.equal(failure.finalPhase, 'failed')
  assert.equal(failure.failureTypes.executor_failed, 2)
  assert.equal(failure.failedTaskCount, 1)
  assert.equal(failure.cost.retryOverhead.attempts, 2)
  assert.equal(failure.cost.retryOverhead.totalTokens > 0, true)

  assert.equal(result.totals.roleCalls.planner, 3)
  assert.equal(result.totals.roleCalls.executor, 8)
  assert.equal(result.totals.roleCalls.critic, 2)
  assert.equal(result.totals.failureTypes.critic_rejected, 1)
  assert.equal(result.totals.failureTypes.executor_failed, 2)
  assert.equal(result.totals.cost.retryOverhead.attempts, 3)
  assert.equal(result.totals.cost.subAgent.sessionCount, 2)
  assert.equal(result.totals.cost.totalTokens, result.totals.cost.inputTokens + result.totals.cost.outputTokens)
})
