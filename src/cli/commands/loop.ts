// src/cli/commands/loop.ts
//
// `bbl loop` wires the bbl CLI to the multi-pane loop driver
// (clients/go-tui/cmd/bbl-loop). The driver itself is pure
// data + the runtime, but it ships no Node-side glue: the
// CLI subcommand resolves the binary, spawns it with stdio
// inherited, and waits for it to exit.
//
// Binary discovery order (matches `bbl go` but simpler — no
// release-asset pipeline yet for the loop driver):
//   1. --binary <path> explicit override
//   2. $BABEL_O_LOOP_BINARY env var
//   3. <packageRoot>/clients/go-tui/bin/bbl-loop (dev build)
//   4. `go run ./cmd/bbl-loop` from the source dir when only
//      the toolchain is available.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { Command } from 'commander'

import { defaultGoTuiSourceDir, defaultPackageRoot } from './go.js'

export interface LoopCommandOptions {
  url: string
  cwd: string
  workspace: string
  state: string
  pollIntervalMs: string
  waitTimeoutMs: string
  binary?: string
  sourceDir?: string
  alt: boolean
  mouse: boolean
  noCheck: boolean
  check: boolean
}

export interface LoopLaunchSpec {
  command: string
  args: string[]
  cwd: string
  mode: 'binary' | 'go-run'
}

export function registerLoopCommand(program: Command): void {
  program
    .command('loop')
    .description('Launch the multi-pane bbl loop driver (Phase 2 alpha)')
    .option('--url <url>', 'Nexus base URL', 'http://127.0.0.1:3000')
    .option('--cwd <path>', 'Workspace directory', process.env.BABEL_O_LAUNCH_CWD ?? process.cwd())
    .option('--workspace <id>', 'Loop workspace id (auto-created on first run)', 'ws-default')
    .option('--state <path>', 'Override path for ~/.bbl/loop/state.json')
    .option('--poll-interval-ms <ms>', 'Background /v1/runtime/loop/health poll interval', '5000')
    .option('--wait-timeout-ms <ms>', 'Max wait window per /v1/sessions/:id/wait call', '5000')
    .option('--no-alt', 'Disable terminal alternate screen')
    .option('--no-mouse', 'Do not capture mouse input')
    .option('--binary <path>', 'Use a prebuilt bbl-loop binary')
    .option('--source-dir <path>', 'bbl-loop source directory', defaultGoTuiSourceDir())
    .option('--check', 'Verify install readiness and exit 0/1')
    .option('--no-check', 'Skip install readiness check (still spawns)')
    .action(async (options: LoopCommandOptions) => {
      if (options.check) {
        const report = runLoopCheckReport(options)
        console.log(report.lines.join('\n'))
        process.exit(report.exitCode)
        return
      }
      if (options.noCheck) {
        // explicit opt-out
      } else {
        const ready = runLoopCheckReport(options)
        if (ready.exitCode === 1) {
          console.error('bbl loop preflight failed:')
          console.error(ready.lines.join('\n'))
          process.exit(1)
          return
        }
      }
      let launch: LoopLaunchSpec
      try {
        launch = createLoopLaunchSpec(options)
      } catch (error: any) {
        console.error(`Error: ${error.message || error}`)
        process.exit(1)
        return
      }

      const child: ChildProcess = spawn(launch.command, launch.args, {
        cwd: launch.cwd,
        stdio: 'inherit',
        env: process.env,
      })

      child.on('error', (error: NodeJS.ErrnoException) => {
        if (launch.mode === 'go-run' && error.code === 'ENOENT') {
          console.error(
            'Error: Go toolchain not found on PATH. Install Go (https://go.dev/dl/) ' +
              'or build the bbl-loop binary manually: `cd clients/go-tui && make dev`.',
          )
        } else if (error.code === 'ENOENT' && !existsSync(launch.cwd)) {
          console.error(`Error: failed to launch bbl loop: spawn cwd does not exist: ${launch.cwd}`)
        } else {
          console.error(`Error: failed to launch bbl loop: ${error.message}`)
        }
        process.exit(1)
      })

      child.on('exit', code => {
        process.exit(code ?? 0)
      })
    })
}

export interface LoopCheckReport {
  lines: string[]
  exitCode: number
}

export function runLoopCheckReport(
  options: LoopCommandOptions,
  deps: { exists?: (path: string) => boolean; packageRoot?: string } = {},
): LoopCheckReport {
  const lines: string[] = []
  let hasFailure = false
  const exists = deps.exists ?? existsSync
  const packageRoot = deps.packageRoot ?? defaultPackageRoot()
  const sourceDir = resolve(options.sourceDir ?? defaultGoTuiSourceDir(packageRoot))

  lines.push('bbl loop install check')
  lines.push('======================')

  // 1. Binary discovery.
  const binaryPath = options.binary
    ?? process.env.BABEL_O_LOOP_BINARY
    ?? join(sourceDir, 'bin', 'bbl-loop')
  if (exists(binaryPath)) {
    lines.push(`[OK]      bbl-loop binary found: ${binaryPath}`)
  } else if (exists(sourceDir)) {
    lines.push(
      `[WARN]    No prebuilt bbl-loop binary at ${binaryPath}. ` +
        `Will fall back to source 'go run ./cmd/bbl-loop' from ${sourceDir} ` +
        `(requires the Go toolchain on PATH).`,
    )
  } else {
    lines.push(
      `[FAIL]    No prebuilt bbl-loop binary AND no source directory at ${sourceDir}. ` +
        `Build the binary: \`cd clients/go-tui && make dev\`.`,
    )
    hasFailure = true
  }

  // 2. Source-dir sanity (only when binary is missing).
  if (!exists(binaryPath) && !exists(sourceDir)) {
    lines.push(
      `[FAIL]    bbl-loop source directory missing: ${sourceDir}. ` +
        `Run from a BabeL-O source checkout or pass --source-dir.`,
    )
  }

  lines.push('')
  lines.push(hasFailure ? 'Result: FAIL' : 'Result: OK')
  return { lines, exitCode: hasFailure ? 1 : 0 }
}

export function createLoopLaunchSpec(
  options: LoopCommandOptions,
  deps: { exists?: (path: string) => boolean; packageRoot?: string; env?: NodeJS.ProcessEnv } = {},
): LoopLaunchSpec {
  const exists = deps.exists ?? existsSync
  const env = deps.env ?? process.env
  const packageRoot = deps.packageRoot ?? defaultPackageRoot()
  const sourceDir = resolve(options.sourceDir ?? defaultGoTuiSourceDir(packageRoot))
  const args = buildLoopArgs(options)

  const binaryPath = options.binary
    ?? env.BABEL_O_LOOP_BINARY
    ?? join(sourceDir, 'bin', 'bbl-loop')

  if (exists(binaryPath)) {
    return {
      command: binaryPath,
      args,
      cwd: dirname(binaryPath),
      mode: 'binary',
    }
  }

  if (options.binary) {
    throw new Error(
      `bbl-loop binary not found: ${options.binary}. ` +
        `Build it with \`cd clients/go-tui && make dev\`.`,
    )
  }
  if (!exists(sourceDir)) {
    throw new Error(
      `bbl-loop source directory not found: ${sourceDir}. ` +
        `Run from a BabeL-O source checkout or pass --source-dir.`,
    )
  }

  return {
    command: 'go',
    args: ['run', './cmd/bbl-loop', ...args],
    cwd: sourceDir,
    mode: 'go-run',
  }
}

export function buildLoopArgs(options: LoopCommandOptions): string[] {
  const args: string[] = ['--url', options.url, '--cwd', options.cwd, '--workspace', options.workspace]
  if (options.state) {
    args.push('--state', options.state)
  }
  if (options.pollIntervalMs) {
    args.push('--poll-interval-ms', options.pollIntervalMs)
  }
  if (options.waitTimeoutMs) {
    args.push('--wait-timeout-ms', options.waitTimeoutMs)
  }
  if (options.alt === false) {
    args.push('--alt=false')
  }
  if (options.mouse === false) {
    args.push('--mouse=false')
  }
  return args
}
