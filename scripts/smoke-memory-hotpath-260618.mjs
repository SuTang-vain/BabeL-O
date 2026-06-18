// §3.5 v1.1 hot-path emission smoke
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eventBase } from '../dist/shared/events.js'
import { SqliteStorage } from '../dist/storage/SqliteStorage.js'
import { refreshRuntimeContextState } from '../dist/runtime/runtimePipeline.js'

const tmp = mkdtempSync(join(tmpdir(), 'babel-o-smoke-260618-'))
const dbPath = join(tmp, 'db.sqlite')
const sessionId = 'session-smoke-260618-001'

const retrieveCalls = []
const probe = {
  name: 'smoke-probe',
  async retrieve(input) {
    retrieveCalls.push({ prompt: input.prompt, cwd: input.cwd })
    const diagnostics = {
      provider: 'smoke-probe',
      enabled: true,
      hitCount: 1,
      injectedChars: 42,
      budgetChars: 200,
      maxHitChars: 100,
      truncated: false,
      scope: 'project',
      autoSearch: { triggered: true, reason: 'explicit_memory_cue', cue: 'remember' },
    }
    return {
      content: 'PROBE-HINT: prior decision was "use memoryos naming".',
      diagnostics,
    }
  },
}

const storage = new SqliteStorage(dbPath)
await storage.appendEvent(sessionId, {
  type: 'session_started',
  schemaVersion: '2026-05-21.babel-o.v1',
  sessionId,
  timestamp: new Date().toISOString(),
  cwd: tmp,
})

// Mirror LLMCodingRuntime.emitMemoryRetrieval
const onMemoryRetrieval = async (input) => {
  const d = input.diagnostics
  const autoSearch = d.autoSearch
  const event = {
    ...eventBase(input.sessionId),
    type: 'memory_retrieval',
    provider: d.provider,
    enabled: d.enabled,
    scope: d.scope,
    ...(d.namespaceId && { namespaceId: d.namespaceId }),
    ...(d.namespaceSource && { namespaceSource: d.namespaceSource }),
    ...(d.isolationKey && { isolationKey: d.isolationKey }),
    autoSearchTriggered: autoSearch?.triggered ?? false,
    autoSearchReason: autoSearch?.reason ?? 'no_memory_cue',
    ...(autoSearch?.cue && { autoSearchCue: autoSearch.cue }),
    hitCount: d.hitCount,
    injectedChars: d.injectedChars,
    budgetChars: d.budgetChars,
    maxHitChars: d.maxHitChars,
    truncated: d.truncated,
    ...(d.searchLatencyMs !== undefined && { searchLatencyMs: d.searchLatencyMs }),
    ...(d.error && { error: d.error }),
    prompt: input.prompt,
    cwd: input.cwd,
  }
  await storage.appendEvent(input.sessionId, event)
}

await refreshRuntimeContextState({
  runtimeOptions: {
    sessionId,
    cwd: tmp,
    prompt: 'remember what we decided',
  },
  events: (await storage.listEvents(sessionId, { order: 'asc' })).events,
  modelId: 'local/test',
  buildSystemPrompt: () => 'system',
  mapEventsToMessages: () => [],
  memoryProvider: probe,
  sessionInbox: [],
  onMemoryRetrieval,
  tools: () => [],
  warningPercent: 80,
  compactPercent: 95,
  suppressToolsForIntent: () => false,
})

if (retrieveCalls.length !== 1) {
  console.error('FAIL: expected exactly 1 retrieve() call, got', retrieveCalls.length)
  process.exit(1)
}
console.log('OK: retrieve() fired once')

const allEvents = await storage.listEvents(sessionId, { order: 'asc' })
const events = allEvents.events.filter((e) => e.type === 'memory_retrieval')
if (events.length !== 1) {
  console.error('FAIL: expected exactly 1 memory_retrieval event in storage, got', events.length)
  process.exit(1)
}
const e = events[0]
if (e.type !== 'memory_retrieval') {
  console.error('FAIL: event type is not memory_retrieval:', e.type)
  process.exit(1)
}
if (e.provider !== 'smoke-probe') {
  console.error('FAIL: provider mismatch:', e.provider)
  process.exit(1)
}
if (e.autoSearchTriggered !== true) {
  console.error('FAIL: autoSearchTriggered mismatch:', e.autoSearchTriggered)
  process.exit(1)
}
if (e.autoSearchReason !== 'explicit_memory_cue') {
  console.error('FAIL: autoSearchReason mismatch:', e.autoSearchReason)
  process.exit(1)
}
if (e.hitCount !== 1 || e.injectedChars !== 42) {
  console.error('FAIL: hitCount/injectedChars mismatch:', e.hitCount, e.injectedChars)
  process.exit(1)
}
if (e.prompt !== 'remember what we decided') {
  console.error('FAIL: prompt mismatch:', e.prompt)
  process.exit(1)
}
if (e.cwd !== tmp) {
  console.error('FAIL: cwd mismatch:', e.cwd)
  process.exit(1)
}
console.log('OK: memory_retrieval event landed in sqlite with all fields correct')
console.log('   provider=', e.provider, 'hits=', e.hitCount, 'chars=', e.injectedChars, 'reason=', e.autoSearchReason)

await storage.close()
rmSync(tmp, { recursive: true, force: true })
console.log('SMOKE PASS')
