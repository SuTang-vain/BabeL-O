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
