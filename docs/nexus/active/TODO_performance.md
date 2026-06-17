# TODO Performance Hardening

## 目标

BabeL-O 从第一天就建立性能边界，避免项目演进中再次变成启动慢、交互重、状态难测的大型 CLI。本文只保留 benchmark、metrics、storage/API 性能、故障注入与并发治理未收口项。

## 当前状态

- `npm run benchmark`、startup trace、context-aware benchmark、runtime metrics、provider/tool duration、storageBridge WAL replay、sessions/events 分页、execution timeout 和并发闸门已落地。
- `/v1/sessions`、`/v1/sessions/:id/events`、tool trace、session detail 默认都已避免无脑全量 hydrate。
- `npm run benchmark` 已接入 1000+ sessions/events API scale section，覆盖 MemoryStorage 与 SqliteStorage 的 `/v1/sessions`、session detail、events page 和 assets 查询，并输出 p50/p95、payload size、item/event count 与 query count 近似诊断。
- `npm run benchmark` / `npm run test:performance` 已接入 `chatFirstResponse` 与 `storageBridgeFaultInjection` section：覆盖 chat cold CLI、warm embedded、service HTTP 首次响应，以及 corrupt WAL skip、SQLite write retry、crash interrupted replay、compact failure diagnostic。
- Provider / AgentLoop runtime metrics 可观测性已补齐；context/compact ceiling diagnostics 已贯通 registry 模型窗口、cache-aware policy、execution_metrics side table 与 `/v1/runtime/metrics`。mocked AgentLoop 成本/失败率 benchmark、mocked retry policy benchmark、AgentLoop-inclusive 并发 smoke、本地 benchmark history 与 TS/Go runner 对比 benchmark 已接入，输出 token、role duration、retry overhead、failure type、success rate、sub-agent cost、测试并发稳定性诊断、本地历史 delta 与 runner duration/output/cancel/timeout/workspace boundary 诊断。embedded/local CLI metrics 持久化一致性已通过 storage-level `execution_metrics` event side-table 同步收口。

## 已收口 Embedded Metrics Persistence

样本 `session_1e2299be-b988-49ea-8819-587de8258172` 暴露的 metrics event / side table 分叉已收口：`SqliteStorage.appendEvent()` 与 `MemoryStorage.appendEvent()` 会在写入 `execution_metrics` event 时同步 side table，HTTP `/v1/execute`、WebSocket `/v1/stream` 与 embedded/local append-event path 共用同一 storage-level side effect。

历史 session 不自动迁移；如需展示旧库中“有 metrics event、无 side table row”的记录，后续只做只读诊断或 event fallback 展示，避免无意改写用户本地历史库。

## 已收口 Scale Benchmark

1000+ sessions/events API scale benchmark、chat 首次响应 benchmark 已接入 `npm run benchmark` / `npm run test:performance`，详见 [DONE.md](../DONE.md) 与 [WORK_LOG.md](../WORK_LOG.md)。

## 已收口 Storage Fault Injection

storageBridge fault-injection benchmark 已接入 `npm run benchmark` / `npm run test:performance`，覆盖 WAL 损坏、SQLite 写失败、进程崩溃中断和 compact 失败诊断；基于结果暂保留 storageBridge 结构，详见 [DONE.md](../DONE.md) 与 [WORK_LOG.md](../WORK_LOG.md)。

## 已收口 Provider / AgentLoop Cost

mocked retry policy benchmark 已接入 `npm run benchmark` / `npm run test:performance`，覆盖 rate limit、provider unavailable、empty response、schema mismatch repair、tool protocol error no-auto-retry，并汇总 retry count、failure type、额外 token/耗时、最终成功率与 mocked AgentLoop retry overhead；详见 [DONE.md](../DONE.md) 与 [WORK_LOG.md](../WORK_LOG.md)。

## 已收口 Remote Runner / Go Runner Benchmarks

本地 TS runner 与可选 Go Runner 对比 benchmark 已接入 `npm run benchmark` / `npm run test:performance`：默认执行 TS local runner 场景并输出 Go skipped reason，只有 `BABEL_O_RUN_GO_RUNNER_SMOKE=1` 时才启动 Go RemoteToolRunner。覆盖 `Read`、大目录 `Grep`、大目录 `Glob`、Bash stdout、大输出截断、workspace escape、cancel latency 与 timeout correctness，并输出 duration p50/p95、stdout/stderr bytes、originalBytes、truncated、cancel/timeout/workspace boundary 计数、heap/RSS 近似诊断和 error code 分布；详见 [DONE.md](../DONE.md) 与 [WORK_LOG.md](../WORK_LOG.md)。

## 已收口 Concurrency Governance Phase 1-4

`npm run test:concurrency` 已作为并发 smoke 接入并完成 AgentLoop-inclusive 扩容：脚本按测试文件启动独立进程，为每个文件创建独立临时 `BABEL_O_CONFIG_FILE` / `BABEL_O_CONFIG_DIR`，并以 bounded concurrency 运行 50 个已审计测试文件。Phase 4 修正并发 runner 不再用 `BABEL_O_MODEL` / `BABEL_O_PROVIDER` 覆盖测试内显式 config，并改用 `node --import tsx --test` 启动子测试进程以稳定 `.js` import 到 `.ts` 源文件的解析；`test/agent-loop.test.ts` 与 `test/runner-comparison-benchmark.test.ts` 已进入稳定集合。默认 `npm test --test-concurrency=1` 暂保留，后续是否放开默认全套件并发需另做完整风险评估。

## 已收口 Benchmark History

`npm run benchmark` / `npm run test:performance` 已写入本地 `.babel-o/benchmarks/latest.json`、`history.json` 与 `summary.json`，默认保留最近 20 次机器可读摘要；summary 提取核心 latency、context/compact、API scale、chat first-response、storage fault-injection、token estimator、AgentLoop、retryPolicy 与 runtime metrics 指标，并记录 previous/delta/deltaPct。不引入远程 telemetry；可用 `BABEL_O_BENCHMARK_HISTORY_DIR` 指向临时目录，或 `BABEL_O_BENCHMARK_HISTORY_DISABLED=1` 禁用本地写入。

## 已收口 Context Ceiling / Runtime Metrics Diagnostics

context/compact ceiling 诊断已对齐 registry `model.contextWindow` 与 cache-aware policy：`/context`、context warning/blocking events、blocking error details、`execution_metrics` event/side table 与 `/v1/runtime/metrics` 会输出 model context window、reserved output、provider safety buffer、legacy/effective ceiling、env hard cap、policy source、warning/compact/blocking thresholds、cache preservation 与 long-context 模式。

## 已收口 Provider / AgentLoop Runtime Metrics Observability

`/v1/runtime/metrics` 与 `/v1/runtime/status` 已基于本地 persisted events 聚合 provider invocation、AgentLoop role step/task failure/retry/sub-agent 与 AgentJob lifecycle 指标；仅用于本地诊断，不引入云端分析平台。

## P1 Agent Trace Schema / Trajectory Eval Harness

> 主规划见 [agent-runtime-architecture-maturity-plan.md](../reference/agent-runtime-architecture-maturity-plan.md)。本节承接 observability / eval / benchmark 打开项。

### Agent Trace Schema — Open

当前 runtime metrics、tool trace、permission audit、behavior trace 已存在，但还不是统一 trajectory trace。

- [ ] 定义 `AgentTrace` / `AgentSpan` 投影 schema，从现有 `NexusEvent`、`execution_metrics`、`toolTrace`、`permission_audit` 派生，不新增第二事实源。
- [ ] span 覆盖 provider invocation、tool call、permission decision、scope boundary、memory retrieval、compact/recovery、sub-agent handoff、final result。
- [ ] trace 可 JSONL 导出，并可从 session replay 重建。
- [ ] `bbl inspect-session` 或独立 debug command 可输出 machine-readable trace。
- [ ] 回归覆盖 event ordering、parent-child span、缺失事件降级、permission denied path。

### Trajectory Eval Harness — Open

现有测试/benchmark 能覆盖函数、API、成本和性能；下一步需要面向 agent trajectory 的 eval。

- [ ] 定义最小 eval fixture 格式：prompt、workspace、expected checks、trace assertions。
- [ ] 新增 `npm run eval:agent` 或等价脚本，默认跑小型 offline fixture，不依赖真实 provider key。
- [ ] 首批至少 10 个 coding trajectory fixture，覆盖 read-before-edit、permission、scope、context budget、recoverable tool error、memory hint caution。
- [ ] eval 输出 success、cost、tool count、permission count、scope warnings、trace path。
- [ ] 后续真实 session regression 可转成 eval fixture，作为 architecture maturity 守门。

## 验证命令

历史验证覆盖：`npm run benchmark`、`BABEL_O_STARTUP_TRACE=1 npm run cli -- --help`、`npm run test:performance`、`npm run test:concurrency`、1000+ sessions/events `apiScale`、storageBridge fault-injection、mocked AgentLoop cost benchmark、mocked retry policy benchmark、本地 benchmark history 与 TS/Go runner 对比 benchmark。后续新增 metrics history 时，应继续接入 `npm run benchmark` / `npm run test:performance`，并输出机器可读诊断。

## 参考文件

- `src/nexus/app.ts`
- `src/runtime/LocalCodingRuntime.ts`
- `src/runtime/LLMCodingRuntime.ts`
- `src/nexus/storageBridge.ts`
- `src/storage/SqliteStorage.ts`
- `scripts`
