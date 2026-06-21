// src/tools/builtin/contextRecent.ts
//
// PR-8: context.recent tool — return the most recent N events.
// Wraps recentEvents() from src/tools/contextTools.ts (PR-7 data layer).

import { z } from 'zod'
import { errorMessage } from '../../shared/errors.js'
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
  prompt: () => 'contextRecent is a lightweight "what just happened" peek. Use it when the user asks "what did we do last", "what was the last thing I asked", "show me the recent flow" — situations where you need a few recent events to ground a response, not a full history search. It returns the N most recent events, newest first, one line per event with timestamp, type, and a 200-char snippet. **Default (Bug 1.3 fix, 2026-06-20)**: hook_started / hook_completed / usage / thinking_delta / assistant_delta / tool_completed are pre-filtered — you only see user-visible turns (user_message, tool_started, error, result, scope_boundary_*, etc.). Pass `excludeEventTypes` to ADD more filters (merged on top of the default). To re-include thinking_delta (e.g. to debug a model reasoning trail) explicitly list it — the default covers the common case. Key tradeoff vs contextSearch: contextRecent is positional (give me the last N), contextSearch is content-based (find events matching X). For deeper history, use contextSearch with a sinceMs bound. Result does NOT enter active context.',
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
          repairHint: 'Continue from visible session context, or retry contextRecent in a runtime with storage attached.',
        },
      }
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
        output: {
          code: 'CONTEXT_RECENT_FAILED',
          message: errorMessage(error),
          repairHint: 'Retry with a smaller n or after session storage is available.',
        },
      }
    }
  },
}
