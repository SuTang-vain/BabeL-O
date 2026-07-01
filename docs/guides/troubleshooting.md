# Troubleshooting

[简体中文](troubleshooting.zh-CN.md)

This guide covers common problems you might encounter when using BabeL-O and
the commands to resolve them.

---

## 1. `bbl` not found

**Symptom:** the shell says `command not found: bbl` after installation.

**Cause:** the `bbl` launcher is not on your `PATH`. The release installer places
it under `~/.local/bin/babel-o/bbl` by default.

**Fix:** add the installer's output directory to your PATH, or reinstall with:

```bash
curl -fsSL https://raw.githubusercontent.com/SuTang-vain/BabeL-O/main/scripts/install.sh | bash
```

If you installed via npm, confirm the npm global bin is on your PATH
(commonly `~/.npm-global/bin` or `$(npm config get prefix)/bin`).

---

## 2. Node.js version too old

**Symptom:** `bbl` errors on startup, or the install script warns about the
Node.js version.

**Cause:** BabeL-O requires Node.js >= 22. Your installed Node is older.

**Fix:** upgrade Node.js to v22 or later (e.g. via `nvm`, `fnm`, or your system
package manager), then verify with `node --version`.

---

## 3. Go TUI binary not found

**Symptom:** `bbl go` errors with "Go TUI binary not found" or similar.

**Cause:** the Go TUI binary is missing from your installation. This can happen
when installing via npm (which ships the JS package only) without the prebuilt
binary, or after a partial install.

**Fix:** run the readiness check to see the full diagnostic:

```bash
bbl go --check --no-start-nexus
```

This reports which binary paths were probed and why they are missing. If no
prebuilt binary is found, you can:

- Install or reinstall via `npm install -g babel-o` (includes the prebuilt
  binary).
- Set `BABEL_O_GO_TUI_BINARY` to the path of a release asset you downloaded
  manually.
- Install the Go toolchain and build from source
  (`cd clients/go-tui && make build`).

---

## 4. Nexus won't start or `bbl go` hangs

**Symptom:** `bbl go` stalls on "waiting for Nexus health", or `bbl nexus
status` returns an error.

**Causes and fixes:**

- **Port in use.** The default port is 3000. Check what is listening:

  ```bash
  lsof -i :3000
  ```

  Stop the conflicting process or set a custom port when starting Nexus:

  ```bash
  bbl nexus start --port 3001
  bbl go --url http://127.0.0.1:3001
  ```

- **Nexus crashed during startup.** Check Nexus health directly:

  ```bash
  bbl nexus status
  ```

  If it fails, run `bbl doctor` for a local readiness check.

- **Timeout.** The default startup timeout is 8 s. Increase it for slow
  machines:

  ```bash
  bbl go --nexus-startup-timeout-ms 30000
  ```

---

## 5. Unknown provider / Unknown model

**Symptom:** you see an error like "Unknown provider" or "Unknown model" when
running `bbl config use` or starting the TUI.

**Cause:** the provider ID or model ID is misspelled.

**Fix:** check the resolved configuration and available models:

```bash
bbl config list
```

Supported provider IDs: `anthropic`, `openai`, `deepseek`, `moonshot`,
`ollama`, `zhipu`, `minimax`, `local`.

Model IDs always take the form `provider/model` (e.g.
`anthropic/claude-sonnet-4-6` or `ollama/qwen2.5-coder:7b`). Run
`bbl config list` to see your active settings, then correct the ID:

```bash
bbl config use anthropic/claude-sonnet-4-6
```

---

## 6. 401 / authentication errors

**Symptom:** the provider returns a 401 error and the model does not respond.

**Cause:** the API key is missing, wrong, or expired.

**Fix:** re-add the credentials for your provider:

```bash
bbl config add anthropic "$ANTHROPIC_API_KEY"
```

Verify the key is stored (masked in output):

```bash
bbl config list
```

For providers that use bearer authentication (OpenAI, DeepSeek, Moonshot), the
same `bbl config add` command handles the token. For Ollama, no API key is
needed (`authMode: none`).

---

## 7. Provider stream hangs or times out

**Symptom:** the model starts responding and then stalls mid-stream, or the TUI
shows a timeout.

**Causes and fixes:**

- **Network issue.** Check connectivity to the provider's API endpoint.
- **Proxy or gateway.** If you route through a proxy, override the base URL:

  ```bash
  bbl config add anthropic "$ANTHROPIC_API_KEY" https://my-gateway.example.com
  ```

  OpenAI-compatible endpoints should end in `/v1`; Anthropic-compatible
  endpoints typically use `/api/anthropic` or `/anthropic`.
- **Provider-side rate limiting.** Wait and retry, or switch to a different
  model.

---

## 8. Ollama server not running or model not pulled

**Symptom:** requests to Ollama fail; the TUI shows no response or an error.

**Causes and fixes:**

- **Server not started.** Start Ollama before using it:

  ```bash
  ollama serve
  ```

- **Model not pulled.** List available models and pull the one you need:

  ```bash
  ollama list
  ollama pull qwen2.5-coder:7b
  ```

- **Ollama is not installed or not on PATH.** Install Ollama from
  https://ollama.com, then start the server.

No API key is needed for Ollama (`authMode: none`). Verify the base URL:

```bash
bbl config add ollama    # uses the default http://localhost:11434/v1
bbl config use ollama/qwen2.5-coder:7b
```

---

## 9. Context budget exceeded / model starts forgetting

**Symptom:** the model's responses become vague or it forgets earlier parts of
the conversation.

**Cause:** the token budget is near or at the limit. The runtime auto-compacts
at ~70% usage, but you may need to compact manually.

**Fix:**

1. Open the context panel inside the TUI: `/context`.
2. Check the remaining budget and compact headroom.
3. If needed, trigger compaction: `/compact`.

This summarizes earlier turns and tool results, preserving only recent events.
You can also inspect context from the CLI:

```bash
bbl context working-set              # tracked files
bbl context history --since 24h      # recent behavior trace
```

---

## 10. Tool keeps asking for approval

**Symptom:** every time the model runs a command, a permission dialog pops up.

**Causes and fixes:**

- **The command is not in the read-only allowlist.** Commands like `npm install`,
  `rm -rf`, or chained commands (`&&`, `|`, `>`) always require approval.
  Approve **for this session** (option 2 in the dialog) to suppress the same
  pattern for the rest of the session.

- **Server is in strict mode.** In strict mode, non-allowlisted tools are
  blocked before you even see a prompt. Switch to soft-deny mode for
  interactive work:

  ```bash
  bbl go --allowed-tools '*'
  ```

- **Inspect tool risk levels.** Inside the TUI, open the tool panel
  (`/tools` or Ctrl+O) to see every registered tool and its risk level. From
  the CLI:

  ```bash
  bbl tools audit
  ```

---

## 11. "Tool denied by Nexus policy"

**Symptom:** the model reports that a tool was denied by policy, or you see
"Tool denied by Nexus policy" in the transcript.

**Cause:** the tool is not in the server allowlist and the server is running in
`strict` policy mode.

**Fix:** add the tool to the allowlist or switch to soft-deny mode:

```bash
# Allow all tools (soft-deny mode, recommended for interactive use)
bbl go --allowed-tools '*'

# Or restrict to specific tools
bbl go --allowed-tools Read,Grep,Glob,Bash
```

You can also set `NEXUS_ALLOWED_TOOLS` and `NEXUS_DEFAULT_POLICY_MODE`
environment variables for persistent control.

---

## 12. Session lost after restart

**Symptom:** you closed `bbl go`, restarted it, and the old session is gone.

**Causes and fixes:**

- **Session was created with in-memory storage (NODE_ENV=test or explicit
  `:memory:`).** Run `bbl go` outside a test environment to use the default
  SQLite storage at `~/.babel-o/db.sqlite`.

- **Find and resume the session.** Persisted sessions survive restarts:

  ```bash
  bbl sessions list                          # find your session
  bbl inspect-session <sessionId> --resume   # verify it can resume
  ```

  Inside the TUI: `/session use <sessionId>`.

---

## 13. MemoryOS not working or not configured

**Symptom:** memory hints are missing, or you see "memory: not configured" in
`bbl doctor`.

**Cause:** MemoryOS is opt-in and not set up yet.

**Fix:** run the memory diagnostic and follow the suggested action:

```bash
bbl doctor
bbl memory setup
```

See the [MemoryOS section in the README](../README.md#memoryos) for available
commands.

---

## Diagnostic commands reference

| Command | What it checks |
| :--- | :--- |
| `bbl doctor` | Local readiness (Node, config, MemoryOS) |
| `bbl go --check --no-start-nexus` | Go TUI binary, Nexus health, version compat |
| `bbl config list` | Active provider config and resolved settings |
| `bbl nexus status` | Nexus runtime health |
| `bbl tools audit` | Registered tools and current allow policy |
| `bbl memory status` | MemoryOS bootstrap and runtime state |
| `bbl sessions list` | Persisted session IDs |
| `bbl inspect-session <id>` | Session diagnostic (events, compact, resume) |
| `bbl context working-set` | Tracked working set files |
| `bbl context history` | Behavior trace history |
