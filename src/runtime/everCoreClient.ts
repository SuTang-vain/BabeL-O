import type { NexusEvent } from '../shared/events.js'
import type { SessionSnapshot } from '../shared/session.js'

export type EverCoreSearchMethod = 'keyword' | 'vector' | 'hybrid' | 'agentic'

export type EverCoreRole = 'user' | 'assistant' | 'tool'

export type EverCoreMessage = {
  sender_id: string
  sender_name?: string | null
  role: EverCoreRole
  timestamp: number
  content: string
  tool_calls?: EverCoreToolCall[]
  tool_call_id?: string | null
}

export type EverCoreToolCall = {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export type EverCoreAddAgentMessagesInput = {
  sessionId: string
  appId?: string
  projectId?: string
  messages: EverCoreMessage[]
}

export type EverCoreFlushAgentSessionInput = {
  sessionId: string
  appId?: string
  projectId?: string
}

export type EverCoreSearchInput = {
  query: string
  userId?: string
  agentId?: string
  appId?: string
  projectId?: string
  method?: EverCoreSearchMethod
  topK?: number
  radius?: number
  includeProfile?: boolean
  enableLlmRerank?: boolean
  filters?: Record<string, unknown>
}

export type EverCoreEnvelope<TData = unknown> = {
  request_id?: string
  data: TData
}

export type EverCoreClient = {
  search(input: EverCoreSearchInput): Promise<EverCoreEnvelope>
  addAgentMessages(input: EverCoreAddAgentMessagesInput): Promise<EverCoreEnvelope>
  flushAgentSession(input: EverCoreFlushAgentSessionInput): Promise<EverCoreEnvelope>
}

export type EverCoreClientOptions = {
  baseUrl: string
  apiKey?: string
  timeoutMs?: number
  fetch?: typeof fetch
}

export type EverCoreSessionSyncConfig = {
  appId: string
  projectId: string
  userId?: string
  agentId: string
  maxMessages: number
  maxContentChars: number
}

export type EverCoreSessionMessagesInput = EverCoreSessionSyncConfig & {
  session: SessionSnapshot
  events: readonly NexusEvent[]
}

export class HttpEverCoreClient implements EverCoreClient {
  private readonly baseUrl: string
  private readonly apiKey?: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(options: EverCoreClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.apiKey = options.apiKey?.trim() || undefined
    this.timeoutMs = options.timeoutMs ?? 3_000
    this.fetchImpl = options.fetch ?? fetch
  }

  async health(): Promise<void> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}/health`, {
      method: 'GET',
      headers: this.headers(),
    })
    if (!response.ok) {
      throw new Error(`EverCore health returned HTTP ${response.status}.`)
    }
  }

  async search(input: EverCoreSearchInput): Promise<EverCoreEnvelope> {
    const identityCount = (input.userId ? 1 : 0) + (input.agentId ? 1 : 0)
    if (identityCount !== 1) {
      throw new Error('EverCore search requires exactly one of userId or agentId.')
    }

    return this.post('/api/v1/memory/search', {
      user_id: input.userId,
      agent_id: input.agentId,
      app_id: input.appId ?? 'default',
      project_id: input.projectId ?? 'default',
      query: input.query,
      method: input.method ?? 'hybrid',
      top_k: input.topK,
      radius: input.radius,
      include_profile: input.includeProfile ?? false,
      enable_llm_rerank: input.enableLlmRerank ?? false,
      filters: input.filters,
    })
  }

  async addAgentMessages(input: EverCoreAddAgentMessagesInput): Promise<EverCoreEnvelope> {
    return this.post('/api/v1/memory/add', {
      session_id: input.sessionId,
      app_id: input.appId ?? 'default',
      project_id: input.projectId ?? 'default',
      messages: input.messages,
    })
  }

  async flushAgentSession(input: EverCoreFlushAgentSessionInput): Promise<EverCoreEnvelope> {
    return this.post('/api/v1/memory/flush', {
      session_id: input.sessionId,
      app_id: input.appId ?? 'default',
      project_id: input.projectId ?? 'default',
    })
  }

  private async post(path: string, body: unknown): Promise<EverCoreEnvelope> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      throw new Error(`EverCore ${path} returned HTTP ${response.status}.`)
    }
    const payload = await response.json()
    if (!payload || typeof payload !== 'object') {
      throw new Error(`EverCore ${path} response must be an object.`)
    }
    return payload as EverCoreEnvelope
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timeout)
    }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...extra,
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
    }
  }
}

export function buildEverCoreMessagesFromSession(
  input: EverCoreSessionMessagesInput,
): EverCoreMessage[] {
  const messages: EverCoreMessage[] = []
  for (const event of input.events) {
    const message = mapEventToEverCoreMessage(event, input)
    if (message) messages.push(message)
  }
  return messages.slice(-input.maxMessages)
}

function mapEventToEverCoreMessage(
  event: NexusEvent,
  config: EverCoreSessionSyncConfig,
): EverCoreMessage | undefined {
  const raw = event as unknown as Record<string, unknown>
  if (event.type === 'user_message') {
    const content = boundedContent(raw.text, config.maxContentChars)
    if (!content) return undefined
    return {
      sender_id: config.userId ?? 'local-user',
      sender_name: 'User',
      role: 'user',
      timestamp: eventTimestampMs(event.timestamp),
      content,
    }
  }

  if (event.type === 'result') {
    const content = boundedContent(raw.message, config.maxContentChars)
    if (!content) return undefined
    return {
      sender_id: config.agentId,
      sender_name: 'BabeL-O',
      role: 'assistant',
      timestamp: eventTimestampMs(event.timestamp),
      content,
    }
  }

  return undefined
}

function boundedContent(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const content = value.trim()
  if (!content) return undefined
  if (content.length <= maxChars) return content
  return `${content.slice(0, maxChars)}...`
}

function eventTimestampMs(timestamp: string): number {
  const parsed = Date.parse(timestamp)
  return Number.isNaN(parsed) ? Date.now() : parsed
}
