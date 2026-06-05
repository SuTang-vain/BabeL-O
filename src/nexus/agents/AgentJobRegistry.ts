import { assertAgentProfile } from './AgentProfiles.js'
import type {
  AgentIsolationMode,
  AgentJob,
  AgentJobError,
  AgentJobFilter,
  AgentJobStatus,
  AgentProfileId,
  AgentResult,
  ContextForkMode,
} from './types.js'

export class AgentJobRegistryError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'AgentJobRegistryError'
  }
}

export type CreateAgentJobOptions = {
  jobId?: string
  parentSessionId: string
  childSessionId: string
  parentTaskId?: string
  agentType?: AgentProfileId
  prompt: string
  contextForkMode?: ContextForkMode
  isolation?: AgentIsolationMode
  transcriptPath?: string
  metadata?: Record<string, unknown>
  createdAt?: string
}

export type AgentJobRegistryOptions = {
  idPrefix?: string
  now?: () => string
}

const TERMINAL_AGENT_JOB_STATUSES = new Set<AgentJobStatus>([
  'completed',
  'failed',
  'cancelled',
])

type AgentJobWaiter = {
  resolve: (job: AgentJob) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

export class AgentJobRegistry {
  private readonly jobs = new Map<string, AgentJob>()
  private readonly waiters = new Map<string, Set<AgentJobWaiter>>()
  private readonly idPrefix: string
  private readonly now: () => string
  private nextId = 0

  constructor(options: AgentJobRegistryOptions = {}) {
    this.idPrefix = options.idPrefix ?? 'agent-job'
    this.now = options.now ?? (() => new Date().toISOString())
  }

  createJob(options: CreateAgentJobOptions): AgentJob {
    const profile = assertAgentProfile(options.agentType ?? 'explore')
    const timestamp = options.createdAt ?? this.now()
    const jobId = options.jobId ?? this.nextJobId()

    if (this.jobs.has(jobId)) {
      throw new AgentJobRegistryError(
        `Agent job already exists: ${jobId}`,
        'AGENT_JOB_ALREADY_EXISTS',
        409,
      )
    }

    const job: AgentJob = {
      jobId,
      parentSessionId: options.parentSessionId,
      childSessionId: options.childSessionId,
      parentTaskId: options.parentTaskId,
      agentType: profile.id,
      status: 'queued',
      prompt: options.prompt,
      contextForkMode: options.contextForkMode ?? profile.defaultContextForkMode,
      isolation: options.isolation ?? profile.defaultIsolation,
      createdAt: timestamp,
      updatedAt: timestamp,
      transcriptPath: options.transcriptPath,
      metadata: cloneRecord(options.metadata),
    }

    this.jobs.set(jobId, job)
    return cloneAgentJob(job)
  }

  getJob(jobId: string): AgentJob {
    return cloneAgentJob(this.requireJob(jobId))
  }

  listJobs(filter: AgentJobFilter = {}): AgentJob[] {
    return Array.from(this.jobs.values())
      .filter(job => matchesFilter(job, filter))
      .map(cloneAgentJob)
  }

  markRunning(jobId: string): AgentJob {
    const timestamp = this.now()
    return this.updateJob(jobId, job => {
      assertTransition(job, 'running', ['queued', 'waiting_permission'])
      job.status = 'running'
      job.startedAt = job.startedAt ?? timestamp
    }, timestamp)
  }

  markWaitingPermission(jobId: string): AgentJob {
    return this.updateJob(jobId, job => {
      assertTransition(job, 'waiting_permission', ['queued', 'running'])
      job.status = 'waiting_permission'
    })
  }

  completeJob(jobId: string, result: AgentResult): AgentJob {
    const timestamp = this.now()
    return this.updateJob(jobId, job => {
      assertTransition(job, 'completed', ['running'])
      job.status = 'completed'
      job.result = cloneAgentResult(result)
      job.error = undefined
      job.completedAt = timestamp
    }, timestamp)
  }

  failJob(jobId: string, error: AgentJobError): AgentJob {
    const timestamp = this.now()
    return this.updateJob(jobId, job => {
      assertTransition(job, 'failed', ['queued', 'running', 'waiting_permission'])
      job.status = 'failed'
      job.error = cloneAgentJobError(error)
      job.completedAt = timestamp
    }, timestamp)
  }

  cancelJob(jobId: string, reason?: string): AgentJob {
    const timestamp = this.now()
    return this.updateJob(jobId, job => {
      assertTransition(job, 'cancelled', ['queued', 'running', 'waiting_permission'])
      job.status = 'cancelled'
      job.error = {
        code: 'AGENT_JOB_CANCELLED',
        message: reason ?? 'Agent job cancelled.',
      }
      job.completedAt = timestamp
    }, timestamp)
  }

  waitForJob(jobId: string, options: { timeoutMs?: number } = {}): Promise<AgentJob> {
    const job = this.requireJob(jobId)
    if (isTerminalStatus(job.status)) {
      return Promise.resolve(cloneAgentJob(job))
    }

    return new Promise((resolve, reject) => {
      const waiter: AgentJobWaiter = { resolve, reject }
      let waiters = this.waiters.get(jobId)
      if (!waiters) {
        waiters = new Set()
        this.waiters.set(jobId, waiters)
      }
      waiters.add(waiter)

      if (options.timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          waiters.delete(waiter)
          if (waiters.size === 0) {
            this.waiters.delete(jobId)
          }
          reject(
            new AgentJobRegistryError(
              `Timed out waiting for agent job: ${jobId}`,
              'AGENT_JOB_WAIT_TIMEOUT',
              408,
            ),
          )
        }, options.timeoutMs)
        waiter.timer.unref?.()
      }
    })
  }

  pendingWaiterCount(jobId?: string): number {
    if (jobId !== undefined) {
      return this.waiters.get(jobId)?.size ?? 0
    }
    let count = 0
    for (const waiters of this.waiters.values()) {
      count += waiters.size
    }
    return count
  }

  private nextJobId(): string {
    this.nextId += 1
    return `${this.idPrefix}-${this.nextId}`
  }

  private requireJob(jobId: string): AgentJob {
    const job = this.jobs.get(jobId)
    if (!job) {
      throw new AgentJobRegistryError(
        `Agent job not found: ${jobId}`,
        'AGENT_JOB_NOT_FOUND',
        404,
      )
    }
    return job
  }

  private updateJob(
    jobId: string,
    update: (job: AgentJob) => void,
    timestamp = this.now(),
  ): AgentJob {
    const job = this.requireJob(jobId)
    update(job)
    job.updatedAt = timestamp
    const updated = cloneAgentJob(job)
    if (isTerminalStatus(job.status)) {
      this.resolveWaiters(job)
    }
    return updated
  }

  private resolveWaiters(job: AgentJob): void {
    const waiters = this.waiters.get(job.jobId)
    if (!waiters) return
    this.waiters.delete(job.jobId)

    for (const waiter of waiters) {
      if (waiter.timer) {
        clearTimeout(waiter.timer)
      }
      waiter.resolve(cloneAgentJob(job))
    }
  }
}

export function isTerminalAgentJobStatus(status: AgentJobStatus): boolean {
  return isTerminalStatus(status)
}

function assertTransition(
  job: AgentJob,
  nextStatus: AgentJobStatus,
  allowedFrom: AgentJobStatus[],
): void {
  if (isTerminalStatus(job.status)) {
    throw new AgentJobRegistryError(
      `Agent job is already terminal: ${job.jobId}`,
      'AGENT_JOB_TERMINAL',
      409,
    )
  }

  if (!allowedFrom.includes(job.status)) {
    throw new AgentJobRegistryError(
      `Invalid agent job transition: ${job.status} -> ${nextStatus}`,
      'AGENT_JOB_INVALID_TRANSITION',
      409,
    )
  }
}

function isTerminalStatus(status: AgentJobStatus): boolean {
  return TERMINAL_AGENT_JOB_STATUSES.has(status)
}

function matchesFilter(job: AgentJob, filter: AgentJobFilter): boolean {
  if (filter.parentSessionId !== undefined && job.parentSessionId !== filter.parentSessionId) {
    return false
  }
  if (filter.status !== undefined && job.status !== filter.status) {
    return false
  }
  if (filter.agentType !== undefined && job.agentType !== filter.agentType) {
    return false
  }
  return true
}

export function cloneAgentJob(job: AgentJob): AgentJob {
  return {
    ...job,
    result: cloneAgentResult(job.result),
    error: cloneAgentJobError(job.error),
    metadata: cloneRecord(job.metadata),
  }
}

function cloneAgentResult(result: AgentResult | undefined): AgentResult | undefined {
  if (!result) return undefined
  return {
    summary: result.summary,
    findings: result.findings?.map(finding => ({ ...finding })),
    changedFiles: result.changedFiles ? [...result.changedFiles] : undefined,
    testsRun: result.testsRun ? [...result.testsRun] : undefined,
    commandsRun: result.commandsRun ? [...result.commandsRun] : undefined,
    nextSteps: result.nextSteps ? [...result.nextSteps] : undefined,
    confidence: result.confidence,
  }
}

function cloneAgentJobError(error: AgentJobError | undefined): AgentJobError | undefined {
  if (!error) return undefined
  return {
    code: error.code,
    message: error.message,
    details: error.details,
  }
}

function cloneRecord(record: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return record ? { ...record } : undefined
}
