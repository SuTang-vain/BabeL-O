import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import {
  ATTACHMENT_REFERENCE_FILE_BYTES_LIMIT,
  expandAttachmentReferences,
  resolveAttachmentReferences,
} from '../src/cli/attachmentReferences.js'

async function createFixture() {
  const cwd = join(tmpdir(), `babel-o-attachments-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  await mkdir(join(cwd, 'src'), { recursive: true })
  await writeFile(join(cwd, 'src', 'context.ts'), 'export const answer = 42\n', 'utf8')
  await writeFile(join(cwd, 'src', 'notes with spaces.md'), '# Notes\nattached context\n', 'utf8')
  await writeFile(join(cwd, 'src', 'large.txt'), 'x'.repeat(80), 'utf8')
  await writeFile(join(cwd, 'src', 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]))
  return cwd
}

test('expandAttachmentReferences appends bounded text file attachments', async () => {
  const cwd = await createFixture()
  const expanded = expandAttachmentReferences('analyze @src/context.ts and @file:"src/notes with spaces.md"', cwd)

  assert.equal(expanded.appended, true)
  assert.equal(expanded.references.length, 2)
  assert.equal(expanded.references[0]!.kind, 'file')
  assert.match(expanded.prompt, /<attached_file_references>/)
  assert.match(expanded.prompt, /token="@src\/context.ts"/)
  assert.match(expanded.prompt, /path=".*src\/context\.ts"/)
  assert.match(expanded.prompt, /export const answer = 42/)
  assert.match(expanded.prompt, /attached context/)
  assert.equal(expanded.prompt.startsWith('analyze @src/context.ts'), true)
})

test('attachment references report unsupported or unsafe paths without embedding content', async () => {
  const cwd = await createFixture()
  const references = resolveAttachmentReferences('check @src/image.png @../outside.txt @src/missing.ts @src/large.txt', cwd, {
    fileBytesLimit: 16,
    totalBytesLimit: 128,
  })

  const image = references.find(reference => reference.token === '@src/image.png')
  assert.equal(image?.kind, 'image')
  assert.equal(image?.mimeType, 'image/png')
  assert.equal(references.find(reference => reference.token === '@../outside.txt')?.kind, 'outside-workspace')
  assert.equal(references.find(reference => reference.token === '@src/missing.ts')?.kind, 'missing')
  assert.equal(references.find(reference => reference.token === '@src/large.txt')?.kind, 'too-large')
  assert.equal(references.some(reference => reference.content?.includes('x'.repeat(20))), false)
})

test('image references accept @image and pasted file URI without multimodal embedding', async () => {
  const cwd = await createFixture()
  const imagePath = join(cwd, 'src', 'image.png')
  const fileUri = pathToFileURL(imagePath).toString()
  const expanded = expandAttachmentReferences(`inspect @image:src/image.png and ${fileUri}`, cwd)

  assert.equal(expanded.appended, true)
  assert.deepEqual(expanded.references.map(reference => reference.kind), ['image', 'image'])
  assert.deepEqual(expanded.references.map(reference => reference.mimeType), ['image/png', 'image/png'])
  assert.match(expanded.prompt, /status="image"/)
  assert.match(expanded.prompt, /mimeType="image\/png"/)
  assert.doesNotMatch(expanded.prompt, /\x89PNG/)
})

test('attachment references ignore symbol and diagnostic mentions and enforce caps', async () => {
  const cwd = await createFixture()
  const references = resolveAttachmentReferences('inspect @symbol:Foo @diag:TODO @src/context.ts @src/context.ts @src/notes', cwd, {
    maxReferences: 2,
  })

  assert.deepEqual(references.map(reference => reference.token), ['@src/context.ts', '@src/notes'])
  assert.equal(references[0]!.kind, 'file')
  assert.equal(references[1]!.kind, 'missing')
  assert.equal(ATTACHMENT_REFERENCE_FILE_BYTES_LIMIT, 64 * 1024)
})
