import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  classifyAuthority,
  computeGroundingScopeFromEvents,
  deriveGroundingScope,
  type AuthorityRecord,
} from '../src/runtime/compactionAuthority.js'
import { buildPostCompactGroundingEvents } from '../src/runtime/pipeline/context.js'
import type { NexusEvent } from '../src/shared/events.js'

const schemaVersion = '2026-05-21.babel-o.v1' as const

function record(overrides: Partial<AuthorityRecord>): AuthorityRecord {
  return {
    id: 'r1',
    kind: 'fact',
    subject: 'src/a.ts',
    value: 'export const a = 1',
    evidence: { type: 'file', ref: 'src/a.ts', sha256: 'abc' },
    status: 'authoritative',
    turn: 5,
    ...overrides,
  }
}

describe('classifyAuthority', () => {
  test('authoritative only with fresh, matching file provenance', () => {
    const context = { currentTurn: 5, fileHashes: { 'src/a.ts': 'abc' } }
    assert.equal(classifyAuthority(record({}), context), 'authoritative')
    assert.equal(classifyAuthority(record({ evidence: { type: 'file', ref: 'src/a.ts', sha256: 'stale' } }), context), 'provisional')
    assert.equal(classifyAuthority(record({ turn: 4 }), context), 'provisional')
    assert.equal(classifyAuthority(record({ evidence: { type: 'tool', ref: 'read-1' } }), context), 'provisional')
  })

  test('contract and open_task are pinned, never authoritative', () => {
    const context = { currentTurn: 5, fileHashes: { 'src/a.ts': 'abc' } }
    assert.equal(classifyAuthority(record({ kind: 'contract' }), context), 'pinned')
    assert.equal(classifyAuthority(record({ kind: 'open_task' }), context), 'pinned')
  })

  test('test results and superseded records are never authoritative', () => {
    const context = { currentTurn: 5, fileHashes: { 'src/a.ts': 'abc' } }
    assert.equal(classifyAuthority(record({ kind: 'test_result' }), context), 'provisional')
    assert.equal(classifyAuthority(record({ status: 'superseded' }), context), 'superseded')
  })
})

describe('deriveGroundingScope', () => {
  test('zero provisional records produce no grounding requirement', () => {
    const context = { currentTurn: 5, fileHashes: { 'src/a.ts': 'abc' } }
    const scope = deriveGroundingScope([
      record({}),
      record({ id: 'c1', kind: 'contract', subject: 'contract', evidence: { type: 'file', ref: 'contract', sha256: 'x' } }),
      record({ id: 'o1', kind: 'open_task', subject: 'open', evidence: { type: 'file', ref: 'open', sha256: 'y' } }),
    ], context)
    assert.deepEqual(scope.requiredFor, [])
    assert.deepEqual(scope.suggestedActions, [])
    assert.deepEqual(scope.pinnedSubjects, ['contract', 'open'])
  })

  test('maps provisional facts, failures, and git status to targeted grounding', () => {
    const context = { currentTurn: 5, fileHashes: { 'src/a.ts': 'changed' } }
    const scope = deriveGroundingScope([
      record({}),
      record({ id: 'f1', kind: 'failure', subject: 'test:unit', evidence: { type: 'tool', ref: 'bash-1' } }),
      record({ id: 'g1', kind: 'git_status', subject: 'git', evidence: { type: 'git', ref: 'status' } }),
    ], context)
    assert.ok(scope.requiredFor.includes('file_facts'))
    assert.ok(scope.requiredFor.includes('test_results'))
    assert.ok(scope.requiredFor.includes('git_status'))
    assert.ok(scope.provisionalSubjects.includes('src/a.ts'))
  })
})

describe('buildPostCompactGroundingEvents scope', () => {
  test('emits no grounding event for an empty scope', () => {
    const events = buildPostCompactGroundingEvents({
      sessionId: 's1',
      source: 'post_compact',
      scope: { requiredFor: [], suggestedActions: [], provisionalSubjects: [], pinnedSubjects: [] },
    })
    assert.deepEqual(events, [])
  })

  test('narrows requiredFor to the scoped kinds', () => {
    const events = buildPostCompactGroundingEvents({
      sessionId: 's1',
      source: 'post_compact',
      scope: {
        requiredFor: ['file_facts'],
        suggestedActions: ['re_read_referenced_files'],
        provisionalSubjects: ['src/a.ts'],
        pinnedSubjects: [],
      },
    })
    assert.equal(events.length, 1)
    assert.deepEqual((events[0] as any).requiredFor, ['file_facts'])
  })
})

describe('computeGroundingScopeFromEvents', () => {
  test('skips unchanged files, flags changed files and observed tests', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'babelo-authority-'))
    try {
      const content = 'export const a = 1\n'
      await writeFile(join(cwd, 'a.ts'), content, 'utf8')
      const events: NexusEvent[] = [
        {
          type: 'tool_started',
          schemaVersion,
          sessionId: 's1',
          timestamp: '2026-05-23T00:00:00.000Z',
          toolUseId: 'read-1',
          name: 'Read',
          input: { path: 'a.ts' },
        },
        {
          type: 'tool_completed',
          schemaVersion,
          sessionId: 's1',
          timestamp: '2026-05-23T00:00:01.000Z',
          toolUseId: 'read-1',
          name: 'Read',
          success: true,
          output: content,
        },
        {
          type: 'tool_started',
          schemaVersion,
          sessionId: 's1',
          timestamp: '2026-05-23T00:00:02.000Z',
          toolUseId: 'bash-1',
          name: 'Bash',
          input: { command: 'npm test' },
        },
        {
          type: 'tool_completed',
          schemaVersion,
          sessionId: 's1',
          timestamp: '2026-05-23T00:00:03.000Z',
          toolUseId: 'bash-1',
          name: 'Bash',
          success: true,
          output: 'ok',
        },
      ]

      const unchanged = await computeGroundingScopeFromEvents(events, cwd)
      assert.ok(unchanged)
      assert.ok(!unchanged!.requiredFor.includes('file_facts'))
      assert.ok(unchanged!.requiredFor.includes('test_results'))

      await writeFile(join(cwd, 'a.ts'), 'export const a = 2\n', 'utf8')
      const changed = await computeGroundingScopeFromEvents(events, cwd)
      assert.ok(changed)
      assert.ok(changed!.requiredFor.includes('file_facts'))
      assert.ok(changed!.provisionalSubjects.includes('a.ts'))
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
