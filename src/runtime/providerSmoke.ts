import type { ProviderDiagnostics } from '../shared/config.js'
import { ConfigManager } from '../shared/config.js'
import { getAdapter, getModel } from '../providers/registry.js'
import { classifyProviderRecovery, type ProviderFallbackPolicy } from './providerRecovery.js'

export type ProviderSmokeRequirements = {
  tools: boolean
  streaming: boolean
  structuredOutput: boolean
}

export type ProviderSmokeChecks = {
  authConfigured: boolean
  modelResolved: boolean
  toolsSupported: boolean
  streamingSupported: boolean
  structuredOutputSupported: boolean
}

export type ProviderSmokeFallbackMode = 'retry_same_model' | 'fix_configuration'

export type ProviderSmokeFallbackPolicy = {
  mode: ProviderSmokeFallbackMode
  reason: string
  nextAction: string
  allowSilentModelSwitch: false
}

export type ProviderSmokeOptions = {
  model?: string
  role?: string
  requireTools?: boolean
  requireStreaming?: boolean
  requireStructuredOutput?: boolean
}

export type ProviderSmokeResult = {
  type: 'provider_smoke'
  mode: 'dry_run'
  ready: boolean
  provider: ProviderDiagnostics
  requirements: ProviderSmokeRequirements
  checks: ProviderSmokeChecks
  fallbackPolicy: ProviderSmokeFallbackPolicy
}

export type ProviderLiveSmokeOptions = {
  model?: string
  role?: string
  mode?: 'simple_text'
  timeoutMs?: number
}

export type ProviderLiveSmokeResult = {
  type: 'provider_smoke'
  mode: 'live'
  smokeMode: 'simple_text'
  ready: boolean
  live: boolean
  success?: boolean
  matchedExpectedText?: boolean
  provider: ProviderDiagnostics
  requirements: ProviderSmokeRequirements
  checks: ProviderSmokeChecks
  outputPreview?: string
  deltas?: Array<{ type: string; text?: string; name?: string; reason?: string }>
  error?: {
    message: string
    recovery: ReturnType<typeof classifyProviderRecovery>
  }
  fallbackPolicy: ProviderSmokeFallbackPolicy | ProviderFallbackPolicy
}

const SMOKE_TEXT = 'BABEL_O_PROVIDER_SMOKE_OK'

export function runProviderSmokeDryRun(options: ProviderSmokeOptions = {}): ProviderSmokeResult {
  const provider = ConfigManager.getInstance().getProviderDiagnostics({
    model: options.model,
    role: options.role,
  })
  const requirements: ProviderSmokeRequirements = {
    tools: options.requireTools ?? true,
    streaming: options.requireStreaming ?? true,
    structuredOutput: options.requireStructuredOutput ?? false,
  }
  const checks = buildProviderSmokeChecks(provider, requirements, options.model)
  const ready = Object.values(checks).every(Boolean)
  return {
    type: 'provider_smoke',
    mode: 'dry_run',
    ready,
    provider,
    requirements,
    checks,
    fallbackPolicy: buildProviderSmokeFallbackPolicy(ready, 'dry_run'),
  }
}

export async function runProviderLiveSmoke(options: ProviderLiveSmokeOptions = {}): Promise<ProviderLiveSmokeResult> {
  const configManager = ConfigManager.getInstance()
  const settings = configManager.resolveSettings({
    model: options.model,
    role: options.role,
  })
  const provider = configManager.getProviderDiagnostics({
    model: options.model,
    role: options.role,
  })
  const requirements: ProviderSmokeRequirements = {
    tools: false,
    streaming: true,
    structuredOutput: false,
  }
  const checks = buildProviderSmokeChecks(provider, requirements, options.model)
  const ready = Object.values(checks).every(Boolean)
  const smokeMode = options.mode ?? 'simple_text'
  if (!ready) {
    return {
      type: 'provider_smoke',
      mode: 'live',
      smokeMode,
      ready: false,
      live: false,
      provider,
      requirements,
      checks,
      fallbackPolicy: buildProviderSmokeFallbackPolicy(false, 'live'),
    }
  }

  const abortController = new AbortController()
  const timeout = setTimeout(() => abortController.abort(), options.timeoutMs ?? 30_000)
  try {
    const adapter = getAdapter(settings.providerId)
    const deltas = [] as Array<{ type: string; text?: string; name?: string; reason?: string }>
    let text = ''
    for await (const delta of adapter.queryStream({
      model: settings.modelId,
      systemPrompt: `You are running a BabeL-O provider smoke test. Reply with exactly: ${SMOKE_TEXT}`,
      messages: [{ role: 'user', content: `Reply with exactly: ${SMOKE_TEXT}` }],
      maxTokens: 32,
    }, {
      signal: abortController.signal,
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
    })) {
      if (delta.type === 'text') {
        text += delta.text
        deltas.push({ type: delta.type, text: delta.text })
      } else if (delta.type === 'tool_use_start') {
        deltas.push({ type: delta.type, name: delta.name })
      } else if (delta.type === 'finish') {
        deltas.push({ type: delta.type, reason: delta.reason })
      } else {
        deltas.push({ type: delta.type })
      }
    }
    const output = text.trim()
    return {
      type: 'provider_smoke',
      mode: 'live',
      smokeMode,
      ready: true,
      live: true,
      success: output.length > 0,
      matchedExpectedText: output === SMOKE_TEXT,
      provider,
      requirements,
      checks,
      outputPreview: output.slice(0, 200),
      deltas,
      fallbackPolicy: buildProviderSmokeFallbackPolicy(true, 'live'),
    }
  } catch (error) {
    const recovery = classifyProviderRecovery(error)
    return {
      type: 'provider_smoke',
      mode: 'live',
      smokeMode,
      ready: true,
      live: false,
      success: false,
      provider,
      requirements,
      checks,
      error: {
        message: error instanceof Error ? error.message : String(error),
        recovery,
      },
      fallbackPolicy: recovery?.fallbackPolicy ?? buildProviderSmokeFallbackPolicy(false, 'live'),
    }
  } finally {
    clearTimeout(timeout)
  }
}

export function buildProviderSmokeChecks(
  provider: ProviderDiagnostics,
  requirements: ProviderSmokeRequirements,
  requestedModel?: string,
): ProviderSmokeChecks {
  let modelResolved = false
  try {
    getModel(provider.modelId)
    modelResolved = !requestedModel || provider.modelId === requestedModel
  } catch {
    modelResolved = false
  }
  return {
    authConfigured: provider.authConfigured,
    modelResolved,
    toolsSupported: !requirements.tools || provider.capabilities.toolCalling,
    streamingSupported: !requirements.streaming || provider.capabilities.streaming,
    structuredOutputSupported: !requirements.structuredOutput || provider.capabilities.structuredOutput,
  }
}

export function buildProviderSmokeFallbackPolicy(
  ready: boolean,
  mode: 'dry_run' | 'live',
): ProviderSmokeFallbackPolicy {
  return {
    mode: ready ? 'retry_same_model' : 'fix_configuration',
    reason: ready
      ? `The configured provider and model satisfy the requested ${mode} readiness checks.`
      : `The configured provider or model does not satisfy one or more ${mode} readiness checks.`,
    nextAction: ready
      ? 'Run an explicit provider smoke request only when the user asks for a live provider call.'
      : 'Fix provider credentials/capabilities or explicitly choose another configured model/profile before retrying.',
    allowSilentModelSwitch: false,
  }
}
