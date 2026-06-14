# BabeL-O

<p align="center">
  <img src="docs/assets/babel-o-logo.png" alt="BabeL-O 产品 logo" width="132" />
  <img src="docs/assets/kezhongke_logo_3d.png" alt="KezhongKe IP 品牌 logo" width="132" />
</p>

<p align="center">
  <strong>技术支援由 KezhongKe（壳中客）提供。</strong>
</p>

> **Nexus-first 的 AI 编程 agent：原生 Go TUI、持久化 session、工具感知执行、跨 session 协作。**

[English README](README.md)

---

## 为什么是 BabeL-O？

市面上的编程 agent 基本都长一个样：Node 进程、Electron、云端往返、或者一次性 chat。BabeL-O 沿着真正卡脖子的那条线把问题拆开：

- **多 session 跨 worktree 并行执行，状态不丢。** Nexus 守护进程持有持久化 runtime；客户端可以断线、重连、换机器。任务不会因为 TUI 没了就死。_技术对照：process-per-session 模型 + Nexus `bbl serve` / embedded 模式 + `/sessions tree` / `/inbox`。_
- **10 MB 原生 Go TUI，线上无 Node。** `bbl go` 是用 Bubble Tea 写的客户端，通过 HTTP/WS 跟 Nexus 通信；可以丢到容器、远端、低速 SSH 里，**不**带 Node。_技术对照：`clients/go-tui` Go module，单个静态二进制，连接前先 `--check` 健康检查。_
- **是能用的 agent loop，不是 demo。** 上下文压缩、证据路由、权限门、sub-agent 协作、超时恢复后还能继续。_技术对照：`src/runtime/cacheAwareCompactPolicy.ts`、`src/runtime/runtimePipeline.ts`、`src/permissions/`、`src/nexus/everCoreRuntimeManager.ts`。_

---

## BabeL-O 是什么？

BabeL-O 是为真正写代码而生的终端 AI agent。交互客户端保持轻量与响应速度，Nexus 持有持久化 runtime 状态：session、工具、权限、上下文、记忆、执行轨迹。

默认的交互入口是 Go TUI：

```bash
bbl go
```

它会连接 Nexus（如果本地没有会自动起一个），给你一个打磨过的终端工作区：聊天、跑工具、切 session、看上下文、批权限、跨 session 协作。

---

## 5 分钟快速开始

> **前置条件**：Node.js ≥ 22（`node --version`）。macOS / Linux / Windows-WSL。

```bash
# 1. 安装
npm i -g babel-o

# 2. 验证
bbl --version

# 3. 选 provider + model
bbl init                          # 交互式 wizard,或:
bbl init --non-interactive --provider anthropic --model claude-3-5-sonnet-latest

# 4. 聊天
bbl go                            # 生产级原生 Go TUI

# 5. 试试看
> 解释这个 repo 的入口文件
```

TUI 内快捷键:

| 输入 | 动作 |
| :--- | :--- |
| `/` | 打开 slash 命令面板 |
| `/session` | 打开 session 操作面板 |
| `/context` | 查看当前上下文预算与诊断 |
| `/tools` 或 `Ctrl+O` | 打开工具面板 |
| `/model` 或 `Ctrl+L` | 打开 model / profile 切换 |
| `/memory` | 查看 memory 状态、检索、审查候选 |
| `Ctrl+D` | 打开顶部状态面板 |
| `Shift+Enter` | 在输入框里插入换行 |
| `Ctrl+C` | 打开退出确认 |
| `Esc` | 关闭当前面板/对话框 |

---

## 试试这些 prompt

直接复制下面任意一条,亲身体验 BabeL-O 的差异化:

- `> 在 /tmp/demo 里搭一个 Python 项目,跑通 pytest,提交到新 branch` —— 一次 turn 走完 Bash + Edit + Git。
- `> 并行起 3 个 worktree,各修 TODO.md 里的一个 P0,然后合并回 main` —— 跑 worktree + sub-agent + session tree。
- `> 用 bbl run 起一个长迁移任务,中途断网,重连,确认任务续传` —— 跑 Nexus 守护进程的持久化。
- `> 后台开 MemoryOS,跑 5 个 session,然后问"上周 auth 模型我们怎么定的?"` —— 跑长期记忆 bootstrap + 召回。

---

## 核心特性

- **生产级 Go TUI**：`bbl go` 是日常交互客户端,Bubble Tea 界面、多行输入、slash 命令面板、权限对话框、上下文检查、响应式 transcript 渲染。
- **持久化 Nexus Session**：session 历史、工具 trace、usage telemetry、压缩后的上下文、可检查的 session 元数据都能跨重启保留。
- **Session 切换与对话流**：`/session` 面板支持创建、选择、切换、复制 session ID,全程不离开 TUI。
- **SessionChannel 协作**：类型化的侧信道消息让 session 交换 findings、handoff、review 请求、决策、memory 候选,不会被当作直接的用户指令执行。
- **上下文与记忆感知**：`/context` 展示预算、压缩、记忆、恢复、working set 诊断,长对话也可读。
- **长期记忆（MemoryOS）**：可选的本地长期记忆,跑 managed sidecar。opt-in 启动,首次 `bbl go` 会提示/显示状态;失败时一行黄色提示,而不是沉默降级。
- **权限优先的工具系统**：Bash / Write / Edit / MCP 工具等敏感操作都要经过显式审批,支持 session 级信任和审计日志。
- **MCP 与内建工具**：Read / Grep / ListDir / Bash / WebSearch / 配置过的 MCP server 全部暴露,带风险分级。
- **Model 与 Profile 控制**：TUI 内切换 model / provider profile,Nexus 保持 runtime 配置一致。
- **Runtime 稳定性修补**：session 重放、上下文压缩、证据路由、超时恢复、安装自检全部加固,长时间 Go TUI session 恢复更可预测。

---

## 长期记忆（MemoryOS）

MemoryOS 是可选的本地长期记忆服务。它在 loopback 起一个 managed sidecar,索引你授权的 session,让模型在之后能回忆起来。**默认关闭、opt-in,永远不替代工作区证据**——它是 hint 层,不是事实源。

快速上手:

```bash
bbl memory status                 # 看 MemoryOS 是否已就绪
bbl memory setup --yes            # 一次性 bootstrap(后台 clone + build)
bbl memory opt-out                # 永久关掉首启询问
bbl memory enable-tools           # 让模型可写笔记(默认是只读 hint)
bbl memory doctor                 # 诊断记忆是否就绪
```

默认情况下模型看不到 MemoryOS 写工具。如果想让模型明确记忆某些事情,先跑 `bbl memory enable-tools`。设置会持久化到 `~/.babel-o/everos-bootstrap.json`(环境变量仍优先)。

详细流程见 [FAQ → Q4](docs/nexus/FAQ.md),设计见 [MemoryOS Zero-Friction Startup Plan](docs/nexus/reference/everos-zero-friction-memory-startup-optimization-plan.md)。

---

## 安装

### 推荐：`npm i -g babel-o`

单一推荐路径。macOS / Linux / Windows-WSL 通用。需要 Node.js ≥ 22。

```bash
npm i -g babel-o
bbl --version
```

### 备选：便携 release 包

如果想不带 Node 装(比如丢进没有 Node 的容器),用 portable 包。包含 Go TUI 二进制和 Nexus CLI/runtime,只有 fallback 路径才需要系统 Node。

- 从 [GitHub Releases](https://github.com/SuTang-vain/BabeL-O/releases) 下载最新的 `bbl-<platform>.tar.gz`,或看 [release notes](docs/releases/README.md)。
- 解压,把 `bin/` 加到 `$PATH`,然后 `bbl go`。
- SHA256 校验信息已经在 release 元数据里。

### 备选：install 脚本

```bash
curl -fsSL https://raw.githubusercontent.com/SuTang-vain/BabeL-O/main/scripts/install.sh | bash
bbl go
```

指定版本:在管道前加 `BBL_VERSION=v0.3.7 bash`。

### 从源码构建

前置：Node.js ≥ 22、npm、Go toolchain（TUI 需要）、可选 Docker（沙箱 shell）。

```bash
git clone https://github.com/SuTang-vain/BabeL-O.git
cd BabeL-O
npm ci
npm test
npm run build
npm link
bbl go
```

构建 portable 包:

```bash
npm run build
cd clients/go-tui && make build && cd ../..
npm run build:portable
```

---

## 配置

BabeL-O 把本地配置存在 `~/.babel-o/config.json`。首次运行建议用 `bbl init` 交互式设置,不要手编。

```json
{
  "providerId": "anthropic",
  "modelId": "anthropic/claude-3-5-sonnet",
  "apiKey": "sk-ant-...",
  "baseUrl": "https://api.anthropic.com"
}
```

支持的 provider：`anthropic`、`openai`、`deepseek`、`moonshot`、`ollama`、`zhipu`、`minimax`、`local`（测试与基准用）。

运行时检查：

```bash
bbl config show
bbl doctor
bbl memory doctor
```

---

## Session 协作

BabeL-O 把 session-to-session 消息当作协作上下文,不是隐藏 prompt。消息可以携带 finding、handoff、review 请求、validation 请求、假设、决策、blocked 状态、memory 候选,但接收方仍要自己验证并显式执行。

```bash
bbl sessions list
bbl sessions tree
bbl sessions inbox <sessionId>
bbl sessions ack <sessionId> <messageId>
bbl sessions inspect <sessionId>
```

TUI 内,用 `/session` 创建或切换 session,`/inbox` 看跨 session 消息,`/activity` 看最近的协作事件。

---

## 常用命令

```bash
bbl go                            # 交互 TUI(Go,正式入口)
bbl run "解释这个 repo"           # 一次性 prompt,不开 TUI
bbl init                          # 首启 provider + model wizard
bbl doctor                        # 自检(provider、keychain、端口、memory)
bbl memory status                 # MemoryOS bootstrap + runtime 状态
bbl memory setup --yes            # 引导 MemoryOS
bbl nexus status                  # 检查 Nexus 健康
bbl sessions list                 # 列出持久化 session
bbl sessions inspect <sessionId>  # 查看 session 详情与 trace
bbl tools list                    # 列出可用工具
bbl tools audit                   # 工具审计
bbl config show                   # 当前配置
```

---

## TypeScript TUI 移除说明

旧的 `bbl chat` TypeScript TUI 已在 v0.3.7 从发布包中移除。正式交互入口是 `bbl go`; `bbl run` 继续用于一次性自动化与脚本场景。这样可以减小分发包体积,减少两套终端 UI 的重复维护,并把后续交互体验集中到原生 Go TUI。

## 安全模型

BabeL-O 设计上守住显式边界：

- 工作区路径检查防止遍历与 symlink 逃逸。
- 风险工具必须显式审批。
- 工具输入、输出、审批、拒绝、usage 事件全部持久化,可审计。
- SessionChannel 内容**永远不**作为直接指令执行。
- MemoryOS 结果是 hint,不是工作区事实的权威来源。
- Nexus 是 runtime 状态的唯一事实源,TUI 只负责交互。

---

## 文档

- [FAQ](docs/nexus/FAQ.md) —— 关于长期记忆、安装、配置的常见问题
- [Go TUI 客户端指南](clients/go-tui/README.md)
- [Nexus 规划与实现笔记](docs/nexus/README.md)
- [Release notes](docs/releases/README.md)
- [MemoryOS First-Run Onboarding Plan](docs/nexus/reference/everos-first-run-onboarding-optimization-plan.md)
- [MemoryOS Zero-Friction Startup Plan](docs/nexus/reference/everos-zero-friction-memory-startup-optimization-plan.md)

---

## 许可证

本项目以 MIT 协议开源,详见 [LICENSE](LICENSE)。
