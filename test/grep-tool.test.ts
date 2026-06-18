import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
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

test('Grep rejects boolean-string pathMatches with recoverable guidance', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'babel-o-grep-pathmatches-invalid-'))
  await writeFile(join(cwd, 'source.ts'), 'evercore integration\n')

  const result = await grepTool.execute({
    pattern: 'evercore',
    path: '.',
    pathMatches: 'true',
    maxMatches: 10,
  }, toolContext(cwd))

  assert.equal(result.success, false)
  const output = String(result.output)
  assert.match(output, /INVALID_GREP_PATH_MATCHES_GLOB/)
  assert.match(output, /file glob filter, not a boolean/)
  assert.match(output, /Omit pathMatches to search all files/)
  assert.match(output, /\*\*\/\*\.ts/)
})

test('Grep supports pathMatches array for multiple include globs', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'babel-o-grep-pathmatches-array-'))
  await mkdir(join(cwd, 'src'))
  await mkdir(join(cwd, 'docs'))
  await mkdir(join(cwd, 'scripts'))
  await writeFile(join(cwd, 'src', 'source.ts'), 'export const MemoryProvider = true\n')
  await writeFile(join(cwd, 'docs', 'memory.md'), 'MemoryProvider docs\n')
  await writeFile(join(cwd, 'scripts', 'memory.sh'), 'echo MemoryProvider\n')

  const result = await grepTool.execute({
    pattern: 'MemoryProvider',
    path: '.',
    pathMatches: ['src/**/*.ts', 'docs/**/*.md'],
    maxMatches: 10,
  }, toolContext(cwd))

  assert.equal(result.success, true)
  const output = String(result.output)
  assert.match(output, /src\/source\.ts:1:export const MemoryProvider = true/)
  assert.match(output, /docs\/memory\.md:1:MemoryProvider docs/)
  assert.doesNotMatch(output, /scripts\/memory\.sh/)
})

test('Grep rejects boolean-string values inside pathMatches array', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'babel-o-grep-pathmatches-array-invalid-'))
  await writeFile(join(cwd, 'source.ts'), 'evercore integration\n')

  const result = await grepTool.execute({
    pattern: 'evercore',
    path: '.',
    pathMatches: ['src/**/*.ts', 'true'],
    maxMatches: 10,
  }, toolContext(cwd))

  assert.equal(result.success, false)
  const output = String(result.output)
  assert.match(output, /INVALID_GREP_PATH_MATCHES_GLOB/)
  assert.match(output, /file glob filter, not a boolean/)
  assert.match(output, /use an array/)
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

test('Grep schema accepts pathMatches array', () => {
  const result = grepTool.inputSchema.safeParse({
    pattern: 'MemoryProvider|memoryProvider',
    path: '.',
    pathMatches: ['src/**/*.ts', 'test/**/*.ts', 'docs/**/*.md'],
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

test('Grep supports patterns that start with a dash', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'babel-o-grep-leading-dash-'))
  await writeFile(join(cwd, 'todo.md'), '- [ ] unchecked task\n- [x] done task\n')

  const result = await grepTool.execute({
    pattern: '- \\[ \\]',
    path: '.',
    pathMatches: '**/*.md',
    maxMatches: 10,
  }, toolContext(cwd))

  assert.equal(result.success, true)
  assert.match(String(result.output), /todo\.md:1:- \[ \] unchecked task/)
})

function toolContext(cwd: string) {
  return {
    cwd,
    sessionId: 'session-grep-test',
    maxOutputBytes: 100_000,
    bashMaxBufferBytes: 100_000,
  }
}
