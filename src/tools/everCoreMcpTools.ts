import { performance } from 'node:perf_hooks'
import { z } from 'zod'
import { errorMessage } from '../shared/errors.js'
import type { EverCoreClient, EverCoreMessage } from '../runtime/everCoreClient.js'
import type { EverCoreRuntimeConfig } from '../nexus/everCoreConfig.js'
import {
  extractEverCoreMemoryHits,
  formatMemoryProviderHits,
} from '../runtime/memoryProvider.js'
import type { AnyTool, ToolDefinition } from './Tool.js'

const DEFAULT_SEARCH_MAX_CHARS = 4_000
const DEFAULT_SEARCH_MAX_HIT_CHARS = 800
const MAX_NOTE_CHARS = 4_000

const searchInputSchema = z.object({
  query: z.string().min(1),
  topK: z.number().int().positive().max(20).optional(),
  method: z.enum(['keyword', 'vector', 'hybrid', 'agentic']).optional(),
  maxChars: z.number().int().positive().max(20_000).optional(),
  maxHitChars: z.number().int().positive().max(4_000).optional(),
})

const saveNoteInputSchema = z.object({
  note: z.string().min(1).max(MAX_NOTE_CHARS),
  sessionId: z.string().min(1).optional(),
})

const flushInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
})

export function createEverCoreMcpToolRegistry(
  client: EverCoreClient,
  config: EverCoreRuntimeConfig,
): Map<string, AnyTool> {
  const tools = createEverCoreMcpTools(client, config)
  return new Map(tools.map(tool => [tool.name, tool]))
}

export function createEverCoreMcpTools(
  client: EverCoreClient,
  config: EverCoreRuntimeConfig,
): AnyTool[] {
  return [
    createMemorySearchTool(client, config),
    createMemorySaveNoteTool(client, config),
    createMemoryFlushSessionTool(client, config),
  ]
}

function createMemorySearchTool(
  client: EverCoreClient,
  config: EverCoreRuntimeConfig,
): ToolDefinition<typeof searchInputSchema> {
  return {
    name: 'mcp:evercore:memory_search',
    description: 'Search EverCore long-term semantic memory. Use this read-only tool when the user asks about prior preferences, previous decisions, cross-session context, or says things like "do you remember", "before", "last time", "之前", "上次", or "我的偏好". Results are background hints, not authoritative project state; verify project facts against workspace evidence.',
    risk: 'read',
    inputSchema: searchInputSchema,
    modelInputSchema: z.toJSONSchema(searchInputSchema),
    source: {
      type: 'mcp',
      serverName: 'evercore',
      originalName: 'memory_search',
    },
    requiresApproval: false,
    suggestedAllowRule: 'mcp:evercore:memory_search',
    mcpServerAllowed: true,
    async execute(input) {
      const maxChars = input.maxChars ?? config.maxContentChars ?? DEFAULT_SEARCH_MAX_CHARS
      const maxHitChars = input.maxHitChars ?? DEFAULT_SEARCH_MAX_HIT_CHARS
      const topK = input.topK ?? config.topK
      const started = performance.now()
      try {
        const envelope = await client.search({
          query: input.query,
          appId: config.appId,
          projectId: config.projectId,
          userId: config.userId,
          agentId: config.userId ? undefined : config.agentId,
          method: input.method ?? config.retrieveMethod,
          topK,
        })
        const hits = extractEverCoreMemoryHits(envelope)
        const formatted = formatMemoryProviderHits(hits, {
          maxContextChars: maxChars,
          maxHitChars,
          maxHits: topK,
        })
        return {
          success: true,
          output: {
            provider: 'evercore',
            hitCount: formatted.hitCount,
            injectedChars: formatted.content.length,
            budgetChars: maxChars,
            maxHitChars,
            truncated: formatted.truncated,
            searchLatencyMs: Math.round(performance.now() - started),
            content: formatted.content,
            note: 'EverCore memories are background hints; verify against current workspace/session evidence before strong claims.',
          },
        }
      } catch (error) {
        return {
          success: false,
          output: {
            code: 'EVERCORE_MEMORY_SEARCH_FAILED',
            message: errorMessage(error),
            searchLatencyMs: Math.round(performance.now() - started),
          },
        }
      }
    },
  }
}

function createMemorySaveNoteTool(
  client: EverCoreClient,
  config: EverCoreRuntimeConfig,
): ToolDefinition<typeof saveNoteInputSchema> {
  return {
    name: 'mcp:evercore:memory_save_note',
    description: 'Save a note to EverCore long-term memory only when the user explicitly asks you to remember something, or when an approved governed memory candidate should be written. This is write-risk and permission-gated. Prefer saving user preferences, durable constraints, or work-style feedback; do not save high-impact project facts without workspace evidence and user approval.',
    risk: 'write',
    inputSchema: saveNoteInputSchema,
    modelInputSchema: z.toJSONSchema(saveNoteInputSchema),
    source: {
      type: 'mcp',
      serverName: 'evercore',
      originalName: 'memory_save_note',
    },
    requiresApproval: true,
    suggestedAllowRule: 'mcp:evercore:memory_save_note',
    mcpServerAllowed: true,
    async execute(input, context) {
      const sessionId = input.sessionId ?? context.sessionId
      const message: EverCoreMessage = {
        sender_id: config.agentId,
        sender_name: 'BabeL-O',
        role: 'assistant',
        timestamp: Date.now(),
        content: input.note.trim(),
      }
      try {
        await client.addAgentMessages({
          sessionId,
          appId: config.appId,
          projectId: config.projectId,
          messages: [message],
        })
        return {
          success: true,
          output: {
            provider: 'evercore',
            sessionId,
            savedMessages: 1,
            savedChars: message.content.length,
          },
        }
      } catch (error) {
        return {
          success: false,
          output: {
            code: 'EVERCORE_MEMORY_SAVE_NOTE_FAILED',
            message: errorMessage(error),
            sessionId,
          },
        }
      }
    },
  }
}

function createMemoryFlushSessionTool(
  client: EverCoreClient,
  config: EverCoreRuntimeConfig,
): ToolDefinition<typeof flushInputSchema> {
  return {
    name: 'mcp:evercore:memory_flush_session',
    description: 'Flush an explicit session into EverCore memory processing. This is a lifecycle/write-risk operation and is normally owned by runtime session close; call it only when the user explicitly asks to sync/flush memory now or during a diagnostic memory workflow.',
    risk: 'write',
    inputSchema: flushInputSchema,
    modelInputSchema: z.toJSONSchema(flushInputSchema),
    source: {
      type: 'mcp',
      serverName: 'evercore',
      originalName: 'memory_flush_session',
    },
    requiresApproval: true,
    suggestedAllowRule: 'mcp:evercore:memory_flush_session',
    mcpServerAllowed: true,
    async execute(input, context) {
      const sessionId = input.sessionId ?? context.sessionId
      try {
        await client.flushAgentSession({
          sessionId,
          appId: config.appId,
          projectId: config.projectId,
        })
        return {
          success: true,
          output: {
            provider: 'evercore',
            sessionId,
            flushed: true,
          },
        }
      } catch (error) {
        return {
          success: false,
          output: {
            code: 'EVERCORE_MEMORY_FLUSH_SESSION_FAILED',
            message: errorMessage(error),
            sessionId,
          },
        }
      }
    },
  }
}
