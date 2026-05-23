import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { getProvider, getModel } from '../providers/registry.js';

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
}

export interface BabelOConfig {
  defaultModel?: string;
  providers?: Record<string, ProviderConfig>;
}

export const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.babel-o');
export const DEFAULT_CONFIG_FILE = path.join(DEFAULT_CONFIG_DIR, 'config.json');

export class ConfigManager {
  private static instance: ConfigManager;
  private config: BabelOConfig | null = null;
  private readonly configFile: string;

  constructor(configFile = process.env.BABEL_O_CONFIG_FILE ?? DEFAULT_CONFIG_FILE) {
    this.configFile = configFile;
  }

  public static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  public load(): BabelOConfig {
    if (this.config) return this.config;

    try {
      if (fs.existsSync(this.configFile)) {
        const raw = fs.readFileSync(this.configFile, 'utf-8');
        this.config = JSON.parse(raw);
      } else {
        this.config = {};
      }
    } catch (error) {
      this.config = {};
    }

    return this.config!;
  }

  public save(config?: BabelOConfig): void {
    const toSave = config || this.config || {};
    const configDir = path.dirname(this.configFile);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    fs.writeFileSync(this.configFile, JSON.stringify(toSave, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    this.config = toSave;
  }

  public getProviderConfig(providerId: string): ProviderConfig {
    const conf = this.load();
    return conf.providers?.[providerId] || {};
  }

  public setProviderConfig(providerId: string, providerConfig: ProviderConfig): void {
    const conf = this.load();
    if (!conf.providers) {
      conf.providers = {};
    }
    conf.providers[providerId] = {
      ...conf.providers[providerId],
      ...providerConfig,
    };
    this.save(conf);
  }

  public getDefaultModel(): string {
    const conf = this.load();
    return conf.defaultModel || 'local/coding-runtime';
  }

  public setDefaultModel(model: string): void {
    const conf = this.load();
    conf.defaultModel = model;
    this.save(conf);
  }

  /**
   * Resolves the current model and connection settings, considering env vars, config file, and defaults.
   */
  public resolveSettings() {
    const conf = this.load();

    // 1. Resolve model ID
    let modelId = process.env.BABEL_O_MODEL || conf.defaultModel || 'local/coding-runtime';
    
    // Verify model exists in registry (if it's not a custom model string, but we stick to model registry format provider/name)
    // E.g. openai/gpt-4o. If it is local/coding-runtime, it resolves to local provider.
    let providerId = '';
    const slashIdx = modelId.indexOf('/');
    if (slashIdx !== -1) {
      providerId = modelId.substring(0, slashIdx);
    } else {
      // Fallback
      providerId = modelId === 'local-runtime' ? 'local' : modelId;
    }

    // Allow overriding provider via env
    if (process.env.BABEL_O_PROVIDER) {
      providerId = process.env.BABEL_O_PROVIDER;
    }

    // Ensure providerId is valid
    let providerDef;
    try {
      providerDef = getProvider(providerId);
    } catch {
      // Fallback to local if unknown provider
      providerId = 'local';
      modelId = 'local/coding-runtime';
      providerDef = getProvider(providerId);
    }

    // 2. Resolve credentials
    const provConfig = conf.providers?.[providerId] || {};

    let apiKey = process.env.BABEL_O_API_KEY;
    if (!apiKey) {
      if (providerId === 'anthropic') {
        apiKey = process.env.ANTHROPIC_API_KEY;
      } else if (providerId === 'openai') {
        apiKey = process.env.OPENAI_API_KEY;
      } else if (providerId === 'zhipu') {
        apiKey = process.env.ZHIPU_API_KEY || process.env.ZHIPUAI_API_KEY;
      } else if (providerId === 'minimax') {
        apiKey = process.env.MINIMAX_API_KEY || process.env.MINIMAX_AUTH_TOKEN;
      }
    }
    if (!apiKey) {
      apiKey = provConfig.apiKey;
    }

    let baseUrl = process.env.BABEL_O_BASE_URL;
    if (!baseUrl) {
      if (providerId === 'anthropic') {
        baseUrl = process.env.ANTHROPIC_BASE_URL;
      } else if (providerId === 'openai') {
        baseUrl = process.env.OPENAI_BASE_URL;
      } else if (providerId === 'zhipu') {
        baseUrl = process.env.ZHIPU_BASE_URL || process.env.ZHIPUAI_BASE_URL;
      } else if (providerId === 'minimax') {
        baseUrl = process.env.MINIMAX_BASE_URL;
      }
    }
    if (!baseUrl) {
      baseUrl = provConfig.baseUrl || providerDef.defaultBaseUrl;
    }

    return {
      modelId,
      providerId,
      apiKey,
      baseUrl,
    };
  }
}
