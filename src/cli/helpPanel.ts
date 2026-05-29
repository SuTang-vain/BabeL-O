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
      { command: '/new', description: 'Start new session' },
      { command: '/sessions', description: 'List recent sessions' },
      { command: '/history', description: 'Search message history' },
      { command: '/resume <id>', description: 'Resume specific session' },
    ],
  },
  {
    title: 'Context',
    items: [
      { command: '/compact', description: 'Compact context to save tokens' },
      { command: '/context', description: 'View context usage' },
      { command: '/clear', description: 'Clear current context' },
    ],
  },
  {
    title: 'Model',
    items: [
      { command: '/model', description: 'Switch or view current model' },
      { command: '/models', description: 'List available models' },
      { command: '/provider', description: 'Switch or view provider' },
    ],
  },
  {
    title: 'Tools',
    items: [
      { command: '/tool', description: 'Open tool selector' },
      { command: '/tools', description: 'List available tools' },
      { command: '/read <file>', description: 'Read file' },
      { command: '/write <file>', description: 'Write file' },
      { command: '/edit <file>', description: 'Edit file' },
      { command: '/bash <cmd>', description: 'Execute shell command' },
      { command: '/grep <pattern>', description: 'Search file content' },
      { command: '/glob <pattern>', description: 'Find matching files' },
    ],
  },
  {
    title: 'Task',
    items: [
      { command: '/task', description: 'Create new task' },
      { command: '/tasks', description: 'View task list' },
      { command: '/delegate', description: 'Delegate to sub-agent' },
    ],
  },
  {
    title: 'Config',
    items: [
      { command: '/config', description: 'View or modify config' },
      { command: '/profile', description: 'Switch profile' },
      { command: '/status', description: 'Show runtime status' },
    ],
  },
  {
    title: 'Optimization',
    items: [
      { command: '/optimize', description: 'Analyze and optimize code' },
      { command: '/review', description: 'Code review' },
    ],
  },
  {
    title: 'Other',
    items: [
      { command: '/help', description: 'Show this help' },
      { command: '/quit', description: 'Exit program' },
      { command: '/nexus', description: 'View Nexus status' },
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
