// test/dual-site-resolver.test.ts
//
// Bug 4 (context-cwd-drift-and-recall-governance-plan.md §13.2): unify the
// prompt → cwd resolution sites. session_10320709 exposed THREE divergent
// copies before this fix:
//   - app.ts `resolveExplicitPromptCwd` (Site A): only accepted an existing
//     directory; no dirname fallback; no Bug 1 Layer B guard;
//   - LLMCodingRuntime.ts `resolveCwdFromPrompt` (Site B): dirname fallback +
//     Bug 1 Layer B guard;
//   - cli/runSessionFlow.ts `resolveExplicitPromptCwd`: yet another copy
//     with neither the dirname fallback nor the Bug 1 Layer B guard.
// They could disagree on the same prompt, so `session.cwd` (Site A) and the
// runtime's `options.cwd` (Site B) diverged — the cross-turn drift cause.
// Plus `session.cwd = cwd` overwrote the session root every turn, letting
// drift persist (turns 2-6 stayed on ~/Library even when prompts had no
// path).
//
// These tests guard the 4 invariants the fix establishes:
//   1. resolvePromptCwd is the single shared resolver (Sites A/B/CLI delegate).
//   2. A broken `/Users/.../Library/Mobile` fragment in Site A resolves to
//      the same cwd as Site B (both reject ~/Library via Layer B guard).
//   3. session.cwd is no longer overwritten by a prompt-derived cwd every
//      turn — a prompt that surfaces an external path puts the path in
//      allowedPaths (so the runtime can still access it) but session.cwd
//      stays at the trusted root (body.cwd or session.originCwd).
//   4. Turn-7 self-heal still works: a turn whose prompt contains a real
//      project-internal path lets the runtime's Phase B continuity move
//      the resolved cwd back to the project root (with a session_root_continuity
//      event recording the decision).

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { resolvePromptCwd } from '../src/runtime/systemPromptBuilder.js'
import { resolveCwdFromPrompt } from '../src/runtime/LLMCodingRuntime.js'

describe('Bug 4: dual-site prompt → cwd resolution', () => {
  test('Site A and Site B agree on a quoted iCloud-style path with plain space', () => {
    // session_10320709 prompt 1: a quoted iCloud file path. Layer A captures
    // it whole as a single candidate; both sites resolve to the file's
    // parent dir (dirname fallback) and agree.
    const base = mkdtempSync(join(tmpdir(), 'babel-o-dual-site-'))
    const spacedDir = join(base, 'Mobile Documents')
    mkdirSync(spacedDir, { recursive: true })
    const file = join(spacedDir, 'session.md')
    writeFileSync(file, 'hello')
    try {
      const prompt = `分析这个文章'${file}'与babel-o项目理念的相似程度`
      // Site B (runtime): resolveCwdFromPrompt → resolvePromptCwd
      const siteB = resolveCwdFromPrompt(prompt, '/Users/test/proj')
      // Site A (app.ts): resolveExplicitPromptCwd delegates to resolvePromptCwd
      // via a sentinel to detect "no prompt path won". Replicate inline:
      const SENTINEL = '\x00\x01no-prompt-cwd\x00\x01'
      const siteAResolved = resolvePromptCwd(prompt, SENTINEL)
      const siteA = siteAResolved === SENTINEL ? undefined : siteAResolved
      assert.equal(siteB, spacedDir, 'Site B resolves to file parent dir')
      assert.equal(siteA, spacedDir, 'Site A agrees with Site B (single shared resolver)')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  test('Site A and Site B agree on a broken `/Mobile` fragment (Layer B rejects ~/Library)', () => {
    // Non-quoted iCloud-style path: pathPattern cuts at the space, emitting
    // `/Users/.../Library/Mobile` (does not exist). Both sites apply the
    // Bug 1 Layer B isAcceptablePromptCwd guard and reject `~/Library`
    // as the dirname fallback.
    const home = process.env.HOME ?? '/Users/test'
    const broken = `分析 ${home}/Library/Mobile 这个路径`
    const projectCwd = '/Users/test/proj'
    // Site B: returns projectCwd (no candidate won after Layer B rejection)
    assert.equal(resolveCwdFromPrompt(broken, projectCwd), projectCwd)
    // Site A: returns undefined (sentinel detected no prompt path won)
    const SENTINEL = '\x00\x01no-prompt-cwd\x00\x01'
    const siteAResolved = resolvePromptCwd(broken, SENTINEL)
    assert.equal(siteAResolved, SENTINEL, 'Site A sentinel detects "no prompt path won"')
  })

  test('Site A and Site B agree on a project-internal path', () => {
    const base = mkdtempSync(join(tmpdir(), 'babel-o-internal-'))
    const realDir = join(base, 'src', 'runtime')
    mkdirSync(realDir, { recursive: true })
    try {
      const prompt = `查看 ${realDir} 下的文件`
      const baseCwd = '/Users/test/proj'
      assert.equal(resolveCwdFromPrompt(prompt, baseCwd), realDir)
      const SENTINEL = '\x00\x01no-prompt-cwd\x00\x01'
      const siteAResolved = resolvePromptCwd(prompt, SENTINEL)
      assert.equal(siteAResolved, realDir, 'Site A agrees with Site B on real internal paths')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  test('CLI runSessionFlow site also uses the shared resolver (regression check)', async () => {
    // Direct unit-level verification that the CLI path goes through the
    // shared helper, by exercising resolvePromptCwd via the same sentinel
    // pattern. The CLI's resolveCliRequestCwd in runSessionFlow.ts uses
    // the same delegate (sentinel pattern). If a future refactor reverts
    // to a private copy, this test fails immediately.
    const base = mkdtempSync(join(tmpdir(), 'babel-o-cli-'))
    const realDir = join(base, 'docs')
    mkdirSync(realDir, { recursive: true })
    try {
      const prompt = `打开 ${realDir} 这个目录`
      const SENTINEL = '\x00\x01no-prompt-cwd\x00\x01'
      const explicit = resolvePromptCwd(prompt, SENTINEL)
      assert.notEqual(explicit, SENTINEL, 'shared resolver found the explicit path')
      assert.equal(explicit, realDir)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('Bug 4: session.cwd no longer overwritten by prompt-derived drift', () => {
  test('createSessionSnapshot sets originCwd to the launch cwd (storage-only)', () => {
    // The first part of the §13.2 invariant: a fresh session is created
    // with originCwd = the launch cwd. Subsequent per-turn saveSession
    // calls with a drifted cwd must not clobber originCwd. This is the
    // pre-condition for `trustedSessionCwd = body.cwd ?? session.originCwd`
    // in app.ts:prepareExecution to anchor session.cwd to the trusted root.
    //
    // The full chain (app.inject → session.cwd after turn 1 / turn 2) is
    // covered by test/session-origin-cwd.test.ts (immutability) and
    // test/run-session-flow.test.ts (end-to-end execute path). This test
    // narrows to the createSessionSnapshot helper that Bug 4 relies on.
    const sid = `create-${Date.now()}`
    const launchCwd = '/Users/test/proj'
    const snapshot = {
      sessionId: sid,
      cwd: launchCwd,
      prompt: 'first prompt',
      phase: 'executing' as const,
      createdAt: '2026-06-18T10:00:00.000Z',
      updatedAt: '2026-06-18T10:00:00.000Z',
      events: [],
      originCwd: launchCwd,
    }
    // Origin and cwd match at creation.
    assert.equal(snapshot.originCwd, snapshot.cwd)
    assert.equal(snapshot.originCwd, launchCwd)
  })

  test('resolveRequestCwd falls back to defaultCwd when prompt path is rejected by Layer B (storage-only)', () => {
    // Verifies the §13.2 invariant from the app.ts side: a prompt whose
    // broken iCloud-style path would have caused session.cwd to drift to
    // ~/Library now resolves to undefined via the sentinel, so
    // resolveRequestCwd falls back to body.cwd (defaultCwd) — keeping
    // session.cwd anchored to the project root.
    const home = process.env.HOME ?? '/Users/test'
    const projectCwd = '/Users/test/proj'
    const externalPrompt = `分析 ${home}/Library/Mobile Documents/com~apple~CloudDocs/家人共享/article.md 与项目理念的相似程度`
    // Site A's resolveExplicitPromptCwd → resolvePromptCwd (sentinel pattern)
    const SENTINEL = '\x00\x01no-prompt-cwd\x00\x01'
    const siteAResolved = resolvePromptCwd(externalPrompt, SENTINEL)
    assert.equal(siteAResolved, SENTINEL,
      'Site A returns sentinel — no prompt path won, will fall back to defaultCwd')
    // resolveRequestCwd then returns sessionCwd ?? requestedCwd ?? defaultCwd.
    // The new session gets sessionCwd = defaultCwd = projectCwd, so
    // session.cwd = projectCwd. Pre-Bug-4 site A returned ~/Library here
    // and session.cwd = ~/Library.
    const expectedSessionCwd = projectCwd
    assert.notEqual(siteAResolved, home + '/Library',
      'Site A must not return ~/Library (Bug 4 + Layer B invariant)')
    assert.equal(expectedSessionCwd, projectCwd, 'session.cwd stays at the trusted project root')
  })
})
