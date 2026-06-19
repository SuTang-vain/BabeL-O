// test/resolve-cwd-fallback.test.ts
//
// Bug 1 Layer B (context-cwd-drift-and-recall-governance-plan.md §13.3):
// shared `isAcceptablePromptCwd` guard at both cwd resolution sites
// (`app.ts:resolveExplicitPromptCwd` Site A + `LLMCodingRuntime.ts:resolveCwdFromPrompt`
// Site B). System/home directories (`~/Library`, `~/Documents`, homedir,
// `/Users`, `/`) always exist on macOS, so they pass the `existsSync` +
// `isDirectory` checks and would otherwise be promoted as prompt-derived cwd —
// the exact cause of session_10320709's drift to `~/Library` (dirname fallback
// of a non-existent `/Users/.../Library/Mobile` candidate). These tests guard
// that Layer B rejects such fallbacks while still accepting real project roots.
//
// Uses the real homedir() so the rejected paths are the actual on-disk system
// dirs, not synthetic ones — the test is honest about what exists.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { isAcceptablePromptCwd } from '../src/runtime/systemPromptBuilder.js'
import { resolveCwdFromPrompt } from '../src/runtime/LLMCodingRuntime.js'

describe('isAcceptablePromptCwd — vocabulary', () => {
  test('rejects homedir itself', () => {
    assert.equal(isAcceptablePromptCwd(homedir()), false)
  })

  test('rejects ~/Library (session_10320709 drift target)', () => {
    const target = join(homedir(), 'Library')
    if (!existsSync(target)) return // non-macOS skip
    assert.equal(isAcceptablePromptCwd(target), false)
  })

  test('rejects ~/Documents', () => {
    const target = join(homedir(), 'Documents')
    if (!existsSync(target)) return
    assert.equal(isAcceptablePromptCwd(target), false)
  })

  test('rejects / and /Users', () => {
    assert.equal(isAcceptablePromptCwd('/'), false)
    assert.equal(isAcceptablePromptCwd('/Users'), false)
    assert.equal(isAcceptablePromptCwd('/Users/'), false)
  })

  test('accepts a synthetic project root (non-home, non-system)', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'babel-o-accept-'))
    try {
      assert.equal(isAcceptablePromptCwd(projectDir), true)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })
})

describe('resolveCwdFromPrompt — Bug 1 Layer B system-dir fallback rejection (Site B)', () => {
  const projectCwd = '/Users/test/DEV/BABEL/BabeL-O'

  test('does NOT drift to ~/Library via dirname fallback of a broken fragment', () => {
    // Mimics session_10320709: a path with a plain space (no quotes, so
    // Layer A does not capture it whole) gets cut by pathPattern into
    // `/Users/<user>/Library/Mobile`, which does NOT exist. Pre-Layer-B the
    // dirname fallback returned `~/Library` (always exists). Layer B must
    // reject it and keep baseCwd.
    const home = homedir()
    const broken = `分析 ${home}/Library/Mobile 这个路径`
    assert.equal(resolveCwdFromPrompt(broken, projectCwd), projectCwd)
  })

  test('does NOT promote a direct ~/Library prompt (exists on disk)', () => {
    const home = homedir()
    const target = join(home, 'Library')
    if (!existsSync(target)) return // non-macOS skip
    // Site A would accept this because it isDirectory + existsSync; Site B
    // must reject via isAcceptablePromptCwd.
    const prompt = `切到 ${target} 工作`
    assert.equal(resolveCwdFromPrompt(prompt, projectCwd), projectCwd)
  })

  test('does NOT promote a direct ~/Documents prompt', () => {
    const home = homedir()
    const target = join(home, 'Documents')
    if (!existsSync(target)) return
    const prompt = `看 ${target}`
    assert.equal(resolveCwdFromPrompt(prompt, projectCwd), projectCwd)
  })

  test('still follows a real existing project-internal directory', () => {
    // Guard against over-filtering: a legitimate existing non-system dir
    // must still win as prompt-derived cwd.
    const realDir = mkdtempSync(join(tmpdir(), 'babel-o-real-'))
    try {
      const prompt = `查看 ${realDir} 这个目录的内容`
      assert.equal(resolveCwdFromPrompt(prompt, projectCwd), realDir)
    } finally {
      rmSync(realDir, { recursive: true, force: true })
    }
  })

  test('still follows a real file to its parent dir (parent not a system dir)', () => {
    const parentDir = mkdtempSync(join(tmpdir(), 'babel-o-file-'))
    const filePath = join(parentDir, 'README.md')
    mkdirSync(parentDir, { recursive: true })
    try {
      const prompt = `读 ${filePath}`
      assert.equal(resolveCwdFromPrompt(prompt, projectCwd), parentDir)
    } finally {
      rmSync(parentDir, { recursive: true, force: true })
    }
  })
})
