import {
  allowAllTools,
  denyByDefaultTools,
  allowlistedTools,
  LocalCodingRuntime,
} from '../runtime/LocalCodingRuntime.js'
import { LLMCodingRuntime, buildSystemPrompt as llmBuildSystemPrompt, mapEventsToMessages as llmMapEventsToMessages } from '../runtime/LLMCodingRuntime.js'
import { MemoryStorage } from '../storage/MemoryStorage.js'
import { SqliteStorage } from '../storage/SqliteStorage.js'
import { createDefaultToolRegistry } from '../tools/registry.js'
import { ConfigManager } from '../shared/config.js'
import { createMcpToolRegistry } from '../mcp/McpToolAdapter.js'
import { ExploreAgentScheduler } from './agents/AgentScheduler.js'
import { createAgentToolRegistry } from './agents/AgentTools.js'
import {
  configureStorageBridgeWal,
  flushStorageBridge,
  type StorageBridgeWalOptions,
} from './storageBridge.js'
import type { RemoteToolRunner } from '../runtime/remoteRunner.js'
import type { MemoryProvider } from '../runtime/memoryProvider.js'
import type { EverCoreClient } from '../runtime/everCoreClient.js'
import type { EverCoreRuntimeConfig } from './everCoreConfig.js'
import { createEverCoreMcpToolRegistry } from '../tools/everCoreMcpTools.js'
import { startEverOSBackgroundBootstrap } from '../cli/everosBackgroundBootstrap.js'
// PR-A4: resume() class method dependencies.
import { PersistedWorkingSetTracker } from './persistedWorkingSetTracker.js'
import { BehaviorMonitor } from './behaviorMonitor.js'
import * as os from 'node:os'
import * as path from 'node:path'

export type CreateDefaultNexusRuntimeOptions = {
  storagePath?: string
  allowedTools?: string[]
  cwd?: string
  enableMcp?: boolean
  enableAgentTools?: boolean
  storageWal?: StorageBridgeWalOptions
  remoteRunner?: RemoteToolRunner
  agentExecutionEnvironment?: 'local' | 'remote'
  memoryProvider?: MemoryProvider
  everCore?: {
    client?: EverCoreClient
    config: EverCoreRuntimeConfig
    dispose?(): Promise<void>
  }
  /**
   * Disable the Z3 auto-bootstrap trigger. Used by tests and
   * by callers that want to manage the bootstrap lifecycle
   * themselves (e.g. an embedded runner that does its own
   * pre-flight). Default is `false` (auto-bootstrap enabled).
   */
  disableAutoMemoryBootstrap?: boolean
}

export async function createDefaultNexusRuntime(
  options: CreateDefaultNexusRuntimeOptions = {},
) {
  const tools = createDefaultToolRegistry()
  if (options.enableMcp) {
    const mcpTools = await createMcpToolRegistry(options.cwd ?? process.cwd())
    for (const [name, tool] of mcpTools) {
      tools.set(name, tool)
    }
  }
  if (options.everCore?.config.mcpToolsEnabled && options.everCore.client) {
    const everCoreTools = createEverCoreMcpToolRegistry(options.everCore.client, options.everCore.config)
    for (const [name, tool] of everCoreTools) {
      tools.set(name, tool)
    }
  }
  // Phase 2 of docs/nexus/reference/go-tui-session-observability-governance-plan.md:
  // When `storagePath` is not explicitly set, fall back to the
  // shared `~/.babel-o/db.sqlite` (honouring `BABEL_O_CONFIG_DIR` /
  // `BABEL_O_CONFIG_FILE` overrides) rather than `MemoryStorage`.
  // The previous `MemoryStorage` default meant any `bbl go`
  // embedded Nexus instance lost all session data on exit — the
  // exact failure mode that hid `session_go_1781146359507755000`.
  //
  // MemoryStorage is now reserved for the **explicit opt-in** path:
  // callers pass `storagePath: ':memory:'` (or any other sentinel
  // that maps to an in-memory backend) to keep the old behaviour
  // for unit tests / short-lived runners.
  const resolvedStoragePath = resolveDefaultStoragePath(options.storagePath)
  const storage = resolvedStoragePath.kind === 'sqlite'
    ? new SqliteStorage(resolvedStoragePath.path)
    : resolvedStoragePath.kind === 'memory-opt-in'
    ? new MemoryStorage()
    : new MemoryStorage() // legacy fallback (see resolveDefaultStoragePath)
  if (resolvedStoragePath.kind === 'memory-legacy') {
    // Non-fatal: log a one-line warning so operators understand
    // why their session isn't being persisted. Phase 3 will
    // surface this in `~/.babel-o/log/embedded-nexus.log`.
    console.warn(
      '[nexus] storagePath=memory is deprecated; ' +
        'Phase 2 now defaults to ~/.babel-o/db.sqlite. ' +
        'Pass `storagePath: \':memory:\'` to opt back in.',
    )
  }
  const agentScheduler = new ExploreAgentScheduler({
    storage,
    cwd: options.cwd,
    executionEnvironment: options.agentExecutionEnvironment,
    remoteRunner: options.remoteRunner,
  })
  if (options.enableAgentTools) {
    for (const [name, tool] of createAgentToolRegistry(agentScheduler)) {
      tools.set(name, tool)
    }
  }
  if (resolvedStoragePath.kind === 'sqlite') {
    configureStorageBridgeWal(`${resolvedStoragePath.path}.wal.jsonl`, options.storageWal)
  } else {
    configureStorageBridgeWal(null)
  }

  // Z3 of the zero-friction memory plan: kick off the
  // background bootstrap at runtime startup so that any path
  // triggering the runtime (bbl run, bbl serve behind bbl go)
  // benefits from the same auto-bootstrap behavior. The
  // worker is fire-and-forget — failure is non-fatal and surfaced
  // via the /v1/runtime/status bootstrap field consumed by both
  // the CLI welcome card and the Go TUI footer.
  //
  // The auto-bootstrap policy comes from the same env+state
  // resolution used by the interactive launcher, so a user who
  // sets BABEL_O_EVERCORE_AUTO_BOOTSTRAP=1 once will see memory
  // come online automatically regardless of entrypoint.
  if (!options.disableAutoMemoryBootstrap) {
    const background = startEverOSBackgroundBootstrap({
      assumeYes: true,
      nonInteractive: true,
    })
    void background.promise.catch(() => undefined)
  }

  const originalClose = storage.close?.bind(storage)
  storage.close = async () => {
    await flushStorageBridge()
    const disposableTools = [...tools.values()].filter(tool => tool.dispose)
    await Promise.allSettled(disposableTools.map(tool => tool.dispose?.()))
    await options.everCore?.dispose?.()
    await originalClose?.()
  }

  const configManager = ConfigManager.getInstance()
  const settings = configManager.resolveSettings()

  let policy = denyByDefaultTools()
  if (options.allowedTools) {
    const hasWildcard = options.allowedTools.some(t => {
      const norm = t.trim().toLowerCase()
      return norm === '*' || norm === 'all'
    })
    if (hasWildcard) {
      policy = allowAllTools()
    } else {
      policy = allowlistedTools(options.allowedTools)
    }
  }

  const runtime =
    settings.providerId === 'local'
      ? new LocalCodingRuntime(tools, policy, storage, configManager.load().hooks)
      : await (async () => {
          // PR-A4: wire resumeDeps for the LLMCodingRuntime class method
          // (doc §6.2). Construct a per-cwd PersistedWorkingSetTracker +
          // BehaviorMonitor; pre-load the WS file once at boot (tiny,
          // idempotent). The buildSystemPrompt + mapEventsToMessages
          // closures match the shapes the runtime's hot-path
          // refreshRuntimeContextState call site already uses.
          const defaultCwd = options.cwd ?? process.cwd()
          const workingSetTracker = new PersistedWorkingSetTracker(defaultCwd)
          await workingSetTracker.load()
          const behaviorMonitor = new BehaviorMonitor({ cwd: defaultCwd })
          return new LLMCodingRuntime(
            tools,
            policy,
            storage,
            configManager,
            options.memoryProvider,
            undefined, // contextBroadcaster (A2 path) — leave default
            {
              workingSetTracker,
              behaviorMonitor,
              buildSystemPrompt: llmBuildSystemPrompt,
              mapEventsToMessages: (events, initialPrompt) =>
                llmMapEventsToMessages(events, initialPrompt),
            },
          )
        })()

  return { runtime, storage, tools, agentScheduler, remoteRunner: options.remoteRunner }
}

/**
 * Phase 2 of `docs/nexus/reference/go-tui-session-observability-governance-plan.md`:
 * Resolve the storage path used by `createDefaultNexusRuntime` when
 * the caller doesn't pass `storagePath`. Mirrors the Phase 0
 * `resolveConfigDir` helper in `src/cli/commands/inspectSession.ts`
 * (same three-tier precedence: explicit arg → `BABEL_O_CONFIG_DIR`
 * → `BABEL_O_CONFIG_FILE` → `~/.babel-o`).
 *
 * Three return kinds:
 *   - `'sqlite'`     — use the resolved absolute sqlite path.
 *   - `'memory-opt-in'` — caller explicitly passed `:memory:`
 *     (or `NODE_ENV === 'test'` is set). Use `MemoryStorage` and
 *     stay silent. The `NODE_ENV === 'test'` branch preserves
 *     the test isolation invariant for the 100+ existing tests
 *     that call `createDefaultNexusRuntime()` without an explicit
 *     storage path; the plan's hard invariant is "BabeL-O tests
 *     must never read from or write to the user's real
 *     `~/.babel-o/config.json`" (memory `babel-o-test-config-isolation`).
 *   - `'memory-legacy'` — caller passed an unrecognised non-sqlite
 *     value. Use `MemoryStorage` but emit a deprecation warning.
 *     The deprecation window gives unit tests and short-lived
 *     runners time to migrate to explicit opt-in.
 */
export type ResolvedStoragePath =
  | { kind: 'sqlite'; path: string }
  | { kind: 'memory-opt-in' }
  | { kind: 'memory-legacy' }

export function resolveDefaultStoragePath(
  explicitPath: string | undefined,
): ResolvedStoragePath {
  // Test isolation guard: when `NODE_ENV === 'test'` (set by
  // node:test / jest / mocha), default to `MemoryStorage`
  // unless the caller explicitly opts into sqlite. The 100+
  // existing tests that call `createDefaultNexusRuntime()`
  // without arguments will then continue to use the
  // per-process in-memory backend, never touching the
  // user's real `~/.babel-o/db.sqlite`.
  //
  // This is the smallest possible invasive change that
  // preserves the test isolation invariant while still
  // flipping the production default to sqlite (Phase 2's
  // primary goal).
  if (explicitPath === undefined && process.env.NODE_ENV === 'test') {
    return { kind: 'memory-opt-in' }
  }
  if (explicitPath !== undefined) {
    // Recognised opt-in: `:memory:` keeps the old per-process
    // behaviour for unit tests and short-lived runners.
    if (explicitPath === ':memory:') {
      return { kind: 'memory-opt-in' }
    }
    // Anything else is treated as a sqlite path (relative or
    // absolute). We resolve to an absolute path so embedded
    // Nexus instances don't accidentally write to the wrong
    // cwd-relative location.
    const absolute = resolveAbsolutePath(explicitPath)
    return { kind: 'sqlite', path: absolute }
  }
  // No explicit path → default to the shared ~/.babel-o/db.sqlite.
  // Honours BABEL_O_CONFIG_DIR / BABEL_O_CONFIG_FILE for test
  // isolation (mirrors `resolveConfigDir` in inspectSession.ts).
  const configDir = resolveConfigDirForStorage()
  return { kind: 'sqlite', path: joinPath(configDir, 'db.sqlite') }
}

function resolveAbsolutePath(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(p)
}

function joinPath(...parts: string[]): string {
  return path.join(...parts)
}

function resolveConfigDirForStorage(): string {
  const fromDir = process.env.BABEL_O_CONFIG_DIR
  if (fromDir) return fromDir
  const fromFile = process.env.BABEL_O_CONFIG_FILE
  if (fromFile) return joinPath(fromFile, '..')
  return joinPath(os.homedir(), '.babel-o')
}
