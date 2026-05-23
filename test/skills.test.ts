import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { parseFrontMatter, loadSkillFromFile, loadSkillsFromDir, loadAllSkills } from '../src/skills/loader.js'
import { matchSkills } from '../src/skills/matcher.js'
import { assembleContext } from '../src/runtime/contextAssembler.js'
import { buildSystemPrompt, mapEventsToMessages } from '../src/runtime/LLMCodingRuntime.js'

test('parseFrontMatter correctly parses valid front-matter', () => {
  const content = `---
id: test-skill
name: Test Skill Name
triggers: [test, keyword, match]
priority: 5
---
# Test Skill Markdown
This is the body of the skill.
`
  const skill = parseFrontMatter(content)
  assert.ok(skill)
  assert.strictEqual(skill.id, 'test-skill')
  assert.strictEqual(skill.name, 'Test Skill Name')
  assert.deepStrictEqual(skill.triggers, ['test', 'keyword', 'match'])
  assert.strictEqual(skill.priority, 5)
  assert.strictEqual(skill.content, '# Test Skill Markdown\nThis is the body of the skill.')
})

test('parseFrontMatter handles missing priority and custom triggers formats', () => {
  const content = `---
id: minimal-skill
triggers: foo, bar
---
Minimal body
`
  const skill = parseFrontMatter(content)
  assert.ok(skill)
  assert.strictEqual(skill.id, 'minimal-skill')
  assert.strictEqual(skill.name, 'minimal-skill')
  assert.deepStrictEqual(skill.triggers, ['foo', 'bar'])
  assert.strictEqual(skill.priority, 0)
  assert.strictEqual(skill.content, 'Minimal body')
})

test('parseFrontMatter returns null for invalid front-matter', () => {
  assert.strictEqual(parseFrontMatter('no front matter'), null)
  assert.strictEqual(parseFrontMatter('---\nincomplete\n'), null)
  assert.strictEqual(parseFrontMatter('---\nname: missing-id\n---\nbody'), null)
})

test('loadSkillsFromDir scans directory and returns parsed skills', async () => {
  const tmpDir = path.join(os.tmpdir(), `babel-o-skills-test-${Date.now()}`)
  await fs.mkdir(tmpDir, { recursive: true })

  try {
    await fs.writeFile(
      path.join(tmpDir, 'skill-1.md'),
      `---
id: s1
triggers: trigger1
priority: 1
---
Body 1`
    )
    await fs.writeFile(
      path.join(tmpDir, 'skill-2.md'),
      `---
id: s2
triggers: trigger2
priority: 2
---
Body 2`
    )
    await fs.writeFile(path.join(tmpDir, 'skill-3.txt'), 'hello')

    const skills = await loadSkillsFromDir(tmpDir)
    assert.strictEqual(skills.length, 2)
    const sorted = skills.sort((a, b) => a.id.localeCompare(b.id))
    assert.strictEqual(sorted[0].id, 's1')
    assert.strictEqual(sorted[1].id, 's2')
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test('matchSkills scores trigger matches and sorts correctly', () => {
  const skills = [
    {
      id: 'debug',
      name: 'Debugging',
      triggers: ['debug', 'bug'],
      priority: 10,
      content: 'debug guidelines'
    },
    {
      id: 'coding',
      name: 'Coding',
      triggers: ['code', 'class'],
      priority: 5,
      content: 'coding guidelines'
    },
    {
      id: 'perf',
      name: 'Performance',
      triggers: ['optimize', 'slow'],
      priority: 20,
      content: 'perf guidelines'
    }
  ]

  const match1 = matchSkills(skills, 'I need to debug this bug.')
  assert.strictEqual(match1.length, 1)
  assert.strictEqual(match1[0].id, 'debug')

  const match2 = matchSkills(skills, 'optimize my code.')
  assert.strictEqual(match2.length, 2)
  assert.strictEqual(match2[0].id, 'perf')
  assert.strictEqual(match2[1].id, 'coding')

  const match3 = matchSkills(skills, 'optimize code using a class.')
  assert.strictEqual(match3.length, 2)
  assert.strictEqual(match3[0].id, 'coding')
  assert.strictEqual(match3[1].id, 'perf')

  const tieSkills = [
    { id: 'b-skill', name: 'B', triggers: ['trigger'], priority: 10, content: 'B' },
    { id: 'a-skill', name: 'A', triggers: ['trigger'], priority: 10, content: 'A' }
  ]
  const match4 = matchSkills(tieSkills, 'this is a trigger')
  assert.strictEqual(match4.length, 2)
  assert.strictEqual(match4[0].id, 'a-skill')
  assert.strictEqual(match4[1].id, 'b-skill')
})

test('loadAllSkills implements directory overlays correctly', async () => {
  const tmpProjectDir = path.join(os.tmpdir(), `babel-o-project-test-${Date.now()}`)
  const tmpBuiltInDir = path.join(tmpProjectDir, 'built-in')
  const tmpProjectSkillsDir = path.join(tmpProjectDir, '.babel-o', 'skills')

  await fs.mkdir(tmpBuiltInDir, { recursive: true })
  await fs.mkdir(tmpProjectSkillsDir, { recursive: true })

  try {
    await fs.writeFile(
      path.join(tmpBuiltInDir, 'coding.md'),
      `---
id: coding
priority: 5
triggers: [code]
---
built-in coding`
    )

    await fs.writeFile(
      path.join(tmpProjectSkillsDir, 'coding.md'),
      `---
id: coding
priority: 15
triggers: [code]
---
project coding`
    )

    await fs.writeFile(
      path.join(tmpProjectSkillsDir, 'custom.md'),
      `---
id: custom
priority: 10
triggers: [custom]
---
project custom`
    )

    const skills = await loadAllSkills(tmpProjectDir, tmpBuiltInDir)
    assert.strictEqual(skills.length, 2)

    const codingSkill = skills.find(s => s.id === 'coding')
    assert.ok(codingSkill)
    assert.strictEqual(codingSkill.priority, 15)
    assert.strictEqual(codingSkill.content, 'project coding')

    const customSkill = skills.find(s => s.id === 'custom')
    assert.ok(customSkill)
    assert.strictEqual(customSkill.content, 'project custom')
  } finally {
    await fs.rm(tmpProjectDir, { recursive: true, force: true })
  }
})

test('assembleContext matches and injects skills into system prompt', async () => {
  const cwd = path.join(os.tmpdir(), `babel-o-context-skills-${Date.now()}`)
  const skillsDir = path.join(cwd, '.babel-o', 'skills')
  await fs.mkdir(skillsDir, { recursive: true })

  try {
    await fs.writeFile(
      path.join(skillsDir, 'test-skill.md'),
      `---
id: test-skill
priority: 10
triggers: [testkeyword]
---
This is active skill instructions.`
    )

    const context = await assembleContext({
      runtimeOptions: {
        sessionId: 'session-skills',
        prompt: 'Let us run a testkeyword script',
        cwd,
      },
      events: [],
      modelId: 'local/coding-runtime',
      buildSystemPrompt,
      mapEventsToMessages,
    })

    assert.match(context.systemPrompt, /Active Developer Skills/)
    assert.match(context.systemPrompt, /This is active skill instructions/)
    assert.strictEqual(context.activeSkills.includes('This is active skill instructions.'), true)
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
})
