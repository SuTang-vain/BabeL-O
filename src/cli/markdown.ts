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
function highlightJson(code: string): string {
  let result = ''
  let i = 0
  const len = code.length
  while (i < len) {
    const char = code[i]!
    const remaining = code.slice(i)

    // String
    if (char === '"') {
      let strVal = '"'
      i++
      let escaped = false
      while (i < len) {
        const c = code[i]!
        strVal += c
        if (escaped) {
          escaped = false
        } else if (c === '\\') {
          escaped = true
        } else if (c === '"') {
          i++
          break
        }
        i++
      }
      // Check if this string is a JSON key (followed by a colon)
      const afterStr = code.slice(i).trimStart()
      if (afterStr.startsWith(':')) {
        result += chalk.cyan(strVal)
      } else {
        result += chalk.green(strVal)
      }
      continue
    }

    // Number
    const numMatch = remaining.match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/)
    if (numMatch) {
      const num = numMatch[0]!
      result += chalk.yellow(num)
      i += num.length
      continue
    }

    // Keyword (true, false, null)
    const kwMatch = remaining.match(/^(?:true|false|null)\b/)
    if (kwMatch) {
      const kw = kwMatch[0]!
      result += chalk.magenta(kw)
      i += kw.length
      continue
    }

    result += char
    i++
  }
  return result
}

// Simple syntax highlighting for common languages using stateful tokenizer
function highlightCode(code: string, lang: string): string {
  const langLower = lang.toLowerCase()
  if (langLower === 'json') {
    return highlightJson(code)
  }

  // Basic keyword lists
  const keywordsMap: Record<string, string[]> = {
    typescript: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'interface', 'type', 'import', 'export', 'from', 'async', 'await', 'try', 'catch', 'throw', 'new', 'this', 'extends', 'implements', 'public', 'private', 'protected', 'static', 'readonly', 'abstract', 'as', 'in', 'of', 'typeof', 'instanceof', 'default', 'case', 'switch', 'break', 'continue', 'null', 'undefined', 'true', 'false', 'void', 'never', 'any', 'unknown'],
    javascript: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'import', 'export', 'from', 'async', 'await', 'try', 'catch', 'throw', 'new', 'this', 'extends', 'default', 'case', 'switch', 'break', 'continue', 'null', 'undefined', 'true', 'false'],
    tsx: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'interface', 'type', 'import', 'export', 'from', 'async', 'await', 'try', 'catch', 'throw', 'new', 'this', 'extends', 'implements', 'public', 'private', 'protected', 'static', 'readonly', 'abstract', 'as', 'in', 'of', 'typeof', 'instanceof', 'default', 'case', 'switch', 'break', 'continue', 'null', 'undefined', 'true', 'false', 'void', 'never', 'any', 'unknown'],
    jsx: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'import', 'export', 'from', 'async', 'await', 'try', 'catch', 'throw', 'new', 'this', 'extends', 'default', 'case', 'switch', 'break', 'continue', 'null', 'undefined', 'true', 'false'],
    bash: ['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac', 'function', 'return', 'exit', 'echo', 'export', 'source', 'cd', 'ls', 'mkdir', 'rm', 'cp', 'mv', 'cat', 'grep', 'sed', 'awk', 'chmod', 'chown', 'sudo', 'apt', 'yum', 'npm', 'yarn', 'pnpm', 'git', 'docker'],
    python: ['def', 'class', 'if', 'elif', 'else', 'for', 'while', 'try', 'except', 'finally', 'with', 'as', 'import', 'from', 'return', 'yield', 'raise', 'pass', 'break', 'continue', 'and', 'or', 'not', 'in', 'is', 'None', 'True', 'False', 'lambda', 'global', 'nonlocal', 'assert', 'async', 'await'],
    json: [],
    yaml: ['true', 'false', 'null', 'yes', 'no', 'on', 'off'],
  }

  const words = new Set(keywordsMap[langLower] || keywordsMap.typescript || [])

  let result = ''
  let i = 0
  const len = code.length

  while (i < len) {
    const char = code[i]!
    const remaining = code.slice(i)

    // 1. Comments
    if (langLower === 'bash' || langLower === 'sh' || langLower === 'python' || langLower === 'yaml') {
      if (char === '#') {
        let comment = ''
        while (i < len && code[i] !== '\n') {
          comment += code[i]!
          i++
        }
        result += chalk.gray(comment)
        continue
      }
    } else {
      if (remaining.startsWith('//')) {
        let comment = ''
        while (i < len && code[i] !== '\n') {
          comment += code[i]!
          i++
        }
        result += chalk.gray(comment)
        continue
      }
      if (remaining.startsWith('/*')) {
        const endIdx = code.indexOf('*/', i + 2)
        if (endIdx !== -1) {
          const comment = code.slice(i, endIdx + 2)
          result += chalk.gray(comment)
          i = endIdx + 2
          continue
        } else {
          result += chalk.gray(code.slice(i))
          break
        }
      }
    }

    // 2. Strings
    if (char === '"' || char === "'" || char === '`') {
      const quote = char
      let strVal = quote
      i++
      let escaped = false
      while (i < len) {
        const c = code[i]!
        strVal += c
        if (escaped) {
          escaped = false
        } else if (c === '\\') {
          escaped = true
        } else if (c === quote) {
          i++
          break
        }
        i++
      }
      result += chalk.green(strVal)
      continue
    }

    // 3. Keywords / Identifiers
    const identMatch = remaining.match(/^[a-zA-Z_$][a-zA-Z0-9_$]*/)
    if (identMatch) {
      const word = identMatch[0]!
      if (words.has(word)) {
        result += chalk.cyan(word)
      } else {
        result += word
      }
      i += word.length
      continue
    }

    // 4. Numbers
    const numMatch = remaining.match(/^\b\d+(?:\.\d+)?\b/)
    if (numMatch) {
      const num = numMatch[0]!
      result += chalk.yellow(num)
      i += num.length
      continue
    }

    // 5. Operators / Punctuation
    result += char
    i++
  }

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

function renderInlineText(text: string): string {
  let formatted = text
  // Bold + Italic
  formatted = formatted.replace(/\*\*\*(.+?)\*\*\*/g, (_, t) => chalk.bold.italic(t))
  // Bold
  formatted = formatted.replace(/\*\*(.+?)\*\*/g, (_, t) => chalk.bold(t))
  // Italic
  formatted = formatted.replace(/\*(.+?)\*/g, (_, t) => chalk.italic(t))
  // Inline code
  formatted = formatted.replace(/`([^`]+)`/g, (_, code) => chalk.bgBlackBright.white(` ${code} `))
  // Links
  formatted = formatted.replace(/\[([^\]]+)\]\([^)]+\)/g, (_, t) => chalk.underline.blue(t))
  // Strikethrough
  formatted = formatted.replace(/~~(.+?)~~/g, (_, t) => chalk.strikethrough(t))
  return formatted
}

function padAnsi(text: string, width: number): string {
  const visibleLen = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').length
  const paddingNeeded = Math.max(0, width - visibleLen)
  return text + ' '.repeat(paddingNeeded)
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
          const cleanHeader = tableHeader[colIdx]!.replace(/\*\*|\*|`|~~/g, '')
          const maxWidth = Math.max(
            cleanHeader.length,
            ...tableRows.map(row => (row[colIdx] || '').replace(/\*\*|\*|`|~~|\[([^\]]+)\]\([^)]+\)/g, '$1').length)
          )
          return Math.min(maxWidth + 2, 40)
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
          const rendered = renderInlineText(h)
          return chalk.bold.white(padAnsi(rendered, colWidths[i]!))
        }).join(chalk.cyan('│')) + chalk.cyan('┐'))

        // Separator
        lines.push(chalk.cyan('├') + separator.split('').map(c => c === '┼' ? chalk.cyan('┼') : chalk.gray(c)).join('') + chalk.cyan('┤'))

        // Rows
        for (const row of tableRows) {
          lines.push(chalk.cyan('│') + row.map((cell, i) => {
            const rendered = renderInlineText(cell || '')
            return chalk.white(padAnsi(rendered, colWidths[i]!))
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
      const cleanHeader = tableHeader[colIdx]!.replace(/\*\*|\*|`|~~/g, '')
      const maxWidth = Math.max(
        cleanHeader.length,
        ...tableRows.map(row => (row[colIdx] || '').replace(/\*\*|\*|`|~~|\[([^\]]+)\]\([^)]+\)/g, '$1').length)
      )
      return Math.min(maxWidth + 2, 40)
    })

    lines.push(chalk.cyan('┌') + tableHeader.map((h, i) => {
      const rendered = renderInlineText(h)
      return chalk.bold.white(padAnsi(rendered, colWidths[i]!))
    }).join(chalk.cyan('│')) + chalk.cyan('┐'))
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
    const lines = this.buffer.split('\n')
    // Keep the last unclosed line in the buffer
    this.buffer = lines.pop() || ''

    let output = ''
    for (const line of lines) {
      if (line.startsWith('```')) {
        if (this.inCodeBlock) {
          output += this.flushCodeBlock()
          this.inCodeBlock = false
          this.codeBlockContent = ''
          this.codeBlockLang = ''
        } else {
          this.inCodeBlock = true
          this.codeBlockLang = line.slice(3).trim()
        }
      } else {
        if (this.inCodeBlock) {
          this.codeBlockContent += line + '\n'
        } else {
          output += this.renderInline(line) + '\n'
        }
      }
    }
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
      if (this.buffer.startsWith('```')) {
        output += `\n${chalk.gray('─'.repeat(60))}\n`
      } else if (this.inCodeBlock) {
        output += this.flushCodeBlock()
      } else {
        output += this.renderInline(this.buffer)
      }
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
