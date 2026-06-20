// src/tools/builtin/contextSessions.ts
//
// context.sessions tool — cross-session metadata search.
//
// Why this is a separate tool (not contextSearch with a flag):
//   - contextSearch searches the *event stream* of a *single session*
//     and returns event snippets.
//   - contextSessions searches *session metadata* (id, prompt, cwd,
//     lastUserInput, phase, timestamps) across ALL sessions and
//     returns one line per session.
//   - The two tools answer different questions and have different
//     payload shapes; collapsing them under a flag would make the
//     prompt and result schema confusing for the model.
//
// Wires to `searchSessionsMetadata()` in
// src/tools/contextTools.ts (data layer).

import { z } from 'zod'
import { errorMessage } from '../../shared/errors.js'
import type { ToolDefinition } from '../Tool.js'
import {
  searchSessionsMetadata,
  type SessionMetadata,
} from '../contextTools.js'
import type { SessionSnapshot } from '../../shared/session.js'

const inputSchema = z.object({
  query: z.string().optional()
    .describe('Substring match against session prompt / lastUserInput / result / failureReason / cwd. Omit to list all sessions in the filter window.'),
  cwd: z.string().optional()
    .describe('Restrict to sessions whose cwd matches exactly. Use the workspace path as recorded by the runtime.'),
  phase: z.union([z.string(), z.array(z.string())]).optional()
    .describe('Restrict by phase (e.g. "completed", ["executing","waiting"]).'),
  sinceMs: z.number().int().nonnegative().optional()
    .describe('Only include sessions updated >= sinceMs (epoch ms).'),
  limit: z.number().int().positive().max(100).optional()
    .describe('Max sessions to return (default 20). Newest first.'),
  caseSensitive: z.boolean().optional()
    .describe('Case-sensitive matching (default false).'),
  maxTokens: z.number().int().positive().max(5000).optional()
    .describe('Cap return at this many tokens (default 5000).'),
})

export const contextSessionsTool: ToolDefinition<typeof inputSchema> = {
  name: 'contextSessions',
  description:
    'Search session metadata across the entire Nexus session store. ' +
    'Returns one line per matching session with id, phase, cwd, last ' +
    'user input, and timestamp. Use this when the user asks about ' +
    'PAST sessions ("which session did we discuss X", "what were the ' +
    'last 5 sessions", "show sessions from yesterday"). For drilling ' +
    'into the events of one session, follow up with contextSearch / ' +
    'contextRecent. Does NOT enter active context.',
  prompt: () =>
    'contextSessions answers cross-session "which past sessions match X" questions. Unlike contextSearch (single-session event-stream match) and contextRecent (single-session positional peek), contextSessions reads SESSION METADATA across ALL sessions: id, cwd, prompt, lastUserInput, result, failureReason, phase, timestamps. Use it when the user wants to find or list past sessions — by topic ("query=memory leak"), by workspace ("cwd=/path/to/project"), by status ("phase=failed"), by recency ("sinceMs=..."), or by combinations. Returns a capped list, newest first, one line per session. Follow up with contextSearch (with the matching sessionId would require a future extension; for now, contextSessions is the entry point and contextSearch covers current-session events). Result does NOT enter active context.',
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
          repairHint:
            'Continue from visible session context, or retry contextSessions in a runtime with storage attached.',
        },
      }
    }
    try {
      const sessions = await context.storage.listSessions({})
      const metadata = sessions.map(toSessionMetadata)
      const result = searchSessionsMetadata(metadata, {
        query: input.query,
        cwd: input.cwd,
        phase: input.phase,
        sinceMs: input.sinceMs,
        limit: input.limit,
        caseSensitive: input.caseSensitive,
        maxTokens: input.maxTokens,
      })
      return { success: true, output: result }
    } catch (error) {
      return {
        success: false,
        output: {
          code: 'CONTEXT_SESSIONS_FAILED',
          message: errorMessage(error),
          repairHint:
            'Narrow the query / cwd / phase, or retry after session storage is available.',
        },
      }
    }
  },
}

function toSessionMetadata(s: SessionSnapshot): SessionMetadata {
  return {
    sessionId: s.sessionId,
    cwd: s.cwd,
    prompt: s.prompt,
    lastUserInput: s.lastUserInput,
    phase: s.phase,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    result: typeof s.result === 'string' ? s.result : undefined,
    failureReason: s.failureReason,
  }
}
