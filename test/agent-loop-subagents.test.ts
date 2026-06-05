import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPreviousSubAgentsMetadata,
  buildSubAgentLifecycleMetadata,
  buildSubAgentSessionId,
  buildTaskOrchestrationContext,
  getSubAgentStatus,
  getTaskDepth,
  getTaskSessionEventRange,
  normalizeSubTasks,
  summarizeSubAgentSession,
  toParentSubAgentReference,
} from '../src/nexus/agentLoopSubAgents.js'
import type { SessionSnapshot } from '../src/shared/session.js'
import type { NexusTask } from '../src/shared/task.js'

test('agent loop sub-agent helpers build lifecycle and parent references', () => {
  const task = createTask({
    taskId: 'task-1',
    retryCount: 2,
    metadata: { parentTaskId: 'parent-task', depth: 1 },
  })

  assert.equal(buildSubAgentSessionId('session-parent', task), 'session-parent-sub-task-1-retry-2')

  const metadata = buildSubAgentLifecycleMetadata({
    parentSessionId: 'session-parent',
    subSessionId: 'session-child',
    task,
    role: 'executor',
    approvalInheritance: {
      inheritSessionApprovals: true,
      sessionApprovalAllowTools: ['Read', 'Bash', 'NotAllowed'],
    },
  })

  assert.equal(metadata.agentId, 'session-parent:subagent:task-1')
  assert.equal(metadata.parentTaskId, 'parent-task')
  assert.equal(metadata.depth, 1)
  assert.equal(metadata.transcriptPath, 'nexus://sessions/session-child/events')
  assert.equal(metadata.permissionInheritance.requiresApproval, true)
  assert.deepEqual(metadata.permissionInheritance.inheritedSessionApprovalTools, ['Bash', 'Read'])

  const reference = toParentSubAgentReference({
    ...metadata,
    status: 'completed',
    resultEventRange: { eventCount: 2 },
    summary: 'Completed.',
  }, 'session-child')

  assert.deepEqual(reference, {
    agentId: 'session-parent:subagent:task-1',
    subSessionId: 'session-child',
    parentTaskId: 'parent-task',
    depth: 1,
    status: 'completed',
    transcriptPath: 'nexus://sessions/session-child/events',
    resultEventRange: { eventCount: 2 },
    summary: 'Completed.',
  })
})

test('agent loop sub-agent helpers normalize orchestration context and subtasks', () => {
  const task = createTask({
    metadata: {
      depth: 2,
      delegatedSubTaskIds: ['child-1', 42, 'child-2'],
    },
  })

  assert.equal(getTaskDepth(task), 2)
  assert.deepEqual(buildTaskOrchestrationContext(task, true, 4), {
    enableSubAgents: true,
    currentDepth: 2,
    maxDepth: 4,
    remainingDepth: 2,
    delegatedSubTaskIds: ['child-1', 'child-2'],
  })

  assert.deepEqual(normalizeSubTasks([
    { title: ' First ', description: ' Do first ' },
    { title: '' },
    { title: 'First', description: 'duplicate' },
    { title: 'Second', description: '   ' },
  ], 2), [
    { title: 'First', description: 'Do first' },
    { title: 'Second', description: undefined },
  ])
})

test('agent loop sub-agent helpers summarize sessions and previous failures', () => {
  const task = createTask({
    metadata: {
      previousSubAgents: [{ status: 'failed', subSessionId: 'old-child' }],
    },
  })
  const failedSubAgent = { status: 'cancelled', subSessionId: 'child' }

  assert.equal(getSubAgentStatus({ subAgent: failedSubAgent }), 'cancelled')
  assert.deepEqual(buildPreviousSubAgentsMetadata(task, {
    metadata: { subAgent: failedSubAgent },
  }), {
    previousSubAgents: [
      { status: 'failed', subSessionId: 'old-child' },
      failedSubAgent,
    ],
  })
  assert.deepEqual(buildPreviousSubAgentsMetadata(task, {
    metadata: { subAgent: { status: 'completed' } },
  }), {})

  const session = createSession({
    events: [
      { type: 'task_session_event', eventId: 'event-1' } as any,
      { type: 'task_session_event', eventId: 'event-2' } as any,
    ],
    terminalReason: { category: 'cancelled', code: 'STOPPED', message: 'Stopped by user.' },
  })

  assert.deepEqual(getTaskSessionEventRange(session), {
    firstEventId: 'event-1',
    lastEventId: 'event-2',
    eventCount: 2,
  })
  assert.equal(summarizeSubAgentSession(session), 'Stopped by user.')
  assert.equal(summarizeSubAgentSession(createSession({ phase: 'completed' })), 'Completed successfully via sub-agent session')
})

function createTask(overrides: Partial<NexusTask> = {}): NexusTask {
  return {
    taskId: 'task-1',
    sessionId: 'session-parent',
    title: 'Task',
    status: 'pending',
    dependsOn: [],
    blocks: [],
    retryCount: 0,
    createdAt: '2026-06-04T00:00:00.000Z',
    updatedAt: '2026-06-04T00:00:00.000Z',
    ...overrides,
  }
}

function createSession(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: 'session-child',
    cwd: '/workspace/project',
    prompt: 'Prompt',
    phase: 'failed',
    createdAt: '2026-06-04T00:00:00.000Z',
    updatedAt: '2026-06-04T00:00:00.000Z',
    events: [],
    ...overrides,
  }
}
