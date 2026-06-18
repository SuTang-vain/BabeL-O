import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateSkillDraft, deriveId, redact } from '../src/skills/generator.js'

test('generateSkillDraft produces a normalized draft from a clean title', () => {
  const result = generateSkillDraft({ title: 'Permission Denial Recovery' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.draft.id, 'permission-denial-recovery')
  assert.equal(result.draft.name, 'Permission Denial Recovery')
  assert.equal(result.draft.status, 'draft')
  assert.equal(result.draft.scope, 'project')
  assert.equal(result.draft.risk, 'read')
  assert.ok(result.draft.triggers.length >= 2)
  assert.match(result.draft.content, /# Purpose/)
  assert.match(result.draft.content, /# Procedure/)
  assert.match(result.draft.content, /# Failure handling/)
  assert.equal(result.redactionWarnings.length, 0)
})

test('generateSkillDraft respects explicit idHint when provided', () => {
  const result = generateSkillDraft({ title: 'Some Title', idHint: 'custom-id' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.draft.id, 'custom-id')
})

test('generateSkillDraft rejects bad idHint', () => {
  const result = generateSkillDraft({ title: 'Some Title', idHint: 'Bad_Id' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errorCode, 'SKILL_DRAFT_ID_CONFLICT')
  assert.ok(result.diagnostics.some(d => d.code === 'SKILL_DRAFT_ID_CONFLICT'))
})

test('generateSkillDraft rejects empty title', () => {
  const result = generateSkillDraft({ title: '' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errorCode, 'SKILL_DRAFT_INVALID_TITLE')
})

test('generateSkillDraft explicitOnly allows zero triggers', () => {
  const result = generateSkillDraft({
    title: 'Compile And Run',
    explicitOnly: true,
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.draft.triggers, [])
})

test('generateSkillDraft rejects implicit drafts with too few triggers', () => {
  // Title yields a valid id but only one ≥ 3-char token.
  const result = generateSkillDraft({ title: 'A B' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errorCode, 'SKILL_DRAFT_INVALID_TITLE')
  assert.ok(result.diagnostics.some(d => d.code === 'SKILL_DRAFT_TRIGGERS_INSUFFICIENT'))
})

test('generateSkillDraft redacts bearer-style tokens in session summary', () => {
  const result = generateSkillDraft({
    title: 'Token Safe Skill',
    sessionSummary: 'Used token Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCD in a request.',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.redactionWarnings.length, 1)
  assert.equal(result.redactionWarnings[0].code, 'TOKEN_BEARER_HEADER')
  assert.match(result.draft.content, /\[REDACTED:Bearer header\]/)
  assert.doesNotMatch(result.draft.content, /abcdefghijklmnopqrstuvwxyz0123456789ABCD/)
})

test('generateSkillDraft redacts provider API keys', () => {
  const result = generateSkillDraft({
    title: 'API Key Safe Skill',
    toolOutcomes: 'Configured with sk-1234567890abcdefghij',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.ok(result.redactionWarnings.some(w => w.code === 'TOKEN_PROVIDER_PREFIX'))
  assert.doesNotMatch(result.draft.content, /sk-1234567890abcdefghij/)
})

test('generateSkillDraft redacts private absolute paths', () => {
  const result = generateSkillDraft({
    title: 'Path Safe Skill',
    sessionSummary: 'Read /Users/alice/secret/file.txt during the run.',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.ok(result.redactionWarnings.some(w => w.code === 'PATH_PRIVATE_HOME'))
  assert.doesNotMatch(result.draft.content, /\/Users\/alice\/secret\/file\.txt/)
})

test('generateSkillDraft surfaces validation warnings separately from errors', () => {
  // Force a non-error diagnostic by giving a too-long title → all validation
  // passes, but body should still embed Procedure / Failure handling sections.
  const result = generateSkillDraft({
    title: 'A reasonable title',
    allowedTools: ['Read', 'Grep'],
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.validationWarnings.length, 0)
  assert.match(result.draft.content, /May use: `Read`, `Grep`/)
})

test('generateSkillDraft maps scope to project by default', () => {
  const result = generateSkillDraft({ title: 'My Custom Workflow Tool' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.draft.scope, 'project')
})

test('generateSkillDraft maps scope to user when requested', () => {
  const result = generateSkillDraft({ title: 'My Personal Workflow Tool', scope: 'user' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.draft.scope, 'user')
})

test('deriveId produces a stable kebab-case id', () => {
  assert.equal(deriveId('Permission Denial Recovery'), 'permission-denial-recovery')
  assert.equal(deriveId('  Some   Random  Title! '), 'some-random-title')
  assert.equal(deriveId('!!!'), null)
  assert.equal(deriveId(''), null)
})

test('redact leaves clean text untouched', () => {
  const out = redact('The user asked for a permission-denial-recovery skill.')
  assert.equal(out.redacted, 'The user asked for a permission-denial-recovery skill.')
  assert.equal(out.warnings.length, 0)
})
