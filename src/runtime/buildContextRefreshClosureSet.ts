/**
 * Phase 3B-12 slice — `buildContextRefreshClosureSet.ts`
 *
 * Extracted from `src/runtime/LLMCodingRuntime.ts`. Contains
 * the factory function `buildContextRefreshClosureSet()`
 * that returns the per-request closure bundle the main loop
 * uses between context refreshes. The closures all read
 * the same mutable `let` bundle of state; the factory
 * captures the state and returns the closures that
 * observe / mutate it.
 *
 * What the factory returns:
 *
 *   - `estimateVisibleContextTokens()` — recompute the
 *     conservative total-token estimate using the current
 *     `assembledContext.systemPrompt` + `messages` +
 *     `modelVisibleTools`.
 *   - `applyContextRefreshState(nextState)` — overwrite
 *     the holder's state with a fresh
 *     `ContextRefreshState` (returned by
 *     `ContextRefreshStrategy.refresh(...)`) and absorb
 *     the new `cacheAwareCompactPolicy` into the runtime
 *     metrics.
 *   - `contextMicrocompactEvent(trigger)` — build the
 *     `context_microcompact` NexusEvent for one of the
 *     four triggers (`initial_refresh` /
 *     `pre_provider_call` / `after_compact` /
 *     `after_message_budget`).
 *   - `refreshAfterProviderContextRecovery()` — re-run
 *     the `ContextRefreshStrategy.refresh` after the
 *     provider has rejected the prompt as too large and
 *     the reactive compact has already happened.
 *   - `postCompactGroundingEvents(source, boundaryId?)` —
 *     build the post-compact / context-recovery grounding
 *     events, side-effecting `readFileCache.clear()` first.
 *
 * Why extracted:
 *
 * - The five closures were the only consumers of the
 *   `let assembledContext` / `let messages` / `let
 *   contextWindowState` / `let cacheAwareCompactPolicy`
 *   mutable bundle in the first half of
 *   `runExecuteStreamInner`. Pulling them out as a
 *   factory makes the main loop's closure dependency
 *   explicit and shrinks the closure count that lives
 *   inside the class body.
 * - The five closures are tightly coupled — they all
 *   observe and mutate the same seven-tuple of state. As
 *   a class field each closure was inlined and the
 *   shared state was re-listed on every refresh; as a
 *   factory the state lives in the factory's closure
 *   and each helper is a single small function.
 * - Future slices that need to "drive a context refresh
 *   off the runtime loop" can call this factory directly
 *   with a fake `ContextRefreshStrategy` and observe the
 *   same helper surface the main loop uses.
 *
 * Goals:
 *
 * - Preserve exact behavior parity: every helper's
 *   observable output is byte-identical to the prior
 *   inline closure.
 * - Eliminate ~50 lines of inline closure bundle from
 *   `LLMCodingRuntime.ts`.
 *
 * Non-goals:
 *
 * - The factory does NOT own the `let` state. The main
 *   loop still declares the 7 mutable state variables
 *   inline; the factory's helpers read / write them
 *   through the getter callbacks the caller passes in.
 *   This is a deliberate split: the factory is a
 *   "closure bundle" that observes / mutates externally-
 *   owned state. Future slices that own the state
 *   themselves (3B-13 holder pattern) can swap to a
 *   different factory.
 * - Do not yield events. The factory returns plain
 *   functions; the main loop's yield shape is
 *   unchanged.
 * - Do not introduce a new "ContextRefreshStateManager"
 *   class. The factory is a plain function that returns
 *   a `{ ...closures }` object — no class hierarchy, no
 *   inheritance, no subclass hooks.
 */

import {
  buildContextMicrocompactEvent,
  buildPostCompactGroundingEvents,
  absorbCacheAwareCompactPolicyMetrics,
} from './runtimePipeline.js'
import { estimateContextTokens } from './tokenEstimator.js'
import { ContextRefreshStrategy, type ContextRefreshStrategyOptions } from './ContextRefreshStrategy.js'
import type { RuntimeExecutionMetrics } from './pipeline/cache.js'
import type { RuntimeContextRefreshState } from './pipeline/contextRefresh.js'
import type { NexusEvent } from '../shared/events.js'
import type { ModelToolDefinition } from '../providers/adapters/ModelAdapter.js'
import type { ReadFileCacheEntry } from './runtimeToolLoop.js'

export type ContextRefreshStateBundle = {
  /** Read the current `assembledContext`. */
  getAssembledContext: () => RuntimeContextRefreshState['assembledContext']
  /** Read the current `messages`. */
  getMessages: () => RuntimeContextRefreshState['messages']
  /** Read the current `modelVisibleTools`. */
  getModelVisibleTools: () => ModelToolDefinition[]
  /** Read the current `contextWindowState`. */
  getContextWindowState: () => RuntimeContextRefreshState['contextWindowState']
  /** Write the full `nextState` bundle into the holder.
   *  Side effect: absorb the new `cacheAwareCompactPolicy`
   *  into the runtime metrics. */
  setContextRefreshState: (nextState: RuntimeContextRefreshState) => void
}

export type ContextRefreshClosureSet = {
  /**
   * Conservative total-token estimate using the holder's
   * current `assembledContext.systemPrompt` +
   * `messages` + `modelVisibleTools`. Recomputed on
   * every call.
   */
  estimateVisibleContextTokens: () => number
  /**
   * Overwrite the holder's state with `nextState` via
   * `setContextRefreshState` (which also absorbs the
   * new `cacheAwareCompactPolicy` into the runtime
   * metrics).
   */
  applyContextRefreshState: (nextState: RuntimeContextRefreshState) => void
  /**
   * Build the `context_microcompact` NexusEvent for
   * one of the four triggers. Returns `undefined` when
   * the holder's `assembledContext.microcompactMetrics`
   * says no microcompact happened on this turn.
   */
  contextMicrocompactEvent: (
    trigger: 'initial_refresh' | 'pre_provider_call' | 'after_compact' | 'after_message_budget',
  ) => NexusEvent | undefined
  /**
   * Re-run `ContextRefreshStrategy.refresh` against the
   * same arguments used for the most recent refresh
   * (the closure captures them) and pipe the result
   * through `applyContextRefreshState` so the holder
   * stays the single source of truth.
   */
  refreshAfterProviderContextRecovery: () => Promise<void>
  /**
   * Build the post-compact / context-recovery grounding
   * events, side-effecting `readFileCache.clear()` first.
   */
  postCompactGroundingEvents: (
    source: 'post_compact' | 'context_recovery',
    boundaryId?: string,
  ) => NexusEvent[]
}

export type BuildContextRefreshClosureSetInput = {
  /** Mutable state bundle the closures observe. The
   *  main loop owns the underlying `let` variables; the
   *  factory's helpers read / write through this. */
  state: ContextRefreshStateBundle
  metrics: RuntimeExecutionMetrics
  refreshStrategy: ContextRefreshStrategy
  /**
   * The arguments to pass to
   * `ContextRefreshStrategy.refresh(...)` on every call
   * to `refreshAfterProviderContextRecovery()`. Captured
   * by closure so the call site does not have to repeat
   * the option list on every provider-recovery loop.
   */
  refreshOptions: Omit<ContextRefreshStrategyOptions, 'sessionInbox'>
  /** Side-effect target for `postCompactGroundingEvents`. */
  readFileCache: Map<string, ReadFileCacheEntry>
  sessionId: string
  requestId: string | undefined
}

/**
 * Build the per-request context-refresh closure bundle.
 * The factory does not own the `let` state; it reads /
 * writes through the `state: ContextRefreshStateBundle`
 * the caller passes in.
 */
export function buildContextRefreshClosureSet(
  input: BuildContextRefreshClosureSetInput,
): ContextRefreshClosureSet {
  const { state, metrics, refreshStrategy, refreshOptions, readFileCache } = input

  return {
    estimateVisibleContextTokens: () =>
      estimateContextTokens({
        systemPrompt: state.getAssembledContext().systemPrompt,
        messages: state.getMessages(),
        tools: state.getModelVisibleTools(),
        conservative: true,
      }).totalTokens,

    applyContextRefreshState: (nextState) => {
      state.setContextRefreshState(nextState)
      absorbCacheAwareCompactPolicyMetrics(metrics, nextState.cacheAwareCompactPolicy)
    },

    contextMicrocompactEvent: (trigger) =>
      buildContextMicrocompactEvent({
        sessionId: input.sessionId,
        requestId: input.requestId,
        trigger,
        metrics: state.getAssembledContext().microcompactMetrics,
      }),

    refreshAfterProviderContextRecovery: async () => {
      // The post-recovery path always uses 'load' so the
      // broadcaster-backed inbox state is fresh.
      const next = await refreshStrategy.refresh({
        ...refreshOptions,
        sessionInbox: 'load',
      })
      state.setContextRefreshState(next)
      absorbCacheAwareCompactPolicyMetrics(metrics, next.cacheAwareCompactPolicy)
    },

    postCompactGroundingEvents: (source, boundaryId) => {
      readFileCache.clear()
      return buildPostCompactGroundingEvents({
        sessionId: input.sessionId,
        requestId: input.requestId,
        source,
        boundaryId,
        gitStatus: state.getAssembledContext().gitStatus,
      })
    },
  }
}
