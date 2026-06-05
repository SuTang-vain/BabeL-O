import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computePrefixCacheDiagnostics,
  fingerprintImmutablePrefix,
  hasVolatileContentLast,
} from '../src/runtime/prefixCache.js'
import type { ModelToolDefinition, SystemPromptBlock } from '../src/providers/adapters/ModelAdapter.js'

const tools: ModelToolDefinition[] = [
  { name: 'Read', description: 'Read files', inputSchema: {} },
  { name: 'Grep', description: 'Search files', inputSchema: {} },
]

test('prefix cache fingerprint is stable for sorted tool names and volatile suffix changes', () => {
  const blocks: SystemPromptBlock[] = [
    { text: 'identity', cacheable: true },
    { text: 'system rules', cacheable: true },
    { text: 'Working Set: src/a.ts', cacheable: false },
  ]
  const reorderedTools = [...tools].reverse()
  const changedVolatileBlocks: SystemPromptBlock[] = [
    blocks[0]!,
    blocks[1]!,
    { text: 'Working Set: src/b.ts', cacheable: false },
  ]

  assert.equal(
    fingerprintImmutablePrefix(blocks, tools),
    fingerprintImmutablePrefix(changedVolatileBlocks, reorderedTools),
  )
})

test('prefix cache fingerprint changes when immutable prefix or tool names change', () => {
  const blocks: SystemPromptBlock[] = [
    { text: 'identity', cacheable: true },
    { text: 'system rules', cacheable: true },
  ]

  assert.notEqual(
    fingerprintImmutablePrefix(blocks, tools),
    fingerprintImmutablePrefix([{ text: 'identity v2', cacheable: true }, blocks[1]!], tools),
  )
  assert.notEqual(
    fingerprintImmutablePrefix(blocks, tools),
    fingerprintImmutablePrefix(blocks, [...tools, { name: 'Glob', description: 'Find paths', inputSchema: {} }]),
  )
})

test('prefix cache diagnostics report immutable prefix ratio and volatile-content-last invariant', () => {
  const blocks: SystemPromptBlock[] = [
    { text: 'aaaa', cacheable: true },
    { text: 'bbbb', cacheable: true },
    { text: 'cc', cacheable: false },
  ]

  const diagnostics = computePrefixCacheDiagnostics({ systemPromptBlocks: blocks, tools })

  assert.equal(diagnostics.immutablePrefixChars, 8)
  assert.equal(diagnostics.totalSystemPromptChars, 10)
  assert.equal(diagnostics.immutablePrefixRatio, 0.8)
  assert.equal(diagnostics.volatileContentLast, true)
  assert.equal(hasVolatileContentLast(blocks), true)
  assert.equal(hasVolatileContentLast([blocks[0]!, blocks[2]!, blocks[1]!]), false)
})
