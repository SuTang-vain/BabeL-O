import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runAgentLoop } from '../src/nexus/agentLoop.js'
import {
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
