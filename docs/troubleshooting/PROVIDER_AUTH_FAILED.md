# Error Code: PROVIDER_AUTH_FAILED

## What Happened

The provider rejected the API key. Authentication failed when trying to call the LLM.

## Why It Happened

Common causes:

1. **Invalid API key** — Key is incorrect or malformed.
2. **Expired key** — Key has been revoked or expired.
3. **Insufficient quota** — Account has no credits or quota remaining.
4. **Wrong provider** — Key is for a different provider than configured.

## How to Fix It

### 1. Check Credential Status

```bash
bbl config audit
```

This shows:
- Where API keys are stored (keychain, env, config file)
- Which providers have keys configured
- Whether keys are valid (if checkable)

### 2. Reconfigure API Key

```bash
# Interactive setup
bbl config init

# Or add key for specific provider
bbl config add anthropic $ANTHROPIC_API_KEY
bbl config add openai $OPENAI_API_KEY
```

### 3. Check Key in Dashboard

Verify the key works in the provider's dashboard:

- [Anthropic Console](https://console.anthropic.com/)
- [OpenAI Platform](https://platform.openai.com/api-keys)
- [Other providers...](https://babel-o.dev/providers)

### 4. Check Account Status

- Verify account has credits
- Check for any account restrictions
- Ensure billing is set up correctly

### 5. Migrate to Keychain (Recommended)

If keys are stored in plaintext:

```bash
bbl config migrate
```

This moves keys to your system keychain for better security.

## Credential Storage Options

| Method | Security | Convenience |
|--------|----------|-------------|
| System Keychain | High | High (automatic) |
| Environment Variable | Medium | Medium (manual) |
| Config File | Low | High (not recommended) |

## Related Commands

- `bbl config audit` — Check credential status
- `bbl config add <provider> <key>` — Add new API key
- `bbl config migrate` — Move keys to keychain
- `bbl config list` — List configured providers

## See Also

- [Installation Guide](../INSTALLATION.md)
- [Provider Configuration](../guides/provider-configuration.md)
