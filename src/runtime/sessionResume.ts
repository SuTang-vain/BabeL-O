// src/runtime/sessionResume.ts
//
// PR-28b: Session Resume helper (per long-running-context-assembly.md §6.2).
// Standalone function — NOT a method on LLMCodingRuntime — to avoid
// constructor changes. The doc shows resume() as part of LLMCodingRuntime,
// but adding it there would require passing workingSetTracker +
// contextAssembler + behaviorMonitor into the runtime's constructor, which
// breaks every existing call site. This module is a side-channel
// implementation that callers (PR-29+, future REST POST /sessions/:id/resume)
// can wire up without disturbing the runtime.
//
// ─── DEPRECATION NOTE (PR-A4) ──────────────────────────────────────────────
// This helper is now superseded by the canonical class method
// `LLMCodingRuntime.resume({ sessionId, cwd })` (see
// long-running-context-assembly.md §6.2). The class method completes all
// 3 steps: load-or-rebuild working set, full assembleContext pass with
// include* flags, and live-hint subscription. CLI/REST callers should
// migrate to the class method. This module is kept around for backward
// compatibility with the PR-28b contract; new code MUST use
// `LLMCodingRuntime.resume()` instead.
// ──────────────────────────────────────────────────────────────────────────
//
// Behavior (per doc §6.2):
//   1. Load persisted working set for the session.
//   2. If absent or invalid, rebuild from recent event tail.
//   3. Return both the working set and a flag indicating whether rebuild
//      was needed. Callers (ContextAssembler.assemble, future REST) can
//      then decide what scope to assemble.
//
// Pure read — no state mutation. Caller-side concerns (subscribe to live
// hints, assemble at scope=workspace) are out of scope here.

import type { NexusEvent } from '../shared/events.js'
import type { WorkingSet } from './workingSetTracker.js'
import type { PersistedWorkingSetTracker } from './persistedWorkingSetTracker.js'

export type ResumeSessionOptions = {
  sessionId: string
  cwd: string
  workingSetTracker: PersistedWorkingSetTracker
  /** Optional cap on event tail when rebuilding. Defaults to 100. */
  rebuildEventLimit?: number
}

export type ResumeSessionResult = {
  /** The post-load (or post-rebuild) working set. */
  workingSet: WorkingSet
  /** True when the working set was rebuilt from the event tail (no persisted state). */
  rebuilt: boolean
  /** Event tail used during rebuild (empty if loaded from persistence). */
  rebuildEventTail: NexusEvent[]
  /** Wall-clock latency for the resume load. */
  latencyMs: number
}

export async function resumeSession(options: ResumeSessionOptions): Promise<ResumeSessionResult> {
  const start = Date.now()
  const { sessionId, workingSetTracker } = options

  // Step 1: try to load from persistence.
  let workingSet: WorkingSet | null = workingSetTracker.get(sessionId) ?? null
  let rebuilt = false
  const rebuildEventTail: NexusEvent[] = []

  if (!workingSet) {
    // Step 2: signal rebuild. The caller drives the actual rebuild
    // (load events, derive entries) and then calls workingSetTracker.update.
    rebuilt = true
    workingSet = {
      sessionId,
      workspaceId: '',
      entries: [],
      version: 0,
      updatedAt: new Date(0).toISOString(),
    }
  }

  return {
    workingSet,
    rebuilt,
    rebuildEventTail,
    latencyMs: Date.now() - start,
  }
}
