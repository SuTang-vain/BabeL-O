import { errorMessage } from '../shared/errors.js'
import {
  HttpRemoteToolRunner,
  REMOTE_RUNNER_PROTOCOL_VERSION,
  type RemoteToolRunner,
  type RemoteToolRunnerCapability,
} from '../runtime/remoteRunner.js'

export type RemoteRunnerConfigInput = {
  url?: string
  required?: boolean
  fetch?: typeof fetch
}

export type RemoteRunnerStatus = {
  configured: boolean
  required: boolean
  healthy: boolean
  url?: string
  id?: string
  protocolVersion?: string
  capabilities?: RemoteToolRunnerCapability
  errorCode?: string
  errorMessage?: string
}

export type ConfiguredRemoteRunner = {
  runner?: RemoteToolRunner
  status: RemoteRunnerStatus
}

type CapabilitiesResponse = {
  protocolVersion?: unknown
  id?: unknown
  capabilities?: unknown
}

export async function configureRemoteRunnerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ConfiguredRemoteRunner> {
  return configureRemoteRunner({
    url: env.NEXUS_REMOTE_RUNNER_URL,
    required: parseBoolean(env.NEXUS_REMOTE_RUNNER_REQUIRED) ?? false,
  })
}

export async function configureRemoteRunner(
  input: RemoteRunnerConfigInput = {},
): Promise<ConfiguredRemoteRunner> {
  const url = input.url?.trim()
  const required = input.required ?? false
  if (!url) {
    return {
      status: {
        configured: false,
        required,
        healthy: !required,
        errorCode: required ? 'REMOTE_RUNNER_URL_REQUIRED' : undefined,
        errorMessage: required ? 'NEXUS_REMOTE_RUNNER_REQUIRED=1 requires NEXUS_REMOTE_RUNNER_URL.' : undefined,
      },
    }
  }

  const redactedUrl = redactRemoteRunnerUrl(url)
  try {
    const capabilities = await fetchRemoteRunnerCapabilities(url, input.fetch)
    if (capabilities.protocolVersion !== REMOTE_RUNNER_PROTOCOL_VERSION) {
      return {
        status: {
          configured: true,
          required,
          healthy: false,
          url: redactedUrl,
          id: typeof capabilities.id === 'string' ? capabilities.id : undefined,
          protocolVersion: typeof capabilities.protocolVersion === 'string' ? capabilities.protocolVersion : undefined,
          errorCode: 'REMOTE_RUNNER_PROTOCOL_MISMATCH',
          errorMessage: `Remote runner protocol ${String(capabilities.protocolVersion)} does not match ${REMOTE_RUNNER_PROTOCOL_VERSION}.`,
        },
      }
    }
    const runnerCapabilities = normalizeCapabilities(capabilities.capabilities)
    const runner = new HttpRemoteToolRunner({
      id: typeof capabilities.id === 'string' ? capabilities.id : undefined,
      baseUrl: url,
      capabilities: runnerCapabilities,
      fetch: input.fetch,
    })
    return {
      runner,
      status: {
        configured: true,
        required,
        healthy: true,
        url: redactedUrl,
        id: runner.id,
        protocolVersion: REMOTE_RUNNER_PROTOCOL_VERSION,
        capabilities: runnerCapabilities,
      },
    }
  } catch (error) {
    return {
      status: {
        configured: true,
        required,
        healthy: false,
        url: redactedUrl,
        errorCode: 'REMOTE_RUNNER_CAPABILITIES_FAILED',
        errorMessage: errorMessage(error),
      },
    }
  }
}

export function assertRemoteRunnerReady(status: RemoteRunnerStatus): void {
  if (status.required && !status.healthy) {
    const message = status.errorMessage ?? 'Required remote runner is not healthy.'
    throw new Error(`NEXUS_REMOTE_RUNNER_REQUIRED failed: ${message}`)
  }
}

export function parseAgentExecutionEnvironment(value: string | undefined): 'local' | 'remote' | undefined {
  if (!value) return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === 'local' || normalized === 'remote') return normalized
  throw new Error('NEXUS_AGENT_EXECUTION_ENVIRONMENT must be local or remote.')
}

export function assertAgentRemoteExecutionReady(
  executionEnvironment: 'local' | 'remote' | undefined,
  status: RemoteRunnerStatus,
): void {
  if (executionEnvironment === 'remote' && (!status.configured || !status.healthy)) {
    const message = status.errorMessage ?? 'NEXUS_AGENT_EXECUTION_ENVIRONMENT=remote requires a healthy NEXUS_REMOTE_RUNNER_URL.'
    throw new Error(message)
  }
}

async function fetchRemoteRunnerCapabilities(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CapabilitiesResponse> {
  const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/v1/remote-runner/capabilities`)
  if (!response.ok) {
    throw new Error(`Remote runner capabilities returned HTTP ${response.status}.`)
  }
  const body = await response.json()
  if (!body || typeof body !== 'object') {
    throw new Error('Remote runner capabilities response must be an object.')
  }
  return body as CapabilitiesResponse
}

function normalizeCapabilities(value: unknown): RemoteToolRunnerCapability {
  if (!value || typeof value !== 'object') return { tools: [] }
  const raw = value as Record<string, unknown>
  const tools = Array.isArray(raw.tools)
    ? raw.tools.filter((tool): tool is string => typeof tool === 'string')
    : []
  return {
    tools,
    ...(typeof raw.readOnly === 'boolean' ? { readOnly: raw.readOnly } : {}),
    ...(typeof raw.bashEnabled === 'boolean' ? { bashEnabled: raw.bashEnabled } : {}),
    ...(typeof raw.writeEnabled === 'boolean' ? { writeEnabled: raw.writeEnabled } : {}),
    ...(typeof raw.maxConcurrentTools === 'number' ? { maxConcurrentTools: raw.maxConcurrentTools } : {}),
    ...(typeof raw.maxOutputBytes === 'number' ? { maxOutputBytes: raw.maxOutputBytes } : {}),
    ...(typeof raw.defaultDeadlineMs === 'number' ? { defaultDeadlineMs: raw.defaultDeadlineMs } : {}),
    ...(typeof raw.maxDeadlineMs === 'number' ? { maxDeadlineMs: raw.maxDeadlineMs } : {}),
  }
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (!value) return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true
  if (normalized === '0' || normalized === 'false' || normalized === 'no') return false
  return undefined
}

function redactRemoteRunnerUrl(raw: string): string {
  try {
    const url = new URL(raw)
    url.username = ''
    url.password = ''
    for (const key of [...url.searchParams.keys()]) {
      url.searchParams.set(key, '<redacted>')
    }
    return url.toString()
  } catch {
    return raw.replace(/\/\/[^/@]+@/, '//<redacted>@')
  }
}
