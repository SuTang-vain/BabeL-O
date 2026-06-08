import chalk from 'chalk'

export interface HelpCategory {
  title: string
  items: HelpItem[]
}

export interface HelpItem {
  command: string
  description: string
  shortcut?: string
}

export const helpCategories: HelpCategory[] = [
  {
    title: 'Session',
    items: [
      { command: '/sessions', description: 'List recent sessions' },
      { command: '/inbox', description: 'Show unread SessionChannel messages' },
      { command: '/history [query]', description: 'Search message history' },
      { command: '/history !<n>', description: 'Replay a history entry' },
      { command: '/exit', description: 'Exit chat' },
    ],
  },
  {
    title: 'Context',
    items: [
      { command: '/compact', description: 'Compact context to save tokens' },
      { command: '/context', description: 'View context usage' },
      { command: '/clear', description: 'Clear terminal output' },
      { command: '/pager', description: 'Open last output in pager' },
    ],
  },
  {
    title: 'Model',
    items: [
      { command: '/model [id]', description: 'Configure or set model' },
      { command: '/profile', description: 'Show profiles' },
      { command: '/profile add <name>', description: 'Create profile' },
      { command: '/profile clear', description: 'Clear active profile' },
    ],
  },
  {
    title: 'Tools',
    items: [
      { command: '/tool', description: 'Open tool selector' },
      { command: '/read <file>', description: 'Insert read prompt prefix' },
      { command: '/write <file>', description: 'Insert write prompt prefix' },
      { command: '/edit <file>', description: 'Insert edit prompt prefix' },
      { command: '/bash <cmd>', description: 'Insert shell command prefix' },
      { command: '/grep <pattern>', description: 'Insert grep prompt prefix' },
      { command: '/glob <pattern>', description: 'Insert glob prompt prefix' },
      { command: '/task', description: 'Insert task prompt prefix' },
    ],
  },
  {
    title: 'Status',
    items: [
      { command: '/status', description: 'Show runtime and provider status' },
      { command: '/agents', description: 'Show read-only multi-agent status' },
      { command: '/smoke', description: 'Run provider smoke dry-run' },
      { command: '/smoke live', description: 'Run explicit live provider smoke' },
      { command: '/smoke live tool-call', description: 'Run explicit provider tool-call smoke' },
      { command: '/fallback [kind]', description: 'Show non-silent provider fallback plan' },
    ],
  },
  {
    title: 'Input',
    items: [
      { command: '/editor', description: 'Compose prompt in external editor' },
      { command: '/e', description: 'Alias for /editor' },
      { command: '/help', description: 'Show this help' },
      { command: '/?', description: 'Show compact shortcuts' },
    ],
  },
]

export const keyboardShortcuts: Array<{ key: string; description: string }> = [
  { key: 'Ctrl+O', description: 'Toggle compact mode' },
  { key: 'Ctrl+C', description: 'Cancel / Quit' },
  { key: 'Escape', description: 'Cancel execution' },
  { key: '↑/↓', description: 'Browse history' },
  { key: 'Tab', description: 'Autocomplete' },
  { key: 'Ctrl+L', description: 'Clear screen' },
]

export function renderHelpPanel(mode: 'compact' | 'full' = 'full'): string {
  const terminalWidth = process.stdout.columns || 80
  const leftWidth = 45
  const rightWidth = terminalWidth - leftWidth - 3

  let output = '\n'

  // Header
  output += chalk.cyan('┌') + chalk.cyan('─'.repeat(terminalWidth - 2)) + chalk.cyan('┐') + '\n'
  output += chalk.cyan('│') + chalk.bold.white(' BabeL-O Help '.padStart(Math.floor((terminalWidth + 13) / 2)).padEnd(terminalWidth - 1)) + chalk.cyan('│') + '\n'
  output += chalk.cyan('├') + chalk.cyan('─'.repeat(terminalWidth - 2)) + chalk.cyan('┤') + '\n'

  if (mode === 'full') {
    // Two-column layout for categories
    let leftCol = ''
    let rightCol = ''

    for (let i = 0; i < helpCategories.length; i++) {
      const cat = helpCategories[i]!
      const isLeft = i % 2 === 0
      const catText = formatCategory(cat)
      if (isLeft) {
        leftCol += catText
      } else {
        rightCol += catText
      }
    }

    // Pad right column to match height
    const leftLines = leftCol.split('\n').length
    const rightLines = rightCol.split('\n').length
    if (rightLines < leftLines) {
      rightCol += '\n'.repeat(leftLines - rightLines)
    }

    // Combine columns
    const leftLinesArr = leftCol.split('\n')
    const rightLinesArr = rightCol.split('\n')

    for (let i = 0; i < leftLinesArr.length; i++) {
      const left = leftLinesArr[i] || ''
      const right = rightLinesArr[i] || ''
      output += chalk.cyan('│') + left.padEnd(leftWidth) + chalk.cyan('│') + right.padEnd(rightWidth) + chalk.cyan('│') + '\n'
    }

    // Keyboard shortcuts section
    output += chalk.cyan('├') + chalk.cyan('─'.repeat(terminalWidth - 2)) + chalk.cyan('┤') + '\n'
    output += chalk.cyan('│') + chalk.bold.yellow(' Shortcuts '.padEnd(terminalWidth - 1)) + chalk.cyan('│') + '\n'

    for (const shortcut of keyboardShortcuts) {
      const keyStr = chalk.green(shortcut.key.padEnd(10))
      const descStr = chalk.white(shortcut.description)
      output += chalk.cyan('│') + `  ${keyStr}${descStr}`.padEnd(terminalWidth - 2) + chalk.cyan('│') + '\n'
    }
  } else {
    // Compact mode - just show key shortcuts
    const shortcutText = keyboardShortcuts
      .map(s => `${chalk.green(s.key)}: ${s.description}`)
      .join(chalk.dim(' | '))
    output += chalk.cyan('│') + `  ${shortcutText}`.padEnd(terminalWidth - 2) + chalk.cyan('│') + '\n'
  }

  // Footer
  output += chalk.cyan('└') + chalk.cyan('─'.repeat(terminalWidth - 2)) + chalk.cyan('┘') + '\n'

  return output
}

function formatCategory(cat: HelpCategory): string {
  let text = chalk.bold.cyan(`  ${cat.title}\n`)
  for (const item of cat.items) {
    const cmd = chalk.green(item.command.padEnd(16))
    const desc = chalk.white(item.description)
    const shortcut = item.shortcut ? ` ${chalk.dim(`(${item.shortcut})`)}` : ''
    text += `    ${cmd}${desc}${shortcut}\n`
  }
  text += '\n'
  return text
}

// Compact help for status bar
export function renderCompactHelp(): string {
  return [
    chalk.green('/help') + ' help',
    chalk.cyan('Ctrl+O') + ' toggle',
    chalk.cyan('Ctrl+C') + ' cancel',
  ].join(chalk.dim(' │ '))
}
