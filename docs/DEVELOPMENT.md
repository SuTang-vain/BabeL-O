# Development Guide

This guide is for contributors working from the `dev` branch or a local source checkout.

## Branch responsibilities

- `main`: release-oriented branch for installer, release notes, and user-facing validation.
- `dev`: active development branch for source-code iteration and contributor workflows.
- `release/vX.Y.Z`: version-specific release validation and hotfix branch.

Keep development-only behavior on `dev` until it is ready to be promoted to `main`.

## Run the source CLI in dev mode

From a source checkout:

```bash
npm ci
npm run cli -- chat dev
```

`chat dev` starts the interactive TUI from the current source tree and renders the welcome header as:

```text
❖ BABEL-O  dev
```

Use this mode when validating local source changes so the session is not confused with an installed release binary such as `bbl chat` from your `$PATH`.

## Release binary comparison

For release validation, use the installed or built binary instead:

```bash
bbl chat
./dist/bbl chat
```

Those commands should render the release version title, for example `❖ BABEL-O  v0.3.1`, not `dev`.
