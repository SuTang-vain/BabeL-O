# TODO Runtime / Nexus

## 目标

Nexus 是 BabeL-O 的执行核心。这里只保留仍未收口的 runtime / API / storage / security / context / compact / permissions 任务。已完成的大项见 [DONE.md](./DONE.md)。

## 当前状态

- `GET /v1/runtime/status`、`/v1/runtime/provider-smoke`、`/v1/runtime/provider-smoke/live`、`/v1/sessions/:sessionId/context`、`/v1/sessions/:sessionId/assets`、`/compact`、`/context`、Session Memory Lite 第一版、provider recovery、DeepSeek reasoning replay、hooks 最小内核都已落地。
- Context token estimator、blocking limit、auto/manual compact、retained segment、User Intake Guidance、final-response-only、provider protocol regression corpus 都已进入可验证状态。
- 当前 TODO 只保留后续阶段的架构收口、权限细化和执行入口升级。

## P1 Runtime Core

- [ ] 将 `LocalCodingRuntime` 改为可组合 runtime pipeline：prompt parser、provider call、tool loop、result aggregator。
- [ ] 为 runtime hook executor 增加用户配置层和更强的结果聚合口径，让 built-in hooks 之后可以安全接入可选自定义 hooks。
- [ ] 把 `contextAnalysis()`、`providerSmoke()`、`providerFallbackPlan()` 的结果进一步统一成可复用的诊断对象，供 CLI、API 和 benchmark 共享。

## P1 Context / Recovery Follow-ups

- [ ] Session Memory Lite 从 opt-in 第一版推进到自然停顿触发、后台轻量 agent、顺序队列和成本控制。
- [ ] 保留 segment / resume 验证继续增强：把 retained tail、boundary anchor、first/last event identity 和 hash 的异常恢复做成更明确的用户可见诊断。
- [ ] 重新评估 `thinking_delta` 策略：当前完全丢弃能防污染，但长任务里可能损失规划连续性。

## P1/P2 Provider Stability

- [ ] `Model Fallback` 执行入口：当 provider recovery 建议切换模型/provider/profile 时，只提供显式用户确认后的执行入口，保持 `allowSilentModelSwitch=false`。
- [ ] `DeepSeek` 后续仅保留真实兼容性回归；当前 reasoning replay 已稳定，后续只在模型协议变化时补样本。

## P2 Smart Permissions

- [ ] 将已落地的 CLI once/session/editable rule 升级为 runtime-owned permission scope backend。
  - 默认继续只开放 `once/session`。
  - `project/user` scope 必须明确配置开启，并写入可审计存储。
- [ ] 权限 request details 增加 runtime decision candidates。
  - 包含 classifier reason、suggested allow rule、risk explanation、tool schema summary。
  - CLI approval panel 只负责展示，不重新实现风险判断。
- [ ] 拒绝权限的用户反馈需要在 service/embedded 两条路径都作为可恢复 tool result 传给 provider。
  - 当前 TUI 已有 reject with instruction 交互，后续要确保 HTTP/WS/service mode 行为一致。
- [ ] PermissionRequest hook 接入后，自动审批必须记录 `hookName`、`ruleId`、`scope` 和 `reason` 到 permission audit。

## P2 Architecture Boundary

- [ ] 明确 embedded local 与 Nexus-only 两种运行模式的架构口径：若保留 embedded，文档中承认其为本地单进程路径；若推进 Nexus-only，则 CLI 必须经 HTTP/WS 调用 Nexus。
- [ ] 减少 CLI 对 `SqliteStorage` / `closeNexusSession` 的直接 import：优先复用 Nexus API 或嵌入式 `createNexusApp()`，避免 Storage 操作散落在 CLI 层。
- [ ] 将 permission pending state 从进程内单例逐步抽象为可插拔 backend，为多进程 service/CLI 场景预留 SQLite 或 Nexus-owned 状态同步。

## P2 Execution Environments

- [ ] 设计 remote runner protocol。

## 验证命令

- [x] `npm run typecheck`
- [x] `npm test`
- [x] `npm run cli -- run "hello"`
- [x] `npm run cli -- run --url http://127.0.0.1:3000 "bash pwd"`
- [x] `npm run cli -- --help`
- [x] `npm run benchmark`

## 参考文件

- `src/nexus/app.ts`
- `src/nexus/server.ts`
- `src/nexus/createRuntime.ts`
- `src/runtime/Runtime.ts`
- `src/runtime/LocalCodingRuntime.ts`
- `src/runtime/LLMCodingRuntime.ts`
- `src/storage/Storage.ts`
- `src/storage/MemoryStorage.ts`
- `src/storage/SqliteStorage.ts`
