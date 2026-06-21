# Contributing To BabeL-O

Thanks for helping make BabeL-O better. This project moves quickly, so the
most valuable contribution style is small, reviewable, and backed by a clear
verification trail.

## Project Shape

BabeL-O is Nexus-first:

```text
Nexus owns execution.
CLI and TUI own interaction.
Runtime owns task scope, tool risk, and evidence validation.
Memory is volatile context, not a fact source.
```

Main directories:

| Path | Owns |
| --- | --- |
| `src/nexus/` | Fastify API, WebSocket streaming, sessions, task orchestration, agent loop. |
| `src/runtime/` | Local/LLM runtime, context assembly, compact, provider/tool loop, task scope. |
| `src/tools/` | Built-in tools, MCP tool wrapping, risk classification, path safety. |
| `src/storage/` | Memory/SQLite storage, events, tool traces, metrics, permission audits. |
| `src/providers/` | Provider registry, adapters, retry, model capability routing. |
| `src/cli/` | Commander commands, one-shot CLI flow, terminal rendering. |
| `clients/go-tui/` | Production interactive terminal client. |
| `docs/nexus/` | Canonical planning, architecture, active TODO, and work history. |

Before changing runtime, storage, permissions, task scope, context assembly,
or CI/release behavior, read
[Development Process Stability Governance](docs/nexus/reference/development-process-stability-governance-plan.md).

## Local Setup

Requirements:

- Node.js >= 22
- npm
- Go 1.23+ only when touching `clients/go-tui/` or `runners/go-runner/`

```bash
npm ci
npm run typecheck
npm run format:check
npm test
npm run build:smoke
```

Useful targeted commands:

```bash
npm run deps:audit
npm run docs:check
npm run test:go-tui
npm run test:go-runner
npm run test:providers:smoke
```

The default `npm test` path is expected to be offline and deterministic. Do
not depend on a user's real `~/.babel-o/config.json`; tests must use isolated
config paths.

## Choosing A Change Size

Keep one pull request to one semantic slice:

- one regression fix,
- one feature slice,
- one documentation lifecycle move,
- one test-harness improvement.

Split the PR when it mixes runtime behavior with broad docs migration, storage
schema with UI rendering, event schema with provider behavior, Go TUI state
with Nexus runtime behavior, or more than one high-risk ownership boundary.

It is fine to open several small PRs in one day. The limit is reviewability,
not commit count.

## Pull Request Expectations

Every PR should explain:

- risk level,
- scope,
- behavior changed,
- regression evidence if any,
- verification commands,
- documentation impact,
- flaky/quarantine impact,
- rollback notes for risky changes.

High-risk changes include runtime loop, task scope, storage, permissions,
shared event schemas, provider replay, Nexus session routing, CI/release
scripts, and dependency-boundary scripts. These require focused regression
evidence or a clear reason why the change is behavior-neutral.

## Documentation Rules

`docs/nexus` is the canonical docs library:

- current scheduling: `docs/nexus/TODO.md`;
- active implementation detail: `docs/nexus/active/`;
- long-lived architecture: `docs/nexus/reference/`;
- draft or partially landed plans: `docs/nexus/proposals/`;
- closed implementation history: `docs/nexus/history/` or `docs/nexus/DONE.md`;
- factual work and verification: `docs/nexus/WORK_LOG.md`.

Run `npm run docs:check` after changing `docs/nexus`.

## Tests And Flaky Behavior

If a test fails twice with the same non-deterministic symptom, do not normalize
the noise. Record it in `docs/nexus/active/TODO_cleanup.md` with:

- file and test name,
- first and last observed failure,
- symptom,
- likely cause,
- owner,
- exit condition,
- replacement coverage.

Known flaky or environment-sensitive tests should move to a quarantine or
smoke tier rather than weakening default `npm test`.

## Issue Triage

Use:

- Bug report for reproducible failures.
- Feature request for new user-visible behavior.
- Documentation issue for docs, examples, install, or onboarding gaps.
- Question for usage or design clarification.

Security-sensitive reports should avoid public secrets or provider keys. Open a
minimal issue first and coordinate privately with the maintainer if needed.

## Maintainer Decisions

Governance, review expectations, maintainer availability, and bus factor are
tracked in [GOVERNANCE.md](GOVERNANCE.md). Larger design changes should start
as an issue or docs proposal before implementation.
