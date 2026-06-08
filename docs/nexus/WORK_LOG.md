# BabeL-O Nexus 工作记录

本文件只记录事实、验证和重要决策。不承载长期规划，长期规划写入各 TODO 文档。

## 2026-06-08 — Session Channel Phase E governed memory candidate MVP

- **用户请求**: 推进 Session Channel + Scoped Memory Phase E。
- **实现**:
  - 新增 `memoryCandidateGovernance` 最小治理模型：`memory_candidate` SessionMessage 在 API 创建时会被评估为 review-only candidate，写入 message metadata，不触发 EverCore 或长期记忆写入。
  - governance metadata 覆盖 scope classifier、evidence refs、confidence、staleness/supersession、approval requirement、blocked reasons、review reasons、write policy 与 `autoWrite=false`。
  - `allowMemoryWriteRequests=false` 不再禁止候选消息传输，而是禁止候选请求直接写入；缺少 evidence、project scope 缺 workspace evidence、low confidence、stale/superseded、requested write disabled 等都会进入 rejected governance metadata。
  - inbox context 会展示 `governance=<decision> scope=<scope> approval=<status>:<target> auto_write=false`，并明确 memory candidates 只是 review items，不是长期记忆写入。
  - 本切片仍不实现完整 background dreaming、不做 raw transcript sharing、不把跨 session 消息当直接用户指令、不自动写入高影响项目事实。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-phase-e-test-config.json npx tsx --test test/session-channel.test.ts test/context-assembler.test.ts`：61/61 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-phase-e-typecheck-config.json npm run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-phase-e-format-config.json npm run format:check` 通过。
  - `git diff --check` 通过。

## 2026-06-08 — Session Channel scoped diagnostics 与可行性回归

- **用户请求**: 继续推进 Session Channel + Scoped Memory 的 Phase D user/channel scoped，并尝试测试 session-to-session 是否真实可行。
- **实现**:
  - `assembleContext()` 现在会输出 `scopedMemoryDiagnostics` 聚合分项：现有 MemoryProvider diagnostics 保留 project/user/unknown scope；session inbox 会形成 `provider=session-channel`、`scope=channel`、`namespaceId=<channelId>`、`isolationKey=channelId` 的 budget diagnostics。
  - `analyzeContext()`、HTTP `/v1/sessions/:sessionId/context`、CLI `/context` 与 expanded context view 均暴露 `scopedMemory[]`，可同时观察 project/user/channel memory 的 hits、injected/budget、namespace 与 isolation key。
  - 新增 user-scoped MemoryProvider fixture 与 channel-scoped inbox fixture，验证 user memory diagnostics 表达和 channel inbox budget diagnostics 不改变 EverCore projectId 隔离边界。
  - 新增 SessionChannel API→Inbox→Context focused regression：两个已存在 session 创建 `workspace_pair` channel 后，session A 发送 typed `handoff` 到 session B；session B 的 context API 和 `assembleContext()` 可看到 non-cacheable collaboration context；ack 后该 channel message 不再进入 unread inbox 或 scoped channel diagnostics。
  - 本切片不实现 governed dreaming、不做 raw transcript sharing、不把跨 session 消息当成用户直接指令，也不自动写入长期记忆。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-scoped-channel-test-config.json npx tsx --test test/context-assembler.test.ts test/runtime.test.ts test/session-channel.test.ts`：158/158 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-scoped-channel-typecheck-config.json npm run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-scoped-channel-format-config.json npm run format:check` 通过。
  - `git diff --check` 通过。

## 2026-06-08 — AgentScheduler parent-child SessionChannel

- **用户请求**: 继续推进 P2/P3 Session Channel + Scoped Memory，优先实现 Phase C.2 AgentScheduler parent-child channel 可选集成。
- **实现**:
  - `ExploreAgentScheduler` spawn Explore/Review/Test child job 时会创建 `parent_child` SessionChannel，参与者为 parent session 与 child session，并把 `channelId` 写入 AgentJob metadata 与 child session metadata。
  - parent→child 会写入 `request_review` 或 `request_validation` typed message，child runtime 继续通过现有 `listSessionInbox()` context 注入看到该 collaboration context。
  - child job terminal 后会向 parent inbox 写入 `handoff` 或 `blocked` message，方便 parent session 获取结果摘要；`agent_job_event` 与 child transcript 查询仍是 lifecycle/source-of-truth，不被 SessionChannel 替代。
  - 本切片不实现 raw transcript sharing、不新增 agent transport、不实现 governed dreaming，也不改变任何 cwd/provider/profile/permission。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-agent-channel-test-config.json npx tsx --test test/agent-scheduler.test.ts test/session-channel.test.ts`：19/19 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-agent-channel-typecheck-config.json npm run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-agent-channel-format-config.json npm run format:check` 通过。
  - `git diff --check` 通过。

## 2026-06-08 — EverCore project-scoped MemoryProvider diagnostics

- **用户请求**: 继续推进 Session Channel + Scoped Memory Phase D，在 projectId namespace 治理后补 scoped MemoryProvider diagnostics。
- **实现**:
  - `MemoryProviderDiagnostics` 新增 `scope`、`namespaceId`、`namespaceSource` 与 `isolationKey`，并给 noop / mock provider 保留 `scope=unknown` 默认口径。
  - `EverCoreMemoryProvider` 接收 `projectIdSource`，检索成功、空 query 与检索失败 diagnostics 均标记 `scope=project`、`namespaceId=<projectId>`、`namespaceSource=<explicit|workspace|default>` 与 `isolationKey=projectId`。
  - `analyzeContext()` 与 HTTP `/v1/sessions/:sessionId/context` 的 diagnostic details 透出 long-term memory scope/namespace/isolation 字段。
  - CLI `/context` formatter 与 expanded context view 均展示 long-term memory provider、scope、namespace、source、isolation、hits、injected/budget、latency、truncated 与 error。
  - 本切片不新增 user/channel memory provider，不实现 governed dreaming，不改变 EverCore volatile / non-cacheable / non-authoritative hints 边界。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-scoped-memory-diagnostics-test-config.json npx tsx --test test/context-assembler.test.ts test/runtime.test.ts`：151/151 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-scoped-memory-diagnostics-typecheck-config.json npm run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-scoped-memory-diagnostics-format-config.json npm run format:check` 通过。
  - `git diff --check` 通过。

## 2026-06-08 — EverCore workspace projectId namespace 派生

- **用户请求**: 继续推进 Phase D，在默认 projectId 诊断之后补 project/workspace identity 隔离能力。
- **实现**:
  - 新增 opt-in `BABEL_O_EVERCORE_PROJECT_ID_MODE=workspace`；未显式配置 `BABEL_O_EVERCORE_PROJECT_ID` 时，BabeL-O 会从 workspace git root（优先）或 cwd 派生稳定 projectId：`<sanitized-root-name>-<sha256(root).slice(0,12)>`。
  - `configureEverCoreFromEnv()` 支持接收 workspace cwd；service mode 使用 `BABEL_O_WORKSPACE ?? process.cwd()`，embedded client 与 local run flow 使用当前 workspace cwd。
  - 显式 `BABEL_O_EVERCORE_PROJECT_ID` 仍最高优先级；默认行为仍保持 `projectId=default` 并输出既有 `EVERCORE_PROJECT_ID_DEFAULT` guidance。
  - runtime status namespace diagnostics 继续标记 Layer 2 Project memory 使用 `projectId` 隔离、`sessionScoped=false`，workspace 派生时 `projectIdSource=workspace` 且不报警。
  - 本切片不实现 dreaming，不把 Project memory 改为 sessionId 隔离，也不改变 EverCore volatile / non-cacheable / non-authoritative hints 边界。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-evercore-workspace-namespace-test-config.json npx tsx --test test/runtime.test.ts`：100/100 通过。

## 2026-06-08 — EverCore projectId namespace 诊断

- **用户请求**: 按规划继续推进 Layer 2 Project memory 隔离治理；Project memory 不按 sessionId 隔离，应做 projectId namespace 治理。
- **实现**:
  - `EverCoreRuntimeConfig` 记录 `projectIdSource`，区分显式 `BABEL_O_EVERCORE_PROJECT_ID` 与默认 `projectId=default`。
  - `/v1/runtime/status` 的 EverCore status 新增 `namespace` diagnostics，明确 Layer 2 Project memory 的隔离 key 是 `projectId`，`sessionScoped=false`。
  - EverCore 启用且仍使用默认 projectId 时输出 `EVERCORE_PROJECT_ID_DEFAULT` warning 与 guidance，提示为每个项目设置 `BABEL_O_EVERCORE_PROJECT_ID`，或等待后续 cwd/git-root 派生 namespace；禁用 EverCore 时不报警。
  - 继续保持 EverCore memory 为 volatile / non-cacheable / non-authoritative hints，不替代 SQLite/session/event/tool trace 事实源；本切片不实现 dreaming，也不把 Project memory 改成 sessionId 隔离。
  - `TODO.md`、`active/TODO_runtime.md` 与 `DONE.md` 已同步：默认 projectId 诊断收口，cwd/git-root 派生 namespace 与 scoped MemoryProvider 继续留作 Phase D 后续。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-evercore-namespace-test-config.json npx tsx --test test/runtime.test.ts`：100/100 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-evercore-namespace-typecheck-config.json npm run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-evercore-namespace-format-config.json npm run format:check` 通过。
  - `git diff --check` 通过。

## 2026-06-08 — SessionChannel Phase C.1 CLI/TUI Inbox 可见化

- **用户请求**: 根据后续优先级建议推进 Session Channel Phase C，让 unread inbox / ack / handoff 在 CLI/TUI 中可见、可操作。
- **实现**:
  - `NexusClient` 与 `EmbeddedNexusClient` 新增 `listSessionInbox()` / `ackSessionMessage()`，复用已有 `/v1/sessions/:sessionId/inbox` 与 `/ack` API。
  - `bbl sessions inbox <sessionId>` 支持展示 unread inbox，`--include-acknowledged` 可包含已 ack 消息，`--json` 保留 raw response；`bbl sessions ack <sessionId> <messageId>` 可确认单条 inbox message。
  - `bbl chat` 新增 `/inbox`、`/inbox all` 与 `/inbox ack <messageId>` slash 入口，并同步 slash palette、autosuggestion 与 help panel；展示 message id、createdAt、status、type、priority、from/to/broadcast、channel、content 与 evidence refs。
  - Inbox 展示继续声明跨 session 消息只是 collaboration context，需要验证证据后再行动；本次不做 raw transcript sharing、不实现完整 dreaming，也不把 AgentScheduler parent-child lifecycle 替换为 channel。
  - 新增 `test/sessions-command.test.ts` 覆盖 `sessions inbox/ack` 注册与 formatter，`test/completer.test.ts` 补 `/inbox` completion 元数据；新测试已加入默认 `npm test` 列表。
  - `TODO.md`、`active/TODO_runtime.md` 与 `DONE.md` 已同步 Phase C.1 收口，AgentScheduler parent-child channel 仍作为 Phase C.2 可选后续。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-session-channel-phase-c-test-config.json npx tsx --test test/sessions-command.test.ts test/completer.test.ts test/session-channel.test.ts`：23/23 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-session-channel-phase-c-typecheck-config.json npm run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-session-channel-phase-c-format-config.json npm run format:check` 通过。
  - `git diff --check` 通过。

## 2026-06-08 — SessionChannel + Scoped Memory MVP

- **用户请求**: 新增 Session-to-Session memory channel 设计文档，并先实现最小 `SessionChannel` + Inbox，不一开始做完整 dreaming。
- **实现**:
  - 新增 `docs/nexus/reference/session-to-session-memory-channel-plan.md`，明确 session = workspace runtime state、project/workspace memory 隔离、user memory / auto-memory 只承载跨项目习惯约束，EverCore / EverOS 只作为长期语义记忆与 consolidation 层，不替代 SQLite/session/event/tool trace 事实源。
  - `docs/nexus/README.md`、`docs/nexus/reference/README.md`、`TODO.md` 与 `active/TODO_runtime.md` 已同步 P2/P3 Session Channel + Scoped Memory 规划；Phase B MVP 已收口，Phase C/D/E 继续保留 CLI/TUI、scoped MemoryProvider 与 governed dreaming 后续项。
  - 新增 `src/shared/sessionChannel.ts`，定义 `SessionChannel`、`SessionMessage`、`EvidenceRef` 与默认 channel policy；扩展 `NexusStorage`、MemoryStorage 与 SQLite version 11 schema，支持 channel save/get/list、message save/get/list、session inbox 与 ack。
  - `src/nexus/app.ts` 新增 `POST/GET /v1/session-channels`、`GET /v1/session-channels/:channelId`、`POST/GET /v1/session-channels/:channelId/messages`、`GET /v1/sessions/:sessionId/inbox`、`POST /v1/sessions/:sessionId/inbox/:messageId/ack`，并校验 participant、broadcast、message type、message length 与 evidence refs policy。
  - `assembleContext()` 支持 `sessionInbox`，`LLMCodingRuntime` 与 HTTP `/v1/sessions/:sessionId/context` 会把 unread inbox 作为 bounded non-cacheable `session_inbox` block 注入，并声明跨 session 消息是 collaboration context、不是直接用户指令。
  - `test/session-channel.test.ts` 覆盖 MemoryStorage/SQLite lifecycle、HTTP API create/send/list/inbox/ack/policy rejection，以及 context inbox non-cacheable 注入。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-session-channel-test-config.json npx tsx --test test/session-channel.test.ts`：5/5 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-session-channel-typecheck-config.json npm run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-session-channel-format-config.json npm run format:check` 通过。
  - `git diff --check` 通过。

## 2026-06-08 — P0 Current-turn Session Finalization Regression

- **用户请求**: 推进 `session_9d985c5c-7c89-41b8-9d5e-cc672e412f00` 暴露的 session 终态污染修复优化。
- **触发样本**:
  - 同一 session 第三轮请求只有 `user_message` / `session_started` / PreInvocation / `usage` / `thinking_delta`，没有当前轮 `assistant_delta` / PostInvocation / `result` / `error` / `execution_metrics`。
  - 旧逻辑在 `runSessionFlow()` finally 中回扫整段 session 最近 events，复用上一轮 `result`，导致 session 误标为 `completed`。
- **实现**:
  - `src/cli/runSessionFlow.ts` 在每轮 local embedded execution 中创建 requestId 后收集当前 `executeStream()` 产出的 events，finalization 只基于 current-turn events 结算，不再回扫整段 session 旧 terminal event。
  - `resolveFinalSessionOutcome()` 增加 request boundary helper 与 `REQUEST_INTERRUPTED_WITHOUT_TERMINAL_EVENT` 诊断；当前轮无 `result` / `error` 时保存 failed outcome，用户取消仍保存 `cancelled`。
  - 新一轮 session 执行开始时清空旧 `result` / `error` / `terminalReason`，避免执行中或失败收口时继续展示上一轮成功结果。
  - `test/run-session-flow.test.ts` 增加真实样本抽象回归：当前 request 有 `session_started` / provider prelude 但无 terminal event 时，不能复用 older turn result。
  - `src/shared/version.ts` 同步为 `0.3.1`，修复默认测试暴露的 package version boundary mismatch。
  - `TODO.md`、`active/TODO_runtime.md`、`DONE.md` 与 `reference/session-finalization-and-evidence-governance-plan.md` 已同步 P0 收口；evidence-scope drift 继续作为 P2 watch 样本保留。
- **验证**:
  - `BABEL_O_CONFIG_FILE="/tmp/babel-o-test-config-run-session-flow.json" npx tsx --test --test-concurrency=1 "/Users/tangyaoyue/DEV/BABEL/BabeL-O/test/run-session-flow.test.ts"`：3/3 通过。
  - `npm run typecheck` 通过。
  - `npm run format:check` 通过。
  - `npm test`：628/628 通过。

## 2026-06-07 — EverCore Phase B Internal MemoryProvider

- **用户请求**: 继续推进 P3 EverCore / 长期语义记忆。
- **实现**:
  - 新增 `src/runtime/memoryProvider.ts`，抽象 `MemoryProvider` / `NoopMemoryProvider` / `EverCoreMemoryProvider`，并把 EverOS 当前 `/api/v1/memory/search` 的 typed response（episodes / profiles / agent_cases / agent_skills / unprocessed_messages）解析为 bounded memory hits。
  - `assembleContext()` 支持可选 `memoryProvider`，把检索结果追加为 `long_term_memory` system prompt block；该 block 明确为 volatile / non-cacheable，并提示模型将其视为 background hints 而非 authoritative project state，检索失败只记录 diagnostics、不进入 provider-visible context。
  - `LLMCodingRuntime`、`runtimePipeline.refreshRuntimeContextState()`、`createDefaultNexusRuntime()` 已接入可选 provider；Nexus server、embedded client 与本地 CLI flow 都复用 `configureEverCoreFromEnv()`，仅在 EverCore healthy 时创建 provider。
  - `test/context-assembler.test.ts` 覆盖 volatile 注入、失败不污染上下文、当前 EverOS typed search response parser；Phase A status/session-close 回归保持通过。
  - `TODO.md`、`active/TODO_runtime.md` 与 `DONE.md` 已同步 Phase B 收口，后续 P3 转入 Phase C context budget / diagnostics。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-evercore-phaseb-context-test-config.json npx tsx --test test/context-assembler.test.ts`：50/50 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-evercore-phaseb-runtime-test-config.json npx tsx --test test/runtime.test.ts`：96/96 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-evercore-phaseb-typecheck-config.json npm run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-evercore-phaseb-format-config.json npm run format:check` 通过。
  - `git diff --check` 通过。

## 2026-06-06 — docs/nexus 分层归档整理

- **用户请求**: 根据源码核对结果，重新整理归档 `docs/nexus`，清理过时文档，并保持权威文档中心为最新状态。
- **实现**:
  - 调整 `.gitignore`：继续默认忽略 `docs/` 根目录技术细节文档，但显式放行 `docs/nexus/**/*.md`，让 Nexus 权威文档中心能够被 Git 正常追踪；`docs/releases/*.md` 放行规则保持不变。
  - 删除 `docs/nexus/.DS_Store`。
  - 新增 `docs/nexus/active/`、`docs/nexus/reference/`、`docs/nexus/archive/` 三层结构。
  - 将当前仍作为优先级来源的专项 TODO 移入 `active/`：Runtime、Agents、Provider、TUI、Performance、Cleanup。
  - 将仍有架构约束价值的长期方案移入 `reference/`：Context/Sub-agent、Tool Granularity/Evidence、Go Runner。
  - 将已完成或被根索引取代的历史专项移入 `archive/`：CLI 导航、Tool Result Budget、Intake Classifier、Tool-call Text Leakage。
  - 新增 `active/README.md`、`reference/README.md`、`archive/README.md`，明确各层职责和维护规则。
  - 更新 `README.md`、`TODO.md`、`DONE.md` 与相关文档链接，修正移动后的相对路径。
- **验证**:
  - 自定义 Node 链接检查通过：20 个 markdown 文件的相对链接均存在。
  - `git diff --check -- .gitignore docs/nexus` 通过。

## 2026-06-06 — P2 TUI Vim Mode

- **用户请求**: 推进 P2 Advanced CLI/TUI 中的 vim mode。
- **实现**:
  - 新增 `src/cli/vimMode.ts` 纯 reducer，`BABEL_O_VIM_MODE=1` 时启用 opt-in vim input mode，默认关闭。
  - `src/cli/commands/chat.ts` 在 raw `stdin.emit('data')` 阶段、idle 且无 overlay 时接入 vim reducer，normal mode 会拦截 `h`/`l`/`0`/`$` 移动、`x`/Backspace 删除、`i`/`a` 回到 insert，避免命令键被 readline 当文本写入。
  - Esc 在 insert mode 切到 normal mode；normal mode Enter 继续交给 readline 原生提交流程，不手动 resolve prompt；Ctrl+C、Ctrl+E、Ctrl+O、slash palette、permission panel、overlay、paste 与执行中 Esc cancellation 保持既有路径。
  - `test/tui-input.test.ts` 覆盖默认关闭、insert/normal 切换、normal mode 移动/删除不插入命令文本、Enter 交回 readline。
  - `TODO.md`、`TODO_tui.md` 与 `DONE.md` 已同步 vim mode 已收口，P2 Advanced CLI/TUI 当前无打开功能项。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-vim-mode-test-config.json npx tsx --test test/tui-input.test.ts` 通过，38/38 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-vim-mode-typecheck-config.json npm run typecheck` 通过。

## 2026-06-06 — P2 TUI Image Reference Metadata

- **用户请求**: 推进 P2 Advanced CLI/TUI 中的 image paste。
- **实现**:
  - `src/cli/attachmentReferences.ts` 扩展图片引用识别：图片路径、`@image:path` 与粘贴的 `file://` 图片 URI 会解析为 attachment reference。
  - 图片引用只记录 `kind: image`、bytes 与 mimeType，并在 `<attached_file_references>` block 中输出 `status="image"` metadata；不读取/嵌入图片 bytes，不生成 base64，不改变 Nexus event schema、provider message schema 或 provider 多模态注入语义。
  - `test/attachment-references.test.ts` 补充 `@image:` 与 `file://` 图片 URI regression，确认图片不会被作为文本或 binary 内容嵌入。
  - `TODO.md`、`TODO_tui.md` 与 `DONE.md` 已同步 image reference metadata 已收口，Advanced CLI/TUI 剩余项缩小为 vim mode。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-image-reference-test-config.json npx tsx --test test/attachment-references.test.ts test/tui-input.test.ts test/path-mention.test.ts` 通过，42/42 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-image-reference-typecheck-config.json npm run typecheck` 通过。

## 2026-06-06 — P2 TUI File Attachment References

- **用户请求**: 推进 P2 Advanced CLI/TUI 中的 image paste / file attachment references。
- **实现**:
  - 新增 `src/cli/attachmentReferences.ts`，解析 `@path` / `@file:path` 当前 prompt 附件引用，支持 quoted path、重复去重、workspace boundary、单文件/总预算与引用数量上限。
  - `src/cli/commands/chat.ts` 在展开 paste placeholder 后、非 slash command 提交前追加 `<attached_file_references>` prompt block；成功的小文本文件会嵌入内容，目录、缺失路径、workspace escape、图片/二进制和超预算文件只记录状态。
  - 本切片不改变 Nexus event schema、provider message schema 或多模态 image 注入语义；image paste 保留为后续单独项。
  - `test/attachment-references.test.ts` 覆盖文本附件嵌入、quoted `@file:`、图片/二进制、workspace escape、缺失/超预算、symbol/diagnostic mention 排除和 cap；该测试已加入默认 `npm test` 列表。
  - `TODO.md`、`TODO_tui.md` 与 `DONE.md` 已同步 file attachment references 已收口，Advanced CLI/TUI 剩余项缩小为 vim mode 与 image paste。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-attachment-test-config.json npx tsx --test test/attachment-references.test.ts test/tui-input.test.ts test/path-mention.test.ts` 通过，41/41 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-attachment-typecheck-config.json npm run typecheck` 通过。

## 2026-06-06 — P2 TUI LSP Context Mention

- **用户请求**: 推进 P2 Advanced CLI/TUI 中的 LSP context picker。
- **实现**:
  - 新增 `src/cli/lspContextMention.ts`，提供 CLI 侧轻量语义 context mention 索引；`@symbol:` / `@sym:` 补全 TypeScript/JavaScript/Go 的 class/interface/type/function/const/method 等 symbol 引用，`@diagnostic:` / `@diag:` 补全 TODO/FIXME/ts-ignore/eslint-disable/merge-conflict marker 等诊断引用。
  - `src/cli/completer.ts` 接入 LSP context mention，并保持 path mention 作为 fallback；补全结果以普通 prompt 文本插入，例如 `@symbol:src/runtime/contextForker.ts#ContextForker`，不改变 runtime ownership、不启动外部 LSP server、不新增模型可见 LSP 工具。
  - `test/lsp-context-mention.test.ts` 覆盖 lazy index、symbol/diagnostic completion、dependency tree skip、alias、entry cap 与 `makeCompleter()` 集成；该测试已加入默认 `npm test` 列表。
  - `TODO.md`、`TODO_tui.md` 与 `DONE.md` 已同步 LSP context mention 已收口，Advanced CLI/TUI 剩余项缩小为 vim mode 与 image paste / file attachment references。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-lsp-context-test-config.json npx tsx --test test/lsp-context-mention.test.ts test/completer.test.ts test/path-mention.test.ts` 通过，22/22 tests pass。
  - `npm run typecheck` 通过。

## 2026-06-06 — P2 Tool Granularity Grep bundled ripgrep

- **用户请求**: 将 ripgrep 依赖附加到项目安装链路，并直接修复 `Grep` 对系统 `rg` 的依赖问题。
- **实现**:
  - `package.json` / `package-lock.json` 新增 optional dependency `@vscode/ripgrep`，用户安装 BabeL-O 时优先获得 bundled `rg`，optional 安装失败或被 omit 时不阻断主流程。
  - `src/tools/builtin/grep.ts` 的执行优先级调整为 bundled ripgrep → system `rg` → JavaScript `RegExp` fallback。
  - `Grep` schema 显式支持 `pathMatches`，ripgrep 路径通过 `--glob` 过滤，fallback 也使用 `minimatch` 做同等文件 glob 过滤。
  - fallback 修正绝对路径解析与输出路径格式，继续保留 fallback mode / no-result / invalid-regex diagnostics。
  - `test/grep-tool.test.ts` 覆盖 `pathMatches`、schema 与 `ContextForker|forkContext|contextFork` alternation 查询。
- **验证**:
  - `BABEL_O_CONFIG_FILE="/tmp/babel-o-test-config-grep.json" BABEL_O_TEST_CONFIG_WRITE_GUARD=1 npm exec -- tsx --test --test-concurrency=1 test/grep-tool.test.ts test/tool-prompt.test.ts` 通过，5/5 tests pass。
  - `BABEL_O_CONFIG_FILE="/tmp/babel-o-test-config-typecheck.json" BABEL_O_TEST_CONFIG_WRITE_GUARD=1 npm --prefix "/Users/tangyaoyue/DEV/BABEL/BabeL-O" run typecheck` 通过。

## 2026-06-06 — P2 Tool Granularity Phase B.6

- **用户请求**: 推进 Phase B.6 的 Bash timeout / SIGTERM recoverable failure。
- **触发样本**: `session_122f07b9-8ed5-4b2a-a949-e0de0b9fcb91`，模型退回全仓库 Bash grep 后被 SIGTERM，旧路径把普通 shell timeout 升级为 `TOOL_ERROR` / failed session。
- **实现**:
  - `src/tools/builtin/bash.ts` 将普通 command timeout / SIGTERM 识别为 recoverable command failure，返回 `success=false` 的 tool result，不再 throw 到 session fatal path。
  - Bash timeout 输出包含 `code: COMMAND_TIMEOUT`、`timedOut: true`、`signal`、stdout/stderr 摘要与 command summary；Bash-as-file-discovery guidance 仍会附加在 timeout failure 结果上。
  - 外部 `AbortSignal` 已 abort 时仍不吞掉 request cancellation，保留 runtime timeout/cancel path。
  - `parseLocalRuntimeIntent()` 修复 `Bash: {json}` 形式的 tool shortcut，避免将 tool name 解析成 `Bash:`，用于覆盖 runtime 层 timeout fixture。
  - `test/runtime.test.ts` 补充 direct Bash timeout、discovery timeout guidance、runtime `tool_completed(success=false)` 与 parser shortcut regression。
- **验证**:
  - `BABEL_O_CONFIG_FILE="/tmp/babel-o-bash-timeout-runtime-config-2.json" node --import tsx --test "/Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts"` 通过，91/91 tests pass。
  - `BABEL_O_CONFIG_FILE="/tmp/babel-o-bash-timeout-typecheck-config.json" npm --prefix "/Users/tangyaoyue/DEV/BABEL/BabeL-O" run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE="/tmp/babel-o-bash-timeout-format-config.json" npm --prefix "/Users/tangyaoyue/DEV/BABEL/BabeL-O" run format:check` 通过。
  - `git -C "/Users/tangyaoyue/DEV/BABEL/BabeL-O" diff --check` 通过。

## 2026-06-06 — P2 Tool Granularity Phase B.7

- **用户请求**: 推进 Bash-as-file-discovery 降级治理，并复查 Grep fallback 能力。
- **复查结论**:
  - `src/tools/builtin/grep.ts` 的 TypeScript fallback 已使用 JavaScript `RegExp` scan，支持 `ContextForker|forkContext|contextFork` alternation，并对 fallback mode、no-result、invalid-regex 输出 diagnostics。
  - `test/runtime.test.ts` 已覆盖 `rg` unavailable fixture、direct `grepTool` fallback alternation 命中与 no-result diagnostics。
- **实现**:
  - 新增 `src/shared/bashDiscoveryGuidance.ts`，识别 `ls`、`ls -R`、`find`、`tree`、recursive grep 与 `rg` 这类 read-only file discovery 命令，并生成 `BASH_AS_FILE_DISCOVERY` structured guidance。
  - `src/tools/builtin/bash.ts` 在 Bash 成功结果和 recoverable failure 结果中追加 `guidance` 字段，不污染 `stdout` / `stderr`，提示优先使用 `ListDir` / `Glob` / `Grep` / `Read`，必要时缩小 Bash path。
  - `src/runtime/classifier.ts` 对 `find`、`tree`、recursive grep/ls、`rg` 等 broad discovery Bash 命令返回 manual-review reason 并包含同一替代工具提示；普通 `ls` 保持既有低风险执行语义，但 Bash result 仍输出 guidance。
  - `test/classifier.test.ts` 与 `test/runtime.test.ts` 补充 focused regression，覆盖 broad discovery classifier reason、普通 `ls` 输出 guidance 与 Grep fallback 既有能力。
- **验证**:
  - `BABEL_O_CONFIG_FILE="/tmp/babel-o-bash-discovery-runtime-config.json" node --import tsx --test "/Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts"` 通过，88/88 tests pass。
  - `BABEL_O_CONFIG_FILE="/tmp/babel-o-bash-discovery-classifier-config.json" node --import tsx --test "/Users/tangyaoyue/DEV/BABEL/BabeL-O/test/classifier.test.ts"` 通过，5/5 tests pass。
  - `BABEL_O_CONFIG_FILE="/tmp/babel-o-bash-discovery-typecheck-config.json" npm --prefix "/Users/tangyaoyue/DEV/BABEL/BabeL-O" run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE="/tmp/babel-o-bash-discovery-format-config.json" npm --prefix "/Users/tangyaoyue/DEV/BABEL/BabeL-O" run format:check` 通过。
  - `git -C "/Users/tangyaoyue/DEV/BABEL/BabeL-O" diff --check` 通过。

## 2026-06-06 — P2 Tool Granularity Phase B.5

- **用户请求**: 推进 P2 Tool Granularity Phase。
- **触发样本**: `session_122f07b9-8ed5-4b2a-a949-e0de0b9fcb91`。
- **实现**:
  - `src/tools/builtin/grep.ts` 的 TypeScript fallback 不再做 case-insensitive literal substring scan；当 `rg` 不可用时改用 JavaScript `RegExp` scan，覆盖 `ContextForker|forkContext|contextFork` 这类基础 regex alternation locator 查询。
  - fallback 命中结果追加 `Grep fallback` mode hint，提醒其仍是 locator-only evidence，需要用 `Read` 做 source understanding。
  - fallback no-result 不再返回空字符串，而是输出 no-result diagnostics，区分 fallback locator 证据与完整源码证明；invalid regex 也返回明确 diagnostics，避免误导模型退回 broad Bash scan。
  - `test/runtime.test.ts` 补充 `rg` unavailable fixture 与 direct `grepTool` fallback regression，覆盖 alternation 命中与 no-result diagnostics。
- **验证**:
  - `BABEL_O_CONFIG_FILE="/tmp/babel-o-grep-fallback-runtime-config.json" node --import tsx --test "/Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts"` 通过，88/88 tests pass。
  - `BABEL_O_CONFIG_FILE="/tmp/babel-o-grep-fallback-typecheck-config.json" npm --prefix "/Users/tangyaoyue/DEV/BABEL/BabeL-O" run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE="/tmp/babel-o-grep-fallback-format-config.json" npm --prefix "/Users/tangyaoyue/DEV/BABEL/BabeL-O" run format:check` 通过。
  - `git -C "/Users/tangyaoyue/DEV/BABEL/BabeL-O" diff --check` 通过。

## 2026-06-06 — P2 Tool Granularity Follow-up Planning

- **触发样本**: `session_122f07b9-8ed5-4b2a-a949-e0de0b9fcb91`。
- **现象**:
  - `ListDir` 已正常可见并成功执行，provider invocation diagnostics 显示 `toolCount=8` / `visibleToolCount=8`。
  - 第二轮分析 `ContextForker` 时，内置 `Grep` 对 `ContextForker|forkContext|contextFork` 返回空结果；模型退回 Bash `grep -rln -E`，第一次限定 `src/test` 成功，第二次扩大到整个 repo 后被 SIGTERM，runtime 产出 `TOOL_ERROR` 并使 session failed。
- **规划同步**:
  - `TODO_runtime.md` 与 `tool-granularity-and-evidence-governance-plan.md` 新增未收口项：`Grep` fallback regex parity / no-result diagnostics、Bash timeout recoverable failure、Bash-as-file-discovery 降级治理。
  - `TODO.md` 总控 P2 工具粒度行已同步该真实回归优先级；本次只登记规划，未修改 runtime 代码。
- **验证**:
  - 文档同步，无测试运行。

## 2026-06-06 — P2 Tool Granularity / ListDir

- **用户请求**: 直接实现 `ListDir`，并明确工具职责细分，避免多工具之间存在模糊边界。
- **实现**:
  - 新增 TypeScript builtin `ListDir`：read-only、workspace-safe、默认 `maxDepth=1`、最大 `maxDepth=2`、stable directories-first ordering、跳过 dependency/build/cache 目录，输出 entries/counts/truncated/skippedDirs/guidance。
  - 默认工具注册、local runtime `listdir` / `ls` 显式命令、system prompt、permission classifier、Explore/Review/Test Agent profiles、AgentScheduler allowlist、ContextForker 和 Agent tool prompt 均同步 `ListDir` / `Glob` / `Grep` / `Read` 职责边界。
  - Go Remote Runner read-only backend capabilities 同步为 `ListDir` / `Glob` / `Grep` / `Read`，并实现 Go `ListDir` structured inventory，避免远程 Explore Agent 退化。
  - 文档口径更新为：`ListDir` 已落地；`Search` 不新增；`define_subagent` / `invoke_subagent` 不新增；后续只保留 Source Coverage Ledger / evidence hint 等真实回归驱动治理项。
- **验证**:
  - `BABEL_O_CONFIG_FILE="/tmp/babel-o-listdir-test-config.json" BABEL_O_TEST_CONFIG_WRITE_GUARD=1 npm --prefix "/Users/tangyaoyue/DEV/BABEL/BabeL-O" exec -- tsx --test --test-concurrency=1 "/Users/tangyaoyue/DEV/BABEL/BabeL-O/test/list-dir-tool.test.ts" "/Users/tangyaoyue/DEV/BABEL/BabeL-O/test/agent-profiles.test.ts" "/Users/tangyaoyue/DEV/BABEL/BabeL-O/test/agent-scheduler.test.ts" "/Users/tangyaoyue/DEV/BABEL/BabeL-O/test/tool-prompt.test.ts"` 通过，22/22 tests pass。
  - `go -C "/Users/tangyaoyue/DEV/BABEL/BabeL-O/runners/go-runner" test ./...` 通过。

## 2026-06-06 — P2 TUI Worktree Flow

- **用户请求**: 推进 P2 TUI worktree flow。
- **实现**:
  - `src/cli/renderEvents.ts` 新增只读 Worktree Flow panel，从现有 `task_session_event` 聚合 `worktree_created`、`worktree_merged`、`worktree_merge_conflict` 与 `worktree_recovery_action`。
  - Worktree panel 展示 isolated/merged/conflict/recovery 状态、task id/title、worktree/preserved path、冲突文件、recovery status、selected action 和 CLI 操作提示：`bbl sessions worktree-recovery <sessionId> <taskId> continue|abandon|keep`。
  - `formatTaskSessionEvent()` 对 worktree lifecycle/recovery 事件输出专项摘要，不再只显示通用 payload summary。
  - Task Status Board 会把 `metadata.worktreeRecovery` 识别为 `worktree`，冲突/恢复任务不会丢失隔离上下文。
  - 本切片只增强 TUI observability，不改变 Nexus-owned worktree lifecycle、review、merge/reject/recovery flow，也不启用 write-capable child agent。
- **验证**:
  - `BABEL_O_CONFIG_FILE="/tmp/babel-o-worktree-tui-renderer-config.json" node --import tsx --test "/Users/tangyaoyue/DEV/BABEL/BabeL-O/test/tui-renderer.test.ts"` 通过，37/37 tests pass。
  - `BABEL_O_CONFIG_FILE="/tmp/babel-o-worktree-tui-typecheck-config.json" npm --prefix "/Users/tangyaoyue/DEV/BABEL/BabeL-O" run typecheck` 通过。

## 2026-06-06 — P2 Permission Pending State Backend Evaluation

- **用户请求**: 推进 P2 Permission pending state 持久 backend 评估。
- **结论**:
  - 当前不实现 SQLite / Nexus-owned pending permission backend；现有 `PendingPermissionRegistry` 的 backend seam 是 process-live resolver registry，不是可跨进程恢复的 durable state。
  - `permission_request` event 与 permission audit 已持久化，但 HTTP/WS `/v1/execute`、embedded local flow 与 runtime tool loop 都依赖当前进程中的 async iterator / pending promise。进程重启后只有历史事件，没有可恢复的 provider/tool-loop continuation；单独持久化 pending entry 会误导为可恢复。
  - 真正 durable backend 需要先设计 resumable execution：session phase `waiting_permission`、pending tool call snapshot、approval metadata、permission response event/audit 写入、resume/timeout/cancel 状态机，以及重启后继续或显式失败策略。
  - 当前保持 in-memory backend，并继续依靠 session close cleanup、TTL sweep、HTTP/WS approval endpoint 与 permission-flow 回归守住单进程 service/embedded 行为。
- **验证**:
  - 本次为架构评估和文档收口，未改 runtime 代码，未运行测试。

## 2026-06-06 — P1 Intake Classifier Phase 4

- **用户请求**: 推进 P1 Phase 4：`TOOL_CALL_SUPPRESSED_BY_USER_INTENT` retry。
- **实现**:
  - `reduceProviderTurnOutcome()` 新增 `suppressedToolRetryCount` / `maxSuppressedToolRetries`，respond-only 场景下 provider 首次尝试工具调用时输出 `TOOL_CALL_SUPPRESSED_BY_USER_INTENT`，记录 attempted tools 与 retry diagnostics，并注入一次 retry prompt。
  - `LLMCodingRuntime` 新增 `MAX_SUPPRESSED_TOOL_RETRIES = 1` 与 loop-level retry state；首轮 pause/greeting 仍隐藏工具，retry 后工具重新可见，模型若仍坚持调用工具则允许进入正常 tool execution。
  - 将 `suppressToolsForCurrentIntent` 统一用于 provider request assembly、tool-shaped text leak guard 与 reducer，避免 retry 后工具已可见但 leakage phase 仍误判为 `respond_only`。
  - 更新 MiniMax respond-only 回归：首轮工具调用仍被 suppress，第二轮 provider request 携带工具定义；新增集成回归覆盖第二轮 Bash 调用实际执行并返回最终回答。
- **验证**:
  - `cd "/Users/tangyaoyue/DEV/BABEL/BabeL-O" && BABEL_O_CONFIG_FILE="/tmp/babel-o-intake-phase4-runtime-test-config.json" node --import tsx --test "test/runtime.test.ts"` 通过，88/88 tests pass。
  - `cd "/Users/tangyaoyue/DEV/BABEL/BabeL-O" && BABEL_O_CONFIG_FILE="/tmp/babel-o-intake-phase4-llm-test-config.json" node --import tsx --test "test/runtime-llm.test.ts"` 通过，57/57 tests pass。
  - `cd "/Users/tangyaoyue/DEV/BABEL/BabeL-O" && BABEL_O_CONFIG_FILE="/tmp/babel-o-intake-phase4-context-test-config.json" node --import tsx --test "test/context-regression.test.ts"` 通过，10/10 tests pass。
  - `npm --prefix "/Users/tangyaoyue/DEV/BABEL/BabeL-O" run typecheck` 通过。
  - `npm --prefix "/Users/tangyaoyue/DEV/BABEL/BabeL-O" run format:check` 通过。
  - `git -C "/Users/tangyaoyue/DEV/BABEL/BabeL-O" diff --check` 通过。

## 2026-06-06 — P1 Intake Classifier Phase 3

- **用户请求**: 继续推进 P1 Intake Classifier Phase。
- **实现**:
  - `shouldSuppressToolsForIntent()` 对 `status` intent 不再隐藏工具，即使 `requiresTools=false` / `actionHint=respond_only`。
  - `formatUserIntentGuidance()` 为纯 status 短问注入 prompt guidance：优先从现有上下文回答，只有确实需要验证时才运行命令，不启动多步工具链。
  - pause/greeting 继续硬抑制工具；respond-only tool-shaped text leakage 守门改用 greeting fixture 保持覆盖。
  - 更新 context-memory fallback 回归：`"还记得我刚刚问什么吗？"` 仍为 `status/respond_only/requiresTools=false`，但 provider request 保留工具定义并携带 guidance。
  - Phase 4 suppress retry 未实现，继续作为可选安全网。
- **验证**:
  - `cd "/Users/tangyaoyue/DEV/BABEL/BabeL-O" && BABEL_O_CONFIG_FILE="/tmp/babel-o-intake-phase3-test-config.json" node --import tsx --test "test/runtime-llm.test.ts"` 通过，56/56 tests pass。
  - `cd "/Users/tangyaoyue/DEV/BABEL/BabeL-O" && BABEL_O_CONFIG_FILE="/tmp/babel-o-intake-phase3-context-test-config.json" node --import tsx --test "test/context-regression.test.ts"` 通过，10/10 tests pass。
  - `npm --prefix "/Users/tangyaoyue/DEV/BABEL/BabeL-O" run typecheck` 通过。

## 2026-06-06 — P1 Intake Classifier Phase 1/2

- **用户请求**: 根据优先级建议继续推进 Intake Classifier 升级。
- **实现**:
  - `normalizeGuidancePolicy()` 对 `pause` / `greeting` 继续强制 respond-only，但对 `status` 不再覆盖 `requiresTools=true`；只有 `status` + `requiresTools=false` 继续归一为 `respond_only`。
  - intake model prompt 补充中英文 few-shot，区分纯状态问句（如“你在干什么”）与执行类请求（如“验证当前改动是否健康”“检查一下测试能不能过”“跑一下 lint”“check if tests pass”）。
  - 新增真实回归样本测试：当 intake 返回 `intent=status, requiresTools=true, actionHint=normal` 时，Bash 工具保持可见且不触发 `TOOL_CALL_SUPPRESSED_BY_USER_INTENT`。
  - 未实现 Phase 3/4：status 工具抑制降级为 prompt guidance 与可选 suppress retry 仍保留为后续项。
- **验证**:
  - `cd "/Users/tangyaoyue/DEV/BABEL/BabeL-O" && BABEL_O_CONFIG_FILE="/tmp/babel-o-intake-test-config.json" node --import tsx --test "test/runtime-llm.test.ts"` 通过，56/56 tests pass。
  - `npm --prefix "/Users/tangyaoyue/DEV/BABEL/BabeL-O" run typecheck` 通过。

## 2026-06-06 — P2 Advanced CLI/TUI: Prompt Suggestions & Theme

- **用户请求**: P2 Advanced CLI/TUI 剩余项推进。
- **实现**:
  - 新增 `src/cli/promptSuggestions.ts`，提供 `getPromptSuggestion(SessionHintState)` 基于 session 最近事件类型返回上下文 placeholder 提示。
  - `setupAutosuggestions` 接入 `sessionHintRef`，输入为空时在 boxed input 中展示 dim placeholder；agent running 时隐藏。
  - `chat.ts` 在每次 `runSessionFlow` 完成后从 `getSessionEvents()` 提取 hint state 更新 placeholder。
  - 新增 `src/cli/theme.ts`，`BABEL_O_THEME` 支持 `default` / `minimal` 两套主题。
  - Welcome card 品牌色改为从 `getTheme().brand` 获取。
  - 未恢复自动模型选择、fallback execution 或 silent switch。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-tui-prompt-theme-2.json npm exec -- tsx --test --test-concurrency=1 test/tui-input.test.ts` 通过，33/33 tests pass。
  - `npm run typecheck` 通过。
  - `npm run format:check` 通过。
  - `git diff --check` 通过。

## 2026-06-06 — P2 AgentLoop Worktree Helper Split

- **用户请求**: 根据优先级建议继续推进 P2 AgentLoop Maintainability。
- **实现**:
  - 新增 `src/nexus/agentLoopWorktree.ts`，承载 optimizer Git stash/pop、explicit-path commit、tracked rollback、Git status snapshot 记录与 in-place optimizer approval helper。
  - `src/nexus/agentLoop.ts` 改为导入这些 helper，并 re-export `GitStatusSnapshot` / `InPlaceOptimizerApprovalRequest` / `InPlaceOptimizerApprovalReason` 以保持 CLI import 兼容。
  - 保留 `runAgentLoop()` 主状态机在原文件，不拆 executor/critic/retry step，不改变 worktree merge/recovery、in-place hardening、structured output repair 或 benchmark 行为。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-agent-loop-helper-split-test.json "/Users/tangyaoyue/DEV/BABEL/BabeL-O/node_modules/.bin/tsx" --test --test-concurrency=1 "/Users/tangyaoyue/DEV/BABEL/BabeL-O/test/agent-loop.test.ts"` 通过，36/36 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-worktree-helper-split-test.json "/Users/tangyaoyue/DEV/BABEL/BabeL-O/node_modules/.bin/tsx" --test --test-concurrency=1 "/Users/tangyaoyue/DEV/BABEL/BabeL-O/test/worktree.test.ts"` 通过，7/7 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-agent-loop-benchmark-helper-split-test.json "/Users/tangyaoyue/DEV/BABEL/BabeL-O/node_modules/.bin/tsx" --test --test-concurrency=1 "/Users/tangyaoyue/DEV/BABEL/BabeL-O/test/agent-loop-benchmark.test.ts"` 通过，1/1 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-agent-loop-helper-split-typecheck.json npm --prefix "/Users/tangyaoyue/DEV/BABEL/BabeL-O" run typecheck` 通过。
  - `git diff --check` 通过。

## 2026-06-06 — P2 Worktree / Git Hardening

- **用户请求**: 推进 #1「P2 Worktree / Git Hardening」。
- **实现**:
  - `runAgentLoop()` 新增 `allowInPlaceOptimizer` 与 `confirmInPlaceOptimizer`：Git workspace 中 optimizer 非隔离 in-place task 默认 blocked，只有显式 opt-in 或 per-task confirmation 才会继续。
  - worktree 创建失败会记录 `worktree_create_failed`，并同样要求 opt-in/confirmation 后才允许 fallback 到 in-place，不再静默降级。
  - in-place optimizer task 会记录 `optimizer_in_place_approved` / `optimizer_in_place_blocked`，并在 task 前、task 后、commit/rollback/merge resolution 后记录 Git status snapshot。
  - `bbl optimize` 新增 `--allow-in-place-optimizer`，并支持 `BABEL_O_ALLOW_IN_PLACE_OPTIMIZER=1`；未 opt-in 时使用 per-task prompt。`gitCommit()` 仍只 stage explicit changed paths，不使用 `git add .`；代码路径不引入 `git reset --hard` 或 `git clean -fd`。
  - AgentLoop smoke / benchmark 对固定临时 workspace 或 mocked optimizer path 明确传入 in-place policy，避免新默认值改变 smoke/benchmark 语义。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-agent-loop-hardening-test.json "/Users/tangyaoyue/DEV/BABEL/BabeL-O/node_modules/.bin/tsx" --test --test-concurrency=1 "/Users/tangyaoyue/DEV/BABEL/BabeL-O/test/agent-loop.test.ts"` 通过，36/36 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-optimize-command-hardening-test.json "/Users/tangyaoyue/DEV/BABEL/BabeL-O/node_modules/.bin/tsx" --test --test-concurrency=1 "/Users/tangyaoyue/DEV/BABEL/BabeL-O/test/optimize-command.test.ts"` 通过，10/10 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-git-hardening-typecheck.json npm --prefix "/Users/tangyaoyue/DEV/BABEL/BabeL-O" run typecheck` 通过。

## 2026-06-06 — P2 TUI Multi-Agent Status View

- **用户请求**: 推进 #1：P2 TUI multi-agent status view。
- **实现**:
  - `src/cli/renderEvents.ts` 新增 `formatMultiAgentStatusView()` 纯渲染函数，统一展示 AgentScheduler `AgentJob` 与 AgentLoop sub-agent lifecycle 的只读状态行、状态计数、child session 与 transcript reference。
  - `bbl chat` 新增 `/agents` / `/agents status` slash command，按当前 session 读取 `/v1/sessions/:sessionId/agents` 与近期 session events 后渲染 multi-agent status panel；embedded client 补齐 `listAgents()` / `listSessionAgents()`，保持 service/embedded 入口一致。
  - slash palette 与 `/help` 已加入 `/agents`，不改变 AgentScheduler / `runAgentLoop()` 执行路径，不引入 execution bridge，不启用 `implement` 或写 capable child agent。
  - `test/tui-renderer.test.ts` 覆盖 AgentJob + AgentLoop sub-agent 混合视图与空状态。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-multi-agent-status-test.json "/Users/tangyaoyue/DEV/BABEL/BabeL-O/node_modules/.bin/tsx" --test --test-concurrency=1 "/Users/tangyaoyue/DEV/BABEL/BabeL-O/test/tui-renderer.test.ts"` 通过，35/35 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-multi-agent-status-typecheck.json npm --prefix "/Users/tangyaoyue/DEV/BABEL/BabeL-O" run typecheck` 通过。

## 2026-06-06 — P2 Implement Profile Evaluation

- **用户请求**: 推进 #1：P2 Implement profile 评估。
- **结论**:
  - 当前不启用 `implement` AgentScheduler profile，不向模型可见 child agent 开放 Edit/Write，也不把 `ExploreAgentScheduler` 小改成写 capable scheduler。
  - 现有 `AgentProfileId` / `AgentJob` schema 已能表达 `implement` 与 `isolation: 'worktree'`，但 `AgentProfiles.ts` 只启用 `explore`/`review`/`test`，`assertAgentProfile('implement')` 仍应失败。
  - 当前 AgentScheduler child runtime 使用 `skipPermissionCheck: true`；这只因 Explore/Review/Test 工具白名单排除写工具、Review/Test Bash 受限才安全。未来 implement 不能只把 `Edit`/`Write` 加入 allowedTools。
  - 未来 implement 必须先实现 Nexus-owned worktree lifecycle：创建 worktree、child cwd/allowedPaths 收窄到 worktree、变更文件/diff 摘要、parent review、merge/reject、merge conflict recovery 与 preserved worktree 处理。
  - 未来 implement 需要独立写安全策略：默认 worktree isolation，禁止 `isolation: none`，不继承 broad approvals，Bash 初期禁用或严格限制，remote runner Write/Edit 只作为执行后端且不得拥有权限/merge/session 所有权。
  - `runAgentLoop()` 现有 optimizer/worktree flow 继续作为写 capable orchestration 的 source of truth；AgentScheduler implement 只有在上述边界和测试就绪后再实现。
- **依据**:
  - `src/nexus/agents/AgentProfiles.ts` 当前只注册 `explore`/`review`/`test`。
  - `src/nexus/agents/AgentScheduler.ts` 当前只支持 `explore`/`review`/`test`，child session cwd 仍来自 parent cwd，不创建 worktree；`normalizeAgentResult()` 也不会收集 changed files。
  - `src/nexus/worktree.ts` 和 `runAgentLoop()` 已有 worktree 创建、merge、冲突恢复与 cleanup 机制，但尚未映射到 AgentJob review/merge lifecycle。
- **验证**:
  - 本次为文档化评估收口；未改 runtime 代码，未运行测试。

## 2026-06-06 — P2 runAgentLoop ↔ AgentScheduler Bridge Evaluation

- **用户请求**: 推进 P2 `runAgentLoop` ↔ `AgentScheduler` bridge 评估。
- **结论**:
  - 不把 `runAgentLoop()` 执行路径迁入 `ExploreAgentScheduler`，也不让 AgentScheduler 直接承接 Planner/Executor/Critic/Optimizer task orchestration。
  - `runAgentLoop()` 继续拥有 optimize/task workflow：subTasks、父任务 blocked/resume、retry/critic、worktree isolation/merge/recovery、permission inheritance、SubagentStart/SubagentStop hooks 与现有 `task_session_event` lifecycle。
  - `AgentScheduler` 继续拥有模型可见 Explore/Review/Test jobs：`AgentSpawn`/`AgentWait`/`AgentList`/`AgentCancel`、ContextForker、AgentJob governance、persistent AgentJob storage 与 `agent_job_event` lifecycle。
  - 当前可共享的边界是 context/summary/metrics 层：两套事件已被 context assembler、ContextForker、compact restore、TUI render 与 runtime metrics 分别识别；后续若 dashboard/agent UX 需要，再评估只读 observability/status bridge。
  - 暂不实现 parallel `AgentJob` mirror，不引入 execution bridge，不改变权限、模型选择、fallback 或 silent switch 行为。
- **依据**:
  - Scheduler 当前只支持 `explore`/`review`/`test` profiles，执行单 runtime stream；缺少 `runAgentLoop()` 的 task queue、planner/executor/critic、worktree merge/recovery 与 retry 语义。
  - `AgentJob.parentTaskId`、persistent storage 与 `agent_job_event` 可支持未来可见性桥接，但直接替换执行路径会改变现有 AgentLoop 语义与回归面。
- **验证**:
  - 本次为文档化评估收口；未改 runtime 代码，未运行测试。

## 2026-06-06 — P2 Agent Role Capability Diagnostics

- **用户请求**: 推进 P2 Agent role capability diagnostics，并随后更新文档状态。
- **实现**:
  - `RuntimeAgentStepUsageSummary` 新增 `capabilityDiagnostics`，runtime role step 复用 `ConfigManager.getProviderDiagnostics({ role, model })` / provider registry capability source，输出 provider/model、context window、default max tokens、tool/json/structured/streaming、role suitability、missing capabilities、recommendation 与 manual switch hint。
  - `createRuntimeAgentStepRunner()` 在 capability gate mismatch 时产出 `AGENT_ROLE_CAPABILITY_MISMATCH` summary 并抛出 `RuntimeAgentStepError`，确保 gate 失败前不调用 runtime/provider。
  - `runAgentLoop()` 的 `agent_loop_role_step_metrics` 携带 capability diagnostics，failure path 优先使用 runtime step 的实际 request-level diagnostics，避免默认 config 与 request model override 漂移。
  - AgentLoop live smoke per-role diagnostics 暴露同一套 capability diagnostics。
  - 未恢复自动模型选择、默认 role model 推荐、fallback execution 或 silent model/provider/profile switch；只给出人工切换提示。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-agent-role-diagnostics-test.json "/Users/tangyaoyue/DEV/BABEL/BabeL-O/node_modules/.bin/tsx" --test --test-concurrency=1 "/Users/tangyaoyue/DEV/BABEL/BabeL-O/test/agent-loop.test.ts"` 通过，33/33 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-provider-registry-test.json "/Users/tangyaoyue/DEV/BABEL/BabeL-O/node_modules/.bin/tsx" --test --test-concurrency=1 "/Users/tangyaoyue/DEV/BABEL/BabeL-O/test/providers.test.ts"` 通过，11/11 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-agent-role-diagnostics-typecheck.json npm run typecheck` 通过。

## 2026-06-06 — P2 Provider Seeds

- **用户请求**: 推进 #1「P2 Provider Seeds」。
- **实现**:
  - `src/providers/registry.ts` 新增 Moonshot 与 Ollama/local OpenAI-compatible provider seed，并补 Moonshot V1 8K/32K/128K/auto、Ollama qwen2.5-coder/llama3.1/deepseek-r1 model declaration。
  - OpenAI-compatible adapter 改为按 provider registry 使用 authMode/defaultBaseUrl：Moonshot 使用默认 `https://api.moonshot.cn/v1` 与 Bearer auth，Ollama 使用默认 `http://localhost:11434/v1` 且不发送空 Authorization。
  - `ConfigManager` 新增 `MOONSHOT_API_KEY` / `MOONSHOT_BASE_URL`、`OLLAMA_API_KEY` / `OLLAMA_BASE_URL` 解析；BabeL-X legacy Moonshot profile 现在可导入到 `moonshot/moonshot-v1-auto`。
  - Model config wizard 改为 registry-driven provider list，并允许 `authMode=none` provider 跳过 API key 输入。
  - 未恢复自动模型选择、默认 role model 推荐、fallback execution 或 silent model/provider/profile switch。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-provider-seeds-focused.json npm exec -- tsx --test --test-concurrency=1 test/providers.test.ts test/adapters.test.ts test/runtime-llm.test.ts test/runtime.test.ts` 通过，176/176 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-provider-seeds-typecheck.json npm run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-provider-seeds-format.json npm run format:check` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-provider-seeds-cli-list.json npm run cli -- models list` 通过，输出 Moonshot 与 Ollama seed。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-provider-seeds-cli-inspect.json npm run cli -- models inspect ollama/qwen2.5-coder:7b` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-provider-seeds-cli-inspect-moonshot.json npm run cli -- models inspect moonshot/moonshot-v1-128k` 通过。

## 2026-06-05 — P2 Provider Adapter Robustness Error Metadata

- **用户请求**: 继续根据建议推进 P2 Provider Adapter Robustness。
- **实现**:
  - `ProviderError` 新增 parsed metadata，解析 provider-specific JSON error body 中的 code/type/message/request id，并在错误 message 中展示可读摘要。
  - OpenAI-compatible adapter non-200 回归覆盖 provider-specific JSON error body，保留 providerId/httpStatus/rawMessage，同时断言 parsed metadata。
  - Agent role structured output diagnostics 新增 provider-neutral failure kind，区分 provider protocol、JSON parse、schema mismatch 与 capability gate。
  - 新增 structured output wrapped in text 的 provider error 回归，确认 provider error 不被误归为普通 schema mismatch。
  - 未恢复自动模型选择、默认 role model 推荐、fallback execution 或 silent model/provider/profile switch。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-provider-robustness-focused.json npm exec -- tsx --test --test-concurrency=1 test/adapters.test.ts test/agent-loop.test.ts test/provider-recovery.test.ts` 通过，61/61 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-provider-robustness-typecheck.json npm run typecheck` 通过。
  - `npm run format:check` 通过。
  - `git diff --check` 通过。

## 2026-06-05 — P2 Provider / AgentLoop Runtime Metrics Observability

- **用户请求**: P2 provider / agent loop runtime metrics 可观测性补齐推进。
- **实现**:
  - `/v1/runtime/metrics` 与 `/v1/runtime/status` 改为返回 enriched runtime metrics snapshot，在既有 `NexusMetrics` 基础上扫描最近本地 persisted events 聚合 diagnostics。
  - Provider invocation metrics 复用 `InvocationDiagnosticsHook` 的 `hook_completed(PostInvocation)` 事件，输出 count、success/failure、duration avg、failureKind、errorCode 与 byRole 聚合。
  - AgentLoop 新增 `agent_loop_role_step_metrics` task session event，记录 role、taskId、duration、estimated input/output tokens、success 与 failure metadata，不保存原始 input/output。
  - AgentLoop metrics 聚合 task/session event，输出 observed sessions、task/completed/failed、retry、sub-agent session、role token/duration/success/failure 与 failure type 诊断。
  - AgentJob metrics 聚合 top-level `agent_job_event` terminal lifecycle，输出 completed/failed/cancelled、byAgentType 与 failure code 诊断。
  - 未新增 storage schema、远程 telemetry、自动模型选择、fallback execution 或 silent provider/profile switch；仅补齐本地可调试性。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-provider-agent-metrics-focused.json npm exec -- tsx --test --test-concurrency=1 test/runtime.test.ts test/agent-loop.test.ts` 通过，119/119 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-provider-agent-metrics-typecheck.json npm run typecheck` 通过。
  - `npm run format:check` 通过。
  - `git diff --check` 通过。

## 2026-06-05 — P2 Context Ceiling / Runtime Metrics Diagnostics Alignment

- **用户请求**: P2 Context Ceiling / Runtime Metrics 诊断对齐推进。
- **实现**:
  - `CacheAwareCompactPolicy` 明确输出 registry-aware `modelContextWindow`、reserved output、provider safety buffer、legacy/effective ceiling、env hard cap、policy source 与 warning/compact/blocking thresholds。
  - `analyzeContext()`、CLI `/context`、context warning/blocking events 与 `CONTEXT_LIMIT_EXCEEDED` details 已统一展示/携带 context policy 来源和阈值，避免继续暴露无来源的 magic ceiling。
  - `execution_metrics` event、Memory/SQLite side table、`/v1/runtime/metrics` 与 `/v1/runtime/status` 已同步持久化/聚合这些 context ceiling diagnostics。
  - 未引入自动模型选择、默认 role model 推荐、显式 fallback 执行或 silent model/provider switch；仅补齐诊断与可观测性。
  - `TODO_provider_registry.md` / `TODO_performance.md` / `TODO.md` / `DONE.md` 已同步收口状态，后续 P2 observability 缩窄到真实 provider 数据与 provider/agent loop metrics。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-context-ceiling-runtime.json npm exec -- tsx --test --test-concurrency=1 test/runtime.test.ts test/context-assembler.test.ts` 通过，134/134 tests pass。
  - `npm run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-context-ceiling-benchmark-smoke.json BABEL_O_BENCHMARK_HISTORY_DIR=/tmp/babel-o-context-ceiling-benchmark-history npm run benchmark` 通过，并输出 runtime metrics / benchmark history smoke。
  - `npm run format:check` 通过。
  - `git diff --check` 通过。

## 2026-06-05 — P2 TS/Go Runner Comparison Benchmark

- **用户请求**: P2 TS Runner vs Go Runner 对比 benchmark 推进。
- **实现**:
  - 新增 `src/nexus/runnerComparisonBenchmark.ts`，复用 `executeToolSafely()` 对 TS local runner 与可选 Go `HttpRemoteToolRunner` 采集同一组工具执行场景。
  - `npm run benchmark` / `npm run test:performance` 新增 `runnerComparison` section；默认执行 TS local runner 并输出 Go skipped reason，只有 `BABEL_O_RUN_GO_RUNNER_SMOKE=1` 时才启动 `runners/go-runner`，且 Go Runner 子进程只接收最小 Go/env allowlist，不接收 provider API key。
  - benchmark 覆盖 `Read`、大目录 `Grep`、大目录 `Glob`、Bash stdout、大输出截断、workspace escape、cancel latency 与 timeout correctness；输出 duration p50/p95、stdout/stderr bytes、output/originalBytes、truncated、cancel/timeout/workspace denied 计数、heap/RSS 近似诊断和 error code 分布。
  - `src/nexus/benchmarkHistory.ts` 已提取 `runnerComparison` summary metrics；新增 `test/runner-comparison-benchmark.test.ts` 并纳入默认 `npm test` 与 `npm run test:concurrency`。
  - `scripts/test-concurrency-smoke.ts` 的子测试进程启动从 `npm exec -- tsx` 改为 `node --import tsx --test`，修复高并发下 `.js` import 解析到 `.ts` 源文件的偶发竞态。
  - `TODO_performance.md` / `TODO.md` / `DONE.md` 已同步 TS/Go runner 对比 benchmark 收口状态。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npm exec -- tsx --test --test-concurrency=1 test/runner-comparison-benchmark.test.ts` 通过，2/2 tests pass。
  - `npm run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-runner-comparison-benchmark-smoke.json BABEL_O_BENCHMARK_HISTORY_DIR=/tmp/babel-o-runner-comparison-benchmark-history npm run benchmark` 通过，并输出 `runnerComparison` section。
  - `/tmp/babel-o-runner-comparison-benchmark-history/summary.json` 验证包含 7 个 `runnerComparison ts_local ...` summary metrics。
  - `npm run test:concurrency` 通过，50/50 test files pass。
  - `npm run format:check` 通过。
  - `git diff --check` 通过。

## 2026-06-05 — P2 Local Benchmark History

- **用户请求**: 推进 P2 本地 benchmark history。
- **实现**:
  - 新增 `src/nexus/benchmarkHistory.ts`，从 `performance_benchmark` 结果提取核心指标摘要，覆盖 top-level latency、context/auto-compact/cache-aware compact、API scale、chat first-response、storage fault-injection、token estimator、AgentLoop、retryPolicy 与 runtime metrics。
  - `npm run benchmark` / `npm run test:performance` 现在默认写入 `.babel-o/benchmarks/latest.json`、`history.json` 与 `summary.json`，保留最近 20 次本地机器可读摘要，并在 summary 中记录 previousValue、delta、deltaPct。
  - 支持 `BABEL_O_BENCHMARK_HISTORY_DIR` 指向临时输出目录，支持 `BABEL_O_BENCHMARK_HISTORY_DISABLED=1` 禁用本地写入；不引入远程 telemetry。
  - 新增 `test/benchmark-history.test.ts` 并纳入默认 `npm test` 与 `npm run test:concurrency`；`.gitignore` 忽略 `.babel-o/benchmarks/`。
  - `TODO_performance.md` / `TODO.md` / `DONE.md` 已同步 benchmark history 收口状态。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-benchmark-history-focused.json npm exec -- tsx --test --test-concurrency=1 test/benchmark-history.test.ts` 通过，4/4 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-benchmark-history-typecheck.json npm run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-benchmark-history-smoke.json BABEL_O_BENCHMARK_HISTORY_DIR=/tmp/babel-o-benchmark-history-smoke npm run benchmark` 通过，并写入 latest/history/summary。
  - `/tmp/babel-o-benchmark-history-smoke` 验证包含 `latest.json`、`history.json`、`summary.json`，summary 提取 54 个指标。
  - `npm run test:concurrency` 通过，49/49 test files pass。
  - `git diff --check` 通过。

## 2026-06-05 — P2 AgentLoop Concurrency Isolation

- **用户请求**: 推进 P2 AgentLoop 主套件并发隔离。
- **实现**:
  - 将 `test/agent-loop.test.ts` 接回 `scripts/test-concurrency-smoke.ts`，并复现完整 per-file 并发 smoke 下的 live/manual smoke 状态漂移。
  - 根因定位为并发 runner 给所有子测试进程注入 `BABEL_O_MODEL=local/coding-runtime` / `BABEL_O_PROVIDER=local`，覆盖了 AgentLoop live smoke 测试内显式 `ConfigManager` 的 anthropic provider/model，导致 smoke 没有走预期 LLMCodingRuntime 路径。
  - `scripts/test-concurrency-smoke.ts` 现在会清除继承环境中的 `BABEL_O_MODEL` / `BABEL_O_PROVIDER`，只注入每文件独立临时 `BABEL_O_CONFIG_FILE` / `BABEL_O_CONFIG_DIR`。
  - 子测试进程从直接 `tsx` 改为 `npm exec -- tsx` 启动，修复并发场景下 `test/retry-policy-benchmark.test.ts` 偶发 `.js` import 解析不到 `.ts` 源文件的问题。
  - `npm run test:concurrency` 稳定集合扩展到 48 个文件，包含 `test/agent-loop.test.ts`。
  - `TODO_performance.md` / `TODO.md` / `DONE.md` 已同步 AgentLoop-inclusive Phase 1-4 收口状态。
- **验证**:
  - `npm run test:concurrency` 通过，48/48 test files pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-agent-loop-concurrency-typecheck.json npm run typecheck` 通过。
  - `git diff --check` 通过。

## 2026-06-05 — P2 Test Concurrency Governance Phase 3

- **用户请求**: 推进 Phase 3。
- **实现**:
  - `scripts/test-concurrency-smoke.ts` 在 Phase 2 per-file 进程隔离基础上扩展到 47 个稳定文件，新增 `test/permission-flow.test.ts`、`test/optimizer-safety.test.ts`、`test/runtime.test.ts`、`test/security.test.ts` 与 `test/worktree.test.ts` 等强状态候选。
  - 保持每个测试文件独立临时 `BABEL_O_CONFIG_FILE` / `BABEL_O_CONFIG_DIR`，默认 `npm test --test-concurrency=1` 不变。
  - `test/agent-loop.test.ts` 在完整并发 smoke 中暴露 live/manual smoke 状态漂移，单独运行可通过；暂不纳入稳定集合，后续作为 AgentLoop 主套件并发隔离专项收口。
  - `TODO_performance.md` / `TODO.md` / `DONE.md` 已同步 Phase 1-3 收口状态。
- **验证**:
  - `npm run test:concurrency` 通过，47/47 test files pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-concurrency-phase3-final-typecheck.json npm run typecheck` 通过。
  - `git diff --check` 通过。

## 2026-06-05 — P2 Test Concurrency Governance Phase 2

- **用户请求**: 推进 P2 测试并发治理 Phase 2。
- **实现**:
  - `scripts/test-concurrency-smoke.ts` 从单个共享 config 的 test runner 改为 bounded per-file 测试进程池，每个测试文件独立临时 `BABEL_O_CONFIG_FILE` / `BABEL_O_CONFIG_DIR`，避免并发进程争用 BabeL-O config。
  - `npm run test:concurrency` 覆盖从第一阶段扩展到 42 个测试文件，新增 Agent API/tools/runtime tools、agents command、completer、hooks、MCP、provider registry、run-session-flow、runtime-LLM、tool-trace、optimize command 等候选。
  - 默认 `npm test --test-concurrency=1` 继续保留；AgentLoop/worktree/runtime 主套件和 TaskQueue/TaskSession/storageBridge 强状态路径仍作为后续并发化目标。
  - `TODO_performance.md` / `TODO.md` / `DONE.md` 已同步 Phase 1-2 收口状态。
- **验证**:
  - `npm run test:concurrency` 通过，42/42 test files pass。

## 2026-06-05 — P2 Test Concurrency Governance Phase 1

- **用户请求**: 推进 #1「测试并发治理」。
- **实现**:
  - 梳理并发风险入口：`PendingPermissionRegistry`、TaskQueue、TaskSession、storageBridge、provider adapter override、修改 `process.env` 的测试和部分 session lifecycle 测试仍是默认全套件串行的主要原因。
  - 新增 `scripts/test-concurrency-smoke.ts`，创建独立临时 `BABEL_O_CONFIG_FILE` / `BABEL_O_CONFIG_DIR`，以 `--test-concurrency=4` 运行已审计的无共享状态/隔离良好测试集合。
  - `package.json` 新增 `npm run test:concurrency`；默认 `npm test --test-concurrency=1` 暂不移除，避免把未隔离全局状态测试直接并发化。
  - `TODO_performance.md` / `TODO.md` / `DONE.md` 已同步：第一阶段并发 smoke 收口，后续继续逐项扩大覆盖。
- **验证**:
  - `npm run test:concurrency` 通过，262/262 tests pass。

## 2026-06-05 — P2 Retry Policy Benchmark

- **用户请求**: 根据建议继续推进 P2 #1 retry policy benchmark。
- **实现**:
  - 新增 `src/nexus/retryPolicyBenchmark.ts`，用 deterministic mocked scenarios 覆盖 rate limit retry success、provider unavailable retry exhausted、empty response output retry exhausted、schema mismatch repair success 与 tool protocol error no-auto-retry。
  - benchmark 复用 `withRetry()`、`classifyProviderRecovery()`、`estimateTextTokens()` 与既有 mocked AgentLoop benchmark，不调用真实 provider。
  - `scripts/benchmark-performance-core.ts` 新增 machine-readable `retryPolicy` section，并复用同一次 `agentLoop` benchmark 结果汇总 AgentLoop retry overhead。
  - 新增 `test/retry-policy-benchmark.test.ts` 并纳入默认 `npm test`，断言 scenario schema、failure type、policy mode、retry count、success rate、retry overhead token 与 AgentLoop summary。
  - `TODO_performance.md` / `TODO.md` / `DONE.md` 已同步收口状态。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-retry-policy-benchmark.json npm exec -- tsx --test --test-concurrency=1 test/retry-policy-benchmark.test.ts test/agent-loop-benchmark.test.ts test/provider-recovery.test.ts test/retry.test.ts` 通过，15/15 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-retry-policy-typecheck.json npm run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-retry-policy-benchmark-smoke.json npm run benchmark` 通过，输出 `retryPolicy` section。
  - `git diff --check` 通过。

## 2026-06-05 — P1 Persistent AgentJob Storage

- **用户请求**: 按建议继续推进 AgentScheduler 规范化后续项。
- **实现**:
  - 新增 `src/shared/agentJob.ts`，将 AgentJob / AgentResult / AgentJobFilter 等共享类型从 Nexus agents 层下沉，避免 storage 反向依赖 AgentScheduler 模块。
  - `NexusStorage` 新增 `saveAgentJob` / `getAgentJob` / `listAgentJobs`；MemoryStorage 使用 Map + defensive clone，SqliteStorage 新增 `agent_jobs` JSON 表、parent/status/agentType 索引与 user_version 9 migration。
  - `AgentJobRegistry` 新增 `hydrateJobs()`，恢复 persisted jobs 时会同步已有 numeric id，避免新 job id 冲突。
  - `ExploreAgentScheduler` 在 spawn/running/terminal transition 后写入 AgentJob storage，并在 spawn/list/wait/cancel 入口一次性 hydrate persisted jobs；重启后非当前进程 running 的非终态 job 只返回持久化状态，不自动恢复执行。
  - AgentScheduler API/CLI 通过既有 scheduler list/get/wait/cancel 路径自然获得重启后 job 可见性；Implement Agent 继续延后。
  - `TODO_agents.md` / `TODO.md` / `DONE.md` 已同步收口状态。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-agent-job-storage-focused-1.json npm exec -- tsx --test --test-concurrency=1 test/agent-job-registry.test.ts test/agent-scheduler.test.ts` 通过，23/23 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-agent-job-storage-api.json npm exec -- tsx --test --test-concurrency=1 test/agent-tools.test.ts test/agent-api.test.ts test/agents-command.test.ts test/context-forker.test.ts` 通过，15/15 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-agent-job-storage-typecheck-2.json npm run typecheck` 通过。
  - `git diff --check` 通过。

## 2026-06-05 — P1 Agent Job Event Schema

- **用户请求**: 推进 P1「独立 agent_job_* event schema 决策」。
- **决策**:
  - AgentScheduler 生命周期事件升级为 top-level `agent_job_event`，覆盖 queued、started、completed、failed、cancelled。
  - `task_session_event` 继续保留给 AgentLoop / TaskSession 旧事件使用，不再承载新的 AgentJob 生命周期语义。
  - `agent_job_event` 携带 jobId、childSessionId、agentType、contextForkMode、status、governance、result/error，便于后续 persistent AgentJob storage / dashboard audit 不锁死在旧 task session payload。
- **实现**:
  - `src/shared/events.ts` 新增 `AgentJobEventSchema` 并纳入 `NexusEventSchema`。
  - `ExploreAgentScheduler` 父会话事件从 `task_session_event.eventType = agent_job_*` 改为写入 `agent_job_event`。
  - Context Manager、ContextForker、compact post-restore、session summary、context hash 与 CLI/TUI event renderer 已识别并渲染新的 `agent_job_event`。
  - AgentScheduler / Agent tools / API / ContextForker / Go remote smoke 相关回归已改用新事件结构。
  - `TODO_agents.md` / `TODO.md` / `DONE.md` 已同步收口状态；persistent AgentJob storage 仍按需后置，Implement Agent 继续延后。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-agent-event-schema.json npm exec -- tsx --test --test-concurrency=1 test/agent-scheduler.test.ts test/agent-tools.test.ts test/agent-api.test.ts test/context-forker.test.ts` 通过，23/23 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-agent-event-schema.json npm exec -- tsx --test --test-concurrency=1 test/context-assembler.test.ts test/tui-renderer.test.ts` 通过，80/80 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-agent-event-schema.json npm exec -- tsx --test --test-concurrency=1 test/agent-job-registry.test.ts test/agent-profiles.test.ts test/agent-tools-runtime.test.ts test/agents-command.test.ts` 通过，17/17 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-agent-event-schema.json npm run typecheck` 通过。
  - `git diff --check` 通过。

## 2026-06-05 — P1 AgentScheduler Governance

- **用户请求**: 根据最新建议推进：不要急着做 Implement Agent，先补 AgentScheduler governance，再决策 event schema / persistent storage。
- **实现**:
  - `ExploreAgentScheduler` 新增 max concurrent agents 与 max depth 治理，默认限制 active agent 数和 child agent 深度；超过容量返回 `AGENT_SCHEDULER_CAPACITY_EXCEEDED`，超过深度返回 `AGENT_SCHEDULER_MAX_DEPTH_EXCEEDED`。
  - Agent job 新增 `governance` diagnostics，包含 maxConcurrentAgents、activeAgents、maxDepth、depth、maxRuntimeMs、timeoutAt，并同步写入 job、child session metadata、parent `agent_job_*` event payload 与 `AgentSpawn` tool output。
  - Agent job runtime timeout 现在以 `AGENT_JOB_TIMEOUT` failed 状态收口，child session 标记 failed，不再与手动 cancel 混同。
  - Implement Agent 继续延后；TODO 已调整为先决策独立 `agent_job_*` event schema，再按 service/dashboard 真实需求评估 persistent AgentJob storage，最后基于 worktree isolation 与 parent diff review/merge/reject/recovery flow 评估 implement profile。
  - `TODO_agents.md` / `TODO.md` / `DONE.md` 已同步收口状态。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-agent-governance.json npm exec -- tsx --test --test-concurrency=1 test/agent-scheduler.test.ts test/agent-tools.test.ts test/agent-api.test.ts` 通过，17/17 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-agent-governance.json npm exec -- tsx --test --test-concurrency=1 test/agent-job-registry.test.ts test/agent-profiles.test.ts test/agent-tools-runtime.test.ts test/agents-command.test.ts` 通过，17/17 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-agent-governance.json npm run typecheck` 通过。
  - `git diff --check` 通过。

## 2026-06-05 — P2 Go Runner Metrics Passthrough

- **用户请求**: 推进 Go Runner metrics passthrough。
- **实现**:
  - `RemoteToolRunner` / HTTP remote runner / Go Runner protocol result 新增可选 metrics，保留 runner id、protocol version、runner duration、truncated/originalBytes、Bash exit code/signal、cancelled/timedOut/errorCode 等诊断；TS 侧额外记录 remote roundtrip。
  - `executeToolSafely()` 将 remote result metrics 归一为 `RemoteToolRunnerDiagnostics`，并透传到 `tool_completed.remoteRunner`；provider tool loop、local explicit tool path 与 file-question `Read` path 均接入。
  - Memory/SQLite tool trace 持久化 `remoteRunner`，`execution_metrics` side table 与 runtime metrics 聚合 remote tool call count / remote runner duration；`/v1/runtime/metrics` 仅展示本地聚合，不新增远程 telemetry 或上传路径。
  - Go Runner `Read` / `Grep` / `Glob` / `Bash` execute path 返回 metrics；Bash success/failure 可提取 exit code 与 signal，cancel/timeout 继续使用结构化 error code。
  - `TODO_performance.md` / `DONE.md` 已同步收口状态。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-metrics-passthrough.json npm exec -- tsx --test test/runtime.test.ts` 通过，87/87 tests pass。
  - `go -C "runners/go-runner" test ./...` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-metrics-passthrough.json npm run typecheck` 通过。
  - `git diff --check` 通过。

## 2026-06-05 — P1 Explore Agent Remote Execution Smoke

- **用户请求**: 继续推进 P1：Explore Agent remote execution smoke。
- **实现**:
  - `ExploreAgentScheduler` 新增显式 scheduler-level `executionEnvironment` / `remoteRunner` 配置，并在 child runtime `executeStream()` 中透传 remote execution context、child cwd 与 `allowedPaths`。
  - `AgentJob` 创建时写入 `nexus://sessions/<childSessionId>/events` transcript reference，父会话 agent job 事件继续只引用 child transcript，不内联原始 transcript。
  - `createDefaultNexusRuntime()` / `createNexusApp()` 支持向默认 `ExploreAgentScheduler` 传入显式 `agentExecutionEnvironment`；service/embedded 模式可通过 `NEXUS_AGENT_EXECUTION_ENVIRONMENT=remote` opt in，且要求 healthy `NEXUS_REMOTE_RUNNER_URL`；配置 remote runner 本身不自动把所有 Agent 切到 remote。
  - `test/remote-runner-go-smoke.test.ts` 新增 gated Go Explore Agent remote smoke：模型可见层仍只使用 `AgentSpawn` / `AgentWait` 等 Agent tools，child runtime 的 `Read/Grep/Glob` 经 HTTP Go Runner 执行，并覆盖 `AgentResult`、child transcript reference、父会话完成事件与 workspace escape 失败摘要。
  - Go Runner 仍不接收 provider API key，不承担 Agent scheduling、permission、session lifecycle 或 provider loop；TypeScript Nexus 继续拥有这些职责。
  - `TODO_agents.md` / `DONE.md` 已同步收口状态。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-agent-remote-final2.json npm exec -- tsx --test --test-concurrency=1 "test/agent-scheduler.test.ts" "test/agent-tools-runtime.test.ts" "test/remote-runner-go-smoke.test.ts"` 通过，11 passed / 2 skipped。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-runtime-remote-env.json npm exec -- tsx --test --test-concurrency=1 "test/runtime.test.ts" --test-name-pattern "remote runner config|agent remote execution env|remote execution uses configured RemoteToolRunner seam|HTTP remote runner transport executes a tool through protocol server"` 通过，87/87 tests pass。
  - `npm run typecheck` 通过。
  - `git diff --check` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-go-agent-remote.json BABEL_O_RUN_GO_RUNNER_SMOKE=1 npm exec -- tsx --test --test-concurrency=1 "test/remote-runner-go-smoke.test.ts"` 通过，2/2 tests pass。

## 2026-06-05 — P2 Go Remote Runner Phase C Restricted Bash

- **用户请求**: 已安装 Go 后，先测试 Go Runner，再继续推进 Phase C restricted Bash。
- **实现**:
  - 本机 Go toolchain 已验证为 `go version go1.26.4 darwin/arm64`。
  - 修复 macOS `/var` 与 `/private/var` canonical path 差异导致的 workspace false denial，Go Runner 现在对 cwd、requested path、allowed roots 与 symlink target 使用 canonical path 比较。
  - `GO_RUNNER_ENABLE_BASH=1` 显式开启后 capabilities 才包含 `Bash`；默认仍只暴露 `Read` / `Grep` / `Glob`，`Write` / `Edit` 保持 disabled。
  - Go Bash backend 使用 `/bin/sh -c` 执行已由 Nexus 批准的命令，Nexus 继续负责 permission、risk classification、hooks、audit 与命令策略。
  - Bash 执行提供 Unix process group cancel/timeout、stdout/stderr 分离、输出预算、exit code/signal/duration 结构化返回和 env allowlist；provider API key 不进入子进程环境。
  - `src/runtime/remoteRunner.ts` capabilities 类型同步 readOnly/bashEnabled/writeEnabled 与 limit diagnostics；`test/remote-runner-go-smoke.test.ts` gated smoke 在显式开启 Bash 后覆盖 Read/Grep/Glob/Bash、workspace escape 与 protocol mismatch。
  - 修复 gated smoke 清理：`go run` 以独立进程组启动，finally 中终止整个进程组，避免编译出的 `go-runner` 子进程残留导致测试挂起。
  - `TODO_runtime.md` / `DONE.md` / `go-runner-plan.md` 已同步 Phase C 收口状态，下一项仍是 Phase D implement/worktree execution backend。
- **验证**:
  - `cd /Users/tangyaoyue/DEV/BABEL/BabeL-O/runners/go-runner && go test ./...` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-go-runner-phase-c-typecheck-config.json npm run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-go-runner-phase-c-typecheck-config-2.json npm run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-go-runner-phase-c-skip-config.json npx tsx --test --test-concurrency=1 test/remote-runner-go-smoke.test.ts` 默认 skip 成功，1/1 skipped。
  - `cd /Users/tangyaoyue/DEV/BABEL/BabeL-O && BABEL_O_CONFIG_FILE=/tmp/babel-o-go-runner-phase-c-skip-config-2.json npx tsx --test --test-concurrency=1 test/remote-runner-go-smoke.test.ts` 默认 skip 成功，1/1 skipped。
  - `cd /Users/tangyaoyue/DEV/BABEL/BabeL-O && BABEL_O_CONFIG_FILE=/tmp/babel-o-go-runner-phase-c-live-config-2.json BABEL_O_RUN_GO_RUNNER_SMOKE=1 npx tsx --test --test-concurrency=1 test/remote-runner-go-smoke.test.ts` 通过，1/1 tests pass。
  - `cd /Users/tangyaoyue/DEV/BABEL/BabeL-O && npm run format:check` 通过。
  - `cd /Users/tangyaoyue/DEV/BABEL/BabeL-O && npm run deps:audit` 通过。

## 2026-06-05 — P2 Go Remote Runner Safety Defaults

- **用户请求**: 继续推进 Go Runner 安全默认值收口。
- **实现**:
  - `runners/go-runner/internal/protocol/types.go` 的 capabilities 扩展为 read-only、安全开关和 limits 诊断：tools、readOnly、bashEnabled、writeEnabled、maxConcurrentTools、maxOutputBytes、defaultDeadlineMs、maxDeadlineMs。
  - `runners/go-runner/internal/runner/server.go` 新增 `ServerOptions` 与默认/硬上限：默认并发 4、硬上限 16；默认输出 200000 bytes、硬上限 1000000 bytes；默认 deadline 120000 ms、硬上限 600000 ms。
  - execute path 现在由 server 夹紧 `maxOutputBytes` 与 `deadlineMs`，省略 output budget 时使用 server 默认预算；并发 gate 满时返回 HTTP 429 + `REMOTE_RUNNER_CAPACITY_EXCEEDED`。
  - `runners/go-runner/cmd/go-runner/main.go` 默认继续绑定 `127.0.0.1`，非 loopback `GO_RUNNER_HOST` 必须显式设置 `GO_RUNNER_ALLOW_NON_LOCAL_BIND=1`；runner 仍不接收 provider keys 或 env forwarding。
  - `runners/go-runner/internal/runner/server_test.go` 新增 capabilities safety fields、options hard cap、output cap、deadline default/max、capacity exhaustion 和 Bash/Write/Edit disabled 回归。
  - `TODO_runtime.md` / `DONE.md` / `go-runner-plan.md` 已同步：Go Runner 安全默认值收口，下一项仍是 Phase C restricted Bash 或后续可选 Go smoke 扩展。
- **验证**:
  - 初次验证时本机无 Go toolchain；用户安装 Go 后，`go version go1.26.4 darwin/arm64` 可用，`cd /Users/tangyaoyue/DEV/BABEL/BabeL-O/runners/go-runner && go test ./...` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-go-runner-safety-typecheck-config.json npm run typecheck` 通过。
  - `npm run format:check` 通过。
  - `npm run deps:audit` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-go-runner-safety-skip-config.json npx tsx --test --test-concurrency=1 test/remote-runner-go-smoke.test.ts` 默认 skip 成功，1/1 skipped。

## 2026-06-04 — P2 Nexus Remote Runner Optional Config

- **用户请求**: 根据建议继续推进 Nexus 侧 Go Runner 可选配置与降级。
- **实现**:
  - 新增 `src/nexus/remoteRunnerConfig.ts`，集中解析 `NEXUS_REMOTE_RUNNER_URL` / `NEXUS_REMOTE_RUNNER_REQUIRED`，查询 `/v1/remote-runner/capabilities`，校验 remote runner protocol version，并构造 `HttpRemoteToolRunner`。
  - service mode `src/nexus/server.ts` 与 embedded mode `src/cli/embedded.ts` / `src/cli/runSessionFlow.ts` 复用同一配置路径；默认不启用 remote runner，`NEXUS_REMOTE_RUNNER_REQUIRED=1` 且 URL/capabilities/protocol 校验失败时 fail fast。
  - `GET /v1/runtime/status` 新增 `remoteRunner` diagnostics，暴露 configured/required/healthy、redacted URL、runner id、protocol version、capabilities 与失败原因。
  - `test/runtime.test.ts` 新增回归覆盖默认 disabled、optional capabilities 失败、required fail-fast、capabilities 成功构造 `HttpRemoteToolRunner` 与 runtime status 诊断。
  - `TODO_runtime.md` / `DONE.md` / `go-runner-plan.md` 已同步：Nexus 侧可选配置与降级收口，下一项仍是 Go Runner 安全默认值或 Phase C restricted Bash。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-remote-runner-config-typecheck-config.json npm run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-remote-runner-config-focused-config.json npx tsx --test --test-concurrency=1 test/runtime.test.ts --test-name-pattern "remote runner config|runtime/status reports remote runner|runtime/status returns redacted provider"` 通过，86/86 tests pass。

## 2026-06-04 — P2 Go Remote Runner Phase B

- **用户请求**: 推进 Phase B，实现 Go Runner read-only `Read` / `Grep` / `Glob` backend。
- **实现**:
  - Go Runner capabilities 从 Phase A `Noop` 切换为 `Read` / `Grep` / `Glob`，HTTP execute dispatch 调用 `internal/tools` read-only backend。
  - 新增纯 Go `Read` / `Grep` / `Glob`：支持 `cwd` / `allowedPaths`、workspace escape 拒绝、symlink escape 拒绝、Read offset/limit/preview/truncation、Grep regexp scan、Glob stable sorted match、dependency/build 目录跳过、输出预算与 context cancel/timeout。
  - 修正多 `allowedPaths` 下 symlink defense-in-depth 判断，先归一化全部 allowed roots 再判断 symlink target，避免误拒绝指向第二个允许根的合法链接。
  - Go tests 覆盖 read-only 主路径、workspace escape、symlink escape、多 allowed root symlink、context cancel/timeout；gated TS smoke 通过 `HttpRemoteToolRunner` 覆盖 Read/Grep/Glob、workspace escape 与 protocol mismatch。
  - `TODO_runtime.md`、`DONE.md`、`go-runner-plan.md` 已同步 Phase B 收口状态；Phase C restricted Bash 仍是下一阶段。
- **验证**:
  - `go version` 失败：本机无 Go toolchain，未本地执行 `go test ./...` 或启用真实 Go runner smoke。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-go-runner-phase-b-final-typecheck-config.json npm run typecheck` 通过。
  - `npm run format:check` 通过。
  - `npm run deps:audit` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-go-runner-phase-b-skip-config-final.json npx tsx --test --test-concurrency=1 test/remote-runner-go-smoke.test.ts` 默认 skip 成功，1/1 skipped。

## 2026-06-04 — P2 Go Remote Runner Phase A

- **用户请求**: 推进 #1 Go Remote Runner Phase A protocol compatibility spike。
- **实现**:
  - 新增 `runners/go-runner/` Go module，提供兼容现有 `RemoteToolRunner` 的最小 HTTP server。
  - 支持 `GET /v1/remote-runner/capabilities`、`POST /v1/remote-runner/execute`、`POST /v1/remote-runner/cancel`、protocol version validation、request id tracking、structured result/error 与 active request cancel。
  - Phase A 仅启用 `Noop` tool；不接入 Bash、Write/Edit、sandbox、agent scheduling、provider loop、部署、文件同步或 remote provider loop。
  - 新增 `test/remote-runner-go-smoke.test.ts`，通过 `BABEL_O_RUN_GO_RUNNER_SMOKE=1` 显式启用；默认 `npm test` 不要求 Go toolchain。
  - `package.json` 新增 `test:go-runner` 与 `test:go-runner:smoke` 显式脚本。
- **验证**:
  - `go version` 不可用，本机未执行 `go test ./...` 或启用真实 Go smoke。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-go-runner-phase-a-typecheck-config.json npm run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-go-runner-phase-a-skip-config.json npx tsx --test --test-concurrency=1 test/remote-runner-go-smoke.test.ts` 默认 skip 成功，1/1 skipped。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-go-runner-phase-a-typecheck-config-2.json npm run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-go-runner-phase-a-final-typecheck-config.json npm run typecheck` 通过。
  - `npm run format:check` 通过。
  - `npm run deps:audit` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-go-runner-phase-a-skip-config-final.json npx tsx --test --test-concurrency=1 test/remote-runner-go-smoke.test.ts` 默认 skip 成功，1/1 skipped。

## 2026-06-04 — P2 AgentLoop Maintainability Helper Split

- **用户请求**: 根据建议继续推进。
- **实现**:
  - 新增 `src/nexus/agentLoopSubAgents.ts`，抽出 sub-agent session id、lifecycle metadata、permission inheritance、parent sub-agent reference、task orchestration context、subtask normalization、task depth、session event range 与 sub-agent summary 等纯 helper。
  - `src/nexus/agentLoop.ts` 改为 import 这些 helper，并继续保留 `runAgentLoop()` 主状态机、executor/critic/retry step、worktree merge/recovery 与带副作用的 subtask delegation 逻辑。
  - 新增 `test/agent-loop-subagents.test.ts`，锁定 helper 契约，避免后续维护时破坏 child transcript reference、permission inheritance 与 orchestration context。
  - `TODO_agents.md` / `DONE.md` 已同步：第一阶段 maintainability 拆分完成，后续仅按需继续拆 worktree/task orchestration helper。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-agent-loop-helper-typecheck-config.json npm run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-agent-loop-helper-test-config.json npx tsx --test --test-concurrency=1 test/agent-loop-subagents.test.ts test/agent-loop.test.ts` 通过，34/34 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-agent-loop-helper-benchmark-test-config.json npx tsx --test --test-concurrency=1 test/agent-loop-benchmark.test.ts` 通过，1/1 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-agent-loop-helper-worktree-test-config.json npx tsx --test --test-concurrency=1 test/worktree.test.ts` 通过，7/7 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-agent-loop-helper-typecheck-config-2.json npm run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-agent-loop-helper-final-typecheck-config.json npm run typecheck`、`npm run format:check`、`npm run deps:audit` 通过。

## 2026-06-04 — P1 Review/Test Agent Profiles

- **用户请求**: 根据建议继续推进 P1。
- **实现**:
  - `src/nexus/agents/AgentProfiles.ts` 已启用 `review` / `test` profiles，默认复用 `task-focused` ContextForker，保留 `explore` 的 `minimal` read-only 行为。
  - `ExploreAgentScheduler` 支持 `explore`、`review`、`test` 三类 schedulable profile；`implement` / `debug` / `general` 继续拒绝，避免提前开放写能力。
  - Review/Test child runtime 不暴露 Edit/Write；Bash 通过 profile wrapper 限制为 `npm run typecheck`、`npm run format:check`、`npm run deps:audit` 和 focused `npx tsx --test ...`，并允许隔离 `BABEL_O_CONFIG_FILE=/tmp/...` 前缀。
  - `AgentResult` 归一已记录 Bash `commandsRun` 与 `testsRun`，方便 parent session 只消费结构化结果而不是完整 child transcript。
  - `AgentSpawn` prompt、AgentScheduler/API/tool 回归已覆盖 review/test profile、task-focused fork、restricted Bash 与编辑工具拒绝路径。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-review-test-agent-focused-config-2.json npx tsx --test --test-concurrency=1 test/agent-profiles.test.ts test/agent-scheduler.test.ts test/agent-tools.test.ts test/agent-api.test.ts test/agents-command.test.ts` 通过，19/19 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-review-test-agent-regression-config.json npx tsx --test --test-concurrency=1 test/agent-profiles.test.ts test/agent-job-registry.test.ts test/context-forker.test.ts test/agent-scheduler.test.ts test/agent-tools.test.ts test/agent-tools-runtime.test.ts test/agent-api.test.ts test/agents-command.test.ts` 通过，35/35 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-review-test-agent-typecheck-config.json npm run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-review-test-agent-final-typecheck-config.json npm run typecheck`、`npm run format:check`、`npm run deps:audit` 通过。

## 2026-06-04 — P1 ContextForker Multi-mode

- **用户请求**: 推进 #1 ContextForker 多模式收口。
- **实现**:
  - `src/nexus/agents/ContextForker.ts` 已从 Explore-only `minimal` 扩展为 `minimal`、`working-set`、`task-focused`、`full-summary`、`debug-replay` 五种 fork mode。
  - `minimal` 保持 read-only Explore Agent 聚焦 prompt 与父历史隔离；其他模式按 working set、近期用户关注、任务状态、失败/权限上下文、compact summary 与 child-agent result 生成 child prompt。
  - `ContextForkDiagnostics` 记录 included/omitted 类别、working set paths 与相关 parent event references；AgentScheduler 会把 fork diagnostics 写入 child session metadata。
  - Runtime context diagnostics、HTTP `/v1/sessions/:sessionId/context` 与 CLI `/context` 已展示 fork mode、inherited/omitted item 数量和 child-agent context 继承情况，且 runtime 层不反向 import Nexus agent types。
  - `test/context-forker.test.ts` 覆盖五种 fork mode 与 scheduler metadata；`test/runtime.test.ts` 覆盖 Context API fork metadata passthrough。
  - `TODO_runtime.md` / `DONE.md` / `context-and-subagent-upgrade-plan.md` 已同步：ContextForker 多模式收口完成，下一步转向 Review/Test Agent profiles。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-context-forker-test-config.json npx tsx --test --test-concurrency=1 test/context-forker.test.ts` 通过，6/6 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-context-forker-test-config-2.json npx tsx --test --test-concurrency=1 test/context-forker.test.ts test/runtime.test.ts --test-name-pattern "ContextForker|context returns reusable|context fork|/v1/sessions/:sessionId/context"` 通过，88/88 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-context-forker-typecheck-config-2.json npm run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-context-forker-final-typecheck-config.json npm run typecheck`、`npm run format:check`、`npm run deps:audit` 通过。

## 2026-06-04 — P1 Context Manager Normalization

- **用户请求**: 根据建议推进 P1 Context Manager 规范化。
- **实现**:
  - 新增 `src/runtime/contextManager.ts`，定义 `ContextManagerPhase`、`ContextItem`、`ScoredContextItem`、`SelectedContextItem` 与 `ContextSelectionDiagnostics`，并提供 retained/dropped selection diagnostics builder。
  - `assembleContext()` 保留既有 recent event selection、tool-pair protection、omitted-event selection、microcompact/snipping 行为，只额外输出 selection diagnostics。
  - `analyzeContext()`、runtime diagnostic envelope、HTTP context API passthrough 与 CLI `/context` 展示已暴露 retained/dropped item 数量、主要 reason、estimated tokens、working set paths 与 compact boundary。
  - `test/context-assembler.test.ts` 覆盖 selection diagnostics、API payload 与 CLI/context view 展示；`test/runtime.test.ts` fixture 已接入空 selection diagnostics。
  - `TODO_runtime.md` / `DONE.md` / `context-and-subagent-upgrade-plan.md` 已同步：本切片收口 Context Manager 最小规范化，`ForkForChildAgent` / 多模式 ContextForker 仍作为后续 child-agent context work。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-context-manager-typecheck-config-2.json npm run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-context-manager-test-config.json npx tsx --test --test-concurrency=1 test/context-assembler.test.ts test/runtime.test.ts` 通过，129/129 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-context-manager-regression-config.json npx tsx --test --test-concurrency=1 test/context-assembler.test.ts test/context-regression.test.ts test/system-prompt-builder.test.ts test/prefix-cache.test.ts test/runtime-llm.test.ts test/runtime.test.ts` 通过，211/211 tests pass。
  - `npm run format:check` 通过。

## 2026-06-04 — AgentScheduler API / CLI Management

- **用户请求**: 推进#1 AgentScheduler API / CLI 管理层，并继续任务。
- **实现**:
  - `createDefaultNexusRuntime()` 现在创建共享 `ExploreAgentScheduler`，显式 `enableAgentTools` 暴露的 Agent tools 与 Nexus API 使用同一 scheduler 实例。
  - `createNexusApp()` 新增可注入 `agentScheduler`，默认用 storage/default cwd 创建 `ExploreAgentScheduler`，并提供 `POST /v1/agents`、`GET /v1/agents`、`GET /v1/agents/:jobId`、`POST /v1/agents/:jobId/wait`、`POST /v1/agents/:jobId/cancel`、`GET /v1/agents/:jobId/transcript`、`GET /v1/sessions/:sessionId/agents`。
  - `NexusClient` 新增 agent spawn/list/session-list/get/wait/cancel/transcript 方法；新增 `src/cli/commands/agents.ts` 并注册 `bbl agents spawn/list/show/wait/cancel/transcript/session`。
  - 新增 `test/agent-api.test.ts` 和 `test/agents-command.test.ts`，覆盖 API 管理面、transcript 按需查询、CLI command 注册与请求体/filter 构造，并纳入默认 `npm test`。
  - `TODO_agents.md` / `DONE.md` / `context-and-subagent-upgrade-plan.md` 已同步；review/test/implement profiles 仍待后续评估。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-agent-api-cli-test-config.json npx tsx --test --test-concurrency=1 test/agent-api.test.ts test/agents-command.test.ts` 通过，5/5 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-agent-api-regression-config.json npx tsx --test --test-concurrency=1 test/agent-profiles.test.ts test/agent-job-registry.test.ts test/context-forker.test.ts test/agent-scheduler.test.ts test/agent-tools.test.ts test/agent-tools-runtime.test.ts test/agent-api.test.ts test/agents-command.test.ts` 通过，26/26 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-agent-api-typecheck-config.json npm run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-agent-api-targeted-test-config.json npx tsx --test --test-concurrency=1 test/tui-input.test.ts test/agent-api.test.ts test/agents-command.test.ts` 通过，36/36 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-agent-api-typecheck-config-2.json npm run typecheck`、`npm run format:check`、`npm run deps:audit` 通过。
  - `npm test` 通过，520/520 tests pass；收口期间恢复 welcome header 的 `❖ BABEL-O` 身份标记，并移除 `src/cli/embedded.ts` 对传递依赖 `light-my-request` 的类型导入。

## 2026-06-04 — Read-only Explore Agent MVP

- **用户请求**: 根据建议继续推进。
- **实现**:
  - 新增 `src/nexus/agents/ContextForker.ts`，提供 minimal context fork：继承 stable rules/cwd/agent prompt/explicit paths，默认省略 parent history、large tool results、compact summary 与 child transcripts。
  - 新增 `src/nexus/agents/AgentScheduler.ts`，实现 `ExploreAgentScheduler`：创建 child session、登记 `AgentJobRegistry` job、执行 read-only child runtime、归一 structured `AgentResult`、支持 wait/list/cancel，并通过 parent `task_session_event` 记录 agent_job lifecycle。
  - 新增 `src/nexus/agents/AgentTools.ts`，提供模型可见 `AgentSpawn`、`AgentWait`、`AgentList`、`AgentCancel` 工具定义；工具只调用 `AgentScheduler`，不会混入 `RemoteToolRunner`。
  - `createDefaultNexusRuntime()` 新增显式 `enableAgentTools` 选项，`src/nexus/server.ts` 支持 `BABEL_O_ENABLE_AGENT_TOOLS=1`；默认不暴露 Agent tools，显式开启后 parent runtime 可 allowlist Agent tools。
  - Explore child 默认只允许 `Read/Grep/Glob`，拒绝 `Edit/Write/Bash` 等工具 override；本切片不改变既有 `runAgentLoop()`。
  - 新增 `test/context-forker.test.ts`、`test/agent-scheduler.test.ts`、`test/agent-tools.test.ts`、`test/agent-tools-runtime.test.ts` 并纳入默认 `npm test`。
  - `TODO_agents.md` / `DONE.md` 已同步；review/test/implement profiles 仍待后续评估。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-explore-agent-test-config.json npx tsx --test --test-concurrency=1 test/context-forker.test.ts test/agent-scheduler.test.ts test/agent-tools.test.ts` 通过，8/8 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-explore-agent-runtime-test-config.json npx tsx --test --test-concurrency=1 test/agent-profiles.test.ts test/agent-job-registry.test.ts test/context-forker.test.ts test/agent-scheduler.test.ts test/agent-tools.test.ts test/agent-tools-runtime.test.ts` 通过，21/21 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-explore-agent-typecheck-config.json npm run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-explore-agent-final-test-config.json npx tsx --test --test-concurrency=1 test/agent-profiles.test.ts test/agent-job-registry.test.ts test/context-forker.test.ts test/agent-scheduler.test.ts test/agent-tools.test.ts test/agent-tools-runtime.test.ts test/agent-loop.test.ts` 通过，52/52 tests pass。
  - `npm run format:check` 通过；期间仅修复 `docs/nexus/go-runner-plan.md` header 三处 trailing whitespace，未运行自动格式化。

## 2026-06-04 — AgentJobRegistry State Machine

- **用户请求**: 根据建议继续推进。
- **实现**:
  - 新增 `src/nexus/agents/AgentJobRegistry.ts`，实现 in-memory `AgentJobRegistry`、`AgentJobRegistryError`、terminal status helper 与 defensive clone helper。
  - Registry 支持创建 queued explore job、profile 默认 context fork/isolation、parent/status/profile filter、queued/running/waiting_permission/completed/failed/cancelled 状态转换、terminal transition guard、waiter resolve、wait timeout 和 cancel。
  - Parent 默认只拿到 structured `AgentResult` 与 `transcriptPath` reference，不注入完整 child transcript；返回对象做 defensive clone，避免外部 mutation 污染 registry state。
  - 新增 `test/agent-job-registry.test.ts` 并纳入默认 `npm test`，覆盖状态机、filter、wait/cancel、invalid transition、timeout、defensive clone 与 transcript reference-only contract。
  - `TODO_agents.md` / `DONE.md` 已同步；read-only Explore Agent MVP 仍是下一步未完成项。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-agent-job-registry-test-config.json npx tsx --test --test-concurrency=1 test/agent-job-registry.test.ts` 通过，8/8 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-agent-job-registry-typecheck-config.json npm run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-agent-registry-core-test-config.json npx tsx --test --test-concurrency=1 test/agent-profiles.test.ts test/agent-job-registry.test.ts test/agent-loop.test.ts` 通过，42/42 tests pass。
  - `npm run format:check` 通过。

## 2026-06-04 — Agent Core Types / Profiles

- **用户请求**: 推进 #1Agent core types / profiles。
- **实现**:
  - 新增 `src/nexus/agents/types.ts`，定义 `ContextForkMode`、`AgentProfileId`、`AgentJobStatus`、`AgentIsolationMode`、`AgentProfile`、`AgentJob`、`AgentResult`、spawn/wait/filter request types 与 `AgentScheduler` interface 占位。
  - 新增 `src/nexus/agents/AgentProfiles.ts`，第一版只启用 read-only `explore` profile：默认工具 `Read/Grep/Glob`、默认 `minimal` context fork、`none` isolation、禁用 Bash 与编辑权限。
  - 新增 `src/nexus/agents/AgentResult.ts` 作为 structured result import point。
  - 新增 `test/agent-profiles.test.ts` 并纳入默认 `npm test`，覆盖 explore profile 安全默认值、仅 explore profile 启用、AgentJob/AgentResult 结构化契约。
  - `TODO_agents.md` / `DONE.md` 已同步；本切片只落 core contracts/profile groundwork，不改变既有 `runAgentLoop()` 行为，`AgentJobRegistry` 仍是下一步未完成项。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-agent-profiles-test-config.json npx tsx --test --test-concurrency=1 test/agent-profiles.test.ts` 通过，3/3 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-agent-profiles-typecheck-config.json npm run typecheck` 通过。
  - `npm run format:check` 通过；期间仅修复 `docs/nexus/context-and-subagent-upgrade-plan.md` 一处 trailing whitespace，未运行自动格式化。

## 2026-06-04 — Provider Model Capability Diagnostics

- **用户请求**: 根据建议继续推进。
- **实现**:
  - `src/providers/registry.ts` 新增 `inspectModelCapabilities()`，统一输出 provider adapter/auth mode、registry declaration、capability source、context window、default max tokens、tool/json/structured/streaming、long-context 与 AgentLoop role suitability。
  - `ConfigManager.getProviderDiagnostics()` 复用 registry helper，runtime provider diagnostics 现在暴露 `modelDeclared`、`capabilitySource`、`capabilityWarning` 与 role suitability；unknown/custom provider-scoped model 继续允许配置，但以 undeclared 保守占位展示，不触发自动模型切换。
  - `bbl models inspect` 输出 provider、adapter、auth mode、registry declaration、静态能力表、AgentLoop role suitability，并对 unknown/custom OpenAI-compatible model 显示“未声明，不做强拦截”的提示。
  - `test/providers.test.ts`、`test/runtime-llm.test.ts`、`test/provider-recovery.test.ts` 已补能力诊断与 fixture 回归；`TODO_provider_registry.md` / `DONE.md` 已同步。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-provider-diagnostics-test-config.json npx tsx --test --test-concurrency=1 test/providers.test.ts test/runtime-llm.test.ts` 通过，60/60 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-provider-diagnostics-typecheck-config.json npm run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-provider-diagnostics-recovery-config.json npx tsx --test --test-concurrency=1 test/provider-recovery.test.ts` 通过，7/7 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-provider-diagnostics-cli-known-config.json npm run cli -- models inspect openai/gpt-4o` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-provider-diagnostics-cli-config.json npm run cli -- models inspect openai/custom-model` 通过。
  - `npm run format:check` 通过。

## 2026-06-04 — Runtime Regression Suite Guardrail

- **用户请求**: 推进 #1 Runtime。
- **实现**:
  - 核对 `npm test` 默认入口，确认 token estimator、blocking/context diagnostics、microcompact、compact post-restore、context display/API、working set、prefix cache 与 path mention 已由现有 focused suites 覆盖。
  - `package.json` 将遗漏的 `test/tool-result-budget.test.ts` 纳入默认 `npm test`，补齐工具结果持久化、消息级预算和 Read aggregate budget 守门。
  - `TODO_runtime.md` / `DONE.md` 已同步：Runtime context 回归套件收口完成。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-runtime-suite-config.json npx tsx --test --test-concurrency=1 test/tool-result-budget.test.ts test/context-assembler.test.ts test/context-regression.test.ts test/working-set.test.ts test/prefix-cache.test.ts test/path-mention.test.ts test/token-estimator.test.ts` 通过，86/86 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-runtime-suite-typecheck-config.json npm run typecheck` 通过。
  - `npm run format:check` 通过。

## 2026-06-04 — P1 Read Repeat Large File Diagnostics

- **用户请求**: 根据建议继续推进，并继续当前任务。
- **实现**:
  - `src/tools/builtin/read.ts` 的 read ledger 扩展为记录 sessionId、fileBytes、byte range、line range、session read index 与 read mode。
  - 重复完整读取同一大文件时，`<read-repeat>` 诊断新增 `previousLines`、`currentLines`、`lastReadIndex`，并明确提示此前读取的 byte/line range 与 session read #，继续引导 offset/limit、Grep/Glob 或 targeted read。
  - 显式 offset/limit targeted read 仍绕过 repeat 诊断，避免阻断模型按提示读取下一段。
  - `test/read-tool.test.ts` 扩展重复大文件读取 focused 回归，覆盖 byte range、line range、session read index、targeted read 不触发 repeat。
  - `TODO_runtime.md` / `DONE.md` 已同步：P1 重复大文件读取诊断已完成。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-read-repeat-test-config.json npx tsx --test --test-concurrency=1 test/read-tool.test.ts` 通过，3/3 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-read-repeat-typecheck-config.json npm run typecheck` 通过。
  - `npm run format:check` 通过。

## 2026-06-04 — P2 Remote Runner HTTP Transport

- **用户请求**: 继续推进实现真实 remote runner transport 的最小协议层。
- **实现**:
  - `src/runtime/remoteRunner.ts` 新增 `HttpRemoteToolRunner`，通过 HTTP/JSON 调用 `/v1/remote-runner/execute` 与 `/v1/remote-runner/cancel`，保留 client-side capability filtering 与 shaped result/error 解析。
  - `src/runtime/remoteRunner.ts` 新增 `createRemoteToolRunnerServer()`，提供 capabilities、execute、cancel 三个最小协议 endpoint；execute 校验 protocol version、tool capability 与 tool input schema 后执行本地 tool，并把 tool result 或 structured error 映射回 remote runner result。
  - `test/runtime.test.ts` 新增 HTTP transport focused 回归，覆盖 Read 通过协议 server 执行、cancel 转发到 server abort、server-side tool failure 作为 runner result 回传。
  - `TODO_runtime.md` / `DONE.md` 已同步：真实 remote runner 最小 HTTP transport 已完成；部署、runner 调度、文件同步与 remote provider loop 仍为 non-goals。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-remote-transport-test-config.json npx tsx --test --test-concurrency=1 test/runtime.test.ts --test-name-pattern "HTTP remote runner transport"` 通过，82/82 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-remote-transport-typecheck-config.json npm run typecheck` 通过。
  - `npm run format:check` 通过。

## 2026-06-04 — P2 Remote Runner Parity Regressions

- **用户请求**: 继续根据建议推进。
- **实现**:
  - `test/permission-flow.test.ts` 新增 remote `Write` permission-before-dispatch 回归：配置 `InMemoryRemoteToolRunner` 时，Nexus 在用户批准前不调用 runner，批准后才 dispatch，并持久化 approved permission audit。
  - `test/permission-flow.test.ts` 新增 remote deny-no-dispatch / audit parity 回归：用户拒绝 remote `Write` 后 runner request 计数保持 0，事件包含 `permission_response` / `tool_denied`，permission audit 持久化为 denied。
  - `test/runtime.test.ts` 新增 remote ExecutionGate 容量回归：长时间 active 的 remote runner 占用 Nexus execution gate，第二个请求返回 `EXECUTION_BUSY`，首个请求超时后写入 `REQUEST_TIMEOUT` envelope 并触发 runner cancel。
  - `TODO_runtime.md` / `DONE.md` 已同步：remote parity 回归已完成，真实 remote runner transport 仍未实现。
- **验证**:
  - `cd /Users/tangyaoyue/DEV/BABEL/BabeL-O && BABEL_O_CONFIG_FILE=/tmp/babel-o-remote-parity-test-config.json npx tsx --test --test-concurrency=1 test/permission-flow.test.ts test/runtime.test.ts` 通过，89/89 tests pass。
  - `cd /Users/tangyaoyue/DEV/BABEL/BabeL-O && npm run typecheck` 通过。
  - `cd /Users/tangyaoyue/DEV/BABEL/BabeL-O && npm run format:check` 通过。

## 2026-06-04 — P2 Remote Runner Test-double Transport

- **用户请求**: 根据建议继续推进 P2。
- **实现**:
  - `src/runtime/remoteRunner.ts` 新增 `RemoteToolRunnerCancelRequest`、`InMemoryRemoteToolRunner` 与 handler context `AbortSignal`，test-double runner 会记录 execute/cancel request，并按 request key abort 对应 handler signal。
  - `executeToolSafely()` 的 remote 分支接入 cancel/timeout：parent abort、`timeoutSignal` abort 与工具级 timeout 都会 best-effort 调用 `remoteRunner.cancelTool()`，并继续映射既有 `REQUEST_CANCELLED` / `REQUEST_TIMEOUT`；remote runner error/result 仍复用现有错误与 truncation 映射。
  - `test/runtime.test.ts` 改用导出的 `InMemoryRemoteToolRunner`，新增 cancel、timeoutSignal、runner error 和 output truncation focused 回归；仍覆盖配置 runner dispatch 与未配置 runner 不回落本地工具执行。
  - `TODO_runtime.md` / `DONE.md` 已同步：test-double transport 已完成，真实 remote transport、permission/audit parity 与容量回归仍保留为后续项。
- **验证**:
  - `cd /Users/tangyaoyue/DEV/BABEL/BabeL-O && BABEL_O_CONFIG_FILE=/tmp/babel-o-remote-runner-test-config.json npx tsx --test --test-concurrency=1 test/runtime.test.ts` 通过，78/78 tests pass。
  - `cd /Users/tangyaoyue/DEV/BABEL/BabeL-O && npm run typecheck` 通过。

## 2026-06-04 — P2 RemoteToolRunner Minimal Seam

- **用户请求**: 根据建议继续推进 P2。
- **实现**:
  - 新增 `src/runtime/remoteRunner.ts`，定义 remote runner protocol version、`RemoteToolRunnerExecuteRequest`、`RemoteToolRunnerResult`、`RemoteToolRunner`、`NoopRemoteToolRunner`、capability helper 与未配置 runner 的标准错误结果。
  - `RuntimeExecuteOptions` 新增可选 `remoteRunner`；`createDefaultNexusRuntime()` 与 `createNexusApp()` 支持传入 remote runner。
  - `/v1/execute` 与 `/v1/stream` 的 remote 拦截从固定 501 调整为最小 capability 前置：未配置 runner 时继续 `NOT_IMPLEMENTED`，配置 runner 时放行给 runtime。
  - `executeToolSafely()` 新增 `executionEnvironment === 'remote'` 分支：不调用本地 `tool.execute()`，改为检查 runner capability、构造 protocol request、调用 runner，并复用现有 output truncation 与错误映射。
  - `LocalCodingRuntime` 与 provider `runtimeToolLoop` 将 `toolUseId` 传入 execution seam，remote protocol request 可携带 tool identifier。
  - `test/runtime.test.ts` 新增配置 runner dispatch 与未配置 runner direct runtime 不回落本地工具执行的 focused 回归。
- **验证**:
  - `cd /Users/tangyaoyue/DEV/BABEL/BabeL-O && BABEL_O_CONFIG_FILE=/tmp/babel-o-remote-runner-test-config.json npx tsx --test --test-concurrency=1 test/runtime.test.ts` 通过，75/75 tests pass。
  - `cd /Users/tangyaoyue/DEV/BABEL/BabeL-O && npm run typecheck` 通过。

## 2026-06-04 — P2 Execution Environments / Remote Runner Protocol Design

- **用户请求**: 根据建议继续 P2 Execution Environments / remote runner protocol 设计。
- **现状核对**:
  - `RuntimeExecuteOptions` 与 `ToolContext` 已有 `executionEnvironment?: 'local' | 'docker' | 'remote'` seam。
  - `src/nexus/app.ts` 的 `/v1/execute` 与 `/v1/stream` 当前对 `remote` 返回明确 501，占位行为保留。
  - Docker execution 目前只在 builtin `Bash` 内部实现；`executeToolSafely()` 是工具执行前后的统一安全包装点。
  - `runtimeToolLoop` / `LocalCodingRuntime` 仍拥有 permission、hooks、policy、audit 和 tool event flow；`PendingPermissionBackend` seam 可为后续多进程权限状态同步提供基础。
- **设计**:
  - Nexus 作为唯一控制面：继续拥有 session/event/storage/permission/audit/timeout/cancel；remote runner 只执行已授权单个 tool call，不运行 provider loop、不持久化 session、不决定权限。
  - remote dispatch 以 `executeToolSafely()` 为唯一 seam，协议请求携带 protocol version、session/request/tool identifiers、tool input、cwd/allowedPaths、output budget、Bash buffer、deadline 与 runner capability metadata。
  - runner 响应只返回 tool execution result/error metadata；Nexus 复用现有 `tool_completed` / `error` / `result` / metrics / storage append 路径并负责 redaction/truncation。
  - cancel/timeout 以 Nexus `AbortController` 和 deadline 为权威；取消通过 best-effort `tool.cancel.request` 下发，结果仍映射既有 `REQUEST_CANCELLED` / `REQUEST_TIMEOUT`。
  - 明确 non-goals：本阶段不做 remote provider loop、remote session storage、任意用户 shell hook、MCP federation、跨 runner 调度或文件同步协议。
- **文档同步**:
  - `TODO_runtime.md` 已将 remote runner protocol 设计标为完成，并新增后续未完成实现步骤：`RemoteToolRunner`/`NoopRemoteToolRunner`、capability validation、`executeToolSafely()` remote dispatch 与回归覆盖。
  - `DONE.md` 已同步：remote runner protocol 已完成 P2 设计，实际 dispatch/transport 仍未实现。

## 2026-06-04 — P2 Permission Pending backend

- **用户请求**: 根据建议继续推进 P2。
- **实现**:
  - `src/shared/session.ts` 新增正式 `PendingPermissionBackend` 接口与默认 `InMemoryPendingPermissionBackend`，`PendingPermissionRegistry` 继续作为现有 singleton façade，但 register/resolve/resolveSession/sweep/pendingCount/reset 已委派 backend。
  - `PendingPermissionRegistry.setBackend()` 支持替换 backend，并在替换前 resolve 旧 pending entry，避免悬挂权限请求；`resetForTest()` 恢复默认 in-memory backend 与 TTL。
  - `test/permission-flow.test.ts` 新增 replaceable backend 回归，使用 `RecordingPermissionBackend` 验证 register/resolve/pendingCount 委派；既有 HTTP/WS/smart permission flow 保持不变。
  - `TODO_runtime.md` / `DONE.md` 已同步：permission pending state backend seam 已完成；SQLite/Nexus-owned backend 与 remote runner protocol 仍未实现。
- **验证**:
  - `cd /Users/tangyaoyue/DEV/BABEL/BabeL-O && BABEL_O_CONFIG_FILE=/tmp/babel-o-permission-backend-test-config.json npx tsx --test --test-concurrency=1 test/permission-flow.test.ts test/runtime.test.ts` 通过，81/81 tests pass。
  - `cd /Users/tangyaoyue/DEV/BABEL/BabeL-O && BABEL_O_CONFIG_FILE=/tmp/babel-o-permission-backend-test-config.json npx tsx --test --test-concurrency=1 test/permission-flow.test.ts` 通过，8/8 tests pass。
  - `cd /Users/tangyaoyue/DEV/BABEL/BabeL-O && npm run typecheck` 通过。
  - `cd /Users/tangyaoyue/DEV/BABEL/BabeL-O && npm run format:check` 通过。

## 2026-06-04 — P2 Architecture Boundary

- **用户请求**: 根据建议继续推进 P2。
- **实现**:
  - `src/cli/embedded.ts` 扩展为 embedded Nexus API client：`createEmbeddedNexusClient()` 通过 `createDefaultNexusRuntime()` + `createNexusApp().inject()` 复用 Nexus API，支持 status、tool audit、execute、session events、compact、context analysis、close 和 list sessions。
  - `src/cli/commands/chat.ts` 的 embedded local session close、tool audit、resume history、`/context`、`/compact`、`/sessions` 改走 embedded client；CLI 层不再直接 import `SqliteStorage`、`closeNexusSession`、`compactSession`、`analyzeContext`、`LLMCodingRuntime`。
  - `src/cli/NexusClient.ts` 的 `listSessions()` 支持 limit 参数，使 service mode 与 embedded mode 调用口径一致。
  - 新增 `test/architecture-boundary.test.ts`，覆盖 embedded client app injection 可用性，并静态守住 `chat.ts` 不穿透 storage/runtime internals；默认 `npm test` 已纳入该测试。
  - `TODO_runtime.md` / `DONE.md` 已同步：embedded local 明确为本地单进程路径，Nexus-only service mode 继续走 HTTP/WS；permission pending backend 抽象仍保留为下一步未完成项。
- **验证**:
  - `cd /Users/tangyaoyue/DEV/BABEL/BabeL-O && BABEL_O_CONFIG_FILE=/tmp/babel-o-boundary-test-config.json npx tsx --test --test-concurrency=1 test/architecture-boundary.test.ts` 通过，2/2 tests pass。
  - `cd /Users/tangyaoyue/DEV/BABEL/BabeL-O && BABEL_O_CONFIG_FILE=/tmp/babel-o-boundary-test-config.json npx tsx --test --test-concurrency=1 test/architecture-boundary.test.ts test/run-session-flow.test.ts test/runtime.test.ts` 通过，77/77 tests pass。
  - `cd /Users/tangyaoyue/DEV/BABEL/BabeL-O && npm run typecheck` 通过。
  - `cd /Users/tangyaoyue/DEV/BABEL/BabeL-O && npm run format:check` 通过。
  - `cd /Users/tangyaoyue/DEV/BABEL/BabeL-O && npm test` 通过，467/467 tests pass。

## 2026-06-04 — P2 Hook Lifecycle / Invocation Diagnostics

- **用户请求**: 根据建议继续推进 P2。
- **实现**:
  - `src/runtime/hooks.ts` 新增 `PreInvocation` / `PostInvocation` hook event，并扩展 `RuntimeHookInput.invocation` metadata：provider/model、loop/maxLoops、role、context estimate/max/percent、tool/visible tool count、cache preservation、final-response-only、duration、success、errorCode、failureKind。
  - 新增内置 `InvocationDiagnosticsHook`，只通过现有 `hook_started` / `hook_completed` / `hook_failed` 事件返回 summary/metadata，不执行外部命令。
  - `LLMCodingRuntime.ts` 在每次 provider call 前后执行 invocation hooks；失败路径先发 `PostInvocation(success=false)` 并带 provider recovery `failureKind`，再交回既有 provider recovery/error 流程。
  - `test/hooks.test.ts` 覆盖内置 invocation hook metadata；`test/runtime-llm.test.ts` 覆盖 provider call 前后的 hook 事件顺序和核心 metadata。
  - `package.json` 默认 `npm test` 已纳入 `test/hooks.test.ts`。
  - `TODO_runtime.md` / `DONE.md` 已同步 Hook Lifecycle 收口状态；当前仍不开放任意用户 shell hook。
- **验证**:
  - `cd /Users/tangyaoyue/DEV/BABEL/BabeL-O && BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/hooks.test.ts test/runtime-llm.test.ts` 通过，59/59 tests pass。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run format:check` 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O test` 通过，465/465 tests pass。

## 2026-06-04 — P2 TUI: Path Mention / Completer

- **用户请求**: 根据建议继续推进 P2。
- **实现**:
  - 新增 `src/cli/pathMention.ts`：提供 lazy `WorkspacePathIndex`、fuzzy basename/path 匹配、50K entry cap、scan budget、dot-dir 可发现，以及 dependency/build 目录跳过策略。
  - `src/cli/completer.ts` 复用 Path Mention 模块；普通自然语言 token 不再触发目录扫描，只有 `@` mention 或路径分隔符 token 触发路径补全。
  - 新增 `test/path-mention.test.ts`，覆盖 lazy index、`.babel-o` / `.claude` 可发现、`node_modules` 跳过、workspace escape、URL 排除和 entry cap；默认 `npm test` 已纳入 Path Mention 测试。
  - `TODO_runtime.md` / `TODO_tui.md` / `DONE.md` 已同步 Path Mention 收口状态。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/path-mention.test.ts /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/completer.test.ts` 通过，18/18 tests pass。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run format:check` 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O test` 通过，454/454 tests pass。

## 2026-06-03 — P2 Context Foundation: Prefix Cache 稳定性策略

- **用户请求**: 根据建议继续推进 P2。
- **实现**:
  - 新增 `src/runtime/prefixCache.ts`：计算 cacheable immutable prefix 字符占比、volatile-content-last invariant，以及基于 cacheable system text + sorted tool names 的 SHA-256 fingerprint。
  - `runtimePipeline.ts` 抽出 provider system prompt block 构建，保证 execution state 作为 non-cacheable suffix，并提供 provider prefix cache diagnostics helper。
  - `LLMCodingRuntime.ts` 在 provider request 前吸收 Prefix Cache diagnostics，写入 `execution_metrics`。
  - `ExecutionMetrics`、Nexus event schema、SQLite migration、embedded metrics persistence、`/v1/runtime/metrics` 与 `/v1/runtime/status` 已接入 prefix cache diagnostics。
  - 新增 `test/prefix-cache.test.ts`，并扩展 system prompt builder/runtime 回归；默认 `npm test` 已纳入 Prefix Cache 测试。
  - `TODO_runtime.md` / `DONE.md` 已同步 Prefix Cache 收口状态。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/prefix-cache.test.ts /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/system-prompt-builder.test.ts /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts` 通过，94/94 tests pass。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run format:check` 通过。

## 2026-06-03 — P2 Context Foundation: Working Set

- **用户请求**: 继续推进 P2 Context Foundation：Working Set。
- **实现**:
  - 新增 `src/runtime/workingSet.ts`：从 `user_message` 文本与 `tool_started.input` JSON 提取绝对/相对路径，记录 touches、lastTurn、isDir、source，并按 `touches * 4 + recency_bonus` 选择最多 16 个 entry。
  - `contextAssembler.ts` 从 compact-aware events 派生 Working Set，并传入 `buildSystemPromptSections()`。
  - `systemPromptBuilder.ts` 新增 non-cacheable `working_set` section，放在 request paths / focus 之后，避免进入 immutable prefix。
  - 新增 `test/working-set.test.ts`，并扩展 system prompt builder/context assembler 回归；默认 `npm test` 已纳入 Working Set 测试。
  - `TODO_runtime.md` / `DONE.md` 已同步 Working Set 收口状态。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json /Users/tangyaoyue/DEV/BABEL/BabeL-O/node_modules/.bin/tsx --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/working-set.test.ts /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/system-prompt-builder.test.ts /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/context-assembler.test.ts` 通过，66/66 tests pass。
  - `npm run typecheck --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O` 通过。
  - `npm run format:check --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O` 通过。

## 2026-06-03 — Read 策略与候选工具能力规划

- **用户请求**: 将 Read 工具算法优化纳入 TODO 规划，并评估自适应上下文上限、Search/ListDir、hook lifecycle 与 runtime 模型差异是否纳入规划。
- **决策**:
  - adaptive `Read` strategy 纳入当前 P1 Context Blocking Recovery：read ledger、小/中/大文件分层策略、intent-aware targeted read、基于 registry/effective ceiling 的 Read 预算。
  - `Search` / `ListDir` 不直接作为 P1 实现；登记为 P2 Tool Discovery / Targeted Reading，优先评估是否增强现有 `Grep` / `Glob`，避免重复工具。
  - `PreInvocation` / `PostInvocation` 等 hook lifecycle 扩展登记为 P2 diagnostics，不开放任意用户 shell hook。
  - runtime model capability diagnostics 登记为 P2 Provider/Agents 能力诊断：辅助 agent role 任务展示 context window、tool calling、structured output、streaming 能力缺口，但继续禁止 silent model switch，不恢复自动模型选择。
- **规划**:
  - `TODO_runtime.md` P1 增加 adaptive `Read` strategy，并新增 P2 Tool Discovery / Targeted Reading 与 Hook Lifecycle / Invocation Diagnostics。
  - `TODO_provider_registry.md` 新增 P2 Runtime Model Capability Diagnostics。
  - `TODO_agents.md` 新增 P2 Sub-agent Tooling / Role Assistance。
  - `TODO.md` 总控同步 P1 收口标准与主线下一步。

## 2026-06-03 — EverCore 长期语义记忆远期计划登记

- **用户请求**: 评估是否当前阶段引入 `/Users/tangyaoyue/DEV/EverOS/docs/babel-o-evercore-integration-plan.md`，并先更新到 TODO 文档作为相对远端计划。
- **决策**:
  - 当前不在 P1 Context Blocking Recovery 阶段实现 EverCore REST/MCP 接入。
  - EverCore 只作为 P3 长期语义记忆方向登记；等待 BabeL-O context recovery、Working Set、Prefix Cache、Path Mention 等上下文地基稳定后，再从可选 REST Spike 启动。
  - EverCore 不替代 BabeL-O SQLite storage、compact、Session Memory Lite、Working Set、Prefix Cache、permission audit 或 runtime hooks。
- **规划**:
  - `TODO_runtime.md` 新增 P3 “Long-Term Memory / EverCore Integration”，分为 REST Spike、Internal MemoryProvider、Context Budget / Diagnostics、Optional MCP Tools。
  - `TODO.md` 总控新增 P3 行，并在推进顺序与 Runtime 主线状态中明确当前只登记、不实现。

## 2026-06-03 — 真实会话 context blocking recovery 规划

- **用户请求**: 查看最新会话 `session_1e2299be-b988-49ea-8819-587de8258172` 并将设计优化规划到 TODO 文档。
- **分析结论**:
  - 目标 session 第一轮项目深度分析成功，第二轮继续深挖 runtime pipeline / AgentLoop 时，大量 `Read` 输出让上下文估算达到 `194769/179616`，超过 blocking limit `178616`，runtime 在下一次 provider call 前正确 hard-block。
  - provider fallback 没有 silent switch；`fallbackPolicy.allowSilentModelSwitch=false` 符合底线。
  - event log 中有 2 条 `execution_metrics`，但 `execution_metrics` side table 为 0 行，暴露 embedded/local CLI path metrics side-effect 与 HTTP/WS path 不一致。
  - manual compact 后存在 `compact_boundary`，但 session row 仍为 `phase=failed`，后续需要更清晰表达 retryable failed + compact 后可恢复状态。
- **规划**:
  - `TODO_runtime.md` 新增 P1 “真实会话 Context Blocking Recovery”：最小 regression fixture、provider-loop reactive compact、live `Read` aggregate budget、重复大文件读取诊断、compact 后 retryable failed session 状态表达。
  - `TODO_performance.md` 新增 P1 “Embedded Metrics Persistence”：共享 metrics side-effect、embedded/local CLI metrics 回归、历史 session fallback 诊断口径。
  - `TODO.md` 总控恢复新的 P1 行，指向上述真实 session 回归收口。

## 2026-06-03 — 主动 P1 收口：BabeL-X compatibility、TUI 回归与 Runtime watchlist

- **用户请求**: 推进完成全部 P1 项。
- **实现**:
  - `src/shared/config.ts` 新增显式 BabeL-X config import plan：解析 BabeL-X v1 `profiles`，仅导入 BabeL-O 已注册 provider（zhipu/openai/anthropic/deepseek/minimax），规范化模型 ID，跳过无 API key 或未注册 provider profile，默认不读取旧 `~/.babel/config.json`。
  - `src/cli/commands/config.ts` 新增 `bbl config import-babel-x --source <path> [--apply]`：默认 dry-run，只输出 profile/provider/model/hasApiKey/hasBaseUrl/skipped/warnings；`--apply` 合并写入 BabeL-O config，不覆盖无关现有配置；旧 transcript import 明确不支持，避免 BabeL-X 历史 schema 污染 Nexus runtime/session schema。
  - `test/runtime-llm.test.ts` 新增 BabeL-X import plan 回归，覆盖 MiniMax 模型别名、unsupported provider skip、empty key skip、显式路径加载和不读取默认旧配置；同时修正测试 config guard 断言，显式验证真实 `~/.babel-o/config.json` 路径拒写。
  - `test/tui-input.test.ts` 扩展 visual/keyboard 回归：history search overlay ownership、长路径/CJK/ANSI/resize 宽度、stale wrapped rows。
  - `test/tui-renderer.test.ts` 扩展 agent running indicator 回归：sub-agent running 与 active model/context gauge 组合展示。
  - `TODO_runtime.md` 将 Runtime P1 watchlist 归档为已收口说明，保留真实 drift regression-first 触发口径；`TODO.md` / `TODO_cleanup.md` / `TODO_tui.md` / `DONE.md` 已同步，主动 P1 不再保留未完成项。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O tsx --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime-llm.test.ts` 通过，48/48 tests pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O tsx --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/tui-input.test.ts /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/tui-renderer.test.ts` 通过，64/64 tests pass。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - CLI dry-run smoke 通过：临时 BabeL-X config 中的 `legacy-secret-key` 未出现在 `bbl config import-babel-x --source <tmp>` 输出中，且未写入目标 BabeL-O config。

## 2026-06-03 — P1 chat first-response 与 storageBridge fault injection

- **用户请求**: 根据建议推进完成 P1。
- **实现**:
  - `scripts/benchmark-performance-core.ts` 新增 `chatFirstResponse` benchmark section，覆盖 cold CLI startup、warm embedded execute、service HTTP execute，并输出 p50/p95、providerSdkLoaded、sqliteOpened、contextAssemblyTriggered、firstResponseEventType 和 responseEventCount。
  - `scripts/benchmark-performance-core.ts` 新增 `storageBridgeFaultInjection` benchmark section，覆盖 corrupt WAL skip/replay、SQLite write failure retry、crash interrupted replay 和 compact failure diagnostic，并输出 replay/skip/retry/retain strategy、诊断字符串、walPending/walBuffered/walWriteFailures 与成功/失败计数；基于结果暂保留 storageBridge 结构。
  - `package.json` 新增 `npm run test:performance`，指向同一 performance benchmark，作为 P1 性能/故障注入单独验证入口。
  - `src/shared/config.ts` 支持显式 `BABEL_O_CONFIG_DIR`，且当设置 `BABEL_O_CONFIG_FILE` 时默认配置目录落在该文件所在目录，避免 chat cold-start benchmark 写入真实 `~/.babel-o`；测试守门仍拒绝写真实用户默认 config。
  - `src/nexus/storageBridge.ts` 的 test reset 会清除当前 storage 引用，避免故障注入场景之间复用已关闭 storage。
  - `test/agent-loop.test.ts` 新增 storageBridge corrupt WAL skip/replay 与 compact failure diagnostic 回归。
  - `TODO.md` / `TODO_performance.md` / `DONE.md` 已同步：chat first-response、storageBridge fault injection 和 `test:performance` 从 P1 待办移出，后续 provider retry benchmark 与并发治理维持 P2。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-p1-storage-fault-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/agent-loop.test.ts --test-name-pattern "storageBridge"` 通过，31/31 tests pass。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run test:performance` 通过，输出包含 `chatFirstResponse` 与 `storageBridgeFaultInjection`。

## 2026-06-03 — P1 工程发布底座、lint/CI/coverage 与 API scale benchmark

- **用户请求**: 根据建议推进完成 P1。
- **实现**:
  - `scripts/benchmark-performance-core.ts` 新增 `apiScale` benchmark section，构造 1000 sessions / 8000 events 的固定数据集，分别覆盖 MemoryStorage 与 SqliteStorage 的 `/v1/sessions`、`/v1/sessions/:id`、`/v1/sessions/:id/events`、`/v1/sessions/:id/assets`，输出 p50/p95、payload bytes、item/event count 与 query count 近似诊断。
  - 新增 `scripts/audit-dependency-boundary.js` 与 `npm run deps:audit`，输出 direct dependency ownership、runtime reachable imports、CLI imports，并拦截 missing ownership、runtime→CLI dependency leak、dev dependency leak 和 undeclared third-party import。
  - CLI 远程 WebSocket 路径使用的 `ws` 已补为显式 CLI dependency，避免依赖 transitive package。
  - 新增 `scripts/smoke-production-build.js` 与 `npm run build:smoke`，先执行 production build，再验证 `bbl --help`、`bbl chat --help`、`bbl run hello` 走 `dist/cli/program.js`。
  - 新增 `scripts/check-format.js` 与 `npm run format:check`，只检查 CRLF、final newline、trailing whitespace 和 JSON parse，不自动改写文件；`npm run lint` 串联 typecheck、format check 和 dependency boundary audit。
  - 新增 `scripts/coverage-report.js` 与 `npm run coverage`，使用 Node V8 coverage 产出 `coverage/coverage-summary.json`，当前不设置硬阈值。
  - 新增 `.github/workflows/ci.yml`，CI 覆盖 `npm ci`、typecheck、format check、dependency audit、full test 和 production build smoke。
  - `TODO.md` / `TODO_performance.md` / `TODO_cleanup.md` / `DONE.md` 已同步：Cache-aware P1 从总控当前优先级移出，1000+ API scale、production build smoke、dependency boundary audit、check-only lint/format、CI workflow 与 coverage report 进入已完成能力索引；剩余 P1 聚焦 BabeL-X compatibility strategy、chat first response、storageBridge fault injection、retry policy benchmark 和并发测试治理。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run benchmark` 通过，输出 `apiScale`，其中 MemoryStorage/SqliteStorage 均覆盖 1000 sessions、8000 events、sessions/detail/events/assets route p50/p95 与 payload 诊断。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run deps:audit` 通过，failure diagnostics 全为空。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run format:check` 通过，failureCount 为 0。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run lint` 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run coverage` 通过，133/133 tests pass，生成 `coverage/coverage-summary.json`，function coverage 57.78%。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O test` 通过，429/429 tests pass。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run build:smoke` 通过，`bbl --help`、`bbl chat --help`、`bbl run hello` exitCode 均为 0。

## 2026-06-03 — Cache-aware Compact benchmark/runtime metrics follow-up

- **用户请求**: 根据建议推进 Cache-aware compact 的 benchmark/runtime metrics follow-up，把 first-token latency、cacheRead/cacheCreation、summary latency、effective ceiling 写入性能诊断。
- **实现**:
  - `runtimePipeline.ts` 的 `RuntimeExecutionMetrics` 扩展 provider usage/cache tokens、effective/legacy context ceiling、cache policy mode、cache read ratio 和 compact summary latency；provider stream usage delta 会累计到 runtime metrics。
  - `compactSession()` 返回 `summaryLatencyMs`，`LLMCodingRuntime` 在 auto/reactive compact 后写入 execution metrics。
  - `execution_metrics` event schema、`Storage.ExecutionMetrics`、SQLite migration v6、session assets 和 `/v1/runtime/metrics` 聚合已透传新增字段，包含 first-token latency、cacheRead/cacheCreation、effective ceiling 与 compact summary latency。
  - `scripts/benchmark-performance-core.ts` 新增 `cacheAwareCompact` benchmark section，并在 `autoCompact` 输出 summary/recovery summary latency。
  - `test/runtime.test.ts` 增加 focused 回归，覆盖 provider usage 聚合、execution metrics event 字段、session assets passthrough 和 runtime metrics snapshot 聚合。
  - `TODO_runtime.md` / `DONE.md` 已同步：benchmark/runtime metrics follow-up 从待办移出。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json /Users/tangyaoyue/DEV/BABEL/BabeL-O/node_modules/.bin/tsx --test --test-concurrency=1 --test-name-pattern "runtime pipeline collects provider turn deltas and usage events|runtime execution metrics include cache-aware compact diagnostics|runtime metrics aggregates cache-aware performance diagnostics|/v1/sessions/:sessionId/assets returns SDK dashboard data assets" /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts`：4/4 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run benchmark` 通过，输出包含 `autoCompact.summaryLatencyMs`、`autoCompact.recoverySummaryLatencyMs` 与 `cacheAwareCompact.effectiveContextCeiling/cacheReadInputTokens/cacheCreationInputTokens`。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 无输出。

## 2026-06-03 — Cache-aware Compact / 长上下文利用

- **用户请求**: 推进 P1 Cache-aware Compact / 长上下文利用。
- **实现**:
  - 新增 `src/runtime/cacheAwareCompactPolicy.ts`，根据 model contextWindow、reserved output、provider safety buffer、usage cache read/create tokens、system prompt cacheable ratio、env hard cap 和 provider context error 输出 `effectiveContextCeiling`、warning/compact/blocking thresholds、cache-preserving / long-context mode 和 reason。
  - `allocateBudget()` 改为消费 adaptive effective ceiling；MiniMax/Anthropic/Zhipu 大上下文模型默认可突破旧 120k cap，同时保留 output/provider safety buffer，`BABEL_O_MAX_CONTEXT_TOKENS` 继续作为硬上限。
  - `runtimePipeline.ts` / `LLMCodingRuntime.ts` 将 policy 接入 context refresh、auto compact decision 和 provider loop request guard；默认 compact threshold 统一到 90%，高 cache reuse 时提升到 93%，provider context error 时保守降到 80%。
  - `analyzeContext()`、HTTP context API passthrough 和 CLI `/context` 展示 cache economics：cache read ratio、cacheable system prompt ratio、preserving/long-context mode、effective vs legacy ceiling 和 policy reason。
  - `test/context-assembler.test.ts` / `test/runtime.test.ts` 增加 focused 回归，覆盖 adaptive ceiling、env cap reason、高 cache-read 不早 compact、provider context error 保守 compact、provider loop guard 消费 policy ceiling 和 `/context` reason 输出。
  - `TODO_runtime.md` / `DONE.md` 已同步：核心能力收口，后续只保留 benchmark/runtime metrics 写入。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/context-assembler.test.ts --test-name-pattern "allocateBudget|analyzeContext|cache-aware|cache policy|context display"`：45/45 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts --test-name-pattern "runtime pipeline|context|compact"`：69/69 通过。

## 2026-06-03 — TUI tool/model overlay 与 agent terminal states smoke

- **用户决策**: 继续推进 P1 TUI 剩余开发项，优先补唯一输入框高风险 overlay 路径和 agent running indicator 的 retrying/done/failed 覆盖。
- **处理**:
  - `bbl chat` 的 `/tool` 路径在打开 interactive dropdown 时显式进入 `inputState.toolPalette`，关闭后恢复 idle，避免 tool picker 与主 readline 同时成为输入 owner。
  - `/model` wizard 路径显式进入 `inputState.modelWizard`，取消或异常后恢复 idle；真实配置写入仍只在完成 wizard 后发生，PTY smoke 走 Escape cancel 路径。
  - PTY driver 的 screen simulator 支持 `ESC[s` / `ESC[u` cursor save/restore，能更准确断言 dropdown/wizard overlay 清理后不会残留二次输入框。
  - 新增 `tool-model-overlay-routing` PTY smoke，覆盖 tool picker 与 model wizard 的 ↑/↓/Esc 路由、关闭后单一 input owner 和无 overlay 残留。
  - 新增 `agent-running-terminal-states` PTY smoke，覆盖等待权限、成功 Bash、失败 Bash 后 live status 清理，并断言 compact tool rows 保留 done/failed 终态。
  - `startAgentStatus('retrying')` renderer 回归已补齐；`TODO_tui.md` / `DONE.md` 已同步，后续只保留 history search、scroll/resize 截图类回归和新增 provider retry/multi-agent terminal state 组合。
- **验证**:
  - `env BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-tui-p1-focused-*.json /Users/tangyaoyue/DEV/BABEL/BabeL-O/node_modules/.bin/tsx --test --test-concurrency=1 test/tui-renderer.test.ts test/tui-input.test.ts test/completer.test.ts`：70/70 通过。
  - `env BABEL_O_RUN_PTY_SMOKE=1 BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-tui-p1-pty-*.json /Users/tangyaoyue/DEV/BABEL/BabeL-O/node_modules/.bin/tsx --test --test-concurrency=1 test/tui-pty-smoke.test.ts`：23/23 通过。
  - `env BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-tui-p1-typecheck-*.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `env BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-tui-p1-build-*.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run build` 通过。
  - `env BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-tui-p1-build-binary-*.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run build:binary` 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 无输出；测试均使用隔离 `BABEL_O_CONFIG_FILE`。

## 2026-06-03 — TUI AgentLoop/sub-agent 入口与键盘路由 smoke

- **用户决策**: 根据 `TODO_tui.md` 推进 P1 TUI：补齐 run sub-agent / AgentLoop 的 TUI 可见入口和 PTY smoke，并继续守住唯一输入框 / 键盘路由回归。
- **处理**:
  - `bbl chat` 新增 `/agentloop-smoke`（兼容 `/agent-loop-smoke`）确定性入口，使用真实 AgentLoop/sub-agent 事件名与 metadata shape 渲染 mock 层级，不依赖真实 provider credentials。
  - TUI renderer 支持 sub-agent running 状态和任务面板 transcript metadata，能展示 parent blocked、child running/completed、depth、parentTaskId、subSession 与 `nexus://sessions/.../events` transcript 引用。
  - slash palette/completer/autosuggestion 加入 `/agentloop-smoke`，并修复真实 PTY 中单独 Escape 的关闭路径：降低 chat readline `escapeCodeTimeout`，同时保留 Escape 恢复原 query 的行为。
  - PTY smoke 新增 `agentloop-subagent-smoke` 和 `unique-input-keyboard-routing`，覆盖 AgentLoop 层级、slash palette Esc/Tab/Enter、长 CJK 输入、permission panel Backspace/Esc 路由、单一 input owner 和运行状态不残留。
  - `TODO_tui.md` / `DONE.md` 已同步：run sub-agent / AgentLoop smoke 与唯一输入框键盘路由主路径当前收口，后续 TUI P1 保留 tool palette/history/model wizard/scroll/resize 视觉回归与 retrying/done/failed running indicator 组合场景。
- **验证**:
  - `env BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-agentloop-tui-direct-*.json /Users/tangyaoyue/DEV/BABEL/BabeL-O/node_modules/.bin/tsx --test --test-concurrency=1 test/tui-renderer.test.ts test/tui-input.test.ts test/completer.test.ts test/optimize-command.test.ts`：76/76 通过。
  - `env BABEL_O_RUN_PTY_SMOKE=1 BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-pty-full-*.json /Users/tangyaoyue/DEV/BABEL/BabeL-O/node_modules/.bin/tsx --test --test-concurrency=1 test/tui-pty-smoke.test.ts`：21/21 通过。
  - `env BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-typecheck-agentloop-tui-*.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `env BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-build-agentloop-tui-*.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run build` 通过。
  - `env BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-build-binary-agentloop-tui-*.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run build:binary` 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 无输出；测试均使用隔离 `BABEL_O_CONFIG_FILE`，未写真实 `~/.babel-o/config.json`。

## 2026-06-03 — Runtime provider request assembly / loop guard helper

- **用户决策**: 根据建议继续推进 P1 Runtime Core，做 provider request assembly / loop guard helper 小切片。
- **处理**:
  - `src/runtime/runtimePipeline.ts` 新增 `buildProviderLoopRequestState()`、`buildProviderQueryParams()` 和 `buildRuntimeContextBlockingEventsForLoop()`，统一每轮 visible tools 选择、context window guard、execution state block 与 provider query params 构造。
  - `src/runtime/LLMCodingRuntime.ts` 改为复用 provider request helper，主循环不再内联构造 provider query params 或 loop 内 context blocking event threshold；provider stream、metrics、tool execution、final-response-only outcome 行为保持不变。
  - `test/runtime.test.ts` 新增 provider request helper 回归，覆盖 final-response-only / intent suppression 的 visible tools、loop blocking threshold、prompt caching、thinking budget 与 message normalization。
  - 初次 focused LLM runtime 回归发现 final-response-only 边界多发起 1 次 provider call，原因是 helper 调用显式传入上一轮 `finalResponseOnlyMode=false`；已改回由当前 loop count 计算并通过原回归。
  - `TODO_runtime.md` / `DONE.md` 已同步：provider request assembly / loop guard helper 当前收口，后续 P1 Runtime Core 优先转向 runtime hook executor 用户配置层与结果聚合口径。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `env BABEL_O_CONFIG_FILE=/tmp/babel-o-p1-provider-request-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts --test-name-pattern "runtime pipeline|LLMCodingRuntime|context|execution metrics"`：69/69 通过。
  - `env BABEL_O_CONFIG_FILE=/tmp/babel-o-p1-provider-request-llm-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime-llm.test.ts --test-name-pattern "LLMCodingRuntime|tool|respond-only|context"`：46/46 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 无输出。

## 2026-06-03 — Runtime compact/reassemble state refresh helper

- **用户决策**: 根据建议继续推进 P1 Runtime Core，按文档下一项收口 compact/reassemble state refresh helper。
- **处理**:
  - `src/runtime/runtimePipeline.ts` 新增 `buildRuntimeContextRefreshState()` 与 `refreshRuntimeContextState()`，统一 compact 后 reassemble context、messages、visible tools、context token estimate、window state 与 auto compact decision 的刷新口径。
  - `src/runtime/LLMCodingRuntime.ts` 的初始 context assembly、auto compact 后重建和 reactive compact 后重建改为复用 refresh helper；`compactSession()` 调用和 `compact_boundary` 事件 yield 顺序保持在 runtime 主流程中。
  - `test/runtime.test.ts` 新增 compact refresh seam 回归，覆盖 messages/current tools/model-visible tools、context window state 与 auto compact failure count 刷新。
  - `TODO_runtime.md` / `DONE.md` 已同步：compact/reassemble state refresh helper 当前收口，后续 runtime pipeline 深拆转向 provider request assembly / loop guard 等仍可安全抽出的纯 helper。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `env BABEL_O_CONFIG_FILE=/tmp/babel-o-p1-compact-refresh-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts --test-name-pattern "runtime pipeline|compact|LLMCodingRuntime|context"`：68/68 通过。
  - `env BABEL_O_CONFIG_FILE=/tmp/babel-o-p1-compact-refresh-llm-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime-llm.test.ts --test-name-pattern "LLMCodingRuntime|tool|respond-only|context"`：46/46 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 无输出。

## 2026-06-03 — Runtime loop state / execution state helper

- **用户决策**: 继续做 P1 Runtime Core：loop state / execution state helper。
- **处理**:
  - `src/runtime/runtimePipeline.ts` 新增 `buildProviderLoopState()`、`shouldEnterFinalResponseOnlyMode()`、`countRuntimeTurnContextChars()` 和 `buildRuntimeExecutionStateBlock()`，统一每轮 final-response-only 判定、context chars 输入统计和 execution state block 构造。
  - `src/runtime/LLMCodingRuntime.ts` 改为复用 loop state helper，主循环不再内联统计 message chars 或本地构造 execution state block。
  - `test/runtime.test.ts` 新增 loop state seam 回归，覆盖 context chars 统计、must_respond / synthesize phase 和 execution state block 内容。
  - `TODO_runtime.md` / `DONE.md` 已同步：loop state / execution state helper 当前收口，后续 runtime pipeline 深拆聚焦 compact/reassemble state refresh helper。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `env BABEL_O_CONFIG_FILE=/tmp/babel-o-p1-loop-state-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts --test-name-pattern "runtime pipeline|LLMCodingRuntime|local runtime|execution metrics"`：67/67 通过。
  - `env BABEL_O_CONFIG_FILE=/tmp/babel-o-p1-loop-state-llm-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime-llm.test.ts --test-name-pattern "LLMCodingRuntime|tool|respond-only|context"`：46/46 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 无输出。

## 2026-06-03 — Runtime context blocking helper

- **用户决策**: 继续推进 BabeL-O P1 Runtime Core，并按文档稳步进行 loop state / context blocking helper 小切片。
- **处理**:
  - `src/runtime/runtimePipeline.ts` 新增 `buildContextWarningEvent()`、`buildContextBlockingEvent()`、`buildContextBlockingErrorDetails()`、`buildContextBlockingEvents()` 和 `buildContextBlockingMessage()`，统一 context blocking 的 warning、blocking、error、result 事件序列与 details 口径。
  - `src/runtime/LLMCodingRuntime.ts` 的初始 blocking guard 和 loop 内 blocking guard 改为复用 `buildContextBlockingEvents()`，删除本地重复 context helper，保留 auto/reactive compact、fuse warning 和 metrics emission 行为。
  - `test/runtime.test.ts` 新增 context helper seam 回归，覆盖 warning/blocking/error/result 事件顺序、413 details、recovery actions 与 non-silent fallback policy。
  - `TODO_runtime.md` / `DONE.md` 已同步：context blocking helper 当前收口，后续 runtime pipeline 深拆聚焦 loop state / execution state helper。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `env BABEL_O_CONFIG_FILE=/tmp/babel-o-p1-context-helper-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts --test-name-pattern "runtime pipeline|context blocking|LLMCodingRuntime|local runtime|execution metrics"`：66/66 通过。
  - `env BABEL_O_CONFIG_FILE=/tmp/babel-o-p1-context-helper-llm-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime-llm.test.ts --test-name-pattern "LLMCodingRuntime|tool|respond-only|context"`：46/46 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 无输出。

## 2026-06-03 — Runtime provider turn outcome reducer

- **用户决策**: 继续推进 BabeL-O P1 Runtime Core，按优先级深拆 provider loop turn reducer / terminal outcome aggregator。
- **处理**:
  - `src/runtime/runtimePipeline.ts` 新增 `reduceProviderTurnOutcome()`，把 provider turn 后的 max_tokens recovery、final-response-only、respond-only suppression、empty response retry、final result 和 tool_calls 分支归一为纯 outcome。
  - `src/runtime/LLMCodingRuntime.ts` 改为消费 provider outcome，主循环只负责追加 messages、发出 outcome events、触发 Session Memory Lite pause update 和调用已抽出的 `executeProviderToolCall()`。
  - `test/runtime.test.ts` 新增 reducer seam 回归，覆盖 max token continue/terminal、respond-only suppression retry、final terminal 和 tool_calls outcome。
  - `TODO_runtime.md` / `DONE.md` 已同步：provider turn outcome reducer 当前收口，后续 runtime pipeline 深拆聚焦 loop state / context blocking helper。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `env BABEL_O_CONFIG_FILE=/tmp/babel-o-p1-turn-reducer-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts --test-name-pattern "runtime pipeline|runtime tool loop|local runtime|Read returns|execution metrics|LLMCodingRuntime"`：65/65 通过。
  - `env BABEL_O_CONFIG_FILE=/tmp/babel-o-p1-turn-reducer-llm-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime-llm.test.ts --test-name-pattern "LLMCodingRuntime|tool|respond-only|context"`：46/46 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 无输出。

## 2026-06-03 — Runtime tool loop execution helper

- **用户决策**: 继续推进 BabeL-O P1 Runtime Core，按小切片深拆 tool loop execution helper。
- **处理**:
  - 新增 `src/runtime/runtimeToolLoop.ts`，抽出 `executeProviderToolCall()` async generator，统一单个 provider tool call 的解析、policy、hook、schema、safety、permission、Read cache、tool execution、post-hook 与 tool_result 构造路径。
  - `src/runtime/LLMCodingRuntime.ts` 改为在 provider tool loop 中调用 `executeProviderToolCall()`，外层只负责顺序消费事件、处理 terminal outcome 和聚合 `toolResultsContent`。
  - `test/runtime.test.ts` 新增 direct seam 回归，覆盖成功 Read、未知工具 recoverable result、policy denied terminal result 和 metrics 更新。
  - `TODO_runtime.md` / `DONE.md` 已同步：tool loop execution helper 当前收口，后续 runtime pipeline 深拆聚焦 provider loop turn reducer / terminal outcome aggregator。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `env BABEL_O_CONFIG_FILE=/tmp/babel-o-p1-tool-exec-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts --test-name-pattern "runtime tool loop|runtime pipeline|local runtime|Read returns|execution metrics"`：62/62 通过。
  - `env BABEL_O_CONFIG_FILE=/tmp/babel-o-p1-tool-exec-llm-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime-llm.test.ts --test-name-pattern "LLMCodingRuntime|tool|respond-only|context"`：46/46 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 无输出。

## 2026-06-02 — Runtime tool loop/result aggregator seam

- **用户决策**: 继续推进 P1 Runtime Core 的 tool loop / result aggregator seam，保持 regression-first 小切片，不重写权限、Hook 或实际工具执行路径。
- **处理**:
  - `src/runtime/runtimePipeline.ts` 新增 `resolveProviderToolCallInput()`、`buildProviderAssistantMessage()`、`buildProviderToolResultsMessage()`、`buildRuntimeResultEvent()` 和 `buildRuntimeErrorEvent()`。
  - `src/runtime/LLMCodingRuntime.ts` 改为复用 provider tool input 解析、assistant/tool_result message 构造和主循环 terminal result/error event builder；权限审批、hook、schema validation、Read cache、`executeToolSafely()` 和 large tool result replacement 仍保留原内联顺序。
  - `test/runtime.test.ts` 新增 seam 回归，覆盖 explicit input 优先、partial JSON 解析、malformed partial input fallback、assistant/tool_result message 构造和 terminal result/error event 聚合。
  - `TODO_runtime.md` / `DONE.md` 已同步：tool loop/result aggregator seam 当前收口，后续 runtime pipeline 深拆聚焦 tool loop execution helper。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `env BABEL_O_CONFIG_FILE=/tmp/babel-o-p1-tool-loop-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts --test-name-pattern "runtime pipeline|local runtime|Read returns|execution metrics"`：59/59 通过。
  - `env BABEL_O_CONFIG_FILE=/tmp/babel-o-p1-tool-loop-llm-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime-llm.test.ts --test-name-pattern "LLMCodingRuntime|tool|respond-only|context"`：46/46 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 无输出。

## 2026-06-02 — Runtime pipeline minimum seam

- **用户决策**: 根据建议推进 P1 Runtime Core 可组合 runtime pipeline，采用 regression-first 小切片，避免一次性重写主循环。
- **处理**:
  - 新增 `src/runtime/runtimePipeline.ts`，抽出 `parseLocalRuntimeIntent()`、`streamProviderTurn()`、`RuntimeExecutionMetrics`、`createRuntimeExecutionMetrics()`、`buildRuntimeExecutionMetricsEvent()` 和 `absorbProviderTurnMetrics()`。
  - `src/runtime/LocalCodingRuntime.ts` 接入共享 local prompt parser 与 execution metrics builder，保留原工具执行、permission、hook 和 task update 行为。
  - `src/runtime/LLMCodingRuntime.ts` 接入 provider turn collector 与共享 metrics builder，provider stream delta 解析、usage/thinking/assistant_delta 事件和 tool call 收集变成可单测 seam；context blocking、max token recovery、empty response、tool loop、permission 与 hook 早退路径保持原语义。
  - `test/runtime.test.ts` 新增 runtime pipeline seam 回归，覆盖 local tool/task/file-question intent parser 与 provider turn delta/usage/tool-call collector；既有 runtime 与 LLM runtime focused 回归确认行为不漂移。
  - `TODO_runtime.md` / `DONE.md` 已同步：Runtime Core 最小 seam 当前收口，后续 pipeline 深拆聚焦 tool loop / result aggregator。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `env BABEL_O_CONFIG_FILE=/tmp/babel-o-p1-runtime-pipeline-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts --test-name-pattern "runtime pipeline|execute reads|local runtime|Read returns|/v1/execute|execution metrics"`：56/56 通过。
  - `env BABEL_O_CONFIG_FILE=/tmp/babel-o-p1-runtime-llm-pipeline-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime-llm.test.ts --test-name-pattern "LLMCodingRuntime|respond-only|tool|context|Session Memory Lite"`：46/46 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 无输出。

## 2026-06-02 — Runtime diagnostics object

- **用户决策**: 根据建议继续推进 P1，优先把 context/provider 诊断统一成可复用对象，供 CLI、API 和 benchmark 共享。
- **处理**:
  - 新增 `src/runtime/runtimeDiagnostics.ts`，定义 `RuntimeDiagnosticsEnvelope`、signals、action 和 shared status helper。
  - `src/runtime/contextAnalysis.ts` 在保留既有 `diagnostics` 的同时新增 `diagnostic` envelope，统一暴露 context status、summary、signals、recommendations 和核心 details。
  - `src/runtime/providerSmoke.ts`、`src/runtime/providerRecovery.ts` 和 `src/nexus/agentLoopSmoke.ts` 为 dry/live smoke、fallback plan、AgentLoop live smoke 增加统一 `diagnostic`，并保持 `allowSilentModelSwitch: false` 与非执行 fallback action。
  - `src/nexus/app.ts` 的 fallback plan API 显式传递 `recoveryKind`，避免 `rate_limit` 与 `provider_unavailable` 因同属 `retry_same_model` policy 而在诊断里混淆。
  - CLI `/smoke`、`/fallback` 和 `bbl optimize --provider-smoke-live` formatter 展示统一 `status · summary` 诊断行。
  - `test/context-assembler.test.ts`、`test/provider-recovery.test.ts`、`test/runtime.test.ts` 和 `test/optimize-command.test.ts` 覆盖 context/provider/AgentLoop diagnostic envelope、API passthrough、formatter 与 `rate_limit` kind 保真。
  - `TODO_runtime.md` / `DONE.md` 已同步：P1 统一 diagnostics object 当前收口。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `env BABEL_O_CONFIG_FILE=/tmp/babel-o-p1-provider-recovery-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/provider-recovery.test.ts`：7/7 通过。
  - `env BABEL_O_CONFIG_FILE=/tmp/babel-o-p1-context-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/context-assembler.test.ts --test-name-pattern "analyzeContext returns token"`：44/44 通过。
  - `env BABEL_O_CONFIG_FILE=/tmp/babel-o-p1-runtime-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts --test-name-pattern "/v1/runtime/(status|provider-smoke|provider-fallback/plan)|/v1/sessions/:sessionId/context"`：54/54 通过。
  - `env BABEL_O_CONFIG_FILE=/tmp/babel-o-p1-optimize-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/optimize-command.test.ts --test-name-pattern "formatAgentLoopSmokeResult"`：7/7 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 无输出。

## 2026-06-02 — Session Memory Lite diagnostics

- **用户决策**: 根据建议继续推进 P1 后续项，优先收口 Session Memory Lite 的成本策略、更新诊断和 CLI/API 可见状态。
- **处理**:
  - `src/runtime/sessionMemoryLite.ts` 新增 `SessionMemoryLiteStatus` 与 extractive-only cost policy，统一暴露 enabled、path、last update、next decision、summary chars、token/tool-call 诊断。
  - `session_memory_updated` 审计事件扩展 decisionReason、estimatedTokensSinceLastUpdate、toolCallCount、summaryMaxChars 和 summaryMode；reactive pause 与 compact/manual 路径都会写入诊断元数据。
  - `src/runtime/contextAnalysis.ts`、CLI `/context` 和 `GET /v1/sessions/:sessionId/context` 接入 Session Memory Lite 状态，展示 last update、next decision 和成本上限。
  - `test/context-assembler.test.ts`、`test/runtime.test.ts` 和 `test/runtime-llm.test.ts` 覆盖 structured diagnostics、CLI formatter、HTTP API passthrough、queued pause update 与 compact audit metadata。
  - `TODO_runtime.md` / `DONE.md` 已同步：该 P1 follow-up 当前收口，后续若要接入真实 summary provider 需另补显式授权与成本回归。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/context-assembler.test.ts --test-name-pattern "Session Memory Lite|analyzeContext returns token|/context display includes matching"`：44/44 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts --test-name-pattern "/v1/sessions/:sessionId/context|/v1/sessions/:sessionId/compact"`：54/54 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime-llm.test.ts --test-name-pattern "Session Memory Lite"`：46/46 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 无输出。

## 2026-06-02 — Compact post-restore follow-ups

- **用户决策**: 根据建议继续推进 P1 Compact Post-Restore。
- **处理**:
  - `src/runtime/compactPostRestore.ts` 扩展 `PostCompactState`，从现有 `tool_started` / `tool_completed` / `tool_denied` / `task_created` / `task_session_event` / `hook_completed` 事件推导 MCP tool audit、tool contract reminders、tool failure summary、skill reminders、agent status 和 sub-task status。
  - MCP audit 使用 `mcp:*` tool name 约定，不新增 Nexus event schema；workspace escape 等失败工具结果会进入 post-restore failure summary，供 compact 后恢复参考。
  - `buildCompactCapabilityReminder()` 重新宣布 active skills、MCP audit、agent/sub-task summary 和工具契约，保留 tool_use/tool_result pairing 底线。
  - `test/context-assembler.test.ts` 扩展 post-restore 模块和 assembleContext 集成回归，覆盖 compact 后最新任务、workspace escape 后恢复、cancel boundary 后恢复、provider empty response 后恢复。
  - `TODO_runtime.md` / `DONE.md` 已同步：compact post-restore follow-up 当前收口，后续只在真实恢复漂移出现时补最小回归。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/context-assembler.test.ts --test-name-pattern "post-restore|post-compact|recovery fixtures"`：44/44 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 无输出。

## 2026-06-02 — Compact post-restore restored contents budget

- **用户决策**: 根据建议继续推进 P1；优先做 Compact Post-Restore restored file contents 总预算。
- **处理**:
  - `src/runtime/compactPostRestore.ts` 新增 `MAX_RESTORED_FILES`、`MAX_RESTORED_FILE_CHARS` 和 `MAX_RESTORED_TOTAL_CHARS`，恢复 Read 内容时同时受单文件与总 char budget 约束。
  - `PostCompactState.restoredFileContents` 扩展 `truncated` / `originalChars` 元数据；`formatPostCompactState()` 对预算截断内容输出简短 truncation marker。
  - `test/context-assembler.test.ts` 新增 post-restore 总预算回归，验证 restored contents 总量不会超过 12K chars，且截断提示会进入 formatted post-compact state。
  - `TODO_runtime.md` / `DONE.md` 已同步：restored file contents 总预算完成，MCP tools audit、tool contract reminder、skill delta 和 agent/sub-task 状态摘要仍保留待办。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/context-assembler.test.ts --test-name-pattern "post-restore|post-compact state"`：37/37 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 无输出。

## 2026-06-02 — Session Memory Lite background queue

- **用户决策**: 根据建议继续推进 P1；优先做 Session Memory Lite 后台化。
- **处理**:
  - `src/runtime/sessionMemoryLite.ts` 新增顺序后台队列、`queueSessionMemoryLiteUpdate()`、`flushSessionMemoryLiteQueue()` 和 `shouldUpdateSessionMemoryLite()`。
  - 触发策略覆盖最后轮无工具调用的自然停顿，以及自上次 memory update 后 token estimate ≥ 30K 且 tool calls ≥ 15 的增长阈值；同一用户轮已有 `session_memory_updated` 时跳过重复更新。
  - 后台更新复用 `summarizeSessionEvents()`，只写 `.babel-o/session-memory.md`，失败仅 debug logging，不阻塞当前 runtime result。
  - `LLMCodingRuntime` 在无工具 final response 成功路径排队 reactive pause update；compact 同步写入路径保持兼容。
  - `test/context-assembler.test.ts` 覆盖后台队列自然停顿写入和重复排队去重；`test/runtime-llm.test.ts` 覆盖 runtime 无工具 final response 后后台写入与审计事件追加。
  - `TODO_runtime.md` / `DONE.md` 已同步：后台化最小切片完成，后台 summary model 降级/成本上限、更细诊断和 CLI/API 可见状态保留待办。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/context-assembler.test.ts --test-name-pattern "Session Memory Lite"`：36/36 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime-llm.test.ts --test-name-pattern "Session Memory Lite"`：46/46 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 无输出。

## 2026-06-02 — Retained segment and resume diagnostics

- **用户决策**: 根据建议继续推进 P1 retained segment / resume 用户可见诊断。
- **处理**:
  - `src/runtime/contextAnalysis.ts` 的 structured `diagnostics` 新增 `compactRetention` 与 `resumeRecovery`，分别暴露 compact boundary、retained event count、retained segment valid/warning/fallback，以及 recovery boundary code/timestamp/message。
  - diagnostics signals 新增 `retained_segment_fallback` 与 `resume_recovery_boundary`；recommendations 新增 retained fallback 和 recovery boundary 的用户动作建议。
  - CLI `/context` Diagnostics 区块显示 retained segment valid/fallback、retained event count、warning，以及 resume recovery boundary 状态。
  - `test/context-assembler.test.ts` 扩展 retained segment mismatch 与 recovery boundary 回归，验证 diagnostics、signals 和 recommendations 均用户可见。
  - `TODO_runtime.md` / `DONE.md` 已同步：基础用户可见诊断完成，后续保留各类 retained metadata 异常 fixture 和 CLI embedded / HTTP Nexus 展示一致性回归。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/context-assembler.test.ts --test-name-pattern "analyzeContext|retained segment|recovery boundary|auto compact preserves"`：35/35 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 无输出。

## 2026-06-02 — `/context` diagnostics enhancement

- **用户决策**: 根据建议继续推进 P1 `/context` 诊断增强。
- **处理**:
  - `src/runtime/contextAnalysis.ts` 新增 structured `diagnostics`：context remaining/compact headroom/blocking headroom、usage input/output/cache/reasoning、auto compact decision/fuse、project memory pressure、large tool results、repeated tool inputs、microcompact savings signals。
  - `buildContextRecommendations()` 使用 diagnostics 生成更具体建议：大工具结果、重复工具输入、memory pressure、auto compact fuse 和 compact boundary。
  - CLI `/context` 展示新增 Diagnostics、Signals、Recommendations 区块，显示 usage、remaining、microcompact savings、largest tool result、repeated tool input 和 memory pressure。
  - `test/context-assembler.test.ts` 扩展 `analyzeContext()` 回归；`test/runtime.test.ts` 扩展 HTTP `/v1/sessions/:sessionId/context` diagnostics 透传断言。
  - `TODO_runtime.md` / `DONE.md` 已同步：基础 diagnostics 增强完成，working set 路径、compact 前后 token delta 和更多边界展示一致性回归仍保留待办。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/context-assembler.test.ts --test-name-pattern "analyzeContext|context diagnostics"`：35/35 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts --test-name-pattern "/v1/sessions/:sessionId/context"`：54/54 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 无输出。

## 2026-06-02 — Compact post-restore extraction

- **用户决策**: 根据建议继续推进 P1 Runtime Context / Compact；在 Microcompact 后优先抽离 Compact Post-Restore。
- **处理**:
  - 新增 `src/runtime/compactPostRestore.ts`，承载 `PostCompactState`、`derivePostCompactState()`、`formatPostCompactState()` 和 `buildCompactCapabilityReminder()`。
  - `contextAssembler.ts` 改为导入该模块并保留兼容重导出，`assembleContext()` 行为不变。
  - `test/context-assembler.test.ts` 新增 post-restore 模块直接回归，覆盖最近 Read 文件、active tools、active skills、task status、hook activity、restored file contents 和 compact capability reminder；保留 assembleContext post-compact 集成回归。
  - `TODO_runtime.md` / `DONE.md` 已同步：抽离项完成，MCP tools audit、agent/sub-task 摘要、restored file contents 总预算和更多恢复场景回归仍保留待办。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/context-assembler.test.ts --test-name-pattern "post-compact|Post-Compact|compact boundary|analyzeContext"`：35/35 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 无输出。

## 2026-06-02 — Microcompact extraction and metrics

- **用户决策**: 根据建议继续推进 P1 Runtime Context / Compact；优先收口 Microcompact 机制抽离与增强。
- **处理**:
  - 新增 `src/runtime/compactors/microCompact.ts`，`contextAssembler.ts` 保留 `microcompactEvents()` 兼容导出并改用 `microcompactEventsWithMetrics()`。
  - Microcompact 支持按 `(tool_name, normalized input)` 识别重复工具结果：旧结果替换为摘要，最新结果保留完整输出；只替换 `tool_completed.output`，不改变 `tool_started` / `tool_completed` 顺序或 `toolUseId` 配对。
  - `assembleContext()` 与 `analyzeContext()` 新增 microcompact metrics：deduplicated tool result count、bytes saved、estimated tokens saved。
  - `test/context-assembler.test.ts` 扩展重复工具输出清理、tool pair/event order、源事件非原地修改、最新结果 identity 稳定和 `/context` 诊断字段回归。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/context-assembler.test.ts --test-name-pattern "microcompact|context_analysis"`：34/34 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 无输出。

## 2026-06-02 — Compact recovery regression hardening

- **用户决策**: 根据建议继续推进 P1 Runtime Context / Compact；优先补 compact 成功恢复、compact 失败熔断、service/embedded 一致性回归，不重构 compact 主流程。
- **处理**:
  - `test/runtime.test.ts` 新增成功 compact boundary 后 `LLMCodingRuntime` 可继续 provider 路径的回归，使用隔离 `ConfigManager` 与本地 provider adapter，避免真实 provider 与真实配置污染。
  - 新增 auto compact failure fuse 回归：已有连续 auto `compact_failure` 时 runtime 只提示 fuse open，不再重复发起 auto compact；若上下文仍超 blocking limit，则发出 `context_blocking` / `CONTEXT_LIMIT_EXCEEDED` 并阻止 provider 请求。
  - 新增 WebSocket stream 回归：`/v1/stream` 会透传并持久化 `context_blocking` 与对应 error，补齐 HTTP `/v1/execute` envelope 之外的 service 路径一致性。
  - `TODO_runtime.md` / `DONE.md` 已同步：compact 成功恢复、失败熔断、service/embedded 一致性回归移出待办，Compact 完整化后续仍保留 microcompact 抽离、post-restore 抽离和 `/context` 诊断增强。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts --test-name-pattern "successful compact boundary|failure fuse|compacted context still exceeds|context blocking.*(envelope|ws)|websocket stream relays"`：54/54 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 无输出。

## 2026-06-02 — Context blocking hard-block diagnostics

- **用户决策**: 继续根据建议推进 P1 Runtime Context；在 conservative token estimator 后优先收口 Context Blocking Limit 的 UX/API 诊断，不重复实现硬拦截。
- **处理**:
  - 保留既有 `context_warning` 兼容事件，新增 `context_blocking` 结构化事件，包含 tokenEstimate、maxTokens、warning/compact/blocking thresholds、`httpStatus=413` 与恢复动作列表。
  - `LLMCodingRuntime` 两条 provider-call-before blocking 分支在阻断 provider 请求前同时发出 `context_blocking`，并让 `CONTEXT_LIMIT_EXCEEDED` error details 携带 `recoveryReason=CONTEXT_BLOCKING_LIMIT`、413 语义、token 阈值和 fallback policy。
  - `/v1/execute` 保持 HTTP 200 result envelope 兼容，但新增 `statusCode=413` 和 `error` 字段，API 客户端可区分 runtime warning 与 hard block。
  - CLI live render 与 history render 新增 hard-block action 提示：`/compact`、`/context`、切换大上下文模型或降低工具输出。
  - `TODO_runtime.md` / `DONE.md` 已同步：hard-block 结构化诊断移出待办，后续只保留 compact 成功恢复、compact 失败熔断和 service/embedded 一致性回归。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts --test-name-pattern "context blocking|compacted context still exceeds limit"` 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/tui-renderer.test.ts`：29/29 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。

## 2026-06-02 — Context token estimator conservative mode

- **用户决策**: 根据建议推进 P1 Runtime Context；优先补 Token Estimator conservative mode，而不是先推进 Working Set / Prefix Cache。
- **处理**:
  - `estimateContextTokens()` 新增 `conservative` / `conservativeBufferPercent` 选项，默认 conservative buffer 为 25%，并通过 `estimateTokensConservative()` 限定在 20-30% provider 偏差 buffer。
  - conservative 估算保留原 component token 明细，并额外返回 `baseTotalTokens` 与 `conservativeBufferPercent`；未开启 conservative 时保持原 `totalTokens = systemPromptTokens + messageTokens + toolDefinitionTokens` 兼容语义。
  - `LLMCodingRuntime` 的 provider-call-before warning / auto compact / reactive compact / blocking guard 改用 conservative 估算；`analyzeContext()` API 同步展示 conservative window。
  - `test/token-estimator.test.ts` 新增 bounded buffer 不变量，以及中文长上下文、长 tool_result、DeepSeek reasoning replay、provider tool schema overhead 的混合样本回归。
  - `TODO_runtime.md` / `DONE.md` 已同步：conservative mode 移出待办，后续只保留更大 provider 偏差 fixture 校准。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/token-estimator.test.ts`：5/5 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 无输出。

## 2026-06-01 — AgentLoop benchmark cost schema v2

- **用户决策**: 根据建议继续推进 P2；在 structured output repair 之后，优先深化 mocked AgentLoop 成本与失败率 benchmark，不消耗真实 provider quota。
- **处理**:
  - `runMockAgentLoopBenchmark()` 的 agent loop benchmark schema 升级到 v2，保留 critic retry success、sub-agent delegation success、executor failure limit 三个固定 mocked 场景。
  - benchmark stepRunner wrapper 记录每个 role call 的估算 input/output token、duration 与 role 维度聚合；token 估算复用 runtime `estimateTextTokens()`。
  - 新增 `cost.retryOverhead`：`attempts` 对齐 queue retryCount，token/duration 只统计同一 root task 的额外执行轮次，避免把 sub-agent delegation 的父任务续跑误算为 retry 成本。
  - 新增 `cost.subAgent`：输出 sub-agent session 数、sub-agent roleCalls、token 与 duration；总计中聚合所有 scenario 的 role cost、retry overhead 与 sub-agent cost。
  - `TODO.md` / `TODO_performance.md` / `DONE.md` 已同步：mocked AgentLoop cost benchmark 深化移出总控优先级，provider retry policy benchmark、规模压测与故障注入仍保留未收口。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/agent-loop-benchmark.test.ts`：1/1 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run benchmark` 通过，输出 `agentLoop.schemaVersion=2`，totals cost 包含 `totalTokens=1307`、`retryOverhead.attempts=3`、`subAgent.sessionCount=2`。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 无输出。

## 2026-06-01 — AgentLoop structured output repair

- **用户决策**: 根据建议继续推进 P2 AgentLoop structured output repair；不推进自动模型选择，继续保持 provider/model fallback 非静默。
- **处理**:
  - `tryParseWithRepair()` 改为返回 `{ output, repairAttempts }`，成功修复后把 repair attempt 数传回 role diagnostics / usage summary。
  - Planner 空 JSON / 空计划 fallback 在 runtime step 层不再直接接受，先触发一次同模型 repair，要求返回更小的 `summary` + 1-3 个具体 task；直接 parser fallback 兼容性保持不变。
  - Executor/Optimizer repair prompt 带上上一轮 raw invalid output（assistant text、result payload、structured output preview），要求以 `taskId/success/result` 结构保留已完成工作摘要。
  - Critic repair 失败后不再抛出导致不确定状态，而是返回 conservative reject：`approved=false`、`reason=needs-human-review: structured output ...`。
  - 修复 repair 重试轮次未记录到 TaskSession events、以及只看 `assistant_delta` 不看 `result.message` 的解析缺口。
  - `TODO.md` / `TODO_agents.md` / `DONE.md` 已同步：structured output repair 移出待办，Agents 后续优先级回到 benchmark 深化与 Git hardening。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/agent-loop.test.ts --test-name-pattern "structured output|repair|critic"`：29/29 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 无输出。

## 2026-06-01 — Failed sub-agent rerun UX

- **用户决策**: 继续推进失败子 Agent 重新执行 UX；需要保留旧 child transcript，并提供 operator/API/CLI 可控重跑入口，避免静默自动重跑。
- **处理**:
  - AgentLoop 的 sub-agent session id 改为 retry-aware：首次为 `<parent>-sub-<taskId>`，父级 task retry 后为 `<parent>-sub-<taskId>-retry-<retryCount>`；sub-agent lifecycle metadata 与 transcriptPath 指向对应 child session。
  - 失败或取消的 sub-agent reference 会保存在父 task metadata 的 `previousSubAgents`，新的成功/失败 sub-agent reference 继续写入 `metadata.subAgent`，避免旧 transcript 被覆盖。
  - 新增 `POST /v1/sessions/:sessionId/tasks/:taskId/rerun-subagent`，只接受带 failed/cancelled sub-agent metadata 的 task；成功后把 task 恢复为 pending、递增 retryCount、写入 `subAgentRerun` 审计 metadata，并恢复因该子任务失败而失败的 dependent task 到 blocked。
  - `NexusClient.rerunSubAgentTask()` 与 `bbl sessions rerun-subagent <sessionId> <taskId>` 接入同一入口，CLI 写入 actor/source/reason 审计。
  - `TODO.md` / `TODO_agents.md` / `DONE.md` 已同步：失败子 Agent rerun UX 移出待办，Agents 主线回到真实回归守门与 structured output repair。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/agent-loop.test.ts --test-name-pattern "sub-agent.*rerun|runs sub-agent"`：26/26 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts --test-name-pattern "SDK task mutation API"`：50/50 通过。

## 2026-06-01 — Worktree conflict recovery UX

- **用户决策**: 根据建议继续推进当前 P1，优先补 isolated worktree merge-back/cherry-pick 冲突的人工恢复 UX。
- **处理**:
  - `commitAndMergeWorktree()` 的 cherry-pick 冲突从字符串错误升级为 `WorktreeMergeConflictError`，携带结构化 `worktree_merge_conflict` diagnostic：冲突文件、父/子 commit、失败 commit、父 workspace、isolated worktree 路径、git 输出与恢复动作。
  - AgentLoop 在 isolated worktree merge 冲突时不再自动删除现场；任务标记 failed，session 进入 `waiting_user`，`pendingInput`、`worktree_merge_conflict` 事件和 task metadata 中写入恢复诊断。
  - 新增 `POST /v1/sessions/:sessionId/tasks/:taskId/worktree-recovery`，支持 `keep`、`continue`、`abandon`：`keep` 只审计保留现场，`continue` 删除保留 worktree 并把任务恢复为 pending，`abandon` 删除保留 worktree 并记录放弃。
  - `NexusClient` 与 `bbl sessions worktree-recovery <sessionId> <taskId> <continue|abandon|keep>` 接入同一恢复动作；删除 worktree 前校验路径必须位于 session cwd 的 `.babel-o/worktrees/` 下。
  - `TODO.md` / `TODO_agents.md` / `DONE.md` 已同步：Worktree 冲突恢复 UX 移出待办，Agents 后续优先级收窄到失败子 Agent 重新执行 UX。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/worktree.test.ts --test-name-pattern "conflicting files"`：7/7 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/agent-loop.test.ts --test-name-pattern "worktree|requiresIsolation"`：25/25 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts --test-name-pattern "SDK task mutation API"`：50/50 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run cli -- sessions worktree-recovery --help` 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 无输出。

## 2026-06-01 — Child sub-agent transcript query and retry entry

- **用户决策**: 根据 TODO 综合评估推进 P0-P1；P0 继续只做真实会话 regression 守门，P1 先补子 Agent transcript 查询与恢复 UX，并修正 Agents TODO 中仍指向自动模型选择的旧口径。
- **处理**:
  - 新增父 session 作用域的 child session 查询：`GET /v1/sessions/:sessionId/children`，返回 child session 摘要、`transcriptPath` 与可选 recent event preview。
  - 新增 child transcript 详情查询：`GET /v1/sessions/:sessionId/children/:childSessionId/events`，校验 child 必须属于 parent，避免跨 session 任意读取。
  - `NexusClient` 与 `bbl sessions` 新增 `children`、`child-events`、`retry-task` 子命令；`retry-task` 复用现有 task retry mutation，将失败任务恢复为 pending 并写入 actor/source/reason 审计，实际重新执行仍由 operator 或后续 AgentLoop 恢复入口触发。
  - 修正 `TODO_agents.md` 口径：自动模型选择、默认 role model 推荐与显式 fallback 执行入口已无限期 delay；Agents 主线优先 child transcript/retry UX 与 worktree 冲突恢复 UX。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts --test-name-pattern "session assets|SDK task mutation API"`：50/50 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run cli -- sessions --help` 通过，确认新增 CLI 子命令已注册。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。

## 2026-06-01 — Auto model selection indefinitely delayed

- **用户决策**: 暂时不推进自动选择模型；Provider role defaults、默认 role model 推荐与显式 fallback 执行入口无限期 delay，需要时再恢复。
- **处理**:
  - 总控优先级移除 Provider role defaults / fallback execution，将当前 P1 调整为子 Agent transcript 查询与恢复 UX、Worktree 冲突人工恢复 UX。
  - `TODO_provider_registry.md` 新增 `Delayed Indefinitely` 小节，保留安全底线：不得静默切换模型/provider/profile，`allowSilentModelSwitch=false`。
  - `models inspect` 后续只保留静态 capability table / auth mode / adapter 等细节补齐，不输出自动 role model 推荐。
- **验证**:
  - 文档-only 更新；未改运行时代码。

## 2026-06-01 — MiniMax real provider AgentLoop smoke passed

- **用户决策**: 授权继续使用当前本地已配置真实 provider，开发推进优先于 provider quota 最小化；固定 smoke 仍限定临时 workspace、固定 fixture、Read-only 工具，不执行任意用户任务。
- **处理**:
  - 定位 MiniMax-M3 超时根因：role output JSON Schema 在 Zod v4 下被旧转换逻辑退化为近似 `{ "type": "object" }`，导致 Planner/Optimizer 角色输出不稳定。
  - `zodRoleOutputSchemaToJsonSchema()` 改用 Zod v4 `z.toJSONSchema()`，并补回归确保 Planner/Executor/Critic schema 暴露 required fields。
  - AgentLoop role step 继续关闭 session history replay，并通过 `maxOutputTokens` 限制结构化 role 输出预算。
  - MiniMax/Anthropic-compatible stream 结束处理保留：等待 content block close、flush MiniMax text tool parser 后再输出 finish，避免 hanging stream 或 text/finish 顺序错误。
  - 固定 live smoke 的非 git 临时 workspace 不再触发 optimizer stash/commit/rollback bookkeeping；正常 git workspace 的 worktree/rollback 路径保持原语义。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/Users/tangyaoyue/.babel-o/config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run cli -- optimize --provider-smoke-live --model minimax/MiniMax-M3 --timeout-ms 120000` 通过两次：readiness `auth/model/tools/streaming/structured=yes`，session phase `completed`，Planner 与 Optimizer 成功，Read tool 调用 1 次，fixture marker 为 `BABEL_O_AGENT_LOOP_SMOKE_OK`，workspace `created=yes cleaned=yes`，fallback `retry_same_model silentSwitch=false`。
  - 第二次重跑确认非 git 临时 workspace 已无 `Git commit failed` warning。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/agent-loop.test.ts`：24/24 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。

## 2026-06-01 — MiniMax real provider smoke timeout and git ENOENT hardening

- **用户决策**: 授权使用当前本地已配置真实 provider 运行一次固定 AgentLoop live/manual smoke；限定 MiniMax-M3、固定临时 workspace、固定 fixture、Read-only 工具，不执行任意用户任务。
- **处理**:
  - 执行 `bbl optimize --provider-smoke-live --model minimax/MiniMax-M3 --timeout-ms 120000`。
  - provider readiness 检查通过：`auth=yes model=yes tools=yes streaming=yes structured=yes`；实际 live smoke 未成功，session phase 为 `unknown`，task 与 critic 均未完成。
  - 本次只观测到 Planner 路径：`planner:events=61,tools=1`，role diagnostics 为 `planner{model=minimax/MiniMax-M3,tools=Read,repair=0}`。
  - 失败归类为 `agent_loop_timeout`：120000ms 超时，fallback 为 `fix_configuration silentSwitch=false`；临时 workspace 显示 `created=yes cleaned=yes`。
  - 超时后的清理路径暴露本地 `spawn git ENOENT` 未处理错误；`git restore --staged --worktree .` 在 PATH 中找不到 git 时会触发 child process `error` 并崩溃。
  - 新增 `runGitCommand` 缺失 git 回归，并修复 child process `error` 处理，让调用返回非零 code 与诊断 stderr，而不是触发未处理异常。
- **验证**:
  - MiniMax real provider smoke 已执行但未通过；未自动重跑真实 provider，后续再次消耗 provider quota 需要新的显式授权。
  - 用户再次授权继续真实 provider 后重跑同一固定 smoke：readiness 仍通过，`session_31c44785-a0f5-4390-b443-68f85e024dbc` 仍 120000ms 超时；本次推进到 Planner 与 Optimizer，usage 为 `planner:events=14,tools=1 | optimizer:events=17,tools=1`，Task/Critic 仍未完成。
  - 重跑中 `spawn git ENOENT` 已按预期降级为 `Git commit failed` warning，不再触发未处理 child process error。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/worktree.test.ts`：7/7 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/agent-loop.test.ts /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/optimize-command.test.ts`：28/28 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。

## 2026-06-01 — AgentLoop live smoke timeout cancellation regression

- **用户决策**: 根据建议继续推进；不继续盲目消耗真实 provider quota，先把 MiniMax 两次 120s 超时转为 deterministic regression，并定位 Planner/Optimizer 后不进入 Critic 的边界。
- **处理**:
  - `createRuntimeAgentStepRunner()` 新增 `AbortSignal` 透传，Planner/Optimizer/Critic role runtime 调用和 structured-output repair retry 都会收到同一个 timeout signal。
  - `runAgentLoopLiveSmoke()` 的 timeout 从单纯 `Promise.race` 改为先 abort provider/runtime，再等待 AgentLoop 收尾并读取 partial session events。
  - live smoke 失败结果现在保留 `sessionPhase`、tool count、Planner/Task/Critic 完成状态和 role diagnostics；timeout 明确标记为 `agent_loop_timeout`。
  - CLI smoke 输出新增 `Failure type:` 行，真实 provider smoke 超时时可直接看到分类。
  - 新增 mocked provider regression：Planner 完成后 Optimizer provider request 挂起，timeout 触发 abort，验证 provider fetch 收到 abort、Planner partial progress 被记录、Task/Critic 未完成，且不泄露 API key。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/agent-loop.test.ts /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/optimize-command.test.ts`：29/29 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。

## 2026-06-01 — Optimizer role timeout diagnostics

- **用户决策**: 根据建议继续推进；在不重跑真实 provider 的前提下，先增强 Optimizer role 后不收敛的定位信息。
- **处理**:
  - `RuntimeAgentStepUsageSummary` 的 result/error/last-tool 字段接入 live smoke role diagnostics。
  - role diagnostics 新增 `resultMessagePreview`、`errorCode`、`errorMessagePreview`、`lastToolName`、`lastToolSuccess`、`lastToolOutputPreview`、`structuredOutputPreview`。
  - runtime role step 在 provider/runtime 抛错或 abort 时也会记录 usage summary，使 timeout 场景能看到 Optimizer 的 `REQUEST_TIMEOUT` 与 abort message。
  - `bbl optimize --provider-smoke-live` 的 `Role diagnostics:` 行现在输出 role-level success/error、last tool、structured failure 与短 preview，方便下次真实 provider smoke 直接定位卡点。
  - 新增 CLI formatter regression，覆盖 `Failure type: agent_loop_timeout`、Optimizer `error=REQUEST_TIMEOUT`、`lastTool=Read:yes` 和 tool output preview。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/agent-loop.test.ts /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/optimize-command.test.ts`：30/30 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。

## 2026-06-01 — TUI renderer build artifact refresh

- **用户反馈**: 实际 `bbl chat` 仍显示旧式 `● ✓ Bash ... done <summary>`、`✓ Permission approved` 和 done 后输出摘要，说明源码改动没有进入当前运行入口。
- **处理**:
  - 确认 `/opt/homebrew/bin/bbl` symlink 到当前 repo，但 `bin/bbl.js` 在存在 `dist/cli/program.js` 时优先运行 dist，因此必须 rebuild。
  - 执行 `npm run build` 刷新 `dist/cli/renderEvents.js`，使全局 `bbl` 入口加载新 compact renderer。
  - 执行 `npm run build:binary` 刷新 `dist/bbl-bundled.mjs` 与 standalone `dist/bbl`，避免旧 binary/bundle 继续显示旧格式。
  - 用 `/opt/homebrew/bin/bbl chat` 做真实 PTY 验证，确认输出为 `● Bash(...)` + `⎿` 折叠预览，不再出现 `✓ Permission approved`、`✓ done`、`● ✓ Bash ... done ...`。
- **验证**:
  - `/opt/homebrew/bin/bbl chat` 真实 PTY smoke 通过：Bash 长输出折叠为 `⎿ line-0..line-2` + `… +2 lines (ctrl+o to expand)`。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run test:tui:pty`：15/15 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 通过。

## 2026-06-01 — TUI compact Bash output preview folding

- **用户决策**: Bash 工具 compact 输出仍然容易刷屏；默认应聚合成少量输出预览，类似 `⎿ … +18 lines (ctrl+o to expand)`，完整内容仍通过 Ctrl+O 查看。
- **处理**:
  - Bash 成功/失败完成态 compact 行继续保留 `● Bash(command)`，下方最多展示 3 行 stdout/stderr 预览。
  - 超出预览的输出折叠成 `… +N lines (ctrl+o to expand)`；非默认 timeout 显示 `(timeout 2m)` 这类摘要。
  - Read/Edit/Grep/Glob/TaskCreate 等工具保持纯 `● Tool(args)`，不内联输出。
  - 新增 renderer regression 和真实 PTY smoke 覆盖 Bash 长输出折叠。
- **验证**:
  - `/Users/tangyaoyue/DEV/BABEL/BabeL-O/node_modules/.bin/tsx --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/tui-renderer.test.ts`：25/25 通过。
  - `BABEL_O_RUN_PTY_SMOKE=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/node_modules/.bin/tsx --test --test-name-pattern "compact bash output preview" /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/tui-pty-smoke.test.ts`：1/1 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run test:tui:pty`：15/15 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 通过。

## 2026-06-01 — TUI compact tool rows final simplification

- **用户决策**: compact 工具消息仍然冗杂，参考 `● Read(path)` / `● Search(pattern in path)` 形式，默认工具行只保留 tool call 本身。
- **处理**:
  - compact/live/history 成功态工具行从 `● Tool(args) (ctrl+o to expand)` 收敛为 `● Tool(args)`；失败态和截断态仍保留 `failed` / `truncated`。
  - compact 模式不再输出成功审批行 `✓ Permission approved`，拒绝仍显示 `Permission denied`。
  - compact 模式不再输出成功 result 行 `✓ done`，失败仍显示 `✗ failed`；普通文本 prompt smoke 改用 assistant 正文作为完成信号。
  - PTY smoke 改为等待工具完成后的 assistant 摘要或业务输出，避免 compact 行去掉 expand hint 后误匹配运行中工具行。
- **验证**:
  - `/Users/tangyaoyue/DEV/BABEL/BabeL-O/node_modules/.bin/tsx --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/tui-renderer.test.ts`：24/24 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run test:tui:pty`：14/14 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 通过。

## 2026-06-01 — TUI Ctrl+O expanded tool details cleanup

- **用户决策**: Ctrl+O 展开视图当前太乱，会重复显示 permission/usage 事件，并把 Bash 对象输出显示成 `[object Object]`，需要整理成可读的工具详情页。
- **处理**:
  - expanded history 不再逐条打印 `usage`、独立 `permission_request`、独立 `permission_response`，避免 `usage input=0 output=...` 和重复审批块污染详情视图。
  - permission request/response 聚合进对应工具详情，显示为 `Permission: approved/denied (risk): reason`。
  - 工具详情统一分区为 header、Input、Permission、Status、Diff、Output；compact 仍保持 `Tool(args) (ctrl+o to expand)`。
  - `Output` 使用 `formatOutput()` 直接处理对象，修复 Bash object 输出被 `String(output)` 转成 `[object Object]`。
  - 新增 renderer regression 覆盖对象输出、permission 聚合和 usage 隐藏。
- **验证**:
  - `/Users/tangyaoyue/DEV/BABEL/BabeL-O/node_modules/.bin/tsx --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/tui-renderer.test.ts`：24/24 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run test:tui:pty`：14/14 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 通过。

## 2026-06-01 — TUI compact tool event rendering polish

- **用户决策**: 当前 `bbl chat` 工具事件太冗长，参考 Claude Code 风格改为更简洁的“说明文本 + 单行 tool call + Ctrl+O 展开详情”。
- **处理**:
  - compact/live/history 工具行从 `● ✓ Tool args done <output summary>` 改为 `● Tool(args) (ctrl+o to expand)`；失败态保留 `failed`，截断态保留 `truncated`。
  - 移除 compact history 末尾全局 `ctrl+o to expand tool details` 提示，避免每轮工具后额外占一行。
  - `formatToolCallName()` 统一使用函数调用式 `Tool(arg)`，`TaskCreate` 显示 title，`Grep/Glob` 优先显示 pattern 而非默认 path `.`。
  - compact 模式不再内联 Bash stdout/exitCode 等输出摘要；详细 input/output/diff 仍通过 Ctrl+O expanded 模式查看。
  - 更新 renderer 单测和 PTY smoke 断言，真实终端等待完成态 `(... ctrl+o to expand)`，避免误匹配运行中工具行。
- **验证**:
  - `/Users/tangyaoyue/DEV/BABEL/BabeL-O/node_modules/.bin/tsx --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/tui-renderer.test.ts`：23/23 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run test:tui:pty`：14/14 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 通过。

## 2026-06-01 — P2 AgentLoop mocked cost/failure benchmark

- **用户决策**: 继续推进；在不运行真实 provider 的前提下，先收口 AgentLoop 成本与失败率 benchmark 的 mocked 基线。
- **处理**:
  - 新增 `runMockAgentLoopBenchmark()`，运行固定 mocked AgentLoop 场景：critic retry success、sub-agent delegation success、executor failure limit。
  - benchmark 输出 `agent_loop_benchmark` JSON，包含每个场景的 duration、event/task count、completed/failed task count、retryCount、subAgentSessionCount、Planner/Executor/Optimizer/Critic 调用次数和 failureTypes。
  - `npm run benchmark` 的 JSON 输出新增 `agentLoop` 段，和现有 API/context/compact/tokenEstimator/runtime metrics 同步输出。
  - 新增 `test/agent-loop-benchmark.test.ts` 并纳入 `npm test`，验证 mocked benchmark 不触发 live provider 且汇总 role calls / failureTypes 正确。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/agent-loop-benchmark.test.ts /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/agent-loop.test.ts /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/optimize-command.test.ts`：29/29 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run benchmark` 通过，并输出 `agentLoop.totals.roleCalls` 与 `agentLoop.totals.failureTypes`。

## 2026-06-01 — P1 SDK/dashboard task mutation session smoke

- **用户决策**: 根据建议继续推进 P1；在 task mutation 核心生命周期收口后，扩展 SDK/dashboard 写操作 smoke 到 active/terminal session 与 worktree task。
- **处理**:
  - `POST /v1/sessions/:sessionId/tasks` 现在先确认 session 存在且非终态；缺失 session 返回 404 `SESSION_NOT_FOUND`，completed/cancelled/failed session 返回 409 `SESSION_NOT_MUTABLE`。
  - `PATCH /v1/sessions/:sessionId/tasks/:taskId` 与所有 task action mutation 复用同一 session mutability guard，避免 dashboard 在终态 session 上继续改 task。
  - SDK task mutation smoke 扩展 active session 写入、completed/cancelled session create 拒绝、completed session update/action 拒绝，以及 worktree task claim 后保留 `requiresIsolation` / `worktreePath` metadata。
  - SQLite 持久化测试改为在显式 active session 上创建 task，和新的 terminal session 写保护保持一致。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 --test-name-pattern "SDK task mutation API" /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts` 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts`：50/50 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。

## 2026-06-01 — P1 SDK task approve/reject HITL 边界

- **用户决策**: 根据建议继续推进 P1；在 external cancel 与 fail/retry 生命周期之后，收口外部 approve/reject 不得绕过 Planner HITL / task review 边界。
- **处理**:
  - `POST /v1/sessions/:sessionId/tasks/:taskId/approve` 与 `reject` 增加 pending review 守门：只有已有 `review.status === 'pending'` 的 task 才能变为 approved/rejected。
  - 非 pending review task 现在返回 409 `TASK_REVIEW_NOT_PENDING`，避免 SDK/dashboard 对任意 task 伪造 review 状态。
  - `mutateTaskAction()` 支持异步 mutation 中抛出结构化 HTTP 错误，保留 revision guard、ownerAgentId 合并、metadata requestId 与 mutation audit 语义。
  - `test/runtime.test.ts` 扩展 SDK task mutation smoke，在 MemoryStorage 与 SqliteStorage 两条路径覆盖非 pending review 拒绝、pending review approve/reject 成功，以及 audit previous snapshot 保留 pending review。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 --test-name-pattern "SDK task mutation API" /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts` 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts`：50/50 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。

## 2026-06-01 — P1 SDK task fail/retry 依赖传播

- **用户决策**: 根据建议继续推进 P1；在 external cancel 级联之后，收口外部 fail/retry 与 TaskQueue 依赖传播语义的一致性。
- **处理**:
  - `POST /v1/sessions/:sessionId/tasks/:taskId/fail` 从单纯改 status 扩展为异步 mutation，按 TaskQueue 的 `failedDependencies` 结构把依赖该 task 的 blocked/pending/in-progress task 标记为 `failed`。
  - fail mutation 的 next metadata 记录 `blockedTasksFailed`，dependent task metadata 记录 failedDependencies 快照，result 复用失败依赖摘要。
  - `POST /v1/sessions/:sessionId/tasks/:taskId/retry` 增加 dependent task 恢复：对由该 dependency failure 导致的 failed dependent task，清理 failed dependency metadata/result 并恢复为 `blocked`。
  - `test/runtime.test.ts` 扩展 SDK task mutation smoke，在 MemoryStorage 与 SqliteStorage 两条路径覆盖 fail 传播与 retry 恢复。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 --test-name-pattern "SDK task mutation API" /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts` 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts`：50/50 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。

## 2026-06-01 — P1 SDK task cancel 生命周期集成

- **用户决策**: 继续推进；在不运行真实 provider 的前提下，优先收口外部 SDK task mutation 与 TaskSession 生命周期的交界。
- **处理**:
  - `POST /v1/sessions/:sessionId/tasks/:taskId/cancel` 从单纯改 task status 扩展为异步 mutation。
  - external task cancel 会查找同 session 下匹配 `currentTaskId`、`metadata.parentTaskId` 或 `metadata.taskId` 的 child sessions，并将非终态 child session 标记为 `cancelled`，写入 `TASK_CANCELLED` terminal reason 与 `cancelledByTaskId` metadata。
  - external task cancel 会把依赖被取消 task 的 blocked/pending/in-progress task 标记为 `failed`，写入 `failedDependencyTaskId` 与 `failedDependencyReason` metadata。
  - mutation audit 继续保留 previous/next snapshot；next metadata 中记录 `childSessionsCancelled` 与 `blockedTasksFailed`。
  - `test/runtime.test.ts` 扩展 SDK task mutation smoke，在 MemoryStorage 与 SqliteStorage 两条路径覆盖 child session 级联取消和 failed dependency。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 --test-name-pattern "SDK task mutation API" /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts` 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts`：50/50 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。

## 2026-06-01 — P0 provider config 污染守门

- **用户决策**: 根据建议推进 P0；先处理新会话无法保留 provider 配置的问题，防止测试再次污染真实 `~/.babel-o/config.json`。
- **处理**:
  - 复盘 `session_f275fe79-993b-4a81-9302-4baf6887e278` 与 `session_af6ae9ac-77aa-4d7c-b322-e76f11d378a4`，确认它们均以 `local/coding-runtime` 启动，原因是真实 `~/.babel-o/config.json` 已被写成 `{}`。
  - 定位污染源：`test/runtime.test.ts` 顶层 `ConfigManager.getInstance().save({})` 在未隔离 `BABEL_O_CONFIG_FILE` 时写入默认用户配置。
  - `test/runtime.test.ts` 顶层先设置临时 `BABEL_O_CONFIG_FILE`，让 runtime test 的默认 singleton 写入临时 config。
  - `ConfigManager.save()` 增加中心化测试守门：在 test process 中若目标是默认 `~/.babel-o/config.json`，直接抛出 `BABEL_O_TEST_CONFIG_NOT_ISOLATED`，要求显式临时 config。
  - `test/runtime-llm.test.ts` 新增 regression，验证测试进程误用默认 config path 时拒绝写入。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime-llm.test.ts`：43/43 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts`：50/50 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。

## 2026-06-01 — P1 SDK task mutation 最小写接口

- **用户决策**: 根据建议继续推进 P1；不运行真实 provider，优先收口外部 SDK/dashboard 可用的 task mutation API。
- **处理**:
  - Nexus API 新增/扩展 task mutation：create、update title/description/status/metadata/result、claim、complete、fail、cancel、retry、approve、reject。
  - mutation body 支持 `actor`、`source`、`reason`、`requestId` 与 `expectedUpdatedAt`；create 使用 `requestId` 做幂等返回，update/action 使用 `expectedUpdatedAt` 做 revision guard。
  - 每个 mutation 写入 `task_session_event` 审计，payload 包含 actor、source、reason、requestId、taskId、parentTaskId、previous snapshot 与 next snapshot。
  - `NexusClient` 增加 `createTask()`、`updateTask()` 与 `mutateTask()`，作为外部 SDK/dashboard 写操作的最小封装。
  - 修复 SqliteStorage event 去重键：`task_session_event` 使用 `eventId` 参与索引，避免多个同毫秒 mutation 审计事件因 `INSERT OR IGNORE` 碰撞丢失。
  - `test/runtime.test.ts` 增加 MemoryStorage + SqliteStorage 最小 smoke，覆盖 create 幂等、stale revision conflict、update、complete、retry、reject、cancel 与审计事件。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts`：50/50 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。

## 2026-06-01 — P1 AgentLoop live/manual smoke role diagnostics

- **用户决策**: 继续推进 P1 收口；当前只收口 `bbl optimize --provider-smoke-live` 的可选诊断输出，不实际运行真实 provider，真实 provider 手动执行仍保留为未完成项。
- **处理**:
  - `runAgentLoopLiveSmoke()` 结果新增 `roleDiagnostics`，按 Planner/Optimizer/Critic 汇总 role、model、allowedTools、structuredOutputRequired、repairAttempts、event/tool/failure/denial 计数、resultSuccess 和 structuredOutputFailureType。
  - `bbl optimize --provider-smoke-live` CLI 输出新增 `Role diagnostics:` 行，便于手动真实 smoke 时直接核对 role routing、工具白名单和 repair 次数。
  - mocked live/manual smoke 回归补断言：planner/optimizer/critic 诊断存在，工具面固定为 `Read` / `none`，model 正确，repairAttempts 为 0，且不泄露 API key。
  - `docs/nexus/TODO_agents.md` 移除“给 live/manual smoke 增加可选诊断输出”未完成项；真实 provider 手动执行项仍保留。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/agent-loop.test.ts /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/optimize-command.test.ts`：28/28 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。

## 2026-06-01 — P0 真实会话指令跟随 fallback regression

- **用户决策**: 根据总控 P0 规则继续稳步推进真实会话指令跟随回归守门；遇到短追问/身份类问题时先补最小 regression，再做 runtime fallback 修复。
- **处理**:
  - `test/runtime-llm.test.ts` 新增 intake 模型失败时“你是谁？”的 regression，验证 fallback `user_intake_guidance` 为 `greeting`、`respond_only`、`requiresTools=false`、`source=fallback`，且 provider 请求不带 `tools`。
  - `test/runtime-llm.test.ts` 新增 intake 模型失败时“还记得我刚刚问什么吗？”的 regression，验证 fallback 为 `status`、`respond_only`、`requiresTools=false`、`source=fallback`，且 provider 请求不带 `tools`。
  - `test/runtime-llm.test.ts` 新增直接 fallback 分类单元测试，验证 `deriveFallbackUserIntentGuidance()` 与 `shouldSuppressToolsForIntent()` 对身份/能力短问、上下文记忆短追问均保持 respond-only/no-tools。
  - `src/runtime/intentGuidance.ts` 扩展 fallback greeting/status 分类，覆盖身份/能力短问和上下文记忆短追问，避免 provider intake 不可用时短问被误判为 `continue` 并触发旧工具链。
  - 更新 `TODO.md`、`TODO_runtime.md`、`DONE.md` 记录本轮 P0 regression 状态和后续优先级。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime-llm.test.ts`：42/42 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。

## 2026-06-01 — P1 TUI task update/status PTY smoke

- **用户决策**: 继续按 TUI P1 编程闭环优先级，补齐 local chat 中 task status/update 的真实 PTY smoke，而不是只走 service/API。
- **处理**:
  - `LocalCodingRuntime` 新增 `task status` 和 `task update <id|suffix|title> <pending|in_progress|completed|failed> [result]` 命令，复用 session storage 的 `listTasks()` / `saveTask()`。
  - task status 输出当前 session task 列表；task update 按 taskId、id suffix 或 title 定位任务，保存新 status/result，并发出 `task_session_event: task_updated`。
  - `renderEvents` 的 task session event 摘要支持 `{ task }` / `{ tasks }` payload，TUI 行内可见 `pending/completed + title`，同时既有 task board 可消费 update。
  - `test/tui_pty_driver.py` 新增 `task-update-status` 序列：真实 PTY 中创建任务、执行 `task status`、按 title 执行 `task update ... completed done` 并断言 TUI 输出。
  - `test/tui-pty-smoke.test.ts` 和 `test/runtime.test.ts` 分别覆盖真实 TUI smoke 与 runtime 命令回归。
  - `docs/nexus/TODO_tui.md` 标记 task update/status smoke 完成，下一项仍是 run sub-agent / AgentLoop smoke。
- **验证**:
  - `/Users/tangyaoyue/DEV/BABEL/BabeL-O/node_modules/.bin/tsx --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts`：49/49 通过。
  - `/Users/tangyaoyue/DEV/BABEL/BabeL-O/node_modules/.bin/tsx --test --test-name-pattern "task" /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/tui-renderer.test.ts`：3/3 通过。
  - `BABEL_O_RUN_PTY_SMOKE=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/node_modules/.bin/tsx --test --test-name-pattern "task status and update" /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/tui-pty-smoke.test.ts`：1/1 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run test:tui:pty`：14/14 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。

## 2026-06-01 — P1 TUI ask coding question about files PTY smoke

- **用户决策**: 按 TUI 优先级补 `ask coding question about files` 的真实 PTY smoke，优先守住编程闭环。
- **处理**:
  - `LocalCodingRuntime` 新增窄范围自然语言文件问题解析：识别包含文件名和 read/content/about/what/say/中文关键词的问题，走真实 `Read` 工具事件，再用读取内容生成回答。
  - `test/tui_pty_driver.py` 新增 `coding-question-files` 序列：临时 workspace 写入 `question.txt`，在真实 `bbl chat` 中发送 `What does question.txt say?`。
  - `test/tui-pty-smoke.test.ts` 新增断言：prompt 正常显示、`Read question.txt done` 出现、回答包含 fixture token `violet-river`。
  - `test/runtime.test.ts` 新增 local runtime 单元回归，验证自然语言文件问题触发 `Read` 且回答包含文件内容。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts`：48/48 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run test:tui:pty`：13/13 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/tui-renderer.test.ts /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/tui-input.test.ts /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/completer.test.ts`：59/59 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 通过。

## 2026-05-31 — P1 SDK/dashboard session assets query API

- **用户决策**: 暂跳过真实 provider live/manual AgentLoop smoke，优先推进 SDK / dashboard-facing session/task query API，作为后续 AetheL / SDK / dashboard 的基础。
- **处理**:
  - 新增 `src/nexus/sessionAssets.ts`，提供稳定 `session_assets` snapshot 聚合：session、tasks、child sessions、events page、tool traces、permission audits、critic reviews、usage summary 与 execution metrics。
  - `GET /v1/sessions/:sessionId/assets` 接入 Nexus API；支持 `eventLimit`、`toolTraceLimit`、`childSessionLimit` 和 `includeEvents/includeToolTraces/includePermissionAudits/includeExecutionMetrics` 查询参数。
  - `NexusStorage` 新增 `listChildSessions(parentSessionId)` 原语，`MemoryStorage` 与 `SqliteStorage` 实现按 parent session 稳定查询，避免 dashboard/resume/cancel 路径继续依赖全局 session list 扫描。
  - `/v1/sessions/:sessionId/resume` 与父 session cancel cascade 改用 `listChildSessions()`；child session snapshot 默认不嵌入完整 events，仍保留 metadata/transcriptPath 供外部查询。
  - critic reviews 同时从 `NexusTask.review` 和 `task_session_event: critic_completed` 提取；usage summary 从完整 session event stream 聚合，不受返回 events page 截断影响。
  - `test/runtime.test.ts` 新增 session assets API 回归，覆盖成功聚合、分页截断、child transcript 不内嵌、404、include 开关和 usage/critic/tool/metrics 输出。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts`：47/47 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。

## 2026-05-30 — P1 TUI 无外框 welcome 与 boxed input prompt

- **用户决策**: 去掉 welcome 最外层框，保留 logo/身份信息；主输入框改为上下分隔线、裸 `>` 输入行和底部 `? for shortcuts` + 当前模型状态。
- **处理**:
  - `src/cli/welcome.ts` 移除 welcome header 的 `┌/│/└` 外框与独立快捷 hint，只保留 logo、`❖ BABEL-O`、版本、用户、工作区、模型和运行模式信息。
  - `src/cli/inputBox.ts` 新增 boxed input renderer：顶部/底部 `─` 分隔线、`>` 输入行、footer 左侧快捷提示、右侧当前模型 label；长输入按终端宽度软换行，首行使用 `> `、续行使用两个空格缩进；未知模型会从 model id 生成可读名称，registry 内模型优先使用 display name。
  - `src/cli/ui.ts` 只对主 chat prompt 使用 boxed input；二级 readline prompt（editable rule / reject instruction 等）继续使用原单行渲染，并在多行主输入刷新后把光标移回 `>` 行。
  - `src/cli/ui.ts` 记录上一帧文本和光标位置，刷新前按当前终端列宽重算旧输入块的视觉光标行，修复 resize 后旧长分隔线残留/错位。
  - `src/cli/inputBox.ts` 的 boxed separator 使用 `columns - 1` 安全宽度；boxed input 多行文本使用 CRLF 输出，避免长路径/中文混排后下分隔线从当前列继续绘制或触发终端软换行。
  - `src/cli/ui.ts` 暴露 `clearCurrentInputBlock()` 和 `renderSubmittedPrompt()`；`src/cli/commands/chat.ts` 在提交后按 readline 已换到下一行的真实光标位置清理整个 boxed input，再用紫色文本渲染用户消息，避免上分隔线、输入框 chrome 或 placeholder tail 残留到 agent 输出前。
  - `src/cli/commands/chat.ts` 的首字符 ghost 清理改为调用 `_refreshLine()`，避免重新写入旧单行 prompt。
  - `src/cli/commands/chat.ts` 将多行 bracketed paste 从独立 Paste Buffer 面板改为插入压缩占位符 `[Pasted text #n +m lines]`；提交前通过 `src/cli/pasteBuffer.ts` 展开占位符为真实粘贴内容，发送态仍保留压缩显示。
  - `test/tui-input.test.ts` 覆盖无外框 welcome header、boxed input prompt/footer、长路径/中文混排输入按首行 `> ` + 续行双空格缩进软换行、boxed input CRLF 行复位、paste placeholder 压缩/展开、主输入多行光标回移、resize 后旧 boxed rows 清理、二级 prompt 保持单行和 wrapped row 清理，以及发送后紫色用户消息不带输入框 chrome。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/tui-renderer.test.ts /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/tui-input.test.ts /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/completer.test.ts`：59/59 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run test:tui:pty`：12/12 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 通过。

## 2026-05-30 — P1 AgentLoop provider live/manual smoke 入口

- **用户决策**: 继续按建议推进 P1，在 deterministic provider-backed smoke 后补真实 provider live/manual AgentLoop smoke；当前先落地显式入口和安全回归，真实联网执行仍作为下一步手动验证。
- **处理**:
  - 新增 `src/nexus/agentLoopSmoke.ts`，提供 `runAgentLoopLiveSmoke()`：创建临时 workspace 和固定 `fixture.txt`，用固定 prompt 跑 AgentLoop，并在结束后清理临时 workspace 与本次 queue。
  - 新增 `bbl optimize --provider-smoke-live`，显式触发 live/manual AgentLoop smoke；支持 `--model <provider/model>` 与 `--timeout-ms <number>`，不要求 `--target`，不会执行任意用户传入任务。
  - smoke 路径真实经过 Planner → Optimizer → `Read` → Optimizer final → Critic，但 Planner 结果会经 `reviewPlan` 固定替换成只读任务，避免真实模型产出任意任务被执行。
  - `createRuntimeAgentStepRunner()` 增加 `allowedToolsOverride`，smoke 中将 Planner/Optimizer 工具可见面收敛到 `Read`；Critic 仍无工具。
  - smoke 输出只展示 redacted provider/model、ready/live/success、session phase、tool call count、task/critic 状态、workspace cleanup、usage summary 和 fallback policy，不输出 API key。
  - `test/agent-loop.test.ts` 新增 mocked provider live/manual smoke 回归，验证固定 planner review 覆盖任意 planner task、Optimizer 请求不含任意任务、只暴露 `Read`、不泄露 key、workspace 清理成功。
  - `test/optimize-command.test.ts` 新增 `--provider-smoke-live` timeout/model 解析与非法 timeout 校验。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/agent-loop.test.ts`：22/22 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/optimize-command.test.ts`：6/6 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 通过。

## 2026-05-30 — P1 非 dry-run provider-backed AgentLoop smoke

- **用户决策**: 继续按建议推进 P1，在远程 cancel/resume 之后补非 dry-run provider AgentLoop smoke；真实 provider/live 仍保持为后续手动验证项，本次先落地可重复、无网络、无任意用户任务执行的 deterministic coverage。
- **处理**:
  - `test/agent-loop.test.ts` 新增 provider-backed 非 dry-run smoke：通过 mock Anthropic-compatible SSE 驱动真实 `LLMCodingRuntime`、Anthropic adapter、`createRuntimeAgentStepRunner()` 与 `runAgentLoop()` 路径，覆盖 Planner → Optimizer → 真实 `Read` 工具 → Optimizer final → Critic。
  - smoke 使用固定临时 workspace、固定 `fixture.txt`、固定 prompt、固定 mock provider response，并固定 runner model 为 `anthropic/claude-3-5-sonnet`，避免本机 `BABEL_O_MODEL` 或 provider/profile 配置污染。
  - smoke 验证 role tool policy：Planner 只看到 `Glob/Grep/Read`，Optimizer 看到 `Bash/Edit/Glob/Grep/Read/Write`，Critic 不看到 tools；同时断言 provider request 不含 arbitrary user task 文案。
  - `LLMCodingRuntime.withToolPolicy()` 与 `LocalCodingRuntime.withToolPolicy()` 修复 async iterable policy 作用域：对 `executeStream()` 这类延迟消费的 stream，在 `for await` 期间保持 role policy 生效，避免创建 stream 后过早恢复默认 policy。
  - `docs/nexus/TODO.md` 与 `docs/nexus/TODO_agents.md` 更新状态：deterministic provider-backed smoke 已完成，真实 provider live/manual AgentLoop smoke 仍单独保留为未完成项。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O test -- test/agent-loop.test.ts` 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 通过。

## 2026-05-30 — P1 远程 cancel/resume API

- **用户决策**: 继续按建议推进 P1，在子 Agent lifecycle / cancel / permission audit 之后补远程 cancel/resume API，供 SDK/dashboard 侧可靠观察和中止运行中的 Nexus session。
- **处理**:
  - `src/nexus/app.ts` 增加 active execution registry，HTTP `/v1/execute` 与 WebSocket `/v1/stream` 运行时登记 `requestId`、transport、startedAt 和 `AbortController`，结束时按 requestId 清理。
  - `POST /v1/sessions/:sessionId/cancel` 会中止 active HTTP/WebSocket execution，复用 `closeNexusSession()` 设置 cancelled phase、解析 pending permissions，并返回 activeExecutionCancelled、requestId、transport、permissionsResolved 和 childSessionsCancelled。
  - `POST /v1/sessions/:sessionId/resume` 返回 session snapshot、recent events、tasks、child sessions 和 active execution metadata；该接口是恢复/观察快照，不会重启执行。
  - HTTP execute 终态保存时保留已被远程 cancel 标记的 `cancelled` phase，避免执行流返回失败 result 后把 session 覆盖为 failed。
  - `closeNexusSession()` 的 child cascade 从仅扫描 in-memory TaskSession 扩展到同时扫描持久化 sessions，确保直接存在 storage 中的 child sessions 也会随父 session cancel 被标记为 cancelled。
  - `test/runtime.test.ts` 新增远程 cancel/resume 回归：覆盖 active execute resume snapshot、远程 cancel abort、持久化 child session 级联取消、最终 cancelled phase 保留，以及 terminal resume 中 `REQUEST_CANCELLED` event 可见。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts`：46/46 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/agent-loop.test.ts`：20/20 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 通过。

## 2026-05-30 — P1 TUI 启动信息与输入刷新 polish

- **用户决策**: 保留 boxed welcome card 的 logo、`❖ BABEL-O`、版本、登录用户、工作区和模型信息；只精简 `/help help │ Ctrl+O toggle │ Ctrl+C cancel` 与 `Started/Resuming session` 两段展示，并修复长输入刷新残影。
- **处理**:
  - `src/cli/welcome.ts` 保留 boxed logo welcome card 结构，将启动 hint 改为轻量 `? shortcuts · / commands · Ctrl+E editor ... Ctrl+O details · Ctrl+C cancel`，避免重复 `help help` 和重分隔符。
  - `src/cli/commands/chat.ts` 将新建/恢复 session banner 改为紧凑 `session <id>` / `resume <id>`；`test/tui_pty_driver.py` 与 `test/tui-pty-smoke.test.ts` 同步使用新 banner 解析真实 session id。
  - `src/cli/ui.ts` 的 autosuggestion `_refreshLine` 记录上一次输入区占用行数，刷新前回到旧输入块顶部并 `clearScreenDown`，避免长路径/中文输入截断回退后旧 prompt 片段残留到相邻行。
  - `test/tui-input.test.ts` 补 welcome identity/border、compact hint/session banner、wrapped input row 清理回归。
  - `src/cli/inputBox.ts` 保持单行 fixed viewport，新增 placeholder/ghost 行为 helper；placeholder 只在输入内容真正为空时显示，普通字符、中文、空格输入都会清除提示。
  - `src/cli/commands/chat.ts` 在 stdin data 截获层处理输入框 ghost：空白 Enter 只重绘当前行不提交空 turn；首字符输入前清除 hint 并重绘完整 prompt，避免提示残留或 prompt 被整行擦掉。
  - `test/tui_pty_driver.py` / `test/tui-pty-smoke.test.ts` 新增 `input-placeholder` 真实 PTY 序列，覆盖空白 Enter、中文首字符输入、ghost hint 清除和 prompt 保留。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/tui-renderer.test.ts /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/tui-input.test.ts /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/completer.test.ts`：52/52 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run test:tui:pty`：11/11 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 通过。

## 2026-05-30 — P1 子 Agent session-scope approval 可配置继承 audit

- **用户决策**: 继续按建议推进 P1，在子 Agent cancel/resume 后补 session-scope approval 继承策略的可配置审计。
- **处理**:
  - `runAgentLoop()` 新增 `subAgentApprovalInheritance` 选项，默认不继承 once approval / session approval，保持安全默认。
  - `buildSubAgentLifecycleMetadata()` 根据显式配置计算 `inheritedSessionApprovalTools`；即使开启 session approval 继承，也只保留当前子 Agent role policy `allowedTools` 中允许的工具名，过滤掉越权工具。
  - `subagent_permission_inheritance` 审计事件和 child session metadata 均记录 `inheritsOnceApprovals=false`、`inheritsSessionApprovals` 和过滤后的 `inheritedSessionApprovalTools`。
  - `test/agent-loop.test.ts` 新增显式开启 session approval 继承的 smoke，验证 `NotAllowed` 与当前 role 不允许的 `TaskCreate` 不会进入继承列表；既有 lifecycle 测试补断言默认 inheritedSessionApprovalTools 为空。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/agent-loop.test.ts`：20/20 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 通过。

## 2026-05-30 — P1 单个子 Agent cancel 结构化失败传播

- **用户决策**: 继续按建议推进 P1，在父 session close 级联取消之后补单个 child session cancel 后的父任务恢复/收口 smoke。
- **处理**:
  - `runAgentLoop()` 在执行循环和 executor 返回后检查当前 TaskSession 是否已被外部取消，避免取消中的 child session 被后续 executor success 覆盖成 completed。
  - 子 Agent 返回 cancelled/failed 时生成结构化 `executorResult`，把 `subAgent.status`、`summary`、`resultEventRange` 和 transcriptPath 写入父队列 child task metadata。
  - child sub-agent cancel 默认不重试，child task 终态 failed，review reason 为 `Sub-agent session was cancelled`。
  - `TaskQueue` 的 dependency failure propagation 不再只写 `Dependency failed`，而是把 failed dependency 的 result/metadata 汇总进 blocked parent task 的 `failedDependencies` metadata，父任务可从队列层直接看到 child cancel 摘要。
  - `test/agent-loop.test.ts` 新增单个 child TaskSession 在 executor 中被取消的 smoke，验证 child session 保持 cancelled、child task failed、parent task failed、`subagent_cancelled` 事件和 failed dependency metadata。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/agent-loop.test.ts`：19/19 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 通过。

## 2026-05-30 — P1 TUI resume session PTY smoke 与 task update 入口核对

- **用户决策**: 继续根据 TUI 优先级建议推进，补齐剩余编程闭环里最稳的 resume session smoke，并核对 task update/status 是否已有可测入口。
- **处理**:
  - `test/tui_pty_driver.py` 新增 `resume-session` 序列：第一次真实启动 `bbl chat`，执行 `read smoke.txt` 后退出，再从首轮 transcript 解析实际 `session_<id>` 并用 `--session` 恢复。
  - resume 序列验证恢复 banner、历史 `Read smoke.txt done` 工具记录和 compact 展开提示重绘，覆盖 embedded SQLite session history 在真实 PTY 下的恢复路径。
  - PTY driver 抽出 `start_chat_process()` / `stop_chat_process()`，确保 resume 序列可在同一隔离 config/HOME/workspace 内安全重启 chat 进程。
  - 核对 task update/status：Nexus service 已有 `PATCH /v1/sessions/:sessionId/tasks/:taskId` 与 `task_updated` event 渲染路径，但 local `bbl chat` 的 `LocalCodingRuntime` 当前只暴露 `task <title>` -> `TaskCreate`，因此 task update/status 不能直接由 local PTY smoke 覆盖。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run test:tui:pty`：10/10 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O test -- test/tui-renderer.test.ts test/tui-input.test.ts test/completer.test.ts`：328/328 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。

## 2026-05-30 — P1 TUI 编程工作流 PTY smoke

- **用户决策**: 继续根据 TUI 优先级建议推进，先补真实编程工作流闭环 smoke，再进入视觉 smoke 与 MCP display。
- **处理**:
  - `test/tui_pty_driver.py` 新增 `programming-workflow` 序列：在 `/tmp/babel-o-pty-<pid>/workspace` 初始化临时 git repo 和 fixture 文件，避免修改真实仓库。
  - 该序列通过真实 PTY 驱动 `bbl chat` 依次执行 `read smoke.txt`、`edit smoke.txt beta gamma`、Ctrl+O 展开 diff、`grep gamma`、`glob **/*.ts`、`task Verify smoke workflow`。
  - PTY driver 现在把 `HOME` 指向临时 config 目录，使 chat history 与 SQLite session DB 也隔离在 smoke 临时目录中。
  - `test/tui-pty-smoke.test.ts` 新增对应 Node wrapper 断言，覆盖 Read/Edit/Grep/Glob/TaskCreate 完成行、Edit diff `+ gamma`、Grep 输出 `smoke.txt:1:alpha gamma` 和 Glob 输出 `src/smoke.ts`。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run test:tui:pty`：9/9 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O test -- test/tui-renderer.test.ts test/tui-input.test.ts test/completer.test.ts`：328/328 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。

## 2026-05-30 — P1 子 Agent cancel/resume smoke 与 permission inheritance audit

- **用户决策**: 继续按建议推进 P1，在子 Agent lifecycle metadata 后补 cancel/resume smoke 与 permission inheritance 审计记录。
- **处理**:
  - `closeNexusSession()` 增加 active child TaskSession 级联取消：父 session close/cancel 时取消非终态 child session，并把 `childSessionsCancelled` 写入父 session metadata、SessionEnd hook cleanup payload 与 close API response。
  - child session 取消时写入 `PARENT_SESSION_CANCELLED` terminal reason，并在 child metadata 中记录 `status=cancelled`、`cancelledByParentSessionId` 和 `cancelReason`。
  - `runAgentLoop()` 在子 Agent 启动时新增 `subagent_permission_inheritance` 审计事件，显式记录 role policy allow rules、`requiresApproval`，以及不继承 once/session approvals。
  - `test/agent-loop.test.ts` 补齐父 session close 级联取消 active child TaskSession 的 smoke，并扩展子 Agent lifecycle 测试覆盖 permission inheritance 审计事件、child metadata 和父队列 `subAgent` transcript 引用。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/agent-loop.test.ts`：18/18 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 通过。

## 2026-05-30 — P1 子 Agent lifecycle metadata / transcript / permission inheritance

- **用户决策**: 根据建议推进 P1，优先收口子 Agent lifecycle、transcript 引用和 permission inheritance 可审计性。
- **处理**:
  - `SessionSnapshot` 新增通用 `metadata`，`TaskSession` 与 SQLite storage 持久化该字段，并补 SQLite v5 metadata 迁移。
  - `runAgentLoop()` 为子 Agent session 注入正式 metadata：`agentId`、`parentAgentId`、`parentSessionId`、`parentTaskId`、`depth`、`agentType=subagent`、`status`、`transcriptPath` 与 permission inheritance 策略。
  - 父 session 兼容保留 `sub_agent_session_*` 事件，同时新增规范化 `subagent_started`、`subagent_completed`、`subagent_failed`、`subagent_cancelled` 事件；父队列任务只保存 `subAgent` 摘要引用和 `nexus://sessions/<subSessionId>/events` transcriptPath。
  - permission inheritance 第一版记录 role policy allow rules、`requiresApproval`，并明确不继承 once/session approvals；cancel/resume smoke 与 session-scope approval audit 保留为下一步。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/agent-loop.test.ts`：17/17 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts`：45/45 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 通过。

## 2026-05-30 — P1 TUI 最小 PTY smoke 与下一优先级重排

- **用户决策**: 继续推进 TUI 开发优先级，并要求同步更新 TODO 文档和工作记录；当前重点从权限键盘正确性转向编程工作流闭环与终端视觉 smoke。
- **处理**:
  - 新增 `test/tui_pty_driver.py`，使用 Python stdlib `pty/select/termios` 启动真实 `bbl chat`，以隔离 temp config 和 `local/coding-runtime` 驱动真实键盘路径，不依赖真实 provider 或 native `node-pty`。
  - 新增可选 `test:tui:pty` 脚本和 `test/tui-pty-smoke.test.ts`，由 `BABEL_O_RUN_PTY_SMOKE=1` 显式启用，覆盖 slash palette、permission panel Esc/Backspace reject、approve once、approve for session cache、editable rule、reject with instruction，以及 compact Read 工具渲染隐藏 raw 参数/state。
  - 修复 PTY 暴露的 secondary readline prompt 问题：autosuggestion `_refreshLine` 现在保留当前 `this._prompt`，只在主 prompt idle 状态下展示 autosuggestion，避免 editable rule / reject instruction prompt 被 BabeL-O 主输入框覆盖。
  - 修复 renderer 中 standalone whitespace-only `assistant_delta` 导致工具行前出现裸 `⏺` 的问题；live/history 渲染均跳过独立空白 assistant delta，但保留连续 assistant 文本内部空白。
  - `test/tui-pty-smoke.test.ts` 在断言前剥离 ANSI 和 `\r`，避免 raw terminal 控制序列造成 false negative。
  - TUI 下一轮优先级重排为：编程工作流闭环 smoke、唯一输入框/agent running 视觉 smoke、MCP tool/resource display。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run test:tui:pty`：8/8 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O test -- test/tui-renderer.test.ts test/tui-input.test.ts test/completer.test.ts`：327/327 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。

## 2026-05-30 — P0/P1 worktree / Git 并发安全

- **用户决策**: 按建议推进 worktree / Git 并发安全，目标是避免多个 agent / optimizer 同时操作同一父工作区导致 cherry-pick 冲突、Git metadata 竞争或误覆盖。
- **处理**:
  - `src/nexus/worktree.ts` 新增 per-cwd Git operation lock，并暴露测试用 stats/reset helper。
  - `createWorktree()`、`commitAndMergeWorktree()`、`removeWorktree()`、`pruneOrphanedWorktrees()` 均按父仓 cwd 串行化；merge-back 的 parent HEAD 读取、worktree commit、commit range 计算、cherry-pick 与 conflict abort 保持在同一临界区。
  - `src/nexus/agentLoop.ts` 的 optimizer in-place Git mutation 也复用同一锁：`stash`、`commit`、`rollback`、`stash pop`，避免与 isolated worktree merge-back 并发修改同一父仓。
  - `worktree.test.ts` 新增同仓串行、跨仓并发和真实 concurrent merge-back 回归；顺手修正 `tui-input.test.ts` 中 autosuggestion readline mock 的 `_refreshLine` 类型窄化问题，使 typecheck 恢复通过。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/worktree.test.ts`：6/6 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/agent-loop.test.ts`：17/17 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 通过。

## 2026-05-30 — P0/P1 Bash classifier 路径与变量展开硬化

- **用户决策**: 继续根据建议推进 P0；非 DeepSeek 的指令跟随与 provider 协议 P0 已收口后，顺手推进相邻 runtime 安全硬化项。
- **处理**:
  - `classifyAction()` 新增可选 cwd 上下文，`LLMCodingRuntime` 与 `LocalCodingRuntime` 在权限分类时传入当前 workspace。
  - Bash `cat` 自动审批只允许明确的 workspace 内文件路径；`../` 越界、绝对路径越界、glob、`/dev/*` 均不自动批准。
  - shell 词法扫描从只拒绝 `$()` / `${}` 扩展，收紧为所有 `$VAR` / `${VAR}` / `$()` 在自动审批路径下都进入人工 review。
  - `classifier.test.ts` 覆盖 `$HOME`、`${HOME}`、workspace 内外 `cat` 与 glob；`permission-flow.test.ts` 覆盖 `cat /tmp/secret.txt` 触发 permission_request 而不是自动执行。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/classifier.test.ts /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/permission-flow.test.ts`：12/12 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 通过。

## 2026-05-30 — P0 session_3ba2d788 指令跟随回归修复

- **用户决策**: 继续推进 P0，并针对真实会话 `session_3ba2d788-6f78-468b-b01d-0a6a10ade46f` 中 “你好？” 后仍继续旧 BabeL-X 工具链的问题做修复；DeepSeek reasoning 适配仍暂缓。
- **处理**:
  - `LLMCodingRuntime` 读取历史事件改为 `order=desc, limit=1000` 后 reverse，确保长会话使用最新 tail 而不是最早 1000 条。
  - User Intake Guidance 绑定与校验改为以本轮 `latestPrompt` 为最高优先级，旧 `user_message` 只作为 history/background。
  - intake 模型输出的 `explicitPaths` 不再被信任，统一使用 deterministic extractor 从当前 prompt 提取，避免 hallucinated path 污染 focus。
  - runtime 执行层新增 `TOOL_CALL_SUPPRESSED_BY_USER_INTENT` 硬拦截：当 `respond_only` / `requiresTools=false` 时，即使 provider 通过 MiniMax text-encoded tool_call 产出工具调用，也不会进入 `tool_started`。
  - `runtime-llm.test.ts` 覆盖长会话 tail/intake、respond_only 下 MiniMax 文本工具调用硬拦截；`context-regression.test.ts` 新增 session_3ba2d788 sanitized replay。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime-llm.test.ts /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/context-regression.test.ts`：49/49 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。

## 2026-05-29 — P0 Provider smoke live tool-call 与协议回归扩展

- **用户决策**: 继续推进 P0，并在用户已全量修复 TUI 页面问题后直接执行测试与 provider/runtime P0 收口。
- **处理**:
  - `POST /v1/runtime/provider-smoke/live` 新增显式 `mode=tool_call`，用固定 synthetic tool `provider_smoke_probe` 与固定 `BABEL_O_PROVIDER_SMOKE_OK` probe 参数验证 provider 工具调用协议。
  - live tool-call smoke 只收集 `tool_use_start/tool_use_delta/tool_use_end`，不执行工具、不创建 session、不写 event、不自动切换 provider/model/profile、不泄露 API key。
  - CLI 支持 `/smoke live tool-call` 与 `/smoke tool-call`，展示 tool matched 状态、toolCallCount 和工具名；help panel 增加对应入口。
  - `adapters.test.ts` 新增 Anthropic malformed `input_json_delta` 回归，确认以 `_parseError/_rawInput` 保留为 recoverable tool input。
  - `adapters.test.ts` 新增 OpenAI 并发 multi-tool `tool_calls` 回归，确认按 index 分离参数流并各自产生正确 `tool_use_end.input`。
  - 清理 `src/cli/renderEvents.ts` EOF 多余空行，使 `git diff --check` 通过。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/adapters.test.ts /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/completer.test.ts /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/tui-input.test.ts`：82/82 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O test`：305/305 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 通过。

## 2026-05-29 — P0 Provider 协议 regression corpus 扩展

- **用户决策**: 继续根据建议推进 P0，在 simple-text live smoke 之后优先扩展 provider 协议兼容回归。
- **处理**:
  - `adapters.test.ts` 新增 MiniMax text-encoded tool call 前后夹带普通文本的回归，确认普通文本保留、raw `<minimax:tool_call>` 不作为 text delta 泄露。
  - `adapters.test.ts` 新增 MiniMax 未闭合 `<minimax:tool_call>` 回归，确认不会被转换成真实工具调用。
  - `adapters.test.ts` 新增 OpenAI malformed `delta.tool_calls[].function.arguments` 回归，确认最终 `tool_use_end.input` 保留 `_parseError` 与 `_rawInput`。
  - `runtime-llm.test.ts` 新增 OpenAI malformed tool-call runtime 回归，确认 raw provider 协议不进入 `assistant_delta`，并以 recoverable `tool_completed success=false` / `PARSE_ERROR` 回传模型。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/adapters.test.ts /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime-llm.test.ts`：52/52 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。

## 2026-05-29 — P0 Provider smoke live 与 CLI/TUI 展示第一版

- **用户决策**: 根据建议执行 P0-0 与 P0-1：收口 live provider smoke，并把 provider smoke 诊断接入 CLI/TUI 状态展示。
- **处理**:
  - 新增共享 `providerSmoke` runtime helper，API 与 CLI 复用同一套 readiness/live smoke 判断。
  - `POST /v1/runtime/provider-smoke/live` 使用固定 `BABEL_O_PROVIDER_SMOKE_OK` prompt 验证真实 provider/adapter streaming 链路；不执行用户任务、不创建 session、不写 session event、不自动切换 provider/model/profile、不泄露 API key。
  - `/v1/runtime/status` 返回 `providerSmoke` dry-run readiness。
  - CLI `/status` 在 embedded/service 模式展示 provider smoke readiness、requirements、checks 与 `allowSilentModelSwitch=false` fallbackPolicy。
  - 新增 CLI `/smoke` dry-run 与显式 `/smoke live`；默认只读检查，只有用户明确输入 live 时才触发固定 live smoke。
- **测试覆盖**:
  - `runtime.test.ts` 覆盖 status 中的 `providerSmoke`、dry-run readiness、capability unmet、live smoke 固定 prompt 与不创建 session。
  - `completer.test.ts` 覆盖 slash/palette 元数据仍可用。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/completer.test.ts`：51/51 通过。

## 2026-05-29 — TUI 多行剪贴板粘贴缓存 (Clipboard Multiline Paste Cache)

- **用户反馈**: CLI 仍然不支持多行信息的直接粘贴缓存（直接粘贴会把回车解析为多行提交，导致指令错乱）。
- **实现结果**:
  - **终端 Bracketed Paste 整合**: 在 chat 命令启动时向 stdout 写入 `\x1b[?2004h` 开启 Bracketed Paste Mode，退出时通过 `\x1b[?2004l` 彻底关闭，防止污染用户终端环境。
  - **Emitter 级数据截获**: 拦截 `process.stdin.emit` 事件。在 Raw 模式下，当检测到粘贴流起始符 `\x1b[200~` 时，自动进入 `isPasting` 状态，拦截所有 `data` 和 `keypress` 事件，将内容归拢至缓冲区直到收到结束符 `\x1b[201~`。
  - **单行与多行智能分流**:
    - 若粘贴文本不包含换行符（如 URL、单词），自动通过 `rl.write(text)` 写入当前输入行，允许用户继续交互编辑。
    - 若粘贴文本包含换行符（多行粘贴），自动将输入状态切换为 `'pasteBuffer'`，并在控制台绘制醒目的 cyan 边框 Multiline Paste Buffer 预览卡片（展示前 8 行及总行数）。
  - **专属快捷按键路由**: 在 `'pasteBuffer'` 状态下，只响应 `Enter`（确认提交多行内容）、`Ctrl+E`（打开外部编辑器编辑该粘贴内容）和 `Esc/Backspace`（取消并丢弃缓存），拦截其余所有字符输入，防范键盘敲击污染。
- **测试覆盖与验证**:
  - 在 `test/editor.test.ts` 中新增了 `bracketed paste logic isolates pasted content correctly` 单元测试，完全覆盖了单分包和多分包（multi-chunk）下对 `\x1b[200~` 与 `\x1b[201~` 粘贴内容的抽取逻辑与状态切换。
  - 运行 `npm run typecheck` 通过。
  - 运行 `npm test`，全量 279 项测试用例全部成功通过。

## 2026-05-29 — P0 MiniMax text-encoded tool_call 协议兼容修复

- **用户反馈**: 使用 `minimax/MiniMax-M2.7-highspeed` 时，CLI 直接显示 `<minimax:tool_call><invoke name="Bash">...` 原始文本，而不是正常执行工具并输出结果。
- **原因**: MiniMax 的 Anthropic-compatible 流会把工具调用编码进 `text_delta`，形态为 `<minimax:tool_call><invoke ...><parameter ...>`；旧 `AnthropicAdapter` 只识别标准 Anthropic `content_block.type=tool_use`，因此把这段 provider-specific 工具协议当成普通助手文本透传成 `assistant_delta`。
- **处理**:
  - `AnthropicAdapter` 对 `providerId=minimax` 增加 text-encoded tool parser。
  - 解析 `<invoke name="...">` 和 `<parameter name="...">...</parameter>`，输出标准 `tool_use_start/tool_use_delta/tool_use_end`，并补 `finish=tool_use`。
  - 保留非 MiniMax provider 的原有 Anthropic text/tool_use 处理路径，避免影响 Anthropic/Zhipu 等 adapter 行为。
- **测试覆盖**:
  - `adapters.test.ts` 新增 MiniMax text-encoded tool call 回归，断言不产生 raw text，而是标准 tool deltas。
  - `runtime-llm.test.ts` 新增 runtime 回归，断言 raw `<minimax:tool_call>` 不会作为 `assistant_delta` 出现，并会进入 `tool_started/tool_denied` 标准工具路径。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/adapters.test.ts`：13/13 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime-llm.test.ts`：35/35 通过。

## 2026-05-29 — TUI 多行文本输入缓冲区 / 外部编辑器模式支持

- **用户决策**: 批准推进 CLI 终端下 `bbl chat` 的多行输入缓冲区开发，支持使用外部文本编辑器。
- **实现结果**:
  - **外部编辑器集成 (`editor.ts` [NEW])**: 实现了 `openExternalEditor` 助手，优先使用用户配置的 `$VISUAL`/`$EDITOR` 变量，自动兜底到 `nano` 和 `vi` 编辑器。
  - **行内快捷键编辑 (`Ctrl+E`)**: 在命令行 `idle` 输入状态下，拦截 `Ctrl+E` 组合键，挂起 Readline 界面，利用工作区下隔离的临时文件目录 `.babel-o/` 生成临时文本，交由编辑器全屏打开。用户保存并关闭编辑器后，自动读取内容并作为 prompt 直接提交运行。
  - **斜杠命令扩展 (`/editor`/`/e`)**: 支持在 prompt 中输入 `/editor` 或 `/e`，回车后将直接触发外部编辑器打开一个空白 prompt 进行自由撰写。
  - **自动清理与安全拦截**: 每次编辑产生的临时文件均在编辑器退出（无论成功或异常）后被立即删除。增加了命令行 keypress 监听恢复及 raw mode 切换的防御性还原。
- **测试覆盖与验证**:
  - 新建了 `test/editor.test.ts`，对 `openExternalEditor` 进行单元测试。通过 mock 导出的 spawner 容器，全量覆盖了成功编辑返回、断言临时文件存在、临时文件在 final 周期清理、以及 broken-editor 情况下向下兜底到 `nano` 的流程。
  - `npm run typecheck` 成功通过。
  - `npm test` 成功通过，全量 276 个测试用例（新增 2 个）全部通过。

## 2026-05-29 — TUI 终端交互与 Markdown 语法高亮渲染优化

- **用户决策**: 批准推进 CLI 终端交互 TUI 优化与 Markdown 渲染/高亮性能修复。
- **实现结果**:
  - **交互式终端分页器 (`pager.ts`)**: 基于备用屏幕缓冲区 (`\x1b[?1049h`) 实现了不污染主屏历史的分页器。支持 `↑`/`↓`/`PageUp`/`PageDown`/空格/`b`/`f` 键滚动，`q`/`Esc` 退出。集成 `/pager` 与 `/less` 命令查看上一次工具调用完整输出。
  - **行内自动建议 (Auto-suggestions)**: 实现类似 Zsh/Fish 的灰色行内自动建议，通过 `→` 或 `Ctrl+F` 快速补全。修复了输入 `/` 时直接预填首项的干扰问题（现仅在按上下键时才显式预览），并利用 ANSI 剥离计算修复了原生 raw 模式下的光标偏移。
  - **持久化底部状态栏**: 重构终端下方状态行，实现显示当前大模型及 Token 消耗比例的红黄绿渐变上下文 Gauge 进度条。
  - **树状多层级任务看板**: 升级任务看板为双边框外盒，以 Unicode 连接符 (`├─`, `└─`, `│  `) 直观展示子任务深度、Worktree 范围和子会话依赖。
  - **语法高亮状态机优化**: 废弃容易产生冲突的全局正则高亮方案，重构为基于字符遍历的词法状态机 (`highlightCode` & `highlightJson`)，精准着色字符串、注释、关键词及数值，避免转义符溢出污染；新增 JSON Key-Value 专用高亮。
  - **富文本表格与对齐**: 支持表格内加粗、斜体、行内代码与链接的混合渲染；编写 `padAnsi` 自动剔除不可见 ANSI 字符以精确计算列宽对齐。
  - **流式防抖与行缓冲 (`MarkdownStreamRenderer`)**: 重构流式渲染器为行缓冲机制，阻断由于分块传输导致的 Markdown 标记未闭合闪烁问题。
- **验证**:
  - `npm run typecheck` 成功通过。
  - `npm test` 成功通过，全量 274 个测试用例 100% 通过。

## 2026-05-29 — P0 Provider smoke dry-run 诊断入口第一版

- **用户决策**: 继续根据建议推进 P0，并优先压实 provider/runtime 稳定性；DeepSeek reasoning replay 继续暂缓。
- **问题**: `/status` 已能展示 provider/model/auth/capability，但缺少一个可由 service/CLI/UI 调用的 smoke readiness 入口；直接做真实 provider 请求会有成本、速率限制和误执行用户任务风险。
- **处理**:
  - 新增 `GET /v1/runtime/provider-smoke`，只做 dry-run readiness 诊断，不执行用户 prompt、不创建 session、不写 event。
  - endpoint 返回 redacted provider diagnostics、requirements、checks、`ready` 与 fallbackPolicy。
  - checks 覆盖 auth configured、model resolved、tool calling、streaming、structured output capability。
  - fallbackPolicy 固定 `allowSilentModelSwitch=false`，未满足 readiness 时要求修配置或显式选择模型/配置，不自动切换 provider/model/profile。
- **测试覆盖**:
  - `runtime.test.ts` 新增 local provider dry-run ready 回归，断言不泄露 apiKey、不创建 session。
  - `runtime.test.ts` 新增 capability unmet 回归，断言 `ready=false`、`fallbackPolicy.mode=fix_configuration`、禁止 silent switch、不创建 session。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts`：42/42 通过。

## 2026-05-29 — P0 Provider diagnostics / auth mode 展示第一版

- **用户决策**: 继续按建议推进 P0，优先让 provider/model/auth/capability 状态在请求失败前可见。
- **问题**: `/status` embedded 模式只显示 model，service 模式只 dump raw runtime status；用户无法直接看到 provider、authMode、auth 是否配置、配置来源、baseUrl 来源、tool/structured-output capability。
- **处理**:
  - `ConfigManager.resolveSettings()` 增加 `apiKeySource` 与 `baseUrlSource`，保留原 `modelSource`。
  - 新增 `ConfigManager.getProviderDiagnostics()`，输出 redacted provider diagnostics：provider/model、adapter、authMode、authConfigured、authSource、baseUrlSource、contextWindow、defaultMaxTokens、tool/json/structured/streaming capability；不输出 API key。
  - `/v1/runtime/status` 返回 `provider` diagnostics。
  - CLI `/status` 在 embedded/service 模式格式化展示 provider diagnostics。
- **测试覆盖**:
  - `runtime-llm.test.ts` 扩展 ConfigManager 配置优先级测试，断言 apiKey/baseUrl 来源和 provider diagnostics capability。
  - `runtime.test.ts` 新增 `/v1/runtime/status returns redacted provider diagnostics`，断言 local provider diagnostics 且不泄露 apiKey。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime-llm.test.ts`：34/34 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts`：40/40 通过。

## 2026-05-29 — P0 Provider fallback policy 第一版（非静默）

- **用户决策**: 继续推进 P0 provider/runtime fallback 策略，但不处理 DeepSeek reasoning replay。
- **问题**: provider recovery 只有 kind/recoveryReason/suggestion，无法审计 runtime 是否会自动切换模型，也无法在 UI 中明确下一步应该 compact、重试、修配置还是要求用户确认。
- **处理**:
  - `providerRecovery.ts` 新增 `ProviderFallbackPolicy`，字段包含 `mode`、`reason`、`nextAction`、`allowSilentModelSwitch=false`。
  - `classifyProviderRecovery()` 为 max-output、context-window、rate-limit/provider-unavailable、auth/billing、provider-protocol、unknown 错误返回 fallback policy。
  - `LLMCodingRuntime` 的 `MAX_OUTPUT_TOKENS_EXCEEDED` 终态也带同一 `max_output_tokens` fallback policy。
  - CLI error rendering 展示 `fallback=<mode>` 与 `silentSwitch=false`，让用户能看到不会静默切换模型。
- **测试覆盖**:
  - `provider-recovery.test.ts` 断言 max-output/context-window/auth/protocol 的 fallback mode 和禁止 silent switch。
  - `runtime-llm.test.ts` 断言 provider error 与 max-output exhausted error details 带 fallback policy。
  - `tui-renderer.test.ts` 断言 session history 渲染 fallback policy。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/provider-recovery.test.ts /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/tui-renderer.test.ts`：18/18 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime-llm.test.ts`：34/34 通过。

## 2026-05-29 — P0 `/context` runtime policy 诊断可观测性

- **用户决策**: 认可继续按建议推进 P0，优先补齐 intake/tool suppression/recovery boundary 的可观测性。
- **问题**: `/context` / context analysis 只暴露原始 `userIntentGuidance`，但没有明确告诉用户当前工具是否被 runtime 隐藏、隐藏原因，以及最近哪个终态错误正在作为 recovery boundary；真实会话复盘时仍需要从 event log 手工判断。
- **处理**:
  - `contextAnalysis.ts` 新增 `runtimePolicy`：`toolsVisible`、`toolSuppressionReason`、`recoveryBoundaryActive`、`recoveryBoundaryCode`、`recoveryBoundaryTimestamp`、`recoveryBoundaryMessage`。
  - `contextAssembler.ts` 导出 `isRecoveryBoundaryError()`，保证 diagnostics 与 recent event 选择使用同一套 recovery boundary 判定。
  - CLI `/context` 新增 `User Intent / Runtime Policy` 区块，展示 intent/source/confidence、action/scope/requiresTools、explicit paths、tools visible 和 recovery boundary。
- **测试覆盖**:
  - `context-assembler.test.ts` 的 `analyzeContext returns token and compact diagnostics` 增加 pause + `REQUEST_CANCELLED` 样本，断言 tools hidden 和 recovery boundary code。
  - `runtime.test.ts` 的 `/v1/sessions/:sessionId/context` API 回归断言 `runtimePolicy` 与 `userIntentGuidance` 字段存在。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/context-assembler.test.ts`：32/32 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts`：39/39 通过。

## 2026-05-29 — P0 真实 session_321c48be replay 回归

- **用户决策**: 继续推进 P0，并继续暂缓 DeepSeek reasoning replay。
- **问题**: 真实会话 `session_321c48be-0ffd-4ec4-bfc0-9ba7f1896f8f` 中，Baidu 项目分析后用户输入 malformed greeting `hi``，旧逻辑继续触发 Baidu 旧工具链；用户 cancel 后又输入 `just stop it and waite for me other require`，仍存在恢复边界后继续旧工具链的风险。
- **处理**:
  - `context-regression.test.ts` 新增 sanitized real-session replay fixture，保留真实 session id、Baidu cwd、关键时间线、关键工具结果和 cancel/pause 事件。
  - 新增回归：`hi`` 被识别为 `greeting` + `respond_only` + `requiresTools=false`，同时保留 Baidu 项目上下文作为背景，不触发旧工具链。
  - 新增回归：`REQUEST_CANCELLED` 后的 `just stop it...` 从 recovery boundary 开始，只保留最新 pause 用户轮次，并归一化为 `respond_only`。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/context-regression.test.ts`：9/9 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/context-assembler.test.ts /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/provider-recovery.test.ts`：37/37 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime-llm.test.ts`：34/34 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 通过。

## 2026-05-29 — P0 非 DeepSeek：max-output recovery 端到端修复

- **问题**: `LLMCodingRuntime` 遇到 provider stream `finishReason=max_tokens` 时会尝试 continuation；但连续超过恢复次数后，旧逻辑会把最后一段截断文本作为 `success=true` 的最终回答，且早期截断段没有进入 messages。
- **处理**:
  - `max_tokens` 且无工具调用时，前三次恢复会把当前截断 assistant 文本写入 messages，再追加 continuation prompt，避免丢失已生成片段。
  - 恢复耗尽后输出 `MAX_OUTPUT_TOKENS_EXCEEDED` error 和失败 `result`，details 使用 `kind=max_output_tokens`、`recoveryReason=ESCALATED_MAX_TOKENS`。
  - `selectRecentEvents()` 将 `MAX_OUTPUT_TOKENS_EXCEEDED` 纳入 recovery boundary。
- **测试覆盖**:
  - `runtime-llm.test.ts` 新增连续 4 次 `max_tokens` 的端到端回归，断言不会误判成功。
  - `context-regression.test.ts` 的终态错误组合加入 `MAX_OUTPUT_TOKENS_EXCEEDED`。
  - `provider-recovery.test.ts` 新增 OpenAI `finish_reason=length` 分类回归。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json /Users/tangyaoyue/DEV/BABEL/BabeL-O/node_modules/.bin/tsx --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime-llm.test.ts /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/context-regression.test.ts /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/provider-recovery.test.ts`：46/46 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。

## 2026-05-29 — P0 非 DeepSeek：provider/runtime 可恢复错误组合回归

- **用户决策**: 认可继续推进 P0 provider/runtime 可恢复性组合回归，仍暂不处理 DeepSeek reasoning replay。
- **问题**:
  - `selectRecentEvents()` recovery boundary 只覆盖 cancel/timeout，provider error、empty response、context limit、max loops 等终态错误后的下一轮状态追问可能仍回放旧工具链。
  - `LLMCodingRuntime` provider error catch 和 `MAX_LOOPS_EXCEEDED` 终态只输出 error/metrics，缺少失败 `result` 作为统一终态。
- **处理**:
  - `contextAssembler.ts` 新增终态错误 recovery boundary：`PROVIDER_ERROR`、`EMPTY_PROVIDER_RESPONSE`、`CONTEXT_LIMIT_EXCEEDED`、`MAX_LOOPS_EXCEEDED`、`TOOL_LOOP_FINAL_RESPONSE_ONLY`。
  - `LLMCodingRuntime` 在 provider error catch 中输出失败 `result`，保留 `error.details` 的 provider recovery 分类。
  - `MAX_LOOPS_EXCEEDED` 终态也输出失败 `result`，避免 UI/调用方误缺终态。
- **测试覆盖**:
  - `context-regression.test.ts` 新增 terminal runtime errors recovery boundary 组合回归。
  - `runtime-llm.test.ts` 新增 provider error recovery details + failed result 回归。
  - `runtime-llm.test.ts` 新增 max-loop exceeded failed result 回归。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json /Users/tangyaoyue/DEV/BABEL/BabeL-O/node_modules/.bin/tsx --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/context-regression.test.ts /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime-llm.test.ts`：40/40 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。

## 2026-05-29 — P0 非 DeepSeek：指令边界 regression corpus

- **用户决策**: 认可优先补齐短纠错、取消后追问、多路径比较的 P0 regression corpus，继续暂缓 DeepSeek 适配。
- **处理**:
  - `context-regression.test.ts` 新增 `REQUEST_TIMEOUT` 后状态追问回归，覆盖超时后“你现在在干什么？”必须从 recovery boundary 开始。
  - 新增短纠错回归：`不是这个，是 /Users/.../BabeL-X` 必须识别为 `correction` + `prioritize_latest`，同时保留旧上下文作为背景。
  - 新增多路径比较回归：同一请求中的 BabeL-O 与 BabeL-X 两个显式路径必须同时保留为最新 focus，不被旧 Baidu 上下文锚偏。
  - 修复 `selectRecentEvents()` recovery code 识别：除 `REQUEST_CANCELLED` 和旧 `EXECUTION_TIMEOUT` 外，也识别 runtime 实际产出的 `REQUEST_TIMEOUT`。
  - 扩展短纠错识别：覆盖“不是这个，是 X”这类中文短句。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json /Users/tangyaoyue/DEV/BABEL/BabeL-O/node_modules/.bin/tsx --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/context-regression.test.ts`：6/6 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json /Users/tangyaoyue/DEV/BABEL/BabeL-O/node_modules/.bin/tsx --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/context-assembler.test.ts /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime-llm.test.ts`：63/63 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。

## 2026-05-29 — P0 非 DeepSeek：User Intake Guidance 硬归一化

- **问题**: `user_intake_guidance` 主路径仍信任 intake 模型 JSON。如果模型输出 `intent=pause/status/greeting` 但同时给出 `actionHint=normal`、`requiresTools=true`，runtime 会向主 provider 暴露工具，存在短暂停/状态追问继续旧工具链的风险。
- **处理**:
  - `intentGuidance.ts` 新增 policy normalization：`pause`、`greeting`、`status` 强制归一化为 `actionHint=respond_only`、`requiresTools=false`；`pause` 同时收敛到 `contextScope=recent`。
  - `toUserIntakeGuidanceEvent()`、`guidanceFromIntakeEvent()`、`buildGuidance()` 和 `shouldSuppressToolsForIntent()` 均走同一归一化路径，确保持久事件、context 注入和 runtime tool suppression 一致。
- **测试覆盖**:
  - `runtime-llm.test.ts` 新增 contradictory pause intake 回归：mock intake 返回 `pause + normal + requiresTools=true`，断言持久事件被归一化，主 provider 请求不包含 tools。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json /Users/tangyaoyue/DEV/BABEL/BabeL-O/node_modules/.bin/tsx --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime-llm.test.ts`：31/31 通过。

## 2026-05-29 — P0 非 DeepSeek：工具循环 final-response-only 硬约束

- **用户决策**: 继续推进 P0，但暂时不处理 DeepSeek 模型适配问题。
- **问题**: 旧 `LLMCodingRuntime` 只在 Execution State 中提示 `must_respond`，如果模型忽略提示继续请求工具，runtime 仍会暴露工具并执行，直到 `MAX_LOOPS_EXCEEDED`。
- **处理**:
  - 新增 final-response-only 尾部阶段：接近 `maxLoops` 时主 provider 请求不再暴露 tools。
  - 若 provider 在 final-response-only 阶段仍输出工具调用，runtime 产出 `TOOL_LOOP_FINAL_RESPONSE_ONLY` error，拒绝执行这些工具，并追加无工具最终回答提示让模型合成答案。
  - `buildExecutionState()` 的 must-respond 文案改为明确 runtime 已隐藏工具，不再仅是软提示。
- **测试覆盖**:
  - `runtime-llm.test.ts` 新增模型持续请求 `Read` 的失控循环回归，验证 final-response-only 阶段没有执行新工具、provider 请求不含 tools，且最终成功产出 answer。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json /Users/tangyaoyue/DEV/BABEL/BabeL-O/node_modules/.bin/tsx --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime-llm.test.ts`：30/30 通过。

## 2026-05-29 — runtime-llm 测试配置隔离

- **问题**: `runtime-llm.test.ts` 在本机存在 `BABEL_O_BASE_URL` / provider baseUrl 等环境变量时，会覆盖测试临时 config，导致 Anthropic baseUrl 断言被 Baidu OneAPI 配置污染。
- **处理**:
  - 在 `runtime-llm.test.ts` 增加 provider/config 环境变量 snapshot、clear 和 restore helper。
  - `ConfigManager` 与 `LLMCodingRuntime` test suite 的 `beforeEach` 清理 `BABEL_O_*`、`ANTHROPIC_*`、`OPENAI_*`、`DEEPSEEK_*`、`ZHIPU*`、`MINIMAX*` 相关变量，`afterEach` 恢复原环境。
  - 保留单测内部主动设置 env 的断言场景，避免改变配置优先级语义。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json /Users/tangyaoyue/DEV/BABEL/BabeL-O/node_modules/.bin/tsx --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime-llm.test.ts`：29/29 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json /Users/tangyaoyue/DEV/BABEL/BabeL-O/node_modules/.bin/tsx --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/context-assembler.test.ts /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime-llm.test.ts`：61/61 通过。

## 2026-05-29 — Pivot Guard Phase 2.1：User Intake Guidance 事件管线

- **用户决策**: 将 `intentGuidance` 从硬规则分类器升级为轻量 intake 机制：先让模型产出可持久化 `user_intake_guidance` 事件，再让 runtime/agent loop 把该事件作为本轮最高优先级上下文。
- **实现**:
  - `shared/events.ts` 新增 `user_intake_guidance` 事件类型，字段包含 `userText`、`intent`、`confidence`、`continuity`、`contextScope`、`actionHint`、`requiresTools`、`reason`、`guidance`、`explicitPaths` 和 `source=model|fallback`。
  - `intentGuidance.ts` 改为 intake 管线模块：`buildUserIntakeGuidanceEvent()` 调用 provider 进行无工具、低 token 的 intake JSON 生成；解析失败或 provider 失败时回退到本地规则 `deriveFallbackUserIntentGuidance()`。
  - `contextAssembler` 优先读取最新匹配当前用户消息的 `user_intake_guidance`，并注入 `User Intake Guidance` 高优先级 system block；事件身份 hash 覆盖 intake event。
  - `LLMCodingRuntime` 在主 provider 请求前生成并 yield intake event，使外层 storage 正常持久化；主请求的工具列表由 intake 的 `requiresTools` / `actionHint` 决定。
  - token 估算改为使用模型实际可见工具列表，避免 `respond_only` 场景仍把隐藏工具计入 context。
- **测试覆盖**:
  - `runtime-llm.test.ts` 新增 `persists user_intake_guidance and hides tools for respond-only intake`，验证 intake event `source=model`、`requiresTools=false`，并断言主 provider 请求不包含 tools。
  - 既有 context assembler 测试继续覆盖短问候、纠错、session_321c48be 和暂停请求场景。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json /Users/tangyaoyue/DEV/BABEL/BabeL-O/node_modules/.bin/tsx --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime-llm.test.ts`：29/29 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json /Users/tangyaoyue/DEV/BABEL/BabeL-O/node_modules/.bin/tsx --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/context-assembler.test.ts /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime-llm.test.ts`：61/61 通过。
- **剩余项**: 可进一步把 AgentLoop role step 也显式消费 intake event，而不仅通过 runtime context 间接继承；也可为 `/context` UI 增加 intake event 原文展示。

## 2026-05-29 — Pivot Guard Phase 2：用户信息意图引导层

- **用户决策**: 不继续堆叠生硬中文提示词注入，直接进入 Phase 2，用结构化“用户信息意图引导层”替代 hard pivot 截断。
- **实现**:
  - 新增 `src/runtime/intentGuidance.ts`，派生 `continue/new_focus/correction/pause/greeting/status`、`continuity`、`contextScope` 和 `actionHint`。
  - `contextAssembler` 不再因闲聊/暂停/纠错/绝对路径在 `selectRecentEvents()` 中硬截断 recent events，而是保留最近上下文并返回 `userIntentGuidance`。
  - `systemPromptBuilder` 在高优先级动态段注入 `User Intent Guidance`，让最新用户意图成为后续动作的显式决策输入。
  - `LLMCodingRuntime` 对 `actionHint=respond_only` 的问候、状态、暂停请求不向 provider 暴露工具，防止用户说停或短问候时继续旧工具链。
  - `/context` 诊断经 `contextAnalysis` 暴露 `userIntentGuidance`，便于复盘当前意图判断。
- **回归覆盖**:
  - session_321c48be 的 `hi`` 场景：短问候不再丢弃 Baidu 上下文。
  - 暂停请求：`just stop it and waite for me other require` 会得到 `respond_only` 指引。
  - 旧 hard-pivot 测试已改为验证 guidance 注入、上下文保留和 `actionHint`。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `/Users/tangyaoyue/DEV/BABEL/BabeL-O/node_modules/.bin/tsx --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/context-assembler.test.ts`：32/32 通过。
  - 合并运行 `context-assembler.test.ts` + `runtime-llm.test.ts` 时 58/60 通过，2 个失败为本机 provider baseUrl 配置污染（Anthropic 期望 URL 与本机 Baidu OneAPI baseUrl 冲突），与本次改动无关。
- **剩余项**: 可补一个 runtime 级测试，直接断言 `respond_only` 时 provider query 收到 `tools: []`；DeepSeek reasoning replay 仍是独立 P0/P2 待办。

## 2026-05-29 — Pivot Guard P0 提升与深度缺陷分析

- **问题**: `shouldStartFromLatestUserPrompt` 的闲聊/路径触发路径导致不可逆上下文丢失。
- **复现**: session_321c48be Turn 8 用户输入 `hi`` 误触闲聊 pivot，丢弃 Turn 6-7 的 Baidu 分析上下文（30+ 条工具调用事件），导致模型重复执行 `ls /Users/tangyaoyue/DEV/Baidu`。
- **处理**:
  - 将 TODO_runtime.md 中 "P2: Prompt Intent Classifier / Pivot Guard 扩展" 提升为 **P0**，重写为 "P0: Pivot Guard 重建——闲聊/路径误触导致不可逆上下文丢失"。
  - 新增 "P0 Pivot Guard 缺陷专项" 章节，包含 7 个子节：定义与作用、当前触发条件、核心缺陷、各触发路径风险评估、与其他上下文机制的交互缺陷、修复方案（Phase 1-3）、验证命令。
  - 更新 TODO.md 总控 P0 收口标准，补充 Pivot Guard 缺陷描述。
- **关键发现**:
  1. Pivot 是全有全无操作：触发后旧事件不进 summary、不进 retainedEvents、不进 PostCompactState，完全从 LLM 视野消失。
  2. 闲聊路径（`hi/你好`）在长对话中误触概率高，且丢失的上下文无法恢复。
  3. 路径路径（`extractAbsolutePaths > 0`）过于激进：同项目内引用路径也会触发 pivot。
  4. 暂停路径只影响上下文选择，不影响 runtime 工具循环——用户说"停"但模型不停。
  5. Pivot 旁路了 Recovery Boundary 和 `recentTurnLimit` 预算。
  6. Pivot 后的 omitted events 只生成统计摘要，不生成 LLM 结构化摘要。
- **验证**: 本次为文档更新和缺陷分析，没有执行代码修改。

## 2026-05-29 — TODO 口径重整与主线收束

- **工作项**: 重新梳理 `docs/nexus` 的总控与专项 TODO 口径，清理混在一起的阶段状态、已完成项、验证项和长期规划。
- **处理结果**:
  - 将 `docs/nexus/TODO.md` 收敛为更短的总控路线板，只保留口径、当前优先级、主线状态、文档索引、底线与维护规则。
  - 在 `TODO_runtime.md` 中补入最新会话暴露的两项待办：`Prompt Intent Classifier / Pivot Guard` 扩展，以及 DeepSeek `reasoning_content` replay 兼容。
  - 将 `TODO_agents.md` 中已落地的 sub-agent lifecycle / transcript / inheritance / worktree notice / output contract 口径标为完成，保留非 dry-run smoke 与少量验证项。
  - 将 `TODO_tui.md` 中已实现的输入框唯一 owner、slash/tool palette 互斥、agent running indicator、permission panel 键盘路径口径整理为完成，并将仍需真实 PTY / 截图 smoke 的项回调为待验证。
- **验证**: 本次为文档口径整理，没有执行代码或测试。

## 0.99 2026-05-28~29 指令跟随性问题分析与执行控制增强

- **问题**: session_968feb69 和后续会话暴露严重指令跟随性问题：模型重复读取同一文件 3 次、用户说"等一下"后继续执行 23 次工具调用、单 turn token 从 2.9K 爆炸到 103K。
- **根因分析**:
  - LLMCodingRuntime 的 while 循环是无约束的 tool-call 循环，模型缺少做出合理决策所需的结构化信息
  - 模型不知道当前迭代次数、已读文件列表、token 使用量、当前阶段
  - 对比 BabeL-X：也没有模型可见的执行状态注入，但有跨 turn 持久化的文件读取缓存和结构化的 compaction 后状态恢复
- **实施**:
  1. **执行状态注入** (`LLMCodingRuntime.ts`): 每次 provider call 前注入 `## Execution State` 到 systemPromptBlocks，包含 iteration/maxLoops、已读文件列表、tool calls 计数、context token 使用百分比、当前阶段（gathering/synthesize/must_respond）
  2. **跨 turn 文件读取缓存** (`LLMCodingRuntime.ts`): `readFileCache: Map<string, {mtime, size}>` 提升到实例级别，Read 工具执行前检查 mtime，未变则返回 stub
  3. **Compaction 后文件内容恢复** (`contextAssembler.ts`): `PostCompactState.restoredFileContents` 恢复最多 5 个文件内容（≤5000 chars），`buildCompactCapabilityReminder` 不再鼓励重新读取
  4. **系统 prompt 强化** (`systemPromptBuilder.ts`): No-Repetition 规则升级为 MANDATORY，新增 Analysis budget 规则
- **验证**: typecheck 通过，261 tests 259 pass（2 个预先存在的 URL 配置失败）
- **未解决**: 指令跟随性问题仍然存在。可能的根因：
  - 服务未重启加载新代码
  - 模型本身能力限制（DeepSeek 对 system prompt 指令的遵循度不如 Claude）
  - execution state 注入的信息量不足以改变模型行为
  - 需要更强的运行时强制机制（如硬限制工具调用次数、强制在 N 次后停止循环）而非仅依赖模型自觉
- **待评估**: 部署新代码后实测效果；如果仍然无效，可能需要从"给模型信息让它自己决策"转向"runtime 强制执行策略"（如分析任务硬限 10 次工具调用后强制输出）

## 0.98 2026-05-28 Tier 0-3 代码缺陷修复与架构去重

- **背景**: 基于完整源码审查与 TODO 文档交叉比对，确认 4 个 Tier 0 代码缺陷、P0 预算问题、多处代码重复和 Agent 可靠性问题。
- **Tier 0 — 代码缺陷修复**:
  - `edit.ts`: 添加 occurrences 计数，多匹配时拒绝替换（正确性底线）。
  - `glob.ts`: 引入 minimatch 依赖，使用 `rg --glob` + minimatch fallback 替代旧的子串匹配。`**/*.js` 不再匹配 `.json`。无 glob 元字符时自动包装为 `**/*{pattern}*` 保持向后兼容。
  - `app.ts`: 9 个路由处理器从 plain object 返回改为 `reply.code(404).send(...)`，修复 HTTP 200 返回错误的问题。
  - `task.ts`: TaskCreate 工具接入完整 NexusTask 持久化（ToolContext 增加 storage 字段，两个 runtime 传递）。
- **Tier 1 — P0 工具结果持久化与消息级预算**:
  - 新建 `src/runtime/toolResultBudget.ts`：层 1 `replaceLargeToolResult`（单条 >50K 持久化为预览）+ 层 2 `enforceMessageBudget`（跨轮聚合预算 200K，re-apply 已替换结果）。
  - 集成到 `LLMCodingRuntime.ts`：移除旧 per-turn 预算逻辑，替换为两层预算。
  - 预期效果：多轮 provider call input tokens 减少 50-59%。
  - 新建 `test/tool-result-budget.test.ts`（9 个测试全部通过）。
- **Tier 2 — 运行时去重**:
  - 新建 `src/runtime/toolExecutor.ts`：提取 `executeToolSafely` + `normalizeToolErrorDetails`，两个 runtime 共享。支持可选 per-tool timeout。
  - `app.ts`：提取 `prepareExecution`、`recordEventMetrics`、`persistEventMetrics`，POST /v1/execute 和 GET /v1/stream 共享 ~115 行验证/session/metrics 逻辑。
  - `agentLoop.ts`：移除重复的 `runGitCommand` 和 `parsePorcelainChangedPaths`，改为从 `worktree.ts` 导入。
  - 关键空 catch 块添加 `logger.debug`（LLMCodingRuntime、compactSummary）。
- **Tier 3 — Agent 可靠性**:
  - `taskQueue.ts`：新增 `propagateFailures` 函数，依赖 failed 时级联标记下游任务为 failed，防止死锁。
  - `runtimeAgentStep.ts`：repair 尝试添加 `logger.debug` 日志；`zodToJsonSchemaShape` 对 ZodUnknown/ZodAny/fallback 返回 `{ type: 'object' }` 而非 `{}`。
- **验证**:
  - `npm run typecheck` 通过。
  - `npm test`（含新增 test/tool-result-budget.test.ts）：261 tests, 259 pass, 2 fail（预先存在的本地 URL 配置问题，与本次改动无关）。
- **新增文件**: `src/runtime/toolResultBudget.ts`, `src/runtime/toolExecutor.ts`, `test/tool-result-budget.test.ts`
- **新增依赖**: `minimatch`
- **修改文件**: `edit.ts`, `glob.ts`, `task.ts`, `Tool.ts`, `Runtime.ts`, `LLMCodingRuntime.ts`, `LocalCodingRuntime.ts`, `app.ts`, `worktree.ts`, `agentLoop.ts`, `taskQueue.ts`, `runtimeAgentStep.ts`, `compactSummary.ts`, `tool-trace.test.ts`

## 0.97 2026-05-27 TODO 总控口径重整

- **用户请求**: 重新梳理当前 TODO 文档，解决总控 TODO 混乱问题。
- **核实**:
  - `docs/nexus/TODO.md` 同时包含阶段表、当前优先级、真实会话复盘、已完成长清单和工作日志式记录，和 `WORK_LOG.md`、专项 TODO 重复。
  - 子 TODO 中仍有少量指向已删除根目录文档的旧引用，例如 `docs/RECOMMENDATIONS.md` 和 `docs/ARCHITECTURE.md`。
- **处理**:
  - 将 `docs/nexus/TODO.md` 重写为 71 行路线板，只保留：口径、当前优先级、主线状态、文档索引、必须守住的底线和维护规则。
  - 将 P0/P1/P2 任务细节保留在对应专项 TODO，避免总控与专项重复维护。
  - 将 `TODO_runtime.md` 和 `TODO_cleanup.md` 中的旧根目录文档引用改为“已合并的 BabeL-X 迁移结论”或 `docs/nexus/README.md`。
- **验证**:
  - `wc -l docs/nexus/TODO.md` 确认总控从 270 行收敛到 71 行。
  - `rg` 检查 `docs/nexus` 中不再存在指向已删除根目录文档的链接。
  - `git diff --check -- docs/nexus/TODO.md docs/nexus/TODO_runtime.md docs/nexus/TODO_cleanup.md` 通过。

## 0.96 2026-05-27 docs/nexus 文档口径收敛

- **用户请求**: 清除/更新 `docs` 中所有文档，删除过时文档，并将所有文档内容更新到最核心的 `docs/nexus` 目录中。
- **核实**:
  - `docs` 根目录仍残留 `ARCHITECTURE.md`、`PLAN.md`、`RECOMMENDATIONS.md`、`implementation_plan.md`、`task.md`、`walkthrough.md`、多个 BabeL-O 历史分析/调优文档和 `.DS_Store`。
  - 这些文档大多是一次性审计、历史实施计划或已被 `docs/nexus/TODO.md` / `WORK_LOG.md` 吸收的旧口径，继续保留会让后续开发误读当前状态。
- **处理**:
  - 重写 `docs/nexus/README.md` 为唯一文档入口，补充 Nexus-first 原则、架构分层、文档索引、当前实现状态、历史文档合并口径和维护规则。
  - 更新 `docs/nexus/TODO.md`，移除对根目录 `RECOMMENDATIONS.md` 的权威引用，新增 Docs Canonicalization 口径。
  - 更新根 `README.md` 的项目树和 Related Documentation，只指向 `docs/nexus/*`。
  - 删除根目录过时 Markdown 文档与 `.DS_Store`，保留 `docs/nexus` 作为唯一长期文档目录。
- **验证**:
  - `find docs -maxdepth 2 -type f | sort` 确认只剩 `docs/nexus` 下文档。
  - `rg` 检查根 README 与 docs 中不再存在旧文档链接。
  - `git diff --check -- README.md docs` 通过。

## 0.95 2026-05-27 session_e9fa6e3a 纠错轮项目目标丢失修复

- **用户请求**: 查看 `session_e9fa6e3a-90c3-4bf9-afa7-c4c1b42d3be9` 最新会话，继续调用日志深入分析模型指路跟随问题。
- **日志核实**:
  - 会话共 52 次工具调用、4 条 `user_message`。前两轮分别分析 `/Users/tangyaoyue/DEV/Baidu` 与 `/Users/tangyaoyue/DEV/BABEL/BabeL-O`。
  - 第 3 轮用户明确输入 `/Users/tangyaoyue/DEV/BABEL/BabeL-X查看这个项目`，`session_started.cwd` 已正确切到 `/Users/tangyaoyue/DEV/BABEL/BabeL-X`，但模型仍尝试读取 BabeL-O 并被 workspace guard 拦截。
  - 第 4 轮用户纠正“呃让你分析的就是babel-X项目”，本轮 `session_started.cwd` 却回到了 `/Users/tangyaoyue`，随后工具成功读取 BabeL-O 和 Baidu/KeDU 文档，最终结果仍是“BabeL-O 作为动态百科服务平台服务内核”的分析。
- **根因**:
  - `LLMCodingRuntime.resolveCwdFromPrompt()` 能在含显式路径的本轮内部切换 cwd，并发出正确的 `session_started.cwd`，但 `SessionSnapshot.cwd` 没有根据 `session_started` 写回。
  - CLI/service 下一轮如果用户输入没有显式绝对路径，会继续使用启动时的默认 cwd（如 `/Users/tangyaoyue`），而不是上一轮真实项目 cwd。
  - `selectRecentEvents()` 对“我说的是 X / 让你分析的就是 X / 不是 A 是 B”这类纠错句没有 pivot 保护，旧 BabeL-O 分析仍进入 provider live messages。
- **修复**:
  - `MemoryStorage` 与 `SqliteStorage.appendEvent()` 在收到 `session_started` 事件时写回 `session.cwd = event.cwd`，让运行时解析出的真实项目成为持久会话状态。
  - `app.ts` HTTP/WebSocket 入口增加 `resolveRequestCwd()`：存在真实目录型显式路径时切换到该目录；后续无显式路径的同 session 输入继承 `session.cwd`；保留文件路径由 Read/Write/Edit 自己做 workspace safety，避免把 `/tmp/file` 自动提升成新 workspace。
  - `runSessionFlow.ts` embedded CLI 使用同样的 cwd 继承/目录型显式路径规则，并把 UserPromptSubmit hook 的 cwd 改成有效 cwd。
  - `contextAssembler` 增加 correction pivot：覆盖“让你/要你/我说的/说的是/分析的就是/不是 A 是 B/i mean”等纠错短句，只保留最新用户意图，避免旧工具链锚定。
- **测试覆盖**:
  - `assembleContext treats user correction prompts as a new pivot`。
  - `/v1/execute persists resolved cwd and reuses it for correction turns`。
  - 既有 `Read returns a recoverable tool result for workspace escape paths` 验证文件路径不会被入口层误提升为 workspace。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/context-assembler.test.ts test/runtime.test.ts test/runtime-llm.test.ts test/context-regression.test.ts`：98/98 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsc --noEmit` 通过。

## 0.94 2026-05-27 session_b4fd19a4 多项目切换下 Bash CWD 污染修复

- **用户请求**: 查看最新会话 `session_b4fd19a4-97cb-4210-8dfe-44d1dfd00805`，调用日志继续深入分析模型指路跟随问题。
- **日志核实**:
  - 最新会话共 66 次 `tool_started`、64 次 `tool_completed`、6 条 `user_message`；初始请求仍为 `/Users/tangyaoyue/DEV/Baidu查看这个文件夹中的项目内容`。
  - 后续用户明确输入 `/Users/tangyaoyue/DEV/BABEL/BabeL-X` 和 `/Users/tangyaoyue/DEV/BABEL/BabeL-X查看这个项目`，`session_started.cwd` 已正确切到 `/Users/tangyaoyue/DEV/BABEL/BabeL-X`。
  - 但工具调用仍多次访问 `/Users/tangyaoyue/DEV/BABEL/BabeL-O` 和 `/Users/tangyaoyue/DEV/Baidu/...`。Glob/Read 能返回 `WORKSPACE_PATH_ESCAPE`，Bash 也能返回 recoverable escape；不过部分 Bash escape 的 `Current workspace` 仍显示 `/Users/tangyaoyue/DEV/Baidu`，说明 Bash 内部 retained CWD 没有随新请求 workspace 切换。
  - 最终 result 仍回答 BabeL-O/动态百科服务平台运行时适配，而不是用户最新要求的 BabeL-X 项目查看，证明同 session 多项目切换时仍存在路径锚定污染。
- **根因**:
  - `bash.ts` 的 `sessionCwdMap` 用 `sessionId -> cwd` 保存 shell `cd` 状态，但它既被用作 shell 当前目录，也被用于 workspace escape preflight。
  - 当同一个 `sessionId` 从 Baidu 切到 BabeL-X 时，`LLMCodingRuntime.resolveCwdFromPrompt()` 已更新 `runtimeOptions.cwd`，但 Bash 仍优先使用旧的 `sessionCwdMap`，导致 workspace guard 基准可能回退到旧项目。
  - 这是工具状态生命周期 bug，不是单纯 prompt 跟随能力问题。
- **修复**:
  - `bash.ts` 新增 `resolveShellCwd(sessionId, workspaceCwd)`：只有 retained shell cwd 仍位于当前 `context.cwd` workspace 内时才复用；一旦越界，立即清除该 session 的 Bash CWD 并回到本轮 `context.cwd`。
  - Bash 命令绝对路径 preflight 改为始终以本轮 `context.cwd` 为 workspace root，而不是以 retained shell cwd 为 root；shell 执行目录仍可在同一 workspace 内保留 `cd` 状态。
  - 新增回归测试 `bash retained CWD resets when the same session switches workspace`，覆盖同 session 先 `cd nested`，再切到另一个 workspace 后 `pwd` 必须落在新 workspace，访问旧 workspace 必须返回 `WORKSPACE_PATH_ESCAPE` 且 `cwd` 指向新 workspace。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/runtime.test.ts`：38/38 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/context-assembler.test.ts test/runtime-llm.test.ts test/context-regression.test.ts`：58/58 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsc --noEmit` 通过。

## 0.93 2026-05-27 session_7b928e48 指令跟随偏移根因分析与修复

- **用户请求**: 查看 `session_7b928e48-e3b4-4326-95c9-f30cb2a554f6` 最新会话和调用日志，继续深入分析模型指路跟随问题。
- **日志核实**:
  - 会话共 2152 个 events，3 条 `user_message`，32 次工具调用；模型为 `deepseek/deepseek-v4-pro`。
  - 第 1 轮用户请求 `/Users/tangyaoyue/DEV/Baidu查看这个文件夹中的项目内容`，模型使用 Bash `ls` + Glob `**/*` 扫描大目录，生成大量 Baidu 工具上下文。
  - 第 2 轮用户请求 `/Users/tangyaoyue/DEV/BABEL/BabeL-O分析能否将这个项目作为动态百科服务平台的服务内核/运行时`。运行时已将 workspace 切到 BabeL-O，Glob 访问 Baidu 被正确返回 `WORKSPACE_PATH_ESCAPE`，但模型随后通过 Bash `cat/ls` 继续读取 `/Users/tangyaoyue/DEV/Baidu`，绕过了 Read/Glob 的 workspace guard，最终仍回答 Baidu 总览而非 BabeL-O 运行时适配分析。
  - 第 3 轮用户只输入 `你好？`，模型仍继续调用 Bash/Glob/Read 分析 Baidu，并在用户 ESC 后产生 `REQUEST_CANCELLED`。这说明普通成功 result 后的短问候/状态追问没有形成新的 context pivot，旧任务工具链仍进入 live messages。
- **根因**:
  1. Bash 工具缺少绝对路径 workspace preflight。Read/Glob 已能阻止 workspace escape，但 Bash 命令中的 `/Users/...` 绝对路径仍可执行。
  2. `selectRecentEvents()` 仅在取消/超时错误后建立 recovery boundary；对 `你好？`、`你现在在干什么？` 等短交互没有 pivot 保护，模型容易继续旧分析。
  3. 最新显式路径虽然通过 `resolveCwdFromPrompt()` 切换了 cwd，但旧 Baidu 大摘要和工具结果仍能在非 pivot 场景中成为注意力锚点。
- **修复**:
  - `contextAssembler.selectRecentEvents()` 新增短问候/状态追问 pivot 识别：`hi/hello/你好/您好/还在吗/你现在在干什么/还记得/知道我在问什么` 等输入只保留最新用户轮次，不再回放旧工具链。
  - `selectRecentEvents()` 对包含显式绝对路径的新用户请求默认从最新用户消息开始；保留 `横向/对比/compare/vs` 场景继续允许使用相关历史作为对比基线。
  - `bash.ts` 新增 Bash 命令绝对路径预检：抽取命令中的绝对路径并调用 `resolveInsideWorkspace()`；若越界，返回 recoverable `WORKSPACE_PATH_ESCAPE` failed tool result，而不是执行命令或抛全局错误。
  - 新增回归测试：`assembleContext treats short greetings and status questions as a new pivot`、`bash absolute paths outside workspace return recoverable workspace escape result`。
- **真实会话回放验证**:
  - 用 `session_7b928...` 真实 events 重建第 3 轮 `你好？` 的 assembled context，修复后 provider messages 仅为 `[{ role: "user", content: "你好？" }]`，`selectedEventCount=1`，不再包含 Baidu 或 tool_use。
- **验证**:
  - `npm run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/context-assembler.test.ts test/runtime.test.ts test/runtime-llm.test.ts test/security.test.ts`：101/101 通过。

## 0.92 2026-05-27 P0 长会话可靠性（session_d61f22d0 实战驱动）

- **用户请求**: "根据文档进一步开发完善" — 基于 `session_d61f22d0` 问题分析文档中识别的 4 项待修复项实施开发。
- **背景**: 真实会话 `session_d61f22d0` 在 7 轮对话中 contextCharsIn 经历 10K→148K→303K→102K→28K→427K→126K 的剧烈波动，136 次工具调用（Bash×41, Glob×21, Read×74）中大量重复读取同一文件。auto-compact 默认关闭，无 compact_boundary/context_warning 事件。
- **实施**:

  1. **P0-1: StreamDelta 新增 FinishDelta + adapter 暴露 stop_reason**
     - `ModelAdapter.ts`: 新增 `FinishReason` 联合类型（`end_turn | max_tokens | stop_sequence | tool_use | pause`）和 `FinishDelta`（`type: 'finish'`）加入 `StreamDelta` 联合类型。
     - `AnthropicAdapter.ts`: 从 `message_delta` SSE 事件的 `delta.stop_reason` 提取并 yield `FinishDelta`。
     - `OpenAIAdapter.ts`: 从 `choices[0].finish_reason` 提取并映射（`stop→end_turn`, `length→max_tokens`, `tool_calls→tool_use`, `content_filter→end_turn`）后 yield `FinishDelta`。

  2. **P0-2: max_tokens 截断检测 + 恢复**
     - `LLMCodingRuntime.ts`: 流解析中捕获 `finish` delta 存入 `currentFinishReason`；流结束后检测 `max_tokens`，注入续写 prompt（"Please continue exactly from where you left off"）让模型从断点继续；最多重试 `MAX_TOKEN_RECOVERIES=3` 次。

  3. **P1-1: 工具结果 per-turn 预算截断**
     - `LLMCodingRuntime.ts`: 工具执行循环新增 `toolResultBudgetChars = maxChars * 30%`；每个工具结果累加字符数到 `toolResultUsedChars`；超限时截断当前结果内容并附加预算溢出提示，设置 `toolBudgetExceeded=true`；后续工具跳过执行并返回 `TURN_BUDGET_EXCEEDED` 错误结果。

  4. **P1-2: 三层 Context Warning 梯度**
     - `tokenEstimator.ts`: `ContextWindowState` 新增 `compactThresholdTokens` 和 `isCompact`；`getContextWindowState()` 新增 `compactPercent` 参数。
     - `LLMCodingRuntime.ts`: warning 阈值从 85% 降至 70%，compact 阈值 85%，blocking ≈99%；warning 消息根据所处区间（`isCompact` / `isWarning`）给出不同文案。
     - `contextAnalysis.ts`: 默认 warningPercent 从 85 更新为 70。
     - `token-estimator.test.ts`: 测试从 2 个断言（warning/blocking）扩展为 4 个（normal/warning/compact/blocking）。

  5. **文档更新**:
     - `docs/BabeL-O_Session_d61f22d0_问题分析.md`: 修正 4 处事实性错误（会话状态、轮次、工具总数、阻塞原因），新增逐轮 contextCharsIn 轨迹表，添加第五节"已实施的修复"。
     - `docs/nexus/TODO.md`: 新增 P0 长会话可靠性阶段条目，问题状态全部标记已完成。

- **涉及文件**: `ModelAdapter.ts`、`AnthropicAdapter.ts`、`OpenAIAdapter.ts`、`LLMCodingRuntime.ts`、`tokenEstimator.ts`、`contextAnalysis.ts`、`token-estimator.test.ts`、`runtime.test.ts`、`compact.ts`、`systemPromptBuilder.ts`、`docs/BabeL-O_Session_d61f22d0_问题分析.md`、`docs/nexus/TODO.md`。
- **验证**:
  - `npx tsc --noEmit` 零错误通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/*.test.ts`：242/244 通过（2 个 pre-existing ConfigManager 泄漏失败不变）。

## 0.91 2026-05-27 P2 上下文恢复能力推进：Session Memory Lite / Preserved Segment / Provider Recovery / Regression Corpus

- **用户请求**: 根据 TODO 中 P2 上下文能力继续稳步推进：Session Memory Lite、Preserved Segment / Resume Verification、Model Fallback / Max Output Recovery、Context Regression Corpus。
- **实现**:
  - `compact_boundary.retainedSegment` 增加 retained count、boundary anchor、first/last event identity 和 hash。`eventIdentity()` 升级为包含 `type/sessionId/timestamp/eventId/toolUseId/content fingerprint`，避免 deep clone 或内容漂移后误判 retained tail 完整。
  - `contextAssembler` 恢复 compact boundary 时验证 retained segment；校验失败时不静默使用断裂 retained tail，而是回退完整历史，并在 `Session Summary` 注入 `Preserved Segment Warning`。`/context` 诊断新增 retained check/warn 展示。
  - 新增 `src/runtime/sessionMemoryLite.ts`：仅在 `BABEL_O_SESSION_MEMORY_LITE=1` 时，compact 成功后写入 `.babel-o/session-memory.md`，并追加 `session_memory_updated` 审计事件；该文件不进入主 context/read cache，保持 opt-in 和固定路径受限写入。
  - 新增 `src/runtime/providerRecovery.ts`：把 provider error 分类为 `ESCALATED_MAX_TOKENS`、`ESCALATED_CONTEXT_WINDOW`、`RETRY_PROVIDER_RATE_LIMIT`、`PROVIDER_AUTH_OR_BILLING`、`RETRY_PROVIDER_UNAVAILABLE` 等，写入 error `details`；TUI error 行会展示 recovery/kind/status 和建议动作。当前只做诊断层，不自动切换 fallback model。
  - 新增 `test/context-regression.test.ts` 与 `test/provider-recovery.test.ts`，固化 workspace escape 后继续、cancel 后继续、provider empty response、invalid tool input/schema failure、max output/context window/billing provider error 等回归样本。
- **涉及文件**: `src/shared/events.ts`、`src/runtime/contextAssembler.ts`、`src/runtime/compact.ts`、`src/runtime/sessionMemoryLite.ts`、`src/runtime/providerRecovery.ts`、`src/runtime/LLMCodingRuntime.ts`、`src/runtime/sessionSummary.ts`、`src/cli/renderEvents.ts`、`src/cli/commands/chat.ts`、`test/context-assembler.test.ts`、`test/context-regression.test.ts`、`test/provider-recovery.test.ts`、`package.json`。
- **验证**:
  - `npm run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/context-assembler.test.ts test/context-regression.test.ts test/provider-recovery.test.ts test/tui-renderer.test.ts`：45/45 通过。

## 0.90 2026-05-26 P0 上下文补齐：AGENT.md 自动发现 + Git 状态注入

- **用户请求**: 推进 P0 优先级任务：AGENT.md 自动发现与注入、Git 状态上下文收集。
- **背景**: `systemPromptBuilder.ts` 接口已完整支持 `agentMdContent` 和 `gitStatus` 参数，但 `contextAssembler.ts` 实际调用时未传入数据——这两个信息通道虽已铺设但未接通。`BabeL-O_调优规划_v1.0.md` Phase 4 任务 4.1 和 4.2 描述了实现方案。
- **实现**:
  - 新建 `src/runtime/agentMdLoader.ts`（54 行）：从 cwd 向上遍历到根目录收集所有 `AGENTS.md`，检查 `.babel-o/AGENTS.md`，去重，8,000 字符上限。参照 `memory.ts` 的加载模式。
  - 新建 `src/runtime/gitContext.ts`（88 行）：`rev-parse --git-dir` 检测 git 仓库，`branch --show-current` 获取分支（含 detached HEAD 处理），`status --short` 获取变更状态（带文件数统计），`log -5 --oneline` 获取最近提交。所有 git 命令使用 `execFile`（零 shell 注入风险），5s 超时，非 git 仓库返回空字符串。
  - 修改 `src/runtime/contextAssembler.ts`：将 `loadProjectMemory` 升级为 `Promise.all([loadProjectMemory, loadAgentMdFiles, collectGitContext])` 并行加载；`buildSystemPromptSections` 调用新增 `agentMdContent` 和 `gitStatus` 参数传入。
- **涉及文件**: `agentMdLoader.ts`（新建）、`gitContext.ts`（新建）、`contextAssembler.ts`（修改）。
- **验证**:
  - `npm run typecheck`：零新增错误（pre-existing 3 个错误来自 `compact.ts` 和 `context-assembler.test.ts`，与本次改动无关）。
  - 单元测试 30/30 通过：`test/system-prompt-builder.test.ts`（16）、`test/tool-prompt.test.ts`（2）、`test/message-normalizer.test.ts`（6）、`test/retry.test.ts`（6）。
  - 手工验证：`gitContext.ts` 在 BabeL-O 项目正确输出分支（main）、58 个变更文件、5 个最近提交；`agentMdLoader.ts` 在无 AGENTS.md 项目正确返回空字符串。

## 0.89 2026-05-26 LLM 语义摘要升级

- **用户请求**: 将会话摘要从纯统计拼接升级为 LLM 生成的结构化语义摘要（参考 BabeL-X 的 compact prompt.ts 实现）。
- **问题**: `summarizeSessionEvents()` 只输出统计数字（事件数、工具名、文件引用），完全不包含语义信息。模型拿到这样的摘要无法理解之前发生了什么。
- **BabeL-X 对比**: BabeL-X 调用 Claude 生成 9 段结构化摘要（用户意图、技术概念、文件代码、错误修复、问题解决、用户消息、待完成任务、当前工作、下一步），使用 `<analysis>` 思考块 + `<summary>` 输出块。
- **实现**:
  - 新建 `src/runtime/compactSummary.ts`：`queryModelText()` 流式文本收集器、`buildCompactUserPrompt()` 9 段 prompt 模板、`formatCompactSummary()` 解析 `<analysis>/<summary>` 块、`llmSummarizeEvents()` 主编排函数（LLM 优先 + 统计 fallback）。
  - `compact.ts`：`CompactSessionOptions` 新增 `mapEventsToMessages` 和 `initialPrompt`，`compactSession()` 当有 mapFn 时调用 `llmSummarizeEvents()`。
  - `LLMCodingRuntime.ts`：auto compact 和 reactive compact 两个调用点传递 `mapEventsToMessages` 和 `initialPrompt`。
  - `systemPromptBuilder.ts`：移除 `Session Summary:\n` 前缀，LLM 摘要自带 `Summary:` header。
  - `contextAssembler.ts`：summary 层预算从 2000 提升至 4000 tokens，fixedBudget 从 9000 提升至 11000。
- **涉及文件**: `compactSummary.ts`（新建）、`compact.ts`、`LLMCodingRuntime.ts`、`systemPromptBuilder.ts`、`contextAssembler.ts`、`compact-summary.test.ts`（新建）、`context-assembler.test.ts`。
- **测试**: 初始记录为 240/242 通过，但复核发现 `compact-summary.test.ts` 未纳入 `package.json` 的 `npm test` 脚本，且测试数量口径已过期。已修正测试脚本并重新验证：`npm run typecheck` 通过；`BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/runtime.test.ts test/compact-summary.test.ts` 46/46 通过；`npm test` 239/239 通过。

## 0.88 2026-05-26 Session 0c03 深度根因分析与结构性修复

- **用户请求**: "真的只是提示词导致的问题吗，需要你继续深入分析研究" — 要求超越 prompt 工程，从结构层面分析 DeepSeek v4-pro 指令跟随失效的根因。
- **Session 0c03 复盘**: 用户在第 3 轮请求"分析改进的地方"时，模型执行了 `npx vite --host`（启动项目），与用户意图完全相反。第 2 轮用户请求"启动项目"，模型正确执行了 vite start。
- **5 层非 Prompt 根因**:
  1. **`mapEventsToMessages` 不区分轮次边界的 assistant 文本**: 第 2 轮的 "项目已启动成功" assistant_delta 文本完整保留到第 3 轮的上下文，成为 attention 锚点，导致模型倾向延续"启动"动作。
  2. **`selectRecentEvents(recentTurnLimit=4)` 包含全部 4 轮**: 第 2 轮的完整工具调用链 + assistant 文本占据上下文主导地位。
  3. **`defaultMaxTokens: 8192` 不鼓励深度分析**: 模型可能因为输出 token 限制而偏好快速动作（启动命令）而非多文件阅读分析。
  4. **无轮次切换检测机制**: 系统无法识别用户从"启动项目"到"分析改进"的意图切换。
  5. **旧轮次 `tool_completed` 输出创建强关联**: vite 启动输出在上下文中形成"运行 vite"的模式关联。
- **结构性修复**:
  - 实现 `microcompactEvents()`: 按轮次边界（最后一条 `user_message`）区分 prior-turn 和 current-turn 事件。Prior-turn 的 `assistant_delta` 文本截断至 `microcompactInternalTextChars`（~1000 字符），`tool_completed` 输出使用更紧凑的 `snipPriorTurnToolOutputChars` 配额。
  - 实现 `protectToolPairs()`: 确保 `tool_started`/`tool_completed` 配对在事件选择后保持完整。
  - 实现 `buildCompactCapabilityReminder()`: compact 后提醒模型可用工具和已读文件。
  - 实现 `enforceDynamicLayerBudgets()` + `applySystemPromptSectionBudgets()`: 动态段（memory/summary/skills）预算控制。
  - `deepseek-v4-pro` 的 `defaultMaxTokens` 从 8192 提升至 16384。
- **上下文流水线**: `selectRecentEvents → protectToolPairs → microcompactEvents → snipEventsWithTurnBoundary → mapEventsToMessages`
- **涉及文件**: `src/runtime/contextAssembler.ts`（5 个函数实现）、`src/providers/registry.ts`（defaultMaxTokens）、`test/context-assembler.test.ts`（预算字段更新）。
- **测试**: 230/232 通过（2 个预存失败来自 ConfigManager 的全局配置泄漏）。

## 0.87 2026-05-26 Session 6694 指令跟随失效根因分析与修复

- **用户请求**: 深入分析 `session_66948496-4454-4300-b7c4-38422090a499` 中用户反复请求"帮我启动项目"但模型始终继续读文件回答平台来源的问题，并修复根因。
- **日志核实**:
  - Session 使用 `deepseek/deepseek-v4-pro`，CWD 为 `/Users/tangyaoyue`。
  - 6 轮对话，42 次工具调用（Read 27、Glob 14、Bash 仅 1 次），用户从第 3 轮开始请求"启动项目"，但模型在第 3-6 轮中持续做文件分析。
  - 到第 3 轮时已有 1666 个事件（756 个来自第 2 轮的文件读取），上下文被旧的"平台分析"工具结果主导。
- **根因分析（3 层）**:
  1. System Prompt 缺少"最新指令优先"和"动作意图识别"规则。
  2. 旧轮次大量工具调用结果使用与当前轮次相同的 snip 配额，挤占上下文空间。
  3. task_guidelines 的 "Read files first" 导致模型对所有请求都先做分析。
- **修复内容**:
  - `system_rules` 新增 "Latest instruction priority" 规则。
  - `task_guidelines` 新增 "Action vs analysis" 规则（启动/运行/execute 等用 Bash 直接执行）。
  - `tool_usage` 新增动作命令指引（"run, start, test, build, or execute → Bash"）。
  - 新增两层 snip 策略：`snipPriorTurnToolOutputChars`（约当前轮次的 1/5），`snipEventsWithTurnBoundary()` 按 `user_message` 边界区分。
- **测试覆盖**: 新增 8 个测试（3 system prompt 规则 + 5 snip compactor），全量 226/228 通过。
- **涉及文件**: `src/runtime/systemPromptBuilder.ts`、`src/runtime/contextAssembler.ts`、`src/runtime/compactors/snipCompactor.ts`、`test/system-prompt-builder.test.ts`、`test/snip-compactor.test.ts`、`test/context-assembler.test.ts`。

## 0.86 2026-05-26 P0 调优推进：System Prompt 工程 / Provider 加固 / 工具容错

- **用户请求**: 根据 `BabeL-O_调优规划_v1.0.md` 和 `BabeL-O_vs_BabeL-X_深度分析_v1.0.md` 交叉核对审计后，实现 Phase 1-3 的 P0 级调优工作。
- **文档修正**:
  - `docs/BabeL-O_调优规划_v1.0.md`：修正 GLM-5.1/GLM-5/MiniMax-M2.7 contextWindow 值（128K→200K），补充 OpenAI adapter max_tokens 差异说明。
  - `docs/BabeL-O_优化建议_v1.0.md`：storageBridge WAL 状态更新为"已完成"，Bash probe 标记名修正为 `__BABEL_O_STATE_`。
- **Phase 1 System Prompt 工程**:
  - 新建 `src/runtime/systemPromptBuilder.ts`：分段式 builder，7 个静态段（identity/system_rules/task_guidelines/tool_usage/risky_actions/tone_style/output_efficiency，cacheable=true）+ 动态段（env_info/request_paths/focus/git_status/agent_md/memory/summary/skills/language，cacheable=false）。导出 `buildSystemPromptSections()`、`sectionsToPromptText()`、`extractAbsolutePaths()`、`resolvePromptPath()`。
  - `ToolDefinition` 新增 `prompt?(): string` 可选方法；Bash/Read/Write/Edit/Glob/Grep/TaskCreate 7 个内置工具全部实现 `prompt()`，返回比 `description` 更详细的工具描述。
  - `LLMCodingRuntime.toolsList()` 优先使用 `prompt()` 替代 `description`。
  - 用户请求从 system prompt 移至 user message（已由 `mapEventsToMessages` 插入）。
  - `contextAssembler.ts` 预算调整：`system: 500→5000`，`fixedBudget: 4500→9000`；新增 `systemPromptBlocks` 字段。
- **Phase 2 Provider 适配层加固**:
  - `src/providers/registry.ts` 新增 `defaultMaxTokens: number`，按模型族设值（claude/gpt-4o/gpt-4-turbo=16384，glm-5.1/minimax-m2.7=16384，glm-5/glm-5-turbo/deepseek-v4=8192，gpt-3.5/deepseek-chat/reasoner=4096）。
  - `AnthropicAdapter` 使用 registry `defaultMaxTokens` 替代硬编码 4096；`OpenAIAdapter` 使用 registry 值，未配置则省略 max_tokens（依赖 provider 默认值）。
  - 新建 `src/providers/retry.ts`：`withRetry()` 通用重试包装器，默认 maxRetries=2、指数退避（baseDelay 1s、maxDelay 15s）、retryableStatuses=[429,500,502,503,529]，429 优先使用 Retry-After header。
  - `AnthropicAdapter` 和 `OpenAIAdapter` 的 fetch 调用包裹在 `withRetry()` 中。
  - 两个 adapter 的 eval 回退移除，替换为 `_parseError` 标记（`{ _parseError: true, _rawInput: buffer.slice(0, 500) }`）。
  - `LLMCodingRuntime` 检测 `_parseError` 标记后产出 `tool_completed(success=false)` + error tool_result，`continue` 继续循环。
  - `ModelAdapter.ts` 新增 `SystemPromptBlock { text, cacheable }` 类型和 `systemPromptBlocks` 字段；`AnthropicAdapter` 按 cacheable 分组为 static block（带 cache_control）+ dynamic block（无 cache_control），实现分段 prompt caching。
- **Phase 3 工具调用容错**:
  - TOOL_NOT_FOUND 从致命 `return` 改为 `continue`，返回包含可用工具列表的 error tool_result。
  - Max Output Recovery：维护 `outputRetryCount`（最大 2 次），空响应注入续写提示而非终止。
  - 新建 `src/runtime/messageNormalizer.ts`：`normalizeMessages()` 收集 tool_use/tool_result ID，移除孤立 tool_result，为孤立 tool_use 补充合成 error tool_result，确保首条消息非 assistant。
  - 每次 provider 调用前 `normalizeMessages(messages)` 规范化 queryParams.messages。
  - 工具执行超时保护：`TOOL_EXECUTION_TIMEOUT_MS = 120_000`，通过 AbortController 在 `executeToolSafely` 中实施。
- **测试覆盖**:
  - `test/system-prompt-builder.test.ts`（13 个测试）：7 个静态段、env_info、不含用户请求、request_paths、focus block、memory/summary/skills/language sections、唯一 ID。
  - `test/tool-prompt.test.ts`（2 个测试）：每个 builtin tool prompt() 非空且长于 description、prompt 内容不同于 description。
  - `test/retry.test.ts`（6 个测试）：首次成功、重试成功、耗尽重试、非 retryable 不重试、非 ProviderError 不重试、多状态码重试。
  - `test/message-normalizer.test.ts`（6 个测试）：正常透传、孤立 tool_use 补充合成结果、孤立 tool_result 移除、配对保留、assistant 首条前置 user、混合场景。
  - 更新 `test/context-assembler.test.ts`：验证用户请求在 messages 中而非 systemPrompt 中。
- **验证**:
  - `npx tsc --noEmit` 成功通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/*.test.ts` 215/217 通过。2 个 pre-existing 失败（`supports profiles switching and resolution` 和 `emits assistant_delta and thinking_delta events during stream execution`）与本次改动无关。
- **涉及文件**:
  - 新建：`src/runtime/systemPromptBuilder.ts`、`src/providers/retry.ts`、`src/runtime/messageNormalizer.ts`、`test/system-prompt-builder.test.ts`、`test/tool-prompt.test.ts`、`test/retry.test.ts`、`test/message-normalizer.test.ts`。
  - 修改：`src/runtime/LLMCodingRuntime.ts`、`src/runtime/contextAssembler.ts`、`src/providers/registry.ts`、`src/providers/adapters/ModelAdapter.ts`、`src/providers/adapters/AnthropicAdapter.ts`、`src/providers/adapters/OpenAIAdapter.ts`、`src/tools/Tool.ts`、`src/tools/builtin/*.ts`（7 个）、`test/context-assembler.test.ts`。
  - 文档：`docs/BabeL-O_调优规划_v1.0.md`、`docs/BabeL-O_优化建议_v1.0.md`。

## 0.85 2026-05-25 Context Analysis API, /context, and Post-Compact State

- **用户请求**: 继续推进 P1：`/context` 诊断命令、Context Analysis API、Post-Compact State Rebuild。
- **实现结果**:
  - 新增 `src/runtime/contextAnalysis.ts`，提供可复用 `analyzeContext()`。该 API 复用 `assembleContext()`、`estimateContextTokens()` 和 `getContextWindowState()`，输出 JSON 序列化结构，包含 token estimate、window state、section chars/counts、compact boundary、postCompactState 与 recommendations。
  - Nexus service 新增 `GET /v1/sessions/:sessionId/context`，service 模式可直接返回同一套 context analysis，避免 CLI 和 Runtime 各自拼估算逻辑。
  - CLI chat 新增 `/context` 命令和 slash palette/help 文案。embedded 模式读取本地 SQLite 后调用同一 `analyzeContext()`；service 模式调用 Nexus API。输出内容包含 session/model/cwd、token/window 阈值、system prompt/project memory/session summary/active skills/messages/tool schemas、compact boundary、Post-Compact State 和建议动作。
  - `RuntimeToolAuditEntry` 增加 `inputSchema`，`LocalCodingRuntime` 与 `LLMCodingRuntime` 的 `listTools()` 会暴露模型可见 tool schema，供 `/context` 与 service API 估算 tool definition overhead。
  - `contextAssembler` 增加轻量 Post-Compact State Rebuild：在 compact boundary 存在时，从 compact 后事件派生最近成功 Read 文件、recent tools、active skills、task/agent status、hook results，并作为 `Post-Compact State` 注入 `Session Summary` / system prompt。该实现保持 Nexus-first，不迁移 BabeL-X 重型 `buildPostCompactMessages`。
- **测试覆盖**:
  - `test/context-assembler.test.ts` 新增 `assembleContext rebuilds lightweight post-compact state` 与 `analyzeContext returns token and compact diagnostics`。
  - `test/runtime.test.ts` 新增 `/v1/sessions/:sessionId/context returns reusable context analysis`。
  - `test/completer.test.ts` 覆盖 `/context` slash 命令、描述和 control command 映射。
- **文档修正**:
  - `docs/nexus/TODO_runtime.md` 将 `/context`、Context Analysis API、Post-Compact State Rebuild 标记为已完成第一版。
  - `docs/nexus/TODO.md` 将上下文能力水位更新为约 BabeL-X 的 75%-80%，后续优先级调整为 Microcompact/API Invariant Guard、System Prompt 分层硬截断、MCP/Skill Delta 重宣布、stable event identity 和 auto-compact fuse 重置。
- **验证**:
  - `npm run typecheck` 成功通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/context-assembler.test.ts test/completer.test.ts test/runtime.test.ts` 成功通过，63/63 全绿。

## 0.84 2026-05-25 Context Token Estimator and Blocking Limit

- **用户请求**: 根据最新 TODO 文档推进 P0：补齐 Context Token Estimator 与 Context Blocking Limit，优先解决中文长会话未及时 compact、provider call 前仍可能触发 `prompt_too_long` 的问题。
- **实现结果**:
  - 新增 `src/runtime/tokenEstimator.ts`，提供 provider-neutral 保守 token estimator。第一版覆盖 CJK、JSON/tool schema、tool_use/tool_result、reasoningContent、thinking/redacted thinking、image/document/server tool block 和 provider tool overhead，并输出 system/messages/tool definitions 分项统计。
  - `LLMCodingRuntime` 改用新 estimator 计算上下文窗口状态，估算范围包含 system prompt、messages 和当前可用 tool definitions，不再使用 `JSON.stringify(messages).length / 4` 作为 provider call 前判断依据。
  - provider call 前新增 blocking guard：超过 warning 阈值产出 `context_warning`；超过 `blockingLimit = maxTokens - safetyBuffer` 时先尝试 `trigger=reactive` compact；compact 后仍超限则产出 `CONTEXT_LIMIT_EXCEEDED`、失败 `result` 和 `execution_metrics`，并阻止继续调用 provider。
  - 工具多轮循环中也会在每次 provider call 前重新估算，避免 tool result 在中途膨胀后继续把明显超限的上下文发给 provider。
  - `scripts/benchmark-performance-core.ts` 新增 `Chinese context token estimator` 子项：构造中文输入、中文输出、代码块、JSON tool result、reasoningContent 和 tool schema。当前实测旧估算 `10229` tokens 不触发 warning，新 estimator `18421` tokens 会触发 warning 与 blocking。
  - `test/token-estimator.test.ts` 增加 estimator 单测；`test/runtime.test.ts` 增加 compact 后仍超限时阻断 provider call 的集成测试；`package.json` 将 token estimator 测试接入全量测试脚本。
- **文档修正**:
  - `docs/nexus/TODO_runtime.md` 将 `P0 Context Token Estimator`、`P0 中文长会话 benchmark`、`P0 Context Blocking Limit` 标记为已完成第一版，保留 System Prompt 分层硬截断、`/context` 诊断、Context Analysis API 和 Post-Compact State Rebuild 等后续项。
  - `docs/nexus/TODO.md` 将当前上下文能力水位更新为约 BabeL-X 的 70%-75%，后续优先级调整为 `/context` 诊断、`analyzeContext()` API、post-compact state rebuild、microcompact/API invariant guard 和 system prompt 分层裁剪。
- **验证**:
  - `npm run typecheck` 成功通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npm test` 成功通过，183/183 全绿。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npm run benchmark` 成功通过，新增 token estimator 子项输出 `legacyWouldWarn=false`、`estimatorWouldWarn=true`、`estimatorWouldBlock=true`。

## 0.83 2026-05-25 Context Capability Gap Rebaseline

- **用户请求**: 继续深入分析 BabeL-O 当前上下文管理与 BabeL-X 的差距，并将“尽可能补齐优化上下文能力”作为首要目标同步到 TODO 文档。
- **分析结论更新**:
  - 旧 `CONTEXT_GAP_ANALYSIS.md` 中“BabeL-O 约为 BabeL-X 40%”“auto-compact boundary 不持久化”“compact 后完全没有 tail”的判断已经过期。
  - 当前代码已具备 persisted `compact_boundary`、`retainedEvents` tail、recovery boundary、显式路径锚定、focus project 和 auto-compact benchmark。
  - 当前差距重估为约 BabeL-X 的 65%-70%，首要缺口转为 token 估算精度、blocking limit、post-compact state rebuild、`/context` 诊断、API invariant guard、Session Memory Lite 和 preserved segment。
- **文档更新**:
  - `docs/nexus/TODO.md` 将“P0 上下文能力补齐”提升为当前首要主线，列出 Context Token Estimator、Context Blocking Limit、`/context` 诊断、Post-Compact State Rebuild、Microcompact/API Invariant Guard、Session Memory Lite、Preserved Segment 和 Model Fallback。
  - `docs/nexus/TODO_runtime.md` 将 Context Compact 已知缺陷改写为可执行任务清单，明确 P0/P1/P2 分层和首批落地文件/测试方向。
  - `docs/nexus/CONTEXT_GAP_ANALYSIS.md` 整体重写为当前工作树口径，明确已完成项、当前能力估计、真实剩余差距和推荐 Phase 1-3 路线。
- **重要决策**:
  - 不直接迁移 BabeL-X 的完整 Session Memory / React UI / attachment message 体系；BabeL-O 继续保持 Nexus-first，先实现 provider-neutral token estimator、runtime-level `analyzeContext()` 和轻量 post-compact state rebuild。
  - `retainedEvents` 是正确的 BabeL-O 化方向，但不能等同于 BabeL-X 的 `messagesToKeep + attachments + hooks` 完整结构化恢复。
- **验证**:
  - 纯文档更新，未运行代码测试。
  - 计划运行 `git diff --check` 验证文档 diff 无空白错误。

## 0.82 2026-05-25 Compact Boundary and Permission Rule Audit Fixes

- **用户请求**: 对用户进一步开发完善后的代码、TODO 和工作记录进行核对，并继续收口未完成项。
- **核对结论**:
  - 用户新增的 context anchor、Glob `path`、hooks、TUI 输入状态、auto-compact benchmark 和文档更新整体方向成立，隔离配置下全量测试可通过。
  - 发现并修复了 3 个需要立即校准的问题：权限 panel Esc 安全回归、session 级 Bash rule 过宽、auto-compact benchmark 未验证持久化恢复。
- **实现修复**:
  - **权限 panel 安全回归**：新增 `Approve with editable rule` 后，Esc 仍选择旧索引 2，会误触发批准。现改为显式 `REJECT_PERMISSION_CHOICE_INDEX = 3`，数字快捷键扩展到 1-5，Esc 始终走 Reject。
  - **session rule 精确匹配**：原 `Approve for session` / editable rule cache 只按工具名命中，`Bash:npm test:*` 会错误批准所有 Bash。现新增 `isSessionPermissionCached()` 与 `matchesPermissionRule()`，Bash rule 只匹配精确前缀，如 `npm test` 或 `npm test ...`，不会批准 `npm install ...`。
  - **auto-compact 持久化验证**：benchmark 和单测改为读取持久化后的 storage events 再 `assembleContext`，不再只看内存返回值。由此暴露 compact boundary 只保存 summary、未保存最近 tail 的问题。
  - **compact boundary retained tail**：`compact_boundary` schema 新增 `retainedEvents`；`compactSession()` 写入 selected recent events；`contextAssembler` 读取最新 boundary 时拼接 `retainedEvents + boundary 后续事件`；重复 compact 会继承上一次 retained tail，避免恢复后最近用户轮次和取消/失败 recovery boundary 丢失。
- **文档修正**:
  - `TODO.md` 将 auto-compact boundary 持久化从 P0 未完成移出，当前 P0 聚焦精确 tokenizer。
  - `TODO_runtime.md` 标记 boundary 持久化与 retained tail 恢复已完成，保留 attachments/hooks/MCP 状态重建、blocking limit、manual compact 熔断重置等真实待办。
  - `TODO_tui.md` 明确状态机/权限 rule 是第一版已落地，同时保留 PTY 键盘路径和截图 smoke。
- **验证**:
  - `npm run typecheck` 成功通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npm test` 成功通过，179/179 全绿。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npm run benchmark` 成功通过，auto-compact 实测 `beforeEventCount=202`、`afterEventCount=7`、reduction 96.53%，最近 2/2 用户轮次保留，recovery boundary 完整。
  - `git diff --check` 成功通过。
- **注意事项**:
  - 直接运行 `npm test` 会读取本机 `~/.babel-o/config.json`，可能触发真实 provider 配置并造成环境性失败；测试验证应继续使用 `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json` 隔离配置。

## 0.81 2026-05-25 Context Anchor and Tool Contract Hardening

- **用户请求**: 深度修复 session `session_a1b20033` 中 Agent 无法按指令继续任务的系统性失效（CWD 漂移、Glob path 被静默忽略、输入退化后上下文丢失、指令理解偏差）。
- **根因分析**:
  1. CWD 漂移：`session_started.cwd` 始终是 `/Users/tangyaoyue`，用户输入 `/Users/.../BabeL-O 查看这个项目` 后 cwd 未切换。
  2. Glob `path` 参数被静默忽略：`glob.ts` 的 `inputSchema` 不含 `path`，Agent 传入后被 Zod strip 丢弃。
  3. 输入退化后上下文丢失：后续输入从完整路径退化为"运行" → "运行这个benchmark脚本"，system prompt 中只有 `workspace: /Users/tangyaoyue`。
  4. 指令理解偏差："运行"被模型误解为"搜索"，Agent 选择 Glob 而非 Bash。
  5. 历史 thinking 污染：旧轮次"未找到 benchmark"的结果被固化为当前轮次的前提假设。
- **实现结果**:
  - **`src/tools/builtin/glob.ts`**：
    - `inputSchema` 增加 `path?: string`。
    - `execute` 中若 `input.path` 存在，用 `resolveInsideWorkspace(context.cwd, input.path)` 解析为绝对路径，作为 `rg --files` 和 `listFilesFallback` 的搜索根目录。
    - `normalizeGlobNeedle` 同步使用新搜索根计算相对路径。
  - **`src/runtime/LLMCodingRuntime.ts`**：
    - 新增 `resolveCwdFromPrompt(prompt, baseCwd)`：提取 prompt 中的绝对路径，按"存在目录 → 返回目录 / 存在文件 → 返回 dirname / 父目录存在 → 返回父目录"的优先级解析，并切换 `options.cwd`。
    - `executeStream` 开头调用 `resolveCwdFromPrompt`，`session_started` 事件同步反映新 cwd。
    - 新增 `buildFocusBlock(options)`：当 prompt 无显式路径且 `cwd` 不是用户主目录时，在 system prompt 中注入 `Current focus project:\n${cwd}`，防止输入退化后上下文丢失。
    - `buildSystemPrompt` Guidelines 新增第 8 条：明确 "run/execute/call a script or command → use Bash; find/search/list files → use Glob or Grep; read file contents → use Read"。
  - **`test/runtime.test.ts`**：新增 `Glob respects custom path parameter` 和 `LLMCodingRuntime resolves cwd from prompt absolute path`。
  - **`test/context-assembler.test.ts`**：新增 `buildSystemPrompt anchors focus project when prompt lacks explicit path`。
- **验证**:
  - `npm run typecheck` 成功通过。
  - `npm test` 全量 178/178 通过（新增 3 个测试）。

## 0.80 2026-05-25 Auto-Compact Benchmark

- **用户请求**: 推进 `TODO_runtime.md` 中 P1 Context Compact UX 的 auto-compact benchmark 项，参考 BabeL-X 实现方法验证长会话 compact 后的规模下降、轮次保留和 recovery boundary 保护。
- **实现结果**:
  - `scripts/benchmark-performance-core.ts` 新增 `benchmarkAutoCompact()`：
    - 构造 40 轮长会话（大量 assistant_delta、thinking_delta、tool_completed 大输出），通过 `compactSession` 执行 auto-compact。
    - 验证规模下降：实测 `beforeEventCount=202` → `afterEventCount=7`，压缩率 96.53%。
    - 验证最近轮次保留：检查后 compact 的 user_message 包含 turn 38 和 39，共 2/2 个最近轮次完整保留。
    - 验证 recovery boundary 保护：构造带 `REQUEST_CANCELLED` + 后续 user_message 的会话，auto-compact 后 `Follow-up after cancellation` 和 `Final question after recovery.` 均未被破坏。
  - 修复原有 `benchmarkContextAssembly` 的 preservedRecentMarkers 断言：原检查 `recent-turn-37/38/39` 三个标记都在 `assembled.messages` 中，但 `recentTurnLimit=2` 只会保留最后 2 轮；修正为检查 `recent-turn-38/39` 在 messages 中（与 `test/context-assembler.test.ts` 的测试口径一致）。
  - `test/context-assembler.test.ts` 新增两个单元测试：
    - `auto compact reduces session size while preserving recent user turns`
    - `auto compact preserves recovery boundary after cancellation or failure`
- **仍保留为后续项**:
  - 暂不迁移 BabeL-X SessionMemory 后台子 Agent；继续等 hooks、子 Agent transcript 和成本控制稳定。
- **验证**:
  - `npm run typecheck` 成功通过。
  - `npm run benchmark` 成功通过；auto-compact 子项产出完整 JSON 结果。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/context-assembler.test.ts` 成功通过，18/18 通过。

## 0.79 2026-05-24 Auto Compact Threshold and Fuse

- **用户请求**: 继续推进 P1 Context Compact UX 中未完成的 auto-compact threshold、compact failure 熔断、manual compact smoke、auto-compact benchmark 和 SessionMemory 迁移评估项。
- **实现结果**:
  - `src/runtime/compact.ts` 新增 auto compact 判定 helper：默认通过 `BABEL_O_AUTO_COMPACT=1|true|yes|on` opt-in 开启，阈值默认 90%，可用 `BABEL_O_AUTO_COMPACT_THRESHOLD_PERCENT` 调整，并限制在 50%-99% 范围内。
  - `LLMCodingRuntime` 在 provider 调用前基于已组装上下文估算 token 用量；超过 warning 阈值会继续产出 `context_warning`，超过 auto threshold 且 opt-in 开启时会生成 `trigger=auto` 的 compact boundary，并重新组装当轮上下文。
  - `compactSession()` 新增 `persist=false` 模式，供 runtime 自动压缩路径只产出事件、由外层既有 storage event 管线统一持久化，避免重复写入。
  - `NexusEventSchema` 新增 `compact_failure`，记录 `trigger`、`modelId`、`failureCount`、`maxFailures`、`message`。
  - 自动压缩连续失败达到 `BABEL_O_AUTO_COMPACT_FAILURE_LIMIT`（默认 2）后打开熔断：runtime 只产出可见 warning，不再每轮重复尝试 auto compact。
  - CLI renderer 新增 `compact_failure` 展示，便于在长会话中直接看到自动压缩失败与熔断原因。
  - 增加手动 compact smoke，覆盖大量 tool output、thinking_delta、provider error、cancel boundary 后，compact 后仍优先回答最新用户问题。
- **仍保留为后续项**:
  - auto-compact benchmark 目前只有阈值/熔断单测与手动 smoke，尚未形成独立 benchmark 脚本或持续性能指标。
  - 暂不迁移 BabeL-X SessionMemory 后台子 Agent，继续等 hooks、子 Agent transcript 和成本控制稳定。
- **验证**:
  - `npm run typecheck` 成功通过。
  - `npx tsx --test --test-concurrency=1 test/context-assembler.test.ts test/tui-renderer.test.ts` 成功通过，28/28 通过。

## 0.78 2026-05-24 Context Compact UX

- **用户请求**: 推进 TODO 中的 P1 Context Compact UX，把 context budget、snip compactor、session summary 和恢复边界变成用户可感知、可控制、可调试的长会话能力。
- **实现结果**:
  - `NexusEventSchema` 新增 `compact_boundary` 与 `context_warning` 事件。`compact_boundary` 记录 `beforeEventCount`、`afterEventCount`、`summaryChars`、`snippedToolResults`、`trigger`、`modelId`、`budget`；`context_warning` 记录估算 token、模型窗口、阈值和提示文案。
  - 新增 `src/runtime/compact.ts`，实现逻辑压缩：不删除 SQLite 历史，只追加 compact boundary event；后续上下文装配通过最新 boundary summary + boundary 后 recent events 运行，避免历史审计数据被破坏。
  - `contextAssembler` 支持读取最新 compact boundary：旧事件不再作为 live messages 回放，也不会和旧 summary 双重计入；boundary 后的新 omitted events 会继续进入 session summary。
  - `LLMCodingRuntime` 在 provider 调用前估算当前上下文用量，超过 85% budget 时产出 `context_warning`，CLI 会提示用户考虑 `/compact`。
  - `bbl chat` 新增 `/compact` 命令；embedded 模式直接压缩本地 SQLite session，service 模式调用新增的 `POST /v1/sessions/:sessionId/compact` API。
  - Slash palette / completion / help 已加入 `/compact`；CLI renderer 能展示 compact boundary 和 context warning。
- **仍保留为后续项**:
  - auto-compact threshold 默认启用策略、compact failure 熔断、auto-compact benchmark 尚未实现；当前交付为手动 compact + warning first。
- **验证**:
  - `npm run typecheck` 成功通过。
  - `npx tsx --test --test-concurrency=1 test/context-assembler.test.ts test/completer.test.ts test/tui-renderer.test.ts` 成功通过，33/33 通过。

## 0.77 2026-05-24 Nexus Hooks 最小内核

- **用户请求**: 根据 TODO 中的 Hooks 生命周期系统开始推进，实现能解决工具调用失败自动修复、权限前置审计、子 Agent 上下文注入和长任务结束清理的最小 hooks 内核。
- **实现结果**:
  - 新增 `src/runtime/hooks.ts`，以 Nexus-owned 方式实现内置 hooks 运行器，第一版支持 `UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`PermissionRequest`、`SubagentStart`、`SubagentStop`、`SessionEnd`。
  - 内置 hooks 目前包含四类可落地行为：`RecoverInvalidToolInputHook`（为 schema 校验失败生成 retry hint）、`BashFailureSummaryHook`（汇总 Bash 失败摘要）、`PermissionExplanationHook`（为权限请求生成解释）、`SessionCleanupAuditHook`（记录 session 结束清理审计）。
  - `NexusEventSchema` 新增 `hook_started`、`hook_completed`、`hook_failed` 三类事件，hook 执行过程可进入 session event 流并被 CLI / storage 观察。
  - `LLMCodingRuntime` 已在 `PreToolUse`、`PermissionRequest`、`PostToolUse`、`PostToolUseFailure` 路径接入 hooks；`INVALID_TOOL_INPUT` 与 Bash 失败会把 hook retry hint 追加回模型可见的 tool result。
  - `LocalCodingRuntime` 也在工具执行、权限请求和失败摘要路径接入 hooks，保证 embedded 本地路径和 LLM runtime 口径一致。
  - `sessionLifecycle.closeNexusSession()` 在关闭 session 时触发 `SessionEnd` hooks，并把 hook 事件追加到 session events。
- **验证**:
  - `npm run typecheck` 成功通过。
  - `npx tsx --test --test-concurrency=1 test/hooks.test.ts` 成功通过，2/2 通过。
  - `npx tsx --test --test-concurrency=1 test/runtime.test.ts --test-name-pattern 'local runtime emits hook events around failed tool execution'` 成功通过。

## 0.76 2026-05-24 Recoverable Invalid Tool Input

- **用户请求**: 查看最新 `Write` 工具调用错误，分析并修复 `INVALID_TOOL_INPUT: expected string, received undefined → at path`。
- **日志核实**:
  - 最新 `session_0f3f9a49-7558-4174-ac35-27c176bc0083` 中，模型发起 `Write` 调用时只传入 `content`，缺少必填 `path`。
  - `Write` 工具 schema 正确要求 `{ path: string, content: string }`；问题在 `LLMCodingRuntime` 将 tool input schema 校验失败升级为全局 `INVALID_TOOL_INPUT` error 后直接终止，模型无法收到 tool result 并自行补齐参数重试。
- **实现结果**:
  - `LLMCodingRuntime` 中 provider 工具循环遇到 `tool.inputSchema.safeParse()` 失败时，不再产出全局 `error` 并结束整轮。
  - 现在会产出 `tool_completed success=false`，output 包含 `code: INVALID_TOOL_INPUT`、可读 schema 错误、原始 input，并把同样信息作为 provider `tool_result isError=true` 回传模型。
  - 这样模型可以继续下一轮，重新发起带完整参数的 `Write` / `Edit` / 其他工具调用，符合“工具调用失败后 Agent 自行决策继续”的目标。
- **验证**:
  - `npm run typecheck` 成功通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/runtime-llm.test.ts` 成功通过，26/26 通过。

## 0.75 2026-05-24 Chat Recovery Context Boundary and Cancellation Semantics

- **用户请求**: 查看最新 `bbl chat` 会话记录，修复用户 ESC/超时后 Agent 不回复当前追问、继续旧任务读文件，以及上下文长任务能力弱的问题。
- **日志核实**:
  - 最新 `session_0b39043f-04a3-49d2-b77e-5d84153d4de7` 中，用户追问 `？你回答我你现在在干什么？？？` 已写入 `last_user_input`。
  - 该 session 之前存在大量 `/Users/tangyaoyue/DEV/BABEL/BabeL-O深入分析这个项目` 的工具调用、thinking 和 Read/Bash 历史；取消/超时后下一轮仍回放这些 live messages，导致模型继续旧的“读 runtimeAgentStep.ts / 跑测试”任务。
  - ESC 取消路径被 runtime 统一标记为 `REQUEST_TIMEOUT`，造成 UI 同时显示 `Execution cancelled by user` 与 `REQUEST_TIMEOUT: Execution timed out while running Bash.`，语义混乱。
- **实现结果**:
  - **恢复边界**：`contextAssembler.selectRecentEvents()` 遇到 `REQUEST_CANCELLED`、`REQUEST_TIMEOUT`、`MAX_LOOPS_EXCEEDED`、`PROVIDER_ERROR`、`EMPTY_PROVIDER_RESPONSE` 或失败 result 后，若后续出现新的 `user_message`，会从该新用户消息处重新开始 recent context；旧长工具链只进入 session summary，不再作为可继续执行的 live messages 回放。
  - **取消语义修复**：`RuntimeExecuteOptions` 新增 `timeoutSignal`。HTTP/WS timeout 由独立 `timeoutController` 标记，用户 ESC/连接关闭只 abort 主 signal；`LLMCodingRuntime` 与 `LocalCodingRuntime` 现在能区分 `REQUEST_CANCELLED` 与真正的 `REQUEST_TIMEOUT`。
  - **Planner 自然语言 fallback 顺序修复**：structured output diagnostics 增强后，Planner 自然语言 numbered plan 会先走文本 fallback，再在确实无法恢复时抛 schema mismatch，避免兼容层被诊断候选提前截断。
- **验证**:
  - `npm run typecheck` 成功通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/context-assembler.test.ts test/runtime-llm.test.ts test/runtime.test.ts test/run-session-flow.test.ts` 成功通过，69/69 通过。

## 0.74 2026-05-24 Agent Structured Output Failure Diagnostics

- **用户请求**: 继续推进 P3 真实 provider 非 dry-run smoke 诊断，重点展开 structured output 失败细节和 AgentLoop 失败可观测性。
- **实现结果**:
  - **Structured output 诊断细化**：`RuntimeAgentStepError.summary` 新增 `structuredOutput` 诊断对象，区分 `no_structured_json`、`schema_mismatch`、`provider_error`，并记录候选来源、候选数量、缺失必填字段、schema 错误摘要、assistant/result/structuredOutput 预览。
  - **Result message 解析补齐**：当 runtime 没有流式 assistant text、只通过 `result.message` 返回最终文本时，Agent step 现在会把该 message 纳入 structured output 候选解析，避免真实 provider/测试 runtime 的 JSON 被误判为无结构化输出。
  - **CLI 失败摘要增强**：`task_session_event` 的 executor/critic 失败摘要优先展示 `structured=<type>`、`missing=<keys>`、`sources=<candidateSources>`，再展示原始 error、provider/tool 信息和最后工具输出，便于在 `bbl optimize` 真实 smoke 中直接定位是字段缺失、空响应还是 provider 错误。
- **验证**:
  - `npm run typecheck` 成功通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/agent-loop.test.ts test/tui-renderer.test.ts test/runtime-llm.test.ts` 成功通过，53/53 通过。

## 0.73 2026-05-24 Agent Failure Observability and Provider Smoke Diagnostics

- **用户请求**: 继续推进 P3 真实 provider 非 dry-run smoke 诊断与 AgentLoop 失败可观测性。
- **实现结果**:
  - **Agent step 诊断对象**：`createRuntimeAgentStepRunner()` 新增 `RuntimeAgentStepError`，在 provider error、空响应、structured output parse 失败时携带 role、event/tool 计数、tool_denied/tool_failed 计数、result message、provider error code/message、最后一个 tool 名称与输出摘要。
  - **AgentLoop 失败事件增强**：`executor_failed_error` 事件 payload 现在包含 `diagnostics`，CLI `renderEvents` 会优先展示 error/diagnostics 摘要，避免真实 smoke 只看到 `executor failed error 1/2/3`。
  - **Planner 空 JSON 兜底**：Planner structured output 解析支持 `{}` / 空计划 fallback，生成保守单任务计划，避免 provider 返回空 JSON 时直接卡死在规划阶段。
  - **Executor 输出归一化增强**：Executor/Optimizer structured output 归一化可从当前 task input 补齐 `taskId`，并接受 `id`、`message`、`finalOutput`、`summary`、`status` 等常见 provider 变体，降低“结构接近但字段缺失”的失败率。
- **真实 provider smoke 诊断结果**:
  - 复跑临时仓库 `/tmp/babel-o-smoke-diag2-29PsE3` 后，Planner 阶段通过并生成 4 个任务，证明 Planner 空 JSON fallback 有效。
  - 复跑临时仓库 `/tmp/babel-o-smoke-diag3-ePVVB1` 后，主要失败类型收敛为两类：`Failed to parse optimizer structured output`（缺少必需字段，如 result/taskId）与 `Provider returned an empty assistant response with no tool calls`。
  - 两次临时 Git 仓库均保持干净，Git rollback/worktree 保护链路未污染目标目录。
  - 结论：当前 P3 非 dry-run smoke 的主要阻塞已经从 Git/rollback 链路转移到 provider/role structured-output 稳定性，下一步应做 role-level structured-output repair/retry 或按 `modelPreference.capability` 路由到更稳定的 role 模型。
- **验证**:
  - `npm run typecheck` 成功通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/runtime-llm.test.ts test/agent-loop.test.ts test/tui-renderer.test.ts` 成功通过，52/52 通过。

## 0.72 2026-05-24 P3 Worktree / Git Hardening

- **用户请求**: 继续推进 P3 Non-dry-run Provider Smoke 与 Worktree / Git Hardening 重写。
- **实现结果**:
  - **Worktree 提交加固**：`commitAndMergeWorktree()` 不再使用宽泛 `git add -A`，改为读取 `git status --porcelain=v1 -z --untracked-files=normal` 后通过显式 pathspec staging 本轮变更；stage 失败会抛出结构化错误，不再继续尝试 commit。
  - **嵌套 worktree 合并修复保留**：即使父 worktree 没有未提交文件，也会继续检查 `parentHead..worktreeHead` commit 范围，确保子 Agent 已经提交到父 worktree 的变更仍能 cherry-pick 回主工作区。
  - **非隔离 optimizer Git 回滚加固**：in-place rollback 从 `git reset --hard && git clean -fd` 改为 `git restore --staged --worktree .`，只回滚 tracked 文件，避免删除用户手动创建但未纳入任务的 untracked 文件。
  - **非隔离 optimizer commit 加固**：in-place commit 不再使用 `git add .`，改为显式 pathspec staging 当前 porcelain 变更，并配置本地 agent author，避免误纳入路径解析以外的文件或因缺少全局 Git 身份失败。
  - **MCP shutdown 稳定性修复**：`McpClient.shutdown()` 改为幂等并增加 1 秒超时兜底，避免同一 MCP server 暴露多个 tool 时共享 client 被并发 dispose，导致测试或运行时关闭流程挂起。
- **测试覆盖**:
  - `test/worktree.test.ts` 新增 pathspec staging + 新文件合并回归。
  - `test/agent-loop.test.ts` 新增 optimizer rollback 保留 unrelated untracked 文件回归。
  - 既有嵌套子 Agent worktree 合并、冲突文件诊断、worktree 生命周期测试全部继续通过。
  - `test/mcp.test.ts test/permission-flow.test.ts` 组合运行验证 MCP shutdown 不再挂起。
- **验证**:
  - `npm run typecheck` 成功通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/worktree.test.ts test/agent-loop.test.ts` 成功通过，18/18 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/mcp.test.ts test/permission-flow.test.ts` 成功通过，9/9 通过。
- **真实 provider smoke**:
  - 使用临时 Git 仓库 `/tmp/babel-o-smoke-WiPr4l` 执行 `npm run cli -- optimize --target /tmp/babel-o-smoke-WiPr4l --focus cleanup --enable-subagents --max-sub-agent-depth 1 --max-sub-tasks-per-task 2 --yes --cwd /tmp/babel-o-smoke-WiPr4l`。
  - 结果：真实 provider 非 dry-run 流程成功进入 Planner、生成 3 个任务、执行多轮工具调用，并在 executor 失败时触发 tracked-only rollback；最终因多任务达到 retry/settled 状态失败，终态为 `Task queue settled but not all tasks completed successfully.`
  - Git 安全验证：临时仓库保持干净，未生成额外 commit 或未跟踪残留，说明本轮 rollback/保护链路未污染目标目录。
  - 后续需要继续诊断 executor 失败细节展示与真实 provider 任务粒度/structured output 稳定性，暂不将非 dry-run provider smoke 标记为完成。

## 0.71 2026-05-24 P1 Safety Hardening Closure

- **用户请求**: 根据 TODO 文档推进完成 P0/P1 安全收口。
- **实现结果**:
  - **Bash 自动审批白名单收紧**：`src/runtime/classifier.ts` 从单条宽松正则升级为轻量 shell 词法扫描 + 精确命令白名单。自动审批仅覆盖 `pwd`、受限 `ls`、受限 `cat`、`git status/diff/log`、`npm list`、`npx tsc --noEmit` 等明确只读/校验命令；`npm test`、宽松 `npx tsc .*`、`cat /dev/*`、管道、重定向、链式操作、命令替换、变量展开和未闭合引号均回落人工确认。
  - **Optimizer safety 策略化**：`src/runtime/safetyCheck.ts` 新增 `OptimizerSafetyPolicy` 与 `defaultOptimizerSafetyPolicy`，把 package/lock/env/bin/tsconfig 保护和高危命令 deny 规则从函数体硬编码抽出为可注入策略；新增对 `pnpm-lock.yaml`、`yarn.lock`、`git reset --hard`、`git clean -fd` 的保护。
  - **MCP inputSchema 运行时校验**：`src/mcp/McpToolAdapter.ts` 在调用远端 MCP tool 前，将远端 `inputSchema` 的常用 JSON Schema 子集转换为 Zod 校验器；校验失败返回 `MCP_INPUT_SCHEMA_VALIDATION_FAILED` 可恢复 tool result，不再把任意对象直接传给远端 server。
- **测试覆盖**:
  - `test/classifier.test.ts` 覆盖 Bash 白名单收紧、命令替换、管道/重定向、`cat /dev/*` 等绕过样例。
  - `test/optimizer-safety.test.ts` 覆盖策略 override、lockfile、`git reset --hard` 与 `git clean -fd`。
  - `test/mcp.test.ts` 覆盖 MCP 远端 `inputSchema` 缺失 required 字段时的可恢复失败。
- **验证**:
  - `npm run typecheck` 成功通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/classifier.test.ts test/optimizer-safety.test.ts` 成功通过，7/7 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/mcp.test.ts` 成功通过，3/3 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/permission-flow.test.ts` 成功通过，6/6 通过。
- **后续核对**:
  - `test/mcp.test.ts test/permission-flow.test.ts` 在同一个 `tsx --test` 进程中组合运行时曾出现 Node test runner 子进程挂起；两者单独运行均通过。该问题更适合纳入测试并发化/子进程生命周期治理，而不作为本次安全实现阻塞。

## 0.70 2026-05-24 Recoverable Bash Non-Zero Exit

- **用户请求**: 深度分析最新聊天会话中 Bash 工具失败后 Agent 停止继续决策的问题，要求 Planner / Executor / Critic AgentLoop 能在工具调用失败后自行继续。
- **问题核实**:
  - 真实会话中的失败命令为 `cd /Users/tangyaoyue/DEV/BABEL/BabeL-X && git remote -v && git log --oneline -20`。
  - 外部直接原因是 `/Users/tangyaoyue/DEV/BABEL/BabeL-X` 当前不是 Git 仓库，`git` 返回非 0 退出码并输出 `fatal: not a git repository`。
  - 内部问题是 Bash 将“命令成功启动但业务退出码非 0”的情况抛成全局 `TOOL_ERROR`，导致 provider 收不到 `tool_result`，模型没有机会基于 stderr/exitCode 决定下一步，例如改查父目录、换目标路径或向用户说明。
- **实现结果**:
  - `src/tools/builtin/bash.ts` 将 Bash 非零退出码区分为可恢复失败：返回 `tool_completed success=false`，并保留结构化 `stdout`、`stderr`、`exitCode`、`signal` 和 `message`。
  - Docker Bash 与本地 Bash 使用相同口径；失败前若已探测到最新 CWD，仍会更新 session CWD。
  - 超时、maxBuffer、spawn/Docker 环境异常等运行时失败仍继续抛出 `TOOL_ERROR` 或超时错误，避免把基础设施故障伪装成普通命令失败。
  - LLM runtime 会把该失败作为 `tool_result is_error=true` 回传给模型，允许后续 provider 轮次继续生成工具调用或总结。
- **验证**:
  - `npm run typecheck` 成功通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/runtime.test.ts test/runtime-llm.test.ts` 成功通过，52/52 通过。

## 0.69 2026-05-24 Docker Sandbox Execution Environment

- **用户请求**: 实现 `executionEnvironment: 'docker'` 沙箱执行环境（P2 优先级），包括 Docker 容器生命周期管理、Workspace 目录挂载、网络/资源隔离以及 Session 清理。
- **实现结果**:
  - **类型扩展**：`ToolContext`（`src/tools/Tool.ts`）和 `RuntimeExecuteOptions`（`src/runtime/Runtime.ts`）均新增可选字段 `executionEnvironment?: 'local' | 'docker' | 'remote'`。
  - **配置扩展**：`BabelOConfig` 接口与 `BabelOConfigSchema`（`src/shared/config.ts`）新增可选 `docker` 配置块（`image` / `network` / `memory` / `cpus`），支持通过 config.json 或环境变量（`BABEL_O_DOCKER_IMAGE` / `BABEL_O_DOCKER_NETWORK` / `BABEL_O_DOCKER_MEMORY` / `BABEL_O_DOCKER_CPUS`）覆盖。
  - **API 路由调整**：`src/nexus/app.ts` 的 `/v1/execute` 和 `/v1/stream` 入口改为仅拦截 `remote`（返回 501），放行 `docker`；并将 `executionEnvironment` 透传至 `runtime.executeStream()`。
  - **运行时透传**：`LocalCodingRuntime` 与 `LLMCodingRuntime` 的 `executeToolSafely` 均将 `executionEnvironment` 写入 `tool.execute()` 的 context 对象。
  - **Docker Bash 执行器**：`src/tools/builtin/bash.ts` 新增 Docker 分支——首次调用时按需拉起命名为 `babel-o-session-${sessionId}` 的 detached 容器（`docker run -d -v <cwd>:<cwd> -w <currentCwd> --network none <image> tail -f /dev/null`），后续通过 `docker exec -w <currentCwd>` 执行命令；Docker 不存在时抛出明确的用户友好错误。
  - **异步容器清理**：`clearBashSessionState` 改为 `async`，Session 关闭时自动执行 `docker rm -f babel-o-session-${sessionId}`；全局 `spawnedContainers` Set 追踪所有已启动容器。
  - **Session 生命周期对接**：`src/nexus/sessionLifecycle.ts` 的 `closeNexusSession` 改为 `await clearBashSessionState()`。
  - **测试更新**：`test/runtime.test.ts` 的 `executionEnvironment parameter validation` 用例改为验证 `docker` 请求放行（无 Docker 时优雅报错），`remote` 仍返回 501；所有 `clearBashSessionState` 调用均加上 `await`。
- **验证结果**:
  - `npm run typecheck` — 0 错误。
  - 全部 155 项测试通过（20 个测试文件分组验证）。
  - `executionEnvironment: 'docker'` 在无 Docker daemon 环境下返回 HTTP 200 + 明确错误事件；有 Docker 时可实际进入容器执行命令。

## 0.68 2026-05-24 Audit Snapshot Cleanup

- **用户请求**: 删除 `docs/AUDIT_2026-05-24.md`，并将可用结论合并同步到 TODO 文档的合适位置。
- **核实结果**:
  - 审计中 `SEC-01` / `TEST-01` 提到的 `Allow-all policy still prompts for high risk tools` 失败结论已经过期；复跑 `test/security.test.ts test/classifier.test.ts test/tool-trace.test.ts test/diff.test.ts`，17/17 通过。
  - 审计中仍成立的结论主要是工程化和安全硬化事项，而不是当前 P0 失败：Bash 自动审批规则仍依赖正则/字符串、MCP runtime input schema 未用远端 schema 校验、CLI embedded 仍直接碰 Storage、非隔离 optimizer Git 操作仍需更保守策略、测试并发仍固定为 1。
- **实现结果**:
  - 删除过期快照 `docs/AUDIT_2026-05-24.md`。
  - `TODO_runtime.md` 增补 Bash 自动审批白名单收紧、shell parser、Optimizer safety 策略化、MCP inputSchema 运行时校验，以及 embedded/Nexus 架构边界事项。
  - `TODO_agents.md` 增补非隔离 in-place Git 操作加固、worktree isolation 默认推荐路径、AgentLoop 低成本 `--no-critic` 模式。
  - `TODO_performance.md` 增补 storageBridge 故障注入/复杂度再评估、AgentLoop 成本 benchmark、测试并发化治理。
  - `TODO_cleanup.md` 增补生产 build、lint/format、CI、coverage。
  - `TODO.md` 更新当前优先级并记录本次审计清理摘要。

## 0.67 2026-05-24 Model Routing and Provider Error Diagnostics Fix

- **用户请求**: 解决 `deepseek/deepseek-v4-pro` 模型请求报错 `Provider 'openai' request failed with status 402` 的问题，确保正确解析路由与报错诊断。
- **设计与实现**:
  - **模型凭证路由修复**：修复了 `src/runtime/LLMCodingRuntime.ts` 中调用 `resolveSettings` 未传入 `options.model` 的 bug。该问题导致运行时执行任何重写模型时均只能获取默认配置（OpenAI/默认 Profile）的 API Key 和 Base URL，现已修改为传入 `{ model: options.model }` 正确路由至 `deepseek` 凭证。
  - **动态 ProviderError 诊断**：修复了 `src/providers/adapters/OpenAIAdapter.ts` 中抛出 `ProviderError` 时硬编码 `'openai'` 作为 providerId 的问题。现已修改为提取 model 的 provider 前缀（如 `'deepseek'`)，使第三方或代理请求失败时可以返回真实的 providerId。
- **验证**:
  - `npm run typecheck` 成功通过。
  - `npm run test` 成功通过全部 155 个测试用例。

## 0.66 2026-05-24 Git Cherry-pick Conflict Diagnostics

- **用户请求**: 稳步推进建议一，在 Worktree 冲突下增加具体的文件名与诊断细节，编写测试验证。
- **设计与实现**:
  - **冲突文件诊断机制**：在 `commitAndMergeWorktree` 中，如果 `git cherry-pick <commit>` 失败，在调用 `cherry-pick --abort` 恢复父仓库干净状态之前，运行 `git diff --name-only --diff-filter=U` 搜集所有冲突状态的文件名列表。
  - **结构化错误抛出**：将搜集到的冲突文件名序列化并随 Error 抛出（格式如：`Cherry-pick failed with conflicts. Conflicting files: conflict.txt.`），让 Critic、Planner 以及用户和调用端可以从异常中看到详细的冲突文件诊断。
  - **冲突单元测试**：在 `test/worktree.test.ts` 中新增了 `commitAndMergeWorktree reports conflicting files on cherry-pick failure` 单元测试，通过向 parent 仓库和 worktree 隔离目录的同一行写入不同内容并合并来制造冲突，断言抛出的异常信息包含 `conflict.txt`，并验证 `.git/CHERRY_PICK_HEAD` 被正确清除（无残留 cherry-pick 状态）。
  - **构建测试链条**：将 `test/optimize-command.test.ts` 补充至 `package.json` 的 `test` 运行脚本中，确保全面覆盖。
- **验证**:
  - `npm run typecheck` 成功通过。
  - `npm run test` 成功通过全部 155 个测试用例。

## 0.65 2026-05-24 Provider Error Session Outcome Fix

- **用户请求**: 深度分析最新 `PROVIDER_ERROR: Provider 'openai' request failed with status 402 ... Insufficient Balance` 会话报错。
- **日志核实**:
  - 最新问题会话为 `session_ba17e426-0e80-4b34-909a-d5893cdd04f0`，SQLite 中共有 4104 个事件：`tool_started`/`tool_completed` 各 62 个，最后一条终态事件是 `error`，code 为 `PROVIDER_ERROR`。
  - 外部直接原因是 OpenAI 返回 402 `Insufficient Balance`，发生在最后 3 个 Bash 工具结果成功回传给 provider 之后，因此模型没有机会基于最后工具结果生成最终总结。
  - 内部状态问题是 embedded `bbl chat` 收尾逻辑只读取升序前 100 条事件判断终态；长会话中它看到早期成功 `result`，漏掉尾部 `PROVIDER_ERROR`，导致 session 表仍显示 `completed`，`result` 还停留在更早的 `hi` 回复。
- **实现结果**:
  - `runSessionFlow()` 收尾改为按 `order: 'desc'` 读取最新事件窗口。
  - 新增 `resolveFinalSessionOutcome()`，以最新 terminal event（`error` 或 `result`）决定 session phase/result/error，避免早期成功结果覆盖最新失败。
  - 新增 `test/run-session-flow.test.ts`，覆盖“早期 success result + 长工具流 + 最新 provider error”应标记为 failed，以及最新 failed result 的失败口径。
  - 将 `test/run-session-flow.test.ts` 纳入 `npm test`。
- **验证**:
  - `npm run typecheck` 成功通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/run-session-flow.test.ts test/runtime-llm.test.ts test/runtime.test.ts` 成功通过，53/53 通过。

## 0.64 2026-05-24 Cross-Session Task Delegation & Dynamic Sub-Agents

- **用户请求**: 稳步推进重写建议一，实现跨 Session 任务委派与动态子代理，确保功能稳定完善，批准开发。
- **设计与实现**:
  - **动态子代理会话**：在 `runAgentLoop` 中增加了对 `tasks` 预定义计划任务的支持。在执行阶段，如遇到拥有 `parentTaskId` 且启用了子代理的任务，会启动一个全新的子代理 Session（带有独立 queueId 和 parentSessionId），使子任务生命周期与上下文完全独立，默认 autoApprove 为 true。
  - **防无限递归 (OOM) 修复**：在子会话启动时，通过在 tasks 的 metadata 中将 `parentTaskId` 设为 `undefined` 以隔离上下游父子任务标记；并在 `isSubAgentTask` 判断中强化约束 `String(task.metadata.parentTaskId) !== String(task.taskId)`，彻底避免子 Session 根任务自己匹配自己导致无限生成孙 Session。
  - **嵌套隔离 Worktree 合并修复**：修复了子代理在其隔离 worktree 内 commit + cherry-pick 到父隔离工作区后，父代理因工作目录 relative clean 导致无法检测到新 Commit 的 bug。将 `commitAndMergeWorktree` 升级为检测范围 Commit 并批量 cherry-pick 合并：通过 `git rev-list --reverse parentHead..worktreeHead` 获取工作流自创建以来的全部 Commit 列表并逐个 cherry-pick 合并回主工作区。
  - **集成测试覆盖**：在 `test/agent-loop.test.ts` 中新增了 `runAgentLoop runs sub-agent session with isolation and merges changes back` 集成用例，覆盖了子代理 Session 嵌套隔离 worktree 读写、递归调用、变更合并和工作区清理流程。
- **验证**:
  - `npm run typecheck` 成功通过。
  - `npm run test` 成功通过全部 148 个测试用例。

## 0.63 2026-05-24 Worktree Isolation First Pass

- **用户请求**: 用户进一步修改并更新项目后，核对当前开发状态与文档记录。
- **核实结果**:
  - 新增 `src/nexus/worktree.ts` 与 `test/worktree.test.ts`，实现 Git worktree 创建、隔离提交、cherry-pick 合并与清理。
  - `runAgentLoop()` 已接入 `requiresIsolation` metadata：任务要求隔离时会在 `.babel-o/worktrees/<taskId>` 中执行 Executor/Critic，审核通过后合并回主工作区。
  - `TODO_agents.md` 原先仍写着 worktree 隔离延后实现，和代码状态不一致。
- **实现修正**:
  - 修正 AgentLoop 隔离任务合并后的提交语义：worktree merge 已经产生并 cherry-pick 提交，不再继续走主工作区 `gitCommit`，避免 no-op warn 或把主工作区其他改动误纳入提交。
  - 更新 `TODO.md` 与 `TODO_agents.md`：worktree isolation 第一版标记为已接入，剩余项改为真实 provider 非 dry-run smoke、冲突恢复策略和可视化提示。
  - `test/agent-loop.test.ts` 增加断言：隔离任务应记录 `worktree_merged`，且不应再记录 `git_commit_performed`。
- **验证**:
  - `npm run typecheck` 成功通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/worktree.test.ts test/agent-loop.test.ts test/optimize-command.test.ts test/runtime-llm.test.ts test/context-assembler.test.ts` 成功通过，52/52 通过。

## 0.62 2026-05-24 Explicit Path Request Anchoring

- **用户请求**: 最新会话中输入 `/Users/tangyaoyue/DEV/BABEL/BabeL-X横向对比分析这个项目` 后，Agent 依旧被旧上下文带偏并继续分析 BabeL-O，要求深度分析修复。
- **日志核实**:
  - 本地 SQLite 中 `session_bff7cbdd-d987-4dbf-8145-549c94aed2dc` 已完成，`last_user_input` 确认为 `/Users/tangyaoyue/DEV/BABEL/BabeL-X横向对比分析这个项目`。
  - 该 session 共 6314 个事件，其中 `user_message` 4 个、`tool_started` 54 个、`assistant_delta` 5380 个。
  - 最新用户输入后的第一批工具调用仍然是 `find /Users/tangyaoyue/DEV/BABEL/BabeL-O ...`、`ls .../BabeL-O` 和读取 BabeL-O 源码，说明问题已经不是输入未写入或轮次未锚定，而是模型把“这个项目”解释成旧历史中的 BabeL-O。
- **实现结果**:
  - `buildSystemPrompt()` 增加 `Explicit paths in current request` 块，解析当前请求中的绝对路径并标注是否存在。
  - system prompt 新增规则：当前请求包含显式绝对路径时，该路径是权威任务目标，不得用旧历史项目替换；横向对比/compare 且只有一个显式路径时，必须先检查该显式路径，再把最相关旧项目作为对比基线。
  - 路径解析支持 `/Users/.../BabeL-X横向对比分析这个项目` 这种中文无空格后缀：会回退到最长真实存在路径 `/Users/.../BabeL-X`，同时避免把普通缺失文件误折叠成父目录。
- **验证**:
  - `npm run typecheck` 成功通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/context-assembler.test.ts test/runtime-llm.test.ts test/runtime.test.ts` 成功通过，63/63 通过。

## 0.60 2026-05-24 Recoverable Read Failures

- **用户请求**: 根据 `session_923e...f29a0` 的项目分析输出中断问题，调用项目日志和数据库分析模型输出错误原因并修复优化。
- **日志核实**:
  - 本地持久化库路径为 `/Users/tangyaoyue/.babel-o/db.sqlite`。
  - `session_923ecd72-3a8a-43d7-a039-03a04b1f29a0` 共 570 个事件：`tool_started` 19 个、`tool_completed` 18 个、最后 1 个 `error`。
  - 最后一项工具调用为 `Read({"path":"/Users/tangyaoyue/DEV/BABEL/BabeL-O/.babel-o/config.json"})`，该文件不存在，`Read` 内部 `stat` 抛出 `ENOENT`，runtime 将其升级为全局 `TOOL_ERROR`，导致模型没有机会收到失败结果并继续输出项目分析。
- **实现结果**:
  - `Read` 工具现在将 `ENOENT` / `ENOTDIR` 转为 `success=false` 的可恢复工具结果，并提示用户/模型用 `Glob` 探测真实文件。
  - `Read` 对目录和非普通文件同样返回可解释的 `success=false` 工具结果，不抛异常中断 Agent turn。
  - LLM runtime 回归测试确认缺失 `Read` 会作为 `tool_result is_error=true` 回传给 provider，模型可继续给出后续回复；真正的 Bash 执行异常仍保留 `TOOL_ERROR` 结构化诊断。
- **验证**:
  - `npm run typecheck` 成功通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/runtime.test.ts test/runtime-llm.test.ts` 成功通过，51/51 通过。
  - CLI smoke：`BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npm run cli -- run 'read missing.txt' --cwd <tmpdir>` 输出 `Read failed` 和 `✗ failed`，不再输出 `TOOL_ERROR`。

## 0.61 2026-05-24 Latest-Turn Context Anchoring

- **用户请求**: 继续查看当前正在运行的聊天会话，分析为什么输入 `/Users/tangyaoyue/DEV/BABEL/BabeL-X横向对比这个项目` 后没有得到正常直接反馈。
- **日志核实**:
  - 本地 SQLite 中 `session_804224db-8b7c-4c96-bc3b-4912e02cff91` 已完成，并非仍在运行中；该 session 共 3859 个事件，其中 `assistant_delta` 3501 个、`user_message` 4 个。
  - 最新用户输入确实写入数据库：`/Users/tangyaoyue/DEV/BABEL/BabeL-X横向对比这个项目`，但随后模型继续读取 BabeL-O 的核心文件并输出 BabeL-O 深度分析。
  - 根因是 `selectRecentEvents()` 的“最近 4 个用户轮次”策略在长输出会话中直接保留几千个旧事件，旧 BabeL-O 分析与后续 assistant 尾巴压过了当前对比 BabeL-X 的意图。
- **实现结果**:
  - `selectRecentEvents()` 现在即使按用户轮次选择历史，也会受 `recentEventLimit` 约束，不再把几千个历史 delta 全量回放给 provider。
  - 裁剪逻辑以最新 `user_message` 为锚点：如果一轮内部事件超预算，会保留该轮最新用户请求，再拼接预算内的尾部事件，避免当前请求被裁掉。
  - system prompt 新增 `Current user request:` 显式块，并加入规则：当前请求优先于冲突的旧历史。
  - 用真实 `session_8042...cff91` 事件回放验证：组装后 `selectedEventCount=256`、`omittedEventCount=3603`，system prompt 含 BabeL-X 对比请求，第一条 message 是最新 BabeL-X 对比请求。
- **验证**:
  - `npm run typecheck` 成功通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/context-assembler.test.ts test/runtime-llm.test.ts test/runtime.test.ts` 成功通过，61/61 通过。

## 0.59 2026-05-24 Planner HITL and SubTask Visualization

- **用户请求**: 推进后续优先级 1 + 2：Planner Human-in-the-Loop，以及在 CLI/TUI 中更清晰展示子任务状态。
- **实现结果**:
  - `runAgentLoop()` 增加 `reviewPlan` 钩子和 `PlannerReviewDecision` 类型；Planner 输出后可记录 `planner_review` pending input，等待调用方确认、编辑或拒绝。
  - Planner 审批拒绝时会记录 `planner_review_rejected`，取消 TaskSession，并写入 `PLANNER_REJECTED` terminal reason；审批通过时会记录 `planner_review_approved` 并使用编辑后的任务列表创建 TaskQueue。
  - `bbl optimize` 非 dry-run 默认在执行前展示计划，支持 `[a]pprove`、`[e]dit`、`[r]eject`；`--auto-approve` 和 `--yes` 可跳过 Planner 审批。
  - AgentLoop task session events 改为携带完整 task payload；委派成功时单独记录父任务 `task_blocked`，并在 `subtasks_delegated` 中包含 parentTask、subTasks、depth、accepted/requested 等元信息。
  - CLI Task Status Board 支持展示 blocked 父任务、子任务缩进层级、`parent #id` 和 `delegated #id`，方便观察父任务 blocked、子任务 created/claimed/completed 的流转。
  - 修正 Planner 编辑交互中“删除全部任务”后的语义：直接按拒绝计划处理，避免空任务列表被误当作批准。
  - 为真实 `bbl optimize --target <目录>` smoke 补齐两个恢复性边界：`Read` 读取目录时返回可解释的工具失败结果，不再抛 `EISDIR` 打断 AgentStep；`Glob` 兼容绝对 workspace 目录 pattern，避免目录目标被误判为空。
  - Planner 结构化输出解析增加自然语言编号列表兜底，仅在 Planner schema 下启用，用于吸收部分 provider 未严格返回 JSON 的计划文本。
- **验证**:
  - `npm run typecheck` 成功通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/runtime.test.ts test/agent-loop.test.ts test/tui-renderer.test.ts test/optimize-command.test.ts test/runtime-llm.test.ts` 成功通过，75/75 通过。
  - 真实 provider dry-run smoke 通过：`npm run cli -- optimize --target /tmp/babel-o-opt-hitl-smoke-real.7phfKH --cwd /tmp/babel-o-opt-hitl-smoke-real.7phfKH --focus cleanup --dry-run --enable-subagents --max-sub-agent-depth 1 --max-sub-tasks-per-task 2` 成功输出 4 个 Proposed Tasks，且 dry-run 未写入目标目录。
- **后续核对**:
  - 下一步优先跑真实 provider 的非 dry-run `bbl optimize --enable-subagents` 小目录 smoke，验证 Planner 审批、Git stash/commit/rollback、子任务回收在真实模型输出下是否稳定。
  - 跨 session dynamic sub-agent 与 worktree isolation 仍未开始，继续作为 P3 后续主线。

## 0.58 2026-05-24 Optimize SubAgents CLI and Provider Smoke

- **用户请求**: 按建议继续推进，优先完成 `bbl optimize` 暴露 subAgents 开关，并跑真实 provider smoke。
- **实现结果**:
  - `bbl optimize` 新增 `--enable-subagents`、`--max-sub-agent-depth`、`--max-sub-tasks-per-task`，并将参数传入 `runAgentLoop()` 的 `enableSubAgents`、`maxSubAgentDepth`、`maxSubTasksPerTask`。
  - 修复 Commander 对 `--enable-subagents` 的 camelcase 解析差异：兼容 `enableSubAgents` 与 `enableSubagents`。
  - dry-run planner 路径现在会创建 TaskSession，避免 `recordTaskSessionNexusEvent()` 报 `TaskSession not found`。
  - Agent role 工具策略接入 runtime：`runtimeAgentStep` 运行角色步骤时临时应用 role allowlist；`LLMCodingRuntime` provider 请求只暴露当前 policy 允许的 tools，避免 Planner 看到 Bash/Write 等不可用工具后触发 denied。
  - Planner role 开放只读工具 `Read` / `Grep` / `Glob`，可先检查目标再生成计划。
  - Planner structured output normalization 增强：兼容 provider 返回 `goal` / `finalOutput` / `optimizationFocus` 作为 summary，以及 `tasks[].description/action/file` 作为任务 title/metadata。
- **真实 smoke**:
  - 临时目录 `/tmp/babel-o-opt-smoke.YN0znC`，含一个 `sample.ts`。
  - 执行 `npm run cli -- optimize --target /tmp/babel-o-opt-smoke.YN0znC --cwd /tmp/babel-o-opt-smoke.YN0znC --focus cleanup --dry-run --enable-subagents --max-sub-agent-depth 1 --max-sub-tasks-per-task 2`。
  - 结果：CLI 正确显示 `Sub-agents enabled: max depth 1, max subTasks/task 2`；Planner 调用只读工具读取目标目录；最终输出 4 个 proposed tasks，dry-run 未写入目标目录。
- **验证**:
  - `npm run typecheck` 成功通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/optimize-command.test.ts test/agent-loop.test.ts test/runtime-llm.test.ts` 成功通过，34/34 通过。
- **后续核对**:
  - 下一步建议推进 Planner Human-in-the-Loop：dry-run 已能出计划，非 dry-run 前需要用户确认/编辑/拒绝任务列表，避免真实 optimizer 一上来按错误计划写文件。

## 0.57 2026-05-24 Context Replay and Empty Response Fix

- **用户请求**: 查看最近一次调用日志，分析当前项目上下文管理混乱、不能支持相对连续任务和交互回应的问题。问题 session 为 `session_fa312235-4377-430f-b7f9-65753bf6e1ad`。
- **日志核实**:
  - SQLite 中该 session 共有 3376 个事件，其中 `assistant_delta` 2963 条、`thinking_delta` 180 条、`user_message` 6 条。
  - 第一次输入 `架构性能差异` 只产生 usage/result/metrics，`result.message` 为空但 `success=true`，因此 CLI 显示空白 `✓ done`。
  - 第二次输入 `架构性能差异` 的上下文组装中，最后一个 assistant message 正文为空，但带有 10k+ 字符 `reasoningContent`，开头包含 `<file_contents>` 等旧隐藏推理内容，确认历史 thinking 被回放并污染后续 provider 请求。
  - 原 `selectRecentEvents()` 按原始事件条数切片，长回答会产生大量 delta，容易切碎用户轮次和工具调用边界。
- **实现结果**:
  - `mapEventsToMessages()` 不再把历史 `thinking_delta` 组装为 `reasoningContent`。thinking 仍保留在事件日志和 TUI 显示路径，但不会回放给 provider。
  - `selectRecentEvents()` 改为优先按最近用户轮次选择上下文；大窗口模型保留最近 4 个用户轮次，本地小窗口保留最近 2 个用户轮次，旧内容进入规则摘要。
  - provider 返回无文本且无工具调用时，`LLMCodingRuntime` 产出 `EMPTY_PROVIDER_RESPONSE` error 和 `success=false` result，不再把空响应显示为成功 done。
  - `mapEventsToMessages()` 跳过连续相同 user message，降低历史空轮次造成重复追问的上下文噪音。
  - `summarizeSessionEvents()` 的 earlier user requests 改为保留最近被压缩的几个用户请求，便于恢复连续任务语义。
- **真实日志回放验证**:
  - 对 `session_fa31...6e1ad` 重新组装上下文后，messages 中不再包含 `<file_contents>`，`totalReasoningChars=0`。
  - 选中上下文从“横向对比分析这两个项目”开始，并保留“你对比错了两个项目 -> 架构性能差异”的最近连续语义；更早的大段 BabeL-X 分析进入 summary。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/runtime-llm.test.ts test/context-assembler.test.ts` 成功通过，27/27 通过。

## 0.56 2026-05-24 Provider Tool Result Mapping Fix

- **用户请求**: 查看 `PROVIDER_ERROR: Provider 'minimax' request failed with status 400 ... tool result's tool id(...) not found` 的项目日志并分析报错原因。
- **根因核实**:
  - 本地 SQLite 日志确认 `session_0158eef1-20db-4178-aa57-069d1d27a36e` 中 `call_function_lgkuocdgyntw_3` 的 `tool_started` 与 `tool_completed` 均存在，数据库事件本身没有丢失。
  - 报错发生在下一轮用户输入组装历史上下文并发送给 Minimax 时。现有 `mapEventsToMessages()` 会把持久化事件中的 `tool_started -> tool_completed -> tool_started -> tool_completed` 还原为多组 `assistant(tool_use) -> user(tool_result)`。Minimax 的 Anthropic-compatible `/v1/messages` 校验要求同一 assistant turn 的多个 `tool_use` 保持在同一个 assistant message 中，并由紧随其后的一个 user message 一次性返回全部 `tool_result`；拆散后会触发 `tool result's tool id not found`。
  - 另一个潜在风险是上下文压缩后可能只保留 `tool_completed` 而遗漏对应 `tool_started`，从而生成 orphan `tool_result`。
- **实现结果**:
  - `mapEventsToMessages()` 现在会跳过没有对应 `tool_started` 的 orphan `tool_completed`，避免向 provider 发送无来源 `tool_result`。
  - 连续工具调用事件会被恢复为一个 assistant message 内的多个 `tool_use` blocks，并紧跟一个 user message 内的多个 `tool_result` blocks，匹配 Anthropic-compatible provider 的工具调用协议。
  - 用真实 `session_0158...7a36e` 数据重放验证：`call_function_lgkuocdgyntw_1..4` 被恢复为一条 assistant + 一条 user，且无 orphan tool_result。
  - 新增单测覆盖 orphan `tool_completed` 跳过和连续工具调用分组合并。
- **验证**:
  - `npm run typecheck` 成功通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/runtime-llm.test.ts test/context-assembler.test.ts` 成功通过，23/23 通过。

## 0.55 2026-05-24 P3 Agent Orchestration: Controlled SubTasks

- **用户请求**: 参考 BabeL-X 中的优秀设计推进 Agent Orchestration P3：Executor 能拆 subTasks，`runAgentLoop()` 限制最大嵌套深度，避免无限派生。
- **设计参考**:
  - 参考 BabeL-X coordinator / AgentTool 的核心约束：不要委派琐碎读文件/简单命令、不要重复委派、worker/子任务结果是内部信号而不是对话对象、必须有深度与数量边界。
  - 不迁移 BabeL-X 的后台 worker、React AgentTool、跨 session fork 和 worktree 隔离复杂体系；BabeL-O 第一版采用同 TaskQueue 的轻量受控委派，复用现有 TaskSession、TaskQueue、Critic、storageBridge 和审计链路。
- **实现结果**:
  - **Executor/Optimizer schema 扩展**：`ExecutorOutputSchema` 增加 `subTasks` 字段，支持 `title`、`description`、`requiresIsolation`、`metadata`。
  - **AgentLoop 委派控制**：`runAgentLoop()` 新增 `enableSubAgents`、`maxSubAgentDepth`、`maxSubTasksPerTask`。默认关闭 subAgents，避免旧流程行为变化。
  - **父子任务调度语义**：Executor 返回有效 `subTasks` 且未超过深度时，父任务转为 `blocked`，把子任务 ID 写入父任务 `dependsOn` 和 `metadata.delegatedSubTaskIds`；子任务完成后现有 `unblockTasks()` 会让父任务回到 `pending`，再由 Executor 汇总收口。
  - **防无限派生**：每个任务通过 `metadata.depth` 记录嵌套深度；达到 `maxSubAgentDepth` 或未启用 subAgents 时，记录 `subtasks_rejected_depth_limit` 事件，并将拒绝原因写入任务 metadata，不创建子任务。
  - **真实 runtime 提示**：Executor/Optimizer system prompt 和 input orchestration context 会明确当前深度、最大深度、剩余深度和已委派子任务，指导模型不要滥用子任务。
  - **测试覆盖**：新增 AgentLoop 测试覆盖父任务委派、子任务执行、父任务恢复收口，以及深度上限拒绝继续派生；新增 structured output 测试覆盖 Executor schema 接收 `subTasks`。
- **验证**:
  - `npm run typecheck` 成功通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/agent-loop.test.ts` 成功通过，10/10 通过。
- **后续核对**:
  - 下一步可继续做跨 session dynamic sub-agent 生命周期、worktree isolation、Planner 输出后 human approval，以及真实 provider 下的 `bbl optimize --enable-subagents` smoke。

## 0.54 2026-05-24 T0 Reliability Completion: WAL Batch/Fsync Strategy

- **用户请求**: 完成 T0 完善。
- **实现结果**:
  - **WAL 批量写入策略**：`storageBridge` WAL 从固定逐条同步追加升级为可配置策略，支持 `batchSize`、`flushIntervalMs` 和 `fsync`。默认 `batchSize=1`、`flushIntervalMs=0`、`fsync=false`，保持原有即时写入语义；需要吞吐时可调大 batch 并用 interval 定时 flush。
  - **刷盘安全选项**：`fsync=true` 时，WAL 追加会 fsync 文件描述符；compact 时会 fsync 临时文件并在 rename 后 fsync 目录，降低系统崩溃下 rename 丢失风险。
  - **服务端配置入口**：`createDefaultNexusRuntime()` 新增 `storageWal` 选项；`nexus/server.ts` 支持 `NEXUS_STORAGE_WAL_BATCH_SIZE`、`NEXUS_STORAGE_WAL_FLUSH_INTERVAL_MS`、`NEXUS_STORAGE_WAL_FSYNC`。
  - **测试覆盖**：新增 batch flush + fsync smoke，验证 WAL buffer、flush 计数和配置 stats；新增 1000 pending ops WAL replay smoke，验证大量待持久化 task 在重启后完整恢复。
- **验证**:
  - `npm run typecheck` 成功通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/agent-loop.test.ts` 成功通过，8/8 通过。
- **后续核对**:
  - T0 高优先级可靠性项已收口。后续性能主线仍可继续补 1000+ sessions/events API 响应压测、chat 首响 benchmark、provider retry benchmark。

## 0.53 2026-05-24 T0 Reliability Closure: Durable WAL and Session Close Cascade

- **用户请求**: 推进 T0，继续收口 reliability / safety 高优先级项。
- **实现结果**:
  - **storageBridge durable WAL**：将 `storageBridge` 从纯内存重试队列升级为 JSONL WAL 队列。每个 task/session mutation 入队前先追加 `op` 记录，落库成功后追加 `ack`，队列清空时 compact WAL；启动/配置 WAL 时 replay 未 ack 操作，避免进程崩溃导致未 flush 数据丢失。
  - **runtime 生命周期接入**：`createDefaultNexusRuntime({ storagePath })` 默认为 SQLite storage 配套启用 `${storagePath}.wal.jsonl`，并在 storage close 前主动 flush storageBridge。
  - **session close 级联清理**：新增 `closeNexusSession()` 和 `POST /v1/sessions/:sessionId/close`；`cancel` 路径复用 close 流程。关闭会话时统一清理 Bash CWD、TaskQueue、TaskSession 和 PendingPermission，避免长运行进程中模块级 Map 常驻。
  - **CLI 退出清理**：`bbl chat` 的 `/exit` 与 Ctrl-C 退出路径改为 best-effort 调用 close 流程；远程模式通过 Nexus API close，本地模式直接打开默认 SQLite storage 清理。
  - **测试覆盖**：新增 storageBridge WAL replay 测试和 session close cascade 测试，覆盖 WAL 恢复、Bash CWD 清理、TaskQueue/TaskSession 清理和 pending permission 自动 deny。
- **验证**:
  - `npm run typecheck` 成功通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/agent-loop.test.ts test/runtime.test.ts` 成功通过，33/33 通过。
- **后续核对**:
  - T0-1 / T0-2 已从高优先级未收口项转为完成；后续如需增强，重点是 WAL 批量写入、fsync 策略配置和大量 session/event 恢复压测。

## 0.52 2026-05-24 T0 Reliability Follow-up: Tool error diagnostics and structured logger

- **用户请求**: 根据 T0 优先级继续推进优化，包含 durable WAL、session close 清理、工具错误信息传递修复和结构化 Logger。
- **实现结果**:
  - **工具错误诊断增强 (T0-3)**：`LocalCodingRuntime` 与 `LLMCodingRuntime` 的 `executeToolSafely()` 在工具异常时保留结构化 `details`，包含 `stdout`、`stderr`、`code`、`signal`、`exitCode` 等字段；stdout/stderr 会按工具输出预算分别截断并记录 original bytes，避免错误事件只剩 `Command failed`。
  - **事件 Schema 扩展**：`ErrorEventSchema` 增加可选 `details` 字段，保持已有 `code/message` 兼容。
  - **最小结构化 Logger (T0-4)**：新增 `src/shared/logger.ts`，输出 JSON 日志，支持 `NEXUS_LOG_LEVEL=silent|error|warn|info|debug`。
  - **Nexus/shared 层日志治理**：`storageBridge` 永久失败、`nexus/server.ts` 安全配置失败、`agentLoop` Git stash/commit/rollback 异常、`ConfigManager` 配置校验失败均改为结构化 logger；CLI 面向用户的 console 输出暂不纳入 silent logger 控制。
  - **测试覆盖**：新增 `test/logger.test.ts` 验证 silent 静默和 JSON 日志格式；新增 runtime 集成测试验证 Bash 工具失败时 error event 带 stdout/stderr/code details。
- **验证**:
  - `npm run typecheck` 成功通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/logger.test.ts test/runtime.test.ts test/runtime-llm.test.ts test/agent-loop.test.ts` 成功通过，45/45 全绿。
- **后续核对**:
  - T0-1 `storageBridge` durable WAL 与批量写入仍未实现。
  - T0-2 session close event + 级联清理仍未实现。当前不应在每次 execute 完成后清理，因为 chat 需要跨轮保留 Bash CWD；应先定义明确的 session close/cancel/end 语义。

## 0.51 2026-05-24 P2 Model Capability Routing 收口

- **用户请求**: 根据下一步开发建议继续稳步重写，优先推进 Provider Registry 收口与 Agent 能力闭环。
- **实现结果**:
  - **统一模型解析优先级**：`ConfigManager.resolveSettings()` 支持传入 `{ model, role, provider }`，明确优先级为 request model > env model > role model > profile model > defaultModel。
  - **Provider 解析修正**：带 provider 前缀的模型 ID（如 `deepseek/deepseek-v4-pro`）不再被 `BABEL_O_PROVIDER` 或 active profile provider 错配，避免 request model 被错误送到其他 adapter。
  - **Nexus HTTP/WS 统一口径**：`POST /v1/execute` 与 WS `/v1/stream` 均使用 `resolveSettings({ model })` 解析 request model，继续对 `toolCalling=false` 的已知模型前置拒绝。
  - **Structured role gate**：`runtimeAgentStep.ts` 在 Agent step 执行前校验模型能力。工具角色要求 `toolCalling=true`；`modelPreference.capability === 'structured-output'` 的角色要求 `jsonOutput=true`。不满足时直接报错，不调用 runtime。
  - **测试覆盖**：新增配置解析测试，锁定 request model 优先于 env/role/profile/default；新增 Agent Step 测试，验证 Critic 这类 structured role 在不支持 JSON 输出模型上被前置拒绝。
- **验证**:
  - `npm run typecheck` 成功通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/runtime-llm.test.ts test/agent-loop.test.ts test/runtime.test.ts` 成功通过，42/42 全绿。
- **后续核对**:
  - Model Capability Routing 核心路径已收口；未配置 roles 时根据 role capability 自动推荐默认模型仍待补。

## 0.50 2026-05-23 P0 Safety / Stability Hardening

- **用户请求**: 根据 TODO 文档进一步重写开发，优先收口 P0 安全与稳定性问题：PendingPermissionRegistry TTL、storageBridge 持久化重试、模块级 Map 生命周期、Bash 标记注入、`new Function` 动态 import。
- **实现结果**:
  - **PendingPermissionRegistry TTL**：`src/shared/session.ts` 为 pending permission 增加 `expiresAt`、30 分钟默认 TTL、后台 sweeper、`sweepExpired()`、`pendingCount()`、测试配置与 reset 入口。超时请求自动返回 deny，释放等待中的 Promise。
  - **storageBridge 重试队列**：`src/nexus/storageBridge.ts` 从 fire-and-forget 改为内存持久化队列，支持最多 3 次重试、延迟调度、永久失败计数、`lastError` 与 `getStorageBridgeStats()`。
  - **模块级 Map 生命周期**：`src/tools/builtin/bash.ts` 的 `sessionCwdMap` 保存 `lastActiveAt` 并增加 TTL prune；`src/nexus/taskQueue.ts` 与 `src/nexus/taskSession.ts` 对终态 task/session 增加 24 小时默认 prune 与后台 sweeper。
  - **Bash probe 加固**：Bash CWD 状态探测从固定 `---BABEL_O_STATE---` 改为每次执行随机 nonce + HMAC marker，并用 `timingSafeEqual` 验证，避免用户命令伪造 marker 污染会话 CWD。
  - **动态 import 安全收口**：移除 CLI/测试中 `new Function("return import('ws')")` 形式，改为普通 `await import('ws')`，并补充本地 `src/types/ws.d.ts` 以保持 strict typecheck。
  - **测试覆盖**：新增/更新测试覆盖 pending permission 超时、task/session prune、storageBridge 失败后重试、Bash forged marker 防护、Bash CWD TTL prune。
- **验证**:
  - `npm run typecheck` 成功通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/permission-flow.test.ts test/agent-loop.test.ts test/runtime.test.ts test/security.test.ts` 成功通过，43/43 全绿。
- **后续核对**:
  - 本次完成的是 P0 级长运行进程稳定性治理。`storageBridge` durable WAL、批量写入和 session close event 级联清理仍可作为后续可靠性增强，不再作为当前 P0 阻塞。

## 0.1 2026-05-21 Clean rewrite skeleton

- **用户请求**: 在 `/Users/tangyaoyue/develop/BabeL-O` 新文件夹中进行 BabeL-X Nexus-first 重写。
- **实现结果**:
  - 创建 `package.json`、`tsconfig.json`、`.gitignore`、`bin/babel-o.js`。
  - 创建 `src/nexus/`、`src/runtime/`、`src/tools/`、`src/storage/`、`src/providers/`、`src/cli/`、`src/shared/`。
  - 实现 Fastify Nexus API。
  - 实现 Commander CLI。
  - 实现 `LocalCodingRuntime`。
  - 实现基础工具：Read、Write、Edit、Bash、Grep、Glob、TaskCreate。
  - 实现 MemoryStorage。
  - 实现 `run`、`chat`、`nexus start/status`、`sessions list/show`。
  - 创建 `docs/ARCHITECTURE.md`。
- **验证**:
  - `npm install` 成功，0 vulnerabilities。
  - `npm run typecheck` 通过。
  - `npm test` 通过。
  - `npm run cli -- run "hello"` 通过。
  - `npm run cli -- run "read README.md"` 通过。
  - `npm run start` 后 `/health` 可访问。
  - `npm run cli -- run --url http://127.0.0.1:3000 "bash pwd"` 通过。
  - `npm run cli -- nexus status --url http://127.0.0.1:3000` 通过。
- **重要决策**:
  - Nexus owns execution.
  - CLI owns interaction.
  - 第一版使用 deterministic local runtime 保证架构和测试先稳定。
  - 真实 provider adapter 放到下一阶段。

## 0.2 2026-05-22 TODO 文档拆分

- **用户请求**: 在新文件夹中编写 TODO 文档，采用 BabeL-X 同样的拆分 TODO 文档结构。
- **实现结果**:
  - 新增 `docs/nexus/README.md`。
  - 新增总控 `docs/nexus/TODO.md`。
  - 新增主线文档：
    - `TODO_runtime.md`
    - `TODO_agents.md`
    - `TODO_provider_registry.md`
    - `TODO_tui.md`
    - `TODO_cleanup.md`
    - `TODO_performance.md`
    - `TODO_cli.md`
  - 新增 `docs/nexus/WORK_LOG.md`。
- **结构原则**:
  - 总控只写阶段、优先级和链接。
  - 子 TODO 维护具体任务。
  - `TODO_cli.md` 只做兼容导航，不作为主规划源。
  - `WORK_LOG.md` 只追加事实与验证。

## 0.3 2026-05-22 SQLite storage and lifecycle endpoints

- **用户请求**: 继续推进开发。
- **实现结果**:
  - 新增 `src/storage/SqliteStorage.ts`。
  - `NexusStorage` 增加 `getTask()` 和可选 `close()`。
  - `MemoryStorage` 补齐 `getTask()` 和 `close()`。
  - `createDefaultNexusRuntime()` 支持 `storagePath`。
  - `src/nexus/server.ts` 支持 `NEXUS_STORAGE_PATH`。
  - `babel-o nexus start` 支持 `--storage-path`。
  - 新增 `POST /v1/sessions/:id/input`。
  - 新增 `POST /v1/sessions/:id/cancel`。
  - 新增 `PATCH /v1/sessions/:id/tasks/:taskId`。
  - 新增 `POST /v1/sessions/:id/tasks/:taskId/claim`。
  - 新增 `POST /v1/sessions/:id/tasks/:taskId/complete`。
  - CLI 新增 `sessions resume` 与 `sessions cancel`。
  - `NexusEvent` 增加 `user_message`。
  - `SessionSnapshot` 增加 `lastUserInput`。
- **验证**:
  - `npm run typecheck` 通过。
  - `npm test` 通过，覆盖 SQLite session/event/task restart 与 session/task lifecycle endpoints。

## 0.4 2026-05-22 Service-safe tool allowlist

- **用户请求**: 继续推进开发。
- **实现结果**:
  - `ToolDefinition` 增加 `risk` 元数据。
  - 基础工具完成风险分类：Read/Grep/Glob=`read`，Write/Edit=`write`，Bash=`execute`，TaskCreate=`task`。
  - `LocalCodingRuntime` 增加工具策略，支持 allow-all 和 allowlist。
  - `createDefaultNexusRuntime()` 支持 `allowedTools`。
  - `src/nexus/server.ts` 支持 `NEXUS_ALLOWED_TOOLS`。
  - `babel-o nexus start` 支持 `--allowed-tools`。
  - 新增 `tool_denied` event。
  - 新增 `GET /v1/tools/audit`。
  - CLI 新增 `babel-o tools audit`。
  - `/v1/execute` 会根据 result success 标记整体成功/失败。
- **验证**:
  - `npm run typecheck` 通过。
  - `npm test` 通过，覆盖 tools audit、allowlisted Read 和 denied Bash。

## 0.5 2026-05-22 Runtime performance hardening

- **用户请求**: 继续推进，确保服务拥有 BabeL-X 同等级的高效性能服务。
- **实现结果**:
  - `/v1/sessions` 与 `/v1/runtime/status` 默认返回轻量 session 摘要，不再携带全量 events。
  - `NexusStorage.listSessions()` 增加 `includeEvents` 选项。
  - `NexusMetrics` 增加服务端 metrics。
  - 新增 `GET /v1/runtime/metrics`。
  - `POST /v1/execute` 增加服务端超时控制。
  - `LocalCodingRuntime` 支持 `AbortSignal` 传播到工具执行。
  - `Grep` / `Glob` 传播 `signal`，长任务可中断。
  - 新增长运行工具 timeout 测试和 session list 轻量化测试。
- **验证**:
  - `npm run typecheck` 通过。
  - `npm test` 通过，覆盖 timeout、metrics、session list lightweight。

## 0.6 2026-05-22 Benchmark core and execution gate

- **用户请求**: 继续推进，关键代码可以考虑复制 BabeL-X 后修缮。
- **实现结果**:
  - 从 BabeL-X 的 performance-core 思路中移植出 BabeL-O 版 `npm run benchmark`。
  - 新增 `scripts/benchmark-performance-core.ts`，输出机器可读 JSON。
  - `NexusMetrics` 增加 active/rejected execute 统计。
  - `ExecutionGate` 限制并发执行，超限快速 429。
  - `NEXUS_EXECUTE_TIMEOUT_MS`、`NEXUS_MAX_CONCURRENT_EXECUTIONS` 环境变量可配置。
  - CLI `nexus start` 新增 `--execute-timeout-ms` 和 `--max-concurrent-executions`。
- **验证**:
  - `npm run typecheck` 通过。
  - `npm test` 通过，新增并发闸门测试。
  - `npm run benchmark` 通过，输出 JSON benchmark 结果。

## 0.7 2026-05-22 Session event pagination

- **用户请求**: 继续根据 TODO 文档推进。
- **实现结果**:
  - `NexusStorage.getSession()` 增加 `includeEvents` 选项。
  - `NexusStorage.listEvents()` 增加分页接口。
  - `MemoryStorage` 支持事件分页，并修复轻量 session 保存时覆盖历史 events 的问题。
  - `SqliteStorage` 支持事件分页，并新增 `events_session_key_idx`。
  - `GET /v1/sessions/:sessionId` 默认只返回最近 events。
  - 新增 `GET /v1/sessions/:sessionId/events?limit&cursor&order`。
  - CLI 新增 `babel-o sessions events <sessionId>`。
- **验证**:
  - `npm run typecheck` 通过。
  - `npm test` 通过，覆盖 recent events、events pagination。
  - `npm run benchmark` 通过。

## 0.8 2026-05-22 Tool output limits

- **用户请求**: 继续重写。
- **实现结果**:
  - 新增统一工具输出裁剪层 `src/tools/output.ts`。
  - `ToolContext` 增加 `maxOutputBytes` 和 `bashMaxBufferBytes`。
  - `tool_completed` event 增加 `truncated` 和 `originalBytes`。
  - `LocalCodingRuntime` 在 tool result 写入 event/storage 前裁剪输出。
  - `Bash` 工具使用可配置 `bashMaxBufferBytes`。
  - `POST /v1/execute` 支持 `maxToolOutputBytes`。
  - Nexus 服务支持 `NEXUS_MAX_TOOL_OUTPUT_BYTES` 和 `NEXUS_BASH_MAX_BUFFER_BYTES`。
  - CLI `nexus start` 新增 `--max-tool-output-bytes` 与 `--bash-max-buffer-bytes`。
  - CLI 渲染 truncated tool output 提示。
- **验证**:
  - `npm run typecheck` 通过。
  - `npm test` 通过，覆盖工具输出裁剪和 Bash maxBuffer 安全失败。
  - `npm run benchmark` 通过。

## 0.9 2026-05-22 Stream execution hardening

- **用户请求**: 继续推进。
- **实现结果**:
  - `/v1/stream` 接入 execution gate，超限返回 `EXECUTION_BUSY`。
  - `/v1/stream` 支持 `timeoutMs` 和 socket close cancellation。
  - `/v1/stream` 向 runtime 传递 `AbortSignal`、`maxToolOutputBytes`、`bashMaxBufferBytes`。
  - `NexusMetrics` 增加 stream metrics：active、count、timeout、rejected、clientClosed、sentEventCount、maxBufferedAmount。
  - stream send 后记录 `socket.bufferedAmount`，作为 backpressure 观察入口。
  - 新增 WebSocket stream 测试，覆盖正常执行、timeout、并发拒绝。
- **验证**:
  - `npm run typecheck` 通过。
  - `npm test` 通过，15 个测试全部通过。
  - `npm run benchmark` 通过。

## 0.10 2026-05-22 Formal benchmark and startup trace

- **用户请求**: 继续推进重写，选中 TODO 中“尚未建立正式 benchmark”和“尚未记录 startup trace”。
- **实现结果**:
  - `npm run benchmark` 升级为正式机器可读 benchmark，`type` 改为 `performance_benchmark`，增加 `schemaVersion`。
  - benchmark 覆盖 `/health`、`/v1/runtime/status`、`/v1/execute hello`、Read、Grep、Bash。
  - benchmark 增加 SQLite storage restart。
  - benchmark 增加 CLI `--help` startup 和 embedded `run hello`。
  - 新增 `src/cli/startupTrace.ts`。
  - `BABEL_O_STARTUP_TRACE=1 npm run cli -- --help` 输出 `startup_trace` JSON。
- **验证**:
  - `npm run typecheck` 通过。
  - `npm test` 通过，15 个测试全部通过。
  - `npm run benchmark` 通过。
  - `BABEL_O_STARTUP_TRACE=1 npm run cli -- --help` 输出 startup trace。

## 0.11 2026-05-22 Provider & Model Registry v1

- **用户请求**: 稳步推进重写，落实 Provider & Model Registry v1。
- **实现结果**:
  - 扩展 `src/providers/registry.ts` 中的 `ProviderDefinition`，增加支持的 model ID 列表。
  - 定义 `ModelDefinition` 并填充 built-in 常用模型的能力矩阵（如 context window、tool calling、json output、streaming 等）。
  - 实现自定义错误类 `UnknownProviderError` 与 `UnknownModelError`。
  - 实现查找辅助函数 `getProvider(id)` 与 `getModel(id)`。
  - 新增单元测试 `test/providers.test.ts`。
- **验证**:
  - `npm run typecheck` 通过。
  - `npm test` 通过，20 个测试全部通过（新增 5 个模型注册测试）。

## 0.12 2026-05-22 Real Provider Adapters, Config CLI & LLMCodingRuntime Integration

- **用户请求**: 稳步推进真实提供商（Anthropic 与 OpenAI）适配器与 LLM 运行时（LLMCodingRuntime）的集成，支持安全的本地配置管理。
- **实现结果**:
  - **厂商模型适配器**: 实现 `ModelAdapter` 规范。新增 `AnthropicAdapter`，支持提示词缓存、thinking 思考预算设置、BEDROCK 与 VERTEX 环境变量路由；新增 `OpenAIAdapter` 支持 OpenAI completions SSE 响应及工具结果结构映射。
  - **安全配置管理**: 新增 `ConfigManager`，将敏感凭证保存在 `~/.babel-o/config.json` 中，通过 `0o600` 权限限制读取，并提供优先级处理规则（环境变量 > 本地配置 > 预置默认值）。
  - **LLM 运行总控驱动**: 新增 `LLMCodingRuntime`，管理核心 Agent 工具执行循环（顺序解析流式 delta、触发 allowlist 边界阻断、输出 thinking 思考块、注入合成失败响应以恢复中断的工具链状态）。
  - **CLI 命令行补充**: 注册 `config` 与 `models` 二级命令，实现 API key 安全打码展示，支持模型详情查询。
  - **自动化集成测试**: 新增 `test/runtime-llm.test.ts` 测试套件，深度覆盖 `ConfigManager` 的保存、加载与优先级解析逻辑，以及 `LLMCodingRuntime` 对正常流、工具顺序流、拦截流和容灾逻辑的模拟验证。
- **验证**:
  - `npm run typecheck` 通过。
  - `npm test` 通过，全量 32 个测试用例全部绿灯通过（新增 7 个集成测试用例）。
  - 手动通过 CLI 运行 `npm run cli -- models list` 及 `npm run cli -- config list` 功能均正确。

## 0.13 2026-05-22 Fix TypeScript types in test mock events & verify

- **实现结果**:
  - 修复 `test/runtime-llm.test.ts` 中 `mapEventsToMessages` 测试套件的编译报错，为模拟的 `NexusEvent` 对象添加了必须的 `schemaVersion: '2026-05-21.babel-o.v1'` 字段。
  - 更新 TODO 相关子文档（`TODO_runtime.md` 与 `TODO_tui.md`），将已交付的 `/v1/execute` 超时控制、`config` 与 `models` 二级 CLI 命令等清单项标记为已完成。
- **验证**:
  - `npm run typecheck` 成功通过，没有任何 TypeScript 编译报错。
  - `npm test` 成功运行并通过全部 32 个测试。

## 0.14 2026-05-22 TODO/WORK_LOG reconciliation after provider runtime development

- **用户请求**: 用户进一步开发和完善项目后，核对 TODO 文档和工作记录文档。
- **核对结果**:
  - 当前 CLI binary 已是 `bbl`，`package.json` 仅发布 `bin/bbl.js`。
  - 当前仓库 remote 已连接到 `https://github.com/SuTang-vain/BabeL-O.git`。
  - `.gitignore` 已排除 `docs/`、`*TODO*.md`、`*WORK_LOG*.md`、`*ANALYSIS*.md`、`*PLAN*.md` 等本地规划/技术细节文档，避免上传。
  - `src/providers/registry.ts` 已扩展 provider/model registry，并提供 `getProvider()`、`getModel()`、`getAdapter()`。
  - `src/providers/adapters/` 已新增 `ModelAdapter`、`AnthropicAdapter`、`OpenAIAdapter`、`LocalAdapter` 与 SSE parser。
  - `src/shared/config.ts` 已新增 `ConfigManager`，默认使用 `~/.babel-o/config.json`，写入权限为 `0o600`。
  - `src/runtime/LLMCodingRuntime.ts` 已新增真实 provider stream、tool loop、result aggregator 第一版，并支持 `thinking_delta`。
  - `src/cli/program.ts` 已注册 `bbl config add/list/use` 与 `bbl models list/inspect`。
  - `src/cli/renderEvents.ts` 已支持连续渲染 `assistant_delta` 与 `thinking_delta`。
  - `test/providers.test.ts`、`test/adapters.test.ts`、`test/runtime-llm.test.ts` 已覆盖 provider registry、adapter SSE 映射、ConfigManager 与 LLMCodingRuntime mocked flow。
- **文档同步**:
  - `TODO.md`、`TODO_provider_registry.md`、`TODO_runtime.md`、`TODO_tui.md`、`TODO_cli.md`、`TODO_cleanup.md`、`TODO_performance.md` 已与当前实现对齐。
  - 当前仍保持未完成状态的事项包括：provider options schema、usage 归一、provider error 归一为 Nexus `PROVIDER_ERROR`、structured output mocked smoke、真实 provider smoke、权限确认 UI、完整 request context/model/budget、workspace realpath 安全边界。
- **验证**:
  - `npm run typecheck` 通过。
  - `npm test` 通过，32 个测试全部通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-doc-check-config.json npm run cli -- models list` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-doc-check-config.json npm run cli -- models inspect local/coding-runtime` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-doc-check-config.json npm run cli -- config list` 通过，默认解析到 `local/coding-runtime`。

## 0.15 2026-05-22 Agent Coordination Loop & Self-Optimization Framework

- **用户请求**: 开始执行多智能体协作循环与自优化框架的开发。
- **实现结果**:
  - **核心数据结构升级**: 扩展核心 shared schemas 和 SQLite 存储底层，支持任务与会话细粒度状态的持久化及重启恢复，初始化自适应运行增量表结构变动 (`ALTER TABLE`)。
  - **多角色协作流程**: 实现 Planner/Executor/Critic 等基本角色，成功将 Planner 拆解子任务，Executor/Optimizer 认领执行，Critic 进行终态代码审核与修正建议等任务协作流移植到 BabeL-O。
  - **自优化机制 (Self-Optimize)**:
    - 引入 `bbl optimize` 命令行，支持 `--target` 等参数自定义范围。
    - 自带沙箱拦截机制：在 `optimizer` 角色执行时，严禁修改系统/包配置文件 (`package.json`, `.env*` 等)，且拦截高危命令 (`rm -rf`, `sudo` 等)。
    - 内建 Git 状态维护：开启优化前自动执行 `git stash` 保护本地工作区；执行失败/Critic 拒绝时通过 `git reset --hard` 回滚；执行成功则提交（`git commit`），退出时恢复（`git stash pop`）工作区。
  - **死锁问题修复**: 解决了原重试任务中因无法重置 Claim 时保留的 `ownerAgentId` 导致的任务被重复挂起死锁问题。
- **验证**:
  - `npm run typecheck` 通过。
  - `npm test` 通过（全量 36 个用例），成功验证自优化安全规则以及死锁释放重试机制。

## 0.16 2026-05-22 Interactive permission flow and CLI approval logic

- **用户请求**: 实现高风险工具安全确认与交互式提权流程，并对之前的测试超时失败进行定位和验证。
- **实现结果**:
  - **核心提权单例注册中心**: 移除了不稳定的 `safety.ts` 与 `PendingPermissionRegistry.ts`，合并统一归入到 `src/shared/session.ts`，彻底消除了动态模块 ESM 加载时出现的单例分裂和 TSX 解析死锁隐患。
  - **流程拦截控制**: 重新细化并实现了在 `LocalCodingRuntime` 与 `LLMCodingRuntime` 中遇到 `write` 或 `execute` 工具时的拦截控制流，生成 `permission_request` 悬空 promise 状态直到外部触发。
  - **HTTP/WS 提权响应**: 接入并补齐 Fastify API 提权处理器（`/approve`，`/deny`，`/input`）以及 WebSocket `/v1/stream` 监听事件，打通客户端的交互提权。
  - **排查并发测试冲突**: 定位了之前多进程并发执行测试导致 CPU/端口争抢卡顿而引起的 3 秒轮询超时问题。清理全部后台残留测试进程，通过串行化保障了交互流程的顺畅执行。
- **验证**:
  - `npm run typecheck` 通过。
  - 补充 `test/permission-flow.test.ts` 以完整验证 HTTP POST 批准、HTTP POST 拒绝以及 WebSocket 批准提权，单次执行耗时约 150ms。
  - 进行 10 轮压力测试循环（总计 390 项用例），全量测试 100% 成功，没有任何失败或泄露。

## 0.17 2026-05-22 Documentation status correction after permission-flow review

- **用户请求**: 修正文档。
- **核对结果**:
  - `P1 Service-Safe Permissions` 的交互确认第一版已经落地：`permission_request` / `permission_response` 事件、`PendingPermissionRegistry`、HTTP `/approve` / `/deny`、WebSocket `permission_response` 和 CLI 交互路径均有代码与测试覆盖。
  - 该主线尚不能标为完全完成：持久化 permission audit、断线重连后的 pending permission 恢复、默认绑定 `127.0.0.1`、远程部署 `NEXUS_API_KEY` 要求仍未完成。
- **文档修正**:
  - 将 `docs/nexus/TODO.md` 中 `P1 Service-Safe Permissions` 从“已完成”修正为“进行中：交互确认第一版已完成”。
  - 在 `docs/nexus/TODO_runtime.md` 的 P1 Security 下补充当前状态说明，明确已完成项和收尾项。
- **验证**:
  - 本轮复核执行 `npm run typecheck` 通过。
  - 本轮复核执行 `npm test` 通过，39 个测试全部通过。
  - 未在本轮复现 0.16 中记录的 10 轮压力测试。

## 0.18 2026-05-22 Bash Tool Directory & State Retention (CWD Retention)

- **用户请求**: 继续推进下一步，重写 Bash 工具以实现 CWD 状态保持。
- **实现结果**:
  - **状态存储**: 在 `src/tools/builtin/bash.ts` 中引入模块级 `sessionCwdMap`，在进程级记录并追踪每个 `sessionId` 最后的 CWD。
  - **状态探测软拦截 (State Probing)**: 放弃依赖复杂的原生二进制依赖（如 `node-pty`），采用状态探测后缀拦截方案。在每个执行的 Shell 命令后方追加注入探测脚本 `pwd -P` 并在 stdout 输出指定格式的 demarcator 标记 `---BABEL_O_STATE---`。
  - **零残留过滤**: 在 Node.js 执行完成后拦截并截除 `stdout` 中注入的探测标记及其后的 CWD 输出，还原干净的原始命令输出。
  - **容错处理**: 在执行报错（如退出码非 0）时捕获并读取 `err.stdout`，保证即便运行失败，前面执行的目录迁移也能被解析更新，并对 `err.message` 进行裁剪改写，完全遮掩注入的探测痕迹。
- **验证**:
  - `npm run typecheck` 通过。
  - `test/runtime.test.ts` 新增集成测试 `bash tool session CWD retention`。验证了正常跳转、连续状态保留、失败跳转防御、多 session 会话 CWD 隔离。
  - `npm run test` 通过，全量 40 项测试全部成功。

## 0.19 2026-05-22 Service-safe permissions and API Key authentication hardening

- **用户请求**: 继续推进下一步，完成 P1 Service-Safe Permissions 鉴权与安全绑定收尾。
- **实现结果**:
  - **安全绑定验证**: 在 `src/nexus/app.ts` 中实现 `isLocalHost()` 和 `validateSecurityConfig()`。当 `NEXUS_HOST` 绑定非 localhost (例如 `0.0.0.0`) 且 `NEXUS_API_KEY` 为空时，服务启动抛出安全配置错误并以 `1` 退出。
  - **全局鉴权拦截**: 在 `src/nexus/app.ts` 中注册 onRequest Fastify 拦截 Hook。若 `NEXUS_API_KEY` 存在，除 `/health` 外的所有 API 必须通过 `X-Nexus-API-Key` 或 `Authorization: Bearer <key>` 鉴权，失败直接通过 Fastify `reply.code(401).send(...)` 短路返回 `401 Unauthorized`。
  - **客户端与 WebSocket 附带凭证**:
    - 更新 `src/cli/NexusClient.ts` 发送 HTTP 请求时自动携带 `X-Nexus-API-Key` 标头。
    - 更新 `src/cli/program.ts` 创建 WebSocket 连接时，若存在 API Key，则传入对应的握手 headers。
  - **集成安全测试**:
    - 新增 `test/security.test.ts`，彻底覆盖 `isLocalHost` 与 `validateSecurityConfig` 的单元测试、HTTP 鉴权（无 key、错 key、正确 key、Authorization 标头），以及 WebSocket 握手拦截，确保在 `try...finally` 块中清理服务监听端口防止端口泄露。
- **验证**:
  - `npm run typecheck` 通过。
  - `npm test` 通过，全量 44 项测试全部绿灯通过（新增 4 个安全测试用例）。

## 0.20 2026-05-22 SQLite Tool Traces and Cursor Pagination

- **用户请求**: 保存 tool traces 并实现游标分页。
- **实现结果**:
  - **数据结构与模式**: 定义 `ToolTrace` 接口，在 `SqliteStorage` 中建立 `tool_traces` 表并为 `(session_id, started_at)` 创建索引。
  - **运行时集成**: 在 `MemoryStorage` 和 `SqliteStorage` 的 `appendEvent` 中自动拦截 `tool_started` 和 `tool_completed` 事件，自动创建/更新 traces 记录并计算耗时。
  - **复合游标分页 (Composite Cursor Pagination)**: 使用 `${startedAt}|${toolUseId}` 复合游标分页机制，规避 ISO 时间戳冒号 `:` 引起的解析冲突，确保同一时间戳下并发工具执行分页的绝对稳定性。
  - **REST API 端点**: 暴露 `GET /v1/sessions/:sessionId/tool-traces`，支持 `limit`、`order` 和 `cursor` 复合参数查询。
  - **测试与并发优化**:
    - 新增 `test/tool-trace.test.ts` 覆盖持久化、状态更新、游标解析与 REST API 端点校验。
    - 在 `package.json` 的测试脚本中添加 `--test-concurrency=1` 参数，确保单元/集成测试串行执行，避免因多线程并发 ESM 模块动态解析或端口冲突引起的不稳定性。
- **验证**:
  - `npm run typecheck` 通过。
  - `npm test` 通过，全量 47 项测试用例全部通过。

## 0.21 2026-05-22 Completed P1 Runtime, Security and Storage rewrite

- **用户请求**: 稳步推进并彻底完成 P1 级 Runtime / Security / Storage 改造任务。
- **实现结果**:
  - **Request Context 补全**: 传递并统一了完整 `RuntimeExecuteOptions` 参数（包括 `requestId`，`model`，`budget`），在会话初始化及运行事件中传递上下文参数。
  - **全局标准错误码统一**: 整合并统一了系统核心错误码，包括 `INVALID_REQUEST`、`SESSION_NOT_FOUND`、`TOOL_DENIED`、`REQUEST_TIMEOUT`、`PROVIDER_ERROR`。
  - **JSON Schema 获取路由**: 新增了 `GET /v1/schema/events` 路由，能动态获取 `NexusEvent` 的 Zod schemas 导出的 JSON schema 结构。
  - **SQLite Schema 自动迁移与 Version 控制**: 在 SQLite 初始化逻辑中采用 `PRAGMA user_version` 进行版本检查和库迁移（当前升级到 v2，自动生成并检测 `permission_audits` 表）。
  - **Symlink Escape 边界防护**: 升级 `resolveInsideWorkspace` 路径处理逻辑，解析 realpath 保证无法利用软链接跨越 CWD 目录。
  - **Workspace Allowlist 白名单**: 提取了 `NEXUS_ALLOWED_WORKSPACES` 环境变量和 `--allowed-workspaces` 参数并在 Fastify 接收 execute/stream 请求时拦截所有跨目录工作区请求。
  - **默认拒绝高危工具 (Deny-by-default)**: 设置 `denyByDefaultTools()` 默认拦截 Bash/Write/Edit 高风险工具，允许在 `createRuntime` 时传入 `allowedTools: ['*']` 显式解封，并在 `test/runtime.test.ts` 相关测试中修改以适配新策略。
  - **Permission Audit 持久化**: 引入了 `permission_audits` 审计流水存储接口与数据表，每次在授权决策（Approve/Deny）完成后记录详细日志，提供 `GET /v1/sessions/:sessionId/permission-audits` 供管理审计查询。
- **验证**:
  - `npm run typecheck` 绿灯通过，无 TypeScript 编译警告。
  - `npm test` 绿灯通过（全量 50 项单元与集成测试用例全部通过），包括新增的 `test/security.test.ts` 安全防线测试。

## 0.22 2026-05-23 Multi-turn Session Persistence and Resume Support

- **用户请求**: 继续推进之前未完成的会话恢复与多轮对话记忆工作。
- **实现结果**:
  - **会话持久化与恢复**: 修改 `src/cli/program.ts` 的 `bbl chat` 命令，使其在交互式会话生命周期内共享同一个 `sessionId` 而不是为每次输入生成新 ID，并增加 `--session <id>` 选项。在启动时自动获取并渲染该 session 的历史交互（包括用户 prompt、assistant 输出与工具调用轨迹）。
  - **嵌入式环境状态同步**: 升级 `runSessionFlow`，在本地嵌入式 SQLite 模式下在保存前先执行 `getSession`，如已存在则更新 metadata（`phase` 改为 `executing`，记录 `lastUserInput` 和 `updatedAt`），并写入 `user_message` 事件，与 API 服务端行为完全对齐。
  - **集成测试**: 在 `test/runtime.test.ts` 中新增集成测试 `/v1/execute session reuse and history mapping` 覆盖会话的多轮重用及历史事件映射。
- **验证**:
  - `npm run typecheck` 通过。
  - `npm test` 通过，全量 51 项测试全部成功。

## 0.23 2026-05-23 Row-level Diff Rendering and History Search Command

- **用户请求**: 稳步推进建议一，实现行级 Diff 对比渲染器与命令历史检索。
- **实现结果**:
  - **最长公共子序列（LCS）Diff 算法**: 新增零依赖模块 `src/cli/diffLcs.ts`，实现基于 LCS 算法的行级对比。
  - **统一红绿 Diff 渲染**: 重构 `src/cli/diff.ts` 中对 `Edit` 工具的对比输出，将其由大块替换升级为像 `git diff` 一样精准的行级统一对比渲染（新增行绿 `+`，删除行红 `-`，普通行灰缩进）。
  - **终端历史指令检索与运行**:
    - 在 `src/cli/program.ts` 的 chat 循环中新增 `/history` 指令查看历史记录，`/history <keyword>` 过滤历史记录，以及 `/history !<idx>` 重新运行指定编号的历史命令。
    - 将 `/history` 指令注册到 readline autocomplete 自动补全中，并更新了 `/help` 菜单。
    - 修复了被误删的 `/sessions` 管理指令。
  - **单元测试**: 新增测试文件 `test/diff.test.ts` 以检验 LCS 算法和渲染正确性，并在 `package.json` 中配置运行该测试。
- **验证**:
  - `npm run typecheck` 编译成功。
  - `npm test` 绿灯通过，全量 54 项单元与集成测试用例全部通过。

## 0.24 2026-05-23 Provider Error and Token Usage Normalization

- **用户请求**: 稳步推进建议二，实现 Provider 错误与 Usage 消耗归一化。
- **实现结果**:
  - **错误归一化**: 在 `src/shared/errors.ts` 中新增继承自 `NexusError` 的 `ProviderError`，用于在底层网络失败或 HTTP 状态为非 2xx 时封装结构化细节。
  - **Usage 归一化**:
    - 在 `src/shared/events.ts` 中新增 Zod 模型 `UsageEventSchema` 并在全局事件联合类型中注册；在 `src/providers/adapters/ModelAdapter.ts` 中补充 `UsageDelta` 类型。
    - 修改 `src/providers/adapters/AnthropicAdapter.ts` 从 stream 的 `message_start`（包含输入 token、缓存统计）和 `message_delta`（包含最终输出 token）事件中解析并 yield `usage` delta。
    - 修改 `src/providers/adapters/OpenAIAdapter.ts` 传入 `stream_options: { include_usage: true }` 并从流末尾的 chunk 解析并 yield `usage` delta。
    - 升级 `src/runtime/LLMCodingRuntime.ts` 使得所有流式 `usage` 自动作为标准事件 yield 出去，并在 `executeStream` 的 catch 块中优先使用自定义 `NexusError` 的 `code` 属性。
  - **单元测试**: 在 `test/adapters.test.ts` 中新增了 `throws ProviderError on non-200 response` 与 `yields usage stats...` 等 4 个针对 Anthropic 和 OpenAI adapter 的测试用例。
- **验证**:
  - `npm run typecheck` 编译通过。
  - `npm test` 绿灯通过，全量 58 项测试用例全部通过。

## 0.25 2026-05-23 Documentation status reconciliation before repository push

- **用户请求**: 先更新文档准确性，然后提交推送仓库。
- **核对结果**:
  - 总控 `TODO.md` 中 `P2 Performance Hardening` 仍标为“待开始”，但 `TODO_performance.md` 已记录正式 benchmark、startup trace、tool output limit、stream backpressure、分页与并发闸门等已完成项，因此修正为“进行中”。
  - `TODO.md` 的 `P1 Real Provider Runtime` 说明仍把 usage 归一列为待跟进，但 provider 子文档与代码已完成 usage/provider error 归一，因此修正说明，仅保留 provider options schema、真实 provider smoke 与 structured output 验证为待收口。
  - `TODO_tui.md` 当前状态存在“已勾选但文字仍写尚未有权限确认 UI”的口径冲突，修正为“已支持权限确认 UI”。
  - `TODO_cli.md` 是兼容导航页，不承载主规划；其迁移状态同步为 slash command 与权限确认 UI 已实现，并指向 `TODO_tui.md` 作为主清单。
- **后续仍未收口**:
  - provider options schema、`models inspect` 展示 provider auth mode/adapter、structured output mocked smoke、真实 provider smoke。
  - task/Todo status panel、model/profile switching、MCP tool/resource display。
  - 大量 session/event API 压测、chat 首响 benchmark、Grep/Glob result limit、route handler O(n) 审计、SQLite 索引审计。

## 0.26 2026-05-23 Zhipu and MiniMax provider seeds

- **用户请求**: 进一步开发并记录后，核对当前进度。
- **实现结果**:
  - 在 `src/providers/registry.ts` 中新增 Zhipu / GLM provider seed，默认使用 Anthropic-compatible adapter，默认端点为 `https://open.bigmodel.cn/api/anthropic`，并登记 `zhipu/glm-5.1`、`zhipu/glm-5`、`zhipu/glm-5-turbo` 模型能力矩阵。
  - 在 `src/providers/registry.ts` 中新增 MiniMax provider seed，默认使用 Anthropic-compatible adapter，默认端点为 `https://api.minimaxi.com/anthropic`，并登记 `MiniMax-M2.7`、`MiniMax-M2.7-highspeed`、`MiniMax-M2.5`、`MiniMax-M2.5-highspeed`、`MiniMax-M2.1`、`MiniMax-M2` 模型能力矩阵。
  - 在 `src/shared/config.ts` 中新增 Zhipu 与 MiniMax 的 provider-specific 环境变量解析，包括 `ZHIPU_API_KEY` / `ZHIPUAI_API_KEY`、`ZHIPU_BASE_URL` / `ZHIPUAI_BASE_URL`、`MINIMAX_API_KEY` / `MINIMAX_AUTH_TOKEN`、`MINIMAX_BASE_URL`。
  - 在 `src/providers/adapters/AnthropicAdapter.ts` 中根据 provider registry 的 `authMode` 选择鉴权头，并仅对原生 Anthropic 或显式 `ANTHROPIC_BETA` 注入 Anthropic beta header，避免对第三方兼容端点默认发送不兼容 beta。
  - 根据官方 Anthropic-compatible 文档核对后，将 MiniMax registry 鉴权模式校准为 `api-key`，保持直连 Anthropic Messages API 时使用 `x-api-key`。
  - 补充 `test/providers.test.ts` 与 `test/adapters.test.ts`，覆盖 Zhipu/MiniMax registry seed、模型矩阵和第三方 Anthropic-compatible header 行为。
- **验证**:
  - `npm run typecheck` 通过。
  - `npm test` 通过，全量 60 项测试用例全部通过。

## 0.27 2026-05-23 Lightweight CLI/TUI renderer

- **用户请求**: 进一步开发并记录后，核对当前进度。
- **实现结果**:
  - 在 `src/cli/renderEvents.ts` 中引入轻量 terminal renderer 第一版，支持 compact / expanded 双模式渲染，并通过 `Ctrl-O` 切换视图。
  - 新增 session 渲染状态管理：`startSession()`、`resumeSessionHistory()`、`redrawSession()`、`setActiveReadline()`，统一处理当前会话、历史恢复和 readline prompt 刷新。
  - 新增 spinner 状态：在 thinking、tool running 等阶段显示动态状态，并在 assistant delta、tool completion、result/error/permission request 时停止。
  - 将 assistant delta 保持直接流式输出，expanded 模式下显示 thinking delta，compact 模式下用 spinner 表达思考中状态。
  - 升级工具渲染：compact 模式显示单行工具摘要，expanded 模式显示完整 input、success/output、Edit/Write diff、permission request/response 和 tool denial 详情。
  - 在 `src/cli/program.ts` 中接入 renderer 状态，替换手写 session history 渲染，并为补全候选增加交互式下拉选择。
  - 新增 `test/tui-renderer.test.ts`，覆盖 compact/expanded 渲染、工具结果、拒绝和错误输出；`package.json` 已将该测试纳入 `npm test`。
- **验证**:
  - `npm run typecheck` 通过。
  - `npm test` 通过，全量 63 项测试用例全部通过。

## 0.28 2026-05-23 Interactive CLI Autocomplete Mappings and /model Config Wizard

- **用户请求**: 批准并推进重写，使得 BabeL-O 支持在 / 下拉选项中对工具自动完成进行映射，并参考 BabeL-X 实现交互式 `/model` 配置向导。
- **实现结果**:
  - **Tool Selection 自动完成映射**: 在 `src/cli/program.ts` 的 `completer` 中支持将 `/read` -> `read `、`/bash` -> `bash ` 等快捷下拉选项翻译为直接可执行的工具前缀，并保留常规控制指令（如 `/clear`、`/help` 等）。提取并导出了全局公共 `mapDropdownSelection()` 函数。
  - **安全状态保护与键盘事件流恢复**:
    - 为所有交互式 Prompt 控件（`chooseInteractive`、`promptSecret`、`promptText`、`runInteractiveDropdown`）增加了 `process.stdin.isRaw` 的状态恢复。
    - **键盘事件流恢复 (Stdin Flow)**: 修复了 `rl.question()` 结束后 readline 自动暂停 stdin 流导致交互向导无法通过键盘输入（方向键、字符、回车）的问题。在控件启动时显式调用 `emitKeypressEvents(process.stdin)` 和 `process.stdin.resume()`，并在退出清理时调用 `process.stdin.pause()` 返回挂起状态。
    - **方向键事件修复**: 经真实 PTY 复现发现清理 `data` listener 会移除 Node keypress parser 的底层解析器，导致 `/model` 的 Provider 选择无法响应 ↑/↓。已改为只临时接管业务层 `keypress` listener，不清理 `data` listener，也不在控件退出后暂停 stdin，确保回到 `bbl>` 后 readline 可继续接收输入。
    - **方向键/控制键 Escape 序列兜底**: 在 `handleKey` 键盘事件分发中引入对原始 `chunk` 字节转义序列的兜底判断。在 `keypress` 解析器尚未完全准备或被挂起时，手动解析 `\x1b[A` (Up)、`\x1b[B` (Down)、`\r`/`\n` (Enter) 和 `\x1b` (Esc)，确保任何终端环境下方向键及确认取消功能 100% 坚固可用，同时自动屏蔽输入流中不慎掺杂的 `\x1b` 引导控制字符写入密码和文本字段。
    - **live 渲染修复**: 将执行过程中的 TUI renderer 从全量 `redrawSession()` 改为追加式 `renderLiveEvent()`，避免 `session_started`、`tool_started`、`result` 等事件重绘整段历史时和 readline 当前输入行互相覆盖，修复中文输入后出现重复 `bbl>` 输入、`bsession` 错位等问题。
  - **交互式 `/model` 配置向导**:
    - 在 `bbl chat` 命令接收到不带参数的 `/model` 时，触发交互式向导，支持 Provider、API Key、Base URL 和 Model ID 连贯交互配置。
    - **保留现有密钥**: 检测到 Provider 已有 API Key 配置时，提示 `(leave empty to keep existing key)` 允许用户直接回车保留。
    - **自定义 URL 的清除**: 支持输入 `-` 显式清除自定义 Base URL 并还原到提供商的默认 Endpoint。
  - **测试与模块隔离**:
    - 新增 `test/completer.test.ts` 覆盖 `mapDropdownSelection` 的各种分支（工具别名转换、控制命令保留、未知输入防错）。
    - 新增 renderer 测试覆盖 live `user_message` 忽略逻辑，避免 readline 已回显的输入在 TUI 事件流中被再次渲染。
    - 针对 `src/cli/program.ts` 在末尾注入了 `isMain()` 判断机制，确保在运行单元测试导入该模块时，不会受 `process.argv` 污染而错误执行 commander 命令行。
    - 将新测试登记到 `package.json` 的 `npm run test` 中，并通过 `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json` 隔离用户本机默认模型配置，避免测试因 `~/.babel-o/config.json` 指向真实 provider 而不稳定。
  - **工具 fallback**:
    - 为 `Grep` 和 `Glob` 增加 Node.js fallback：当系统没有 `rg` 或 PATH 中找不到 ripgrep 时，自动递归遍历工作区（跳过 `.git` / `node_modules`）完成内容搜索或文件列表过滤，避免出现 `TOOL_ERROR: spawn rg ENOENT`。
- **验证**:
  - PTY smoke：`/model` -> ↓↓ ↓↓ -> Enter 可切换到 `local`，返回 `bbl>` 后 `exit` 可正常退出。
  - PTY smoke：输入 `你好` 后不再重复渲染多条 `bbl> 你好`；live `user_message` 事件已在 renderer 中忽略，历史恢复仍由 `resumeSessionHistory()` 渲染。
  - PTY smoke：输入 `你是谁` 后输出采用追加渲染，不再出现重复输入行或 `bsession` 错位。
  - 工具 smoke：在空 `PATH` 下运行 `glob package` 不再报 `spawn rg ENOENT`。
  - `npm run typecheck` 通过。
  - `npm test` 通过，全量 69 项测试用例全部绿屏成功。

## 0.29 2026-05-23 CLI/TUI permission prompt wiring

- **用户请求**: 当前 CLI/TUI 中没有给用户提供权限选择选项，参考 BabeL-X 权限交互方式修复。
- **核对结果**:
  - `LocalCodingRuntime` / `LLMCodingRuntime` 已具备 `permission_request` -> `PendingPermissionRegistry` -> approve/deny 的挂起确认流。
  - 问题出在 `bbl chat` 本地 embedded path 创建 runtime 时未传入 `allowedTools`，导致 Bash/Write/Edit 在进入确认流前被 `denyByDefaultTools()` 直接策略拒绝，表现为 `Tool denied by Nexus policy: Bash`。
  - BabeL-X 对应语义是高风险工具先进入 ask/permission dialog，由用户明确 allow/deny；不是默认静默执行。
- **实现结果**:
  - `src/cli/program.ts` 的本地 embedded `bbl chat` 改为使用 `createDefaultNexusRuntime({ storagePath, allowedTools: ['*'] })`，让高风险工具进入单次权限确认流。
  - 保留默认 runtime 与 service runtime 的 deny-by-default 行为，避免放宽非交互服务安全边界；service 模式仍需通过 `--allowed-tools` 或 `NEXUS_ALLOWED_TOOLS` 明确开放可询问工具。
  - 权限询问提示由泛化的 `Approve tool execution? [y/n]` 改为 `Approve <Tool> (<risk> risk)? [y/N]`，默认回车为拒绝；确认交互改为单键 TUI 输入，`y` 批准，`n` 或 Enter 拒绝。
  - 本地 embedded permission prompt 改为异步处理，避免在 `permission_request` 事件持久化期间过早 resolve，导致 runtime 尚未注册 pending permission 而丢失用户选择。
  - `src/nexus/server.ts` 启动日志修正默认 allowedTools 口径，避免把默认 deny-by-default 误显示成 all。
  - 新增安全测试覆盖 `allowedTools: ['*']` 下高风险工具会触发 `permission_request`，且默认 policy denial 既有测试仍保留。
- **验证**:
  - `git diff --check` 通过。
  - `npm run typecheck` 通过。
  - `npm test` 通过，全量 70 项测试用例全部通过。
  - PTY smoke：`bbl chat` 输入 `bash "pwd"` 后出现 `Permission requested for Bash (execute risk)` 与 `Approve Bash (execute risk)? [y/N]`。
  - PTY smoke：按 `n` 会输出 `Permission denied`、`Bash denied`、`failed` 并返回 `bbl>`。
  - PTY smoke：再次输入 `bash "pwd"` 后按 `y` 会输出 `Permission approved`、`Bash completed`、`done` 并返回 `bbl>`。

## 0.30 2026-05-23 BabeL-X-inspired lightweight TUI second pass

- **用户请求**: 参考 BabeL-X 的 TUI 设计，包括 CLI 交互形式、用户输入框、模型工具调用显示、agent 运行显示、模型输出和 `/tool` 下拉列表，以更合适合理的方式重写。
- **参考结论**:
  - BabeL-X 的关键交互不是单个组件，而是“稳定输入底栏 + 候选列表 + 状态化消息流 + 工具专属显示 + 权限/agent 状态分层”。
  - BabeL-O 暂不引入完整 React/Ink 栈，先在现有 Nexus event stream 上实现轻量等价语义，避免扩大依赖和重写范围。
- **实现结果**:
  - 新增 `/tool` 工具选择面板，展示工具类别和用途说明；支持方向键选择和 Enter 执行对应工具前缀。
  - 新增 completion metadata：`describeCompletionChoice()` / `formatCompletionChoice()` / `getToolCompletionChoices()`，为 slash command 与工具候选提供标签、描述和统一格式。
  - `renderEvents.ts` 升级为更状态化的 TUI 输出：
    - `session_started` 渲染为 `agent <sessionId> model <model>` 状态行。
    - `tool_started` 渲染为工具运行块，显示工具名、输入摘要和 running 状态。
    - `tool_completed` / `tool_denied` 渲染为 done/failed/denied 状态块，expanded 模式保留完整 input/output/diff。
    - `task_session_event` 渲染为 `agent <phase> <event>`，补齐 agent 运行可观察性。
    - `usage` 在 expanded 模式显示 token 统计。
  - 将 chat 主循环从 `node:readline/promises` 切回 callback readline 并用 `questionAsync()` 包装，后续可继续对输入层做更细的 TUI 控制。
  - 保留 readline 默认 Tab 补全作为兜底；BabeL-X 风格的描述式候选面板由 `/tool` 确定入口承载，避免 Node readline Tab 行为在不同终端里不稳定。
- **验证**:
  - `git diff --check` 通过。
  - `npm run typecheck` 通过。
  - `npm test` 通过，全量 72 项测试用例全部通过。
  - PTY smoke：输入 `/tool` 后出现带 `[read]`、`[write]`、`[execute]` 等标签和说明的工具选择面板。
  - PTY smoke：`/tool` 选择 read 后执行并显示 `agent <sessionId> model local/coding-runtime` 状态行。
  - PTY smoke：执行 `bash "pwd"` 时显示 `Bash ... running`、权限确认、批准后 `Bash done` 与 `done`。

## 0.31 2026-05-23 RECOMMENDATIONS roadmap sync

- **用户请求**: 将 `docs/RECOMMENDATIONS.md` 中的建议更新到 TODO 文档中。
- **实现结果**:
  - `TODO.md` 增加 `RECOMMENDATIONS.md` 索引，并将当前优先级调整为 Context-Aware、MCP-Ready、Knowledge-First、P1 收口、P2 Performance。
  - `TODO_runtime.md` 新增 P0 Context-Aware Runtime、P0 MCP-Ready Runtime Extensions、P1 Knowledge-First Skills、P2 Smart Permissions 四个章节。
  - `TODO_agents.md` 补充 AgentTool 渐进演进路线：先 sub-task，再跨 session 委派，最后动态子 Agent。
  - `TODO_performance.md` 补充 Observability / Metrics：本地结构化日志、SQLite metrics、execute duration、first token、context size、tool roundtrip 等。
  - `TODO_cleanup.md` 补充不迁移 React/Ink、telemetry/analytics、复杂 plugin system 的规则，并加入 BabeL-X -> BabeL-O 文件映射表。
- **验证**:
  - 文档同步，无代码实现变更。
  - `git diff --check` 通过。

## 0.32 2026-05-23 Context-Aware runtime first slice

- **用户请求**: 根据最新 TODO 推进项目。
- **实现结果**:
  - 新增 `src/runtime/contextAssembler.ts`，实现 `ContextBudget`、`allocateBudget()`、`selectRecentEvents()` 和 `assembleContext()`。
  - 新增 `src/runtime/compactors/snipCompactor.ts`，对历史 `tool_completed.output` 做 head/tail 字符级截断；原始 events 仍保存在 SQLite，不改变审计数据。
  - 新增 `src/runtime/memory.ts`，加载 `<cwd>/.babel-o/memory.md` 并限制最大注入字符数。
  - `LLMCodingRuntime` 接入 context assembler，在调用 provider 前先选择近期事件、压缩历史工具输出并注入项目记忆。
  - `buildSystemPrompt()` 支持 Project Memory 块，并导出以便测试。
  - 新增 `test/context-assembler.test.ts`，覆盖预算分配、snip、近期事件选择、project memory 注入和消息映射前压缩。
  - `package.json` 将 `test/context-assembler.test.ts` 纳入 `npm test`。
- **仍未完成**:
  - 规则化 session summary 尚未实现。
  - Context benchmark 尚未建立，`TODO_runtime.md` 中 benchmark 项仍未勾选。
- **验证**:
  - `git diff --check` 通过。
  - `npm run typecheck` 通过。
  - `npm test` 通过，全量 76 项测试用例全部通过。

## 0.33 2026-05-23 Context-Aware rule-based session summary

- **用户请求**: 继续推进收口重写。
- **实现结果**:
  - 新增 `src/runtime/sessionSummary.ts`，对被 recent context 截掉的旧事件生成确定性规则摘要，不调用模型、不改写 SQLite 原始 events。
  - 摘要覆盖旧 user message 数量、assistant/thinking 字符量、工具调用统计、引用文件、权限拒绝、错误和旧 result 状态。
  - `contextAssembler` 现在区分 selected events 与 omitted events，只把 omitted events 生成 `Session Summary` 注入 system prompt，避免和近期完整上下文重复。
  - `buildSystemPrompt()` 支持 `Session Summary` 块，与 `Project Memory` 分层注入。
  - `test/context-assembler.test.ts` 增加规则摘要覆盖：长会话会注入摘要，短会话不生成摘要。
- **仍未完成**:
  - Context benchmark 尚未建立，`TODO_runtime.md` 中 benchmark 项仍未勾选。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/context-assembler.test.ts` 通过。
  - `npm run typecheck` 通过。

## 0.34 2026-05-23 Context-Aware benchmark gate

- **用户请求**: 继续任务。
- **实现结果**:
  - `scripts/benchmark-performance-core.ts` 新增 `Context assembly long session` benchmark，输出原始上下文字符数、装配后字符数、压缩率、selected/omitted/snipped event 数量以及最近轮次保留标记。
  - benchmark 主进程与 CLI 子进程均固定使用临时 `local/coding-runtime` 配置，避免读取用户本机真实 provider 配置导致 benchmark 卡住或依赖外部网络。
  - benchmark 对 Context-Aware 建立失败门槛：长会话上下文压缩率必须达到 50%+，且最近三轮 marker 必须保留，否则 `npm run benchmark` 直接失败。
  - `test/context-assembler.test.ts` 新增同等覆盖，确保 `npm test` 也会守住长会话 50%+ 压缩和最近三轮保留。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/context-assembler.test.ts` 通过。
  - `npm run typecheck` 通过。
  - `npm run benchmark` 通过；本机样本中 context 从 654,517 chars 降至 11,655 chars，压缩率 98.22%，保留 `recent-turn-37`、`recent-turn-38`、`recent-turn-39`。

## 0.35 2026-05-23 MCP-ready stdio first slice

- **用户请求**: 继续根据 TODO 文档推进重写。
- **实现结果**:
  - 新增 `src/mcp/McpClient.ts`，实现 JSON-RPC 2.0 over stdio 的 initialize、tools/list、tools/call、shutdown。
  - 新增 `src/mcp/McpRegistry.ts`，合并加载 `~/.babel-o/mcp.json` 与 `<cwd>/.babel-o/mcp.json`，server 配置默认 `allowedTools: []`。
  - 新增 `src/mcp/McpToolAdapter.ts`，将 MCP tool 注册为 BabeL-O tool，命名为 `mcp:<server>:<tool>`，并保留远端 input schema 给模型调用。
  - `createDefaultNexusRuntime()` 支持 `enableMcp` 与 `cwd`，默认仍不启用 MCP；service 可通过 `BABEL_O_ENABLE_MCP=1` 打开。
  - MCP tool 支持 `source` 元数据，`GET /v1/tools/audit` 与 `bbl tools audit` 可显示 source/server/originalName、risk 和 allowlist 状态。
  - MCP tool 执行前会检查 server 级 `allowedTools`，未显式白名单的工具返回失败；write/execute 风险继续复用现有 permission_request 流。
  - runtime storage close 时会 dispose MCP clients，避免 stdio server 子进程泄漏。
  - 新增 `test/fixtures/mock-mcp-server.mjs` 与 `test/mcp.test.ts`，覆盖注册、审计、allowlist 和执行。
- **仍未完成**:
  - 官方 MCP server e2e smoke 尚未补齐。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/mcp.test.ts` 通过。
  - `npm run typecheck` 通过。

## 0.36 2026-05-23 MCP official smoke and chat TUI layering

- **用户请求**: 推进 MCP 官方 server smoke 收尾，并改善 `bbl chat` 页面输入框、Bash 和信息分层显示。
- **实现结果**:
  - 新增 `npm run test:mcp:official`，由 `scripts/smoke-mcp-official.ts` 通过 npx 启动 3 个官方 MCP server：`@modelcontextprotocol/server-filesystem`、`@modelcontextprotocol/server-memory`、`@modelcontextprotocol/server-everything`。
  - 官方 smoke 覆盖 tools/list；filesystem 额外调用 `read_file` 读取临时文件，验证真实 tools/call。
  - MCP client 支持新版官方 SDK 的 JSONL stdio framing，同时保留旧 Content-Length framing 兼容本地 mock server。
  - MCP client 在 initialize 后发送 `notifications/initialized`，并 drain stderr，避免官方 server 输出导致管道阻塞。
  - `bbl chat` 输入提示从 `bbl>` 改为更接近输入框的 `> `。
  - TUI renderer 将 assistant、thinking、tool/bash、permission 和 result 分层显示；Bash 会以 `bash` 层标记，普通工具以 `tool` 层标记。
  - session 状态行压缩 session id 和过长 model id，避免截图中 model 名换行挤压。
  - `test/tui-renderer.test.ts` 增加 assistant 与 Bash/tool 分层断言。
- **验证**:
  - `BABEL_O_MCP_SMOKE_TIMEOUT_MS=90000 npm run test:mcp:official` 通过：filesystem 14 tools、memory 9 tools、everything 13 tools。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/tui-renderer.test.ts test/mcp.test.ts` 通过。

## 0.37 2026-05-23 Chat TUI block hierarchy polish

- **用户请求**: 当前模型输出层级仍不清晰，参考 Claude/Gemini 风格继续重写 TUI。
- **实现结果**:
  - `renderEvents.ts` 将 live 输出改为块状层级：assistant 回复使用 `⏺`，expanded thinking 使用 `▸ Thought`，工具调用使用 `● Tool(input)`。
  - 工具运行、完成、拒绝和权限确认不再和 spinner 粘连；`tool_started` 前主动停止 spinner。
  - 移除普通执行阶段对 stdin raw mode 的切换，只在交互控件/权限确认里临时接管键盘，修复 `bash "pwd"` 等命令在终端中重复回显的问题。
  - 修复权限拒绝后 `formatToolInput(undefined)` 引发的异常。
  - `test/tui-renderer.test.ts` 增加 `▸ Thought` 分块断言，并更新工具完成行断言为 `● ... done` 风格。
- **验证**:
  - PTY smoke：`bbl chat` 输入 `bash "pwd"` 只回显一次；Bash 行显示为 `● Bash({...}) running`；拒绝权限不会抛错，批准权限显示 `● ✓ Bash done`。

## 0.38 2026-05-23 Multi-level permission approval panel

- **用户请求**: 将权限确认从 `y/n` 改为图片中的上下选择、多级权限面板。
- **实现结果**:
  - `askPermission()` 从单键 `y/n` 升级为 approval panel，支持方向键上下选择、数字 `1/2/3/4` 快捷选择、Enter 确认、Esc 拒绝。
  - 权限选项包括 `Approve once`、`Approve for this session`、`Reject`、`Reject, tell the model what to do instead`。
  - `Approve for this session` 会在当前 CLI session 内缓存同一工具名，后续同工具 permission request 自动批准。
  - `Reject, tell the model what to do instead` 会收集用户说明，并作为 permission denial reason 返回给 runtime/model。
  - `permission_request` live 渲染不再额外打印旧的 `? Permission requested...` 行，避免和新 approval panel 重复。
  - 新增 `formatPermissionDialog()` 单元测试，防止权限 UI 退回单行 `y/n`。
- **验证**:
  - PTY smoke：`bash "pwd"` 出现 approval panel；按 `2` 批准本会话，第二次 Bash 自动批准。
  - PTY smoke：`write tmp-permission.txt hello` 按 `4` 后输入说明，runtime 收到对应拒绝原因且不抛错。

## 0.39 2026-05-23 Slash command dropdown palette

- **用户请求**: 当前项目 `/` 无法显示下拉列表，参考图片构建 `/` 下拉工具列表。
- **实现结果**:
  - `bbl chat` 增加 slash command palette：当前输入为 `/...` 且尚未包含参数空格时自动显示下拉候选。
  - 下拉列表采用两列布局：左侧命令，右侧描述；底部显示 `↑/↓ Navigate · tab Complete · enter Run`。
  - 支持上下键移动选中项，Tab 将当前选中命令补全到输入行；输入参数后自动关闭 palette，避免干扰 `/model xxx` 和自然语言输入。
  - 新增 `getSlashPaletteChoices()` 与 `formatSlashPalette()` 单元测试，覆盖过滤、描述渲染和参数后不弹出。
- **验证**:
  - PTY smoke：输入 `/` 后显示下拉列表；按 ↓ 后选中 `/clear`；按 Tab 后输入行补全为 `/clear`。

## 0.40 2026-05-23 P1 Knowledge-First Skills and prompt integration

- **用户请求**: 批准，继续稳步推进重写；更新todo文档和工作记录文档。
- **实现结果**:
  - 新增 `src/skills/loader.ts`，解析 markdown front-matter (id, triggers, priority, name)，并支持 built-in、user (~/.babel-o/skills) 和 project (<cwd>/.babel-o/skills) 三级目录覆盖。
  - 新增 `src/skills/matcher.ts`，基于触发词在 prompt 中匹配度、优先级和 id 进行多级排序，单次 query 最多匹配并提取 3 个 inline skills。
  - 新增 5 个内置技能 markdown 模板 (`coding`, `optimization`, `debugging`, `testing`, `git`) 放置于 `src/skills/built-in/`。
  - 改造 `src/runtime/contextAssembler.ts` 与 `LLMCodingRuntime.ts` 中的 `buildSystemPrompt`，将匹配到的技能拼装为 `Active Developer Skills` 结构化 markdown 文本注入到 LLM system prompt。
  - 新增 `test/skills.test.ts` 单元与集成测试，并在 `package.json` 的 `npm test` 中注册。
- **验证**:
  - `npm run typecheck` 通过.
  - `npm test` 通过，全量 93 个测试用例全部绿屏通过。

## 0.41 2026-05-23 P1 Wrapping-Up: provider validation, E2E smoke, profile switching, task status board

- **用户请求**: 批准，并且顺便完成 第一优先级：P1 收口 (P1 Wrapping-up)。主要目标是补齐现有 Provider、Model 与 任务界面的易用性与功能盲区，实现完整的功能闭环。同时检查并修正 DeepSeek 模型的选择映射以支持最新的 V4 模型（`deepseek-v4-pro` 和 `deepseek-v4-flash`），以及为项目的 TUI 界面用户输入添加上下输入框分割线。
- **实现结果**:
  - **Provider 参数校验**: 扩展 `src/shared/config.ts` 中的 `ProviderConfigSchema`、`ProfileConfigSchema` 和 `BabelOConfigSchema`，严格限制提供商参数格式（如 `apiKey` 最小长度及 `baseUrl` URL 格式），对 model/provider ID 结合 registry 进行存在性检查，并在配置加载出错时友好警示，避免擦除用户配置。
  - **DeepSeek V4 模型更新**: 更新 `src/providers/registry.ts` 和 `src/providers/adapters/OpenAIAdapter.ts` 以将 DeepSeek 模型首选映射切换到 `deepseek/deepseek-v4-pro` (默认旗舰推理模型) 和 `deepseek/deepseek-v4-flash` (快速高性价比模型)，保留 `deepseek-chat` (V3) 和 `deepseek-reasoner` (R1) 作为向后兼容选项，并确保 V4 Pro 在使用 OpenAI 适配器时能够正确命中并还原 `reasoning_content`。
  - **真实提供商冒烟测试**: 新增 `scripts/smoke-providers.ts`，对 Anthropic/OpenAI/DeepSeek 等真实厂商接口提供流式 E2E 测试，如未配置对应密钥则优雅跳过；在 `package.json` 中注册 `"test:providers:smoke"` 命令。
  - **模型/环境切换 (`/profile`)**: 在交互命令行中支持 `/profile` 列出配置、`/profile clear` 清理当前环境、`/profile add <name>` 基于当前配置克隆新环境、`/profile <name>` 切换活动配置。并在 `src/cli/program.ts` 中补全补全别名及 Tab 自动补全逻辑。
  - **任务状态看板**: 实现了任务状态跟踪逻辑 `formatTaskStatusPanel`，并在 `src/cli/renderEvents.ts` 的 `formatSessionHistory` 底部实时显示当前会话任务状态（规划中、执行中、已完成、已失败）。
  - **TUI 输入框分割线**: 优化 `src/cli/program.ts` 的会话输入循环，在用户输入提示符的前后均输出亮灰色细横线分割栏（`─`），实现用户输入区域与历史日志内容的视觉物理隔离。
  - **测试覆盖**:
    - 在 `test/runtime-llm.test.ts` 中补充 ConfigManager 校验及 profiles 切换用例。
    - 在 `test/tui-renderer.test.ts` 中补充 Task Status Panel 格式断言。
    - 在 `test/adapters.test.ts` 中新增 DeepSeek V4 推理序列化和 `(reasoning omitted)` 降级机制断言。
- **验证**:
  - `npm run typecheck` 成功无错。
  - `npm test` 通过，全量 97 个测试用例全绿通过。
  - `npm run test:providers:smoke` 成功运行并输出跳过/成功状态。

## 0.42 2026-05-23 Context boundary correction for long sessions

- **用户请求**: 继续核对聊天输入读取问题，并参考 BabeL-X 的上下文处理方式吸收更好的设计。
- **实现结果**:
  - 修复 `src/runtime/contextAssembler.ts` 的长会话截断策略：不再优先保留最早的用户开场，而是从最近窗口中的首个 `user_message` 开始切片，避免旧 `hi` 与残缺的早期历史污染模型上下文起点。
  - 在 `src/runtime/LLMCodingRuntime.ts` 的 `buildSystemPrompt()` 中加入 `Context Boundary` 段，明确提示模型“更早的历史已经压缩，最近消息才是权威工作历史”，吸收了 BabeL-X 的边界提示设计。
  - 更新 `test/context-assembler.test.ts`，增加对最新中文问题优先级与边界提示的回归断言。
  - 同步更新 `docs/nexus/TODO.md` 与 `docs/nexus/TODO_runtime.md` 的状态说明。
- **验证**:
  - `git diff --check` 通过。
  - `npm run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/context-assembler.test.ts test/runtime-llm.test.ts` 通过。

## 0.43 2026-05-23 TUI Input borders and full-width alignment polish

- **用户请求**: 为项目的 tui 界面用户输入添加上下输入框分割线，输入部分应该是有上下两条分割线，覆盖终端的左右边界。
- **实现结果**:
  - 优化 `src/cli/program.ts` 会话输入循环：在输入等待前通过 stdout 顺序绘制上线、空行和下线，并使用 ANSI `\x1b[2A` 将光标回退 2 行至输入行进行 readline 输入。输入完成后使用 `\x1b[1B\r` 将光标跨越下分割线。
  - 移除原分割线中 Math.min(..., 72) 的硬限制，改用 `process.stdout.columns || 80`。分割线会根据终端当前实际列宽大小动态调整，完美拉满到左右边界。
  - 修复 `/` 下拉补全菜单关闭时 `clearScreenDown` 擦除并丢失底部分割线的问题：在 `close()` 中增加 `wasOpen` 条件守卫，仅在菜单开启时执行重画下分割线和光标归位。
- **验证**:
  - 启动会话后显示完美的上下两条分割线，横跨整个终端左右边界。
  - 正常按下回车提交输入后，分割线完全对齐保留，没有任何多余的 `>` 符号。
  - 输入 `/` 弹出补全菜单并选择或 Esc 关闭后，下方的分割线重绘成功且位置保持一致。
  - 单元测试 97/97 全部通过。

## 0.44 2026-05-23 P2 Performance Hardening: Grep/Glob limits, Sqlite N+1 optimization, and CLI dynamic loading

- **用户请求**: 根据 todo 文档稳步推进重写任务：p2 性能优化硬化与硬边界。
- **实现结果**:
  - **Grep/Glob 结果安全限额**：在 `grep.ts` 及其 fallback 的 fs 遍历执行中，强制限制输出行数在 `maxMatches`（最大 200 行），超限时进行安全裁剪并追加 `... (matches truncated for context budget)` 说明。在 `glob.ts` 中切片输出结果至 `maxResults`，并在末尾追加说明元素，防止大项目文件搜索耗尽模型上下文。
  - **消灭存储 N+1 查询**：重构 `SqliteStorage.listSessions` 的多会话获取逻辑。当 `includeEvents: true` 时，用单次 `LEFT JOIN` 联合查询拼装全量数据，并在内存侧分组，代替以往查询 50 个会话需要进行 51 次数据库查询 the N+1 瓶颈。
  - **SQLite 复合索引与平滑升级**：重组 `tool_traces` 的索引结构为复合索引 `(session_id, started_at, tool_use_id)` 提升分页检索效率。设计 `user_version = 3` 数据库自动迁移，在初始化时自动 DROP 旧索引并建立新索引，保护已有 session 历史文件。
  - **CLI 3ms 启动懒加载**：重构 `src/cli/program.ts` 的头部静态引用，将 `createDefaultNexusRuntime`、`SqliteStorage` 等大型模块全部转换为 async action 内部的延迟 `await import`。`bbl --help` 启动时间由原本的 tsx 加载几百毫秒压缩到了 `3.07ms`（`cli.imported` 编译仅耗时 `0.06ms`），极大缩短了冷启动延迟。
  - **测试覆盖**：在 `test/runtime.test.ts` 中新增 Grep 与 Glob 限额截断的专门断言。
- **验证**:
  - `npm run typecheck` 成功通过。
  - `npm test` 通过，全量 100 个测试用例全部绿屏跑通。
  - `BABEL_O_STARTUP_TRACE=1 npm run cli -- --help` 显示冷启动耗时大幅减小至 3.07ms。
- **后续核对**:
  - 该阶段完成的是性能硬边界核心项；大量 session/event 压测、chat 首响 benchmark、retry benchmark 和结构化 logger 仍按 `TODO_performance.md` 跟进。
  - 2026-05-23 复核时发现 `rg --max-count=maxMatches` 无法判断是否还有更多匹配，已修正为探测 `maxMatches + 1` 条再裁剪，避免 truncation warning 缺失。

## 0.45 2026-05-23 P2 Smart Permissions: Automatic rule classifier and audit logging

- **用户请求**: 根据 todo 文档稳步推进开发重写：P2 智能权限分类。
- **实现结果**:
  - **规则分类器 (`src/runtime/classifier.ts`)**：实现对输入工具调用的自动分类逻辑。对 `Read`、`Grep`、`Glob` 等只读查询工具以及 `ls`、`pwd`、`cat`、`git status`/`diff`/`log`、`npm list`/`test` 等白名单内的 shell 安全命令执行自动批准（`autoApprove: true`）；而对 `Write`、`Edit` 以及存在高风险指令（`rm -rf`、`sudo`、`git push`、`npm publish` 等）或未知/非白名单的命令强制要求用户手动交互审批（`autoApprove: false`）。
  - **运行时流水线对接**：集成到 `LLMCodingRuntime` 与 `LocalCodingRuntime` 中。如果分类器断言可以自动批准，将跳过 `permission_request` 事件 yield 和 pending registry 注册，直接写入一条决策为 `approved`、原因为 `Auto-approved: [Reason]` 的审计记录到数据库 `permission_audits` 中，并直接调用工具。
  - **测试覆盖与修复**：
    - 新增 `test/classifier.test.ts` 以单元测试覆盖规则分类器的全部白名单、黑名单和默认拦截分支。
    - 在 `test/permission-flow.test.ts` 中新增两个集成测试：验证安全命令自动批准且无 `permission_request` 且存入 SQLite 审计中；验证危险命令拦截并正常派发 `permission_request` 悬空状态等待外部审批。
    - 修复 `test/security.test.ts` 中原本使用 `bash "pwd"` 预期必触发弹窗的用例（由于 `pwd` 现已被自动批准，已将其更新为非白名单的 `bash "make build"` 以通过断言）。
- **验证**:
  - `npm run typecheck` 成功通过。
  - `npm test` 成功通过，全部 105 个测试用例全部绿屏跑通（无一挂起或报错）。

## 0.46 2026-05-23 P2 Execution Environments and Observability Metrics

- **用户请求**: 根据 todo 文档和开发建议完成 p2 的开发重写。
- **实现结果**:
  - **多执行环境安全校验**：在 `app.ts` 的 `executeSchema` 校验中新增并规范化了 `executionEnvironment` 字段。仅限支持 `local` 执行环境；若请求参数中传递 `docker` 或 `remote`，在 HTTP API (/v1/execute) 及 WebSocket 握手 (/v1/stream) 中均会短路拦截并抛出 `501 NOT_IMPLEMENTED` 状态错误，强化系统执行环境安全隔离。
  - **SQLite 指标持久化 (`execution_metrics`)**：设计并执行了数据库模式自动升级（`user_version = 4`），自动创建 `execution_metrics` 存储表和 session_id 复合索引。
  - **运行时指标监控与上报**：重构了 `LLMCodingRuntime` 与 `LocalCodingRuntime` 级别的执行流。在每次会话执行时，自适应统计并生成包含：总执行时长（`execute_duration_ms`）、首包响应时长（`provider_first_token_ms`）、大模型请求耗时（`provider_request_duration_ms`）、流式 Delta 数量、工具执行次数与耗时统计、输入输出近似字符数的 `execution_metrics` 全量事件，随流结束后同步写入 SQLite 中，并主动回传更新至内存 `metrics` 快照以通过 `/v1/runtime/metrics` REST 接口提供实时查询。
  - **测试覆盖**：在 `test/runtime.test.ts` 中新增了 `executionEnvironment parameter validation` 及 `execution metrics recording and retrieval` 两个核心集成测试，分别覆盖环境拦截与指标搜集/持久化/接口快照逻辑。
- **验证**:
  - `npm run typecheck` 成功通过.
  - `npm test` 成功通过，全量 107 个测试用例 100% 全部通过。
- **后续核对**:
  - `executionEnvironment` 目前仅完成 local-only 参数校验和 docker/remote 的明确未实现拦截；Docker workspace mount、资源限制和 remote runner protocol 仍未设计落地。
  - Observability 已完成指标核心链路；结构化 logger 与 1000+ sessions 压测仍待补。

## 0.47 2026-05-23 P3/P4 Architectural Refactoring and Type Hardening

- **用户请求**: 根据todo文档稳步推进p0，务必严谨仔细。
- **实现结果**:
  - **CLI 子命令模块化拆分**：将原本臃肿的 `src/cli/program.ts`（超过 2100 行）进行拆分，将各子命令重构至单独的文件（`src/cli/commands/run.ts`, `src/cli/commands/chat.ts`, `src/cli/commands/nexus.ts`, `src/cli/commands/sessions.ts`, `src/cli/commands/tools.ts`, `src/cli/commands/config.ts`, `src/cli/commands/models.ts`, `src/cli/commands/optimize.ts`）。
  - **公共交互与补全解耦**：抽离 `src/cli/ui.ts` 整合输入询问、密钥获取和权限审批菜单，抽离 `src/cli/completer.ts` 集中处理 Readline 的快捷别名补全和斜杠下拉 palette，抽离 `src/cli/runSessionFlow.ts` 处理会话流控制。
  - **强类型收窄与消除 \`as any\`**：对 Zod to JSON Schema 结构映射、Websocket message 类型转换、SSE 管道检测等处大量的 \`as any\` 进行强类型收窄和 \`unknown\` 渐进式强制类型转换处理，全面消除类型逃逸。
- **验证**:
  - `npm run typecheck` 成功通过。
  - `npm test` 成功通过，107 个单元和集成测试用例 100% 成功。

## 0.48 2026-05-23 Bash Timeout Threshold Tuning

- **用户请求**: 修复 Bash 工具执行超时导致的 \`TOOL_ERROR: Command failed\` 报错。
- **实现结果**:
  - **超时限制放宽**：定位并调整了 `src/tools/builtin/bash.ts` 中的 Zod timeoutMs 校验限制，将最大可接受的超时限制由 `30,000ms` 提升至 `300,000ms`。
  - **默认超时提升**：将缺省命令的默认执行超时时长从过于仓促的 `10,000ms` 调高为 `60,000ms`（60秒），降低网络安装命令（如 `pip3 install`）或编译测试执行命令遭遇超时夭折的概率。
- **验证**:
  - `npm run typecheck` 成功通过。
  - `npm test` 成功通过，107 个用例 100% 成功。

## 0.49 2026-05-23 P2 Model Capability Routing — 声明式角色路由与底线拦截

- **用户请求**: 批准并稳步推进 P2 Model Capability Routing 的开发（声明式角色重写 + Gatekeeping 方案）。
- **实现结果**:

  - **配置 Schema 扩展 (`src/shared/config.ts`)**:
    - `ProfileConfig` 接口与 `ProfileConfigSchema` Zod 校验新增可选 `roles` 字段，支持用户为 `planner`、`executor`、`critic`、`optimizer` 四个 Agent 角色独立指定模型 ID。
    - `resolveSettings(role?: string)` 扩展为三层模型优先级解析：①`process.env.BABEL_O_MODEL`（最高）→ ②`profile.roles[role]`（角色专属覆盖）→ ③`profile.model` / `defaultModel` / `local/coding-runtime`（兜底）。

  - **Nexus 服务端前置拦截 (`src/nexus/app.ts`)**:
    - 在 `POST /v1/execute` 与 WebSocket `/v1/stream` 路由中，执行前通过 `getModel()` 查找目标模型在 `modelRegistry` 中的能力声明。
    - 若 `capabilities.toolCalling === false`，立即返回 `400 INVALID_REQUEST`，附错误消息 `Model "X" does not support tool calling`；WS 端则发送对应 error 事件。
    - 未注册的自定义模型允许通过，不受拦截影响。
    - 补充了缺失的 `import { ConfigManager } from '../shared/config.js'`，修复 TypeScript 编译报错。

  - **Agent 步骤运行器集成 (`src/nexus/runtimeAgentStep.ts`)**:
    - 每个 Agent 步骤执行前调用 `ConfigManager.getInstance().resolveSettings(roleDefinition.role)` 解析当前角色的目标模型 `targetModelId`。
    - 将 `targetModelId` 显式传递给 `runtime.executeStream({ model: targetModelId })`。
    - 对需要工具执行的角色（`toolPolicy.allowedTools.length > 0`，即 executor/optimizer），预检 `toolCalling` 能力，若为 `false` 直接抛出异常阻断，避免浪费 Token。

  - **模型能力声明修正 (`src/providers/registry.ts`)**:
    - 将 `deepseek/deepseek-reasoner`（R1 推理模型）的 `capabilities.toolCalling` 由 `true` 修正为 `false`，符合其实际 API 不支持 function calling 的特性。

  - **新增测试用例（+4 个，共 111 个）**:
    - `profile roles field is parsed and loaded by ProfileConfigSchema`（runtime-llm.test.ts）
    - `resolveSettings respects role override over profile model`（runtime-llm.test.ts）
    - `POST /v1/execute blocks model without tool calling support`（runtime.test.ts）
    - `WebSocket /v1/stream blocks model without tool calling support`（runtime.test.ts）
    - providers.test.ts 补充断言验证 `deepseek-reasoner` 的 `toolCalling: false` 声明正确。

- **重要决策**:
  - 路由方案采用"完全声明式"设计，不进行任何自动推断或 API 探测，所有路由决策均由用户在配置文件中明确声明，避免系统黑盒行为。
  - Gatekeeping 仅针对 registry 中已知声明为不支持工具调用的模型，未注册的自定义模型不受限制，确保开放性与兼容性。
  - 推理模型（如 `deepseek-reasoner`）可被指定为 planner/critic 角色（toolPolicy.allowedTools 为空，不触发工具拦截），实现纯文本推理任务的路由分配。

- **验证**:
  - `npm run typecheck` 成功通过，0 errors。
  - `npm test` 成功通过，全量 **111 个**测试用例 100% 全部通过（0 fail, 0 skip）。
- **后续核对**:
  - 该阶段为 Model Capability Routing 第一版。已完成角色模型声明、角色解析和 toolCalling=false 前置拦截。
  - request model > role model > active profile default 的完整优先级、Planner/Executor/Critic 默认模型策略和 structured output role gate 仍按 `TODO_provider_registry.md` 跟进。

---

## 2026-05-25 — 上下文管理深度差距分析（v0.81 审计）

- **工作项**: 对 BabeL-O v0.81 上下文管理子系统进行源码级审计，并与 BabeL-X 横向对比。
- **分析方法**: 逐行阅读 `src/runtime/contextAssembler.ts`、`compact.ts`、`sessionSummary.ts`、`memory.ts`、`LLMCodingRuntime.ts`、`hooks.ts`、`shared/events.ts`，以及 BabeL-X 的 `src/services/compact/`、`src/services/SessionMemory/`、`src/query.ts`、`src/components/TokenWarning.tsx`、`src/utils/analyzeContext.ts`。
- **产出**:
  - 新建 `docs/nexus/CONTEXT_GAP_ANALYSIS.md`（15KB 完整报告），覆盖：
    - 9 个维度逐项对比（auto-compact、预算分配、压缩后结构、Session Memory、恢复边界、token 估算、UI/UX、工具映射、模型路由）
    - 13 项按严重程度排序的具体缺陷清单（P0×2、P1×4、P2×4、P3×3）
    - 4 阶段改进路线图（Phase 1 紧急修复 → Phase 4 健壮性硬化）
  - 更新 `docs/nexus/TODO.md`：在"当前优先级"前插入 6 个上下文管理高优先级项。
  - 更新 `docs/nexus/TODO_runtime.md`：在"P1 Context Compact UX"末尾补充 10 个具体缺陷修复项。
- **核心结论**: BabeL-O 上下文管理处于 BabeL-X ~40% 水平；差距主要在压缩持久化结构化、轻量降级层、token 估算精度和诊断能力，而非架构方向性错误。按路线图补齐可达 ~80-90%。
- **验证**: 无代码变更，纯文档审计。未运行测试。

## 2026-05-26 — Recoverable Workspace Path Escape and Context Drift Fix (v0.87)

- **用户请求**: 核对最新开发与文档，并深度分析真实会话中 `TOOL_ERROR: Path escapes workspace: /Users/tangyaoyue/DEV/BabeL/BabeL-O/package.json` 后，Agent 100% 忘记上下文并在用户输入“继续”后回复偏移的问题。
- **日志核实**:
  - SQLite 会话 `session_97950217-70e2-4609-8e7c-2c1cdcc3da9c` 显示 session cwd 为 `/Users/tangyaoyue`，用户任务在多个项目路径间切换。
  - 事件序列中 `Read /Users/tangyaoyue/DEV/BabeL/BabeL-O/package.json` 后立即出现全局 `error`：`code=TOOL_ERROR`、`message=Path escapes workspace: /Users/tangyaoyue/DEV/BabeL/BabeL-O/package.json`。
  - 下一轮用户只输入“继续”后，模型没有拿到上一轮工具失败的 `tool_result`，转而使用 Bash 探测 `NOT FOUND`、zip 目录和其他项目，证明这不是单纯模型幻觉，而是工具循环被运行时错误中断后恢复上下文过弱。
- **根因**:
  - `resolveInsideWorkspace()` 对 workspace escape 抛出普通 Error，`LLMCodingRuntime.executeToolSafely()` / `LocalCodingRuntime.executeToolSafely()` 将其升级为全局 `TOOL_ERROR`。
  - 全局错误会结束 provider tool loop，模型看不到 `tool_result is_error=true`，下一句“继续”只能依赖旧 summary 和残缺上下文恢复，极易把任务目标带偏。
  - 路径 `/DEV/BabeL/...` 与真实工作区 `/DEV/BABEL/...` 的大小写差异、以及 `relative().startsWith('..')` 的粗判断，会放大误判和上下文漂移风险。
- **实现结果**:
  - 新增 `WorkspacePathError`、`isWorkspacePathError()`、`formatWorkspacePathError()`，将 workspace escape 标准化为 `WORKSPACE_PATH_ESCAPE`。
  - `LLMCodingRuntime` 与 `LocalCodingRuntime` 捕获该错误后返回 `tool_completed success=false`，输出 `requestedPath`、`cwd`、`resolvedPath` 与可读修复建议，并在 LLM 续轮中映射为 `tool_result is_error=true`。
  - `resolveInsideWorkspace()` 改为真实路径优先，并用 `relative + isAbsolute + ../` 的标准包含判断，避免把工作区内 `..valid-name` 等合法路径误判为逃逸；安全边界仍保持 deny-by-default，不放宽跨 workspace 访问。
  - 补充 Runtime LLM、HTTP Runtime 与 path safety 边界测试，覆盖 workspace escape 可恢复、全局 `TOOL_ERROR` 不再出现、外部路径仍拒绝、内部缺失路径和 `..` 前缀目录名仍允许。
- **验证**:
  - `npm run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/runtime-llm.test.ts test/runtime.test.ts test/security.test.ts` 通过。

## 2026-05-26 — Context P1 Microcompact and Invariant Guard 收口 (v0.88)

- **用户请求**: 根据 TODO 中 P1 上下文治理项继续推进：Microcompact / API Invariant Guard、System Prompt 分层硬截断、MCP / Skill Delta 重宣布、`selectOmittedEvents` 稳定身份、manual compact 重置 auto-compact 熔断计数。
- **实现结果**:
  - **Microcompact**: 新增 `microcompactEvents()`，在 recent events 进入 message mapper 前先压缩旧轮次 `tool_completed.output`、`assistant_delta` 与 `thinking_delta`，使用 head/tail 保留并明确标记为 microcompact，避免把“上下文截断”误写成 denied/interrupted。
  - **API Invariant Guard**: 新增 `protectToolPairs()`，在 `selectRecentEvents()` 后自动补齐同一 `toolUseId` 的 `tool_started/tool_completed` 配对；`compactSession()` 的 `retainedEvents` 也复用该保护，降低 compact 后 orphan tool_result / synthetic interrupted result 的概率。
  - **Stable event identity**: 新增 `eventIdentity()`，优先使用 `eventId`、`toolUseId`，再退化到 `type/sessionId/timestamp/hash`，替代 `new Set(selectedEvents)` 的对象引用判断，避免 deep clone/normalize 后 omitted 计算失真。
  - **System Prompt 分层硬截断**: 新增 `enforceDynamicLayerBudgets()` 与 `applySystemPromptSectionBudgets()`，对 Project Memory、Session Summary、Active Developer Skills、focus/request path 等动态 section 按预算裁剪，保留 head/tail 并记录 `systemPromptTruncation`；`/context` 诊断新增 `microcompactedEventCount` 与 `systemPromptTruncationCount`。
  - **Compact 后能力重宣布**: 在 compact boundary 后追加 `Compact Capability Reminder`，与 `Post-Compact State` 一起重声明 recent tools、active skills、task/hook 状态和 `tool_use/tool_result` 配对约束。
  - **Auto compact fuse reset**: `countConsecutiveAutoCompactFailures()` 遇到任意成功 `compact_boundary`（manual/reactive/auto）即停止继续向前累计，manual/reactive compact success 可清除边界之前的 auto failure。
- **测试覆盖**:
  - 新增/更新 `test/context-assembler.test.ts` 覆盖 cloned selected events、tool pair protection、microcompact 文案、system prompt layer budget、compact capability reminder、manual boundary fuse reset 和 context analysis 诊断字段。
- **验证**:
  - `npm run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/context-assembler.test.ts` 通过。

---

## 2026-05-31 — Nexus TODO 优先级重梳与 DONE.md 拆分

- **用户请求**: 推送更新到仓库，并查看各个 TODO 文档，将混乱的优先级重新梳理调整；必要时查看源码分析实际优先级；整理完成后分析是否需要添加 `DONE.md` 来转移 TODO 中已经完成的部分。
- **源码校准**:
  - 核对 `src/nexus/sessionAssets.ts`、`src/nexus/app.ts` 与 `test/runtime.test.ts`，确认 `GET /v1/sessions/:sessionId/assets` 已落地，不应继续作为 TODO 追踪。
  - 核对 `src/cli/commands/optimize.ts`、`src/nexus/app.ts`、`src/runtime/providerSmoke.ts` 与测试，确认 `bbl optimize --provider-smoke-live` 入口已落地，剩余项是手动真实 provider live/manual smoke。
  - 核对 `src/runtime/hooks.ts`、`src/runtime/LLMCodingRuntime.ts`、`src/runtime/LocalCodingRuntime.ts`、`src/nexus/sessionLifecycle.ts` 与 `test/hooks.test.ts`，确认 Hooks 最小内核已落地。
  - 核对 `src/providers/adapters/OpenAIAdapter.ts`、`test/runtime-llm.test.ts`、`test/adapters.test.ts`，确认 DeepSeek `reasoning_content` replay 已有 adapter/runtime 回归。
  - 核对 TUI 输入、权限、paste、PTY smoke 相关源码与测试，确认 slash/tool palette、permission panel、唯一 input owner、agent running indicator、paste placeholder 等已经进入完成能力口径。
- **文档调整**:
  - 新增 `docs/nexus/DONE.md`，作为已完成能力索引，承接 TODO 中大量 `[x]` 历史，避免待办优先级继续被完成项淹没。
  - 重写 `docs/nexus/TODO.md`：只保留当前总控优先级、主线状态、推进顺序和维护规则。
  - 重写 `TODO_runtime.md`、`TODO_agents.md`、`TODO_provider_registry.md`、`TODO_tui.md`、`TODO_performance.md`、`TODO_cleanup.md`：各文件只保留未收口任务，完成历史统一转入 `DONE.md`。
  - 更新 `README.md`、`TODO_cli.md`、`TODO_tool_result_budget.md`：明确 `DONE.md` 入口、历史设计状态和 TODO/DONE/WORK_LOG 的职责边界。
- **优先级结论**:
  - 当前没有打开的 P0 功能开发项；真实会话指令跟随回归仍作为 P0 守门规则，一旦复现先补 regression corpus 再修 runtime/adapter/TUI。
  - P1 顺序为：真实 provider live/manual AgentLoop smoke、SDK task mutation API、provider role defaults + 显式 fallback execution、TUI 编程闭环与视觉 smoke。
  - P2 顺序为：生产 build/lint/CI/coverage、1000+ sessions/events 压测、storageBridge 故障注入、AgentLoop 成本 benchmark、并发测试治理。
- **DONE.md 决策**:
  - 需要新增 `DONE.md`。原因是 `TODO_agents.md`、`TODO_tui.md`、`TODO_runtime.md` 等已经沉积大量 `[x]` 项，继续保留会让真实优先级失真。
  - `WORK_LOG.md` 继续记录事实流水和验证命令；`DONE.md` 只保留可检索的完成能力索引；TODO 文件原则上只写 `[ ]` 未完成项。
- **校验中发现并修复的回归**:
  - `LocalCodingRuntime` 新增的自然语言文件问答解析优先级过高，会把显式 `write temp.txt "ws content"` 误判为读取 `temp.txt` 回答问题，导致 WebSocket permission smoke 没有进入权限请求。已调整为显式 `read/write/edit/grep/glob/bash/task` 命令优先，自然语言文件问答后置。
  - WebSocket 快速审批存在竞态：客户端收到 `permission_request` 后立即发送 `permission_response` 时，runtime 可能尚未注册 pending permission，导致响应被丢弃并长时间等待。已在 `LocalCodingRuntime` 与 `LLMCodingRuntime` 中改为发送 permission_request 前先注册 pending entry，hook 自动决策仍会清理 pending entry。
- **验证**:
  - `git diff --check` 通过。
  - `npm run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/permission-flow.test.ts` 通过。
  - `npm test` 全量通过：350 pass, 0 fail。

---

## 2026-06-02 — `/context` diagnostics continued enhancement

- **用户请求**: 推进 P1 `/context` 诊断继续增强。
- **实现**:
  - 扩展 `src/runtime/contextAnalysis.ts` 的 structured diagnostics：新增轻量 `workingSetPaths`、`autoCompactFloor` 和 `compactTokenDelta`。
  - `workingSetPaths` 从当前 prompt、历史 `user_message` 与 `tool_started.input` 中提取路径，不提前实现 P2 `workingSet.ts`，最多返回 16 个高频/近因路径。
  - `autoCompactFloor` 暴露 threshold percent/tokens、当前 tokens、剩余 tokens 和 assembly budget，并说明 auto compact 以 `min(model context × 80%, 120k tokens)` 的 bounded assembly budget 为口径。
  - `compactTokenDelta` 在存在 compact boundary 时返回 before/after event count、event delta 与基于事件 JSON chars 的 estimated token delta；字段明确为 estimated，避免伪装为 provider 精确 usage。
  - 更新 CLI `/context` 展示：增加 auto compact floor、compact delta 和 working set path 行。
  - 更新 HTTP `/v1/sessions/:sessionId/context` passthrough 回归，确保新增 diagnostics 字段进入 API 响应。
- **修复中发现的问题**:
  - 路径提取曾把相对路径 `src/runtime/contextAnalysis.ts` 内部的 `/runtime/contextAnalysis.ts` 误识别为绝对路径；已增加 standalone 检查，只有独立出现的绝对路径才进入 absolute path 结果。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/context-assembler.test.ts --test-name-pattern "analyzeContext|compact token delta|context diagnostics|post-restore|post-compact state"`：38/38 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts --test-name-pattern "/v1/sessions/:sessionId/context"`：54/54 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。

---

## 2026-06-02 — `/context` display consistency regressions

- **用户请求**: 根据建议推进 P1 `/context` 展示一致性回归。
- **实现**:
  - 导出 `src/cli/commands/chat.ts` 的 `formatContextAnalysis()`，用于单测直接验证 CLI embedded 展示文本，避免通过 PTY 做慢速 fragile 断言。
  - 在 `test/context-assembler.test.ts` 增加 `/context display includes matching boundary diagnostics for CLI and API payloads`：同一 `analyzeContext()` payload 同时断言 compact boundary、recovery boundary 的 structured diagnostics 和 CLI formatter 文本。
  - 增加 `/context display includes blocking boundary diagnostics for CLI and API payloads`：通过低 `warningPercent` 构造 warning/blocking 边界显示，断言 signals 与 recommendations 会进入 CLI formatter。
  - 扩展 `test/runtime.test.ts` 的 `/v1/sessions/:sessionId/context returns reusable context analysis`：在 HTTP Nexus 路径追加 compact boundary 与 recovery error 后二次查询，确认 compactRetention、compactTokenDelta、resumeRecovery 和 signals 经 API passthrough 保持一致。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/context-assembler.test.ts --test-name-pattern "/context display|analyzeContext reports compact token delta|retained segment"`：40/40 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts --test-name-pattern "/v1/sessions/:sessionId/context"`：54/54 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。

---

## 2026-06-02 — Retained segment / resume fixture hardening

- **用户请求**: 根据建议推进 P1 retained segment / resume fixture 增强。
- **实现**:
  - 在 `test/context-assembler.test.ts` 增加 `verifyRetainedSegment reports each retained metadata mismatch independently`，分别覆盖 retained boundary anchor、first event identity、last event identity、hash mismatch，并确认有效 metadata 通过。
  - 增加 `assembleContext uses retained tail after a valid compact boundary`，验证 compact boundary 后使用 retained tail + post-boundary events，且不回灌 stale pre-compact history。
  - 增加 `recovery boundary code fixture covers all resumable terminal errors`，覆盖 `REQUEST_CANCELLED`、`REQUEST_TIMEOUT`、`EXECUTION_TIMEOUT`、`PROVIDER_ERROR`、`EMPTY_PROVIDER_RESPONSE`、`CONTEXT_LIMIT_EXCEEDED`、`MAX_LOOPS_EXCEEDED`、`MAX_OUTPUT_TOKENS_EXCEEDED`、`TOOL_LOOP_FINAL_RESPONSE_ONLY`，并确认非恢复错误不误判。
  - 保留既有 count mismatch、retained fallback diagnostics、auto compact preserves recovery boundary after cancellation/failure 回归，形成 retained/resume fixture 矩阵。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/context-assembler.test.ts --test-name-pattern "retained segment|retained tail|recovery boundary"`：43/43 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。

---

## 2026-06-03 — Runtime hook configuration and aggregation

- **用户请求**: 根据建议继续推进 P1 runtime hooks 用户配置层与结果聚合。
- **实现**:
  - 扩展 `src/shared/config.ts`：新增 `hooks.enabled` 与 `hooks.builtins.*.{enabled,timeoutMs}` schema/type，只覆盖内置 hook，不接入任意自定义 shell 命令。
  - 扩展 `src/runtime/hooks.ts`：`executeRuntimeHooks()` 支持显式 options，按配置过滤 hook、覆盖 timeout，并新增 `aggregateHookResults()` 统一汇总 summaries、retryHints、additionalContext、metadata、首个 deny/permission decision 与最后 updatedInput。
  - Runtime 入口透传配置：`RuntimeExecuteOptions.hooks`、`LocalCodingRuntime`、`LLMCodingRuntime`、provider tool loop、CLI `UserPromptSubmit`、session close/cancel、AgentLoop subagent lifecycle 和 fixed live smoke 均接入同一配置对象。
  - 保留既有 timeout/error isolation 与 `hook_started` / `hook_completed` / `hook_failed` 审计事件；未配置时默认行为不变。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `env BABEL_O_CONFIG_FILE=/tmp/babel-o-p1-hooks-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/hooks.test.ts`：9/9 通过。
  - `env BABEL_O_CONFIG_FILE=/tmp/babel-o-p1-hooks-runtime-config.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts --test-name-pattern "hook|runtime pipeline|local runtime"`：69/69 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 通过。

---

## 2026-06-03 — TUI MCP tool audit and permission display

- **用户请求**: 继续推进 TUI P1，优先补 MCP tool/resource display 与 MCP audit / permission panel 对齐。
- **实现**:
  - 新增 `src/cli/toolAuditFormatter.ts`，把 `/v1/tools/audit` 的 raw tool list 格式化为 compact TUI 摘要，展示 builtin/MCP 计数、MCP server/tool、registered name、risk、policy enabled/disabled、server allowlist 状态、approval required 与 suggested allow rule，同时避免输出 raw `inputSchema` / provider schema。
  - `bbl tools audit` 从 raw JSON 改为使用同一 compact formatter；`bbl chat` 的 `/status` 在 service mode 读取 `/v1/tools/audit`，embedded mode 临时构造 runtime audit，并遵循 `BABEL_O_ENABLE_MCP=1` 开关。
  - MCP tool adapter 与 runtime `listTools()` 补充 `requiresApproval`、`suggestedAllowRule`、`mcpServerAllowed` 元数据；MCP resources 当前 runtime 尚未暴露，formatter 明确显示 `MCP resources: not exposed by current runtime`。
  - `permission_request` 增加可选 `source`，Local / provider tool loop 在 MCP 工具审批时携带 server/original tool；permission panel 展示 `mcp/<server>` 来源，并修复含冒号 MCP 工具名的 session allow rule 缓存/匹配。
  - 本地 embedded chat 执行路径接入 `BABEL_O_ENABLE_MCP=1`，与 service runtime 的 MCP enable 口径一致。
- **验证**:
  - `cd /Users/tangyaoyue/DEV/BABEL/BabeL-O && BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-mcp-tui.json ./node_modules/.bin/tsx --test --test-concurrency=1 test/completer.test.ts test/mcp.test.ts`：15/15 通过。
  - `cd /Users/tangyaoyue/DEV/BABEL/BabeL-O && BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-mcp-tui-typecheck.json npm run typecheck` 通过。

---

## 2026-06-03 — Runtime token estimator provider calibration

- **用户请求**: 继续推进 P1 Runtime token estimator 校准增强。
- **实现**:
  - `src/runtime/tokenEstimator.ts` 为 provider tool schema 增加 wrapper overhead，并把 JSON-like object、长 `tool_result`、DeepSeek `reasoningContent`、thinking/redacted_thinking 改为专用估算口径。
  - 保持 `estimateContextTokens()`、`estimateTextTokens()`、`estimateTokensConservative()`、`getContextWindowState()` API 稳定，不改 context window threshold 或 runtime blocking 语义。
  - `test/token-estimator.test.ts` 增加显式 provider 偏差 fixture：50K JSON schema、10K CJK、长 tool result、DeepSeek reasoning replay、provider schema overhead 与 conservative blocking state。
  - `TODO_runtime.md` / `DONE.md` 已同步：当前校准增强收口，后续只在真实 provider drift 出现时补最小 fixture。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/token-estimator.test.ts`：10/10 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec -- tsx --test /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts --test-name-pattern "context|runtime pipeline"`：69/69 通过。
  - `git -C /Users/tangyaoyue/DEV/BABEL/BabeL-O diff --check` 通过。

---

## 2026-06-05 — Go Remote Runner Phase D worktree-aware Write/Edit backend

- **用户请求**: 继续推进 Phase D implement/worktree execution backend。
- **实现**:
  - Go Runner 新增可选 `Write` / `Edit` backend，只有 `GO_RUNNER_ENABLE_WRITE=1` 时 capabilities 才暴露写工具；默认仍保持 Write/Edit disabled，Bash 仍由 `GO_RUNNER_ENABLE_BASH=1` 单独控制。
  - 新增 writable path resolver：支持新文件写入时检查最近已存在父目录，拒绝 traversal、workspace escape、symlink file escape 与 symlink-parent escape；`Edit` 要求唯一 `oldString`，missing/duplicate 作为 recoverable tool failure 返回。
  - Go Runner server/capabilities 增加 `writeEnabled`，并保留 read-only diagnostics、并发/output/deadline hard limits 与 unsupported-tool 守门。
  - Nexus `RuntimeAgentStep` 透传 `executionEnvironment`、`remoteRunner`、step cwd 和 `allowedPaths`，structured-output repair retry 也保留同一 remote execution context。
  - `runAgentLoop()` 在 worktree isolation 下把 executor/critic input 的 `allowedPaths` 缩到 Nexus 创建的 worktree path，Go Runner 不创建、合并、拒绝或删除 worktree。
  - `bbl optimize` 增加 `--execution-environment local|remote`，默认 local；remote 模式复用 `NEXUS_REMOTE_RUNNER_URL` 配置和 capabilities diagnostics。
  - gated Go smoke 扩展到 Phase D：显式启用 Bash + Write，覆盖 capabilities、Read/Grep/Glob/Bash、Write/Edit、workspace escape 与 protocol mismatch。
  - `go-runner-plan.md`、`TODO_runtime.md`、`DONE.md` 已同步 Phase D 已收口状态与剩余 non-goals。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-phase-d.json npm run typecheck` 通过。
  - `go -C "runners/go-runner" test ./...` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-phase-d.json npm exec -- tsx --test --test-concurrency=1 "test/agent-loop.test.ts" "test/runtime.test.ts"`：118/118 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-phase-d-smoke.json BABEL_O_RUN_GO_RUNNER_SMOKE=1 npm exec -- tsx --test --test-concurrency=1 "test/remote-runner-go-smoke.test.ts"`：1/1 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-phase-d-typecheck.json npm run typecheck` 通过。

---

## 2026-06-05 — P0 Tool-call Text Leakage regression closure

- **用户请求**: 将真实会话 Tool-call Text Leakage 作为 P0 回归收口推进。
- **真实样本**:
  - `session_93052ea7-8346-40a9-8175-db941312778c` 中，MiniMax-M3 在 `respond_only` clarification turn 把 bracket-wrapped pseudo Bash tool call 作为 assistant text 输出。
  - 该样本未触发真实工具执行：无 `tool_started`、无 `tool_completed`、无 `permission_request`、无 `tool_denied`；问题是 provider 协议形态污染 `assistant_delta` / `result.message`。
- **实现结果**:
  - `AnthropicAdapter` 对已知 MiniMax bracket wrapper `]<]minimax[>[` 做严格局部归一，并只在完整 `<tool_call>...</tool_call>` envelope 中解析 direct child tags / parameter tags，输出标准 `tool_use_*` deltas，不把 wrapper/XML 同时作为 assistant text 泄漏。
  - `runtimePipeline` 增加通用 tool-shaped text leakage guard；在 `respond_only`、tools hidden、final-response-only 等禁用阶段只做 suppression-only 检测，不推断 tool name/input，也不进入执行路径。
  - 新增 `TOOL_CALL_TEXT_LEAK_SUPPRESSED` diagnostic，包含 provider/model、phase、pattern、redactedPreview、retryAttempted/retrySucceeded；retry prompt 不包含原始 command body。
  - `LLMCodingRuntime` 接入 guard phase 选择与 retry/metrics 聚合，`execution_metrics` 增加 `toolCallTextLeakSuppressedCount`、`finalAnswerRetryCount`、`toolShapedTextPattern`。
  - `contextAssembler` 将该 diagnostic 纳入 recovery boundary；`sessionSummary` 对泄漏诊断做 redacted summary，避免 suppressed command body 进入未来上下文或 compact summary。
  - `tool-call-text-leakage-governance.md` 已标记 Phase A-C implemented，Phase D 仅保留后续 cross-provider corpus / parser registry discipline。
  - `TODO_runtime.md` / `DONE.md` 已同步本次 P0 回归守门收口状态。
- **安全口径**:
  - 未知或禁用阶段的 tool-shaped assistant text 永不执行。
  - 通用 runtime 检测只抑制/诊断/重试 final answer，不做工具参数解析。
  - 只有 provider adapter 输出的标准 `tool_use_*` delta 才能进入 tool loop 与权限链路。
- **验证**:
  - `BABEL_O_CONFIG_FILE="/tmp/babel-o-test-config-tool-leakage.json" BABEL_O_TEST_CONFIG_WRITE_GUARD=1 npm --prefix "/Users/tangyaoyue/DEV/BABEL/BabeL-O" exec -- tsx --test --test-concurrency=1 "/Users/tangyaoyue/DEV/BABEL/BabeL-O/test/adapters.test.ts" "/Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime-llm.test.ts"`：75/75 通过。
  - `BABEL_O_CONFIG_FILE="/tmp/babel-o-test-config-tool-leakage-typecheck.json" BABEL_O_TEST_CONFIG_WRITE_GUARD=1 npm --prefix "/Users/tangyaoyue/DEV/BABEL/BabeL-O" run typecheck` 通过。

---

## 2026-06-06 — Tool granularity and evidence-grounded reading planning

- **用户请求**: 分析是否要引入更细分工具，并在 `docs/nexus` 中新增详细优化文档、同步 TODO、清理归档已完成文档。
- **规划结果**:
  - 新增 `tool-granularity-and-evidence-governance-plan.md`，把 `Search` / `ListDir` / subagent tool 命名问题上升为工具粒度与 evidence-grounded reading 治理。
  - 当前不新增重复 `Search`；`Grep` 继续承担内容定位，但后续应强化 locator-only 语义。
  - 当前不新增 `define_subagent` / `invoke_subagent`；AgentScheduler 已使用 `AgentSpawn` / `AgentWait` / `AgentList` / `AgentCancel` 管理 governed Explore/Review/Test jobs。
  - bounded `ListDir` 只作为 Watch 候选：若真实会话持续出现 Bash `ls/find/tree` 权限噪音、目录层级误判或输出预算问题，再按 read-only、workspace-safe、depth-limited、stable sorted、带 diagnostics 的目录 inventory 工具实现。
- **文档同步**:
  - `TODO.md` 新增 P2 “工具粒度 / Evidence-grounded Reading 治理”主线，并加入文档索引。
  - `TODO_runtime.md` 将已完成 Tool Discovery / Targeted Reading 第一阶段改为归档摘要，并新增 P2 Phase B/C/D 未收口项。
  - `DONE.md` 归档 Tool Discovery / Targeted Reading 第一阶段。
  - `README.md` 增加新规划文档入口。
  - `context-and-subagent-upgrade-plan.md` 清理过时口径：AgentScheduler model-visible tools 已落地，剩余边界是 write-capable child agent 安全。

---

## 2026-06-07 — Workspace path drift governance planning

- **用户请求**: 将 `session_1cf5362d-b33f-467f-b07e-f97356652662` 暴露的最后工具调用问题泛化，并写成优化规划放入文档库合适位置。
- **真实样本结论**:
  - session cwd 为 `/Users/tangyaoyue/DEV/BABEL/BabeL-O`，但模型在跨仓库分析中漂移到 `/Users/tangyaoyue/DEV/BabeL-O`，少了 `BABEL` segment。
  - 后续 `Read` / `ListDir` / `Glob` 在不存在 root 下连续 file-not-found / empty result；工具本身没有 fatal，session 也没有 runtime `error` event，但最终回答存在证据退化风险。
  - 另有一次 `ListDir maxDepth=3` schema validation failure；该问题已被工具提示纠正，不是主要根因。
- **规划结果**:
  - 新增 `docs/nexus/reference/workspace-path-drift-governance-plan.md`，将问题抽象为 Workspace Path Drift、Tool Failure Recovery Drift 与 Evidence Degradation Without Fatal Error。
  - 规划建议优先补最小 `PATH_DRIFT_SUSPECTED` diagnostic：在 `Read` / `ListDir` / `Glob` missing path / empty-result 中基于 cwd、attemptedPath 与 safe candidate path 给出纠偏提示。
  - 明确非目标：不新增路径搜索工具、不自动切换 cwd、不绕过 path safety、不立即实现完整 Source Coverage Ledger。
- **文档同步**:
  - `docs/nexus/reference/README.md` 与 `docs/nexus/README.md` 增加新规划入口。
  - `docs/nexus/TODO.md` 将 P2 / Watch 工具治理扩展为 Evidence-grounded Reading 与 Path Drift 治理，并把 `session_1cf5362d-b33f-467f-b07e-f97356652662` 作为真实样本登记。
  - `docs/nexus/active/TODO_runtime.md` 增加 Phase B.8 Workspace Path Drift / Tool Failure Recovery 轻量诊断未收口项。
- **验证**:
  - 本次为文档规划与索引同步，未改 runtime 代码；未运行测试。

---

## 2026-06-07 — Grep pathMatches parameter drift planning

- **用户请求**: 查看 `session_303c...120e4` 最新会话，分析 Grep 工具调用错误，并同步文档后开始修复。
- **真实样本结论**:
  - 目标会话为 `session_303c7221-8cc3-4251-9436-4215244120e4`，cwd 为 `/Users/tangyaoyue/DEV`。
  - Grep 执行本身未崩溃；失败事件主要是 provider 生成重复 `pathMatches` 字段导致 `PARSE_ERROR: Invalid JSON from model`。
  - 后续模型修正为合法 JSON，但使用 `pathMatches: "true"`；该值被 Grep/ripgrep 当成 file glob `true`，返回空结果，容易被误读为没有匹配。
- **规划结果**:
  - 在 P2 Tool Granularity / Evidence-grounded Reading 下新增 Phase B.9：Grep `pathMatches` 参数语义诊断。
  - 最小修复方向：对 boolean-string `"true"` / `"false"` 返回 recoverable diagnostic，提示省略 `pathMatches` 或使用 file glob；不新增 Search 工具，不改变 Grep locator 边界。
- **实现结果**:
  - `src/tools/builtin/grep.ts` 在执行 ripgrep / fallback 前校验 `pathMatches`；boolean-string 非 glob 意图返回 `INVALID_GREP_PATH_MATCHES_GLOB`，保持 recoverable tool failure。
  - `test/grep-tool.test.ts` 覆盖 `pathMatches: "true"` 的诊断输出，并保留正常 `**/*.ts` glob 过滤回归。
- **验证**:
  - `BABEL_O_CONFIG_FILE="/tmp/babel-o-grep-pathmatches-test-config.json" npm exec -- tsx --test --test-concurrency=1 "test/grep-tool.test.ts"`：4/4 通过。
  - `BABEL_O_CONFIG_FILE="/tmp/babel-o-grep-pathmatches-typecheck-config.json" npm run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE="/tmp/babel-o-grep-pathmatches-format-config.json" npm run format:check` 通过。
  - `git diff --check` 通过。

---

## 2026-06-07 — Workspace path drift minimal diagnostic closure

- **用户请求**: 根据 `workspace-path-drift-governance-plan.md` 推进最小优化实现。
- **实现结果**:
  - 新增 `src/tools/builtin/pathDrift.ts`，在 attempted path 不存在且 cwd 下存在 safe candidate path 时生成 `PATH_DRIFT_SUSPECTED` diagnostic。
  - `Read` missing file 与 `ListDir` missing directory 结果追加 cwd-aware guidance，提醒不要把错误根路径的 missing 当成项目不存在证据。
  - `Glob` 在显式 `path` search root 不存在时保持 `success=true` empty-result 语义；若检测到 workspace path drift，则返回 explanatory output 与 structured guidance。
  - 实现不新增路径搜索工具、不自动切换 cwd、不绕过 `resolveInsideWorkspace` / allowed workspace 安全边界。
- **回归覆盖**:
  - `test/read-tool.test.ts` 覆盖 `/tmp/.../BABEL/BabeL-O` cwd 与 `/tmp/.../BabeL-O/src/index.ts` 错误绝对路径。
  - `test/list-dir-tool.test.ts` 覆盖同类 missing directory drift。
  - `test/runtime.test.ts` 覆盖 `Glob` missing search root 输出 `PATH_DRIFT_SUSPECTED` 与 candidate path。
- **文档同步**:
  - `docs/nexus/active/TODO_runtime.md` 将 Phase B.8 改为已收口摘要，保留 Source Coverage Ledger / evidence hint 为 Watch。
  - `docs/nexus/TODO.md`、`docs/nexus/DONE.md` 与 `workspace-path-drift-governance-plan.md` 已同步最小诊断落地状态。
- **验证**:
  - `BABEL_O_CONFIG_FILE="/tmp/babel-o-path-drift-test-config.json" npm exec -- tsx --test --test-concurrency=1 "test/read-tool.test.ts" "test/list-dir-tool.test.ts" "test/runtime.test.ts"`：102/102 通过。
  - `BABEL_O_CONFIG_FILE="/tmp/babel-o-path-drift-typecheck-config.json" npm run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE="/tmp/babel-o-path-drift-format-config.json" npm run format:check` 通过。
  - `git diff --check` 通过。

---

## 2026-06-07 — EverCore Phase A REST Spike

- **用户请求**: 尝试推进 BabeL-O 与 `/Users/tangyaoyue/DEV/EverOS` 的结合。
- **接口核对**:
  - EverOS 当前实际 REST API 是 `/api/v1/memory/add`、`/api/v1/memory/flush`、`/api/v1/memory/search`，不是早期规划里的 `/api/v1/memories/agent`。
  - EverOS 不提供内置 auth；BabeL-O 侧保持默认关闭，URL diagnostics 只输出 redacted 版本。
- **实现**:
  - 新增 `src/runtime/everCoreClient.ts`：`HttpEverCoreClient` 支持 `search`、`addAgentMessages`、`flushAgentSession`，带 timeout、可选 bearer token header、实际 `/api/v1/memory/*` 路由和 bounded session event mapper。
  - 新增 `src/nexus/everCoreConfig.ts`：环境变量配置 `BABEL_O_EVERCORE_ENABLED`、`BABEL_O_EVERCORE_BASE_URL`、`BABEL_O_EVERCORE_API_KEY`、`BABEL_O_EVERCORE_UPLOAD_ON_SESSION_END` 等；默认 disabled；health check 失败只进入 status，不 fail fast。
  - `src/nexus/app.ts` 的 `/v1/runtime/status` 增加 `everCore` diagnostics，并把可选 EverCore client/config 传给 session close/cancel。
  - `src/nexus/server.ts` 在 service mode 配置 EverCore，并在启动日志显示 `everCore=disabled|healthy|unhealthy`。
  - `src/nexus/sessionLifecycle.ts` 在 `uploadOnSessionEnd` 启用时，session close/cancel 会上传 bounded user/result messages 并 flush；失败仅写入 `session.metadata.everCoreSync.status = "failed"`，不影响 close/cancel 响应。
  - 不修改 `src/shared/events.ts`、storage interface、context assembler 或 provider loop；SQLite/session/event/tool trace 仍是事实源。
- **回归覆盖**:
  - `test/runtime.test.ts` 覆盖默认 disabled、URL redaction、实际 `/api/v1/memory/add|flush|search` 路由、runtime status EverCore diagnostics，以及 session close 时 EverCore sync failure non-fatal。
- **文档同步**:
  - `docs/nexus/TODO.md`、`docs/nexus/active/TODO_runtime.md` 与 `docs/nexus/DONE.md` 已同步 Phase A 已收口，Phase B/C/D 保留为 P3 后续项。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-evercore-runtime-test-config.json npx tsx --test test/runtime.test.ts`：96/96 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-evercore-typecheck-config.json npm run typecheck` 通过。

---

## 2026-06-07 — EverCore Phase B Internal MemoryProvider

- **用户请求**: 继续推进 P3 EverCore / 长期语义记忆。
- **实现**:
  - 新增 `src/runtime/memoryProvider.ts`，定义 `MemoryProvider`、`NoopMemoryProvider` 与 `EverCoreMemoryProvider`。
  - `EverCoreMemoryProvider` 通过 EverOS 当前 `/api/v1/memory/search` 检索 typed search response，提取 `episodes`、`profiles`、`agent_cases`、`agent_skills` 与 `unprocessed_messages` 作为 bounded hits。
  - `assembleContext()` 接收可选 `memoryProvider`，把检索结果注入 `long_term_memory` volatile / non-cacheable section，并明确提示这些内容只是 background hints，不能作为 authoritative project state。
  - `LLMCodingRuntime`、runtime pipeline、server、embedded client 与本地 CLI flow 均完成 provider threading；EverCore healthy 时启用，disabled/unhealthy 时不影响 BabeL-O 主流程。
  - 检索失败只返回 diagnostics/空内容，不污染 provider-visible context；SQLite/session/event/tool trace 仍是事实源。
- **回归覆盖**:
  - `test/context-assembler.test.ts` 覆盖 MemoryProvider 注入为 volatile long-term memory、EverOS typed search response parser，以及检索失败不进入 provider-visible context。
  - `test/runtime.test.ts` 保持 runtime/server 路径回归通过。
- **文档同步**:
  - `docs/nexus/TODO.md`、`docs/nexus/active/TODO_runtime.md` 与 `docs/nexus/DONE.md` 已同步 Phase B 已收口，并保留 Phase C diagnostics 为下一步。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-evercore-phaseb-context-test-config.json npx tsx --test test/context-assembler.test.ts`：50/50 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-evercore-phaseb-runtime-test-config.json npx tsx --test test/runtime.test.ts`：96/96 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-evercore-phaseb-typecheck-config.json npm run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-evercore-phaseb-format-config.json npm run format:check` 通过。
  - `git diff --check` 通过。

---

## 2026-06-07 — EverCore Phase C Context Budget / Diagnostics

- **用户请求**: 推进 Phase C：Context Budget / Diagnostics。
- **实现**:
  - `MemoryProviderDiagnostics` 增加 provider/enabled/hitCount/injectedChars/budgetChars/maxHitChars/truncated/searchLatencyMs/error，EverCore search 会记录独立 memory budget、per-hit budget、命中数、注入字符数、截断状态和检索耗时。
  - `assembleContext()` 返回 `memoryProviderDiagnostics`，`analyzeContext()` 暴露 `diagnostics.longTermMemory`，并把 long-term memory fields 写入 diagnostic envelope details。
  - HTTP `/v1/sessions/:sessionId/context` 接入 app-level `memoryProvider`，使 API context analysis 能报告 EverCore long-term memory diagnostics。
  - CLI `/context` formatter 与 context view 增加 `long-term memory ... hits=... injected=... latency=... truncated/error` 诊断行。
  - 检索失败保持 non-fatal，只进入 diagnostics 和 recommendations，不把错误文本注入 provider-visible context。
- **回归覆盖**:
  - `test/context-assembler.test.ts` 覆盖默认 noop diagnostics、long-term memory budget diagnostics、diagnostic envelope fields、CLI rendering 和 truncated recommendation。
  - `test/runtime.test.ts` 覆盖 `/v1/sessions/:sessionId/context` 默认 noop diagnostics，以及 app-level memory provider 的 hit/budget/latency API passthrough。
- **文档同步**:
  - `docs/nexus/active/TODO_runtime.md` 将 Phase C 改为已收口摘要，只保留 Phase D Optional MCP Tools。
  - `docs/nexus/TODO.md` 与 `docs/nexus/DONE.md` 已同步 Phase C 完成状态。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-evercore-phasec-context-test-config.json npx tsx --test test/context-assembler.test.ts`：51/51 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-evercore-phasec-typecheck-config.json npm run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-evercore-phasec-runtime-test-config.json npx tsx --test test/runtime.test.ts`：97/97 通过。

---

## 2026-06-07 — EverCore Phase D Optional MCP Tools

- **用户请求**: 推进 P3 EverCore Phase D Optional MCP Tools。
- **实现**:
  - 新增 `src/tools/everCoreMcpTools.ts`，提供 `mcp:evercore:memory_search`、`mcp:evercore:memory_save_note` 与 `mcp:evercore:memory_flush_session`。
  - 新增 `BABEL_O_ENABLE_EVERCORE_MCP_TOOLS=1` 显式开关；只有 EverCore enabled/healthy 且存在 client 时，`createDefaultNexusRuntime()` 才注册这些工具。
  - `memory_search` 是 read-only bounded explicit retrieval，返回 hitCount/injectedChars/budgetChars/maxHitChars/truncated/searchLatencyMs/content，并提示 EverCore memories 只是 background hints。
  - `memory_save_note` 与 `memory_flush_session` 标记为 write risk，复用现有 permission request / permission audit / MCP source identity，不自动执行。
  - 不改变 Phase B/C 的每轮 MemoryProvider 自动检索路径；MCP tools 只用于用户主动或模型显式调用，不承担 session end 上传。
- **回归覆盖**:
  - `test/mcp.test.ts` 覆盖默认不注册、显式启用后的 tool audit/source identity、bounded search diagnostics、save/flush permission gating，以及 search failure non-fatal tool result。
  - `test/runtime.test.ts` 继续覆盖 EverCore status diagnostics，并新增 `mcpToolsEnabled` 状态断言。
- **文档同步**:
  - `docs/nexus/active/TODO_runtime.md` 将 Phase D 改为已收口摘要。
  - `docs/nexus/TODO.md` 与 `docs/nexus/DONE.md` 已同步 Phase D 完成状态。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-evercore-phased-mcp-test-config.json npx tsx --test test/mcp.test.ts`：8/8 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-evercore-phased-typecheck-config.json npm run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-evercore-phased-runtime-test-config.json npx tsx --test test/runtime.test.ts`：97/97 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-evercore-phased-context-test-config.json npx tsx --test test/context-assembler.test.ts`：51/51 通过。

---

## 2026-06-08 — EverCore Phase E Embedded / Managed EverCore Spike

- **用户请求**: 推进 P3 Embedded / Managed EverCore 一体化部署 Spike，采用“一体化部署、边界仍解耦”。
- **实现**:
  - 新增 `src/nexus/everCoreSidecar.ts`，提供默认关闭的 managed EverCore sidecar lifecycle：loopback-only host 校验、自动本地端口分配、本地数据目录创建、`everos server start` 子进程启动、`/health` readiness polling、失败 diagnostics 与 dispose 清理。
  - `configureEverCore()` 新增 `mode: disabled | external | managed`，环境变量 `BABEL_O_EVERCORE_MODE=managed`、`BABEL_O_EVERCORE_MANAGED_*` 与 `BABEL_O_EVERCORE_DATA_DIR` 可启用/覆盖 sidecar；旧 `BABEL_O_EVERCORE_ENABLED=1` + `BABEL_O_EVERCORE_BASE_URL` 继续映射为 external mode。
  - Managed mode 向 EverOS 注入 `EVEROS_MEMORY__ROOT`、`EVEROS_API__HOST`、`EVEROS_API__PORT`，然后复用现有 `HttpEverCoreClient` / `EverCoreMemoryProvider` / optional MCP tools，不新增 BabeL-O 对 EverCore 内部 schema/index 的直接依赖。
  - `createDefaultNexusRuntime()` 会在 storage close 时清理 managed sidecar；service mode、embedded Nexus client 与本地 CLI flow 均传递 dispose。
  - `/v1/runtime/status` 增加 EverCore `mode` 与 `sidecar` diagnostics，展示 redacted endpoint、data dir、pid、running/healthy、upload/MCP tools 状态。
- **边界**:
  - 默认仍 disabled；managed sidecar 只允许 loopback/localhost/::1，不支持非本地绑定。
  - Sidecar 启动/健康检查失败保持 non-fatal，不创建 memory provider，但 BabeL-O 主流程继续运行。
  - SQLite/session/event/tool trace 仍是 authoritative 事实源；EverCore memory 仍是 volatile / non-cacheable / non-authoritative hints；不做 full merge，不做 remote provider loop。
- **回归覆盖**:
  - `test/runtime.test.ts` 覆盖 managed mode 启动参数/env 注入、自动端口分配、diagnostics、dispose 清理、非 loopback host 拒绝，以及 `/v1/runtime/status` sidecar diagnostics passthrough。
- **文档同步**:
  - `docs/nexus/active/TODO_runtime.md` 将 Phase E 改为已收口摘要。
  - `docs/nexus/TODO.md` 与 `docs/nexus/DONE.md` 已同步 Phase E 完成状态。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-evercore-managed-runtime-test-config.json npx tsx --test test/runtime.test.ts`：100/100 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-evercore-managed-typecheck-config.json npm run typecheck` 通过。
