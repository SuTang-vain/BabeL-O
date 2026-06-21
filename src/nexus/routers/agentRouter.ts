import { z } from 'zod'
import type { FastifyReply } from 'fastify'
import { AgentJobRegistryError } from '../agents/AgentJobRegistry.js'
import type { AgentJob, AgentScheduler } from '../agents/types.js'
import type { FeatureRouter } from '../router.js'

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

const eventListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(100),
  cursor: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('asc'),
})

export const agentRouter: FeatureRouter = {
  name: 'agentRouter',
  register(app, context) {
    const agentScheduler = requireAgentScheduler(context.agentScheduler)

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
      const page = await context.options.storage.listEvents(job.childSessionId, query)
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

    app.get('/v1/sessions/:sessionId/agents', async (request, reply) => {
      const params = z.object({ sessionId: z.string() }).parse(request.params)
      const query = agentListQuerySchema.omit({ parentSessionId: true }).parse(request.query)
      const session = await context.options.storage.getSession(params.sessionId, {
        includeEvents: false,
      })
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
  },
}

function requireAgentScheduler(agentScheduler: AgentScheduler | undefined): AgentScheduler {
  if (!agentScheduler) {
    throw new Error('agentRouter requires an AgentScheduler')
  }
  return agentScheduler
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

function createAgentJobNotFoundPayload(jobId: string): {
  type: 'error'
  code: string
  message: string
} {
  return {
    type: 'error',
    code: 'AGENT_JOB_NOT_FOUND',
    message: `Agent job not found: ${jobId}`,
  }
}

function createSessionNotFoundPayload(sessionId: string): {
  type: 'error'
  code: string
  message: string
} {
  return {
    type: 'error',
    code: 'SESSION_NOT_FOUND',
    message: `Session not found: ${sessionId}`,
  }
}
