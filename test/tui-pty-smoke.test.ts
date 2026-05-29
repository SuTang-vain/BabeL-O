import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..')
const driver = path.join(repoRoot, 'test', 'tui_pty_driver.py')
const shouldRun = process.env.BABEL_O_RUN_PTY_SMOKE === '1'

function stripAnsi(text: string) {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\r/g, '')
}

function runPtySmoke(sequence: string) {
  const python = process.env.PYTHON ?? 'python3'
  const result = spawnSync(python, [driver, '--sequence', sequence, '--timeout', '10'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      NO_COLOR: '1',
    },
    timeout: 20_000,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  assert.equal(result.status, 0, output)
  return stripAnsi(output)
}

test('PTY smoke: slash palette opens and exits cleanly', { skip: !shouldRun || !existsSync(driver) }, () => {
  const output = runPtySmoke('slash-palette')
  assert.match(output, /Insert bash prompt prefix/)
  assert.match(output, /BabeL-O/)
})

test('PTY smoke: permission panel escape rejects without approval', { skip: !shouldRun || !existsSync(driver) }, () => {
  const output = runPtySmoke('permission-reject-escape')
  assert.match(output, /approval/)
  assert.match(output, /Permission denied/)
  assert.doesNotMatch(output, /Permission approved/)
})

test('PTY smoke: permission panel backspace rejects without approval', { skip: !shouldRun || !existsSync(driver) }, () => {
  const output = runPtySmoke('permission-reject-backspace')
  assert.match(output, /approval/)
  assert.match(output, /Permission denied/)
  assert.doesNotMatch(output, /Permission approved/)
})

test('PTY smoke: permission panel numeric approve once completes command', { skip: !shouldRun || !existsSync(driver) }, () => {
  const output = runPtySmoke('permission-approve-once')
  assert.match(output, /approval/)
  assert.match(output, /Permission approved/)
  assert.match(output, /Bash node -v done/)
})

test('PTY smoke: permission panel session approval caches the tool rule', { skip: !shouldRun || !existsSync(driver) }, () => {
  const output = runPtySmoke('permission-approve-session')
  assert.match(output, /Bash node -v done/)
  assert.match(output, /Bash node -p 1 done/)
})

test('PTY smoke: permission panel editable rule path completes command', { skip: !shouldRun || !existsSync(driver) }, () => {
  const output = runPtySmoke('permission-editable-rule')
  assert.match(output, /Enter allow rule prefix/)
  assert.match(output, /Bash node -v done/)
})

test('PTY smoke: permission panel reject with instruction renders reason', { skip: !shouldRun || !existsSync(driver) }, () => {
  const output = runPtySmoke('permission-reject-instruction')
  assert.match(output, /Tell the model what to do instead/)
  assert.match(output, /Permission denied: Use Read instead/)
})

test('PTY smoke: compact read tool rendering hides raw state', { skip: !shouldRun || !existsSync(driver) }, () => {
  const output = runPtySmoke('tool-rendering-read')
  assert.match(output, /Read package\.json done/)
  assert.doesNotMatch(output, /maxBytes/)
  assert.doesNotMatch(output, /running/)
})
