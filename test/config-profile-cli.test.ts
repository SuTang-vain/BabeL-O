import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

/**
 * §5 路径 C 阶段 2: `bbl config profile <sub>` CLI.
 *
 * 端到端跑 `tsx src/cli/program.ts config profile <sub>`, 用临时
 * BABEL_O_CONFIG_FILE 隔离状态;验证 list / use / delete / restore
 * 与持久化行为。
 */

const repoRoot = join(import.meta.dirname, '..')
const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx')
const program = join(repoRoot, 'src', 'cli', 'program.ts')

function makeTempConfig(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'babel-o-config-profile-cli-'))
  const file = join(dir, 'config.json')
  writeFileSync(file, JSON.stringify({}))
  return {
    file,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function runCli(args: string[], env: Record<string, string>) {
  return spawnSync(tsxBin, [program, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 30_000,
  })
}

test('bbl config profile list reports active and tombstones', () => {
  const { file, cleanup } = makeTempConfig()
  try {
    // Seed: work profile + tombstone personal.
    writeFileSync(file, JSON.stringify({
      profiles: { work: { provider: 'local', model: 'local/coding-runtime' } },
      activeProfile: 'work',
      tombstones: { personal: { deletedAt: '2026-06-01T00:00:00Z' } },
      configVersion: 3,
    }))

    const result = runCli(['config', 'profile', 'list'], { BABEL_O_CONFIG_FILE: file })
    assert.equal(result.status, 0, result.stderr)
    const out = result.stdout
    assert.match(out, /active: work/)
    assert.match(out, /version: 3/)
    assert.match(out, /\* work:/)
    assert.match(out, /Tombstones:/)
    assert.match(out, /personal: deletedAt=2026-06-01T00:00:00Z/)
  } finally {
    cleanup()
  }
})

test('bbl config profile use <name> sets active profile and persists', () => {
  const { file, cleanup } = makeTempConfig()
  try {
    writeFileSync(file, JSON.stringify({
      profiles: {
        work: { provider: 'local', model: 'local/coding-runtime' },
        personal: { provider: 'anthropic', model: 'anthropic/claude-test' },
      },
    }))

    const result = runCli(['config', 'profile', 'use', 'personal'], { BABEL_O_CONFIG_FILE: file })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /✓ Active profile set to: personal/)

    const reloaded = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(reloaded.activeProfile, 'personal')
    assert.ok(typeof reloaded.configVersion === 'number')
  } finally {
    cleanup()
  }
})

test('bbl config profile use refuses tombstoned profile with exit 1', () => {
  const { file, cleanup } = makeTempConfig()
  try {
    writeFileSync(file, JSON.stringify({
      profiles: {},
      tombstones: { personal: { deletedAt: '2026-06-01T00:00:00Z' } },
    }))

    const result = runCli(['config', 'profile', 'use', 'personal'], { BABEL_O_CONFIG_FILE: file })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /tombstoned/)
  } finally {
    cleanup()
  }
})

test('bbl config profile delete soft-deletes (moves to tombstones)', () => {
  const { file, cleanup } = makeTempConfig()
  try {
    writeFileSync(file, JSON.stringify({
      profiles: { work: { provider: 'local', model: 'local/coding-runtime' } },
      activeProfile: 'work',
    }))

    const result = runCli(['config', 'profile', 'delete', 'work'], { BABEL_O_CONFIG_FILE: file })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /moved to tombstones/)

    const reloaded = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(reloaded.profiles.work, undefined)
    assert.ok(reloaded.tombstones.work)
    assert.ok(reloaded.tombstones.work.deletedAt.length > 0)
  } finally {
    cleanup()
  }
})

test('bbl config profile restore clears the tombstone (does not recreate profile)', () => {
  const { file, cleanup } = makeTempConfig()
  try {
    writeFileSync(file, JSON.stringify({
      profiles: {},
      tombstones: { work: { deletedAt: '2026-06-01T00:00:00Z' } },
    }))

    const result = runCli(['config', 'profile', 'restore', 'work'], { BABEL_O_CONFIG_FILE: file })
    assert.equal(result.status, 0, result.stderr)

    const reloaded = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(reloaded.tombstones.work, undefined)
    // restore only clears the tombstone, not the profile config itself.
    assert.equal(reloaded.profiles.work, undefined)
  } finally {
    cleanup()
  }
})

test('bbl config profile restore refuses non-tombstoned profile with exit 1', () => {
  const { file, cleanup } = makeTempConfig()
  try {
    writeFileSync(file, JSON.stringify({}))

    const result = runCli(['config', 'profile', 'restore', 'never-existed'], { BABEL_O_CONFIG_FILE: file })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /not tombstoned/)
  } finally {
    cleanup()
  }
})

test('config profile subcommands are visible in `bbl config profile --help`', () => {
  const result = runCli(['config', 'profile', '--help'], { BABEL_O_CONFIG_FILE: '/tmp/irrelevant.json' })
  assert.equal(result.status, 0, result.stderr)
  const out = result.stdout
  for (const sub of ['list', 'use', 'delete', 'restore']) {
    assert.match(out, new RegExp(`\\b${sub}\\b`), `expected config profile --help to mention ${sub}: ${out}`)
  }
})
