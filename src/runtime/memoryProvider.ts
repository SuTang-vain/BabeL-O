import { performance } from 'node:perf_hooks'
import { errorMessage } from '../shared/errors.js'
import type {
  EverCoreClient,
  EverCoreEnvelope,
  EverCoreSearchInput,
  EverCoreSearchMethod,
} from './everCoreClient.js'

export type MemoryProviderRetrieveInput = {
  sessionId: string
  prompt: string
  cwd: string
  signal?: AbortSignal
}

export type MemoryScope = 'project' | 'user' | 'channel' | 'unknown'

export type MemoryProviderDiagnostics = {
  provider: string
  enabled: boolean
  hitCount: number
  injectedChars: number
  budgetChars: number
  maxHitChars: number
  truncated: boolean
  scope: MemoryScope
  namespaceId?: string
  namespaceSource?: 'explicit' | 'workspace' | 'default'
  isolationKey?: 'projectId' | 'userId' | 'channelId'
  searchLatencyMs?: number
  error?: string
}

export type MemoryProviderResult = {
  content: string
  diagnostics: MemoryProviderDiagnostics
}

export type MemoryProvider = {
  name: string
  retrieve(input: MemoryProviderRetrieveInput): Promise<MemoryProviderResult>
}

export type MemoryProviderHit = {
  content: string
  source?: string
  score?: number
}

export type EverCoreMemoryProviderConfig = {
  appId: string
  projectId: string
  projectIdSource?: 'explicit' | 'workspace' | 'default'
  userId?: string
  agentId: string
  retrieveMethod: EverCoreSearchMethod
  topK: number
  maxContentChars?: number
  maxContextChars?: number
  maxHitChars?: number
}

const DEFAULT_MAX_CONTEXT_CHARS = 4_000
const DEFAULT_MAX_HIT_CHARS = 800

export class NoopMemoryProvider implements MemoryProvider {
  readonly name = 'noop'

  async retrieve(): Promise<MemoryProviderResult> {
    return {
      content: '',
      diagnostics: createMemoryProviderDiagnostics({
        provider: this.name,
        enabled: false,
      }),
    }
  }
}

export class EverCoreMemoryProvider implements MemoryProvider {
  readonly name = 'evercore'

  constructor(
    private readonly client: EverCoreClient,
    private readonly config: EverCoreMemoryProviderConfig,
  ) {}

  async retrieve(input: MemoryProviderRetrieveInput): Promise<MemoryProviderResult> {
    const query = input.prompt.trim()
    if (!query || input.signal?.aborted) {
      return {
        content: '',
        diagnostics: createMemoryProviderDiagnostics({
          provider: this.name,
          enabled: true,
          scope: 'project',
          namespaceId: this.config.projectId,
          namespaceSource: this.config.projectIdSource,
          isolationKey: 'projectId',
        }),
      }
    }

    const budgetChars = this.config.maxContextChars ?? this.config.maxContentChars ?? DEFAULT_MAX_CONTEXT_CHARS
    const maxHitChars = this.config.maxHitChars ?? DEFAULT_MAX_HIT_CHARS
    const started = performance.now()
    try {
      const envelope = await this.client.search(this.buildSearchInput(query))
      const searchLatencyMs = performance.now() - started
      const hits = extractEverCoreMemoryHits(envelope)
      const formatted = formatMemoryProviderHits(hits, {
        maxContextChars: budgetChars,
        maxHitChars,
        maxHits: this.config.topK,
      })
      return {
        content: formatted.content,
        diagnostics: createMemoryProviderDiagnostics({
          provider: this.name,
          enabled: true,
          hitCount: formatted.hitCount,
          injectedChars: formatted.content.length,
          budgetChars,
          maxHitChars,
          truncated: formatted.truncated,
          searchLatencyMs,
          scope: 'project',
          namespaceId: this.config.projectId,
          namespaceSource: this.config.projectIdSource,
          isolationKey: 'projectId',
        }),
      }
    } catch (error) {
      return {
        content: '',
        diagnostics: createMemoryProviderDiagnostics({
          provider: this.name,
          enabled: true,
          budgetChars,
          maxHitChars,
          searchLatencyMs: performance.now() - started,
          error: errorMessage(error),
          scope: 'project',
          namespaceId: this.config.projectId,
          namespaceSource: this.config.projectIdSource,
          isolationKey: 'projectId',
        }),
      }
    }
  }

  private buildSearchInput(query: string): EverCoreSearchInput {
    return {
      query,
      appId: this.config.appId,
      projectId: this.config.projectId,
      method: this.config.retrieveMethod,
      topK: this.config.topK,
      userId: this.config.userId,
      agentId: this.config.userId ? undefined : this.config.agentId,
    }
  }
}

export function createMemoryProviderDiagnostics(input: Partial<MemoryProviderDiagnostics> & {
  provider: string
  enabled: boolean
}): MemoryProviderDiagnostics {
  return {
    provider: input.provider,
    enabled: input.enabled,
    hitCount: input.hitCount ?? 0,
    injectedChars: input.injectedChars ?? 0,
    budgetChars: input.budgetChars ?? 0,
    maxHitChars: input.maxHitChars ?? 0,
    truncated: input.truncated ?? false,
    scope: input.scope ?? 'unknown',
    ...(input.namespaceId && { namespaceId: input.namespaceId }),
    ...(input.namespaceSource && { namespaceSource: input.namespaceSource }),
    ...(input.isolationKey && { isolationKey: input.isolationKey }),
    ...(input.searchLatencyMs !== undefined && { searchLatencyMs: input.searchLatencyMs }),
    ...(input.error && { error: input.error }),
  }
}

export function extractEverCoreMemoryHits(envelope: EverCoreEnvelope): MemoryProviderHit[] {
  return extractCandidateRecords(envelope.data)
    .map(extractMemoryProviderHit)
    .filter((hit): hit is MemoryProviderHit => hit !== undefined)
}

export function formatMemoryProviderHits(
  hits: MemoryProviderHit[],
  options: { maxContextChars: number; maxHitChars: number; maxHits: number },
): { content: string; hitCount: number; truncated: boolean } {
  const maxHits = Math.max(1, options.maxHits)
  const maxHitChars = Math.max(1, options.maxHitChars)
  const maxContextChars = Math.max(1, options.maxContextChars)
  let truncated = hits.length > maxHits
  const lines = hits.slice(0, maxHits).map(hit => {
    const content = truncateText(normalizeWhitespace(hit.content), maxHitChars)
    if (content.truncated) truncated = true
    const details = [
      hit.source ? `source=${normalizeWhitespace(hit.source)}` : '',
      hit.score !== undefined ? `score=${roundScore(hit.score)}` : '',
    ].filter(Boolean).join(', ')
    return `- ${content.text}${details ? ` (${details})` : ''}`
  })
  const joined = lines.join('\n').trim()
  const content = truncateText(joined, maxContextChars)
  return {
    content: content.text,
    hitCount: lines.length,
    truncated: truncated || content.truncated,
  }
}

function extractCandidateRecords(data: unknown): unknown[] {
  if (Array.isArray(data)) return data
  if (!isRecord(data)) return []
  const directKeys = ['results', 'memories', 'items', 'hits', 'chunks']
  for (const key of directKeys) {
    const value = data[key]
    if (Array.isArray(value)) return value
    if (isRecord(value)) {
      const nested = extractCandidateRecords(value)
      if (nested.length > 0) return nested
    }
  }
  const everCoreKeys = ['episodes', 'profiles', 'agent_cases', 'agent_skills', 'unprocessed_messages']
  const typedRecords = everCoreKeys.flatMap(key => Array.isArray(data[key]) ? data[key] : [])
  if (typedRecords.length > 0) return typedRecords
  if (hasTextField(data)) return [data]
  return []
}

function extractMemoryProviderHit(candidate: unknown): MemoryProviderHit | undefined {
  if (typeof candidate === 'string') {
    const content = candidate.trim()
    return content ? { content } : undefined
  }
  if (!isRecord(candidate)) return undefined
  const metadata = isRecord(candidate.metadata) ? candidate.metadata : undefined
  const memory = isRecord(candidate.memory) ? candidate.memory : undefined
  const content = firstString(candidate, [
    'content',
    'text',
    'summary',
    'episode',
    'subject',
    'approach',
    'key_insight',
    'description',
    'memory',
    'value',
  ]) ?? (memory ? firstString(memory, ['content', 'text', 'summary', 'value']) : undefined)
  if (!content?.trim()) return undefined
  const source = firstString(candidate, ['source', 'title', 'id', 'memory_id', 'session_id']) ??
    (metadata ? firstString(metadata, ['source', 'title', 'id', 'memory_id', 'session_id']) : undefined)
  const score = firstNumber(candidate, ['score', 'similarity', 'relevance']) ??
    (metadata ? firstNumber(metadata, ['score', 'similarity', 'relevance']) : undefined)
  return {
    content,
    ...(source && { source }),
    ...(score !== undefined && { score }),
  }
}

function hasTextField(record: Record<string, unknown>): boolean {
  return [
    'content',
    'text',
    'summary',
    'episode',
    'subject',
    'approach',
    'key_insight',
    'description',
    'memory',
    'value',
  ].some(key => typeof record[key] === 'string')
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function truncateText(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) return { text: value, truncated: false }
  return { text: `${value.slice(0, Math.max(0, maxChars - 3))}...`, truncated: true }
}

function roundScore(value: number): string {
  return Math.round(value * 1000) / 1000 + ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
