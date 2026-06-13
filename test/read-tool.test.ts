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
    assert.ok(output.includes('shownBytes="0-50000"'))
    assert.ok(output.includes('shownLines='))
    assert.ok(output.includes('byteOffset=50000'))
    assert.ok(output.length < 80_000)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('Read diagnoses workspace path drift for missing absolute paths', async () => {
  const root = await makeTmpDir()
  const cwd = join(root, 'BABEL', 'BabeL-O')
  try {
    await mkdir(join(cwd, 'src'), { recursive: true })
    await writeFile(join(cwd, 'src', 'index.ts'), 'export {}', 'utf8')
    const wrongPath = join(root, 'BabeL-O', 'src', 'index.ts')

    const result = await readTool.execute(
      { path: wrongPath, maxBytes: 200_000, mode: 'auto' },
      { cwd, sessionId: 'session-read-path-drift', maxOutputBytes: 1_000_000, bashMaxBufferBytes: 1_000_000 },
    )

    assert.equal(result.success, false)
    const output = String(result.output)
    assert.match(output, /Read could not find/)
    assert.match(output, /PATH_DRIFT_SUSPECTED/)
    assert.match(output, new RegExp(join('BABEL', 'BabeL-O', 'src', 'index.ts').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(output, /Do not treat the missing path as evidence/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Read supports targeted byteOffset and byteLimit ranges', async () => {
  const cwd = await makeTmpDir()
  try {
    await writeFile(join(cwd, 'range.txt'), 'abcdefghij', 'utf8')
    const result = await readTool.execute(
      { path: 'range.txt', byteOffset: 2, byteLimit: 4, maxBytes: 200_000, mode: 'auto' },
      { cwd, sessionId: 'session-read-range', maxOutputBytes: 1_000_000, bashMaxBufferBytes: 1_000_000 },
    )

    assert.equal(result.success, true)
    const output = String(result.output)
    assert.ok(output.startsWith('cdef'))
    assert.match(output, /<read-truncated path="range\.txt" bytes="10" shownBytes="2-6" shownLines="1-1">/)
    assert.match(output, /byteOffset=6/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('Read supports targeted lineOffset and lineLimit ranges', async () => {
  const cwd = await makeTmpDir()
  try {
    await writeFile(join(cwd, 'lines.md'), ['one', 'two', 'three', 'four', 'five'].join('\n'), 'utf8')
    const result = await readTool.execute(
      { path: 'lines.md', lineOffset: 2, lineLimit: 3, maxBytes: 200_000, mode: 'auto' },
      { cwd, sessionId: 'session-read-line-range', maxOutputBytes: 1_000_000, bashMaxBufferBytes: 1_000_000 },
    )

    assert.equal(result.success, true)
    const output = String(result.output)
    assert.ok(output.startsWith('two\nthree\nfour\n'))
    assert.doesNotMatch(output, /^one/m)
    assert.doesNotMatch(output, /^five/m)
    assert.match(output, /shownBytes="4-19"/)
    assert.match(output, /shownLines="2-4"/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('Read deprecated offset and limit remain byte aliases with diagnostic', async () => {
  const cwd = await makeTmpDir()
  try {
    await writeFile(join(cwd, 'deprecated.txt'), 'abcdefghij', 'utf8')
    const result = await readTool.execute(
      { path: 'deprecated.txt', offset: 2, limit: 4, maxBytes: 200_000, mode: 'auto' },
      { cwd, sessionId: 'session-read-deprecated-range', maxOutputBytes: 1_000_000, bashMaxBufferBytes: 1_000_000 },
    )

    assert.equal(result.success, true)
    const output = String(result.output)
    assert.match(output, /DEPRECATED_OFFSET_LIMIT/)
    assert.match(output, /lineOffset\/lineLimit/)
    assert.match(output, /byteOffset\/byteLimit/)
    assert.match(output, /shownBytes="2-6"/)
    assert.ok(output.includes('cdef'))
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('Read rejects mixed line and byte range styles', async () => {
  const cwd = await makeTmpDir()
  try {
    await writeFile(join(cwd, 'mixed.txt'), 'one\ntwo\nthree\n', 'utf8')
    const result = await readTool.execute(
      { path: 'mixed.txt', lineOffset: 2, byteOffset: 4, maxBytes: 200_000, mode: 'auto' },
      { cwd, sessionId: 'session-read-mixed-range', maxOutputBytes: 1_000_000, bashMaxBufferBytes: 1_000_000 },
    )

    assert.equal(result.success, false)
    assert.match(String(result.output), /INVALID_READ_RANGE/)
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
    assert.ok(repeatOutput.includes('previousLines="1-10000"'))
    assert.ok(repeatOutput.includes('currentLines="1-10000"'))
    assert.ok(repeatOutput.includes('lastReadIndex="1"'))
    assert.ok(repeatOutput.includes('session read #1'))
    assert.ok(repeatOutput.includes('byteOffset=50000'))
    assert.ok(repeatOutput.includes('Use Grep to search for symbols/errors'))

    const targeted = await readTool.execute(
      { path: 'large-repeat.txt', byteOffset: 50_000, byteLimit: 6, maxBytes: 200_000, mode: 'auto' },
      { cwd, sessionId: 'session-read-repeat', maxOutputBytes: 1_000_000, bashMaxBufferBytes: 1_000_000 },
    )
    assert.equal(targeted.success, true)
    assert.ok(String(targeted.output).startsWith('needle'))
    assert.ok(!String(targeted.output).includes('<read-repeat'))
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
