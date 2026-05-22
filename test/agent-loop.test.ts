import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runAgentLoop } from '../src/nexus/agentLoop.js'
import { setNexusStorage } from '../src/nexus/storageBridge.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'
import { PLANNER_ROLE, EXECUTOR_ROLE, CRITIC_ROLE, OPTIMIZER_ROLE } from '../src/nexus/agentRoles.js'
import { resetTaskQueuesForTest, listNexusTasks } from '../src/nexus/taskQueue.js'
import { resetTaskSessionsForTest, getTaskSession } from '../src/nexus/taskSession.js'

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
