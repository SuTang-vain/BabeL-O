# EverOS First-Run Onboarding Optimization Plan

> Superseded by [memory-governance-plan.md](../reference/memory-governance-plan.md). Keep this file for one cleanup cycle as detailed implementation history; do not use it as the current memory governance source of truth.

## Status

Implemented and verified.

Implemented surface:

- `src/shared/everosBootstrapStore.ts` — versioned `everos-bootstrap.json` state, env override via `BABEL_O_EVEROS_BOOTSTRAP_FILE`, lockfile, atomic temp-file rename, reset/read/update helpers.
- `src/nexus/everosBootstrapConfig.ts` + `src/nexus/everCoreConfig.ts` — ready bootstrap state synthesizes managed EverCore defaults only when explicit `BABEL_O_EVERCORE_*` config is absent.
- `src/cli/everosPrerequisites.ts` + `src/cli/everosBootstrap.ts` — prerequisite detection, optional brew/apt install path, source clone/build orchestration, non-fatal failed bootstrap diagnostics.
- `src/cli/commands/firstRun.ts` + `src/cli/commands/memory.ts` — first-run TTY onboarding and `bbl memory setup --status|--retry|--reset`, `bbl memory status`, `bbl memory opt-out`, `bbl memory external`.
- `src/nexus/app.ts` + Go TUI `/memory` overlay — runtime status includes bootstrap summary; Go TUI `/memory setup` points users to the CLI setup path.

Verified with isolated config paths:

- `test/everos-bootstrap-store.test.ts`
- `test/everos-bootstrap-config.test.ts`
- `test/everos-bootstrap.test.ts`
- `test/everos-first-run.test.ts`
- `test/memory-command.test.ts`
- focused runtime/context/Go TUI/typecheck regressions listed near the end of this document.

This document expands the W2.5 product TODO into an implementation-grade plan for a
Crush-style first-run onboarding flow that lets users opt into installing and enabling
local long-term memory support powered by EverOS / EverCore sidecar.

Related docs:

- [FAQ](../FAQ.md) — user-facing current behavior and expectation setting.
- [TODO Product / UX 30-Day Lift](../active/TODO_product_30day.md) — W2.5 product entry.
- [Memory Capability Awareness and Self-Trigger Plan](./memory-capability-awareness-and-trigger-plan.md) — already-implemented memory capability behavior.
- [EverCore Lifecycle, Cache and Answer Governance Plan](./evercore-lifecycle-cache-and-answer-governance-plan.md) — already-implemented runtime lifecycle/cache/status/action governance.

## Background

BabeL-O already supports EverCore / EverOS memory integration at runtime:

- `BABEL_O_EVERCORE_MODE=disabled|external|managed`
- `external`: user manages EverOS and BabeL-O connects to `BABEL_O_EVERCORE_BASE_URL`
- `managed`: BabeL-O starts a local loopback sidecar from `BABEL_O_EVERCORE_MANAGED_COMMAND`
- runtime memory status/actions are available through `/v1/runtime/memory/*` and Go TUI `/memory`
- managed sidecar reuse, registry, idle TTL, and memory capability governance are implemented

The remaining UX gap is earlier in the user journey:

```text
Install BabeL-O
  -> start bbl for the first time
  -> user may not know local memory exists
  -> user has no guided path to fetch/build EverOS sidecar
  -> user must manually discover env vars and configure managed mode
```

The desired product behavior is:

```text
First bbl startup, in an interactive TTY:
  -> ask whether the user wants local long-term memory
  -> if yes, clone + build EverOS from source when prerequisites are available
  -> persist bootstrap state
  -> configure managed mode without blocking the main chat if bootstrap fails
  -> if no, persist opt-out so the user is not nagged repeatedly
```

This follows Crush's first-run configuration pattern: Crush does not perform heavy
interactive work from package postinstall; it starts normally, detects missing provider
setup, prompts in the application flow, and persists configuration through a centralized
store.

## Crush Reference Pattern

Observed in `/Users/tangyaoyue/DEV/crush`:

| Crush pattern | Relevant files | Lesson for BabeL-O |
| --- | --- | --- |
| First-run prompt belongs in app startup, not package installation | `README.md:174-179` says users can start Crush and be prompted for an API key | Do not use `npm postinstall` for EverOS bootstrap; use first `bbl` startup / `bbl init` flow |
| Config path follows an app-level directory convention with env override | `internal/home/home.go:25-30` uses `XDG_CONFIG_HOME` or `~/.config` | Keep BabeL-O's existing `~/.babel-o`, but make bootstrap path overrideable for CI/tests |
| Config writes go through one store | `internal/config/store.go:45-71` | Create `EverOSBootstrapStore`; avoid scattered direct JSON writes |
| Writes are protected by locks and atomic rename | `internal/config/store.go:116-179`, `internal/config/atomicwrite.go:8-38` | Use a lockfile + temp-file rename for `everos-bootstrap.json` |
| Provider key writes are routed through backend/config APIs | `internal/config/store.go:314-374` | If TUI/API later modifies EverOS bootstrap settings, route through one runtime API/store |
| Env vars can explicitly override config | `internal/config/load.go:146-172` implements `CRUSH_` env shadowing | Treat `BABEL_O_EVERCORE_*` env vars as explicit user intent; onboarding must not override them |

## Goals

1. Let users opt into local long-term memory from a guided first-run experience.
2. Avoid `npm install` / `postinstall` side effects and fragile TTY assumptions.
3. Preserve current default: EverCore disabled unless the user opts in or explicitly configures env.
4. Make failures non-fatal: failed EverOS bootstrap must not prevent `bbl chat` from starting.
5. Make bootstrap state observable, retryable, and test-isolated.
6. Prevent concurrent `bbl` launches from corrupting state or running duplicate clone/build jobs.
7. Keep memory service local by default; do not expose EverOS externally without explicit user configuration.

## Non-goals

- Do not bundle EverOS binary into BabeL-O npm package in this slice.
- Do not run heavy interactive prompts from `npm postinstall`.
- Do not implement Docker-based EverOS provisioning in this slice.
- Do not turn EverOS into BabeL-O's authoritative project-state store.
- Do not ask for an EverOS API key during first-run bootstrap; managed loopback should be local.
- Do not silently override `BABEL_O_EVERCORE_*` env vars or user-authored config.
- Do not enable model-visible `mcp:evercore:*` tools by default unless explicitly chosen.

## User Experience

### Happy path

```text
$ bbl chat

Welcome to BabeL-O.

Local long-term memory is available as an optional feature.
It runs a local EverOS sidecar and lets BabeL-O recall approved cross-session notes.
Memory is disabled by default and never replaces workspace evidence.

Enable local long-term memory now?
  1. Yes, clone and build EverOS locally
  2. Not now
  3. I already run EverOS elsewhere

Choice: 1

Checking prerequisites...
  ✓ git
  ✓ python
  ✓ uv

Cloning EverOS...
Building EverOS...
Writing bootstrap state...

Long-term memory is ready.
BabeL-O will use managed local memory for future sessions.
```

### User chooses "Not now"

```text
Choice: 2

No problem. Long-term memory remains disabled.
You can enable it later with `bbl memory setup` or by setting BABEL_O_EVERCORE_MODE.
```

Persist opt-out so subsequent starts do not ask again.

### User already runs EverOS elsewhere

```text
Choice: 3

Set BABEL_O_EVERCORE_MODE=external and BABEL_O_EVERCORE_BASE_URL to connect your service.
Skipping local sidecar bootstrap.
```

This should record a neutral state such as `optedIn=false`, `externalHintShown=true`, not a managed installation.

### Missing prerequisites

```text
Checking prerequisites...
  ✓ git
  ✗ uv

uv is required to build EverOS from source.
Install uv automatically using Homebrew?
  1. Yes, run: brew install uv
  2. No, show manual instructions
```

Rules:

- Detect `brew` on macOS; detect `apt` on Debian/Ubuntu-like Linux.
- Never run package manager commands without explicit user confirmation.
- If auto-install fails, record failure in bootstrap state but continue into `bbl chat`.
- On unsupported package managers, show manual instructions only.

### Non-interactive / CI

If stdin/stdout is not a TTY:

- do not prompt
- do not clone/build
- do not create opt-out unless explicitly requested
- proceed with current env/config behavior

Example message, only in verbose/debug mode:

```text
Skipping EverOS first-run onboarding because this is not an interactive TTY.
```

## Bootstrap State

Default path:

```text
~/.babel-o/everos-bootstrap.json
```

Override:

```text
BABEL_O_EVEROS_BOOTSTRAP_FILE=/tmp/babel-o-test-everos-bootstrap.json
```

Suggested schema:

```json
{
  "version": 1,
  "optedIn": true,
  "optedOut": false,
  "externalHintShown": false,
  "sourceRepo": "https://github.com/<org>/<everos-repo>.git",
  "sourceRef": "main",
  "sourceCommit": "abcdef123456",
  "sourceDir": "/Users/alice/.babel-o/everos/source",
  "dataDir": "/Users/alice/.babel-o/everos/data",
  "managedCommand": "/Users/alice/.babel-o/everos/source/.venv/bin/everos",
  "buildStatus": "ready",
  "lastCheckedAt": "2026-06-14T00:00:00.000Z",
  "lastBuildAt": "2026-06-14T00:00:00.000Z",
  "errorCode": null,
  "errorMessage": null
}
```

### State fields

| Field | Meaning |
| --- | --- |
| `version` | Schema version for future migrations |
| `optedIn` | User chose local managed memory bootstrap |
| `optedOut` | User chose not now; suppress repeated prompts |
| `externalHintShown` | User said they already run EverOS elsewhere |
| `sourceRepo` | Git URL used for EverOS source clone |
| `sourceRef` | Branch/tag/commit requested by installer |
| `sourceCommit` | Resolved commit after clone/build |
| `sourceDir` | Local checkout path |
| `dataDir` | EverOS runtime data directory |
| `managedCommand` | Command path to pass into `BABEL_O_EVERCORE_MANAGED_COMMAND` equivalent config |
| `buildStatus` | `not_started|checking_prereqs|cloning|building|ready|failed|opted_out|external` |
| `lastCheckedAt` | Last bootstrap check time |
| `lastBuildAt` | Last successful build time |
| `errorCode` | Stable machine-readable failure code |
| `errorMessage` | Human-readable failure message |

### Error codes

Initial set:

```text
EVEROS_BOOTSTRAP_GIT_MISSING
EVEROS_BOOTSTRAP_PYTHON_MISSING
EVEROS_BOOTSTRAP_UV_MISSING
EVEROS_BOOTSTRAP_PACKAGE_MANAGER_UNSUPPORTED
EVEROS_BOOTSTRAP_PACKAGE_INSTALL_FAILED
EVEROS_BOOTSTRAP_CLONE_FAILED
EVEROS_BOOTSTRAP_BUILD_FAILED
EVEROS_BOOTSTRAP_COMMAND_NOT_FOUND
EVEROS_BOOTSTRAP_CONCURRENT_INSTALL_IN_PROGRESS
EVEROS_BOOTSTRAP_STATE_INVALID
```

## Configuration Precedence

EverOS onboarding must respect this order:

```text
1. Explicit environment variables:
   BABEL_O_EVERCORE_MODE
   BABEL_O_EVERCORE_BASE_URL
   BABEL_O_EVERCORE_MANAGED_COMMAND
   BABEL_O_EVERCORE_DATA_DIR
   BABEL_O_EVERCORE_* LLM settings

2. Explicit user config already written in ~/.babel-o/config.json

3. everos-bootstrap.json generated by first-run onboarding

4. Defaults: EverCore disabled
```

If any explicit `BABEL_O_EVERCORE_MODE` is present, first-run onboarding should skip the memory prompt.

If bootstrap says `buildStatus=ready`, runtime configuration can synthesize managed-mode defaults:

```text
mode: managed
managedCommand: bootstrap.managedCommand
managedDataDir: bootstrap.dataDir
```

But this must not silently enable model-visible MCP tools. Keep `BABEL_O_ENABLE_EVERCORE_MCP_TOOLS` or a wizard checkbox separate.

## Proposed Architecture

### New modules

```text
src/cli/commands/firstRun.ts
  - orchestrates first-run checks
  - TTY detection
  - calls provider init wizard and EverOS prompt in sequence

src/cli/commands/everosBootstrap.ts
  - user-facing prompt flow
  - prerequisite detection
  - clone/build orchestration
  - non-fatal status rendering

src/cli/everosBootstrapStore.ts
  - read/write everos-bootstrap.json
  - schema validation
  - migration
  - file locking
  - atomic temp file + rename

src/cli/everosPrerequisites.ts
  - detect git/python/uv
  - detect brew/apt
  - produce install suggestions/commands

src/nexus/everosBootstrapConfig.ts
  - converts bootstrap state into EverCoreConfigInput defaults
  - only used when explicit env/config is absent
```

### Runtime integration

Current path:

```text
configureEverCoreFromEnv(env, options)
  -> resolveEverCoreConfigInputFromEnv(env, options)
  -> configureEverCore(input)
```

Proposed future path:

```text
createRuntime / CLI startup
  -> firstRunOnboarding()                 // interactive only, non-fatal
  -> load settings/env
  -> loadEverOSBootstrapDefaults()        // read-only, non-fatal
  -> resolveEverCoreConfigInput(env + settings + bootstrap defaults)
  -> configureEverCore(input)
```

Important boundary:

- onboarding may write `everos-bootstrap.json`
- `configureEverCore` should not run prompts
- runtime config resolution may read bootstrap state but should not clone/build

### Store write discipline

Follow Crush's `ConfigStore` discipline:

```text
EverOSBootstrapStore.update(fn)
  -> acquire process mutex
  -> acquire lockfile (everos-bootstrap.json.lock)
  -> read current JSON or {}
  -> validate/migrate
  -> apply pure transform
  -> write temp file in same dir
  -> chmod 0600
  -> rename into place
  -> release lock
```

No command should call `fs.writeFile(bootstrapPath, ...)` directly.

## Implementation Phases

### Phase O1 — Documentation and schema only

Status: implemented and verified.

Deliverables:

- this plan
- FAQ link
- TODO W2.5 link
- JSON schema sketch documented

Acceptance:

- no runtime behavior changes
- docs clearly state current version does not install EverOS automatically

### Phase O2 — BootstrapStore foundation

Status: implemented and verified.

Deliverables:

- `src/cli/everosBootstrapStore.ts`
- schema validation for version 1
- atomic write helper
- lockfile helper
- test-only env override: `BABEL_O_EVEROS_BOOTSTRAP_FILE`

Tests:

- read missing file returns empty/default state
- invalid JSON returns `EVEROS_BOOTSTRAP_STATE_INVALID` without crashing caller
- update writes chmod 0600 where supported
- two concurrent updates do not corrupt JSON
- tests use `/tmp`, never real `~/.babel-o`

### Phase O3 — Non-interactive config resolution

Status: implemented and verified.

Deliverables:

- `src/nexus/everosBootstrapConfig.ts`
- read bootstrap state and synthesize managed defaults when ready
- respect env/config precedence

Tests:

- explicit `BABEL_O_EVERCORE_MODE=disabled` wins over bootstrap ready
- explicit `external` wins over bootstrap ready
- bootstrap ready produces managed command/dataDir only when no explicit mode exists
- bootstrap failed/opted_out/external does not enable EverCore

### Phase O4 — First-run prompt shell

Status: implemented and verified.

Deliverables:

- `src/cli/commands/firstRun.ts`
- TTY detection
- prompt for yes/no/external only
- write opted-out/external/opted-in-not-started state
- no clone/build yet

Tests:

- non-TTY skips prompt and writes nothing
- TTY yes writes optedIn state
- TTY no writes optedOut state and suppresses second prompt
- existing `BABEL_O_EVERCORE_MODE` skips prompt

### Phase O5 — Prerequisite detection

Status: implemented and verified.

Deliverables:

- `src/cli/everosPrerequisites.ts`
- detect `git`, `python`/`python3`, `uv`
- detect `brew` and `apt`
- generate explicit install plan, but do not run package manager without confirmation

Tests:

- missing git blocks bootstrap with stable error code
- missing uv with brew suggests `brew install uv`
- missing uv with apt suggests documented install path
- unsupported package manager returns manual-instructions-only status

### Phase O6 — Clone/build orchestration

Status: implemented and verified with mocked command runners; real clone/build path is available through `bbl memory setup`.

Deliverables:

- `git clone` or `git fetch`/checkout into `~/.babel-o/everos/source`
- build command for EverOS source tree
- write `sourceCommit`, `managedCommand`, `buildStatus=ready`
- failure state is persisted and non-fatal

Tests:

- mocked spawn success writes ready state
- clone failure writes `EVEROS_BOOTSTRAP_CLONE_FAILED`
- build failure writes `EVEROS_BOOTSTRAP_BUILD_FAILED`
- concurrent bootstrap sees lock and does not duplicate build

### Phase O7 — UX polish and retry commands

Status: implemented and verified. CLI shape is `bbl memory setup --status|--retry|--reset --yes` plus `bbl memory status`, `opt-out`, and `external` convenience commands.

Deliverables:

```text
bbl memory setup
bbl memory setup --retry
bbl memory setup --status
bbl memory setup --reset
```

Behavior:

- `--status` renders bootstrap state and runtime memory status
- `--retry` retries failed clone/build
- `--reset` removes bootstrap state after confirmation

Tests:

- reset asks confirmation before deleting
- retry preserves sourceRepo/sourceRef unless explicitly changed
- status redacts secrets and paths as appropriate

### Phase O8 — TUI integration

Status: implemented and verified. Go TUI `/memory status` renders bootstrap summary from runtime status; `/memory setup` shows CLI setup guidance instead of running clone/build inside the TUI.

Deliverables:

- Go TUI `/memory status` includes bootstrap state summary when available
- `/memory setup` can open or instruct CLI setup path
- errors use friendly hints

Tests:

- bootstrap ready shown as managed-ready
- opted out shown without warning tone
- failed bootstrap shows retry hint

## Test and Safety Requirements

BabeL-O memory from prior sessions requires:

- never let tests write real `~/.babel-o/config.json`
- use isolated `BABEL_O_CONFIG_FILE=/tmp/...`
- new bootstrap tests must also set `BABEL_O_EVEROS_BOOTSTRAP_FILE=/tmp/...`
- do not run real `git clone` or package-manager commands in unit tests
- mock `spawn`/command detection
- broad auto-formatters remain out of scope; `npm run format:check` is allowed

Suggested focused commands after implementation slices:

```bash
BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json \
BABEL_O_EVEROS_BOOTSTRAP_FILE=/tmp/babel-o-test-everos-bootstrap.json \
NODE_ENV=test npx tsx --test test/everos-bootstrap-store.test.ts

BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json \
BABEL_O_EVEROS_BOOTSTRAP_FILE=/tmp/babel-o-test-everos-bootstrap.json \
NODE_ENV=test npx tsx --test test/runtime.test.ts --test-name-pattern="EverCore|EverOS|memory"

BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json \
BABEL_O_EVEROS_BOOTSTRAP_FILE=/tmp/babel-o-test-everos-bootstrap.json \
NODE_ENV=test npm run typecheck

BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json \
BABEL_O_EVEROS_BOOTSTRAP_FILE=/tmp/babel-o-test-everos-bootstrap.json \
NODE_ENV=test npm run format:check
```

## Security and Privacy Boundaries

- Do not expose local EverOS outside loopback by default.
- Do not store provider API keys in `everos-bootstrap.json`.
- Do not log full API keys, tokens, or auth-bearing URLs.
- Do not clone arbitrary repos unless user explicitly overrides source repo.
- If `BABEL_O_EVERCORE_SOURCE_REPO` is set, display it before cloning.
- Prefer pinned release tags once EverOS has stable releases; source `main` is acceptable only for dev/nightly channel.
- Treat long-term memory results as hints, never authoritative workspace facts.

## Open Decisions

1. **EverOS default source repo URL**
   - Need final canonical URL.
   - Current TODO placeholder: `EverOS/babel-o-evercore`.

2. **EverOS build command**
   - Need final source build contract.
   - Candidate forms:
     - `uv sync && uv run ...`
     - repo-provided `make build`
     - repo-provided `scripts/build.sh`

3. **Where to store source checkout**
   - Proposed: `~/.babel-o/everos/source`.
   - Alternative: XDG data dir, e.g. `~/.local/share/babel-o/everos/source`.
   - Recommendation: keep under `~/.babel-o` for consistency with current BabeL-O config unless broader XDG migration is planned.

4. **Whether first-run prompt belongs in `bbl init` only or any first `bbl chat`**
   - Recommendation: `bbl init` should own the complete wizard; `bbl chat` may show a lightweight one-time prompt only in TTY.

5. **Whether successful bootstrap should enable model-visible MCP tools**
   - Recommendation: no. Keep runtime memory enabled separately from model-visible write-capable tools.

## Verification

Focused validation completed with isolated config paths (`BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json`, `BABEL_O_EVEROS_BOOTSTRAP_FILE=/tmp/babel-o-test-everos-bootstrap.json`):

```bash
NODE_ENV=test npm run typecheck
NODE_ENV=test tsx --test test/everos-bootstrap-store.test.ts test/everos-bootstrap-config.test.ts test/everos-bootstrap.test.ts test/everos-first-run.test.ts test/memory-command.test.ts
NODE_ENV=test tsx --test test/context-assembler.test.ts test/context-regression.test.ts test/runtime.test.ts --test-name-pattern="context|Context|cache|compact|runtime/status|runtime/memory|EverCore"
cd clients/go-tui && go test ./internal/tui -count=1
```

Additional checks:

- Go TUI files were formatted with `gofmt`.
- New bootstrap tests were added to the root `npm test` explicit file list.
- Clone/build behavior is covered with mocked command runners; unit tests never run real `git clone`, package-manager commands, or write real `~/.babel-o` state.

## Success Criteria

This feature is complete when:

1. A fresh user can run `bbl chat`, opt into local memory, and get a ready managed EverOS sidecar without reading env-var docs.
2. A user who chooses "not now" is not prompted again until they explicitly run setup/reset.
3. A user with `BABEL_O_EVERCORE_MODE=external` or `managed` is never prompted and never overwritten.
4. Bootstrap failures are visible, retryable, and non-fatal.
5. Concurrent first-run launches do not corrupt state or duplicate clone/build.
6. Unit tests prove config isolation with `BABEL_O_EVEROS_BOOTSTRAP_FILE=/tmp/...`.
7. The FAQ can be updated from "planned" to "implemented" without changing the architecture wording.
