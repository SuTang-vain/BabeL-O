import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'

type ExistsFn = (path: string) => boolean

export interface GoTuiCommandOptions {
  url: string
  cwd: string
  session?: string
  alt: boolean
  binary?: string
  sourceDir?: string
}

export interface GoTuiLaunchSpec {
  command: string
  args: string[]
  cwd: string
  mode: 'binary' | 'go-run'
}

export function registerGoCommand(program: Command): void {
  program
    .command('go')
    .description('Launch the experimental Go TUI client')
    .option('--url <url>', 'Nexus base URL', 'http://127.0.0.1:3000')
    .option('--cwd <path>', 'Workspace directory', process.env.BABEL_O_LAUNCH_CWD ?? process.cwd())
    .option('--session <id>', 'Reuse an existing Nexus session id')
    .option('--no-alt', 'Disable terminal alternate screen')
    .option('--binary <path>', 'Use a prebuilt go-tui binary')
    .option('--source-dir <path>', 'Go TUI source directory', defaultGoTuiSourceDir())
    .action((options: GoTuiCommandOptions) => {
      let launch: GoTuiLaunchSpec
      try {
        launch = createGoTuiLaunchSpec(options)
      } catch (error: any) {
        console.error(`Error: ${error.message || error}`)
        process.exit(1)
      }

      const child = spawn(launch.command, launch.args, {
        cwd: launch.cwd,
        stdio: 'inherit',
        env: process.env,
      })

      child.on('error', (error: NodeJS.ErrnoException) => {
        if (launch.mode === 'go-run' && error.code === 'ENOENT') {
          console.error(
            'Error: Go TUI binary was not found and the Go toolchain is unavailable. ' +
              'Install Go or build clients/go-tui/go-tui first.',
          )
        } else {
          console.error(`Error: failed to launch Go TUI: ${error.message}`)
        }
        process.exit(1)
      })

      child.on('exit', code => {
        process.exit(code ?? 0)
      })
    })
}

export function createGoTuiLaunchSpec(
  options: GoTuiCommandOptions,
  deps: { exists?: ExistsFn; packageRoot?: string; platform?: NodeJS.Platform } = {},
): GoTuiLaunchSpec {
  const exists = deps.exists ?? existsSync
  const packageRoot = deps.packageRoot ?? defaultPackageRoot()
  const sourceDir = resolve(options.sourceDir ?? defaultGoTuiSourceDir(packageRoot))
  const args = buildGoTuiArgs(options)
  const binary = resolve(options.binary ?? defaultGoTuiBinary(sourceDir, deps.platform ?? process.platform))

  if (exists(binary)) {
    return {
      command: binary,
      args,
      cwd: sourceDir,
      mode: 'binary',
    }
  }

  if (options.binary) {
    throw new Error(`Go TUI binary not found: ${binary}`)
  }

  if (!exists(sourceDir)) {
    throw new Error(`Go TUI source directory not found: ${sourceDir}`)
  }

  return {
    command: 'go',
    args: ['run', '.', ...args],
    cwd: sourceDir,
    mode: 'go-run',
  }
}

export function buildGoTuiArgs(options: Pick<GoTuiCommandOptions, 'url' | 'cwd' | 'session' | 'alt'>): string[] {
  const args = ['--url', options.url, '--cwd', options.cwd]
  if (options.session) {
    args.push('--session', options.session)
  }
  if (options.alt === false) {
    args.push('--alt=false')
  }
  return args
}

export function defaultPackageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
}

export function defaultGoTuiSourceDir(packageRoot = defaultPackageRoot()): string {
  return join(packageRoot, 'clients', 'go-tui')
}

export function defaultGoTuiBinary(sourceDir = defaultGoTuiSourceDir(), platform: NodeJS.Platform = process.platform): string {
  return join(sourceDir, platform === 'win32' ? 'go-tui.exe' : 'go-tui')
}
