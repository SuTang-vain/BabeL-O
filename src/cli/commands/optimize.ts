import chalk from 'chalk'
import { Command } from 'commander'
import { renderEvent } from '../renderEvents.js'
import { createId } from '../../shared/id.js'

export function registerOptimizeCommand(program: Command): void {
  program
    .command('optimize')
    .description('Optimize a specific target file or directory using self-optimizing agents')
    .option('--target <path>', 'Path to file or directory to optimize')
    .option('--focus <focus>', 'Optimization focus: performance, cleanup, or security', 'performance')
    .option('--dry-run', 'Generate the plan but do not execute changes')
    .option('--auto-approve', 'Automatically approve all optimization changes without manual feedback')
    .option('--cwd <path>', 'Workspace directory', process.env.BABEL_O_LAUNCH_CWD ?? process.cwd())
    .action(async (options: { target?: string; focus: 'performance' | 'cleanup' | 'security'; dryRun?: boolean; autoApprove?: boolean; cwd: string }) => {
      const targetPath = options.target
      if (!targetPath) {
        console.error(chalk.red('Error: --target option is required.'))
        process.exit(1)
      }

      console.log(chalk.bold.blue(`Starting optimizer on: ${targetPath} (focus: ${options.focus})`))

      const { createDefaultNexusRuntime } = await import('../../nexus/createRuntime.js')
      const { setNexusStorage } = await import('../../nexus/storageBridge.js')
      const { runtime, storage } = await createDefaultNexusRuntime()
      setNexusStorage(storage)

      // Wrap storage.appendEvent to render events in real-time
      const originalAppendEvent = storage.appendEvent.bind(storage)
      storage.appendEvent = async (sessionId, event) => {
        await originalAppendEvent(sessionId, event)
        renderEvent(event)
      }

      const sessionId = createId('session')
      const prompt = `Optimize the file or directory at "${targetPath}" focusing on ${options.focus}. Please compile and verify correctness.`

      if (options.dryRun) {
        console.log(chalk.yellow('Dry-run mode: planning phase only.'))
        try {
          const { createRuntimeAgentStepRunner } = await import('../../nexus/runtimeAgentStep.js')
          const { PLANNER_ROLE } = await import('../../nexus/agentRoles.js')
          const stepRunner = createRuntimeAgentStepRunner({
            cwd: options.cwd,
            runtimeFactory: async () => runtime,
          })

          const plannerOutput = await stepRunner<{ sessionId: string; goal: string; queueId: string; context?: string }, {
            summary: string
            tasks: Array<{
              title: string
              description?: string
              dependsOn?: string[]
              metadata?: Record<string, unknown>
            }>
          }>({
            roleDefinition: PLANNER_ROLE,
            input: {
              sessionId,
              goal: prompt,
              queueId: sessionId,
              context: `Cwd: ${options.cwd}`,
            },
          })

          console.log(chalk.green.bold('\n--- Optimization Plan ---'))
          console.log(chalk.white(plannerOutput.summary))
          console.log(chalk.cyan.bold('\nProposed Tasks:'))
          plannerOutput.tasks.forEach((t, i) => {
            console.log(chalk.white(`  ${i + 1}. [${t.title}]` + (t.description ? `: ${t.description}` : '')))
            if (t.dependsOn && t.dependsOn.length > 0) {
              console.log(chalk.dim(`     Depends on: ${t.dependsOn.join(', ')}`))
            }
          })
          console.log(chalk.yellow('\nDry-run: exiting without executing changes.'))
        } catch (err) {
          console.error(chalk.red('Failed during dry-run planning:'), err)
        } finally {
          await storage.close?.()
        }
        return
      }

      try {
        const { createRuntimeAgentStepRunner } = await import('../../nexus/runtimeAgentStep.js')
        const { runAgentLoop } = await import('../../nexus/agentLoop.js')
        const stepRunner = createRuntimeAgentStepRunner({
          cwd: options.cwd,
          runtimeFactory: async () => runtime,
        })

        const finalSession = await runAgentLoop({
          sessionId,
          cwd: options.cwd,
          prompt,
          stepRunner,
          role: 'optimizer',
          autoApprove: options.autoApprove,
        })

        if (finalSession.phase === 'completed') {
          console.log(chalk.green.bold('\n✓ Optimization successfully completed!'))
        } else {
          console.log(chalk.red.bold(`\n✗ Optimization failed: ${finalSession.error || finalSession.failureReason || 'Unknown error'}`))
        }
      } catch (err) {
        console.error(chalk.red('\nOptimizer encountered an uncaught error:'), err)
      } finally {
        await storage.close?.()
      }
    })
}
