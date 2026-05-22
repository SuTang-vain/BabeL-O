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
  capabilities: {
    toolCalling: boolean
    jsonOutput: boolean
    streaming: boolean
  }
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
    models: ['anthropic/claude-3-5-sonnet', 'anthropic/claude-3-opus'],
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
]

export const modelRegistry: ModelDefinition[] = [
  {
    id: 'local/coding-runtime',
    name: 'Local Coding Runtime',
    contextWindow: 8192,
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
    capabilities: {
      toolCalling: true,
      jsonOutput: false,
      streaming: true,
    },
  },
  {
    id: 'openai/gpt-4o',
    name: 'GPT-4o',
    contextWindow: 128000,
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

