// src/tools/builtin/contextRecent.ts
//
// PR-8: context.recent tool — return the most recent N events.
// Wraps recentEvents() from src/tools/contextTools.ts (PR-7 data layer).

import { z } from 'zod'
import type { ToolDefinition } from '../Tool.js'
import { recentEvents } from '../contextTools.js'
import type { NexusEvent } from '../../shared/events.js'

const inputSchema = z.object({
  n: z.number().int().positive().max(500)
    .describe('Number of recent events to return'),
  excludeEventTypes: z.array(z.string()).max(20).optional()
    .describe('Event types to skip (e.g. ["tool_completed"] to reduce noise)'),
  maxTokens: z.number().int().positive().max(5000).optional()
    .describe('Cap return at this many tokens (default 5000)'),
})

export const contextRecentTool: ToolDefinition<typeof inputSchema> = {
  name: 'contextRecent',
  description: 'Return the most recent N events from the session, ' +
    'newest first. Useful for recalling what just happened without ' +
    'scrolling through the entire event history. Optionally exclude ' +
    'noisy event types (e.g. tool_completed) to focus on user-visible ' +
    'turns. Returns one line per event with type, timestamp, and a ' +
    'truncated text snippet. Does NOT enter active context.',
  prompt: () => 'contextRecent is a lightweight "what just happened" peek. Use it when the user asks "what did we do last", "what was the last thing I asked", "show me the recent flow" — situations where you need a few recent events to ground a response, not a full history search. It returns the N most recent events, newest first, one line per event with timestamp, type, and a 200-char snippet. Key tradeoff vs contextSearch: contextRecent is positional (give me the last N), contextSearch is content-based (find events matching X). Use excludeEventTypes to drop noisy types like tool_completed or assistant_delta when you only care about user-visible turns (user_message, tool_started, error). For deeper history, use contextSearch with a sinceMs bound. Result does NOT enter active context.',
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
      const recent = recentEvents(events, input.n, {
        excludeEventTypes: input.excludeEventTypes as NexusEvent['type'][] | undefined,
        maxTokens: input.maxTokens,
      })
      return { success: true, output: recent }
    } catch (error) {
      return {
        success: false,
        output: error instanceof Error ? error.message : String(error),
      }
    }
  },
}
