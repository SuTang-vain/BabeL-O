import type { NexusRuntime, RuntimeExecuteOptions } from '../runtime/Runtime.js'
import type { NexusEvent } from '../shared/events.js'
import type { NexusStorage } from '../storage/Storage.js'
import { appendNearTimeoutWarning, type TimeoutEventSender } from './executionTimeoutEvents.js'
import { processRuntimeExecutionEvent, type BehaviorMonitorLike, type ProcessRuntimeExecutionEventResult } from './executionEventProcessing.js'
import type { ExecuteTimeoutDecision, WatchdogState } from './executionPreparation.js'
import type { NexusMetrics } from './metrics.js'

export type ExecutionStreamLoopForwardResult = {
  closed?: boolean
  event?: NexusEvent
}

export type ExecutionStreamLoopResult = {
  success: boolean
  timedOut: boolean
}

export async function runExecutionStreamLoop(options: {
  runtime: NexusRuntime
  runtimeOptions: RuntimeExecuteOptions
  events: NexusEvent[]
  sessionId: string
  cwd: string
  requestId: string
  storage: NexusStorage
  metrics: NexusMetrics
  timeoutDecision: ExecuteTimeoutDecision
  watchdog: WatchdogState
  timeoutMs: number
  startedAtMs: number
  now: () => number
  behaviorMonitor?: BehaviorMonitorLike
  sendTimeoutEvent?: TimeoutEventSender
  forwardProcessedEvent?: (processed: ProcessRuntimeExecutionEventResult) => ExecutionStreamLoopForwardResult
}): Promise<ExecutionStreamLoopResult> {
  let success = false
  let timedOut = false
  for await (const event of options.runtime.executeStream(options.runtimeOptions)) {
    const processed = await processRuntimeExecutionEvent({
      event,
      events: options.events,
      sessionId: options.sessionId,
      cwd: options.cwd,
      storage: options.storage,
      metrics: options.metrics,
      timeoutDecision: options.timeoutDecision,
      watchdog: options.watchdog,
      behaviorMonitor: options.behaviorMonitor,
    })
    const forwarded = options.forwardProcessedEvent?.(processed)
    if (forwarded?.closed) break
    const observedEvent = forwarded?.event ?? processed.event
    await appendNearTimeoutWarning({
      storage: options.storage,
      events: options.events,
      sessionId: options.sessionId,
      requestId: options.requestId,
      timeoutMs: options.timeoutMs,
      elapsedMs: Math.max(0, Math.round(options.now() - options.startedAtMs)),
      send: options.sendTimeoutEvent,
    })
    if (observedEvent.type === 'result') success = observedEvent.success
    if (observedEvent.type === 'error' && observedEvent.code === 'REQUEST_TIMEOUT') {
      timedOut = true
    }
  }
  return { success, timedOut }
}
