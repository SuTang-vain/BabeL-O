// Phase 1 regression gate for context-search-algorithm-robustness-plan.md.
// Loads the REAL event stream of session_06308b17 via SqliteStorage.listEvents
// (exercising the eventTypeFilter SQL pushdown) and runs the 5 historical
// contextSearch queries through the new tokenized searchEvents.
//
// Phase 1 exit criteria:
//   - query 4 ("user message request") is non-empty (AND-substring fix).
//   - query 5 ("user_message" + eventTypeFilter) returns ALL user_message
//     events (pushdown bypasses the 10k-row cap).
//   - queries 1-3 are documented as the Phase 2 CJK-reordering trigger
//     (AND-substring cannot match `架构分析` against `分析…架构`).
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { SqliteStorage } from '../dist/storage/SqliteStorage.js'
import { searchEvents } from '../dist/tools/contextTools.js'

const SID = 'session_06308b17-84b4-402a-909e-b0078f67ca76'
const realDb = join(homedir(), '.babel-o', 'db.sqlite')

// Copy the real db into a temp file so we open it read-write safely via
// SqliteStorage without touching the user's live database.
const tmp = mkdtempSync(join(tmpdir(), 'babel-o-repro-260621-'))
const tmpDb = join(tmp, 'db.sqlite')
import { copyFileSync } from 'node:fs'
copyFileSync(realDb, tmpDb)

const storage = new SqliteStorage(tmpDb)

// Mirror contextSearch.ts: unfiltered load with limit 50_000 (Phase 1 raised
// from 10_000). nextCursor present means the window was row-capped.
const unfiltered = await storage.listEvents(SID, { order: 'asc', limit: 50_000 })
const events = unfiltered.events
const eventsCapped = unfiltered.nextCursor !== undefined
console.log(`unfiltered load: ${events.length} events, eventsCapped=${eventsCapped}`)

const totalUserMessages = events.filter((e) => e.type === 'user_message').length
console.log(`user_message events in full window: ${totalUserMessages}`)

const queries = [
  { n: 1, input: { query: '架构分析 合理性 先进性', maxTokens: 3000 } },
  { n: 2, input: { query: '深度分析研究', maxTokens: 3000 } },
  { n: 3, input: { query: 'BabeL-O 架构 合理性 先进性 CLI Nexus Runtime', maxTokens: 4000 } },
  { n: 4, input: { query: 'user message request', maxTokens: 5000 } },
  { n: 5, input: { query: 'user_message', maxTokens: 3000, eventTypeFilter: ['user_message'] } },
]

let failures = 0
const expect = (cond, msg) => {
  if (!cond) { console.error(`  FAIL: ${msg}`); failures += 1 }
  else { console.log(`  ok: ${msg}`) }
}

for (const q of queries) {
  // For query 5, mirror contextSearch.ts which passes eventTypeFilter as
  // eventTypes to listEvents (SQL pushdown) when set.
  let window = events
  let capped = eventsCapped
  if (q.input.eventTypeFilter) {
    const filtered = await storage.listEvents(SID, {
      order: 'asc',
      limit: 50_000,
      eventTypes: q.input.eventTypeFilter,
    })
    window = filtered.events
    capped = filtered.nextCursor !== undefined
  }
  const result = searchEvents(window, q.input.query, {
    maxTokens: q.input.maxTokens,
    eventTypeFilter: q.input.eventTypeFilter,
    eventsScanned: window.length,
    eventsCapped: capped,
  })
  console.log(`query ${q.n} "${q.input.query}" -> hitCount=${result.hitCount} eventsScanned=${result.eventsScanned} eventsCapped=${result.eventsCapped}`)
  if (q.n === 4) {
    expect(result.hitCount > 0, 'query 4 non-empty (AND-substring fix)')
  }
  if (q.n === 5) {
    expect(result.hitCount === totalUserMessages, `query 5 returns all ${totalUserMessages} user_message events (pushdown bypasses cap)`)
    expect(result.eventsCapped === false, 'query 5 window not row-capped (pushdown)')
  }
  if (q.n <= 3 && result.hitCount === 0) {
    console.log(`  note: query ${q.n} still empty — CJK reordering, Phase 2 trigger`)
  }
}

await storage.close()
rmSync(tmp, { recursive: true, force: true })

console.log('')
if (failures === 0) {
  console.log('PHASE 1 GATE PASS')
  process.exit(0)
} else {
  console.log(`PHASE 1 GATE FAIL (${failures} failure(s))`)
  process.exit(1)
}
