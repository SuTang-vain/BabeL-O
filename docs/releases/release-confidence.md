# Release Confidence Checklist

This checklist is the go/no-go gate for a BabeL-O release.

Use it before pushing a release tag and again after the GitHub release assets are
available.

## Goal

A BabeL-O release is ready when a new user can install it, start the Go TUI,
configure a model, approve tools, and run a basic session without reading the
source tree.

## Level 1: Required Automated Gates

These checks must pass before tagging:

```sh
npm run typecheck -- --pretty false
npm run format:check
npm run deps:audit
npm test
npm run build:smoke
cd clients/go-tui && go test ./... && make build && ./bin/go-tui --version
```

Distribution-sensitive releases must also pass:

```sh
npm run build:portable
npx tsx --test --test-concurrency=1 test/install-script.test.ts test/go-command.test.ts
```

Do not tag if any required check is red.

## Level 2: Release Asset Gate

After the tag workflow finishes, confirm the GitHub release contains:

```text
bbl-darwin-arm64.tar.gz
bbl-darwin-x64.tar.gz
bbl-linux-x64.tar.gz
go-tui-darwin-arm64
go-tui-darwin-x64
go-tui-linux-x64
go-tui-windows-x64.exe
```

For the current release line, missing macOS/Linux portable assets are a blocking
release defect. The installer should not be announced while a required asset is
missing.

## Level 3: Public Install Smoke

Run the public installer against the released tag:

```sh
tmp="$(mktemp -d)"
curl -fsSL https://raw.githubusercontent.com/SuTang-vain/BabeL-O/main/scripts/install.sh | \
  BBL_VERSION=vX.Y.Z BBL_INSTALL_DIR="$tmp/bin" HOME="$tmp/home" bash
"$tmp/bin/bbl" --version
"$tmp/bin/bbl" go --check --no-start-nexus --url http://127.0.0.1:9
```

The smoke is successful only if:

- the installer downloads a `bbl-<platform>.tar.gz` portable package;
- `bbl --version` reports the intended version;
- `bbl go --check --no-start-nexus` finds and runs the bundled Go TUI;
- no Nexus process is required for the install readiness check;
- no 404, fallback-to-old-version, or empty-asset behavior appears.

## Level 4: Critical User Journeys

Run these manually for releases that touch TUI, provider setup, sessions,
permissions, memory, context, or distribution.

### First Launch

- [ ] Start `bbl go` from a clean install.
- [ ] Confirm Nexus is started or discovered as expected.
- [ ] Confirm the welcome panel and input box render correctly.
- [ ] Confirm the cursor appears in the input box.

### Model Setup

- [ ] Open `/model`.
- [ ] Select an API-key provider.
- [ ] Paste an API key into the credential step.
- [ ] Confirm the pasted value does not duplicate, split, or leak into the main
      prompt composer.
- [ ] Save the provider/model and return to the main screen.
- [ ] Confirm the input box height returns to normal.

### Session Workflow

- [ ] Open `/session`.
- [ ] Create a session.
- [ ] Select or switch a session.
- [ ] Copy the current session ID with the documented shortcut.
- [ ] Exit with `Esc` without layout corruption.

### Context And Panels

- [ ] Open `/context`.
- [ ] Confirm the panel renders above the input area and is not clipped.
- [ ] Scroll the panel.
- [ ] Exit with `Esc` and confirm composer height is normalized.
- [ ] Repeat for `/tools`, `/memory`, and `/model`.

### Input And Mouse

- [ ] Type ordinary text quickly.
- [ ] Paste a multiline prompt.
- [ ] Use `Shift+Enter` for newline.
- [ ] Scroll the transcript with the mouse wheel.
- [ ] Confirm wheel events do not insert characters into the input field.
- [ ] Select transcript text with the mouse and confirm the visual selection
      aligns with the actual copied text.

### Permissions

- [ ] Trigger a low-risk read tool.
- [ ] Trigger a Bash tool that requires approval.
- [ ] Approve once and verify execution.
- [ ] Approve for the session and verify the same rule is not repeatedly
      requested in that session.
- [ ] Reject a tool and confirm the agent receives visible feedback.

## Level 5: Documentation Gate

Before announcing:

- [ ] `CHANGELOG.md` includes the new version.
- [ ] `docs/releases/vX.Y.Z.md` exists.
- [ ] `docs/releases/README.md` links to the new note.
- [ ] README install commands still point to `bbl go`.
- [ ] The release note states known limitations honestly.
- [ ] If the release changes distribution, update
      `docs/guides/distribution-guide.md`.

## Go/No-Go Decision

Ship only when:

- automated checks pass;
- required assets exist;
- public install smoke passes;
- critical user journeys pass for touched areas;
- documentation is updated.

If any item fails, fix forward, rebuild the release assets from the same tag or
publish a patch tag, and rerun the relevant gates.
