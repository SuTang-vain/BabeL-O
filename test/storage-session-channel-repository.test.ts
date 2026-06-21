import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteStorage } from '../src/storage/SqliteStorage.js'
import type {
  SessionChannel,
  SessionChannelPolicy,
  SessionMessage,
} from '../src/shared/sessionChannel.js'

function tempDbPath(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'babel-o-session-channel-repo-'))
  return { dir, dbPath: join(dir, 'nexus.sqlite') }
}

function baseSession(sessionId: string) {
  return {
    sessionId,
    cwd: '/workspace',
    prompt: 'inspect',
    phase: 'created' as const,
    createdAt: '2026-06-20T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:00.000Z',
    events: [],
  }
}

function basePolicy(): SessionChannelPolicy {
  return {
    allowedMessageTypes: ['question', 'answer', 'finding'],
    maxMessageChars: 2000,
    maxEvidenceRefs: 5,
    allowBroadcast: true,
    allowMemoryWriteRequests: false,
    requireUserApprovalForExternalProject: false,
    contextInjectionMode: 'recent_messages',
  }
}

function makeChannel(overrides: Partial<SessionChannel> = {}): SessionChannel {
  return {
    channelId: 'channel_1',
    kind: 'direct',
    participantSessionIds: ['session_a', 'session_b'],
    createdBySessionId: 'session_a',
    createdAt: '2026-06-20T00:00:01.000Z',
    status: 'open',
    policy: basePolicy(),
    ...overrides,
  }
}

function makeMessage(overrides: Partial<SessionMessage> = {}): SessionMessage {
  return {
    messageId: 'msg_1',
    channelId: 'channel_1',
    fromSessionId: 'session_a',
    type: 'question',
    content: 'have you finished the audit?',
    priority: 'normal',
    createdAt: '2026-06-20T00:00:02.000Z',
    status: 'queued',
    ...overrides,
  }
}

test('SessionChannelRepository saveSessionChannel + getSessionChannel preserves all fields', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    const channel = makeChannel({
      channelId: 'channel_roundtrip',
      kind: 'group',
      participantSessionIds: ['s1', 's2', 's3'],
      createdBySessionId: 's1',
      metadata: { topic: 'audit', tags: ['p0'] },
    })
    await storage.saveSessionChannel(channel)
    const loaded = await storage.getSessionChannel('channel_roundtrip')
    assert.ok(loaded)
    assert.equal(loaded.channelId, 'channel_roundtrip')
    assert.equal(loaded.kind, 'group')
    assert.deepEqual(loaded.participantSessionIds, ['s1', 's2', 's3'])
    assert.equal(loaded.createdBySessionId, 's1')
    assert.equal(loaded.status, 'open')
    assert.deepEqual(loaded.policy, basePolicy())
    assert.deepEqual(loaded.metadata, { topic: 'audit', tags: ['p0'] })
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SessionChannelRepository getSessionChannel returns null for unknown channelId', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    const loaded = await storage.getSessionChannel('channel_does_not_exist')
    assert.equal(loaded, null)
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SessionChannelRepository listSessionChannels filters by participant sessionId', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    await storage.saveSessionChannel(makeChannel({
      channelId: 'channel_ab',
      participantSessionIds: ['s_a', 's_b'],
      createdAt: '2026-06-20T00:00:01.000Z',
    }))
    await storage.saveSessionChannel(makeChannel({
      channelId: 'channel_bc',
      participantSessionIds: ['s_b', 's_c'],
      createdAt: '2026-06-20T00:00:02.000Z',
    }))
    await storage.saveSessionChannel(makeChannel({
      channelId: 'channel_cd',
      participantSessionIds: ['s_c', 's_d'],
      createdAt: '2026-06-20T00:00:03.000Z',
    }))

    const allChannels = await storage.listSessionChannels()
    assert.equal(allChannels.length, 3)

    const sBChannels = await storage.listSessionChannels({ sessionId: 's_b' })
    assert.equal(sBChannels.length, 2)
    assert.deepEqual(sBChannels.map(c => c.channelId).sort(), ['channel_ab', 'channel_bc'])

    const sZChannels = await storage.listSessionChannels({ sessionId: 's_z' })
    assert.equal(sZChannels.length, 0)
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SessionChannelRepository saveSessionMessage + getSessionMessage round-trip with evidence and metadata', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    await storage.saveSessionChannel(makeChannel({ channelId: 'channel_msg' }))
    const message = makeMessage({
      messageId: 'msg_roundtrip',
      channelId: 'channel_msg',
      fromSessionId: 'session_a',
      toSessionId: 'session_b',
      broadcast: false,
      type: 'finding',
      content: 'I found a bug',
      priority: 'high',
      evidence: [{ type: 'session_event', ref: 'evt_42', label: 'compact' }],
      metadata: { severity: 'p0' },
    })
    await storage.saveSessionMessage(message)
    const loaded = await storage.getSessionMessage('msg_roundtrip')
    assert.ok(loaded)
    assert.equal(loaded.messageId, 'msg_roundtrip')
    assert.equal(loaded.fromSessionId, 'session_a')
    assert.equal(loaded.toSessionId, 'session_b')
    assert.equal(loaded.broadcast, false)
    assert.equal(loaded.type, 'finding')
    assert.equal(loaded.priority, 'high')
    assert.deepEqual(loaded.evidence, [{ type: 'session_event', ref: 'evt_42', label: 'compact' }])
    assert.deepEqual(loaded.metadata, { severity: 'p0' })
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SessionChannelRepository listSessionMessages cursor pagination round-trips full set', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    await storage.saveSessionChannel(makeChannel({ channelId: 'channel_paginate' }))
    for (let i = 0; i < 5; i++) {
      await storage.saveSessionMessage(makeMessage({
        messageId: `msg_${i}`,
        channelId: 'channel_paginate',
        createdAt: `2026-06-20T00:00:0${i + 1}.000Z`,
      }))
    }

    const first = await storage.listSessionMessages('channel_paginate', { limit: 2, order: 'asc' })
    assert.equal(first.messages.length, 2)
    assert.equal(first.messages[0].messageId, 'msg_0')
    assert.equal(first.messages[1].messageId, 'msg_1')
    assert.equal(first.nextCursor, '2')

    const second = await storage.listSessionMessages('channel_paginate', { limit: 2, order: 'asc', cursor: first.nextCursor })
    assert.equal(second.messages.length, 2)
    assert.equal(second.messages[0].messageId, 'msg_2')
    assert.equal(second.messages[1].messageId, 'msg_3')
    assert.equal(second.nextCursor, '4')

    const third = await storage.listSessionMessages('channel_paginate', { limit: 2, order: 'asc', cursor: second.nextCursor })
    assert.equal(third.messages.length, 1)
    assert.equal(third.messages[0].messageId, 'msg_4')
    assert.equal(third.nextCursor, undefined)
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SessionChannelRepository listSessionInbox filters direct + broadcast for participant only', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    // session_b participates
    await storage.saveSessionChannel(makeChannel({
      channelId: 'channel_ab',
      participantSessionIds: ['session_a', 'session_b'],
    }))
    // session_b does NOT participate
    await storage.saveSessionChannel(makeChannel({
      channelId: 'channel_cd',
      participantSessionIds: ['session_c', 'session_d'],
    }))

    // direct to session_b — should appear
    await storage.saveSessionMessage(makeMessage({
      messageId: 'msg_direct',
      channelId: 'channel_ab',
      fromSessionId: 'session_a',
      toSessionId: 'session_b',
      content: 'hi b',
      createdAt: '2026-06-20T00:00:01.000Z',
    }))
    // broadcast on channel session_b participates — should appear
    await storage.saveSessionMessage(makeMessage({
      messageId: 'msg_broadcast',
      channelId: 'channel_ab',
      fromSessionId: 'session_a',
      broadcast: true,
      content: 'announce',
      createdAt: '2026-06-20T00:00:02.000Z',
    }))
    // sent BY session_b — should be filtered out
    await storage.saveSessionMessage(makeMessage({
      messageId: 'msg_self',
      channelId: 'channel_ab',
      fromSessionId: 'session_b',
      toSessionId: 'session_a',
      content: 'sent by me',
      createdAt: '2026-06-20T00:00:03.000Z',
    }))
    // on channel session_b does NOT participate — should be filtered out
    await storage.saveSessionMessage(makeMessage({
      messageId: 'msg_outside',
      channelId: 'channel_cd',
      fromSessionId: 'session_c',
      toSessionId: 'session_d',
      content: 'outside',
      createdAt: '2026-06-20T00:00:04.000Z',
    }))
    // direct to a different participant (session_a) — should be filtered out
    await storage.saveSessionMessage(makeMessage({
      messageId: 'msg_other_direct',
      channelId: 'channel_ab',
      fromSessionId: 'session_a',
      toSessionId: 'session_a', // same-participant edge case (shouldn't see)
      content: 'self-direct',
      createdAt: '2026-06-20T00:00:05.000Z',
    }))

    const inbox = await storage.listSessionInbox('session_b')
    const ids = inbox.map(m => m.messageId).sort()
    assert.deepEqual(ids, ['msg_broadcast', 'msg_direct'])
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SessionChannelRepository listSessionInbox excludes acknowledged messages by default', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    await storage.saveSessionChannel(makeChannel({
      channelId: 'channel_ack',
      participantSessionIds: ['session_a', 'session_b'],
    }))
    await storage.saveSessionMessage(makeMessage({
      messageId: 'msg_unread',
      channelId: 'channel_ack',
      fromSessionId: 'session_a',
      toSessionId: 'session_b',
      content: 'unread',
      createdAt: '2026-06-20T00:00:01.000Z',
    }))
    await storage.saveSessionMessage(makeMessage({
      messageId: 'msg_acked',
      channelId: 'channel_ack',
      fromSessionId: 'session_a',
      toSessionId: 'session_b',
      content: 'acked',
      createdAt: '2026-06-20T00:00:02.000Z',
      acknowledgedAt: '2026-06-20T00:00:03.000Z',
      status: 'acknowledged',
    }))

    const inboxDefault = await storage.listSessionInbox('session_b')
    assert.equal(inboxDefault.length, 1)
    assert.equal(inboxDefault[0].messageId, 'msg_unread')

    const inboxAll = await storage.listSessionInbox('session_b', { includeAcknowledged: true })
    assert.equal(inboxAll.length, 2)
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SessionChannelRepository acknowledgeSessionMessage sets acknowledgedAt + status acknowledged', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    await storage.saveSessionChannel(makeChannel({ channelId: 'channel_ack_msg' }))
    await storage.saveSessionMessage(makeMessage({
      messageId: 'msg_to_ack',
      channelId: 'channel_ack_msg',
      status: 'delivered',
      deliveredAt: '2026-06-20T00:00:02.500Z',
    }))

    const acked = await storage.acknowledgeSessionMessage('msg_to_ack', '2026-06-20T00:00:05.000Z')
    assert.ok(acked)
    assert.equal(acked.acknowledgedAt, '2026-06-20T00:00:05.000Z')
    assert.equal(acked.status, 'acknowledged')
    // delivered_at preserved
    assert.equal(acked.deliveredAt, '2026-06-20T00:00:02.500Z')

    const reloaded = await storage.getSessionMessage('msg_to_ack')
    assert.ok(reloaded)
    assert.equal(reloaded.acknowledgedAt, '2026-06-20T00:00:05.000Z')
    assert.equal(reloaded.status, 'acknowledged')
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SessionChannelRepository acknowledgeSessionMessage returns null for unknown messageId', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    const result = await storage.acknowledgeSessionMessage('msg_does_not_exist', '2026-06-20T00:00:05.000Z')
    assert.equal(result, null)
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
