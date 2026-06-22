import type { NexusRuntime, RuntimeExecuteOptions } from '../runtime/Runtime.js'
import { eventBase, type NexusEvent } from '../shared/events.js'
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
  const iterator = options.runtime.executeStream(options.runtimeOptions)[Symbol.asyncIterator]()
  let runtimeDone = false
  while (!runtimeDone) {
    const next = await nextRuntimeEventOrAbort(iterator, {
      sessionId: options.sessionId,
      signal: options.runtimeOptions.signal,
      timeoutSignal: options.runtimeOptions.timeoutSignal,
    })
    if (next.kind === 'done') {
      runtimeDone = true
      break
    }
    if (next.kind === 'abort') {
      void closeRuntimeIterator(iterator)
    }
    const event = next.event
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
    if (next.kind === 'abort') break
  }
  return { success, timedOut }
}

type RuntimeNextOutcome =
  | { kind: 'event'; event: NexusEvent }
  | { kind: 'abort'; event: NexusEvent }
  | { kind: 'done' }

async function nextRuntimeEventOrAbort(
  iterator: AsyncIterator<NexusEvent>,
  options: {
    sessionId: string
    signal?: AbortSignal
    timeoutSignal?: AbortSignal
  },
): Promise<RuntimeNextOutcome> {
  const alreadyAborted = buildAbortEventIfNeeded(options)
  if (alreadyAborted) return { kind: 'abort', event: alreadyAborted }

  let cleanup = () => {}
  const nextPromise = iterator.next()
    .then((result): RuntimeNextOutcome => {
      if (result.done) return { kind: 'done' }
      return { kind: 'event', event: result.value }
    })
  nextPromise.catch(() => {
    // If abort wins the race, the underlying iterator.next()
    // may still reject later while the route has already
    // settled the execution. The main await observes errors
    // that win the race; this catch prevents a late rejection
    // from becoming process-level noise.
  })

  const abortPromise = new Promise<RuntimeNextOutcome>(resolve => {
    const onAbort = () => {
      cleanup()
      const event = buildAbortEventIfNeeded(options)
      if (event) resolve({ kind: 'abort', event })
    }
    const listeners: Array<{ signal: AbortSignal; listener: () => void }> = []
    for (const signal of [options.timeoutSignal, options.signal]) {
      if (!signal) continue
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
      listeners.push({ signal, listener: onAbort })
    }
    cleanup = () => {
      for (const entry of listeners) {
        entry.signal.removeEventListener('abort', entry.listener)
      }
      listeners.length = 0
    }
  })

  try {
    return await Promise.race([nextPromise, abortPromise])
  } finally {
    cleanup()
  }
}

function buildAbortEventIfNeeded(options: {
  sessionId: string
  signal?: AbortSignal
  timeoutSignal?: AbortSignal
}): Extract<NexusEvent, { type: 'error' }> | undefined {
  if (options.timeoutSignal?.aborted) {
    return {
      type: 'error',
      ...eventBase(options.sessionId),
      code: 'REQUEST_TIMEOUT',
      message: 'Execution timed out.',
      details: { source: 'nexus_stream_abort_race' },
    }
  }
  if (options.signal?.aborted) {
    return {
      type: 'error',
      ...eventBase(options.sessionId),
      code: 'REQUEST_CANCELLED',
      message: 'Execution cancelled by user.',
      details: { source: 'nexus_stream_abort_race' },
    }
  }
  return undefined
}

async function closeRuntimeIterator(iterator: AsyncIterator<NexusEvent>): Promise<void> {
  try {
    await iterator.return?.()
  } catch {
    // Best-effort cleanup only. The route already has an authoritative
    // abort signal and has emitted a terminal error for the client.
  }
}
