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
      const result = await verifyProviderConfig(body)
      return reply.code(result.success ? 200 : 400).send(result)
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
      if (!modelRegistry.some(entry => entry.id === modelId)) {
        return reply.code(400).send({
          error: 'unknown_model',
          model: modelId,
          message: 'model id is not present in the modelRegistry',
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

      const data = await response.json() as any
      const models: Array<{ id: string; name: string }> = []

      // OpenAI format: { data: [{ id: string, object: string, ... }] }
      if (Array.isArray(data.data)) {
        for (const model of data.data) {
          if (model.id) {
            models.push({
              id: `${provider}/${model.id}`,
              name: model.id,
            })
          }
        }
      }

      return {
        success: true,
        provider,
        models: models.slice(0, 100), // Limit to 100 models
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
