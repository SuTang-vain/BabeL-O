import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { emitKeypressEvents } from 'node:readline'
import { stdin as input, stdout as output } from 'node:process'
import chalk from 'chalk'
import { Command } from 'commander'
import * as path from 'node:path'
import * as fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { NexusClient } from './NexusClient.js'
import { executeEmbedded } from './embedded.js'
import {
  renderEvent,
  getChatPrompt,
  setActiveReadline,
  startSession,
  resumeSessionHistory,
  toggleTuiMode,
  startSpinner,
  stopSpinner,
  redrawSession
} from './renderEvents.js'
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

type CliReadline = readline.Interface

markStartup('cli.imported')

const program = new Command()

type PermissionChoice =
  | 'approve_once'
  | 'approve_session'
  | 'reject'
  | 'reject_instruct'

type PermissionDecision = {
  approved: boolean
  scope: 'once' | 'session'
  reason?: string
}

const sessionPermissionApprovals = new Map<string, Set<string>>()

function questionAsync(rl: CliReadline, query: string): Promise<string> {
  return new Promise(resolve => {
    rl.question(query, answer => resolve(answer))
  })
}

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

    const completer = (line: string, callback?: (err?: any, result?: [string[], string]) => void) => {
      let hits: string[] = []
      let substring = line

      if (line.startsWith('/') && !line.includes(' ')) {
        const commands = getSlashCompletionChoices()
        hits = commands.filter(c => c.startsWith(line))
        substring = line
      } else if (line.startsWith('/tool')) {
        const toolPrefix = line.slice('/tool'.length).trimStart().toLowerCase()
        const toolChoices = getToolCompletionChoices()
        hits = toolChoices.filter(c => c.toLowerCase().startsWith(`/tool ${toolPrefix}`))
        substring = line
      } else if (line.startsWith('/model ')) {
        const modelPrefix = line.slice('/model '.length)
        const modelIds = modelRegistry.map(m => m.id)
        hits = modelIds.filter(id => id.startsWith(modelPrefix)).map(id => `/model ${id}`)
        substring = line
      } else {
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
              const fileHits = files
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
              hits = fileHits
              substring = lastWord
            }
          } catch (e) {
            // ignore
          }
        }
      }

      const complete = (result: [string[], string]) => {
        if (callback) {
          callback(null, result)
          return undefined
        }
        return result
      }

      if (hits.length === 0) {
        return complete([[], substring])
      } else if (hits.length === 1) {
        const mapped = mapDropdownSelection(hits[0]!)
        return complete([[mapped], substring])
      } else {
        return complete([hits, substring])
      }
    }

    const rl = readline.createInterface({
      input,
      output,
      completer: completer as any,
      historySize: 1000,
      removeHistoryDuplicates: true
    } as any)

    ;(rl as any).history = history
    setActiveReadline(rl)

    let activeAbortController: AbortController | null = null
    let isExecuting = false
    const slashPalette = createSlashPalette(rl)

    const onGlobalKeypress = (chunk: any, key: any) => {
      if (!isExecuting && slashPalette.handleKey(chunk, key)) {
        return
      }
      if (key) {
        if (key.ctrl && key.name === 'o') {
          // Clear readline prompt line
          process.stdout.write('\r\x1b[K')
          // Toggle TUI mode and redraw session
          toggleTuiMode()
          // Refresh prompt if not executing
          if (!isExecuting) {
            if (typeof (rl as any)._refreshLine === 'function') {
              ;(rl as any)._refreshLine()
            } else {
              rl.prompt()
            }
          }
          return
        }
        if (key.ctrl && key.name === 'c') {
          if (isExecuting && activeAbortController) {
            activeAbortController.abort()
            console.log(chalk.yellow('\nExecution cancelled by user.'))
          } else {
            console.log(chalk.dim('\nExiting chat...'))
            cleanupListeners()
            rl.close()
            process.exit(0)
          }
          return
        }
      }
    }

    const cleanupListeners = () => {
      slashPalette.dispose()
      process.stdin.removeListener('keypress', onGlobalKeypress)
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false)
      }
    }

    process.stdin.on('keypress', onGlobalKeypress)
    rl.on('line', () => slashPalette.close())

    rl.on('SIGINT', () => {
      if (activeAbortController) {
        activeAbortController.abort()
        console.log(chalk.yellow('\nExecution cancelled by user.'))
      } else {
        console.log(chalk.dim('\nExiting chat...'))
        cleanupListeners()
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
          resumeSessionHistory(events)
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
          prompt = await questionAsync(rl, getChatPrompt())
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
          console.log(`${chalk.bold('/tool')}          Browse built-in tools and insert a tool prompt prefix`)
          console.log(chalk.dim('You can also type any natural language prompt to start a session.'))
          console.log()
          continue
        }

        if (trimmed === '/tool' || trimmed === '/tools') {
          const selected = await pickCompletionChoice(getToolCompletionChoices())
          if (selected) {
            const mapped = mapDropdownSelection(selected)
            console.log(chalk.dim(`Inserted: ${mapped.trim()}`))
            const abortController = new AbortController()
            activeAbortController = abortController
            isExecuting = true
            startSession()
            try {
              await runSessionFlow(mapped.trim(), options.cwd, options.url, rl, abortController, sessionId)
            } catch (e: any) {
              if (e.message !== 'Aborted' && e.name !== 'AbortError') {
                console.error(chalk.red(`Error: ${e.message || e}`))
              }
            } finally {
              activeAbortController = null
              isExecuting = false
              stopSpinner()
            }
          }
          continue
        }

        if (trimmed.startsWith('/model')) {
          const parts = trimmed.split(/\s+/)
          const configManager = ConfigManager.getInstance()
          if (parts.length === 1) {
            isExecuting = true
            try {
              await runModelConfigWizard()
            } catch (err: any) {
              console.error(chalk.red(`Wizard error: ${err.message || err}`))
            } finally {
              isExecuting = false
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
                isExecuting = true
                startSession()
                try {
                  await runSessionFlow(cmdToRun, options.cwd, options.url, rl, abortController, sessionId)
                } catch (e: any) {
                  if (e.message !== 'Aborted' && e.name !== 'AbortError') {
                    console.error(chalk.red(`Error: ${e.message || e}`))
                  }
                } finally {
                  activeAbortController = null
                  isExecuting = false
                  stopSpinner()
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
        isExecuting = true
        startSession()
        try {
          await runSessionFlow(trimmed, options.cwd, options.url, rl, abortController, sessionId)
        } catch (e: any) {
          if (e.message !== 'Aborted' && e.name !== 'AbortError') {
            console.error(chalk.red(`Error: ${e.message || e}`))
          }
        } finally {
          activeAbortController = null
          isExecuting = false
          stopSpinner()
        }
      }
    } finally {
      cleanupListeners()
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

    const { runtime, storage } = await createDefaultNexusRuntime()
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

const isMain = () => {
  try {
    const mainPath = fs.realpathSync(process.argv[1] || '')
    const currentPath = fs.realpathSync(fileURLToPath(import.meta.url))
    return mainPath === currentPath
  } catch {
    return false
  }
}

if (isMain()) {
  await program.parseAsync(process.argv)
  flushStartupTrace()
}

async function runSessionFlow(
  prompt: string,
  cwd: string,
  url: string | undefined,
  rl: CliReadline,
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
              const cached = data.name ? sessionPermissionApprovals.get(data.sessionId)?.has(data.name) : false
              const decision: PermissionDecision = cached
                ? { approved: true, scope: 'session' }
                : await askPermission(rl, data, abortController.signal)
              if (decision.approved && decision.scope === 'session' && data.name) {
                const tools = sessionPermissionApprovals.get(data.sessionId) ?? new Set<string>()
                tools.add(data.name)
                sessionPermissionApprovals.set(data.sessionId, tools)
              }
              if (socket.readyState === 1 /* OPEN */) {
                socket.send(JSON.stringify({
                  type: 'permission_response',
                  sessionId: data.sessionId,
                  toolUseId: data.toolUseId,
                  approved: decision.approved,
                  reason: decision.reason,
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
    const { runtime, storage } = await createDefaultNexusRuntime({
      storagePath,
      allowedTools: ['*'],
    })
    const originalAppendEvent = storage.appendEvent.bind(storage)

    storage.appendEvent = async (sid, ev) => {
      await originalAppendEvent(sid, ev)
      if (ev.type === 'permission_request') {
        renderEvent(ev)
        void handleLocalPermissionRequest(sid, ev, rl, abortController.signal).catch(err => {
          console.error(chalk.red(`Permission prompt error: ${err.message || err}`))
          PendingPermissionRegistry.getInstance().resolve(sid, ev.toolUseId, {
            approved: false,
            reason: 'Permission prompt failed',
          })
        })
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

export function mapDropdownSelection(selected: string): string {
  const mappings: Record<string, string> = {
    '/read': 'read ',
    '/write': 'write ',
    '/edit': 'edit ',
    '/grep': 'grep ',
    '/glob': 'glob ',
    '/bash': 'bash ',
    '/task': 'task ',
    '/tool': '/tool ',
    '/tools': '/tool ',
    '/tool read': 'read ',
    '/tool write': 'write ',
    '/tool edit': 'edit ',
    '/tool grep': 'grep ',
    '/tool glob': 'glob ',
    '/tool bash': 'bash ',
    '/tool task': 'task ',
    '/model': '/model ',
    '/history': '/history ',
    '/help': '/help',
    '/clear': '/clear',
    '/exit': '/exit',
    '/status': '/status',
    '/sessions': '/sessions',
  }
  return mappings[selected] ?? mappings[selected.toLowerCase()] ?? selected
}

export function getSlashCompletionChoices(): string[] {
  return [
    '/help', '/clear', '/exit', '/model', '/status', '/sessions', '/history', '/tool',
    '/read', '/write', '/edit', '/grep', '/glob', '/bash', '/task',
  ]
}

export function getToolCompletionChoices(): string[] {
  return [
    '/tool read',
    '/tool write',
    '/tool edit',
    '/tool grep',
    '/tool glob',
    '/tool bash',
    '/tool task',
  ]
}

export function describeCompletionChoice(choice: string): { label: string; tag: string; description: string } {
  const details: Record<string, { tag: string; description: string }> = {
    '/help': { tag: 'command', description: 'Show command help' },
    '/clear': { tag: 'command', description: 'Clear the terminal' },
    '/exit': { tag: 'command', description: 'Exit chat' },
    '/model': { tag: 'config', description: 'Open model configuration wizard' },
    '/status': { tag: 'status', description: 'Show current runtime and model' },
    '/sessions': { tag: 'session', description: 'List recent sessions' },
    '/history': { tag: 'history', description: 'Search and replay prompt history' },
    '/tool': { tag: 'tools', description: 'Open the tool picker' },
    '/read': { tag: 'tool', description: 'Insert read prompt prefix' },
    '/write': { tag: 'tool', description: 'Insert write prompt prefix' },
    '/edit': { tag: 'tool', description: 'Insert edit prompt prefix' },
    '/grep': { tag: 'tool', description: 'Insert grep prompt prefix' },
    '/glob': { tag: 'tool', description: 'Insert glob prompt prefix' },
    '/bash': { tag: 'tool', description: 'Insert bash prompt prefix' },
    '/task': { tag: 'tool', description: 'Insert task prompt prefix' },
    '/tool read': { tag: 'read', description: 'Read a file inside the workspace' },
    '/tool write': { tag: 'write', description: 'Write a file with permission' },
    '/tool edit': { tag: 'write', description: 'Replace text in a file with permission' },
    '/tool grep': { tag: 'read', description: 'Search file contents' },
    '/tool glob': { tag: 'read', description: 'Find files by pattern' },
    '/tool bash': { tag: 'execute', description: 'Run a shell command with permission' },
    '/tool task': { tag: 'task', description: 'Create a task record' },
  }
  return {
    label: choice,
    tag: details[choice]?.tag ?? 'path',
    description: details[choice]?.description ?? 'Workspace path',
  }
}

export function formatCompletionChoice(choice: string, selected: boolean): string {
  const { label, tag, description } = describeCompletionChoice(choice)
  const prefix = selected ? '~ ' : '  '
  const row = `${prefix}${label.padEnd(16)} [${tag}]  ${description}`
  return selected ? chalk.black.bgCyan(row) : chalk.dim(row)
}

export function getSlashPaletteChoices(input: string): string[] {
  if (!/^\/[A-Za-z]*$/.test(input)) return []
  const normalized = input.toLowerCase()
  return getSlashCompletionChoices()
    .filter(choice => choice.toLowerCase().startsWith(normalized))
    .sort((left, right) => left.localeCompare(right))
}

export function formatSlashPalette(
  choices: string[],
  activeIndex: number,
  totalCount = choices.length,
): string {
  if (choices.length === 0) return ''
  const visible = choices.slice(0, 8)
  const lines = [
    chalk.dim('─'.repeat(Math.min(process.stdout.columns || 80, 72))),
  ]
  for (let index = 0; index < visible.length; index++) {
    const choice = visible[index]!
    const { label, description } = describeCompletionChoice(choice)
    const selected = index === activeIndex
    const marker = selected ? chalk.blue('>') : ' '
    const left = selected ? chalk.blue(label) : chalk.white(label)
    const right = chalk.dim(description)
    lines.push(`${marker} ${left.padEnd(18)} ${right}`)
  }
  const remaining = Math.max(0, totalCount - visible.length)
  if (remaining > 0) {
    lines.push(`  ${chalk.dim(`↓ ${remaining} more`)}`)
  }
  lines.push('')
  lines.push(`${chalk.dim('↑/↓ Navigate ·')} ${chalk.blue('tab')} ${chalk.dim('Complete ·')} ${chalk.blue('enter')} ${chalk.dim('Run')}`)
  return `${lines.join('\n')}\n`
}

export function isPermissionApproved(answer: string): boolean {
  return ['y', 'yes'].includes(answer.trim().toLowerCase())
}

async function handleLocalPermissionRequest(
  sessionId: string,
  event: { toolUseId: string; name?: string; risk?: string },
  rl: CliReadline,
  signal: AbortSignal,
): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
  try {
    const cached = event.name ? sessionPermissionApprovals.get(sessionId)?.has(event.name) : false
    const decision: PermissionDecision = cached
      ? { approved: true, scope: 'session' }
      : await askPermission(rl, event, signal)
    if (decision.approved && decision.scope === 'session' && event.name) {
      const tools = sessionPermissionApprovals.get(sessionId) ?? new Set<string>()
      tools.add(event.name)
      sessionPermissionApprovals.set(sessionId, tools)
    }
    const resolved = PendingPermissionRegistry.getInstance().resolve(sessionId, event.toolUseId, {
      approved: decision.approved,
      reason: decision.approved ? undefined : decision.reason ?? 'Denied by user',
    })
    if (!resolved) {
      console.error(chalk.red(`Permission request not found: ${event.toolUseId}`))
    }
  } catch (err: any) {
    if (err.name === 'AbortError') {
      PendingPermissionRegistry.getInstance().resolve(sessionId, event.toolUseId, {
        approved: false,
        reason: 'Cancelled by user',
      })
    } else {
      throw err
    }
  }
}

async function askPermission(
  rl: CliReadline,
  event: { name?: string; risk?: string; input?: unknown },
  signal: AbortSignal,
): Promise<PermissionDecision> {
  const wasRaw = process.stdin.isRaw
  const dataListeners = process.stdin.listeners('data')
  const keypressListeners = process.stdin.listeners('keypress')
  rl.pause()
  process.stdin.removeAllListeners('keypress')

  return new Promise<PermissionDecision>((resolve, reject) => {
    let settled = false
    let activeIndex = 0
    let renderedLines = 0
    const choices: { id: PermissionChoice; label: string }[] = [
      { id: 'approve_once', label: 'Approve once' },
      { id: 'approve_session', label: 'Approve for this session' },
      { id: 'reject', label: 'Reject' },
      { id: 'reject_instruct', label: 'Reject, tell the model what to do instead' },
    ]

    const cleanup = () => {
      clearRenderedPermissionDialog()
      process.stdin.removeListener('data', onData)
      process.stdin.removeListener('keypress', onKeypress)
      for (const listener of dataListeners) {
        process.stdin.on('data', listener as any)
      }
      for (const listener of keypressListeners) {
        process.stdin.on('keypress', listener as any)
      }
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(wasRaw)
      }
      signal.removeEventListener('abort', onAbort)
      rl.resume()
      process.stdin.resume()
    }

    const redraw = () => {
      clearRenderedPermissionDialog()
      const dialog = formatPermissionDialog(event, choices, activeIndex)
      process.stdout.write(dialog)
      renderedLines = countRenderedLines(dialog)
    }

    const clearRenderedPermissionDialog = () => {
      if (renderedLines <= 0) return
      process.stdout.write(`\x1b[${renderedLines}A\x1b[J`)
      renderedLines = 0
    }

    const finish = async (choice: PermissionChoice) => {
      if (settled) return
      settled = true
      let decision: PermissionDecision
      if (choice === 'approve_once') {
        decision = { approved: true, scope: 'once' }
      } else if (choice === 'approve_session') {
        decision = { approved: true, scope: 'session' }
      } else if (choice === 'reject_instruct') {
        cleanup()
        const reason = await questionAsync(rl, chalk.yellow('Tell the model what to do instead: '))
        resolve({
          approved: false,
          scope: 'once',
          reason: reason.trim() || 'Denied by user',
        })
        return
      } else {
        decision = { approved: false, scope: 'once', reason: 'Denied by user' }
      }
      cleanup()
      resolve(decision)
    }

    const onAbort = () => {
      if (settled) return
      settled = true
      process.stdout.write('\n')
      cleanup()
      const err = new Error('Aborted')
      err.name = 'AbortError'
      reject(err)
    }

    const move = (delta: number) => {
      activeIndex = (activeIndex + delta + choices.length) % choices.length
      redraw()
    }

    const chooseIndex = (index: number) => {
      activeIndex = index
      void finish(choices[activeIndex]!.id)
    }

    const onData = (chunk: Buffer | string) => {
      const text = chunk.toString('utf8')
      if (text.includes('\u0003')) {
        onAbort()
        return
      }
      if (text.includes('\x1b[A')) {
        move(-1)
        return
      }
      if (text.includes('\x1b[B')) {
        move(1)
        return
      }
      for (const char of text) {
        if (char >= '1' && char <= '4') {
          chooseIndex(Number(char) - 1)
          return
        }
        if (char === '\r' || char === '\n') {
          void finish(choices[activeIndex]!.id)
          return
        }
        if (char === '\x1b') {
          chooseIndex(2)
          return
        }
      }
    }

    const onKeypress = (_chunk: any, key: any) => {
      if (key?.ctrl && key.name === 'c') {
        onAbort()
        return
      }
      if (key?.name === 'up') {
        move(-1)
      } else if (key?.name === 'down') {
        move(1)
      } else if (key?.name === 'return') {
        void finish(choices[activeIndex]!.id)
      } else if (key?.name === 'escape') {
        chooseIndex(2)
      } else if (['1', '2', '3', '4'].includes(key?.name)) {
        chooseIndex(Number(key.name) - 1)
      }
    }

    for (const listener of dataListeners) {
      process.stdin.removeListener('data', listener as any)
    }
    process.stdin.on('data', onData)
    process.stdin.on('keypress', onKeypress)
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true)
    }
    process.stdin.resume()
    signal.addEventListener('abort', onAbort, { once: true })
    redraw()
  })
}

export function formatPermissionDialog(
  event: { name?: string; risk?: string; input?: unknown },
  choices: { id: PermissionChoice; label: string }[],
  activeIndex: number,
): string {
  const tool = event.name || 'tool'
  const risk = event.risk ? `${event.risk} risk` : 'unknown risk'
  const command = formatPermissionInput(event.input)
  const lines = [
    chalk.yellow(' approval '),
    `│ ${chalk.yellow(`${tool} is requesting approval (${risk})`)}`,
  ]
  if (command) {
    lines.push('│')
    lines.push(`│ ${command}`)
  }

  choices.forEach((choice, index) => {
    const selected = index === activeIndex
    const marker = selected ? chalk.cyan('➜') : ' '
    const label = selected ? chalk.cyan(choice.label) : chalk.dim(choice.label)
    lines.push(`│ ${marker} [${index + 1}] ${label}`)
  })

  lines.push(` ${chalk.dim('▲/▼ select   1/2/3/4 choose   ↵ confirm   esc reject')}`)
  return `${lines.join('\n')}\n`
}

function formatPermissionInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  if (typeof record.command === 'string') return record.command
  if (typeof record.path === 'string') return record.path
  return JSON.stringify(input)
}

function countRenderedLines(text: string): number {
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length
}

function createSlashPalette(rl: CliReadline) {
  let activeIndex = 0
  let currentChoices: string[] = []
  let consumedNavigationKey = false
  let isOpen = false
  let query = ''
  let renderedLines = 0
  let pendingRefresh: NodeJS.Timeout | null = null
  const originalTtyWrite = typeof (rl as any)._ttyWrite === 'function'
    ? (rl as any)._ttyWrite.bind(rl)
    : null

  const cancelPendingRefresh = () => {
    if (pendingRefresh) {
      clearTimeout(pendingRefresh)
      pendingRefresh = null
    }
  }

  const scheduleRefresh = () => {
    cancelPendingRefresh()
    pendingRefresh = setTimeout(() => {
      pendingRefresh = null
      refresh()
    }, 0)
  }

  const refresh = () => {
    const line = (rl as any).line ?? ''
    if (!isOpen || line !== currentChoices[activeIndex]) {
      query = line
    }
    currentChoices = getSlashPaletteChoices(query)
    if (currentChoices.length === 0) {
      close()
      return
    }
    isOpen = true
    activeIndex = Math.min(activeIndex, Math.min(currentChoices.length, 8) - 1)
    preview()
    renderOverlay()
  }

  const renderOverlay = () => {
    clear()
    const palette = formatSlashPalette(currentChoices, activeIndex, currentChoices.length)
    if (!palette) return
    const line = (rl as any).line ?? ''
    const prompt = getChatPrompt()
    output.write(`\r\x1b[K${prompt}${line}`)
    output.write('\n')
    output.write(palette)
    renderedLines = 1 + countRenderedLines(palette)
    readline.moveCursor(output, 0, -renderedLines)
    readline.cursorTo(output, prompt.length + line.length)
  }

  const clear = () => {
    if (!isOpen || renderedLines <= 0) return
    readline.cursorTo(output, 0)
    readline.clearScreenDown(output)
    renderedLines = 0
  }

  const close = () => {
    cancelPendingRefresh()
    clear()
    currentChoices = []
    activeIndex = 0
    isOpen = false
    query = ''
    refreshReadline()
  }

  const setInputLine = (value: string) => {
    ;(rl as any).line = value
    ;(rl as any).cursor = value.length
  }

  const preview = () => {
    const selected = currentChoices[activeIndex]
    if (!selected) return false
    setInputLine(selected)
    return true
  }

  const refreshFromCurrentInput = (previewSelection: boolean) => {
    const line = (rl as any).line ?? ''
    query = line
    currentChoices = getSlashPaletteChoices(query)
    if (currentChoices.length === 0) {
      close()
      return
    }
    isOpen = true
    activeIndex = Math.min(activeIndex, Math.min(currentChoices.length, 8) - 1)
    if (previewSelection) {
      preview()
    }
    renderOverlay()
  }

  const select = () => {
    const selected = currentChoices[activeIndex]
    if (!selected) return false
    const mapped = mapDropdownSelection(selected)
    setInputLine(mapped)
    close()
    return true
  }

  const move = (delta: number) => {
    if (currentChoices.length === 0) return false
    const visibleCount = Math.min(currentChoices.length, 8)
    activeIndex = (activeIndex + delta + visibleCount) % visibleCount
    preview()
    renderOverlay()
    return true
  }

  const handleKey = (chunk: any, key: any): boolean => {
    if (consumedNavigationKey) {
      consumedNavigationKey = false
      return true
    }
    const line = (rl as any).line ?? ''
    const shouldShow = getSlashPaletteChoices(line).length > 0
    if (!shouldShow) {
      close()
      return false
    }
    const raw = chunk ? chunk.toString('utf8') : ''
    if (raw.includes('\x1b[A')) return move(-1)
    if (raw.includes('\x1b[B')) return move(1)
    if (raw === '\t') return select()
    if (raw === '\r' || raw === '\n') return false
    if (key?.name === 'up') return move(-1)
    if (key?.name === 'down') return move(1)
    if (key?.name === 'tab') return select()
    if (key?.name === 'return') return false
    if (key?.name === 'escape') {
      close()
      return true
    }
    scheduleRefresh()
    return false
  }

  if (originalTtyWrite) {
    ;(rl as any)._ttyWrite = (text: string, key: any) => {
      const raw = typeof text === 'string' ? text : ''
      const keyName = key?.name
      const navigationKey = keyName === 'up' || keyName === 'down' || keyName === 'tab' ||
        raw.includes('\x1b[A') || raw.includes('\x1b[B') || raw === '\t'
      const escapeKey = keyName === 'escape' || raw === '\x1b'
      const backspaceKey = keyName === 'backspace' || raw === '\x7f' || raw === '\b'
      const line = (rl as any).line ?? ''
      const choices = isOpen ? currentChoices : getSlashPaletteChoices(line)

      if (escapeKey && isOpen) {
        cancelPendingRefresh()
        consumedNavigationKey = true
        close()
        return
      }

      if (backspaceKey && isOpen) {
        cancelPendingRefresh()
        clear()
        const cursor = (rl as any).cursor ?? line.length
        if (cursor > 0) {
          const nextLine = line.slice(0, cursor - 1) + line.slice(cursor)
          ;(rl as any).line = nextLine
          ;(rl as any).cursor = cursor - 1
        }
        refreshFromCurrentInput(false)
        consumedNavigationKey = true
        return
      }

      if (navigationKey && choices.length > 0) {
        cancelPendingRefresh()
        currentChoices = choices
        if (!isOpen) {
          query = line
          isOpen = true
        }
        activeIndex = Math.min(activeIndex, Math.min(currentChoices.length, 8) - 1)
        consumedNavigationKey = true
        if (keyName === 'up' || raw.includes('\x1b[A')) move(-1)
        else if (keyName === 'down' || raw.includes('\x1b[B')) move(1)
        else select()
        return
      }
      return originalTtyWrite(text, key)
    }
  }

  const refreshReadline = () => {
    if (typeof (rl as any)._refreshLine === 'function') {
      ;(rl as any)._refreshLine()
    }
  }

  const dispose = () => {
    cancelPendingRefresh()
    close()
    if (originalTtyWrite) {
      ;(rl as any)._ttyWrite = originalTtyWrite
    }
  }

  return { close, dispose, handleKey }
}

function runInteractiveDropdown(
  choices: string[],
  originalWord: string,
  onSelect: (selected: string) => void
) {
  let activeIndex = 0
  const displayChoices = choices.slice(0, 10)

  const keypressListeners = process.stdin.listeners('keypress')
  const wasRaw = process.stdin.isRaw

  process.stdin.removeAllListeners('keypress')

  const redraw = () => {
    // Save cursor
    process.stdout.write('\x1b[s')
    // Move down 1 line and clear everything below
    process.stdout.write('\n\x1b[J')
    // Draw the dropdown options
    for (let i = 0; i < displayChoices.length; i++) {
      const isSelected = i === activeIndex
      process.stdout.write(formatCompletionChoice(displayChoices[i]!, isSelected) + '\n')
    }
    // Restore cursor position
    process.stdout.write('\x1b[u')
  }

  const cleanup = () => {
    // Clear dropdown rendering
    process.stdout.write('\x1b[s\n\x1b[J\x1b[u')
    process.stdin.removeListener('keypress', handleKey)
    for (const l of keypressListeners) {
      process.stdin.addListener('keypress', l as any)
    }
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(wasRaw)
    }
  }

  const handleKey = (chunk: any, key: any) => {
    const name = key?.name || (chunk ? chunk.toString() : '')
    const ctrl = key?.ctrl || (key && key.ctrl)

    if (ctrl && name === 'c') {
      cleanup()
      process.exit(0)
    }
    if (name === 'up' || name === '\u001b[A' || name === '\x1b[A') {
      activeIndex = (activeIndex - 1 + displayChoices.length) % displayChoices.length
      redraw()
      return
    }
    if (name === 'down' || name === '\u001b[B' || name === '\x1b[B') {
      activeIndex = (activeIndex + 1) % displayChoices.length
      redraw()
      return
    }
    if (name === 'enter' || name === 'return' || name === '\r' || name === '\n') {
      cleanup()
      onSelect(displayChoices[activeIndex]!)
      return
    }
    if (name === 'escape' || name === '\u001b' || name === '\x1b') {
      cleanup()
      onSelect('')
      return
    }

    // Any other key: close dropdown, cancel select, and replay key event on stdin
    cleanup()
    onSelect('')
    if (chunk || key) {
      process.stdin.emit('keypress', chunk, key)
    }
  }

  process.stdin.on('keypress', handleKey)
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
  }

  redraw()
}

function pickCompletionChoice(choices: string[]): Promise<string> {
  return new Promise(resolve => {
    runInteractiveDropdown(choices, '', selected => resolve(selected))
  })
}

function chooseInteractive(
  question: string,
  choices: string[],
  onSelect: (selected: string) => void
) {
  let activeIndex = 0

  // Ensure keypress parser is active and stdin is flowing
  emitKeypressEvents(process.stdin)
  process.stdin.resume()

  const keypressListeners = process.stdin.listeners('keypress')
  const wasRaw = process.stdin.isRaw

  process.stdin.removeAllListeners('keypress')

  const redraw = () => {
    process.stdout.write('\x1b[s')
    process.stdout.write('\n\x1b[J')
    process.stdout.write(chalk.cyan(question) + '\n')
    for (let i = 0; i < choices.length; i++) {
      const isSelected = i === activeIndex
      const prefix = isSelected ? chalk.cyan('> ') : '  '
      const text = isSelected ? chalk.black.bgCyan(choices[i]!) : chalk.dim(choices[i]!)
      process.stdout.write(prefix + text + '\n')
    }
    process.stdout.write('\x1b[u')
  }

  const cleanup = () => {
    process.stdout.write('\x1b[s\n\x1b[J\x1b[u')
    process.stdin.removeListener('keypress', handleKey)
    for (const l of keypressListeners) {
      process.stdin.addListener('keypress', l as any)
    }
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(wasRaw)
    }
  }

  const handleKey = (chunk: any, key: any) => {
    const name = key?.name || (chunk ? chunk.toString() : '')
    const ctrl = key?.ctrl || (key && key.ctrl)

    if (ctrl && name === 'c') {
      cleanup()
      process.exit(0)
    }
    if (name === 'up' || name === '\u001b[A' || name === '\x1b[A') {
      activeIndex = (activeIndex - 1 + choices.length) % choices.length
      redraw()
      return
    }
    if (name === 'down' || name === '\u001b[B' || name === '\x1b[B') {
      activeIndex = (activeIndex + 1) % choices.length
      redraw()
      return
    }
    if (name === 'enter' || name === 'return' || name === '\r' || name === '\n') {
      cleanup()
      onSelect(choices[activeIndex]!)
      return
    }
    if (name === 'escape' || name === '\u001b' || name === '\x1b') {
      cleanup()
      onSelect('')
      return
    }
  }

  process.stdin.on('keypress', handleKey)
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
  }

  redraw()
}

function promptSecret(question: string, callback: (secret: string) => void) {
  // Ensure keypress parser is active and stdin is flowing
  emitKeypressEvents(process.stdin)
  process.stdin.resume()

  process.stdout.write(chalk.cyan(question))
  let value = ''

  const keypressListeners = process.stdin.listeners('keypress')
  const wasRaw = process.stdin.isRaw

  process.stdin.removeAllListeners('keypress')

  const handleKey = (chunk: any, key: any) => {
    const name = key?.name || (chunk ? chunk.toString() : '')
    const ctrl = key?.ctrl || (key && key.ctrl)

    if (ctrl && name === 'c') {
      cleanup()
      process.exit(0)
    }
    if (name === 'escape' || name === '\u001b' || name === '\x1b') {
      process.stdout.write('\n')
      cleanup()
      callback('')
      return
    }
    if (name === 'enter' || name === 'return' || name === '\r' || name === '\n') {
      process.stdout.write('\n')
      cleanup()
      callback(value)
      return
    }
    if (name === 'backspace' || name === '\x7f' || name === '\b') {
      if (value.length > 0) {
        value = value.slice(0, -1)
        process.stdout.write('\b\x1b[K')
      }
      return
    }

    if (chunk && chunk !== '\r' && chunk !== '\n' && chunk !== '\u001b' && chunk !== '\x1b' && chunk !== '\x7f' && chunk !== '\b') {
      if (!chunk.toString().startsWith('\x1b')) {
        value += chunk
        process.stdout.write('*')
      }
    }
  }

  const cleanup = () => {
    process.stdin.removeListener('keypress', handleKey)
    for (const l of keypressListeners) {
      process.stdin.addListener('keypress', l as any)
    }
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(wasRaw)
    }
  }

  process.stdin.on('keypress', handleKey)
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
  }
}

function promptText(question: string, defaultValue: string, callback: (text: string) => void) {
  // Ensure keypress parser is active and stdin is flowing
  emitKeypressEvents(process.stdin)
  process.stdin.resume()

  const showDefault = defaultValue ? chalk.dim(` (${defaultValue})`) : ''
  process.stdout.write(chalk.cyan(question) + showDefault + ': ')
  let value = ''

  const keypressListeners = process.stdin.listeners('keypress')
  const wasRaw = process.stdin.isRaw

  process.stdin.removeAllListeners('keypress')

  const handleKey = (chunk: any, key: any) => {
    const name = key?.name || (chunk ? chunk.toString() : '')
    const ctrl = key?.ctrl || (key && key.ctrl)

    if (ctrl && name === 'c') {
      cleanup()
      process.exit(0)
    }
    if (name === 'escape' || name === '\u001b' || name === '\x1b') {
      process.stdout.write('\n')
      cleanup()
      callback('')
      return
    }
    if (name === 'enter' || name === 'return' || name === '\r' || name === '\n') {
      process.stdout.write('\n')
      cleanup()
      callback(value || defaultValue)
      return
    }
    if (name === 'backspace' || name === '\x7f' || name === '\b') {
      if (value.length > 0) {
        value = value.slice(0, -1)
        process.stdout.write('\b\x1b[K')
      }
      return
    }

    if (chunk && chunk !== '\r' && chunk !== '\n' && chunk !== '\u001b' && chunk !== '\x1b' && chunk !== '\x7f' && chunk !== '\b') {
      if (!chunk.toString().startsWith('\x1b')) {
        value += chunk
        process.stdout.write(chunk)
      }
    }
  }

  const cleanup = () => {
    process.stdin.removeListener('keypress', handleKey)
    for (const l of keypressListeners) {
      process.stdin.addListener('keypress', l as any)
    }
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(wasRaw)
    }
  }

  process.stdin.on('keypress', handleKey)
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
  }
}

async function runModelConfigWizard() {
  const chooseInteractivePromise = (question: string, choices: string[]): Promise<string> => {
    return new Promise((resolve) => chooseInteractive(question, choices, resolve))
  }
  const promptSecretPromise = (question: string): Promise<string> => {
    return new Promise((resolve) => promptSecret(question, resolve))
  }
  const promptTextPromise = (question: string, defaultValue: string): Promise<string> => {
    return new Promise((resolve) => promptText(question, defaultValue, resolve))
  }

  console.log(chalk.bold.cyan('\n--- BabeL-O Model Config Wizard ---'))

  const providers = ['anthropic', 'openai', 'zhipu', 'minimax', 'local']
  const provider = await chooseInteractivePromise('Select provider:', providers)
  if (!provider) {
    console.log(chalk.yellow('Wizard cancelled.'))
    return
  }

  if (provider === 'local') {
    const configManager = ConfigManager.getInstance()
    configManager.setDefaultModel('local/coding-runtime')
    console.log(chalk.green('\n✓ Default model set to: local/coding-runtime'))
    return
  }

  const configManager = ConfigManager.getInstance()
  const currentProviderConfig = configManager.getProviderConfig(provider)
  const existingKey = currentProviderConfig?.apiKey || ''

  const keyPrompt = existingKey
    ? `Enter API Key for ${provider} (leave empty to keep existing key): `
    : `Enter API Key for ${provider}: `
  const apiKey = await promptSecretPromise(keyPrompt)

  const finalApiKey = apiKey || existingKey
  if (!finalApiKey) {
    console.log(chalk.yellow('Wizard cancelled: API key is required.'))
    return
  }

  const defaultBaseUrl = currentProviderConfig.baseUrl || ''
  const baseUrlPrompt = defaultBaseUrl
    ? `Enter Custom Base URL (optional) (type '-' to clear, current: ${defaultBaseUrl}): `
    : `Enter Custom Base URL (optional): `
  const baseUrl = await promptTextPromise(baseUrlPrompt, defaultBaseUrl)

  let finalBaseUrl: string | undefined = baseUrl ? baseUrl.trim() : undefined
  if (finalBaseUrl === '-') {
    finalBaseUrl = undefined
  }

  const providerModels = modelRegistry.filter(m => m.id.startsWith(provider + '/')).map(m => m.id)
  let modelId = ''
  if (providerModels.length > 0) {
    modelId = await chooseInteractivePromise('Select default model:', providerModels)
  } else {
    modelId = await promptTextPromise('Enter custom model ID', `${provider}/model-name`)
  }

  if (!modelId) {
    console.log(chalk.yellow('Wizard cancelled.'))
    return
  }

  configManager.setProviderConfig(provider, {
    apiKey: finalApiKey,
    baseUrl: finalBaseUrl
  })
  configManager.setDefaultModel(modelId)
  console.log(chalk.green(`\n✓ Configuration saved! Default model set to: ${chalk.bold(modelId)}`))
}
