# Eval

> 模块参考 · 稳定公开契约 · 深度架构见链接的治理文档

[English](eval.md)

## 角色

Eval 是编码 Agent 行为的轨迹评估工具。它读取录制好的 agent 轨迹（通过
`projectAgentTrace` 从 Nexus 事件流投影），运行一组内置规约检查，并产生自验证
报告。它是离线和确定性的——无需 provider 密钥、无需工作区、无需网络——因此在
每台机器和 CI 上评估结果完全一致。

代码位于 `src/eval/` 下两个文件：

- **`trajectoryEval.ts`** —— 6 个内置规约检查（`tool_discipline`、
  `permission_discipline`、`scope_discipline`、`context_discipline`、
  `memory_discipline`，以及 v1 中返回 `skip` 的 `task_success`）、执行器
  （`runFixture` / `runAll`）和指标聚合（`computeMetrics`）。
- **`fixtureBuilder.ts`** —— `defineFixture` 辅助函数和 `ev` 紧凑事件构建器，
  用于编写测试轨迹。

Fixture 存放于 `evals/coding/*.ts`（v1 共 12 个），通过 `npm run eval:agent`
运行。当 fixture 的自验证出现不匹配时（即检查套件错误分类了已知好或坏的轨迹），
harness 以非零退出码退出。

## 公开契约

- **`runAll(fixtures: Fixture[])` → `EvalReport`** —— 顶层入口。对所有
  fixture 运行全部检查，收集 `FixtureResult` 对象（判定、是否通过、检查详情、
  指标、不匹配项），返回包含 `total` / `passed` / `failed` 的汇总报告。
- **`runFixture(fixture: Fixture)` → `FixtureResult`** —— 单 fixture 执行器，
  被 `runAll` 调用。将事件流投影为 `AgentTrace`，运行全部 6 个检查，将实际
  严重度与 fixture 的 `expectChecks` 比对，返回判定结果。
- **`CHECKS: Record<CheckKey, TrajectoryCheck>`** —— 规约检查注册表。每个检查
  是一个纯函数 `(AgentTrace, Fixture) → CheckResult`，严重度为
  `pass` | `warn` | `fail` | `skip`。
- **`defineFixture(def)` → `Fixture`** —— fixture 编写 API。接收 id、描述、
  提示词、可选 `expectChecks` 和事件数组。`ev` 构建器自动填充
  `schemaVersion`、`sessionId` 和确定性的单调递增时间戳。
- **`npm run eval:agent`** —— CLI 入口。从 `evals/coding/*.ts` 加载所有
  fixture，运行 `runAll`，输出每个 fixture 的报告和汇总。传入 `--json` 可
 获得机器可读的 JSON 输出。

## 允许的依赖

Eval 是一个离线分析工具，位于主执行层方向链之外。它可以依赖 `runtime`（用于
轨迹投影类型和 `projectAgentTrace` 投影器）和 `shared`（用于 `NexusEvent`
模式）。没有其他模块导入 `src/eval/`——它只消费轨迹，从不产生轨迹。

层方向门禁不直接适用于 eval，因为它不属于 `cli` / `nexus` / `runtime`
热路径，但其依赖范围必须保持精简：

- `eval` → `runtime` —— **允许**（用于 `agentTrace` 类型和投影器）。
- `eval` → `shared` —— **允许**（用于事件模式）。
- `eval` → `nexus` / `cli` / `providers` / `tools` / `storage` —— **禁止**。

## 扩展点

- **新增规约检查** —— 在 `trajectoryEval.ts` 中定义 `TrajectoryCheck` 函数
  并加入 `CHECKS` 注册表。检查必须是 `AgentTrace` + `Fixture` 上的纯函数。
  新增检查会自动对所有 fixture 执行。
- **新增 fixture** —— 创建 `evals/coding/<id>.ts` 并导出
  `defineFixture({...})`。使用 `ev` 构建器实现紧凑的事件构造。设置
  `expectChecks` 断言检查套件应该给出的严重度；harness 会自动验证。
- **将真实 session 回归转化为 fixture** —— 导出 session 的事件（例如通过
  `bbl inspect-session <id>` 读取 SQLite events 表），裁剪到能复现规约违反
  的最小事件序列，提交为 fixture。它将成为永久的回归屏障。
- **新增事件类型** —— 在 `src/shared/events.ts` 中添加事件，在
  `fixtureBuilder.ts` 中添加对应的 `ev.*` 构建器，然后创建或更新相关的检查。
  `projectAgentTrace` 投影器也可能需要扩展以暴露新的事件跨度类型。

## 相关治理

- [Agent runtime 成熟度](../../nexus/reference/agent-runtime-architecture-maturity-plan.md) —— §3.2 轨迹评估 harness 设计、§3.5 内存质量自动判定及
  v1.1 实时工作区路线图。
- [证据治理索引](../../nexus/reference/evidence-governance-index.md) —— 规约检查
  执行的"工具证据优先于记忆叙述"原则。
- [行为监控](../../nexus/reference/behavior-monitor.md) —— 跨 session 行为轨迹，
  以实时提示投影补充离线评估。
- [模块耦合治理](../../nexus/reference/module-coupling-decoupling-and-re-aggregation-plan.md) —— eval 模块依赖范围的耦合热力图。
- [层方向审计](../../nexus/reference/layer-direction-audit-enforcement-plan.md) ——
  方向感知依赖门禁（eval 在主链之外，但不得泄漏到 `nexus` / `cli`）。
