import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createReplacementState,
  persistToolResult,
  replaceLargeToolResult,
  enforceMessageBudget,
} from '../src/runtime/toolResultBudget.js'

const makeTmpDir = async () => {
  const dir = join(tmpdir(), `babel-o-budget-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(dir, { recursive: true })
  return dir
}

test('persistToolResult writes file and returns preview', async () => {
  const cwd = await makeTmpDir()
  const content = 'x'.repeat(5000)
  const result = await persistToolResult(content, 'tool-1', 'sess-1', cwd)
  assert.ok(result)
  assert.ok(result.preview.length <= 2000)
  const saved = await readFile(result.filepath, 'utf8')
  assert.equal(saved, content)
  await rm(cwd, { recursive: true, force: true })
})

test('persistToolResult returns null on duplicate (wx flag)', async () => {
  const cwd = await makeTmpDir()
  const content = 'hello'
  const first = await persistToolResult(content, 'tool-dup', 'sess-1', cwd)
  assert.ok(first)
  const second = await persistToolResult(content, 'tool-dup', 'sess-1', cwd)
  assert.equal(second, null)
  await rm(cwd, { recursive: true, force: true })
})

test('replaceLargeToolResult returns content unchanged when below threshold', async () => {
  const result = await replaceLargeToolResult({
    content: 'small',
    toolUseId: 'tool-1',
    toolName: 'Bash',
    sessionId: 'sess-1',
    cwd: tmpdir(),
    threshold: 100,
  })
  assert.equal(result, 'small')
})

test('replaceLargeToolResult persists and replaces large content', async () => {
  const cwd = await makeTmpDir()
  const content = 'y'.repeat(60000)
  const result = await replaceLargeToolResult({
    content,
    toolUseId: 'tool-big',
    toolName: 'Bash',
    sessionId: 'sess-2',
    cwd,
    threshold: 50000,
  })
  assert.ok(result.includes('<persisted-output>'))
  assert.ok(result.includes('59KB'))
  assert.ok(result.length < content.length)
  await rm(cwd, { recursive: true, force: true })
})

test('replaceLargeToolResult keeps a single Read result visible', async () => {
  const content = 'z'.repeat(60000)
  const result = await replaceLargeToolResult({
    content,
    toolUseId: 'tool-read',
    toolName: 'Read',
    sessionId: 'sess-3',
    cwd: tmpdir(),
    threshold: 50000,
  })
  assert.equal(result, content)
})

test('enforceMessageBudget leaves small messages unchanged', async () => {
  const state = createReplacementState()
  const messages = [
    { role: 'user' as const, content: [{ type: 'tool_result', toolUseId: 'id-1', content: 'short' }] },
  ]
  const result = await enforceMessageBudget(messages, state, 'sess', tmpdir(), 200000)
  assert.equal((result[0].content as any[])[0].content, 'short')
  assert.ok(state.seenIds.has('id-1'))
})

test('enforceMessageBudget applies aggregate Read budget', async () => {
  const cwd = await makeTmpDir()
  const state = createReplacementState()
  const firstRead = 'r'.repeat(70000)
  const secondRead = 's'.repeat(60000)
  const messages = [
    {
      role: 'user' as const,
      content: [
        { type: 'tool_result', toolUseId: 'read-1', toolName: 'Read', content: firstRead },
        { type: 'tool_result', toolUseId: 'read-2', toolName: 'Read', content: secondRead },
      ],
    },
  ]

  const result = await enforceMessageBudget(messages, state, 'sess-read-budget', cwd, {
    budget: 200000,
    readBudgetChars: 80000,
  })
  const blocks = result[0].content as any[]
  assert.ok(blocks[0].content.includes('<persisted-output>'))
  assert.equal(blocks[1].content, secondRead)
  assert.ok(state.replacements.has('read-1'))
  assert.ok(state.seenIds.has('read-1'))
  assert.ok(state.seenIds.has('read-2'))
  await rm(cwd, { recursive: true, force: true })
})

test('enforceMessageBudget replaces largest when over budget', async () => {
  const cwd = await makeTmpDir()
  const state = createReplacementState()
  const large = 'a'.repeat(150000)
  const small = 'b'.repeat(10000)
  const messages = [
    {
      role: 'user' as const,
      content: [
        { type: 'tool_result', toolUseId: 'big-1', content: large },
        { type: 'tool_result', toolUseId: 'small-1', content: small },
      ],
    },
  ]
  const result = await enforceMessageBudget(messages, state, 'sess-budget', cwd, 100000)
  const blocks = result[0].content as any[]
  assert.ok(blocks[0].content.includes('<persisted-output>'))
  assert.equal(blocks[1].content, small)
  assert.ok(state.replacements.has('big-1'))
  await rm(cwd, { recursive: true, force: true })
})

test('enforceMessageBudget re-applies replacements on subsequent calls', async () => {
  const cwd = await makeTmpDir()
  const state = createReplacementState()
  const large = 'c'.repeat(150000)
  const messages = [
    { role: 'user' as const, content: [{ type: 'tool_result', toolUseId: 'reuse-1', content: large }] },
  ]
  await enforceMessageBudget(messages, state, 'sess-reuse', cwd, 100000)
  const replacement = state.replacements.get('reuse-1')
  assert.ok(replacement)

  const messages2 = [
    { role: 'user' as const, content: [{ type: 'tool_result', toolUseId: 'reuse-1', content: large }] },
    { role: 'user' as const, content: [{ type: 'tool_result', toolUseId: 'new-1', content: 'tiny' }] },
  ]
  const result2 = await enforceMessageBudget(messages2, state, 'sess-reuse', cwd, 100000)
  assert.equal((result2[0].content as any[])[0].content, replacement)
  assert.equal((result2[1].content as any[])[0].content, 'tiny')
  await rm(cwd, { recursive: true, force: true })
})

test('enforceMessageBudget skips non-user messages', async () => {
  const state = createReplacementState()
  const messages = [
    { role: 'assistant' as const, content: 'hello' },
    { role: 'user' as const, content: 'plain text' },
  ]
  const result = await enforceMessageBudget(messages, state, 'sess', tmpdir())
  assert.equal(result.length, 2)
  assert.equal(result[0].content, 'hello')
  assert.equal(result[1].content, 'plain text')
})
