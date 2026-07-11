import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executeSchema } from '../src/nexus/executionPreparation.js'
import {
  formatThinkingLevelGuidance,
  parseThinkingLevel,
  resolveThinkingProfile,
} from '../src/runtime/thinkingLevel.js'

test('thinking levels resolve to bounded execution profiles', () => {
  assert.equal(parseThinkingLevel(' QUICK '), 'quick')
  assert.equal(parseThinkingLevel('balanced'), 'balanced')
  assert.equal(parseThinkingLevel('deep'), 'deep')
  assert.equal(parseThinkingLevel('maximum'), undefined)

  const quick = resolveThinkingProfile('quick')
  const balanced = resolveThinkingProfile('balanced')
  const deep = resolveThinkingProfile('deep')

  assert.equal(quick.maxLoops, 12)
  assert.equal(balanced.maxLoops, 25)
  assert.equal(deep.maxLoops, 40)
  assert.ok((quick.defaultThinkingBudget ?? 0) < (deep.defaultThinkingBudget ?? 0))
  assert.ok((quick.defaultMaxOutputTokens ?? 0) < (deep.defaultMaxOutputTokens ?? 0))
})

test('thinking level guidance preserves safety and scope boundaries', () => {
  const guidance = formatThinkingLevelGuidance('deep')
  assert.match(guidance, /Investigate deliberately/)
  assert.match(guidance, /Do not mention the selected level/)
  assert.match(guidance, /Safety, permissions, task scope, and evidence requirements remain unchanged/)
})

test('balanced profile preserves the legacy runtime loop limit', () => {
  const balanced = resolveThinkingProfile()
  assert.equal(balanced.level, 'balanced')
  assert.equal(balanced.maxLoops, 25)
  assert.equal(balanced.defaultThinkingBudget, undefined)
  assert.equal(balanced.defaultMaxOutputTokens, undefined)
})

test('execute schema accepts only supported thinking levels', () => {
  const valid = executeSchema.safeParse({
    prompt: 'review the implementation',
    thinkingLevel: 'deep',
  })
  assert.equal(valid.success, true)

  const invalid = executeSchema.safeParse({
    prompt: 'review the implementation',
    thinkingLevel: 'maximum',
  })
  assert.equal(invalid.success, false)
})
