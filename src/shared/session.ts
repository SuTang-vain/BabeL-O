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

type PendingPermissionEntry = {
  sessionId: string
  toolUseId: string
  resolve: (res: PermissionResolution) => void
  expiresAt: number
}

export class PendingPermissionRegistry {
  private static instance: PendingPermissionRegistry
  private readonly pending = new Map<string, PendingPermissionEntry>()
  private ttlMs = 30 * 60 * 1000
  private timer: ReturnType<typeof setInterval> | null = null

  static getInstance(): PendingPermissionRegistry {
    if (!PendingPermissionRegistry.instance) {
      PendingPermissionRegistry.instance = new PendingPermissionRegistry()
    }
    return PendingPermissionRegistry.instance
  }

  private constructor() {
    this.startSweeper()
  }

  register(sessionId: string, toolUseId: string): Promise<PermissionResolution> {
    const key = `${sessionId}:${toolUseId}`
    return new Promise((resolve) => {
      this.pending.set(key, {
        sessionId,
        toolUseId,
        resolve,
        expiresAt: Date.now() + this.ttlMs,
      })
    })
  }

  resolve(sessionId: string, toolUseId: string, resolution: PermissionResolution): boolean {
    const key = `${sessionId}:${toolUseId}`
    const entry = this.pending.get(key)
    if (entry) {
      entry.resolve(resolution)
      this.pending.delete(key)
      return true
    }
    return false
  }

  resolveSession(sessionId: string, resolution: PermissionResolution): boolean {
    let resolvedAny = false
    for (const [key, entry] of this.pending.entries()) {
      if (key.startsWith(`${sessionId}:`)) {
        entry.resolve(resolution)
        this.pending.delete(key)
        resolvedAny = true
      }
    }
    return resolvedAny
  }

  sweepExpired(nowMs = Date.now()): number {
    let expired = 0
    for (const [key, entry] of this.pending.entries()) {
      if (entry.expiresAt > nowMs) continue
      entry.resolve({
        approved: false,
        reason: 'Permission request timed out',
      })
      this.pending.delete(key)
      expired += 1
    }
    return expired
  }

  pendingCount(): number {
    return this.pending.size
  }

  configureForTest(options: { ttlMs?: number; disableSweeper?: boolean }): void {
    if (options.ttlMs !== undefined) {
      this.ttlMs = options.ttlMs
    }
    if (options.disableSweeper) {
      this.stopSweeper()
    } else {
      this.startSweeper()
    }
  }

  resetForTest(): void {
    for (const entry of this.pending.values()) {
      entry.resolve({
        approved: false,
        reason: 'Permission registry reset',
      })
    }
    this.pending.clear()
    this.ttlMs = 30 * 60 * 1000
    this.startSweeper()
  }

  private startSweeper(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.sweepExpired()
    }, 60 * 1000)
    this.timer.unref?.()
  }

  private stopSweeper(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }
}
