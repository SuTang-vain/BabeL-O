import chalk from 'chalk'
import { computeLcs } from './diffLcs.js'

export function renderDiff(toolName: string, input: any): string {
  if (!input || typeof input !== 'object') return ''

  if (toolName === 'Edit') {
    const path = input.path || 'unknown'
    const oldLines = typeof input.oldString === 'string' ? input.oldString.split('\n') : []
    const newLines = typeof input.newString === 'string' ? input.newString.split('\n') : []

    let out = chalk.bold.cyan(`\nDiff for Edit in ${path}:\n`)
    out += chalk.dim(`--- ${path} (before)\n`)
    out += chalk.dim(`+++ ${path} (after)\n`)

    const diff = computeLcs(oldLines, newLines)
    for (const item of diff) {
      if (item.type === 'common') {
        out += chalk.dim(`  ${item.text}\n`)
      } else if (item.type === 'removed') {
        out += chalk.red(`- ${item.text}\n`)
      } else if (item.type === 'added') {
        out += chalk.green(`+ ${item.text}\n`)
      }
    }
    return out
  }

  if (toolName === 'Write') {
    const path = input.path || 'unknown'
    const content = typeof input.content === 'string' ? input.content : ''
    const lines = content.split('\n')

    let out = chalk.bold.cyan(`\nWritten File ${path}:\n`)
    out += chalk.dim(`+++ ${path} (${lines.length} lines, ${Buffer.byteLength(content)} bytes)\n`)

    // Show first 15 lines, truncate the rest to keep terminal output readable
    const maxPreviewLines = 15
    const previewLines = lines.slice(0, maxPreviewLines)
    for (const line of previewLines) {
      out += chalk.green(`+ ${line}\n`)
    }
    if (lines.length > maxPreviewLines) {
      out += chalk.dim(`... and ${lines.length - maxPreviewLines} more lines (truncated)\n`)
    }
    return out
  }

  return ''
}
