import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  estimateContextTokens,
  estimateTextTokens,
  getContextWindowState,
} from '../src/runtime/tokenEstimator.js'

test('estimateTextTokens is conservative for CJK compared with chars/4', () => {
  const chinese = '你好，帮我继续分析这个项目的上下文管理能力。'.repeat(100)
  const legacyEstimate = Math.ceil(chinese.length / 4)
  const estimate = estimateTextTokens(chinese)

  assert.ok(estimate > legacyEstimate * 2, 'CJK estimate should be materially higher than chars/4')
})

test('estimateContextTokens includes tool definition and structured block overhead', () => {
  const estimate = estimateContextTokens({
    systemPrompt: 'System prompt with instructions.',
    messages: [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'Write',
            input: { path: 'src/example.ts', content: 'export const value = 1' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'tool-1',
            content: JSON.stringify({ ok: true, diagnostics: 'x'.repeat(1000) }),
          },
        ],
      },
    ],
    tools: [
      {
        name: 'Write',
        description: 'Write a file',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['path', 'content'],
        },
      },
    ],
  })

  assert.ok(estimate.systemPromptTokens > 0)
  assert.ok(estimate.messageTokens > 0)
  assert.ok(estimate.toolDefinitionTokens >= 500)
  assert.equal(
    estimate.totalTokens,
    estimate.systemPromptTokens + estimate.messageTokens + estimate.toolDefinitionTokens,
  )
})

test('getContextWindowState exposes warning, compact and blocking thresholds', () => {
  const normal = getContextWindowState({
    tokenEstimate: 500,
    maxTokens: 1000,
    warningPercent: 70,
    compactPercent: 85,
    blockingBufferTokens: 100,
  })
  assert.equal(normal.isWarning, false)
  assert.equal(normal.isCompact, false)
  assert.equal(normal.isBlocking, false)

  const warning = getContextWindowState({
    tokenEstimate: 750,
    maxTokens: 1000,
    warningPercent: 70,
    compactPercent: 85,
    blockingBufferTokens: 100,
  })
  assert.equal(warning.isWarning, true)
  assert.equal(warning.isCompact, false)
  assert.equal(warning.isBlocking, false)
  assert.equal(warning.warningThresholdTokens, 700)
  assert.equal(warning.compactThresholdTokens, 850)

  const compact = getContextWindowState({
    tokenEstimate: 870,
    maxTokens: 1000,
    warningPercent: 70,
    compactPercent: 85,
    blockingBufferTokens: 100,
  })
  assert.equal(compact.isWarning, true)
  assert.equal(compact.isCompact, true)
  assert.equal(compact.isBlocking, false)

  const blocking = getContextWindowState({
    tokenEstimate: 950,
    maxTokens: 1000,
    warningPercent: 70,
    compactPercent: 85,
    blockingBufferTokens: 100,
  })
  assert.equal(blocking.isWarning, true)
  assert.equal(blocking.isCompact, true)
  assert.equal(blocking.isBlocking, true)
})
