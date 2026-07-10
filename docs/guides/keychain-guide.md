# API Key Security Guide

BabeL-O stores your API keys securely using the system keychain by default.
This guide explains how it works and how to manage your credentials.

## How It Works

When you configure a provider with `bbl config add` or `bbl config init`,
your API key is stored in the system keychain rather than in the plaintext
config file.

| Platform | Keychain | Command |
|----------|----------|---------|
| macOS | Keychain (Apple) | `security` CLI |
| Windows | Credential Manager | `cmdkey` CLI |
| Linux | Secret Service (libsecret) | `secret-tool` CLI |

## Quick Start

### Interactive Setup

```bash
bbl config init
```

The wizard will guide you through:
1. Selecting a provider
2. Entering your API key (hidden input)
3. Choosing a default model

Your API key is automatically stored in the system keychain.

### Command-Line Setup

```bash
# Store in keychain (default)
bbl config add anthropic "sk-ant-xxxxx"

# Store in config file (explicit plaintext)
bbl config add anthropic "sk-ant-xxxxx" --plain
```

## Credential Audit

Check where your API keys are stored:

```bash
bbl config audit
```

Example output:

```
--- Credential Storage Audit ---

Keychain:
  ✓ anthropic
  ✓ openai

Config File:
  deepseek (plaintext) ⚠

Environment Variables:
  (none)

⚠ 1 API key(s) stored in plaintext. Run `bbl config migrate` to move to keychain.
```

## Migrating Plaintext Keys

If you have existing API keys stored in the config file, migrate them to the
keychain:

```bash
# Migrate all providers
bbl config migrate

# Migrate a specific provider
bbl config migrate --provider anthropic
```

## Environment Variable Fallback

In CI/CD environments or containers without a keychain, use environment
variables:

```bash
# Provider-specific
export ANTHROPIC_API_KEY="sk-ant-xxxxx"

# Or universal (overrides all providers)
export BABEL_O_API_KEY="sk-ant-xxxxx"

# Run non-interactively
bbl config init --non-interactive --provider anthropic --model claude-sonnet-4-6
```

## Security Best Practices

1. **Use the keychain** — `bbl config add` uses it by default. No extra steps
   needed.

2. **Avoid plaintext storage** — Only use `--plain` when you have a specific
   reason (e.g., testing in a disposable container).

3. **Prefer environment variables in CI** — Set `BABEL_O_ANTHROPIC_API_KEY` in
   your CI pipeline secrets rather than in the config file.

4. **Audit regularly** — Run `bbl config audit` to check where your keys are
   stored.

5. **Rotate keys** — When rotating an API key, re-run `bbl config add` with the
   new key. The old key is automatically replaced.

## Troubleshooting

### "Keychain not available" Error

This usually means you're running in a non-interactive environment (CI,
container, SSH without agent forwarding).

**Solution**: Set the API key via environment variable:

```bash
export BABEL_O_ANTHROPIC_API_KEY="sk-ant-xxxxx"
bbl go
```

### "security: SecKeychainItemCopyContent" on macOS

This can happen if the Keychain is locked or there's a permission issue.

**Solution**: Unlock your login keychain:

```bash
security unlock-keychain ~/Library/Keychains/login.keychain-db
```

### "secret-tool: command not found" on Linux

The `secret-tool` utility is part of the `libsecret` package.

**Solution**: Install libsecret:

```bash
# Debian/Ubuntu
sudo apt install libsecret-tools

# Fedora
sudo dnf install libsecret

# Arch
sudo pacman -S libsecret
```

## Verification

To verify that your API key is stored securely:

```bash
# Check where the key is stored
bbl config audit

# The output should show "Keychain" for your provider
# The config file should NOT contain the API key

# Verify the config file
cat ~/.babel-o/config.json
# Expected: no "apiKey" field for keychain-stored providers
```
