import { runAgentLoop, type AgentStepRunner } from './agentLoop.js'
import { resetTaskQueuesForTest, listNexusTasks } from './taskQueue.js'
import { resetTaskSessionsForTest, getTaskSession } from './taskSession.js'
import { setNexusStorage } from './storageBridge.js'
import { MemoryStorage } from '../storage/MemoryStorage.js'
import type { SessionPhase } from '../shared/session.js'
import type { NexusEvent } from '../shared/events.js'

type RoleCallCounts = {
  planner: number
  executor: number
  optimizer: number
  critic: number
}

type FailureTypeCounts = Record<string, number>

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
}

export type AgentLoopBenchmarkResult = {
  type: 'agent_loop_benchmark'
  schemaVersion: 1
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
    schemaVersion: 1,
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
  const sessionId = `benchmark-${name}`
  const startedAt = process.hrtime.bigint()

  try {
    const finalSession = await runAgentLoop({
      sessionId,
      cwd: process.cwd(),
      prompt: `Benchmark scenario: ${name}`,
      stepRunner: async args => {
        incrementRoleCall(roleCalls, args.roleDefinition.role)
        return stepRunner(args)
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
  }
  return totals
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
  if (role === 'planner' || role === 'executor' || role === 'optimizer' || role === 'critic') {
    counts[role] += 1
  }
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
