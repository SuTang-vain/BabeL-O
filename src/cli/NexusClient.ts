import type { NexusEvent } from '../shared/events.js'

export type NexusClientOptions = {
  baseUrl?: string
}

export class NexusClient {
  private readonly baseUrl: string

  constructor(options: NexusClientOptions = {}) {
    this.baseUrl =
      options.baseUrl ??
      process.env.NEXUS_URL ??
      `http://${process.env.NEXUS_HOST ?? '127.0.0.1'}:${process.env.NEXUS_PORT ?? '3000'}`
  }

  async status(): Promise<unknown> {
    return this.getJson('/v1/runtime/status')
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

  async resumeSession(sessionId: string, message: string): Promise<unknown> {
    return this.postJson(`/v1/sessions/${encodeURIComponent(sessionId)}/input`, {
      message,
    })
  }

  async cancelSession(sessionId: string): Promise<unknown> {
    return this.postJson(`/v1/sessions/${encodeURIComponent(sessionId)}/cancel`, {})
  }

  private async getJson(path: string): Promise<unknown> {
    const response = await fetch(new URL(path, this.baseUrl))
    if (!response.ok) {
      throw new Error(`GET ${path} failed: ${response.status}`)
    }
    return response.json()
  }

  private async postJson(path: string, body: unknown): Promise<unknown> {
    const response = await fetch(new URL(path, this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      throw new Error(`POST ${path} failed: ${response.status}`)
    }
    return response.json()
  }
}
