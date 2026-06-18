import { test } from 'node:test'
import assert from 'node:assert'
import { normalizeSkill, normalizeSkills } from '../src/skills/normalizer.js'
import { validateSkill } from '../src/skills/validator.js'
import { formatSkill } from '../src/skills/formatter.js'
import type { RawSkill } from '../src/skills/schema.js'

test('normalizeSkill fills legacy defaults from minimal raw skill', () => {
  const raw: RawSkill = {
    id: 'minimal',
    name: 'Minimal',
    triggers: ['min'],
    priority: 0,
    content: 'body',
  }
  const out = normalizeSkill(raw, 'project')
  assert.strictEqual(out.id, 'minimal')
  assert.strictEqual(out.name, 'Minimal')
  assert.strictEqual(out.description, 'Minimal') // defaults to name
  assert.strictEqual(out.version, 1)
  assert.strictEqual(out.status, 'active')
  assert.strictEqual(out.source, 'project')
  assert.strictEqual(out.scope, 'project')
  assert.strictEqual(out.risk, 'read')
  assert.deepStrictEqual(out.allowedTools, [])
  assert.deepStrictEqual(out.triggers, ['min'])
})

test('normalizeSkill preserves explicit front-matter fields', () => {
  const raw: RawSkill = {
    id: 'babel-o-permission-denial-recovery',
    name: 'BabeL-O Permission Denial Recovery',
    description: 'Recover from denied tool calls.',
    version: 1,
    status: 'active',
    scope: 'project',
    triggers: ['permission denial', 'soft-deny'],
    priority: 80,
    risk: 'read',
    allowedTools: ['Read', 'Grep', 'Glob'],
    content: '# Procedure\n...',
  }
  const out = normalizeSkill(raw, 'project')
  assert.strictEqual(out.description, 'Recover from denied tool calls.')
  assert.strictEqual(out.risk, 'read')
  assert.deepStrictEqual(out.allowedTools, ['Read', 'Grep', 'Glob'])
  assert.strictEqual(out.source, 'project')
})

test('normalizeSkill resolves source as builtin / user / project', () => {
  const raw: RawSkill = { id: 'x', name: 'X', triggers: ['x'], priority: 0, content: '' }
  assert.strictEqual(normalizeSkill(raw, 'builtin').source, 'builtin')
  assert.strictEqual(normalizeSkill(raw, 'user').source, 'user')
  assert.strictEqual(normalizeSkill(raw, 'project').source, 'project')
})

test('normalizeSkills filters out raw skills with empty id', () => {
  const raws: RawSkill[] = [
    { id: 'a', name: 'A', triggers: ['a'], priority: 0, content: 'A' },
    { id: '', name: 'B', triggers: ['b'], priority: 0, content: 'B' },
    { id: 'c', name: 'C', triggers: ['c'], priority: 0, content: 'C' },
  ]
  const out = normalizeSkills(raws, 'project')
  assert.strictEqual(out.length, 2)
  assert.deepStrictEqual(out.map(s => s.id), ['a', 'c'])
})

test('validateSkill reports SKILL_ID_MISSING when id is empty', () => {
  const r = validateSkill({ id: '', name: 'n', triggers: ['t'], priority: 0, content: 'c' })
  assert.strictEqual(r.ok, false)
  const codes = r.diagnostics.map(d => d.code)
  assert.ok(codes.includes('SKILL_ID_MISSING'))
})

test('validateSkill reports SKILL_ID_INVALID for non-kebab-case id', () => {
  const r = validateSkill({ id: 'Bad_Id', name: 'n', triggers: ['t'], priority: 0, content: 'c' })
  assert.strictEqual(r.ok, false)
  const codes = r.diagnostics.map(d => d.code)
  assert.ok(codes.includes('SKILL_ID_INVALID'))
  assert.ok(codes.includes('SKILL_TRIGGERS_EMPTY') === false)
})

test('validateSkill rejects empty triggers and empty body', () => {
  const r = validateSkill({ id: 'ok', name: 'n', triggers: [], priority: 0, content: '' })
  assert.strictEqual(r.ok, false)
  const codes = r.diagnostics.map(d => d.code)
  assert.ok(codes.includes('SKILL_TRIGGERS_EMPTY'))
  assert.ok(codes.includes('SKILL_BODY_EMPTY'))
})

test('validateSkill allows empty triggers when status is draft or disabled', () => {
  const draftResult = validateSkill({
    id: 'ok',
    name: 'n',
    triggers: [],
    priority: 0,
    content: 'body',
    status: 'draft',
  })
  assert.strictEqual(draftResult.ok, true)

  const disabledResult = validateSkill({
    id: 'ok',
    name: 'n',
    triggers: [],
    priority: 0,
    content: 'body',
    status: 'disabled',
  })
  assert.strictEqual(disabledResult.ok, true)
})

test('validateSkill rejects invalid status / risk / allowedTools', () => {
  const r = validateSkill({
    id: 'ok',
    name: 'n',
    triggers: ['t'],
    priority: 0,
    content: 'c',
    status: 'weird',
    risk: 'r00t',
    allowedTools: 'Read' as unknown as string[],
  })
  assert.strictEqual(r.ok, false)
  const codes = r.diagnostics.map(d => d.code)
  assert.ok(codes.includes('SKILL_STATUS_INVALID'))
  assert.ok(codes.includes('SKILL_RISK_INVALID'))
  assert.ok(codes.includes('SKILL_ALLOWED_TOOLS_NOT_ARRAY'))
})

test('validateSkill ok=true on a valid legacy skill', () => {
  const r = validateSkill({
    id: 'coding',
    name: 'Coding',
    triggers: ['code'],
    priority: 5,
    content: 'coding guidelines',
  })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.diagnostics.length, 0)
  assert.ok(r.normalized)
  assert.strictEqual(r.normalized?.id, 'coding')
})

test('formatSkill emits canonical front matter and preserves body', () => {
  const raw: RawSkill = {
    id: 'coding',
    name: 'Coding',
    triggers: ['code', 'class'],
    priority: 5,
    content: '# Procedure\n1. Read file\n2. Edit',
  }
  const normalized = normalizeSkill(raw, 'builtin')
  const md = formatSkill(normalized)
  assert.match(md, /^---\n/)
  assert.match(md, /id: coding/)
  assert.match(md, /name: Coding/)
  assert.match(md, /version: 1/)
  assert.match(md, /status: active/)
  assert.match(md, /source: builtin/)
  assert.match(md, /scope: builtin/)
  assert.match(md, /triggers:\n {2}- code\n {2}- class/)
  assert.match(md, /priority: 5/)
  assert.match(md, /risk: read/)
  assert.match(md, /# Procedure\n1\. Read file\n2\. Edit/)
})

test('formatSkill quotes values containing reserved YAML characters', () => {
  const raw: RawSkill = {
    id: 'pn-deny',
    name: 'Permission: denial recovery',
    description: 'Has "quoted" text and : colons.',
    triggers: ['permission denial'],
    priority: 80,
    content: 'body',
  }
  const normalized = normalizeSkill(raw, 'project')
  const md = formatSkill(normalized)
  // description must be quoted because of the embedded double quotes / colon
  assert.match(md, /description: "Has \\"quoted\\" text and : colons\."/)
})
