# Installation Guide

This guide covers all installation methods for BabeL-O.

## Requirements

- **Operating System**: macOS or Linux
- **Node.js**: Version 22 or higher (required for native SQLite support)
- **Go** (optional): Version 1.23+ for building the Go TUI from source

## Method 1: npm Global Install (Recommended)

The fastest way to get started:

```bash
npm install -g babel-o
bbl go
```

This method is ideal for Node.js developers and CI/CD environments.

## Method 2: Release Installer

The release installer downloads a lightweight package for your platform,
installs the `bbl` launcher, bundles the matching Go TUI binary, and runs
a post-install self-check.

```bash
curl -fsSL https://raw.githubusercontent.com/SuTang-vain/BabeL-O/main/scripts/install.sh | bash
bbl go
```

### Install a Specific Version

```bash
curl -fsSL https://raw.githubusercontent.com/SuTang-vain/BabeL-O/main/scripts/install.sh | BBL_VERSION=v0.4.1 bash
```

## Method 3: From Source

For contributors and those who want the latest development version:

```bash
# Clone the repository
git clone https://github.com/SuTang-vain/BabeL-O.git
cd BabeL-O

# Install dependencies
npm ci

# Run tests (optional but recommended)
npm test

# Build the TypeScript code
npm run build

# Link the CLI globally
npm link

# Build the Go TUI (optional, for development)
cd clients/go-tui && make build

# Start the TUI
bbl go
```

## Go TUI Build Options

The Go TUI client can be built separately:

```bash
cd clients/go-tui

# Development build (fast, no optimization)
make dev

# Production build (optimized, smaller binary)
make build

# Run tests
make test
```

## Verification

After installation, verify everything works:

```bash
# Check the CLI version
bbl --version

# Run local readiness checks
bbl doctor

# Check TUI and installation readiness
bbl go --check --no-start-nexus
```

## Configuration

Before using BabeL-O, configure your provider:

### Interactive Setup (Recommended)

```bash
bbl config init
```

Follow the interactive wizard to select a provider, enter your API key
(stored in the system keychain), and choose a default model.

### Non-Interactive Setup

```bash
# Set up your API key (stored in system keychain by default)
bbl config add anthropic "$ANTHROPIC_API_KEY"

# Set the default model
bbl config use anthropic/claude-sonnet-4-6

# Verify configuration
bbl config list
```

> **API key security**: By default, `bbl config add` stores your API key in the
> system keychain (macOS Keychain, Windows Credential Manager, or Linux
> Secret Service). Use `--plain` to store in the config file instead.
>
> Keychain availability is detected automatically. In CI/container environments
> without a keychain, fall back to environment variables:
> `BABEL_O_ANTHROPIC_API_KEY` or the universal `BABEL_O_API_KEY`.

You can also configure providers from inside the TUI with `/model` (or `Ctrl+L`).

### Credential Audit

```bash
# Check where your API keys are stored
bbl config audit

# Migrate plaintext keys from config file to keychain
bbl config migrate
```

## Troubleshooting

### Node.js Version Issues

If you see errors about native SQLite or ESM modules, ensure you're running
Node.js 22 or higher:

```bash
node --version  # Should be v22.x.x or higher
```

### Permission Errors

If you get permission errors during npm install:

```bash
# Option 1: Use sudo (not recommended for security)
sudo npm install -g babel-o

# Option 2: Configure npm to use a directory you own
mkdir -p ~/.npm-global
npm config set prefix '~/.npm-global'
# Add to your shell profile:
export PATH=~/.npm-global/bin:$PATH
```

### Go TUI Not Found

If the Go TUI binary is missing after installation:

```bash
# Rebuild the Go TUI
cd clients/go-tui && make build

# Or use the TypeScript fallback
npx tsx src/cli/program.ts go
```

## Next Steps

- [Quick Start Guide](../README.md#quick-start-5-minutes)
- [TUI Keybindings](../README.md#tui-keybindings)
- [Common Commands](../README.md#common-commands)
- [Architecture Overview](./guides/ARCHITECTURE.md)
