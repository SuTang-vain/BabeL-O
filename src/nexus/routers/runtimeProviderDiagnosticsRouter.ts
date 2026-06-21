import { z } from 'zod'
import { ConfigManager } from '../../shared/config.js'
import { buildProviderFallbackPolicy, planProviderFallbackAction } from '../../runtime/providerRecovery.js'
import { runProviderLiveSmoke, runProviderSmokeDryRun } from '../../runtime/providerSmoke.js'
import type { FeatureRouter } from '../router.js'

function booleanQuery(defaultValue: boolean) {
  return z.preprocess(value => {
    if (value === undefined) return defaultValue
    if (typeof value === 'boolean') return value
    if (typeof value !== 'string') return value
    const lowered = value.toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(lowered)) return true
    if (['0', 'false', 'no', 'off'].includes(lowered)) return false
    return value
  }, z.boolean())
}

const providerSmokeQuerySchema = z.object({
  model: z.string().optional(),
  role: z.string().optional(),
  requireTools: booleanQuery(true),
  requireStreaming: booleanQuery(true),
  requireStructuredOutput: booleanQuery(false),
})

const providerLiveSmokeSchema = z.object({
  model: z.string().optional(),
  role: z.string().optional(),
  mode: z.enum(['simple_text', 'tool_call']).default('simple_text').optional(),
  timeoutMs: z.number().int().positive().max(60_000).default(30_000).optional(),
})

const providerFallbackPlanSchema = z.object({
  model: z.string().optional(),
  role: z.string().optional(),
  kind: z.enum(['max_output_tokens', 'context_window', 'rate_limit', 'auth_or_billing', 'provider_protocol', 'provider_unavailable', 'unknown']).default('unknown').optional(),
})

export const runtimeProviderDiagnosticsRouter: FeatureRouter = {
  name: 'runtime-provider-diagnostics',
  register(app) {
    app.get('/v1/runtime/provider-smoke', async request => {
      const query = providerSmokeQuerySchema.parse(request.query)
      return runProviderSmokeDryRun({
        model: query.model,
        role: query.role,
        requireTools: query.requireTools,
        requireStreaming: query.requireStreaming,
        requireStructuredOutput: query.requireStructuredOutput,
      })
    })

    app.post('/v1/runtime/provider-smoke/live', async request => {
      const body = providerLiveSmokeSchema.parse(request.body ?? {})
      return runProviderLiveSmoke({
        model: body.model,
        role: body.role,
        mode: body.mode,
        timeoutMs: body.timeoutMs,
      })
    })

    app.post('/v1/runtime/provider-fallback/plan', async request => {
      const body = providerFallbackPlanSchema.parse(request.body ?? {})
      const provider = ConfigManager.getInstance().getProviderDiagnostics({
        model: body.model,
        role: body.role,
      })
      const recoveryKind = body.kind ?? 'unknown'
      return planProviderFallbackAction({
        provider,
        recoveryKind,
        policy: buildProviderFallbackPolicy(recoveryKind),
      })
    })
  },
}
