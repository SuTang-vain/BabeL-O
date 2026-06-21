import assert from 'node:assert/strict'
import { test } from 'node:test'
import Fastify, { type FastifyInstance } from 'fastify'
import { NexusMetrics } from '../src/nexus/metrics.js'
import {
  registerApiKeyAuth,
  registerCoreMiddleware,
  registerErrorHandler,
  registerRequestMetricsStamp,
  registerResponseMetrics,
} from '../src/nexus/middleware.js'

/**
 * Build a Fastify instance that has an `onRequest` hook set up to
 * stamp `performanceStartMs` (the canonical augmentation lives in
 * `app.ts`; this re-declares it locally so the middleware tests are
 * self-contained).
 */
function buildAppWithMetricsStamp(metrics: NexusMetrics): FastifyInstance {
  const app = Fastify({ logger: false })
  app.addHook('onRequest', async request => {
    ;(request as { performanceStartMs?: number }).performanceStartMs = metrics.now()
  })
  return app
}

test('registerErrorHandler rewrites Fastify validation errors into 400 INVALID_REQUEST envelope', async () => {
  const app = Fastify({ logger: false })
  registerErrorHandler(app)
  app.get('/schema-fail', async () => {
    // Simulate a Fastify schema validation error — the validation flag
    // is the canonical signal for body/query/params schema failures.
    const err: any = new Error('body must have required property prompt')
    err.validation = [{ instancePath: '/body', keyword: 'required', message: "must have required property 'prompt'" }]
    throw err
  })
  try {
    const response = await app.inject({ method: 'GET', url: '/schema-fail' })
    assert.equal(response.statusCode, 400)
    const body = response.json()
    assert.equal(body.type, 'error')
    assert.equal(body.code, 'INVALID_REQUEST')
    assert.equal(typeof body.message, 'string')
  } finally {
    await app.close()
  }
})

test('registerErrorHandler rewrites ZodError into 400 INVALID_REQUEST envelope', async () => {
  const app = Fastify({ logger: false })
  registerErrorHandler(app)
  app.get('/zod-fail', async () => {
    const err: any = new Error('Invalid input')
    err.name = 'ZodError'
    throw err
  })
  try {
    const response = await app.inject({ method: 'GET', url: '/zod-fail' })
    assert.equal(response.statusCode, 400)
    const body = response.json()
    assert.equal(body.code, 'INVALID_REQUEST')
    assert.equal(body.type, 'error')
  } finally {
    await app.close()
  }
})

test('registerErrorHandler forwards non-validation errors with their statusCode + code', async () => {
  const app = Fastify({ logger: false })
  registerErrorHandler(app)
  app.get('/custom', async () => {
    const err: any = new Error('something specific broke')
    err.statusCode = 418
    err.code = 'IM_A_TEAPOT'
    throw err
  })
  try {
    const response = await app.inject({ method: 'GET', url: '/custom' })
    assert.equal(response.statusCode, 418)
    const body = response.json()
    assert.equal(body.type, 'error')
    assert.equal(body.code, 'IM_A_TEAPOT')
    assert.equal(body.message, 'something specific broke')
  } finally {
    await app.close()
  }
})

test('registerErrorHandler falls back to 500 INTERNAL_ERROR when error has no statusCode / code', async () => {
  const app = Fastify({ logger: false })
  registerErrorHandler(app)
  app.get('/explode', async () => {
    throw new Error('boom')
  })
  try {
    const response = await app.inject({ method: 'GET', url: '/explode' })
    assert.equal(response.statusCode, 500)
    const body = response.json()
    assert.equal(body.code, 'INTERNAL_ERROR')
    assert.equal(body.type, 'error')
    assert.equal(body.message, 'boom')
  } finally {
    await app.close()
  }
})

test('registerApiKeyAuth returns 401 UNAUTHORIZED when no key is provided', async () => {
  const app = Fastify({ logger: false })
  registerApiKeyAuth(app, 'secret-key')
  app.get('/protected', async () => ({ ok: true }))
  try {
    const response = await app.inject({ method: 'GET', url: '/protected' })
    assert.equal(response.statusCode, 401)
    const body = response.json()
    assert.equal(body.type, 'error')
    assert.equal(body.code, 'UNAUTHORIZED')
  } finally {
    await app.close()
  }
})

test('registerApiKeyAuth accepts the x-nexus-api-key header', async () => {
  const app = Fastify({ logger: false })
  registerApiKeyAuth(app, 'secret-key')
  app.get('/protected', async () => ({ ok: true }))
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { 'x-nexus-api-key': 'secret-key' },
    })
    assert.equal(response.statusCode, 200)
  } finally {
    await app.close()
  }
})

test('registerApiKeyAuth accepts a Bearer Authorization header (case-insensitive scheme)', async () => {
  const app = Fastify({ logger: false })
  registerApiKeyAuth(app, 'secret-key')
  app.get('/protected', async () => ({ ok: true }))
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer secret-key' },
    })
    assert.equal(response.statusCode, 200)

    const lowerResponse = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'bearer secret-key' },
    })
    assert.equal(lowerResponse.statusCode, 200)
  } finally {
    await app.close()
  }
})

test('registerApiKeyAuth rejects a wrong key with 401', async () => {
  const app = Fastify({ logger: false })
  registerApiKeyAuth(app, 'secret-key')
  app.get('/protected', async () => ({ ok: true }))
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { 'x-nexus-api-key': 'wrong-key' },
    })
    assert.equal(response.statusCode, 401)
    const body = response.json()
    assert.equal(body.code, 'UNAUTHORIZED')
  } finally {
    await app.close()
  }
})

test('registerApiKeyAuth always allows /health without credentials', async () => {
  const app = Fastify({ logger: false })
  registerApiKeyAuth(app, 'secret-key')
  app.get('/health', async () => ({ ok: true }))
  try {
    const response = await app.inject({ method: 'GET', url: '/health' })
    assert.equal(response.statusCode, 200)
  } finally {
    await app.close()
  }
})

test('registerApiKeyAuth is a no-op when apiKey is undefined', async () => {
  const app = Fastify({ logger: false })
  registerApiKeyAuth(app, undefined)
  app.get('/protected', async () => ({ ok: true }))
  try {
    const response = await app.inject({ method: 'GET', url: '/protected' })
    assert.equal(response.statusCode, 200)
  } finally {
    await app.close()
  }
})

test('registerRequestMetricsStamp populates performanceStartMs on every request', async () => {
  const metrics = new NexusMetrics()
  const app = buildAppWithMetricsStamp(metrics)
  // Drop the outer stamp hook and replace with the canonical one.
  // We rebuild the app so we exercise only the helper under test.
  const app2 = Fastify({ logger: false })
  registerRequestMetricsStamp(app2, metrics)
  let captured: number | undefined
  app2.get('/probe', async request => {
    captured = (request as { performanceStartMs?: number }).performanceStartMs
    return { ok: true }
  })
  try {
    await app2.inject({ method: 'GET', url: '/probe' })
    assert.equal(typeof captured, 'number')
    assert.ok(captured! > 0)
  } finally {
    await app2.close()
  }
})

test('registerResponseMetrics records route metrics keyed by method + route url', async () => {
  const metrics = new NexusMetrics()
  const app = buildAppWithMetricsStamp(metrics)
  registerResponseMetrics(app, metrics)
  app.get('/v1/probe/:id', async () => ({ ok: true }))
  try {
    await app.inject({ method: 'GET', url: '/v1/probe/abc-123' })
    const snapshot = metrics.snapshot()
    // snapshot.routes is an array of RouteMetricWithAverage, sorted by
    // route key. The route key is "GET /v1/probe/:id" (routeOptions.url),
    // not the raw URL — this keeps cardinality bounded for high-volume
    // routes.
    const target = snapshot.routes.find(r => r.route === 'GET /v1/probe/:id')
    assert.ok(target, `route 'GET /v1/probe/:id' must be recorded; got: ${snapshot.routes.map(r => r.route).join(', ')}`)
    assert.ok(target!.count >= 1, 'route count must be >= 1')
    assert.ok(target!.totalMs >= 0, 'route totalMs must be >= 0')
  } finally {
    await app.close()
  }
})

test('registerCoreMiddleware wires all four pieces in canonical order', async () => {
  const metrics = new NexusMetrics()
  const app = Fastify({ logger: false })
  registerCoreMiddleware(app, metrics, 'core-key')
  app.get('/health', async () => ({ ok: true }))
  app.get('/v1/probe', async () => ({ ok: true }))
  let captured: number | undefined
  app.addHook('onRequest', async request => {
    captured = (request as { performanceStartMs?: number }).performanceStartMs
  })
  try {
    // /health bypasses auth and should succeed without credentials.
    const healthResp = await app.inject({ method: 'GET', url: '/health' })
    assert.equal(healthResp.statusCode, 200)

    // /v1/probe without the key → 401.
    const unauthResp = await app.inject({ method: 'GET', url: '/v1/probe' })
    assert.equal(unauthResp.statusCode, 401)

    // /v1/probe with the key → 200, performanceStartMs is stamped.
    const authResp = await app.inject({
      method: 'GET',
      url: '/v1/probe',
      headers: { 'x-nexus-api-key': 'core-key' },
    })
    assert.equal(authResp.statusCode, 200)
    assert.equal(typeof captured, 'number')
  } finally {
    await app.close()
  }
})
