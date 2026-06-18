// src/tools/builtin/contextSummarize.ts
//
// PR-8: context.summarize tool — extract a human-readable summary of
// behavior trace entries by trigger type / scope.
// Wraps summarizeWindow() from src/tools/contextTools.ts (PR-7 data layer).

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { errorMessage } from '../../shared/errors.js'
import type { ToolDefinition } from '../Tool.js'
import { summarizeWindow } from '../contextTools.js'
import { BEHAVIOR_TRACE_RELATIVE_PATH, type BehaviorTraceEntry } from '../../runtime/behaviorTrace.js'

const SCOPES = ['all', 'error', 'denial', 'scope-drift', 'user-redirect', 'trajectory-end', 'cross-session'] as const

const inputSchema = z.object({
  scope: z.enum(SCOPES).optional()
    .describe('Narrow to one trigger type (default: all)'),
  sinceMs: z.number().int().nonnegative().optional()
    .describe('Only include entries with timestamp >= sinceMs'),
  maxTokens: z.number().int().positive().max(5000).optional()
    .describe('Cap return at this many tokens (default 5000)'),
  maxEntries: z.number().int().positive().max(500).optional()
    .describe('Maximum number of entries to include (default 50)'),
})

export const contextSummarizeTool: ToolDefinition<typeof inputSchema> = {
  name: 'contextSummarize',
  description: 'Summarize behavior trace entries. Reads from ' +
    '.babel-o/behavior-trace.jsonl (the JSONL file written by ' +
    'behaviorTrace.ts). Use scope=cross-session to get only Nexus-side ' +
    'detections (source=nexus). Returns a markdown-formatted summary. ' +
    'Does NOT enter active context — use this to inspect history on demand.',
  prompt: () => 'contextSummarize is the on-demand behavior-trace inspector. The behavior trace is the per-session anomaly log written by behaviorTrace.ts (hot-path, tool-storm, scope-drift-wave, error, denial, user-redirect, etc.) plus Nexus cross-session detections (source=nexus). Use it when the user asks "what went wrong", "why did X fail", or "show recent anomalies". Set scope to narrow: scope=error for runtime errors, scope=denial for permission denials, scope=scope-drift for off-path tool storms, scope=cross-session for only Nexus-detected patterns. sinceMs bounds the time window (e.g. 24h ago). maxEntries caps the number of entries (default 50); maxTokens caps the formatted markdown (default 5000). When truncated is true, narrow scope or sinceMs. Returns a markdown-formatted summary grouped by trigger type — use it for human-readable retrospectives, not for grep-style search (use contextSearch for that). Like all on-demand tools, the result does NOT enter active context.',
  risk: 'read',
  inputSchema,
  source: { type: 'builtin' },
  requiresApproval: false,
  async execute(input, context) {
    const tracePath = resolve(context.cwd, BEHAVIOR_TRACE_RELATIVE_PATH)
    if (!existsSync(tracePath)) {
      return {
        success: true,
        output: { content: '(no behavior trace file yet)', tokenEstimate: 5, hitCount: 0, truncated: false },
      }
    }
    try {
      const raw = await readFile(tracePath, 'utf8')
      const entries: BehaviorTraceEntry[] = []
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          entries.push(JSON.parse(trimmed) as BehaviorTraceEntry)
        } catch {
          // skip malformed lines
        }
      }
      const summary = summarizeWindow(entries, {
        scope: input.scope,
        sinceMs: input.sinceMs,
        maxTokens: input.maxTokens,
        maxEntries: input.maxEntries,
      })
      return { success: true, output: summary }
    } catch (error) {
      return {
        success: false,
        output: {
          code: 'CONTEXT_SUMMARIZE_FAILED',
          message: errorMessage(error),
          repairHint: 'Retry with a narrower scope/sinceMs window, or inspect the behavior trace file directly if it exists.',
        },
      }
    }
  },
}
