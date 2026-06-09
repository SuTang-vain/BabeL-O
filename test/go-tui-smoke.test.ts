import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * Phase 1 Go TUI smoke harness.
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
 *   3. Types a Bash prompt, waits for the permission panel, approves,
 *      and verifies the Bash tool result and the result event.
 *   4. Tears the Nexus subprocess down on exit.
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

function runGoTuiSmoke() {
  const result = spawnSync(
    python,
    [driver, '--sequence', 'permission-approve', '--timeout', '45'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        BABEL_O_RUN_GO_TUI_SMOKE: '1',
        NO_COLOR: '1',
      },
      timeout: 60_000,
    },
  )
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  assert.equal(result.status, 0, `go-tui smoke exited non-zero\n${output}`)
  return output
}

test('Go TUI smoke: permission approve chain drives Bash through Nexus', { skip: skipReason }, () => {
  const output = runGoTuiSmoke()
  assert.match(output, /\[go-tui-smoke\] OK: permission approve chain verified end-to-end/)
})
