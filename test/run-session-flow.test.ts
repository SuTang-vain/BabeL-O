import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveFinalSessionOutcome } from '../src/cli/runSessionFlow.js'
import type { NexusEvent } from '../src/shared/events.js'

const schemaVersion = '2026-05-21.babel-o.v1' as const

test('resolveFinalSessionOutcome uses the newest terminal event in a descending event window', () => {
  const eventsNewestFirst: NexusEvent[] = [
    {
      type: 'execution_metrics',
      schemaVersion,
      sessionId: 'session-provider-error',
      timestamp: '2026-05-24T04:09:00.733Z',
    },
    {
      type: 'error',
      schemaVersion,
      sessionId: 'session-provider-error',
      timestamp: '2026-05-24T04:09:00.732Z',
      code: 'PROVIDER_ERROR',
      message: 'Provider openai request failed with status 402: Insufficient Balance',
    },
    ...Array.from({ length: 150 }, (_, index): NexusEvent => ({
      type: 'tool_completed',
      schemaVersion,
      sessionId: 'session-provider-error',
      timestamp: `2026-05-24T04:08:${String(index % 60).padStart(2, '0')}.000Z`,
      toolUseId: `tool-${index}`,
      name: 'Bash',
      success: true,
      output: 'ok',
    })),
    {
      type: 'result',
      schemaVersion,
      sessionId: 'session-provider-error',
      timestamp: '2026-05-24T04:04:30.417Z',
      success: true,
      message: 'Earlier successful result',
    },
  ]

  const outcome = resolveFinalSessionOutcome(eventsNewestFirst.slice(0, 100))

  assert.equal(outcome.phase, 'failed')
  assert.match(outcome.error ?? '', /Insufficient Balance/)
  assert.equal(outcome.result, undefined)
})

test('resolveFinalSessionOutcome treats latest failed result as failed', () => {
  const outcome = resolveFinalSessionOutcome([
    {
      type: 'result',
      schemaVersion,
      sessionId: 'session-failed-result',
      timestamp: '2026-05-24T04:09:00.000Z',
      success: false,
      message: 'Provider returned an empty assistant response with no tool calls.',
    },
  ])

  assert.equal(outcome.phase, 'failed')
  assert.match(outcome.result ?? '', /empty assistant response/)
})
