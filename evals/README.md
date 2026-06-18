# Trajectory Eval Fixtures

> Source: [`docs/nexus/reference/agent-runtime-architecture-maturity-plan.md`](../docs/nexus/reference/agent-runtime-architecture-maturity-plan.md) §3.2

This directory holds offline trajectory eval fixtures for the agent runtime maturity plan. Each fixture is a **recorded event stream** (the trajectory under test) plus declarative check expectations. The harness projects the stream to an `AgentTrace` via `projectAgentTrace` and runs the builtin discipline checks.

## Run

```bash
npm run eval:agent            # human-readable report
npm run eval:agent -- --json  # machine-readable JSON
```

The harness exits non-zero if any fixture's self-validation mismatches (the check suite misclassified a known-good/bad trajectory). Offline + deterministic — no provider key, no live workspace, no network.

## Fixture format (v1)

A fixture is a single TypeScript module `evals/coding/<id>.ts` exporting a default `defineFixture({...})`:

```ts
import { defineFixture, ev } from '../../src/eval/fixtureBuilder.js'

export default defineFixture({
  id: 'my-fixture',
  description: 'What this trajectory demonstrates.',
  prompt: 'The task prompt (context only; not executed in v1).',
  expectChecks: { tool_discipline: 'pass' }, // optional: assert specific check severities
  events: [
    ev.sessionStarted({ cwd: '/repo', requestId: 'r1' }),
    ev.toolStarted({ toolUseId: 't1', name: 'Read', input: { path: '/repo/a.ts' } }),
    ev.toolCompleted({ toolUseId: 't1', name: 'Read', success: true }),
    ev.result({ success: true, message: 'done' }),
  ],
})
```

The `ev` builder fills `schemaVersion`, `sessionId`, and auto-incrementing deterministic timestamps, so each fixture only states the events that matter for its discipline.

## Self-validation

`expectChecks` is a partial map of check key → expected severity (`pass` | `warn` | `fail` | `skip`). The harness asserts each actual severity matches. A fixture's `verdict` is `pass` iff every asserted check matched. Omitted checks are still run and reported but not asserted.

- A **good** fixture (trajectory that *should* satisfy discipline) asserts the relevant checks are `pass`.
- A **bad** fixture (trajectory that *violates* discipline) asserts the relevant check is `fail`/`warn`.

This makes the eval a **self-validating check suite**: the fixtures with known good/bad trajectories prove the checks discriminate correctly.

## Builtin checks (v1)

| Key | What it checks | v1 severity |
| --- | --- | --- |
| `task_success` | Files modified correctly + tests pass | `skip` (needs live-workspace mode, plan §3.3) |
| `tool_discipline` | Read/search before edit/write | `pass` / `fail` |
| `permission_discipline` | Write/execute approved or auto-approved; no repeated denials | `pass` / `fail` |
| `scope_discipline` | Run did not escape task primary root | `pass` / `warn` / `fail` |
| `context_discipline` | No repeated reads (>2×) or large truncated reads | `pass` / `warn` |
| `memory_discipline` | Memory hint not treated as fact source | `pass` / `warn` (full auto-decide needs §3.5 retrieval spans) |

## Turning a real-session regression into a fixture

1. Export the session's events (e.g. via `bbl inspect-session <id>` reading the SQLite `events` table).
2. Trim to the minimal event sequence that reproduces the discipline violation.
3. Drop a new `evals/coding/<id>.ts` with `expectChecks` asserting the check that should catch it.

The fixture then becomes a permanent regression guard for the architecture maturity check suite.

## v1.1 (deferred)

A live-workspace mode (the plan's literal `prompt.md` + `workspace/` + `expected.json` + `checks.ts` fixture structure) requires the durable-resume/replay machinery from plan §3.3. v1 is trace-only; `task_success` is `skip` until that lands.
