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
  /**
   * How many events were scanned for this search. Echoed from the caller
   * (which knows the loaded window size) so the model can tell a sparse
   * match from a truncated scan.
   */
  eventsScanned?: number
  /**
   * True when the loaded event window hit a row cap (the caller's
   * `listEvents` returned a `nextCursor`). Distinct from `truncated`
   * (which reflects token capping of the result text). When true, the
   * model should narrow with `eventTypeFilter` or `sinceMs` rather than
   * reword the query — the missing matches may simply not have been loaded.
   */
  eventsCapped?: boolean
}

export type SearchOptions = {
  sinceMs?: number
  maxTokens?: number
  caseSensitive?: boolean
  eventTypeFilter?: NexusEvent['type'][]
  /**
   * Caller-supplied diagnostics echoed into the result. `eventsScanned` is
   * the size of the loaded window; `eventsCapped` is true if that window
   * was row-capped (listEvents returned a nextCursor).
   */
  eventsScanned?: number
  eventsCapped?: boolean
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

// ─── Cross-session search ─────────────────────────────────────────────────

// Lightweight session metadata for cross-session search — mirrors the
// fields models actually need to triage past sessions (id, prompt,
// cwd, lastUserInput, phase, timestamps) without loading event
// streams. Wire from `storage.listSessions()` in the tool wrapper.
export type SessionMetadata = {
  sessionId: string
  cwd?: string
  prompt?: string
  lastUserInput?: string
  phase?: string
  createdAt?: string
  updatedAt?: string
  result?: string
  failureReason?: string
}

export type SessionSearchOptions = {
  query?: string                  // optional content match against prompt/lastUserInput/result
  cwd?: string                    // restrict to a workspace
  sinceMs?: number                // restrict to sessions updated >= sinceMs
  phase?: string | string[]       // restrict to phases (e.g. 'completed', ['executing','waiting'])
  limit?: number                  // max sessions to return (default 20)
  caseSensitive?: boolean
  maxTokens?: number
}

// Search across session metadata (NOT events). Use this when the
// caller needs to find past sessions by topic, cwd, phase, or
// timeframe, then optionally drill into a specific session via
// searchEvents. Returns one line per matching session with id +
// phase + cwd + lastUserInput + timestamp — capped by maxTokens.
export function searchSessionsMetadata(
  sessions: SessionMetadata[],
  options: SessionSearchOptions = {},
): ToolResult {
  const maxTokens = options.maxTokens ?? MAX_TOKENS_PER_TOOL_RETURN
  const limit = options.limit ?? 20
  const caseSensitive = options.caseSensitive ?? false
  const queryRaw = options.query?.trim() ?? ''
  const needle = queryRaw ? (caseSensitive ? queryRaw : queryRaw.toLowerCase()) : null
  const phases = options.phase
    ? (Array.isArray(options.phase) ? new Set(options.phase) : new Set([options.phase]))
    : null
  const sinceMs = options.sinceMs

  const filtered: SessionMetadata[] = []
  for (const session of sessions) {
    if (options.cwd && session.cwd !== options.cwd) continue
    if (phases && session.phase && !phases.has(session.phase)) continue
    if (sinceMs !== undefined) {
      const ts = Date.parse(session.updatedAt ?? session.createdAt ?? '')
      if (!Number.isFinite(ts) || ts < sinceMs) continue
    }
    if (needle) {
      const haystack = caseSensitive
        ? extractSessionText(session)
        : extractSessionText(session).toLowerCase()
      if (!haystack.includes(needle)) continue
    }
    filtered.push(session)
  }

  // Sort newest first
  const sorted = [...filtered].sort((a, b) => {
    const at = Date.parse(a.updatedAt ?? a.createdAt ?? '') || 0
    const bt = Date.parse(b.updatedAt ?? b.createdAt ?? '') || 0
    return bt - at
  })
  const sliced = sorted.slice(0, limit)
  const hitCount = filtered.length

  if (sliced.length === 0) {
    return {
      content: '(no matching sessions)',
      tokenEstimate: estimateTokens('(no matching sessions)'),
      hitCount: 0,
      truncated: false,
    }
  }

  const lines: string[] = [`## Sessions (${sliced.length}/${hitCount})`, '']
  for (const s of sliced) {
    lines.push(formatSessionSnippet(s))
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

function extractSessionText(s: SessionMetadata): string {
  return [
    s.sessionId,
    s.cwd ?? '',
    s.prompt ?? '',
    s.lastUserInput ?? '',
    s.result ?? '',
    s.failureReason ?? '',
    s.phase ?? '',
  ].join(' ')
}

function formatSessionSnippet(s: SessionMetadata): string {
  const last = (s.lastUserInput ?? s.prompt ?? '').replace(/\s+/g, ' ').slice(0, 120)
  const ts = s.updatedAt ?? s.createdAt ?? ''
  const phase = s.phase ?? '?'
  const cwd = s.cwd ?? ''
  return `- [${ts}] ${s.sessionId} phase=${phase} cwd=${cwd}\n  lastInput: "${last}"`
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
//
// Matching is TOKENIZED AND-substring: the query is split on whitespace
// into tokens, and an event matches only when EVERY token appears as a
// substring of its extracted text. This lets a keyword query like
// `架构分析 合理性 先进性` match `分析这个项目架构的合理以及先进性` even
// though no single contiguous run spans the whole phrase. Whole-string
// substring match (the pre-2026-06-21 behavior) returned empty for any
// reworded query, which forced the model into a multi-retry loop — see
// docs/nexus/proposals/context-search-algorithm-robustness-plan.md and
// real session session_06308b17.
//
// CJK reordering (e.g. `架构分析` vs `分析…架构`, same characters in a
// different order) is NOT handled by AND-substring — that needs bigram
// scoring and is deferred to Phase 2 of the plan, gated on a real query
// that Phase 1 cannot satisfy.
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
  // Tokenize on whitespace. Each token is matched as a substring
  // (case-insensitively by default). AND: every token must appear.
  const rawTokens = query.split(/\s+/).filter(Boolean)
  const tokens = caseSensitive ? rawTokens : rawTokens.map((t) => t.toLowerCase())
  const sinceMs = options.sinceMs
  const typeFilter = options.eventTypeFilter ? new Set(options.eventTypeFilter) : null

  // Scan in storage order, collect matches with their index so we can
  // return newest-first without a separate timestamp parse per event.
  const matched: { event: NexusEvent; index: number; snippet: string }[] = []
  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    if (sinceMs !== undefined) {
      const ts = Date.parse((event as { timestamp: string }).timestamp)
      if (!Number.isFinite(ts) || ts < sinceMs) continue
    }
    if (typeFilter && !typeFilter.has(event.type)) continue
    const haystack = caseSensitive ? extractText(event) : extractText(event).toLowerCase()
    if (tokens.every((token) => haystack.includes(token))) {
      matched.push({ event, index: i, snippet: formatEventSnippet(event) })
    }
  }

  const hitCount = matched.length

  // Newest-first: highest storage index first. This matches contextRecent
  // ordering and surfaces the most recent relevant turn at the top.
  matched.sort((a, b) => b.index - a.index)

  // Collapse consecutive same-type hits with identical snippet text so a
  // long assistant_delta run (thousands of chunks) does not crowd out the
  // result. Keep the first (newest) of a run, drop the rest.
  const deduped: string[] = []
  let prevType = ''
  let prevSnippet = ''
  for (const m of matched) {
    if (m.event.type === prevType && m.snippet === prevSnippet) continue
    deduped.push(m.snippet)
    prevType = m.event.type
    prevSnippet = m.snippet
  }

  const joined = deduped.join('\n---\n')
  const capped = capByTokens(joined, maxTokens)
  return {
    content: capped.content,
    tokenEstimate: estimateTokens(capped.content),
    hitCount,
    truncated: capped.truncated,
    truncatedAt: capped.truncatedAt,
    eventsScanned: options.eventsScanned,
    eventsCapped: options.eventsCapped,
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

// Event types that recentEvents filters out by default — internal
// pipeline / noise that pollutes the model-visible recent-flow view.
// Real session session_ea4f1793-ffc1-412a-a3c4-119c386f7ba1 caught
// the gap (Bug 1.3, 2026-06-20): a model that excluded only
// `tool_completed + assistant_delta` still got
//   hook_started / hook_completed / usage / thinking_delta
// prepended to its contextRecent output, with the very first line being
// `[2026-06-20T13:59:51.744Z] hook_started: hook_started InvocationDiagnosticsHook`
// — useless noise that ate into the 5000-token cap and crowded out the
// user-visible events the model actually wanted.
//
// The caller can still pass `excludeEventTypes` to either (a) override
// the default entirely (just supply the full set), or (b) extend it
// (`options.excludeEventTypes` are merged on top of the default).
// We pick (b) here so the model can opt into MORE filtering without
// having to repeat the entire default list.
export const DEFAULT_RECENT_EXCLUDED_EVENT_TYPES: ReadonlySet<NexusEvent['type']> = new Set<NexusEvent['type']>([
  // Internal hook / pipeline telemetry — never user-visible.
  'hook_started',
  'hook_completed',
  // Per-step token / cache accounting — runtime-owned, not for model reasoning.
  'usage',
  // Single-character chunks from extended thinking — high volume, low signal.
  // Models that DO want thinking_delta can list it explicitly to re-include
  // (it then sits at the top of the model's choice, not the default).
  'thinking_delta',
  // Stream chunks not useful for "what just happened" recap; if the model
  // wants the exact text of recent model output it can read the result
  // event directly.
  'assistant_delta',
  // tool_completed bodies (raw outputs) are usually large and noisy;
  // tool_started already gives the model the action signature.
  'tool_completed',
])

// Return the most recent N events, optionally excluding certain types
// (e.g. tool_completed to reduce noise). Each event is rendered as a
// one-line summary.
//
// Default exclusion set (Bug 1.3 fix): see
// `DEFAULT_RECENT_EXCLUDED_EVENT_TYPES` — model only sees
// user-visible turns (user_message, tool_started, error, result,
// scope_boundary_*, etc.) unless it explicitly overrides the list.
export function recentEvents(
  events: NexusEvent[],
  n: number,
  options: RecentOptions = {},
): ToolResult {
  const maxTokens = options.maxTokens ?? MAX_TOKENS_PER_TOOL_RETURN
  // Caller-supplied `excludeEventTypes` MERGE on top of the default so
  // the model can add more filters without having to repeat the whole
  // baseline. To override entirely, pass a list that includes the
  // default types and any additional ones you want kept.
  const exclude = new Set<NexusEvent['type']>(DEFAULT_RECENT_EXCLUDED_EVENT_TYPES)
  if (options.excludeEventTypes) {
    for (const t of options.excludeEventTypes) exclude.add(t)
  }

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
