#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = resolve(root, 'test', 'quarantine.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const args = new Set(process.argv.slice(2))
const shouldRun = args.has('--run')
const shouldJson = args.has('--json')

const entries = Array.isArray(manifest.entries) ? manifest.entries : []
const runnableEntries = entries.filter(entry => entry.command)

const summary = {
  type: 'test_quarantine',
  mode: shouldRun ? 'run' : 'list',
  manifest: 'test/quarantine.json',
  entryCount: entries.length,
  runnableCount: runnableEntries.length,
  entries: entries.map(entry => ({
    id: entry.id,
    file: entry.file,
    testName: entry.testName,
    tier: entry.tier,
    status: entry.status,
    firstObserved: entry.firstObserved,
    lastObserved: entry.lastObserved,
    likelyCause: entry.likelyCause,
    owner: entry.owner,
    exitCondition: entry.exitCondition,
    command: entry.command,
  })),
  results: [],
}

if (shouldRun) {
  for (const entry of runnableEntries) {
    const startedAt = Date.now()
    const result = spawnSync(entry.command, {
      cwd: root,
      shell: true,
      stdio: shouldJson ? 'pipe' : 'inherit',
      env: {
        ...process.env,
        NODE_ENV: 'test',
      },
      encoding: 'utf8',
    })
    summary.results.push({
      id: entry.id,
      command: entry.command,
      exitCode: result.status,
      signal: result.signal,
      durationMs: Date.now() - startedAt,
      stdoutTail: shouldJson ? tail(result.stdout ?? '') : undefined,
      stderrTail: shouldJson ? tail(result.stderr ?? '') : undefined,
    })
  }
}

if (shouldJson) {
  console.log(JSON.stringify(summary, null, 2))
} else if (!shouldRun) {
  console.log(JSON.stringify(summary, null, 2))
  console.log('\nRun quarantined checks with: npm run test:quarantine -- --run')
}

const failed = summary.results.filter(result => result.exitCode !== 0 || result.signal)
if (failed.length > 0) {
  console.error(`\n${failed.length} quarantined check(s) failed. This command reports quarantine state; default required gates remain separate.`)
}

function tail(text) {
  const lines = String(text).split('\n')
  return lines.slice(Math.max(0, lines.length - 40)).join('\n')
}
