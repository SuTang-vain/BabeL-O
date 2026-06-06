# TODO Runtime / Nexus

## 目标

Nexus 是 BabeL-O 的执行核心。这里只保留仍未收口的 runtime / API / storage / security / context / compact / permissions 任务。已完成的大项见 [DONE.md](../DONE.md)。

## 当前状态

- `GET /v1/runtime/status`、`/v1/runtime/provider-smoke`、`/v1/runtime/provider-smoke/live`、`/v1/sessions/:sessionId/context`、`/v1/sessions/:sessionId/assets`、`/compact`、`/context`、Session Memory Lite 第一版、provider recovery、DeepSeek reasoning replay、hooks 最小内核都已落地。
- Context token estimator conservative mode、blocking limit、auto/manual compact、retained segment、User Intake Guidance、final-response-only、provider protocol regression corpus、统一 diagnostics object、runtime pipeline 最小 seam、tool loop/result aggregator seam、tool loop execution helper、provider turn outcome reducer、context blocking helper、loop state / execution state helper、compact/reassemble state refresh helper 和 provider request assembly / loop guard helper 都已进入可验证状态。
- 真实会话守门继续采用 regression-first：intake 失败时身份/能力短问、上下文记忆短追问已覆盖为 respond-only fallback；`session_93052ea7-8346-40a9-8175-db941312778c` 暴露的 provider 协议污染 assistant 文本已补 Tool-call Text Leakage 回归守门；测试进程写真实 provider config 的污染事故已补中心化 guard 与回归。后续只在真实漂移出现时补最小回归再修 runtime/config/adapter/TUI。
- `session_1e2299be-b988-49ea-8819-587de8258172` 暴露真实会话在大量 `Read` 后第二轮 provider call 前触发 context blocking；P1 已补 provider-loop reactive compact、adaptive `Read` preview/range 策略、live `Read` aggregate budget、embedded metrics side-table 持久化和 retryable failed session 恢复状态表达。后续只保留重复大文件读取诊断与 P2 targeted reading 地基。
- 除上述真实会话回归外，后续阶段仍保留架构收口、权限细化和执行入口升级。

## 已收口 P0 Tool-call Text Leakage Regression

> 样本：`session_93052ea7-8346-40a9-8175-db941312778c`。MiniMax-M3 在 `respond_only` turn 中把 bracket-wrapped pseudo tool call 作为 assistant text 输出，未触发真实工具执行，但污染了 `assistant_delta` / `result.message` 的用户可见文本。

本项已按 P0 regression-first 收口：MiniMax bracket-wrapper parser 已把已知完整格式严格归一为标准 tool-use deltas；runtime generic leakage guard 只在 tools hidden / `respond_only` / final-response-only 等禁用阶段做 suppression-only 检测，输出 `TOOL_CALL_TEXT_LEAK_SUPPRESSED`、redacted preview、retry/metrics diagnostics，并保证未知文本语法不会进入执行路径。

后续只在真实 provider 再次暴露稳定泄漏样本时补最小 corpus；cross-provider 泛化样本与 parser registry 纪律继续按 [tool-call-text-leakage-governance.md](../archive/tool-call-text-leakage-governance.md) Phase D 低优先级推进。

## P1 Intake Classifier 升级

> 样本：`session_a30306de-0933-455a-8263-d14fab1edd24`。用户说"验证当前未提交改动是否健康"，intake 模型分类为 `intent=status, requiresTools=false`，`normalizeGuidancePolicy()` 硬覆盖后工具被隐藏，provider 尝试调用 Bash 被 `TOOL_CALL_SUPPRESSED_BY_USER_INTENT` 抑制。
>
> 详细规划见 [intake-classifier-upgrade-plan.md](../archive/intake-classifier-upgrade-plan.md)。

Phase 1/2/3/4 已收口：`normalizeGuidancePolicy()` 不再对 `status` + `requiresTools=true` 强制 `respond_only` / `requiresTools=false`，intake prompt 已补中英文执行动词 + 工程对象 few-shot；`"验证当前未提交改动是否健康"` 回归覆盖工具保持可见；纯 `status` 短问仍注入 prompt guidance 但不隐藏工具；pause/greeting 继续首轮硬抑制工具；若 respond-only 场景下 provider 仍尝试工具调用，runtime 会输出 `TOOL_CALL_SUPPRESSED_BY_USER_INTENT` 并注入一次 retry prompt，下一轮工具重新可见，模型仍坚持调用时允许执行。

## Watch: 真实会话 Context Blocking Recovery

> 样本：`session_1e2299be-b988-49ea-8819-587de8258172`。第一轮项目深度分析成功；第二轮继续深挖 runtime pipeline / AgentLoop 时，多次大文件 `Read` 让上下文估算达到 `194769/179616`，超过 blocking limit `178616`，runtime 在下一次 provider call 前 hard-block。provider fallback 没有 silent switch，blocking 保护正确；待优化点是恢复路径和 live tool output 预算。

本项核心恢复路径已收口，不再作为当前 P1 开发项。已落地能力包括：最小 regression fixture、provider-loop blocking path reactive compact、adaptive `Read` preview/range 策略、live `Read` aggregate budget、重复大文件读取诊断，以及 compact 后 retryable failed session 状态表达。

后续只在真实会话再次出现 context blocking recovery drift 时重新开未收口项；新项必须先补最小 fixture，再调整 runtime/context/TUI。

## 已收口 Runtime Core

Runtime pipeline 与 hooks 最小内核已收口：prompt parser、provider turn collector、execution metrics builder、provider tool input/message builder、terminal result/error event builder、context blocking helper、loop state / execution state helper、compact/reassemble state refresh helper、provider request assembly / loop guard helper、单 tool call execution helper 和 provider turn outcome reducer 已完成。后续只在真实重复分支继续出现时再补小 helper，避免一次性重写 `LLMCodingRuntime` 主循环。

自定义 hooks 不作为当前 P1：后续若要接入任意用户命令，必须先补用户配置解析、命令 sandbox/permission、输出预算和审计回归；当前只允许配置内置 hook 启停与 timeout 覆盖。

## 已收口 Context / Recovery Follow-ups

Session Memory Lite 后台队列、extractive-only 成本策略、更新诊断和 CLI/API 可见状态已收口；若后续需要接入真实 summary provider，再补显式授权与成本回归。retained segment / resume 的 retained tail、boundary anchor、first/last event identity、hash mismatch、recovery code 和 CLI/API 展示一致性基础回归已收口，后续只在真实漂移出现时补最小 fixture。

`thinking_delta` 当前策略仍以防污染为优先：历史 thinking 不回放给 provider，DeepSeek live reasoning 只在 tool result 续轮回放真实 reasoning；若长任务暴露规划连续性问题，再按真实样本重新评估。

## 已收口 Context: Cache-aware Compact / 长上下文利用

当前 cache-aware compact policy、adaptive context ceiling、runtime auto compact 口径、provider loop guard、`/context` cache economics 诊断以及 benchmark/runtime metrics follow-up 已落地；`BABEL_O_MAX_CONTEXT_TOKENS` 仍作为硬上限并会在 `/context` reason 中说明。

若真实 provider drift 暴露 cache policy 误判，再补最小 fixture；现有回归已覆盖高 cache-read 不早 compact、大上下文模型突破旧 120k ceiling、env hard cap、provider context error 保守 compact、`/context` reason 输出，以及 first-token/cacheRead/cacheCreation/summary latency/effective ceiling 性能诊断写入。

## 已收口 Context Token Estimator — 校准增强

> 历史实施事实已归档到 [DONE.md](../DONE.md)，后续规范化规划见 [context-and-subagent-upgrade-plan.md](../reference/context-and-subagent-upgrade-plan.md)。

Provider 偏差校准基础已收口：50K JSON schema、10K 中文、长 tool_result、DeepSeek reasoning、provider tool schema overhead、conservative buffer 与 context blocking 口径已覆盖。`LLMCodingRuntime` provider-call-before blocking guard 与 `analyzeContext()` 已默认使用 conservative 估算。后续 provider 偏差校准只在真实 drift 出现时补最小 fixture；多模态动态 patch count 仍作为未来接口预留。

## 已收口 Compact 完整化 — 机制增强

> 历史实施事实已归档到 [DONE.md](../DONE.md)，后续规范化规划见 [context-and-subagent-upgrade-plan.md](../reference/context-and-subagent-upgrade-plan.md)。

### Compact 后状态重建

当前 compact post-restore 增强和 focused recovery fixture 已收口；若后续真实会话出现恢复漂移，再补最小回归。

### /context 诊断命令

当前 `/context` 诊断增强和展示一致性回归已收口；若后续真实会话出现展示漂移，再补最小回归。

## 已归档 Tool Discovery / Targeted Reading 第一阶段

Tool Discovery / Targeted Reading 第一阶段已归档到 [DONE.md](../DONE.md)：`ListDir` 已在后续工具边界切片中作为正交目录 inventory 工具落地；`Glob` 用于 path pattern discovery，`Grep` 用于 content locating，`Read` preview / truncated result / repeat ledger 引导 targeted range 读取，避免重复灌入大文件。

## P2 Tool Granularity / Evidence-grounded Reading

> 详细规划见 [tool-granularity-and-evidence-governance-plan.md](../reference/tool-granularity-and-evidence-governance-plan.md)。本项承接“工具职责应正交细分但避免重复命名”的治理结论：`ListDir` 已落地为 bounded directory inventory；`Glob` / `Grep` / `Read` 分别限定为 path pattern discovery、content locating、source understanding；不新增与 `Grep` 重叠的 `Search`，不新增 `define_subagent` / `invoke_subagent`。

Phase B.5 已收口：`Grep` 优先使用 optional bundled ripgrep（`@vscode/ripgrep`），其次使用系统 `rg`，最后才使用 JavaScript `RegExp` fallback；schema 显式支持 `pathMatches` glob 过滤，fallback 支持基础 regex alternation，并为 fallback mode、no-result 与 invalid-regex 返回明确 diagnostics；focused regression 覆盖 `ContextForker|forkContext|contextFork`。
Phase B.6 已收口：Bash 普通 command timeout / SIGTERM 已返回 recoverable `tool_completed(success=false)`，输出结构化 `COMMAND_TIMEOUT`、`timedOut`、`signal`、stdout/stderr 摘要与 command summary，不再把普通 shell timeout 作为 session fatal；外部 request abort 仍保留 runtime cancellation path，不被 Bash timeout recovery 吞掉。
Phase B.7 已收口：新增 Bash-as-file-discovery guidance，`ls`/`ls -R`/`find`/`tree`/`grep -r`/`rg` 这类只读 discovery 命令会在 Bash tool result 中追加 `BASH_AS_FILE_DISCOVERY` structured guidance，提示优先使用 `ListDir` / `Glob` / `Grep` / `Read`；classifier 对 `find`、`tree`、recursive grep/ls、`rg` 等 broad discovery 命令返回 manual-review reason 并包含同一替代工具提示，普通 `ls` 保持既有低风险执行但仍输出 guidance。
- [ ] Phase C: Source Coverage Ledger / Strong Claim Guard 轻量诊断评估。
  - 仅在真实会话继续暴露 evidence scope drift 时推进；避免过早引入复杂审计系统。
- [ ] Phase E（Watch）: tool result evidence hint 评估。
  - 如继续出现模型把 `ListDir` / `Glob` / `Grep` / partial `Read` 证据过度扩张为强声明，再评估在结果渲染或 diagnostics 中增加 `directory-inventory`、`locator-only`、`partial-read`、`full-read` 等轻量标签。

## 已收口 P1 Context Manager / ContextForker 规范化

> 统一规划见 [context-and-subagent-upgrade-plan.md](../reference/context-and-subagent-upgrade-plan.md)。现有上下文能力已较强，后续重点不是重写，而是显式化 pipeline、统一 ContextItem/ScoredContextItem/SelectedContextItem 抽象、增加 ContextForker，并让 `/context` 能解释 retained/dropped reason。

当前最小规范化切片已收口：`src/runtime/contextManager.ts` 定义 Context Manager phase、`ContextItem` / `ScoredContextItem` / `SelectedContextItem` 与 selection diagnostics；`assembleContext()` 保留既有 recent event selection、tool-pair protection、omitted-event selection 行为，只额外输出 retained/dropped diagnostics；`analyzeContext()`、HTTP context API 与 CLI `/context` 已展示 retained/dropped item 数量、reason、estimated tokens、working set paths 与 compact boundary。

ContextForker 多模式也已收口：`minimal` 保留 Explore Agent 只读聚焦语义；`working-set`、`task-focused`、`full-summary` 与 `debug-replay` 已能按 active paths、近期用户关注、任务/失败/权限上下文、compact summary 与 child-agent result 生成 child prompt。AgentScheduler 会把 fork diagnostics 写入 child session metadata，HTTP context API 与 CLI `/context` 已展示 fork mode、inherited/omitted item 数量和 child-agent context 继承情况。

## 已收口 Context: Working Set

> 历史实施事实已归档到 [DONE.md](../DONE.md)，后续 ContextForker / AgentScheduler 复用规划见 [context-and-subagent-upgrade-plan.md](../reference/context-and-subagent-upgrade-plan.md)。

`src/runtime/workingSet.ts` 已落地：从 `user_message` 与 tool input JSON 提取路径，按 touches/recency 选择最多 16 个 entry，并以 byte-stable 顺序注入 `buildSystemPromptSections()` 的 non-cacheable working set block。后续复用方向是 ContextForker / AgentScheduler，不再把 Working Set 本身作为待办项。

## 已收口 Context: Prefix Cache 稳定性策略

Prefix Cache 稳定性地基已落地：`src/runtime/prefixCache.ts` 计算 cacheable immutable prefix 字符占比、SHA-256 fingerprint（cacheable system text + sorted tool names）和 volatile-content-last invariant；provider request assembly 复用同一 system prompt block 顺序，并把 execution state 作为 non-cacheable suffix。`execution_metrics`、storage、`/v1/runtime/metrics` 与 `/v1/runtime/status` 已暴露 prefix cache diagnostics；focused 回归覆盖 fingerprint 稳定性、prompt block 顺序不变量与 runtime/status 聚合。

## 已收口 TUI: Path Mention / Completer

Path Mention 已在 CLI/TUI 层收口：`src/cli/pathMention.ts` 提供 lazy `WorkspacePathIndex`、fuzzy basename/path 匹配、50K entry cap、dot-dir 可发现与 dependency/build 目录跳过策略；`makeCompleter()` 只在 `@` mention 或路径分隔符 token 中触发路径补全，Runtime 侧继续只消费显式路径和 Working Set。`test/path-mention.test.ts` 已覆盖 lazy index、dot-dir、workspace escape、URL 排除和 entry cap，并纳入默认 `npm test`。

## 已收口 P2 Hook Lifecycle / Invocation Diagnostics

Provider invocation 粒度 hook 已落地：`RuntimeHookInput.invocation` 记录 provider/model、loop/maxLoops、role、context estimate/max/percent、tool/visible tool count、cache preservation、final-response-only、duration、success、errorCode 和 provider recovery failureKind；`InvocationDiagnosticsHook` 作为内置 hook 复用现有 `hook_started` / `hook_completed` / `hook_failed` 事件，不新增独立 diagnostics vocabulary。`LLMCodingRuntime` 在每次 provider call 前后发出 `PreInvocation` / `PostInvocation`，失败路径先发 `PostInvocation(success=false)` 再交回既有 provider recovery/error path。当前仍不开放任意用户 shell hook；若未来允许自定义命令，必须先补 sandbox/permission/output budget/audit 回归。

## P2 Architecture Boundary

Permission pending state 持久 backend 评估已收口：当前不实现 SQLite / Nexus-owned pending permission backend。现有 `PendingPermissionRegistry` / `PendingPermissionBackend` seam 的真实语义是 process-live resolver registry：它保存 `Promise` resolver，让同一进程内正在等待的 runtime tool loop 继续执行。

评估结论：只把 pending permission entry 写入 SQLite 会造成“看似可恢复、实际无法恢复”的假持久化。原因是 HTTP/WS `/v1/execute` 与 embedded local flow 都把执行悬挂在当前进程的 async iterator / pending promise 上；`permission_request` event 与 permission audit 可持久化，但进程重启后没有可恢复的 provider/tool-loop continuation，也无法安全重放已准备执行的 tool call。真正的 durable permission backend 必须先定义 resumable execution 语义：session phase 进入 `waiting_permission`、pending tool call snapshot、approval metadata、permission response event/audit 写入、resume/timeout/cancel 状态机，以及重启后如何继续或显式失败。

当前口径：

- embedded local 与 Nexus-only 两种运行模式继续保持清晰边界；service mode 经 HTTP/WS `NexusClient`，embedded mode 经 `createEmbeddedNexusClient()` 复用 `createNexusApp().inject()`；`chat.ts` 不直接 import SQLite storage、session lifecycle、compact/context runtime internals。
- `PendingPermissionRegistry` 保持 process-local backend seam，用于同进程审批、timeout sweep、session close cleanup 与测试替换 backend。
- 若未来出现真实多进程 service/CLI 权限状态同步需求，先开 resumable execution / durable pending permission 设计项，不单独落地 SQLite backend。

## P2 Execution Environments

Remote runner v1 已收口到最小可测传输层：`RemoteToolRunner` / `NoopRemoteToolRunner`、`InMemoryRemoteToolRunner` test-double、`HttpRemoteToolRunner`、`createRemoteToolRunnerServer()`、capability validation、cancel/timeout best-effort、permission-before-dispatch、deny-no-dispatch、audit parity 和 ExecutionGate 容量回归均已落地。

当前安全口径：权限审批全部在 Nexus 侧完成；runner 不弹用户审批，不写 permission audit，不决定权限。v1 协议尚未携带独立 approval metadata，因此 runner 侧不承诺二次验证 approval metadata；安全边界由 Nexus 的 permission-before-dispatch、capability validation、allowedPaths、deadline/cancel 和 audit 保障。

后续未收口项只保留真实需求驱动：

- [ ] remote runner approval metadata 二次校验。
  - 若未来 runner 需要独立拒绝未授权请求，应先扩展 `RemoteToolRunnerExecuteRequest`，加入 signed/opaque approval metadata，并补 HTTP runner server 校验与 replay/expiry 测试。
- [ ] remote runner 跨机器部署、调度、文件同步或 remote provider loop。
  - 当前明确 non-goals：不做 remote provider loop、不做 remote session storage、不开放任意用户 shell hook、不做 MCP federation、不做跨 runner 调度或文件同步协议。
  - 可选 Go Runner 只允许作为单 runner 执行后端接入现有 `RemoteToolRunner` 协议；不得演化成新的 agent transport、provider loop 或 session owner。

### P2 Optional Go Remote Runner

> 详细规划见 [go-runner-plan.md](../reference/go-runner-plan.md)。Go Runner 的定位是执行层增强：TypeScript Nexus 决定做什么，Go 只安全高效地执行已经批准的动作。它不替代 Context Manager、AgentScheduler、provider adapter、权限决策或 CLI/TUI。

Phase A protocol compatibility spike 已收口：`runners/go-runner/` 已提供兼容 `RemoteToolRunner` 的最小 HTTP server，支持 capabilities、Noop execute、cancel、protocol version validation、request id tracking、structured result/error；TypeScript optional smoke 通过 `BABEL_O_RUN_GO_RUNNER_SMOKE=1` 显式启用，默认不要求 Go toolchain。

Phase B read-only backend 已收口：Go Runner capabilities 切换为 `Read` / `Grep` / `Glob`，`internal/tools` 纯 Go 实现 cwd/allowedPaths、workspace escape/symlink escape 拒绝、Read offset/limit/preview/truncation、Grep regexp scan、Glob stable sorted match、依赖/build 目录跳过、输出预算与 context cancel/timeout；Go tests 与 gated TS smoke 已覆盖主路径和安全边界。

Nexus 侧可选配置与降级已收口：`NEXUS_REMOTE_RUNNER_URL` / `NEXUS_REMOTE_RUNNER_REQUIRED` 显式启用 HTTP remote runner，默认不启用；service mode 与 embedded mode 均会查询 capabilities、校验 protocol version、构造 `HttpRemoteToolRunner`，`required=1` 且不可用时 fail fast；`GET /v1/runtime/status` 暴露 redacted URL、id、capabilities、healthy 与失败原因。

Go Runner 安全默认值已收口：默认绑定 `127.0.0.1`，非 loopback 绑定必须显式设置 `GO_RUNNER_ALLOW_NON_LOCAL_BIND=1`；Bash/Write/Edit 默认 disabled，capabilities 暴露 read-only 与 concurrency/output/deadline limits；server 侧对输出预算、默认/最大 deadline 和并发执行数做硬上限，provider API keys/env forwarding 仍不进入协议。

Phase C restricted Bash 已收口：`GO_RUNNER_ENABLE_BASH=1` 显式开启后 capabilities 才包含 `Bash`；Nexus 仍负责权限审批、risk classification、hook/audit 与命令策略，Go 仅执行已批准命令并提供 process group cancel/timeout、stdout/stderr 分离、输出预算、exit code/signal/duration 结构化返回和 env allowlist。

Phase D implement/worktree execution backend 已收口：`GO_RUNNER_ENABLE_WRITE=1` 显式开启后 capabilities 才包含 `Write` / `Edit`；Nexus 仍创建/合并/拒绝 worktree，并在 isolated executor/critic 步骤中把 `allowedPaths` 缩到 Nexus 创建的 worktree。`RuntimeAgentStep` 会把 `executionEnvironment: remote`、remote runner、step cwd 和 allowed paths 传入 runtime 与 structured-output repair retry；`bbl optimize --execution-environment remote` 可显式选择远程工具执行，默认仍是 local。

后续 Go Runner 小节只保留真实需求驱动：

- [ ] Optional expanded smoke / tests。
  - TypeScript 集成 smoke 通过 `BABEL_O_RUN_GO_RUNNER_SMOKE=1` 显式启用；默认 `npm test` 不要求 Go binary。
  - 已覆盖 capabilities、Read/Grep/Glob、Bash、Write/Edit、workspace escape 与 protocol mismatch；后续如增加 runner 部署形态，再补部署/认证相关 smoke。

## P3 Long-Term Memory / EverCore Integration

> 参考规划：`/Users/tangyaoyue/DEV/EverOS/docs/babel-o-evercore-integration-plan.md`。当前只登记远期计划，不进入实现阶段；先完成 P1 Context Manager / AgentScheduler 规范化与 P2 context foundation，再启动 EverCore REST spike。

- [ ] Phase A: REST Spike。
  - 新增可选 EverCore REST client，支持 search、add agent messages、flush agent session。
  - behind config flag，默认 disabled；EverCore 不可达时 BabeL-O 主流程不失败。
  - 不改变 BabeL-O SQLite/session/event/tool trace 事实源。
- [ ] Phase B: Internal MemoryProvider。
  - 抽象 `MemoryProvider` / `NoopMemoryProvider` / `EverCoreMemoryProvider`。
  - context assembler 可注入长期语义记忆 block，但必须作为 volatile context，不进入 immutable prefix。
  - session lifecycle 可在 session end 上传摘要 trajectory，不上传大段原始源码或工具输出。
- [ ] Phase C: Context Budget / Diagnostics。
  - 为 EverCore memory block 设置独立 char/token budget、命中数量、检索耗时、截断和 lastError 诊断。
  - `/context` 展示 EverCore enabled/baseUrl redacted/searchLatency/hitCount/injectedChars/truncated。
  - secret redaction、per-project opt-out 和失败降级必须先于默认开启。
- [ ] Phase D: Optional MCP Tools。
  - 仅在 REST path 与 MemoryProvider 稳定后，再考虑 memory_search / memory_save_note / memory_flush_session 等 MCP tool。
  - MCP 只用于模型或用户主动操作，不承担每轮自动检索或 session end 上传。

## 验证命令

历史验证命令包括 `npm run typecheck`、`npm test`、`npm run cli -- run "hello"`、`npm run cli -- run --url http://127.0.0.1:3000 "bash pwd"`、`npm run cli -- --help` 与 `npm run benchmark`。当前默认 `npm test` 已覆盖 token estimator、blocking limit、microcompact、compact post-restore、context command、working set、prefix cache、path mention、tool result budget 与 Runtime context API/display 回归。

## 参考文件

- `docs/nexus/reference/context-and-subagent-upgrade-plan.md` — 上下文规范化、ContextForker 与模型可见 AgentScheduler 统一升级规划
- `src/nexus/app.ts`
- `src/nexus/server.ts`
- `src/nexus/createRuntime.ts`
- `src/runtime/Runtime.ts`
- `src/runtime/LocalCodingRuntime.ts`
- `src/runtime/LLMCodingRuntime.ts`
- `src/runtime/tokenEstimator.ts`
- `src/runtime/contextAssembler.ts`
- `src/runtime/compact.ts`
- `src/runtime/compactSummary.ts`
- `src/runtime/compactors/snipCompactor.ts`
- `src/runtime/sessionMemoryLite.ts`
- `src/runtime/systemPromptBuilder.ts`
- `src/storage/Storage.ts`
- `src/storage/MemoryStorage.ts`
- `src/storage/SqliteStorage.ts`
