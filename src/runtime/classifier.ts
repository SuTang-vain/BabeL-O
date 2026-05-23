export type ClassificationResult = {
  autoApprove: boolean
  reason: string
}

/**
 * Classifies an incoming tool execution request to determine if it can be automatically
 * approved or if it must prompt the user for manual verification.
 */
export function classifyAction(
  toolName: string,
  input: unknown
): ClassificationResult {
  const name = toolName.trim()

  // 1. Read-only query tools are safe to execute immediately
  if (['Read', 'Grep', 'Glob'].includes(name)) {
    return { autoApprove: true, reason: 'Read-only tool' }
  }

  // 2. Fine-grained classification for shell (Bash) commands
  if (name === 'Bash') {
    const cmd = (input && typeof input === 'object' && 'command' in input)
      ? (input as { command: unknown }).command
      : undefined
    if (typeof cmd !== 'string') {

      return { autoApprove: false, reason: 'Invalid bash command input' }
    }
    const trimmed = cmd.trim()

    // Blacklist regexes checking for dangerous destructive actions
    const dangerousPatterns = [
      /\brm\s+-[rf]*f[rf]*\b/,
      /\bsudo\b/,
      /\bcurl\s+.*\|\s*(?:bash|sh)\b/,
      /\bwget\s+.*\|\s*(?:bash|sh)\b/,
      /\bnpm\s+publish\b/,
      /\bgit\s+push\b/
    ]

    if (dangerousPatterns.some(regex => regex.test(trimmed))) {
      return { autoApprove: false, reason: 'Potentially destructive or unauthorized action detected' }
    }

    // Whitelist regexes checking for safe status, read, and testing commands
    const safePatterns = [
      /^(?:ls|pwd|cat|git\s+status|git\s+diff|git\s+log|npm\s+list|npm\s+test|npx\s+tsc)(?:\s+.*)?$/
    ]

    if (safePatterns.some(regex => regex.test(trimmed))) {
      return { autoApprove: true, reason: 'Known safe command' }
    }

    // Default other bash commands to manual confirmation
    return { autoApprove: false, reason: 'Requires manual review' }
  }

  // 3. Write or Edit tools that modify files directly should always prompt the user
  if (['Write', 'Edit'].includes(name)) {
    return { autoApprove: false, reason: 'Write or Edit operation requires manual review' }
  }

  // 4. Default fallback for any other tools
  return { autoApprove: false, reason: 'Default ask' }
}
