# BabeL-O Release Guide

This guide describes how to prepare, publish, and verify a BabeL-O release.

The release notes in this directory explain what changed. This guide explains
how to ship those changes without publishing a broken installer or incomplete
asset set.

## Release Shape

BabeL-O currently ships through three layers:

| Layer | Purpose | Source of truth |
| --- | --- | --- |
| GitHub release | Public release page and downloadable assets | `.github/workflows/release.yml` |
| Portable package | Primary install payload for macOS and Linux | `bbl-<platform>.tar.gz` |
| Standalone Go TUI asset | Debugging and compatibility asset | `go-tui-<platform>` |

The official interactive entrypoint is:

```sh
bbl go
```

`bbl run "<prompt>"` remains the one-shot automation path. The legacy
TypeScript interactive TUI is no longer part of the release package as of
v0.3.7.

## Version Policy

BabeL-O follows semver-style tags:

- Patch releases fix install, runtime, TUI, provider, or permission regressions.
- Minor releases can add user-visible workflow capabilities.
- Major releases are reserved for incompatible CLI, storage, or runtime contract
  changes.

Every public release must have:

- a git tag named `vX.Y.Z`;
- matching `package.json` version `X.Y.Z`;
- a release note at `docs/releases/vX.Y.Z.md`;
- a `CHANGELOG.md` entry;
- macOS arm64, macOS x64, and Linux x64 portable assets.

## Required Assets

For v0.3.5 and later, the required release assets are:

```text
bbl-darwin-arm64.tar.gz
bbl-darwin-x64.tar.gz
bbl-linux-x64.tar.gz
go-tui-darwin-arm64
go-tui-darwin-x64
go-tui-linux-x64
go-tui-windows-x64.exe
```

The portable `bbl-*.tar.gz` assets are the user install path. The standalone
`go-tui-*` assets are kept for direct debugging, compatibility checks, and
manual validation.

Do not announce a release until the required macOS/Linux portable assets exist
and the public installer has passed a clean smoke test.

## Prepare A Release

1. Update the package version:

   ```sh
   npm version X.Y.Z --no-git-tag-version
   ```

2. Add `docs/releases/vX.Y.Z.md`.

   Use a concise structure:

   ```md
   # Release Notes: BabeL-O vX.Y.Z

   One short paragraph describing the release.

   ## What Changed

   1. **Area**
      - User-visible change.
      - Important fix or migration note.

   ## Install

   ...

   ## Expected Release Assets

   ...

   ## Verification

   ...

   ## Known Notes

   ...
   ```

   Add a Chinese section when the release contains meaningful user-facing
   changes.

3. Update [CHANGELOG.md](../../CHANGELOG.md).

   Keep the changelog shorter than the full release note. It should answer:

   - What changed for users?
   - What was fixed?
   - Is there an install or migration note?

4. Update [docs/releases/README.md](README.md) so the new version appears at the
   top of the index.

5. Run the release confidence checks in
   [release-confidence.md](release-confidence.md).

## Local Verification

Before creating the tag, run:

```sh
npm run typecheck -- --pretty false
npm run format:check
npm run deps:audit
npm test
npm run build:smoke
cd clients/go-tui && go test ./... && make build && ./bin/go-tui --version
```

For distribution-sensitive changes, also run:

```sh
npm run build:portable
npx tsx --test --test-concurrency=1 test/install-script.test.ts test/go-command.test.ts
```

If the release changes provider setup, model configuration, or TUI layout,
manually smoke:

```sh
bbl go --check --no-start-nexus
bbl go
```

Then exercise:

- `/model`
- `/context`
- `/session`
- `/tools`
- `/memory`
- mouse wheel scrolling
- multiline input
- permission approval and rejection

## Publish

Create and push the tag:

```sh
git tag vX.Y.Z
git push origin vX.Y.Z
```

The release workflow builds portable packages and Go TUI assets, then creates or
updates the GitHub release using `docs/releases/vX.Y.Z.md` when present.

If a release already exists and assets need to be replaced, the workflow uploads
with `--clobber`.

## Public Installer Smoke

After the workflow uploads assets, verify the release through the same path a
new user will use:

```sh
tmp="$(mktemp -d)"
curl -fsSL https://raw.githubusercontent.com/SuTang-vain/BabeL-O/main/scripts/install.sh | \
  BBL_VERSION=vX.Y.Z BBL_INSTALL_DIR="$tmp/bin" HOME="$tmp/home" bash
"$tmp/bin/bbl" --version
"$tmp/bin/bbl" go --check --no-start-nexus --url http://127.0.0.1:9
```

Inspect the installed layout:

```sh
head -n 5 "$tmp/bin/bbl"
find "$tmp/home/.local/share/babel-o/app" -maxdepth 3 -type f | sort
```

Expected result:

- `$tmp/bin/bbl` is a small launcher shim.
- The app directory contains `bin/bbl`, `bin/bbl.js`, `dist/`,
  `node_modules/`, and a platform Go TUI binary.
- `bbl go --check --no-start-nexus` succeeds without starting Nexus.

## Failure Handling

If any required asset is missing:

- rerun the release workflow;
- or upload the missing asset manually only if it was built from the exact tag;
- then rerun the public installer smoke.

If the installer returns 404:

- check that the tag, release, and asset names match exactly;
- do not work around this by changing install docs to a different version;
- fix the release asset set.

If `bbl go --check` passes but `bbl go` fails:

- inspect `head -n 5 "$(command -v bbl)"`;
- confirm the installed launcher points at the portable app directory;
- confirm the bundled Go TUI binary exists and is executable;
- reinstall with `BBL_VERSION=vX.Y.Z` after the fixed assets are uploaded.

## Documentation Links

- [Changelog](../../CHANGELOG.md)
- [Release index](README.md)
- [Release confidence checklist](release-confidence.md)
- [Distribution guide](../guides/distribution-guide.md)
- [Distribution strategy](../nexus/reference/distribution-strategy-plan.md)
