import { z } from 'zod'
import { ConfigManager, validateModelSelectionAuth } from '../../shared/config.js'
import { modelRegistry, providerRegistry } from '../../providers/registry.js'
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

export const runtimeConfigMutationRouter: FeatureRouter = {
  name: 'runtime-config-mutation',
  register(app) {
    app.post('/v1/runtime/config/provider', async (request, reply) => {
      const body = runtimeConfigProviderSchema.parse(request.body ?? {})
      const manager = ConfigManager.getInstance()
      if (!providerRegistry.some(provider => provider.id === body.provider)) {
        return reply.code(400).send({
          error: 'unknown_provider',
          provider: body.provider,
          message: 'provider id is not present in the providerRegistry',
        })
      }

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
