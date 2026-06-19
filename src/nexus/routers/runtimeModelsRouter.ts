import { ConfigManager, type ProfileConfig } from '../../shared/config.js'
import { modelRegistry, providerRegistry } from '../../providers/registry.js'
import type { FeatureRouter } from '../router.js'

type RuntimeProviderAuthSource = 'none' | 'env' | 'profile' | 'provider_config'

function providerCredentialEnv(providerId: string): string | undefined {
  if (process.env.BABEL_O_API_KEY) return process.env.BABEL_O_API_KEY
  if (providerId === 'anthropic') return process.env.ANTHROPIC_API_KEY
  if (providerId === 'openai') return process.env.OPENAI_API_KEY
  if (providerId === 'deepseek') return process.env.DEEPSEEK_API_KEY
  if (providerId === 'zhipu') return process.env.ZHIPU_API_KEY || process.env.ZHIPUAI_API_KEY
  if (providerId === 'minimax') return process.env.MINIMAX_API_KEY || process.env.MINIMAX_AUTH_TOKEN
  if (providerId === 'moonshot') return process.env.MOONSHOT_API_KEY
  if (providerId === 'ollama') return process.env.OLLAMA_API_KEY
  return undefined
}

function profileProviderId(profile: ProfileConfig): string | undefined {
  if (profile.provider) return profile.provider
  if (profile.model?.includes('/')) return profile.model.slice(0, profile.model.indexOf('/'))
  return undefined
}

function resolveProviderAuthState(
  manager: ConfigManager,
  providerId: string,
): {
  configured: boolean
  authConfigured: boolean
  authSource: RuntimeProviderAuthSource
} {
  const provider = providerRegistry.find(item => item.id === providerId)
  if (!provider) {
    return { configured: false, authConfigured: false, authSource: 'none' }
  }
  if (provider.authMode === 'none') {
    return { configured: true, authConfigured: true, authSource: 'none' }
  }

  const providerConfigApiKey = manager.getProviderConfig(providerId).apiKey
  const configured = Boolean(providerConfigApiKey)

  let authSource: RuntimeProviderAuthSource = 'none'
  if (providerCredentialEnv(providerId)) {
    authSource = 'env'
  } else if (Object.values(manager.getProfiles()).some(profile => Boolean(profile.apiKey) && profileProviderId(profile) === providerId)) {
    authSource = 'profile'
  } else if (providerConfigApiKey) {
    authSource = 'provider_config'
  }

  return {
    configured,
    authConfigured: authSource !== 'none',
    authSource,
  }
}

export const runtimeModelsRouter: FeatureRouter = {
  name: 'runtime-models',
  register(app) {
    app.get('/v1/runtime/models', async () => {
      const manager = ConfigManager.getInstance()
      const settings = manager.resolveSettings()
      return {
        type: 'runtime_models',
        version: manager.getConfigVersion(),
        tombstones: manager.getTombstones(),
        providers: providerRegistry.map(p => {
          const authState = resolveProviderAuthState(manager, p.id)
          return {
            id: p.id,
            displayName: p.displayName,
            adapter: p.adapter,
            authMode: p.authMode,
            defaultBaseUrl: p.defaultBaseUrl,
            defaultModel: p.defaultModel,
            configured: authState.configured,
            authConfigured: authState.authConfigured,
            authSource: authState.authSource,
            active: settings.providerId === p.id,
            models: p.models.map(mid => {
              const def = modelRegistry.find(m => m.id === mid)
              return {
                id: mid,
                name: def?.name ?? mid,
                contextWindow: def?.contextWindow ?? 0,
                defaultMaxTokens: def?.defaultMaxTokens ?? 0,
                capabilities: def?.capabilities ?? {
                  toolCalling: false,
                  jsonOutput: false,
                  streaming: false,
                },
              }
            }),
          }
        }),
        defaultModel: settings.modelId,
        activeProfile: settings.activeProfile,
      }
    })
  },
}
