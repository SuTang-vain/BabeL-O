import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import {
  skillDraftTool,
  skillListTool,
  skillSaveTool,
  skillShowTool,
  skillValidateTool,
} from '../src/tools/builtin/skillTool.js'
import { createDefaultToolRegistry } from '../src/tools/registry.js'

const baseContext = (cwd: string) => ({
  cwd,
  sessionId: 'session-tools',
  maxOutputBytes: 200_000,
  bashMaxBufferBytes: 1_000_000,
})

async function makeProjectTreeWithBuiltIn(title: string) {
  const cwd = path.join(os.tmpdir(), `babel-o-skill-tools-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const builtInDir = path.join(cwd, 'built-in')
  await fs.mkdir(builtInDir, { recursive: true })
  const projectSkillsDir = path.join(cwd, '.babel-o', 'skills')
  await fs.mkdir(projectSkillsDir, { recursive: true })
  await fs.writeFile(
    path.join(builtInDir, 'coding.md'),
    `---
id: coding
name: Coding
triggers: [code, class]
priority: 5
---
coding body`,
  )
  return { cwd, builtInDir, projectSkillsDir }
}

test('createDefaultToolRegistry exposes the 5 Skill tools', () => {
  const reg = createDefaultToolRegistry()
  assert.ok(reg.has('SkillList'))
  assert.ok(reg.has('SkillShow'))
  assert.ok(reg.has('SkillValidate'))
  assert.ok(reg.has('SkillDraft'))
  assert.ok(reg.has('SkillSave'))
})

test('SkillSave has write risk and requires approval', () => {
  assert.equal(skillSaveTool.risk, 'write')
  assert.equal(skillSaveTool.requiresApproval, true)
})

test('SkillList / SkillShow / SkillValidate / SkillDraft have read risk and no approval gate', () => {
  for (const tool of [skillListTool, skillShowTool, skillValidateTool, skillDraftTool]) {
    assert.equal(tool.risk, 'read')
    assert.notEqual(tool.requiresApproval, true)
  }
})

test('SkillList returns built-in + project skills with source attribution', async () => {
  const { cwd, builtInDir } = await makeProjectTreeWithBuiltIn('Coding')
  try {
    const result = await skillListTool.execute({ cwd, builtInDir }, baseContext(cwd))
    assert.equal(result.success, true)
    const skills = (result.output as { skills: Array<{ id: string; source: string }> }).skills
    const ids = skills.map(s => s.id)
    assert.ok(ids.includes('coding'))
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

test('SkillShow returns full skill body when id is present', async () => {
  const { cwd, builtInDir } = await makeProjectTreeWithBuiltIn('Coding')
  try {
    const result = await skillShowTool.execute({ cwd, builtInDir, id: 'coding' }, baseContext(cwd))
    assert.equal(result.success, true)
    const skill = (result.output as { skill: { id: string; body: string } }).skill
    assert.equal(skill.id, 'coding')
    assert.match(skill.body, /coding body/)
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

test('SkillShow returns SKILL_NOT_FOUND for unknown id', async () => {
  const { cwd, builtInDir } = await makeProjectTreeWithBuiltIn('Coding')
  try {
    const result = await skillShowTool.execute({ cwd, builtInDir, id: 'missing' }, baseContext(cwd))
    assert.equal(result.success, false)
    const output = result.output as { errorCode: string; id: string }
    assert.equal(output.errorCode, 'SKILL_NOT_FOUND')
    assert.equal(output.id, 'missing')
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

test('SkillValidate succeeds for a valid body', async () => {
  const result = await skillValidateTool.execute(
    {
      body: `---
id: test-skill
name: Test
triggers: [test]
priority: 5
---
body`,
    },
    baseContext('/tmp'),
  )
  assert.equal(result.success, true)
})

test('SkillValidate returns SKILL_VALIDATION_FAILED for an invalid body', async () => {
  const result = await skillValidateTool.execute(
    {
      body: `---
name: Missing Id
triggers: [test]
---
body`,
    },
    baseContext('/tmp'),
  )
  assert.equal(result.success, false)
  const output = result.output as { errorCode: string; diagnostics: Array<{ code: string }> }
  assert.equal(output.errorCode, 'SKILL_VALIDATION_FAILED')
  assert.ok(output.diagnostics.some(d => d.code === 'SKILL_PARSE_FAILED'))
})

test('SkillValidate returns SKILL_INVALID_INPUT when neither id nor body is provided', async () => {
  const result = await skillValidateTool.execute({}, baseContext('/tmp'))
  assert.equal(result.success, false)
  const output = result.output as { errorCode: string }
  assert.equal(output.errorCode, 'SKILL_INVALID_INPUT')
})

test('SkillDraft produces a normalized draft with status=draft', async () => {
  const result = await skillDraftTool.execute(
    { title: 'My Personal Workflow Tool' },
    baseContext('/tmp'),
  )
  assert.equal(result.success, true)
  const output = result.output as { draft: { id: string; status: string; body: string } }
  assert.equal(output.draft.id, 'my-personal-workflow-tool')
  assert.equal(output.draft.status, 'draft')
  assert.match(output.draft.body, /# Purpose/)
})

test('SkillSave returns previewOnly when confirm is false', async () => {
  const { cwd, builtInDir } = await makeProjectTreeWithBuiltIn('Coding')
  try {
    const draft = (await skillDraftTool.execute(
      { title: 'My Personal Workflow Tool' },
      baseContext('/tmp'),
    )) as { output: { draft: { id: string; name: string; description: string; source: 'builtin' | 'user' | 'project'; scope: 'builtin' | 'user' | 'project'; status: string; version: number; triggers: string[]; priority: number; risk: 'read' | 'write' | 'execute' | 'network' | 'task'; allowedTools: string[]; body: string } } }
    const result = await skillSaveTool.execute(
      {
        cwd,
        builtInDir,
        draft: { ...draft.output.draft, content: draft.output.draft.body },
        confirm: false,
      },
      baseContext(cwd),
    )
    // Save returns success=true with previewOnly flag — model can re-call with confirm: true.
    assert.equal(result.success, true)
    const output = result.output as { ok: boolean; previewOnly: boolean; preview: { filePath: string } }
    assert.equal(output.ok, false)
    assert.equal(output.previewOnly, true)
    assert.match(output.preview.filePath, /\.babel-o\/skills\/my-personal-workflow-tool\.md$/)
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

test('SkillSave persists file on disk when confirm is true', async () => {
  const { cwd, builtInDir } = await makeProjectTreeWithBuiltIn('Coding')
  try {
    const draft = (await skillDraftTool.execute(
      { title: 'My Personal Workflow Tool' },
      baseContext('/tmp'),
    )) as { output: { draft: { id: string; name: string; description: string; source: 'builtin' | 'user' | 'project'; scope: 'builtin' | 'user' | 'project'; status: string; version: number; triggers: string[]; priority: number; risk: 'read' | 'write' | 'execute' | 'network' | 'task'; allowedTools: string[]; body: string } } }
    const result = await skillSaveTool.execute(
      {
        cwd,
        builtInDir,
        draft: { ...draft.output.draft, content: draft.output.draft.body },
        confirm: true,
        scope: 'project',
      },
      baseContext(cwd),
    )
    assert.equal(result.success, true)
    const output = result.output as { ok: boolean; filePath: string; saved: { skillId: string } }
    assert.equal(output.ok, true)
    assert.equal(output.saved.skillId, 'my-personal-workflow-tool')

    const onDisk = await fs.readFile(output.filePath, 'utf-8')
    assert.match(onDisk, /id: my-personal-workflow-tool/)
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

test('SkillSave rejects overwrite without explicit overwrite flag', async () => {
  const { cwd, builtInDir, projectSkillsDir } = await makeProjectTreeWithBuiltIn('Coding')
  try {
    await fs.writeFile(
      path.join(projectSkillsDir, 'my-existing-tool.md'),
      '---\nid: my-existing-tool\n---\nold body',
    )
    const draft = (await skillDraftTool.execute(
      { title: 'My Existing Tool', idHint: 'my-existing-tool' },
      baseContext('/tmp'),
    )) as { output: { draft: { id: string; name: string; description: string; source: 'builtin' | 'user' | 'project'; scope: 'builtin' | 'user' | 'project'; status: string; version: number; triggers: string[]; priority: number; risk: 'read' | 'write' | 'execute' | 'network' | 'task'; allowedTools: string[]; body: string } } }
    const result = await skillSaveTool.execute(
      {
        cwd,
        builtInDir,
        draft: { ...draft.output.draft, content: draft.output.draft.body },
        confirm: true,
        scope: 'project',
      },
      baseContext(cwd),
    )
    assert.equal(result.success, false)
    const output = result.output as { errorCode: string }
    assert.equal(output.errorCode, 'SKILL_SAVE_OVERWRITE_REQUIRED')
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
})
