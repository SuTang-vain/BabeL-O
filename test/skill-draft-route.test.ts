import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNexusApp } from '../src/nexus/app.js'
import { createDefaultNexusRuntime } from '../src/nexus/createRuntime.js'

async function buildApp() {
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: '/tmp' })
  await app.ready()
  return app
}

test('POST /v1/skills/draft returns a normalized draft with body and zero diagnostics for clean input', async () => {
  const app = await buildApp()
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/skills/draft',
      payload: {
        title: 'Permission Denial Recovery Workflow',
        description: 'Recover from denied tool calls.',
      },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.ok, true)
    assert.equal(body.draft.id, 'permission-denial-recovery-workflow')
    assert.equal(body.draft.status, 'draft')
    assert.equal(body.draft.scope, 'project')
    assert.equal(body.draft.risk, 'read')
    assert.ok(body.draft.triggers.length >= 2)
    assert.match(body.draft.body, /# Purpose/)
    assert.match(body.draft.body, /# Procedure/)
    assert.match(body.draft.body, /# Failure handling/)
    assert.equal(body.redactionWarnings.length, 0)
    assert.equal(body.validationWarnings.length, 0)
  } finally {
    await app.close()
  }
})

test('POST /v1/skills/draft returns 400 for empty title (zod schema rejects min(1))', async () => {
  const app = await buildApp()
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/skills/draft',
      payload: { title: '' },
    })
    // zod `title: z.string().min(1)` rejects the request before it reaches
    // the handler; the handler's SKILL_DRAFT_INVALID_TITLE is reserved for
    // post-zod semantic rejections (e.g. deriveId failed).
    assert.equal(response.statusCode, 400)
  } finally {
    await app.close()
  }
})

test('POST /v1/skills/draft returns 422 for bad idHint', async () => {
  const app = await buildApp()
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/skills/draft',
      payload: { title: 'Some Title', idHint: 'Bad_Id' },
    })
    assert.equal(response.statusCode, 422)
    const body = response.json()
    assert.equal(body.ok, false)
    assert.equal(body.errorCode, 'SKILL_DRAFT_ID_CONFLICT')
  } finally {
    await app.close()
  }
})

test('POST /v1/skills/draft returns redaction warnings when session summary contains a bearer header', async () => {
  const app = await buildApp()
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/skills/draft',
      payload: {
        title: 'Token Safe Workflow Tool',
        sessionSummary: 'Used Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCD in call.',
      },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.ok, true)
    assert.ok(body.redactionWarnings.length >= 1)
    assert.equal(body.redactionWarnings[0].code, 'TOKEN_BEARER_HEADER')
    assert.match(body.draft.body, /\[REDACTED:Bearer header\]/)
    assert.doesNotMatch(body.draft.body, /abcdefghijklmnopqrstuvwxyz0123456789ABCD/)
  } finally {
    await app.close()
  }
})

test('POST /v1/skills/draft respects explicitOnly and emits empty triggers', async () => {
  const app = await buildApp()
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/skills/draft',
      payload: {
        title: 'Compile And Run',
        explicitOnly: true,
      },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.ok, true)
    assert.deepEqual(body.draft.triggers, [])
    assert.equal(body.draft.status, 'draft')
  } finally {
    await app.close()
  }
})

test('POST /v1/skills/draft maps scope to user when requested', async () => {
  const app = await buildApp()
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/skills/draft',
      payload: {
        title: 'My Personal Workflow Tool',
        scope: 'user',
      },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.ok, true)
    assert.equal(body.draft.scope, 'user')
  } finally {
    await app.close()
  }
})

test('POST /v1/skills/draft does not persist any file on disk', async () => {
  // Phase 4 contract: drafts are in-memory only.
  const app = await buildApp()
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/skills/draft',
      payload: { title: 'My Draft Workflow Tool' },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    // The response must not contain a filePath — Phase 4 never writes.
    assert.equal('filePath' in body.draft, false)
  } finally {
    await app.close()
  }
})
