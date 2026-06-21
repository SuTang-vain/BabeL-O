/**
 * Phase 4A+ slice — `middleware.ts`
 *
 * Extracts the Fastify `setErrorHandler` and the three `addHook`
 * registrations (request metrics stamp, optional API key auth,
 * response metrics record) from `src/nexus/app.ts` into a focused
 * module. Each helper takes the Fastify instance plus the minimum
 * collaborators it needs and returns nothing — the side effect is the
 * registration itself.
 *
 * Goals:
 * - One small reviewable file that documents the cross-cutting
 *   middleware contract (error envelope shape, auth bypass paths,
 *   metric key shape).
 * - Preserve exact behavior: every status code, error code, and
 *   header name from the inline closure is preserved.
 * - Eliminate ~50 lines of cross-cutting boilerplate from `app.ts`.
 *
 * Non-goals:
 * - Do not introduce new error codes or status codes.
 * - Do not change the `performanceStartMs` request decoration shape —
 *   `app.ts` declares the FastifyRequest module augmentation.
 * - Do not move the API key env-var lookup; the composition root
 *   already does that and passes the resolved key in.
 */

import type { FastifyInstance } from 'fastify'
import type { NexusMetrics } from './metrics.js'

/**
 * Wire the canonical Nexus error envelope onto the Fastify app.
 *
 * Behaviour:
 * - Validation errors (Fastify schema errors, `ZodError`, or
 *   `statusCode === 400`) are rewritten as `{ type: 'error', code:
 *   'INVALID_REQUEST', message }` with HTTP 400. This gives every
 *   router a single uniform 400 response shape regardless of which
 *   schema layer produced the error.
 * - Any other error is forwarded with its original `statusCode` /
 *   `code` (falling back to `500` / `INTERNAL_ERROR`).
 *
 * The envelope shape is part of the v1 API contract — do not change
 * field names without bumping the API version.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: any, request, reply) => {
    const isValidationError =
      error.validation || error.name === 'ZodError' || error.statusCode === 400

    if (isValidationError) {
      return reply.status(400).send({
        type: 'error',
        code: 'INVALID_REQUEST',
        message: error.message || String(error),
      })
    }

    const code = (error as { code?: string }).code || 'INTERNAL_ERROR'
    const statusCode = error.statusCode || 500
    return reply.status(statusCode).send({
      type: 'error',
      code,
      message: error.message || String(error),
    })
  })
}

/**
 * Attach an `onRequest` hook that stamps each request with
 * `performanceStartMs`. The `onResponse` hook in `registerResponseMetrics`
 * uses this stamp to compute the route latency that lands in
 * `NexusMetrics.routes`.
 *
 * The `performanceStartMs` field is declared via FastifyRequest module
 * augmentation in `app.ts` — both hooks share the same declaration.
 */
export function registerRequestMetricsStamp(app: FastifyInstance, metrics: NexusMetrics): void {
  app.addHook('onRequest', async request => {
    request.performanceStartMs = metrics.now()
  })
}

/**
 * Attach an `onRequest` hook that enforces the Nexus API key.
 *
 * Behaviour:
 * - The `/health` route is always public — local monitoring tools
 *   poll it without credentials.
 * - The key is read from either the `x-nexus-api-key` header or the
 *   `Authorization: Bearer <key>` header (case-insensitive scheme).
 * - Any request without a matching key returns `401` with the
 *   canonical `{ type: 'error', code: 'UNAUTHORIZED' }` envelope.
 *
 * The `apiKey` argument is the resolved key (already merged with the
 * `NEXUS_API_KEY` env-var fallback by the composition root). Passing
 * `undefined` is a no-op — the hook is simply not registered.
 */
export function registerApiKeyAuth(app: FastifyInstance, apiKey: string | undefined): void {
  if (!apiKey) return
  app.addHook('onRequest', async (request, reply) => {
    const pathname = request.url.split('?')[0]
    if (pathname === '/health') {
      return
    }

    const authHeader = request.headers['authorization']
    let clientKey = request.headers['x-nexus-api-key']
    if (!clientKey && typeof authHeader === 'string') {
      const parts = authHeader.split(' ')
      if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
        clientKey = parts[1]
      }
    }

    if (clientKey !== apiKey) {
      return reply.code(401).send({
        type: 'error',
        code: 'UNAUTHORIZED',
        message: 'Unauthorized: Invalid or missing API key',
      })
    }
  })
}

/**
 * Attach an `onResponse` hook that records per-route latency into the
 * `NexusMetrics.routes` map. The metric key is `"<METHOD> <url>"`,
 * preferring `request.routeOptions.url` (the route pattern, e.g.
 * `/v1/sessions/:sessionId`) over the raw URL so cardinality stays
 * bounded. If `routeOptions.url` is absent (404 / unmatched path), the
 * raw URL is used as a fallback.
 */
export function registerResponseMetrics(app: FastifyInstance, metrics: NexusMetrics): void {
  app.addHook('onResponse', async (request, reply) => {
    metrics.recordRoute(
      `${request.method} ${request.routeOptions.url ?? request.url}`,
      reply.statusCode,
      metrics.now() - request.performanceStartMs,
    )
  })
}

/**
 * Convenience wrapper that registers all four cross-cutting pieces of
 * middleware in the canonical order. Composition roots that want a
 * non-default auth path can call the individual helpers instead.
 */
export function registerCoreMiddleware(app: FastifyInstance, metrics: NexusMetrics, apiKey: string | undefined): void {
  registerErrorHandler(app)
  registerRequestMetricsStamp(app, metrics)
  registerApiKeyAuth(app, apiKey)
  registerResponseMetrics(app, metrics)
}
