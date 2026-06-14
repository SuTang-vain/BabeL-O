import readline from 'node:readline'
import { stdin as input, stdout as output } from 'node:process'
import chalk from 'chalk'
import { Command } from 'commander'
import { renderWelcome } from '../welcome.js'
import { runSessionFlow } from '../runSessionFlow.js'
import { decideAutoBootstrap } from '../everosAutoBootstrap.js'
import { formatEverCoreWelcomeHint } from '../everosWelcomeHint.js'

export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Run a one-shot coding prompt through Nexus')
    .argument('<prompt...>', 'Prompt to execute')
    .option('--url <url>', 'Use a running Nexus service instead of embedded mode')
    .option('--cwd <path>', 'Workspace directory', process.env.BABEL_O_LAUNCH_CWD ?? process.cwd())
    .action(async (promptParts: string[], options: { url?: string; cwd: string }) => {
      const prompt = promptParts.join(' ')
      const rl = readline.createInterface({ input, output })
      const abortController = new AbortController()

      rl.on('SIGINT', () => {
        abortController.abort()
        console.log(chalk.yellow('\nExecution cancelled by user.'))
        process.exit(130)
      })

      try {
        const autoDecision = await decideAutoBootstrap({})
        if (autoDecision.attempt) {
          console.error(chalk.dim(`memory: bootstrapping in background (${autoDecision.reason})`))
          void autoDecision.handle.promise.catch(() => undefined)
        }
        renderWelcome({ cwd: options.cwd, url: options.url })
        const everCoreHint = formatEverCoreWelcomeHint()
        if (everCoreHint) {
          console.error(chalk.dim(everCoreHint.text))
        }
        await runSessionFlow(prompt, options.cwd, options.url, rl, abortController)
      } catch (e: any) {
        if (e.message !== 'Aborted' && e.name !== 'AbortError') {
          console.error(chalk.red(`Error: ${e.message || e}`))
        }
      } finally {
        rl.close()
      }
    })
}
