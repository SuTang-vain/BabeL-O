# Go TUI Session 可观测性 / Embedded Nexus 持久化 治理规划

> Status: **源码核对后：部分收口 / 文档曾过度收口**（Phase 0 已收口；Phase 1 server UUID 分配与本地映射日志部分落地；Phase 2 生产默认 SQLite 已落地但 launcher/check 仍未收口；Phase 3 Nexus 启动日志与 reverse-resolve 部分落地；Phase 4 跨文档状态已同步但 PTY/e2e 守门仍未补齐）。原始真实样本 `session_go_1781146359507755000` 仍不能保证端到端复盘；新会话只有在 client log + SQLite row 同时存在时才能 reverse-resolve。
> Priority: 真实会话 regression-first；`session_go_1781146359507755000` 暴露的"session 创建后无法复盘"是 P0 可观测性盲区——任何在 Go TUI 下发生的 Bash 写命令 permission drift 都无法追查
> 真实样本: `session_go_1781146359507755000`（Go TUI WebSocket 会话，sessionId 末段 755000 来自 `session_go_<unixnano>` 命名；用户 2026-06-11 10:52:39 CST 创建；本地 Nexus SQLite 0 命中；运行中的 Nexus `execute.count: 0` 也不命中）

---

## 1. 背景

用户在 2026-06-11 10:52:39 CST 触发了一次 Go TUI 会话（`session_go_1781146359507755000`），随后要求分析"该会话的潜在问题"。分析结果显示 **该 session 在任何可访问的存储后端都不存在**：

| 位置 | 结果 |
|---|---|
| `/Users/tangyaoyue/.babel-o/db.sqlite`（本地 Nexus SQLite，472 sessions）| **未找到**（所有 session_id 都是 `session_<uuid>` 格式，无 `session_go_` 前缀）|
| `/Users/tangyaoyue/DEV/BABEL/BabeL-O/.babel-o/`（BABEL repo 内的 .babel-o）| **无 db.sqlite**（只有 test fixture 与 worktrees 目录）|
| 远端文件系统全盘搜索 `session_go_1781*` | **0 命中** |
| `~/.crush/crush.db` | 不存在 |
| `~/.codex/sessions/2026/05/*` | 0 命中 |
| `~/.agent_cli/projects/*/` | 0 命中 |
| `~/.gemini/antigravity-cli/db.sqlite` | 空文件（0 字节）|
| 当前运行 `http://127.0.0.1:3000` Nexus（v0.3.2, uptime 4 秒）| `/v1/sessions/session_go_1781146359507755000` 返回 `SESSION_NOT_FOUND`；`/v1/sessions` 列表为空；`execute.count: 0` |

`/v1/runtime/status` 显示该 Nexus 启动于 `2026-06-11T03:08:07.501Z`（即 CST 11:08:07），**晚于 session 创建时间约 15 分钟**——即 session 创建时的 Nexus 进程已退出，事件流没有持久化到任何可访问的存储后端。

完整时序（来自 `python3 -c "from datetime import datetime, timezone; print(datetime.fromtimestamp(1781146359507755000 / 1e9, tz=timezone.utc).isoformat())"`）：

```text
2026-06-11 02:52:39.507755 UTC  session_go_1781146359507755000 created (Go TUI client)
2026-06-11 02:53:55.532 UTC    user prompt: "session_go_1781146359507755000查看最新的会话信息，分析潜在的问题"
2026-06-11 03:08:07.501 UTC    current local Nexus process started
2026-06-11 03:11:45.559 UTC    current query: GET /v1/sessions/session_go_1781146359507755000
                                → SESSION_NOT_FOUND
```

**根因诊断结果**：session 数据**不可复盘**这件事本身就是真实的运维风险——任何在 Go TUI 下发生的 Bash 写命令 permission drift、timeout 误标、provider 错答都无从追查。这与 `docs/nexus/TODO.md` P0 行的"真实会话 regression 守门"原则直接冲突：regression-first 需要 session 可复盘。

---

## 2. 根因

### 2.1 Session ID 双轨命名（最高优先级根因）

Nexus 服务端 `prepareExecution` 接受 `sessionId` 字段（`src/nexus/app.ts` schema 透传），Go TUI 客户端在 `runStream` 调用时随机生成 `session_go_<unixnano>` 格式的 sessionId（`clients/go-tui/main.go:runStream()` 启动时 `sessionID := fmt.Sprintf("session_go_%d", time.Now().UnixNano())`，无服务端协调）。两个 sessionId **不是同一个 ID**：

- 服务端：接受 Go TUI 发的 `session_go_1781146359507755000`，但内部 SQLite 用同样的 key 存（在 `sessions` 表的 `session_id` 列），所以本地 SQLite **应该有**这条记录。
- 客户端：Go TUI 内部用 `session_go_1781146359507755000` 跟踪 streaming、permission panel 状态、pending decisions。
- 跨系统追踪：用户用 `session_go_xxx` 找不到任何东西（事件流、permission audits、tool traces），但 `session_<uuid>` 又找不到 Go TUI 命名约定的 ID。

**实际验证**：本地 SQLite 472 sessions 全部是 `session_<uuid>` 格式（`session_9abe6d70-5981-4024-bb0b-2b5229fbc150` 等），没有任何 `session_go_` 前缀——**这说明 Go TUI session 从来没持久化到本地 SQLite**。换言之，**Go TUI session 在 Nexus 端用 `session_go_xxx` 持久化，但这些 session 在本地 SQLite 里查不到**。这是更严重的 bug：本应存到 SQLite 的事件没有存。

### 2.2 Embedded Nexus 走 MemoryStorage 而非 SQLite

`src/nexus/server.ts:23-24`：

```ts
const storagePath = process.env.NEXUS_STORAGE_PATH
const allowedTools = parseAllowedTools(process.env.NEXUS_ALLOWED_TOOLS)
```

`createDefaultNexusRuntime`（`src/nexus/createRuntime.ts`）在 `storagePath` 未设时回退 `MemoryStorage`。`bbl go` 启动 embedded Nexus 时（`clients/go-tui/main.go` 的 `__server` 启动路径，`docs/nexus/DONE.md:204` 已收口），`NEXUS_STORAGE_PATH` 未设置——embedded Nexus 走 `MemoryStorage`，进程退出即丢全部 events / sessions / permission_audits / tool_traces / execution_metrics。

这与 `session_go_1781146359507755000` 完美吻合：session 跑在 embedded Nexus（`bbl go` 自动拉起的 hidden `__server` 进程）上，进程退出时 SQLite 没被写入过任何东西。

### 2.3 无 session-start 日志

embedded Nexus 启动时无 `session_go_xxx → sqlite-mapping` 日志写入 `~/.babel-o/log/embedded-nexus.log`。Go TUI 客户端无 `client_log` 记录哪条 `permission_request` 发到了哪个 sessionId。事后回查完全靠用户记忆或 sqlite 直接 grep（如果存在的话）。

### 2.4 server-side `execute.count: 0` 反证

当前 Nexus `/v1/runtime/status.metrics.execute`：`count: 0`。说明该 Nexus **从未执行过任何 provider call**——它启动后只跑了 6 个 `GET` for `/health` / `/v1/runtime/{config,profiles,models,version,sessions}` 路由。

如果 `session_go_1781146359507755000` 真的跑过 provider 调用，**embedded Nexus 进程当时**应该已经把这些 execute 计数器累加上去了，**但当前进程**的 metrics 是从 0 开始的（uptime 4160ms），完全独立的实例。这条反证进一步坐实了 `2.1` + `2.2` 的判断：session 跑在另一个**已死掉的** embedded Nexus 进程上。

---

## 3. 目标行为

1. **所有 Go TUI session 在 Nexus SQLite 中可查**：Go TUI 跑过的 session 在 `~/.babel-o/db.sqlite` 的 `sessions` 表里能 grep 到（用 Go TUI 自己的 `session_go_xxx` 命名 或 Nexus 分配的 `session_<uuid>` 命名，两边能交叉引用）。
2. **embedded Nexus 默认持久化到 SQLite**：`bbl go` 启动的 hidden `__server` 进程不依赖 `NEXUS_STORAGE_PATH` 也能把 session 写到 `~/.babel-o/db.sqlite`，进程退出后 session 仍可查。
3. **session-start 日志可回查**：embedded Nexus 启动时写一条 `~/.babel-o/log/embedded-nexus.log` 行，包含 `pid`、`session_go_xxx`（如有）、`storage_path`、`started_at`、client 进程命令行；Go TUI 客户端在 transcript / footer 暴露"本会话持久化路径"。
4. **Go TUI session ID 命名统一**（按需推进）：Go TUI 在启动时 `POST /v1/sessions` 拿 server 分配的 `session_<uuid>`，再用于 `runStream` 的 `sessionId` 字段——同一 ID 在客户端与服务端全程可追踪。
5. **session 不可访问时给出明确 hint**：当用户用 `session_go_xxx` 找 session 但 SQLite 找不到时，`/v1/sessions/session_go_xxx` 返回 404 + redacted hint "session not persisted（可能因 embedded Nexus 走 memory storage 而丢失）"，而不是笼统的 `SESSION_NOT_FOUND`。

---

## 4. 非目标

- 不在 Go TUI 端持久化 session 副本（避免双写 source-of-truth 风险）。
- 不修改 `MemoryStorage` 行为本身（保留 per-process option 给 unit test / 短生命周期的 runner）。
- 不引入新的 storage backend（不写 postgres / s3 之类）。
- 不修改 `permission_request` / `permission_response` / `tool_denied` 事件 schema。
- 不在 plan 里定义新的权限策略（`go-tui-permission-policy-governance-plan.md` 已经在这一面闭环）。
- 不把 `~/.babel-o/config.json` 写入测试进程（继续按 `babel-o-test-config-isolation.md` 守门）。
- 不在 Phase 10 默认化里解决（见 `go-tui-rewrite-plan.md`，session ID 统一建议在那里推）。

---

## 5. 分阶段修复方案

### Phase 0: 文档守门 + session ID 探查工具（最小，2-3 天）

状态：已落地。

落地点：

- `src/cli/commands/inspectSession.ts` 新增（~250 行）：导出 `inspectSession(id)` / `findSessionInSqlite(id, { sqlitePath })` / `grepLogForSessionId(logPath, id, opts)` / `grepRecentEmbeddedNexusStarts(logPath, opts)` / `resolveSqlitePath()` / `resolveLogPaths()` / `resolveConfigDir()` / `registerInspectSessionCommand(program)`。三档 hint 模型：
  - **tier (a) found-in-sqlite**：用 `node:sqlite` 的 `DatabaseSync` 以 `readOnly: true` 模式查 `~/.babel-o/db.sqlite` 的 `sessions` 表，命中返回 `{ sessionId, phase, cwd, createdAt, updatedAt, prompt, result, error, eventCount }`。
  - **tier (b) found-in-client-log-only**：SQLite 没有但 `~/.babel-o/log/go-tui-session.log`（Phase 1 客户端日志）含 sessionId —— "embedded Nexus crashed before save" 典型样本。
  - **tier (c) not-found**：两边都没有，扫 `~/.babel-o/log/embedded-nexus.log`（Phase 3 服务端启动日志）取最近 20 条 `bbl-go[pid=...]` / `nexus[pid=...]` 启动行作为 hint。
- `src/cli/program.ts` 注册 `registerInspectSessionCommand(program)`，命令为顶级 `bbl inspect-session <sessionId>`。`--json` 输出原始 JSON；`--sqlite-path <path>` 仅测试用。
- `test/inspect-session.test.ts` 新增 16 个 focused 测试守门：tier (a) 命中渲染、tier (a) events=0、tier (b) 客户端日志命中、tier (c) 含最近 embedded-nexus 启动记录、tier (c) 无任何 log、SQLite 缺失不抛、SQLite 损坏不抛、`findSessionInSqlite` 直传 sqlitePath、null 命中、`grepLogForSessionId` 行号 + maxLines 截断、长行 `…` 截断、`grepRecentEmbeddedNexusStarts` pid/storage/cwd/startedAt 字段解析 + maxLines 截断、`resolveConfigDir` 守 BABEL_O_CONFIG_DIR（**关键**：每次调用重读 env 而非依赖 module-level `DEFAULT_CONFIG_DIR` 缓存，确保测试隔离）、`registerInspectSessionCommand` 注册 `inspect-session` 子命令、`session_go_` ID 真实失败模式端到端复现。
- **测试隔离守门**：`withTempConfigDir` helper 用 `mkdtempSync` + `BABEL_O_CONFIG_DIR` 注入临时目录；`try/finally` 还原原 env。**不**碰真实 `~/.babel-o/config.json`。
- **三档 hint 输出 UX**：tier (a) `chalk.green` + 字段表；tier (b) `chalk.yellow` + log 行展示；tier (c) `chalk.red` + 4 条 "suggested next steps" + 最近 embedded-nexus 启动行。
- 4 份文档同步（TODO / DONE / WORK_LOG / reference/README）—— 单独 Phase 0 文档守门条目见下。

收口标准：

- 跑 `BABEL_O_CONFIG_DIR=/tmp/x bbl inspect-session session_go_1781146359507755000` 给出 tier (c) "session not found" + 3 条 suggested next steps + (若存在) 最近 embedded-nexus 启动记录。✅
- 跑 `BABEL_O_CONFIG_DIR=<含 go-tui-session.log 的目录> bbl inspect-session session_go_<id>` 命中 tier (b) "found in client log only"。✅
- 跑 `BABEL_O_CONFIG_DIR=<含 db.sqlite 且 sessions 表有该 id 的目录> bbl inspect-session session_<uuid>` 命中 tier (a) "found in SQLite"，渲染 phase / cwd / events / prompt / result。✅
- 真实 CLI smoke 验证：`BABEL_O_CONFIG_DIR=/tmp/x bbl inspect-session session_go_1781146359507755000` 输出正确的 tier (c) 提示（无 sqlite、无 log）。✅
- 16 个 focused tests 全过（`npx tsx --test test/inspect-session.test.ts`）。✅
- 4 份文档同步。

### Phase 1: Go TUI 与 Nexus session ID 命名统一（中等，5-7 天）

状态：**部分落地；原文“已落地”过度乐观**。

源码核对结果：

- `clients/go-tui/internal/tui/tui.go:7843` 的 `runStream()` 在 `cfg.SessionID == ""` 时会先调用 `allocateServerSession(cfg, prompt)`，把 WebSocket `buildExecuteRequest(..., sessionID, ...)` 的 `sessionId` 改为服务端分配的 `session_<uuid>`；server 返回错误 / empty `sessionId` 时会显式 error，不静默 fallback。
- `src/nexus/app.ts:1219` 已有 `POST /v1/sessions`，支持分配 `session_<uuid>` 并在 body 带 `clientSessionId` 时写入 session metadata；`test/inspect-session-phase1.test.ts` 覆盖 allocation、list round-trip、`clientSessionIdSetAt`。
- **但 Go TUI 当前并没有把本地 `session_go_<unixnano>` 传给 `POST /v1/sessions`**：`allocateServerSession()` 只发送 `metadata: { client: 'go-tui', phase: 'session_allocate' }`，随后 `runStream()` 才生成 `clientSessionID := fmt.Sprintf("session_go_%d", time.Now().UnixNano())` 并写本地 `~/.babel-o/log/go-tui-session.log`。因此服务端 SQLite metadata 不含 Go TUI 生成的 clientSessionId，反查依赖本地 client log。
- `m.sessionID` 不是 allocation 后立即更新；Go TUI model 在 `consumeNexusEvent()` 收到 `session_started` 后用事件里的 `sessionId` 更新 UI 状态。可以确认的是 WebSocket payload 使用 server UUID。
- 仓库中没有 `clients/go-tui/internal/tui/phase1_session_id_test.go`，也没有原文列出的 7 个 Go 专名测试；只有既有 `fakeNexusWSPermissionHandler` 支持 `POST /v1/sessions`，并在 permission-policy 相关 runStream 测试中间接覆盖。

收口标准核对：

- ✅ WebSocket execute payload 使用服务端 UUID，不再默认发送 `session_go_<unixnano>`。
- ⚠️ Go TUI 本地 `clientSessionId → serverSessionId` 只写 `~/.babel-o/log/go-tui-session.log`，未写入服务端 session metadata。
- ⚠️ UI `m.sessionID` 随 `session_started` 更新，不是 allocation 后立即更新。
- ❌ 原文列出的 7 个 Go focused tests 文件/用例不存在；应补测试或删掉该收口断言。
- 不在 Phase 10 默认化前修改 `bbl chat` 命名约定（CLI 继续用 `session_<uuid>` 命名）。

### Phase 2: embedded Nexus 默认持久化到 SQLite（核心，5-7 天）

状态：**部分落地；仍需 launcher / check / e2e 守门补齐**。

源码核对结果：

- ✅ `src/nexus/createRuntime.ts:73` 已新增 `resolveDefaultStoragePath()`：生产路径（`NODE_ENV !== 'test'` 且无显式 `storagePath`）默认 `~/.babel-o/db.sqlite`，并尊重 `BABEL_O_CONFIG_DIR` / `BABEL_O_CONFIG_FILE`；显式 `:memory:` 与 `NODE_ENV=test` 仍使用 `MemoryStorage`，守住测试隔离。
- ✅ 显式 sqlite path 会解析为绝对路径；`SqliteStorage` 构造器会创建父目录，不需要 launcher 额外 mkdir。
- ✅ `test/inspect-session-phase2.test.ts` 覆盖 explicit `:memory:`、显式 sqlite、relative path absolute、test-mode memory、production default sqlite、`BABEL_O_CONFIG_DIR` override。
- ⚠️ `src/cli/commands/go.ts:createManagedNexusLaunchSpec()` 没有显式设置 `NEXUS_STORAGE_PATH` 或 `BABEL_O_STORAGE_PATH`；`bbl go` 目前依赖 runtime 生产默认 SQLite，而不是 launcher 显式传 storage env。
- ⚠️ `src/nexus/server.ts` 的启动 console 文案仍在 `storagePath` 未设时打印 `storage=memory`，与实际 `resolveDefaultStoragePath(undefined)` 的生产默认 SQLite 不一致。
- ❌ 没有 `startupDiagnostics` helper；没有统一 `storageBackend` 字段模型。
- ❌ 尚未看到真实 `bbl go` 启动 embedded `__server` 后“退出再重启仍能 inspect”的端到端测试。

收口标准核对：

- ✅ production/runtime 默认不再回退 MemoryStorage。
- ⚠️ Go TUI embedded launcher 未显式传 storage env；可接受作为实现策略，但需更新规划或补 launcher env 守门。
- ⚠️ `storageBackend` 诊断不是稳定结构化字段；server startup log 写的是 `storage=<path|kind>`。
- ❌ `bbl go --check` 未报告 `embedded-nexus-storage: <path>`。
- ❌ 缺少 Phase 2 的真实 embedded restart / inspect e2e 守门。

### Phase 3: session-start 日志与端到端映射（收尾，3-4 天）

状态：**部分落地；server log + reverse-resolve 已有，client/startup UX 未收口**。

源码核对结果：

- ❌ `clients/go-tui/cmd/go-tui/main.go` 只是 flag parsing / `tui.Run(cfg)`，没有启动 `__server`，也没有写 `bbl-go[pid=...] starting embedded Nexus ...` 日志。embedded Nexus auto-start 实际在 `src/cli/commands/go.ts`，该文件也没有写 `bbl-go[...]` startup log。
- ✅ `src/nexus/server.ts:112` 在 `app.listen()` 后 best-effort 追加 `~/.babel-o/log/embedded-nexus.log`：`nexus[pid=...] listen=... storage=... executePolicyMode=... cwd=...`。
- ⚠️ `src/nexus/server.ts` 里 `executePolicyMode` 日志读取的是 `BABEL_O_NEXUS_DEFAULT_POLICY_MODE ?? 'strict'`，但实际配置变量是 `NEXUS_DEFAULT_POLICY_MODE`；日志字段可能与真实 policy mode 不一致。
- ❌ Go TUI transcript/header 未发现 `Session persisted: ~/.babel-o/db.sqlite#session_<uuid>` 文案或持久化路径展示。
- ✅ `src/cli/commands/inspectSession.ts` 已有 `reverseResolveClientSessionId()`，但它扫描的是 `~/.babel-o/log/go-tui-session.log`，不是 `embedded-nexus.log`；`test/inspect-session-phase3.test.ts` 覆盖 client log reverse-resolve 到 SQLite row。
- ❌ `/v1/sessions/:sessionId` 404 仍返回普通 `SESSION_NOT_FOUND`，未给 `session_go_xxx` 的 redacted persistence hint。

收口标准核对：

- ⚠️ 每次 Nexus server 启动会有 `nexus[pid=...]` 行；没有 `bbl-go[pid=...]` 行。
- ✅ `bbl inspect-session session_go_xxx` 可在 client log 存在映射时 reverse-resolve；全 0 命中时给 suggested next steps。
- ❌ 尚未证明真实 Bash 写命令 regression 跑完、重启 `bbl go` 后仍能 resume / 复盘。

### Phase 4: 文档与守门标准同步（守门，1-2 天）

状态：**文档状态已同步到“部分收口”事实；PTY/e2e 守门仍未补齐**。

源码/文档核对结果：

- ✅ `docs/nexus/reference/README.md` 已登记本文件，并改为“Phase 0 已收口、Phase 1/2/3 部分落地、Phase 4 仍需守门”的描述。
- ✅ `docs/nexus/TODO.md:33` 已从“Phase 1/2/3/4 待办”更新为源码核对后的部分落地状态和剩余优先项。
- ✅ `docs/nexus/WORK_LOG.md:5352` 已追加 Phase 1/2/3 部分落地与 Phase 4 待补守门的核对流水。
- ✅ `docs/nexus/DONE.md` 已保留 Phase 0 收口条目，并新增“源码核对同步”条目；没有虚构 Phase 1/2/3/4 全部收口。
- ❌ `test/go_tui_pty_driver.py` 未发现 `embedded-nexus-persists-session` / `embedded-nexus-startup-log` / `go-tui-session-id-is-server-uuid` 三个序列；当前 smoke driver 仍由测试进程显式启动 Nexus，并传 `NEXUS_STORAGE_PATH` 到临时 db，不能守住 `bbl go` embedded 默认持久化。
- ❌ `bbl go --check` 未输出 `embedded-nexus-storage: <path>`。

收口标准：

- 补 PTY 或等价 e2e 守门，覆盖 embedded default storage、startup log、clientId→serverId→SQLite inspect。
- `bbl go --check` 新增 storage 诊断。

---

## 6. 与其它 reference 文档的关系

- [go-tui-permission-policy-governance-plan.md](./go-tui-permission-policy-governance-plan.md)：本规划的下游。Phase A + B + A.1 + B 推进 已收口，但**没有 session 可观测性就不能 regression-first 守门**——本文件补这一缺口。
- [session-finalization-and-evidence-governance-plan.md](./session-finalization-and-evidence-governance-plan.md)：本规划不涉及 terminal event 复用 / current-turn finalization。但 P0 收口**同样依赖** session 可复盘——本文件与它是 P0 守门的一对。
- [go-tui-rewrite-plan.md](./go-tui-rewrite-plan.md)：Phase 10 规划时把 session ID 统一推进到 default 路径（与本 Phase 1 同方向但更激进）。
- [session-channel-tui-relationship-visibility-plan.md](./session-channel-tui-relationship-visibility-plan.md)：不重叠——那是 `SessionChannel` 跨 session 通信的可见化，不解决"单 session 不可复盘"。
- [tool-granularity-and-evidence-governance-plan.md](./tool-granularity-and-evidence-governance-plan.md)：不重叠——那是 tool 粒度与 evidence 治理，不解决 session storage。
- [workspace-path-drift-governance-plan.md](./workspace-path-drift-governance-plan.md)：不重叠——那是 cwd / path 漂移诊断，不解决 session 存储。

---

## 7. 验证命令

```bash
# TypeScript 类型检查
npm run typecheck

# Phase 0: inspect-session CLI
npx tsx --test test/inspect-session.test.ts

# Phase 1: Go TUI session ID 统一
cd clients/go-tui && go test ./internal/tui/ -run "TestSessionIdIsServerUuid" -v

# Phase 2: embedded Nexus 持久化
BABEL_O_CONFIG_FILE=/tmp/babel-o-observability-regression.json \
  npm test -- --runInBand test/embedded-nexus-persistence.test.ts

# Phase 3: session-start 日志
ls -la ~/.babel-o/log/embedded-nexus.log
tail -5 ~/.babel-o/log/embedded-nexus.log

# Phase 4: 真实 Bash regression + inspect
BABEL_O_CONFIG_FILE=/tmp/babel-o-permission-policy-regression.json \
  npm run --silent dev -- go --check
```

注意：

- 只跑 check-only format 验证，不跑 broad auto-formatter。
- 真实 regression 必须用 `BABEL_O_CONFIG_FILE` 隔离 config，避免污染 `~/.babel-o/config.json`。
- 不在测试中调用真实 provider / 真实 LLM API；使用 mock runtime / mock provider。
- `bbl inspect-session` 的 mock 测试用 `MemoryStorage` 临时 backend，不污染真实 SQLite。

---

## 8. 源码核对后的收口状态

已满足：

- `bbl inspect-session <any-id>` 子命令上线，能给出"已找到 / 找到 client log 但 sqlite 缺 / 完全未找到"三档 hint。
- `createDefaultNexusRuntime()` 生产默认 storage 已从隐式 `MemoryStorage` 改为 `~/.babel-o/db.sqlite`；`NODE_ENV=test` 和显式 `:memory:` 仍保持测试隔离。
- Go TUI 默认 WebSocket execute payload 使用 `POST /v1/sessions` 分配的 server UUID。
- `~/.babel-o/log/go-tui-session.log` 可记录 `clientSessionId → serverSessionId`，`inspectSession()` 可据此 reverse-resolve 到 SQLite row。
- Nexus server 启动后会 best-effort 写 `nexus[pid=...] listen=... storage=...` 到 `~/.babel-o/log/embedded-nexus.log`。

仍未满足 / 需补齐：

- Go TUI 没有把本地 `session_go_<unixnano>` 作为 `clientSessionId` 传给 `POST /v1/sessions`，server SQLite metadata 不能直接反查 client id。
- embedded launcher 没有写 `bbl-go[pid=...]` 启动行，也没有显式传 `NEXUS_STORAGE_PATH`；当前依赖 runtime 默认值。
- Go TUI transcript/header 未展示 `Session persisted: ~/.babel-o/db.sqlite#session_<uuid>`。
- `/v1/sessions/:sessionId` 对 `session_go_xxx` 的 404 仍是普通 `SESSION_NOT_FOUND`，没有 redacted persistence hint。
- `bbl go --check` 未输出 `embedded-nexus-storage: <path>`。
- TODO / DONE / WORK_LOG / reference README 已同步到“部分收口”事实，但 Phase 4 的 PTY/e2e 守门仍未补齐。
- `test/go_tui_pty_driver.py` 未新增 embedded persistence / startup log / server UUID transcript 三条 smoke 序列。

完成事实按 [../README.md 维护规则](../README.md) 写入 [../DONE.md](../DONE.md)。
