# Eval

> Module reference · stable public contract · see linked governance docs for deep architecture

[简体中文](eval.zh-CN.md)

## Role

Eval is the trajectory evaluation harness for coding-agent behavior. It reads
recorded agent traces (projected from Nexus event streams via
`projectAgentTrace`), runs a suite of builtin discipline checks, and produces a
self-validating report. It is offline and deterministic — no provider key, no
live workspace, no network — so evaluation runs identically on every machine
and in CI.

The eval harness lives in two files under `src/eval/`:

- **`trajectoryEval.ts`** — 6 builtin discipline checks (`tool_discipline`,
  `permission_discipline`, `scope_discipline`, `context_discipline`,
  `memory_discipline`, plus `task_success` which returns `skip` in v1), the
  runner (`runFixture` / `runAll`), and metrics aggregation (`computeMetrics`).
- **`fixtureBuilder.ts`** — the `defineFixture` helper and the `ev` compact
  event builder for authoring test trajectories.

Fixtures live in `evals/coding/*.ts` (12 fixtures as of v1) and execute via
`npm run eval:agent`. The harness exits non-zero when a fixture's
self-validation mismatches — i.e. the check suite misclassified a known-good or
known-bad trajectory.

## Public contract

- **`runAll(fixtures: Fixture[])` → `EvalReport`** — the top-level entry point.
  Runs every fixture through every check, collects `FixtureResult` objects
  (verdict, satisfied, checks, metrics, mismatches), and returns a summary with
  `total` / `passed` / `failed` counts.
- **`runFixture(fixture: Fixture)` → `FixtureResult`** — single-fixture runner
  used by `runAll`. Projects events to an `AgentTrace` via `projectAgentTrace`,
  runs all 6 checks, compares each actual severity against the fixture's
  `expectChecks` map, and returns the verdict.
- **`CHECKS: Record<CheckKey, TrajectoryCheck>`** — the canonical check
  registry. Each check is a pure function `(AgentTrace, Fixture) → CheckResult`
  with severity `pass` | `warn` | `fail` | `skip`.
- **`defineFixture(def)` → `Fixture`** — fixture authoring API. Takes an id,
  description, prompt, optional `expectChecks`, and an event array. The `ev`
  builder auto-fills `schemaVersion`, `sessionId`, and deterministic
  monotonically-incrementing timestamps.
- **`npm run eval:agent`** — CLI entry. Loads all fixtures from
  `evals/coding/*.ts`, runs `runAll`, prints a per-fixture report and a
  summary. Pass `--json` for machine-readable output.

## Allowed dependencies

Eval is an offline analysis tool and sits outside the main execution-layer
direction chain. It may import from `runtime` (for trace projection types and
the `projectAgentTrace` projector) and `shared` (for `NexusEvent` schemas). No
other module imports `src/eval/` — it is a consumer of traces, never a
producer.

The layer-direction gates do not apply to eval because it is not part of the
`cli` / `nexus` / `runtime` hot path, but its dependency footprint must remain
thin:

- `eval` → `runtime` — **allowed** (for `agentTrace` types and projector).
- `eval` → `shared` — **allowed** (for event schemas).
- `eval` → `nexus` / `cli` / `providers` / `tools` / `storage` — **forbidden**.

## Extension points

- **Add a new discipline check** — define a `TrajectoryCheck` function in
  `trajectoryEval.ts` and add it to the `CHECKS` registry. The check must be a
  pure function over `AgentTrace` + `Fixture`. New checks are automatically run
  on every fixture.
- **Add a fixture** — drop a new `evals/coding/<id>.ts` exporting
  `defineFixture({...})`. Use the `ev` builder for compact event construction.
  Set `expectChecks` to assert the severities the check suite should assign;
  the harness self-validates.
- **Turn a real-session regression into a fixture** — export the session's
  events (e.g. via `bbl inspect-session <id>` reading the SQLite events table),
  trim to the minimal event sequence reproducing the discipline violation, and
  commit the fixture. It becomes a permanent regression guard.
- **Add a new event kind** — add the event to `src/shared/events.ts`, add its
  `ev.*` builder to `fixtureBuilder.ts`, and create or update a check that
  reasons about it. The `projectAgentTrace` projector may also need extension
  to surface the new span kind.

## Related governance

- [Agent runtime maturity](../../nexus/reference/agent-runtime-architecture-maturity-plan.md) — §3.2 trajectory eval harness design, §3.5 memory quality auto-decide, and the v1.1 live-workspace roadmap.
- [Evidence governance index](../../nexus/reference/evidence-governance-index.md) — tool-evidence-before-narrative-memory principles that the discipline checks enforce.
- [Behavior monitor](../../nexus/reference/behavior-monitor.md) — cross-session behavior trace that complements offline eval with live hint projection.
- [Module coupling governance](../../nexus/reference/module-coupling-decoupling-and-re-aggregation-plan.md) — coupling heat map for the eval module's dependency footprint.
- [Layer-direction audit](../../nexus/reference/layer-direction-audit-enforcement-plan.md) — direction-aware dependency gates (eval is outside the main chain but must not leak into `nexus`/`cli`).
