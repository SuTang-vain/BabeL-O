export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
}

export function terminalWidth(text: string): number {
  let width = 0
  for (let i = 0; i < text.length; i++) {
    const codePoint = text.codePointAt(i)!
    const char = String.fromCodePoint(codePoint)
    if (codePoint > 0xffff) i++
    if (isZeroWidthCodePoint(codePoint)) continue
    width += isWideCodePoint(codePoint) ? 2 : 1
  }
  return width
}

export function visibleTerminalWidth(text: string): number {
  return terminalWidth(stripAnsi(text))
}

export function padToTerminalWidth(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - visibleTerminalWidth(text)))
}

export function truncateToTerminalWidth(text: string, width: number): string {
  let result = ''
  let currentWidth = 0
  for (let i = 0; i < text.length; i++) {
    const codePoint = text.codePointAt(i)!
    const char = String.fromCodePoint(codePoint)
    const charWidth = isZeroWidthCodePoint(codePoint) ? 0 : isWideCodePoint(codePoint) ? 2 : 1
    if (currentWidth + charWidth > width) break
    result += char
    currentWidth += charWidth
    if (codePoint > 0xffff) i++
  }
  return result
}

export function renderedLineCount(text: string, columns = process.stdout.columns || 80): number {
  const cleanText = stripAnsi(text)
  const lines = cleanText.split('\n')
  let count = 0
  for (let i = 0; i < lines.length; i++) {
    if (i === lines.length - 1 && lines[i] === '' && cleanText.endsWith('\n')) continue
    count += Math.max(1, Math.ceil(terminalWidth(lines[i]!) / columns))
  }
  return count
}

function isZeroWidthCodePoint(codePoint: number): boolean {
  return codePoint === 0 ||
    codePoint < 32 ||
    (codePoint >= 0x7f && codePoint < 0xa0) ||
    (codePoint >= 0x300 && codePoint <= 0x36f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
}

function isWideCodePoint(codePoint: number): boolean {
  return (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff)
}
