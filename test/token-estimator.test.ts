import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  estimateContextTokens,
  estimateTextTokens,
  estimateTokensConservative,
  getContextWindowState,
} from '../src/runtime/tokenEstimator.js'

test('estimateTextTokens is conservative for CJK compared with chars/4', () => {
  const chinese = '你好，帮我继续分析这个项目的上下文管理能力。'.repeat(100)
  const legacyEstimate = Math.ceil(chinese.length / 4)
  const estimate = estimateTextTokens(chinese)

  assert.ok(estimate > legacyEstimate * 2, 'CJK estimate should be materially higher than chars/4')
})

test('estimateTokensConservative applies a bounded provider deviation buffer', () => {
  assert.equal(estimateTokensConservative(1000), 1250)
  assert.equal(estimateTokensConservative(1000, 20), 1200)
  assert.equal(estimateTokensConservative(1000, 30), 1300)
  assert.equal(estimateTokensConservative(1000, 5), 1200)
  assert.equal(estimateTokensConservative(1000, 50), 1300)
  assert.equal(estimateTokensConservative(-1), 0)
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

test('estimates 50K provider tool schemas with provider wrapper overhead', () => {
  const properties = Object.fromEntries(
    Array.from({ length: 520 }, (_, index) => [
      `field_${index}`,
      {
        type: 'string',
        description: `Provider schema calibration field ${index} `.repeat(3),
        enum: ['alpha', 'beta', 'gamma', `value-${index}`],
      },
    ]),
  )
  const inputSchema = {
    type: 'object',
    additionalProperties: false,
    properties,
    required: Object.keys(properties).slice(0, 200),
  }
  const schemaJsonLength = JSON.stringify(inputSchema).length
  const estimate = estimateContextTokens({
    messages: [],
    tools: [
      {
        name: 'CalibrateSchema',
        description: 'Large provider tool schema fixture.',
        inputSchema,
      },
    ],
  })

  assert.ok(schemaJsonLength >= 50_000)
  assert.ok(estimate.toolDefinitionTokens >= 500 + 128 + Math.ceil(schemaJsonLength / 3))
  assert.equal(estimate.totalTokens, estimate.toolDefinitionTokens)
})

test('estimateTextTokens handles 10K CJK fixture without chars/4 undercount', () => {
  const chinese = '界'.repeat(10_000)
  const estimate = estimateTextTokens(chinese)

  assert.equal(estimate, Math.ceil(chinese.length / 1.35))
  assert.ok(estimate > Math.ceil(chinese.length / 4) * 2)
})

test('estimates long tool results with dense output calibration', () => {
  const content = 'tool output line with compact diagnostics\n'.repeat(800)
  const estimate = estimateContextTokens({
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'tool-long',
            content,
          },
        ],
      },
    ],
  })

  assert.equal(estimate.messageTokens, 4 + 18 + Math.ceil(content.length / 2))
})

test('estimates DeepSeek reasoning replay separately from visible content', () => {
  const reasoningContent = 'DeepSeek reasoning replay '.repeat(1200)
  const estimate = estimateContextTokens({
    messages: [
      {
        role: 'assistant',
        content: 'final answer',
        reasoningContent,
      },
    ],
  })

  assert.equal(
    estimate.messageTokens,
    4 + estimateTextTokens('final answer') + 12 + Math.ceil(reasoningContent.length / 3),
  )
})

test('conservative calibrated estimates feed context window blocking state', () => {
  const base = estimateContextTokens({
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'tool-blocking',
            content: 'blocking calibration output\n'.repeat(600),
          },
        ],
      },
    ],
  })
  const conservative = estimateContextTokens({
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'tool-blocking',
            content: 'blocking calibration output\n'.repeat(600),
          },
        ],
      },
    ],
    conservative: true,
  })
  const window = getContextWindowState({
    tokenEstimate: conservative.totalTokens,
    maxTokens: base.totalTokens + 50,
    warningPercent: 70,
    compactPercent: 85,
    blockingBufferTokens: 100,
  })

  assert.equal(conservative.baseTotalTokens, base.totalTokens)
  assert.ok(conservative.totalTokens > base.totalTokens)
  assert.equal(window.isWarning, true)
  assert.equal(window.isCompact, true)
  assert.equal(window.isBlocking, true)
})

test('estimateContextTokens conservative mode keeps component totals and buffers the total', () => {
  const messages = [
    {
      role: 'user' as const,
      content: '请分析上下文窗口风险和 compact 触发边界。'.repeat(500),
    },
    {
      role: 'assistant' as const,
      content: [
        {
          type: 'tool_result' as const,
          toolUseId: 'tool-1',
          content: JSON.stringify({
            diagnostics: Array.from({ length: 80 }, (_, index) => ({
              file: `src/runtime/example-${index}.ts`,
              message: `中文诊断 ${index}: 工具输出较长，需要保守估算 token。`,
            })),
          }),
        },
      ],
      reasoningContent: 'DeepSeek reasoning replay '.repeat(1400),
    },
  ]
  const tools = [
    {
      name: 'Read',
      description: 'Read a file from disk and return its contents.',
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(
          Array.from({ length: 50 }, (_, index) => [
            `field${index}`,
            { type: 'string', description: `schema field ${index}` },
          ]),
        ),
      },
    },
  ]

  const base = estimateContextTokens({
    systemPrompt: 'System prompt with provider tool schema overhead.',
    messages,
    tools,
  })
  const conservative = estimateContextTokens({
    systemPrompt: 'System prompt with provider tool schema overhead.',
    messages,
    tools,
    conservative: true,
  })

  assert.equal(conservative.baseTotalTokens, base.totalTokens)
  assert.equal(conservative.conservativeBufferPercent, 25)
  assert.equal(conservative.systemPromptTokens, base.systemPromptTokens)
  assert.equal(conservative.messageTokens, base.messageTokens)
  assert.equal(conservative.toolDefinitionTokens, base.toolDefinitionTokens)
  assert.equal(conservative.totalTokens, estimateTokensConservative(base.totalTokens))
  assert.ok(conservative.totalTokens >= Math.ceil(base.totalTokens * 1.2))
  assert.ok(conservative.totalTokens <= Math.ceil(base.totalTokens * 1.3))
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
