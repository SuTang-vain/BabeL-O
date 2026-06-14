import chalk from 'chalk'
import { Command } from 'commander'
import {
  readEverOSBootstrapStateSync,
  type EverOSBootstrapErrorCode,
  type EverOSBootstrapState,
} from '../../shared/everosBootstrapStore.js'
import { suggestEverCoreFixAction } from '../everosWelcomeHint.js'

export type DoctorMemorySection = {
  configured: boolean
  status: 'not_configured' | 'ready' | 'failed' | 'in_flight' | 'opted_out' | 'external'
  bootstrapPath: string
  managedCommand?: string
  dataDir?: string
  mcpToolsEnabled?: boolean
  errorCode?: EverOSBootstrapErrorCode
  fixAction?: string
  autoBootstrapPolicy?: string
}

export function inspectDoctorMemory(): DoctorMemorySection {
  const read = readEverOSBootstrapStateSync()
  if (!read.ok) {
    return {
      configured: false,
      status: 'failed',
      bootstrapPath: read.path,
      errorCode: read.errorCode,
      fixAction: 'Inspect the bootstrap file path and re-run `bbl memory setup`.',
    }
  }
  if (!read.exists || !read.state) {
    return {
      configured: false,
      status: 'not_configured',
      bootstrapPath: read.path,
      fixAction: 'Run `bbl memory setup` to enable local long-term memory.',
    }
  }
  return stateToSection(read.state, read.path)
}

function stateToSection(state: EverOSBootstrapState, bootstrapPath: string): DoctorMemorySection {
  const base: DoctorMemorySection = {
    configured: state.buildStatus === 'ready',
    status: mapStatus(state),
    bootstrapPath,
    managedCommand: state.managedCommand,
    dataDir: state.dataDir,
    errorCode: state.errorCode ?? undefined,
    autoBootstrapPolicy: state.autoBootstrapPolicy,
  }
  if (state.buildStatus === 'failed') {
    base.fixAction = suggestEverCoreFixAction(state)
  } else if (state.buildStatus === 'not_started' || !state.buildStatus) {
    base.fixAction = 'Run `bbl memory setup` to begin bootstrap.'
  } else if (state.buildStatus === 'opted_out') {
    base.fixAction = 'Run `bbl memory setup` if you want local memory.'
  }
  return base
}

function mapStatus(state: EverOSBootstrapState): DoctorMemorySection['status'] {
  switch (state.buildStatus) {
    case 'ready':
      return 'ready'
    case 'failed':
      return 'failed'
    case 'opted_out':
      return 'opted_out'
    case 'external':
      return 'external'
    case 'cloning':
    case 'building':
    case 'checking_prereqs':
      return 'in_flight'
    default:
      return 'not_configured'
  }
}

export function formatDoctorMemory(section: DoctorMemorySection): string {
  const lines: string[] = []
  lines.push(chalk.bold('Memory'))
  lines.push(`  mode:           ${section.status}`)
  lines.push(`  configured:     ${section.configured ? chalk.green('yes') : chalk.red('no')}`)
  if (section.managedCommand) {
    lines.push(`  managedCommand: ${chalk.dim(section.managedCommand)}`)
  }
  if (section.dataDir) {
    lines.push(`  dataDir:        ${chalk.dim(section.dataDir)}`)
  }
  if (section.autoBootstrapPolicy) {
    lines.push(`  auto-bootstrap: ${section.autoBootstrapPolicy}`)
  }
  if (section.errorCode) {
    lines.push(`  error:          ${chalk.red(section.errorCode)}`)
  }
  if (section.fixAction) {
    lines.push(`  fix:            ${chalk.cyan(section.fixAction)}`)
  }
  lines.push(`  path:           ${chalk.dim(section.bootstrapPath)}`)
  return lines.join('\n')
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Self-check the BabeL-O runtime (provider, keychain, ports, memory, …)')
    .option('--memory-only', 'Only print the memory section')
    .action((options: { memoryOnly?: boolean }) => {
      const memory = inspectDoctorMemory()
      if (options.memoryOnly) {
        console.log(formatDoctorMemory(memory))
        return
      }
      console.log(chalk.bold.cyan('bbl doctor'))
      console.log()
      console.log(formatDoctorMemory(memory))
      console.log()
      console.log(chalk.dim('Other sections (provider / keychain / port) will land in a later slice.'))
    })
}
