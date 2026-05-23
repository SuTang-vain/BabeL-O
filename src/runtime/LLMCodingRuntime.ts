import { z } from 'zod'
import { errorMessage, ProviderError } from '../shared/errors.js'
import { eventBase, type NexusEvent } from '../shared/events.js'
import { createId, nowIso } from '../shared/id.js'
import type { AnyTool } from '../tools/Tool.js'
import { truncateToolOutput } from '../tools/output.js'
import type {
  NexusRuntime,
  RuntimeExecuteOptions,
  RuntimeToolAuditEntry,
} from './Runtime.js'
import type { ToolPolicy } from './LocalCodingRuntime.js'
import { checkOptimizerSafety } from './safetyCheck.js'
import { PendingPermissionRegistry } from '../shared/session.js'
import type { NexusStorage } from '../storage/Storage.js'
import { getAdapter } from '../providers/registry.js'
import type {
  ModelMessage,
  ModelQueryParams,
  ContentBlock,
} from '../providers/adapters/ModelAdapter.js'
import { ConfigManager } from '../shared/config.js'


export class LLMCodingRuntime implements NexusRuntime {
  constructor(
    private readonly tools: Map<string, AnyTool>,
    private readonly toolPolicy: ToolPolicy,
    private readonly storage: NexusStorage,
    private readonly configManager: ConfigManager = ConfigManager.getInstance(),
  ) {}

  listTools(): RuntimeToolAuditEntry[] {
    return [...this.tools.values()]
      .map(tool => ({
        name: tool.name,
        description: tool.description,
        risk: tool.risk,
        allowed: this.toolPolicy.isAllowed(tool),
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  async *executeStream(options: RuntimeExecuteOptions): AsyncIterable<NexusEvent> {
    yield {
      type: 'session_started',
      ...eventBase(options.sessionId),
      cwd: options.cwd,
      requestId: options.requestId,
      model: options.model,
      budget: options.budget,
    }

    try {
      // 1. Resolve connection and credential settings
      const settings = this.configManager.resolveSettings()

      // 2. Load previous session events from storage (if any)
      let previousEvents: NexusEvent[] = []
      if (this.storage) {
        try {
          const result = await this.storage.listEvents(options.sessionId, {
            order: 'asc',
            limit: 1000,
          })
          previousEvents = result?.events || []
        } catch {
          // Fallback to empty history on storage error
        }
      }

      // Strip optional [1m] tag from canonical model name
      const activeModel = options.model || settings.modelId
      const cleanedModelId = activeModel.replace(/\[1m\]$/i, '')
      const adapter = getAdapter(settings.providerId)

      // Build the messages history
      const messages = mapEventsToMessages(previousEvents, options.prompt)

      // Parse thinking budget config from environments or options.budget
      const thinkingBudgetEnv =
        process.env.BABEL_O_THINKING_BUDGET || process.env.ANTHROPIC_THINKING_BUDGET
      const thinkingBudget = options.budget !== undefined ? options.budget : (thinkingBudgetEnv ? parseInt(thinkingBudgetEnv, 10) : undefined)

      let loopCount = 0
      const maxLoops = 25

      while (loopCount < maxLoops) {
        loopCount++

        if (options.signal?.aborted) {
          throw new Error('Aborted')
        }

        // Convert tool registry definitions to JSON Schema objects using Zod native export
        const toolsList = [...this.tools.values()].map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: z.toJSONSchema(tool.inputSchema),
        }))

        const queryParams: ModelQueryParams = {
          model: cleanedModelId,
          systemPrompt: buildSystemPrompt(options),
          messages,
          tools: toolsList,
          enablePromptCaching: settings.providerId === 'anthropic',
          ...(thinkingBudget &&
            thinkingBudget > 0 && {
              thinking: { budgetTokens: thinkingBudget },
            }),
        }

        const adapterOptions = {
          signal: options.signal,
          apiKey: settings.apiKey,
          baseUrl: settings.baseUrl,
        }

        let currentAssistantText = ''
        const currentToolCalls: {
          id: string
          name: string
          partialInput: string
          input?: unknown
        }[] = []

        // Stream LLM response
        const stream = adapter.queryStream(queryParams, adapterOptions)
        for await (const delta of stream) {
          if (options.signal?.aborted) {
            throw new Error('Aborted')
          }

          if (delta.type === 'text') {
            currentAssistantText += delta.text
            yield {
              type: 'assistant_delta',
              ...eventBase(options.sessionId),
              text: delta.text,
            }
          } else if (delta.type === 'thinking') {
            yield {
              type: 'thinking_delta',
              ...eventBase(options.sessionId),
              text: delta.text,
            }
          } else if (delta.type === 'tool_use_start') {
            currentToolCalls.push({
              id: delta.id,
              name: delta.name,
              partialInput: '',
            })
          } else if (delta.type === 'tool_use_delta') {
            const toolCall = currentToolCalls.find(tc => tc.id === delta.id)
            if (toolCall) {
              toolCall.partialInput += delta.inputDelta
            }
          } else if (delta.type === 'tool_use_end') {
            const toolCall = currentToolCalls.find(tc => tc.id === delta.id)
            if (toolCall) {
              toolCall.input = delta.input
            }
          } else if (delta.type === 'usage') {
            yield {
              type: 'usage',
              ...eventBase(options.sessionId),
              inputTokens: delta.inputTokens,
              outputTokens: delta.outputTokens,
              cacheCreationInputTokens: delta.cacheCreationInputTokens,
              cacheReadInputTokens: delta.cacheReadInputTokens,
            }
          }
        }

        // Record assistant's turn in messages array
        const assistantContent: ContentBlock[] = []
        if (currentAssistantText) {
          assistantContent.push({ type: 'text', text: currentAssistantText })
        }
        for (const tc of currentToolCalls) {
          let resolvedInput = tc.input
          if (resolvedInput === undefined && tc.partialInput) {
            try {
              resolvedInput = JSON.parse(tc.partialInput)
            } catch {
              resolvedInput = {}
            }
          }
          assistantContent.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: resolvedInput,
          })
        }

        messages.push({
          role: 'assistant',
          content: assistantContent.length > 0 ? assistantContent : currentAssistantText,
        })

        // If no tool call was issued, we yield the final result and terminate loop
        if (currentToolCalls.length === 0) {
          yield {
            type: 'result',
            ...eventBase(options.sessionId),
            success: true,
            message: currentAssistantText,
          }
          return
        }

        // Execute requested tools
        const toolResultsContent: ContentBlock[] = []
        for (const tc of currentToolCalls) {
          let resolvedInput = tc.input
          if (resolvedInput === undefined && tc.partialInput) {
            try {
              resolvedInput = JSON.parse(tc.partialInput)
            } catch {
              resolvedInput = {}
            }
          }

          const tool = this.tools.get(tc.name)
          if (!tool) {
            const msg = `Tool not found: ${tc.name}`
            yield {
              type: 'error',
              ...eventBase(options.sessionId),
              code: 'TOOL_NOT_FOUND',
              message: msg,
            }
            return
          }

          yield {
            type: 'tool_started',
            ...eventBase(options.sessionId),
            toolUseId: tc.id,
            name: tc.name,
            input: resolvedInput,
          }

          if (!this.toolPolicy.isAllowed(tool)) {
            const message = `Tool denied by Nexus policy: ${tool.name}`
            yield {
              type: 'tool_denied',
              ...eventBase(options.sessionId),
              name: tool.name,
              risk: tool.risk,
              message,
            }
            yield {
              type: 'result',
              ...eventBase(options.sessionId),
              success: false,
              message,
            }
            return
          }

          const parsed = tool.inputSchema.safeParse(resolvedInput)
          if (!parsed.success) {
            yield {
              type: 'error',
              ...eventBase(options.sessionId),
              code: 'INVALID_TOOL_INPUT',
              message: z.prettifyError(parsed.error),
            }
            return
          }

          const safetyCheck = checkOptimizerSafety(tool.name, parsed.data, options.role)
          if (!safetyCheck.allowed) {
            const message = safetyCheck.reason!
            yield {
              type: 'tool_denied',
              ...eventBase(options.sessionId),
              name: tool.name,
              risk: tool.risk,
              message,
            }
            yield {
              type: 'result',
              ...eventBase(options.sessionId),
              success: false,
              message,
            }
            return
          }

          // Check if the tool requires authorization.
          if ((tool.risk === 'write' || tool.risk === 'execute') && !options.skipPermissionCheck) {
            yield {
              type: 'permission_request',
              ...eventBase(options.sessionId),
              toolUseId: tc.id,
              name: tool.name,
              input: parsed.data,
              risk: tool.risk,
              message: `Tool ${tool.name} requires user permission to run.`,
            }

            const decision = await PendingPermissionRegistry.getInstance().register(
              options.sessionId,
              tc.id
            )

            await this.storage.savePermissionAudit({
              auditId: createId('audit'),
              sessionId: options.sessionId,
              toolUseId: tc.id,
              toolName: tool.name,
              toolRisk: tool.risk,
              toolInput: parsed.data,
              decision: decision.approved ? 'approved' : 'denied',
              reason: decision.reason,
              timestamp: nowIso(),
            })

            yield {
              type: 'permission_response',
              ...eventBase(options.sessionId),
              toolUseId: tc.id,
              approved: decision.approved,
              reason: decision.reason,
            }

            if (!decision.approved) {
              const denyMessage = decision.reason || `Tool execution denied by user: ${tool.name}`
              yield {
                type: 'tool_denied',
                ...eventBase(options.sessionId),
                name: tool.name,
                risk: tool.risk,
                message: denyMessage,
              }
              yield {
                type: 'result',
                ...eventBase(options.sessionId),
                success: false,
                message: denyMessage,
              }
              return
            }
          }

          const result = await executeToolSafely(tool, parsed.data, options)
          if (result.kind === 'error') {
            yield {
              type: 'error',
              ...eventBase(options.sessionId),
              code: result.code,
              message: result.message,
            }
            return
          }

          yield {
            type: 'tool_completed',
            ...eventBase(options.sessionId),
            toolUseId: tc.id,
            name: tool.name,
            success: result.success,
            output: result.output,
            truncated: result.truncated,
            originalBytes: result.originalBytes,
          }

          const blockContent =
            typeof result.output === 'string'
              ? result.output
              : JSON.stringify(result.output, null, 2)
          toolResultsContent.push({
            type: 'tool_result',
            toolUseId: tc.id,
            content: blockContent,
            isError: !result.success,
          })
        }

        // Record tool results as a single user message
        messages.push({
          role: 'user',
          content: toolResultsContent,
        })
      }

      yield {
        type: 'error',
        ...eventBase(options.sessionId),
        code: 'MAX_LOOPS_EXCEEDED',
        message: `Execution exceeded maximum tool call iterations (${maxLoops}).`,
      }
    } catch (err: any) {
      const isTimeout = options.signal?.aborted || err.message?.includes('Abort') || err.name === 'AbortError'
      yield {
        type: 'error',
        ...eventBase(options.sessionId),
        code: isTimeout ? 'REQUEST_TIMEOUT' : (err.code || 'PROVIDER_ERROR'),
        message: err instanceof Error ? err.message : String(err),
      }
    }
  }
}

async function executeToolSafely(
  tool: AnyTool,
  input: unknown,
  options: RuntimeExecuteOptions,
): Promise<
  | {
      kind: 'result'
      success: boolean
      output: unknown
      truncated?: boolean
      originalBytes?: number
    }
  | { kind: 'error'; code: string; message: string }
> {
  try {
    const result = await tool.execute(input, {
      cwd: options.cwd,
      sessionId: options.sessionId,
      signal: options.signal,
      maxOutputBytes: options.maxToolOutputBytes ?? 200_000,
      bashMaxBufferBytes: options.bashMaxBufferBytes ?? 1_000_000,
    })
    const truncated = truncateToolOutput(
      result.output,
      options.maxToolOutputBytes ?? 200_000,
    )
    return {
      kind: 'result',
      success: result.success,
      output: truncated.value,
      truncated: truncated.truncated || undefined,
      originalBytes: truncated.originalBytes,
    }
  } catch (error) {
    if (options.signal?.aborted) {
      return {
        kind: 'error',
        code: 'REQUEST_TIMEOUT',
        message: `Execution timed out while running ${tool.name}.`,
      }
    }
    return {
      kind: 'error',
      code: 'TOOL_ERROR',
      message: errorMessage(error),
    }
  }
}

function buildSystemPrompt(options: RuntimeExecuteOptions): string {
  return `You are BabeL-O, a powerful agentic AI coding assistant designed to help developers with tasks.
You are running in the workspace: ${options.cwd}
Current OS: ${process.platform}
Current time: ${new Date().toISOString()}

Guidelines:
1. Use the workspace tools sequentially to accomplish the requested task.
2. Maintain context awareness. Search, read, or list files before making edits or running commands if you are unsure of the structure.
3. Keep your explanations concise and direct.
4. When writing code, ensure correct syntax and path safety within the workspace.
5. All operations must be confined to the current directory (${options.cwd}). Do not access files outside this workspace.
`
}

export function mapEventsToMessages(
  events: NexusEvent[],
  initialPrompt: string,
): ModelMessage[] {
  const messages: ModelMessage[] = []

  const firstUserMsg = events.find(e => e.type === 'user_message') as Extract<NexusEvent, { type: 'user_message' }> | undefined
  const initial = firstUserMsg ? firstUserMsg.text : initialPrompt
  messages.push({ role: 'user', content: initial })

  const completedToolIds = new Set<string>()
  for (const event of events) {
    if (event.type === 'tool_completed') {
      completedToolIds.add(event.toolUseId)
    }
  }

  for (const event of events) {
    if (event.type === 'user_message') {
      if (messages.length === 1 && messages[0].content === event.text) {
        continue
      }
      messages.push({ role: 'user', content: event.text })
    } else if (event.type === 'assistant_delta') {
      let lastMsg = messages[messages.length - 1]
      if (!lastMsg || lastMsg.role !== 'assistant') {
        lastMsg = { role: 'assistant', content: '' }
        messages.push(lastMsg)
      }
      if (typeof lastMsg.content === 'string') {
        lastMsg.content += event.text
      } else {
        const lastBlock = lastMsg.content[lastMsg.content.length - 1]
        if (lastBlock && lastBlock.type === 'text') {
          lastBlock.text += event.text
        } else {
          lastMsg.content.push({ type: 'text', text: event.text })
        }
      }
    } else if (event.type === 'tool_started') {
      let lastMsg = messages[messages.length - 1]
      if (!lastMsg || lastMsg.role !== 'assistant') {
        lastMsg = { role: 'assistant', content: [] }
        messages.push(lastMsg)
      } else if (typeof lastMsg.content === 'string') {
        lastMsg.content = lastMsg.content ? [{ type: 'text', text: lastMsg.content }] : []
      }
      ;(lastMsg.content as ContentBlock[]).push({
        type: 'tool_use',
        id: event.toolUseId,
        name: event.name,
        input: event.input,
      })

      // If this tool was started but never completed (e.g. denied or interrupted),
      // we must synthetically complete it with an error result block so future queries don't break.
      if (!completedToolIds.has(event.toolUseId)) {
        let lastUserMsg = messages.findLast(m => m.role === 'user')
        if (!lastUserMsg || typeof lastUserMsg.content === 'string') {
          lastUserMsg = { role: 'user', content: [] }
          messages.push(lastUserMsg)
        }
        ;(lastUserMsg.content as ContentBlock[]).push({
          type: 'tool_result',
          toolUseId: event.toolUseId,
          content: 'Error: Tool execution was denied or interrupted.',
          isError: true,
        })
      }
    } else if (event.type === 'tool_completed') {
      let lastMsg = messages[messages.length - 1]
      if (!lastMsg || lastMsg.role !== 'user' || typeof lastMsg.content === 'string') {
        lastMsg = { role: 'user', content: [] }
        messages.push(lastMsg)
      }
      const outputText =
        typeof event.output === 'string'
          ? event.output
          : JSON.stringify(event.output, null, 2)
      ;(lastMsg.content as ContentBlock[]).push({
        type: 'tool_result',
        toolUseId: event.toolUseId,
        content: outputText,
        isError: !event.success,
      })
    }
  }

  return messages
}
