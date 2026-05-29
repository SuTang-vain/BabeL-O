import websocket from '@fastify/websocket'
import Fastify, { type FastifyInstance } from 'fastify'
import { existsSync, lstatSync } from 'node:fs'
import { z } from 'zod'
import type { NexusRuntime } from '../runtime/Runtime.js'
import { eventBase, type NexusEvent, NexusEventSchema } from '../shared/events.js'
import { createId, nowIso } from '../shared/id.js'
import type { SessionSnapshot } from '../shared/session.js'
import type { NexusTask } from '../shared/task.js'
import type { NexusStorage } from '../storage/Storage.js'
import { ExecutionGate } from './executionGate.js'
import { NexusMetrics, round } from './metrics.js'
import { PendingPermissionRegistry } from '../shared/session.js'
import { isWorkspaceAllowed } from '../tools/builtin/pathSafety.js'
import { ConfigManager } from '../shared/config.js'
import { getModel, UnknownModelError } from '../providers/registry.js'
import { closeNexusSession } from './sessionLifecycle.js'
import { compactSession } from '../runtime/compact.js'
import { analyzeContext } from '../runtime/contextAnalysis.js'
import { buildSystemPrompt, extractAbsolutePaths, mapEventsToMessages } from '../runtime/LLMCodingRuntime.js'
import { resolvePromptPath } from '../runtime/systemPromptBuilder.js'


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
  skipPermissionCheck: z.boolean().optional(),
  requestId: z.string().optional(),
  model: z.string().optional(),
  budget: z.number().int().positive().optional(),
  executionEnvironment: z.enum(['local', 'docker', 'remote']).default('local').optional(),
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

const toolTraceListQuerySchema = z.object({
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
  apiKey?: string
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
  const apiKey = options.apiKey ?? process.env.NEXUS_API_KEY
  const executeTimeoutMs = options.executeTimeoutMs ?? 30_000
  const maxToolOutputBytes = options.maxToolOutputBytes ?? 200_000
  const bashMaxBufferBytes = options.bashMaxBufferBytes ?? 1_000_000
  const executionGate = new ExecutionGate(options.maxConcurrentExecutions ?? 8)
  await app.register(websocket)

  app.setErrorHandler((error: any, request, reply) => {
    const isValidationError =
      error.validation ||
      error.name === 'ZodError' ||
      error.statusCode === 400

    if (isValidationError) {
      return reply.status(400).send({
        type: 'error',
        code: 'INVALID_REQUEST',
        message: error.message || String(error),
      })
    }

    const code = (error as { code?: string }).code || 'INTERNAL_ERROR'
    const statusCode = error.statusCode || 500
    return reply.status(statusCode).send({
      type: 'error',
      code,
      message: error.message || String(error),
    })
  })

  app.addHook('onRequest', async request => {
    request.performanceStartMs = metrics.now()
  })

  if (apiKey) {
    app.addHook('onRequest', async (request, reply) => {
      const pathname = request.url.split('?')[0]
      if (pathname === '/health') {
        return
      }

      const authHeader = request.headers['authorization']
      let clientKey = request.headers['x-nexus-api-key']
      if (!clientKey && typeof authHeader === 'string') {
        const parts = authHeader.split(' ')
        if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
          clientKey = parts[1]
        }
      }

      if (clientKey !== apiKey) {
        return reply.code(401).send({
          type: 'error',
          code: 'UNAUTHORIZED',
          message: 'Unauthorized: Invalid or missing API key',
        })
      }
    })
  }

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

  app.get('/v1/schema/events', async () => {
    return z.toJSONSchema(NexusEventSchema)
  })

  app.get('/v1/tools/audit', async () => ({
    type: 'tools_audit',
    tools: options.runtime.listTools?.() ?? [],
  }))

  type PreparedExecution = {
    sessionId: string
    session: SessionSnapshot
    cwd: string
    body: z.infer<typeof executeSchema>
    requestId: string
    abortController: AbortController
    timeoutController: AbortController
    timeout: ReturnType<typeof setTimeout>
    allowedPaths?: string[]
  }

  type PrepareError = { code: string; message: string; status: number }

  async function prepareExecution(body: z.infer<typeof executeSchema>): Promise<PreparedExecution | PrepareError> {
    if (body.executionEnvironment && body.executionEnvironment === 'remote') {
      return { code: 'NOT_IMPLEMENTED', message: `Execution environment '${body.executionEnvironment}' is not implemented yet.`, status: 501 }
    }
    const sessionId = body.sessionId ?? createId('session')
    let session = await options.storage.getSession(sessionId, { includeEvents: false })
    const cwd = resolveRequestCwd({
      prompt: body.prompt,
      requestedCwd: body.cwd,
      sessionCwd: session?.cwd,
      defaultCwd: options.defaultCwd,
    })
    if (!isWorkspaceAllowed(cwd)) {
      return { code: 'INVALID_REQUEST', message: `Workspace directory not allowed: ${cwd}`, status: 400 }
    }

    let allowedPaths = session?.allowedPaths ? [...session.allowedPaths] : []
    if (session && session.cwd && session.cwd !== cwd && !allowedPaths.includes(session.cwd)) {
      allowedPaths.push(session.cwd)
    }

    const configManager = ConfigManager.getInstance()
    const settings = configManager.resolveSettings({ model: body.model })
    const targetModelId = settings.modelId || 'local/coding-runtime'
    try {
      const modelDef = getModel(targetModelId)
      if (modelDef && !modelDef.capabilities.toolCalling) {
        return { code: 'INVALID_REQUEST', message: `Model "${targetModelId}" does not support tool calling`, status: 400 }
      }
    } catch (err) {
      if (!(err instanceof UnknownModelError)) throw err
    }
    const abortController = new AbortController()
    const timeoutController = new AbortController()
    const timeout = setTimeout(() => { timeoutController.abort(); abortController.abort() }, body.timeoutMs ?? executeTimeoutMs)
    if (!session) {
      session = createSessionSnapshot(sessionId, cwd, body.prompt)
    } else {
      session.phase = 'executing'
      session.cwd = cwd
      session.updatedAt = nowIso()
      session.lastUserInput = body.prompt
      session.allowedPaths = allowedPaths.length > 0 ? allowedPaths : undefined
    }
    await options.storage.saveSession(session)
    await options.storage.appendEvent(sessionId, { type: 'user_message', ...eventBase(sessionId), text: body.prompt })
    const requestId = body.requestId ?? createId('req')
    return { sessionId, session, cwd, body, requestId, abortController, timeoutController, timeout, allowedPaths: allowedPaths.length > 0 ? allowedPaths : undefined }
  }

  function isPrepareError(r: PreparedExecution | PrepareError): r is PrepareError {
    return 'status' in r
  }

  function recordEventMetrics(event: NexusEvent): void {
    if (event.type !== 'execution_metrics') return
    if (event.providerFirstTokenMs !== undefined) metrics.recordProviderFirstToken(event.providerFirstTokenMs)
    if (event.providerRequestDurationMs !== undefined) metrics.recordProviderRequestDuration(event.providerRequestDurationMs)
    if (event.streamDeltaCount !== undefined) metrics.recordStreamDeltas(event.streamDeltaCount)
    if (event.toolCallCount !== undefined && event.toolRoundtripDurationMs !== undefined) metrics.recordToolCalls(event.toolCallCount, event.toolRoundtripDurationMs)
    if (event.contextCharsIn !== undefined && event.contextCharsOut !== undefined) metrics.recordContextChars(event.contextCharsIn, event.contextCharsOut)
  }

  async function persistEventMetrics(sessionId: string, event: NexusEvent): Promise<void> {
    if (event.type !== 'execution_metrics') return
    await options.storage.saveExecutionMetrics({
      metricId: createId('metric'),
      sessionId,
      executeDurationMs: event.executeDurationMs,
      providerFirstTokenMs: event.providerFirstTokenMs,
      providerRequestDurationMs: event.providerRequestDurationMs,
      streamDeltaCount: event.streamDeltaCount,
      toolCallCount: event.toolCallCount,
      toolRoundtripDurationMs: event.toolRoundtripDurationMs,
      contextCharsIn: event.contextCharsIn,
      contextCharsOut: event.contextCharsOut,
      timestamp: event.timestamp,
    })
  }

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
      const prepared = await prepareExecution(body)
      if (isPrepareError(prepared)) {
        return reply.status(prepared.status).send({ type: 'error', code: prepared.code, message: prepared.message })
      }
      const { sessionId, cwd, requestId, abortController, timeoutController, timeout } = prepared

      const events: NexusEvent[] = []
      try {
        for await (const event of options.runtime.executeStream({
          sessionId,
          prompt: body.prompt,
          cwd,
          signal: abortController.signal,
          timeoutSignal: timeoutController.signal,
          maxToolOutputBytes: body.maxToolOutputBytes ?? maxToolOutputBytes,
          bashMaxBufferBytes,
          skipPermissionCheck: body.skipPermissionCheck,
          requestId,
          model: body.model,
          budget: body.budget,
          executionEnvironment: body.executionEnvironment,
          allowedPaths: prepared.allowedPaths,
        })) {
          events.push(event)
          await options.storage.appendEvent(sessionId, event)
          await persistEventMetrics(sessionId, event)
          recordEventMetrics(event)
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

  app.get('/v1/sessions/:sessionId', async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    const query = sessionDetailQuerySchema.parse(request.query)
    const session = await options.storage.getSession(params.sessionId, {
      includeEvents: false,
    })
    if (!session) {
      return reply.code(404).send({
        type: 'error',
        code: 'SESSION_NOT_FOUND',
        message: `Session not found: ${params.sessionId}`,
      })
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

  app.get('/v1/sessions/:sessionId/events', async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    const query = eventListQuerySchema.parse(request.query)
    const session = await options.storage.getSession(params.sessionId, {
      includeEvents: false,
    })
    if (!session) {
      return reply.code(404).send({
        type: 'error',
        code: 'SESSION_NOT_FOUND',
        message: `Session not found: ${params.sessionId}`,
      })
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

  app.post('/v1/sessions/:sessionId/compact', async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    const body = z.object({
      modelId: z.string().optional(),
      trigger: z.enum(['manual', 'auto', 'reactive']).default('manual').optional(),
    }).parse(request.body ?? {})
    const session = await options.storage.getSession(params.sessionId, {
      includeEvents: false,
    })
    if (!session) {
      return reply.code(404).send({
        type: 'error',
        code: 'SESSION_NOT_FOUND',
        message: `Session not found: ${params.sessionId}`,
      })
    }
    const result = await compactSession({
      storage: options.storage,
      sessionId: params.sessionId,
      modelId: body.modelId,
      trigger: body.trigger ?? 'manual',
      mapEventsToMessages,
      initialPrompt: session.lastUserInput ?? session.prompt,
    })
    return {
      type: 'compact_result',
      sessionId: params.sessionId,
      event: result.event,
      beforeEventCount: result.beforeEventCount,
      afterEventCount: result.afterEventCount,
    }
  })

  app.get('/v1/sessions/:sessionId/context', async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    const query = z.object({
      modelId: z.string().optional(),
      prompt: z.string().optional(),
      cwd: z.string().optional(),
    }).parse(request.query)
    const session = await options.storage.getSession(params.sessionId, {
      includeEvents: false,
    })
    if (!session) {
      return reply.code(404).send({
        type: 'error',
        code: 'SESSION_NOT_FOUND',
        message: `Session not found: ${params.sessionId}`,
      })
    }
    const { events } = await options.storage.listEvents(params.sessionId, {
      limit: 10_000,
      order: 'asc',
    })
    const settings = ConfigManager.getInstance().resolveSettings()
    const modelId = query.modelId ?? settings.modelId ?? 'local/coding-runtime'
    const toolDefinitions = (options.runtime.listTools?.() ?? [])
      .filter(tool => tool.allowed)
      .map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema ?? {},
      }))
    const analysis = await analyzeContext({
      runtimeOptions: {
        sessionId: params.sessionId,
        prompt: query.prompt ?? session.lastUserInput ?? session.prompt,
        cwd: query.cwd ?? session.cwd,
      },
      events,
      modelId,
      buildSystemPrompt,
      mapEventsToMessages,
      tools: toolDefinitions,
    })
    return analysis
  })

  app.get('/v1/sessions/:sessionId/tool-traces', async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    const query = toolTraceListQuerySchema.parse(request.query)
    const session = await options.storage.getSession(params.sessionId, {
      includeEvents: false,
    })
    if (!session) {
      return reply.code(404).send({
        type: 'error',
        code: 'SESSION_NOT_FOUND',
        message: `Session not found: ${params.sessionId}`,
      })
    }
    const page = await options.storage.listToolTraces(params.sessionId, query)
    return {
      type: 'tool_traces',
      sessionId: params.sessionId,
      traces: page.traces,
      nextCursor: page.nextCursor,
      order: query.order,
      limit: query.limit,
    }
  })

  app.get('/v1/sessions/:sessionId/permission-audits', async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    const session = await options.storage.getSession(params.sessionId, {
      includeEvents: false,
    })
    if (!session) {
      return reply.code(404).send({
        type: 'error',
        code: 'SESSION_NOT_FOUND',
        message: `Session not found: ${params.sessionId}`,
      })
    }
    const audits = await options.storage.listPermissionAudits(params.sessionId)
    return {
      type: 'permission_audits',
      sessionId: params.sessionId,
      audits,
    }
  })

  app.post('/v1/sessions/:sessionId/input', async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    const body = sessionInputSchema.parse(request.body)
    const session = await options.storage.getSession(params.sessionId)
    if (!session) {
      return reply.code(404).send({
        type: 'error',
        code: 'SESSION_NOT_FOUND',
        message: `Session not found: ${params.sessionId}`,
      })
    }

    if (session.phase === 'waiting_permission') {
      const lowerMessage = body.message.trim().toLowerCase()
      const approved = ['y', 'yes', 'approve', 'ok', 'true'].includes(lowerMessage)
      PendingPermissionRegistry.getInstance().resolveSession(params.sessionId, {
        approved,
        reason: approved ? undefined : body.message,
      })
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

  app.post('/v1/sessions/:sessionId/approve', async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    const body = z.object({ toolUseId: z.string() }).parse(request.body)
    const resolved = PendingPermissionRegistry.getInstance().resolve(
      params.sessionId,
      body.toolUseId,
      { approved: true }
    )
    if (!resolved) {
      return reply.code(404).send({
        type: 'error',
        code: 'PERMISSION_REQUEST_NOT_FOUND',
        message: `No pending permission request found for session ${params.sessionId} and tool use ${body.toolUseId}`,
      })
    }
    return {
      type: 'permission_resolved',
      sessionId: params.sessionId,
      toolUseId: body.toolUseId,
      approved: true,
    }
  })

  app.post('/v1/sessions/:sessionId/deny', async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    const body = z.object({ toolUseId: z.string(), reason: z.string().optional() }).parse(request.body)
    const resolved = PendingPermissionRegistry.getInstance().resolve(
      params.sessionId,
      body.toolUseId,
      { approved: false, reason: body.reason }
    )
    if (!resolved) {
      return reply.code(404).send({
        type: 'error',
        code: 'PERMISSION_REQUEST_NOT_FOUND',
        message: `No pending permission request found for session ${params.sessionId} and tool use ${body.toolUseId}`,
      })
    }
    return {
      type: 'permission_resolved',
      sessionId: params.sessionId,
      toolUseId: body.toolUseId,
      approved: false,
    }
  })

  app.post('/v1/sessions/:sessionId/cancel', async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    const { session } = await closeNexusSession({
      storage: options.storage,
      sessionId: params.sessionId,
      phase: 'cancelled',
      reason: 'Session cancelled',
    })
    if (!session) {
      return reply.code(404).send({
        type: 'error',
        code: 'SESSION_NOT_FOUND',
        message: `Session not found: ${params.sessionId}`,
      })
    }
    return {
      type: 'session_cancelled',
      sessionId: params.sessionId,
    }
  })

  app.post('/v1/sessions/:sessionId/close', async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    const body = z.object({
      phase: z.enum(['cancelled', 'completed', 'failed']).optional(),
      reason: z.string().optional(),
    }).parse(request.body ?? {})
    const { session, permissionsResolved } = await closeNexusSession({
      storage: options.storage,
      sessionId: params.sessionId,
      phase: body.phase,
      reason: body.reason,
    })
    if (!session) {
      return reply.code(404).send({
        type: 'error',
        code: 'SESSION_NOT_FOUND',
        message: `Session not found: ${params.sessionId}`,
      })
    }
    return {
      type: 'session_closed',
      sessionId: params.sessionId,
      phase: session.phase,
      permissionsResolved,
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
      dependsOn: [],
      blocks: [],
      retryCount: 0,
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

  app.patch('/v1/sessions/:sessionId/tasks/:taskId', async (request, reply) => {
    const params = z
      .object({ sessionId: z.string(), taskId: z.string() })
      .parse(request.params)
    const body = updateTaskSchema.parse(request.body)
    const task = await options.storage.getTask(params.taskId)
    if (!task || task.sessionId !== params.sessionId) {
      return reply.code(404).send({
        type: 'error',
        code: 'TASK_NOT_FOUND',
        message: `Task not found: ${params.taskId}`,
      })
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

  app.post('/v1/sessions/:sessionId/tasks/:taskId/claim', async (request, reply) => {
    const params = z
      .object({ sessionId: z.string(), taskId: z.string() })
      .parse(request.params)
    const task = await options.storage.getTask(params.taskId)
    if (!task || task.sessionId !== params.sessionId) {
      return reply.code(404).send({
        type: 'error',
        code: 'TASK_NOT_FOUND',
        message: `Task not found: ${params.taskId}`,
      })
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

  app.post('/v1/sessions/:sessionId/tasks/:taskId/complete', async (request, reply) => {
    const params = z
      .object({ sessionId: z.string(), taskId: z.string() })
      .parse(request.params)
    const body = z.object({ result: z.string().optional() }).parse(request.body ?? {})
    const task = await options.storage.getTask(params.taskId)
    if (!task || task.sessionId !== params.sessionId) {
      return reply.code(404).send({
        type: 'error',
        code: 'TASK_NOT_FOUND',
        message: `Task not found: ${params.taskId}`,
      })
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
      const parsedJson = parseJsonObject(raw)
      if (parsedJson && typeof parsedJson === 'object' && 'type' in parsedJson && parsedJson.type === 'permission_response') {
        const res = (parsedJson as unknown) as { sessionId: string; toolUseId: string; approved: boolean; reason?: string }
        PendingPermissionRegistry.getInstance().resolve(res.sessionId, res.toolUseId, {
          approved: res.approved,
          reason: res.reason,
        })
        return
      }

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
      let abortController: AbortController | undefined
      socket.once('close', () => abortController?.abort())

      let success = false
      let timedOut = false
      try {
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
      const prepared = await prepareExecution(body)
      if (isPrepareError(prepared)) {
        sendJson(socket, { type: 'error', code: prepared.code, message: prepared.message })
        return
      }
      const { sessionId, cwd, requestId } = prepared
      abortController = prepared.abortController
      const timeout = prepared.timeout

      try {
        for await (const event of options.runtime.executeStream({
          sessionId,
          prompt: body.prompt,
          cwd,
          signal: abortController.signal,
          timeoutSignal: prepared.timeoutController.signal,
          maxToolOutputBytes: body.maxToolOutputBytes ?? maxToolOutputBytes,
          bashMaxBufferBytes,
          skipPermissionCheck: body.skipPermissionCheck,
          requestId,
          model: body.model,
          budget: body.budget,
          executionEnvironment: body.executionEnvironment,
          allowedPaths: prepared.allowedPaths,
        })) {
          await options.storage.appendEvent(sessionId, event)
          await persistEventMetrics(sessionId, event)
          recordEventMetrics(event)
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

function resolveRequestCwd(options: {
  prompt: string
  requestedCwd?: string
  sessionCwd?: string
  defaultCwd: string
}): string {
  const explicitCwd = resolveExplicitPromptCwd(options.prompt)
  if (explicitCwd) {
    return explicitCwd
  }
  if (options.requestedCwd && options.requestedCwd !== options.defaultCwd) {
    return options.requestedCwd
  }
  return options.sessionCwd ?? options.requestedCwd ?? options.defaultCwd
}

function resolveExplicitPromptCwd(prompt: string): string | undefined {
  for (const candidate of extractAbsolutePaths(prompt)) {
    const resolved = resolvePromptPath(candidate)
    if (!existsSync(resolved)) continue
    try {
      const stat = lstatSync(resolved)
      if (stat.isDirectory()) return resolved
    } catch {
      continue
    }
  }
  return undefined
}

export function isLocalHost(h: string): boolean {
  const normalized = h.toLowerCase().trim()
  return (
    normalized === '127.0.0.1' ||
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '[::1]'
  )
}

export function validateSecurityConfig(host: string, apiKey: string | undefined): void {
  if (!isLocalHost(host) && !apiKey) {
    throw new Error(
      `Security Error: Running Nexus on non-localhost (${host}) requires setting the NEXUS_API_KEY environment variable.`,
    )
  }
}
