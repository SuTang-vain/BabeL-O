/**
 * T1 reversible eviction: dedupe and trim tool results from prior turns,
 * while leaving the current turn byte-exact.
 *
 * The current turn starts at the newest `user_message`. Everything at or
 * after that index is pinned; everything before it is eligible for
 * microcompaction (duplicate tool results, oversized tool output) and snip
 * compaction (old tool output slices). This is deliberately reversible:
 * storage still holds the dropped content, and no LLM summary is involved.
 */
import type { NexusEvent } from '../shared/events.js'
import type { ContextBudget } from './contextAssembler.js'
import { microcompactEventsWithMetrics } from './compactors/microCompact.js'
import { snipEventsWithTurnBoundary } from './compactors/snipCompactor.js'

export type ReversibleEvictionResult = {
  events: NexusEvent[]
  compactedEvents: number
  bytesSaved: number
}

export function evictReversibleBeforeCurrentTurn(
  events: NexusEvent[],
  budget: ContextBudget,
): ReversibleEvictionResult {
  let lastUserIndex = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'user_message') {
      lastUserIndex = index
      break
    }
  }
  if (lastUserIndex <= 0) {
    return { events, compactedEvents: 0, bytesSaved: 0 }
  }

  const priorEvents = events.slice(0, lastUserIndex)
  const currentTurn = events.slice(lastUserIndex)
  const microcompacted = microcompactEventsWithMetrics(priorEvents, budget)
  const snipped = snipEventsWithTurnBoundary(
    microcompacted.events,
    budget.snipToolOutputChars,
    budget.snipPriorTurnToolOutputChars,
  )

  return {
    events: [...snipped, ...currentTurn],
    compactedEvents: microcompacted.metrics.compactedEventCount,
    bytesSaved: microcompacted.metrics.bytesSaved,
  }
}
