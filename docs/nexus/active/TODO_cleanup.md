# TODO Cleanup / Decoupling

## 目标

BabeL-O 采用全新设计的干净架构，不应无选择地搬运 BabeL-X 的历史复杂度。Cleanup 的重点不是“删旧代码”，而是守住依赖边界、发布工程化和 BabeL-X 参考迁入纪律。已完成的重构能力见 [DONE.md](../DONE.md)。

## 当前状态

- Runtime 去重、结构化 logger、`docs/nexus` 文档中心、Hooks 最小内核、PromptInput 状态分层、多级 permission panel、Compact UX、MCP stdio client、Skill loader、Agent lifecycle metadata 等第一轮迁入/设计重构已完成。
- Dependency boundary audit、生产构建与 build smoke 已落地：`npm run deps:audit` 输出 direct dependency ownership、runtime reachable dependency report、CLI imports 和 failure diagnostics；`npm run build:smoke` 会 build `dist/` 并覆盖 `bbl --help`、`bbl go --check`、`bbl run hello`（`bbl chat` 已于 v0.3.7 移除，不再纳入 smoke）。
- Check-only format/lint、GitHub Actions workflow 与 coverage report 已落地：`npm run format:check` 只检查不改写文件，`npm run lint` 串联 typecheck/format/deps audit，`npm run coverage` 产出 `coverage/coverage-summary.json` 且暂不设置硬阈值。
- 当前 cleanup 剩余项为 P2 后续迁入门禁。

## 已收口 Package Boundary

Dependency boundary audit 已接入 `npm run deps:audit`，详见 [DONE.md](../DONE.md) 与 [WORK_LOG.md](../WORK_LOG.md)。

这些规则已由 `scripts/audit-dependency-boundary.js` 与 `npm run deps:audit` 守门：新增依赖必须有 runtime / cli / dev / optional-ui 归属，runtime core 不允许依赖 terminal UI、desktop/browser/mobile integration，provider adapter 不允许把 provider-specific event shape 泄漏到 Nexus API。

## 已收口 Production Build

Production build 与 build smoke 已接入 `npm run build:smoke`：`npm run build` 产出 `dist/`，`bin/bbl.js` 在 `dist/cli/program.js` 存在时走生产 JS，不再经 `tsx` 启动；smoke 覆盖 `bbl --help`、`bbl go --check`、`bbl run "hello"`。

## 已收口 Lint / Format / CI

Check-only format/lint、GitHub Actions workflow 与 coverage report 已接入，详见 [DONE.md](../DONE.md) 与 [WORK_LOG.md](../WORK_LOG.md)。当前 coverage 只产出报告，不设置硬阈值。

## P1 Development Process Stability Governance

> Canonical plan: [development-process-stability-governance-plan.md](../reference/development-process-stability-governance-plan.md).

本项把开发过程稳定性显式化，不改变 Nexus/runtime 架构边界。目标是让高频开发继续保持 reviewable、可回滚、可验证。

- [x] **Phase 1 — PR review template + risk levels**. ✅ 收口（2026-06-18）：新增 `.github/PULL_REQUEST_TEMPLATE.md`，覆盖 risk level、scope、behavior changed、regression evidence、verification、docs updated、flaky/quarantine impact、rollback notes 和 checklist；`CONTRIBUTING.md` / `GOVERNANCE.md` 记录 `review-light` / `review-standard` / `review-high-risk` / `review-emergency` 口径，高风险范围覆盖 runtime loop、task scope、storage、permissions、shared events、provider replay、Nexus session routing、CI、release 与 dependency-boundary scripts。
- [x] **Phase 2 — semantic PR / commit granularity rule**. ✅ 收口（2026-06-18）：`CONTRIBUTING.md` 明确 one PR = one regression slice / feature slice / documentation lifecycle move；列出 runtime+docs、storage+UI、event schema+provider、Go TUI+Nexus runtime 等 split triggers；明确不设置任意单日 commit-count cap。
- [x] **Phase 3 — flaky quarantine inventory + command**. ✅ 收口（2026-06-18）：新增 `test/quarantine.json` 机器可读清单和 `scripts/test-quarantine.js`；`npm run test:quarantine` 默认只列出 quarantine state，`npm run test:quarantine -- --run` 才显式运行登记项并报告结果。第一版保持默认 `npm test` 覆盖不变，只提供隔离观察入口，避免未完成 root cause 前降低 required gate 覆盖。
- [ ] **Phase 4 — CI quarantine reporting**.
  - Add non-blocking quarantine log upload or summary when the quarantine lane is enabled.
  - Required gates remain `typecheck`, `format:check`, `deps:audit`, deterministic `npm test`, and `build:smoke`.
- [ ] **Phase 5 Watch — scheduled smoke / nightly lanes**.
  - Optional Go TUI, Go runner, provider live, PTY, benchmark, and network-sensitive tests stay env-gated or scheduled.
  - Failures should produce trend evidence before becoming required PR gates.

### Flaky Quarantine Index

| Test file | Test name / symptom | First observed | Last observed | Likely cause | Owner | Exit condition | Replacement coverage |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `test/runtime.test.ts` | full-file run intermittently reports `Unable to deserialize cloned data` from the Node test runner, not an assertion failure | 2026-06-18 | 2026-06-18 | Node test-runner serialization / large runtime fixture state | Runtime maintainer | 10 consecutive full-file runs pass or root cause isolated to a smaller deterministic fixture | Focused `runtime.test.ts` name-pattern runs covering cwd / storage / tool-loop cases continue to pass |
| `test/permission-flow.test.ts` | `smart permissions: prompts user on non-whitelisted` can time out waiting for `permission_request`; baseline also fails after stash | 2026-06-18 | 2026-06-18 | Async permission timing / polling race, pre-existing | Runtime maintainer | deterministic permission fixture or 10 consecutive isolated passes | Existing focused permission and runtime tool-loop tests remain required |

Machine-readable source: `test/quarantine.json`. Listing command: `npm run test:quarantine`. Opt-in run command: `npm run test:quarantine -- --run`.

**Resolved 2026-07-01 (fixed, not quarantined):** `test/everos-background-bootstrap.test.ts` — "timeout env var is respected when present" plus 5 siblings cancelled via `cancelledByParent` on Node 22 (local `npm test` exit 1), passing on Node 24 (CI). Root cause: `startEverOSBackgroundBootstrap` correctly `.unref()`s its timeout timer (production-correct — must not keep the process alive), but the test's mock runner returned a bare `new Promise(() => {})` with no pending I/O, so Node 22's `node:test` saw an empty event loop and cancelled before the 50ms timeout could fire. Fix: mock runner now resolves after 500ms (keeps the loop alive); the 50ms timeout still wins `Promise.race` and settles `handle.promise` with the timeout error. Local `npm test` now exit 0 (1246/1246). No quarantine entry — coverage retained.

## P1 Module Coupling Governance

> Canonical plan: [module-coupling-decoupling-and-re-aggregation-plan.md](../reference/module-coupling-decoupling-and-re-aggregation-plan.md).

本项承接模块耦合治理。执行口径是小 PR，不直接做大重构；每个 PR 消除一个可审查耦合点，并给出 before / after audit fingerprint。

当前优先级在 Phase 4A+；Phase 0.5/1A/1B/2A/2B/2C 已提供 audit baseline、移走 runtime-owned monitors、清掉 `nexus -> cli` bootstrap import、把 provider session rules 改为可注入服务、移除了最后一个 `runtime -> nexus` reverse import，并完成 `ConfigManager` 实例化 pilot。Phase 3A 已把 `runtimePipeline.ts` 收缩为 137-line compatibility façade，helper slices 已落地到 `runtime/pipeline/*`；Phase 3B+ 已落地 `ContextRefreshStrategy`、`ProviderTurnDriver`、`ToolDispatchPipeline` 三个小切片：

- [x] **Phase 0.5 — Coupling Audit Baseline**. ✅ 收口（2026-06-18）：新增 `scripts/audit-coupling.js` 与 `npm run coupling:audit`，输出 reverse imports、import direction matrix、known singleton state、large-file line counts、`process.env` / `process.cwd()` concentration。脚本只生成机器可读 JSON，不改变 runtime / Nexus / CLI 行为，也不把历史耦合债务直接变成 required failure gate。
- [x] **Phase 1A — Move Runtime-Owned Monitors**. ✅ 收口（2026-06-18）：`BehaviorMonitor`、`WorkingSetTracker`、`PersistedWorkingSetTracker` 已迁入 `src/runtime/`；`src/nexus/*` 旧路径仅保留 compatibility re-export façade。`npm run coupling:audit` 显示 monitor 相关 `runtime -> nexus` imports 已清零。
- [x] **Phase 1B — Remove Nexus -> CLI Bootstrap Import**. ✅ 收口（2026-06-18）：`startEverOSBackgroundBootstrap`、`runEverOSMemorySetup`、EverOS prerequisite inspection、pip fallback build helpers 已迁入 `src/runtime/`；`src/nexus/createRuntime.ts` 改为依赖 runtime bootstrap；`src/cli/everos*.ts` 旧路径保留 compatibility façade / CLI policy wrapper。`npm run coupling:audit` 报告 `nexusToCli: []`。
- [x] **Phase 2A — ProviderSessionRules Service**. ✅ 收口（2026-06-18）：新增 `src/runtime/providerSessionRules.ts`；`runtimeToolLoop.ts` 不再持有 module-level rule `Map`，而是接收 injected service 并保留 legacy default instance；`LLMCodingRuntime` 默认拥有 per-runtime `ProviderSessionRules`。focused provider-session test 证明两个 injected services 不共享 approval rule。
- [x] **Phase 2B — ContextBroadcaster Injection**. ✅ 收口（2026-06-18）：新增 runtime-owned `RuntimeContextBroadcaster` 结构接口；`refreshRuntimeContextState` 接收 injected broadcaster；`LLMCodingRuntime` / `createDefaultNexusRuntime` / server / embedded app composition 显式传递同一实例；删除 `runtime/contextBroadcasterSingleton.ts`。`npm run coupling:audit` 报告 `runtimeToNexus: []`。
- [x] **Phase 2C — ConfigManager Instance Pilot**. ✅ 收口（2026-06-18）：`ConfigManager` 支持 `new ConfigManager({ configFile })` 并保留旧 string constructor；`createDefaultNexusRuntime({ configManager })`、`ExploreAgentScheduler({ configManager })`、`createExploreRuntime({ configManager })` 走 injected instance。focused dual-instance test 证明两个 config 文件不串线，且 Nexus / agent runtime factory 可按各自实例选择 runtime 类型。
- [x] **Phase 2D — RuntimeServices Container** (container landed 2026-06-21 per [module-coupling-decoupling-and-re-aggregation-plan.md §2D](../reference/module-coupling-decoupling-and-re-aggregation-plan.md) + commit `8173de3`): introduce the typed composition-root container so the remaining module-level singletons collapse into one. **Sub-slices**:
  - [x] `RuntimeServices` container slice（2026-06-21, 2D.0）: `src/runtime/env.ts` 195 lines `parseRuntimeEnv` boot-time snapshot + `src/nexus/services.ts` 114 lines `createRuntimeServices` composition root in `src/nexus/` (NOT `src/runtime/`) to keep `nexus → runtime` direction clean; `test/runtime-env.test.ts` 17 cases + `test/runtime-services.test.ts` 8 cases. Container exposes 5 fields (configManager / contextBroadcaster / everCoreManager / providerSessionRules / env); defaults fall back to legacy module-level instances. `parseRuntimeEnv` mirrors `nexus/server.ts:parsePolicyMode` alias set (`'strict'` / `'soft-deny'` / `'softdeny'` / `'soft_deny'` / case-insensitive / empty-string-means-undefined) + `parseBoolean` yes/no compatibility so the follow-up migrations are byte-identical.
  - [ ] **2D.1 — `src/nexus/server.ts` migration** (pending): 21 `process.env` reads → `services.env.nexus.*`. Verification: `grep -rn 'process\.env' src/nexus/` drops from 47 hits to 0 hits, satisfying Phase 7 verification criterion (line 459 in plan doc). Largest single-file impact.
  - [ ] **2D.2 — `src/nexus/createRuntime.ts` migration** (pending): 1 `process.env` read + 1 `ConfigManager.getInstance()` → `services.configManager` + `services.env`.
  - [ ] **2D.3 — `src/cli/embedded.ts` migration** (pending): 2 `process.env` reads + 2 `ConfigManager.getInstance()` + 1 `defaultEverCoreRuntimeManager` → services.
  - [ ] **2D.4 — CLI commands migration** (pending): `src/cli/commands/go.ts` 8 reads + `src/cli/runSessionFlow.ts` 7 reads → `services.env.workspace.*` / `services.env.nexus.*`.
  - [ ] **2D.5 — Nexus routers / benchmarks migration** (pending): `src/nexus/routers/runtimeModelsRouter.ts` 8 reads + `src/nexus/runnerComparisonBenchmark.ts` 5 reads.
  - [ ] **2D.6 — Remaining `ConfigManager.getInstance()` callsites** (pending): 22+ callsites in CLI commands / routers / runtime diagnostics / provider smoke / compact summary / bash tool → `services.configManager`.
  - [ ] **2D.7 — Phase 2 closure** (pending): flip Phase 2 row → "Closed 2026-06-XX"; remove the 7 follow-up bullets from plan doc Phase 2 row; flip `[ ]` → `[x]` for this entire entry in TODO_cleanup.md.

Current focus:

- [x] **Phase 3A — RuntimePipeline Submodule Split**. ✅ 收口（2026-06-18）：extract pure helper submodules while keeping `runtimePipeline.ts` as a re-export façade.
  - [x] `turn` slice（2026-06-18）：新增 `src/runtime/pipeline/turn.ts`，承载 provider turn types、tool-call input resolution、assistant/tool-result message builders；`runtimePipeline.ts` 保留 re-export façade。
  - [x] `events` slice（2026-06-18）：新增 `src/runtime/pipeline/events.ts`，承载 runtime result/error/tool-call text leak suppressed event builders；`runtimePipeline.ts` 保留 re-export façade。
  - [x] `context grounding` slice（2026-06-18）：新增 `src/runtime/pipeline/context.ts`，承载 context grounding required/confirmed、workspace dirty detection、git status changed-file parsing；`runtimePipeline.ts` 保留 re-export façade。
  - [x] `context refresh` slice（2026-06-18）：新增 `src/runtime/pipeline/contextRefresh.ts`，承载 context warning/blocking/usage/microcompact/recovery events、context refresh state builder、injected broadcaster publish path；`runtimePipeline.ts` 保留 re-export façade。
  - [x] `cache / metrics` slice（2026-06-18）：新增 `src/runtime/pipeline/cache.ts`，承载 `RuntimeExecutionMetrics`、execution metrics event builder、provider/cache/prefix/compact/remote metrics absorption；`runtimePipeline.ts` 保留 re-export façade。
  - [x] `provider loop` slice（2026-06-18）：新增 `src/runtime/pipeline/loop.ts`，承载 provider loop request state、query params、prefix-cache diagnostics、execution state block helpers；`runtimePipeline.ts` 保留 re-export façade。
  - [x] `provider turn outcome / stream` slice（2026-06-18）：新增 `src/runtime/pipeline/providerTurn.ts`，承载 `reduceProviderTurnOutcome()`、option-selection clarification helper、`streamProviderTurn()`、usage aggregation 和 leak guards。
  - [x] `local runtime intent` slice（2026-06-18）：新增 `src/runtime/pipeline/localIntent.ts`，承载 `parseLocalRuntimeIntent()` 及其 local parser helpers。

Current focus:

- [x] **Phase 3B+ — LLMCodingRuntime Strategy Extraction**（父收口 2026-06-21，per [module-coupling-decoupling-and-re-aggregation-plan.md §3B+](../reference/module-coupling-decoupling-and-re-aggregation-plan.md)）：extract one strategy object per PR; do not mix router or event-schema work into the same PR.
  - [x] `ContextRefreshStrategy` slice（2026-06-18）：新增 `src/runtime/ContextRefreshStrategy.ts`，封装 context refresh dependencies、session inbox loading policy，并接入 `LLMCodingRuntime.executeStream()` hot path 与 `resume()` context assembly；compact orchestration / provider calls / tool dispatch 仍留在 runtime loop。
  - [x] `ProviderTurnDriver` slice（2026-06-18）：新增 `src/runtime/ProviderTurnDriver.ts`，封装 provider adapter `queryStream` 调用、`streamProviderTurn()` 接线和 tool-call text / memory capability leak guard setup；hook dispatch、provider recovery、compact retry 仍留在 runtime loop。
  - [x] `ToolDispatchPipeline` slice（2026-06-18）：新增 `src/runtime/ToolDispatchPipeline.ts`，封装 provider tool-call dispatch coordination、tool events 收集、working-set callback、grounding confirmation 和 scope confirmation 后 task scope re-derive；`executeProviderToolCall()` permission / scope / audit behavior 不变。
  - [x] `executeProviderRecoveryDecision` slice（2026-06-20, 3B-19）：新增 `src/runtime/executeProviderRecoveryDecision.ts` 382 行 catch-block 提取，owns hook firing / error classification / recovered-blocked-rethrow branching / reactive compact + refresh + enforceMessageBudget sequence。
  - [x] `eventsTranslator` / `behaviorTraceTap` / `loadWorkingSetOverride` / `applyWorkingSetUpdate` slices（2026-06-19, 3B-1/6/7/8）：4 个 standalone helper 共 708 行从 runtime body 抽出。
  - **Open**: `HookDispatcher` / `RuntimeResumeService` 后续 follow-up — plan doc 显式说明"仅在能保持小 PR 时推进"。`LLMCodingRuntime.ts` 当前 1502 行（1841 起始），主循环 25+ `yield buildXxxEvent` 仍在原处；按 stop rule (plan doc line 24) 剩余为 orchestration 时即可停。

- [x] **Phase 4A+ — Nexus Router Slice**（父收口 2026-06-19，per [module-coupling-decoupling-and-re-aggregation-plan.md §4](../reference/module-coupling-decoupling-and-re-aggregation-plan.md) + [Phase 4A+ App.ts Decomposition Retrospective](../reference/module-coupling-decoupling-and-re-aggregation-plan.md#phase-4a-appts-decomposition-retrospective-2026-06-19)）: extract low-risk route clusters first; do not start with `/v1/execute` or WebSocket stream.
  - [x] `runtimeStatusRouter` slice（2026-06-18）：新增 `src/nexus/router.ts` 与 `src/nexus/routers/runtimeStatusRouter.ts`，接管 `/health`、`/v1/runtime/status`、`/v1/runtime/version`；`app.ts` 只传入 metrics/bootstrap/status closures，route response shape 不变，focused router integration test 已补。
  - [x] `runtimeConfigRouter` read-only slice（2026-06-18）：新增 `src/nexus/routers/runtimeConfigRouter.ts`，接管 GET `/v1/runtime/config`、`/v1/runtime/config/profiles`、`/v1/runtime/config/profiles/:name`；POST select/provider 和 `/v1/runtime/models` 仍留在 `app.ts`，focused router integration test 已补。
  - [x] `runtimeConfigMutationRouter` slice（2026-06-18）：新增 `src/nexus/routers/runtimeConfigMutationRouter.ts`，接管 POST `/v1/runtime/config/provider` 与 POST `/v1/runtime/config/select`；复用 `inspectResolvedRuntimeConfig()` 保持脱敏响应 shape，focused router test 与 `test/config-endpoints.test.ts` 已覆盖。
  - [x] `runtimeMemoryRouter` status slice（2026-06-18）：新增 `src/nexus/routers/runtimeMemoryRouter.ts`，接管 GET `/v1/runtime/memory/status`；memory search/save/flush/restart actions 仍留在 `app.ts`，focused router integration test 已补。
  - [x] `runtimeMemoryRouter` candidates slice（2026-06-18）：扩展 `src/nexus/routers/runtimeMemoryRouter.ts`，接管 GET `/v1/runtime/memory/candidates` review-only queue；memory search/save/flush/restart actions 仍留在 `app.ts`，focused router test 与 runtime named regression 已通过。
  - [x] `runtimeModelsRouter` slice（2026-06-18）：新增 `src/nexus/routers/runtimeModelsRouter.ts`，接管 GET `/v1/runtime/models` provider/model list 与 auth diagnostics；POST config provider/select 仍留在 `app.ts`，focused router integration test 已补。
  - [x] `runtimeMetricsRouter` slice（2026-06-18）：新增 `src/nexus/routers/runtimeMetricsRouter.ts`，接管 GET `/v1/runtime/metrics`；metrics aggregation helper 仍留在 `app.ts` 并通过 typed context closure 注入，focused router integration test 已补。
  - [x] `runtimeProviderDiagnosticsRouter` slice（2026-06-18）：新增 `src/nexus/routers/runtimeProviderDiagnosticsRouter.ts`，接管 provider smoke dry-run/live 与 fallback-plan diagnostics；provider config mutation routes 仍留在 `app.ts`，focused router integration test 已补。
  - [x] `schemaRouter` slice（2026-06-18）：新增 `src/nexus/routers/schemaRouter.ts`，接管 GET `/v1/schema/events`；`app.ts` 不再直接 import `NexusEventSchema`，focused schema router test 已补。
  - [x] `contextHistoryRouter` slice（2026-06-18）：新增 `src/nexus/routers/contextHistoryRouter.ts`，接管 GET `/v1/context/history` 与 GET `/v1/context/trace`，并搬迁 `parseSinceFromQuery()` / `runContextHistory()` / `runBehaviorTraceGet()` helper；`app.ts` 仅 re-export 旧 helper 入口，focused router test 已补。
  - [x] `contextWorkingSetReadRouter` slice（2026-06-18）：新增 `src/nexus/routers/contextWorkingSetReadRouter.ts`，接管 working-set GET list/session/workspace aggregate routes，并搬迁 `runWorkingSetList()` / `runWorkingSetGet()` / `runWorkspaceWorkingSetGet()` helper；focused router test 已补。
  - [x] `contextWorkingSetWriteRouter` slice（2026-06-18）：新增 `src/nexus/routers/contextWorkingSetWriteRouter.ts`，接管 PUT `/v1/context/working-set/:sessionId` 与 `runWorkingSetPut()` helper implementation；`app.ts` 保留 re-export 兼容入口，`/v1/context/observe` WebSocket 仍留待后续切片，focused PUT regression 已通过。
  - [x] `contextAssembleRouter` slice（2026-06-18）：新增 `src/nexus/routers/contextAssembleRouter.ts`，接管 POST `/v1/context/assemble` manual preview route，并搬迁 `runContextAssemble()` helper；不触碰 runtime assemble hot path、working-set write 或 observe stream，focused router test 已补。
  - [x] `toolsAuditRouter` slice（2026-06-18）：新增 `src/nexus/routers/toolsAuditRouter.ts`，接管 GET `/v1/tools/audit` global runtime tool audit route；保持 `tools_audit` envelope 与 runtime `listTools()` 来源不变，focused router test 已补。
  - [x] `runtimeLoopHealthRouter` slice（2026-06-18）：新增 `src/nexus/routers/runtimeLoopHealthRouter.ts`，接管 GET `/v1/runtime/loop/health`、task-scope summary、behavior hint projection 与 per-pane cache health projection；loop_state CRUD routes 仍留待后续切片，focused router test 与隔离 runtime-loop regression 已通过。
  - [x] `loopWorkspaceRouter` slice（2026-06-18）：新增 `src/nexus/routers/loopWorkspaceRouter.ts`，接管 GET `/v1/loop/workspaces` read-only pane listing；pane create/update/delete mutations 仍留在 `app.ts`，focused router test 与 loop pane named regression 已通过。
  - [x] `skillReadRouter` slice（2026-06-18）：新增 `src/nexus/routers/skillReadRouter.ts`，接管 GET `/v1/skills` 与 GET `/v1/skills/:id` read-only skill registry routes；validate/invoke/draft/save 仍留在 `app.ts`，focused router test 与原 skill routes regression 已通过。
  - [x] `skillValidateRouter` slice（2026-06-18）：新增 `src/nexus/routers/skillValidateRouter.ts`，接管 POST `/v1/skills/validate` validation-only route；invoke/draft/save 仍留在 `app.ts`，focused router test 与原 skill routes regression 已通过。
  - [x] `agentRouter` slice（2026-06-18）：新增 `src/nexus/routers/agentRouter.ts`，接管 agent job API cluster（spawn/list/show/wait/cancel/transcript/session agents）；`app.ts` 仍负责创建并注入 `AgentScheduler`，不触碰 `/v1/execute`、WebSocket stream 或 session task mutation routes，`test/agent-api.test.ts` 已通过。
  - [x] `loopPaneRouter` slice（2026-06-18）：新增 `src/nexus/routers/loopPaneRouter.ts`，接管 loop pane create/update/delete routes；`loopWorkspaceRouter` 继续只负责 GET listing，不触碰 `/v1/execute`、WebSocket stream 或 session task mutation routes，focused router test 与隔离 loop_state regression 已通过。
  - [x] `sessionChannelRouter` slice（2026-06-18）：新增 `src/nexus/routers/sessionChannelRouter.ts`，接管 SessionChannel create/list/show、message create/list、session inbox list/ack routes；不触碰 `/v1/execute`、WebSocket stream、runtime context hot path、SQLite schema 或 Go TUI inbox 渲染，`test/session-channel.test.ts` 已通过。
  - [x] `skillActionRouter` slice（2026-06-18）：新增 `src/nexus/routers/skillActionRouter.ts`，接管 POST `/v1/skills/invoke`、POST `/v1/skills/draft` 与 POST `/v1/skills/save`；read/validate routers 保持独立，不触碰 runtime execution、WebSocket stream 或 Skill 文件格式，focused skill invoke/draft/save regressions 已通过。
  - [x] `sessionReadRouter` slice（2026-06-18）：新增 `src/nexus/routers/sessionReadRouter.ts`，接管 GET `/v1/sessions`、GET `/v1/sessions/:sessionId`、GET `/v1/sessions/:sessionId/assets` 与 GET `/v1/sessions/:sessionId/events`；不触碰 POST session allocation、wait polling、children、compact/context/tool-trace/permission-audit routes、runtime execution 或 WebSocket stream，focused session read regressions 已通过。
  - [x] `sessionWaitRouter` slice（2026-06-18）：新增 `src/nexus/routers/sessionWaitRouter.ts`，接管 GET `/v1/sessions/:sessionId/wait` polling read endpoint；不触碰 session/task/permission mutation、runtime execution 或 WebSocket stream，focused runtime-loop wait regressions 已通过。
  - [x] `sessionChildrenRouter` slice（2026-06-18）：新增 `src/nexus/routers/sessionChildrenRouter.ts`，接管 GET `/v1/sessions/:sessionId/children` 与 GET `/v1/sessions/:sessionId/children/:childSessionId/events`；不触碰 compact/context/tool-trace/permission-audit routes、resume / approval mutation routes、runtime execution 或 WebSocket stream，focused child session read regression 已通过。
  - [x] `sessionInspectionRouter` slice（2026-06-18）：新增 `src/nexus/routers/sessionInspectionRouter.ts`，接管 GET `/v1/sessions/:sessionId/tool-traces` 与 GET `/v1/sessions/:sessionId/permission-audits`；不触碰 compact/context routes、resume / approval mutation routes、runtime execution 或 WebSocket stream，focused tool trace / permission audit regressions 已通过。
  - [x] `sessionCreateRouter` slice（2026-06-18）：新增 `src/nexus/routers/sessionCreateRouter.ts`，接管 POST `/v1/sessions` lightweight allocation；不触碰 runtime execution、permission decision、task mutation、compact/context assembly 或 WebSocket stream，focused inspect-session Phase 1 regressions 已通过。
  - [x] `sessionTaskReadRouter` slice（2026-06-18）：新增 `src/nexus/routers/sessionTaskReadRouter.ts`，接管 GET `/v1/sessions/:sessionId/tasks` read-only task list；不触碰 task create/update/action mutation、task mutation audit、runtime execution 或 WebSocket stream，focused task API regression 已通过。
  - [x] `runtimeMemoryRouter` actions slice（2026-06-18）：将 POST `/v1/runtime/memory/search`、`save-note`、`flush`、`restart` 从 `app.ts` 迁入既有 `src/nexus/routers/runtimeMemoryRouter.ts`；保留 process-local approval counters 注入，不改变 approval gate、EverCore payload 或 memory envelopes，focused memory action regressions 已通过。
  - [x] `sessionResumeRouter` slice（2026-06-18）：新增 `src/nexus/routers/sessionResumeRouter.ts`，接管 POST `/v1/sessions/:sessionId/resume` snapshot route；通过 `getActiveExecutionSnapshot()` 只读注入 active execution metadata，不暴露 abort controller 或 active map，focused resume/cancel regression 已通过。
  - [x] `sessionPermissionRouter` slice（2026-06-18）：新增 `src/nexus/routers/sessionPermissionRouter.ts`，接管 POST `/v1/sessions/:sessionId/approve` 与 POST `/v1/sessions/:sessionId/deny` permission decision routes；不触碰 session storage、cancel/close、task mutation、runtime execution 或 WebSocket stream，focused approve/deny regressions 已通过。
  - [x] `sessionInputRouter` slice（2026-06-18）：新增 `src/nexus/routers/sessionInputRouter.ts`，接管 POST `/v1/sessions/:sessionId/input`；保留 waiting-permission shortcut、`user_message` append 与 `session_input_accepted` envelope，不触碰 cancel/close、task mutation、runtime execution 或 WebSocket stream，focused lifecycle regression 已通过。
  - [x] `sessionCloseRouter` slice（2026-06-19）：新增 `src/nexus/routers/sessionCloseRouter.ts`，接管 POST `/v1/sessions/:sessionId/close`；保留 `closeNexusSession()` cleanup cascade、SessionEnd hooks、EverCore non-fatal sync failure 与 `session_closed` envelope，不触碰 cancel active execution abort、task mutation、runtime execution 或 WebSocket stream，focused close regressions 已通过。
  - [x] `sessionContextRouter` slice（2026-06-19）：新增 `src/nexus/routers/sessionContextRouter.ts`，接管 GET `/v1/sessions/:sessionId/context`；保留 `context_analysis` envelope、context fork metadata、SessionChannel inbox 注入、long-term memory diagnostics 与 memory retrieval event append，不触碰 compact mutation、runtime execution、task mutation、lifecycle cancel/close 或 WebSocket stream，focused context regressions 已通过。
  - [x] `sessionCompactRouter` slice（2026-06-19）：新增 `src/nexus/routers/sessionCompactRouter.ts`，接管 POST `/v1/sessions/:sessionId/compact`；保留 `compact_result` envelope、compact/context boundary 字段与 post-compact grounding events，不触碰 context analysis GET、runtime execution、task mutation、lifecycle cancel/close 或 WebSocket stream，focused compact regression 已通过。
  - [x] `sessionCancelRouter` slice（2026-06-19）：新增 `src/nexus/routers/sessionCancelRouter.ts`，接管 POST `/v1/sessions/:sessionId/cancel`；通过 `cancelActiveExecution()` closure 保留 app composition 对 active execution registry / AbortController 的所有权，router 只接收 request metadata；保留 `session_cancelled` envelope、child session cancel、permission cleanup 与 lifecycle hook 行为，focused cancel regressions 已通过。
  - [x] `sessionTaskMutationRouter` slice（2026-06-19）：新增 `src/nexus/routers/sessionTaskMutationRouter.ts`，整体接管 session task mutation cluster（create/update/claim/complete/fail/cancel/retry/rerun-subagent/worktree-recovery/approve/reject）；把 mutation audit、revision conflict、dependency cleanup、child-session cleanup、sub-agent rerun 和 worktree recovery helpers 作为 router 私有实现迁出 `app.ts`，focused task mutation regressions 已通过。
  - [x] `workingSetObserveRouter` slice（2026-06-19）：新增 `src/nexus/routers/workingSetObserveRouter.ts`，接管 GET `/v1/working-set/observe` WebSocket；保留 snapshot / update / reset event、sessionId filter、injected broadcaster 优先级和 close code 行为，focused working-set observe regressions 已通过。
  - [x] `contextObserveRouter` slice（2026-06-19）：新增 `src/nexus/routers/contextObserveRouter.ts`，接管 GET `/v1/context/observe` WebSocket；保留 assembled snapshot、sessionId filter、default broadcaster fallback、reconnect snapshot 和 subscriber cleanup 行为，focused context observe regressions 已通过。
  - [x] `ActiveExecutionRegistry` slice（2026-06-19）：新增 `src/nexus/activeExecutionRegistry.ts`，把 `/v1/execute`、`/v1/stream`、resume、cancel 共享的 active execution `Map`、snapshot、abort 和 cleanup 操作从 `app.ts` 移出；保留 route contract，不迁移 execute/stream 本体，focused cancel/resume/watchdog/WS concurrency regressions 已通过。
  - [x] `ExecutionTimeoutEvents` slice（2026-06-19）：新增 `src/nexus/executionTimeoutEvents.ts`，把 `/v1/execute` 与 `/v1/stream` 共享的 near-timeout warning、soft-timeout cycle、partial timeout result 和 execute summary builder 从 `app.ts` 移出；保留 route contract 与 timeout policy/watchdog semantics，focused timeout regressions 已通过。
  - [x] `ExecutionPreparation` slice（2026-06-19）：新增 `src/nexus/executionPreparation.ts`，把 `/v1/execute` 与 `/v1/stream` 共享的 request schema、timeout decision、cwd/session 初始化、model capability gate、policy/allowTools 解析和 continuity input 派生从 `app.ts` 移出；保留 route contract 与 runtime execution/finalization 行为，focused model gate / timeout policy / cancel-resume / cwd continuity regressions 已通过。
  - [x] `ExecutionFinalization` slice（2026-06-19）：新增 `src/nexus/executionFinalization.ts`，把 `/v1/execute` 与 `/v1/stream` 共享的 session finalization、execute summary outcome、recoverable denial success 归因、terminalReason 分类和 context-blocking recovery metadata 从 `app.ts` 移出；保留 route contract、event loop、summary append 与 metrics 行为，focused timeout / denial / context-blocking / cancel regressions 已通过。
  - [x] `ExecutionEventProcessing` / `ExecutionEventSink` slice（2026-06-19）：新增并扩展 `src/nexus/executionEventProcessing.ts`，把 `/v1/execute` 与 `/v1/stream` 共享的 soft watchdog decoration、event push/storage append、`execution_metrics` → NexusMetrics、BehaviorMonitor ingest 与 `cache_health` 派生/持久化从 `app.ts` 移出；保留 route contract、event append/persist/send 顺序、timeout scheduling、summary append 与 WS forward 行为，focused timeout / metrics / cache-health / context-blocking regressions 已通过。
  - [x] `RuntimeMetricsSnapshot` slice（2026-06-19）：新增 `src/nexus/runtimeMetricsSnapshot.ts`，把 `/v1/runtime/metrics` 使用的 provider invocation / agent loop / agent job / cache health snapshot 聚合逻辑从 `app.ts` 移出；保留 router contract、response shape、storage scan 范围与 NexusMetrics accumulator 语义，focused runtime metrics regressions 已通过。
  - [x] `ExecutionHttpResult` slice（2026-06-19）：新增 `src/nexus/executionHttpResult.ts`，把 HTTP `/v1/execute` 的 result envelope / status-code assembly 从 `app.ts` 移出；保留 REST 200 wrapper、envelope shape、`context_blocking` → 413、`REQUEST_TIMEOUT` → 408 与 `execute_summary` 元数据回填行为，focused execute envelope regressions 已通过。
  - [x] `ExecutionRuntimeOptions` slice（2026-06-19）：新增 `src/nexus/executionRuntimeOptions.ts`，把 HTTP `/v1/execute` 与 WebSocket `/v1/stream` 共享的 `runtime.executeStream()` options assembly 从 `app.ts` 移出；保留 storage 注入、cwd continuity inputs、policy / allowedTools、allowedPaths、remote runner、timeout signal 与 output budget 传递行为，focused helper regression 已通过。
  - [x] `ExecutionWebSocketControl` slice（2026-06-19）：新增 `src/nexus/executionWebSocketControl.ts`，把 WebSocket `/v1/stream` 的 JSON parse、open-only send helper 与 `permission_response` 快路径 resolve 从 `app.ts` 移出；保留 permission response semantics、execution message flow、event persist/send 顺序与 metrics 行为，focused helper + WS regressions 已通过。
  - [x] `ExecutionTimeoutControls` slice（2026-06-19）：扩展 `src/nexus/executionTimeoutEvents.ts`，新增 `startExecutionTimeoutControls()`，统一 HTTP `/v1/execute` 与 WebSocket `/v1/stream` 的 `effectiveTimeoutMs`、near-timeout watcher、soft-timeout cycle 与 cleanup 接线；route 层仍保留主 watchdog、event loop、near-timeout 检查点、socket-close abort 与 response/stream contract，focused timeout / WS regressions 已通过。
  - [x] `ExecutionSettlement` slice（2026-06-19）：扩展 `src/nexus/executionFinalization.ts`，新增 `settleExecutionSession()`，统一 HTTP `/v1/execute` 与 WebSocket `/v1/stream` loop 后的 result/error 提取、timeout partial result、recoverable denial 成功归因、session finalization 与 `execute_summary` append/persist/send；route 层仍保留 HTTP envelope、socket cleanup、active execution cleanup 和 execute/stream finish metrics，focused helper + execute/WS regressions 已通过。
  - [x] `ExecutionWebSocketForwarding` slice（2026-06-19）：扩展 `src/nexus/executionWebSocketControl.ts`，新增 `forwardProcessedRuntimeEvent()`，把 WebSocket `/v1/stream` 的 processed event 转发顺序、socket closed abort 与 stream metric 记录从 `app.ts` 移出；保留 cache_health-before-main-event 顺序、near-timeout checkpoint、result/error tracking 与 settlement 行为，focused helper regression 已通过。
  - [x] `ExecutionStreamLoop` slice（2026-06-19）：新增 `src/nexus/executionStreamLoop.ts`，把 HTTP `/v1/execute` 与 WebSocket `/v1/stream` 共享的 `runtime.executeStream()` loop、single-event sink、near-timeout checkpoint 与 terminal result/error tracking 从 `app.ts` 移出；WS forwarding / timeout send 通过 callback 注入，route 层仍保留 lifecycle、settlement、HTTP envelope 与 socket cleanup，focused helper + execute/WS regressions 已通过。
  - [x] `ActiveExecutionLease` slice（2026-06-19）：扩展 `src/nexus/activeExecutionRegistry.ts`，让 `register()` 返回幂等 `ActiveExecutionLease.release()`；HTTP/WS routes 统一持有 cleanup handle，不再分别保存 session/request 清理键或通过 abort controller 反查清理；保留 snapshot/cancel response shape，focused registry + cancel/resume regressions 已通过。
  - [x] `ExecutionWebSocketLifecycle` slice（2026-06-19）：扩展 `src/nexus/executionWebSocketControl.ts`，新增 `trackWebSocketClientClose()` 与 `createWebSocketEventSender()`，把 WebSocket `/v1/stream` 的 client-close listener/cleanup、`closedByClient` 状态读取、timeout/summary event sender 与 stream metric 记录从 `app.ts` 移出；保留 WebSocket contract、timeout send 行为和 finish metrics 语义，focused helper + WS regressions 已通过。`app.ts` 当前 864 lines。
  - [x] `SocketQuery` tail cleanup（2026-06-20）：新增 `src/shared/socketQuery.ts`，把 `parseSocketQuery()` 从 Nexus composition root 尾部移到 shared utility；保留 WebSocket query parsing semantics，focused `test/socket-query.test.ts` 覆盖 14 个 malformed/priority/fallback case。
  - [x] `Security helpers` tail cleanup（2026-06-20）：新增 `src/shared/security.ts`，把 `isLocalHost()` / `validateSecurityConfig()` 从 `nexus/app.ts` 移到 shared utility，并从 `nexus/app.ts` re-export legacy path；focused `test/security.test.ts` 增加 shared-vs-legacy parity，`test/security.test.ts` / `test/socket-query.test.ts` / `test/middleware.test.ts` 37/37 pass。`app.ts` 当前 191 lines；`npm run coupling:audit` 仍报告 `runtimeToNexus: []` / `nexusToCli: []`。
  - [x] Phase 4A+ tail cleanup complete（2026-06-20）：`app.ts` 已降到 191 lines；剩余工作不再是 router slice。下一步回到 Phase 3B+，按 `review-high-risk` 规划 `LLMCodingRuntime.runExecuteStreamInner` / `RuntimeOrchestrator` 小切片，不做顺手大搬迁。

Queued but not current focus:

- [ ] **Phase 5 Watch — Events / RuntimeEnv**: defer exhaustive event translator and full env consolidation until Phase 1-4 reduce hot spots.

## 已收口 BabeL-X Compatibility Strategy

BabeL-X compatibility strategy 已收口：默认不自动读取 BabeL-X `~/.babel/config.json`；如需迁移配置，必须显式运行一次性 `bbl config import-babel-x --source <path>`，默认 dry-run 且输出只显示 profile/provider/model 与 hasApiKey/hasBaseUrl，不打印 secret；`--apply` 只把可映射 provider profile 合并写入 BabeL-O config。BabeL-X transcript import 当前不支持，Nexus runtime/session schema 不接纳旧 transcript schema。

## P2 Future Migration Gate

后续从 BabeL-X 迁入能力时必须遵守以下常驻门禁；这些是规则，不作为待办 checkbox 统计：

- 先定义 Nexus-owned interface。
- 再写 adapter。
- 最后迁移实现。
- 优先“设计重构”，不直接复制 giant file。
- 不复制 feature flag dead code、cloud service stub、analytics/GrowthBook、React/Ink runtime 组件。
- 不迁移复杂 plugin system；优先通过 MCP 扩展能力。
- 所有迁入能力必须先写 TODO/接口/测试计划，再实现。

## P2 Optional Go Runner Build Boundary

Go Runner 可以作为可选执行后端进入 `runners/go-runner/`，但不能改变 BabeL-O 的 TypeScript Nexus-first 主架构；以下为常驻 build boundary，不作为待办 checkbox 统计：

- Go 代码放在独立 subtree。
  - 建议路径：`runners/go-runner/`。
  - TypeScript runtime 只通过 `RemoteToolRunner` HTTP/JSON 协议依赖它，不从 runtime core 直接 import/exec Go 内部实现。
- 默认 Node/TypeScript 开发流不依赖 Go。
  - 默认 `npm test`、`npm run typecheck`、`npm run build:smoke` 不要求 Go binary。
  - Go smoke 使用显式 env gate，例如 `BABEL_O_RUN_GO_RUNNER_SMOKE=1`。
- 初期优先 build-from-source，不急于发布 npm optional package。
  - 等协议、Read/Grep/Glob、restricted Bash 与安全默认值稳定后，再评估预构建 binary、平台矩阵和 release packaging。
- Go Runner 不能引入新的架构所有权。
  - 不拥有 session storage、provider credentials、permission audit、AgentScheduler、Context Manager 或 CLI/TUI。
  - 任何 Bash/Write/Edit 能力都必须先在 TODO_runtime / TODO_agents 中完成权限、安全、测试计划登记。

## P2 仍可参考但未迁入的 BabeL-X 能力

| BabeL-X 能力 | BabeL-O 方向 | 当前口径 |
| --- | --- | --- |
| QueryEngine 高阶 tool loop | Runtime pipeline / tool loop | 暂不搬迁，先完成 `LocalCodingRuntime` pipeline 化。 |
| Session transcript import | 一次性导入工具 | 等配置兼容策略确定后再做。 |
| LSPTool | MCP LSP server 或轻量 context picker | 排在 TUI P2。 |
| fork subagent / prompt cache | 子 Agent transcript + worktree 稳定后评估 | 暂不迁入复杂优化路径。 |
| remote/team/swarm agent | SDK/dashboard + remote runner protocol | 暂不迁入；Go Runner 只作为单 runner 执行后端，不作为 remote/team/swarm agent 基础设施。 |

## 验证命令

历史验证覆盖：`npm run typecheck`、`npm test`、`npm run deps:audit`、`npm run build:smoke`、`npm run format:check`、`npm run lint`、`.github/workflows/ci.yml` 和 `npm run coverage`。后续 BabeL-X 能力迁入必须同时补接口/测试计划和 dependency boundary audit。

## 参考文件

- `package.json`
- `docs/nexus/README.md`
- `docs/nexus/TODO.md`
- `src/runtime`
- `src/nexus`
- `src/cli`
