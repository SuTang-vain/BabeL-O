import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { createNexusApp } from '../src/nexus/app.js'
import { createDefaultNexusRuntime } from '../src/nexus/createRuntime.js'
import { NEXUS_EVENT_SCHEMA_VERSION, type NexusEvent } from '../src/shared/events.js'
import { DEFAULT_SESSION_CHANNEL_POLICY, type SessionChannel, type SessionMessage } from '../src/shared/sessionChannel.js'

const originalConfigFile = process.env.BABEL_O_CONFIG_FILE
const originalNodeEnv = process.env.NODE_ENV
process.env.BABEL_O_CONFIG_FILE = join(tmpdir(), `babel-o-runtime-memory-router-${process.pid}.json`)
process.env.NODE_ENV = 'test'

after(() => {
  if (originalConfigFile === undefined) delete process.env.BABEL_O_CONFIG_FILE
  else process.env.BABEL_O_CONFIG_FILE = originalConfigFile
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
})

test('runtime memory router preserves read-only status and quality metric contracts', async () => {
  const { runtime, storage } = await createDefaultNexusRuntime()
  const sessionId = 'session-memory-router-test'
  const createdAt = '2026-06-18T08:00:00.000Z'
  await storage.saveSession({
    sessionId,
    cwd: '/tmp',
    prompt: 'remembered context',
    phase: 'completed',
    createdAt,
    updatedAt: createdAt,
    events: [],
  })
  await storage.appendEvent(sessionId, {
    schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
    sessionId,
    type: 'memory_retrieval',
    timestamp: '2026-06-18T08:00:01.000Z',
    provider: 'evercore',
    enabled: true,
    scope: 'project',
    namespaceId: 'project-1',
    namespaceSource: 'explicit',
    isolationKey: 'projectId',
    autoSearchTriggered: true,
    autoSearchReason: 'explicit_memory_cue',
    autoSearchCue: 'remember',
    hitCount: 2,
    injectedChars: 480,
    budgetChars: 4_000,
    maxHitChars: 800,
    truncated: true,
    searchLatencyMs: 12,
  } as NexusEvent)

  const app = await createNexusApp({
    runtime,
    storage,
    defaultCwd: '/tmp',
    everCoreStatus: {
      configured: true,
      enabled: true,
      healthy: true,
      mode: 'managed',
      uploadOnSessionEnd: false,
      mcpToolsEnabled: true,
      namespace: {
        layer: 'project_memory',
        isolationKey: 'projectId',
        sessionScoped: false,
        projectIdSource: 'explicit',
      },
    },
  })
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/runtime/memory/status' })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.type, 'memory_status')
    assert.equal(body.capability.available, true)
    assert.equal(body.capability.autoSearch, 'cue-driven')
    assert.equal(body.capability.save, 'permission-gated')
    assert.equal(body.capability.authoritative, false)
    assert.equal(body.everCore.namespace.isolationKey, 'projectId')
    assert.equal(body.quality.windowSize, 1)
    assert.equal(body.quality.retrievalCount, 1)
    assert.equal(body.quality.autoSearchTriggeredCount, 1)
    assert.equal(body.quality.totalHitCount, 2)
    assert.equal(body.quality.totalInjectedChars, 480)
    assert.equal(body.quality.truncationRate, 1)
    assert.equal(body.quality.retrievalHitRate, 1)
    assert.equal(body.quality.autoSearchTriggerRate, 1)
    assert.equal(body.quality.averageSearchLatencyMs, 12)
    assert.equal(body.guidance.memoryIsHint, true)
    assert.equal(body.actions.status, 'read')
    assert.equal(body.actions.saveNote, 'write_permission_gated')
    assert.equal(body.actions.flush, 'lifecycle_permission_gated')
  } finally {
    await app.close()
  }
})

test('runtime memory router reports review-only memory candidates', async () => {
  const { runtime, storage } = await createDefaultNexusRuntime()
  const createdAt = '2026-06-18T09:00:00.000Z'
  const channel: SessionChannel = {
    channelId: 'channel-memory-router-candidates',
    kind: 'workspace_pair',
    participantSessionIds: ['session-a', 'session-b'],
    createdBySessionId: 'session-a',
    createdAt,
    status: 'open',
    policy: {
      ...DEFAULT_SESSION_CHANNEL_POLICY,
      allowMemoryWriteRequests: true,
    },
  }
  await storage.saveSessionChannel(channel)
  const message: SessionMessage = {
    messageId: 'msg-memory-candidate',
    channelId: channel.channelId,
    fromSessionId: 'session-a',
    toSessionId: 'session-b',
    type: 'memory_candidate',
    content: 'User prefers focused regression tests before broad hygiene.',
    evidence: [{ type: 'session_event', ref: 'evt_1', label: 'preference' }],
    priority: 'normal',
    createdAt: '2026-06-18T09:00:01.000Z',
    status: 'queued',
    metadata: {
      memoryCandidateGovernance: {
        scope: 'user',
        decision: 'requires_approval',
        autoWrite: false,
        approval: { status: 'required' },
      },
    },
  }
  await storage.saveSessionMessage(message)

  const app = await createNexusApp({
    runtime,
    storage,
    defaultCwd: '/tmp',
  })
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/runtime/memory/candidates?sessionId=session-b&limit=5',
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.type, 'memory_candidates')
    assert.equal(body.limit, 5)
    assert.equal(body.includeRejected, true)
    assert.equal(body.guidance.autoWrite, false)
    assert.equal(body.guidance.reviewOnly, true)
    assert.equal(body.candidates.length, 1)
    assert.equal(body.candidates[0].messageId, 'msg-memory-candidate')
    assert.equal(body.candidates[0].content, 'User prefers focused regression tests before broad hygiene.')
    assert.equal(body.candidates[0].governance.scope, 'user')
    assert.equal(body.candidates[0].governance.decision, 'requires_approval')
    assert.equal(body.candidates[0].governance.autoWrite, false)
  } finally {
    await app.close()
  }
})
