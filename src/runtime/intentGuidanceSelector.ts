import type { ModelAdapter } from '../providers/adapters/ModelAdapter.js'
import type { NexusEvent } from '../shared/events.js'
import type { SessionAuthorizationState } from '../shared/session.js'
import type { UserIntakeGuidanceEvent, UserIntentGuidance } from './intentGuidance.js'
import {
  buildUserIntakeGuidanceEvent as buildDefaultUserIntakeGuidanceEvent,
  deriveUserIntentGuidance as deriveDefaultUserIntentGuidance,
  formatUserIntentGuidance as formatDefaultUserIntentGuidance,
  getIntentCategory as getDefaultIntentCategory,
  getToolSuppressionReason as getDefaultToolSuppressionReason,
  shouldSuppressToolsForIntent as shouldSuppressDefaultToolsForIntent,
} from './intentGuidance.js'
import {
  deriveUserIntentGuidance as deriveSimplifiedUserIntentGuidance,
  deriveUserIntentGuidanceSync as deriveSimplifiedUserIntentGuidanceSync,
  formatUserIntentGuidance as formatSimplifiedUserIntentGuidance,
  getIntentCategory as getSimplifiedIntentCategory,
  getToolSuppressionReason as getSimplifiedToolSuppressionReason,
  shouldSuppressToolsForIntent as shouldSuppressSimplifiedToolsForIntent,
  toUserIntakeGuidanceEvent as toSimplifiedUserIntakeGuidanceEvent,
} from './intentGuidanceSimplified.js'

export type IntentGuidanceMode = 'default' | 'simplified'

export function getIntentGuidanceMode(env: NodeJS.ProcessEnv = process.env): IntentGuidanceMode {
  return env.BABEL_O_INTENT_GUIDANCE === 'default' ? 'default' : 'simplified'
}

export function deriveSelectedUserIntentGuidance(options: {
  events: NexusEvent[]
  latestPrompt: string
  cwd: string
}): UserIntentGuidance {
  if (getIntentGuidanceMode() === 'simplified') {
    return deriveSimplifiedUserIntentGuidanceSync(options) as UserIntentGuidance
  }
  return deriveDefaultUserIntentGuidance(options)
}

export async function buildSelectedUserIntakeGuidanceEvent(options: {
  adapter: ModelAdapter
  modelId: string
  apiKey?: string
  baseUrl?: string
  sessionId: string
  events: NexusEvent[]
  latestPrompt: string
  cwd: string
  signal?: AbortSignal
  previousAuthorizationState?: SessionAuthorizationState
}): Promise<UserIntakeGuidanceEvent> {
  if (getIntentGuidanceMode() === 'simplified') {
    const guidance = await deriveSimplifiedUserIntentGuidance({
      latestPrompt: options.latestPrompt,
      cwd: options.cwd,
      events: options.events,
      previousAuthorizationState: options.previousAuthorizationState,
    })
    return toSimplifiedUserIntakeGuidanceEvent({
      guidance,
      sessionId: options.sessionId,
    }) as UserIntakeGuidanceEvent
  }
  return buildDefaultUserIntakeGuidanceEvent(options)
}

export function formatSelectedUserIntentGuidance(guidance: UserIntentGuidance): string {
  return getIntentGuidanceMode() === 'simplified'
    ? formatSimplifiedUserIntentGuidance(guidance)
    : formatDefaultUserIntentGuidance(guidance)
}

export function shouldSuppressSelectedToolsForIntent(guidance: UserIntentGuidance): boolean {
  return getIntentGuidanceMode() === 'simplified'
    ? shouldSuppressSimplifiedToolsForIntent(guidance)
    : shouldSuppressDefaultToolsForIntent(guidance)
}

export function getSelectedIntentCategory(guidance: UserIntentGuidance): string {
  return getIntentGuidanceMode() === 'simplified'
    ? getSimplifiedIntentCategory(guidance)
    : getDefaultIntentCategory(guidance)
}

export function getSelectedToolSuppressionReason(guidance: UserIntentGuidance): string | undefined {
  return getIntentGuidanceMode() === 'simplified'
    ? getSimplifiedToolSuppressionReason(guidance)
    : getDefaultToolSuppressionReason(guidance)
}
