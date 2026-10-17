/**
 * Opt-in compaction policy mode + decision ledger.
 *
 * `BABEL_O_COMPACT_MODE`:
 *   - `stock` (default): current behavior, unchanged.
 *   - `noop`: evaluate and log decisions, but never auto/reactive compact.
 *             Useful for the same-ceiling A/B control arm.
 *   - `adaptive`: forced-only until the admission policy lands (P1).
 *             Compacts only when the estimate reaches 92% of the ceiling.
 *
 * `BABEL_O_COMPACT_DECISION_LOG`: when set, append one JSON line per decision.
 * Unset means zero overhead. Manual `/compact` is intentionally not gated by
 * this mode.
 */
import { appendFileSync } from 'node:fs'
import type { AutoCompactDecision } from './compact.js'

export type CompactionMode = 'stock' | 'noop' | 'adaptive'

export type CompactionModeDecision = AutoCompactDecision & {
  reason: string
}

export type CompactionDecisionRecord = {
  sessionId: string
  requestId?: string
  modelId: string
  providerId?: string
  source: 'pre_loop' | 'reactive' | 'manual'
  mode: CompactionMode
  tokenEstimate: number
  maxTokens: number
  percentUsed: number
  warningThresholdTokens?: number
  compactThresholdTokens?: number
  blockingLimitTokens?: number
  enabled: boolean
  shouldCompact: boolean
  thresholdPercent: number
  failureCount: number
  fuseOpen: boolean
  reason: string
}

export function resolveCompactionMode(env: NodeJS.ProcessEnv = process.env): CompactionMode {
  const raw = (env.BABEL_O_COMPACT_MODE ?? '').trim().toLowerCase()
  if (raw === 'noop' || raw === 'off') return 'noop'
  if (raw === 'adaptive') return 'adaptive'
  return 'stock'
}

export function applyCompactionMode(input: {
  mode: CompactionMode
  tokenEstimate: number
  maxTokens: number
  stock: AutoCompactDecision
}): CompactionModeDecision {
  const percentUsed = input.maxTokens > 0
    ? (input.tokenEstimate / input.maxTokens) * 100
    : 0

  if (input.mode === 'noop') {
    return {
      ...input.stock,
      enabled: false,
      shouldCompact: false,
      reason: 'mode-noop',
    }
  }

  if (input.mode === 'adaptive') {
    // P1 admission control replaces this forced-only gate. Until then,
    // `adaptive` is deliberately conservative: act only at the hard
    // pressure point, never proactively.
    const forcedThresholdPercent = 92
    const forced = percentUsed >= forcedThresholdPercent
    return {
      ...input.stock,
      enabled: true,
      shouldCompact: forced && !input.stock.fuseOpen,
      thresholdPercent: forcedThresholdPercent,
      reason: forced ? 'adaptive-forced' : 'adaptive-headroom',
    }
  }

  return {
    ...input.stock,
    reason: input.stock.shouldCompact ? 'stock-threshold' : 'stock-headroom',
  }
}

export function recordCompactionDecision(record: CompactionDecisionRecord): void {
  const path = process.env.BABEL_O_COMPACT_DECISION_LOG
  if (!path) return
  try {
    appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`)
  } catch {
    // Observability must never break the runtime hot path.
  }
}
