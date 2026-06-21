// Phase 0 reproduction for context-search-algorithm-robustness-plan.md.
// Loads the REAL event stream of session_06308b17 from ~/.babel-o/db.sqlite
// and runs the 5 historical contextSearch queries through the CURRENT
// searchEvents(), asserting the regression baseline: queries 1-4 return
// hitCount=0 (empty), query 5 returns only 5 of 7 user messages.
//
// This script is the regression gate. After Phase 1 lands, re-run it:
// queries 1-4 must be non-empty and query 5 must return all 7 user messages.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { searchEvents } from '../dist/tools/contextTools.js'

const SID = 'session_06308b17-84b4-402a-909e-b0078f67ca76'
const dbPath = join(homedir(), '.babel-o', 'db.sqlite')

// Load the full event stream directly (bypass listEvents' 10k cap so we can
// also measure what the cap drops). We parse event_json rows in seq order.
const db = new DatabaseSync(dbPath, { readOnly: true })
const rows = db
  .prepare('SELECT event_json FROM events WHERE session_id = ? ORDER BY event_seq ASC')
  .all(SID)
const allEvents = rows.map((r) => JSON.parse(String(r.event_json)))
db.close()

console.log(`loaded ${allEvents.length} events for ${SID}`)

// Mirror contextSearch.ts: listEvents(order:'asc', limit:10_000) — drops rows
// past 10000 because of ascending seq + LIMIT with no filter pushdown.
const cappedEvents = allEvents.slice(0, 10_000)
console.log(`current contextSearch would load ${cappedEvents.length} of ${allEvents.length} (cap drops ${allEvents.length - cappedEvents.length})`)

// Count user_message events in each window to show what the cap hides.
const userMsgAll = allEvents.filter((e) => e.type === 'user_message')
const userMsgCapped = cappedEvents.filter((e) => e.type === 'user_message')
console.log(`user_message events: ${userMsgCapped.length} loaded / ${userMsgAll.length} total`)

// The 5 historical queries from tool_traces, in call order.
const queries = [
  { n: 1, input: { query: '架构分析 合理性 先进性', maxTokens: 3000 } },
  { n: 2, input: { query: '深度分析研究', maxTokens: 3000 } },
  { n: 3, input: { query: 'BabeL-O 架构 合理性 先进性 CLI Nexus Runtime', maxTokens: 4000 } },
  { n: 4, input: { query: 'user message request', maxTokens: 5000 } },
  { n: 5, input: { query: 'user_message', maxTokens: 3000, eventTypeFilter: ['user_message'] } },
]

let baselineConfirmed = true
for (const q of queries) {
  // Run against the SAME window contextSearch.ts loads (10k ascending).
  const result = searchEvents(cappedEvents, q.input.query, {
    maxTokens: q.input.maxTokens,
    eventTypeFilter: q.input.eventTypeFilter,
  })
  const tag = `query ${q.n} "${q.input.query}"`
  if (result.hitCount === 0) {
    console.log(`[BASELINE] ${tag} -> hitCount=0 (EMPTY — current bug)`)
  } else {
    console.log(`[BASELINE] ${tag} -> hitCount=${result.hitCount} (non-empty)`)
    if (q.n !== 5) baselineConfirmed = false // queries 1-4 should be empty under current bug
  }
  if (q.n === 5) {
    console.log(`           query 5 returned ${result.hitCount} of ${userMsgAll.length} total user_message events`)
    if (result.hitCount !== userMsgAll.length) {
      console.log(`           GAP: ${userMsgAll.length - result.hitCount} newest user messages unreachable due to 10k cap`)
    }
  }
}

console.log('')
if (baselineConfirmed && userMsgCapped.length < userMsgAll.length) {
  console.log('REPRO PASS: baseline confirmed — queries 1-4 empty, query 5 missing newest user messages')
  process.exit(0)
} else {
  console.log('REPRO UNEXPECTED: baseline not as predicted, investigate')
  process.exit(1)
}
