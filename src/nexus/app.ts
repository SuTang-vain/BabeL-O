import websocket from '@fastify/websocket'
import Fastify, { type FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { NexusRuntime } from '../runtime/Runtime.js'
import { eventBase, type NexusEvent } from '../shared/events.js'
import { createId, nowIso } from '../shared/id.js'
import type { SessionSnapshot } from '../shared/session.js'
import type { NexusTask } from '../shared/task.js'
import type { NexusStorage } from '../storage/Storage.js'
import { ExecutionGate } from './executionGate.js'
import { NexusMetrics, round } from './metrics.js'

declare module 'fastify' {
  interface FastifyRequest {
    performanceStartMs: number
  }
}

const executeSchema = z.object({
  prompt: z.string().min(1),
  sessionId: z.string().optional(),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().max(300_000).optional(),
  maxToolOutputBytes: z.number().int().positive().max(10_000_000).optional(),
})

const createTaskSchema = z.object({
  title: z.string().min(1),
})

const sessionInputSchema = z.object({
  message: z.string().min(1),
  nextPhase: z
    .enum(['created', 'executing', 'waiting_permission', 'completed', 'failed', 'cancelled'])
    .optional(),
})

const updateTaskSchema = z.object({
  title: z.string().min(1).optional(),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed']).optional(),
  result: z.string().optional(),
})

const eventListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(100),
  cursor: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('asc'),
})

const sessionDetailQuerySchema = z.object({
  recentEventLimit: z.coerce.number().int().min(0).max(500).default(100),
})

export type CreateNexusAppOptions = {
  runtime: NexusRuntime
  storage: NexusStorage
  defaultCwd: string
  executeTimeoutMs?: number
  maxConcurrentExecutions?: number
  maxToolOutputBytes?: number
  bashMaxBufferBytes?: number
}

type WebSocketLike = {
  OPEN: number
  readyState: number
  bufferedAmount: number
  send(payload: string): void
}

export async function createNexusApp(
  options: CreateNexusAppOptions,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  const metrics = new NexusMetrics()
  const executeTimeoutMs = options.executeTimeoutMs ?? 30_000
  const maxToolOutputBytes = options.maxToolOutputBytes ?? 200_000
  const bashMaxBufferBytes = options.bashMaxBufferBytes ?? 1_000_000
  const executionGate = new ExecutionGate(options.maxConcurrentExecutions ?? 8)
  await app.register(websocket)

  app.addHook('onRequest', async request => {
    request.performanceStartMs = metrics.now()
  })

  app.addHook('onResponse', async (request, reply) => {
    metrics.recordRoute(
      `${request.method} ${request.routeOptions.url ?? request.url}`,
      reply.statusCode,
      metrics.now() - request.performanceStartMs,
    )
  })

  app.get('/health', async () => ({
    status: 'ok',
    version: '0.1.0',
    runtime: 'babel-o',
    timestamp: nowIso(),
  }))

  app.get('/v1/runtime/status', async () => ({
    type: 'runtime_status',
    health: {
      status: 'ok',
      version: '0.1.0',
    },
    sessions: await options.storage.listSessions({ limit: 20 }),
  }))

  app.get('/v1/runtime/metrics', async () => metrics.snapshot())

  app.get('/v1/tools/audit', async () => ({
    type: 'tools_audit',
    tools: options.runtime.listTools?.() ?? [],
  }))

  app.post('/v1/execute', async (request, reply) => {
    const releaseExecution = executionGate.tryAcquire()
    if (!releaseExecution) {
      metrics.recordExecuteRejected()
      return reply.code(429).send({
        type: 'error',
        code: 'EXECUTION_BUSY',
        message: 'Nexus execution capacity is full. Try again shortly.',
      })
    }
    metrics.recordExecuteStart()
    const startedAtMs = metrics.now()
    try {
      const body = executeSchema.parse(request.body)
      const sessionId = body.sessionId ?? createId('session')
      const cwd = body.cwd ?? options.defaultCwd
      const abortController = new AbortController()
      const timeout = setTimeout(
        () => abortController.abort(),
        body.timeoutMs ?? executeTimeoutMs,
      )
      const session = createSessionSnapshot(sessionId, cwd, body.prompt)
      await options.storage.saveSession(session)

      const events: NexusEvent[] = []
      try {
        for await (const event of options.runtime.executeStream({
          sessionId,
          prompt: body.prompt,
          cwd,
          signal: abortController.signal,
          maxToolOutputBytes: body.maxToolOutputBytes ?? maxToolOutputBytes,
          bashMaxBufferBytes,
        })) {
          events.push(event)
          await options.storage.appendEvent(sessionId, event)
        }
      } finally {
        clearTimeout(timeout)
      }

      const resultEvent = events.findLast(event => event.type === 'result')
      const errorEvent = events.findLast(event => event.type === 'error')
      const timedOut = abortController.signal.aborted
      const timeoutEvent =
        errorEvent?.type === 'error' && errorEvent.code === 'REQUEST_TIMEOUT'
      const succeeded =
        !timedOut && !errorEvent && resultEvent?.type === 'result' && resultEvent.success
      const finalSession = await options.storage.getSession(sessionId, {
        includeEvents: false,
      })
      if (finalSession) {
        finalSession.phase = succeeded ? 'completed' : 'failed'
        finalSession.updatedAt = nowIso()
        if (resultEvent?.type === 'result') finalSession.result = resultEvent.message
        if (errorEvent?.type === 'error') finalSession.error = errorEvent.message
        await options.storage.saveSession(finalSession)
      }
      metrics.recordExecuteFinish({
        success: succeeded,
        timedOut: timedOut || timeoutEvent,
        durationMs: metrics.now() - startedAtMs,
      })

      return {
        type: 'execute_result',
        sessionId,
        success: succeeded,
        durationMs: round(metrics.now() - startedAtMs),
        result: resultEvent ?? null,
        events,
      }
    } finally {
      releaseExecution()
    }
  })

  app.get('/v1/sessions', async request => {
    const query = z
      .object({ limit: z.coerce.number().int().positive().max(200).default(50) })
      .parse(request.query)
    return {
      type: 'sessions_list',
      sessions: await options.storage.listSessions({ limit: query.limit }),
    }
  })

  app.get('/v1/sessions/:sessionId', async request => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    const query = sessionDetailQuerySchema.parse(request.query)
    const session = await options.storage.getSession(params.sessionId, {
      includeEvents: false,
    })
    if (!session) {
      return {
        type: 'error',
        code: 'SESSION_NOT_FOUND',
        message: `Session not found: ${params.sessionId}`,
      }
    }
    const eventPage =
      query.recentEventLimit > 0
        ? await options.storage.listEvents(params.sessionId, {
            limit: query.recentEventLimit,
            order: 'desc',
          })
        : { events: [] }
    return {
      type: 'session',
      session: {
        ...session,
        events: [...eventPage.events].reverse(),
      },
      eventsTruncated: eventPage.nextCursor !== undefined,
      recentEventLimit: query.recentEventLimit,
    }
  })

  app.get('/v1/sessions/:sessionId/events', async request => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    const query = eventListQuerySchema.parse(request.query)
    const session = await options.storage.getSession(params.sessionId, {
      includeEvents: false,
    })
    if (!session) {
      return {
        type: 'error',
        code: 'SESSION_NOT_FOUND',
        message: `Session not found: ${params.sessionId}`,
      }
    }
    const page = await options.storage.listEvents(params.sessionId, query)
    return {
      type: 'session_events',
      sessionId: params.sessionId,
      events: page.events,
      nextCursor: page.nextCursor,
      order: query.order,
      limit: query.limit,
    }
  })

  app.post('/v1/sessions/:sessionId/input', async request => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    const body = sessionInputSchema.parse(request.body)
    const session = await options.storage.getSession(params.sessionId)
    if (!session) {
      return {
        type: 'error',
        code: 'SESSION_NOT_FOUND',
        message: `Session not found: ${params.sessionId}`,
      }
    }

    const event: NexusEvent = {
      type: 'user_message',
      ...eventBase(params.sessionId),
      text: body.message,
    }
    session.lastUserInput = body.message
    session.phase = body.nextPhase ?? 'executing'
    session.updatedAt = event.timestamp
    await options.storage.saveSession(session)
    await options.storage.appendEvent(params.sessionId, event)

    return {
      type: 'session_input_accepted',
      sessionId: params.sessionId,
      phase: session.phase,
    }
  })

  app.post('/v1/sessions/:sessionId/cancel', async request => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    const session = await options.storage.getSession(params.sessionId)
    if (!session) {
      return {
        type: 'error',
        code: 'SESSION_NOT_FOUND',
        message: `Session not found: ${params.sessionId}`,
      }
    }
    session.phase = 'cancelled'
    session.updatedAt = nowIso()
    await options.storage.saveSession(session)
    return {
      type: 'session_cancelled',
      sessionId: params.sessionId,
    }
  })

  app.get('/v1/sessions/:sessionId/tasks', async request => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    return {
      type: 'tasks_list',
      tasks: await options.storage.listTasks(params.sessionId),
    }
  })

  app.post('/v1/sessions/:sessionId/tasks', async request => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    const body = createTaskSchema.parse(request.body)
    const task: NexusTask = {
      taskId: createId('task'),
      sessionId: params.sessionId,
      title: body.title,
      status: 'pending',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    await options.storage.saveTask(task)
    await options.storage.appendEvent(params.sessionId, {
      type: 'task_created',
      ...eventBase(params.sessionId),
      taskId: task.taskId,
      title: task.title,
    })
    return { type: 'task_created', task }
  })

  app.patch('/v1/sessions/:sessionId/tasks/:taskId', async request => {
    const params = z
      .object({ sessionId: z.string(), taskId: z.string() })
      .parse(request.params)
    const body = updateTaskSchema.parse(request.body)
    const task = await options.storage.getTask(params.taskId)
    if (!task || task.sessionId !== params.sessionId) {
      return {
        type: 'error',
        code: 'TASK_NOT_FOUND',
        message: `Task not found: ${params.taskId}`,
      }
    }
    const updated: NexusTask = {
      ...task,
      ...body,
      updatedAt: nowIso(),
    }
    await options.storage.saveTask(updated)
    return {
      type: 'task_updated',
      task: updated,
    }
  })

  app.post('/v1/sessions/:sessionId/tasks/:taskId/claim', async request => {
    const params = z
      .object({ sessionId: z.string(), taskId: z.string() })
      .parse(request.params)
    const task = await options.storage.getTask(params.taskId)
    if (!task || task.sessionId !== params.sessionId) {
      return {
        type: 'error',
        code: 'TASK_NOT_FOUND',
        message: `Task not found: ${params.taskId}`,
      }
    }
    const updated: NexusTask = {
      ...task,
      status: 'in_progress',
      updatedAt: nowIso(),
    }
    await options.storage.saveTask(updated)
    return {
      type: 'task_claimed',
      task: updated,
    }
  })

  app.post('/v1/sessions/:sessionId/tasks/:taskId/complete', async request => {
    const params = z
      .object({ sessionId: z.string(), taskId: z.string() })
      .parse(request.params)
    const body = z.object({ result: z.string().optional() }).parse(request.body ?? {})
    const task = await options.storage.getTask(params.taskId)
    if (!task || task.sessionId !== params.sessionId) {
      return {
        type: 'error',
        code: 'TASK_NOT_FOUND',
        message: `Task not found: ${params.taskId}`,
      }
    }
    const updated: NexusTask = {
      ...task,
      status: 'completed',
      result: body.result,
      updatedAt: nowIso(),
    }
    await options.storage.saveTask(updated)
    return {
      type: 'task_completed',
      task: updated,
    }
  })

  app.get('/v1/stream', { websocket: true }, socket => {
    socket.on('message', async (raw: Buffer) => {
      let closedByClient = false
      const markClosed = () => {
        closedByClient = true
      }
      socket.once('close', markClosed)

      const releaseExecution = executionGate.tryAcquire()
      if (!releaseExecution) {
        metrics.recordStreamRejected()
        sendJson(socket, {
          type: 'error',
          code: 'EXECUTION_BUSY',
          message: 'Nexus execution capacity is full. Try again shortly.',
        })
        socket.off('close', markClosed)
        return
      }

      metrics.recordStreamStart()
      const startedAtMs = metrics.now()
      const abortController = new AbortController()
      socket.once('close', () => abortController.abort())

      let success = false
      let timedOut = false
      try {
        const parsedJson = parseJsonObject(raw)
        const parsed = executeSchema.safeParse(parsedJson)
      if (!parsed.success) {
        sendJson(socket, {
          type: 'error',
          code: 'INVALID_REQUEST',
          message: z.prettifyError(parsed.error),
        })
        return
      }

      const body = parsed.data
      const sessionId = body.sessionId ?? createId('session')
      const cwd = body.cwd ?? options.defaultCwd
      const timeout = setTimeout(
        () => abortController.abort(),
        body.timeoutMs ?? executeTimeoutMs,
      )
      await options.storage.saveSession(
        createSessionSnapshot(sessionId, cwd, body.prompt),
      )

      try {
        for await (const event of options.runtime.executeStream({
          sessionId,
          prompt: body.prompt,
          cwd,
          signal: abortController.signal,
          maxToolOutputBytes: body.maxToolOutputBytes ?? maxToolOutputBytes,
          bashMaxBufferBytes,
        })) {
          await options.storage.appendEvent(sessionId, event)
          if (socket.readyState !== socket.OPEN) {
            abortController.abort()
            break
          }
          sendJson(socket, event)
          metrics.recordStreamEvent(socket.bufferedAmount)
          if (event.type === 'result') success = event.success
          if (event.type === 'error' && event.code === 'REQUEST_TIMEOUT') {
            timedOut = true
          }
        }
      } finally {
        clearTimeout(timeout)
      }
      timedOut = timedOut || abortController.signal.aborted
      } finally {
        socket.off('close', markClosed)
        releaseExecution()
        metrics.recordStreamFinish({
          success,
          timedOut,
          clientClosed: closedByClient,
          durationMs: metrics.now() - startedAtMs,
        })
      }
    })
  })

  return app
}

function parseJsonObject(raw: Buffer): unknown {
  try {
    return JSON.parse(String(raw))
  } catch {
    return {}
  }
}

function sendJson(socket: WebSocketLike, value: unknown): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(value))
  }
}

function createSessionSnapshot(
  sessionId: string,
  cwd: string,
  prompt: string,
): SessionSnapshot {
  const timestamp = nowIso()
  return {
    sessionId,
    cwd,
    prompt,
    phase: 'executing',
    createdAt: timestamp,
    updatedAt: timestamp,
    events: [],
  }
}
