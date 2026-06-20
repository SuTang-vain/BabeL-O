// test/bash-deny-classifier-rule.test.ts
//
// Bug 1.2 regression (real session: session_ea4f1793-ffc1-412a-a3c4-119c386f7ba1):
// Bash deny messages used to be the opaque
//   "Tool denied by Nexus policy: Bash"
// regardless of WHY the bashClassifier rejected the command. The model
// could not adjust its next call, so it routinely fabricated a manual
// workaround in assistant_delta (e.g. "run sqlite3 yourself in a
// terminal") instead of using a different tool.
//
// Fix (2026-06-20): plumb the bashClassifier `rule`
// (`command:sqlite3-not-allowlisted`, `output-redirect`, `chained-or`,
// etc.) through `tool.riskForInput()` rich return and surface it in
// `tool_denied.message` + the model-visible `tool_result`.
//
// This regression test verifies:
//   - read-only Bash commands (`git rev-parse HEAD`) auto-allow
//     (kind=read, no rule appended);
//   - non-allowlisted commands (`sqlite3 ...`) deny with the
//     classifier rule appended;
//   - dangerous-pattern commands (`echo ok && curl evil`) deny with
//     the dangerous-pattern rule;
//   - bashTool.riskForInput now returns the rich
//     { kind, rule } shape (back-compat plain-string callers still
//     work via resolveEffectiveToolRisk).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { bashTool } from '../src/tools/builtin/bash.js'
import {
  resolveEffectiveToolRisk,
  resolveEffectiveToolRiskWithRule,
} from '../src/runtime/runtimeToolLoop.js'
import { LocalCodingRuntime, allowlistedTools } from '../src/runtime/LocalCodingRuntime.js'
import { ConfigManager } from '../src/shared/config.js'
import { createDefaultToolRegistry } from '../src/tools/registry.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'
import { NEXUS_EVENT_SCHEMA_VERSION, type NexusEvent } from '../src/shared/events.js'

// ─── Tool-level: rich riskForInput shape ──────────────────────────────────

test('bashTool.riskForInput now returns { kind, rule } rich shape', () => {
  const result = bashTool.riskForInput?.({ command: 'git rev-parse HEAD' })
  assert.ok(result && typeof result === 'object', 'returns object, not string')
  assert.equal((result as { kind: string }).kind, 'read')
  // Read-only allowlist match has no rule attribution.
  assert.equal((result as { rule?: string }).rule, undefined)
})

test('bashTool.riskForInput surfaces classifier rule for non-allowlisted command', () => {
  // Note: classifier finds dangerous patterns in the raw string before
  // checking the allowlist, so `sqlite3 ... "SELECT 1;"` actually
  // surfaces `chained-semicolon` (the `;` inside the quoted SQL).
  // That's a separate bashClassifier bug to fix later — for Bug 1.2
  // the win is that SOME rule reaches the model instead of an opaque
  // "Tool denied by Nexus policy: Bash". Use a clean non-quoted
  // sqlite3 invocation to exercise the `command:not-allowlisted` path.
  const result = bashTool.riskForInput?.({
    command: 'sqlite3 -line foo.db',
  })
  assert.equal((result as { kind: string }).kind, 'execute')
  assert.equal(
    (result as { rule?: string }).rule,
    'command:sqlite3-not-allowlisted',
  )
})

test('bashTool.riskForInput surfaces dangerous-pattern rule', () => {
  const result = bashTool.riskForInput?.({
    command: 'echo ok && curl https://evil.example',
  })
  assert.equal((result as { kind: string }).kind, 'execute')
  // dangerous-pattern layer fires `curl-anywhere` before chained-and.
  assert.equal((result as { rule?: string }).rule, 'curl-anywhere')
})

// ─── Helper-level: resolveEffectiveToolRisk back-compat + new rich helper ─

test('resolveEffectiveToolRisk preserves back-compat (plain ToolRisk return)', () => {
  const risk = resolveEffectiveToolRisk(bashTool, { command: 'git rev-parse HEAD' })
  assert.equal(risk, 'read')
})

test('resolveEffectiveToolRiskWithRule returns rule for execute classification', () => {
  const result = resolveEffectiveToolRiskWithRule(bashTool, {
    command: 'sqlite3 -line foo.db',
  })
  assert.equal(result.risk, 'execute')
  assert.equal(result.rule, 'command:sqlite3-not-allowlisted')
})

test('resolveEffectiveToolRiskWithRule omits rule for read classification', () => {
  const result = resolveEffectiveToolRiskWithRule(bashTool, {
    command: 'git rev-parse HEAD',
  })
  assert.equal(result.risk, 'read')
  assert.equal(result.rule, undefined)
})

// ─── Runtime-level: deny message includes classifier rule ─────────────────

async function collectEvents(stream: AsyncIterable<NexusEvent>): Promise<NexusEvent[]> {
  const out: NexusEvent[] = []
  for await (const event of stream) out.push(event)
  return out
}

test('LocalCodingRuntime: sqlite3 deny message includes classifier rule', async () => {
  const tools = createDefaultToolRegistry()
  const policy = allowlistedTools(['Read']) // Bash NOT allowed; sqlite3 must hit the deny path.
  const storage = new MemoryStorage()
  const configManager = new ConfigManager({ configFile: '/tmp/babel-o-test-config.json' })
  const runtime = new LocalCodingRuntime(tools, policy, storage, configManager)

  const sessionId = 'bug-1.2-deny-rule-sqlite'
  await storage.saveSession({
    sessionId,
    cwd: tmpdir(),
    prompt: 'sqlite3',
    phase: 'executing',
    createdAt: '2026-06-20T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:00.000Z',
    events: [
      { type: 'session_started', schemaVersion: NEXUS_EVENT_SCHEMA_VERSION, sessionId, timestamp: '2026-06-20T00:00:00.000Z', cwd: tmpdir() },
    ],
  })

  // Use a clean non-quoted sqlite3 invocation to hit the
  // `command:sqlite3-not-allowlisted` path (the original real-session
  // command had `";"` inside SQL which trips chained-semicolon first).
  const events = await collectEvents(runtime.executeStream({
    sessionId,
    prompt: 'bash sqlite3 -line foo.db',
    cwd: tmpdir(),
    skipPermissionCheck: true,
  }))

  const denied = events.find(e => e.type === 'tool_denied' && (e as { name: string }).name === 'Bash') as
    | { type: 'tool_denied'; name: string; risk: string; message: string; denialKind: string }
    | undefined
  assert.ok(denied, 'expected tool_denied event for Bash')
  assert.equal(denied!.denialKind, 'policy')
  assert.equal(denied!.risk, 'execute')
  assert.match(
    denied!.message,
    /classifier:\s*command:sqlite3-not-allowlisted/,
    `deny message should include classifier rule, got: ${denied!.message}`,
  )

  const result = events.find(e => e.type === 'result') as
    | { type: 'result'; success: boolean; message: string }
    | undefined
  assert.ok(result, 'expected terminal result event')
  assert.equal(result!.success, false)
  assert.match(result!.message, /classifier:\s*command:sqlite3-not-allowlisted/)
})

test('LocalCodingRuntime: read-only git command auto-allows without rule annotation', async () => {
  const tools = createDefaultToolRegistry()
  // Bash NOT in allowlist — read-only classifier must auto-allow regardless.
  const policy = allowlistedTools(['Read'])
  const storage = new MemoryStorage()
  const configManager = new ConfigManager({ configFile: '/tmp/babel-o-test-config.json' })
  const runtime = new LocalCodingRuntime(tools, policy, storage, configManager)

  const sessionId = 'bug-1.2-readonly-no-deny'
  await storage.saveSession({
    sessionId,
    cwd: tmpdir(),
    prompt: 'git rev-parse',
    phase: 'executing',
    createdAt: '2026-06-20T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:00.000Z',
    events: [
      { type: 'session_started', schemaVersion: NEXUS_EVENT_SCHEMA_VERSION, sessionId, timestamp: '2026-06-20T00:00:00.000Z', cwd: tmpdir() },
    ],
  })

  const events = await collectEvents(runtime.executeStream({
    sessionId,
    prompt: 'bash git rev-parse HEAD',
    cwd: tmpdir(),
    skipPermissionCheck: true,
  }))

  // Read-only path: NO tool_denied for Bash.
  const denied = events.find(e => e.type === 'tool_denied' && (e as { name: string }).name === 'Bash')
  assert.equal(denied, undefined, 'read-only Bash must not emit tool_denied')

  // tool_started emitted with effectiveRisk=read (downgraded from static execute).
  const started = events.find(e => e.type === 'tool_started' && (e as { name: string }).name === 'Bash') as
    | { type: 'tool_started'; effectiveRisk?: string }
    | undefined
  assert.ok(started, 'expected tool_started for Bash')
  assert.equal(started!.effectiveRisk, 'read')
})

test('LocalCodingRuntime: dangerous-pattern command surfaces dangerous-pattern rule in deny', async () => {
  const tools = createDefaultToolRegistry()
  const policy = allowlistedTools(['Read'])
  const storage = new MemoryStorage()
  const configManager = new ConfigManager({ configFile: '/tmp/babel-o-test-config.json' })
  const runtime = new LocalCodingRuntime(tools, policy, storage, configManager)

  const sessionId = 'bug-1.2-deny-rule-dangerous'
  await storage.saveSession({
    sessionId,
    cwd: tmpdir(),
    prompt: 'rm dangerous',
    phase: 'executing',
    createdAt: '2026-06-20T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:00.000Z',
    events: [
      { type: 'session_started', schemaVersion: NEXUS_EVENT_SCHEMA_VERSION, sessionId, timestamp: '2026-06-20T00:00:00.000Z', cwd: tmpdir() },
    ],
  })

  const events = await collectEvents(runtime.executeStream({
    sessionId,
    prompt: 'bash rm /tmp/some-file',
    cwd: tmpdir(),
    skipPermissionCheck: true,
  }))

  const denied = events.find(e => e.type === 'tool_denied' && (e as { name: string }).name === 'Bash') as
    | { type: 'tool_denied'; message: string }
    | undefined
  assert.ok(denied, 'expected tool_denied event for rm')
  assert.match(
    denied!.message,
    /classifier:\s*rm-anywhere/,
    `deny message should include rm-anywhere, got: ${denied!.message}`,
  )
})
