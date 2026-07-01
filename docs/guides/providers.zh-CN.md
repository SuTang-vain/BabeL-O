# Provider 与模型

[English](providers.md)

BabeL-O 通过三套 adapter 支持 8 个 provider。用 `bbl config` 命令(或 TUI 内的
`/model` 面板)配置,并随时切换 model 或 provider。

## 快速开始

设凭证和默认模型,然后启动 TUI:

```bash
bbl config add anthropic "$ANTHROPIC_API_KEY"   # 设凭证(可选 baseUrl)
bbl config use anthropic/claude-sonnet-4-6       # 设默认模型
bbl go                                           # 启动正式 TUI
```

随时查看已解析的配置:

```bash
bbl config list                                  # 查看当前配置与解析结果
```

## Provider 参考

| Provider | Adapter | 认证 | 默认 Base URL | 默认模型 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `anthropic` | anthropic-compatible | api-key | `https://api.anthropic.com` | `anthropic/claude-sonnet-4-6` | Claude 系列;Sonnet / Opus / Haiku / Fable。 |
| `openai` | openai-compatible | bearer | `https://api.openai.com/v1` | `openai/gpt-5` | GPT 与 o 系列模型。 |
| `deepseek` | openai-compatible | bearer | `https://api.deepseek.com` | `deepseek/deepseek-v4-pro` | 含 reasoner 模型。 |
| `moonshot` | openai-compatible | bearer | `https://api.moonshot.cn/v1` | `moonshot/kimi-for-coding` | Kimi 模型。 |
| `zhipu` | anthropic-compatible | api-key | `https://open.bigmodel.cn/api/anthropic` | `zhipu/glm-5.1` | GLM 系列。 |
| `minimax` | anthropic-compatible | api-key | `https://api.minimaxi.com/anthropic` | `minimax/MiniMax-M3` | MiniMax 模型。 |
| `ollama` | openai-compatible | none | `http://localhost:11434/v1` | `ollama/qwen2.5-coder:7b` | 本地;无需 API key。先 `ollama serve`。 |
| `local` | local | none | — | `local/coding-runtime` | 测试用确定性 runtime;非真实模型。 |

Model ID 统一格式为 `provider/model`(如 `anthropic/claude-sonnet-4-6` 或
`ollama/qwen2.5-coder:7b`)。

## 各 Provider 说明

- **Anthropic / OpenAI** —— 云 provider。用 `bbl config add` 设 API key 即可,
  默认 base URL 对应官方端点。
- **DeepSeek / Moonshot** —— OpenAI-compatible、bearer 认证。用默认 base URL,
  或在走代理时覆盖。
- **Zhipu / MiniMax** —— 暴露 Anthropic-compatible 端点,BabeL-O 通过
  `anthropic-compatible` adapter + API key 接入。
- **Ollama** —— 本地运行,**无需 API key**(`authMode: none`)。先启动服务
  (`ollama serve`)、拉模型(`ollama pull qwen2.5-coder:7b`),再
  `bbl config add ollama` 与 `bbl config use ollama/qwen2.5-coder:7b`。默认 base URL
  指向 `localhost:11434`。
- **Local** —— 测试用确定性 runtime,不是真实模型,不要用于编码工作。

## 自定义 Base URL 与兼容端点

`bbl config add` 第三参数可覆盖 base URL——适用于代理、网关或任意
OpenAI / Anthropic 兼容端点:

```bash
bbl config add openai "$OPENAI_API_KEY" https://my-gateway.example.com/v1
```

## 在 TUI 内切换 model / provider

`bbl go` 内用 `/model` 或 `Ctrl+L` 打开模型配置面板,可不离开 TUI 修改 provider、
API key、base URL 与 model。

## Profile

需要多套配置(如一个云 profile + 一个本地 Ollama profile)时用 profile:

```bash
bbl config profile list                 # 列出 profile(含 tombstone)
bbl config profile use <name>           # 切换当前 profile
bbl config profile delete <name>        # 软删除(可恢复)
bbl config profile restore <name>       # 恢复已 tombstone 的 profile
```

TUI 内通过 `/profile` 与 `/profiles` 查看。

## 排错

- **`Unknown provider` / `Unknown model`** —— provider 或 model ID 拼错。用
  `bbl config list` 查看已配置项,注意 `provider/model` 格式。
- **Ollama 请求失败** —— 确认 `ollama serve` 在运行且模型已拉取(`ollama list`)。
  无需 API key。
- **云 provider 401 / 认证错误** —— 用有效 key 重新 `bbl config add <provider>
  <key>`。
- **兼容端点无响应** —— 用 `bbl config add` 第三参数覆盖 base URL,并检查路径
  (OpenAI-compatible 用 `/v1`,Anthropic-compatible 用 `/anthropic` 或
  `/api/anthropic`)。
