import { runAgentLoop, type AgentStepRunner } from './agentLoop.js'
import { resetTaskQueuesForTest, listNexusTasks } from './taskQueue.js'
import { resetTaskSessionsForTest, getTaskSession } from './taskSession.js'
import { setNexusStorage } from './storageBridge.js'
import { MemoryStorage } from '../storage/MemoryStorage.js'
import type { SessionPhase } from '../shared/session.js'
import type { NexusEvent } from '../shared/events.js'
import { estimateTextTokens } from '../runtime/tokenEstimator.js'

type RoleCallCounts = {
  planner: number
  executor: number
  optimizer: number
  critic: number
}

type FailureTypeCounts = Record<string, number>

type RoleMetricTotals = Record<keyof RoleCallCounts, { durationMs: number; inputTokens: number; outputTokens: number }>

type RoleCallMetric = {
  role: keyof RoleCallCounts
  taskId?: string
  inputTokens: number
  outputTokens: number
  durationMs: number
  isSubAgent: boolean
}

type MetricCollector = {
  calls: RoleCallMetric[]
}

type AgentLoopBenchmarkCost = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  retryOverhead: {
    attempts: number
    inputTokens: number
    outputTokens: number
    totalTokens: number
    durationMs: number
  }
  subAgent: {
    sessionCount: number
    roleCalls: RoleCallCounts
    inputTokens: number
    outputTokens: number
    totalTokens: number
    durationMs: number
  }
  byRole: RoleMetricTotals
}

export type AgentLoopBenchmarkScenarioResult = {
  name: string
  live: false
  finalPhase: SessionPhase
  durationMs: number
  eventCount: number
  taskCount: number
  completedTaskCount: number
  failedTaskCount: number
  retryCount: number
  subAgentSessionCount: number
  roleCalls: RoleCallCounts
  failureTypes: FailureTypeCounts
  cost: AgentLoopBenchmarkCost
}

export type AgentLoopBenchmarkResult = {
  type: 'agent_loop_benchmark'
  schemaVersion: 2
  live: false
  timestamp: string
  totalDurationMs: number
  scenarios: AgentLoopBenchmarkScenarioResult[]
  totals: {
    roleCalls: RoleCallCounts
    failureTypes: FailureTypeCounts
    taskCount: number
    completedTaskCount: number
    failedTaskCount: number
    retryCount: number
    subAgentSessionCount: number
    cost: AgentLoopBenchmarkCost
  }
}

export async function runMockAgentLoopBenchmark(): Promise<AgentLoopBenchmarkResult> {
  const startedAt = process.hrtime.bigint()
  const scenarios = [
    await runCriticRetrySuccessScenario(),
    await runSubAgentDelegationSuccessScenario(),
    await runExecutorFailureLimitScenario(),
  ]

  return {
    type: 'agent_loop_benchmark',
    schemaVersion: 2,
    live: false,
    timestamp: new Date().toISOString(),
    totalDurationMs: round(elapsedMs(startedAt)),
    scenarios,
    totals: aggregateScenarioTotals(scenarios),
  }
}

async function runCriticRetrySuccessScenario(): Promise<AgentLoopBenchmarkScenarioResult> {
  let criticTurns = 0
  const stepRunner: AgentStepRunner = async ({ roleDefinition, input }: any): Promise<any> => {
    if (roleDefinition.role === 'planner') {
      return {
        summary: 'Retry benchmark plan',
        tasks: [{ title: 'Retryable task' }],
      }
    }
    if (roleDefinition.role === 'executor') {
      return {
        taskId: input.taskId,
        success: true,
        result: `Executor result ${criticTurns}`,
        needsReview: true,
      }
    }
    if (roleDefinition.role === 'critic') {
      criticTurns += 1
      return criticTurns === 1
        ? { approved: false, reason: 'benchmark critic rejection' }
        : { approved: true }
    }
    throw new Error(`Unexpected role ${roleDefinition.role}`)
  }

  return runScenario('critic_retry_success', stepRunner, {
    role: 'executor',
    autoApprove: false,
    maxRetriesPerTask: 3,
  })
}

async function runSubAgentDelegationSuccessScenario(): Promise<AgentLoopBenchmarkScenarioResult> {
  const stepRunner: AgentStepRunner = async ({ roleDefinition, input }: any): Promise<any> => {
    if (roleDefinition.role === 'planner') {
      return {
        summary: 'Sub-agent benchmark plan',
        tasks: [{ title: 'Parent feature work' }],
      }
    }
    if (roleDefinition.role === 'executor') {
      if (input.title === 'Parent feature work' && !input.orchestration.delegatedSubTaskIds) {
        return {
          taskId: input.taskId,
          success: true,
          result: 'Delegated benchmark work',
          needsReview: false,
          subTasks: [
            { title: 'Benchmark API child' },
            { title: 'Benchmark UI child' },
          ],
        }
      }
      return {
        taskId: input.taskId,
        success: true,
        result: `Completed ${input.title}`,
        needsReview: false,
      }
    }
    throw new Error(`Unexpected role ${roleDefinition.role}`)
  }

  return runScenario('subagent_delegation_success', stepRunner, {
    role: 'executor',
    autoApprove: true,
    enableSubAgents: true,
    maxSubAgentDepth: 1,
  })
}

async function runExecutorFailureLimitScenario(): Promise<AgentLoopBenchmarkScenarioResult> {
  const stepRunner: AgentStepRunner = async ({ roleDefinition, input }: any): Promise<any> => {
    if (roleDefinition.role === 'planner') {
      return {
        summary: 'Failure benchmark plan',
        tasks: [{ title: 'Failing task' }],
      }
    }
    if (roleDefinition.role === 'executor') {
      return {
        taskId: input.taskId,
        success: false,
        result: 'benchmark executor failure',
        needsReview: false,
      }
    }
    throw new Error(`Unexpected role ${roleDefinition.role}`)
  }

  return runScenario('executor_failure_limit', stepRunner, {
    role: 'executor',
    autoApprove: true,
    maxRetriesPerTask: 2,
  })
}

async function runScenario(
  name: string,
  stepRunner: AgentStepRunner,
  options: {
    role: 'executor' | 'optimizer'
    autoApprove: boolean
    maxRetriesPerTask?: number
    enableSubAgents?: boolean
    maxSubAgentDepth?: number
  },
): Promise<AgentLoopBenchmarkScenarioResult> {
  resetTaskQueuesForTest()
  resetTaskSessionsForTest()
  const storage = new MemoryStorage()
  setNexusStorage(storage)
  const roleCalls = emptyRoleCallCounts()
  const metrics = createMetricCollector()
  const sessionId = `benchmark-${name}`
  const startedAt = process.hrtime.bigint()

  try {
    const finalSession = await runAgentLoop({
      sessionId,
      cwd: process.cwd(),
      prompt: `Benchmark scenario: ${name}`,
      stepRunner: async <TInput, TOutput>(args: {
        roleDefinition: Parameters<AgentStepRunner>[0]['roleDefinition']
        input: TInput
      }): Promise<TOutput> => {
        incrementRoleCall(roleCalls, args.roleDefinition.role)
        const callStartedAt = process.hrtime.bigint()
        const output = await stepRunner<TInput, TOutput>(args)
        recordRoleMetric(metrics, {
          rootSessionId: sessionId,
          role: args.roleDefinition.role,
          input: args.input,
          output,
          durationMs: elapsedMs(callStartedAt),
        })
        return output
      },
      role: options.role,
      autoApprove: options.autoApprove,
      maxRetriesPerTask: options.maxRetriesPerTask,
      enableSubAgents: options.enableSubAgents,
      maxSubAgentDepth: options.maxSubAgentDepth,
    })
    const tasks = listNexusTasks(sessionId).tasks
    return {
      name,
      live: false,
      finalPhase: finalSession.phase,
      durationMs: round(elapsedMs(startedAt)),
      eventCount: finalSession.events.length,
      taskCount: tasks.length,
      completedTaskCount: tasks.filter(task => task.status === 'completed').length,
      failedTaskCount: tasks.filter(task => task.status === 'failed').length,
      retryCount: tasks.reduce((sum, task) => sum + task.retryCount, 0),
      subAgentSessionCount: countSubAgentSessions(finalSession.events),
      roleCalls,
      failureTypes: classifyScenarioFailures(finalSession.events),
      cost: buildScenarioCost(metrics, tasks.reduce((sum, task) => sum + task.retryCount, 0), countSubAgentSessions(finalSession.events)),
    }
  } finally {
    await storage.close?.()
  }
}

function classifyScenarioFailures(events: NexusEvent[]): FailureTypeCounts {
  const counts: FailureTypeCounts = {}
  for (const event of events) {
    if (event.type !== 'task_session_event') continue
    if (event.eventType === 'executor_failed_error') incrementFailure(counts, 'executor_error')
    if (event.eventType === 'critic_failed_error') incrementFailure(counts, 'critic_error')
    if (event.eventType === 'subagent_failed') incrementFailure(counts, 'subagent_failed')
    if (event.eventType === 'subagent_cancelled') incrementFailure(counts, 'subagent_cancelled')
    if (event.eventType !== 'task_updated') continue
    const payload = event.payload as { task?: { status?: string; review?: { reason?: string; reviewerAgentId?: string } } } | undefined
    const task = payload?.task
    if (task?.review?.reviewerAgentId === 'critic' && task.review.reason) incrementFailure(counts, 'critic_rejected')
    if (task?.review?.reviewerAgentId === 'system' && task.review.reason === 'Executor step returned failure or crashed') incrementFailure(counts, 'executor_failed')
  }
  return counts
}

function countSubAgentSessions(events: NexusEvent[]): number {
  return events.filter(event => event.type === 'task_session_event' && event.eventType === 'sub_agent_session_started').length
}

function aggregateScenarioTotals(scenarios: AgentLoopBenchmarkScenarioResult[]): AgentLoopBenchmarkResult['totals'] {
  const totals = {
    roleCalls: emptyRoleCallCounts(),
    failureTypes: {} as FailureTypeCounts,
    taskCount: 0,
    completedTaskCount: 0,
    failedTaskCount: 0,
    retryCount: 0,
    subAgentSessionCount: 0,
    cost: emptyCost(0, 0),
  }
  for (const scenario of scenarios) {
    totals.taskCount += scenario.taskCount
    totals.completedTaskCount += scenario.completedTaskCount
    totals.failedTaskCount += scenario.failedTaskCount
    totals.retryCount += scenario.retryCount
    totals.subAgentSessionCount += scenario.subAgentSessionCount
    for (const role of Object.keys(totals.roleCalls) as Array<keyof RoleCallCounts>) {
      totals.roleCalls[role] += scenario.roleCalls[role]
    }
    for (const [type, count] of Object.entries(scenario.failureTypes)) {
      totals.failureTypes[type] = (totals.failureTypes[type] ?? 0) + count
    }
    addCost(totals.cost, scenario.cost)
  }
  return totals
}

function createMetricCollector(): MetricCollector {
  return { calls: [] }
}

function stringifyForTokenEstimate(value: unknown): string {
  try {
    return JSON.stringify(value ?? null)
  } catch {
    return String(value)
  }
}

function recordRoleMetric(metrics: MetricCollector, options: {
  rootSessionId: string
  role: string
  input: unknown
  output: unknown
  durationMs: number
}): void {
  if (!isTrackedRole(options.role)) return
  const input = isRecord(options.input) ? options.input : {}
  const inputSessionId = typeof input.sessionId === 'string'
    ? input.sessionId
    : options.rootSessionId
  metrics.calls.push({
    role: options.role,
    taskId: typeof input.taskId === 'string' ? input.taskId : undefined,
    inputTokens: estimateTextTokens(stringifyForTokenEstimate(options.input)),
    outputTokens: estimateTextTokens(stringifyForTokenEstimate(options.output)),
    durationMs: round(options.durationMs),
    isSubAgent: inputSessionId !== options.rootSessionId,
  })
}

function buildScenarioCost(
  metrics: MetricCollector,
  retryCount: number,
  subAgentSessionCount: number,
): AgentLoopBenchmarkCost {
  const cost = emptyCost(retryCount, subAgentSessionCount)
  const rootTaskAttempts = new Map<string, number>()
  const retryCallsRemaining = { count: retryCount }
  for (const call of metrics.calls) {
    cost.inputTokens += call.inputTokens
    cost.outputTokens += call.outputTokens
    cost.totalTokens += call.inputTokens + call.outputTokens
    cost.byRole[call.role].durationMs = round(cost.byRole[call.role].durationMs + call.durationMs)
    cost.byRole[call.role].inputTokens += call.inputTokens
    cost.byRole[call.role].outputTokens += call.outputTokens
    if (call.isSubAgent) {
      cost.subAgent.roleCalls[call.role] += 1
      cost.subAgent.inputTokens += call.inputTokens
      cost.subAgent.outputTokens += call.outputTokens
      cost.subAgent.totalTokens += call.inputTokens + call.outputTokens
      cost.subAgent.durationMs = round(cost.subAgent.durationMs + call.durationMs)
    }
    if (isRetryOverheadCall(call, rootTaskAttempts, retryCallsRemaining)) {
      cost.retryOverhead.inputTokens += call.inputTokens
      cost.retryOverhead.outputTokens += call.outputTokens
      cost.retryOverhead.totalTokens += call.inputTokens + call.outputTokens
      cost.retryOverhead.durationMs = round(cost.retryOverhead.durationMs + call.durationMs)
    }
  }
  return cost
}

function isRetryOverheadCall(
  call: RoleCallMetric,
  rootTaskAttempts: Map<string, number>,
  retryCallsRemaining: { count: number },
): boolean {
  if (call.isSubAgent || (call.role !== 'executor' && call.role !== 'optimizer') || !call.taskId) return false
  const attempts = rootTaskAttempts.get(call.taskId) ?? 0
  rootTaskAttempts.set(call.taskId, attempts + 1)
  if (attempts === 0 || retryCallsRemaining.count <= 0) return false
  retryCallsRemaining.count -= 1
  return true
}

function emptyCost(retryCount: number, subAgentSessionCount: number): AgentLoopBenchmarkCost {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    retryOverhead: {
      attempts: retryCount,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      durationMs: 0,
    },
    subAgent: {
      sessionCount: subAgentSessionCount,
      roleCalls: emptyRoleCallCounts(),
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      durationMs: 0,
    },
    byRole: emptyRoleMetricTotals(),
  }
}

function addCost(target: AgentLoopBenchmarkCost, source: AgentLoopBenchmarkCost): void {
  target.inputTokens += source.inputTokens
  target.outputTokens += source.outputTokens
  target.totalTokens += source.totalTokens
  target.retryOverhead.attempts += source.retryOverhead.attempts
  target.retryOverhead.inputTokens += source.retryOverhead.inputTokens
  target.retryOverhead.outputTokens += source.retryOverhead.outputTokens
  target.retryOverhead.totalTokens += source.retryOverhead.totalTokens
  target.retryOverhead.durationMs = round(target.retryOverhead.durationMs + source.retryOverhead.durationMs)
  target.subAgent.sessionCount += source.subAgent.sessionCount
  target.subAgent.inputTokens += source.subAgent.inputTokens
  target.subAgent.outputTokens += source.subAgent.outputTokens
  target.subAgent.totalTokens += source.subAgent.totalTokens
  target.subAgent.durationMs = round(target.subAgent.durationMs + source.subAgent.durationMs)
  for (const role of Object.keys(target.subAgent.roleCalls) as Array<keyof RoleCallCounts>) {
    target.subAgent.roleCalls[role] += source.subAgent.roleCalls[role]
    target.byRole[role].durationMs = round(target.byRole[role].durationMs + source.byRole[role].durationMs)
    target.byRole[role].inputTokens += source.byRole[role].inputTokens
    target.byRole[role].outputTokens += source.byRole[role].outputTokens
  }
}

function emptyRoleMetricTotals(): RoleMetricTotals {
  return {
    planner: { durationMs: 0, inputTokens: 0, outputTokens: 0 },
    executor: { durationMs: 0, inputTokens: 0, outputTokens: 0 },
    optimizer: { durationMs: 0, inputTokens: 0, outputTokens: 0 },
    critic: { durationMs: 0, inputTokens: 0, outputTokens: 0 },
  }
}

function emptyRoleCallCounts(): RoleCallCounts {
  return {
    planner: 0,
    executor: 0,
    optimizer: 0,
    critic: 0,
  }
}

function incrementRoleCall(counts: RoleCallCounts, role: string): void {
  if (isTrackedRole(role)) {
    counts[role] += 1
  }
}

function isTrackedRole(role: string): role is keyof RoleCallCounts {
  return role === 'planner' || role === 'executor' || role === 'optimizer' || role === 'critic'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function incrementFailure(counts: FailureTypeCounts, type: string): void {
  counts[type] = (counts[type] ?? 0) + 1
}

function elapsedMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1_000_000
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
