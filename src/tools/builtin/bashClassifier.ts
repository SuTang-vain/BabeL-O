// Bash command risk classifier for the read-only auto-allow path
// (Phase A of docs/nexus/reference/go-tui-permission-policy-governance-plan.md).
//
// The Bash tool always advertises `risk: 'execute'` to keep its identity in
// audit logs and the transcript. The runtime, however, needs a *per-input*
// risk signal so that read-only subcommands (e.g. `git status`, `ls -la`,
// `cat foo.txt`, `find . -type f`) can skip the policy hard-deny and the
// approval gate, while write/execute patterns (`rm -rf`, `git commit`,
// `find -exec rm {} \;`, command chains, redirects, pipes to shell) remain
// gated.
//
// This module is intentionally a pure function over the command string: it
// does NOT touch the filesystem, does NOT consult any other tool, and has
// no Node-specific dependencies. The dangerous-pattern layer is the second
// line of defence: a `git status` whose command body chains into
// `rm -rf /` is escalated back to execute by the regex sweep.

export type BashRiskKind = 'read' | 'execute'

export type BashRiskClassification = {
  kind: BashRiskKind
  /**
   * Short, human-readable reason for the classification. Used in tool
   * trace metadata and policy/approval diagnostics. Undefined when the
   * read-only allowlist matches and no dangerous pattern is present.
   */
  rule?: string
  /**
   * Original command string. Returned verbatim so callers can attach it
   * to `tool_started.effectiveRisk` for audit.
   */
  command: string
}

/**
 * Read-only subcommand allowlist. An empty Set means "the command has no
 * subcommand; any usage is read-only" (e.g. `ls`, `cat`, `pwd`).
 *
 * The first token of the Bash command must match a key here for the
 * classifier to consider it read-only. Subcommand-level restrictions
 * (e.g. `git status` allowed but `git push` denied) are encoded by the
 * non-empty Set.
 */
const BASH_READ_ONLY_COMMANDS: Record<string, Set<string> | null> = {
  // VCS inspection
  git: new Set([
    'status',
    'log',
    'diff',
    'show',
    // 'branch' is intentionally NOT in the read allowlist because
    // `git branch -D` is destructive — we'd rather force a permission
    // ask than have to model every branch flag.
    'remote',
    'rev-parse',
    'ls-files',
    'tag',
    'branch',
  ]),
  // Pure read-only filesystem inspection
  ls: new Set(),
  cat: new Set(),
  head: new Set(),
  tail: new Set(),
  wc: new Set(),
  file: new Set(),
  stat: new Set(),
  readlink: new Set(),
  realpath: new Set(),
  // Identity / env snapshots
  pwd: new Set(),
  echo: new Set(),
  whoami: new Set(),
  hostname: new Set(),
  date: new Set(),
  uname: new Set(),
  env: new Set(),
  printenv: new Set(),
  // Process / system inspection (no mutation)
  ps: new Set(),
  top: new Set(),
  uptime: new Set(),
  // find is special-cased below
}

/**
 * Subcommand deny-list. If a subcommand appears here, the classifier
 * escalates to `execute` even if the parent command is in the allowlist.
 * This blocks e.g. `git push` even though `git` is allowlisted.
 */
const BASH_DENIED_SUBCOMMANDS: Record<string, Set<string>> = {
  git: new Set([
    'push',
    'commit',
    'checkout',
    'switch',
    'reset',
    'clean',
    'rebase',
    'merge',
    'cherry-pick',
    'revert',
    'stash',
    'apply',
    'am',
    'init',
    'clone',
    'fetch',
    'pull',
    'mv',
    'rm',
    'add',
  ]),
  ps: new Set([]), // ps has no dangerous subcommands; reserved for future
  top: new Set([]),
  // ls, cat, head, tail, wc, file, stat have no dangerous subcommands.
}

const FIND_REQUIRED_FLAGS = ['-type', 'f']
const FIND_DENIED_FLAGS = [
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-delete',
  '-fprint',
  '-fprintf',
  '-fls',
  '-print0',
]

const SAFE_GREP_FLAGS = new Set([
  '--line-number',
  '--extended-regexp',
  '--fixed-strings',
  '--ignore-case',
  '--binary-files=without-match',
])
const SAFE_SED_FLAGS = new Set(['-n', '--quiet', '--silent'])
const SAFE_GIT_BRANCH_FLAGS = new Set([
  '--show-current',
  '--list',
  '--all',
  '--remotes',
  '--verbose',
  '--color',
  '--no-color',
  '--format',
  '-a',
  '-r',
  '-v',
  '-vv',
])
const DENIED_GIT_BRANCH_FLAGS = new Set([
  '-d',
  '-D',
  '-m',
  '-M',
  '-c',
  '-C',
  '-f',
  '--delete',
  '--move',
  '--copy',
  '--force',
  '--set-upstream-to',
  '--unset-upstream',
  '--edit-description',
])

/**
 * Regex escalations applied to the *entire* command string. A match
 * forces `kind: 'execute'`. They are intentionally conservative:
 * chained commands, redirects, command substitution, pipe-to-shell, and
 * obviously dangerous command names are all treated as execute.
 */
const DANGEROUS_PATTERNS: { pattern: RegExp; rule: string }[] = [
  // More specific patterns must come BEFORE the broader ones they
  // overlap with — first match wins.
  { pattern: />>\s*\S/, rule: 'output-append-redirect' },
  { pattern: />\s*\S/, rule: 'output-redirect' },
  { pattern: /<\s*\S/, rule: 'input-redirect' },
  { pattern: /\|\s*(sh|bash|zsh|fish|ksh|ash|dash|python|python3|perl|ruby|node|php)\b/, rule: 'pipe-to-shell' },
  { pattern: /`[^`]*`/, rule: 'command-substitution-backtick' },
  { pattern: /\$\(/, rule: 'command-substitution-dollar-paren' },
  // Specific dangerous command names — listed before the chain
  // patterns so e.g. `echo && curl` reports `curl-anywhere` (more
  // informative) rather than `chained-and`.
  { pattern: /\brm\s+/, rule: 'rm-anywhere' },
  { pattern: /\bmv\s+/, rule: 'mv-anywhere' },
  { pattern: /\bcp\s+/, rule: 'cp-anywhere' },
  { pattern: /\bmkdir\s+/, rule: 'mkdir-anywhere' },
  { pattern: /\btouch\s+/, rule: 'touch-anywhere' },
  { pattern: /\bchmod\s+/, rule: 'chmod-anywhere' },
  { pattern: /\bchown\s+/, rule: 'chown-anywhere' },
  { pattern: /\bcurl\s+/, rule: 'curl-anywhere' },
  { pattern: /\bwget\s+/, rule: 'wget-anywhere' },
  { pattern: /\bdd\s+/, rule: 'dd-anywhere' },
  { pattern: /\bmkfs/, rule: 'mkfs-anywhere' },
  { pattern: /\bsudo\s+/, rule: 'sudo-anywhere' },
  { pattern: /\bsu\s+/, rule: 'su-anywhere' },
  { pattern: /\bkill\s+/, rule: 'kill-anywhere' },
  { pattern: /\bkillall\s+/, rule: 'killall-anywhere' },
  { pattern: /\bpkill\s+/, rule: 'pkill-anywhere' },
  { pattern: /\bshutdown\s+/, rule: 'shutdown-anywhere' },
  { pattern: /\breboot\s+/, rule: 'reboot-anywhere' },
  { pattern: /\bnpm\s+(install|uninstall|update|add|remove|i|rm)\b/, rule: 'npm-install' },
  { pattern: /\byarn\s+(add|remove|install)\b/, rule: 'yarn-install' },
  { pattern: /\bpnpm\s+(add|remove|install|i)\b/, rule: 'pnpm-install' },
  { pattern: /\bpip\s+(install|uninstall)\b/, rule: 'pip-install' },
  { pattern: /\bapt(-get)?\s+(install|remove|purge)\b/, rule: 'apt-install' },
  { pattern: /\bbrew\s+(install|uninstall)\b/, rule: 'brew-install' },
  { pattern: /\bsystemctl\s+(start|stop|restart|enable|disable)\b/, rule: 'systemctl' },
  { pattern: /\blaunchctl\s+(load|unload|start|stop)\b/, rule: 'launchctl' },
  // Generic chain operators last — they catch anything we missed
  // above but are less specific (don't identify the dangerous payload).
  { pattern: /;\s*\S/, rule: 'chained-semicolon' },
  { pattern: /&&/, rule: 'chained-and' },
  { pattern: /\|\|/, rule: 'chained-or' },
]

/**
 * Parse the leading token stream of a shell command. Quoted segments are
 * preserved as single tokens. Backticks / $() are NOT unescaped — the
 * dangerous-pattern layer flags them so the classifier never sees a
 * confused token stream.
 */
export function tokenizeBashCommand(command: string): string[] {
  const out: string[] = []
  let buf = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]
    if (quote) {
      if (ch === quote) {
        quote = null
      } else {
        buf += ch
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '\\' && i + 1 < command.length) {
      buf += command[i + 1]
      i += 1
      continue
    }
    if (/\s/.test(ch)) {
      if (buf) {
        out.push(buf)
        buf = ''
      }
      continue
    }
    buf += ch
  }
  if (buf) out.push(buf)
  return out
}

/**
 * Build a length-aligned copy of `command` where every char that lives
 * inside a single-quoted or double-quoted segment is replaced with a
 * space. Outside-quote chars (and the quote chars themselves) are
 * preserved verbatim.
 *
 * Used as the input to {@link findDangerousPattern} so the regex sweep
 * only matches `;` / `|` / `>` / `<` / etc. that occur in *unquoted*
 * regions. Quote-aware bug fix (2026-06-21): previously the regex ran
 * on the raw command, so a SQL like
 *   sqlite3 foo.db "SELECT * FROM t WHERE c = 'a;b'"
 *   echo "x > y"
 *   echo "SELECT 1;"
 * fired `chained-semicolon` / `output-redirect` rules because the `;`,
 * `>` inside quotes were treated as live shell operators. Real e2e
 * (session_ea4f1793 sqlite3 deny cascade) caught this: the deny message
 * said `chained-semicolon` for a fully-quoted SQL literal, which
 * confused the model's reasoning about why the call was rejected.
 *
 * The mask preserves length so any regex match positions align with
 * the original command for error reporting (we only use the regex
 * boolean test + rule name; we never report match positions).
 *
 * Note: backslash-escapes inside double quotes (`"\;"`) are handled
 * by masking the `\` too — the regex doesn't need to look at the
 * escape sequence anyway. Single quotes have no escapes in POSIX
 * shell. The mask does NOT model `$()` command substitution
 * (`echo $(rm -rf /)`); that path is already caught earlier by
 * DANGEROUS_PATTERNS `command-substitution-dollar-paren` because the
 * `$(` and the closing `)` both live in unquoted regions.
 */
function maskQuotedSegments(command: string): string {
  let out = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]
    if (quote) {
      if (ch === quote) {
        quote = null
        out += ch // keep the closing quote
        continue
      }
      // Char lives inside a quote — mask it. Preserve length so
      // regex match positions stay aligned with the raw string.
      out += ch === '\t' || ch === '\n' ? ch : ' '
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      out += ch // keep the opening quote
      continue
    }
    out += ch
  }
  return out
}

function findDangerousPattern(command: string): string | null {
  const masked = maskQuotedSegments(command)
  for (const { pattern, rule } of DANGEROUS_PATTERNS) {
    if (pattern.test(masked)) return rule
  }
  return null
}

function classifyFind(tokens: string[]): BashRiskKind | { kind: 'execute'; rule: string } {
  // find is allowlisted ONLY when restricted to `-type f` (file metadata
  // discovery) AND none of the dangerous action flags are present.
  for (let i = 0; i < tokens.length; i += 1) {
    if (FIND_DENIED_FLAGS.includes(tokens[i])) {
      return { kind: 'execute', rule: `find-${tokens[i].replace(/^--?/, '')}-denied` }
    }
  }
  for (let i = 0; i < tokens.length - 1; i += 1) {
    if (tokens[i] === '-type' && tokens[i + 1] !== 'f') {
      return { kind: 'execute', rule: `find-type-${tokens[i + 1]}-not-allowlisted` }
    }
  }
  const hasTypeF = tokens.some((t, i) => t === '-type' && tokens[i + 1] === 'f')
  if (!hasTypeF) {
    return { kind: 'execute', rule: 'find-requires-type-f' }
  }
  return 'read'
}

function classifySafeSourceInspection(
  tokens: string[],
  command: string,
): 'read' | { kind: 'execute'; rule: string } | null {
  const dangerous = findDangerousPattern(command)
  if (dangerous) return { kind: 'execute', rule: dangerous }

  const pipeIndex = tokens.indexOf('|')
  if (pipeIndex >= 0 && !isSafeTruncationPipe(tokens.slice(pipeIndex + 1))) {
    return { kind: 'execute', rule: 'pipeline-not-allowlisted' }
  }
  const commandTokens = pipeIndex >= 0 ? tokens.slice(0, pipeIndex) : tokens
  const [head, ...args] = commandTokens
  if (head === 'sed') return classifySafeSed(args)
  if (head === 'grep') return classifySafeGrep(args)
  return null
}

function isSafeTruncationPipe(tokens: string[]): boolean {
  const [command, ...args] = tokens
  if (command !== 'head' && command !== 'tail') return false
  if (args.length === 0) return true
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (/^-[0-9]+$/.test(arg)) continue
    if ((arg === '-n' || arg === '-c') && /^\d+$/.test(args[i + 1] ?? '')) {
      i += 1
      continue
    }
    return false
  }
  return true
}

function classifySafeSed(args: string[]): 'read' | { kind: 'execute'; rule: string } {
  if (args.some(arg => arg === '-i' || arg.startsWith('-i'))) {
    return { kind: 'execute', rule: 'sed-in-place-denied' }
  }
  const invalidFlag = args.find(arg => arg.startsWith('-') && !SAFE_SED_FLAGS.has(arg))
  if (invalidFlag) return { kind: 'execute', rule: `sed-flag-${invalidFlag.replace(/^--?/, '')}-not-allowlisted` }

  const scriptAndPaths = args.filter(arg => !SAFE_SED_FLAGS.has(arg))
  if (!args.some(arg => SAFE_SED_FLAGS.has(arg))) {
    return { kind: 'execute', rule: 'sed-requires-print-only-mode' }
  }
  if (scriptAndPaths.length < 2) {
    return { kind: 'execute', rule: 'sed-requires-script-and-file' }
  }
  const [script, ...paths] = scriptAndPaths
  if (!/^\d+(?:,\d+)?p$/.test(script)) {
    return { kind: 'execute', rule: 'sed-script-not-allowlisted' }
  }
  if (paths.some(path => path.startsWith('-'))) {
    return { kind: 'execute', rule: 'sed-path-not-allowlisted' }
  }
  return 'read'
}

function classifySafeGrep(args: string[]): 'read' | { kind: 'execute'; rule: string } {
  const positional: string[] = []
  for (const arg of args) {
    if (arg === '--') continue
    if (arg.startsWith('--')) {
      if (!SAFE_GREP_FLAGS.has(arg)) {
        return { kind: 'execute', rule: `grep-flag-${arg.replace(/^--/, '')}-not-allowlisted` }
      }
      continue
    }
    if (arg.startsWith('-')) {
      if (!/^-[nEFiHhIo]+$/.test(arg)) {
        return { kind: 'execute', rule: `grep-flag-${arg.replace(/^-/, '')}-not-allowlisted` }
      }
      continue
    }
    positional.push(arg)
  }
  if (positional.length < 2) {
    return { kind: 'execute', rule: 'grep-requires-pattern-and-file' }
  }
  const paths = positional.slice(1)
  if (paths.some(path => path.includes('*') || path.includes('?'))) {
    return { kind: 'execute', rule: 'grep-glob-path-not-allowlisted' }
  }
  return 'read'
}

function classifyGitBranch(args: string[]): 'read' | { kind: 'execute'; rule: string } {
  if (args.length === 0) return 'read'
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--') {
      return { kind: 'execute', rule: 'git-branch-positional-not-allowlisted' }
    }
    if (DENIED_GIT_BRANCH_FLAGS.has(arg)) {
      return { kind: 'execute', rule: `git-branch-${arg.replace(/^--?/, '')}-denied` }
    }
    if (arg === '--format') {
      const value = args[i + 1]
      if (!value || value.startsWith('-')) {
        return { kind: 'execute', rule: 'git-branch-format-requires-value' }
      }
      i += 1
      continue
    }
    if (arg.startsWith('--format=')) {
      continue
    }
    if (SAFE_GIT_BRANCH_FLAGS.has(arg)) {
      continue
    }
    if (arg.startsWith('-')) {
      return { kind: 'execute', rule: `git-branch-${arg.replace(/^--?/, '')}-not-allowlisted` }
    }
    return { kind: 'execute', rule: 'git-branch-positional-not-allowlisted' }
  }
  return 'read'
}

/**
 * Classify a Bash command string as `read` (auto-allow under
 * `denyByDefaultTools()`) or `execute` (keep current hard-deny /
 * approval-gate path). Pure function: no IO, no globals.
 */
export function classifyBashRisk(command: string): BashRiskClassification {
  const trimmed = command.trim()
  if (!trimmed) {
    return { kind: 'execute', rule: 'empty-command', command }
  }
  const tokens = tokenizeBashCommand(trimmed)
  if (tokens.length === 0) {
    return { kind: 'execute', rule: 'no-tokens', command }
  }
  const [first, ...rest] = tokens

  if (first === 'find') {
    const findResult = classifyFind([first, ...rest])
    if (findResult === 'read') {
      return scanForDangerous(trimmed, 'read')
    }
    // findResult is the discriminated union of { kind: 'execute'; rule: string }.
    return { kind: 'execute', rule: (findResult as { rule: string }).rule, command }
  }

  const sourceInspection = classifySafeSourceInspection(tokens, trimmed)
  if (sourceInspection === 'read') {
    return { kind: 'read', command }
  }
  if (sourceInspection) {
    return { kind: 'execute', rule: sourceInspection.rule, command }
  }

  const allowedSubs = Object.prototype.hasOwnProperty.call(BASH_READ_ONLY_COMMANDS, first)
    ? BASH_READ_ONLY_COMMANDS[first]
    : null

  if (allowedSubs === null) {
    return { kind: 'execute', rule: `command:${first}-not-allowlisted`, command }
  }

  if (allowedSubs !== null) {
    // Find first non-flag token (flags start with `-`).
    const subcommand = rest.find(t => !t.startsWith('-'))

    const denySet = BASH_DENIED_SUBCOMMANDS[first]
    if (subcommand && denySet && denySet.has(subcommand)) {
      return { kind: 'execute', rule: `command:${first}-${subcommand}-denied-subcommand`, command }
    }

    if (allowedSubs.size > 0) {
      if (!subcommand) {
        return { kind: 'execute', rule: `command:${first}-requires-subcommand`, command }
      }
      if (!allowedSubs.has(subcommand)) {
        // Subcommand isn't in the read allowlist. Still scan for
        // dangerous patterns so e.g. `git status; rm -rf` reports the
        // semicolon chain (more specific / more informative rule)
        // instead of the misleading "not-allowlisted" reason.
        const dangerous = findDangerousPattern(trimmed)
        if (dangerous) {
          return { kind: 'execute', rule: dangerous, command }
        }
        return { kind: 'execute', rule: `command:${first}-${subcommand}-not-allowlisted`, command }
      }
    }
    if (first === 'git' && subcommand === 'branch') {
      const branchArgs = rest.slice(rest.indexOf(subcommand) + 1)
      const branchResult = classifyGitBranch(branchArgs)
      if (branchResult !== 'read') {
        return { kind: 'execute', rule: branchResult.rule, command }
      }
    }
    // Empty Set (no subcommand restriction) OR matched subcommand: fall
    // through to the dangerous-pattern sweep.
  }

  return scanForDangerous(trimmed, 'read')
}

function scanForDangerous(command: string, base: BashRiskKind): BashRiskClassification {
  const dangerous = findDangerousPattern(command)
  if (dangerous) {
    return { kind: 'execute', rule: dangerous, command }
  }
  return base === 'read' ? { kind: 'read', command } : { kind: 'execute', command }
}
