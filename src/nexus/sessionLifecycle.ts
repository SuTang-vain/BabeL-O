import { PendingPermissionRegistry, type SessionSnapshot } from '../shared/session.js'
import type { NexusStorage } from '../storage/Storage.js'
import { clearBashSessionState } from '../tools/builtin/bash.js'
import { clearTaskQueue } from './taskQueue.js'
import { clearTaskSession } from './taskSession.js'
import { nowIso } from '../shared/id.js'

export type CloseNexusSessionOptions = {
  storage: NexusStorage
  sessionId: string
  phase?: 'cancelled' | 'completed' | 'failed'
  reason?: string
}

export async function closeNexusSession(
  options: CloseNexusSessionOptions,
): Promise<{ session: SessionSnapshot | null; permissionsResolved: boolean }> {
  const session = await options.storage.getSession(options.sessionId)
  if (session) {
    session.phase = options.phase ?? session.phase
    session.updatedAt = nowIso()
    await options.storage.saveSession(session)
  }

  const permissionsResolved = PendingPermissionRegistry.getInstance().resolveSession(
    options.sessionId,
    {
      approved: false,
      reason: options.reason ?? 'Session closed',
    },
  )
  await clearBashSessionState(options.sessionId)
  clearTaskQueue(options.sessionId)
  clearTaskSession(options.sessionId)

  return {
    session,
    permissionsResolved,
  }
}
