import chalk from 'chalk'
import { Command } from 'commander'
import { renderHelpPanel } from '../helpPanel.js'

export function registerHelpCommand(program: Command): void {
  program
    .command('help')
    .description('Show help information')
    .option('-c, --compact', 'Show compact help')
    .action((options: { compact?: boolean }) => {
      const mode = options.compact ? 'compact' : 'full'
      process.stdout.write(renderHelpPanel(mode))
    })
}

// Interactive help panel that can be called from the chat loop
export function showInteractiveHelp(): void {
  process.stdout.write(renderHelpPanel('full'))
}
