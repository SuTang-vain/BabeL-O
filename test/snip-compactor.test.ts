import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { snipEvents, snipEventsWithTurnBoundary } from '../src/runtime/compactors/snipCompactor.js'

function makeToolCompleted(output: string): any {
  return {
    type: 'tool_completed',
    sessionId: 'test',
    timestamp: new Date().toISOString(),
    toolUseId: 'tool-1',
    name: 'Read',
    success: true,
    output,
  }
}

function makeUserMessage(text: string): any {
  return {
    type: 'user_message',
    sessionId: 'test',
    timestamp: new Date().toISOString(),
    text,
  }
}

describe('snipEventsWithTurnBoundary', () => {
  test('applies larger limit to current turn, smaller to prior turn', () => {
    const longOutput = 'x'.repeat(5000)
    const events = [
      makeToolCompleted(longOutput),
      makeUserMessage('new request'),
      makeToolCompleted(longOutput),
    ]

    const result = snipEventsWithTurnBoundary(events, 5000, 500)

    const priorSnipped = result[0] as any
    assert.ok(priorSnipped.truncated, 'Prior turn tool output should be truncated')
    assert.ok(
      (priorSnipped.output as string).length < 800,
      `Prior turn output too long: ${(priorSnipped.output as string).length}`,
    )

    const currentSnipped = result[2] as any
    assert.ok(!currentSnipped.truncated, 'Current turn tool output should not be truncated with 5000 limit')
  })

  test('falls back to uniform snipping when priorTurnMaxChars <= 0', () => {
    const events = [makeToolCompleted('short')]
    const result = snipEventsWithTurnBoundary(events, 3000, 0)
    assert.equal(result.length, 1)
  })

  test('non-tool_completed events pass through unchanged', () => {
    const events = [makeUserMessage('hello')]
    const result = snipEventsWithTurnBoundary(events, 3000, 500)
    assert.equal(result[0], events[0])
  })
})

describe('snipEvents', () => {
  test('truncates long tool output', () => {
    const longOutput = 'a'.repeat(10000)
    const events = [makeToolCompleted(longOutput)]
    const result = snipEvents(events, 1000)
    const snipped = result[0] as any
    assert.ok(snipped.truncated)
    assert.ok((snipped.output as string).includes('truncated'))
  })

  test('keeps short tool output unchanged', () => {
    const events = [makeToolCompleted('short output')]
    const result = snipEvents(events, 1000)
    assert.equal(result[0], events[0])
  })
})
