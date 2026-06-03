#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const coverageDir = join(tmpdir(), `babel-o-v8-coverage-${Date.now()}-${Math.random()}`)
const outputDir = join(root, 'coverage')
const outputPath = join(outputDir, 'coverage-summary.json')
const testArgs = [
  '--test',
  '--test-concurrency=1',
  'test/adapters.test.ts',
  'test/classifier.test.ts',
  'test/message-normalizer.test.ts',
  'test/provider-recovery.test.ts',
  'test/providers.test.ts',
  'test/runtime.test.ts',
  'test/security.test.ts',
  'test/token-estimator.test.ts',
]

rmSync(coverageDir, { recursive: true, force: true })
mkdirSync(coverageDir, { recursive: true })
mkdirSync(outputDir, { recursive: true })

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', ...testArgs],
  {
    cwd: root,
    env: {
      ...process.env,
      NODE_V8_COVERAGE: coverageDir,
      BABEL_O_CONFIG_FILE: process.env.BABEL_O_CONFIG_FILE ?? join(tmpdir(), 'babel-o-coverage-config.json'),
    },
    stdio: 'inherit',
  },
)

if (result.status !== 0) {
  process.exit(result.status ?? 1)
}

const summary = summarizeCoverage(coverageDir)
writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({
  type: 'coverage_report',
  output: relative(root, outputPath),
  files: summary.fileCount,
  functions: summary.functions,
}, null, 2))

function summarizeCoverage(directory) {
  const byFile = new Map()
  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith('.json')) continue
    const profile = JSON.parse(readFileSync(join(directory, entry), 'utf8'))
    for (const script of profile.result ?? []) {
      if (typeof script.url !== 'string') continue
      if (!script.url.startsWith('file://')) continue
      const filePath = new URL(script.url).pathname
      if (!filePath.startsWith(join(root, 'src'))) continue
      const existing = byFile.get(filePath) ?? { total: 0, covered: 0 }
      for (const fn of script.functions ?? []) {
        existing.total += 1
        if ((fn.ranges ?? []).some(range => range.count > 0)) {
          existing.covered += 1
        }
      }
      byFile.set(filePath, existing)
    }
  }

  let total = 0
  let covered = 0
  const files = [...byFile.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([filePath, counts]) => {
      total += counts.total
      covered += counts.covered
      return {
        file: relative(root, filePath),
        functions: {
          total: counts.total,
          covered: counts.covered,
          percent: percent(counts.covered, counts.total),
        },
      }
    })

  return {
    type: 'coverage_summary',
    schemaVersion: 1,
    fileCount: files.length,
    functions: {
      total,
      covered,
      percent: percent(covered, total),
    },
    files,
  }
}

function percent(covered, total) {
  return total === 0 ? 100 : Math.round((covered / total) * 10_000) / 100
}
