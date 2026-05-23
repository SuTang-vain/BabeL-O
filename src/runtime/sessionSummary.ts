import type { NexusEvent } from '../shared/events.js'

type SummaryStats = {
  userMessages: number
  assistantChars: number
  thinkingChars: number
  toolsStarted: number
  toolsCompleted: number
  toolsFailed: number
  permissionsRequested: number
  permissionsDenied: number
  taskEvents: number
  resultsSucceeded: number
  resultsFailed: number
}

const DEFAULT_MAX_CHARS = 2_000
const MAX_LIST_ITEMS = 8

export function summarizeSessionEvents(
  events: NexusEvent[],
  maxChars = DEFAULT_MAX_CHARS,
): string {
  if (events.length === 0 || maxChars <= 0) return ''

  const stats: SummaryStats = {
    userMessages: 0,
    assistantChars: 0,
    thinkingChars: 0,
    toolsStarted: 0,
    toolsCompleted: 0,
    toolsFailed: 0,
    permissionsRequested: 0,
    permissionsDenied: 0,
    taskEvents: 0,
    resultsSucceeded: 0,
    resultsFailed: 0,
  }
  const toolCounts = new Map<string, number>()
  const countedToolUseIds = new Set<string>()
  const fileRefs = new Set<string>()
  const earlierRequests: string[] = []
  const notableIssues: string[] = []
  let lastResult = ''

  for (const event of events) {
    switch (event.type) {
      case 'user_message':
        stats.userMessages++
        pushLimited(earlierRequests, quoteSnippet(event.text, 120), 3)
        break
      case 'assistant_delta':
        stats.assistantChars += event.text.length
        break
      case 'thinking_delta':
        stats.thinkingChars += event.text.length
        break
      case 'tool_started':
        stats.toolsStarted++
        countToolOnce(toolCounts, countedToolUseIds, event.toolUseId, event.name)
        collectFileRefs(event.input, fileRefs)
        break
      case 'tool_completed':
        stats.toolsCompleted++
        countToolOnce(toolCounts, countedToolUseIds, event.toolUseId, event.name)
        if (!event.success) {
          stats.toolsFailed++
          pushLimited(notableIssues, `${event.name} failed`, MAX_LIST_ITEMS)
        }
        break
      case 'tool_denied':
        stats.permissionsDenied++
        pushLimited(notableIssues, `${event.name} denied: ${snippet(event.message, 120)}`, MAX_LIST_ITEMS)
        break
      case 'permission_request':
        stats.permissionsRequested++
        collectFileRefs(event.input, fileRefs)
        break
      case 'permission_response':
        if (!event.approved) {
          stats.permissionsDenied++
          pushLimited(notableIssues, `permission denied: ${snippet(event.reason || event.toolUseId, 120)}`, MAX_LIST_ITEMS)
        }
        break
      case 'error':
        pushLimited(notableIssues, `${event.code}: ${snippet(event.message, 120)}`, MAX_LIST_ITEMS)
        break
      case 'result':
        if (event.success) stats.resultsSucceeded++
        else stats.resultsFailed++
        lastResult = `${event.success ? 'success' : 'failed'}: ${snippet(event.message, 160)}`
        break
      case 'task_session_event':
        stats.taskEvents++
        break
      case 'session_started':
      case 'usage':
      case 'task_created':
        break
    }
  }

  const lines = [
    `- Earlier omitted events: ${events.length}; user messages ${stats.userMessages}; assistant text ${stats.assistantChars} chars; thinking ${stats.thinkingChars} chars.`,
  ]

  if (stats.toolsStarted || stats.toolsCompleted) {
    lines.push(`- Earlier tools: started ${stats.toolsStarted}; completed ${stats.toolsCompleted}; failed ${stats.toolsFailed}.`)
  }
  if (toolCounts.size > 0) {
    lines.push(`- Tool usage: ${formatTopCounts(toolCounts)}.`)
  }
  if (fileRefs.size > 0) {
    lines.push(`- Files referenced: ${[...fileRefs].slice(0, MAX_LIST_ITEMS).join(', ')}.`)
  }
  if (earlierRequests.length > 0) {
    lines.push(`- Earlier user requests: ${earlierRequests.join(' | ')}.`)
  }
  if (stats.permissionsRequested || stats.permissionsDenied) {
    lines.push(`- Earlier permissions: requested ${stats.permissionsRequested}; denied ${stats.permissionsDenied}.`)
  }
  if (stats.taskEvents) {
    lines.push(`- Earlier agent events: ${stats.taskEvents}.`)
  }
  if (lastResult) {
    lines.push(`- Last earlier result: ${lastResult}.`)
  }
  if (notableIssues.length > 0) {
    lines.push(`- Notable issues: ${notableIssues.join(' | ')}.`)
  }

  return trimToMaxChars(lines.join('\n'), maxChars)
}

function increment(counts: Map<string, number>, key: string) {
  counts.set(key, (counts.get(key) || 0) + 1)
}

function countToolOnce(
  counts: Map<string, number>,
  seenIds: Set<string>,
  toolUseId: string,
  name: string,
) {
  if (seenIds.has(toolUseId)) return
  seenIds.add(toolUseId)
  increment(counts, name)
}

function pushLimited(values: string[], value: string, maxItems: number) {
  if (!value || values.length >= maxItems) return
  values.push(value)
}

function formatTopCounts(counts: Map<string, number>): string {
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, MAX_LIST_ITEMS)
    .map(([name, count]) => `${name} x${count}`)
    .join(', ')
}

function collectFileRefs(value: unknown, refs: Set<string>) {
  if (refs.size >= MAX_LIST_ITEMS) return
  if (typeof value === 'string') {
    maybeAddFileRef(value, refs)
    return
  }
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) collectFileRefs(item, refs)
    return
  }

  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    if (refs.size >= MAX_LIST_ITEMS) return
    if (isFileRefKey(key)) {
      if (Array.isArray(nestedValue)) {
        for (const item of nestedValue) {
          if (typeof item === 'string') maybeAddFileRef(item, refs)
        }
      } else if (typeof nestedValue === 'string') {
        maybeAddFileRef(nestedValue, refs)
      }
    } else if (nestedValue && typeof nestedValue === 'object') {
      collectFileRefs(nestedValue, refs)
    }
  }
}

function isFileRefKey(key: string): boolean {
  const normalized = key.toLowerCase()
  return [
    'path',
    'filepath',
    'file_path',
    'filename',
    'file',
    'files',
    'paths',
    'target',
  ].includes(normalized)
}

function maybeAddFileRef(value: string, refs: Set<string>) {
  const normalized = value.trim()
  if (!normalized || normalized.length > 240) return
  if (/[\r\n]/.test(normalized)) return
  refs.add(normalized)
}

function quoteSnippet(value: string, maxChars: number): string {
  return `"${snippet(value, maxChars).replace(/"/g, '\\"')}"`
}

function snippet(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`
}

function trimToMaxChars(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  if (maxChars <= 20) return value.slice(0, maxChars)
  return `${value.slice(0, maxChars - 18).trimEnd()}\n[summary truncated]`
}
