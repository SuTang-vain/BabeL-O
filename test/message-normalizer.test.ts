import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeMessages } from '../src/runtime/messageNormalizer.js'
import type { ModelMessage } from '../src/providers/adapters/ModelAdapter.js'

describe('normalizeMessages', () => {
  test('passes through normal messages unchanged', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ]
    const result = normalizeMessages(messages)
    assert.equal(result.length, 2)
    assert.equal(result[0].role, 'user')
    assert.equal(result[1].role, 'assistant')
  })

  test('adds synthetic tool_result for orphaned tool_use', () => {
    const messages: ModelMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: '/tmp/test' } },
        ],
      },
    ]
    const result = normalizeMessages(messages)
    // Prepends user message since first is assistant, plus synthetic tool_result
    assert.equal(result.length, 3)
    assert.equal(result[0].role, 'user')
    assert.equal(result[1].role, 'assistant')
    const synthMsg = result[2]
    assert.equal(synthMsg.role, 'user')
    if (typeof synthMsg.content === 'object') {
      const block = synthMsg.content[0]
      assert.equal(block.type, 'tool_result')
      if (block.type === 'tool_result') {
        assert.equal(block.toolUseId, 'tool-1')
        assert.equal(block.isError, true)
      }
    }
  })

  test('removes orphaned tool_result with no matching tool_use', () => {
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'missing-id', content: 'some result' },
          { type: 'text', text: 'Continue please' },
        ],
      },
    ]
    const result = normalizeMessages(messages)
    assert.equal(result.length, 1)
    if (typeof result[0].content === 'object') {
      assert.equal(result[0].content.length, 1)
      assert.equal(result[0].content[0].type, 'text')
    }
  })

  test('keeps paired tool_use and tool_result', () => {
    const messages: ModelMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool-2', name: 'Bash', input: { command: 'ls' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'tool-2', content: 'file1.txt\nfile2.txt' },
        ],
      },
    ]
    const result = normalizeMessages(messages)
    // Prepends user message since first is assistant
    assert.equal(result.length, 3)
    assert.equal(result[0].role, 'user')
    assert.equal(result[1].role, 'assistant')
    assert.equal(result[2].role, 'user')
  })

  test('prepends user message when first message is assistant', () => {
    const messages: ModelMessage[] = [
      { role: 'assistant', content: 'I can help with that.' },
    ]
    const result = normalizeMessages(messages)
    assert.equal(result.length, 2)
    assert.equal(result[0].role, 'user')
  })

  test('handles mixed orphaned and paired blocks', () => {
    const messages: ModelMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'paired', name: 'Read', input: { path: '/a' } },
          { type: 'tool_use', id: 'orphaned', name: 'Bash', input: { command: 'ls' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'paired', content: 'file content' },
          { type: 'tool_result', toolUseId: 'ghost', content: 'ghost result' },
        ],
      },
    ]
    const result = normalizeMessages(messages)
    // result[0] = prepended user (first was assistant)
    // result[1] = assistant (both tool_use blocks kept)
    // result[2] = user (paired tool_result kept, ghost removed)
    // result[3] = synthetic user (orphaned tool_use gets synthetic error result)
    assert.equal(result.length, 4)
    assert.equal(result[0].role, 'user')

    const assistantContent = typeof result[1].content === 'object' ? result[1].content : []
    assert.equal(assistantContent.length, 2)

    const userContent = typeof result[2].content === 'object' ? result[2].content : []
    assert.equal(userContent.length, 1)
    assert.equal(userContent[0].type, 'tool_result')
    if (userContent[0].type === 'tool_result') {
      assert.equal(userContent[0].toolUseId, 'paired')
    }

    const synthBlock = typeof result[3].content === 'object' ? result[3].content : []
    assert.equal(synthBlock.length, 1)
    assert.equal(synthBlock[0].type, 'tool_result')
    if (synthBlock[0].type === 'tool_result') {
      assert.equal(synthBlock[0].toolUseId, 'orphaned')
      assert.equal(synthBlock[0].isError, true)
    }
  })
})
