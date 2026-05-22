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
