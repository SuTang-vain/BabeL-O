import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { ConfigManager } from '../../shared/config.js'
import { NEXUS_EVENT_SCHEMA_VERSION } from '../../shared/events.js'
import { nowIso } from '../../shared/id.js'
import { BABEL_O_VERSION } from '../../shared/version.js'
import { runProviderSmokeDryRun } from '../../runtime/providerSmoke.js'
import type { FeatureRouter } from '../router.js'

function readOwnPackageVersion(): string {
  try {
    const candidates = [fileURLToPath(new URL('../../../package.json', import.meta.url)), fileURLToPath(new URL('../../package.json', import.meta.url))]
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        const raw = readFileSync(candidate, 'utf8')
        const parsed = JSON.parse(raw) as { version?: unknown }
        if (typeof parsed.version === 'string' && parsed.version.length > 0) {
          return parsed.version
        }
      }
    }
  } catch {
    // fall through
  }
  return '0.0.0-unknown'
}

export const runtimeStatusRouter: FeatureRouter = {
  name: 'runtime-status',
  register(app, context) {
    const { options } = context

    app.get('/health', async () => ({
      status: 'ok',
      version: BABEL_O_VERSION,
      runtime: 'babel-o',
      timestamp: nowIso(),
    }))

    app.get('/v1/runtime/status', async () => ({
      type: 'runtime_status',
      health: {
        status: 'ok',
        version: BABEL_O_VERSION,
      },
      provider: ConfigManager.getInstance().getProviderDiagnostics(),
      providerSmoke: runProviderSmokeDryRun(),
      remoteRunner: options.remoteRunnerStatus ?? {
        configured: options.remoteRunner !== undefined,
        required: false,
        healthy: options.remoteRunner !== undefined,
        id: options.remoteRunner?.id,
        capabilities: options.remoteRunner?.capabilities,
      },
      everCore: context.everCoreStatus(),
      bootstrap: context.everOSBootstrapStatus(),
      metrics: await context.runtimeMetricsSnapshot(),
      sessions: await options.storage.listSessions({ limit: 20 }),
    }))

    app.get('/v1/runtime/version', async () => {
      const rawVersion = readOwnPackageVersion()
      return {
        type: 'runtime_version' as const,
        serverVersion: rawVersion,
        schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
        goTuiCompatibility: {
          supportedMajors: [0],
          latestSupported: rawVersion,
        },
        nodeCliCompatibility: {
          supportedMajors: [0],
          latestSupported: rawVersion,
        },
      }
    })
  },
}
