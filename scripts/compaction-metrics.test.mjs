/**
 * Tests for scripts/compaction-metrics.mjs. Run: node --test scripts/compaction-metrics.test.mjs
 * Uses synthetic fixtures in os.tmpdir() (including a real node:sqlite DB) plus
 * a guarded integration pass over the four post-wiring gates in .eval/.
 */
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  REPO_ROOT,
  analyzeGate,
  billedFromTotals,
  cacheReadRatioCumulative,
  cacheReadRatioEvent,
  loadGateCache,
  pairedRatioMedian,
  summarizeArms,
} from './compaction-metrics.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'compaction-metrics-'))
after(() => rmSync(tmp, { recursive: true, force: true }))

// ---------------------------------------------------------------------------
// billed

describe('billedFromTotals', () => {
  test('sums input + output + summaryInput + summaryOutput', () => {
    assert.equal(billedFromTotals({
      inputTokens: 100, outputTokens: 20, summaryInputTokens: 5, summaryOutputTokens: 3,
    }), 128)
  })
  test('missing summary fields count as zero', () => {
    assert.equal(billedFromTotals({ inputTokens: 350075, outputTokens: 15046 }), 365121)
  })
})

// ---------------------------------------------------------------------------
// calls: median vs total are different statistics

describe('summarizeArms calls median vs total', () => {
  const cell = (arm, calls, billed = 1000) => ({
    arm, task: 't', rep: `r${calls}`, valid: true, billed, calls,
    compactions: 0, summary: 0, qualityPassed: 1, qualityTotal: 1,
  })
  test('median and total can move in opposite directions (P1 v3 shape)', () => {
    // Arm X: flat 18s. Arm Y: lower median but one long-tail outlier.
    const cells = [
      cell('X', 18), cell('X', 18), cell('X', 18),
      cell('Y', 17), cell('Y', 17), cell('Y', 60),
    ]
    const arms = Object.fromEntries(summarizeArms(cells).map(a => [a.arm, a]))
    assert.equal(arms.X.callsMedian, 18)
    assert.equal(arms.Y.callsMedian, 17)
    assert.ok(arms.Y.callsMedian < arms.X.callsMedian, 'median: Y < X')
    assert.equal(arms.X.callsTotal, 54)
    assert.equal(arms.Y.callsTotal, 94)
    assert.ok(arms.Y.callsTotal > arms.X.callsTotal, 'total: Y > X (opposite of median)')
  })
  test('invalid cells are excluded from medians/totals but still counted', () => {
    const cells = [
      cell('X', 10, 100),
      { ...cell('X', 999, 999999), valid: false },
    ]
    const [x] = summarizeArms(cells)
    assert.equal(x.validCells, 1)
    assert.equal(x.invalidCells, 1)
    assert.equal(x.callsMedian, 10)
    assert.equal(x.billedMedian, 100)
    // quality is summed over ALL cells (checklist still ran on invalid ones)
    assert.deepEqual(x.qualityAll, { passed: 2, total: 2 })
    assert.deepEqual(x.qualityValid, { passed: 1, total: 1 })
  })
})

// ---------------------------------------------------------------------------
// cacheReadRatio formulas

describe('cacheReadRatioEvent (per-event formula)', () => {
  test('OpenAI/DeepSeek style: input already includes cached tokens (no double count)', () => {
    // input 1000 already contains the 400 cache reads; denominator stays input.
    assert.equal(cacheReadRatioEvent({ inputTokens: 1000, cacheReadInputTokens: 400 }), 0.4)
  })
  test('Anthropic style: input excludes cache reads/creation', () => {
    // denominator = max(100, 800+100) = 900
    const ratio = cacheReadRatioEvent({ inputTokens: 100, cacheReadInputTokens: 800, cacheCreationInputTokens: 100 })
    assert.ok(Math.abs(ratio - 800 / 900) < 1e-12, `expected 800/900, got ${ratio}`)
  })
  test('zero denominator returns null (skipped), zero cache read returns 0', () => {
    assert.equal(cacheReadRatioEvent({ inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }), null)
    assert.equal(cacheReadRatioEvent({ inputTokens: 500, cacheReadInputTokens: 0 }), 0)
  })
})

describe('cacheReadRatioCumulative (run-cumulative Σ/Σ formula)', () => {
  const events = [
    { inputTokens: 1000, cacheReadInputTokens: 400 },                              // 0.4 per-event
    { inputTokens: 100, cacheReadInputTokens: 800, cacheCreationInputTokens: 100 }, // 0.8889 per-event
    { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },       // skipped
  ]
  test('is Σ cacheRead / Σ max(input, cacheRead+creation), NOT mean of per-event ratios', () => {
    const cum = cacheReadRatioCumulative(events)
    assert.equal(cum.cacheReadSum, 1200)
    assert.equal(cum.denominatorSum, 1900)
    assert.equal(cum.events, 2)
    assert.equal(cum.skipped, 1)
    assert.ok(Math.abs(cum.ratio - 1200 / 1900) < 1e-12)
    const meanOfRatios = (0.4 + 800 / 900) / 2
    assert.ok(Math.abs(cum.ratio - meanOfRatios) > 1e-3, 'cumulative must differ from mean of per-event ratios')
  })
  test('empty / all-skipped input yields null ratio', () => {
    assert.equal(cacheReadRatioCumulative([]).ratio, null)
    assert.equal(cacheReadRatioCumulative([{ inputTokens: 0 }]).ratio, null)
  })
})

// ---------------------------------------------------------------------------
// paired per-cell ratio vs ratio of arm medians

describe('pairedRatioMedian', () => {
  test('median of paired per-cell ratios differs from ratio of arm medians', () => {
    const mk = (arm, rep, billed, valid = true) => ({
      arm, task: 't', rep, valid, billed, calls: 1, compactions: 0, summary: 0, qualityPassed: 1, qualityTotal: 1,
    })
    const num = [mk('Y', 'r1', 150), mk('Y', 'r2', 150)] // arm median 150
    const den = [mk('X', 'r1', 100), mk('X', 'r2', 200)] // arm median 150
    const res = pairedRatioMedian(num, den, { label: 'Y/X', num: 'Y', den: 'X' })
    assert.equal(res.label, 'Y/X')
    assert.equal(res.pairs, 2)
    assert.equal(res.armMedianRatio, 1)                    // 150 / 150
    assert.equal(res.ratioMedian, 1.125)                   // median(1.5, 0.75)
    assert.notEqual(res.ratioMedian, res.armMedianRatio)
  })
  test('invalid cells are dropped from pairing', () => {
    const mk = (arm, task, rep, billed, valid = true) => ({
      arm, task, rep, valid, billed, calls: 1, compactions: 0, summary: 0, qualityPassed: 1, qualityTotal: 1,
    })
    const num = [mk('C', 'a', 'r1', 110), mk('C', 'a', 'r2', 999, false)]
    const den = [mk('A', 'a', 'r1', 100), mk('A', 'a', 'r2', 100)]
    const res = pairedRatioMedian(num, den, { num: 'C', den: 'A' })
    assert.equal(res.pairs, 1)
    assert.equal(res.ratioMedian, 1.1)
  })
})

// ---------------------------------------------------------------------------
// fixtures: gate dir on disk (results JSON) + real sqlite DB

function writeResult(dir, { arm, task = 't1', rep, input, output, summaryIn = 0, summaryOut = 0, calls, compactions = 0, failedTurns = 0, q = 1, qt = 1 }) {
  writeFileSync(join(dir, 'results', `${arm}-${task}-${rep}.json`), JSON.stringify({
    arm, taskId: task, rep,
    checklist: { passed: q, total: qt, items: [] },
    totals: {
      providerCalls: calls, inputTokens: input, outputTokens: output,
      summaryInputTokens: summaryIn, summaryOutputTokens: summaryOut,
      wallMs: 1, compactions, blockedTurns: 0, failedTurns,
    },
    turns: [],
  }))
}

function createUsageDb(dbPath, events) {
  const db = new DatabaseSync(dbPath)
  db.exec(`CREATE TABLE events (
    event_key TEXT PRIMARY KEY, session_id TEXT, timestamp TEXT,
    event_type TEXT, event_json TEXT, event_seq INTEGER)`)
  const insert = db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)')
  events.forEach((e, i) => {
    insert.run(`k${i}`, 's1', new Date(0).toISOString(), e.type, JSON.stringify(e.payload), i)
  })
  db.close()
}

describe('analyzeGate on a synthetic gate dir', () => {
  const gate = join(tmp, 'synthgate')
  mkdirSync(join(gate, 'results'), { recursive: true })
  writeResult(gate, { arm: 'X', rep: 'r1', input: 90, output: 10, calls: 5 })                    // billed 100
  writeResult(gate, { arm: 'X', rep: 'r2', input: 250, output: 50, calls: 15, failedTurns: 1 })  // invalid
  writeResult(gate, { arm: 'Y', rep: 'r1', input: 100, output: 50, calls: 7 })                   // billed 150
  writeResult(gate, { arm: 'Y', rep: 'r2', input: 190, output: 10, calls: 9 })                   // billed 200

  test('derives validity from failedTurns when aggregate.json is absent', () => {
    const report = analyzeGate(gate, { pairs: [{ label: 'Y/X', num: 'Y', den: 'X' }] })
    assert.equal(report.validSource, 'derived:failedTurns===0')
    const x = report.arms.find(a => a.arm === 'X')
    assert.equal(x.validCells, 1)
    assert.equal(x.invalidCells, 1)
    assert.equal(x.billedMedian, 100) // the invalid 300-billed cell is excluded
    assert.equal(x.callsTotal, 5)
    const pair = report.pairs[0]
    assert.equal(pair.label, 'Y/X')
    assert.equal(pair.pairs, 1)
    assert.equal(pair.ratioMedian, 1.5)
    assert.equal(report.cache.available, false)
    assert.match(report.cache.reason, /no runs/)
  })
})

describe('loadGateCache with a real node:sqlite DB', () => {
  const gate = join(tmp, 'cachegate')
  const laneDir = join(gate, 'runs', 'Z')
  mkdirSync(laneDir, { recursive: true })
  createUsageDb(join(laneDir, 'db-run1.sqlite'), [
    { type: 'usage', payload: { inputTokens: 1000, outputTokens: 10, cacheReadInputTokens: 400 } },
    { type: 'usage', payload: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 800, cacheCreationInputTokens: 100 } },
    { type: 'usage', payload: { inputTokens: 0, outputTokens: 0 } }, // zero denominator → skipped
    { type: 'user_message', payload: { text: 'not usage, ignored' } },
  ])

  test('per-run cumulative ratio + gate per-event stats from usage events', () => {
    const cache = loadGateCache(gate)
    assert.equal(cache.available, true)
    assert.equal(cache.lanes.length, 1)
    const run = cache.lanes[0].runs[0]
    assert.equal(run.run, 'run1')
    assert.equal(run.usageEvents, 2)
    assert.equal(run.skippedZeroDenominator, 1)
    assert.ok(Math.abs(run.cacheReadRatio - 1200 / 1900) < 1e-12)
    assert.ok(Math.abs(run.perEvent.min - 0.4) < 1e-12)
    assert.ok(Math.abs(run.perEvent.max - 800 / 900) < 1e-12)
    assert.equal(cache.gatePerEvent.n, 2)
  })

  test('graceful degradation when runs/ is missing', () => {
    const missing = loadGateCache(join(tmp, 'does-not-exist'))
    assert.equal(missing.available, false)
  })
})

// ---------------------------------------------------------------------------
// Integration: the four post-wiring gates vs the documented headline numbers

const GATES = ['p1gate3', 'p15gate2', 'p2gate2', 'p3gate2']
  .map(g => join(REPO_ROOT, '.eval', g))
const haveGates = GATES.every(g => existsSync(join(g, 'results')))

describe('integration: real gates match documented numbers', { skip: !haveGates }, () => {
  const reports = Object.fromEntries(GATES.map(g => [g.split('/').pop(), analyzeGate(g)]))
  const armOf = (gate, arm) => reports[gate].arms.find(a => a.arm === arm)
  const pairOf = (gate, label) => reports[gate].pairs.find(p => p.label === label)

  test('P1 gate v3 (p1gate3): medians, C/A, calls median+total, compactions, quality', () => {
    assert.equal(armOf('p1gate3', 'A').billedMedian, 380983.5)
    assert.equal(armOf('p1gate3', 'B').billedMedian, 437224.5)
    assert.equal(armOf('p1gate3', 'C').billedMedian, 382318.5)
    assert.equal(armOf('p1gate3', 'D').billedMedian, 396039.5)
    assert.equal(armOf('p1gate3', 'C').compactions, 26)
    // doc: C/A 1.068 (paired median); ratio of arm medians is 1.0035
    assert.ok(Math.abs(pairOf('p1gate3', 'C/A').ratioMedian - 1.0684) < 5e-4)
    assert.ok(Math.abs(pairOf('p1gate3', 'C/A').armMedianRatio - 1.0035) < 5e-4)
    // doc: calls median C 20 vs A 18 (+11%); total C 304 vs A 333 (−8.7%)
    assert.equal(armOf('p1gate3', 'C').callsMedian, 20)
    assert.equal(armOf('p1gate3', 'A').callsMedian, 18)
    assert.equal(armOf('p1gate3', 'C').callsTotal, 304)
    assert.equal(armOf('p1gate3', 'A').callsTotal, 333)
    for (const arm of ['A', 'B', 'C', 'D']) {
      assert.deepEqual(armOf('p1gate3', arm).qualityAll, { passed: 124, total: 124 })
    }
  })

  test('P1.5 cache A/B (p15gate2): OFF/ON billed median, calls median, compactions, quality', () => {
    assert.equal(armOf('p15gate2', 'OFF').billedMedian, 508636)
    assert.equal(armOf('p15gate2', 'ON').billedMedian, 433093.5)
    assert.equal(armOf('p15gate2', 'OFF').callsMedian, 22)
    assert.equal(armOf('p15gate2', 'ON').callsMedian, 20)
    assert.equal(armOf('p15gate2', 'OFF').compactions, 15)
    assert.equal(armOf('p15gate2', 'ON').compactions, 9)
    assert.deepEqual(armOf('p15gate2', 'OFF').qualityAll, { passed: 51, total: 51 })
    assert.deepEqual(armOf('p15gate2', 'ON').qualityAll, { passed: 51, total: 51 })
    // cache ratios from runs/{OFF,ON}/db-*.sqlite; doc: run-cumulative ≈0.68–0.85
    const cache = reports.p15gate2.cache
    assert.equal(cache.available, true)
    const ratios = cache.lanes.flatMap(l => l.runs.map(r => r.cacheReadRatio))
    assert.equal(ratios.length, 12)
    assert.ok(Math.min(...ratios) >= 0.6 && Math.max(...ratios) <= 0.9,
      `run-cumulative band drifted: ${Math.min(...ratios)}..${Math.max(...ratios)}`)
    assert.equal(cache.gatePerEvent.n, 260)
  })

  test('P2 post-wiring (p2gate2): B/C billed + summary medians, C/B, quality', () => {
    assert.equal(armOf('p2gate2', 'B').billedMedian, 446068.5)
    assert.equal(armOf('p2gate2', 'C').billedMedian, 364095)
    assert.equal(armOf('p2gate2', 'B').summaryMedian, 8433)
    assert.equal(armOf('p2gate2', 'C').summaryMedian, 0)
    assert.ok(Math.abs(pairOf('p2gate2', 'C/B').ratioMedian - 0.9356) < 5e-4)
    assert.deepEqual(armOf('p2gate2', 'B').qualityAll, { passed: 62, total: 62 })
    assert.deepEqual(armOf('p2gate2', 'C').qualityAll, { passed: 62, total: 62 })
    assert.equal(reports.p2gate2.cache.available, false)
  })

  test('P3 post-delivery (p3gate2): R median, cross-gate paired R/B, quality', () => {
    assert.equal(armOf('p3gate2', 'R').billedMedian, 538548.5)
    assert.deepEqual(armOf('p3gate2', 'R').qualityAll, { passed: 34, total: 34 })
    const pair = pairOf('p3gate2', 'R/B')
    assert.equal(pair.crossGate, true)
    assert.equal(pair.denominatorGate, 'p2gate2')
    assert.ok(Math.abs(pair.ratioMedian - 0.9675) < 5e-4)
    // doc: P3 run-cumulative ≈0.77–0.90
    const ratios = reports.p3gate2.cache.lanes.flatMap(l => l.runs.map(r => r.cacheReadRatio))
    assert.equal(ratios.length, 4)
    assert.ok(Math.min(...ratios) >= 0.7 && Math.max(...ratios) <= 0.95,
      `run-cumulative band drifted: ${Math.min(...ratios)}..${Math.max(...ratios)}`)
  })
})
