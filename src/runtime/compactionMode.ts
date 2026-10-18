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

export type CompactionTier = 'noop' | 't1' | 't2' | 't3'

export type CompactionModeDecision = AutoCompactDecision & {
  reason: string
  tier?: CompactionTier
  payback?: number
  nStar?: number
  dHat?: number
  sHat?: number
  kHat?: number
  nHat?: number
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
  tier?: CompactionTier
  payback?: number
  nStar?: number
  dHat?: number
  sHat?: number
  kHat?: number
  nHat?: number
}

export type CompactionPolicyInput = {
  tokenEstimate: number
  maxTokens: number
  fuseOpen?: boolean
  failureCount?: number
  nHat?: number
  dHat?: number
  sHat?: number
  kHat?: number
  cacheRatio?: number
  compactionsThisTurn?: number
  callsSinceLastCompact?: number
  lastPostTokens?: number
  lastD?: number
  forcedPercent?: number
  minPayback?: number
}

export type CompactionPolicyDecision = {
  shouldCompact: boolean
  tier: CompactionTier
  reason: string
  percentUsed: number
  nHat: number
  dHat: number
  sHat: number
  kHat: number
  nStar: number
  payback: number
}

const DEFAULT_SUMMARY_TOKENS = 12_000
const DEFAULT_K_HAT = 0.5
const DEFAULT_N_HAT = 3
const DEFAULT_FORCED_PERCENT = 92
const DEFAULT_MIN_PAYBACK = 1.25
const CACHE_PRICE_RATIO = 0.02

export function evaluateCompactionPolicy(
  input: CompactionPolicyInput,
): CompactionPolicyDecision {
  const maxTokens = Math.max(1, input.maxTokens)
  const percentUsed = (input.tokenEstimate / maxTokens) * 100
  const forcedPercent = input.forcedPercent ?? DEFAULT_FORCED_PERCENT
  const nHat = Math.max(1, input.nHat ?? DEFAULT_N_HAT)
  const dHat = Math.max(
    1,
    input.dHat ?? Math.max(4_000, Math.min(8_000, Math.floor(input.tokenEstimate * 0.15))),
  )
  const sHat = Math.max(1, input.sHat ?? DEFAULT_SUMMARY_TOKENS)
  const kHat = Math.max(0, input.kHat ?? DEFAULT_K_HAT)
  const cacheRatio = Math.max(0, Math.min(1, input.cacheRatio ?? 0))
  const nStar = (sHat + kHat * input.tokenEstimate) / dHat
  const payback = nHat * dHat * ((1 - cacheRatio) + cacheRatio * CACHE_PRICE_RATIO)

  if (input.fuseOpen) {
    return { shouldCompact: false, tier: 'noop', reason: 'fuse-open', percentUsed, nHat, dHat, sHat, kHat, nStar, payback }
  }
  if ((input.compactionsThisTurn ?? 0) >= 1) {
    return { shouldCompact: false, tier: 'noop', reason: 'churn-turn', percentUsed, nHat, dHat, sHat, kHat, nStar, payback }
  }
  if ((input.callsSinceLastCompact ?? Number.POSITIVE_INFINITY) < 2) {
    return { shouldCompact: false, tier: 'noop', reason: 'churn-calls', percentUsed, nHat, dHat, sHat, kHat, nStar, payback }
  }
  if (input.lastPostTokens !== undefined) {
    const hysteresisTokens = Math.max(0.15 * maxTokens, 2 * (input.lastD ?? dHat))
    if (input.tokenEstimate - input.lastPostTokens < hysteresisTokens) {
      return { shouldCompact: false, tier: 'noop', reason: 'hysteresis', percentUsed, nHat, dHat, sHat, kHat, nStar, payback }
    }
  }

  const forced = percentUsed >= forcedPercent
  if (forced) {
    return {
      shouldCompact: true,
      tier: 't3',
      reason: payback >= sHat + kHat * input.tokenEstimate ? 'forced-payback-positive' : 'forced-payback-negative',
      percentUsed,
      nHat,
      dHat,
      sHat,
      kHat,
      nStar,
      payback,
    }
  }

  if (dHat < Math.max(4_000, 0.05 * maxTokens)) {
    return { shouldCompact: false, tier: 'noop', reason: 'too-small', percentUsed, nHat, dHat, sHat, kHat, nStar, payback }
  }
  const cost = sHat + kHat * input.tokenEstimate + (1 - cacheRatio) * input.tokenEstimate
  if (payback < (input.minPayback ?? DEFAULT_MIN_PAYBACK) * cost) {
    return { shouldCompact: false, tier: 'noop', reason: 'payback', percentUsed, nHat, dHat, sHat, kHat, nStar, payback }
  }
  return { shouldCompact: true, tier: 't3', reason: 'payback', percentUsed, nHat, dHat, sHat, kHat, nStar, payback }
}

/**
 * T1 reversible eviction is independent of the compaction policy. It is off
 * by default so stock behavior is unchanged; the P1 gate runs A/B/C with T1
 * off to isolate admission from eviction.
 */
export function isReversibleEvictionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.BABEL_O_COMPACT_T1 ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
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
    const policy = evaluateCompactionPolicy({
      tokenEstimate: input.tokenEstimate,
      maxTokens: input.maxTokens,
      fuseOpen: input.stock.fuseOpen,
      failureCount: input.stock.failureCount,
    })
    return {
      ...input.stock,
      enabled: true,
      shouldCompact: policy.shouldCompact,
      thresholdPercent: DEFAULT_FORCED_PERCENT,
      reason: policy.reason,
      tier: policy.tier,
      payback: policy.payback,
      nStar: policy.nStar,
      dHat: policy.dHat,
      sHat: policy.sHat,
      kHat: policy.kHat,
      nHat: policy.nHat,
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
