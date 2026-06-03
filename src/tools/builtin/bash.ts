import { execFile } from 'node:child_process'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { ToolDefinition } from '../Tool.js'
import { ConfigManager } from '../../shared/config.js'
import {
  formatWorkspacePathError,
  resolveInsideWorkspace,
  WorkspacePathError,
} from './pathSafety.js'

const spawnedContainers = new Set<string>()

const execFileAsync = promisify(execFile)
const sessionProbeSecret = randomBytes(32)
const SESSION_CWD_TTL_MS = 24 * 60 * 60 * 1000
const SESSION_CWD_SWEEP_INTERVAL_MS = 60 * 60 * 1000

// Maintain a map of sessionId -> last active CWD
const sessionCwdMap = new Map<string, { cwd: string; workspaceCwd: string; lastActiveAt: number }>()

type StateProbe = {
  marker: string
  nonce: string
  signature: string
}

type FailedCommandResult = {
  stdout: string
  stderr: string
  exitCode?: number
  signal?: string
  message: string
}

function resolveShellCwd(sessionId: string, workspaceCwd: string): string {
  const retained = sessionCwdMap.get(sessionId)
  if (!retained) return workspaceCwd
  if (retained.workspaceCwd !== workspaceCwd) {
    sessionCwdMap.delete(sessionId)
    return workspaceCwd
  }
  return retained.cwd
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

function isRecoverableCommandFailure(err: { code?: unknown; signal?: unknown }): boolean {
  return typeof err.code === 'number' && (err.signal === undefined || err.signal === null)
}

function toFailedCommandResult(
  err: {
    message?: string
    code?: unknown
    signal?: unknown
    stdout?: unknown
    stderr?: unknown
  },
  probe: StateProbe,
  wrappedCommand: string,
  originalCommand: string,
): { result: FailedCommandResult; detectedCwd: string | null } {
  const stdoutStr = typeof err.stdout === 'string' ? err.stdout : ''
  const stderrStr = typeof err.stderr === 'string' ? err.stderr : ''
  const { cleanStdout, detectedCwd } = parseStateFromStdout(stdoutStr, probe)
  let cleanedMessage = err.message || 'Command failed'
  cleanedMessage = cleanedMessage.replace(wrappedCommand, originalCommand)
  cleanedMessage = cleanedMessage.replaceAll(probe.marker, '').trim()

  return {
    result: {
      stdout: cleanStdout,
      stderr: stderrStr,
      exitCode: typeof err.code === 'number' ? err.code : undefined,
      signal: typeof err.signal === 'string' ? err.signal : undefined,
      message: cleanedMessage,
    },
    detectedCwd,
  }
}

function updateSessionCwdFromFailure(
  sessionId: string,
  detectedCwd: string | null,
  workspaceCwd: string,
): void {
  if (!detectedCwd) return
  sessionCwdMap.set(sessionId, {
    cwd: detectedCwd,
    workspaceCwd,
    lastActiveAt: Date.now(),
  })
}

export async function clearBashSessionState(sessionId?: string): Promise<void> {
  if (sessionId) {
    sessionCwdMap.delete(sessionId)
    const containerName = `babel-o-session-${sessionId}`
    spawnedContainers.delete(containerName)
    try {
      await execFileAsync('docker', ['rm', '-f', containerName])
    } catch {
      // Ignore
    }
    return
  }

  sessionCwdMap.clear()
  const containers = [...spawnedContainers]
  spawnedContainers.clear()
  await Promise.all(
    containers.map(async name => {
      try {
        await execFileAsync('docker', ['rm', '-f', name])
      } catch {
        // Ignore
      }
    })
  )
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
  prompt: () => 'Executes a bash command in the working directory. The shell state does not persist between commands. Use this for system commands and terminal operations that require shell execution. Prefer dedicated tools (Read, Edit, Glob, Grep) for file operations instead of shell commands.',
  risk: 'execute',
  inputSchema,
  async execute(input, context) {
    const currentCwd = resolveShellCwd(context.sessionId, context.cwd)
    const workspaceEscape = findWorkspaceEscapeInCommand(input.command, context.cwd, context.allowedPaths)
    if (workspaceEscape) {
      return {
        success: false,
        output: {
          code: workspaceEscape.code,
          message: formatWorkspacePathError(workspaceEscape),
          requestedPath: workspaceEscape.requestedPath,
          cwd: workspaceEscape.cwd,
          resolvedPath: workspaceEscape.resolvedPath,
        },
      }
    }
    const probe = createStateProbe()

    // Inject state probing code to capture the final CWD and exit code
    const wrappedCommand = `${input.command}
_EXIT_CODE=$?
echo ""
echo "${probe.marker}"
pwd -P
exit $_EXIT_CODE`

    if (context.executionEnvironment === 'docker') {
      const containerName = `babel-o-session-${context.sessionId}`

      // 1. Ensure docker container is running
      try {
        let isRunning = false
        try {
          const { stdout } = await execFileAsync('docker', [
            'inspect',
            '--format',
            '{{.State.Running}}',
            containerName,
          ])
          if (stdout.trim() === 'true') {
            isRunning = true
          }
        } catch {
          // Container might not exist
        }

        if (!isRunning) {
          // Resolve config
          const config = ConfigManager.getInstance().load()
          const dockerImage = process.env.BABEL_O_DOCKER_IMAGE || config.docker?.image || 'node:22-bookworm'
          const dockerNetwork = process.env.BABEL_O_DOCKER_NETWORK || config.docker?.network || 'none'
          const dockerMemory = process.env.BABEL_O_DOCKER_MEMORY || config.docker?.memory
          const dockerCpus = process.env.BABEL_O_DOCKER_CPUS || config.docker?.cpus

          // Clean up potentially stopped container
          try {
            await execFileAsync('docker', ['rm', '-f', containerName])
          } catch {
            // Ignore
          }

          // Build runner args
          const runArgs = [
            'run',
            '-d',
            '--name',
            containerName,
            '-v',
            `${context.cwd}:${context.cwd}`,
            '-w',
            currentCwd,
          ]
          if (dockerNetwork) {
            runArgs.push('--network', dockerNetwork)
          }
          if (dockerMemory) {
            runArgs.push('--memory', dockerMemory)
          }
          if (dockerCpus) {
            runArgs.push('--cpus', dockerCpus)
          }
          runArgs.push(dockerImage, 'tail', '-f', '/dev/null')

          await execFileAsync('docker', runArgs)
          spawnedContainers.add(containerName)
        }
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          throw new Error('Docker executable not found on host. Please install Docker and ensure it is in the system PATH.')
        }
        throw new Error(`Failed to initialize Docker sandbox environment: ${err.message}`)
      }

      // 2. Execute command via docker exec
      try {
        const { stdout, stderr } = await execFileAsync(
          'docker',
          [
            'exec',
            '-w',
            currentCwd,
            containerName,
            '/bin/sh',
            '-c',
            wrappedCommand,
          ],
          {
            timeout: input.timeoutMs,
            signal: context.signal,
            maxBuffer: context.bashMaxBufferBytes,
          }
        )

        const { cleanStdout, detectedCwd } = parseStateFromStdout(stdout, probe)
        if (detectedCwd) {
          sessionCwdMap.set(context.sessionId, {
            cwd: detectedCwd,
            workspaceCwd: context.cwd,
            lastActiveAt: Date.now(),
          })
        }

        return {
          success: true,
          output: { stdout: cleanStdout, stderr },
        }
      } catch (err: any) {
        const { result, detectedCwd } = toFailedCommandResult(
          err,
          probe,
          wrappedCommand,
          input.command,
        )
        updateSessionCwdFromFailure(context.sessionId, detectedCwd, context.cwd)
        if (isRecoverableCommandFailure(err)) {
          return {
            success: false,
            output: result,
          }
        }

        const newErr = new Error(result.message) as any
        newErr.code = err.code
        newErr.signal = err.signal
        newErr.stdout = result.stdout
        newErr.stderr = result.stderr
        throw newErr
      }
    }

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
          workspaceCwd: context.cwd,
          lastActiveAt: Date.now(),
        })
      }

      return {
        success: true,
        output: { stdout: cleanStdout, stderr },
      }
    } catch (err: any) {
      // Even if the command fails, salvage any CWD change that occurred prior to the failure
      const { result, detectedCwd } = toFailedCommandResult(
        err,
        probe,
        wrappedCommand,
        input.command,
      )
      updateSessionCwdFromFailure(context.sessionId, detectedCwd, context.cwd)
      if (isRecoverableCommandFailure(err)) {
        return {
          success: false,
          output: result,
        }
      }

      const newErr = new Error(result.message) as any
      newErr.code = err.code
      newErr.signal = err.signal
      newErr.stdout = result.stdout
      newErr.stderr = result.stderr
      throw newErr
    }
  },
}

function findWorkspaceEscapeInCommand(command: string, cwd: string, allowedPaths?: string[]): WorkspacePathError | null {
  if (!process.env.NEXUS_ALLOWED_WORKSPACES) return null
  for (const path of extractAbsoluteCommandPaths(command)) {
    try {
      resolveInsideWorkspace(cwd, path, allowedPaths)
    } catch (error) {
      if (error instanceof WorkspacePathError) {
        return error
      }
      const maybeWorkspaceError = error as { code?: unknown }
      if (maybeWorkspaceError?.code === 'WORKSPACE_PATH_ESCAPE') {
        return error as WorkspacePathError
      }
      throw error
    }
  }
  return null
}

function extractAbsoluteCommandPaths(command: string): string[] {
  const paths = new Set<string>()
  const pathPattern = /\/[^\s"'`$|&;<>]+/g
  for (const match of command.matchAll(pathPattern)) {
    const candidate = match[0].replace(/[),.]+$/u, '')
    if (candidate === '/' || candidate.startsWith('/dev/')) continue
    paths.add(candidate)
  }
  return [...paths]
}
