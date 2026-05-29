import type { ModelAdapter } from './adapters/ModelAdapter.js'
import { AnthropicAdapter } from './adapters/AnthropicAdapter.js'
import { OpenAIAdapter } from './adapters/OpenAIAdapter.js'
import { LocalAdapter } from './adapters/LocalAdapter.js'

export type ProviderAdapter =
  | 'anthropic-compatible'
  | 'openai-compatible'
  | 'openai-responses'
  | 'local'

export type ProviderDefinition = {
  id: string
  displayName: string
  adapter: ProviderAdapter
  authMode: 'api-key' | 'bearer' | 'none'
  defaultBaseUrl?: string
  defaultModel: string
  models: string[]
}

export type ModelDefinition = {
  id: string // Format: provider/model (e.g. openai/gpt-4o)
  name: string
  contextWindow: number
  defaultMaxTokens: number
  capabilities: {
    toolCalling: boolean
    jsonOutput: boolean
    streaming: boolean
  }
}

export type ModelRole = 'planner' | 'executor' | 'critic' | 'optimizer'

export type ModelRoleRecommendation = {
  role: ModelRole
  capability: 'long_context' | 'tool_calling' | 'structured_output' | 'balanced'
  modelId: string
  reason: string
}

export class UnknownProviderError extends Error {
  constructor(providerId: string) {
    super(`Unknown provider: ${providerId}`)
    this.name = 'UnknownProviderError'
  }
}

export class UnknownModelError extends Error {
  constructor(modelId: string) {
    super(`Unknown model: ${modelId}`)
    this.name = 'UnknownModelError'
  }
}

export const providerRegistry: ProviderDefinition[] = [
  {
    id: 'local',
    displayName: 'Local deterministic runtime',
    adapter: 'local',
    authMode: 'none',
    defaultModel: 'local/coding-runtime',
    models: ['local/coding-runtime'],
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic-compatible',
    adapter: 'anthropic-compatible',
    authMode: 'api-key',
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultModel: 'anthropic/claude-3-5-sonnet',
    models: ['anthropic/claude-3-5-sonnet', 'anthropic/claude-3-opus', 'anthropic/claude-3-7-sonnet'],
  },
  {
    id: 'openai',
    displayName: 'OpenAI-compatible',
    adapter: 'openai-compatible',
    authMode: 'bearer',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'openai/gpt-4o',
    models: ['openai/gpt-4o', 'openai/gpt-4-turbo', 'openai/gpt-3.5-turbo'],
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    adapter: 'openai-compatible',
    authMode: 'bearer',
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek/deepseek-v4-pro',
    models: [
      'deepseek/deepseek-v4-pro',
      'deepseek/deepseek-v4-flash',
      'deepseek/deepseek-chat',
      'deepseek/deepseek-reasoner',
    ],
  },
  {
    id: 'zhipu',
    displayName: 'Zhipu AI',
    adapter: 'anthropic-compatible',
    authMode: 'api-key',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
    defaultModel: 'zhipu/glm-5.1',
    models: [
      'zhipu/glm-5.1',
      'zhipu/glm-5',
      'zhipu/glm-5-turbo',
    ],
  },
  {
    id: 'minimax',
    displayName: 'MiniMax',
    adapter: 'anthropic-compatible',
    authMode: 'api-key',
    defaultBaseUrl: 'https://api.minimaxi.com/anthropic',
    defaultModel: 'minimax/MiniMax-M2.7',
    models: [
      'minimax/MiniMax-M2.7',
      'minimax/MiniMax-M2.7-highspeed',
      'minimax/MiniMax-M2.5',
      'minimax/MiniMax-M2.5-highspeed',
      'minimax/MiniMax-M2.1',
      'minimax/MiniMax-M2',
    ],
  },
]

export const modelRegistry: ModelDefinition[] = [
  {
    id: 'local/coding-runtime',
    name: 'Local Coding Runtime',
    contextWindow: 8192,
    defaultMaxTokens: 4096,
    capabilities: {
      toolCalling: true,
      jsonOutput: false,
      streaming: true,
    },
  },
  {
    id: 'anthropic/claude-3-5-sonnet',
    name: 'Claude 3.5 Sonnet',
    contextWindow: 200000,
    defaultMaxTokens: 16384,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'anthropic/claude-3-opus',
    name: 'Claude 3 Opus',
    contextWindow: 200000,
    defaultMaxTokens: 16384,
    capabilities: {
      toolCalling: true,
      jsonOutput: false,
      streaming: true,
    },
  },
  {
    id: 'anthropic/claude-3-7-sonnet',
    name: 'Claude 3.7 Sonnet',
    contextWindow: 200000,
    defaultMaxTokens: 16384,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'openai/gpt-4o',
    name: 'GPT-4o',
    contextWindow: 128000,
    defaultMaxTokens: 16384,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'openai/gpt-4-turbo',
    name: 'GPT-4 Turbo',
    contextWindow: 128000,
    defaultMaxTokens: 16384,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'openai/gpt-3.5-turbo',
    name: 'GPT-3.5 Turbo',
    contextWindow: 16385,
    defaultMaxTokens: 4096,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'deepseek/deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    contextWindow: 128000,
    defaultMaxTokens: 16384,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'deepseek/deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    contextWindow: 128000,
    defaultMaxTokens: 8192,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'deepseek/deepseek-chat',
    name: 'DeepSeek Chat (V3)',
    contextWindow: 64000,
    defaultMaxTokens: 4096,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'deepseek/deepseek-reasoner',
    name: 'DeepSeek Reasoner (R1)',
    contextWindow: 64000,
    defaultMaxTokens: 4096,
    capabilities: {
      toolCalling: false,
      jsonOutput: false,
      streaming: true,
    },
  },
  {
    id: 'zhipu/glm-5.1',
    name: 'GLM 5.1',
    contextWindow: 200000,
    defaultMaxTokens: 16384,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'zhipu/glm-5',
    name: 'GLM 5',
    contextWindow: 200000,
    defaultMaxTokens: 8192,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'zhipu/glm-5-turbo',
    name: 'GLM 5 Turbo',
    contextWindow: 200000,
    defaultMaxTokens: 8192,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'minimax/MiniMax-M2.7',
    name: 'MiniMax M2.7',
    contextWindow: 200000,
    defaultMaxTokens: 16384,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'minimax/MiniMax-M2.7-highspeed',
    name: 'MiniMax M2.7 Highspeed',
    contextWindow: 200000,
    defaultMaxTokens: 16384,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'minimax/MiniMax-M2.5',
    name: 'MiniMax M2.5',
    contextWindow: 200000,
    defaultMaxTokens: 8192,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'minimax/MiniMax-M2.5-highspeed',
    name: 'MiniMax M2.5 Highspeed',
    contextWindow: 200000,
    defaultMaxTokens: 8192,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'minimax/MiniMax-M2.1',
    name: 'MiniMax M2.1',
    contextWindow: 200000,
    defaultMaxTokens: 8192,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'minimax/MiniMax-M2',
    name: 'MiniMax M2',
    contextWindow: 200000,
    defaultMaxTokens: 8192,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
]

export function getProvider(id: string): ProviderDefinition {
  const provider = providerRegistry.find(p => p.id === id)
  if (!provider) {
    throw new UnknownProviderError(id)
  }
  return provider
}

export function getModel(id: string): ModelDefinition {
  const model = modelRegistry.find(m => m.id === id)
  if (!model) {
    throw new UnknownModelError(id)
  }
  return model
}

export function recommendModelForRole(role: ModelRole): ModelRoleRecommendation {
  const models = modelRegistry.filter(model => model.capabilities.streaming)
  switch (role) {
    case 'planner': {
      const model = [...models]
        .sort((left, right) => right.contextWindow - left.contextWindow || right.defaultMaxTokens - left.defaultMaxTokens)[0]!
      return {
        role,
        capability: 'long_context',
        modelId: model.id,
        reason: 'Planner role benefits from the largest available context window.',
      }
    }
    case 'executor': {
      const model = [...models]
        .filter(item => item.capabilities.toolCalling)
        .sort((left, right) => right.defaultMaxTokens - left.defaultMaxTokens || right.contextWindow - left.contextWindow)[0]!
      return {
        role,
        capability: 'tool_calling',
        modelId: model.id,
        reason: 'Executor role requires stable tool calling support.',
      }
    }
    case 'critic': {
      const model = [...models]
        .filter(item => item.capabilities.jsonOutput)
        .sort((left, right) => right.contextWindow - left.contextWindow || right.defaultMaxTokens - left.defaultMaxTokens)[0]!
      return {
        role,
        capability: 'structured_output',
        modelId: model.id,
        reason: 'Critic role benefits from structured output support.',
      }
    }
    case 'optimizer': {
      const model = [...models]
        .filter(item => item.capabilities.toolCalling && item.capabilities.jsonOutput)
        .sort((left, right) => right.contextWindow - left.contextWindow || right.defaultMaxTokens - left.defaultMaxTokens)[0] ?? models[0]!
      return {
        role,
        capability: 'balanced',
        modelId: model.id,
        reason: 'Optimizer role prefers a balanced model with tool and structured output support.',
      }
    }
  }
}

export function getAdapter(providerId: string): ModelAdapter {
  const provider = getProvider(providerId)
  switch (provider.adapter) {
    case 'anthropic-compatible':
      return new AnthropicAdapter()
    case 'openai-compatible':
    case 'openai-responses':
      return new OpenAIAdapter()
    case 'local':
      return new LocalAdapter()
    default:
      throw new Error(`No adapter found for provider type: ${provider.adapter}`)
  }
}
