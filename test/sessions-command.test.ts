import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Command } from 'commander'
import { formatSessionAck, formatSessionInbox, registerSessionsCommand } from '../src/cli/commands/sessions.js'
import type { SessionMessage } from '../src/shared/sessionChannel.js'

test('sessions command registers inbox and ack subcommands', () => {
  const program = new Command()
  registerSessionsCommand(program)

  const sessions = program.commands.find(command => command.name() === 'sessions')
  assert.ok(sessions)
  assert.ok(sessions.commands.find(command => command.name() === 'inbox'))
  assert.ok(sessions.commands.find(command => command.name() === 'ack'))
})

test('formatSessionInbox renders collaboration context and evidence refs', () => {
  const output = formatSessionInbox({
    type: 'session_inbox',
    sessionId: 'session-b',
    limit: 20,
    includeAcknowledged: false,
    messages: [createMessage()],
  })

  assert.match(output, /Session Inbox: session-b/)
  assert.match(output, /Collaboration context only/)
  assert.match(output, /msg-1/)
  assert.match(output, /handoff/)
  assert.match(output, /from=session-a/)
  assert.match(output, /channel=channel-1/)
  assert.match(output, /Read src\/runtime\/contextAssembler.ts before editing context injection\./)
  assert.match(output, /file:src\/runtime\/contextAssembler.ts/)
  assert.match(output, /\/inbox ack <messageId>/)
  assert.match(output, /bbl sessions ack session-b <messageId>/)
})

test('formatSessionInbox renders empty unread inbox state', () => {
  const output = formatSessionInbox({
    type: 'session_inbox',
    sessionId: 'session-b',
    limit: 20,
    includeAcknowledged: false,
    messages: [],
  })

  assert.match(output, /No unread inbox messages\./)
})

test('formatSessionAck renders acknowledged message status', () => {
  const output = formatSessionAck({
    type: 'session_message_acknowledged',
    sessionId: 'session-b',
    message: {
      ...createMessage(),
      status: 'acknowledged',
      acknowledgedAt: '2026-06-08T00:00:02.000Z',
    },
  })

  assert.match(output, /Acknowledged msg-1 for session session-b\./)
  assert.match(output, /acknowledged/)
})

function createMessage(): SessionMessage {
  return {
    messageId: 'msg-1',
    channelId: 'channel-1',
    fromSessionId: 'session-a',
    toSessionId: 'session-b',
    broadcast: false,
    type: 'handoff',
    content: 'Read src/runtime/contextAssembler.ts before editing context injection.',
    evidence: [{ type: 'file', ref: 'src/runtime/contextAssembler.ts' }],
    priority: 'high',
    createdAt: '2026-06-08T00:00:00.000Z',
    deliveredAt: '2026-06-08T00:00:01.000Z',
    status: 'delivered',
  }
}
