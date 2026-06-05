import type { SystemPromptBlock } from '../providers/adapters/ModelAdapter.js'
import { getModel } from '../providers/registry.js'
import type { NexusEvent } from '../shared/events.js'

export type CacheAwareCompactUsage = {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
}

export type CacheAwareCompactPolicy = {
  modelContextWindow: number
  reservedOutputTokens: number
  providerSafetyBufferTokens: number
  legacyContextCeiling: number
  effectiveContextCeiling: number
  envMaxContextTokens?: number
  policySource: 'legacy' | 'large_context' | 'env_cap'
  warningThresholdPercent: number
  compactThresholdPercent: number
  warningThresholdTokens: number
  compactThresholdTokens: number
  blockingLimitTokens: number
  cachePreservationMode: boolean
  longContextUtilizationMode: boolean
  cacheReadRatio: number
  cacheableSystemPromptRatio: number
  reason: string
}

const DEFAULT_CONTEXT_WINDOW = 8192
const LEGACY_MAX_CONTEXT_TOKENS = 120_000
const DEFAULT_WARNING_PERCENT = 70
const DEFAULT_COMPACT_PERCENT = 90
const CACHE_PRESERVING_WARNING_PERCENT = 80
const CACHE_PRESERVING_COMPACT_PERCENT = 93
const LARGE_CONTEXT_WINDOW_TOKENS = 180_000
const LARGE_CONTEXT_UTILIZATION_RATIO = 0.92
const PROVIDER_SAFETY_BUFFER_PERCENT = 2
const MIN_PROVIDER_SAFETY_BUFFER_TOKENS = 2_000
const DEFAULT_RESERVED_OUTPUT_TOKENS = 4_096

export function buildCacheAwareCompactPolicy(options: {
  modelId: string
  tokenEstimate: number
  usage?: Partial<CacheAwareCompactUsage>
  cacheableSystemPromptRatio?: number
  warningPercent?: number
  compactPercent?: number
  blockingBufferTokens?: number
  maxOutputTokens?: number
  providerContextError?: boolean
}): CacheAwareCompactPolicy {
  const model = getModelDefinition(options.modelId)
  const modelContextWindow = Math.max(1, Math.floor(model.contextWindow))
  const reservedOutputTokens = normalizeReservedOutputTokens(options.maxOutputTokens ?? model.defaultMaxTokens)
  const providerSafetyBufferTokens = Math.max(
    MIN_PROVIDER_SAFETY_BUFFER_TOKENS,
    Math.floor(modelContextWindow * (PROVIDER_SAFETY_BUFFER_PERCENT / 100)),
  )
  const legacyContextCeiling = computeLegacyContextCeiling(modelContextWindow)
  const envMaxTokens = readEnvMaxContextTokens()
  const longContextCeiling = computeLongContextCeiling({
    modelId: options.modelId,
    modelContextWindow,
    reservedOutputTokens,
    providerSafetyBufferTokens,
  })
  const policyCeiling = longContextCeiling ?? legacyContextCeiling
  const envConstrained = envMaxTokens !== undefined && envMaxTokens < policyCeiling
  const effectiveContextCeiling = Math.max(1, Math.min(policyCeiling, envMaxTokens ?? policyCeiling))
  const policySource = envConstrained
    ? 'env_cap'
    : longContextCeiling !== undefined
      ? 'large_context'
      : 'legacy'
  const longContextUtilizationMode = effectiveContextCeiling > legacyContextCeiling
  const usage = normalizeUsage(options.usage)
  const cacheReadRatio = computeCacheReadRatio(usage)
  const cacheableSystemPromptRatio = clampRatio(options.cacheableSystemPromptRatio ?? 0)
  const baseWarningPercent = clampPercent(options.warningPercent ?? DEFAULT_WARNING_PERCENT)
  const baseCompactPercent = clampPercent(options.compactPercent ?? DEFAULT_COMPACT_PERCENT)
  const highCacheReuse = cacheReadRatio >= 0.5 && cacheableSystemPromptRatio >= 0.4
  const nearBlocking = options.tokenEstimate >= computeBlockingLimit({
    maxTokens: effectiveContextCeiling,
    compactPercent: CACHE_PRESERVING_COMPACT_PERCENT,
    blockingBufferTokens: options.blockingBufferTokens,
  })
  const cachePreservationMode = highCacheReuse && !options.providerContextError && !nearBlocking
  const compactThresholdPercent = options.providerContextError
    ? Math.min(baseCompactPercent, 80)
    : cachePreservationMode
      ? Math.max(baseCompactPercent, CACHE_PRESERVING_COMPACT_PERCENT)
      : baseCompactPercent
  const warningThresholdPercent = cachePreservationMode
    ? Math.max(baseWarningPercent, CACHE_PRESERVING_WARNING_PERCENT)
    : baseWarningPercent
  const warningThresholdTokens = Math.floor(effectiveContextCeiling * (warningThresholdPercent / 100))
  const compactThresholdTokens = Math.floor(effectiveContextCeiling * (compactThresholdPercent / 100))
  const blockingLimitTokens = computeBlockingLimit({
    maxTokens: effectiveContextCeiling,
    compactPercent: compactThresholdPercent,
    blockingBufferTokens: options.blockingBufferTokens,
  })

  return {
    modelContextWindow,
    reservedOutputTokens,
    providerSafetyBufferTokens,
    legacyContextCeiling,
    effectiveContextCeiling,
    ...(envMaxTokens !== undefined && { envMaxContextTokens: envMaxTokens }),
    policySource,
    warningThresholdPercent,
    compactThresholdPercent,
    warningThresholdTokens,
    compactThresholdTokens,
    blockingLimitTokens,
    cachePreservationMode,
    longContextUtilizationMode,
    cacheReadRatio,
    cacheableSystemPromptRatio,
    reason: buildPolicyReason({
      envMaxTokens,
      longContextUtilizationMode,
      cachePreservationMode,
      providerContextError: Boolean(options.providerContextError),
      nearBlocking,
      envConstrained,
      effectiveContextCeiling,
      legacyContextCeiling,
    }),
  }
}

export function resolveContextCeilingForModel(modelId: string): number {
  return buildCacheAwareCompactPolicy({ modelId, tokenEstimate: 0 }).effectiveContextCeiling
}

export function summarizeCacheAwareUsage(events: NexusEvent[]): CacheAwareCompactUsage {
  return events.reduce<CacheAwareCompactUsage>((summary, event) => {
    if (event.type !== 'usage') return summary
    summary.inputTokens += event.inputTokens
    summary.outputTokens += event.outputTokens
    summary.cacheCreationInputTokens += event.cacheCreationInputTokens ?? 0
    summary.cacheReadInputTokens += event.cacheReadInputTokens ?? 0
    return summary
  }, {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  })
}

export function computeSystemPromptCacheableRatio(blocks: SystemPromptBlock[] | undefined): number {
  if (!blocks || blocks.length === 0) return 0
  const totalChars = blocks.reduce((sum, block) => sum + block.text.length, 0)
  if (totalChars === 0) return 0
  const cacheableChars = blocks.reduce((sum, block) => sum + (block.cacheable ? block.text.length : 0), 0)
  return clampRatio(cacheableChars / totalChars)
}

function computeLegacyContextCeiling(contextWindow: number): number {
  return Math.min(Math.floor(contextWindow * 0.8), LEGACY_MAX_CONTEXT_TOKENS)
}

function computeLongContextCeiling(options: {
  modelId: string
  modelContextWindow: number
  reservedOutputTokens: number
  providerSafetyBufferTokens: number
}): number | undefined {
  if (!isKnownLargeContextModel(options.modelId, options.modelContextWindow)) return undefined
  const ratioCeiling = Math.floor(options.modelContextWindow * LARGE_CONTEXT_UTILIZATION_RATIO)
  const reserveCeiling = options.modelContextWindow - options.reservedOutputTokens - options.providerSafetyBufferTokens
  return Math.max(1, Math.min(ratioCeiling, reserveCeiling))
}

function isKnownLargeContextModel(modelId: string, contextWindow: number): boolean {
  if (contextWindow < LARGE_CONTEXT_WINDOW_TOKENS) return false
  return modelId.startsWith('anthropic/') || modelId.startsWith('minimax/') || modelId.startsWith('zhipu/')
}

function computeBlockingLimit(options: {
  maxTokens: number
  compactPercent: number
  blockingBufferTokens?: number
}): number {
  const maxTokens = Math.max(1, Math.floor(options.maxTokens))
  const compactThresholdTokens = Math.floor(maxTokens * (clampPercent(options.compactPercent) / 100))
  const blockingBufferTokens = Math.max(0, Math.floor(options.blockingBufferTokens ?? 1_000))
  return Math.max(
    compactThresholdTokens,
    maxTokens - Math.min(blockingBufferTokens, Math.floor(maxTokens * 0.1)),
  )
}

function normalizeUsage(usage: Partial<CacheAwareCompactUsage> | undefined): CacheAwareCompactUsage {
  return {
    inputTokens: normalizeTokenCount(usage?.inputTokens),
    outputTokens: normalizeTokenCount(usage?.outputTokens),
    cacheCreationInputTokens: normalizeTokenCount(usage?.cacheCreationInputTokens),
    cacheReadInputTokens: normalizeTokenCount(usage?.cacheReadInputTokens),
  }
}

function normalizeReservedOutputTokens(value: number | undefined): number {
  return Math.max(1, normalizeTokenCount(value || DEFAULT_RESERVED_OUTPUT_TOKENS))
}

function normalizeTokenCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

function computeCacheReadRatio(usage: CacheAwareCompactUsage): number {
  const denominator = usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens
  if (denominator <= 0) return 0
  return clampRatio(usage.cacheReadInputTokens / denominator)
}

function getModelDefinition(modelId: string): { contextWindow: number; defaultMaxTokens: number } {
  try {
    return getModel(modelId)
  } catch {
    return { contextWindow: DEFAULT_CONTEXT_WINDOW, defaultMaxTokens: DEFAULT_RESERVED_OUTPUT_TOKENS }
  }
}

function readEnvMaxContextTokens(): number | undefined {
  const raw = process.env.BABEL_O_MAX_CONTEXT_TOKENS
  if (!raw) return undefined
  const value = parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

function buildPolicyReason(options: {
  envMaxTokens?: number
  longContextUtilizationMode: boolean
  cachePreservationMode: boolean
  providerContextError: boolean
  nearBlocking: boolean
  envConstrained: boolean
  effectiveContextCeiling: number
  legacyContextCeiling: number
}): string {
  if (options.providerContextError) {
    return 'Provider context error was observed recently; compact threshold is conservative and cache preservation is disabled.'
  }
  if (options.nearBlocking) {
    return 'Context is near the hard blocking limit; safety overrides cache preservation.'
  }
  if (options.envConstrained) {
    return 'Context ceiling is constrained by BABEL_O_MAX_CONTEXT_TOKENS.'
  }
  if (options.cachePreservationMode && options.longContextUtilizationMode) {
    return 'Large-context model and high prompt cache reuse detected; delaying compact to preserve cache while reserving output and provider safety buffer.'
  }
  if (options.cachePreservationMode) {
    return 'High prompt cache reuse detected; delaying compact until closer to the hard blocking limit.'
  }
  if (options.longContextUtilizationMode) {
    return 'Large-context model detected; using adaptive ceiling above the legacy 120k cap while reserving output and provider safety buffer.'
  }
  return 'Using legacy bounded context ceiling and compact thresholds.'
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_COMPACT_PERCENT
  return Math.max(1, Math.min(99, Math.round(value)))
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}
