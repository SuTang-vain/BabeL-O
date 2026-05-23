# TODO Performance Hardening

## 目标

BabeL-O 从第一天就建立性能边界，避免重写后再次变成启动慢、交互重、状态难测的大型 CLI。

## 当前状态

- [x] 项目体量很小。
- [x] `npm run typecheck` 可快速完成。
- [x] `npm test` 可快速完成。
- [x] embedded `run` 可用。
- [x] service mode `run --url` 可用。
- [x] 已建立正式 benchmark。
- [x] 已建立 `npm run benchmark`。
- [x] 已记录 startup trace。
- [x] 已建立 Context-Aware 长会话压缩 benchmark。
- [x] `/v1/sessions` 采用轻量摘要，避免默认携带全量 events。
- [x] `/v1/execute` 支持 timeout。
- [x] `/v1/runtime/metrics` 提供机器可读 metrics。
- [x] 已补长运行工具超时测试。
- [x] 已补并发闸门测试。
- [x] session detail 默认 recent events，避免长会话全量 hydrate。
- [x] `GET /v1/sessions/:id/events` 支持分页。
- [ ] 尚未测试大量 session/event 下的 API 响应。

## P1 Baseline

- [x] 增加 `npm run benchmark`。
- [x] benchmark embedded `run "hello"`。
- [x] benchmark service `/v1/execute`。
- [x] benchmark `/v1/runtime/status`。
- [ ] benchmark `chat` 首次响应时间。
- [x] benchmark Read/Grep/Bash 工具。
- [x] benchmark 长会话 context assembly 压缩率和最近轮次保留。
- [x] 输出机器可读 JSON。

## P1 Runtime Performance

- [x] `/v1/stream` 支持 backpressure 观察。
- [x] tool output truncation。
- [x] Bash maxBuffer 配置化。
- [x] Grep/Glob result limit。
- [x] session events 限制 recent 默认值。
- [x] route handlers 不做 O(n) 全量扫描。
- [x] 执行并发闸门。

## P1 Storage Performance

- [x] SQLite schema 加索引。
- [x] sessions list 默认 limit。
- [x] events list 分页。
- [x] tool trace 分页。
- [x] 大 session hydrate 策略。
- [x] storage restart benchmark。

## P1 CLI Performance

- [x] `bbl --help` 启动耗时基线。
- [x] `bbl run "hello"` embedded 耗时基线。
- [x] `bbl chat` 首屏耗时基线。
- [x] CLI 不在启动时加载 provider SDK。
- [x] CLI 不在启动时加载 TUI optional deps。

## P2 Provider Performance

- [x] provider request duration 记录。
- [x] time to first token 记录。
- [x] stream delta count 记录。
- [x] tool call roundtrip duration 记录。
- [ ] retry policy benchmark。
- [x] provider timeout policy。

## P2 Observability / Metrics

来自 `docs/RECOMMENDATIONS.md` 的 Milestone 5。目标是本地可观测，不迁移 BabeL-X 的 telemetry / analytics / GrowthBook。

- [ ] 新增最小结构化 logger，支持 `NEXUS_LOG_LEVEL=silent`。
- [x] SQLite metrics 表记录执行指标。
- [x] 记录 `execute_duration_ms`。
- [x] 记录 `provider_first_token_ms`。
- [x] benchmark 记录 context 字符级近似输入规模、压缩后规模和压缩率。
- [x] runtime metrics 记录 `context_tokens_in` / `context_tokens_out` 或字符级近似值。
- [x] 记录 `tool_call_count`。
- [x] 记录 `tool_roundtrip_duration_ms`。
- [x] `/v1/runtime/metrics` 返回新增指标。
- [ ] 压力测试覆盖 1000+ sessions。

## 验证命令

- [x] `npm run benchmark`
- [ ] `npm run test:performance`
- [x] `BABEL_O_STARTUP_TRACE=1 npm run cli -- --help`

## 参考文件

- `src/nexus/app.ts`
- `src/cli/program.ts`
- `src/runtime/LocalCodingRuntime.ts`
