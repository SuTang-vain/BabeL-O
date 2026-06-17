import websocket from '@fastify/websocket'
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { NexusRuntime } from '../runtime/Runtime.js'
import type { EverCoreClient, EverCoreMessage } from '../runtime/everCoreClient.js'
import type { RemoteToolRunner } from '../runtime/remoteRunner.js'
import type { EverCoreRuntimeConfig, EverCoreStatus } from './everCoreConfig.js'
import {
  extractEverCoreMemoryHits,
  formatMemoryProviderHits,
  type MemoryProvider,
} from '../runtime/memoryProvider.js'
import type { RemoteRunnerStatus } from './remoteRunnerConfig.js'
import { eventBase, NEXUS_EVENT_SCHEMA_VERSION, type NexusEvent, NexusEventSchema } from '../shared/events.js'
import { createId, nowIso } from '../shared/id.js'
import type { SessionSnapshot, TaskSessionTerminalReason } from '../shared/session.js'
import { DEFAULT_SESSION_CHANNEL_POLICY, type SessionChannel, type SessionChannelPolicy, type SessionMessage } from '../shared/sessionChannel.js'
import { evaluateSessionMemoryCandidate } from '../runtime/memoryCandidateGovernance.js'
import { applyBehaviorHint, derivePaneStatus } from '../runtime/loopDiagnostics.js'
import { errorMessage } from '../shared/errors.js'
import type { NexusTask, TaskStatus } from '../shared/task.js'
import type { NexusStorage } from '../storage/Storage.js'
import { ExecutionGate } from './executionGate.js'
import { NexusMetrics, round } from './metrics.js'
import { PendingPermissionRegistry } from '../shared/session.js'
import { BABEL_O_VERSION } from '../shared/version.js'
import { isWorkspaceAllowed } from '../tools/builtin/pathSafety.js'
import { ConfigManager, validateModelSelectionAuth, type ProfileConfig } from '../shared/config.js'
import { getModel, inspectModelCapabilities, modelRegistry, providerRegistry, UnknownModelError } from '../providers/registry.js'
import { runProviderLiveSmoke, runProviderSmokeDryRun } from '../runtime/providerSmoke.js'
import { buildProviderFallbackPolicy, planProviderFallbackAction } from '../runtime/providerRecovery.js'
import {
  invokeSkill,
  listSkills,
  showSkill,
  generateDraftHandler,
  saveSkillHandler,
  SkillIdParamsSchema,
  SkillInvokeBodySchema,
  SkillListQuerySchema,
  SkillValidateBodySchema,
  SkillDraftBodySchema,
  SkillSaveBodySchema,
  validateSkillRequest,
} from './skillRoutes.js'
import { closeNexusSession } from './sessionLifecycle.js'
import { compactSession } from '../runtime/compact.js'
import { analyzeContext } from '../runtime/contextAnalysis.js'
import { assembleContext } from '../runtime/contextAssembler.js'
import { buildPostCompactGroundingEvents } from '../runtime/runtimePipeline.js'
import { buildSystemPrompt, extractAbsolutePaths, mapEventsToMessages } from '../runtime/LLMCodingRuntime.js'
import { resolvePromptPath } from '../runtime/systemPromptBuilder.js'
import { buildSessionAssetsSnapshot } from './sessionAssets.js'
import { removeWorktree } from './worktree.js'
import { ExploreAgentScheduler } from './agents/AgentScheduler.js'
import { AgentJobRegistryError } from './agents/AgentJobRegistry.js'
import type { AgentJob, AgentScheduler } from './agents/types.js'
import { readEverOSBootstrapStateSync, type EverOSBootstrapErrorCode } from '../shared/everosBootstrapStore.js'


declare module 'fastify' {
  interface FastifyRequest {
    performanceStartMs: number
  }
}

const executeSchema = z.object({
  prompt: z.string().min(1),
  sessionId: z.string().optional(),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().max(300_000).optional(),
  timeoutPolicy: z.enum(['fatal', 'soft']).optional(),
  softTimeoutMs: z.number().int().positive().max(300_000).optional(),
  watchdogTimeoutMs: z.number().int().positive().max(1_800_000).optional(),
  /**
   * Phase 3 of docs/nexus/reference/task-adaptive-recoverable-timeout-plan.md.
   * Maximum number of automatic soft-timeout extensions the runtime
   * may grant when `timeoutPolicy: 'soft'`. Each extension fires
   * after a `timeout_budget_exceeded` event and is announced with a
   * `timeout_extension_granted` event. The hard watchdog is never
   * extended.
   * Defaults to 1 — enough for the model to react to the budget
   * warning with a deliberate choice. Set to 0 to disable
   * extensions entirely (one-shot recoverable signal only).
   */
  maxSoftTimeoutExtensions: z.number().int().nonnegative().max(5).optional(),
  /**
   * Phase 3: how much extra soft budget is granted per extension.
   * Defaults to `softTimeoutMs`. Capped at 300_000ms so it can never
   * outrun the hard watchdog budget.
   */
  softTimeoutExtensionMs: z.number().int().positive().max(300_000).optional(),
  maxToolOutputBytes: z.number().int().positive().max(10_000_000).optional(),
  skipPermissionCheck: z.boolean().optional(),
  /**
   * Per-request policy override (Phase B of
   * docs/nexus/reference/go-tui-permission-policy-governance-plan.md).
   * When omitted, the server-side `executePolicyMode` default applies
   * (which itself defaults to `'strict'` for back-compat with `bbl
   * chat` and HTTP API consumers).
   *   - 'strict': tools not in the allowlist are hard-denied (existing
   *     behavior; `permission_request` never fires for them).
   *   - 'soft-deny': the hard-deny is bypassed; the existing approval
   *     gate then emits `permission_request` for write/execute-risk
   *     tools so the user can approve via the Go TUI permission panel.
   * Read-only Bash subcommands (Phase A classifier) always auto-allow
   * regardless of policy mode.
   */
  policy: z.enum(['strict', 'soft-deny']).optional(),
  /**
   * Per-request tool allowlist (Phase D of
   * docs/nexus/reference/go-tui-permission-policy-governance-plan.md).
   * When set, the runtime applies an allowlist-based policy for this
   * turn only (next turn re-evaluates from the body). The override
   * scopes to a single `executeStream` call. Empty / omitted → no
   * per-turn override; server-startup `denyByDefaultTools()` (or
   * whichever policy the runtime was constructed with) applies.
   * `*` / `all` → allowAllTools. Works orthogonally with
   * `policy: 'soft-deny'`.
   */
  allowedTools: z.array(z.string().min(1)).optional(),
  requestId: z.string().optional(),
  model: z.string().optional(),
  budget: z.number().int().positive().optional(),
  executionEnvironment: z.enum(['local', 'docker', 'remote']).default('local').optional(),
})

const booleanQuery = (defaultValue: boolean) => z.preprocess(value => {
  if (value === undefined) return defaultValue
  if (value === true || value === 'true' || value === '1') return true
  if (value === false || value === 'false' || value === '0') return false
  return value
}, z.boolean())

// escapeRegExpForWait is a minimal regex-metacharacter escape used
// by the `/v1/sessions/:id/wait` endpoint so the `match` query
// parameter is treated as a literal substring rather than a
// user-controlled regex. Substring semantics match the schema
// (z.string) and the bbl-loop plan's wait-for-event contract.
function escapeRegExpForWait(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const providerSmokeQuerySchema = z.object({
  model: z.string().optional(),
  role: z.string().optional(),
  requireTools: booleanQuery(true),
  requireStreaming: booleanQuery(true),
  requireStructuredOutput: booleanQuery(false),
})

const providerLiveSmokeSchema = z.object({
  model: z.string().optional(),
  role: z.string().optional(),
  mode: z.enum(['simple_text', 'tool_call']).default('simple_text').optional(),
  timeoutMs: z.number().int().positive().max(60_000).default(30_000).optional(),
})

const runtimeConfigSelectSchema = z.object({
  profile: z.string().min(1).max(120).optional(),
  model: z.string().optional(),
  role: z.string().optional(),
  roleModel: z.string().optional(),
}).strict()

const runtimeConfigProviderSchema = z.object({
  provider: z.string().min(1).max(80),
  apiKey: z.string().min(1).max(20_000).optional(),
  baseUrl: z.string().url().optional(),
}).strict()

const runtimeConfigProfileParamsSchema = z.object({
  name: z.string().min(1).max(120),
})

type SharedRuntimeCapabilities = {
  toolCalling: boolean
  jsonOutput: boolean
  structuredOutput: boolean
  streaming: boolean
}

// readOwnPackageVersion returns the BabeL-O package.json
// `version` field for /v1/runtime/version self-reporting. The
// resolve uses the same import.meta.url anchor that the rest
// of the Nexus process uses, so the value tracks the actual
// installed package (not the process cwd). Falls back to
// "0.0.0-unknown" if the package.json cannot be read (e.g.
// unusual install layout) so the endpoint still returns a
// well-formed response.
function readOwnPackageVersion(): string {
  try {
    const candidates = [
      fileURLToPath(new URL('../../package.json', import.meta.url)),
      fileURLToPath(new URL('../package.json', import.meta.url)),
    ]
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        const raw = readFileSync(candidate, 'utf8')
        const parsed = JSON.parse(raw) as { version?: unknown }
        if (typeof parsed.version === 'string' && parsed.version.length > 0) {
          return parsed.version
        }
      }
    }
  } catch {
    // fall through
  }
  return '0.0.0-unknown'
}

function inspectResolvedRuntimeConfig(manager: ConfigManager) {
  const settings = manager.resolveSettings()
  const base = {
    version: manager.getConfigVersion(),
    tombstones: manager.getTombstones(),
  }
  try {
    const diag = inspectModelCapabilities(settings.modelId, settings.providerId)
    return {
      ...base,
      type: 'runtime_config',
      modelId: settings.modelId,
      modelName: diag.modelName,
      providerId: settings.providerId,
      providerName: diag.providerName,
      authMode: diag.authMode,
      modelSource: settings.modelSource,
      hasApiKey: settings.apiKeySource !== 'none' && Boolean(settings.apiKey),
      apiKeySource: settings.apiKeySource,
      baseUrl: settings.baseUrl ?? '',
      baseUrlSource: settings.baseUrlSource,
      activeProfile: settings.activeProfile,
      contextWindow: diag.contextWindow,
      defaultMaxTokens: diag.defaultMaxTokens,
      capabilities: diag.capabilities,
    }
  } catch {
    return {
      ...base,
      type: 'runtime_config',
      modelId: settings.modelId,
      modelName: settings.modelId,
      providerId: settings.providerId,
      providerName: settings.providerId,
      authMode: 'api-key',
      modelSource: settings.modelSource,
      hasApiKey: settings.apiKeySource !== 'none' && Boolean(settings.apiKey),
      apiKeySource: settings.apiKeySource,
      baseUrl: settings.baseUrl ?? '',
      baseUrlSource: settings.baseUrlSource,
      activeProfile: settings.activeProfile,
      contextWindow: 0,
      defaultMaxTokens: 0,
      capabilities: {
        toolCalling: false,
        jsonOutput: false,
        structuredOutput: false,
        streaming: false,
      },
    }
  }
}

function sanitizeProfileConfig(name: string, profile: ProfileConfig, activeProfile: string | undefined) {
  const modelId = profile.model ?? ''
  const providerId = profile.provider ?? (modelId.includes('/') ? modelId.slice(0, modelId.indexOf('/')) : '')
  const base = {
    name,
    active: name === activeProfile,
    model: profile.model,
    provider: profile.provider,
    roles: profile.roles,
    hasApiKey: Boolean(profile.apiKey),
    hasBaseUrl: Boolean(profile.baseUrl),
  }
  if (!modelId || !providerId) {
    return base
  }
  try {
    const diag = inspectModelCapabilities(modelId, providerId)
    return {
      ...base,
      modelName: diag.modelName,
      providerName: diag.providerName,
      contextWindow: diag.contextWindow,
      defaultMaxTokens: diag.defaultMaxTokens,
      capabilities: diag.capabilities,
    }
  } catch {
    return base
  }
}

type RuntimeProviderAuthSource = 'none' | 'env' | 'profile' | 'provider_config'

function providerCredentialEnv(providerId: string): string | undefined {
  if (process.env.BABEL_O_API_KEY) return process.env.BABEL_O_API_KEY
  if (providerId === 'anthropic') return process.env.ANTHROPIC_API_KEY
  if (providerId === 'openai') return process.env.OPENAI_API_KEY
  if (providerId === 'deepseek') return process.env.DEEPSEEK_API_KEY
  if (providerId === 'zhipu') return process.env.ZHIPU_API_KEY || process.env.ZHIPUAI_API_KEY
  if (providerId === 'minimax') return process.env.MINIMAX_API_KEY || process.env.MINIMAX_AUTH_TOKEN
  if (providerId === 'moonshot') return process.env.MOONSHOT_API_KEY
  if (providerId === 'ollama') return process.env.OLLAMA_API_KEY
  return undefined
}

function profileProviderId(profile: ProfileConfig): string | undefined {
  if (profile.provider) return profile.provider
  if (profile.model?.includes('/')) return profile.model.slice(0, profile.model.indexOf('/'))
  return undefined
}

function resolveProviderAuthState(
  manager: ConfigManager,
  providerId: string,
): { configured: boolean; authConfigured: boolean; authSource: RuntimeProviderAuthSource } {
  const provider = providerRegistry.find(item => item.id === providerId)
  if (!provider) {
    return { configured: false, authConfigured: false, authSource: 'none' }
  }
  if (provider.authMode === 'none') {
    return { configured: true, authConfigured: true, authSource: 'none' }
  }

  const providerConfigApiKey = manager.getProviderConfig(providerId).apiKey
  const configured = Boolean(providerConfigApiKey)

  let authSource: RuntimeProviderAuthSource = 'none'
  if (providerCredentialEnv(providerId)) {
    authSource = 'env'
  } else if (Object.values(manager.getProfiles()).some(profile => Boolean(profile.apiKey) && profileProviderId(profile) === providerId)) {
    authSource = 'profile'
  } else if (providerConfigApiKey) {
    authSource = 'provider_config'
  }

  return {
    configured,
    authConfigured: authSource !== 'none',
    authSource,
  }
}

const providerFallbackPlanSchema = z.object({
  model: z.string().optional(),
  role: z.string().optional(),
  kind: z.enum([
    'max_output_tokens',
    'context_window',
    'rate_limit',
    'auth_or_billing',
    'provider_protocol',
    'provider_unavailable',
    'unknown',
  ]).default('unknown').optional(),
})

const taskMutationMetadataSchema = z.record(z.string(), z.unknown())

const taskMutationAuditSchema = z.object({
  actor: z.string().optional(),
  source: z.string().optional(),
  reason: z.string().optional(),
  requestId: z.string().optional(),
  expectedUpdatedAt: z.string().optional(),
})

const createTaskSchema = taskMutationAuditSchema.extend({
  title: z.string().min(1),
  description: z.string().optional(),
  metadata: taskMutationMetadataSchema.optional(),
})

const sessionInputSchema = z.object({
  message: z.string().min(1),
  nextPhase: z
    .enum(['created', 'executing', 'waiting_permission', 'completed', 'failed', 'cancelled'])
    .optional(),
})

const updateTaskSchema = taskMutationAuditSchema.extend({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  status: z.enum(['pending', 'in_progress', 'blocked', 'completed', 'failed', 'cancelled']).optional(),
  result: z.string().optional(),
  metadata: taskMutationMetadataSchema.optional(),
})

const taskActionSchema = taskMutationAuditSchema.extend({
  result: z.string().optional(),
  ownerAgentId: z.string().optional(),
  reviewReason: z.string().optional(),
})

const worktreeRecoveryActionSchema = taskMutationAuditSchema.extend({
  action: z.enum(['continue', 'abandon', 'keep']),
})

const subAgentRerunSchema = taskMutationAuditSchema.extend({
  mode: z.enum(['retry-task']).default('retry-task').optional(),
})

const eventListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(100),
  cursor: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('asc'),
})

const toolTraceListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(100),
  cursor: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('asc'),
})

const sessionDetailQuerySchema = z.object({
  recentEventLimit: z.coerce.number().int().min(0).max(500).default(100),
})

const sessionAssetsQuerySchema = z.object({
  eventLimit: z.coerce.number().int().min(0).max(500).default(200),
  toolTraceLimit: z.coerce.number().int().min(0).max(500).default(200),
  childSessionLimit: z.coerce.number().int().min(0).max(500).default(200),
  includeEvents: booleanQuery(true),
  includeToolTraces: booleanQuery(true),
  includePermissionAudits: booleanQuery(true),
  includeExecutionMetrics: booleanQuery(true),
})

const childSessionsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(200),
  eventLimit: z.coerce.number().int().min(0).max(100).default(5),
  failedOnly: booleanQuery(false),
  includeEvents: booleanQuery(true),
})

const sessionResumeSchema = z.object({
  recentEventLimit: z.number().int().min(0).max(500).default(100).optional(),
  includeTasks: z.boolean().default(true).optional(),
  includeChildSessions: z.boolean().default(true).optional(),
})

const sessionMessageTypeSchema = z.enum([
  'question',
  'answer',
  'finding',
  'request_review',
  'request_validation',
  'hypothesis',
  'decision',
  'blocked',
  'memory_candidate',
  'handoff',
])

const sessionChannelPolicySchema = z.object({
  allowedMessageTypes: z.array(sessionMessageTypeSchema).min(1).default(DEFAULT_SESSION_CHANNEL_POLICY.allowedMessageTypes),
  maxMessageChars: z.number().int().positive().max(20_000).default(DEFAULT_SESSION_CHANNEL_POLICY.maxMessageChars),
  maxEvidenceRefs: z.number().int().min(0).max(50).default(DEFAULT_SESSION_CHANNEL_POLICY.maxEvidenceRefs),
  allowBroadcast: z.boolean().default(DEFAULT_SESSION_CHANNEL_POLICY.allowBroadcast),
  allowMemoryWriteRequests: z.boolean().default(DEFAULT_SESSION_CHANNEL_POLICY.allowMemoryWriteRequests),
  requireUserApprovalForExternalProject: z.boolean().default(DEFAULT_SESSION_CHANNEL_POLICY.requireUserApprovalForExternalProject),
  contextInjectionMode: z.enum(['none', 'unread_summary', 'recent_messages', 'manual_only']).default(DEFAULT_SESSION_CHANNEL_POLICY.contextInjectionMode),
})

const createSessionChannelSchema = z.object({
  kind: z.enum(['direct', 'group', 'parent_child', 'workspace_pair', 'project_bridge']).default('direct').optional(),
  participantSessionIds: z.array(z.string().min(1)).min(2).max(16),
  createdBySessionId: z.string().min(1),
  policy: sessionChannelPolicySchema.partial().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

const sessionChannelListQuerySchema = z.object({
  sessionId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
})

const sessionMessageListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(100),
  cursor: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('asc'),
})

const evidenceRefSchema = z.object({
  type: z.enum(['session_event', 'tool_trace', 'file', 'url', 'note']),
  ref: z.string().min(1),
  label: z.string().optional(),
})

const createSessionMessageSchema = z.object({
  fromSessionId: z.string().min(1),
  toSessionId: z.string().min(1).optional(),
  broadcast: z.boolean().optional(),
  type: sessionMessageTypeSchema,
  content: z.string().min(1).max(20_000),
  evidence: z.array(evidenceRefSchema).optional(),
  priority: z.enum(['low', 'normal', 'high']).default('normal').optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

const sessionInboxQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(20),
  includeAcknowledged: booleanQuery(false),
})

const memorySearchSchema = z.object({
  query: z.string().min(1).max(2_000),
  topK: z.number().int().positive().max(20).optional(),
  method: z.enum(['keyword', 'vector', 'hybrid', 'agentic']).optional(),
  maxChars: z.number().int().positive().max(20_000).optional(),
  maxHitChars: z.number().int().positive().max(4_000).optional(),
})

const memoryCandidatesQuerySchema = z.object({
  sessionId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
  includeRejected: booleanQuery(true),
})

const memoryApprovalSchema = z.object({
  approved: z.boolean().optional(),
  confirmation: z.string().optional(),
  reason: z.string().optional(),
})

const memorySaveNoteSchema = memoryApprovalSchema.extend({
  note: z.string().min(1).max(4_000),
  sessionId: z.string().min(1).optional(),
  candidateMessageId: z.string().min(1).optional(),
})

const memoryFlushSchema = memoryApprovalSchema.extend({
  sessionId: z.string().min(1),
})

const memoryRestartSchema = memoryApprovalSchema

const agentSpawnSchema = z.object({
  parentSessionId: z.string().min(1),
  prompt: z.string().min(1),
  agentType: z.enum(['explore', 'review', 'test', 'implement', 'debug', 'general']).default('explore').optional(),
  contextForkMode: z.enum(['minimal', 'working-set', 'task-focused', 'full-summary', 'debug-replay']).optional(),
  isolation: z.enum(['none', 'worktree']).optional(),
  allowedTools: z.array(z.string()).optional(),
  maxRuntimeMs: z.number().int().positive().max(600_000).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

const agentListQuerySchema = z.object({
  parentSessionId: z.string().optional(),
  status: z.enum(['queued', 'running', 'waiting_permission', 'completed', 'failed', 'cancelled']).optional(),
  agentType: z.enum(['explore', 'review', 'test', 'implement', 'debug', 'general']).optional(),
})

const agentWaitSchema = z.object({
  timeoutMs: z.number().int().positive().max(600_000).optional(),
})

const agentCancelSchema = z.object({
  reason: z.string().optional(),
})

type ActiveExecution = {
  requestId: string
  abortController: AbortController
  transport: 'http' | 'websocket'
  startedAt: string
}

type ExecuteTimeoutPolicy = 'fatal' | 'soft'

type ExecuteTimeoutDecision = {
  policy: ExecuteTimeoutPolicy
  softTimeoutMs: number
  watchdogTimeoutMs: number
  /**
   * Phase 3 of task-adaptive-recoverable-timeout: how many soft
   * extensions the runtime will auto-grant after the soft budget is
   * exhausted. 0 means one-shot recoverable signal with no
   * extension. Only consulted under `policy: 'soft'`.
   */
  maxSoftTimeoutExtensions: number
  /**
   * Phase 3: how much soft budget each extension adds. Capped at
   * the remaining hard watchdog budget at issue time so we never
   * out-budget the watchdog. Only consulted under `policy: 'soft'`.
   */
  softTimeoutExtensionMs: number
}

export type CreateNexusAppOptions = {
  runtime: NexusRuntime
  storage: NexusStorage
  defaultCwd: string
  /**
   * PR-27: Optional shared WorkingSetBroadcaster. When provided, the
   * /v1/working-set/observe WebSocket and any future REST handlers that
   * opt in will share a per-cwd PersistedWorkingSetTracker instance, so
   * mutations flow into the same event bus that subscribers are listening
   * on. If not provided, a default per-app broadcaster is created.
   */
  workingSetBroadcaster?: import('./workingSetBroadcaster.js').WorkingSetBroadcaster
  /**
   * PR-A2: Optional ContextBroadcaster instance. When provided, it
   * overrides the module-level `defaultContextBroadcaster` singleton
   * used by the runtime hot path AND the instance subscribed to by
   * /v1/context/observe. Both sides share the same instance by
   * default — production apps that don't pass this option still get
   * working fan-out (the WS route and the runtime both read from the
   * singleton). Tests can pass a hermetic instance for isolation.
   */
  contextBroadcaster?: import('./contextBroadcaster.js').ContextBroadcaster
  executeTimeoutMs?: number
  /**
   * Server-side default for the per-request `policy` body field. When a
   * request body omits `policy`, this value is used. Defaults to
   * `'strict'` to preserve existing HTTP API behavior. Go TUI overrides
   * per-request to `'soft-deny'`.
   */
  executePolicyMode?: 'strict' | 'soft-deny'
  maxConcurrentExecutions?: number
  maxToolOutputBytes?: number
  bashMaxBufferBytes?: number
  apiKey?: string
  remoteRunner?: RemoteToolRunner
  remoteRunnerStatus?: RemoteRunnerStatus
  everCoreClient?: EverCoreClient
  everCoreConfig?: EverCoreRuntimeConfig
  everCoreStatus?: EverCoreStatus
  memoryProvider?: MemoryProvider
  agentScheduler?: AgentScheduler
  agentExecutionEnvironment?: 'local' | 'remote'
}

type WebSocketLike = {
  OPEN: number
  readyState: number
  bufferedAmount: number
  send(payload: string): void
}

type MemoryApprovalResult =
  | { approved: true }
  | { approved: false; response: Record<string, unknown> }

function isEverCoreAvailable(status: EverCoreStatus): boolean {
  return status.enabled && status.healthy
}

function memoryUnavailablePayload(status: EverCoreStatus) {
  return {
    type: 'error',
    code: 'EVERCORE_MEMORY_UNAVAILABLE',
    message: 'Long-term memory is not available for this runtime.',
    everCore: status,
  }
}

function requireMemoryApproval(action: 'save-note' | 'flush' | 'restart', input: {
  approved?: boolean
  confirmation?: string
  reason?: string
}): MemoryApprovalResult {
  const confirmation = input.confirmation?.trim().toLowerCase()
  const confirmed = input.approved === true || confirmation === action || confirmation === `memory:${action}`
  if (confirmed) return { approved: true }
  return {
    approved: false,
    response: {
      type: 'memory_action_approval_required',
      action,
      approved: false,
      risk: action === 'restart' ? 'lifecycle_execute' : 'write_lifecycle',
      requiredConfirmation: action,
      guidance: action === 'save-note'
        ? 'Memory save is write-risk. Re-submit with approved=true or confirmation="save-note" after user approval.'
        : `Memory ${action} is a lifecycle operation. Re-submit with approved=true or confirmation="${action}" after explicit user confirmation.`,
      ...(input.reason && { reason: input.reason }),
    },
  }
}

function buildApprovedMemoryNoteMessages(input: {
  note: string
  config: EverCoreRuntimeConfig
}): EverCoreMessage[] {
  const timestamp = Date.now()
  return [
    {
      sender_id: input.config.userId ?? 'local-user',
      sender_name: 'User',
      role: 'user',
      timestamp,
      content: input.note,
    },
    {
      sender_id: input.config.agentId,
      sender_name: 'BabeL-O',
      role: 'assistant',
      timestamp: timestamp + 1,
      content: `Approved long-term memory note saved: ${input.note}`,
    },
  ]
}

export async function createNexusApp(
  options: CreateNexusAppOptions,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  const metrics = new NexusMetrics()
  const apiKey = options.apiKey ?? process.env.NEXUS_API_KEY
  const executeTimeoutMs = options.executeTimeoutMs ?? 30_000
  const executePolicyMode = options.executePolicyMode ?? 'strict'
  // PR-27: default per-app broadcaster. Tests can override via options.
  const appBroadcaster = options.workingSetBroadcaster ?? new WorkingSetBroadcaster()
  // PR-A2: if the caller provided a custom ContextBroadcaster, install
  // it as the module-level singleton so the runtime hot path and the
  // /v1/context/observe WebSocket route share the same instance. When
  // no option is provided, the singleton stays untouched and both sides
  // share the default instance.
  if (options.contextBroadcaster) {
    setDefaultContextBroadcaster(options.contextBroadcaster)
  }
  const maxToolOutputBytes = options.maxToolOutputBytes ?? 200_000
  const bashMaxBufferBytes = options.bashMaxBufferBytes ?? 1_000_000
  const executionGate = new ExecutionGate(options.maxConcurrentExecutions ?? 8)
  const activeExecutions = new Map<string, ActiveExecution>()
  const agentScheduler = options.agentScheduler ?? new ExploreAgentScheduler({
    storage: options.storage,
    cwd: options.defaultCwd,
    executionEnvironment: options.agentExecutionEnvironment,
    remoteRunner: options.remoteRunner,
  })
  await app.register(websocket)

  const everCoreStatus = () => options.everCoreStatus ?? {
    configured: false,
    enabled: false,
    healthy: true,
    mode: 'disabled' as const,
    uploadOnSessionEnd: false,
    mcpToolsEnabled: false,
    namespace: {
      layer: 'project_memory' as const,
      isolationKey: 'projectId' as const,
      sessionScoped: false,
      projectIdSource: 'default' as const,
    },
  }

  /**
   * MemoryOS bootstrap status snapshot used by `/v1/runtime/status`
   * (and `/v1/runtime/memory/status`). The Go TUI's persistent
   * `[m: …]` footer reads this field via the runtime status poll,
   * so the function must be safe to call synchronously on every
   * poll — the underlying `readEverOSBootstrapStateSync` is a single
   * readFileSync, not a network round-trip.
   */
  const everOSBootstrapStatus = (): {
    configured: boolean
    path: string
    status: 'not_configured' | 'invalid' | string
    optedIn?: boolean
    optedOut?: boolean
    externalHintShown?: boolean
    sourceRepo?: string
    sourceRef?: string
    sourceCommit?: string
    sourceDir?: string
    dataDir?: string
    managedCommand?: string
    lastCheckedAt?: string
    lastBuildAt?: string
    errorCode?: EverOSBootstrapErrorCode
    errorMessage?: string
    autoBootstrapPolicy?: 'off' | 'on' | 'prompt'
    fallbackBuildTool?: 'uv' | 'pip' | 'none'
    mcpToolsEnabled?: boolean
  } => {
    const read = readEverOSBootstrapStateSync()
    if (!read.ok) {
      return {
        configured: false,
        path: read.path,
        status: 'invalid',
        errorCode: read.errorCode,
        errorMessage: read.errorMessage,
      }
    }
    if (!read.exists || !read.state) {
      return {
        configured: false,
        path: read.path,
        status: 'not_configured',
      }
    }
    return {
      configured: true,
      path: read.path,
      status: read.state.buildStatus ?? 'not_started',
      optedIn: read.state.optedIn === true,
      optedOut: read.state.optedOut === true,
      externalHintShown: read.state.externalHintShown === true,
      sourceRepo: read.state.sourceRepo,
      sourceRef: read.state.sourceRef,
      sourceCommit: read.state.sourceCommit,
      sourceDir: read.state.sourceDir,
      dataDir: read.state.dataDir,
      managedCommand: read.state.managedCommand,
      lastCheckedAt: read.state.lastCheckedAt,
      lastBuildAt: read.state.lastBuildAt,
      errorCode: read.state.errorCode ?? undefined,
      errorMessage: read.state.errorMessage ?? undefined,
      autoBootstrapPolicy: read.state.autoBootstrapPolicy,
      fallbackBuildTool: read.state.fallbackBuildTool,
      mcpToolsEnabled: read.state.mcpToolsEnabled,
    }
  }

  app.setErrorHandler((error: any, request, reply) => {
    const isValidationError =
      error.validation ||
      error.name === 'ZodError' ||
      error.statusCode === 400

    if (isValidationError) {
      return reply.status(400).send({
        type: 'error',
        code: 'INVALID_REQUEST',
        message: error.message || String(error),
      })
    }

    const code = (error as { code?: string }).code || 'INTERNAL_ERROR'
    const statusCode = error.statusCode || 500
    return reply.status(statusCode).send({
      type: 'error',
      code,
      message: error.message || String(error),
    })
  })

  app.addHook('onRequest', async request => {
    request.performanceStartMs = metrics.now()
  })

  if (apiKey) {
    app.addHook('onRequest', async (request, reply) => {
      const pathname = request.url.split('?')[0]
      if (pathname === '/health') {
        return
      }

      const authHeader = request.headers['authorization']
      let clientKey = request.headers['x-nexus-api-key']
      if (!clientKey && typeof authHeader === 'string') {
        const parts = authHeader.split(' ')
        if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
          clientKey = parts[1]
        }
      }

      if (clientKey !== apiKey) {
        return reply.code(401).send({
          type: 'error',
          code: 'UNAUTHORIZED',
          message: 'Unauthorized: Invalid or missing API key',
        })
      }
    })
  }

  app.addHook('onResponse', async (request, reply) => {
    metrics.recordRoute(
      `${request.method} ${request.routeOptions.url ?? request.url}`,
      reply.statusCode,
      metrics.now() - request.performanceStartMs,
    )
  })

  app.get('/health', async () => ({
    status: 'ok',
    version: BABEL_O_VERSION,
    runtime: 'babel-o',
    timestamp: nowIso(),
  }))

  app.get('/v1/runtime/status', async () => ({
    type: 'runtime_status',
    health: {
      status: 'ok',
      version: BABEL_O_VERSION,
    },
    provider: ConfigManager.getInstance().getProviderDiagnostics(),
    providerSmoke: runProviderSmokeDryRun(),
    remoteRunner: options.remoteRunnerStatus ?? {
      configured: options.remoteRunner !== undefined,
      required: false,
      healthy: options.remoteRunner !== undefined,
      id: options.remoteRunner?.id,
      capabilities: options.remoteRunner?.capabilities,
    },
    everCore: everCoreStatus(),
    // MemoryOS bootstrap state must live on the same payload the
    // Go TUI polls. Without it, the persistent `[m: …]` footer
    // indicator would always render `[m: off]` because the Go
    // TUI cannot see the bootstrap file directly.
    bootstrap: everOSBootstrapStatus(),
    metrics: await buildRuntimeMetricsSnapshot(metrics, options.storage),
    sessions: await options.storage.listSessions({ limit: 20 }),
  }))

  // bbl loop plan Phase 1a: per-session health snapshot derived
  // from a bounded event slice (default lastN=200). Aggregates
  // status from derivePaneStatus + a lightweight taskScope
  // projection so the multi-pane TUI can render sidebars without
  // each pane re-deriving truth. Filters by workspaceId/paneId/
  // sessionId when provided; returns all known sessions
  // otherwise. loop_state persistence will replace the implicit
  // "every known session" walk in Phase 1b.
  const loopHealthQuerySchema = z.object({
    workspaceId: z.string().max(128).optional(),
    paneId: z.string().max(128).optional(),
    sessionId: z.string().max(256).optional(),
    lastN: z.coerce.number().int().positive().max(1000).default(200),
  })

  type TaskScopeSummary = {
    cwd: string
    primaryRoot: string
    explicitRoots: string[]
    confirmedExternalRoots: string[]
    inferredCandidateRoots: string[]
    mode: 'single_root' | 'multi_root' | 'cross_project'
    source: 'cwd' | 'prompt_paths' | 'user_confirmation' | 'session_metadata'
    latestDeclaredAt: string
  }

  function summarizeTaskScope(events: NexusEvent[]): TaskScopeSummary {
    let summary: TaskScopeSummary = {
      cwd: '',
      primaryRoot: '',
      explicitRoots: [],
      confirmedExternalRoots: [],
      inferredCandidateRoots: [],
      mode: 'single_root',
      source: 'cwd',
      latestDeclaredAt: '',
    }
    for (const event of events) {
      if (event.type !== 'task_scope_declared') continue
      if (event.timestamp < summary.latestDeclaredAt) continue
      summary = {
        cwd: event.cwd,
        primaryRoot: event.primaryRoot,
        explicitRoots: [...event.explicitRoots],
        confirmedExternalRoots: [...event.confirmedExternalRoots],
        inferredCandidateRoots: [...event.inferredCandidateRoots],
        mode: event.mode,
        source: event.source,
        latestDeclaredAt: event.timestamp,
      }
    }
    return summary
  }

  // PR-14: derive a BehaviorHintProjection for a session by reading
  // cross-session (source=nexus) trace entries from .babel-o/behavior-trace.jsonl
  // and applying the 5min cooldown window.
  function summarizeBehaviorHint(cwd: string, sessionId: string): {
    pendingHints: number
    lastHintAt?: number
    lastHintPattern?: string
  } {
    const tracePath = _resolve(cwd, BEHAVIOR_TRACE_RELATIVE_PATH)
    if (!_existsSync(tracePath)) {
      return { pendingHints: 0 }
    }
    let raw: string
    try {
      raw = _readFileSync(tracePath, 'utf8')
    } catch {
      return { pendingHints: 0 }
    }
    const now = Date.now()
    const cooldownMs = 5 * 60_000
    let pendingHints = 0
    let lastHintAt: number | undefined
    let lastHintPattern: string | undefined
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let entry: BehaviorTraceEntry
      try {
        entry = JSON.parse(trimmed) as BehaviorTraceEntry
      } catch {
        continue
      }
      if (entry.sessionId !== sessionId) continue
      const source = (entry.anomaly as { source?: string } | undefined)?.source
      if (source !== 'nexus') continue
      const ts = Date.parse(entry.timestamp)
      if (!Number.isFinite(ts) || ts < now - cooldownMs) continue
      pendingHints += 1
      const tsMs = ts
      if (lastHintAt === undefined || tsMs > lastHintAt) {
        lastHintAt = tsMs
        lastHintPattern = entry.anomaly?.errorMessage
          || entry.anomaly?.errorCode
          || entry.anomaly?.driftPath
          || entry.anomaly?.denialReason
          || entry.anomaly?.userRedirectSignal
          || undefined
      }
    }
    return { pendingHints, lastHintAt, lastHintPattern }
  }

  app.get('/v1/runtime/loop/health', async (request, reply) => {
    const query = loopHealthQuerySchema.parse(request.query)
    const candidateIds = new Set<string>()
    if (query.sessionId) candidateIds.add(query.sessionId)
    let sessionList: SessionSnapshot[]
    try {
      sessionList = await options.storage.listSessions({ limit: 500 })
    } catch (err) {
      return reply.code(500).send({
        type: 'error',
        code: 'LOOP_HEALTH_FAILED',
        message: errorMessage(err),
      })
    }
    for (const session of sessionList) {
      if (query.workspaceId && query.workspaceId !== 'all') {
        // Phase 1b will replace this with a workspace_id column.
        // For now every session is included unless the caller
        // narrows by sessionId or paneId explicitly.
      }
      candidateIds.add(session.sessionId)
    }
    if (candidateIds.size === 0) {
      return {
        type: 'loop_health',
        panes: [],
        filter: {
          workspaceId: query.workspaceId,
          paneId: query.paneId,
          sessionId: query.sessionId,
          lastN: query.lastN,
        },
      }
    }

    const panes: Array<Record<string, unknown>> = []
    for (const sessionId of candidateIds) {
      let events: NexusEvent[]
      try {
        const page = await options.storage.listEvents(sessionId, {
          order: 'desc',
          limit: query.lastN,
        })
        events = page.events
      } catch (err) {
        panes.push({
          sessionId,
          error: errorMessage(err),
        })
        continue
      }
      const status = derivePaneStatus({ events })
      const taskScope = summarizeTaskScope(events)
      // PR-14: derive behavior hint projection from cross-session trace file
      // and apply via applyBehaviorHint (PR-6). This may upgrade status to
      // 'behaviorHint' if there are recent cross-session detections.
      const hintProjection = summarizeBehaviorHint(
        taskScope.cwd || options.storage.toString?.() || '',
        sessionId,
      )
      const finalSnapshot = applyBehaviorHint(status, {
        pendingHints: hintProjection.pendingHints,
        lastHintAt: hintProjection.lastHintAt,
        lastHintPattern: hintProjection.lastHintPattern,
      })
      panes.push({
        sessionId,
        agent: 'bbl',
        status: finalSnapshot.status,
        pendingPermissions: finalSnapshot.pendingPermissions,
        pendingScopeBoundaries: finalSnapshot.pendingScopeBoundaries,
        outOfScopeEvidence: finalSnapshot.outOfScopeEvidence,
        lastEventRev: finalSnapshot.lastEventSeq,
        lastEventAt: finalSnapshot.lastEventAt,
        taskScope,
        pendingHints: finalSnapshot.pendingHints,
        lastHintAt: finalSnapshot.lastHintAt,
        lastHintPattern: finalSnapshot.lastHintPattern,
      })
    }

    return {
      type: 'loop_health',
      panes,
      filter: {
        workspaceId: query.workspaceId,
        paneId: query.paneId,
        sessionId: query.sessionId,
        lastN: query.lastN,
      },
    }
  })

  // bbl loop plan Phase 1b: per-pane workspace/tab/pane ↔
  // session mapping. Lets multi-pane TUI restore across
  // server restarts and reconcile against local snapshot.
  const loopPaneUpsertSchema = z.object({
    paneId: z.string().min(1).max(128),
    workspaceId: z.string().min(1).max(128),
    tabId: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(256),
    agent: z.string().min(1).max(64),
    cwd: z.string().min(1).max(4096),
    label: z.string().max(256).nullable().optional(),
    lastRev: z.number().int().min(0).default(0),
  })

  app.post('/v1/loop/workspaces/:workspaceId/panes', async (request, reply) => {
    const params = z.object({ workspaceId: z.string() }).parse(request.params)
    const body = loopPaneUpsertSchema.parse(request.body)
    if (body.workspaceId !== params.workspaceId) {
      return reply.code(400).send({
        type: 'error',
        code: 'WORKSPACE_MISMATCH',
        message: `workspaceId in body (${body.workspaceId}) does not match URL (${params.workspaceId}).`,
      })
    }
    const pane = await options.storage.upsertLoopPane({
      paneId: body.paneId,
      workspaceId: body.workspaceId,
      tabId: body.tabId,
      sessionId: body.sessionId,
      agent: body.agent,
      cwd: body.cwd,
      label: body.label ?? null,
      lastRev: body.lastRev,
      updatedAt: new Date().toISOString(),
    })
    return { type: 'loop_pane', pane }
  })

  app.patch(
    '/v1/loop/workspaces/:workspaceId/tabs/:tabId/panes/:paneId',
    async (request, reply) => {
      const params = z
        .object({
          workspaceId: z.string(),
          tabId: z.string(),
          paneId: z.string(),
        })
        .parse(request.params)
      const body = z
        .object({
          label: z.string().max(256).nullable().optional(),
          lastRev: z.number().int().min(0).optional(),
          cwd: z.string().min(1).max(4096).optional(),
          sessionId: z.string().min(1).max(256).optional(),
        })
        .parse(request.body)
      const existing = await options.storage.listLoopPanes({ paneId: params.paneId })
      const current = existing[0]
      if (!current) {
        return reply.code(404).send({
          type: 'error',
          code: 'PANE_NOT_FOUND',
          message: `Pane not found: ${params.paneId}`,
        })
      }
      const merged: typeof current = {
        ...current,
        workspaceId: params.workspaceId,
        tabId: params.tabId,
        label: body.label === undefined ? current.label : body.label,
        cwd: body.cwd ?? current.cwd,
        sessionId: body.sessionId ?? current.sessionId,
        lastRev: body.lastRev ?? current.lastRev,
        updatedAt: new Date().toISOString(),
      }
      await options.storage.upsertLoopPane(merged)
      return { type: 'loop_pane', pane: merged }
    },
  )

  app.delete(
    '/v1/loop/workspaces/:workspaceId/tabs/:tabId/panes/:paneId',
    async (request, reply) => {
      const params = z
        .object({
          workspaceId: z.string(),
          tabId: z.string(),
          paneId: z.string(),
        })
        .parse(request.params)
      const deleted = await options.storage.deleteLoopPane(params.paneId)
      if (!deleted) {
        return reply.code(404).send({
          type: 'error',
          code: 'PANE_NOT_FOUND',
          message: `Pane not found: ${params.paneId}`,
        })
      }
      return { type: 'loop_pane_deleted', paneId: params.paneId }
    },
  )

  app.get('/v1/loop/workspaces', async request => {
    const query = z
      .object({
        workspaceId: z.string().max(128).optional(),
        sessionId: z.string().max(256).optional(),
      })
      .parse(request.query)
    const panes = await options.storage.listLoopPanes({
      workspaceId: query.workspaceId,
      sessionId: query.sessionId,
    })
    return {
      type: 'loop_workspaces',
      panes,
      filter: {
        workspaceId: query.workspaceId ?? null,
        sessionId: query.sessionId ?? null,
      },
    }
  })

  app.get('/v1/runtime/memory/status', async () => {
    const everCore = everCoreStatus()
    const capabilityAvailable = isEverCoreAvailable(everCore)
    return {
      type: 'memory_status',
      capability: {
        available: capabilityAvailable,
        longTermMemory: capabilityAvailable,
        autoSearch: 'cue-driven',
        save: 'permission-gated',
        authoritative: false,
      },
      everCore,
      guidance: {
        memoryIsHint: true,
        projectFactsRequireWorkspaceEvidence: true,
        candidatesAutoWrite: false,
        flushRuntimeOwned: true,
      },
      actions: {
        status: 'read',
        search: 'read',
        candidates: 'read',
        saveNote: 'write_permission_gated',
        flush: 'lifecycle_permission_gated',
        restart: 'lifecycle_permission_gated',
      },
    }
  })

  app.post('/v1/runtime/memory/search', async (request, reply) => {
    const body = memorySearchSchema.parse(request.body ?? {})
    const everCore = everCoreStatus()
    if (!isEverCoreAvailable(everCore) || !options.everCoreClient || !options.everCoreConfig) {
      return reply.code(503).send(memoryUnavailablePayload(everCore))
    }
    const config = options.everCoreConfig
    const topK = body.topK ?? config.topK
    const maxChars = body.maxChars ?? config.maxContentChars ?? 4_000
    const maxHitChars = body.maxHitChars ?? 800
    const started = metrics.now()
    const envelope = await options.everCoreClient.search({
      query: body.query,
      appId: config.appId,
      projectId: config.projectId,
      userId: config.userId,
      agentId: config.userId ? undefined : config.agentId,
      method: body.method ?? config.retrieveMethod,
      topK,
    })
    const hits = extractEverCoreMemoryHits(envelope)
    const formatted = formatMemoryProviderHits(hits, {
      maxContextChars: maxChars,
      maxHitChars,
      maxHits: topK,
    })
    return {
      type: 'memory_search_result',
      query: body.query,
      provider: 'evercore',
      hitCount: formatted.hitCount,
      totalExtractedHits: hits.length,
      injectedChars: formatted.content.length,
      budgetChars: maxChars,
      maxHitChars,
      truncated: formatted.truncated,
      searchLatencyMs: Math.round(metrics.now() - started),
      method: body.method ?? config.retrieveMethod,
      topK,
      content: formatted.content,
      hits: hits.slice(0, topK).map(hit => ({
        content: hit.content.length > maxHitChars ? `${hit.content.slice(0, maxHitChars)}...` : hit.content,
        ...(hit.source && { source: hit.source }),
        ...(hit.score !== undefined && { score: hit.score }),
      })),
      guidance: {
        memoryIsHint: true,
        projectFactsRequireWorkspaceEvidence: true,
      },
    }
  })

  app.get('/v1/runtime/memory/candidates', async request => {
    const query = memoryCandidatesQuerySchema.parse(request.query)
    const channels = await options.storage.listSessionChannels({
      sessionId: query.sessionId,
      limit: Math.max(query.limit, 100),
    })
    const candidates: SessionMessage[] = []
    for (const channel of channels) {
      const page = await options.storage.listSessionMessages(channel.channelId, {
        limit: query.limit,
        order: 'desc',
      })
      for (const message of page.messages) {
        if (message.type !== 'memory_candidate') continue
        const governance = message.metadata?.memoryCandidateGovernance as Record<string, unknown> | undefined
        if (!query.includeRejected && governance?.decision === 'rejected') continue
        candidates.push(message)
      }
    }
    candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.messageId.localeCompare(a.messageId))
    const limited = candidates.slice(0, query.limit)
    return {
      type: 'memory_candidates',
      candidates: limited.map(message => ({
        messageId: message.messageId,
        channelId: message.channelId,
        fromSessionId: message.fromSessionId,
        toSessionId: message.toSessionId,
        broadcast: message.broadcast,
        content: message.content,
        evidence: message.evidence ?? [],
        priority: message.priority,
        createdAt: message.createdAt,
        status: message.status,
        governance: message.metadata?.memoryCandidateGovernance ?? null,
      })),
      limit: query.limit,
      includeRejected: query.includeRejected,
      guidance: {
        autoWrite: false,
        reviewOnly: true,
        saveRequiresApproval: true,
      },
    }
  })

  app.post('/v1/runtime/memory/save-note', async (request, reply) => {
    const body = memorySaveNoteSchema.parse(request.body ?? {})
    const approval = requireMemoryApproval('save-note', body)
    if (!approval.approved) return reply.code(202).send(approval.response)
    const everCore = everCoreStatus()
    if (!isEverCoreAvailable(everCore) || !options.everCoreClient || !options.everCoreConfig) {
      return reply.code(503).send(memoryUnavailablePayload(everCore))
    }
    const sessionId = body.sessionId ?? createId('memory_note')
    const note = body.note.trim()
    const messages = buildApprovedMemoryNoteMessages({ note, config: options.everCoreConfig })
    const envelope = await options.everCoreClient.addAgentMessages({
      sessionId,
      appId: options.everCoreConfig.appId,
      projectId: options.everCoreConfig.projectId,
      messages,
    })
    return {
      type: 'memory_note_saved',
      provider: 'evercore',
      sessionId,
      candidateMessageId: body.candidateMessageId,
      savedMessages: messages.length,
      savedChars: note.length,
      envelope,
      guidance: {
        searchCacheInvalidated: true,
        memoryIsHint: true,
      },
    }
  })

  app.post('/v1/runtime/memory/flush', async (request, reply) => {
    const body = memoryFlushSchema.parse(request.body ?? {})
    const approval = requireMemoryApproval('flush', body)
    if (!approval.approved) return reply.code(202).send(approval.response)
    const everCore = everCoreStatus()
    if (!isEverCoreAvailable(everCore) || !options.everCoreClient || !options.everCoreConfig) {
      return reply.code(503).send(memoryUnavailablePayload(everCore))
    }
    const envelope = await options.everCoreClient.flushAgentSession({
      sessionId: body.sessionId,
      appId: options.everCoreConfig.appId,
      projectId: options.everCoreConfig.projectId,
    })
    return {
      type: 'memory_session_flushed',
      provider: 'evercore',
      sessionId: body.sessionId,
      flushed: true,
      envelope,
      guidance: {
        searchCacheInvalidated: true,
        runtimeOwned: true,
      },
    }
  })

  app.post('/v1/runtime/memory/restart', async (request, reply) => {
    const body = memoryRestartSchema.parse(request.body ?? {})
    const approval = requireMemoryApproval('restart', body)
    if (!approval.approved) return reply.code(202).send(approval.response)
    return reply.code(501).send({
      type: 'error',
      code: 'MEMORY_RESTART_NOT_IMPLEMENTED',
      message: 'Memory restart is permission-gated but not implemented in this runtime yet.',
      guidance: {
        restartRequiresRuntimeManagerOwnership: true,
        useProcessRestartForNow: true,
      },
    })
  })

  app.get('/v1/runtime/provider-smoke', async request => {
    const query = providerSmokeQuerySchema.parse(request.query)
    return runProviderSmokeDryRun({
      model: query.model,
      role: query.role,
      requireTools: query.requireTools,
      requireStreaming: query.requireStreaming,
      requireStructuredOutput: query.requireStructuredOutput,
    })
  })

  app.post('/v1/runtime/provider-smoke/live', async request => {
    const body = providerLiveSmokeSchema.parse(request.body ?? {})
    return runProviderLiveSmoke({
      model: body.model,
      role: body.role,
      mode: body.mode,
      timeoutMs: body.timeoutMs,
    })
  })

  app.post('/v1/runtime/provider-fallback/plan', async request => {
    const body = providerFallbackPlanSchema.parse(request.body ?? {})
    const provider = ConfigManager.getInstance().getProviderDiagnostics({
      model: body.model,
      role: body.role,
    })
    const recoveryKind = body.kind ?? 'unknown'
    return planProviderFallbackAction({
      provider,
      recoveryKind,
      policy: buildProviderFallbackPolicy(recoveryKind),
    })
  })

  app.get('/v1/runtime/metrics', async () => buildRuntimeMetricsSnapshot(metrics, options.storage))

  // === 路径 C: Go TUI 配置拉取端点 ===

  // GET /v1/runtime/config — 当前 ResolvedSettings (脱敏: 不返回 apiKey)
  // ?since=<version> 增量拉取: since >= version 时返回 304 Not Modified
  app.get('/v1/runtime/config', async (request, reply) => {
    const manager = ConfigManager.getInstance()
    const sinceRaw = (request.query as { since?: string | number }).since
    const since = sinceRaw === undefined ? -1 : Number(sinceRaw)
    if (Number.isFinite(since) && since >= 0) {
      const version = manager.getConfigVersion()
      if (since >= version) {
        return reply.code(304).send()
      }
    }
    return inspectResolvedRuntimeConfig(manager)
  })

  // GET /v1/runtime/version — Phase 8 PR1: 客户端版本协商端点
  // 返回 BabeL-O Nexus server 自己的版本、当前 Nexus schema
  // 版本（用于客户端做兼容性检查）、以及 CLI / Go TUI
  // 兼容性范围。客户端启动时拉这个端点做 major-version
  // 校验；major 必须落在兼容范围内。响应脱敏，不返回
  // 任何 secret。
  app.get('/v1/runtime/version', async () => {
    const rawVersion = readOwnPackageVersion()
    return {
      type: 'runtime_version' as const,
      serverVersion: rawVersion,
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      goTuiCompatibility: {
        // 当前 Nexus 兼容的 Go TUI 客户端 major 范围。
        // Phase 8 PR1 阶段只有一个 major（0），bump 时
        // 手动维护即可；未来可以加 "min / max" 二元组。
        supportedMajors: [0],
        latestSupported: rawVersion,
      },
      nodeCliCompatibility: {
        supportedMajors: [0],
        latestSupported: rawVersion,
      },
    }
  })


  // GET /v1/runtime/config/profiles — profile 清单 (脱敏: 不返回 apiKey/baseUrl)
  app.get('/v1/runtime/config/profiles', async () => {
    const manager = ConfigManager.getInstance()
    const activeProfile = manager.getActiveProfile()
    return {
      type: 'runtime_config_profiles',
      version: manager.getConfigVersion(),
      activeProfile,
      profiles: Object.entries(manager.getProfiles()).map(([name, profile]) =>
        sanitizeProfileConfig(name, profile, activeProfile),
      ),
      tombstones: manager.getTombstones(),
    }
  })

  // GET /v1/runtime/config/profiles/:name — 单 profile 详情 (脱敏)
  app.get('/v1/runtime/config/profiles/:name', async request => {
    const params = runtimeConfigProfileParamsSchema.parse(request.params)
    const manager = ConfigManager.getInstance()
    const profile = manager.getProfiles()[params.name]
    const base = {
      type: 'runtime_config_profile',
      version: manager.getConfigVersion(),
      tombstones: manager.getTombstones(),
    }
    if (!manager.hasProfile(params.name) || !profile) {
      return {
        ...base,
        found: false,
        name: params.name,
      }
    }
    return {
      ...base,
      found: true,
      profile: sanitizeProfileConfig(params.name, profile, manager.getActiveProfile()),
    }
  })

  // GET /v1/runtime/models — provider + model 清单 (含配置状态)
  app.get('/v1/runtime/models', async () => {
    const manager = ConfigManager.getInstance()
    const settings = manager.resolveSettings()
    return {
      type: 'runtime_models',
      version: manager.getConfigVersion(),
      tombstones: manager.getTombstones(),
      providers: providerRegistry.map((p) => {
        const authState = resolveProviderAuthState(manager, p.id)
        return {
          id: p.id,
          displayName: p.displayName,
          adapter: p.adapter,
          authMode: p.authMode,
          defaultBaseUrl: p.defaultBaseUrl,
          defaultModel: p.defaultModel,
          configured: authState.configured,
          authConfigured: authState.authConfigured,
          authSource: authState.authSource,
          active: settings.providerId === p.id,
          models: p.models.map((mid) => {
            const def = modelRegistry.find((m) => m.id === mid)
            return {
              id: mid,
              name: def?.name ?? mid,
              contextWindow: def?.contextWindow ?? 0,
              defaultMaxTokens: def?.defaultMaxTokens ?? 0,
              capabilities: def?.capabilities ?? {
                toolCalling: false,
                jsonOutput: false,
                streaming: false,
              },
            }
          }),
        }
      }),
      defaultModel: settings.modelId,
      activeProfile: settings.activeProfile,
    }
  })

  app.post('/v1/runtime/config/provider', async (request, reply) => {
    const body = runtimeConfigProviderSchema.parse(request.body ?? {})
    const manager = ConfigManager.getInstance()
    if (!providerRegistry.some(provider => provider.id === body.provider)) {
      return reply.code(400).send({
        error: 'unknown_provider',
        provider: body.provider,
        message: 'provider id is not present in the providerRegistry',
      })
    }

    const existing = manager.getProviderConfig(body.provider)
    manager.setProviderConfig(body.provider, {
      apiKey: body.apiKey ?? existing.apiKey,
      baseUrl: body.baseUrl ?? existing.baseUrl,
    })
    return inspectResolvedRuntimeConfig(manager)
  })

  // POST /v1/runtime/config/select — 切换 active profile / default model (持久化)
  //
  // 三种互斥形态:
  //   1) {profile: "<name>"}      — 切换 active profile
  //   2) {model: "<provider>/<id>"} — 切换 default model (供 Go TUI /model Step 4
  //                                   一类 Picker 写入),不修改 active profile;
  //                                   若 model 不在 modelRegistry 中 → 400
  //   3) 字段都缺 — 400
  // role / roleModel 仍由 `bbl config` CLI 处理。
  app.post('/v1/runtime/config/select', async (request, reply) => {
    const body = runtimeConfigSelectSchema.parse(request.body ?? {})
    const manager = ConfigManager.getInstance()

    if (body.role || body.roleModel) {
      return reply.code(400).send({
        error: 'not_supported',
        message: 'role / roleModel switching is not supported in this endpoint; use `bbl config` CLI',
      })
    }

    const hasProfile = typeof body.profile === 'string' && body.profile.length > 0
    const hasModel = typeof body.model === 'string' && body.model.length > 0

    if (hasProfile && hasModel) {
      return reply.code(400).send({
        error: 'mutually_exclusive',
        message: 'pass either `profile` or `model`, not both',
      })
    }

    if (!hasProfile && !hasModel) {
      return reply.code(400).send({ error: 'missing_field', message: 'pass `profile` or `model`' })
    }

    if (hasProfile) {
      const profileName = body.profile as string
      if (manager.isProfileTombstoned(profileName)) {
        return reply.code(400).send({
          error: 'tombstoned_profile',
          profile: profileName,
          tombstone: manager.getTombstones()[profileName],
        })
      }

      if (!manager.hasProfile(profileName)) {
        return reply.code(400).send({ error: 'unknown_profile', profile: profileName })
      }

      manager.setActiveProfile(profileName)
      return inspectResolvedRuntimeConfig(manager)
    }

    // hasModel
    const modelId = body.model as string
    if (!modelRegistry.some(entry => entry.id === modelId)) {
      return reply.code(400).send({
        error: 'unknown_model',
        model: modelId,
        message: 'model id is not present in the modelRegistry',
      })
    }

    const authIssue = validateModelSelectionAuth(manager, modelId)
    if (authIssue) {
      return reply.code(400).send({
        error: 'missing_provider_api_key',
        provider: authIssue.providerId,
        model: authIssue.modelId,
        authMode: authIssue.authMode,
        authSource: authIssue.authSource,
        command: authIssue.command,
        message: authIssue.message,
      })
    }

    manager.setDefaultModel(modelId, { clearActiveProfile: true })
    return inspectResolvedRuntimeConfig(manager)
  })

  // === 路径 C: 结束 ===

  app.get('/v1/schema/events', async () => {
    return z.toJSONSchema(NexusEventSchema)
  })

  // PR-11: Track A Phase 2 — context history REST endpoint.
  // Reuses PR-7 data layer (searchEvents, summarizeWindow) and PR-10
  // parseSince helper. Read-only, no Nexus server state required.
  app.get('/v1/context/history', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    const cwd = q.cwd
    if (!cwd) {
      return reply.code(400).send({ error: 'cwd query param is required' })
    }
    const scope = (q.scope === 'search' ? 'search' : 'summarize') as 'search' | 'summarize'
    const query = q.query
    const maxTokens = q.maxTokens ? Number(q.maxTokens) : 5000
    if (Number.isNaN(maxTokens) || maxTokens <= 0) {
      return reply.code(400).send({ error: 'maxTokens must be a positive number' })
    }
    const sinceMs = q.since ? parseSinceFromQuery(q.since) : undefined
    if (q.since && sinceMs === undefined) {
      return reply.code(400).send({ error: `Invalid since: ${q.since}. Use e.g. 24h, 30m, 1d, 1w.` })
    }
    const summarizeScope = (q.summarizeScope ?? 'all') as
      'all' | 'error' | 'denial' | 'scope-drift' | 'user-redirect' | 'trajectory-end' | 'cross-session'
    return await runContextHistory({
      cwd, scope, query, sinceMs, maxTokens, summarizeScope,
    })
  })

  // PR-B2: /v1/context/trace — read raw behavior-trace.jsonl entries
  // as JSON for the Go TUI's StatusBehaviorHint overlay. Mirrors
  // /v1/context/history's file-read path but returns the raw typed
  // entries array (no summarize / search) so the TUI can render
  // each row directly. See docs/nexus/reference/long-running-
  // context-assembly.md §18.2.
  app.get('/v1/context/trace', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    const cwd = q.cwd
    if (!cwd) {
      return reply.code(400).send({ error: 'cwd query param is required' })
    }
    const sessionId = q.sessionId
    const limit = q.limit ? Math.max(1, Math.min(1000, Number(q.limit))) : 100
    if (q.limit && (Number.isNaN(limit) || limit <= 0)) {
      return reply.code(400).send({ error: 'limit must be a positive number' })
    }
    const sinceMs = q.sinceMs ? Number(q.sinceMs) : 24 * 60 * 60 * 1000
    if (q.sinceMs && (Number.isNaN(sinceMs) || sinceMs < 0)) {
      return reply.code(400).send({ error: 'sinceMs must be a non-negative number' })
    }
    return await runBehaviorTraceGet({ cwd, sessionId, limit, sinceMs })
  })

  // PR-12: Track A Phase 2 — context working-set REST endpoints.
  // Read-only. Reuses PR-4b PersistedWorkingSetTracker.
  app.get('/v1/context/working-set', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    const cwd = q.cwd
    if (!cwd) {
      return reply.code(400).send({ error: 'cwd query param is required' })
    }
    return await runWorkingSetList({ cwd })
  })

  app.get('/v1/context/working-set/:sessionId', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    const cwd = q.cwd
    if (!cwd) {
      return reply.code(400).send({ error: 'cwd query param is required' })
    }
    const sessionId = (request.params as { sessionId: string }).sessionId
    return await runWorkingSetGet({ cwd, sessionId })
  })

  // PR-A1: Track A Phase 3 §7.3 — PUT /v1/context/working-set/:sessionId
  // (write op, user-approved 2026-06-17). Updates a session's working
  // set entries; auto-persists + emits working_set_updated event
  // (PR-26). NOT silent: requires explicit body. Body shape:
  //   { workspaceId?: string, entries: Array<{key, value, updatedAt, confidence}> }
  // Pure write — caller is expected to read the current state via GET
  // first and submit the full desired entries set (this endpoint is a
  // write-through, not a delta).
  app.put('/v1/context/working-set/:sessionId', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    const cwd = q.cwd
    if (!cwd) {
      return reply.code(400).send({ error: 'cwd query param is required' })
    }
    const sessionId = (request.params as { sessionId: string }).sessionId
    const body = (request.body ?? {}) as {
      workspaceId?: string
      entries?: Array<{ key?: unknown; value?: unknown; updatedAt?: unknown; confidence?: unknown }>
    }
    if (!Array.isArray(body.entries)) {
      return reply.code(400).send({ error: 'body.entries must be an array' })
    }
    // Per-entry shape validation. Reject early on the first bad row
    // so callers can pinpoint the issue.
    const validated: Array<{ key: string; value: string; updatedAt: string; confidence: number }> = []
    for (let i = 0; i < body.entries.length; i++) {
      const e = body.entries[i]!
      if (typeof e.key !== 'string' || e.key.length === 0) {
        return reply.code(400).send({ error: `entries[${i}].key must be a non-empty string` })
      }
      if (typeof e.value !== 'string') {
        return reply.code(400).send({ error: `entries[${i}].value must be a string` })
      }
      if (e.updatedAt !== undefined && typeof e.updatedAt !== 'string') {
        return reply.code(400).send({ error: `entries[${i}].updatedAt must be a string when present` })
      }
      if (e.confidence !== undefined && (typeof e.confidence !== 'number' || e.confidence < 0 || e.confidence > 1)) {
        return reply.code(400).send({ error: `entries[${i}].confidence must be a number in [0,1]` })
      }
      validated.push({
        key: e.key,
        value: e.value,
        updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : new Date().toISOString(),
        confidence: typeof e.confidence === 'number' ? e.confidence : 1,
      })
    }
    return await runWorkingSetPut({ cwd, sessionId, workspaceId: body.workspaceId, entries: validated })
  })

  // PR-20: Track A Phase 3 — GET /v1/context/working-set/workspace/:wsId.
  // Per design §7.3 row 3. Returns the working set aggregated across all
  // sessions that share the same workspaceId. Pure read.
  app.get('/v1/context/working-set/workspace/:wsId', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    const cwd = q.cwd
    if (!cwd) {
      return reply.code(400).send({ error: 'cwd query param is required' })
    }
    const workspaceId = (request.params as { wsId: string }).wsId
    if (!workspaceId) {
      return reply.code(400).send({ error: 'workspaceId path param is required' })
    }
    return await runWorkspaceWorkingSetGet({ cwd, workspaceId })
  })

  // PR-18: Track A Phase 3 — POST /v1/context/assemble.
  // Read-only manual context assembly. Reuses PR-15 buildAssemblePreview
  // (the pure function extracted from runAssemble). Pure read — never
  // mutates state. Mirrors design §7.3 row 1.
  app.post('/v1/context/assemble', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>
    const cwd = typeof body.cwd === 'string' ? body.cwd : undefined
    if (!cwd) {
      return reply.code(400).send({ error: 'cwd is required in body' })
    }
    const scopeRaw = typeof body.scope === 'string' ? body.scope : 'standard'
    const validScopes = ['minimal', 'standard', 'full', 'task', 'workspace']
    if (!validScopes.includes(scopeRaw)) {
      return reply.code(400).send({ error: `Invalid scope: ${scopeRaw}. Must be one of: ${validScopes.join(', ')}` })
    }
    const maxTokensRaw = body.maxTokens
    const maxTokens = typeof maxTokensRaw === 'number'
      ? maxTokensRaw
      : typeof maxTokensRaw === 'string'
        ? Number(maxTokensRaw)
        : 7500
    if (Number.isNaN(maxTokens) || maxTokens <= 0) {
      return reply.code(400).send({ error: 'maxTokens must be a positive number' })
    }
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined
    return await runContextAssemble({
      cwd,
      sessionId,
      scope: scopeRaw as 'minimal' | 'standard' | 'full' | 'task' | 'workspace',
      maxTokens,
    })
  })

  app.get('/v1/tools/audit', async () => ({
    type: 'tools_audit',
    tools: options.runtime.listTools?.() ?? [],
  }))

  app.post('/v1/agents', async (request, reply) => {
    const body = agentSpawnSchema.parse(request.body)
    try {
      const job = await agentScheduler.spawnAgent(body)
      return {
        type: 'agent_job_spawned',
        job,
      }
    } catch (error) {
      if (error instanceof AgentJobRegistryError) {
        return sendAgentError(reply, error)
      }
      throw error
    }
  })

  app.get('/v1/agents', async request => {
    const query = agentListQuerySchema.parse(request.query)
    return {
      type: 'agent_jobs',
      jobs: await agentScheduler.listAgents(query),
    }
  })

  app.get('/v1/agents/:jobId', async (request, reply) => {
    const params = z.object({ jobId: z.string() }).parse(request.params)
    const job = await findAgentJob(agentScheduler, params.jobId)
    if (!job) return reply.code(404).send(createAgentJobNotFoundPayload(params.jobId))
    return {
      type: 'agent_job',
      job,
    }
  })

  app.post('/v1/agents/:jobId/wait', async (request, reply) => {
    const params = z.object({ jobId: z.string() }).parse(request.params)
    const body = agentWaitSchema.parse(request.body ?? {})
    try {
      return {
        type: 'agent_job',
        job: await agentScheduler.waitForAgent(params.jobId, body),
      }
    } catch (error) {
      if (error instanceof AgentJobRegistryError) {
        return sendAgentError(reply, error)
      }
      throw error
    }
  })

  app.post('/v1/agents/:jobId/cancel', async (request, reply) => {
    const params = z.object({ jobId: z.string() }).parse(request.params)
    const body = agentCancelSchema.parse(request.body ?? {})
    try {
      return {
        type: 'agent_job_cancelled',
        job: await agentScheduler.cancelAgent(params.jobId, body.reason),
      }
    } catch (error) {
      if (error instanceof AgentJobRegistryError) {
        return sendAgentError(reply, error)
      }
      throw error
    }
  })

  app.get('/v1/agents/:jobId/transcript', async (request, reply) => {
    const params = z.object({ jobId: z.string() }).parse(request.params)
    const query = eventListQuerySchema.parse(request.query)
    const job = await findAgentJob(agentScheduler, params.jobId)
    if (!job) return reply.code(404).send(createAgentJobNotFoundPayload(params.jobId))
    const page = await options.storage.listEvents(job.childSessionId, query)
    return {
      type: 'agent_transcript',
      jobId: job.jobId,
      parentSessionId: job.parentSessionId,
      childSessionId: job.childSessionId,
      transcriptPath: job.transcriptPath ?? `nexus://sessions/${job.childSessionId}/events`,
      events: page.events,
      nextCursor: page.nextCursor,
      order: query.order,
      limit: query.limit,
    }
  })

  // ---------------------------------------------------------------------
  // Skill routes (Phase 3 of the Skill execution governance plan)
  // ---------------------------------------------------------------------

  app.get('/v1/skills', async request => {
    const query = SkillListQuerySchema.parse(request.query)
    return listSkills({
      cwd: query.cwd ?? options.defaultCwd,
      ...(query.source ? { source: query.source } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.builtInDir ? { builtInDir: query.builtInDir } : {}),
    })
  })

  app.get('/v1/skills/:id', async (request, reply) => {
    const params = SkillIdParamsSchema.parse(request.params)
    const query = SkillListQuerySchema.parse(request.query)
    const result = await showSkill({
      cwd: query.cwd ?? options.defaultCwd,
      id: params.id,
      ...(query.builtInDir ? { builtInDir: query.builtInDir } : {}),
    })
    if (!result.ok) {
      const status = result.errorCode === 'SKILL_NOT_FOUND' ? 404 : 500
      return reply.code(status).send(result)
    }
    return result
  })

  app.post('/v1/skills/validate', async (request, reply) => {
    const body = SkillValidateBodySchema.parse(request.body ?? {})
    const result = await validateSkillRequest(body)
    if (!result.ok) {
      return reply.code(422).send(result)
    }
    return result
  })

  app.post('/v1/skills/invoke', async request => {
    const body = SkillInvokeBodySchema.parse(request.body ?? {})
    return invokeSkill(body)
  })

  app.post('/v1/skills/draft', async (request, reply) => {
    const body = SkillDraftBodySchema.parse(request.body ?? {})
    const result = await generateDraftHandler(body)
    if (!result.ok) {
      return reply.code(422).send(result)
    }
    return result
  })

  app.post('/v1/skills/save', async (request, reply) => {
    const body = SkillSaveBodySchema.parse(request.body ?? {})
    const result = await saveSkillHandler({
      cwd: body.cwd ?? options.defaultCwd,
      draft: body.draft as unknown as Parameters<typeof saveSkillHandler>[0]['draft'],
      confirm: body.confirm,
      ...(body.overwrite !== undefined ? { overwrite: body.overwrite } : {}),
      ...(body.scope ? { scope: body.scope } : {}),
    })
    if (!result.ok) {
      if (result.errorCode === 'SKILL_SAVE_OVERWRITE_REQUIRED') {
        return reply.code(409).send(result)
      }
      if (result.errorCode === 'SKILL_SAVE_PERSIST_FAILED' || result.errorCode === 'SKILL_SAVE_SCOPE_INVALID') {
        return reply.code(500).send(result)
      }
      return reply.code(422).send(result)
    }
    return result
  })

  app.get('/v1/sessions/:sessionId/agents', async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    const query = agentListQuerySchema.omit({ parentSessionId: true }).parse(request.query)
    const session = await options.storage.getSession(params.sessionId, { includeEvents: false })
    if (!session) return reply.code(404).send(createSessionNotFoundPayload(params.sessionId))
    return {
      type: 'agent_jobs',
      parentSessionId: params.sessionId,
      jobs: await agentScheduler.listAgents({
        ...query,
        parentSessionId: params.sessionId,
      }),
    }
  })

  type WatchdogState = {
    /**
     * Phase 5 of the task-adaptive-recoverable-timeout plan: set
     * to true by the hard watchdog timer when it actually fires.
     * Lets the execute loop decorate the resulting REQUEST_TIMEOUT
     * error with `details.kind='watchdog'` so downstream consumers
     * (Go TUI friendly message, metrics, future SDK clients) can
     * distinguish a watchdog cutoff from a fresh fatal cutoff.
     *
     * Stays false under legacy `fatal` policy because under fatal
     * the soft and watchdog timeouts collapse, so every cutoff is
     * effectively the same fatal cutoff; not marking it preserves
     * back-compat with the existing `REQUEST_TIMEOUT` shape.
     */
    fired: boolean
  }

  type PreparedExecution = {
    sessionId: string
    session: SessionSnapshot
    cwd: string
    body: z.infer<typeof executeSchema>
    requestId: string
    abortController: AbortController
    timeoutController: AbortController
    timeout: ReturnType<typeof setTimeout>
    timeoutDecision: ExecuteTimeoutDecision
    policyMode: 'strict' | 'soft-deny'
    allowedTools?: readonly string[]
    allowedPaths?: string[]
    watchdog: WatchdogState
  }

  type PrepareError = { code: string; message: string; status: number }

  function resolveExecuteTimeoutDecision(body: z.infer<typeof executeSchema>): ExecuteTimeoutDecision {
    const policy = body.timeoutPolicy ?? 'fatal'
    const legacyTimeoutMs = body.timeoutMs ?? executeTimeoutMs
    const softTimeoutMs = body.softTimeoutMs ?? legacyTimeoutMs
    const watchdogTimeoutMs = body.watchdogTimeoutMs ?? (policy === 'soft'
      ? Math.max(legacyTimeoutMs * 3, legacyTimeoutMs + 300_000)
      : legacyTimeoutMs)
    // Phase 3 defaults: a single auto extension equal to the soft
    // budget gives the model one full window to react to the budget
    // warning. fatal policy keeps maxSoftTimeoutExtensions=0 so
    // legacy callers never see the new extension cycle.
    const maxSoftTimeoutExtensions = policy === 'soft'
      ? body.maxSoftTimeoutExtensions ?? 1
      : 0
    const softTimeoutExtensionMs = body.softTimeoutExtensionMs ?? softTimeoutMs
    return { policy, softTimeoutMs, watchdogTimeoutMs, maxSoftTimeoutExtensions, softTimeoutExtensionMs }
  }

  async function prepareExecution(body: z.infer<typeof executeSchema>): Promise<PreparedExecution | PrepareError> {
    if (body.executionEnvironment === 'remote' && !options.remoteRunner) {
      return { code: 'NOT_IMPLEMENTED', message: `Execution environment '${body.executionEnvironment}' is not implemented yet.`, status: 501 }
    }
    const sessionId = body.sessionId ?? createId('session')
    let session = await options.storage.getSession(sessionId, { includeEvents: false })
    const cwd = resolveRequestCwd({
      prompt: body.prompt,
      requestedCwd: body.cwd,
      sessionCwd: session?.cwd,
      defaultCwd: options.defaultCwd,
    })
    if (!isWorkspaceAllowed(cwd)) {
      return { code: 'INVALID_REQUEST', message: `Workspace directory not allowed: ${cwd}`, status: 400 }
    }

    let allowedPaths = session?.allowedPaths ? [...session.allowedPaths] : []
    if (session && session.cwd && session.cwd !== cwd && !allowedPaths.includes(session.cwd)) {
      allowedPaths.push(session.cwd)
    }

    const configManager = ConfigManager.getInstance()
    const settings = configManager.resolveSettings({ model: body.model })
    const targetModelId = settings.modelId || 'local/coding-runtime'
    try {
      const modelDef = getModel(targetModelId)
      if (modelDef && !modelDef.capabilities.toolCalling) {
        return { code: 'INVALID_REQUEST', message: `Model "${targetModelId}" does not support tool calling`, status: 400 }
      }
    } catch (err) {
      if (!(err instanceof UnknownModelError)) throw err
    }
    const abortController = new AbortController()
    const timeoutController = new AbortController()
    const timeoutDecision = resolveExecuteTimeoutDecision(body)
    // Phase 5: when the hard watchdog fires, mark a shared
    // WatchdogState so the execute loop can decorate the
    // resulting REQUEST_TIMEOUT error with details.kind='watchdog'
    // and distinguish a system-safety cutoff from a fresh fatal
    // cutoff in metrics, friendly messages, and persistence.
    const watchdog: WatchdogState = { fired: false }
    const timeout = setTimeout(() => {
      watchdog.fired = true
      timeoutController.abort()
      abortController.abort()
    }, timeoutDecision.watchdogTimeoutMs)
    // Resolve effective policy mode: per-request body field overrides
    // server-side default. Defaults to 'strict' to preserve HTTP API
    // back-compat. See Phase B of
    // docs/nexus/reference/go-tui-permission-policy-governance-plan.md.
    const policyMode = body.policy ?? executePolicyMode
    // Per-request allowlist (Phase D): scoped to this turn only. When
    // omitted, the runtime falls back to its server-startup policy.
    const allowedTools = body.allowedTools
    if (!session) {
      session = createSessionSnapshot(sessionId, cwd, body.prompt)
    } else {
      session.phase = 'executing'
      session.cwd = cwd
      session.updatedAt = nowIso()
      session.lastUserInput = body.prompt
      session.allowedPaths = allowedPaths.length > 0 ? allowedPaths : undefined
    }
    await options.storage.saveSession(session)
    await options.storage.appendEvent(sessionId, { type: 'user_message', ...eventBase(sessionId), text: body.prompt })
    const requestId = body.requestId ?? createId('req')
    return { sessionId, session, cwd, body, requestId, abortController, timeoutController, timeout, timeoutDecision, policyMode, allowedTools, allowedPaths: allowedPaths.length > 0 ? allowedPaths : undefined, watchdog }
  }

  function isPrepareError(r: PreparedExecution | PrepareError): r is PrepareError {
    return 'status' in r
  }

  function registerActiveExecution(
    sessionId: string,
    execution: ActiveExecution,
  ): void {
    activeExecutions.set(sessionId, execution)
  }

  function clearActiveExecution(sessionId: string, requestId: string): void {
    if (activeExecutions.get(sessionId)?.requestId === requestId) {
      activeExecutions.delete(sessionId)
    }
  }

  function recordEventMetrics(event: NexusEvent): void {
    if (event.type !== 'execution_metrics') return
    if (event.providerFirstTokenMs !== undefined) metrics.recordProviderFirstToken(event.providerFirstTokenMs)
    if (event.providerRequestDurationMs !== undefined) metrics.recordProviderRequestDuration(event.providerRequestDurationMs)
    if (event.streamDeltaCount !== undefined) metrics.recordStreamDeltas(event.streamDeltaCount)
    if (event.toolCallCount !== undefined && event.toolRoundtripDurationMs !== undefined) metrics.recordToolCalls(event.toolCallCount, event.toolRoundtripDurationMs)
    if (event.remoteToolCallCount !== undefined && event.remoteToolRunnerDurationMs !== undefined) metrics.recordRemoteToolCalls(event.remoteToolCallCount, event.remoteToolRunnerDurationMs)
    if (event.contextCharsIn !== undefined && event.contextCharsOut !== undefined) metrics.recordContextChars(event.contextCharsIn, event.contextCharsOut)
    metrics.recordTokenUsage({
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheCreationInputTokens: event.cacheCreationInputTokens,
      cacheReadInputTokens: event.cacheReadInputTokens,
    })
    metrics.recordContextPolicy({
      modelContextWindow: event.modelContextWindow,
      reservedOutputTokens: event.reservedOutputTokens,
      providerSafetyBufferTokens: event.providerSafetyBufferTokens,
      effectiveContextCeiling: event.effectiveContextCeiling,
      legacyContextCeiling: event.legacyContextCeiling,
      envMaxContextTokens: event.envMaxContextTokens,
      contextPolicySource: event.contextPolicySource,
      contextWarningThresholdPercent: event.contextWarningThresholdPercent,
      contextCompactThresholdPercent: event.contextCompactThresholdPercent,
      contextWarningThresholdTokens: event.contextWarningThresholdTokens,
      contextCompactThresholdTokens: event.contextCompactThresholdTokens,
      contextBlockingLimitTokens: event.contextBlockingLimitTokens,
      cachePreservationMode: event.cachePreservationMode,
      longContextUtilizationMode: event.longContextUtilizationMode,
      prefixCacheImmutableRatio: event.prefixCacheImmutableRatio,
      prefixCacheVolatileContentLast: event.prefixCacheVolatileContentLast,
      prefixCacheFingerprint: event.prefixCacheFingerprint,
    })
    if (event.compactSummaryLatencyMs !== undefined) metrics.recordCompactSummaryLatency(event.compactSummaryLatencyMs)
  }

  function runtimeResultStatusCode(
    events: NexusEvent[],
    errorEvent: NexusEvent | undefined,
  ): number {
    if (events.some(event => event.type === 'context_blocking')) return 413
    if (errorEvent?.type === 'error' && errorEvent.code === 'REQUEST_TIMEOUT') return 408
    return 200
  }

  /**
   * Phase 5 of task-adaptive-recoverable-timeout: when the hard
   * watchdog fired this turn AND the runtime yielded a REQUEST_TIMEOUT
   * error, decorate the error with `details.kind='watchdog'` (and a
   * compact softCycle summary) so downstream consumers can credit
   * the watchdog instead of recommending the operator raise the
   * fixed-cutoff knob. Only applies under soft policy — fatal
   * policy callers keep the original `REQUEST_TIMEOUT` shape for
   * back-compat.
   *
   * Pure function: returns a new event when it should be replaced,
   * undefined when the original should be kept. The caller is
   * responsible for swapping the in-memory event AND persisting
   * the decorated version.
   */
  function maybeDecorateWatchdogError(options: {
    event: NexusEvent
    timeoutDecision: ExecuteTimeoutDecision
    watchdog: WatchdogState
    events: readonly NexusEvent[]
  }): Extract<NexusEvent, { type: 'error' }> | undefined {
    if (options.event.type !== 'error') return undefined
    if (options.event.code !== 'REQUEST_TIMEOUT') return undefined
    if (options.timeoutDecision.policy !== 'soft') return undefined
    if (!options.watchdog.fired) return undefined
    const softCycleEvents = options.events.filter(event =>
      event.type === 'timeout_budget_exceeded' || event.type === 'timeout_extension_granted',
    )
    const existingDetails = asRecord(options.event.details) ?? {}
    const detailRecord: Record<string, unknown> = {
      ...existingDetails,
      kind: 'watchdog',
      policy: 'soft',
      softTimeoutMs: options.timeoutDecision.softTimeoutMs,
      watchdogTimeoutMs: options.timeoutDecision.watchdogTimeoutMs,
      maxSoftTimeoutExtensions: options.timeoutDecision.maxSoftTimeoutExtensions,
      softCycleEvents: softCycleEvents.length,
      retryable: false,
    }
    return {
      ...options.event,
      details: detailRecord,
    }
  }

  async function maybeAppendNearTimeoutWarning(state: {
    events: NexusEvent[]
    sessionId: string
    requestId: string
    timeoutMs: number
    elapsedMs: number
    send?: (event: NexusEvent) => void
  }): Promise<void> {
    if (state.events.some(event => event.type === 'near_timeout_warning')) return
    if (!executeTimeoutNear(state.elapsedMs, state.timeoutMs)) return
    if (!hasPartialTimeoutEvidence(state.events)) return
    const warning = buildNearTimeoutWarningEvent({
      sessionId: state.sessionId,
      requestId: state.requestId,
      timeoutMs: state.timeoutMs,
      elapsedMs: state.elapsedMs,
      partialSummary: buildPartialTimeoutSummary(state.events),
    })
    state.events.push(warning)
    await options.storage.appendEvent(state.sessionId, warning)
    state.send?.(warning)
  }

  function startNearTimeoutWatcher(state: {
    events: NexusEvent[]
    sessionId: string
    requestId: string
    timeoutMs: number
    startedAtMs: number
    send?: (event: NexusEvent) => void
  }): ReturnType<typeof setTimeout> {
    const delayMs = Math.max(0, Math.floor(state.timeoutMs * EXECUTE_TIMEOUT_NEAR_RATIO))
    return setTimeout(() => {
      void maybeAppendNearTimeoutWarning({
        ...state,
        elapsedMs: Math.max(0, Math.round(metrics.now() - state.startedAtMs)),
      })
    }, delayMs)
  }

  /**
   * Phase 2: emit `timeout_budget_exceeded` for one cycle of the
   * soft timeout watcher. Does NOT touch any AbortController; only
   * the hard watchdog can abort the runtime under soft policy.
   *
   * Phase 3 made this cycle-scoped: each `currentBudgetMs` is the
   * running soft budget for the current cycle (initial + any
   * applied extensions). Idempotency is per cycle: a duplicate
   * fire at the same `currentBudgetMs` is dropped, but a fresh
   * cycle after an extension grant is allowed to emit again.
   */
  async function appendTimeoutBudgetExceededForCycle(state: {
    events: NexusEvent[]
    sessionId: string
    requestId: string
    currentBudgetMs: number
    elapsedMs: number
    send?: (event: NexusEvent) => void
  }): Promise<void> {
    const dup = state.events.some(event =>
      event.type === 'timeout_budget_exceeded' && event.timeoutMs === state.currentBudgetMs,
    )
    if (dup) return
    const event = buildTimeoutBudgetExceededEvent({
      sessionId: state.sessionId,
      requestId: state.requestId,
      timeoutMs: state.currentBudgetMs,
      elapsedMs: state.elapsedMs,
      partialSummary: buildPartialTimeoutSummary(state.events),
    })
    state.events.push(event)
    await options.storage.appendEvent(state.sessionId, event)
    state.send?.(event)
  }

  /**
   * Phase 3: emit `timeout_extension_granted` to announce an
   * auto-extension. Hard watchdog is never extended here.
   */
  async function appendTimeoutExtensionGranted(state: {
    events: NexusEvent[]
    sessionId: string
    requestId: string
    extensionCount: number
    maxExtensions: number
    additionalMs: number
    totalSoftBudgetMs: number
    elapsedMs: number
    send?: (event: NexusEvent) => void
  }): Promise<void> {
    const event = buildTimeoutExtensionGrantedEvent({
      sessionId: state.sessionId,
      requestId: state.requestId,
      extensionCount: state.extensionCount,
      maxExtensions: state.maxExtensions,
      additionalMs: state.additionalMs,
      totalSoftBudgetMs: state.totalSoftBudgetMs,
      elapsedMs: state.elapsedMs,
    })
    state.events.push(event)
    await options.storage.appendEvent(state.sessionId, event)
    state.send?.(event)
  }

  type SoftTimeoutCycleHandle = {
    cancel(): void
  }

  /**
   * Phase 3: replace the Phase 2 one-shot soft watcher with a
   * cycle.
   *
   * Each cycle waits `currentBudgetMs - alreadyElapsedMs` and then
   * fires `timeout_budget_exceeded`. If extensions remain, it
   * immediately fires `timeout_extension_granted`, increments the
   * cycle's running budget by `extensionMs`, and reschedules.
   * After `maxExtensions` cycles, no further grant is emitted —
   * the watchdog stays as the only fatal cutoff.
   *
   * Only meaningful when the request opted into
   * `timeoutPolicy: 'soft'`. Under the legacy `fatal` policy this
   * helper must not be started.
   */
  function scheduleSoftTimeoutCycle(state: {
    events: NexusEvent[]
    sessionId: string
    requestId: string
    softTimeoutMs: number
    startedAtMs: number
    maxExtensions: number
    extensionMs: number
    send?: (event: NexusEvent) => void
  }): SoftTimeoutCycleHandle {
    let cancelled = false
    let currentTimer: ReturnType<typeof setTimeout> | undefined
    let extensionCount = 0
    let currentBudgetMs = state.softTimeoutMs

    const fire = async (): Promise<void> => {
      if (cancelled) return
      const elapsedMs = Math.max(0, Math.round(metrics.now() - state.startedAtMs))
      await appendTimeoutBudgetExceededForCycle({
        events: state.events,
        sessionId: state.sessionId,
        requestId: state.requestId,
        currentBudgetMs,
        elapsedMs,
        send: state.send,
      })
      if (cancelled) return
      if (extensionCount >= state.maxExtensions) return
      extensionCount += 1
      const additionalMs = state.extensionMs
      currentBudgetMs += additionalMs
      await appendTimeoutExtensionGranted({
        events: state.events,
        sessionId: state.sessionId,
        requestId: state.requestId,
        extensionCount,
        maxExtensions: state.maxExtensions,
        additionalMs,
        totalSoftBudgetMs: currentBudgetMs,
        elapsedMs,
        send: state.send,
      })
      if (cancelled) return
      const nextDelayMs = Math.max(0, additionalMs)
      currentTimer = setTimeout(() => { void fire() }, nextDelayMs)
    }

    const initialDelayMs = Math.max(0, state.softTimeoutMs)
    currentTimer = setTimeout(() => { void fire() }, initialDelayMs)

    return {
      cancel(): void {
        cancelled = true
        if (currentTimer !== undefined) clearTimeout(currentTimer)
      },
    }
  }

  app.post('/v1/execute', async (request, reply) => {
    const releaseExecution = executionGate.tryAcquire()
    if (!releaseExecution) {
      metrics.recordExecuteRejected()
      return reply.code(429).send({
        type: 'error',
        code: 'EXECUTION_BUSY',
        message: 'Nexus execution capacity is full. Try again shortly.',
      })
    }
    metrics.recordExecuteStart()
    const startedAtMs = metrics.now()
    let activeSessionId: string | undefined
    let activeRequestId: string | undefined
    try {
      const body = executeSchema.parse(request.body)
      const prepared = await prepareExecution(body)
      if (isPrepareError(prepared)) {
        return reply.status(prepared.status).send({ type: 'error', code: prepared.code, message: prepared.message })
      }
      const { sessionId, cwd, requestId, abortController, timeoutController, timeout, timeoutDecision } = prepared
      activeSessionId = sessionId
      activeRequestId = requestId
      registerActiveExecution(sessionId, {
        requestId,
        abortController,
        transport: 'http',
        startedAt: nowIso(),
      })

      const events: NexusEvent[] = []
      const effectiveTimeoutMs = timeoutDecision.softTimeoutMs
      const nearTimeoutWatcher = startNearTimeoutWatcher({
        events,
        sessionId,
        requestId,
        timeoutMs: effectiveTimeoutMs,
        startedAtMs,
      })
      // Phase 2 of task-adaptive-recoverable-timeout: when the
      // caller opted into soft policy, fire a one-shot watcher AT
      // the soft budget that only appends a runtime-visible
      // `timeout_budget_exceeded` event. The hard watchdog
      // continues to be the only thing that can abort the runtime.
      // For legacy fatal policy we skip this watcher: soft and
      // watchdog timeouts collapse and the existing fatal cutoff
      // already terminates the loop.
      //
      // Phase 3 extends the one-shot watcher into a cycle: after
      // each budget exhaustion the runtime can auto-grant up to
      // `maxSoftTimeoutExtensions` extensions (announced via
      // `timeout_extension_granted`) so the model has time to
      // react with a deliberate next step. fatal policy keeps
      // `maxSoftTimeoutExtensions` at 0 in
      // `resolveExecuteTimeoutDecision`, so the cycle reduces to
      // zero cycles and back-compat is preserved.
      const softTimeoutCycle = timeoutDecision.policy === 'soft'
        ? scheduleSoftTimeoutCycle({
            events,
            sessionId,
            requestId,
            softTimeoutMs: effectiveTimeoutMs,
            startedAtMs,
            maxExtensions: timeoutDecision.maxSoftTimeoutExtensions,
            extensionMs: timeoutDecision.softTimeoutExtensionMs,
          })
        : undefined
      try {
        for await (const event of options.runtime.executeStream({
          sessionId,
          prompt: body.prompt,
          cwd,
          signal: abortController.signal,
          timeoutSignal: timeoutController.signal,
          maxToolOutputBytes: body.maxToolOutputBytes ?? maxToolOutputBytes,
          bashMaxBufferBytes,
          skipPermissionCheck: body.skipPermissionCheck,
          requestId,
          model: body.model,
          budget: body.budget,
          executionEnvironment: body.executionEnvironment,
          remoteRunner: options.remoteRunner,
          allowedPaths: prepared.allowedPaths,
          policyMode: prepared.policyMode,
          ...(prepared.allowedTools && { allowedTools: prepared.allowedTools }),
        })) {
          // Phase 5: when the hard watchdog fired this turn
          // under soft policy, the resulting REQUEST_TIMEOUT
          // error must carry `details.kind='watchdog'` so the
          // Go TUI / metrics layer can distinguish a system
          // safety cutoff from a fresh fatal cutoff. We
          // intercept BEFORE pushing/persisting so the
          // in-memory + storage representations stay
          // consistent.
          const decoratedEvent = maybeDecorateWatchdogError({
            event,
            timeoutDecision,
            watchdog: prepared.watchdog,
            events,
          }) ?? event
          events.push(decoratedEvent)
          await options.storage.appendEvent(sessionId, decoratedEvent)
          recordEventMetrics(decoratedEvent)
          await maybeAppendNearTimeoutWarning({
            events,
            sessionId,
            requestId,
            timeoutMs: effectiveTimeoutMs,
            elapsedMs: Math.max(0, Math.round(metrics.now() - startedAtMs)),
          })
        }
      } finally {
        clearTimeout(nearTimeoutWatcher)
        softTimeoutCycle?.cancel()
        clearTimeout(timeout)
      }

      let resultEvent = events.findLast(event => event.type === 'result')
      const errorEvent = events.findLast(event => event.type === 'error')
      const statusCode = runtimeResultStatusCode(events, errorEvent)
      const timedOut = abortController.signal.aborted
      const timeoutEvent =
        errorEvent?.type === 'error' && errorEvent.code === 'REQUEST_TIMEOUT'
      const partialResultEvent = await appendTimeoutPartialResult({
        storage: options.storage,
        sessionId,
        events,
        resultEvent,
        errorEvent,
      })
      resultEvent = partialResultEvent ?? resultEvent
      const recoveredFromToolDenial = isRecoverableToolDenialOnlyTurn(events, resultEvent, errorEvent, timedOut)
      const succeeded =
        !timedOut && !errorEvent && (
          (resultEvent?.type === 'result' && resultEvent.success) ||
          recoveredFromToolDenial
        )
      await finalizeExecutionSession(options.storage, sessionId, {
        succeeded,
        resultEvent,
        errorEvent,
        contextBlockingEvent: events.find(event => event.type === 'context_blocking'),
      })
      const executeDurationMs = Math.max(0, Math.round(metrics.now() - startedAtMs))
      const summaryEvent = buildExecuteSummaryEvent({
        sessionId,
        requestId,
        timeoutMs: effectiveTimeoutMs,
        executeDurationMs,
        outcome: executeSummaryOutcome(resultEvent, errorEvent, timedOut, recoveredFromToolDenial),
      })
      events.push(summaryEvent)
      await options.storage.appendEvent(sessionId, summaryEvent)
      metrics.recordExecuteFinish({
        success: succeeded,
        timedOut: timedOut || timeoutEvent,
        durationMs: metrics.now() - startedAtMs,
      })

      return {
        type: 'execute_result',
        sessionId,
        success: succeeded,
        statusCode,
        durationMs: executeDurationMs,
        result: resultEvent ?? null,
        error: errorEvent ?? null,
        timeoutMs: effectiveTimeoutMs,
        executeDurationMs,
        nearTimeout: summaryEvent.nearTimeout,
        outcome: summaryEvent.outcome,
        events,
      }
    } finally {
      if (activeSessionId && activeRequestId) {
        clearActiveExecution(activeSessionId, activeRequestId)
      }
      releaseExecution()
    }
  })

  app.get('/v1/sessions', async request => {
    const query = z
      .object({ limit: z.coerce.number().int().positive().max(200).default(50) })
      .parse(request.query)
    return {
      type: 'sessions_list',
      sessions: await options.storage.listSessions({ limit: query.limit }),
    }
  })

  // Phase 1 of docs/nexus/reference/go-tui-session-observability-governance-plan.md:
  // `POST /v1/sessions` allocates a server-side `session_<uuid>` so Go TUI (and
  // any other client) can use a single canonical sessionId in
  // `runStream.sessionId`, `pendingPermission` matching, and event card
  // rendering. The body may include a `clientSessionId` (typically the
  // client's local `session_go_<unixnano>`) which we record as metadata
  // for cross-reference: `bbl inspect-session <serverSessionId>` can
  // surface the clientSessionId, and `bbl inspect-session <clientSessionId>`
  // (Phase 0) can scan the same metadata for the reverse lookup.
  app.post('/v1/sessions', async (request, reply) => {
    const body = z
      .object({
        cwd: z.string().optional(),
        clientSessionId: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(request.body ?? {})
    const sessionId = createId('session')
    const now = new Date().toISOString()
    const sessionMeta: Record<string, unknown> = { ...(body.metadata ?? {}) }
    if (body.clientSessionId) {
      sessionMeta.clientSessionId = body.clientSessionId
      sessionMeta.clientSessionIdSetAt = now
    }
    const session: SessionSnapshot = {
      sessionId,
      cwd: body.cwd ?? options.defaultCwd,
      prompt: '',
      phase: 'created',
      createdAt: now,
      updatedAt: now,
      events: [],
      ...(Object.keys(sessionMeta).length > 0 && { metadata: sessionMeta }),
    }
    await options.storage.saveSession(session)
    return reply.code(201).send({
      type: 'session_created',
      sessionId,
      clientSessionId: body.clientSessionId,
      createdAt: now,
    })
  })

  app.post('/v1/session-channels', async (request, reply) => {
    const body = createSessionChannelSchema.parse(request.body)
    const participantSessionIds = [...new Set(body.participantSessionIds)]
    if (!participantSessionIds.includes(body.createdBySessionId)) {
      return reply.code(400).send({
        type: 'error',
        code: 'INVALID_SESSION_CHANNEL',
        message: 'createdBySessionId must be one of participantSessionIds',
      })
    }
    for (const sessionId of participantSessionIds) {
      const session = await options.storage.getSession(sessionId, { includeEvents: false })
      if (!session) return reply.code(404).send(createSessionNotFoundPayload(sessionId))
    }
    const channel: SessionChannel = {
      channelId: createId('channel'),
      kind: body.kind ?? 'direct',
      participantSessionIds,
      createdBySessionId: body.createdBySessionId,
      createdAt: nowIso(),
      status: 'open',
      policy: mergeSessionChannelPolicy(body.policy),
      metadata: body.metadata,
    }
    await options.storage.saveSessionChannel(channel)
    return {
      type: 'session_channel_created',
      channel,
    }
  })

  app.get('/v1/session-channels', async request => {
    const query = sessionChannelListQuerySchema.parse(request.query)
    return {
      type: 'session_channels',
      channels: await options.storage.listSessionChannels(query),
      limit: query.limit,
    }
  })

  app.get('/v1/session-channels/:channelId', async (request, reply) => {
    const params = z.object({ channelId: z.string() }).parse(request.params)
    const channel = await options.storage.getSessionChannel(params.channelId)
    if (!channel) return reply.code(404).send(createSessionChannelNotFoundPayload(params.channelId))
    return {
      type: 'session_channel',
      channel,
    }
  })

  app.post('/v1/session-channels/:channelId/messages', async (request, reply) => {
    const params = z.object({ channelId: z.string() }).parse(request.params)
    const body = createSessionMessageSchema.parse(request.body)
    const channel = await options.storage.getSessionChannel(params.channelId)
    if (!channel) return reply.code(404).send(createSessionChannelNotFoundPayload(params.channelId))
    const channelError = validateSessionChannelMessage(channel, body)
    if (channelError) return reply.code(400).send(channelError)
    const createdAt = nowIso()
    const message: SessionMessage = withMemoryCandidateGovernance(channel, {
      messageId: createId('msg'),
      channelId: params.channelId,
      fromSessionId: body.fromSessionId,
      toSessionId: body.toSessionId,
      broadcast: body.broadcast ?? body.toSessionId === undefined,
      type: body.type,
      content: body.content,
      evidence: body.evidence,
      priority: body.priority ?? 'normal',
      createdAt,
      deliveredAt: createdAt,
      status: 'delivered',
      metadata: body.metadata,
    })
    await options.storage.saveSessionMessage(message)
    return {
      type: 'session_message_created',
      message,
    }
  })

  app.get('/v1/session-channels/:channelId/messages', async (request, reply) => {
    const params = z.object({ channelId: z.string() }).parse(request.params)
    const query = sessionMessageListQuerySchema.parse(request.query)
    const channel = await options.storage.getSessionChannel(params.channelId)
    if (!channel) return reply.code(404).send(createSessionChannelNotFoundPayload(params.channelId))
    const page = await options.storage.listSessionMessages(params.channelId, query)
    return {
      type: 'session_messages',
      channelId: params.channelId,
      messages: page.messages,
      nextCursor: page.nextCursor,
      order: query.order,
      limit: query.limit,
    }
  })

  app.get('/v1/sessions/:sessionId/inbox', async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    const query = sessionInboxQuerySchema.parse(request.query)
    const session = await options.storage.getSession(params.sessionId, { includeEvents: false })
    if (!session) return reply.code(404).send(createSessionNotFoundPayload(params.sessionId))
    return {
      type: 'session_inbox',
      sessionId: params.sessionId,
      messages: await options.storage.listSessionInbox(params.sessionId, query),
      limit: query.limit,
      includeAcknowledged: query.includeAcknowledged,
    }
  })

  app.post('/v1/sessions/:sessionId/inbox/:messageId/ack', async (request, reply) => {
    const params = z.object({ sessionId: z.string(), messageId: z.string() }).parse(request.params)
    const session = await options.storage.getSession(params.sessionId, { includeEvents: false })
    if (!session) return reply.code(404).send(createSessionNotFoundPayload(params.sessionId))
    const message = await options.storage.getSessionMessage(params.messageId)
    if (!message) return reply.code(404).send(createSessionMessageNotFoundPayload(params.messageId))
    const channel = await options.storage.getSessionChannel(message.channelId)
    if (!isSessionMessageRecipient(message, params.sessionId, channel)) {
      return reply.code(404).send(createSessionMessageNotFoundPayload(params.messageId))
    }
    const acknowledged = await options.storage.acknowledgeSessionMessage(params.messageId, nowIso())
    return {
      type: 'session_message_acknowledged',
      sessionId: params.sessionId,
      message: acknowledged,
    }
  })

  app.get('/v1/sessions/:sessionId', async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    const query = sessionDetailQuerySchema.parse(request.query)
    const session = await options.storage.getSession(params.sessionId, {
      includeEvents: false,
    })
    if (!session) {
      return reply.code(404).send({
        type: 'error',
        code: 'SESSION_NOT_FOUND',
        message: `Session not found: ${params.sessionId}`,
      })
    }
    const eventPage =
      query.recentEventLimit > 0
        ? await options.storage.listEvents(params.sessionId, {
            limit: query.recentEventLimit,
            order: 'desc',
          })
        : { events: [] }
    return {
      type: 'session',
      session: {
        ...session,
        events: [...eventPage.events].reverse(),
      },
      eventsTruncated: eventPage.nextCursor !== undefined,
      recentEventLimit: query.recentEventLimit,
    }
  })

  app.get('/v1/sessions/:sessionId/assets', async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    const query = sessionAssetsQuerySchema.parse(request.query)
    const snapshot = await buildSessionAssetsSnapshot({
      storage: options.storage,
      sessionId: params.sessionId,
      assetOptions: query,
    })
    if (!snapshot) {
      return reply.code(404).send({
        type: 'error',
        code: 'SESSION_NOT_FOUND',
        message: `Session not found: ${params.sessionId}`,
      })
    }
    return snapshot
  })

  app.get('/v1/sessions/:sessionId/events', async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    const query = eventListQuerySchema.parse(request.query)
    const session = await options.storage.getSession(params.sessionId, {
      includeEvents: false,
    })
    if (!session) {
      return reply.code(404).send({
        type: 'error',
        code: 'SESSION_NOT_FOUND',
        message: `Session not found: ${params.sessionId}`,
      })
    }
    const page = await options.storage.listEvents(params.sessionId, query)
    return {
      type: 'session_events',
      sessionId: params.sessionId,
      events: page.events,
      nextCursor: page.nextCursor,
      order: query.order,
      limit: query.limit,
    }
  })

  // bbl loop plan Phase 1: incremental event subscription with
  // since / match / types / timeout. Clients (e.g. multi-pane
  // TUI) poll this endpoint instead of holding a long-lived WS
  // stream per pane. The endpoint intentionally returns 200 with
  // an empty event list on timeout so clients treat it as a
  // normal poll tick, mirroring herdr's `wait_for_output` shape.
  const waitQuerySchema = z.object({
    since: z.coerce.number().int().min(0).default(0),
    match: z.string().min(1).max(2048).optional(),
    types: z.string().min(1).max(1024).optional(),
    timeout: z.coerce.number().int().min(0).max(60_000).default(0),
    limit: z.coerce.number().int().positive().max(500).default(200),
  })

  app.get('/v1/sessions/:sessionId/wait', async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    const query = waitQuerySchema.parse(request.query)
    const session = await options.storage.getSession(params.sessionId, {
      includeEvents: false,
    })
    if (!session) {
      return reply.code(404).send({
        type: 'error',
        code: 'SESSION_NOT_FOUND',
        message: `Session not found: ${params.sessionId}`,
      })
    }
    const allowedTypes = query.types
      ? new Set(query.types.split(',').map(value => value.trim()).filter(Boolean))
      : null
    const matcher = query.match
      ? new RegExp(escapeRegExpForWait(query.match))
      : null

    const pollOnce = async (): Promise<{ events: NexusEvent[]; lastSeq: number }> => {
      const page = await options.storage.listEvents(params.sessionId, {
        order: 'asc',
        limit: query.limit,
        cursor: query.since > 0 ? String(query.since) : undefined,
      })
      const filtered: NexusEvent[] = []
      for (const event of page.events) {
        if (allowedTypes && !allowedTypes.has(event.type)) continue
        if (matcher && !matcher.test(JSON.stringify(event))) continue
        filtered.push(event)
      }
      return {
        events: filtered,
        lastSeq: page.lastSeq ?? query.since,
      }
    }

    const initial = await pollOnce()
    if (initial.events.length > 0 || query.timeout === 0) {
      return {
        type: 'session_wait',
        sessionId: params.sessionId,
        events: initial.events,
        nextRevision: String(initial.lastSeq),
        matched: initial.events.length > 0,
        order: 'asc',
        limit: query.limit,
      }
    }

    // No matches yet and the client asked us to wait. Poll at a
    // coarse interval (250ms) until either a matching event shows
    // up or the deadline elapses. 250ms keeps the round-trip
    // responsive without thrashing the SQLite reader.
    const deadline = Date.now() + query.timeout
    const intervalMs = 250
    while (Date.now() < deadline) {
      const remaining = Math.max(0, deadline - Date.now())
      await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, remaining)))
      const tick = await pollOnce()
      if (tick.events.length > 0) {
        return {
          type: 'session_wait',
          sessionId: params.sessionId,
          events: tick.events,
          nextRevision: String(tick.lastSeq),
          matched: true,
          order: 'asc',
          limit: query.limit,
        }
      }
    }

    return {
      type: 'session_wait',
      sessionId: params.sessionId,
      events: [],
      nextRevision: String(initial.lastSeq),
      matched: false,
      order: 'asc',
      limit: query.limit,
    }
  })

  app.get('/v1/sessions/:sessionId/children', async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    const query = childSessionsQuerySchema.parse(request.query)
    const session = await options.storage.getSession(params.sessionId, {
      includeEvents: false,
    })
    if (!session) {
      return reply.code(404).send({
        type: 'error',
        code: 'SESSION_NOT_FOUND',
        message: `Session not found: ${params.sessionId}`,
      })
    }

    const childSessions = (await options.storage.listChildSessions(params.sessionId, {
      limit: query.limit,
      includeEvents: false,
    })).filter(child => !query.failedOnly || child.phase === 'failed' || child.phase === 'cancelled' || child.metadata?.status === 'failed' || child.metadata?.status === 'cancelled')

    const children = await Promise.all(childSessions.map(async child => {
      const page = query.includeEvents && query.eventLimit > 0
        ? await options.storage.listEvents(child.sessionId, {
            limit: query.eventLimit,
            order: 'desc',
          })
        : undefined
      return {
        session: { ...child, events: [] },
        transcriptPath: typeof child.metadata?.transcriptPath === 'string'
          ? child.metadata.transcriptPath
          : `nexus://sessions/${child.sessionId}/events`,
        events: page
          ? {
              items: [...page.events].reverse(),
              truncated: page.nextCursor !== undefined,
              limit: query.eventLimit,
              order: 'asc',
            }
          : undefined,
      }
    }))

    return {
      type: 'child_sessions',
      sessionId: params.sessionId,
      children,
      limit: query.limit,
      eventLimit: query.eventLimit,
    }
  })

  app.get('/v1/sessions/:sessionId/children/:childSessionId/events', async (request, reply) => {
    const params = z.object({ sessionId: z.string(), childSessionId: z.string() }).parse(request.params)
    const query = eventListQuerySchema.parse(request.query)
    const session = await options.storage.getSession(params.sessionId, {
      includeEvents: false,
    })
    if (!session) {
      return reply.code(404).send({
        type: 'error',
        code: 'SESSION_NOT_FOUND',
        message: `Session not found: ${params.sessionId}`,
      })
    }
    const child = await options.storage.getSession(params.childSessionId, {
      includeEvents: false,
    })
    if (!child || child.parentSessionId !== params.sessionId) {
      return reply.code(404).send({
        type: 'error',
        code: 'CHILD_SESSION_NOT_FOUND',
        message: `Child session not found: ${params.childSessionId}`,
      })
    }
    const page = await options.storage.listEvents(params.childSessionId, query)
    return {
      type: 'child_session_events',
      sessionId: params.sessionId,
      childSessionId: params.childSessionId,
      transcriptPath: typeof child.metadata?.transcriptPath === 'string'
        ? child.metadata.transcriptPath
        : `nexus://sessions/${child.sessionId}/events`,
      events: page.events,
      nextCursor: page.nextCursor,
      order: query.order,
      limit: query.limit,
    }
  })

  app.post('/v1/sessions/:sessionId/compact', async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    const body = z.object({
      modelId: z.string().optional(),
      trigger: z.enum(['manual', 'auto', 'reactive']).default('manual').optional(),
    }).parse(request.body ?? {})
    const session = await options.storage.getSession(params.sessionId, {
      includeEvents: false,
    })
    if (!session) {
      return reply.code(404).send({
        type: 'error',
        code: 'SESSION_NOT_FOUND',
        message: `Session not found: ${params.sessionId}`,
      })
    }
    const initialPrompt = session.lastUserInput ?? session.prompt
    const result = await compactSession({
      storage: options.storage,
      sessionId: params.sessionId,
      modelId: body.modelId,
      trigger: body.trigger ?? 'manual',
      mapEventsToMessages,
      initialPrompt,
    })
    const persistedEvents = await options.storage.listEvents(params.sessionId, { order: 'asc', limit: 10_000 })
    const assembled = await assembleContext({
      runtimeOptions: {
        sessionId: params.sessionId,
        prompt: initialPrompt,
        cwd: session.cwd,
      },
      events: persistedEvents.events,
      modelId: body.modelId ?? 'local/coding-runtime',
      buildSystemPrompt,
      mapEventsToMessages,
    })
    const groundingEvents = buildPostCompactGroundingEvents({
      sessionId: params.sessionId,
      source: 'post_compact',
      boundaryId: result.contextEvent.boundaryId,
      gitStatus: assembled.gitStatus,
    })
    for (const event of groundingEvents) {
      await options.storage.appendEvent(params.sessionId, event)
    }
    return {
      type: 'compact_result',
      sessionId: params.sessionId,
      event: result.event,
      contextEvent: result.contextEvent,
      groundingEvents,
      beforeEventCount: result.beforeEventCount,
      afterEventCount: result.afterEventCount,
    }
  })

  app.get('/v1/sessions/:sessionId/context', async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    const query = z.object({
      modelId: z.string().optional(),
      prompt: z.string().optional(),
      cwd: z.string().optional(),
    }).parse(request.query)
    const session = await options.storage.getSession(params.sessionId, {
      includeEvents: false,
    })
    if (!session) {
      return reply.code(404).send({
        type: 'error',
        code: 'SESSION_NOT_FOUND',
        message: `Session not found: ${params.sessionId}`,
      })
    }
    const { events } = await options.storage.listEvents(params.sessionId, {
      limit: 10_000,
      order: 'asc',
    })
    const settings = ConfigManager.getInstance().resolveSettings()
    const modelId = query.modelId ?? settings.modelId ?? 'local/coding-runtime'
    const toolDefinitions = (options.runtime.listTools?.() ?? [])
      .filter(tool => tool.allowed)
      .map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema ?? {},
      }))
    const analysis = await analyzeContext({
      runtimeOptions: {
        sessionId: params.sessionId,
        prompt: query.prompt ?? session.lastUserInput ?? session.prompt,
        cwd: query.cwd ?? session.cwd,
        contextFork: readContextForkMetadata(session.metadata),
      },
      events,
      modelId,
      buildSystemPrompt,
      mapEventsToMessages,
      tools: toolDefinitions,
      memoryProvider: options.memoryProvider,
      sessionInbox: await options.storage.listSessionInbox(params.sessionId, { limit: 20 }),
    })
    return analysis
  })

  app.get('/v1/sessions/:sessionId/tool-traces', async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    const query = toolTraceListQuerySchema.parse(request.query)
    const session = await options.storage.getSession(params.sessionId, {
      includeEvents: false,
    })
    if (!session) {
      return reply.code(404).send({
        type: 'error',
        code: 'SESSION_NOT_FOUND',
        message: `Session not found: ${params.sessionId}`,
      })
    }
    const page = await options.storage.listToolTraces(params.sessionId, query)
    return {
      type: 'tool_traces',
      sessionId: params.sessionId,
      traces: page.traces,
      nextCursor: page.nextCursor,
      order: query.order,
      limit: query.limit,
    }
  })

  app.get('/v1/sessions/:sessionId/permission-audits', async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    const session = await options.storage.getSession(params.sessionId, {
      includeEvents: false,
    })
    if (!session) {
      return reply.code(404).send({
        type: 'error',
        code: 'SESSION_NOT_FOUND',
        message: `Session not found: ${params.sessionId}`,
      })
    }
    const audits = await options.storage.listPermissionAudits(params.sessionId)
    return {
      type: 'permission_audits',
      sessionId: params.sessionId,
      audits,
    }
  })

  app.post('/v1/sessions/:sessionId/resume', async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    const body = sessionResumeSchema.parse(request.body ?? {})
    const session = await options.storage.getSession(params.sessionId, {
      includeEvents: false,
    })
    if (!session) {
      return reply.code(404).send({
        type: 'error',
        code: 'SESSION_NOT_FOUND',
        message: `Session not found: ${params.sessionId}`,
      })
    }

    const eventPage = await options.storage.listEvents(params.sessionId, {
      limit: body.recentEventLimit ?? 100,
      order: 'desc',
    })
    const tasks = body.includeTasks === false
      ? []
      : await options.storage.listTasks(params.sessionId)
    const childSessions = body.includeChildSessions === false
      ? []
      : await options.storage.listChildSessions(params.sessionId, {
          limit: 200,
          includeEvents: false,
        })
    const activeExecution = activeExecutions.get(params.sessionId)

    return {
      type: 'session_resume_snapshot',
      sessionId: params.sessionId,
      session: {
        ...session,
        events: [...eventPage.events].reverse(),
      },
      eventsTruncated: eventPage.nextCursor !== undefined,
      recentEventLimit: body.recentEventLimit ?? 100,
      tasks,
      childSessions,
      activeExecution: activeExecution
        ? {
            requestId: activeExecution.requestId,
            transport: activeExecution.transport,
            startedAt: activeExecution.startedAt,
          }
        : null,
    }
  })

  app.post('/v1/sessions/:sessionId/input', async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    const body = sessionInputSchema.parse(request.body)
    const session = await options.storage.getSession(params.sessionId)
    if (!session) {
      return reply.code(404).send({
        type: 'error',
        code: 'SESSION_NOT_FOUND',
        message: `Session not found: ${params.sessionId}`,
      })
    }

    if (session.phase === 'waiting_permission') {
      const lowerMessage = body.message.trim().toLowerCase()
      const approved = ['y', 'yes', 'approve', 'ok', 'true'].includes(lowerMessage)
      PendingPermissionRegistry.getInstance().resolveSession(params.sessionId, {
        approved,
        reason: approved ? undefined : body.message,
      })
    }

    const event: NexusEvent = {
      type: 'user_message',
      ...eventBase(params.sessionId),
      text: body.message,
    }
    session.lastUserInput = body.message
    session.phase = body.nextPhase ?? 'executing'
    session.updatedAt = event.timestamp
    await options.storage.saveSession(session)
    await options.storage.appendEvent(params.sessionId, event)

    return {
      type: 'session_input_accepted',
      sessionId: params.sessionId,
      phase: session.phase,
    }
  })

  app.post('/v1/sessions/:sessionId/approve', async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    // Phase A.1 of the enhanced permission panel: the Go TUI sends
    // `scope: 'session' | 'rule'` with an associated `rule` string
    // for "Approve for this session" / "Approve with editable rule".
    // The runtime's `executeStream` accumulates `scope: 'session'`
    // rules into the per-session map so the remaining turns of the
    // session auto-allow matching tool calls.
    const body = z.object({
      toolUseId: z.string(),
      scope: z.enum(['once', 'session', 'rule']).optional(),
      rule: z.string().optional(),
      feedback: z.string().optional(),
    }).parse(request.body)
    const resolved = PendingPermissionRegistry.getInstance().resolve(
      params.sessionId,
      body.toolUseId,
      {
        approved: true,
        scope: body.scope ?? 'once',
        ...(body.rule && { rule: body.rule }),
        ...(body.feedback && { feedback: body.feedback }),
      }
    )
    if (!resolved) {
      return reply.code(404).send({
        type: 'error',
        code: 'PERMISSION_REQUEST_NOT_FOUND',
        message: `No pending permission request found for session ${params.sessionId} and tool use ${body.toolUseId}`,
      })
    }
    return {
      type: 'permission_resolved',
      sessionId: params.sessionId,
      toolUseId: body.toolUseId,
      approved: true,
      scope: body.scope ?? 'once',
      ...(body.rule && { rule: body.rule }),
      ...(body.feedback && { feedback: body.feedback }),
    }
  })

  app.post('/v1/sessions/:sessionId/deny', async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    // Phase A.1: the `feedback` field is the "Reject, tell the model
    // what to do instead" text. It's surfaced in the runtime's
    // `permission_response` event so the next turn can act on it.
    const body = z.object({
      toolUseId: z.string(),
      reason: z.string().optional(),
      scope: z.enum(['once', 'session', 'rule']).optional(),
      rule: z.string().optional(),
      feedback: z.string().optional(),
    }).parse(request.body)
    const resolved = PendingPermissionRegistry.getInstance().resolve(
      params.sessionId,
      body.toolUseId,
      {
        approved: false,
        reason: body.reason,
        ...(body.scope && { scope: body.scope }),
        ...(body.rule && { rule: body.rule }),
        ...(body.feedback && { feedback: body.feedback }),
      }
    )
    if (!resolved) {
      return reply.code(404).send({
        type: 'error',
        code: 'PERMISSION_REQUEST_NOT_FOUND',
        message: `No pending permission request found for session ${params.sessionId} and tool use ${body.toolUseId}`,
      })
    }
    return {
      type: 'permission_resolved',
      sessionId: params.sessionId,
      toolUseId: body.toolUseId,
      approved: false,
      ...(body.reason && { reason: body.reason }),
      ...(body.feedback && { feedback: body.feedback }),
    }
  })

  app.post('/v1/sessions/:sessionId/cancel', async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    const body = z.object({ reason: z.string().optional() }).parse(request.body ?? {})
    const activeExecution = activeExecutions.get(params.sessionId)
    if (activeExecution) {
      activeExecution.abortController.abort()
    }
    const { session, permissionsResolved, childSessionsCancelled } = await closeNexusSession({
      storage: options.storage,
      sessionId: params.sessionId,
      phase: 'cancelled',
      reason: body.reason ?? 'Session cancelled',
      hooks: ConfigManager.getInstance().load().hooks,
      everCore: options.everCoreConfig
        ? { client: options.everCoreClient, config: options.everCoreConfig }
        : undefined,
    })
    if (!session) {
      return reply.code(404).send({
        type: 'error',
        code: 'SESSION_NOT_FOUND',
        message: `Session not found: ${params.sessionId}`,
      })
    }
    return {
      type: 'session_cancelled',
      sessionId: params.sessionId,
      phase: session.phase,
      activeExecutionCancelled: activeExecution !== undefined,
      requestId: activeExecution?.requestId,
      transport: activeExecution?.transport,
      permissionsResolved,
      childSessionsCancelled,
    }
  })

  app.post('/v1/sessions/:sessionId/close', async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    const body = z.object({
      phase: z.enum(['cancelled', 'completed', 'failed']).optional(),
      reason: z.string().optional(),
    }).parse(request.body ?? {})
    const { session, permissionsResolved, childSessionsCancelled } = await closeNexusSession({
      storage: options.storage,
      sessionId: params.sessionId,
      phase: body.phase,
      reason: body.reason,
      hooks: ConfigManager.getInstance().load().hooks,
      everCore: options.everCoreConfig
        ? { client: options.everCoreClient, config: options.everCoreConfig }
        : undefined,
    })
    if (!session) {
      return reply.code(404).send({
        type: 'error',
        code: 'SESSION_NOT_FOUND',
        message: `Session not found: ${params.sessionId}`,
      })
    }
    return {
      type: 'session_closed',
      sessionId: params.sessionId,
      phase: session.phase,
      permissionsResolved,
      childSessionsCancelled,
    }
  })

  app.get('/v1/sessions/:sessionId/tasks', async request => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    return {
      type: 'tasks_list',
      tasks: await options.storage.listTasks(params.sessionId),
    }
  })

  app.post('/v1/sessions/:sessionId/tasks', async (request, reply) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params)
    const body = createTaskSchema.parse(request.body)
    const session = await getMutableSession(options.storage, params.sessionId)
    if (!session) return reply.code(404).send(createSessionNotFoundPayload(params.sessionId))
    if (isTerminalSessionPhase(session.phase)) return reply.code(409).send(createSessionNotMutablePayload(session))
    const existing = body.requestId ? await findTaskByMutationRequestId(options.storage, params.sessionId, body.requestId) : undefined
    if (existing) return { type: 'task_created', task: existing, idempotent: true }
    const task: NexusTask = {
      taskId: createId('task'),
      sessionId: params.sessionId,
      title: body.title,
      description: body.description,
      status: 'pending',
      source: 'user',
      metadata: attachMutationRequestId(body.metadata, body.requestId),
      dependsOn: [],
      blocks: [],
      retryCount: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    await options.storage.saveTask(task)
    await options.storage.appendEvent(params.sessionId, {
      type: 'task_created',
      ...eventBase(params.sessionId),
      taskId: task.taskId,
      title: task.title,
    })
    await appendTaskMutationAudit(options.storage, params.sessionId, 'task_created', undefined, task, body)
    return { type: 'task_created', task }
  })

  app.patch('/v1/sessions/:sessionId/tasks/:taskId', async (request, reply) => {
    const params = z
      .object({ sessionId: z.string(), taskId: z.string() })
      .parse(request.params)
    const body = updateTaskSchema.parse(request.body)
    const task = await options.storage.getTask(params.taskId)
    if (!task || task.sessionId !== params.sessionId) {
      return reply.code(404).send({
        type: 'error',
        code: 'TASK_NOT_FOUND',
        message: `Task not found: ${params.taskId}`,
      })
    }
    const session = await getMutableSession(options.storage, params.sessionId)
    if (!session) return reply.code(404).send(createSessionNotFoundPayload(params.sessionId))
    if (isTerminalSessionPhase(session.phase)) return reply.code(409).send(createSessionNotMutablePayload(session))
    const conflict = checkTaskRevision(task, body.expectedUpdatedAt)
    if (conflict) return reply.code(409).send(conflict)
    const updated: NexusTask = {
      ...task,
      ...pickTaskPatch(body),
      metadata: mergeTaskMetadata(task.metadata, body.metadata, body.requestId),
      updatedAt: nowIso(),
    }
    await options.storage.saveTask(updated)
    await appendTaskMutationAudit(options.storage, params.sessionId, 'task_updated', task, updated, body)
    return {
      type: 'task_updated',
      task: updated,
    }
  })

  app.post('/v1/sessions/:sessionId/tasks/:taskId/claim', async (request, reply) => {
    return mutateTaskAction(options.storage, request.params, request.body, reply, 'task_claimed', task => ({
      ...task,
      status: 'in_progress',
    }))
  })

  app.post('/v1/sessions/:sessionId/tasks/:taskId/complete', async (request, reply) => {
    return mutateTaskAction(options.storage, request.params, request.body, reply, 'task_completed', (task, body) => ({
      ...task,
      status: 'completed',
      result: body.result,
    }))
  })

  app.post('/v1/sessions/:sessionId/tasks/:taskId/fail', async (request, reply) => {
    return mutateTaskAction(options.storage, request.params, request.body, reply, 'task_failed', async (task, body) => {
      const failedTask: NexusTask = {
        ...task,
        status: 'failed',
        result: body.result,
      }
      const blockedTasksFailed = await propagateFailedDependency(
        options.storage,
        task.sessionId,
        failedTask,
      )
      return {
        ...failedTask,
        metadata: {
          ...(failedTask.metadata ?? {}),
          ...(blockedTasksFailed.length > 0 ? { blockedTasksFailed } : {}),
        },
      }
    })
  })

  app.post('/v1/sessions/:sessionId/tasks/:taskId/cancel', async (request, reply) => {
    return mutateTaskAction(options.storage, request.params, request.body, reply, 'task_cancelled', async (task, body) => {
      const childSessionsCancelled = await cancelChildSessionsForTask(
        options.storage,
        task.sessionId,
        task.taskId,
        body.reason ?? 'Task cancelled',
      )
      const blockedTasksFailed = await failBlockedTasksForDependency(
        options.storage,
        task.sessionId,
        task.taskId,
        body.reason ?? 'Task cancelled',
      )
      return {
        ...task,
        status: 'cancelled',
        metadata: {
          ...(task.metadata ?? {}),
          ...(childSessionsCancelled.length > 0 ? { childSessionsCancelled } : {}),
          ...(blockedTasksFailed.length > 0 ? { blockedTasksFailed } : {}),
        },
      }
    })
  })

  app.post('/v1/sessions/:sessionId/tasks/:taskId/retry', async (request, reply) => {
    return mutateTaskAction(options.storage, request.params, request.body, reply, 'task_retried', async task => {
      const blockedTasksRestored = await restoreTasksFailedByDependency(
        options.storage,
        task.sessionId,
        task.taskId,
      )
      return {
        ...task,
        status: 'pending',
        retryCount: task.retryCount + 1,
        result: undefined,
        review: task.review?.status === 'pending' ? task.review : undefined,
        metadata: {
          ...(task.metadata ?? {}),
          ...(blockedTasksRestored.length > 0 ? { blockedTasksRestored } : {}),
        },
      }
    })
  })

  app.post('/v1/sessions/:sessionId/tasks/:taskId/rerun-subagent', async (request, reply) => {
    const params = z
      .object({ sessionId: z.string(), taskId: z.string() })
      .parse(request.params)
    const body = subAgentRerunSchema.parse(request.body ?? {})
    const task = await options.storage.getTask(params.taskId)
    if (!task || task.sessionId !== params.sessionId) {
      return reply.code(404).send({
        type: 'error',
        code: 'TASK_NOT_FOUND',
        message: `Task not found: ${params.taskId}`,
      })
    }
    const session = await options.storage.getSession(params.sessionId, { includeEvents: false })
    if (!session) return reply.code(404).send(createSessionNotFoundPayload(params.sessionId))
    const conflict = checkTaskRevision(task, body.expectedUpdatedAt)
    if (conflict) return reply.code(409).send(conflict)
    const updated = await applySubAgentRerunAction(options.storage, session, task, body)
    await appendTaskMutationAudit(options.storage, params.sessionId, 'subagent_rerun_requested', task, updated, body)
    return {
      type: 'subagent_rerun_requested',
      task: updated,
    }
  })

  app.post('/v1/sessions/:sessionId/tasks/:taskId/worktree-recovery', async (request, reply) => {
    const params = z
      .object({ sessionId: z.string(), taskId: z.string() })
      .parse(request.params)
    const body = worktreeRecoveryActionSchema.parse(request.body ?? {})
    const task = await options.storage.getTask(params.taskId)
    if (!task || task.sessionId !== params.sessionId) {
      return reply.code(404).send({
        type: 'error',
        code: 'TASK_NOT_FOUND',
        message: `Task not found: ${params.taskId}`,
      })
    }
    const session = await getMutableSession(options.storage, params.sessionId)
    if (!session) return reply.code(404).send(createSessionNotFoundPayload(params.sessionId))
    const conflict = checkTaskRevision(task, body.expectedUpdatedAt)
    if (conflict) return reply.code(409).send(conflict)
    const updated = await applyWorktreeRecoveryAction(options.storage, session, task, body)
    await appendTaskMutationAudit(options.storage, params.sessionId, 'worktree_recovery_action', task, updated, body)
    return {
      type: 'worktree_recovery_action',
      action: body.action,
      task: updated,
    }
  })

  app.post('/v1/sessions/:sessionId/tasks/:taskId/approve', async (request, reply) => {
    return mutateTaskAction(options.storage, request.params, request.body, reply, 'task_approved', (task, body) => {
      assertPendingTaskReview(task)
      return {
        ...task,
        review: {
          ...task.review,
          status: 'approved',
          reason: body.reviewReason ?? body.reason,
        },
      }
    })
  })

  app.post('/v1/sessions/:sessionId/tasks/:taskId/reject', async (request, reply) => {
    return mutateTaskAction(options.storage, request.params, request.body, reply, 'task_rejected', (task, body) => {
      assertPendingTaskReview(task)
      return {
        ...task,
        review: {
          ...task.review,
          status: 'rejected',
          reason: body.reviewReason ?? body.reason,
        },
      }
    })
  })

  app.get('/v1/stream', { websocket: true }, socket => {
    socket.on('message', async (raw: Buffer) => {
      const parsedJson = parseJsonObject(raw)
      if (parsedJson && typeof parsedJson === 'object' && 'type' in parsedJson && parsedJson.type === 'permission_response') {
        const res = (parsedJson as unknown) as {
          sessionId: string
          toolUseId: string
          approved: boolean
          reason?: string
          scope?: 'once' | 'session' | 'rule'
          rule?: string
          feedback?: string
        }
        PendingPermissionRegistry.getInstance().resolve(res.sessionId, res.toolUseId, {
          approved: res.approved,
          reason: res.reason,
          ...(res.scope && { scope: res.scope }),
          ...(res.rule && { rule: res.rule }),
          ...(res.feedback && { feedback: res.feedback }),
        })
        return
      }

      let closedByClient = false
      const markClosed = () => {
        closedByClient = true
      }
      socket.once('close', markClosed)

      const releaseExecution = executionGate.tryAcquire()
      if (!releaseExecution) {
        metrics.recordStreamRejected()
        sendJson(socket, {
          type: 'error',
          code: 'EXECUTION_BUSY',
          message: 'Nexus execution capacity is full. Try again shortly.',
        })
        socket.off('close', markClosed)
        return
      }

      metrics.recordStreamStart()
      const startedAtMs = metrics.now()
      let abortController: AbortController | undefined
      socket.once('close', () => abortController?.abort())

      let success = false
      let timedOut = false
      try {
        const parsed = executeSchema.safeParse(parsedJson)
        if (!parsed.success) {
          sendJson(socket, {
            type: 'error',
            code: 'INVALID_REQUEST',
            message: z.prettifyError(parsed.error),
          })
          return
        }

      const body = parsed.data
      const prepared = await prepareExecution(body)
      if (isPrepareError(prepared)) {
        sendJson(socket, { type: 'error', code: prepared.code, message: prepared.message })
        return
      }
      const { sessionId, cwd, requestId } = prepared
      abortController = prepared.abortController
      registerActiveExecution(sessionId, {
        requestId,
        abortController,
        transport: 'websocket',
        startedAt: nowIso(),
      })
      const timeout = prepared.timeout
      const events: NexusEvent[] = []
      const effectiveTimeoutMs = prepared.timeoutDecision.softTimeoutMs
      const nearTimeoutWatcher = startNearTimeoutWatcher({
        events,
        sessionId,
        requestId,
        timeoutMs: effectiveTimeoutMs,
        startedAtMs,
        send: event => {
          if (socket.readyState === socket.OPEN) {
            sendJson(socket, event)
            metrics.recordStreamEvent(socket.bufferedAmount)
          }
        },
      })
      // Phase 2: soft watcher fires once at the soft budget and
      // pushes `timeout_budget_exceeded` over the WS without
      // aborting. Hard watchdog still owns abort. Only run under
      // soft policy; legacy fatal callers fall through to the
      // existing watchdog-driven cutoff.
      //
      // Phase 3: same cycle as the HTTP path — after each soft
      // budget exhaustion the runtime may auto-grant a bounded
      // number of extensions (announced via
      // `timeout_extension_granted`). fatal policy keeps
      // `maxSoftTimeoutExtensions` at 0 in
      // `resolveExecuteTimeoutDecision`, so legacy WS callers do
      // not see the new event stream either.
      const softTimeoutCycle = prepared.timeoutDecision.policy === 'soft'
        ? scheduleSoftTimeoutCycle({
            events,
            sessionId,
            requestId,
            softTimeoutMs: effectiveTimeoutMs,
            startedAtMs,
            maxExtensions: prepared.timeoutDecision.maxSoftTimeoutExtensions,
            extensionMs: prepared.timeoutDecision.softTimeoutExtensionMs,
            send: event => {
              if (socket.readyState === socket.OPEN) {
                sendJson(socket, event)
                metrics.recordStreamEvent(socket.bufferedAmount)
              }
            },
          })
        : undefined

      try {
        for await (const event of options.runtime.executeStream({
          sessionId,
          prompt: body.prompt,
          cwd,
          signal: abortController.signal,
          timeoutSignal: prepared.timeoutController.signal,
          maxToolOutputBytes: body.maxToolOutputBytes ?? maxToolOutputBytes,
          bashMaxBufferBytes,
          skipPermissionCheck: body.skipPermissionCheck,
          requestId,
          model: body.model,
          budget: body.budget,
          executionEnvironment: body.executionEnvironment,
          remoteRunner: options.remoteRunner,
          allowedPaths: prepared.allowedPaths,
          policyMode: prepared.policyMode,
          ...(prepared.allowedTools && { allowedTools: prepared.allowedTools }),
        })) {
          // Phase 5: same watchdog decoration as the HTTP
          // path. Soft policy + watchdog fired ⇒ rewrite the
          // REQUEST_TIMEOUT error event with
          // details.kind='watchdog' before persisting, pushing
          // to the events array, and sending it over the WS.
          const decoratedEvent = maybeDecorateWatchdogError({
            event,
            timeoutDecision: prepared.timeoutDecision,
            watchdog: prepared.watchdog,
            events,
          }) ?? event
          events.push(decoratedEvent)
          await options.storage.appendEvent(sessionId, decoratedEvent)
          recordEventMetrics(decoratedEvent)
          if (socket.readyState !== socket.OPEN) {
            abortController.abort()
            break
          }
          sendJson(socket, decoratedEvent)
          metrics.recordStreamEvent(socket.bufferedAmount)
          await maybeAppendNearTimeoutWarning({
            events,
            sessionId,
            requestId,
            timeoutMs: effectiveTimeoutMs,
            elapsedMs: Math.max(0, Math.round(metrics.now() - startedAtMs)),
            send: warning => {
              if (socket.readyState === socket.OPEN) {
                sendJson(socket, warning)
                metrics.recordStreamEvent(socket.bufferedAmount)
              }
            },
          })
          if (decoratedEvent.type === 'result') success = decoratedEvent.success
          if (decoratedEvent.type === 'error' && decoratedEvent.code === 'REQUEST_TIMEOUT') {
            timedOut = true
          }
        }
      } finally {
        clearTimeout(nearTimeoutWatcher)
        softTimeoutCycle?.cancel()
        clearTimeout(timeout)
      }
      timedOut = timedOut || abortController.signal.aborted
      let resultEvent = events.findLast(event => event.type === 'result')
      const errorEvent = events.findLast(event => event.type === 'error')
      const partialResultEvent = await appendTimeoutPartialResult({
        storage: options.storage,
        sessionId,
        events,
        resultEvent,
        errorEvent,
        send: event => {
          if (socket.readyState === socket.OPEN) {
            sendJson(socket, event)
            metrics.recordStreamEvent(socket.bufferedAmount)
          }
        },
      })
      if (partialResultEvent) {
        resultEvent = partialResultEvent
        success = false
      }
      const recoveredFromToolDenial = isRecoverableToolDenialOnlyTurn(events, resultEvent, errorEvent, timedOut)
      if (recoveredFromToolDenial) success = true
      await finalizeExecutionSession(options.storage, sessionId, {
        succeeded: success,
        resultEvent,
        errorEvent,
        contextBlockingEvent: events.find(event => event.type === 'context_blocking'),
      })
      const executeDurationMs = Math.max(0, Math.round(metrics.now() - startedAtMs))
      const summaryEvent = buildExecuteSummaryEvent({
        sessionId,
        requestId,
        timeoutMs: effectiveTimeoutMs,
        executeDurationMs,
        outcome: executeSummaryOutcome(resultEvent, errorEvent, timedOut, recoveredFromToolDenial),
      })
      events.push(summaryEvent)
      await options.storage.appendEvent(sessionId, summaryEvent)
      sendJson(socket, summaryEvent)
      metrics.recordStreamEvent(socket.bufferedAmount)
      } finally {
        socket.off('close', markClosed)
        if (abortController) {
          for (const [sessionId, execution] of activeExecutions.entries()) {
            if (execution.abortController === abortController) {
              clearActiveExecution(sessionId, execution.requestId)
              break
            }
          }
        }
        releaseExecution()
        metrics.recordStreamFinish({
          success,
          timedOut,
          clientClosed: closedByClient,
          durationMs: metrics.now() - startedAtMs,
        })
      }
    })
  })

  // PR-27: /v1/working-set/observe — WebSocket push for working_set_updated
  // and working_set_reset events. Per design §7.3 WebSocket + PR-26 event bus.
  // Pure read: subscribes to a tracker's event bus and fans out to the
  // client. No state mutation.
  app.get('/v1/working-set/observe', { websocket: true }, async (socket, request) => {
    // Use the FastifyRequest for query parsing (the @fastify/websocket
    // handshake is unreliable across versions).
    const q = (request.query ?? {}) as Record<string, string | undefined>
    const cwd = typeof q.cwd === 'string' ? q.cwd : undefined
    if (!cwd) {
      sendJson(socket, { type: 'error', code: 'MISSING_CWD', message: 'cwd query param is required' })
      socket.close(1008, 'missing cwd')
      return
    }
    const sessionId = typeof q.sessionId === 'string' ? q.sessionId : undefined

    // Use the shared broadcaster if provided (lets REST + WS share the
    // same tracker instance, so REST mutations flow into WS events).
    // Otherwise create a per-connection broadcaster as a fallback.
    const broadcaster = options.workingSetBroadcaster ?? appBroadcaster
    const entry = broadcaster.getOrCreateTracker(cwd)
    try {
      await entry.loadPromise
    } catch (err) {
      sendJson(socket, {
        type: 'error',
        code: 'LOAD_FAILED',
        message: err instanceof Error ? err.message : String(err),
      })
      socket.close(1011, 'load failed')
      return
    }

    // Initial snapshot (per design §7.3: 'on connect, send latest state').
    const initialState: Array<{ sessionId: string; ws: unknown }> = []
    for (const [sid, ws] of entry.tracker.entries()) {
      if (sessionId && sid !== sessionId) continue
      initialState.push({ sessionId: sid, ws })
    }
    sendJson(socket, {
      type: 'working_set_snapshot',
      cwd,
      filter: { sessionId: sessionId ?? null },
      sessions: initialState,
    })

    // Subscribe to events. Filter by sessionId if requested.
    const handler = (event: WorkingSetEvent) => {
      if (sessionId && event.sessionId !== sessionId) return
      if (event.type === 'working_set_updated') {
        sendJson(socket, {
          type: 'working_set_updated',
          sessionId: event.sessionId,
          workspaceId: event.workspaceId,
          ws: event.ws,
          timestamp: event.timestamp,
        })
      } else if (event.type === 'working_set_reset') {
        sendJson(socket, {
          type: 'working_set_reset',
          sessionId: event.sessionId,
          workspaceId: event.workspaceId,
          timestamp: event.timestamp,
        })
      }
    }
    const unsubscribe = entry.tracker.subscribe(handler)

    const cleanup = () => {
      try { unsubscribe() } catch { /* ignore */ }
    }
    socket.once('close', cleanup)
    socket.once('error', cleanup)
  })

  // PR-A2: /v1/context/observe — WebSocket push for assembled context
  // events emitted by the runtime's hot path. Per design §7.3
  // WebSocket + PR-A2 event bus. Sends an initial `assembled_snapshot`
  // frame on connect (from the broadcaster's lastBySessionId cache),
  // then live `assembled` events. Pure read: subscribes to the
  // broadcaster and fans out to the client. No state mutation.
  app.get('/v1/context/observe', { websocket: true }, async (socket, request) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    const cwd = typeof q.cwd === 'string' ? q.cwd : undefined
    if (!cwd) {
      sendJson(socket, { type: 'error', code: 'MISSING_CWD', message: 'cwd query param is required' })
      socket.close(1008, 'missing cwd')
      return
    }
    const sessionId = typeof q.sessionId === 'string' ? q.sessionId : undefined

    // PR-A2: the WS route always reads from the module-level singleton
    // (which the createNexusApp call above may have replaced with the
    // caller's `options.contextBroadcaster`). The runtime hot path also
    // publishes to this singleton, so by default both sides share the
    // same instance — no extra wiring required.
    const broadcaster = defaultContextBroadcaster

    // Initial snapshot (per design §7.3: 'on connect, send latest state').
    // When sessionId is set, the snapshot is just that session's last
    // context; otherwise the snapshot's `context` field is null (no
    // global "all sessions" view — the cache is per-sessionId).
    const last = sessionId ? broadcaster.getLast(cwd, sessionId) : undefined
    sendJson(socket, {
      type: 'assembled_snapshot',
      cwd,
      filter: { sessionId: sessionId ?? null },
      context: last ?? null,
    })

    // Subscribe to events. Filter by sessionId if requested.
    const handler = (event: { type: string; sessionId: string; context: unknown; timestamp: string }) => {
      if (event.type !== 'assembled') return
      if (sessionId && event.sessionId !== sessionId) return
      sendJson(socket, {
        type: 'assembled',
        cwd,
        sessionId: event.sessionId,
        context: event.context,
        timestamp: event.timestamp,
      })
    }
    const unsubscribe = broadcaster.subscribe(cwd, handler)

    const cleanup = () => {
      try { unsubscribe() } catch { /* ignore */ }
    }
    socket.once('close', cleanup)
    socket.once('error', cleanup)
  })

  return app
}

function parseJsonObject(raw: Buffer): unknown {
  try {
    return JSON.parse(String(raw))
  } catch {
    return {}
  }
}

function sendJson(socket: WebSocketLike, value: unknown): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(value))
  }
}

// PR-27: parse WebSocket query string. Robust to either @fastify/websocket
// shape (handshake.query object) or raw URL on `socket.url`.
function parseSocketQuery(socket: { url?: string; handshake?: { query?: Record<string, unknown> } }): Record<string, string | undefined> {
  const handshakeQuery = socket.handshake?.query
  if (handshakeQuery && typeof handshakeQuery === 'object') {
    const out: Record<string, string | undefined> = {}
    for (const [k, v] of Object.entries(handshakeQuery)) {
      if (typeof v === 'string') out[k] = v
      else if (Array.isArray(v) && typeof v[0] === 'string') out[k] = v[0]
    }
    return out
  }
  const url = socket.url
  if (typeof url !== 'string') return {}
  const qIdx = url.indexOf('?')
  if (qIdx < 0) return {}
  const out: Record<string, string | undefined> = {}
  const search = url.slice(qIdx + 1)
  for (const pair of search.split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    if (eq < 0) {
      out[decodeURIComponent(pair)] = ''
    } else {
      const key = decodeURIComponent(pair.slice(0, eq))
      const val = decodeURIComponent(pair.slice(eq + 1))
      out[key] = val
    }
  }
  return out
}

async function findAgentJob(scheduler: AgentScheduler, jobId: string): Promise<AgentJob | undefined> {
  try {
    return (await scheduler.listAgents()).find(job => job.jobId === jobId)
  } catch (error) {
    if (error instanceof AgentJobRegistryError && error.code === 'AGENT_JOB_NOT_FOUND') return undefined
    throw error
  }
}

function sendAgentError(reply: FastifyReply, error: AgentJobRegistryError): unknown {
  return reply.code(error.status).send({
    type: 'error',
    code: error.code,
    message: error.message,
  })
}

function createAgentJobNotFoundPayload(jobId: string): { type: 'error'; code: string; message: string } {
  return {
    type: 'error',
    code: 'AGENT_JOB_NOT_FOUND',
    message: `Agent job not found: ${jobId}`,
  }
}

function createSessionChannelNotFoundPayload(channelId: string): { type: 'error'; code: string; message: string } {
  return {
    type: 'error',
    code: 'SESSION_CHANNEL_NOT_FOUND',
    message: `Session channel not found: ${channelId}`,
  }
}

function createSessionMessageNotFoundPayload(messageId: string): { type: 'error'; code: string; message: string } {
  return {
    type: 'error',
    code: 'SESSION_MESSAGE_NOT_FOUND',
    message: `Session message not found: ${messageId}`,
  }
}

function mergeSessionChannelPolicy(policy: Partial<SessionChannelPolicy> | undefined): SessionChannelPolicy {
  return {
    ...DEFAULT_SESSION_CHANNEL_POLICY,
    ...(policy ?? {}),
    allowedMessageTypes: policy?.allowedMessageTypes ?? DEFAULT_SESSION_CHANNEL_POLICY.allowedMessageTypes,
  }
}

function withMemoryCandidateGovernance(channel: SessionChannel, message: SessionMessage): SessionMessage {
  if (message.type !== 'memory_candidate') return message
  const governance = evaluateSessionMemoryCandidate({ channel, message })
  return {
    ...message,
    metadata: {
      ...(message.metadata ?? {}),
      memoryCandidateGovernance: governance,
    },
  }
}

function validateSessionChannelMessage(
  channel: SessionChannel,
  body: z.infer<typeof createSessionMessageSchema>,
): { type: 'error'; code: string; message: string } | undefined {
  if (channel.status !== 'open') {
    return {
      type: 'error',
      code: 'SESSION_CHANNEL_CLOSED',
      message: `Session channel is not open: ${channel.channelId}`,
    }
  }
  if (!channel.participantSessionIds.includes(body.fromSessionId)) {
    return {
      type: 'error',
      code: 'INVALID_SESSION_MESSAGE',
      message: 'fromSessionId must be a channel participant',
    }
  }
  if (body.toSessionId && !channel.participantSessionIds.includes(body.toSessionId)) {
    return {
      type: 'error',
      code: 'INVALID_SESSION_MESSAGE',
      message: 'toSessionId must be a channel participant',
    }
  }
  if (body.toSessionId === body.fromSessionId) {
    return {
      type: 'error',
      code: 'INVALID_SESSION_MESSAGE',
      message: 'Session messages cannot target the sending session',
    }
  }
  const broadcast = body.broadcast ?? body.toSessionId === undefined
  if (broadcast && !channel.policy.allowBroadcast) {
    return {
      type: 'error',
      code: 'INVALID_SESSION_MESSAGE',
      message: 'Broadcast messages are disabled for this channel',
    }
  }
  if (!broadcast && !body.toSessionId) {
    return {
      type: 'error',
      code: 'INVALID_SESSION_MESSAGE',
      message: 'Non-broadcast messages require toSessionId',
    }
  }
  if (!channel.policy.allowedMessageTypes.includes(body.type)) {
    return {
      type: 'error',
      code: 'INVALID_SESSION_MESSAGE',
      message: `Message type is not allowed for this channel: ${body.type}`,
    }
  }
  if (body.content.length > channel.policy.maxMessageChars) {
    return {
      type: 'error',
      code: 'INVALID_SESSION_MESSAGE',
      message: `Message content exceeds channel maxMessageChars: ${channel.policy.maxMessageChars}`,
    }
  }
  if ((body.evidence?.length ?? 0) > channel.policy.maxEvidenceRefs) {
    return {
      type: 'error',
      code: 'INVALID_SESSION_MESSAGE',
      message: `Message evidence exceeds channel maxEvidenceRefs: ${channel.policy.maxEvidenceRefs}`,
    }
  }
  return undefined
}

function isSessionMessageRecipient(
  message: SessionMessage,
  sessionId: string,
  channel: SessionChannel | null,
): boolean {
  if (!channel || !channel.participantSessionIds.includes(sessionId)) return false
  if (message.fromSessionId === sessionId) return false
  if (message.toSessionId) return message.toSessionId === sessionId
  return message.broadcast === true
}

function readContextForkMetadata(metadata: Record<string, unknown> | undefined): { mode: string; inheritedItems: number; omittedItems: number } | undefined {
  const contextFork = asRecord(metadata?.contextFork)
  const mode = typeof metadata?.contextForkMode === 'string'
    ? metadata.contextForkMode
    : typeof contextFork?.mode === 'string'
      ? contextFork.mode
      : undefined
  if (!mode) return undefined
  const inheritedItems = typeof contextFork?.inheritedItems === 'number' ? contextFork.inheritedItems : 0
  const omittedItems = typeof contextFork?.omittedItems === 'number' ? contextFork.omittedItems : 0
  return { mode, inheritedItems, omittedItems }
}

type ExecutionFinalizationOptions = {
  succeeded: boolean
  resultEvent?: NexusEvent
  errorEvent?: NexusEvent
  contextBlockingEvent?: NexusEvent
}

async function finalizeExecutionSession(
  storage: NexusStorage,
  sessionId: string,
  finalization: ExecutionFinalizationOptions,
): Promise<void> {
  const session = await storage.getSession(sessionId, { includeEvents: false })
  if (!session) return

  if (session.phase !== 'cancelled') {
    session.phase = finalization.succeeded ? 'completed' : 'failed'
  }
  session.updatedAt = nowIso()

  if (finalization.resultEvent?.type === 'result') {
    session.result = finalization.resultEvent.message
  }

  if (finalization.succeeded) {
    session.error = undefined
    session.failureReason = undefined
    session.terminalReason = undefined
    session.metadata = withRuntimeRecoveryMetadata(session.metadata)
  } else if (finalization.errorEvent?.type === 'error') {
    session.error = finalization.errorEvent.message
    session.failureReason = finalization.errorEvent.message
    session.terminalReason = runtimeTerminalReason(finalization.errorEvent)
    session.metadata = withRuntimeRecoveryMetadata(
      session.metadata,
      runtimeRecoveryMetadata(finalization.errorEvent, finalization.contextBlockingEvent),
    )
  } else {
    session.metadata = withRuntimeRecoveryMetadata(session.metadata)
  }

  await storage.saveSession(session)
}

function runtimeTerminalReason(event: Extract<NexusEvent, { type: 'error' }>): TaskSessionTerminalReason {
  return {
    category: runtimeTerminalCategoryForCode(event.code),
    code: event.code,
    message: event.message,
  }
}

function runtimeTerminalCategoryForCode(code: string): TaskSessionTerminalReason['category'] {
  if (code === 'REQUEST_TIMEOUT') return 'timeout'
  if (code === 'REQUEST_CANCELLED') return 'cancelled'
  if (code.startsWith('PROVIDER_')) return 'provider'
  if (code === 'CONTEXT_LIMIT_EXCEEDED' || code.startsWith('RUNTIME_') || code === 'NEXUS_RUNTIME_ERROR') return 'runtime'
  return 'error'
}

const EXECUTE_TIMEOUT_NEAR_RATIO = 0.8

function hasPartialTimeoutEvidence(events: readonly NexusEvent[]): boolean {
  return events.some(event =>
    (event.type === 'assistant_delta' && event.text.trim().length > 0) ||
    event.type === 'tool_completed' ||
    event.type === 'tool_denied' ||
    event.type === 'permission_response',
  )
}

function buildPartialTimeoutSummary(events: readonly NexusEvent[]): string | undefined {
  const assistantText = events
    .filter((event): event is Extract<NexusEvent, { type: 'assistant_delta' }> => event.type === 'assistant_delta')
    .map(event => event.text)
    .join('')
    .trim()
  if (assistantText) {
    return truncateForTimeoutSummary(assistantText)
  }
  const toolEvidence = events
    .filter((event): event is Extract<NexusEvent, { type: 'tool_completed' | 'tool_denied' }> => event.type === 'tool_completed' || event.type === 'tool_denied')
    .map(event => {
      if (event.type === 'tool_denied') return `${event.name} denied: ${event.message}`
      return `${event.name} ${event.success ? 'completed' : 'failed'}`
    })
  if (toolEvidence.length > 0) {
    return truncateForTimeoutSummary(`Tool evidence before timeout: ${toolEvidence.slice(-3).join('; ')}`)
  }
  return undefined
}

function truncateForTimeoutSummary(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > 800 ? `${normalized.slice(0, 797)}...` : normalized
}

function buildNearTimeoutWarningEvent(options: {
  sessionId: string
  requestId?: string
  timeoutMs: number
  elapsedMs: number
  partialSummary?: string
}): Extract<NexusEvent, { type: 'near_timeout_warning' }> {
  const message = options.partialSummary
    ? 'Execution is near its timeout budget; preserve a concise partial answer now.'
    : 'Execution is near its timeout budget; wrap up as soon as possible.'
  return {
    type: 'near_timeout_warning',
    ...eventBase(options.sessionId),
    ...(options.requestId !== undefined && { requestId: options.requestId }),
    timeoutMs: options.timeoutMs,
    elapsedMs: options.elapsedMs,
    thresholdRatio: EXECUTE_TIMEOUT_NEAR_RATIO,
    ...(options.partialSummary !== undefined && { partialSummary: options.partialSummary }),
    message,
  }
}

/**
 * Phase 2 of the task-adaptive-recoverable-timeout plan: build a
 * `timeout_budget_exceeded` event without aborting the runtime.
 *
 * The event signals to the model that the soft budget has been
 * reached. The hard watchdog is still running, so the runtime loop
 * continues; the model is expected to react to this event in its
 * next provider call (continue, summarize, narrow scope, or retry
 * the last tool with a larger budget).
 */
function buildTimeoutBudgetExceededEvent(options: {
  sessionId: string
  requestId?: string
  timeoutMs: number
  elapsedMs: number
  partialSummary?: string
}): Extract<NexusEvent, { type: 'timeout_budget_exceeded' }> {
  const message = options.partialSummary
    ? 'Soft timeout budget exhausted; the workflow continues — summarize, narrow scope, or continue with a fresh budget.'
    : 'Soft timeout budget exhausted; the workflow continues — pick a next step (continue / summarize / narrow scope / retry_last_tool).'
  return {
    type: 'timeout_budget_exceeded',
    ...eventBase(options.sessionId),
    ...(options.requestId !== undefined && { requestId: options.requestId }),
    timeoutMs: options.timeoutMs,
    elapsedMs: options.elapsedMs,
    policy: 'soft',
    ...(options.partialSummary !== undefined && { partialSummary: options.partialSummary }),
    suggestedActions: ['continue', 'summarize', 'narrow_scope', 'retry_last_tool'],
    message,
  }
}

/**
 * Phase 3 of the task-adaptive-recoverable-timeout plan: announce
 * an auto-extension of the soft budget so the model has time to
 * react to the budget warning with a deliberate choice. Hard
 * watchdog is never extended here.
 */
function buildTimeoutExtensionGrantedEvent(options: {
  sessionId: string
  requestId?: string
  extensionCount: number
  maxExtensions: number
  additionalMs: number
  totalSoftBudgetMs: number
  elapsedMs: number
}): Extract<NexusEvent, { type: 'timeout_extension_granted' }> {
  const reason: 'auto-first-budget-exhausted' | 'auto-followup-budget-exhausted' =
    options.extensionCount === 1
      ? 'auto-first-budget-exhausted'
      : 'auto-followup-budget-exhausted'
  const remaining = Math.max(0, options.maxExtensions - options.extensionCount)
  const message = remaining > 0
    ? `Soft timeout extended by ${options.additionalMs}ms (extension ${options.extensionCount}/${options.maxExtensions}; ${remaining} remaining). Pick a deliberate next step.`
    : `Soft timeout extended by ${options.additionalMs}ms (extension ${options.extensionCount}/${options.maxExtensions}; this is the last automatic extension). Wrap up or request user confirmation before the watchdog fires.`
  return {
    type: 'timeout_extension_granted',
    ...eventBase(options.sessionId),
    ...(options.requestId !== undefined && { requestId: options.requestId }),
    extensionCount: options.extensionCount,
    maxExtensions: options.maxExtensions,
    additionalMs: options.additionalMs,
    totalSoftBudgetMs: options.totalSoftBudgetMs,
    elapsedMs: options.elapsedMs,
    policy: 'soft',
    reason,
    message,
  }
}

function buildTimeoutPartialResultMessage(baseMessage: string, events: readonly NexusEvent[]): string {
  const partialSummary = buildPartialTimeoutSummary(events)
  if (!partialSummary) return baseMessage
  return `${baseMessage}\n\nPartial result preserved before timeout:\n${partialSummary}`
}

async function appendTimeoutPartialResult(options: {
  storage: NexusStorage
  sessionId: string
  events: NexusEvent[]
  resultEvent: NexusEvent | undefined
  errorEvent: NexusEvent | undefined
  send?: (event: NexusEvent) => void
}): Promise<Extract<NexusEvent, { type: 'result' }> | undefined> {
  if (options.errorEvent?.type !== 'error' || options.errorEvent.code !== 'REQUEST_TIMEOUT') return undefined
  const baseMessage = options.resultEvent?.type === 'result'
    ? options.resultEvent.message
    : options.errorEvent.message
  const message = buildTimeoutPartialResultMessage(baseMessage, options.events)
  if (message === baseMessage) return undefined
  const partialResult: Extract<NexusEvent, { type: 'result' }> = {
    type: 'result',
    ...eventBase(options.sessionId),
    success: false,
    message,
  }
  options.events.push(partialResult)
  await options.storage.appendEvent(options.sessionId, partialResult)
  options.send?.(partialResult)
  return partialResult
}

function executeTimeoutNear(durationMs: number, timeoutMs: number): boolean {
  if (timeoutMs <= 0) return false
  return durationMs / timeoutMs >= EXECUTE_TIMEOUT_NEAR_RATIO
}

function executeSummaryOutcome(
  resultEvent: NexusEvent | undefined,
  errorEvent: NexusEvent | undefined,
  timedOutByAbort: boolean,
  recoveredFromToolDenial = false,
): 'success' | 'error' | 'cancelled' | 'timeout' {
  if (errorEvent?.type === 'error' && errorEvent.code === 'REQUEST_TIMEOUT') return 'timeout'
  if (errorEvent?.type === 'error' && errorEvent.code === 'REQUEST_CANCELLED') return 'cancelled'
  if (timedOutByAbort) return 'cancelled'
  if (errorEvent?.type === 'error') return 'error'
  if (resultEvent?.type === 'result' && resultEvent.success) return 'success'
  if (recoveredFromToolDenial) return 'success'
  return 'error'
}

function isRecoverableToolDenialOnlyTurn(
  events: readonly NexusEvent[],
  resultEvent: NexusEvent | undefined,
  errorEvent: NexusEvent | undefined,
  timedOutByAbort: boolean,
): boolean {
  if (timedOutByAbort || errorEvent?.type === 'error') return false
  if (resultEvent?.type !== 'result' || resultEvent.success) return false
  const denials = events.filter((event): event is Extract<NexusEvent, { type: 'tool_denied' }> =>
    event.type === 'tool_denied',
  )
  if (denials.length === 0) return false
  return denials.every(event => event.recoverable === true && event.terminal !== true)
}

type ExecuteSummaryOptions = {
  sessionId: string
  requestId?: string
  timeoutMs: number
  executeDurationMs: number
  outcome: 'success' | 'error' | 'cancelled' | 'timeout'
}

function buildExecuteSummaryEvent(options: ExecuteSummaryOptions): Extract<NexusEvent, { type: 'execute_summary' }> {
  return {
    type: 'execute_summary',
    ...eventBase(options.sessionId),
    ...(options.requestId !== undefined && { requestId: options.requestId }),
    timeoutMs: options.timeoutMs,
    executeDurationMs: options.executeDurationMs,
    nearTimeout: executeTimeoutNear(options.executeDurationMs, options.timeoutMs),
    outcome: options.outcome,
  }
}

function runtimeRecoveryMetadata(
  errorEvent: Extract<NexusEvent, { type: 'error' }>,
  contextBlockingEvent?: NexusEvent,
): Record<string, unknown> | undefined {
  if (errorEvent.code !== 'CONTEXT_LIMIT_EXCEEDED') return undefined
  const details = asRecord(errorEvent.details)
  const blocking = contextBlockingEvent?.type === 'context_blocking' ? contextBlockingEvent : undefined
  return {
    kind: typeof details?.kind === 'string' ? details.kind : 'context_window',
    code: errorEvent.code,
    retryable: typeof details?.retryable === 'boolean' ? details.retryable : true,
    recoveryReason: typeof details?.recoveryReason === 'string' ? details.recoveryReason : 'CONTEXT_BLOCKING_LIMIT',
    httpStatus: numberValue(details?.httpStatus) ?? blocking?.httpStatus ?? 413,
    tokenEstimate: blocking?.tokenEstimate ?? numberValue(details?.tokenEstimate),
    maxTokens: blocking?.maxTokens ?? numberValue(details?.maxTokens),
    blockingLimitTokens: blocking?.blockingLimitTokens ?? numberValue(details?.blockingLimitTokens),
    recoveryActions: recoveryActionsValue(blocking?.recoveryActions ?? details?.recoveryActions),
    suggestion: typeof details?.suggestion === 'string'
      ? details.suggestion
      : 'Run /compact or /context, switch to a larger context model, or reduce tool output before retrying.',
  }
}

function withRuntimeRecoveryMetadata(
  metadata: Record<string, unknown> | undefined,
  runtimeRecovery?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const next = { ...(metadata ?? {}) }
  delete next.runtimeRecovery
  if (runtimeRecovery) next.runtimeRecovery = runtimeRecovery
  return Object.keys(next).length > 0 ? next : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function recoveryActionsValue(value: unknown): string[] {
  const allowed = new Set(['compact', 'context', 'switch_model', 'reduce_tool_output'])
  const actions = Array.isArray(value)
    ? value.filter((action): action is string => typeof action === 'string' && allowed.has(action))
    : []
  return actions.length > 0 ? actions : ['compact', 'context', 'switch_model', 'reduce_tool_output']
}

type TaskMutationAudit = z.infer<typeof taskMutationAuditSchema>

type TaskActionBody = z.infer<typeof taskActionSchema>

type WorktreeRecoveryActionBody = z.infer<typeof worktreeRecoveryActionSchema>

type SubAgentRerunBody = z.infer<typeof subAgentRerunSchema>

type WorktreeRecoveryMetadata = {
  type?: string
  status?: string
  cwd?: string
  worktreePath?: string
  preservedWorktreePath?: string
  taskId?: string
}

type SubAgentReferenceMetadata = {
  status?: string
  subSessionId?: string
  transcriptPath?: string
  summary?: string
  resultEventRange?: unknown
}

type TaskMutationHttpError = {
  statusCode: number
  payload: { type: 'error'; code: string; message: string; task?: NexusTask }
}

async function mutateTaskAction(
  storage: NexusStorage,
  rawParams: unknown,
  rawBody: unknown,
  reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } },
  eventType: string,
  apply: (task: NexusTask, body: TaskActionBody) => NexusTask | Promise<NexusTask>,
): Promise<unknown> {
  const params = z
    .object({ sessionId: z.string(), taskId: z.string() })
    .parse(rawParams)
  const body = taskActionSchema.parse(rawBody ?? {})
  const task = await storage.getTask(params.taskId)
  if (!task || task.sessionId !== params.sessionId) {
    return reply.code(404).send({
      type: 'error',
      code: 'TASK_NOT_FOUND',
      message: `Task not found: ${params.taskId}`,
    })
  }
  const session = await getMutableSession(storage, params.sessionId)
  if (!session) return reply.code(404).send(createSessionNotFoundPayload(params.sessionId))
  if (isTerminalSessionPhase(session.phase)) return reply.code(409).send(createSessionNotMutablePayload(session))
  const conflict = checkTaskRevision(task, body.expectedUpdatedAt)
  if (conflict) return reply.code(409).send(conflict)
  let applied: NexusTask
  try {
    applied = await apply(task, body)
  } catch (error) {
    if (isTaskMutationHttpError(error)) return reply.code(error.statusCode).send(error.payload)
    throw error
  }
  const updated = {
    ...applied,
    ownerAgentId: body.ownerAgentId ?? applied.ownerAgentId,
    metadata: mergeTaskMetadata(task.metadata, applied.metadata, body.requestId),
    updatedAt: nowIso(),
  }
  await storage.saveTask(updated)
  await appendTaskMutationAudit(storage, params.sessionId, eventType, task, updated, body)
  return { type: eventType, task: updated }
}

async function applySubAgentRerunAction(
  storage: NexusStorage,
  session: SessionSnapshot,
  task: NexusTask,
  body: SubAgentRerunBody,
): Promise<NexusTask> {
  const subAgent = getFailedSubAgentMetadata(task)
  if (!subAgent) {
    throw createTaskMutationHttpError(409, 'SUBAGENT_RERUN_NOT_AVAILABLE', `Task ${task.taskId} does not reference a failed sub-agent.`, task)
  }

  const previousSubAgents = Array.isArray(task.metadata?.previousSubAgents)
    ? [...task.metadata.previousSubAgents]
    : []
  const blockedTasksRestored = await restoreTasksFailedByDependency(
    storage,
    task.sessionId,
    task.taskId,
  )
  const rerunRequest = {
    requestedAt: nowIso(),
    requestedBy: body.actor ?? 'external',
    source: body.source ?? 'sdk',
    reason: body.reason,
    previousSubSessionId: subAgent.subSessionId,
    previousTranscriptPath: subAgent.transcriptPath,
    nextRetryCount: task.retryCount + 1,
  }
  const updated: NexusTask = {
    ...task,
    status: 'pending',
    ownerAgentId: undefined,
    retryCount: task.retryCount + 1,
    result: undefined,
    review: task.review?.status === 'pending' ? task.review : undefined,
    metadata: {
      ...(task.metadata ?? {}),
      previousSubAgents: [...previousSubAgents, subAgent],
      subAgentRerun: rerunRequest,
      ...(blockedTasksRestored.length > 0 ? { blockedTasksRestored } : {}),
    },
    updatedAt: nowIso(),
  }
  await storage.saveTask(updated)

  if (session.phase === 'failed' || session.phase === 'cancelled') {
    await storage.saveSession({
      ...session,
      phase: 'executing',
      terminalReason: undefined,
      error: undefined,
      failureReason: undefined,
      lastUserInput: 'sub-agent rerun requested',
      updatedAt: nowIso(),
    })
  }
  return updated
}

function getFailedSubAgentMetadata(task: NexusTask): SubAgentReferenceMetadata | undefined {
  const subAgent = task.metadata?.subAgent
  if (typeof subAgent !== 'object' || subAgent === null) return undefined
  const typed = subAgent as SubAgentReferenceMetadata
  if (typed.status !== 'failed' && typed.status !== 'cancelled') return undefined
  if (!typed.subSessionId || !typed.transcriptPath) return undefined
  return typed
}

async function applyWorktreeRecoveryAction(
  storage: NexusStorage,
  session: SessionSnapshot,
  task: NexusTask,
  body: WorktreeRecoveryActionBody,
): Promise<NexusTask> {
  const recovery = getWorktreeRecoveryMetadata(task)
  if (!recovery) {
    throw createTaskMutationHttpError(409, 'WORKTREE_RECOVERY_NOT_AVAILABLE', `Task ${task.taskId} does not have pending worktree recovery metadata.`, task)
  }

  const nextRecovery = {
    ...recovery,
    status: body.action === 'continue'
      ? 'retry_requested'
      : body.action === 'abandon'
        ? 'abandoned'
        : 'kept',
    selectedAction: body.action,
    selectedAt: nowIso(),
    selectedBy: body.actor ?? 'external',
    reason: body.reason,
  }

  if (body.action === 'abandon' || body.action === 'continue') {
    const { cwd, worktreePath } = assertRecoverableWorktreePath(session, task, recovery)
    await removeWorktree(cwd, worktreePath, task.taskId)
  }

  const updated: NexusTask = {
    ...task,
    status: body.action === 'continue' ? 'pending' : task.status,
    ownerAgentId: body.action === 'continue' ? undefined : task.ownerAgentId,
    retryCount: body.action === 'continue' ? task.retryCount + 1 : task.retryCount,
    result: body.action === 'continue' ? undefined : task.result,
    review: body.action === 'continue'
      ? task.review?.status === 'pending' ? task.review : undefined
      : task.review,
    metadata: {
      ...(task.metadata ?? {}),
      worktreeRecovery: nextRecovery,
    },
    updatedAt: nowIso(),
  }
  await storage.saveTask(updated)

  const nextSession: SessionSnapshot = {
    ...session,
    phase: body.action === 'continue' && session.phase === 'waiting_user' ? 'executing' : session.phase,
    pendingInput: body.action === 'continue' ? undefined : session.pendingInput,
    lastUserInput: `worktree recovery ${body.action}`,
    updatedAt: nowIso(),
  }
  await storage.saveSession(nextSession)
  return updated
}

function getWorktreeRecoveryMetadata(task: NexusTask): WorktreeRecoveryMetadata | undefined {
  const recovery = task.metadata?.worktreeRecovery
  if (typeof recovery !== 'object' || recovery === null) return undefined
  const typed = recovery as WorktreeRecoveryMetadata
  if (typed.type !== 'worktree_merge_conflict') return undefined
  if (typed.status && !['awaiting_manual_recovery', 'kept'].includes(typed.status)) return undefined
  return typed
}

function assertRecoverableWorktreePath(
  session: SessionSnapshot,
  task: NexusTask,
  recovery: WorktreeRecoveryMetadata,
): { cwd: string; worktreePath: string } {
  const cwd = recovery.cwd
  const worktreePath = recovery.preservedWorktreePath ?? recovery.worktreePath
  if (!cwd || !worktreePath) {
    throw createTaskMutationHttpError(409, 'WORKTREE_RECOVERY_INVALID', `Task ${task.taskId} worktree recovery metadata is missing cwd or worktreePath.`, task)
  }
  const resolvedCwd = resolve(cwd)
  const resolvedWorktreePath = resolve(worktreePath)
  const expectedPrefix = resolve(resolvedCwd, '.babel-o', 'worktrees')
  if (resolvedCwd !== resolve(session.cwd) || !resolvedWorktreePath.startsWith(`${expectedPrefix}/`)) {
    throw createTaskMutationHttpError(409, 'WORKTREE_RECOVERY_INVALID', `Task ${task.taskId} worktree recovery path is outside the session worktree directory.`, task)
  }
  return { cwd: resolvedCwd, worktreePath: resolvedWorktreePath }
}

function pickTaskPatch(body: z.infer<typeof updateTaskSchema>): Partial<NexusTask> {
  const patch: Partial<NexusTask> = {}
  if (body.title !== undefined) patch.title = body.title
  if (body.description !== undefined) patch.description = body.description
  if (body.status !== undefined) patch.status = body.status
  if (body.result !== undefined) patch.result = body.result
  return patch
}

function checkTaskRevision(task: NexusTask, expectedUpdatedAt?: string): { type: 'error'; code: string; message: string; task: NexusTask } | undefined {
  if (expectedUpdatedAt && task.updatedAt !== expectedUpdatedAt) {
    return {
      type: 'error',
      code: 'TASK_REVISION_CONFLICT',
      message: `Task ${task.taskId} was updated after expected revision ${expectedUpdatedAt}.`,
      task,
    }
  }
  return undefined
}

async function getMutableSession(storage: NexusStorage, sessionId: string): Promise<SessionSnapshot | null> {
  return storage.getSession(sessionId, { includeEvents: false })
}

function isTerminalSessionPhase(phase: SessionSnapshot['phase']): boolean {
  return TERMINAL_SESSION_PHASES.has(phase)
}

function createSessionNotFoundPayload(sessionId: string): { type: 'error'; code: string; message: string } {
  return {
    type: 'error',
    code: 'SESSION_NOT_FOUND',
    message: `Session not found: ${sessionId}`,
  }
}

function createSessionNotMutablePayload(session: SessionSnapshot): { type: 'error'; code: string; message: string; session: SessionSnapshot } {
  return {
    type: 'error',
    code: 'SESSION_NOT_MUTABLE',
    message: `Session ${session.sessionId} is ${session.phase} and cannot accept task mutations.`,
    session,
  }
}

function assertPendingTaskReview(task: NexusTask): void {
  if (task.review?.status === 'pending') return
  throw createTaskMutationHttpError(409, 'TASK_REVIEW_NOT_PENDING', `Task ${task.taskId} does not have a pending review.`, task)
}

function createTaskMutationHttpError(statusCode: number, code: string, message: string, task?: NexusTask): TaskMutationHttpError {
  return {
    statusCode,
    payload: {
      type: 'error',
      code,
      message,
      task,
    },
  }
}

function isTaskMutationHttpError(error: unknown): error is TaskMutationHttpError {
  return typeof error === 'object'
    && error !== null
    && 'statusCode' in error
    && 'payload' in error
}

function attachMutationRequestId(metadata: Record<string, unknown> | undefined, requestId: string | undefined): Record<string, unknown> | undefined {
  if (!requestId) return metadata
  return {
    ...(metadata ?? {}),
    mutationRequestId: requestId,
  }
}

function mergeTaskMetadata(current: Record<string, unknown> | undefined, patch: Record<string, unknown> | undefined, requestId: string | undefined): Record<string, unknown> | undefined {
  if (!current && !patch && !requestId) return undefined
  return {
    ...(current ?? {}),
    ...(patch ?? {}),
    ...(requestId ? { mutationRequestId: requestId } : {}),
  }
}

async function findTaskByMutationRequestId(storage: NexusStorage, sessionId: string, requestId: string): Promise<NexusTask | undefined> {
  const tasks = await storage.listTasks(sessionId)
  return tasks.find(task => task.metadata?.mutationRequestId === requestId)
}

const TERMINAL_SESSION_PHASES = new Set(['completed', 'failed', 'cancelled'])

async function cancelChildSessionsForTask(
  storage: NexusStorage,
  sessionId: string,
  taskId: string,
  reason: string,
): Promise<string[]> {
  const cancelled: string[] = []
  for (const child of await storage.listChildSessions(sessionId, { limit: 200 })) {
    if (TERMINAL_SESSION_PHASES.has(child.phase)) continue
    if (!isChildSessionForTask(child, taskId)) continue
    child.phase = 'cancelled'
    child.terminalReason = {
      category: 'cancelled',
      code: 'TASK_CANCELLED',
      message: reason,
    }
    child.updatedAt = nowIso()
    child.metadata = {
      ...(child.metadata ?? {}),
      status: 'cancelled',
      cancelledByTaskId: taskId,
      cancelReason: reason,
    }
    await storage.saveSession(child)
    cancelled.push(child.sessionId)
  }
  return cancelled
}

function isChildSessionForTask(child: { currentTaskId?: string; metadata?: Record<string, unknown> }, taskId: string): boolean {
  return child.currentTaskId === taskId || child.metadata?.parentTaskId === taskId || child.metadata?.taskId === taskId
}

async function failBlockedTasksForDependency(
  storage: NexusStorage,
  sessionId: string,
  taskId: string,
  reason: string,
): Promise<string[]> {
  const failed: string[] = []
  for (const task of await storage.listTasks(sessionId)) {
    if (task.taskId === taskId) continue
    if (!task.dependsOn.includes(taskId)) continue
    if (!isDependencyFailureTarget(task)) continue
    const updated: NexusTask = {
      ...task,
      status: 'failed',
      result: `Dependency task ${taskId} was cancelled.`,
      metadata: {
        ...(task.metadata ?? {}),
        failedDependencyTaskId: taskId,
        failedDependencyReason: reason,
      },
      updatedAt: nowIso(),
    }
    await storage.saveTask(updated)
    failed.push(task.taskId)
  }
  return failed
}

async function propagateFailedDependency(
  storage: NexusStorage,
  sessionId: string,
  failedTask: NexusTask,
): Promise<string[]> {
  const failed: string[] = []
  let changed = true
  while (changed) {
    changed = false
    for (const task of await storage.listTasks(sessionId)) {
      if (task.taskId === failedTask.taskId) continue
      if (!isDependencyFailureTarget(task)) continue
      const failedDependencies = await getFailedDependencies(storage, task, failedTask)
      if (failedDependencies.length === 0) continue
      const updated: NexusTask = {
        ...task,
        status: 'failed',
        result: failedDependencies
          .map(dep => dep.result || `Dependency ${dep.taskId} failed`)
          .join('\n') || 'Dependency failed',
        metadata: {
          ...(task.metadata ?? {}),
          failedDependencies: failedDependencies.map(dep => ({
            taskId: dep.taskId,
            title: dep.title,
            result: dep.result,
            metadata: dep.metadata,
          })),
        },
        updatedAt: nowIso(),
      }
      await storage.saveTask(updated)
      failed.push(task.taskId)
      changed = true
    }
  }
  return [...new Set(failed)]
}

async function getFailedDependencies(storage: NexusStorage, task: NexusTask, currentFailedTask: NexusTask): Promise<NexusTask[]> {
  const failed: NexusTask[] = []
  for (const dependencyId of task.dependsOn) {
    if (dependencyId === currentFailedTask.taskId) {
      failed.push(currentFailedTask)
      continue
    }
    const dependency = await storage.getTask(dependencyId)
    if (dependency?.status === 'failed') failed.push(dependency)
  }
  return failed
}

async function restoreTasksFailedByDependency(
  storage: NexusStorage,
  sessionId: string,
  dependencyTaskId: string,
): Promise<string[]> {
  const restored: string[] = []
  for (const task of await storage.listTasks(sessionId)) {
    if (task.taskId === dependencyTaskId) continue
    if (task.status !== 'failed') continue
    if (!task.dependsOn.includes(dependencyTaskId)) continue
    if (!hasFailedDependencyMetadata(task, dependencyTaskId)) continue
    const metadata = { ...(task.metadata ?? {}) }
    delete metadata.failedDependencyTaskId
    delete metadata.failedDependencyReason
    delete metadata.failedDependencies
    const updated: NexusTask = {
      ...task,
      status: 'blocked',
      result: undefined,
      metadata,
      updatedAt: nowIso(),
    }
    await storage.saveTask(updated)
    restored.push(task.taskId)
  }
  return restored
}

function isDependencyFailureTarget(task: NexusTask): boolean {
  return task.status === 'blocked' || task.status === 'pending' || task.status === 'in_progress'
}

function hasFailedDependencyMetadata(task: NexusTask, dependencyTaskId: string): boolean {
  if (task.metadata?.failedDependencyTaskId === dependencyTaskId) return true
  const failedDependencies = task.metadata?.failedDependencies
  return Array.isArray(failedDependencies) && failedDependencies.some(dep =>
    typeof dep === 'object' && dep !== null && (dep as { taskId?: unknown }).taskId === dependencyTaskId,
  )
}

async function appendTaskMutationAudit(
  storage: NexusStorage,
  sessionId: string,
  eventType: string,
  previous: NexusTask | undefined,
  next: NexusTask,
  audit: TaskMutationAudit,
): Promise<void> {
  await storage.appendEvent(sessionId, {
    type: 'task_session_event',
    schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
    sessionId,
    eventId: createId('task_event'),
    eventType,
    phase: next.status,
    timestamp: nowIso(),
    payload: {
      actor: audit.actor ?? 'external',
      source: audit.source ?? 'sdk',
      reason: audit.reason,
      requestId: audit.requestId,
      taskId: next.taskId,
      parentTaskId: typeof next.metadata?.parentTaskId === 'string' ? next.metadata.parentTaskId : undefined,
      previous: previous ? taskAuditSnapshot(previous) : undefined,
      next: taskAuditSnapshot(next),
    },
  })
}

function taskAuditSnapshot(task: NexusTask): {
  taskId: string
  title: string
  description?: string
  status: TaskStatus
  ownerAgentId?: string
  retryCount: number
  result?: string
  metadata?: Record<string, unknown>
  review?: NexusTask['review']
  updatedAt: string
} {
  return {
    taskId: task.taskId,
    title: task.title,
    description: task.description,
    status: task.status,
    ownerAgentId: task.ownerAgentId,
    retryCount: task.retryCount,
    result: task.result,
    metadata: task.metadata,
    review: task.review,
    updatedAt: task.updatedAt,
  }
}

type RuntimeMetricsSnapshot = ReturnType<NexusMetrics['snapshot']>

type ProviderInvocationMetrics = {
  count: number
  successCount: number
  failureCount: number
  durationMs: {
    totalMs: number
    count: number
    avgMs: number
  }
  byFailureKind: Record<string, number>
  byErrorCode: Record<string, number>
  byRole: Record<string, { count: number; successCount: number; failureCount: number; avgDurationMs: number }>
}

type AgentLoopMetrics = {
  sessionsObserved: number
  taskSessionEventCount: number
  taskCount: number
  completedTaskCount: number
  failedTaskCount: number
  retryCount: number
  subAgentSessionCount: number
  roleStepCount: number
  roleInputTokens: number
  roleOutputTokens: number
  roleDurationMs: {
    totalMs: number
    count: number
    avgMs: number
  }
  byRole: Record<string, {
    count: number
    successCount: number
    failureCount: number
    inputTokens: number
    outputTokens: number
    avgDurationMs: number
  }>
  byFailureType: Record<string, number>
}

type AgentJobMetrics = {
  count: number
  completedCount: number
  failedCount: number
  cancelledCount: number
  byAgentType: Record<string, { count: number; completedCount: number; failedCount: number; cancelledCount: number }>
  byFailureCode: Record<string, number>
}

async function buildRuntimeMetricsSnapshot(
  metrics: NexusMetrics,
  storage: NexusStorage,
): Promise<RuntimeMetricsSnapshot & {
  providerInvocations: ProviderInvocationMetrics
  agentLoop: AgentLoopMetrics
  agentJobs: AgentJobMetrics
}> {
  const snapshot = metrics.snapshot()
  const recentSessions = await storage.listSessions({ limit: 100, includeEvents: false })
  const providerInvocations = createProviderInvocationMetrics()
  const agentLoop = createAgentLoopMetrics()
  const agentJobs = createAgentJobMetrics()

  for (const session of recentSessions) {
    const page = await storage.listEvents(session.sessionId, { limit: 500, order: 'asc' })
    const sawTaskSessionEvent = page.events.some(event => event.type === 'task_session_event')
    if (sawTaskSessionEvent) agentLoop.sessionsObserved += 1
    for (const event of page.events) {
      recordProviderInvocationMetrics(providerInvocations, event)
      recordAgentLoopMetrics(agentLoop, event)
      recordAgentJobMetrics(agentJobs, event)
    }
  }

  finalizeProviderInvocationMetrics(providerInvocations)
  finalizeAgentLoopMetrics(agentLoop)
  return {
    ...snapshot,
    providerInvocations,
    agentLoop,
    agentJobs,
  }
}

function createProviderInvocationMetrics(): ProviderInvocationMetrics {
  return {
    count: 0,
    successCount: 0,
    failureCount: 0,
    durationMs: { totalMs: 0, count: 0, avgMs: 0 },
    byFailureKind: {},
    byErrorCode: {},
    byRole: {},
  }
}

function recordProviderInvocationMetrics(metrics: ProviderInvocationMetrics, event: NexusEvent): void {
  if (event.type !== 'hook_completed' || event.hookEvent !== 'PostInvocation') return
  const output = asRecord(event.output)
  const invocation = asRecord(output?.metadata)
  if (!invocation) return
  const success = invocation.success === true
  const role = typeof invocation.role === 'string' ? invocation.role : 'unknown'
  metrics.count += 1
  if (success) {
    metrics.successCount += 1
  } else {
    metrics.failureCount += 1
  }
  const durationMs = numberValue(invocation.durationMs)
  if (durationMs !== undefined) {
    metrics.durationMs.totalMs = round(metrics.durationMs.totalMs + durationMs)
    metrics.durationMs.count += 1
  }
  const failureKind = typeof invocation.failureKind === 'string' ? invocation.failureKind : undefined
  if (failureKind) metrics.byFailureKind[failureKind] = (metrics.byFailureKind[failureKind] ?? 0) + 1
  const errorCode = typeof invocation.errorCode === 'string' ? invocation.errorCode : undefined
  if (errorCode) metrics.byErrorCode[errorCode] = (metrics.byErrorCode[errorCode] ?? 0) + 1
  const roleMetrics = metrics.byRole[role] ?? { count: 0, successCount: 0, failureCount: 0, avgDurationMs: 0 }
  roleMetrics.count += 1
  if (success) roleMetrics.successCount += 1
  else roleMetrics.failureCount += 1
  if (durationMs !== undefined) {
    const previousTotal = roleMetrics.avgDurationMs * (roleMetrics.count - 1)
    roleMetrics.avgDurationMs = round((previousTotal + durationMs) / roleMetrics.count)
  }
  metrics.byRole[role] = roleMetrics
}

function finalizeProviderInvocationMetrics(metrics: ProviderInvocationMetrics): void {
  metrics.durationMs.avgMs = metrics.durationMs.count > 0
    ? round(metrics.durationMs.totalMs / metrics.durationMs.count)
    : 0
}

function createAgentLoopMetrics(): AgentLoopMetrics {
  return {
    sessionsObserved: 0,
    taskSessionEventCount: 0,
    taskCount: 0,
    completedTaskCount: 0,
    failedTaskCount: 0,
    retryCount: 0,
    subAgentSessionCount: 0,
    roleStepCount: 0,
    roleInputTokens: 0,
    roleOutputTokens: 0,
    roleDurationMs: { totalMs: 0, count: 0, avgMs: 0 },
    byRole: {},
    byFailureType: {},
  }
}

function recordAgentLoopMetrics(metrics: AgentLoopMetrics, event: NexusEvent): void {
  if (event.type !== 'task_session_event') return
  metrics.taskSessionEventCount += 1
  if (event.eventType === 'task_created') metrics.taskCount += 1
  if (event.eventType === 'task_completed') metrics.completedTaskCount += 1
  if (event.eventType === 'sub_agent_session_started') metrics.subAgentSessionCount += 1
  if (event.eventType === 'executor_failed_error') incrementCount(metrics.byFailureType, 'executor_error')
  if (event.eventType === 'critic_failed_error') incrementCount(metrics.byFailureType, 'critic_error')
  if (event.eventType === 'subagent_failed') incrementCount(metrics.byFailureType, 'subagent_failed')
  if (event.eventType === 'subagent_cancelled') incrementCount(metrics.byFailureType, 'subagent_cancelled')
  if (event.eventType === 'agent_loop_role_step_metrics') {
    recordAgentLoopRoleStepMetrics(metrics, event.payload)
    return
  }
  if (event.eventType !== 'task_updated') return
  const payload = asRecord(event.payload)
  const task = asRecord(payload?.task) ?? asRecord(payload?.next)
  const retryCount = numberValue(task?.retryCount)
  if (retryCount !== undefined && retryCount > 0) metrics.retryCount += 1
  if (task?.status === 'failed') metrics.failedTaskCount += 1
  const review = asRecord(task?.review)
  if (review?.reviewerAgentId === 'critic' && typeof review.reason === 'string') incrementCount(metrics.byFailureType, 'critic_rejected')
  if (review?.reviewerAgentId === 'system' && review.reason === 'Executor step returned failure or crashed') incrementCount(metrics.byFailureType, 'executor_failed')
}

function recordAgentLoopRoleStepMetrics(metrics: AgentLoopMetrics, payloadValue: unknown): void {
  const payload = asRecord(payloadValue)
  if (!payload) return
  const role = typeof payload.role === 'string' ? payload.role : 'unknown'
  const durationMs = numberValue(payload.durationMs) ?? 0
  const inputTokens = numberValue(payload.inputTokens) ?? 0
  const outputTokens = numberValue(payload.outputTokens) ?? 0
  const success = payload.success === true
  metrics.roleStepCount += 1
  metrics.roleInputTokens += inputTokens
  metrics.roleOutputTokens += outputTokens
  metrics.roleDurationMs.totalMs = round(metrics.roleDurationMs.totalMs + durationMs)
  metrics.roleDurationMs.count += 1
  const roleMetrics = metrics.byRole[role] ?? {
    count: 0,
    successCount: 0,
    failureCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    avgDurationMs: 0,
  }
  roleMetrics.count += 1
  if (success) roleMetrics.successCount += 1
  else roleMetrics.failureCount += 1
  roleMetrics.inputTokens += inputTokens
  roleMetrics.outputTokens += outputTokens
  const previousTotal = roleMetrics.avgDurationMs * (roleMetrics.count - 1)
  roleMetrics.avgDurationMs = round((previousTotal + durationMs) / roleMetrics.count)
  metrics.byRole[role] = roleMetrics
  const failureType = typeof payload.failureType === 'string' ? payload.failureType : undefined
  if (failureType) incrementCount(metrics.byFailureType, failureType)
  const errorCode = typeof payload.errorCode === 'string' ? payload.errorCode : undefined
  if (errorCode) incrementCount(metrics.byFailureType, errorCode)
}

function finalizeAgentLoopMetrics(metrics: AgentLoopMetrics): void {
  metrics.roleDurationMs.avgMs = metrics.roleDurationMs.count > 0
    ? round(metrics.roleDurationMs.totalMs / metrics.roleDurationMs.count)
    : 0
}

function createAgentJobMetrics(): AgentJobMetrics {
  return {
    count: 0,
    completedCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    byAgentType: {},
    byFailureCode: {},
  }
}

function recordAgentJobMetrics(metrics: AgentJobMetrics, event: NexusEvent): void {
  if (event.type !== 'agent_job_event') return
  if (event.eventType !== 'agent_job_completed' && event.eventType !== 'agent_job_failed' && event.eventType !== 'agent_job_cancelled') return
  metrics.count += 1
  const agentType = event.agentType
  const agentTypeMetrics = metrics.byAgentType[agentType] ?? { count: 0, completedCount: 0, failedCount: 0, cancelledCount: 0 }
  agentTypeMetrics.count += 1
  if (event.eventType === 'agent_job_completed') {
    metrics.completedCount += 1
    agentTypeMetrics.completedCount += 1
  } else if (event.eventType === 'agent_job_failed') {
    metrics.failedCount += 1
    agentTypeMetrics.failedCount += 1
    const error = asRecord(event.error)
    const code = typeof error?.code === 'string' ? error.code : 'unknown'
    incrementCount(metrics.byFailureCode, code)
  } else {
    metrics.cancelledCount += 1
    agentTypeMetrics.cancelledCount += 1
  }
  metrics.byAgentType[agentType] = agentTypeMetrics
}

function incrementCount(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1
}

function createSessionSnapshot(
  sessionId: string,
  cwd: string,
  prompt: string,
): SessionSnapshot {
  const timestamp = nowIso()
  return {
    sessionId,
    cwd,
    prompt,
    phase: 'executing',
    createdAt: timestamp,
    updatedAt: timestamp,
    events: [],
  }
}

function resolveRequestCwd(options: {
  prompt: string
  requestedCwd?: string
  sessionCwd?: string
  defaultCwd: string
}): string {
  const explicitCwd = resolveExplicitPromptCwd(options.prompt)
  if (explicitCwd) {
    return explicitCwd
  }
  if (options.requestedCwd && options.requestedCwd !== options.defaultCwd) {
    return options.requestedCwd
  }
  return options.sessionCwd ?? options.requestedCwd ?? options.defaultCwd
}

function resolveExplicitPromptCwd(prompt: string): string | undefined {
  for (const candidate of extractAbsolutePaths(prompt)) {
    const resolved = resolvePromptPath(candidate)
    if (!existsSync(resolved)) continue
    try {
      const stat = lstatSync(resolved)
      if (stat.isDirectory()) return resolved
    } catch {
      continue
    }
  }
  return undefined
}

export function isLocalHost(h: string): boolean {
  const normalized = h.toLowerCase().trim()
  return (
    normalized === '127.0.0.1' ||
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '[::1]'
  )
}

export function validateSecurityConfig(host: string, apiKey: string | undefined): void {
  if (!isLocalHost(host) && !apiKey) {
    throw new Error(
      `Security Error: Running Nexus on non-localhost (${host}) requires setting the NEXUS_API_KEY environment variable.`,
    )
  }
}

// ─── PR-11: /v1/context/history endpoint helpers ──────────────────────────
//
// These are free functions (not closures) so they can be unit-tested
// independently of the Fastify request lifecycle. The route handler above
// just validates params and delegates here.

import { existsSync as _existsSync, readFileSync as _readFileSync } from 'node:fs'
import { resolve as _resolve } from 'node:path'
import {
  BEHAVIOR_TRACE_RELATIVE_PATH,
  type BehaviorTraceEntry,
} from '../runtime/behaviorTrace.js'
import { searchEvents, summarizeWindow } from '../tools/contextTools.js'

export function parseSinceFromQuery(s: string): number | undefined {
  const match = s.trim().match(/^(\d+)\s*([hmdw])$/i)
  if (!match) return undefined
  const n = Number(match[1])
  const unit = match[2]!.toLowerCase()
  if (unit === 'm') return n * 60_000
  if (unit === 'h') return n * 60 * 60_000
  if (unit === 'd') return n * 24 * 60 * 60_000
  if (unit === 'w') return n * 7 * 24 * 60 * 60_000
  return undefined
}

export type ContextHistoryParams = {
  cwd: string
  scope: 'search' | 'summarize'
  query?: string
  sinceMs?: number
  maxTokens: number
  summarizeScope: 'all' | 'error' | 'denial' | 'scope-drift' | 'user-redirect' | 'trajectory-end' | 'cross-session'
}

export async function runContextHistory(params: ContextHistoryParams): Promise<{
  type: 'context_history_result'
  scope: 'search' | 'summarize'
  content: string
  hitCount: number
  tokenEstimate: number
  truncated: boolean
  contentTruncated?: number
}> {
  const tracePath = _resolve(params.cwd, BEHAVIOR_TRACE_RELATIVE_PATH)
  if (!_existsSync(tracePath)) {
    return {
      type: 'context_history_result',
      scope: params.scope,
      content: '(no behavior trace file yet)',
      hitCount: 0,
      tokenEstimate: 5,
      truncated: false,
    }
  }

  let entries: BehaviorTraceEntry[] = []
  try {
    const raw = _readFileSync(tracePath, 'utf8')
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        entries.push(JSON.parse(trimmed) as BehaviorTraceEntry)
      } catch {
        // skip malformed lines
      }
    }
  } catch (error) {
    throw new Error(`Failed to read trace file: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (params.scope === 'search') {
    if (!params.query) {
      throw new Error('query is required for search scope')
    }
    const events: NexusEvent[] = entries.map((e, i) => ({
      type: 'tool_started',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId: e.sessionId,
      timestamp: e.timestamp,
      toolUseId: `trc_${i}`,
      name: 'behavior_trace',
      input: {
        trigger: e.trigger,
        errorMessage: e.anomaly?.errorMessage,
        errorCode: e.anomaly?.errorCode,
        denialReason: e.anomaly?.denialReason,
        driftPath: e.anomaly?.driftPath,
        userRedirectSignal: e.anomaly?.userRedirectSignal,
        source: (e.anomaly as { source?: string } | undefined)?.source,
      },
    }))
    const result = searchEvents(events, params.query, {
      sinceMs: params.sinceMs,
      maxTokens: params.maxTokens,
    })
    return {
      type: 'context_history_result',
      scope: 'search',
      content: result.content,
      hitCount: result.hitCount,
      tokenEstimate: result.tokenEstimate,
      truncated: result.truncated,
      contentTruncated: result.truncatedAt,
    }
  }

  const summary = summarizeWindow(entries, {
    scope: params.summarizeScope,
    sinceMs: params.sinceMs,
    maxTokens: params.maxTokens,
  })
  return {
    type: 'context_history_result',
    scope: 'summarize',
    content: summary.content,
    hitCount: summary.hitCount,
    tokenEstimate: summary.tokenEstimate,
    truncated: summary.truncated,
    contentTruncated: summary.truncatedAt,
  }
}

// ─── PR-B2: /v1/context/trace endpoint helper ─────────────────────────────
//
// Per docs/nexus/reference/long-running-context-assembly.md §18.2 B2.
// Reads the same <cwd>/.babel-o/behavior-trace.jsonl file that
// runContextHistory reads, but returns the raw typed entries
// (BehaviorTraceEntry[]) instead of a summarized markdown blob.
// The TUI's StatusBehaviorHint overlay renders each entry on its
// own line. Optional sessionId filter narrows to a single
// session; sinceMs filters to entries within the window
// (default 24h, matches runContextHistory); limit caps the
// returned array (default 100, max 1000).
export async function runBehaviorTraceGet({
  cwd,
  sessionId,
  limit,
  sinceMs,
}: {
  cwd: string
  sessionId?: string
  limit: number
  sinceMs: number
}): Promise<{
  type: 'behavior_trace_result'
  cwd: string
  sessionId: string
  entries: BehaviorTraceEntry[]
  count: number
}> {
  let all: BehaviorTraceEntry[] = []
  const tracePath = _resolve(cwd, BEHAVIOR_TRACE_RELATIVE_PATH)
  if (_existsSync(tracePath)) {
    try {
      const raw = _readFileSync(tracePath, 'utf8')
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          all.push(JSON.parse(trimmed) as BehaviorTraceEntry)
        } catch {
          // skip malformed lines (mirrors runContextHistory)
        }
      }
    } catch (error) {
      throw new Error(`Failed to read trace file: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // Filter: time window (sinceMs back from now), then optional
  // sessionId. The default sinceMs (24h) is enforced by the
  // caller; the helper accepts the raw value so test paths
  // can pass 0 to disable.
  const cutoff = Date.now() - Math.max(0, sinceMs)
  let filtered = all.filter((e) => {
    const ts = Date.parse(e.timestamp ?? '')
    if (!Number.isFinite(ts)) return false
    if (ts < cutoff) return false
    if (sessionId && e.sessionId !== sessionId) return false
    return true
  })

  // Take the last N (most recent) entries. The file is appended
  // to chronologically so the trailing slice is the freshest.
  if (filtered.length > limit) {
    filtered = filtered.slice(filtered.length - limit)
  }

  return {
    type: 'behavior_trace_result',
    cwd,
    sessionId: sessionId ?? '',
    entries: filtered,
    count: filtered.length,
  }
}

// ─── PR-12: /v1/context/working-set endpoint helpers ──────────────────────

export type WorkingSetSession = {
  sessionId: string
  workspaceId: string
  version: number
  updatedAt: string
  entries: Array<{
    key: string
    value: string
    updatedAt: string
    confidence: number
  }>
}

export async function runWorkingSetList({ cwd }: { cwd: string }): Promise<{
  type: 'working_set_list'
  cwd: string
  sessions: WorkingSetSession[]
}> {
  const tracker = new PersistedWorkingSetTracker_2(cwd)
  await tracker.load()
  const sessions: WorkingSetSession[] = []
  for (const [sessionId, ws] of tracker.entries()) {
    sessions.push({
      sessionId,
      workspaceId: ws.workspaceId,
      version: ws.version,
      updatedAt: ws.updatedAt,
      entries: ws.entries,
    })
  }
  return { type: 'working_set_list', cwd, sessions }
}

export async function runWorkingSetGet({ cwd, sessionId }: { cwd: string; sessionId: string }): Promise<{
  type: 'working_set_session'
  cwd: string
  sessionId: string
  workspaceId: string
  version: number
  updatedAt: string
  entries: Array<{
    key: string
    value: string
    updatedAt: string
    confidence: number
  }>
}> {
  const tracker = new PersistedWorkingSetTracker_2(cwd)
  await tracker.load()
  const ws = tracker.get(sessionId)
  if (!ws) {
    throw new Error(`session not found: ${sessionId}`)
  }
  return {
    type: 'working_set_session',
    cwd,
    sessionId,
    workspaceId: ws.workspaceId,
    version: ws.version,
    updatedAt: ws.updatedAt,
    entries: ws.entries,
  }
}

// ─── PR-A1: /v1/context/working-set/:sessionId PUT endpoint helper ───
//
// Per design §7.3 row "GET / PUT" + user explicit approval (2026-06-17).
// Write op: replaces a session's working set entries and auto-persists
// + emits working_set_updated event (PR-26). Caller submits the FULL
// desired entries set (write-through, not a delta).
export async function runWorkingSetPut({
  cwd,
  sessionId,
  workspaceId,
  entries,
}: {
  cwd: string
  sessionId: string
  workspaceId?: string
  entries: Array<{ key: string; value: string; updatedAt: string; confidence: number }>
}): Promise<{
  type: 'working_set_session'
  cwd: string
  sessionId: string
  workspaceId: string
  version: number
  updatedAt: string
  entries: Array<{ key: string; value: string; updatedAt: string; confidence: number }>
}> {
  const tracker = new PersistedWorkingSetTracker_2(cwd)
  await tracker.load()
  // Preserve the previous workspaceId if the caller omits it; this
  // matches the doc's intent that the endpoint is a write-through,
  // not a full replacement that would zero out workspace linkage.
  const prev = tracker.get(sessionId)
  const resolvedWorkspaceId = workspaceId ?? prev?.workspaceId ?? ''
  const updated = tracker.update(sessionId, {
    workspaceId: resolvedWorkspaceId,
    entries,
  })
  await tracker.flush()
  return {
    type: 'working_set_session',
    cwd,
    sessionId,
    workspaceId: updated.workspaceId,
    version: updated.version,
    updatedAt: updated.updatedAt,
    entries: updated.entries,
  }
}

// ─── PR-20: /v1/context/working-set/workspace/:wsId endpoint helper ──────
//
// Per design §7.3 row 3. Pure read — returns the working set aggregated
// across all sessions that share the same workspaceId. Aggregates entries
// by key, attaching a contributors list so callers can see provenance.

export type WorkspaceEntryContributor = {
  sessionId: string
  value: string
  updatedAt: string
  confidence: number
}

export type WorkspaceAggregatedEntry = {
  key: string
  contributors: WorkspaceEntryContributor[]
}

export async function runWorkspaceWorkingSetGet({ cwd, workspaceId }: { cwd: string; workspaceId: string }): Promise<{
  type: 'workspace_working_set'
  cwd: string
  workspaceId: string
  sessions: WorkingSetSession[]
  aggregateEntries: WorkspaceAggregatedEntry[]
}> {
  const tracker = new PersistedWorkingSetTracker_2(cwd)
  await tracker.load()
  const sessions: WorkingSetSession[] = []
  for (const [sessionId, ws] of tracker.entries()) {
    if (ws.workspaceId === workspaceId) {
      sessions.push({
        sessionId,
        workspaceId: ws.workspaceId,
        version: ws.version,
        updatedAt: ws.updatedAt,
        entries: ws.entries,
      })
    }
  }

  // Aggregate entries by key, collecting contributors from each session
  const byKey = new Map<string, WorkspaceEntryContributor[]>()
  for (const session of sessions) {
    for (const entry of session.entries) {
      const list = byKey.get(entry.key) ?? []
      list.push({
        sessionId: session.sessionId,
        value: entry.value,
        updatedAt: entry.updatedAt,
        confidence: entry.confidence,
      })
      byKey.set(entry.key, list)
    }
  }
  const aggregateEntries: WorkspaceAggregatedEntry[] = []
  for (const [key, contributors] of byKey.entries()) {
    aggregateEntries.push({ key, contributors })
  }
  // Stable order: sort by key
  aggregateEntries.sort((a, b) => a.key.localeCompare(b.key))

  return {
    type: 'workspace_working_set',
    cwd,
    workspaceId,
    sessions,
    aggregateEntries,
  }
}

// Helper to avoid name collision with the ContextCommandOptions / other
// identifiers in this file. Re-exports the PR-4b class via a local alias.
import { PersistedWorkingSetTracker as PersistedWorkingSetTracker_2 } from './persistedWorkingSetTracker.js'
import { WorkingSetBroadcaster } from './workingSetBroadcaster.js'
import { setDefaultContextBroadcaster, defaultContextBroadcaster } from '../runtime/contextBroadcasterSingleton.js'
import type { WorkingSetEvent } from './workingSetTracker.js'

// ─── PR-18: /v1/context/assemble endpoint helpers ────────────────────────
//
// Mirrors PR-15's `buildAssemblePreview` (extracted from runAssemble as a pure
// function). REST handler just validates body and delegates here.
// Pure read — never mutates state.

export type ContextAssembleParams = {
  cwd: string
  sessionId?: string
  scope: 'minimal' | 'standard' | 'full' | 'task' | 'workspace'
  maxTokens: number
}

import { buildAssemblePreview, type AssembledContextPreview } from './contextAssemblePreview.js'

export async function runContextAssemble(params: ContextAssembleParams): Promise<{
  type: 'context_assemble_result'
  cwd: string
  preview: AssembledContextPreview
}> {
  const preview = await buildAssemblePreview(params)
  return {
    type: 'context_assemble_result',
    cwd: params.cwd,
    preview,
  }
}
