import readline from 'node:readline'
import { stdin as input, stdout as output } from 'node:process'
import chalk from 'chalk'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { Command } from 'commander'
import { NexusClient } from '../NexusClient.js'
import { createEmbeddedNexusClient } from '../embedded.js'
import {
  renderEvent,
  getChatPrompt,
  setActiveReadline,
  startSession,
  startAgentStatus,
  resumeSessionHistory,
  toggleTuiMode,
  stopAgentStatus,
  stopSpinner,
  redrawSession,
  formatMultiAgentStatusView,
  getSessionEvents
} from '../renderEvents.js'
import { formatSessionBanner, renderWelcome } from '../welcome.js'
import { renderHelpPanel, renderCompactHelp } from '../helpPanel.js'
import { ConfigManager, DEFAULT_CONFIG_DIR } from '../../shared/config.js'
import { getProvider, modelRegistry, providerRegistry } from '../../providers/registry.js'
import { type SessionHintState } from '../promptSuggestions.js'
import { runProviderLiveSmoke, runProviderSmokeDryRun } from '../../runtime/providerSmoke.js'
import { buildProviderFallbackPolicy, planProviderFallbackAction, type ProviderRecoveryKind } from '../../runtime/providerRecovery.js'
import { createId } from '../../shared/id.js'
import { NexusEvent } from '../../shared/events.js'
import type { NexusTask } from '../../shared/task.js'
import { runSessionFlow } from '../runSessionFlow.js'
import { formatSessionAck, formatSessionInbox, formatSessionsList, formatSessionsTree, loadSessionRelationshipSummary } from './sessions.js'
import {
  chooseInteractive,
  promptSecret,
  promptText,
  pickCompletionChoice,
  mapDropdownSelection,
  getAutosuggestion,
  renderSubmittedPrompt,
  setupAutosuggestions
} from '../ui.js'
import {
  makeCompleter,
  createSlashPalette,
  getToolCompletionChoices
} from '../completer.js'
import { inputState } from '../inputState.js'
import { openExternalEditor } from '../editor.js'
import { normalizeKeyEvent, terminalMouseDisableSequence } from '../keyEvent.js'
import { consumePasteChunk, createPasteBufferState, expandPastedTextPlaceholders, flushPasteBuffer, formatPastedTextPlaceholder } from '../pasteBuffer.js'
import { INPUT_NEWLINE_MARKER, restoreInputNewlines, shouldClearInputGhostBeforeWrite, shouldConsumeBlankInputEnter } from '../inputBox.js'
import { openContextView } from '../contextView.js'
import { formatToolAudit } from '../toolAuditFormatter.js'
import { expandAttachmentReferences } from '../attachmentReferences.js'
import { createVimInputState, reduceVimInputKey } from '../vimMode.js'
import { formatInboxFooterStatus, openInboxOverlay, renderInboxEventCard, shouldRenderInboxEventCard, type InboxChannelSummary } from '../inboxOverlay.js'
import { formatActivityFeed, openActivityOverlay, type ActivityItem } from '../activityOverlay.js'
import { formatChannelGraph } from '../channelGraph.js'
import { channelSendUsage, createChannelSendDraft, formatChannelSendCreated, formatChannelSendPreview, parseChannelSendCommand, resolveInboxReplyDraftTarget, type ChannelSendDraft } from '../channelSend.js'
import { openCollaborateOverlay } from '../collaborateOverlay.js'
import type { SessionMessage } from '../../shared/sessionChannel.js'

interface ReadlineInternal extends readline.Interface {
  history: string[]
  line: string
  _refreshLine?: () => void
}

export function registerChatCommand(program: Command): void {
  program
    .command('chat [mode]')
    .description('Start an interactive Nexus-backed chat loop')
    .option('--url <url>', 'Use a running Nexus service instead of embedded mode')
    .option('--cwd <path>', 'Workspace directory', process.env.BABEL_O_LAUNCH_CWD ?? process.cwd())
    .option('--session <id>', 'Resume an existing session ID')
    .action(async (mode: string | undefined, options: { url?: string; cwd: string; session?: string }) => {
      const isDevMode = mode === 'dev'
      if (mode && !isDevMode) {
        console.error(chalk.red(`Error: unknown chat mode "${mode}". Did you mean \`bbl chat dev\`?`))
        process.exitCode = 1
        return
      }

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

      if (!input.isTTY || !output.isTTY) {
        console.error(chalk.red('Error: bbl chat requires an interactive terminal. Use `bbl run "<prompt>"` for non-interactive prompts.'))
        process.exitCode = 1
        return
      }

      const rl = readline.createInterface({
        input,
        output,
        completer,
        historySize: 1000,
        removeHistoryDuplicates: true,
        escapeCodeTimeout: 50,
      })

      input.resume()
      // SEA idle readline can otherwise leave no active event-loop handle.
      const chatKeepAlive = setInterval(() => {}, 60_000)

      const rlInt = rl as ReadlineInternal
      rlInt.history = history
      setActiveReadline(rl)

      let activeAbortController: AbortController | null = null
      let isExecuting = false

      const isExecutingRef = { get current() { return isExecuting } }
      const sessionHintRef: { current: SessionHintState } = {
        current: { hasSession: false },
      }
      const footerStatusRef: { current?: string } = {}
      let inboxMessages: SessionMessage[] = []
      let inboxChannels: InboxChannelSummary[] = []
      const renderedInboxEventCardMessageIds = new Set<string>()
      rl.setPrompt(getChatPrompt())
      const inputRefresh = setupAutosuggestions(rl, history, isExecutingRef, sessionHintRef, footerStatusRef)
      const slashPalette = createSlashPalette(rl, {
        clearInputBlock: () => inputRefresh.clearCurrentInputBlock(),
      })
      let sessionId = ''
      const localStoragePath = path.join(DEFAULT_CONFIG_DIR, 'db.sqlite')
      const embeddedClient = () => createEmbeddedNexusClient({
        cwd: options.cwd,
        storagePath: localStoragePath,
        allowedTools: ['*'],
        enableMcp: process.env.BABEL_O_ENABLE_MCP === '1',
      })

      // Enable bracketed paste mode
      process.stdout.write('\x1b[?2004h')

      // Keep terminal mouse reporting disabled so wheel/touchpad gestures scroll the native scrollback.
      process.stdout.write(terminalMouseDisableSequence())

      const originalEmit = process.stdin.emit
      let pasteState = createPasteBufferState()
      let pasteTimeout: NodeJS.Timeout | null = null
      let pastedTextCounter = 0
      const pastedTextReplacements = new Map<string, string>()
      let vimInputState = createVimInputState()
      let queuedPromptPrefill = ''
      let pendingChannelSendDraft: ChannelSendDraft | null = null

      const clearPasteTimeout = () => {
        if (pasteTimeout) {
          clearTimeout(pasteTimeout)
          pasteTimeout = null
        }
      }

      const handlePastedText = (text: string) => {
        if (!text) return

        if (!text.includes('\n') && !text.includes('\r')) {
          rl.write(text)
          return
        }

        const placeholder = formatPastedTextPlaceholder(++pastedTextCounter, text)
        pastedTextReplacements.set(placeholder, text)
        rl.write(placeholder)
      }

      const insertInputText = (text: string) => {
        if (!text) return
        const currentLine = rlInt.line ?? ''
        const cursor = typeof (rlInt as any).cursor === 'number' ? (rlInt as any).cursor : currentLine.length
        rlInt.line = `${currentLine.slice(0, cursor)}${text}${currentLine.slice(cursor)}`
        ;(rlInt as any).cursor = cursor + text.length
        rlInt._refreshLine?.()
      }

      const insertInputNewline = () => {
        insertInputText(INPUT_NEWLINE_MARKER)
      }

      const consumeShiftEnterInput = (text: string): boolean => {
        const shiftEnterPattern = /\x1b\[13;2u|\x1b\[27;2;13~/g
        if (!shiftEnterPattern.test(text)) return false
        shiftEnterPattern.lastIndex = 0
        let lastIndex = 0
        for (const match of text.matchAll(shiftEnterPattern)) {
          const index = match.index ?? 0
          const before = text.slice(lastIndex, index)
          insertInputText(before)
          insertInputNewline()
          lastIndex = index + match[0].length
        }
        const after = text.slice(lastIndex)
        insertInputText(after)
        return true
      }

      process.stdin.emit = function (event: string, ...args: any[]) {
        if (event === 'data') {
          const chunk = args[0]
          const str = chunk ? chunk.toString() : ''

          // If an external terminal mode still emits mouse reports, do not let them reach readline.
          if (
            /^\x1b\[<[\d;]+[Mm]/.test(str) ||
            (str.startsWith('\x1b[M') && str.length >= 6) ||
            /^\x1b\[[\d;]+[Mm]/.test(str)
          ) {
            return true
          }

          if (!isExecuting) {
            const keyEvent = normalizeKeyEvent(chunk, undefined)
            if (keyEvent.kind === 'ctrl_c') {
              pasteState = createPasteBufferState()
              clearPasteTimeout()
              return originalEmit.apply(this, [event, ...args] as any)
            }

            if (inputState.current === 'idle' && keyEvent.kind === 'shift_enter') {
              insertInputNewline()
              return true
            }

            if (inputState.current === 'idle' && consumeShiftEnterInput(str)) return true

            if (inputState.current === 'idle') {
              const vimResult = reduceVimInputKey(
                vimInputState,
                rlInt.line ?? '',
                typeof (rlInt as any).cursor === 'number' ? (rlInt as any).cursor : (rlInt.line ?? '').length,
                keyEvent,
              )
              vimInputState = vimResult.state
              if (vimResult.handled) {
                rlInt.line = vimResult.line
                ;(rlInt as any).cursor = vimResult.cursor
                rlInt._refreshLine?.()
                return true
              }
            }

            if (inputState.current === 'idle' && shouldConsumeBlankInputEnter(rlInt.line ?? '', keyEvent.kind)) {
              if (typeof rlInt._refreshLine === 'function') {
                rlInt._refreshLine()
              } else {
                rl.prompt()
              }
              return true
            }

            if (inputState.current === 'idle' && shouldClearInputGhostBeforeWrite(rlInt.line ?? '', str)) {
              rlInt._refreshLine?.()
            }

            const pasteResult = consumePasteChunk(pasteState, str)
            pasteState = pasteResult.state
            if (pasteResult.pastedText !== undefined) {
              clearPasteTimeout()
              handlePastedText(pasteResult.pastedText)
            } else if (pasteState.isPasting && !pasteTimeout) {
              pasteTimeout = setTimeout(() => {
                const flushed = flushPasteBuffer(pasteState)
                pasteState = flushed.state
                pasteTimeout = null
                if (flushed.pastedText !== undefined) {
                  handlePastedText(flushed.pastedText)
                }
              }, 1000)
            }
            if (pasteResult.consumed) return true
          } // end !isExecuting
        }

        if (!isExecuting && event === 'keypress' && pasteState.isPasting) {
          return true
        }

        return originalEmit.apply(this, [event, ...args] as any)
      }

      const closeCurrentSession = async (reason: string): Promise<void> => {
        if (!sessionId) return
        try {
          const client = options.url
            ? new NexusClient({ baseUrl: options.url })
            : embeddedClient()
          if (!options.url && !fs.existsSync(localStoragePath)) return
          await client.closeSession(sessionId, { reason })
        } catch {
          // Best-effort cleanup only. Chat exit must remain fast and reliable.
        }
      }

      const executeSessionFlow = async (command: string, abortController: AbortController) => {
        activeAbortController = abortController
        isExecuting = true
        inputState.set('agentRunning')
        startSession()
        startAgentStatus('working')
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
          updateSessionHint()
          await refreshInboxFooterStatus({ renderEventCards: true })
        }
      }

      const showMockAgentLoopSmoke = async () => {
        isExecuting = true
        inputState.set('agentRunning')
        startSession()
        startAgentStatus('working')
        try {
          for (const event of createMockAgentLoopTuiSmokeEvents(sessionId, options.cwd)) {
            renderEvent(event)
            await new Promise(resolve => setTimeout(resolve, 20))
          }
          stopAgentStatus()
          redrawSession()
          console.log(chalk.green('✓ AgentLoop sub-agent TUI smoke completed'))
        } finally {
          stopAgentStatus()
          inputState.set('idle')
          isExecuting = false
        }
      }

      const loadEmbeddedToolAudit = async () => {
        return embeddedClient().auditTools()
      }

      const showContextAnalysis = async () => {
        const modelId = ConfigManager.getInstance().resolveSettings().modelId
        const client = options.url
          ? new NexusClient({ baseUrl: options.url })
          : embeddedClient()
        if (!options.url && !fs.existsSync(localStoragePath)) {
          console.log(chalk.yellow('No local storage found for context analysis.'))
          return
        }
        const analysis = await client.analyzeContext(sessionId, {
          modelId,
          cwd: options.cwd,
        }) as Parameters<typeof openContextView>[0]
        await openContextView(analysis)
      }

      const showMultiAgentStatus = async () => {
        const client = options.url
          ? new NexusClient({ baseUrl: options.url })
          : embeddedClient()
        if (!options.url && !fs.existsSync(localStoragePath)) {
          console.log(formatMultiAgentStatusView({ sessionId, jobs: [], events: [] }))
          return
        }
        const [agentResponse, eventResponse] = await Promise.all([
          client.listSessionAgents(sessionId),
          client.listSessionEvents(sessionId, { limit: 200, order: 'asc' }) as Promise<{ events?: NexusEvent[] }>,
        ])
        console.log(formatMultiAgentStatusView({
          sessionId,
          jobs: agentResponse.jobs,
          events: eventResponse.events ?? [],
        }))
      }

      const loadSessionInboxSnapshot = async (includeAcknowledged = false): Promise<{
        messages: SessionMessage[]
        channels: InboxChannelSummary[]
      }> => {
        if (!options.url && !fs.existsSync(localStoragePath)) {
          return { messages: [], channels: [] }
        }
        const client = options.url
          ? new NexusClient({ baseUrl: options.url })
          : embeddedClient()
        const inbox = await client.listSessionInbox(sessionId, {
          limit: 20,
          includeAcknowledged,
        })
        let channels: InboxChannelSummary[] = []
        try {
          const channelResponse = await client.listSessionChannels({ sessionId, limit: 100 })
          channels = channelResponse.channels
        } catch {
          channels = []
        }
        return { messages: inbox.messages, channels }
      }

      const loadSessionActivitySnapshot = async (): Promise<ActivityItem[]> => {
        if (!options.url && !fs.existsSync(localStoragePath)) return []
        const client = options.url
          ? new NexusClient({ baseUrl: options.url })
          : embeddedClient()
        let channels: InboxChannelSummary[] = []
        try {
          channels = (await client.listSessionChannels({ sessionId, limit: 100 })).channels
        } catch {
          channels = []
        }
        const messagesByChannel = await Promise.all(channels.map(async channel => {
          try {
            return (await client.listSessionMessages(channel.channelId, { limit: 20, order: 'desc' })).messages.map((message: SessionMessage) => ({ message, channel }))
          } catch {
            return []
          }
        }))
        return messagesByChannel.flat()
          .sort((left, right) => right.message.createdAt.localeCompare(left.message.createdAt) || right.message.messageId.localeCompare(left.message.messageId))
          .slice(0, 20)
      }

      const showSessionActivity = async () => {
        const items = await loadSessionActivitySnapshot()
        if (!process.stdin.isTTY) {
          console.log(formatActivityFeed({ sessionId, items, limit: 20 }))
          return { type: 'closed' as const }
        }
        return openActivityOverlay({ sessionId, items })
      }

      const showCollaborateOverlay = async () => {
        if (!options.url && !fs.existsSync(localStoragePath)) {
          console.log(chalk.yellow('No local storage found for collaboration view.'))
          return
        }
        const client = options.url
          ? new NexusClient({ baseUrl: options.url })
          : embeddedClient()
        const [snapshot, channelResponse, agentResponse, sessionResponse] = await Promise.all([
          loadSessionInboxSnapshot(false),
          client.listSessionChannels({ sessionId, limit: 100 }).catch(() => ({ channels: [] })),
          client.listSessionAgents(sessionId).catch(() => ({ jobs: [] })),
          client.getSession(sessionId, { recentEventLimit: 0 }).catch(() => undefined),
        ])
        const phase = (sessionResponse as { session?: { phase?: string } } | undefined)?.session?.phase
        if (!process.stdin.isTTY) {
          console.log(`Collaborate from: ${sessionId}${phase ? `:${phase}` : ''}`)
          console.log(`Inbox: ${snapshot.messages.length} unread`)
          console.log(`Channels: ${channelResponse.channels.length} active`)
          console.log(`Agents: ${agentResponse.jobs.length} jobs`)
          return
        }
        const result = await openCollaborateOverlay({
          sessionId,
          sessionPhase: phase,
          inboxUnreadCount: snapshot.messages.length,
          messages: snapshot.messages,
          channels: channelResponse.channels,
          agentCount: agentResponse.jobs.length,
        })
        if (result.type === 'channel_message_preview') {
          const draft = createChannelSendDraft({
            command: result.command,
            channelId: result.channel.channelId,
            fromSessionId: sessionId,
            toSessionId: result.target.kind === 'session' ? result.target.sessionId : undefined,
            broadcast: result.target.kind === 'broadcast',
            type: result.messageType,
            priority: result.priority,
            content: result.content,
            replyToMessageId: result.replyToMessageId,
          })
          pendingChannelSendDraft = draft
          console.log(formatChannelSendPreview(draft, { channel: result.channel, columns: process.stdout.columns ?? 100 }))
          return
        }
        if (result.type !== 'open') return
        if (result.entry.kind === 'agents') {
          await showMultiAgentStatus()
        }
      }

      const markInboxEventCardsSeen = (messages: SessionMessage[]) => {
        for (const message of messages) {
          if (shouldRenderInboxEventCard(message)) renderedInboxEventCardMessageIds.add(message.messageId)
        }
      }

      const renderNewInboxEventCards = (messages: SessionMessage[], channels: InboxChannelSummary[]) => {
        const channelMap = new Map(channels.map(channel => [channel.channelId, channel] as const))
        for (const message of messages) {
          if (renderedInboxEventCardMessageIds.has(message.messageId)) continue
          if (!shouldRenderInboxEventCard(message)) continue
          renderedInboxEventCardMessageIds.add(message.messageId)
          process.stdout.write(`\n${renderInboxEventCard(message, {
            channel: channelMap.get(message.channelId),
            columns: process.stdout.columns ?? 80,
          })}\n`)
        }
      }

      const refreshInboxFooterStatus = async (options: { renderEventCards?: boolean; markEventCardsSeen?: boolean } = {}) => {
        try {
          const snapshot = await loadSessionInboxSnapshot(false)
          inboxMessages = snapshot.messages
          inboxChannels = snapshot.channels
          footerStatusRef.current = formatInboxFooterStatus({
            sessionId,
            messages: inboxMessages,
            channels: inboxChannels,
          }) || undefined
          if (options.markEventCardsSeen) markInboxEventCardsSeen(inboxMessages)
          if (options.renderEventCards) renderNewInboxEventCards(inboxMessages, inboxChannels)
        } catch {
          inboxMessages = []
          inboxChannels = []
          footerStatusRef.current = undefined
        }
      }

      const showSessionInbox = async (includeAcknowledged = false) => {
        const snapshot = await loadSessionInboxSnapshot(includeAcknowledged)
        inboxMessages = includeAcknowledged ? inboxMessages : snapshot.messages
        inboxChannels = snapshot.channels
        footerStatusRef.current = formatInboxFooterStatus({
          sessionId,
          messages: includeAcknowledged ? inboxMessages : snapshot.messages,
          channels: snapshot.channels,
        }) || undefined
        if (!process.stdin.isTTY) {
          console.log(formatSessionInbox({
            type: 'session_inbox',
            sessionId,
            messages: snapshot.messages,
            limit: 20,
            includeAcknowledged,
          }))
          return { type: 'closed' as const }
        }
        return openInboxOverlay({
          sessionId,
          messages: snapshot.messages,
          channels: snapshot.channels,
          includeAcknowledged,
        })
      }

      const ackSessionInboxMessage = async (messageId: string) => {
        if (!messageId) {
          console.log(chalk.yellow('Usage: /inbox ack <messageId>'))
          return
        }
        const client = options.url
          ? new NexusClient({ baseUrl: options.url })
          : embeddedClient()
        if (!options.url && !fs.existsSync(localStoragePath)) {
          console.log(chalk.yellow('No local storage found for inbox ack.'))
          return
        }
        console.log(formatSessionAck(await client.ackSessionMessage(sessionId, messageId)))
        await refreshInboxFooterStatus()
      }

      const previewChannelSendCommand = async (line: string) => {
        if (!options.url && !fs.existsSync(localStoragePath)) {
          console.log(chalk.yellow('No local storage found for channel send.'))
          return
        }
        const parsed = parseChannelSendCommand(line)
        if (!parsed.ok) {
          console.log(chalk.yellow(parsed.error))
          console.log(chalk.dim(parsed.usage))
          return
        }
        const client = options.url
          ? new NexusClient({ baseUrl: options.url })
          : embeddedClient()
        const channelResponse = await client.listSessionChannels({ sessionId, limit: 100 })
        const channel = channelResponse.channels.find(candidate => candidate.channelId === parsed.draft.channelId)
        if (!channel) {
          console.log(chalk.yellow(`Current session is not a participant in channel: ${parsed.draft.channelId}`))
          return
        }
        let draft = createChannelSendDraft({ ...parsed.draft, fromSessionId: sessionId })
        if (draft.command === 'inbox_reply' && draft.replyToMessageId) {
          const replyMessage = (await client.listSessionMessages(draft.channelId, { limit: 100, order: 'desc' })).messages
            .find(message => message.messageId === draft.replyToMessageId)
          if (!replyMessage) {
            console.log(chalk.yellow(`Inbox reply message not found in channel: ${draft.replyToMessageId}`))
            return
          }
          draft = resolveInboxReplyDraftTarget(draft, replyMessage)
        }
        pendingChannelSendDraft = draft
        console.log(formatChannelSendPreview(draft, { channel, columns: process.stdout.columns ?? 100 }))
      }

      const confirmChannelSendCommand = async () => {
        if (!pendingChannelSendDraft) {
          console.log(chalk.yellow('No pending SessionChannel send preview.'))
          console.log(chalk.dim(channelSendUsage()))
          return
        }
        const client = options.url
          ? new NexusClient({ baseUrl: options.url })
          : embeddedClient()
        if (!options.url && !fs.existsSync(localStoragePath)) {
          console.log(chalk.yellow('No local storage found for channel send.'))
          return
        }
        const draft = pendingChannelSendDraft
        const created = await client.sendSessionMessage(draft.channelId, {
          fromSessionId: draft.fromSessionId,
          toSessionId: draft.toSessionId,
          broadcast: draft.broadcast,
          type: draft.type,
          content: draft.content,
          priority: draft.priority,
          metadata: draft.replyToMessageId
            ? { replyToMessageId: draft.replyToMessageId, source: draft.command }
            : { source: draft.command },
        })
        pendingChannelSendDraft = null
        console.log(formatChannelSendCreated(created.message, { columns: process.stdout.columns ?? 100 }))
        await refreshInboxFooterStatus()
      }

      const cancelChannelSendCommand = () => {
        pendingChannelSendDraft = null
        console.log(chalk.dim('Cancelled pending SessionChannel send.'))
      }

      const updateSessionHint = () => {
        const events = getSessionEvents()
        const turnCount = events.filter(e => e.type === 'user_message').length
        const lastEvent = events[events.length - 1]
        const tasks = events.filter(e => e.type === 'task_session_event' && (e as any).eventType === 'task_created')
        const failedTasks = events.filter(e => e.type === 'task_session_event' && (e as any).eventType === 'task_updated' && (e as any).payload?.task?.status === 'failed')
        const pendingTasks = tasks.length - failedTasks.length - events.filter(e => e.type === 'task_session_event' && (e as any).eventType === 'task_updated' && (e as any).payload?.task?.status === 'completed').length
        sessionHintRef.current = {
          hasSession: true,
          turnCount,
          lastEventType: lastEvent?.type,
          lastToolName: lastEvent?.type === 'tool_completed' ? (lastEvent as any).name : undefined,
          taskCount: tasks.length,
          failedTaskCount: failedTasks.length,
          pendingTaskCount: Math.max(0, pendingTasks),
          agentRunning: false,
        }
      }

      const onGlobalKeypress = (chunk: any, key: any) => {
        const isCtrlC = (key?.ctrl && key?.name === 'c') || chunk === '\x03' || chunk?.toString() === '\x03' || (typeof chunk === 'string' && chunk.charCodeAt(0) === 3)

        if (isCtrlC) {
          clearPasteTimeout()
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


        // Route to slash palette only when idle (not when permission panel is open)
        if (!isExecuting && inputState.current !== 'permissionPanel' && slashPalette.handleKey(chunk, key)) {
          return
        }

        // Handle accepting suggestion when right arrow or Ctrl+F is pressed
        if (!isExecuting && inputState.current === 'idle') {
          const suggestion = getAutosuggestion(rlInt.line, history)
          if (suggestion && (key?.name === 'right' || (key?.ctrl && key?.name === 'f'))) {
            rlInt.line = suggestion
            ;(rlInt as any).cursor = suggestion.length
            rlInt._refreshLine?.()
            return
          }
        }

        // Handle external editor mode via Ctrl+E when idle
        const isCtrlEWhenIdle = (!isExecuting && inputState.current === 'idle' && (
          (key?.ctrl && key?.name === 'e') || chunk === '\x05' || chunk?.toString() === '\x05' || (typeof chunk === 'string' && chunk.charCodeAt(0) === 5)
        ))
        if (isCtrlEWhenIdle) {
          const currentText = rlInt.line
          // Clear current readline visual line
          process.stdout.write('\r\x1b[K')

          rl.pause()
          void (async () => {
            try {
              const edited = await openExternalEditor(currentText, options.cwd)
              rl.resume()

              if (edited && edited.trim()) {
                const trimmedEdited = edited.trim()
                console.log(chalk.cyan(`\n[Editor] Loaded multi-line prompt (${trimmedEdited.split('\n').length} lines). Submitting...`))
                if (pendingLineResolve) {
                  pendingLineResolve(edited)
                }
              } else {
                // If it is empty or cancelled, go back to readline
                if (typeof rlInt._refreshLine === 'function') {
                  rlInt._refreshLine()
                } else {
                  rl.prompt()
                }
              }
            } catch (err: any) {
              console.error(chalk.red(`\nFailed to open editor: ${err.message || err}`))
              rl.resume()
              if (typeof rlInt._refreshLine === 'function') {
                rlInt._refreshLine()
              } else {
                rl.prompt()
              }
            }
          })()
          return
        }

        // When an overlay is open, only allow Escape to pass through (Ctrl+C is handled at the top)
        if (inputState.isOverlayOpen()) {
          if (key?.name === 'escape' || chunk === '\x1b' || chunk === '\u001b') {
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
        clearInterval(chatKeepAlive)
        slashPalette.dispose()
        process.stdin.removeListener('keypress', onGlobalKeypress)
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false)
        }
        process.stdout.write('\x1b[?2004l')        // Disable bracketed paste
        process.stdout.write(terminalMouseDisableSequence()) // Disable mouse tracking
        process.stdin.emit = originalEmit
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

      // Generate the session id BEFORE the welcome card so the
      // `session` field on the card shows the real id rather
      // than a `new session` placeholder. The card is then a
      // truthful snapshot of the runtime state at the moment
      // the user is dropped into the readline loop.
      sessionId = options.session ?? createId('session')

      renderWelcome({
        cwd: options.cwd,
        sessionId,
        url: options.url,
        title: isDevMode ? 'dev' : undefined,
      })

      if (options.session) {
        console.log(formatSessionBanner('resuming', sessionId))

        try {
          let events: NexusEvent[] = []
          const client = options.url
            ? new NexusClient({ baseUrl: options.url })
            : embeddedClient()
          if (options.url || fs.existsSync(localStoragePath)) {
            const res = (await client.listSessionEvents(sessionId, { limit: 100, order: 'asc' })) as { events: NexusEvent[] }
            events = res.events
          }

          if (events && events.length > 0) {
            resumeSessionHistory(events)
          }
        } catch (e: any) {
          console.error(chalk.yellow(`Warning: Failed to load session history: ${e.message || e}`))
        }
      } else {
        console.log(formatSessionBanner('started', sessionId))
      }

      let pendingLineResolve: ((val: string) => void) | null = null
      await refreshInboxFooterStatus({ markEventCardsSeen: true })

      try {
        for (;;) {
          let prompt: string
          try {
            // Readline logic wrapper to ask input with custom bbl prompt
            await refreshInboxFooterStatus()
            prompt = await new Promise<string>((resolve) => {
              pendingLineResolve = resolve
              rl.setPrompt(getChatPrompt())
              rl.question(getChatPrompt(), resolve)
              if (queuedPromptPrefill) {
                rlInt.line = queuedPromptPrefill
                ;(rlInt as any).cursor = queuedPromptPrefill.length
                queuedPromptPrefill = ''
                rlInt._refreshLine?.()
              }
            })
          } catch (e: any) {
            if (e.name === 'AbortError') {
              continue
            }
            throw e
          } finally {
            pendingLineResolve = null
          }

          const displayPrompt = restoreInputNewlines(prompt)
          prompt = expandPastedTextPlaceholders(restoreInputNewlines(prompt), pastedTextReplacements)
          let trimmed = prompt.trim()
          if (!trimmed.startsWith('/')) {
            prompt = expandAttachmentReferences(prompt, options.cwd).prompt
            trimmed = prompt.trim()
          }
          const displayTrimmed = displayPrompt.trim()
          inputRefresh.clearCurrentInputBlock({ afterSubmit: true })
          if (displayTrimmed) {
            process.stdout.write(renderSubmittedPrompt(displayTrimmed))
          }
          if (trimmed === '/exit' || trimmed === 'exit' || trimmed === 'quit') {
            await closeCurrentSession('CLI exit')
            break
          }
          if (!trimmed) {
            continue
          }

          if (trimmed === '/editor' || trimmed === '/e') {
            rl.pause()
            try {
              const edited = await openExternalEditor('', options.cwd)
              rl.resume()
              if (edited && edited.trim()) {
                prompt = edited
                trimmed = edited.trim()
                console.log(chalk.cyan(`\n[Editor] Loaded multi-line prompt (${trimmed.split('\n').length} lines). Submitting...`))
              } else {
                console.log(chalk.yellow('\nEditor input was empty or cancelled.'))
                continue
              }
            } catch (err: any) {
              console.error(chalk.red(`\nFailed to open editor: ${err.message || err}`))
              rl.resume()
              continue
            }
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

          if (trimmed === '/agentloop-smoke' || trimmed === '/agent-loop-smoke') {
            try {
              await showMockAgentLoopSmoke()
            } catch (e: any) {
              console.error(chalk.red(`Failed to render AgentLoop smoke: ${e.message || e}`))
            }
            continue
          }

          if (trimmed === '/compact') {
            startAgentStatus('compacting')
            try {
              const client = options.url
                ? new NexusClient({ baseUrl: options.url })
                : embeddedClient()
              if (!options.url && !fs.existsSync(localStoragePath)) {
                stopAgentStatus()
                console.log(chalk.yellow('No local storage found to compact.'))
                continue
              }
              const modelId = ConfigManager.getInstance().resolveSettings().modelId
              await client.compactSession(sessionId, {
                modelId,
                trigger: 'manual',
              })
              stopAgentStatus()
              console.log(chalk.green('✓ Context compacted'))
            } catch (e: any) {
              stopAgentStatus()
              console.error(chalk.red(`Failed to compact session: ${e.message || e}`))
            }
            continue
          }

          if (trimmed === '/tool' || trimmed === '/tools') {
            let selected = ''
            inputState.set('toolPalette')
            try {
              selected = await pickCompletionChoice(getToolCompletionChoices())
            } finally {
              if (inputState.current === 'toolPalette') {
                inputState.set('idle')
              }
            }
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
              inputState.set('modelWizard')
              try {
                await runModelConfigWizard()
              } catch (err: any) {
                console.error(chalk.red(`Wizard error: ${err.message || err}`))
              } finally {
                if (inputState.current === 'modelWizard') {
                  inputState.set('idle')
                }
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
                const stat = await client.status() as Record<string, unknown>
                const smoke = (stat.providerSmoke ?? await client.providerSmoke()) as Record<string, unknown>
                const audit = await client.auditTools()
                const { provider, providerSmoke: _providerSmoke, ...statusWithoutProvider } = stat
                console.log(chalk.cyan('\n--- Nexus Service Status ---'))
                console.log(formatProviderDiagnostics(provider))
                console.log(formatProviderSmoke(smoke))
                console.log(formatToolAudit(audit))
                console.log(JSON.stringify(statusWithoutProvider, null, 2))
              } catch (e: any) {
                console.error(chalk.red(`Failed to get status from service: ${e.message || e}`))
              }
            } else {
              console.log(chalk.cyan('\n--- Embedded Nexus Status ---'))
              console.log(`Mode: ${chalk.bold('Embedded (Local)')}`)
              console.log(`Workspace CWD: ${chalk.white(options.cwd)}`)
              const configManager = ConfigManager.getInstance()
              const audit = await loadEmbeddedToolAudit()
              console.log(formatProviderDiagnostics(configManager.getProviderDiagnostics()))
              console.log(formatProviderSmoke(runProviderSmokeDryRun()))
              console.log(formatToolAudit(audit))
            }
            continue
          }

          if (trimmed === '/smoke' || trimmed === '/smoke dry-run' || trimmed === '/provider-smoke') {
            try {
              const smoke = options.url
                ? await new NexusClient({ baseUrl: options.url }).providerSmoke()
                : runProviderSmokeDryRun()
              console.log(chalk.cyan('\n--- Provider Smoke ---'))
              console.log(formatProviderSmoke(smoke))
            } catch (e: any) {
              console.error(chalk.red(`Failed to run provider smoke dry-run: ${e.message || e}`))
            }
            continue
          }

          if (trimmed === '/smoke live' || trimmed === '/provider-smoke live' || trimmed === '/smoke live tool-call' || trimmed === '/smoke tool-call' || trimmed === '/provider-smoke live tool-call') {
            const mode = trimmed.includes('tool-call') ? 'tool_call' : 'simple_text'
            try {
              const smoke = options.url
                ? await new NexusClient({ baseUrl: options.url }).providerLiveSmoke({ mode })
                : await runProviderLiveSmoke({ mode })
              console.log(chalk.cyan('\n--- Provider Live Smoke ---'))
              console.log(formatProviderSmoke(smoke))
            } catch (e: any) {
              console.error(chalk.red(`Failed to run provider live smoke: ${e.message || e}`))
            }
            continue
          }

          if (trimmed === '/fallback' || trimmed.startsWith('/fallback ')) {
            const kind = parseProviderRecoveryKind(trimmed.slice('/fallback'.length).trim())
            try {
              const plan = options.url
                ? await new NexusClient({ baseUrl: options.url }).providerFallbackPlan({ kind })
                : planProviderFallbackAction({
                    provider: ConfigManager.getInstance().getProviderDiagnostics(),
                    policy: buildProviderFallbackPolicy(kind),
                  })
              console.log(chalk.cyan('\n--- Provider Fallback Plan ---'))
              console.log(formatProviderFallbackPlan(plan))
            } catch (e: any) {
              console.error(chalk.red(`Failed to build provider fallback plan: ${e.message || e}`))
            }
            continue
          }

          if (trimmed === '/agents' || trimmed === '/agents status') {
            try {
              await showMultiAgentStatus()
            } catch (e: any) {
              console.error(chalk.red(`Failed to show agent status: ${e.message || e}`))
            }
            continue
          }

          if (trimmed === '/collaborate') {
            try {
              await showCollaborateOverlay()
            } catch (e: any) {
              console.error(chalk.red(`Failed to show collaboration view: ${e.message || e}`))
            }
            continue
          }

          if (trimmed === '/channels graph' || trimmed === '/sessions graph') {
            try {
              const client = options.url
                ? new NexusClient({ baseUrl: options.url })
                : embeddedClient()
              const [list, channelResponse] = await Promise.all([
                client.listSessions({ limit: 200 }),
                client.listSessionChannels({ limit: 200 }),
              ])
              console.log(formatChannelGraph({
                sessions: (list as { sessions?: any[] }).sessions ?? [],
                channels: channelResponse.channels,
                rootSessionId: sessionId,
              }))
            } catch (e: any) {
              console.error(chalk.red(`Failed to show channel graph: ${e.message || e}`))
            }
            continue
          }

          if (trimmed === '/sessions tree' || trimmed === '/agents tree') {
            try {
              const client = options.url
                ? new NexusClient({ baseUrl: options.url })
                : embeddedClient()
              const list = await client.listSessions({ limit: 200 })
              const sessions = (list as { sessions?: any[] }).sessions ?? []
              console.log(formatSessionsTree(list, await loadSessionRelationshipSummary(client, sessions), { rootSessionId: sessionId }))
            } catch (e: any) {
              console.error(chalk.red(`Failed to show session tree: ${e.message || e}`))
            }
            continue
          }

          if (trimmed === '/activity' || trimmed === '/sessions activity') {
            try {
              const result = await showSessionActivity()
              if (result.type === 'ack') {
                await ackSessionInboxMessage(result.messageId)
              } else if (result.type === 'quote') {
                queuedPromptPrefill = result.text.split(/\r?\n/).join(INPUT_NEWLINE_MARKER)
                console.log(chalk.dim('Quoted activity context into the prompt. Review and submit manually.'))
              }
            } catch (e: any) {
              console.error(chalk.red(`Failed to show session activity: ${e.message || e}`))
            }
            continue
          }

          if (trimmed === '/channel send confirm') {
            try {
              await confirmChannelSendCommand()
            } catch (e: any) {
              console.error(chalk.red(`Failed to send channel message: ${e.message || e}`))
            }
            continue
          }

          if (trimmed === '/channel send cancel') {
            cancelChannelSendCommand()
            continue
          }

          if (trimmed === '/channel send' || trimmed === '/inbox reply') {
            console.log(chalk.dim(channelSendUsage()))
            continue
          }

          if (trimmed.startsWith('/channel send ') || trimmed.startsWith('/inbox reply ')) {
            try {
              await previewChannelSendCommand(trimmed)
            } catch (e: any) {
              console.error(chalk.red(`Failed to preview channel message: ${e.message || e}`))
            }
            continue
          }

          if (trimmed === '/inbox' || trimmed === '/sessions inbox' || trimmed === '/inbox all' || trimmed === '/sessions inbox all') {
            try {
              const result = await showSessionInbox(trimmed.endsWith(' all'))
              if (result.type === 'ack') {
                await ackSessionInboxMessage(result.messageId)
              } else if (result.type === 'quote') {
                queuedPromptPrefill = result.text.split(/\r?\n/).join(INPUT_NEWLINE_MARKER)
                console.log(chalk.dim('Quoted inbox context into the prompt. Review and submit manually.'))
              }
            } catch (e: any) {
              console.error(chalk.red(`Failed to show session inbox: ${e.message || e}`))
            }
            continue
          }

          if (trimmed.startsWith('/inbox ack ') || trimmed.startsWith('/sessions ack ')) {
            const prefix = trimmed.startsWith('/inbox ack ') ? '/inbox ack ' : '/sessions ack '
            try {
              await ackSessionInboxMessage(trimmed.slice(prefix.length).trim())
            } catch (e: any) {
              console.error(chalk.red(`Failed to acknowledge inbox message: ${e.message || e}`))
            }
            continue
          }

          if (trimmed === '/sessions') {
            try {
              const client = options.url
                ? new NexusClient({ baseUrl: options.url })
                : embeddedClient()
              const list = await client.listSessions({ limit: 10 })
              console.log(chalk.cyan(options.url ? '\n--- Recent Sessions ---' : '\n--- Recent Sessions (Local) ---'))
              console.log(formatSessionsList(list, await loadSessionRelationshipSummary(client, (list as { sessions?: any[] }).sessions ?? [])))
            } catch (e: any) {
              console.error(chalk.red(`Failed to list sessions: ${e.message || e}`))
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

          if (trimmed === '/pager' || trimmed === '/less') {
            try {
              const { getSessionEvents } = await import('../renderEvents.js')
              const { pageText } = await import('../pager.js')
              const events = getSessionEvents()
              const lastToolEvent = [...events].reverse().find(e => e.type === 'tool_completed' && e.output !== undefined)
              if (lastToolEvent && lastToolEvent.type === 'tool_completed') {
                console.log(chalk.cyan(`Paging output of tool: ${lastToolEvent.name}`))
                await pageText(String(lastToolEvent.output))
              } else {
                const lastAssistant = [...events].reverse().find(e => e.type === 'assistant_delta')
                if (lastAssistant && lastAssistant.type === 'assistant_delta') {
                  console.log(chalk.cyan('Paging last assistant response...'))
                  await pageText(lastAssistant.text)
                } else {
                  console.log(chalk.yellow('No tool output or assistant response found to page.'))
                }
              }
            } catch (e: any) {
              console.error(chalk.red(`Pager error: ${e.message || e}`))
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

export function createMockAgentLoopTuiSmokeEvents(sessionId: string, cwd: string): NexusEvent[] {
  const timestamp = new Date().toISOString()
  const parentTask = createMockAgentLoopTask({
    sessionId,
    taskId: '1',
    title: 'Parent blocked by delegated sub-agent',
    status: 'blocked',
    metadata: {
      delegatedSubTaskIds: ['2'],
    },
    timestamp,
  })
  const childTask = createMockAgentLoopTask({
    sessionId,
    taskId: '2',
    title: 'Child implementation via sub-agent',
    status: 'in_progress',
    metadata: {
      parentTaskId: '1',
      depth: 1,
      delegatedBy: 'optimizer',
      subSessionId: `${sessionId}-sub-2`,
      transcriptPath: `nexus://sessions/${sessionId}-sub-2/events`,
    },
    timestamp,
  })
  const completedChild = { ...childTask, status: 'completed' as const }
  const subAgentMetadata = {
    agentId: `${sessionId}:subagent:2`,
    parentAgentId: sessionId,
    parentSessionId: sessionId,
    parentTaskId: '1',
    depth: 1,
    agentType: 'subagent' as const,
    role: 'optimizer' as const,
    status: 'running' as const,
    transcriptPath: `nexus://sessions/${sessionId}-sub-2/events`,
    permissionInheritance: {
      mode: 'role_policy' as const,
      inheritedAllowRules: ['Read', 'Edit', 'Bash'],
      inheritsOnceApprovals: false,
      inheritsSessionApprovals: false,
      inheritedSessionApprovalTools: [],
      requiresApproval: true,
    },
  }

  return [
    {
      type: 'session_started',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId,
      timestamp,
      cwd,
      model: 'mock/agentloop-tui-smoke',
    },
    mockTaskSessionEvent(sessionId, 'planner_completed', 'planning', timestamp, {
      plannerOutput: {
        summary: 'Mock AgentLoop TUI smoke plan',
        tasks: [{ title: parentTask.title }],
      },
    }),
    mockTaskSessionEvent(sessionId, 'task_claimed', 'executing', timestamp, { task: { ...parentTask, status: 'in_progress' } }),
    mockTaskSessionEvent(sessionId, 'task_blocked', 'executing', timestamp, { task: parentTask }),
    mockTaskSessionEvent(sessionId, 'subtasks_delegated', 'executing', timestamp, {
      parentTask,
      parentTaskId: parentTask.taskId,
      subTaskIds: [childTask.taskId],
      subTasks: [childTask],
      requested: 1,
      accepted: 1,
      currentDepth: 0,
      nextDepth: 1,
    }),
    mockTaskSessionEvent(sessionId, 'task_claimed', 'executing', timestamp, { task: childTask }),
    mockTaskSessionEvent(sessionId, 'sub_agent_session_started', 'executing', timestamp, {
      taskId: childTask.taskId,
      subSessionId: `${sessionId}-sub-2`,
      title: childTask.title,
      ...subAgentMetadata,
    }),
    mockTaskSessionEvent(sessionId, 'subagent_started', 'executing', timestamp, {
      taskId: childTask.taskId,
      subSessionId: `${sessionId}-sub-2`,
      title: childTask.title,
      ...subAgentMetadata,
    }),
    mockTaskSessionEvent(sessionId, 'subagent_completed', 'executing', timestamp, {
      taskId: childTask.taskId,
      subSessionId: `${sessionId}-sub-2`,
      title: childTask.title,
      result: 'Sub-agent child completed.',
      ...subAgentMetadata,
      status: 'completed',
      resultEventRange: { firstEventId: `${sessionId}-sub-2:1`, lastEventId: `${sessionId}-sub-2:5`, eventCount: 5 },
      summary: 'Sub-agent child completed.',
    }),
    mockTaskSessionEvent(sessionId, 'sub_agent_session_completed', 'executing', timestamp, {
      taskId: childTask.taskId,
      subSessionId: `${sessionId}-sub-2`,
      result: 'Sub-agent child completed.',
      ...subAgentMetadata,
      status: 'completed',
    }),
    mockTaskSessionEvent(sessionId, 'task_completed', 'executing', timestamp, { task: completedChild }),
  ]
}

function createMockAgentLoopTask(options: {
  sessionId: string
  taskId: string
  title: string
  status: NexusTask['status']
  metadata?: Record<string, unknown>
  timestamp: string
}): NexusTask {
  return {
    taskId: options.taskId,
    sessionId: options.sessionId,
    title: options.title,
    status: options.status,
    source: 'executor',
    dependsOn: [],
    blocks: [],
    retryCount: 0,
    metadata: options.metadata,
    createdAt: options.timestamp,
    updatedAt: options.timestamp,
  }
}

function mockTaskSessionEvent(
  sessionId: string,
  eventType: string,
  phase: string,
  timestamp: string,
  payload?: unknown,
): NexusEvent {
  return {
    type: 'task_session_event',
    schemaVersion: '2026-05-21.babel-o.v1',
    sessionId,
    eventId: `${sessionId}:${eventType}`,
    eventType,
    phase,
    timestamp,
    payload,
  }
}

function formatProviderDiagnostics(provider: any): string {
  if (!provider) return chalk.dim('Provider diagnostics unavailable.')
  const auth = provider.authConfigured ? chalk.green('configured') : chalk.red('missing')
  const capabilities = provider.capabilities ?? {}
  const roleRecommendation = provider.roleRecommendation
  return [
    chalk.bold('Provider'),
    `  provider:        ${provider.providerId} (${provider.providerName})`,
    `  adapter:         ${provider.adapter}`,
    `  auth:            ${provider.authMode} ${auth} source=${provider.authSource}`,
    `  baseUrl:         ${provider.baseUrl || chalk.dim('none')} source=${provider.baseUrlSource}`,
    `  model:           ${chalk.yellow(provider.modelId)} (${provider.modelName}) source=${provider.modelSource}`,
    `  window/output:   ${provider.contextWindow} / ${provider.defaultMaxTokens}`,
    `  capabilities:    tools=${yesNo(capabilities.toolCalling)} json=${yesNo(capabilities.jsonOutput)} structured=${yesNo(capabilities.structuredOutput)} streaming=${yesNo(capabilities.streaming)}`,
    roleRecommendation
      ? `  role hint:       ${roleRecommendation.role} recommends ${roleRecommendation.modelId} (${roleRecommendation.capability}) configured=${yesNo(roleRecommendation.configured)} autoSwitch=${yesNo(roleRecommendation.willAutoSwitch)}`
      : undefined,
  ].filter(Boolean).join('\n')
}

function formatProviderSmoke(smoke: any): string {
  if (!smoke) return chalk.dim('Provider smoke diagnostics unavailable.')
  const checks = smoke.checks ?? {}
  const requirements = smoke.requirements ?? {}
  const fallbackPolicy = smoke.fallbackPolicy ?? {}
  return [
    chalk.bold('Provider Smoke'),
    `  mode:            ${smoke.mode ?? 'unknown'}${smoke.smokeMode ? `/${smoke.smokeMode}` : ''}`,
    `  ready:           ${smoke.ready ? chalk.green('yes') : chalk.red('no')}`,
    `  requirements:    tools=${yesNo(requirements.tools)} streaming=${yesNo(requirements.streaming)} structured=${yesNo(requirements.structuredOutput)}`,
    `  checks:          auth=${yesNo(checks.authConfigured)} model=${yesNo(checks.modelResolved)} tools=${yesNo(checks.toolsSupported)} streaming=${yesNo(checks.streamingSupported)} structured=${yesNo(checks.structuredOutputSupported)}`,
    smoke.mode === 'live'
      ? `  live:            ${smoke.live ? chalk.green('yes') : chalk.red('no')} success=${yesNo(smoke.success)} text=${yesNo(smoke.matchedExpectedText)} tool=${yesNo(smoke.matchedExpectedTool)}`
      : undefined,
    smoke.toolCallCount !== undefined ? `  tool calls:      ${smoke.toolCallCount}${Array.isArray(smoke.toolCalls) && smoke.toolCalls.length > 0 ? ` (${smoke.toolCalls.map((call: any) => call.name || 'unknown').join(', ')})` : ''}` : undefined,
    smoke.outputPreview ? `  output:          ${String(smoke.outputPreview).slice(0, 120)}` : undefined,
    smoke.diagnostic ? `  diagnostic:      ${smoke.diagnostic.status ?? 'unknown'} · ${smoke.diagnostic.summary ?? ''}` : undefined,
    `  fallback:        ${fallbackPolicy.mode ?? 'unknown'} silentSwitch=${fallbackPolicy.allowSilentModelSwitch === false ? 'false' : 'unknown'}`,
    `  next action:     ${fallbackPolicy.nextAction ?? chalk.dim('none')}`,
  ].filter(Boolean).join('\n')
}

function formatProviderFallbackPlan(plan: any): string {
  if (!plan) return chalk.dim('Provider fallback plan unavailable.')
  const action = plan.action ?? {}
  const fallbackPolicy = plan.fallbackPolicy ?? {}
  const provider = plan.provider ?? {}
  return [
    chalk.bold('Provider Fallback Plan'),
    `  provider:        ${provider.providerId ?? 'unknown'} model=${provider.modelId ?? 'unknown'}`,
    `  mode:            ${fallbackPolicy.mode ?? action.mode ?? 'unknown'}`,
    `  status:          ${action.status ?? 'unknown'}`,
    `  silent switch:   ${fallbackPolicy.allowSilentModelSwitch === false ? 'false' : 'unknown'}`,
    `  user confirm:    ${action.requiresUserConfirmation === true ? 'required' : 'unknown'}`,
    `  side effects:    switchModel=${yesNo(action.willSwitchModel)} switchProvider=${yesNo(action.willSwitchProvider)} mutateConfig=${yesNo(action.willMutateConfig)} callProvider=${yesNo(action.willCallProvider)} createSession=${yesNo(action.willCreateSession)}`,
    plan.diagnostic ? `  diagnostic:      ${plan.diagnostic.status ?? 'unknown'} · ${plan.diagnostic.summary ?? ''}` : undefined,
    `  reason:          ${fallbackPolicy.reason ?? chalk.dim('none')}`,
    `  next action:     ${action.description ?? fallbackPolicy.nextAction ?? chalk.dim('none')}`,
  ].filter(Boolean).join('\n')
}

function parseProviderRecoveryKind(value: string): ProviderRecoveryKind {
  const normalized = value.trim().replace(/-/g, '_')
  const allowed = new Set<ProviderRecoveryKind>([
    'max_output_tokens',
    'context_window',
    'rate_limit',
    'auth_or_billing',
    'provider_protocol',
    'provider_unavailable',
    'unknown',
  ])
  return allowed.has(normalized as ProviderRecoveryKind) ? normalized as ProviderRecoveryKind : 'unknown'
}

function yesNo(value: unknown): string {
  return value ? 'yes' : 'no'
}

export function formatContextAnalysis(analysis: Parameters<typeof openContextView>[0]): string {
  const maxTokens = Math.max(1, analysis.window.maxTokens)
  const usedTokens = Math.max(0, analysis.estimate.totalTokens)
  const availableTokens = Math.max(0, maxTokens - usedTokens)
  const compactBufferTokens = Math.max(0, maxTokens - analysis.window.compactThresholdTokens)
  const freeTokens = Math.max(0, availableTokens - compactBufferTokens)
  const activeSkillsTokens = estimateCharsAsTokens(analysis.sections.activeSkillsChars)
  const systemPromptTokens = Math.max(0, analysis.estimate.systemPromptTokens - activeSkillsTokens)
  const segments: ContextUsageSegment[] = [
    { marker: '■', label: 'System prompt', tokens: systemPromptTokens, color: text => chalk.blue(text), barChar: '■' },
    { marker: '■', label: 'System tools', tokens: analysis.estimate.toolDefinitionTokens, color: text => chalk.magenta(text), barChar: '■' },
    { marker: '■', label: 'Skills', tokens: activeSkillsTokens, color: text => chalk.cyan(text), barChar: '■' },
    { marker: '■', label: 'Messages', tokens: analysis.estimate.messageTokens, color: text => chalk.green(text), barChar: '■' },
    { marker: '~', label: 'Autocompact buffer', tokens: compactBufferTokens, color: text => chalk.yellow(text), barChar: '■' },
    { marker: '□', label: 'Free space', tokens: freeTokens, color: text => chalk.dim(text), barChar: '□' },
  ]
  const usage = analysis.diagnostics.usageSummary
  const cache = analysis.diagnostics.cacheEconomics
  const diagnosticRows = [
    `remaining ${formatTokenCount(analysis.diagnostics.remainingTokens)} (${analysis.diagnostics.remainingPercent}%) · compact headroom ${formatTokenCount(analysis.diagnostics.compactRemainingTokens)} · blocking headroom ${formatTokenCount(analysis.diagnostics.blockingRemainingTokens)}`,
    `usage input=${formatTokenCompact(usage.inputTokens)} cached=${formatTokenCompact(usage.cacheReadInputTokens)} output=${formatTokenCompact(usage.outputTokens)} reasoning≈${formatTokenCompact(usage.estimatedReasoningTokens)}`,
    `cache policy read=${formatPercent(cache.cacheReadRatio, 1)} cacheable=${formatPercent(cache.cacheableSystemPromptRatio, 1)} · preserving=${yesNo(cache.cachePreservationMode)} long-context=${yesNo(cache.longContextUtilizationMode)} · ceiling ${formatTokenCompact(cache.effectiveContextCeiling)}/${formatTokenCompact(cache.legacyContextCeiling)} legacy`,
    `ceiling source=${cache.policySource} model.window=${formatTokenCompact(cache.modelContextWindow)} reserved_output=${formatTokenCompact(cache.reservedOutputTokens)} provider_buffer=${formatTokenCompact(cache.providerSafetyBufferTokens)}${cache.envMaxContextTokens !== undefined ? ` env_cap=${formatTokenCompact(cache.envMaxContextTokens)}` : ''}`,
    `thresholds warning=${formatTokenCompact(cache.warningThresholdTokens)} (${cache.warningThresholdPercent}%) compact=${formatTokenCompact(cache.compactThresholdTokens)} (${cache.compactThresholdPercent}%) blocking=${formatTokenCompact(cache.blockingLimitTokens)}`,
    `cache policy reason ${cache.reason}`,
    `microcompact saved≈${formatTokenCompact(analysis.sections.microcompactEstimatedTokensSaved)} tokens · duplicate results=${analysis.sections.microcompactDeduplicatedToolResultCount}`,
    `auto compact floor ${formatTokenCompact(analysis.diagnostics.autoCompactFloor.currentTokens)}/${formatTokenCompact(analysis.diagnostics.autoCompactFloor.thresholdTokens)} (${analysis.diagnostics.autoCompactFloor.thresholdPercent}%) · budget ${formatTokenCompact(analysis.diagnostics.autoCompactFloor.assemblyBudgetTokens)}`,
    `selection items retained=${analysis.diagnostics.selection.retained.length} dropped=${analysis.diagnostics.selection.dropped.length} · phases=${analysis.diagnostics.selection.phases.length}`,
  ]
  const fork = analysis.diagnostics.selection.fork
  if (fork) {
    diagnosticRows.push(`context fork mode=${fork.mode} inherited=${fork.inheritedItems} omitted=${fork.omittedItems}`)
  }
  const retainedItem = analysis.diagnostics.selection.retained[0]
  if (retainedItem) {
    diagnosticRows.push(`selection retained ${retainedItem.kind} · ${retainedItem.reason} · ${formatTokenCompact(retainedItem.estimatedTokens)} tokens`)
  }
  const droppedItem = analysis.diagnostics.selection.dropped[0]
  if (droppedItem) {
    diagnosticRows.push(`selection dropped ${droppedItem.kind} · ${droppedItem.reason} · ${formatTokenCompact(droppedItem.estimatedTokens)} tokens`)
  }
  if (analysis.diagnostics.autoCompact.fuseOpen) {
    diagnosticRows.push(`auto compact paused after ${analysis.diagnostics.autoCompact.failureCount}/${analysis.diagnostics.autoCompact.failureLimit} failures`)
  } else if (analysis.diagnostics.autoCompact.shouldCompact) {
    diagnosticRows.push(`auto compact threshold reached at ${analysis.diagnostics.autoCompact.thresholdPercent}%`)
  }
  if (analysis.diagnostics.compactRetention.hasBoundary) {
    diagnosticRows.push(`retained segment ${analysis.diagnostics.compactRetention.retainedSegmentValid ? 'valid' : 'fallback'} · events=${analysis.diagnostics.compactRetention.retainedEventCount}${analysis.diagnostics.compactRetention.retainedSegmentWarning ? ` · ${analysis.diagnostics.compactRetention.retainedSegmentWarning}` : ''}`)
  }
  if (analysis.diagnostics.compactTokenDelta.hasBoundary) {
    const delta = analysis.diagnostics.compactTokenDelta
    diagnosticRows.push(`compact delta events ${delta.beforeEventCount}→${delta.afterEventCount} · saved≈${formatTokenCompact(delta.estimatedTokensSaved)} tokens`)
  }
  if (analysis.diagnostics.workingSetPaths.length > 0) {
    const paths = analysis.diagnostics.workingSetPaths.slice(0, 3).map(entry => `${entry.path}×${entry.touches}`)
    diagnosticRows.push(`working set paths ${paths.join(', ')}`)
  }
  if (analysis.diagnostics.resumeRecovery.active) {
    diagnosticRows.push(`resume recovery boundary ${analysis.diagnostics.resumeRecovery.code} · ${analysis.diagnostics.resumeRecovery.message}`)
  }
  if (analysis.diagnostics.largeToolResults.length > 0) {
    const largest = analysis.diagnostics.largeToolResults[0]!
    diagnosticRows.push(`largest tool result ${largest.name} ${formatCharCount(largest.outputChars)} · ${largest.inputPreview}`)
  }
  if (analysis.diagnostics.repeatedToolInputs.length > 0) {
    const repeated = analysis.diagnostics.repeatedToolInputs[0]!
    diagnosticRows.push(`repeated tool input ${repeated.name} ×${repeated.count} · ${repeated.inputPreview}`)
  }
  if (analysis.diagnostics.memory.truncated || analysis.diagnostics.memory.pressurePercent >= 70) {
    diagnosticRows.push(`project memory ${formatCharCount(analysis.diagnostics.memory.projectMemoryChars)}/${formatCharCount(analysis.diagnostics.memory.projectMemoryBudgetChars)} (${analysis.diagnostics.memory.pressurePercent}%)${analysis.diagnostics.memory.truncated ? ' · truncated' : ''}`)
  }
  const longTermMemory = analysis.diagnostics.longTermMemory
  const longTermMemoryScope = longTermMemory.scope !== 'unknown'
    ? ` scope=${longTermMemory.scope}${longTermMemory.namespaceId ? ` namespace=${longTermMemory.namespaceId}` : ''}${longTermMemory.namespaceSource ? ` source=${longTermMemory.namespaceSource}` : ''}${longTermMemory.isolationKey ? ` isolation=${longTermMemory.isolationKey}` : ''}`
    : ''
  diagnosticRows.push(`long-term memory ${longTermMemory.enabled ? longTermMemory.provider : 'disabled'}${longTermMemoryScope} · hits=${longTermMemory.hitCount} injected=${formatCharCount(longTermMemory.injectedChars)}/${formatCharCount(longTermMemory.budgetChars)}${longTermMemory.searchLatencyMs !== undefined ? ` latency=${Math.round(longTermMemory.searchLatencyMs)}ms` : ''}${longTermMemory.truncated ? ' · truncated' : ''}${longTermMemory.error ? ` · error=${longTermMemory.error}` : ''}`)
  for (const scopedMemory of analysis.diagnostics.scopedMemory) {
    if (scopedMemory.scope === 'unknown') continue
    const namespace = scopedMemory.namespaceId ? ` namespace=${scopedMemory.namespaceId}` : ''
    const source = scopedMemory.namespaceSource ? ` source=${scopedMemory.namespaceSource}` : ''
    const isolation = scopedMemory.isolationKey ? ` isolation=${scopedMemory.isolationKey}` : ''
    diagnosticRows.push(`scoped memory ${scopedMemory.scope} ${scopedMemory.enabled ? scopedMemory.provider : 'disabled'}${namespace}${source}${isolation} · hits=${scopedMemory.hitCount} injected=${formatCharCount(scopedMemory.injectedChars)}/${formatCharCount(scopedMemory.budgetChars)}${scopedMemory.truncated ? ' · truncated' : ''}${scopedMemory.error ? ` · error=${scopedMemory.error}` : ''}`)
  }
  const sessionMemory = analysis.diagnostics.sessionMemoryLite
  const sessionMemoryLast = sessionMemory.lastUpdate
    ? `last ${sessionMemory.lastUpdate.trigger}/${sessionMemory.lastUpdate.reason || 'unknown'} ${formatCharCount(sessionMemory.lastUpdate.summaryChars)} events=${sessionMemory.lastUpdate.eventCount}`
    : 'last none'
  diagnosticRows.push(`session memory lite ${sessionMemory.enabled ? 'enabled' : 'disabled'} · ${sessionMemoryLast} · next=${sessionMemory.nextDecision.reason}${sessionMemory.nextDecision.shouldUpdate ? ' update' : ' skip'} · policy=${sessionMemory.costPolicy.summaryMode} max=${formatCharCount(sessionMemory.costPolicy.maxSummaryChars)}`)
  const signalRows = analysis.diagnostics.signals.map(signal => {
    return `${formatSignalSeverity(signal.severity)} ${signal.message}`
  })
  const recommendationRows = analysis.recommendations.map(recommendation => `- ${recommendation}`)

  return [
    '',
    `${chalk.dim('⎿')}  ${chalk.bold('BABEL Context')}`,
    `   ${chalk.yellow(formatContextModelName(analysis.modelId))} · current context ${chalk.bold(formatTokenCompact(usedTokens))}/${formatTokenCompact(maxTokens)} (${formatPercent(usedTokens, maxTokens)}) · available ${formatTokenCompact(availableTokens)}`,
    `   ${formatContextUsageBar(segments, maxTokens)} ${formatPercent(usedTokens, maxTokens)} used`,
    '',
    `   ${chalk.bold('Current context by source')}`,
    ...segments.map(segment => `   ${contextSourceRow(segment, maxTokens)}`),
    '',
    `   ${chalk.bold('Diagnostics')}`,
    ...diagnosticRows.map(row => `   ${row}`),
    ...(signalRows.length > 0 ? ['', `   ${chalk.bold('Signals')}`, ...signalRows.map(row => `   ${row}`)] : []),
    '',
    `   ${chalk.bold('Recommendations')}`,
    ...recommendationRows.map(row => `   ${row}`),
    '',
    `   ${chalk.bold('Skills')} · ${chalk.cyan('/skills')}`,
    '',
  ].join('\n')
}

type ContextUsageSegment = {
  marker: string
  label: string
  tokens: number
  color: (text: string) => string
  barChar: string
}

function contextSourceRow(segment: ContextUsageSegment, maxTokens: number): string {
  return `${segment.color(segment.marker)} ${segment.label} · ${formatTokenCount(segment.tokens)} · ${formatPercent(segment.tokens, maxTokens)}`
}

function formatContextUsageBar(segments: ContextUsageSegment[], maxTokens: number): string {
  const width = 36
  const total = Math.max(1, maxTokens)
  const rawCounts = segments.map(segment => segment.tokens > 0 ? (segment.tokens / total) * width : 0)
  const counts = rawCounts.map(count => Math.floor(count))
  let remaining = width - counts.reduce((sum, count) => sum + count, 0)
  rawCounts
    .map((count, index) => ({ index, fraction: count - Math.floor(count) }))
    .sort((a, b) => b.fraction - a.fraction)
    .forEach(({ index }) => {
      if (remaining <= 0) return
      if (segments[index]!.tokens <= 0) return
      counts[index]! += 1
      remaining -= 1
    })
  for (let index = counts.length - 1; remaining < 0 && index >= 0; index -= 1) {
    const removable = Math.min(counts[index]!, -remaining)
    counts[index]! -= removable
    remaining += removable
  }
  const bar = segments
    .map((segment, index) => segment.color(segment.barChar.repeat(Math.max(0, counts[index]!))))
    .join('')
  return `[${bar}]`
}

function formatContextModelName(modelId: string): string {
  const [, name] = modelId.split('/')
  return name || modelId
}

function formatTokenCompact(tokens: number): string {
  if (tokens >= 1000) {
    const value = tokens / 1000
    return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}k`
  }
  return `${Math.round(tokens)}`
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) return `${formatTokenCompact(tokens)} tokens`
  return `${Math.round(tokens)} tokens`
}

function formatCharCount(chars: number): string {
  if (chars >= 1000) {
    const value = chars / 1000
    return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}k chars`
  }
  return `${Math.round(chars)} chars`
}

function formatSignalSeverity(severity: string): string {
  if (severity === 'critical') return chalk.red('critical')
  if (severity === 'warning') return chalk.yellow('warning')
  return chalk.dim('info')
}

function formatPercent(tokens: number, maxTokens: number): string {
  const percent = (tokens / Math.max(1, maxTokens)) * 100
  return `${percent >= 10 ? Math.round(percent) : Math.round(percent * 10) / 10}%`
}

function estimateCharsAsTokens(chars: number): number {
  return Math.max(0, Math.ceil(chars / 4))
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

  const providers = providerRegistry.map(item => item.id)
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
  const providerDef = getProvider(provider)
  const currentProviderConfig = configManager.getProviderConfig(provider)
  const existingKey = currentProviderConfig?.apiKey || ''
  let finalApiKey: string | undefined

  if (providerDef.authMode !== 'none') {
    const keyPrompt = existingKey
      ? `Enter API Key for ${provider} (leave empty to keep existing key): `
      : `Enter API Key for ${provider}: `
    const apiKey = await promptSecretPromise(keyPrompt)

    finalApiKey = apiKey || existingKey
    if (!finalApiKey) {
      console.log(chalk.yellow('Wizard cancelled: API key is required.'))
      return
    }
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
    ...(finalApiKey ? { apiKey: finalApiKey } : {}),
    baseUrl: finalBaseUrl
  })
  configManager.setDefaultModel(modelId)
  console.log(chalk.green(`\n✓ Configuration saved! Default model set to: ${chalk.bold(modelId)}`))
}
