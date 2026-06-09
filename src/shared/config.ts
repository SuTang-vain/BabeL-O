import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';
import { getProvider, inspectModelCapabilities, providerRegistry, modelRegistry, recommendModelForRole, type ModelCapabilityDiagnostics, type ModelRole, type ModelRoleRecommendation } from '../providers/registry.js';
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

export interface HookBuiltinConfig {
  enabled?: boolean;
  timeoutMs?: number;
}

export interface HooksConfig {
  enabled?: boolean;
  builtins?: Record<string, HookBuiltinConfig>;
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
  hooks?: HooksConfig;
}

export type BabeLXConfigImportProfile = {
  name: string;
  providerId: string;
  modelId: string;
  hasApiKey: boolean;
  hasBaseUrl: boolean;
}

export type BabeLXConfigImportSkippedProfile = {
  name: string;
  providerId?: string;
  reason: string;
}

export type BabeLXConfigImportPlan = {
  sourceSchema: 'babel-x-config-v1';
  transcriptImportSupported: false;
  importedProfiles: BabeLXConfigImportProfile[];
  skippedProfiles: BabeLXConfigImportSkippedProfile[];
  warnings: string[];
  config: BabelOConfig;
}

export type ResolveSettingsOptions = {
  role?: string;
  model?: string;
  provider?: string;
}

export type ResolvedSettings = {
  modelId: string;
  providerId: string;
  apiKey?: string;
  baseUrl?: string;
  activeProfile?: string;
  modelSource: 'request' | 'env' | 'role' | 'profile' | 'default';
  apiKeySource: 'env' | 'profile' | 'provider_config' | 'none';
  baseUrlSource: 'env' | 'profile' | 'provider_config' | 'provider_default' | 'none';
}

export type ProviderRoleDiagnostics = ModelRoleRecommendation & {
  configured: boolean;
  activeModelId: string;
  activeModelMatchesRecommendation: boolean;
  willAutoSwitch: false;
}

export type ProviderDiagnostics = {
  providerId: string;
  providerName: string;
  adapter: string;
  authMode: 'api-key' | 'bearer' | 'none';
  authConfigured: boolean;
  authSource: ResolvedSettings['apiKeySource'];
  baseUrl: string;
  baseUrlSource: ResolvedSettings['baseUrlSource'];
  modelId: string;
  modelName: string;
  modelSource: ResolvedSettings['modelSource'];
  activeProfile?: string;
  contextWindow: number;
  defaultMaxTokens: number;
  capabilities: {
    toolCalling: boolean;
    jsonOutput: boolean;
    streaming: boolean;
    structuredOutput: boolean;
  };
  modelDeclared: boolean;
  capabilitySource: ModelCapabilityDiagnostics['capabilitySource'];
  capabilityWarning?: string;
  suitability: ModelCapabilityDiagnostics['suitability'];
  roleRecommendation?: ProviderRoleDiagnostics;
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

export const HookBuiltinConfigSchema = z.object({
  enabled: z.boolean().optional(),
  timeoutMs: z.number().int().positive().max(60_000).optional(),
});

export const HooksConfigSchema = z.object({
  enabled: z.boolean().optional(),
  builtins: z.record(z.string(), HookBuiltinConfigSchema).optional(),
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
  hooks: HooksConfigSchema.optional(),
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
    if (!data.profiles || !Object.prototype.hasOwnProperty.call(data.profiles, data.activeProfile)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `activeProfile "${data.activeProfile}" does not exist in profiles`,
        path: ['activeProfile'],
      });
    }
  }
});

const USER_DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.babel-o');
const USER_DEFAULT_CONFIG_FILE = path.join(USER_DEFAULT_CONFIG_DIR, 'config.json');
const USER_DEFAULT_BABEL_X_CONFIG_FILE = path.join(os.homedir(), '.babel', 'config.json');

export const DEFAULT_CONFIG_DIR = process.env.BABEL_O_CONFIG_DIR
  || (process.env.BABEL_O_CONFIG_FILE ? path.dirname(process.env.BABEL_O_CONFIG_FILE) : USER_DEFAULT_CONFIG_DIR);
export const DEFAULT_CONFIG_FILE = process.env.BABEL_O_CONFIG_FILE || path.join(DEFAULT_CONFIG_DIR, 'config.json');
export const DEFAULT_BABEL_X_CONFIG_FILE = USER_DEFAULT_BABEL_X_CONFIG_FILE;

const TEST_CONFIG_GUARD_ERROR_CODE = 'BABEL_O_TEST_CONFIG_NOT_ISOLATED';

const BABEL_X_PROVIDER_ALIASES: Record<string, string> = {
  zhipu: 'zhipu',
  openai: 'openai',
  anthropic: 'anthropic',
  deepseek: 'deepseek',
  minimax: 'minimax',
  moonshot: 'moonshot',
};

const BABEL_X_MODEL_ALIASES: Record<string, Record<string, string>> = {
  minimax: {
    'minimax-m2': 'MiniMax-M2',
    'minimax-m2.1': 'MiniMax-M2.1',
    'minimax-m2.5': 'MiniMax-M2.5',
    'minimax-m2.5-highspeed': 'MiniMax-M2.5-highspeed',
    'minimax-m2.7': 'MiniMax-M2.7',
    'minimax-m2.7-highspeed': 'MiniMax-M2.7-highspeed',
  },
  moonshot: {
    'moonshot-v1-8k': 'moonshot-v1-8k',
    'moonshot-v1-32k': 'moonshot-v1-32k',
    'moonshot-v1-128k': 'moonshot-v1-128k',
    'moonshot-v1-auto': 'moonshot-v1-auto',
  },
};

function isNodeTestProcess(): boolean {
  return process.env.BABEL_O_TEST_CONFIG_WRITE_GUARD === '1'
    || process.env.NODE_TEST_CONTEXT !== undefined
    || process.argv.some(arg => arg === '--test' || arg.startsWith('--test-'));
}

function isUserDefaultConfigFile(configFile: string): boolean {
  return path.resolve(configFile) === path.resolve(USER_DEFAULT_CONFIG_FILE);
}

function createTestConfigGuardError(): Error & { code: string } {
  const error = new Error('Refusing to write the user BabeL-O config from a test process; set BABEL_O_CONFIG_FILE to a temporary path.');
  return Object.assign(error, { code: TEST_CONFIG_GUARD_ERROR_CODE });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function normalizeBabeLXModelId(providerId: string, model: string | undefined): string {
  const provider = getProvider(providerId);
  if (!model) return provider.defaultModel;
  const aliased = BABEL_X_MODEL_ALIASES[providerId]?.[model.toLowerCase()] ?? model;
  const canonical = aliased.includes('/') ? aliased : `${providerId}/${aliased}`;
  return modelRegistry.some(item => item.id === canonical) ? canonical : provider.defaultModel;
}

export function createBabeLXConfigImportPlan(rawConfig: unknown): BabeLXConfigImportPlan {
  const warnings: string[] = [];
  const importedProfiles: BabeLXConfigImportProfile[] = [];
  const skippedProfiles: BabeLXConfigImportSkippedProfile[] = [];
  const config: BabelOConfig = { profiles: {} };

  if (!isRecord(rawConfig)) {
    throw new Error('Invalid BabeL-X config: expected a JSON object.');
  }

  const profiles = rawConfig.profiles;
  if (!Array.isArray(profiles)) {
    throw new Error('Invalid BabeL-X config: expected profiles array.');
  }

  const activeProfile = getOptionalString(rawConfig, 'activeProfile');

  for (const [index, profile] of profiles.entries()) {
    if (!isRecord(profile)) {
      skippedProfiles.push({ name: `profile-${index + 1}`, reason: 'profile is not an object' });
      continue;
    }

    const name = getOptionalString(profile, 'name') ?? `profile-${index + 1}`;
    const legacyProvider = getOptionalString(profile, 'type');
    const providerId = legacyProvider ? BABEL_X_PROVIDER_ALIASES[legacyProvider.toLowerCase()] : undefined;
    if (!providerId) {
      skippedProfiles.push({ name, providerId: legacyProvider, reason: 'provider is not registered in BabeL-O' });
      continue;
    }

    const apiKey = getOptionalString(profile, 'apiKey');
    if (!apiKey) {
      skippedProfiles.push({ name, providerId, reason: 'profile has no API key' });
      continue;
    }

    const baseUrl = getOptionalString(profile, 'baseUrl');
    const modelId = normalizeBabeLXModelId(providerId, getOptionalString(profile, 'defaultModel'));
    config.profiles![name] = {
      provider: providerId,
      model: modelId,
      apiKey,
      ...(baseUrl ? { baseUrl } : {}),
    };
    config.providers = {
      ...config.providers,
      [providerId]: {
        ...config.providers?.[providerId],
        apiKey,
        ...(baseUrl ? { baseUrl } : {}),
      },
    };
    importedProfiles.push({
      name,
      providerId,
      modelId,
      hasApiKey: true,
      hasBaseUrl: Boolean(baseUrl),
    });
  }

  if (activeProfile && config.profiles?.[activeProfile]) {
    config.activeProfile = activeProfile;
    config.defaultModel = config.profiles[activeProfile]?.model;
  } else if (importedProfiles[0]) {
    config.activeProfile = importedProfiles[0].name;
    config.defaultModel = importedProfiles[0].modelId;
    if (activeProfile) {
      warnings.push(`Active BabeL-X profile "${activeProfile}" was not imported; using "${importedProfiles[0].name}".`);
    }
  }

  if (!importedProfiles.length) {
    delete config.profiles;
    warnings.push('No BabeL-X provider profiles were importable.');
  }

  warnings.push('BabeL-X transcripts are not imported; Nexus session schema stays separate.');

  return {
    sourceSchema: 'babel-x-config-v1',
    transcriptImportSupported: false,
    importedProfiles,
    skippedProfiles,
    warnings,
    config,
  };
}

export function loadBabeLXConfigImportPlan(configFile = DEFAULT_BABEL_X_CONFIG_FILE): BabeLXConfigImportPlan {
  const raw = fs.readFileSync(configFile, 'utf-8');
  return createBabeLXConfigImportPlan(JSON.parse(raw));
}

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
    if (isNodeTestProcess() && isUserDefaultConfigFile(this.configFile)) {
      throw createTestConfigGuardError();
    }
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

  public hasProfile(name: string): boolean {
    const conf = this.load();
    return Boolean(conf.profiles && Object.prototype.hasOwnProperty.call(conf.profiles, name));
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

  public resolveSettings(roleOrOptions?: string | ResolveSettingsOptions): ResolvedSettings {
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

    let apiKeySource: ResolvedSettings['apiKeySource'] = 'none';
    let apiKey = process.env.BABEL_O_API_KEY;
    if (apiKey) {
      apiKeySource = 'env';
    }
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
      } else if (providerId === 'moonshot') {
        apiKey = process.env.MOONSHOT_API_KEY;
      } else if (providerId === 'ollama') {
        apiKey = process.env.OLLAMA_API_KEY;
      }
      if (apiKey) {
        apiKeySource = 'env';
      }
    }
    if (!apiKey && profile?.apiKey) {
      apiKey = profile.apiKey;
      apiKeySource = 'profile';
    }
    if (!apiKey && provConfig.apiKey) {
      apiKey = provConfig.apiKey;
      apiKeySource = 'provider_config';
    }

    let baseUrlSource: ResolvedSettings['baseUrlSource'] = 'none';
    let baseUrl = process.env.BABEL_O_BASE_URL;
    if (baseUrl) {
      baseUrlSource = 'env';
    }
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
      } else if (providerId === 'moonshot') {
        baseUrl = process.env.MOONSHOT_BASE_URL;
      } else if (providerId === 'ollama') {
        baseUrl = process.env.OLLAMA_BASE_URL;
      }
      if (baseUrl) {
        baseUrlSource = 'env';
      }
    }
    if (!baseUrl && profile?.baseUrl) {
      baseUrl = profile.baseUrl;
      baseUrlSource = 'profile';
    }
    if (!baseUrl && provConfig.baseUrl) {
      baseUrl = provConfig.baseUrl;
      baseUrlSource = 'provider_config';
    }
    if (!baseUrl && providerDef.defaultBaseUrl) {
      baseUrl = providerDef.defaultBaseUrl;
      baseUrlSource = 'provider_default';
    }

    return {
      modelId,
      providerId,
      apiKey,
      baseUrl,
      activeProfile: activeProfileName,
      modelSource,
      apiKeySource,
      baseUrlSource,
    };
  }

  public getProviderDiagnostics(roleOrOptions?: string | ResolveSettingsOptions): ProviderDiagnostics {
    const settings = this.resolveSettings(roleOrOptions);
    const modelDiagnostics = inspectModelCapabilities(settings.modelId, settings.providerId);
    const role = typeof roleOrOptions === 'string' ? roleOrOptions : roleOrOptions?.role;
    const recommendation = isModelRole(role) ? recommendModelForRole(role) : undefined;
    return {
      providerId: settings.providerId,
      providerName: modelDiagnostics.providerName,
      adapter: modelDiagnostics.adapter,
      authMode: modelDiagnostics.authMode,
      authConfigured: modelDiagnostics.authMode === 'none' || Boolean(settings.apiKey),
      authSource: settings.apiKeySource,
      baseUrl: settings.baseUrl || '',
      baseUrlSource: settings.baseUrlSource,
      modelId: settings.modelId,
      modelName: modelDiagnostics.modelName,
      modelSource: settings.modelSource,
      activeProfile: settings.activeProfile,
      contextWindow: modelDiagnostics.contextWindow,
      defaultMaxTokens: modelDiagnostics.defaultMaxTokens,
      capabilities: modelDiagnostics.capabilities,
      modelDeclared: modelDiagnostics.modelDeclared,
      capabilitySource: modelDiagnostics.capabilitySource,
      capabilityWarning: modelDiagnostics.capabilityWarning,
      suitability: modelDiagnostics.suitability,
      roleRecommendation: recommendation ? {
        ...recommendation,
        configured: settings.modelSource === 'role',
        activeModelId: settings.modelId,
        activeModelMatchesRecommendation: settings.modelId === recommendation.modelId,
        willAutoSwitch: false,
      } : undefined,
    };
  }
}

function isModelRole(role: string | undefined): role is ModelRole {
  return role === 'planner' || role === 'executor' || role === 'critic' || role === 'optimizer';
}
