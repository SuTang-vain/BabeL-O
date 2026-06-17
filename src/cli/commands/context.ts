// src/cli/commands/context.ts
//
// PR-9: Track A Phase 2 CLI — `bbl context working-set` (per design §7.2).
// PR-10: + `bbl context history` (per design §7.2 line 6).
//
// Pure read commands. Inspects working-set.json + behavior-trace.jsonl
// directly. No Nexus server dependency — works offline.
//
// Out of scope (other §7.2 subcommands, separate PRs):
//   - bbl context show          (covered by `bbl sessions show`)
//   - bbl context working-set --edit (write op, needs approval)

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import chalk from 'chalk'
import { Command } from 'commander'
import { PersistedWorkingSetTracker } from '../../nexus/persistedWorkingSetTracker.js'
import {
  BEHAVIOR_TRACE_RELATIVE_PATH,
  type BehaviorTraceEntry,
} from '../../runtime/behaviorTrace.js'
import {
  searchEvents,
  summarizeWindow,
} from '../../tools/contextTools.js'
import type { NexusEvent } from '../../shared/events.js'

export interface ContextCommandOptions {
  cwd: string
  json?: boolean
  sessionId?: string
}

export interface HistoryCommandOptions extends ContextCommandOptions {
  scope: 'search' | 'summarize'
  query?: string
  since?: string
  maxTokens?: number
  summarizeScope?: 'all' | 'error' | 'denial' | 'scope-drift' | 'user-redirect' | 'trajectory-end' | 'cross-session'
}

// PR-15: assemble scope matches design §4.3 (minimal/standard/full/task/workspace).
// The CLI version is a pure read — it pulls the same data layers (working-set.json +
// behavior-trace.jsonl) the runtime ContextAssembler would, and emits the same
// ContextSection shape. It does NOT call the runtime assembleContext() (which needs
// modelId, RuntimeExecuteOptions, MemoryProvider). That's intentionally out of scope:
// the CLI works offline, the runtime path is for live turns.
export type AssembleScope = 'minimal' | 'standard' | 'full' | 'task' | 'workspace'

export interface AssembleCommandOptions extends ContextCommandOptions {
  scope: AssembleScope
  maxTokens: number
  includeBehaviorTrace?: boolean
  includeLongTerm?: boolean
  includeProjectMemory?: boolean
}

export function registerContextCommand(program: Command): void {
  const context = program
    .command('context')
    .description('Inspect context state (working set, history, etc.)')

  context
    .command('working-set')
    .description('Show the working set(s) persisted under <cwd>/.babel-o/working-set.json')
    .option('--cwd <path>', 'Project root (default: current dir)', process.cwd())
    .option('--session-id <id>', 'Show only this session (default: all)')
    .option('--json', 'Print raw JSON output')
    .action(async (options: ContextCommandOptions) => {
      await runWorkingSet(options)
    })

  context
    .command('history')
    .description('Show behavior trace history (search or summarize)')
    .option('--cwd <path>', 'Project root (default: current dir)', process.cwd())
    .option('--scope <scope>', 'search or summarize (default: summarize)', 'summarize')
    .option('--query <q>', 'Search query (search mode only)')
    .option('--since <duration>', 'Only include entries from the last Nh/Nm/Nd (e.g. 24h, 30m, 1d)')
    .option('--max-tokens <n>', 'Cap output tokens (default 5000)', '5000')
    .option('--summarize-scope <s>', 'For summarize mode: filter by trigger type', 'all')
    .option('--json', 'Print raw JSON output')
    .action(async (options: HistoryCommandOptions & { maxTokens: string }) => {
      await runHistory({
        ...options,
        maxTokens: Number(options.maxTokens),
      })
    })

  // PR-13: dry-run resume preview. Pure read — shows what would be loaded
  // if a new session resumed from the current state.
  context
    .command('resume')
    .description('Dry-run: show what a resumed session would inherit (working set + recent behavior)')
    .option('--cwd <path>', 'Project root (default: current dir)', process.cwd())
    .option('--session-id <id>', 'Resume plan for a specific session (default: shows all)')
    .option('--json', 'Print raw JSON output')
    .action(async (options: ContextCommandOptions) => {
      await runResume(options)
    })

  // PR-15: manual context assembly preview. Pulls from the same data layers
  // (working-set.json + behavior-trace.jsonl) the runtime ContextAssembler
  // uses, and emits the same ContextSection shape per design §4.2.
  // Pure read — never mutates state.
  context
    .command('assemble')
    .description('Manual context assembly preview: shows what would be injected (working set + recent + behavior trace)')
    .option('--cwd <path>', 'Project root (default: current dir)', process.cwd())
    .option('--session-id <id>', 'Assemble for a specific session (default: latest active)')
    .option('--scope <scope>', 'minimal|standard|full|task|workspace (default: standard)', 'standard')
    .option('--max-tokens <n>', 'Cap total output tokens (default 7500)', '7500')
    .option('--include-behavior-trace', 'Force-include behavior trace summary (default: depends on scope)')
    .option('--include-long-term', 'Force-include long-term memory hint (CLI stub; not yet implemented)')
    .option('--include-project-memory', 'Force-include project memory (CLI stub; not yet implemented)')
    .option('--json', 'Print raw JSON output')
    .action(async (options: AssembleCommandOptions & { maxTokens: string }) => {
      await runAssemble({
        ...options,
        maxTokens: Number(options.maxTokens),
      })
    })
}

export async function runWorkingSet(options: ContextCommandOptions): Promise<void> {
  const tracker = new PersistedWorkingSetTracker(options.cwd)
  await tracker.load()

  const allEntries = tracker.entries()
  if (allEntries.length === 0) {
    if (options.json) {
      console.log(JSON.stringify({ sessions: [] }, null, 2))
      return
    }
    console.log(chalk.gray('(no working set found)'))
    return
  }

  const filtered = options.sessionId
    ? allEntries.filter(([sid]) => sid === options.sessionId)
    : allEntries

  if (options.json) {
    const out = Object.fromEntries(
      filtered.map(([sid, ws]) => [
        sid,
        {
          workspaceId: ws.workspaceId,
          version: ws.version,
          updatedAt: ws.updatedAt,
          entries: ws.entries,
        },
      ]),
    )
    console.log(JSON.stringify(out, null, 2))
    return
  }

  // Human-readable table
  for (const [sessionId, ws] of filtered) {
    console.log(chalk.bold(`Session: ${chalk.cyan(sessionId)}`))
    console.log(`  workspace: ${ws.workspaceId || chalk.gray('(none)')}`)
    console.log(`  version:   ${ws.version}`)
    console.log(`  updated:   ${ws.updatedAt}`)
    console.log(`  entries:   ${ws.entries.length}`)
    if (ws.entries.length > 0) {
      console.log()
      console.log(`  ${chalk.gray('key'.padEnd(36))} ${chalk.gray('confidence'.padEnd(11))} value`)
      console.log(`  ${chalk.gray('-'.repeat(36))} ${chalk.gray('-'.repeat(11))} ${chalk.gray('-'.repeat(20))}`)
      for (const entry of ws.entries) {
        const confStr = entry.confidence.toFixed(2)
        const valueShort = entry.value.length > 50 ? entry.value.slice(0, 47) + '...' : entry.value
        console.log(`  ${entry.key.padEnd(36)} ${confStr.padEnd(11)} ${valueShort}`)
      }
    }
    console.log()
  }
}

export async function runHistory(options: HistoryCommandOptions): Promise<void> {
  const tracePath = resolve(options.cwd, BEHAVIOR_TRACE_RELATIVE_PATH)
  if (!existsSync(tracePath)) {
    if (options.json) {
      console.log(JSON.stringify({ content: '(no behavior trace file yet)', hitCount: 0, truncated: false }, null, 2))
      return
    }
    console.log(chalk.gray('(no behavior trace file yet)'))
    return
  }

  let entries: BehaviorTraceEntry[] = []
  try {
    const raw = await readFile(tracePath, 'utf8')
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        entries.push(JSON.parse(trimmed) as BehaviorTraceEntry)
      } catch {
        // skip malformed lines
      }
    }
  } catch (error) {
    console.error(chalk.red(`Failed to read trace file: ${error instanceof Error ? error.message : String(error)}`))
    process.exitCode = 1
    return
  }

  const sinceDuration = options.since ? parseSince(options.since) : undefined
  if (options.since && sinceDuration === undefined) {
    console.error(chalk.red(`Invalid --since: ${options.since}. Use e.g. 24h, 30m, 1d, 1w.`))
    process.exitCode = 1
    return
  }
  const sinceMs = sinceDuration !== undefined ? Date.now() - sinceDuration : undefined

  if (options.scope === 'search') {
    if (!options.query) {
      console.error(chalk.red('--query is required for search scope'))
      process.exitCode = 1
      return
    }
    // searchEvents expects NexusEvent[]; we synthesize minimal events from
    // trace entries so the existing PR-7 search can run.
    const events: NexusEvent[] = entries.map((e, i) => ({
      type: 'tool_started',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: e.sessionId,
      timestamp: e.timestamp,
      toolUseId: `trc_${i}`,
      name: 'behavior_trace',
      input: {
        trigger: e.trigger,
        errorMessage: e.anomaly?.errorMessage,
        errorCode: e.anomaly?.errorCode,
        denialReason: e.anomaly?.denialReason,
        driftPath: e.anomaly?.driftPath,
        userRedirectSignal: e.anomaly?.userRedirectSignal,
        source: (e.anomaly as { source?: string } | undefined)?.source,
      },
    }))
    const result = searchEvents(events, options.query, { sinceMs, maxTokens: options.maxTokens })
    if (options.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log(result.content || chalk.gray('(no matches)'))
      console.log(chalk.gray(`\n[hitCount=${result.hitCount} tokenEstimate=${result.tokenEstimate} truncated=${result.truncated}]`))
    }
    return
  }

  // summarize mode (default)
  const summary = summarizeWindow(entries, {
    scope: options.summarizeScope,
    sinceMs,
    maxTokens: options.maxTokens,
  })
  if (options.json) {
    console.log(JSON.stringify(summary, null, 2))
  } else {
    console.log(summary.content)
    console.log(chalk.gray(`\n[hitCount=${summary.hitCount} tokenEstimate=${summary.tokenEstimate} truncated=${summary.truncated}]`))
  }
}

// ─── PR-13: runResume (dry-run) ──────────────────────────────────────────

export async function runResume(options: ContextCommandOptions): Promise<void> {
  const tracker = new PersistedWorkingSetTracker(options.cwd)
  await tracker.load()
  const allEntries = tracker.entries()
  const filtered = options.sessionId
    ? allEntries.filter(([sid]) => sid === options.sessionId)
    : allEntries

  // Read recent behavior trace entries (last 10)
  const tracePath = resolve(options.cwd, BEHAVIOR_TRACE_RELATIVE_PATH)
  let recentTraces: BehaviorTraceEntry[] = []
  if (existsSync(tracePath)) {
    try {
      const raw = await readFile(tracePath, 'utf8')
      const all: BehaviorTraceEntry[] = []
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try { all.push(JSON.parse(trimmed) as BehaviorTraceEntry) } catch { /* skip */ }
      }
      recentTraces = [...all]
        .sort((a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0))
        .slice(0, 10)
    } catch {
      // ignore read errors
    }
  }

  // Compute summary stats
  const totalEntries = filtered.reduce((sum, [, ws]) => sum + ws.entries.length, 0)
  const totalSessions = filtered.length
  const totalTraces = recentTraces.length

  if (options.json) {
    console.log(JSON.stringify({
      cwd: options.cwd,
      sessionId: options.sessionId ?? null,
      workingSet: {
        sessionCount: totalSessions,
        totalEntries,
        sessions: filtered.map(([sid, ws]) => ({
          sessionId: sid,
          workspaceId: ws.workspaceId,
          version: ws.version,
          updatedAt: ws.updatedAt,
          entryCount: ws.entries.length,
          entries: ws.entries,
        })),
      },
      recentBehavior: {
        count: totalTraces,
        entries: recentTraces,
      },
      resumePlan: {
        wouldInheritWorkingSet: totalEntries > 0,
        wouldInheritBehaviorTrace: totalTraces > 0,
        wouldInheritSessionCount: totalSessions,
      },
    }, null, 2))
    return
  }

  // Human-readable
  console.log(chalk.bold('Session Resume Plan (dry-run)'))
  console.log()
  console.log(chalk.cyan('  Working Set:'))
  if (totalSessions === 0) {
    console.log(chalk.gray('    (no working set)'))
  } else {
    console.log(`    ${totalSessions} session(s), ${totalEntries} total entries`)
    for (const [sessionId, ws] of filtered) {
      console.log(`    - ${chalk.bold(sessionId)}: ${ws.entries.length} entries, v${ws.version} (${ws.updatedAt})`)
      for (const entry of ws.entries.slice(0, 5)) {
        const valueShort = entry.value.length > 40 ? entry.value.slice(0, 37) + '...' : entry.value
        console.log(`        ${chalk.gray(entry.key)} → ${valueShort}`)
      }
      if (ws.entries.length > 5) {
        console.log(chalk.gray(`        ... and ${ws.entries.length - 5} more`))
      }
    }
  }
  console.log()
  console.log(chalk.cyan('  Recent Behavior Trace:'))
  if (totalTraces === 0) {
    console.log(chalk.gray('    (no behavior trace)'))
  } else {
    console.log(`    ${totalTraces} most recent entr${totalTraces === 1 ? 'y' : 'ies'}:`)
    for (const entry of recentTraces) {
      const detail = entry.anomaly?.errorMessage
        || entry.anomaly?.errorCode
        || entry.anomaly?.denialReason
        || entry.anomaly?.driftPath
        || entry.anomaly?.userRedirectSignal
        || '(no detail)'
      const short = detail.length > 60 ? detail.slice(0, 57) + '...' : detail
      console.log(`    - [${entry.timestamp}] ${chalk.bold(entry.trigger)}: ${short}`)
    }
  }
  console.log()
  console.log(chalk.cyan('  Next session would inherit:'))
  console.log(`    working set:    ${totalEntries > 0 ? chalk.green('yes') + ` (${totalEntries} entries)` : chalk.gray('no')}`)
  console.log(`    behavior trace: ${totalTraces > 0 ? chalk.green('yes') + ` (${totalTraces} recent)` : chalk.gray('no')}`)
  console.log()
}

// ─── PR-15: runAssemble (manual context assembly preview) ─────────────────

// Mirrors design §3.3 / §4.2 / §4.4 at a read-only CLI level.
// Reads the same data layers the runtime ContextAssembler would (working-set.json
// + behavior-trace.jsonl) and emits a ContextSection-shaped result. Does NOT
// call the runtime assembleContext() because that requires modelId, signal,
// MemoryProvider, mapEventsToMessages — those are live-turn concerns.
//
// Layer budget defaults (per design §4.4):
//   Working Set: 1500, Recent: 3000, Behavior Trace: 1000, Long-term: 1000,
//   Project: 500, Live Hints: 500, total 7500.
const ASSEMBLE_LAYER_BUDGETS = {
  workingSet: 1500,
  recent: 3000,
  behaviorTrace: 1000,
  longTerm: 1000,
  project: 500,
  liveHints: 500,
} as const

type AssembledSection = {
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

function buildWorkingSetSection(workingSetVersion: number, entries: ReadonlyArray<{ key: string; value: string; confidence: number }>): AssembledSection {
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
  // Summary by trigger type (per design §4.4 layer 3: ~1k tokens)
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
  const content = '## Project Memory\n\n(not yet implemented in CLI — runtime layer reads .babel-o/memory.md)\n'
  return { kind: 'project', content, tokens: Math.ceil(content.length / 4), pinned: false, source: 'stub' }
}

function buildLiveHintStub(): AssembledSection {
  const content = '## Live Hints\n\n(only populated by runtime BehaviorMonitor)\n'
  return { kind: 'liveHint', content, tokens: Math.ceil(content.length / 4), pinned: false, source: 'stub' }
}

export type AssemblePreviewOptions = {
  cwd: string
  sessionId?: string
  scope: AssembleScope
  maxTokens: number
  includeBehaviorTrace?: boolean
  includeLongTerm?: boolean
  includeProjectMemory?: boolean
}

// PR-18: Pure function — does all the assembly work, returns the preview object.
// No console.log side effects. CLI and REST both call this.
// Read-only: does not mutate any state.
export async function buildAssemblePreview(options: AssemblePreviewOptions): Promise<AssembledContextPreview> {
  const start = Date.now()
  const cwd = options.cwd
  const scope: AssembleScope = options.scope

  // Resolve session
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
    // Pick the most recently updated session
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

  // Read behavior-trace.jsonl once
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
      // Throwing (not console.error) lets REST handler surface as 500
      throw new Error(`Failed to read trace file: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Per-session traces (filtered to resolved session)
  const sessionTraces = resolvedSessionId !== '(none)'
    ? allTraces.filter(t => t.sessionId === resolvedSessionId)
    : []

  // Cross-session traces for `workspace` scope
  const crossSessionTraces = allTraces.filter(t => {
    const source = (t.anomaly as { source?: string } | undefined)?.source
    return source === 'nexus'
  })

  // Build sections per scope (per design §4.3)
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

  // Optional force-includes (override scope defaults)
  if (options.includeBehaviorTrace && !sections.some(s => s.kind === 'behaviorTrace')) {
    sections.push(buildBehaviorTraceSection(sessionTraces))
  }
  if (options.includeLongTerm) {
    sections.push(buildLongTermStub())
  }
  if (options.includeProjectMemory) {
    sections.push(buildProjectStub())
  }

  // Pinned first (workingSet), then by insertion order
  sections.sort((a, b) => (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1))

  // Budget enforcement (per design §4.4: total 7500, max 8000)
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
      // Pinned: still kept (per design: never silently drop pinned)
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

export async function runAssemble(options: AssembleCommandOptions): Promise<AssembledContextPreview | void> {
  let preview: AssembledContextPreview
  try {
    preview = await buildAssemblePreview(options)
  } catch (err) {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)))
    process.exitCode = 1
    return
  }

  if (options.json) {
    console.log(JSON.stringify(preview, null, 2))
    return preview
  }

  // Human-readable
  const { sessionId: resolvedSessionId, scope, sections: kept, budget, meta } = preview
  const { used, max, overflow, droppedSections: dropped } = budget
  console.log(chalk.bold(`Assembled Context Preview (scope=${scope}, session=${chalk.cyan(resolvedSessionId)})`))
  console.log()
  if (kept.length === 0) {
    console.log(chalk.gray('  (no sections — empty state)'))
  } else {
    for (const section of kept) {
      const pinTag = section.pinned ? chalk.yellow(' [pinned]') : ''
      console.log(chalk.cyan(`  ▸ ${section.kind} (${section.tokens} tok)${pinTag}`))
      const previewLines = section.content.split('\n').slice(0, 5)
      for (const line of previewLines) {
        console.log(chalk.gray(`    ${line}`))
      }
      if (section.content.split('\n').length > 5) {
        console.log(chalk.gray(`    ... (${section.content.split('\n').length - 5} more lines)`))
      }
      console.log()
    }
  }
  if (dropped.length > 0) {
    console.log(chalk.yellow(`  ⚠ dropped ${dropped.length} section(s) due to budget (${used}/${max} tokens used):`))
    for (const d of dropped) {
      console.log(chalk.gray(`    - ${d.kind} (${d.tokens} tok)`))
    }
    console.log()
  }
  console.log(chalk.gray(`  budget: ${used}/${max} tokens, overflow=${overflow}`))
  console.log(chalk.gray(`  meta: workingSetVersion=${meta.workingSetVersion}, lastEventRev=${meta.lastEventRev}, traceEntriesConsidered=${meta.traceEntriesConsidered}, latencyMs=${meta.assembleLatencyMs}`))
  console.log()
}

// ─── Helpers ─────────────────────────────────────────────────────────────

export function parseSince(s: string): number | undefined {
  const match = s.trim().match(/^(\d+)\s*([hmdw])$/i)
  if (!match) return undefined
  const n = Number(match[1])
  const unit = match[2]!.toLowerCase()
  if (unit === 'm') return n * 60_000
  if (unit === 'h') return n * 60 * 60_000
  if (unit === 'd') return n * 24 * 60 * 60_000
  if (unit === 'w') return n * 7 * 24 * 60 * 60_000
  return undefined
}
