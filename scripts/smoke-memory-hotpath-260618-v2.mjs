// §3.5 v1.1 hot-path smoke v2: exercise LLMCodingRuntime directly
// (not just refreshRuntimeContextState + a hand-rolled hook). We
// invoke a single tool call against a tiny echo policy so the
// runtime walks its real `after_tool` refresh path, and assert
// that the internal `emitMemoryRetrieval` closure persists a
// `memory_retrieval` NexusEvent.
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LLMCodingRuntime } from '../dist/runtime/LLMCodingRuntime.js'
import { SqliteStorage } from '../dist/storage/SqliteStorage.js'
import { allowAllTools } from '../dist/runtime/LocalCodingRuntime.js'
import { createDefaultToolRegistry } from '../dist/tools/registry.js'
import { ConfigManager } from '../dist/shared/config.js'

const tmp = mkdtempSync(join(tmpdir(), 'babel-o-smoke-260618-v2-'))
const dbPath = join(tmp, 'db.sqlite')
const sessionId = 'session-smoke-v2-001'

const storage = new SqliteStorage(dbPath)
await storage.appendEvent(sessionId, {
  type: 'session_started',
  schemaVersion: '2026-05-21.babel-o.v1',
  sessionId,
  timestamp: new Date().toISOString(),
  cwd: tmp,
})

const tools = createDefaultToolRegistry({ storage })
const policy = allowAllTools()
const configManager = ConfigManager.getInstance()

const retrieveCalls = []
const probe = {
  name: 'runtime-probe',
  async retrieve() {
    retrieveCalls.push(true)
    return {
      content: 'RUNTIME-PROBE-HINT',
      diagnostics: {
        provider: 'runtime-probe',
        enabled: true,
        hitCount: 1,
        injectedChars: 20,
        budgetChars: 200,
        maxHitChars: 100,
        truncated: false,
        scope: 'project',
        autoSearch: { triggered: true, reason: 'explicit_memory_cue' },
      },
    }
  },
}

const runtime = new LLMCodingRuntime(
  tools,
  policy,
  storage,
  configManager,
  probe,
  undefined,
  {
    buildSystemPrompt: () => 'system',
    mapEventsToMessages: (events, initialPrompt) => [
      { role: 'user', content: initialPrompt ?? '' },
    ],
  },
)

// Trigger the hot path via executeStream(). The local-echo provider
// returns a text-only response, so the runtime will refresh
// context state at the start of the turn. We don't care about
// the final answer — only that `emitMemoryRetrieval` fired.
let eventCount = 0
for await (const ev of runtime.executeStream({
  sessionId,
  cwd: tmp,
  prompt: 'remember the plan',
  modelId: 'local/test',
})) {
  eventCount += 1
  if (eventCount > 50) break // safety cap
}

if (retrieveCalls.length === 0) {
  console.error('FAIL: retrieve() never fired during execute()')
  process.exit(1)
}
console.log(`OK: retrieve() fired ${retrieveCalls.length} time(s) during execute()`)

const all = (await storage.listEvents(sessionId, { order: 'asc' })).events
const memoryEvents = all.filter((e) => e.type === 'memory_retrieval')
if (memoryEvents.length === 0) {
  console.error('FAIL: no memory_retrieval events persisted')
  console.error('events seen:', all.map((e) => e.type))
  process.exit(1)
}
console.log(`OK: ${memoryEvents.length} memory_retrieval event(s) persisted to sqlite`)
const e = memoryEvents[0]
console.log('   first event:', JSON.stringify({
  provider: e.provider,
  hits: e.hitCount,
  chars: e.injectedChars,
  reason: e.autoSearchReason,
  triggered: e.autoSearchTriggered,
}))

await storage.close()
rmSync(tmp, { recursive: true, force: true })
console.log('SMOKE V2 PASS')
