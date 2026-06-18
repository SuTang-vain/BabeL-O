import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { generateSkillDraft } from '../src/skills/generator.js'
import { previewSkillSave, saveSkill } from '../src/skills/storage.js'

function userDir(): string {
  return process.env.BABEL_O_USER_SKILLS_DIR ?? path.join(os.homedir(), '.babel-o', 'skills')
}

test('saveSkill returns previewOnly when confirm is false', async () => {
  const cwd = path.join(os.tmpdir(), `babel-o-save-preview-${Date.now()}`)
  await fs.mkdir(cwd, { recursive: true })
  try {
    const draft = generateSkillDraft({ title: 'My Personal Workflow Tool' })
    assert.equal(draft.ok, true)
    if (!draft.ok) return

    const result = await saveSkill({
      cwd,
      draft: draft.draft,
      confirm: false,
      scope: 'project',
    })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.errorCode, 'SKILL_SAVE_NOT_CONFIRMED')
    assert.ok(result.preview)
    assert.equal(result.preview.isNewFile, true)
    assert.match(result.preview.filePath, /\.babel-o\/skills\/my-personal-workflow-tool\.md$/)
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

test('saveSkill persists project scope file with confirm=true', async () => {
  const cwd = path.join(os.tmpdir(), `babel-o-save-project-${Date.now()}`)
  await fs.mkdir(cwd, { recursive: true })
  try {
    const draft = generateSkillDraft({ title: 'My Project Workflow Tool' })
    assert.equal(draft.ok, true)
    if (!draft.ok) return

    const result = await saveSkill({
      cwd,
      draft: draft.draft,
      confirm: true,
      scope: 'project',
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.scope, 'project')
    assert.equal(result.format, 'new')
    assert.match(result.filePath, /\.babel-o\/skills\/my-project-workflow-tool\.md$/)

    // File should exist on disk
    const onDisk = await fs.readFile(result.filePath, 'utf-8')
    assert.match(onDisk, /id: my-project-workflow-tool/)
    assert.match(onDisk, /status: draft/)
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

test('saveSkill rejects overwrite without explicit overwrite flag', async () => {
  const cwd = path.join(os.tmpdir(), `babel-o-save-overwrite-${Date.now()}`)
  const projectSkillsDir = path.join(cwd, '.babel-o', 'skills')
  await fs.mkdir(projectSkillsDir, { recursive: true })
  try {
    // Pre-create target file
    await fs.writeFile(
      path.join(projectSkillsDir, 'my-existing-tool.md'),
      '---\nid: my-existing-tool\n---\nold body',
    )

    const draft = generateSkillDraft({ title: 'My Existing Tool', idHint: 'my-existing-tool' })
    assert.equal(draft.ok, true)
    if (!draft.ok) return

    const result = await saveSkill({
      cwd,
      draft: draft.draft,
      confirm: true,
      scope: 'project',
    })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.errorCode, 'SKILL_SAVE_OVERWRITE_REQUIRED')
    assert.ok(result.preview)
    assert.equal(result.preview.isNewFile, false)
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

test('saveSkill with overwrite=true replaces existing file', async () => {
  const cwd = path.join(os.tmpdir(), `babel-o-save-overwrite-ok-${Date.now()}`)
  const projectSkillsDir = path.join(cwd, '.babel-o', 'skills')
  await fs.mkdir(projectSkillsDir, { recursive: true })
  try {
    await fs.writeFile(
      path.join(projectSkillsDir, 'my-existing-tool.md'),
      '---\nid: my-existing-tool\n---\nold body',
    )

    const draft = generateSkillDraft({ title: 'My Existing Tool', idHint: 'my-existing-tool' })
    assert.equal(draft.ok, true)
    if (!draft.ok) return

    const result = await saveSkill({
      cwd,
      draft: draft.draft,
      confirm: true,
      overwrite: true,
      scope: 'project',
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.format, 'overwrite')

    const onDisk = await fs.readFile(result.filePath, 'utf-8')
    assert.match(onDisk, /status: draft/)
    assert.doesNotMatch(onDisk, /old body/)
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

test('saveSkill persists user scope file under BABEL_O_USER_SKILLS_DIR (test isolation)', async () => {
  const cwd = path.join(os.tmpdir(), `babel-o-save-user-${Date.now()}`)
  await fs.mkdir(cwd, { recursive: true })
  try {
    const draft = generateSkillDraft({
      title: 'My Personal Workflow Tool',
      scope: 'user',
    })
    assert.equal(draft.ok, true)
    if (!draft.ok) return

    const result = await saveSkill({
      cwd,
      draft: draft.draft,
      confirm: true,
      scope: 'user',
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.scope, 'user')
    assert.equal(result.filePath, path.join(userDir(), 'my-personal-workflow-tool.md'))

    // Test isolation: BABEL_O_USER_SKILLS_DIR is a tmp dir, so the file lands there
    // — never in the real ~/.babel-o/skills.
    const onDisk = await fs.readFile(result.filePath, 'utf-8')
    assert.match(onDisk, /id: my-personal-workflow-tool/)
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
    // Clean up the user-scope file we wrote so subsequent tests in the
    // same shared BABEL_O_USER_SKILLS_DIR do not see it.
    await fs.rm(path.join(userDir(), 'my-personal-workflow-tool.md'), { force: true })
  }
})

test('saveSkill reports SKILL_SAVE_DUPLICATE_NAME when normalized name matches existing skill', async () => {
  const cwd = path.join(os.tmpdir(), `babel-o-save-dup-name-${Date.now()}`)
  const projectSkillsDir = path.join(cwd, '.babel-o', 'skills')
  await fs.mkdir(projectSkillsDir, { recursive: true })
  try {
    await fs.writeFile(
      path.join(projectSkillsDir, 'existing-tool.md'),
      `---
id: existing-tool
name: My Personal Workflow Tool
triggers: [foo, bar]
priority: 5
---
existing body`,
    )

    const draft = generateSkillDraft({ title: 'My Personal Workflow Tool' })
    assert.equal(draft.ok, true)
    if (!draft.ok) return

    const result = await saveSkill({
      cwd,
      draft: draft.draft,
      confirm: true,
      scope: 'project',
    })
    // Save succeeds (soft duplicate is advisory, not blocking).
    assert.equal(result.ok, true)
    if (!result.ok) return

    // But the preview built earlier would surface the warning.
    const preview = await previewSkillSave({ cwd, draft: draft.draft, scope: 'project' })
    const warnings = preview.duplicateWarnings
    assert.ok(
      warnings.some(w => w.code === 'SKILL_SAVE_DUPLICATE_NAME' && w.conflictingId === 'existing-tool'),
    )
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

test('saveSkill reports SKILL_SAVE_DUPLICATE_TRIGGERS when >= 2 triggers overlap', async () => {
  const cwd = path.join(os.tmpdir(), `babel-o-save-dup-triggers-${Date.now()}`)
  const projectSkillsDir = path.join(cwd, '.babel-o', 'skills')
  await fs.mkdir(projectSkillsDir, { recursive: true })
  try {
    await fs.writeFile(
      path.join(projectSkillsDir, 'overlap-tool.md'),
      `---
id: overlap-tool
name: Some Other Tool
triggers: [shared, common]
priority: 5
---
body`,
    )

    const draft = generateSkillDraft({
      title: 'My New Shared Common Tool',
    })
    assert.equal(draft.ok, true)
    if (!draft.ok) return

    const preview = await previewSkillSave({ cwd, draft: draft.draft, scope: 'project' })
    assert.ok(
      preview.duplicateWarnings.some(
        w => w.code === 'SKILL_SAVE_DUPLICATE_TRIGGERS' && w.conflictingId === 'overlap-tool',
      ),
    )
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

test('saveSkill rejects invalid draft (missing id)', async () => {
  const cwd = path.join(os.tmpdir(), `babel-o-save-invalid-${Date.now()}`)
  await fs.mkdir(cwd, { recursive: true })
  try {
    const result = await saveSkill({
      cwd,
      // @ts-expect-error - deliberately invalid draft for the test
      draft: { name: 'No ID Skill' },
      confirm: true,
      scope: 'project',
    })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.errorCode, 'SKILL_SAVE_INVALID_DRAFT')
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

test('saveSkill rejects scope=builtin (only user/project allowed)', async () => {
  const cwd = path.join(os.tmpdir(), `babel-o-save-bad-scope-${Date.now()}`)
  await fs.mkdir(cwd, { recursive: true })
  try {
    const draft = generateSkillDraft({ title: 'My Personal Workflow Tool' })
    assert.equal(draft.ok, true)
    if (!draft.ok) return

    const result = await saveSkill({
      cwd,
      draft: draft.draft,
      confirm: true,
      // @ts-expect-error - deliberately bad scope
      scope: 'builtin',
    })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.errorCode, 'SKILL_SAVE_SCOPE_INVALID')
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

test('saveSkill emits typed SkillSavedEvent payload on success', async () => {
  const cwd = path.join(os.tmpdir(), `babel-o-save-event-${Date.now()}`)
  await fs.mkdir(cwd, { recursive: true })
  try {
    const draft = generateSkillDraft({ title: 'My Personal Workflow Tool' })
    assert.equal(draft.ok, true)
    if (!draft.ok) return

    const result = await saveSkill({
      cwd,
      draft: draft.draft,
      confirm: true,
      scope: 'project',
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.saved.type, 'skill_saved')
    assert.equal(result.saved.skillId, 'my-personal-workflow-tool')
    assert.equal(result.saved.scope, 'project')
    assert.equal(result.saved.format, 'new')
    assert.match(result.saved.schemaVersion, /^2026-/)
    assert.match(result.saved.timestamp, /^\d{4}-\d{2}-\d{2}T/)
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
})
