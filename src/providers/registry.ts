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

export type ModelCapabilitySource = 'registry' | 'undeclared'

export type ModelRoleSuitability = {
  role: ModelRole
  suitable: boolean
  missingCapabilities: string[]
}

export type ModelCapabilityDiagnostics = {
  providerId: string
  providerName: string
  adapter: ProviderAdapter
  authMode: ProviderDefinition['authMode']
  modelId: string
  modelName: string
  modelDeclared: boolean
  capabilitySource: ModelCapabilitySource
  capabilityWarning?: string
  contextWindow: number
  defaultMaxTokens: number
  capabilities: {
    toolCalling: boolean
    jsonOutput: boolean
    structuredOutput: boolean
    streaming: boolean
  }
  suitability: {
    longContext: boolean
    toolCalling: boolean
    structuredOutput: boolean
    streaming: boolean
    agentLoopRoles: Record<ModelRole, ModelRoleSuitability>
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
    defaultModel: 'anthropic/claude-sonnet-4-6',
    models: [
      'anthropic/claude-fable-5',
      'anthropic/claude-opus-4-8',
      'anthropic/claude-opus-4-7',
      'anthropic/claude-opus-4-6',
      'anthropic/claude-opus-4-5-20251101',
      'anthropic/claude-opus-4-1-20250805',
      'anthropic/claude-opus-4-20250514',
      'anthropic/claude-sonnet-4-6',
      'anthropic/claude-sonnet-4-5-20250929',
      'anthropic/claude-sonnet-4-20250514',
      'anthropic/claude-haiku-4-5-20251001',
      'anthropic/claude-3-7-sonnet',
      'anthropic/claude-3-5-sonnet',
      'anthropic/claude-3-opus',
    ],
  },
  {
    id: 'openai',
    displayName: 'OpenAI-compatible',
    adapter: 'openai-compatible',
    authMode: 'bearer',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'openai/gpt-5',
    models: [
      'openai/gpt-5.5',
      'openai/gpt-5.5-pro',
      'openai/gpt-5.4',
      'openai/gpt-5.4-pro',
      'openai/gpt-5.4-mini',
      'openai/gpt-5.4-nano',
      'openai/gpt-5.3-codex',
      'openai/gpt-5.2',
      'openai/gpt-5.2-codex',
      'openai/gpt-5.1',
      'openai/gpt-5.1-codex',
      'openai/gpt-5.1-codex-max',
      'openai/gpt-5.1-codex-mini',
      'openai/gpt-5-codex',
      'openai/gpt-5',
      'openai/gpt-5-mini',
      'openai/gpt-5-nano',
      'openai/o4-mini',
      'openai/o3',
      'openai/o3-mini',
      'openai/gpt-4.1',
      'openai/gpt-4.1-mini',
      'openai/gpt-4.1-nano',
      'openai/gpt-4o',
      'openai/gpt-4o-mini',
      'openai/gpt-4-turbo',
      'openai/gpt-3.5-turbo',
    ],
  },
  {
    id: 'moonshot',
    displayName: 'Moonshot AI',
    adapter: 'openai-compatible',
    authMode: 'bearer',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot/kimi-for-coding',
    models: [
      'moonshot/kimi-for-coding',
      'moonshot/moonshot-v1-8k',
      'moonshot/moonshot-v1-32k',
      'moonshot/moonshot-v1-128k',
      'moonshot/moonshot-v1-auto',
    ],
  },
  {
    id: 'ollama',
    displayName: 'Ollama local OpenAI-compatible',
    adapter: 'openai-compatible',
    authMode: 'none',
    defaultBaseUrl: 'http://localhost:11434/v1',
    defaultModel: 'ollama/qwen2.5-coder:7b',
    models: [
      'ollama/qwen2.5-coder:7b',
      'ollama/llama3.1:8b',
      'ollama/deepseek-r1:8b',
    ],
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
      'zhipu/glm-4.7',
      'zhipu/glm-4.7-flash',
      'zhipu/glm-4.6',
      'zhipu/glm-4.6v',
      'zhipu/glm-4.5',
      'zhipu/glm-4.5-air',
    ],
  },
  {
    id: 'minimax',
    displayName: 'MiniMax',
    adapter: 'anthropic-compatible',
    authMode: 'api-key',
    defaultBaseUrl: 'https://api.minimaxi.com/anthropic',
    defaultModel: 'minimax/MiniMax-M3',
    models: [
      'minimax/MiniMax-M3',
      'minimax/MiniMax-M2.7',
      'minimax/MiniMax-M2.7-highspeed',
      'minimax/MiniMax-M2.5',
      'minimax/MiniMax-M2.5-highspeed',
      'minimax/MiniMax-M2.1',
      'minimax/MiniMax-M2.1-highspeed',
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
    defaultMaxTokens: 8192,
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
    id: 'moonshot/moonshot-v1-8k',
    name: 'Moonshot V1 8K',
    contextWindow: 8192,
    defaultMaxTokens: 4096,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'moonshot/moonshot-v1-32k',
    name: 'Moonshot V1 32K',
    contextWindow: 32768,
    defaultMaxTokens: 4096,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'moonshot/moonshot-v1-128k',
    name: 'Moonshot V1 128K',
    contextWindow: 128000,
    defaultMaxTokens: 8192,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'moonshot/moonshot-v1-auto',
    name: 'Moonshot V1 Auto',
    contextWindow: 128000,
    defaultMaxTokens: 8192,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'ollama/qwen2.5-coder:7b',
    name: 'Ollama Qwen2.5 Coder 7B',
    contextWindow: 131072,
    defaultMaxTokens: 8192,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'ollama/llama3.1:8b',
    name: 'Ollama Llama 3.1 8B',
    contextWindow: 131072,
    defaultMaxTokens: 8192,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'ollama/deepseek-r1:8b',
    name: 'Ollama DeepSeek R1 8B',
    contextWindow: 131072,
    defaultMaxTokens: 8192,
    capabilities: {
      toolCalling: false,
      jsonOutput: false,
      streaming: true,
    },
  },
  {
    id: 'deepseek/deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    contextWindow: 1_000_000,
    defaultMaxTokens: 128000,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'deepseek/deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    contextWindow: 1_000_000,
    defaultMaxTokens: 128000,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'deepseek/deepseek-chat',
    name: 'DeepSeek Chat (deepseek-v4-flash non-thinking mode)',
    contextWindow: 1_000_000,
    defaultMaxTokens: 8192,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'deepseek/deepseek-reasoner',
    name: 'DeepSeek Reasoner (deepseek-v4-flash thinking mode)',
    contextWindow: 1_000_000,
    defaultMaxTokens: 65536,
    capabilities: {
      toolCalling: false,
      jsonOutput: false,
      streaming: true,
    },
  },
  {
    id: 'zhipu/glm-5.1',
    name: 'GLM 5.1',
    contextWindow: 204800,
    defaultMaxTokens: 65536,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'zhipu/glm-5',
    name: 'GLM 5',
    contextWindow: 204800,
    defaultMaxTokens: 65536,
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
    defaultMaxTokens: 128000,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'minimax/MiniMax-M3',
    name: 'MiniMax M3',
    contextWindow: 1_000_000,
    defaultMaxTokens: 16384,
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
    defaultMaxTokens: 128000,
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
    defaultMaxTokens: 128000,
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
    defaultMaxTokens: 128000,
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
    defaultMaxTokens: 128000,
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
    defaultMaxTokens: 128000,
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
    defaultMaxTokens: 20000,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'anthropic/claude-fable-5',
    name: 'Claude Fable 5',
    contextWindow: 1_000_000,
    defaultMaxTokens: 128000,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'anthropic/claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    contextWindow: 1_000_000,
    defaultMaxTokens: 128000,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'anthropic/claude-sonnet-4-5-20250929',
    name: 'Claude Sonnet 4.5',
    contextWindow: 1_000_000,
    defaultMaxTokens: 64000,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'anthropic/claude-sonnet-4-20250514',
    name: 'Claude Sonnet 4',
    contextWindow: 1_000_000,
    defaultMaxTokens: 64000,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'anthropic/claude-opus-4-8',
    name: 'Claude Opus 4.8',
    contextWindow: 1_000_000,
    defaultMaxTokens: 128000,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'anthropic/claude-opus-4-7',
    name: 'Claude Opus 4.7',
    contextWindow: 1_000_000,
    defaultMaxTokens: 128000,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'anthropic/claude-opus-4-6',
    name: 'Claude Opus 4.6',
    contextWindow: 1_000_000,
    defaultMaxTokens: 128000,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'anthropic/claude-opus-4-5-20251101',
    name: 'Claude Opus 4.5',
    contextWindow: 200000,
    defaultMaxTokens: 64000,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'anthropic/claude-opus-4-1-20250805',
    name: 'Claude Opus 4.1',
    contextWindow: 200000,
    defaultMaxTokens: 32000,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'anthropic/claude-opus-4-20250514',
    name: 'Claude Opus 4',
    contextWindow: 200000,
    defaultMaxTokens: 32000,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'anthropic/claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5',
    contextWindow: 200000,
    defaultMaxTokens: 64000,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'openai/gpt-5.5',
    name: 'GPT-5.5',
    contextWindow: 1_050_000,
    defaultMaxTokens: 128000,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'openai/gpt-5.5-pro',
    name: 'GPT-5.5 Pro',
    contextWindow: 1_050_000,
    defaultMaxTokens: 128000,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'openai/gpt-5.4',
    name: 'GPT-5.4',
    contextWindow: 1_050_000,
    defaultMaxTokens: 128000,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'openai/gpt-5.4-pro',
    name: 'GPT-5.4 Pro',
    contextWindow: 1_050_000,
    defaultMaxTokens: 128000,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'openai/gpt-5.4-mini',
    name: 'GPT-5.4 Mini',
    contextWindow: 400000,
    defaultMaxTokens: 128000,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'openai/gpt-5.4-nano',
    name: 'GPT-5.4 Nano',
    contextWindow: 400000,
    defaultMaxTokens: 128000,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'openai/gpt-5.3-codex',
    name: 'GPT-5.3 Codex',
    contextWindow: 400000,
    defaultMaxTokens: 128000,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'openai/gpt-5.2',
    name: 'GPT-5.2',
    contextWindow: 400000,
    defaultMaxTokens: 128000,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'openai/gpt-5.2-codex',
    name: 'GPT-5.2 Codex',
    contextWindow: 400000,
    defaultMaxTokens: 128000,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'openai/gpt-5.1',
    name: 'GPT-5.1',
    contextWindow: 400000,
    defaultMaxTokens: 128000,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'openai/gpt-5.1-codex',
    name: 'GPT-5.1 Codex',
    contextWindow: 400000,
    defaultMaxTokens: 128000,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'openai/gpt-5.1-codex-max',
    name: 'GPT-5.1 Codex Max',
    contextWindow: 400000,
    defaultMaxTokens: 128000,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'openai/gpt-5.1-codex-mini',
    name: 'GPT-5.1 Codex Mini',
    contextWindow: 400000,
    defaultMaxTokens: 128000,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'openai/gpt-5-codex',
    name: 'GPT-5 Codex',
    contextWindow: 400000,
    defaultMaxTokens: 128000,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'openai/gpt-5',
    name: 'GPT-5',
    contextWindow: 400000,
    defaultMaxTokens: 128000,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'openai/gpt-5-mini',
    name: 'GPT-5 Mini',
    contextWindow: 400000,
    defaultMaxTokens: 128000,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'openai/gpt-5-nano',
    name: 'GPT-5 Nano',
    contextWindow: 400000,
    defaultMaxTokens: 128000,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'openai/o4-mini',
    name: 'o4 Mini',
    contextWindow: 200000,
    defaultMaxTokens: 50000,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'openai/o3',
    name: 'o3',
    contextWindow: 200000,
    defaultMaxTokens: 50000,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'openai/o3-mini',
    name: 'o3 Mini',
    contextWindow: 200000,
    defaultMaxTokens: 50000,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'openai/gpt-4.1',
    name: 'GPT-4.1',
    contextWindow: 1_047_576,
    defaultMaxTokens: 16384,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'openai/gpt-4.1-mini',
    name: 'GPT-4.1 Mini',
    contextWindow: 1_047_576,
    defaultMaxTokens: 16384,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'openai/gpt-4.1-nano',
    name: 'GPT-4.1 Nano',
    contextWindow: 1_047_576,
    defaultMaxTokens: 16384,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'openai/gpt-4o-mini',
    name: 'GPT-4o-mini',
    contextWindow: 128000,
    defaultMaxTokens: 8192,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'moonshot/kimi-for-coding',
    name: 'Kimi for Coding',
    contextWindow: 262144,
    defaultMaxTokens: 32768,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'zhipu/glm-4.7',
    name: 'GLM 4.7',
    contextWindow: 204800,
    defaultMaxTokens: 98000,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'zhipu/glm-4.7-flash',
    name: 'GLM 4.7 Flash',
    contextWindow: 200000,
    defaultMaxTokens: 65550,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'zhipu/glm-4.6',
    name: 'GLM 4.6',
    contextWindow: 204800,
    defaultMaxTokens: 102400,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'zhipu/glm-4.6v',
    name: 'GLM 4.6V',
    contextWindow: 131072,
    defaultMaxTokens: 65536,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'zhipu/glm-4.5',
    name: 'GLM 4.5',
    contextWindow: 131072,
    defaultMaxTokens: 49152,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'zhipu/glm-4.5-air',
    name: 'GLM 4.5 Air',
    contextWindow: 131072,
    defaultMaxTokens: 49152,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
    },
  },
  {
    id: 'minimax/MiniMax-M2.1-highspeed',
    name: 'MiniMax M2.1 Highspeed',
    contextWindow: 200000,
    defaultMaxTokens: 128000,
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

export function inspectModelCapabilities(modelId: string, providerIdOverride?: string): ModelCapabilityDiagnostics {
  const providerId = providerIdOverride ?? (modelId.includes('/') ? modelId.slice(0, modelId.indexOf('/')) : modelId)
  const provider = getProvider(providerId)
  const declaredModel = modelRegistry.find(model => model.id === modelId)
  const model = declaredModel ?? createUndeclaredModelDefinition(modelId)
  const capabilities = {
    toolCalling: model.capabilities.toolCalling,
    jsonOutput: model.capabilities.jsonOutput,
    structuredOutput: model.capabilities.jsonOutput,
    streaming: model.capabilities.streaming,
  }
  const modelDeclared = Boolean(declaredModel)

  return {
    providerId: provider.id,
    providerName: provider.displayName,
    adapter: provider.adapter,
    authMode: provider.authMode,
    modelId,
    modelName: model.name,
    modelDeclared,
    capabilitySource: modelDeclared ? 'registry' : 'undeclared',
    capabilityWarning: modelDeclared
      ? undefined
      : `Model ${modelId} is not declared in the registry; capabilities are conservative placeholders and are not hard-blocked.`,
    contextWindow: model.contextWindow,
    defaultMaxTokens: model.defaultMaxTokens,
    capabilities,
    suitability: {
      longContext: model.contextWindow >= 128000,
      toolCalling: capabilities.toolCalling,
      structuredOutput: capabilities.structuredOutput,
      streaming: capabilities.streaming,
      agentLoopRoles: {
        planner: roleSuitability('planner', model, capabilities),
        executor: roleSuitability('executor', model, capabilities),
        critic: roleSuitability('critic', model, capabilities),
        optimizer: roleSuitability('optimizer', model, capabilities),
      },
    },
  }
}

function createUndeclaredModelDefinition(modelId: string): ModelDefinition {
  return {
    id: modelId,
    name: modelId,
    contextWindow: 8192,
    defaultMaxTokens: 4096,
    capabilities: {
      toolCalling: false,
      jsonOutput: false,
      streaming: false,
    },
  }
}

function roleSuitability(
  role: ModelRole,
  model: ModelDefinition,
  capabilities: ModelCapabilityDiagnostics['capabilities'],
): ModelRoleSuitability {
  const missingCapabilities: string[] = []
  if ((role === 'planner' || role === 'optimizer') && model.contextWindow < 128000) {
    missingCapabilities.push('long_context')
  }
  if ((role === 'executor' || role === 'optimizer') && !capabilities.toolCalling) {
    missingCapabilities.push('tool_calling')
  }
  if ((role === 'critic' || role === 'optimizer') && !capabilities.structuredOutput) {
    missingCapabilities.push('structured_output')
  }
  if (!capabilities.streaming) {
    missingCapabilities.push('streaming')
  }
  return {
    role,
    suitable: missingCapabilities.length === 0,
    missingCapabilities,
  }
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

const adapterOverrides = new Map<string, ModelAdapter>()

export function setAdapterOverrideForTest(providerId: string, adapter: ModelAdapter | null): void {
  const isTestProcess = process.env.NODE_ENV === 'test' || Boolean(process.env.BABEL_O_CONFIG_FILE?.includes('babel-o-test') || process.env.BABEL_O_CONFIG_FILE?.includes('babel-o-runtime-test'))
  if (!isTestProcess) {
    throw new Error('setAdapterOverrideForTest is only available in test processes')
  }
  if (adapter) {
    adapterOverrides.set(providerId, adapter)
  } else {
    adapterOverrides.delete(providerId)
  }
}

export function getAdapter(providerId: string): ModelAdapter {
  const override = adapterOverrides.get(providerId)
  if (override) return override
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
