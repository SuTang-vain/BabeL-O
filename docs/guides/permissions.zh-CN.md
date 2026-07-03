# 权限与工具审批

[English](permissions.md)

BabeL-O 中的每个工具都带有一个**风险等级**，该等级决定 AI 模型是可以自由调用该工具，还是必须征求你的批准。本指南说明权限模型在 TUI（`bbl go`）中的工作方式、各风险等级的含义，以及如何控制哪些工具被允许使用。

## 四个风险等级

每个工具在定义时都设有一个静态风险等级。BabeL-O 目前区分以下四个等级：

| 等级 | 含义 | 示例 |
| --- | --- | --- |
| **read** | 无副作用地读取数据 | `Read`、`Grep`、`Glob`、`ListDir` |
| **write** | 创建或修改文件/状态 | `Write`、`Edit` |
| **execute** | 执行任意命令或网络调用 | `Bash`、`curl`、`npm install` |
| **task** | 启动子 agent 或长时间运行的任务 | Agent 任务分发 |

**Read** 工具始终由分类器自动批准，无需征求许可。**write** 和 **execute** 工具需要批准，除非有会话规则或白名单匹配。**task** 保留给 agent 或子任务分发，遵循与 write/execute 相同的策略评估路径。

## TUI 中的审批方式

当 AI 调用需要批准的工具时，Go TUI（`bbl go`）会在屏幕底部显示一个**权限面板**，包含以下信息：
- 工具名称和输入
- 风险等级
- 作用域风险（如果工具访问当前任务作用域之外的文件）
- 模型建议的允许规则（如果有）

### 快捷键

| 按键 | 操作 |
| --- | --- |
| `a` / `y` | 批准当前请求 |
| `r` / `n` | 拒绝当前请求 |
| `1` — `5` | 直接从 5 选项菜单选择 |

### 5 选项菜单

权限面板提供五个选项，可用方向键导航：

1. **批准一次（Approve once）** — 仅允许此调用通过；下次调用仍需询问。
2. **为本会话批准（Approve for this session）** — 信任建议规则，在会话剩余时间内有效（当同一规则重复出现时推荐）。
3. **使用可编辑规则批准（Approve with editable rule）** — 批准前编辑允许规则。打开预填建议规则的内联文本输入框。
4. **拒绝（Reject）** — 拒绝调用并将控制权返回给模型。
5. **拒绝并告知模型替代方案（Reject, tell the model what to do instead）** — 拒绝调用并输入让模型参考的反馈。

对于选项 2 和 3，规则（如 `bash:status` 或 `npm:install`）会在会话中持久化，因此匹配的未来调用将跳过权限提示。

### 带反馈的拒绝

当你选择选项 5，或在对话框中按下 `D` 键时，面板会切换到一个文本输入框，你可以在其中描述模型应该做什么。模型将在下一步收到此反馈。

## 策略模式：strict 与 soft-deny

策略模式控制当工具**不在服务器白名单中**时会发生什么：

- **strict**（默认）：工具在权限提示触发之前被策略拦截。在 strict 模式下，对于不在白名单中的工具，用户永远不会看到权限对话框——模型直接收到策略拒绝。
- **soft-deny**：绕过策略拦截。现有的审批关卡会为 write/execute 工具发出 `permission_request` 事件，因此用户可以通过 TUI 权限面板批准该调用。

Go TUI 在通过 `bbl go` 连接时默认为 **soft-deny**，这是交互式工作的推荐设置。当你希望强制执行固定白名单并完全避免审批提示时，请使用 strict 模式。

服务器端默认值由 `NEXUS_DEFAULT_POLICY_MODE` 环境变量控制（可选值：`strict` 或 `soft-deny`）。

### 每轮白名单

启动 `bbl go` 时，可以通过 `--allowed-tools Read,Grep,Glob,Bash` 设置每轮白名单。列表中的工具在该轮中自动执行，无需权限提示。下一轮从请求体中重新评估。

## Bash 只读降级

Bash 工具为审计清晰性始终声明 `risk: 'execute'`，但运行时会应用一个基于输入的**分类器，将只读子命令降级为 `risk: 'read'`**。这意味着安全命令可以完全跳过审批关卡。

### 被视为只读（无需批准）的命令

`ls`、`cat`、`head`、`tail`、`wc`、`file`、`stat`、`readlink`、
`pwd`、`echo`、`whoami`、`hostname`、`date`、`uname`、`env`、
`printenv`、`ps`、`top`、`uptime`

### 被视为只读的 Git 子命令

`git status`、`git log`、`git diff`、`git show`、`git remote`、
`git rev-parse`、`git ls-files`、`git tag`、`git branch`
（仅限检查标志，如 `--show-current`）

### Grep 和 sed 限制

`grep` 只在安全标志（`--line-number`、`--fixed-strings`、`--ignore-case` 等）下并且提供了模式+文件时被视为只读。`sed` 仅在只打印模式且使用行范围 `p` 脚本时被视为只读。

### 始终需要批准的情况

- 命令链（`&&`、`;`、`||`）
- 重定向（`>`、`>>`、`<`、`|`）
- 命令替换（反引号、`$()`）
- 包管理器：`npm install`、`yarn add`、`pip install`、`brew install`、`apt install`
- 破坏性操作：`rm -rf`、`mv`、`sudo`、`chmod`、`curl | sh`
- Git 写入操作：`git push`、`git commit`、`git checkout` 等
- 任何不在只读白名单中的命令

当命令被升级为 `execute` 时，权限面板会显示分类器规则（例如 `command:sudo-anywhere` 或 `chained-and`），让你清楚知道模型为何需要批准。

## 路径和工作空间安全

BabeL-O 通过两种机制将工具操作限制在工作空间边界内：

- **NEXUS_ALLOWED_WORKSPACES** — 一个环境变量，列出逗号分隔的工作空间路径。设置后，解析到这些目录之外的路径会在工具执行前被拒绝，并抛出 `WorkspacePathError`。该错误不可恢复——模型无法绕过它。
- **任务作用域边界** — 当工具访问当前任务主根目录之外的目录（例如父目录、同级仓库、历史会话路径）时，运行时会发出 `scope_boundary_detected` 事件，并请求用户显式确认后再继续。

如果路径被工作空间安全机制阻止，模型会收到一条明确的消息，说明边界无法绕过，必须在你允许的工作空间内操作。

## 审计

### `/tools` 面板

在 `bbl go` 中，按 **Ctrl+O**（或输入 `/tools`）打开**工具审计**覆盖层。它显示每个已注册工具的风险等级、来源（内置或 MCP）、审批状态、描述以及任何建议的允许规则。

### `bbl tools audit`

在命令行中运行：

```bash
bbl tools audit
```

这会以 JSON 格式输出相同的审计数据，你可以通过管道传递给 `jq` 或其他工具进行脚本处理。

## 疑难解答

**"某个工具一直在请求批准"**

检查它是否是 Bash 工具，且命令无法被分类器降级为 `read`。如果命令包含操作符（`&&`、`;`、`>`）或调用了不在白名单中的命令，分类器会将其升级为 `execute`，此时需要批准。你可以：

- **为本会话批准**（选项 2）——存储会话规则，使同一工具调用模式在此会话中不再提示。
- 将服务器切换为 `policyMode: 'soft-deny'`，并向 `bbl go` 传递 `--allowed-tools '*'` 以默认允许所有工具（write/execute 调用仍会显示权限面板）。

**"模型一直尝试在我的工作空间之外写文件"**

工作空间边界在工具执行层强制执行，无法绕过。如果模型尝试访问类似 `../../etc` 或 `/var/log` 的路径，工具调用会失败并抛出 `WorkspacePathError`。提醒模型在项目目录内操作，或者在需要多目录访问时调整 `NEXUS_ALLOWED_WORKSPACES`。

**"我在对话记录中看到 'Tool denied by Nexus policy'"**

这意味着该工具不在服务器白名单中，并且服务器处于 `strict` 模式。使用 `--allowed-tools` 运行（或设置 `NEXUS_ALLOWED_TOOLS`）来添加该工具，或者切换到 `soft-deny` 模式。
