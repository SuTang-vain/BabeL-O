# BabeL-O

<p align="center">
  <img src="docs/assets/babel-o-logo.png" alt="BabeL-O 产品 logo" width="132" />
  <img src="docs/assets/kezhongke_logo_3d.png" alt="壳中客 IP 品牌 logo" width="132" />
</p>

<p align="center">
  <strong>由 KezhongKe（壳中客）提供技术支持。</strong>
</p>

> **以 Nexus 为核心的 AI 编程智能体，提供快速 Go TUI、持久化 session、工具权限治理与跨 session 协作能力。**

[English README](README.md)

---

## BabeL-O 是什么？

BabeL-O 是面向真实开发工作的终端 AI agent。交互端保持轻量、快速、稳定；Nexus 负责持久化运行状态，包括 session、工具、权限、上下文、记忆与执行轨迹。

当前正式交互入口是 Go TUI：

```bash
bbl go
```

它会连接 Nexus，并可在本地 Nexus 不健康时自动拉起服务。你可以在同一个终端界面中完成对话、工具调用、session 切换、context 查看、权限审批和跨 session 协作。

<p align="center">
  <img src="docs/assets/product.png" alt="BabeL-O Go TUI 产品截图" width="920" />
</p>

---

## 核心亮点

- **正式 Go TUI**：`bbl go` 是日常交互客户端，提供 Bubble Tea 界面、多行输入、斜杠命令面板、权限弹窗、context 面板和稳定的 transcript 渲染。
- **持久化 Nexus Session**：会话历史、工具轨迹、用量统计、压缩后的上下文和 session 元数据都可以跨重启保留与检查。
- **Session 切换与对话流**：`/session` 面板支持创建、选择、切换 session，并可复制当前 session id。
- **SessionChannel 协作**：不同 session 可以交换 finding、handoff、review request、decision、memory candidate 等类型化消息，但这些消息永远只是协作上下文，不会被当作直接用户指令执行。
- **上下文与记忆可视化**：`/context` 展示 token budget、压缩状态、记忆注入、恢复信息和 working set，让长对话状态更透明。
- **记忆管理面板**：`/memory` 提供只读状态、受限记忆搜索、review-only 记忆候选和需要确认的 save/flush 操作。
- **权限优先的工具系统**：Bash、Write、Edit、MCP 等敏感工具通过可见审批流执行，并保留 session 级信任和审计记录。
- **MCP 与内置工具**：内置 Read、Grep、ListDir、Bash、WebSearch，并支持从 `mcp.json` 接入 MCP server。
- **模型与 Profile 控制**：可在 TUI 中切换模型、provider 和 profile，配置状态由 Nexus 统一维护。
- **运行稳定性修复**：session replay、context 压缩、证据路由、timeout 恢复和安装自检都经过加固，长时间 Go TUI 会话恢复路径更可预测。

---

## 安装

### 发布版安装脚本

macOS 和 Linux 下，安装脚本会检测系统与架构，安装匹配的 `bbl` release 二进制，并同时安装正式入口 `bbl go` 使用的 Go TUI 二进制：

```bash
curl -fsSL https://raw.githubusercontent.com/SuTang-vain/BabeL-O/main/scripts/install.sh | bash
bbl go
```

安装指定版本：

```bash
curl -fsSL https://raw.githubusercontent.com/SuTang-vain/BabeL-O/main/scripts/install.sh | BBL_VERSION=v0.3.4 bash
bbl go
```

### 手动下载发布二进制

从 [GitHub Releases](https://github.com/SuTang-vain/BabeL-O/releases) 下载最新单文件可执行二进制和匹配的 `go-tui-*` 资产，也可以查看 [v0.3.4 发布说明](docs/releases/v0.3.4.md) 中的版本下载链接。

将下载好的 `bbl` 放入系统 `$PATH` 后运行：

```bash
bbl go
```

### 从源码构建

前提条件：

- Node.js >= 22
- npm
- 本地开发 Go TUI 时需要 Go toolchain
- 可选 Docker，用于隔离 Shell 执行

```bash
git clone https://github.com/SuTang-vain/BabeL-O.git
cd BabeL-O
npm ci
npm test
npm run build
npm link
bbl go
```

构建 Node 单文件二进制：

```bash
npm run build:binary
./dist/bbl go
```

构建源码树中的 Go TUI 本地二进制：

```bash
cd clients/go-tui
make build
cd ../..
bbl go --check
```

---

## 快速开始

```bash
bbl go                           # 启动正式 Go TUI
bbl go --check                   # 检查 Go TUI 二进制、Nexus 健康度和版本兼容
bbl run "summarize this repo"     # 不打开 TUI，执行一次性 prompt
bbl nexus status                 # 检查 Nexus 状态
bbl sessions list                # 列出持久化 session
bbl sessions inspect <sessionId> # 查看 session 详情与工具轨迹
bbl tools list                   # 列出可用工具
bbl tools audit                  # 查看工具审计历史
bbl config show                  # 查看当前配置
```

Go TUI 内常用操作：

| 输入 | 功能 |
| :--- | :--- |
| `/` | 打开斜杠命令面板 |
| `/session` | 打开 session 操作面板 |
| `/context` | 查看当前 context budget 与诊断信息 |
| `/tools` 或 `Ctrl+O` | 打开工具面板 |
| `/model` 或 `Ctrl+L` | 打开模型/profile 选择 |
| `/memory` | 查看记忆状态、搜索记忆 hint、审阅候选记忆 |
| `Ctrl+D` | 打开顶部状态面板 |
| `Shift+Enter` | 在输入框中插入换行 |
| `Ctrl+C` | 打开退出确认弹窗 |
| `Esc` | 关闭当前面板或弹窗 |

---

## Session 协作

BabeL-O 将 session-to-session 消息视为协作上下文，而不是隐藏 prompt。一条消息可以表达 finding、handoff、review request、validation request、hypothesis、decision、blocked 状态或 memory candidate，但接收方仍必须显式核实和行动。

常用命令：

```bash
bbl sessions list
bbl sessions tree
bbl sessions inbox <sessionId>
bbl sessions ack <sessionId> <messageId>
bbl sessions inspect <sessionId>
```

在 Go TUI 中，可用 `/session` 创建或切换 session，用 `/inbox` 查看跨 session 消息，用 `/activity` 查看近期协作事件。

---

## 配置

BabeL-O 使用 `~/.babel-o/config.json` 保存本地配置。

示例：

```json
{
  "providerId": "anthropic",
  "modelId": "anthropic/claude-3-5-sonnet",
  "apiKey": "sk-ant-...",
  "baseUrl": "https://api.anthropic.com"
}
```

支持的 provider 包括：

- `anthropic`
- `openai`
- `deepseek`
- `moonshot`
- `ollama`
- `zhipu`
- `minimax`
- `local`，用于测试和基准压测

---

## 安全模型

BabeL-O 围绕明确边界设计：

- 工作区路径检查会阻止目录穿越和 symlink 逃逸。
- 高风险工具需要可见的权限决策。
- 工具输入输出、批准/拒绝记录和用量事件都会持久化，便于回溯。
- SessionChannel 内容不会作为直接指令执行。
- Nexus 是运行状态的事实源，TUI 专注于交互体验。

---

## 文档

- [发布说明](docs/releases/README.md)
- [Go TUI 客户端说明](clients/go-tui/README.md)
- [Nexus 规划与实现记录](docs/nexus/README.md)

---

## 开源协议

本项目采用 MIT 开源协议。详情请参阅 [LICENSE](LICENSE)。
