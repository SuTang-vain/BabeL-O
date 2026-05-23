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

  const zhipuProvider = getProvider('zhipu')
  assert.equal(zhipuProvider.id, 'zhipu')
  assert.equal(zhipuProvider.adapter, 'anthropic-compatible')
  assert.equal(zhipuProvider.authMode, 'api-key')
  assert.ok(zhipuProvider.models.includes('zhipu/glm-5.1'))

  const minimaxProvider = getProvider('minimax')
  assert.equal(minimaxProvider.id, 'minimax')
  assert.equal(minimaxProvider.adapter, 'anthropic-compatible')
  assert.equal(minimaxProvider.authMode, 'api-key')
  assert.ok(minimaxProvider.models.includes('minimax/MiniMax-M2.7'))
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

  const glmModel = getModel('zhipu/glm-5.1')
  assert.equal(glmModel.id, 'zhipu/glm-5.1')
  assert.equal(glmModel.contextWindow, 200000)
  assert.equal(glmModel.capabilities.toolCalling, true)
  assert.equal(glmModel.capabilities.jsonOutput, true)
  assert.equal(glmModel.capabilities.streaming, true)

  const minimaxModel = getModel('minimax/MiniMax-M2.7')
  assert.equal(minimaxModel.id, 'minimax/MiniMax-M2.7')
  assert.equal(minimaxModel.contextWindow, 200000)
  assert.equal(minimaxModel.capabilities.toolCalling, true)
  assert.equal(minimaxModel.capabilities.jsonOutput, true)
  assert.equal(minimaxModel.capabilities.streaming, true)

  // deepseek-reasoner (R1) explicitly declares no tool-calling support
  const reasonerModel = getModel('deepseek/deepseek-reasoner')
  assert.equal(reasonerModel.id, 'deepseek/deepseek-reasoner')
  assert.equal(reasonerModel.capabilities.toolCalling, false)
  assert.equal(reasonerModel.capabilities.streaming, true)
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
