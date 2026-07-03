import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runEverOSMemorySetup, formatEverOSMemorySetupStatus } from '../src/runtime/everosBootstrap.js'
import type { CommandRunner } from '../src/runtime/everosPrerequisites.js'
import { createEverOSBootstrapState, updateEverOSBootstrapState } from '../src/shared/everosBootstrapStore.js'

function makeTempEnv(): { env: NodeJS.ProcessEnv; dir: string; bootstrapFile: string; sourceDir: string; dataDir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'babel-o-everos-bootstrap-'))
  const bootstrapFile = join(dir, 'everos-bootstrap.json')
  const sourceDir = join(dir, 'source')
  const dataDir = join(dir, 'data')
  return {
    dir,
    bootstrapFile,
    sourceDir,
    dataDir,
    env: {
      ...process.env,
      BABEL_O_CONFIG_FILE: join(dir, 'config.json'),
      BABEL_O_EVEROS_BOOTSTRAP_FILE: bootstrapFile,
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('runEverOSMemorySetup records missing git as non-fatal failed state', async () => {
  const { env, bootstrapFile, cleanup } = makeTempEnv()
  try {
    const runner: CommandRunner = async command => {
      if (command === 'python3' || command === 'uv') return { code: 0, stdout: `${command} ok`, stderr: '' }
      return { code: 127, stdout: '', stderr: `${command} missing` }
    }

    const result = await runEverOSMemorySetup({ env, runner, nonInteractive: true })
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'EVEROS_BOOTSTRAP_GIT_MISSING')
    const state = JSON.parse(readFileSync(bootstrapFile, 'utf8'))
    assert.equal(state.buildStatus, 'failed')
    assert.equal(state.errorCode, 'EVEROS_BOOTSTRAP_GIT_MISSING')
  } finally {
    cleanup()
  }
})

test('runEverOSMemorySetup clones, builds, and writes ready state with mocked commands', async () => {
  const { env, bootstrapFile, sourceDir, dataDir, cleanup } = makeTempEnv()
  try {
    const commands: string[] = []
    const runner: CommandRunner = async (command, args, options) => {
      commands.push(`${command} ${args.join(' ')}`)
      if (args[0] === '--version') return { code: 0, stdout: `${command} version`, stderr: '' }
      if (command === 'git' && args[0] === 'clone') {
        const target = args[args.length - 1]!
        mkdirSync(join(target, '.git'), { recursive: true })
        return { code: 0, stdout: '', stderr: '' }
      }
      if (command === 'git' && args[0] === 'rev-parse') {
        return { code: 0, stdout: 'abcdef123456\n', stderr: '' }
      }
      if (command === 'uv' && args[0] === 'sync') {
        const bin = join(options?.cwd ?? sourceDir, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin')
        mkdirSync(bin, { recursive: true })
        const exe = join(bin, process.platform === 'win32' ? 'everos.exe' : 'everos')
        writeFileSync(exe, '#!/bin/sh\n')
        chmodSync(exe, 0o755)
        return { code: 0, stdout: '', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    }

    const result = await runEverOSMemorySetup({
      env,
      runner,
      nonInteractive: true,
      sourceRepo: 'https://example.invalid/EverOS.git',
      sourceRef: 'main',
      sourceDir,
      dataDir,
    })
    assert.equal(result.ok, true)
    assert.ok(commands.some(command => command.startsWith('git clone')))
    assert.ok(commands.some(command => command.startsWith('uv sync')))
    const state = JSON.parse(readFileSync(bootstrapFile, 'utf8'))
    assert.equal(state.buildStatus, 'ready')
    assert.equal(state.sourceCommit, 'abcdef123456')
    assert.equal(state.dataDir, dataDir)
    assert.match(state.managedCommand, /everos(\.exe)?$/)
    // nonInteractive setup must skip the embedding prompt (no TTY) and
    // leave embeddingPassthrough unset rather than hanging on readline.
    assert.equal(state.embeddingPassthrough, undefined)
  } finally {
    cleanup()
  }
})

test('runEverOSMemorySetup preserves existing embeddingPassthrough across --retry', async () => {
  const { env, bootstrapFile, sourceDir, dataDir, cleanup } = makeTempEnv()
  try {
    // Pre-configure embedding so the prompt is short-circuited (existing ?? prompt).
    await updateEverOSBootstrapState(() => createEverOSBootstrapState({
      optedIn: true,
      buildStatus: 'ready',
      managedCommand: '/tmp/everos',
      dataDir,
      sourceDir,
      embeddingPassthrough: { source: 'ollama', model: 'bge-m3', baseUrl: 'http://localhost:11434/v1' },
    }), { env })

    const runner: CommandRunner = async (command, args, options) => {
      if (args[0] === '--version') return { code: 0, stdout: `${command} version`, stderr: '' }
      if (command === 'git' && args[0] === 'clone') {
        mkdirSync(join(args[args.length - 1]!, '.git'), { recursive: true })
        return { code: 0, stdout: '', stderr: '' }
      }
      if (command === 'git' && args[0] === 'rev-parse') return { code: 0, stdout: 'abcdef123456\n', stderr: '' }
      if (command === 'uv' && args[0] === 'sync') {
        const bin = join(options?.cwd ?? sourceDir, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin')
        mkdirSync(bin, { recursive: true })
        writeFileSync(join(bin, process.platform === 'win32' ? 'everos.exe' : 'everos'), '#!/bin/sh\n')
        return { code: 0, stdout: '', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    }

    const result = await runEverOSMemorySetup({
      env, runner, retry: true, nonInteractive: true,
      sourceRepo: 'https://example.invalid/EverOS.git', sourceRef: 'main', sourceDir, dataDir,
    })
    assert.equal(result.ok, true)
    const state = JSON.parse(readFileSync(bootstrapFile, 'utf8'))
    assert.equal(state.buildStatus, 'ready')
    assert.deepEqual(state.embeddingPassthrough, { source: 'ollama', model: 'bge-m3', baseUrl: 'http://localhost:11434/v1' })
  } finally {
    cleanup()
  }
})

test('formatEverOSMemorySetupStatus surfaces embedding config and not-configured hint', async () => {
  const { env, cleanup } = makeTempEnv()
  try {
    // Ready + embedding configured → status prints the passthrough line.
    await updateEverOSBootstrapState(() => createEverOSBootstrapState({
      optedIn: true,
      buildStatus: 'ready',
      managedCommand: '/tmp/everos',
      dataDir: '/tmp/everos-data',
      embeddingPassthrough: { source: 'ollama', model: 'bge-m3', baseUrl: 'http://localhost:11434/v1' },
    }), { env })
    let status = await formatEverOSMemorySetupStatus(env)
    assert.match(status, /embeddingPassthrough: source=ollama model=bge-m3 baseUrl=http:\/\/localhost:11434\/v1/)
    assert.match(status, /apiKey=ollama\(builtin\)/)

    // Ready + embedding missing → status prints the fix hint (not a silent ready).
    await updateEverOSBootstrapState(current => createEverOSBootstrapState({
      ...current,
      embeddingPassthrough: undefined,
    }), { env })
    status = await formatEverOSMemorySetupStatus(env)
    assert.match(status, /embeddingPassthrough: not configured \(run `bbl memory setup` to enable memory search\)/)
  } finally {
    cleanup()
  }
})
