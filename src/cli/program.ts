import { Command } from 'commander'
import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { flushStartupTrace, markStartup } from './startupTrace.js'

import { registerRunCommand } from './commands/run.js'
import { registerChatCommand } from './commands/chat.js'
import { registerNexusCommand } from './commands/nexus.js'
import { registerToolsCommand } from './commands/tools.js'
import { registerSessionsCommand } from './commands/sessions.js'
import { registerConfigCommand } from './commands/config.js'
import { registerModelsCommand } from './commands/models.js'
import { registerOptimizeCommand } from './commands/optimize.js'

markStartup('cli.imported')

const program = new Command()

program
  .name('bbl')
  .description('BabeL-O: Nexus-first coding agent CLI')
  .version('0.2.4')

// Register modular commands
registerRunCommand(program)
registerChatCommand(program)
registerNexusCommand(program)
registerToolsCommand(program)
registerSessionsCommand(program)
registerConfigCommand(program)
registerModelsCommand(program)
registerOptimizeCommand(program)

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

export {
  isSessionPermissionCached,
  mapDropdownSelection,
  describeCompletionChoice,
  formatCompletionChoice,
  formatPermissionDialog,
  sessionPermissionApprovals,
} from './ui.js'

export {
  getSlashCompletionChoices,
  getSlashPaletteChoices,
  getToolCompletionChoices,
  formatSlashPalette,
} from './completer.js'
