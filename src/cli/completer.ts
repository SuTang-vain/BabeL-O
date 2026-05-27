import readline from 'node:readline'
import chalk from 'chalk'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { modelRegistry } from '../providers/registry.js'
import { ConfigManager } from '../shared/config.js'
import { getChatPrompt } from './renderEvents.js'
import {
  describeCompletionChoice,
  mapDropdownSelection,
  countRenderedLines
} from './ui.js'
import { inputState } from './inputState.js'

type CliReadline = readline.Interface

export function getSlashCompletionChoices(): string[] {
  return [
    '/help', '/clear', '/compact', '/context', '/exit', '/model', '/profile', '/status', '/sessions', '/history', '/tool',
    '/read', '/write', '/edit', '/grep', '/glob', '/bash', '/task',
  ]
}

export function getToolCompletionChoices(): string[] {
  return [
    '/tool read',
    '/tool write',
    '/tool edit',
    '/tool grep',
    '/tool glob',
    '/tool bash',
    '/tool task',
  ]
}

export function getSlashPaletteChoices(input: string): string[] {
  if (!/^\/[A-Za-z]*$/.test(input)) return []
  const normalized = input.toLowerCase()
  return getSlashCompletionChoices()
    .filter(choice => choice.toLowerCase().startsWith(normalized))
    .sort((left, right) => left.localeCompare(right))
}

export function formatSlashPalette(
  choices: string[],
  activeIndex: number,
  totalCount = choices.length,
): string {
  if (choices.length === 0) return ''
  const visible = choices.slice(0, 8)
  const lines = [
    chalk.dim('─'.repeat(process.stdout.columns || 80)),
  ]
  for (let index = 0; index < visible.length; index++) {
    const choice = visible[index]!
    const { label, description } = describeCompletionChoice(choice)
    const selected = index === activeIndex
    const marker = selected ? chalk.blue('>') : ' '
    const left = selected ? chalk.blue(label) : chalk.white(label)
    const right = chalk.dim(description)
    lines.push(`${marker} ${left.padEnd(18)} ${right}`)
  }
  const remaining = Math.max(0, totalCount - visible.length)
  if (remaining > 0) {
    lines.push(`  ${chalk.dim(`↓ ${remaining} more`)}`)
  }
  lines.push('')
  lines.push(`${chalk.dim('↑/↓ Navigate ·')} ${chalk.blue('tab')} ${chalk.dim('Complete ·')} ${chalk.blue('enter')} ${chalk.dim('Run')}`)
  return `${lines.join('\n')}\n`
}

export function makeCompleter(cwd: string) {
  return (line: string, callback?: (err: Error | null, result?: [string[], string]) => void) => {
    let hits: string[] = []
    let substring = line

    if (line.startsWith('/') && !line.includes(' ')) {
      const commands = getSlashCompletionChoices()
      hits = commands.filter(c => c.startsWith(line))
      substring = line
    } else if (line.startsWith('/tool')) {
      const toolPrefix = line.slice('/tool'.length).trimStart().toLowerCase()
      const toolChoices = getToolCompletionChoices()
      hits = toolChoices.filter(c => c.toLowerCase().startsWith(`/tool ${toolPrefix}`))
      substring = line
    } else if (line.startsWith('/model ')) {
      const modelPrefix = line.slice('/model '.length)
      const modelIds = modelRegistry.map(m => m.id)
      hits = modelIds.filter(id => id.startsWith(modelPrefix)).map(id => `/model ${id}`)
      substring = line
    } else if (line.startsWith('/profile ')) {
      const profilePrefix = line.slice('/profile '.length)
      const profiles = Object.keys(ConfigManager.getInstance().getProfiles())
      const subCommands = ['clear', 'add']
      const allOptions = [...subCommands, ...profiles]
      hits = allOptions.filter(opt => opt.startsWith(profilePrefix)).map(opt => `/profile ${opt}`)
      substring = line
    } else {
      const words = line.split(' ')
      const lastWord = words[words.length - 1] || ''

      if (lastWord.length > 0) {
        let searchDir = cwd
        let prefix = lastWord

        if (lastWord.includes('/') || lastWord.includes('\\')) {
          const lastSlashIndex = Math.max(lastWord.lastIndexOf('/'), lastWord.lastIndexOf('\\'))
          const dirPart = lastWord.slice(0, lastSlashIndex)
          prefix = lastWord.slice(lastSlashIndex + 1)
          searchDir = path.resolve(cwd, dirPart)
        }

        try {
          if (fs.existsSync(searchDir) && fs.statSync(searchDir).isDirectory()) {
            const files = fs.readdirSync(searchDir)
            const fileHits = files
              .filter(f => f.startsWith(prefix))
              .map(f => {
                const fullPath = path.join(searchDir, f)
                let isDir = false
                try {
                  isDir = fs.statSync(fullPath).isDirectory()
                } catch {}
                const pathPrefix = lastWord.slice(0, lastWord.length - prefix.length)
                return pathPrefix + f + (isDir ? '/' : '')
              })
            hits = fileHits
            substring = lastWord
          }
        } catch (e) {
          // ignore
        }
      }
    }

    const complete = (result: [string[], string]) => {
      if (callback) {
        callback(null, result)
        return
      }
      return result
    }

    if (hits.length === 0) {
      return complete([[], substring])
    } else if (hits.length === 1) {
      const mapped = mapDropdownSelection(hits[0]!)
      return complete([[mapped], substring])
    } else {
      return complete([hits, substring])
    }
  }
}

interface ReadlineInternal extends CliReadline {
  line: string
  cursor: number
  _refreshLine?: () => void
  _ttyWrite?: (text: string, key: any) => void
  history: string[]
}

export function createSlashPalette(rl: CliReadline) {
  const rlInt = rl as ReadlineInternal
  let activeIndex = 0
  let currentChoices: string[] = []
  let consumedNavigationKey = false
  let isOpen = false
  let query = ''
  let renderedLines = 0
  let pendingRefresh: NodeJS.Timeout | null = null

  const originalTtyWrite = typeof rlInt._ttyWrite === 'function'
    ? rlInt._ttyWrite.bind(rlInt)
    : null

  const cancelPendingRefresh = () => {
    if (pendingRefresh) {
      clearTimeout(pendingRefresh)
      pendingRefresh = null
    }
  }

  const scheduleRefresh = () => {
    cancelPendingRefresh()
    pendingRefresh = setTimeout(() => {
      pendingRefresh = null
      refresh()
    }, 0)
  }

  const refresh = () => {
    const line = rlInt.line ?? ''
    if (!isOpen || line !== currentChoices[activeIndex]) {
      query = line
    }
    currentChoices = getSlashPaletteChoices(query)
    if (currentChoices.length === 0) {
      close()
      return
    }
    isOpen = true
    inputState.set('slashPalette')
    activeIndex = Math.min(activeIndex, Math.min(currentChoices.length, 8) - 1)
    preview()
    renderOverlay()
  }

  const renderOverlay = () => {
    clear()
    const palette = formatSlashPalette(currentChoices, activeIndex, currentChoices.length)
    if (!palette) return
    const line = rlInt.line ?? ''
    const prompt = getChatPrompt()
    process.stdout.write(`\r\x1b[K${prompt}${line}`)
    process.stdout.write('\n')
    process.stdout.write(palette)
    renderedLines = 1 + countRenderedLines(palette)
    readline.moveCursor(process.stdout, 0, -renderedLines)
    readline.cursorTo(process.stdout, prompt.length + line.length)
  }

  const clear = () => {
    if (!isOpen || renderedLines <= 0) return
    readline.cursorTo(process.stdout, 0)
    readline.clearScreenDown(process.stdout)
    renderedLines = 0
  }

  const close = () => {
    cancelPendingRefresh()
    const wasOpen = isOpen
    clear()
    currentChoices = []
    activeIndex = 0
    isOpen = false
    query = ''
    if (inputState.current === 'slashPalette') {
      inputState.set('idle')
    }
    if (wasOpen) {
      refreshReadline()
    }
  }

  const setInputLine = (value: string) => {
    rlInt.line = value
    rlInt.cursor = value.length
  }

  const preview = () => {
    const selected = currentChoices[activeIndex]
    if (!selected) return false
    setInputLine(selected)
    return true
  }

  const refreshFromCurrentInput = (previewSelection: boolean) => {
    const line = rlInt.line ?? ''
    query = line
    currentChoices = getSlashPaletteChoices(query)
    if (currentChoices.length === 0) {
      close()
      return
    }
    isOpen = true
    activeIndex = Math.min(activeIndex, Math.min(currentChoices.length, 8) - 1)
    if (previewSelection) {
      preview()
    }
    renderOverlay()
  }

  const select = () => {
    const selected = currentChoices[activeIndex]
    if (!selected) return false
    const mapped = mapDropdownSelection(selected)
    setInputLine(mapped)
    close()
    // Move cursor to end of line to avoid partial input issues
    rlInt.cursor = rlInt.line.length
    return true
  }

  const move = (delta: number) => {
    if (currentChoices.length === 0) return false
    const visibleCount = Math.min(currentChoices.length, 8)
    activeIndex = (activeIndex + delta + visibleCount) % visibleCount
    preview()
    renderOverlay()
    return true
  }

  const handleKey = (chunk: any, key: any): boolean => {
    if (consumedNavigationKey) {
      consumedNavigationKey = false
      return true
    }
    // If permission panel is open, do not intercept keys
    if (inputState.current === 'permissionPanel') {
      return false
    }
    const line = rlInt.line ?? ''
    const shouldShow = getSlashPaletteChoices(line).length > 0
    if (!shouldShow) {
      close()
      return false
    }
    const raw = chunk ? chunk.toString('utf8') : ''
    if (raw.includes('\x1b[A')) return move(-1)
    if (raw.includes('\x1b[B')) return move(1)
    if (raw === '\t') return select()
    if (raw === '\r' || raw === '\n') return false
    if (key?.name === 'up') return move(-1)
    if (key?.name === 'down') return move(1)
    if (key?.name === 'tab') return select()
    if (key?.name === 'return') return false
    if (key?.name === 'escape') {
      // Restore original query line when escaping palette
      if (query && query !== rlInt.line) {
        setInputLine(query)
      }
      close()
      return true
    }
    scheduleRefresh()
    return false
  }

  if (originalTtyWrite) {
    rlInt._ttyWrite = (text: string, key: any) => {
      const raw = typeof text === 'string' ? text : ''
      const keyName = key?.name
      const navigationKey = keyName === 'up' || keyName === 'down' || keyName === 'tab' ||
        raw.includes('\x1b[A') || raw.includes('\x1b[B') || raw === '\t'
      const escapeKey = keyName === 'escape' || raw === '\x1b'
      const backspaceKey = keyName === 'backspace' || raw === '\x7f' || raw === '\b'
      const line = rlInt.line ?? ''
      const choices = isOpen ? currentChoices : getSlashPaletteChoices(line)

      if (escapeKey && isOpen) {
        cancelPendingRefresh()
        consumedNavigationKey = true
        // Restore original query line when escaping palette
        if (query && query !== rlInt.line) {
          setInputLine(query)
        }
        close()
        return
      }

      if (backspaceKey && isOpen) {
        cancelPendingRefresh()
        clear()
        const cursor = rlInt.cursor ?? line.length
        if (cursor > 0) {
          const nextLine = line.slice(0, cursor - 1) + line.slice(cursor)
          rlInt.line = nextLine
          rlInt.cursor = cursor - 1
        }
        // If backspace removed the leading '/', close palette immediately
        if (!rlInt.line.startsWith('/')) {
          close()
          consumedNavigationKey = true
          return
        }
        refreshFromCurrentInput(false)
        consumedNavigationKey = true
        return
      }

      if (navigationKey && choices.length > 0) {
        cancelPendingRefresh()
        currentChoices = choices
        if (!isOpen) {
          query = line
          isOpen = true
        }
        activeIndex = Math.min(activeIndex, Math.min(currentChoices.length, 8) - 1)
        consumedNavigationKey = true
        if (keyName === 'up' || raw.includes('\x1b[A')) move(-1)
        else if (keyName === 'down' || raw.includes('\x1b[B')) move(1)
        else select()
        return
      }
      return originalTtyWrite(text, key)
    }
  }

  const refreshReadline = () => {
    if (typeof rlInt._refreshLine === 'function') {
      rlInt._refreshLine()
    }
  }

  const dispose = () => {
    cancelPendingRefresh()
    close()
    if (originalTtyWrite) {
      rlInt._ttyWrite = originalTtyWrite
    }
  }

  return { close, dispose, handleKey }
}
