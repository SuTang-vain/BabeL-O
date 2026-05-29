import chalk from 'chalk'

/**
 * Renders long text in a scrollable, interactive pager using the alternate screen buffer.
 * Preserves the main terminal scrollback after exit.
 */
export async function pageText(text: string): Promise<void> {
  const lines = text.split('\n')
  const rows = process.stdout.rows || 24
  const columns = process.stdout.columns || 80

  // If it fits easily in terminal height, just print it directly.
  if (lines.length <= rows - 3) {
    process.stdout.write(text + '\n')
    return
  }

  const wasRaw = process.stdin.isTTY ? process.stdin.isRaw : false
  const dataListeners = process.stdin.listeners('data')
  const keypressListeners = process.stdin.listeners('keypress')

  process.stdin.removeAllListeners('keypress')
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
  }

  // Save current screen, clear, and hide cursor
  process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l')

  return new Promise<void>((resolve) => {
    let topIndex = 0
    const pageHeight = rows - 2 // Leave 2 rows for header and footer
    let settled = false

    const redraw = () => {
      // Reset cursor to top-left
      process.stdout.write('\x1b[H\x1b[2J')

      // Draw header
      const headerText = ' BabeL-O Terminal Pager '
      const padding = '-'.repeat(Math.max(0, Math.floor((columns - headerText.length) / 2)))
      process.stdout.write(chalk.cyan(`${padding}${headerText}${padding}\n`))

      // Draw content lines
      const visible = lines.slice(topIndex, topIndex + pageHeight)
      for (const line of visible) {
        process.stdout.write(line.slice(0, columns) + '\n')
      }

      // Fill empty lines
      if (visible.length < pageHeight) {
        for (let i = 0; i < pageHeight - visible.length; i++) {
          process.stdout.write('\n')
        }
      }

      // Draw footer
      const progress = Math.min(100, Math.round(((topIndex + visible.length) / lines.length) * 100))
      const footer = chalk.bgCyan.black(
        ` Lines ${topIndex + 1}-${Math.min(lines.length, topIndex + pageHeight)} of ${lines.length} (${progress}%) | [↑/↓ scroll  q/esc quit] `
      )
      process.stdout.write('\x1b[H' + `\x1b[${rows};1H${footer}`)
    }

    const cleanup = () => {
      process.stdin.removeListener('data', onData)
      for (const listener of dataListeners) {
        process.stdin.on('data', listener as any)
      }
      for (const listener of keypressListeners) {
        process.stdin.on('keypress', listener as any)
      }
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(wasRaw)
      }
      // Restore cursor, exit alternate screen
      process.stdout.write('\x1b[?25h\x1b[?1049l')
    }

    const onData = (chunk: Buffer | string) => {
      if (settled) return
      const str = chunk.toString()

      // Handle exit: q, Q, Esc, Ctrl+C (0x03)
      if (str === 'q' || str === 'Q' || str === '\x1b' || str === '\u0003') {
        settled = true
        cleanup()
        resolve()
        return
      }

      // Scroll handlers
      if (str === '\x1b[A') { // Up arrow
        if (topIndex > 0) {
          topIndex--
          redraw()
        }
      } else if (str === '\x1b[B') { // Down arrow
        if (topIndex + pageHeight < lines.length) {
          topIndex++
          redraw()
        }
      } else if (str === '\x1b[5~' || str === 'b' || str === 'B') { // Page Up / Back
        topIndex = Math.max(0, topIndex - pageHeight)
        redraw()
      } else if (str === '\x1b[6~' || str === ' ' || str === 'f' || str === 'F') { // Page Down / Forward
        topIndex = Math.min(lines.length - pageHeight, topIndex + pageHeight)
        if (topIndex < 0) topIndex = 0
        redraw()
      }
    }

    process.stdin.on('data', onData)
    redraw()
  })
}
