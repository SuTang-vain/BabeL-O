# MCP（模型上下文协议）

[English](mcp.md)

BabeL-O 可以通过模型上下文协议（Model Context Protocol，MCP）使用外部工具。MCP 服务器作为子进程通过 stdio 启动，使用 JSON-RPC 2.0 通信。远程工具广告的每个工具都会成为 BabeL-O 的一等公民工具，与内置工具一样受相同的权限和风险系统管控。

## 支持范围

BabeL-O **仅实现 `tools/list` 和 `tools/call`**。以下 MCP 能力**尚未实现**：

- **Resources**（`resources/list`、`resources/read`）-- 不支持。
- **Prompts**（`prompts/list`、`prompts/get`）-- 不支持。
- **Roots**（`roots/list`）-- 不支持。

如果真实集成交互需要 resources 或 prompts，它们必须走与原生工具相同的 runtime 拥有的作用域处理和权限流程，而不能成为绕过内置 `Read` 工具或项目根目录门禁的通道。

## MCP 工具的呈现方式

每个远程工具注册为 `ToolDefinition`，名称格式为：

```
mcp:<serverName>:<originalToolName>
```

例如，名为 `filesystem` 的服务器中有一个 `read-file` 工具，注册后的名称为 `mcp:filesystem:read-file`。

每个 MCP 工具携带：

- `source.type: 'mcp'` -- runtime 和权限系统据此将其与内置工具区分。
- 风险等级 `risk`（`read`、`write`、`execute` 或 `task`），按服务器配置。
- 与内置工具相同的 `requiresApproval` / `suggestedAllowRule` 字段。
- `mcpServerAllowed` 门禁 -- 不在服务器 `allowedTools` 列表中的工具仍会注册，但执行时会被拒绝并返回错误信息。

## 权限与风险模型

MCP 工具遵循**与内置工具相同的风险分类、审批流程和路径安全规则**：

| 风险等级 | 行为 |
| --- | --- |
| `read` | 默认允许。 |
| `write` | 需要用户审批（或匹配的 allow 规则）。 |
| `execute` | 需要用户审批（或匹配的 allow 规则）。 |
| `task` | 需要审批，计入任务预算。 |

每个服务器的 `toolRisk` 映射可以按工具名称覆盖默认风险等级（默认为 `read`）。这是在服务器配置项中设置的（见下文）。

## 配置 MCP 服务器

### 1. 启用 MCP 功能开关

MCP 默认关闭。启动 BabeL-O 前设置环境变量：

```bash
export BABEL_O_ENABLE_MCP=1
bbl go
```

不设置此变量，MCP 服务器不会被启动，也不会注册任何 MCP 工具。

### 2. 编写服务器配置

MCP 服务器定义从 JSON 文件中读取，支持两个位置（项目配置覆盖用户配置）：

| 位置 | 作用域 |
| --- | --- |
| `~/.babel-o/mcp.json` | 用户全局（适用于所有项目） |
| `<项目根目录>/.babel-o/mcp.json` | 项目本地（覆盖用户配置） |

每个文件包含一个 `servers` 映射。每个服务器条目必须提供 `command`，可选 `args`、`env`、`cwd`、`allowedTools` 和 `toolRisk`。

```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
      "allowedTools": ["read-file", "list-directory", "search-files"],
      "toolRisk": {
        "read-file": "read",
        "list-directory": "read",
        "search-files": "read"
      }
    },
    "github": {
      "command": "node",
      "args": ["path/to/github-mcp-server/index.js"],
      "env": {
        "GITHUB_TOKEN": "ghp_..."
      },
      "allowedTools": ["*"],
      "toolRisk": {
        "list-issues": "read",
        "create-issue": "write",
        "merge-pr": "execute"
      }
    }
  }
}
```

#### 服务器条目字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `command` | string | 是 | 要启动的可执行文件。 |
| `args` | string[] | 否 | 传给命令的参数。 |
| `env` | object | 否 | 合并到 `process.env` 的额外环境变量。 |
| `cwd` | string | 否 | 子进程的工作目录。 |
| `allowedTools` | string[] | 否 | 工具白名单。`["*"]` 允许全部。不在列表中的工具会注册但拒绝执行。 |
| `toolRisk` | object | 否 | 按工具覆盖风险等级。键为工具名称，值为 `"read"`、`"write"`、`"execute"` 或 `"task"`。 |

### 3. 启动会话

```bash
export BABEL_O_ENABLE_MCP=1
bbl go
```

启动时，BabeL-O 会启动每个配置的 MCP 服务器，调用 `tools/list`，并注册返回的每个工具。如果某个服务器响应慢或无响应，只会阻塞该服务器的工具注册（惰性/并行启动已在计划改进中）。

## 调试

设置 `BABEL_O_MCP_DEBUG=1` 可将 MCP 服务器的 stderr 输出转发到终端：

```bash
export BABEL_O_MCP_DEBUG=1
export BABEL_O_ENABLE_MCP=1
bbl go
```

## 局限

- **启动时同步启动**：每个配置的服务器在工具注册表构建期间都会被启动。慢服务器会延迟启动。该项目已在 MCP 卫生计划中跟踪（Phase 4 -- 惰性/并行注册）。
- **不支持 resource/prompt/root**：详见上方"支持范围"。
- **无 `bbl config` 集成**：MCP 仅通过 `BABEL_O_ENABLE_MCP` 环境变量控制，通过 JSON 文件配置。目前没有用于 MCP 的 `bbl config` 子命令。
- **EverCore/MemoryOS MCP 工具**（由 `BABEL_O_ENABLE_EVERCORE_MCP_TOOLS` 或 `bbl memory enable-mcp` 控制）是用于 MemoryOS 集成的独立功能，不在本指南的涵盖范围内。
