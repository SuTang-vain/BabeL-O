import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import {
  skillDraftTool,
  skillExportPreviewTool,
  skillExportWriteTool,
  skillImportInstallTool,
  skillImportPreviewTool,
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

test('createDefaultToolRegistry exposes Skill tools', () => {
  const reg = createDefaultToolRegistry()
  assert.ok(reg.has('SkillList'))
  assert.ok(reg.has('SkillShow'))
  assert.ok(reg.has('SkillValidate'))
  assert.ok(reg.has('SkillDraft'))
  assert.ok(reg.has('SkillExportPreview'))
  assert.ok(reg.has('SkillExportWrite'))
  assert.ok(reg.has('SkillImportPreview'))
  assert.ok(reg.has('SkillImportInstall'))
  assert.ok(reg.has('SkillSave'))
})

test('SkillSave has write risk and requires approval', () => {
  assert.equal(skillSaveTool.risk, 'write')
  assert.equal(skillSaveTool.requiresApproval, true)
  assert.equal(skillExportWriteTool.risk, 'write')
  assert.equal(skillExportWriteTool.requiresApproval, true)
  assert.equal(skillImportInstallTool.risk, 'write')
  assert.equal(skillImportInstallTool.requiresApproval, true)
})

test('SkillList / SkillShow / SkillValidate / SkillDraft / SkillExportPreview / SkillImportPreview have read risk and no approval gate', () => {
  for (const tool of [skillListTool, skillShowTool, skillValidateTool, skillDraftTool, skillExportPreviewTool, skillImportPreviewTool]) {
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

test('SkillList and SkillShow expose Agent Skills package metadata', async () => {
  const { cwd, builtInDir, projectSkillsDir } = await makeProjectTreeWithBuiltIn('Coding')
  const packageDir = path.join(projectSkillsDir, 'context-debugging')
  await fs.mkdir(path.join(packageDir, 'references'), { recursive: true })
  try {
    await fs.writeFile(
      path.join(packageDir, 'SKILL.md'),
      `---
name: context-debugging
description: Debug context assembly and tool suppression issues.
allowed-tools: Read Grep
metadata.babel-o.triggers: [context assembly, tool suppression]
metadata.babel-o.priority: 80
---
# Purpose
Debug context issues.`
    )
    await fs.writeFile(path.join(packageDir, 'references', 'flow.md'), '# Flow')

    const listResult = await skillListTool.execute({ cwd, builtInDir }, baseContext(cwd))
    assert.equal(listResult.success, true)
    const skills = (listResult.output as { skills: Array<{ id: string; sourceFormat: string; resources: Array<{ path: string }> }> }).skills
    const listed = skills.find(skill => skill.id === 'context-debugging')
    assert.ok(listed)
    assert.equal(listed.sourceFormat, 'agent-skills-v1')
    assert.equal(listed.resources[0]?.path, 'references/flow.md')

    const showResult = await skillShowTool.execute({ cwd, builtInDir, id: 'context-debugging' }, baseContext(cwd))
    assert.equal(showResult.success, true)
    const shown = (showResult.output as { skill: { id: string; sourceFormat: string; manifestPath: string; resources: Array<{ path: string }>; body: string; companionReferences: Array<{ path: string }>; companionAssets: Array<{ path: string }> } }).skill
    assert.equal(shown.id, 'context-debugging')
    assert.equal(shown.sourceFormat, 'agent-skills-v1')
    assert.equal(shown.manifestPath, path.join(packageDir, 'SKILL.md'))
    assert.equal(shown.resources[0]?.path, 'references/flow.md')
    assert.match(shown.body, /description: Debug context assembly and tool suppression issues\./)
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

test('SkillShow surfaces companion references and assets for real public-ecosystem packages', async () => {
  const { cwd, builtInDir, projectSkillsDir } = await makeProjectTreeWithBuiltIn('Companion')
  const packageDir = path.join(projectSkillsDir, 'real-pdf')
  await fs.mkdir(path.join(packageDir, 'canvas-fonts'), { recursive: true })
  try {
    await fs.writeFile(
      path.join(packageDir, 'SKILL.md'),
      `---
name: real-pdf
description: PDF processing skill.
---
# Body`
    )
    await fs.writeFile(path.join(packageDir, 'reference.md'), '# Reference')
    await fs.writeFile(path.join(packageDir, 'forms.md'), '# Forms')
    await fs.writeFile(path.join(packageDir, 'canvas-fonts', 'BigShoulders-Bold.ttf'), 'binary')
    await fs.writeFile(path.join(packageDir, 'canvas-fonts', 'OFL.txt'), 'OFL')

    const showResult = await skillShowTool.execute({ cwd, builtInDir, id: 'real-pdf' }, baseContext(cwd))
    assert.equal(showResult.success, true)
    const shown = (showResult.output as {
      skill: {
        companionReferences: Array<{ kind: string; path: string }>
        companionAssets: Array<{ kind: string; path: string }>
        body: string
      }
    }).skill

    assert.deepStrictEqual(
      shown.companionReferences.map(r => r.path),
      ['forms.md', 'reference.md'],
    )
    assert.deepStrictEqual(
      shown.companionAssets.map(r => r.path).sort(),
      ['canvas-fonts/BigShoulders-Bold.ttf', 'canvas-fonts/OFL.txt'],
    )
    assert.match(shown.body, /## Companion Resources/)
    assert.match(shown.body, /forms\.md/)
    assert.match(shown.body, /reference\.md/)
    assert.match(shown.body, /## Companion Assets/)
    assert.match(shown.body, /canvas-fonts\/BigShoulders-Bold\.ttf/)
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

test('SkillImportPreview previews a local Agent Skills package without saving it', async () => {
  const { cwd, builtInDir, projectSkillsDir } = await makeProjectTreeWithBuiltIn('Coding')
  const sourcePackageDir = path.join(cwd, 'external-skills', 'context-debugging')
  await fs.mkdir(path.join(sourcePackageDir, 'references'), { recursive: true })
  try {
    await fs.writeFile(
      path.join(projectSkillsDir, 'context-debugging.md'),
      `---
id: context-debugging
name: Context Debugging
triggers: [context]
priority: 1
---
existing`,
    )
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
Debug context issues.`
    )
    await fs.writeFile(path.join(sourcePackageDir, 'references', 'flow.md'), '# Flow')

    const result = await skillImportPreviewTool.execute(
      { cwd, builtInDir, sourcePath: sourcePackageDir },
      baseContext(cwd),
    )
    assert.equal(result.success, true)
    const output = result.output as {
      ok: true
      previewOnly: true
      skill: { id: string; sourceFormat: string }
      resources: Array<{ path: string }>
      warnings: Array<{ code: string }>
      targetPath: string
    }
    assert.equal(output.ok, true)
    assert.equal(output.previewOnly, true)
    assert.equal(output.skill.id, 'context-debugging')
    assert.equal(output.skill.sourceFormat, 'agent-skills-v1')
    assert.equal(output.resources[0]?.path, 'references/flow.md')
    assert.ok(output.warnings.some(warning => warning.code === 'SKILL_IMPORT_DUPLICATE_ID'))
    assert.match(output.targetPath, /\.babel-o\/skills\/context-debugging$/)
    await assert.rejects(fs.access(output.targetPath))
    const targetContent = await fs.readFile(path.join(projectSkillsDir, 'context-debugging.md'), 'utf-8')
    assert.equal(targetContent.includes('existing'), true)
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

test('SkillImportInstall installs a local Agent Skills package after confirmation', async () => {
  const { cwd, builtInDir } = await makeProjectTreeWithBuiltIn('Coding')
  const sourcePackageDir = path.join(cwd, 'external-skills', 'context-debugging')
  await fs.mkdir(path.join(sourcePackageDir, 'references'), { recursive: true })
  try {
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
Debug context issues.`
    )
    await fs.writeFile(path.join(sourcePackageDir, 'references', 'flow.md'), '# Flow')

    const previewResult = await skillImportInstallTool.execute(
      { cwd, builtInDir, sourcePath: sourcePackageDir, confirm: false },
      baseContext(cwd),
    )
    assert.equal(previewResult.success, true)
    const previewOutput = previewResult.output as { ok: boolean; previewOnly: boolean; preview: { targetPath: string } }
    assert.equal(previewOutput.ok, false)
    assert.equal(previewOutput.previewOnly, true)
    await assert.rejects(fs.access(previewOutput.preview.targetPath))

    const installResult = await skillImportInstallTool.execute(
      { cwd, builtInDir, sourcePath: sourcePackageDir, confirm: true },
      baseContext(cwd),
    )
    assert.equal(installResult.success, true)
    const output = installResult.output as { ok: true; targetPath: string; skillId: string; format: string }
    assert.equal(output.skillId, 'context-debugging')
    assert.equal(output.format, 'new')
    const manifest = await fs.readFile(path.join(output.targetPath, 'SKILL.md'), 'utf-8')
    assert.match(manifest, /name: context-debugging/)
    const reference = await fs.readFile(path.join(output.targetPath, 'references', 'flow.md'), 'utf-8')
    assert.equal(reference, '# Flow')
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

test('SkillExportPreview previews an Agent Skills package without writing it', async () => {
  const { cwd, builtInDir, projectSkillsDir } = await makeProjectTreeWithBuiltIn('Coding')
  try {
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

    const result = await skillExportPreviewTool.execute(
      { cwd, builtInDir, id: 'context-debugging', targetDir: 'exports' },
      baseContext(cwd),
    )
    assert.equal(result.success, true)
    const output = result.output as {
      ok: true
      previewOnly: true
      packageRoot: string
      manifestPath: string
      manifest: string
      conversion: { targetFormat: string }
    }
    assert.equal(output.ok, true)
    assert.equal(output.previewOnly, true)
    assert.equal(output.conversion.targetFormat, 'agent-skills-v1')
    assert.equal(output.packageRoot, path.join(cwd, 'exports', 'context-debugging'))
    assert.equal(output.manifestPath, path.join(cwd, 'exports', 'context-debugging', 'SKILL.md'))
    assert.match(output.manifest, /name: context-debugging/)
    assert.match(output.manifest, /metadata:\n  babel-o:/)
    assert.match(output.manifest, /allowed-tools: Read Grep/)
    await assert.rejects(fs.access(output.packageRoot))
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

test('SkillExportWrite writes an Agent Skills package after confirmation', async () => {
  const { cwd, builtInDir, projectSkillsDir } = await makeProjectTreeWithBuiltIn('Coding')
  try {
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

    const previewResult = await skillExportWriteTool.execute(
      { cwd, builtInDir, id: 'context-debugging', targetDir: 'exports', confirm: false },
      baseContext(cwd),
    )
    assert.equal(previewResult.success, true)
    const previewOutput = previewResult.output as { ok: boolean; previewOnly: boolean; preview: { packageRoot: string } }
    assert.equal(previewOutput.ok, false)
    assert.equal(previewOutput.previewOnly, true)
    await assert.rejects(fs.access(previewOutput.preview.packageRoot))

    const writeResult = await skillExportWriteTool.execute(
      { cwd, builtInDir, id: 'context-debugging', targetDir: 'exports', confirm: true },
      baseContext(cwd),
    )
    assert.equal(writeResult.success, true)
    const output = writeResult.output as { ok: true; packageRoot: string; manifestPath: string; format: string }
    assert.equal(output.format, 'new')
    const manifest = await fs.readFile(output.manifestPath, 'utf-8')
    assert.match(manifest, /name: context-debugging/)
    assert.match(manifest, /metadata:\n  babel-o:/)
    const exportedReference = await fs.readFile(path.join(output.packageRoot, 'references', 'flow.md'), 'utf-8')
    assert.equal(exportedReference, '# Flow')

    const conflictResult = await skillExportWriteTool.execute(
      { cwd, builtInDir, id: 'context-debugging', targetDir: 'exports', confirm: true },
      baseContext(cwd),
    )
    assert.equal(conflictResult.success, false)
    const conflictOutput = conflictResult.output as { errorCode: string }
    assert.equal(conflictOutput.errorCode, 'SKILL_EXPORT_OVERWRITE_REQUIRED')
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
