import { z } from 'zod'
import { ConfigManager, type ProfileConfig } from '../../shared/config.js'
import { inspectModelCapabilities } from '../../providers/registry.js'
import type { FeatureRouter } from '../router.js'

const runtimeConfigProfileParamsSchema = z.object({
  name: z.string().min(1).max(120),
})

type SharedRuntimeCapabilities = {
  toolCalling: boolean
  jsonOutput: boolean
  structuredOutput: boolean
  streaming: boolean
}

export function inspectResolvedRuntimeConfig(manager: ConfigManager) {
  const settings = manager.resolveSettings()
  const base = {
    version: manager.getConfigVersion(),
    tombstones: manager.getTombstones(),
  }
  try {
    const diag = inspectModelCapabilities(settings.modelId, settings.providerId)
    return {
      ...base,
      type: 'runtime_config',
      modelId: settings.modelId,
      modelName: diag.modelName,
      providerId: settings.providerId,
      providerName: diag.providerName,
      authMode: diag.authMode,
      modelSource: settings.modelSource,
      hasApiKey: settings.apiKeySource !== 'none' && Boolean(settings.apiKey),
      apiKeySource: settings.apiKeySource,
      baseUrl: settings.baseUrl ?? '',
      baseUrlSource: settings.baseUrlSource,
      activeProfile: settings.activeProfile,
      contextWindow: diag.contextWindow,
      defaultMaxTokens: diag.defaultMaxTokens,
      capabilities: diag.capabilities,
    }
  } catch {
    return {
      ...base,
      type: 'runtime_config',
      modelId: settings.modelId,
      modelName: settings.modelId,
      providerId: settings.providerId,
      providerName: settings.providerId,
      authMode: 'api-key',
      modelSource: settings.modelSource,
      hasApiKey: settings.apiKeySource !== 'none' && Boolean(settings.apiKey),
      apiKeySource: settings.apiKeySource,
      baseUrl: settings.baseUrl ?? '',
      baseUrlSource: settings.baseUrlSource,
      activeProfile: settings.activeProfile,
      contextWindow: 0,
      defaultMaxTokens: 0,
      capabilities: {
        toolCalling: false,
        jsonOutput: false,
        structuredOutput: false,
        streaming: false,
      } satisfies SharedRuntimeCapabilities,
    }
  }
}

function sanitizeProfileConfig(name: string, profile: ProfileConfig, activeProfile: string | undefined) {
  const modelId = profile.model ?? ''
  const providerId = profile.provider ?? (modelId.includes('/') ? modelId.slice(0, modelId.indexOf('/')) : '')
  const base = {
    name,
    active: name === activeProfile,
    model: profile.model,
    provider: profile.provider,
    roles: profile.roles,
    hasApiKey: Boolean(profile.apiKey),
    hasBaseUrl: Boolean(profile.baseUrl),
  }
  if (!modelId || !providerId) {
    return base
  }
  try {
    const diag = inspectModelCapabilities(modelId, providerId)
    return {
      ...base,
      modelName: diag.modelName,
      providerName: diag.providerName,
      contextWindow: diag.contextWindow,
      defaultMaxTokens: diag.defaultMaxTokens,
      capabilities: diag.capabilities,
    }
  } catch {
    return base
  }
}

export const runtimeConfigRouter: FeatureRouter = {
  name: 'runtime-config',
  register(app) {
    app.get('/v1/runtime/config', async (request, reply) => {
      const manager = ConfigManager.getInstance()
      const sinceRaw = (request.query as { since?: string | number }).since
      const since = sinceRaw === undefined ? -1 : Number(sinceRaw)
      if (Number.isFinite(since) && since >= 0) {
        const version = manager.getConfigVersion()
        if (since >= version) {
          return reply.code(304).send()
        }
      }
      return inspectResolvedRuntimeConfig(manager)
    })

    app.get('/v1/runtime/config/profiles', async () => {
      const manager = ConfigManager.getInstance()
      const activeProfile = manager.getActiveProfile()
      return {
        type: 'runtime_config_profiles',
        version: manager.getConfigVersion(),
        activeProfile,
        profiles: Object.entries(manager.getProfiles()).map(([name, profile]) => sanitizeProfileConfig(name, profile, activeProfile)),
        tombstones: manager.getTombstones(),
      }
    })

    app.get('/v1/runtime/config/profiles/:name', async request => {
      const params = runtimeConfigProfileParamsSchema.parse(request.params)
      const manager = ConfigManager.getInstance()
      const profile = manager.getProfiles()[params.name]
      const base = {
        type: 'runtime_config_profile',
        version: manager.getConfigVersion(),
        tombstones: manager.getTombstones(),
      }
      if (!manager.hasProfile(params.name) || !profile) {
        return {
          ...base,
          found: false,
          name: params.name,
        }
      }
      return {
        ...base,
        found: true,
        profile: sanitizeProfileConfig(params.name, profile, manager.getActiveProfile()),
      }
    })
  },
}
