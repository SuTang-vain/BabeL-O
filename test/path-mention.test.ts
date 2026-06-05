import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { completePathMention, WorkspacePathIndex, WORKSPACE_PATH_INDEX_LIMIT } from '../src/cli/pathMention.js'

async function createFixture() {
  const cwd = join(tmpdir(), `babel-o-path-mention-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  await mkdir(join(cwd, 'src', 'runtime'), { recursive: true })
  await mkdir(join(cwd, '.babel-o'), { recursive: true })
  await mkdir(join(cwd, '.claude'), { recursive: true })
  await mkdir(join(cwd, 'node_modules', 'ignored'), { recursive: true })
  await writeFile(join(cwd, 'src', 'runtime', 'contextAssembler.ts'), 'export {}\n', 'utf8')
  await writeFile(join(cwd, 'src', 'pathMention.ts'), 'export {}\n', 'utf8')
  await writeFile(join(cwd, '.babel-o', 'session-memory.md'), 'memory\n', 'utf8')
  await writeFile(join(cwd, '.claude', 'settings.json'), '{}\n', 'utf8')
  await writeFile(join(cwd, 'node_modules', 'ignored', 'package.json'), '{}\n', 'utf8')
  return cwd
}

test('WorkspacePathIndex lazily completes @ mentions with fuzzy basename matches', async () => {
  const cwd = await createFixture()
  const index = new WorkspacePathIndex(cwd)

  assert.equal(index.built, false)
  const completion = completePathMention('inspect @ctx', cwd, index)

  assert.ok(completion)
  assert.equal(completion!.substring, '@ctx')
  assert.ok(completion!.hits.includes('@src/runtime/contextAssembler.ts'))
  assert.equal(index.built, true)
})

test('path mention index includes dot dirs but skips dependency trees', async () => {
  const cwd = await createFixture()
  const index = new WorkspacePathIndex(cwd)

  const memory = completePathMention('open @session-memory', cwd, index)
  const settings = completePathMention('open @settings', cwd, index)
  const ignored = completePathMention('open @package', cwd, index)

  assert.ok(memory!.hits.includes('@.babel-o/session-memory.md'))
  assert.ok(settings!.hits.includes('@.claude/settings.json'))
  assert.ok(!ignored!.hits.includes('@node_modules/ignored/package.json'))
})

test('path separator completion stays inside workspace and completes local paths', async () => {
  const cwd = await createFixture()

  const srcCompletion = completePathMention('read src/r', cwd)
  const escapeCompletion = completePathMention('read ../', cwd)
  const urlCompletion = completePathMention('see https://example.com/a', cwd)

  assert.ok(srcCompletion)
  assert.equal(srcCompletion!.substring, 'src/r')
  assert.ok(srcCompletion!.hits.includes('src/runtime/'))
  assert.deepEqual(escapeCompletion, { hits: [], substring: '../' })
  assert.equal(urlCompletion, undefined)
})

test('path mention index respects entry cap', async () => {
  const cwd = await createFixture()
  const index = new WorkspacePathIndex(cwd, { maxEntries: 2, scanBudgetMs: 1000 })

  completePathMention('open @', cwd, index)

  assert.ok(index.entryCount <= 2)
  assert.equal(WORKSPACE_PATH_INDEX_LIMIT, 50_000)
})
