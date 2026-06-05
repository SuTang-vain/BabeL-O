import { createNexusApp } from '../nexus/app.js'
import { createDefaultNexusRuntime } from '../nexus/createRuntime.js'
import {
  assertAgentRemoteExecutionReady,
  assertRemoteRunnerReady,
  configureRemoteRunnerFromEnv,
  parseAgentExecutionEnvironment,
} from '../nexus/remoteRunnerConfig.js'

export type EmbeddedNexusClientOptions = {
  cwd: string
  storagePath?: string
  allowedTools?: string[]
  enableMcp?: boolean
}

type InjectMethod = 'GET' | 'POST'

export function createEmbeddedNexusClient(options: EmbeddedNexusClientOptions): EmbeddedNexusClient {
  return new EmbeddedNexusClient(options)
}

export class EmbeddedNexusClient {
  constructor(private readonly options: EmbeddedNexusClientOptions) {}

  async status(): Promise<unknown> {
    return this.injectJson('GET', '/v1/runtime/status')
  }

  async auditTools(): Promise<unknown> {
    return this.injectJson('GET', '/v1/tools/audit')
  }

  async execute(prompt: string, cwd: string): Promise<unknown> {
    return this.injectJson('POST', '/v1/execute', { prompt, cwd })
  }

  async listSessions(options: { limit?: number } = {}): Promise<unknown> {
    const params = new URLSearchParams()
    if (options.limit !== undefined) params.set('limit', String(options.limit))
    const query = params.size > 0 ? `?${params}` : ''
    return this.injectJson('GET', `/v1/sessions${query}`)
  }

  async listSessionEvents(
    sessionId: string,
    options: { limit?: number; cursor?: string; order?: 'asc' | 'desc' } = {},
  ): Promise<unknown> {
    const params = new URLSearchParams()
    if (options.limit !== undefined) params.set('limit', String(options.limit))
    if (options.cursor) params.set('cursor', options.cursor)
    if (options.order) params.set('order', options.order)
    const query = params.size > 0 ? `?${params}` : ''
    return this.injectJson(
      'GET',
      `/v1/sessions/${encodeURIComponent(sessionId)}/events${query}`,
    )
  }

  async compactSession(
    sessionId: string,
    body: { modelId?: string; trigger?: 'manual' | 'auto' | 'reactive' } = {},
  ): Promise<unknown> {
    return this.injectJson(
      'POST',
      `/v1/sessions/${encodeURIComponent(sessionId)}/compact`,
      body,
    )
  }

  async analyzeContext(
    sessionId: string,
    options: { modelId?: string; prompt?: string; cwd?: string } = {},
  ): Promise<unknown> {
    const params = new URLSearchParams()
    if (options.modelId) params.set('modelId', options.modelId)
    if (options.prompt) params.set('prompt', options.prompt)
    if (options.cwd) params.set('cwd', options.cwd)
    const query = params.size > 0 ? `?${params}` : ''
    return this.injectJson(
      'GET',
      `/v1/sessions/${encodeURIComponent(sessionId)}/context${query}`,
    )
  }

  async closeSession(
    sessionId: string,
    options: { phase?: 'cancelled' | 'completed' | 'failed'; reason?: string } = {},
  ): Promise<unknown> {
    return this.injectJson(
      'POST',
      `/v1/sessions/${encodeURIComponent(sessionId)}/close`,
      options,
    )
  }

  private async injectJson(method: InjectMethod, url: string, payload?: object): Promise<unknown> {
    const agentExecutionEnvironment = parseAgentExecutionEnvironment(process.env.NEXUS_AGENT_EXECUTION_ENVIRONMENT)
    const remoteRunner = await configureRemoteRunnerFromEnv()
    assertRemoteRunnerReady(remoteRunner.status)
    assertAgentRemoteExecutionReady(agentExecutionEnvironment, remoteRunner.status)
    const { runtime, storage } = await createDefaultNexusRuntime({
      storagePath: this.options.storagePath,
      allowedTools: this.options.allowedTools,
      cwd: this.options.cwd,
      enableMcp: this.options.enableMcp,
      remoteRunner: remoteRunner.runner,
      agentExecutionEnvironment,
    })
    const app = await createNexusApp({
      runtime,
      storage,
      defaultCwd: this.options.cwd,
      apiKey: '',
      remoteRunner: remoteRunner.runner,
      remoteRunnerStatus: remoteRunner.status,
      agentExecutionEnvironment,
    })
    try {
      const response = await app.inject(
        payload === undefined ? { method, url } : { method, url, payload },
      )
      if (response.statusCode >= 400) {
        throw new Error(formatInjectError(response.body))
      }
      return response.json()
    } finally {
      await app.close()
      await storage.close?.()
    }
  }
}

export async function executeEmbedded(prompt: string, cwd: string) {
  return createEmbeddedNexusClient({ cwd }).execute(prompt, cwd)
}

function formatInjectError(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown }
    if (typeof parsed.message === 'string') return parsed.message
  } catch {}
  return body
}
