import type { SessionSnapshot } from '../shared/session.js'
import type { NexusTask } from '../shared/task.js'
import { EXECUTOR_ROLE, OPTIMIZER_ROLE } from './agentRoles.js'

export type AgentSubTask = {
  title: string
  description?: string
  requiresIsolation?: boolean
  metadata?: Record<string, unknown>
}

export type SubAgentApprovalInheritanceOptions = {
  inheritSessionApprovals?: boolean
  sessionApprovalAllowTools?: string[]
}

export type SubAgentLifecycleMetadata = {
  agentId: string
  parentAgentId: string
  parentSessionId: string
  parentTaskId: string
  depth: number
  agentType: 'subagent'
  role: 'executor' | 'optimizer'
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  transcriptPath: string
  permissionInheritance: {
    mode: 'role_policy'
    inheritedAllowRules: string[]
    inheritsOnceApprovals: false
    inheritsSessionApprovals: boolean
    inheritedSessionApprovalTools: string[]
    requiresApproval: boolean
  }
}

export function getSubAgentStatus(metadata?: Record<string, unknown>): string | undefined {
  const subAgent = metadata?.subAgent
  if (typeof subAgent !== 'object' || subAgent === null) return undefined
  if (!('status' in subAgent) || typeof subAgent.status !== 'string') return undefined
  return subAgent.status
}

export function buildPreviousSubAgentsMetadata(
  task: NexusTask,
  executorResult?: { metadata?: Record<string, unknown> } | null,
): Record<string, unknown> {
  const subAgent = executorResult?.metadata?.subAgent
  if (typeof subAgent !== 'object' || subAgent === null) return {}
  const status = (subAgent as { status?: unknown }).status
  if (status !== 'failed' && status !== 'cancelled') return {}
  const previous = Array.isArray(task.metadata?.previousSubAgents)
    ? task.metadata.previousSubAgents
    : []
  return {
    previousSubAgents: [...previous, subAgent],
  }
}

export function buildSubAgentSessionId(parentSessionId: string, task: NexusTask): string {
  return task.retryCount > 0
    ? `${parentSessionId}-sub-${task.taskId}-retry-${task.retryCount}`
    : `${parentSessionId}-sub-${task.taskId}`
}

export function buildSubAgentLifecycleMetadata(options: {
  parentSessionId: string
  subSessionId: string
  task: NexusTask
  role: 'executor' | 'optimizer'
  approvalInheritance?: SubAgentApprovalInheritanceOptions
}): SubAgentLifecycleMetadata {
  const depth = getTaskDepth(options.task)
  const agentId = `${options.parentSessionId}:subagent:${options.task.taskId}`
  const inheritedAllowRules = roleAllowedTools(options.role)
  const inheritedSessionApprovalTools = resolveInheritedSessionApprovalTools(
    inheritedAllowRules,
    options.approvalInheritance,
  )
  return {
    agentId,
    parentAgentId: options.parentSessionId,
    parentSessionId: options.parentSessionId,
    parentTaskId: String(options.task.metadata?.parentTaskId ?? options.task.taskId),
    depth,
    agentType: 'subagent',
    role: options.role,
    status: 'running',
    transcriptPath: `nexus://sessions/${options.subSessionId}/events`,
    permissionInheritance: {
      mode: 'role_policy',
      inheritedAllowRules,
      inheritsOnceApprovals: false,
      inheritsSessionApprovals: inheritedSessionApprovalTools.length > 0,
      inheritedSessionApprovalTools,
      requiresApproval: roleRequiresApproval(options.role),
    },
  }
}

export function getTaskSessionEventRange(session: SessionSnapshot): { firstEventId?: string; lastEventId?: string; eventCount: number } {
  const first = session.events[0]
  const last = session.events.at(-1)
  return {
    firstEventId: first && 'eventId' in first ? first.eventId : undefined,
    lastEventId: last && 'eventId' in last ? last.eventId : undefined,
    eventCount: session.events.length,
  }
}

export function summarizeSubAgentSession(session: SessionSnapshot): string {
  if (session.result) return session.result
  if (session.terminalReason?.message) return session.terminalReason.message
  return session.phase === 'completed'
    ? 'Completed successfully via sub-agent session'
    : `Sub-agent session ended with phase ${session.phase}`
}

export function toParentSubAgentReference(metadata: SubAgentLifecycleMetadata & Record<string, unknown>, subSessionId: string): Record<string, unknown> {
  return {
    agentId: metadata.agentId,
    subSessionId,
    parentTaskId: metadata.parentTaskId,
    depth: metadata.depth,
    status: metadata.status,
    transcriptPath: metadata.transcriptPath,
    resultEventRange: metadata.resultEventRange,
    summary: metadata.summary,
  }
}

export function buildTaskOrchestrationContext(
  task: NexusTask,
  enableSubAgents: boolean,
  maxSubAgentDepth: number,
): {
  enableSubAgents: boolean
  currentDepth: number
  maxDepth: number
  remainingDepth: number
  delegatedSubTaskIds?: string[]
} {
  const currentDepth = getTaskDepth(task)
  return {
    enableSubAgents,
    currentDepth,
    maxDepth: maxSubAgentDepth,
    remainingDepth: Math.max(0, maxSubAgentDepth - currentDepth),
    delegatedSubTaskIds: getDelegatedSubTaskIds(task),
  }
}

export function normalizeSubTasks(
  subTasks: AgentSubTask[],
  maxSubTasksPerTask: number,
): AgentSubTask[] {
  const seenTitles = new Set<string>()
  const normalized: AgentSubTask[] = []
  for (const subTask of subTasks) {
    const title = subTask.title.trim()
    if (!title || seenTitles.has(title)) continue
    seenTitles.add(title)
    normalized.push({
      ...subTask,
      title,
      description: subTask.description?.trim() || undefined,
    })
    if (normalized.length >= maxSubTasksPerTask) break
  }
  return normalized
}

export function getTaskDepth(task: NexusTask): number {
  const rawDepth = task.metadata?.depth
  return typeof rawDepth === 'number' && Number.isInteger(rawDepth) && rawDepth >= 0
    ? rawDepth
    : 0
}

function roleAllowedTools(role: 'executor' | 'optimizer'): string[] {
  const roleDefinition = role === 'optimizer' ? OPTIMIZER_ROLE : EXECUTOR_ROLE
  return [...roleDefinition.toolPolicy.allowedTools]
}

function resolveInheritedSessionApprovalTools(
  inheritedAllowRules: string[],
  approvalInheritance?: SubAgentApprovalInheritanceOptions,
): string[] {
  if (!approvalInheritance?.inheritSessionApprovals) return []
  const requested = approvalInheritance.sessionApprovalAllowTools?.length
    ? approvalInheritance.sessionApprovalAllowTools
    : inheritedAllowRules
  return Array.from(new Set(requested.filter(tool => inheritedAllowRules.includes(tool)))).sort()
}

function roleRequiresApproval(role: 'executor' | 'optimizer'): boolean {
  const roleDefinition = role === 'optimizer' ? OPTIMIZER_ROLE : EXECUTOR_ROLE
  return roleDefinition.toolPolicy.requiresApproval
}

function getDelegatedSubTaskIds(task: NexusTask): string[] | undefined {
  const rawIds = task.metadata?.delegatedSubTaskIds
  if (!Array.isArray(rawIds)) return undefined
  const ids = rawIds.filter(id => typeof id === 'string')
  return ids.length > 0 ? ids : undefined
}
