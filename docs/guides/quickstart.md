# Quickstart

[简体中文](quickstart.zh-CN.md)

Get from zero to your first BabeL-O coding session in about five minutes.

## Prerequisites

- **macOS** (Apple Silicon or Intel) or **Linux** (x64 or arm64)
- **Node.js >= 22** on `PATH` (check with `node --version`)

## Step 1: Install

The recommended path is the release installer. It downloads a prebuilt Go TUI
binary and a small `bbl` launcher, then runs a self-check.

```bash
curl -fsSL https://raw.githubusercontent.com/SuTang-vain/BabeL-O/main/scripts/install.sh | bash
```

That is it. After the script finishes, `bbl` is on your `PATH`.

> **npm alternative:** `npm install -g babel-o` also works. The release installer
> is preferred because it includes the native Go TUI binary for your platform.

Verify the install:

```bash
bbl doctor
```

If you see memory status lines and no errors, the runtime is ready. You can also
run a more detailed check with `bbl go --check --no-start-nexus`.

## Step 2: Configure a provider

BabeL-O needs credentials for a model provider before it can send prompts.

Set up Anthropic (the default provider) with your API key:

```bash
bbl config add anthropic "$ANTHROPIC_API_KEY"
bbl config use anthropic/claude-sonnet-4-6
```

The first command stores the key. The second sets the default model —
`anthropic/claude-sonnet-4-6` is the default and a great starting point.

Check what is configured:

```bash
bbl config list
```

You will see the active config file contents, your provider (key masked), and
the resolved settings including the default model ID. If `defaultModel` is
empty, re-run the `bbl config use` step above.

> **Other providers:** BabeL-O also supports OpenAI, DeepSeek, Ollama, Moonshot,
> Zhipu, MiniMax, and a local test runtime. See the
> [Providers guide](providers.md) for details.

## Step 3: Start the TUI

```bash
bbl go
```

On first launch, `bbl go` checks whether a local Nexus runtime is already
running. If not, it starts one automatically, allocates a session, and opens
the Go TUI on the alternate screen.

You will see:

- A **status header** at the top showing the active session ID and model.
- A **main transcript area** — empty until you type something.
- An **input bar** at the bottom where you type prompts.
- A **footer** with key hints.

## Step 4: Run your first prompt

Type (or paste) a prompt and press **Enter**:

```text
explain this repository and point me to the entry points
```

Here is what happens next:

1. **Streaming response** — the assistant starts typing its answer in the
   transcript area, word by word. You see the reasoning unfold live.
2. **Tool calls** — when BabeL-O decides it needs to read a file or run a
   command, a tool call block appears in the transcript with a label such as
   `[tool: Read]` or `[tool: Bash]`.
3. **Permission prompts** — the first time a tool is invoked, a permission
   dialog slides in at the bottom. You can **approve** (press `a` or `y`),
   **reject** (press `r` or `n`), or **approve for the entire session**
   (press `A`).

The first prompt usually triggers file reads (`Read`, `Grep`, `Glob`) to
understand the repository layout, then a final answer appears.

## Step 5: Approve a tool, inspect context

When a permission prompt appears:

- Press **`a`** (or **`y`**) to approve it once.
- Press **`A`** (capital letter) to approve it for the rest of the session,
  so you are not asked again for the same tool.

After the tool runs, its result appears inline in the transcript. You can
scroll through the full exchange with the arrow keys or Page Up / Page Down.

To see what the agent is tracking internally, open the context panel:

- Type **`/context`** and press Enter — this shows the context budget,
  compaction status, memory hints, working set, and long-context diagnostics.

Other useful slash commands while inside the TUI:

| Command      | Action |
| :----------- | :----- |
| `/model`     | Switch provider, API key, base URL, or model |
| `/session`   | Create, switch, or copy session IDs |
| `/tools`     | Open the tool audit panel |
| `/memory`    | Inspect MemoryOS status (if enabled) |
| `/help` or `?` | Open the help overlay |

Press **Ctrl+C** to open the quit dialog, then **`y`** or Enter to exit.

## What to try next

- **One-shot prompts without the TUI:** `bbl run "summarize the changes in the last three commits"`
- **Create a separate session:** inside the TUI, use `/session` to spawn a
  second session for a different task, then switch between them.
- **Explore the tool audit:** run `bbl tools audit` from the terminal to see
  every tool available and its current permission state.
- **Enable MemoryOS:** `bbl memory setup --yes` turns on optional local
  long-term memory that persists knowledge across sessions.
- **Switch models mid-session:** press `/model` in the TUI to try Opus for
  deep reasoning or Haiku for quick edits.

See the [Providers guide](providers.md) for the full provider reference and
the [FAQ](FAQ.md) for common questions.
