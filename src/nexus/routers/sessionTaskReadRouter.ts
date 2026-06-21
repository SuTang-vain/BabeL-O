import { z } from 'zod'
import type { FeatureRouter } from '../router.js'

export const sessionTaskReadRouter: FeatureRouter = {
  name: 'sessionTaskReadRouter',
  register(app, context) {
    app.get('/v1/sessions/:sessionId/tasks', async request => {
      const params = z.object({ sessionId: z.string() }).parse(request.params)
      return {
        type: 'tasks_list',
        tasks: await context.options.storage.listTasks(params.sessionId),
      }
    })
  },
}
