#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspace = mkdtempSync(join(tmpdir(), 'babel-o-build-smoke-'))
const configPath = join(workspace, 'config.json')

try {
  writeFileSync(
    configPath,
    JSON.stringify({ defaultModel: 'local/coding-runtime', providers: {} }, null, 2),
    'utf8',
  )
  writeFileSync(join(workspace, 'sample.txt'), 'hello production smoke\n', 'utf8')

  const env = {
    ...process.env,
    BABEL_O_CONFIG_FILE: configPath,
    BABEL_O_MODEL: 'local/coding-runtime',
    BABEL_O_PROVIDER: 'local',
  }

  const checks = [
    ['bbl --help', ['bin/bbl.js', '--help']],
    ['bbl go --check', ['bin/bbl.js', 'go', '--check', '--no-start-nexus', '--url', 'http://127.0.0.1:9']],
    ['bbl run hello', ['bin/bbl.js', 'run', 'hello']],
  ]

  const results = checks.map(([name, args]) => {
    const startedAt = process.hrtime.bigint()
    const result = spawnSync(process.execPath, args, {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    })
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000
    return {
      name,
      exitCode: result.status,
      durationMs: Math.round(durationMs * 100) / 100,
      stderr: result.status === 0 ? undefined : result.stderr,
    }
  })

  console.log(JSON.stringify({
    type: 'production_build_smoke',
    distEntry: 'dist/cli/program.js',
    results,
  }, null, 2))

  if (results.some(result => result.exitCode !== 0)) {
    process.exitCode = 1
  }
} finally {
  rmSync(workspace, { recursive: true, force: true })
}
