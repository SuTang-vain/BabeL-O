import Fastify, { type FastifyInstance } from 'fastify'
import { performance } from 'node:perf_hooks'
import { errorMessage } from '../shared/errors.js'
import type { AnyTool } from '../tools/Tool.js'

export const REMOTE_RUNNER_PROTOCOL_VERSION = '2026-06-04.babel-o.remote-runner.v1'

export type RemoteToolRunnerCapability = {
  tools?: string[]
  readOnly?: boolean
  bashEnabled?: boolean
  writeEnabled?: boolean
  maxConcurrentTools?: number
  maxOutputBytes?: number
  defaultDeadlineMs?: number
  maxDeadlineMs?: number
}

export type RemoteToolRunnerExecuteRequest = {
  protocolVersion: typeof REMOTE_RUNNER_PROTOCOL_VERSION
  sessionId: string
  requestId?: string
  toolUseId?: string
  toolName: string
  toolInput: unknown
  cwd: string
  allowedPaths?: string[]
  maxOutputBytes: number
  bashMaxBufferBytes: number
  deadlineMs?: number
}

export type RemoteToolRunnerCancelRequest = {
  sessionId: string
  requestId?: string
  toolUseId?: string
}

export type RemoteToolRunnerResult =
  | {
      kind: 'result'
      success: boolean
      output: unknown
      truncated?: boolean
      originalBytes?: number
      metrics?: RemoteToolRunnerResultMetrics
    }
  | {
      kind: 'error'
      code: string
      message: string
      details?: unknown
      metrics?: RemoteToolRunnerResultMetrics
    }

export type RemoteToolRunnerResultMetrics = {
  runnerId?: string
  protocolVersion?: string
  durationMs?: number
  roundtripMs?: number
  truncated?: boolean
  originalBytes?: number
  exitCode?: number
  signal?: string
  cancelled?: boolean
  timedOut?: boolean
  errorCode?: string
}

export interface RemoteToolRunner {
  readonly id: string
  readonly capabilities?: RemoteToolRunnerCapability
  canExecuteTool(tool: AnyTool): boolean
  executeTool(request: RemoteToolRunnerExecuteRequest): Promise<RemoteToolRunnerResult>
  cancelTool?(request: RemoteToolRunnerCancelRequest): Promise<void>
}

export type InMemoryRemoteToolRunnerHandlerContext = {
  signal: AbortSignal
}

export type InMemoryRemoteToolRunnerOptions = {
  id?: string
  capabilities?: RemoteToolRunnerCapability
  handler: (
    request: RemoteToolRunnerExecuteRequest,
    context: InMemoryRemoteToolRunnerHandlerContext,
  ) => Promise<RemoteToolRunnerResult> | RemoteToolRunnerResult
}

export class InMemoryRemoteToolRunner implements RemoteToolRunner {
  readonly id: string
  readonly capabilities?: RemoteToolRunnerCapability
  readonly requests: RemoteToolRunnerExecuteRequest[] = []
  readonly cancelRequests: RemoteToolRunnerCancelRequest[] = []
  private readonly active = new Map<string, AbortController>()

  constructor(private readonly options: InMemoryRemoteToolRunnerOptions) {
    this.id = options.id ?? 'in-memory-test-runner'
    this.capabilities = options.capabilities ?? { tools: ['*'] }
  }

  canExecuteTool(tool: AnyTool): boolean {
    const tools = this.capabilities?.tools
    return !tools || tools.includes('*') || tools.includes(tool.name)
  }

  async executeTool(request: RemoteToolRunnerExecuteRequest): Promise<RemoteToolRunnerResult> {
    this.requests.push(request)
    const controller = new AbortController()
    const key = remoteRunnerRequestKey(request)
    this.active.set(key, controller)
    try {
      return await this.options.handler(request, { signal: controller.signal })
    } finally {
      this.active.delete(key)
    }
  }

  async cancelTool(request: RemoteToolRunnerCancelRequest): Promise<void> {
    this.cancelRequests.push(request)
    this.active.get(remoteRunnerRequestKey(request))?.abort()
  }
}

export type HttpRemoteToolRunnerOptions = {
  id?: string
  baseUrl: string
  capabilities?: RemoteToolRunnerCapability
  fetch?: typeof fetch
}

export class HttpRemoteToolRunner implements RemoteToolRunner {
  readonly id: string
  readonly capabilities?: RemoteToolRunnerCapability
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(options: HttpRemoteToolRunnerOptions) {
    this.id = options.id ?? 'http-remote-runner'
    this.capabilities = options.capabilities ?? { tools: ['*'] }
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.fetchImpl = options.fetch ?? fetch
  }

  canExecuteTool(tool: AnyTool): boolean {
    const tools = this.capabilities?.tools
    return !tools || tools.includes('*') || tools.includes(tool.name)
  }

  async executeTool(request: RemoteToolRunnerExecuteRequest): Promise<RemoteToolRunnerResult> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/remote-runner/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    return parseRemoteRunnerHttpResult(response)
  }

  async cancelTool(request: RemoteToolRunnerCancelRequest): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/remote-runner/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    if (!response.ok) {
      throw new Error(`Remote runner cancel failed with HTTP ${response.status}.`)
    }
  }
}

export type RemoteToolRunnerServerOptions = {
  id?: string
  tools: Map<string, AnyTool>
  capabilities?: RemoteToolRunnerCapability
}

export async function createRemoteToolRunnerServer(
  options: RemoteToolRunnerServerOptions,
): Promise<FastifyInstance> {
  const app = Fastify()
  const capabilities = options.capabilities ?? { tools: [...options.tools.keys()] }
  const active = new Map<string, AbortController>()

  app.get('/v1/remote-runner/capabilities', async () => ({
    protocolVersion: REMOTE_RUNNER_PROTOCOL_VERSION,
    id: options.id ?? 'remote-tool-runner-server',
    capabilities,
  }))

  app.post('/v1/remote-runner/execute', async (request, reply) => {
    const body = request.body as RemoteToolRunnerExecuteRequest
    if (body.protocolVersion !== REMOTE_RUNNER_PROTOCOL_VERSION) {
      return reply.code(400).send({
        kind: 'error',
        code: 'REMOTE_RUNNER_PROTOCOL_MISMATCH',
        message: `Unsupported remote runner protocol version: ${String(body.protocolVersion)}.`,
      } satisfies RemoteToolRunnerResult)
    }
    const tool = options.tools.get(body.toolName)
    if (!tool || !remoteRunnerToolNameSupported(capabilities, tool.name)) {
      return reply.code(404).send({
        kind: 'error',
        code: 'REMOTE_RUNNER_TOOL_UNSUPPORTED',
        message: `Remote runner does not support tool ${body.toolName}.`,
      } satisfies RemoteToolRunnerResult)
    }
    const parsed = tool.inputSchema.safeParse(body.toolInput)
    if (!parsed.success) {
      return reply.code(400).send({
        kind: 'error',
        code: 'INVALID_TOOL_INPUT',
        message: parsed.error.message,
      } satisfies RemoteToolRunnerResult)
    }

    const controller = new AbortController()
    const key = remoteRunnerRequestKey(body)
    const startedAt = performance.now()
    active.set(key, controller)
    try {
      const result = await tool.execute(parsed.data, {
        cwd: body.cwd,
        sessionId: body.sessionId,
        signal: controller.signal,
        maxOutputBytes: body.maxOutputBytes,
        bashMaxBufferBytes: body.bashMaxBufferBytes,
        executionEnvironment: 'local',
        allowedPaths: body.allowedPaths,
      })
      const resultRecord = result as typeof result & { truncated?: boolean; originalBytes?: number }
      return {
        kind: 'result',
        ...resultRecord,
        metrics: buildRemoteRunnerResultMetrics({
          runnerId: options.id ?? 'remote-tool-runner-server',
          durationMs: performance.now() - startedAt,
          truncated: resultRecord.truncated,
          originalBytes: resultRecord.originalBytes,
          exitCode: extractNumber(result.output, 'exitCode'),
          signal: extractString(result.output, 'signal'),
        }),
      } satisfies RemoteToolRunnerResult
    } catch (error) {
      const code = controller.signal.aborted ? 'REQUEST_CANCELLED' : 'REMOTE_RUNNER_TOOL_ERROR'
      return {
        kind: 'error',
        code,
        message: errorMessage(error),
        details: normalizeRemoteRunnerToolError(error),
        metrics: buildRemoteRunnerResultMetrics({
          runnerId: options.id ?? 'remote-tool-runner-server',
          durationMs: performance.now() - startedAt,
          cancelled: controller.signal.aborted || undefined,
          errorCode: code,
        }),
      } satisfies RemoteToolRunnerResult
    } finally {
      active.delete(key)
    }
  })

  app.post('/v1/remote-runner/cancel', async request => {
    const body = request.body as RemoteToolRunnerCancelRequest
    active.get(remoteRunnerRequestKey(body))?.abort()
    return { ok: true }
  })

  return app
}

export class NoopRemoteToolRunner implements RemoteToolRunner {
  readonly id = 'noop'

  canExecuteTool(): boolean {
    return false
  }

  async executeTool(): Promise<RemoteToolRunnerResult> {
    return remoteRunnerUnavailableResult()
  }
}

export function remoteRunnerUnavailableResult(): RemoteToolRunnerResult {
  return {
    kind: 'error',
    code: 'REMOTE_RUNNER_NOT_CONFIGURED',
    message: "Execution environment 'remote' requires a configured remote runner.",
  }
}

export function remoteRunnerSupportsTool(runner: RemoteToolRunner, tool: AnyTool): boolean {
  if (!runner.canExecuteTool(tool)) return false
  const tools = runner.capabilities?.tools
  return !tools || tools.includes('*') || tools.includes(tool.name)
}

function remoteRunnerRequestKey(request: RemoteToolRunnerCancelRequest): string {
  return `${request.sessionId}:${request.requestId ?? ''}:${request.toolUseId ?? ''}`
}

function remoteRunnerToolNameSupported(capabilities: RemoteToolRunnerCapability, toolName: string): boolean {
  const tools = capabilities.tools
  return !tools || tools.includes('*') || tools.includes(toolName)
}

async function parseRemoteRunnerHttpResult(response: Response): Promise<RemoteToolRunnerResult> {
  const body = await response.json().catch(() => undefined)
  if (isRemoteToolRunnerResult(body)) return body
  return {
    kind: 'error',
    code: 'REMOTE_RUNNER_HTTP_ERROR',
    message: `Remote runner returned HTTP ${response.status}.`,
    details: body,
  }
}

function buildRemoteRunnerResultMetrics(options: RemoteToolRunnerResultMetrics & { runnerId: string }): RemoteToolRunnerResultMetrics {
  return Object.fromEntries(
    Object.entries({
      protocolVersion: REMOTE_RUNNER_PROTOCOL_VERSION,
      ...options,
    }).filter(([, value]) => value !== undefined),
  ) as RemoteToolRunnerResultMetrics
}

function extractNumber(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== 'object') return undefined
  const nested = (value as Record<string, unknown>)[key]
  return typeof nested === 'number' && Number.isFinite(nested) ? nested : undefined
}

function extractString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const nested = (value as Record<string, unknown>)[key]
  return typeof nested === 'string' ? nested : undefined
}

function isRemoteToolRunnerResult(value: unknown): value is RemoteToolRunnerResult {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (record.kind === 'result') {
    return typeof record.success === 'boolean' && 'output' in record
  }
  if (record.kind === 'error') {
    return typeof record.code === 'string' && typeof record.message === 'string'
  }
  return false
}

function normalizeRemoteRunnerToolError(error: unknown): unknown {
  if (!error || typeof error !== 'object') return undefined
  const record = error as Record<string, unknown>
  const details: Record<string, unknown> = {}
  if (record.code !== undefined) details.code = record.code
  if (record.signal !== undefined) details.signal = record.signal
  if (record.exitCode !== undefined) details.exitCode = record.exitCode
  if (typeof record.stdout === 'string') details.stdout = record.stdout
  if (typeof record.stderr === 'string') details.stderr = record.stderr
  return Object.keys(details).length > 0 ? details : undefined
}
