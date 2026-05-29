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

export type ProviderLiveSmokeMode = 'simple_text' | 'tool_call'

export type ProviderLiveSmokeOptions = {
  model?: string
  role?: string
  mode?: ProviderLiveSmokeMode
  timeoutMs?: number
}

export type ProviderLiveSmokeResult = {
  type: 'provider_smoke'
  mode: 'live'
  smokeMode: ProviderLiveSmokeMode
  ready: boolean
  live: boolean
  success?: boolean
  matchedExpectedText?: boolean
  matchedExpectedTool?: boolean
  toolCallCount?: number
  toolCalls?: Array<{ name: string; input?: unknown }>
  provider: ProviderDiagnostics
  requirements: ProviderSmokeRequirements
  checks: ProviderSmokeChecks
  outputPreview?: string
  deltas?: Array<{ type: string; id?: string; text?: string; name?: string; inputDelta?: string; input?: unknown; reason?: string }>
  error?: {
    message: string
    recovery: ReturnType<typeof classifyProviderRecovery>
  }
  fallbackPolicy: ProviderSmokeFallbackPolicy | ProviderFallbackPolicy
}

const SMOKE_TEXT = 'BABEL_O_PROVIDER_SMOKE_OK'
const SMOKE_TOOL_NAME = 'provider_smoke_probe'
const SMOKE_TOOL_INPUT = { probe: SMOKE_TEXT } as const
const SMOKE_TOOL = {
  name: SMOKE_TOOL_NAME,
  description: 'Synthetic provider smoke probe. It validates tool-call protocol and is never executed.',
  inputSchema: {
    type: 'object',
    properties: {
      probe: {
        type: 'string',
        enum: [SMOKE_TEXT],
      },
    },
    required: ['probe'],
    additionalProperties: false,
  },
} as const

function matchesExpectedSmokeToolInput(input: unknown): boolean {
  return typeof input === 'object' && input !== null &&
    (input as Record<string, unknown>).probe === SMOKE_TEXT
}

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
  const smokeMode = options.mode ?? 'simple_text'
  const requirements: ProviderSmokeRequirements = {
    tools: smokeMode === 'tool_call',
    streaming: true,
    structuredOutput: false,
  }
  const checks = buildProviderSmokeChecks(provider, requirements, options.model)
  const ready = Object.values(checks).every(Boolean)
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
    const deltas = [] as Array<{ type: string; id?: string; text?: string; name?: string; inputDelta?: string; input?: unknown; reason?: string }>
    const toolCalls = [] as Array<{ name: string; input?: unknown }>
    let text = ''
    const query = smokeMode === 'tool_call'
      ? {
          model: settings.modelId,
          systemPrompt: 'You are running a BabeL-O provider smoke test. Call only the provided provider_smoke_probe tool with the exact probe value.',
          messages: [{ role: 'user' as const, content: `Call ${SMOKE_TOOL_NAME} with exactly ${JSON.stringify(SMOKE_TOOL_INPUT)}. Do not do any other work.` }],
          tools: [SMOKE_TOOL],
          maxTokens: 128,
        }
      : {
          model: settings.modelId,
          systemPrompt: `You are running a BabeL-O provider smoke test. Reply with exactly: ${SMOKE_TEXT}`,
          messages: [{ role: 'user' as const, content: `Reply with exactly: ${SMOKE_TEXT}` }],
          maxTokens: 32,
        }
    for await (const delta of adapter.queryStream(query, {
      signal: abortController.signal,
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
    })) {
      if (delta.type === 'text') {
        text += delta.text
        deltas.push({ type: delta.type, text: delta.text })
      } else if (delta.type === 'tool_use_start') {
        deltas.push({ type: delta.type, id: delta.id, name: delta.name })
      } else if (delta.type === 'tool_use_delta') {
        deltas.push({ type: delta.type, id: delta.id, inputDelta: delta.inputDelta })
      } else if (delta.type === 'tool_use_end') {
        toolCalls.push({ name: deltas.find(item => item.type === 'tool_use_start' && item.id === delta.id)?.name ?? '', input: delta.input })
        deltas.push({ type: delta.type, id: delta.id, input: delta.input })
      } else if (delta.type === 'finish') {
        deltas.push({ type: delta.type, reason: delta.reason })
      } else {
        deltas.push({ type: delta.type })
      }
    }
    const output = text.trim()
    const matchedExpectedTool = toolCalls.some(call =>
      call.name === SMOKE_TOOL_NAME && matchesExpectedSmokeToolInput(call.input),
    )
    return {
      type: 'provider_smoke',
      mode: 'live',
      smokeMode,
      ready: true,
      live: true,
      success: smokeMode === 'tool_call' ? matchedExpectedTool : output.length > 0,
      matchedExpectedText: smokeMode === 'simple_text' ? output === SMOKE_TEXT : undefined,
      matchedExpectedTool: smokeMode === 'tool_call' ? matchedExpectedTool : undefined,
      toolCallCount: smokeMode === 'tool_call' ? toolCalls.length : undefined,
      toolCalls: smokeMode === 'tool_call' ? toolCalls : undefined,
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
