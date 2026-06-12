import { performance } from 'node:perf_hooks'
import { eventBase, type NexusEvent } from '../shared/events.js'
import type { NexusStorage } from '../storage/Storage.js'
import type { ModelMessage } from '../providers/adapters/ModelAdapter.js'
import {
  allocateBudget,
  buildRetainedSegmentMetadata,
  protectToolPairs,
  selectRecentEvents,
  selectOmittedEvents,
} from './contextAssembler.js'
import { summarizeSessionEvents } from './sessionSummary.js'
import { llmSummarizeEvents } from './compactSummary.js'
import { estimateContextTokens } from './tokenEstimator.js'
import { shouldUpdateSessionMemoryLite, updateSessionMemoryLite } from './sessionMemoryLite.js'

export type CompactTrigger = 'manual' | 'auto' | 'reactive'

export type CompactSessionOptions = {
  storage: NexusStorage
  sessionId: string
  modelId?: string
  trigger?: CompactTrigger
  persist?: boolean
  mapEventsToMessages?: (events: NexusEvent[], initialPrompt: string) => ModelMessage[]
  initialPrompt?: string
}

export type CompactSessionResult = {
  event: Extract<NexusEvent, { type: 'compact_boundary' }>
  contextEvent: Extract<NexusEvent, { type: 'context_compact_boundary' }>
  beforeEventCount: number
  afterEventCount: number
  summaryLatencyMs: number
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
  const previousRetainedEvents = previousBoundary
    ? normalizeRetainedEvents(previousBoundary.event.retainedEvents)
    : []
  const compactableEvents = previousBoundary
    ? [...previousRetainedEvents, ...events.slice(previousBoundary.index + 1)]
    : events
  const selectedEvents = protectToolPairs(
    compactableEvents,
    selectRecentEvents(compactableEvents, budget),
  )
  const omittedEvents = selectOmittedEvents(compactableEvents, selectedEvents)
  const beforeTokenEstimate = estimateEventsAsProviderTokens(compactableEvents, options.initialPrompt ?? '')
  const priorSummary = previousBoundary?.event.summary.trim()
  const mapFn = options.mapEventsToMessages
  const summaryStartMs = performance.now()
  let newSummary: string
  if (mapFn && modelId !== 'local/coding-runtime') {
    newSummary = await llmSummarizeEvents(omittedEvents, modelId, {
      mapEventsToMessages: mapFn,
      initialPrompt: options.initialPrompt,
    })
  } else {
    newSummary = summarizeSessionEvents(
      omittedEvents,
      budget.layerBudgets.summary * 4,
    )
  }
  const summaryLatencyMs = performance.now() - summaryStartMs
  const summary = [priorSummary, newSummary]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join('\n')
    .trim()
  const fallbackSummary = summary || 'Manual compact boundary created; no earlier events required summarization.'
  const afterTokenEstimate = estimateEventsAsProviderTokens(selectedEvents, options.initialPrompt ?? '', fallbackSummary)

  const event: Extract<NexusEvent, { type: 'compact_boundary' }> = {
    type: 'compact_boundary',
    ...eventBase(options.sessionId),
    trigger: options.trigger ?? 'manual',
    summary: fallbackSummary,
    beforeEventCount: events.length,
    afterEventCount: selectedEvents.length + 1,
    summaryChars: fallbackSummary.length,
    snippedToolResults: countLargeToolResults(omittedEvents, budget.snipToolOutputChars),
    preTokens: beforeTokenEstimate,
    postTokens: afterTokenEstimate,
    estimatedTokensSaved: Math.max(0, beforeTokenEstimate - afterTokenEstimate),
    retainedEvents: selectedEvents,
    modelId,
    budget,
  }
  event.retainedSegment = buildRetainedSegmentMetadata(selectedEvents, event)
  const contextEvent = buildContextCompactBoundaryEvent(event)

  if (options.persist !== false) {
    await options.storage.appendEvent(options.sessionId, event)
    await options.storage.appendEvent(options.sessionId, contextEvent)
    const memoryDecision = shouldUpdateSessionMemoryLite(events, { force: true })
    const memoryEvent = await updateSessionMemoryLite({
      sessionId: options.sessionId,
      cwd: inferSessionCwd(events) ?? await inferStoredSessionCwd(options.storage, options.sessionId),
      trigger: event.trigger,
      reason: 'compact',
      decisionReason: memoryDecision.reason,
      estimatedTokensSinceLastUpdate: memoryDecision.estimatedTokensSinceLastUpdate,
      toolCallCount: memoryDecision.toolCallCount,
      summaryMaxChars: budget.layerBudgets.summary * 4,
      summary: fallbackSummary,
      eventCount: omittedEvents.length,
    })
    if (memoryEvent) {
      await options.storage.appendEvent(options.sessionId, memoryEvent)
    }
  }

  return {
    event,
    contextEvent,
    beforeEventCount: event.beforeEventCount,
    afterEventCount: event.afterEventCount,
    summaryLatencyMs,
  }
}

export function buildContextCompactBoundaryEvent(
  boundary: Extract<NexusEvent, { type: 'compact_boundary' }>,
): Extract<NexusEvent, { type: 'context_compact_boundary' }> {
  const retainedSegment = boundary.retainedSegment
  const retainedEventCount = Array.isArray(boundary.retainedEvents)
    ? boundary.retainedEvents.length
    : (retainedSegment?.retainedCount ?? Math.max(0, boundary.afterEventCount - 1))
  const messagesSummarized = Math.max(0, boundary.beforeEventCount - retainedEventCount)
  const droppedItemCount = Math.max(0, boundary.beforeEventCount - retainedEventCount)
  const boundaryId = retainedSegment?.boundaryId ?? `${boundary.sessionId}:${boundary.timestamp}:compact_boundary`
  const summary = boundary.summary.trim()
  const userVisibleSummary = summary ? truncate(summary, 500) : undefined
  const droppedReasons = boundary.snippedToolResults > 0
    ? { large_tool_result: boundary.snippedToolResults }
    : undefined
  return {
    type: 'context_compact_boundary',
    ...eventBase(boundary.sessionId),
    boundaryId,
    sourceBoundaryTimestamp: boundary.timestamp,
    trigger: boundary.trigger,
    beforeEventCount: boundary.beforeEventCount,
    afterEventCount: boundary.afterEventCount,
    ...(boundary.preTokens !== undefined && { preTokens: boundary.preTokens }),
    ...(boundary.postTokens !== undefined && { postTokens: boundary.postTokens }),
    ...(boundary.estimatedTokensSaved !== undefined && { estimatedTokensSaved: boundary.estimatedTokensSaved }),
    summaryChars: boundary.summaryChars,
    snippedToolResults: boundary.snippedToolResults,
    messagesSummarized,
    droppedItemCount,
    retainedEventCount,
    retainedItemCount: retainedEventCount,
    ...(droppedReasons && { droppedReasons }),
    ...(retainedSegment?.firstEventId && { preservedFirstEventId: retainedSegment.firstEventId }),
    ...(retainedSegment?.lastEventId && { preservedTailEventId: retainedSegment.lastEventId }),
    ...(retainedSegment?.hash && { retainedSegmentHash: retainedSegment.hash }),
    ...(boundary.modelId && { modelId: boundary.modelId }),
    ...(userVisibleSummary && { userVisibleSummary }),
    message: `Context compact boundary ${boundary.trigger}: ${boundary.beforeEventCount} -> ${boundary.afterEventCount} events; retained ${retainedEventCount}.`,
  }
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}…`
}

function estimateEventsAsProviderTokens(
  events: NexusEvent[],
  initialPrompt: string,
  summary?: string,
): number {
  const content = [
    summary ? `Compact summary:\n${summary}` : '',
    JSON.stringify(events),
    initialPrompt,
  ].filter(Boolean).join('\n')
  return estimateContextTokens({ messages: [{ role: 'user', content }] }).totalTokens
}

function inferSessionCwd(events: NexusEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'session_started') {
      return event.cwd
    }
  }
  return undefined
}

async function inferStoredSessionCwd(
  storage: NexusStorage,
  sessionId: string,
): Promise<string | undefined> {
  try {
    const session = await storage.getSession(sessionId, { includeEvents: false })
    return session?.cwd
  } catch {
    return undefined
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
    if (event.type === 'compact_boundary') {
      return count
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

function normalizeRetainedEvents(value: unknown): NexusEvent[] {
  if (!Array.isArray(value)) return []
  return value.filter(isNexusEventLike)
}

function isNexusEventLike(value: unknown): value is NexusEvent {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'type' in value &&
    'sessionId' in value &&
    'timestamp' in value,
  )
}

function isAutoCompactEnabled(): boolean {
  const raw = (process.env.BABEL_O_AUTO_COMPACT ?? '').trim().toLowerCase()
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false
  if (raw === '' || raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true
  return true
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
