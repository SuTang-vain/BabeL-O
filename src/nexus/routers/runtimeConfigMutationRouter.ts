import { z } from 'zod'
import { ConfigManager, validateModelSelectionAuth } from '../../shared/config.js'
import { modelRegistry, providerRegistry, getProvider } from '../../providers/registry.js'
import { inspectResolvedRuntimeConfig } from './runtimeConfigRouter.js'
import type { FeatureRouter } from '../router.js'

const runtimeConfigSelectSchema = z
  .object({
    profile: z.string().min(1).max(120).optional(),
    model: z.string().optional(),
    role: z.string().optional(),
    roleModel: z.string().optional(),
  })
  .strict()

const runtimeConfigProviderSchema = z
  .object({
    provider: z.string().min(1).max(80),
    apiKey: z.string().min(1).max(20_000).optional(),
    baseUrl: z.string().url().optional(),
    adapter: z.enum(['openai-compatible', 'anthropic-compatible']).optional(),
    models: z.array(z.object({
      id: z.string().min(1),
      name: z.string().min(1).optional(),
    })).optional(),
  })
  .strict()

const runtimeConfigProviderVerifySchema = z
  .object({
    provider: z.string().min(1).max(80),
    adapter: z.enum(['openai-compatible', 'anthropic-compatible']),
    baseUrl: z.string().url(),
    apiKey: z.string().min(1).max(20_000),
  })
  .strict()

type ProviderVerifyResult = {
  success: boolean
  provider?: string
  models?: Array<{ id: string; name: string }>
  error?: string
  errorDetail?: string
}

export const runtimeConfigMutationRouter: FeatureRouter = {
  name: 'runtime-config-mutation',
  register(app) {
    app.post('/v1/runtime/config/provider/verify', async (request, reply) => {
      const body = runtimeConfigProviderVerifySchema.parse(request.body ?? {})
      // Business result is always 200: clients inspect
      // `result.success` / `result.error` / `result.errorDetail`.
      // Returning 4xx here makes transport-layer clients (the Go
      // TUI `nexusJSON` helper) treat a credential failure as a
      // protocol/network error and lose the structured error code,
      // which is what surfaces to the operator in the wizard.
      const result = await verifyProviderConfig(body)
      return reply.code(200).send(result)
    })

    app.post('/v1/runtime/config/provider', async (request, reply) => {
      const body = runtimeConfigProviderSchema.parse(request.body ?? {})
      const manager = ConfigManager.getInstance()
      // Allow unknown providers for custom provider support
      const providerDef = getProvider(body.provider)

      const existing = manager.getProviderConfig(body.provider)
      manager.setProviderConfig(body.provider, {
        apiKey: body.apiKey ?? existing.apiKey,
        baseUrl: body.baseUrl ?? existing.baseUrl,
        adapter: body.adapter ?? existing.adapter,
        models: body.models ?? existing.models,
      })
      return inspectResolvedRuntimeConfig(manager)
    })

    app.post('/v1/runtime/config/select', async (request, reply) => {
      const body = runtimeConfigSelectSchema.parse(request.body ?? {})
      const manager = ConfigManager.getInstance()

      if (body.role || body.roleModel) {
        return reply.code(400).send({
          error: 'not_supported',
          message: 'role / roleModel switching is not supported in this endpoint; use `bbl config` CLI',
        })
      }

      const hasProfile = typeof body.profile === 'string' && body.profile.length > 0
      const hasModel = typeof body.model === 'string' && body.model.length > 0

      if (hasProfile && hasModel) {
        return reply.code(400).send({
          error: 'mutually_exclusive',
          message: 'pass either `profile` or `model`, not both',
        })
      }

      if (!hasProfile && !hasModel) {
        return reply.code(400).send({ error: 'missing_field', message: 'pass `profile` or `model`' })
      }

      if (hasProfile) {
        const profileName = body.profile as string
        if (manager.isProfileTombstoned(profileName)) {
          return reply.code(400).send({
            error: 'tombstoned_profile',
            profile: profileName,
            tombstone: manager.getTombstones()[profileName],
          })
        }

        if (!manager.hasProfile(profileName)) {
          return reply.code(400).send({ error: 'unknown_profile', profile: profileName })
        }

        manager.setActiveProfile(profileName)
        return inspectResolvedRuntimeConfig(manager)
      }

      const modelId = body.model as string
      const config = manager.load()
      const isConfiguredModel = Object.values(config.providers ?? {}).some(provider =>
        provider.models?.some(model => model.id === modelId),
      )
      if (!modelRegistry.some(entry => entry.id === modelId) && !isConfiguredModel) {
        return reply.code(400).send({
          error: 'unknown_model',
          model: modelId,
          message: 'model id is not present in the modelRegistry or configured custom providers',
        })
      }

      const authIssue = validateModelSelectionAuth(manager, modelId)
      if (authIssue) {
        return reply.code(400).send({
          error: 'missing_provider_api_key',
          provider: authIssue.providerId,
          model: authIssue.modelId,
          authMode: authIssue.authMode,
          authSource: authIssue.authSource,
          command: authIssue.command,
          message: authIssue.message,
        })
      }

      manager.setDefaultModel(modelId, { clearActiveProfile: true })
      return inspectResolvedRuntimeConfig(manager)
    })
  },
}

async function verifyProviderConfig(params: {
  provider: string
  adapter: 'openai-compatible' | 'anthropic-compatible'
  baseUrl: string
  apiKey: string
}): Promise<ProviderVerifyResult> {
  const { provider, adapter, baseUrl, apiKey } = params

  try {
    // For OpenAI-compatible providers, try to fetch models from /models endpoint
    if (adapter === 'openai-compatible') {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      }

      // Check if this is a known provider to determine auth mode
      const knownProvider = providerRegistry.find(p => p.id === provider)
      if (knownProvider?.authMode === 'api-key') {
        headers['x-api-key'] = apiKey
      } else {
        headers.Authorization = `Bearer ${apiKey}`
      }

      const response = await fetch(`${baseUrl}/models`, {
        method: 'GET',
        headers,
      })

      if (!response.ok) {
        const errorText = await response.text()
        return {
          success: false,
          provider,
          error: 'auth_failed',
          errorDetail: `Failed to authenticate: ${response.status} ${response.statusText}. ${errorText}`,
        }
      }

      // The credential is valid; surface the upstream model list so
      // the wizard can offer a pick-list instead of forcing the
      // operator to type a model id blind. The OpenAI-compatible
      // `/models` envelope is `{ data: [{ id, ... }, ...] }`. Parse
      // defensively: a provider that returns a non-standard body
      // (or an empty list) should still verify successfully and let
      // the wizard fall back to manual entry — listing failure is
      // not an auth failure.
      const models: Array<{ id: string; name: string }> = []
      try {
        const body = await response.json() as { data?: Array<{ id?: unknown }> }
        for (const entry of body.data ?? []) {
          if (typeof entry?.id !== 'string' || entry.id.length === 0) continue
          models.push({ id: entry.id, name: entry.id })
        }
      } catch {
        // Non-JSON or malformed body: leave models empty.
      }

      return {
        success: true,
        provider,
        models,
      }
    }

    // For Anthropic-compatible providers, we can't list models
    // Just verify the credentials work by making a minimal request
    if (adapter === 'anthropic-compatible') {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      }

      // Try a minimal messages request with a dummy model
      const response = await fetch(`${baseUrl}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'claude-3-5-sonnet-20241022',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      })

      if (!response.ok) {
        const errorText = await response.text()
        return {
          success: false,
          provider,
          error: 'auth_failed',
          errorDetail: `Failed to authenticate: ${response.status} ${response.statusText}. ${errorText}`,
        }
      }

      return {
        success: true,
        provider,
        models: [], // Anthropic doesn't have a /models endpoint
      }
    }

    return {
      success: false,
      provider,
      error: 'unknown_adapter',
      errorDetail: `Unknown adapter type: ${adapter}`,
    }
  } catch (error) {
    return {
      success: false,
      provider,
      error: 'network_error',
      errorDetail: error instanceof Error ? error.message : 'Unknown error occurred',
    }
  }
}
