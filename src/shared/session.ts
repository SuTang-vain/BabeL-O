import type { NexusEvent } from './events.js'

export type SessionPhase =
  | 'created'
  | 'planning'
  | 'executing'
  | 'reviewing'
  | 'waiting_user'
  | 'waiting_permission'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type TaskSessionTerminalReason = {
  category:
    | 'error'
    | 'timeout'
    | 'cancelled'
    | 'provider'
    | 'runtime'
    | 'unknown'
  code: string
  message: string
}

export type TaskSessionInputRequest = {
  reason?: string
  prompt?: string
  requestedBy?: 'planner' | 'executor' | 'critic' | 'system'
  metadata?: Record<string, unknown>
}

export type TaskSessionUserInput = {
  message: string
  submittedAt: string
  metadata?: Record<string, unknown>
}

export type SessionSnapshot = {
  sessionId: string
  cwd: string
  prompt: string
  phase: SessionPhase
  createdAt: string
  updatedAt: string
  events: NexusEvent[]
  result?: string
  error?: string
  lastUserInput?: string

  // Agent Loop & Task Session extensions
  queueId?: string
  parentSessionId?: string
  assignedAgentId?: string
  currentTaskId?: string
  failureReason?: string
  terminalReason?: TaskSessionTerminalReason
  pendingInput?: TaskSessionInputRequest
}

export type PermissionResolution = { approved: boolean; reason?: string }

export class PendingPermissionRegistry {
  private static instance: PendingPermissionRegistry
  private readonly pending = new Map<string, (res: PermissionResolution) => void>()

  static getInstance(): PendingPermissionRegistry {
    if (!PendingPermissionRegistry.instance) {
      PendingPermissionRegistry.instance = new PendingPermissionRegistry()
    }
    return PendingPermissionRegistry.instance
  }

  register(sessionId: string, toolUseId: string): Promise<PermissionResolution> {
    const key = `${sessionId}:${toolUseId}`
    return new Promise((resolve) => {
      this.pending.set(key, resolve)
    })
  }

  resolve(sessionId: string, toolUseId: string, resolution: PermissionResolution): boolean {
    const key = `${sessionId}:${toolUseId}`
    const resolver = this.pending.get(key)
    if (resolver) {
      resolver(resolution)
      this.pending.delete(key)
      return true
    }
    return false
  }

  resolveSession(sessionId: string, resolution: PermissionResolution): boolean {
    let resolvedAny = false
    for (const [key, resolver] of this.pending.entries()) {
      if (key.startsWith(`${sessionId}:`)) {
        resolver(resolution)
        this.pending.delete(key)
        resolvedAny = true
      }
    }
    return resolvedAny
  }
}
