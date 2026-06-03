import type { ProviderDiagnostics } from '../shared/config.js'
import { ProviderError } from '../shared/errors.js'
import { buildRuntimeDiagnostics, type RuntimeDiagnosticsEnvelope } from './runtimeDiagnostics.js'

export type ProviderRecoveryKind =
  | 'max_output_tokens'
  | 'context_window'
  | 'rate_limit'
  | 'auth_or_billing'
  | 'provider_protocol'
  | 'provider_unavailable'
  | 'unknown'

export type ProviderFallbackPolicy = {
  mode: 'manual_confirm' | 'retry_same_model' | 'compact_then_retry' | 'fix_configuration' | 'no_auto_fallback'
  reason: string
  nextAction: string
  allowSilentModelSwitch: false
}

export type ProviderFallbackDiagnosticEnvelope = RuntimeDiagnosticsEnvelope<{
  providerId: string
  modelId: string
  recoveryKind: ProviderRecoveryKind
  policyMode: ProviderFallbackPolicy['mode']
  actionStatus: 'ready' | 'blocked' | 'needs_user_confirmation'
}>

export type ProviderRecoveryDetails = {
  providerId?: string
  httpStatus?: number
  kind: ProviderRecoveryKind
  recoveryReason: string
  retryable: boolean
  suggestion: string
  fallbackPolicy: ProviderFallbackPolicy
  rawMessage?: string
}

export type ProviderFallbackAction = {
  type: 'provider_fallback_plan'
  provider: ProviderDiagnostics
  recovery?: ProviderRecoveryDetails
  fallbackPolicy: ProviderFallbackPolicy
  action: {
    mode: ProviderFallbackPolicy['mode']
    status: 'ready' | 'blocked' | 'needs_user_confirmation'
    description: string
    requiresUserConfirmation: true
    willSwitchModel: false
    willSwitchProvider: false
    willMutateConfig: false
    willCallProvider: false
    willCreateSession: false
  }
  diagnostic: ProviderFallbackDiagnosticEnvelope
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
      fallbackPolicy: buildProviderFallbackPolicy('max_output_tokens'),
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
      fallbackPolicy: buildProviderFallbackPolicy('context_window'),
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
      fallbackPolicy: buildProviderFallbackPolicy('rate_limit'),
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
      fallbackPolicy: buildProviderFallbackPolicy('auth_or_billing'),
      rawMessage,
    }
  }

  if (matchesAny(normalized, [
    'reasoning_content',
    'thinking mode',
    'tool id',
    'tool result',
    'tool_call_id',
  ])) {
    return {
      providerId: error.providerId,
      httpStatus: status,
      kind: 'provider_protocol',
      recoveryReason: 'PROVIDER_PROTOCOL_REPLAY_MISMATCH',
      retryable: false,
      suggestion: 'Provider rejected replayed reasoning/tool-call history. Compact the session or retry after message normalization fixes.',
      fallbackPolicy: buildProviderFallbackPolicy('provider_protocol'),
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
      fallbackPolicy: buildProviderFallbackPolicy('provider_unavailable'),
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
    fallbackPolicy: buildProviderFallbackPolicy('unknown'),
    rawMessage,
  }
}

export function planProviderFallbackAction(options: {
  provider: ProviderDiagnostics
  recovery?: ProviderRecoveryDetails
  recoveryKind?: ProviderRecoveryKind
  policy?: ProviderFallbackPolicy
}): ProviderFallbackAction {
  const fallbackPolicy = options.policy ?? options.recovery?.fallbackPolicy ?? buildProviderFallbackPolicy(options.recoveryKind ?? 'unknown')
  const action: ProviderFallbackAction['action'] = {
    mode: fallbackPolicy.mode,
    status: fallbackPolicy.mode === 'no_auto_fallback' || fallbackPolicy.mode === 'fix_configuration'
      ? 'blocked'
      : 'needs_user_confirmation',
    description: fallbackPolicy.nextAction,
    requiresUserConfirmation: true,
    willSwitchModel: false,
    willSwitchProvider: false,
    willMutateConfig: false,
    willCallProvider: false,
    willCreateSession: false,
  }
  return {
    type: 'provider_fallback_plan',
    provider: options.provider,
    recovery: options.recovery,
    fallbackPolicy,
    action,
    diagnostic: buildProviderFallbackDiagnostic({
      provider: options.provider,
      recovery: options.recovery,
      recoveryKind: options.recoveryKind,
      fallbackPolicy,
      action,
    }),
  }
}

function buildProviderFallbackDiagnostic(options: {
  provider: ProviderDiagnostics
  recovery?: ProviderRecoveryDetails
  recoveryKind?: ProviderRecoveryKind
  fallbackPolicy: ProviderFallbackPolicy
  action: ProviderFallbackAction['action']
}): ProviderFallbackDiagnosticEnvelope {
  const recoveryKind = options.recovery?.kind ?? options.recoveryKind ?? inferRecoveryKindFromPolicy(options.fallbackPolicy)
  const signals: ProviderFallbackDiagnosticEnvelope['signals'] = []
  if (options.action.status === 'blocked') {
    signals.push({
      type: 'provider_fallback_blocked',
      severity: 'critical',
      message: options.fallbackPolicy.reason,
    })
  } else {
    signals.push({
      type: 'provider_fallback_requires_confirmation',
      severity: 'warning',
      message: 'Provider fallback requires explicit user confirmation.',
    })
  }
  return buildRuntimeDiagnostics({
    domain: 'provider',
    name: 'provider_fallback_plan',
    status: options.action.status === 'blocked' ? 'blocked' : 'warning',
    summary: `${options.provider.providerId}/${options.provider.modelId} fallback ${options.fallbackPolicy.mode} for ${recoveryKind}`,
    signals,
    recommendations: [options.fallbackPolicy.nextAction],
    action: {
      mode: options.action.mode,
      status: options.action.status,
      description: options.action.description,
      requiresUserConfirmation: options.action.requiresUserConfirmation,
      allowSilentModelSwitch: false,
      sideEffects: {
        willSwitchModel: options.action.willSwitchModel,
        willSwitchProvider: options.action.willSwitchProvider,
        willMutateConfig: options.action.willMutateConfig,
        willCallProvider: options.action.willCallProvider,
        willCreateSession: options.action.willCreateSession,
      },
    },
    details: {
      providerId: options.provider.providerId,
      modelId: options.provider.modelId,
      recoveryKind,
      policyMode: options.fallbackPolicy.mode,
      actionStatus: options.action.status,
    },
  })
}

function inferRecoveryKindFromPolicy(policy: ProviderFallbackPolicy): ProviderRecoveryKind {
  switch (policy.mode) {
    case 'manual_confirm':
      return 'max_output_tokens'
    case 'compact_then_retry':
      return 'context_window'
    case 'retry_same_model':
      return 'provider_unavailable'
    case 'fix_configuration':
      return 'auth_or_billing'
    case 'no_auto_fallback':
      return 'unknown'
  }
}

export function buildProviderFallbackPolicy(kind: ProviderRecoveryKind): ProviderFallbackPolicy {
  switch (kind) {
    case 'max_output_tokens':
      return {
        mode: 'manual_confirm',
        reason: 'The provider exhausted the output budget; a larger-output model may increase cost or change behavior.',
        nextAction: 'Ask the user whether to retry with a shorter answer, continue in chunks, or switch to a larger-output model/profile.',
        allowSilentModelSwitch: false,
      }
    case 'context_window':
      return {
        mode: 'compact_then_retry',
        reason: 'The input context is too large; compaction is safer than silently changing providers.',
        nextAction: 'Run /compact or reduce context first; ask before routing to a larger-context model/profile.',
        allowSilentModelSwitch: false,
      }
    case 'rate_limit':
    case 'provider_unavailable':
      return {
        mode: 'retry_same_model',
        reason: 'The provider failure may be transient, but switching providers can change cost, latency, or output behavior.',
        nextAction: 'Retry the same model after backoff; ask before switching provider/model/profile.',
        allowSilentModelSwitch: false,
      }
    case 'auth_or_billing':
      return {
        mode: 'fix_configuration',
        reason: 'The active provider credentials, quota, or billing need user action.',
        nextAction: 'Ask the user to fix credentials/billing or explicitly choose another configured model/profile.',
        allowSilentModelSwitch: false,
      }
    case 'provider_protocol':
      return {
        mode: 'no_auto_fallback',
        reason: 'The provider rejected replay protocol details; switching models may hide a message-normalization bug.',
        nextAction: 'Compact or normalize replayed messages, then retry; do not auto-switch providers.',
        allowSilentModelSwitch: false,
      }
    case 'unknown':
      return {
        mode: 'no_auto_fallback',
        reason: 'The provider error is not classified enough for safe automatic fallback.',
        nextAction: 'Inspect the raw provider error and ask the user before retrying with a different model/profile.',
        allowSilentModelSwitch: false,
      }
  }
}

function matchesAny(value: string, needles: string[]): boolean {
  return needles.some(needle => value.includes(needle))
}
