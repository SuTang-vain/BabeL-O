import readline from 'node:readline'
import { stdin as input, stdout as output } from 'node:process'
import chalk from 'chalk'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { Command } from 'commander'
import { NexusClient } from '../NexusClient.js'
import {
  renderEvent,
  getChatPrompt,
  setActiveReadline,
  startSession,
  resumeSessionHistory,
  toggleTuiMode,
  stopSpinner
} from '../renderEvents.js'
import { renderWelcome } from '../welcome.js'
import { renderHelpPanel, renderCompactHelp } from '../helpPanel.js'
import { ConfigManager, DEFAULT_CONFIG_DIR } from '../../shared/config.js'
import { modelRegistry } from '../../providers/registry.js'
import { createId } from '../../shared/id.js'
import { NexusEvent } from '../../shared/events.js'
import { runSessionFlow } from '../runSessionFlow.js'
import {
  chooseInteractive,
  promptSecret,
  promptText,
  pickCompletionChoice,
  mapDropdownSelection
} from '../ui.js'
import {
  makeCompleter,
  createSlashPalette,
  getToolCompletionChoices
} from '../completer.js'
import { inputState } from '../inputState.js'
import type { ContextAnalysis } from '../../runtime/contextAnalysis.js'

interface ReadlineInternal extends readline.Interface {
  history: string[]
  line: string
  _refreshLine?: () => void
}

export function registerChatCommand(program: Command): void {
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

      const completer = makeCompleter(options.cwd)

      const rl = readline.createInterface({
        input,
        output,
        completer,
        historySize: 1000,
        removeHistoryDuplicates: true
      })

      const rlInt = rl as ReadlineInternal
      rlInt.history = history
      setActiveReadline(rl)

      let activeAbortController: AbortController | null = null
      let isExecuting = false
      const slashPalette = createSlashPalette(rl)
      let sessionId = ''

      const closeCurrentSession = async (reason: string): Promise<void> => {
        if (!sessionId) return
        try {
          if (options.url) {
            await new NexusClient({ baseUrl: options.url }).closeSession(sessionId, {
              reason,
            })
          } else {
            const { SqliteStorage } = await import('../../storage/SqliteStorage.js')
            const { closeNexusSession } = await import('../../nexus/sessionLifecycle.js')
            const storagePath = path.join(DEFAULT_CONFIG_DIR, 'db.sqlite')
            if (!fs.existsSync(storagePath)) return
            const storage = new SqliteStorage(storagePath)
            try {
              await closeNexusSession({
                storage,
                sessionId,
                reason,
              })
            } finally {
              await storage.close?.()
            }
          }
        } catch {
          // Best-effort cleanup only. Chat exit must remain fast and reliable.
        }
      }

      const executeSessionFlow = async (command: string, abortController: AbortController) => {
        activeAbortController = abortController
        isExecuting = true
        inputState.set('agentRunning')
        startSession()
        const wasRaw = process.stdin.isTTY ? process.stdin.isRaw : false
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(true)
        }
        try {
          await runSessionFlow(command, options.cwd, options.url, rl, abortController, sessionId)
        } catch (e: any) {
          if (e.message !== 'Aborted' && e.name !== 'AbortError') {
            console.error(chalk.red(`Error: ${e.message || e}`))
          }
        } finally {
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(wasRaw)
          }
          activeAbortController = null
          isExecuting = false
          inputState.set('idle')
          stopSpinner()
        }
      }

      const showContextAnalysis = async () => {
        const modelId = ConfigManager.getInstance().resolveSettings().modelId
        let analysis: ContextAnalysis
        if (options.url) {
          analysis = await new NexusClient({ baseUrl: options.url }).analyzeContext(sessionId, {
            modelId,
            cwd: options.cwd,
          }) as ContextAnalysis
        } else {
          const storagePath = path.join(DEFAULT_CONFIG_DIR, 'db.sqlite')
          if (!fs.existsSync(storagePath)) {
            console.log(chalk.yellow('No local storage found for context analysis.'))
            return
          }
            const { SqliteStorage } = await import('../../storage/SqliteStorage.js')
            const { createDefaultToolRegistry } = await import('../../tools/registry.js')
            const { analyzeContext } = await import('../../runtime/contextAnalysis.js')
            const { buildSystemPrompt, mapEventsToMessages } = await import('../../runtime/LLMCodingRuntime.js')
            const storage = new SqliteStorage(storagePath)
          try {
            const session = await storage.getSession(sessionId, { includeEvents: false })
            if (!session) {
              console.log(chalk.yellow(`Session not found: ${sessionId}`))
              return
            }
            const { events } = await storage.listEvents(sessionId, {
              limit: 10_000,
              order: 'asc',
            })
            const tools = [...createDefaultToolRegistry().values()].map(tool => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.modelInputSchema ?? {},
            }))
            analysis = await analyzeContext({
              runtimeOptions: {
                sessionId,
                prompt: session.lastUserInput ?? session.prompt,
                cwd: session.cwd,
              },
              events,
              modelId,
              buildSystemPrompt,
              mapEventsToMessages,
              tools,
            })
          } finally {
            await storage.close?.()
          }
        }
        console.log(formatContextAnalysis(analysis))
      }

      const onGlobalKeypress = (chunk: any, key: any) => {
        // Route to slash palette only when idle (not when permission panel is open)
        if (!isExecuting && inputState.current !== 'permissionPanel' && slashPalette.handleKey(chunk, key)) {
          return
        }
        // When an overlay is open, only allow Ctrl+C and Escape to pass through
        if (inputState.isOverlayOpen()) {
          if (key?.ctrl && key.name === 'c') {
            // Let the overlay or SIGINT handler deal with it
          } else if (key?.name === 'escape' || chunk === '\x1b' || chunk === '\u001b') {
            // Overlay should handle escape itself; do not process globally
            return
          } else if (!isExecuting) {
            // Block other keys when overlay is open to prevent input pollution
            return
          }
        }
        if (key) {
          if (key.ctrl && key.name === 'o') {
            if (inputState.isOverlayOpen()) return
            // Clear readline prompt line
            process.stdout.write('\r\x1b[K')
            // Toggle TUI mode and redraw session
            toggleTuiMode()
            // Refresh prompt if not executing
            if (!isExecuting) {
              if (typeof rlInt._refreshLine === 'function') {
                rlInt._refreshLine()
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
              void closeCurrentSession('CLI interrupted').finally(() => process.exit(0))
            }
            return
          }
          if (key.name === 'escape') {
            if (isExecuting && activeAbortController) {
              activeAbortController.abort()
              console.log(chalk.yellow('\nExecution cancelled by user (ESC key).'))
              return
            }
          }
        } else if (chunk === '\x1b' || chunk === '\u001b') {
          if (isExecuting && activeAbortController) {
            activeAbortController.abort()
            console.log(chalk.yellow('\nExecution cancelled by user (ESC key).'))
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
          void closeCurrentSession('CLI interrupted').finally(() => process.exit(0))
        }
      })

      renderWelcome({ cwd: options.cwd, url: options.url })

      sessionId = options.session ?? createId('session')
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
              const { SqliteStorage } = await import('../../storage/SqliteStorage.js')
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
            // Readline logic wrapper to ask input with custom bbl prompt
            prompt = await new Promise<string>((resolve) => {
              rl.question(getChatPrompt(), resolve)
            })
          } catch (e: any) {
            if (e.name === 'AbortError') {
              continue
            }
            throw e
          }

          const trimmed = prompt.trim()
          if (trimmed === '/exit' || trimmed === 'exit' || trimmed === 'quit') {
            await closeCurrentSession('CLI exit')
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
            process.stdout.write(renderHelpPanel('full'))
            continue
          }

          if (trimmed === '/?' || trimmed === '/shortcuts') {
            process.stdout.write(renderHelpPanel('compact'))
            continue
          }

          if (trimmed === '/context') {
            try {
              await showContextAnalysis()
            } catch (e: any) {
              console.error(chalk.red(`Failed to analyze context: ${e.message || e}`))
            }
            continue
          }

          if (trimmed === '/compact') {
            try {
              if (options.url) {
                const client = new NexusClient({ baseUrl: options.url })
                const modelId = ConfigManager.getInstance().resolveSettings().modelId
                const result = await client.compactSession(sessionId, {
                  modelId,
                  trigger: 'manual',
                })
                console.log(chalk.green(`✓ Compacted session ${sessionId}`))
                console.log(JSON.stringify(result, null, 2))
              } else {
                const storagePath = path.join(DEFAULT_CONFIG_DIR, 'db.sqlite')
                if (!fs.existsSync(storagePath)) {
                  console.log(chalk.yellow('No local storage found to compact.'))
                } else {
                  const { SqliteStorage } = await import('../../storage/SqliteStorage.js')
                  const { compactSession } = await import('../../runtime/compact.js')
                  const { mapEventsToMessages } = await import('../../runtime/LLMCodingRuntime.js')
                  const storage = new SqliteStorage(storagePath)
                  try {
                    const modelId = ConfigManager.getInstance().resolveSettings().modelId
                    const result = await compactSession({
                      storage,
                      sessionId,
                      modelId,
                      trigger: 'manual',
                      mapEventsToMessages,
                    })
                    console.log(chalk.green(`✓ Compacted session ${sessionId}`))
                    console.log(JSON.stringify(result, null, 2))
                  } finally {
                    await storage.close?.()
                  }
                }
              }
            } catch (e: any) {
              console.error(chalk.red(`Failed to compact session: ${e.message || e}`))
            }
            continue
          }

          if (trimmed === '/tool' || trimmed === '/tools') {
            const selected = await pickCompletionChoice(getToolCompletionChoices())
            if (selected) {
              const mapped = mapDropdownSelection(selected)
              console.log(chalk.dim(`Inserted: ${mapped.trim()}`))
              const abortController = new AbortController()
              await executeSessionFlow(mapped.trim(), abortController)
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

          if (trimmed.startsWith('/profile')) {
            const configManager = ConfigManager.getInstance()
            if (trimmed === '/profile') {
              const profiles = configManager.getProfiles()
              const activeProfile = configManager.getActiveProfile()
              console.log(chalk.cyan('\n--- BabeL-O Configuration Profiles ---'))
              const keys = Object.keys(profiles)
              if (keys.length === 0) {
                console.log(chalk.yellow('No profiles configured.'))
                console.log(`Use ${chalk.bold('/profile add <name>')} to save your current settings to a profile.`)
              } else {
                for (const name of keys) {
                  const isActive = name === activeProfile
                  const prof = profiles[name]
                  const prefix = isActive ? chalk.bold.green('* ') : '  '
                  const nameStr = isActive ? chalk.bold.green(name) : name
                  console.log(`${prefix}${nameStr}`)
                  if (prof.model) console.log(`    model:    ${chalk.yellow(prof.model)}`)
                  if (prof.provider) console.log(`    provider: ${chalk.white(prof.provider)}`)
                  if (prof.baseUrl) console.log(`    baseUrl:  ${chalk.dim(prof.baseUrl)}`)
                }
              }
              if (!activeProfile) {
                console.log(chalk.dim('\nNo profile active. Using default configuration settings.'))
              } else {
                console.log(chalk.green(`\nActive profile: "${activeProfile}"`))
              }
              console.log()
            } else {
              const arg = trimmed.slice('/profile'.length).trim()
              if (arg === 'clear') {
                configManager.setActiveProfile(undefined)
                console.log(chalk.green('✓ Active profile cleared. Now using default settings.'))
              } else if (arg.startsWith('add')) {
                const name = arg.slice('add'.length).trim()
                if (!name) {
                  console.error(chalk.red('Error: Please specify a name for the profile (e.g. /profile add my-profile).'))
                } else {
                  const settings = configManager.resolveSettings()
                  configManager.setProfile(name, {
                    model: settings.modelId,
                    provider: settings.providerId,
                    apiKey: settings.apiKey,
                    baseUrl: settings.baseUrl,
                  })
                  configManager.setActiveProfile(name)
                  console.log(chalk.green(`✓ Profile "${name}" created from current settings and set as active.`))
                }
              } else {
                const name = arg
                const profiles = configManager.getProfiles()
                if (!profiles[name]) {
                  const settings = configManager.resolveSettings()
                  configManager.setProfile(name, {
                    model: settings.modelId,
                    provider: settings.providerId,
                    apiKey: settings.apiKey,
                    baseUrl: settings.baseUrl,
                  })
                  console.log(chalk.green(`✓ Profile "${name}" created with current settings.`))
                }
                configManager.setActiveProfile(name)
                console.log(chalk.green(`✓ Active profile set to: "${name}"`))
              }
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
                const { SqliteStorage } = await import('../../storage/SqliteStorage.js')
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
                  await executeSessionFlow(cmdToRun, abortController)
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
          await executeSessionFlow(trimmed, abortController)
        }
      } finally {
        cleanupListeners()
        rl.close()
      }
    })
}

function formatContextAnalysis(analysis: ContextAnalysis): string {
  const lines: string[] = []
  const windowColor = analysis.window.isBlocking
    ? chalk.red
    : analysis.window.isWarning
      ? chalk.yellow
      : chalk.green
  lines.push(chalk.cyan('\n--- Context Analysis ---'))
  lines.push(`Session: ${chalk.dim(analysis.sessionId)}`)
  lines.push(`Model:   ${chalk.yellow(analysis.modelId)}`)
  lines.push(`CWD:     ${chalk.white(analysis.cwd)}`)
  lines.push(
    `Tokens:  ${windowColor(`${analysis.estimate.totalTokens}/${analysis.window.maxTokens}`)} ` +
    chalk.dim(`(${analysis.window.percentUsed}%, warn ${analysis.window.warningThresholdTokens}, block ${analysis.window.blockingLimitTokens})`),
  )
  lines.push('')
  lines.push(chalk.bold('Sections'))
  lines.push(`  system prompt:   ${analysis.sections.systemPromptChars} chars`)
  lines.push(`  project memory:  ${analysis.sections.projectMemoryChars} chars`)
  lines.push(`  session summary: ${analysis.sections.sessionSummaryChars} chars`)
  lines.push(`  active skills:   ${analysis.sections.activeSkillsChars} chars`)
  lines.push(`  messages:        ${analysis.sections.messageCount}`)
  lines.push(`  events:          selected ${analysis.sections.selectedEventCount}, omitted ${analysis.sections.omittedEventCount}, snipped ${analysis.sections.snippedEventCount}`)
  lines.push(`  tool schemas:    ${analysis.sections.toolDefinitionCount}`)
  lines.push('')
  lines.push(chalk.bold('Compact'))
  if (analysis.compact.hasBoundary) {
    lines.push(`  boundary:        ${chalk.green('yes')} (${analysis.compact.trigger})`)
    lines.push(`  retained events: ${analysis.compact.retainedEventCount}`)
    lines.push(`  retained check:  ${
      analysis.compact.retainedSegmentValid
        ? chalk.green('valid')
        : chalk.red('invalid')
    }`)
    if (analysis.compact.retainedSegmentWarning) {
      lines.push(`  retained warn:   ${chalk.yellow(analysis.compact.retainedSegmentWarning)}`)
    }
    lines.push(`  event counts:    ${analysis.compact.beforeEventCount} -> ${analysis.compact.afterEventCount}`)
  } else {
    lines.push(`  boundary:        ${chalk.yellow('no')}`)
  }
  lines.push('')
  lines.push(chalk.bold('Post-Compact State'))
  lines.push(`  read files:      ${formatList(analysis.postCompactState.recentReadFiles)}`)
  lines.push(`  recent tools:    ${formatList(analysis.postCompactState.activeToolNames)}`)
  lines.push(`  active skills:   ${formatList(analysis.postCompactState.activeSkills)}`)
  lines.push(`  agent/tasks:     ${formatList(analysis.postCompactState.taskStatusLines)}`)
  lines.push(`  hooks:           ${formatList(analysis.postCompactState.hookLines)}`)
  lines.push('')
  lines.push(chalk.bold('Recommendations'))
  for (const recommendation of analysis.recommendations) {
    lines.push(`  - ${recommendation}`)
  }
  lines.push('')
  return lines.join('\n')
}

function formatList(values: string[]): string {
  if (values.length === 0) return chalk.dim('none')
  return values.join(', ')
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

  const providers = ['anthropic', 'openai', 'deepseek', 'zhipu', 'minimax', 'local']
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
