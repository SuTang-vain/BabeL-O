import { execFile } from 'node:child_process'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { ToolDefinition } from '../Tool.js'

const execFileAsync = promisify(execFile)
const sessionProbeSecret = randomBytes(32)
const SESSION_CWD_TTL_MS = 24 * 60 * 60 * 1000
const SESSION_CWD_SWEEP_INTERVAL_MS = 60 * 60 * 1000

// Maintain a map of sessionId -> last active CWD
const sessionCwdMap = new Map<string, { cwd: string; lastActiveAt: number }>()

type StateProbe = {
  marker: string
  nonce: string
  signature: string
}

function createStateProbe(): StateProbe {
  const nonce = randomBytes(16).toString('hex')
  const signature = createHmac('sha256', sessionProbeSecret)
    .update(nonce)
    .digest('hex')
  return {
    marker: `__BABEL_O_STATE_${nonce}_${signature}__`,
    nonce,
    signature,
  }
}

function isValidProbe(probe: StateProbe): boolean {
  const expected = createHmac('sha256', sessionProbeSecret)
    .update(probe.nonce)
    .digest()
  const actual = Buffer.from(probe.signature, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/**
 * Parses the raw stdout to extract the tracked CWD and strips the probe lines.
 */
function parseStateFromStdout(
  stdout: string,
  probe: StateProbe,
): { cleanStdout: string; detectedCwd: string | null } {
  if (!isValidProbe(probe)) {
    return { cleanStdout: stdout, detectedCwd: null }
  }
  const idx = stdout.lastIndexOf(probe.marker)
  if (idx !== -1) {
    const cleanStdout = stdout.substring(0, idx).trimEnd()
    const statePart = stdout.substring(idx + probe.marker.length).trim()
    const lastCwd = statePart.split(/\r?\n/)[0]?.trim() || null
    return { cleanStdout, detectedCwd: lastCwd }
  }
  return { cleanStdout: stdout, detectedCwd: null }
}

export function clearBashSessionState(sessionId?: string): void {
  if (sessionId) {
    sessionCwdMap.delete(sessionId)
    return
  }
  sessionCwdMap.clear()
}

export function pruneBashSessionState(options: {
  olderThanMs?: number
  nowMs?: number
} = {}): number {
  const olderThanMs = options.olderThanMs ?? SESSION_CWD_TTL_MS
  const nowMs = options.nowMs ?? Date.now()
  let pruned = 0

  for (const [sessionId, entry] of sessionCwdMap.entries()) {
    if (nowMs - entry.lastActiveAt < olderThanMs) continue
    sessionCwdMap.delete(sessionId)
    pruned += 1
  }

  return pruned
}

export function getBashSessionStateSizeForTest(): number {
  return sessionCwdMap.size
}

const sessionCwdSweeper = setInterval(() => {
  pruneBashSessionState()
}, SESSION_CWD_SWEEP_INTERVAL_MS)
sessionCwdSweeper.unref?.()

const inputSchema = z.object({
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().max(300_000).default(60_000),
})

export const bashTool: ToolDefinition<typeof inputSchema> = {
  name: 'Bash',
  description: 'Run a shell command in the workspace.',
  risk: 'execute',
  inputSchema,
  async execute(input, context) {
    const currentCwd = sessionCwdMap.get(context.sessionId)?.cwd ?? context.cwd
    const probe = createStateProbe()

    // Inject state probing code to capture the final CWD and exit code
    const wrappedCommand = `${input.command}
_EXIT_CODE=$?
echo ""
echo "${probe.marker}"
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

      const { cleanStdout, detectedCwd } = parseStateFromStdout(stdout, probe)
      if (detectedCwd) {
        sessionCwdMap.set(context.sessionId, {
          cwd: detectedCwd,
          lastActiveAt: Date.now(),
        })
      }

      return {
        success: true,
        output: { stdout: cleanStdout, stderr },
      }
    } catch (err: any) {
      // Even if the command fails, salvage any CWD change that occurred prior to the failure
      const stdoutStr = typeof err.stdout === 'string' ? err.stdout : ''
      const stderrStr = typeof err.stderr === 'string' ? err.stderr : ''
      const { cleanStdout, detectedCwd } = parseStateFromStdout(stdoutStr, probe)
      if (detectedCwd) {
        sessionCwdMap.set(context.sessionId, {
          cwd: detectedCwd,
          lastActiveAt: Date.now(),
        })
      }

      // Re-write the error message to mask the wrapped command and internal probe marker
      let cleanedMessage = err.message || 'Command failed'
      if (typeof wrappedCommand === 'string' && typeof input.command === 'string') {
        cleanedMessage = cleanedMessage.replace(wrappedCommand, input.command)
      }
      cleanedMessage = cleanedMessage.replaceAll(probe.marker, '')

      const newErr = new Error(cleanedMessage) as any
      newErr.code = err.code
      newErr.signal = err.signal
      newErr.stdout = cleanStdout
      newErr.stderr = stderrStr
      throw newErr
    }
  },
}
