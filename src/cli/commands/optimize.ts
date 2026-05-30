import chalk from 'chalk'
import { Command } from 'commander'
import { renderEvent } from '../renderEvents.js'
import { createId } from '../../shared/id.js'
import { questionAsync } from '../ui.js'
import type { CliReadline } from '../ui.js'
import type { PlannerAgentResult, PlannerReviewDecision, PlannerTaskPlan } from '../../nexus/agentLoop.js'

export type OptimizeCommandOptions = {
  target?: string
  focus: 'performance' | 'cleanup' | 'security'
  dryRun?: boolean
  autoApprove?: boolean
  cwd: string
  enableSubAgents?: boolean
  enableSubagents?: boolean
  maxSubAgentDepth?: string | number
  maxSubTasksPerTask?: string | number
  providerSmokeLive?: boolean
  model?: string
  timeoutMs?: string | number
  yes?: boolean
}

export type OptimizeSubAgentOptions = {
  enableSubAgents: boolean
  maxSubAgentDepth: number
  maxSubTasksPerTask: number
}

export function registerOptimizeCommand(program: Command): void {
  program
    .command('optimize')
    .description('Optimize a specific target file or directory using self-optimizing agents')
    .option('--target <path>', 'Path to file or directory to optimize')
    .option('--focus <focus>', 'Optimization focus: performance, cleanup, or security', 'performance')
    .option('--dry-run', 'Generate the plan but do not execute changes')
    .option('--auto-approve', 'Automatically approve all optimization changes without manual feedback')
    .option('--provider-smoke-live', 'Run the fixed live/manual AgentLoop provider smoke in a temporary workspace')
    .option('--model <model>', 'Model override for the provider smoke or optimizer run')
    .option('--timeout-ms <number>', 'Timeout in milliseconds for provider smoke live/manual runs', '120000')
    .option('--yes', 'Approve the planner task list without prompting')
    .option('--enable-subagents', 'Allow optimizer/executor agents to delegate substantive subTasks')
    .option('--max-sub-agent-depth <number>', 'Maximum nested sub-agent delegation depth', '1')
    .option('--max-sub-tasks-per-task <number>', 'Maximum subTasks accepted from a single task result', '5')
    .option('--cwd <path>', 'Workspace directory', process.env.BABEL_O_LAUNCH_CWD ?? process.cwd())
    .action(async (options: OptimizeCommandOptions) => {
      if (options.providerSmokeLive) {
        await runOptimizerProviderSmokeLive(options)
        return
      }

      const targetPath = options.target
      if (!targetPath) {
        console.error(chalk.red('Error: --target option is required.'))
        process.exit(1)
      }

      let subAgentOptions: OptimizeSubAgentOptions
      try {
        subAgentOptions = parseOptimizeSubAgentOptions(options)
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`))
        process.exit(1)
      }

      console.log(chalk.bold.blue(`Starting optimizer on: ${targetPath} (focus: ${options.focus})`))
      if (subAgentOptions.enableSubAgents) {
        console.log(chalk.dim(`Sub-agents enabled: max depth ${subAgentOptions.maxSubAgentDepth}, max subTasks/task ${subAgentOptions.maxSubTasksPerTask}`))
      } else {
        console.log(chalk.dim('Sub-agents disabled. Use --enable-subagents to allow task delegation.'))
      }

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
          const { createTaskSession } = await import('../../nexus/taskSession.js')
          createTaskSession({
            sessionId,
            cwd: options.cwd,
            prompt,
            queueId: sessionId,
          })
          const stepRunner = createRuntimeAgentStepRunner({
            cwd: options.cwd,
            model: options.model,
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
        const readline = await import('node:readline')
        const { stdin: input, stdout: output } = await import('node:process')
        const stepRunner = createRuntimeAgentStepRunner({
          cwd: options.cwd,
          model: options.model,
          runtimeFactory: async () => runtime,
        })
        const rl = readline.createInterface({ input, output })

        let finalSession
        try {
          finalSession = await runAgentLoop({
            sessionId,
            cwd: options.cwd,
            prompt,
            stepRunner,
            role: 'optimizer',
            autoApprove: options.autoApprove,
            enableSubAgents: subAgentOptions.enableSubAgents,
            maxSubAgentDepth: subAgentOptions.maxSubAgentDepth,
            maxSubTasksPerTask: subAgentOptions.maxSubTasksPerTask,
            reviewPlan: options.autoApprove || options.yes
              ? undefined
              : plan => askPlannerReview(rl, plan),
          })
        } finally {
          rl.close()
        }

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

export function renderPlannerPlan(plan: PlannerAgentResult): string {
  const lines = [
    chalk.green.bold('\n--- Optimization Plan ---'),
    chalk.white(plan.summary),
    chalk.cyan.bold('\nProposed Tasks:'),
  ]
  plan.tasks.forEach((task, index) => {
    lines.push(formatPlannerTask(task, index))
  })
  return lines.join('\n')
}

async function askPlannerReview(
  rl: CliReadline,
  plan: PlannerAgentResult,
): Promise<PlannerReviewDecision> {
  console.log(renderPlannerPlan(plan))
  console.log(chalk.dim('\nApprove the plan, edit task titles/descriptions, or reject before any files are changed.'))
  const answer = (await questionAsync(rl, chalk.cyan('Plan action [a]pprove/[e]dit/[r]eject: '))).trim().toLowerCase()
  if (answer === 'r' || answer === 'reject') {
    const reason = await questionAsync(rl, chalk.yellow('Rejection reason: '))
    return { approved: false, reason: reason.trim() || 'Rejected by user' }
  }
  if (answer === 'e' || answer === 'edit') {
    const editedTasks = await editPlannerTasks(rl, plan.tasks)
    if (editedTasks.length === 0) {
      return { approved: false, reason: 'All planner tasks were dropped by user' }
    }
    return { approved: true, tasks: editedTasks }
  }
  return { approved: true }
}

async function editPlannerTasks(
  rl: CliReadline,
  tasks: PlannerTaskPlan[],
): Promise<PlannerTaskPlan[]> {
  const edited: PlannerTaskPlan[] = []
  console.log(chalk.dim('Press Enter to keep each value. Enter "-" to drop a task.'))
  for (const [index, task] of tasks.entries()) {
    const title = await questionAsync(rl, chalk.cyan(`Task ${index + 1} title [${task.title}]: `))
    if (title.trim() === '-') continue
    const description = await questionAsync(rl, chalk.cyan(`Task ${index + 1} description [${task.description ?? ''}]: `))
    edited.push({
      ...task,
      title: title.trim() || task.title,
      description: description.trim() || task.description,
      metadata: {
        ...(task.metadata ?? {}),
        editedByUser: true,
      },
    })
  }
  if (edited.length === 0) {
    console.log(chalk.yellow('All tasks were dropped; rejecting plan.'))
  }
  if (edited.length > 0) {
    console.log(renderPlannerPlan({ summary: 'Edited optimization plan', tasks: edited }))
  }
  return edited
}

export function parseOptimizeProviderSmokeLiveOptions(options: OptimizeCommandOptions): { timeoutMs: number; model?: string } {
  return {
    timeoutMs: parsePositiveIntegerOption(options.timeoutMs, '--timeout-ms'),
    model: options.model,
  }
}

async function runOptimizerProviderSmokeLive(options: OptimizeCommandOptions): Promise<void> {
  const smokeOptions = parseOptimizeProviderSmokeLiveOptions(options)
  console.log(chalk.bold.blue('Running fixed AgentLoop provider live smoke.'))
  console.log(chalk.dim('This uses a temporary workspace, a fixed fixture file, and only the Read tool. It does not execute arbitrary user tasks.'))
  const { runAgentLoopLiveSmoke } = await import('../../nexus/agentLoopSmoke.js')
  const result = await runAgentLoopLiveSmoke(smokeOptions)
  console.log(formatAgentLoopSmokeResult(result))
  if (!result.success) {
    process.exitCode = 1
  }
}

function formatAgentLoopSmokeResult(result: any): string {
  const provider = result.provider ?? {}
  const checks = result.checks ?? {}
  const fallbackPolicy = result.fallbackPolicy ?? {}
  const usage = Array.isArray(result.usage) ? result.usage : []
  return [
    chalk.cyan('\n--- AgentLoop Provider Live Smoke ---'),
    `Provider:        ${provider.providerId ?? 'unknown'} model=${provider.modelId ?? 'unknown'}`,
    `Mode:            ${result.mode ?? 'unknown'}`,
    `Ready:           ${result.ready ? chalk.green('yes') : chalk.red('no')}`,
    `Live:            ${result.live ? chalk.green('yes') : chalk.red('no')} success=${result.success ? chalk.green('yes') : chalk.red('no')}`,
    `Checks:          auth=${yesNo(checks.authConfigured)} model=${yesNo(checks.modelResolved)} tools=${yesNo(checks.toolsSupported)} streaming=${yesNo(checks.streamingSupported)} structured=${yesNo(checks.structuredOutputSupported)}`,
    result.sessionId ? `Session:         ${result.sessionId} phase=${result.sessionPhase ?? 'unknown'}` : undefined,
    result.toolCallCount !== undefined ? `Tool calls:      ${result.toolCallCount}` : undefined,
    `Task/Critic:     taskCompleted=${yesNo(result.taskCompleted)} criticCompleted=${yesNo(result.criticCompleted)}`,
    `Workspace:       created=${yesNo(result.workspaceCreated)} cleaned=${yesNo(result.workspaceCleaned)}`,
    usage.length > 0 ? `Usage roles:     ${usage.map((item: any) => `${item.role}:events=${item.eventCount},tools=${item.toolCallCount}`).join(' | ')}` : undefined,
    result.error ? `Error:           ${result.error.message}` : undefined,
    `Fallback:        ${fallbackPolicy.mode ?? 'unknown'} silentSwitch=${fallbackPolicy.allowSilentModelSwitch === false ? 'false' : 'unknown'}`,
    `Next action:     ${fallbackPolicy.nextAction ?? chalk.dim('none')}`,
  ].filter(Boolean).join('\n')
}

function yesNo(value: unknown): string {
  return value ? 'yes' : 'no'
}

function formatPlannerTask(task: PlannerTaskPlan, index: number): string {
  const dependsOn = task.dependsOn && task.dependsOn.length > 0
    ? chalk.dim(` depends on ${task.dependsOn.join(', ')}`)
    : ''
  const description = task.description ? `: ${task.description}` : ''
  return chalk.white(`  ${index + 1}. [${task.title}]${description}`) + dependsOn
}

export function parseOptimizeSubAgentOptions(options: OptimizeCommandOptions): OptimizeSubAgentOptions {
  const maxSubAgentDepth = parsePositiveIntegerOption(
    options.maxSubAgentDepth,
    '--max-sub-agent-depth',
  )
  const maxSubTasksPerTask = parsePositiveIntegerOption(
    options.maxSubTasksPerTask,
    '--max-sub-tasks-per-task',
  )

  return {
    enableSubAgents: options.enableSubAgents === true || options.enableSubagents === true,
    maxSubAgentDepth,
    maxSubTasksPerTask,
  }
}

function parsePositiveIntegerOption(value: string | number | undefined, name: string): number {
  const normalized = Number(value)
  if (!Number.isInteger(normalized) || normalized < 1) {
    throw new Error(`${name} must be a positive integer.`)
  }
  return normalized
}
