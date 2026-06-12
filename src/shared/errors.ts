export const ErrorCodes = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  TOOL_DENIED: 'TOOL_DENIED',
  REQUEST_TIMEOUT: 'REQUEST_TIMEOUT',
  REQUEST_CANCELLED: 'REQUEST_CANCELLED',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  EXECUTION_BUSY: 'EXECUTION_BUSY',
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  TOOL_NOT_FOUND: 'TOOL_NOT_FOUND',
  INVALID_TOOL_INPUT: 'INVALID_TOOL_INPUT',
  MAX_LOOPS_EXCEEDED: 'MAX_LOOPS_EXCEEDED',
} as const

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes]

export class NexusError extends Error {
  constructor(
    message: string,
    public readonly code: string = 'NEXUS_ERROR',
    public readonly statusCode = 500,
  ) {
    super(message)
  }
}

export type ProviderErrorMetadata = {
  code?: string
  type?: string
  message?: string
  requestId?: string
}

export class ProviderError extends NexusError {
  readonly metadata: ProviderErrorMetadata

  constructor(
    public readonly providerId: string,
    public readonly httpStatus: number,
    public readonly rawMessage: string,
  ) {
    const metadata = parseProviderErrorMetadata(rawMessage)
    super(
      formatProviderError(providerId, httpStatus, rawMessage, metadata),
      ErrorCodes.PROVIDER_ERROR,
      502,
    )
    this.name = 'ProviderError'
    this.metadata = metadata
  }
}

function formatProviderError(
  providerId: string,
  httpStatus: number,
  rawMessage: string,
  metadata: ProviderErrorMetadata,
): string {
  const details = formatProviderErrorMessage(rawMessage, metadata)
  if (httpStatus === 401 || httpStatus === 403) {
    return `Provider '${providerId}' returned ${httpStatus} (no/invalid API key). Run: bbl config add ${providerId} <KEY>. ${details}`
  }
  return `Provider '${providerId}' request failed with status ${httpStatus}: ${details}`
}

function parseProviderErrorMetadata(rawMessage: string): ProviderErrorMetadata {
  try {
    const parsed = JSON.parse(rawMessage)
    const error = isRecord(parsed.error) ? parsed.error : parsed
    return {
      code: stringifyProviderErrorField(error.code),
      type: stringifyProviderErrorField(error.type),
      message: typeof error.message === 'string' ? error.message : undefined,
      requestId: typeof parsed.request_id === 'string'
        ? parsed.request_id
        : typeof parsed.requestId === 'string'
          ? parsed.requestId
          : undefined,
    }
  } catch {
    return {}
  }
}

function formatProviderErrorMessage(rawMessage: string, metadata: ProviderErrorMetadata): string {
  const parts = [
    metadata.code ? `code=${metadata.code}` : undefined,
    metadata.type ? `type=${metadata.type}` : undefined,
    metadata.message,
    metadata.requestId ? `request_id=${metadata.requestId}` : undefined,
  ].filter((part): part is string => Boolean(part))
  return parts.length > 0 ? parts.join(' ') : rawMessage
}

function stringifyProviderErrorField(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
