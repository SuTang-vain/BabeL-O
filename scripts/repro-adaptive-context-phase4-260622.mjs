// Phase 4 reproduction for adaptive-context-window-selection-plan.md.
// Loads the REAL event stream of session_8d6fc33d (7 turns, 852k
// deepseek-v4-pro) and asserts that under headroom, a REQUEST_CANCELLED
// in the middle of the session no longer slices off all prior history.
//
// Real session evidence: this session had a REQUEST_CANCELLED at seq 4752
// (turn 3 cancelled, turn 4 "继续任务"). Legacy recovery-boundary slice
// dropped turns 1-3 (~215k tokens of deep analysis) from turn 4 onward
// even at 2-5% usage. After Phase 4, at low usage the recovery slice is
// skipped so history survives.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { selectRecentEvents, allocateBudget } from '../dist/runtime/contextAssembler.js'
import { estimateContextTokens } from '../dist/runtime/tokenEstimator.js'
import { mapEventsToMessages } from '../dist/runtime/eventsTranslator.js'

const SID = 'session_8d6fc33d-e455-4bcc-8c7b-1d6ea070f1d8'
const realDb = join(homedir(), '.babel-o', 'db.sqlite')

// Load the full event stream directly so we can run with/without headroom
// across the same dataset and observe the recovery-boundary effect.
const db = new DatabaseSync(realDb, { readOnly: true })
const rows = db
  .prepare('SELECT event_json FROM events WHERE session_id = ? ORDER BY event_seq ASC')
  .all(SID)
const events = rows.map((r) => JSON.parse(String(r.event_json)))
db.close()
console.log(`loaded ${events.length} events for ${SID}`)

const budget = allocateBudget('deepseek/deepseek-v4-pro')
console.log(`budget: maxTokens=${budget.maxTokens}, recentTurnLimit=${budget.recentTurnLimit}, recentEventLimit=${budget.recentEventLimit}`)

// Find REQUEST_CANCELLED seq + user_message seq positions for the timeline.
const cancelSeqs = []
const userSeqs = []
for (let i = 0; i < events.length; i++) {
  if (events[i].type === 'user_message') userSeqs.push(i)
  if (events[i].type === 'error' && events[i].code === 'REQUEST_CANCELLED') cancelSeqs.push(i)
}
console.log(`REQUEST_CANCELLED at event idx: ${cancelSeqs.join(', ')}`)
console.log(`user_message at event idx: ${userSeqs.join(', ')}`)

// Map turns to user_message boundaries and label each turn.
const turnLabels = [
  '深度分析研究这个项目/Users/tangyaoyue/DEV/BABEL/BabeL-O',
  '/Users/tangyaoyue/DEV/open-design\n/Users/tangyaoyue/DEV/llamacoder',
  '我当前需要根据...BabeL-O...作为驱动内核',
  '继续任务',
  '所以你推荐使用两个项目中的哪个？',
  '不是挑不挑的问题，而是从工程落地的角度上哪个更合适',
  '回顾我们之前的聊天记录',
]

// For each turn, simulate initial_refresh (window = all events up to and
// including this turn's user_message). Compare legacy (no headroom) vs
// Phase 4 fix (with headroom).
console.log('\n=== Per-turn retention ===')
for (let t = 0; t < userSeqs.length; t++) {
  const endIdx = t + 1 < userSeqs.length ? userSeqs[t + 1] : events.length
  const window = events.slice(0, endIdx)
  const msgs = mapEventsToMessages(window, '继续', { replayReasoningContent: true })
  const preSelectionTokenEstimate = estimateContextTokens({
    messages: msgs,
    conservative: true,
  }).totalTokens
  const hasHeadroom = preSelectionTokenEstimate < Math.floor(budget.maxTokens * 0.7)

  // Legacy (no headroom → recovery-boundary slice applies)
  const legacySelected = selectRecentEvents(window, budget)
  const legacyUserTurns = legacySelected.filter((e) => e.type === 'user_message').length

  // Phase 4 fix (with headroom → recovery-boundary slice skipped)
  const fixedSelected = selectRecentEvents(window, budget, {
    preSelectionTokenEstimate,
  })
  const fixedCount = fixedSelected.filter((e) => e.type === 'user_message').length

  // Is this turn AFTER a REQUEST_CANCELLED?
  const afterCancel = cancelSeqs.length > 0 && userSeqs[t] > cancelSeqs[cancelSeqs.length - 1]

  console.log(
    `turn ${t + 1} (${turnLabels[t]?.slice(0, 40)}...): ` +
    `headroom=${hasHeadroom}, after_cancel=${afterCancel}, ` +
    `legacy_turns=${legacyUserTurns}/${t + 1}, phase4_turns=${fixedCount}/${t + 1}`,
  )
}

console.log('')
console.log('=== Phase 4 assertions ===')
let failures = 0
const expect = (cond, msg) => {
  if (!cond) { console.error(`  FAIL: ${msg}`); failures += 1 }
  else { console.log(`  ok: ${msg}`) }
}

// Specifically check turns AFTER the cancel (4-7): legacy kept only 1 turn,
// Phase 4 should keep all 4 turns (the cancel happened at low usage).
for (let t = 3; t < userSeqs.length; t++) {
  const endIdx = t + 1 < userSeqs.length ? userSeqs[t + 1] : events.length
  const window = events.slice(0, endIdx)
  const msgs = mapEventsToMessages(window, '继续', { replayReasoningContent: true })
  const preSelectionTokenEstimate = estimateContextTokens({
    messages: msgs,
    conservative: true,
  }).totalTokens
  const hasHeadroom = preSelectionTokenEstimate < Math.floor(budget.maxTokens * 0.7)
  if (!hasHeadroom) continue // skip if this turn happens to be high usage

  const fixedSelected = selectRecentEvents(window, budget, {
    preSelectionTokenEstimate,
  })
  const fixedCount = fixedSelected.filter((e) => e.type === 'user_message').length
  expect(fixedCount === t + 1, `turn ${t + 1} (after REQUEST_CANCELLED): Phase 4 retains all ${t + 1} turns (got ${fixedCount})`)
}

console.log('')
if (failures === 0) {
  console.log('PHASE 4 GATE PASS: history across REQUEST_CANCELLED is preserved at low usage')
  process.exit(0)
} else {
  console.log(`PHASE 4 GATE FAIL (${failures} failure(s))`)
  process.exit(1)
}
