import { Command } from 'commander'
import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { BABEL_O_VERSION } from '../shared/version.js'
import { flushStartupTrace, markStartup } from './startupTrace.js'

import { registerRunCommand } from './commands/run.js'
import { registerNexusCommand } from './commands/nexus.js'
import { registerToolsCommand } from './commands/tools.js'
import { registerSessionsCommand } from './commands/sessions.js'
import { registerAgentsCommand } from './commands/agents.js'
import { registerConfigCommand } from './commands/config.js'
import { registerModelsCommand } from './commands/models.js'
import { registerOptimizeCommand } from './commands/optimize.js'
import { registerGoCommand } from './commands/go.js'
import { registerLoopCommand } from './commands/loop.js'
import { registerInspectSessionCommand } from './commands/inspectSession.js'
import { registerMemoryCommand } from './commands/memory.js'
import { registerDoctorCommand } from './commands/doctor.js'

markStartup('cli.imported')

const program = new Command()

program
  .name('bbl')
  .description('BabeL-O: Nexus-first coding agent CLI')
  .version(BABEL_O_VERSION)

// Register modular commands. The TS TUI chat entry point was
// removed in the zero-friction plan; `bbl go` is the production
// interactive entry, and `bbl run` is the one-shot fallback.
registerRunCommand(program)
registerNexusCommand(program)
registerToolsCommand(program)
registerSessionsCommand(program)
registerAgentsCommand(program)
registerConfigCommand(program)
registerModelsCommand(program)
registerOptimizeCommand(program)
registerGoCommand(program)
registerLoopCommand(program)
registerInspectSessionCommand(program)
registerMemoryCommand(program)
registerDoctorCommand(program)

program
  .command('__server', { hidden: true })
  .description('Start a local Nexus service (daemon)')
  .action(async () => {
    await import('../nexus/server.js')
  })

const isMain = () => {
  try {
    const mainPath = fs.realpathSync(process.argv[1] || '')
    const currentPath = fs.realpathSync(fileURLToPath(import.meta.url))
    return mainPath === currentPath
  } catch {
    return false
  }
}

if (isMain()) {
  await program.parseAsync(process.argv)
  flushStartupTrace()
}

export { program }
