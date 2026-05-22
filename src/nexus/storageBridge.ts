import type { SessionSnapshot } from '../shared/session.js'
import type { NexusTask } from '../shared/task.js'
import type { NexusEvent } from '../shared/events.js'
import type { NexusStorage } from '../storage/Storage.js'

let nexusStorage: NexusStorage | null = null

export function setNexusStorage(storage: NexusStorage | null): void {
  nexusStorage = storage
}

export const setNexusStorageForTest = setNexusStorage

export function getNexusStorageForTest(): NexusStorage | null {
  return nexusStorage
}

export function persistTaskSessionMutation(options: {
  session: SessionSnapshot
  event?: NexusEvent
}): void {
  if (!nexusStorage) return
  nexusStorage.saveSession(options.session).catch(err => {
    console.error('Failed to save session snapshot:', err)
  })
}

export function persistNexusTask(task: NexusTask): void {
  nexusStorage?.saveTask(task).catch(err => {
    console.error('Failed to save task:', err)
  })
}
