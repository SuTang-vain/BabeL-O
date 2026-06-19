import type { NexusEvent } from '../shared/events.js'

export type ExecuteResultEnvelope = {
  type: 'execute_result'
  sessionId: string
  success: boolean
  statusCode: number
  durationMs: number
  result: NexusEvent | null
  error: NexusEvent | null
  timeoutMs: number
  executeDurationMs: number
  nearTimeout: boolean
  outcome: 'success' | 'error' | 'cancelled' | 'timeout'
  events: NexusEvent[]
}

export function runtimeResultStatusCode(events: readonly NexusEvent[], errorEvent: NexusEvent | undefined): number {
  if (events.some(event => event.type === 'context_blocking')) return 413
  if (errorEvent?.type === 'error' && errorEvent.code === 'REQUEST_TIMEOUT') return 408
  return 200
}

export function buildExecuteResultEnvelope(options: {
  sessionId: string
  succeeded: boolean
  events: NexusEvent[]
  resultEvent: NexusEvent | undefined
  errorEvent: NexusEvent | undefined
  timeoutMs: number
  executeDurationMs: number
  summaryEvent: Extract<NexusEvent, { type: 'execute_summary' }>
}): ExecuteResultEnvelope {
  return {
    type: 'execute_result',
    sessionId: options.sessionId,
    success: options.succeeded,
    statusCode: runtimeResultStatusCode(options.events, options.errorEvent),
    durationMs: options.executeDurationMs,
    result: options.resultEvent ?? null,
    error: options.errorEvent ?? null,
    timeoutMs: options.timeoutMs,
    executeDurationMs: options.executeDurationMs,
    nearTimeout: options.summaryEvent.nearTimeout,
    outcome: options.summaryEvent.outcome,
    events: options.events,
  }
}
