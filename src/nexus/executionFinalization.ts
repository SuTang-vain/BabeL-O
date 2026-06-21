import type { NexusEvent } from '../shared/events.js'
import { nowIso } from '../shared/id.js'
import type { TaskSessionTerminalReason } from '../shared/session.js'
import type { NexusStorage } from '../storage/Storage.js'
import { appendTimeoutPartialResult, buildExecuteSummaryEvent, type TimeoutEventSender } from './executionTimeoutEvents.js'

export type ExecutionFinalizationOptions = {
  succeeded: boolean
  resultEvent?: NexusEvent
  errorEvent?: NexusEvent
  contextBlockingEvent?: NexusEvent
}

export type ExecutionSettlementResult = {
  resultEvent: NexusEvent | undefined
  errorEvent: NexusEvent | undefined
  partialResultEvent: Extract<NexusEvent, { type: 'result' }> | undefined
  recoveredFromToolDenial: boolean
  succeeded: boolean
  timeoutEvent: boolean
  executeDurationMs: number
  summaryEvent: Extract<NexusEvent, { type: 'execute_summary' }>
}

export async function settleExecutionSession(options: {
  storage: NexusStorage
  sessionId: string
  requestId?: string
  events: NexusEvent[]
  timedOut: boolean
  timeoutMs: number
  startedAtMs: number
  now: () => number
  send?: TimeoutEventSender
  initialSucceeded?: boolean
}): Promise<ExecutionSettlementResult> {
  let resultEvent = options.events.findLast(event => event.type === 'result')
  const errorEvent = options.events.findLast(event => event.type === 'error')
  const timeoutEvent = errorEvent?.type === 'error' && errorEvent.code === 'REQUEST_TIMEOUT'
  const partialResultEvent = await appendTimeoutPartialResult({
    storage: options.storage,
    sessionId: options.sessionId,
    events: options.events,
    resultEvent,
    errorEvent,
    send: options.send,
  })
  resultEvent = partialResultEvent ?? resultEvent
  const recoveredFromToolDenial = isRecoverableToolDenialOnlyTurn(options.events, resultEvent, errorEvent, options.timedOut)
  let succeeded =
    options.initialSucceeded ??
    (!options.timedOut && !errorEvent && ((resultEvent?.type === 'result' && resultEvent.success) || recoveredFromToolDenial))
  if (options.initialSucceeded !== undefined) {
    if (partialResultEvent) succeeded = false
    if (recoveredFromToolDenial) succeeded = true
  }
  await finalizeExecutionSession(options.storage, options.sessionId, {
    succeeded,
    resultEvent,
    errorEvent,
    contextBlockingEvent: options.events.find(event => event.type === 'context_blocking'),
  })
  const executeDurationMs = Math.max(0, Math.round(options.now() - options.startedAtMs))
  const summaryEvent = buildExecuteSummaryEvent({
    sessionId: options.sessionId,
    requestId: options.requestId,
    timeoutMs: options.timeoutMs,
    executeDurationMs,
    outcome: executeSummaryOutcome(resultEvent, errorEvent, options.timedOut, recoveredFromToolDenial),
  })
  options.events.push(summaryEvent)
  await options.storage.appendEvent(options.sessionId, summaryEvent)
  options.send?.(summaryEvent)

  return {
    resultEvent,
    errorEvent,
    partialResultEvent,
    recoveredFromToolDenial,
    succeeded,
    timeoutEvent,
    executeDurationMs,
    summaryEvent,
  }
}

export async function finalizeExecutionSession(storage: NexusStorage, sessionId: string, finalization: ExecutionFinalizationOptions): Promise<void> {
  const session = await storage.getSession(sessionId, { includeEvents: false })
  if (!session) return

  if (session.phase !== 'cancelled') {
    session.phase = finalization.succeeded ? 'completed' : 'failed'
  }
  session.updatedAt = nowIso()

  if (finalization.resultEvent?.type === 'result') {
    session.result = finalization.resultEvent.message
  }

  if (finalization.succeeded) {
    session.error = undefined
    session.failureReason = undefined
    session.terminalReason = undefined
    session.metadata = withRuntimeRecoveryMetadata(session.metadata)
  } else if (finalization.errorEvent?.type === 'error') {
    session.error = finalization.errorEvent.message
    session.failureReason = finalization.errorEvent.message
    session.terminalReason = runtimeTerminalReason(finalization.errorEvent)
    session.metadata = withRuntimeRecoveryMetadata(session.metadata, runtimeRecoveryMetadata(finalization.errorEvent, finalization.contextBlockingEvent))
  } else {
    session.metadata = withRuntimeRecoveryMetadata(session.metadata)
  }

  await storage.saveSession(session)
}

export function executeSummaryOutcome(
  resultEvent: NexusEvent | undefined,
  errorEvent: NexusEvent | undefined,
  timedOutByAbort: boolean,
  recoveredFromToolDenial = false,
): 'success' | 'error' | 'cancelled' | 'timeout' {
  if (errorEvent?.type === 'error' && errorEvent.code === 'REQUEST_TIMEOUT') return 'timeout'
  if (errorEvent?.type === 'error' && errorEvent.code === 'REQUEST_CANCELLED') return 'cancelled'
  if (timedOutByAbort) return 'cancelled'
  if (errorEvent?.type === 'error') return 'error'
  if (resultEvent?.type === 'result' && resultEvent.success) return 'success'
  if (recoveredFromToolDenial) return 'success'
  return 'error'
}

export function isRecoverableToolDenialOnlyTurn(events: readonly NexusEvent[], resultEvent: NexusEvent | undefined, errorEvent: NexusEvent | undefined, timedOutByAbort: boolean): boolean {
  if (timedOutByAbort || errorEvent?.type === 'error') return false
  if (resultEvent?.type !== 'result' || resultEvent.success) return false
  const denials = events.filter((event): event is Extract<NexusEvent, { type: 'tool_denied' }> => event.type === 'tool_denied')
  if (denials.length === 0) return false
  return denials.every(event => event.recoverable === true && event.terminal !== true)
}

function runtimeTerminalReason(event: Extract<NexusEvent, { type: 'error' }>): TaskSessionTerminalReason {
  return {
    category: runtimeTerminalCategoryForCode(event.code),
    code: event.code,
    message: event.message,
  }
}

function runtimeTerminalCategoryForCode(code: string): TaskSessionTerminalReason['category'] {
  if (code === 'REQUEST_TIMEOUT') return 'timeout'
  if (code === 'REQUEST_CANCELLED') return 'cancelled'
  if (code.startsWith('PROVIDER_')) return 'provider'
  if (code === 'CONTEXT_LIMIT_EXCEEDED' || code.startsWith('RUNTIME_') || code === 'NEXUS_RUNTIME_ERROR') return 'runtime'
  return 'error'
}

function runtimeRecoveryMetadata(errorEvent: Extract<NexusEvent, { type: 'error' }>, contextBlockingEvent?: NexusEvent): Record<string, unknown> | undefined {
  if (errorEvent.code !== 'CONTEXT_LIMIT_EXCEEDED') return undefined
  const details = asRecord(errorEvent.details)
  const blocking = contextBlockingEvent?.type === 'context_blocking' ? contextBlockingEvent : undefined
  return {
    kind: typeof details?.kind === 'string' ? details.kind : 'context_window',
    code: errorEvent.code,
    retryable: typeof details?.retryable === 'boolean' ? details.retryable : true,
    recoveryReason: typeof details?.recoveryReason === 'string' ? details.recoveryReason : 'CONTEXT_BLOCKING_LIMIT',
    httpStatus: numberValue(details?.httpStatus) ?? blocking?.httpStatus ?? 413,
    tokenEstimate: blocking?.tokenEstimate ?? numberValue(details?.tokenEstimate),
    maxTokens: blocking?.maxTokens ?? numberValue(details?.maxTokens),
    blockingLimitTokens: blocking?.blockingLimitTokens ?? numberValue(details?.blockingLimitTokens),
    recoveryActions: recoveryActionsValue(blocking?.recoveryActions ?? details?.recoveryActions),
    suggestion: typeof details?.suggestion === 'string' ? details.suggestion : 'Run /compact or /context, switch to a larger context model, or reduce tool output before retrying.',
  }
}

function withRuntimeRecoveryMetadata(metadata: Record<string, unknown> | undefined, runtimeRecovery?: Record<string, unknown>): Record<string, unknown> | undefined {
  const next = { ...(metadata ?? {}) }
  delete next.runtimeRecovery
  if (runtimeRecovery) next.runtimeRecovery = runtimeRecovery
  return Object.keys(next).length > 0 ? next : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function recoveryActionsValue(value: unknown): string[] {
  const allowed = new Set(['compact', 'context', 'switch_model', 'reduce_tool_output'])
  const actions = Array.isArray(value) ? value.filter((action): action is string => typeof action === 'string' && allowed.has(action)) : []
  return actions.length > 0 ? actions : ['compact', 'context', 'switch_model', 'reduce_tool_output']
}
