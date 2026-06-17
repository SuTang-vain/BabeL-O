// test/context-cli.test.ts
//
// PR-9 unit tests: `bbl context working-set` CLI command.
// Covers: empty file, single session, multiple sessions, --json,
// cwd override, HOME isolation.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Command } from 'commander'

import { registerContextCommand, runWorkingSet } from '../src/cli/commands/context.js'

const ORIGINAL_ENV: Record<string, string | undefined> = {}

describe('PR-9 bbl context working-set', () => {
  let home: string
  let cwd: string
  const sessionId = `cli-${randomUUID()}`

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'babel-o-cli-home-'))
    cwd = mkdtempSync(join(home, 'project-'))
    for (const key of ['HOME', 'BABEL_O_TEST_CONFIG_WRITE_GUARD']) {
      ORIGINAL_ENV[key] = process.env[key]
    }
    process.env.HOME = home
    process.env.BABEL_O_TEST_CONFIG_WRITE_GUARD = '1'
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    for (const [key, val] of Object.entries(ORIGINAL_ENV)) {
      if (val === undefined) delete process.env[key]
      else process.env[key] = val
    }
  })

  function seedWorkingSet(entries: Array<{ sid: string; workspaceId: string; items: any[] }>): void {
    const dir = join(cwd, '.babel-o')
    mkdirSync(dir, { recursive: true })
    const sessions: Record<string, any> = {}
    for (const e of entries) {
      sessions[e.sid] = {
        sessionId: e.sid,
        workspaceId: e.workspaceId,
        entries: e.items,
        version: 1,
        updatedAt: '2026-06-16T00:00:00.000Z',
      }
    }
    writeFileSync(
      join(dir, 'working-set.json'),
      JSON.stringify({ schemaVersion: '2026-06-16.working-set.v1', sessions }, null, 2),
      'utf8',
    )
  }

  test('empty file: (no working set found) and exit 0', async () => {
    const output = await captureStdout(() => runWorkingSet({ cwd }))
    assert.ok(output.includes('no working set found'), 'should print empty message')
  })

  test('empty file --json: prints empty sessions array', async () => {
    const output = await captureStdout(() => runWorkingSet({ cwd, json: true }))
    const parsed = JSON.parse(output)
    assert.deepEqual(parsed.sessions, [])
  })

  test('single session: prints human-readable table', async () => {
    seedWorkingSet([{
      sid: sessionId,
      workspaceId: cwd,
      items: [
        { key: 'task:investigate', value: 'review main.ts', updatedAt: '2026-06-16T00:00:00.000Z', confidence: 0.95 },
        { key: 'file:src/main.ts', value: '/path/to/main.ts', updatedAt: '2026-06-16T00:00:00.000Z', confidence: 0.8 },
      ],
    }])
    const output = await captureStdout(() => runWorkingSet({ cwd }))
    assert.ok(output.includes(`Session: ${sessionId}`), 'session id printed')
    assert.ok(output.includes('task:investigate'), 'entry key printed')
    assert.ok(output.includes('review main.ts'), 'entry value printed')
    assert.ok(output.includes('0.95'), 'confidence printed')
    assert.ok(output.includes('0.80'), 'confidence rounded to 2 decimals')
  })

  test('single session --json: prints raw object', async () => {
    seedWorkingSet([{
      sid: sessionId,
      workspaceId: cwd,
      items: [{ key: 'k', value: 'v', updatedAt: 't', confidence: 0.5 }],
    }])
    const output = await captureStdout(() => runWorkingSet({ cwd, json: true }))
    const parsed = JSON.parse(output)
    assert.ok(parsed[sessionId], 'session key present')
    assert.equal(parsed[sessionId].workspaceId, cwd)
    assert.equal(parsed[sessionId].entries.length, 1)
    assert.equal(parsed[sessionId].entries[0].key, 'k')
  })

  test('multiple sessions: prints all by default', async () => {
    seedWorkingSet([
      { sid: 's1', workspaceId: cwd, items: [{ key: 'a', value: 'A', updatedAt: 't', confidence: 0.9 }] },
      { sid: 's2', workspaceId: cwd, items: [{ key: 'b', value: 'B', updatedAt: 't', confidence: 0.7 }] },
    ])
    const output = await captureStdout(() => runWorkingSet({ cwd }))
    assert.ok(output.includes('Session: s1'))
    assert.ok(output.includes('Session: s2'))
  })

  test('--session-id filter: only matching session printed', async () => {
    seedWorkingSet([
      { sid: 's1', workspaceId: cwd, items: [{ key: 'a', value: 'A', updatedAt: 't', confidence: 0.9 }] },
      { sid: 's2', workspaceId: cwd, items: [{ key: 'b', value: 'B', updatedAt: 't', confidence: 0.7 }] },
    ])
    const output = await captureStdout(() => runWorkingSet({ cwd, sessionId: 's1' }))
    assert.ok(output.includes('Session: s1'))
    assert.ok(!output.includes('Session: s2'), 's2 filtered out')
  })

  test('--session-id non-existent: empty output (no error)', async () => {
    seedWorkingSet([{ sid: 's1', workspaceId: cwd, items: [] }])
    const output = await captureStdout(() => runWorkingSet({ cwd, sessionId: 'nonexistent' }))
    assert.ok(!output.includes('Session: s1'), 's1 not printed')
    assert.ok(!output.includes('error'), 'no error printed')
  })

  test('cwd override: reads from specified directory', async () => {
    const otherCwd = mkdtempSync(join(tmpdir(), 'babel-o-cli-other-'))
    try {
      seedWorkingSet([{ sid: 'primary', workspaceId: cwd, items: [] }])
      const otherDir = join(otherCwd, '.babel-o')
      mkdirSync(otherDir, { recursive: true })
      writeFileSync(
        join(otherDir, 'working-set.json'),
        JSON.stringify({
          schemaVersion: '2026-06-16.working-set.v1',
          sessions: { other: { sessionId: 'other', workspaceId: otherCwd, entries: [], version: 1, updatedAt: 't' } },
        }, null, 2),
        'utf8',
      )
      const output = await captureStdout(() => runWorkingSet({ cwd: otherCwd }))
      assert.ok(output.includes('Session: other'), 'reads from otherCwd')
      assert.ok(!output.includes('Session: primary'), 'does not read from cwd')
    } finally {
      rmSync(otherCwd, { recursive: true, force: true })
    }
  })

  test('isolation: file in HOME is NOT read (only cwd)', async () => {
    // Write a working-set.json directly in HOME (no .babel-o prefix)
    writeFileSync(join(home, 'working-set.json'), JSON.stringify({
      schemaVersion: '2026-06-16.working-set.v1',
      sessions: { homeSession: { sessionId: 'homeSession', workspaceId: home, entries: [], version: 1, updatedAt: 't' } },
    }), 'utf8')
    const output = await captureStdout(() => runWorkingSet({ cwd }))
    assert.ok(!output.includes('homeSession'), 'HOME file not read')
  })
})

describe('PR-9 registerContextCommand integration', () => {
  test('registers bbl context as a subcommand of program', () => {
    const program = new Command()
    registerContextCommand(program)
    const ctx = program.commands.find(c => c.name() === 'context')
    assert.ok(ctx, 'context subcommand registered')
    const ws = ctx!.commands.find(c => c.name() === 'working-set')
    assert.ok(ws, 'working-set sub-subcommand registered')
  })
})

// ─── Test helper ─────────────────────────────────────────────────────────

function captureStdout(fn: () => void | Promise<void>): Promise<string> {
  const original = process.stdout.write.bind(process.stdout)
  let buf = ''
  // Mock with a permissive signature that matches Node's real stdout.write
  // (which accepts string | Uint8Array, optional encoding, optional callback).
  // Use a function declaration to avoid strict signature checks.
  function mockWrite(chunk: any, _encoding?: any, _cb?: any): boolean {
    buf += typeof chunk === 'string' ? chunk : chunk.toString()
    return true
  }
  ;(process.stdout.write as unknown) = mockWrite
  return Promise.resolve()
    .then(() => fn())
    .finally(() => {
      ;(process.stdout.write as unknown) = original
    })
    .then(() => buf)
}
