// Phase 2 reproduction for adaptive-context-window-selection-plan.md.
// Loads the REAL event stream of session_75d74b74 (5 turns, 852k
// deepseek-v4-pro) and asserts that at low usage (~22% pre-selection estimate)
// the microcompact/snip compactors preserve large tool_results verbatim
// instead of summarizing them.
//
// Baseline (before Phase 2): microcompact drops 39,866 tokens / 159,462 bytes
// across 18 tool_results >4,000 chars (Read 27k, ListDir 23k, Glob 14k, etc.)
// at 3–22% usage — the real cause of the user-visible "compressed every
// prompt" symptom. After Phase 2, only true duplicate tool_results are
// deduplicated; size-based trimming is skipped while headroom is available.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { SqliteStorage } from '../dist/storage/SqliteStorage.js'
import { estimateContextTokens } from '../dist/runtime/tokenEstimator.js'
import {
  allocateBudget,
  selectRecentEvents,
  protectToolPairs,
} from '../dist/runtime/contextAssembler.js'
import { microcompactEventsWithMetrics } from '../dist/runtime/compactors/microCompact.js'
import { snipEventsWithTurnBoundary } from '../dist/runtime/compactors/snipCompactor.js'
import { mapEventsToMessages } from '../dist/runtime/eventsTranslator.js'

const SID = 'session_75d74b74-1614-44ec-af63-ba636dfc5838'
const realDb = join(homedir(), '.babel-o', 'db.sqlite')
const tmp = mkdtempSync(join(tmpdir(), 'babel-o-repro-p2-260622-'))
const tmpDb = join(tmp, 'db.sqlite')
copyFileSync(realDb, tmpDb)

const storage = new SqliteStorage(tmpDb)
const { events } = await storage.listEvents(SID, { order: 'asc', limit: 50_000 })
await storage.close()
rmSync(tmp, { recursive: true, force: true })

const budget = allocateBudget('deepseek/deepseek-v4-pro')
console.log(`loaded ${events.length} events for ${SID}`)
console.log(`microcompactToolOutputChars (legacy) = ${budget.microcompactToolOutputChars}`)

// Turn 5 window: all events up to turn 5 start.
const window = events.slice(0, 7974)
const preSelectionMessages = mapEventsToMessages(window, '继续', { replayReasoningContent: true })
const preSelectionTokenEstimate = estimateContextTokens({
  messages: preSelectionMessages,
  conservative: true,
}).totalTokens
const hasHeadroom = preSelectionTokenEstimate < Math.floor(budget.maxTokens * 0.7)
console.log(`turn5 window: ${window.length} events, preSelectionEst=${preSelectionTokenEstimate} (${Math.round((preSelectionTokenEstimate / budget.maxTokens) * 100)}%), headroom=${hasHeadroom}`)

const selected = selectRecentEvents(window, budget, { preSelectionTokenEstimate })
const protectedEvents = protectToolPairs(window, selected)

// Count large tool_results in the SELECTED window (what microcompact would trim).
const largeToolResultsBefore = protectedEvents.filter((e) => {
  if (e.type !== 'tool_completed') return false
  const out = typeof e.output === 'string' ? e.output : JSON.stringify(e.output)
  return out.length > budget.microcompactToolOutputChars
}).length
console.log(`large tool_results (>${budget.microcompactToolOutputChars} chars) before compaction: ${largeToolResultsBefore}`)

// Phase 2 compactor budget: raise thresholds when headroom is available.
const compactorBudget = hasHeadroom
  ? {
      ...budget,
      microcompactToolOutputChars: Number.POSITIVE_INFINITY,
      microcompactInternalTextChars: Number.POSITIVE_INFINITY,
      snipToolOutputChars: Number.POSITIVE_INFINITY,
      snipPriorTurnToolOutputChars: Number.POSITIVE_INFINITY,
    }
  : budget

const microcompactResult = microcompactEventsWithMetrics(protectedEvents, compactorBudget)
console.log(`microcompact (headroom): compacted=${microcompactResult.metrics.compactedEventCount} dedup=${microcompactResult.metrics.deduplicatedToolResultCount} bytesSaved=${microcompactResult.metrics.bytesSaved} tokensSaved=${microcompactResult.metrics.estimatedTokensSaved}`)

const snipped = snipEventsWithTurnBoundary(
  microcompactResult.events,
  compactorBudget.snipToolOutputChars,
  compactorBudget.snipPriorTurnToolOutputChars,
)

// Count large tool_results that SURVIVED intact (not summarized).
const survivingLarge = snipped.filter((e) => {
  if (e.type !== 'tool_completed') return false
  const out = typeof e.output === 'string' ? e.output : JSON.stringify(e.output)
  return out.length > budget.microcompactToolOutputChars && !out.includes('microcompacted') && !out.includes('truncated')
}).length
console.log(`large tool_results preserved intact after compaction: ${survivingLarge}`)

// Also run the LEGACY compactor (no headroom) for comparison.
const legacyMicro = microcompactEventsWithMetrics(protectedEvents, budget)
const legacySurvivingLarge = legacyMicro.events.filter((e) => {
  if (e.type !== 'tool_completed') return false
  const out = typeof e.output === 'string' ? e.output : JSON.stringify(e.output)
  return out.length > budget.microcompactToolOutputChars && !out.includes('microcompacted') && !out.includes('truncated')
}).length
console.log(`[LEGACY no headroom] large tool_results preserved: ${legacySurvivingLarge}, tokensSaved=${legacyMicro.metrics.estimatedTokensSaved}`)

let failures = 0
const expect = (cond, msg) => {
  if (!cond) { console.error(`  FAIL: ${msg}`); failures += 1 }
  else { console.log(`  ok: ${msg}`) }
}

console.log(`\n=== Phase 2 assertions ===`)
expect(hasHeadroom, `headroom is active at ${Math.round((preSelectionTokenEstimate / budget.maxTokens) * 100)}% usage`)
expect(largeToolResultsBefore > 0, `session has large tool_results to preserve (found ${largeToolResultsBefore})`)
expect(survivingLarge > legacySurvivingLarge, `Phase 2 preserves more large tool_results than legacy (${survivingLarge} > ${legacySurvivingLarge})`)
expect(microcompactResult.metrics.estimatedTokensSaved < legacyMicro.metrics.estimatedTokensSaved, `Phase 2 saves fewer tokens via size-trim than legacy (${microcompactResult.metrics.estimatedTokensSaved} < ${legacyMicro.metrics.estimatedTokensSaved})`)

console.log('')
if (failures === 0) {
  console.log(`PHASE 2 GATE PASS: ${survivingLarge} large tool_results preserved at ${Math.round((preSelectionTokenEstimate / budget.maxTokens) * 100)}% usage (legacy preserved ${legacySurvivingLarge})`)
  process.exit(0)
} else {
  console.log(`PHASE 2 GATE FAIL (${failures} failure(s))`)
  process.exit(1)
}
