import type { NexusEvent } from '../shared/events.js'
import type { RuntimeExecuteOptions } from './Runtime.js'
import type { ModelMessage } from '../providers/adapters/ModelAdapter.js'
import { getModel } from '../providers/registry.js'
import { snipEvents } from './compactors/snipCompactor.js'
import { loadProjectMemory } from './memory.js'
import { summarizeSessionEvents } from './sessionSummary.js'
import { loadAllSkills } from '../skills/loader.js'
import { matchSkills } from '../skills/matcher.js'

export type ContextBudget = {
  maxTokens: number
  maxChars: number
  layerBudgets: {
    system: number
    memory: number
    summary: number
    recent: number
  }
  snipToolOutputChars: number
  recentEventLimit: number
  recentTurnLimit: number
}

export type ContextAssemblerOptions = {
  runtimeOptions: RuntimeExecuteOptions
  events: NexusEvent[]
  modelId: string
  buildSystemPrompt: (
    options: RuntimeExecuteOptions,
    projectMemory?: string,
    sessionSummary?: string,
    activeSkills?: string,
  ) => string
  mapEventsToMessages: (events: NexusEvent[], initialPrompt: string) => ModelMessage[]
}

export type AssembledContext = {
  systemPrompt: string
  messages: ModelMessage[]
  budget: ContextBudget
  selectedEventCount: number
  omittedEventCount: number
  snippedEventCount: number
  sessionSummary: string
  activeSkills: string
}

export function allocateBudget(modelId: string): ContextBudget {
  let contextWindow = 8192
  try {
    contextWindow = getModel(modelId).contextWindow
  } catch {
    contextWindow = 8192
  }

  const maxTokens = Math.min(Math.floor(contextWindow * 0.8), 120_000)
  const maxChars = maxTokens * 4
  const fixedBudget = 4_500

  return {
    maxTokens,
    maxChars,
    layerBudgets: {
      system: 500,
      memory: 2_000,
      summary: 2_000,
      recent: Math.max(1_000, maxTokens - fixedBudget),
    },
    snipToolOutputChars: Math.max(2_000, Math.min(20_000, Math.floor(maxChars * 0.08))),
    recentEventLimit: Math.max(20, Math.min(300, Math.floor(maxTokens / 400))),
    recentTurnLimit: contextWindow >= 100_000 ? 4 : 2,
  }
}

export async function assembleContext(options: ContextAssemblerOptions): Promise<AssembledContext> {
  const budget = allocateBudget(options.modelId)
  const projectMemory = await loadProjectMemory(options.runtimeOptions.cwd)
  const compactBoundary = findLatestCompactBoundary(options.events)
  const compactAwareEvents = compactBoundary
    ? options.events.slice(compactBoundary.index + 1)
    : options.events
  const selectedEvents = selectRecentEvents(compactAwareEvents, budget)
  const omittedEvents = selectOmittedEvents(compactAwareEvents, selectedEvents)
  const compactSummary = compactBoundary?.event.summary.trim() ?? ''
  const sessionSummary = [
    compactSummary,
    summarizeSessionEvents(omittedEvents, budget.layerBudgets.summary * 4),
  ]
    .filter(part => part.trim().length > 0)
    .join('\n')
    .trim()
  const snippedEvents = snipEvents(selectedEvents, budget.snipToolOutputChars)
  const messages = options.mapEventsToMessages(
    snippedEvents,
    options.runtimeOptions.prompt,
  )

  const allSkills = await loadAllSkills(options.runtimeOptions.cwd)
  const matched = matchSkills(allSkills, options.runtimeOptions.prompt)
  let activeSkills = ''
  if (matched.length > 0) {
    activeSkills = `Active Developer Skills:\n` + matched.map(skill => {
      return `## Skill: ${skill.name} (id: ${skill.id})\n${skill.content}`
    }).join('\n\n')
  }

  return {
    systemPrompt: options.buildSystemPrompt(options.runtimeOptions, projectMemory, sessionSummary, activeSkills),
    messages,
    budget,
    selectedEventCount: selectedEvents.length,
    omittedEventCount: omittedEvents.length,
    snippedEventCount: snippedEvents.filter((event, index) => event !== selectedEvents[index]).length,
    sessionSummary,
    activeSkills,
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

export function selectRecentEvents(events: NexusEvent[], budget: ContextBudget): NexusEvent[] {
  const recoveryEvents = selectRecoveryBoundaryEvents(events)
  if (recoveryEvents.length > 0) {
    if (recoveryEvents.length <= budget.recentEventLimit) return recoveryEvents
    return trimEventsToRecentUserBoundary(recoveryEvents, budget.recentEventLimit)
  }

  if (events.length <= budget.recentEventLimit) return [...events]

  const selectedByTurn = selectRecentTurnEvents(events, budget.recentTurnLimit)
  if (selectedByTurn.length > 0) {
    return trimEventsToRecentUserBoundary(selectedByTurn, budget.recentEventLimit)
  }

  return trimEventsToRecentUserBoundary(events, budget.recentEventLimit)
}

function selectRecoveryBoundaryEvents(events: NexusEvent[]): NexusEvent[] {
  let lastTerminalIndex = -1
  for (let index = 0; index < events.length; index += 1) {
    if (isConversationBoundaryEvent(events[index]!)) {
      lastTerminalIndex = index
    }
  }
  if (lastTerminalIndex === -1) return []

  const nextUserIndex = events.findIndex((event, index) =>
    index > lastTerminalIndex && event.type === 'user_message'
  )
  if (nextUserIndex === -1) return []

  return events.slice(nextUserIndex)
}

function isConversationBoundaryEvent(event: NexusEvent): boolean {
  if (event.type === 'error') {
    return [
      'REQUEST_TIMEOUT',
      'REQUEST_CANCELLED',
      'MAX_LOOPS_EXCEEDED',
      'PROVIDER_ERROR',
      'EMPTY_PROVIDER_RESPONSE',
    ].includes(event.code)
  }
  if (event.type !== 'result') return false
  return event.success === false
}

function trimEventsToRecentUserBoundary(events: NexusEvent[], limit: number): NexusEvent[] {
  if (events.length <= limit) return [...events]
  const lastUserIndex = findLastUserMessageIndex(events)
  if (lastUserIndex === -1) return events.slice(-limit)

  const candidate = events.slice(lastUserIndex)
  if (candidate.length <= limit) return candidate

  const tail = candidate.slice(-(limit - 1))
  return [events[lastUserIndex]!, ...tail]
}

function selectRecentTurnEvents(events: NexusEvent[], maxUserTurns: number): NexusEvent[] {
  let userTurnsSeen = 0
  let startIndex = -1

  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type !== 'user_message') continue
    userTurnsSeen += 1
    startIndex = index
    if (userTurnsSeen >= maxUserTurns) break
  }

  if (startIndex === -1) return []
  return events.slice(startIndex)
}

function findLastUserMessageIndex(events: NexusEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === 'user_message') return index
  }
  return -1
}

export function selectOmittedEvents(
  events: NexusEvent[],
  selectedEvents: NexusEvent[],
): NexusEvent[] {
  if (events.length === selectedEvents.length) return []
  const selected = new Set(selectedEvents)
  return events.filter(event => !selected.has(event))
}
