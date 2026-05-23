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
  }
}

export async function assembleContext(options: ContextAssemblerOptions): Promise<AssembledContext> {
  const budget = allocateBudget(options.modelId)
  const projectMemory = await loadProjectMemory(options.runtimeOptions.cwd)
  const selectedEvents = selectRecentEvents(options.events, budget)
  const omittedEvents = selectOmittedEvents(options.events, selectedEvents)
  const sessionSummary = summarizeSessionEvents(omittedEvents, budget.layerBudgets.summary * 4)
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

export function selectRecentEvents(events: NexusEvent[], budget: ContextBudget): NexusEvent[] {
  if (events.length <= budget.recentEventLimit) return [...events]

  const recent = events.slice(-budget.recentEventLimit)
  const firstRecentUserIndex = recent.findIndex(event => event.type === 'user_message')
  if (firstRecentUserIndex <= 0) return recent
  return recent.slice(firstRecentUserIndex)
}

export function selectOmittedEvents(
  events: NexusEvent[],
  selectedEvents: NexusEvent[],
): NexusEvent[] {
  if (events.length === selectedEvents.length) return []
  const selected = new Set(selectedEvents)
  return events.filter(event => !selected.has(event))
}
