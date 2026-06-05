import { withRetry } from '../providers/retry.js'
import { classifyProviderRecovery, type ProviderFallbackPolicy } from '../runtime/providerRecovery.js'
import { estimateTextTokens } from '../runtime/tokenEstimator.js'
import { ProviderError } from '../shared/errors.js'
import { runMockAgentLoopBenchmark, type AgentLoopBenchmarkResult } from './agentLoopBenchmark.js'

export type RetryPolicyFailureType =
  | 'rate_limit'
  | 'provider_unavailable'
  | 'empty_response'
  | 'schema_mismatch'
  | 'tool_protocol_error'

export type RetryPolicyScenarioResult = {
  name: string
  domain: 'provider' | 'runtime'
  failureType: RetryPolicyFailureType
  policyMode: ProviderFallbackPolicy['mode'] | 'output_retry' | 'structured_output_repair'
  retryable: boolean
  attempts: number
  retryCount: number
  maxRetries: number
  finalSuccess: boolean
  finalErrorCode?: string
  durationMs: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  retryOverheadTokens: number
  retryOverheadDurationMs: number
}

export type RetryPolicyFailureTotals = {
  scenarios: number
  successes: number
  failures: number
  attempts: number
  retryCount: number
  retryOverheadTokens: number
  retryOverheadDurationMs: number
}

export type RetryPolicyAgentLoopSummary = {
  source: 'mock_agent_loop_benchmark'
  schemaVersion: AgentLoopBenchmarkResult['schemaVersion']
  scenarioCount: number
  successRate: number
  retryCount: number
  retryOverheadAttempts: number
  retryOverheadTokens: number
  retryOverheadDurationMs: number
  failureTypes: Record<string, number>
  roleCalls: AgentLoopBenchmarkResult['totals']['roleCalls']
}

export type RetryPolicyBenchmarkResult = {
  type: 'retry_policy_benchmark'
  schemaVersion: 1
  live: false
  timestamp: string
  scenarios: RetryPolicyScenarioResult[]
  totals: {
    scenarioCount: number
    successCount: number
    failedCount: number
    successRate: number
    attempts: number
    retryCount: number
    retryOverheadTokens: number
    retryOverheadDurationMs: number
    byFailureType: Record<string, RetryPolicyFailureTotals>
  }
  agentLoop: RetryPolicyAgentLoopSummary
}

export async function runRetryPolicyBenchmark(options: {
  agentLoop?: AgentLoopBenchmarkResult
} = {}): Promise<RetryPolicyBenchmarkResult> {
  const agentLoop = options.agentLoop ?? await runMockAgentLoopBenchmark()
  const scenarios = [
    await runProviderErrorScenario({
      name: 'rate_limit_retry_success',
      failureType: 'rate_limit',
      error: () => new ProviderError('mock-provider', 429, '{"error":{"message":"rate limit"}}'),
      maxRetries: 2,
      retryableStatuses: [429, 500, 502, 503, 529],
      succeedOnAttempt: 2,
    }),
    await runProviderErrorScenario({
      name: 'provider_unavailable_retry_exhausted',
      failureType: 'provider_unavailable',
      error: () => new ProviderError('mock-provider', 503, '{"error":{"message":"service unavailable"}}'),
      maxRetries: 2,
      retryableStatuses: [429, 500, 502, 503, 529],
    }),
    runEmptyResponseScenario(),
    runSchemaMismatchScenario(),
    await runProviderErrorScenario({
      name: 'tool_protocol_error_no_auto_retry',
      failureType: 'tool_protocol_error',
      error: () => new ProviderError('deepseek', 400, '{"error":{"message":"reasoning_content tool_call_id mismatch"}}'),
      maxRetries: 2,
      retryableStatuses: [429, 500, 502, 503, 529],
    }),
  ]

  return {
    type: 'retry_policy_benchmark',
    schemaVersion: 1,
    live: false,
    timestamp: new Date().toISOString(),
    scenarios,
    totals: aggregateScenarioTotals(scenarios),
    agentLoop: summarizeAgentLoopRetries(agentLoop),
  }
}

async function runProviderErrorScenario(options: {
  name: string
  failureType: RetryPolicyFailureType
  error: () => ProviderError
  maxRetries: number
  retryableStatuses: number[]
  succeedOnAttempt?: number
}): Promise<RetryPolicyScenarioResult> {
  const recovery = classifyProviderRecovery(options.error())
  const attemptTokens: Array<{ input: number; output: number; durationMs: number }> = []
  const startedAt = process.hrtime.bigint()
  let attempts = 0
  let finalSuccess = false
  let finalErrorCode: string | undefined

  try {
    await withRetry(async () => {
      attempts += 1
      const callStartedAt = process.hrtime.bigint()
      const shouldSucceed = options.succeedOnAttempt !== undefined && attempts >= options.succeedOnAttempt
      attemptTokens.push(tokenUsageForAttempt({
        name: options.name,
        attempt: attempts,
        output: shouldSucceed ? 'mock provider success' : options.error().rawMessage,
        durationMs: elapsedMs(callStartedAt),
      }))
      if (!shouldSucceed) throw options.error()
      return 'ok'
    }, {
      maxRetries: options.maxRetries,
      baseDelayMs: 0,
      maxDelayMs: 0,
      retryableStatuses: options.retryableStatuses,
    })
    finalSuccess = true
  } catch (error) {
    finalErrorCode = error instanceof ProviderError ? `HTTP_${error.httpStatus}` : 'PROVIDER_ERROR'
  }

  return buildScenarioResult({
    name: options.name,
    domain: 'provider',
    failureType: options.failureType,
    policyMode: recovery?.fallbackPolicy.mode ?? 'no_auto_fallback',
    retryable: recovery?.retryable ?? false,
    maxRetries: options.maxRetries,
    finalSuccess,
    finalErrorCode,
    durationMs: elapsedMs(startedAt),
    attemptTokens,
  })
}

function runEmptyResponseScenario(): RetryPolicyScenarioResult {
  const maxRetries = 2
  const attempts = maxRetries + 1
  const startedAt = process.hrtime.bigint()
  const attemptTokens = Array.from({ length: attempts }, (_, index) => tokenUsageForAttempt({
    name: 'empty_response_retry_exhausted',
    attempt: index + 1,
    output: '',
    durationMs: 0,
  }))

  return buildScenarioResult({
    name: 'empty_response_retry_exhausted',
    domain: 'runtime',
    failureType: 'empty_response',
    policyMode: 'output_retry',
    retryable: true,
    maxRetries,
    finalSuccess: false,
    finalErrorCode: 'EMPTY_PROVIDER_RESPONSE',
    durationMs: elapsedMs(startedAt),
    attemptTokens,
  })
}

function runSchemaMismatchScenario(): RetryPolicyScenarioResult {
  const startedAt = process.hrtime.bigint()
  const attemptTokens = [
    tokenUsageForAttempt({
      name: 'schema_mismatch_repair_success',
      attempt: 1,
      output: '{"summary":"missing required tasks"}',
      durationMs: 0,
    }),
    tokenUsageForAttempt({
      name: 'schema_mismatch_repair_success',
      attempt: 2,
      output: '{"summary":"repaired","tasks":[{"title":"retry benchmark"}]}',
      durationMs: 0,
    }),
  ]

  return buildScenarioResult({
    name: 'schema_mismatch_repair_success',
    domain: 'runtime',
    failureType: 'schema_mismatch',
    policyMode: 'structured_output_repair',
    retryable: true,
    maxRetries: 1,
    finalSuccess: true,
    durationMs: elapsedMs(startedAt),
    attemptTokens,
  })
}

function buildScenarioResult(options: {
  name: string
  domain: RetryPolicyScenarioResult['domain']
  failureType: RetryPolicyFailureType
  policyMode: RetryPolicyScenarioResult['policyMode']
  retryable: boolean
  maxRetries: number
  finalSuccess: boolean
  finalErrorCode?: string
  durationMs: number
  attemptTokens: Array<{ input: number; output: number; durationMs: number }>
}): RetryPolicyScenarioResult {
  const attempts = options.attemptTokens.length
  const inputTokens = options.attemptTokens.reduce((sum, attempt) => sum + attempt.input, 0)
  const outputTokens = options.attemptTokens.reduce((sum, attempt) => sum + attempt.output, 0)
  const retryOverheadTokens = options.attemptTokens
    .slice(1)
    .reduce((sum, attempt) => sum + attempt.input + attempt.output, 0)
  const retryOverheadDurationMs = options.attemptTokens
    .slice(1)
    .reduce((sum, attempt) => sum + attempt.durationMs, 0)

  return {
    name: options.name,
    domain: options.domain,
    failureType: options.failureType,
    policyMode: options.policyMode,
    retryable: options.retryable,
    attempts,
    retryCount: Math.max(0, attempts - 1),
    maxRetries: options.maxRetries,
    finalSuccess: options.finalSuccess,
    finalErrorCode: options.finalErrorCode,
    durationMs: round(options.durationMs),
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    retryOverheadTokens,
    retryOverheadDurationMs: round(retryOverheadDurationMs),
  }
}

function tokenUsageForAttempt(options: {
  name: string
  attempt: number
  output: string
  durationMs: number
}): { input: number; output: number; durationMs: number } {
  return {
    input: estimateTextTokens(`retry policy benchmark ${options.name} attempt ${options.attempt}`),
    output: estimateTextTokens(options.output),
    durationMs: round(options.durationMs),
  }
}

function aggregateScenarioTotals(scenarios: RetryPolicyScenarioResult[]): RetryPolicyBenchmarkResult['totals'] {
  const byFailureType: Record<string, RetryPolicyFailureTotals> = {}
  for (const scenario of scenarios) {
    const entry = byFailureType[scenario.failureType] ?? {
      scenarios: 0,
      successes: 0,
      failures: 0,
      attempts: 0,
      retryCount: 0,
      retryOverheadTokens: 0,
      retryOverheadDurationMs: 0,
    }
    entry.scenarios += 1
    entry.successes += scenario.finalSuccess ? 1 : 0
    entry.failures += scenario.finalSuccess ? 0 : 1
    entry.attempts += scenario.attempts
    entry.retryCount += scenario.retryCount
    entry.retryOverheadTokens += scenario.retryOverheadTokens
    entry.retryOverheadDurationMs = round(entry.retryOverheadDurationMs + scenario.retryOverheadDurationMs)
    byFailureType[scenario.failureType] = entry
  }
  const successCount = scenarios.filter(scenario => scenario.finalSuccess).length
  return {
    scenarioCount: scenarios.length,
    successCount,
    failedCount: scenarios.length - successCount,
    successRate: round(successCount / scenarios.length),
    attempts: scenarios.reduce((sum, scenario) => sum + scenario.attempts, 0),
    retryCount: scenarios.reduce((sum, scenario) => sum + scenario.retryCount, 0),
    retryOverheadTokens: scenarios.reduce((sum, scenario) => sum + scenario.retryOverheadTokens, 0),
    retryOverheadDurationMs: round(scenarios.reduce((sum, scenario) => sum + scenario.retryOverheadDurationMs, 0)),
    byFailureType,
  }
}

function summarizeAgentLoopRetries(agentLoop: AgentLoopBenchmarkResult): RetryPolicyAgentLoopSummary {
  const completed = agentLoop.scenarios.filter(scenario => scenario.finalPhase === 'completed').length
  return {
    source: 'mock_agent_loop_benchmark',
    schemaVersion: agentLoop.schemaVersion,
    scenarioCount: agentLoop.scenarios.length,
    successRate: round(completed / agentLoop.scenarios.length),
    retryCount: agentLoop.totals.retryCount,
    retryOverheadAttempts: agentLoop.totals.cost.retryOverhead.attempts,
    retryOverheadTokens: agentLoop.totals.cost.retryOverhead.totalTokens,
    retryOverheadDurationMs: agentLoop.totals.cost.retryOverhead.durationMs,
    failureTypes: agentLoop.totals.failureTypes,
    roleCalls: agentLoop.totals.roleCalls,
  }
}

function elapsedMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1_000_000
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
