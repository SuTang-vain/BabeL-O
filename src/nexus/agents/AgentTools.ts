import { z } from 'zod'
import type { AnyTool, ToolDefinition } from '../../tools/Tool.js'
import type { AgentScheduler } from './types.js'

const AgentSpawnInputSchema = z.object({
  parentSessionId: z.string().optional(),
  prompt: z.string().min(1),
  agentType: z.enum(['explore', 'review', 'test', 'implement', 'debug', 'general']).default('explore'),
  contextForkMode: z.enum(['minimal', 'working-set', 'task-focused', 'full-summary', 'debug-replay']).optional(),
  isolation: z.enum(['none', 'worktree']).optional(),
  wait: z.boolean().default(false),
  timeoutMs: z.number().int().positive().optional(),
})

const AgentWaitInputSchema = z.object({
  jobId: z.string().min(1),
  timeoutMs: z.number().int().positive().optional(),
})

const AgentListInputSchema = z.object({
  status: z.enum(['queued', 'running', 'waiting_permission', 'completed', 'failed', 'cancelled']).optional(),
  parentSessionId: z.string().optional(),
})

const AgentCancelInputSchema = z.object({
  jobId: z.string().min(1),
  reason: z.string().optional(),
})

export function createAgentToolRegistry(scheduler: AgentScheduler): Map<string, AnyTool> {
  const tools = createAgentTools(scheduler)
  return new Map(tools.map(tool => [tool.name, tool]))
}

export function createAgentTools(scheduler: AgentScheduler): AnyTool[] {
  const spawnTool: ToolDefinition<typeof AgentSpawnInputSchema> = {
    name: 'AgentSpawn',
    description: 'Spawn a child agent job for exploration, review, or focused tests.',
    risk: 'task',
    inputSchema: AgentSpawnInputSchema,
    requiresApproval: false,
    suggestedAllowRule: 'AgentSpawn',
    prompt: () => [
      'Spawn a child agent job for exploration, review, or focused tests.',
      'Use agentType="explore" for locating code, "review" for read-only code review, and "test" for targeted validation.',
      'Explore agents use Read/Grep/Glob. Review/Test agents may also use restricted Bash for focused check-only validation commands.',
    ].join('\n'),
    async execute(input, context) {
      const job = await scheduler.spawnAgent({
        parentSessionId: input.parentSessionId ?? context.sessionId,
        prompt: input.prompt,
        agentType: input.agentType,
        contextForkMode: input.contextForkMode,
        isolation: input.isolation,
      })
      const waited = input.wait
        ? await scheduler.waitForAgent(job.jobId, { timeoutMs: input.timeoutMs })
        : undefined
      return {
        success: true,
        output: {
          jobId: job.jobId,
          childSessionId: job.childSessionId,
          status: waited?.status ?? job.status,
          agentType: job.agentType,
          result: waited?.result,
          message: waited
            ? `Agent job ${job.jobId} finished with status ${waited.status}.`
            : `Agent job ${job.jobId} queued.`,
        },
      }
    },
  }

  const waitTool: ToolDefinition<typeof AgentWaitInputSchema> = {
    name: 'AgentWait',
    description: 'Wait for a child agent job and return its structured result.',
    risk: 'task',
    inputSchema: AgentWaitInputSchema,
    requiresApproval: false,
    suggestedAllowRule: 'AgentWait',
    prompt: () => 'Wait for a child agent job and return its structured AgentResult without loading the full child transcript.',
    async execute(input) {
      const job = await scheduler.waitForAgent(input.jobId, { timeoutMs: input.timeoutMs })
      return { success: true, output: job }
    },
  }

  const listTool: ToolDefinition<typeof AgentListInputSchema> = {
    name: 'AgentList',
    description: 'List child agent jobs for the current or specified parent session.',
    risk: 'task',
    inputSchema: AgentListInputSchema,
    requiresApproval: false,
    suggestedAllowRule: 'AgentList',
    prompt: () => 'List child agent jobs by parent session and status.',
    async execute(input, context) {
      const jobs = await scheduler.listAgents({
        parentSessionId: input.parentSessionId ?? context.sessionId,
        status: input.status,
      })
      return { success: true, output: { jobs } }
    },
  }

  const cancelTool: ToolDefinition<typeof AgentCancelInputSchema> = {
    name: 'AgentCancel',
    description: 'Cancel a running or queued child agent job.',
    risk: 'task',
    inputSchema: AgentCancelInputSchema,
    requiresApproval: false,
    suggestedAllowRule: 'AgentCancel',
    prompt: () => 'Cancel a running or queued child agent job.',
    async execute(input) {
      const job = await scheduler.cancelAgent(input.jobId, input.reason)
      return { success: true, output: job }
    },
  }

  return [spawnTool, waitTool, listTool, cancelTool]
}
