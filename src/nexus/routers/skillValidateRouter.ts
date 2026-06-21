import {
  SkillValidateBodySchema,
  validateSkillRequest,
} from '../skillRoutes.js'
import type { FeatureRouter } from '../router.js'

export const skillValidateRouter: FeatureRouter = {
  name: 'skillValidateRouter',
  register(app) {
    app.post('/v1/skills/validate', async (request, reply) => {
      const body = SkillValidateBodySchema.parse(request.body ?? {})
      const result = await validateSkillRequest(body)
      if (!result.ok) {
        return reply.code(422).send(result)
      }
      return result
    })
  },
}
