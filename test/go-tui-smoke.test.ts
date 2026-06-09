import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * Phase 1 + Phase 7 Go TUI smoke harness.
 *
 * Gated by BABEL_O_RUN_GO_TUI_SMOKE=1 so it is opt-in for CI and does
 * not require a Go toolchain in the default test path. The full plan
 * lives in docs/nexus/reference/go-tui-rewrite-plan.md and
 * docs/nexus/active/TODO_tui.md.
 *
 * The Python driver:
 *   1. Spawns a temp Nexus on a free port (local/coding-runtime,
 *      ephemeral SQLite, allowed-tools='*').
 *   2. Spawns `bbl go --url <nexus> --no-alt --cwd <tmp> --session
 *      session_go_tui_smoke_<pid>` via PTY.
 *   3. Drives the requested --sequence end-to-end (see SEQUENCES in
 *      go_tui_pty_driver.py for the full list) and prints
 *      `[go-tui-smoke] OK: <ok_message>` on success.
 *   4. Tears the Nexus subprocess down on exit.
 *
 * Sequences (Phase 7 = full regression harness):
 *   - permission-approve       Phase 1: Bash prompt → approve → done
 *   - phase3-overlay-mutex     Phase 3: help + permission mutex, stray
 *                              keys do not leak into textinput
 *   - slash-palette            Phase 4: `/` live-filter → run /help
 *   - slash-palette-prefix     Phase 4: `/bash` inserts prefix into
 *                              textinput instead of running
 *   - tool-palette             Phase 4: /tools static catalog header
 *   - help-overlay             Phase 3/4: ? opens help, Esc closes
 *   - tombstone-rejection      Phase 7 §5 path C phase 3 polish:
 *                              /profile ghost → friendly "unknown
 *                              profile" hint
 *   - visual-regression-narrow Phase 7: COLUMNS=40 / LINES=20,
 *                              banner + help overlay wrap cleanly
 *   - all                      Phase 7 orchestrator: runs every
 *                              sequence in one PTY session with
 *                              inter-sequence reset (Esc + backspace
 *                              stream)
 *
 * This file is NOT wired into the default `npm test` target. Run it
 * with `npm run test:go-tui:smoke` (or directly with
 * BABEL_O_RUN_GO_TUI_SMOKE=1 set).
 */

const repoRoot = path.resolve(import.meta.dirname, '..')
const driver = path.join(repoRoot, 'test', 'go_tui_pty_driver.py')
const shouldRun = process.env.BABEL_O_RUN_GO_TUI_SMOKE === '1'
const python = process.env.PYTHON ?? 'python3'
const prebuilt = path.join(repoRoot, 'clients', 'go-tui', 'go-tui')

const skipReason = !shouldRun
  ? 'Set BABEL_O_RUN_GO_TUI_SMOKE=1 to run Go TUI smoke.'
  : !existsSync(driver)
  ? 'go_tui_pty_driver.py not found'
  : !existsSync(prebuilt)
  ? 'prebuilt clients/go-tui/go-tui binary missing; the smoke requires the local Go toolchain as a separate concern (see Phase 8 packaging).'
  : undefined

const OK_LINE = (sequence: string) =>
  new RegExp(`\\[go-tui-smoke\\] OK: .*${sequence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)

function runGoTuiSmoke(sequence: string, timeoutSeconds = 60): string {
  const result = spawnSync(
    python,
    [driver, '--sequence', sequence, '--timeout', String(timeoutSeconds)],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        BABEL_O_RUN_GO_TUI_SMOKE: '1',
        NO_COLOR: '1',
      },
      timeout: (timeoutSeconds + 15) * 1000,
    },
  )
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  assert.equal(
    result.status,
    0,
    `go-tui smoke (sequence=${sequence}) exited non-zero\n${output}`,
  )
  return output
}

test('Go TUI smoke: permission approve chain drives Bash through Nexus', { skip: skipReason }, () => {
  const output = runGoTuiSmoke('permission-approve')
  assert.match(output, /permission approve chain verified end-to-end/)
})

test('Go TUI smoke: phase 3 help overlay opens and closes', { skip: skipReason }, () => {
  const output = runGoTuiSmoke('help-overlay')
  assert.match(output, /phase 3 help overlay open\/close verified/)
})

test('Go TUI smoke: phase 3 overlay mutex (help + permission + stray keys)', { skip: skipReason }, () => {
  const output = runGoTuiSmoke('phase3-overlay-mutex')
  assert.match(output, /phase 3 single-input-owner overlay mutex verified/)
})

test('Go TUI smoke: phase 4 slash palette live-filter', { skip: skipReason }, () => {
  const output = runGoTuiSmoke('slash-palette')
  assert.match(output, /phase 4 slash palette live-filter verified/)
})

test('Go TUI smoke: phase 4 slash palette prefix insertion', { skip: skipReason }, () => {
  const output = runGoTuiSmoke('slash-palette-prefix')
  assert.match(output, /phase 4 slash palette prefix insertion verified/)
})

test('Go TUI smoke: phase 4 tool palette', { skip: skipReason }, () => {
  const output = runGoTuiSmoke('tool-palette')
  assert.match(output, /phase 4 tool palette verified/)
})

test('Go TUI smoke: phase 7 §5 path C phase 3 friendly profile-rejection', { skip: skipReason }, () => {
  const output = runGoTuiSmoke('tombstone-rejection')
  assert.match(output, /phase 7 .* friendly profile-rejection verified/)
})

test('Go TUI smoke: §5 path C phase 3 polish profile y/n overlay', { skip: skipReason }, () => {
  const output = runGoTuiSmoke('profile-confirm')
  assert.match(output, /profile y\/n overlay verified/)
})

test('Go TUI smoke: phase 5 /context + /compact wire to Nexus', { skip: skipReason }, () => {
  const output = runGoTuiSmoke('context-and-compact')
  assert.match(output, /phase 5 \/context and \/compact wire to Nexus verified/)
})

test('Go TUI smoke: phase 5 续 /context full contextOverlay', { skip: skipReason }, () => {
  const output = runGoTuiSmoke('context-overlay')
  assert.match(output, /phase 5 续 \/context full contextOverlay verified/)
})

test('Go TUI smoke: phase 6 /inbox overlay + footer unread indicator', { skip: skipReason }, () => {
  const output = runGoTuiSmoke('inbox-overlay')
  assert.match(output, /phase 6 inbox overlay \+ footer unread indicator verified/)
})

test('Go TUI smoke: phase 6 PR2 /inbox quote + auto-refresh', { skip: skipReason }, () => {
  const output = runGoTuiSmoke('inbox-quote', 90)
  assert.match(output, /phase 6 PR2 inbox quote \+ auto-refresh verified/)
})

test('Go TUI smoke: phase 6 PR3 /agents overlay + auto-refresh', { skip: skipReason }, () => {
  const output = runGoTuiSmoke('agent-status', 90)
  assert.match(output, /phase 6 PR3 agent status overlay verified/)
})

test('Go TUI smoke: phase 6 PR4 /tasks board overlay + auto-refresh', { skip: skipReason }, () => {
  const output = runGoTuiSmoke('task-board', 90)
  assert.match(output, /phase 6 PR4 task board overlay verified/)
})

test('Go TUI smoke: phase 6 PR5 /activity overlay', { skip: skipReason }, () => {
  const output = runGoTuiSmoke('activity-overlay', 90)
  assert.match(output, /phase 6 PR5 recent activity overlay verified/)
})

test('Go TUI smoke: phase 7 narrow-width visual regression', { skip: skipReason }, () => {
  const output = runGoTuiSmoke('visual-regression-narrow')
  assert.match(output, /phase 7 narrow-width visual regression verified/)
})

test('Go TUI smoke: phase 7 orchestrator runs all sequences end-to-end', { skip: skipReason }, () => {
  const output = runGoTuiSmoke('all', 300)
  assert.match(output, /all phase 7 sequences verified end-to-end/)
  // The orchestrator prints one "running" line per sequence — verify
  // the full set ran (so a regression in one of the individual
  // sequences would surface here, not only in its own test).
  for (const name of [
    'help-overlay',
    'slash-palette',
    'slash-palette-prefix',
    'tool-palette',
    'profile-confirm',
    'phase3-overlay-mutex',
    'permission-approve',
  ]) {
    assert.match(
      output,
      new RegExp(`\\[go-tui-smoke\\] all: running ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      `orchestrator did not run sequence ${name}`,
    )
  }
})
