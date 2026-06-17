// src/tools/builtin/contextSearch.ts
//
// PR-8: context.search tool — full-text search over NexusEvent stream.
// Wraps searchEvents() from src/tools/contextTools.ts (PR-7 data layer).
// Pure data: reads events from storage, returns capped result.

import { z } from 'zod'
import type { ToolDefinition } from '../Tool.js'
import { searchEvents } from '../contextTools.js'
import type { NexusEvent } from '../../shared/events.js'

const inputSchema = z.object({
  query: z.string().min(1).describe('Search query (case-insensitive substring match)'),
  sinceMs: z.number().int().nonnegative().optional()
    .describe('Only include events with timestamp >= sinceMs (ms since epoch)'),
  maxTokens: z.number().int().positive().max(5000).optional()
    .describe('Cap return at this many tokens (default 5000)'),
  caseSensitive: z.boolean().optional()
    .describe('Case-sensitive matching (default false)'),
  eventTypeFilter: z.array(z.string()).max(20).optional()
    .describe('Restrict search to these event types'),
})

export const contextSearchTool: ToolDefinition<typeof inputSchema> = {
  name: 'contextSearch',
  description: 'Full-text search over the session event stream. ' +
    'Searches across all text fields of each event (user_message.text, ' +
    'error.message, tool input strings, etc). Case-insensitive by default. ' +
    'Returns a capped summary of matching events; check truncated flag to ' +
    'detect if more results were dropped. Does NOT enter active context — ' +
    'use this to fetch history on demand.',
  prompt: () => 'contextSearch is an on-demand history locator. Use it when the user asks about past activity ("what did we do earlier", "did we already see this error", "find the previous decision about X"). It searches across all event text fields — user messages, assistant deltas, tool inputs, error messages — and returns matching events as capped snippets. Prefer it over Grep when searching session history (Grep is for files, contextSearch is for events). The result is locator evidence; use Read on referenced paths to verify claims. Set sinceMs to bound the search window when you know the rough time range. maxTokens caps the response (default 5000); if truncated is true, narrow the query or sinceMs to fetch more targeted results. eventTypeFilter narrows to specific event types when you know what to look for. Returns do NOT enter active context — call this only when you actually need historical evidence.',
  risk: 'read',
  inputSchema,
  source: { type: 'builtin' },
  requiresApproval: false,
  async execute(input, context) {
    if (!context.storage) {
      return { success: false, output: 'storage not available in tool context' }
    }
    try {
      const result = await context.storage.listEvents(context.sessionId, {
        order: 'asc',
        limit: 10_000,
      })
      const events = (result?.events ?? []) as NexusEvent[]
      const search = searchEvents(events, input.query, {
        sinceMs: input.sinceMs,
        maxTokens: input.maxTokens,
        caseSensitive: input.caseSensitive,
        eventTypeFilter: input.eventTypeFilter as NexusEvent['type'][] | undefined,
      })
      return { success: true, output: search }
    } catch (error) {
      return {
        success: false,
        output: error instanceof Error ? error.message : String(error),
      }
    }
  },
}
