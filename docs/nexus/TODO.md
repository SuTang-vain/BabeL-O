# BabeL-O / Nexus 总控规划

## 口径

BabeL-O 是以 Nexus 服务端为核心（Nexus-first）的通用泛化 AI 智能体。总控 TODO 只保留当前仍会影响开发排序的打开项；已完成能力索引移入 [DONE.md](./DONE.md)，事实流水与验证命令写入 [WORK_LOG.md](./WORK_LOG.md)。

```text
Nexus owns execution.
CLI owns interaction.
Tools and coding workflows stay first-class.
Legacy complexity is not imported by default.
```

维护原则：

- 本文件回答“当前最应该做什么”，不承载历史长账。
- 具体任务写入对应 [active/](./active/) 专项 TODO。
- 长期设计、边界和非目标写入 [reference/](./reference/)；草案和半落地计划写入 [proposals/](./proposals/)；已收口历史写入 [history/](./history/)；关键治理决策写入 [decisions/](./decisions/)。
- Watch / Closed 项只在下表保留短索引；完整完成事实见 [DONE.md](./DONE.md)。

## 当前打开优先级

| 优先级 | 任务 | 主文档 | 当前判断 / 收口标准 |
| --- | --- | --- | --- |
| **P0** | **产品 / UX 30 天改造** | [active/TODO_product_30day.md](./active/TODO_product_30day.md) | 当前最清晰的用户面改造主线。只动 README/docs/安装链路/错误文案/凭证管理/examples/社区入口，不动 Nexus runtime / provider / agent loop。收口标准是每周都有可验收产物，而不是继续扩大工程内核范围。 |
| **P0 Watch** | **Go TUI Session 可观测性 / Embedded Nexus 持久化** | [active/TODO_runtime.md](./active/TODO_runtime.md), [go-tui-session-observability-governance-plan.md](./proposals/go-tui-session-observability-governance-plan.md) | Phase 0 `bbl inspect-session` 已收口；Phase 1/2/3 仍是“部分落地”。优先补 `bbl go --check` storage 诊断、clientSessionId server metadata、embedded restart inspect e2e、startup log / transcript persistence hint。 |
| **P1** | **`bbl loop` 多 session pane TUI** | [go-tui-history.md](./history/go-tui-history.md), [active/TODO_tui.md](./active/TODO_tui.md) | 本地已有 26 个 develop 提交支撑 Phase 0-5c'，属于真实推进主线。下一步应集中在 chrome/status/sidebar、真实 Nexus streaming、PTY smoke 与文档状态同步；不得让 `bbl loop` 拥有 runtime truth。 |
| **P1** | **Agent Runtime 成熟度补齐：trace / eval / durable resume** | [reference/agent-runtime-architecture-maturity-plan.md](./reference/agent-runtime-architecture-maturity-plan.md), [active/TODO_runtime.md](./active/TODO_runtime.md), [active/TODO_performance.md](./active/TODO_performance.md) | 架构方向已对齐现代 agent runtime。**Agent Trace Schema v1 已收口（2026-06-17）**：`src/runtime/agentTrace.ts` 纯投影 `projectAgentTrace(events)`（9 span kind / parent-child via toolUseId / 确定性 spanId / 降级 warning）+ `bbl inspect-session <id> --trace` JSONL 导出 + 22 测试。**Trajectory Eval Harness v1 已收口（2026-06-17）**：`src/eval/trajectoryEval.ts` 6 个 builtin check（tool/permission/scope/context/memory discipline + task_success skip）+ 10 个 `evals/coding/` 自验证 fixture + `npm run eval:agent` + 19 测试；离线 / 不依赖 provider key。**Durable Run Checkpoint / Resume v1 已收口（2026-06-18）**：`src/runtime/runCheckpoint.ts` 6 boundary / 5 state 纯投影 `deriveResumableState` + `bbl inspect-session <id> --resume` CLI（默认 `hasContinuationSnapshot: false` 保持诚实）+ 18 unit + 7 integration 测试；v1 显式不持久化 in-process continuation snapshot。下一步补 §3.5 Memory Quality Metrics（需真实 regression 触发再推进）。收口标准是从真实 session 重建 trajectory、跑最小 coding eval、并准确表达中断后是否可恢复。 |
| **P1** | **EverCore managed sidecar 启动 cascade + 配置误报** | [proposals/evercore-managed-sidecar-live-validation-and-config-passthrough-plan.md](./proposals/evercore-managed-sidecar-live-validation-and-config-passthrough-plan.md), [reference/memory-governance-plan.md](./reference/memory-governance-plan.md) | 2026-06-30 source 核对：managed sidecar 在 `bbl memory setup` + `bbl nexus start` 后立即死（`EVERCORE_MANAGED_HEALTH_CHECK_FAILED`），`POST /v1/runtime/memory/search` 返回 `EVERCORE_MEMORY_UNAVAILABLE`，`capability.longTermMemory: false`。三个 cascade 失败（缺 LLM env / 缺 embedding model / 缺 `everos init`）只有最后一层被公开。`bbl memory status` / `bbl doctor` 报 "ready" 但 sidecar 实际未存活 —— 误报不是文档漂移。`memory-governance-plan.md` Phase E "live validation 已完成" 不可复现。修法：(1) 实测复现 + 加 `test/evercore-sidecar-live.test.ts` 回归；(2) 修 LLM passthrough 断点（`providerSettings` 没传到 `options.llm`）+ `test/evercore-config-passthrough.test.ts` 单元测；(3) 自动 `everos init` + 暴露 `lastStartupError` typed errorCode，让 CLI 表面反映 sidecar 真实健康；(4) 把 Phase E claim 改成可重放 `test:memory-live` smoke tier。修完所有 Phase 后本 plan 毕业到 `reference/`，live-validation 归属让给 `memory-governance-plan.md`。 |
| **P1 Watch** | **文档生命周期治理** | [reference/README.md](./reference/README.md), [proposals/README.md](./proposals/README.md), [history/README.md](./history/README.md), [decisions/README.md](./decisions/README.md) | v2 分层已建立：`reference/` 只保留 Active Plan / Index / Guide；Draft / Partially Landed 进入 `proposals/`；Closed Reference 合并进 `history/`；关键规则写入 ADR。后续重点不是机械翻译，而是防止新文档绕过生命周期。 |
| **P1** | **开发过程稳定性治理：PR review / 粒度 / flaky 隔离** | [development-process-stability-governance-plan.md](./reference/development-process-stability-governance-plan.md), [active/TODO_cleanup.md](./active/TODO_cleanup.md) | 2026-06-18 新增 Active Plan，Phase 1/2/3 已收口：`CONTRIBUTING.md` / `GOVERNANCE.md` / PR template / issue templates / semantic PR scope guidance / `test/quarantine.json` / `npm run test:quarantine` 均已落地。目标不是降低速度，而是提高每个变更的可审查性：高风险 runtime/storage/context/permission/CI 变更必须有 review + regression evidence；限制单个 PR 的语义范围而非单日提交数；默认 `npm test` 保持 deterministic，已知 flaky 进入 quarantine / smoke / nightly 层。下一步是 Phase 4 CI quarantine reporting 与 Phase 5 scheduled smoke/nightly lanes。 |
| **P1** | **Module Coupling Governance** | [module-coupling-decoupling-and-re-aggregation-plan.md](./reference/module-coupling-decoupling-and-re-aggregation-plan.md), [active/TODO_cleanup.md](./active/TODO_cleanup.md) | 2026-06-18 补充 PR-sized execution map，并落地 Phase 0.5/1A/1B/2A/2B/2C/3A；Phase 3B+ 已完成 `ContextRefreshStrategy`、`ProviderTurnDriver`、`ToolDispatchPipeline` 以及 `eventsTranslator` / `behaviorTraceTap` / `loadWorkingSetOverride` / `applyWorkingSetUpdate` 四个 standalone helper。Phase 4A+ 已收口：37 个 router slice、execute/stream route modules、active execution / timeout / preparation / finalization / event processing / metrics / HTTP result / runtime options / WebSocket control / stream loop helper、`routerRegistrar`、`bootstrapStatus`、`middleware`、`executeRouteDeps`、shared `workingSetBroadcaster` wire、`socketQuery` 与 `security` tail cleanup 均已落地；`app.ts` 当前 191 lines，低于 ≤400 north-star。下一步回到 Phase 3B+，按 `review-high-risk` 规划 `LLMCodingRuntime.runExecuteStreamInner` / `RuntimeOrchestrator` 小切片；不得再把 Phase 4 tail cleanup 扩成新的 router 大搬迁。 |
| **P2 Plan** | **Tool Surface Expansion / Native vs MCP 共存** | [reference/tool-governance-plan.md](./reference/tool-governance-plan.md) | 新工具（Phase 1–6）仍 Plan only：源码尚未实现 `AskUserQuestion`、`TaskGet/List/Update`、`MCPTool`、`EnterPlanMode`、`WorktreeCreate/Remove`、`ConfigGet/Set`、`Sleep`、`ScheduleCron*`、`WebSearchProvider` 抽象。**`SkillList/Show/Validate/Draft/Save` 已通过 [Skill 治理规划](./reference/skill-execution-and-automated-normalized-skill-generation-governance-plan.md) Phase 6 落地**。新工具必须真实 regression 驱动。Phase 0 文档口径已 Closed（2026-06-17，含 27 errorCode 登记 + 文档纠偏）；**registry layering 诊断（`tool_overridden_by` + `tool_override_blocked` + `risk_promoted`）已收口（2026-06-17，`src/nexus/toolRegistryLayering.ts` + `createRuntime.ts` 接线 + `test/runtime-layering.test.ts` 11 测试）**。历史工具面/边界/整合规划已迁入 [archive/](./archive/)。 |
| **P2 Plan** | **Cache Observability & Nexus Realtime Detection** | [cache-observability-and-nexus-realtime-detection-plan.md](./reference/cache-observability-and-nexus-realtime-detection-plan.md) | 2026-06-17 升级为 Active Plan + Phase A + B + C + D 全部收口。Phase A：`src/nexus/cacheHealth.ts` 纯函数 + `/v1/runtime/metrics` 增 `cacheHealth` 字段。Phase B：`/v1/runtime/loop/health` pane payload 增 `cacheHealth` 字段。Phase C：`CacheHealthEventSchema` + `buildCacheHealthEvent` + `CacheHealthEventDedup` 模块级单例 + `maybeBuildCacheHealthEventFromExecutionMetrics`，HTTP/WS 两个 yield 点按需 emit。Phase D：`BehaviorMonitor.detectPromptCacheMissWave` detector — 读 `execution_metrics.cacheReadRatio`，当 ≥ 3 sessions 低于 0.85 target 时输出 `PROMPT_CACHE_MISS_WAVE` anomaly（errorMessage 含 session 数 + 最低 ratio 列表）；BehaviorTrigger 联合类型已扩。累计 28 cache-health + 29 behavior-monitor tests pass。Phase E (real caches) 仍 Watch。 |
| **P2 Plan** | **Context CWD Drift & Recall Governance** | [context-cwd-drift-and-recall-governance-plan.md](./reference/context-cwd-drift-and-recall-governance-plan.md) | 2026-06-17 升级为 Active Plan。**Phase A + Phase A Follow-up + Phase B + Phase C1 已收口（2026-06-18）**：路径提取 prose guard / URL guard / 实存路径短路、registry storage 哨兵、SessionRootContinuity event 与 AgentTrace 投影已落地，focused regression tests 覆盖 `session_cf361f04` 失败点和 cwd 切换面。**Phase C2 已收口（2026-06-18, §11-13）**：源核对（2026-06-24）确认 `session_10320709-2b06-405f-8f51-d954435d4a70` 暴露的 4 个 follow-up bug 全部落地——(1) **Bug 1 Layer A [P0] ✅**：`src/runtime/systemPromptBuilder.ts` 新增 `extractAndBlankQuotedRealPaths()` 在 pathPattern 之前抽取 `'...'`/`"..."`/backtick 平衡 span，实存则整段加入 candidates；39 unit tests。(2) **Bug 1 Layer B [P0] ✅**：同文件导出 `isAcceptablePromptCwd(p)` 守卫 4 个 return 点（拒绝 `/`/`/Users`/homedir/`~/Library`/`~/Documents`/`~/Desktop`/`~/Downloads`/`~/Applications`）；`test/resolve-cwd-fallback.test.ts` 10 test。(3) **Bug 2 [P1] ✅（§13.4 修正版）**：新增 `sessions.origin_cwd` 列（`src/storage/SqliteStorage.ts:488` + 不可变 migration `776` + backfill `782`；`MemoryStorage.ts:49` 强制 immutable）；`sessionCreateRouter.ts:36` 写入一次；`executionPreparation.ts:180/249/253/276` 全部走 `originCwd ?? cwd` 链；`app.ts:resolveExplicitPromptCwd` 站点已收敛到 `executionPreparation.ts:328` 一份，dual-site 不一致消除。(4) **Bug 3 [P0] ✅**：`LLMCodingRuntime.runExecuteStreamInner` 起手 + `app.ts` HTTP/WS 两条 `executeStream` 调用点 + `runtimeToolLoop.executeProviderToolCall` defensive merge 三处全部注入 storage；`test/runtime-storage-propagation.test.ts` 5 test 含 session_10320709 精确场景。(5) **Bug 4 [P1, §13 新增] ✅**：dual-site 已统一到 `executionPreparation.ts`，`session.cwd = cwd` 每 turn 覆写路径消失。**session_10320709 的 8 GLOB_FAILED / 3 scope_boundary parent_scan / 6 WEB_SEARCH_FAILED / 1 幻觉路径 / turn 1 992k tokens 浪费** — 仍是真实独立问题（ripgrep `~/Library/Caches` 权限拒绝、网络稳定性、模型幻觉），但跟 cwd drift 主线解耦，归入对应独立工具鲁棒性 follow-up，不再阻塞 cwd plan。**Phase D（`ContextEstimateCalibration` diagnostic）/ E（`ROOT_SCAN_REQUIRES_CONFIRMATION` 工具层 guard）/ F（`UserArtifactContinuity`）仍 Open**。 |
| **Active Plan** | **Long-Running Context Assembly** | [long-running-context-assembly.md](./reference/long-running-context-assembly.md), [context-cwd-drift-and-recall-governance-plan.md](./reference/context-cwd-drift-and-recall-governance-plan.md), [active/TODO_runtime.md](./active/TODO_runtime.md) | 2026-06-20 收盘：R0 / R1 / R2 / R3 / R4 / R5 / R6 / R7 全部收口。R2（persisted working set 接入 `executeStream` hot path）、R3（REST PUT ↔ `/v1/working-set/observe` 共享 broadcaster tracker）、R4（`/v1/context/observe` 真实 runtime e2e + redacted payload）、R5（resume preview product path）、R6（Go TUI runtime-owned rendering）、R7（真实 session replay gate，c1-c6 全过）全部有 focused regression。**2026-06-21 doc lifecycle 迁移**：本 plan 从 `proposals/` 迁到 `reference/` 并升级为 `Active Plan`。R7 后无剩余 Open 段。 |
| **P2 Watch** | **后续迁入、可选执行后端与性能治理** | [active/TODO_runtime.md](./active/TODO_runtime.md), [active/TODO_cleanup.md](./active/TODO_cleanup.md), [active/TODO_performance.md](./active/TODO_performance.md), [go-runner-plan.md](./proposals/go-runner-plan.md) | Go Runner 只作为 optional `RemoteToolRunner` 执行后端；BabeL-X 后续迁入必须先定义 Nexus-owned interface，再写 adapter，最后迁移实现。默认 Node/TS 开发流不能依赖 Go。 |

## Watch / Closed 短索引

这些事项已经完成或转为真实回归守门，完整事实不再放在总控 TODO 中，见 [DONE.md](./DONE.md)：

- Session Replay & Evidence Governance：partial Read、line/byte range、intent target、same-ms tool replay mismatch 已收口。
- Recoverable Tool Error / Session Continuity：Grep dash-leading pattern、generic thrown tool errors provider-visible recovery、内置工具结构化 `success=false` code 已收口；后续只保留 recovery boundary / context diagnostics 真实 drift follow-up。
- Current-turn Session Finalization：旧 result/error 污染已收口。
- Task-adaptive Recoverable Timeout：soft deadline + hard watchdog + Go TUI 可见化已收口。
- Go TUI Permission Policy / Bash hard-deny：read-only classifier、soft-deny policy、mock regression、`--allow-tools` 已收口。
- Go TUI `/model` 模型持久化：`POST /v1/runtime/config/select {model}` 与 Step 4 state machine 已收口。
- SessionChannel + Inbox / scoped memory / governed memory candidate：MVP 与 TUI 可见化已收口，后续只按真实 drift 重开。
- EverCore Phase A-G 与 L1-L6：默认关闭、volatile / non-authoritative、managed sidecar/cache/UI/actions/answer governance 已收口。
- Context Blocking Recovery / Cache-aware Compact / Token Estimator：核心恢复路径与诊断已收口，后续按真实 drift 补 fixture。
- AgentLoop / AgentScheduler / Worktree recovery：child transcript、rerun、worktree conflict recovery 与 governance storage 已收口；write-capable child agent 仍未启用。

## 主线状态

| 主线 | 当前状态 | 下一步 |
| --- | --- | --- |
| Runtime / Context | Context compact、token estimator、provider recovery、DeepSeek reasoning replay、hooks、SessionChannel、scoped memory、EverCore、Task-adaptive timeout、Context Blocking Recovery 核心路径均处于可验证状态。 | 不开泛化重写；真实 drift 先补最小 regression。Behavior Monitor 与 Long-Running Context Assembly 只能从小切片进入。 |
| Agents / Optimize | AgentLoop、sub-agent、worktree、provider smoke、AgentScheduler API/CLI、review/test profiles、child transcript、rerun、worktree recovery 已落地。 | 暂不启用 write-capable child agent；未来必须先完成 worktree-isolated child execution + parent diff review。 |
| Provider / Models | Registry、adapters、role routing、capability gates、diagnostics、MiniMax/DeepSeek 兼容、models inspect 已落地。 | 自动模型选择、默认 role model 推荐和 silent fallback 继续延后；只补真实 provider regression。 |
| CLI / TUI | `bbl go`、`bbl run`、slash/tool palette、permission panel、boxed input、PTY baseline、Inbox/Agents/Memory overlays 均已落地；`bbl loop` 正在推进。 | Go TUI 进入稳定维护；`bbl loop` 按 reference plan 推进，但只做前端编排与渲染。 |
| Performance / Storage | SQLite、tool traces、metrics、storageBridge WAL、benchmark、runtime metrics、Go Runner 对比 benchmark 已落地。 | 保持 CI/build/benchmark 守门；Go Runner 扩展必须显式 env gate。 |
| Cleanup / Build | `docs/nexus` 为唯一长期文档中心；依赖边界、build smoke、format/lint/coverage、BabeL-X compatibility strategy 已完成。 | 继续守住迁入门禁与文档分层，不再把历史完成项堆进 TODO。 |

## 文档索引

| 文档 | 维护内容 |
| --- | --- |
| [README.md](./README.md) | `docs/nexus` 入口、架构分层、历史文档合并口径。 |
| [DONE.md](./DONE.md) | 已完成能力索引与 Watch / Closed 降噪承接。 |
| [WORK_LOG.md](./WORK_LOG.md) | 事实性工作记录、验证命令和重要决策。 |
| [active/TODO_runtime.md](./active/TODO_runtime.md) | Runtime、Nexus API、storage、security、context、compact、MCP、skills、permissions。 |
| [active/TODO_agents.md](./active/TODO_agents.md) | TaskSession、TaskQueue、AgentLoop、Planner/Executor/Critic、sub-agent、worktree。 |
| [active/TODO_tui.md](./active/TODO_tui.md) | `bbl go`、`bbl run`、`bbl loop`、输入框、overlay、permission panel、PTY smoke。 |
| [active/TODO_product_30day.md](./active/TODO_product_30day.md) | 产品 / UX 30 天改造。 |
| [active/TODO_performance.md](./active/TODO_performance.md) | benchmark、metrics、storage/API 性能、故障注入、并发治理。 |
| [active/TODO_cleanup.md](./active/TODO_cleanup.md) | 依赖治理、BabeL-X 迁入规则、build/CI/lint/coverage。 |
| [reference/README.md](./reference/README.md) | 长期设计、架构边界、索引和指南。 |
| [proposals/README.md](./proposals/README.md) | Draft / Partially Landed 计划索引。 |
| [history/README.md](./history/README.md) | Closed / Watch-only 实现历史账本。 |
| [decisions/README.md](./decisions/README.md) | ADR 风格治理决策索引。 |

## 维护规则

- 新任务必须写入对应 `active/` 专项 TODO；本文件只保留路线板和跨主线优先级。
- 完成事实先追加到 [WORK_LOG.md](./WORK_LOG.md)，再把完成能力索引移动到 [DONE.md](./DONE.md)。
- TODO 中原则上只保留未收口项；已完成事项写入 [DONE.md](./DONE.md) 或在本文件 Watch 短索引中一行带过。
- 状态标为完成前，必须能对应到代码、测试、文档或明确验证命令。
- 若一个任务跨多个主线，只在总控保留一行优先级，细节由一个主文档承接，其他文档只做链接。
- 新增 reference 文档正文优先英文，末尾保留 `中文概述`；Draft / Partially Landed 不进入 reference，Closed 项不长期保留为独立 reference。
