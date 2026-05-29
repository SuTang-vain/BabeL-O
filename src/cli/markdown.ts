import chalk from 'chalk'

// Simple markdown renderer for CLI output
// Supports: headers, bold, italic, code blocks, inline code, links (shown as text), lists

export interface RenderOptions {
  codeHighlighting?: boolean
  maxWidth?: number
}

const DEFAULT_OPTIONS: Required<RenderOptions> = {
  codeHighlighting: true,
  maxWidth: 80,
}

// Language to syntax highlight token colors
const TOKEN_COLORS: Record<string, (text: string) => string> = {
  keyword: chalk.cyan,
  string: chalk.green,
  comment: chalk.gray,
  number: chalk.yellow,
  function: chalk.blue,
  operator: chalk.white,
  punctuation: chalk.gray,
  type: chalk.magenta,
  variable: chalk.white,
  default: chalk.white,
}

// Simple syntax highlighting for common languages
function highlightCode(code: string, lang: string): string {
  const langLower = lang.toLowerCase()

  // Basic keyword lists
  const keywords: Record<string, string[]> = {
    typescript: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'interface', 'type', 'import', 'export', 'from', 'async', 'await', 'try', 'catch', 'throw', 'new', 'this', 'extends', 'implements', 'public', 'private', 'protected', 'static', 'readonly', 'abstract', 'as', 'in', 'of', 'typeof', 'instanceof', 'default', 'case', 'switch', 'break', 'continue', 'null', 'undefined', 'true', 'false', 'void', 'never', 'any', 'unknown'],
    javascript: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'import', 'export', 'from', 'async', 'await', 'try', 'catch', 'throw', 'new', 'this', 'extends', 'default', 'case', 'switch', 'break', 'continue', 'null', 'undefined', 'true', 'false'],
    tsx: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'interface', 'type', 'import', 'export', 'from', 'async', 'await', 'try', 'catch', 'throw', 'new', 'this', 'extends', 'implements', 'public', 'private', 'protected', 'static', 'readonly', 'abstract', 'as', 'in', 'of', 'typeof', 'instanceof', 'default', 'case', 'switch', 'break', 'continue', 'null', 'undefined', 'true', 'false', 'void', 'never', 'any', 'unknown'],
    jsx: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'import', 'export', 'from', 'async', 'await', 'try', 'catch', 'throw', 'new', 'this', 'extends', 'default', 'case', 'switch', 'break', 'continue', 'null', 'undefined', 'true', 'false'],
    bash: ['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac', 'function', 'return', 'exit', 'echo', 'export', 'source', 'cd', 'ls', 'mkdir', 'rm', 'cp', 'mv', 'cat', 'grep', 'sed', 'awk', 'chmod', 'chown', 'sudo', 'apt', 'yum', 'npm', 'yarn', 'pnpm', 'git', 'docker'],
    python: ['def', 'class', 'if', 'elif', 'else', 'for', 'while', 'try', 'except', 'finally', 'with', 'as', 'import', 'from', 'return', 'yield', 'raise', 'pass', 'break', 'continue', 'and', 'or', 'not', 'in', 'is', 'None', 'True', 'False', 'lambda', 'global', 'nonlocal', 'assert', 'async', 'await'],
    json: [],
    yaml: ['true', 'false', 'null', 'yes', 'no', 'on', 'off'],
  }

  const words = keywords[langLower] || keywords.typescript || []

  // Simple regex-based tokenization
  let result = code

  // Highlight strings (double and single quoted)
  result = result.replace(/(["'`])(?:(?!\1)[^\\]|\\.)*\1/g, (match) => {
    return chalk.green(match)
  })

  // Highlight comments
  if (langLower === 'bash' || langLower === 'sh') {
    result = result.replace(/#.*$/gm, (match) => chalk.gray(match))
  } else if (langLower === 'python') {
    result = result.replace(/#.*$/gm, (match) => chalk.gray(match))
  } else {
    result = result.replace(/\/\/.*$/gm, (match) => chalk.gray(match))
    result = result.replace(/\/\*[\s\S]*?\*\//g, (match) => chalk.gray(match))
  }

  // Highlight numbers
  result = result.replace(/\b\d+\.?\d*\b/g, (match) => chalk.yellow(match))

  // Highlight keywords
  const keywordRegex = new RegExp(`\\b(${words.join('|')})\\b`, 'g')
  result = result.replace(keywordRegex, (match) => chalk.cyan(match))

  return result
}

function wrapText(text: string, width: number, indent: string = ''): string[] {
  const lines: string[] = []
  const words = text.split(/\s+/)
  let currentLine = indent

  for (const word of words) {
    if (currentLine.length + word.length + 1 > width) {
      if (currentLine.length > indent.length) {
        lines.push(currentLine)
      }
      currentLine = indent + word
    } else {
      currentLine += (currentLine === indent ? '' : ' ') + word
    }
  }

  if (currentLine.length > indent.length) {
    lines.push(currentLine)
  }

  return lines
}

export function renderMarkdown(text: string, options: RenderOptions = {}): string {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const lines: string[] = []
  let inCodeBlock = false
  let codeBlockLang = ''
  let codeBlockContent = ''
  let inTable = false
  let tableHeader: string[] = []
  let tableAligns: ('left' | 'center' | 'right')[] = []
  let tableRows: string[][] = []

  const rawLines = text.split('\n')

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]!

    // Code block start/end
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        // End code block
        const highlighted = opts.codeHighlighting
          ? highlightCode(codeBlockContent.trimEnd(), codeBlockLang)
          : codeBlockContent.trimEnd()

        const codeLines = highlighted.split('\n')
        const border = chalk.gray('─'.repeat(Math.min(opts.maxWidth, 60)))
        lines.push(border)
        for (const cl of codeLines) {
          lines.push(`  ${cl}`)
        }
        lines.push(border)
        lines.push('')
        inCodeBlock = false
        codeBlockContent = ''
        codeBlockLang = ''
      } else {
        // Start code block
        inCodeBlock = true
        codeBlockLang = line.slice(3).trim()
        if (line.includes('\n')) {
          // Multiline fence
        }
      }
      continue
    }

    if (inCodeBlock) {
      codeBlockContent += line + '\n'
      continue
    }

    // Table handling
    if (line.startsWith('|')) {
      if (!inTable) {
        inTable = true
        tableHeader = []
        tableRows = []
        tableAligns = []
      }

      const cells = line.split('|').filter((_, i, arr) => i > 0 && i < arr.length - 1).map(c => c.trim())

      // Check if this is the alignment row
      if (cells.every(c => /^:?-+$/.test(c))) {
        tableAligns = cells.map(c => {
          if (c.startsWith(':') && c.endsWith(':')) return 'center'
          if (c.endsWith(':')) return 'right'
          return 'left'
        })
        continue
      }

      if (tableHeader.length === 0) {
        tableHeader = cells
      } else {
        tableRows.push(cells)
      }
      continue
    } else if (inTable) {
      // End table
      inTable = false

      if (tableHeader.length > 0) {
        // Render table
        const colWidths = tableHeader.map((_, colIdx) => {
          const maxWidth = Math.max(
            tableHeader[colIdx]!.length,
            ...tableRows.map(row => (row[colIdx] || '').length)
          )
          return Math.min(maxWidth + 2, 20)
        })

        const separator = tableAligns.length > 0
          ? tableAligns.map((align, i) => {
              const w = colWidths[i]!
              const dash = '─'.repeat(w)
              if (align === 'center') return `:${dash.slice(1, -1)}:`
              if (align === 'right') return `${dash.slice(0, -1)}:`
              return `:${dash.slice(1)}`
            }).join('┼')
          : colWidths.map(w => '─'.repeat(w)).join('┼')

        // Header
        lines.push(chalk.cyan('┌') + tableHeader.map((h, i) => {
          const padded = h.padEnd(colWidths[i]!)
          return chalk.bold.white(padded)
        }).join(chalk.cyan('│')) + chalk.cyan('┐'))

        // Separator
        lines.push(chalk.cyan('├') + separator.split('').map(c => c === '┼' ? chalk.cyan('┼') : chalk.gray(c)).join('') + chalk.cyan('┤'))

        // Rows
        for (const row of tableRows) {
          lines.push(chalk.cyan('│') + row.map((cell, i) => {
            const padded = cell.padEnd(colWidths[i]!)
            return chalk.white(padded)
          }).join(chalk.cyan('│')) + chalk.cyan('│'))
        }

        // Bottom
        lines.push(chalk.cyan('└') + tableHeader.map((_, i) => '─'.repeat(colWidths[i]!)).join(chalk.cyan('┴')) + chalk.cyan('┘'))
        lines.push('')
      }
    }

    // Headers
    if (line.startsWith('#### ')) {
      lines.push(chalk.bold.cyan(line.slice(5)))
      lines.push('')
      continue
    }
    if (line.startsWith('### ')) {
      lines.push(chalk.bold.cyan(line.slice(4)))
      lines.push('')
      continue
    }
    if (line.startsWith('## ')) {
      lines.push(chalk.bold.cyan(line.slice(3)))
      lines.push('')
      continue
    }
    if (line.startsWith('# ')) {
      lines.push(chalk.bold.cyan.underline(line.slice(2)))
      lines.push('')
      continue
    }

    // Horizontal rule
    if (/^[-*_]{3,}$/.test(line.trim())) {
      lines.push(chalk.gray('─'.repeat(Math.min(line.length, opts.maxWidth))))
      lines.push('')
      continue
    }

    // Blockquotes
    if (line.startsWith('> ')) {
      lines.push(chalk.gray('│') + ' ' + chalk.italic(line.slice(2)))
      continue
    }

    // Unordered lists
    if (line.match(/^[-*+] /)) {
      lines.push(chalk.cyan('•') + ' ' + line.slice(2))
      continue
    }

    // Ordered lists
    const orderedMatch = line.match(/^\d+\.\s/)
    if (orderedMatch) {
      lines.push(chalk.cyan(orderedMatch[0]) + line.slice(orderedMatch[0]!.length))
      continue
    }

    // Checkboxes
    if (line.match(/^- \[[ x]\]/i)) {
      const checked = line.includes('[x]') || line.includes('[X]')
      const text = line.replace(/^- \[[ x]\]\s*/i, '')
      const checkbox = checked ? chalk.green('☑') : chalk.gray('☐')
      lines.push(`${checkbox} ${checked ? chalk.strikethrough(text) : text}`)
      continue
    }

    // Regular paragraph
    if (line.trim()) {
      // Inline formatting
      let formatted = line

      // Bold + Italic
      formatted = formatted.replace(/\*\*\*(.+?)\*\*\*/g, (_, text) => chalk.bold.italic(text))
      // Bold
      formatted = formatted.replace(/\*\*(.+?)\*\*/g, (_, text) => chalk.bold(text))
      // Italic
      formatted = formatted.replace(/\*(.+?)\*/g, (_, text) => chalk.italic(text))
      // Inline code
      formatted = formatted.replace(/`([^`]+)`/g, (_, code) => chalk.bgBlackBright.white(` ${code} `))
      // Links (show text only)
      formatted = formatted.replace(/\[([^\]]+)\]\([^)]+\)/g, (_, text) => chalk.underline.blue(text))
      // Strikethrough
      formatted = formatted.replace(/~~(.+?)~~/g, (_, text) => chalk.strikethrough(text))

      lines.push(formatted)
    } else {
      // Empty line
      lines.push('')
    }
  }

  // Handle unclosed code block
  if (inCodeBlock && codeBlockContent) {
    const highlighted = opts.codeHighlighting
      ? highlightCode(codeBlockContent.trimEnd(), codeBlockLang)
      : codeBlockContent.trimEnd()

    const codeLines = highlighted.split('\n')
    const border = chalk.gray('─'.repeat(Math.min(opts.maxWidth, 60)))
    lines.push(border)
    for (const cl of codeLines) {
      lines.push(`  ${cl}`)
    }
    lines.push(border)
    lines.push('')
  }

  // Handle unclosed table
  if (inTable && tableHeader.length > 0) {
    const colWidths = tableHeader.map((_, colIdx) => {
      const maxWidth = Math.max(
        tableHeader[colIdx]!.length,
        ...tableRows.map(row => (row[colIdx] || '').length)
      )
      return Math.min(maxWidth + 2, 20)
    })

    lines.push(chalk.cyan('┌') + tableHeader.map((h, i) => chalk.bold.white(h.padEnd(colWidths[i]!))).join(chalk.cyan('│')) + chalk.cyan('┐'))
    lines.push(chalk.cyan('└') + tableHeader.map((_, i) => '─'.repeat(colWidths[i]!)).join(chalk.cyan('┴')) + chalk.cyan('┘'))
    lines.push('')
  }

  return lines.join('\n')
}

// Render markdown for streaming (line by line)
export class MarkdownStreamRenderer {
  private buffer: string = ''
  private inCodeBlock: boolean = false
  private codeBlockContent: string = ''
  private codeBlockLang: string = ''

  feed(text: string): string {
    this.buffer += text
    let output = ''
    let remaining = ''

    // Process character by character to handle streaming
    for (let i = 0; i < this.buffer.length; i++) {
      const char = this.buffer[i]!

      // Check for code block fence
      if (this.buffer.slice(i).startsWith('```')) {
        const fenceEnd = this.buffer.indexOf('\n', i)
        if (fenceEnd !== -1) {
          const fenceLine = this.buffer.slice(i, fenceEnd)
          if (fenceLine.match(/^```\s*$/)) {
            if (this.inCodeBlock) {
              // End code block
              this.codeBlockContent += '\n'
              output += this.flushCodeBlock()
              this.inCodeBlock = false
              this.codeBlockContent = ''
              this.codeBlockLang = ''
              i = fenceEnd
              continue
            } else {
              // Start code block
              this.inCodeBlock = true
              this.codeBlockLang = fenceLine.slice(3).trim()
              i = fenceEnd
              continue
            }
          }
        }
      }

      if (this.inCodeBlock) {
        this.codeBlockContent += char
      } else {
        remaining += char
      }
    }

    // Process remaining text (not in code block)
    if (remaining) {
      output += this.renderInline(remaining)
    }

    // Keep code block content buffered
    this.buffer = this.inCodeBlock ? this.codeBlockContent : ''

    return output
  }

  private renderInline(text: string): string {
    let formatted = text

    // Inline code
    formatted = formatted.replace(/`([^`]+)`/g, (_, code) => chalk.bgBlackBright.white(` ${code} `))
    // Bold + Italic
    formatted = formatted.replace(/\*\*\*(.+?)\*\*\*/g, (_, t) => chalk.bold.italic(t))
    // Bold
    formatted = formatted.replace(/\*\*(.+?)\*\*/g, (_, t) => chalk.bold(t))
    // Italic
    formatted = formatted.replace(/\*(.+?)\*/g, (_, t) => chalk.italic(t))
    // Links
    formatted = formatted.replace(/\[([^\]]+)\]\([^)]+\)/g, (_, t) => chalk.underline.blue(t))

    return formatted
  }

  flush(): string {
    let output = ''
    if (this.inCodeBlock) {
      output += this.flushCodeBlock()
    }
    if (this.buffer) {
      output += this.renderInline(this.buffer)
    }
    this.buffer = ''
    this.codeBlockContent = ''
    this.inCodeBlock = false
    return output
  }

  private flushCodeBlock(): string {
    const border = chalk.gray('─'.repeat(60))
    const lines = this.codeBlockContent.split('\n')
    let result = `\n${border}\n`
    for (const line of lines) {
      const highlighted = highlightCode(line, this.codeBlockLang)
      result += `  ${highlighted}\n`
    }
    result += border + '\n'
    return result
  }
}

// Check if text contains markdown formatting
export function containsMarkdown(text: string): boolean {
  return /[#*_`~\[\]]/.test(text) ||
    /```[\s\S]*?```/.test(text) ||
    /\|.*\|/.test(text) // Table
}

// Quick format for tool output
export function formatToolOutputMarkdown(output: string, maxLines: number = 50): string {
  if (!output.trim()) return ''

  // Check if it looks like JSON
  if (output.trim().startsWith('{') || output.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(output)
      return JSON.stringify(parsed, null, 2)
    } catch {
      // Not valid JSON, render as markdown
    }
  }

  // Check if it contains markdown
  if (containsMarkdown(output)) {
    const rendered = renderMarkdown(output)
    const lines = rendered.split('\n')
    if (lines.length > maxLines) {
      return lines.slice(0, maxLines).join('\n') + `\n${chalk.dim('...')} ${chalk.gray(`(${lines.length - maxLines} more lines)`)}`
    }
    return rendered
  }

  // Plain text - just return as-is, truncated if needed
  const lines = output.split('\n')
  if (lines.length > maxLines) {
    return lines.slice(0, maxLines).join('\n') + `\n${chalk.dim('...')} ${chalk.gray(`(${lines.length - maxLines} more lines)`)}`
  }

  return output
}
