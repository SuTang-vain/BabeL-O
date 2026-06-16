import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { createNexusApp } from '../src/nexus/app.js'
import { createDefaultNexusRuntime } from '../src/nexus/createRuntime.js'

async function buildApp() {
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: '/tmp' })
  await app.ready()
  return app
}

function generateDraftFor(title: string, idOverride?: string) {
  return {
    id: idOverride ?? title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
    name: title,
    description: title,
    version: 1,
    status: 'draft',
    source: 'project' as const,
    scope: 'project' as const,
    triggers: title.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3).slice(0, 4),
    priority: 50,
    risk: 'read' as const,
    allowedTools: [],
    content: `# Purpose\n\nHelp with ${title}.\n\n# Procedure\n\n1. Read the task.\n2. Apply guidance.`,
  }
}

test('POST /v1/skills/save returns previewOnly when confirm is false', async () => {
  const app = await buildApp()
  try {
    const draft = await generateDraftFor('My Personal Workflow Tool')
    const response = await app.inject({
      method: 'POST',
      url: '/v1/skills/save',
      payload: {
        cwd: path.join(os.tmpdir(), `babel-o-save-route-preview-${Date.now()}`),
        draft,
        confirm: false,
      },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.ok, true)
    assert.equal(body.previewOnly, true)
    assert.equal(body.isNewFile, true)
    assert.match(body.filePath, /\.babel-o\/skills\/my-personal-workflow-tool\.md$/)
  } finally {
    await app.close()
  }
})

test('POST /v1/skills/save persists project scope file on disk with confirm=true', async () => {
  const app = await buildApp()
  const cwd = path.join(os.tmpdir(), `babel-o-save-route-ok-${Date.now()}`)
  try {
    const draft = await generateDraftFor('My Project Workflow Tool')
    const response = await app.inject({
      method: 'POST',
      url: '/v1/skills/save',
      payload: { cwd, draft, confirm: true, scope: 'project' },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.ok, true)
    assert.equal(body.format, 'new')
    assert.match(body.filePath, /\.babel-o\/skills\/my-project-workflow-tool\.md$/)
    assert.equal(body.saved.skillId, 'my-project-workflow-tool')
    assert.equal(body.saved.scope, 'project')

    // File on disk
    const onDisk = await fs.readFile(body.filePath, 'utf-8')
    assert.match(onDisk, /id: my-project-workflow-tool/)

    // Cleanup
    await fs.rm(cwd, { recursive: true, force: true })
  } finally {
    await app.close()
  }
})

test('POST /v1/skills/save returns 409 SKILL_SAVE_OVERWRITE_REQUIRED without overwrite flag', async () => {
  const app = await buildApp()
  const cwd = path.join(os.tmpdir(), `babel-o-save-route-409-${Date.now()}`)
  const projectSkillsDir = path.join(cwd, '.babel-o', 'skills')
  try {
    await fs.mkdir(projectSkillsDir, { recursive: true })
    await fs.writeFile(
      path.join(projectSkillsDir, 'my-existing-tool.md'),
      '---\nid: my-existing-tool\n---\nold body',
    )

    const draft = await generateDraftFor('My Existing Tool')
    draft.id = 'my-existing-tool'
    const response = await app.inject({
      method: 'POST',
      url: '/v1/skills/save',
      payload: { cwd, draft, confirm: true, scope: 'project' },
    })
    assert.equal(response.statusCode, 409)
    const body = response.json()
    assert.equal(body.ok, false)
    assert.equal(body.errorCode, 'SKILL_SAVE_OVERWRITE_REQUIRED')
  } finally {
    await app.close()
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

test('POST /v1/skills/save with overwrite=true replaces existing file', async () => {
  const app = await buildApp()
  const cwd = path.join(os.tmpdir(), `babel-o-save-route-overwrite-${Date.now()}`)
  const projectSkillsDir = path.join(cwd, '.babel-o', 'skills')
  try {
    await fs.mkdir(projectSkillsDir, { recursive: true })
    await fs.writeFile(
      path.join(projectSkillsDir, 'my-existing-tool.md'),
      '---\nid: my-existing-tool\n---\nold body',
    )

    const draft = await generateDraftFor('My Existing Tool')
    draft.id = 'my-existing-tool'
    const response = await app.inject({
      method: 'POST',
      url: '/v1/skills/save',
      payload: { cwd, draft, confirm: true, scope: 'project', overwrite: true },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.ok, true)
    assert.equal(body.format, 'overwrite')

    const onDisk = await fs.readFile(body.filePath, 'utf-8')
    assert.doesNotMatch(onDisk, /old body/)
  } finally {
    await app.close()
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

test('POST /v1/skills/save persists user scope under BABEL_O_USER_SKILLS_DIR (test isolation)', async () => {
  const app = await buildApp()
  const cwd = path.join(os.tmpdir(), `babel-o-save-route-user-${Date.now()}`)
  const userDir = process.env.BABEL_O_USER_SKILLS_DIR ?? path.join(os.homedir(), '.babel-o', 'skills')
  try {
    const draft = await generateDraftFor('My Personal Workflow Tool')

    const response = await app.inject({
      method: 'POST',
      url: '/v1/skills/save',
      payload: { cwd, draft, confirm: true, scope: 'user' },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.ok, true)
    assert.equal(body.scope, 'user')
    assert.equal(body.filePath, path.join(userDir, 'my-personal-workflow-tool.md'))
  } finally {
    await app.close()
    await fs.rm(cwd, { recursive: true, force: true })
    // Clean up the user-scope file we wrote so subsequent tests in the same
    // shared BABEL_O_USER_SKILLS_DIR do not see it.
    await fs.rm(path.join(userDir, 'my-personal-workflow-tool.md'), { force: true })
  }
})

test('POST /v1/skills/save returns 400 for invalid draft (missing id)', async () => {
  const app = await buildApp()
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/skills/save',
      payload: {
        cwd: '/tmp',
        // deliberately missing `id` field
        draft: { name: 'No ID' },
        confirm: true,
      },
    })
    // zod rejects missing required field at the schema level → 400.
    assert.equal(response.statusCode, 400)
  } finally {
    await app.close()
  }
})
