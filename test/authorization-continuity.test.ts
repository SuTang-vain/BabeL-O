import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  isContinuationPhrase,
  isLocalChangeAuthorizationRequest,
  normalizeGuidancePolicy,
  deriveDefaultAuthorizationLevel,
  type UserIntentGuidance,
} from '../src/runtime/intentGuidance.js'

/**
 * Phase 0 — Authorization Continuity Baseline Tests
 *
 * Evidence session: session_1de7cf54-3e73-4a1e-9e36-94e48b0fd661
 * Problem: Turn 6 "继续任务" reset authorization from local_change to inspect
 *
 * These tests define the expected behavior for continuation phrases
 * and authorization inheritance.
 */

describe('Authorization Continuity — Phase 0 Baseline', () => {
  // ============================================================================
  // Test 1: Continuation phrase detection
  // ============================================================================

  describe('isContinuationPhrase()', () => {
    it('should recognize "继续任务" as continuation phrase', () => {
      assert.strictEqual(isContinuationPhrase('继续任务'), true)
    })

    it('should recognize "继续推进" as continuation phrase', () => {
      assert.strictEqual(isContinuationPhrase('继续推进'), true)
    })

    it('should recognize "继续" as continuation phrase', () => {
      assert.strictEqual(isContinuationPhrase('继续'), true)
    })

    it('should recognize "continue" (English) as continuation phrase', () => {
      assert.strictEqual(isContinuationPhrase('continue'), true)
    })

    it('should recognize "keep going" as continuation phrase', () => {
      assert.strictEqual(isContinuationPhrase('keep going'), true)
    })

    it('should NOT recognize "开始新任务" as continuation phrase', () => {
      assert.strictEqual(isContinuationPhrase('开始新任务'), false)
    })

    it('should NOT recognize "查看当前状态" as continuation phrase', () => {
      assert.strictEqual(isContinuationPhrase('查看当前状态'), false)
    })

    it('should NOT recognize empty string as continuation phrase', () => {
      assert.strictEqual(isContinuationPhrase(''), false)
    })

    it('should handle whitespace normalization', () => {
      assert.strictEqual(isContinuationPhrase('  继续任务  '), true)
    })
  })

  // ============================================================================
  // Test 2: Extended authorization verbs
  // ============================================================================

  describe('isLocalChangeAuthorizationRequest() — extended verbs', () => {
    it('should recognize "修复这个问题" as local change request', () => {
      assert.strictEqual(isLocalChangeAuthorizationRequest('修复这个问题'), true)
    })

    it('should recognize "进入可写模式" as local change request', () => {
      assert.strictEqual(isLocalChangeAuthorizationRequest('进入可写模式'), true)
    })

    it('should recognize "执行刚才的方案" as local change request', () => {
      assert.strictEqual(isLocalChangeAuthorizationRequest('执行刚才的方案'), true)
    })

    it('should recognize "就这样改" as local change request', () => {
      assert.strictEqual(isLocalChangeAuthorizationRequest('就这样改'), true)
    })

    it('should recognize "按这个提交" as local change request', () => {
      assert.strictEqual(isLocalChangeAuthorizationRequest('按这个提交'), true)
    })

    it('should recognize "继续任务并修改" as local change request', () => {
      // Combination of continuation + action verb
      assert.strictEqual(isLocalChangeAuthorizationRequest('继续任务并修改'), true)
    })

    // Existing patterns should still work
    it('should recognize existing pattern "开始推进架构优化"', () => {
      assert.strictEqual(isLocalChangeAuthorizationRequest('开始推进架构优化'), true)
    })

    it('should recognize existing pattern "根据规划开始推进"', () => {
      assert.strictEqual(isLocalChangeAuthorizationRequest('根据规划开始推进'), true)
    })
  })

  // ============================================================================
  // Test 3: Authorization inheritance through normalizeGuidancePolicy
  // ============================================================================

  describe('normalizeGuidancePolicy() — continuation inheritance', () => {
    const createMockGuidance = (
      text: string,
      overrides: Partial<UserIntentGuidance> = {}
    ): UserIntentGuidance => ({
      intent: 'continue',
      confidence: 0.66,
      continuity: 0.8,
      contextScope: 'full',
      actionHint: 'normal',
      requiresTools: true,
      problemTarget: 'unknown',
      reason: 'Test guidance',
      latestUserText: text,
      explicitPaths: [],
      source: 'model',
      ...overrides,
    })

    it('should NOT force respond_only for "继续任务" when model set requiresTools=true', () => {
      const guidance = createMockGuidance('继续任务', {
        requiresTools: true,
        authorization: {
          level: 'local_change', // Model inferred from context
          consentScope: 'stated_plan',
          source: 'explicit_user',
          selectionKind: 'none',
          reason: 'Inherited from previous turn',
          allowedActionSummary: 'Perform local edits',
          blockedActionSummary: 'No remote operations',
        },
      })

      const normalized = normalizeGuidancePolicy(guidance)

      // Should preserve the authorization from model
      assert.strictEqual(normalized.authorization?.level, 'local_change')
      assert.strictEqual(normalized.requiresTools, true)
      assert.notStrictEqual(normalized.actionHint, 'respond_only')
    })

    it('should preserve inspect for "继续任务" when no prior authorization', () => {
      const guidance = createMockGuidance('继续任务', {
        authorization: {
          level: 'inspect', // No prior authorization to inherit
          consentScope: 'current_step',
          source: 'inferred_none',
          selectionKind: 'none',
          reason: 'No prior authorization context',
          allowedActionSummary: 'Read-only inspection',
          blockedActionSummary: 'No writes',
        },
      })

      const normalized = normalizeGuidancePolicy(guidance)

      // Should keep inspect (cannot upgrade without explicit authorization)
      assert.strictEqual(normalized.authorization?.level, 'inspect')
    })

    it('should recognize "进入可写模式并开始修复" as local_change', () => {
      const guidance = createMockGuidance('进入可写模式并开始修复')

      const normalized = normalizeGuidancePolicy(guidance)

      // The normalizeGuidancePolicy should upgrade to local_change
      // because isLocalChangeAuthorizationRequest matches
      assert.strictEqual(normalized.authorization?.level, 'local_change')
      assert.strictEqual(normalized.authorization?.source, 'explicit_user')
    })
  })

  // ============================================================================
  // Test 4: deriveDefaultAuthorizationLevel with extended verbs
  // ============================================================================

  describe('deriveDefaultAuthorizationLevel() — extended verbs', () => {
    const createOptions = (text: string) => ({
      intent: 'continue' as const,
      actionHint: 'normal' as const,
      requiresTools: true,
      latestUserText: text,
    })

    it('should return local_change for "修复这个问题"', () => {
      const level = deriveDefaultAuthorizationLevel(createOptions('修复这个问题'))
      assert.strictEqual(level, 'local_change')
    })

    it('should return local_change for "进入可写模式"', () => {
      const level = deriveDefaultAuthorizationLevel(createOptions('进入可写模式'))
      assert.strictEqual(level, 'local_change')
    })

    it('should return local_change for "执行刚才的方案"', () => {
      const level = deriveDefaultAuthorizationLevel(createOptions('执行刚才的方案'))
      assert.strictEqual(level, 'local_change')
    })

    it('should return inspect for "查看当前状态"', () => {
      const level = deriveDefaultAuthorizationLevel(createOptions('查看当前状态'))
      assert.strictEqual(level, 'inspect')
    })

    it('should return inspect for "分析这个问题"', () => {
      const level = deriveDefaultAuthorizationLevel(createOptions('分析这个问题'))
      assert.strictEqual(level, 'inspect')
    })
  })

  // ============================================================================
  // Test 5: Preference selection edge cases (intake-conservatism-analysis §3.2)
  // ============================================================================

  describe('normalizeGuidancePolicy() — preference selection edge cases', () => {
    const createMockGuidance = (
      text: string,
      overrides: Partial<UserIntentGuidance> = {}
    ): UserIntentGuidance => ({
      intent: 'continue',
      confidence: 0.66,
      continuity: 0.8,
      contextScope: 'full',
      actionHint: 'normal',
      requiresTools: true,
      problemTarget: 'unknown',
      reason: 'Test guidance',
      latestUserText: text,
      explicitPaths: [],
      source: 'model',
      ...overrides,
    })

    it('should keep none for "light" (single word preference)', () => {
      const guidance = createMockGuidance('light', {
        requiresTools: false,
        authorization: {
          level: 'none',
          consentScope: 'current_step',
          source: 'inferred_none',
          selectionKind: 'preference',
          reason: 'Theme preference',
          allowedActionSummary: 'No tool execution',
          blockedActionSummary: 'All tools blocked',
        },
      })
      const normalized = normalizeGuidancePolicy(guidance)
      // Single word theme name is a preference selection
      assert.strictEqual(normalized.authorization?.level, 'none')
      assert.strictEqual(normalized.authorization?.selectionKind, 'preference')
    })

    it('should upgrade to local_change for "就用第一个方案" (plan + execution cue)', () => {
      const guidance = createMockGuidance('就用第一个方案', { requiresTools: true })
      const normalized = normalizeGuidancePolicy(guidance)
      // "方案" + "就" = execution authorization cue
      assert.strictEqual(normalized.authorization?.level, 'local_change')
    })

    it('should keep none for "第三个" (pure option selection)', () => {
      const guidance = createMockGuidance('第三个', {
        requiresTools: false,
        authorization: {
          level: 'none',
          consentScope: 'current_step',
          source: 'inferred_none',
          selectionKind: 'option',
          reason: 'Option selection',
          allowedActionSummary: 'No tool execution',
          blockedActionSummary: 'All tools blocked',
        },
      })
      const normalized = normalizeGuidancePolicy(guidance)
      assert.strictEqual(normalized.authorization?.level, 'none')
      assert.strictEqual(normalized.authorization?.selectionKind, 'option')
    })

    it('should keep none for "选第二个吧" (pure option selection)', () => {
      const guidance = createMockGuidance('选第二个吧', {
        requiresTools: false,
        authorization: {
          level: 'none',
          consentScope: 'current_step',
          source: 'inferred_none',
          selectionKind: 'option',
          reason: 'Option selection',
          allowedActionSummary: 'No tool execution',
          blockedActionSummary: 'All tools blocked',
        },
      })
      const normalized = normalizeGuidancePolicy(guidance)
      assert.strictEqual(normalized.authorization?.level, 'none')
      assert.strictEqual(normalized.authorization?.selectionKind, 'option')
    })
  })

  // ============================================================================
  // Test 6: Meta behavior question edge cases (intake-conservatism-analysis §3.3)
  // ============================================================================

  describe('deriveDefaultAuthorizationLevel() — meta behavior question', () => {
    const createOptions = (text: string) => ({
      intent: 'continue' as const,
      actionHint: 'normal' as const,
      requiresTools: true,
      latestUserText: text,
    })

    it('should return none for "为什么你修改了这个文件" (meta question)', () => {
      // This is a meta-behavior question asking WHY, not an execution request
      const level = deriveDefaultAuthorizationLevel(createOptions('为什么你修改了这个文件'))
      assert.strictEqual(level, 'none')
    })

    it('should return none for "why did you edit that file" (meta question)', () => {
      const level = deriveDefaultAuthorizationLevel(createOptions('why did you edit that file'))
      assert.strictEqual(level, 'none')
    })

    it('should return local_change for "修改这个文件" (execution request)', () => {
      // This is a direct execution request, NOT a meta question
      const level = deriveDefaultAuthorizationLevel(createOptions('修改这个文件'))
      assert.strictEqual(level, 'local_change')
    })
  })

  // ============================================================================
  // Test 7: Correction prompts with action verbs (intake-conservatism-analysis §3.4)
  // ============================================================================

  describe('deriveDefaultAuthorizationLevel() — correction + action', () => {
    const createOptions = (text: string) => ({
      intent: 'continue' as const,
      actionHint: 'normal' as const,
      requiresTools: true,
      latestUserText: text,
    })

    it('should return local_change for "更改为更产品功能的版本" (change action)', () => {
      // "更改" + "版本" = local change request
      const level = deriveDefaultAuthorizationLevel(createOptions('更改为更产品功能的版本'))
      assert.strictEqual(level, 'local_change')
    })

    it('should return local_change for "改一下这个文件" (edit action)', () => {
      const level = deriveDefaultAuthorizationLevel(createOptions('改一下这个文件'))
      assert.strictEqual(level, 'local_change')
    })

    it('should return local_change for "让你修改这个配置" (directive + action)', () => {
      const level = deriveDefaultAuthorizationLevel(createOptions('让你修改这个配置'))
      assert.strictEqual(level, 'local_change')
    })
  })
})
