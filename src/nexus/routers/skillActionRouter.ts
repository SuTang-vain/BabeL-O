import {
  generateDraftHandler,
  invokeSkill,
  saveSkillHandler,
  SkillDraftBodySchema,
  SkillInvokeBodySchema,
  SkillSaveBodySchema,
} from '../skillRoutes.js'
import type { FeatureRouter } from '../router.js'

export const skillActionRouter: FeatureRouter = {
  name: 'skillActionRouter',
  register(app, context) {
    app.post('/v1/skills/invoke', async request => {
      const body = SkillInvokeBodySchema.parse(request.body ?? {})
      return invokeSkill(body)
    })

    app.post('/v1/skills/draft', async (request, reply) => {
      const body = SkillDraftBodySchema.parse(request.body ?? {})
      const result = await generateDraftHandler(body)
      if (!result.ok) {
        return reply.code(422).send(result)
      }
      return result
    })

    app.post('/v1/skills/save', async (request, reply) => {
      const body = SkillSaveBodySchema.parse(request.body ?? {})
      const result = await saveSkillHandler({
        cwd: body.cwd ?? context.options.defaultCwd,
        draft: body.draft as unknown as Parameters<typeof saveSkillHandler>[0]['draft'],
        confirm: body.confirm,
        ...(body.overwrite !== undefined ? { overwrite: body.overwrite } : {}),
        ...(body.scope ? { scope: body.scope } : {}),
      })
      if (!result.ok) {
        if (result.errorCode === 'SKILL_SAVE_OVERWRITE_REQUIRED') {
          return reply.code(409).send(result)
        }
        if (result.errorCode === 'SKILL_SAVE_PERSIST_FAILED' || result.errorCode === 'SKILL_SAVE_SCOPE_INVALID') {
          return reply.code(500).send(result)
        }
        return reply.code(422).send(result)
      }
      return result
    })
  },
}
