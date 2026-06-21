import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createWebSocketEventSender,
  forwardProcessedRuntimeEvent,
  parseJsonObject,
  resolvePermissionResponseMessage,
  sendJson,
  trackWebSocketClientClose,
  type WebSocketLike,
} from '../src/nexus/executionWebSocketControl.js'
import { eventBase } from '../src/shared/events.js'

test('parseJsonObject returns parsed objects and tolerates invalid JSON', () => {
  assert.deepEqual(parseJsonObject(Buffer.from('{"type":"execute","prompt":"hi"}')), {
    type: 'execute',
    prompt: 'hi',
  })
  assert.deepEqual(parseJsonObject(Buffer.from('{nope')), {})
})

test('sendJson writes only when the socket is open', () => {
  const sent: string[] = []
  const socket: WebSocketLike = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    send(payload: string) {
      sent.push(payload)
    },
  }

  sendJson(socket, { type: 'hello' })
  socket.readyState = 0
  sendJson(socket, { type: 'closed' })

  assert.deepEqual(sent, ['{"type":"hello"}'])
})

test('trackWebSocketClientClose tracks close state and removes its listener on cleanup', () => {
  const listeners: Array<() => void> = []
  const socket = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    send(_payload: string) {},
    once(event: 'close', listener: () => void) {
      assert.equal(event, 'close')
      listeners.push(listener)
    },
    off(event: 'close', listener: () => void) {
      assert.equal(event, 'close')
      const index = listeners.indexOf(listener)
      if (index >= 0) listeners.splice(index, 1)
    },
  }

  const tracker = trackWebSocketClientClose(socket)
  assert.equal(tracker.closedByClient, false)
  assert.equal(listeners.length, 1)
  listeners[0]?.()
  assert.equal(tracker.closedByClient, true)
  tracker.cleanup()
  assert.equal(listeners.length, 0)
})

test('createWebSocketEventSender sends open socket events and records stream metrics', () => {
  const sent: string[] = []
  const bufferedAmounts: number[] = []
  const socket: WebSocketLike = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    send(payload: string) {
      sent.push(payload)
      this.bufferedAmount += payload.length
    },
  }
  const sendEvent = createWebSocketEventSender(socket, {
    recordStreamEvent(bufferedAmount: number) {
      bufferedAmounts.push(bufferedAmount)
    },
  })

  sendEvent({
    type: 'result',
    ...eventBase('session-1'),
    success: true,
    message: 'done',
  })
  socket.readyState = 0
  sendEvent({
    type: 'result',
    ...eventBase('session-1'),
    success: false,
    message: 'closed',
  })

  assert.equal(sent.length, 1)
  assert.equal(JSON.parse(sent[0] ?? '{}').message, 'done')
  assert.deepEqual(bufferedAmounts, [socket.bufferedAmount])
})

test('forwardProcessedRuntimeEvent sends cache health before the decorated event and records one stream metric', () => {
  const sent: string[] = []
  const bufferedAmounts: number[] = []
  const socket: WebSocketLike = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    send(payload: string) {
      sent.push(payload)
      this.bufferedAmount += payload.length
    },
  }
  const controller = new AbortController()

  const result = forwardProcessedRuntimeEvent(
    socket,
    {
      cacheHealthEvent: {
        type: 'cache_health',
        ...eventBase('session-1'),
        cacheHealth: { summary: { status: 'warning' } },
        trigger: 'after_execution_metrics',
      },
      event: {
        type: 'result',
        ...eventBase('session-1'),
        success: true,
        message: 'done',
      },
    },
    {
      recordStreamEvent(bufferedAmount: number) {
        bufferedAmounts.push(bufferedAmount)
      },
    },
    controller,
  )

  assert.equal(result.closed, false)
  assert.equal(result.forwarded, true)
  assert.equal(controller.signal.aborted, false)
  assert.deepEqual(
    sent.map(value => JSON.parse(value)),
    [
      {
        type: 'cache_health',
        sessionId: 'session-1',
        schemaVersion: '2026-05-21.babel-o.v1',
        timestamp: JSON.parse(sent[0] ?? '{}').timestamp,
        cacheHealth: { summary: { status: 'warning' } },
        trigger: 'after_execution_metrics',
      },
      {
        type: 'result',
        sessionId: 'session-1',
        schemaVersion: '2026-05-21.babel-o.v1',
        timestamp: JSON.parse(sent[1] ?? '{}').timestamp,
        success: true,
        message: 'done',
      },
    ],
  )
  assert.deepEqual(bufferedAmounts, [socket.bufferedAmount])
})

test('forwardProcessedRuntimeEvent aborts when the socket closes before the decorated event', () => {
  const sent: string[] = []
  const socket: WebSocketLike = {
    OPEN: 1,
    readyState: 0,
    bufferedAmount: 0,
    send(payload: string) {
      sent.push(payload)
    },
  }
  const controller = new AbortController()
  const bufferedAmounts: number[] = []

  const result = forwardProcessedRuntimeEvent(
    socket,
    {
      event: {
        type: 'result',
        ...eventBase('session-1'),
        success: true,
        message: 'done',
      },
    },
    {
      recordStreamEvent(bufferedAmount: number) {
        bufferedAmounts.push(bufferedAmount)
      },
    },
    controller,
  )

  assert.equal(result.closed, true)
  assert.equal(result.forwarded, false)
  assert.equal(controller.signal.aborted, true)
  assert.deepEqual(sent, [])
  assert.deepEqual(bufferedAmounts, [])
})

test('resolvePermissionResponseMessage resolves valid permission responses only', () => {
  const calls: Array<{
    sessionId: string
    toolUseId: string
    decision: {
      approved: boolean
      reason?: string
      scope?: 'once' | 'session' | 'rule'
      rule?: string
      feedback?: string
    }
  }> = []
  const registry = {
    resolve(sessionId: string, toolUseId: string, decision: (typeof calls)[number]['decision']) {
      calls.push({ sessionId, toolUseId, decision })
    },
  }

  assert.equal(resolvePermissionResponseMessage({ type: 'not_permission_response' }, registry), false)
  assert.equal(
    resolvePermissionResponseMessage(
      {
        type: 'permission_response',
        sessionId: 'session-1',
        toolUseId: 'tool-1',
        approved: true,
        reason: 'ok',
        scope: 'session',
        rule: 'Bash:read-only',
        feedback: 'continue',
      },
      registry,
    ),
    true,
  )

  assert.deepEqual(calls, [
    {
      sessionId: 'session-1',
      toolUseId: 'tool-1',
      decision: {
        approved: true,
        reason: 'ok',
        scope: 'session',
        rule: 'Bash:read-only',
        feedback: 'continue',
      },
    },
  ])
})
