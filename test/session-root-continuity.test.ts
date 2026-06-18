// test/session-root-continuity.test.ts
//
// Phase B unit tests for `deriveSessionRootContinuity`:
// 4 decision branches × multiple inputs, plus the regression cases
// from session_981cc5c2 + session_cf361f04. Real filesystem paths
// (/etc/hosts, /tmp, /Users) are reused so the test is honest about
// what exists on disk; cases that need an external "iCloud article"
// path are emulated with `/Users/test/...` because we cannot depend
// on a real iCloud path.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  deriveSessionRootContinuity,
  SESSION_ROOT_DECISIONS,
  SESSION_ROOT_REASONS,
  buildSessionRootContinuityMessage,
} from '../src/runtime/sessionRootContinuity.js'

describe('deriveSessionRootContinuity — vocabulary', () => {
  test('SESSION_ROOT_DECISIONS covers all 4 branches', () => {
    assert.equal(SESSION_ROOT_DECISIONS.length, 4)
    assert.ok(SESSION_ROOT_DECISIONS.includes('keep_request_cwd'))
    assert.ok(SESSION_ROOT_DECISIONS.includes('use_prompt_path'))
    assert.ok(SESSION_ROOT_DECISIONS.includes('keep_session_root'))
    assert.ok(SESSION_ROOT_DECISIONS.includes('require_confirmation'))
  })

  test('SESSION_ROOT_REASONS covers all 9 reasons', () => {
    assert.equal(SESSION_ROOT_REASONS.length, 9)
  })
})

describe('deriveSessionRootContinuity — keep_request_cwd', () => {
  test('CJK prose path (session_981cc5c2) → keep_request_cwd / cjk_prose_excluded', () => {
    const projectCwd = '/Users/test/DEV/BABEL/BabeL-O'
    const r = deriveSessionRootContinuity({
      requestCwd: projectCwd,
      prompt: '查看有无咱们刚刚聊到的上下文管理优化的相关文档/信息',
    })
    assert.equal(r.decision, 'keep_request_cwd')
    assert.equal(r.reason, 'cjk_prose_excluded')
    assert.equal(r.resolvedCwd, projectCwd)
    assert.equal(r.wasProjectRootKept, true)
    assert.equal(r.isExternalRoot, false)
    assert.equal(r.promptPathCandidates.length, 0)
  })

  test('URL-heavy prompt (session_cf361f04) → keep_request_cwd / url_excluded', () => {
    const projectCwd = '/Users/test/DEV/BABEL/BabeL-O'
    const prompt = '阅读 https://www.openrath.com/agent-architecture 此外 https://docs.openrath.com/spec/loop'
    const r = deriveSessionRootContinuity({ requestCwd: projectCwd, prompt })
    assert.equal(r.decision, 'keep_request_cwd')
    assert.equal(r.reason, 'url_excluded')
    assert.equal(r.resolvedCwd, projectCwd)
    assert.equal(r.wasProjectRootKept, true)
  })

  test('empty prompt → keep_request_cwd / no_paths_in_prompt', () => {
    const r = deriveSessionRootContinuity({ requestCwd: '/tmp', prompt: '' })
    assert.equal(r.decision, 'keep_request_cwd')
    assert.equal(r.reason, 'no_paths_in_prompt')
    assert.equal(r.resolvedCwd, '/tmp')
  })

  test('CJK + em-dash prose → keep_request_cwd / cjk_prose_excluded', () => {
    const r = deriveSessionRootContinuity({
      requestCwd: '/tmp',
      prompt: '阅读 /目录——一条编号递进的学习阶梯 这条规则',
    })
    assert.equal(r.decision, 'keep_request_cwd')
    assert.equal(r.reason, 'cjk_prose_excluded')
  })
})

describe('deriveSessionRootContinuity — use_prompt_path (internal)', () => {
  test('real path inside project → use_prompt_path / prompt_internal_path_inferred', () => {
    // Use a synthetic project dir under tmpdir so the test does not
    // depend on macOS symlinks like /etc → /private/etc.
    const projectDir = mkdtempSync(join(tmpdir(), 'babel-o-src-'))
    const innerDir = join(projectDir, 'src')
    mkdirSync(innerDir, { recursive: true })
    try {
      const r = deriveSessionRootContinuity({
        requestCwd: projectDir,
        prompt: `看 ${innerDir} 下的文件`,
      })
      assert.equal(r.decision, 'use_prompt_path')
      assert.equal(r.reason, 'prompt_internal_path_inferred')
      assert.equal(r.resolvedCwd, innerDir)
      assert.equal(r.isExternalRoot, false)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  test('real file inside project → use_prompt_path with parent as resolved cwd', () => {
    // A file (not a directory) inside the project: cwd should switch to
    // the parent directory. This is the same behavior as
    // `resolveCwdFromPrompt` for file paths.
    const projectDir = mkdtempSync(join(tmpdir(), 'babel-o-file-'))
    const filePath = join(projectDir, 'README.md')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(filePath, 'hello')
    try {
      const r = deriveSessionRootContinuity({
        requestCwd: projectDir,
        prompt: `看 ${filePath} 这个文件`,
      })
      assert.equal(r.decision, 'use_prompt_path')
      assert.equal(r.reason, 'prompt_internal_path_inferred')
      assert.equal(r.resolvedCwd, projectDir)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })
})

describe('deriveSessionRootContinuity — keep_session_root', () => {
  test('external prompt path + storedSessionCwd → keep_session_root / stored_session_cwd_inherited', () => {
    // Use a synthetic external project dir under tmpdir.
    const projectDir = mkdtempSync(join(tmpdir(), 'babel-o-proj-'))
    const externalDir = mkdtempSync(join(tmpdir(), 'babel-o-ext-'))
    try {
      const r = deriveSessionRootContinuity({
        requestCwd: projectDir,
        prompt: `分析 ${externalDir} 这个目录`,
        storedSessionCwd: projectDir,
      })
      assert.equal(r.decision, 'keep_session_root')
      assert.equal(r.reason, 'stored_session_cwd_inherited')
      assert.equal(r.resolvedCwd, projectDir)
      assert.equal(r.isExternalRoot, true)
      assert.ok(r.warnings.length > 0)
      assert.match(r.warnings[0]!, /external path/i)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
      rmSync(externalDir, { recursive: true, force: true })
    }
  })

  test('external prompt path + latestTaskPrimaryRoot → keep_session_root / session_primary_root_inherited', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'babel-o-proj-'))
    const externalDir = mkdtempSync(join(tmpdir(), 'babel-o-ext-'))
    try {
      const r = deriveSessionRootContinuity({
        requestCwd: projectDir,
        prompt: `分析 ${externalDir}`,
        latestTaskPrimaryRoot: projectDir,
      })
      assert.equal(r.decision, 'keep_session_root')
      assert.equal(r.reason, 'session_primary_root_inherited')
      assert.equal(r.resolvedCwd, projectDir)
      assert.equal(r.isExternalRoot, true)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
      rmSync(externalDir, { recursive: true, force: true })
    }
  })

  test('latestTaskPrimaryRoot === requestCwd → keep_session_root with primary as inherited', () => {
    // When the primary root already matches the request cwd, the
    // inherited cwd is requestCwd. The external prompt path still
    // routes through the keep_session_root branch (because the caller
    // passed session context), with the primary root recorded as the
    // inherited cwd. From the CLI perspective this is "session root
    // matches the request, but we still record the external candidate
    // as a warning".
    const projectDir = mkdtempSync(join(tmpdir(), 'babel-o-proj-'))
    const externalDir = mkdtempSync(join(tmpdir(), 'babel-o-ext-'))
    const otherSessionDir = mkdtempSync(join(tmpdir(), 'babel-o-other-'))
    try {
      const r = deriveSessionRootContinuity({
        requestCwd: projectDir,
        prompt: `分析 ${externalDir}`,
        storedSessionCwd: otherSessionDir,
        latestTaskPrimaryRoot: projectDir,
      })
      assert.equal(r.decision, 'keep_session_root')
      assert.equal(r.reason, 'session_primary_root_inherited')
      assert.equal(r.resolvedCwd, projectDir)
      assert.equal(r.wasProjectRootKept, true)
      assert.ok(r.warnings.length > 0)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
      rmSync(externalDir, { recursive: true, force: true })
      rmSync(otherSessionDir, { recursive: true, force: true })
    }
  })

  test('latestTaskPrimaryRoot wins when both differ from requestCwd', () => {
    const requestDir = mkdtempSync(join(tmpdir(), 'babel-o-req-'))
    const primaryDir = mkdtempSync(join(tmpdir(), 'babel-o-pri-'))
    const externalDir = mkdtempSync(join(tmpdir(), 'babel-o-ext-'))
    const storedDir = mkdtempSync(join(tmpdir(), 'babel-o-sto-'))
    try {
      const r = deriveSessionRootContinuity({
        requestCwd: requestDir,
        prompt: `分析 ${externalDir}`,
        storedSessionCwd: storedDir,
        latestTaskPrimaryRoot: primaryDir,
      })
      assert.equal(r.decision, 'keep_session_root')
      assert.equal(r.reason, 'session_primary_root_inherited')
      assert.equal(r.resolvedCwd, primaryDir)
    } finally {
      rmSync(requestDir, { recursive: true, force: true })
      rmSync(primaryDir, { recursive: true, force: true })
      rmSync(externalDir, { recursive: true, force: true })
      rmSync(storedDir, { recursive: true, force: true })
    }
  })
})

describe('deriveSessionRootContinuity — require_confirmation (external, no session)', () => {
  test('external prompt path + no session context → require_confirmation', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'babel-o-proj-'))
    const externalDir = mkdtempSync(join(tmpdir(), 'babel-o-ext-'))
    try {
      const r = deriveSessionRootContinuity({
        requestCwd: projectDir,
        prompt: `分析 ${externalDir}`,
      })
      assert.equal(r.decision, 'require_confirmation')
      assert.equal(r.reason, 'prompt_external_path_inferred')
      assert.equal(r.resolvedCwd, projectDir, 'cwd kept at request cwd')
      assert.equal(r.isExternalRoot, true)
      assert.equal(r.wasProjectRootKept, true)
      assert.ok(r.warnings.length > 0)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
      rmSync(externalDir, { recursive: true, force: true })
    }
  })

  test('acceptExternalPromptPath=true → use_prompt_path / prompt_external_path_inferred', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'babel-o-proj-'))
    const externalDir = mkdtempSync(join(tmpdir(), 'babel-o-ext-'))
    try {
      const r = deriveSessionRootContinuity({
        requestCwd: projectDir,
        prompt: `分析 ${externalDir}`,
        acceptExternalPromptPath: true,
      })
      assert.equal(r.decision, 'use_prompt_path')
      assert.equal(r.reason, 'prompt_external_path_inferred')
      assert.equal(r.resolvedCwd, externalDir)
      assert.equal(r.isExternalRoot, true)
      assert.equal(r.wasProjectRootKept, false)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
      rmSync(externalDir, { recursive: true, force: true })
    }
  })
})

describe('deriveSessionRootContinuity — wasProjectRootKept semantic', () => {
  test('kept when resolvedCwd === requestCwd', () => {
    const r = deriveSessionRootContinuity({
      requestCwd: '/tmp',
      prompt: 'CJK 文档/信息',
    })
    assert.equal(r.wasProjectRootKept, true)
  })

  test('NOT kept when resolvedCwd differs from requestCwd', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'babel-o-proj-'))
    const externalDir = mkdtempSync(join(tmpdir(), 'babel-o-ext-'))
    try {
      const r = deriveSessionRootContinuity({
        requestCwd: projectDir,
        prompt: `分析 ${externalDir}`,
        acceptExternalPromptPath: true,
      })
      assert.equal(r.wasProjectRootKept, false)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
      rmSync(externalDir, { recursive: true, force: true })
    }
  })
})

describe('buildSessionRootContinuityMessage', () => {
  test('emits a non-empty human-readable summary for each decision', () => {
    const samples = [
      { decision: 'use_prompt_path' as const, isExternalRoot: false, resolvedCwd: '/etc', reason: 'prompt_internal_path_inferred' as const, requestCwd: '/etc', promptPathCandidates: [], wasProjectRootKept: true, warnings: [] },
      { decision: 'use_prompt_path' as const, isExternalRoot: true, resolvedCwd: '/tmp/x', reason: 'prompt_external_path_inferred' as const, requestCwd: '/tmp', promptPathCandidates: ['/tmp/x'], wasProjectRootKept: false, warnings: [] },
      { decision: 'keep_session_root' as const, isExternalRoot: true, resolvedCwd: '/proj', reason: 'stored_session_cwd_inherited' as const, requestCwd: '/proj', promptPathCandidates: ['/external'], wasProjectRootKept: true, warnings: [] },
      { decision: 'require_confirmation' as const, isExternalRoot: true, resolvedCwd: '/proj', reason: 'prompt_external_path_inferred' as const, requestCwd: '/proj', promptPathCandidates: ['/external'], wasProjectRootKept: true, warnings: [] },
      { decision: 'keep_request_cwd' as const, isExternalRoot: false, resolvedCwd: '/proj', reason: 'cjk_prose_excluded' as const, requestCwd: '/proj', promptPathCandidates: [], wasProjectRootKept: true, warnings: [] },
    ]
    for (const sample of samples) {
      const msg = buildSessionRootContinuityMessage(sample)
      assert.ok(msg.length > 0, `non-empty for ${sample.decision}`)
      assert.ok(msg.includes(sample.resolvedCwd), `mentions cwd for ${sample.decision}`)
    }
  })
})
