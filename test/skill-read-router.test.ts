import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createNexusApp } from '../src/nexus/app.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'

test('skill read router lists and shows skills without touching write endpoints', async () => {
  const cwd = join(tmpdir(), `babel-o-skill-read-router-${Date.now()}`)
  const builtInDir = join(cwd, 'built-in')
  await mkdir(builtInDir, { recursive: true })
  await writeFile(
    join(builtInDir, 'coding.md'),
    `---
id: coding
name: Coding
triggers: [code]
priority: 5
risk: read
---
coding body`,
  )

  const app = await createNexusApp({
    storage: new MemoryStorage(),
    defaultCwd: cwd,
    runtime: { listTools: () => [] } as any,
  })
  try {
    const list = await app.inject({
      method: 'GET',
      url: `/v1/skills?cwd=${encodeURIComponent(cwd)}&builtInDir=${encodeURIComponent(builtInDir)}`,
    })
    assert.equal(list.statusCode, 200)
    const listBody = list.json()
    assert.equal(listBody.ok, true)
    assert.equal(listBody.skills.length, 1)
    assert.equal(listBody.skills[0].id, 'coding')
    assert.equal(listBody.skills[0].source, 'builtin')

    const show = await app.inject({
      method: 'GET',
      url: `/v1/skills/coding?cwd=${encodeURIComponent(cwd)}&builtInDir=${encodeURIComponent(builtInDir)}`,
    })
    assert.equal(show.statusCode, 200)
    const showBody = show.json()
    assert.equal(showBody.ok, true)
    assert.equal(showBody.skill.id, 'coding')
    assert.match(showBody.skill.body, /coding body/)

    const missing = await app.inject({
      method: 'GET',
      url: `/v1/skills/missing?cwd=${encodeURIComponent(cwd)}&builtInDir=${encodeURIComponent(builtInDir)}`,
    })
    assert.equal(missing.statusCode, 404)
    const missingBody = missing.json()
    assert.equal(missingBody.ok, false)
    assert.equal(missingBody.errorCode, 'SKILL_NOT_FOUND')
  } finally {
    await app.close()
    await rm(cwd, { recursive: true, force: true })
  }
})
