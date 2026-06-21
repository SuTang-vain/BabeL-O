import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { createNexusApp } from '../src/nexus/app.js'
import { createDefaultNexusRuntime } from '../src/nexus/createRuntime.js'

const originalConfigFile = process.env.BABEL_O_CONFIG_FILE
const originalNodeEnv = process.env.NODE_ENV
process.env.BABEL_O_CONFIG_FILE = join(tmpdir(), `babel-o-context-history-router-${process.pid}.json`)
process.env.NODE_ENV = 'test'

after(() => {
  if (originalConfigFile === undefined) delete process.env.BABEL_O_CONFIG_FILE
  else process.env.BABEL_O_CONFIG_FILE = originalConfigFile
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
})

test('context history router preserves history summarize and raw trace contracts', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'babel-o-context-history-router-'))
  const traceDir = join(cwd, '.babel-o')
  mkdirSync(traceDir, { recursive: true })
  const timestamp = new Date().toISOString()
  const entries = [
    {
      schemaVersion: '2026-06-16.behavior-trace.v1',
      traceId: 'trace-1',
      sessionId: 'session-router-a',
      cwd,
      timestamp,
      trigger: 'error',
      triggerConfidence: 0.9,
      context: { recentEvents: [], toolSequence: [], fileRefStack: [], userIntentGuidance: '', retryCount: 0, timeInSessionMs: 0, tokensSinceLastTrace: 0 },
      anomaly: { errorCode: 'CTX_ROUTER', errorMessage: 'context router trace', source: 'nexus' },
    },
    {
      schemaVersion: '2026-06-16.behavior-trace.v1',
      traceId: 'trace-2',
      sessionId: 'session-router-b',
      cwd,
      timestamp,
      trigger: 'denial',
      triggerConfidence: 0.9,
      context: { recentEvents: [], toolSequence: [], fileRefStack: [], userIntentGuidance: '', retryCount: 0, timeInSessionMs: 0, tokensSinceLastTrace: 0 },
      anomaly: { errorCode: 'OTHER', errorMessage: 'other session' },
    },
  ]
  writeFileSync(join(traceDir, 'behavior-trace.jsonl'), `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`, 'utf8')

  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const history = await app.inject({
      method: 'GET',
      url: `/v1/context/history?cwd=${encodeURIComponent(cwd)}&summarizeScope=cross-session`,
    })
    assert.equal(history.statusCode, 200)
    const historyBody = history.json()
    assert.equal(historyBody.type, 'context_history_result')
    assert.equal(historyBody.scope, 'summarize')
    assert.equal(historyBody.hitCount, 1)
    assert.match(historyBody.content, /context router trace/)

    const trace = await app.inject({
      method: 'GET',
      url: `/v1/context/trace?cwd=${encodeURIComponent(cwd)}&sessionId=session-router-a&limit=10`,
    })
    assert.equal(trace.statusCode, 200)
    const traceBody = trace.json()
    assert.equal(traceBody.type, 'behavior_trace_result')
    assert.equal(traceBody.sessionId, 'session-router-a')
    assert.equal(traceBody.count, 1)
    assert.equal(traceBody.entries[0].traceId, 'trace-1')
  } finally {
    await app.close()
    rmSync(cwd, { recursive: true, force: true })
  }
})
