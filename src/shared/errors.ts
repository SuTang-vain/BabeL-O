export class NexusError extends Error {
  constructor(
    message: string,
    public readonly code = 'NEXUS_ERROR',
    public readonly statusCode = 500,
  ) {
    super(message)
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
