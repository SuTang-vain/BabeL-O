import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createId } from '../shared/id.js'
import { ConfigManager, type ProviderDiagnostics } from '../shared/config.js'
import { createDefaultNexusRuntime } from './createRuntime.js'
import { createRuntimeAgentStepRunner, type RuntimeAgentStepUsageSummary } from './runtimeAgentStep.js'
import { runAgentLoop } from './agentLoop.js'
import { clearTaskQueue } from './taskQueue.js'
import { setNexusStorage } from './storageBridge.js'
import { buildProviderSmokeChecks, type ProviderSmokeChecks, type ProviderSmokeFallbackPolicy, type ProviderSmokeRequirements } from '../runtime/providerSmoke.js'
import { buildProviderSmokeFallbackPolicy } from '../runtime/providerSmoke.js'
import { classifyProviderRecovery, type ProviderFallbackPolicy } from '../runtime/providerRecovery.js'

export type AgentLoopLiveSmokeOptions = {
  model?: string
  timeoutMs?: number
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
  error?: {
    message: string
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
      runtimeFactory: async () => runtimeBundle.runtime,
      onUsageSummary: summary => usage.push(summary),
    })

    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`AgentLoop live smoke timed out after ${timeoutMs}ms`)), timeoutMs)
    })
    const finalSession = await Promise.race([
      runAgentLoop({
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
      }),
      timeout,
    ])
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
      fallbackPolicy: buildProviderSmokeFallbackPolicy(true, 'live'),
    }
  } catch (error) {
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
      workspaceCreated: true,
      usage,
      error: {
        message: error instanceof Error ? error.message : String(error),
        recovery,
      },
      fallbackPolicy: recovery?.fallbackPolicy ?? buildProviderSmokeFallbackPolicy(false, 'live'),
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
