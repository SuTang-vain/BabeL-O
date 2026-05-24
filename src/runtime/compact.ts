import { eventBase, type NexusEvent } from '../shared/events.js'
import type { NexusStorage } from '../storage/Storage.js'
import { allocateBudget, selectRecentEvents, selectOmittedEvents } from './contextAssembler.js'
import { summarizeSessionEvents } from './sessionSummary.js'

export type CompactTrigger = 'manual' | 'auto' | 'reactive'

export type CompactSessionOptions = {
  storage: NexusStorage
  sessionId: string
  modelId?: string
  trigger?: CompactTrigger
}

export type CompactSessionResult = {
  event: Extract<NexusEvent, { type: 'compact_boundary' }>
  beforeEventCount: number
  afterEventCount: number
}

export async function compactSession(
  options: CompactSessionOptions,
): Promise<CompactSessionResult> {
  const modelId = options.modelId ?? 'local/coding-runtime'
  const budget = allocateBudget(modelId)
  const { events } = await options.storage.listEvents(options.sessionId, {
    limit: 10_000,
    order: 'asc',
  })

  const previousBoundary = findLatestCompactBoundary(events)
  const compactableEvents = previousBoundary
    ? events.slice(previousBoundary.index + 1)
    : events
  const selectedEvents = selectRecentEvents(compactableEvents, budget)
  const omittedEvents = selectOmittedEvents(compactableEvents, selectedEvents)
  const priorSummary = previousBoundary?.event.summary.trim()
  const newSummary = summarizeSessionEvents(
    omittedEvents,
    budget.layerBudgets.summary * 4,
  )
  const summary = [priorSummary, newSummary]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join('\n')
    .trim()
  const fallbackSummary = summary || 'Manual compact boundary created; no earlier events required summarization.'

  const event: Extract<NexusEvent, { type: 'compact_boundary' }> = {
    type: 'compact_boundary',
    ...eventBase(options.sessionId),
    trigger: options.trigger ?? 'manual',
    summary: fallbackSummary,
    beforeEventCount: events.length,
    afterEventCount: selectedEvents.length + 1,
    summaryChars: fallbackSummary.length,
    snippedToolResults: countLargeToolResults(omittedEvents, budget.snipToolOutputChars),
    modelId,
    budget,
  }

  await options.storage.appendEvent(options.sessionId, event)

  return {
    event,
    beforeEventCount: event.beforeEventCount,
    afterEventCount: event.afterEventCount,
  }
}

function findLatestCompactBoundary(events: NexusEvent[]): {
  event: Extract<NexusEvent, { type: 'compact_boundary' }>
  index: number
} | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'compact_boundary') {
      return { event, index }
    }
  }
  return undefined
}

function countLargeToolResults(events: NexusEvent[], thresholdChars: number): number {
  let count = 0
  for (const event of events) {
    if (event.type !== 'tool_completed') continue
    const output = typeof event.output === 'string'
      ? event.output
      : JSON.stringify(event.output)
    if (output.length > thresholdChars) count += 1
  }
  return count
}
