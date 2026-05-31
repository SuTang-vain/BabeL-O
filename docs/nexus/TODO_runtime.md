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
  - 触发条件：token growth ≥ 30K + tool calls ≥ 15 或最后轮无工具调用。
  - 执行：sequential 控制，只读写 `.babel-o/session-memory.md`，summary model 可降级。
  - 详见 [CONTEXT_UPGRADE_ROADMAP.md](./CONTEXT_UPGRADE_ROADMAP.md) Phase 2.1。
- [ ] 保留 segment / resume 验证继续增强：把 retained tail、boundary anchor、first/last event identity 和 hash 的异常恢复做成更明确的用户可见诊断。
- [ ] 重新评估 `thinking_delta` 策略：当前完全丢弃能防污染，但长任务里可能损失规划连续性。

## P1 Context Token Estimator — 校准增强（已落地基础）

> 详见 [CONTEXT_UPGRADE_ROADMAP.md](./CONTEXT_UPGRADE_ROADMAP.md) Phase 0.1

- [ ] 在已存在的 `src/runtime/tokenEstimator.ts` 分层估算基础上补 `estimateTokensConservative()` 或等价 conservative mode，默认给 budget / blocking 决策预留 20-30% provider 偏差 buffer。
  - 现状已覆盖 ASCII、CJK、JSON-like、tool_use/tool_result、thinking/redacted_thinking、image/document 和 tool definition overhead。
  - 后续只做校准：50K JSON schema、10K 中文、长 tool_result、DeepSeek reasoning、provider tool schema overhead 的 fixture 偏差回归。
  - 参考 Codex token usage / image payload 估算策略，为未来多模态动态 patch count 预留接口。
- [ ] 扩展 `test/token-estimator.test.ts`，从“函数阈值验证”升级为“真实上下文样本偏差基线 + conservative buffer 不变量”。

## P1 Context Blocking Limit — UX / API 收口（已落地基础）

> 详见 [CONTEXT_UPGRADE_ROADMAP.md](./CONTEXT_UPGRADE_ROADMAP.md) Phase 0.2

- [ ] 保持 `LLMCodingRuntime.ts` 已有 provider call 前 blocking guard，不再重复实现硬拦截。
  - 现状：超限时会 reactive compact；compact 后仍超限则返回 `CONTEXT_LIMIT_EXCEEDED`，并阻止 provider request。
  - 后续增强：增加独立 `context_blocking` 或等价结构化事件，让 CLI/API 能区分“warning”与“hard block”。
  - API 路径补 413 映射或结构化错误 body；TUI 展示明确 action：`/context`、`/compact`、切换大上下文模型或降低工具输出。
- [ ] 扩展 blocking 回归：覆盖 compact 成功恢复、compact 失败熔断、blocking 后不调用 provider、service/embedded 两条路径一致。

## P1 Compact 完整化 — 机制增强（已落地基础）

> 详见 [CONTEXT_UPGRADE_ROADMAP.md](./CONTEXT_UPGRADE_ROADMAP.md) Phase 1

### Microcompact 机制

- [ ] 将已存在于 `contextAssembler.ts` 的 `microcompactEvents()` 抽离到 `src/runtime/compactors/microCompact.ts`，并保持现有行为兼容。
  - 增强重复工具输出识别：按 `(tool_name, normalized input)` 去重，保留最近结果，旧结果替换为一行摘要。
  - 保护最近 2-4 个用户轮次和 tool_use/tool_result 对，不能破坏 provider 协议。
  - 增加 byte/token savings 统计，供 `/context` 和 compact metrics 展示。
- [ ] 扩展 microcompact 回归：重复工具输出清理、tool pair 保护、事件顺序稳定、byte-stable identity。

### Compact 后状态重建

- [ ] 在已存在 `derivePostCompactState()` / `formatPostCompactState()` 基础上抽离 `src/runtime/compactPostRestore.ts`，让 compact 后状态重建可单测、可复用。
  - 继续保留最近读取文件、active tools、active skills、task status、hook activity。
  - 补 MCP tools audit、tool contract reminder、skill delta 重宣布和 agent/sub-task 状态摘要。
  - 对 restored file contents 设置总 token/char 上限，避免 post-compact 反向膨胀。
- [ ] 扩展 compact-post-restore 回归：compact 后继续问最新任务、workspace escape 后恢复、cancel boundary 后恢复、provider empty response 后恢复。

### /context 诊断命令

- [ ] 在已存在 `/context` 命令和 `analyzeContext()` API 基础上增强诊断展示。
  - 增加 BabeL-X 式 suggestions：大 tool_result、重复 Read、memory bloat、auto compact disabled、near capacity。
  - 增加 Codex 式 usage 指标：input/cached/output/reasoning、context remaining、compact 前后 token delta。
  - 增加 DeepSeek-TUI 式工作集路径和 large-context auto-compact floor 解释。
- [ ] 扩展 `/context` 回归：本地 embedded、HTTP Nexus、compact boundary、blocking boundary、recovery boundary 都能输出一致诊断。

## P2 Context: Working Set（新增）

> 详见 [CONTEXT_UPGRADE_ROADMAP.md](./CONTEXT_UPGRADE_ROADMAP.md) Phase 2.2

- [ ] 新建 `src/runtime/workingSet.ts`。
  - `WorkingSetEntry`：path、touches、lastTurn、isDir、source。
  - 评分：`touches * 4 + recency_bonus`（[6,4,3,2,1,0] 对应 [0,1,2,3-5,6-10,>10] 轮前）。
  - Byte-stable 排序（只用 touches，不含 recency bonus），避免 system prompt 重排破坏 prefix cache。
  - 最多 16 个 entry，自动淘汰最低分。
- [ ] 路径提取：扫描 user_message text 和 tool input JSON 中的路径。
- [ ] 集成到 `buildSystemPromptSections()` 的 project context block。
- [ ] 新增 `test/working-set.test.ts`。

## P2 Context: Prefix Cache 稳定性策略（新增）

> 详见 [CONTEXT_UPGRADE_ROADMAP.md](./CONTEXT_UPGRADE_ROADMAP.md) Phase 3.1

- [ ] 新建 `src/runtime/prefixCache.ts`。
  - 三段式：IMMUTABLE PREFIX (system + tool_specs) → APPEND-ONLY HISTORY → LATEST USER TURN。
  - SHA-256 fingerprint（system text + sorted tool names）。
  - 稳定性比率暴露给 metrics 和 `/status` 命令。
- [ ] 重构 `buildSystemPromptSections()` 输出顺序：静态内容在前，volatile 内容在后（volatile-content-last 不变量）。
- [ ] 新增 `test/prefix-cache.test.ts`。

## P2 TUI: Path Mention（新增，归属 TUI / Completer）

> 详见 [CONTEXT_UPGRADE_ROADMAP.md](./CONTEXT_UPGRADE_ROADMAP.md) Phase 3.2

- [ ] 在 `TODO_tui.md` 同步跟踪 `src/cli/pathMention.ts`（或集成到 `completer.ts`），Runtime 侧只消费显式路径和 working set 结果。
  - `WorkspacePathIndex`：lazy fuzzy basename index，cap 50K entries。
  - dot-dir（.babel-o/.claude/）在 gitignore 下仍可发现。
  - `@`-mention 或路径分隔符触发补全，响应 < 100ms。
- [ ] 新增 `test/path-mention.test.ts`。

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
- [ ] `npm test` 扩展 token-estimator / blocking-limit / microcompact / compact-post-restore / context-command / working-set / prefix-cache / path-mention 回归套件

## 参考文件

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
- `docs/nexus/CONTEXT_UPGRADE_ROADMAP.md` — 上下文管理升级详细实施路径（必读）
