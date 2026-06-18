# BabeL-O Distribution Strategy Plan

> State: Active Plan
> Track: Distribution / Portable Package / Launcher
> Priority: P1 Watch
> Source of truth: [../TODO.md](../TODO.md), [../active/TODO_cleanup.md](../active/TODO_cleanup.md), [../DONE.md](../DONE.md), [../WORK_LOG.md](../WORK_LOG.md), `scripts/install.sh`, `scripts/package-portable.mjs`, `src/cli/commands/go.ts`

> Governance: Indexed by [go-client-distribution-governance-index.md](./go-client-distribution-governance-index.md). This document owns release-channel strategy; it must stay aligned with real assets, `install.sh`, and `bbl go --check`.

## Decision

Move the production installer away from Node.js SEA as the primary channel. The v0.3.5 release line uses a lightweight portable package now, while the long-term target remains a small Go launcher. The target product shape is:

- v0.3.5 immediate path: `bbl-<platform>.tar.gz` portable packages that bundle `dist/`, production `node_modules`, the normal Node wrapper, and the platform Go TUI.
- `bbl` as a small Go launcher binary.
- Go TUI embedded or bundled by the launcher distribution.
- npm kept as the developer channel with a normal Node wrapper and downloaded Go TUI asset.
- Homebrew tap as the preferred macOS/Linux user channel.
- `install.sh` kept as the one-command channel, installing the same product payload as manual GitHub release downloads.

## Why

The v0.3.4 distribution kept the stabilized two-asset model by publishing both `bbl-*` and `go-tui-*` assets in the same release, but it still depended on Node.js SEA for the standalone `bbl` executable. That path had three product risks:

- SEA is still a fragile production base for this project because it depends on embedding a Node runtime and application blob into a platform executable.
- The release asset is large: the macOS arm64 `bbl` is about 140 MB before the separate Go TUI asset.
- The official product entrypoint is now `bbl go`, so a Node SEA launcher that immediately starts or locates a Go TUI binary is an awkward shape for the main user path.

The project already maintains Go code for `clients/go-tui`, so a Go launcher has the lowest long-term operational risk.

## Immediate Path

v0.3.5 is the immediate safer release path before the larger Go launcher migration:

1. Keep one product release tag, `v*`, containing all user-installable assets.
2. Publish lightweight packages as the primary user assets:

```text
bbl-darwin-arm64.tar.gz
bbl-darwin-x64.tar.gz
bbl-linux-x64.tar.gz
```

3. Keep standalone `go-tui-*` assets for manual debugging and compatibility, but do not require a second download in the curl install path.
4. Require Node.js >= 22 on the target machine for portable packages. This is an explicit tradeoff: it removes the 140MB SEA runtime from the release asset and avoids the macOS SEA spawn path.
5. `install.sh` should prefer `bbl-<platform>.tar.gz` when present and fall back to legacy SEA + separate Go TUI only for v0.3.4 and older releases.
6. Run a non-destructive installer self-check after install:

```sh
"$INSTALLED_GO_TUI_PATH" --version
NODE_NO_WARNINGS=1 BABEL_O_GO_TUI_BINARY="$INSTALLED_GO_TUI_PATH" "$INSTALL_DIR/bbl" go --check --no-start-nexus
```

The self-check verifies Go TUI discovery and CLI startup without starting a Nexus server.

The old macOS SEA shell wrapper remains only as a compatibility branch for legacy releases: it moves the downloaded SEA binary to `bbl.sea`, delegates non-Go commands to that payload, and handles `bbl go` by `exec`ing the installed Go TUI directly. Do not expand that path for new releases.

Users can opt out only for debugging or partial CLI installs:

```sh
BBL_INSTALL_SMOKE=0
BBL_INSTALL_GO_TUI=0
```

## Medium-Term npm Channel

npm should not publish SEA binaries as its primary mechanism. It should use the existing `bin/bbl.js` Node wrapper plus a postinstall asset downloader:

```json
{
  "name": "babel-o",
  "bin": { "bbl": "./bin/bbl.js" },
  "scripts": {
    "postinstall": "node scripts/download-go-tui.js"
  },
  "engines": { "node": ">=22" },
  "os": ["darwin", "linux", "win32"]
}
```

The postinstall script should:

- Resolve the package version.
- Map platform and architecture to `go-tui-*`.
- Download the matching asset from the same GitHub release.
- Store it under `node_modules/babel-o/bin/`.
- Set `BABEL_O_GO_TUI_PACKAGE_BINARY` or write the binary to the path already searched by `bbl go`.
- Fail with a clear message when the platform has no prebuilt asset.

This keeps `bbl run`, `bbl chat`, and `bbl go` running through normal Node, avoiding SEA-specific runtime behavior for npm users.

## Long-Term Go Launcher

The long-term production binary should be a Go launcher. Two designs are acceptable:

### Preferred: Embedded TUI Payload

The launcher embeds the platform-matched Go TUI payload and materializes it to a temporary executable before `syscall.Exec`.

```go
//go:embed tui/go-tui-darwin-arm64
var tuiBinary []byte

func launchTUI(args []string) error {
    tmp, err := os.CreateTemp("", "babel-o-go-tui-*")
    if err != nil {
        return err
    }
    name := tmp.Name()
    if _, err := tmp.Write(tuiBinary); err != nil {
        tmp.Close()
        os.Remove(name)
        return err
    }
    if err := tmp.Chmod(0o755); err != nil {
        tmp.Close()
        os.Remove(name)
        return err
    }
    if err := tmp.Close(); err != nil {
        os.Remove(name)
        return err
    }
    return syscall.Exec(name, append([]string{name}, args...), os.Environ())
}
```

This preserves terminal behavior because the Go TUI becomes the process image after `exec`.

### Fallback: Side-by-Side Bundle

The launcher ships with `go-tui-*` next to it or under a shared directory and uses `syscall.Exec` into that file. This is less self-contained but simpler for Homebrew, Linux packages, and debugging.

## Homebrew Tap

Before attempting homebrew-core, maintain a first-party tap. For v0.3.5, Homebrew should install the same portable package as `install.sh` and write a small shim into `bin`:

```ruby
class BabelO < Formula
  desc "Nexus-first coding agent CLI"
  homepage "https://github.com/SuTang-vain/BabeL-O"
  version "0.3.5"
  depends_on "node@22"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/SuTang-vain/BabeL-O/releases/download/v0.3.5/bbl-darwin-arm64.tar.gz"
      sha256 "<sha256>"
    else
      url "https://github.com/SuTang-vain/BabeL-O/releases/download/v0.3.5/bbl-darwin-x64.tar.gz"
      sha256 "<sha256>"
    end
  end

  def install
    libexec.install Dir["*"]
    (bin/"bbl").write <<~SH
      #!/bin/sh
      exec "#{libexec}/bin/bbl" "$@"
    SH
  end

  test do
    assert_match "0.3.5", shell_output("#{bin}/bbl --version")
    assert_match "Result: OK", shell_output("#{bin}/bbl go --check --no-start-nexus")
  end
end
```

After the Go launcher lands, the formula should install a single `bbl` binary.

## Release Workflow Direction

The current workflow should remain stable until the Go launcher is ready:

- `release.yml` builds portable `bbl-<platform>.tar.gz` packages and standalone `go-tui-*` assets for one `v*` release.
- `install.sh` consumes only that product release.
- `go-tui-release.yml` remains for standalone maintenance only, not the primary user install path.

When the Go launcher lands:

- Replace SEA `build-bbl` with Go launcher builds.
- Keep asset names `bbl-darwin-arm64`, `bbl-darwin-x64`, `bbl-linux-x64`, `bbl-windows-x64.exe`.
- Stop requiring a separate Go TUI asset for the curl/Homebrew path if the TUI is embedded.
- Keep standalone `go-tui-*` assets temporarily for compatibility and manual debugging.

## Acceptance Criteria

Immediate:

- v0.3.5+ releases publish all required macOS/Linux `bbl-<platform>.tar.gz` packages.
- `install.sh` installs the portable package when present and writes a small launcher shim.
- `install.sh` directly probes the bundled Go TUI executable with `--version`, then runs `bbl go --check --no-start-nexus` by default.
- macOS curl installs do not rely on SEA spawning the Go TUI Mach-O.
- The installer can be smoke-tested with custom install dirs without touching the user's real `bbl`.
- Rebuilding `npm run build:portable` locally does not recursively package older `dist/bbl-*.tar.gz` artifacts.

npm:

- `npm i -g babel-o` installs a working `bbl go` on supported platforms.
- No SEA binary is required for npm users.
- Package install failures tell users which asset is missing and where to download it manually.

Go launcher:

- Installed curl/Homebrew binary is one `bbl` file.
- `bbl --version`, `bbl go --check --no-start-nexus`, and `bbl go` work without Node.
- macOS arm64 binary is materially smaller than the current SEA plus Go TUI pair.
- Existing CLI commands either run natively in the launcher or dispatch to an explicitly managed Node runtime with clear messaging. The final target is no hidden SEA dependency in the primary Go TUI path.

## 中文概述

### 背景

本文定义 BabeL-O 从 Node SEA 转向 lightweight portable package、npm wrapper、Homebrew 和未来 Go launcher 的分发路线。

### 边界

分发策略不能超前于真实 release assets 和安装脚本；Go launcher 是长期方向，不等于 Go 接管 Nexus runtime。

### 当前状态

作为 Active Plan 保留。当前主路径是 v0.3.5+ lightweight portable package，Go launcher 仍是后续迁移目标。
