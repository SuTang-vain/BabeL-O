import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const repoRoot = join(import.meta.dirname, '..')
const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx')
const program = join(repoRoot, 'src', 'cli', 'program.ts')

function makeTempState(): { env: NodeJS.ProcessEnv; bootstrapFile: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'babel-o-doctor-'))
  const bootstrapFile = join(dir, 'everos-bootstrap.json')
  const configFile = join(dir, 'config.json')
  writeFileSync(configFile, JSON.stringify({}))
  return {
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

test('bbl doctor prints the memory section with a fix hint when unconfigured', () => {
  const { env, cleanup } = makeTempState()
  try {
    const result = runCli(['doctor', '--memory-only'], env)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Memory/)
    assert.match(result.stdout, /not_configured/)
    assert.match(result.stdout, /bbl memory setup/)
  } finally {
    cleanup()
  }
})

test('bbl doctor surfaces a failed bootstrap with errorCode and a fix line', () => {
  const { env, bootstrapFile, cleanup } = makeTempState()
  try {
    writeFileSync(bootstrapFile, JSON.stringify({
      version: 2,
      optedIn: true,
      buildStatus: 'failed',
      errorCode: 'EVEROS_BOOTSTRAP_UV_MISSING',
      errorMessage: 'uv missing',
    }), 'utf8')
    const result = runCli(['doctor', '--memory-only'], env)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Memory/)
    assert.match(result.stdout, /failed/)
    assert.match(result.stdout, /EVEROS_BOOTSTRAP_UV_MISSING/)
    assert.match(result.stdout, /Install uv/)
  } finally {
    cleanup()
  }
})

test('bbl doctor without --memory-only prints a header and the memory section', () => {
  const { env, cleanup } = makeTempState()
  try {
    const result = runCli(['doctor'], env)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /bbl doctor/)
    assert.match(result.stdout, /Memory/)
  } finally {
    cleanup()
  }
})

test('bbl memory doctor is an alias for `bbl doctor --memory-only`', () => {
  const { env, bootstrapFile, cleanup } = makeTempState()
  try {
    writeFileSync(bootstrapFile, JSON.stringify({
      version: 2,
      buildStatus: 'ready',
      managedCommand: '/x/everos',
      dataDir: '/x/data',
    }), 'utf8')
    const result = runCli(['memory', 'doctor'], env)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Memory/)
    assert.match(result.stdout, /ready/)
    assert.match(result.stdout, /\/x\/everos/)
    assert.doesNotMatch(result.stdout, /bbl doctor/)
  } finally {
    cleanup()
  }
})

test('bbl doctor never writes to the bootstrap state (read-only)', () => {
  const { env, bootstrapFile, cleanup } = makeTempState()
  try {
    assert.equal(existsSync(bootstrapFile), false)
    runCli(['doctor', '--memory-only'], env)
    assert.equal(existsSync(bootstrapFile), false)
  } finally {
    cleanup()
  }
})
