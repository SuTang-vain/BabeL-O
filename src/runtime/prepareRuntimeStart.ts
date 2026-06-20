/**
 * Phase 3B-10 slice — `prepareRuntimeStart.ts`
 *
 * Extracted from `src/runtime/LLMCodingRuntime.ts`. Contains
 * the standalone function `prepareRuntimeStart()` which is
 * the runtime's step 1-2 (per the per-step comments in
 * `runExecuteStreamInner`):
 *
 *   1. Resolve connection / credential settings (caller's job)
 *   2. Load previous session events from storage (if any)
 *   3. Build and yield the user intake guidance event
 *   4. Build and yield the task scope declared event
 *   5. Decide whether the current turn is a confirmed
 *      option-selection-after-clarification (this drives
 *      `confirmedOptionSelection` in the main loop)
 *   6. Construct the per-request `toolsList` closure
 *   7. Construct the per-request `mapEventsForProvider`
 *      closure
 *
 * Why extracted:
 *
 * - The helper is the only non-orchestration block in the
 *   first ~70 lines of `runExecuteStreamInner`. It does
 *   not participate in the main 25-step yield / refresh /
 *   compact / provider-turn / tool-dispatch loop. Pulling
 *   it out shrinks the main loop's cognitive load without
 *   touching the loop body itself.
 * - The helper is a non-trivial collection of closures
 *   (mapEventsForProvider, toolsList) plus a 1-shot pair
 *   of side-effecting event builds (intakeEvent,
 *   taskScopeEvent) that the runtime yields in order. As a
 *   class-internal block it could not be unit-tested
 *   without instantiating a full LLMCodingRuntime.
 * - Future work that needs to "set up a runtime start
 *   context for analysis" (e.g. a CLI debug command that
 *   replays a previous turn without executing it) can call
 *   this helper directly.
 *
 * Goals:
 *
 * - Preserve exact behavior parity: the caller yields
 *   intakeEvent then taskScopeEvent in that order, then
 *   mutates `previousEvents` to include both, and uses
 *   the closures for downstream refresh / tool dispatch.
 * - Eliminate ~60 lines of pre-loop setup from
 *   `LLMCodingRuntime.ts`.
 *
 * Non-goals:
 *
 * - Do not change the event shapes of intake / task scope
 *   / user_message; they are owned by `intentGuidance.ts`
 *   and `taskScope.ts`.
 * - Do not change the policy / soft-deny / schema rules
 *   inside `toolsList` — those are runtime policy facts
 *   the runtime owns, not configuration knobs to centralize.
 * - Do not yield events from this helper. The caller
 *   yields; the helper builds. This is a deliberate
 *   split: the helper has no `AsyncIterable` shape, so it
 *   can be tested with plain `await` and asserted on
 *   synchronously.
 */

import { z } from 'zod'
import type { NexusEvent } from '../shared/events.js'
import type { ModelMessage } from '../providers/adapters/ModelAdapter.js'
import type { RuntimeExecuteOptions } from './Runtime.js'
import type { NexusStorage } from '../storage/Storage.js'
import type { AnyTool } from '../tools/Tool.js'
import { type ToolPolicy } from './LocalCodingRuntime.js'
import { mapEventsToMessages } from './eventsTranslator.js'
import { buildUserIntakeGuidanceEvent } from './intentGuidance.js'
import { buildTaskScopeDeclaredEvent } from './taskScope.js'
import { isOptionSelectionClarificationText, normalizeOptionSelection } from './pipeline/providerTurn.js'

// ProviderToolSpec is the shape the toolsList closure
// returns. It is what the runtime hot path passes into
// `ContextRefreshStrategy.refresh({ tools: toolsList })`
// and what `buildProviderLoopRequestState` later embeds
// in the model-visible tool list. The shape is defined
// inline here rather than imported from
// `RuntimeExecuteOptions.tools` to keep this helper
// decoupled from the runtime interface.
export type ProviderToolSpec = {
  name: string
  description: string
  inputSchema: unknown
}

export type RuntimeStartDeps = {
  storage: NexusStorage | undefined
  tools: Map<string, AnyTool>
  toolPolicy: ToolPolicy
  // logger is optional; if absent, the helper silently
  // swallows the storage.listEvents error (matching the
  // original behavior of `logger.debug(...)` swallowing).
  logger?: { debug: (message: string, ...args: unknown[]) => void }
}

export type PreparedRuntimeStart = {
  intakeEvent: NexusEvent
  taskScopeEvent: NexusEvent
  previousEvents: NexusEvent[]
  mapEventsForProvider: (events: NexusEvent[], initialPrompt: string) => ModelMessage[]
  toolsList: () => ProviderToolSpec[]
  confirmedOptionSelection: boolean
}

export type PrepareRuntimeStartInput = {
  options: RuntimeExecuteOptions
  deps: RuntimeStartDeps
  // The caller resolves these in step 1 (configManager
  // settings) and passes them through. The helper does
  // NOT call configManager itself — that decision is
  // retained by the runtime so step 1 audit trails
  // (which model / provider / baseUrl) are visible in
  // the main loop's call site.
  settings: {
    providerId: string
    modelId: string
    apiKey: string | undefined
    baseUrl: string | undefined
  }
  cleanedModelId: string
  adapter: unknown
  shouldReplayReasoningContent: boolean
}

/**
 * Build the runtime's step 2-7 outputs in one place.
 *
 * Step 1 (resolve connection settings) is intentionally
 * left to the caller so the runtime can own the
 * `configManager.resolveSettings` call. This helper
 * assumes `settings` + `cleanedModelId` + `adapter` have
 * already been resolved.
 *
 * Returns the events the caller must yield, the
 * per-request closures, and the seeded `previousEvents`
 * list (which already includes intakeEvent +
 * taskScopeEvent so the caller can simply use it as
 * `previousEvents` going forward).
 */
export async function prepareRuntimeStart(
  input: PrepareRuntimeStartInput,
): Promise<PreparedRuntimeStart> {
  const { options, deps, settings, cleanedModelId, adapter, shouldReplayReasoningContent } = input

  // Step 2: load previous session events (desc order then
  // reverse for chronological in-memory list).
  let previousEvents: NexusEvent[] = []
  if (deps.storage && options.replaySessionHistory !== false) {
    try {
      const result = await deps.storage.listEvents(options.sessionId, {
        order: 'desc',
        limit: 1000,
      })
      previousEvents = [...(result?.events || [])].reverse()
    } catch (e) {
      deps.logger?.debug('Failed to load previous session events from storage', e)
    }
  }

  // Step 3: build intake event. The helper builds; the
  // caller yields. (See "Non-goals" above for why the
  // helper does not yield itself.)
  const intakeEvent = await buildUserIntakeGuidanceEvent({
    adapter: adapter as Parameters<typeof buildUserIntakeGuidanceEvent>[0]['adapter'],
    modelId: cleanedModelId,
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    sessionId: options.sessionId,
    events: previousEvents,
    latestPrompt: options.prompt,
    cwd: options.cwd,
    signal: options.signal,
  })
  previousEvents = [...previousEvents, intakeEvent]

  // Step 4 + 5: build task scope event and decide whether
  // this is a confirmed option selection.
  const confirmedOptionSelection = isConfirmedOptionSelectionAfterClarification(previousEvents, options.prompt)
  const taskScopeEvent = buildTaskScopeDeclaredEvent({
    sessionId: options.sessionId,
    requestId: options.requestId,
    cwd: options.cwd,
    prompt: options.prompt,
    events: previousEvents,
    allowedPaths: options.allowedPaths,
  })
  previousEvents = [...previousEvents, taskScopeEvent]

  // Step 6 + 7: per-request closures used by the main
  // loop's refresh / tool-dispatch sites.
  const mapEventsForProvider = (events: NexusEvent[], initialPrompt: string): ModelMessage[] =>
    mapEventsToMessages(events, initialPrompt, {
      replayReasoningContent: shouldReplayReasoningContent,
    })

  const toolsList = (): ProviderToolSpec[] =>
    [...deps.tools.values()]
      .filter(
        (tool) =>
          deps.toolPolicy.isAllowed(tool) ||
          (options.policyMode === 'soft-deny' &&
            (tool.risk === 'write' || tool.risk === 'execute')),
      )
      .map((tool) => ({
        name: tool.name,
        description: tool.prompt ? tool.prompt() : tool.description,
        inputSchema: tool.modelInputSchema ?? z.toJSONSchema(tool.inputSchema),
      }))

  return {
    intakeEvent,
    taskScopeEvent,
    previousEvents,
    mapEventsForProvider,
    toolsList,
    confirmedOptionSelection,
  }
}

/**
 * Decide whether the current turn is a confirmed
 * option-selection-after-clarification by walking the
 * loaded events backwards.
 *
 * Moved here from the bottom of `LLMCodingRuntime.ts`
 * because it is exclusively used by `prepareRuntimeStart`.
 * Keeping it next to its single caller makes the option-
 * selection-after-clarification policy audit-able in one
 * place; if a future slice needs to relax the rule
 * (e.g. to allow confirmed-selection inside an interrupt
 * chain) the change is local to this file.
 */
function isConfirmedOptionSelectionAfterClarification(
  events: NexusEvent[],
  latestPrompt: string,
): boolean {
  const optionSelection = normalizeOptionSelection(latestPrompt)
  if (!optionSelection) return false
  let skippedCurrentUserMessage = false
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'user_message') {
      if (!skippedCurrentUserMessage && normalizeOptionSelection(event.text) === optionSelection) {
        skippedCurrentUserMessage = true
        continue
      }
      return false
    }
    if (
      (event.type === 'assistant_delta' &&
        isOptionSelectionClarificationText(event.text) &&
        event.text.includes(`"${optionSelection}"`)) ||
      (event.type === 'result' &&
        isOptionSelectionClarificationText(event.message) &&
        event.message.includes(`"${optionSelection}"`))
    ) {
      return true
    }
  }
  return false
}
