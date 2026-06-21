import { buildCacheHealthFromRuntimeMetrics } from './cacheHealth.js'
import { NexusMetrics, round } from './metrics.js'
import type { NexusEvent } from '../shared/events.js'
import type { NexusStorage } from '../storage/Storage.js'

type RuntimeMetricsSnapshot = ReturnType<NexusMetrics['snapshot']>

type ProviderInvocationMetrics = {
  count: number
  successCount: number
  failureCount: number
  durationMs: {
    totalMs: number
    count: number
    avgMs: number
  }
  byFailureKind: Record<string, number>
  byErrorCode: Record<string, number>
  byRole: Record<
    string,
    {
      count: number
      successCount: number
      failureCount: number
      avgDurationMs: number
    }
  >
}

type AgentLoopMetrics = {
  sessionsObserved: number
  taskSessionEventCount: number
  taskCount: number
  completedTaskCount: number
  failedTaskCount: number
  retryCount: number
  subAgentSessionCount: number
  roleStepCount: number
  roleInputTokens: number
  roleOutputTokens: number
  roleDurationMs: {
    totalMs: number
    count: number
    avgMs: number
  }
  byRole: Record<
    string,
    {
      count: number
      successCount: number
      failureCount: number
      inputTokens: number
      outputTokens: number
      avgDurationMs: number
    }
  >
  byFailureType: Record<string, number>
}

type AgentJobMetrics = {
  count: number
  completedCount: number
  failedCount: number
  cancelledCount: number
  byAgentType: Record<
    string,
    {
      count: number
      completedCount: number
      failedCount: number
      cancelledCount: number
    }
  >
  byFailureCode: Record<string, number>
}

export async function buildRuntimeMetricsSnapshot(
  metrics: NexusMetrics,
  storage: NexusStorage,
): Promise<
  RuntimeMetricsSnapshot & {
    providerInvocations: ProviderInvocationMetrics
    agentLoop: AgentLoopMetrics
    agentJobs: AgentJobMetrics
    cacheHealth: ReturnType<typeof buildCacheHealthFromRuntimeMetrics>
  }
> {
  const snapshot = metrics.snapshot()
  const recentSessions = await storage.listSessions({
    limit: 100,
    includeEvents: false,
  })
  const providerInvocations = createProviderInvocationMetrics()
  const agentLoop = createAgentLoopMetrics()
  const agentJobs = createAgentJobMetrics()

  for (const session of recentSessions) {
    const page = await storage.listEvents(session.sessionId, {
      limit: 500,
      order: 'asc',
    })
    const sawTaskSessionEvent = page.events.some(event => event.type === 'task_session_event')
    if (sawTaskSessionEvent) agentLoop.sessionsObserved += 1
    for (const event of page.events) {
      recordProviderInvocationMetrics(providerInvocations, event)
      recordAgentLoopMetrics(agentLoop, event)
      recordAgentJobMetrics(agentJobs, event)
    }
  }

  finalizeProviderInvocationMetrics(providerInvocations)
  finalizeAgentLoopMetrics(agentLoop)
  const cacheHealth = buildCacheHealthFromRuntimeMetrics({
    tokenUsage: snapshot.tokenUsage,
  })
  return {
    ...snapshot,
    providerInvocations,
    agentLoop,
    agentJobs,
    cacheHealth,
  }
}

function createProviderInvocationMetrics(): ProviderInvocationMetrics {
  return {
    count: 0,
    successCount: 0,
    failureCount: 0,
    durationMs: { totalMs: 0, count: 0, avgMs: 0 },
    byFailureKind: {},
    byErrorCode: {},
    byRole: {},
  }
}

function recordProviderInvocationMetrics(metrics: ProviderInvocationMetrics, event: NexusEvent): void {
  if (event.type !== 'hook_completed' || event.hookEvent !== 'PostInvocation') return
  const output = asRecord(event.output)
  const invocation = asRecord(output?.metadata)
  if (!invocation) return
  const success = invocation.success === true
  const role = typeof invocation.role === 'string' ? invocation.role : 'unknown'
  metrics.count += 1
  if (success) {
    metrics.successCount += 1
  } else {
    metrics.failureCount += 1
  }
  const durationMs = numberValue(invocation.durationMs)
  if (durationMs !== undefined) {
    metrics.durationMs.totalMs = round(metrics.durationMs.totalMs + durationMs)
    metrics.durationMs.count += 1
  }
  const failureKind = typeof invocation.failureKind === 'string' ? invocation.failureKind : undefined
  if (failureKind) metrics.byFailureKind[failureKind] = (metrics.byFailureKind[failureKind] ?? 0) + 1
  const errorCode = typeof invocation.errorCode === 'string' ? invocation.errorCode : undefined
  if (errorCode) metrics.byErrorCode[errorCode] = (metrics.byErrorCode[errorCode] ?? 0) + 1
  const roleMetrics = metrics.byRole[role] ?? {
    count: 0,
    successCount: 0,
    failureCount: 0,
    avgDurationMs: 0,
  }
  roleMetrics.count += 1
  if (success) roleMetrics.successCount += 1
  else roleMetrics.failureCount += 1
  if (durationMs !== undefined) {
    const previousTotal = roleMetrics.avgDurationMs * (roleMetrics.count - 1)
    roleMetrics.avgDurationMs = round((previousTotal + durationMs) / roleMetrics.count)
  }
  metrics.byRole[role] = roleMetrics
}

function finalizeProviderInvocationMetrics(metrics: ProviderInvocationMetrics): void {
  metrics.durationMs.avgMs = metrics.durationMs.count > 0 ? round(metrics.durationMs.totalMs / metrics.durationMs.count) : 0
}

function createAgentLoopMetrics(): AgentLoopMetrics {
  return {
    sessionsObserved: 0,
    taskSessionEventCount: 0,
    taskCount: 0,
    completedTaskCount: 0,
    failedTaskCount: 0,
    retryCount: 0,
    subAgentSessionCount: 0,
    roleStepCount: 0,
    roleInputTokens: 0,
    roleOutputTokens: 0,
    roleDurationMs: { totalMs: 0, count: 0, avgMs: 0 },
    byRole: {},
    byFailureType: {},
  }
}

function recordAgentLoopMetrics(metrics: AgentLoopMetrics, event: NexusEvent): void {
  if (event.type !== 'task_session_event') return
  metrics.taskSessionEventCount += 1
  if (event.eventType === 'task_created') metrics.taskCount += 1
  if (event.eventType === 'task_completed') metrics.completedTaskCount += 1
  if (event.eventType === 'sub_agent_session_started') metrics.subAgentSessionCount += 1
  if (event.eventType === 'executor_failed_error') incrementCount(metrics.byFailureType, 'executor_error')
  if (event.eventType === 'critic_failed_error') incrementCount(metrics.byFailureType, 'critic_error')
  if (event.eventType === 'subagent_failed') incrementCount(metrics.byFailureType, 'subagent_failed')
  if (event.eventType === 'subagent_cancelled') incrementCount(metrics.byFailureType, 'subagent_cancelled')
  if (event.eventType === 'agent_loop_role_step_metrics') {
    recordAgentLoopRoleStepMetrics(metrics, event.payload)
    return
  }
  if (event.eventType !== 'task_updated') return
  const payload = asRecord(event.payload)
  const task = asRecord(payload?.task) ?? asRecord(payload?.next)
  const retryCount = numberValue(task?.retryCount)
  if (retryCount !== undefined && retryCount > 0) metrics.retryCount += 1
  if (task?.status === 'failed') metrics.failedTaskCount += 1
  const review = asRecord(task?.review)
  if (review?.reviewerAgentId === 'critic' && typeof review.reason === 'string') incrementCount(metrics.byFailureType, 'critic_rejected')
  if (review?.reviewerAgentId === 'system' && review.reason === 'Executor step returned failure or crashed') incrementCount(metrics.byFailureType, 'executor_failed')
}

function recordAgentLoopRoleStepMetrics(metrics: AgentLoopMetrics, payloadValue: unknown): void {
  const payload = asRecord(payloadValue)
  if (!payload) return
  const role = typeof payload.role === 'string' ? payload.role : 'unknown'
  const durationMs = numberValue(payload.durationMs) ?? 0
  const inputTokens = numberValue(payload.inputTokens) ?? 0
  const outputTokens = numberValue(payload.outputTokens) ?? 0
  const success = payload.success === true
  metrics.roleStepCount += 1
  metrics.roleInputTokens += inputTokens
  metrics.roleOutputTokens += outputTokens
  metrics.roleDurationMs.totalMs = round(metrics.roleDurationMs.totalMs + durationMs)
  metrics.roleDurationMs.count += 1
  const roleMetrics = metrics.byRole[role] ?? {
    count: 0,
    successCount: 0,
    failureCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    avgDurationMs: 0,
  }
  roleMetrics.count += 1
  if (success) roleMetrics.successCount += 1
  else roleMetrics.failureCount += 1
  roleMetrics.inputTokens += inputTokens
  roleMetrics.outputTokens += outputTokens
  const previousTotal = roleMetrics.avgDurationMs * (roleMetrics.count - 1)
  roleMetrics.avgDurationMs = round((previousTotal + durationMs) / roleMetrics.count)
  metrics.byRole[role] = roleMetrics
  const failureType = typeof payload.failureType === 'string' ? payload.failureType : undefined
  if (failureType) incrementCount(metrics.byFailureType, failureType)
  const errorCode = typeof payload.errorCode === 'string' ? payload.errorCode : undefined
  if (errorCode) incrementCount(metrics.byFailureType, errorCode)
}

function finalizeAgentLoopMetrics(metrics: AgentLoopMetrics): void {
  metrics.roleDurationMs.avgMs = metrics.roleDurationMs.count > 0 ? round(metrics.roleDurationMs.totalMs / metrics.roleDurationMs.count) : 0
}

function createAgentJobMetrics(): AgentJobMetrics {
  return {
    count: 0,
    completedCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    byAgentType: {},
    byFailureCode: {},
  }
}

function recordAgentJobMetrics(metrics: AgentJobMetrics, event: NexusEvent): void {
  if (event.type !== 'agent_job_event') return
  if (event.eventType !== 'agent_job_completed' && event.eventType !== 'agent_job_failed' && event.eventType !== 'agent_job_cancelled') return
  metrics.count += 1
  const agentType = event.agentType
  const agentTypeMetrics = metrics.byAgentType[agentType] ?? {
    count: 0,
    completedCount: 0,
    failedCount: 0,
    cancelledCount: 0,
  }
  agentTypeMetrics.count += 1
  if (event.eventType === 'agent_job_completed') {
    metrics.completedCount += 1
    agentTypeMetrics.completedCount += 1
  } else if (event.eventType === 'agent_job_failed') {
    metrics.failedCount += 1
    agentTypeMetrics.failedCount += 1
    const error = asRecord(event.error)
    const code = typeof error?.code === 'string' ? error.code : 'unknown'
    incrementCount(metrics.byFailureCode, code)
  } else {
    metrics.cancelledCount += 1
    agentTypeMetrics.cancelledCount += 1
  }
  metrics.byAgentType[agentType] = agentTypeMetrics
}

function incrementCount(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}
