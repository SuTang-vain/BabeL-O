import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { grepTool } from '../src/tools/builtin/grep.js'

test('Grep supports pathMatches file glob filtering', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'babel-o-grep-pathmatches-'))
  await writeFile(join(cwd, 'source.ts'), 'export const ContextForker = true\n')
  await writeFile(join(cwd, 'notes.md'), 'ContextForker notes\n')

  const result = await grepTool.execute({
    pattern: 'ContextForker',
    path: '.',
    pathMatches: '**/*.ts',
    maxMatches: 10,
  }, toolContext(cwd))

  assert.equal(result.success, true)
  const output = String(result.output)
  assert.match(output, /source\.ts:1:export const ContextForker = true/)
  assert.doesNotMatch(output, /notes\.md/)
})

test('Grep schema accepts pathMatches', () => {
  const result = grepTool.inputSchema.safeParse({
    pattern: 'ContextForker|forkContext|contextFork',
    path: 'src',
    pathMatches: '**/*.ts',
    maxMatches: 80,
  })

  assert.equal(result.success, true)
})

test('Grep supports regex alternation in fallback-capable execution', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'babel-o-grep-regex-'))
  await writeFile(join(cwd, 'context.ts'), 'const forkContext = () => true\n')

  const result = await grepTool.execute({
    pattern: 'ContextForker|forkContext|contextFork',
    path: '.',
    pathMatches: '**/*.ts',
    maxMatches: 10,
  }, toolContext(cwd))

  assert.equal(result.success, true)
  assert.match(String(result.output), /context\.ts:1:const forkContext = \(\) => true/)
})

function toolContext(cwd: string) {
  return {
    cwd,
    sessionId: 'session-grep-test',
    maxOutputBytes: 100_000,
    bashMaxBufferBytes: 100_000,
  }
}
