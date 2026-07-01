# Usage Examples

[简体中文](examples.zh-CN.md)

Real-world patterns for working with BabeL-O inside `bbl go`.

---

## 1. Explore an unfamiliar repository

**Prompt:**

```
explain this repository and point me to the entry points
```

**What happens:** The agent calls Glob, Grep, and Read to understand the project layout. It reads `package.json`, entrypoint files, and key configuration files, then synthesizes a structured walkthrough in the transcript.

**Follow up:** Ask "how does the build pipeline work?" or "what tests exist for the auth module?" to go deeper. The agent already has the repo structure in context.

**Tip:** Start a fresh `/session new` for each repo so context doesn't carry noise from previous work.

---

## 2. Bug-fix flow

Start a session, paste the failing test output, and ask:

```
read the failing test output, patch the bug, and rerun the smallest useful test
```

**What happens:** The agent reads the test file, runs it once to capture the full error trace (Bash), traces the failure to the source (Read, Grep), edits the file (Edit), and re-runs the test. Permission prompts appear for Write/Edit/Bash on their first use. Press `A` (capital) to approve Bash for the session.

**Tip:** If the test runner is slow, ask the agent to extract a focused test case first:
"find the minimal reproduction and only rerun that one."

---

## 3. Long migration across sessions

A large refactor cannot finish in one session. Use durable sessions to resume.

**Session A — setup:**

```
migrate the config loader from YAML to JSON. start by mapping the public API surface
```

Let the agent explore and produce a plan. When context runs high, run `/compact` or let auto-compact handle it. At the end, note the session ID:

```
/session current
```

**Session B — resume (next day or after a restart):**

```bash
bbl sessions list                    # find the session
bbl inspect-session <sessionId> --resume  # verify resumability
```

Then inside `bbl go`:

```
/session use <sessionId>
```

The model loads compacted history and continues. Check context with `/context` to see the working set and compact state.

**Tip:** Before closing the TUI, run `/compact` so history is already summarized. The next session loads faster.

---

## 4. Multi-session handoff

When a task has a clear sub-task, create a dedicated child session and hand it off.

Start in the parent session:

```
/session new migration-prep
```

Run the exploration. Then switch back to the main session:

```
/session use main
```

Inside the TUI, type a handoff prompt that references the other session:

```
check /session/migration-prep for the dependency list, then implement the changes here
```

To inspect a session from the terminal without the TUI:

```bash
bbl sessions show <sessionId>          # full metadata as JSON
bbl sessions events <sessionId>        # paginated event transcript
bbl inspect-session <sessionId>        # diagnosis + compact history
bbl inspect-session <sessionId> --trace  # export as machine-readable trajectory
```

**Tip:** Use `bbl sessions tree` to see parent-child relationships when sub-agents are involved.

---

## 5. Context inspection

**Prompt:**

```
inspect the current context budget and tell me whether we should compact
```

**What happens:** The agent runs `/context` (or reads from its own context-awareness), then explains the numbers: token usage vs. limit, compact headroom, working set paths, and whether the model recommends compacting now.

To inspect the panel yourself:

- Type `/context` in the input bar and press Enter.
- Look for the compact section: `compact delta: events 156 -> 18 · saved~8400 tokens`.
- Use `/compact` to trigger a manual compaction.
- Re-run `/context` to verify the freed headroom.

**Tip:** Auto-compact fires at ~70 % of the context window. If you see frequent auto-compacts, manually compact at a natural pause so summarization happens on your terms.

---

## 6. Model switching mid-session

Inside `bbl go`, switch the active model without losing session state:

- Type **`/model`** and press Enter (or press **Ctrl+L**).
- The model-config panel opens. Select a different provider profile or model ID.
- The session stays intact; subsequent turns use the new model.

Common scenarios:

| When | Switch to |
| --- | --- |
| Deep reasoning needed | A larger model (e.g. `claude-opus-4-5`) |
| Quick, cheap edits | A smaller model (e.g. `claude-haiku-4-5`) |
| Trying a different provider | Switch the whole provider profile |

The session's tool traces, context, and permission rules carry over.

**Tip:** Use `bbl config list` to see your configured profiles before entering the TUI, so you know what is available under `/model`.

---

## 7. One-shot prompt without the TUI

For quick questions or automation, skip the TUI entirely:

```bash
bbl run "summarize the changes in the last three commits"
```

BabeL-O runs the prompt against the default session, returns the result, and exits. No TUI startup, no persistence.

**Tip:** For anything that needs more than one turn, use `bbl go`. The TUI is built for multi-turn sessions.
