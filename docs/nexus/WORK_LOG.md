# BabeL-O Nexus 工作记录

本文件只记录事实、验证和重要决策。不承载长期规划，长期规划写入各 TODO 文档。

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
