import * as path from 'node:path'
import chalk from 'chalk'
import { Command } from 'commander'
import { NexusClient } from '../NexusClient.js'
import { DEFAULT_CONFIG_DIR } from '../../shared/config.js'

export function registerSessionsCommand(program: Command): void {
  const sessions = program.command('sessions').description('Inspect Nexus sessions')

  sessions
    .command('list')
    .description('List sessions')
    .option('--url <url>', 'Nexus URL')
    .action(async (options: { url?: string }) => {
      console.log(
        JSON.stringify(await new NexusClient({ baseUrl: options.url }).listSessions(), null, 2),
      )
    })

  sessions
    .command('show')
    .description('Show one session')
    .argument('<sessionId>', 'Session id')
    .option('--url <url>', 'Nexus URL')
    .option('--recent-event-limit <count>', 'Number of recent events to include', '100')
    .action(async (
      sessionId: string,
      options: { url?: string; recentEventLimit: string },
    ) => {
      console.log(
        JSON.stringify(
          await new NexusClient({ baseUrl: options.url }).getSession(sessionId, {
            recentEventLimit: Number(options.recentEventLimit),
          }),
          null,
          2,
        ),
      )
    })

  sessions
    .command('events')
    .description('Page through session events')
    .argument('<sessionId>', 'Session id')
    .option('--url <url>', 'Nexus URL')
    .option('--limit <count>', 'Events to fetch', '100')
    .option('--cursor <cursor>', 'Pagination cursor')
    .option('--order <order>', 'asc or desc', 'asc')
    .action(async (
      sessionId: string,
      options: { url?: string; limit: string; cursor?: string; order: string },
    ) => {
      console.log(
        JSON.stringify(
          await new NexusClient({ baseUrl: options.url }).listSessionEvents(sessionId, {
            limit: Number(options.limit),
            cursor: options.cursor,
            order: options.order === 'desc' ? 'desc' : 'asc',
          }),
          null,
          2,
        ),
      )
    })

  sessions
    .command('children')
    .description('List child sessions with transcript previews')
    .argument('<sessionId>', 'Parent session id')
    .option('--url <url>', 'Nexus URL')
    .option('--limit <count>', 'Child sessions to fetch', '200')
    .option('--event-limit <count>', 'Recent child events to include', '5')
    .option('--failed-only', 'Only include failed or cancelled child sessions')
    .option('--no-events', 'Do not include event previews')
    .action(async (
      sessionId: string,
      options: { url?: string; limit: string; eventLimit: string; failedOnly?: boolean; events?: boolean },
    ) => {
      console.log(
        JSON.stringify(
          await new NexusClient({ baseUrl: options.url }).listChildSessions(sessionId, {
            limit: Number(options.limit),
            eventLimit: Number(options.eventLimit),
            failedOnly: options.failedOnly === true,
            includeEvents: options.events !== false,
          }),
          null,
          2,
        ),
      )
    })

  sessions
    .command('child-events')
    .description('Page through a child session transcript from its parent session')
    .argument('<sessionId>', 'Parent session id')
    .argument('<childSessionId>', 'Child session id')
    .option('--url <url>', 'Nexus URL')
    .option('--limit <count>', 'Events to fetch', '100')
    .option('--cursor <cursor>', 'Pagination cursor')
    .option('--order <order>', 'asc or desc', 'asc')
    .action(async (
      sessionId: string,
      childSessionId: string,
      options: { url?: string; limit: string; cursor?: string; order: string },
    ) => {
      console.log(
        JSON.stringify(
          await new NexusClient({ baseUrl: options.url }).listChildSessionEvents(
            sessionId,
            childSessionId,
            {
              limit: Number(options.limit),
              cursor: options.cursor,
              order: options.order === 'desc' ? 'desc' : 'asc',
            },
          ),
          null,
          2,
        ),
      )
    })

  sessions
    .command('retry-task')
    .description('Mark a failed task pending again so an operator or AgentLoop can rerun it')
    .argument('<sessionId>', 'Session id')
    .argument('<taskId>', 'Task id')
    .option('--url <url>', 'Nexus URL')
    .option('--reason <reason>', 'Retry reason', 'retry requested from CLI')
    .action(async (sessionId: string, taskId: string, options: { url?: string; reason: string }) => {
      console.log(
        JSON.stringify(
          await new NexusClient({ baseUrl: options.url }).mutateTask(sessionId, taskId, 'retry', {
            actor: 'cli',
            source: 'sessions.retry-task',
            reason: options.reason,
          }),
          null,
          2,
        ),
      )
    })

  sessions
    .command('rerun-subagent')
    .description('Mark a failed sub-agent task pending again with transcript-preserving audit metadata')
    .argument('<sessionId>', 'Parent session id')
    .argument('<taskId>', 'Failed sub-agent task id')
    .option('--url <url>', 'Nexus URL')
    .option('--reason <reason>', 'Rerun reason', 'sub-agent rerun requested from CLI')
    .action(async (sessionId: string, taskId: string, options: { url?: string; reason: string }) => {
      console.log(
        JSON.stringify(
          await new NexusClient({ baseUrl: options.url }).rerunSubAgentTask(sessionId, taskId, {
            actor: 'cli',
            source: 'sessions.rerun-subagent',
            reason: options.reason,
          }),
          null,
          2,
        ),
      )
    })

  sessions
    .command('worktree-recovery')
    .description('Record a worktree conflict recovery action for a task')
    .argument('<sessionId>', 'Session id')
    .argument('<taskId>', 'Task id')
    .argument('<action>', 'continue, abandon, or keep')
    .option('--url <url>', 'Nexus URL')
    .option('--reason <reason>', 'Recovery reason')
    .action(async (
      sessionId: string,
      taskId: string,
      action: string,
      options: { url?: string; reason?: string },
    ) => {
      if (action !== 'continue' && action !== 'abandon' && action !== 'keep') {
        throw new Error(`Invalid worktree recovery action: ${action}`)
      }
      console.log(
        JSON.stringify(
          await new NexusClient({ baseUrl: options.url }).recoverWorktreeTask(sessionId, taskId, action, {
            actor: 'cli',
            source: 'sessions.worktree-recovery',
            reason: options.reason,
          }),
          null,
          2,
        ),
      )
    })

  sessions
    .command('resume')
    .description('Record user input for a session')
    .argument('<sessionId>', 'Session id')
    .argument('<message...>', 'Message to append')
    .option('--url <url>', 'Nexus URL')
    .action(async (sessionId: string, messageParts: string[], options: { url?: string }) => {
      console.log(
        JSON.stringify(
          await new NexusClient({ baseUrl: options.url }).resumeSession(
            sessionId,
            messageParts.join(' '),
          ),
          null,
          2,
        ),
      )
    })

  sessions
    .command('cancel')
    .description('Cancel a session')
    .argument('<sessionId>', 'Session id')
    .option('--url <url>', 'Nexus URL')
    .action(async (sessionId: string, options: { url?: string }) => {
      console.log(
        JSON.stringify(
          await new NexusClient({ baseUrl: options.url }).cancelSession(sessionId),
          null,
          2,
        ),
      )
    })
}
