import { eventBase, type NexusEvent } from '../shared/events.js'
import type { ProviderRecoveryDetails } from './providerRecovery.js'

export type ProviderAutoRetryKind = Extract<ProviderRecoveryDetails['kind'], 'provider_unavailable' | 'rate_limit'>

export type ProviderAutoRetryPolicy = {
  enabled: boolean
  maxRetries: number
  delayMs: number
}

export type ProviderAutoRetryConfigInput = {
  enabled?: boolean
  maxRetries?: number
  delayMs?: number
}

export type ProviderAutoRetryState = {
  count: number
  startedAtMs?: number
}

export const DEFAULT_PROVIDER_AUTO_RETRY_POLICY: ProviderAutoRetryPolicy = {
  enabled: true,
  maxRetries: 10,
  delayMs: 30_000,
}

export function readProviderAutoRetryPolicy(
  env: NodeJS.ProcessEnv = process.env,
  config: ProviderAutoRetryConfigInput = {},
): ProviderAutoRetryPolicy {
  const configured: ProviderAutoRetryPolicy = {
    enabled: config.enabled ?? DEFAULT_PROVIDER_AUTO_RETRY_POLICY.enabled,
    maxRetries: validNonNegativeInt(config.maxRetries) ?? DEFAULT_PROVIDER_AUTO_RETRY_POLICY.maxRetries,
    delayMs: validNonNegativeInt(config.delayMs) ?? DEFAULT_PROVIDER_AUTO_RETRY_POLICY.delayMs,
  }
  const enabled = readBooleanEnv(env.BABEL_O_PROVIDER_AUTO_RETRY_ENABLED, configured.enabled)
  return {
    enabled,
    maxRetries: readNonNegativeIntEnv(env.BABEL_O_PROVIDER_AUTO_RETRY_MAX_RETRIES, configured.maxRetries),
    delayMs: readNonNegativeIntEnv(env.BABEL_O_PROVIDER_AUTO_RETRY_DELAY_MS, configured.delayMs),
  }
}

export function isProviderAutoRetryKind(kind: ProviderRecoveryDetails['kind'] | undefined): kind is ProviderAutoRetryKind {
  return kind === 'provider_unavailable' || kind === 'rate_limit'
}

export function canRetryProviderFailure(options: {
  recovery: ProviderRecoveryDetails | undefined
  policy: ProviderAutoRetryPolicy
  state: ProviderAutoRetryState
}): boolean {
  return options.policy.enabled &&
    options.recovery?.retryable === true &&
    isProviderAutoRetryKind(options.recovery.kind) &&
    options.state.count < options.policy.maxRetries
}

export function buildProviderRetryScheduledEvent(options: {
  sessionId: string
  providerId: string
  modelId: string
  requestId?: string
  originalRequestId?: string
  recoveryKind: ProviderAutoRetryKind
  httpStatus?: number
  attempt: number
  maxRetries: number
  delayMs: number
  nextAttemptAt: string
}): Extract<NexusEvent, { type: 'provider_retry_scheduled' }> {
  return {
    type: 'provider_retry_scheduled',
    ...eventBase(options.sessionId),
    providerId: options.providerId,
    modelId: options.modelId,
    ...(options.requestId ? { requestId: options.requestId } : {}),
    ...(options.originalRequestId ? { originalRequestId: options.originalRequestId } : {}),
    recoveryKind: options.recoveryKind,
    ...(options.httpStatus !== undefined ? { httpStatus: options.httpStatus } : {}),
    attempt: options.attempt,
    maxRetries: options.maxRetries,
    delayMs: options.delayMs,
    nextAttemptAt: options.nextAttemptAt,
    sameProvider: true,
    sameModel: true,
    message: `Provider ${options.providerId}/${options.modelId} unavailable; retry ${options.attempt}/${options.maxRetries} in ${Math.round(options.delayMs / 1000)}s.`,
  }
}

export function buildProviderRetryStartedEvent(options: {
  sessionId: string
  providerId: string
  modelId: string
  recoveryKind: ProviderAutoRetryKind
  attempt: number
  maxRetries: number
}): Extract<NexusEvent, { type: 'provider_retry_started' }> {
  return {
    type: 'provider_retry_started',
    ...eventBase(options.sessionId),
    providerId: options.providerId,
    modelId: options.modelId,
    recoveryKind: options.recoveryKind,
    attempt: options.attempt,
    maxRetries: options.maxRetries,
  }
}

export function buildProviderRetrySucceededEvent(options: {
  sessionId: string
  providerId: string
  modelId: string
  recoveryKind: ProviderAutoRetryKind
  attempt: number
  maxRetries: number
  recoveredAfterMs: number
}): Extract<NexusEvent, { type: 'provider_retry_succeeded' }> {
  return {
    type: 'provider_retry_succeeded',
    ...eventBase(options.sessionId),
    providerId: options.providerId,
    modelId: options.modelId,
    recoveryKind: options.recoveryKind,
    attempt: options.attempt,
    maxRetries: options.maxRetries,
    recoveredAfterMs: options.recoveredAfterMs,
  }
}

export function buildProviderRetryExhaustedEvent(options: {
  sessionId: string
  providerId: string
  modelId: string
  recoveryKind: ProviderAutoRetryKind
  attempts: number
  maxRetries: number
  finalErrorCode: string
}): Extract<NexusEvent, { type: 'provider_retry_exhausted' }> {
  return {
    type: 'provider_retry_exhausted',
    ...eventBase(options.sessionId),
    providerId: options.providerId,
    modelId: options.modelId,
    recoveryKind: options.recoveryKind,
    attempts: options.attempts,
    maxRetries: options.maxRetries,
    finalErrorCode: options.finalErrorCode,
    message: `Provider ${options.providerId}/${options.modelId} retry budget exhausted after ${options.attempts}/${options.maxRetries} attempts.`,
  }
}

export function sleepForProviderRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Provider retry sleep aborted.'))
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timeout)
      reject(signal?.reason ?? new Error('Provider retry sleep aborted.'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function readNonNegativeIntEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function validNonNegativeInt(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value >= 0 ? value : undefined
}

function readBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  const normalized = value.trim().toLowerCase()
  if (normalized === '0' || normalized === 'false' || normalized === 'no') return false
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true
  return fallback
}
