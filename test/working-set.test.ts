import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { NexusEvent } from '../src/shared/events.js'
import { deriveWorkingSet, formatWorkingSet, WORKING_SET_LIMIT } from '../src/runtime/workingSet.js'

const schemaVersion = '2026-05-21.babel-o.v1' as const

function userMessage(text: string, turn: number): NexusEvent {
  return {
    type: 'user_message',
    schemaVersion,
    sessionId: 'session-working-set',
    timestamp: `2026-05-23T00:${String(turn).padStart(2, '0')}:00.000Z`,
    text,
  }
}

function toolStarted(input: unknown, index: number): NexusEvent {
  return {
    type: 'tool_started',
    schemaVersion,
    sessionId: 'session-working-set',
    timestamp: `2026-05-23T00:00:${String(index).padStart(2, '0')}.000Z`,
    toolUseId: `tool-${index}`,
    name: 'Read',
    input,
  }
}

test('deriveWorkingSet extracts user and tool paths with stable formatting', async () => {
  const cwd = join(tmpdir(), `babel-o-working-set-${Date.now()}`)
  await mkdir(join(cwd, 'src', 'runtime'), { recursive: true })
  await writeFile(join(cwd, 'src', 'runtime', 'workingSet.ts'), 'export {}\n', 'utf8')

  try {
    const events: NexusEvent[] = [
      userMessage('Inspect src/runtime/workingSet.ts and ./src/runtime.', 1),
      toolStarted({ path: 'src/runtime/workingSet.ts' }, 1),
      toolStarted({ nested: { filePath: './src/runtime/workingSet.ts' } }, 2),
      userMessage(`Now compare ${join(cwd, 'src', 'runtime')}.`, 2),
    ]

    const entries = deriveWorkingSet(events, cwd)
    const filePath = join(cwd, 'src', 'runtime', 'workingSet.ts')
    const dirPath = join(cwd, 'src', 'runtime')
    const fileEntry = entries.find(entry => entry.path === filePath)
    const dirEntry = entries.find(entry => entry.path === dirPath)

    assert.equal(fileEntry?.touches, 3)
    assert.equal(fileEntry?.lastTurn, 1)
    assert.equal(fileEntry?.isDir, false)
    assert.equal(fileEntry?.source, 'user')
    assert.equal(dirEntry?.touches, 2)
    assert.equal(dirEntry?.lastTurn, 2)
    assert.equal(dirEntry?.isDir, true)
    assert.equal(dirEntry?.source, 'user')

    const formatted = formatWorkingSet(entries)
    assert.match(formatted, /Working Set:/)
    assert.match(formatted, new RegExp(filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(formatted, /touches=3/)
    assert.equal(formatWorkingSet([]), '')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('deriveWorkingSet selects by score then emits byte-stable touches path order', () => {
  const cwd = join(tmpdir(), 'babel-o-working-set-order')
  const events: NexusEvent[] = []

  for (let turn = 1; turn <= 20; turn += 1) {
    events.push(userMessage(`turn ${turn} mentions src/file-${String(turn).padStart(2, '0')}.ts`, turn))
  }
  events.push(toolStarted({ path: 'src/file-20.ts' }, 20))

  const entries = deriveWorkingSet(events, cwd)

  assert.equal(entries.length, WORKING_SET_LIMIT)
  assert.equal(entries[0]?.path, join(cwd, 'src', 'file-20.ts'))
  assert.equal(entries[0]?.touches, 2)
  assert.deepEqual(
    entries.slice(1).map(entry => entry.path),
    [
      'src/file-01.ts',
      'src/file-02.ts',
      'src/file-03.ts',
      'src/file-04.ts',
      'src/file-05.ts',
      'src/file-10.ts',
      'src/file-11.ts',
      'src/file-12.ts',
      'src/file-13.ts',
      'src/file-14.ts',
      'src/file-15.ts',
      'src/file-16.ts',
      'src/file-17.ts',
      'src/file-18.ts',
      'src/file-19.ts',
    ].map(path => join(cwd, path)),
  )
  assert.ok(!entries.some(entry => entry.path === join(cwd, 'src', 'file-06.ts')))
  assert.ok(!entries.some(entry => entry.path === join(cwd, 'src', 'file-09.ts')))
})
