# MCP

> 模块参考 · 稳定公开契约 · 深度架构见链接的治理文档

[English](mcp.md)

## 角色

MCP（Model Context Protocol）模块将外部工具服务器封装为 BabeL-O 可用的工具。
它拥有基于 stdio 的 JSON-RPC 2.0 客户端（`McpClient`）、服务器配置注册表
（`McpRegistry`），以及将远程 MCP 工具定义转换为 Nexus runtime 可消费的
`ToolDefinition` 实例的适配器（`McpToolAdapter`）。

MCP 是一个**叶子域**——它暴露狭窄的工具包装面，既不依赖也不感知执行引擎、
agent 循环或交互层。所有由 `createMcpToolRegistry` 注册的 MCP 工具都带有
`mcp:<serverName>:<originalName>` 命名前缀和 `source.type: 'mcp'` 身份标识，
使得 runtime 和权限系统能够将它们与本机内置工具区分。

## 公开契约

- **`McpClient(command, args?, env?, cwd?, framing?)`** —— 一个 stdio 子进程
  客户端，使用 JSON-RPC 2.0 协议，支持 `Content-Length` 或 `\n` 分隔的帧格式。
  它**只**支持 `tools/list` 和 `tools/call`。没有实现 resources、prompts、
  roots 或其他 MCP 协议能力。客户端预先连接，使用协议版本 `2024-11-05` 初始化，
  并向服务器标识为 `BabeL-O`。
- **`McpRegistry`** —— 从 `~/.babel-o/mcp.json`（用户级）→
  `<cwd>/.babel-o/mcp.json`（项目级覆盖用户级）加载合并后的服务器配置。
  每个服务器条目指定 `command`、`args`、`env`、`cwd`、`allowedTools` 和
  `toolRisk`（read / write / execute / task）。不在 `allowedTools` 中的工具仍会
  注册，但其 `execute` 会返回拒绝消息。
- **`createMcpToolRegistry(cwd)` → `Map<string, AnyTool>`** —— 遍历每个已配置
  的服务器，为每个服务器初始化一个 `McpClient`，调用 `tools/list`，将每个远程
  工具包装为带 `jsonSchemaToZod` 输入验证、风险分类和 `mcpServerAllowed` 门禁的
  `ToolDefinition`。这些工具随后由 Nexus 的 `createDefaultNexusRuntime`（通过
  `registerToolWithDiagnostics`）合并到全局工具映射中。

## 允许的依赖

MCP 处于模块图的底部，可以依赖 `shared`（版本常量）和 `tools`（`ToolDefinition`、
`AnyTool`、`ToolRisk` 类型）。层方向门禁（`deps:audit`，CI 强制）禁止反向：

- `runtime` → `mcp` **禁止**（runtime 不得直接依赖叶子 MCP 模块；MCP 工具在
  harness 阶段由 Nexus 注入）。
- `nexus` → `mcp` **允许**——仅通过 `nexus/createRuntime.ts` 中调用的窄入口
  `createMcpToolRegistry`。
- `mcp` → `nexus` / `mcp` → `cli` **禁止**（MCP 是叶子域，不得依赖任何执行层
  或交互层）。

完整叶子域规则与耦合热力图见
[层方向审计](../../nexus/reference/layer-direction-audit-enforcement-plan.md)
与
[模块耦合治理](../../nexus/reference/module-coupling-decoupling-and-re-aggregation-plan.md)。

## 扩展点

- **添加 MCP 服务器** —— 在 `~/.babel-o/mcp.json`（用户全局）或
  `<cwd>/.babel-o/mcp.json`（项目本地）中添加 JSON 条目，包含 `command`、
  可选的 `args` / `env` / `cwd`、`allowedTools` 白名单以及每个工具的
  `toolRisk` 分类。无需修改代码。
- **配置工具风险和白名单** —— 每个服务器的 `toolRisk` 映射可覆盖默认的 `read`
  风险等级；`allowedTools` 数组限制哪些工具可被调用。不在 `allowedTools` 中的
  工具仍会注册，但其 `execute` 将返回类似 `MCP_INPUT_SCHEMA_VALIDATION_FAILED`
  的拒绝消息。
- **未来协议扩展** —— MCP resources、prompts 和 roots 目前不支持。如果真实
  集成交互需要它们，则必须走与原生工具相同的 runtime 拥有的作用域处理与权限流，
  而不能成为绕过 `Read` 或项目根目录门禁的通道。这在工具治理文档中标记为
  plan-only 候选。

## 相关治理

- [工具治理](../../nexus/reference/tool-governance-plan.md) —— 原生/MCP 共存规则、`mcp:*` 工具类、来源限定身份标识、命名冲突诊断。
- [Agent runtime 成熟度](../../nexus/reference/agent-runtime-architecture-maturity-plan.md) —— MCP context primitives 缺口（resources/prompts/roots）与未来扩展治理。
- [Runtime tool-loop 治理](../../nexus/reference/runtime-tool-loop-governance-plan.md) —— MCP 写入工具排除在 `final_check` 范围之外。
- [层方向审计](../../nexus/reference/layer-direction-audit-enforcement-plan.md) —— `src/mcp/` 归类为叶子域，带方向感知的导入门禁。
- [模块耦合治理](../../nexus/reference/module-coupling-decoupling-and-re-aggregation-plan.md) —— `mcp/` 的耦合热力图（2 条出边：`tools/Tool.js`、`shared/version.js`）。
