import { spawn } from 'node:child_process'
import os from 'node:os'

export type EverOSPrerequisiteName = 'git' | 'python' | 'uv'
export type EverOSPackageManager = 'brew' | 'apt' | 'none'

export type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<{ code: number; stdout: string; stderr: string }>

export type EverOSPrerequisiteStatus = {
  name: EverOSPrerequisiteName
  available: boolean
  command?: string
}

export type EverOSPrerequisiteReport = {
  ok: boolean
  prerequisites: EverOSPrerequisiteStatus[]
  packageManager: EverOSPackageManager
  installHint?: string
  missing: EverOSPrerequisiteName[]
}

export const defaultCommandRunner: CommandRunner = (command, args, options = {}) => {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', chunk => { stdout += chunk.toString() })
    child.stderr?.on('data', chunk => { stderr += chunk.toString() })
    child.once('error', error => resolve({ code: 127, stdout, stderr: error.message }))
    child.once('close', code => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

export async function inspectEverOSPrerequisites(
  runner: CommandRunner = defaultCommandRunner,
): Promise<EverOSPrerequisiteReport> {
  const [git, python3, python, uv, brew, aptGet, apt] = await Promise.all([
    commandExists(runner, 'git'),
    commandExists(runner, 'python3'),
    commandExists(runner, 'python'),
    commandExists(runner, 'uv'),
    commandExists(runner, 'brew'),
    commandExists(runner, 'apt-get'),
    commandExists(runner, 'apt'),
  ])

  const pythonCommand = python3 ? 'python3' : python ? 'python' : undefined
  const packageManager: EverOSPackageManager = brew
    ? 'brew'
    : aptGet || apt
    ? 'apt'
    : 'none'
  const prerequisites: EverOSPrerequisiteStatus[] = [
    { name: 'git', available: git, command: git ? 'git' : undefined },
    { name: 'python', available: Boolean(pythonCommand), command: pythonCommand },
    { name: 'uv', available: uv, command: uv ? 'uv' : undefined },
  ]
  const missing = prerequisites.filter(item => !item.available).map(item => item.name)
  return {
    ok: missing.length === 0,
    prerequisites,
    packageManager,
    missing,
    installHint: createInstallHint(missing, packageManager),
  }
}

export async function installMissingEverOSPrerequisites(
  report: EverOSPrerequisiteReport,
  runner: CommandRunner = defaultCommandRunner,
): Promise<{ ok: boolean; command?: string; errorMessage?: string }> {
  if (report.ok) return { ok: true }
  if (report.packageManager === 'brew') {
    const packages = unique(report.missing.flatMap(item => {
      if (item === 'git') return ['git']
      if (item === 'python') return ['python']
      if (item === 'uv') return ['uv']
      return []
    }))
    if (packages.length === 0) return { ok: false, errorMessage: `Missing prerequisites: ${report.missing.join(', ')}` }
    const result = await runner('brew', ['install', ...packages])
    return result.code === 0
      ? { ok: true, command: `brew install ${packages.join(' ')}` }
      : { ok: false, command: `brew install ${packages.join(' ')}`, errorMessage: result.stderr || result.stdout }
  }
  if (report.packageManager === 'apt') {
    const packages = unique(report.missing.flatMap(item => {
      if (item === 'git') return ['git']
      if (item === 'python') return ['python3', 'python3-venv']
      if (item === 'uv') return ['uv']
      return []
    }))
    if (packages.length === 0) return { ok: false, errorMessage: report.installHint ?? `Missing prerequisites: ${report.missing.join(', ')}` }
    const result = await runner('sudo', ['apt-get', 'install', '-y', ...packages])
    return result.code === 0
      ? { ok: true, command: `sudo apt-get install -y ${packages.join(' ')}` }
      : { ok: false, command: `sudo apt-get install -y ${packages.join(' ')}`, errorMessage: result.stderr || result.stdout }
  }
  return { ok: false, errorMessage: report.installHint ?? `Missing prerequisites: ${report.missing.join(', ')}` }
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

async function commandExists(runner: CommandRunner, command: string): Promise<boolean> {
  const result = await runner(command, ['--version'])
  return result.code === 0
}

function createInstallHint(missing: EverOSPrerequisiteName[], packageManager: EverOSPackageManager): string | undefined {
  if (missing.length === 0) return undefined
  if (packageManager === 'brew') {
    const hints: string[] = []
    if (missing.includes('git')) hints.push('Install Xcode Command Line Tools or run `brew install git`.')
    if (missing.includes('python')) hints.push('Run `brew install python`.')
    if (missing.includes('uv')) hints.push('Run `brew install uv`.')
    return hints.join(' ')
  }
  if (packageManager === 'apt') {
    const hints: string[] = []
    if (missing.includes('git')) hints.push('Run `sudo apt-get install -y git`.')
    if (missing.includes('python')) hints.push('Run `sudo apt-get install -y python3`.')
    if (missing.includes('uv')) hints.push('Install uv from https://docs.astral.sh/uv/getting-started/installation/.')
    return hints.join(' ')
  }
  const platform = os.platform()
  return `Missing prerequisites on ${platform}: ${missing.join(', ')}. Install git, Python 3.12+, and uv, then run \`bbl memory setup --retry\`.`
}
