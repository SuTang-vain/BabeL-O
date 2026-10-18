/**
 * Bounded in-process cache for LLM compaction summaries.
 *
 * The key covers the omitted event stream and the summary model, so a repeated
 * identical compaction (same events, same model) reuses the previous summary
 * instead of paying for another provider call. Deterministic digests do not
 * need this cache; they are computed from metadata.
 */
import { createHash } from 'node:crypto'
import type { NexusEvent } from '../shared/events.js'

export type CachedSummary = {
  text: string
  usage: { inputTokens: number; outputTokens: number }
}

const MAX_ENTRIES = 32
const cache = new Map<string, CachedSummary>()

export function buildSummaryCacheKey(events: readonly NexusEvent[], modelId: string): string {
  const hash = createHash('sha256').update(modelId)
  for (const event of events) {
    hash.update(`|${event.type}:${event.timestamp}`)
    if (event.type === 'user_message' || event.type === 'assistant_delta' || event.type === 'thinking_delta') {
      hash.update(`:${event.text.length}`)
    }
  }
  return hash.digest('hex')
}

export function getCachedSummary(key: string): CachedSummary | undefined {
  const value = cache.get(key)
  if (value) {
    cache.delete(key)
    cache.set(key, value)
  }
  return value
}

export function setCachedSummary(key: string, value: CachedSummary): void {
  if (cache.has(key)) cache.delete(key)
  cache.set(key, value)
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

export function clearSummaryCache(): void {
  cache.clear()
}

export function summaryCacheSize(): number {
  return cache.size
}
