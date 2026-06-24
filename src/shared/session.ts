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
  /**
   * Reaped on startup by the orphan reaper (Phase 2 of
   * `docs/nexus/proposals/daemon-graceful-shutdown-and-orphan-reaper-plan.md`).
   * A session that was left in an in-flight phase (e.g. `executing`,
   * `reviewing`, `waiting_user`, `waiting_permission`) by a crashed
   * daemon is transitioned to `interrupted` so reconnecting clients
   * see a clean terminal state instead of a frozen in-flight badge.
   * Treated as terminal by all TERMINAL_SESSION_PHASES / TERMINAL_PHASES
   * sets — `interrupted` is *not* `failed` because the session was
   * recoverable, not errored.
   */
  | 'interrupted'

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
  kind?: 'planner_review' | 'user_input'
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

  // Bug 2 (context-cwd-drift plan §13.4): the cwd the session was created
  // under (launcher `body.cwd` / Nexus defaultCwd), written ONCE at session
  // creation and never overwritten by per-turn `session.cwd` mutations.
  // Phase B continuity uses this as the immutable reference root so that
  // `deriveSessionRootContinuity` can pull a drifted requestCwd back to the
  // project root even when `session.cwd` itself has already drifted (the
  // session_10320709 failure: turns 2-6 stayed on ~/Library because
  // session.cwd carried the drift forward). Optional for back-compat with
  // sessions created before this column existed.
  originCwd?: string

  // Agent Loop & Task Session extensions
  queueId?: string
  parentSessionId?: string
  assignedAgentId?: string
  currentTaskId?: string
  failureReason?: string
  terminalReason?: TaskSessionTerminalReason
  pendingInput?: TaskSessionInputRequest
  allowedPaths?: string[]
  metadata?: Record<string, unknown>
}

export type PermissionResolution = {
  approved: boolean
  reason?: string
  /**
   * Scope of the decision (Phase A.1 of the enhanced permission
   * panel). Defaults to 'once' for back-compat. When set to
   * 'session', `rule` must be present and the runtime
   * accumulates it under the session for the remainder of
   * that session's turns.
   */
  scope?: 'once' | 'session' | 'rule'
  /**
   * Allow rule for `scope: 'session' | 'rule'`; ignored for
   * `scope: 'once'`.
   */
  rule?: string
  /**
   * Free-form user feedback text the model should act on
   * (typically paired with `approved: false` for the
   * "Reject, tell the model what to do instead" path).
   */
  feedback?: string
}

export type PendingPermissionEntry = {
  sessionId: string
  toolUseId: string
  resolve: (res: PermissionResolution) => void
  expiresAt: number
}

export interface PendingPermissionBackend {
  register(entry: PendingPermissionEntry): void
  resolve(sessionId: string, toolUseId: string, resolution: PermissionResolution): boolean
  resolveSession(sessionId: string, resolution: PermissionResolution): boolean
  sweepExpired(nowMs: number): number
  pendingCount(): number
  reset(resolution: PermissionResolution): void
}

export class InMemoryPendingPermissionBackend implements PendingPermissionBackend {
  private readonly pending = new Map<string, PendingPermissionEntry>()

  register(entry: PendingPermissionEntry): void {
    this.pending.set(pendingPermissionKey(entry.sessionId, entry.toolUseId), entry)
  }

  resolve(sessionId: string, toolUseId: string, resolution: PermissionResolution): boolean {
    const key = pendingPermissionKey(sessionId, toolUseId)
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
      if (entry.sessionId === sessionId) {
        entry.resolve(resolution)
        this.pending.delete(key)
        resolvedAny = true
      }
    }
    return resolvedAny
  }

  sweepExpired(nowMs: number): number {
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

  reset(resolution: PermissionResolution): void {
    for (const entry of this.pending.values()) {
      entry.resolve(resolution)
    }
    this.pending.clear()
  }
}

export class PendingPermissionRegistry {
  private static instance: PendingPermissionRegistry
  private backend: PendingPermissionBackend = new InMemoryPendingPermissionBackend()
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
    return new Promise((resolve) => {
      this.backend.register({
        sessionId,
        toolUseId,
        resolve,
        expiresAt: Date.now() + this.ttlMs,
      })
    })
  }

  resolve(sessionId: string, toolUseId: string, resolution: PermissionResolution): boolean {
    return this.backend.resolve(sessionId, toolUseId, resolution)
  }

  resolveSession(sessionId: string, resolution: PermissionResolution): boolean {
    return this.backend.resolveSession(sessionId, resolution)
  }

  sweepExpired(nowMs = Date.now()): number {
    return this.backend.sweepExpired(nowMs)
  }

  pendingCount(): number {
    return this.backend.pendingCount()
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

  setBackend(backend: PendingPermissionBackend): void {
    this.backend.reset({
      approved: false,
      reason: 'Permission backend replaced',
    })
    this.backend = backend
  }

  resetForTest(): void {
    this.backend.reset({
      approved: false,
      reason: 'Permission registry reset',
    })
    this.backend = new InMemoryPendingPermissionBackend()
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

function pendingPermissionKey(sessionId: string, toolUseId: string): string {
  return `${sessionId}:${toolUseId}`
}

/**
 * Phase 3 / §3 goal 5 of
 * `docs/nexus/proposals/go-tui-session-observability-governance-plan.md`:
 * detect a Go TUI client-side placeholder session id
 * (`session_go_<unixnano>`, e.g. `session_go_1781146359507755000`).
 *
 * The server persists sessions under a canonical `session_<uuid>`;
 * the Go TUI's local placeholder is only carried as
 * `metadata.clientSessionId` for cross-reference. When an operator
 * queries `/v1/sessions/<placeholder>` directly, the 404 response
 * uses {@link goTuiClientSessionPersistenceHint} to explain *why*
 * the id is missing and what to do next, instead of the generic
 * `SESSION_NOT_FOUND`.
 */
const GO_TUI_CLIENT_SESSION_ID_PATTERN = /^session_go_\d{15,}$/

export function isGoTuiClientSessionId(sessionId: string): boolean {
  return GO_TUI_CLIENT_SESSION_ID_PATTERN.test(sessionId)
}

/**
 * Redacted persistence hint for a Go TUI client placeholder session
 * id that the server does not persist under directly. The hint is
 * deliberately non-revealing (no other sessions, no storage path)
 * and points the operator at the two real reverse-resolve paths:
 *   - `bbl inspect-session <placeholder>` (tier (b) client-log scan)
 *   - `bbl inspect-session <server uuid>` (tier (a) sqlite row,
 *     which also surfaces `metadata.clientSessionId`)
 *
 * It also flags the most common root cause (embedded Nexus ran on
 * memory storage and the session was never written to disk), which
 * is the exact failure mode of the real sample
 * `session_go_1781146359507755000`.
 */
export function goTuiClientSessionPersistenceHint(sessionId: string): string {
  return (
    `Session ${sessionId} looks like a Go TUI client placeholder ` +
    `(session_go_<unixnano>); the server persists sessions under a canonical ` +
    `session_<uuid> and carries this id only as metadata.clientSessionId. ` +
    `This 404 usually means the session ran on an embedded Nexus that used ` +
    `memory storage and was never written to disk. Run ` +
    `'bbl inspect-session ${sessionId}' to reverse-resolve via the client log, ` +
    `or 'bbl inspect-session <server uuid>' to read the sqlite row directly.`
  )
}
