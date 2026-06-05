import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readTool } from '../src/tools/builtin/read.js'

async function makeTmpDir() {
  const dir = join(tmpdir(), `babel-o-read-tool-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(dir, { recursive: true })
  return dir
}

test('Read auto mode previews files larger than maxBytes', async () => {
  const cwd = await makeTmpDir()
  try {
    await writeFile(join(cwd, 'large.txt'), 'x'.repeat(220_000), 'utf8')
    const result = await readTool.execute(
      { path: 'large.txt', maxBytes: 200_000, mode: 'auto' },
      { cwd, sessionId: 'session-read-preview', maxOutputBytes: 1_000_000, bashMaxBufferBytes: 1_000_000 },
    )

    assert.equal(result.success, true)
    const output = String(result.output)
    assert.ok(output.includes('<read-preview'))
    assert.ok(output.includes('offset=50000'))
    assert.ok(output.length < 80_000)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('Read supports targeted offset and limit ranges', async () => {
  const cwd = await makeTmpDir()
  try {
    await writeFile(join(cwd, 'range.txt'), 'abcdefghij', 'utf8')
    const result = await readTool.execute(
      { path: 'range.txt', offset: 2, limit: 4, maxBytes: 200_000, mode: 'auto' },
      { cwd, sessionId: 'session-read-range', maxOutputBytes: 1_000_000, bashMaxBufferBytes: 1_000_000 },
    )

    assert.equal(result.success, true)
    assert.equal(result.output, 'cdef\n<read-truncated path="range.txt" bytes="10" shownRange="2-6">Use Read with offset=6 and limit=4 to continue.</read-truncated>')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('Read diagnoses repeated large file reads and points to targeted ranges', async () => {
  const cwd = await makeTmpDir()
  try {
    const content = `${'line\n'.repeat(10_000)}needle${'b'.repeat(170_000)}`
    await writeFile(join(cwd, 'large-repeat.txt'), content, 'utf8')

    const first = await readTool.execute(
      { path: 'large-repeat.txt', maxBytes: 200_000, mode: 'auto' },
      { cwd, sessionId: 'session-read-repeat', maxOutputBytes: 1_000_000, bashMaxBufferBytes: 1_000_000 },
    )
    assert.equal(first.success, true)
    assert.ok(String(first.output).includes('<read-preview'))

    const second = await readTool.execute(
      { path: 'large-repeat.txt', maxBytes: 200_000, mode: 'auto' },
      { cwd, sessionId: 'session-read-repeat', maxOutputBytes: 1_000_000, bashMaxBufferBytes: 1_000_000 },
    )
    assert.equal(second.success, true)
    const repeatOutput = String(second.output)
    assert.ok(repeatOutput.includes('<read-repeat'))
    assert.ok(repeatOutput.includes('previousRange="0-50000"'))
    assert.ok(repeatOutput.includes('previousLines="1-10001"'))
    assert.ok(repeatOutput.includes('currentLines="1-10001"'))
    assert.ok(repeatOutput.includes('lastReadIndex="1"'))
    assert.ok(repeatOutput.includes('session read #1'))
    assert.ok(repeatOutput.includes('offset=50000'))
    assert.ok(repeatOutput.includes('Use Grep to search for symbols/errors'))

    const targeted = await readTool.execute(
      { path: 'large-repeat.txt', offset: 50_000, limit: 6, maxBytes: 200_000, mode: 'auto' },
      { cwd, sessionId: 'session-read-repeat', maxOutputBytes: 1_000_000, bashMaxBufferBytes: 1_000_000 },
    )
    assert.equal(targeted.success, true)
    assert.ok(String(targeted.output).startsWith('needle'))
    assert.ok(!String(targeted.output).includes('<read-repeat'))
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
