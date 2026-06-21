import { eventBase, type NexusEvent } from '../../shared/events.js'
import type { ToolCallTextLeakSuppression } from './turn.js'

export function buildRuntimeResultEvent(
  sessionId: string,
  success: boolean,
  message: string,
): Extract<NexusEvent, { type: 'result' }> {
  return {
    type: 'result',
    ...eventBase(sessionId),
    success,
    message,
  }
}

export function buildRuntimeErrorEvent(options: {
  sessionId: string
  code: string
  message: string
  details?: unknown
}): Extract<NexusEvent, { type: 'error' }> {
  return {
    type: 'error',
    ...eventBase(options.sessionId),
    code: options.code,
    message: options.message,
    ...(options.details !== undefined && { details: options.details }),
  }
}

export function buildToolCallTextLeakSuppressedEvent(options: {
  sessionId: string
  providerId?: string
  modelId?: string
  suppression: ToolCallTextLeakSuppression
  retryAttempted: boolean
  retrySucceeded?: boolean
}): Extract<NexusEvent, { type: 'error' }> {
  return buildRuntimeErrorEvent({
    sessionId: options.sessionId,
    code: 'TOOL_CALL_TEXT_LEAK_SUPPRESSED',
    message: 'Suppressed tool-call-shaped assistant text while tools are unavailable for this turn.',
    details: {
      providerId: options.providerId,
      modelId: options.modelId,
      phase: options.suppression.phase,
      pattern: options.suppression.pattern,
      redactedPreview: options.suppression.redactedPreview,
      retryAttempted: options.retryAttempted,
      ...(options.retrySucceeded !== undefined && { retrySucceeded: options.retrySucceeded }),
    },
  })
}
