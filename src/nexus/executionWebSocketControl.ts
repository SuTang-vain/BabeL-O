import { PendingPermissionRegistry } from '../shared/session.js'
import type { NexusEvent } from '../shared/events.js'
import { logger } from '../shared/logger.js'

export type WebSocketLike = {
  OPEN: number
  readyState: number
  bufferedAmount: number
  send(payload: string): void
}

export type WebSocketCloseTrackable = WebSocketLike & {
  once(event: 'close', listener: () => void): void
  off(event: 'close', listener: () => void): void
}

export type PermissionResponseResolver = {
  resolve(
    sessionId: string,
    toolUseId: string,
    decision: {
      approved: boolean
      reason?: string
      scope?: 'once' | 'session' | 'rule'
      rule?: string
      feedback?: string
    },
  ): void
}

export type StreamMetricsRecorder = {
  recordStreamEvent(bufferedAmount: number): void
}

export type WebSocketClientCloseTracker = {
  readonly closedByClient: boolean
  cleanup(): void
}

export type ProcessedRuntimeEventForForwarding = {
  event: NexusEvent
  cacheHealthEvent?: NexusEvent
}

export type ForwardProcessedRuntimeEventResult = {
  event: NexusEvent
  forwarded: boolean
  closed: boolean
}

export function parseJsonObject(raw: Buffer): unknown {
  try {
    return JSON.parse(String(raw))
  } catch {
    return {}
  }
}

export function sendJson(socket: WebSocketLike, value: unknown): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(value))
  }
}

export function trackWebSocketClientClose(socket: WebSocketCloseTrackable): WebSocketClientCloseTracker {
  let closedByClient = false
  const markClosed = () => {
    closedByClient = true
  }
  socket.once('close', markClosed)
  return {
    get closedByClient() {
      return closedByClient
    },
    cleanup(): void {
      socket.off('close', markClosed)
    },
  }
}

export function createWebSocketEventSender(socket: WebSocketLike, metrics: StreamMetricsRecorder): (event: NexusEvent) => void {
  return event => {
    if (socket.readyState === socket.OPEN) {
      sendJson(socket, event)
      metrics.recordStreamEvent(socket.bufferedAmount)
    }
  }
}

export function forwardProcessedRuntimeEvent(
  socket: WebSocketLike,
  processed: ProcessedRuntimeEventForForwarding,
  metrics: StreamMetricsRecorder,
  abortController: AbortController,
): ForwardProcessedRuntimeEventResult {
  const { cacheHealthEvent, event } = processed
  if (cacheHealthEvent) {
    sendJson(socket, cacheHealthEvent)
  }
  if (socket.readyState !== socket.OPEN) {
    abortController.abort()
    return { event, forwarded: false, closed: true }
  }
  try {
    sendJson(socket, event)
    metrics.recordStreamEvent(socket.bufferedAmount)
  } catch (err) {
    // Bug 2 fix (2026-06-21): if `sendJson` throws (socket
    // closed mid-flight, bufferedAmount cap, transport-level
    // error), abort the runtime stream consumer so we don't
    // keep producing events for a dead socket. Without this the
    // consumer would keep streaming while the WS was already
    // closed — leaking work and inflating metrics.stream.activeCount.
    logger.warn('forward event failed; aborting stream consumer', err)
    abortController.abort()
    return { event, forwarded: false, closed: true }
  }
  return { event, forwarded: true, closed: false }
}

export function resolvePermissionResponseMessage(parsedJson: unknown, registry: PermissionResponseResolver = PendingPermissionRegistry.getInstance()): boolean {
  if (!isPermissionResponseMessage(parsedJson)) return false
  registry.resolve(parsedJson.sessionId, parsedJson.toolUseId, {
    approved: parsedJson.approved,
    reason: parsedJson.reason,
    ...(parsedJson.scope && { scope: parsedJson.scope }),
    ...(parsedJson.rule && { rule: parsedJson.rule }),
    ...(parsedJson.feedback && { feedback: parsedJson.feedback }),
  })
  return true
}

function isPermissionResponseMessage(value: unknown): value is {
  type: 'permission_response'
  sessionId: string
  toolUseId: string
  approved: boolean
  reason?: string
  scope?: 'once' | 'session' | 'rule'
  rule?: string
  feedback?: string
} {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return record.type === 'permission_response' && typeof record.sessionId === 'string' && typeof record.toolUseId === 'string' && typeof record.approved === 'boolean'
}
