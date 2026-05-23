import { spawn } from 'node:child_process'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import chalk from 'chalk'
import { Command } from 'commander'
import * as path from 'node:path'
import * as fs from 'node:fs'
import os from 'node:os'
import { NexusClient } from './NexusClient.js'
import { executeEmbedded } from './embedded.js'
import { renderEvent } from './renderEvents.js'
import { renderWelcome } from './welcome.js'
import { flushStartupTrace, markStartup } from './startupTrace.js'
import type { NexusEvent } from '../shared/events.js'
import { ConfigManager, DEFAULT_CONFIG_DIR } from '../shared/config.js'
import { modelRegistry } from '../providers/registry.js'
import { createDefaultNexusRuntime } from '../nexus/createRuntime.js'
import { createRuntimeAgentStepRunner } from '../nexus/runtimeAgentStep.js'
import { runAgentLoop } from '../nexus/agentLoop.js'
import { setNexusStorage } from '../nexus/storageBridge.js'
import { createId } from '../shared/id.js'
import { PLANNER_ROLE } from '../nexus/agentRoles.js'
import { PendingPermissionRegistry } from '../shared/session.js'
import { SqliteStorage } from '../storage/SqliteStorage.js'


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
    const rl = readline.createInterface({ input, output })
    const abortController = new AbortController()

    rl.on('SIGINT', () => {
      abortController.abort()
      console.log(chalk.yellow('\nExecution cancelled by user.'))
      process.exit(130)
    })

    try {
      renderWelcome({ cwd: options.cwd, url: options.url })
      await runSessionFlow(prompt, options.cwd, options.url, rl, abortController)
    } catch (e: any) {
      if (e.message !== 'Aborted' && e.name !== 'AbortError') {
        console.error(chalk.red(`Error: ${e.message || e}`))
      }
    } finally {
      rl.close()
    }
  })

program
  .command('chat')
  .description('Start an interactive Nexus-backed chat loop')
  .option('--url <url>', 'Use a running Nexus service instead of embedded mode')
  .option('--cwd <path>', 'Workspace directory', process.env.BABEL_O_LAUNCH_CWD ?? process.cwd())
  .option('--session <id>', 'Resume an existing session ID')
  .action(async (options: { url?: string; cwd: string; session?: string }) => {
    const historyFile = path.join(DEFAULT_CONFIG_DIR, 'history')
    let history: string[] = []
    try {
      if (fs.existsSync(historyFile)) {
        history = fs.readFileSync(historyFile, 'utf8')
          .split('\n')
          .map(line => line.trim())
          .filter(line => line.length > 0)
          .reverse()
      }
    } catch (e) {
      // ignore
    }

    const completer = (line: string): [string[], string] => {
      if (line.startsWith('/') && !line.includes(' ')) {
        const commands = ['/help', '/clear', '/exit', '/model', '/status', '/sessions', '/history']
        const hits = commands.filter(c => c.startsWith(line))
        return [hits, line]
      }

      if (line.startsWith('/model ')) {
        const modelPrefix = line.slice('/model '.length)
        const modelIds = modelRegistry.map(m => m.id)
        const hits = modelIds.filter(id => id.startsWith(modelPrefix))
        return [hits.map(id => `/model ${id}`), line]
      }

      const words = line.split(' ')
      const lastWord = words[words.length - 1] || ''

      if (lastWord.length > 0) {
        let searchDir = options.cwd
        let prefix = lastWord

        if (lastWord.includes('/') || lastWord.includes('\\')) {
          const lastSlashIndex = Math.max(lastWord.lastIndexOf('/'), lastWord.lastIndexOf('\\'))
          const dirPart = lastWord.slice(0, lastSlashIndex)
          prefix = lastWord.slice(lastSlashIndex + 1)
          searchDir = path.resolve(options.cwd, dirPart)
        }

        try {
          if (fs.existsSync(searchDir) && fs.statSync(searchDir).isDirectory()) {
            const files = fs.readdirSync(searchDir)
            const hits = files
              .filter(f => f.startsWith(prefix))
              .map(f => {
                const fullPath = path.join(searchDir, f)
                let isDir = false
                try {
                  isDir = fs.statSync(fullPath).isDirectory()
                } catch {}
                const pathPrefix = lastWord.slice(0, lastWord.length - prefix.length)
                return pathPrefix + f + (isDir ? '/' : '')
              })
            return [hits, lastWord]
          }
        } catch (e) {
          // ignore
        }
      }

      return [[], line]
    }

    const rl = readline.createInterface({
      input,
      output,
      completer,
      historySize: 1000,
      removeHistoryDuplicates: true
    })

    ;(rl as any).history = history

    let activeAbortController: AbortController | null = null

    rl.on('SIGINT', () => {
      if (activeAbortController) {
        activeAbortController.abort()
        console.log(chalk.yellow('\nExecution cancelled by user.'))
      } else {
        console.log(chalk.dim('\nExiting chat...'))
        rl.close()
        process.exit(0)
      }
    })

    renderWelcome({ cwd: options.cwd, url: options.url })

    const sessionId = options.session ?? createId('session')
    if (options.session) {
      console.log(chalk.cyan(`Resuming session: ${sessionId}`))
      
      try {
        let events: NexusEvent[] = []
        if (options.url) {
          const client = new NexusClient({ baseUrl: options.url })
          const res = (await client.listSessionEvents(sessionId, { limit: 100, order: 'asc' })) as { events: NexusEvent[] }
          events = res.events
        } else {
          const storagePath = path.join(DEFAULT_CONFIG_DIR, 'db.sqlite')
          if (fs.existsSync(storagePath)) {
            const storage = new SqliteStorage(storagePath)
            const res = await storage.listEvents(sessionId, { limit: 100, order: 'asc' })
            events = res.events
            await storage.close?.()
          }
        }

        if (events && events.length > 0) {
          console.log(chalk.dim('\n--- Session History ---'))
          let currentAssistantText = ''
          for (const ev of events) {
            if (ev.type === 'user_message') {
              if (currentAssistantText) {
                console.log(currentAssistantText)
                currentAssistantText = ''
              }
              console.log(`${chalk.cyan('bbl>')} ${ev.text}`)
            } else if (ev.type === 'assistant_delta') {
              currentAssistantText += ev.text
            } else if (ev.type === 'tool_started') {
              if (currentAssistantText) {
                console.log(currentAssistantText)
                currentAssistantText = ''
              }
              console.log(chalk.cyan(`→ ${ev.name}`), chalk.dim(JSON.stringify(ev.input)))
            } else if (ev.type === 'tool_completed') {
              console.log(
                ev.success ? chalk.green(`✓ ${ev.name}`) : chalk.red(`✗ ${ev.name}`)
              )
            }
          }
          if (currentAssistantText) {
            console.log(currentAssistantText)
          }
          console.log(chalk.dim('-----------------------\n'))
        }
      } catch (e: any) {
        console.error(chalk.yellow(`Warning: Failed to load session history: ${e.message || e}`))
      }
    } else {
      console.log(chalk.cyan(`Started new session: ${sessionId}`))
    }

    try {
      for (;;) {
        let prompt: string
        try {
          prompt = await rl.question(chalk.cyan('bbl> '))
        } catch (e: any) {
          if (e.name === 'AbortError') {
            continue
          }
          throw e
        }

        const trimmed = prompt.trim()
        if (trimmed === '/exit' || trimmed === 'exit' || trimmed === 'quit') {
          break
        }
        if (!trimmed) {
          continue
        }

        try {
          fs.mkdirSync(path.dirname(historyFile), { recursive: true })
          fs.appendFileSync(historyFile, trimmed + '\n', 'utf8')
        } catch (e) {
          // ignore
        }

        if (trimmed === '/clear' || trimmed === 'clear') {
          console.clear()
          continue
        }

        if (trimmed === '/help') {
          console.log(chalk.cyan('\n--- BabeL-O CLI Commands ---'))
          console.log(`${chalk.bold('/help')}          Show this help message`)
          console.log(`${chalk.bold('/clear')}         Clear terminal screen`)
          console.log(`${chalk.bold('/exit')}          Exit the interactive shell`)
          console.log(`${chalk.bold('/model')}         Show default model or switch it (e.g. /model anthropic/claude-3-5-sonnet)`)
          console.log(`${chalk.bold('/status')}        Show Nexus connection status`)
          console.log(`${chalk.bold('/sessions')}      List recent sessions`)
          console.log(`${chalk.bold('/history')}       Show or search command history (e.g. /history [keyword])`)
          console.log(`${chalk.bold('/history !<idx>')} Re-run history command at index`)
          console.log(chalk.dim('You can also type any natural language prompt to start a session.'))
          console.log()
          continue
        }

        if (trimmed.startsWith('/model')) {
          const parts = trimmed.split(/\s+/)
          const configManager = ConfigManager.getInstance()
          if (parts.length === 1) {
            const current = configManager.resolveSettings().modelId || 'local/coding-runtime'
            console.log(`Current default model: ${chalk.yellow(current)}`)
            console.log(`To switch model: ${chalk.bold('/model <modelId>')}`)
            console.log(`Available models:`)
            for (const m of modelRegistry) {
              console.log(`  - ${m.id}`)
            }
          } else {
            const modelId = parts[1]!
            const exists = modelRegistry.some(m => m.id === modelId)
            if (!exists) {
              console.warn(chalk.yellow(`Warning: Model "${modelId}" is not in the registered list, but setting it anyway.`))
            }
            configManager.setDefaultModel(modelId)
            console.log(chalk.green(`✓ Default model set to: ${modelId}`))
          }
          continue
        }

        if (trimmed === '/status') {
          if (options.url) {
            try {
              const client = new NexusClient({ baseUrl: options.url })
              const stat = await client.status()
              console.log(chalk.cyan('\n--- Nexus Service Status ---'))
              console.log(JSON.stringify(stat, null, 2))
            } catch (e: any) {
              console.error(chalk.red(`Failed to get status from service: ${e.message || e}`))
            }
          } else {
            console.log(chalk.cyan('\n--- Embedded Nexus Status ---'))
            console.log(`Mode: ${chalk.bold('Embedded (Local)')}`)
            console.log(`Workspace CWD: ${chalk.white(options.cwd)}`)
            const configManager = ConfigManager.getInstance()
            const model = configManager.resolveSettings().modelId || 'local/coding-runtime'
            console.log(`Model: ${chalk.yellow(model)}`)
          }
          continue
        }

        if (trimmed === '/sessions') {
          if (options.url) {
            try {
              const client = new NexusClient({ baseUrl: options.url })
              const list = await client.listSessions()
              console.log(chalk.cyan('\n--- Recent Sessions ---'))
              console.log(JSON.stringify(list, null, 2))
            } catch (e: any) {
              console.error(chalk.red(`Failed to list sessions from service: ${e.message || e}`))
            }
          } else {
            try {
              const storagePath = path.join(DEFAULT_CONFIG_DIR, 'db.sqlite')
              const storage = new SqliteStorage(storagePath)
              const list = await storage.listSessions({ limit: 10 })
              await storage.close?.()
              console.log(chalk.cyan('\n--- Recent Sessions (Local) ---'))
              console.log(JSON.stringify(list, null, 2))
            } catch (e: any) {
              console.error(chalk.red(`Failed to list local sessions: ${e.message || e}`))
            }
          }
          continue
        }

        if (trimmed.startsWith('/history !')) {
          const indexStr = trimmed.slice('/history !'.length).trim()
          const targetIdx = parseInt(indexStr, 10)

          try {
            if (fs.existsSync(historyFile)) {
              const allLines = fs.readFileSync(historyFile, 'utf8')
                .split('\n')
                .map(l => l.trim())
                .filter(l => l.length > 0)

              if (targetIdx > 0 && targetIdx <= allLines.length) {
                const cmdToRun = allLines[targetIdx - 1]!
                console.log(chalk.green(`Re-running command #${targetIdx}: ${cmdToRun}`))
                fs.appendFileSync(historyFile, cmdToRun + '\n', 'utf8')

                const abortController = new AbortController()
                activeAbortController = abortController
                try {
                  await runSessionFlow(cmdToRun, options.cwd, options.url, rl, abortController, sessionId)
                } catch (e: any) {
                  if (e.message !== 'Aborted' && e.name !== 'AbortError') {
                    console.error(chalk.red(`Error: ${e.message || e}`))
                  }
                } finally {
                  activeAbortController = null
                }
              } else {
                console.log(chalk.red(`Invalid history index. Range: 1 - ${allLines.length}`))
              }
            } else {
              console.log(chalk.dim('No command history found.'))
            }
          } catch (e: any) {
            console.error(chalk.red(`Failed to execute history command: ${e.message || e}`))
          }
          continue
        }

        if (trimmed.startsWith('/history')) {
          const parts = trimmed.split(/\s+/)
          const keyword = parts.slice(1).join(' ').trim()

          try {
            if (fs.existsSync(historyFile)) {
              const allLines = fs.readFileSync(historyFile, 'utf8')
                .split('\n')
                .map(l => l.trim())
                .filter(l => l.length > 0)

              if (keyword) {
                const matches = allLines
                  .map((cmd, idx) => ({ cmd, originalIdx: idx + 1 }))
                  .filter(item => item.cmd.toLowerCase().includes(keyword.toLowerCase()))

                console.log(chalk.cyan(`\n--- History search results for "${keyword}" ---`))
                if (matches.length === 0) {
                  console.log(chalk.dim('No matches found.'))
                } else {
                  const lastMatches = matches.slice(-20)
                  for (const match of lastMatches) {
                    console.log(`${chalk.dim(match.originalIdx + ':')} ${match.cmd}`)
                  }
                }
              } else {
                console.log(chalk.cyan(`\n--- Recent Command History ---`))
                const lastCommands = allLines.slice(-20)
                const startIdx = Math.max(1, allLines.length - 20 + 1)
                lastCommands.forEach((cmd, idx) => {
                  console.log(`${chalk.dim((startIdx + idx) + ':')} ${cmd}`)
                })
              }
              console.log()
            } else {
              console.log(chalk.dim('No command history found.'))
            }
          } catch (e: any) {
            console.error(chalk.red(`Failed to read history: ${e.message || e}`))
          }
          continue
        }

        const abortController = new AbortController()
        activeAbortController = abortController
        try {
          await runSessionFlow(trimmed, options.cwd, options.url, rl, abortController, sessionId)
        } catch (e: any) {
          if (e.message !== 'Aborted' && e.name !== 'AbortError') {
            console.error(chalk.red(`Error: ${e.message || e}`))
          }
        } finally {
          activeAbortController = null
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

const configCmd = program.command('config').description('Manage configuration')

configCmd
  .command('add')
  .description('Configure credentials for a provider')
  .argument('<provider>', 'Provider ID (e.g., anthropic, openai)')
  .argument('<key>', 'API Key')
  .argument('[baseUrl]', 'Custom Base URL')
  .action((provider: string, key: string, baseUrl?: string) => {
    const configManager = ConfigManager.getInstance()
    configManager.setProviderConfig(provider, { apiKey: key, baseUrl })
    console.log(chalk.green(`✓ Configured credentials for provider: ${provider}`))
  })

configCmd
  .command('list')
  .description('List active configuration and resolved settings')
  .action(() => {
    const configManager = ConfigManager.getInstance()
    const rawConfig = configManager.load()
    const resolved = configManager.resolveSettings()

    const maskedConfig = JSON.parse(JSON.stringify(rawConfig))
    if (maskedConfig.providers) {
      for (const p of Object.keys(maskedConfig.providers)) {
        if (maskedConfig.providers[p].apiKey) {
          maskedConfig.providers[p].apiKey = '********'
        }
      }
    }

    const maskedResolved = {
      ...resolved,
      apiKey: resolved.apiKey ? '********' : undefined,
    }

    console.log(chalk.cyan.bold('\n--- Active Config file ---'))
    console.log(JSON.stringify(maskedConfig, null, 2))

    console.log(chalk.cyan.bold('\n--- Resolved Settings ---'))
    console.log(JSON.stringify(maskedResolved, null, 2))
    console.log()
  })

configCmd
  .command('use')
  .description('Set the default model')
  .argument('<modelId>', 'Canonical Model ID (e.g. anthropic/claude-3-5-sonnet)')
  .action((modelId: string) => {
    const configManager = ConfigManager.getInstance()
    const exists = modelRegistry.some(m => m.id === modelId)
    if (!exists) {
      console.warn(chalk.yellow(`Warning: Model "${modelId}" is not in the registered list, but setting it anyway.`))
    }
    configManager.setDefaultModel(modelId)
    console.log(chalk.green(`✓ Default model set to: ${modelId}`))
  })

const modelsCmd = program.command('models').description('Inspect capability matrices for supported models')

modelsCmd
  .command('list')
  .description('List all supported models and their capabilities')
  .action(() => {
    console.log(chalk.cyan.bold('\nSupported Models Capability Matrix:'))
    console.log('----------------------------------------------------')
    for (const model of modelRegistry) {
      const toolSupport = model.capabilities.toolCalling ? chalk.green('✓ tool-call') : chalk.red('✗ tool-call')
      const jsonSupport = model.capabilities.jsonOutput ? chalk.green('✓ json') : chalk.red('✗ json')
      const streamingSupport = model.capabilities.streaming ? chalk.green('✓ stream') : chalk.red('✗ stream')
      
      console.log(
        `${chalk.bold(model.id.padEnd(30))} | Context: ${String(model.contextWindow).padEnd(7)} | ${toolSupport} | ${jsonSupport} | ${streamingSupport}`
      )
    }
    console.log()
  })

modelsCmd
  .command('inspect')
  .description('Inspect details of a specific model')
  .argument('<modelId>', 'Model ID')
  .action((modelId: string) => {
    const model = modelRegistry.find(m => m.id === modelId)
    if (!model) {
      console.error(chalk.red(`Error: Model "${modelId}" not found in model registry.`))
      process.exit(1)
    }
    console.log(chalk.cyan.bold(`\nModel Details: ${model.name}`))
    console.log(`ID:             ${model.id}`)
    console.log(`Context Window: ${model.contextWindow} tokens`)
    console.log('Capabilities:')
    console.log(`  Tool Calling: ${model.capabilities.toolCalling ? chalk.green('Yes') : chalk.red('No')}`)
    console.log(`  JSON Output:  ${model.capabilities.jsonOutput ? chalk.green('Yes') : chalk.red('No')}`)
    console.log(`  Streaming:    ${model.capabilities.streaming ? chalk.green('Yes') : chalk.red('No')}`)
    console.log()
  })

program
  .command('optimize')
  .description('Optimize a specific target file or directory using self-optimizing agents')
  .option('--target <path>', 'Path to file or directory to optimize')
  .option('--focus <focus>', 'Optimization focus: performance, cleanup, or security', 'performance')
  .option('--dry-run', 'Generate the plan but do not execute changes')
  .option('--auto-approve', 'Automatically approve all optimization changes without manual feedback')
  .option('--cwd <path>', 'Workspace directory', process.env.BABEL_O_LAUNCH_CWD ?? process.cwd())
  .action(async (options: { target?: string; focus: 'performance' | 'cleanup' | 'security'; dryRun?: boolean; autoApprove?: boolean; cwd: string }) => {
    const targetPath = options.target
    if (!targetPath) {
      console.error(chalk.red('Error: --target option is required.'))
      process.exit(1)
    }

    console.log(chalk.bold.blue(`Starting optimizer on: ${targetPath} (focus: ${options.focus})`))

    const { runtime, storage } = createDefaultNexusRuntime()
    setNexusStorage(storage)

    // Wrap storage.appendEvent to render events in real-time
    const originalAppendEvent = storage.appendEvent.bind(storage)
    storage.appendEvent = async (sessionId, event) => {
      await originalAppendEvent(sessionId, event)
      renderEvent(event)
    }

    const sessionId = createId('session')
    const prompt = `Optimize the file or directory at "${targetPath}" focusing on ${options.focus}. Please compile and verify correctness.`

    if (options.dryRun) {
      console.log(chalk.yellow('Dry-run mode: planning phase only.'))
      try {
        const stepRunner = createRuntimeAgentStepRunner({
          cwd: options.cwd,
          runtimeFactory: async () => runtime,
        })

        const plannerOutput = await stepRunner<{ sessionId: string; goal: string; queueId: string; context?: string }, {
          summary: string
          tasks: Array<{
            title: string
            description?: string
            dependsOn?: string[]
            metadata?: Record<string, unknown>
          }>
        }>({
          roleDefinition: PLANNER_ROLE,
          input: {
            sessionId,
            goal: prompt,
            queueId: sessionId,
            context: `Cwd: ${options.cwd}`,
          },
        })

        console.log(chalk.green.bold('\n--- Optimization Plan ---'))
        console.log(chalk.white(plannerOutput.summary))
        console.log(chalk.cyan.bold('\nProposed Tasks:'))
        plannerOutput.tasks.forEach((t, i) => {
          console.log(chalk.white(`  ${i + 1}. [${t.title}]` + (t.description ? `: ${t.description}` : '')))
          if (t.dependsOn && t.dependsOn.length > 0) {
            console.log(chalk.dim(`     Depends on: ${t.dependsOn.join(', ')}`))
          }
        })
        console.log(chalk.yellow('\nDry-run: exiting without executing changes.'))
      } catch (err) {
        console.error(chalk.red('Failed during dry-run planning:'), err)
      } finally {
        await storage.close?.()
      }
      return
    }

    try {
      const stepRunner = createRuntimeAgentStepRunner({
        cwd: options.cwd,
        runtimeFactory: async () => runtime,
      })

      const finalSession = await runAgentLoop({
        sessionId,
        cwd: options.cwd,
        prompt,
        stepRunner,
        role: 'optimizer',
        autoApprove: options.autoApprove,
      })

      if (finalSession.phase === 'completed') {
        console.log(chalk.green.bold('\n✓ Optimization successfully completed!'))
      } else {
        console.log(chalk.red.bold(`\n✗ Optimization failed: ${finalSession.error || finalSession.failureReason || 'Unknown error'}`))
      }
    } catch (err) {
      console.error(chalk.red('\nOptimizer encountered an uncaught error:'), err)
    } finally {
      await storage.close?.()
    }
  })

await program.parseAsync(process.argv)
flushStartupTrace()

async function runSessionFlow(
  prompt: string,
  cwd: string,
  url: string | undefined,
  rl: readline.Interface,
  abortController: AbortController,
  sessionIdArg?: string
): Promise<string> {
  const sessionId = sessionIdArg ?? createId('session')

  if (url) {
    const wsUrl = url.replace(/^http/, 'ws') + '/v1/stream'
    const wsModule = await (new Function("return import('ws')")())
    const WebSocketCtor = (globalThis as any).WebSocket || wsModule.default

    return new Promise<string>((resolve, reject) => {
      let socket: any
      
      const onAbort = () => {
        if (socket) {
          try {
            socket.close()
          } catch {}
        }
        new NexusClient({ baseUrl: url }).cancelSession(sessionId).catch(() => {})
        reject(new Error('Aborted'))
      }

      if (abortController.signal.aborted) {
        onAbort()
        return
      }
      abortController.signal.addEventListener('abort', onAbort)

      try {
        const wsOpts: any = {}
        const apiKey = process.env.NEXUS_API_KEY
        if (apiKey) {
          wsOpts.headers = {
            'X-Nexus-API-Key': apiKey,
          }
        }
        socket = new WebSocketCtor(wsUrl, wsOpts)
      } catch (err) {
        abortController.signal.removeEventListener('abort', onAbort)
        reject(err)
        return
      }

      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ prompt, cwd, sessionId }))
      })

      socket.addEventListener('message', async (event: any) => {
        try {
          const data = JSON.parse(event.data)
          if (data.type === 'permission_request') {
            renderEvent(data)
            try {
              const answer = await rl.question(chalk.yellow('Approve tool execution? [y/n] '), {
                signal: abortController.signal,
              })
              const approved = ['y', 'yes'].includes(answer.trim().toLowerCase())
              if (socket.readyState === 1 /* OPEN */) {
                socket.send(JSON.stringify({
                  type: 'permission_response',
                  sessionId: data.sessionId,
                  toolUseId: data.toolUseId,
                  approved,
                }))
              }
            } catch (err: any) {
              if (err.name === 'AbortError') {
                // User aborted during prompt
              } else {
                reject(err)
              }
            }
          } else {
            renderEvent(data)
            if (data.type === 'result' || data.type === 'error') {
              abortController.signal.removeEventListener('abort', onAbort)
              socket.close()
              resolve(sessionId)
            }
          }
        } catch (err) {
          abortController.signal.removeEventListener('abort', onAbort)
          reject(err)
        }
      })

      socket.addEventListener('close', () => {
        abortController.signal.removeEventListener('abort', onAbort)
        resolve(sessionId)
      })

      socket.addEventListener('error', (err: any) => {
        abortController.signal.removeEventListener('abort', onAbort)
        console.error(chalk.red(`WebSocket error: ${err.message || err}`))
        reject(err)
      })
    })
  } else {
    fs.mkdirSync(DEFAULT_CONFIG_DIR, { recursive: true })
    const storagePath = path.join(DEFAULT_CONFIG_DIR, 'db.sqlite')
    const { runtime, storage } = createDefaultNexusRuntime({ storagePath })
    const originalAppendEvent = storage.appendEvent.bind(storage)

    storage.appendEvent = async (sid, ev) => {
      await originalAppendEvent(sid, ev)
      if (ev.type === 'permission_request') {
        renderEvent(ev)
        try {
          const answer = await rl.question(chalk.yellow('Approve tool execution? [y/n] '), {
            signal: abortController.signal,
          })
          const approved = ['y', 'yes'].includes(answer.trim().toLowerCase())
          PendingPermissionRegistry.getInstance().resolve(sid, ev.toolUseId, { approved })
        } catch (err: any) {
          if (err.name === 'AbortError') {
            PendingPermissionRegistry.getInstance().resolve(sid, ev.toolUseId, {
              approved: false,
              reason: 'Cancelled by user',
            })
          } else {
            throw err
          }
        }
      } else {
        renderEvent(ev)
      }
    }

    let session = await storage.getSession(sessionId, { includeEvents: false })
    if (!session) {
      session = {
        sessionId,
        cwd,
        prompt,
        phase: 'executing' as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        events: [],
      }
    } else {
      session.phase = 'executing'
      session.updatedAt = new Date().toISOString()
      session.lastUserInput = prompt
    }
    await storage.saveSession(session)

    await storage.appendEvent(sessionId, {
      type: 'user_message',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId,
      timestamp: new Date().toISOString(),
      text: prompt,
    })

    try {
      const configManager = ConfigManager.getInstance()
      const settings = configManager.resolveSettings()
      const requestId = createId('req')
      const budget = process.env.BABEL_O_THINKING_BUDGET
        ? parseInt(process.env.BABEL_O_THINKING_BUDGET, 10)
        : undefined

      for await (const event of runtime.executeStream({
        sessionId,
        prompt,
        cwd,
        signal: abortController.signal,
        requestId,
        model: settings.modelId,
        budget,
      })) {
        await storage.appendEvent(sessionId, event)
      }
    } catch (err: any) {
      if (err.message !== 'Aborted' && err.name !== 'AbortError') {
        throw err
      }
    } finally {
      const finalSession = await storage.getSession(sessionId, { includeEvents: false })
      if (finalSession) {
        if (abortController.signal.aborted) {
          finalSession.phase = 'cancelled'
        } else {
          const eventsResult = await storage.listEvents(sessionId, { limit: 100 })
          const events = eventsResult.events
          const errorEvent = events.findLast(e => e.type === 'error')
          const resultEvent = events.findLast(e => e.type === 'result')
          const succeeded = !errorEvent && resultEvent?.type === 'result' && resultEvent.success
          finalSession.phase = succeeded ? 'completed' : 'failed'
          if (resultEvent?.type === 'result') finalSession.result = resultEvent.message
          if (errorEvent?.type === 'error') finalSession.error = errorEvent.message
        }
        finalSession.updatedAt = new Date().toISOString()
        await storage.saveSession(finalSession)
      }
      await storage.close?.()
    }
    return sessionId
  }
}

