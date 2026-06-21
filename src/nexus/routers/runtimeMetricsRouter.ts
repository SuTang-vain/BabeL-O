import type { FeatureRouter } from '../router.js'

export const runtimeMetricsRouter: FeatureRouter = {
  name: 'runtime-metrics',
  register(app, context) {
    app.get('/v1/runtime/metrics', async () => context.runtimeMetricsSnapshot())
  },
}
