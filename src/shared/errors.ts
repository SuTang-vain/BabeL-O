export const ErrorCodes = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  TOOL_DENIED: 'TOOL_DENIED',
  REQUEST_TIMEOUT: 'REQUEST_TIMEOUT',
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

export class ProviderError extends NexusError {
  constructor(
    public readonly providerId: string,
    public readonly httpStatus: number,
    public readonly rawMessage: string,
  ) {
    super(
      `Provider '${providerId}' request failed with status ${httpStatus}: ${rawMessage}`,
      ErrorCodes.PROVIDER_ERROR,
      502,
    )
    this.name = 'ProviderError'
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
