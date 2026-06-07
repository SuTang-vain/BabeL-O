import websocket from '@fastify/websocket'
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import { existsSync, lstatSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { NexusRuntime } from '../runtime/Runtime.js'
import type { RemoteToolRunner } from '../runtime/remoteRunner.js'
import type { RemoteRunnerStatus } from './remoteRunnerConfig.js'
import { eventBase, NEXUS_EVENT_SCHEMA_VERSION, type NexusEvent, NexusEventSchema } from '../shared/events.js'
import { createId, nowIso } from '../shared/id.js'
import type { SessionSnapshot, TaskSessionTerminalReason } from '../shared/session.js'
import type { NexusTask, TaskStatus } from '../shared/task.js'
import type { NexusStorage } from '../storage/Storage.js'
import { ExecutionGate } from './executionGate.js'
import { NexusMetrics, round } from './metrics.js'
import { PendingPermissionRegistry } from '../shared/session.js'
import { BABEL_O_VERSION } from '../shared/version.js'
import { isWorkspaceAllowed } from '../tools/builtin/pathSafety.js'
import { ConfigManager } from '../shared/config.js'
import { getModel, UnknownModelError } from '../providers/registry.js'
import { runProviderLiveSmoke, runProviderSmokeDryRun } from '../runtime/providerSmoke.js'
import { buildProviderFallbackPolicy, planProviderFallbackAction } from '../runtime/providerRecovery.js'
import { closeNexusSession } from './sessionLifecycle.js'
import { compactSession } from '../runtime/compact.js'
import { analyzeContext } from '../runtime/contextAnalysis.js'
import { buildSystemPrompt, extractAbsolutePaths, mapEventsToMessages } from '../runtime/LLMCodingRuntime.js'
import { resolvePromptPath } from '../runtime/systemPromptBuilder.js'
import { buildSessionAssetsSnapshot } from './sessionAssets.js'
import { removeWorktree } from './worktree.js'
import { ExploreAgentScheduler } from './agents/AgentScheduler.js'
import { AgentJobRegistryError } from './agents/AgentJobRegistry.js'
import type { AgentJob, AgentScheduler } from './agents/types.js'


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

const booleanQuery = (defaultValue: boolean) => z.preprocess(value => {
  if (value === undefined) return defaultValue
  if (value === true || value === 'true' || value === '1') return true
  if (value === false || value === 'false' || value === '0') return false
  return value
}, z.boolean())

const providerSmokeQuerySchema = z.object({
  model: z.string().optional(),
  role: z.string().optional(),
  requireTools: booleanQuery(true),
  requireStreaming: booleanQuery(true),
  requireStructuredOutput: booleanQuery(false),
})

const providerLiveSmokeSchema = z.object({
  model: z.string().optional(),
  role: z.string().optional(),
  mode: z.enum(['simple_text', 'tool_call']).default('simple_text').optional(),
  timeoutMs: z.number().int().positive().max(60_000).default(30_000).optional(),
})

const providerFallbackPlanSchema = z.object({
  model: z.string().optional(),
  role: z.string().optional(),
  kind: z.enum([
    'max_output_tokens',
    'context_window',
    'rate_limit',
    'auth_or_billing',
    'provider_protocol',
    'provider_unavailable',
    'unknown',
  ]).default('unknown').optional(),
})

const taskMutationMetadataSchema = z.record(z.string(), z.unknown())

const taskMutationAuditSchema = z.object({
  actor: z.string().optional(),
  source: z.string().optional(),
  reason: z.string().optional(),
  requestId: z.string().optional(),
  expectedUpdatedAt: z.string().optional(),
})

const createTaskSchema = taskMutationAuditSchema.extend({
  title: z.string().min(1),
  description: z.string().optional(),
  metadata: taskMutationMetadataSchema.optional(),
})

const sessionInputSchema = z.object({
  message: z.string().min(1),
  nextPhase: z
    .enum(['created', 'executing', 'waiting_permission', 'completed', 'failed', 'cancelled'])
    .optional(),
})

const updateTaskSchema = taskMutationAuditSchema.extend({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  status: z.enum(['pending', 'in_progress', 'blocked', 'completed', 'failed', 'cancelled']).optional(),
  result: z.string().optional(),
  metadata: taskMutationMetadataSchema.optional(),
})

const taskActionSchema = taskMutationAuditSchema.extend({
  result: z.string().optional(),
  ownerAgentId: z.string().optional(),
  reviewReason: z.string().optional(),
})

const worktreeRecoveryActionSchema = taskMutationAuditSchema.extend({
  action: z.enum(['continue', 'abandon', 'keep']),
})

const subAgentRerunSchema = taskMutationAuditSchema.extend({
  mode: z.enum(['retry-task']).default('retry-task').optional(),
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

const sessionAssetsQuerySchema = z.object({
  eventLimit: z.coerce.number().int().min(0).max(500).default(200),
  toolTraceLimit: z.coerce.number().int().min(0).max(500).default(200),
  childSessionLimit: z.coerce.number().int().min(0).max(500).default(200),
  includeEvents: booleanQuery(true),
  includeToolTraces: booleanQuery(true),
  includePermissionAudits: booleanQuery(true),
  includeExecutionMetrics: booleanQuery(true),
})

const childSessionsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(200),
  eventLimit: z.coerce.number().int().min(0).max(100).default(5),
  failedOnly: booleanQuery(false),
  includeEvents: booleanQuery(true),
})

const sessionResumeSchema = z.object({
  recentEventLimit: z.number().int().min(0).max(500).default(100).optional(),
  includeTasks: z.boolean().default(true).optional(),
  includeChildSessions: z.boolean().default(true).optional(),
})

const agentSpawnSchema = z.object({
  parentSessionId: z.string().min(1),
  prompt: z.string().min(1),
  agentType: z.enum(['explore', 'review', 'test', 'implement', 'debug', 'general']).default('explore').optional(),
  contextForkMode: z.enum(['minimal', 'working-set', 'task-focused', 'full-summary', 'debug-replay']).optional(),
  isolation: z.enum(['none', 'worktree']).optional(),
  allowedTools: z.array(z.string()).optional(),
  maxRuntimeMs: z.number().int().positive().max(600_000).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

const agentListQuerySchema = z.object({
  parentSessionId: z.string().optional(),
  status: z.enum(['queued', 'running', 'waiting_permission', 'completed', 'failed', 'cancelled']).optional(),
  agentType: z.enum(['explore', 'review', 'test', 'implement', 'debug', 'general']).optional(),
})

const agentWaitSchema = z.object({
  timeoutMs: z.number().int().positive().max(600_000).optional(),
})

const agentCancelSchema = z.object({
  reason: z.string().optional(),
})

type ActiveExecution = {
  requestId: string
  abortController: AbortController
  transport: 'http' | 'websocket'
  startedAt: string
}

export type CreateNexusAppOptions = {
  runtime: NexusRuntime
  storage: NexusStorage
  defaultCwd: string
  executeTimeoutMs?: number
  maxConcurrentExecutions?: number
  maxToolOutputBytes?: number
  bashMaxBufferBytes?: number
  apiKey?: string
  remoteRunner?: RemoteToolRunner
  remoteRunnerStatus?: RemoteRunnerStatus
  agentScheduler?: AgentScheduler
  agentExecutionEnvironment?: 'local' | 'remote'
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
  const activeExecutions = new Map<string, ActiveExecution>()
  const agentScheduler = options.agentScheduler ?? new ExploreAgentScheduler({
    storage: options.storage,
    cwd: options.defaultCwd,
    executionEnvironment: options.agentExecutionEnvironment,
    remoteRunner: options.remoteRunner,
  })
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
    version: BABEL_O_VERSION,
    runtime: 'babel-o',
    timestamp: nowIso(),
  }))

  app.get('/v1/runtime/status', async () => ({
    type: 'runtime_status',
    health: {
      status: 'ok',
      version: BABEL_O_VERSION,
    },
    provider: ConfigManager.getInstance().getProviderDiagnostics(),
    providerSmoke: runProviderSmokeDryRun(),
    remoteRunner: options.remoteRunnerStatus ?? {
      configured: options.remoteRunner !== undefined,
      required: false,
      healthy: options.remoteRunner !== undefined,
      id: options.remoteRunner?.id,
      capabilities: options.remoteRunner?.capabilities,
    },
    metrics: await buildRuntimeMetricsSnapshot(metrics, options.storage),
    sessions: await options.storage.listSessions({ limit: 20 }),
  }))

  app.get('/v1/runtime/provider-smoke', async request => {
    const query = providerSmokeQuerySchema.parse(request.query)
    return runProviderSmokeDryRun({
      model: query.model,
      role: query.role,
      requireTools: query.requireTools,
      requireStreaming: query.requireStreaming,
      requireStructuredOutput: query.requireStructuredOutput,
    })
  })

  app.post('/v1/runtime/provider-smoke/live', async request => {
    const body = providerLiveSmokeSchema.parse(request.body ?? {})
    return runProviderLiveSmoke({
      model: body.model,
      role: body.role,
      mode: body.mode,
      timeoutMs: body.timeoutMs,
    })
  })

  app.post('/v1/runtime/provider-fallback/plan', async request => {
    const body = providerFallbackPlanSchema.parse(request.body ?? {})
    const provider = ConfigManager.getInstance().getProviderDiagnostics({
      model: body.model,
      role: body.role,
    })
    const recoveryKind = body.kind ?? 'unknown'
    return planProviderFallbackAction({
      provider,
      recoveryKind,
      policy: buildProviderFallbackPolicy(recoveryKind),
    })
  })

  app.get('/v1/runtime/metrics', async () => buildRuntimeMetricsSnapshot(metrics, options.storage))

  app.get('/v1/schema/events', async () => {
    return z.toJSONSchema(NexusEventSchema)
  })

  app.get('/v1/tools/audit', async () => ({
    type: 'tools_audit',
    tools: options.runtime.listTools?.() ?? [],
  }))

  app.post('/v1/agents', async (request, reply) => {
    const body = agentSpawnSchema.parse(request.body)
    try {
      const job = await agentScheduler.spawnAgent(body)
      return {
        type: 'agent_job_spawned',
        job,
      }
    } catch (error) {
      if (error instanceof AgentJobRegistryError) {
        return sendAgentError(reply, error)
      }
      throw error
    }
  })

  app.get('/v1/agents', async request => {
    const query = agentListQuerySchema.parse(request.query)
    return {
      type: 'agent_jobs',
      jobs: await agentScheduler.listAgents(query),
    }
  })

  app.get('/v1/agents/:jobId', async (request, reply) => {
    const params = z.object({ jobId: z.string() }).parse(request.params)
    const job = await findAgentJob(agentScheduler, params.jobId)
    if (!job) return reply.code(404).send(createAgentJobNotFoundPayload(params.jobId))
    return {
      type: 'agent_job',
      job,
    }
  })

  app.post('/v1/agents/:jobId/wait', async (request, reply) => {
    const params = z.object({ jobId: z.string() }).parse(request.params)
    const body = agentWaitSchema.parse(request.body ?? {})
    try {
      return {
        type: 'agent_job',
        job: await agentScheduler.waitForAgent(params.jobId, body),
      }
    } catch (error) {
      if (error instanceof AgentJobRegistryError) {
        return sendAgentError(reply, error)
      }
      throw error
    }
  })

  app.post('/v1/agents/:jobId/cancel', async (request, reply) => {
    const params = z.object({ jobId: z.string() }).parse(request.params)
    const body = agentCancelSchema.parse(request.body ?? {})
    try {
      return {
        type: 'agent_job_cancelled',
        job: await agentScheduler.cancelAgent(params.jobId, body.reason),
      }
    } catch (error) {
      if (error instanceof AgentJobRegistryError) {
        return sendAgentError(reply, error)
      }
      throw error
    }
  })

  app.get('/v1/agents/:jobId/transcript', async (request, reply) => {
    const params = z.object({ jobId: z.string() }).parse(request.params)
    const query = eventListQuerySchema.parse(request.query)
    const job = await findAgentJob(agentScheduler, params.jobId)
    if (!job) return reply.code(404).send(createAgentJobNotFoundPayload(params.jobId))
    const page = await options.storage.listEvents(job.childSessionId, query)
    return {
      type: 'agent_transcript',
      jobId: job.jobId,
      parentSessionId: job.parentSessionId,
      childSessionId: job.childSessionId,
      transcriptPath: job.transcriptPath ?? `nexus://sessions/${job.childSessionId}/events`,
      events: page.events,
      nextCursor: page.nextCursor,
      order: query.order,
      limit: query.limit,
    }
  })

  app.get('/v1/sessions/:sessionId/agents', async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    const query = agentListQuerySchema.omit({ parentSessionId: true }).parse(request.query)
    const session = await options.storage.getSession(params.sessionId, { includeEvents: false })
    if (!session) return reply.code(404).send(createSessionNotFoundPayload(params.sessionId))
    return {
      type: 'agent_jobs',
      parentSessionId: params.sessionId,
      jobs: await agentScheduler.listAgents({
        ...query,
        parentSessionId: params.sessionId,
      }),
    }
  })

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
    if (body.executionEnvironment === 'remote' && !options.remoteRunner) {
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

  function registerActiveExecution(
    sessionId: string,
    execution: ActiveExecution,
  ): void {
    activeExecutions.set(sessionId, execution)
  }

  function clearActiveExecution(sessionId: string, requestId: string): void {
    if (activeExecutions.get(sessionId)?.requestId === requestId) {
      activeExecutions.delete(sessionId)
    }
  }

  function recordEventMetrics(event: NexusEvent): void {
    if (event.type !== 'execution_metrics') return
    if (event.providerFirstTokenMs !== undefined) metrics.recordProviderFirstToken(event.providerFirstTokenMs)
    if (event.providerRequestDurationMs !== undefined) metrics.recordProviderRequestDuration(event.providerRequestDurationMs)
    if (event.streamDeltaCount !== undefined) metrics.recordStreamDeltas(event.streamDeltaCount)
    if (event.toolCallCount !== undefined && event.toolRoundtripDurationMs !== undefined) metrics.recordToolCalls(event.toolCallCount, event.toolRoundtripDurationMs)
    if (event.remoteToolCallCount !== undefined && event.remoteToolRunnerDurationMs !== undefined) metrics.recordRemoteToolCalls(event.remoteToolCallCount, event.remoteToolRunnerDurationMs)
    if (event.contextCharsIn !== undefined && event.contextCharsOut !== undefined) metrics.recordContextChars(event.contextCharsIn, event.contextCharsOut)
    metrics.recordTokenUsage({
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheCreationInputTokens: event.cacheCreationInputTokens,
      cacheReadInputTokens: event.cacheReadInputTokens,
    })
    metrics.recordContextPolicy({
      modelContextWindow: event.modelContextWindow,
      reservedOutputTokens: event.reservedOutputTokens,
      providerSafetyBufferTokens: event.providerSafetyBufferTokens,
      effectiveContextCeiling: event.effectiveContextCeiling,
      legacyContextCeiling: event.legacyContextCeiling,
      envMaxContextTokens: event.envMaxContextTokens,
      contextPolicySource: event.contextPolicySource,
      contextWarningThresholdPercent: event.contextWarningThresholdPercent,
      contextCompactThresholdPercent: event.contextCompactThresholdPercent,
      contextWarningThresholdTokens: event.contextWarningThresholdTokens,
      contextCompactThresholdTokens: event.contextCompactThresholdTokens,
      contextBlockingLimitTokens: event.contextBlockingLimitTokens,
      cachePreservationMode: event.cachePreservationMode,
      longContextUtilizationMode: event.longContextUtilizationMode,
      prefixCacheImmutableRatio: event.prefixCacheImmutableRatio,
      prefixCacheVolatileContentLast: event.prefixCacheVolatileContentLast,
      prefixCacheFingerprint: event.prefixCacheFingerprint,
    })
    if (event.compactSummaryLatencyMs !== undefined) metrics.recordCompactSummaryLatency(event.compactSummaryLatencyMs)
  }

  function runtimeResultStatusCode(
    events: NexusEvent[],
    errorEvent: NexusEvent | undefined,
  ): number {
    if (events.some(event => event.type === 'context_blocking')) return 413
    if (errorEvent?.type === 'error' && errorEvent.code === 'REQUEST_TIMEOUT') return 408
    return 200
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
    let activeSessionId: string | undefined
    let activeRequestId: string | undefined
    try {
      const body = executeSchema.parse(request.body)
      const prepared = await prepareExecution(body)
      if (isPrepareError(prepared)) {
        return reply.status(prepared.status).send({ type: 'error', code: prepared.code, message: prepared.message })
      }
      const { sessionId, cwd, requestId, abortController, timeoutController, timeout } = prepared
      activeSessionId = sessionId
      activeRequestId = requestId
      registerActiveExecution(sessionId, {
        requestId,
        abortController,
        transport: 'http',
        startedAt: nowIso(),
      })

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
          remoteRunner: options.remoteRunner,
          allowedPaths: prepared.allowedPaths,
        })) {
          events.push(event)
          await options.storage.appendEvent(sessionId, event)
          recordEventMetrics(event)
        }
      } finally {
        clearTimeout(timeout)
      }

      const resultEvent = events.findLast(event => event.type === 'result')
      const errorEvent = events.findLast(event => event.type === 'error')
      const statusCode = runtimeResultStatusCode(events, errorEvent)
      const timedOut = abortController.signal.aborted
      const timeoutEvent =
        errorEvent?.type === 'error' && errorEvent.code === 'REQUEST_TIMEOUT'
      const succeeded =
        !timedOut && !errorEvent && resultEvent?.type === 'result' && resultEvent.success
      await finalizeExecutionSession(options.storage, sessionId, {
        succeeded,
        resultEvent,
        errorEvent,
        contextBlockingEvent: events.find(event => event.type === 'context_blocking'),
      })
      metrics.recordExecuteFinish({
        success: succeeded,
        timedOut: timedOut || timeoutEvent,
        durationMs: metrics.now() - startedAtMs,
      })

      return {
        type: 'execute_result',
        sessionId,
        success: succeeded,
        statusCode,
        durationMs: round(metrics.now() - startedAtMs),
        result: resultEvent ?? null,
        error: errorEvent ?? null,
        events,
      }
    } finally {
      if (activeSessionId && activeRequestId) {
        clearActiveExecution(activeSessionId, activeRequestId)
      }
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

  app.get('/v1/sessions/:sessionId/assets', async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    const query = sessionAssetsQuerySchema.parse(request.query)
    const snapshot = await buildSessionAssetsSnapshot({
      storage: options.storage,
      sessionId: params.sessionId,
      assetOptions: query,
    })
    if (!snapshot) {
      return reply.code(404).send({
        type: 'error',
        code: 'SESSION_NOT_FOUND',
        message: `Session not found: ${params.sessionId}`,
      })
    }
    return snapshot
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

  app.get('/v1/sessions/:sessionId/children', async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    const query = childSessionsQuerySchema.parse(request.query)
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

    const childSessions = (await options.storage.listChildSessions(params.sessionId, {
      limit: query.limit,
      includeEvents: false,
    })).filter(child => !query.failedOnly || child.phase === 'failed' || child.phase === 'cancelled' || child.metadata?.status === 'failed' || child.metadata?.status === 'cancelled')

    const children = await Promise.all(childSessions.map(async child => {
      const page = query.includeEvents && query.eventLimit > 0
        ? await options.storage.listEvents(child.sessionId, {
            limit: query.eventLimit,
            order: 'desc',
          })
        : undefined
      return {
        session: { ...child, events: [] },
        transcriptPath: typeof child.metadata?.transcriptPath === 'string'
          ? child.metadata.transcriptPath
          : `nexus://sessions/${child.sessionId}/events`,
        events: page
          ? {
              items: [...page.events].reverse(),
              truncated: page.nextCursor !== undefined,
              limit: query.eventLimit,
              order: 'asc',
            }
          : undefined,
      }
    }))

    return {
      type: 'child_sessions',
      sessionId: params.sessionId,
      children,
      limit: query.limit,
      eventLimit: query.eventLimit,
    }
  })

  app.get('/v1/sessions/:sessionId/children/:childSessionId/events', async (request, reply) => {
    const params = z.object({ sessionId: z.string(), childSessionId: z.string() }).parse(request.params)
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
    const child = await options.storage.getSession(params.childSessionId, {
      includeEvents: false,
    })
    if (!child || child.parentSessionId !== params.sessionId) {
      return reply.code(404).send({
        type: 'error',
        code: 'CHILD_SESSION_NOT_FOUND',
        message: `Child session not found: ${params.childSessionId}`,
      })
    }
    const page = await options.storage.listEvents(params.childSessionId, query)
    return {
      type: 'child_session_events',
      sessionId: params.sessionId,
      childSessionId: params.childSessionId,
      transcriptPath: typeof child.metadata?.transcriptPath === 'string'
        ? child.metadata.transcriptPath
        : `nexus://sessions/${child.sessionId}/events`,
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
        contextFork: readContextForkMetadata(session.metadata),
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

  app.post('/v1/sessions/:sessionId/resume', async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    const body = sessionResumeSchema.parse(request.body ?? {})
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

    const eventPage = await options.storage.listEvents(params.sessionId, {
      limit: body.recentEventLimit ?? 100,
      order: 'desc',
    })
    const tasks = body.includeTasks === false
      ? []
      : await options.storage.listTasks(params.sessionId)
    const childSessions = body.includeChildSessions === false
      ? []
      : await options.storage.listChildSessions(params.sessionId, {
          limit: 200,
          includeEvents: false,
        })
    const activeExecution = activeExecutions.get(params.sessionId)

    return {
      type: 'session_resume_snapshot',
      sessionId: params.sessionId,
      session: {
        ...session,
        events: [...eventPage.events].reverse(),
      },
      eventsTruncated: eventPage.nextCursor !== undefined,
      recentEventLimit: body.recentEventLimit ?? 100,
      tasks,
      childSessions,
      activeExecution: activeExecution
        ? {
            requestId: activeExecution.requestId,
            transport: activeExecution.transport,
            startedAt: activeExecution.startedAt,
          }
        : null,
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
    const body = z.object({ reason: z.string().optional() }).parse(request.body ?? {})
    const activeExecution = activeExecutions.get(params.sessionId)
    if (activeExecution) {
      activeExecution.abortController.abort()
    }
    const { session, permissionsResolved, childSessionsCancelled } = await closeNexusSession({
      storage: options.storage,
      sessionId: params.sessionId,
      phase: 'cancelled',
      reason: body.reason ?? 'Session cancelled',
      hooks: ConfigManager.getInstance().load().hooks,
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
      phase: session.phase,
      activeExecutionCancelled: activeExecution !== undefined,
      requestId: activeExecution?.requestId,
      transport: activeExecution?.transport,
      permissionsResolved,
      childSessionsCancelled,
    }
  })

  app.post('/v1/sessions/:sessionId/close', async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    const body = z.object({
      phase: z.enum(['cancelled', 'completed', 'failed']).optional(),
      reason: z.string().optional(),
    }).parse(request.body ?? {})
    const { session, permissionsResolved, childSessionsCancelled } = await closeNexusSession({
      storage: options.storage,
      sessionId: params.sessionId,
      phase: body.phase,
      reason: body.reason,
      hooks: ConfigManager.getInstance().load().hooks,
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
      childSessionsCancelled,
    }
  })

  app.get('/v1/sessions/:sessionId/tasks', async request => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    return {
      type: 'tasks_list',
      tasks: await options.storage.listTasks(params.sessionId),
    }
  })

  app.post('/v1/sessions/:sessionId/tasks', async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    const body = createTaskSchema.parse(request.body)
    const session = await getMutableSession(options.storage, params.sessionId)
    if (!session) return reply.code(404).send(createSessionNotFoundPayload(params.sessionId))
    if (isTerminalSessionPhase(session.phase)) return reply.code(409).send(createSessionNotMutablePayload(session))
    const existing = body.requestId ? await findTaskByMutationRequestId(options.storage, params.sessionId, body.requestId) : undefined
    if (existing) return { type: 'task_created', task: existing, idempotent: true }
    const task: NexusTask = {
      taskId: createId('task'),
      sessionId: params.sessionId,
      title: body.title,
      description: body.description,
      status: 'pending',
      source: 'user',
      metadata: attachMutationRequestId(body.metadata, body.requestId),
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
    await appendTaskMutationAudit(options.storage, params.sessionId, 'task_created', undefined, task, body)
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
    const session = await getMutableSession(options.storage, params.sessionId)
    if (!session) return reply.code(404).send(createSessionNotFoundPayload(params.sessionId))
    if (isTerminalSessionPhase(session.phase)) return reply.code(409).send(createSessionNotMutablePayload(session))
    const conflict = checkTaskRevision(task, body.expectedUpdatedAt)
    if (conflict) return reply.code(409).send(conflict)
    const updated: NexusTask = {
      ...task,
      ...pickTaskPatch(body),
      metadata: mergeTaskMetadata(task.metadata, body.metadata, body.requestId),
      updatedAt: nowIso(),
    }
    await options.storage.saveTask(updated)
    await appendTaskMutationAudit(options.storage, params.sessionId, 'task_updated', task, updated, body)
    return {
      type: 'task_updated',
      task: updated,
    }
  })

  app.post('/v1/sessions/:sessionId/tasks/:taskId/claim', async (request, reply) => {
    return mutateTaskAction(options.storage, request.params, request.body, reply, 'task_claimed', task => ({
      ...task,
      status: 'in_progress',
    }))
  })

  app.post('/v1/sessions/:sessionId/tasks/:taskId/complete', async (request, reply) => {
    return mutateTaskAction(options.storage, request.params, request.body, reply, 'task_completed', (task, body) => ({
      ...task,
      status: 'completed',
      result: body.result,
    }))
  })

  app.post('/v1/sessions/:sessionId/tasks/:taskId/fail', async (request, reply) => {
    return mutateTaskAction(options.storage, request.params, request.body, reply, 'task_failed', async (task, body) => {
      const failedTask: NexusTask = {
        ...task,
        status: 'failed',
        result: body.result,
      }
      const blockedTasksFailed = await propagateFailedDependency(
        options.storage,
        task.sessionId,
        failedTask,
      )
      return {
        ...failedTask,
        metadata: {
          ...(failedTask.metadata ?? {}),
          ...(blockedTasksFailed.length > 0 ? { blockedTasksFailed } : {}),
        },
      }
    })
  })

  app.post('/v1/sessions/:sessionId/tasks/:taskId/cancel', async (request, reply) => {
    return mutateTaskAction(options.storage, request.params, request.body, reply, 'task_cancelled', async (task, body) => {
      const childSessionsCancelled = await cancelChildSessionsForTask(
        options.storage,
        task.sessionId,
        task.taskId,
        body.reason ?? 'Task cancelled',
      )
      const blockedTasksFailed = await failBlockedTasksForDependency(
        options.storage,
        task.sessionId,
        task.taskId,
        body.reason ?? 'Task cancelled',
      )
      return {
        ...task,
        status: 'cancelled',
        metadata: {
          ...(task.metadata ?? {}),
          ...(childSessionsCancelled.length > 0 ? { childSessionsCancelled } : {}),
          ...(blockedTasksFailed.length > 0 ? { blockedTasksFailed } : {}),
        },
      }
    })
  })

  app.post('/v1/sessions/:sessionId/tasks/:taskId/retry', async (request, reply) => {
    return mutateTaskAction(options.storage, request.params, request.body, reply, 'task_retried', async task => {
      const blockedTasksRestored = await restoreTasksFailedByDependency(
        options.storage,
        task.sessionId,
        task.taskId,
      )
      return {
        ...task,
        status: 'pending',
        retryCount: task.retryCount + 1,
        result: undefined,
        review: task.review?.status === 'pending' ? task.review : undefined,
        metadata: {
          ...(task.metadata ?? {}),
          ...(blockedTasksRestored.length > 0 ? { blockedTasksRestored } : {}),
        },
      }
    })
  })

  app.post('/v1/sessions/:sessionId/tasks/:taskId/rerun-subagent', async (request, reply) => {
    const params = z
      .object({ sessionId: z.string(), taskId: z.string() })
      .parse(request.params)
    const body = subAgentRerunSchema.parse(request.body ?? {})
    const task = await options.storage.getTask(params.taskId)
    if (!task || task.sessionId !== params.sessionId) {
      return reply.code(404).send({
        type: 'error',
        code: 'TASK_NOT_FOUND',
        message: `Task not found: ${params.taskId}`,
      })
    }
    const session = await options.storage.getSession(params.sessionId, { includeEvents: false })
    if (!session) return reply.code(404).send(createSessionNotFoundPayload(params.sessionId))
    const conflict = checkTaskRevision(task, body.expectedUpdatedAt)
    if (conflict) return reply.code(409).send(conflict)
    const updated = await applySubAgentRerunAction(options.storage, session, task, body)
    await appendTaskMutationAudit(options.storage, params.sessionId, 'subagent_rerun_requested', task, updated, body)
    return {
      type: 'subagent_rerun_requested',
      task: updated,
    }
  })

  app.post('/v1/sessions/:sessionId/tasks/:taskId/worktree-recovery', async (request, reply) => {
    const params = z
      .object({ sessionId: z.string(), taskId: z.string() })
      .parse(request.params)
    const body = worktreeRecoveryActionSchema.parse(request.body ?? {})
    const task = await options.storage.getTask(params.taskId)
    if (!task || task.sessionId !== params.sessionId) {
      return reply.code(404).send({
        type: 'error',
        code: 'TASK_NOT_FOUND',
        message: `Task not found: ${params.taskId}`,
      })
    }
    const session = await getMutableSession(options.storage, params.sessionId)
    if (!session) return reply.code(404).send(createSessionNotFoundPayload(params.sessionId))
    const conflict = checkTaskRevision(task, body.expectedUpdatedAt)
    if (conflict) return reply.code(409).send(conflict)
    const updated = await applyWorktreeRecoveryAction(options.storage, session, task, body)
    await appendTaskMutationAudit(options.storage, params.sessionId, 'worktree_recovery_action', task, updated, body)
    return {
      type: 'worktree_recovery_action',
      action: body.action,
      task: updated,
    }
  })

  app.post('/v1/sessions/:sessionId/tasks/:taskId/approve', async (request, reply) => {
    return mutateTaskAction(options.storage, request.params, request.body, reply, 'task_approved', (task, body) => {
      assertPendingTaskReview(task)
      return {
        ...task,
        review: {
          ...task.review,
          status: 'approved',
          reason: body.reviewReason ?? body.reason,
        },
      }
    })
  })

  app.post('/v1/sessions/:sessionId/tasks/:taskId/reject', async (request, reply) => {
    return mutateTaskAction(options.storage, request.params, request.body, reply, 'task_rejected', (task, body) => {
      assertPendingTaskReview(task)
      return {
        ...task,
        review: {
          ...task.review,
          status: 'rejected',
          reason: body.reviewReason ?? body.reason,
        },
      }
    })
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
      registerActiveExecution(sessionId, {
        requestId,
        abortController,
        transport: 'websocket',
        startedAt: nowIso(),
      })
      const timeout = prepared.timeout
      const events: NexusEvent[] = []

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
          remoteRunner: options.remoteRunner,
          allowedPaths: prepared.allowedPaths,
        })) {
          events.push(event)
          await options.storage.appendEvent(sessionId, event)
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
      const resultEvent = events.findLast(event => event.type === 'result')
      const errorEvent = events.findLast(event => event.type === 'error')
      await finalizeExecutionSession(options.storage, sessionId, {
        succeeded: success,
        resultEvent,
        errorEvent,
        contextBlockingEvent: events.find(event => event.type === 'context_blocking'),
      })
      } finally {
        socket.off('close', markClosed)
        if (abortController) {
          for (const [sessionId, execution] of activeExecutions.entries()) {
            if (execution.abortController === abortController) {
              clearActiveExecution(sessionId, execution.requestId)
              break
            }
          }
        }
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

async function findAgentJob(scheduler: AgentScheduler, jobId: string): Promise<AgentJob | undefined> {
  try {
    return (await scheduler.listAgents()).find(job => job.jobId === jobId)
  } catch (error) {
    if (error instanceof AgentJobRegistryError && error.code === 'AGENT_JOB_NOT_FOUND') return undefined
    throw error
  }
}

function sendAgentError(reply: FastifyReply, error: AgentJobRegistryError): unknown {
  return reply.code(error.status).send({
    type: 'error',
    code: error.code,
    message: error.message,
  })
}

function createAgentJobNotFoundPayload(jobId: string): { type: 'error'; code: string; message: string } {
  return {
    type: 'error',
    code: 'AGENT_JOB_NOT_FOUND',
    message: `Agent job not found: ${jobId}`,
  }
}

function readContextForkMetadata(metadata: Record<string, unknown> | undefined): { mode: string; inheritedItems: number; omittedItems: number } | undefined {
  const contextFork = asRecord(metadata?.contextFork)
  const mode = typeof metadata?.contextForkMode === 'string'
    ? metadata.contextForkMode
    : typeof contextFork?.mode === 'string'
      ? contextFork.mode
      : undefined
  if (!mode) return undefined
  const inheritedItems = typeof contextFork?.inheritedItems === 'number' ? contextFork.inheritedItems : 0
  const omittedItems = typeof contextFork?.omittedItems === 'number' ? contextFork.omittedItems : 0
  return { mode, inheritedItems, omittedItems }
}

type ExecutionFinalizationOptions = {
  succeeded: boolean
  resultEvent?: NexusEvent
  errorEvent?: NexusEvent
  contextBlockingEvent?: NexusEvent
}

async function finalizeExecutionSession(
  storage: NexusStorage,
  sessionId: string,
  finalization: ExecutionFinalizationOptions,
): Promise<void> {
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
    session.metadata = withRuntimeRecoveryMetadata(
      session.metadata,
      runtimeRecoveryMetadata(finalization.errorEvent, finalization.contextBlockingEvent),
    )
  } else {
    session.metadata = withRuntimeRecoveryMetadata(session.metadata)
  }

  await storage.saveSession(session)
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

function runtimeRecoveryMetadata(
  errorEvent: Extract<NexusEvent, { type: 'error' }>,
  contextBlockingEvent?: NexusEvent,
): Record<string, unknown> | undefined {
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
    suggestion: typeof details?.suggestion === 'string'
      ? details.suggestion
      : 'Run /compact or /context, switch to a larger context model, or reduce tool output before retrying.',
  }
}

function withRuntimeRecoveryMetadata(
  metadata: Record<string, unknown> | undefined,
  runtimeRecovery?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const next = { ...(metadata ?? {}) }
  delete next.runtimeRecovery
  if (runtimeRecovery) next.runtimeRecovery = runtimeRecovery
  return Object.keys(next).length > 0 ? next : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function recoveryActionsValue(value: unknown): string[] {
  const allowed = new Set(['compact', 'context', 'switch_model', 'reduce_tool_output'])
  const actions = Array.isArray(value)
    ? value.filter((action): action is string => typeof action === 'string' && allowed.has(action))
    : []
  return actions.length > 0 ? actions : ['compact', 'context', 'switch_model', 'reduce_tool_output']
}

type TaskMutationAudit = z.infer<typeof taskMutationAuditSchema>

type TaskActionBody = z.infer<typeof taskActionSchema>

type WorktreeRecoveryActionBody = z.infer<typeof worktreeRecoveryActionSchema>

type SubAgentRerunBody = z.infer<typeof subAgentRerunSchema>

type WorktreeRecoveryMetadata = {
  type?: string
  status?: string
  cwd?: string
  worktreePath?: string
  preservedWorktreePath?: string
  taskId?: string
}

type SubAgentReferenceMetadata = {
  status?: string
  subSessionId?: string
  transcriptPath?: string
  summary?: string
  resultEventRange?: unknown
}

type TaskMutationHttpError = {
  statusCode: number
  payload: { type: 'error'; code: string; message: string; task?: NexusTask }
}

async function mutateTaskAction(
  storage: NexusStorage,
  rawParams: unknown,
  rawBody: unknown,
  reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } },
  eventType: string,
  apply: (task: NexusTask, body: TaskActionBody) => NexusTask | Promise<NexusTask>,
): Promise<unknown> {
  const params = z
    .object({ sessionId: z.string(), taskId: z.string() })
    .parse(rawParams)
  const body = taskActionSchema.parse(rawBody ?? {})
  const task = await storage.getTask(params.taskId)
  if (!task || task.sessionId !== params.sessionId) {
    return reply.code(404).send({
      type: 'error',
      code: 'TASK_NOT_FOUND',
      message: `Task not found: ${params.taskId}`,
    })
  }
  const session = await getMutableSession(storage, params.sessionId)
  if (!session) return reply.code(404).send(createSessionNotFoundPayload(params.sessionId))
  if (isTerminalSessionPhase(session.phase)) return reply.code(409).send(createSessionNotMutablePayload(session))
  const conflict = checkTaskRevision(task, body.expectedUpdatedAt)
  if (conflict) return reply.code(409).send(conflict)
  let applied: NexusTask
  try {
    applied = await apply(task, body)
  } catch (error) {
    if (isTaskMutationHttpError(error)) return reply.code(error.statusCode).send(error.payload)
    throw error
  }
  const updated = {
    ...applied,
    ownerAgentId: body.ownerAgentId ?? applied.ownerAgentId,
    metadata: mergeTaskMetadata(task.metadata, applied.metadata, body.requestId),
    updatedAt: nowIso(),
  }
  await storage.saveTask(updated)
  await appendTaskMutationAudit(storage, params.sessionId, eventType, task, updated, body)
  return { type: eventType, task: updated }
}

async function applySubAgentRerunAction(
  storage: NexusStorage,
  session: SessionSnapshot,
  task: NexusTask,
  body: SubAgentRerunBody,
): Promise<NexusTask> {
  const subAgent = getFailedSubAgentMetadata(task)
  if (!subAgent) {
    throw createTaskMutationHttpError(409, 'SUBAGENT_RERUN_NOT_AVAILABLE', `Task ${task.taskId} does not reference a failed sub-agent.`, task)
  }

  const previousSubAgents = Array.isArray(task.metadata?.previousSubAgents)
    ? [...task.metadata.previousSubAgents]
    : []
  const blockedTasksRestored = await restoreTasksFailedByDependency(
    storage,
    task.sessionId,
    task.taskId,
  )
  const rerunRequest = {
    requestedAt: nowIso(),
    requestedBy: body.actor ?? 'external',
    source: body.source ?? 'sdk',
    reason: body.reason,
    previousSubSessionId: subAgent.subSessionId,
    previousTranscriptPath: subAgent.transcriptPath,
    nextRetryCount: task.retryCount + 1,
  }
  const updated: NexusTask = {
    ...task,
    status: 'pending',
    ownerAgentId: undefined,
    retryCount: task.retryCount + 1,
    result: undefined,
    review: task.review?.status === 'pending' ? task.review : undefined,
    metadata: {
      ...(task.metadata ?? {}),
      previousSubAgents: [...previousSubAgents, subAgent],
      subAgentRerun: rerunRequest,
      ...(blockedTasksRestored.length > 0 ? { blockedTasksRestored } : {}),
    },
    updatedAt: nowIso(),
  }
  await storage.saveTask(updated)

  if (session.phase === 'failed' || session.phase === 'cancelled') {
    await storage.saveSession({
      ...session,
      phase: 'executing',
      terminalReason: undefined,
      error: undefined,
      failureReason: undefined,
      lastUserInput: 'sub-agent rerun requested',
      updatedAt: nowIso(),
    })
  }
  return updated
}

function getFailedSubAgentMetadata(task: NexusTask): SubAgentReferenceMetadata | undefined {
  const subAgent = task.metadata?.subAgent
  if (typeof subAgent !== 'object' || subAgent === null) return undefined
  const typed = subAgent as SubAgentReferenceMetadata
  if (typed.status !== 'failed' && typed.status !== 'cancelled') return undefined
  if (!typed.subSessionId || !typed.transcriptPath) return undefined
  return typed
}

async function applyWorktreeRecoveryAction(
  storage: NexusStorage,
  session: SessionSnapshot,
  task: NexusTask,
  body: WorktreeRecoveryActionBody,
): Promise<NexusTask> {
  const recovery = getWorktreeRecoveryMetadata(task)
  if (!recovery) {
    throw createTaskMutationHttpError(409, 'WORKTREE_RECOVERY_NOT_AVAILABLE', `Task ${task.taskId} does not have pending worktree recovery metadata.`, task)
  }

  const nextRecovery = {
    ...recovery,
    status: body.action === 'continue'
      ? 'retry_requested'
      : body.action === 'abandon'
        ? 'abandoned'
        : 'kept',
    selectedAction: body.action,
    selectedAt: nowIso(),
    selectedBy: body.actor ?? 'external',
    reason: body.reason,
  }

  if (body.action === 'abandon' || body.action === 'continue') {
    const { cwd, worktreePath } = assertRecoverableWorktreePath(session, task, recovery)
    await removeWorktree(cwd, worktreePath, task.taskId)
  }

  const updated: NexusTask = {
    ...task,
    status: body.action === 'continue' ? 'pending' : task.status,
    ownerAgentId: body.action === 'continue' ? undefined : task.ownerAgentId,
    retryCount: body.action === 'continue' ? task.retryCount + 1 : task.retryCount,
    result: body.action === 'continue' ? undefined : task.result,
    review: body.action === 'continue'
      ? task.review?.status === 'pending' ? task.review : undefined
      : task.review,
    metadata: {
      ...(task.metadata ?? {}),
      worktreeRecovery: nextRecovery,
    },
    updatedAt: nowIso(),
  }
  await storage.saveTask(updated)

  const nextSession: SessionSnapshot = {
    ...session,
    phase: body.action === 'continue' && session.phase === 'waiting_user' ? 'executing' : session.phase,
    pendingInput: body.action === 'continue' ? undefined : session.pendingInput,
    lastUserInput: `worktree recovery ${body.action}`,
    updatedAt: nowIso(),
  }
  await storage.saveSession(nextSession)
  return updated
}

function getWorktreeRecoveryMetadata(task: NexusTask): WorktreeRecoveryMetadata | undefined {
  const recovery = task.metadata?.worktreeRecovery
  if (typeof recovery !== 'object' || recovery === null) return undefined
  const typed = recovery as WorktreeRecoveryMetadata
  if (typed.type !== 'worktree_merge_conflict') return undefined
  if (typed.status && !['awaiting_manual_recovery', 'kept'].includes(typed.status)) return undefined
  return typed
}

function assertRecoverableWorktreePath(
  session: SessionSnapshot,
  task: NexusTask,
  recovery: WorktreeRecoveryMetadata,
): { cwd: string; worktreePath: string } {
  const cwd = recovery.cwd
  const worktreePath = recovery.preservedWorktreePath ?? recovery.worktreePath
  if (!cwd || !worktreePath) {
    throw createTaskMutationHttpError(409, 'WORKTREE_RECOVERY_INVALID', `Task ${task.taskId} worktree recovery metadata is missing cwd or worktreePath.`, task)
  }
  const resolvedCwd = resolve(cwd)
  const resolvedWorktreePath = resolve(worktreePath)
  const expectedPrefix = resolve(resolvedCwd, '.babel-o', 'worktrees')
  if (resolvedCwd !== resolve(session.cwd) || !resolvedWorktreePath.startsWith(`${expectedPrefix}/`)) {
    throw createTaskMutationHttpError(409, 'WORKTREE_RECOVERY_INVALID', `Task ${task.taskId} worktree recovery path is outside the session worktree directory.`, task)
  }
  return { cwd: resolvedCwd, worktreePath: resolvedWorktreePath }
}

function pickTaskPatch(body: z.infer<typeof updateTaskSchema>): Partial<NexusTask> {
  const patch: Partial<NexusTask> = {}
  if (body.title !== undefined) patch.title = body.title
  if (body.description !== undefined) patch.description = body.description
  if (body.status !== undefined) patch.status = body.status
  if (body.result !== undefined) patch.result = body.result
  return patch
}

function checkTaskRevision(task: NexusTask, expectedUpdatedAt?: string): { type: 'error'; code: string; message: string; task: NexusTask } | undefined {
  if (expectedUpdatedAt && task.updatedAt !== expectedUpdatedAt) {
    return {
      type: 'error',
      code: 'TASK_REVISION_CONFLICT',
      message: `Task ${task.taskId} was updated after expected revision ${expectedUpdatedAt}.`,
      task,
    }
  }
  return undefined
}

async function getMutableSession(storage: NexusStorage, sessionId: string): Promise<SessionSnapshot | null> {
  return storage.getSession(sessionId, { includeEvents: false })
}

function isTerminalSessionPhase(phase: SessionSnapshot['phase']): boolean {
  return TERMINAL_SESSION_PHASES.has(phase)
}

function createSessionNotFoundPayload(sessionId: string): { type: 'error'; code: string; message: string } {
  return {
    type: 'error',
    code: 'SESSION_NOT_FOUND',
    message: `Session not found: ${sessionId}`,
  }
}

function createSessionNotMutablePayload(session: SessionSnapshot): { type: 'error'; code: string; message: string; session: SessionSnapshot } {
  return {
    type: 'error',
    code: 'SESSION_NOT_MUTABLE',
    message: `Session ${session.sessionId} is ${session.phase} and cannot accept task mutations.`,
    session,
  }
}

function assertPendingTaskReview(task: NexusTask): void {
  if (task.review?.status === 'pending') return
  throw createTaskMutationHttpError(409, 'TASK_REVIEW_NOT_PENDING', `Task ${task.taskId} does not have a pending review.`, task)
}

function createTaskMutationHttpError(statusCode: number, code: string, message: string, task?: NexusTask): TaskMutationHttpError {
  return {
    statusCode,
    payload: {
      type: 'error',
      code,
      message,
      task,
    },
  }
}

function isTaskMutationHttpError(error: unknown): error is TaskMutationHttpError {
  return typeof error === 'object'
    && error !== null
    && 'statusCode' in error
    && 'payload' in error
}

function attachMutationRequestId(metadata: Record<string, unknown> | undefined, requestId: string | undefined): Record<string, unknown> | undefined {
  if (!requestId) return metadata
  return {
    ...(metadata ?? {}),
    mutationRequestId: requestId,
  }
}

function mergeTaskMetadata(current: Record<string, unknown> | undefined, patch: Record<string, unknown> | undefined, requestId: string | undefined): Record<string, unknown> | undefined {
  if (!current && !patch && !requestId) return undefined
  return {
    ...(current ?? {}),
    ...(patch ?? {}),
    ...(requestId ? { mutationRequestId: requestId } : {}),
  }
}

async function findTaskByMutationRequestId(storage: NexusStorage, sessionId: string, requestId: string): Promise<NexusTask | undefined> {
  const tasks = await storage.listTasks(sessionId)
  return tasks.find(task => task.metadata?.mutationRequestId === requestId)
}

const TERMINAL_SESSION_PHASES = new Set(['completed', 'failed', 'cancelled'])

async function cancelChildSessionsForTask(
  storage: NexusStorage,
  sessionId: string,
  taskId: string,
  reason: string,
): Promise<string[]> {
  const cancelled: string[] = []
  for (const child of await storage.listChildSessions(sessionId, { limit: 200 })) {
    if (TERMINAL_SESSION_PHASES.has(child.phase)) continue
    if (!isChildSessionForTask(child, taskId)) continue
    child.phase = 'cancelled'
    child.terminalReason = {
      category: 'cancelled',
      code: 'TASK_CANCELLED',
      message: reason,
    }
    child.updatedAt = nowIso()
    child.metadata = {
      ...(child.metadata ?? {}),
      status: 'cancelled',
      cancelledByTaskId: taskId,
      cancelReason: reason,
    }
    await storage.saveSession(child)
    cancelled.push(child.sessionId)
  }
  return cancelled
}

function isChildSessionForTask(child: { currentTaskId?: string; metadata?: Record<string, unknown> }, taskId: string): boolean {
  return child.currentTaskId === taskId || child.metadata?.parentTaskId === taskId || child.metadata?.taskId === taskId
}

async function failBlockedTasksForDependency(
  storage: NexusStorage,
  sessionId: string,
  taskId: string,
  reason: string,
): Promise<string[]> {
  const failed: string[] = []
  for (const task of await storage.listTasks(sessionId)) {
    if (task.taskId === taskId) continue
    if (!task.dependsOn.includes(taskId)) continue
    if (!isDependencyFailureTarget(task)) continue
    const updated: NexusTask = {
      ...task,
      status: 'failed',
      result: `Dependency task ${taskId} was cancelled.`,
      metadata: {
        ...(task.metadata ?? {}),
        failedDependencyTaskId: taskId,
        failedDependencyReason: reason,
      },
      updatedAt: nowIso(),
    }
    await storage.saveTask(updated)
    failed.push(task.taskId)
  }
  return failed
}

async function propagateFailedDependency(
  storage: NexusStorage,
  sessionId: string,
  failedTask: NexusTask,
): Promise<string[]> {
  const failed: string[] = []
  let changed = true
  while (changed) {
    changed = false
    for (const task of await storage.listTasks(sessionId)) {
      if (task.taskId === failedTask.taskId) continue
      if (!isDependencyFailureTarget(task)) continue
      const failedDependencies = await getFailedDependencies(storage, task, failedTask)
      if (failedDependencies.length === 0) continue
      const updated: NexusTask = {
        ...task,
        status: 'failed',
        result: failedDependencies
          .map(dep => dep.result || `Dependency ${dep.taskId} failed`)
          .join('\n') || 'Dependency failed',
        metadata: {
          ...(task.metadata ?? {}),
          failedDependencies: failedDependencies.map(dep => ({
            taskId: dep.taskId,
            title: dep.title,
            result: dep.result,
            metadata: dep.metadata,
          })),
        },
        updatedAt: nowIso(),
      }
      await storage.saveTask(updated)
      failed.push(task.taskId)
      changed = true
    }
  }
  return [...new Set(failed)]
}

async function getFailedDependencies(storage: NexusStorage, task: NexusTask, currentFailedTask: NexusTask): Promise<NexusTask[]> {
  const failed: NexusTask[] = []
  for (const dependencyId of task.dependsOn) {
    if (dependencyId === currentFailedTask.taskId) {
      failed.push(currentFailedTask)
      continue
    }
    const dependency = await storage.getTask(dependencyId)
    if (dependency?.status === 'failed') failed.push(dependency)
  }
  return failed
}

async function restoreTasksFailedByDependency(
  storage: NexusStorage,
  sessionId: string,
  dependencyTaskId: string,
): Promise<string[]> {
  const restored: string[] = []
  for (const task of await storage.listTasks(sessionId)) {
    if (task.taskId === dependencyTaskId) continue
    if (task.status !== 'failed') continue
    if (!task.dependsOn.includes(dependencyTaskId)) continue
    if (!hasFailedDependencyMetadata(task, dependencyTaskId)) continue
    const metadata = { ...(task.metadata ?? {}) }
    delete metadata.failedDependencyTaskId
    delete metadata.failedDependencyReason
    delete metadata.failedDependencies
    const updated: NexusTask = {
      ...task,
      status: 'blocked',
      result: undefined,
      metadata,
      updatedAt: nowIso(),
    }
    await storage.saveTask(updated)
    restored.push(task.taskId)
  }
  return restored
}

function isDependencyFailureTarget(task: NexusTask): boolean {
  return task.status === 'blocked' || task.status === 'pending' || task.status === 'in_progress'
}

function hasFailedDependencyMetadata(task: NexusTask, dependencyTaskId: string): boolean {
  if (task.metadata?.failedDependencyTaskId === dependencyTaskId) return true
  const failedDependencies = task.metadata?.failedDependencies
  return Array.isArray(failedDependencies) && failedDependencies.some(dep =>
    typeof dep === 'object' && dep !== null && (dep as { taskId?: unknown }).taskId === dependencyTaskId,
  )
}

async function appendTaskMutationAudit(
  storage: NexusStorage,
  sessionId: string,
  eventType: string,
  previous: NexusTask | undefined,
  next: NexusTask,
  audit: TaskMutationAudit,
): Promise<void> {
  await storage.appendEvent(sessionId, {
    type: 'task_session_event',
    schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
    sessionId,
    eventId: createId('task_event'),
    eventType,
    phase: next.status,
    timestamp: nowIso(),
    payload: {
      actor: audit.actor ?? 'external',
      source: audit.source ?? 'sdk',
      reason: audit.reason,
      requestId: audit.requestId,
      taskId: next.taskId,
      parentTaskId: typeof next.metadata?.parentTaskId === 'string' ? next.metadata.parentTaskId : undefined,
      previous: previous ? taskAuditSnapshot(previous) : undefined,
      next: taskAuditSnapshot(next),
    },
  })
}

function taskAuditSnapshot(task: NexusTask): {
  taskId: string
  title: string
  description?: string
  status: TaskStatus
  ownerAgentId?: string
  retryCount: number
  result?: string
  metadata?: Record<string, unknown>
  review?: NexusTask['review']
  updatedAt: string
} {
  return {
    taskId: task.taskId,
    title: task.title,
    description: task.description,
    status: task.status,
    ownerAgentId: task.ownerAgentId,
    retryCount: task.retryCount,
    result: task.result,
    metadata: task.metadata,
    review: task.review,
    updatedAt: task.updatedAt,
  }
}

type RuntimeMetricsSnapshot = ReturnType<NexusMetrics['snapshot']>

type ProviderInvocationMetrics = {
  count: number
  successCount: number
  failureCount: number
  durationMs: {
    totalMs: number
    count: number
    avgMs: number
  }
  byFailureKind: Record<string, number>
  byErrorCode: Record<string, number>
  byRole: Record<string, { count: number; successCount: number; failureCount: number; avgDurationMs: number }>
}

type AgentLoopMetrics = {
  sessionsObserved: number
  taskSessionEventCount: number
  taskCount: number
  completedTaskCount: number
  failedTaskCount: number
  retryCount: number
  subAgentSessionCount: number
  roleStepCount: number
  roleInputTokens: number
  roleOutputTokens: number
  roleDurationMs: {
    totalMs: number
    count: number
    avgMs: number
  }
  byRole: Record<string, {
    count: number
    successCount: number
    failureCount: number
    inputTokens: number
    outputTokens: number
    avgDurationMs: number
  }>
  byFailureType: Record<string, number>
}

type AgentJobMetrics = {
  count: number
  completedCount: number
  failedCount: number
  cancelledCount: number
  byAgentType: Record<string, { count: number; completedCount: number; failedCount: number; cancelledCount: number }>
  byFailureCode: Record<string, number>
}

async function buildRuntimeMetricsSnapshot(
  metrics: NexusMetrics,
  storage: NexusStorage,
): Promise<RuntimeMetricsSnapshot & {
  providerInvocations: ProviderInvocationMetrics
  agentLoop: AgentLoopMetrics
  agentJobs: AgentJobMetrics
}> {
  const snapshot = metrics.snapshot()
  const recentSessions = await storage.listSessions({ limit: 100, includeEvents: false })
  const providerInvocations = createProviderInvocationMetrics()
  const agentLoop = createAgentLoopMetrics()
  const agentJobs = createAgentJobMetrics()

  for (const session of recentSessions) {
    const page = await storage.listEvents(session.sessionId, { limit: 500, order: 'asc' })
    const sawTaskSessionEvent = page.events.some(event => event.type === 'task_session_event')
    if (sawTaskSessionEvent) agentLoop.sessionsObserved += 1
    for (const event of page.events) {
      recordProviderInvocationMetrics(providerInvocations, event)
      recordAgentLoopMetrics(agentLoop, event)
      recordAgentJobMetrics(agentJobs, event)
    }
  }

  finalizeProviderInvocationMetrics(providerInvocations)
  finalizeAgentLoopMetrics(agentLoop)
  return {
    ...snapshot,
    providerInvocations,
    agentLoop,
    agentJobs,
  }
}

function createProviderInvocationMetrics(): ProviderInvocationMetrics {
  return {
    count: 0,
    successCount: 0,
    failureCount: 0,
    durationMs: { totalMs: 0, count: 0, avgMs: 0 },
    byFailureKind: {},
    byErrorCode: {},
    byRole: {},
  }
}

function recordProviderInvocationMetrics(metrics: ProviderInvocationMetrics, event: NexusEvent): void {
  if (event.type !== 'hook_completed' || event.hookEvent !== 'PostInvocation') return
  const output = asRecord(event.output)
  const invocation = asRecord(output?.metadata)
  if (!invocation) return
  const success = invocation.success === true
  const role = typeof invocation.role === 'string' ? invocation.role : 'unknown'
  metrics.count += 1
  if (success) {
    metrics.successCount += 1
  } else {
    metrics.failureCount += 1
  }
  const durationMs = numberValue(invocation.durationMs)
  if (durationMs !== undefined) {
    metrics.durationMs.totalMs = round(metrics.durationMs.totalMs + durationMs)
    metrics.durationMs.count += 1
  }
  const failureKind = typeof invocation.failureKind === 'string' ? invocation.failureKind : undefined
  if (failureKind) metrics.byFailureKind[failureKind] = (metrics.byFailureKind[failureKind] ?? 0) + 1
  const errorCode = typeof invocation.errorCode === 'string' ? invocation.errorCode : undefined
  if (errorCode) metrics.byErrorCode[errorCode] = (metrics.byErrorCode[errorCode] ?? 0) + 1
  const roleMetrics = metrics.byRole[role] ?? { count: 0, successCount: 0, failureCount: 0, avgDurationMs: 0 }
  roleMetrics.count += 1
  if (success) roleMetrics.successCount += 1
  else roleMetrics.failureCount += 1
  if (durationMs !== undefined) {
    const previousTotal = roleMetrics.avgDurationMs * (roleMetrics.count - 1)
    roleMetrics.avgDurationMs = round((previousTotal + durationMs) / roleMetrics.count)
  }
  metrics.byRole[role] = roleMetrics
}

function finalizeProviderInvocationMetrics(metrics: ProviderInvocationMetrics): void {
  metrics.durationMs.avgMs = metrics.durationMs.count > 0
    ? round(metrics.durationMs.totalMs / metrics.durationMs.count)
    : 0
}

function createAgentLoopMetrics(): AgentLoopMetrics {
  return {
    sessionsObserved: 0,
    taskSessionEventCount: 0,
    taskCount: 0,
    completedTaskCount: 0,
    failedTaskCount: 0,
    retryCount: 0,
    subAgentSessionCount: 0,
    roleStepCount: 0,
    roleInputTokens: 0,
    roleOutputTokens: 0,
    roleDurationMs: { totalMs: 0, count: 0, avgMs: 0 },
    byRole: {},
    byFailureType: {},
  }
}

function recordAgentLoopMetrics(metrics: AgentLoopMetrics, event: NexusEvent): void {
  if (event.type !== 'task_session_event') return
  metrics.taskSessionEventCount += 1
  if (event.eventType === 'task_created') metrics.taskCount += 1
  if (event.eventType === 'task_completed') metrics.completedTaskCount += 1
  if (event.eventType === 'sub_agent_session_started') metrics.subAgentSessionCount += 1
  if (event.eventType === 'executor_failed_error') incrementCount(metrics.byFailureType, 'executor_error')
  if (event.eventType === 'critic_failed_error') incrementCount(metrics.byFailureType, 'critic_error')
  if (event.eventType === 'subagent_failed') incrementCount(metrics.byFailureType, 'subagent_failed')
  if (event.eventType === 'subagent_cancelled') incrementCount(metrics.byFailureType, 'subagent_cancelled')
  if (event.eventType === 'agent_loop_role_step_metrics') {
    recordAgentLoopRoleStepMetrics(metrics, event.payload)
    return
  }
  if (event.eventType !== 'task_updated') return
  const payload = asRecord(event.payload)
  const task = asRecord(payload?.task) ?? asRecord(payload?.next)
  const retryCount = numberValue(task?.retryCount)
  if (retryCount !== undefined && retryCount > 0) metrics.retryCount += 1
  if (task?.status === 'failed') metrics.failedTaskCount += 1
  const review = asRecord(task?.review)
  if (review?.reviewerAgentId === 'critic' && typeof review.reason === 'string') incrementCount(metrics.byFailureType, 'critic_rejected')
  if (review?.reviewerAgentId === 'system' && review.reason === 'Executor step returned failure or crashed') incrementCount(metrics.byFailureType, 'executor_failed')
}

function recordAgentLoopRoleStepMetrics(metrics: AgentLoopMetrics, payloadValue: unknown): void {
  const payload = asRecord(payloadValue)
  if (!payload) return
  const role = typeof payload.role === 'string' ? payload.role : 'unknown'
  const durationMs = numberValue(payload.durationMs) ?? 0
  const inputTokens = numberValue(payload.inputTokens) ?? 0
  const outputTokens = numberValue(payload.outputTokens) ?? 0
  const success = payload.success === true
  metrics.roleStepCount += 1
  metrics.roleInputTokens += inputTokens
  metrics.roleOutputTokens += outputTokens
  metrics.roleDurationMs.totalMs = round(metrics.roleDurationMs.totalMs + durationMs)
  metrics.roleDurationMs.count += 1
  const roleMetrics = metrics.byRole[role] ?? {
    count: 0,
    successCount: 0,
    failureCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    avgDurationMs: 0,
  }
  roleMetrics.count += 1
  if (success) roleMetrics.successCount += 1
  else roleMetrics.failureCount += 1
  roleMetrics.inputTokens += inputTokens
  roleMetrics.outputTokens += outputTokens
  const previousTotal = roleMetrics.avgDurationMs * (roleMetrics.count - 1)
  roleMetrics.avgDurationMs = round((previousTotal + durationMs) / roleMetrics.count)
  metrics.byRole[role] = roleMetrics
  const failureType = typeof payload.failureType === 'string' ? payload.failureType : undefined
  if (failureType) incrementCount(metrics.byFailureType, failureType)
  const errorCode = typeof payload.errorCode === 'string' ? payload.errorCode : undefined
  if (errorCode) incrementCount(metrics.byFailureType, errorCode)
}

function finalizeAgentLoopMetrics(metrics: AgentLoopMetrics): void {
  metrics.roleDurationMs.avgMs = metrics.roleDurationMs.count > 0
    ? round(metrics.roleDurationMs.totalMs / metrics.roleDurationMs.count)
    : 0
}

function createAgentJobMetrics(): AgentJobMetrics {
  return {
    count: 0,
    completedCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    byAgentType: {},
    byFailureCode: {},
  }
}

function recordAgentJobMetrics(metrics: AgentJobMetrics, event: NexusEvent): void {
  if (event.type !== 'agent_job_event') return
  if (event.eventType !== 'agent_job_completed' && event.eventType !== 'agent_job_failed' && event.eventType !== 'agent_job_cancelled') return
  metrics.count += 1
  const agentType = event.agentType
  const agentTypeMetrics = metrics.byAgentType[agentType] ?? { count: 0, completedCount: 0, failedCount: 0, cancelledCount: 0 }
  agentTypeMetrics.count += 1
  if (event.eventType === 'agent_job_completed') {
    metrics.completedCount += 1
    agentTypeMetrics.completedCount += 1
  } else if (event.eventType === 'agent_job_failed') {
    metrics.failedCount += 1
    agentTypeMetrics.failedCount += 1
    const error = asRecord(event.error)
    const code = typeof error?.code === 'string' ? error.code : 'unknown'
    incrementCount(metrics.byFailureCode, code)
  } else {
    metrics.cancelledCount += 1
    agentTypeMetrics.cancelledCount += 1
  }
  metrics.byAgentType[agentType] = agentTypeMetrics
}

function incrementCount(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1
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
