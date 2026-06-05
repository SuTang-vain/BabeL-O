import { Command } from 'commander'
import { NexusClient } from '../NexusClient.js'
import type { AgentJobFilter, AgentSpawnRequest } from '../../nexus/agents/types.js'

export function registerAgentsCommand(program: Command): void {
  const agents = program.command('agents').description('Manage Nexus agent jobs')

  agents
    .command('spawn')
    .description('Spawn a read-only Explore agent job')
    .requiredOption('--parent-session-id <sessionId>', 'Parent session id')
    .option('--url <url>', 'Nexus URL')
    .option('--agent-type <type>', 'Agent profile id', 'explore')
    .option('--context-fork-mode <mode>', 'Context fork mode')
    .option('--isolation <mode>', 'Isolation mode')
    .option('--max-runtime-ms <ms>', 'Maximum runtime in milliseconds')
    .option('--wait', 'Wait for the spawned job to finish')
    .option('--timeout-ms <ms>', 'Wait timeout in milliseconds')
    .argument('<prompt...>', 'Agent prompt')
    .action(async (promptParts: string[], options: AgentSpawnCommandOptions) => {
      const client = new NexusClient({ baseUrl: options.url })
      const spawned = await client.spawnAgent(buildAgentSpawnRequest(promptParts, options))
      if (options.wait) {
        console.log(
          JSON.stringify(
            await client.waitAgent(spawned.job.jobId, {
              timeoutMs: parseOptionalPositiveInteger(options.timeoutMs, '--timeout-ms'),
            }),
            null,
            2,
          ),
        )
        return
      }
      console.log(JSON.stringify(spawned, null, 2))
    })

  agents
    .command('list')
    .description('List agent jobs')
    .option('--url <url>', 'Nexus URL')
    .option('--parent-session-id <sessionId>', 'Parent session id')
    .option('--status <status>', 'Agent job status')
    .option('--agent-type <type>', 'Agent profile id')
    .action(async (options: AgentListCommandOptions) => {
      console.log(
        JSON.stringify(
          await new NexusClient({ baseUrl: options.url }).listAgents(buildAgentFilter(options)),
          null,
          2,
        ),
      )
    })

  agents
    .command('show')
    .description('Show one agent job')
    .argument('<jobId>', 'Agent job id')
    .option('--url <url>', 'Nexus URL')
    .action(async (jobId: string, options: { url?: string }) => {
      console.log(
        JSON.stringify(
          await new NexusClient({ baseUrl: options.url }).getAgent(jobId),
          null,
          2,
        ),
      )
    })

  agents
    .command('wait')
    .description('Wait for an agent job to finish')
    .argument('<jobId>', 'Agent job id')
    .option('--url <url>', 'Nexus URL')
    .option('--timeout-ms <ms>', 'Wait timeout in milliseconds')
    .action(async (jobId: string, options: { url?: string; timeoutMs?: string }) => {
      console.log(
        JSON.stringify(
          await new NexusClient({ baseUrl: options.url }).waitAgent(jobId, {
            timeoutMs: parseOptionalPositiveInteger(options.timeoutMs, '--timeout-ms'),
          }),
          null,
          2,
        ),
      )
    })

  agents
    .command('cancel')
    .description('Cancel an agent job')
    .argument('<jobId>', 'Agent job id')
    .option('--url <url>', 'Nexus URL')
    .option('--reason <reason>', 'Cancellation reason')
    .action(async (jobId: string, options: { url?: string; reason?: string }) => {
      console.log(
        JSON.stringify(
          await new NexusClient({ baseUrl: options.url }).cancelAgent(jobId, options.reason),
          null,
          2,
        ),
      )
    })

  agents
    .command('transcript')
    .description('Page through an agent job transcript')
    .argument('<jobId>', 'Agent job id')
    .option('--url <url>', 'Nexus URL')
    .option('--limit <count>', 'Events to fetch', '100')
    .option('--cursor <cursor>', 'Pagination cursor')
    .option('--order <order>', 'asc or desc', 'asc')
    .action(async (
      jobId: string,
      options: { url?: string; limit: string; cursor?: string; order: string },
    ) => {
      console.log(
        JSON.stringify(
          await new NexusClient({ baseUrl: options.url }).getAgentTranscript(jobId, {
            limit: parsePositiveInteger(options.limit, '--limit'),
            cursor: options.cursor,
            order: options.order === 'desc' ? 'desc' : 'asc',
          }),
          null,
          2,
        ),
      )
    })

  agents
    .command('session')
    .description('List agent jobs for a parent session')
    .argument('<sessionId>', 'Parent session id')
    .option('--url <url>', 'Nexus URL')
    .option('--status <status>', 'Agent job status')
    .option('--agent-type <type>', 'Agent profile id')
    .action(async (sessionId: string, options: Omit<AgentListCommandOptions, 'parentSessionId'>) => {
      console.log(
        JSON.stringify(
          await new NexusClient({ baseUrl: options.url }).listSessionAgents(sessionId, buildAgentFilter(options)),
          null,
          2,
        ),
      )
    })
}

type AgentSpawnCommandOptions = {
  url?: string
  parentSessionId: string
  agentType?: string
  contextForkMode?: string
  isolation?: string
  maxRuntimeMs?: string
  wait?: boolean
  timeoutMs?: string
}

type AgentListCommandOptions = {
  url?: string
  parentSessionId?: string
  status?: string
  agentType?: string
}

export function buildAgentSpawnRequest(promptParts: string[], options: AgentSpawnCommandOptions): AgentSpawnRequest {
  return {
    parentSessionId: options.parentSessionId,
    prompt: promptParts.join(' '),
    agentType: options.agentType as AgentSpawnRequest['agentType'],
    contextForkMode: options.contextForkMode as AgentSpawnRequest['contextForkMode'],
    isolation: options.isolation as AgentSpawnRequest['isolation'],
    maxRuntimeMs: parseOptionalPositiveInteger(options.maxRuntimeMs, '--max-runtime-ms'),
  }
}

export function buildAgentFilter(options: AgentListCommandOptions): AgentJobFilter {
  return {
    parentSessionId: options.parentSessionId,
    status: options.status as AgentJobFilter['status'],
    agentType: options.agentType as AgentJobFilter['agentType'],
  }
}

function parseOptionalPositiveInteger(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined
  return parsePositiveInteger(value, flag)
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`)
  }
  return parsed
}
