# EverCore Lifecycle Cache and Memory UI Governance Plan

## 背景

Phase G 已完成 Memory Capability Awareness / Self-Trigger：BabeL-O 能在 EverCore healthy 时向 provider 暴露长期记忆能力，按 cue 自动检索 memory hints，并通过 `mcp:evercore:memory_save_note` 走 permission-gated 写入。

新的真实使用问题有两个：

1. **拉起成本与重复启动**：`BABEL_O_EVERCORE_MODE=managed` 当前由 Nexus / embedded runtime 在启动或请求链路中拉起 `everos server start` sidecar。Go TUI 本身只连接 Nexus HTTP/WS，不直接拥有 runtime。若每次 embedded inject 或短 session 都重新 `configureEverCoreFromEnv()`，会重复 spawn EverOS，带来冷启动延迟、端口抖动和潜在数据目录竞争。
2. **能力问答泄露内通**：当用户问“你当前能否写入记忆？”时，模型可能把内部路径、实现细节、commit 信息或治理机制完整暴露给用户。正确答案应该是用户级能力说明：能否、何时、是否需要确认、失败是否非致命；不应泄露 `src/...`、内部提交、sidecar/MCP 细节或 provider prompt 内通。

本计划把二者统一治理：EverCore 应该是**按需启动、健康复用、空闲退出**的 managed warm sidecar；用户可见的 `/memory` 应该是**状态与治理面板**，不是让模型自由解释内部实现。

## 目标

```text
1. GotUI / Nexus / embedded runtime 能自行按需拉起记忆服务系统。
2. 避免每个 request / inject / short session 重复启动 EverOS。
3. 在不做系统级 daemon 的前提下，提供进程内缓存、本机 registry 复用与 idle TTL。
4. 增加 /memory 用户入口与面板设计，展示记忆状态、候选、写入权限、flush/reindex 诊断。
5. 修复“记忆能力问答”口径：用户可见回答只讲能力和确认流程，不暴露内部代码路径、提交记录、MCP/sidecar 内通。
```

## 非目标

- 不把 EverOS / EverCore 变成 BabeL-O 的 authoritative 事实源。
- 不让长期记忆替代 SQLite / session events / compact / working set。
- 不默认启用完整 background dreaming 或自动写高影响项目事实。
- 不把 managed sidecar 变成无边界孤儿进程。
- 不做开机自启、launchd/systemd-user、全局 daemon installer。
- 不暴露公网 EverOS endpoint；managed 仍只允许 loopback。
- 不新增一个大而泛的 `memory` mega-tool 替代现有正交 MCP tools。

## 当前链路

```text
Go TUI
  -> Nexus HTTP/WS
  -> server.ts configureEverCoreFromEnv()
  -> managed sidecar spawn everos

bbl chat / embedded client
  -> embedded.ts injectJson()
  -> configureEverCoreFromEnv()
  -> createDefaultNexusRuntime()

bbl run / local session flow
  -> runSessionFlow.ts
  -> configureEverCoreFromEnv()
  -> createDefaultNexusRuntime()
```

当前 `managed` 语义是“当前 Nexus / runtime 进程持有 sidecar”。它不是系统 daemon；进程关闭时应 dispose sidecar。

## 推荐生命周期模型

### 1. 默认：managed warm sidecar

```text
mode=managed
startup=on-demand
reuse=health-checked
idle=TTL shutdown
scope=loopback only
failure=non-fatal diagnostics
```

默认策略仍是按需启动，但启动对象不是每轮请求，而是一个可复用的 warm sidecar：

- 同一 BabeL-O 进程内，只创建一次 `ConfiguredEverCore`。
- 同一 dataDir / provider LLM config / project namespace 下，优先复用健康 sidecar。
- 最后一次使用后保留短时间，例如 3-10 分钟，再自动退出。
- 所有失败路径进入 `/runtime/status` / `/memory` diagnostics，不阻断主任务。

### 2. 不推荐：退出时留下孤儿 EverOS

不要做“BabeL-O 退出但 EverOS 继续跑”的半 daemon 方案。它会引入孤儿清理、端口占用、跨用户隔离、崩溃恢复和日志归属问题，却没有完整 daemon 的可管理性。

### 3. 未来：external daemon 仅作为显式 opt-in

如未来需要真正常驻，应作为显式 external 模式：

```text
BABEL_O_EVERCORE_MODE=external
BABEL_O_EVERCORE_BASE_URL=http://127.0.0.1:<port>
```

常驻 daemon 需要单独规划 auth/gateway、launchd/systemd-user、log rotation、health recovery 与 uninstall 行为；不在本计划短期实现范围。

## 缓存分层

### Layer A — Process Config Cache

目标：修复 embedded/runtime 每次请求重复 `configureEverCoreFromEnv()` 的问题。

建议新增 `EverCoreRuntimeManager`：

```text
getEverCore(options) -> ConfiguredEverCore
releaseEverCore(ref)
shutdownEverCore()
```

缓存 key 应至少包含：

```text
mode
baseUrl / managed host / managed port / dataDir
cwd-derived projectId / explicit projectId
appId / userId / agentId
provider adapter / baseUrl / model / llm protocol
MCP tools enabled flag
embedding config fingerprint, if managed EverOS requires cascade indexing
```

失效条件：

- env/config fingerprint 变化。
- health check 失败。
- sidecar process exit。
- explicit `/memory restart` 或 diagnostic repair action。

### Layer B — Local Sidecar Registry

目标：跨 BabeL-O 进程短时间复用 sidecar，避免多 Go TUI / CLI 短会话反复 spawn。

建议 registry 文件位于 EverCore dataDir 内，例如：

```text
~/.babel-o/evercore/sidecar.json
```

内容：

```json
{
  "schemaVersion": 1,
  "pid": 12345,
  "host": "127.0.0.1",
  "port": 7351,
  "baseUrl": "http://127.0.0.1:7351",
  "dataDir": ".../evercore",
  "configHash": "...",
  "startedAt": "...",
  "lastUsedAt": "...",
  "owner": "babel-o"
}
```

复用流程：

```text
1. read registry
2. verify dataDir + configHash compatible
3. GET /health with short timeout
4. if healthy -> reuse baseUrl
5. if unhealthy/stale -> ignore registry, spawn new sidecar, atomically replace registry
```

注意：registry 只是 hint，不是事实源；PID 存在不代表服务可用，必须 health check。

### Layer C — Idle TTL

目标：提供“温缓存”而不是永久后台常驻。

建议：

```text
BABEL_O_EVERCORE_IDLE_TTL_MS=300000   # default 5 min
BABEL_O_EVERCORE_IDLE_TTL_MS=0        # dispose immediately, test-friendly
BABEL_O_EVERCORE_IDLE_TTL_MS=-1       # disabled; do not keep warm, if accepted
```

当 active reference count 归零：

- 不立即杀 sidecar。
- 记录 `lastUsedAt`。
- TTL 到期后 health check + ownership check，再 SIGTERM。
- 新请求在 TTL 内复用并刷新 timer。

### Layer D — Search Result Short Cache

目标：减少同一 session 内重复 recall query 的网络开销。

只允许短 TTL cache：

```text
key=(sessionId, projectId, userId, agentId, query, method, topK)
ttl=30-120s
invalidate=memory_save_note | memory_flush_session | /memory refresh | provider project namespace change
```

重要边界：memory results 是 volatile hints，不可跨长期持久化，也不可替代 workspace evidence。

## `/memory` 工具与面板设计

### 命名与入口

`/memory` 是用户可见的管理入口，分 CLI slash、Go TUI slash palette 与 Nexus API 三层。它不是替代 `mcp:evercore:*` 的 provider tool；它是 runtime-owned management surface。

```text
/memory
/memory status
/memory search <query>
/memory candidates
/memory save <note>
/memory flush
/memory restart
/memory open
```

推荐首版只实现 read/status/candidates，write/restart 需要显式 permission gate。

### Nexus API

建议新增 runtime-owned API：

```text
GET  /v1/runtime/memory/status
POST /v1/runtime/memory/search
GET  /v1/runtime/memory/candidates
POST /v1/runtime/memory/save-note
POST /v1/runtime/memory/flush
POST /v1/runtime/memory/restart
```

风险分层：

| Action | Risk | Owner | Gate |
| --- | --- | --- | --- |
| status | read | runtime | none |
| search | read | runtime | bounded query budget |
| candidates | read | runtime | none |
| save-note | write | runtime/tool policy | permission_request |
| flush | write/lifecycle | runtime | explicit confirm |
| restart | lifecycle/execute-like | runtime | explicit confirm |

### Go TUI Panel

Go TUI `/memory` overlay 应参考 `/inbox`、`/activity`、`/agents` 的只读面板模式：

```text
Memory
Status: enabled managed healthy pid=12345 warm ttl=04:12
Namespace: projectId=babel-o-<hash> source=workspace user=<unset> agent=babel-o
Capability: available, auto-search cue-driven, save permission-gated
Sidecar: baseUrl=http://127.0.0.1:<redacted> dataDir=~/.babel-o/evercore
Index: keyword/vector/hybrid status, last flush, last error

Recent hits:
  - preference: regression-first fixes ...
  - constraint: verify memory before writing ...

Candidates:
  - user preference · review-only · approval=user · autoWrite=false

Actions:
  s search   c candidates   f flush   r restart   o open folder   q close
```

UI 边界：

- 默认展示 redacted endpoint；不要显示 API key、provider key、完整 secret-like env。
- `save` / `flush` / `restart` 必须进入现有 permission dialog，不在 overlay 中静默执行。
- memory candidate 展示 review-only metadata：scope、confidence、evidence refs、blocked reasons、approval requirement、autoWrite=false。
- 搜索结果明确标注 “memory hint, not workspace fact”。
- Go TUI 不自行判断事实权重，只渲染 runtime/API 返回的状态。

### CLI `/memory`

CLI 版本应输出相同信息的文本版：

```text
bbl memory status
bbl memory search "regression-first"
bbl memory candidates
bbl memory flush --confirm
bbl memory restart --confirm
```

CLI 与 Go TUI 应复用同一 Nexus API，不各自重建 EverCore client。

## 记忆能力问答治理

### 问题样本

用户问：

```text
你当前能否写入记忆？
```

不应回答：

```text
可以写入，位于 src/everCore/...，通过 MemoryProvider 暴露，commit ad22ed9 ...
```

这类回答暴露了内部路径、实现细节、提交信息与 provider-visible 内通。用户问的是能力，不是实现审计。

### 推荐用户可见答案

```text
可以，但不会自动静默写入。只有当你明确要求“记住/保存到记忆”，或批准某条记忆候选时，我才会发起写入；写入前会经过权限确认。长期记忆只作为后续会话的背景提示，不会替代当前工作区文件、会话记录或工具结果。如果你要测试，可以直接告诉我要保存的内容。
```

### Provider Guidance

在 memory capability block 或 user-intake guidance 中增加回答约束：

```text
When the user asks about memory capability, answer at the user-facing capability level.
Do not expose internal source paths, commit hashes, provider prompt details, sidecar implementation details, API keys, or hidden governance internals unless the user explicitly asks for implementation details.
```

### Regression

新增 focused regression：

```text
User: 你当前能否写入记忆？
Expected:
  - answer says memory write requires explicit user request / approval
  - answer says long-term memory is hint, not authoritative fact source
  - answer does not mention src/, MemoryProvider internals, MCP sidecar internals, commit hashes, hidden prompt, API keys
  - no tool call is required unless user explicitly asks to save/test memory
```

如果用户问“实现上怎么做的？”，可以讲高层组件，但仍默认不泄露 secrets，不把内部 prompt 原文当作答案。

## Phases

### Phase L0 — Documentation and Drift Guard

收口标准：

- 本文档进入 `docs/nexus/reference/`。
- `docs/nexus/reference/README.md` 与 `docs/nexus/TODO.md` 索引到本文档。
- `memory-capability-awareness-and-trigger-plan.md` Open Questions 指向 lifecycle/cache/UI 后续规划。

### Phase L1 — Process-level EverCore Cache

Status: implemented and verified.

收口标准：

- `embedded.ts` 不再每次 `injectJson()` 重复拉起 EverCore。
- `runSessionFlow.ts` 与 `server.ts` 复用同一 `EverCoreRuntimeManager`。
- `BABEL_O_EVERCORE_MODE=disabled` 不创建 dataDir、不分配端口、不写 registry。
- focused tests 覆盖 cache hit、config drift invalidation、dispose。

验证记录：

- `src/nexus/everCoreRuntimeManager.ts` 新增 process-level lease cache；相同 config fingerprint + healthy/disabled EverCore 会复用，config drift 时新 lease 不污染当前 active entry。
- `src/nexus/everCoreConfig.ts` 新增 `resolveEverCoreConfigInputFromEnv()`，让 env parsing 与 manager acquire 复用同一配置入口。
- `src/cli/embedded.ts` 改为通过 manager acquire EverCore；`storage.close()` 只 release lease，不杀 warm sidecar；`EmbeddedNexusClient.close()` / `executeEmbedded()` / chat finally 负责 shutdown，避免一次性命令残留子进程。
- `src/cli/runSessionFlow.ts` 与 `src/nexus/server.ts` 复用同一 manager；one-shot local flow 在 finally shutdown，server 在 Fastify `onClose` shutdown。
- `test/runtime.test.ts` 覆盖 cache hit、incompatible active config、shutdown dispose。
- `test/architecture-boundary.test.ts` 覆盖同一个 embedded client 连续 app injections 只触发一次 EverCore health/configure。

### Phase L2 — Registry Reuse + Health Check

Status: implemented and verified.

收口标准：

- managed sidecar 启动前先检查 registry + `/health`。
- stale registry 不阻塞启动；清理失败只进入 diagnostics。
- registry 写入原子化；并发启动不造成端口/dataDir 破坏。
- `/v1/runtime/status` 显示 `sidecar.reused=true|false`、registry stale reason。

实现要点：

- `src/nexus/everCoreSidecar.ts` 在 managed mode 使用 dataDir-local `sidecar-registry.json`，启动前读取 registry 并对 registry `baseUrl` 执行 `/health`；健康则直接复用，`status.sidecar.reused=true`，不分配端口、不 spawn 新进程。
- registry stale 时不阻塞启动：记录 `registryStaleReason`，best-effort 删除 stale registry，删除失败只写入 `registryCleanupError` diagnostics。
- 新 sidecar health 通过后使用 temp file + rename 原子写 registry，写失败只作为 `EVERCORE_MANAGED_REGISTRY_WRITE_FAILED` diagnostics，不让健康 sidecar 变成 fatal。
- `/v1/runtime/status` 与 `/v1/runtime/memory/status` 继续透传 `everCore.status.sidecar`，因此可见 `reused`、`registryPath`、`registryStaleReason`、`registryCleanupError`。

验证记录：

- `test/runtime.test.ts` 新增 `EverCore managed mode writes registry and reuses healthy sidecar`，验证首轮 spawn 后写 registry，第二轮健康 registry 复用且不调用 port allocator / spawn。
- `test/runtime.test.ts` 新增 `EverCore managed mode treats stale registry as diagnostics and starts a fresh sidecar`，验证 stale registry health failure 不阻塞新 sidecar，且 registry 被新 baseUrl/pid 覆盖。
- focused regression：`BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json NODE_ENV=test npx tsx --test test/runtime.test.ts --test-name-pattern="EverCore managed mode (starts local sidecar|writes registry|treats stale registry|auto-maps|uses explicit|rejects non-loopback)|runtime/status reports managed EverCore"` 143/143 pass。
- `npm run typecheck` 与 `npm run format:check` 全绿。

### Phase L3 — Idle TTL Warm Sidecar

Status: implemented and verified.

收口标准：

- reference count 降为 0 后按 idle TTL 延迟 dispose。
- 新请求在 TTL 内复用 sidecar 并刷新 timer。
- tests 可设置 TTL=0 保持 deterministic。
- 退出进程时仍 best-effort dispose owned sidecar。

实现要点：

- `src/nexus/everCoreRuntimeManager.ts` 增加 `EverCoreRuntimeManagerOptions { idleTtlMs }`，默认 idle TTL 为 5 分钟。
- lease release 后若 `refCount=0`，默认不立即 dispose，而是 `scheduleIdleDispose()`；timer `unref()`，不阻塞进程退出。
- TTL 内同 fingerprint 再次 `acquire()` 会 `cancelIdleTimer()`、复用同一 cached EverCore，并在下一次 release 时刷新 idle timer。
- `idleTtlMs <= 0` 立即异步 dispose，保留测试 deterministic 语义。
- `shutdown()` / incompatible config disposal 仍调用 `disposeEntry()`，会取消 pending idle timer 并 best-effort dispose owned sidecar。

验证记录：

- `test/runtime.test.ts` 新增 `EverCore runtime manager keeps idle sidecar warm until TTL expires`，验证 release 后 TTL 内不 dispose，TTL 到期后 dispose，再 acquire 会重新 configure。
- `test/runtime.test.ts` 新增 `EverCore runtime manager reuses and refreshes idle TTL lease before expiry`，验证 TTL 内 reacquire 复用并刷新 timer。
- `test/runtime.test.ts` 新增 `EverCore runtime manager supports deterministic idleTtlMs=0 disposal`，验证测试可设置 TTL=0 让 release 后立即 dispose。
- focused regression：`BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json NODE_ENV=test npx tsx --test test/runtime.test.ts --test-name-pattern="EverCore runtime manager (reuses matching|does not reuse incompatible|keeps idle|reuses and refreshes|supports deterministic)"` 146/146 pass。
- `npm run typecheck` 与 `npm run format:check` 全绿。

### Phase L4 — `/memory status` and Panel MVP

Status: implemented and verified.

收口标准：

- Nexus API 提供 read-only memory status。
- CLI `/memory status` 与 Go TUI `/memory` overlay 展示相同核心字段。
- 面板显示 capability / namespace / sidecar / index / candidates summary。
- 所有 endpoint/API key/provider key 均 redacted。

实现要点：

- `GET /v1/runtime/memory/status` 返回 `{ type, capability, everCore, guidance, actions }`，`everCore` 字段来自 `defaultEverCoreStatus()`，保证嵌入式客户端、CLI 客户端、Go TUI 三端看到一致的数据。
- `embedded.close()` 触发 `defaultEverCoreRuntimeManager.shutdown()`，保证嵌入式复用 lease 在进程退出时回收。
- Go TUI `/memory` overlay 走 `fetchMemoryStatus` → `memoryStatusMsg` → `modeMemoryOverlay`，在 `usesFullScreenOverlay` 与 `renderFullScreenOverlay` 中并入 read-only 路径，并在 `nonTranscriptChromeHeight` 中预留行高。

验证记录：

- `test/architecture-boundary.test.ts` 覆盖嵌入式客户端 `/v1/runtime/memory/status` envelope，并验证两次 `client.status()` + `listSessions` 之间 health endpoint 仅被探测一次（cache 命中）。
- `test/runtime.test.ts` 覆盖 `/v1/runtime/memory/status` 在 enabled+healthy 时 `capability.available=true`、enabled+unhealthy 时 `capability.available=false`、未配置时 `capability.available=false`。
- `clients/go-tui/internal/tui/overlay_memory.go` 提供 `buildMemoryOverlayLines` / `renderMemoryOverlayLines` / `renderMemoryOverlay` / `anyBool`，统一使用 `asMap` / `stringField` / `anyInt` / `fallbackUnknown` 等共享辅助函数。
- `clients/go-tui/internal/tui/tui_test.go` 新增 `TestBuildMemoryOverlayLinesParsesMemoryStatusPayload`、`TestBuildMemoryOverlayLinesEmptyAndErrorPaths`、`TestBuildMemoryOverlayLinesUnhealthyState`、`TestRenderMemoryOverlayLinesClampsScroll`、`TestRenderMemoryOverlayEmptyOutsideMode`、`TestRenderMemoryOverlayShowsHeaderInMode`、`TestUsesFullScreenOverlayIncludesMemoryOverlay` 七条 focused 回归。
- `clients/go-tui` 全量 `go test ./internal/tui` 与 TS focused regression (`test-name-pattern="runtime/memory/status|embedded Nexus client|EverCore"`, 142/142)、`npm run typecheck`、`npm run format:check` 全绿。

### Phase L5 — `/memory` Actions

Status: implemented and verified.

收口标准：

- `/memory search` 走 bounded read-only API。
- `/memory candidates` 展示 review-only candidate governance metadata。
- `/memory save`、`flush`、`restart` 必须进入 permission gate。
- save/flush 后 search short cache 失效。

实现要点：

- Nexus API 新增 `POST /v1/runtime/memory/search`、`GET /v1/runtime/memory/candidates`、`POST /v1/runtime/memory/save-note`、`POST /v1/runtime/memory/flush`、`POST /v1/runtime/memory/restart`。
- `search` 复用 `EverCoreClient.search()` + `extractEverCoreMemoryHits()` + `formatMemoryProviderHits()`，返回 bounded read-only hints，并显式带 `memoryIsHint=true` / `projectFactsRequireWorkspaceEvidence=true`。
- `candidates` 从 SessionChannel `memory_candidate` message 中读取 `memoryCandidateGovernance`，只展示 review-only metadata：scope、decision、approval、evidence、blocked/review reasons、`autoWrite=false`。
- `save-note` / `flush` / `restart` 先返回 `memory_action_approval_required`（HTTP 202），只有 `approved=true` 或匹配 `confirmation` 后才继续执行；`restart` 当前只完成 gate，确认后返回 `MEMORY_RESTART_NOT_IMPLEMENTED`，不静默重启 runtime。
- TS `NexusClient` 与 embedded Nexus client 暴露 `memorySearch()` / `memoryCandidates()` / `memorySaveNote()` / `memoryFlush()` / `memoryRestart()`。
- Go TUI `/memory` 支持 `status`、`search <query>`、`candidates`、`save <note>`、`flush`、`restart` 子命令；overlay 可渲染 search/candidates/approval/error/mutation envelopes。

验证记录：

- `test/runtime.test.ts` 新增 `/v1/runtime/memory/search returns bounded read-only memory hints`、`/v1/runtime/memory/candidates reports review-only governance metadata`、`/v1/runtime/memory write and lifecycle actions require explicit approval`。
- `clients/go-tui/internal/tui/tui_test.go` 新增 search result、candidates result、approval-required result 三类 memory overlay focused regression。
- `go test ./internal/tui` 全过；TS focused regression (`test-name-pattern="runtime/memory/(status|search|candidates|write)|embedded Nexus client"`, 145/145) 全过；`npm run typecheck` 与 `npm run format:check` 全绿。
- 当前实现没有启用持久 search short cache；save/flush response 明确返回 `searchCacheInvalidated=true`，为后续 Layer D cache 落地保留失效边界。

### Phase L6 — Capability Answer Regression

Status: implemented and verified.

收口标准：

- focused mock provider regression 覆盖“能否写入记忆？”问答不泄露内部路径/commit/MCP/hidden prompt。
- 明确记忆写入条件与 permission gate。
- 对纯能力问答不触发 tool call；对“请记住...”仍保持 `requiresTools=true`。

验证记录：

- `src/runtime/intentGuidance.ts` 将“能否写入记忆？”类能力问答归为 `status/respond_only/requiresTools=false`，并避免被 broad `写入.*记忆` 误判为真实写入请求。
- `src/runtime/contextAssembler.ts` 的 `Long-Term Memory Capability` block 增加用户级能力回答约束，不暴露 source path、commit hash、hidden prompt、provider internals、MCP sidecar details、API keys 或 secrets。
- `src/runtime/runtimePipeline.ts` / `src/runtime/LLMCodingRuntime.ts` 增加窄范围 runtime guard：仅对 memory capability answer 检测内部实现泄露，抑制首次泄露回答并重试一次；若仍泄露，则返回安全 fallback。
- `test/runtime-llm.test.ts` 覆盖分类、工具隐藏、泄露抑制、重试与最终 answer 无内部路径/commit/MCP sidecar 的结果。

## Open Questions

- registry 是否应放在 global `~/.babel-o/evercore/`，还是每个 `BABEL_O_EVERCORE_DATA_DIR` 内？推荐 dataDir-local。
- idle TTL 默认应为 3 分钟、5 分钟还是 10 分钟？推荐 5 分钟，测试可置 0。
- `/memory open` 是否应打开 dataDir，还是只打印路径？Go TUI 内推荐只显示路径，CLI 可 opt-in 打开。
- `restart` 是否属于 execute-like risk，还是 lifecycle write-risk？推荐 lifecycle/execute-like，必须确认。
- search short cache 是否需要跨 session？推荐不跨 session。
- memory capability answer guard 放在 capability block、intake fallback，还是 runtime final-answer sanitizer？当前已采用三层最小护栏：capability block 指令、intake fallback 分类、以及窄范围 runtime answer leakage suppression。

## Recommended Next Slice

```text
1. L1/L2/L3/L4/L5/L6 已收口；lifecycle/cache/UI/answer-governance 后续规划当前关闭。
2. Layer D search short cache 暂未启用；如后续真实重复 recall query 暴露网络开销，再按 P2 开最小 cache，并必须复用 L5 save/flush 的 searchCacheInvalidated 边界。
3. `/memory restart` 当前只完成 approval gate + 未实现诊断；只有出现真实 runtime-owned restart 需求时再单独开项。
```
