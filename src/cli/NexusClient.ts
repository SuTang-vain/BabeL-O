import type { NexusEvent } from '../shared/events.js'
import type { NexusTask } from '../shared/task.js'

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

  async listSessions(): Promise<unknown> {
    return this.getJson('/v1/sessions')
  }

  async listTasks(sessionId: string): Promise<{ type: 'tasks_list'; tasks: NexusTask[] }> {
    return this.getJson(`/v1/sessions/${encodeURIComponent(sessionId)}/tasks`) as Promise<{
      type: 'tasks_list'
      tasks: NexusTask[]
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
