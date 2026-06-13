import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSystemPromptSections,
  sectionsToPromptText,
  extractAbsolutePaths,
  normalizeWrappedPathFragments,
} from '../src/runtime/systemPromptBuilder.js'

describe('buildSystemPromptSections', () => {
  test('produces 8 static (cacheable) sections', () => {
    const sections = buildSystemPromptSections({
      cwd: '/tmp/test',
      platform: 'darwin',
    })
    const staticSections = sections.filter(s => s.cacheable)
    assert.ok(staticSections.length === 8, `Expected 8 static sections, got ${staticSections.length}`)
    const staticIds = staticSections.map(s => s.id)
    assert.deepEqual(staticIds, [
      'identity', 'system_rules', 'context_facts', 'task_guidelines',
      'tool_usage', 'risky_actions', 'tone_style', 'output_efficiency',
    ])
  })

  test('env_info is always present and not cacheable', () => {
    const sections = buildSystemPromptSections({
      cwd: '/tmp/test',
      platform: 'linux',
    })
    const envSection = sections.find(s => s.id === 'env_info')
    assert.ok(envSection)
    assert.equal(envSection!.cacheable, false)
    assert.ok(envSection!.content.includes('/tmp/test'))
    assert.ok(envSection!.content.includes('linux'))
  })

  test('does not include user request in any section', () => {
    const sections = buildSystemPromptSections({
      cwd: '/tmp/test',
      platform: 'darwin',
      prompt: 'Read the file /etc/hosts',
    })
    for (const section of sections) {
      assert.ok(
        !section.content.includes('Current user request:'),
        `Section ${section.id} contains user request marker`,
      )
    }
  })

  test('request_paths appears when prompt has absolute paths', () => {
    const sections = buildSystemPromptSections({
      cwd: '/tmp/test',
      platform: 'darwin',
      prompt: 'Read /etc/hosts and show its content',
    })
    const pathSection = sections.find(s => s.id === 'request_paths')
    assert.ok(pathSection, 'Expected request_paths section')
    assert.equal(pathSection!.cacheable, false)
  })

  test('focus block appears when prompt has no absolute paths and cwd is not home', () => {
    const sections = buildSystemPromptSections({
      cwd: '/tmp/test',
      platform: 'darwin',
      prompt: 'list all typescript files',
    })
    const focusSection = sections.find(s => s.id === 'focus')
    assert.ok(focusSection, 'Expected focus section')
    assert.ok(focusSection!.content.includes('/tmp/test'))
  })

  test('memory section appears when projectMemory is provided', () => {
    const sections = buildSystemPromptSections({
      cwd: '/tmp/test',
      platform: 'darwin',
      projectMemory: 'This project uses pnpm.',
    })
    const memSection = sections.find(s => s.id === 'memory')
    assert.ok(memSection)
    assert.ok(memSection!.content.includes('This project uses pnpm.'))
  })

  test('summary section appears when sessionSummary is provided', () => {
    const sections = buildSystemPromptSections({
      cwd: '/tmp/test',
      platform: 'darwin',
      sessionSummary: 'User was editing main.ts',
    })
    const sumSection = sections.find(s => s.id === 'summary')
    assert.ok(sumSection)
    assert.ok(sumSection!.content.includes('User was editing main.ts'))
  })

  test('skills section appears when activeSkills is provided', () => {
    const sections = buildSystemPromptSections({
      cwd: '/tmp/test',
      platform: 'darwin',
      activeSkills: 'Skill: test-skill (id: test)',
    })
    const skillSection = sections.find(s => s.id === 'skills')
    assert.ok(skillSection)
    assert.ok(skillSection!.content.includes('test-skill'))
  })

  test('language section appears when language is provided', () => {
    const sections = buildSystemPromptSections({
      cwd: '/tmp/test',
      platform: 'darwin',
      language: 'Chinese',
    })
    const langSection = sections.find(s => s.id === 'language')
    assert.ok(langSection)
    assert.ok(langSection!.content.includes('Chinese'))
  })

  test('working_set section appears when workingSet is provided', () => {
    const sections = buildSystemPromptSections({
      cwd: '/tmp/test',
      platform: 'darwin',
      workingSet: 'Working Set:\n- /tmp/test/src/a.ts (file, touches=2, lastTurn=1, source=tool)',
    })
    const workingSetSection = sections.find(s => s.id === 'working_set')
    assert.ok(workingSetSection)
    assert.equal(workingSetSection!.cacheable, false)
    assert.ok(workingSetSection!.content.includes('/tmp/test/src/a.ts'))
  })

  test('system_rules contains latest instruction priority rule', () => {
    const sections = buildSystemPromptSections({
      cwd: '/tmp/test',
      platform: 'darwin',
    })
    const rules = sections.find(s => s.id === 'system_rules')
    assert.ok(rules)
    assert.ok(rules!.content.includes('Latest instruction priority'))
    assert.ok(rules!.content.includes('immediately stop the previous task'))
  })

  test('context_facts prohibits ungrounded context percentages', () => {
    const sections = buildSystemPromptSections({
      cwd: '/tmp/test',
      platform: 'darwin',
    })
    const facts = sections.find(s => s.id === 'context_facts')
    assert.ok(facts)
    assert.equal(facts!.cacheable, true)
    assert.ok(facts!.content.includes('Context usage numbers are runtime facts'))
    assert.ok(facts!.content.includes('Do not estimate, invent, or narrate context percentages'))
    assert.ok(facts!.content.includes('context_usage'))
    assert.ok(facts!.content.includes('context_warning'))
    assert.ok(facts!.content.includes('context_blocking'))
    assert.ok(facts!.content.includes('上下文已 X%'))
    assert.ok(facts!.content.includes('Compact summaries are indexes/recovery hints'))
    assert.ok(facts!.content.includes('context_grounding_required'))
    assert.ok(facts!.content.includes('workspace_dirty_detected'))
  })

  test('task_guidelines contains action vs analysis guidance', () => {
    const sections = buildSystemPromptSections({
      cwd: '/tmp/test',
      platform: 'darwin',
    })
    const guidelines = sections.find(s => s.id === 'task_guidelines')
    assert.ok(guidelines)
    assert.ok(guidelines!.content.includes('Action vs analysis'))
    assert.ok(guidelines!.content.includes('Action requests'))
    assert.ok(guidelines!.content.includes('Analysis requests'))
    assert.ok(!guidelines!.content.includes('启动'), 'Should not contain Chinese keywords')
    assert.ok(guidelines!.content.includes('Do NOT run the project'))
  })

  test('tool_usage contains action command guidance', () => {
    const sections = buildSystemPromptSections({
      cwd: '/tmp/test',
      platform: 'darwin',
    })
    const tools = sections.find(s => s.id === 'tool_usage')
    assert.ok(tools)
    assert.ok(tools!.content.includes('run, start, test, build, or execute'))
  })

  test('all sections have unique ids', () => {
    const sections = buildSystemPromptSections({
      cwd: '/tmp/test',
      platform: 'darwin',
      projectMemory: 'memory',
      sessionSummary: 'summary',
      activeSkills: 'skills',
      language: 'English',
      prompt: '/tmp/test/a.txt',
    })
    const ids = sections.map(s => s.id)
    assert.equal(new Set(ids).size, ids.length, 'Duplicate section ids found')
  })

  test('keeps cacheable immutable prefix before volatile sections', () => {
    const sections = buildSystemPromptSections({
      cwd: '/tmp/test',
      platform: 'darwin',
      userIntentGuidance: 'User Intake Guidance: continue',
      workingSet: 'Working Set:\n- /tmp/test/src/a.ts',
      gitStatus: 'Git Status: clean',
      projectMemory: 'memory',
      sessionSummary: 'summary',
      activeSkills: 'skills',
      language: 'English',
      prompt: '/tmp/test/a.txt',
    })
    const firstVolatileIndex = sections.findIndex(section => !section.cacheable)
    assert.ok(firstVolatileIndex > 0)
    assert.ok(sections.slice(0, firstVolatileIndex).every(section => section.cacheable))
    assert.ok(sections.slice(firstVolatileIndex).every(section => !section.cacheable))
  })

  test('defines Turn Policy as structured control data with evidence separation', () => {
    const sections = buildSystemPromptSections({
      cwd: '/tmp/test',
      platform: 'darwin',
    })
    const taskGuidelines = sections.find(section => section.id === 'task_guidelines')?.content ?? ''
    assert.match(taskGuidelines, /Turn Policy/)
    assert.match(taskGuidelines, /structured runtime control data/)
    assert.match(taskGuidelines, /verified observations, code-confirmed causes, and hypotheses distinct/)
  })
})

describe('sectionsToPromptText', () => {
  test('joins section contents with double newlines', () => {
    const sections = buildSystemPromptSections({
      cwd: '/tmp/test',
      platform: 'darwin',
    })
    const text = sectionsToPromptText(sections)
    assert.ok(text.length > 0)
    assert.ok(text.includes('BabeL-O'))
    assert.ok(text.includes('Tool Usage'))
    assert.ok(text.includes('/tmp/test'))
  })
})

describe('extractAbsolutePaths', () => {
  test('extracts absolute paths from text', () => {
    const paths = extractAbsolutePaths('Read /etc/hosts and /var/log/syslog')
    assert.ok(paths.length >= 2, `Expected at least 2 paths, got ${paths.length}`)
  })

  test('returns empty for text without paths', () => {
    const paths = extractAbsolutePaths('Hello world, no paths here')
    assert.equal(paths.length, 0)
  })

  test('normalizes terminal-wrapped hyphenated paths', () => {
    const text = [
      '请查看 /Users/example/repo/docs/nexus/reference/memory-capability',
      '  -awareness-and-trigger-plan.md 的状态',
    ].join('\n')

    assert.equal(
      normalizeWrappedPathFragments(text),
      '请查看 /Users/example/repo/docs/nexus/reference/memory-capability-awareness-and-trigger-plan.md 的状态',
    )
    assert.deepEqual(extractAbsolutePaths(text), [
      '/Users/example/repo/docs/nexus/reference/memory-capability-awareness-and-trigger-plan.md',
    ])
  })

  test('normalizes terminal-wrapped underscore paths without indentation', () => {
    const text = [
      'Read /tmp/project/docs/runtime',
      '_governance.md now',
    ].join('\n')

    assert.deepEqual(extractAbsolutePaths(text), [
      '/tmp/project/docs/runtime_governance.md',
    ])
  })

  test('does not normalize ordinary prose bullet paragraphs', () => {
    const text = [
      'Review /tmp/project/docs/runtime',
      '- this bullet is a separate sentence, not a path suffix',
    ].join('\n')

    assert.equal(normalizeWrappedPathFragments(text), text)
    assert.deepEqual(extractAbsolutePaths(text), ['/tmp/project/docs/runtime'])
  })
})
