# Permissions and Tool Approval

[简体中文](permissions.zh-CN.md)

Every tool in BabeL-O carries a **risk level** that determines whether the AI
model can call it freely or must ask for your approval. This guide explains how
the permission model works in the TUI (`bbl go`), what the risk levels mean,
and how to control which tools are allowed.

## The four risk levels

Each tool has a static risk level set at tool definition time. BabeL-O currently
distinguishes four levels:

| Level | Meaning | Examples |
| --- | --- | --- |
| **read** | Reads data without side effects | `Read`, `Grep`, `Glob`, `ListDir` |
| **write** | Creates or modifies files/state | `Write`, `Edit` |
| **execute** | Runs arbitrary commands or network calls | `Bash`, `curl`, `npm install` |
| **task** | Spawns sub-agents or long-running tasks | Agent task dispatch |

**Read** tools are always auto-approved by the classifier and never prompt for
permission. **Write** and **execute** tools require approval unless a session
rule or allowlist matches. **Task** is reserved for agent or sub-task dispatch
and follows the same policy evaluation path as write/execute.

## How approval works in the TUI

When the AI calls a tool that needs approval, the Go TUI (`bbl go`) shows a
**permission panel** at the bottom of the screen with a summary of:
- The tool name and input
- The risk level
- The scope risk (if the tool accesses files outside the current task scope)
- A model-suggested allow rule (when available)

### Key bindings

| Key | Action |
| --- | --- |
| `a` / `y` | Approve the current request |
| `r` / `n` | Reject the current request |
| `1` — `5` | Select from the 5-option menu directly |

### The 5-option menu

The permission panel offers five choices, navigable with arrow keys:

1. **Approve once** — let this one call through; the next call asks again.
2. **Approve for this session** — trust the suggested rule for the remainder of
   the session (recommended when the same rule repeats).
3. **Approve with editable rule** — edit the allow rule before approving.
   Opens an inline text input pre-filled with the suggested rule.
4. **Reject** — deny the call and return control to the model.
5. **Reject, tell the model what to do instead** — deny the call and type
   feedback the model can act on.

For options 2 and 3, the rule (e.g. `bash:status` or `npm:install`) is persisted
for the session so matching future calls skip the permission prompt.

### Rejecting with feedback

When you choose option 5, or press `D` in the dialog, the panel switches to a
text input where you can describe what the model should do instead. The model
receives this feedback in the next turn.

## Policy modes: strict vs soft-deny

The policy mode controls what happens when a tool is **not in the server
allowlist**:

- **strict** (default): the tool is blocked before the permission prompt fires.
  The user never sees a permission dialog in strict mode for non-allowlisted
  tools — the model gets a policy denial directly.
- **soft-deny**: the policy block is bypassed. The existing approval gate then
  emits a `permission_request` for write/execute tools, so the user can approve
  the call via the TUI permission panel.

The Go TUI defaults to **soft-deny** when connecting via `bbl go`, which is the
recommended setting for interactive work. Use strict mode when you want to
enforce a fixed allowlist and avoid approval prompts entirely.

The server-side default is controlled by the
`NEXUS_DEFAULT_POLICY_MODE` environment variable (values: `strict` or
`soft-deny`).

### Per-turn allowlist

When starting `bbl go`, you can pass `--allowed-tools Read,Grep,Glob,Bash` to
set a per-turn allowlist. Tools in this list auto-execute without permission
prompts for that turn. The next turn re-evaluates from the request body.

## Bash read-only downgrade

The Bash tool always advertises `risk: 'execute'` for audit clarity, but the
runtime applies a per-input classifier that **downgrades read-only subcommands
to `risk: 'read'`**. This means safe commands can skip the approval gate
entirely.

### Commands that are treated as read-only (no approval needed)

`ls`, `cat`, `head`, `tail`, `wc`, `file`, `stat`, `readlink`,
`pwd`, `echo`, `whoami`, `hostname`, `date`, `uname`, `env`,
`printenv`, `ps`, `top`, `uptime`

### Git subcommands treated as read-only

`git status`, `git log`, `git diff`, `git show`, `git remote`,
`git rev-parse`, `git ls-files`, `git tag`, `git branch`
(inspection flags only, e.g. `--show-current`)

### Grep and sed restrictions

`grep` is read-only only with safe flags (`--line-number`, `--fixed-strings`,
`--ignore-case`, etc.) and when pattern + file are provided. `sed` is
read-only only in print-only mode with a line-range `p` script.

### What always requires approval

- Command chains (`&&`, `;`, `||`)
- Redirects (`>`, `>>`, `<`, `|`)
- Command substitution (backticks, `$()`)
- Package managers: `npm install`, `yarn add`, `pip install`, `brew install`,
  `apt install`
- Destructive operations: `rm -rf`, `mv`, `sudo`, `chmod`, `curl | sh`
- Git write operations: `git push`, `git commit`, `git checkout`, etc.
- Any command not in the read-only allowlist

When a command is escalated to `execute`, the permission panel shows a
classifier rule (e.g. `command:sudo-anywhere` or `chained-and`) so you can
see exactly why the model is being asked for approval.

## Path and workspace safety

BabeL-O keeps tool operations inside the workspace boundary through two
mechanisms:

- **NEXUS_ALLOWED_WORKSPACES** — an environment variable that lists
  comma-separated workspace paths. When set, paths that resolve outside these
  directories are rejected with a `WorkspacePathError` before the tool executes.
  The error is non-recoverable—the model cannot work around it.
- **Task scope boundary** — when a tool accesses a directory outside the
  current task's primary root (e.g. a parent directory, a sibling repo, a
  historical session path), the runtime emits a `scope_boundary_detected`
  event and requests explicit user confirmation before proceeding.

If a path is blocked by workspace safety, the model receives a clear message
that the boundary cannot be bypassed and must work within the allowed
workspace.

## Auditing

### The `/tools` panel

Inside `bbl go`, press **Ctrl+O** (or type `/tools`) to open the **tools
audit** overlay. It shows every registered tool with its risk level, source
(builtin or MCP), approval status, description, and any suggested allow rules.

### `bbl tools audit`

From the command line, run:

```bash
bbl tools audit
```

This prints the same audit data as JSON, which you can pipe to `jq` or other
tools for scripting.

## Troubleshooting

**"A tool keeps asking for approval"**

Check whether the tool is the Bash tool with a command that the classifier
cannot downgrade to `read`. If the command contains operators (`&&`, `;`, `>`)
or calls a non-allowlisted command, the classifier escalates it to `execute`
and approval is required. You can:

- Approve **for this session** (option 2) — stores a session rule so the same
  tool call pattern won't prompt again for this session.
- Switch the server to `policyMode: 'soft-deny'` and pass
  `--allowed-tools '*'` to `bbl go` to allow all tools by default (the
  permission panel still appears for write/execute calls).

**"The model keeps trying to write files outside my workspace"**

The workspace boundary is enforced at the tool execution layer and cannot be
bypassed. If the model attempts a path like `../../etc` or `/var/log`, the
tool call fails with a `WorkspacePathError`. Remind the model to work inside
the project directory, or adjust `NEXUS_ALLOWED_WORKSPACES` if you need
multi-directory access.

**"I see 'Tool denied by Nexus policy' in the transcript"**

This means the tool is not in the server allowlist and the server is in
`strict` mode. Run with `--allowed-tools` (or set `NEXUS_ALLOWED_TOOLS`) to
add the tool, or switch to `soft-deny` mode.
