/**
 * Phase 3B-15 slice — `executeProviderTurn.ts`
 *
 * Extracted from `src/runtime/LLMCodingRuntime.ts`. Contains
 * the standalone async function `executeProviderTurn()`
 * that runs `ProviderTurnDriver.run(...)`, drains the
 * resulting async generator, and returns the final
 * `RuntimeProviderTurn` + the events it yielded.
 *
 * Why extracted:
 *
 * - The provider-turn call site is the start of a 130+
 *   line block in the main loop. Pulling the call out
 *   behind a 1-line helper makes the main loop's per-
 *   iteration shape visible at a glance and lets the
 *   catch-block (recovery + post-invocation hooks)
 *   be the next thing the eye lands on.
 * - `ProviderTurnDriver.run(...)` returns an async
 *   generator; the main loop's prior inline code drove
 *   the generator with a hand-rolled
 *   `while (!result.done) { yield result.value; result =
 *   await stream.next() }` loop. The helper hides that
 *   plumbing behind a single function call.
 * - Future slices (3B-16) can add a recovery / post-
 *   invocation wrapper around the same call without
 *   touching the call site.
 *
 * Goals:
 *
 * - Preserve exact behavior parity: the helper returns
 *   the same `RuntimeProviderTurn` value the prior
 *   inline `while`-loop would have assigned to
 *   `providerTurn`, and the helper returns the same
 *   `NexusEvent`s in the same order. The main loop
 *   still drives the user-facing yield loop.
 * - Eliminate ~10 lines of inline generator-drive
 *   code from `LLMCodingRuntime.ts`.
 *
 * Non-goals:
 *
 * - Do not change the call site of
 *   `ProviderTurnDriver.run(...)`: the helper passes
 *   the same options through.
 * - Do not handle errors here. The catch-block +
 *   recovery decision tree stays in the main loop
 *   (3B-16). Errors thrown by `ProviderTurnDriver.run`
 *   propagate up to the main loop's try/catch.
 * - Do not add any new behaviour: this is a pure
 *   extraction.
 */

import type { RuntimeProviderTurn } from './runtimePipeline.js'
import type { ProviderTurnDriver } from './ProviderTurnDriver.js'
import type { NexusEvent } from '../shared/events.js'

export type ExecuteProviderTurnInput = Parameters<ProviderTurnDriver['run']>[0]

export type ExecuteProviderTurnResult = {
  /** Every `NexusEvent` the provider turn yielded, in
   *  order. The main loop drives the user-facing yield
   *  loop; the helper does not yield. */
  events: NexusEvent[]
  /** Final provider turn value (the value the prior
   *  inline `while`-loop would have assigned to
   *  `providerTurn`). */
  providerTurn: RuntimeProviderTurn
}

/**
 * Run one provider turn via `ProviderTurnDriver.run(...)`,
 * drain the resulting async generator, and return
 * `{ events, providerTurn }`. The main loop is
 * responsible for driving the user-facing yield loop.
 */
export async function executeProviderTurn(
  providerTurnDriver: ProviderTurnDriver,
  input: ExecuteProviderTurnInput,
): Promise<ExecuteProviderTurnResult> {
  const events: NexusEvent[] = []
  const stream = providerTurnDriver.run(input)
  let result = await stream.next()
  while (!result.done) {
    events.push(result.value)
    result = await stream.next()
  }
  return { events, providerTurn: result.value }
}
