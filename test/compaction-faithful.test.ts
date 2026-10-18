import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'
import { compactSession } from '../src/runtime/compact.js'
import {
  buildFaithfulDigest,
  carryFaithfulDigest,
  extractConstraintSentences,
  isFaithfulDigestEnabled,
  normalizeFaithfulDigest,
  renderFaithfulDigest,
} from '../src/runtime/compactionFaithfulDigest.js'
import { mapEventsToMessages } from '../src/runtime/LLMCodingRuntime.js'
import type { NexusEvent } from '../src/shared/events.js'

const schemaVersion = '2026-05-21.babel-o.v1' as const

function ev(partial: Partial<NexusEvent> & { type: NexusEvent['type'] }, sessionId: string, seq: number): NexusEvent {
  return {
    schemaVersion,
    sessionId,
    timestamp: `2026-05-23T00:00:${String(seq).padStart(2, '0')}.000Z`,
    ...partial,
  } as NexusEvent
}

function fixture(sessionId: string): NexusEvent[] {
  return [
    ev({ type: 'session_started', cwd: '/tmp' } as any, sessionId, 0),
    ev({
      type: 'user_message',
      text: 'Build the export tool in src/export.mjs. You must keep the CSV header exactly `id,amountCents`. Never rename exported functions. Pin commit 0123456789abcdef0123456789abcdef01234567 as the base.',
    }, sessionId, 1),
    ev({ type: 'tool_started', toolUseId: 'w1', name: 'Write', input: { path: 'src/export.mjs' } } as any, sessionId, 2),
    ev({ type: 'tool_completed', toolUseId: 'w1', name: 'Write', success: true, output: 'written' } as any, sessionId, 3),
    ev({ type: 'tool_started', toolUseId: 'b1', name: 'Bash', input: { command: 'npm test' } } as any, sessionId, 4),
    ev({ type: 'tool_completed', toolUseId: 'b1', name: 'Bash', success: false, output: 'FAIL ledger.test.mjs: expected 350 got 300' } as any, sessionId, 5),
    ev({ type: 'tool_started', toolUseId: 'b2', name: 'Bash', input: { command: 'node test.mjs' } } as any, sessionId, 6),
    ev({ type: 'tool_completed', toolUseId: 'b2', name: 'Bash', success: true, output: 'ok\ncommit deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' } as any, sessionId, 7),
    ev({ type: 'permission_request', toolUseId: 'p1', name: 'Read', input: { path: '../other-repo/x' }, risk: 'read', scopeRisk: 'sibling_repo', targetRoot: '/home/u/other-repo' } as any, sessionId, 8),
    ev({ type: 'permission_response', toolUseId: 'p1', approved: false, scope: 'once' } as any, sessionId, 9),
    ev({ type: 'scope_boundary_confirmed', targetRoot: '/home/u/shared', confirmationScope: 'session', confirmedBy: 'user', message: 'ok' } as any, sessionId, 10),
    ev({ type: 'user_message', text: 'Now add the CSV round-trip check and run the tests again.' }, sessionId, 11),
  ]
}

describe('isFaithfulDigestEnabled', () => {
  test('defaults to off; opt-in via env', () => {
    assert.equal(isFaithfulDigestEnabled({}), false)
    assert.equal(isFaithfulDigestEnabled({ BABEL_O_COMPACT_FAITHFUL_DIGEST: '0' }), false)
    assert.equal(isFaithfulDigestEnabled({ BABEL_O_COMPACT_FAITHFUL_DIGEST: '1' }), true)
    assert.equal(isFaithfulDigestEnabled({ BABEL_O_COMPACT_FAITHFUL_DIGEST: 'yes' }), true)
  })
})

describe('buildFaithfulDigest (extractive anchors)', () => {
  const events = fixture('s-faithful')
  const digest = buildFaithfulDigest(events)

  test('keeps the most recent user instruction verbatim and untruncated', () => {
    assert.equal(digest.instruction, 'Now add the CSV round-trip check and run the tests again.')
  })

  test('constraint sentences are verbatim slices of the source user text', () => {
    const source = (events[1] as any).text as string
    assert.ok(digest.constraints.length >= 2)
    for (const c of digest.constraints) {
      assert.ok(source.includes(c), `constraint not verbatim: ${c}`)
    }
    assert.ok(digest.constraints.some(c => c.includes('must keep the CSV header exactly')))
    assert.ok(digest.constraints.some(c => /[Nn]ever rename/.test(c)))
  })

  test('paths, SHAs, test commands and outcomes are verbatim anchors', () => {
    assert.ok(digest.paths.includes('src/export.mjs'))
    assert.ok(digest.shas.includes('0123456789abcdef0123456789abcdef01234567'))
    assert.ok(digest.shas.includes('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'))
    const npmTest = digest.testCommands.find(c => c.command === 'npm test')
    const nodeTest = digest.testCommands.find(c => c.command === 'node test.mjs')
    assert.equal(npmTest?.outcome, 'fail')
    assert.equal(nodeTest?.outcome, 'pass')
  })

  test('scope/permission constraints are captured from structured fields', () => {
    assert.ok(digest.scopeConstraints.some(s => s.includes('sibling_repo') && s.includes('/home/u/other-repo')))
    assert.ok(digest.scopeConstraints.some(s => s.includes('DENIED') && s.includes('p1') === false))
    assert.ok(digest.scopeConstraints.some(s => s.includes('scope confirmed: /home/u/shared scope=session')))
  })

  test('failure excerpts are verbatim (modulo whitespace normalization)', () => {
    const failure = digest.failures.find(f => f.tool === 'Bash')
    assert.ok(failure)
    assert.ok('FAIL ledger.test.mjs: expected 350 got 300'.includes(failure!.excerpt))
  })

  test('earlier user messages are carried as verbatim quotes', () => {
    assert.equal(digest.userQuotes.length, 1)
    assert.ok((events[1] as any).text.startsWith(digest.userQuotes[0]!.slice(0, 40)))
  })
})

describe('carryFaithfulDigest (no recursive compaction)', () => {
  test('previous digest is carried verbatim and never merged/re-built', () => {
    const first = buildFaithfulDigest(fixture('s-carry-1'))
    const secondEvents: NexusEvent[] = [
      ev({ type: 'user_message', text: 'Second phase: keep everything working.' }, 's-carry-2', 1),
      ev({ type: 'tool_started', toolUseId: 'w9', name: 'Write', input: { path: 'src/phase2.mjs' } } as any, 's-carry-2', 2),
    ]
    const delta = buildFaithfulDigest(secondEvents)
    const combined = carryFaithfulDigest(first, delta)
    // carried subtree is deep-equal to the original previous digest
    assert.deepEqual(combined.carried, first)
    // delta records come only from the raw second-phase events
    assert.equal(combined.instruction, 'Second phase: keep everything working.')
    assert.deepEqual(combined.paths, ['src/phase2.mjs'])
    // no merge: delta does NOT contain first-phase anchors at top level
    assert.ok(!combined.shas.includes('0123456789abcdef0123456789abcdef01234567'))
    // but the render surfaces the carried first-phase anchors verbatim
    const rendered = renderFaithfulDigest(combined, 20_000)
    assert.ok(rendered.includes('0123456789abcdef0123456789abcdef01234567'))
    assert.ok(rendered.includes('Carried previous digest (verbatim, not re-summarized)'))
  })

  test('normalizeFaithfulDigest round-trips and rejects T2 v1 digests', () => {
    const first = buildFaithfulDigest(fixture('s-norm'))
    const restored = normalizeFaithfulDigest(JSON.parse(JSON.stringify(carryFaithfulDigest(first, first))))
    assert.ok(restored)
    assert.deepEqual(restored.carried, first)
    assert.equal(normalizeFaithfulDigest({ version: 1, records: [] }), undefined)
    assert.equal(normalizeFaithfulDigest('nope'), undefined)
  })
})

describe('renderFaithfulDigest', () => {
  test('instruction survives even a tiny budget', () => {
    const digest = buildFaithfulDigest(fixture('s-render'))
    const rendered = renderFaithfulDigest(digest, 400)
    assert.ok(rendered.includes('Now add the CSV round-trip check and run the tests again.'))
    assert.ok(rendered.includes('truncated'))
  })

  test('extractConstraintSentences finds nothing in neutral text', () => {
    assert.deepEqual(extractConstraintSentences('Add a function and run it.'), [])
  })

  test('overflow counter reports evicted anchors', () => {
    const many: NexusEvent[] = Array.from({ length: 30 }, (_, i) => ev({
      type: 'tool_started', toolUseId: `w${i}`, name: 'Write', input: { path: `src/file-${i}.mjs` },
    } as any, 's-overflow', i + 1))
    const digest = buildFaithfulDigest(many, { maxPaths: 5 })
    assert.equal(digest.paths.length, 5)
    assert.equal(digest.overflow?.paths, 25)
    const rendered = renderFaithfulDigest(digest, 20_000)
    assert.ok(rendered.includes('Anchor overflow') && rendered.includes('paths -25'))
  })
})

describe('byte-verbatim extraction', () => {
  test('multi-line instruction is preserved byte-exactly (no whitespace folding)', () => {
    const text = 'Line one.\n  indented line two\n\nLine four after blank.'
    const digest = buildFaithfulDigest([
      ev({ type: 'user_message', text: 'earlier' }, 's-ml', 1),
      ev({ type: 'user_message', text }, 's-ml', 2),
    ])
    assert.equal(digest.instruction, text)
  })

  test('instruction beyond maxInstructionChars is truncated with an explicit marker', () => {
    const text = `prefix ${'y'.repeat(9000)}`
    const digest = buildFaithfulDigest([ev({ type: 'user_message', text }, 's-long', 1)])
    assert.ok(digest.instruction!.startsWith('prefix'))
    assert.ok(digest.instruction!.includes('[truncated'))
    assert.ok(digest.instruction!.length < text.length + 60)
  })

  test('short SHAs are extracted from git bash output only', () => {
    const events: NexusEvent[] = [
      ev({ type: 'tool_started', toolUseId: 'g1', name: 'Bash', input: { command: 'git log --oneline -3' } } as any, 's-sha', 1),
      ev({ type: 'tool_completed', toolUseId: 'g1', name: 'Bash', success: true, output: 'a430b00 feat: metrics\nfb41308 fix: ratio' } as any, 's-sha', 2),
      ev({ type: 'tool_started', toolUseId: 'n1', name: 'Bash', input: { command: 'npm test' } } as any, 's-sha', 3),
      ev({ type: 'tool_completed', toolUseId: 'n1', name: 'Bash', success: true, output: 'suite deadbeef passed' } as any, 's-sha', 4),
    ]
    const digest = buildFaithfulDigest(events)
    assert.ok(digest.shas.includes('a430b00'))
    assert.ok(digest.shas.includes('fb41308'))
    // 'deadbeef' appears in non-git output and must not be captured
    assert.ok(!digest.shas.includes('deadbeef'))
  })
})

describe('stock mode is untouched by the faithful flag', () => {
  test('mode=stock + flag=1 still uses the deterministic stock fallback, no v2 digest', async () => {
    const prev = {
      mode: process.env.BABEL_O_COMPACT_MODE,
      max: process.env.BABEL_O_MAX_CONTEXT_TOKENS,
      flag: process.env.BABEL_O_COMPACT_FAITHFUL_DIGEST,
    }
    process.env.BABEL_O_COMPACT_MODE = 'stock'
    process.env.BABEL_O_MAX_CONTEXT_TOKENS = '90000'
    process.env.BABEL_O_COMPACT_FAITHFUL_DIGEST = '1'
    try {
      const sessionId = 's-stock-inert'
      const storage = new MemoryStorage()
      const huge: NexusEvent = {
        type: 'assistant_delta', schemaVersion, sessionId,
        timestamp: '2026-05-23T00:00:01.500Z', text: 'x'.repeat(80_000),
      } as NexusEvent
      await storage.saveSession({
        sessionId, cwd: '/tmp', prompt: 'stock', phase: 'executing',
        createdAt: '2026-05-23T00:00:00.000Z', updatedAt: '2026-05-23T00:00:00.000Z',
        events: [fixture(sessionId)[0]!, fixture(sessionId)[1]!, huge, ...fixture(sessionId).slice(2)],
      })
      const result = await compactSession({
        storage, sessionId, modelId: 'local/coding-runtime', trigger: 'auto', mapEventsToMessages,
      })
      assert.ok(!result.event.summary.startsWith('## Faithful Compaction Digest'), 'faithful digest must not activate in stock mode')
      assert.equal(normalizeFaithfulDigest((result.event as any).digest), undefined)
    } finally {
      if (prev.mode === undefined) delete process.env.BABEL_O_COMPACT_MODE
      else process.env.BABEL_O_COMPACT_MODE = prev.mode
      if (prev.max === undefined) delete process.env.BABEL_O_MAX_CONTEXT_TOKENS
      else process.env.BABEL_O_MAX_CONTEXT_TOKENS = prev.max
      if (prev.flag === undefined) delete process.env.BABEL_O_COMPACT_FAITHFUL_DIGEST
      else process.env.BABEL_O_COMPACT_FAITHFUL_DIGEST = prev.flag
    }
  })
})

describe('mixed prose -> faithful -> faithful history', () => {
  test('prose-era summary survives as carriedProse across later faithful boundaries', async () => {
    const sessionId = 's-mixed-chain'
    const prev = {
      mode: process.env.BABEL_O_COMPACT_MODE,
      max: process.env.BABEL_O_MAX_CONTEXT_TOKENS,
      flag: process.env.BABEL_O_COMPACT_FAITHFUL_DIGEST,
    }
    try {
      // Boundary 1: stock-era PROSE/deterministic boundary (flag off, stock mode).
      process.env.BABEL_O_COMPACT_MODE = 'stock'
      process.env.BABEL_O_MAX_CONTEXT_TOKENS = '90000'
      delete process.env.BABEL_O_COMPACT_FAITHFUL_DIGEST
      const storage = new MemoryStorage()
      const huge = (t: string): NexusEvent => ({
        type: 'assistant_delta', schemaVersion, sessionId, timestamp: t, text: 'x'.repeat(80_000),
      } as NexusEvent)
      const base = fixture(sessionId)
      await storage.saveSession({
        sessionId, cwd: '/tmp', prompt: 'mixed', phase: 'executing',
        createdAt: '2026-05-23T00:00:00.000Z', updatedAt: '2026-05-23T00:00:00.000Z',
        events: [base[0]!, base[1]!, huge('2026-05-23T00:00:01.500Z'), ...base.slice(2)],
      })
      const first = await compactSession({
        storage, sessionId, modelId: 'local/coding-runtime', trigger: 'auto', mapEventsToMessages,
      })
      assert.ok(!first.event.summary.startsWith('## Faithful Compaction Digest'))
      const proseSummary = first.event.summary

      // Boundary 2: switch on adaptive + faithful. Prose summary must enter
      // the digest as carriedProse (verbatim), not be chained as text.
      process.env.BABEL_O_COMPACT_MODE = 'adaptive'
      process.env.BABEL_O_COMPACT_FAITHFUL_DIGEST = '1'
      const events2 = [
        ...[base[0]!, base[1]!, huge('2026-05-23T00:00:01.500Z'), ...base.slice(2)],
        first.event as NexusEvent,
        huge('2026-05-23T00:01:00.000Z'),
        ev({ type: 'user_message', text: 'mixed phase two' }, sessionId, 70),
      ]
      await storage.saveSession({
        sessionId, cwd: '/tmp', prompt: 'mixed', phase: 'executing',
        createdAt: '2026-05-23T00:00:00.000Z', updatedAt: '2026-05-23T00:01:00.000Z', events: events2,
      })
      const second = await compactSession({
        storage, sessionId, modelId: 'local/coding-runtime', trigger: 'auto', mapEventsToMessages,
      })
      const digest2 = normalizeFaithfulDigest((second.event as any).digest)
      assert.ok(digest2)
      // compact.ts chains priorSummary.trim(); carriedProse must equal exactly that
      assert.equal(digest2!.carriedProse, proseSummary.trim(), 'prose summary must be carried verbatim into digest2')
      assert.ok(!second.event.summary.startsWith(proseSummary.slice(0, 40)), 'prose must not be text-chained on top')

      // Boundary 3: faithful again. The prose-era content must STILL be visible.
      const events3 = [
        ...events2,
        second.event as NexusEvent,
        huge('2026-05-23T00:02:00.000Z'),
        ev({ type: 'user_message', text: 'mixed phase three' }, sessionId, 80),
      ]
      await storage.saveSession({
        sessionId, cwd: '/tmp', prompt: 'mixed', phase: 'executing',
        createdAt: '2026-05-23T00:00:00.000Z', updatedAt: '2026-05-23T00:02:00.000Z', events: events3,
      })
      const third = await compactSession({
        storage, sessionId, modelId: 'local/coding-runtime', trigger: 'auto', mapEventsToMessages,
      })
      const digest3 = normalizeFaithfulDigest((third.event as any).digest)
      assert.ok(digest3?.carried, 'digest3 must carry digest2')
      assert.deepEqual(digest3!.carried, digest2)
      assert.ok(third.event.summary.includes(proseSummary.trim().slice(0, 60)), 'prose-era history lost at boundary 3 (P1 regression)')
    } finally {
      if (prev.mode === undefined) delete process.env.BABEL_O_COMPACT_MODE
      else process.env.BABEL_O_COMPACT_MODE = prev.mode
      if (prev.max === undefined) delete process.env.BABEL_O_MAX_CONTEXT_TOKENS
      else process.env.BABEL_O_MAX_CONTEXT_TOKENS = prev.max
      if (prev.flag === undefined) delete process.env.BABEL_O_COMPACT_FAITHFUL_DIGEST
      else process.env.BABEL_O_COMPACT_FAITHFUL_DIGEST = prev.flag
    }
  })
})

describe('adaptive + faithful flag integration (compactSession)', () => {
  async function runCompact(sessionId: string, events: NexusEvent[], faithful: boolean) {
    const prev = {
      mode: process.env.BABEL_O_COMPACT_MODE,
      max: process.env.BABEL_O_MAX_CONTEXT_TOKENS,
      flag: process.env.BABEL_O_COMPACT_FAITHFUL_DIGEST,
    }
    process.env.BABEL_O_COMPACT_MODE = 'adaptive'
    process.env.BABEL_O_MAX_CONTEXT_TOKENS = '90000'
    if (faithful) process.env.BABEL_O_COMPACT_FAITHFUL_DIGEST = '1'
    else delete process.env.BABEL_O_COMPACT_FAITHFUL_DIGEST
    try {
      const storage = new MemoryStorage()
      await storage.saveSession({
        sessionId,
        cwd: '/tmp',
        prompt: 'faithful',
        phase: 'executing',
        createdAt: '2026-05-23T00:00:00.000Z',
        updatedAt: '2026-05-23T00:00:00.000Z',
        events,
      })
      return await compactSession({
        storage,
        sessionId,
        modelId: 'deepseek/deepseek-v4-flash',
        trigger: 'auto',
        mapEventsToMessages,
      })
    } finally {
      if (prev.mode === undefined) delete process.env.BABEL_O_COMPACT_MODE
      else process.env.BABEL_O_COMPACT_MODE = prev.mode
      if (prev.max === undefined) delete process.env.BABEL_O_MAX_CONTEXT_TOKENS
      else process.env.BABEL_O_MAX_CONTEXT_TOKENS = prev.max
      if (prev.flag === undefined) delete process.env.BABEL_O_COMPACT_FAITHFUL_DIGEST
      else process.env.BABEL_O_COMPACT_FAITHFUL_DIGEST = prev.flag
    }
  }

  function bigSession(sessionId: string): NexusEvent[] {
    const base = fixture(sessionId)
    const huge: NexusEvent = {
      type: 'assistant_delta',
      schemaVersion,
      sessionId,
      timestamp: '2026-05-23T00:00:01.500Z',
      text: 'x'.repeat(80_000),
    } as NexusEvent
    const tail: NexusEvent[] = Array.from({ length: 3 }, (_, i) => ev(
      { type: 'user_message', text: `follow-up ${i}` }, sessionId, 20 + i,
    ))
    return [base[0]!, base[1]!, huge, ...base.slice(2), ...tail]
  }

  test('faithful ON: boundary digest is v2 and instruction is verbatim; OFF: T2 v1 digest', async () => {
    const on = await runCompact('s-faith-on', bigSession('s-faith-on'), true)
    assert.ok(on.event.summary.startsWith('## Faithful Compaction Digest'))
    assert.ok(on.event.summary.includes('must keep the CSV header exactly'))
    const digest = normalizeFaithfulDigest((on.event as any).digest)
    assert.ok(digest, 'boundary digest should be a faithful v2 digest')
    assert.equal(digest!.builtFromEvents > 0, true)

    const off = await runCompact('s-faith-off', bigSession('s-faith-off'), false)
    assert.ok(off.event.summary.startsWith('## Compaction Digest (deterministic)'))
    assert.equal(normalizeFaithfulDigest((off.event as any).digest), undefined)
  })

  test('second faithful compaction carries the first digest verbatim (no recursion)', async () => {
    const sessionId = 's-faith-chain'
    const prev = {
      mode: process.env.BABEL_O_COMPACT_MODE,
      max: process.env.BABEL_O_MAX_CONTEXT_TOKENS,
      flag: process.env.BABEL_O_COMPACT_FAITHFUL_DIGEST,
    }
    process.env.BABEL_O_COMPACT_MODE = 'adaptive'
    process.env.BABEL_O_MAX_CONTEXT_TOKENS = '90000'
    process.env.BABEL_O_COMPACT_FAITHFUL_DIGEST = '1'
    try {
      const storage = new MemoryStorage()
      await storage.saveSession({
        sessionId,
        cwd: '/tmp',
        prompt: 'chain',
        phase: 'executing',
        createdAt: '2026-05-23T00:00:00.000Z',
        updatedAt: '2026-05-23T00:00:00.000Z',
        events: bigSession(sessionId),
      })
      const first = await compactSession({
        storage, sessionId, modelId: 'deepseek/deepseek-v4-flash', trigger: 'auto', mapEventsToMessages,
      })
      const firstDigest = normalizeFaithfulDigest((first.event as any).digest)
      assert.ok(firstDigest)

      // Second compaction: the previous boundary + more raw events.
      const more: NexusEvent[] = [
        first.event as NexusEvent,
        {
          type: 'assistant_delta', schemaVersion, sessionId,
          timestamp: '2026-05-23T00:01:00.000Z', text: 'y'.repeat(80_000),
        } as NexusEvent,
        ev({ type: 'user_message', text: 'phase three: verify everything still passes.' }, sessionId, 61),
      ]
      await storage.saveSession({
        sessionId,
        cwd: '/tmp',
        prompt: 'chain',
        phase: 'executing',
        createdAt: '2026-05-23T00:00:00.000Z',
        updatedAt: '2026-05-23T00:01:00.000Z',
        events: [...bigSession(sessionId), ...more],
      })
      const second = await compactSession({
        storage, sessionId, modelId: 'deepseek/deepseek-v4-flash', trigger: 'auto', mapEventsToMessages,
      })
      const secondDigest = normalizeFaithfulDigest((second.event as any).digest)
      assert.ok(secondDigest)
      assert.ok(secondDigest!.carried, 'second digest must carry the first verbatim')
      assert.deepEqual(secondDigest!.carried, firstDigest)
      // the first boundary's anchors survive verbatim in the render
      assert.ok(second.event.summary.includes('0123456789abcdef0123456789abcdef01234567'))
      // and the previous summary text is NOT chain-duplicated on top
      const firstRenderCount = second.event.summary.split('## Faithful Compaction Digest').length - 1
      assert.ok(firstRenderCount >= 2, 'carried render is nested, not chained as prose')
    } finally {
      if (prev.mode === undefined) delete process.env.BABEL_O_COMPACT_MODE
      else process.env.BABEL_O_COMPACT_MODE = prev.mode
      if (prev.max === undefined) delete process.env.BABEL_O_MAX_CONTEXT_TOKENS
      else process.env.BABEL_O_MAX_CONTEXT_TOKENS = prev.max
      if (prev.flag === undefined) delete process.env.BABEL_O_COMPACT_FAITHFUL_DIGEST
      else process.env.BABEL_O_COMPACT_FAITHFUL_DIGEST = prev.flag
    }
  })
})
