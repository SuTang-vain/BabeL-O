import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';
import { getProvider, providerRegistry, modelRegistry } from '../providers/registry.js';
import { logger } from './logger.js';

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
}

export interface ProfileConfig {
  model?: string;
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  roles?: {
    planner?: string;
    executor?: string;
    critic?: string;
    optimizer?: string;
  };
}

export interface BabelOConfig {
  defaultModel?: string;
  providers?: Record<string, ProviderConfig>;
  profiles?: Record<string, ProfileConfig>;
  activeProfile?: string;
  docker?: {
    image?: string;
    network?: string;
    memory?: string;
    cpus?: string;
  };
}

export type ResolveSettingsOptions = {
  role?: string;
  model?: string;
  provider?: string;
}

export const ProviderConfigSchema = z.object({
  apiKey: z.string().min(1, 'API key cannot be empty').optional(),
  baseUrl: z.string().url('Base URL must be a valid URL').optional(),
});

export const ProfileConfigSchema = z.object({
  model: z.string().min(1, 'Model ID cannot be empty').optional(),
  provider: z.string().min(1, 'Provider ID cannot be empty').optional(),
  apiKey: z.string().min(1, 'API key cannot be empty').optional(),
  baseUrl: z.string().url('Base URL must be a valid URL').optional(),
  roles: z.object({
    planner: z.string().min(1).optional(),
    executor: z.string().min(1).optional(),
    critic: z.string().min(1).optional(),
    optimizer: z.string().min(1).optional(),
  }).optional(),
});

export const BabelOConfigSchema = z.object({
  defaultModel: z.string().optional(),
  providers: z.record(z.string(), ProviderConfigSchema).optional(),
  profiles: z.record(z.string(), ProfileConfigSchema).optional(),
  activeProfile: z.string().optional(),
  docker: z.object({
    image: z.string().optional(),
    network: z.string().optional(),
    memory: z.string().optional(),
    cpus: z.string().optional(),
  }).optional(),
}).superRefine((data, ctx) => {
  if (data.defaultModel) {
    const defaultModel = data.defaultModel;
    const modelValid = modelRegistry.some(m => m.id === defaultModel) || (() => {
      const slashIdx = defaultModel.indexOf('/');
      if (slashIdx === -1) return false;
      const providerId = defaultModel.substring(0, slashIdx);
      return providerRegistry.some(p => p.id === providerId);
    })();
    if (!modelValid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unknown defaultModel ID: ${defaultModel}`,
        path: ['defaultModel'],
      });
    }
  }

  if (data.providers) {
    for (const providerId of Object.keys(data.providers)) {
      if (!providerRegistry.some(p => p.id === providerId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown provider ID: ${providerId}`,
          path: ['providers', providerId],
        });
      }
    }
  }

  if (data.profiles) {
    for (const [profileName, profile] of Object.entries(data.profiles)) {
      if (profile.model) {
        const modelValid = modelRegistry.some(m => m.id === profile.model) || (() => {
          const slashIdx = profile.model.indexOf('/');
          if (slashIdx === -1) return false;
          const providerId = profile.model.substring(0, slashIdx);
          return providerRegistry.some(p => p.id === providerId);
        })();
        if (!modelValid) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Unknown model ID in profile "${profileName}": ${profile.model}`,
            path: ['profiles', profileName, 'model'],
          });
        }
      }
      if (profile.provider && !providerRegistry.some(p => p.id === profile.provider)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown provider ID in profile "${profileName}": ${profile.provider}`,
          path: ['profiles', profileName, 'provider'],
        });
      }
    }
  }

  if (data.activeProfile && data.activeProfile !== '') {
    if (!data.profiles || !data.profiles[data.activeProfile]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `activeProfile "${data.activeProfile}" does not exist in profiles`,
        path: ['activeProfile'],
      });
    }
  }
});

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
        const parsed = JSON.parse(raw);
        const validated = BabelOConfigSchema.safeParse(parsed);
        if (validated.success) {
          this.config = validated.data;
        } else {
          logger.error('Invalid BabeL-O configuration file; falling back to empty configuration', {
            configFile: this.configFile,
            issues: validated.error.issues.map(issue => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          });
          this.config = {};
        }
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
    const validated = BabelOConfigSchema.parse(toSave);
    const configDir = path.dirname(this.configFile);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    fs.writeFileSync(this.configFile, JSON.stringify(validated, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    this.config = validated;
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

  public getProfiles(): Record<string, ProfileConfig> {
    const conf = this.load();
    return conf.profiles || {};
  }

  public getActiveProfile(): string | undefined {
    const conf = this.load();
    return conf.activeProfile;
  }

  public setActiveProfile(name: string | undefined): void {
    const conf = this.load();
    conf.activeProfile = name;
    this.save(conf);
  }

  public setProfile(name: string, profileConfig: ProfileConfig): void {
    const conf = this.load();
    if (!conf.profiles) {
      conf.profiles = {};
    }
    conf.profiles[name] = {
      ...conf.profiles[name],
      ...profileConfig,
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

  public resolveSettings(roleOrOptions?: string | ResolveSettingsOptions) {
    const conf = this.load();
    const options =
      typeof roleOrOptions === 'string'
        ? { role: roleOrOptions }
        : roleOrOptions ?? {};
    const role = options.role;

    const activeProfileName = conf.activeProfile;
    const profile = activeProfileName ? conf.profiles?.[activeProfileName] : undefined;

    let modelSource: 'request' | 'env' | 'role' | 'profile' | 'default' = 'default';
    let modelId = options.model;
    if (modelId) {
      modelSource = 'request';
    }
    if (!modelId && process.env.BABEL_O_MODEL) {
      modelId = process.env.BABEL_O_MODEL;
      modelSource = 'env';
    }
    if (!modelId && role && profile?.roles) {
      const roleModel = (profile.roles as Record<string, string | undefined>)[role];
      if (roleModel) {
        modelId = roleModel;
        modelSource = 'role';
      }
    }
    if (!modelId && profile?.model) {
      modelId = profile.model;
      modelSource = 'profile';
    }
    if (!modelId) {
      modelId = conf.defaultModel || 'local/coding-runtime';
      modelSource = 'default';
    }
    
    let providerId = options.provider || '';
    const slashIdx = modelId.indexOf('/');
    if (slashIdx !== -1) {
      providerId = modelId.substring(0, slashIdx);
    } else if (!providerId) {
      providerId = modelId === 'local-runtime' ? 'local' : modelId;
    }

    if (slashIdx === -1 && (process.env.BABEL_O_PROVIDER || profile?.provider)) {
      providerId = process.env.BABEL_O_PROVIDER || profile?.provider || providerId;
    }

    let providerDef;
    try {
      providerDef = getProvider(providerId);
    } catch {
      providerId = 'local';
      modelId = 'local/coding-runtime';
      providerDef = getProvider(providerId);
    }

    const provConfig = conf.providers?.[providerId] || {};

    let apiKey = process.env.BABEL_O_API_KEY;
    if (!apiKey) {
      if (providerId === 'anthropic') {
        apiKey = process.env.ANTHROPIC_API_KEY;
      } else if (providerId === 'openai') {
        apiKey = process.env.OPENAI_API_KEY;
      } else if (providerId === 'deepseek') {
        apiKey = process.env.DEEPSEEK_API_KEY;
      } else if (providerId === 'zhipu') {
        apiKey = process.env.ZHIPU_API_KEY || process.env.ZHIPUAI_API_KEY;
      } else if (providerId === 'minimax') {
        apiKey = process.env.MINIMAX_API_KEY || process.env.MINIMAX_AUTH_TOKEN;
      }
    }
    if (!apiKey) {
      apiKey = profile?.apiKey || provConfig.apiKey;
    }

    let baseUrl = process.env.BABEL_O_BASE_URL;
    if (!baseUrl) {
      if (providerId === 'anthropic') {
        baseUrl = process.env.ANTHROPIC_BASE_URL;
      } else if (providerId === 'openai') {
        baseUrl = process.env.OPENAI_BASE_URL;
      } else if (providerId === 'deepseek') {
        baseUrl = process.env.DEEPSEEK_BASE_URL;
      } else if (providerId === 'zhipu') {
        baseUrl = process.env.ZHIPU_BASE_URL || process.env.ZHIPUAI_BASE_URL;
      } else if (providerId === 'minimax') {
        baseUrl = process.env.MINIMAX_BASE_URL;
      }
    }
    if (!baseUrl) {
      baseUrl = profile?.baseUrl || provConfig.baseUrl || providerDef.defaultBaseUrl;
    }

    return {
      modelId,
      providerId,
      apiKey,
      baseUrl,
      activeProfile: activeProfileName,
      modelSource,
    };
  }
}
