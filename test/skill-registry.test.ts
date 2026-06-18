import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { loadSkillRegistry, validateRegistrySkill } from '../src/skills/registry.js'
import { SkillMatchedEventSchema } from '../src/shared/skillEvents.js'

test('loadSkillRegistry returns empty registry for empty tree', async () => {
  const cwd = path.join(os.tmpdir(), `babel-o-registry-empty-${Date.now()}`)
  const builtInDir = path.join(cwd, 'built-in')
  await fs.mkdir(builtInDir, { recursive: true })
  try {
    const reg = await loadSkillRegistry({ cwd, builtInDir })
    assert.deepStrictEqual(reg.list(), [])
    assert.deepStrictEqual(reg.diagnose().skipped, [])
    assert.deepStrictEqual(reg.diagnose().overlaid, [])
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

test('loadSkillRegistry normalizes built-in / project skills with source attribution', async () => {
  const cwd = path.join(os.tmpdir(), `babel-o-registry-${Date.now()}`)
  const builtInDir = path.join(cwd, 'built-in')
  const projectSkillsDir = path.join(cwd, '.babel-o', 'skills')
  await fs.mkdir(builtInDir, { recursive: true })
  await fs.mkdir(projectSkillsDir, { recursive: true })

  try {
    await fs.writeFile(
      path.join(builtInDir, 'coding.md'),
      `---
id: coding
name: Coding
triggers: [code, class]
priority: 5
---
Built-in coding body`,
    )
    await fs.writeFile(
      path.join(projectSkillsDir, 'testing.md'),
      `---
id: testing
name: Testing
triggers: [test, coverage]
priority: 10
risk: read
allowedTools: [Read, Grep]
---
Project testing body`,
    )

    const reg = await loadSkillRegistry({ cwd, builtInDir })
    const list = reg.list()
    assert.strictEqual(list.length, 2)

    const coding = list.find(s => s.id === 'coding')
    assert.ok(coding)
    assert.strictEqual(coding.source, 'builtin')
    assert.strictEqual(coding.scope, 'builtin')
    assert.strictEqual(coding.version, 1)
    assert.strictEqual(coding.status, 'active')
    assert.strictEqual(coding.description, 'Coding')
    assert.strictEqual(coding.risk, 'read')
    assert.deepStrictEqual(coding.allowedTools, [])

    const testing = list.find(s => s.id === 'testing')
    assert.ok(testing)
    assert.strictEqual(testing.source, 'project')
    assert.strictEqual(testing.risk, 'read')
    assert.deepStrictEqual(testing.allowedTools, ['Read', 'Grep'])
    assert.strictEqual(testing.content, 'Project testing body')
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

test('loadSkillRegistry records overlay when project shadows built-in', async () => {
  const cwd = path.join(os.tmpdir(), `babel-o-registry-overlay-${Date.now()}`)
  const builtInDir = path.join(cwd, 'built-in')
  const projectSkillsDir = path.join(cwd, '.babel-o', 'skills')
  await fs.mkdir(builtInDir, { recursive: true })
  await fs.mkdir(projectSkillsDir, { recursive: true })

  try {
    await fs.writeFile(
      path.join(builtInDir, 'coding.md'),
      `---
id: coding
name: Built-in Coding
triggers: [code]
priority: 5
---
built-in body`,
    )
    await fs.writeFile(
      path.join(projectSkillsDir, 'coding.md'),
      `---
id: coding
name: Project Coding
triggers: [code]
priority: 50
---
project body`,
    )

    const reg = await loadSkillRegistry({ cwd, builtInDir })
    const list = reg.list()
    assert.strictEqual(list.length, 1)
    assert.strictEqual(list[0].source, 'project')
    assert.strictEqual(list[0].priority, 50)
    assert.strictEqual(list[0].content, 'project body')

    const diag = reg.diagnose()
    assert.strictEqual(diag.overlaid.length, 1)
    assert.strictEqual(diag.overlaid[0].id, 'coding')
    assert.strictEqual(diag.overlaid[0].shadowedBy, 'project')
    assert.strictEqual(diag.overlaid[0].from, 'builtin')
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

test('loadSkillRegistry match returns skills whose triggers hit the prompt', async () => {
  const cwd = path.join(os.tmpdir(), `babel-o-registry-match-${Date.now()}`)
  const builtInDir = path.join(cwd, 'built-in')
  await fs.mkdir(builtInDir, { recursive: true })

  try {
    await fs.writeFile(
      path.join(builtInDir, 'coding.md'),
      `---
id: coding
triggers: [code, class]
priority: 5
---
coding`,
    )
    await fs.writeFile(
      path.join(builtInDir, 'testing.md'),
      `---
id: testing
triggers: [test, coverage]
priority: 10
---
testing`,
    )

    const reg = await loadSkillRegistry({ cwd, builtInDir })
    const hits = reg.match('let us run a test against the code', { maxCount: 2 })
    assert.strictEqual(hits.length, 2)
    const ids = hits.map(s => s.id)
    assert.ok(ids.includes('coding'))
    assert.ok(ids.includes('testing'))
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

test('loadSkillRegistry get(id) returns single normalized skill', async () => {
  const cwd = path.join(os.tmpdir(), `babel-o-registry-get-${Date.now()}`)
  const builtInDir = path.join(cwd, 'built-in')
  await fs.mkdir(builtInDir, { recursive: true })

  try {
    await fs.writeFile(
      path.join(builtInDir, 'coding.md'),
      `---
id: coding
triggers: [code]
priority: 5
---
coding`,
    )
    const reg = await loadSkillRegistry({ cwd, builtInDir })
    const skill = reg.get('coding')
    assert.ok(skill)
    assert.strictEqual(skill.id, 'coding')
    assert.strictEqual(skill.content, 'coding')
    assert.strictEqual(reg.get('nonexistent'), undefined)
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

test('validateRegistrySkill runs validator on registry entry', async () => {
  const cwd = path.join(os.tmpdir(), `babel-o-registry-validate-${Date.now()}`)
  const builtInDir = path.join(cwd, 'built-in')
  await fs.mkdir(builtInDir, { recursive: true })

  try {
    await fs.writeFile(
      path.join(builtInDir, 'coding.md'),
      `---
id: coding
triggers: [code]
priority: 5
---
coding body`,
    )
    const reg = await loadSkillRegistry({ cwd, builtInDir })
    const result = validateRegistrySkill(reg, 'coding')
    assert.ok(result)
    assert.strictEqual(result.ok, true)
    assert.strictEqual(result.diagnostics.length, 0)

    assert.strictEqual(validateRegistrySkill(reg, 'missing'), undefined)
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

test('SkillMatchedEventSchema accepts a typed match event payload', () => {
  const event = {
    type: 'skill_matched' as const,
    schemaVersion: '2026-05-21.babel-o.v1' as const,
    sessionId: 'session-1',
    timestamp: '2026-06-16T00:00:00.000Z',
    skillIds: ['coding', 'testing'],
    matches: [
      { id: 'coding', name: 'Coding', source: 'builtin' as const, score: 2, priority: 5, triggers: ['code', 'class'] },
      { id: 'testing', name: 'Testing', source: 'project' as const, score: 1, priority: 10, triggers: ['test'] },
    ],
    promptPreview: 'run a test against the code',
  }
  const parsed = SkillMatchedEventSchema.safeParse(event)
  assert.strictEqual(parsed.success, true)
})
