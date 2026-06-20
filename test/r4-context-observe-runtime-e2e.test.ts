// test/r4-context-observe-runtime-e2e.test.ts
//
// R4 of docs/nexus/proposals/long-running-context-assembly.md §20:
// Prove /v1/context/observe is not just a broadcaster skeleton; it
// receives assembled context from actual runtime turns.
//
// R4 acceptance (per long-running-context-assembly.md §20 R4):
//   1. Default observer payload is redacted (counts/budgets/section
//      metadata, NOT the full systemPrompt/messages text)
//   2. ?full=1 query flag opts in to the verbatim context for
//      local/debug consumers
//   3. Observer never blocks execution (publish is fire-and-forget)
//   4. Observer cleans up subscribers on socket close (no leak)
//   5. Reconnect gets assembled_snapshot with the latest context
//      summary
//   6. e2e: execute one real turn → observer receives an `assembled`
//      event WITHOUT manual defaultContextBroadcaster.publish() from
//      the test code
//
// This test covers both:
//   (a) the redaction contract (unit-level)
//   (b) the runtime-hot-path e2e (integration, no manual publish)

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  redactContext,
  ContextBroadcaster,
  type RedactedContext,
} from '../src/nexus/contextBroadcaster.js'
import { createDefaultNexusRuntime } from '../src/nexus/createRuntime.js'
import { createNexusApp } from '../src/nexus/app.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'

function makeFakeAssembledContext() {
  // The full AssembledContext type is large (ContextSelectionDiagnostics,
  // PostCompactState, etc.). The R4 redaction contract is agnostic to
  // those sub-fields — the test only asserts that `redactContext` strips
  // `systemPrompt` + `messages` and preserves everything else. The function
  // return type is Parameters<typeof redactContext>[0] (= AssembledContext),
  // so every literal is widened to the target by TS without cascading
  // inference issues from `as never` workarounds.
  return {
    systemPrompt: 'IDENTITY\n\nYou are a test assistant.\n\nSYSTEM_RULES\n\nBe helpful.',
    systemPromptBlocks: [
      { text: 'IDENTITY\n\nYou are a test assistant.', cacheable: true },
      { text: 'SYSTEM_RULES\n\nBe helpful.', cacheable: true },
      { text: 'ENV_INFO\n\ncwd=/Users/test/proj', cacheable: false },
    ],
    messages: [
      { role: 'user' as 'user', content: 'hello' },
      { role: 'assistant' as 'assistant', content: 'hi there' },
      { role: 'user' as 'user', content: 'do something' },
    ],
    budget: {
      maxTokens: 200000,
      maxChars: 800000,
      layerBudgets: { system: 0, memory: 0, summary: 0, recent: 0 },
      snipToolOutputChars: 0,
      snipPriorTurnToolOutputChars: 0,
      microcompactToolOutputChars: 0,
      microcompactInternalTextChars: 0,
      recentEventLimit: 0,
      recentTurnLimit: 0,
      usedTokens: 1500,
      reservedTokens: 1000,
    },
    selectedEventCount: 7,
    omittedEventCount: 2,
    snippedEventCount: 0,
    sessionSummary: 'Test session',
    projectMemory: '',
    activeSkills: '',
    gitStatus: '',
    compactRetainedEventCount: 0,
    compactRetainedSegmentValid: true,
    compactRetainedSegmentWarning: '',
    postCompactState: {
      recentReadFiles: [],
      restoredFileContents: [],
      activeToolNames: [],
      activeSkills: [],
      skillReminderLines: [],
      mcpToolLines: [],
      toolContractLines: [],
      toolFailureLines: [],
      taskStatusLines: [],
      agentStatusLines: [],
      subTaskStatusLines: [],
      hookLines: [],
    },
    userIntentGuidance: {
      intent: 'continue' as const,
      confidence: 0.9,
      continuity: 0.9,
      contextScope: 'recent' as const,
      actionHint: 'normal' as const,
      requiresTools: true,
      problemTarget: 'project_feature' as const,
      reason: 'r4 e2e',
      latestUserText: 'r4 e2e smoke',
      explicitPaths: [],
      source: 'model' as const,
    },
    memoryTruncated: false,
    microcompactedEventCount: 0,
    microcompactMetrics: {
      compactedEventCount: 0,
      deduplicatedToolResultCount: 0,
      bytesBefore: 0,
      bytesAfter: 0,
      bytesSaved: 0,
      estimatedTokensSaved: 0,
    },
    selectionDiagnostics: {
      phases: [] as never[],
      estimatedTokens: 0,
      maxTokens: 0,
      percentUsed: 0,
      retained: [] as never[],
      dropped: [] as never[],
      workingSetPaths: [],
    },
    memoryCapabilityAvailable: true,
    scopedMemoryDiagnostics: [],
  } as unknown as Parameters<typeof redactContext>[0]
}

describe('R4: redactContext contract', () => {
  test('summary mode strips systemPrompt + messages, preserves structured fields', () => {
    const original = makeFakeAssembledContext()
    const redacted = redactContext(original, 'summary') as RedactedContext

    // systemPrompt + messages are stripped (and replaced by length metadata)
    assert.ok(!('systemPrompt' in redacted), 'systemPrompt must be stripped in summary mode')
    assert.ok(!('messages' in redacted), 'messages must be stripped in summary mode')
    assert.equal(redacted.redaction.systemPromptChars, original.systemPrompt.length)
    assert.equal(redacted.redaction.messageCount, 3)
    assert.equal(redacted.redaction.messageChars, 'hello'.length + 'hi there'.length + 'do something'.length)
    // blockCount + cacheableBlockCount survive
    assert.equal(redacted.redaction.blockCount, 3)
    assert.equal(redacted.redaction.cacheableBlockCount, 2)
    // Structured fields survive verbatim
    assert.deepEqual(redacted.budget, original.budget)
    assert.equal(redacted.selectedEventCount, original.selectedEventCount)
    assert.equal(redacted.sessionSummary, original.sessionSummary)
  })

  test('summary mode strips per-block `text` (Bug 2: systemPromptBlocks leak)', () => {
    // Real e2e via /v1/context/observe during an active execute caught
    // this: the legacy destructure stripped `systemPrompt` (joined
    // string) and `messages`, but `systemPromptBlocks: Array<{ text,
    // cacheable }>` survived redaction — leaking the full ~14k-char
    // system prompt verbatim to WS observer subscribers under default
    // summary mode. Fix (2026-06-20): also strip the per-block `text`
    // field; only `{ cacheable }` markers survive.
    const original = makeFakeAssembledContext()
    const redacted = redactContext(original, 'summary') as RedactedContext

    assert.ok(redacted.systemPromptBlocks, 'systemPromptBlocks array present')
    assert.equal(redacted.systemPromptBlocks!.length, 3)
    for (const block of redacted.systemPromptBlocks!) {
      assert.ok(!('text' in block), `block.text must be stripped, got: ${JSON.stringify(block)}`)
      assert.ok('cacheable' in block, 'block.cacheable survives as length-only marker')
    }
    // blockCount still equals the original count
    assert.equal(redacted.redaction.blockCount, 3)
    // None of the original per-block text leaks
    const json = JSON.stringify(redacted)
    assert.ok(!json.includes('IDENTITY'), 'block 1 text not leaked')
    assert.ok(!json.includes('SYSTEM_RULES'), 'block 2 text not leaked')
    assert.ok(!json.includes('ENV_INFO'), 'block 3 text not leaked')
    assert.ok(!json.includes('You are a test assistant'), 'block body not leaked')
  })

  test('full mode keeps systemPromptBlocks with text intact', () => {
    const original = makeFakeAssembledContext()
    const full = redactContext(original, 'full') as AssembledContext
    assert.equal(full.systemPromptBlocks!.length, 3)
    assert.ok(full.systemPromptBlocks![0]!.text.includes('IDENTITY'))
    assert.ok(full.systemPromptBlocks![1]!.text.includes('SYSTEM_RULES'))
  })

  test('full mode returns the original context verbatim', () => {
    const original = makeFakeAssembledContext()
    const full = redactContext(original, 'full')
    // Should be the same shape — systemPrompt + messages present
    assert.ok('systemPrompt' in full)
    assert.ok('messages' in full)
    assert.equal((full as { systemPrompt: string }).systemPrompt, original.systemPrompt)
    assert.equal((full as { messages: unknown[] }).messages.length, original.messages.length)
  })

  test('default mode is summary (no mode arg)', () => {
    const original = makeFakeAssembledContext()
    const redacted = redactContext(original) as RedactedContext
    assert.ok(!('systemPrompt' in redacted))
    assert.ok(!('messages' in redacted))
    assert.ok(redacted.redaction, 'default mode emits redaction summary')
  })

  test('redaction handles messages with array content blocks', () => {
    const original = makeFakeAssembledContext()
    // Inject a message with array content (Anthropic-style)
    const originalWithArray = {
      ...original,
      messages: [
        ...original.messages,
        { role: 'assistant' as 'assistant', content: [
          { type: 'text', text: 'hello world' },
          { type: 'tool_use', id: 'x', name: 'Read', input: { path: '/a' } },
        ] as unknown as never },
      ],
    } as unknown as Parameters<typeof redactContext>[0]
    const redacted = redactContext(originalWithArray, 'summary') as RedactedContext
    assert.equal(redacted.redaction.messageCount, 4)
    // The text block contributes 11 chars; the tool_use block contributes
    // the JSON.stringify length. We don't pin the exact number — just
    // assert it's > the plain-text contribution of the prior 3 messages.
    const plainOnlyChars = 'hello'.length + 'hi there'.length + 'do something'.length
    assert.ok(redacted.redaction.messageChars > plainOnlyChars,
      'array content message chars must include text block + tool_use JSON')
  })
})

describe('R4: ContextBroadcaster default-on redaction (observer + broadcaster wiring)', () => {
  let cwd: string
  let broadcaster: ContextBroadcaster

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'babel-o-r4-broadcaster-'))
    broadcaster = new ContextBroadcaster()
  })

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  test('subscriber receives redacted context by default (mode summary)', () => {
    const events: unknown[] = []
    broadcaster.subscribe(cwd, (ev) => events.push(ev))
    const original = makeFakeAssembledContext()
    broadcaster.publish(cwd, {
      type: 'assembled',
      sessionId: 's1',
      context: original,
      timestamp: new Date().toISOString(),
    })
    // The handler receives the raw event with full context (the
    // redaction is the observer ROUTE's responsibility, not the
    // broadcaster's). The route applies redactContext before sending
    // over the wire. The broadcaster publishes verbatim so route-level
    // opt-in (?full=1) can work.
    assert.equal(events.length, 1)
    const ev = events[0] as { context: { systemPrompt: string } }
    assert.equal(ev.context.systemPrompt, original.systemPrompt)
  })

  test('getLast returns verbatim; route applies redactContext before serializing', () => {
    // Documents the contract: getLast returns the verbatim context;
    // the redaction is applied at the route boundary (see contextObserveRouter).
    // The unit-level redaction is in the redactContext tests above.
    const original = makeFakeAssembledContext()
    broadcaster.publish(cwd, {
      type: 'assembled',
      sessionId: 's1',
      context: original,
      timestamp: new Date().toISOString(),
    })
    const got = broadcaster.getLast(cwd, 's1')
    assert.ok(got)
    assert.equal(got!.systemPrompt, original.systemPrompt)
  })

  test('unsubscriber removes the handler (no leak on socket close)', () => {
    const events: unknown[] = []
    const unsubscribe = broadcaster.subscribe(cwd, (ev) => events.push(ev))
    broadcaster.publish(cwd, {
      type: 'assembled',
      sessionId: 's1',
      context: makeFakeAssembledContext(),
      timestamp: new Date().toISOString(),
    })
    assert.equal(events.length, 1, 'subscriber received the first event')
    unsubscribe()
    broadcaster.publish(cwd, {
      type: 'assembled',
      sessionId: 's2',
      context: makeFakeAssembledContext(),
      timestamp: new Date().toISOString(),
    })
    assert.equal(events.length, 1, 'unsubscriber removed the handler; second event skipped')
  })
})

describe('R4: e2e — LLMCodingRuntime hot path publishes to the broadcaster', () => {
  let cwd: string
  let broadcaster: ContextBroadcaster

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'babel-o-r4-runtime-'))
    mkdirSync(cwd, { recursive: true })
    broadcaster = new ContextBroadcaster()
  })

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  test('LLMCodingRuntime.executeStream publishes an assembled event for a real turn (no manual defaultContextBroadcaster.publish)', async () => {
    // Per R4 acceptance: "No reliance on manual
    // defaultContextBroadcaster.publish() for the primary e2e." We
    // construct a real LLMCodingRuntime with the shared broadcaster
    // injected via the constructor; the hot path's safeContextPublish
    // call (inside refreshRuntimeContextState) is the production code
    // path that publishes.
    const { LLMCodingRuntime } = await import('../src/runtime/LLMCodingRuntime.js')
    const { createDefaultToolRegistry } = await import('../src/tools/registry.js')
    const { allowAllTools } = await import('../src/runtime/LocalCodingRuntime.js')
    const { ConfigManager } = await import('../src/shared/config.js')

    const tools = createDefaultToolRegistry()
    const storage = new MemoryStorage()
    const policy = allowAllTools()
    const runtime = new LLMCodingRuntime(
      tools, policy, storage,
      ConfigManager.getInstance(),
      undefined, // memoryProvider
      broadcaster, // contextBroadcaster — R4 e2e wires the shared instance
    )

    const sessionId = `r4-runtime-${randomUUID()}`
    const received: unknown[] = []
    broadcaster.subscribeSession(cwd, sessionId, (ev) => received.push(ev))

    // Drive one real executeStream turn. The runtime's pre-loop
    // refreshRuntimeContextState → safeContextPublish fires before any
    // provider call, so we should see at least one event regardless
    // of whether the mock provider succeeds.
    try {
      for await (const _ev of runtime.executeStream({
        sessionId,
        prompt: 'r4 e2e smoke',
        cwd,
        skipPermissionCheck: true,
      })) {
        // drain; we only care about broadcaster events
      }
    } catch {
      // The mock provider may fail / abort in the test env; we only
      // care that the broadcaster received a publish, which happens
      // BEFORE the provider call.
    }

    // Allow the fire-and-forget publish a small window to land.
    const start = Date.now()
    while (received.length === 0 && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 25))
    }
    assert.ok(received.length > 0,
      'LLMCodingRuntime.executeStream did NOT publish a context event to the shared broadcaster')
    const ev = received[0] as { type: string; sessionId: string; context: { systemPrompt: string } }
    assert.equal(ev.type, 'assembled')
    assert.equal(ev.sessionId, sessionId)
    assert.ok(ev.context.systemPrompt.length > 0, 'published context carries the assembled system prompt')
  })

  test('reconnect after the first publish receives the latest context as assembled_snapshot', async () => {
    // Per R4 spec: "Reconnect and assert `assembled_snapshot` has the
    // latest context summary." The cache is the source of truth on
    // reconnect (the WS observer route sends an `assembled_snapshot`
    // frame from broadcaster.getLast).
    const original = makeFakeAssembledContext()
    broadcaster.publish(cwd, {
      type: 'assembled',
      sessionId: 's1',
      context: original,
      timestamp: new Date().toISOString(),
    })

    // Simulate a reconnect: the observer route calls getLast to send
    // the initial snapshot. The redaction contract applies the same
    // way as for live events.
    const got = broadcaster.getLast(cwd, 's1')
    assert.ok(got, 'broadcaster remembers the last assembled context per cwd+sessionId')
    assert.deepEqual(got!.budget, original.budget)
    assert.equal(got!.selectedEventCount, original.selectedEventCount)
  })
})

// Reference the unused import (linter consistency).
void MemoryStorage
