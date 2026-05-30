import chalk from 'chalk'
import { ConfigManager } from '../shared/config.js'
import { renderCompactHelp } from './helpPanel.js'
import { padToTerminalWidth, visibleTerminalWidth } from './terminalWidth.js'

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
  console.log()
  for (const line of formatWelcomeCardLines(options)) {
    console.log(`  ${line}`)
  }
  console.log()
  console.log(renderCompactHelp())
  console.log()
}

export function formatWelcomeCardLines(options: {
  modelId?: string
  cwd: string
  sessionId?: string
  url?: string
}): string[] {
  const username = process.env.USER || process.env.USERNAME || 'User'
  const version = '0.2.5'
  const mode = options.url ? `Service (${options.url})` : 'Embedded (Local)'
  const configManager = ConfigManager.getInstance()
  const defaultModel = options.modelId || configManager.resolveSettings().modelId || 'local/coding-runtime'

  const metadataLines = [
    ` ${chalk.bold.hex('#ff006e')('❖ BABEL-O')}  ${chalk.dim(`v${version}`)}`,
    ` ${chalk.bold.cyan(username)}`,
    ` ${chalk.yellow(defaultModel)}`,
    ` ${chalk.italic.white(options.cwd)}`,
    ` ${chalk.magenta(mode)}`,
  ]
  const contentWidths = PIXEL_ROWS.map((row, index) => {
    const logoCol = renderLogoRow(row)
    const metaCol = metadataLines[index] ? metadataLines[index] : ''
    return visibleTerminalWidth(` ${logoCol}   ${metaCol}`)
  })
  const width = Math.max(55, ...contentWidths)
  const lines = [chalk.cyan('┌' + '─'.repeat(width) + '┐')]

  for (let i = 0; i < PIXEL_ROWS.length; i++) {
    const logoCol = renderLogoRow(PIXEL_ROWS[i]!)
    const metaCol = metadataLines[i] ? metadataLines[i] : ''
    const content = ` ${logoCol}   ${metaCol}`
    lines.push(`${chalk.cyan('│')}${padToTerminalWidth(content, width)}${chalk.cyan('│')}`)
  }

  lines.push(chalk.cyan('└' + '─'.repeat(width) + '┘'))
  return lines
}
