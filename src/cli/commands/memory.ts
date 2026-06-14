import chalk from 'chalk'
import { Command } from 'commander'
import {
  formatEverOSMemorySetupStatus,
  markEverOSMemoryExternalHint,
  markEverOSMemoryOptOut,
  resetEverOSMemorySetup,
  runEverOSMemorySetup,
} from '../everosBootstrap.js'
import {
  createEverOSBootstrapState,
  parseAutoBootstrapPolicy,
  updateEverOSBootstrapState,
  type EverOSAutoBootstrapPolicy,
} from '../../shared/everosBootstrapStore.js'
import { formatDoctorMemory, inspectDoctorMemory } from './doctor.js'

export function registerMemoryCommand(program: Command): void {
  const memoryCmd = program.command('memory').description('Manage local long-term memory bootstrap')

  memoryCmd
    .command('status')
    .description('Show local MemoryOS bootstrap status')
    .action(async () => {
      console.log(await formatEverOSMemorySetupStatus())
    })

  memoryCmd
    .command('setup')
    .description('Set up local MemoryOS long-term memory bootstrap')
    .option('--yes', 'Assume yes for safe setup prompts')
    .option('--retry', 'Retry setup even if bootstrap is already ready')
    .option('--status', 'Show bootstrap status instead of running setup')
    .option('--reset', 'Reset bootstrap state instead of running setup (requires --yes)')
    .option('--auto-install-prerequisites', 'Offer to install missing prerequisites with brew/apt when available')
    .option('--source-repo <url>', 'MemoryOS source repository URL')
    .option('--source-ref <ref>', 'MemoryOS source branch/tag/commit')
    .option('--source-dir <path>', 'Local source checkout directory')
    .option('--data-dir <path>', 'MemoryOS memory data directory')
    .action(async (options: {
      yes?: boolean
      retry?: boolean
      status?: boolean
      reset?: boolean
      autoInstallPrerequisites?: boolean
      sourceRepo?: string
      sourceRef?: string
      sourceDir?: string
      dataDir?: string
    }) => {
      if (options.status) {
        console.log(await formatEverOSMemorySetupStatus())
        return
      }
      if (options.reset) {
        if (!options.yes) {
          console.error(chalk.red('Refusing to reset without confirmation. Re-run: bbl memory setup --reset --yes'))
          process.exitCode = 1
          return
        }
        await resetEverOSMemorySetup()
        console.log(chalk.green('✓ MemoryOS bootstrap state reset.'))
        return
      }
      const result = await runEverOSMemorySetup({
        assumeYes: options.yes,
        retry: options.retry,
        autoInstallPrerequisites: options.autoInstallPrerequisites,
        sourceRepo: options.sourceRepo,
        sourceRef: options.sourceRef,
        sourceDir: options.sourceDir,
        dataDir: options.dataDir,
      })
      if (!result.ok) {
        console.error(chalk.red(`MemoryOS setup did not complete: ${result.errorCode ?? 'unknown'}`))
        if (result.errorMessage) console.error(chalk.yellow(result.errorMessage))
        console.error(chalk.dim('BabeL-O can still run without long-term memory. Fix the issue and retry with `bbl memory setup --retry`.'))
        process.exitCode = 1
      }
    })

  memoryCmd
    .command('opt-out')
    .description('Disable first-run MemoryOS memory prompts')
    .action(async () => {
      await markEverOSMemoryOptOut()
      console.log(chalk.green('✓ Local long-term memory prompt disabled.'))
    })

  memoryCmd
    .command('external')
    .description('Record that MemoryOS is managed externally')
    .action(async () => {
      await markEverOSMemoryExternalHint()
      console.log(chalk.green('✓ Recorded external MemoryOS preference.'))
      console.log(chalk.dim('Set BABEL_O_EVERCORE_MODE=external and BABEL_O_EVERCORE_BASE_URL to connect BabeL-O.'))
    })

  memoryCmd
    .command('reset')
    .description('Reset local MemoryOS bootstrap state')
    .option('--yes', 'Do not ask for confirmation')
    .action(async (options: { yes?: boolean }) => {
      if (!options.yes) {
        console.error(chalk.red('Refusing to reset without confirmation. Re-run: bbl memory reset --yes'))
        process.exitCode = 1
        return
      }
      await resetEverOSMemorySetup()
      console.log(chalk.green('✓ MemoryOS bootstrap state reset.'))
    })

  memoryCmd
    .command('auto [state]')
    .description('Show or set the local auto-bootstrap policy (on/off/prompt)')
    .action(async (state: string | undefined) => {
      if (!state) {
        const policy = parseAutoBootstrapPolicy({})
        console.log(chalk.bold('Auto-bootstrap policy'))
        console.log(`  env:    ${chalk.cyan(process.env.BABEL_O_EVERCORE_AUTO_BOOTSTRAP ?? '<unset>')}`)
        console.log(`  state:  ${chalk.cyan(policy)}`)
        console.log(chalk.dim('  Set with: bbl memory auto on | off | prompt'))
        return
      }
      const normalized = state.trim().toLowerCase()
      if (normalized !== 'on' && normalized !== 'off' && normalized !== 'prompt') {
        console.error(chalk.red(`Invalid policy: ${state}. Expected: on, off, prompt.`))
        process.exitCode = 1
        return
      }
      await updateEverOSBootstrapState(current => createEverOSBootstrapState({
        ...current,
        autoBootstrapPolicy: normalized as EverOSAutoBootstrapPolicy,
      }))
      console.log(chalk.green(`✓ Auto-bootstrap policy set to: ${normalized}`))
    })

  memoryCmd
    .command('doctor')
    .description('Print the bbl doctor memory section (alias for `bbl doctor --memory-only`)')
    .action(() => {
      console.log(formatDoctorMemory(inspectDoctorMemory()))
    })

  memoryCmd
    .command('enable-tools')
    .description('Persist `BABEL_O_ENABLE_EVERCORE_MCP_TOOLS=true` in the local bootstrap state')
    .action(async () => {
      await updateEverOSBootstrapState(current => createEverOSBootstrapState({
        ...current,
        mcpToolsEnabled: true,
      }))
      console.log(chalk.green('✓ MemoryOS MCP tools enabled for future sessions.'))
      console.log(chalk.dim('The env var BABEL_O_ENABLE_EVERCORE_MCP_TOOLS still wins if set.'))
    })

  memoryCmd
    .command('disable-tools')
    .description('Persist `BABEL_O_ENABLE_EVERCORE_MCP_TOOLS=false` in the local bootstrap state')
    .action(async () => {
      await updateEverOSBootstrapState(current => createEverOSBootstrapState({
        ...current,
        mcpToolsEnabled: false,
      }))
      console.log(chalk.green('✓ MemoryOS MCP tools disabled.'))
    })
}
