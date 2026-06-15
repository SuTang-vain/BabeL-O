# Changelog

This changelog highlights user-facing changes in BabeL-O releases.

For full bilingual release notes, see [docs/releases](docs/releases/README.md).

## Unreleased

- No unreleased user-facing changes are documented yet.

## v0.3.8 - 2026-06-15

[Full release notes](docs/releases/v0.3.8.md)

### Changed

- Moved Go TUI `/model` configuration progress messages out of the persistent
  transcript and into short-lived composer notices.
- Generalized current-state verification guidance so provider, model, tool,
  config, session, workspace, test/build, MCP, and runtime checks stay
  evidence-backed.
- Clarified WebSearch as an external public-information locator, not a source
  for private workspace facts or instructions.

### Fixed

- Displayed DeepSeek's declared 1M context window in Go TUI context chrome while
  still showing the effective runtime ceiling.
- Kept soft-deny provider tool calls visible to the model while preserving the
  permission gate for write and execute actions.
- Fed permission denials back to the provider as recoverable tool results so it
  can adjust instead of terminating the turn immediately.
- Reused approved session-scoped provider rules to avoid repeated permission
  prompts for the same approved action.

## v0.3.7 - 2026-06-14

[Full release notes](docs/releases/v0.3.7.md)

### Changed

- Made `bbl go` the single production interactive TUI entrypoint.
- Removed the legacy `bbl chat` TypeScript TUI from the release package.
- Kept `bbl run "<prompt>"` for one-shot automation and scripting.
- Updated CI and smoke checks to validate the Go TUI path.

### Fixed

- Preserved Go TUI permission response fields such as `scope`, `rule`, and
  `feedback`.
- Applied trusted session approvals consistently within the active runtime
  session.

## v0.3.6 - 2026-06-14

[Full release notes](docs/releases/v0.3.6.md)

### Fixed

- Fixed portable `bbl go` launch on macOS after `bbl go --check` had passed.
- Started bundled TUI binaries from the installed binary directory instead of a
  source checkout path.
- Improved readiness checks and portable install regression coverage.

## v0.3.5 - 2026-06-14

[Full release notes](docs/releases/v0.3.5.md)

### Changed

- Switched the primary release artifact to a lightweight
  `bbl-<platform>.tar.gz` portable package.
- Reused the user's system Node.js >= 22 instead of shipping a large Node SEA
  executable.
- Kept standalone `go-tui-*` assets for debugging and compatibility.

### Fixed

- Restored the explicit API-key step in `/model`.
- Treated pasted API keys as single-line secrets to avoid duplicated or
  corrupted input.
- Routed mouse wheel events away from text fields.
- Normalized composer height after returning from `/model` and `/context`.

## v0.3.4 - 2026-06-13

[Full release notes](docs/releases/v0.3.4.md)

### Added

- Added the `/memory` panel for MemoryOS status and memory candidate review.
- Added stronger context, recovery, and working-set diagnostics.

### Changed

- Replaced hard-coded natural-language intent guidance with structured
  `problemTarget` and turn-policy metadata.
- Improved timeout recovery, compact/restore validation, and provider replay.

### Fixed

- Fixed context, model, session, tool, and memory overlays so they render above
  the input area.
- Hardened Go TUI layout restoration after panel exits.
- Improved installer self-checks and release asset validation.

## v0.3.3 - 2026-06-13

[Full release notes](docs/releases/v0.3.3.md)

### Added

- Promoted the Go TUI as the documented production interactive client.
- Added panel-driven `/session` workflows for creating, selecting, switching,
  and copying session IDs.
- Added a current product screenshot and product-facing README refresh.

### Changed

- Refined the header, welcome panel, footer, input box, slash palette, context
  panel, tool overlays, and runtime activity line.
- Made session-to-session messages typed collaboration context rather than
  hidden direct instructions.

### Fixed

- Improved model setup guardrails for API-key providers.
- Reduced accidental input pollution from mouse selection and wheel behavior.
- Reworked cancellation and recoverable conflict paths to ask the user instead
  of hard-cancelling ambiguous work.

## v0.3.2 - 2026-06-09

[Full release notes](docs/releases/v0.3.2.md)

### Added

- Added first-class SessionChannel collaboration with inbox, typed side-channel
  messages, channel graph diagnostics, activity overlay, and a Collaborate hub.
- Added CLI commands for session inbox inspection and acknowledgement.

### Fixed

- Made interactive chat fail clearly under non-TTY conditions.
- Kept standalone binary chat sessions alive while idle.
- Tightened path-drift checks for `ListDir`, `Grep`, and `Read`.

## v0.3.1 - 2026-06-08

[Full release notes](docs/releases/v0.3.1.md)

### Fixed

- Fixed standalone binary startup failures caused by duplicate
  `createRequire` declarations.
- Retained hardened installer behavior so incomplete downloads and HTTP error
  bodies cannot be installed as `bbl`.

## v0.3.0 - 2026-06-07

[Full release notes](docs/releases/v0.3.0.md)

### Added

- Added BabeL-O and KezhongKe logo assets to the README.
- Added file attachment references, image metadata handling, symbol mentions,
  diagnostic mentions, and opt-in vim input mode.
- Added optional bundled ripgrep support through `@vscode/ripgrep`.

### Changed

- Reorganized `docs/nexus` into active, reference, and archive layers.
- Hardened installer downloads with retries, temporary files, size checks, and
  executable validation.

## v0.2.9 - 2026-06-06

[Full release notes](docs/releases/v0.2.9.md)

### Added

- Added persistent, governable Agent jobs with lifecycle metadata.
- Added richer runtime metrics for provider invocations, AgentLoop steps, and
  AgentJob aggregation.
- Added benchmark history, retry policy benchmarks, and runner comparison
  diagnostics.

## v0.2.8 - 2026-06-03

[Full release notes](docs/releases/v0.2.8.md)

### Added

- Added cache-aware context compaction and long-context utilization diagnostics.
- Added a structured runtime diagnostics envelope.
- Added quality gates including `format:check`, `lint`, `coverage`,
  `build:smoke`, `deps:audit`, and `test:performance`.

### Changed

- Improved `/context`, `/status`, slash/tool palettes, multiline input, paste
  state, and agent status rendering.

## v0.2.7 - 2026-06-02

[Full release notes](docs/releases/v0.2.7.md)

### Added

- Added MiniMax-M3 to the model registry.
- Aligned model list syncing for autocomplete and interactive configuration.

### Changed

- Updated documentation language around BabeL-O as a generalized agent system.

## v0.2.6

[Full release notes](docs/releases/v0.2.6.md)

### Added

- Introduced Node.js SEA single-executable distribution.
- Added a decoupled Nexus backend runtime architecture.
- Added multi-agent Git worktree coordination, sandbox controls, path safety,
  HMAC command validation, and SQLite audit persistence.
