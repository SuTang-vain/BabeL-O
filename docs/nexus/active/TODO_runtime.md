# TODO Runtime / Nexus

## 目标

Nexus 是 BabeL-O 的执行核心。这里只保留仍未收口的 runtime / API / storage / security / context / compact / permissions 任务。已完成的大项见 [DONE.md](../DONE.md)。

## 当前状态

- `GET /v1/runtime/status`、`/v1/runtime/provider-smoke`、`/v1/runtime/provider-smoke/live`、`/v1/sessions/:sessionId/context`、`/v1/sessions/:sessionId/assets`、`/compact`、`/context`、Session Memory Lite 第一版、provider recovery、DeepSeek reasoning replay、hooks 最小内核都已落地。
- Context token estimator conservative mode、blocking limit、auto/manual compact、retained segment、User Intake Guidance、final-response-only、provider protocol regression corpus、统一 diagnostics object、runtime pipeline 最小 seam、tool loop/result aggregator seam、tool loop execution helper、provider turn outcome reducer、context blocking helper、loop state / execution state helper、compact/reassemble state refresh helper 和 provider request assembly / loop guard helper 都已进入可验证状态。
- 真实会话守门继续采用 regression-first：intake 失败时身份/能力短问、上下文记忆短追问已覆盖为 respond-only fallback；`session_93052ea7-8346-40a9-8175-db941312778c` 暴露的 provider 协议污染 assistant 文本已补 Tool-call Text Leakage 回归守门；测试进程写真实 provider config 的污染事故已补中心化 guard 与回归；`session_9d985c5c-7c89-41b8-9d5e-cc672e412f00` 暴露的 current-turn finalization 污染已补最小 regression 并修复。后续仍按真实漂移先补最小回归再修 runtime/config/adapter/TUI。
- `session_ee116547-6545-4f70-bc7c-b1b287387cda` 暴露的 recoverable tool error / session continuity drift 已收口：`Grep` dash-leading pattern 加 `--` separator；generic thrown tool errors 改为 provider-visible paired `tool_result is_error=true`；`Write` / `Edit` / `Glob` / `TaskCreate` / `context*` / `WebSearch` 常见可修正失败返回结构化 `success=false` code。后续只在真实样本证明 latest recoverable failure 没有进入 context diagnostics / recovery boundary 时再开 Phase D。
- `session_1e2299be-b988-49ea-8819-587de8258172` 暴露真实会话在大量 `Read` 后第二轮 provider call 前触发 context blocking；P1 已补 provider-loop reactive compact、adaptive `Read` preview/range 策略、live `Read` aggregate budget、embedded metrics side-table 持久化和 retryable failed session 恢复状态表达。后续只保留重复大文件读取诊断与 P2 targeted reading 地基。
- 除上述真实会话回归外，后续阶段仍保留架构收口、权限细化和执行入口升级。

## P0 Session Replay / Evidence Governance

> 详细规划见 [evidence-and-runtime-history.md](../history/evidence-and-runtime-history.md)。真实样本：`session_315814e7-3b82-4a31-8601-a5b383288e9c`；用户要求确认 memory capability 文档收口时，模型把真实 G1-G6 结构错答成 L0-L7，随后在用户要求分析“你出现的问题”时又漂移成项目功能评估，最终 provider replay 因 `tool_completed` / `tool_started` 同毫秒乱序生成 orphan `tool_result`，MiniMax 返回 `tool result's tool id ... not found`。

打开项按 regression-first 排序：

- [x] Phase A — P0 event ordering / provider replay safety：SQLite events 已增加 `event_seq` append-order column、migration/backfill、duplicate repair、`(session_id,event_seq)` unique index 与 `BEGIN IMMEDIATE` append transaction；新 event key 使用 append seq + content digest，避免 same-ms / same-type collision；`listEvents` / `listSessions(includeEvents)` / sync list 全部按 `event_seq` 排序；`mapEventsToMessages()` 能修复 completed-before-started tool pair；OpenAI-compatible 与 Anthropic-compatible（含 MiniMax）adapter 都会在 fetch 前拒绝 orphan / duplicate tool result。验证：`test/storage.test.ts`、`test/runtime-llm.test.ts`、`test/adapters.test.ts` focused regression。
- [x] Phase B — P0 Read evidence coverage / cache contract：`readFileCache` 已升级为 coverage-aware ranges；partial / offset-limited Read 不再拦截后续 full Read；preview range 不再满足 non-preview 读取；重复 full-file / exact byte-range Read 只在覆盖完整、非 truncated 且 provider-visible 时返回 coverage stub，文案显式标注 requested byte range 与原 Read call。验证：`test/runtime.test.ts` partial→full / full→same / preview→non-preview focused regression。
- [x] Phase C — P1 Read line semantics / targeted source evidence：`Read` 已新增 `lineOffset` / `lineLimit` 源码行范围读取，以及显式 `byteOffset` / `byteLimit` byte window；旧 `offset` / `limit` 作为 deprecated byte alias 保留但输出诊断；Read 输出统一标注 `shownBytes` 与 `shownLines`。验证：`test/read-tool.test.ts`、`test/runtime.test.ts` focused regression。
- [x] Phase D — P1 tool input parse / schema ergonomics：`Grep` 的 `pathMatches` 支持单 glob 或 multi-glob array，prompt 明示不要重复 JSON key；boolean-string 校验覆盖数组值；`resolveProviderToolCallInput()` 对 malformed `partialInput` 统一返回 `_parseError` sentinel，malformed provider tool input 现在产出 synthetic `tool_started` → `tool_completed(success=false)` pair，并返回 `TOOL_INPUT_PARSE_ERROR` + schema repair hint。验证：`test/grep-tool.test.ts`、`test/runtime-llm.test.ts`、`test/runtime.test.ts` focused regression。
- [x] Phase E — P1 intent target binding：User Intake Guidance 已增加可持久化 `problemTarget`（`agent_failure` / `runtime_replay` / `tool_evidence` / `project_feature` / `user_artifact` / `unknown`）；fallback 与模型 intake 输出都会经过本地 reconcile。provider-visible 注入已从动态自然语言 guidance 改为结构化 `Turn Policy`（`responseMode` / `toolMode` / `evidenceMode` / `staleTaskMode`），新写入的 `user_intake_guidance` 事件也不再持久化自然语言 `guidance` payload；历史 `guidance` 字段仅作为 optional 兼容读取。自诊断链路通过 `problemTarget=agent_failure` + `evidenceMode=verify_before_claim` + `staleTaskMode=background_only` 锁住行为路径，不再依赖硬编码中文/英文提示词。验证：`test/runtime-llm.test.ts`、`test/context-assembler.test.ts` focused regression。
- [x] Phase F — P1 timeout convergence：`near_timeout_warning`、`timeout_budget_exceeded` 与 `timeout_extension_granted` 在 provider replay 中会转成 model-visible convergence constraint，要求不要继续 broad discovery，只能基于已验证证据回答或最多做一次明确有界 final check，并标注未验证结论。验证：`test/runtime-llm.test.ts` focused `mapEventsToMessages` regression。
- [x] Phase G — P2 capability and self-diagnosis answer governance：记忆能力问答已有三层护栏（capability block、intake fallback、runtime leakage suppression），中文“你当前能否写入记忆？”不默认暴露 source path / commit / MCP / sidecar；自我诊断不再通过动态固定段落 prompt 注入实现，而是由静态 `Turn Policy` 解释 + `problemTarget=agent_failure` + `evidenceMode=verify_before_claim` 驱动，要求主模型先验证 session/source/tool evidence 再把结论当事实，并区分 verified observations、code-confirmed causes 与 hypotheses。验证：`test/runtime-llm.test.ts`、`test/context-assembler.test.ts`、`test/system-prompt-builder.test.ts` focused regression。
- [x] Phase H — wrapped/split path normalization：`extractAbsolutePaths()` 现在会先受限归一化 terminal-wrapped path fragments，支持 `word\n  -suffix.md` / `word\n_suffix.md` 这类路径换行拼接，同时避免普通 prose bullet paragraph 被合并。验证：`test/system-prompt-builder.test.ts`、`test/context-assembler.test.ts` focused regression。

收口标准：真实 session fixture 能复现并防住 partial Read → false full evidence、same-ms tool pair replay mismatch、agent self-diagnosis target drift 三类问题；provider request validation 证明不会再发送 orphan tool result；中文 capability/self-diagnosis prompt 有 focused regression。

## 已收口 P1 Task-adaptive Recoverable Timeout

> 详细规划见 [Task-adaptive Recoverable Timeout 规划](../history/evidence-and-runtime-history.md)。真实样本：`session_791b10ce-0d41-409d-b2de-1e5d14eb19b3`；用户请求“查看当前项目分析潜在的bug”，session 在 180s 顶层 cutoff 时仍在推进，最后一个已获批 Bash 未完成，最终 `REQUEST_TIMEOUT` 直接终止 workflow。
>
> 全部 Phase 0~6 已落地，DONE 索引见 [DONE.md](../DONE.md) "Task-adaptive Recoverable Timeout 已落地" 行。规划文档同步保留，旧 [go-tui-tool-permission-timeout-optimization-plan.md](../archive/go-tui-tool-permission-timeout-optimization-plan.md) 已加 "降噪 vs fatal timeout 语义" 范围拆分提示。后续真实样本若再次暴露 fatal-style cutoff drift 才重新开未收口项；目前不再作为打开项跟踪。

收口要点：

- 协议：`executeSchema` 新增 `timeoutPolicy` / `softTimeoutMs` / `watchdogTimeoutMs` / `maxSoftTimeoutExtensions` / `softTimeoutExtensionMs`；fatal back-compat 客户端不传新字段时行为完全不变。
- 事件：`timeout_budget_exceeded` + `timeout_extension_granted` 全部进入 `NexusEventSchema` 联合类型；soft policy + watchdog 触发的 `REQUEST_TIMEOUT` 由 `maybeDecorateWatchdogError()` 加 `details.kind='watchdog'` 等结构化字段。
- Runtime：`scheduleSoftTimeoutCycle()` 在 HTTP `/v1/execute` 与 WS `/v1/stream` wire；hard watchdog 仍是唯一 abort 源，软周期永远不调 `abortController`；`activeExecutions` 清理回归证明 watchdog 触发后 registry 已 clean。
- Go TUI：opt-in `timeoutPolicy='soft'` payload；`softTimeoutSnapshot` model state 与 `formatSoftTimeoutFooter()` 状态行；`friendlyNexusErrorWithContext` 接受 server `details.kind='watchdog'` 标记或 snapshot 两种入口，明确拒绝建议提高 `--execute-timeout-ms`。
- 验证：`NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test test/runtime.test.ts test/go-tui-tool-permission-timeout-regression.test.ts`（125/125 pass）；`cd clients/go-tui && go test ./internal/tui`（全部 pass）；`npx tsc --noEmit`（clean）。

## 已收口 P0 Current-turn Session Finalization Regression

> 样本：`session_9d985c5c-7c89-41b8-9d5e-cc672e412f00`。第三轮用户请求已经写入 `user_message` / `session_started` / PreInvocation / `usage` / `thinking_delta`，但没有当前轮 `assistant_delta`、PostInvocation、`result`、`error` 或 `execution_metrics`；session 最终仍被标记为 `completed`，并继承上一轮 result。
>
> 详细规划见 [evidence-and-runtime-history.md](../history/evidence-and-runtime-history.md)。

本项已按 P0 regression-first 收口：`resolveFinalSessionOutcome()` 增加 current request boundary regression，`runSessionFlow()` 改为只使用当前轮 `executeStream()` 产出的 events 做 finalization，不再回扫整段 session 旧 terminal event；新一轮开始会清空旧 `result` / `error` / `terminalReason`，当前轮无 terminal event 时保存 `failed` 与 `REQUEST_INTERRUPTED_WITHOUT_TERMINAL_EVENT` 诊断，用户取消仍保存 `cancelled`。

后续若真实 provider stream 中断继续出现缺失 PostInvocation / execution_metrics 的稳定样本，再单独开 runtime/provider partial invocation terminalization 项；当前 P0 先完成 session state correctness 守门。

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

## P0 session_10320709-2b06-405f-8f51-d954435d4a70 跟进项 — 4 Bug 修复追踪（§12 初判 + §13 二次复盘修正）

> 样本：`session_10320709-2b06-405f-8f51-d954435d4a70`。真实 Nexus session，SQLite event storage 有 15914 行，权限审计可写，但 `contextSearch` / `contextRecent` 在 LLMCodingRuntime/Nexus 热路径仍拿不到 `context.storage`（3 次 `CONTEXT_STORAGE_UNAVAILABLE` 失败：event_seq 10050 / 15072 / 15103）；同时 6 个 turn 全部跑在 cwd `/Users/tangyaoyue/Library`（被 iCloud 路径污染，且跨 turn 2-6 持续）；0 个 `session_root_continuity` event。§12 初判 3 bug，§13 二次复盘（直接读 SQLite events 表）修正为 4 bug + 提升优先级。详细分析见 [context-cwd-drift-and-recall-governance-plan.md §12 + §13](../reference/context-cwd-drift-and-recall-governance-plan.md)。

**§13 二次复盘新增的关键证据**（修正 §12 判断）：

- 真实 prompt 用**普通空格**（`Mobile Documents`，非 `\ ` shell escape）→ Phase A Follow-up ④ 的 SPACE_MARK 哨兵修了错误目标。
- **一条 iCloud 路径拆成 2 candidate**：`/Users/.../Library/Mobile`（→ cwd 漂移源）+ `/com~apple~CloudDocs/家人共享/上百个Agent`（→ 进 `task_scope_declared.explicitRoots` seq=4 成为垃圾 explicitRoot）。
- `/Users/tangyaoyue/Library/Mobile` **不存在**（`existsSync` 验证），`~/Library` 存在 → Site A `resolveExplicitPromptCwd`（app.ts）正确拒绝但 Site B `resolveCwdFromPrompt`（runtime）dirname 兜底接受 `~/Library` → **两 resolution site 不一致** = Bug 4。
- **drift 跨 turn 2-6 持续**：turn 2-6 prompt 完全无路径却仍跑在 `~/Library`；turn 7 用户重述项目内路径 `在/Users/tangyaoyue/DEV/BABEL/BabeL-O/docs/nexus中...` 自愈（seq=14509 cwd=`docs/nexus`）。
- **下游损害**：8 GLOB_FAILED（ripgrep 撞 `~/Library/Caches` 权限拒绝整段失败，非 partial）+ 3 scope_boundary parent_scan + 6 WEB_SEARCH_FAILED（独立网络问题）+ 1 幻觉路径拼接（seq=4786）+ turn 1 contextCharsIn=992400（≈250k tokens）浪费。

**4 个 bug 修复追踪**（按 P0 → P1 排序，§13 修正后）：

- [x] **Bug 1 Layer A [P0，§13 提升优先级]** — `extractAbsolutePaths` quote-delimited span 优先识别（plan §13.3）。✅ 收口（2026-06-18）：`src/runtime/systemPromptBuilder.ts` 新增 `extractAndBlankQuotedRealPaths()` 在 pathPattern 之前抽取 `'...'`/`"..."`/backtick 平衡 span，实存则整段加入 candidates 并 blank 掉原 span（防止 pathPattern 在普通空格 + CJK 标点处切断 emit 破碎 fragment）。`test/system-prompt-builder.test.ts` 35→39（+4 Layer A test）。真实 prompt 验证：`/Users/.../Library/Mobile` → 整段 iCloud 文件路径。
  - 症状：cwd 漂 `~/Library` + 垃圾 explicitRoot `/com~apple~CloudDocs/...` + 跨 turn 持续 + 8 GLOB_FAILED + 3 parent_scan + 992k context 浪费。
  - 根因：pathPattern 在普通空格处切断 iCloud 路径（路径在单引号 `'...'` 内，但 pathPattern 仍在引号内的空格处停）。
  - 修法：在 pathPattern 之前先抽取 `'...'` / `"..."` / backtick 内容，整段 `existsSync` true 或 `resolvePromptPath` 命中实存 prefix → 作为单一 candidate 加入，绕过空格切断。
  - 验证：`test/system-prompt-builder.test.ts` +4 个 test（quoted iCloud path 整段提取 / 双引号 / backtick / 混入 prose 不误合并）。
  - 估算：~15 行 code + 4 test。**最优先**——修根因，阻断整条 drift 链。

- [x] **Bug 1 Layer B [P0]** — 共享 `isAcceptablePromptCwd` 守卫在 Site A+B 拦系统目录（plan §13.3）。✅ 收口（2026-06-18）：`src/runtime/systemPromptBuilder.ts` 新增 export `isAcceptablePromptCwd(p)`（reject `/`/`/Users`/homedir/`dirname(homedir)`/`~/Library`/`~/Documents`/`~/Desktop`/`~/Downloads`/`~/Applications`）；`LLMCodingRuntime.ts:resolveCwdFromPrompt` Site B 的 3 个 return 点 + `app.ts:resolveExplicitPromptCwd` Site A 的 isDirectory 分支都加守卫。新文件 `test/resolve-cwd-fallback.test.ts` 10 test（5 vocabulary + 5 Site B 拒绝场景）。真实验证：broken `/Mobile` fragment / 直接 `~/Library` / 直接 `~/Documents` 都不漂，real internal dir 仍正常 resolve。
  - 修法：新增纯函数 `isAcceptablePromptCwd(p)` 拒绝 homedir / `~/Library` / `~/Documents` / `~/Desktop` / `~/Downloads` / `/Users` / `/Users/<user>`；`resolveExplicitPromptCwd`（app.ts Site A）与 `resolveCwdFromPrompt`（runtime Site B）返回前都过这个守卫。
  - 验证：`test/resolve-cwd-fallback.test.ts` +3 个 test（`~/Library` / `~/Documents` / homedir 拒绝；project root 通过）。
  - 估算：~10 行 code + 3 test。Layer A 漏网时的 defense-in-depth。

- [x] **Bug 3 [P0]** — `LLMCodingRuntime.runExecuteStreamInner` 起手缺 `options = { ...options, storage: this.storage }` 注入（plan §11 / §12.3）。✅ 收口（2026-06-18，Phase C2）：3 个接线点全注入——① `LLMCodingRuntime.runExecuteStreamInner` 起手 `if (!options.storage && this.storage) options = { ...options, storage: this.storage }`（镜像 `LocalCodingRuntime.ts:170-172`）；② `app.ts` HTTP + WS 两条 `executeStream` 调用点各加 `storage: options.storage`；③ `runtimeToolLoop.ts` `executeProviderToolCall` 在 `executeToolSafely` 之前 defensive merge `runtimeOptions.storage ?? options.storage`。新文件 `test/runtime-storage-propagation.test.ts` 5 test（含 session_10320709 精确场景：runtimeOptions.storage 省略 + side-channel storage 提供 → contextRecent/contextSearch 不返回 CONTEXT_STORAGE_UNAVAILABLE）。临时 revert merge → 3 test 失败；restore → 5/5 pass，证明 test 精确锁住注入点。
  - 症状：session_10320709 的 3 个 `CONTEXT_STORAGE_UNAVAILABLE`（event_seq 10050 / 15072 / 15103）。
  - 根因：`executeToolSafely` → `tool.execute(input, { storage: options.storage })` 而 `options.storage === undefined`（对比 `LocalCodingRuntime.ts:170-172` 有 storage 注入）。
  - 修法：`src/runtime/LLMCodingRuntime.ts:runExecuteStreamInner` 起手段落 2 行。
  - 验证：`test/runtime-storage-propagation.test.ts` 5 个新 focused regression + `test/runtime.test.ts` 6 个 + `test/runtime-context-tools-registry-gate.test.ts` 4 个（共 15 个 regression test 守住 §11.5 全部失败点）。
  - 同时 `src/nexus/app.ts` HTTP/WS 两条 `executeStream` 调用点同步注入 `storage: options.storage`；`runtimeToolLoop` 在 `executeToolSafely` 之前 defensive merge `storage: runtimeOptions.storage ?? options.storage`。
  - 估算：~1 行 code + 5 行 wiring + 5 test。锁住 context tool 失败。

- [x] **Bug 2 + origin_cwd [P1，§13 修正]** — `src/nexus/app.ts:2695-2711` `executeStream` 没传 `storedSessionCwd` / `latestTaskPrimaryRoot` + `session.cwd` 本身已漂（plan §13.4）。✅ 收口（2026-06-18）：① `shared/session.ts` `SessionSnapshot` 增 `originCwd?` 字段；② `SqliteStorage` migration v15 加 `origin_cwd` 列 + backfill（无条件 `WHERE NULL`）+ `saveSession` ON CONFLICT **不**更新 origin_cwd（immutable）+ `sessionParams`/`rowToSession` 支持；③ `MemoryStorage` `saveSession` 保 originCwd 不被 clobber；④ `app.ts` 两创建点设 `originCwd=cwd` + `prepareExecution` 派生 `storedSessionCwd=originCwd ?? cwd` + `resolveLatestTaskPrimaryRoot` helper（`listEvents` desc 扫 task_scope_declared.primaryRoot）+ HTTP/WS executeStream 都传两字段。新文件 `test/session-origin-cwd.test.ts` 4 test（Memory + Sqlite immutability + v15 backfill）。**测试抓到真实 migration bug**：backfill 误嵌在 `if(!columns)` 里被跳过 → 修正为无条件。真实 db 副本验证 immutability + session_10320709 backfill。
  - 症状：session_10320709 的 0 个 `session_root_continuity` event。
  - 根因：`hasSessionContext` 永远 false；且 §13 发现 `session.cwd` 在 turn 1 就被 `app.ts:2301` 覆写成 drifted 值，单纯传 `session.cwd` 会传漂移值。
  - 修法：`sessions` 表新增不可变 `origin_cwd` 列（`createSessionSnapshot` 时从 launcher `body.cwd` 写入一次，不随 `session.cwd` 漂移）；`app.ts:2695` 传 `storedSessionCwd = session.origin_cwd` + `latestTaskPrimaryRoot`；emit `session_root_continuity_missing` diagnostic。
  - 验证：`test/nexus-runtime-wiring.test.ts` +3 个 test（origin_cwd 不随 drift 变 / continuity 用 origin_cwd 拉回 / HTTP+WS 接线）。
  - 估算：~20 行 code + 3 test。与 Bug 1 互补不替代。

- [x] **Bug 4 [P1，§13 新增]** — dual cwd resolution sites 不一致 + `session.cwd` 每 turn 覆写（plan §13.2）。✅ 收口（2026-06-18）：① `systemPromptBuilder.ts` 新增 `resolvePromptCwd` 单一共享 resolver（合并 Site B 的 dirname fallback + Layer B 守卫）；② `LLMCodingRuntime.ts:resolveCwdFromPrompt` Site B 改为 thin wrapper；③ `app.ts:resolveExplicitPromptCwd` Site A 改为 thin wrapper（sentinel 模式保 `undefined` 契约）；④ `cli/runSessionFlow.ts:resolveExplicitPromptCwd` 第三个副本也合并到 shared resolver；⑤ `app.ts:prepareExecution` `session.cwd` 改用 `trustedSessionCwd = body.cwd ?? session?.originCwd ?? session?.cwd ?? cwd` 不再被 prompt 覆写。新文件 `test/dual-site-resolver.test.ts` 6 test（Site A/B/CLI 三 site 一致性 + Layer B 拒绝 `~/Library` + session.cwd 不漂 invariant）。6/6 pass，125/125 完整回归。
  - 症状：drift 跨 turn 2-6 持续（turn prompt 无路径但 cwd 不回 project root）。
  - 根因：Site A（`app.ts:5651 resolveRequestCwd` → `resolveExplicitPromptCwd`，只接受实存目录）与 Site B（`LLMCodingRuntime.ts:1378 resolveCwdFromPrompt`，有 dirname 兜底）行为不一致；`app.ts:2301 session.cwd = cwd` 每 turn 覆写。
  - 修法：统一 Site A/B——要么删 `resolveExplicitPromptCwd` 让 runtime+PhaseB 决策，要么把 Phase B continuity 上移到 `resolveRequestCwd`；`session.cwd` 不被 external prompt 覆写。
  - 验证：`test/resolve-cwd-fallback.test.ts` +4 个 test（两 site 一致性 / session.cwd 不被 external prompt 覆写 / 跨 turn 不漂 / turn 7 自愈仍工作）。
  - 估算：~30 行 refactor + 4 test。

**Reopen 信号**（operator-facing，§13.6 修正）：

- 任何 `cwd` 漂到 `/Users/<user>/Library` / `Documents` / `Desktop` / `Downloads` / `homedir` → **Bug 1 Layer A+B 未收口**。
- 任何 `task_scope_declared.explicitRoots` 含 `/com~apple~...` / 不以 `/Users/<user>/...` 开头的破碎 fragment → **Bug 1 Layer A 未收口**（quote span 识别漏）。
- 任何 turn 的 `session_started.cwd` 与 `session.origin_cwd` 不一致 + 该 turn prompt 无项目内路径 → **Bug 4 未收口**（跨 turn drift 持续）。
- 任何 `session_root_continuity` event 缺失 → **Bug 2 未收口**（接线层未传 origin_cwd）。
- 任何 `CONTEXT_STORAGE_UNAVAILABLE` + `events` 表非空 → **Bug 3 未收口**（reopen Phase C2 注入层）。
- 任何 `GLOB_FAILED` 因 `Operation not permitted` 整段失败（非 partial）→ 独立工具鲁棒性 follow-up（tool-governance-plan，不阻塞本 plan）。

## P1 Long-Running Context Assembly Hot Path Closure — R0-R7

> 主文档：[long-running-context-assembly.md §19/§20](../proposals/long-running-context-assembly.md)。**2026-06-20 收盘**：R0 / R1 / R2 / R3 / R4 / R5 全部收口。**只剩 R6**（Go TUI runtime-owned rendering）Open，是 plan 升级到 `Active Reference` 之前必须补的最后 1 段。R7 replay gate 部分收口（c1-c4 + c4' + c5 + c6 全部关闭 — R5 关闭 c5）。

- [x] **R0 [P0 prerequisite] — Storage propagation + continuity wiring**（✅ 2026-06-18）。
  - 依赖：上方 `session_10320709` Bug 3 + Bug 2。
  - 修法：`LLMCodingRuntime.runExecuteStreamInner` 注入 `this.storage`；Nexus HTTP/WS executeStream 传 `storage` / `storedSessionCwd` / `latestTaskPrimaryRoot`；runtimeToolLoop defensive merge。
  - 验证：`test/runtime-storage-propagation.test.ts` 5/5 + `test/session-origin-cwd.test.ts` 4/4；storage-backed session 中 `contextRecent` 不再返回 `CONTEXT_STORAGE_UNAVAILABLE`，并能 emit `session_root_continuity`。
  - 状态：完全收口。

- [x] **R1 [P0 prerequisite] — CWD drift guard before persistence**（✅ 2026-06-18）。
  - 依赖：上方 `session_10320709` Bug 1。
  - 修法：Bug 1 Layer A（quote-delimited span 优先识别）+ Bug 1 Layer B（共享 `isAcceptablePromptCwd` 拦系统目录）+ Bug 4（统一 3 个 resolution sites + `session.cwd` 不被 prompt 覆写）。
  - 验证：`test/resolve-cwd-fallback.test.ts` 10/10 + `test/dual-site-resolver.test.ts` 6/6 + `test/system-prompt-builder.test.ts` 39/39；`session_cf361f04` / `session_10320709` 风格 prompt 不再把 root 写成 `/` 或 `~/Library`。
  - 状态：完全收口。

- [x] **R2 [P1 core] — Persisted working set enters normal executeStream hot path**（✅ 2026-06-18）。
  - 修法：`LLMCodingRuntime` 通过 `resumeDeps.workingSetTracker` load/rebuild working set；每次 `refreshRuntimeContextState()` 传 `workingSetOverride`；成功工具事件后 `applyEvent()` + `flush()`；失败/denied/out-of-scope 不更新。
  - 同步修：`refreshRuntimeContextState()` 必须 forward `workingSetOverride` / include flags 给 `assembleContext()`，不能 drop。
  - 验证：`test/runtime-working-set-hot-path.test.ts` 7/7 + `test/working-set-tracker-persist.test.ts` + `test/working-set.test.ts` 覆盖 persisted entry 出现在 provider system prompt、工具触达后写 `.babel-o/working-set.json`、runtime restart 后下一轮注入。
  - 状态：完全收口。

- [x] **R3 [P1] — REST PUT and `/v1/working-set/observe` share tracker**（✅ 2026-06-18）。
  - 问题：当前 PUT helper fresh tracker；WS 监听 broadcaster tracker。写入可以持久化，但不保证通知已连接 WS。
  - 修法：`WorkingSetBroadcaster.mutate(cwd, fn)` 或等价共享 tracker provider；PUT 走 broadcaster-owned tracker 后 flush。
  - 验证：`test/r3-rest-put-observe.test.ts` 6/6 覆盖：mutate helper 基础 / 持久化 / tracker 复用 / R3 acceptance e2e (PUT → persisted → broadcaster event → GET same version) / 共享 tracker 证明 / legacy back-compat。
  - 状态：完全收口。

- [x] **R4 [P1] — `/v1/context/observe` real-runtime e2e + redacted payload**（✅ 2026-06-20）。
  - 问题：route + broadcaster 存在，但现有测试主要手动 `publish()`。
  - 修法：`nexus/contextBroadcaster.ts` 新增 `redactContext(context, mode='summary')` 剥离 `systemPrompt` + `messages`；`routers/contextObserveRouter.ts` 默认 summary 模式（redacted payload），`?full=1` opt-in verbatim。`redaction: 'summary' | 'full'` 字段写入响应帧让消费者知道模式。`publisher` publish fire-and-forget 永不阻塞 hot path。
  - 验证：`test/r4-context-observe-runtime-e2e.test.ts` 9/9 覆盖：redactContext summary / full / 默认 mode / array content 兼容 / broadcaster publish 不断 / cache contract / unsubscribe 清理 / **真实 LLMCodingRuntime.executeStream → broadcaster 自动 publish e2e**（无手动 `defaultContextBroadcaster.publish()`）/ reconnect → assembled_snapshot。
  - 状态：完全收口。c6 (observer redacted e2e) 关闭。

- [x] **R5 [P2] — Resume preview as product path**（✅ 2026-06-20）。
  - 修法：`LLMCodingRuntime.resumePreview({ sessionId, cwd })` 纯 read-only projection：load/rebuild working set + assemble context（`includeLiveHints: false`），返回 `{ cwd, workingSet: { sessionId, workspaceId, entries, version, updatedAt, rebuilt }, assembledSectionIds, budget, liveHintsSubscribed: false, hasContinuationSnapshot: false }`。`/v1/sessions/:sessionId/resume-preview` route 调 `runtime.resumePreview?.()`；`LocalCodingRuntime` 无 resume → route 返回 501 `RESUME_PREVIEW_UNSUPPORTED`（默认-on policy：缺能力显式报错，不静默回退）。
  - 验证：`test/r5-resume-preview.test.ts` 6/6 覆盖：404 SESSION_NOT_FOUND / 400 缺 cwd / 501 LocalCodingRuntime / pre-seeded 文件 rebuilt=false version preserved / event-tail fixture rebuilt=true derived entries / 调 preview 前后 storage event count + session.updatedAt 不变（read-only 验证）。`hasContinuationSnapshot: false` 硬编码，docs 不再承诺"0 information loss" 直到 R0-R7 全过。
  - 状态：完全收口。c5 (resume preview product path) 关闭。

- [ ] **R6 [P2] — Go TUI consumes runtime-owned context facts only**。
  - 修法：订阅 `/v1/working-set/observe` 和 redacted `/v1/context/observe`；展示 working-set version/count、last assembled timestamp、context usage source、unavailable state。
  - 约束：Go TUI 不自行推导 context truth。

- [x] **R7 [P1 gate] — Real regression replay gate**（✅ 2026-06-20，部分收口）。
  - Fixtures：`session_981cc5c2`、`session_cf361f04`、`session_10320709`（snapshot 在 `test/fixtures/r7-fixture.sqlite`）。
  - 状态：c1 (cwd drift 治理) + c2 (Phase B continuity) + c3 (context tool storage) + c4 (working-set hot path) + c4' (REST PUT ↔ WS observer 共享 tracker) + c5 (resume preview product path) + c6 (observer redacted e2e) **全部关闭**（R4 关 c6 + R5 关 c5）。**只剩 R6**（Go TUI runtime-owned rendering）Open——plan 升级到 `Active Reference` 之前必须补的最后 1 段。
  - 验证：`test/r7-replay-gate.test.ts` 15/15 覆盖 fixture 完整性、c1-c3 replay、c4-c6 仍 Open 的诚实报告、gate verdict summary。

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

> 历史实施事实已归档到 [DONE.md](../DONE.md)，后续规范化规划见 [context-and-agent-history.md](../history/context-and-agent-history.md)。

Provider 偏差校准基础已收口：50K JSON schema、10K 中文、长 tool_result、DeepSeek reasoning、provider tool schema overhead、conservative buffer 与 context blocking 口径已覆盖。`LLMCodingRuntime` provider-call-before blocking guard 与 `analyzeContext()` 已默认使用 conservative 估算。后续 provider 偏差校准只在真实 drift 出现时补最小 fixture；多模态动态 patch count 仍作为未来接口预留。

## 已收口 Compact 完整化 — 机制增强

> 历史实施事实已归档到 [DONE.md](../DONE.md)，后续规范化规划见 [context-and-agent-history.md](../history/context-and-agent-history.md)。

### Compact 后状态重建

当前 compact post-restore 增强和 focused recovery fixture 已收口；若后续真实会话出现恢复漂移，再补最小回归。

### /context 诊断命令

当前 `/context` 诊断增强和展示一致性回归已收口；若后续真实会话出现展示漂移，再补最小回归。

## 已收口 Go TUI Permission Policy / Bash Hard-Deny 治理

> 详细规划见 [go-tui-history.md](../history/go-tui-history.md)。真实样本：`session_go_1781076550805204000`（Go TUI WebSocket session，sessionId 末段 204000）。

- Phase A — Bash read-only subcommand 自动放行已收口：`src/tools/builtin/bashClassifier.ts` 新建 230 行纯函数 `classifyBashRisk`（read-only 白名单 + git 拒绝子命令黑名单 + find `-type f` 特殊处理 + 30+ 危险 pattern 二次校验）；`src/tools/Tool.ts` `ToolDefinition` 加 `riskForInput?: (input: any) => ToolRisk` 字段；`src/runtime/LocalCodingRuntime.ts` 与 `src/runtime/LLMCodingRuntime.ts` 新增 private `effectiveRisk` helper，hard-deny gate + approval gate 都用 `effectiveRisk` 判定。Go TUI 默认 provider 是 `local`，所以 `LocalCodingRuntime` 必须同样支持 `riskForInput` 才能让 Go TUI 跑得动——这个边界在 plan 阶段未识别，靠 Phase A 第一个 Nexus focused test 间接暴露。
- Phase B — soft-deny policy per-request override 已收口：`src/nexus/app.ts` `executeSchema` 加 `policy: z.enum(['strict', 'soft-deny']).optional()` + `CreateNexusAppOptions` 加 `executePolicyMode?: 'strict' | 'soft-deny'`（server-side 默认值，默认 `'strict'` 保 back-compat）；`src/runtime/Runtime.ts` `RuntimeExecuteOptions` 加 `policyMode?: 'strict' | 'soft-deny'`；`src/runtime/LocalCodingRuntime.ts` hard-deny gate 改为 `if (effectiveRisk !== 'read' && !this.toolPolicy.isAllowed(tool) && options.policyMode !== 'soft-deny')`——**核心改动仅一行**，soft-deny 仅 bypass hard-deny 让既有 approval gate 自然触发 `permission_request`。
- Phase C — 端到端 mock provider regression 已收口（含 bug 修复）：`src/runtime/LocalCodingRuntime.ts:4465` `case "result", "error"` 之前不重置 `m.inputMode`，导致 permission denied 流程后 model 卡在 `modePermission` 不出来，textinput 吞掉非 `a/y/n/r/esc` 键；修复为显式 `m.setMode(modeComposing)`。`test/runtime.test.ts` 新增 `execute permission denial: user denies → tool denied + result(false)` 端到端测试。
- Phase D — Go TUI `--allow-tools` flag 已收口：`src/runtime/perRequestPolicy.ts` 新建独立模块（避免 `LLMCodingRuntime` ↔ `LocalCodingRuntime` 循环 import）——导出 `buildPerRequestAllowedToolsPolicy(allowedTools)` helper，镜像 server-startup policy 解析（`*` / `all` → `allowAllTools`；否则 → `allowlistedTools`）。`src/runtime/Runtime.ts` `RuntimeExecuteOptions` 加 `allowedTools?: readonly string[]` 字段。`src/runtime/LLMCodingRuntime.ts:128-143` 与 `src/runtime/LocalCodingRuntime.ts:109-127` `executeStream` wrapper：`options.allowedTools` 非空时构造 override policy、用 `withToolPolicy` 包裹 inner body（`runExecuteStreamInner` 抽到私有方法）。

**守住的边界**：
- `denyByDefaultTools()` / `allowAllTools()` / `allowlistedTools()` 三个 policy builder 签名未动
- approval gate 自身完全未动；`permission_request` / `permission_response` / `tool denied` 事件 schema 未改
- `bbl chat` 与 HTTP API 既有客户端完全 back-compat（不发 `policy` / `allowedTools` 走 server-side 默认 `'strict'` + `denyByDefaultTools()`）
- child AgentLoop 仍走 server-startup policy，不被 per-request `policy` / `allowedTools` 影响
- workspace path safety 仍由 `findWorkspaceEscapeInCommand` 拦截（独立机制）
- `error.code` 分类口径（`REQUEST_TIMEOUT` / `REQUEST_CANCELLED` / `RUNTIME_AGENT_STEP_ERROR`）未动

后续只在以下情形重新开项：(1) 真实会话继续暴露 runtime tool policy drift；(2) 真实用户反馈 approval gate 需要更细的 read / write / execute 三档区分；(3) Power-user 需要 `allowedTools` 之外的"自动 approve 一组 command" 等新 opt-in 模式。

## 已归档 Tool Discovery / Targeted Reading 第一阶段

Tool Discovery / Targeted Reading 第一阶段已归档到 [DONE.md](../DONE.md)：`ListDir` 已在后续工具边界切片中作为正交目录 inventory 工具落地；`Glob` 用于 path pattern discovery，`Grep` 用于 content locating，`Read` preview / truncated result / repeat ledger 引导 targeted range 读取，避免重复灌入大文件。

## P2 Tool Granularity / Evidence-grounded Reading

> 详细规划见 [tool-governance-plan.md](../reference/tool-governance-plan.md)。本项承接“工具职责应正交细分但避免重复命名”的治理结论：`ListDir` 已落地为 bounded directory inventory；`Glob` / `Grep` / `Read` 分别限定为 path pattern discovery、content locating、source understanding；不新增与 `Grep` 重叠的 `Search`，不新增 `define_subagent` / `invoke_subagent`。历史边界文档已迁入 [archive/tool-granularity-and-evidence-governance-plan.md](../archive/tool-granularity-and-evidence-governance-plan.md)。

Phase B.5 已收口：`Grep` 优先使用 optional bundled ripgrep（`@vscode/ripgrep`），其次使用系统 `rg`，最后才使用 JavaScript `RegExp` fallback；schema 显式支持 `pathMatches` glob 过滤，fallback 支持基础 regex alternation，并为 fallback mode、no-result 与 invalid-regex 返回明确 diagnostics；focused regression 覆盖 `ContextForker|forkContext|contextFork`。
Phase B.6 已收口：Bash 普通 command timeout / SIGTERM 已返回 recoverable `tool_completed(success=false)`，输出结构化 `COMMAND_TIMEOUT`、`timedOut`、`signal`、stdout/stderr 摘要与 command summary，不再把普通 shell timeout 作为 session fatal；外部 request abort 仍保留 runtime cancellation path，不被 Bash timeout recovery 吞掉。
Phase B.7 已收口：新增 Bash-as-file-discovery guidance，`ls`/`ls -R`/`find`/`tree`/`grep -r`/`rg` 这类只读 discovery 命令会在 Bash tool result 中追加 `BASH_AS_FILE_DISCOVERY` structured guidance，提示优先使用 `ListDir` / `Glob` / `Grep` / `Read`；classifier 对 `find`、`tree`、recursive grep/ls、`rg` 等 broad discovery 命令返回 manual-review reason 并包含同一替代工具提示，普通 `ls` 保持既有低风险执行但仍输出 guidance。
Phase B.8 已收口：Workspace Path Drift / Tool Failure Recovery 最小诊断已落地；`Read` / `ListDir` missing path 与 `Glob` missing search root 会在 cwd-aware 候选路径存在时输出 `PATH_DRIFT_SUSPECTED` guidance，保留 recoverable failure / empty-result 语义，不自动切换 cwd、不新增路径搜索工具、不绕过 path safety。样本：`session_1cf5362d-b33f-467f-b07e-f97356652662`。
Phase B.9 已收口：Grep `pathMatches` 参数语义诊断已落地；`pathMatches: "true"` / `"false"` 会返回 recoverable `INVALID_GREP_PATH_MATCHES_GLOB` diagnostic，提示 omit field 或使用 `**/*.ts` / `**/package.json` 这类 file glob，避免 boolean-string 被 ripgrep 当作 `--glob true` 后产生误导性空结果。样本：`session_303c7221-8cc3-4251-9436-4215244120e4`。
`session_9d985c5c-7c89-41b8-9d5e-cc672e412f00` 同时暴露了 evidence-scope drift：项目级强声明主要基于 `Read` / `ListDir` 证据，未观察到足以支撑部分全局声明的 `Grep` / `Glob` / `Bash git status`；作为 Phase C/Phase E 的真实样本记录，详见 [evidence-and-runtime-history.md](../history/evidence-and-runtime-history.md)。
- [ ] Phase C: Source Coverage Ledger / Strong Claim Guard 轻量诊断评估。
  - 仅在真实会话继续暴露 evidence scope drift 时推进；避免过早引入复杂审计系统。
- [ ] Phase E（Watch）: tool result evidence hint 评估。
  - 如继续出现模型把 `ListDir` / `Glob` / `Grep` / partial `Read` 证据过度扩张为强声明，再评估在结果渲染或 diagnostics 中增加 `directory-inventory`、`locator-only`、`partial-read`、`full-read` 等轻量标签。

## 已收口 P1 Context Manager / ContextForker 规范化

> 统一规划见 [context-and-agent-history.md](../history/context-and-agent-history.md)。现有上下文能力已较强，后续重点不是重写，而是显式化 pipeline、统一 ContextItem/ScoredContextItem/SelectedContextItem 抽象、增加 ContextForker，并让 `/context` 能解释 retained/dropped reason。

当前最小规范化切片已收口：`src/runtime/contextManager.ts` 定义 Context Manager phase、`ContextItem` / `ScoredContextItem` / `SelectedContextItem` 与 selection diagnostics；`assembleContext()` 保留既有 recent event selection、tool-pair protection、omitted-event selection 行为，只额外输出 retained/dropped diagnostics；`analyzeContext()`、HTTP context API 与 CLI `/context` 已展示 retained/dropped item 数量、reason、estimated tokens、working set paths 与 compact boundary。

ContextForker 多模式也已收口：`minimal` 保留 Explore Agent 只读聚焦语义；`working-set`、`task-focused`、`full-summary` 与 `debug-replay` 已能按 active paths、近期用户关注、任务/失败/权限上下文、compact summary 与 child-agent result 生成 child prompt。AgentScheduler 会把 fork diagnostics 写入 child session metadata，HTTP context API 与 CLI `/context` 已展示 fork mode、inherited/omitted item 数量和 child-agent context 继承情况。

## 已收口 Context: Working Set

> 历史实施事实已归档到 [DONE.md](../DONE.md)，后续 ContextForker / AgentScheduler 复用规划见 [context-and-agent-history.md](../history/context-and-agent-history.md)。

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

## P1 Agent Runtime Maturity — Durable Resume / MCP Context / Memory Quality

> 主规划见 [agent-runtime-architecture-maturity-plan.md](../reference/agent-runtime-architecture-maturity-plan.md)。本节只承接 runtime-owned 的打开项；trace/eval harness 见 [TODO_performance.md](./TODO_performance.md)。

### Durable Run Checkpoint / Resume — ✅ v1 收口（2026-06-18）

`src/runtime/runCheckpoint.ts` 纯投影 + `bbl inspect-session <id> --resume` CLI 已落地，覆盖 6 boundary / 5 state + 18 unit + 7 integration test。v1 显式不持久化 in-process continuation snapshot（避免“看起来 durable / 实际不可恢复”的假持久化），所以默认 `hasContinuationSnapshot: false` 保持诚实；CLI 一律传 `false` 表示 post-restart inspection。

- [x] 定义 resumable run state：`before_provider_invocation` / `after_provider_invocation` / `before_tool_execution` / `waiting_permission` / `after_tool_result` / `before_final_result`。→ `src/runtime/runCheckpoint.ts` `RunCheckpointBoundary` + `ResumableRunState` 5 variant。
- [x] session metadata / task state 能表达 `resume_possible` / `retry_from_provider_turn` / `waiting_permission` / `terminal_failed_recoverable` / `cannot_resume` 与 reason。→ `deriveResumableState` 纯函数 + `test/run-checkpoint.test.ts` 18 test。
- [x] pending permission 只有在存在 tool call snapshot + continuation state 时才允许宣称 durable。→ CLI 默认 `hasContinuationSnapshot: false`；`formatResumeState` 灰字 note 明示 v1 不持久化。
- [x] `inspect-session` / Nexus status 能说明 session 中断点、是否可恢复、下一步动作。→ `exportSessionResumeState` + `formatResumeState` + `bbl inspect-session <id> --resume`；honest `next:` hint per state。
- [x] 回归覆盖：permission wait、tool result 已持久但 provider continuation 未完成、provider context recovery 后中断。→ `test/inspect-session.test.ts` 7 集成 test（waiting_permission / terminal success / terminal error / non-terminal mid-run / absent / formatter）+ `test/run-checkpoint.test.ts` 18 unit test。

后续 v1.1+：持久化 durable continuation snapshot；从 provider token stream 中段 resume；将 `retryable_provider_turn` / `retryable_tool_result` 写成 session metadata（当前只 derivation，不写回）。需要真实 regression 触发再推进。

### MCP Context Primitives — Watch / Regression-driven

现有 MCP 主要作为 tool wrapping。若后续落地 `ListMcpResources` / `ReadMcpResource` / MCP roots，必须和 task scope / evidence scope 协议对齐。

- [ ] MCP resource read 触发和文件 `Read` 同级别的 scope diagnostics。
- [ ] MCP roots 不覆盖 Nexus `primaryRoot`，只能成为 explicitRoots 或 confirmedExternalRoots。
- [ ] Go TUI 只渲染 `source=mcp` 和 scope event，不 re-derive MCP scope。
- [ ] 实施前需要真实 MCP resource 使用 regression 或明确集成需求。

### Memory Quality Metrics — Open

MemoryOS/EverCore 当前边界正确：volatile / non-authoritative / cue-driven / permission-gated。下一步需要可观测质量指标。

- [ ] 汇总 auto-search triggered / skipped reason 分布。
- [ ] 汇总 hit count、injected chars、truncation rate、search latency。
- [ ] 增加 stale / contradicted memory diagnostic 口径。
- [ ] 增加 memory save approval / denial 指标。
- [ ] eval harness 能断言 memory hint 不被当作 workspace fact。

### Loop Taxonomy — Docs Guard

后续文档和代码注释统一使用：

- `runtime loop`：`LLMCodingRuntime` 内 provider/tool 循环。
- `tool loop`：单次 provider-requested tool lifecycle。
- `agent loop`：Planner/Executor/Critic/Optimizer task loop。
- `interaction loop`：Go TUI / `bbl loop` UI event loop。

新增 loop 相关设计必须声明是否拥有 runtime truth；默认只有 Nexus/runtime 拥有 execution truth。

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

> 详细规划见 [go-runner-plan.md](../proposals/go-runner-plan.md)。Go Runner 的定位是执行层增强：TypeScript Nexus 决定做什么，Go 只安全高效地执行已经批准的动作。它不替代 Context Manager、AgentScheduler、provider adapter、权限决策或 CLI/TUI。

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

> 参考规划：`/Users/tangyaoyue/DEV/EverOS/babel-o-evercore-integration-plan.md`。EverOS 当前实际 REST API 是 `/api/v1/memory/add|flush|search`，不是早期规划中的 `/memories/agent` 路径。

Phase A REST Spike 已收口：BabeL-O 侧新增默认关闭的可选 EverCore REST client，支持 `search`、`addAgentMessages`、`flushAgentSession`；`GET /v1/runtime/status` 暴露 redacted EverCore diagnostics；`BABEL_O_EVERCORE_UPLOAD_ON_SESSION_END=1` 时 session close/cancel 会上传 bounded user/result messages 并 flush，失败只写入 session metadata，不影响 BabeL-O 主流程；SQLite/session/event/tool trace 仍是事实源。

Phase B Internal MemoryProvider 已收口：`MemoryProvider` / `NoopMemoryProvider` / `EverCoreMemoryProvider` 已抽象完成；server、embedded client 与本地 CLI flow 都可在 EverCore healthy 时把 `/api/v1/memory/search` 结果注入 provider context；长期语义记忆 block 明确为 volatile / non-cacheable，并在 prompt 中标注为 background hints，不作为 authoritative project state；检索失败只记录 diagnostics，不污染 provider-visible context。

Phase C Context Budget / Diagnostics 已收口：MemoryProvider 结果携带独立 `hitCount` / `injectedChars` / `budgetChars` / `maxHitChars` / `truncated` / `searchLatencyMs` / `error` 诊断；`analyzeContext()`、HTTP `/v1/sessions/:sessionId/context`、CLI `/context` 与 context view 均展示 long-term memory budget 状态；检索失败仍只进入 diagnostics，不污染 provider-visible context。后续 Phase D 已补 scoped diagnostics：EverCore provider 会标记 `scope=project`、`namespaceId=projectId`、`namespaceSource` 与 `isolationKey=projectId`。

Phase D Optional MCP Tools 已收口：`BABEL_O_ENABLE_EVERCORE_MCP_TOOLS=1` 且 EverCore healthy 时才注册 `mcp:evercore:memory_search` / `memory_save_note` / `memory_flush_session`；search 为 read-only bounded explicit retrieval，save/flush 为 write risk 且走现有 permission 审批；这些工具只用于用户主动或模型显式调用，不承担每轮自动检索或 session end 上传。

Phase E Embedded / Managed EverCore 一体化部署 Spike 已收口：新增 `BABEL_O_EVERCORE_MODE=managed`，BabeL-O/Nexus 可默认关闭地管理本地 `everos server start` sidecar，自动分配 loopback 端口与本地数据目录，向 EverOS 注入 `EVEROS_MEMORY__ROOT` / `EVEROS_API__HOST` / `EVEROS_API__PORT`，并在 `/v1/runtime/status` 暴露 mode、health、redacted endpoint、data dir、pid、upload/MCP tools 状态；managed sidecar 启动/健康检查失败保持 non-fatal diagnostics，external mode 继续保留，SQLite/session/event/tool trace 仍是 authoritative 事实源，EverCore memory 仍只是 volatile / non-cacheable / non-authoritative hints。

Phase F Provider Protocol Convergence 已完成首轮 live 验证：EverOS text LLM 侧新增 protocol-aware provider，BabeL-O managed sidecar 通过 `EVEROS_LLM__PROTOCOL` + `EVEROS_LLM__API_KEY` / `EVEROS_LLM__BASE_URL` / `EVEROS_LLM__MODEL` 桥接当前 provider；显式 `BABEL_O_EVERCORE_LLM_*` override 仍最高优先级。自动桥接按 adapter 映射：OpenAI-compatible / OpenAI Responses → `openai-compatible`，Anthropic-compatible → `anthropic-compatible`；已用当前 MiniMax Anthropic-compatible provider 跑通本地 loopback EverOS `/health`、`/api/v1/memory/add`、`/api/v1/memory/flush` 与 keyword `/api/v1/memory/search`。EverOS cascade 在 embedding 未配置时降级为 disabled，允许 health / add / flush / keyword search 验证继续运行；vector/hybrid search 与 fresh vector indexing 仍需要 embedding 配置。不优先在 BabeL-O 中新增 OpenAI-compatible proxy。

Phase G Memory Capability Awareness / Self-Trigger 已完成 G1-G6 闭环：当前口径见 [memory-governance-plan.md](../reference/memory-governance-plan.md)，历史细节见 [archive/memory-capability-awareness-and-trigger-plan.md](../archive/memory-capability-awareness-and-trigger-plan.md)。provider loop 现在会在 MemoryProvider enabled 时获得 non-cacheable `Long-Term Memory Capability` block，明确 `memory_search` 的自触发场景、memory results 的非事实源边界、项目事实需 workspace evidence，以及 `memory_save_note` 只在用户明确要求记住或治理候选获批时使用。EverCore MCP tool descriptions 已同步 read/search、permission-gated save 与 lifecycle-owned flush 边界；SessionChannel `memory_candidate` 已生成 review-only governance metadata 且 `autoWrite=false`；EverCore MemoryProvider 新增轻量 heuristic auto-search policy，只在 prior/previous/last time/偏好/之前/上次/记得 等记忆线索出现时自动检索，build/test/status、permission response 与纯 workspace/file turn 只记录 skip diagnostics，不污染 provider context。mock provider regression 已证明 capability block + visible MCP tools 可触发 read-only `memory_search`，且 `memory_save_note` 在写入前发出 `permission_request`；G6 managed EverCore live validation 已用当前 MiniMax Anthropic-compatible provider 跑通 save permission gate、EverOS add/flush、runtime auto-search recall 与 project fact caution，验证长期记忆只作为 hint 且项目事实仍需 workspace evidence。

Phase G 后续只保留 focused P2：当前口径见 [memory-governance-plan.md](../reference/memory-governance-plan.md)，历史 lifecycle/cache/UI/answer 细节见 [archive/evercore-lifecycle-cache-and-answer-governance-plan.md](../archive/evercore-lifecycle-cache-and-answer-governance-plan.md)。能力问答回归已收口：”你当前能否写入记忆？”只回答用户级能力与确认流程，不暴露内部路径、commit hash、MCP sidecar 细节或 hidden prompt 内通，并且纯能力问答不触发 tool call。managed EverCore process-level cache 也已收口：embedded / chat / local run / server 均复用 `EverCoreRuntimeManager`，相同 config 不再每次 inject 重复拉起 sidecar，并在 client close / one-shot finally / server close 时 shutdown。`/memory` 状态与管理面板 MVP（L4）已收口：Nexus 提供 `GET /v1/runtime/memory/status`（read-only envelope `{ type, capability, everCore, guidance, actions }`），`embedded.memoryStatus()` 复用同一 lease cache，Go TUI `/memory` overlay 通过 `fetchMemoryStatus → memoryStatusMsg → modeMemoryOverlay` 进入 read-only 全屏面板。`/memory` actions（L5）也已收口：Nexus 新增 bounded read-only `search`、review-only `candidates`，以及 approval-gated `save-note` / `flush` / `restart` envelopes；TS/embedded clients 暴露对应方法，Go TUI `/memory status|search|candidates|save|flush|restart` 子命令可渲染 search/candidates/approval/mutation/error envelopes。`save` / `flush` / `restart` 默认只返回 approval required，不静默写入或重启；`restart` 当前只完成 gate，确认后返回未实现诊断。registry health reuse（L2）已收口：managed sidecar 启动前会读取 dataDir-local `sidecar-registry.json` 并探测 `/health`，健康则复用现有 sidecar 且不再分配端口/重复 spawn；stale registry 只进入 diagnostics 并 best-effort 清理，新 sidecar health 通过后原子写回 registry，`/v1/runtime/status` / `/v1/runtime/memory/status` 可见 `sidecar.reused`、`registryPath`、`registryStaleReason`、`registryCleanupError`。idle TTL warm sidecar（L3）已收口：`EverCoreRuntimeManager` 默认在 refCount 降为 0 后保留 warm sidecar 5 分钟，TTL 内同 fingerprint acquire 会复用并刷新 timer；测试可用 `idleTtlMs=0` 保持 deterministic 立即 dispose；`shutdown()` 仍会取消 timer 并 best-effort dispose owned sidecar。至此 lifecycle/cache/UI/answer-governance 后续规划 L1/L2/L3/L4/L5/L6 均已收口；Layer D search short cache 仍未启用，除非真实重复 recall query 暴露网络开销，否则不再主动开项。

## P2/P3 Session Channel + Scoped Memory

> 详细规划见 [context-and-agent-history.md](../history/context-and-agent-history.md)。本项把 session 视为 workspace runtime state：project/workspace memory 默认按 session/cwd 隔离，user memory / auto-memory 只承载跨项目用户习惯与配置约束，EverCore / EverOS 作为长期语义记忆与 consolidation 层，不替代 SQLite/session/event/tool trace 事实源。

Phase B MVP 已收口：`SessionChannel` / `SessionMessage` shared types、MemoryStorage/SQLite persistence、Nexus API create/list/get channel、send/list message、session inbox 与 ack 已落地；`LLMCodingRuntime` 与 `/v1/sessions/:sessionId/context` 会把 unread inbox 注入 bounded non-cacheable `session_inbox` block，并明确标注跨 session 消息是 collaboration context、不是直接用户指令。MVP 仍不实现完整 dreaming、不做 raw transcript sharing、不替代 `AgentScheduler` parent-child lifecycle。

Phase C.1 CLI/TUI 可见化已收口：`NexusClient` 与 embedded client 支持 list/ack session inbox；`bbl sessions inbox <sessionId>` / `bbl sessions ack <sessionId> <messageId>` 提供外部 CLI 入口；`bbl chat` 新增 `/inbox`、`/inbox all`、`/inbox ack <messageId>` slash 入口并在 help/completion 中可发现。展示继续声明跨 session message 只是 collaboration context，需要验证证据后再行动。

Phase C.2 AgentScheduler parent-child channel 已收口：`ExploreAgentScheduler` 会为 parent/child session 创建 `parent_child` channel，parent→child 写入 review/validation request，child terminal 时向 parent inbox 写入 handoff/blocked；`agent_job_event` 与 child transcript 查询仍是 lifecycle/source-of-truth。

Phase D scoped MemoryProvider / channel diagnostics 已收口：Layer 2 Project memory 不按 sessionId 隔离，继续按 project/workspace identity 隔离；`projectId=default` runtime status 诊断、opt-in `BABEL_O_EVERCORE_PROJECT_ID_MODE=workspace` cwd/git-root 派生 namespace、EverCore project-scoped MemoryProvider diagnostics、user-scoped MemoryProvider diagnostics 表达与 channel-scoped inbox budget diagnostics 均已落地。`/v1/sessions/:sessionId/context`、CLI `/context` 与 context view 会展示 `scopedMemory[]` 分项；SessionChannel API→Inbox→Context focused regression 已验证两个 session 可以真实传输 typed message，并在 ack 后不再注入 receiving context。仍保持 volatile / non-authoritative hints 口径，不做 raw transcript sharing、不把跨 session message 当成直接指令、不自动写入长期记忆。

Phase E governed dreaming / auto-memory candidate pipeline 评估已收口为最小治理模型：`memory_candidate` SessionMessage 会被评估为 review-only candidate，并在 message metadata 中记录 scope classifier、evidence refs、confidence、staleness/supersession、approval requirement、blocked/review reasons 与 `autoWrite=false`；inbox context 会显式展示候选治理状态。默认不自动写入长期记忆；项目事实需要 workspace evidence 与用户审批，user memory candidate 需要用户审批，channel candidate 只允许进入策略审批的 channel/project summary 路径。完整 background dreaming、自动 EverCore 写入和 high-impact project fact auto-write 仍不启用，后续只在真实使用暴露治理缺口时按 regression-first 开项。

## 验证命令

历史验证命令包括 `npm run typecheck`、`npm test`、`npm run cli -- run "hello"`、`npm run cli -- run --url http://127.0.0.1:3000 "bash pwd"`、`npm run cli -- --help` 与 `npm run benchmark`。当前默认 `npm test` 已覆盖 token estimator、blocking limit、microcompact、compact post-restore、context command、working set、prefix cache、path mention、tool result budget 与 Runtime context API/display 回归。

## 参考文件

- `docs/nexus/reference/session-finalization-and-evidence-governance-plan.md` — current-turn session finalization 污染修复与 evidence-scope drift 轻量治理样本
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

## Skill execution governance (Phase 0–6) — 2026-06-16 收口

- Phase 0（Baseline preservation）— 已收口
- Phase 1（Schema / validator / normalizer / formatter）— `src/skills/{schema,validator,normalizer,formatter}.ts` + 11 测试
- Phase 2（SkillRegistry + observability）— `src/skills/registry.ts` + `src/shared/skillEvents.ts`（4 event schema 独立可 import；union 集成延后）+ 7 测试
- Phase 3（Nexus `/v1/skills/*` endpoints）— `src/nexus/skillRoutes.ts` 4 route + 8 测试
- Phase 4（Draft generation）— `src/skills/generator.ts`（6 类 redaction）+ `POST /v1/skills/draft` + 21 测试
- Phase 5（Session capture + save）— `src/skills/storage.ts`（8 errorCode + 原子写 + 重复检测）+ `POST /v1/skills/save` + 16 测试
- Phase 6（Model-visible bounded skill tools）— `src/tools/builtin/skillTool.ts`（SkillList / SkillShow / SkillValidate / SkillDraft / SkillSave）+ 13 测试

**累计 84/84 测试通过；typecheck 0 错误。** 规划路径见 [skill-execution-and-automated-normalized-skill-generation-governance-plan.md](../proposals/skill-execution-and-automated-normalized-skill-generation-governance-plan.md)；工具三角关系当前口径见 [reference/tool-governance-plan.md](../reference/tool-governance-plan.md)，历史整合索引见 [archive/tool-governance-reference-integration.md](../archive/tool-governance-reference-integration.md)。**不主动开新项**；后续仅在真实 session 暴露 drift 时按 regression-first 重新开项（per §Phase 7）。

### 治理三角闭环 — 2026-06-16 同步

- `tool-granularity-and-evidence-governance-plan.md`（边界）— 顶部 Related plans 行 + 末尾 §10 Related governance plans 段落落地，三角引用从"两条单向 + 一条无"补到 **完整双向闭环**。
- `tool-surface-expansion-and-native-mcp-coexistence-plan.md`（补齐）+ `skill-execution-and-automated-normalized-skill-generation-governance-plan.md`（Skill）— Related 行 / 段落已存在，本批次未改。
- 任何后续修改任一联主规划时，必须同步检查另两联 + 整合索引是否需要更新。

### Go TUI fallback 同步 — 2026-06-16

- `clients/go-tui/internal/tui/slash.go` `staticToolDescriptorCatalog` 8 → 13；新增 5 个 Skill 工具（SkillList / SkillShow / SkillValidate / SkillDraft / SkillSave）。
- `tui_test.go` wantNames 同步；新增 SkillSave risk/approval 断言。
- `go test ./internal/tui/...` 11.110s 全过；`go vet ./...` 干净。

### 流程收口

- `CronDelete ca8ae7e4` 结束 `/loop 10m` 循环。Skill 治理 6 阶段全部 Closed + 84/84 测试 + 三联闭环 + Go TUI 同步 — 任务目标达成，循环不再需要。

---

## Tool Surface Expansion / Native vs MCP 共存（Phase 0–6）— 2026-06-17 文档纠偏收口，§2.2 治理待实装

规划路径见 [reference/tool-governance-plan.md](../reference/tool-governance-plan.md)，历史工具面扩展细节见 [archive/tool-surface-expansion-and-native-mcp-coexistence-plan.md](../archive/tool-surface-expansion-and-native-mcp-coexistence-plan.md)。本规划新工具（Phase 1–6）= **Plan only**；**Phase 0 文档口径**已 Closed；**registry layering 诊断**为 Phase 0 收尾项仍 Open（现存安全缺口，不受 regression gate 约束）。

### Phase 0：文档口径与注册表分层文档化 — Closed（2026-06-17）

- `AGENTS.md` §9 reference 列表补全：补齐 `tool-surface-expansion-and-native-mcp-coexistence-plan.md` / `skill-execution-and-automated-normalized-skill-generation-governance-plan.md` / `tool-governance-reference-integration.md` 三项；删除 stale 隐含。
- `src/shared/errors.ts` 登记 27 个新 errorCode（按 plan §3.1.1-3.2.4 全部列出的 sentinel）：
  - §3.1.1 Task 族（3 新增，TASK_NOT_FOUND 既存）：`STORAGE_UNAVAILABLE` / `TASK_TERMINAL` / `TASK_IDENTITY_FIELD_READONLY`。
  - §3.1.2 AskUserQuestion（2）：`ASK_QUESTION_OPTIONS_OUT_OF_RANGE` / `ASK_QUESTION_NOT_ALLOWED_COLD_START`。
  - §3.1.3 MCP（4）：`MCP_SERVER_NOT_FOUND` / `MCP_RESOURCES_UNSUPPORTED` / `MCP_RESOURCE_NOT_FOUND` / `MCP_TOOL_CALL_FAILED`。
  - §3.1.4 Skill（2）：`SKILL_NOT_FOUND` / `SKILL_NAME_REQUIRED`。
  - §3.1.5 Plan mode（3）：`PLAN_MODE_NOT_TRIGGERED` / `PLAN_MODE_ALREADY_ACTIVE` / `PLAN_MODE_NOT_ACTIVE`。
  - §3.2.1 Worktree（3）：`NOT_IN_GIT_REPO` / `WORKTREE_BRANCH_EXISTS` / `WORKTREE_PATH_NOT_FOUND`。
  - §3.2.2 WebSearch provider（1）：`WEB_SEARCH_PROVIDER_UNAVAILABLE`。
  - §3.2.3 Config（3）：`CONFIG_KEY_NOT_WRITABLE` / `CONFIG_KEY_NOT_FOUND` / `CONFIG_RELOAD_FAILED`。
  - §3.2.4 Cron / Sleep（5）：`SLEEP_ABORTED` / `SLEEP_DURATION_OUT_OF_RANGE` / `CRON_EXPRESSION_INVALID` / `CRON_JOB_NOT_FOUND` / `CRON_PERSIST_FAILED`。
  - 注：Skill 治理域另 8 个 SKILL_* errorCode（validator / storage / generator）**仍**保留在 `src/skills/*` 模块 return types，**不**进 `errors.ts`（plan §3.1.4 显式只要求 2 个）。
- `docs/nexus/TODO.md` 第 29 行 stale 修复：从"未实现 `SkillShow`"改为"未实现 `AskUserQuestion` / `TaskGet/List/Update` / `MCPTool` / `EnterPlanMode` / `Worktree*` / `Config*` / `Sleep` / `ScheduleCron*` / `WebSearchProvider`"。
- **2026-06-17 文档纠偏**（修正 plan 自身失真）：
  - §1 现状表 9→17 工具（补 contextTools×3 + Skill×5，注明已通过各自规划落地、非本规划 Phase 1–6 产物）。
  - §3.1.1 task storage 现状纠正：`NexusStorage` 已有 `saveTask`/`getTask`/`listTasks`（原写"仅 task.create"错误），缺 update/stop/output 三个。
  - §2.2 层级治理显式标注为"现存安全缺口、非新工具、不受 §7.1 regression gate 约束"。
- 守门不变量：
  - 27 个新 errorCode **未**被任何 P0 新工具引用 — 等 Phase 1-6 实施时按"errorCode 必须出现在某 unit test 断言"守门。
  - 旧 12 个 errorCode 行为不变；typecheck 守门。
  - 新工具仍 "Plan only" — Phase 0 收口**不**等于"工具已实现"。

### §2.2 层级治理实装（Phase 0 收尾项）— ✅ 已收口（2026-06-17）

- 实装文件：
  - `src/nexus/toolRegistryLayering.ts`（~180 行）：`registerToolWithDiagnostics()`、`ToolRegistryDiagnostic` 类型（`tool_overridden_by` / `tool_override_blocked` / `risk_promoted`）、`consoleWarnDiagnosticHandler`、risk score 排序。
  - `src/nexus/createRuntime.ts`：Layer 2 MCP / Layer 3 EverCore MCP / Layer 4 Agent tools 全部从无条件 `tools.set(name, tool)` 改为 `registerToolWithDiagnostics(tools, tool, diagnosticHandler)`。
  - `src/tools/registry.ts`：`createDefaultToolRegistry()` 类型标注从 `ToolDefinition[]` 改为 `AnyTool[]`（行为不变）。
  - `CreateDefaultNexusRuntimeOptions.toolRegistryDiagnosticHandler`：显式 `null` = 静默，`undefined` = 默认 `console.warn`，自定义 handler = 注入。
- 诊断规则：
  1. EverCore tool（`source.serverName === 'evercore'`）覆盖非 EverCore 同名工具 → `tool_override_blocked`，**跳过注册**。
  2. 同名覆盖 → `tool_overridden_by` WARN。
  3. 新工具 risk 高于已有工具 → `risk_promoted`（额外诊断）。
- 验证：`test/runtime-layering.test.ts` 11 个 focused test 全部通过（覆盖 3 种诊断 + 跨前缀拦截 + risk 升降 + handler 可空）；`test/config-endpoints.test.ts` + `test/agent-tools-runtime.test.ts` 42 测试无回归；`npx tsc --noEmit` 0 错误。

### Phase 1：Task 工具族拆分（最小风险，最高价值）— 未开

- 入口：把 `src/tools/builtin/task.ts` 拆为 `src/tools/builtin/task/{create,get,list,update,stop,output}.ts`；6 个 tool 全部走 `shared/task.ts` 的 `NexusTask` 类型 + `context.storage` 持久化。
- 治理前置：先有 `NexusStorage` 真实支持 `task.get/list/update/stop/output` 5 个接口（当前**只**有 `task.create`）。
- 实施**前**验证：必须在 `WORK_LOG.md` / session log 找到真实 regression 引用（"模型创建 task 后无法 list / get"），否则按 `babel-o-p0-regression-focus` 降 P1。
- 装配点：`createDefaultToolRegistry()` 改为引用 `task/create.ts` 等；旧 `Task` 单一入口保留 alias 由 `task/create.ts` 重导出（守 CLI 脚本 `bbl run --task-only` 之类）。
- 错误码（已登记）：`STORAGE_UNAVAILABLE` / `TASK_TERMINAL` / `TASK_IDENTITY_FIELD_READONLY` / `TASK_NOT_FOUND`。
- 守门：现有 100+ 测试不回归；`npm run db:migrate` 无报错。

### Phase 2：AskUserQuestion + Skill — Skill 侧已 Closed；AskUserQuestion 0%

- **Skill 侧**（来自 [Skill 治理规划 Phase 6](../proposals/skill-execution-and-automated-normalized-skill-generation-governance-plan.md)）：5 个 model-visible tool 全 Closed — `SkillList` / `SkillShow` / `SkillValidate` / `SkillDraft` / `SkillSave`。
- **AskUserQuestion** 0%：`src/tools/builtin/askUserQuestion.ts` 不存在；CLI 端 `@inquirer/prompts` 通道接入点、Go TUI `AskUserQuestionDialog` 都未做。
- 依赖：Go TUI 端 `AskUserQuestionDialog` 必须等 [go-tui-history.md](../history/go-tui-history.md) Closed；当前 Phase 0-5c' 推进中，**未**Closed。
- 实施**前**验证：必须有 session log 中"模型需要澄清问题但被迫写临时文件"的 regression 引用。
- 错误码（已登记）：`ASK_QUESTION_OPTIONS_OUT_OF_RANGE` / `ASK_QUESTION_NOT_ALLOWED_COLD_START`。

### Phase 3：MCP 工具暴露（`MCPTool` / `ListMcpResources` / `ReadMcpResource`）— 未开

- 入口：把现有 `src/mcp/McpClient.ts` + `src/mcp/McpToolAdapter.ts` 暴露为 3 个独立 `ToolDefinition`；仅在 `enableMcp === true && McpRegistry` 至少注册 1 个 server 时才注册到 `createDefaultToolRegistry()`。
- 能力探测：`ListMcpResources` / `ReadMcpResource` 前必须 `mcpClient.listCapabilities(server)` 探测 `resources` 能力。
- 跨前缀覆盖拦截：MCP 注册到 Layer 2 前必须先 check Layer 1 native 是否有同名工具；同名且 MCP `risk` 更高时触发 `tool_overridden_by` 诊断日志。
- Go TUI 端：`MCPTool` 走 `permission_request.source = 'mcp'`。
- 错误码（已登记）：`MCP_SERVER_NOT_FOUND` / `MCP_RESOURCES_UNSUPPORTED` / `MCP_RESOURCE_NOT_FOUND` / `MCP_TOOL_CALL_FAILED`。
- 实施**中**验证：`createDefaultToolRegistry()` 分层行为 unit test 断言（先 native 再 MCP，断言 native 被覆盖并 log）。

### Phase 4：Plan 模式 — 未开

- 入口：`src/tools/builtin/planMode.ts`（`EnterPlanMode` / `ExitPlanMode`）+ `LLMCodingRuntime` 新增 `mode='plan'` 信号 + `src/runtime/planModeCue.ts` 纯函数 cue 检测。
- plan 模式下 `tools` 白名单由 `LLMCodingRuntime` 重新构建，仅含 `risk: 'read'` + `SkillShow` + `Plan` 三类。
- `shared/agentJob.ts` 新增可选 `plan` 字段，schema migration 守门。
- Cue 思路参考 [memory-governance-plan.md](../reference/memory-governance-plan.md) 与历史 [archive/memory-capability-awareness-and-trigger-plan.md](../archive/memory-capability-awareness-and-trigger-plan.md) 中的 `shouldAutoSearchMemory()`（纯函数 + trigger 词表 + 可测试），**不**复用 `memoryProvider.ts` 内部代码。
- 错误码（已登记）：`PLAN_MODE_NOT_TRIGGERED` / `PLAN_MODE_ALREADY_ACTIVE` / `PLAN_MODE_NOT_ACTIVE`。
- 实施**后**验证：真实 session 中"模型未走计划直接调 Bash 出错"的 regression log 关闭。

### Phase 5：Worktree / Config / Cron / Sleep — 未开

- 4 个工具族：Worktree（`WorktreeCreate` / `WorktreeRemove`）、Config（`ConfigGet` / `ConfigSet`）、Cron（`ScheduleCronCreate` / `ScheduleCronDelete` / `ScheduleCronList`）、Sleep（`Sleep`）。
- `NexusStorage.cronJobs` 新表 schema migration（如不存在）；cron 触发时启动**新** session，走 `task-scope-and-evidence-scope-governance-plan.md` 的 `task_scope_declared` 守门。
- `ConfigSet` 写完必须重新加载 `ConfigManager` + 重新解析 model metadata resolver（与 `babel-o-model-catalog-governance` 一致：显式 set 后必须 reload，**不** auto-switch）。
- Go TUI `/config` overlay（MVP，与 `/memory` 走同一通道）。
- 错误码（已登记）：`NOT_IN_GIT_REPO` / `WORKTREE_BRANCH_EXISTS` / `WORKTREE_PATH_NOT_FOUND` / `CONFIG_KEY_NOT_WRITABLE` / `CONFIG_KEY_NOT_FOUND` / `CONFIG_RELOAD_FAILED` / `SLEEP_ABORTED` / `SLEEP_DURATION_OUT_OF_RANGE` / `CRON_EXPRESSION_INVALID` / `CRON_JOB_NOT_FOUND` / `CRON_PERSIST_FAILED`。
- 实施**前**验证：`ConfigSet` / `Sleep` / `Cron` 必须有真实 regression 引用，否则按 `babel-o-p0-regression-focus` 降 P2。

### Phase 6：WebSearch provider 抽象 — 未开

- 入口：把 `src/tools/builtin/webSearch.ts` 重构为 provider 接口（`WebSearchProvider`） + 内置 `DuckDuckGoLiteProvider` + `McpBackedWebSearchProvider`。
- provider 选择顺序：MCP `mcp:web_search` > MCP `mcp:brave_search` > builtin `ddgLite`。
- 缺 provider 时返 `WEB_SEARCH_PROVIDER_UNAVAILABLE` diagnostic，**不**走 Bash `curl` 临时方案。
- 切换必须在 `~/.babel-o/log/embedded-nexus.log` 留 INFO 行（`web_search_provider=mcp:web_search` 等），不允许运行时静默切换。
- 错误码（已登记）：`WEB_SEARCH_PROVIDER_UNAVAILABLE`。
- 实施**后**验证：用户安装 `mcp:web_search` 后无感接管 DuckDuckGo Lite，behavior 一致；back-compat 守门（用户**未**注册 MCP 搜索时，行为与现在完全一致）。

### Phase 7：真实回归驱动 — 长期 Watch

P0 / P1 全部落地后转为 Watch（设计本就是 always-on）。本规划**不主动开新 P0 项**；后续只在真实 session 暴露以下 drift 时按 regression-first 重新开项（与 plan §Phase 7 一致）：

- 工具选择分歧（模型挑错工具造成超时 / 失败）。
- 同名 MCP 覆盖未被诊断日志记录。
- Plan 模式被绕过（Bash 强声明但未审批）。
- Cron 触发后 spawn 的新 session 没有走 `task_scope_declared`。
- `ConfigSet` 写完后 model metadata resolver 未重跑，模型继续用过时配置。
- Sleep 固定截断回潮（违反 [evidence-and-runtime-history.md](../history/evidence-and-runtime-history.md)）。
- test fixture 写入真实 `~/.babel-o/config.json`（CI 守门失败，与 [babel-o-test-config-isolation](../reference/) 记忆一致）。
