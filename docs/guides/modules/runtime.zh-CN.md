# Runtime

> 模块参考 · 稳定的公开契约 · 深层架构请参阅关联治理文档

[English](runtime.md)

## 定位

Runtime 是执行引擎。它拥有流式执行循环（`executeStream`）、上下文组装与压缩、工具分发与权限控制、提供商交互、任务范围推导、意图识别、会话连续性以及中间件钩子系统。Runtime 实现了 Nexus 构造、客户端消费的 `NexusRuntime` 契约；它是执行真相的唯一来源，且严格禁止导入任何 Nexus 宿主代码。

## 公开契约

- **`NexusRuntime.executeStream(options)` → `AsyncIterable<NexusEvent>`** — 规范的流式执行契约。定义于 `Runtime.ts`；由 `LLMCodingRuntime`（真实 LLM，生产路径）和 `LocalCodingRuntime`（确定性、本地意图及测试路径）实现。两种实现产出形状一致的事件流。
- **`RuntimeExecuteOptions`** — 全面的按请求参数面：提供商选择、信号/中止、工具策略（`allowedTools`、`policyMode`）、钩子配置、cwd 连续性字段、执行环境、预算以及远程运行器连接。
- **`RuntimeToolAuditEntry`** — `listTools()` 返回的工具审计结构：名称、描述、风险、允许状态、输入模式、来源（builtin 或 MCP）以及审批元数据。
- **`ToolPolicy`** — 导出自 `LocalCodingRuntime.ts` 的按输入策略门，支持三种模式（`allow_all`、`allowlist`、`session_rules`）。通过 `buildPerRequestAllowedToolsPolicy` 作用于每个回合，并可通过 `RuntimeExecuteOptions.allowedTools` 覆盖。
- **`RuntimeHook`** — 中间件风格的钩子契约（`hooks.ts`）。钩子订阅命名的生命周期事件（`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PermissionRequest`、`PreInvocation`、`PostInvocation`、`SessionEnd`），可以拒绝、改写、增强或提供重试提示。运行时内置了七个钩子；调用方可通过 `HooksConfig` 提供额外钩子或配置内置覆盖。

## 允许的依赖

Runtime 可以导入 `shared/`、`tools/`、`providers/`、`storage/` 和 `skills/`。层方向门（`deps:audit`，在 CI 中强制执行）严格禁止：

- `runtime` → `nexus` — **禁止**（运行时不得依赖宿主层——不得导入 `../nexus/`）。
- `runtime` → `cli` / `clients` — **禁止**（运行时不得依赖任何交互层）。

完整的热力图和允许列表规则参见[层方向审计](../../nexus/reference/layer-direction-audit-enforcement-plan.md)。

## 扩展点

- **添加运行时钩子** — 实现 `RuntimeHook` 接口（`hooks.ts`），订阅一个或多个 `HookEventName` 生命周期点，并通过 `RuntimeExecuteOptions.runtimeHooks` 传入钩子。钩子可以拒绝某个工具（附原因）、改写工具输入、提供权限决策、添加重试提示或输出摘要诊断。
- **添加新的运行时实现** — 实现 `NexusRuntime.executeStream()`。契约是一个异步可迭代方法加上可选的 `listTools()` 辅助函数。然后运行时在工厂函数（Nexus 中的 `createRuntime.ts`）中接入生产使用。
- **扩展工具循环** — 工具分发管道（`runtimeToolLoop.ts`、`toolExecutor.ts`）由独立阶段组成（有效风险裁决、策略检查、钩子、范围边界预检、带超时/远程运行器的工具执行、结果预算执行）。各个阶段可以被替换或扩展，而无需触及主 LLM 提供商循环。
- **扩展上下文压缩** — 压缩链（`compact.ts`、`compactPostRestore.ts`、`cacheAwareCompactPolicy.ts`）和上下文组装（`contextAssembler.ts`）是模块化的。新的压缩器放在 `src/runtime/compactors/` 中，并接入组装管道。

## 相关治理

- [运行时工具循环治理](../../nexus/reference/runtime-tool-loop-governance-plan.md) — 可恢复的工具错误、有界循环终结、工具调用文本抑制以及工具失败后的最终答案保证。
- [运行时工具权限流程参考](../../nexus/reference/runtime-tool-permission-flow-reference.md) — 从两个运行时提取的规范化共享权限流程（风险裁决、策略、钩子、范围边界、待定注册表、审计、事件）。
- [上下文治理索引](../../nexus/reference/context-governance-index.md) — 上下文组装、工作集、行为追踪、记忆、缓存可观测性和工具循环恢复的读者入口点。
- [意图引导与提示词治理优化计划](../../nexus/reference/intent-guidance-and-prompt-governance-optimization-plan.md) — 运行时拥有的意图分类、确定性回合策略归一化以及能力/验证分离。
- [任务范围与证据范围治理计划](../../nexus/reference/task-scope-and-evidence-scope-governance-plan.md) — 运行时拥有的任务范围推导、范围边界分类以及范围外证据诊断。
