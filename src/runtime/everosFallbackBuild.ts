import fs from 'node:fs'
import path from 'node:path'
import type { CommandRunner } from './everosPrerequisites.js'

/**
 * Build a Python project using the standard library `venv`
 * module + `pip` instead of `uv`. Used as a fallback when the
 * user has `python3` available but no `uv` binary. The fallback
 * is intentionally narrow: it only runs `python3 -m venv
 * <dir>/.venv` and then `<dir>/.venv/bin/pip install -r
 * requirements.txt` (or `pyproject.toml` if no requirements.txt
 * is present).
 *
 * The function returns the same shape as the uv runner so
 * `runEverOSMemorySetup` can fall through transparently.
 */
export async function buildEverOSSourceWithPip(options: {
  runner: CommandRunner
  sourceDir: string
}): Promise<{ ok: true } | { ok: false; errorMessage: string }> {
  const venvDir = path.join(options.sourceDir, '.venv')
  const hasVenv = fs.existsSync(venvDir)
  if (!hasVenv) {
    const venv = await options.runner('python3', ['-m', 'venv', venvDir], { cwd: options.sourceDir })
    if (venv.code !== 0) {
      return { ok: false, errorMessage: venv.stderr || venv.stdout || 'python3 -m venv failed' }
    }
  }
  const isWindows = process.platform === 'win32'
  const pip = isWindows
    ? path.join(venvDir, 'Scripts', 'pip.exe')
    : path.join(venvDir, 'bin', 'pip')
  if (!fs.existsSync(pip)) {
    return { ok: false, errorMessage: `pip not found in venv at ${pip}` }
  }
  const requirements = path.join(options.sourceDir, 'requirements.txt')
  const pyproject = path.join(options.sourceDir, 'pyproject.toml')
  if (fs.existsSync(requirements)) {
    const install = await options.runner(pip, ['install', '-r', requirements], { cwd: options.sourceDir })
    if (install.code !== 0) {
      return { ok: false, errorMessage: install.stderr || install.stdout || 'pip install -r requirements.txt failed' }
    }
    return { ok: true }
  }
  if (fs.existsSync(pyproject)) {
    const install = await options.runner(pip, ['install', '.'], { cwd: options.sourceDir })
    if (install.code !== 0) {
      return { ok: false, errorMessage: install.stderr || install.stdout || 'pip install . failed' }
    }
    return { ok: true }
  }
  return { ok: false, errorMessage: 'No requirements.txt or pyproject.toml found for pip fallback' }
}

export type PipFallbackAvailability = {
  available: boolean
  reason?: string
}

/**
 * Detect whether the pip fallback path is available on this
 * machine. Used by `runEverOSMemorySetup` to decide whether to
 * transparently fall back when `uv` is missing.
 */
export async function detectPipFallbackAvailability(
  runner: CommandRunner,
): Promise<PipFallbackAvailability> {
  const venvCheck = await runner('python3', ['-m', 'venv', '--help'])
  if (venvCheck.code !== 0) {
    return { available: false, reason: 'python3 -m venv is not available' }
  }
  return { available: true }
}
