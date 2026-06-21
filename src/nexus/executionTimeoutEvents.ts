import { eventBase, type NexusEvent } from '../shared/events.js'
import type { NexusStorage } from '../storage/Storage.js'
import type { ExecuteTimeoutDecision } from './executionPreparation.js'

export const EXECUTE_TIMEOUT_NEAR_RATIO = 0.8

export type TimeoutEventSender = (event: NexusEvent) => void

export type SoftTimeoutCycleHandle = {
  cancel(): void
}

export type ExecutionTimeoutControls = {
  effectiveTimeoutMs: number
  cancel(): void
}

export function startExecutionTimeoutControls(state: {
  storage: NexusStorage
  events: NexusEvent[]
  sessionId: string
  requestId: string
  timeoutDecision: ExecuteTimeoutDecision
  startedAtMs: number
  now: () => number
  send?: TimeoutEventSender
}): ExecutionTimeoutControls {
  const effectiveTimeoutMs = state.timeoutDecision.softTimeoutMs
  const nearTimeoutWatcher = startNearTimeoutWatcher({
    storage: state.storage,
    events: state.events,
    sessionId: state.sessionId,
    requestId: state.requestId,
    timeoutMs: effectiveTimeoutMs,
    startedAtMs: state.startedAtMs,
    now: state.now,
    send: state.send,
  })
  const softTimeoutCycle =
    state.timeoutDecision.policy === 'soft'
      ? scheduleSoftTimeoutCycle({
          storage: state.storage,
          events: state.events,
          sessionId: state.sessionId,
          requestId: state.requestId,
          softTimeoutMs: effectiveTimeoutMs,
          startedAtMs: state.startedAtMs,
          maxExtensions: state.timeoutDecision.maxSoftTimeoutExtensions,
          extensionMs: state.timeoutDecision.softTimeoutExtensionMs,
          now: state.now,
          send: state.send,
        })
      : undefined

  return {
    effectiveTimeoutMs,
    cancel(): void {
      clearTimeout(nearTimeoutWatcher)
      softTimeoutCycle?.cancel()
    },
  }
}

export function hasPartialTimeoutEvidence(events: readonly NexusEvent[]): boolean {
  return events.some(
    event => (event.type === 'assistant_delta' && event.text.trim().length > 0) || event.type === 'tool_completed' || event.type === 'tool_denied' || event.type === 'permission_response',
  )
}

export function buildPartialTimeoutSummary(events: readonly NexusEvent[]): string | undefined {
  const assistantText = events
    .filter((event): event is Extract<NexusEvent, { type: 'assistant_delta' }> => event.type === 'assistant_delta')
    .map(event => event.text)
    .join('')
    .trim()
  if (assistantText) {
    return truncateForTimeoutSummary(assistantText)
  }
  const toolEvidence = events
    .filter((event): event is Extract<NexusEvent, { type: 'tool_completed' | 'tool_denied' }> => event.type === 'tool_completed' || event.type === 'tool_denied')
    .map(event => {
      if (event.type === 'tool_denied') return `${event.name} denied: ${event.message}`
      return `${event.name} ${event.success ? 'completed' : 'failed'}`
    })
  if (toolEvidence.length > 0) {
    return truncateForTimeoutSummary(`Tool evidence before timeout: ${toolEvidence.slice(-3).join('; ')}`)
  }
  return undefined
}

export function executeTimeoutNear(durationMs: number, timeoutMs: number): boolean {
  if (timeoutMs <= 0) return false
  return durationMs / timeoutMs >= EXECUTE_TIMEOUT_NEAR_RATIO
}

export async function appendNearTimeoutWarning(state: {
  storage: NexusStorage
  events: NexusEvent[]
  sessionId: string
  requestId: string
  timeoutMs: number
  elapsedMs: number
  send?: TimeoutEventSender
}): Promise<void> {
  if (state.events.some(event => event.type === 'near_timeout_warning')) return
  if (!executeTimeoutNear(state.elapsedMs, state.timeoutMs)) return
  if (!hasPartialTimeoutEvidence(state.events)) return
  const warning = buildNearTimeoutWarningEvent({
    sessionId: state.sessionId,
    requestId: state.requestId,
    timeoutMs: state.timeoutMs,
    elapsedMs: state.elapsedMs,
    partialSummary: buildPartialTimeoutSummary(state.events),
  })
  state.events.push(warning)
  await state.storage.appendEvent(state.sessionId, warning)
  state.send?.(warning)
}

export function startNearTimeoutWatcher(state: {
  storage: NexusStorage
  events: NexusEvent[]
  sessionId: string
  requestId: string
  timeoutMs: number
  startedAtMs: number
  now: () => number
  send?: TimeoutEventSender
}): ReturnType<typeof setTimeout> {
  const delayMs = Math.max(0, Math.floor(state.timeoutMs * EXECUTE_TIMEOUT_NEAR_RATIO))
  return setTimeout(() => {
    void appendNearTimeoutWarning({
      ...state,
      elapsedMs: Math.max(0, Math.round(state.now() - state.startedAtMs)),
    })
  }, delayMs)
}

export function scheduleSoftTimeoutCycle(state: {
  storage: NexusStorage
  events: NexusEvent[]
  sessionId: string
  requestId: string
  softTimeoutMs: number
  startedAtMs: number
  maxExtensions: number
  extensionMs: number
  now: () => number
  send?: TimeoutEventSender
}): SoftTimeoutCycleHandle {
  let cancelled = false
  let currentTimer: ReturnType<typeof setTimeout> | undefined
  let extensionCount = 0
  let currentBudgetMs = state.softTimeoutMs

  const fire = async (): Promise<void> => {
    if (cancelled) return
    const elapsedMs = Math.max(0, Math.round(state.now() - state.startedAtMs))
    await appendTimeoutBudgetExceededForCycle({
      storage: state.storage,
      events: state.events,
      sessionId: state.sessionId,
      requestId: state.requestId,
      currentBudgetMs,
      elapsedMs,
      send: state.send,
    })
    if (cancelled) return
    if (extensionCount >= state.maxExtensions) return
    extensionCount += 1
    const additionalMs = state.extensionMs
    currentBudgetMs += additionalMs
    await appendTimeoutExtensionGranted({
      storage: state.storage,
      events: state.events,
      sessionId: state.sessionId,
      requestId: state.requestId,
      extensionCount,
      maxExtensions: state.maxExtensions,
      additionalMs,
      totalSoftBudgetMs: currentBudgetMs,
      elapsedMs,
      send: state.send,
    })
    if (cancelled) return
    const nextDelayMs = Math.max(0, additionalMs)
    currentTimer = setTimeout(() => {
      void fire()
    }, nextDelayMs)
  }

  const initialDelayMs = Math.max(0, state.softTimeoutMs)
  currentTimer = setTimeout(() => {
    void fire()
  }, initialDelayMs)

  return {
    cancel(): void {
      cancelled = true
      if (currentTimer !== undefined) clearTimeout(currentTimer)
    },
  }
}

export async function appendTimeoutPartialResult(options: {
  storage: NexusStorage
  sessionId: string
  events: NexusEvent[]
  resultEvent: NexusEvent | undefined
  errorEvent: NexusEvent | undefined
  send?: TimeoutEventSender
}): Promise<Extract<NexusEvent, { type: 'result' }> | undefined> {
  if (options.errorEvent?.type !== 'error' || options.errorEvent.code !== 'REQUEST_TIMEOUT') return undefined
  const baseMessage = options.resultEvent?.type === 'result' ? options.resultEvent.message : options.errorEvent.message
  const message = buildTimeoutPartialResultMessage(baseMessage, options.events)
  if (message === baseMessage) return undefined
  const partialResult: Extract<NexusEvent, { type: 'result' }> = {
    type: 'result',
    ...eventBase(options.sessionId),
    success: false,
    message,
  }
  options.events.push(partialResult)
  await options.storage.appendEvent(options.sessionId, partialResult)
  options.send?.(partialResult)
  return partialResult
}

export function buildExecuteSummaryEvent(options: {
  sessionId: string
  requestId?: string
  timeoutMs: number
  executeDurationMs: number
  outcome: 'success' | 'error' | 'cancelled' | 'timeout'
}): Extract<NexusEvent, { type: 'execute_summary' }> {
  return {
    type: 'execute_summary',
    ...eventBase(options.sessionId),
    ...(options.requestId !== undefined && { requestId: options.requestId }),
    timeoutMs: options.timeoutMs,
    executeDurationMs: options.executeDurationMs,
    nearTimeout: executeTimeoutNear(options.executeDurationMs, options.timeoutMs),
    outcome: options.outcome,
  }
}

async function appendTimeoutBudgetExceededForCycle(state: {
  storage: NexusStorage
  events: NexusEvent[]
  sessionId: string
  requestId: string
  currentBudgetMs: number
  elapsedMs: number
  send?: TimeoutEventSender
}): Promise<void> {
  const dup = state.events.some(event => event.type === 'timeout_budget_exceeded' && event.timeoutMs === state.currentBudgetMs)
  if (dup) return
  const event = buildTimeoutBudgetExceededEvent({
    sessionId: state.sessionId,
    requestId: state.requestId,
    timeoutMs: state.currentBudgetMs,
    elapsedMs: state.elapsedMs,
    partialSummary: buildPartialTimeoutSummary(state.events),
  })
  state.events.push(event)
  await state.storage.appendEvent(state.sessionId, event)
  state.send?.(event)
}

async function appendTimeoutExtensionGranted(state: {
  storage: NexusStorage
  events: NexusEvent[]
  sessionId: string
  requestId: string
  extensionCount: number
  maxExtensions: number
  additionalMs: number
  totalSoftBudgetMs: number
  elapsedMs: number
  send?: TimeoutEventSender
}): Promise<void> {
  const event = buildTimeoutExtensionGrantedEvent({
    sessionId: state.sessionId,
    requestId: state.requestId,
    extensionCount: state.extensionCount,
    maxExtensions: state.maxExtensions,
    additionalMs: state.additionalMs,
    totalSoftBudgetMs: state.totalSoftBudgetMs,
    elapsedMs: state.elapsedMs,
  })
  state.events.push(event)
  await state.storage.appendEvent(state.sessionId, event)
  state.send?.(event)
}

function truncateForTimeoutSummary(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > 800 ? `${normalized.slice(0, 797)}...` : normalized
}

function buildNearTimeoutWarningEvent(options: {
  sessionId: string
  requestId?: string
  timeoutMs: number
  elapsedMs: number
  partialSummary?: string
}): Extract<NexusEvent, { type: 'near_timeout_warning' }> {
  const message = options.partialSummary ? 'Execution is near its timeout budget; preserve a concise partial answer now.' : 'Execution is near its timeout budget; wrap up as soon as possible.'
  return {
    type: 'near_timeout_warning',
    ...eventBase(options.sessionId),
    ...(options.requestId !== undefined && { requestId: options.requestId }),
    timeoutMs: options.timeoutMs,
    elapsedMs: options.elapsedMs,
    thresholdRatio: EXECUTE_TIMEOUT_NEAR_RATIO,
    ...(options.partialSummary !== undefined && {
      partialSummary: options.partialSummary,
    }),
    message,
  }
}

function buildTimeoutBudgetExceededEvent(options: {
  sessionId: string
  requestId?: string
  timeoutMs: number
  elapsedMs: number
  partialSummary?: string
}): Extract<NexusEvent, { type: 'timeout_budget_exceeded' }> {
  const message = options.partialSummary
    ? 'Soft timeout budget exhausted; the workflow continues — summarize, narrow scope, or continue with a fresh budget.'
    : 'Soft timeout budget exhausted; the workflow continues — pick a next step (continue / summarize / narrow scope / retry_last_tool).'
  return {
    type: 'timeout_budget_exceeded',
    ...eventBase(options.sessionId),
    ...(options.requestId !== undefined && { requestId: options.requestId }),
    timeoutMs: options.timeoutMs,
    elapsedMs: options.elapsedMs,
    policy: 'soft',
    ...(options.partialSummary !== undefined && {
      partialSummary: options.partialSummary,
    }),
    suggestedActions: ['continue', 'summarize', 'narrow_scope', 'retry_last_tool'],
    message,
  }
}

function buildTimeoutExtensionGrantedEvent(options: {
  sessionId: string
  requestId?: string
  extensionCount: number
  maxExtensions: number
  additionalMs: number
  totalSoftBudgetMs: number
  elapsedMs: number
}): Extract<NexusEvent, { type: 'timeout_extension_granted' }> {
  const reason: 'auto-first-budget-exhausted' | 'auto-followup-budget-exhausted' = options.extensionCount === 1 ? 'auto-first-budget-exhausted' : 'auto-followup-budget-exhausted'
  const remaining = Math.max(0, options.maxExtensions - options.extensionCount)
  const message =
    remaining > 0
      ? `Soft timeout extended by ${options.additionalMs}ms (extension ${options.extensionCount}/${options.maxExtensions}; ${remaining} remaining). Pick a deliberate next step.`
      : `Soft timeout extended by ${options.additionalMs}ms (extension ${options.extensionCount}/${options.maxExtensions}; this is the last automatic extension). Wrap up or request user confirmation before the watchdog fires.`
  return {
    type: 'timeout_extension_granted',
    ...eventBase(options.sessionId),
    ...(options.requestId !== undefined && { requestId: options.requestId }),
    extensionCount: options.extensionCount,
    maxExtensions: options.maxExtensions,
    additionalMs: options.additionalMs,
    totalSoftBudgetMs: options.totalSoftBudgetMs,
    elapsedMs: options.elapsedMs,
    policy: 'soft',
    reason,
    message,
  }
}

function buildTimeoutPartialResultMessage(baseMessage: string, events: readonly NexusEvent[]): string {
  const partialSummary = buildPartialTimeoutSummary(events)
  if (!partialSummary) return baseMessage
  return `${baseMessage}\n\nPartial result preserved before timeout:\n${partialSummary}`
}
