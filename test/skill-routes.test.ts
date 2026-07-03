import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { createNexusApp } from '../src/nexus/app.js'
import { createDefaultNexusRuntime } from '../src/nexus/createRuntime.js'

async function buildAppWithCwd(defaultCwd: string) {
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd })
  await app.ready()
  return app
}

test('GET /v1/skills returns empty list when no skills are present', async () => {
  const cwd = path.join(os.tmpdir(), `babel-o-skill-routes-empty-${Date.now()}`)
  const builtInDir = path.join(cwd, 'built-in')
  await fs.mkdir(builtInDir, { recursive: true })
  const app = await buildAppWithCwd(cwd)
  try {
    const url = `/v1/skills?cwd=${encodeURIComponent(cwd)}&builtInDir=${encodeURIComponent(builtInDir)}`
    const response = await app.inject({ method: 'GET', url })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.ok, true)
    assert.deepEqual(body.skills, [])
    assert.equal(body.diagnostics.skippedCount, 0)
    assert.equal(body.diagnostics.overlaidCount, 0)
  } finally {
    await app.close()
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

test('GET /v1/skills lists built-in and project skills with source attribution', async () => {
  const cwd = path.join(os.tmpdir(), `babel-o-skill-routes-list-${Date.now()}`)
  const builtInDir = path.join(cwd, 'built-in')
  const projectSkillsDir = path.join(cwd, '.babel-o', 'skills')
  await fs.mkdir(builtInDir, { recursive: true })
  await fs.mkdir(projectSkillsDir, { recursive: true })

  await fs.writeFile(
    path.join(builtInDir, 'coding.md'),
    `---
id: coding
name: Coding
triggers: [code]
priority: 5
---
coding body`,
  )
  await fs.writeFile(
    path.join(projectSkillsDir, 'testing.md'),
    `---
id: testing
name: Testing
triggers: [test]
priority: 10
---
testing body`,
  )

  const app = await buildAppWithCwd(cwd)
  try {
    const url = `/v1/skills?cwd=${encodeURIComponent(cwd)}&builtInDir=${encodeURIComponent(builtInDir)}`
    const response = await app.inject({ method: 'GET', url })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.ok, true)
    assert.equal(body.skills.length, 2)
    const ids = body.skills.map((s: { id: string }) => s.id)
    assert.ok(ids.includes('coding'))
    assert.ok(ids.includes('testing'))
    const testing = body.skills.find((s: { id: string }) => s.id === 'testing')
    assert.equal(testing.source, 'project')
    assert.equal(testing.priority, 10)
  } finally {
    await app.close()
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

test('GET /v1/skills?source=project filters by source', async () => {
  const cwd = path.join(os.tmpdir(), `babel-o-skill-routes-filter-${Date.now()}`)
  const builtInDir = path.join(cwd, 'built-in')
  const projectSkillsDir = path.join(cwd, '.babel-o', 'skills')
  await fs.mkdir(builtInDir, { recursive: true })
  await fs.mkdir(projectSkillsDir, { recursive: true })

  await fs.writeFile(
    path.join(builtInDir, 'coding.md'),
    `---
id: coding
triggers: [code]
priority: 5
---
coding`,
  )
  await fs.writeFile(
    path.join(projectSkillsDir, 'testing.md'),
    `---
id: testing
triggers: [test]
priority: 10
---
testing`,
  )

  const app = await buildAppWithCwd(cwd)
  try {
    const url = `/v1/skills?cwd=${encodeURIComponent(cwd)}&source=project&builtInDir=${encodeURIComponent(builtInDir)}`
    const response = await app.inject({
      method: 'GET',
      url,
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.skills.length, 1)
    assert.equal(body.skills[0].id, 'testing')
    assert.equal(body.skills[0].source, 'project')
  } finally {
    await app.close()
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

test('GET /v1/skills/:id returns full skill with body when present', async () => {
  const cwd = path.join(os.tmpdir(), `babel-o-skill-routes-show-${Date.now()}`)
  const builtInDir = path.join(cwd, 'built-in')
  await fs.mkdir(builtInDir, { recursive: true })

  await fs.writeFile(
    path.join(builtInDir, 'coding.md'),
    `---
id: coding
name: Coding
triggers: [code]
priority: 5
risk: read
---
coding body`,
  )

  const app = await buildAppWithCwd(cwd)
  try {
    const url = `/v1/skills/coding?cwd=${encodeURIComponent(cwd)}&builtInDir=${encodeURIComponent(builtInDir)}`
    const response = await app.inject({ method: 'GET', url })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.ok, true)
    assert.equal(body.skill.id, 'coding')
    assert.equal(body.skill.risk, 'read')
    assert.match(body.skill.body, /coding body/)
  } finally {
    await app.close()
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

test('GET /v1/skills/:id returns 404 SKILL_NOT_FOUND for missing id', async () => {
  const cwd = path.join(os.tmpdir(), `babel-o-skill-routes-missing-${Date.now()}`)
  const builtInDir = path.join(cwd, 'built-in')
  await fs.mkdir(builtInDir, { recursive: true })

  const app = await buildAppWithCwd(cwd)
  try {
    const url = `/v1/skills/missing?cwd=${encodeURIComponent(cwd)}&builtInDir=${encodeURIComponent(builtInDir)}`
    const response = await app.inject({ method: 'GET', url })
    assert.equal(response.statusCode, 404)
    const body = response.json()
    assert.equal(body.ok, false)
    assert.equal(body.errorCode, 'SKILL_NOT_FOUND')
    assert.equal(body.id, 'missing')
  } finally {
    await app.close()
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

test('POST /v1/skills/validate validates raw markdown body and reports diagnostics', async () => {
  const cwd = path.join(os.tmpdir(), `babel-o-skill-routes-validate-${Date.now()}`)
  const app = await buildAppWithCwd(cwd)
  try {
    // valid body
    const validResponse = await app.inject({
      method: 'POST',
      url: '/v1/skills/validate',
      payload: {
        body: `---
id: test-skill
name: Test
triggers: [test]
priority: 5
---
body`,
      },
    })
    assert.equal(validResponse.statusCode, 200)
    const validBody = validResponse.json()
    assert.equal(validBody.ok, true)
    assert.equal(validBody.skillId, 'test-skill')
    assert.equal(validBody.errorCount, 0)

    // invalid body (missing id) — parseFrontMatter returns null when id is missing,
    // so the route returns SKILL_PARSE_FAILED (not the validator's SKILL_ID_MISSING).
    const invalidResponse = await app.inject({
      method: 'POST',
      url: '/v1/skills/validate',
      payload: {
        body: `---
name: Missing Id
triggers: [test]
---
body`,
      },
    })
    assert.equal(invalidResponse.statusCode, 422)
    const invalidBody = invalidResponse.json()
    assert.equal(invalidBody.ok, false)
    assert.ok(invalidBody.diagnostics.some((d: { code: string }) => d.code === 'SKILL_PARSE_FAILED'))
  } finally {
    await app.close()
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

test('POST /v1/skills/invoke returns a prompt envelope referencing the skill', async () => {
  const cwd = path.join(os.tmpdir(), `babel-o-skill-routes-invoke-${Date.now()}`)
  const builtInDir = path.join(cwd, 'built-in')
  await fs.mkdir(builtInDir, { recursive: true })
  await fs.writeFile(
    path.join(builtInDir, 'testing.md'),
    `---
id: testing
name: Testing
triggers: [test]
priority: 5
---
testing body`,
  )

  const app = await buildAppWithCwd(cwd)
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/skills/invoke',
      payload: {
        cwd,
        builtInDir,
        id: 'testing',
        prompt: 'write tests for runtime',
        mode: 'explicit',
      },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.ok, true)
    assert.equal(body.skillId, 'testing')
    assert.equal(body.mode, 'explicit')
    assert.match(body.promptEnvelope, /Use the following developer skill explicitly/)
    assert.match(body.promptEnvelope, /<skill id="testing"/)
    assert.match(body.promptEnvelope, /User task:\nwrite tests for runtime/)
  } finally {
    await app.close()
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

test('POST /v1/skills/invoke returns SKILL_NOT_FOUND for unknown id', async () => {
  const cwd = path.join(os.tmpdir(), `babel-o-skill-routes-invoke-missing-${Date.now()}`)
  const builtInDir = path.join(cwd, 'built-in')
  await fs.mkdir(builtInDir, { recursive: true })
  const app = await buildAppWithCwd(cwd)
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/skills/invoke',
      payload: { cwd, id: 'unknown', prompt: 'noop' },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.ok, false)
    assert.equal(body.errorCode, 'SKILL_NOT_FOUND')
  } finally {
    await app.close()
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

test('POST /v1/skills/import/preview previews an Agent Skills package without persisting it', async () => {
  const cwd = path.join(os.tmpdir(), `babel-o-skill-routes-import-${Date.now()}`)
  const builtInDir = path.join(cwd, 'built-in')
  const sourcePackageDir = path.join(cwd, 'external-skills', 'context-debugging')
  await fs.mkdir(builtInDir, { recursive: true })
  await fs.mkdir(path.join(sourcePackageDir, 'references'), { recursive: true })
  await fs.writeFile(
    path.join(sourcePackageDir, 'SKILL.md'),
    `---
name: context-debugging
description: Debug context assembly and tool suppression issues.
allowed-tools: Read Grep
metadata:
  babel-o:
    triggers:
      - context assembly
---
# Purpose
Debug context issues.`,
  )
  await fs.writeFile(path.join(sourcePackageDir, 'references', 'flow.md'), '# Flow')

  const app = await buildAppWithCwd(cwd)
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/skills/import/preview',
      payload: {
        cwd,
        builtInDir,
        sourcePath: sourcePackageDir,
      },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.ok, true)
    assert.equal(body.previewOnly, true)
    assert.equal(body.skill.id, 'context-debugging')
    assert.equal(body.conversion.sourceFormat, 'agent-skills-v1')
    assert.equal(body.resources[0].path, 'references/flow.md')
    assert.equal(body.targetPath, path.join(cwd, '.babel-o', 'skills', 'context-debugging'))
    await assert.rejects(fs.access(path.join(cwd, '.babel-o', 'skills', 'context-debugging')))
  } finally {
    await app.close()
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

test('POST /v1/skills/import/install requires confirm before persisting an Agent Skills package', async () => {
  const cwd = path.join(os.tmpdir(), `babel-o-skill-routes-import-install-${Date.now()}`)
  const builtInDir = path.join(cwd, 'built-in')
  const sourcePackageDir = path.join(cwd, 'external-skills', 'context-debugging')
  await fs.mkdir(builtInDir, { recursive: true })
  await fs.mkdir(path.join(sourcePackageDir, 'references'), { recursive: true })
  await fs.writeFile(
    path.join(sourcePackageDir, 'SKILL.md'),
    `---
name: context-debugging
description: Debug context assembly and tool suppression issues.
metadata:
  babel-o:
    triggers:
      - context assembly
---
# Purpose
Debug context issues.`,
  )
  await fs.writeFile(path.join(sourcePackageDir, 'references', 'flow.md'), '# Flow')

  const app = await buildAppWithCwd(cwd)
  try {
    const previewResponse = await app.inject({
      method: 'POST',
      url: '/v1/skills/import/install',
      payload: {
        cwd,
        builtInDir,
        sourcePath: sourcePackageDir,
        confirm: false,
      },
    })
    assert.equal(previewResponse.statusCode, 422)
    const previewBody = previewResponse.json()
    assert.equal(previewBody.ok, false)
    assert.equal(previewBody.errorCode, 'SKILL_IMPORT_NOT_CONFIRMED')
    await assert.rejects(fs.access(path.join(cwd, '.babel-o', 'skills', 'context-debugging')))

    const installResponse = await app.inject({
      method: 'POST',
      url: '/v1/skills/import/install',
      payload: {
        cwd,
        builtInDir,
        sourcePath: sourcePackageDir,
        confirm: true,
      },
    })
    assert.equal(installResponse.statusCode, 200)
    const installBody = installResponse.json()
    assert.equal(installBody.ok, true)
    assert.equal(installBody.skillId, 'context-debugging')
    assert.equal(installBody.format, 'new')
    const manifest = await fs.readFile(path.join(cwd, '.babel-o', 'skills', 'context-debugging', 'SKILL.md'), 'utf-8')
    assert.match(manifest, /name: context-debugging/)
    const reference = await fs.readFile(path.join(cwd, '.babel-o', 'skills', 'context-debugging', 'references', 'flow.md'), 'utf-8')
    assert.equal(reference, '# Flow')
  } finally {
    await app.close()
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

test('POST /v1/skills/export/preview previews an Agent Skills package without persisting it', async () => {
  const cwd = path.join(os.tmpdir(), `babel-o-skill-routes-export-${Date.now()}`)
  const builtInDir = path.join(cwd, 'built-in')
  const projectSkillsDir = path.join(cwd, '.babel-o', 'skills')
  await fs.mkdir(builtInDir, { recursive: true })
  await fs.mkdir(projectSkillsDir, { recursive: true })
  await fs.writeFile(
    path.join(projectSkillsDir, 'context-debugging.md'),
    `---
id: context-debugging
name: Context Debugging
description: Debug context assembly and tool suppression issues.
triggers: [context assembly]
priority: 80
risk: read
allowedTools: [Read, Grep]
---
# Purpose
Debug context issues.`,
  )

  const app = await buildAppWithCwd(cwd)
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/skills/export/preview',
      payload: {
        cwd,
        builtInDir,
        id: 'context-debugging',
        targetDir: 'exports',
      },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.ok, true)
    assert.equal(body.previewOnly, true)
    assert.equal(body.packageRoot, path.join(cwd, 'exports', 'context-debugging'))
    assert.match(body.manifest, /name: context-debugging/)
    assert.match(body.manifest, /metadata:\n  babel-o:/)
    await assert.rejects(fs.access(path.join(cwd, 'exports', 'context-debugging')))
  } finally {
    await app.close()
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

test('POST /v1/skills/export/write requires confirm before persisting an Agent Skills package', async () => {
  const cwd = path.join(os.tmpdir(), `babel-o-skill-routes-export-write-${Date.now()}`)
  const builtInDir = path.join(cwd, 'built-in')
  const projectSkillsDir = path.join(cwd, '.babel-o', 'skills')
  await fs.mkdir(builtInDir, { recursive: true })
  await fs.mkdir(projectSkillsDir, { recursive: true })
  const packageDir = path.join(projectSkillsDir, 'context-debugging')
  await fs.mkdir(path.join(packageDir, 'references'), { recursive: true })
  await fs.writeFile(
    path.join(packageDir, 'SKILL.md'),
    `---
name: context-debugging
description: Debug context assembly and tool suppression issues.
allowed-tools: Read Grep
metadata:
  babel-o:
    displayName: Context Debugging
    triggers:
      - context assembly
    priority: 80
    risk: read
---
# Purpose
Debug context issues.`,
  )
  await fs.writeFile(path.join(packageDir, 'references', 'flow.md'), '# Flow')

  const app = await buildAppWithCwd(cwd)
  try {
    const previewResponse = await app.inject({
      method: 'POST',
      url: '/v1/skills/export/write',
      payload: {
        cwd,
        builtInDir,
        id: 'context-debugging',
        targetDir: 'exports',
        confirm: false,
      },
    })
    assert.equal(previewResponse.statusCode, 422)
    const previewBody = previewResponse.json()
    assert.equal(previewBody.ok, false)
    assert.equal(previewBody.errorCode, 'SKILL_EXPORT_NOT_CONFIRMED')
    await assert.rejects(fs.access(path.join(cwd, 'exports', 'context-debugging')))

    const writeResponse = await app.inject({
      method: 'POST',
      url: '/v1/skills/export/write',
      payload: {
        cwd,
        builtInDir,
        id: 'context-debugging',
        targetDir: 'exports',
        confirm: true,
      },
    })
    assert.equal(writeResponse.statusCode, 200)
    const writeBody = writeResponse.json()
    assert.equal(writeBody.ok, true)
    assert.equal(writeBody.format, 'new')
    const manifest = await fs.readFile(path.join(cwd, 'exports', 'context-debugging', 'SKILL.md'), 'utf-8')
    assert.match(manifest, /name: context-debugging/)
    assert.match(manifest, /metadata:\n  babel-o:/)
    const reference = await fs.readFile(path.join(cwd, 'exports', 'context-debugging', 'references', 'flow.md'), 'utf-8')
    assert.equal(reference, '# Flow')
  } finally {
    await app.close()
    await fs.rm(cwd, { recursive: true, force: true })
  }
})
