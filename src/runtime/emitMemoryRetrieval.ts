/**
 * Phase 3B-9 slice — `emitMemoryRetrieval.ts`
 *
 * Extracted from `src/runtime/LLMCodingRuntime.ts`. Contains the
 * standalone function `emitMemoryRetrieval()` which is the
 * hot-path emitter for the §3.5 Memory Quality Metrics v1.1
 * `memory_retrieval` NexusEvent.
 *
 * Why extracted:
 *
 * - The helper is **a fire-and-forget side effect**: it walks
 *   one `MemoryProviderDiagnostics` snapshot, builds a
 *   `memory_retrieval` NexusEvent, calls
 *   `NexusStorage.appendEvent`, and never throws into the
 *   hot path. Keeping it as a class field on LLMCodingRuntime
 *   made it impossible to unit-test in isolation (every test
 *   had to instantiate a full runtime with a real storage).
 * - The helper is the §3.5 metrics emission counterpart of
 *   `loadWorkingSetOverride` / `applyWorkingSetUpdate` —
 *   three independent "write to storage" surfaces that
 *   each have their own structured event shape. Future
 *   observability work may want to call them from a CLI
 *   debug command without spinning up a full Nexus runtime;
 *   having them as standalone functions removes the
 *   runtime-loop dependency for those callers.
 *
 * Goals:
 *
 * - Preserve exact behavior parity: every `memory_retrieval`
 *   event is written to storage when `memoryProvider` is
 *   truthy; when `memoryProvider` is undefined the function
 *   is a no-op so legacy / test-only paths don't fail.
 * - Make the helper testable in isolation by passing
 *   dependencies (the memory-provider + the storage) as
 *   explicit arguments.
 * - Eliminate ~40 lines of class-field code from
 *   `LLMCodingRuntime.ts`.
 *
 * Non-goals:
 *
 * - Do not await the storage write — the hot path must not
 *   block on persistence (per
 *   `feedback-babel-o-soft-recoverable-timeouts`). The
 *   storage layer schedules its own flush; the caller of
 *   this function treats the `appendEvent` Promise as
 *   fire-and-forget.
 * - Do not change the `memory_retrieval` event shape or
 *   schema — that contract is owned by `shared/events.ts`
 *   and consumed by the §3.5 dashboard.
 * - Do not change the conditional-field policy
 *   (`...(d.namespaceId && { namespaceId: d.namespaceId })`)
 *   that omits undefined diagnostics fields from the
 *   emitted event.
 */

import { eventBase, type NexusEvent } from '../shared/events.js'
import type { MemoryProvider } from './memoryProvider.js'
import type { MemoryProviderDiagnostics } from './memoryProvider.js'
import type { NexusStorage } from '../storage/Storage.js'

export type EmitMemoryRetrievalInput = {
  sessionId: string
  cwd: string
  prompt: string
  diagnostics: MemoryProviderDiagnostics
}

/**
 * Build and append a `memory_retrieval` NexusEvent for the
 * given diagnostics snapshot.
 *
 * Fire-and-forget: any throw from `storage.appendEvent` is
 * caught and reported on `process.stderr` so the hot path
 * stays unaffected. The dashboard degrades to "fewer events"
 * rather than 5xx when storage is degraded. This is
 * consistent with the v1 contract that §3.5 metrics are a
 * recent-window dashboard signal, not a durability-critical
 * audit.
 *
 * No-op when `memoryProvider` is undefined so legacy /
 * test-only paths (e.g. LocalCodingRuntime variants without
 * a memory provider, or in-memory test mode) do not pay the
 * cost of constructing an event they would never store.
 */
export async function emitMemoryRetrieval(
  memoryProvider: MemoryProvider | undefined,
  storage: NexusStorage,
  input: EmitMemoryRetrievalInput,
): Promise<void> {
  if (!memoryProvider) return
  const d = input.diagnostics
  const autoSearch = d.autoSearch
  const event: NexusEvent = {
    ...eventBase(input.sessionId),
    type: 'memory_retrieval',
    provider: d.provider,
    enabled: d.enabled,
    scope: d.scope,
    ...(d.namespaceId && { namespaceId: d.namespaceId }),
    ...(d.namespaceSource && { namespaceSource: d.namespaceSource }),
    ...(d.isolationKey && { isolationKey: d.isolationKey }),
    autoSearchTriggered: autoSearch?.triggered ?? false,
    autoSearchReason: autoSearch?.reason ?? 'no_memory_cue',
    ...(autoSearch?.cue && { autoSearchCue: autoSearch.cue }),
    hitCount: d.hitCount,
    injectedChars: d.injectedChars,
    budgetChars: d.budgetChars,
    maxHitChars: d.maxHitChars,
    truncated: d.truncated,
    ...(d.searchLatencyMs !== undefined && { searchLatencyMs: d.searchLatencyMs }),
    ...(d.error && { error: d.error }),
    prompt: input.prompt,
    cwd: input.cwd,
  }
  try {
    await storage.appendEvent(input.sessionId, event)
  } catch (error) {
    // never break the hot path on a metrics write failure
    process.stderr.write(
      `[LLMCodingRuntime] memory_retrieval event append failed: ${error instanceof Error ? error.message : String(error)}\n`,
    )
  }
}
