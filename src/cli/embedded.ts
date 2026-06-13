import { createNexusApp } from '../nexus/app.js'
import { createDefaultNexusRuntime } from '../nexus/createRuntime.js'
import { ConfigManager } from '../shared/config.js'
import type { AgentJob, AgentJobFilter } from '../shared/agentJob.js'
import {
  assertAgentRemoteExecutionReady,
  assertRemoteRunnerReady,
  configureRemoteRunnerFromEnv,
  parseAgentExecutionEnvironment,
} from '../nexus/remoteRunnerConfig.js'
import { defaultEverCoreRuntimeManager } from '../nexus/everCoreRuntimeManager.js'
import type { EvidenceRef, SessionChannel, SessionMessage, SessionMessagePriority, SessionMessageType } from '../shared/sessionChannel.js'

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

  async close(): Promise<void> {
    await defaultEverCoreRuntimeManager.shutdown()
  }

  async status(): Promise<unknown> {
    return this.injectJson('GET', '/v1/runtime/status')
  }

  async memoryStatus(): Promise<unknown> {
    return this.injectJson('GET', '/v1/runtime/memory/status')
  }

  async memorySearch(body: {
    query: string
    topK?: number
    method?: 'keyword' | 'vector' | 'hybrid' | 'agentic'
    maxChars?: number
    maxHitChars?: number
  }): Promise<unknown> {
    return this.injectJson('POST', '/v1/runtime/memory/search', body)
  }

  async memoryCandidates(options: { sessionId?: string; limit?: number; includeRejected?: boolean } = {}): Promise<unknown> {
    const params = new URLSearchParams()
    if (options.sessionId) params.set('sessionId', options.sessionId)
    if (options.limit !== undefined) params.set('limit', String(options.limit))
    if (options.includeRejected !== undefined) params.set('includeRejected', String(options.includeRejected))
    const query = params.size > 0 ? `?${params}` : ''
    return this.injectJson('GET', `/v1/runtime/memory/candidates${query}`)
  }

  async memorySaveNote(body: {
    note: string
    sessionId?: string
    candidateMessageId?: string
    approved?: boolean
    confirmation?: string
    reason?: string
  }): Promise<unknown> {
    return this.injectJson('POST', '/v1/runtime/memory/save-note', body)
  }

  async memoryFlush(body: {
    sessionId: string
    approved?: boolean
    confirmation?: string
    reason?: string
  }): Promise<unknown> {
    return this.injectJson('POST', '/v1/runtime/memory/flush', body)
  }

  async memoryRestart(body: {
    approved?: boolean
    confirmation?: string
    reason?: string
  } = {}): Promise<unknown> {
    return this.injectJson('POST', '/v1/runtime/memory/restart', body)
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

  async getSession(
    sessionId: string,
    options: { recentEventLimit?: number } = {},
  ): Promise<unknown> {
    const params = new URLSearchParams()
    if (options.recentEventLimit !== undefined) {
      params.set('recentEventLimit', String(options.recentEventLimit))
    }
    const query = params.size > 0 ? `?${params}` : ''
    return this.injectJson(
      'GET',
      `/v1/sessions/${encodeURIComponent(sessionId)}${query}`,
    )
  }

  async listSessionMessages(
    channelId: string,
    options: { limit?: number; cursor?: string; order?: 'asc' | 'desc' } = {},
  ): Promise<{ type: 'session_messages'; channelId: string; messages: SessionMessage[]; nextCursor?: string; order: 'asc' | 'desc'; limit: number }> {
    const params = new URLSearchParams()
    if (options.limit !== undefined) params.set('limit', String(options.limit))
    if (options.cursor) params.set('cursor', options.cursor)
    if (options.order) params.set('order', options.order)
    const query = params.size > 0 ? `?${params}` : ''
    return this.injectJson(
      'GET',
      `/v1/session-channels/${encodeURIComponent(channelId)}/messages${query}`,
    ) as Promise<{
      type: 'session_messages'
      channelId: string
      messages: SessionMessage[]
      nextCursor?: string
      order: 'asc' | 'desc'
      limit: number
    }>
  }

  async sendSessionMessage(
    channelId: string,
    body: {
      fromSessionId: string
      toSessionId?: string
      broadcast?: boolean
      type: SessionMessageType
      content: string
      evidence?: EvidenceRef[]
      priority?: SessionMessagePriority
      metadata?: Record<string, unknown>
    },
  ): Promise<{ type: 'session_message_created'; message: SessionMessage }> {
    return this.injectJson(
      'POST',
      `/v1/session-channels/${encodeURIComponent(channelId)}/messages`,
      body,
    ) as Promise<{
      type: 'session_message_created'
      message: SessionMessage
    }>
  }

  async listSessionChannels(options: { sessionId?: string; limit?: number } = {}): Promise<{ type: 'session_channels'; channels: SessionChannel[]; limit: number }> {
    const params = new URLSearchParams()
    if (options.sessionId) params.set('sessionId', options.sessionId)
    if (options.limit !== undefined) params.set('limit', String(options.limit))
    const query = params.size > 0 ? `?${params}` : ''
    return this.injectJson('GET', `/v1/session-channels${query}`) as Promise<{
      type: 'session_channels'
      channels: SessionChannel[]
      limit: number
    }>
  }

  async listSessionInbox(
    sessionId: string,
    options: { limit?: number; includeAcknowledged?: boolean } = {},
  ): Promise<{ type: 'session_inbox'; sessionId: string; messages: SessionMessage[]; limit: number; includeAcknowledged: boolean }> {
    const params = new URLSearchParams()
    if (options.limit !== undefined) params.set('limit', String(options.limit))
    if (options.includeAcknowledged !== undefined) params.set('includeAcknowledged', String(options.includeAcknowledged))
    const query = params.size > 0 ? `?${params}` : ''
    return this.injectJson(
      'GET',
      `/v1/sessions/${encodeURIComponent(sessionId)}/inbox${query}`,
    ) as Promise<{
      type: 'session_inbox'
      sessionId: string
      messages: SessionMessage[]
      limit: number
      includeAcknowledged: boolean
    }>
  }

  async ackSessionMessage(
    sessionId: string,
    messageId: string,
  ): Promise<{ type: 'session_message_acknowledged'; sessionId: string; message: SessionMessage | null }> {
    return this.injectJson(
      'POST',
      `/v1/sessions/${encodeURIComponent(sessionId)}/inbox/${encodeURIComponent(messageId)}/ack`,
      {},
    ) as Promise<{
      type: 'session_message_acknowledged'
      sessionId: string
      message: SessionMessage | null
    }>
  }

  async listAgents(filter: AgentJobFilter = {}): Promise<{ type: 'agent_jobs'; jobs: AgentJob[] }> {
    const params = new URLSearchParams()
    if (filter.parentSessionId) params.set('parentSessionId', filter.parentSessionId)
    if (filter.status) params.set('status', filter.status)
    if (filter.agentType) params.set('agentType', filter.agentType)
    const query = params.size > 0 ? `?${params}` : ''
    return this.injectJson('GET', `/v1/agents${query}`) as Promise<{ type: 'agent_jobs'; jobs: AgentJob[] }>
  }

  async listSessionAgents(sessionId: string, filter: Omit<AgentJobFilter, 'parentSessionId'> = {}): Promise<{
    type: 'agent_jobs'
    parentSessionId: string
    jobs: AgentJob[]
  }> {
    const params = new URLSearchParams()
    if (filter.status) params.set('status', filter.status)
    if (filter.agentType) params.set('agentType', filter.agentType)
    const query = params.size > 0 ? `?${params}` : ''
    return this.injectJson('GET', `/v1/sessions/${encodeURIComponent(sessionId)}/agents${query}`) as Promise<{
      type: 'agent_jobs'
      parentSessionId: string
      jobs: AgentJob[]
    }>
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
    const providerSettings = ConfigManager.getInstance().resolveSettings()
    const everCore = await defaultEverCoreRuntimeManager.acquireFromEnv(process.env, {
      cwd: this.options.cwd,
      providerSettings,
    })
    const { runtime, storage } = await createDefaultNexusRuntime({
      storagePath: this.options.storagePath,
      allowedTools: this.options.allowedTools,
      cwd: this.options.cwd,
      enableMcp: this.options.enableMcp,
      remoteRunner: remoteRunner.runner,
      agentExecutionEnvironment,
      memoryProvider: everCore.memoryProvider,
      everCore: {
        client: everCore.client,
        config: everCore.config,
        dispose: everCore.dispose,
      },
    })
    const app = await createNexusApp({
      runtime,
      storage,
      defaultCwd: this.options.cwd,
      apiKey: '',
      remoteRunner: remoteRunner.runner,
      remoteRunnerStatus: remoteRunner.status,
      everCoreClient: everCore.client,
      everCoreConfig: everCore.config,
      everCoreStatus: everCore.status,
      memoryProvider: everCore.memoryProvider,
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
  const client = createEmbeddedNexusClient({ cwd })
  try {
    return await client.execute(prompt, cwd)
  } finally {
    await client.close()
  }
}

function formatInjectError(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown }
    if (typeof parsed.message === 'string') return parsed.message
  } catch {}
  return body
}
