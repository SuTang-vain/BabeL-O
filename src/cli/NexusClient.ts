import type { NexusEvent } from '../shared/events.js'
import type { NexusTask, TaskStatus } from '../shared/task.js'
import type {
  EvidenceRef,
  SessionChannel,
  SessionMessage,
  SessionMessagePriority,
  SessionMessageType,
} from '../shared/sessionChannel.js'
import type { AgentJob, AgentJobFilter, AgentSpawnRequest, AgentWaitOptions } from '../nexus/agents/types.js'

export type NexusClientOptions = {
  baseUrl?: string
  apiKey?: string
}

export class NexusClient {
  private readonly baseUrl: string
  private readonly apiKey?: string

  constructor(options: NexusClientOptions = {}) {
    this.baseUrl =
      options.baseUrl ??
      process.env.NEXUS_URL ??
      `http://${process.env.NEXUS_HOST ?? '127.0.0.1'}:${process.env.NEXUS_PORT ?? '3000'}`
    this.apiKey = options.apiKey ?? process.env.NEXUS_API_KEY
  }

  async status(): Promise<unknown> {
    return this.getJson('/v1/runtime/status')
  }

  async memoryStatus(): Promise<unknown> {
    return this.getJson('/v1/runtime/memory/status')
  }

  async memorySearch(body: {
    query: string
    topK?: number
    method?: 'keyword' | 'vector' | 'hybrid' | 'agentic'
    maxChars?: number
    maxHitChars?: number
  }): Promise<unknown> {
    return this.postJson('/v1/runtime/memory/search', body)
  }

  async memoryCandidates(options: { sessionId?: string; limit?: number; includeRejected?: boolean } = {}): Promise<unknown> {
    const params = new URLSearchParams()
    if (options.sessionId) params.set('sessionId', options.sessionId)
    if (options.limit !== undefined) params.set('limit', String(options.limit))
    if (options.includeRejected !== undefined) params.set('includeRejected', String(options.includeRejected))
    const query = params.size > 0 ? `?${params}` : ''
    return this.getJson(`/v1/runtime/memory/candidates${query}`)
  }

  async memorySaveNote(body: {
    note: string
    sessionId?: string
    candidateMessageId?: string
    approved?: boolean
    confirmation?: string
    reason?: string
  }): Promise<unknown> {
    return this.postJson('/v1/runtime/memory/save-note', body)
  }

  async memoryFlush(body: {
    sessionId: string
    approved?: boolean
    confirmation?: string
    reason?: string
  }): Promise<unknown> {
    return this.postJson('/v1/runtime/memory/flush', body)
  }

  async memoryRestart(body: {
    approved?: boolean
    confirmation?: string
    reason?: string
  } = {}): Promise<unknown> {
    return this.postJson('/v1/runtime/memory/restart', body)
  }

  async providerSmoke(options: {
    model?: string
    role?: string
    requireTools?: boolean
    requireStreaming?: boolean
    requireStructuredOutput?: boolean
  } = {}): Promise<unknown> {
    const params = new URLSearchParams()
    if (options.model) params.set('model', options.model)
    if (options.role) params.set('role', options.role)
    if (options.requireTools !== undefined) params.set('requireTools', String(options.requireTools))
    if (options.requireStreaming !== undefined) params.set('requireStreaming', String(options.requireStreaming))
    if (options.requireStructuredOutput !== undefined) params.set('requireStructuredOutput', String(options.requireStructuredOutput))
    const query = params.size > 0 ? `?${params}` : ''
    return this.getJson(`/v1/runtime/provider-smoke${query}`)
  }

  async providerLiveSmoke(options: {
    model?: string
    role?: string
    mode?: 'simple_text' | 'tool_call'
    timeoutMs?: number
  } = {}): Promise<unknown> {
    return this.postJson('/v1/runtime/provider-smoke/live', options)
  }

  async auditTools(): Promise<unknown> {
    return this.getJson('/v1/tools/audit')
  }

  async spawnAgent(body: AgentSpawnRequest): Promise<{ type: 'agent_job_spawned'; job: AgentJob }> {
    return this.postJson('/v1/agents', body) as Promise<{ type: 'agent_job_spawned'; job: AgentJob }>
  }

  async listAgents(filter: AgentJobFilter = {}): Promise<{ type: 'agent_jobs'; jobs: AgentJob[] }> {
    const params = new URLSearchParams()
    if (filter.parentSessionId) params.set('parentSessionId', filter.parentSessionId)
    if (filter.status) params.set('status', filter.status)
    if (filter.agentType) params.set('agentType', filter.agentType)
    const query = params.size > 0 ? `?${params}` : ''
    return this.getJson(`/v1/agents${query}`) as Promise<{ type: 'agent_jobs'; jobs: AgentJob[] }>
  }

  async listSessionAgents(sessionId: string, filter: Omit<AgentJobFilter, 'parentSessionId'> = {}): Promise<{ type: 'agent_jobs'; parentSessionId: string; jobs: AgentJob[] }> {
    const params = new URLSearchParams()
    if (filter.status) params.set('status', filter.status)
    if (filter.agentType) params.set('agentType', filter.agentType)
    const query = params.size > 0 ? `?${params}` : ''
    return this.getJson(`/v1/sessions/${encodeURIComponent(sessionId)}/agents${query}`) as Promise<{
      type: 'agent_jobs'
      parentSessionId: string
      jobs: AgentJob[]
    }>
  }

  async listSessionChannels(options: { sessionId?: string; limit?: number } = {}): Promise<{ type: 'session_channels'; channels: SessionChannel[]; limit: number }> {
    const params = new URLSearchParams()
    if (options.sessionId) params.set('sessionId', options.sessionId)
    if (options.limit !== undefined) params.set('limit', String(options.limit))
    const query = params.size > 0 ? `?${params}` : ''
    return this.getJson(`/v1/session-channels${query}`) as Promise<{
      type: 'session_channels'
      channels: SessionChannel[]
      limit: number
    }>
  }

  async getAgent(jobId: string): Promise<{ type: 'agent_job'; job: AgentJob }> {
    return this.getJson(`/v1/agents/${encodeURIComponent(jobId)}`) as Promise<{ type: 'agent_job'; job: AgentJob }>
  }

  async waitAgent(jobId: string, options: AgentWaitOptions = {}): Promise<{ type: 'agent_job'; job: AgentJob }> {
    return this.postJson(`/v1/agents/${encodeURIComponent(jobId)}/wait`, options) as Promise<{ type: 'agent_job'; job: AgentJob }>
  }

  async cancelAgent(jobId: string, reason?: string): Promise<{ type: 'agent_job_cancelled'; job: AgentJob }> {
    return this.postJson(`/v1/agents/${encodeURIComponent(jobId)}/cancel`, { reason }) as Promise<{
      type: 'agent_job_cancelled'
      job: AgentJob
    }>
  }

  async getAgentTranscript(jobId: string, options: { limit?: number; cursor?: string; order?: 'asc' | 'desc' } = {}): Promise<unknown> {
    const params = new URLSearchParams()
    if (options.limit !== undefined) params.set('limit', String(options.limit))
    if (options.cursor) params.set('cursor', options.cursor)
    if (options.order) params.set('order', options.order)
    const query = params.size > 0 ? `?${params}` : ''
    return this.getJson(`/v1/agents/${encodeURIComponent(jobId)}/transcript${query}`)
  }

  async providerFallbackPlan(options: {
    model?: string
    role?: string
    kind?: 'max_output_tokens' | 'context_window' | 'rate_limit' | 'auth_or_billing' | 'provider_protocol' | 'provider_unavailable' | 'unknown'
  } = {}): Promise<unknown> {
    return this.postJson('/v1/runtime/provider-fallback/plan', options)
  }

  async execute(body: {
    prompt: string
    cwd?: string
    sessionId?: string
  }): Promise<{
    sessionId: string
    success: boolean
    events: NexusEvent[]
  }> {
    return this.postJson('/v1/execute', body) as Promise<{
      sessionId: string
      success: boolean
      events: NexusEvent[]
    }>
  }

  async listSessions(options: { limit?: number } = {}): Promise<unknown> {
    const params = new URLSearchParams()
    if (options.limit !== undefined) params.set('limit', String(options.limit))
    const query = params.size > 0 ? `?${params}` : ''
    return this.getJson(`/v1/sessions${query}`)
  }

  async listTasks(sessionId: string): Promise<{ type: 'tasks_list'; tasks: NexusTask[] }> {
    return this.getJson(`/v1/sessions/${encodeURIComponent(sessionId)}/tasks`) as Promise<{
      type: 'tasks_list'
      tasks: NexusTask[]
    }>
  }

  async createTask(sessionId: string, body: {
    title: string
    description?: string
    metadata?: Record<string, unknown>
    actor?: string
    source?: string
    reason?: string
    requestId?: string
  }): Promise<{ type: 'task_created'; task: NexusTask; idempotent?: boolean }> {
    return this.postJson(`/v1/sessions/${encodeURIComponent(sessionId)}/tasks`, body) as Promise<{
      type: 'task_created'
      task: NexusTask
      idempotent?: boolean
    }>
  }

  async updateTask(sessionId: string, taskId: string, body: {
    title?: string
    description?: string
    status?: TaskStatus
    result?: string
    metadata?: Record<string, unknown>
    actor?: string
    source?: string
    reason?: string
    requestId?: string
    expectedUpdatedAt?: string
  }): Promise<{ type: 'task_updated'; task: NexusTask }> {
    return this.postJsonTaskMutation(sessionId, taskId, undefined, body) as Promise<{
      type: 'task_updated'
      task: NexusTask
    }>
  }

  async mutateTask(sessionId: string, taskId: string, action: 'claim' | 'complete' | 'fail' | 'cancel' | 'retry' | 'approve' | 'reject', body: {
    result?: string
    ownerAgentId?: string
    reviewReason?: string
    actor?: string
    source?: string
    reason?: string
    requestId?: string
    expectedUpdatedAt?: string
  } = {}): Promise<{ type: string; task: NexusTask }> {
    return this.postJsonTaskMutation(sessionId, taskId, action, body) as Promise<{
      type: string
      task: NexusTask
    }>
  }

  async recoverWorktreeTask(sessionId: string, taskId: string, action: 'continue' | 'abandon' | 'keep', body: {
    actor?: string
    source?: string
    reason?: string
    requestId?: string
    expectedUpdatedAt?: string
  } = {}): Promise<{ type: string; action: string; task: NexusTask }> {
    return this.postJsonTaskMutation(sessionId, taskId, 'worktree-recovery', {
      ...body,
      action,
    }) as Promise<{
      type: string
      action: string
      task: NexusTask
    }>
  }

  async rerunSubAgentTask(sessionId: string, taskId: string, body: {
    actor?: string
    source?: string
    reason?: string
    requestId?: string
    expectedUpdatedAt?: string
  } = {}): Promise<{ type: string; task: NexusTask }> {
    return this.postJsonTaskMutation(sessionId, taskId, 'rerun-subagent', body) as Promise<{
      type: string
      task: NexusTask
    }>
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
    return this.getJson(`/v1/sessions/${encodeURIComponent(sessionId)}${query}`)
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
    return this.getJson(
      `/v1/sessions/${encodeURIComponent(sessionId)}/events${query}`,
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
    return this.getJson(
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
    return this.postJson(
      `/v1/session-channels/${encodeURIComponent(channelId)}/messages`,
      body,
    ) as Promise<{
      type: 'session_message_created'
      message: SessionMessage
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
    return this.getJson(`/v1/sessions/${encodeURIComponent(sessionId)}/inbox${query}`) as Promise<{
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
    return this.postJson(`/v1/sessions/${encodeURIComponent(sessionId)}/inbox/${encodeURIComponent(messageId)}/ack`, {}) as Promise<{
      type: 'session_message_acknowledged'
      sessionId: string
      message: SessionMessage | null
    }>
  }

  async listChildSessions(
    sessionId: string,
    options: { limit?: number; eventLimit?: number; failedOnly?: boolean; includeEvents?: boolean } = {},
  ): Promise<unknown> {
    const params = new URLSearchParams()
    if (options.limit !== undefined) params.set('limit', String(options.limit))
    if (options.eventLimit !== undefined) params.set('eventLimit', String(options.eventLimit))
    if (options.failedOnly !== undefined) params.set('failedOnly', String(options.failedOnly))
    if (options.includeEvents !== undefined) params.set('includeEvents', String(options.includeEvents))
    const query = params.size > 0 ? `?${params}` : ''
    return this.getJson(`/v1/sessions/${encodeURIComponent(sessionId)}/children${query}`)
  }

  async listChildSessionEvents(
    sessionId: string,
    childSessionId: string,
    options: { limit?: number; cursor?: string; order?: 'asc' | 'desc' } = {},
  ): Promise<unknown> {
    const params = new URLSearchParams()
    if (options.limit !== undefined) params.set('limit', String(options.limit))
    if (options.cursor) params.set('cursor', options.cursor)
    if (options.order) params.set('order', options.order)
    const query = params.size > 0 ? `?${params}` : ''
    return this.getJson(`/v1/sessions/${encodeURIComponent(sessionId)}/children/${encodeURIComponent(childSessionId)}/events${query}`)
  }

  async compactSession(
    sessionId: string,
    body: { modelId?: string; trigger?: 'manual' | 'auto' | 'reactive' } = {},
  ): Promise<unknown> {
    return this.postJson(`/v1/sessions/${encodeURIComponent(sessionId)}/compact`, body)
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
    return this.getJson(`/v1/sessions/${encodeURIComponent(sessionId)}/context${query}`)
  }

  async resumeSession(sessionId: string, message: string): Promise<unknown> {
    return this.postJson(`/v1/sessions/${encodeURIComponent(sessionId)}/input`, {
      message,
    })
  }

  async cancelSession(sessionId: string): Promise<unknown> {
    return this.postJson(`/v1/sessions/${encodeURIComponent(sessionId)}/cancel`, {})
  }

  async closeSession(
    sessionId: string,
    options: { phase?: 'cancelled' | 'completed' | 'failed'; reason?: string } = {},
  ): Promise<unknown> {
    return this.postJson(`/v1/sessions/${encodeURIComponent(sessionId)}/close`, options)
  }

  async approvePermission(sessionId: string, toolUseId: string): Promise<unknown> {
    return this.postJson(`/v1/sessions/${encodeURIComponent(sessionId)}/approve`, {
      toolUseId,
    })
  }

  async denyPermission(
    sessionId: string,
    toolUseId: string,
    reason?: string,
  ): Promise<unknown> {
    return this.postJson(`/v1/sessions/${encodeURIComponent(sessionId)}/deny`, {
      toolUseId,
      reason,
    })
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {}
    if (this.apiKey) {
      headers['X-Nexus-API-Key'] = this.apiKey
    }
    return headers
  }

  private async getJson(path: string): Promise<unknown> {
    const headers = this.getHeaders()
    const response = await fetch(new URL(path, this.baseUrl), {
      headers,
    })
    if (!response.ok) {
      throw new Error(`GET ${path} failed: ${response.status}`)
    }
    return response.json()
  }

  private async postJsonTaskMutation(sessionId: string, taskId: string, action: string | undefined, body: unknown): Promise<unknown> {
    const encodedSession = encodeURIComponent(sessionId)
    const encodedTask = encodeURIComponent(taskId)
    const suffix = action ? `/${encodeURIComponent(action)}` : ''
    const path = `/v1/sessions/${encodedSession}/tasks/${encodedTask}${suffix}`
    if (!action) return this.patchJson(path, body)
    return this.postJson(path, body)
  }

  private async patchJson(path: string, body: unknown): Promise<unknown> {
    const headers = this.getHeaders()
    headers['content-type'] = 'application/json'
    const response = await fetch(new URL(path, this.baseUrl), {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      throw new Error(`PATCH ${path} failed: ${response.status}`)
    }
    return response.json()
  }

  private async postJson(path: string, body: unknown): Promise<unknown> {
    const headers = this.getHeaders()
    headers['content-type'] = 'application/json'
    const response = await fetch(new URL(path, this.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      throw new Error(`POST ${path} failed: ${response.status}`)
    }
    return response.json()
  }
}
