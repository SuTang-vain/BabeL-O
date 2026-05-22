import { spawn } from 'node:child_process'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import chalk from 'chalk'
import { Command } from 'commander'
import { NexusClient } from './NexusClient.js'
import { executeEmbedded } from './embedded.js'
import { renderEvent } from './renderEvents.js'
import { flushStartupTrace, markStartup } from './startupTrace.js'
import type { NexusEvent } from '../shared/events.js'

markStartup('cli.imported')

const program = new Command()

program
  .name('bbl')
  .description('BabeL-O: Nexus-first coding agent CLI')
  .version('0.1.0')

program
  .command('run')
  .description('Run a one-shot coding prompt through Nexus')
  .argument('<prompt...>', 'Prompt to execute')
  .option('--url <url>', 'Use a running Nexus service instead of embedded mode')
  .option('--cwd <path>', 'Workspace directory', process.env.BABEL_O_LAUNCH_CWD ?? process.cwd())
  .action(async (promptParts: string[], options: { url?: string; cwd: string }) => {
    const prompt = promptParts.join(' ')
    const result = options.url
      ? await new NexusClient({ baseUrl: options.url }).execute({ prompt, cwd: options.cwd })
      : await executeEmbedded(prompt, options.cwd)

    for (const event of result.events as NexusEvent[]) {
      renderEvent(event)
    }
  })

program
  .command('chat')
  .description('Start an interactive Nexus-backed chat loop')
  .option('--url <url>', 'Use a running Nexus service instead of embedded mode')
  .option('--cwd <path>', 'Workspace directory', process.env.BABEL_O_LAUNCH_CWD ?? process.cwd())
  .action(async (options: { url?: string; cwd: string }) => {
    console.log(chalk.bold('bbl chat'))
    console.log(chalk.dim('Try: read README.md, grep Nexus, bash pwd, task "review runtime"'))
    const rl = readline.createInterface({ input, output })
    try {
      for (;;) {
        const prompt = await rl.question(chalk.cyan('bbl> '))
        if (['exit', 'quit', '/exit'].includes(prompt.trim())) break
        if (!prompt.trim()) continue

        const result = options.url
          ? await new NexusClient({ baseUrl: options.url }).execute({
              prompt,
              cwd: options.cwd,
            })
          : await executeEmbedded(prompt, options.cwd)
        for (const event of result.events as NexusEvent[]) {
          renderEvent(event)
        }
      }
    } finally {
      rl.close()
    }
  })

const nexus = program.command('nexus').description('Manage Nexus service')

nexus
  .command('start')
  .description('Start a local Nexus service')
  .option('--host <host>', 'Host to bind', '127.0.0.1')
  .option('--port <port>', 'Port to bind', '3000')
  .option('--cwd <path>', 'Workspace directory', process.env.BABEL_O_LAUNCH_CWD ?? process.cwd())
  .option('--storage-path <path>', 'SQLite storage path')
  .option('--allowed-tools <tools>', 'Comma-separated allowed tool names')
  .option('--execute-timeout-ms <ms>', 'Default execute timeout in milliseconds')
  .option('--max-concurrent-executions <count>', 'Maximum concurrent executions')
  .option('--max-tool-output-bytes <bytes>', 'Maximum stored/rendered tool output bytes')
  .option('--bash-max-buffer-bytes <bytes>', 'Maximum Bash process output buffer bytes')
  .action((options: {
    host: string
    port: string
    cwd: string
    storagePath?: string
    allowedTools?: string
    executeTimeoutMs?: string
    maxConcurrentExecutions?: string
    maxToolOutputBytes?: string
    bashMaxBufferBytes?: string
  }) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', new URL('../nexus/server.ts', import.meta.url).pathname],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          NEXUS_HOST: options.host,
          NEXUS_PORT: options.port,
          BABEL_O_WORKSPACE: options.cwd,
          ...(options.storagePath ? { NEXUS_STORAGE_PATH: options.storagePath } : {}),
          ...(options.allowedTools ? { NEXUS_ALLOWED_TOOLS: options.allowedTools } : {}),
          ...(options.executeTimeoutMs
            ? { NEXUS_EXECUTE_TIMEOUT_MS: options.executeTimeoutMs }
            : {}),
          ...(options.maxConcurrentExecutions
            ? { NEXUS_MAX_CONCURRENT_EXECUTIONS: options.maxConcurrentExecutions }
            : {}),
          ...(options.maxToolOutputBytes
            ? { NEXUS_MAX_TOOL_OUTPUT_BYTES: options.maxToolOutputBytes }
            : {}),
          ...(options.bashMaxBufferBytes
            ? { NEXUS_BASH_MAX_BUFFER_BYTES: options.bashMaxBufferBytes }
            : {}),
        },
      },
    )
    child.on('exit', code => process.exit(code ?? 0))
  })

nexus
  .command('status')
  .description('Read Nexus runtime status')
  .option('--url <url>', 'Nexus URL')
  .action(async (options: { url?: string }) => {
    console.log(JSON.stringify(await new NexusClient({ baseUrl: options.url }).status(), null, 2))
  })

const tools = program.command('tools').description('Inspect Nexus tools')

tools
  .command('audit')
  .description('Show registered tools and current allow policy')
  .option('--url <url>', 'Nexus URL')
  .action(async (options: { url?: string }) => {
    console.log(
      JSON.stringify(await new NexusClient({ baseUrl: options.url }).auditTools(), null, 2),
    )
  })

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

await program.parseAsync(process.argv)
flushStartupTrace()
