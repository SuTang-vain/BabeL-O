import type { SessionSnapshot } from '../shared/session.js'
import type { NexusTask } from '../shared/task.js'
import type { NexusEvent } from '../shared/events.js'
import type { NexusStorage } from '../storage/Storage.js'

let nexusStorage: NexusStorage | null = null
const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 100

type PersistOperation = {
  id: string
  type: 'task_session' | 'task'
  attempt: number
  run(storage: NexusStorage): Promise<void>
}

type StorageBridgeStats = {
  queued: number
  active: boolean
  succeeded: number
  failed: number
  permanentFailures: number
  lastError?: string
}

let nextOperationId = 0
let queue: PersistOperation[] = []
let flushing = false
let scheduled: ReturnType<typeof setTimeout> | null = null
const stats: StorageBridgeStats = {
  queued: 0,
  active: false,
  succeeded: 0,
  failed: 0,
  permanentFailures: 0,
}

export function setNexusStorage(storage: NexusStorage | null): void {
  nexusStorage = storage
  if (storage) {
    scheduleFlush(0)
  }
}

export const setNexusStorageForTest = setNexusStorage

export function getNexusStorageForTest(): NexusStorage | null {
  return nexusStorage
}

export function getStorageBridgeStats(): StorageBridgeStats {
  return {
    ...stats,
    queued: queue.length,
    active: flushing,
  }
}

export async function flushStorageBridgeForTest(): Promise<void> {
  await flushQueue()
}

export function resetStorageBridgeForTest(): void {
  if (scheduled) {
    clearTimeout(scheduled)
    scheduled = null
  }
  queue = []
  flushing = false
  stats.queued = 0
  stats.active = false
  stats.succeeded = 0
  stats.failed = 0
  stats.permanentFailures = 0
  stats.lastError = undefined
}

export function persistTaskSessionMutation(options: {
  session: SessionSnapshot
  event?: NexusEvent
}): void {
  enqueueOperation({
    type: 'task_session',
    async run(storage) {
      await storage.saveSession(options.session)
      if (options.event) {
        await storage.appendEvent(options.session.sessionId, options.event)
      }
    },
  })
}

export function persistNexusTask(task: NexusTask): void {
  enqueueOperation({
    type: 'task',
    async run(storage) {
      await storage.saveTask(task)
    },
  })
}

function enqueueOperation(operation: Omit<PersistOperation, 'id' | 'attempt'>): void {
  queue.push({
    ...operation,
    id: `persist-${++nextOperationId}`,
    attempt: 0,
  })
  stats.queued = queue.length
  scheduleFlush(0)
}

function scheduleFlush(delayMs = RETRY_DELAY_MS): void {
  if (!nexusStorage || scheduled || flushing) return
  scheduled = setTimeout(() => {
    scheduled = null
    void flushQueue()
  }, delayMs)
  scheduled.unref?.()
}

async function flushQueue(): Promise<void> {
  if (flushing || !nexusStorage) return
  flushing = true
  stats.active = true
  try {
    while (queue.length > 0 && nexusStorage) {
      const operation = queue.shift()!
      try {
        await operation.run(nexusStorage)
        stats.succeeded += 1
      } catch (error) {
        operation.attempt += 1
        stats.failed += 1
        stats.lastError = error instanceof Error ? error.message : String(error)
        if (operation.attempt < MAX_ATTEMPTS) {
          queue.unshift(operation)
          scheduleFlush(RETRY_DELAY_MS * operation.attempt)
          return
        }
        stats.permanentFailures += 1
        console.error(`Storage operation ${operation.id} (${operation.type}) failed permanently:`, error)
      } finally {
        stats.queued = queue.length
      }
    }
  } finally {
    flushing = false
    stats.active = false
    stats.queued = queue.length
  }
}
