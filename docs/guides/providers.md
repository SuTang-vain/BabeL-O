# Providers and Models

[简体中文](providers.zh-CN.md)

BabeL-O supports eight providers through three adapter families. Configure them
with the `bbl config` commands (or the `/model` panel inside the TUI), and
switch model or provider at any time.

## Quick start

Set credentials and a default model, then start the TUI:

```bash
bbl config add anthropic "$ANTHROPIC_API_KEY"   # set credentials (optional baseUrl)
bbl config use anthropic/claude-sonnet-4-6       # set the default model
bbl go                                           # start the production TUI
```

Check the resolved configuration at any time:

```bash
bbl config list                                  # show active config and resolved settings
```

## Provider reference

| Provider | Adapter | Auth | Default base URL | Default model | Notes |
| --- | --- | --- | --- | --- | --- |
| `anthropic` | anthropic-compatible | api-key | `https://api.anthropic.com` | `anthropic/claude-sonnet-4-6` | Claude family; Sonnet / Opus / Haiku / Fable. |
| `openai` | openai-compatible | bearer | `https://api.openai.com/v1` | `openai/gpt-5` | GPT and o-series models. |
| `deepseek` | openai-compatible | bearer | `https://api.deepseek.com` | `deepseek/deepseek-v4-pro` | Reasoner model available. |
| `moonshot` | openai-compatible | bearer | `https://api.moonshot.cn/v1` | `moonshot/kimi-for-coding` | Kimi models. |
| `zhipu` | anthropic-compatible | api-key | `https://open.bigmodel.cn/api/anthropic` | `zhipu/glm-5.1` | GLM family. |
| `minimax` | anthropic-compatible | api-key | `https://api.minimaxi.com/anthropic` | `minimax/MiniMax-M3` | MiniMax models. |
| `ollama` | openai-compatible | none | `http://localhost:11434/v1` | `ollama/qwen2.5-coder:7b` | Local; no API key. Run `ollama serve` first. |
| `local` | local | none | — | `local/coding-runtime` | Deterministic runtime for tests; no provider. |

Model IDs always take the form `provider/model` (for example
`anthropic/claude-sonnet-4-6` or `ollama/qwen2.5-coder:7b`).

## Per-provider notes

- **Anthropic / OpenAI** — cloud providers. Set the API key with `bbl config add`
  and you are ready; the default base URL is correct for the public endpoints.
- **DeepSeek / Moonshot** — OpenAI-compatible bearer-auth providers. Use the
  default base URL, or override it if you route through a proxy.
- **Zhipu / MiniMax** — these expose Anthropic-compatible endpoints, so BabeL-O
  talks to them through the `anthropic-compatible` adapter with an API key.
- **Ollama** — runs locally and needs **no API key** (`authMode: none`). Start
  the server first (`ollama serve`), pull a model (`ollama pull
  qwen2.5-coder:7b`), then `bbl config add ollama` and `bbl config use
  ollama/qwen2.5-coder:7b`. The default base URL points at `localhost:11434`.
- **Local** — the deterministic runtime used by tests. It is not a real model;
  do not use it for coding work.

## Custom base URLs and compatible endpoints

Pass a third argument to `bbl config add` to override the base URL — useful for
proxies, gateways, or any OpenAI-/Anthropic-compatible endpoint:

```bash
bbl config add openai "$OPENAI_API_KEY" https://my-gateway.example.com/v1
```

## Switch model or provider in the TUI

Inside `bbl go`, open the model configuration panel with `/model` or `Ctrl+L`.
You can change provider, API key, base URL, and model without leaving the TUI.

## Profiles

When you need several configurations (for example, a cloud profile and a local
Ollama profile), use profiles:

```bash
bbl config profile list                 # list profiles (and tombstones)
bbl config profile use <name>           # switch the active profile
bbl config profile delete <name>        # soft-delete (restorable)
bbl config profile restore <name>       # restore a tombstoned profile
```

Profiles are surfaced in the TUI through `/profile` and `/profiles`.

## Troubleshooting

- **`Unknown provider` / `Unknown model`** — the provider or model ID is
  misspelled. Run `bbl config list` to see what is configured, and remember the
  `provider/model` format.
- **Ollama requests fail** — confirm `ollama serve` is running and the model is
  pulled (`ollama list`). No API key is needed.
- **401 / auth errors on a cloud provider** — re-run `bbl config add <provider>
  <key>` with a valid key.
- **Compatible endpoint not responding** — override the base URL as the third
  argument to `bbl config add` and check the path (`/v1` for OpenAI-compatible,
  `/anthropic` or `/api/anthropic` for Anthropic-compatible).
