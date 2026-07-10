/**
 * Error Registry for BabeL-O
 * 
 * Centralized error code management providing user-friendly hints
 * and documentation URLs for all error events.
 * 
 * Governance: Nexus owns error definition. Client consumes server hints.
 */

/**
 * Definition of an error code with user-facing information.
 */
export type ErrorDefinition = {
  /** Machine-readable error code */
  code: string
  /** User-friendly hint message */
  hint: string
  /** Optional documentation URL */
  docsUrl?: string
  /** Whether the hint requires context extraction from details */
  requiresContext?: boolean
}

/**
 * Registry of all known error codes with their user-facing information.
 * 
 * Principles:
 * 1. Every error code MUST have a hint.
 * 2. Hints should be actionable and avoid technical jargon.
 * 3. docsUrl should point to specific troubleshooting guides.
 */
export const ERROR_REGISTRY: Record<string, ErrorDefinition> = {
  // === Timeout Errors ===
  REQUEST_TIMEOUT: {
    code: 'REQUEST_TIMEOUT',
    hint: 'The task took too long. Ask the model to summarize, narrow scope, or split the task.',
    docsUrl: '/troubleshooting/REQUEST_TIMEOUT',
  },
  EXECUTION_TIMEOUT: {
    code: 'EXECUTION_TIMEOUT',
    hint: 'The execution timed out. Try a simpler task or run `/compact` to reduce context.',
    docsUrl: '/troubleshooting/REQUEST_TIMEOUT',
  },

  // === Context Errors ===
  CONTEXT_BLOCKING: {
    code: 'CONTEXT_BLOCKING',
    hint: 'Context is too large. The runtime will compact automatically, or run `/compact` manually.',
    docsUrl: '/troubleshooting/CONTEXT_BLOCKING',
  },
  CONTEXT_LIMIT_EXCEEDED: {
    code: 'CONTEXT_LIMIT_EXCEEDED',
    hint: 'Context exceeded the limit. Run `/compact` or reduce the scope of your task.',
    docsUrl: '/troubleshooting/CONTEXT_BLOCKING',
  },

  // === Provider Errors ===
  PROVIDER_AUTH_FAILED: {
    code: 'PROVIDER_AUTH_FAILED',
    hint: 'API key is invalid or expired. Run `bbl config audit` to check your credentials.',
    docsUrl: '/troubleshooting/PROVIDER_AUTH_FAILED',
    requiresContext: true,
  },
  PROVIDER_ERROR: {
    code: 'PROVIDER_ERROR',
    hint: 'Provider encountered an error. Check your API key and network connection.',
    docsUrl: '/troubleshooting/PROVIDER_AUTH_FAILED',
  },
  EMPTY_PROVIDER_RESPONSE: {
    code: 'EMPTY_PROVIDER_RESPONSE',
    hint: 'Provider returned an empty response. Try again or check your API quota.',
    docsUrl: '/troubleshooting/PROVIDER_AUTH_FAILED',
  },

  // === Tool Errors ===
  WORKTREE_CONFLICT: {
    code: 'WORKTREE_CONFLICT',
    hint: 'Worktree merge conflict detected. Use `bbl sessions worktree-recovery` to resolve.',
    docsUrl: '/troubleshooting/WORKTREE_CONFLICT',
  },
  TOOL_RESULT_BUDGET_EXCEEDED: {
    code: 'TOOL_RESULT_BUDGET_EXCEEDED',
    hint: 'Tool output too large. The runtime will truncate automatically, or use more specific paths.',
    docsUrl: '/troubleshooting/TOOL_RESULT_BUDGET_EXCEEDED',
  },
  TOOL_NOT_FOUND: {
    code: 'TOOL_NOT_FOUND',
    hint: 'Unknown tool requested. Run `/tools` to see available tools.',
  },
  INVALID_TOOL_INPUT: {
    code: 'INVALID_TOOL_INPUT',
    hint: 'Tool input is invalid. Check the tool schema and try again.',
  },
  TOOL_EXECUTION_FAILED: {
    code: 'TOOL_EXECUTION_FAILED',
    hint: 'Tool execution failed. Check the error details and try again.',
  },
  TOOL_INPUT_PARSE_ERROR: {
    code: 'TOOL_INPUT_PARSE_ERROR',
    hint: 'Tool input could not be parsed. Check the JSON syntax and try again.',
  },
  TOOL_LOOP_FINAL_RESPONSE_ONLY: {
    code: 'TOOL_LOOP_FINAL_RESPONSE_ONLY',
    hint: 'Tool loop ended without completing the task. Try a different approach.',
  },
  TOOL_CALL_TEXT_LEAK_SUPPRESSED: {
    code: 'TOOL_CALL_TEXT_LEAK_SUPPRESSED',
    hint: 'Tool call was suppressed due to policy. Check permission settings.',
  },
  REMOTE_RUNNER_TOOL_UNSUPPORTED: {
    code: 'REMOTE_RUNNER_TOOL_UNSUPPORTED',
    hint: 'Tool not supported by remote runner. Use local execution or choose a different tool.',
  },
  REMOTE_RUNNER_TOOL_ERROR: {
    code: 'REMOTE_RUNNER_TOOL_ERROR',
    hint: 'Remote runner encountered an error. Check network and try again.',
  },

  // === Loop Errors ===
  MAX_LOOPS_EXCEEDED: {
    code: 'MAX_LOOPS_EXCEEDED',
    hint: 'Maximum tool loops exceeded. Simplify your task or break it into smaller pieces.',
  },
  MAX_OUTPUT_TOKENS_EXCEEDED: {
    code: 'MAX_OUTPUT_TOKENS_EXCEEDED',
    hint: 'Output too long. Ask for a shorter response or split the task.',
  },

  // === Cancellation ===
  REQUEST_CANCELLED: {
    code: 'REQUEST_CANCELLED',
    hint: 'Request was cancelled.',
  },

  // === Profile Errors (from Go TUI friendlyNexusErrorWithContext) ===
  tombstoned_profile: {
    code: 'tombstoned_profile',
    hint: 'Profile is tombstoned. Restore via `bbl config profile restore <name>`.',
    requiresContext: true,
  },
  unknown_profile: {
    code: 'unknown_profile',
    hint: 'Unknown profile name. Run `bbl config list` to see available profiles.',
    requiresContext: true,
  },
  not_supported: {
    code: 'not_supported',
    hint: 'Model/role switching is not supported via HTTP. Use `bbl config use <modelId>` CLI.',
  },
  missing_profile: {
    code: 'missing_profile',
    hint: 'Missing profile name in request body.',
  },
  missing_provider_api_key: {
    code: 'missing_provider_api_key',
    hint: 'Provider needs an API key. Run `/model` to configure or use `bbl config add <provider> <KEY>`.',
    requiresContext: true,
  },
  unknown_provider: {
    code: 'unknown_provider',
    hint: 'Unknown provider name. Run `bbl models` to see available providers.',
    requiresContext: true,
  },
}

/**
 * Humanizes an error by adding user-friendly hint and docsUrl.
 * 
 * @param code - Machine-readable error code
 * @param message - Original error message
 * @param details - Optional error details for context extraction
 * @returns Object with code, message, and optional hint/docsUrl
 */
export function humanizeError(
  code: string,
  message: string,
  details?: unknown
): { code: string; message: string; hint?: string; docsUrl?: string } {
  const def = ERROR_REGISTRY[code]
  
  if (!def) {
    // Unregistered error code: return original message
    return { code, message }
  }

  let hint = def.hint
  
  // Inject context from details if needed
  if (def.requiresContext && details && typeof details === 'object' && details !== null) {
    const detailsRecord = details as Record<string, unknown>
    
    // Handle specific context injections
    if (code === 'tombstoned_profile' && detailsRecord.profile) {
      hint = `Profile "${detailsRecord.profile}" is tombstoned. Restore via \`bbl config profile restore ${detailsRecord.profile}\`.`
    } else if (code === 'unknown_profile' && detailsRecord.profile) {
      hint = `Unknown profile "${detailsRecord.profile}". Run \`bbl config list\` to see available profiles.`
    } else if (code === 'missing_provider_api_key') {
      const provider = detailsRecord.provider as string | undefined
      const model = detailsRecord.model as string | undefined
      if (provider) {
        hint = `Provider "${provider}" needs an API key${model ? ` before selecting "${model}"` : ''}. Run \`/model\` to configure or use \`bbl config add ${provider} <KEY>\`.`
      }
    } else if (code === 'unknown_provider' && detailsRecord.provider) {
      hint = `Unknown provider "${detailsRecord.provider}". Run \`bbl models\` to see available providers.`
    }
  }

  return {
    code,
    message,
    hint,
    docsUrl: def.docsUrl,
  }
}

/**
 * List all registered error codes.
 */
export function listErrorCodes(): string[] {
  return Object.keys(ERROR_REGISTRY)
}

/**
 * Check if an error code is registered.
 */
export function isKnownErrorCode(code: string): boolean {
  return code in ERROR_REGISTRY
}
