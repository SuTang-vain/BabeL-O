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
}

export const providerRegistry: ProviderDefinition[] = [
  {
    id: 'local',
    displayName: 'Local deterministic runtime',
    adapter: 'local',
    authMode: 'none',
    defaultModel: 'local/coding-runtime',
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic-compatible',
    adapter: 'anthropic-compatible',
    authMode: 'api-key',
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultModel: 'anthropic/claude-sonnet',
  },
  {
    id: 'openai',
    displayName: 'OpenAI-compatible',
    adapter: 'openai-compatible',
    authMode: 'bearer',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'openai/gpt-4.1',
  },
]
