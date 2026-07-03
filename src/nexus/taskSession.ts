import type { NexusEvent } from '../shared/events.js'
import type {
  SessionSnapshot,
  SessionPhase,
  TaskSessionTerminalReason,
  TaskSessionInputRequest,
} from '../shared/session.js'
import { persistTaskSessionMutation } from './storageBridge.js'

export class TaskSessionError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'TaskSessionError'
  }
}

const taskSessions = new Map<string, SessionSnapshot>()
const TERMINAL_SESSION_PHASES = new Set<SessionPhase>([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
])
const TERMINAL_SESSION_TTL_MS = 24 * 60 * 60 * 1000
const TERMINAL_SESSION_SWEEP_INTERVAL_MS = 60 * 60 * 1000

function now(): string {
  return new Date().toISOString()
}

function appendTaskSessionEvent(
  session: SessionSnapshot,
  type: string,
  payload?: unknown,
): NexusEvent {
  const eventId = `${session.sessionId}:${session.events.length + 1}`
  const event: NexusEvent = {
    type: 'task_session_event',
    schemaVersion: '2026-05-21.babel-o.v1',
    sessionId: session.sessionId,
    eventId,
    eventType: type,
    phase: session.phase,
    timestamp: now(),
    payload,
  }
  session.events.push(event)
  session.updatedAt = event.timestamp
  return event
}

function snapshotAndPersist(
  session: SessionSnapshot,
  event?: NexusEvent,
): SessionSnapshot {
  persistTaskSessionMutation({
    session,
    event,
  })
  return session
}

export function createTaskSession(options: {
  sessionId: string
  cwd?: string
  prompt?: string
  queueId?: string
  parentSessionId?: string
  assignedAgentId?: string
  currentTaskId?: string
  metadata?: Record<string, unknown>
}): SessionSnapshot {
  const existing = taskSessions.get(options.sessionId)
  if (existing) {
    return updateTaskSession(options.sessionId, {
      cwd: options.cwd,
      queueId: options.queueId,
      parentSessionId: options.parentSessionId,
      assignedAgentId: options.assignedAgentId,
      currentTaskId: options.currentTaskId,
      metadata: options.metadata,
    })
  }

  const timestamp = now()
  const session: SessionSnapshot = {
    sessionId: options.sessionId,
    cwd: options.cwd ?? '',
    prompt: options.prompt ?? '',
    phase: 'created',
    createdAt: timestamp,
    updatedAt: timestamp,
    events: [],
    queueId: options.queueId,
    parentSessionId: options.parentSessionId,
    assignedAgentId: options.assignedAgentId,
    currentTaskId: options.currentTaskId,
    metadata: options.metadata,
  }

  taskSessions.set(options.sessionId, session)
  const event = appendTaskSessionEvent(session, 'task_session_created', {
    cwd: options.cwd,
    queueId: options.queueId,
    parentSessionId: options.parentSessionId,
    assignedAgentId: options.assignedAgentId,
    currentTaskId: options.currentTaskId,
    metadata: options.metadata,
  })

  return snapshotAndPersist(session, event)
}

export function updateTaskSession(
  sessionId: string,
  updates: Partial<
    Pick<
      SessionSnapshot,
      | 'cwd'
      | 'prompt'
      | 'queueId'
      | 'parentSessionId'
      | 'assignedAgentId'
      | 'currentTaskId'
      | 'metadata'
    >
  >,
): SessionSnapshot {
  const session = getMutableTaskSession(sessionId)
  Object.assign(session, updates)
  const event = appendTaskSessionEvent(session, 'task_session_updated', updates)
  return snapshotAndPersist(session, event)
}

export function recordTaskSessionEvent(
  sessionId: string,
  type: string,
  payload?: unknown,
): SessionSnapshot {
  const session = getMutableTaskSession(sessionId)
  const event = appendTaskSessionEvent(session, type, payload)
  return snapshotAndPersist(session, event)
}

export function setTaskSessionPhase(
  sessionId: string,
  phase: SessionPhase,
  payload?: unknown,
): SessionSnapshot {
  const session = getMutableTaskSession(sessionId)
  session.phase = phase
  const event = appendTaskSessionEvent(
    session,
    'task_session_phase_changed',
    payload,
  )
  return snapshotAndPersist(session, event)
}

export function requestTaskSessionInput(
  sessionId: string,
  inputRequest: TaskSessionInputRequest,
): SessionSnapshot {
  const session = getMutableTaskSession(sessionId)
  session.phase = 'waiting_user'
  session.pendingInput = inputRequest
  const event = appendTaskSessionEvent(
    session,
    'task_session_input_requested',
    inputRequest,
  )
  return snapshotAndPersist(session, event)
}

export function submitTaskSessionInput(
  sessionId: string,
  input: {
    message: string
    metadata?: Record<string, unknown>
    nextPhase?: Exclude<SessionPhase, 'created' | 'waiting_user'>
  },
): SessionSnapshot {
  const session = getMutableTaskSession(sessionId)
  session.pendingInput = undefined
  session.lastUserInput = input.message
  session.phase = input.nextPhase ?? 'planning'
  const event = appendTaskSessionEvent(session, 'task_session_input_submitted', {
    message: input.message,
    metadata: input.metadata,
    nextPhase: session.phase,
  })
  return snapshotAndPersist(session, event)
}

export function recordTaskSessionNexusEvent(
  sessionId: string,
  event: NexusEvent,
): SessionSnapshot {
  const session = getMutableTaskSession(sessionId)
  const nextPhase = phaseForNexusEvent(event)
  if (nextPhase) {
    session.phase = nextPhase
  }

  // push to inner event stream
  session.events.push(event)

  if (event.type === 'result') {
    session.result = event.message
  }
  if (event.type === 'error') {
    session.error = event.message
    session.failureReason = event.message
    session.terminalReason = {
      category: terminalCategoryForCode(event.code),
      code: event.code,
      message: event.message,
    }
  }

  const taskSessionEvent = appendTaskSessionEvent(
    session,
    `nexus_${event.type}`,
    event,
  )
  return snapshotAndPersist(session, taskSessionEvent)
}

export function failTaskSession(
  sessionId: string,
  error: unknown,
  reason?: Partial<TaskSessionTerminalReason>,
): SessionSnapshot {
  const session = getMutableTaskSession(sessionId)
  session.phase = 'failed'
  session.error = error instanceof Error ? error.message : String(error)
  session.failureReason = session.error
  session.terminalReason = normalizeTerminalReason(error, {
    category: reason?.category ?? 'error',
    code: reason?.code,
    message: reason?.message,
  })
  const event = appendTaskSessionEvent(session, 'task_session_failed', {
    error: session.failureReason,
    reason: session.terminalReason,
  })
  return snapshotAndPersist(session, event)
}

export function cancelTaskSession(
  sessionId: string,
  reason = 'cancelled',
  code = 'REQUEST_CANCELLED',
): SessionSnapshot {
  const session = getMutableTaskSession(sessionId)
  session.phase = 'cancelled'
  session.terminalReason = {
    category: reason === 'timeout' ? 'timeout' : 'cancelled',
    code: reason === 'timeout' ? 'REQUEST_TIMEOUT' : code,
    message:
      reason === 'timeout'
        ? 'Nexus request timed out'
        : 'Nexus request was cancelled',
  }
  const event = appendTaskSessionEvent(session, 'task_session_cancelled', {
    reason,
    terminalReason: session.terminalReason,
  })
  return snapshotAndPersist(session, event)
}

export function getTaskSession(sessionId: string): SessionSnapshot {
  return getMutableTaskSession(sessionId)
}

export function listTaskSessions(): SessionSnapshot[] {
  return Array.from(taskSessions.values())
}

export function resetTaskSessionsForTest(): void {
  taskSessions.clear()
}

export function clearTaskSession(sessionId: string): boolean {
  return taskSessions.delete(sessionId)
}

export function pruneTaskSessions(options: {
  olderThanMs?: number
  nowMs?: number
} = {}): number {
  const olderThanMs = options.olderThanMs ?? TERMINAL_SESSION_TTL_MS
  const nowMs = options.nowMs ?? Date.now()
  let pruned = 0

  for (const [sessionId, session] of taskSessions.entries()) {
    if (!TERMINAL_SESSION_PHASES.has(session.phase)) continue
    const updatedAtMs = Date.parse(session.updatedAt)
    if (!Number.isFinite(updatedAtMs)) continue
    if (nowMs - updatedAtMs < olderThanMs) continue
    taskSessions.delete(sessionId)
    pruned += 1
  }

  return pruned
}

const taskSessionSweeper = setInterval(() => {
  pruneTaskSessions()
}, TERMINAL_SESSION_SWEEP_INTERVAL_MS)
taskSessionSweeper.unref?.()

export function taskSessionStatsForTest(): { sessions: number } {
  return {
    sessions: taskSessions.size,
  }
}

export function hydrateTaskSessions(sessions: SessionSnapshot[]): void {
  taskSessions.clear()
  for (const snapshot of sessions) {
    taskSessions.set(snapshot.sessionId, { ...snapshot })
  }
}

export const hydrateTaskSessionsForTest = hydrateTaskSessions

function getMutableTaskSession(sessionId: string): SessionSnapshot {
  const session = taskSessions.get(sessionId)
  if (!session) {
    throw new TaskSessionError(
      `TaskSession not found: ${sessionId}`,
      'TASK_SESSION_NOT_FOUND',
      404,
    )
  }
  return session
}

function phaseForNexusEvent(event: NexusEvent): SessionPhase | null {
  if (event.type === 'session_started') return 'executing'
  if (event.type === 'result') return event.success ? 'completed' : 'failed'
  if (event.type === 'error') return 'failed'
  return null
}

function normalizeTerminalReason(
  error: unknown,
  reason: Partial<TaskSessionTerminalReason>,
): TaskSessionTerminalReason {
  const fallbackMessage = error instanceof Error ? error.message : String(error)
  const code =
    reason.code ??
    (typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
      ? error.code
      : 'NEXUS_RUNTIME_ERROR')
  return {
    category: reason.category ?? 'error',
    code,
    message: reason.message ?? fallbackMessage,
  }
}

function terminalCategoryForCode(
  code: string,
): TaskSessionTerminalReason['category'] {
  if (code === 'REQUEST_TIMEOUT') return 'timeout'
  if (code === 'REQUEST_CANCELLED') return 'cancelled'
  if (code.startsWith('PROVIDER_')) return 'provider'
  if (code.startsWith('RUNTIME_') || code === 'NEXUS_RUNTIME_ERROR') {
    return 'runtime'
  }
  return 'error'
}
