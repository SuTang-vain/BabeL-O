/**
 * Fallback provider for environments without keychain support.
 * Uses environment variables for API keys (read-only).
 */

import type { SecretProvider, SecretOptions } from './types.js';

/**
 * Environment variable mapping for each provider.
 */
const PROVIDER_ENV_VARS: Record<string, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY', 'BABEL_O_ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY', 'BABEL_O_OPENAI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY', 'BABEL_O_DEEPSEEK_API_KEY'],
  zhipu: ['ZHIPU_API_KEY', 'ZHIPUAI_API_KEY', 'BABEL_O_ZHIPU_API_KEY'],
  minimax: ['MINIMAX_API_KEY', 'MINIMAX_AUTH_TOKEN', 'BABEL_O_MINIMAX_API_KEY'],
  moonshot: ['MOONSHOT_API_KEY', 'BABEL_O_MOONSHOT_API_KEY'],
  ollama: ['OLLAMA_API_KEY', 'BABEL_O_OLLAMA_API_KEY'],
};

/**
 * Fallback secret provider that reads from environment variables.
 * This is read-only and does not store secrets.
 */
export class FallbackEnvProvider implements SecretProvider {
  private env: NodeJS.ProcessEnv;

  constructor(options?: SecretOptions) {
    this.env = options?.env ?? process.env;
  }

  async isAvailable(): Promise<boolean> {
    // Always available as a fallback
    return true;
  }

  async get(providerId: string): Promise<string | undefined> {
    const envVars = PROVIDER_ENV_VARS[providerId] || [];

    // Also check the universal BABEL_O_API_KEY
    envVars.push('BABEL_O_API_KEY');

    for (const envVar of envVars) {
      const value = this.env[envVar];
      if (value && typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }

    return undefined;
  }

  async set(_providerId: string, _apiKey: string): Promise<void> {
    // Cannot write to environment variables
    throw new Error('Cannot store API key in environment variables. Use system keychain or config file instead.');
  }

  async delete(_providerId: string): Promise<boolean> {
    // Cannot delete from environment variables
    throw new Error('Cannot delete API key from environment variables.');
  }

  async list(): Promise<string[]> {
    // List providers that have API keys in environment
    const providers: string[] = [];

    for (const [providerId, envVars] of Object.entries(PROVIDER_ENV_VARS)) {
      for (const envVar of envVars) {
        if (this.env[envVar] && typeof this.env[envVar] === 'string' && this.env[envVar]!.trim()) {
          providers.push(providerId);
          break;
        }
      }
    }

    return providers;
  }

  /**
   * Get the environment variable name for a provider.
   */
  static getEnvVarName(providerId: string): string {
    return `BABEL_O_${providerId.toUpperCase()}_API_KEY`;
  }
}
