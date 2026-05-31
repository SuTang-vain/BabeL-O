# TODO Performance Hardening

## 目标

BabeL-O 从第一天就建立性能边界，避免重写后再次变成启动慢、交互重、状态难测的大型 CLI。本文只保留 benchmark、metrics、storage/API 性能、故障注入与并发治理未收口项。

## 当前状态

- `npm run benchmark`、startup trace、context-aware benchmark、runtime metrics、provider/tool duration、storageBridge WAL replay、sessions/events 分页、execution timeout 和并发闸门已落地。
- `/v1/sessions`、`/v1/sessions/:id/events`、tool trace、session detail 默认都已避免无脑全量 hydrate。
- 当前缺口集中在规模压测、故障注入、AgentLoop 成本数据和并发测试治理。

## P1 Scale Benchmark

- [ ] 压力测试覆盖 1000+ sessions/events API 响应。
  - 覆盖 `/v1/sessions`、`/v1/sessions/:id`、`/v1/sessions/:id/events`、`/v1/sessions/:id/assets`。
  - MemoryStorage 与 SqliteStorage 都要跑。
  - 输出 p50/p95、payload size、event count、query count 或近似诊断。
- [ ] benchmark `chat` 首次响应时间。
  - 区分 cold start、warm start、embedded mode、service mode。
  - 记录是否加载 provider SDK、是否打开 SQLite、是否触发 context assembly。

## P1 Storage Fault Injection

- [ ] storageBridge 故障注入压测。
  - 模拟 WAL 损坏、SQLite 写失败、进程崩溃中断、compact 失败。
  - 验证 session/task/event/tool trace 不发生不可诊断分叉。
  - 失败时需要明确 replay/repair/skip 策略与用户可见诊断。
- [ ] 重新评估 storageBridge 复杂度。
  - 如果故障注入收益不足，设计降级为更简单的 await 持久化或单层 async retry。
  - 决策必须基于故障注入结果，而不是文档偏好。

## P2 Provider / AgentLoop Cost

- [ ] retry policy benchmark。
  - 记录重试次数、失败类型、额外 token/耗时、最终成功率。
  - 对 provider empty response、rate limit、schema mismatch、tool protocol error 分别统计。
- [ ] AgentLoop 成本 benchmark。
  - 记录 Planner/Executor/Critic/SubAgent 各 role 的调用次数、token、耗时和失败率。
  - 用数据支撑 Critic/sub-agent 是否默认启用，以及 `--no-critic`、`--subagent-model` 等配置默认值。

## P2 Concurrency Governance

- [ ] 测试并发化治理。
  - 梳理 `PendingPermissionRegistry`、TaskQueue、TaskSession、Bash CWD、storageBridge、session lifecycle 等全局状态 reset。
  - 逐步移除 `--test-concurrency=1`。
  - 并发失败时优先修隔离和生命周期，不用扩大串行范围掩盖问题。

## P2 Observability

- [ ] 将 benchmark 结果纳入机器可读历史。
  - 至少保留最近一次 JSON 输出与关键指标说明。
  - 不引入远程 telemetry；只保留本地 metrics。
- [ ] `/v1/runtime/metrics` 继续补齐 context/compact/provider/agent loop 指标。
  - 关注可调试性，不追求云端分析平台。

## 验证命令

- [x] `npm run benchmark`
- [x] `BABEL_O_STARTUP_TRACE=1 npm run cli -- --help`
- [ ] `npm run test:performance`
- [ ] 1000+ sessions/events benchmark
- [ ] storageBridge fault-injection benchmark
- [ ] AgentLoop cost benchmark

## 参考文件

- `src/nexus/app.ts`
- `src/runtime/LocalCodingRuntime.ts`
- `src/runtime/LLMCodingRuntime.ts`
- `src/nexus/storageBridge.ts`
- `src/storage/SqliteStorage.ts`
- `scripts`
