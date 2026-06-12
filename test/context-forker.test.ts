import { test } from 'node:test'
import assert from 'node:assert/strict'
import { forkContextForAgent } from '../src/nexus/agents/ContextForker.js'
import { ExploreAgentScheduler } from '../src/nexus/agents/AgentScheduler.js'
import type { AgentJob, ContextForkMode } from '../src/nexus/agents/types.js'
import type { SessionSnapshot } from '../src/shared/session.js'
import { NEXUS_EVENT_SCHEMA_VERSION, type NexusEvent } from '../src/shared/events.js'
import type { NexusRuntime, RuntimeExecuteOptions } from '../src/runtime/Runtime.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'

const timestamp = '2026-06-04T00:00:00.000Z'

const parentSession: SessionSnapshot = {
  sessionId: 'session-parent',
  cwd: '/workspace/project',
  prompt: 'Parent prompt',
  phase: 'executing',
  createdAt: timestamp,
  updatedAt: timestamp,
  allowedPaths: ['/workspace/project'],
  events: [
    {
      type: 'user_message',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId: 'session-parent',
      timestamp: '2026-06-04T00:00:00.000Z',
      text: 'Large parent history should not be inherited.',
    },
    {
      type: 'user_message',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId: 'session-parent',
      timestamp: '2026-06-04T00:00:01.000Z',
      text: 'Focus src/runtime/contextAssembler.ts and src/runtime/contextManager.ts.',
    },
    {
      type: 'tool_started',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId: 'session-parent',
      timestamp: '2026-06-04T00:00:02.000Z',
      toolUseId: 'tool-read-context',
      name: 'Read',
      input: { path: 'src/runtime/contextAssembler.ts' },
    },
    {
      type: 'task_created',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId: 'session-parent',
      timestamp: '2026-06-04T00:00:03.000Z',
      taskId: 'task-1',
      title: 'Implement ContextForker modes',
    },
    {
      type: 'permission_request',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId: 'session-parent',
      timestamp: '2026-06-04T00:00:04.000Z',
      toolUseId: 'tool-bash',
      name: 'Bash',
      input: { command: 'npm test' },
      risk: 'execute',
    },
    {
      type: 'tool_completed',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId: 'session-parent',
      timestamp: '2026-06-04T00:00:05.000Z',
      toolUseId: 'tool-test',
      name: 'Bash',
      success: false,
      output: 'test failure in ContextForker',
    },
    {
      type: 'error',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId: 'session-parent',
      timestamp: '2026-06-04T00:00:06.000Z',
      code: 'TEST_FAILURE',
      message: 'ContextForker regression failed',
    },
    {
      type: 'compact_boundary',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId: 'session-parent',
      timestamp: '2026-06-04T00:00:07.000Z',
      trigger: 'manual',
      summary: 'Compact summary with open ContextForker decisions.',
      beforeEventCount: 20,
      afterEventCount: 6,
      summaryChars: 48,
      snippedToolResults: 1,
    },
    {
      type: 'agent_job_event',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId: 'session-parent',
      timestamp: '2026-06-04T00:00:08.000Z',
      eventId: 'event-agent-completed',
      eventType: 'agent_job_completed',
      jobId: 'agent-job-old',
      childSessionId: 'session-child-old',
      agentType: 'explore',
      contextForkMode: 'minimal',
      status: 'completed',
      result: { summary: 'Explore agent found context files.' },
    },
  ],
}

const job: AgentJob = {
  jobId: 'agent-job-1',
  parentSessionId: 'session-parent',
  childSessionId: 'session-child',
  agentType: 'explore',
  status: 'queued',
  prompt: 'Find src/nexus/agents/AgentScheduler.ts and summarize it.',
  contextForkMode: 'minimal',
  isolation: 'none',
  createdAt: timestamp,
  updatedAt: timestamp,
}

test('minimal context fork keeps explore prompt focused and omits parent history', () => {
  const fork = forkContextForAgent({ parentSession, job })

  assert.equal(fork.mode, 'minimal')
  assert.match(fork.prompt, /read-only Explore Agent/)
  assert.match(fork.prompt, /Use only ListDir, Glob, Grep, and Read/)
  assert.match(fork.prompt, /Find src\/nexus\/agents\/AgentScheduler.ts/)
  assert.doesNotMatch(fork.prompt, /Large parent history/)
  assert.equal(fork.omittedItems, parentSession.events.length)
  assert.ok(fork.allowedPaths?.includes('/workspace/project'))
  assert.ok(fork.allowedPaths?.some(path => path.endsWith('src/nexus/agents/AgentScheduler.ts')))
  assert.deepEqual(fork.diagnostics.omitted, [
    'parent_history',
    'large_tool_results',
    'compact_summary',
    'child_transcripts',
  ])
  assert.deepEqual(fork.diagnostics.workingSetPaths, [
    '/workspace/project/src/runtime/contextAssembler.ts',
    '/workspace/project/src/runtime/contextManager.ts',
  ])
  assert.equal(fork.diagnostics.parentSummary.sessionId, 'session-parent')
  assert.equal(fork.diagnostics.parentSummary.eventCount, parentSession.events.length)
  assert.equal(fork.diagnostics.provenance.forkMode, 'minimal')
  assert.deepEqual(fork.diagnostics.provenance.workingSetPaths, fork.diagnostics.workingSetPaths)
})

test('working-set context fork includes active paths and recent user focus', () => {
  const fork = forkContextForAgent({ parentSession, job: jobWithMode('working-set') })

  assert.equal(fork.mode, 'working-set')
  assert.match(fork.prompt, /focused Working Set Agent/)
  assert.match(fork.prompt, /Working Set:/)
  assert.match(fork.prompt, /src\/runtime\/contextAssembler\.ts/)
  assert.match(fork.prompt, /Recent user focus:/)
  assert.doesNotMatch(fork.prompt, /test failure in ContextForker/)
  assert.ok(fork.allowedPaths?.includes('/workspace/project/src/runtime/contextAssembler.ts'))
  assert.ok(fork.diagnostics.included.includes('working_set'))
  assert.ok(fork.diagnostics.eventReferences.some(reference => reference.reason === 'working set relevance'))
})

test('task-focused context fork includes task, failure, and permission context', () => {
  const fork = forkContextForAgent({ parentSession, job: jobWithMode('task-focused') })

  assert.equal(fork.mode, 'task-focused')
  assert.match(fork.prompt, /task-focused Agent/)
  assert.match(fork.prompt, /Task state:/)
  assert.match(fork.prompt, /Implement ContextForker modes/)
  assert.match(fork.prompt, /Relevant failures:/)
  assert.match(fork.prompt, /TEST_FAILURE/)
  assert.match(fork.prompt, /Permission context:/)
  assert.match(fork.prompt, /Bash permission requested/)
  assert.ok(fork.diagnostics.included.includes('task_state'))
  assert.ok(fork.diagnostics.included.includes('permission_context'))
  assert.ok(fork.diagnostics.childWorkingSet.some(item => item.path.endsWith('src/runtime/contextAssembler.ts')))
  assert.ok(fork.diagnostics.excludedItems.some(item => item.includes('full_parent_history') || item.includes('event:')))
})

test('full-summary context fork includes compact summaries and child agent results', () => {
  const fork = forkContextForAgent({ parentSession, job: jobWithMode('full-summary') })

  assert.equal(fork.mode, 'full-summary')
  assert.match(fork.prompt, /continuation Agent/)
  assert.match(fork.prompt, /Compact summaries:/)
  assert.match(fork.prompt, /open ContextForker decisions/)
  assert.match(fork.prompt, /Child agent results:/)
  assert.match(fork.prompt, /agent_job_completed/)
  assert.ok(fork.diagnostics.included.includes('compact_summary'))
  assert.ok(fork.diagnostics.included.includes('child_agent_results'))
  assert.ok(fork.diagnostics.toolTraceReferences.some(reference => reference.name === 'Bash'))
  assert.ok(fork.diagnostics.provenance.parentSummary?.childAgentResults)
})

test('debug-replay context fork keeps selected failure events under diagnostics', () => {
  const fork = forkContextForAgent({ parentSession, job: jobWithMode('debug-replay') })

  assert.equal(fork.mode, 'debug-replay')
  assert.match(fork.prompt, /debug replay Agent/)
  assert.match(fork.prompt, /Debug replay events:/)
  assert.match(fork.prompt, /tool Bash failed/)
  assert.match(fork.prompt, /error TEST_FAILURE/)
  assert.doesNotMatch(fork.prompt, /Large parent history should not be inherited/)
  assert.ok(fork.diagnostics.included.includes('debug_replay_events'))
  assert.ok(fork.diagnostics.eventReferences.some(reference => reference.reason === 'failed tool output'))
  assert.ok(fork.diagnostics.toolTraceReferences.some(reference => reference.toolUseId === 'tool-test' && reference.success === false))
  assert.ok(fork.diagnostics.provenance.toolTraceReferences?.some(reference => reference.outputPreview?.includes('test failure')))
  assert.ok(fork.omittedItems > 0)
})

test('ExploreAgentScheduler stores selected fork diagnostics on child session metadata', async () => {
  const storage = new MemoryStorage()
  await storage.saveSession(parentSession)
  const scheduler = new ExploreAgentScheduler({
    storage,
    now: () => timestamp,
    runtimeFactory: () => new RecordingRuntime(),
  })

  const spawned = await scheduler.spawnAgent({
    parentSessionId: 'session-parent',
    prompt: 'Find src/runtime/contextAssembler.ts',
    contextForkMode: 'working-set',
  })
  await scheduler.waitForAgent(spawned.jobId)

  const child = await storage.getSession(spawned.childSessionId)
  assert.equal(child?.metadata?.contextForkMode, 'working-set')
  assert.equal((child?.metadata?.contextFork as any)?.inheritedItems > 0, true)
  assert.equal((child?.metadata?.contextFork as any)?.diagnostics?.included.includes('working_set'), true)
  assert.equal((child?.metadata?.contextFork as any)?.diagnostics?.provenance?.forkMode, 'working-set')

  const completed = await scheduler.waitForAgent(spawned.jobId)
  assert.equal(completed.result?.contextProvenance?.forkMode, 'working-set')
  assert.ok(completed.result?.contextProvenance?.workingSetPaths.some(path => path.endsWith('src/runtime/contextAssembler.ts')))
  assert.ok(completed.result?.contextProvenance?.parentSummary?.eventCount)
})

function jobWithMode(mode: ContextForkMode): AgentJob {
  return { ...job, contextForkMode: mode }
}

class RecordingRuntime implements NexusRuntime {
  readonly calls: RuntimeExecuteOptions[] = []

  async *executeStream(options: RuntimeExecuteOptions): AsyncIterable<NexusEvent> {
    this.calls.push(options)
    yield {
      type: 'result',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId: options.sessionId,
      timestamp,
      success: true,
      message: 'done',
    }
  }
}
