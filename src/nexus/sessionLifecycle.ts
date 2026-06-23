import { executeRuntimeHooks } from '../runtime/hooks.js'
import {
  buildEverCoreMessagesFromSession,
  type EverCoreClient,
} from '../runtime/everCoreClient.js'
import type { HooksConfig } from '../shared/config.js'
import { errorMessage } from '../shared/errors.js'
import { nowIso } from '../shared/id.js'
import { PendingPermissionRegistry, type SessionPhase, type SessionSnapshot } from '../shared/session.js'
import type { NexusStorage } from '../storage/Storage.js'
import { clearBashSessionState } from '../tools/builtin/bash.js'
import type { EverCoreRuntimeConfig } from './everCoreConfig.js'
import { clearTaskQueue } from './taskQueue.js'
import {
  cancelTaskSession,
  clearTaskSession,
  listTaskSessions,
  updateTaskSession,
} from './taskSession.js'

export type CloseNexusSessionOptions = {
  storage: NexusStorage
  sessionId: string
  phase?: 'cancelled' | 'completed' | 'failed'
  reason?: string
  hooks?: HooksConfig
  everCore?: {
    client?: EverCoreClient
    config: EverCoreRuntimeConfig
  }
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
    await syncSessionToEverCore(options.storage, session, options.everCore)
  }

  return {
    session,
    permissionsResolved,
    childSessionsCancelled,
  }
}

async function syncSessionToEverCore(
  storage: NexusStorage,
  session: SessionSnapshot,
  everCore: CloseNexusSessionOptions['everCore'],
): Promise<void> {
  if (!everCore?.client || !everCore.config.uploadOnSessionEnd) return

  const { events } = await storage.listEvents(session.sessionId, {
    limit: 500,
    order: 'asc',
  })
  const messages = buildEverCoreMessagesFromSession({
    session,
    events,
    ...everCore.config,
  })
  if (messages.length === 0) return

  try {
    await everCore.client.addAgentMessages({
      sessionId: session.sessionId,
      appId: everCore.config.appId,
      projectId: everCore.config.projectId,
      messages,
    })
    await everCore.client.flushAgentSession({
      sessionId: session.sessionId,
      appId: everCore.config.appId,
      projectId: everCore.config.projectId,
    })
    await storage.saveSession({
      ...session,
      metadata: {
        ...(session.metadata ?? {}),
        everCoreSync: {
          status: 'flushed',
          messageCount: messages.length,
          syncedAt: nowIso(),
        },
      },
    })
  } catch (error) {
    await storage.saveSession({
      ...session,
      metadata: {
        ...(session.metadata ?? {}),
        everCoreSync: {
          status: 'failed',
          messageCount: messages.length,
          syncedAt: nowIso(),
          error: errorMessage(error),
        },
      },
    })
  }
}

const TERMINAL_PHASES = new Set<SessionPhase>(['completed', 'failed', 'cancelled', 'interrupted'])

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
