import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { ToolDefinition } from '../Tool.js'

const execFileAsync = promisify(execFile)

// Maintain a map of sessionId -> last active CWD
const sessionCwdMap = new Map<string, string>()

/**
 * Parses the raw stdout to extract the tracked CWD and strips the probe lines.
 */
function parseStateFromStdout(stdout: string): { cleanStdout: string; detectedCwd: string | null } {
  const marker = '---BABEL_O_STATE---'
  const idx = stdout.lastIndexOf(marker)
  if (idx !== -1) {
    const cleanStdout = stdout.substring(0, idx).trimEnd()
    const statePart = stdout.substring(idx + marker.length).trim()
    const lastCwd = statePart.split(/\r?\n/)[0]?.trim() || null
    return { cleanStdout, detectedCwd: lastCwd }
  }
  return { cleanStdout: stdout, detectedCwd: null }
}

const inputSchema = z.object({
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().max(30_000).default(10_000),
})

export const bashTool: ToolDefinition<typeof inputSchema> = {
  name: 'Bash',
  description: 'Run a shell command in the workspace.',
  risk: 'execute',
  inputSchema,
  async execute(input, context) {
    const currentCwd = sessionCwdMap.get(context.sessionId) ?? context.cwd

    // Inject state probing code to capture the final CWD and exit code
    const wrappedCommand = `${input.command}
_EXIT_CODE=$?
echo ""
echo "---BABEL_O_STATE---"
pwd -P
exit $_EXIT_CODE`

    try {
      const { stdout, stderr } = await execFileAsync(
        process.env.SHELL ?? '/bin/sh',
        ['-lc', wrappedCommand],
        {
          cwd: currentCwd,
          timeout: input.timeoutMs,
          signal: context.signal,
          maxBuffer: context.bashMaxBufferBytes,
        },
      )

      const { cleanStdout, detectedCwd } = parseStateFromStdout(stdout)
      if (detectedCwd) {
        sessionCwdMap.set(context.sessionId, detectedCwd)
      }

      return {
        success: true,
        output: { stdout: cleanStdout, stderr },
      }
    } catch (err: any) {
      // Even if the command fails, salvage any CWD change that occurred prior to the failure
      const stdoutStr = typeof err.stdout === 'string' ? err.stdout : ''
      const stderrStr = typeof err.stderr === 'string' ? err.stderr : ''
      const { cleanStdout, detectedCwd } = parseStateFromStdout(stdoutStr)
      if (detectedCwd) {
        sessionCwdMap.set(context.sessionId, detectedCwd)
      }

      // Re-write the error message to mask the wrapped command and internal probe marker
      let cleanedMessage = err.message || 'Command failed'
      if (typeof wrappedCommand === 'string' && typeof input.command === 'string') {
        cleanedMessage = cleanedMessage.replace(wrappedCommand, input.command)
      }
      cleanedMessage = cleanedMessage.replace(/---BABEL_O_STATE---/g, '')

      const newErr = new Error(cleanedMessage) as any
      newErr.code = err.code
      newErr.signal = err.signal
      newErr.stdout = cleanStdout
      newErr.stderr = stderrStr
      throw newErr
    }
  },
}

