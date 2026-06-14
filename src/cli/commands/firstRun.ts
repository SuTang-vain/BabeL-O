import chalk from 'chalk'
import readline from 'node:readline'
import { hasExplicitEverCoreEnv } from '../../nexus/everosBootstrapConfig.js'
import { readEverOSBootstrapState } from '../../shared/everosBootstrapStore.js'
import {
  markEverOSMemoryExternalHint,
  markEverOSMemoryOptOut,
  runEverOSMemorySetup,
} from '../everosBootstrap.js'

export type FirstRunOnboardingOptions = {
  env?: NodeJS.ProcessEnv
  stdin?: NodeJS.ReadStream
  stdout?: NodeJS.WriteStream
  skip?: boolean
}

export async function runFirstRunOnboarding(options: FirstRunOnboardingOptions = {}): Promise<void> {
  const env = options.env ?? process.env
  const stdin = options.stdin ?? process.stdin
  const stdout = options.stdout ?? process.stdout
  if (options.skip || env.BABEL_O_EVEROS_FIRST_RUN === '0') return
  if (!stdin.isTTY || !stdout.isTTY) return
  if (hasExplicitEverCoreEnv(env)) return
  const current = await readEverOSBootstrapState({ env })
  if (!current.ok) return
  if (current.exists) return

  stdout.write(chalk.bold.cyan('\n--- Optional local long-term memory ---\n'))
  stdout.write('BabeL-O can run a local MemoryOS sidecar for approved cross-session memory.\n')
  stdout.write('Memory is disabled by default and never replaces workspace evidence.\n\n')
  stdout.write('Enable local long-term memory now?\n')
  stdout.write('  1. Yes, clone and build MemoryOS locally\n')
  stdout.write('  2. Not now\n')
  stdout.write('  3. I already run MemoryOS elsewhere\n')

  const choice = await ask(stdin, stdout, 'Choice [1/2/3]: ')
  const normalized = choice.trim().toLowerCase()
  if (normalized === '1' || normalized === 'y' || normalized === 'yes') {
    const result = await runEverOSMemorySetup({ env, stdin, stdout, autoInstallPrerequisites: true })
    if (!result.ok) {
      stdout.write(chalk.yellow('\nMemoryOS setup did not complete. BabeL-O will continue without long-term memory.\n'))
      stdout.write(chalk.dim('Fix the issue and retry later with `bbl memory setup --retry`.\n\n'))
    }
    return
  }
  if (normalized === '3' || normalized === 'external') {
    await markEverOSMemoryExternalHint({ env })
    stdout.write(chalk.green('\n✓ Recorded external MemoryOS preference.\n'))
    stdout.write(chalk.dim('Set BABEL_O_EVERCORE_MODE=external and BABEL_O_EVERCORE_BASE_URL when you are ready.\n\n'))
    return
  }
  await markEverOSMemoryOptOut({ env })
  stdout.write(chalk.green('\n✓ Long-term memory remains disabled.\n'))
  stdout.write(chalk.dim('Run `bbl memory setup` later if you want local memory.\n\n'))
}

function ask(input: NodeJS.ReadStream, output: NodeJS.WriteStream, question: string): Promise<string> {
  const rl = readline.createInterface({ input, output })
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close()
      resolve(answer)
    })
  })
}
