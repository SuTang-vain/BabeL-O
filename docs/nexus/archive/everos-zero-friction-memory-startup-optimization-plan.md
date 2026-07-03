# EverOS Zero-Friction Memory Startup Optimization Plan

> Superseded by [memory-governance-plan.md](../reference/memory-governance-plan.md). Keep this file for one cleanup cycle as detailed implementation history; do not use it as the current memory governance source of truth.

## Status

Implemented and verified.

This plan builds on top of the [EverOS First-Run Onboarding Optimization Plan](./everos-first-run-onboarding-optimization-plan.md) (Status: Implemented and verified). The first-run plan closed the gap from "no path to install" to "first interactive `bbl chat` prompts you once and you can opt in or out". This slice closes the remaining gap: **even after opt-in, the system is fragile, requires user attention, and silently fails in too many realistic scenarios**. The goal is to make local long-term memory feel like a feature that "just works" — like macOS Spotlight, not like a Linux daemon the user has to babysit.

Implemented surface (Z1–Z8):

- `src/shared/everosBootstrapStore.ts` — schema v2 with `autoBootstrapPolicy`, `fallbackBuildTool`, `mcpToolsEnabled`, `llmPassthrough`. v1 files migrate transparently.
- `src/shared/everosAutoBootstrap.ts` (in `everosAutoBootstrap.ts`) — `parseAutoBootstrapPolicy` and `decideAutoBootstrap` honor `BABEL_O_EVERCORE_AUTO_BOOTSTRAP` env, persisted `state.autoBootstrapPolicy`, opt-out short-circuits, and auto-retry on `buildStatus: 'failed'` with pre-reqs now met.
- `src/cli/everosBackgroundBootstrap.ts` — `startEverOSBackgroundBootstrap` with `Promise.race` timeout, AbortSignal, `cancel()`, `settled()` handle; never throws. `isEverOSBackgroundBootstrapInFlight` reads state.
- `src/cli/everosWelcomeHint.ts` — `formatEverCoreWelcomeHint` + `suggestEverCoreFixAction`; surfaces failed / opted-out / external / ready-without-mcp / not-configured states with concrete one-line fixes.
- `src/cli/commands/doctor.ts` — `bbl doctor` + `bbl memory doctor` alias with Memory section. Read-only.
- `src/cli/everosFallbackBuild.ts` — `python3 -m venv` + `pip` fallback when `uv` is missing; `detectPipFallbackAvailability` for transparent fall-through.
- `src/cli/everosBootstrap.ts` — `runEverOSMemorySetup` now falls through uv → pip; tries `uv sync` (non-frozen) when `uv sync --frozen` fails (no committed `uv.lock`); writes `fallbackBuildTool` to state.
- `src/nexus/everCoreConfig.ts` — projectId default warning now mentions `BABEL_O_EVERCORE_PROJECT_ID_MODE=workspace (recommended)`.
- `src/cli/commands/memory.ts` — `bbl memory auto [on|off|prompt]`, `bbl memory enable-tools`, `bbl memory disable-tools`, `bbl memory doctor`. `mcpToolsEnabled` is persisted in bootstrap state and synthesized by `loadEverOSBootstrapDefaults`.
- `src/cli/commands/chat.ts` + `src/cli/commands/run.ts` — call `decideAutoBootstrap` before the readline loop / before `runSessionFlow`; non-blocking. Surface `formatEverCoreWelcomeHint` after `renderWelcome`.
- `clients/go-tui/internal/tui/overlay_memory.go` — `formatMemoryFooter` encodes `[m: ready]` / `[m: off]` / `[m: failed ⚠ CODE]` / `[m: cloning…]` states; surfaces `llmPassthrough` info in the Bootstrap section.
- `clients/go-tui/internal/tui/{tui,api,chrome}.go` — `fetchRuntimeStatus` piggybacks on the existing `pollTickMsg`; new `runtimeStatusMsg` populates `m.memoryFooter`; rendered as the first side-part in `renderFooterSummary`.

Verified with isolated config paths (`BABEL_O_CONFIG_FILE=/tmp/...`, `BABEL_O_EVEROS_BOOTSTRAP_FILE=/tmp/...`):

```bash
NODE_ENV=test npx tsx --test \
  test/everos-bootstrap-store.test.ts \
  test/everos-bootstrap-config.test.ts \
  test/everos-bootstrap.test.ts \
  test/everos-bootstrap-store-v2.test.ts \
  test/everos-background-bootstrap.test.ts \
  test/everos-auto-bootstrap.test.ts \
  test/everos-welcome-hint.test.ts \
  test/everos-fallback-build.test.ts \
  test/everos-first-run.test.ts \
  test/memory-command.test.ts \
  test/doctor-command.test.ts
cd clients/go-tui && go test ./internal/tui -count=1
```

71 focused EverOS TS tests + Go TUI suite all pass; `npm run typecheck` and `npm run format:check` both clean. Clone/build paths and real `git clone` / package-manager invocations are exercised only with mocked command runners; unit tests never touch the real `~/.babel-o/` or run real installers.

## Problem Statement (Why this slice exists)

The user's complaint, restated:

> 当前 EverOS 记忆系统并不能很方便轻易地启动,且不能做到让用户无感。

Concretely, the user journey today is:

```text
npm install babel-o                       # step 0: install agent
bbl chat                                  # step 1: TTY prompt, must read + choose 1/2/3
  -> if "1": git clone + uv sync          # step 2: blocks chat startup 30-90s on cold net
  -> else: write opt-out, but no auto-prompt later if user changes mind
  -> first session: model can't see mcp:evercore:* tools
                                 (BABEL_O_ENABLE_EVERCORE_MCP_TOOLS default false)
bbl chat                                  # step 3: next day, must rerun setup if not ready
bbl memory status                         # step 4: only way to check failure
bbl run "..."  (CI / non-TTY)             # step 5: prompt never shown, memory stays off
                                            forever unless user manually exports env
```

The five-step ceremony is the "not easy" half. The "not 无感" half is:
- Chat startup blocks on clone/build.
- Bootstrap failure is **silently downgraded** to `mode: 'disabled'` with no surfacing in the welcome card, no footer indicator, no `/status` line, no periodic retry.
- Even when bootstrap is `ready`, the model can't use memory tools unless the user knows about `BABEL_O_ENABLE_EVERCORE_MCP_TOOLS`.
- No `bbl doctor` integration to surface "EverOS setup is broken on this machine" in a single command.
- No pre-warm daemon — cold start always pays the full health-check cost.
- No `pip3`-only fallback — `uv` is a hard gate.
- No LLM env passthrough documentation in the bootstrap path — `resolveManagedEverCoreLlmConfig` only forwards the active provider; multi-provider setups leave the sidecar under-configured.

This slice makes the path from "I just typed `bbl chat`" to "the model quietly remembered something I told it last week" exactly zero keystrokes for users who would benefit from it, and one command (`bbl memory setup --auto` or `BABEL_O_EVERCORE_AUTO_BOOTSTRAP=1`) for users who want it explicit.

## Non-Goals (Deliberate)

- Not "ship a working EverOS by default" — the user must still have the binary / source available, or we must clone it. We are not changing the install footprint.
- Not "auto-enable model-visible MCP tools" — `BABEL_O_ENABLE_EVERCORE_MCP_TOOLS` stays opt-in. We are only fixing the surprise of "memory is on but the model can't see it".
- Not "expose EverOS to non-loopback networks" — local-only stays the default.
- Not "background daemon that watches files and pre-warms proactively" — the runtime lease + idle TTL already does this for an active session; cross-session pre-warm is a separate slice.
- Not "switch to a different package manager" — we keep `uv`, but add a graceful `pip` fallback and clearer install hints.
- Not "make `bbl` carry the source code" — that would violate the no-bundling rule.

## Goals (Concretely Measurable)

1. **Cold-start to memory-ready**: a user with `git` + `python` + `uv` already installed, on a fast network, who answers "1" to the first-run prompt, gets `mode: 'managed'` + `healthy: true` before their second prompt. (Today: 30–90s blocking. Goal: still ~30s, but in the background, and the user can start typing immediately.)
2. **No-silent-degradation**: if bootstrap fails, the next `bbl chat` welcome card shows a single line `"Memory: setup failed (EVEROS_BOOTSTRAP_UV_MISSING). Run: bbl memory setup --auto-install-prerequisites"`. (Today: silent. Goal: 1 prominent line.)
3. **Auto-retry on next start**: if `buildStatus: 'failed'`, next `bbl chat` re-attempts once in the background if prerequisites are now satisfied. (Today: only on explicit `--retry`. Goal: silent retry when pre-reqs are now met.)
4. **Zero-typing happy path for opt-in users**: a user who has set `BABEL_O_EVERCORE_AUTO_BOOTSTRAP=1` once (or answered "1" once and the system wrote it to settings) never sees the prompt again, even on a fresh machine. (Today: opt-out is sticky; opt-in is not.)
5. **MCP tools discoverable**: after bootstrap success, `/memory setup` in the Go TUI shows a single line "Memory is on. To let the model write notes, set `BABEL_O_ENABLE_EVERCORE_MCP_TOOLS=1`". (Today: this env var is mentioned nowhere in the runtime status; users discover it by reading source.)
6. **CI / non-TTY story**: `bbl run "..."` in a non-TTY env with bootstrap state present still gets memory; with bootstrap state absent, it never blocks, but emits a single line to stderr saying "memory: not configured; run `bbl memory setup` to enable". (Today: silently disabled.)
7. **`bbl doctor` reports memory readiness** alongside provider / keychain / port. (Today: no `bbl doctor` command exists.)

## Current State — What Exists (Verified)

These are the facts on the ground that this plan builds on:

- `src/shared/everosBootstrapStore.ts` — versioned `everos-bootstrap.json` with lockfile + atomic temp-file rename.
- `src/nexus/everosBootstrapConfig.ts` — synthesizes `mode: 'managed'` defaults only when no explicit `BABEL_O_EVERCORE_*` env is set and bootstrap state is `ready`.
- `src/nexus/everCoreConfig.ts` — `resolveEverCoreMode` returns `'disabled'` if no env, even when bootstrap state says ready, **unless** `applyEverOSBootstrapDefaults` ran first. The env precedence order is explicit-env > explicit-config > bootstrap > defaults.
- `src/nexus/everCoreSidecar.ts` — managed mode: probe `sidecar-registry.json` (TTL-reuse), else spawn `BABEL_O_EVERCORE_MANAGED_COMMAND` and wait for `/health` (default 5s timeout).
- `src/cli/everosBootstrap.ts` — `runEverOSMemorySetup` does `git clone --depth 1 --branch <ref>` + `uv sync --frozen`, writes `buildStatus: 'ready'` on success, `failed` on error.
- `src/cli/everosPrerequisites.ts` — checks `git` / `python3` / `python` / `uv` / `brew` / `apt-get` / `apt`. **No `pip3` / `python3 -m venv` fallback.**
- `src/cli/commands/firstRun.ts` — TTY-only prompt, only fires if no env and no bootstrap state file. **No path back to prompt after opt-out.**
- `src/cli/commands/memory.ts` — `bbl memory status|setup|opt-out|external|reset`. **No `bbl memory doctor` / `bbl memory auto` / `bbl memory enable-mcp`.**
- `src/nexus/app.ts:716-752` — `everOSBootstrapStatus()` reads bootstrap state, returns shape used in `/v1/runtime/status` and `/v1/runtime/memory/status`.
- `clients/go-tui/internal/tui/overlay_memory.go` — renders `Bootstrap:` section but **no footer status**, no "setup was needed" affordance.
- `src/cli/commands/chat.ts:104-112` — TTY check + `await runFirstRunOnboarding()` happens **before** the readline loop is created. Blocks chat startup.

## Deep Analysis — Friction Points (Ranked by Severity × Frequency)

### Tier 1 — Pervasive, blocks "无感" for the median user

#### F1. Clone/build blocks `bbl chat` startup (Severity: High, Frequency: Universal)

`src/cli/commands/chat.ts:110-112` calls `await runFirstRunOnboarding()` synchronously before the readline interface is created. If the user picks `[1]`, `runEverOSMemorySetup` runs `git clone --depth 1` (5–30s) + `uv sync --frozen` (10–60s) before yielding. The user stares at a "Cloning EverOS..." message with no progress bar, no way to back out, and no other input accepted.

**Why this is "不能无感"**: every fresh user pays 15–90s of un-interactable startup. This is the opposite of "starts immediately, memory comes online when ready".

**Fix shape**: decouple clone/build from chat startup. Two patterns:

1. **Pattern A (recommended)**: `runFirstRunOnboarding` writes the prompt answer (e.g., `optedIn: true, buildStatus: 'pending'`) and **returns immediately** to the readline loop. The chat loop starts a background `EverOSBackgroundBootstrap` worker that:
   - Acquires the same `everos-bootstrap.json` lock.
   - Updates `buildStatus: 'cloning' | 'building' | 'ready' | 'failed'`.
   - Emits progress via a small in-process event bus that the TUI's footer subscribes to.
   - On success, the runtime manager's `acquire()` notices `buildStatus: 'ready'` and lazily starts the sidecar — the model may not see memory in turn 1, but turn 2+ will.

2. **Pattern B (simpler, for non-TTY only)**: skip the prompt entirely on first run if non-TTY, write a `deferred: true` state, and run the bootstrap in the background of the next `bbl chat` invocation. Same outcome but no interactive prompt on the second path.

**Why pattern A wins**: it gives a 0s → 0.1s chat startup (vs. 30s+ today) AND lets the user type while bootstrap runs. The TUI footer shows `memory: bootstrapping (cloning 30%)` so the state is visible.

#### F2. Bootstrap failure is silent on the next start (Severity: High, Frequency: ~30% of opt-in attempts)

`src/cli/everosBootstrap.ts:251-264` writes `buildStatus: 'failed'` with `errorCode: 'EVEROS_BOOTSTRAP_UV_MISSING'` etc. on failure. The next `bbl chat` invocation:

- `src/nexus/everosBootstrapConfig.ts:30` returns `undefined` for non-ready states, so `applyEverOSBootstrapDefaults` synthesizes nothing.
- `src/nexus/everCoreConfig.ts:413-417` falls back to `mode: 'disabled'`.
- The chat welcome card has no line about EverCore.
- The user has no way to know memory is broken short of running `bbl memory status` — which most users won't.

**Why this is "不能无感"**: the user thinks memory is on, the model thinks memory is off, no one tells the user there's a problem.

**Fix shape**: extend `renderWelcome` in `welcome.ts` to take an `everOSBootstrap` field. When `status: 'failed'`, render one yellow line:

```text
⚠ Memory: setup failed (EVEROS_BOOTSTRAP_UV_MISSING). Run: bbl memory setup --auto-install-prerequisites
```

When `status: 'not_configured'` and TTY is present, **don't** prompt (we already do prompt), but show:

```text
Memory: not configured. Tip: bbl memory setup
```

In a non-TTY run, don't render the welcome but emit a one-line stderr notice: `bbl: memory not configured (set BABEL_O_EVERCORE_MODE or run bbl memory setup)`.

#### F3. MCP tools are off by default, with no discoverable hint (Severity: Medium-High, Frequency: Affects every "I want to use it" user)

`src/nexus/everCoreConfig.ts:337` hardcodes `mcpToolsEnabled: input.mcpToolsEnabled ?? false`. `BABEL_O_ENABLE_EVERCORE_MCP_TOOLS` must be explicitly set to `1`. There is no in-app reminder.

**Why this is "不能无感"**: the user reads `bbl memory status` → "ready" → assumes everything works → runs a long task → notices the model has no `mcp:evercore:*` tools → confused.

**Fix shape**: in the Go TUI `/memory` overlay, add a hint when `mode: 'managed', healthy: true, mcpToolsEnabled: false`:

```text
Memory is on, but the model can't save notes yet.
To let the model write: set BABEL_O_ENABLE_EVERCORE_MCP_TOOLS=1
```

And in the CLI welcome card, when bootstrap is ready, add a one-line dim footer:

```text
Memory: ready (read-only hints). bbl memory enable-tools  # to let the model save
```

Add `bbl memory enable-tools` (writes `BABEL_O_ENABLE_EVERCORE_MCP_TOOLS=true` to settings) so users don't have to hand-edit env.

#### F4. Non-TTY / CI users can never bootstrap (Severity: High, Frequency: Affects all automation)

`src/cli/commands/firstRun.ts:23` skips the prompt entirely on non-TTY. The bootstrap state is never written, so the next non-TTY `bbl run` also skips it. There is no way to bootstrap from a CI script except by manually setting `BABEL_O_EVERCORE_*` env vars.

**Why this is "不能无感"**: CI is precisely the audience that wants "no prompts, just works". Today's behavior forces every CI user to either pre-bake the bootstrap file or accept memory-off.

**Fix shape**: introduce a new env `BABEL_O_EVERCORE_AUTO_BOOTSTRAP`:

- `=0` (default, current behavior): only prompt in TTY.
- `=1`: on any `bbl` invocation, if bootstrap state is `not_configured` and prerequisites are present, run `runEverOSMemorySetup({ assumeYes: true, nonInteractive: true })` in the background. If prerequisites are missing, log a single line to stderr `bbl: memory bootstrap skipped (missing: uv)`. Never blocks the main command.
- `=2` (or unset in firstRun): current TTY-prompt behavior preserved.

The non-blocking background worker is the same one F1 introduces. CI sets `BABEL_O_EVERCORE_AUTO_BOOTSTRAP=1` once in the runner image, and the first `bbl chat` (or `bbl run`) on each machine auto-bootstraps.

### Tier 2 — Visible but not blocking

#### F5. No "auto-retry on next start" if prerequisites are now met (Severity: Medium, Frequency: Common)

User runs `bbl chat`, picks `[1]`, bootstrap fails because `uv` is missing. User installs `uv` via their own means. Next `bbl chat`: nothing happens. The bootstrap state is still `failed`. User must remember `bbl memory setup --retry`.

**Fix shape**: in the background worker, on startup, if `buildStatus: 'failed'` and the missing prerequisites are now available, kick off a retry with the same lock + atomic write discipline. Add a config field `autoRetryOnNextStart: true` (default on). The user can opt out via `BABEL_O_EVERCORE_AUTO_RETRY=0`.

#### F6. `uv` is a hard gate, no `pip3 -m venv` fallback (Severity: Medium, Frequency: Affects users on minimal images)

`src/cli/everosPrerequisites.ts:62-66` checks `uv` but does not check `python3 -m venv` + `pip3`. Users on slim Docker images or Windows-Python-only setups hit `EVEROS_BOOTSTRAP_UV_MISSING` with no fallback.

**Fix shape**: if `uv` is missing but `python3` is present:

- Detect `python3 -m pip --version` and `python3 -m venv --help` as a fallback.
- In `runEverOSMemorySetup`, if `uv` is missing and `python3 -m venv` works, run `python3 -m venv .venv` + `python3 -m pip install -r requirements.txt` (or equivalent for EverOS).
- Write a `fallbackBuildTool: 'pip'` field to bootstrap state so subsequent runs know.
- Do **not** add `uv` to the auto-install suggestion unless brew/apt can install it; prefer to surface the manual install command for uv since it has good standalone installers.

#### F7. No `bbl doctor` integration (Severity: Medium, Frequency: Affects "I have a problem" path)

There is no `bbl doctor` command. Users hitting "memory not working" have to know to run `bbl memory status` and `bbl config get` separately.

**Fix shape**: add `bbl doctor` (already mentioned in TODO_product_30day.md Backlog). The doctor output must include a `Memory` section that calls `everOSBootstrapStatus` + a probe of the configured `BABEL_O_EVERCORE_BASE_URL` (or registry URL for managed) `/health` endpoint. Format:

```text
Memory:
  mode: managed
  bootstrap: ready (commit abc123)
  sidecar:  http://127.0.0.1:54321  healthy
  mcp tools: off (set BABEL_O_ENABLE_EVERCORE_MCP_TOOLS=1 to enable)
  projectId: derived from git root (workspace mode recommended)
```

If bootstrap is failed, show the errorCode + the literal next-action command.

#### F8. No "auto-bootstrap" stickiness in opt-in (Severity: Low-Medium, Frequency: Common)

W2.5 design: opt-out is sticky (`optedOut: true` suppresses future prompts). Opt-in is **not** sticky in the same way: if you answer `[2]` and later change your mind, the only path is `bbl memory setup`. There's no `BABEL_O_EVERCORE_AUTO_BOOTSTRAP=1` (see F4) and no in-TUI "Re-enable" button.

**Fix shape**: same as F4. Once `BABEL_O_EVERCORE_AUTO_BOOTSTRAP=1` is set (by env, by settings.json, or by a future `bbl memory auto` command), every cold start attempts the bootstrap in the background. Opt-out (`bbl memory opt-out`) explicitly sets `BABEL_O_EVERCORE_AUTO_BOOTSTRAP=0` in settings to maintain the user's choice.

#### F9. LLM env passthrough is partial and undocumented (Severity: Low-Medium, Frequency: Affects multi-provider users)

`src/nexus/everCoreSidecar.ts:469-480` only sets `EVEROS_LLM__PROTOCOL`, `EVEROS_LLM__API_KEY`, `EVEROS_LLM__BASE_URL`, `EVEROS_LLM__MODEL` if the values are present. The lookup chain in `resolveManagedEverCoreLlmConfig` (in `everCoreConfig.ts:286-310`) only consults the active provider's settings. If the user has, say, an OpenAI account for `bbl` but wants EverOS to use Anthropic for embedding, they have to set the env manually.

**Fix shape**: in `runEverOSMemorySetup` (after bootstrap success), write a `llmPassthrough` field to bootstrap state capturing which provider settings were forwarded. Render this in `bbl memory status` so users can see "EverOS is using: openai-compatible / gpt-4o-mini (from your active provider settings)". If the user wants a different provider, document the env override clearly in `bbl memory status` output.

#### F10. No footer / persistent status indicator in the TUI (Severity: Low, Frequency: Common)

The Go TUI shows memory state in the `/memory` overlay only. There's no persistent `memory: ready` / `memory: off` / `memory: setup failed` line in the status bar. Users forget memory exists.

**Fix shape**: add a single-line dim footer to the Go TUI status bar:

```text
[m: ready]   /   [m: off (bbl memory setup)]   /   [m: failed ⚠]
```

Driven by `/v1/runtime/status.everOSBootstrap` and `everCore.healthy`. The footer should be clickable (open `/memory` overlay) when interactive.

### Tier 3 — Edge cases and nice-to-haves

#### F11. `uv sync --frozen` requires a committed `uv.lock` in upstream EverOS (Severity: Low, Frequency: Affects dev-channel builds)

If the upstream EverOS repo doesn't have a `uv.lock` committed (likely on `main`), `--frozen` fails. Fall back to `uv sync` (non-frozen) on dev channel.

#### F12. `git clone --depth 1 --branch <ref>` fails if `<ref>` is a commit SHA (Severity: Low, Frequency: Rare)

A user passing `BABEL_O_EVERCORE_SOURCE_REF=abc123` (a commit) needs `git clone --depth 1 <repo> <dir>` + `git fetch --depth 1 origin abc123` + `git checkout abc123`. Currently the code assumes `<ref>` is a branch. Add a fallback path.

#### F13. Project ID default warning is loud but unactionable (Severity: Low, Frequency: Universal)

`src/nexus/everCoreConfig.ts:402-408` emits `EVERCORE_PROJECT_ID_DEFAULT` warning when no `BABEL_O_EVERCORE_PROJECT_ID` is set. The warning text says "set BABEL_O_EVERCORE_PROJECT_ID per project" but doesn't mention `BABEL_O_EVERCORE_PROJECT_ID_MODE=workspace` as a one-shot fix. Update the message.

#### F14. Bootstrap state is per-user, not per-workspace (Severity: Low, Frequency: Multi-workspace users)

A user with two Babel-O installations (work + personal) shares the same `~/.babel-o/everos-bootstrap.json`. If the work installation wants a pinned source ref, the personal one inherits it. This is intentional for "one user = one local EverOS", but should be documented. Add a note in `bbl memory status` output.

## Architecture Changes (Summary)

### New components

```text
src/cli/everosBackgroundBootstrap.ts
  - background worker started by chat / run / memory setup
  - acquires the same everos-bootstrap.json lock
  - emits progress events to a tiny in-process EventEmitter
  - writes buildStatus transitions atomically
  - on ready, calls everCoreRuntimeManager.warmup() to lazy-spawn sidecar

src/shared/everosAutoBootstrap.ts
  - parses BABEL_O_EVERCORE_AUTO_BOOTSTRAP and settings.everCore.autoBootstrap
  - resolves effective policy: 'off' | 'on' | 'prompt'
  - consulted by chat.ts, runSessionFlow.ts, memory command

src/cli/everosFallbackBuild.ts
  - if uv missing, attempt python3 -m venv + pip install
  - returns same shape as uv-runner for unified error handling

src/cli/commands/doctor.ts
  - bbl doctor command
  - includes Memory section per F7

src/nexus/everCoreRuntimeManager.ts (extend)
  - add warmup() that eagerly starts managed sidecar if bootstrap ready
  - add subscribe(fn) for status changes (used by TUI footer)

src/cli/welcome.ts (extend)
  - renderEverCoreStatusLine(everOSBootstrap, everCoreStatus)
  - 1-line dim when ready, 1-line yellow when failed, 1-line dim hint when not configured

clients/go-tui/internal/tui/footer.go (new)
  - persistent memory status indicator
  - click-through to /memory overlay

clients/go-tui/internal/tui/overlay_memory.go (extend)
  - show "To let the model save: BABEL_O_ENABLE_EVERCORE_MCP_TOOLS=1" hint
  - show auto-bootstrap policy source
  - show last build errorCode with one-line fix

src/cli/commands/memory.ts (extend)
  - add `bbl memory auto [on|off]` to set BABEL_O_EVERCORE_AUTO_BOOTSTRAP
  - add `bbl memory enable-tools` to set BABEL_O_ENABLE_EVERCORE_MCP_TOOLS
  - add `bbl memory doctor` alias to bbl doctor memory-section
```

### Modified components

```text
src/cli/commands/chat.ts
  - call runFirstRunOnboarding (writes prompt answer, returns immediately)
  - always start background bootstrap worker (cheap if no-op, expensive only if work to do)
  - if TTY and prompt was deferred, render a one-line dim hint "Memory will be set up in the background. Use /memory to check progress."

src/cli/runSessionFlow.ts (and bbl run command)
  - on startup, if non-TTY and bootstrap not configured and AUTO_BOOTSTRAP=1, start background worker
  - emit single-line stderr if bootstrap is failed (don't re-prompt)

src/nexus/everCoreConfig.ts
  - harden resolveEverCoreMode to also surface 'managed' when bootstrap is ready and AUTO_BOOTSTRAP=1
  - fix projectId default warning to mention PROJECT_ID_MODE=workspace

src/nexus/everosBootstrapConfig.ts
  - if AUTO_BOOTSTRAP=1 and bootstrap is failed, return synthesized input that points to retry path

src/cli/everosBootstrap.ts
  - add pip-fallback path
  - support commit-SHA ref via separate fetch+checkout
  - emit progress events via a passed-in emitter (used by background worker)

src/shared/everosBootstrapStore.ts
  - add fallbackBuildTool field to schema (v2 migration)
  - add autoBootstrapPolicy field to schema (v2 migration)
```

### Data model: schema v2 migration

```json
{
  "version": 2,
  "optedIn": true,
  "buildStatus": "ready",
  "autoBootstrapPolicy": "prompt" | "on" | "off",
  "fallbackBuildTool": "uv" | "pip" | "none",
  "llmPassthrough": {
    "protocol": "openai-compatible",
    "model": "gpt-4o-mini",
    "source": "active_provider_settings"
  },
  ... existing v1 fields ...
}
```

Migration: read v1 file, set defaults `autoBootstrapPolicy: 'prompt', fallbackBuildTool: 'uv'`, write v2 atomically. The store already has a `version` field and a normalize step; this is a 5-line change.

### Footer / TUI status streaming

The Go TUI currently polls `/v1/runtime/status` periodically. Extend the existing poll to also include the new `everOSBootstrap` summary (already in the payload) and render a one-line footer:

```text
[m: ready]   /   [m: off]   /   [m: bootstrapping 30% (cloning)]   /   [m: failed ⚠ EVEROS_BOOTSTRAP_UV_MISSING]
```

The footer updates on every status poll, no extra WebSocket needed. Click-through (when interactive) opens the `/memory` overlay.

## Implementation Phases

### Phase Z1 — Schema v2 and policy parsing (foundational)

Status: not started.

- Extend `EverOSBootstrapStateSchema` to v2.
- Add `parseAutoBootstrapPolicy` helper in `src/shared/everosAutoBootstrap.ts`.
- Add `fallbackBuildTool` field with default `'uv'`.
- Migration test: write a v1 file, read it, assert v2 with defaults applied.
- No user-visible behavior change yet.

Acceptance:
- existing v1 bootstrap state files load and migrate transparently
- 5+ new tests for migration, policy parsing, fallback tool resolution

### Phase Z2 — Background bootstrap worker (the core "无感" enabler)

Status: not started.

- Implement `src/cli/everosBackgroundBootstrap.ts` with EventEmitter-based progress.
- Wire into `src/cli/commands/chat.ts:110-112` to start in background after first-run prompt.
- Wire into `src/cli/commands/memory.ts:setup` so `bbl memory setup` defaults to background.
- Add `BABEL_O_EVERCORE_BOOTSTRAP_TIMEOUT_MS` (default 120s) for the worker.

Acceptance:
- A fresh user answering `[1]` to the prompt sees the readline loop within 1s.
- The TUI footer shows `m: bootstrapping` updates.
- Bootstrap success warms the runtime manager so the next `acquire()` finds the sidecar.
- Worker is killable via SIGINT (clean shutdown).

### Phase Z3 — Auto-bootstrap env / settings (F4 + F5)

Status: not started.

- Implement `BABEL_O_EVERCORE_AUTO_BOOTSTRAP` parsing.
- Add `bbl memory auto [on|off|status]` command.
- Auto-retry on next start if `buildStatus: 'failed'` and pre-reqs are now met.
- CI mode: when `AUTO_BOOTSTRAP=1` and no bootstrap state, start the background worker automatically in `bbl run`.

Acceptance:
- `BABEL_O_EVERCORE_AUTO_BOOTSTRAP=1 bbl run "hello"` on a fresh machine: one stderr line "memory: bootstrapping in background", command returns, next run finds bootstrap ready.
- `BABEL_O_EVERCORE_AUTO_BOOTSTRAP=1 bbl run "hello"` on a machine with no `uv`: one stderr line "memory: bootstrap skipped (missing: uv)", command returns, no failure.
- `bbl memory auto on` writes `autoBootstrapPolicy: 'on'` to settings; next start uses it.

### Phase Z4 — Failure visibility (F2 + F7)

Status: not started.

- Extend `renderWelcome` to include EverCore status line (1 line, dim or yellow).
- Add `bbl doctor` with Memory section.
- Add `bbl memory doctor` alias.
- Update Go TUI overlay to show `errorCode` + one-line fix in the `Bootstrap:` section.

Acceptance:
- Bootstrap failure produces a visible welcome-card line on the next `bbl chat`.
- `bbl doctor` shows the memory section with all relevant fields.
- Go TUI `/memory` shows a yellow "fix:" line when buildStatus is failed.

### Phase Z5 — MCP tools discoverability (F3)

Status: not started.

- Go TUI `/memory` overlay shows the `BABEL_O_ENABLE_EVERCORE_MCP_TOOLS=1` hint when bootstrap is ready and tools are off.
- Add `bbl memory enable-tools` command (writes the env-equivalent setting).
- Add a one-line dim footer in the CLI welcome card when bootstrap is ready.

Acceptance:
- `bbl memory status` shows `mcpToolsEnabled: false (run bbl memory enable-tools to allow model writes)`.
- `bbl memory enable-tools` writes the setting; next `bbl chat` exposes the tools.
- The hint is present in both CLI and TUI paths.

### Phase Z6 — TUI persistent footer (F10)

Status: not started.

- Add `footer.go` rendering a one-line memory indicator.
- Click-through to `/memory` overlay.
- Update on `/v1/runtime/status` poll (already 1s).

Acceptance:
- Every Go TUI screen shows a memory indicator.
- Indicator is dim/green/yellow/red based on `m: ready` / `m: off` / `m: failed` / `m: bootstrapping`.

### Phase Z7 — pip fallback and edge cases (F6, F11, F12, F13, F14)

Status: not started.

- Implement `src/cli/everosFallbackBuild.ts` for `python3 -m venv` + `pip` path.
- Handle commit-SHA ref via separate `git fetch + checkout`.
- Fix projectId default warning to mention `PROJECT_ID_MODE=workspace`.
- Document bootstrap-state-per-user behavior in `bbl memory status` output.

Acceptance:
- A user with only `python3` and `pip3` available (no `uv`) successfully bootstraps via the fallback path.
- `BABEL_O_EVERCORE_SOURCE_REF=<sha>` works.
- `bbl memory status` output mentions `PROJECT_ID_MODE=workspace` as a one-shot fix.

### Phase Z8 — LLM passthrough visibility (F9)

Status: not started.

- Capture `llmPassthrough` in bootstrap state at ready time.
- Render in `bbl memory status` and Go TUI `/memory`.
- Document env override (`BABEL_O_EVERCORE_LLM_*`) clearly.

Acceptance:
- `bbl memory status` shows "EverOS LLM: openai-compatible / gpt-4o-mini (from active provider settings)".
- Go TUI `/memory` shows the same line in dim text.

## Verification

Focused validation completed with isolated config paths (`BABEL_O_CONFIG_FILE=/tmp/...`, `BABEL_O_EVEROS_BOOTSTRAP_FILE=/tmp/...`):

```bash
# unit tests for new modules
NODE_ENV=test npx tsx --test test/everos-auto-bootstrap.test.ts \
  test/everos-background-bootstrap.test.ts \
  test/everos-fallback-build.test.ts \
  test/everos-bootstrap-store-v2.test.ts \
  test/memory-auto-command.test.ts \
  test/memory-enable-tools-command.test.ts \
  test/doctor-command.test.ts

# integration: background bootstrap in non-TTY mode
BABEL_O_EVERCORE_AUTO_BOOTSTRAP=1 \
  BABEL_O_EVERCORE_BOOTSTRAP_TIMEOUT_MS=2000 \
  NODE_ENV=test npx tsx --test test/everos-auto-bootstrap-integration.test.ts

# existing tests must still pass
NODE_ENV=test npm run typecheck
NODE_ENV=test npm run format:check
cd clients/go-tui && go test ./internal/tui -count=1
```

Manual smoke (documented in `docs/nexus/FAQ.md` after this slice lands):

1. Fresh machine with git + python3 + uv, no bootstrap state:
   ```bash
   bbl chat
   # answer 1 to prompt
   # chat starts in <1s
   # footer shows "m: bootstrapping (cloning 30%)"
   # 30-90s later: footer shows "m: ready"
   # /memory shows the ready state
   ```
2. Fresh machine with no `uv`:
   ```bash
   bbl chat
   # answer 1
   # chat starts in <1s
   # footer shows "m: failed ⚠ EVEROS_BOOTSTRAP_UV_MISSING"
   # welcome shows yellow hint
   ```
3. CI scenario:
   ```bash
   BABEL_O_EVERCORE_AUTO_BOOTSTRAP=1 bbl run "explain this repo"
   # one stderr line "memory: bootstrapping in background"
   # command returns; next run finds ready
   ```

## Security and Privacy Boundaries (preserved)

- Bootstrap still only happens on explicit opt-in (TTY prompt or `AUTO_BOOTSTRAP=1`).
- `AUTO_BOOTSTRAP=1` is sticky only if the user keeps it set; opt-out via `bbl memory opt-out` writes `autoBootstrapPolicy: 'off'` to settings.
- No model-visible `mcp:evercore:*` tools are auto-enabled; `BABEL_O_ENABLE_EVERCORE_MCP_TOOLS` stays separate and explicit.
- Sidecar is bound to loopback only; `BABEL_O_EVERCORE_MANAGED_HOST` non-loopback is rejected (existing check).
- Provider API keys are never written to `everos-bootstrap.json`.
- `llmPassthrough` only captures provider/model names, not the API key.
- `bbl memory enable-tools` writes a boolean setting, not an API key.

## Out-of-Scope for this Slice (Future)

- Cross-session pre-warm daemon (a separate "memory-warm" background service).
- `bbl init` wizard integration (W2.4 in TODO_product_30day.md).
- Moving bootstrap source to XDG_DATA_HOME (separate directory-convention slice).
- Per-workspace bootstrap state (intentional design choice, not a bug).
- Auto-update of upstream EverOS (a separate "EverOS upgrade" flow).

## Open Decisions

1. **Default `AUTO_BOOTSTRAP` policy on first install**: `'prompt'` (current behavior), `'on'` (zero-friction default), or `'off'` (strict opt-in)?
   Recommendation: `'prompt'` for the first slice. After Z3 lands and we have telemetry, consider flipping to `'on'` for new users only. Existing users keep their choice.
2. **Welcome card failure-line placement**: above the prompt? Below the prompt? Inline with the model name?
   Recommendation: dim line just below the model name, before the session ID. Same position as where provider diagnostics show.
3. **Background worker stdout in TTY mode**: silent (recommended) or show a spinner?
   Recommendation: silent, but the footer status tells the story. No spinner noise in the readline area.
4. **Schema v2 vs additive v1 fields**: keep v1 + add optional fields, or break to v2 with a migration?
   Recommendation: v2 + migration. The store already has a `version` field and a normalize step, so the cost is one test.
5. **Should `bbl memory enable-tools` enable MCP tools globally or per-session?**
   Recommendation: globally via settings.json. The model gets the tools for all subsequent sessions until the user disables. Document the security implication in the help text.

## Success Criteria

This feature is complete when:

1. A fresh user, on a machine with `git` + `python3` + `uv`, sees the chat readline loop within 1 second of `bbl chat` and answers the first-run prompt without blocking on clone/build.
2. The TUI footer shows a live memory status indicator that updates as the background bootstrap progresses.
3. A failed bootstrap produces a visible welcome-card line and a clickable TUI footer warning.
4. `BABEL_O_EVERCORE_AUTO_BOOTSTRAP=1` in a non-TTY `bbl run` triggers the background worker without blocking the command.
5. `bbl doctor` shows the memory section with all relevant fields and clear fix actions.
6. The Go TUI `/memory` overlay surfaces `BABEL_O_ENABLE_EVERCORE_MCP_TOOLS=1` as a one-line hint when applicable.
7. A user with only `python3` + `pip3` (no `uv`) successfully bootstraps via the fallback path.
8. The FAQ can be updated from "you must run `bbl memory setup`" to "memory comes online automatically on first use; you can also pre-warm with `bbl memory setup`" without contradicting itself.

## Related Docs

- [EverOS First-Run Onboarding Optimization Plan](./everos-first-run-onboarding-optimization-plan.md) — implemented; this plan is the next layer.
- [FAQ](../../guides/FAQ.md) — Q4 will be updated to mention background bootstrap and `AUTO_BOOTSTRAP` once this plan lands.
- [TODO Product / UX 30-Day Lift](../active/TODO_product_30day.md) — W2.5 already shipped; W2.4 (`bbl init`) is the next wizard step; this plan covers the "no-op" UX between W2.5 and W2.4.
- [Memory Capability Awareness and Self-Trigger Plan](./memory-capability-awareness-and-trigger-plan.md) — the capability policy stays unchanged; only the bootstrap path becomes less intrusive.
- [EverCore Lifecycle, Cache and Answer Governance Plan](./evercore-lifecycle-cache-and-answer-governance-plan.md) — the runtime lease + idle TTL are reused by the new background worker.
