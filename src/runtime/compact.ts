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
  persist?: boolean
}

export type CompactSessionResult = {
  event: Extract<NexusEvent, { type: 'compact_boundary' }>
  beforeEventCount: number
  afterEventCount: number
}

export type AutoCompactDecision = {
  enabled: boolean
  shouldCompact: boolean
  thresholdPercent: number
  failureCount: number
  failureLimit: number
  fuseOpen: boolean
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

  if (options.persist !== false) {
    await options.storage.appendEvent(options.sessionId, event)
  }

  return {
    event,
    beforeEventCount: event.beforeEventCount,
    afterEventCount: event.afterEventCount,
  }
}

export function getAutoCompactDecision(options: {
  events: NexusEvent[]
  tokenEstimate: number
  maxTokens: number
  enabled?: boolean
  thresholdPercent?: number
  failureLimit?: number
}): AutoCompactDecision {
  const enabled = options.enabled ?? isAutoCompactEnabled()
  const thresholdPercent = clampPercent(
    options.thresholdPercent ?? readPercentEnv('BABEL_O_AUTO_COMPACT_THRESHOLD_PERCENT', 90),
  )
  const failureLimit = Math.max(
    1,
    readPositiveIntEnv('BABEL_O_AUTO_COMPACT_FAILURE_LIMIT', options.failureLimit ?? 2),
  )
  const failureCount = countConsecutiveAutoCompactFailures(options.events)
  const fuseOpen = failureCount >= failureLimit
  const percentUsed = options.maxTokens > 0
    ? (options.tokenEstimate / options.maxTokens) * 100
    : 0

  return {
    enabled,
    shouldCompact: enabled && !fuseOpen && percentUsed >= thresholdPercent,
    thresholdPercent,
    failureCount,
    failureLimit,
    fuseOpen,
  }
}

export function buildCompactFailureEvent(options: {
  sessionId: string
  trigger: CompactTrigger
  modelId?: string
  failureCount: number
  maxFailures: number
  message: string
}): Extract<NexusEvent, { type: 'compact_failure' }> {
  return {
    type: 'compact_failure',
    ...eventBase(options.sessionId),
    trigger: options.trigger,
    modelId: options.modelId,
    failureCount: options.failureCount,
    maxFailures: options.maxFailures,
    message: options.message,
  }
}

export function countConsecutiveAutoCompactFailures(events: NexusEvent[]): number {
  let count = 0
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!event) continue
    if (event.type === 'compact_boundary' && event.trigger === 'auto') {
      return 0
    }
    if (event.type === 'compact_failure' && event.trigger === 'auto') {
      count += 1
      continue
    }
  }
  return count
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

function isAutoCompactEnabled(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(
    (process.env.BABEL_O_AUTO_COMPACT ?? '').trim().toLowerCase(),
  )
}

function readPercentEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 90
  return Math.max(50, Math.min(99, value))
}
