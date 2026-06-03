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
