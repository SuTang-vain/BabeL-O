import type { FeatureRouter } from '../router.js'

export const toolsAuditRouter: FeatureRouter = {
  name: 'toolsAuditRouter',
  register(app, context) {
    app.get('/v1/tools/audit', async () => ({
      type: 'tools_audit',
      tools: context.options.runtime.listTools?.() ?? [],
    }))
  },
}
