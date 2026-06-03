import { PendingPermissionRegistry, type SessionPhase, type SessionSnapshot } from '../shared/session.js'
import type { NexusStorage } from '../storage/Storage.js'
import { clearBashSessionState } from '../tools/builtin/bash.js'
import { clearTaskQueue } from './taskQueue.js'
import {
  cancelTaskSession,
  clearTaskSession,
  listTaskSessions,
  updateTaskSession,
} from './taskSession.js'
import { nowIso } from '../shared/id.js'
import type { HooksConfig } from '../shared/config.js'
import { executeRuntimeHooks } from '../runtime/hooks.js'

export type CloseNexusSessionOptions = {
  storage: NexusStorage
  sessionId: string
  phase?: 'cancelled' | 'completed' | 'failed'
  reason?: string
  hooks?: HooksConfig
}

export async function closeNexusSession(
  options: CloseNexusSessionOptions,
): Promise<{ session: SessionSnapshot | null; permissionsResolved: boolean; childSessionsCancelled: string[] }> {
  const session = await options.storage.getSession(options.sessionId)
  const childSessionsCancelled = await cascadeCancelChildTaskSessions(
    options.storage,
    options.sessionId,
    options.reason ?? 'Parent session closed',
  )
  if (session) {
    session.phase = options.phase ?? session.phase
    session.updatedAt = nowIso()
    session.metadata = {
      ...(session.metadata ?? {}),
      ...(childSessionsCancelled.length > 0 ? { childSessionsCancelled } : {}),
    }
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

  const hookResult = await executeRuntimeHooks(
    'SessionEnd',
    {
      cleanup: {
        permissionsResolved,
        phase: options.phase,
        reason: options.reason,
        childSessionsCancelled,
      },
    },
    {
      sessionId: options.sessionId,
      cwd: session?.cwd ?? '',
    },
    { config: options.hooks },
  )
  if (session) {
    for (const event of hookResult.events) {
      session.events.push(event)
      await options.storage.appendEvent(options.sessionId, event)
    }
  }

  return {
    session,
    permissionsResolved,
    childSessionsCancelled,
  }
}

const TERMINAL_PHASES = new Set<SessionPhase>(['completed', 'failed', 'cancelled'])

async function cascadeCancelChildTaskSessions(
  storage: NexusStorage,
  parentSessionId: string,
  reason: string,
): Promise<string[]> {
  const cancelled = new Set<string>()
  for (const child of listTaskSessions()) {
    if (child.parentSessionId !== parentSessionId) continue
    if (TERMINAL_PHASES.has(child.phase)) continue
    const cancelledChild = cancelTaskSession(child.sessionId, reason, 'PARENT_SESSION_CANCELLED')
    updateTaskSession(child.sessionId, {
      metadata: cancelledChildMetadata(cancelledChild, parentSessionId, reason),
    })
    cancelled.add(child.sessionId)
  }

  for (const child of await storage.listChildSessions(parentSessionId, { limit: 200 })) {
    if (TERMINAL_PHASES.has(child.phase)) continue
    child.phase = 'cancelled'
    child.terminalReason = {
      category: 'cancelled',
      code: 'PARENT_SESSION_CANCELLED',
      message: 'Nexus request was cancelled',
    }
    child.updatedAt = nowIso()
    child.metadata = cancelledChildMetadata(child, parentSessionId, reason)
    await storage.saveSession(child)
    cancelled.add(child.sessionId)
  }

  return [...cancelled]
}

function cancelledChildMetadata(
  child: SessionSnapshot,
  parentSessionId: string,
  reason: string,
): Record<string, unknown> {
  return {
    ...(child.metadata ?? {}),
    status: 'cancelled',
    cancelledByParentSessionId: parentSessionId,
    cancelReason: reason,
  }
}
