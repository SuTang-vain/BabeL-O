/**
 * Phase 3B-8 slice — `applyWorkingSetUpdate.ts`
 *
 * Extracted from `src/runtime/LLMCodingRuntime.ts`. Contains the
 * standalone function `applyWorkingSetUpdate()` which is the
 * write-side counterpart of `loadWorkingSetOverride()`.
 *
 * Why extracted:
 *
 * - The helper is **a fire-and-forget side effect**: it walks the
 *   events list, calls `workingSetTracker.applyEvent` for each
 *   `tool_started` event, and never blocks the hot path. Keeping it
 *   as a private method on the LLMCodingRuntime class made it
 *   impossible to unit-test in isolation (every test had to
 *   instantiate a full runtime).
 * - The helper is **the R2 write-side** of
 *   `docs/nexus/proposals/long-running-context-assembly.md §20` — it
 *   pairs with `loadWorkingSetOverride` to close the "Persisted
 *   Working Set接入 executeStream hot path" loop. Future R5 work may
 *   want to call it from a CLI debug command without spinning up a
 *   full Nexus runtime; having it as a standalone function removes
 *   the runtime-loop dependency for those callers.
 *
 * Goals:
 *
 * - Preserve exact behavior parity: every successful `tool_started`
 *   event contributes to the working set; non-`tool_started` events
 *   are skipped; the function is fire-and-forget (no await).
 * - Make the helper testable in isolation by passing dependencies
 *   (the working-set tracker) as an explicit argument.
 * - Eliminate ~30 lines of private-method code from
 *   `LLMCodingRuntime.ts` (the comment block stays inline for
 *   documentation purposes; see the thin-delegate wrapper).
 *
 * Non-goals:
 *
 * - Do not await the tracker's background flush — the hot path must
 *   not block on persistence (per
 *   `feedback-babel-o-soft-recoverable-timeouts`). The tracker
 *   schedules its own flush on every `applyEvent()` call.
 * - Do not change the per-event `applyEvent` filter — that logic
 *   already lives in `WorkingSetTracker.applyEvent` and handles the
 *   out-of-scope path filter, parse-only pseudo calls, and the
 *   success-confidence logic.
 * - Do not change the iteration order: events are processed in the
 *   order they appear in the input array, with non-tool events
 *   silently skipped.
 */

import type { NexusEvent } from '../shared/events.js'
import type { PersistedWorkingSetTracker } from './persistedWorkingSetTracker.js'

/**
 * Walk the events list and call `workingSetTracker.applyEvent()` for
 * each `tool_started` event. Non-`tool_started` events are silently
 * skipped. The function is fire-and-forget: the tracker schedules its
 * own background flush on every update, so we do not await persistence
 * (per R2 acceptance: "a real run touching a workspace file creates
 * `<cwd>/.babel-o/working-set.json`" — the background flush lands the
 * file within one tick).
 *
 * Called from `runExecuteStreamInner` after a successful tool
 * execution, with the `toolEvents` batch yielded by the provider
 * tool-call loop.
 */
export function applyWorkingSetUpdate(
  tracker: PersistedWorkingSetTracker | undefined,
  sessionId: string,
  events: NexusEvent[],
  cwd: string,
): void {
  if (!tracker) return
  for (const event of events) {
    // R2 spec: only successful tool_started events contribute.
    if (event.type !== 'tool_started') continue
    // The tracker's own applyEvent handles:
    //   - parse-only pseudo calls (TOOL_INPUT_PARSE_ERROR path) that
    //     emit synthetic tool_started without a usable path
    //   - out-of-scope paths (not under cwd)
    //   - confidence logic for partial-success tools
    // by returning null without mutating state.
    tracker.applyEvent(sessionId, event, cwd)
  }
}
