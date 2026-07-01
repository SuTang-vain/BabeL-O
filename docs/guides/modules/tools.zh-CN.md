# Tools

> 模块参考 · 稳定公共契约 · 详见关联治理文档

[English](tools.md)

## 职责

Tools 模块拥有模型可见的工具表面：`ToolDefinition` 接口、内置工具实现、工具注册表、路径安全守卫、Bash 风险分类、工具输出截断及上下文检索纯函数。每个工具都是头等对象，具有静态风险等级、Zod 输入 schema、可选的模型侧 schema、可选的逐输入风险覆盖（`riskForInput`）及 `execute` 函数。注册表（`createDefaultToolRegistry`）组装 19 个内置工具，覆盖文件发现、源码理解、变更、执行、任务生命周期、网页搜索、上下文检索和技能生命周期。

## 公共契约

- **`ToolDefinition`**（`src/tools/Tool.ts`）— 每个工具实现的稳定接口。字段：`name`、`description`、`risk`（`'read' | 'write' | 'execute' | 'task'`）、`inputSchema`（Zod）、可选 `modelInputSchema`、可选 `riskForInput`（逐输入覆盖）、`execute(input, context)`。`ToolContext` 携带 `cwd`、`sessionId`、可选 `signal`、`maxOutputBytes`、`bashMaxBufferBytes`、`allowedPaths` 及可选 `storage` 引用。

- **`createDefaultToolRegistry`**（`src/tools/registry.ts`）— 规范注册表工厂。接入了 19 个内置工具（ListDir、Glob、Grep、Read、Write、Edit、Bash、TaskCreate、WebSearch、contextSearch、contextSummarize、contextRecent、contextSessions、SkillList、SkillShow、SkillValidate、SkillDraft、SkillSave）。支持传入 `storage: null` 哨兵值以从注册表中移除上下文工具。

- **Read**（`src/tools/builtin/read.ts`）— 源码理解工具。支持 `lineOffset`/`lineLimit`（源码行）、`byteOffset`/`byteLimit`（字节窗口）、`mode`（`'auto' | 'full' | 'preview'`）。维护会话级读取账本，检测大文件重复读取并给出指引。风险：`read`。

- **Write / Edit**（`src/tools/builtin/write.ts`、`src/tools/builtin/edit.ts`）— 变更工具。Write 创建或覆盖文件；Edit 应用行范围替换。风险：`write`。

- **Bash**（`src/tools/builtin/bash.ts`）— 命令执行工具。风险：`execute`（静态审计标识）。通过 `riskForInput` 使用 `classifyBashRisk`（`src/tools/builtin/bashClassifier.ts`）在命令为只读子命令（ls、cat、`git status` 等）且无危险模式（重定向、管道、链式操作、已知破坏性命令）时降级为 `'read'`。路径解析通过 `resolveInsideWorkspace`（`src/tools/builtin/pathSafety.ts`）执行，强制遵守 `NEXUS_ALLOWED_WORKSPACES` 白名单。

- **路径安全**（`src/tools/builtin/pathSafety.ts`）— 工作空间边界强制。`resolveInsideWorkspace` 将请求路径相对于 cwd 解析，通过 `realpathSync` 核验 `NEXUS_ALLOWED_WORKSPACES`，越界时抛出 `WorkspacePathError`。`buildPathDriftDiagnostic`（`src/tools/builtin/pathDrift.ts`）在文件不存在于请求路径时检测路径漂移模式（缺失工作空间父级段、同级根目录混淆）。

- **`classifyBashRisk`**（`src/tools/builtin/bashClassifier.ts`）— 纯函数 Bash 命令分类器。双层设计：（1）只读子命令白名单（ls、cat、git status 等）；（2）危险模式正则扫描（重定向、管道、链式操作符、已知破坏性命令）。引号感知掩码防止字符串字面量内的 shell 操作符产生误报。

- **工具输出截断**（`src/tools/output.ts`）— `truncateToolOutput` 按字节长度限制字符串和 JSON 输出，超出限制时返回带 `truncated` 和 `originalBytes` 字段的 `TruncatedOutput` 信封。

## 允许的依赖

Tools 模块可导入 `shared` 获取类型、错误处理、ID 和配置。允许从 `storage` 进行类型导入（`NexusStorage`）用于工具上下文和注册表。从 `runtime`（例如 `contextTools.ts` 中的 `behaviorTrace.ts`）和 `skills`（例如 `skillTool.ts` 中的 `registry.ts`）的导入仅限于特定内置工具，不应视为通用依赖许可。层方向审计（`deps:audit`）强制禁止任何工具文件导入 `nexus` 或 `cli`。

## 扩展点

- **新增内置工具** — 在 `src/tools/builtin/` 中创建导出 `ToolDefinition` 的文件，然后在 `src/tools/registry.ts` 的 `createDefaultToolRegistry` 中注册。遵循现有风险分类和证据语义模式。

- **添加 MCP 工具** — MCP 工具通过 MCP 桥注册，而非内置工具注册表。通过配置 MCP 服务器并经由 MCP 连接器导入工具定义来扩展工具表面。

- **自定义工具策略** — 三个 `ToolPolicy` 构造函数（`allowAllTools`、`denyByDefaultTools`、`allowlistedTools`）位于 `src/runtime/LocalCodingRuntime.ts`，由运行时管道（`createRuntime.ts`）组合使用。`denyByDefault` 策略仅自动允许 `read` 和 `task` 风险的工具；每次 `write` 或 `execute` 调用都需要权限决策。

- **覆盖逐输入风险** — 在 `ToolDefinition` 上实现 `riskForInput`。Bash 工具使用此模式将安全子命令的 `'execute'` 降级为 `'read'`，在跳过审批关卡的同时为审计清晰度保留静态风险 `'execute'`。

- **扩展路径安全检查** — `NEXUS_ALLOWED_WORKSPACES` 环境变量是管理员控制的工作空间边界。`resolveInsideWorkspace` 和 `buildPathDriftDiagnostic` 提供两个护栏（越界阻止和漂移检测）。任务范围外的证据检测由运行时的 `taskScope.ts` 处理，而非 tools 模块。

## 关联治理

- [工具治理](../../nexus/reference/tool-governance-plan.md) — 规范工具分类、证据语义、原生/MCP 共存、新工具准入关卡。
- [运行时工具循环治理](../../nexus/reference/runtime-tool-loop-governance-plan.md) — 可恢复工具错误、工具调用形状文本抑制、循环预算、有界最终检查。
- [证据治理索引](../../nexus/reference/evidence-governance-index.md) — 工具结果的五个证据维度（存在性、覆盖率、范围、时效性、回放有效性）。
- [任务范围与证据范围治理](../../nexus/reference/task-scope-and-evidence-scope-governance-plan.md) — 只读工具的范围边界分类，P0 防止越界证据的护栏。
- [运行时工具权限流程](../../nexus/reference/runtime-tool-permission-flow-reference.md) — 有效风险解析、策略检查、钩子、范围边界预检、待定注册表、审计事件。
