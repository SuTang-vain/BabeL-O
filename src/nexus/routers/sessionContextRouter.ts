import { z } from 'zod'
import { ConfigManager } from '../../shared/config.js'
import { errorMessage } from '../../shared/errors.js'
import { eventBase, type NexusEvent } from '../../shared/events.js'
import { analyzeContext } from '../../runtime/contextAnalysis.js'
import { buildSystemPrompt, mapEventsToMessages } from '../../runtime/LLMCodingRuntime.js'
import type { FeatureRouter } from '../router.js'

const sessionContextQuerySchema = z.object({
  modelId: z.string().optional(),
  prompt: z.string().optional(),
  cwd: z.string().optional(),
})

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function readContextForkMetadata(metadata: Record<string, unknown> | undefined): { mode: string; inheritedItems: number; omittedItems: number } | undefined {
  const contextFork = asRecord(metadata?.contextFork)
  const mode = typeof metadata?.contextForkMode === 'string' ? metadata.contextForkMode : typeof contextFork?.mode === 'string' ? contextFork.mode : undefined
  if (!mode) return undefined
  const inheritedItems = typeof contextFork?.inheritedItems === 'number' ? contextFork.inheritedItems : 0
  const omittedItems = typeof contextFork?.omittedItems === 'number' ? contextFork.omittedItems : 0
  return { mode, inheritedItems, omittedItems }
}

export const sessionContextRouter: FeatureRouter = {
  name: 'sessionContextRouter',
  register(app, context) {
    app.get('/v1/sessions/:sessionId/context', async (request, reply) => {
      const params = z.object({ sessionId: z.string() }).parse(request.params)
      const query = sessionContextQuerySchema.parse(request.query)
      const session = await context.options.storage.getSession(params.sessionId, {
        includeEvents: false,
      })
      if (!session) {
        return reply.code(404).send({
          type: 'error',
          code: 'SESSION_NOT_FOUND',
          message: `Session not found: ${params.sessionId}`,
        })
      }
      const { events } = await context.options.storage.listEvents(params.sessionId, {
        limit: 10_000,
        order: 'asc',
      })
      const settings = ConfigManager.getInstance().resolveSettings()
      const modelId = query.modelId ?? settings.modelId ?? 'local/coding-runtime'
      const toolDefinitions = (context.options.runtime.listTools?.() ?? [])
        .filter(tool => tool.allowed)
        .map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema ?? {},
        }))
      const analysis = await analyzeContext({
        runtimeOptions: {
          sessionId: params.sessionId,
          prompt: query.prompt ?? session.lastUserInput ?? session.prompt,
          cwd: query.cwd ?? session.cwd,
          contextFork: readContextForkMetadata(session.metadata),
        },
        events,
        modelId,
        buildSystemPrompt,
        mapEventsToMessages,
        tools: toolDefinitions,
        memoryProvider: context.options.memoryProvider,
        sessionInbox: await context.options.storage.listSessionInbox(params.sessionId, {
          limit: 20,
        }),
        onMemoryRetrieval: context.options.memoryProvider
          ? async ({ sessionId, cwd, prompt, diagnostics }) => {
              const autoSearch = diagnostics.autoSearch
              const event: NexusEvent = {
                ...eventBase(sessionId),
                type: 'memory_retrieval',
                provider: diagnostics.provider,
                enabled: diagnostics.enabled,
                scope: diagnostics.scope,
                ...(diagnostics.namespaceId && { namespaceId: diagnostics.namespaceId }),
                ...(diagnostics.namespaceSource && { namespaceSource: diagnostics.namespaceSource }),
                ...(diagnostics.isolationKey && { isolationKey: diagnostics.isolationKey }),
                autoSearchTriggered: autoSearch?.triggered ?? false,
                autoSearchReason: autoSearch?.reason ?? 'no_memory_cue',
                ...(autoSearch?.cue && { autoSearchCue: autoSearch.cue }),
                hitCount: diagnostics.hitCount,
                injectedChars: diagnostics.injectedChars,
                budgetChars: diagnostics.budgetChars,
                maxHitChars: diagnostics.maxHitChars,
                truncated: diagnostics.truncated,
                ...(diagnostics.searchLatencyMs !== undefined && { searchLatencyMs: diagnostics.searchLatencyMs }),
                ...(diagnostics.error && { error: diagnostics.error }),
                prompt,
                cwd,
              }
              try {
                await context.options.storage.appendEvent(sessionId, event)
              } catch (error) {
                process.stderr.write(
                  `[nexus:context] memory_retrieval event append failed: ${errorMessage(error)}\n`,
                )
              }
            }
          : undefined,
      })
      return analysis
    })
  },
}
