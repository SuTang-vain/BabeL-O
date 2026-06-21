/**
 * Phase 3B-6 slice — `behaviorTraceTap.ts`
 *
 * Extracted from `src/runtime/LLMCodingRuntime.ts` (the 1609-line god
 * class after Phase 3B-1). Contains the top-level exportable function
 * `wrapWithBehaviorTraceTap()` plus its private `behaviorTraceDetectionKey()`
 * helper.
 *
 * Why extracted:
 *
 * - The tap is a **pure write-side function** (INV-4): it consumes an
 *   `AsyncIterable<NexusEvent>` from the runtime loop and emits the
 *   exact same events downstream, while enqueueing best-effort
 *   behaviorTrace entries as a side effect. Keeping it inside the
 *   1609-line `LLMCodingRuntime` file made it harder to unit-test in
 *   isolation (every test had to instantiate a full runtime).
 * - The tap is **orthogonal** to the runtime loop: it does not depend
 *   on `this.*` state, the loop's local variables, or `ProviderTurnDriver`
 *   / `ContextRefreshStrategy` / `ToolDispatchPipeline`. All it needs
 *   is `RuntimeExecuteOptions` (for `cwd` / `sessionId`) and the
 *   behaviorTrace subsystem.
 * - The tap is **a candidate for further reuse**: future event-driven
 *   pipelines (e.g. a CLI inspector replay tool) may want the same
 *   detection + enqueue + passthrough behavior without instantiating
 *   a full Nexus runtime.
 *
 * Goals:
 *
 * - Preserve exact event ordering and detection semantics. The tap
 *   must yield every input event in input order; the side-effect
 *   queueing must remain best-effort and must never block the event
 *   stream.
 * - Keep INV-4 / INV-11 / test-config-isolation invariants intact.
 * - Eliminate ~85 lines of pure-function code from `LLMCodingRuntime.ts`.
 *
 * Non-goals:
 *
 * - Do not move the underlying behaviorTrace machinery (`detectTriggers`,
 *   `queueBehaviorTraceEntry`, `flushBehaviorTraceQueue`,
 *   `buildTraceContext`, `deriveRuleSelfAssessment`,
 *   `isBehaviorTraceEnabled`) — those already live in
 *   `./behaviorTrace.ts` and stay there. This module just composes
 *   them into the runtime-event-stream tap.
 * - Do not change the detection key shape: the JSON-stringified key
 *   is persisted in `.babel-o/behavior-trace.jsonl` so changing it
 *   would orphan existing entries.
 */

import type { NexusEvent } from '../shared/events.js'
import { logger } from '../shared/logger.js'
import type { RuntimeExecuteOptions } from './Runtime.js'
import {
  buildTraceContext,
  detectTriggers,
  deriveRuleSelfAssessment,
  flushBehaviorTraceQueue,
  isBehaviorTraceEnabled,
  queueBehaviorTraceEntry,
} from './behaviorTrace.js'

/**
 * Wrap a runtime event stream with a best-effort behaviorTrace tap.
 *
 * Behaviour:
 *
 * - **Passthrough**: every input event is yielded to the consumer in
 *   input order. The tap never mutates or drops events (INV-4).
 * - **Disabled short-circuit**: when `isBehaviorTraceEnabled()` returns
 *   false (env var not set or feature off), the source is yielded
 *   directly with zero overhead beyond the wrapper allocation.
 * - **Per-event detection**: for each event, `detectTriggers()` is
 *   invoked with the trailing buffer slice. Triggered entries are
 *   deduplicated by a stable JSON key, then enqueued via
 *   `queueBehaviorTraceEntry()` with the surrounding trace context.
 * - **Task scope windowing**: after the first `task_scope_declared`
 *   event, detection is restricted to events emitted at-or-after that
 *   scope declaration. This suppresses drift detection on the
 *   task_scope_declared event itself, which is the event that
 *   establishes the scope.
 * - **Best-effort flush**: after the source ends, a fire-and-forget
 *   `flushBehaviorTraceQueue()` is triggered. Errors are logged at
 *   debug level only; they must never propagate into the runtime loop.
 *
 * Invariants:
 *
 * - INV-4: pure write-side; never mutates the inner event stream.
 * - INV-11: never touches `natural_pause`.
 * - test-config-isolation: `cwd` comes from `RuntimeExecuteOptions`,
 *   never from `process.env.HOME`.
 */
export async function* wrapWithBehaviorTraceTap(
  options: RuntimeExecuteOptions,
  source: AsyncIterable<NexusEvent>,
): AsyncIterable<NexusEvent> {
  if (!isBehaviorTraceEnabled()) {
    yield* source
    return
  }
  const buffer: NexusEvent[] = []
  const emittedTraceKeys = new Set<string>()
  let taskScopeGlob: string | undefined
  let lastTaskScopeEventAt = -1
  for await (const event of source) {
    buffer.push(event)
    if (event.type === 'task_scope_declared') {
      const e = event as Extract<NexusEvent, { type: 'task_scope_declared' }>
      const root = e.primaryRoot
      if (typeof root === 'string' && root.length > 0) {
        taskScopeGlob = root.endsWith('/**') ? root : `${root.replace(/\/+$/, '')}/**`
        lastTaskScopeEventAt = buffer.length - 1
      }
    }
    try {
      // Only consider events that have been seen (suppress drift detection
      // on the task_scope_declared event itself, which is the first event
      // that establishes the scope).
      const eventsForDetect = lastTaskScopeEventAt >= 0
        ? buffer.slice(lastTaskScopeEventAt)
        : buffer
      const detected = detectTriggers({
        events: eventsForDetect,
        cwd: options.cwd,
        sessionId: options.sessionId,
        taskScope: taskScopeGlob,
      })
      for (const det of detected) {
        const key = behaviorTraceDetectionKey(det)
        if (emittedTraceKeys.has(key)) continue
        emittedTraceKeys.add(key)
        const ctx = buildTraceContext({ events: buffer })
        const sa = deriveRuleSelfAssessment(det.trigger, det.anomaly, { retryCount: ctx.retryCount })
        queueBehaviorTraceEntry({
          cwd: options.cwd,
          sessionId: options.sessionId,
          trigger: det.trigger,
          triggerConfidence: det.confidence,
          anomaly: det.anomaly,
          context: ctx,
          selfAssessment: sa,
        })
      }
    } catch (error) {
      logger.debug('behaviorTrace tap detection failed', error)
    }
    yield event
  }
  // Best-effort flush. Do not block event stream teardown.
  void flushBehaviorTraceQueue().catch((error) => {
    logger.debug('behaviorTrace flush failed', error)
  })
}

/**
 * Stable JSON-stringified key for a detected trigger. Used to
 * deduplicate entries when the same trigger fires repeatedly on the
 * same anomaly signature.
 *
 * The key shape is part of the on-disk `.babel-o/behavior-trace.jsonl`
 * contract: changing it orphans existing entries, so it must remain
 * stable across versions.
 */
function behaviorTraceDetectionKey(
  detected: ReturnType<typeof detectTriggers>[number],
): string {
  const anomaly = detected.anomaly
  return JSON.stringify([
    detected.trigger,
    detected.relatedEventIndex,
    anomaly.errorCode ?? '',
    anomaly.errorMessage ?? '',
    anomaly.denialReason ?? '',
    anomaly.driftPath ?? '',
    anomaly.expectedScope ?? '',
    anomaly.userRedirectSignal ?? '',
  ])
}
