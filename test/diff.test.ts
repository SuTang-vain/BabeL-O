import { test } from 'node:test'
import assert from 'node:assert'
import { computeLcs } from '../src/cli/diffLcs.js'
import { renderDiff } from '../src/cli/diff.js'

test('computeLcs diff alignment', () => {
  const oldLines = ['line1', 'line2', 'line3']
  const newLines = ['line1', 'line2 modified', 'line3']

  const diff = computeLcs(oldLines, newLines)
  assert.equal(diff.length, 4)
  assert.deepEqual(diff[0], { type: 'common', text: 'line1' })
  assert.deepEqual(diff[1], { type: 'removed', text: 'line2' })
  assert.deepEqual(diff[2], { type: 'added', text: 'line2 modified' })
  assert.deepEqual(diff[3], { type: 'common', text: 'line3' })
})

test('computeLcs completely different lists', () => {
  const oldLines = ['aaa', 'bbb']
  const newLines = ['ccc', 'ddd']

  const diff = computeLcs(oldLines, newLines)
  // Reconstructing LCS: either aaa/bbb removed and ccc/ddd added
  assert.equal(diff.filter(d => d.type === 'common').length, 0)
  assert.equal(diff.filter(d => d.type === 'removed').length, 2)
  assert.equal(diff.filter(d => d.type === 'added').length, 2)
})

test('renderDiff output for Edit and Write', () => {
  const editInput = {
    path: 'test.ts',
    oldString: 'const a = 1\nconst b = 2',
    newString: 'const a = 1\nconst b = 3\nconst c = 4',
  }
  const editDiff = renderDiff('Edit', editInput)
  assert.ok(editDiff.includes('Diff for Edit in test.ts'))
  assert.ok(editDiff.includes('const a = 1'))
  assert.ok(editDiff.includes('const b = 2'))
  assert.ok(editDiff.includes('const b = 3'))
  assert.ok(editDiff.includes('const c = 4'))

  const writeInput = {
    path: 'test.ts',
    content: 'const a = 1\nconst b = 2',
  }
  const writeDiff = renderDiff('Write', writeInput)
  assert.ok(writeDiff.includes('Written File test.ts'))
  assert.ok(writeDiff.includes('const a = 1'))
  assert.ok(writeDiff.includes('const b = 2'))
})
