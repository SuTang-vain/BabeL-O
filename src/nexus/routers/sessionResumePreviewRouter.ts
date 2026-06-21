// src/nexus/routers/sessionResumePreviewRouter.ts
//
// R5 of docs/nexus/proposals/long-running-context-assembly.md §20:
// Session Resume As Product Path, Not Only Unit Method.
//
// POST /v1/sessions/:sessionId/resume-preview — read-only projection of
// what `LLMCodingRuntime.resume()` would build for a session, without
// subscribing to live hints and without executing a provider turn.
//
// Why a separate route (vs. extending /v1/sessions/:sessionId/resume):
//   - /v1/sessions/:sessionId/resume (PR-A2) is a pure inspect path
//     that reads events/tasks/childSessions from storage without ever
//     touching the runtime. It's a snapshot of "what is on disk".
//   - /v1/sessions/:sessionId/resume-preview (R5) calls into
//     runtime.resumePreview() and runs the actual assembleContext
//     pipeline. The output reflects "what the runtime would see on
//     resume", which is a fundamentally different question.
//
// Contract:
//   - hasContinuationSnapshot: false — hard-coded. R5 acceptance
//     requires an explicit "we do not promise 0 information loss
//     until a real restart e2e passes".
//   - Does NOT mutate state: no working set writes, no event appends,
//     no provider turn. The route is idempotent and read-only.
//   - LocalCodingRuntime has no resume implementation; the route
//     returns 501 NOT_IMPLEMENTED with a clear code.

import { z } from 'zod'
import type { FeatureRouter } from '../router.js'
import type { NexusRuntime } from '../../runtime/Runtime.js'

const sessionResumePreviewSchema = z.object({
  cwd: z.string().min(1),
}).strict()

export const sessionResumePreviewRouter: FeatureRouter = {
  name: 'sessionResumePreviewRouter',
  register(app, context) {
    app.post('/v1/sessions/:sessionId/resume-preview', async (request, reply) => {
      const params = z.object({ sessionId: z.string() }).parse(request.params)
      const body = sessionResumePreviewSchema.parse(request.body ?? {})
      const session = await context.options.storage.getSession(params.sessionId, {
        includeEvents: false,
      })
      if (!session) {
        return reply.code(404).send({
          type: 'error',
          code: 'SESSION_NOT_FOUND',
          message: `Session not found: ${params.sessionId}`,
        })
      }

      // The runtime may or may not implement resumePreview (R5 added it
      // to LLMCodingRuntime; LocalCodingRuntime has no resume support).
      // FeatureRouter context exposes `options.runtime` as NexusRuntime,
      // which has an optional `resumePreview` method. If absent, the
      // route returns 501 with an explicit code so callers can
      // distinguish "session exists but this runtime can't preview
      // resume" from "session exists and the preview ran".
      const runtime = context.options.runtime as NexusRuntime & {
        resumePreview?: (opts: { sessionId: string; cwd: string }) => Promise<unknown>
      }
      if (typeof runtime.resumePreview !== 'function') {
        return reply.code(501).send({
          type: 'error',
          code: 'RESUME_PREVIEW_UNSUPPORTED',
          message:
            'The active runtime does not implement resumePreview (R5). ' +
            'LLMCodingRuntime is required; LocalCodingRuntime has no resume support.',
        })
      }

      try {
        const preview = await runtime.resumePreview({
          sessionId: params.sessionId,
          cwd: body.cwd,
        })
        return preview
      } catch (error) {
        return reply.code(500).send({
          type: 'error',
          code: 'RESUME_PREVIEW_FAILED',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    })
  },
}
