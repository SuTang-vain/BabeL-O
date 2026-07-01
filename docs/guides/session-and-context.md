# Sessions and Context

[简体中文](session-and-context.zh-CN.md)

BabeL-O models each coding session as a durable, inspectable unit of work.
Every prompt inside `bbl go` belongs to a session. Sessions persist through
SQLite even after you close the TUI, so you can resume, inspect, or replay
them later.

## Sessions

### Create

A session is created automatically when you submit your first prompt. To
force a fresh one: `/session new`.

### List

```bash
bbl sessions list                   # all persisted sessions (phase + cwd)
bbl sessions tree                   # parent-child hierarchy (sub-agents)
bbl sessions tree <rootSessionId>   # subtree from a specific root
```

### Inspect

```bash
bbl sessions show <sessionId>              # full metadata (JSON)
bbl sessions events <sessionId>            # paginated event transcript
bbl inspect-session <sessionId>             # SQLite diagnosis + compact history
bbl inspect-session <sessionId> --trace    # export as agent trajectory
bbl inspect-session <sessionId> --resume   # check if session can resume
```

`bbl inspect-session` is the primary diagnostic: it looks up the session
in local SQLite, reporting phase, event count, compact boundaries, and the
original prompt. `--trace` exports the full event stream; `--resume` shows
where the run stopped and whether it can continue.

### Switch and resume

In the TUI: `/session use <sessionId>`. From the CLI:

```bash
bbl sessions resume <sessionId> "continue with the refactor"
```

This appends user input to an existing session and lets Nexus continue.

### Cancel

```bash
bbl sessions cancel <sessionId>
```

### Sub-sessions and inbox

When agents spawn sub-agents, each child has its own session:

```bash
bbl sessions children <parentSessionId>
bbl sessions child-events <parentSessionId> <childSessionId>
```

Sessions can receive collaboration context via SessionChannels:

```bash
bbl sessions inbox <sessionId>           # unread messages
bbl sessions inbox <sessionId> --include-acknowledged
bbl sessions ack <sessionId> <messageId>
```

Inside the TUI, use `/inbox`.

## Durable sessions

Sessions survive TUI restarts. Nexus persists to `~/.babel-o/db.sqlite`.
After restart:

1. `bbl sessions list` to find the session.
2. `/session use <sessionId>` in the TUI.
3. The model loads history and continues.

If a session was lost (in-memory storage before persistence),
`bbl inspect-session <sessionId>` reports what happened with client-side
log hints.

## Context inspection

### The `/context` panel

Inside `bbl go`, `/context` opens the context analysis overlay. It reads
`GET /v1/sessions/:id/context` and shows what the model sees:

- **Token budget**: usage vs maximum, with a segmented visual bar.
- **Capacity**: remaining tokens, compact headroom, blocking headroom.
- **State**: selected/omitted event counts, compact boundary, recovery
  boundary, next threshold.
- **Task scope**: primary root, confirmed external roots, pending scope
  boundaries, out-of-scope evidence.
- **Sections**: character counts for system prompt, project memory,
  session summary, active skills.
- **Compact retention**: whether a boundary exists, retained events.
- **Compact delta**: events collapsed and estimated tokens saved.
- **Memory**: long-term memory hits, injected chars, latency.
- **Working set paths**: most-frequently-touched files.
- **Signals and recommendations**: warnings, notices, and suggestions
  (e.g. "compact now").

### Reading the compact section

```
compact boundary yes · retained=42
compact delta: events 156 -> 18 · saved~8400 tokens
```

- **retained=N**: how many recent events survive after compaction.
- **before/after**: event count before and after the compact pass.
- **saved**: estimated tokens freed.

### Auto-compact

The runtime triggers compaction automatically when estimated tokens cross
~70% of the context window:

```
auto compact: threshold reached at 85%
```

When `shouldCompact` is true, the next model turn compacts before calling
the provider.

### Manual compact

Inside the TUI: `/compact`.

```
compact_result events: 156 -> 18
```

The response includes boundary type, trigger, summary, and retained
segment details. Compaction summarizes earlier turns and tool results,
preserving only recent events.

## Long sessions and handoff

1. **Before closing**: no save needed. Check current ID with
   `/session current`.
2. **After restart**: `bbl sessions list`, then `/session use <id>`.
3. **Verify resume**: `bbl inspect-session <id> --resume`.
4. **Inspect traces**: `bbl inspect-session <id> --trace` for a
   machine-readable replay of every turn and tool call.
5. **Working set**: `bbl context working-set` shows tracked files.

Session storage keeps history intact across terminal restarts, network
interruptions, and provider changes.
