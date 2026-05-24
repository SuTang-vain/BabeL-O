import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import type { SessionSnapshot } from '../shared/session.js'
import type { NexusTask } from '../shared/task.js'
import type { NexusEvent } from '../shared/events.js'
import type { NexusStorage } from '../storage/Storage.js'
import { logger } from '../shared/logger.js'

let nexusStorage: NexusStorage | null = null
const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 100

type PersistOperation = {
  id: string
  type: 'task_session' | 'task'
  attempt: number
  payload: PersistOperationPayload
  run(storage: NexusStorage): Promise<void>
}

type StorageBridgeStats = {
  queued: number
  active: boolean
  succeeded: number
  failed: number
  permanentFailures: number
  walPending: number
  walBuffered: number
  walFlushes: number
  walWriteFailures: number
  walPath?: string
  walBatchSize: number
  walFlushIntervalMs: number
  walFsync: boolean
  lastError?: string
}

export type StorageBridgeWalOptions = {
  batchSize?: number
  flushIntervalMs?: number
  fsync?: boolean
}

type PersistOperationPayload =
  | {
      type: 'task_session'
      session: SessionSnapshot
      event?: NexusEvent
    }
  | {
      type: 'task'
      task: NexusTask
    }

type WalRecord =
  | {
      schemaVersion: '2026-05-24.storage-bridge-wal.v1'
      recordType: 'op'
      id: string
      timestamp: string
      operation: PersistOperationPayload
    }
  | {
      schemaVersion: '2026-05-24.storage-bridge-wal.v1'
      recordType: 'ack'
      id: string
      timestamp: string
    }

let nextOperationId = 0
let queue: PersistOperation[] = []
let flushing = false
let scheduled: ReturnType<typeof setTimeout> | null = null
let walPath: string | null = null
let walFlushTimer: ReturnType<typeof setTimeout> | null = null
let walBuffer: WalRecord[] = []
const walPendingOperations = new Map<string, PersistOperationPayload>()
let walOptions = normalizeWalOptions()
const stats: StorageBridgeStats = {
  queued: 0,
  active: false,
  succeeded: 0,
  failed: 0,
  permanentFailures: 0,
  walPending: 0,
  walBuffered: 0,
  walFlushes: 0,
  walWriteFailures: 0,
  walBatchSize: walOptions.batchSize,
  walFlushIntervalMs: walOptions.flushIntervalMs,
  walFsync: walOptions.fsync,
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
    walPending: walPendingOperations.size,
    walBuffered: walBuffer.length,
    walBatchSize: walOptions.batchSize,
    walFlushIntervalMs: walOptions.flushIntervalMs,
    walFsync: walOptions.fsync,
    walPath: walPath ?? undefined,
  }
}

export function configureStorageBridgeWal(
  path: string | null,
  options: StorageBridgeWalOptions = {},
): void {
  flushWalBuffer()
  walPath = path
  walOptions = normalizeWalOptions(options)
  stats.walBatchSize = walOptions.batchSize
  stats.walFlushIntervalMs = walOptions.flushIntervalMs
  stats.walFsync = walOptions.fsync
  walPendingOperations.clear()

  if (!path) {
    stats.walPending = 0
    walBuffer = []
    clearWalFlushTimer()
    return
  }

  try {
    mkdirSync(dirname(path), { recursive: true })
    replayWal(path)
    stats.walPending = walPendingOperations.size
    scheduleFlush(0)
  } catch (error) {
    stats.lastError = error instanceof Error ? error.message : String(error)
    logger.error('Failed to configure storage bridge WAL', {
      walPath: path,
      error,
    })
  }
}

export const configureStorageBridgeWalForTest = configureStorageBridgeWal

export async function flushStorageBridge(): Promise<void> {
  await flushQueue()
  flushWalBuffer()
}

export async function flushStorageBridgeForTest(): Promise<void> {
  await flushQueue()
  flushWalBuffer()
}

export function flushStorageBridgeWalForTest(): void {
  flushWalBuffer()
}

export function resetStorageBridgeForTest(): void {
  if (scheduled) {
    clearTimeout(scheduled)
    scheduled = null
  }
  clearWalFlushTimer()
  queue = []
  flushing = false
  stats.queued = 0
  stats.active = false
  stats.succeeded = 0
  stats.failed = 0
  stats.permanentFailures = 0
  stats.walPending = 0
  stats.walBuffered = 0
  stats.walFlushes = 0
  stats.walWriteFailures = 0
  walOptions = normalizeWalOptions()
  stats.walBatchSize = walOptions.batchSize
  stats.walFlushIntervalMs = walOptions.flushIntervalMs
  stats.walFsync = walOptions.fsync
  stats.lastError = undefined
  walPath = null
  walBuffer = []
  walPendingOperations.clear()
  nextOperationId = 0
}

export function persistTaskSessionMutation(options: {
  session: SessionSnapshot
  event?: NexusEvent
}): void {
  enqueueOperation({
    type: 'task_session',
    session: options.session,
    event: options.event,
  })
}

export function persistNexusTask(task: NexusTask): void {
  enqueueOperation({
    type: 'task',
    task,
  })
}

function enqueueOperation(payload: PersistOperationPayload): void {
  const id = `persist-${++nextOperationId}`
  const stablePayload = structuredClone(payload)
  appendWalOperation(id, stablePayload)
  queue.push(buildOperation(id, stablePayload))
  stats.queued = queue.length
  scheduleFlush(0)
}

function enqueueReplayedOperation(id: string, payload: PersistOperationPayload): void {
  if (queue.some(operation => operation.id === id)) return
  queue.push(buildOperation(id, structuredClone(payload)))
  stats.queued = queue.length
}

function buildOperation(
  id: string,
  payload: PersistOperationPayload,
): PersistOperation {
  return {
    id,
    type: payload.type,
    attempt: 0,
    payload,
    async run(storage) {
      await runPersistOperation(storage, payload)
    },
  }
}

async function runPersistOperation(
  storage: NexusStorage,
  payload: PersistOperationPayload,
): Promise<void> {
  if (payload.type === 'task') {
    await storage.saveTask(payload.task)
    return
  }

  await storage.saveSession(payload.session)
  if (payload.event) {
    await storage.appendEvent(payload.session.sessionId, payload.event)
  }
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
        appendWalAck(operation.id)
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
        logger.error('Storage operation failed permanently', {
          operationId: operation.id,
          operationType: operation.type,
          error,
        })
      } finally {
        stats.queued = queue.length
      }
    }
  } finally {
    if (queue.length === 0) {
      compactWal()
    }
    flushing = false
    stats.active = false
    stats.queued = queue.length
    stats.walPending = walPendingOperations.size
  }
}

function appendWalOperation(id: string, operation: PersistOperationPayload): void {
  if (!walPath) return
  appendWalRecord({
    schemaVersion: '2026-05-24.storage-bridge-wal.v1',
    recordType: 'op',
    id,
    timestamp: new Date().toISOString(),
    operation,
  })
  walPendingOperations.set(id, operation)
  stats.walPending = walPendingOperations.size
}

function appendWalAck(id: string): void {
  if (!walPath || !walPendingOperations.has(id)) return
  appendWalRecord({
    schemaVersion: '2026-05-24.storage-bridge-wal.v1',
    recordType: 'ack',
    id,
    timestamp: new Date().toISOString(),
  })
  walPendingOperations.delete(id)
  stats.walPending = walPendingOperations.size
}

function appendWalRecord(record: WalRecord): void {
  if (!walPath) return
  walBuffer.push(record)
  stats.walBuffered = walBuffer.length
  if (walBuffer.length >= walOptions.batchSize) {
    flushWalBuffer()
    return
  }
  scheduleWalFlush()
}

function flushWalBuffer(): void {
  if (!walPath || walBuffer.length === 0) return
  const records = walBuffer
  walBuffer = []
  stats.walBuffered = 0
  clearWalFlushTimer()
  try {
    mkdirSync(dirname(walPath), { recursive: true })
    const fd = openSync(walPath, 'a')
    try {
      writeSync(fd, records.map(record => JSON.stringify(record)).join('\n') + '\n')
      if (walOptions.fsync) {
        fsyncSync(fd)
      }
    } finally {
      closeSync(fd)
    }
    stats.walFlushes += 1
  } catch (error) {
    stats.walWriteFailures += 1
    stats.lastError = error instanceof Error ? error.message : String(error)
    walBuffer = [...records, ...walBuffer]
    stats.walBuffered = walBuffer.length
    scheduleWalFlush()
    logger.error('Failed to append storage bridge WAL record', {
      walPath,
      recordCount: records.length,
      error,
    })
  }
}

function scheduleWalFlush(): void {
  if (!walPath || walBuffer.length === 0 || walFlushTimer || walOptions.flushIntervalMs <= 0) {
    return
  }
  walFlushTimer = setTimeout(() => {
    walFlushTimer = null
    flushWalBuffer()
  }, walOptions.flushIntervalMs)
  walFlushTimer.unref?.()
}

function clearWalFlushTimer(): void {
  if (!walFlushTimer) return
  clearTimeout(walFlushTimer)
  walFlushTimer = null
}

function replayWal(path: string): void {
  if (!existsSync(path)) return
  const content = readFileSync(path, 'utf8')
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const record = JSON.parse(trimmed) as WalRecord
      if (record.recordType === 'op') {
        walPendingOperations.set(record.id, record.operation)
        updateNextOperationId(record.id)
      } else if (record.recordType === 'ack') {
        walPendingOperations.delete(record.id)
        updateNextOperationId(record.id)
      }
    } catch (error) {
      stats.lastError = error instanceof Error ? error.message : String(error)
      logger.warn('Ignoring malformed storage bridge WAL record', {
        walPath: path,
        error,
      })
    }
  }

  for (const [id, operation] of walPendingOperations.entries()) {
    enqueueReplayedOperation(id, operation)
  }
}

function compactWal(): void {
  if (!walPath) return
  flushWalBuffer()
  try {
    const tmpPath = `${walPath}.tmp`
    const records = [...walPendingOperations.entries()].map(([id, operation]) =>
      JSON.stringify({
        schemaVersion: '2026-05-24.storage-bridge-wal.v1',
        recordType: 'op',
        id,
        timestamp: new Date().toISOString(),
        operation,
      } satisfies WalRecord),
    )
    writeFileSync(tmpPath, records.length > 0 ? `${records.join('\n')}\n` : '', 'utf8')
    if (walOptions.fsync) {
      const fd = openSync(tmpPath, 'r')
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    }
    renameSync(tmpPath, walPath)
    if (walOptions.fsync) {
      const dirFd = openSync(dirname(walPath), 'r')
      try {
        fsyncSync(dirFd)
      } finally {
        closeSync(dirFd)
      }
    }
  } catch (error) {
    stats.lastError = error instanceof Error ? error.message : String(error)
    logger.error('Failed to compact storage bridge WAL', {
      walPath,
      error,
    })
  }
}

function normalizeWalOptions(
  options: StorageBridgeWalOptions = {},
): Required<StorageBridgeWalOptions> {
  return {
    batchSize: normalizePositiveInt(options.batchSize, 1),
    flushIntervalMs: normalizeNonNegativeInt(options.flushIntervalMs, 0),
    fsync: options.fsync ?? false,
  }
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value > 0 ? value : fallback
}

function normalizeNonNegativeInt(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value >= 0 ? value : fallback
}

function updateNextOperationId(id: string): void {
  const match = /^persist-(\d+)$/.exec(id)
  if (!match) return
  const numericId = Number(match[1])
  if (Number.isInteger(numericId)) {
    nextOperationId = Math.max(nextOperationId, numericId)
  }
}
