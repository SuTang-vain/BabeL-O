import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  getProvider,
  getModel,
  UnknownProviderError,
  UnknownModelError,
  providerRegistry,
  modelRegistry,
} from '../src/providers/registry.js'

test('getProvider returns valid provider definition', () => {
  const localProvider = getProvider('local')
  assert.equal(localProvider.id, 'local')
  assert.equal(localProvider.displayName, 'Local deterministic runtime')
  assert.equal(localProvider.adapter, 'local')
  assert.equal(localProvider.authMode, 'none')
  assert.deepEqual(localProvider.models, ['local/coding-runtime'])

  const openaiProvider = getProvider('openai')
  assert.equal(openaiProvider.id, 'openai')
  assert.equal(openaiProvider.adapter, 'openai-compatible')
  assert.equal(openaiProvider.authMode, 'bearer')
  assert.ok(openaiProvider.models.includes('openai/gpt-4o'))
})

test('getProvider throws UnknownProviderError for unknown ids', () => {
  assert.throws(() => {
    getProvider('non-existent-provider')
  }, UnknownProviderError)

  try {
    getProvider('non-existent-provider')
  } catch (error) {
    assert.ok(error instanceof Error)
    assert.equal(error.name, 'UnknownProviderError')
    assert.equal(error.message, 'Unknown provider: non-existent-provider')
  }
})

test('getModel returns valid model definition', () => {
  const localModel = getModel('local/coding-runtime')
  assert.equal(localModel.id, 'local/coding-runtime')
  assert.equal(localModel.name, 'Local Coding Runtime')
  assert.equal(localModel.contextWindow, 8192)
  assert.equal(localModel.capabilities.toolCalling, true)
  assert.equal(localModel.capabilities.jsonOutput, false)
  assert.equal(localModel.capabilities.streaming, true)

  const claudeModel = getModel('anthropic/claude-3-5-sonnet')
  assert.equal(claudeModel.id, 'anthropic/claude-3-5-sonnet')
  assert.equal(claudeModel.contextWindow, 200000)
  assert.equal(claudeModel.capabilities.toolCalling, true)
  assert.equal(claudeModel.capabilities.jsonOutput, true)
  assert.equal(claudeModel.capabilities.streaming, true)
})

test('getModel throws UnknownModelError for unknown ids', () => {
  assert.throws(() => {
    getModel('non-existent/model')
  }, UnknownModelError)

  try {
    getModel('non-existent/model')
  } catch (error) {
    assert.ok(error instanceof Error)
    assert.equal(error.name, 'UnknownModelError')
    assert.equal(error.message, 'Unknown model: non-existent/model')
  }
})

test('all models listed in providers exist in modelRegistry', () => {
  for (const provider of providerRegistry) {
    for (const modelId of provider.models) {
      const model = getModel(modelId)
      assert.ok(model)
      assert.equal(model.id, modelId)
    }
    // Verify defaultModel exists
    const defaultModel = getModel(provider.defaultModel)
    assert.ok(defaultModel)
    assert.ok(provider.models.includes(provider.defaultModel))
  }
})
