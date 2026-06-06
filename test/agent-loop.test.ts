import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { runAgentLoop } from '../src/nexus/agentLoop.js'
import { runAgentLoopLiveSmoke } from '../src/nexus/agentLoopSmoke.js'
import {
  configureStorageBridgeWalForTest,
  flushStorageBridgeWalForTest,
  flushStorageBridgeForTest,
  getStorageBridgeStats,
  resetStorageBridgeForTest,
  setNexusStorage,
} from '../src/nexus/storageBridge.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'
import { PLANNER_ROLE, EXECUTOR_ROLE, CRITIC_ROLE, OPTIMIZER_ROLE } from '../src/nexus/agentRoles.js'
import { createRuntimeAgentStepRunner, RuntimeAgentStepError } from '../src/nexus/runtimeAgentStep.js'
import {
  completeNexusTask,
  createNexusTask,
  listNexusTasks,
  pruneTaskQueues,
  resetTaskQueuesForTest,
  taskQueueStatsForTest,
} from '../src/nexus/taskQueue.js'
import {
  cancelTaskSession,
  createTaskSession,
  getTaskSession,
  pruneTaskSessions,
  resetTaskSessionsForTest,
  setTaskSessionPhase,
  taskSessionStatsForTest,
} from '../src/nexus/taskSession.js'
import type { NexusTask } from '../src/shared/task.js'
import { ConfigManager } from '../src/shared/config.js'
import { closeNexusSession } from '../src/nexus/sessionLifecycle.js'
import { LLMCodingRuntime } from '../src/runtime/LLMCodingRuntime.js'
import { allowAllTools } from '../src/runtime/LocalCodingRuntime.js'
import { InMemoryRemoteToolRunner } from '../src/runtime/remoteRunner.js'
import { createDefaultToolRegistry } from '../src/tools/registry.js'
import { logger } from '../src/shared/logger.js'

function runGitSync(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
}

function createTempGitRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix))
  runGitSync(repo, ['init'])
  runGitSync(repo, ['config', 'user.name', 'Test Agent'])
  runGitSync(repo, ['config', 'user.email', 'agent@test.com'])
  writeFileSync(join(repo, 'main.txt'), 'original content', 'utf8')
  runGitSync(repo, ['add', '--', 'main.txt'])
  runGitSync(repo, ['commit', '-m', 'initial'])
  return repo
}

test('runAgentLoop runs successfully and handles critic approval', async () => {
  resetTaskQueuesForTest()
  resetTaskSessionsForTest()

  const storage = new MemoryStorage()
  setNexusStorage(storage)

  const sessionId = 'test-loop-success'
  const originalInstance = (ConfigManager as unknown as { instance?: ConfigManager }).instance
  const oldBabelOModel = process.env.BABEL_O_MODEL
  const tempConfig = new ConfigManager('/tmp/babel-o-agent-loop-role-diagnostics.json')
  tempConfig.save({ defaultModel: 'local/coding-runtime' })
  ;(ConfigManager as unknown as { instance?: ConfigManager }).instance = tempConfig
  delete process.env.BABEL_O_MODEL
  let criticTurns = 0

  const stepRunner = async ({ roleDefinition, input }: any): Promise<any> => {
    if (roleDefinition.role === 'planner') {
      return {
        summary: 'A simple plan',
        tasks: [
          { title: 'Optimize function X', description: 'Make it faster' }
        ]
      }
    }
    if (roleDefinition.role === 'executor' || roleDefinition.role === 'optimizer') {
      return {
        taskId: input.taskId,
        success: true,
        result: 'Optimized function X code',
        needsReview: true
      }
    }
    if (roleDefinition.role === 'critic') {
      criticTurns++
      if (criticTurns === 1) {
        return {
          approved: false,
          reason: 'Needs more formatting'
        }
      }
      return {
        approved: true
      }
    }
    throw new Error('Unknown role')
  }

  const workspace = mkdtempSync(join(tmpdir(), 'babel-o-agent-loop-success-'))

  try {
    const finalSession = await runAgentLoop({
      sessionId,
      cwd: workspace,
      prompt: 'Optimize src/nexus/app.ts',
      stepRunner,
      role: 'optimizer',
      autoApprove: false,
      maxRetriesPerTask: 3
    })

    // Verify phase
    if (finalSession.phase !== 'completed') {
      console.error('Test 1 failed with session:', finalSession)
    }
    assert.equal(finalSession.phase, 'completed')

    // Verify task status
    const queue = listNexusTasks(sessionId)
    assert.equal(queue.tasks.length, 1)
    assert.equal(queue.tasks[0].status, 'completed')
    assert.equal(queue.tasks[0].retryCount, 1) // 1 rejection retry

    const roleMetricEvents = finalSession.events.filter(
      event => event.type === 'task_session_event' && event.eventType === 'agent_loop_role_step_metrics',
    )
    const roleMetricPayloads = roleMetricEvents.map(event => {
      assert.equal(event.type, 'task_session_event')
      return event.payload as Record<string, unknown>
    })
    assert.ok(roleMetricPayloads.some(payload => payload.role === 'planner'))
    assert.ok(roleMetricPayloads.some(payload => payload.role === 'optimizer'))
    assert.ok(roleMetricPayloads.some(payload => payload.role === 'critic'))
    const plannerMetrics = roleMetricPayloads.find(payload => payload.role === 'planner')
    const plannerCapabilityDiagnostics = plannerMetrics?.capabilityDiagnostics as Record<string, any>
    assert.equal(plannerCapabilityDiagnostics.modelId, 'local/coding-runtime')
    assert.equal(plannerCapabilityDiagnostics.contextWindow, 8192)
    assert.equal(plannerCapabilityDiagnostics.capabilities.toolCalling, true)
    assert.equal(plannerCapabilityDiagnostics.capabilities.streaming, true)
    assert.deepEqual(plannerCapabilityDiagnostics.suitability.missingCapabilities, ['long_context'])
    assert.match(plannerCapabilityDiagnostics.manualSwitchHint, /No automatic switch will be performed/)
    assert.equal(plannerCapabilityDiagnostics.recommendation.willAutoSwitch, false)
    assert.equal(
      roleMetricPayloads.some(payload => 'input' in payload || 'output' in payload),
      false,
    )
  } finally {
    ;(ConfigManager as unknown as { instance?: ConfigManager }).instance = originalInstance
    if (oldBabelOModel) process.env.BABEL_O_MODEL = oldBabelOModel
    else delete process.env.BABEL_O_MODEL
    rmSync('/tmp/babel-o-agent-loop-role-diagnostics.json', { force: true })
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('runAgentLoop stops and marks failed when retry limit is reached', async () => {
  resetTaskQueuesForTest()
  resetTaskSessionsForTest()

  const storage = new MemoryStorage()
  setNexusStorage(storage)

  const sessionId = 'test-loop-failed'

  const stepRunner = async ({ roleDefinition, input }: any): Promise<any> => {
    if (roleDefinition.role === 'planner') {
      return {
        summary: 'A simple plan',
        tasks: [
          { title: 'Optimize function Y', description: 'Make it faster' }
        ]
      }
    }
    if (roleDefinition.role === 'executor' || roleDefinition.role === 'optimizer') {
      return {
        taskId: input.taskId,
        success: false,
        result: 'Execution failed',
      }
    }
    throw new Error('Should not reach critic')
  }

  const finalSession = await runAgentLoop({
    sessionId,
    cwd: process.cwd(),
    prompt: 'Optimize src/nexus/app.ts',
    stepRunner,
    role: 'executor',
    autoApprove: false,
    maxRetriesPerTask: 2
  })

  if (finalSession.phase !== 'failed') {
    console.error('Test 2 failed with session:', finalSession)
  }
  assert.equal(finalSession.phase, 'failed')
  const queue = listNexusTasks(sessionId)
  if (queue.tasks[0]?.status !== 'failed') {
    console.error('Test 2 task state mismatch:', queue.tasks[0])
  }
  assert.equal(queue.tasks.length, 1)
  assert.equal(queue.tasks[0].status, 'failed')
  assert.equal(queue.tasks[0].retryCount, 2) // Retried 2 times and then failed
})

test('runAgentLoop delegates executor subTasks and resumes parent after children complete', async () => {
  resetTaskQueuesForTest()
  resetTaskSessionsForTest()

  const storage = new MemoryStorage()
  setNexusStorage(storage)

  const sessionId = 'test-loop-subtasks'
  const executorCalls: Array<{ taskId: string; title: string; orchestration?: any }> = []

  const stepRunner = async ({ roleDefinition, input }: any): Promise<any> => {
    if (roleDefinition.role === 'planner') {
      return {
        summary: 'Plan with one broad task',
        tasks: [{ title: 'Implement feature suite' }],
      }
    }

    if (roleDefinition.role === 'executor') {
      executorCalls.push({
        taskId: input.taskId,
        title: input.title,
        orchestration: input.orchestration,
      })
      if (input.title === 'Implement feature suite' && !input.orchestration.delegatedSubTaskIds) {
        return {
          taskId: input.taskId,
          success: true,
          result: 'Delegated substantial work',
          needsReview: false,
          subTasks: [
            { title: 'Implement API', description: 'Add endpoint changes' },
            { title: 'Implement UI', description: 'Add interface changes', requiresIsolation: true },
          ],
        }
      }
      return {
        taskId: input.taskId,
        success: true,
        result: `Completed ${input.title}`,
        needsReview: false,
      }
    }

    throw new Error('Unexpected role')
  }

  const finalSession = await runAgentLoop({
    sessionId,
    cwd: process.cwd(),
    prompt: 'Implement a broad feature',
    stepRunner,
    role: 'executor',
    autoApprove: true,
    enableSubAgents: true,
    maxSubAgentDepth: 1,
  })

  assert.equal(finalSession.phase, 'completed')
  const tasks = listNexusTasks(sessionId).tasks
  assert.equal(tasks.length, 3)
  assert.ok(tasks.every(task => task.status === 'completed'))
  const parent = tasks.find(task => task.title === 'Implement feature suite')
  assert.deepEqual(parent?.metadata?.delegatedSubTaskIds, ['2', '3'])
  assert.deepEqual(parent?.dependsOn, ['2', '3'])
  assert.equal(tasks.find(task => task.title === 'Implement UI')?.metadata?.requiresIsolation, true)
  assert.deepEqual(
    executorCalls.map(call => call.title),
    ['Implement feature suite', 'Implement API', 'Implement UI', 'Implement feature suite'],
  )
  assert.equal(executorCalls[0].orchestration.remainingDepth, 1)
  assert.equal(executorCalls[1].orchestration.currentDepth, 1)
  assert.deepEqual(executorCalls[3].orchestration.delegatedSubTaskIds, ['2', '3'])
})

test('runAgentLoop audits configured sub-agent session approval inheritance', async () => {
  resetTaskQueuesForTest()
  resetTaskSessionsForTest()

  const storage = new MemoryStorage()
  setNexusStorage(storage)

  const sessionId = 'test-loop-subagent-approval-inheritance'

  const stepRunner = async ({ roleDefinition, input }: any): Promise<any> => {
    if (roleDefinition.role === 'planner') {
      return {
        summary: 'Plan with one delegated task',
        tasks: [{ title: 'Parent approval work' }],
      }
    }

    if (roleDefinition.role === 'executor') {
      if (input.title === 'Parent approval work' && !input.orchestration.delegatedSubTaskIds) {
        return {
          taskId: input.taskId,
          success: true,
          result: 'Delegated approval work',
          needsReview: false,
          subTasks: [{ title: 'Child approval work' }],
        }
      }
      return {
        taskId: input.taskId,
        success: true,
        result: `Completed ${input.title}`,
        needsReview: false,
      }
    }

    throw new Error('Unexpected role')
  }

  const finalSession = await runAgentLoop({
    sessionId,
    cwd: process.cwd(),
    prompt: 'Delegate with configured approval inheritance',
    stepRunner,
    role: 'executor',
    autoApprove: true,
    enableSubAgents: true,
    maxSubAgentDepth: 1,
    subAgentApprovalInheritance: {
      inheritSessionApprovals: true,
      sessionApprovalAllowTools: ['Bash', 'Write', 'TaskCreate', 'NotAllowed'],
    },
  })

  assert.equal(finalSession.phase, 'completed')
  const inheritanceEvent = finalSession.events.find(e => e.type === 'task_session_event' && e.eventType === 'subagent_permission_inheritance') as any
  assert.ok(inheritanceEvent)
  assert.equal(inheritanceEvent.payload.permissionInheritance.inheritsOnceApprovals, false)
  assert.equal(inheritanceEvent.payload.permissionInheritance.inheritsSessionApprovals, true)
  assert.deepEqual(inheritanceEvent.payload.permissionInheritance.inheritedSessionApprovalTools, ['Bash', 'Write'])
  assert.ok(inheritanceEvent.payload.permissionInheritance.inheritedAllowRules.includes('Bash'))
  assert.equal(inheritanceEvent.payload.permissionInheritance.inheritedSessionApprovalTools.includes('TaskCreate'), false)
  assert.equal(inheritanceEvent.payload.permissionInheritance.inheritedSessionApprovalTools.includes('NotAllowed'), false)

  const child = listNexusTasks(sessionId).tasks.find(task => task.title === 'Child approval work')
  const subSession = getTaskSession(`${sessionId}-sub-${child?.taskId}`)
  assert.equal(subSession.metadata?.permissionInheritance && (subSession.metadata.permissionInheritance as any).inheritsSessionApprovals, true)
  assert.deepEqual((subSession.metadata?.permissionInheritance as any)?.inheritedSessionApprovalTools, ['Bash', 'Write'])
})

test('runAgentLoop propagates cancelled child sub-agent failure to parent task', async () => {
  resetTaskQueuesForTest()
  resetTaskSessionsForTest()

  const storage = new MemoryStorage()
  setNexusStorage(storage)

  const sessionId = 'test-loop-subagent-cancel-propagates'

  const stepRunner = async ({ roleDefinition, input }: any): Promise<any> => {
    if (roleDefinition.role === 'planner') {
      return {
        summary: 'Plan with cancellable child work',
        tasks: [{ title: 'Parent feature work' }],
      }
    }

    if (roleDefinition.role === 'executor') {
      if (input.title === 'Parent feature work' && !input.orchestration.delegatedSubTaskIds) {
        return {
          taskId: input.taskId,
          success: true,
          result: 'Delegated cancellable work',
          needsReview: false,
          subTasks: [{ title: 'Cancellable child work', description: 'Will be cancelled' }],
        }
      }

      if (input.title === 'Cancellable child work') {
        cancelTaskSession(input.sessionId, 'child cancelled by test', 'CHILD_CANCELLED_FOR_TEST')
        return {
          taskId: input.taskId,
          success: true,
          result: 'This result must not overwrite cancellation',
          needsReview: false,
        }
      }

      return {
        taskId: input.taskId,
        success: true,
        result: 'Parent should not resume after failed dependency',
        needsReview: false,
      }
    }

    throw new Error('Unexpected role')
  }

  const finalSession = await runAgentLoop({
    sessionId,
    cwd: process.cwd(),
    prompt: 'Delegate and cancel child work',
    stepRunner,
    role: 'executor',
    autoApprove: true,
    enableSubAgents: true,
    maxSubAgentDepth: 1,
    maxRetriesPerTask: 1,
  })

  assert.equal(finalSession.phase, 'failed')
  const tasks = listNexusTasks(sessionId).tasks
  const parent = tasks.find(task => task.title === 'Parent feature work')
  const child = tasks.find(task => task.title === 'Cancellable child work')
  assert.equal(child?.status, 'failed')
  assert.equal((child?.metadata?.subAgent as any)?.status, 'cancelled')
  assert.equal((child?.metadata?.subAgent as any)?.summary, 'Nexus request was cancelled')
  assert.equal(child?.review?.reason, 'Sub-agent session was cancelled')
  assert.equal(parent?.status, 'failed')
  assert.equal((parent?.metadata?.failedDependencies as any[])?.[0]?.taskId, child?.taskId)
  assert.equal((parent?.metadata?.failedDependencies as any[])?.[0]?.metadata?.subAgent?.status, 'cancelled')
  assert.match(parent?.result ?? '', /Nexus request was cancelled/)
  assert.ok(finalSession.events.some(e => e.type === 'task_session_event' && e.eventType === 'subagent_cancelled'))

  const subSession = getTaskSession(`${sessionId}-sub-${child?.taskId}`)
  assert.equal(subSession.phase, 'cancelled')
  assert.equal(subSession.terminalReason?.code, 'CHILD_CANCELLED_FOR_TEST')
  assert.equal(subSession.metadata?.status, 'cancelled')
})

test('runAgentLoop rejects subTasks when maxSubAgentDepth is reached', async () => {
  resetTaskQueuesForTest()
  resetTaskSessionsForTest()

  const storage = new MemoryStorage()
  setNexusStorage(storage)

  const sessionId = 'test-loop-subtasks-depth-limit'

  const stepRunner = async ({ roleDefinition, input }: any): Promise<any> => {
    if (roleDefinition.role === 'planner') {
      return {
        summary: 'Plan with one task at depth limit',
        tasks: [
          {
            title: 'Already nested task',
            metadata: { depth: 1 },
          },
        ],
      }
    }

    if (roleDefinition.role === 'executor') {
      return {
        taskId: input.taskId,
        success: true,
        result: 'Did the work directly after rejected delegation',
        needsReview: false,
        subTasks: [{ title: 'Should not be created' }],
      }
    }

    throw new Error('Unexpected role')
  }

  const finalSession = await runAgentLoop({
    sessionId,
    cwd: process.cwd(),
    prompt: 'Try nested delegation',
    stepRunner,
    role: 'executor',
    autoApprove: true,
    enableSubAgents: true,
    maxSubAgentDepth: 1,
  })

  assert.equal(finalSession.phase, 'completed')
  const tasks = listNexusTasks(sessionId).tasks
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].status, 'completed')
  assert.equal(tasks[0].metadata?.subTasksRejected, true)
  assert.equal(tasks[0].metadata?.subTasksRejectedReason, 'maxSubAgentDepth reached')
})

test('runAgentLoop waits for planner review and uses edited plan', async () => {
  resetTaskQueuesForTest()
  resetTaskSessionsForTest()

  const storage = new MemoryStorage()
  setNexusStorage(storage)

  const sessionId = 'test-loop-plan-review-edit'
  let reviewedTitles: string[] = []

  const stepRunner = async ({ roleDefinition, input }: any): Promise<any> => {
    if (roleDefinition.role === 'planner') {
      return {
        summary: 'Original plan',
        tasks: [{ title: 'Original task', description: 'Before review' }],
      }
    }
    if (roleDefinition.role === 'executor') {
      return {
        taskId: input.taskId,
        success: true,
        result: `Completed ${input.title}`,
        needsReview: false,
      }
    }
    throw new Error('Unexpected role')
  }

  const finalSession = await runAgentLoop({
    sessionId,
    cwd: process.cwd(),
    prompt: 'Review plan before executing',
    stepRunner,
    role: 'executor',
    autoApprove: true,
    reviewPlan: plan => {
      reviewedTitles = plan.tasks.map(task => task.title)
      return {
        approved: true,
        tasks: [{ title: 'Edited task', description: 'After review' }],
      }
    },
  })

  assert.equal(finalSession.phase, 'completed')
  assert.deepEqual(reviewedTitles, ['Original task'])
  const tasks = listNexusTasks(sessionId).tasks
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].title, 'Edited task')
  assert.equal(tasks[0].description, 'After review')
  assert.ok(finalSession.events.some(event => event.type === 'task_session_event' && event.eventType === 'task_session_input_requested'))
  assert.ok(finalSession.events.some(event => event.type === 'task_session_event' && event.eventType === 'planner_review_approved'))
})

test('runAgentLoop cancels when planner review rejects the plan', async () => {
  resetTaskQueuesForTest()
  resetTaskSessionsForTest()

  const storage = new MemoryStorage()
  setNexusStorage(storage)

  const sessionId = 'test-loop-plan-review-reject'

  const stepRunner = async ({ roleDefinition }: any): Promise<any> => {
    if (roleDefinition.role === 'planner') {
      return {
        summary: 'Risky plan',
        tasks: [{ title: 'Risky task' }],
      }
    }
    throw new Error('Executor should not run after plan rejection')
  }

  const finalSession = await runAgentLoop({
    sessionId,
    cwd: process.cwd(),
    prompt: 'Reject plan',
    stepRunner,
    role: 'executor',
    autoApprove: true,
    reviewPlan: () => ({ approved: false, reason: 'Wrong direction' }),
  })

  assert.equal(finalSession.phase, 'cancelled')
  assert.equal(listNexusTasks(sessionId).tasks.length, 0)
  assert.equal(finalSession.terminalReason?.code, 'PLANNER_REJECTED')
  assert.ok(finalSession.events.some(event => event.type === 'task_session_event' && event.eventType === 'planner_review_rejected'))
})

test('task queues and task sessions prune old terminal state', () => {
  resetTaskQueuesForTest()
  resetTaskSessionsForTest()

  const task = createNexusTask({
    queueId: 'queue-prune',
    title: 'terminal task',
  })
  completeNexusTask({
    queueId: 'queue-prune',
    taskId: task.taskId,
  })
  assert.equal(taskQueueStatsForTest().tasks, 1)
  assert.equal(pruneTaskQueues({ olderThanMs: 0, nowMs: Date.now() + 1_000 }), 1)
  assert.equal(taskQueueStatsForTest().tasks, 0)

  createTaskSession({ sessionId: 'session-prune' })
  setTaskSessionPhase('session-prune', 'completed')
  assert.equal(taskSessionStatsForTest().sessions, 1)
  assert.equal(pruneTaskSessions({ olderThanMs: 0, nowMs: Date.now() + 1_000 }), 1)
  assert.equal(taskSessionStatsForTest().sessions, 0)
})

test('storageBridge retries failed task persistence before succeeding', async () => {
  resetStorageBridgeForTest()
  resetTaskQueuesForTest()
  resetTaskSessionsForTest()

  class FlakyStorage extends MemoryStorage {
    attempts = 0
    async saveTask(task: NexusTask): Promise<void> {
      this.attempts += 1
      if (this.attempts === 1) {
        throw new Error('temporary storage failure')
      }
      await super.saveTask(task)
    }
  }

  const storage = new FlakyStorage()
  setNexusStorage(storage)
  const task = createNexusTask({
    queueId: 'queue-storage-retry',
    title: 'retry persistence',
  })

  await flushStorageBridgeForTest()
  await flushStorageBridgeForTest()

  assert.equal(storage.attempts, 2)
  assert.equal((await storage.getTask(task.taskId))?.title, 'retry persistence')
  const stats = getStorageBridgeStats()
  assert.equal(stats.succeeded, 1)
  assert.equal(stats.failed, 1)
  assert.equal(stats.permanentFailures, 0)
})

test('storageBridge replays pending WAL operations after restart', async () => {
  resetStorageBridgeForTest()
  resetTaskQueuesForTest()
  resetTaskSessionsForTest()

  const tempDir = mkdtempSync(join(tmpdir(), 'babel-o-storage-bridge-'))
  const walPath = join(tempDir, 'storage.wal.jsonl')

  try {
    configureStorageBridgeWalForTest(walPath)
    setNexusStorage(null)

    const task = createNexusTask({
      queueId: 'queue-storage-wal',
      title: 'recover from wal',
    })

    assert.equal(getStorageBridgeStats().queued, 1)
    assert.equal(getStorageBridgeStats().walPending, 1)

    resetStorageBridgeForTest()
    configureStorageBridgeWalForTest(walPath)
    const storage = new MemoryStorage()
    setNexusStorage(storage)

    await flushStorageBridgeForTest()

    assert.equal((await storage.getTask(task.taskId))?.title, 'recover from wal')
    const stats = getStorageBridgeStats()
    assert.equal(stats.queued, 0)
    assert.equal(stats.walPending, 0)
    assert.equal(stats.succeeded, 1)
  } finally {
    resetStorageBridgeForTest()
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('storageBridge batches WAL writes and flushes explicitly', async () => {
  resetStorageBridgeForTest()
  resetTaskQueuesForTest()
  resetTaskSessionsForTest()

  const tempDir = mkdtempSync(join(tmpdir(), 'babel-o-storage-bridge-batch-'))
  const walPath = join(tempDir, 'storage.wal.jsonl')

  try {
    configureStorageBridgeWalForTest(walPath, {
      batchSize: 10,
      flushIntervalMs: 60_000,
      fsync: true,
    })
    setNexusStorage(null)

    for (let i = 0; i < 3; i++) {
      createNexusTask({
        queueId: 'queue-storage-wal-batch',
        title: `batched ${i}`,
      })
    }

    let stats = getStorageBridgeStats()
    assert.equal(stats.walPending, 3)
    assert.equal(stats.walBuffered, 3)
    assert.equal(stats.walFlushes, 0)
    assert.equal(stats.walBatchSize, 10)
    assert.equal(stats.walFlushIntervalMs, 60_000)
    assert.equal(stats.walFsync, true)
    assert.equal(existsSync(walPath), false)

    flushStorageBridgeWalForTest()
    stats = getStorageBridgeStats()
    assert.equal(stats.walBuffered, 0)
    assert.equal(stats.walFlushes, 1)
    assert.match(readFileSync(walPath, 'utf8'), /"recordType":"op"/)
  } finally {
    resetStorageBridgeForTest()
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('storageBridge skips malformed WAL records and replays valid pending operations', async () => {
  resetStorageBridgeForTest()
  resetTaskQueuesForTest()
  resetTaskSessionsForTest()

  const tempDir = mkdtempSync(join(tmpdir(), 'babel-o-storage-bridge-corrupt-'))
  const walPath = join(tempDir, 'storage.wal.jsonl')

  try {
    configureStorageBridgeWalForTest(walPath)
    setNexusStorage(null)

    const task = createNexusTask({
      queueId: 'queue-storage-wal-corrupt',
      title: 'recover around corrupt wal',
    })
    flushStorageBridgeWalForTest()
    writeFileSync(walPath, `${readFileSync(walPath, 'utf8')}{not-json\n`, 'utf8')

    resetStorageBridgeForTest()
    configureStorageBridgeWalForTest(walPath)
    const storage = new MemoryStorage()
    setNexusStorage(storage)

    await flushStorageBridgeForTest()

    assert.equal((await storage.getTask(task.taskId))?.title, 'recover around corrupt wal')
    const stats = getStorageBridgeStats()
    assert.equal(stats.queued, 0)
    assert.equal(stats.walPending, 0)
    assert.match(stats.lastError ?? '', /JSON/)
  } finally {
    resetStorageBridgeForTest()
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('storageBridge exposes compact failure diagnostics without dropping persisted work', async () => {
  resetStorageBridgeForTest()
  resetTaskQueuesForTest()
  resetTaskSessionsForTest()

  const tempDir = mkdtempSync(join(tmpdir(), 'babel-o-storage-bridge-compact-fail-'))
  const walPath = join(tempDir, 'storage.wal.jsonl')

  try {
    configureStorageBridgeWalForTest(walPath)
    setNexusStorage(null)

    const task = createNexusTask({
      queueId: 'queue-storage-wal-compact-fail',
      title: 'persist before compact failure',
    })
    flushStorageBridgeWalForTest()
    mkdirSync(`${walPath}.tmp`, { recursive: true })

    const storage = new MemoryStorage()
    setNexusStorage(storage)

    await flushStorageBridgeForTest()

    assert.equal((await storage.getTask(task.taskId))?.title, 'persist before compact failure')
    const stats = getStorageBridgeStats()
    assert.equal(stats.succeeded, 1)
    assert.equal(stats.walPending, 0)
    assert.ok(stats.lastError)
  } finally {
    resetStorageBridgeForTest()
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('storageBridge replays a large pending WAL after restart', async () => {
  resetStorageBridgeForTest()
  resetTaskQueuesForTest()
  resetTaskSessionsForTest()

  const tempDir = mkdtempSync(join(tmpdir(), 'babel-o-storage-bridge-large-'))
  const walPath = join(tempDir, 'storage.wal.jsonl')
  const taskCount = 1000

  try {
    configureStorageBridgeWalForTest(walPath, {
      batchSize: 128,
      flushIntervalMs: 60_000,
    })
    setNexusStorage(null)

    for (let i = 0; i < taskCount; i++) {
      createNexusTask({
        queueId: 'queue-storage-wal-large',
        title: `recover large ${i}`,
      })
    }
    flushStorageBridgeWalForTest()
    assert.equal(getStorageBridgeStats().walPending, taskCount)

    resetStorageBridgeForTest()
    configureStorageBridgeWalForTest(walPath, {
      batchSize: 128,
      flushIntervalMs: 60_000,
    })
    const storage = new MemoryStorage()
    setNexusStorage(storage)

    await flushStorageBridgeForTest()

    const tasks = await storage.listTasks('queue-storage-wal-large')
    assert.equal(tasks.length, taskCount)
    assert.equal(tasks[0].title, 'recover large 0')
    assert.equal(tasks.at(-1)?.title, `recover large ${taskCount - 1}`)
    const stats = getStorageBridgeStats()
    assert.equal(stats.queued, 0)
    assert.equal(stats.walPending, 0)
    assert.equal(stats.permanentFailures, 0)
  } finally {
    resetStorageBridgeForTest()
    rmSync(tempDir, { recursive: true, force: true })
  }
})

function createProviderMockStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

function anthropicTextResponse(text: string): ReadableStream<Uint8Array> {
  return createProviderMockStream([
    'event: content_block_start\n',
    'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\n',
    `data: ${JSON.stringify({ index: 0, delta: { type: 'text_delta', text } })}\n\n`,
    'event: content_block_stop\n',
    'data: {"index":0}\n\n',
    'event: message_stop\n',
    'data: {"type":"message_stop"}\n\n',
  ])
}

function anthropicToolResponse(options: {
  id: string
  name: string
  input: unknown
}): ReadableStream<Uint8Array> {
  return createProviderMockStream([
    'event: content_block_start\n',
    `data: ${JSON.stringify({
      index: 0,
      content_block: { type: 'tool_use', id: options.id, name: options.name, input: {} },
    })}\n\n`,
    'event: content_block_delta\n',
    `data: ${JSON.stringify({ index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(options.input) } })}\n\n`,
    'event: content_block_stop\n',
    'data: {"index":0}\n\n',
    'event: message_delta\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":10}}\n\n',
    'event: message_stop\n',
    'data: {"type":"message_stop"}\n\n',
  ])
}

function parseProviderRequestBody(init?: RequestInit): any {
  if (typeof init?.body !== 'string') return undefined
  return JSON.parse(init.body)
}

function isAgentLoopIntakeRequest(body: any): boolean {
  return JSON.stringify(body).includes('fast intake classifier')
}

function latestProviderUserText(body: any): string {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const latest = messages.at(-1)
  if (!latest) return ''
  if (typeof latest.content === 'string') return latest.content
  if (!Array.isArray(latest.content)) return ''
  return latest.content
    .map((block: any) => block?.text ?? block?.content ?? '')
    .join('\n')
}

test('runAgentLoop non-dry-run provider smoke executes fixed runtime-backed task', async () => {
  resetTaskQueuesForTest()
  resetTaskSessionsForTest()

  const workspace = mkdtempSync(join(tmpdir(), 'babel-o-agent-provider-smoke-'))
  const targetFile = join(workspace, 'fixture.txt')
  writeFileSync(targetFile, 'safe provider-backed smoke fixture\n', 'utf8')

  const originalFetch = globalThis.fetch
  const originalInstance = (ConfigManager as unknown as { instance?: ConfigManager }).instance
  const configPath = join(workspace, 'config.json')
  const configManager = new ConfigManager(configPath)
  configManager.save({
    defaultModel: 'anthropic/claude-3-5-sonnet',
    providers: {
      anthropic: {
        apiKey: 'test-agent-loop-provider-key',
        baseUrl: 'https://agent-loop-smoke.invalid',
      },
    },
  })
  ;(ConfigManager as unknown as { instance?: ConfigManager }).instance = configManager

  const storage = new MemoryStorage()
  setNexusStorage(storage)
  const tools = createDefaultToolRegistry()
  const runtime = new LLMCodingRuntime(tools, allowAllTools(), storage, configManager)
  const requestBodies: any[] = []

  globalThis.fetch = async (_url, init) => {
    const body = parseProviderRequestBody(init)
    requestBodies.push(body)
    if (isAgentLoopIntakeRequest(body)) {
      return {
        ok: true,
        status: 200,
        body: anthropicTextResponse(JSON.stringify({
          intent: 'continue',
          confidence: 0.95,
          continuity: 0.8,
          contextScope: 'full',
          actionHint: 'normal',
          requiresTools: true,
          reason: 'Fixed AgentLoop provider smoke should proceed.',
          guidance: 'Proceed with the fixed smoke task.',
          explicitPaths: [],
        })),
        text: async () => 'mock intake',
      } as Response
    }

    const latestText = latestProviderUserText(body)
    if (latestText.includes('Role:\nplanner')) {
      assert.deepEqual(body.tools?.map((tool: any) => tool.name).sort(), ['Glob', 'Grep', 'Read'])
      return {
        ok: true,
        status: 200,
        body: anthropicTextResponse(JSON.stringify({
          summary: 'Fixed provider smoke plan',
          tasks: [{
            title: 'Read fixed provider smoke fixture',
            description: 'Read only fixture.txt and summarize it.',
          }],
        })),
        text: async () => 'mock planner',
      } as Response
    }

    if (latestText.includes('Role:\noptimizer') && !latestText.includes('tool_result')) {
      assert.deepEqual(body.tools?.map((tool: any) => tool.name).sort(), ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'])
      return {
        ok: true,
        status: 200,
        body: anthropicToolResponse({
          id: 'tool-smoke-read',
          name: 'Read',
          input: { path: targetFile },
        }),
        text: async () => 'mock optimizer tool',
      } as Response
    }

    if (latestText.includes('safe provider-backed smoke fixture')) {
      return {
        ok: true,
        status: 200,
        body: anthropicTextResponse(JSON.stringify({
          taskId: '1',
          success: true,
          result: 'Read fixture.txt via provider-backed AgentLoop smoke.',
          needsReview: true,
        })),
        text: async () => 'mock optimizer final',
      } as Response
    }

    if (latestText.includes('Role:\ncritic')) {
      assert.equal(body.tools, undefined)
      return {
        ok: true,
        status: 200,
        body: anthropicTextResponse(JSON.stringify({
          approved: true,
          reason: 'Fixed provider smoke passed.',
        })),
        text: async () => 'mock critic',
      } as Response
    }

    throw new Error(`Unexpected provider request: ${latestText.slice(0, 400)}`)
  }

  try {
    const finalSession = await runAgentLoop({
      sessionId: 'test-provider-backed-agent-loop-smoke',
      cwd: workspace,
      prompt: 'Run the fixed non-dry-run AgentLoop provider smoke.',
      stepRunner: createRuntimeAgentStepRunner({
        cwd: workspace,
        model: 'anthropic/claude-3-5-sonnet',
        runtimeFactory: async () => runtime,
      }),
      role: 'optimizer',
      autoApprove: false,
      maxRetriesPerTask: 1,
    })

    assert.equal(finalSession.phase, 'completed')
    assert.ok(finalSession.events.some(event => event.type === 'task_session_event' && event.eventType === 'planner_completed'))
    assert.ok(finalSession.events.some(event => event.type === 'task_session_event' && event.eventType === 'task_completed'))
    assert.ok(finalSession.events.some(event => event.type === 'task_session_event' && event.eventType === 'critic_completed'))
    assert.ok(finalSession.events.some(event => event.type === 'tool_started' && event.name === 'Read'))
    assert.ok(finalSession.events.some(event => event.type === 'tool_completed' && event.name === 'Read' && event.success))
    assert.equal(listNexusTasks(finalSession.sessionId).tasks[0].status, 'completed')
    assert.equal(requestBodies.filter(isAgentLoopIntakeRequest).length, 3)
    assert.equal(requestBodies.some(body => JSON.stringify(body).includes('arbitrary user task')), false)
  } finally {
    globalThis.fetch = originalFetch
    ;(ConfigManager as unknown as { instance?: ConfigManager }).instance = originalInstance
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('runAgentLoopLiveSmoke uses fixed live/manual task and read-only tool surface', async () => {
  resetTaskQueuesForTest()
  resetTaskSessionsForTest()

  const originalFetch = globalThis.fetch
  const originalInstance = (ConfigManager as unknown as { instance?: ConfigManager }).instance
  const configPath = join(tmpdir(), `babel-o-agent-loop-live-smoke-${Date.now()}.json`)
  const configManager = new ConfigManager(configPath)
  configManager.save({
    defaultModel: 'anthropic/claude-3-5-sonnet',
    providers: {
      anthropic: {
        apiKey: 'test-agent-loop-live-smoke-key',
        baseUrl: 'https://agent-loop-live-smoke.invalid',
      },
    },
  })
  ;(ConfigManager as unknown as { instance?: ConfigManager }).instance = configManager

  const requestBodies: any[] = []
  globalThis.fetch = async (_url, init) => {
    const body = parseProviderRequestBody(init)
    requestBodies.push(body)
    if (isAgentLoopIntakeRequest(body)) {
      return {
        ok: true,
        status: 200,
        body: anthropicTextResponse(JSON.stringify({
          intent: 'continue',
          confidence: 0.95,
          continuity: 0.8,
          contextScope: 'current_task',
          actionHint: 'normal',
          requiresTools: true,
          reason: 'Fixed live smoke should proceed.',
          guidance: 'Proceed with the fixed live smoke task.',
          explicitPaths: [],
        })),
        text: async () => 'mock intake',
      } as Response
    }

    const latestText = latestProviderUserText(body)
    if (latestText.includes('Role:\nplanner')) {
      assert.deepEqual(body.tools?.map((tool: any) => tool.name).sort(), ['Read'])
      return {
        ok: true,
        status: 200,
        body: anthropicTextResponse(JSON.stringify({
          summary: 'Unsafe plan that should be replaced by reviewPlan',
          tasks: [{
            title: 'Run arbitrary user task',
            description: 'This should never be executed.',
          }],
        })),
        text: async () => 'mock planner',
      } as Response
    }

    if (latestText.includes('Role:\noptimizer') && !latestText.includes('BABEL_O_AGENT_LOOP_SMOKE_OK')) {
      assert.deepEqual(body.tools?.map((tool: any) => tool.name).sort(), ['Read'])
      assert.ok(latestText.includes('Read fixed AgentLoop live smoke fixture'))
      assert.equal(latestText.includes('Run arbitrary user task'), false)
      return {
        ok: true,
        status: 200,
        body: anthropicToolResponse({
          id: 'tool-live-smoke-read',
          name: 'Read',
          input: { path: 'fixture.txt' },
        }),
        text: async () => 'mock optimizer tool',
      } as Response
    }

    if (latestText.includes('Role:\ncritic')) {
      assert.equal(body.tools, undefined)
      return {
        ok: true,
        status: 200,
        body: anthropicTextResponse(JSON.stringify({
          approved: true,
          reason: 'Fixed live/manual AgentLoop smoke passed.',
        })),
        text: async () => 'mock critic',
      } as Response
    }

    if (latestText.includes('BABEL_O_AGENT_LOOP_SMOKE_OK')) {
      return {
        ok: true,
        status: 200,
        body: anthropicTextResponse(JSON.stringify({
          taskId: '1',
          success: true,
          result: 'Read fixture.txt and found BABEL_O_AGENT_LOOP_SMOKE_OK.',
          needsReview: true,
        })),
        text: async () => 'mock optimizer final',
      } as Response
    }

    throw new Error(`Unexpected live smoke request: ${latestText.slice(0, 400)}`)
  }

  try {
    const result = await runAgentLoopLiveSmoke({
      model: 'anthropic/claude-3-5-sonnet',
      timeoutMs: 30_000,
    })

    assert.equal(result.type, 'agent_loop_smoke')
    assert.equal(result.mode, 'live_manual')
    assert.equal(result.ready, true)
    assert.equal(result.live, true)
    assert.equal(result.success, true)
    assert.equal('apiKey' in result.provider, false)
    assert.equal(result.workspaceCreated, true)
    assert.equal(result.workspaceCleaned, true)
    assert.equal(result.plannerCompleted, true)
    assert.equal(result.taskCompleted, true)
    assert.equal(result.criticCompleted, true)
    assert.equal(result.toolCallCount, 1)
    assert.deepEqual(result.roleDiagnostics?.map(item => item.role), ['planner', 'optimizer', 'critic'])
    assert.deepEqual(result.roleDiagnostics?.map(item => item.allowedTools), [['Read'], ['Read'], []])
    assert.equal(result.roleDiagnostics?.every(item => item.model === 'anthropic/claude-3-5-sonnet'), true)
    assert.equal(result.roleDiagnostics?.every(item => item.repairAttempts === 0), true)
    assert.equal(JSON.stringify(result.roleDiagnostics).includes('test-agent-loop-live-smoke-key'), false)
    assert.equal(result.fallbackPolicy.allowSilentModelSwitch, false)
    assert.equal(requestBodies.some(body => latestProviderUserText(body).includes('Role:\noptimizer') && JSON.stringify(body).includes('Run arbitrary user task')), false)
    assert.equal(requestBodies.some(body => JSON.stringify(body).includes('test-agent-loop-live-smoke-key')), false)
  } finally {
    globalThis.fetch = originalFetch
    ;(ConfigManager as unknown as { instance?: ConfigManager }).instance = originalInstance
    rmSync(configPath, { force: true })
  }
})

test('runAgentLoopLiveSmoke aborts provider request on timeout and records partial role progress', async () => {
  resetTaskQueuesForTest()
  resetTaskSessionsForTest()

  const originalFetch = globalThis.fetch
  const originalInstance = (ConfigManager as unknown as { instance?: ConfigManager }).instance
  const configPath = join(tmpdir(), `babel-o-agent-loop-live-smoke-timeout-${Date.now()}.json`)
  const configManager = new ConfigManager(configPath)
  configManager.save({
    defaultModel: 'anthropic/claude-3-5-sonnet',
    providers: {
      anthropic: {
        apiKey: 'test-agent-loop-live-smoke-timeout-key',
        baseUrl: 'https://agent-loop-live-smoke-timeout.invalid',
      },
    },
  })
  ;(ConfigManager as unknown as { instance?: ConfigManager }).instance = configManager

  let optimizerAbortObserved = false
  globalThis.fetch = async (_url, init) => {
    const body = parseProviderRequestBody(init)
    if (isAgentLoopIntakeRequest(body)) {
      return {
        ok: true,
        status: 200,
        body: anthropicTextResponse(JSON.stringify({
          intent: 'continue',
          confidence: 0.95,
          continuity: 0.8,
          contextScope: 'current_task',
          actionHint: 'normal',
          requiresTools: true,
          reason: 'Fixed live smoke should proceed.',
          guidance: 'Proceed with the fixed live smoke task.',
          explicitPaths: [],
        })),
        text: async () => 'mock intake',
      } as Response
    }

    const latestText = latestProviderUserText(body)
    if (latestText.includes('Role:\nplanner')) {
      return {
        ok: true,
        status: 200,
        body: anthropicTextResponse(JSON.stringify({
          summary: 'Plan for timeout smoke',
          tasks: [{ title: 'Read fixed AgentLoop live smoke fixture' }],
        })),
        text: async () => 'mock planner',
      } as Response
    }

    if (latestText.includes('Role:\noptimizer')) {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          optimizerAbortObserved = true
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
      })
    }

    throw new Error(`Unexpected timeout smoke request: ${latestText.slice(0, 400)}`)
  }

  try {
    const result = await runAgentLoopLiveSmoke({
      model: 'anthropic/claude-3-5-sonnet',
      timeoutMs: 250,
    })

    assert.equal(result.success, false)
    assert.equal(result.live, false)
    assert.equal(result.error?.message, 'AgentLoop live smoke timed out after 250ms')
    assert.equal(result.error?.category, 'agent_loop_timeout')
    assert.equal(result.plannerCompleted, true)
    assert.equal(result.taskCompleted, false)
    assert.equal(result.criticCompleted, false)
    assert.equal(result.sessionPhase, 'failed')
    assert.equal(result.roleDiagnostics?.map(item => item.role).includes('planner'), true)
    const optimizerDiagnostic = result.roleDiagnostics?.find(item => item.role === 'optimizer')
    assert.ok(optimizerDiagnostic)
    assert.equal(optimizerDiagnostic.errorCode, 'REQUEST_TIMEOUT')
    assert.equal(optimizerDiagnostic.errorMessagePreview, 'The operation was aborted.')
    assert.equal(optimizerAbortObserved, true)
    assert.equal(JSON.stringify(result).includes('test-agent-loop-live-smoke-timeout-key'), false)
  } finally {
    globalThis.fetch = originalFetch
    ;(ConfigManager as unknown as { instance?: ConfigManager }).instance = originalInstance
    rmSync(configPath, { force: true })
  }
})

test('runtime agent step rejects structured roles on non-json models', async () => {
  resetTaskSessionsForTest()
  const sessionId = 'test-structured-output-gate'
  createTaskSession({ sessionId })

  const originalInstance = (ConfigManager as unknown as { instance?: ConfigManager }).instance
  const tempConfig = new ConfigManager('/tmp/babel-o-agent-step-config.json')
  tempConfig.save({
    defaultModel: 'local/coding-runtime',
    activeProfile: 'structured-gate',
    profiles: {
      'structured-gate': {
        model: 'anthropic/claude-3-opus',
        provider: 'anthropic',
        roles: {
          critic: 'anthropic/claude-3-opus',
        },
      },
    },
  })

  ;(ConfigManager as unknown as { instance?: ConfigManager }).instance = tempConfig
  try {
    let runtimeCalled = false
    const usageSummaries: any[] = []
    const stepRunner = createRuntimeAgentStepRunner({
      runtimeFactory: async () => ({
        async *executeStream() {
          runtimeCalled = true
          throw new Error('runtime should not be called when capability gate fails')
        },
      } as any),
      onUsageSummary: summary => usageSummaries.push(summary),
    })

    await assert.rejects(
      stepRunner({
        roleDefinition: CRITIC_ROLE,
        input: {
          sessionId,
          queueId: sessionId,
          taskId: '1',
          title: 'review',
          result: 'done',
        },
      }),
      /does not support structured output/,
    )

    assert.equal(runtimeCalled, false)
    assert.equal(usageSummaries.length, 1)
    assert.equal(usageSummaries[0].role, 'critic')
    assert.equal(usageSummaries[0].errorCode, 'AGENT_ROLE_CAPABILITY_MISMATCH')
    assert.equal(usageSummaries[0].capabilityDiagnostics.modelId, 'anthropic/claude-3-opus')
    assert.equal(usageSummaries[0].capabilityDiagnostics.modelSource, 'role')
    assert.notEqual(usageSummaries[0].capabilityDiagnostics.recommendation.modelId, 'anthropic/claude-3-opus')
    assert.equal(usageSummaries[0].capabilityDiagnostics.capabilities.structuredOutput, false)
    assert.deepEqual(usageSummaries[0].capabilityDiagnostics.suitability.missingCapabilities, ['structured_output'])
    assert.match(usageSummaries[0].capabilityDiagnostics.manualSwitchHint, /No automatic switch will be performed/)
    assert.equal(usageSummaries[0].capabilityDiagnostics.recommendation.willAutoSwitch, false)
  } finally {
    ;(ConfigManager as unknown as { instance?: ConfigManager }).instance = originalInstance
    rmSync('/tmp/babel-o-agent-step-config.json', { force: true })
  }
})

test('runtime agent step passes remote runner and allowed paths to runtime tools', async () => {
  resetTaskSessionsForTest()
  const workspace = mkdtempSync(join(tmpdir(), 'babel-o-agent-step-remote-'))
  const sessionId = 'test-agent-step-remote-runner'
  createTaskSession({ sessionId, cwd: workspace })
  const remoteRunner = new InMemoryRemoteToolRunner({
    capabilities: { tools: ['Write'], writeEnabled: true },
    handler: () => ({ kind: 'result', success: true, output: 'ok' }),
  })
  const executeOptions: any[] = []

  try {
    const stepRunner = createRuntimeAgentStepRunner({
      cwd: workspace,
      executionEnvironment: 'remote',
      remoteRunner,
      allowedPaths: [workspace],
      runtimeFactory: async () => ({
        async *executeStream(options: any) {
          executeOptions.push(options)
          yield {
            type: 'result',
            schemaVersion: '2026-05-21.babel-o.v1',
            sessionId,
            timestamp: new Date().toISOString(),
            success: true,
            message: JSON.stringify({ taskId: 'task-remote-step', success: true, result: 'remote step complete' }),
          }
        },
      } as any),
    })

    const output = await stepRunner({
      roleDefinition: EXECUTOR_ROLE,
      input: {
        sessionId,
        queueId: sessionId,
        taskId: 'task-remote-step',
        title: 'Write remote file',
      },
    }) as any

    assert.equal(output.success, true)
    assert.equal(executeOptions.length, 1)
    assert.equal(executeOptions[0].executionEnvironment, 'remote')
    assert.equal(executeOptions[0].remoteRunner, remoteRunner)
    assert.equal(executeOptions[0].cwd, workspace)
    assert.deepEqual(executeOptions[0].allowedPaths, [workspace])
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('runtime agent step surfaces diagnostics on structured output parse failure', async () => {
  resetTaskSessionsForTest()
  const sessionId = 'test-agent-step-diagnostics'
  createTaskSession({ sessionId })

  const stepRunner = createRuntimeAgentStepRunner({
    runtimeFactory: async () => ({
      async *executeStream() {
        yield {
          type: 'tool_completed',
          schemaVersion: '2026-05-21.babel-o.v1',
          sessionId,
          timestamp: new Date().toISOString(),
          toolUseId: 'tool-1',
          name: 'Bash',
          success: false,
          output: { stderr: 'command failed with code 2', exitCode: 2 },
        }
        yield {
          type: 'result',
          schemaVersion: '2026-05-21.babel-o.v1',
          sessionId,
          timestamp: new Date().toISOString(),
          success: true,
          message: 'not json',
        }
      },
    } as any),
  })

  await assert.rejects(
    stepRunner({
      roleDefinition: OPTIMIZER_ROLE,
      input: {
        sessionId,
        queueId: sessionId,
        taskId: 'task-diagnostics',
        title: 'diagnose',
      },
    }),
    (err: unknown) => {
      assert.ok(err instanceof RuntimeAgentStepError)
      assert.equal(err.summary.toolResultCount, 1)
      assert.equal(err.summary.toolFailedCount, 1)
      assert.equal(err.summary.lastToolName, 'Bash')
      assert.match(err.summary.lastToolOutputPreview ?? '', /command failed/)
      assert.equal(err.summary.structuredOutput?.failureType, 'no_structured_json')
      assert.equal(err.summary.structuredOutput?.providerNeutralFailureKind, 'json_parse_error')
      assert.equal(err.summary.structuredOutput?.candidateCount, 0)
      assert.match(err.message, /structured output/)
      return true
    },
  )
})

test('runtime agent step diagnostics classify wrapped provider errors', async () => {
  resetTaskSessionsForTest()
  const sessionId = 'test-agent-step-provider-error-diagnostics'
  createTaskSession({ sessionId })

  const stepRunner = createRuntimeAgentStepRunner({
    runtimeFactory: async () => ({
      async *executeStream() {
        yield {
          type: 'result',
          schemaVersion: '2026-05-21.babel-o.v1',
          sessionId,
          timestamp: new Date().toISOString(),
          success: true,
          message: '```json\n{"error":{"code":"tool_call_id_mismatch","message":"Provider rejected tool_call_id replay"},"request_id":"req_provider_456"}\n```',
        }
      },
    } as any),
  })

  await assert.rejects(
    stepRunner({
      roleDefinition: OPTIMIZER_ROLE,
      input: {
        sessionId,
        queueId: sessionId,
        taskId: 'task-provider-error-diagnostics',
        title: 'diagnose provider error',
      },
    }),
    (err: unknown) => {
      assert.ok(err instanceof RuntimeAgentStepError)
      assert.equal(err.summary.structuredOutput?.failureType, 'provider_error')
      assert.equal(err.summary.structuredOutput?.providerNeutralFailureKind, 'provider_protocol')
      assert.equal(err.summary.structuredOutput?.candidateSources[0], 'assistantText')
      assert.match(err.message, /Provider returned an error/)
      return true
    },
  )
})

test('runtime agent step diagnostics include structured output missing required fields', async () => {
  resetTaskSessionsForTest()
  const sessionId = 'test-agent-step-structured-diagnostics'
  createTaskSession({ sessionId })

  const stepRunner = createRuntimeAgentStepRunner({
    runtimeFactory: async () => ({
      async *executeStream() {
        yield {
          type: 'result',
          schemaVersion: '2026-05-21.babel-o.v1',
          sessionId,
          timestamp: new Date().toISOString(),
          success: true,
          message: JSON.stringify({ status: 'completed', details: { checked: true } }),
        }
      },
    } as any),
  })

  await assert.rejects(
    stepRunner({
      roleDefinition: OPTIMIZER_ROLE,
      input: {
        sessionId,
        queueId: sessionId,
        taskId: 'task-structured-diagnostics',
        title: 'diagnose structured fields',
      },
    }),
    (err: unknown) => {
      assert.ok(err instanceof RuntimeAgentStepError)
      assert.equal(err.summary.structuredOutput?.failureType, 'schema_mismatch')
      assert.deepEqual(err.summary.structuredOutput?.candidateSources, ['assistantText'])
      assert.equal(err.summary.structuredOutput?.providerNeutralFailureKind, 'schema_mismatch')
      assert.ok(err.summary.structuredOutput?.missingRequiredKeys?.includes('taskId'))
      assert.ok(err.summary.structuredOutput?.missingRequiredKeys?.includes('success'))
      assert.ok(err.summary.structuredOutput?.missingRequiredKeys?.includes('result'))
      assert.ok((err.summary.structuredOutput?.schemaErrors?.length ?? 0) > 0)
      return true
    },
  )
})

test('runtime agent step repairs empty planner output with a smaller task list', async () => {
  resetTaskSessionsForTest()
  const sessionId = 'test-agent-step-planner-repair'
  createTaskSession({ sessionId })

  const prompts: string[] = []
  const usageSummaries: any[] = []
  const originalInstance = (ConfigManager as unknown as { instance?: ConfigManager }).instance
  const configPath = join(tmpdir(), `babel-o-agent-step-planner-repair-${Date.now()}.json`)
  const configManager = new ConfigManager(configPath)
  configManager.save({ defaultModel: 'anthropic/claude-3-5-sonnet' })
  ;(ConfigManager as unknown as { instance?: ConfigManager }).instance = configManager

  try {
    const stepRunner = createRuntimeAgentStepRunner({
      model: 'anthropic/claude-3-5-sonnet',
      onUsageSummary: usage => usageSummaries.push(usage),
      runtimeFactory: async () => ({
        async *executeStream({ prompt }: any) {
          prompts.push(prompt)
          yield {
            type: 'result',
            schemaVersion: '2026-05-21.babel-o.v1',
            sessionId,
            timestamp: new Date().toISOString(),
            success: true,
            message: prompts.length === 1
              ? '{}'
              : JSON.stringify({
                summary: 'Smaller repaired plan',
                tasks: [{ title: 'Inspect structured output repair path' }],
              }),
          }
        },
      } as any),
    })

    const output = await stepRunner({
      roleDefinition: PLANNER_ROLE,
      input: {
        sessionId,
        queueId: sessionId,
        goal: 'Fix broad structured output failures',
      },
    }) as any

    assert.equal(prompts.length, 2)
    assert.match(prompts[1], /Previous invalid output:/)
    assert.match(prompts[1], /assistantText: \{\}/)
    assert.equal(output.summary, 'Smaller repaired plan')
    assert.equal(output.tasks[0].title, 'Inspect structured output repair path')
    assert.equal(usageSummaries.at(-1)?.repairAttempts, 2)
  } finally {
    ;(ConfigManager as unknown as { instance?: ConfigManager }).instance = originalInstance
    rmSync(configPath, { force: true })
  }
})

test('runtime agent step repairs optimizer output while preserving raw output', async () => {
  resetTaskSessionsForTest()
  const sessionId = 'test-agent-step-optimizer-repair'
  createTaskSession({ sessionId })

  const prompts: string[] = []
  const originalInstance = (ConfigManager as unknown as { instance?: ConfigManager }).instance
  const configPath = join(tmpdir(), `babel-o-agent-step-optimizer-repair-${Date.now()}.json`)
  const configManager = new ConfigManager(configPath)
  configManager.save({ defaultModel: 'anthropic/claude-3-5-sonnet' })
  ;(ConfigManager as unknown as { instance?: ConfigManager }).instance = configManager

  try {
    const stepRunner = createRuntimeAgentStepRunner({
      model: 'anthropic/claude-3-5-sonnet',
      runtimeFactory: async () => ({
        async *executeStream({ prompt }: any) {
          prompts.push(prompt)
          yield {
            type: 'result',
            schemaVersion: '2026-05-21.babel-o.v1',
            sessionId,
            timestamp: new Date().toISOString(),
            success: true,
            message: prompts.length === 1
              ? JSON.stringify({ status: 'completed' })
              : JSON.stringify({
                taskId: 'task-optimizer-repair',
                success: true,
                result: 'Preserved raw optimizer summary from repair prompt.',
              }),
          }
        },
      } as any),
    })

    const output = await stepRunner({
      roleDefinition: OPTIMIZER_ROLE,
      input: {
        sessionId,
        queueId: sessionId,
        taskId: 'task-optimizer-repair',
        title: 'Repair optimizer output',
      },
    }) as any

    assert.equal(prompts.length, 2)
    assert.match(prompts[1], /Use the previous raw output/)
    assert.match(prompts[1], /assistantText: \{"status":"completed"\}/)
    assert.equal(output.taskId, 'task-optimizer-repair')
    assert.equal(output.success, true)
    assert.match(output.result, /Preserved raw optimizer summary/)
  } finally {
    ;(ConfigManager as unknown as { instance?: ConfigManager }).instance = originalInstance
    rmSync(configPath, { force: true })
  }
})

test('runtime agent step falls back to conservative critic rejection after repair failure', async () => {
  resetTaskSessionsForTest()
  const sessionId = 'test-agent-step-critic-conservative-repair'
  createTaskSession({ sessionId })

  const prompts: string[] = []
  const originalInstance = (ConfigManager as unknown as { instance?: ConfigManager }).instance
  const configPath = join(tmpdir(), `babel-o-agent-step-critic-repair-${Date.now()}.json`)
  const configManager = new ConfigManager(configPath)
  configManager.save({ defaultModel: 'anthropic/claude-3-5-sonnet' })
  ;(ConfigManager as unknown as { instance?: ConfigManager }).instance = configManager

  try {
    const stepRunner = createRuntimeAgentStepRunner({
      model: 'anthropic/claude-3-5-sonnet',
      runtimeFactory: async () => ({
        async *executeStream({ prompt }: any) {
          prompts.push(prompt)
          yield {
            type: 'result',
            schemaVersion: '2026-05-21.babel-o.v1',
            sessionId,
            timestamp: new Date().toISOString(),
            success: true,
            message: prompts.length === 1
              ? 'critic output was not json'
              : JSON.stringify({ verdict: 'unclear' }),
          }
        },
      } as any),
    })

    const output = await stepRunner({
      roleDefinition: CRITIC_ROLE,
      input: {
        sessionId,
        queueId: sessionId,
        taskId: 'task-critic-repair',
        title: 'Review repaired output',
        result: 'Executor result to review',
      },
    }) as any

    assert.equal(prompts.length, 2)
    assert.equal(output.approved, false)
    assert.match(output.reason, /needs-human-review/)
  } finally {
    ;(ConfigManager as unknown as { instance?: ConfigManager }).instance = originalInstance
    rmSync(configPath, { force: true })
  }
})

test('closeNexusSession cancels active child task sessions', async () => {
  resetTaskQueuesForTest()
  resetTaskSessionsForTest()
  const storage = new MemoryStorage()
  setNexusStorage(storage)

  const parent = createTaskSession({ sessionId: 'parent-close-session', cwd: process.cwd(), prompt: 'parent' })
  const child = createTaskSession({
    sessionId: 'parent-close-session-sub-1',
    cwd: process.cwd(),
    prompt: 'child',
    parentSessionId: parent.sessionId,
    metadata: {
      agentType: 'subagent',
      status: 'running',
      transcriptPath: 'nexus://sessions/parent-close-session-sub-1/events',
    },
  })
  setTaskSessionPhase(child.sessionId, 'executing')
  await flushStorageBridgeForTest()

  const result = await closeNexusSession({
    storage,
    sessionId: parent.sessionId,
    phase: 'cancelled',
    reason: 'test parent close',
  })

  assert.deepEqual(result.childSessionsCancelled, [child.sessionId])
  const cancelledChild = getTaskSession(child.sessionId)
  assert.equal(cancelledChild.phase, 'cancelled')
  assert.equal(cancelledChild.terminalReason?.code, 'PARENT_SESSION_CANCELLED')
  assert.equal(cancelledChild.metadata?.status, 'cancelled')
  assert.equal(cancelledChild.metadata?.cancelledByParentSessionId, parent.sessionId)
  assert.equal(result.session?.phase, 'cancelled')
})

test('runAgentLoop optimizer skips git bookkeeping outside git workspaces', async () => {
  resetTaskQueuesForTest()
  resetTaskSessionsForTest()

  const storage = new MemoryStorage()
  setNexusStorage(storage)

  const workspace = mkdtempSync(join(tmpdir(), 'babel-o-non-git-loop-'))
  const warnings: string[] = []
  const originalWarn = logger.warn
  logger.warn = (message: string, meta?: unknown) => {
    warnings.push(message)
    originalWarn(message, meta)
  }

  try {
    const finalSession = await runAgentLoop({
      sessionId: 'test-loop-non-git-optimizer',
      cwd: workspace,
      prompt: 'Run optimizer outside git',
      role: 'optimizer',
      autoApprove: true,
      stepRunner: async ({ roleDefinition, input }: any): Promise<any> => {
        if (roleDefinition.role === 'planner') {
          return {
            summary: 'Non git plan',
            tasks: [{ title: 'No git task' }],
          }
        }
        if (roleDefinition.role === 'optimizer') {
          return {
            taskId: input.taskId,
            success: true,
            result: 'Completed without git bookkeeping',
            needsReview: false,
          }
        }
        throw new Error('Unexpected role')
      },
    })

    assert.equal(finalSession.phase, 'completed')
    assert.equal(finalSession.events.some(event => event.type === 'task_session_event' && event.eventType === 'git_stash_performed'), false)
    assert.equal(finalSession.events.some(event => event.type === 'task_session_event' && event.eventType === 'git_commit_performed'), false)
    assert.equal(warnings.some(message => message.includes('Git commit failed')), false)
    assert.equal(warnings.some(message => message.includes('Git stash failed')), false)
  } finally {
    logger.warn = originalWarn
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('runAgentLoop blocks in-place optimizer in git workspaces without explicit approval', async () => {
  resetTaskQueuesForTest()
  resetTaskSessionsForTest()

  const storage = new MemoryStorage()
  setNexusStorage(storage)
  const repo = createTempGitRepo('babel-o-in-place-blocked-')

  try {
    const finalSession = await runAgentLoop({
      sessionId: 'test-in-place-optimizer-blocked',
      cwd: repo,
      prompt: 'Modify tracked file',
      role: 'optimizer',
      autoApprove: true,
      maxRetriesPerTask: 1,
      stepRunner: async ({ roleDefinition, input }: any): Promise<any> => {
        if (roleDefinition.role === 'planner') {
          return {
            summary: 'In-place plan',
            tasks: [{ title: 'Modify tracked file' }],
          }
        }
        if (roleDefinition.role === 'optimizer') {
          writeFileSync(join(input.cwd, 'main.txt'), 'should not run', 'utf8')
          return { taskId: input.taskId, success: true, result: 'unexpected', needsReview: false }
        }
        throw new Error(`Unexpected role ${roleDefinition.role}`)
      },
    })

    assert.equal(finalSession.phase, 'failed')
    assert.match(finalSession.error ?? '', /In-place optimizer execution requires explicit opt-in/)
    assert.equal(readFileSync(join(repo, 'main.txt'), 'utf8'), 'original content')
    assert.ok(finalSession.events.some(event => event.type === 'task_session_event' && event.eventType === 'optimizer_in_place_blocked'))
    assert.equal(finalSession.events.some(event => event.type === 'task_session_event' && event.eventType === 'git_commit_performed'), false)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('runAgentLoop records git status around explicitly allowed in-place optimizer tasks', async () => {
  resetTaskQueuesForTest()
  resetTaskSessionsForTest()

  const storage = new MemoryStorage()
  setNexusStorage(storage)
  const repo = createTempGitRepo('babel-o-in-place-approved-')

  try {
    const finalSession = await runAgentLoop({
      sessionId: 'test-in-place-optimizer-approved',
      cwd: repo,
      prompt: 'Modify tracked file',
      role: 'optimizer',
      autoApprove: true,
      allowInPlaceOptimizer: true,
      maxRetriesPerTask: 1,
      stepRunner: async ({ roleDefinition, input }: any): Promise<any> => {
        if (roleDefinition.role === 'planner') {
          return {
            summary: 'In-place plan',
            tasks: [{ title: 'Modify tracked file' }],
          }
        }
        if (roleDefinition.role === 'optimizer') {
          writeFileSync(join(input.cwd, 'main.txt'), 'agent modified content', 'utf8')
          return { taskId: input.taskId, success: true, result: 'modified file', needsReview: false }
        }
        throw new Error(`Unexpected role ${roleDefinition.role}`)
      },
    })

    assert.equal(finalSession.phase, 'completed')
    assert.equal(readFileSync(join(repo, 'main.txt'), 'utf8'), 'agent modified content')
    assert.ok(finalSession.events.some(event => event.type === 'task_session_event' && event.eventType === 'optimizer_in_place_approved'))
    const before = finalSession.events.find(event => event.type === 'task_session_event' && event.eventType === 'git_status_before_task') as any
    const after = finalSession.events.find(event => event.type === 'task_session_event' && event.eventType === 'git_status_after_task') as any
    const resolution = finalSession.events.find(event => event.type === 'task_session_event' && event.eventType === 'git_status_after_resolution') as any
    assert.ok(before)
    assert.ok(after)
    assert.ok(resolution)
    assert.deepEqual(before.payload.snapshot.changedPaths, [])
    assert.deepEqual(after.payload.snapshot.changedPaths, ['main.txt'])
    assert.equal(resolution.payload.note, 'git_commit_performed')
    assert.deepEqual(resolution.payload.snapshot.changedPaths, [])
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('runAgentLoop does not silently fall back to in-place when requested worktree creation fails', async () => {
  resetTaskQueuesForTest()
  resetTaskSessionsForTest()

  const storage = new MemoryStorage()
  setNexusStorage(storage)
  const repo = createTempGitRepo('babel-o-worktree-fail-')
  const conflictingWorktreeDir = join(repo, '.babel-o', 'worktrees', '1')
  mkdirSync(conflictingWorktreeDir, { recursive: true })
  writeFileSync(join(conflictingWorktreeDir, 'occupied.txt'), 'occupied', 'utf8')

  try {
    const finalSession = await runAgentLoop({
      sessionId: 'test-worktree-failure-no-fallback',
      cwd: repo,
      prompt: 'Modify isolated file',
      role: 'optimizer',
      autoApprove: true,
      maxRetriesPerTask: 1,
      stepRunner: async ({ roleDefinition, input }: any): Promise<any> => {
        if (roleDefinition.role === 'planner') {
          return {
            summary: 'Isolation plan',
            tasks: [{ title: 'Modify isolated file', metadata: { requiresIsolation: true } }],
          }
        }
        if (roleDefinition.role === 'optimizer') {
          writeFileSync(join(input.cwd, 'main.txt'), 'should not run', 'utf8')
          return { taskId: input.taskId, success: true, result: 'unexpected', needsReview: false }
        }
        throw new Error(`Unexpected role ${roleDefinition.role}`)
      },
    })

    assert.equal(finalSession.phase, 'failed')
    assert.match(finalSession.error ?? '', /In-place optimizer execution requires explicit opt-in/)
    assert.equal(readFileSync(join(repo, 'main.txt'), 'utf8'), 'original content')
    assert.ok(finalSession.events.some(event => event.type === 'task_session_event' && event.eventType === 'worktree_create_failed'))
    assert.ok(finalSession.events.some(event => event.type === 'task_session_event' && event.eventType === 'optimizer_in_place_blocked'))
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('runAgentLoop preserves isolated worktree and records recovery metadata on merge conflict', async () => {
  resetTaskQueuesForTest()
  resetTaskSessionsForTest()

  const storage = new MemoryStorage()
  setNexusStorage(storage)

  const rootDir = resolve(process.cwd())
  const babelODir = join(rootDir, '.babel-o')
  if (!existsSync(babelODir)) {
    mkdirSync(babelODir)
  }
  const testRepoDir = join(babelODir, `test-agent-conflict-repo-${Date.now()}`)
  mkdirSync(testRepoDir)

  const runRepoCmd = (cmd: string, args: string[]) => {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, args, { cwd: testRepoDir })
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`${cmd} ${args.join(' ')} failed with code ${code}`))
      })
    })
  }

  try {
    await runRepoCmd('git', ['init'])
    await runRepoCmd('git', ['config', 'user.name', 'Test Agent'])
    await runRepoCmd('git', ['config', 'user.email', 'agent@test.com'])

    const conflictFile = join(testRepoDir, 'conflict.txt')
    writeFileSync(conflictFile, 'line 1\nline 2\nline 3\n', 'utf8')
    await runRepoCmd('git', ['add', '.'])
    await runRepoCmd('git', ['commit', '-m', 'initial'])

    const sessionId = 'test-isolated-loop-conflict'
    let isolatedCwd = ''

    const stepRunner = async ({ roleDefinition, input }: any): Promise<any> => {
      if (roleDefinition.role === 'planner') {
        return {
          summary: 'Conflict planning',
          tasks: [
            {
              title: 'Write conflicting file',
              description: 'Modify conflict.txt',
              metadata: { requiresIsolation: true },
            },
          ],
        }
      }
      if (roleDefinition.role === 'optimizer') {
        isolatedCwd = input.cwd
        writeFileSync(join(input.cwd, 'conflict.txt'), 'line 1\nline 2 modified in worktree\nline 3\n', 'utf8')
        writeFileSync(conflictFile, 'line 1\nline 2 modified in parent\nline 3\n', 'utf8')
        await runRepoCmd('git', ['add', '.'])
        await runRepoCmd('git', ['commit', '-m', 'parent modification'])
        return {
          taskId: input.taskId,
          success: true,
          result: 'Modified conflict file',
          needsReview: true,
        }
      }
      if (roleDefinition.role === 'critic') {
        return { approved: true }
      }
      throw new Error(`Unexpected role ${roleDefinition.role}`)
    }

    const finalSession = await runAgentLoop({
      sessionId,
      cwd: testRepoDir,
      prompt: 'Write conflicting file',
      stepRunner,
      role: 'optimizer',
      autoApprove: false,
      maxRetriesPerTask: 1,
    })

    assert.equal(finalSession.phase, 'waiting_user')
    assert.equal(finalSession.pendingInput?.reason, 'worktree_merge_conflict')
    assert.equal(existsSync(isolatedCwd), true)
    assert.equal(existsSync(join(testRepoDir, '.git', 'CHERRY_PICK_HEAD')), false)

    const task = listNexusTasks(sessionId).tasks[0]
    assert.equal(task.status, 'failed')
    assert.equal((task.metadata?.worktreeRecovery as any).type, 'worktree_merge_conflict')
    assert.equal((task.metadata?.worktreeRecovery as any).preservedWorktreePath, isolatedCwd)
    assert.equal((task.metadata?.worktreeRecovery as any).conflictingFiles.includes('conflict.txt'), true)
    assert.deepEqual((task.metadata?.worktreeRecovery as any).recoveryActions.map((action: any) => action.action), ['keep', 'continue', 'abandon'])
    assert.ok(finalSession.events.some(event => event.type === 'task_session_event' && event.eventType === 'worktree_merge_conflict'))
  } finally {
    if (existsSync(testRepoDir)) {
      rmSync(testRepoDir, { recursive: true, force: true })
    }
  }
})

test('runAgentLoop runs with requiresIsolation and successfully manages Git Worktree lifecycle', async () => {
  resetTaskQueuesForTest()
  resetTaskSessionsForTest()

  const storage = new MemoryStorage()
  setNexusStorage(storage)

  // Initialize a temp Git repository inside the workspace
  const rootDir = resolve(process.cwd())
  const babelODir = join(rootDir, '.babel-o')
  if (!existsSync(babelODir)) {
    mkdirSync(babelODir)
  }
  const testRepoDir = join(babelODir, `test-agent-repo-${Date.now()}`)
  mkdirSync(testRepoDir)

  const runRepoCmd = (cmd: string, args: string[]) => {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, args, { cwd: testRepoDir })
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`${cmd} ${args.join(' ')} failed with code ${code}`))
      })
    })
  }

  try {
    await runRepoCmd('git', ['init'])
    await runRepoCmd('git', ['config', 'user.name', 'Test Agent'])
    await runRepoCmd('git', ['config', 'user.email', 'agent@test.com'])

    // Create initial commit
    const dummy = join(testRepoDir, 'main.txt')
    writeFileSync(dummy, 'original content', 'utf8')
    await runRepoCmd('git', ['add', '.'])
    await runRepoCmd('git', ['commit', '-m', 'initial'])

    const sessionId = 'test-isolated-loop'
    let stepRunnerCwd: string | undefined

    const stepRunner = async ({ roleDefinition, input }: any): Promise<any> => {
      if (roleDefinition.role === 'planner') {
        return {
          summary: 'Isolated planning',
          tasks: [
            {
              title: 'Write isolated file',
              description: 'Create isolated.txt',
              metadata: { requiresIsolation: true }
            }
          ]
        }
      }
      if (roleDefinition.role === 'executor' || roleDefinition.role === 'optimizer') {
        stepRunnerCwd = input.cwd
        assert.ok(input.cwd)
        assert.ok(input.cwd.includes('.babel-o/worktrees'))
        assert.deepEqual(input.allowedPaths, [input.cwd])

        writeFileSync(join(input.cwd, 'isolated.txt'), 'hello isolated content', 'utf8')

        return {
          taskId: input.taskId,
          success: true,
          result: 'Wrote isolated file successfully',
          needsReview: true
        }
      }
      if (roleDefinition.role === 'critic') {
        assert.ok(input.cwd)
        assert.ok(input.cwd.includes('.babel-o/worktrees'))
        assert.deepEqual(input.allowedPaths, [input.cwd])

        const fileContent = readFileSync(join(input.cwd, 'isolated.txt'), 'utf8')
        assert.equal(fileContent, 'hello isolated content')

        return { approved: true }
      }
      throw new Error('Unknown role')
    }

    const finalSession = await runAgentLoop({
      sessionId,
      cwd: testRepoDir,
      prompt: 'Write isolated file',
      stepRunner,
      role: 'optimizer',
      autoApprove: false,
      maxRetriesPerTask: 2
    })

    assert.equal(finalSession.phase, 'completed')

    // Verify worktree changes were merged back to main repository
    const mergedFilePath = join(testRepoDir, 'isolated.txt')
    assert.equal(existsSync(mergedFilePath), true)
    assert.equal(readFileSync(mergedFilePath, 'utf8'), 'hello isolated content')

    // Verify worktree directory is cleaned up
    assert.ok(stepRunnerCwd)
    assert.equal(existsSync(stepRunnerCwd), false)
    assert.ok(finalSession.events.some(event => event.type === 'task_session_event' && event.eventType === 'worktree_merged'))
    assert.equal(finalSession.events.some(event => event.type === 'task_session_event' && event.eventType === 'git_commit_performed'), false)

  } finally {
    if (existsSync(testRepoDir)) {
      rmSync(testRepoDir, { recursive: true, force: true })
    }
  }
})

test('runAgentLoop optimizer rollback preserves unrelated untracked files', async () => {
  resetTaskQueuesForTest()
  resetTaskSessionsForTest()

  const storage = new MemoryStorage()
  setNexusStorage(storage)

  const rootDir = resolve(process.cwd())
  const babelODir = join(rootDir, '.babel-o')
  if (!existsSync(babelODir)) {
    mkdirSync(babelODir)
  }
  const testRepoDir = join(babelODir, `test-agent-rollback-repo-${Date.now()}`)
  mkdirSync(testRepoDir)

  const runRepoCmd = (cmd: string, args: string[]) => {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, args, { cwd: testRepoDir })
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`${cmd} ${args.join(' ')} failed with code ${code}`))
      })
    })
  }

  try {
    await runRepoCmd('git', ['init'])
    await runRepoCmd('git', ['config', 'user.name', 'Test Agent'])
    await runRepoCmd('git', ['config', 'user.email', 'agent@test.com'])

    const trackedFile = join(testRepoDir, 'tracked.txt')
    const untrackedFile = join(testRepoDir, 'user-notes.txt')
    writeFileSync(trackedFile, 'original content', 'utf8')
    await runRepoCmd('git', ['add', '.'])
    await runRepoCmd('git', ['commit', '-m', 'initial'])
    writeFileSync(untrackedFile, 'manual user scratchpad', 'utf8')

    const stepRunner = async ({ roleDefinition, input }: any): Promise<any> => {
      if (roleDefinition.role === 'planner') {
        return {
          summary: 'Rollback plan',
          tasks: [{ title: 'Modify tracked file', description: 'This will be rejected' }],
        }
      }
      if (roleDefinition.role === 'optimizer') {
        writeFileSync(join(input.cwd, 'tracked.txt'), 'agent modified content', 'utf8')
        return {
          taskId: input.taskId,
          success: true,
          result: 'Modified tracked file',
          needsReview: true,
        }
      }
      if (roleDefinition.role === 'critic') {
        return { approved: false, reason: 'Reject to test rollback' }
      }
      throw new Error(`Unexpected role ${roleDefinition.role}`)
    }

    const finalSession = await runAgentLoop({
      sessionId: 'test-optimizer-rollback-preserves-untracked',
      cwd: testRepoDir,
      prompt: 'Modify tracked file',
      stepRunner,
      role: 'optimizer',
      allowInPlaceOptimizer: true,
      maxRetriesPerTask: 1,
    })

    assert.equal(finalSession.phase, 'failed')
    assert.equal(readFileSync(trackedFile, 'utf8'), 'original content')
    assert.equal(readFileSync(untrackedFile, 'utf8'), 'manual user scratchpad')
    assert.ok(finalSession.events.some(event =>
      event.type === 'task_session_event' && event.eventType === 'git_rollback_performed',
    ))
  } finally {
    if (existsSync(testRepoDir)) {
      rmSync(testRepoDir, { recursive: true, force: true })
    }
  }
})

test('runAgentLoop reruns failed sub-agent tasks with a new child transcript', async () => {
  resetTaskQueuesForTest()
  resetTaskSessionsForTest()

  const storage = new MemoryStorage()
  setNexusStorage(storage)

  const sessionId = 'test-sub-agent-rerun-transcript'
  const firstChildSessionId = `${sessionId}-sub-2`
  const retryChildSessionId = `${sessionId}-sub-2-retry-1`
  let firstChildExecutorFailures = 0

  const stepRunner = async ({ roleDefinition, input }: any): Promise<any> => {
    if (roleDefinition.role === 'planner') {
      return {
        summary: 'Parent plan',
        tasks: [{ title: 'Delegate flaky child' }],
      }
    }
    if (roleDefinition.role === 'executor') {
      if (input.title === 'Delegate flaky child') {
        if (!input.orchestration.delegatedSubTaskIds) {
          return {
            taskId: input.taskId,
            success: true,
            result: 'Delegated flaky child',
            needsReview: false,
            subTasks: [{ title: 'Flaky child work' }],
          }
        }
        return {
          taskId: input.taskId,
          success: true,
          result: 'Parent completed after child rerun',
          needsReview: false,
        }
      }
      if (input.title === 'Flaky child work') {
        if (input.sessionId === firstChildSessionId) {
          firstChildExecutorFailures += 1
          return {
            taskId: input.taskId,
            success: false,
            result: 'Child failed first transcript',
            needsReview: false,
          }
        }
        return {
          taskId: input.taskId,
          success: true,
          result: 'Child succeeded on rerun',
          needsReview: false,
        }
      }
    }
    throw new Error(`Unexpected role ${roleDefinition.role}`)
  }

  const finalSession = await runAgentLoop({
    sessionId,
    cwd: process.cwd(),
    prompt: 'Delegate flaky child',
    stepRunner,
    role: 'executor',
    autoApprove: true,
    enableSubAgents: true,
    maxSubAgentDepth: 2,
    maxRetriesPerTask: 2,
  })

  assert.equal(finalSession.phase, 'completed')
  assert.equal(firstChildExecutorFailures, 2)
  const firstChild = getTaskSession(firstChildSessionId)
  const retryChild = getTaskSession(retryChildSessionId)
  assert.equal(firstChild.phase, 'failed')
  assert.equal(retryChild.phase, 'completed')
  assert.equal(firstChild.metadata?.transcriptPath, `nexus://sessions/${firstChildSessionId}/events`)
  assert.equal(retryChild.metadata?.transcriptPath, `nexus://sessions/${retryChildSessionId}/events`)

  const childTask = listNexusTasks(sessionId).tasks.find(task => task.title === 'Flaky child work')
  assert.equal(childTask?.status, 'completed')
  assert.equal(childTask?.retryCount, 1)
  assert.equal((childTask?.metadata?.subAgent as any).subSessionId, retryChildSessionId)
  assert.equal((childTask?.metadata?.previousSubAgents as any[])[0].subSessionId, firstChildSessionId)
  assert.equal((childTask?.metadata?.previousSubAgents as any[])[0].transcriptPath, `nexus://sessions/${firstChildSessionId}/events`)
})

test('runAgentLoop runs sub-agent session with isolation and merges changes back', async () => {
  resetTaskQueuesForTest()
  resetTaskSessionsForTest()

  const storage = new MemoryStorage()
  setNexusStorage(storage)

  // Initialize a temp Git repository inside the workspace
  const rootDir = resolve(process.cwd())
  const babelODir = join(rootDir, '.babel-o')
  if (!existsSync(babelODir)) {
    mkdirSync(babelODir)
  }
  const testRepoDir = join(babelODir, `test-sub-agent-repo-${Date.now()}`)
  mkdirSync(testRepoDir)

  const runRepoCmd = (cmd: string, args: string[]) => {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, args, { cwd: testRepoDir })
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`${cmd} ${args.join(' ')} failed with code ${code}`))
      })
    })
  }

  try {
    await runRepoCmd('git', ['init'])
    await runRepoCmd('git', ['config', 'user.name', 'Test Agent'])
    await runRepoCmd('git', ['config', 'user.email', 'agent@test.com'])

    // Create initial commit
    const dummy = join(testRepoDir, 'main.txt')
    writeFileSync(dummy, 'original content', 'utf8')
    await runRepoCmd('git', ['add', '.'])
    await runRepoCmd('git', ['commit', '-m', 'initial'])

    const sessionId = 'test-sub-agent-isolated'
    let subAgentCwd: string | undefined

    const stepRunner = async ({ roleDefinition, input }: any): Promise<any> => {
      if (roleDefinition.role === 'planner') {
        return {
          summary: 'Parent plan',
          tasks: [
            {
              title: 'Delegate to sub-agent task',
              description: 'This will spawn subtask',
            }
          ]
        }
      }

      if (roleDefinition.role === 'executor' || roleDefinition.role === 'optimizer') {
        if (input.title === 'Delegate to sub-agent task') {
          // If we haven't delegated yet, delegate subtask with requiresIsolation
          if (!input.orchestration.delegatedSubTaskIds) {
            return {
              taskId: input.taskId,
              success: true,
              result: 'Delegated task with isolation',
              needsReview: false,
              subTasks: [
                {
                  title: 'Isolated child work',
                  description: 'Write isolated file from sub-agent',
                  requiresIsolation: true,
                }
              ]
            }
          } else {
            // After subtasks completed, parent executor finishes
            return {
              taskId: input.taskId,
              success: true,
              result: 'All work completed successfully',
              needsReview: false,
            }
          }
        }

        if (input.title === 'Isolated child work') {
          subAgentCwd = input.cwd
          assert.ok(input.cwd)
          assert.ok(input.cwd.includes('.babel-o/worktrees'))

          // Sub-agent writes a file in its isolated cwd
          writeFileSync(join(input.cwd, 'sub-agent-file.txt'), 'written by sub-agent', 'utf8')

          return {
            taskId: input.taskId,
            success: true,
            result: 'Sub-agent wrote file successfully',
            needsReview: false,
          }
        }
      }

      throw new Error(`Unexpected role ${roleDefinition.role}`)
    }

    const finalSession = await runAgentLoop({
      sessionId,
      cwd: testRepoDir,
      prompt: 'Delegate work',
      stepRunner,
      role: 'executor',
      autoApprove: true,
      enableSubAgents: true,
      maxSubAgentDepth: 2,
    })

    assert.equal(finalSession.phase, 'completed')

    // Verify sub-agent worktree changes were merged back to main repository
    const mergedFilePath = join(testRepoDir, 'sub-agent-file.txt')
    assert.equal(existsSync(mergedFilePath), true)
    assert.equal(readFileSync(mergedFilePath, 'utf8'), 'written by sub-agent')

    // Verify sub-agent worktree directory is cleaned up
    assert.ok(subAgentCwd)
    assert.equal(existsSync(subAgentCwd), false)

    // Check events list to verify sub-agent lifecycle events were recorded
      const startedEvent = finalSession.events.find(e => e.type === 'task_session_event' && e.eventType === 'subagent_started') as any
    const inheritanceEvent = finalSession.events.find(e => e.type === 'task_session_event' && e.eventType === 'subagent_permission_inheritance') as any
    const completedEvent = finalSession.events.find(e => e.type === 'task_session_event' && e.eventType === 'subagent_completed') as any
    assert.ok(finalSession.events.some(e => e.type === 'task_session_event' && e.eventType === 'sub_agent_session_started'))
    assert.ok(finalSession.events.some(e => e.type === 'task_session_event' && e.eventType === 'sub_agent_session_completed'))
    assert.ok(startedEvent)
    assert.ok(inheritanceEvent)
    assert.ok(completedEvent)
    assert.equal(startedEvent.payload.agentType, 'subagent')
    assert.equal(startedEvent.payload.parentSessionId, sessionId)
    assert.equal(startedEvent.payload.parentTaskId, '1')
    assert.equal(startedEvent.payload.depth, 1)
    assert.equal(startedEvent.payload.status, 'running')
    assert.equal(startedEvent.payload.permissionInheritance.mode, 'role_policy')
    assert.deepEqual(startedEvent.payload.permissionInheritance.inheritsOnceApprovals, false)
    assert.deepEqual(startedEvent.payload.permissionInheritance.inheritsSessionApprovals, false)
    assert.deepEqual(startedEvent.payload.permissionInheritance.inheritedSessionApprovalTools, [])
    assert.ok(startedEvent.payload.permissionInheritance.inheritedAllowRules.includes('Write'))
    assert.equal(inheritanceEvent.payload.agentId, startedEvent.payload.agentId)
    assert.deepEqual(inheritanceEvent.payload.permissionInheritance, startedEvent.payload.permissionInheritance)
    assert.match(startedEvent.payload.transcriptPath, /^nexus:\/\/sessions\/test-sub-agent-isolated-sub-2\/events$/)
    assert.equal(completedEvent.payload.status, 'completed')
    assert.equal(completedEvent.payload.transcriptPath, startedEvent.payload.transcriptPath)
    assert.equal(completedEvent.payload.resultEventRange.eventCount > 0, true)

    const subSession = getTaskSession('test-sub-agent-isolated-sub-2')
    assert.equal(subSession.parentSessionId, sessionId)
    assert.equal(subSession.assignedAgentId, startedEvent.payload.agentId)
    assert.equal(subSession.currentTaskId, '2')
    assert.equal(subSession.metadata?.agentType, 'subagent')
    assert.equal(subSession.metadata?.status, 'completed')
    assert.equal(subSession.metadata?.transcriptPath, startedEvent.payload.transcriptPath)

    const parentQueueChildTask = listNexusTasks(sessionId).tasks.find(task => task.title === 'Isolated child work')
    assert.equal((parentQueueChildTask?.metadata?.subAgent as any)?.transcriptPath, startedEvent.payload.transcriptPath)
    assert.equal((parentQueueChildTask?.metadata?.subAgent as any)?.status, 'completed')

  } finally {
    if (existsSync(testRepoDir)) {
      rmSync(testRepoDir, { recursive: true, force: true })
    }
  }
})
