import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..')
const driver = path.join(repoRoot, 'test', 'tui_pty_driver.py')
const shouldRun = process.env.BABEL_O_RUN_PTY_SMOKE === '1'

function stripAnsi(text: string) {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\r/g, '')
}

function runPtySmoke(sequence: string) {
  const python = process.env.PYTHON ?? 'python3'
  const result = spawnSync(python, [driver, '--sequence', sequence, '--timeout', '10'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      NO_COLOR: '1',
    },
    timeout: 20_000,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  assert.equal(result.status, 0, output)
  return stripAnsi(output)
}

test('PTY smoke: chat stays open while idle', { skip: !shouldRun || !existsSync(driver) }, () => {
  const output = runPtySmoke('idle-stays-open')
  assert.match(output, /BABEL-O/)
  assert.match(output, /\? for shortcuts/)
  assert.doesNotMatch(output, /chat exited while idle/)
})

test('PTY smoke: chat dev renders dev title', { skip: !shouldRun || !existsSync(driver) }, () => {
  const output = runPtySmoke('dev-title')
  assert.match(output, /❖ BABEL-O\s+dev/)
  assert.doesNotMatch(output, /❖ BABEL-O\s+v\d+\.\d+\.\d+/)
})

test('PTY smoke: slash palette opens and exits cleanly', { skip: !shouldRun || !existsSync(driver) }, () => {
  const output = runPtySmoke('slash-palette')
  assert.match(output, /Insert bash prompt prefix/)
  assert.match(output, /BABEL-O/)
  assert.match(output, /\? for shortcuts/)
})

test('PTY smoke: slash palette narrow terminal redraws without residue', { skip: !shouldRun || !existsSync(driver) }, () => {
  const output = runPtySmoke('slash-palette-narrow')
  assert.match(output, /Insert grep prompt prefix/)
  assert.match(output, /MiniMax M3|Embedded Local/)
})

test('PTY smoke: keyboard routing keeps a single input owner across overlays', { skip: !shouldRun || !existsSync(driver) }, () => {
  const output = runPtySmoke('unique-input-keyboard-routing')
  assert.match(output, /Insert bash prompt prefix/)
  assert.match(output, /AgentLoop sub-agent TUI smoke completed/)
  assert.match(output, /当前用户生产的作品可能会在实际上线后发现批量化的问题/)
  assert.match(output, /BabeL-O local runtime is active\./)
  assert.match(output, /approval/)
  assert.match(output, /Permission denied/)
  assert.doesNotMatch(output, /Permission approved/)
  assert.equal((output.match(/BabeL-O local runtime is active\./g) ?? []).length, 1)
})

test('PTY smoke: tool picker and model wizard keep one input owner', { skip: !shouldRun || !existsSync(driver) }, () => {
  const output = runPtySmoke('tool-model-overlay-routing')
  assert.match(output, /Read a file inside the workspace/)
  assert.match(output, /Select provider:/)
  assert.match(output, /Wizard cancelled\./)
  assert.match(output, /\? for shortcuts/)
})

test('PTY smoke: permission panel escape rejects without approval', { skip: !shouldRun || !existsSync(driver) }, () => {
  const output = runPtySmoke('permission-reject-escape')
  assert.match(output, /approval/)
  assert.match(output, /Permission denied/)
  assert.doesNotMatch(output, /Permission approved/)
})

test('PTY smoke: permission panel backspace rejects without approval', { skip: !shouldRun || !existsSync(driver) }, () => {
  const output = runPtySmoke('permission-reject-backspace')
  assert.match(output, /approval/)
  assert.match(output, /Permission denied/)
  assert.doesNotMatch(output, /Permission approved/)
})

test('PTY smoke: permission panel numeric approve once completes command', { skip: !shouldRun || !existsSync(driver) }, () => {
  const output = runPtySmoke('permission-approve-once')
  assert.match(output, /approval/)
  assert.match(output, /Bash\(node -v\)/)
  assert.doesNotMatch(output, /Permission approved/)
})

test('PTY smoke: permission panel session approval caches the tool rule', { skip: !shouldRun || !existsSync(driver) }, () => {
  const output = runPtySmoke('permission-approve-session')
  assert.match(output, /Bash\(node -v\)/)
  assert.match(output, /Bash\(node -p 1\)/)
})

test('PTY smoke: permission panel editable rule path completes command', { skip: !shouldRun || !existsSync(driver) }, () => {
  const output = runPtySmoke('permission-editable-rule')
  assert.match(output, /Enter allow rule prefix/)
  assert.match(output, /Bash\(node -v\)/)
})

test('PTY smoke: permission panel reject with instruction renders reason', { skip: !shouldRun || !existsSync(driver) }, () => {
  const output = runPtySmoke('permission-reject-instruction')
  assert.match(output, /Tell the model what to do instead/)
  assert.match(output, /Permission denied: Use Read instead/)
})

test('PTY smoke: compact read tool rendering hides raw state', { skip: !shouldRun || !existsSync(driver) }, () => {
  const output = runPtySmoke('tool-rendering-read')
  assert.match(output, /Read\(package\.json\)/)
  assert.doesNotMatch(output, /\(ctrl\+o to expand\)/)
  assert.doesNotMatch(output, /maxBytes/)
  assert.doesNotMatch(output, /running/)
})

test('PTY smoke: compact bash output preview folds long output', { skip: !shouldRun || !existsSync(driver) }, () => {
  const output = runPtySmoke('bash-output-preview')
  assert.match(output, /Bash\(for i in 0 1 2 3 4; do echo line-\$i; done\)/)
  assert.match(output, /⎿  line-0/)
  assert.match(output, /⎿  line-2/)
  assert.doesNotMatch(output, /⎿  line-3/)
  assert.doesNotMatch(output, /⎿  line-4/)
  assert.match(output, /… \+2 lines \(ctrl\+o to expand\)/)
})

test('PTY smoke: AgentLoop sub-agent hierarchy renders from TUI command', { skip: !shouldRun || !existsSync(driver) }, () => {
  const output = runPtySmoke('agentloop-subagent-smoke')
  assert.match(output, /task blocked/)
  assert.match(output, /subtasks delegated/)
  assert.match(output, /subagent started/)
  assert.match(output, /subagent completed/)
  assert.match(output, /Parent blocked by delegated sub-agent/)
  assert.match(output, /Child implementation via sub-agent/)
  assert.match(output, /depth=1/)
  assert.match(output, /parentTaskId=1/)
  assert.match(output, /parent #1/)
  assert.match(output, /transcript=nexus:\/\/sessions\/session_[A-Za-z0-9_-]+-sub-2\/events/)
  assert.match(output, /✓ AgentLoop sub-agent TUI smoke completed/)
})

test('PTY smoke: live waiting status renders while a prompt is running', { skip: !shouldRun || !existsSync(driver) }, () => {
  const output = runPtySmoke('live-waiting-status')
  assert.match(output, /Working\.\.\./)
  assert.match(output, /Generating\.\.\./)
  assert.match(output, /Read\(package\.json\)/)
})

test('PTY smoke: agent running indicator clears after done and failed tools', { skip: !shouldRun || !existsSync(driver) }, () => {
  const output = runPtySmoke('agent-running-terminal-states')
  assert.match(output, /Waiting for permission\.\.\./)
  assert.match(output, /Bash\(node -v\)/)
  assert.match(output, /Bash\(node -e process\.exit\(7\)\) failed/)
  assert.match(output, /Bash failed\./)
})

test('PTY smoke: compact command renders progress without internal details', { skip: !shouldRun || !existsSync(driver) }, () => {
  const output = runPtySmoke('compact-progress')
  assert.match(output, /Compacting conversation\.\.\./)
  assert.match(output, /✓ Context compacted/)
  assert.doesNotMatch(output, /Compacted session/)
  assert.doesNotMatch(output, /summaryChars/)
})

test('PTY smoke: context command renders visual usage panel', { skip: !shouldRun || !existsSync(driver) }, () => {
  const output = runPtySmoke('context-visualization')
  assert.match(output, /BABEL Context/)
  assert.match(output, /current context/)
  assert.match(output, /Current context by source/)
  assert.match(output, /System prompt/)
  assert.match(output, /System tools/)
  assert.match(output, /Skills · \/skills/)
  assert.match(output, /Autocompact buffer/)
  assert.match(output, /Free space/)
})

test('PTY smoke: input placeholder clears on typing and blank enter does not submit', { skip: !shouldRun || !existsSync(driver) }, () => {
  const output = runPtySmoke('input-placeholder')
  assert.match(output, /什么我可以帮你的吗？/)
  assert.doesNotMatch(output, /什么我可以帮你的吗？edit, \/ for commands/)
  assert.equal((output.match(/BabeL-O local runtime is active\./g) ?? []).length, 1)
})

test('PTY smoke: Shift+Enter inserts multiline input before submit', { skip: !shouldRun || !existsSync(driver) }, () => {
  const output = runPtySmoke('shift-enter-multiline-input')
  assert.match(output, /第一行业务场景/)
  assert.match(output, /第二行风险分层/)
  assert.equal((output.match(/BabeL-O local runtime is active\./g) ?? []).length, 1)
})

test('PTY smoke: multiline paste renders placeholder and expands on submit', { skip: !shouldRun || !existsSync(driver) }, () => {
  const output = runPtySmoke('multiline-paste-placeholder')
  assert.match(output, /\[Pasted text #1 \+3 lines\] analyze/)
  assert.match(output, /beta/)
  assert.doesNotMatch(output, /Multiline Paste Buffer/)
})

test('PTY smoke: ask coding question about files reads and answers', { skip: !shouldRun || !existsSync(driver) }, () => {
  const output = runPtySmoke('coding-question-files')
  assert.match(output, /What does question\.txt say\?/)
  assert.match(output, /Read\(question\.txt\)/)
  assert.match(output, /violet-river/)
})

test('PTY smoke: task status and update render in TUI', { skip: !shouldRun || !existsSync(driver) }, () => {
  const output = runPtySmoke('task-update-status')
  assert.match(output, /TaskCreate\(Verify task update smoke\)/)
  assert.match(output, /Verify task update smoke/)
  assert.match(output, /pending Verify task update smoke/)
  assert.match(output, /task updated/)
  assert.match(output, /Task updated:/)
  assert.match(output, /completed Verify task update smoke/)
})

test('PTY smoke: programming workflow covers read edit diff grep glob and task', { skip: !shouldRun || !existsSync(driver) }, () => {
  const output = runPtySmoke('programming-workflow')
  assert.match(output, /Read\(smoke\.txt\)/)
  assert.match(output, /Edit\(smoke\.txt\)/)
  assert.match(output, /Diff for Edit in smoke\.txt/)
  assert.match(output, /\+ gamma/)
  assert.match(output, /Grep\(gamma\)/)
  assert.match(output, /smoke\.txt:1:alpha gamma/)
  assert.match(output, /Glob\(\*\*\/\*\.ts\)/)
  assert.match(output, /src\/smoke\.ts/)
  assert.match(output, /TaskCreate\(Verify smoke workflow\)/)
})

test('PTY smoke: resume session redraws previous tool history', { skip: !shouldRun || !existsSync(driver) }, () => {
  const output = runPtySmoke('resume-session')
  assert.match(output, /session session_/)
  assert.match(output, /resume session_/)
  assert.match(output, /Read\(smoke\.txt\)/)
  assert.doesNotMatch(output, /ctrl\+o to expand tool details/)
})
