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

  const metadataLines = [
    `${chalk.bold.hex('#ff006e')('BABEL-O')}  ${chalk.dim(`v${version}`)}`,
    `${chalk.dim('Welcome,')} ${chalk.bold.cyan(username)}!`,
    `${chalk.dim('Model:')}     ${chalk.yellow(defaultModel)}`,
    `${chalk.dim('Workspace:')} ${chalk.italic.white(options.cwd)}`,
    `${chalk.dim('Mode:')}      ${chalk.magenta(mode)}`,
    '',
  ]

  console.log()
  for (let i = 0; i < PIXEL_ROWS.length; i++) {
    const logoCol = renderLogoRow(PIXEL_ROWS[i]!)
    const metaCol = metadataLines[i] || ''
    console.log(`  ${logoCol}   ${metaCol}`)
  }

  // Quick commands bar
  console.log()
  console.log(renderCompactHelp())
  console.log()

  // Tips
  //console.log(chalk.dim('  💡 Tips:') + ` ${chalk.white('输入 /help 查看完整帮助 ·')} ${chalk.white('Ctrl+O 切换视图模式')}`)
  //console.log()
}
