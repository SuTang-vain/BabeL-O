import chalk from 'chalk'
import { ConfigManager } from '../shared/config.js'
import { padToTerminalWidth, truncateToTerminalWidth, visibleTerminalWidth } from './terminalWidth.js'
import { getTheme } from './theme.js'

const VERSION = '0.3.0'
const WELCOME_MAX_WIDTH = 96
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
}

export function formatWelcomeCardLines(options: {
  modelId?: string
  cwd: string
  sessionId?: string
  url?: string
  columns?: number
}): string[] {
  const columns = Math.max(48, options.columns ?? process.stdout.columns ?? 80)
  const maxContentWidth = Math.max(46, Math.min(WELCOME_MAX_WIDTH, columns - 4))
  const mode = options.url ? `Service (${options.url})` : 'Embedded (Local)'
  const username = process.env.USER || process.env.USERNAME || 'User'
  const configManager = ConfigManager.getInstance()
  const defaultModel = options.modelId || configManager.resolveSettings().modelId || 'local/coding-runtime'
  const logoWidth = Math.max(...PIXEL_ROWS.map(row => visibleTerminalWidth(renderLogoRow(row))))
  const theme = getTheme()
  const metadataWidth = Math.max(18, maxContentWidth - logoWidth - 5)
  const metadataLines = [
    ` ${theme.brand('❖ BABEL-O')}  ${chalk.dim(`v${VERSION}`)}`,
    ` ${chalk.bold.cyan(truncateToTerminalWidth(username, metadataWidth))}`,
    ` ${chalk.yellow(truncateToTerminalWidth(defaultModel, metadataWidth))}`,
    ` ${chalk.italic.white(truncateToTerminalWidth(formatCwd(options.cwd), metadataWidth))}`,
    ` ${theme.accent(truncateToTerminalWidth(mode, metadataWidth))}`,
  ]
  const contentWidths = PIXEL_ROWS.map((row, index) => {
    const logoCol = renderLogoRow(row)
    const metaCol = metadataLines[index] ?? ''
    return visibleTerminalWidth(` ${logoCol}   ${metaCol}`)
  })
  const contentWidth = Math.min(maxContentWidth, Math.max(55, ...contentWidths))
  const lines = []

  for (let i = 0; i < PIXEL_ROWS.length; i++) {
    const logoCol = renderLogoRow(PIXEL_ROWS[i]!)
    const metaCol = metadataLines[i] ?? ''
    const content = ` ${logoCol}   ${metaCol}`
    lines.push(padToTerminalWidth(content, contentWidth))
  }

  return lines
}

export function formatWelcomeHintLine(columns = process.stdout.columns ?? 80): string {
  const width = Math.max(48, Math.min(WELCOME_MAX_WIDTH, columns))
  const left = `${chalk.dim('?')} ${chalk.dim('shortcuts')} ${chalk.dim('·')} ${chalk.dim('/')} ${chalk.dim('commands')} ${chalk.dim('·')} ${chalk.dim('Ctrl+E')} ${chalk.dim('editor')}`
  const right = `${chalk.dim('Ctrl+O')} ${chalk.dim('details')} ${chalk.dim('·')} ${chalk.dim('Ctrl+C')} ${chalk.dim('cancel')}`
  const gap = Math.max(2, width - visibleTerminalWidth(left) - visibleTerminalWidth(right))
  return `${left}${' '.repeat(gap)}${right}`
}

export function formatSessionBanner(action: 'started' | 'resuming', sessionId: string): string {
  const label = action === 'started' ? 'session' : 'resume'
  return `${chalk.dim(label)} ${chalk.dim(sessionId)}`
}

function formatCwd(cwd: string): string {
  const home = process.env.HOME
  if (home && cwd === home) return '~'
  if (home && cwd.startsWith(`${home}/`)) return `~/${cwd.slice(home.length + 1)}`
  return cwd
}
