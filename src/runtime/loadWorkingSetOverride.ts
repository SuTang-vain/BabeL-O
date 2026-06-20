/**
 * Phase 3B-7 slice — `loadWorkingSetOverride.ts`
 *
 * Extracted from `src/runtime/LLMCodingRuntime.ts` (the 1525-line god
 * class after Phases 3B-1 + 3B-6). Contains the standalone function
 * `loadWorkingSetOverride()` which derives the provider-visible
 * `workingSetOverride` string for the current turn.
 *
 * Why extracted:
 *
 * - The helper is **a pure function** of `(tracker, storage, sessionId,
 *   cwd)` with no `this.*` reference. Keeping it as a private method
 *   on the 1525-line `LLMCodingRuntime` class made it impossible to
 *   unit-test without instantiating the full runtime (and a real
 *   provider mock).
 * - The helper is **R2 of docs/nexus/proposals/long-running-context-assembly.md
 *   §20** — it is the load-side of the "Persisted Working Set接入
 *   executeStream hot path" work. Future R5/R7 work may want to call
 *   it from the CLI resume preview path or from a debugging tool;
 *   having it as a standalone function removes the runtime-loop
 *   dependency for those callers.
 *
 * Goals:
 *
 * - Preserve exact behavior parity with the original private method:
 *   - when `tracker` is undefined → return `undefined`
 *   - when tracker has a session entry → format it
 *   - when tracker has no session entry → rebuild from event tail
 *   - when rebuild also yields nothing → return `undefined`
 *   - on storage failure → return `undefined` (best-effort)
 * - Make the helper testable in isolation by passing dependencies as
 *   explicit arguments.
 * - Eliminate ~37 lines of private-method code from
 *   `LLMCodingRuntime.ts`.
 *
 * Non-goals:
 *
 * - Do not move `applyWorkingSetUpdate` (the write-side counterpart)
 *   in this slice — that one is more tightly coupled to the runtime
 *   loop's `events` array and `this` context.
 * - Do not change the rebuild tail size (200 events) — it is part of
 *   the R2 spec.
 * - Do not change the `WorkingSetEntry` shape mapping (touches=1,
 *   lastTurn=0, isDir=false, source='tool') — that is the legacy
 *   derive-path shape contract.
 */

import type { NexusStorage } from '../storage/Storage.js'
import { formatWorkingSet } from './workingSet.js'
import type { PersistedWorkingSetTracker } from './persistedWorkingSetTracker.js'
import { deriveEntriesFromEvents } from './workingSetTracker.js'

/**
 * Load the provider-visible `workingSetOverride` string for the current
 * turn. Called once at the start of `runExecuteStreamInner` and
 * threaded into every `refreshRuntimeContextState` call.
 *
 * Behaviour:
 *
 * - When `tracker` is undefined (legacy / test-only path with no
 *   `resumeDeps`): return `undefined` so the assembler falls back to
 *   its transient derive.
 * - When `tracker.get(sessionId)` returns a working set: format it
 *   via `formatWorkingSet` (mapping the tracker entry shape into the
 *   legacy derive-path shape).
 * - When `tracker.get(sessionId)` returns nothing: rebuild from the
 *   recent event tail via `deriveEntriesFromEvents` (R2 spec). This
 *   catches the "session just started, persisted file is empty" case.
 * - When rebuild also yields no entries: return `undefined`.
 * - On storage failure during rebuild: return `undefined` (best-effort,
 *   never throw into the runtime loop).
 *
 * The load is idempotent: `createRuntime` pre-loads the file once at
 * boot, so the tracker is already populated for the cwd. The `cwd`
 * parameter is passed for the rebuild path (event-tail derivation
 * uses cwd to filter out-of-scope tool paths).
 */
export async function loadWorkingSetOverride(
  tracker: PersistedWorkingSetTracker | undefined,
  storage: NexusStorage | undefined,
  sessionId: string,
  cwd: string,
): Promise<string | undefined> {
  if (!tracker) return undefined
  let workingSet = tracker.get(sessionId)
  if (!workingSet) {
    // R2 spec: if absent, rebuild from the recent event tail via
    // deriveEntriesFromEvents. Read a bounded tail (200 events) from
    // storage; this is best-effort — if storage fails, we return
    // undefined and the assembler falls back to its transient derive.
    if (!storage) return undefined
    try {
      const result = await storage.listEvents(sessionId, { limit: 200, order: 'desc' })
      const entries = deriveEntriesFromEvents([...result.events].reverse(), cwd)
      if (entries.length > 0) {
        workingSet = tracker.rebuild(sessionId, '', entries)
      }
    } catch {
      return undefined
    }
  }
  if (!workingSet) return undefined
  // Convert tracker entries (runtime/workingSetTracker.ts shape) to the
  // formatWorkingSet input shape (runtime/workingSet.ts shape) so the
  // provider-visible Working Set: block matches the legacy derive path.
  // The two WorkingSetEntry types share the path/updatedAt fields; the
  // runtime type adds touches/lastTurn/isDir/source. We map with safe
  // defaults for the new fields — touches=1 (one observation from the
  // tracker), lastTurn=0, isDir=false (we don't know without stat),
  // source='tool' (the entry came from a tool_started event).
  const entries = workingSet.entries.map((e) => ({
    path: e.value,
    touches: 1,
    lastTurn: 0,
    isDir: false,
    source: 'tool' as const,
  }))
  return formatWorkingSet(entries)
}
