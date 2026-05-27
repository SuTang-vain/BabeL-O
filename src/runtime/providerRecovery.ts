import { ProviderError } from '../shared/errors.js'

export type ProviderRecoveryKind =
  | 'max_output_tokens'
  | 'context_window'
  | 'rate_limit'
  | 'auth_or_billing'
  | 'provider_unavailable'
  | 'unknown'

export type ProviderRecoveryDetails = {
  providerId?: string
  httpStatus?: number
  kind: ProviderRecoveryKind
  recoveryReason: string
  retryable: boolean
  suggestion: string
  rawMessage?: string
}

export function classifyProviderRecovery(error: unknown): ProviderRecoveryDetails | undefined {
  if (!(error instanceof ProviderError)) return undefined

  const rawMessage = error.rawMessage
  const normalized = rawMessage.toLowerCase()
  const status = error.httpStatus

  if (matchesAny(normalized, [
    'max_output_tokens',
    'max_tokens',
    'max output',
    'output tokens',
    'finish_reason":"length',
    'stop_reason":"max_tokens',
  ])) {
    return {
      providerId: error.providerId,
      httpStatus: status,
      kind: 'max_output_tokens',
      recoveryReason: 'ESCALATED_MAX_TOKENS',
      retryable: true,
      suggestion: 'Retry with a smaller requested output, ask the model to summarize, or route this role to a model with a larger output budget.',
      rawMessage,
    }
  }

  if (matchesAny(normalized, [
    'context_length_exceeded',
    'prompt_too_long',
    'context window',
    'maximum context',
    'input tokens',
    'token limit',
    'too many tokens',
  ])) {
    return {
      providerId: error.providerId,
      httpStatus: status,
      kind: 'context_window',
      recoveryReason: 'ESCALATED_CONTEXT_WINDOW',
      retryable: true,
      suggestion: 'Run /compact or retry with a smaller context window; fallback routing can use a larger-context model.',
      rawMessage,
    }
  }

  if (status === 429 || matchesAny(normalized, ['rate limit', 'too many requests'])) {
    return {
      providerId: error.providerId,
      httpStatus: status,
      kind: 'rate_limit',
      recoveryReason: 'RETRY_PROVIDER_RATE_LIMIT',
      retryable: true,
      suggestion: 'Retry after provider backoff or switch to another configured provider.',
      rawMessage,
    }
  }

  if ([401, 402, 403].includes(status) || matchesAny(normalized, [
    'insufficient balance',
    'quota',
    'billing',
    'unauthorized',
    'forbidden',
    'invalid api key',
  ])) {
    return {
      providerId: error.providerId,
      httpStatus: status,
      kind: 'auth_or_billing',
      recoveryReason: 'PROVIDER_AUTH_OR_BILLING',
      retryable: false,
      suggestion: 'Check API key, billing balance, provider permissions, or switch the active model/profile.',
      rawMessage,
    }
  }

  if (status >= 500) {
    return {
      providerId: error.providerId,
      httpStatus: status,
      kind: 'provider_unavailable',
      recoveryReason: 'RETRY_PROVIDER_UNAVAILABLE',
      retryable: true,
      suggestion: 'Retry after transient provider failure or switch provider.',
      rawMessage,
    }
  }

  return {
    providerId: error.providerId,
    httpStatus: status,
    kind: 'unknown',
    recoveryReason: 'PROVIDER_ERROR_UNCLASSIFIED',
    retryable: false,
    suggestion: 'Inspect provider rawMessage and request payload.',
    rawMessage,
  }
}

function matchesAny(value: string, needles: string[]): boolean {
  return needles.some(needle => value.includes(needle))
}
