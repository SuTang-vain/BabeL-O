// src/nexus/contextAssemblePreview.ts
//
// Read-only manual context assembly preview shared by CLI and REST. This keeps
// Nexus from importing CLI command modules while preserving the offline preview
// behavior introduced by PR-15/PR-18.

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { PersistedWorkingSetTracker } from '../runtime/persistedWorkingSetTracker.js'
import {
  BEHAVIOR_TRACE_RELATIVE_PATH,
  type BehaviorTraceEntry,
} from '../runtime/behaviorTrace.js'
import { loadProjectMemory } from '../runtime/memory.js'

export type AssembleScope = 'minimal' | 'standard' | 'full' | 'task' | 'workspace'

const ASSEMBLE_LAYER_BUDGETS = {
  workingSet: 1500,
  recent: 3000,
  behaviorTrace: 1000,
  longTerm: 1000,
  project: 500,
  liveHints: 500,
} as const

export type AssembledSection = {
  kind: 'workingSet' | 'recentEvents' | 'behaviorTrace' | 'longTerm' | 'project' | 'liveHint'
  content: string
  tokens: number
  pinned: boolean
  source: string
}

export type AssembledContextPreview = {
  sessionId: string
  scope: AssembleScope
  sections: AssembledSection[]
  budget: {
    used: number
    max: number
    overflow: 'drop' | 'microcompact' | 'none'
    droppedSections: AssembledSection[]
  }
  meta: {
    workingSetVersion: number
    lastEventRev: number
    traceEntriesConsidered: number
    assembledAt: string
    assembleLatencyMs: number
  }
}

export type AssemblePreviewOptions = {
  cwd: string
  sessionId?: string
  scope: AssembleScope
  maxTokens: number
  includeBehaviorTrace?: boolean
  includeLongTerm?: boolean
  includeProjectMemory?: boolean
  includeLiveHints?: boolean
}

function capToTokens(content: string, maxTokens: number): { content: string; tokens: number; truncated: boolean } {
  const maxChars = maxTokens * 4
  if (content.length <= maxChars) {
    return { content, tokens: Math.ceil(content.length / 4), truncated: false }
  }
  const cutAt = content.lastIndexOf('\n', maxChars)
  const finalCut = cutAt > 0 ? cutAt : maxChars
  const truncated = `${content.slice(0, finalCut)}\n[...truncated]`
  return { content: truncated, tokens: Math.ceil(truncated.length / 4), truncated: true }
}

function buildWorkingSetSection(
  workingSetVersion: number,
  entries: ReadonlyArray<{ key: string; value: string; confidence: number }>,
): AssembledSection {
  const lines: string[] = ['## Working Set', '']
  if (entries.length === 0) {
    lines.push('(no working set entries)')
  } else {
    for (const entry of entries) {
      const valueShort = entry.value.length > 80 ? `${entry.value.slice(0, 77)}...` : entry.value
      lines.push(`- ${entry.key} = ${valueShort} (conf=${entry.confidence.toFixed(2)})`)
    }
  }
  lines.push('')
  lines.push(`(source: working-set.json v${workingSetVersion})`)
  const raw = lines.join('\n')
  const capped = capToTokens(raw, ASSEMBLE_LAYER_BUDGETS.workingSet)
  return { kind: 'workingSet', content: capped.content, tokens: capped.tokens, pinned: true, source: `working-set.json:v${workingSetVersion}` }
}

function buildRecentEventsSection(sessionId: string, traces: ReadonlyArray<BehaviorTraceEntry>): AssembledSection {
  const lines: string[] = ['## Recent Events (last hour, microcompact-applied)', '']
  if (traces.length === 0) {
    lines.push('(no recent events)')
  } else {
    for (const entry of traces) {
      const detail = entry.anomaly?.errorMessage
        || entry.anomaly?.errorCode
        || entry.anomaly?.denialReason
        || entry.anomaly?.driftPath
        || entry.anomaly?.userRedirectSignal
        || '(no detail)'
      const short = detail.length > 100 ? `${detail.slice(0, 97)}...` : detail
      lines.push(`- [${entry.timestamp}] ${entry.trigger}: ${short}`)
    }
  }
  lines.push('')
  lines.push(`(source: behavior-trace.jsonl for ${sessionId}, ${traces.length} entries)`)
  const raw = lines.join('\n')
  const capped = capToTokens(raw, ASSEMBLE_LAYER_BUDGETS.recent)
  return { kind: 'recentEvents', content: capped.content, tokens: capped.tokens, pinned: false, source: `behavior-trace.jsonl:${sessionId}` }
}

function buildBehaviorTraceSection(traces: ReadonlyArray<BehaviorTraceEntry>): AssembledSection {
  const counts = new Map<string, number>()
  for (const t of traces) {
    counts.set(t.trigger, (counts.get(t.trigger) ?? 0) + 1)
  }
  const lines: string[] = ['## Behavior Trace Summary (last 24h)', '']
  if (traces.length === 0) {
    lines.push('(no behavior trace entries)')
  } else {
    lines.push(`Total: ${traces.length} entr${traces.length === 1 ? 'y' : 'ies'}`)
    for (const [trigger, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`- ${trigger}: ${count}`)
    }
  }
  lines.push('')
  lines.push('(source: behavior-trace.jsonl, 24h window)')
  const raw = lines.join('\n')
  const capped = capToTokens(raw, ASSEMBLE_LAYER_BUDGETS.behaviorTrace)
  return { kind: 'behaviorTrace', content: capped.content, tokens: capped.tokens, pinned: false, source: 'behavior-trace.jsonl:24h' }
}

function buildLongTermStub(): AssembledSection {
  const content = '## Long-Term Memory\n\n(not yet implemented in CLI — runtime layer requires MemoryProvider)\n'
  return { kind: 'longTerm', content, tokens: Math.ceil(content.length / 4), pinned: false, source: 'stub' }
}

function buildProjectStub(): AssembledSection {
  // PR-32: replaced by async buildProjectSection. Kept as a sync fallback
  // (calls into a synchronously-cached version, returns empty if not preloaded).
  const content = '## Project Memory\n\n(use --include-project-memory with --cwd to load .babel-o/memory.md)\n'
  return { kind: 'project', content, tokens: Math.ceil(content.length / 4), pinned: false, source: 'stub' }
}

// PR-32: read project memory from .babel-o/memory.md (per doc §5.2
// getProjectMemorySection). Async because loadProjectMemory is async.
// Reuses the runtime's max-chars cap for consistency.
async function buildProjectSection(cwd: string): Promise<AssembledSection> {
  const content = await loadProjectMemory(cwd)
  if (!content || content.trim().length === 0) {
    const empty = '## Project Memory\n\n(no .babel-o/memory.md found in this project)\n'
    return { kind: 'project', content: empty, tokens: Math.ceil(empty.length / 4), pinned: false, source: '.babel-o/memory.md:not-found' }
  }
  const header = '## Project Memory (from .babel-o/memory.md)\n\n'
  const body = content.endsWith('\n') ? content : content + '\n'
  const full = header + body
  return { kind: 'project', content: full, tokens: Math.ceil(full.length / 4), pinned: false, source: '.babel-o/memory.md' }
}

// PR-31: read live hints from behavior-trace.jsonl. Per doc §4.4 layer 6
// + §7.3 WS comment. Pulls nexus-source entries (source=nexus) within a
// 5min cooldown (per doc §4.3 default). Pure read.
function buildLiveHintSection(traces: ReadonlyArray<BehaviorTraceEntry>, cooldownMs = 5 * 60_000): AssembledSection {
  const now = Date.now()
  const fresh = traces.filter((t) => {
    const source = (t.anomaly as { source?: string } | undefined)?.source
    if (source !== 'nexus') return false
    const ts = Date.parse(t.timestamp)
    return Number.isFinite(ts) && (now - ts) < cooldownMs
  })
  if (fresh.length === 0) {
    const content = '## Live Hints\n\n(no recent nexus-detected patterns within 5min cooldown)\n'
    return { kind: 'liveHint', content, tokens: Math.ceil(content.length / 4), pinned: false, source: 'behavior-trace.jsonl:nexus:5min' }
  }
  const lines: string[] = [`## Live Hints (${fresh.length} within 5min)`, '']
  for (const t of fresh) {
    const conf = t.triggerConfidence > 0 ? ` (conf=${t.triggerConfidence})` : ''
    lines.push(`- [${t.timestamp}] ${t.trigger}${conf}: ${t.anomaly?.errorMessage ?? t.anomaly?.errorCode ?? t.anomaly?.denialReason ?? '(no detail)'}`)
  }
  const raw = lines.join('\n')
  return { kind: 'liveHint', content: raw, tokens: Math.ceil(raw.length / 4), pinned: false, source: 'behavior-trace.jsonl:nexus:5min' }
}

export async function buildAssemblePreview(options: AssemblePreviewOptions): Promise<AssembledContextPreview> {
  const start = Date.now()
  const cwd = options.cwd
  const scope = options.scope

  const tracker = new PersistedWorkingSetTracker(cwd)
  await tracker.load()
  const allEntries = tracker.entries()
  let sessionId: string | undefined = options.sessionId
  let wsVersion = 0
  let wsEntries: ReadonlyArray<{ key: string; value: string; confidence: number }> = []
  if (sessionId) {
    const ws = allEntries.find(([sid]) => sid === sessionId)?.[1]
    if (ws) {
      wsVersion = ws.version
      wsEntries = ws.entries
    }
  } else if (allEntries.length > 0) {
    const sorted = [...allEntries].sort((a, b) => {
      const av = Date.parse(a[1].updatedAt) || 0
      const bv = Date.parse(b[1].updatedAt) || 0
      return bv - av
    })
    const [latestSid, latestWs] = sorted[0]!
    sessionId = latestSid
    wsVersion = latestWs.version
    wsEntries = latestWs.entries
  }
  const resolvedSessionId = sessionId ?? '(none)'

  const tracePath = resolve(cwd, BEHAVIOR_TRACE_RELATIVE_PATH)
  const allTraces: BehaviorTraceEntry[] = []
  if (existsSync(tracePath)) {
    try {
      const raw = await readFile(tracePath, 'utf8')
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try { allTraces.push(JSON.parse(trimmed) as BehaviorTraceEntry) } catch { /* skip */ }
      }
    } catch (err) {
      throw new Error(`Failed to read trace file: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const sessionTraces = resolvedSessionId !== '(none)'
    ? allTraces.filter(t => t.sessionId === resolvedSessionId)
    : []
  const crossSessionTraces = allTraces.filter(t => {
    const source = (t.anomaly as { source?: string } | undefined)?.source
    return source === 'nexus'
  })

  const sections: AssembledSection[] = []
  if (scope === 'minimal') {
    sections.push(buildWorkingSetSection(wsVersion, wsEntries))
  } else if (scope === 'standard') {
    sections.push(buildWorkingSetSection(wsVersion, wsEntries))
    sections.push(buildRecentEventsSection(resolvedSessionId, sessionTraces))
  } else if (scope === 'full') {
    sections.push(buildWorkingSetSection(wsVersion, wsEntries))
    sections.push(buildRecentEventsSection(resolvedSessionId, sessionTraces))
    sections.push(buildBehaviorTraceSection(sessionTraces))
  } else if (scope === 'task') {
    sections.push(buildWorkingSetSection(wsVersion, wsEntries))
    if (sessionTraces.length > 0) {
      sections.push(buildBehaviorTraceSection(sessionTraces))
    }
  } else if (scope === 'workspace') {
    sections.push(buildWorkingSetSection(wsVersion, wsEntries))
    sections.push(buildRecentEventsSection(resolvedSessionId, sessionTraces))
    sections.push(buildBehaviorTraceSection(crossSessionTraces))
  }

  if (options.includeBehaviorTrace && !sections.some(s => s.kind === 'behaviorTrace')) {
    sections.push(buildBehaviorTraceSection(sessionTraces))
  }
  if (options.includeLongTerm) {
    sections.push(buildLongTermStub())
  }
  if (options.includeProjectMemory) {
    sections.push(await buildProjectSection(cwd))
  }
  if (options.includeLiveHints && !sections.some(s => s.kind === 'liveHint')) {
    // PR-31: real live hints from behavior-trace.jsonl (nexus-sourced, 5min cooldown).
    // Use crossSessionTraces (already filtered to source=nexus) instead of
    // sessionTraces, so live hints are workspace-wide.
    sections.push(buildLiveHintSection(crossSessionTraces))
  }

  sections.sort((a, b) => (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1))

  const max = options.maxTokens
  let used = 0
  const kept: AssembledSection[] = []
  const dropped: AssembledSection[] = []
  let overflow: 'drop' | 'microcompact' | 'none' = 'none'
  for (const section of sections) {
    if (used + section.tokens <= max) {
      used += section.tokens
      kept.push(section)
    } else if (section.pinned) {
      used += section.tokens
      kept.push(section)
      overflow = 'microcompact'
    } else {
      dropped.push(section)
      overflow = 'drop'
    }
  }

  return {
    sessionId: resolvedSessionId,
    scope,
    sections: kept,
    budget: { used, max, overflow, droppedSections: dropped },
    meta: {
      workingSetVersion: wsVersion,
      lastEventRev: sessionTraces.length,
      traceEntriesConsidered: allTraces.length,
      assembledAt: new Date().toISOString(),
      assembleLatencyMs: Date.now() - start,
    },
  }
}
