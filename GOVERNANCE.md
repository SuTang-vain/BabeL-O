# BabeL-O Governance

BabeL-O is currently maintainer-led. The project is open to contributors, but
runtime ownership remains intentionally strict so the Nexus-first architecture
does not drift.

## Maintainer

Current maintainer:

- `SuTang-vain`

Current bus factor: **1**.

This is an explicit project risk. The near-term sustainability goal is to
merge at least one external PR through the documented review process, then
identify 1-2 recurring contributors who can own docs, examples, Go TUI, or
test governance before expanding runtime ownership.

## Decision Model

- Small fixes can be reviewed and merged by the maintainer.
- Runtime, storage, permission, task-scope, provider replay, event schema,
  CI/release, and dependency-boundary changes require high-risk review notes.
- Major architecture changes should start as a docs proposal under
  `docs/nexus/proposals/` or as an issue linked to a reference plan.
- Completed implementation facts must be recorded in `docs/nexus/WORK_LOG.md`
  and moved to `docs/nexus/DONE.md` when they no longer affect scheduling.

## Review Levels

| Level | Meaning |
| --- | --- |
| `review-light` | Docs index updates, typo fixes, comments, release-note copy. |
| `review-standard` | Normal source changes, tests, CLI behavior, docs plan changes. |
| `review-high-risk` | Runtime loop, task scope, storage, permissions, shared events, provider replay, Nexus session routing, CI/release scripts. |
| `review-emergency` | Urgent P0 fix that can merge fast but needs a follow-up review note and regression test tracking. |

See
[Development Process Stability Governance](docs/nexus/reference/development-process-stability-governance-plan.md)
for the full policy.

## Community

GitHub Discussions are the preferred place for questions, show-and-tell,
ideas, and general design discussion once enabled on the repository.

Until Discussions are enabled, use issues with the `question`, `docs`,
`feature`, or `bug` template.

Maintainer response target: check public issues or discussions once per
working day when possible. This is a target, not a service-level guarantee.

## Becoming A Maintainer

Potential maintainers should first build a track record in one bounded area:

- documentation and onboarding;
- examples and product-surface polish;
- Go TUI rendering/input tests;
- flaky test isolation and CI;
- provider adapter regression fixtures;
- runtime governance tests under maintainer review.

Runtime ownership expands only after repeated, small, correct contributions
that preserve Nexus/runtime/client boundaries.
