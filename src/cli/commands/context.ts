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
import {
  buildAssemblePreview,
  type AssembleScope,
  type AssembledContextPreview,
} from '../../nexus/contextAssemblePreview.js'
import { PersistedWorkingSetTracker } from '../../runtime/persistedWorkingSetTracker.js'
import {
  BEHAVIOR_TRACE_RELATIVE_PATH,
  type BehaviorTraceEntry,
} from '../../runtime/behaviorTrace.js'
import {
  searchEvents,
  summarizeWindow,
} from '../../tools/contextTools.js'
import type { NexusEvent } from '../../shared/events.js'
import type { WorkingSetEntry } from '../../runtime/workingSetTracker.js'

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

export interface AssembleCommandOptions extends ContextCommandOptions {
  scope: AssembleScope
  maxTokens: number
  includeBehaviorTrace?: boolean
  includeLongTerm?: boolean
  includeProjectMemory?: boolean
  includeLiveHints?: boolean
}

// PR-19: write-op options. NOT silent — defaults to no-op unless explicit
// flags are provided. Each kv has form key=value where value is JSON-encoded
// (e.g. 'task:foo="bar"' or 'count=42'). Per [[memory: babel-o-write-capable-
// child-agent-delayed]] this was approved by user on 2026-06-17.
export interface WorkingSetEditOptions {
  cwd: string
  sessionId?: string
  workspaceId?: string
  add: string[]
  remove: string[]
  update: string[]
  dryRun: boolean
  json: boolean
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

  // PR-19: write op — manual edit of a session's working set.
  // Per doc §7.2. NOT a silent mutation: requires explicit --add/--remove/--update
  // flags. Default behavior (no flags) is a no-op that errors out.
  // --dry-run previews without persisting.
  context
    .command('working-set-edit')
    .description('Edit a session working set (write op). Adds/removes/updates key-value entries.')
    .option('--cwd <path>', 'Project root (default: current dir)', process.cwd())
    .option('--session-id <id>', 'Session to edit (required)', undefined)
    .option('--workspace-id <id>', 'Workspace id (defaults to existing or empty)', undefined)
    .option('--add <kv>', 'Add entry as key=value (repeatable, JSON value supported)', (val: string, prev: string[]) => prev.concat(val), [])
    .option('--remove <key>', 'Remove entry by key (repeatable)', (val: string, prev: string[]) => prev.concat(val), [])
    .option('--update <kv>', 'Update existing entry as key=value (repeatable, JSON value supported)', (val: string, prev: string[]) => prev.concat(val), [])
    .option('--dry-run', 'Preview changes without persisting', false)
    .option('--json', 'Print result as JSON', false)
    .action(async (options: WorkingSetEditOptions) => {
      await runWorkingSetEdit(options)
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
    .option('--include-project-memory', 'Force-include project memory from .babel-o/memory.md (PR-32)')
    .option('--include-live-hints', 'Force-include live hints (nexus-detected patterns within 5min; PR-31)')
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


// ─── PR-19: runWorkingSetEdit (write op, user-approved 2026-06-17) ───────

type ParsedKv = { key: string; value: string }

function parseKv(s: string): ParsedKv {
  const idx = s.indexOf('=')
  if (idx <= 0) {
    throw new Error(`Invalid --add/--update value: "${s}". Expected key=value.`)
  }
  return { key: s.slice(0, idx), value: s.slice(idx + 1) }
}

export async function runWorkingSetEdit(options: WorkingSetEditOptions): Promise<void> {
  if (!options.sessionId) {
    console.error(chalk.red('Error: --session-id is required for working-set-edit'))
    process.exitCode = 2
    return
  }
  if (options.add.length === 0 && options.remove.length === 0 && options.update.length === 0) {
    console.error(chalk.red('Error: must specify at least one of --add, --remove, --update'))
    process.exitCode = 2
    return
  }

  // Load persisted tracker (auto-loads from working-set.json)
  const tracker = new PersistedWorkingSetTracker(options.cwd)
  await tracker.load()

  // Capture pre-edit snapshot
  const before = tracker.get(options.sessionId)
  const beforeEntries: WorkingSetEntry[] = before?.entries ? [...before.entries] : []
  const beforeVersion = before?.version ?? 0
  const beforeWorkspaceId = before?.workspaceId ?? ''

  // Build the new entries list
  let entries: WorkingSetEntry[] = [...beforeEntries]
  const now = new Date().toISOString()
  const operations: Array<{ op: string; key: string; value?: string }> = []

  // --add
  for (const kv of options.add) {
    let key: string, value: string
    try {
      ({ key, value } = parseKv(kv))
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)))
      process.exitCode = 2
      return
    }
    const existingIdx = entries.findIndex((e) => e.key === key)
    if (existingIdx >= 0) {
      console.error(chalk.red(`Error: --add key "${key}" already exists; use --update`))
      process.exitCode = 2
      return
    }
    entries.push({ key, value, updatedAt: now, confidence: 1 })
    operations.push({ op: 'add', key, value })
  }

  // --update
  for (const kv of options.update) {
    let key: string, value: string
    try {
      ({ key, value } = parseKv(kv))
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)))
      process.exitCode = 2
      return
    }
    const existingIdx = entries.findIndex((e) => e.key === key)
    if (existingIdx < 0) {
      console.error(chalk.red(`Error: --update key "${key}" does not exist; use --add`))
      process.exitCode = 2
      return
    }
    entries[existingIdx] = { key, value, updatedAt: now, confidence: 1 }
    operations.push({ op: 'update', key, value })
  }

  // --remove
  for (const key of options.remove) {
    const idx = entries.findIndex((e) => e.key === key)
    if (idx < 0) {
      console.error(chalk.red(`Error: --remove key "${key}" not found`))
      process.exitCode = 2
      return
    }
    entries.splice(idx, 1)
    operations.push({ op: 'remove', key })
  }

  const workspaceId = options.workspaceId ?? beforeWorkspaceId

  if (options.dryRun) {
    if (options.json) {
      console.log(JSON.stringify({ dryRun: true, operations, beforeCount: beforeEntries.length, afterCount: entries.length }, null, 2))
    } else {
      console.log(chalk.yellow('DRY RUN — no changes written'))
      for (const op of operations) {
        if (op.op === 'remove') {
          console.log(`  - remove  ${op.key}`)
        } else {
          console.log(`  ${op.op === 'add' ? '+ add' : '~ update'}  ${op.key}=${op.value}`)
        }
      }
      console.log(chalk.gray(`  (${beforeEntries.length} → ${entries.length} entries)`))
    }
    return
  }

  // Persist
  tracker.update(options.sessionId, { workspaceId, entries })
  await tracker.flush()

  // PR-26: event bus emits working_set_updated automatically
  const after = tracker.get(options.sessionId)
  if (options.json) {
    console.log(JSON.stringify({
      sessionId: options.sessionId,
      workspaceId,
      version: after?.version,
      operations,
      entryCount: entries.length,
    }, null, 2))
  } else {
    console.log(chalk.green('✓ working set updated'))
    for (const op of operations) {
      if (op.op === 'remove') {
        console.log(`  ${chalk.red('- remove')}  ${op.key}`)
      } else if (op.op === 'add') {
        console.log(`  ${chalk.green('+ add')}    ${op.key}=${op.value}`)
      } else {
        console.log(`  ${chalk.yellow('~ update')} ${op.key}=${op.value}`)
      }
    }
    console.log(chalk.gray(`  version: ${beforeVersion} → ${after?.version} (${entries.length} entries)`))
  }
}

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
