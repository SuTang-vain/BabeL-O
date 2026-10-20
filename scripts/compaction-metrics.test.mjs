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
  attachFailureClass,
  billedFromTotals,
  cacheReadRatioCumulative,
  cacheReadRatioEvent,
  classifyFailureEvents,
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
// validity strata: protocolValid / taskSuccess / costEligible / failureClass

describe('costEligible strata', () => {
  // mk builds a fully-tagged cell like loadGateCells does.
  const mk = (arm, rep, billed, { valid = true, q = 1, qt = 1 } = {}) => {
    const taskSuccess = qt > 0 && q === qt
    return {
      arm, task: 't', rep, valid, protocolValid: valid, billed, calls: 1,
      compactions: 0, summary: 0, qualityPassed: q, qualityTotal: qt,
      taskSuccess, costEligible: valid && taskSuccess, failureClass: 'none',
    }
  }

  test('failedTurns=0 + full checklist -> eligible', () => {
    const [x] = summarizeArms([mk('X', 'r1', 100)])
    assert.equal(x.protocolValidCells, 1)
    assert.equal(x.taskSuccessCells, 1)
    assert.equal(x.costEligibleCells, 1)
  })

  test('protocolValid=true + checklist NOT full -> not eligible (the 24/45 case)', () => {
    const cells = [mk('X', 'r1', 100, { q: 3, qt: 9 })]
    const [x] = summarizeArms(cells)
    assert.equal(x.validCells, 1)               // legacy median still includes it
    assert.equal(x.billedMedian, 100)
    assert.equal(x.protocolValidCells, 1)
    assert.equal(x.taskSuccessCells, 0)
    assert.equal(x.costEligibleCells, 0)
    assert.equal(x.billedMedianEligible, null)  // no eligible cells at all
  })

  test('protocolValid=false (e.g. final_check) + full checklist -> not eligible', () => {
    const cells = [{ ...mk('X', 'r1', 100), valid: false, protocolValid: false, costEligible: false, failureClass: 'final_check' }]
    const [x] = summarizeArms(cells)
    assert.equal(x.validCells, 0)
    assert.equal(x.taskSuccessCells, 1)         // task succeeded but protocol failed
    assert.equal(x.costEligibleCells, 0)
  })

  test('paired ratio uses ONLY costEligible pairs; legacy count kept alongside', () => {
    // r1: both eligible. r2: num protocolValid but 3/9 (not taskSuccess).
    // r3: den invalid. Legacy pairs: r1+r2. Eligible pairs: r1 only.
    const num = [
      mk('C', 'r1', 110),
      mk('C', 'r2', 999, { q: 3, qt: 9 }),      // protocolValid, not taskSuccess
      mk('C', 'r3', 500),
    ]
    const den = [
      mk('A', 'r1', 100),
      mk('A', 'r2', 100),
      { ...mk('A', 'r3', 100), valid: false, protocolValid: false, costEligible: false },
    ]
    const res = pairedRatioMedian(num, den, { label: 'C/A', num: 'C', den: 'A' })
    assert.equal(res.pairsEligible, 1)
    assert.equal(res.ratioMedianEligible, 1.1)  // canonical: only the r1 eligible pair
    assert.equal(res.pairsProtocolValidLegacy, 2)
    assert.equal(res.ratioMedianLegacy, (1.1 + 9.99) / 2)
    assert.equal(res.ratioMedian, res.ratioMedianEligible) // canonical alias
    assert.equal(res.canonical, 'eligible')
  })
})

describe('classifyFailureEvents (synthetic messages)', () => {
  test('context_blocking patterns', () => {
    assert.equal(classifyFailureEvents(['Context estimate 43447/100000 tokens exceeds the blocking limit (99000)']).failureClass, 'context_blocking')
    assert.equal(classifyFailureEvents(['provider error: CONTEXT_LIMIT_EXCEEDED']).failureClass, 'context_blocking')
  })
  test('final_check patterns', () => {
    assert.equal(classifyFailureEvents(['final_check: write/execute tool calls (Edit) attempted during finalization window.']).failureClass, 'final_check')
  })
  test('other + precedence (context_blocking wins over final_check and other)', () => {
    assert.equal(classifyFailureEvents(['fetch failed']).failureClass, 'other')
    const mixed = classifyFailureEvents(['fetch failed', 'final_check: …', 'CONTEXT_LIMIT_EXCEEDED'])
    assert.equal(mixed.failureClass, 'context_blocking')
    assert.deepEqual(mixed.failureClasses, ['context_blocking', 'final_check', 'other'])
  })
  test('no messages -> none', () => {
    assert.deepEqual(classifyFailureEvents([]), { failureClass: 'none', failureClasses: [] })
  })
})

describe('attachFailureClass with a real node:sqlite DB', () => {
  const gate = join(tmp, 'failgate')
  const laneDir = join(gate, 'runs', 'X')
  mkdirSync(laneDir, { recursive: true })
  createUsageDb(join(laneDir, 'db-t1-r1.sqlite'), [
    { type: 'error', payload: { message: 'final_check: write/execute tool calls (Edit) attempted during finalization window. Routing to the permission flow.' } },
    { type: 'usage', payload: { inputTokens: 10 } },
  ])
  createUsageDb(join(laneDir, 'db-t1-r2.sqlite'), [
    { type: 'error', payload: { message: 'Context estimate 99999/100000 tokens exceeds the blocking limit (99000).' } },
  ])

  test('classifies final_check and context_blocking from sqlite error events', () => {
    const c1 = attachFailureClass(gate, { arm: 'X', task: 't1', rep: 'r1', failedTurns: 1, blockedTurns: 0 })
    assert.equal(c1.failureClass, 'final_check')
    const c2 = attachFailureClass(gate, { arm: 'X', task: 't1', rep: 'r2', failedTurns: 1, blockedTurns: 1 })
    assert.equal(c2.failureClass, 'context_blocking')
  })
  test('missing DB -> unknown (failed) / none (clean)', () => {
    assert.equal(attachFailureClass(gate, { arm: 'X', task: 't1', rep: 'rX', failedTurns: 2, blockedTurns: 0 }).failureClass, 'unknown')
    assert.equal(attachFailureClass(gate, { arm: 'X', task: 't1', rep: 'rX', failedTurns: 0, blockedTurns: 0 }).failureClass, 'none')
  })
})

// ---------------------------------------------------------------------------
// paired per-cell ratio vs ratio of arm medians

describe('pairedRatioMedian', () => {
  const mkp = (arm, rep, billed, extra = {}) => ({
    arm, task: 't', rep, valid: true, protocolValid: true, billed, calls: 1,
    compactions: 0, summary: 0, qualityPassed: 1, qualityTotal: 1,
    taskSuccess: true, costEligible: true, failureClass: 'none', ...extra,
  })
  test('median of paired per-cell ratios differs from ratio of arm medians', () => {
    const num = [mkp('Y', 'r1', 150), mkp('Y', 'r2', 150)] // arm median 150
    const den = [mkp('X', 'r1', 100), mkp('X', 'r2', 200)] // arm median 150
    const res = pairedRatioMedian(num, den, { label: 'Y/X', num: 'Y', den: 'X' })
    assert.equal(res.label, 'Y/X')
    assert.equal(res.pairs, 2)
    assert.equal(res.pairsEligible, 2)
    assert.equal(res.armMedianRatio, 1)                    // 150 / 150
    assert.equal(res.ratioMedian, 1.125)                   // median(1.5, 0.75)
    assert.notEqual(res.ratioMedian, res.armMedianRatio)
  })
  test('ineligible cells are dropped from canonical pairing but kept in legacy', () => {
    const num = [mkp('C', 'r1', 110), mkp('C', 'r2', 999, { qualityPassed: 3, qualityTotal: 9, taskSuccess: false, costEligible: false })]
    const den = [mkp('A', 'r1', 100), mkp('A', 'r2', 100)]
    const res = pairedRatioMedian(num, den, { num: 'C', den: 'A' })
    assert.equal(res.pairs, 1)
    assert.equal(res.ratioMedian, 1.1)
    assert.equal(res.pairsProtocolValidLegacy, 2)
    assert.equal(res.ratioMedianLegacy, (1.1 + 9.99) / 2)
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
    // All P1/P2/P3 cells are taskSuccess, so eligible == legacy: the
    // historical paired numbers must be reproduced byte-identically.
    for (const [gate, label] of [['p1gate3', 'C/A'], ['p2gate2', 'C/B'], ['p3gate2', 'R/B']]) {
      const p = pairOf(gate, label)
      assert.equal(p.pairsEligible, p.pairsProtocolValidLegacy, `${gate} ${label}: eligible must equal legacy`)
      assert.equal(p.ratioMedianEligible, p.ratioMedianLegacy)
    }
  })
})

// ---------------------------------------------------------------------------
// Integration: E/Kimi rounds — strict (costEligible) pairs drop vs legacy

const E_GATES = ['next-e-90k', 'next-e-95k', 'next-e-100k', 'kimi-e-95k']
  .map(g => join(REPO_ROOT, '.eval', g))
const haveEGates = E_GATES.every(g => existsSync(join(g, 'results')))

describe('integration: E/Kimi strict pairing drops vs legacy', { skip: !haveEGates }, () => {
  const pairs = { pairs: [{ label: 'CACHE/STOCK', num: 'CACHE', den: 'STOCK' }, { label: 'SFAITH/STOCK', num: 'SFAITH', den: 'STOCK' }] }
  const reports = Object.fromEntries(E_GATES.map(g => [g.split('/').pop(), analyzeGate(g, pairs)]))
  const pairOf = (gate, label) => reports[gate].pairs.find(p => p.label === label)
  const armOf = (gate, arm) => reports[gate].arms.find(a => a.arm === arm)

  test('E rounds: all protocolValid cells are also taskSuccess (strict == legacy)', () => {
    for (const gate of ['next-e-90k', 'next-e-95k', 'next-e-100k']) {
      for (const label of ['CACHE/STOCK', 'SFAITH/STOCK']) {
        const p = pairOf(gate, label)
        assert.equal(p.pairsEligible, p.pairsProtocolValidLegacy, `${gate} ${label}: strict must equal legacy here`)
      }
    }
    // Documented strict pair counts (verified against raw): 90k 0 pairs; 95k 1+1; 100k 1+1.
    assert.equal(pairOf('next-e-90k', 'CACHE/STOCK').pairsEligible, 0)
    assert.equal(pairOf('next-e-95k', 'CACHE/STOCK').pairsEligible, 1)
    assert.equal(pairOf('next-e-95k', 'SFAITH/STOCK').pairsEligible, 1)
    assert.equal(pairOf('next-e-100k', 'CACHE/STOCK').pairsEligible, 1)
    assert.equal(pairOf('next-e-100k', 'SFAITH/STOCK').pairsEligible, 1)
  })

  test('kimi round: strict pairs DROP from legacy 5 to eligible subset', () => {
    const cs = pairOf('kimi-e-95k', 'CACHE/STOCK')
    const ss = pairOf('kimi-e-95k', 'SFAITH/STOCK')
    assert.equal(cs.pairsProtocolValidLegacy, 5)
    assert.equal(ss.pairsProtocolValidLegacy, 5)
    // CACHE only r4 is taskSuccess; STOCK r1/r2/r4/r5 are.
    assert.equal(cs.pairsEligible, 1)
    assert.ok(Math.abs(cs.ratioMedianEligible - 0.7662) < 5e-4)
    // SFAITH r1/r2/r4 taskSuccess; strict median over 3 pairs.
    assert.equal(ss.pairsEligible, 3)
    assert.ok(Math.abs(ss.ratioMedianEligible - 1.3396) < 5e-4)
    // quality non-comparability is visible in the arm strata.
    assert.equal(armOf('kimi-e-95k', 'CACHE').taskSuccessCells, 1)
    assert.equal(armOf('kimi-e-95k', 'STOCK').taskSuccessCells, 4)
    assert.equal(armOf('kimi-e-95k', 'SFAITH').taskSuccessCells, 3)
  })
})
