#!/usr/bin/env tsx
/**
 * Trajectory Eval Harness CLI.
 *
 * Source: `docs/nexus/reference/agent-runtime-architecture-maturity-plan.md` §3.2.
 *
 * Runs every fixture under `evals/coding/*.ts`, projects each recorded event
 * stream to an `AgentTrace`, runs the builtin discipline checks, and prints a
 * per-fixture + overall report. Exits non-zero if any fixture's self-validation
 * mismatches (i.e. the check suite misclassified a known-good/bad trajectory).
 *
 * Offline + deterministic: no provider key, no live workspace, no network.
 *
 * Usage:
 *   npm run eval:agent            # human-readable report
 *   npm run eval:agent -- --json  # machine-readable JSON
 */

import { readdirSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runAll, type EvalReport, type FixtureResult } from '../src/eval/trajectoryEval.js'
import type { Fixture } from '../src/eval/fixtureBuilder.js'

const FIXTURES_DIR = resolve(process.cwd(), 'evals', 'coding')

async function loadFixtures(): Promise<Fixture[]> {
  const files = readdirSync(FIXTURES_DIR)
    .filter(f => extname(f) === '.ts' && !f.endsWith('.d.ts'))
    .sort()
  const fixtures: Fixture[] = []
  for (const file of files) {
    const url = pathToFileURL(join(FIXTURES_DIR, file)).href
    const mod = (await import(url)) as { default: Fixture }
    if (!mod.default || typeof mod.default !== 'object' || !mod.default.id) {
      throw new Error(`Fixture ${file} does not export a default defineFixture({ id, ... })`)
    }
    fixtures.push({ ...mod.default, sourcePath: join('evals', 'coding', file) })
  }
  return fixtures
}

function formatResult(r: FixtureResult): string {
  const checks = r.checks
    .map(c => `    ${severityBadge(c.severity)} ${c.key.padEnd(22)} ${c.message}`)
    .join('\n')
  const m = r.metrics
  const cost = `${m.cost.inputTokens} in / ${m.cost.outputTokens} out / ${m.cost.cacheReadTokens} cache`
  const mismatches = r.mismatches.length === 0
    ? ''
    : `\n  mismatches: ${r.mismatches.map(mm => `${mm.key} expected=${mm.expected} actual=${mm.actual}`).join(', ')}`
  return [
    `${verdictBadge(r.verdict)} ${r.fixtureId}  (${r.sourcePath ?? '?'})`,
    `  ${r.description}`,
    `  verdict=${r.verdict} satisfied=${r.satisfied} | tools=${m.toolCount} perms=${m.permissionCount} scopeWarn=${m.scopeWarnings} spans=${m.spanCount} | cost: ${cost}${mismatches}`,
    checks,
  ].join('\n')
}

function severityBadge(s: string): string {
  switch (s) {
    case 'pass': return '✓'
    case 'warn': return '⚠'
    case 'fail': return '✗'
    case 'skip': return '·'
    default: return '?'
  }
}

function verdictBadge(v: string): string {
  return v === 'pass' ? '✓' : '✗'
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const jsonMode = args.includes('--json')

  const fixtures = await loadFixtures()
  if (fixtures.length === 0) {
    console.error('No fixtures found under evals/coding/*.ts')
    process.exitCode = 1
    return
  }
  const report: EvalReport = runAll(fixtures)

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    for (const r of report.results) console.log(formatResult(r))
    console.log('')
    console.log(
      `Eval summary: ${report.passed}/${report.total} fixtures self-validated, ${report.failed} mismatched.`,
    )
    if (report.failed > 0) {
      console.log('  Mismatched fixtures indicate the check suite misclassified a trajectory; fix the check or the fixture.')
    }
  }

  if (report.failed > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error('eval:agent failed:', err)
  process.exitCode = 1
})
