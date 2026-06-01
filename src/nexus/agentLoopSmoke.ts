import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createId } from '../shared/id.js'
import { ConfigManager, type ProviderDiagnostics } from '../shared/config.js'
import { createDefaultNexusRuntime } from './createRuntime.js'
import { AGENT_ROLE_DEFINITIONS, type AgentRole } from './agentRoles.js'
import { createRuntimeAgentStepRunner, type RuntimeAgentStepUsageSummary } from './runtimeAgentStep.js'
import { runAgentLoop } from './agentLoop.js'
import { clearTaskQueue } from './taskQueue.js'
import { getTaskSession } from './taskSession.js'
import { setNexusStorage } from './storageBridge.js'
import { buildProviderSmokeChecks, type ProviderSmokeChecks, type ProviderSmokeFallbackPolicy, type ProviderSmokeRequirements } from '../runtime/providerSmoke.js'
import { buildProviderSmokeFallbackPolicy } from '../runtime/providerSmoke.js'
import { classifyProviderRecovery, type ProviderFallbackPolicy } from '../runtime/providerRecovery.js'

export type AgentLoopLiveSmokeOptions = {
  model?: string
  timeoutMs?: number
}

export type AgentLoopLiveSmokeRoleDiagnostic = {
  role: AgentRole
  model: string
  allowedTools: string[]
  structuredOutputRequired: boolean
  repairAttempts: number
  eventCount: number
  toolCallCount: number
  toolFailedCount: number
  toolDeniedCount: number
  resultSuccess?: boolean
  resultMessagePreview?: string
  assistantTextPreview?: string
  thinkingTextPreview?: string
  errorCode?: string
  errorMessagePreview?: string
  lastToolName?: string
  lastToolSuccess?: boolean
  lastToolOutputPreview?: string
  structuredOutputFailureType?: string
  structuredOutputPreview?: string
}

export type AgentLoopLiveSmokeResult = {
  type: 'agent_loop_smoke'
  mode: 'live_manual'
  ready: boolean
  live: boolean
  success?: boolean
  provider: ProviderDiagnostics
  requirements: ProviderSmokeRequirements
  checks: ProviderSmokeChecks
  sessionId?: string
  sessionPhase?: string
  workspaceCreated?: boolean
  workspaceCleaned?: boolean
  toolCallCount?: number
  plannerCompleted?: boolean
  taskCompleted?: boolean
  criticCompleted?: boolean
  usage?: RuntimeAgentStepUsageSummary[]
  roleDiagnostics?: AgentLoopLiveSmokeRoleDiagnostic[]
  error?: {
    message: string
    category?: 'agent_loop_timeout'
    recovery: ReturnType<typeof classifyProviderRecovery>
  }
  fallbackPolicy: ProviderSmokeFallbackPolicy | ProviderFallbackPolicy
}

const SMOKE_FIXTURE = 'BABEL_O_AGENT_LOOP_SMOKE_OK\n'
const SMOKE_PROMPT = 'Run the fixed BabeL-O AgentLoop live smoke. Read only fixture.txt and summarize the exact marker.'

export async function runAgentLoopLiveSmoke(options: AgentLoopLiveSmokeOptions = {}): Promise<AgentLoopLiveSmokeResult> {
  const configManager = ConfigManager.getInstance()
  const provider = configManager.getProviderDiagnostics({ model: options.model })
  const requirements: ProviderSmokeRequirements = {
    tools: true,
    streaming: true,
    structuredOutput: true,
  }
  const checks = buildProviderSmokeChecks(provider, requirements, options.model)
  const ready = Object.values(checks).every(Boolean)
  if (!ready) {
    return {
      type: 'agent_loop_smoke',
      mode: 'live_manual',
      ready: false,
      live: false,
      provider,
      requirements,
      checks,
      fallbackPolicy: buildProviderSmokeFallbackPolicy(false, 'live'),
    }
  }

  const workspace = await mkdtemp(join(tmpdir(), 'babel-o-agent-loop-live-smoke-'))
  const sessionId = createId('session')
  const usage: RuntimeAgentStepUsageSummary[] = []
  let workspaceCleaned = false
  let result: AgentLoopLiveSmokeResult | undefined
  let storage: Awaited<ReturnType<typeof createDefaultNexusRuntime>>['storage'] | undefined
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  let didTimeout = false
  let loopPromise: Promise<Awaited<ReturnType<typeof runAgentLoop>>> | undefined
  const abortController = new AbortController()

  try {
    await writeFile(join(workspace, 'fixture.txt'), SMOKE_FIXTURE, 'utf8')
    const runtimeBundle = await createDefaultNexusRuntime({
      cwd: workspace,
      allowedTools: ['Read'],
    })
    storage = runtimeBundle.storage
    setNexusStorage(runtimeBundle.storage)

    const timeoutMs = options.timeoutMs ?? 120_000
    const stepRunner = createRuntimeAgentStepRunner({
      cwd: workspace,
      model: options.model,
      allowedToolsOverride: ['Read'],
      signal: abortController.signal,
      runtimeFactory: async () => runtimeBundle.runtime,
      onUsageSummary: summary => usage.push(summary),
    })

    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        didTimeout = true
        abortController.abort()
        reject(new Error(`AgentLoop live smoke timed out after ${timeoutMs}ms`))
      }, timeoutMs)
    })
    loopPromise = runAgentLoop({
      sessionId,
      cwd: workspace,
      prompt: SMOKE_PROMPT,
      stepRunner,
      role: 'optimizer',
      autoApprove: false,
      maxRetriesPerTask: 1,
      reviewPlan: () => ({
        approved: true,
        summary: 'Fixed AgentLoop live smoke plan',
        tasks: [
          {
            title: 'Read fixed AgentLoop live smoke fixture',
            description: 'Use only the Read tool on fixture.txt in the current workspace, then return a structured result mentioning the marker found in the file.',
          },
        ],
      }),
    })
    const finalSession = await Promise.race([loopPromise, timeout])
    const events = finalSession.events ?? []
    result = {
      type: 'agent_loop_smoke',
      mode: 'live_manual',
      ready: true,
      live: true,
      success: finalSession.phase === 'completed',
      provider,
      requirements,
      checks,
      sessionId,
      sessionPhase: finalSession.phase,
      workspaceCreated: true,
      toolCallCount: events.filter(event => event.type === 'tool_started').length,
      plannerCompleted: events.some(event => event.type === 'task_session_event' && event.eventType === 'planner_completed'),
      taskCompleted: events.some(event => event.type === 'task_session_event' && event.eventType === 'task_completed'),
      criticCompleted: events.some(event => event.type === 'task_session_event' && event.eventType === 'critic_completed'),
      usage,
      roleDiagnostics: buildRoleDiagnostics(usage, provider.modelId, ['Read']),
      fallbackPolicy: buildProviderSmokeFallbackPolicy(true, 'live'),
    }
  } catch (error) {
    if (didTimeout && loopPromise) {
      try {
        await loopPromise
      } catch {
      }
    }
    const sessionAfterError = getSafeTaskSession(sessionId)
    const events = sessionAfterError?.events ?? []
    const recovery = classifyProviderRecovery(error)
    result = {
      type: 'agent_loop_smoke',
      mode: 'live_manual',
      ready: true,
      live: false,
      success: false,
      provider,
      requirements,
      checks,
      sessionId,
      sessionPhase: sessionAfterError?.phase,
      workspaceCreated: true,
      toolCallCount: events.filter(event => event.type === 'tool_started').length,
      plannerCompleted: events.some(event => event.type === 'task_session_event' && event.eventType === 'planner_completed'),
      taskCompleted: events.some(event => event.type === 'task_session_event' && event.eventType === 'task_completed'),
      criticCompleted: events.some(event => event.type === 'task_session_event' && event.eventType === 'critic_completed'),
      usage,
      roleDiagnostics: buildRoleDiagnostics(usage, provider.modelId, ['Read']),
      error: {
        message: error instanceof Error ? error.message : String(error),
        category: didTimeout ? 'agent_loop_timeout' : undefined,
        recovery,
      },
      fallbackPolicy: didTimeout
        ? buildProviderSmokeFallbackPolicy(false, 'live')
        : recovery?.fallbackPolicy ?? buildProviderSmokeFallbackPolicy(false, 'live'),
    }
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
    await storage?.close?.()
    try {
      await rm(workspace, { recursive: true, force: true })
      workspaceCleaned = true
    } catch {
      workspaceCleaned = false
    }
    clearTaskQueue(sessionId)
  }

  return {
    ...result!,
    workspaceCleaned,
  }
}

function getSafeTaskSession(sessionId: string) {
  try {
    return getTaskSession(sessionId)
  } catch {
    return undefined
  }
}

function buildRoleDiagnostics(
  usage: RuntimeAgentStepUsageSummary[],
  model: string | undefined,
  allowedToolsOverride: string[],
): AgentLoopLiveSmokeRoleDiagnostic[] {
  return usage.map(summary => {
    const role = summary.role as AgentRole
    const definition = AGENT_ROLE_DEFINITIONS[role]
    const allowedTools = definition
      ? intersectAllowedTools(definition.toolPolicy.allowedTools, allowedToolsOverride)
      : []
    return {
      role,
      model: model ?? 'unknown',
      allowedTools,
      structuredOutputRequired: Boolean(definition),
      repairAttempts: summary.repairAttempts ?? 0,
      eventCount: summary.eventCount,
      toolCallCount: summary.toolCallCount,
      toolFailedCount: summary.toolFailedCount ?? 0,
      toolDeniedCount: summary.toolDeniedCount ?? 0,
      resultSuccess: summary.resultSuccess,
      resultMessagePreview: summarizeForSmokeDiagnostics(summary.resultMessage),
      assistantTextPreview: summarizeForSmokeDiagnostics(summary.assistantTextPreview),
      thinkingTextPreview: summarizeForSmokeDiagnostics(summary.thinkingTextPreview),
      errorCode: summary.errorCode,
      errorMessagePreview: summarizeForSmokeDiagnostics(summary.errorMessage),
      lastToolName: summary.lastToolName,
      lastToolSuccess: summary.lastToolSuccess,
      lastToolOutputPreview: summarizeForSmokeDiagnostics(summary.lastToolOutputPreview),
      structuredOutputFailureType: summary.structuredOutput?.failureType,
      structuredOutputPreview: summarizeForSmokeDiagnostics(
        summary.structuredOutput?.assistantTextPreview ??
        summary.structuredOutput?.resultPayloadPreview ??
        summary.structuredOutput?.structuredOutputPreview,
      ),
    }
  })
}

function summarizeForSmokeDiagnostics(value: string | undefined): string | undefined {
  if (!value) return undefined
  return value.length > 120 ? `${value.slice(0, 117)}...` : value
}

function intersectAllowedTools(roleTools: string[], overrideTools: string[]): string[] {
  const allowed = new Set(overrideTools.map(tool => tool.trim().toLowerCase()))
  return roleTools.filter(tool => allowed.has(tool.trim().toLowerCase()))
}
