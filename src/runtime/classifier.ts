import { isAbsolute, relative, resolve } from 'node:path'
import { getBashFileDiscoveryGuidance } from '../shared/bashDiscoveryGuidance.js'

export type ClassificationResult = {
  autoApprove: boolean
  reason: string
}

export type ClassificationContext = {
  cwd?: string
}

type ShellTokenizationResult = {
  tokens: string[]
  unsafeSyntax?: string
}

const UNSAFE_SHELL_OPERATORS = new Set(['|', '||', '&', '&&', ';', '>', '>>', '<', '<<'])

function tokenizeShellCommand(command: string): ShellTokenizationResult {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]
    const next = command[i + 1]

    if (escaped) {
      current += char
      escaped = false
      continue
    }

    if (char === '\\') {
      escaped = true
      continue
    }

    if (quote) {
      if (char === quote) {
        quote = null
        continue
      }
      if (quote === '"' && char === '$') {
        return { tokens, unsafeSyntax: 'Shell variable or command expansion is not auto-approved' }
      }
      if (quote === '"' && char === '`') {
        return { tokens, unsafeSyntax: 'Command substitution is not auto-approved' }
      }
      current += char
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }

    if (char === '$') {
      return { tokens, unsafeSyntax: 'Shell variable or command expansion is not auto-approved' }
    }
    if (char === '`') {
      return { tokens, unsafeSyntax: 'Command substitution is not auto-approved' }
    }

    if ('|&;<>'.includes(char)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      const twoChar = char + (next ?? '')
      if (UNSAFE_SHELL_OPERATORS.has(twoChar)) {
        tokens.push(twoChar)
        i += 1
      } else {
        tokens.push(char)
      }
      continue
    }

    current += char
  }

  if (escaped) return { tokens, unsafeSyntax: 'Trailing escape is not auto-approved' }
  if (quote) return { tokens, unsafeSyntax: 'Unclosed quote is not auto-approved' }
  if (current) tokens.push(current)
  if (tokens.some(token => UNSAFE_SHELL_OPERATORS.has(token))) {
    return { tokens, unsafeSyntax: 'Shell operators require manual review' }
  }
  return { tokens }
}

function classifySafeBashTokens(tokens: string[], context: ClassificationContext = {}): ClassificationResult | null {
  const [command, ...args] = tokens
  if (!command) return { autoApprove: false, reason: 'Empty bash command input' }

  if (command === 'pwd' && args.length === 0) {
    return { autoApprove: true, reason: 'Known safe command' }
  }

  if (command === 'ls') {
    const safe = args.every(arg => arg === '--' || /^-[A-Za-z1-9]+$/.test(arg) || !arg.startsWith('-'))
    return safe ? { autoApprove: true, reason: 'Known safe command' } : null
  }

  if (command === 'cat') {
    const pathArgs = args.filter(arg => arg !== '--' && arg !== '-n' && arg !== '-b')
    const safe = pathArgs.length > 0 && pathArgs.every(arg =>
      !arg.startsWith('-') &&
      !arg.startsWith('/dev/') &&
      !arg.includes('*') &&
      !arg.includes('?') &&
      isPathInsideClassifierWorkspace(arg, context.cwd),
    )
    return safe ? { autoApprove: true, reason: 'Known safe command' } : null
  }

  if (command === 'git') {
    const [subcommand, ...gitArgs] = args
    if (subcommand === 'status') {
      const safe = gitArgs.every(arg => [
        '--short',
        '--porcelain',
        '--porcelain=v1',
        '--porcelain=v2',
        '--branch',
        '--show-stash',
        '-s',
        '-b',
      ].includes(arg))
      return safe ? { autoApprove: true, reason: 'Known safe command' } : null
    }
    if (subcommand === 'diff') {
      const safe = gitArgs.every(arg =>
        arg === '--' ||
        arg === '--stat' ||
        arg === '--name-only' ||
        arg === '--cached' ||
        arg === '--staged' ||
        arg === '--check' ||
        arg === 'HEAD' ||
        /^[A-Za-z0-9._/@:-]+$/.test(arg),
      )
      return safe ? { autoApprove: true, reason: 'Known safe command' } : null
    }
    if (subcommand === 'log') {
      const safe = gitArgs.every(arg =>
        arg === '--oneline' ||
        arg === '--decorate' ||
        arg === '--graph' ||
        /^-[0-9]+$/.test(arg) ||
        /^--max-count=\d+$/.test(arg) ||
        /^[A-Za-z0-9._/@:-]+$/.test(arg),
      )
      return safe ? { autoApprove: true, reason: 'Known safe command' } : null
    }
  }

  if (command === 'npm' && args[0] === 'list') {
    const safe = args.slice(1).every(arg =>
      arg === '--depth=0' ||
      arg === '--json' ||
      arg === '--parseable' ||
      arg === '--long' ||
      /^[A-Za-z0-9@/_-]+$/.test(arg),
    )
    return safe ? { autoApprove: true, reason: 'Known safe command' } : null
  }

  if (command === 'npx' && args[0] === 'tsc') {
    const compilerArgs = args.slice(1)
    const safe = compilerArgs.length > 0 && compilerArgs.every(arg =>
      arg === '--noEmit' ||
      arg === '--pretty' ||
      arg === 'false' ||
      arg === 'true' ||
      arg === '-p' ||
      arg === '--project' ||
      /^[A-Za-z0-9._/-]+$/.test(arg),
    )
    return safe && compilerArgs.includes('--noEmit')
      ? { autoApprove: true, reason: 'Known safe command' }
      : null
  }

  return null
}

function isPathInsideClassifierWorkspace(path: string, cwd?: string): boolean {
  if (!cwd) return !isAbsolute(path)
  const resolvedCwd = resolve(cwd)
  const resolvedPath = resolve(resolvedCwd, path)
  const rel = relative(resolvedCwd, resolvedPath)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Classifies an incoming tool execution request to determine if it can be automatically
 * approved or if it must prompt the user for manual verification.
 */
export function classifyAction(
  toolName: string,
  input: unknown,
  context: ClassificationContext = {},
): ClassificationResult {
  const name = toolName.trim()

  // 1. Read-only query tools are safe to execute immediately
  if (['ListDir', 'Glob', 'Grep', 'Read'].includes(name)) {
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
    const tokenized = tokenizeShellCommand(trimmed)
    if (tokenized.unsafeSyntax) {
      return { autoApprove: false, reason: tokenized.unsafeSyntax }
    }

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

    const discoveryGuidance = getBashFileDiscoveryGuidance(trimmed)
    if (discoveryGuidance && discoveryGuidance.commandKind !== 'ls') {
      return {
        autoApprove: false,
        reason: `${discoveryGuidance.message} Bash execution requires manual review.`,
      }
    }

    const safeCommand = classifySafeBashTokens(tokenized.tokens, context)
    if (safeCommand) {
      return safeCommand
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
