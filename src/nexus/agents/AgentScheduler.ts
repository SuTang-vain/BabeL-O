import type { NexusEvent } from '../../shared/events.js'
import { eventBase } from '../../shared/events.js'
import { createId, nowIso } from '../../shared/id.js'
import type { SessionSnapshot } from '../../shared/session.js'
import { DEFAULT_SESSION_CHANNEL_POLICY, type SessionChannel, type SessionMessage, type SessionMessageType } from '../../shared/sessionChannel.js'
import type { NexusStorage } from '../../storage/Storage.js'
import { createDefaultToolRegistry } from '../../tools/registry.js'
import type { AnyTool, ToolResult } from '../../tools/Tool.js'
import { LLMCodingRuntime } from '../../runtime/LLMCodingRuntime.js'
import { LocalCodingRuntime, allowlistedTools } from '../../runtime/LocalCodingRuntime.js'
import type { NexusRuntime } from '../../runtime/Runtime.js'
import type { RemoteToolRunner } from '../../runtime/remoteRunner.js'
import { ConfigManager } from '../../shared/config.js'
import { assertAgentProfile } from './AgentProfiles.js'
import {
  AgentJobRegistry,
  AgentJobRegistryError,
  isTerminalAgentJobStatus,
} from './AgentJobRegistry.js'
import { forkContextForAgent } from './ContextForker.js'
import type {
  AgentContextProvenance,
  AgentJob,
  AgentJobFilter,
  AgentJobGovernance,
  AgentResult,
  AgentScheduler,
  AgentSpawnRequest,
  AgentWaitOptions,
} from './types.js'

export type ExploreAgentSchedulerOptions = {
  storage: NexusStorage
  cwd?: string
  registry?: AgentJobRegistry
  runtimeFactory?: (options: ExploreAgentRuntimeFactoryOptions) => NexusRuntime
  now?: () => string
  executionEnvironment?: 'local' | 'remote'
  remoteRunner?: RemoteToolRunner
  maxConcurrentAgents?: number
  maxDepth?: number
}

export type ExploreAgentRuntimeFactoryOptions = {
  agentType: AgentJob['agentType']
  allowedTools: string[]
  storage: NexusStorage
  executionEnvironment?: 'local' | 'remote'
  remoteRunner?: RemoteToolRunner
}

type RunningAgent = {
  controller: AbortController
  promise: Promise<void>
}

type AgentJobEventType =
  | 'agent_job_queued'
  | 'agent_job_started'
  | 'agent_job_completed'
  | 'agent_job_failed'
  | 'agent_job_cancelled'

export class ExploreAgentScheduler implements AgentScheduler {
  private readonly storage: NexusStorage
  private readonly cwd?: string
  private readonly registry: AgentJobRegistry
  private readonly runtimeFactory: (options: ExploreAgentRuntimeFactoryOptions) => NexusRuntime
  private readonly now: () => string
  private readonly executionEnvironment?: 'local' | 'remote'
  private readonly remoteRunner?: RemoteToolRunner
  private readonly maxConcurrentAgents: number
  private readonly maxDepth: number
  private readonly running = new Map<string, RunningAgent>()
  private loadedPersistedJobs = false

  constructor(options: ExploreAgentSchedulerOptions) {
    this.storage = options.storage
    this.cwd = options.cwd
    this.registry = options.registry ?? new AgentJobRegistry({ now: options.now })
    this.runtimeFactory = options.runtimeFactory ?? createExploreRuntime
    this.now = options.now ?? nowIso
    this.executionEnvironment = options.executionEnvironment
    this.remoteRunner = options.remoteRunner
    this.maxConcurrentAgents = options.maxConcurrentAgents ?? 4
    this.maxDepth = options.maxDepth ?? 2
  }

  async spawnAgent(request: AgentSpawnRequest): Promise<AgentJob> {
    await this.loadPersistedJobs()
    const profile = assertAgentProfile(request.agentType ?? 'explore')
    assertSchedulableProfile(profile.id)
    const allowedTools = request.allowedTools ?? profile.defaultTools
    assertProfileAllowedTools(profile.id, allowedTools)
    const parentSession = await this.requireParentSession(request.parentSessionId)
    const activeAgents = this.running.size
    if (activeAgents >= this.maxConcurrentAgents) {
      throw new AgentJobRegistryError(
        `Agent scheduler capacity exceeded: ${activeAgents}/${this.maxConcurrentAgents} agents are running.`,
        'AGENT_SCHEDULER_CAPACITY_EXCEEDED',
        429,
      )
    }
    const depth = agentDepth(parentSession)
    if (depth > this.maxDepth) {
      throw new AgentJobRegistryError(
        `Agent scheduler max depth exceeded: ${depth}/${this.maxDepth}.`,
        'AGENT_SCHEDULER_MAX_DEPTH_EXCEEDED',
        400,
      )
    }
    const maxRuntimeMs = request.maxRuntimeMs ?? profile.maxRuntimeMs
    const governance: AgentJobGovernance = {
      maxConcurrentAgents: this.maxConcurrentAgents,
      activeAgents,
      maxDepth: this.maxDepth,
      depth,
      maxRuntimeMs,
      timeoutAt: addMillisecondsIso(this.now(), maxRuntimeMs),
    }
    const childSessionId = createId('session')
    const channel = createAgentParentChildChannel({
      parentSessionId: request.parentSessionId,
      childSessionId,
      agentType: profile.id,
      createdAt: this.now(),
    })
    const job = this.registry.createJob({
      parentSessionId: request.parentSessionId,
      childSessionId,
      agentType: profile.id,
      prompt: request.prompt,
      contextForkMode: request.contextForkMode ?? profile.defaultContextForkMode,
      isolation: request.isolation ?? profile.defaultIsolation,
      transcriptPath: `nexus://sessions/${childSessionId}/events`,
      governance,
      metadata: {
        ...(request.metadata ?? {}),
        allowedTools,
        governance,
        channelId: channel.channelId,
      },
    })
    const fork = forkContextForAgent({ parentSession, job })
    const childSession: SessionSnapshot = {
      sessionId: childSessionId,
      cwd: parentSession.cwd || this.cwd || process.cwd(),
      prompt: fork.prompt,
      phase: 'created',
      createdAt: this.now(),
      updatedAt: this.now(),
      events: [],
      parentSessionId: parentSession.sessionId,
      assignedAgentId: profile.id,
      allowedPaths: fork.allowedPaths,
      metadata: {
        agentJobId: job.jobId,
        agentType: profile.id,
        contextForkMode: fork.mode,
        isolation: job.isolation,
        agentDepth: depth,
        allowedTools,
        governance,
        channelId: channel.channelId,
        contextFork: {
          inheritedItems: fork.inheritedItems,
          omittedItems: fork.omittedItems,
          diagnostics: fork.diagnostics,
        },
      },
    }
    channel.metadata = { ...(channel.metadata ?? {}), jobId: job.jobId }
    await this.storage.saveSession(childSession)
    await this.storage.saveAgentJob(job)
    await this.storage.saveSessionChannel(channel)
    await this.storage.saveSessionMessage(createAgentChannelMessage({
      channelId: channel.channelId,
      fromSessionId: request.parentSessionId,
      toSessionId: childSessionId,
      type: agentRequestMessageType(profile.id),
      content: `Agent task request (${profile.id}): ${request.prompt}`,
      createdAt: this.now(),
      job,
    }))
    await this.appendParentAgentEvent('agent_job_queued', job)

    const controller = new AbortController()
    const promise = this.runAgentJob(
      job.jobId,
      fork.prompt,
      childSession,
      allowedTools,
      controller,
      maxRuntimeMs,
      fork.diagnostics.provenance,
    ).finally(() => {
      this.running.delete(job.jobId)
    })
    this.running.set(job.jobId, { controller, promise })

    return job
  }

  async waitForAgent(jobId: string, options?: AgentWaitOptions): Promise<AgentJob> {
    await this.loadPersistedJobs()
    const existing = this.registry.getJob(jobId)
    const running = this.running.get(jobId)
    if (!running && !isTerminalAgentJobStatus(existing.status)) return existing
    const job = await this.registry.waitForJob(jobId, options)
    await running?.promise
    return this.registry.getJob(jobId)
  }

  async listAgents(filter?: AgentJobFilter): Promise<AgentJob[]> {
    await this.loadPersistedJobs()
    return this.registry.listJobs(filter)
  }

  async cancelAgent(jobId: string, reason?: string): Promise<AgentJob> {
    await this.loadPersistedJobs()
    const existing = this.registry.getJob(jobId)
    if (isTerminalAgentJobStatus(existing.status)) return existing

    const running = this.running.get(jobId)
    running?.controller.abort()
    const job = this.registry.cancelJob(jobId, reason)
    await this.storage.saveAgentJob(job)
    await this.finalizeChildSession(job, false, reason ?? 'Agent job cancelled.')
    await this.appendParentAgentEvent('agent_job_cancelled', job)
    return job
  }

  private async loadPersistedJobs(): Promise<void> {
    if (this.loadedPersistedJobs) return
    this.loadedPersistedJobs = true
    this.registry.hydrateJobs(await this.storage.listAgentJobs())
  }

  private async runAgentJob(
    jobId: string,
    prompt: string,
    childSession: SessionSnapshot,
    allowedTools: string[],
    controller: AbortController,
    maxRuntimeMs: number | undefined,
    contextProvenance: AgentContextProvenance,
  ): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    if (maxRuntimeMs !== undefined) {
      timeout = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, maxRuntimeMs)
      timeout.unref?.()
    }

    let job = this.registry.markRunning(jobId)
    await this.storage.saveAgentJob(job)
    await this.appendParentAgentEvent('agent_job_started', job)
    childSession.phase = 'executing'
    childSession.updatedAt = this.now()
    await this.storage.saveSession(childSession)

    const runtime = this.runtimeFactory({
      agentType: job.agentType,
      allowedTools,
      storage: this.storage,
      executionEnvironment: this.executionEnvironment,
      remoteRunner: this.remoteRunner,
    })
    const events: NexusEvent[] = []
    try {
      for await (const event of runtime.executeStream({
        sessionId: childSession.sessionId,
        prompt,
        cwd: childSession.cwd,
        role: job.agentType,
        signal: controller.signal,
        timeoutSignal: controller.signal,
        skipPermissionCheck: true,
        replaySessionHistory: false,
        storage: this.storage,
        allowedPaths: childSession.allowedPaths,
        executionEnvironment: this.executionEnvironment,
        remoteRunner: this.remoteRunner,
      })) {
        events.push(event)
        await this.storage.appendEvent(childSession.sessionId, event)
      }

      const errorEvent = events.findLast(event => event.type === 'error')
      if (controller.signal.aborted) {
        if (!isTerminalAgentJobStatus(this.registry.getJob(jobId).status)) {
          if (timedOut) {
            job = this.registry.failJob(jobId, {
              code: 'AGENT_JOB_TIMEOUT',
              message: `Agent job timed out after ${maxRuntimeMs}ms.`,
            })
            await this.storage.saveAgentJob(job)
            await this.finalizeChildSession(job, false, job.error?.message ?? 'Agent job timed out.')
            await this.appendParentAgentEvent('agent_job_failed', job)
          } else {
            job = this.registry.cancelJob(jobId, 'Agent job cancelled.')
            await this.storage.saveAgentJob(job)
            await this.finalizeChildSession(job, false, 'Agent job cancelled.')
            await this.appendParentAgentEvent('agent_job_cancelled', job)
          }
        }
        return
      }
      if (errorEvent?.type === 'error') {
        job = this.registry.failJob(jobId, {
          code: errorEvent.code,
          message: errorEvent.message,
          details: errorEvent.details,
        })
        await this.storage.saveAgentJob(job)
        await this.finalizeChildSession(job, false, errorEvent.message)
        await this.appendParentAgentEvent('agent_job_failed', job)
        return
      }

      const result = {
        ...normalizeAgentResult(events, allowedTools),
        contextProvenance,
      }
      job = this.registry.completeJob(jobId, result)
      await this.storage.saveAgentJob(job)
      await this.finalizeChildSession(job, true, result.summary)
      await this.appendParentAgentEvent('agent_job_completed', job)
    } catch (error) {
      if (controller.signal.aborted) {
        if (!isTerminalAgentJobStatus(this.registry.getJob(jobId).status)) {
          if (timedOut) {
            job = this.registry.failJob(jobId, {
              code: 'AGENT_JOB_TIMEOUT',
              message: `Agent job timed out after ${maxRuntimeMs}ms.`,
            })
            await this.storage.saveAgentJob(job)
            await this.finalizeChildSession(job, false, job.error?.message ?? 'Agent job timed out.')
            await this.appendParentAgentEvent('agent_job_failed', job)
          } else {
            job = this.registry.cancelJob(jobId, 'Agent job cancelled.')
            await this.storage.saveAgentJob(job)
            await this.finalizeChildSession(job, false, 'Agent job cancelled.')
            await this.appendParentAgentEvent('agent_job_cancelled', job)
          }
        }
        return
      }
      job = this.registry.failJob(jobId, {
        code: 'AGENT_RUNTIME_ERROR',
        message: error instanceof Error ? error.message : String(error),
      })
      await this.storage.saveAgentJob(job)
      await this.finalizeChildSession(job, false, job.error?.message ?? 'Agent job failed.')
      await this.appendParentAgentEvent('agent_job_failed', job)
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  private async finalizeChildSession(job: AgentJob, success: boolean, message: string): Promise<void> {
    const child = await this.storage.getSession(job.childSessionId)
    if (!child) return
    child.phase = success ? 'completed' : job.status === 'cancelled' ? 'cancelled' : 'failed'
    child.updatedAt = this.now()
    child.result = success ? message : undefined
    child.error = success ? undefined : message
    child.metadata = {
      ...(child.metadata ?? {}),
      agentJobStatus: job.status,
    }
    await this.storage.saveSession(child)
  }

  private async requireParentSession(parentSessionId: string): Promise<SessionSnapshot> {
    const session = await this.storage.getSession(parentSessionId)
    if (!session) {
      throw new AgentJobRegistryError(
        `Parent session not found: ${parentSessionId}`,
        'AGENT_PARENT_SESSION_NOT_FOUND',
        404,
      )
    }
    return session
  }

  private async appendParentAgentEvent(eventType: AgentJobEventType, job: AgentJob): Promise<void> {
    await this.storage.appendEvent(job.parentSessionId, {
      type: 'agent_job_event',
      ...eventBase(job.parentSessionId),
      eventId: createId('event'),
      eventType,
      jobId: job.jobId,
      childSessionId: job.childSessionId,
      agentType: job.agentType,
      contextForkMode: job.contextForkMode,
      status: job.status,
      governance: job.governance,
      result: job.result,
      error: job.error,
    })
    if (eventType === 'agent_job_completed' || eventType === 'agent_job_failed' || eventType === 'agent_job_cancelled') {
      await this.appendAgentChannelTerminalMessage(job)
    }
  }

  private async appendAgentChannelTerminalMessage(job: AgentJob): Promise<void> {
    const channelId = typeof job.metadata?.channelId === 'string' ? job.metadata.channelId : undefined
    if (!channelId) return
    if (!await this.storage.getSessionChannel(channelId)) return
    await this.storage.saveSessionMessage(createAgentChannelMessage({
      channelId,
      fromSessionId: job.childSessionId,
      toSessionId: job.parentSessionId,
      type: job.status === 'completed' ? 'handoff' : 'blocked',
      content: agentTerminalMessageContent(job),
      createdAt: this.now(),
      job,
    }))
  }
}

export function createExploreRuntime(options: ExploreAgentRuntimeFactoryOptions): NexusRuntime {
  const tools = createDefaultToolRegistry({ storage: options.storage ?? null })
  if (options.agentType === 'review' || options.agentType === 'test') {
    tools.set('Bash', createRestrictedAgentBashTool(options.agentType, tools.get('Bash')))
  }
  const policy = allowlistedTools(options.allowedTools)
  const settings = ConfigManager.getInstance().resolveSettings()
  if (settings.providerId === 'local') {
    return new LocalCodingRuntime(tools, policy, options.storage, ConfigManager.getInstance().load().hooks)
  }
  return new LLMCodingRuntime(tools, policy, options.storage, ConfigManager.getInstance())
}

export function normalizeAgentResult(events: NexusEvent[], allowedTools: string[]): AgentResult {
  const resultEvent = events.findLast(event => event.type === 'result')
  const assistantText = events
    .filter((event): event is Extract<NexusEvent, { type: 'assistant_delta' }> => event.type === 'assistant_delta')
    .map(event => event.text)
    .join('')
    .trim()
  const toolEvents = events.filter((event): event is Extract<NexusEvent, { type: 'tool_completed' }> => event.type === 'tool_completed')
  const deniedTools = events.filter((event): event is Extract<NexusEvent, { type: 'tool_denied' }> => event.type === 'tool_denied')
  const toolInputs = new Map(
    events
      .filter((event): event is Extract<NexusEvent, { type: 'tool_started' }> => event.type === 'tool_started')
      .map(event => [event.toolUseId, event.input]),
  )
  const commandsRun = toolEvents
    .filter(event => event.name === 'Bash')
    .map(event => commandFromToolInput(toolInputs.get(event.toolUseId)))
    .filter((command): command is string => command !== undefined)
  const testsRun = commandsRun.filter(command => command.includes('tsx --test'))

  return {
    summary: resultEvent?.type === 'result'
      ? resultEvent.message
      : assistantText || 'Agent completed.',
    findings: [
      ...toolEvents.map(event => ({
        severity: event.success ? 'info' as const : 'warning' as const,
        message: `${event.name} ${event.success ? 'completed' : 'failed'}.`,
        evidence: stringifyEvidence(event.output),
      })),
      ...deniedTools.map(event => ({
        severity: 'error' as const,
        message: event.message,
      })),
    ],
    changedFiles: [],
    testsRun,
    commandsRun,
    nextSteps: [],
    confidence: deniedTools.length > 0 ? 'low' : toolEvents.length > 0 || assistantText ? 'medium' : 'low',
  }
}

function commandFromToolInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const command = (input as { command?: unknown }).command
  return typeof command === 'string' ? command : undefined
}

function assertSchedulableProfile(profileId: AgentJob['agentType']): void {
  if (profileId === 'explore' || profileId === 'review' || profileId === 'test') return
  throw new AgentJobRegistryError(
    `Agent profile is not supported by ExploreAgentScheduler: ${profileId}`,
    'AGENT_PROFILE_UNSUPPORTED',
    400,
  )
}

function agentDepth(parentSession: SessionSnapshot): number {
  const depth = parentSession.metadata?.agentDepth
  return typeof depth === 'number' && Number.isInteger(depth) && depth >= 0 ? depth + 1 : 1
}

function addMillisecondsIso(timestamp: string, durationMs: number): string | undefined {
  const time = new Date(timestamp).getTime()
  if (!Number.isFinite(time)) return undefined
  return new Date(time + durationMs).toISOString()
}

function createAgentParentChildChannel(input: {
  parentSessionId: string
  childSessionId: string
  agentType: AgentJob['agentType']
  createdAt: string
}): SessionChannel {
  return {
    channelId: createId('channel'),
    kind: 'parent_child',
    participantSessionIds: [input.parentSessionId, input.childSessionId],
    createdBySessionId: input.parentSessionId,
    createdAt: input.createdAt,
    status: 'open',
    policy: {
      ...DEFAULT_SESSION_CHANNEL_POLICY,
      allowedMessageTypes: ['request_review', 'request_validation', 'question', 'answer', 'finding', 'handoff', 'blocked'],
      allowMemoryWriteRequests: false,
      requireUserApprovalForExternalProject: true,
      contextInjectionMode: 'recent_messages',
    },
    metadata: {
      agentType: input.agentType,
      parentSessionId: input.parentSessionId,
      childSessionId: input.childSessionId,
    },
  }
}

function createAgentChannelMessage(input: {
  channelId: string
  fromSessionId: string
  toSessionId: string
  type: SessionMessageType
  content: string
  createdAt: string
  job: AgentJob
}): SessionMessage {
  return {
    messageId: createId('msg'),
    channelId: input.channelId,
    fromSessionId: input.fromSessionId,
    toSessionId: input.toSessionId,
    broadcast: false,
    type: input.type,
    content: input.content,
    priority: input.type === 'blocked' ? 'high' : 'normal',
    createdAt: input.createdAt,
    deliveredAt: input.createdAt,
    status: 'delivered',
    metadata: {
      agentJobId: input.job.jobId,
      agentType: input.job.agentType,
      childSessionId: input.job.childSessionId,
      parentSessionId: input.job.parentSessionId,
      agentJobStatus: input.job.status,
      contextProvenance: input.job.result?.contextProvenance,
    },
  }
}

function agentRequestMessageType(agentType: AgentJob['agentType']): SessionMessageType {
  if (agentType === 'test') return 'request_validation'
  return 'request_review'
}

function agentTerminalMessageContent(job: AgentJob): string {
  if (job.status === 'completed') {
    return `Agent ${job.agentType} completed: ${job.result?.summary ?? 'Agent completed.'}`
  }
  return `Agent ${job.agentType} ${job.status}: ${job.error?.message ?? 'Agent did not complete.'}`
}

function assertProfileAllowedTools(profileId: AgentJob['agentType'], allowedTools: string[]): void {
  const allowed = profileId === 'explore'
    ? new Set(['ListDir', 'Glob', 'Grep', 'Read'])
    : new Set(['ListDir', 'Glob', 'Grep', 'Read', 'Bash'])
  const disallowed = allowedTools.filter(tool => !allowed.has(tool))
  if (disallowed.length > 0) {
    throw new AgentJobRegistryError(
      `${profileId} agent cannot use tools: ${disallowed.join(', ')}`,
      'AGENT_TOOLS_NOT_ALLOWED',
      400,
    )
  }
}

function createRestrictedAgentBashTool(profileId: 'review' | 'test', bashTool: AnyTool | undefined): AnyTool {
  if (!bashTool) {
    throw new AgentJobRegistryError('Bash tool is not registered.', 'AGENT_BASH_UNAVAILABLE', 500)
  }
  return {
    ...bashTool,
    description: `${profileId} agent restricted test/check command runner.`,
    prompt: () => [
      'Run only read-only validation commands for review/test work.',
      'Allowed commands are npm run typecheck, npm run format:check, npm run deps:audit, and npx tsx --test with explicit test files or --test-name-pattern.',
      'Do not run write, install, network, git mutation, destructive, server, or broad formatting commands.',
    ].join('\n'),
    async execute(input, context): Promise<ToolResult> {
      const parsed = bashTool.inputSchema.parse(input) as { command: string }
      if (!isAllowedAgentBashCommand(parsed.command)) {
        return {
          success: false,
          output: {
            code: 'AGENT_BASH_COMMAND_NOT_ALLOWED',
            message: `${profileId} agents may only run focused read-only validation commands.`,
            command: parsed.command,
          },
        }
      }
      return bashTool.execute(input, context)
    },
  }
}

function isAllowedAgentBashCommand(command: string): boolean {
  let normalized = command.trim().replace(/\s+/g, ' ')
  if (/[;&|`$<>]/.test(normalized)) return false
  if (normalized.startsWith('BABEL_O_CONFIG_FILE=/tmp/')) {
    const [, rest] = normalized.match(/^BABEL_O_CONFIG_FILE=\/tmp\/[A-Za-z0-9._-]+ (.+)$/) ?? []
    if (!rest) return false
    normalized = rest
  }
  if (normalized === 'npm run typecheck') return true
  if (normalized === 'npm run format:check') return true
  if (normalized === 'npm run deps:audit') return true
  if (!normalized.startsWith('npx tsx --test ')) return false
  if (normalized.includes(' --watch') || normalized.includes(' --inspect')) return false
  return normalized.includes('.test.ts') || normalized.includes('--test-name-pattern')
}

function stringifyEvidence(output: unknown): string | undefined {
  if (output === undefined || output === null) return undefined
  if (typeof output === 'string') return output.slice(0, 1_000)
  try {
    return JSON.stringify(output).slice(0, 1_000)
  } catch {
    return undefined
  }
}
