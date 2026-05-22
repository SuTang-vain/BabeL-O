import chalk from 'chalk'
import { ConfigManager } from '../shared/config.js'

const PIXEL_ROWS = [
  '    M    ',
  '   M M   ',
  '    R    ',
  '   R R   ',
  '  R   R  ',
  'O O P V V',
]

const COLORS: Record<string, string> = {
  M: '#ff006e',
  P: '#ff4f9a',
  R: '#c72d68',
  O: '#ff7a18',
  V: '#8b5cf6',
}

function renderLogoRow(row: string): string {
  let result = ''
  for (const char of row) {
    if (char === ' ') {
      result += ' '
    } else {
      const color = COLORS[char] ?? '#ff006e'
      result += chalk.hex(color)('█')
    }
  }
  return result
}

export function renderWelcome(options: {
  modelId?: string
  cwd: string
  sessionId?: string
  url?: string
}): void {
  const username = process.env.USER || process.env.USERNAME || 'User'
  const version = '0.1.0'
  const mode = options.url ? `Service (${options.url})` : 'Embedded (Local)'
  const configManager = ConfigManager.getInstance()
  const defaultModel = options.modelId || configManager.resolveSettings().modelId || 'local/coding-runtime'

  const metadataLines = [
    `${chalk.bold.hex('#ff006e')('BABEL-O')}  ${chalk.dim(`v${version}`)}`,
    `${chalk.dim('Welcome,')} ${chalk.bold.cyan(username)}!`,
    `${chalk.dim('Model:')}     ${chalk.yellow(defaultModel)}`,
    `${chalk.dim('Workspace:')} ${chalk.italic.white(options.cwd)}`,
    `${chalk.dim('Mode:')}      ${chalk.magenta(mode)}`,
    `${chalk.dim('Type')} ${chalk.bold.yellow('/help')} ${chalk.dim('to list commands, or')} ${chalk.bold.green('exit')} ${chalk.dim('to quit.')}`,
  ]

  console.log()
  for (let i = 0; i < PIXEL_ROWS.length; i++) {
    const logoCol = renderLogoRow(PIXEL_ROWS[i]!)
    const metaCol = metadataLines[i] || ''
    // Use literal spacing since logoCol has a constant visual width of 9 cells
    console.log(`  ${logoCol}   ${metaCol}`)
  }
  console.log(chalk.dim('  ' + '─'.repeat(60)))
}
