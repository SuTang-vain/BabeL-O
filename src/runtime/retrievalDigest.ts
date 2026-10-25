/**
 * Retrieval-first compaction pointers (P3 prototype).
 *
 * Instead of rewriting history into prose, the boundary keeps a small index of
 * event pointers (user turns, file reads/writes, failures). The model can then
 * call the existing `contextSearch` / `contextRecent` tools to fetch the exact
 * slice it needs. This trades summary tokens for on-demand tool calls.
 */
import type { NexusEvent } from '../shared/events.js'

export type RetrievalEntryKind = 'user' | 'file' | 'failure'

export type RetrievalEntry = {
  id: string
  kind: RetrievalEntryKind
  subject: string
  snippet: string
  turn: number
  timestamp: string
}

export type RetrievalIndex = {
  entries: RetrievalEntry[]
}

export type RetrievalOptions = {
  maxEntries?: number
  maxSnippetChars?: number
}

export function isRetrievalCompactionEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = (env.BABEL_O_COMPACT_RETRIEVAL ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

function truncate(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= maxChars
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxChars - 1))}…`
}

export function buildRetrievalIndex(
  events: readonly NexusEvent[],
  options: RetrievalOptions = {},
): RetrievalIndex {
  const maxEntries = options.maxEntries ?? 32
  const maxSnippetChars = options.maxSnippetChars ?? 160
  const pathByToolUseId = new Map<string, string>()
  const entries: RetrievalEntry[] = []
  let turn = 0

  for (const event of events) {
    if (event.type === 'user_message') {
      turn += 1
      entries.push({
        id: `user:${turn}`,
        kind: 'user',
        subject: `user:${turn}`,
        snippet: truncate(event.text, maxSnippetChars),
        turn,
        timestamp: event.timestamp,
      })
      continue
    }
    if (event.type === 'tool_started') {
      const path = (event.input as { path?: unknown } | undefined)?.path
      if (typeof path === 'string' && path.length > 0) {
        pathByToolUseId.set(event.toolUseId, path)
      }
      continue
    }
    if (event.type !== 'tool_completed') continue
    if (!event.success) {
      const output = typeof event.output === 'string' ? event.output : JSON.stringify(event.output)
      entries.push({
        id: `failure:${event.toolUseId}`,
        kind: 'failure',
        subject: `tool:${event.name}`,
        snippet: truncate(output, maxSnippetChars),
        turn,
        timestamp: event.timestamp,
      })
      continue
    }
    const path = pathByToolUseId.get(event.toolUseId)
    if (!path || (event.name !== 'Read' && event.name !== 'Write' && event.name !== 'Edit')) continue
    const output = typeof event.output === 'string' ? event.output : JSON.stringify(event.output)
    entries.push({
      id: `file:${event.toolUseId}`,
      kind: 'file',
      subject: `file:${path}`,
      snippet: event.name === 'Read' ? `read ${output.length} chars` : event.name.toLowerCase(),
      turn,
      timestamp: event.timestamp,
    })
  }

  const kept = entries.slice(-Math.max(1, maxEntries))
  return { entries: kept }
}

export function searchRetrievalIndex(
  index: RetrievalIndex,
  query: string,
  limit = 5,
): RetrievalEntry[] {
  const keywords = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (keywords.length === 0) return []
  return index.entries
    .filter(entry => {
      const haystack = `${entry.subject} ${entry.snippet}`.toLowerCase()
      return keywords.every(keyword => haystack.includes(keyword))
    })
    .slice(-Math.max(1, limit))
    .reverse()
}

export function renderRetrievalPointers(index: RetrievalIndex, maxChars = 6_000): string {
  const lines = [
    '## Retrieval Index (pointers only)',
    'History was compacted into pointers. Use contextSearch/contextRecent to fetch exact evidence; do not assume the pointer text is complete.',
  ]
  let used = lines.join('\n').length + 1
  for (const entry of index.entries) {
    const sinceMs = Date.parse(entry.timestamp)
    const hint = Number.isFinite(sinceMs) ? ` sinceMs=${sinceMs}` : ''
    const line = `- [${entry.kind}] ${entry.subject}: ${entry.snippet}${hint}`
    if (used + line.length + 1 > maxChars) {
      lines.push('- … (retrieval index truncated)')
      break
    }
    lines.push(line)
    used += line.length + 1
  }
  return lines.join('\n')
}
