# Nexus

> 模块参考 · 稳定公开契约 · 深度架构见链接的治理文档

[English](nexus.md)

## 角色

Nexus 是执行核心。它拥有 Fastify REST + WebSocket API、session/event/task/audit
存储编排、runtime harness 组装、agent 调度,以及工具权限与 task-scope 门禁。客户端
(`bbl go`、`bbl run` 或任意 API 消费方)连接到 Nexus;Nexus 拥有执行真相,客户端
只负责交互渲染。

## 公开契约

- **`NexusRuntime.executeStream(...)` → `AsyncIterable<NexusEvent>`** —— 核心执行
  契约。所有客户端(`bbl run`、`bbl go`、API 消费方)共用同一事件协议,与选用的
  runtime 实现无关。harness 在 `createRuntime.ts` 组装;流式实现位于
  `src/runtime`(`LLMCodingRuntime` 用于真实 LLM,`LocalCodingRuntime` 用于确定性
  /测试路径)。
- **HTTP + WebSocket API(`/v1/...`)** —— 路由以小模块形式放在
  `src/nexus/routers/`,由 `routerRegistrar.ts` 注册。服务入口 `server.ts` 在
  `app.ts` 组装前先跑安全校验(`validateSecurityConfig`)与环境解析。
- **`createDefaultNexusRuntime`** —— harness 工厂,把内置工具、MCP 工具、agent
  工具、storage、MemoryOS / EverCore、policy 和 runtime 选型组装为一个
  `NexusRuntime`。

## 允许的依赖

Nexus 处于执行层顶端,可依赖 `runtime`、`tools`、`mcp`、`storage`、`providers`、
`shared` 及自身 `agents/` 子树。层方向门禁(`deps:audit`,CI 强制)禁止反向:

- `runtime` → `nexus` **禁止**(runtime 引擎不得依赖宿主)。
- `nexus` → `cli` / `clients` **禁止**(Nexus 不得依赖任何交互层)。

完整热力图与反向导入白名单见
[层方向审计](../../nexus/reference/layer-direction-audit-enforcement-plan.md)
与
[模块耦合治理](../../nexus/reference/module-coupling-decoupling-and-re-aggregation-plan.md)。

## 扩展点

- **新增 HTTP / WebSocket 路由** —— 在 `src/nexus/routers/` 建路由模块,并在
  `routerRegistrar.ts` 注册。保持 `app.ts` 精简;北极星是路由切片小且可独立测试。
- **新增或调整 agent 行为** —— 扩展 `src/nexus/agents/` 与 `agentLoop*.ts` 族。
  当前四个角色:planner、executor、critic、optimizer。子 agent 通过
  `runAgentLoop` 递归,带 forked context 与受限工具集。
- **挂接执行** —— 中间件式 runtime hooks(`src/runtime/hooks.ts`)由 harness
  接线,可拒绝工具、改写工具输入、给出权限决策或追加重试提示。
- **持久化状态** —— 新的持久化状态走 `src/storage` 的 repository 模式与异步
  `storageBridge` WAL 路径;Nexus 负责编排,不直接写 storage 格式。

## 相关治理

- [模块耦合治理](../../nexus/reference/module-coupling-decoupling-and-re-aggregation-plan.md) —— 耦合热力图、`app.ts` 路由拆分、单例改注入。
- [层方向审计](../../nexus/reference/layer-direction-audit-enforcement-plan.md) —— 方向感知依赖门禁。
- [Agent runtime 成熟度](../../nexus/reference/agent-runtime-architecture-maturity-plan.md) —— trace、eval、durable resume 缺口。
- [Runtime tool-loop 治理](../../nexus/reference/runtime-tool-loop-governance-plan.md) —— 工具循环连续性与有界最终检查。
- [开发过程稳定性](../../nexus/reference/development-process-stability-governance-plan.md) —— 高风险 nexus 变更的 PR review 级别。
