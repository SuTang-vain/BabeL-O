// src/tools/contextTools.ts
//
// PR-7: Track A Phase 2 on-demand tools (see
// docs/nexus/reference/long-running-context-assembly.md §7.1).
//
// Three pure functions for model-initiated history queries:
//   - searchEvents:     full-text search over NexusEvent streams
//   - summarizeWindow:  extract human-readable summary from behavior trace
//   - recentEvents:     return last N events
//
// Constraints (per design §7.1 + INV-L12):
//   - Each return ≤ MAX_TOKENS_PER_TOOL_RETURN (5000 tokens)
//   - Pure functions: no storage reads, no file writes, no LLM calls
//   - Token cap is strictly enforced; truncation flagged via `truncated`
//   - Tool results do NOT enter active context (caller-side concern)
//
// This module is the data layer. Wiring into ToolRegistry, REST, and CLI
// is out of scope (separate PRs).

import type { NexusEvent } from '../shared/events.js'
import type { BehaviorTraceEntry } from '../runtime/behaviorTrace.js'

// ─── Constants ────────────────────────────────────────────────────────────

export const MAX_TOKENS_PER_TOOL_RETURN = 5000

// 4 chars per token is a reasonable rough heuristic (matches OpenAI's
// published ratio for English text). Documented as a constant for
// future refinement.
const CHARS_PER_TOKEN = 4

// ─── Types ────────────────────────────────────────────────────────────────

export type ToolResult = {
  content: string
  tokenEstimate: number
  hitCount: number
  truncated: boolean
  truncatedAt?: number
}

export type SearchOptions = {
  sinceMs?: number
  maxTokens?: number
  caseSensitive?: boolean
  eventTypeFilter?: NexusEvent['type'][]
}

export type SummarizeOptions = {
  scope?: 'all' | 'error' | 'denial' | 'scope-drift' | 'user-redirect' | 'trajectory-end' | 'cross-session'
  sinceMs?: number
  maxTokens?: number
  maxEntries?: number
}

export type RecentOptions = {
  excludeEventTypes?: NexusEvent['type'][]
  maxTokens?: number
}

// ─── Token estimation ─────────────────────────────────────────────────────

export function estimateTokens(text: string): number {
  return Math.floor(text.length / CHARS_PER_TOKEN)
}

// ─── Cap helper ───────────────────────────────────────────────────────────

function capByTokens(content: string, maxTokens: number): { content: string; truncated: boolean; truncatedAt?: number } {
  const maxChars = maxTokens * CHARS_PER_TOKEN
  if (content.length <= maxChars) {
    return { content, truncated: false }
  }
  // Truncate at the last newline before maxChars to keep readability.
  const cutAt = content.lastIndexOf('\n', maxChars)
  const finalCut = cutAt > 0 ? cutAt : maxChars
  return {
    content: content.slice(0, finalCut) + '\n[...truncated]',
    truncated: true,
    truncatedAt: finalCut,
  }
}

// ─── Tool 1: context.search ───────────────────────────────────────────────

// Full-text search over an event stream. Case-insensitive by default.
// Searches across all text fields of each event (user_message.text,
// error.message, tool input strings, etc.).
export function searchEvents(
  events: NexusEvent[],
  query: string,
  options: SearchOptions = {},
): ToolResult {
  const maxTokens = options.maxTokens ?? MAX_TOKENS_PER_TOOL_RETURN
  if (!query || query.trim().length === 0) {
    return { content: '', tokenEstimate: 0, hitCount: 0, truncated: false }
  }
  const caseSensitive = options.caseSensitive ?? false
  const needle = caseSensitive ? query : query.toLowerCase()
  const sinceMs = options.sinceMs
  const typeFilter = options.eventTypeFilter ? new Set(options.eventTypeFilter) : null

  const hits: string[] = []
  let hitCount = 0
  for (const event of events) {
    if (sinceMs !== undefined) {
      const ts = Date.parse((event as { timestamp: string }).timestamp)
      if (!Number.isFinite(ts) || ts < sinceMs) continue
    }
    if (typeFilter && !typeFilter.has(event.type)) continue
    const haystack = caseSensitive ? extractText(event) : extractText(event).toLowerCase()
    if (haystack.includes(needle)) {
      hitCount += 1
      hits.push(formatEventSnippet(event))
    }
  }

  const joined = hits.join('\n---\n')
  const capped = capByTokens(joined, maxTokens)
  return {
    content: capped.content,
    tokenEstimate: estimateTokens(capped.content),
    hitCount,
    truncated: capped.truncated,
    truncatedAt: capped.truncatedAt,
  }
}

// ─── Tool 2: context.summarize ────────────────────────────────────────────

// Summarize behavior trace entries by trigger type. Returns human-readable
// lines that can be presented to the model as tool result. Optional scope
// narrows to one trigger type. Optional sinceMs filters by timestamp.
export function summarizeWindow(
  entries: BehaviorTraceEntry[],
  options: SummarizeOptions = {},
): ToolResult {
  const maxTokens = options.maxTokens ?? MAX_TOKENS_PER_TOOL_RETURN
  const maxEntries = options.maxEntries ?? 50
  const scope = options.scope ?? 'all'
  const sinceMs = options.sinceMs

  // Filter
  const filtered = entries.filter(entry => {
    if (sinceMs !== undefined) {
      const ts = Date.parse(entry.timestamp)
      if (!Number.isFinite(ts) || ts < sinceMs) return false
    }
    if (scope === 'all') return true
    if (scope === 'cross-session') {
      return entry.anomaly && (entry.anomaly as { source?: string }).source === 'nexus'
    }
    if (scope === 'error' || scope === 'denial' || scope === 'scope-drift' ||
        scope === 'user-redirect' || scope === 'trajectory-end') {
      return entry.trigger === scope
    }
    return true
  })

  // Sort newest first, cap
  const sorted = [...filtered].sort((a, b) => {
    const at = Date.parse(a.timestamp) || 0
    const bt = Date.parse(b.timestamp) || 0
    return bt - at
  })
  const sliced = sorted.slice(0, maxEntries)
  const hitCount = filtered.length

  if (sliced.length === 0) {
    return {
      content: '(no matching trace entries)',
      tokenEstimate: estimateTokens('(no matching trace entries)'),
      hitCount: 0,
      truncated: false,
    }
  }

  // Format
  const lines: string[] = [`## Summary (${sliced.length}/${hitCount} entries, scope=${scope})`, '']
  for (const entry of sliced) {
    lines.push(formatTraceLine(entry))
  }
  const joined = lines.join('\n')
  const capped = capByTokens(joined, maxTokens)
  return {
    content: capped.content,
    tokenEstimate: estimateTokens(capped.content),
    hitCount,
    truncated: capped.truncated,
    truncatedAt: capped.truncatedAt,
  }
}

// ─── Tool 3: context.recent ───────────────────────────────────────────────

// Return the most recent N events, optionally excluding certain types
// (e.g. tool_completed to reduce noise). Each event is rendered as a
// one-line summary.
export function recentEvents(
  events: NexusEvent[],
  n: number,
  options: RecentOptions = {},
): ToolResult {
  const maxTokens = options.maxTokens ?? MAX_TOKENS_PER_TOOL_RETURN
  const exclude = options.excludeEventTypes ? new Set(options.excludeEventTypes) : null

  // Sort newest first
  const sorted = [...events].sort((a, b) => {
    const at = Date.parse((a as { timestamp: string }).timestamp) || 0
    const bt = Date.parse((b as { timestamp: string }).timestamp) || 0
    return bt - at
  })

  const sliced: NexusEvent[] = []
  for (const event of sorted) {
    if (sliced.length >= n) break
    if (exclude && exclude.has(event.type)) continue
    sliced.push(event)
  }
  const hitCount = sliced.length

  if (sliced.length === 0) {
    return {
      content: '(no events)',
      tokenEstimate: estimateTokens('(no events)'),
      hitCount: 0,
      truncated: false,
    }
  }
  const lines = sliced.map(formatEventSnippet)
  const joined = lines.join('\n')
  const capped = capByTokens(joined, maxTokens)
  return {
    content: capped.content,
    tokenEstimate: estimateTokens(capped.content),
    hitCount,
    truncated: capped.truncated,
    truncatedAt: capped.truncatedAt,
  }
}

// ─── Internals ────────────────────────────────────────────────────────────

function extractText(event: NexusEvent): string {
  const parts: string[] = []
  parts.push(event.type)
  for (const [key, value] of Object.entries(event as Record<string, unknown>)) {
    if (key === 'type' || key === 'schemaVersion' || key === 'sessionId' || key === 'timestamp' || key === 'requestId' || key === 'cwd') continue
    if (typeof value === 'string') {
      parts.push(value)
    } else if (value && typeof value === 'object') {
      // Shallow stringify for tool input etc.
      try {
        parts.push(JSON.stringify(value))
      } catch {
        // ignore
      }
    }
  }
  return parts.join(' ')
}

function formatEventSnippet(event: NexusEvent): string {
  const ts = (event as { timestamp?: string }).timestamp ?? ''
  const type = event.type
  const text = extractText(event)
  // Cap each line at 200 chars for readability
  const short = text.length > 200 ? text.slice(0, 197) + '...' : text
  return `[${ts}] ${type}: ${short}`
}

function formatTraceLine(entry: BehaviorTraceEntry): string {
  const ts = entry.timestamp
  const trigger = entry.trigger
  const conf = entry.triggerConfidence
  const message = entry.anomaly?.errorMessage
    || entry.anomaly?.errorCode
    || entry.anomaly?.denialReason
    || entry.anomaly?.driftPath
    || entry.anomaly?.userRedirectSignal
    || '(no detail)'
  const source = (entry.anomaly as { source?: string } | undefined)?.source
  const sourceTag = source ? ` [${source}]` : ''
  const confStr = conf > 0 ? ` (conf=${conf})` : ''
  return `- [${ts}] ${trigger}${confStr}${sourceTag}: ${message}`
}
