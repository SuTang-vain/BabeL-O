// src/tools/builtin/contextSearch.ts
//
// PR-8: context.search tool — full-text search over NexusEvent stream.
// Wraps searchEvents() from src/tools/contextTools.ts (PR-7 data layer).
// Pure data: reads events from storage, returns capped result.

import { z } from 'zod'
import { errorMessage } from '../../shared/errors.js'
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
    'The query is split on whitespace into keywords; every keyword must ' +
    'appear as a substring (case-insensitive by default) in some text field ' +
    'of an event for it to match. Use distinctive keywords, not full ' +
    'sentences. Returns matching events as capped snippets, newest first. ' +
    'Check truncated / eventsCapped to detect dropped results. ' +
    'Does NOT enter active context — use this to fetch history on demand.',
  prompt: () => 'contextSearch is an on-demand history locator. Use it when the user asks about past activity ("what did we do earlier", "did we already see this error", "回顾一下之前的任务"). Matching is TOKENIZED SUBSTRING: the query is split on whitespace, and an event matches only when EVERY keyword appears as a substring of its text fields. Use distinctive keywords, not full sentences — `query="memory leak"` works, `query="find the previous decision about the memory leak"` does not. It searches user messages, assistant output, tool inputs, and error messages. Prefer it over Grep when searching session history (Grep is for files, contextSearch is for events). Use Read on referenced paths to verify claims. Set sinceMs to bound the search window when you know the rough time range. eventTypeFilter narrows to specific event types (e.g. ["user_message"]) AND pushes the filter to storage so long sessions do not drop recent matches. maxTokens caps the response (default 5000). If `truncated` is true, narrow the query or sinceMs. If `eventsCapped` is true, the loaded window hit a row cap — narrow with eventTypeFilter or sinceMs rather than rewording the query, since the missing matches may not have been loaded. Returns do NOT enter active context — call this only when you actually need historical evidence.',
  risk: 'read',
  inputSchema,
  source: { type: 'builtin' },
  requiresApproval: false,
  async execute(input, context) {
    if (!context.storage) {
      return {
        success: false,
        output: {
          code: 'CONTEXT_STORAGE_UNAVAILABLE',
          message: 'storage not available in tool context',
          repairHint: 'Continue from visible session context, or retry contextSearch in a runtime with storage attached.',
        },
      }
    }
    try {
      // When eventTypeFilter is set, push it to storage as `eventTypes` so
      // the SQL WHERE clause filters BEFORE the row LIMIT. Without this
      // pushdown, a long session (>10k events) silently drops the newest
      // matching events because listEvents applies LIMIT on an ascending
      // scan before the in-memory type filter. See
      // docs/nexus/proposals/context-search-algorithm-robustness-plan.md.
      const listOptions: {
        order: 'asc'
        limit: number
        eventTypes?: string[]
      } = { order: 'asc', limit: 50_000 }
      if (input.eventTypeFilter && input.eventTypeFilter.length > 0) {
        listOptions.eventTypes = input.eventTypeFilter
      }
      const result = await context.storage.listEvents(context.sessionId, listOptions)
      const events = (result?.events ?? []) as NexusEvent[]
      const search = searchEvents(events, input.query, {
        sinceMs: input.sinceMs,
        maxTokens: input.maxTokens,
        caseSensitive: input.caseSensitive,
        eventTypeFilter: input.eventTypeFilter as NexusEvent['type'][] | undefined,
        eventsScanned: events.length,
        eventsCapped: result?.nextCursor !== undefined,
      })
      return { success: true, output: search }
    } catch (error) {
      return {
        success: false,
        output: {
          code: 'CONTEXT_SEARCH_FAILED',
          message: errorMessage(error),
          query: input.query,
          repairHint: 'Narrow the query or retry after session storage is available.',
        },
      }
    }
  },
}
