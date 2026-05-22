export function checkOptimizerSafety(
  toolName: string,
  input: unknown,
  role?: string,
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
        if (['package.json', 'package-lock.json', 'tsconfig.json'].includes(fileName)) {
          return true
        }
        if (segments.includes('bin')) {
          return true
        }
        if (fileName.startsWith('.env')) {
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
      const commandRegex = /rm\s+-rf|git\s+push|npm\s+publish|sudo/
      if (commandRegex.test(typedInput.command)) {
        return {
          allowed: false,
          reason: `Command execution denied: command "${typedInput.command}" is blocklisted under optimizer role.`,
        }
      }
    }
  }

  return { allowed: true }
}


