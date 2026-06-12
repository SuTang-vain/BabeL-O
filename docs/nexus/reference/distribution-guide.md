# BabeL-O Distribution Guide

## Purpose

This guide is the operational companion to [distribution-strategy-plan.md](./distribution-strategy-plan.md). The strategy document explains where distribution should go; this guide explains how to ship, install, verify, and debug the current release line.

The current official user entrypoint is the Go TUI:

```sh
bbl go
```

The legacy TypeScript TUI remains a development/debugging path. User-facing distribution work should optimize for `bbl go` first.

## Supported Channels

| Channel | Status | Intended audience | Notes |
| --- | --- | --- | --- |
| `curl \| bash` | Current zero-dependency channel | Users who want one command | Installs `bbl-*` plus `go-tui-*` from the same GitHub release. On macOS it installs a shell wrapper that bypasses Node SEA spawning the Go TUI. |
| GitHub release assets | Current source of truth | Maintainers and manual installers | Every product release must publish matching `bbl-*` and `go-tui-*` assets. |
| npm | Planned developer channel | Node developers | Should use a normal Node wrapper and postinstall Go TUI asset download, not SEA. |
| Homebrew tap | Planned user channel | macOS/Linux users | Should install the same product payload as `install.sh`. After the Go launcher lands, this becomes one `bbl` binary. |
| Go launcher | Target architecture | All users | Replaces Node SEA as the production launcher. |

## Current `install.sh` Contract

`scripts/install.sh` installs:

1. The platform `bbl-*` asset to `$BBL_INSTALL_DIR/bbl`, defaulting to `/usr/local/bin` or `~/.local/bin`.
2. The matching `go-tui-*` asset to `$BBL_GO_TUI_INSTALL_DIR`, defaulting to `~/.local/share/babel-o/bin`.
3. On macOS, a generated shell launcher at `bbl`, with the downloaded SEA payload moved to `bbl.sea`.

The macOS shell launcher exists because v0.3.3 uses a Node.js SEA binary, and SEA can fail to `child_process.spawn()` a valid Go TUI Mach-O with `ENOENT`. The shell wrapper keeps non-Go commands delegated to `bbl.sea`, but handles `bbl go` by starting local Nexus when needed and then `exec`ing the Go TUI directly.

Generated macOS layout:

```text
~/.local/bin/bbl       # shell wrapper
~/.local/bin/bbl.sea   # original Node SEA payload
~/.local/share/babel-o/bin/go-tui-darwin-arm64
```

Linux currently keeps the downloaded `bbl-*` payload as `bbl`; the shell wrapper is macOS-only.

## Install Commands

Latest release:

```sh
curl -fsSL https://raw.githubusercontent.com/SuTang-vain/BabeL-O/main/scripts/install.sh | bash
```

Specific release:

```sh
curl -fsSL https://raw.githubusercontent.com/SuTang-vain/BabeL-O/main/scripts/install.sh | BBL_VERSION=v0.3.3 bash
```

Custom install paths:

```sh
curl -fsSL https://raw.githubusercontent.com/SuTang-vain/BabeL-O/main/scripts/install.sh | \
  BBL_INSTALL_DIR="$HOME/bin" \
  BBL_GO_TUI_INSTALL_DIR="$HOME/.local/share/babel-o/bin" \
  bash
```

Skip smoke only for debugging:

```sh
BBL_INSTALL_SMOKE=0
```

Install only the CLI payload, without Go TUI:

```sh
BBL_INSTALL_GO_TUI=0
```

That mode is not a normal user install because `bbl go` needs a Go TUI binary.

## Post-Install Verification

Run these after install:

```sh
bbl --version
bbl go --check --no-start-nexus
bbl go
```

Expected `bbl go --check --no-start-nexus` behavior:

- Reports the Go TUI binary search order.
- Runs the selected Go TUI with `--version`.
- Reports Nexus health as `OK` or `WARN`.
- Does not start Nexus during the check.
- Exits non-zero only for install failures, such as missing or non-executable Go TUI assets, or known version incompatibility.

On macOS curl installs, `bbl go` should use the shell wrapper and should not depend on Node SEA spawning the Go TUI.

## Release Checklist

Before creating a release tag:

- `npm run typecheck`
- `npm run format:check`
- `npm run build:smoke`
- `npm test`
- Go TUI tests from `clients/go-tui`
- Installer tests:

```sh
npx tsx --test --test-concurrency=1 test/install-script.test.ts test/go-command.test.ts
```

Release assets must include matching platform pairs:

```text
bbl-darwin-arm64
go-tui-darwin-arm64
bbl-darwin-x64
go-tui-darwin-x64
bbl-linux-x64
go-tui-linux-x64
```

If a `bbl-*` asset is published without the matching `go-tui-*` asset, `install.sh` should fail clearly rather than install a partial `bbl go`.

After release publication:

```sh
tmp="$(mktemp -d)"
curl -fsSL https://raw.githubusercontent.com/SuTang-vain/BabeL-O/main/scripts/install.sh | \
  BBL_VERSION=vX.Y.Z BBL_INSTALL_DIR="$tmp/bin" HOME="$tmp/home" bash
"$tmp/bin/bbl" --version
"$tmp/bin/bbl" go --check --no-start-nexus
```

On macOS, also inspect:

```sh
file "$tmp/bin/bbl"
file "$tmp/bin/bbl.sea"
```

Expected:

- `bbl` is a shell script.
- `bbl.sea` is the SEA Mach-O payload.

## Troubleshooting

### Release asset returns 404

Symptom:

```text
curl: (56) The requested URL returned error: 404
```

Likely cause:

- The release tag exists, but binary assets are not uploaded yet.
- The installer maps the platform to an asset that was not built.

Action:

- Check the GitHub release asset list.
- Do not announce the release until all required `bbl-*` and `go-tui-*` assets are present.
- Re-run the release workflow or upload the missing asset.

### `bbl go --check` passes but `bbl go` fails with `spawn ... ENOENT`

Likely cause on macOS:

- The installed `bbl` is the raw Node SEA payload, not the generated shell wrapper.
- Or the user installed from an older `install.sh`.

Action:

```sh
head -n 5 "$(command -v bbl)"
ls -l "$(dirname "$(command -v bbl)")/bbl.sea"
```

Expected for current macOS curl installs:

- `bbl` starts with `#!/bin/bash`.
- `bbl.sea` exists next to it.

Reinstall from main:

```sh
curl -fsSL https://raw.githubusercontent.com/SuTang-vain/BabeL-O/main/scripts/install.sh | BBL_VERSION=v0.3.3 bash
```

### `go_args[@]: unbound variable`

Cause:

- An older shell wrapper expanded an empty Bash array under `set -u`.

Action:

- Reinstall from main so the wrapper uses the safe array expansion.
- The fixed launcher supports plain `bbl go` with no forwarded Go TUI arguments.

### `Go TUI binary is not executable`

Action:

```sh
ls -l ~/.local/share/babel-o/bin/go-tui-*
chmod +x ~/.local/share/babel-o/bin/go-tui-*
bbl go --check --no-start-nexus
```

If the binary is missing, reinstall. If architecture is wrong, install from a supported platform or build from source.

### Nexus is not healthy

`bbl go --check --no-start-nexus` may warn when Nexus is not running. That is acceptable for the non-destructive check.

For real launch:

- `bbl go` with default localhost URL should start a local Nexus.
- `bbl go --no-start-nexus` requires an already healthy Nexus.
- Non-local URLs are never auto-started.

Manual status:

```sh
curl -fsS http://127.0.0.1:3000/health
```

## Environment Variables

| Variable | Purpose |
| --- | --- |
| `BBL_VERSION` | Install a specific release tag. |
| `BBL_INSTALL_DIR` | Directory for `bbl`. |
| `BBL_GO_TUI_INSTALL_DIR` | Directory for the Go TUI binary. |
| `BBL_INSTALL_SMOKE=0` | Skip installer self-check. Debug only. |
| `BBL_INSTALL_GO_TUI=0` | Skip Go TUI asset install. Partial CLI install only. |
| `BABEL_O_GO_TUI_BINARY` | Override Go TUI binary path at runtime. |
| `BABEL_O_LAUNCH_CWD` | Default workspace cwd for launchers. |
| `NEXUS_ALLOWED_TOOLS` | Tool policy for auto-started Nexus. |

## Maintainer Notes

- Keep user instructions centered on `bbl go`.
- Do not publish a release until the installer can pass an end-to-end smoke using a temporary install directory.
- Keep the macOS shell wrapper as a bridge only; do not keep expanding it into a second full launcher.
- The long-term fix is a Go launcher that owns startup and `exec`s the Go TUI without Node SEA.
- When the Go launcher lands, update this guide, [distribution-strategy-plan.md](./distribution-strategy-plan.md), README install instructions, and release notes together.
