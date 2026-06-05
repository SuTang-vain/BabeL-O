import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  getProvider,
  getModel,
  inspectModelCapabilities,
  UnknownProviderError,
  UnknownModelError,
  providerRegistry,
  modelRegistry,
  recommendModelForRole,
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

test('role recommendations are capability-based and registry-backed', () => {
  const planner = recommendModelForRole('planner')
  const plannerModel = getModel(planner.modelId)
  assert.equal(planner.capability, 'long_context')
  assert.equal(plannerModel.contextWindow, Math.max(...modelRegistry.map(model => model.contextWindow)))

  const executor = recommendModelForRole('executor')
  assert.equal(executor.capability, 'tool_calling')
  assert.equal(getModel(executor.modelId).capabilities.toolCalling, true)

  const critic = recommendModelForRole('critic')
  assert.equal(critic.capability, 'structured_output')
  assert.equal(getModel(critic.modelId).capabilities.jsonOutput, true)
})

test('inspectModelCapabilities exposes provider and registry-backed model capabilities', () => {
  const diagnostics = inspectModelCapabilities('openai/gpt-4o')

  assert.equal(diagnostics.providerId, 'openai')
  assert.equal(diagnostics.providerName, 'OpenAI-compatible')
  assert.equal(diagnostics.adapter, 'openai-compatible')
  assert.equal(diagnostics.authMode, 'bearer')
  assert.equal(diagnostics.modelDeclared, true)
  assert.equal(diagnostics.capabilitySource, 'registry')
  assert.equal(diagnostics.contextWindow, 128000)
  assert.equal(diagnostics.defaultMaxTokens, 16384)
  assert.deepEqual(diagnostics.capabilities, {
    toolCalling: true,
    jsonOutput: true,
    structuredOutput: true,
    streaming: true,
  })
  assert.equal(diagnostics.suitability.longContext, true)
  assert.equal(diagnostics.suitability.agentLoopRoles.executor.suitable, true)
  assert.equal(diagnostics.suitability.agentLoopRoles.critic.suitable, true)
})

test('inspectModelCapabilities marks provider-scoped custom models as undeclared without hard blocking', () => {
  const diagnostics = inspectModelCapabilities('openai/custom-model')

  assert.equal(diagnostics.providerId, 'openai')
  assert.equal(diagnostics.modelDeclared, false)
  assert.equal(diagnostics.capabilitySource, 'undeclared')
  assert.match(diagnostics.capabilityWarning ?? '', /not declared in the registry/)
  assert.equal(diagnostics.contextWindow, 8192)
  assert.equal(diagnostics.defaultMaxTokens, 4096)
  assert.equal(diagnostics.capabilities.toolCalling, false)
  assert.equal(diagnostics.capabilities.structuredOutput, false)
  assert.equal(diagnostics.suitability.agentLoopRoles.executor.suitable, false)
  assert.deepEqual(diagnostics.suitability.agentLoopRoles.executor.missingCapabilities, ['tool_calling', 'streaming'])
})

test('inspectModelCapabilities supports slashless custom models with explicit provider override', () => {
  const diagnostics = inspectModelCapabilities('custom-gpt', 'openai')

  assert.equal(diagnostics.providerId, 'openai')
  assert.equal(diagnostics.modelId, 'custom-gpt')
  assert.equal(diagnostics.modelDeclared, false)
  assert.equal(diagnostics.capabilitySource, 'undeclared')
})
