import chalk from 'chalk'
import type { NexusEvent } from '../shared/events.js'

let lastWasDelta = false

export function renderEvent(event: NexusEvent): void {
  if (lastWasDelta && event.type !== 'assistant_delta' && event.type !== 'thinking_delta') {
    process.stdout.write('\n')
    lastWasDelta = false
  }

  switch (event.type) {
    case 'session_started':
      console.log(chalk.dim(`session ${event.sessionId}`))
      break
    case 'assistant_delta':
      process.stdout.write(event.text)
      lastWasDelta = true
      break
    case 'thinking_delta':
      process.stdout.write(chalk.dim(event.text))
      lastWasDelta = true
      break
    case 'tool_started':
      console.log(chalk.cyan(`→ ${event.name}`), chalk.dim(JSON.stringify(event.input)))
      break
    case 'tool_completed':
      console.log(
        event.success ? chalk.green(`✓ ${event.name}`) : chalk.red(`✗ ${event.name}`),
      )
      if (event.truncated) {
        console.log(
          chalk.yellow(
            `output truncated at ${event.originalBytes ?? 'unknown'} original bytes`,
          ),
        )
      }
      if (event.output !== undefined) {
        console.log(formatOutput(event.output))
      }
      break
    case 'tool_denied':
      console.log(chalk.yellow(`! ${event.name} denied`), chalk.dim(event.risk))
      console.log(event.message)
      break
    case 'task_created':
      console.log(chalk.green(`task created:`), event.title)
      break
    case 'result':
      console.log(event.success ? chalk.green('done') : chalk.red('failed'))
      break
    case 'error':
      console.error(chalk.red(`${event.code}: ${event.message}`))
      break
  }
}

function formatOutput(output: unknown): string {
  if (typeof output === 'string') return output
  return JSON.stringify(output, null, 2)
}
