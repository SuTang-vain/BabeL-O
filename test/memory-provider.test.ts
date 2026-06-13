import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EverCoreMemoryProvider,
  shouldAutoSearchMemory,
} from '../src/runtime/memoryProvider.js'
import type { EverCoreClient, EverCoreSearchInput } from '../src/runtime/everCoreClient.js'

test('shouldAutoSearchMemory triggers only for historical memory cues', () => {
  assert.deepEqual(shouldAutoSearchMemory({ prompt: '你还记得我之前偏好的 provider 吗？' }), {
    shouldSearch: true,
    reason: 'explicit_memory_cue',
    cue: '记得',
  })
  assert.deepEqual(shouldAutoSearchMemory({ prompt: 'What did we decide last time?' }), {
    shouldSearch: true,
    reason: 'explicit_memory_cue',
    cue: 'last time',
  })
  assert.equal(shouldAutoSearchMemory({ prompt: 'run tests and report status' }).reason, 'execution_status_only')
  assert.equal(shouldAutoSearchMemory({ prompt: '读取 src/runtime/memoryProvider.ts' }).reason, 'current_workspace_only')
  assert.equal(shouldAutoSearchMemory({ prompt: '继续实现当前任务' }).reason, 'no_memory_cue')
})

test('EverCoreMemoryProvider skips automatic retrieval when no memory cue is present', async () => {
  const searchInputs: EverCoreSearchInput[] = []
  const provider = new EverCoreMemoryProvider(createMockEverCoreClient({ searchInputs }), {
    appId: 'babel-o',
    projectId: 'project-1',
    projectIdSource: 'workspace',
    agentId: 'agent-1',
    retrieveMethod: 'hybrid',
    topK: 5,
    maxContentChars: 128,
  })

  const result = await provider.retrieve({
    sessionId: 'session-memory-skip',
    prompt: 'run tests and report status',
    cwd: '/workspace/project',
  })

  assert.equal(searchInputs.length, 0)
  assert.equal(result.content, '')
  assert.equal(result.diagnostics.enabled, true)
  assert.equal(result.diagnostics.autoSearch?.triggered, false)
  assert.equal(result.diagnostics.autoSearch?.reason, 'execution_status_only')
  assert.equal(result.diagnostics.scope, 'project')
  assert.equal(result.diagnostics.namespaceId, 'project-1')
  assert.equal(result.diagnostics.namespaceSource, 'workspace')
  assert.equal(result.diagnostics.isolationKey, 'projectId')
})

test('EverCoreMemoryProvider automatically retrieves bounded hits for memory cues', async () => {
  const searchInputs: EverCoreSearchInput[] = []
  const provider = new EverCoreMemoryProvider(createMockEverCoreClient({ searchInputs }), {
    appId: 'babel-o',
    projectId: 'project-1',
    agentId: 'agent-1',
    retrieveMethod: 'hybrid',
    topK: 1,
    maxContentChars: 80,
    maxHitChars: 48,
  })

  const result = await provider.retrieve({
    sessionId: 'session-memory-trigger',
    prompt: '你还记得我之前偏好的 provider 吗？',
    cwd: '/workspace/project',
  })

  assert.equal(searchInputs.length, 1)
  assert.equal(searchInputs[0]?.query, '你还记得我之前偏好的 provider 吗？')
  assert.equal(searchInputs[0]?.projectId, 'project-1')
  assert.equal(searchInputs[0]?.agentId, 'agent-1')
  assert.equal(searchInputs[0]?.method, 'hybrid')
  assert.match(result.content, /Remembered regression-first provider preferen/)
  assert.equal(result.diagnostics.hitCount, 1)
  assert.equal(result.diagnostics.budgetChars, 80)
  assert.equal(result.diagnostics.maxHitChars, 48)
  assert.equal(result.diagnostics.autoSearch?.triggered, true)
  assert.equal(result.diagnostics.autoSearch?.reason, 'explicit_memory_cue')
  assert.equal(result.diagnostics.autoSearch?.cue, '记得')
})

function createMockEverCoreClient(options: {
  searchInputs: EverCoreSearchInput[]
}): EverCoreClient {
  return {
    async search(input) {
      options.searchInputs.push(input)
      return {
        data: {
          episodes: [
            {
              id: 'episode-1',
              content: 'Remembered regression-first provider preference from an earlier session.',
              score: 0.9,
            },
          ],
        },
      }
    },
    async addAgentMessages() {
      return { data: {} }
    },
    async flushAgentSession() {
      return { data: {} }
    },
  }
}
