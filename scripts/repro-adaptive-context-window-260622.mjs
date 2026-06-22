// Phase 0 reproduction for adaptive-context-window-selection-plan.md.
// Loads the REAL event stream of session_cd42cb65 from ~/.babel-o/db.sqlite
// and runs the CURRENT selectRecentEvents + allocateBudget to show that
// every assembly trims to a fixed 4-turn window regardless of the fact that
// context usage is only ~3% on an 852k-token model.
//
// Baseline assertion (current bug):
//   - allocateBudget('deepseek/deepseek-v4-pro').recentTurnLimit === 4
//   - selectRecentEvents on the full session returns only the LAST 4 user
//     turns, dropping turns 1-7 even though usage is ~3%.
//
// After Phase 1 lands, re-run: at 3% usage the selected window must include
// ALL user turns (1-8), not just the last 4.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { SqliteStorage } from '../dist/storage/SqliteStorage.js'
import { selectRecentEvents, allocateBudget } from '../dist/runtime/contextAssembler.js'
import { estimateContextTokens } from '../dist/runtime/tokenEstimator.js'
import { mapEventsToMessages } from '../dist/runtime/eventsTranslator.js'

const SID = 'session_cd42cb65-bc34-4a49-9923-8d43cb4f5fe4'
const realDb = join(homedir(), '.babel-o', 'db.sqlite')

// Copy the real db into a temp file so we open it safely read-write via
// SqliteStorage without touching the user's live database.
const tmp = mkdtempSync(join(tmpdir(), 'babel-o-repro-adaptive-260622-'))
const tmpDb = join(tmp, 'db.sqlite')
copyFileSync(realDb, tmpDb)

const storage = new SqliteStorage(tmpDb)
const result = await storage.listEvents(SID, { order: 'asc', limit: 50_000 })
const events = result.events
await storage.close()
rmSync(tmp, { recursive: true, force: true })

console.log(`loaded ${events.length} events for ${SID}`)

// User-turn bookkeeping: index of each user_message event.
const userMsgIdxs = []
for (let i = 0; i < events.length; i++) {
  if (events[i].type === 'user_message') userMsgIdxs.push(i)
}
const totalTurns = userMsgIdxs.length
console.log(`user_message events (turns): ${totalTurns}`)
userMsgIdxs.forEach((idx, i) => {
  const text = String(events[idx].text ?? '').slice(0, 50)
  console.log(`  turn ${i + 1} @ event[${idx}]: "${text}"`)
})

// Mirror contextAssembler.ts: the budget for deepseek-v4-pro (852k ceiling).
const budget = allocateBudget('deepseek/deepseek-v4-pro')
console.log(`\nallocateBudget('deepseek/deepseek-v4-pro'):`)
console.log(`  maxTokens = ${budget.maxTokens}`)
console.log(`  recentTurnLimit = ${budget.recentTurnLimit}  (fixed: maxTokens >= 100_000 ? 4 : 2)`)
console.log(`  recentEventLimit = ${budget.recentEventLimit}`)

// Current behavior: selectRecentEvents trims to recentTurnLimit unconditionally.
const selected = selectRecentEvents(events, budget)
const selectedUserMsgs = selected.filter((e) => e.type === 'user_message')
console.log(`\n[BASELINE] selectRecentEvents (no headroom) returned ${selected.length} events, ${selectedUserMsgs.length} user_message(s)`)

// Fixed behavior: pass a pre-selection estimate via the SAME path
// assembleContext uses — mapEventsToMessages(coalesce deltas) then
// estimateContextTokens. The runtime reported ~3% for this session on the
// post-selection window; the full-stream pre-selection estimate is larger
// (deltas coalesced but no microcompact/snip yet) but still well below the
// 70% warning threshold, so headroom activates and all turns are retained.
const preSelectionMessages = mapEventsToMessages(events, '继续任务', { replayReasoningContent: true })
const preSelectionTokenEstimate = estimateContextTokens({
  messages: preSelectionMessages,
  conservative: true,
}).totalTokens
const selectedFixed = selectRecentEvents(events, budget, { preSelectionTokenEstimate })
const selectedFixedUserMsgs = selectedFixed.filter((e) => e.type === 'user_message')
console.log(`[FIXED]    selectRecentEvents (headroom ${Math.round((preSelectionTokenEstimate / budget.maxTokens) * 100)}%) returned ${selectedFixed.length} events, ${selectedFixedUserMsgs.length} user_message(s)`)

// Which turns survived in the FIXED window?
const selectedTexts = new Set(selectedFixedUserMsgs.map((e) => String(e.text ?? '').slice(0, 50)))
console.log(`\nsurviving turns (FIXED):`)
let droppedCount = 0
for (let i = 0; i < userMsgIdxs.length; i++) {
  const text = String(events[userMsgIdxs[i]].text ?? '').slice(0, 50)
  const survived = selectedTexts.has(text)
  console.log(`  turn ${i + 1}: ${survived ? 'KEPT' : 'DROPPED'}  "${text}"`)
  if (!survived) droppedCount += 1
}

// Headroom context: estimate the FIXED window via the SAME coalescing path
// the runtime uses (mapEventsToMessages + estimateContextTokens), so the
// percent-of-ceiling reflects what the provider would actually see. The
// raw-JSON estimate overstates cost (deltas are not coalesced); the coalesced
// estimate is the honest signal that full history fits below the warning
// threshold, justifying the relaxed caps.
const fixedMessages = mapEventsToMessages(selectedFixed, '继续任务', { replayReasoningContent: true })
const selectedEstimate = estimateContextTokens({
  messages: fixedMessages,
  conservative: true,
}).totalTokens
const selectedPct = Math.round((selectedEstimate / budget.maxTokens) * 100)

console.log(`\nFIXED selected window (coalesced) estimate: ~${selectedEstimate} tokens = ${selectedPct}% of ${budget.maxTokens} ceiling`)

let failures = 0
const expect = (cond, msg) => {
  if (!cond) { console.error(`  FAIL: ${msg}`); failures += 1 }
  else { console.log(`  ok: ${msg}`) }
}

console.log(`\n=== baseline + fix assertions ===`)
// Baseline (no headroom): the bug still reproduces — 1 of 11 turns kept.
expect(budget.recentTurnLimit === 4, `recentTurnLimit is fixed 4 for 852k model`)
expect(selectedUserMsgs.length < totalTurns, `BASELINE (no headroom) drops turns (kept ${selectedUserMsgs.length} of ${totalTurns})`)
// Fix (with headroom): all turns retained at low usage.
expect(selectedFixedUserMsgs.length === totalTurns, `FIXED (headroom) retains all turns (kept ${selectedFixedUserMsgs.length} of ${totalTurns})`)
expect(droppedCount === 0, `FIXED (headroom) drops 0 turns (dropped ${droppedCount})`)

console.log('')
if (failures === 0) {
  console.log(`REPRO PASS: baseline bug confirmed (${selectedUserMsgs.length}/${totalTurns} without headroom) AND fix verified (${selectedFixedUserMsgs.length}/${totalTurns} with headroom); FIXED window is ${selectedPct}% of ceiling`)
  process.exit(0)
} else {
  console.log(`REPRO UNEXPECTED: ${failures} assertion(s) failed`)
  process.exit(1)
}
