export type OptimizerSafetyPolicy = {
  protectedFileNames: string[]
  protectedPathSegments: string[]
  protectedFilePrefixes: string[]
  deniedCommandPatterns: RegExp[]
}

export const defaultOptimizerSafetyPolicy: OptimizerSafetyPolicy = {
  protectedFileNames: [
    'package.json',
    'package-lock.json',
    'npm-shrinkwrap.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lockb',
    'tsconfig.json',
  ],
  protectedPathSegments: ['bin'],
  protectedFilePrefixes: ['.env'],
  deniedCommandPatterns: [
    /\brm\s+-[rf]*f[rf]*\b/,
    /\bgit\s+push\b/,
    /\bnpm\s+publish\b/,
    /\bsudo\b/,
    /\bgit\s+reset\s+--hard\b/,
    /\bgit\s+clean\s+-[^\s]*f/,
  ],
}

export function checkOptimizerSafety(
  toolName: string,
  input: unknown,
  role?: string,
  policy: OptimizerSafetyPolicy = defaultOptimizerSafetyPolicy,
): { allowed: boolean; reason?: string } {
  if (role !== 'optimizer') {
    return { allowed: true }
  }

  // 1. Files blocklist for Write/Edit tools
  if (['Write', 'Edit'].includes(toolName)) {
    const typedInput = input as { path?: string }
    if (typedInput && typeof typedInput.path === 'string') {
      const isForbidden = (filePath: string) => {
        const normalized = filePath.replace(/\\/g, '/')
        const segments = normalized.split('/')
        const fileName = segments[segments.length - 1]
        if (policy.protectedFileNames.includes(fileName)) {
          return true
        }
        if (segments.some(segment => policy.protectedPathSegments.includes(segment))) {
          return true
        }
        if (policy.protectedFilePrefixes.some(prefix => fileName.startsWith(prefix))) {
          return true
        }
        return false
      }

      if (isForbidden(typedInput.path)) {
        return {
          allowed: false,
          reason: `File modification denied: path "${typedInput.path}" is blocklisted under optimizer role.`,
        }
      }
    }
  }

  // 2. Commands blocklist for Bash tool
  if (toolName === 'Bash') {
    const typedInput = input as { command?: string }
    if (typedInput && typeof typedInput.command === 'string') {
      const command = typedInput.command
      if (policy.deniedCommandPatterns.some(pattern => pattern.test(command))) {
        return {
          allowed: false,
          reason: `Command execution denied: command "${command}" is blocklisted under optimizer role.`,
        }
      }
    }
  }

  return { allowed: true }
}
