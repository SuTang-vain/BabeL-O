import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { listDirTool, type ListDirOutput } from '../src/tools/builtin/listDir.js'

async function makeTmpDir() {
  const dir = join(tmpdir(), `babel-o-list-dir-tool-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(dir, { recursive: true })
  return dir
}

function toolContext(cwd: string) {
  return { cwd, sessionId: 'session-list-dir', maxOutputBytes: 1_000_000, bashMaxBufferBytes: 1_000_000 }
}

test('ListDir returns structured directory inventory with stable directories-first ordering', async () => {
  const cwd = await makeTmpDir()
  try {
    await mkdir(join(cwd, 'src'), { recursive: true })
    await writeFile(join(cwd, 'README.md'), 'hello', 'utf8')
    await writeFile(join(cwd, 'src', 'index.ts'), 'export {}', 'utf8')

    const result = await listDirTool.execute(
      { path: '.', maxEntries: 20, includeHidden: false, includeFiles: true, includeDirectories: true, maxDepth: 1 },
      toolContext(cwd),
    )

    assert.equal(result.success, true)
    const output = result.output as ListDirOutput
    assert.equal(output.path, '.')
    assert.equal(output.maxDepth, 1)
    assert.deepEqual(output.entries.map(entry => entry.path), ['src', 'README.md'])
    assert.deepEqual(output.entries.map(entry => entry.type), ['directory', 'file'])
    assert.equal(output.counts.directories, 1)
    assert.equal(output.counts.files, 1)
    assert.equal(output.counts.shown, 2)
    assert.equal(output.truncated, false)
    assert.match(output.guidance, /directory inventory/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('ListDir diagnoses workspace path drift for missing absolute directories', async () => {
  const root = await makeTmpDir()
  const cwd = join(root, 'BABEL', 'BabeL-O')
  try {
    await mkdir(join(cwd, 'src'), { recursive: true })
    await writeFile(join(cwd, 'src', 'index.ts'), 'export {}', 'utf8')
    const wrongPath = join(root, 'BabeL-O', 'src')

    const result = await listDirTool.execute(
      { path: wrongPath, maxEntries: 20, includeHidden: false, includeFiles: true, includeDirectories: true, maxDepth: 1 },
      toolContext(cwd),
    )

    assert.equal(result.success, false)
    const output = String(result.output)
    assert.match(output, /ListDir could not find directory/)
    assert.match(output, /PATH_DRIFT_SUSPECTED/)
    assert.ok(output.includes(join('BABEL', 'BabeL-O', 'src')))
    assert.match(output, /current cwd/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ListDir supports maxDepth=2 and skips dependency/build directories', async () => {
  const cwd = await makeTmpDir()
  try {
    await mkdir(join(cwd, 'src', 'components'), { recursive: true })
    await mkdir(join(cwd, 'node_modules', 'pkg'), { recursive: true })
    await mkdir(join(cwd, 'dist'), { recursive: true })
    await writeFile(join(cwd, 'src', 'app.ts'), 'app', 'utf8')
    await writeFile(join(cwd, 'src', 'components', 'button.ts'), 'button', 'utf8')

    const result = await listDirTool.execute(
      { path: '.', maxEntries: 20, includeHidden: false, includeFiles: true, includeDirectories: true, maxDepth: 2 },
      toolContext(cwd),
    )

    assert.equal(result.success, true)
    const output = result.output as ListDirOutput
    assert.ok(output.entries.some(entry => entry.path === 'src/components' && entry.depth === 2))
    assert.ok(output.entries.some(entry => entry.path === 'src/app.ts' && entry.depth === 2))
    assert.ok(!output.entries.some(entry => entry.path.startsWith('node_modules')))
    assert.ok(!output.entries.some(entry => entry.path.startsWith('dist')))
    assert.deepEqual(output.skippedDirs.sort(), ['dist', 'node_modules'])
    assert.equal(output.counts.skippedDirectories, 2)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('ListDir handles hidden entries, type filters, symlinks, and truncation', async () => {
  const cwd = await makeTmpDir()
  try {
    await mkdir(join(cwd, 'visible-dir'), { recursive: true })
    await mkdir(join(cwd, '.hidden-dir'), { recursive: true })
    await writeFile(join(cwd, 'a.txt'), 'a', 'utf8')
    await writeFile(join(cwd, 'b.txt'), 'b', 'utf8')
    await writeFile(join(cwd, '.env'), 'secret-ish', 'utf8')
    await symlink(join(cwd, 'a.txt'), join(cwd, 'a-link'))

    const directoriesOnly = await listDirTool.execute(
      { path: '.', maxEntries: 20, includeHidden: false, includeFiles: false, includeDirectories: true, maxDepth: 1 },
      toolContext(cwd),
    )
    const directoryOutput = directoriesOnly.output as ListDirOutput
    assert.deepEqual(directoryOutput.entries.map(entry => entry.path), ['visible-dir'])
    assert.equal(directoryOutput.counts.skippedHidden, 2)
    assert.ok(directoryOutput.counts.skippedByType >= 3)

    const withHidden = await listDirTool.execute(
      { path: '.', maxEntries: 2, includeHidden: true, includeFiles: true, includeDirectories: true, maxDepth: 1 },
      toolContext(cwd),
    )
    const hiddenOutput = withHidden.output as ListDirOutput
    assert.equal(hiddenOutput.entries.length, 2)
    assert.equal(hiddenOutput.truncated, true)
    assert.ok(hiddenOutput.entries.some(entry => entry.path === '.hidden-dir'))
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('ListDir rejects maxDepth above supported inventory range', () => {
  const result = listDirTool.inputSchema.safeParse({
    path: '.',
    maxEntries: 20,
    includeHidden: false,
    includeFiles: true,
    includeDirectories: true,
    maxDepth: 3,
  })

  assert.equal(result.success, false)
  assert.match(String(result.error), /maxDepth/)
})

test('ListDir rejects files and workspace escapes', async () => {
  const cwd = await makeTmpDir()
  const outside = await makeTmpDir()
  try {
    await writeFile(join(cwd, 'file.txt'), 'content', 'utf8')

    const fileResult = await listDirTool.execute(
      { path: 'file.txt', maxEntries: 20, includeHidden: false, includeFiles: true, includeDirectories: true, maxDepth: 1 },
      toolContext(cwd),
    )
    assert.equal(fileResult.success, false)
    assert.match(String(fileResult.output), /expected a directory/)

    const previousAllowed = process.env.NEXUS_ALLOWED_WORKSPACES
    process.env.NEXUS_ALLOWED_WORKSPACES = cwd
    try {
      await assert.rejects(
        () => listDirTool.execute(
          { path: outside, maxEntries: 20, includeHidden: false, includeFiles: true, includeDirectories: true, maxDepth: 1 },
          toolContext(cwd),
        ),
        /Path escapes workspace/,
      )
    } finally {
      if (previousAllowed === undefined) delete process.env.NEXUS_ALLOWED_WORKSPACES
      else process.env.NEXUS_ALLOWED_WORKSPACES = previousAllowed
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
