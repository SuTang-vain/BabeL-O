import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const repoRoot = join(import.meta.dirname, '..')
const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx')
const program = join(repoRoot, 'src', 'cli', 'program.ts')

function makeTempState(): { env: NodeJS.ProcessEnv; configFile: string; bootstrapFile: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'babel-o-memory-command-'))
  const configFile = join(dir, 'config.json')
  const bootstrapFile = join(dir, 'everos-bootstrap.json')
  writeFileSync(configFile, JSON.stringify({}))
  return {
    configFile,
    bootstrapFile,
    env: {
      ...process.env,
      BABEL_O_CONFIG_FILE: configFile,
      BABEL_O_EVEROS_BOOTSTRAP_FILE: bootstrapFile,
      BABEL_O_TEST_CONFIG_WRITE_GUARD: '1',
      NO_COLOR: '1',
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function runCli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(tsxBin, [program, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
    timeout: 30_000,
  })
}

test('bbl memory status reports unconfigured bootstrap path', () => {
  const { env, bootstrapFile, cleanup } = makeTempState()
  try {
    const result = runCli(['memory', 'status'], env)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /MemoryOS bootstrap has not been configured/)
    assert.match(result.stdout, new RegExp(bootstrapFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  } finally {
    cleanup()
  }
})

test('bbl memory opt-out writes opted-out state', () => {
  const { env, bootstrapFile, cleanup } = makeTempState()
  try {
    const result = runCli(['memory', 'opt-out'], env)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /prompt disabled/)
    const state = JSON.parse(readFileSync(bootstrapFile, 'utf8'))
    assert.equal(state.optedOut, true)
    assert.equal(state.buildStatus, 'opted_out')
  } finally {
    cleanup()
  }
})

test('bbl memory external records external preference', () => {
  const { env, bootstrapFile, cleanup } = makeTempState()
  try {
    const result = runCli(['memory', 'external'], env)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Recorded external MemoryOS preference/)
    const state = JSON.parse(readFileSync(bootstrapFile, 'utf8'))
    assert.equal(state.externalHintShown, true)
    assert.equal(state.buildStatus, 'external')
  } finally {
    cleanup()
  }
})

test('bbl memory reset requires confirmation and --yes removes state', () => {
  const { env, bootstrapFile, cleanup } = makeTempState()
  try {
    const optOut = runCli(['memory', 'opt-out'], env)
    assert.equal(optOut.status, 0, optOut.stderr)
    assert.equal(existsSync(bootstrapFile), true)

    const status = runCli(['memory', 'setup', '--status'], env)
    assert.equal(status.status, 0, status.stderr)
    assert.match(status.stdout, /status: opted_out/)

    const refused = runCli(['memory', 'setup', '--reset'], env)
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /Refusing to reset/)
    assert.equal(existsSync(bootstrapFile), true)

    const reset = runCli(['memory', 'setup', '--reset', '--yes'], env)
    assert.equal(reset.status, 0, reset.stderr)
    assert.equal(existsSync(bootstrapFile), false)
  } finally {
    cleanup()
  }
})

test('bbl memory auto sets the auto-bootstrap policy in state', () => {
  const { env, bootstrapFile, cleanup } = makeTempState()
  try {
    const show = runCli(['memory', 'auto'], env)
    assert.equal(show.status, 0, show.stderr)
    assert.match(show.stdout, /Auto-bootstrap policy/)
    assert.match(show.stdout, /state:\s*prompt/)

    const on = runCli(['memory', 'auto', 'on'], env)
    assert.equal(on.status, 0, on.stderr)
    assert.match(on.stdout, /Auto-bootstrap policy set to: on/)
    const onState = JSON.parse(readFileSync(bootstrapFile, 'utf8'))
    assert.equal(onState.autoBootstrapPolicy, 'on')

    const off = runCli(['memory', 'auto', 'off'], env)
    assert.equal(off.status, 0, off.stderr)
    const offState = JSON.parse(readFileSync(bootstrapFile, 'utf8'))
    assert.equal(offState.autoBootstrapPolicy, 'off')

    const bad = runCli(['memory', 'auto', 'sometimes'], env)
    assert.equal(bad.status, 1)
    assert.match(bad.stderr, /Invalid policy/)
  } finally {
    cleanup()
  }
})

test('bbl memory enable-tools / disable-tools persist mcpToolsEnabled in state', () => {
  const { env, bootstrapFile, cleanup } = makeTempState()
  try {
    const enable = runCli(['memory', 'enable-tools'], env)
    assert.equal(enable.status, 0, enable.stderr)
    assert.match(enable.stdout, /MCP tools enabled/)
    const onState = JSON.parse(readFileSync(bootstrapFile, 'utf8'))
    assert.equal(onState.mcpToolsEnabled, true)

    const disable = runCli(['memory', 'disable-tools'], env)
    assert.equal(disable.status, 0, disable.stderr)
    const offState = JSON.parse(readFileSync(bootstrapFile, 'utf8'))
    assert.equal(offState.mcpToolsEnabled, false)
  } finally {
    cleanup()
  }
})
