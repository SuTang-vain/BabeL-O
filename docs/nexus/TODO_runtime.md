# TODO Runtime / Nexus

## 目标

Nexus 是 BabeL-O 的执行核心。它负责 API、event stream、runtime orchestration、sessions、tasks、storage、安全边界和服务状态，不依赖 CLI UI 或终端状态。

## P0 已完成摘要

- [x] 建立 `src/nexus/` 服务目录。
- [x] 使用 Fastify 作为 HTTP API 服务。
- [x] 使用 `@fastify/websocket` 暴露 `/v1/stream`。
- [x] 实现 `GET /health`。
- [x] 实现 `GET /v1/runtime/status`。
- [x] 实现 `POST /v1/execute`。
- [x] 实现 `GET /v1/sessions`。
- [x] 实现 `GET /v1/sessions/:sessionId`。
- [x] 实现 `GET /v1/sessions/:sessionId/tasks`。
- [x] 实现 `POST /v1/sessions/:sessionId/tasks`。
- [x] 建立 `Runtime.ts` runtime facade。
- [x] 建立 `LocalCodingRuntime` 作为 deterministic local runtime。
- [x] 建立 `MemoryStorage`。
- [x] 建立 `SqliteStorage`。
- [x] 建立共享 `NexusEvent`、`SessionSnapshot`、`NexusTask` 类型。
- [x] 实现 `POST /v1/sessions/:id/input`。
- [x] 实现 `POST /v1/sessions/:id/cancel`。
- [x] 实现 `PATCH /v1/sessions/:id/tasks/:taskId`。
- [x] 实现 `POST /v1/sessions/:id/tasks/:taskId/claim`。
- [x] 实现 `POST /v1/sessions/:id/tasks/:taskId/complete`。
- [x] `npm run typecheck` 通过。
- [x] `npm test` 通过。
- [x] embedded CLI smoke 通过。
- [x] service mode smoke 通过。

## P1 Runtime Core

- [ ] 将 `LocalCodingRuntime` 改为可组合 runtime pipeline：prompt parser、provider call、tool loop、result aggregator。
- [x] 新增 `LLMCodingRuntime`，实现 provider stream、tool loop、result aggregator 第一版。
- [x] 实现零额外依赖的 Bash 状态探测软拦截（State Probing），使 Bash 工具在同一会话下能够保持工作目录（CWD）。
- [x] 实现完整 request context：`requestId`、`sessionId`、`cwd`、`model`、`budget`、`abortSignal`。
- [x] runtime execute options 已传递 `sessionId`、`cwd`、`abortSignal` 与工具输出预算。
- [x] 给 `/v1/execute` 加 timeout。
- [x] 给 `/v1/stream` 加 cancellation / close handling。
- [x] 增加标准 error code：`INVALID_REQUEST`、`SESSION_NOT_FOUND`、`TOOL_DENIED`、`REQUEST_TIMEOUT`、`PROVIDER_ERROR`。
- [x] 增加 `thinking_delta` event。
- [x] 增加 `GET /v1/schema/events`。
- [x] 增加 `GET /v1/tools/audit`。
- [x] 增加 `POST /v1/sessions/:id/cancel`。
- [x] 增加 `PATCH /v1/sessions/:id/tasks/:taskId`。
- [x] 增加 task claim/complete endpoint。

## P0 Context-Aware Runtime

来自 `docs/RECOMMENDATIONS.md` 的 Milestone 1。目标是先做低风险、Nexus-owned 的上下文预算和压缩，不迁移 BabeL-X 的重型后台 SessionMemory 子 Agent。

- [x] 新增 `ContextBudget`：按 model context window 分配 system / memory / summary / recent budgets，预留输出余量。
- [x] 新增 `src/runtime/compactors/snipCompactor.ts`：对超长 `tool_completed.output` 做 head/tail 字符级截断，原始 events 继续完整保存在 SQLite。
- [x] 新增 `src/runtime/contextAssembler.ts`：按 System Prompt、Project Memory、Session Summary、Recent Events、Current Turn 分层装配模型上下文。
- [x] 支持 `.babel-o/memory.md` 项目记忆加载，并注入 system prompt。
- [x] 初版只做字符预算和规则摘要；暂不实现 BabeL-X `SessionMemory` 的后台子 Agent 提取。
- [x] Benchmark：长会话上下文输入规模降低 50%+，且最近 3-5 轮完整保留。

## P0 MCP-Ready Runtime Extensions

来自 `docs/RECOMMENDATIONS.md` 的 Milestone 2。目标是利用 Nexus-first 架构把 MCP server 作为 Nexus 管理的外部工具源，而不是绑定 CLI 生命周期。

- [x] 新增 `src/mcp/McpClient.ts`：实现 JSON-RPC 2.0 over stdio，覆盖 initialize、tools/list、tools/call、shutdown。
- [x] 新增 `src/mcp/McpRegistry.ts`：加载 `~/.babel-o/mcp.json` 和项目级 MCP 配置。
- [x] 新增 `src/mcp/McpToolAdapter.ts`：将 MCP tool 适配为 BabeL-O `ToolDefinition`。
- [x] MCP 初版只支持 stdio transport；http/sse/ws/OAuth/XAA 延后。
- [x] MCP server 配置默认 `allowedTools: []`，未显式白名单的 MCP 工具全部拒绝。
- [x] MCP tool 风险在适配阶段确定：read / write / execute / task，并复用现有 `permission_request` 流。
- [x] `GET /v1/tools/audit` 和 `bbl tools audit` 显示 MCP tool 来源、server name、risk 和 allowlist 状态。
- [x] 增加至少 3 个官方 MCP server e2e smoke。

## P1 Knowledge-First Skills

来自 `docs/RECOMMENDATIONS.md` 的 Milestone 3。目标是先实现纯文本 inline Skills，为模型提供稳定工作方法，不迁移 BabeL-X 的 React `SkillTool` 和 fork 模式。

- [ ] 新增 `src/skills/loader.ts`：解析 front matter，加载 skill id/name/triggers/priority/content。
- [ ] 支持三级目录：`src/skills/built-in`、`~/.babel-o/skills`、`<cwd>/.babel-o/skills`。
- [ ] 新增 `matchSkills(skills, prompt)`：按触发词匹配，最多注入 3 个，按 priority 排序。
- [ ] 将匹配到的 inline skill 注入 system prompt 或 context assembler。
- [ ] 内置 5 个 skill：coding、optimization、debugging、testing、git。
- [ ] 初版不支持 `mode: fork`；fork 等 AgentLoop/sub-agent 能力稳定后再接。

## P2 Smart Permissions

来自 `docs/RECOMMENDATIONS.md` 的 Milestone 4。目标是从全手动审批升级为轻量规则自动分类，不迁移 BabeL-X 的复杂九阶段权限管道。

- [ ] 新增 `src/runtime/classifier.ts`。
- [ ] Read/Grep/Glob 等 read-only 操作自动放行。
- [ ] Bash 支持安全白名单：`ls`、`cat`、`pwd`、`git status`、`git log`、`git diff`、`npm list`、`npx tsc --noEmit` 等。
- [ ] Bash 支持危险黑名单：`rm -rf`、`sudo`、管道 curl/wget、`npm publish`、`git push` 等。
- [ ] 写操作默认仍要求人工确认。
- [ ] 所有自动放行/拒绝记录 permission audit reason。

## P1 Storage

- [x] 定义正式 `NexusStorage` schema 版本。
- [x] 实现 SQLite storage。
- [x] 保存 sessions。
- [x] 保存 events。
- [x] 保存 tasks。
- [x] 保存 tool traces。
- [x] 支持服务启动 hydrate。
- [x] 支持 storage restart smoke test。
- [x] 给 sessions/tasks/events 列表加 `limit`。
- [x] 预留/实现 cursor pagination (复合游标复合分页)。

## P1 Security

### 当前状态

- [x] 高风险工具交互式确认第一版已完成：Write/Edit/Bash 会生成 `permission_request`，可通过 HTTP `/approve`、`/deny` 或 WebSocket `permission_response` 恢复执行。
- [x] CLI embedded 与 service/WS 路径均已接入 approve/deny 交互。
- [x] Service-safe permissions 已完成收尾：实现默认绑定 127.0.0.1，且在绑定非 localhost 时强制要求 NEXUS_API_KEY。实现 HTTP/WS 鉴权防御。

- [x] 实现 workspace allowlist.
- [x] 实现 realpath 防 symlink escape.
- [x] 工具默认 deny-by-default.
- [x] 实现 `NEXUS_ALLOWED_TOOLS`.
- [x] 实现 Bash 风险分类.
- [x] 实现工具 allowlist policy.
- [x] 实现 denied tool event.
- [x] 将 Write/Edit/Bash 转为 permission event.
- [x] CLI 支持 approve/deny permission event.
- [x] 记录当前工具 allow/deny audit view.
- [x] 记录持久化 permission audit.
- [x] 默认绑定 `127.0.0.1`.
- [x] 生产/远程部署默认要求 `NEXUS_API_KEY`.

## P2 Execution Environments

- [ ] 定义 `executionEnvironment` 请求字段。
- [ ] P2 只支持 `local`。
- [ ] 对 `docker` / `remote` 返回明确 not implemented。
- [ ] 设计 Docker workspace mount 和资源限制。
- [ ] 设计 remote runner protocol。

## 验证命令

- [x] `npm run typecheck`
- [x] `npm test`
- [x] `npm run cli -- run "hello"`
- [x] `npm run cli -- run "read README.md"`
- [x] `npm run start` + `curl /health`
- [x] `npm run cli -- run --url http://127.0.0.1:3000 "bash pwd"`
- [x] storage restart test 已纳入 `npm test`
- [x] allowlisted tool denial test 已纳入 `npm test`
- [x] `test/security.test.ts` 安全鉴权测试已纳入 `npm test`
- [ ] `npm run test:stream`

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
