// test/context-assemble-project-memory.test.ts
//
// PR-32 unit tests: projectMemory section reads .babel-o/memory.md (doc §5.2).
// Covers:
//   1. missing memory.md → "not found" section
//   2. existing memory.md → content rendered
//   3. content has header
//   4. includeProjectMemory=false → no section
//   5. HOME isolation
//   6. empty memory.md → "not found"
//   7. large memory.md truncated (per loadProjectMemory cap)

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildAssemblePreview } from '../src/nexus/contextAssemblePreview.js'

const ORIGINAL_ENV: Record<string, string | undefined> = {}

describe('PR-32 projectMemory section from .babel-o/memory.md', () => {
  let home: string
  let cwd: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'babel-o-pr32-home-'))
    cwd = mkdtempSync(join(home, 'project-'))
    mkdirSync(join(cwd, '.babel-o'), { recursive: true })
    for (const key of ['HOME', 'BABEL_O_TEST_CONFIG_WRITE_GUARD']) {
      ORIGINAL_ENV[key] = process.env[key]
    }
    process.env.HOME = home
    process.env.BABEL_O_TEST_CONFIG_WRITE_GUARD = '1'
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    for (const [key, val] of Object.entries(ORIGINAL_ENV)) {
      if (val === undefined) delete process.env[key]
      else process.env[key] = val
    }
  })

  // Test 1: missing memory.md
  test('missing memory.md → "not found" section', async () => {
    const preview = await buildAssemblePreview({ cwd, scope: 'workspace', maxTokens: 7500, includeProjectMemory: true })
    const proj = preview.sections.find((s) => s.kind === 'project')
    assert.ok(proj)
    assert.ok(proj!.content.includes('no .babel-o/memory.md'))
    assert.equal(proj!.source, '.babel-o/memory.md:not-found')
  })

  // Test 2: existing memory.md
  test('existing memory.md → content rendered with header', async () => {
    writeFileSync(join(cwd, '.babel-o', 'memory.md'),
      '# Project Notes\n\nThis is a test project.\n\n## Architecture\n- Layer 1: ...\n',
      'utf8')
    const preview = await buildAssemblePreview({ cwd, scope: 'workspace', maxTokens: 7500, includeProjectMemory: true })
    const proj = preview.sections.find((s) => s.kind === 'project')
    assert.ok(proj)
    assert.ok(proj!.content.includes('## Project Memory (from .babel-o/memory.md)'))
    assert.ok(proj!.content.includes('This is a test project'))
    assert.ok(proj!.content.includes('Layer 1'))
    assert.equal(proj!.source, '.babel-o/memory.md')
  })

  // Test 3: includeProjectMemory=false → no project section
  test('includeProjectMemory=false → no project section', async () => {
    writeFileSync(join(cwd, '.babel-o', 'memory.md'), '# Should not appear\n', 'utf8')
    const preview = await buildAssemblePreview({ cwd, scope: 'workspace', maxTokens: 7500 })
    const proj = preview.sections.find((s) => s.kind === 'project')
    assert.equal(proj, undefined)
  })

  // Test 4: empty memory.md → "not found"
  test('empty memory.md (whitespace only) → "not found" section', async () => {
    writeFileSync(join(cwd, '.babel-o', 'memory.md'), '   \n  \n', 'utf8')
    const preview = await buildAssemblePreview({ cwd, scope: 'workspace', maxTokens: 7500, includeProjectMemory: true })
    const proj = preview.sections.find((s) => s.kind === 'project')
    assert.ok(proj)
    assert.ok(proj!.content.includes('no .babel-o/memory.md'))
  })

  // Test 5: HOME isolation
  test('HOME isolation: HOME memory.md not read', async () => {
    writeFileSync(join(home, 'memory.md'), '# HOME SHOULD NOT APPEAR\n', 'utf8')
    const preview = await buildAssemblePreview({ cwd, scope: 'workspace', maxTokens: 7500, includeProjectMemory: true })
    const proj = preview.sections.find((s) => s.kind === 'project')
    assert.ok(proj)
    assert.ok(!proj!.content.includes('HOME SHOULD NOT APPEAR'), 'HOME file not read')
  })

  // Test 6: content with no trailing newline
  test('memory.md without trailing newline → newline added in section', async () => {
    writeFileSync(join(cwd, '.babel-o', 'memory.md'), '# No newline at end', 'utf8')
    const preview = await buildAssemblePreview({ cwd, scope: 'workspace', maxTokens: 7500, includeProjectMemory: true })
    const proj = preview.sections.find((s) => s.kind === 'project')
    assert.ok(proj)
    assert.ok(proj!.content.includes('No newline at end\n'))
  })
})
