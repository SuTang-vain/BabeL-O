import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EXPLORE_AGENT_PROFILE,
  REVIEW_AGENT_PROFILE,
  TEST_AGENT_PROFILE,
  agentProfiles,
  assertAgentProfile,
  getAgentProfile,
} from '../src/nexus/agents/AgentProfiles.js'
import type { AgentJob, AgentResult } from '../src/nexus/agents/types.js'

test('explore agent profile is read-only and minimal by default', () => {
  assert.equal(EXPLORE_AGENT_PROFILE.id, 'explore')
  assert.equal(EXPLORE_AGENT_PROFILE.displayName, 'Explore Agent')
  assert.deepEqual(EXPLORE_AGENT_PROFILE.defaultTools, ['Read', 'Grep', 'Glob'])
  assert.equal(EXPLORE_AGENT_PROFILE.defaultContextForkMode, 'minimal')
  assert.equal(EXPLORE_AGENT_PROFILE.defaultIsolation, 'none')
  assert.equal(EXPLORE_AGENT_PROFILE.canEdit, false)
  assert.equal(EXPLORE_AGENT_PROFILE.canRunBash, false)
  assert.equal(EXPLORE_AGENT_PROFILE.requiresApproval, false)
  assert.equal(EXPLORE_AGENT_PROFILE.maxRuntimeMs, 120_000)
  assert.equal(EXPLORE_AGENT_PROFILE.maxOutputTokens, 2_048)
})

test('review and test profiles are enabled as read-only validation agents', () => {
  assert.deepEqual(Object.keys(agentProfiles), ['explore', 'review', 'test'])
  assert.equal(getAgentProfile('explore'), EXPLORE_AGENT_PROFILE)
  assert.equal(getAgentProfile('review'), REVIEW_AGENT_PROFILE)
  assert.equal(getAgentProfile('test'), TEST_AGENT_PROFILE)
  assert.throws(() => assertAgentProfile('implement'), /not enabled/)

  assert.deepEqual(REVIEW_AGENT_PROFILE.defaultTools, ['Read', 'Grep', 'Glob', 'Bash'])
  assert.equal(REVIEW_AGENT_PROFILE.defaultContextForkMode, 'task-focused')
  assert.equal(REVIEW_AGENT_PROFILE.canEdit, false)
  assert.equal(REVIEW_AGENT_PROFILE.canRunBash, true)
  assert.equal(REVIEW_AGENT_PROFILE.requiresApproval, false)
  assert.equal(REVIEW_AGENT_PROFILE.maxRuntimeMs, 180_000)
  assert.equal(REVIEW_AGENT_PROFILE.maxOutputTokens, 3_000)

  assert.deepEqual(TEST_AGENT_PROFILE.defaultTools, ['Read', 'Grep', 'Glob', 'Bash'])
  assert.equal(TEST_AGENT_PROFILE.defaultContextForkMode, 'task-focused')
  assert.equal(TEST_AGENT_PROFILE.canEdit, false)
  assert.equal(TEST_AGENT_PROFILE.canRunBash, true)
  assert.equal(TEST_AGENT_PROFILE.requiresApproval, false)
  assert.equal(TEST_AGENT_PROFILE.maxRuntimeMs, 300_000)
  assert.equal(TEST_AGENT_PROFILE.maxOutputTokens, 3_000)
})

test('agent core types support job and structured result contracts', () => {
  const result: AgentResult = {
    summary: 'Found prefix cache diagnostics files.',
    findings: [
      {
        severity: 'info',
        message: 'Prefix cache diagnostics are implemented in runtime helpers.',
        file: 'src/runtime/prefixCache.ts',
        line: 1,
      },
    ],
    changedFiles: [],
    testsRun: [],
    commandsRun: [],
    nextSteps: ['Inspect runtime status aggregation.'],
    confidence: 'high',
  }

  const job: AgentJob = {
    jobId: 'agent-job-1',
    parentSessionId: 'session-parent',
    childSessionId: 'session-child',
    agentType: 'explore',
    status: 'completed',
    prompt: 'Find prefix cache diagnostics files.',
    contextForkMode: 'minimal',
    isolation: 'none',
    createdAt: '2026-06-04T00:00:00.000Z',
    updatedAt: '2026-06-04T00:00:01.000Z',
    startedAt: '2026-06-04T00:00:00.100Z',
    completedAt: '2026-06-04T00:00:01.000Z',
    result,
  }

  assert.equal(job.result?.summary, 'Found prefix cache diagnostics files.')
  assert.equal(job.result?.findings?.[0]?.severity, 'info')
  assert.equal(job.contextForkMode, 'minimal')
  assert.equal(job.isolation, 'none')
})
