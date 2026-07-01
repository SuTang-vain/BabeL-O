# 故障排查指南

[English](troubleshooting.md)

本文覆盖使用 BabeL-O 时可能遇到的常见问题及修复命令。

---

## 1. `bbl` 未找到

**现象：** 安装后提示 `command not found: bbl`。

**原因：** `bbl` 启动器不在 `PATH` 中。发布安装器默认安装到
`~/.local/bin/babel-o/bbl`。

**修复：** 将该目录添加到 PATH，或重新安装：

```bash
curl -fsSL https://raw.githubusercontent.com/SuTang-vain/BabeL-O/main/scripts/install.sh | bash
```

如果通过 npm 安装，请确认 npm 全局 bin 目录在 PATH 中（通常是
`~/.npm-global/bin` 或 `$(npm config get prefix)/bin`）。

---

## 2. Node.js 版本过旧

**现象：** `bbl` 启动时报错，或安装脚本提示 Node.js 版本问题。

**原因：** BabeL-O 要求 Node.js >= 22。当前版本过旧。

**修复：** 升级 Node.js 到 v22 或更高版本（例如通过 `nvm`、`fnm` 或系统包管
理器），然后用 `node --version` 验证。

---

## 3. Go TUI 二进制未找到

**现象：** `bbl go` 报错 "Go TUI binary not found" 或类似信息。

**原因：** Go TUI 二进制文件缺失。通过 npm 安装时可能只得到了 JS 包，缺少预编
译的 TUI 二进制。

**修复：** 运行就绪检查查看完整诊断信息：

```bash
bbl go --check --no-start-nexus
```

该命令会报告哪些路径被搜索过及缺失原因。如果未找到预编译二进制，你可以：

- 重新用 `npm install -g babel-o` 安装（包含预编译二进制）。
- 设置 `BABEL_O_GO_TUI_BINARY` 环境变量指向手动下载的发布资产路径。
- 安装 Go 工具链并源码编译（`cd clients/go-tui && make build`）。

---

## 4. Nexus 无法启动或 `bbl go` 卡住

**现象：** `bbl go` 卡在 "waiting for Nexus health"，或 `bbl nexus status`
返回错误。

**常见原因与修复：**

- **端口被占用。** 默认端口为 3000。检查端口占用：

  ```bash
  lsof -i :3000
  ```

  停止冲突进程或指定其他端口启动：

  ```bash
  bbl nexus start --port 3001
  bbl go --url http://127.0.0.1:3001
  ```

- **Nexus 启动时崩溃。** 直接检查 Nexus 健康状态：

  ```bash
  bbl nexus status
  ```

  如果失败，运行 `bbl doctor` 做本地就绪检查。

- **启动超时。** 默认超时为 8 秒。在慢速机器上可以增加超时时间：

  ```bash
  bbl go --nexus-startup-timeout-ms 30000
  ```

---

## 5. 未知 provider / 未知模型

**现象：** 执行 `bbl config use` 或启动 TUI 时出现 "Unknown provider" 或
"Unknown model" 错误。

**原因：** provider ID 或 model ID 拼写错误。

**修复：** 查看当前生效配置和可用模型：

```bash
bbl config list
```

支持的 provider ID：`anthropic`、`openai`、`deepseek`、`moonshot`、
`ollama`、`zhipu`、`minimax`、`local`。

模型 ID 格式为 `provider/model`（例如 `anthropic/claude-sonnet-4-6` 或
`ollama/qwen2.5-coder:7b`）。先用 `bbl config list` 查看当前设置，然后修正：

```bash
bbl config use anthropic/claude-sonnet-4-6
```

---

## 6. 401 / 认证错误

**现象：** provider 返回 401 错误，模型无响应。

**原因：** API key 缺失、错误或已过期。

**修复：** 重新添加 provider 的凭据：

```bash
bbl config add anthropic "$ANTHROPIC_API_KEY"
```

确认凭据已保存（输出中密钥会被屏蔽）：

```bash
bbl config list
```

对于使用 bearer 认证的 provider（OpenAI、DeepSeek、Moonshot），同样使用
`bbl config add` 命令。Ollama 不需要 API key（`authMode: none`）。

---

## 7. Provider 流式响应卡住或超时

**现象：** 模型开始响应后中途卡住，或 TUI 显示超时。

**常见原因与修复：**

- **网络问题。** 检查能否连接到 provider 的 API 端点。
- **代理或网关。** 如果通过代理连接，覆盖 base URL：

  ```bash
  bbl config add anthropic "$ANTHROPIC_API_KEY" https://my-gateway.example.com
  ```

  OpenAI 兼容端点应以 `/v1` 结尾；Anthropic 兼容端点通常用
  `/api/anthropic` 或 `/anthropic`。
- **Provider 端限流。** 稍后重试，或切换到其他模型。

---

## 8. Ollama 服务器未运行或模型未拉取

**现象：** 向 Ollama 发起请求失败；TUI 无响应或报错。

**常见原因与修复：**

- **服务器未启动。** 使用 Ollama 前先启动服务器：

  ```bash
  ollama serve
  ```

- **模型未拉取。** 列出可用模型并拉取需要的模型：

  ```bash
  ollama list
  ollama pull qwen2.5-coder:7b
  ```

- **Ollama 未安装或不在 PATH 上。** 从 https://ollama.com 安装，然后启动服务
  器。

Ollama 不需要 API key（`authMode: none`）。确认 base URL：

```bash
bbl config add ollama    # 使用默认的 http://localhost:11434/v1
bbl config use ollama/qwen2.5-coder:7b
```

---

## 9. 上下文预算超限 / 模型开始遗忘

**现象：** 模型的回答变得模糊，或遗忘了对话前文。

**原因：** Token 预算接近或达到上限。运行时在 70% 用量时会自动压缩，但你也可
以手动触发。

**修复：**

1. 在 TUI 内打开上下文面板：`/context`。
2. 查看剩余预算和压缩余量。
3. 如需手动压缩：`/compact`。

这会总结较早的轮次和工具结果，只保留近期事件。也可以通过 CLI 检查上下文：

```bash
bbl context working-set              # 追踪的文件
bbl context history --since 24h      # 近期的行为轨迹
```

---

## 10. 工具频繁请求审批

**现象：** 每次模型执行命令时都弹出审批对话框。

**常见原因与修复：**

- **命令不在只读白名单中。** 像 `npm install`、`rm -rf` 或链式命令
  （`&&`、`|`、`>`）始终需要审批。在对话框中选择 **批准本次 session**
  （选项 2），可让相同模式在本 session 内不再提示。

- **服务器处于 strict 模式。** 在 strict 模式下，未列入白名单的工具在
  弹出审批前即被拦截。在交互模式下切换到 soft-deny：

  ```bash
  bbl go --allowed-tools '*'
  ```

- **查看工具风险等级。** 在 TUI 内用 `/tools` 或 Ctrl+O 打开工具面板，
  查看每个工具的风险等级。也可通过 CLI：

  ```bash
  bbl tools audit
  ```

---

## 11. "Tool denied by Nexus policy"

**现象：** 模型报告工具被策略拒绝，或 Transcript 中出现 "Tool denied by
Nexus policy"。

**原因：** 该工具不在服务器白名单中，且服务器运行在 `strict` 策略模式下。

**修复：** 将工具加入白名单或切换到 soft-deny 模式：

```bash
# 允许所有工具（soft-deny 模式，推荐交互使用）
bbl go --allowed-tools '*'

# 或限制为特定工具
bbl go --allowed-tools Read,Grep,Glob,Bash
```

也可以通过设置 `NEXUS_ALLOWED_TOOLS` 和 `NEXUS_DEFAULT_POLICY_MODE` 环境变量
进行持久化控制。

---

## 12. 重启后 session 丢失

**现象：** 关闭 `bbl go` 后重启，旧 session 不见了。

**常见原因与修复：**

- **Session 使用内存存储创建（NODE_ENV=test 或显式 `:memory:`）。** 在测试环
  境外运行 `bbl go`，以使用默认的 SQLite 存储
  `~/.babel-o/db.sqlite`。

- **查找并恢复 session。** 持久化的 session 可跨重启保留：

  ```bash
  bbl sessions list                          # 查找 session
  bbl inspect-session <sessionId> --resume   # 确认可恢复
  ```

  在 TUI 内：`/session use <sessionId>`。

---

## 13. MemoryOS 未工作或未配置

**现象：** 缺少记忆提示，或 `bbl doctor` 显示 "memory: not configured"。

**原因：** MemoryOS 是可选功能，尚未设置。

**修复：** 运行记忆系统诊断并按建议操作：

```bash
bbl doctor
bbl memory setup
```

可用命令参见
[README 中的 MemoryOS 章节](../README.md#memoryos)。

---

## 诊断命令参考

| 命令 | 检查内容 |
| :--- | :--- |
| `bbl doctor` | 本地就绪度（Node、配置、MemoryOS） |
| `bbl go --check --no-start-nexus` | Go TUI 二进制、Nexus 健康、版本兼容性 |
| `bbl config list` | 当前 provider 配置与解析设置 |
| `bbl nexus status` | Nexus 运行时健康状态 |
| `bbl tools audit` | 已注册工具与当前允许策略 |
| `bbl memory status` | MemoryOS 引导及运行时状态 |
| `bbl sessions list` | 持久化的 session ID |
| `bbl inspect-session <id>` | Session 诊断（事件数、压缩、可恢复性） |
| `bbl context working-set` | 追踪的工作集文件 |
| `bbl context history` | 行为轨迹历史 |
