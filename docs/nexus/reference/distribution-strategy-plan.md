# BabeL-O Distribution Strategy Plan

## Decision

Move the production installer away from Node.js SEA as the long-term primary channel. The target product shape is:

- `bbl` as a small Go launcher binary.
- Go TUI embedded or bundled by the launcher distribution.
- npm kept as the developer channel with a normal Node wrapper and downloaded Go TUI asset.
- Homebrew tap as the preferred macOS/Linux user channel.
- `install.sh` kept as the zero-dependency channel, installing the same release binary as Homebrew.

## Why

The current v0.3.3 distribution has been stabilized by publishing both `bbl-*` and `go-tui-*` assets in the same release, but it still depends on Node.js SEA for the standalone `bbl` executable. That path has three product risks:

- SEA is still a fragile production base for this project because it depends on embedding a Node runtime and application blob into a platform executable.
- The release asset is large: the macOS arm64 `bbl` is about 140 MB before the separate Go TUI asset.
- The official product entrypoint is now `bbl go`, so a Node SEA launcher that immediately starts or locates a Go TUI binary is an awkward shape for the main user path.

The project already maintains Go code for `clients/go-tui`, so a Go launcher has the lowest long-term operational risk.

## Immediate Path

These changes are safe for the current release line and should be done before the larger launcher migration:

1. Keep one product release tag, `v*`, containing all user-installable assets.
2. Keep `install.sh` installing both `bbl-*` and `go-tui-*`.
3. Treat a missing Go TUI release asset as an install failure by default.
4. Run an installer self-check after install:

```sh
"$INSTALLED_GO_TUI_PATH" --version
NODE_NO_WARNINGS=1 BABEL_O_GO_TUI_BINARY="$INSTALLED_GO_TUI_PATH" "$INSTALL_DIR/bbl" go --check --no-start-nexus
```

The self-check should be non-destructive: it verifies binary discovery and CLI startup without starting a Nexus server.

5. On macOS standalone installs, wrap the SEA payload with a small shell `bbl` launcher:
   - Move the downloaded SEA binary to `bbl.sea`.
   - Keep `bbl run`, `bbl chat`, `bbl sessions`, etc. delegated to `bbl.sea`.
   - Handle `bbl go` in shell by starting local Nexus when needed, then `exec`ing the installed Go TUI directly.

This is a short-term bridge for the v0.3.3 release line: it avoids the macOS Node SEA `child_process.spawn` path that can report `ENOENT` for a valid Go TUI Mach-O. It is not the final architecture; the Go launcher remains the target.

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

Before attempting homebrew-core, maintain a first-party tap:

```ruby
class BabelO < Formula
  desc "Nexus-first coding agent CLI"
  homepage "https://github.com/SuTang-vain/BabeL-O"
  version "0.3.3"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/SuTang-vain/BabeL-O/releases/download/v0.3.3/bbl-darwin-arm64"
      sha256 "<sha256>"
    else
      url "https://github.com/SuTang-vain/BabeL-O/releases/download/v0.3.3/bbl-darwin-x64"
      sha256 "<sha256>"
    end
  end

  def install
    bin.install Dir["bbl-*"].first => "bbl"
  end

  test do
    assert_match "0.3.3", shell_output("#{bin}/bbl --version")
  end
end
```

After the Go launcher lands, the formula should install a single `bbl` binary.

## Release Workflow Direction

The current workflow should remain stable until the Go launcher is ready:

- `release.yml` builds all assets for one `v*` release.
- `install.sh` consumes only that product release.
- `go-tui-release.yml` remains for standalone maintenance only, not the primary user install path.

When the Go launcher lands:

- Replace SEA `build-bbl` with Go launcher builds.
- Keep asset names `bbl-darwin-arm64`, `bbl-darwin-x64`, `bbl-linux-x64`, `bbl-windows-x64.exe`.
- Stop requiring a separate Go TUI asset for the curl/Homebrew path if the TUI is embedded.
- Keep standalone `go-tui-*` assets temporarily for compatibility and manual debugging.

## Acceptance Criteria

Immediate:

- A release missing `go-tui-*` fails installation clearly.
- `install.sh` directly probes the installed Go TUI executable with `--version`, then runs `bbl go --check --no-start-nexus` by default.
- macOS curl installs launch `bbl go` through the shell wrapper and do not rely on SEA spawning the Go TUI Mach-O.
- The installer can be smoke-tested with custom install dirs without touching the user's real `bbl`.

npm:

- `npm i -g babel-o` installs a working `bbl go` on supported platforms.
- No SEA binary is required for npm users.
- Package install failures tell users which asset is missing and where to download it manually.

Go launcher:

- Installed curl/Homebrew binary is one `bbl` file.
- `bbl --version`, `bbl go --check --no-start-nexus`, and `bbl go` work without Node.
- macOS arm64 binary is materially smaller than the current SEA plus Go TUI pair.
- Existing CLI commands either run natively in the launcher or dispatch to an explicitly managed Node runtime with clear messaging. The final target is no hidden SEA dependency in the primary Go TUI path.
