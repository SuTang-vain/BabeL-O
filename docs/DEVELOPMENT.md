# Development Guide

This guide is for contributors working from the `develop` branch or a local source checkout. For the full development guide — essential commands, design rules, layer boundaries, and tooling — see [../AGENTS.md](../AGENTS.md). This page only covers branch responsibilities and source/release CLI invocation.

## Branch responsibilities

- `main`: release-oriented branch for installer, release notes, and user-facing validation.
- `develop`: active development branch for source-code iteration and contributor workflows.
- `release/vX.Y.Z`: version-specific release validation and hotfix branch.

Keep development-only behavior on `develop` until it is ready to be promoted to `main`.

## Run the source CLI

From a source checkout:

```bash
npm ci
npm run build
cd clients/go-tui && make build && cd ../..
npm run cli -- go --check --no-start-nexus
npm run cli -- go
```

`bbl go` is the production interactive client. The TypeScript chat TUI was removed from release packages in v0.3.7, so source validation should use the same Go TUI path that users run after installation.

## Release binary comparison

For release validation, use the installed or built binary instead:

```bash
bbl go --check --no-start-nexus
./dist/cli/program.js go --check --no-start-nexus
```
