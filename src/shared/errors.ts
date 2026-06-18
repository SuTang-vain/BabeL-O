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

  // ----------------------------------------------------------------------
  // Tool Surface Expansion & Native vs MCP Coexistence Plan
  // (docs/nexus/reference/tool-surface-expansion-and-native-mcp-coexistence-plan.md)
  // §3.1.1 Task 工具族拆分 (4 codes; TASK_NOT_FOUND already registered above)
  // ----------------------------------------------------------------------
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
  TASK_TERMINAL: 'TASK_TERMINAL',
  TASK_IDENTITY_FIELD_READONLY: 'TASK_IDENTITY_FIELD_READONLY',

  // §3.1.2 AskUserQuestion (2 codes)
  ASK_QUESTION_OPTIONS_OUT_OF_RANGE: 'ASK_QUESTION_OPTIONS_OUT_OF_RANGE',
  ASK_QUESTION_NOT_ALLOWED_COLD_START: 'ASK_QUESTION_NOT_ALLOWED_COLD_START',

  // §3.1.3 MCPTool + ListMcpResources + ReadMcpResource (4 codes)
  MCP_SERVER_NOT_FOUND: 'MCP_SERVER_NOT_FOUND',
  MCP_RESOURCES_UNSUPPORTED: 'MCP_RESOURCES_UNSUPPORTED',
  MCP_RESOURCE_NOT_FOUND: 'MCP_RESOURCE_NOT_FOUND',
  MCP_TOOL_CALL_FAILED: 'MCP_TOOL_CALL_FAILED',

  // §3.1.4 Skill (2 codes)
  // Note: SKILL_* codes for validator/draft/save (8 codes) live in
  // src/skills/{validator,storage,generator}.ts return types; the model-visible
  // tool wrapper uses these two from errors.ts per the expansion plan.
  SKILL_NOT_FOUND: 'SKILL_NOT_FOUND',
  SKILL_NAME_REQUIRED: 'SKILL_NAME_REQUIRED',

  // §3.1.5 Plan mode (3 codes)
  PLAN_MODE_NOT_TRIGGERED: 'PLAN_MODE_NOT_TRIGGERED',
  PLAN_MODE_ALREADY_ACTIVE: 'PLAN_MODE_ALREADY_ACTIVE',
  PLAN_MODE_NOT_ACTIVE: 'PLAN_MODE_NOT_ACTIVE',

  // §3.2.1 Worktree (3 codes)
  NOT_IN_GIT_REPO: 'NOT_IN_GIT_REPO',
  WORKTREE_BRANCH_EXISTS: 'WORKTREE_BRANCH_EXISTS',
  WORKTREE_PATH_NOT_FOUND: 'WORKTREE_PATH_NOT_FOUND',

  // §3.2.2 WebSearch provider (1 code)
  WEB_SEARCH_PROVIDER_UNAVAILABLE: 'WEB_SEARCH_PROVIDER_UNAVAILABLE',

  // §3.2.3 Config (3 codes)
  CONFIG_KEY_NOT_WRITABLE: 'CONFIG_KEY_NOT_WRITABLE',
  CONFIG_KEY_NOT_FOUND: 'CONFIG_KEY_NOT_FOUND',
  CONFIG_RELOAD_FAILED: 'CONFIG_RELOAD_FAILED',

  // §3.2.4 Cron / Sleep (5 codes)
  SLEEP_ABORTED: 'SLEEP_ABORTED',
  SLEEP_DURATION_OUT_OF_RANGE: 'SLEEP_DURATION_OUT_OF_RANGE',
  CRON_EXPRESSION_INVALID: 'CRON_EXPRESSION_INVALID',
  CRON_JOB_NOT_FOUND: 'CRON_JOB_NOT_FOUND',
  CRON_PERSIST_FAILED: 'CRON_PERSIST_FAILED',
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
