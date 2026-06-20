import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyBashRisk } from '../src/tools/builtin/bashClassifier.js'

/**
 * Focused unit tests for the Bash read-only risk classifier
 * (Phase A of docs/nexus/reference/go-tui-permission-policy-governance-plan.md).
 *
 * The classifier is a pure function over the command string — no IO, no
 * runtime dependencies — so these tests are intentionally lightweight and
 * cover the table-driven truth table rather than integration paths.
 */

function expectRead(command: string, opts: { ruleSubstring?: string } = {}): void {
  const result = classifyBashRisk(command)
  assert.equal(result.kind, 'read', `expected read, got ${JSON.stringify(result)} for: ${command}`)
  if (opts.ruleSubstring) {
    assert.ok(false, `read classification should not carry a rule, got: ${result.rule}`)
  }
}

function expectExecute(command: string, opts: { ruleSubstring?: string } = {}): void {
  const result = classifyBashRisk(command)
  assert.equal(
    result.kind,
    'execute',
    `expected execute, got ${JSON.stringify(result)} for: ${command}`,
  )
  if (opts.ruleSubstring) {
    assert.ok(
      result.rule?.includes(opts.ruleSubstring),
      `expected rule to include ${JSON.stringify(opts.ruleSubstring)}, got ${JSON.stringify(result.rule)}`,
    )
  }
}

test('classifyBashRisk auto-allows git read-only subcommands', () => {
  expectRead('git status')
  expectRead('git status --short')
  expectRead('git log -5')
  expectRead('git log --oneline -10')
  expectRead('git diff')
  expectRead('git diff HEAD~1')
  expectRead('git show HEAD')
  expectRead('git remote -v')
  expectRead('git rev-parse --short HEAD')
  expectRead('git ls-files')
  expectRead('git tag --list')
})

test('classifyBashRisk denies git write/mutating subcommands', () => {
  expectExecute('git push', { ruleSubstring: 'git-push-denied-subcommand' })
  expectExecute('git commit -m "x"', { ruleSubstring: 'git-commit-denied-subcommand' })
  expectExecute('git checkout main', { ruleSubstring: 'git-checkout-denied-subcommand' })
  expectExecute('git reset --hard', { ruleSubstring: 'git-reset-denied-subcommand' })
  expectExecute('git clean -fd', { ruleSubstring: 'git-clean-denied-subcommand' })
  expectExecute('git rebase main', { ruleSubstring: 'git-rebase-denied-subcommand' })
  expectExecute('git merge feature', { ruleSubstring: 'git-merge-denied-subcommand' })
  expectExecute('git stash drop', { ruleSubstring: 'git-stash-denied-subcommand' })
  expectExecute('git branch -D feature', { ruleSubstring: 'git-branch-not-allowlisted' })
  expectExecute('git branch --list', { ruleSubstring: 'git-branch-not-allowlisted' })
  expectExecute('git fetch origin', { ruleSubstring: 'git-fetch-denied-subcommand' })
  expectExecute('git pull', { ruleSubstring: 'git-pull-denied-subcommand' })
  expectExecute('git clone https://example.com/repo', { ruleSubstring: 'git-clone-denied-subcommand' })
})

test('classifyBashRisk auto-allows pure read-only filesystem inspection', () => {
  expectRead('ls')
  expectRead('ls -la')
  expectRead('ls -la /tmp')
  expectRead('cat foo.txt')
  expectRead('cat /etc/hostname')
  expectRead('head -n 20 README.md')
  expectRead('tail -f /var/log/system.log')
  expectRead('wc -l foo.txt')
  expectRead('file foo.txt')
  expectRead('stat foo.txt')
  expectRead('readlink /usr/bin/python3')
  expectRead('realpath ./relative')
  expectRead('pwd')
  expectRead('echo hello')
  expectRead('whoami')
  expectRead('hostname')
  expectRead('date')
  expectRead('uname -a')
  expectRead('env | head')
  expectRead('printenv PATH')
  expectRead('ps aux')
  expectRead('top -l 1 -n 0')
  expectRead('uptime')
})

test('classifyBashRisk auto-allows find restricted to -type f', () => {
  expectRead('find . -type f')
  expectRead('find . -type f -name "*.ts"')
  expectRead('find /tmp -type f -mtime -1')
})

test('classifyBashRisk denies find without -type f or with action flags', () => {
  expectExecute('find .', { ruleSubstring: 'find-requires-type-f' })
  expectExecute('find . -type d', { ruleSubstring: 'find-type-d-not-allowlisted' })
  expectExecute('find . -type f -exec rm {} \\;', { ruleSubstring: 'find-exec-denied' })
  expectExecute('find . -type f -delete', { ruleSubstring: 'find-delete-denied' })
  expectExecute('find . -type f -fprint /tmp/x', { ruleSubstring: 'find-fprint-denied' })
  expectExecute('find . -type f -ok rm {} \\;', { ruleSubstring: 'find-ok-denied' })
})

test('classifyBashRisk auto-allows narrow read-only source inspection commands', () => {
  expectRead("sed -n '2200,2650p' /Users/tangyaoyue/DEV/BABEL/BabeL-O/clients/go-tui/internal/tui/tui.go")
  expectRead("sed -n '2200,2650p' /Users/tangyaoyue/DEV/BABEL/BabeL-O/clients/go-tui/internal/tui/tui.go | head -c 30000")
  expectRead('grep -n "permission_request\\|streamEvent" /Users/tangyaoyue/DEV/BABEL/BabeL-O/clients/go-tui/internal/tui/tui.go | head -80')
  expectRead('grep -nE "Test[A-Z][a-zA-Z_]+" /Users/tangyaoyue/DEV/BABEL/BabeL-O/clients/go-tui/internal/tui/tui_test.go')
})

test('classifyBashRisk keeps mutating or broad source inspection variants gated', () => {
  expectExecute("sed -i 's/a/b/' file.go", { ruleSubstring: 'sed-in-place-denied' })
  expectExecute("sed -n '1,20p' file.go > out.txt", { ruleSubstring: 'output-redirect' })
  expectExecute("sed -n '1,20p' file.go | sh", { ruleSubstring: 'pipe-to-shell' })
  expectExecute('grep -r needle .', { ruleSubstring: 'grep-flag-r-not-allowlisted' })
  expectExecute('grep needle *.ts', { ruleSubstring: 'grep-glob-path-not-allowlisted' })
})

test('classifyBashRisk escalates command chains and pipes to shell', () => {
  // When a chained command contains a specifically dangerous name (rm,
  // curl, etc.), the more specific rule wins. Plain chains without a
  // dangerous name fall through to the chain pattern.
  expectExecute('git status; rm -rf /', { ruleSubstring: 'rm-anywhere' })
  expectExecute('git status && echo "done"', { ruleSubstring: 'chained-and' })
  expectExecute('git status || true', { ruleSubstring: 'chained-or' })
  expectExecute('echo "x" ; echo "y"', { ruleSubstring: 'chained-semicolon' })
  expectExecute('cat foo.txt | sh', { ruleSubstring: 'pipe-to-shell' })
  expectExecute('cat foo.txt | bash', { ruleSubstring: 'pipe-to-shell' })
  expectExecute('cat foo.txt | python3', { ruleSubstring: 'pipe-to-shell' })
  expectExecute('cat foo.txt | perl', { ruleSubstring: 'pipe-to-shell' })
})

test('classifyBashRisk escalates command substitution and redirects', () => {
  expectExecute('git status $(rm -rf /)', { ruleSubstring: 'command-substitution-dollar-paren' })
  expectExecute('git status `rm -rf /`', { ruleSubstring: 'command-substitution-backtick' })
  expectExecute('cat foo.txt > /etc/passwd', { ruleSubstring: 'output-redirect' })
  expectExecute('cat foo.txt >> /tmp/log', { ruleSubstring: 'output-append-redirect' })
  expectExecute('cat foo.txt < /etc/shadow', { ruleSubstring: 'input-redirect' })
})

test('classifyBashRisk escalates dangerous command names anywhere in the body', () => {
  expectExecute('git status; rm /tmp/foo', { ruleSubstring: 'rm-anywhere' })
  expectExecute('echo hello && curl http://evil', { ruleSubstring: 'curl-anywhere' })
  expectExecute('echo hello && sudo apt install', { ruleSubstring: 'sudo-anywhere' })
  expectExecute('echo hello && chmod 777 /', { ruleSubstring: 'chmod-anywhere' })
  expectExecute('ls && dd if=/dev/zero of=/dev/sda', { ruleSubstring: 'dd-anywhere' })
  expectExecute('echo hello && shutdown -h now', { ruleSubstring: 'shutdown-anywhere' })
  expectExecute('ls && npm install lodash', { ruleSubstring: 'npm-install' })
  expectExecute('ls && yarn add react', { ruleSubstring: 'yarn-install' })
  expectExecute('ls && pip install requests', { ruleSubstring: 'pip-install' })
  expectExecute('ls && apt install nginx', { ruleSubstring: 'apt-install' })
})

test('classifyBashRisk denies unknown / non-allowlisted commands', () => {
  expectExecute('unzip foo.zip', { ruleSubstring: 'command:unzip-not-allowlisted' })
  expectExecute('python3 script.py', { ruleSubstring: 'command:python3-not-allowlisted' })
  expectExecute('make build', { ruleSubstring: 'command:make-not-allowlisted' })
  expectExecute('node index.js', { ruleSubstring: 'command:node-not-allowlisted' })
})

test('classifyBashRisk denies empty / whitespace-only commands', () => {
  expectExecute('', { ruleSubstring: 'empty-command' })
  expectExecute('   ', { ruleSubstring: 'empty-command' })
  expectExecute('\n\t', { ruleSubstring: 'empty-command' })
})

test('classifyBashRisk tokenizes quoted arguments correctly', () => {
  // Quoted strings are single tokens, so "git" with subcommand "log" inside
  // quotes still parses correctly. The allowlist check uses token-level
  // matching, not string-level.
  expectRead('git log "two words" --oneline')
  // Quote-aware fix (2026-06-21): `;` inside double-quoted segments
  // is no longer treated as a shell operator. Real e2e session
  // session_ea4f1793 caught this — sqlite3 with embedded `;` in SQL
  // was being misclassified as `chained-semicolon`.
  expectRead('git log "x; y" --oneline')
})

test('classifyBashRisk: dangerous patterns OUTSIDE quotes still fire', () => {
  // Same `;` operator but in the unquoted part of the command.
  expectExecute('echo hi; echo bye', { ruleSubstring: 'chained-semicolon' })
  // Same `>` redirect but in the unquoted part.
  expectExecute('echo hi > /tmp/out', { ruleSubstring: 'output-redirect' })
  // Same `||` chain but in the unquoted part (real session_ea4f1793
  // had this on the second attempt: the `||` chain to echo fallback).
  expectExecute('cat /etc/foo 2>/dev/null || echo fallback', { ruleSubstring: 'output-redirect' })
  // Real session_ea4f1793 sqlite3 command had `;` inside SQL string
  // + `2>/dev/null` + `||` outside. The dangerous-pattern layer
  // (DANGEROUS_PATTERNS) lists `rm-anywhere` / `chained-semicolon` /
  // `output-redirect` / `chained-or` in that source order — the first
  // match wins, and since `2>/dev/null` redirect appears before
  // `||` in this command, output-redirect fires first.
  expectExecute('sqlite3 foo.db "SELECT * FROM t WHERE c = \'a;b\'" 2>/dev/null || echo fallback', { ruleSubstring: 'output-redirect' })
})

test('classifyBashRisk: dangerous patterns inside quotes do NOT fire', () => {
  // Single-quoted SQL literal with embedded `;`
  expectExecute('sqlite3 foo.db "SELECT * FROM t WHERE c = \'a;b\'"', { ruleSubstring: 'command:sqlite3-not-allowlisted' })
  // Double-quoted echo argument with embedded `>`
  expectRead('echo "x > y"')
  // Double-quoted echo with embedded `|` (was a false-negative coincidence)
  expectRead('echo "a | b"')
})

test('classifyBashRisk preserves original command string for audit', () => {
  const result = classifyBashRisk('git status --short')
  assert.equal(result.command, 'git status --short')
  const execute = classifyBashRisk('rm -rf /')
  assert.equal(execute.kind, 'execute')
  assert.equal(execute.command, 'rm -rf /')
})
