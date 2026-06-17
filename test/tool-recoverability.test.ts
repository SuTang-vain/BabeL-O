import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { editTool } from '../src/tools/builtin/edit.js'
import { globTool } from '../src/tools/builtin/glob.js'
import { taskTool } from '../src/tools/builtin/task.js'
import { writeTool } from '../src/tools/builtin/write.js'
import type { NexusStorage } from '../src/storage/Storage.js'

function toolContext(cwd: string, storage?: NexusStorage) {
  return {
    cwd,
    sessionId: 'session-tool-recoverability-test',
    maxOutputBytes: 200_000,
    bashMaxBufferBytes: 1_000_000,
    storage,
  }
}

test('Write returns a structured recoverable result when the parent path is not a directory', async () => {
  const cwd = join(tmpdir(), `babel-o-write-recoverable-${Date.now()}`)
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'blocked'), 'not a directory', 'utf8')

  const result = await writeTool.execute(
    { path: 'blocked/child.txt', content: 'hello' },
    toolContext(cwd),
  )

  assert.equal(result.success, false)
  assert.equal((result.output as any).code, 'WRITE_FAILED')
  assert.equal((result.output as any).path, 'blocked/child.txt')
  assert.match((result.output as any).repairHint, /parent path/)
  assert.match(String((result.output as any).details.code), /EEXIST|ENOTDIR/)
})

test('Edit returns a structured recoverable result for missing target files', async () => {
  const cwd = join(tmpdir(), `babel-o-edit-missing-recoverable-${Date.now()}`)
  await mkdir(cwd, { recursive: true })

  const result = await editTool.execute(
    { path: 'missing.txt', oldString: 'before', newString: 'after' },
    toolContext(cwd),
  )

  assert.equal(result.success, false)
  assert.equal((result.output as any).code, 'EDIT_FILE_NOT_FOUND')
  assert.equal((result.output as any).path, 'missing.txt')
  assert.match((result.output as any).repairHint, /Glob\/ListDir/)
  assert.equal((result.output as any).details.code, 'ENOENT')
})

test('Edit returns structured repair hints when oldString is absent or ambiguous', async () => {
  const cwd = join(tmpdir(), `babel-o-edit-string-recoverable-${Date.now()}`)
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'sample.txt'), 'alpha\nbeta\nalpha\n', 'utf8')

  const absent = await editTool.execute(
    { path: 'sample.txt', oldString: 'gamma', newString: 'delta' },
    toolContext(cwd),
  )
  assert.equal(absent.success, false)
  assert.equal((absent.output as any).code, 'EDIT_OLD_STRING_NOT_FOUND')
  assert.match((absent.output as any).repairHint, /copied exactly/)

  const ambiguous = await editTool.execute(
    { path: 'sample.txt', oldString: 'alpha', newString: 'omega' },
    toolContext(cwd),
  )
  assert.equal(ambiguous.success, false)
  assert.equal((ambiguous.output as any).code, 'EDIT_OLD_STRING_NOT_UNIQUE')
  assert.equal((ambiguous.output as any).occurrences, 2)
  assert.match((ambiguous.output as any).repairHint, /uniquely/)
})

test('Glob returns a structured recoverable result for invalid glob syntax', async () => {
  const cwd = join(tmpdir(), `babel-o-glob-recoverable-${Date.now()}`)
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'sample.txt'), 'content', 'utf8')

  const result = await globTool.execute(
    { pattern: '[', maxResults: 10 },
    toolContext(cwd),
  )

  assert.equal(result.success, false)
  assert.equal((result.output as any).code, 'GLOB_FAILED')
  assert.equal((result.output as any).pattern, '[')
  assert.match((result.output as any).repairHint, /glob syntax/)
})

test('TaskCreate returns a structured recoverable result when task storage fails', async () => {
  const cwd = join(tmpdir(), `babel-o-task-recoverable-${Date.now()}`)
  await mkdir(cwd, { recursive: true })
  const storage = {
    async saveTask() {
      const error = new Error('database is locked') as Error & { code?: string }
      error.code = 'SQLITE_BUSY'
      throw error
    },
  } as unknown as NexusStorage

  const result = await taskTool.execute(
    { title: 'Investigate recoverability' },
    toolContext(cwd, storage),
  )

  assert.equal(result.success, false)
  assert.equal((result.output as any).code, 'TASK_SAVE_FAILED')
  assert.equal((result.output as any).title, 'Investigate recoverability')
  assert.equal((result.output as any).details.code, 'SQLITE_BUSY')
  assert.match((result.output as any).repairHint, /Retry task creation/)
})
