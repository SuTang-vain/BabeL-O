import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { test } from 'node:test'
import { runFirstRunOnboarding } from '../src/cli/commands/firstRun.js'

function makeTempEnv(): { env: NodeJS.ProcessEnv; bootstrapFile: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'babel-o-everos-first-run-'))
  const bootstrapFile = join(dir, 'everos-bootstrap.json')
  return {
    bootstrapFile,
    env: {
      ...process.env,
      BABEL_O_CONFIG_FILE: join(dir, 'config.json'),
      BABEL_O_EVEROS_BOOTSTRAP_FILE: bootstrapFile,
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function makeTTYInput(answer: string): NodeJS.ReadStream {
  const input = new PassThrough() as unknown as NodeJS.ReadStream
  ;(input as any).isTTY = true
  queueMicrotask(() => {
    input.push(`${answer}\n`)
  })
  return input
}

function makeTTYOutput(): { output: NodeJS.WriteStream; text: () => string } {
  let buffer = ''
  const output = new Writable({
    write(chunk, _encoding, callback) {
      buffer += chunk.toString()
      callback()
    },
  }) as NodeJS.WriteStream
  ;(output as any).isTTY = true
  return { output, text: () => buffer }
}

test('first-run onboarding skips non-TTY without writing bootstrap state', async () => {
  const { env, bootstrapFile, cleanup } = makeTempEnv()
  try {
    await runFirstRunOnboarding({ env, stdin: new PassThrough() as unknown as NodeJS.ReadStream, stdout: new PassThrough() as unknown as NodeJS.WriteStream })
    assert.equal(existsSync(bootstrapFile), false)
  } finally {
    cleanup()
  }
})

test('first-run onboarding skips when explicit EverCore env is present', async () => {
  const { env, bootstrapFile, cleanup } = makeTempEnv()
  try {
    const { output } = makeTTYOutput()
    await runFirstRunOnboarding({
      env: { ...env, BABEL_O_EVERCORE_MODE: 'external' },
      stdin: makeTTYInput('2'),
      stdout: output,
    })
    assert.equal(existsSync(bootstrapFile), false)
  } finally {
    cleanup()
  }
})

test('first-run onboarding opt-out persists opted-out state', async () => {
  const { env, bootstrapFile, cleanup } = makeTempEnv()
  try {
    const { output, text } = makeTTYOutput()
    await runFirstRunOnboarding({ env, stdin: makeTTYInput('2'), stdout: output })
    assert.match(text(), /Optional local long-term memory/)
    const state = JSON.parse(readFileSync(bootstrapFile, 'utf8'))
    assert.equal(state.optedOut, true)
    assert.equal(state.buildStatus, 'opted_out')
  } finally {
    cleanup()
  }
})

test('first-run onboarding external preference persists external state', async () => {
  const { env, bootstrapFile, cleanup } = makeTempEnv()
  try {
    await runFirstRunOnboarding({ env, stdin: makeTTYInput('3'), stdout: makeTTYOutput().output })
    const state = JSON.parse(readFileSync(bootstrapFile, 'utf8'))
    assert.equal(state.externalHintShown, true)
    assert.equal(state.buildStatus, 'external')
  } finally {
    cleanup()
  }
})
