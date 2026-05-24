import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { runAgentLoop } from '../src/nexus/agentLoop.js'
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
import { createRuntimeAgentStepRunner } from '../src/nexus/runtimeAgentStep.js'
import {
  completeNexusTask,
  createNexusTask,
  listNexusTasks,
  pruneTaskQueues,
  resetTaskQueuesForTest,
  taskQueueStatsForTest,
} from '../src/nexus/taskQueue.js'
import {
  createTaskSession,
  getTaskSession,
  pruneTaskSessions,
  resetTaskSessionsForTest,
  setTaskSessionPhase,
  taskSessionStatsForTest,
} from '../src/nexus/taskSession.js'
import type { NexusTask } from '../src/shared/task.js'
import { ConfigManager } from '../src/shared/config.js'

test('runAgentLoop runs successfully and handles critic approval', async () => {
  resetTaskQueuesForTest()
  resetTaskSessionsForTest()

  const storage = new MemoryStorage()
  setNexusStorage(storage)

  const sessionId = 'test-loop-success'
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

  const finalSession = await runAgentLoop({
    sessionId,
    cwd: process.cwd(),
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
    const stepRunner = createRuntimeAgentStepRunner({
      runtimeFactory: async () => ({
        async *executeStream() {
          throw new Error('runtime should not be called when capability gate fails')
        },
      } as any),
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
  } finally {
    ;(ConfigManager as unknown as { instance?: ConfigManager }).instance = originalInstance
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
    assert.ok(finalSession.events.some(e => e.type === 'task_session_event' && e.eventType === 'sub_agent_session_started'))
    assert.ok(finalSession.events.some(e => e.type === 'task_session_event' && e.eventType === 'sub_agent_session_completed'))

  } finally {
    if (existsSync(testRepoDir)) {
      rmSync(testRepoDir, { recursive: true, force: true })
    }
  }
})

