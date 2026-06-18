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
// Tool registry layering diagnostics (§2.2 of the Tool Surface Expansion plan).
import {
  registerToolWithDiagnostics,
  consoleWarnDiagnosticHandler,
  type ToolRegistryDiagnosticHandler,
} from './toolRegistryLayering.js'
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
  /**
   * Optional handler for tool registry layering diagnostics.
   * When provided, each Layer 2-4 tool registration that
   * overrides an existing name, escalates risk, or attempts a
   * blocked cross-prefix override will call this handler.
   * Default: `console.warn` (via `consoleWarnDiagnosticHandler`).
   * Pass a no-op to silence diagnostics in tests that don't care.
   */
  toolRegistryDiagnosticHandler?: ToolRegistryDiagnosticHandler | null
}

export async function createDefaultNexusRuntime(
  options: CreateDefaultNexusRuntimeOptions = {},
) {
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
  // Pass the real storage so the registry registers context* tools.
  // (Storage is always available in this code path — see legacy fallback
  // above. If storage is ever undefined here, the registry's storage=null
  // gate hides context* tools rather than advertising tools that always
  // fail with CONTEXT_STORAGE_UNAVAILABLE.)
  const tools = createDefaultToolRegistry({ storage })
  // Resolve the diagnostic handler: explicit null means silent,
  // undefined means default console.warn, handler means custom.
  const diagnosticHandler: ToolRegistryDiagnosticHandler | undefined =
    options.toolRegistryDiagnosticHandler === null
      ? undefined
      : (options.toolRegistryDiagnosticHandler ?? consoleWarnDiagnosticHandler)

  if (options.enableMcp) {
    const mcpTools = await createMcpToolRegistry(options.cwd ?? process.cwd())
    for (const [name, tool] of mcpTools) {
      registerToolWithDiagnostics(tools, tool, diagnosticHandler)
    }
  }
  if (options.everCore?.config.mcpToolsEnabled && options.everCore.client) {
    const everCoreTools = createEverCoreMcpToolRegistry(options.everCore.client, options.everCore.config)
    for (const [name, tool] of everCoreTools) {
      registerToolWithDiagnostics(tools, tool, diagnosticHandler)
    }
  }
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
      registerToolWithDiagnostics(tools, tool, diagnosticHandler)
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

  let behaviorMonitor: BehaviorMonitor | undefined

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
          behaviorMonitor = new BehaviorMonitor({ cwd: defaultCwd })
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

  return { runtime, storage, tools, agentScheduler, remoteRunner: options.remoteRunner, behaviorMonitor }
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
  return resolveDefaultStoragePathForEnv(explicitPath, process.env)
}

/**
 * Env-parameterised twin of {@link resolveDefaultStoragePath} so
 * diagnostic surfaces (e.g. `bbl go --check`'s embedded-nexus-storage
 * line) can resolve the *would-be* storage path against an injected
 * env without mutating `process.env`. The runtime path still goes
 * through {@link resolveDefaultStoragePath} (which reads
 * `process.env`); this function is the shared, testable core.
 *
 * Mirrors the production-default resolution that `bbl go`'s embedded
 * Nexus child inherits: no explicit `NEXUS_STORAGE_PATH` → the
 * runtime's `resolveDefaultStoragePath(undefined)` lands on
 * `<configDir>/db.sqlite` (honouring `BABEL_O_CONFIG_DIR` /
 * `BABEL_O_CONFIG_FILE`), with `NODE_ENV === 'test'` and explicit
 * `:memory:` keeping the per-process memory backend for isolation.
 */
export function resolveDefaultStoragePathForEnv(
  explicitPath: string | undefined,
  env: NodeJS.ProcessEnv,
  homeDir: string = os.homedir(),
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
  if (explicitPath === undefined && env.NODE_ENV === 'test') {
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
  const configDir = resolveConfigDirForStorageEnv(env, homeDir)
  return { kind: 'sqlite', path: joinPath(configDir, 'db.sqlite') }
}

function resolveConfigDirForStorage(): string {
  return resolveConfigDirForStorageEnv(process.env)
}

function resolveConfigDirForStorageEnv(env: NodeJS.ProcessEnv, homeDir: string = os.homedir()): string {
  const fromDir = env.BABEL_O_CONFIG_DIR
  if (fromDir) return fromDir
  const fromFile = env.BABEL_O_CONFIG_FILE
  if (fromFile) return joinPath(fromFile, '..')
  return joinPath(homeDir, '.babel-o')
}

function resolveAbsolutePath(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(p)
}

function joinPath(...parts: string[]): string {
  return path.join(...parts)
}

