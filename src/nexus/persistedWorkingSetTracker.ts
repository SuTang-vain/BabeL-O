// src/nexus/persistedWorkingSetTracker.ts
//
// PR-4b (Track A Phase 1 persistence, see docs/nexus/reference/long-running-
// context-assembly.md §5.1): PersistedWorkingSetTracker extends the
// in-memory WorkingSetTracker with file-backed persistence.
//
// Storage: <cwd>/.babel-o/working-set.json
// Format: { "<sessionId>": WorkingSet, ... }
// Write strategy: synchronous flush on update (file is tiny, ~100B per
//                  session, no debounce complexity)
// Load strategy: eager on construction
// Atomic write: writeFile + rename (POSIX rename is atomic)
//
// Invariants respected:
//   - INV-L1: working set never compressed
//   - INV-L2: session died, state didn't (this is what persistence buys us)
//   - test-config-isolation: cwd is explicit; HOME is never read
//
// Out of scope (later PRs):
//   - cross-workspace aggregation
//   - event bus broadcast
//   - LRU/TTL
//   - multi-process concurrency

import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  WorkingSetTracker,
  type WorkingSet,
  type WorkingSetEntry,
  type WorkingSetPatch,
} from './workingSetTracker.js'
import { logger } from '../shared/logger.js'

export const WORKING_SET_RELATIVE_PATH = '.babel-o/working-set.json'

export type PersistedWorkingSetFile = {
  schemaVersion: '2026-06-16.working-set.v1'
  sessions: Record<string, WorkingSet>
}

export class PersistedWorkingSetTracker extends WorkingSetTracker {
  private readonly filePath: string
  private dirty = false
  private flushScheduled = false
  private flushChain: Promise<void> = Promise.resolve()

  constructor(cwd: string) {
    super()
    if (!cwd || typeof cwd !== 'string') {
      throw new Error('PersistedWorkingSetTracker requires a non-empty cwd')
    }
    this.filePath = resolve(cwd, WORKING_SET_RELATIVE_PATH)
  }

  // Eager load on construction. Best-effort: missing/corrupt file → empty start.
  // We do not call super.get() here to keep load() pure I/O; the in-memory
  // map is populated by direct write into the parent.
  async load(): Promise<void> {
    if (!existsSync(this.filePath)) {
      return
    }
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<PersistedWorkingSetFile>
      const sessions = parsed?.sessions ?? {}
      for (const [sessionId, ws] of Object.entries(sessions)) {
        if (ws && typeof ws === 'object' && Array.isArray(ws.entries)) {
          this.hydrate(sessionId, ws)
        }
      }
    } catch (error) {
      logger.debug('PersistedWorkingSetTracker load failed; starting empty', error)
    }
  }

  // Override update to mark dirty + schedule flush. We intentionally do
  // NOT await flush in update() (per [[babel-o-soft-recoverable-timeouts]],
  // persistence must not block the caller; eventual consistency OK).
  update(sessionId: string, patch: WorkingSetPatch): WorkingSet {
    const ws = super.update(sessionId, patch)
    this.dirty = true
    this.scheduleFlush()
    return ws
  }

  // Override reset to mark dirty (file may need to drop the session).
  override reset(sessionId: string): void {
    super.reset(sessionId)
    this.dirty = true
    this.scheduleFlush()
  }

  // Force an immediate, awaited flush. Useful for tests and on session-end.
  // Routes through the same flushChain used by scheduleFlush to serialize
  // concurrent flushes and avoid ENOENT from overlapping .tmp writes.
  async flush(): Promise<void> {
    // Ensure a flush is queued (so update-since-last-flush is captured),
    // then await the chain to complete.
    if (this.dirty && !this.flushScheduled) {
      this.scheduleFlush()
    }
    await this.flushChain
  }

  get fileLocation(): string {
    return this.filePath
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return
    this.flushScheduled = true
    // Chain off the previous flush to serialize writes; do not await here.
    this.flushChain = this.flushChain
      .then(async () => {
        this.flushScheduled = false
        if (!this.dirty) return
        const snapshot = this.snapshot()
        const dir = dirname(this.filePath)
        await mkdir(dir, { recursive: true })
        const tmpPath = `${this.filePath}.tmp`
        const payload: PersistedWorkingSetFile = {
          schemaVersion: '2026-06-16.working-set.v1',
          sessions: snapshot,
        }
        await writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf8')
        await rename(tmpPath, this.filePath)
        this.dirty = false
      })
      .catch(error => {
        this.flushScheduled = false
        logger.debug('PersistedWorkingSetTracker background flush failed', error)
      })
  }

  private snapshot(): Record<string, WorkingSet> {
    const out: Record<string, WorkingSet> = {}
    for (const [sessionId, ws] of this.entries()) {
      out[sessionId] = ws
    }
    return out
  }

  // Direct map injection (load path). Avoids re-deriving through update.
  private hydrate(sessionId: string, ws: WorkingSet): void {
    super.update(sessionId, { workspaceId: ws.workspaceId, entries: ws.entries })
  }
}
