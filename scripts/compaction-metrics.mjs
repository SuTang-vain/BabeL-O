#!/usr/bin/env node
/**
 * compaction-metrics.mjs — canonical metrics reporter for the compaction gates.
 *
 * Metric definitions (docs/nexus/reference/compaction-p0-p3-final-recommendation-20261017.md
 * and compaction-cache-mock-20261017.md, "Metric definitions"):
 *
 *   billed   = input + output + summaryInput + summaryOutput tokens (per cell).
 *   calls    = provider calls. The per-cell MEDIAN and the TOTAL are different
 *              statistics and can move in opposite directions; both are reported.
 *   X/Y      = median of paired per-cell billed ratios (cells matched on
 *              taskId+rep). The ratio of arm medians is a different statistic
 *              and is printed alongside for contrast.
 *   cacheReadRatio(event) = cacheRead / max(input, cacheRead + cacheCreation).
 *              OpenAI/DeepSeek prompt_tokens already include cached tokens, so
 *              the denominator is `input`; Anthropic input_tokens excludes cache,
 *              so the denominator becomes cacheRead+cacheCreation. Run-cumulative
 *              uses the sum form: Σ cacheRead / Σ max(input, cacheRead+cacheCreation).
 *   valid    = aggregate.json `valid` flag when present, else derived from raw
 *              results as `totals.failedTurns === 0` (reproduces the p1gate2
 *              aggregate flags on all 96 cells). Medians, totals and paired
 *              ratios are computed over valid cells; quality is summed over all
 *              cells (the checklist still ran on invalid cells).
 *
 * Usage:
 *   node scripts/compaction-metrics.mjs [--format md|json|both]
 *                                       [--pair LABEL=NUM/DEN[@DEN_GATE]]...
 *                                       [gateDir ...]
 * Defaults to the four post-wiring gates: .eval/p1gate3, .eval/p15gate2,
 * .eval/p2gate2, .eval/p3gate2. Read-only; no npm dependencies; Node >= 22.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

export const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')

export const DEFAULT_GATES = ['.eval/p1gate3', '.eval/p15gate2', '.eval/p2gate2', '.eval/p3gate2']

/** Built-in paired-ratio specs, keyed by gate directory basename. */
export const DEFAULT_PAIRS = {
  p1gate3: [{ label: 'C/A', num: 'C', den: 'A' }],
  p15gate2: [{ label: 'ON/OFF', num: 'ON', den: 'OFF' }],
  p2gate2: [{ label: 'C/B', num: 'C', den: 'B' }],
  // P3 has no in-gate control arm: the R cells pair against the P2 post-wiring
  // B arm by taskId+rep (same p2b task set), so the denominator is cross-gate.
  p3gate2: [{ label: 'R/B', num: 'R', den: 'B', denGate: 'p2gate2' }],
}

// ---------------------------------------------------------------------------
// Pure metric primitives (exported for tests)

/** billed = input + output + summaryInput + summaryOutput. */
export function billedFromTotals(totals) {
  return (totals?.inputTokens ?? 0)
    + (totals?.outputTokens ?? 0)
    + (totals?.summaryInputTokens ?? 0)
    + (totals?.summaryOutputTokens ?? 0)
}

export function median(values) {
  const v = values.filter(Number.isFinite).slice().sort((a, b) => a - b)
  if (v.length === 0) return null
  const mid = v.length >> 1
  return v.length % 2 === 1 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

export function mean(values) {
  const v = values.filter(Number.isFinite)
  return v.length === 0 ? null : v.reduce((a, b) => a + b, 0) / v.length
}

/**
 * Per-arm summary. `cells` items: { arm, task, rep, valid, billed, calls,
 * compactions, summary, qualityPassed, qualityTotal }. Medians and totals are
 * valid-only; quality is additionally summed over all cells.
 */
export function summarizeArms(cells) {
  const byArm = new Map()
  for (const cell of cells) {
    if (!byArm.has(cell.arm)) byArm.set(cell.arm, [])
    byArm.get(cell.arm).push(cell)
  }
  const arms = []
  for (const [arm, rows] of [...byArm.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const valid = rows.filter(r => r.valid)
    arms.push({
      arm,
      cells: rows.length,
      validCells: valid.length,
      invalidCells: rows.length - valid.length,
      billedMedian: median(valid.map(r => r.billed)),
      billedTotal: valid.reduce((a, r) => a + r.billed, 0),
      callsMedian: median(valid.map(r => r.calls)),
      callsTotal: valid.reduce((a, r) => a + r.calls, 0),
      compactions: valid.reduce((a, r) => a + r.compactions, 0),
      summaryMedian: median(valid.map(r => r.summary)),
      qualityAll: {
        passed: rows.reduce((a, r) => a + r.qualityPassed, 0),
        total: rows.reduce((a, r) => a + r.qualityTotal, 0),
      },
      qualityValid: {
        passed: valid.reduce((a, r) => a + r.qualityPassed, 0),
        total: valid.reduce((a, r) => a + r.qualityTotal, 0),
      },
    })
  }
  return arms
}

/**
 * Median of paired per-cell billed ratios, cells matched on (task, rep).
 * Explicitly distinct from the ratio of arm-level billed medians.
 */
export function pairedRatioMedian(numCells, denCells, { label, num, den } = {}) {
  const denIndex = new Map()
  for (const c of denCells.filter(c => c.valid)) denIndex.set(`${c.task}${c.rep}`, c)
  const pairs = []
  for (const c of numCells.filter(c => c.valid)) {
    const d = denIndex.get(`${c.task}${c.rep}`)
    if (d && d.billed > 0) {
      pairs.push({ task: c.task, rep: c.rep, numBilled: c.billed, denBilled: d.billed, ratio: c.billed / d.billed })
    }
  }
  const numMedian = median(numCells.filter(c => c.valid).map(c => c.billed))
  const denMedian = median(denCells.filter(c => c.valid).map(c => c.billed))
  return {
    label: label ?? `${num}/${den}`,
    numArm: num,
    denArm: den,
    pairs: pairs.length,
    ratioMedian: median(pairs.map(p => p.ratio)),
    ratioMean: mean(pairs.map(p => p.ratio)),
    armMedianRatio: numMedian !== null && denMedian ? numMedian / denMedian : null,
    statistic: 'median of paired per-cell billed ratios (not the ratio of arm medians)',
    cells: pairs,
  }
}

/**
 * cacheReadRatio(event) = cacheRead / max(input, cacheRead + cacheCreation).
 * OpenAI/DeepSeek input already includes cached tokens (denominator = input);
 * Anthropic input excludes them (denominator = cacheRead + cacheCreation).
 * Returns null when the denominator is zero (nothing was read or written).
 */
export function cacheReadRatioEvent(event) {
  const input = event?.inputTokens ?? 0
  const cacheRead = event?.cacheReadInputTokens ?? 0
  const cacheCreation = event?.cacheCreationInputTokens ?? 0
  const denominator = Math.max(input, cacheRead + cacheCreation)
  if (denominator <= 0) return null
  return cacheRead / denominator
}

/** Run-cumulative form: Σ cacheRead / Σ max(input, cacheRead+cacheCreation). */
export function cacheReadRatioCumulative(events) {
  let cacheReadSum = 0
  let denominatorSum = 0
  let counted = 0
  let skipped = 0
  for (const event of events) {
    const input = event?.inputTokens ?? 0
    const cacheRead = event?.cacheReadInputTokens ?? 0
    const cacheCreation = event?.cacheCreationInputTokens ?? 0
    const denominator = Math.max(input, cacheRead + cacheCreation)
    if (denominator <= 0) {
      skipped += 1
      continue
    }
    cacheReadSum += cacheRead
    denominatorSum += denominator
    counted += 1
  }
  return {
    ratio: denominatorSum > 0 ? cacheReadSum / denominatorSum : null,
    cacheReadSum,
    denominatorSum,
    events: counted,
    skipped,
  }
}

export function perEventStats(ratios) {
  const v = ratios.filter(Number.isFinite)
  if (v.length === 0) return { n: 0, min: null, median: null, max: null }
  return { n: v.length, min: Math.min(...v), median: median(v), max: Math.max(...v) }
}

// ---------------------------------------------------------------------------
// Loading: results/*.json (+ aggregate.json validity), runs/&#42;/db-*.sqlite

/** Read one gate's result cells. Read-only. */
export function loadGateCells(gateDir) {
  const resultsDir = join(gateDir, 'results')
  const cells = []
  const problems = []
  if (!existsSync(resultsDir)) return { cells, problems: [`no results/ directory in ${gateDir}`], validSource: 'none' }
  for (const file of readdirSync(resultsDir).filter(f => f.endsWith('.json')).sort()) {
    let d
    try {
      d = JSON.parse(readFileSync(join(resultsDir, file), 'utf8'))
    } catch (error) {
      problems.push(`unparseable ${file}: ${error.message}`)
      continue
    }
    const t = d.totals ?? {}
    cells.push({
      file,
      arm: d.arm,
      task: d.taskId,
      rep: d.rep,
      failedTurns: t.failedTurns ?? 0,
      blockedTurns: t.blockedTurns ?? 0,
      billed: billedFromTotals(t),
      calls: t.providerCalls ?? 0,
      compactions: t.compactions ?? 0,
      summary: (t.summaryInputTokens ?? 0) + (t.summaryOutputTokens ?? 0),
      qualityPassed: d.checklist?.passed ?? 0,
      qualityTotal: d.checklist?.total ?? 0,
    })
  }

  // Validity: prefer the gate's aggregate.json flag; otherwise derive it as
  // failedTurns === 0 (verified to reproduce p1gate2's flags on all 96 cells).
  const aggregatePath = join(gateDir, 'aggregate.json')
  let validSource = 'derived:failedTurns===0'
  const disagreements = []
  if (existsSync(aggregatePath)) {
    try {
      const agg = JSON.parse(readFileSync(aggregatePath, 'utf8'))
      const aggCells = Array.isArray(agg) ? agg : agg.cells
      if (Array.isArray(aggCells) && aggCells.some(c => 'valid' in c)) {
        const flag = new Map(aggCells.map(c => [`${c.arm}${c.task}${c.rep}`, Boolean(c.valid)]))
        validSource = 'aggregate.json'
        for (const cell of cells) {
          const key = `${cell.arm}${cell.task}${cell.rep}`
          const derived = cell.failedTurns === 0
          if (flag.has(key)) {
            cell.valid = flag.get(key)
            if (cell.valid !== derived) disagreements.push({ cell: key, aggregate: cell.valid, derived })
          } else {
            cell.valid = derived
          }
        }
      }
    } catch (error) {
      problems.push(`unparseable aggregate.json: ${error.message}`)
    }
  }
  if (validSource !== 'aggregate.json') {
    for (const cell of cells) cell.valid = cell.failedTurns === 0
  }
  return { cells, problems, validSource, validDisagreements: disagreements }
}

function readUsageEvents(dbPath) {
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch (error) {
    return { error: `open failed: ${error.message}` }
  }
  try {
    const hasEvents = db.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='events'",
    ).get().n
    if (!hasEvents) return { error: 'no events table' }
    const rows = db.prepare("SELECT event_json FROM events WHERE event_type = 'usage'").all()
    const events = []
    let unparseable = 0
    for (const row of rows) {
      try {
        const text = typeof row.event_json === 'string' ? row.event_json : Buffer.from(row.event_json).toString('utf8')
        const e = JSON.parse(text)
        events.push({
          inputTokens: e.inputTokens ?? 0,
          outputTokens: e.outputTokens ?? 0,
          cacheReadInputTokens: e.cacheReadInputTokens ?? 0,
          cacheCreationInputTokens: e.cacheCreationInputTokens ?? 0,
        })
      } catch {
        unparseable += 1
      }
    }
    return { events, unparseable }
  } finally {
    db.close()
  }
}

/**
 * Scan runs/<lane>/db-*.sqlite (lane usually matches the arm name) and compute
 * per-run cumulative cacheReadRatio plus gate-wide per-event min/median/max.
 * Degrades gracefully to { available: false } when no DBs exist.
 */
export function loadGateCache(gateDir) {
  const runsDir = join(gateDir, 'runs')
  if (!existsSync(runsDir)) return { available: false, reason: 'no runs/ directory' }
  const lanes = []
  const allRatios = []
  for (const entry of readdirSync(runsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    const laneDir = join(runsDir, entry.name)
    const dbFiles = readdirSync(laneDir).filter(f => /^db-.*\.sqlite$/.test(f)).sort()
    if (dbFiles.length === 0) continue
    const runs = []
    for (const dbFile of dbFiles) {
      const dbPath = join(laneDir, dbFile)
      const { events, unparseable, error } = readUsageEvents(dbPath)
      if (error) {
        runs.push({ run: dbFile.replace(/^db-|\.sqlite$/g, ''), db: dbPath, error })
        continue
      }
      const cumulative = cacheReadRatioCumulative(events)
      const ratios = events.map(cacheReadRatioEvent).filter(r => r !== null)
      allRatios.push(...ratios)
      runs.push({
        run: dbFile.replace(/^db-|\.sqlite$/g, ''),
        usageEvents: cumulative.events,
        skippedZeroDenominator: cumulative.skipped,
        ...(unparseable ? { unparseable } : {}),
        cacheReadRatio: cumulative.ratio,
        perEvent: perEventStats(ratios),
      })
    }
    lanes.push({ lane: entry.name, runs })
  }
  if (lanes.length === 0) return { available: false, reason: 'no runs/*/db-*.sqlite found' }
  return {
    available: true,
    formula: 'cacheReadRatio = cacheRead / max(input, cacheRead+cacheCreation); run-cumulative uses Σ/Σ',
    lanes,
    gatePerEvent: perEventStats(allRatios),
  }
}

// Note: per-event pooling is gate-wide only (one formula, one pool); lanes
// carry per-run cumulative ratios plus per-run per-event stats.

// ---------------------------------------------------------------------------
// Gate analysis + rendering

export function analyzeGate(gateDir, { pairs } = {}) {
  const { cells, problems, validSource, validDisagreements } = loadGateCells(gateDir)
  const pairSpecs = pairs ?? DEFAULT_PAIRS[basename(gateDir)] ?? []
  const pairResults = []
  for (const spec of pairSpecs) {
    const denGateDir = spec.denGate ? resolve(gateDir, '..', spec.denGate) : null
    const denCells = denGateDir ? loadGateCells(denGateDir).cells : cells
    const numCells = cells.filter(c => c.arm === spec.num)
    const denPool = denCells.filter(c => c.arm === spec.den)
    pairResults.push({
      ...pairedRatioMedian(numCells, denPool, spec),
      ...(denGateDir ? { denominatorGate: basename(denGateDir), crossGate: true } : {}),
    })
  }
  return {
    gate: basename(gateDir),
    path: gateDir,
    cells: cells.length,
    validSource,
    ...(validDisagreements?.length ? { validDisagreements } : {}),
    problems,
    arms: summarizeArms(cells),
    pairs: pairResults,
    cache: loadGateCache(gateDir),
  }
}

const fmtInt = n => (n === null || n === undefined ? '—' : Math.round(n).toLocaleString('en-US'))
const fmtMed = n => (n === null || n === undefined ? '—' : Number.isInteger(n) ? fmtInt(n) : n.toLocaleString('en-US'))
const fmtRatio = n => (n === null || n === undefined ? '—' : n.toFixed(4))

export function renderMarkdown(reports) {
  const out = []
  out.push('# Compaction gate metrics')
  out.push('')
  out.push('Source: `node scripts/compaction-metrics.mjs`. Definitions:')
  out.push('`docs/nexus/reference/compaction-p0-p3-final-recommendation-20261017.md` → Metric definitions.')
  for (const report of reports) {
    out.push('')
    out.push(`## ${report.path}`)
    if (report.problems.length) out.push(`> problems: ${report.problems.join('; ')}`)
    out.push('')
    out.push('| arm | n (valid/total) | billed median | calls median | calls total | compactions | summary median | quality (all cells) |')
    out.push('|---|---:|---:|---:|---:|---:|---:|---|')
    for (const a of report.arms) {
      out.push(`| ${a.arm} | ${a.validCells}/${a.cells} | ${fmtMed(a.billedMedian)} | ${fmtMed(a.callsMedian)} | ${fmtInt(a.callsTotal)} | ${a.compactions} | ${fmtMed(a.summaryMedian)} | ${a.qualityAll.passed}/${a.qualityAll.total} |`)
    }
    out.push('')
    out.push(`calls median and calls total are different statistics and can move in opposite directions; quality is summed over all cells, medians/totals are valid-only (validity: ${report.validSource}).`)
    if (report.pairs.length) {
      out.push('')
      out.push('Paired billed ratios (median of per-cell ratios, cells matched on task+rep — **not** the ratio of arm medians):')
      for (const p of report.pairs) {
        const cross = p.crossGate ? ` (denominator arm ${p.denArm} from ${p.denominatorGate})` : ''
        out.push(`- **${p.label} = ${fmtRatio(p.ratioMedian)}** over ${p.pairs} pairs${cross}; ratio of arm medians = ${fmtRatio(p.armMedianRatio)}, mean paired ratio = ${fmtRatio(p.ratioMean)}`)
      }
    }
    out.push('')
    if (report.cache.available) {
      out.push(`cacheReadRatio (event: cacheRead / max(input, cacheRead+creation); run-cumulative: Σ/Σ):`)
      for (const lane of report.cache.lanes) {
        for (const run of lane.runs) {
          if (run.error) {
            out.push(`- ${lane.lane}/${run.run}: unavailable (${run.error})`)
          } else {
            out.push(`- ${lane.lane}/${run.run}: run-cumulative **${fmtRatio(run.cacheReadRatio)}** (${run.usageEvents} usage events, per-event median ${fmtRatio(run.perEvent.median)})`)
          }
        }
      }
      const g = report.cache.gatePerEvent
      out.push(`- gate-wide per-event: n=${g.n}, min ${fmtRatio(g.min)}, median ${fmtRatio(g.median)}, max ${fmtRatio(g.max)}`)
    } else {
      out.push(`cacheReadRatio: unavailable — ${report.cache.reason}`)
    }
  }
  out.push('')
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// CLI

function parseArgs(argv) {
  const opts = { format: 'md', pairs: undefined, gates: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--format') {
      opts.format = argv[++i]
    } else if (arg.startsWith('--format=')) {
      opts.format = arg.slice('--format='.length)
    } else if (arg === '--pair') {
      opts.pairs = [...(opts.pairs ?? []), parsePair(argv[++i])]
    } else if (arg.startsWith('--pair=')) {
      opts.pairs = [...(opts.pairs ?? []), parsePair(arg.slice('--pair='.length))]
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true
    } else {
      opts.gates.push(arg)
    }
  }
  return opts
}

function parsePair(spec) {
  const m = spec.match(/^([^=]+)=([^/]+)\/([^@]+)(?:@(.+))?$/)
  if (m) return { label: m[1], num: m[2], den: m[3], ...(m[4] ? { denGate: m[4] } : {}) }
  // Shorthand: NUM/DEN[@DEN_GATE] with the label defaulting to "NUM/DEN".
  const s = spec.match(/^([^/=]+)\/([^@=]+)(?:@(.+))?$/)
  if (s) return { label: `${s[1]}/${s[2]}`, num: s[1], den: s[2], ...(s[3] ? { denGate: s[3] } : {}) }
  throw new Error(`invalid --pair spec: ${spec} (expected LABEL=NUM/DEN[@DEN_GATE] or NUM/DEN[@DEN_GATE])`)
}

const USAGE = `Usage: node scripts/compaction-metrics.mjs [--format md|json|both]
              [--pair LABEL=NUM/DEN[@DEN_GATE]]... [gateDir ...]
--pair accepts LABEL=NUM/DEN[@DEN_GATE] or the shorthand NUM/DEN[@DEN_GATE].
Defaults: the four post-wiring gates (${DEFAULT_GATES.join(', ')}).
Read-only; requires Node >= 22 (node:sqlite for runs/*/db-*.sqlite cache ratios).`

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv)
  if (opts.help) {
    console.log(USAGE)
    return 0
  }
  if (!['md', 'json', 'both'].includes(opts.format)) {
    console.error(`unknown --format: ${opts.format}`)
    console.error(USAGE)
    return 2
  }
  const gates = (opts.gates.length ? opts.gates : DEFAULT_GATES.map(g => resolve(REPO_ROOT, g)))
    .map(g => resolve(g))
  const reports = []
  for (const gateDir of gates) {
    if (!existsSync(gateDir)) {
      reports.push({ gate: basename(gateDir), path: gateDir, cells: 0, problems: ['gate directory missing'], arms: [], pairs: [], cache: { available: false, reason: 'gate directory missing' } })
      continue
    }
    reports.push(analyzeGate(gateDir, { pairs: opts.pairs }))
  }
  if (opts.format === 'json' || opts.format === 'both') {
    console.log(JSON.stringify({ generatedBy: 'scripts/compaction-metrics.mjs', reports }, null, 2))
  }
  if (opts.format === 'md' || opts.format === 'both') {
    if (opts.format === 'both') console.log('')
    console.log(renderMarkdown(reports))
  }
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main())
}
