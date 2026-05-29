import chalk from 'chalk'
import { ConfigManager } from '../shared/config.js'
import { keyboardShortcuts, renderCompactHelp } from './helpPanel.js'

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
  const version = '0.2.0'
  const mode = options.url ? `Service (${options.url})` : 'Embedded (Local)'
  const configManager = ConfigManager.getInstance()
  const defaultModel = options.modelId || configManager.resolveSettings().modelId || 'local/coding-runtime'

  const width = Math.max(55, options.cwd.length + 15)

  const metadataLines = [
    ` ${chalk.bold.hex('#ff006e')('❖ BABEL-O')}  ${chalk.dim(`v${version}`)}`,
    ` ${chalk.dim('User:')}      ${chalk.bold.cyan(username)}`,
    ` ${chalk.dim('Model:')}     ${chalk.yellow(defaultModel)}`,
    ` ${chalk.dim('Workspace:')} ${chalk.italic.white(options.cwd)}`,
    ` ${chalk.dim('Mode:')}      ${chalk.magenta(mode)}`,
  ]

  console.log()
  const boxTop = chalk.cyan('┌' + '─'.repeat(width) + '┐')
  const boxBottom = chalk.cyan('└' + '─'.repeat(width) + '┘')

  console.log(`  ${boxTop}`)
  for (let i = 0; i < PIXEL_ROWS.length; i++) {
    const logoCol = renderLogoRow(PIXEL_ROWS[i]!)
    const metaCol = metadataLines[i] ? metadataLines[i] : ''

    // Calculate padding to align the right border
    const visibleLength = stripAnsi(metaCol).length
    const paddingLength = Math.max(0, width - 13 - visibleLength)
    const rightPadding = ' '.repeat(paddingLength)
    const borderRight = chalk.cyan('│')

    console.log(`  ${chalk.cyan('│')} ${logoCol}   ${metaCol}${rightPadding}${borderRight}`)
  }
  console.log(`  ${boxBottom}`)

  // Quick commands bar
  console.log()
  console.log(renderCompactHelp())
  console.log()
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
}
