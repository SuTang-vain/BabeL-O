# 快速开始

[English](quickstart.md)

大约五分钟，从零到第一次 BabeL-O 编码会话。

## 前置要求

- **macOS**（Apple Silicon 或 Intel）或 **Linux**（x64 或 arm64）
- **Node.js >= 22** 已加入 `PATH`（运行 `node --version` 确认）

## 第一步：安装

推荐使用发布安装器。它会下载预编译的 Go TUI 二进制文件和轻量 `bbl` 启动器，然后运行自检。

```bash
curl -fsSL https://raw.githubusercontent.com/SuTang-vain/BabeL-O/main/scripts/install.sh | bash
```

安装完成后，`bbl` 即已加入 `PATH`。

> **npm 替代方案：** `npm install -g babel-o` 也可用，适合已安装 npm 工具链的用户。
> 发布安装器更好，因为它包含针对你平台的原生 Go TUI 二进制文件。

验证安装：

```bash
bbl doctor
```

如果看到内存状态行且没有错误信息，则运行时就绪。你也可以用 `bbl go --check --no-start-nexus` 运行更详细的就绪检查。

## 第二步：配置提供商

BabeL-O 需要模型提供商的凭据才能发送提示。

使用你的 API 密钥配置 Anthropic（默认提供商）：

```bash
bbl config add anthropic "$ANTHROPIC_API_KEY"
bbl config use anthropic/claude-sonnet-4-6
```

第一条命令存储密钥。第二条设置默认模型 ——
`anthropic/claude-sonnet-4-6` 是默认值，也是一个很好的起点。

查看配置：

```bash
bbl config list
```

你会看到当前配置文件内容、你的提供商（密钥已打码）以及已解析的设置，包括默认模型 ID。
如果 `defaultModel` 为空，请重新运行上面的 `bbl config use` 步骤。

> **其他提供商：** BabeL-O 还支持 OpenAI、DeepSeek、Ollama、Moonshot、
> Zhipu、MiniMax 以及本地测试运行时。详见[提供商指南](providers.zh-CN.md)。

## 第三步：启动 TUI

```bash
bbl go
```

首次启动时，`bbl go` 会检查本地 Nexus 运行时是否已在运行。
如果没有，它会自动启动一个，分配会话，然后在备用屏幕上打开 Go TUI。

你会看到：

- **状态头部** —— 顶部显示当前会话 ID 和模型。
- **主转录区域** —— 初始为空，等待输入。
- **输入栏** —— 底部用于输入提示。
- **底部栏** —— 按键提示。

## 第四步：运行第一个提示

输入（或粘贴）以下提示，按 **Enter**：

```text
explain this repository and point me to the entry points
```

接下来会发生：

1. **流式响应** —— 助手在转录区域逐字开始回答，你可以实时看到推理过程。
2. **工具调用** —— 当 BabeL-O 决定需要读取文件或运行命令时，转录区会显示工具调用块，
   带有 `[tool: Read]` 或 `[tool: Bash]` 等标签。
3. **权限提示** —— 工具首次被调用时，底部会弹出权限对话框。你可以
   **批准**（按 `a` 或 `y`）、**拒绝**（按 `r` 或 `n`），
   或**为整个会话批准**（按 `A`）。

第一个提示通常会触发文件读取（`Read`、`Grep`、`Glob`）来了解仓库结构，然后给出最终回答。

## 第五步：批准工具、检查上下文

当权限提示出现时：

- 按 **`a`**（或 **`y`**）批准单次使用。
- 按 **`A`**（大写字母）批准该工具在整个会话中使用，之后不再重复询问。

工具执行后，结果会内联显示在转录区。你可以用方向键或 Page Up / Page Down 翻阅完整对话。

查看助手内部跟踪的信息，打开上下文面板：

- 输入 **`/context`** 并按 Enter —— 显示上下文预算、压缩状态、记忆提示、工作集和长上下文诊断。

TUI 中其他有用的斜杠命令：

| 命令        | 功能 |
| :----------- | :--- |
| `/model`     | 切换提供商、API 密钥、基础 URL 或模型 |
| `/session`   | 创建、切换或复制会话 ID |
| `/tools`     | 打开工具审计面板 |
| `/memory`    | 查看 MemoryOS 状态（如已启用） |
| `/help` 或 `?` | 打开帮助面板 |

按 **Ctrl+C** 打开退出对话框，然后按 **`y`** 或 Enter 退出。

## 接下来可以尝试

- **无需 TUI 的一次性提示：** `bbl run "summarize the changes in the last three commits"`
- **创建独立会话：** 在 TUI 内使用 `/session` 为新任务生成第二个会话，然后在它们之间切换。
- **查看工具审计：** 在终端运行 `bbl tools audit`，查看所有可用工具及其当前权限状态。
- **启用 MemoryOS：** `bbl memory setup --yes` 开启可选的本地长期记忆功能，跨会话持久化知识。
- **会话中切换模型：** 在 TUI 中按 `/model`，尝试 Opus 进行深度推理，或 Haiku 进行快速编辑。

完整提供商参考见[提供商指南](providers.zh-CN.md)，常见问题见[FAQ](FAQ.md)。
