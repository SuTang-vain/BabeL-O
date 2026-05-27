import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  queryModelText,
  buildCompactUserPrompt,
  formatCompactSummary,
  COMPACT_MAX_OUTPUT_TOKENS,
} from '../src/runtime/compactSummary.js'
import type { ModelAdapter, ModelQueryParams, StreamDelta } from '../src/providers/adapters/ModelAdapter.js'

function createMockAdapter(deltas: StreamDelta[]): ModelAdapter {
  return {
    async *queryStream(_params: ModelQueryParams) {
      for (const delta of deltas) {
        yield delta
      }
    },
  }
}

function createErrorAdapter(error: Error): ModelAdapter {
  return {
    async *queryStream() {
      throw error
    },
  }
}

describe('queryModelText', () => {
  test('collects text deltas from adapter', async () => {
    const adapter = createMockAdapter([
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'World' },
      { type: 'usage', inputTokens: 10, outputTokens: 5 },
    ])
    const result = await queryModelText(adapter, {
      model: 'test',
      messages: [{ role: 'user', content: 'hi' }],
    })
    assert.equal(result, 'Hello World')
  })

  test('propagates adapter errors', async () => {
    const adapter = createErrorAdapter(new Error('API timeout'))
    await assert.rejects(
      () => queryModelText(adapter, {
        model: 'test',
        messages: [{ role: 'user', content: 'hi' }],
      }),
      { message: 'API timeout' },
    )
  })

  test('ignores non-text deltas', async () => {
    const adapter = createMockAdapter([
      { type: 'thinking', text: 'internal reasoning' },
      { type: 'text', text: 'visible' },
      { type: 'usage', inputTokens: 5, outputTokens: 1 },
    ])
    const result = await queryModelText(adapter, {
      model: 'test',
      messages: [{ role: 'user', content: 'hi' }],
    })
    assert.equal(result, 'visible')
  })
})

describe('buildCompactUserPrompt', () => {
  const prompt = buildCompactUserPrompt()

  test('contains all 9 section names', () => {
    const sections = [
      'Primary Request and Intent',
      'Key Technical Concepts',
      'Files and Code Sections',
      'Errors and fixes',
      'Problem Solving',
      'All user messages',
      'Pending Tasks',
      'Current Work',
      'Optional Next Step',
    ]
    for (const section of sections) {
      assert.ok(prompt.includes(section), `Missing section: ${section}`)
    }
  })

  test('contains analysis and summary tag instructions', () => {
    assert.ok(prompt.includes('<analysis>'))
    assert.ok(prompt.includes('</analysis>'))
    assert.ok(prompt.includes('<summary>'))
    assert.ok(prompt.includes('</summary>'))
  })
})

describe('formatCompactSummary', () => {
  test('strips analysis and extracts summary', () => {
    const input = '<analysis>thinking through the conversation...</analysis>\n<summary>\n1. Primary Request:\n  The user wanted X.\n</summary>'
    const result = formatCompactSummary(input)
    assert.ok(!result.includes('<analysis>'))
    assert.ok(!result.includes('thinking through'))
    assert.ok(result.startsWith('Summary:'))
    assert.ok(result.includes('Primary Request:'))
    assert.ok(result.includes('The user wanted X.'))
  })

  test('handles missing summary tags (passthrough)', () => {
    const input = 'Some plain text without tags'
    const result = formatCompactSummary(input)
    assert.equal(result, 'Some plain text without tags')
  })

  test('collapses excessive blank lines', () => {
    const input = 'Line 1\n\n\n\n\nLine 2'
    const result = formatCompactSummary(input)
    assert.ok(!result.includes('\n\n\n'), `Expected max 2 consecutive newlines, got: ${JSON.stringify(result)}`)
  })

  test('handles analysis only without summary tags', () => {
    const input = '<analysis>Just thinking</analysis>\nPlain text after analysis.'
    const result = formatCompactSummary(input)
    assert.ok(!result.includes('<analysis>'))
    assert.ok(result.includes('Plain text after analysis.'))
  })
})

describe('COMPACT_MAX_OUTPUT_TOKENS', () => {
  test('is 16384', () => {
    assert.equal(COMPACT_MAX_OUTPUT_TOKENS, 16384)
  })
})
