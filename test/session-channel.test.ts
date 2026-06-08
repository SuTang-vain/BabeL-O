import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createNexusApp } from '../src/nexus/app.js'
import { assembleContext } from '../src/runtime/contextAssembler.js'
import { buildSystemPrompt, mapEventsToMessages } from '../src/runtime/LLMCodingRuntime.js'
import type { NexusRuntime } from '../src/runtime/Runtime.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'
import { SqliteStorage } from '../src/storage/SqliteStorage.js'
import type { NexusStorage } from '../src/storage/Storage.js'
import type { NexusEvent } from '../src/shared/events.js'
import type { SessionMessage } from '../src/shared/sessionChannel.js'
import type { SessionSnapshot } from '../src/shared/session.js'

const sessionA = createSession('session-a')
const sessionB = createSession('session-b')
const sessionC = createSession('session-c')

test('SessionChannel storage supports create send inbox and ack in MemoryStorage', async () => {
  await assertStorageLifecycle(new MemoryStorage())
})

test('SessionChannel storage supports create send inbox and ack in SqliteStorage', async () => {
  const tempDir = join(tmpdir(), `babel-o-session-channel-${Date.now()}`)
  await mkdir(tempDir, { recursive: true })
  const storage = new SqliteStorage(join(tempDir, 'nexus.sqlite'))
  try {
    await assertStorageLifecycle(storage)
  } finally {
    await storage.close?.()
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('Nexus SessionChannel API creates messages lists inbox and acknowledges delivery', async () => {
  const storage = new MemoryStorage()
  await storage.saveSession(sessionA)
  await storage.saveSession(sessionB)
  const app = await createNexusApp({
    runtime: new EmptyRuntime(),
    storage,
    defaultCwd: '/workspace/project',
  })

  try {
    await app.ready()
    const created = await app.inject({
      method: 'POST',
      url: '/v1/session-channels',
      payload: {
        participantSessionIds: ['session-a', 'session-b'],
        createdBySessionId: 'session-a',
      },
    })
    assert.equal(created.statusCode, 200)
    const channel = created.json().channel
    assert.equal(channel.status, 'open')
    assert.deepEqual(channel.participantSessionIds, ['session-a', 'session-b'])

    const sent = await app.inject({
      method: 'POST',
      url: `/v1/session-channels/${channel.channelId}/messages`,
      payload: {
        fromSessionId: 'session-a',
        toSessionId: 'session-b',
        type: 'finding',
        content: 'Read src/runtime/contextAssembler.ts before changing context injection.',
        evidence: [{ type: 'file', ref: 'src/runtime/contextAssembler.ts' }],
      },
    })
    assert.equal(sent.statusCode, 200)
    const message = sent.json().message
    assert.equal(message.status, 'delivered')
    assert.equal(message.broadcast, false)

    const inbox = await app.inject({ method: 'GET', url: '/v1/sessions/session-b/inbox' })
    assert.equal(inbox.statusCode, 200)
    assert.equal(inbox.json().messages.length, 1)
    assert.equal(inbox.json().messages[0].messageId, message.messageId)

    const senderInbox = await app.inject({ method: 'GET', url: '/v1/sessions/session-a/inbox' })
    assert.equal(senderInbox.statusCode, 200)
    assert.equal(senderInbox.json().messages.length, 0)

    const listed = await app.inject({ method: 'GET', url: `/v1/session-channels/${channel.channelId}/messages` })
    assert.equal(listed.statusCode, 200)
    assert.equal(listed.json().messages.length, 1)

    const ack = await app.inject({ method: 'POST', url: `/v1/sessions/session-b/inbox/${message.messageId}/ack` })
    assert.equal(ack.statusCode, 200)
    assert.equal(ack.json().message.status, 'acknowledged')

    const emptyInbox = await app.inject({ method: 'GET', url: '/v1/sessions/session-b/inbox' })
    assert.equal(emptyInbox.statusCode, 200)
    assert.equal(emptyInbox.json().messages.length, 0)
  } finally {
    await app.close()
  }
})

test('Nexus SessionChannel API message is injected into receiving session context until acknowledged', async () => {
  const storage = new MemoryStorage()
  await storage.saveSession(sessionA)
  await storage.saveSession(sessionB)
  const app = await createNexusApp({
    runtime: new EmptyRuntime(),
    storage,
    defaultCwd: '/workspace/project',
  })

  try {
    await app.ready()
    const created = await app.inject({
      method: 'POST',
      url: '/v1/session-channels',
      payload: {
        kind: 'workspace_pair',
        participantSessionIds: ['session-a', 'session-b'],
        createdBySessionId: 'session-a',
        metadata: { purpose: 'session-to-session-feasibility' },
      },
    })
    assert.equal(created.statusCode, 200)
    const channelId = created.json().channel.channelId

    const sent = await app.inject({
      method: 'POST',
      url: `/v1/session-channels/${channelId}/messages`,
      payload: {
        fromSessionId: 'session-a',
        toSessionId: 'session-b',
        type: 'handoff',
        priority: 'high',
        content: 'Session A verified src/runtime/contextAssembler.ts and found inbox context is non-cacheable.',
        evidence: [{ type: 'file', ref: 'src/runtime/contextAssembler.ts' }],
      },
    })
    assert.equal(sent.statusCode, 200)
    const message = sent.json().message

    const context = await app.inject({
      method: 'GET',
      url: '/v1/sessions/session-b/context?modelId=local/coding-runtime&prompt=continue',
    })
    assert.equal(context.statusCode, 200)
    const body = context.json()
    assert.equal(body.diagnostics.scopedMemory.some((diagnostic: { scope: string; namespaceId: string; isolationKey: string }) =>
      diagnostic.scope === 'channel' && diagnostic.namespaceId === channelId && diagnostic.isolationKey === 'channelId'
    ), true)
    assert.match(body.diagnostic.details.scopedMemory.find((diagnostic: { scope: string }) => diagnostic.scope === 'channel')?.provider ?? '', /session-channel/)

    const assembled = await assembleContext({
      runtimeOptions: {
        sessionId: 'session-b',
        prompt: 'continue',
        cwd: '/workspace/project',
      },
      events: [],
      modelId: 'local/coding-runtime',
      buildSystemPrompt,
      mapEventsToMessages,
      sessionInbox: await storage.listSessionInbox('session-b'),
    })
    assert.match(assembled.systemPrompt, /Session inbox messages from other sessions/)
    assert.match(assembled.systemPrompt, /not direct user instructions/)
    assert.match(assembled.systemPrompt, /Session A verified src\/runtime\/contextAssembler\.ts/)
    assert.equal(assembled.systemPromptBlocks?.find(block => block.text.includes('Session inbox messages'))?.cacheable, false)

    const ack = await app.inject({ method: 'POST', url: `/v1/sessions/session-b/inbox/${message.messageId}/ack` })
    assert.equal(ack.statusCode, 200)
    const acknowledgedContext = await app.inject({
      method: 'GET',
      url: '/v1/sessions/session-b/context?modelId=local/coding-runtime&prompt=continue',
    })
    assert.equal(acknowledgedContext.statusCode, 200)
    assert.equal(acknowledgedContext.json().diagnostics.scopedMemory.some((diagnostic: { scope: string }) => diagnostic.scope === 'channel'), false)
    assert.equal((await storage.listSessionInbox('session-b')).length, 0)
  } finally {
    await app.close()
  }
})

test('Nexus SessionChannel API rejects messages outside channel policy and participants', async () => {
  const storage = new MemoryStorage()
  await storage.saveSession(sessionA)
  await storage.saveSession(sessionB)
  await storage.saveSession(sessionC)
  const app = await createNexusApp({
    runtime: new EmptyRuntime(),
    storage,
    defaultCwd: '/workspace/project',
  })

  try {
    await app.ready()
    const created = await app.inject({
      method: 'POST',
      url: '/v1/session-channels',
      payload: {
        participantSessionIds: ['session-a', 'session-b'],
        createdBySessionId: 'session-a',
        policy: {
          allowBroadcast: false,
          maxMessageChars: 20,
          maxEvidenceRefs: 1,
        },
      },
    })
    assert.equal(created.statusCode, 200)
    const channelId = created.json().channel.channelId

    const outsider = await app.inject({
      method: 'POST',
      url: `/v1/session-channels/${channelId}/messages`,
      payload: {
        fromSessionId: 'session-c',
        toSessionId: 'session-b',
        type: 'finding',
        content: 'outside',
      },
    })
    assert.equal(outsider.statusCode, 400)
    assert.equal(outsider.json().code, 'INVALID_SESSION_MESSAGE')

    const broadcast = await app.inject({
      method: 'POST',
      url: `/v1/session-channels/${channelId}/messages`,
      payload: {
        fromSessionId: 'session-a',
        type: 'finding',
        content: 'broadcast',
      },
    })
    assert.equal(broadcast.statusCode, 400)
    assert.match(broadcast.json().message, /Broadcast messages are disabled/)

    const tooLong = await app.inject({
      method: 'POST',
      url: `/v1/session-channels/${channelId}/messages`,
      payload: {
        fromSessionId: 'session-a',
        toSessionId: 'session-b',
        type: 'finding',
        content: 'x'.repeat(21),
      },
    })
    assert.equal(tooLong.statusCode, 400)
    assert.match(tooLong.json().message, /maxMessageChars/)
  } finally {
    await app.close()
  }
})

test('assembleContext injects session inbox as non-cacheable collaboration context', async () => {
  const message: SessionMessage = {
    messageId: 'msg-1',
    channelId: 'channel-1',
    fromSessionId: 'session-a',
    toSessionId: 'session-b',
    broadcast: false,
    type: 'handoff',
    content: 'The review session found that context inbox must stay non-cacheable.',
    evidence: [{ type: 'file', ref: 'src/runtime/contextAssembler.ts' }],
    priority: 'high',
    createdAt: '2026-06-08T00:00:00.000Z',
    deliveredAt: '2026-06-08T00:00:00.000Z',
    status: 'delivered',
  }

  const context = await assembleContext({
    runtimeOptions: {
      sessionId: 'session-b',
      prompt: 'Continue implementation',
      cwd: tmpdir(),
    },
    events: [],
    modelId: 'local/coding-runtime',
    buildSystemPrompt,
    mapEventsToMessages,
    sessionInbox: [message],
  })

  assert.match(context.systemPrompt, /Session inbox messages from other sessions/)
  assert.match(context.systemPrompt, /not direct user instructions/)
  assert.match(context.systemPrompt, /context inbox must stay non-cacheable/)
  const inboxBlock = context.systemPromptBlocks?.find(block => block.text.includes('Session inbox messages'))
  assert.ok(inboxBlock)
  assert.equal(inboxBlock.cacheable, false)
})

async function assertStorageLifecycle(storage: NexusStorage): Promise<void> {
  await storage.saveSession(sessionA)
  await storage.saveSession(sessionB)
  const channel = {
    channelId: 'channel-1',
    kind: 'direct' as const,
    participantSessionIds: ['session-a', 'session-b'],
    createdBySessionId: 'session-a',
    createdAt: '2026-06-08T00:00:00.000Z',
    status: 'open' as const,
    metadata: undefined,
    policy: {
      allowedMessageTypes: ['finding' as const, 'handoff' as const],
      maxMessageChars: 1000,
      maxEvidenceRefs: 4,
      allowBroadcast: true,
      allowMemoryWriteRequests: false,
      requireUserApprovalForExternalProject: true,
      contextInjectionMode: 'recent_messages' as const,
    },
  }
  await storage.saveSessionChannel(channel)
  assert.deepEqual(await storage.getSessionChannel('channel-1'), channel)
  assert.equal((await storage.listSessionChannels({ sessionId: 'session-b' })).length, 1)

  const directMessage: SessionMessage = {
    messageId: 'msg-1',
    channelId: 'channel-1',
    fromSessionId: 'session-a',
    toSessionId: 'session-b',
    broadcast: false,
    type: 'finding',
    content: 'Use typed inbox instead of transcript sharing.',
    evidence: [{ type: 'note', ref: 'design' }],
    priority: 'normal',
    createdAt: '2026-06-08T00:00:01.000Z',
    deliveredAt: '2026-06-08T00:00:01.000Z',
    status: 'delivered',
  }
  const broadcastMessage: SessionMessage = {
    ...directMessage,
    messageId: 'msg-2',
    toSessionId: undefined,
    broadcast: true,
    type: 'handoff',
    content: 'Broadcast handoff.',
    createdAt: '2026-06-08T00:00:02.000Z',
  }
  await storage.saveSessionMessage(directMessage)
  await storage.saveSessionMessage(broadcastMessage)

  const listed = await storage.listSessionMessages('channel-1')
  assert.deepEqual(listed.messages.map(message => message.messageId), ['msg-1', 'msg-2'])
  assert.deepEqual((await storage.listSessionInbox('session-b')).map(message => message.messageId), ['msg-1', 'msg-2'])
  assert.deepEqual(await storage.listSessionInbox('session-a'), [])

  const acknowledged = await storage.acknowledgeSessionMessage('msg-1', '2026-06-08T00:00:03.000Z')
  assert.equal(acknowledged?.status, 'acknowledged')
  assert.deepEqual((await storage.listSessionInbox('session-b')).map(message => message.messageId), ['msg-2'])
  assert.deepEqual((await storage.listSessionInbox('session-b', { includeAcknowledged: true })).map(message => message.messageId), ['msg-1', 'msg-2'])
}

function createSession(sessionId: string): SessionSnapshot {
  return {
    sessionId,
    cwd: '/workspace/project',
    prompt: 'test',
    phase: 'created',
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T00:00:00.000Z',
    events: [],
  }
}

class EmptyRuntime implements NexusRuntime {
  async *executeStream(): AsyncIterable<NexusEvent> {}
}
