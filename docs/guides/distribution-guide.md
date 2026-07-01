# BabeL-O Distribution Guide

> State: Guide
> Track: Distribution / Installer / Release Operations
> Priority: P1 Watch
> Source of truth: [../nexus/TODO.md](../nexus/TODO.md), [../nexus/DONE.md](../nexus/DONE.md), [../nexus/WORK_LOG.md](../nexus/WORK_LOG.md), `scripts/install.sh`, `scripts/package-portable.mjs`, `docs/releases/`

> Governance: Indexed by [go-client-distribution-governance-index.md](../nexus/reference/go-client-distribution-governance-index.md). This guide is operational; strategic channel direction lives in [distribution-strategy-plan.md](../nexus/reference/distribution-strategy-plan.md).

## Purpose

This guide is the operational companion to [distribution-strategy-plan.md](../nexus/reference/distribution-strategy-plan.md). The strategy document explains where distribution should go; this guide explains how to ship, install, verify, and debug the current release line.

The current official user entrypoint is the Go TUI:

```sh
bbl go
```

The legacy TypeScript TUI remains a development/debugging path. User-facing distribution work should optimize for `bbl go` first.

## Supported Channels

| Channel | Status | Intended audience | Notes |
| --- | --- | --- | --- |
| `curl \| bash` | Current primary channel | Users who want one command | v0.3.5+ installs the lightweight `bbl-<platform>.tar.gz` package and runs an end-to-end self-check. |
| GitHub release assets | Current source of truth | Maintainers and manual installers | v0.3.5+ publishes `bbl-<platform>.tar.gz` packages. Standalone `go-tui-*` assets are still published for debugging and compatibility. |
| npm | Planned developer channel | Node developers | Should use a normal Node wrapper and postinstall Go TUI asset download, not SEA. |
| Homebrew tap | Planned user channel | macOS/Linux users | Should install the same product payload as `install.sh`. After the Go launcher lands, this becomes one `bbl` binary. |
| Go launcher | Target architecture | All users | Replaces Node SEA as the production launcher. |

## Current `install.sh` Contract

For v0.3.5 and later, `scripts/install.sh` installs:

1. The platform `bbl-<platform>.tar.gz` package from the GitHub release.
2. The unpacked application under `$BBL_APP_INSTALL_ROOT`, defaulting to `~/.local/share/babel-o/app`.
3. A small launcher shim at `$BBL_INSTALL_DIR/bbl`, defaulting to `/usr/local/bin` or `~/.local/bin`.
4. A built-in Go TUI binary under the package `bin/` directory.

The lightweight package requires Node.js >= 22 on the target machine. In exchange, it avoids the 140MB Node SEA payload and the macOS SEA spawn path entirely. The release still publishes standalone `go-tui-*` assets for manual debugging, but curl installs do not need a second download.

Generated v0.3.5+ layout:

```text
~/.local/bin/bbl                                      # thin launcher shim
~/.local/share/babel-o/app/v0.3.5-darwin-arm64/bin/bbl
~/.local/share/babel-o/app/v0.3.5-darwin-arm64/bin/bbl.js
~/.local/share/babel-o/app/v0.3.5-darwin-arm64/bin/go-tui-darwin-arm64
~/.local/share/babel-o/app/v0.3.5-darwin-arm64/dist/
~/.local/share/babel-o/app/v0.3.5-darwin-arm64/node_modules/
```

For v0.3.4 and older releases, `install.sh` falls back to the legacy SEA + separate Go TUI asset path. That compatibility branch should not be expanded; v0.3.5+ work should target the portable package or future Go launcher.

## Install Commands

Latest release:

```sh
curl -fsSL https://raw.githubusercontent.com/SuTang-vain/BabeL-O/main/scripts/install.sh | bash
```

Specific release:

```sh
curl -fsSL https://raw.githubusercontent.com/SuTang-vain/BabeL-O/main/scripts/install.sh | BBL_VERSION=v0.3.6 bash
```

Custom install paths:

```sh
curl -fsSL https://raw.githubusercontent.com/SuTang-vain/BabeL-O/main/scripts/install.sh | \
  BBL_INSTALL_DIR="$HOME/bin" \
  BBL_APP_INSTALL_ROOT="$HOME/.local/share/babel-o/app" \
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

That mode only applies to legacy SEA releases. It is not a normal user install because `bbl go` needs a Go TUI binary.

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

On v0.3.5+ curl installs, `bbl go` should run through the portable package and should not depend on Node SEA.

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
bbl-darwin-arm64.tar.gz
go-tui-darwin-arm64
bbl-darwin-x64.tar.gz
go-tui-darwin-x64
bbl-linux-x64.tar.gz
go-tui-linux-x64
go-tui-windows-x64.exe
```

If a required macOS/Linux v0.3.5+ `bbl-*.tar.gz` asset is missing, `install.sh` may fall back to legacy assets if they exist. For new releases, treat that as a release bug: the portable package is the primary user install artifact.

The curl installer supports macOS and Linux. Windows remains source-build first for v0.3.5 while the portable packaging path is stabilized.

After release publication:

```sh
tmp="$(mktemp -d)"
curl -fsSL https://raw.githubusercontent.com/SuTang-vain/BabeL-O/main/scripts/install.sh | \
  BBL_VERSION=vX.Y.Z BBL_INSTALL_DIR="$tmp/bin" HOME="$tmp/home" bash
"$tmp/bin/bbl" --version
"$tmp/bin/bbl" go --check --no-start-nexus
```

Also inspect:

```sh
file "$tmp/bin/bbl"
ls -lh "$tmp/home/.local/share/babel-o/app"
```

Expected:

- `bbl` is a small shell launcher.
- the app directory contains `bin/bbl`, `bin/bbl.js`, `dist/`, `node_modules/`, and a platform `go-tui-*` binary.

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

- For v0.3.5+, the installed `bbl` is not the portable shim.
- For legacy v0.3.4 and older installs, the installed `bbl` is the raw Node SEA payload, not the generated shell wrapper.
- Or the user installed from an older `install.sh`.

Action:

```sh
head -n 5 "$(command -v bbl)"
```

Expected for v0.3.5+ curl installs:

- `bbl` starts with `#!/bin/sh`.
- `bbl` contains an `APP_DIR=.../.local/share/babel-o/app/...` line.

Expected only for legacy macOS SEA installs:

- `bbl` starts with `#!/bin/bash`.
- `bbl.sea` exists next to it.

Reinstall a current lightweight version from main:

```sh
curl -fsSL https://raw.githubusercontent.com/SuTang-vain/BabeL-O/main/scripts/install.sh | BBL_VERSION=v0.3.6 bash
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
find ~/.local/share/babel-o -name 'go-tui-*' -print -exec ls -l {} \;
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
| `BBL_APP_INSTALL_ROOT` | Directory for unpacked v0.3.5+ lightweight app packages. |
| `BBL_GO_TUI_INSTALL_DIR` | Directory for the Go TUI binary. |
| `BBL_INSTALL_SMOKE=0` | Skip installer self-check. Debug only. |
| `BBL_INSTALL_GO_TUI=0` | Skip Go TUI asset install. Partial CLI install only. |
| `BABEL_O_GO_TUI_BINARY` | Override Go TUI binary path at runtime. |
| `BABEL_O_LAUNCH_CWD` | Default workspace cwd for launchers. |
| `NEXUS_ALLOWED_TOOLS` | Tool policy for auto-started Nexus. |

## Maintainer Notes

- Keep user instructions centered on `bbl go`.
- Do not publish a release until the installer can pass an end-to-end smoke using a temporary install directory.
- Keep the legacy macOS SEA shell wrapper as a compatibility branch only; do not expand it into a second full launcher.
- v0.3.5+ release work should verify `bbl-<platform>.tar.gz`, not just `go-tui-*` and legacy `bbl-*`.
- The long-term fix is a Go launcher that owns startup and `exec`s the Go TUI without Node SEA.
- When the Go launcher lands, update this guide, [distribution-strategy-plan.md](../nexus/reference/distribution-strategy-plan.md), README install instructions, and release notes together.

## 中文概述

### 背景

本文是发布和安装操作指南，服务于真实用户如何安装、验证、排错 BabeL-O。

### 边界

它不决定长期发布策略；策略方向由 distribution-strategy-plan 维护。指南内容必须和 install.sh、release assets、README 安装命令保持一致。

### 当前状态

作为 Guide 保留，后续每次 release 或安装路径变化都应同步核对。
