import type { NexusEvent } from '../../shared/events.js'
import type { ContextBudget } from '../contextAssembler.js'

export type MicrocompactMetrics = {
  compactedEventCount: number
  deduplicatedToolResultCount: number
  bytesBefore: number
  bytesAfter: number
  bytesSaved: number
  estimatedTokensSaved: number
}

export type MicrocompactResult = {
  events: NexusEvent[]
  metrics: MicrocompactMetrics
}

export function microcompactEvents(events: NexusEvent[], budget: ContextBudget): NexusEvent[] {
  return microcompactEventsWithMetrics(events, budget).events
}

export function microcompactEventsWithMetrics(events: NexusEvent[], budget: ContextBudget): MicrocompactResult {
  const latestToolResultByKey = findLatestToolResultByKey(events)
  const metrics: MicrocompactMetrics = {
    compactedEventCount: 0,
    deduplicatedToolResultCount: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    bytesSaved: 0,
    estimatedTokensSaved: 0,
  }

  const compactedEvents = events.map((event, index) => {
    if (event.type !== 'tool_completed') return event

    const output = stringifyOutput(event.output)
    const beforeBytes = Buffer.byteLength(output, 'utf8')
    let replacementOutput: string | undefined
    let deduplicated = false

    const key = toolResultKey(events, index, event)
    if (key && latestToolResultByKey.get(key) !== index) {
      replacementOutput = `[microcompacted duplicate ${event.name} result for ${describeToolInput(events, index)}; kept latest result later in context]`
      deduplicated = true
    } else if (output.length > budget.microcompactToolOutputChars) {
      const headLen = Math.floor(budget.microcompactToolOutputChars * 0.6)
      const tailLen = budget.microcompactToolOutputChars - headLen
      replacementOutput = `${output.slice(0, headLen)}\n\n[microcompacted ${event.name} output (${output.length} chars)]\n\n${output.slice(-tailLen)}`
    }

    if (replacementOutput === undefined) return event

    const afterBytes = Buffer.byteLength(replacementOutput, 'utf8')
    metrics.compactedEventCount += 1
    if (deduplicated) metrics.deduplicatedToolResultCount += 1
    metrics.bytesBefore += beforeBytes
    metrics.bytesAfter += afterBytes

    return {
      ...event,
      output: replacementOutput,
      truncated: true,
      originalBytes: event.originalBytes ?? beforeBytes,
      _originalOutputLength: output.length,
    } as NexusEvent
  })

  metrics.bytesSaved = Math.max(0, metrics.bytesBefore - metrics.bytesAfter)
  metrics.estimatedTokensSaved = Math.ceil(metrics.bytesSaved / 4)

  return {
    events: compactedEvents,
    metrics,
  }
}

function findLatestToolResultByKey(events: NexusEvent[]): Map<string, number> {
  const latest = new Map<string, number>()
  events.forEach((event, index) => {
    if (event.type !== 'tool_completed') return
    const key = toolResultKey(events, index, event)
    if (key) latest.set(key, index)
  })
  return latest
}

function toolResultKey(
  events: NexusEvent[],
  index: number,
  event: Extract<NexusEvent, { type: 'tool_completed' }>,
): string | undefined {
  const started = findToolStarted(events, index, event.toolUseId)
  if (!started) return undefined
  return `${event.name}:${stableStringify(started.input)}`
}

function findToolStarted(
  events: NexusEvent[],
  completedIndex: number,
  toolUseId: string,
): Extract<NexusEvent, { type: 'tool_started' }> | undefined {
  for (let index = completedIndex - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'tool_started' && event.toolUseId === toolUseId) return event
    if (event?.type === 'user_message') return undefined
  }
  return undefined
}

function describeToolInput(events: NexusEvent[], index: number): string {
  const completed = events[index]
  if (completed?.type !== 'tool_completed') return 'same input'
  const started = findToolStarted(events, index, completed.toolUseId)
  if (!started) return 'same input'
  const text = stableStringify(started.input)
  return text.length <= 120 ? text : `${text.slice(0, 117)}...`
}

function stringifyOutput(output: unknown): string {
  return typeof output === 'string' ? output : JSON.stringify(output)
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, nestedValue) => {
      if (!nestedValue || typeof nestedValue !== 'object' || Array.isArray(nestedValue)) {
        return nestedValue
      }
      return Object.fromEntries(
        Object.entries(nestedValue as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right)),
      )
    }) ?? ''
  } catch {
    return String(value)
  }
}
