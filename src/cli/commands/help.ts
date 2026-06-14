import { Command } from 'commander'


export function registerHelpCommand(program: Command): void {
  program
    .command('help')
    .description('Show help information')
    .option('-c, --compact', 'Show compact help')
    .action((options: { compact?: boolean }) => {
      const mode = options.compact ? 'compact' : 'full'
      process.stdout.write(formatCliHelp(mode))
    })
}

export function showInteractiveHelp(): void {
  process.stdout.write(formatCliHelp('full'))
}

function formatCliHelp(mode: 'compact' | 'full'): string {
  const lines = [
    'BabeL-O CLI',
    '',
    'Interactive:',
    '  bbl go                         Start the production Go TUI',
    '',
    'Automation:',
    '  bbl run "<prompt>"             Run a one-shot prompt',
    '  bbl sessions list              List persisted Nexus sessions',
    '  bbl config show                Show active model configuration',
  ]
  if (mode === 'full') {
    lines.push(
      '  bbl doctor                     Run local health checks',
      '  bbl memory status              Inspect MemoryOS readiness',
      '',
      'Tip: the TypeScript chat TUI was removed in v0.3.7; use `bbl go` for interactive work.',
    )
  }
  return `${lines.join('\n')}\n`
}
