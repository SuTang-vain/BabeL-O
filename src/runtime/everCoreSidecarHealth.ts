import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { errorMessage } from '../shared/errors.js'

export type EverCoreSidecarHealthState = 'healthy' | 'unhealthy' | 'not_running'

export type EverCoreSidecarHealthProbe = {
  state: EverCoreSidecarHealthState
  url?: string
  errorCode?: string
  errorMessage?: string
}

type SidecarRegistry = {
  version?: number
  baseUrl?: string
  host?: string
  port?: number
  dataDir?: string
}

/**
 * Probe the managed EverCore sidecar's actual health by reading the
 * sidecar-registry.json the spawner writes under <dataDir>/ and hitting its
 * /health endpoint. This is the honest counterpart to the bootstrap
 * `buildStatus` (which only reflects binary build success, not sidecar
 * runnability) — used by `bbl memory status` / `bbl doctor` so they stop
 * reporting "ready" while the sidecar is in fact dead.
 *
 * Intentionally independent of `src/nexus/everCoreSidecar.ts` (which lives in
 * a higher layer) so the runtime-layer CLI status paths can call it without
 * crossing the layer-direction boundary.
 */
export async function probeEverCoreSidecarHealth(
  dataDir: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<EverCoreSidecarHealthProbe> {
  if (!dataDir) return { state: 'not_running' }
  const registryPath = join(dataDir, 'sidecar-registry.json')
  let registry: SidecarRegistry | undefined
  try {
    const raw = await readFile(registryPath, 'utf8')
    registry = JSON.parse(raw) as SidecarRegistry
  } catch {
    return { state: 'not_running' }
  }
  if (!registry?.baseUrl) return { state: 'not_running' }
  try {
    const response = await fetchImpl(`${registry.baseUrl}/health`, { method: 'GET' })
    if (!response.ok) {
      return {
        state: 'unhealthy',
        url: registry.baseUrl,
        errorCode: 'EVERCORE_SIDECAR_HEALTH_HTTP_ERROR',
        errorMessage: `sidecar /health returned HTTP ${response.status}`,
      }
    }
    return { state: 'healthy', url: registry.baseUrl }
  } catch (error) {
    return {
      state: 'unhealthy',
      url: registry.baseUrl,
      errorCode: 'EVERCORE_SIDECAR_HEALTH_UNREACHABLE',
      errorMessage: errorMessage(error),
    }
  }
}

export function formatEverCoreSidecarHealthLine(probe: EverCoreSidecarHealthProbe): string {
  switch (probe.state) {
    case 'healthy':
      return `sidecar: healthy`
    case 'unhealthy':
      return `sidecar: unhealthy (${probe.errorCode ?? 'unknown'}${probe.errorMessage ? `: ${probe.errorMessage}` : ''})`
    case 'not_running':
    default:
      return `sidecar: not running`
  }
}
