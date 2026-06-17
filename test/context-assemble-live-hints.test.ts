// test/context-assemble-live-hints.test.ts
//
// PR-31 unit tests: liveHints section reads behavior-trace.jsonl (doc §4.4 / §7.3).
// Covers:
//   1. empty trace file → "no recent" section
//   2. nexus-source entries within 5min → included
//   3. non-nexus entries (e.g. error, denial) → excluded
//   4. nexus entries older than 5min → excluded
//   5. includeLiveHints=false → no section
//   6. includeLiveHints=true → section present
//   7. duplicate keys de-duped (existing behavior)
//   8. content includes confidence

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildAssemblePreview } from '../src/nexus/contextAssemblePreview.js'
import type { BehaviorTraceEntry } from '../src/runtime/behaviorTrace.js'

const ORIGINAL_ENV: Record<string, string | undefined> = {}

function traceEntry(overrides: Partial<BehaviorTraceEntry> & { timestamp: string; source?: string; trigger?: string }): BehaviorTraceEntry {
  const baseAnomaly = {
    source: overrides.source,
    errorCode: overrides.anomaly?.errorCode,
    errorMessage: overrides.anomaly?.errorMessage ?? 'detail',
  }
  return {
    schemaVersion: '2026-06-16.behavior-trace.v1',
    traceId: `t_${Math.random().toString(36).slice(2, 8)}`,
    sessionId: 's_test',
    cwd: '/tmp',
    trigger: overrides.trigger ?? 'hot-path',
    triggerConfidence: overrides.triggerConfidence ?? 0.9,
    context: { recentEvents: [], toolSequence: [], fileRefStack: [], userIntentGuidance: '', retryCount: 0, timeInSessionMs: 0, tokensSinceLastTrace: 0 },
    anomaly: { ...baseAnomaly, ...(overrides.anomaly ?? {}) },
    timestamp: overrides.timestamp,
  } as BehaviorTraceEntry
}

describe('PR-31 liveHints section from behavior-trace.jsonl', () => {
  let home: string
  let cwd: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'babel-o-pr31-home-'))
    cwd = mkdtempSync(join(home, 'project-'))
    mkdirSync(join(cwd, '.babel-o'), { recursive: true })
    for (const key of ['HOME', 'BABEL_O_TEST_CONFIG_WRITE_GUARD']) {
      ORIGINAL_ENV[key] = process.env[key]
    }
    process.env.HOME = home
    process.env.BABEL_O_TEST_CONFIG_WRITE_GUARD = '1'
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    for (const [key, val] of Object.entries(ORIGINAL_ENV)) {
      if (val === undefined) delete process.env[key]
      else process.env[key] = val
    }
  })

  function seedTrace(entries: BehaviorTraceEntry[]): void {
    writeFileSync(
      join(cwd, '.babel-o', 'behavior-trace.jsonl'),
      entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf8',
    )
  }

  function recentIso(): string {
    return new Date(Date.now() - 30_000).toISOString() // 30s ago
  }

  function oldIso(): string {
    return new Date(Date.now() - 10 * 60_000).toISOString() // 10min ago
  }

  // Test 1: empty trace file
  test('empty trace file → "no recent" section when includeLiveHints', async () => {
    const preview = await buildAssemblePreview({ cwd, scope: 'workspace', maxTokens: 7500, includeLiveHints: true })
    const liveHints = preview.sections.find((s) => s.kind === 'liveHint')
    assert.ok(liveHints)
    assert.ok(liveHints!.content.includes('no recent'))
  })

  // Test 2: nexus entries within 5min included
  test('nexus-source entries within 5min → included', async () => {
    seedTrace([
      traceEntry({ timestamp: recentIso(), source: 'nexus', trigger: 'hot-path', anomaly: { errorMessage: 'cross session pattern' } }),
    ])
    const preview = await buildAssemblePreview({ cwd, scope: 'workspace', maxTokens: 7500, includeLiveHints: true })
    const liveHints = preview.sections.find((s) => s.kind === 'liveHint')!
    assert.ok(liveHints.content.includes('hot-path'))
    assert.ok(liveHints.content.includes('cross session pattern'))
  })

  // Test 3: non-nexus entries excluded
  test('non-nexus entries → excluded', async () => {
    seedTrace([
      traceEntry({ timestamp: recentIso(), source: undefined, trigger: 'error', anomaly: { errorMessage: 'local error' } }),
      traceEntry({ timestamp: recentIso(), source: 'rule', trigger: 'denial', anomaly: { errorMessage: 'rule denial' } }),
    ])
    const preview = await buildAssemblePreview({ cwd, scope: 'workspace', maxTokens: 7500, includeLiveHints: true })
    const liveHints = preview.sections.find((s) => s.kind === 'liveHint')!
    assert.ok(liveHints.content.includes('no recent'), 'no nexus entries → no recent')
    assert.ok(!liveHints.content.includes('local error'))
    assert.ok(!liveHints.content.includes('rule denial'))
  })

  // Test 4: nexus entries older than 5min excluded
  test('nexus entries older than 5min → excluded', async () => {
    seedTrace([
      traceEntry({ timestamp: oldIso(), source: 'nexus', trigger: 'hot-path', anomaly: { errorMessage: 'old pattern' } }),
    ])
    const preview = await buildAssemblePreview({ cwd, scope: 'workspace', maxTokens: 7500, includeLiveHints: true })
    const liveHints = preview.sections.find((s) => s.kind === 'liveHint')!
    assert.ok(liveHints.content.includes('no recent'), 'old nexus entries outside 5min cooldown')
  })

  // Test 5: includeLiveHints=false → no section
  test('includeLiveHints=false → no liveHint section', async () => {
    seedTrace([
      traceEntry({ timestamp: recentIso(), source: 'nexus', trigger: 'hot-path', anomaly: { errorMessage: 'pattern' } }),
    ])
    const preview = await buildAssemblePreview({ cwd, scope: 'workspace', maxTokens: 7500 })
    const liveHints = preview.sections.find((s) => s.kind === 'liveHint')
    assert.equal(liveHints, undefined)
  })

  // Test 6: includeLiveHints=true → section present
  test('includeLiveHints=true → liveHint section present', async () => {
    const preview = await buildAssemblePreview({ cwd, scope: 'workspace', maxTokens: 7500, includeLiveHints: true })
    const liveHints = preview.sections.find((s) => s.kind === 'liveHint')
    assert.ok(liveHints, 'section exists')
    assert.equal(liveHints!.kind, 'liveHint')
  })

  // Test 7: count + confidence included
  test('content includes count and confidence', async () => {
    seedTrace([
      traceEntry({ timestamp: recentIso(), source: 'nexus', trigger: 'hot-path', triggerConfidence: 0.92, anomaly: { errorMessage: 'p1' } }),
      traceEntry({ timestamp: recentIso(), source: 'nexus', trigger: 'tool-storm', triggerConfidence: 0.85, anomaly: { errorMessage: 'p2' } }),
    ])
    const preview = await buildAssemblePreview({ cwd, scope: 'workspace', maxTokens: 7500, includeLiveHints: true })
    const liveHints = preview.sections.find((s) => s.kind === 'liveHint')!
    assert.ok(liveHints.content.includes('(2 within 5min)'))
    assert.ok(liveHints.content.includes('conf=0.92'))
    assert.ok(liveHints.content.includes('conf=0.85'))
  })

  // Test 8: HOME isolation
  test('HOME isolation: HOME behavior-trace.jsonl not read', async () => {
    writeFileSync(join(home, 'behavior-trace.jsonl'), JSON.stringify(
      traceEntry({ timestamp: recentIso(), source: 'nexus', trigger: 'hot-path', anomaly: { errorMessage: 'home_pattern' } })
    ) + '\n', 'utf8')
    const preview = await buildAssemblePreview({ cwd, scope: 'workspace', maxTokens: 7500, includeLiveHints: true })
    const liveHints = preview.sections.find((s) => s.kind === 'liveHint')!
    assert.ok(!liveHints.content.includes('home_pattern'), 'HOME file not read')
  })
})
