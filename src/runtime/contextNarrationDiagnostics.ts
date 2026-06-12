import type { NexusEvent } from '../shared/events.js'

export type ContextPercentGrounding = {
  eventType: 'context_warning' | 'context_blocking'
  timestamp?: string
  percentUsed: number
  tokenEstimate: number
  maxTokens: number
}

export type UngroundedContextPercentDiagnostic = {
  code: 'MODEL_CONTEXT_PERCENT_UNGROUNDED'
  sessionId?: string
  timestamp?: string
  percent: number
  textSnippet: string
  reason: string
  nearestContextEvent?: ContextPercentGrounding
}

const DEFAULT_RECENT_CONTEXT_EVENT_WINDOW = 8
const MAX_SNIPPET_CHARS = 180

const CONTEXT_PERCENT_PATTERNS = [
  /(?:上下文|context)[^\n。.!?]{0,40}?(\d{1,3})\s*%/giu,
  /(\d{1,3})\s*%[^\n。.!?]{0,40}?(?:上下文|context)/giu,
]

export function findUngroundedAssistantContextPercentages(
  events: NexusEvent[],
  options?: { recentContextEventWindow?: number },
): UngroundedContextPercentDiagnostic[] {
  const recentContextEventWindow = Math.max(
    0,
    Math.floor(options?.recentContextEventWindow ?? DEFAULT_RECENT_CONTEXT_EVENT_WINDOW),
  )
  const diagnostics: UngroundedContextPercentDiagnostic[] = []

  for (let index = 0; index < events.length; index++) {
    const event = events[index]
    if (event?.type !== 'assistant_delta') continue

    const matches = extractContextPercentMentions(event.text)
    if (matches.length === 0) continue

    const nearestContextEvent = findNearestContextEvent(events, index, recentContextEventWindow)
    for (const mention of matches) {
      if (nearestContextEvent && nearestContextEvent.percentUsed === mention.percent) continue
      diagnostics.push({
        code: 'MODEL_CONTEXT_PERCENT_UNGROUNDED',
        sessionId: event.sessionId,
        timestamp: event.timestamp,
        percent: mention.percent,
        textSnippet: snippet(event.text, mention.index),
        reason: nearestContextEvent
          ? `Assistant mentioned context ${mention.percent}% but the nearest runtime context event reported ${nearestContextEvent.percentUsed}%.`
          : `Assistant mentioned context ${mention.percent}% without a recent runtime context event.`,
        nearestContextEvent,
      })
    }
  }

  return diagnostics
}

function extractContextPercentMentions(text: string): Array<{ percent: number; index: number }> {
  const mentions: Array<{ percent: number; index: number }> = []
  const seen = new Set<string>()

  for (const pattern of CONTEXT_PERCENT_PATTERNS) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      const raw = match[1]
      if (!raw) continue
      const percent = Number.parseInt(raw, 10)
      if (!Number.isFinite(percent) || percent < 0 || percent > 100) continue
      const index = match.index ?? 0
      const key = `${percent}:${index}`
      if (seen.has(key)) continue
      seen.add(key)
      mentions.push({ percent, index })
    }
  }

  return mentions
}

function findNearestContextEvent(
  events: NexusEvent[],
  assistantIndex: number,
  recentContextEventWindow: number,
): ContextPercentGrounding | undefined {
  const start = Math.max(0, assistantIndex - recentContextEventWindow)
  for (let index = assistantIndex - 1; index >= start; index--) {
    const event = events[index]
    if (!event) continue
    if (event.type === 'context_warning' || event.type === 'context_blocking') {
      return {
        eventType: event.type,
        timestamp: event.timestamp,
        percentUsed: event.percentUsed,
        tokenEstimate: event.tokenEstimate,
        maxTokens: event.maxTokens,
      }
    }
  }
  return undefined
}

function snippet(text: string, index: number): string {
  const start = Math.max(0, index - 60)
  const end = Math.min(text.length, index + MAX_SNIPPET_CHARS - 60)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return `${prefix}${text.slice(start, end)}${suffix}`
}
