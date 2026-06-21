import { z } from 'zod'
import { NexusEventSchema } from '../../shared/events.js'
import type { FeatureRouter } from '../router.js'

export const schemaRouter: FeatureRouter = {
  name: 'schema',
  register(app) {
    app.get('/v1/schema/events', async () => z.toJSONSchema(NexusEventSchema))
  },
}
