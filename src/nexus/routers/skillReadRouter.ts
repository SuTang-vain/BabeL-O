import {
  listSkills,
  showSkill,
  SkillIdParamsSchema,
  SkillListQuerySchema,
} from '../skillRoutes.js'
import type { FeatureRouter } from '../router.js'

export const skillReadRouter: FeatureRouter = {
  name: 'skillReadRouter',
  register(app, context) {
    app.get('/v1/skills', async request => {
      const query = SkillListQuerySchema.parse(request.query)
      return listSkills({
        cwd: query.cwd ?? context.options.defaultCwd,
        ...(query.source ? { source: query.source } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.builtInDir ? { builtInDir: query.builtInDir } : {}),
      })
    })

    app.get('/v1/skills/:id', async (request, reply) => {
      const params = SkillIdParamsSchema.parse(request.params)
      const query = SkillListQuerySchema.parse(request.query)
      const result = await showSkill({
        cwd: query.cwd ?? context.options.defaultCwd,
        id: params.id,
        ...(query.builtInDir ? { builtInDir: query.builtInDir } : {}),
      })
      if (!result.ok) {
        const status = result.errorCode === 'SKILL_NOT_FOUND' ? 404 : 500
        return reply.code(status).send(result)
      }
      return result
    })
  },
}
