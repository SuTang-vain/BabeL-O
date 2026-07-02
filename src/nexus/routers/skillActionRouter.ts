import {
  generateDraftHandler,
  installSkillImportHandler,
  invokeSkill,
  previewSkillExportHandler,
  previewSkillImportHandler,
  saveSkillHandler,
  SkillDraftBodySchema,
  SkillExportPreviewBodySchema,
  SkillExportWriteBodySchema,
  SkillImportInstallBodySchema,
  SkillImportPreviewBodySchema,
  SkillInvokeBodySchema,
  SkillSaveBodySchema,
  writeSkillExportHandler,
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

    app.post('/v1/skills/import/preview', async (request, reply) => {
      const body = SkillImportPreviewBodySchema.parse(request.body ?? {})
      const result = await previewSkillImportHandler({
        cwd: body.cwd ?? context.options.defaultCwd,
        sourcePath: body.sourcePath,
        ...(body.scope ? { scope: body.scope } : {}),
        ...(body.builtInDir ? { builtInDir: body.builtInDir } : {}),
      })
      if (!result.ok) {
        return reply.code(result.errorCode === 'SKILL_IMPORT_SOURCE_NOT_FOUND' ? 404 : 422).send(result)
      }
      return result
    })

    app.post('/v1/skills/export/preview', async (request, reply) => {
      const body = SkillExportPreviewBodySchema.parse(request.body ?? {})
      const result = await previewSkillExportHandler({
        cwd: body.cwd ?? context.options.defaultCwd,
        id: body.id,
        ...(body.targetDir ? { targetDir: body.targetDir } : {}),
        ...(body.builtInDir ? { builtInDir: body.builtInDir } : {}),
      })
      if (!result.ok) {
        return reply.code(result.errorCode === 'SKILL_NOT_FOUND' ? 404 : 422).send(result)
      }
      return result
    })

    app.post('/v1/skills/export/write', async (request, reply) => {
      const body = SkillExportWriteBodySchema.parse(request.body ?? {})
      const result = await writeSkillExportHandler({
        cwd: body.cwd ?? context.options.defaultCwd,
        id: body.id,
        confirm: body.confirm,
        ...(body.targetDir ? { targetDir: body.targetDir } : {}),
        ...(body.builtInDir ? { builtInDir: body.builtInDir } : {}),
        ...(body.overwrite !== undefined ? { overwrite: body.overwrite } : {}),
      })
      if (!result.ok) {
        if (result.errorCode === 'SKILL_NOT_FOUND') {
          return reply.code(404).send(result)
        }
        if (result.errorCode === 'SKILL_EXPORT_OVERWRITE_REQUIRED') {
          return reply.code(409).send(result)
        }
        if (result.errorCode === 'SKILL_EXPORT_PERSIST_FAILED') {
          return reply.code(500).send(result)
        }
        return reply.code(422).send(result)
      }
      return result
    })

    app.post('/v1/skills/import/install', async (request, reply) => {
      const body = SkillImportInstallBodySchema.parse(request.body ?? {})
      const result = await installSkillImportHandler({
        cwd: body.cwd ?? context.options.defaultCwd,
        sourcePath: body.sourcePath,
        confirm: body.confirm,
        ...(body.overwrite !== undefined ? { overwrite: body.overwrite } : {}),
        ...(body.scope ? { scope: body.scope } : {}),
        ...(body.builtInDir ? { builtInDir: body.builtInDir } : {}),
      })
      if (!result.ok) {
        if (result.errorCode === 'SKILL_IMPORT_SOURCE_NOT_FOUND') {
          return reply.code(404).send(result)
        }
        if (result.errorCode === 'SKILL_IMPORT_OVERWRITE_REQUIRED') {
          return reply.code(409).send(result)
        }
        if (result.errorCode === 'SKILL_IMPORT_PERSIST_FAILED') {
          return reply.code(500).send(result)
        }
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
