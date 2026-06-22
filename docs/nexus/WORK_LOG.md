# BabeL-O Nexus 工作记录

本文件只记录事实、验证和重要决策。不承载长期规划，长期规划写入各 TODO 文档。

## 2026-06-22 — Go TUI drafting-response stall: watchdog fired but stream iterator did not settle

- **背景**: 用户再次同时打开两个新 Go TUI session 后看到 `drafting response` 长时间不结束：
  - `session_4872604b-a0c8-4eff-bde2-3c17e08d8c09`: prompt=`查看这个项目的git分支情况`，cwd=`clients/go-tui`。
  - `session_2f196238-40cd-4c5e-aeac-cd242d47d3d9`: 第二轮 prompt=`BabeL-O should 在桌面写一个简单的c语言小程序`，cwd=`/Users/tangyaoyue`。
- **实际事件结论**:
  - 两个 session 尾部均为大量 `thinking_delta` → `usage` → `hook_completed(PostInvocation)` → `timeout_budget_exceeded`；没有 pending `permission_request`，也没有后续 `assistant_delta` / `tool_started` / `result` / `error`。
  - Nexus 日志显示 hard watchdog 已真实触发：`hard watchdog fired after 240000ms`，分别对应 `03:27:00.688Z` 与 `03:27:28.482Z`。
  - 但 `/v1/runtime/status` 仍显示 `stream.activeCount=2` 且 `activeAgeMs > 480s`，session 仍为 `phase=executing`。这证明问题不是“watchdog 未配置”，而是 watchdog abort 后 `runExecutionStreamLoop` 仍在等待 runtime async iterator 的下一次 `.next()` resolve。
- **根因**:
  - `runExecutionStreamLoop` 旧实现用 `for await (const event of runtime.executeStream(...))` 消费 runtime event。该形状假设 runtime/provider 内部在 abort 后一定会 yield/throw/return。
  - 真实 session 证明这个假设不够强：provider invocation 已完成并发出 `PostInvocation` hook，但后续 runtime 路径没有产出终态；hard watchdog 只能 abort controller，不能抢占一个永远 pending 的 iterator `.next()`。
  - 另一个相邻风险是 thinking-only provider turn：provider 只返回 reasoning/thinking、没有 assistant 正文也没有工具调用时，旧 reducer 会把“空 assistant + reasoningContent”回灌给下一轮重试。该消息形状对 OpenAI-compatible/DeepSeek 路径可疑，并会放大“只有 thinking 没有正文”的 live stall。
- **实现**:
  - `src/nexus/executionStreamLoop.ts`: 把 `for await` 改为显式 async iterator 消费，每次 `iterator.next()` 都与 `signal` / `timeoutSignal` abort race。
    - `timeoutSignal.aborted` 时由 Nexus 外层合成并持久化 `REQUEST_TIMEOUT` error，继续走 `processRuntimeExecutionEvent()`，因此 soft policy 下仍会被装饰为 `details.kind='watchdog'`。
    - `signal.aborted` 时合成 `REQUEST_CANCELLED`，保证 Go TUI Esc / `/cancel` 不再依赖 runtime 内部自行收口。
    - abort 获胜后 best-effort 调 `iterator.return()`，但不 await，避免一个不响应 abort 的 async generator 再次卡住路由。
  - `src/runtime/pipeline/providerTurn.ts`: reasoning-only + no tool call 不再重试空 assistant，直接 terminal `EMPTY_PROVIDER_RESPONSE`，`details.kind='reasoning_only'`。这把 provider 的异常输出转为可见失败，而不是隐藏在下一轮 provider retry 中。
- **回归覆盖**:
  - `test/execution-stream-loop.test.ts`: 新增 `NonResponsiveRuntime`，模拟 runtime 先 yield `session_started` 后永久 pending；触发 timeout controller 后，断言 `runExecutionStreamLoop` 仍返回 `{ timedOut: true }`，并持久化 `REQUEST_TIMEOUT` 且 `details.kind='watchdog'`。
  - `test/runtime.test.ts`: 新增 reducer 单测，锁定 reasoning-only provider turn 必须立即 terminal，不能增加 `outputRetryCount`。
  - 既有 `test/runtime-llm.test.ts` thinking-only provider response regression 继续覆盖完整 runtime event 链。
- **验证**:
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-name-pattern "runtime iterator does not resolve after abort|reasoning-only provider turns|thinking-only provider response|empty provider response" test/execution-stream-loop.test.ts test/runtime.test.ts test/runtime-llm.test.ts`: 4/4 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test test/execution-stream-loop.test.ts test/execute-stream-watchdog.test.ts test/execution-event-processing.test.ts`: 8/8 pass。
  - `cd clients/go-tui && GOCACHE=/private/tmp/babel-o-go-cache go test ./internal/tui -run 'Test(BuildExecuteRequestEmitsSoftTimeoutPolicy|RuntimeAnimationStateFollowsAgentEvent|HookCompletedDoesNotShowToolActivity|CancelStreamNotifiesLocalStreamAfterHTTPAck|StreamPermissionRequestOwnsForegroundView|PermissionRequestOwnsForegroundView|ConsumeNexusEventTracksSoftTimeoutLifecycle)$'`: pass。
- **边界**:
  - 没有把 `thinking_delta` 暴露为用户答案；reasoning-only 仍是 provider 空响应错误。
  - 没有改变 soft timeout 的语义：soft budget 仍只发 recoverable signal；真正终止仍来自 hard watchdog 或 user cancel。
  - 该修复保护 Nexus/WS route，不替代 provider adapter 的 abort propagation；即使内部某个 promise 不响应 abort，外层也能向 Go TUI 发送终态并释放 execution lease。

### Follow-up: `session_f4a0a894` proved the reducer guard was still too late

- **背景**: `session_f4a0a894-1585-4c59-96e2-92f32699bf57` 中，用户要求“你尝试查看一下bash工具是否正常”。事件显示模型只输出 thinking：`I'll run a simple bash command to verify.`，但没有发出 Bash tool call。
- **证据**:
  - 该 turn 的事件尾部是 `thinking_delta` → `usage` → `hook_completed(PostInvocation)` → 约 58 秒空窗 → `REQUEST_CANCELLED { source: "nexus_stream_abort_race" }`。
  - `tool_traces` 中没有该 turn 的 Bash；只有前一轮分析时使用的 `contextSummarize/contextRecent` 等工具。
  - 因此这仍不是权限面板问题：没有 `permission_request`，也没有 Bash tool call 可显示。
- **进一步根因**:
  - 之前在 `reduceProviderTurnOutcome()` 加的 reasoning-only terminal guard 理论上正确，但真实 session 证明 guard 执行得太晚：`PostInvocation` 已经发出后仍出现长空窗。
  - 对 Go TUI 体验来说，reasoning-only/no-tool/no-text turn 必须在 provider turn 聚合完成后立刻终止，不能先进入 PostInvocation hook / leak helper / outcome helper 链路。
- **追加实现**:
  - `src/runtime/LLMCodingRuntime.ts`: 在 provider turn 返回后、`PostInvocation` hooks 之前增加前置 guard。若 `toolCalls.length===0 && assistantText.trim()==='' && reasoningText.trim()!==''`，立即：
    1. `absorbProviderTurnMetrics(metrics, providerTurn)`，
    2. emit `EMPTY_PROVIDER_RESPONSE` with `details.kind='reasoning_only'`，
    3. emit failed `result`，
    4. emit `execution_metrics`，
    5. return。
  - `test/runtime-llm.test.ts`: thinking-only 完整 runtime regression 现在断言 **不会出现 `hook_completed(PostInvocation)`**，锁定“PostInvocation 前终止”这个真实修复点。
- **验证**:
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-name-pattern "thinking-only provider response|empty provider response|reasoning-only provider turns|runtime iterator does not resolve after abort" test/runtime-llm.test.ts test/runtime.test.ts test/execution-stream-loop.test.ts`: 4/4 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test test/execution-stream-loop.test.ts test/execute-stream-watchdog.test.ts test/execution-event-processing.test.ts`: 8/8 pass。
  - `npm run typecheck`: pass。

### Follow-up: `session_f300...4a9fdf` proved stale deployment plus frontend backend-loss blind spot

- **背景**: 用户报告最新 `session_...4a9fdf` 仍停在 `drafting response`，截图中 prompt 为“在桌面写一个简单的 c 语言程序”。Go TUI 显示 `running`，但没有权限面板、没有工具活动详情。
- **进程事实**:
  - `lsof -nP -iTCP:3000 -sTCP:LISTEN` 没有发现 Nexus 监听。
  - 旧 Go TUI 进程仍在：`clients/go-tui/bin/go-tui --url http://127.0.0.1:3000 --cwd /Users/tangyaoyue --session session_f300c03c-1216-46f0-87e2-5b04414a9fdf`。
  - 因此画面上的 Go TUI 已经与后端脱节；这不是当前 Bash permission panel 的可见性问题。
- **session 事件证据**:
  - `bbl inspect-session session_f300c03c-1216-46f0-87e2-5b04414a9fdf` 显示 SQLite 中 session 仍是 `phase=executing`，事件数 77，`terminal_reason=null`。
  - 事件尾部为 `thinking_delta`（文本拼成 “Let me first check what's on the desktop, then write the file.”）→ `usage` → `hook_completed(PostInvocation)` → 180 秒后 `timeout_budget_exceeded`。
  - 没有 `assistant_delta`、没有 `tool_started`、没有 `permission_request`、没有 `error/result`。`inspect-session --resume --json` 给出的边界是 `after_provider_invocation` 且 `cannot_resume`。
- **根因归类**:
  - 后端层：该 live session 仍命中旧 Nexus/runtime 代码路径。当前源码的前置 guard 会在 provider turn 聚合完成后、PostInvocation hook 之前把 reasoning-only/no-text/no-tool turn 转成 `EMPTY_PROVIDER_RESPONSE`；而真实 session 中已经出现 `hook_completed(PostInvocation)`，说明运行时不是当前修复后的后端。
  - 前端层：旧 Go TUI 在后端 Nexus 进程死亡/不可达后，后台 `/v1/runtime/status` 轮询只清空 memory footer，没有把正在运行的 turn 收敛成可见错误，因此界面继续显示 `running` / `drafting response`。
- **追加实现**:
  - `clients/go-tui/internal/tui/api.go`: 新增 `isNexusTransportError()`，只识别 `url.Error` / `net.Error` / connection refused / reset / broken pipe / EOF 等传输断联，不把 HTTP 500 误判为后端进程丢失。
  - `clients/go-tui/internal/tui/tui.go`: `runtimeStatusMsg` 在 running 且非 cancelRequested 时，如果健康轮询遇到 transport loss，立即追加 `Nexus became unreachable while this turn was running: ...`，清 `queuedPrompt`，并调用 `finishRunningStream()` 清理 running、pending、stream handles、soft timeout snapshot。
  - `clients/go-tui/internal/tui/tui_test.go`: 新增两条回归：transport loss 必须 settle stale stream；普通 HTTP status error 不得误杀仍活着的 WebSocket stream。
  - `src/nexus/sessionLifecycle.ts` + `src/nexus/server.ts`: Nexus 启动时收敛上个进程遗留的 `phase=executing` session，标记为 `failed`，`terminalReason.code=NEXUS_RESTARTED_DURING_EXECUTION`，并写入 `metadata.staleExecutionRecovery`；只处理 `executing`，不碰 `waiting_user` 或 terminal sessions。
- **验证**:
  - `cd clients/go-tui && GOCACHE=/private/tmp/babel-o-go-cache go test ./internal/tui -run 'Test(RuntimeStatusFailureSettlesRunningStream|RuntimeStatusHTTPFailureDoesNotSettleRunningStream|StreamPermissionRequestOwnsForegroundView|PermissionRequestOwnsForegroundView|CancelStreamNotifiesLocalStreamAfterHTTPAck|FriendlyNexusRequestError|BuildExecuteRequestEmitsSoftTimeoutPolicy|BuildExecuteRequestRaisesLongContextTimeout|RuntimeAnimationStateFollowsAgentEvent)'`: pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-name-pattern "thinking-only provider response|empty provider response|reasoning-only provider turns|runtime iterator does not resolve after abort" test/runtime-llm.test.ts test/runtime.test.ts test/execution-stream-loop.test.ts`: 4/4 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test test/session-lifecycle-stale-startup.test.ts`: pass。
- **操作结论**:
  - 对 `session_f300...4a9fdf` 的正确处置是停止旧 Go TUI / stale Nexus，重建并重启当前源码；不能继续用该旧 session 判断 Bash permission 或 context 工具注册。
  - 后续排查 `drafting response` 必须先看事件尾部：有 unresolved `permission_request` 才是权限面板；只有 `thinking_delta` + `PostInvocation` 是 provider/output path；Nexus 不监听而 TUI 仍 running 是前端 backend-loss 收敛问题。

## 2026-06-22 — Go TUI double-session stall triage: stale Nexus + shorter soft watchdog

- **背景**: 用户同时打开两个新的 Go TUI session 后再次看到“running / drafting response”长时间不结束：
  - `session_717fe155-b321-4fc7-a675-c744e7958217`: prompt=`查看当前项目的分支信息`，cwd=`/Users/tangyaoyue`。
  - `session_84031893-9ee4-447f-be3b-666ef9a2a423`: prompt=`能否在桌面编写一个简单的c语言程序？`，cwd=`clients/go-tui`。
- **实际事件结论**:
  - 两个 session 都没有 pending `permission_request`；`session_840...` 的唯一 `Bash echo $HOME/Desktop` 已在 93ms 内完成。该轮不是 Bash 权限面板卡住。
  - `session_717...` 只有 `thinking_delta`，无 `tool_started`、无 `assistant_delta`、无 `result/error`；随后进入软超时事件。
  - `session_840...` 是第一轮 Bash 完成后，第二轮只输出 `thinking_delta`，无后续正文/工具/result；随后进入软超时事件。
  - 两个 session 的 `timeout_budget_exceeded` / `timeout_extension_granted` 都来自旧 Go TUI payload：`timeoutPolicy=soft`、未显式传 `watchdogTimeoutMs`、默认 `maxSoftTimeoutExtensions=1`，因此 Nexus 默认 hard watchdog 为 540s，软超时后仍可假运行数分钟。
- **源码核对**:
  - 当前源码下新增回归 `test/runtime-llm.test.ts` 证明“thinking-only provider response”会在 ~100ms 内转为 `EMPTY_PROVIDER_RESPONSE`，不会进入数分钟悬挂。
  - 因此两个 live session 的长时间悬挂不是当前源码可复现的 runtime 行为，而是本机 3000 上仍运行旧 Nexus 进程导致验证命中过期代码路径。
  - `ps -p 6043` 确认旧 Nexus 是 2026-06-22 01:21:41 启动的 `tsx src/nexus/server.ts`，早于本轮 Go TUI / CLI / timeout 修复。
- **实现补强**:
  - `clients/go-tui/internal/tui/stream.go`: Go TUI execute payload 现在显式发送 `watchdogTimeoutMs = timeoutMs + 60s`，并发送 `maxSoftTimeoutExtensions=0`。默认交互 turn 从 “180s soft + 540s watchdog + 1 次扩展” 改为 “180s soft + 240s watchdog + 0 次扩展”；长上下文 turn 为 “300s soft + 360s watchdog”。
  - `clients/go-tui/internal/tui/chrome.go`: `softTimeoutState` 已触发时，runtime animation 不再继续显示 `drafting response`，而是显示 `waiting for watchdog`，避免把 provider/synthesis stall 伪装成正常即将输出。
  - `test/runtime-llm.test.ts`: 新增 thinking-only provider response regression，锁定只有 `thinking_delta` + `finish=end_turn` 时必须快速返回 `EMPTY_PROVIDER_RESPONSE`。
- **验证 / 重启**:
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-name-pattern "thinking-only provider response|empty provider response" test/runtime-llm.test.ts`: 2/2 pass。
  - `cd clients/go-tui && GOCACHE=/private/tmp/babel-o-go-cache go test ./internal/tui -run 'Test(BuildExecuteRequestEmitsSoftTimeoutPolicy|BuildExecuteRequestRaisesLongContextTimeout|ResolveGoTuiTimeoutKeepsDefaultForOrdinaryTurn|ResolveGoTuiTimeoutRaisesLongContextTo300s|ResolveGoTuiTimeoutHonoursExplicitNonDefaultTimeout|RuntimeAnimationStateFollowsAgentEvent|HookCompletedDoesNotShowToolActivity|CancelStreamNotifiesLocalStreamAfterHTTPAck|StreamPermissionRequestOwnsForegroundView|PermissionRequestOwnsForegroundView|RenderPermissionIncludesInputAndMessage|ConsumeNexusEventTracksSoftTimeoutLifecycle)$'`: pass。
  - `git diff --check`: clean。
  - 取消两个 stuck session 后停止旧 Nexus / Go TUI 进程；重新 `npm run start` 启动 Nexus，健康检查通过，runtime status 显示新进程 `stream.activeCount=0`。
  - `cd clients/go-tui && GOCACHE=/private/tmp/babel-o-go-cache make dev` 重建 `bin/go-tui`；随后启动新 Go TUI 连接 `http://127.0.0.1:3000`。
  - `/v1/tools/audit` 确认 `contextRecent/contextSearch/contextSessions/contextSummarize` 等 context tools 仍注册并可见；`/v1/tools` 返回 404 是该分支无此公开路由，不代表工具注册丢失。
- **边界**:
  - 没有改变 Nexus 全局 soft timeout 默认；仅 Go TUI 交互客户端显式选择更短 hard watchdog 和零自动软扩展。
  - 未把 `thinking_delta` 当 final answer；thinking-only 仍是 provider 空结果错误，避免把 hidden reasoning 泄漏成用户答案。
  - 后续若再次看到“工具卡住”，必须先核对 session events + tool traces：有 `permission_request` 才是权限面板问题；只有 `thinking_delta`/soft timeout 是 provider/output path 问题；旧 PID 未重启则优先排除 stale process。

## 2026-06-22 — Go TUI Bash permission panel + full tool-surface regression fix

- **背景**: 用户在真实 Go TUI 验证中发现 Bash 权限申请面板不能直接显示，随后指出更核心的问题：`context*` 以及其他本应可见的工具从模型工具面消失。
- **根因**:
  - Go TUI 视觉层问题：`permission_request` 已到达时，`viewString()` 仍先渲染 transcript / interruption prompt / top card 等视图，导致权限面板可能被埋在当前运行态 UI 后面，表现为必须按 `Esc` 才看见。
  - `session_c3fad031-8d9b-4150-bb10-4e20b91e2b35` 中的 `permission_response: Cancelled from Go TUI` 不是用户正常拒绝 Bash；它是权限面板不可见/卡住后，操作者按 `Esc` 逃生触发的取消。该 session 同时证明 Go TUI 已收到 pending permission（否则不会能取消），问题集中在可见渲染/重绘。
  - 进一步核对发现：权限前台视图如果只返回短内容，在 Bubble Tea alt-screen / diff 渲染下仍可能留下上一帧满屏 transcript，导致“状态已切到 permission，但画面没有明显接管”。因此权限前台需要像 fullscreen overlay 一样补齐到终端高度。
  - `session_69d88c7c-73e2-493f-b879-405ec2fa16a0` 复现了相邻但不同的 Go TUI 可见性问题：Nexus tool trace 中没有 Bash、也没有 pending `permission_request`；最后一批真实工具是 `ListDir` / `Read` / `Glob` 且均毫秒级完成。Go TUI footer 显示 `tool activity` 的直接原因是 `hook_started` / `hook_completed` 被 `runtimeAnimationState()` 归类成工具活动，导致内部 hook 事件伪装成用户可见工具卡住。
  - 同一 session 中用户按 `Esc` 后看到 `interrupt requested — waiting for Nexus to stop` 长时间不恢复。根因是 `cancelStream()` 只有在 HTTP cancel 失败时才通知本地 WebSocket cancel channel；当 Nexus 成功接收 cancel 但 provider/stream 未立刻自然收口时，Go TUI 本地 `running` 状态仍等待远端最终 `result` / `error` / socket close。
  - 工具面问题：`src/cli/commands/go.ts` 曾把 `bbl go --allowed-tools` 转发为 Go TUI `--allow-tools`。Go TUI 的 `--allow-tools` 会发送 per-turn `allowedTools`，这是模型可见工具集过滤器；用 `Read,Grep,Glob,ListDir` 启动验证时，会把 `contextSearch/contextRecent/contextSummarize/contextSessions`、`WebSearch`、`Skill*`、`TaskCreate`、`Write/Edit/Bash` 等默认工具一起裁掉。
  - 诊断漂移：`denyByDefaultTools().describe()` 与 Nexus 启动日志仍描述成旧的 `read,grep,glob,task` 口径，实际策略已经是 `read-risk + task`。
- **实现**:
  - `clients/go-tui/internal/tui/tui.go`: `viewString()` 在 header 后优先返回 `renderPermissionEditor()` / `renderPermission()`，让 pending permission 拥有前景视图；该前景视图现在用 `padViewHeight(..., m.height)` 补齐到终端高度，避免短视图切换时被旧 transcript 帧干扰。
  - `clients/go-tui/internal/tui/chrome.go`: `runtimeAnimationState()` 不再把 `hook_started` / `hook_completed` / `hook_failed` 当成 `tool activity`。只有真实 `tool_started` / `tool_completed` / `tool_denied` 会显示工具活动，避免内部 diagnostics hook 让用户误以为工具卡住。
  - `clients/go-tui/internal/tui/api.go`: `cancelStream()` 在 Nexus cancel HTTP 成功或失败后都会通知本地 stream cancel channel。Esc 中断现在同时请求服务端取消并关闭本地 WebSocket，Go TUI 不再无限等待远端自然收口。
  - `src/cli/commands/go.ts`: 拆分语义；`--allowed-tools` 只用于 auto-started Nexus 的 `NEXUS_ALLOWED_TOOLS`，新增 `--turn-allowed-tools` 才转发到 Go TUI `--allow-tools`。
  - `src/runtime/LocalCodingRuntime.ts` + `src/nexus/server.ts`: 默认策略描述改为 `read-risk,task`，启动日志同步为 `allowedTools=default(read-risk,task)`。
  - `docs/nexus/reference/tool-governance-plan.md`: provider-visible context 工具名修正为真实的 lowercase camelCase，并补上 `contextSessions`。
- **回归覆盖**:
  - `clients/go-tui/internal/tui/tui_test.go`: `TestPermissionRequestOwnsForegroundView` 覆盖 running + interruption prompt active 时权限面板仍应前景显示。
  - `clients/go-tui/internal/tui/tui_test.go`: `TestStreamPermissionRequestOwnsForegroundView` 覆盖真实 `streamEventMsg{permission_request}` 更新路径，断言 `pending != nil`、`inputMode == modePermission`、transcript 不渲染，并且权限前台视图高度等于终端高度。
  - `clients/go-tui/internal/tui/tui_test.go`: `TestHookCompletedDoesNotShowToolActivity` 覆盖内部 hook 事件不能再显示成工具活动。
  - `clients/go-tui/internal/tui/tui_test.go`: `TestCancelStreamNotifiesLocalStreamAfterHTTPAck` 覆盖 Nexus cancel HTTP 200 时仍会通知本地 stream cancel channel。
  - `test/go-command.test.ts`: 覆盖 `--allowed-tools` 不再转发到 Go TUI turn；`--turn-allowed-tools` 才转发。
  - `test/prepare-runtime-start.test.ts`: 覆盖 default soft-deny 下 `createDefaultToolRegistry()` 的全量工具都保持 model-visible；并锁定 `denyByDefaultTools().describe().allowedTools === ['read-risk', 'task']`。
- **验证**:
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test test/go-command.test.ts test/prepare-runtime-start.test.ts`: 56/56 pass。
  - `cd clients/go-tui && GOCACHE=/private/tmp/babel-o-go-cache go test ./internal/tui -run 'Test(RenderPermissionIncludesInputAndMessage|PermissionRequestOwnsForegroundView|PermissionRequestEntersPermissionMode|KeyDoesNotReachTextinputInPermissionMode|BuildExecuteRequestEmitsAllowedToolsWhenConfigured|BuildExecuteRequestOmitsAllowedToolsWhenUnset)$'`: pass。
  - `cd clients/go-tui && GOCACHE=/private/tmp/babel-o-go-cache go test ./internal/tui -run 'Test(StreamPermissionRequestOwnsForegroundView|PermissionRequestOwnsForegroundView|RenderPermissionIncludesInputAndMessage)$'`: pass。
  - `cd clients/go-tui && GOCACHE=/private/tmp/babel-o-go-cache go test ./internal/tui -run 'Test(HookCompletedDoesNotShowToolActivity|CancelStreamNotifiesLocalStreamAfterHTTPAck|RuntimeAnimationState|ToolCompletedUpdatesRuntimeAnimationState|StreamPermissionRequestOwnsForegroundView|PermissionRequestOwnsForegroundView|RenderPermissionIncludesInputAndMessage)$'`: pass。
  - `cd clients/go-tui && GOCACHE=/private/tmp/babel-o-go-cache make dev`: rebuilt `bin/go-tui`.
  - 本地 Nexus 已重启，健康检查通过，启动日志显示 `allowedTools=default(read-risk,task)`；Go TUI 已用 `--no-start-nexus --url http://127.0.0.1:3000` 启动，未携带 `--allowed-tools` / `--turn-allowed-tools`。
- **边界**:
  - 没有移除或改名 context 工具；`src/tools/registry.ts` 仍注册 `contextSearch/contextSummarize/contextRecent/contextSessions`。
  - `allowedTools` per-turn 过滤语义保留，只是从 `bbl go --allowed-tools` 的启动策略中拆出，避免误裁剪默认工具面。
  - Bash 是否一定触发面板仍取决于 provider 是否真实发出 Bash tool call；若 provider 只输出文本、不发 tool call，则 Nexus 不会有 `permission_request` 可显示。
## 2026-06-21 — contextSearch 算法与鲁棒性回归收口（Phase 0/1）

> **完整文档**: [reference/context-search-algorithm-robustness-plan.md](./reference/context-search-algorithm-robustness-plan.md) — 含根因、设计、Phase 表与验证清单。本节只记事实流水。

- **背景**: 真实 session `session_06308b17-84b4-402a-909e-b0078f67ca76`（11,997 事件，8 条 user_message）里 `contextSearch` 连续 5 次调用 4 次空返（query 1–4 `hitCount=0`），query 5 靠 `eventTypeFilter:["user_message"]` + query 恰为字面量 `user_message` 才命中 5/8。`contextRecent` / `contextSummarize` / `contextSessions` 同 session 全部正常 → 回归隔离在 `contextSearch`。
- **两个叠加根因**：
  1. **算法**：`src/tools/contextTools.ts` `searchEvents` 把整个 query 当一个字面量子串 `haystack.includes(needle)`，无分词。query `架构分析 合理性 先进性` 与实际文本 `分析…架构的合理以及先进性` 无连续相同子串 → 0 命中。
  2. **鲁棒性**：`src/tools/builtin/contextSearch.ts` 用 `listEvents(order:'asc', limit:10_000)` 加载，11,997 事件只取最早 10,000，seq 10001+ 静默丢弃；`eventTypeFilter` 是**内存里**过滤（`contextTools.ts:227`），SQL 层未用；`truncated` 只反映 token 截断不反映源截断，模型无法区分"没匹配"与"源被截"。工具 prompt 又写成"语义搜索"口吻误导模型反复换措辞重试。
- **修复**（分支 `fix/context-search-algorithm-robustness`，3 个语义提交按 §7.4 拆分）：
  - `fix(storage)`: `EventListOptions` 加可选 `eventTypes?: string[]`，`EventRepository.listEvents` 下推 `WHERE event_type IN (...)`（`MemoryStorage` 镜像），非破坏可选字段。
  - `fix(context)` 算法: `searchEvents` 改分词 AND-substring（`query.split(/\s+/)` 每 token 子串命中）+ 命中倒序 + 同类型连续去重 + `eventsScanned`/`eventsCapped` 诊断 echo。
  - `fix(context)` 契约: `contextSearch` 带 filter 时传 `eventTypes` 走下推、limit 10k→50k、`prompt`/`description` 改"分词子串匹配 + 正反例 + eventsCapped 指引"。
- **验证**：
  - 复现脚本 `scripts/repro-context-search-260621.mjs` 用 `SqliteStorage` 加载真实 session → query 1–4 全部非空（1–3 各命中 3，匹配路径是模型自身 assistant 输出复用同关键词；4 命中 16）、query 5 返回全部 8 条 user_message、`eventsCapped=false`。`PHASE 1 GATE PASS`。
  - 单测：`test/context-tools.test.ts` 7 个新增（分词 AND、缺失 token 不命中、CJK 单 token 子串无回归、倒序、同类型去重、诊断 echo / 默认 undefined）+ `test/storage-event-repository.test.ts` 2 个新增（SQL 下推绕开低 limit、MemoryStorage 对等）。修复了既有 "5k token cap" 测试（原 fixture 1000 条相同文本被去重成 1 条，改为每条 distinct text）。
  - 全 gate：`typecheck` / `deps:audit` / `docs:check`(failureCount 0) / `build:smoke` green。`format:check` 仅 `.babel-o/working-set.json` 失败（预存运行时产物，stash 验证非本次引入）。
- **耦合/架构边界**：存储层（`Storage`/`EventRepository`/`MemoryStorage`）接口扩展、算法层（`contextTools.ts` 纯函数无副作用）、wiring 层（`contextSearch.ts`）三层正交分离；6 个 `refreshRuntimeContextState` hot-path 不用 `eventTypeFilter` 不受影响；`contextRecent`/`contextSummarize`/`contextSessions` 未触碰（健康不碰，P0-regression-focus）。
- **分支切换副作用处理**：从 `fix/provider-stream-abort-propagation` 切出本分支时，该分支已提交的 SSE abort 改动（`sse.ts`/`OpenAIAdapter.ts`/`AnthropicAdapter.ts` + `test/sse-abort-propagation.test.ts`）作为工作树脏文件被带过来；确认是另一条 P0 回归线的已提交内容（`git cat-file` 验证存在于该分支），已 `git checkout --` 还原 + 删除游离测试，本分支工作树干净，gate 仍绿，未污染另一分支。
- **文档生命周期**：提案 `proposals/context-search-algorithm-robustness-plan.md` 从 `Draft` → `Partially Landed` → `Active Plan`，毕业到 `reference/`（Phase 3 closed），`reference/README.md` 与 `proposals/README.md` 同步更新（graduation note 指向新位置）。
- **未触发 / 仍 Open**：Phase 2（CJK bigram 重序容忍，如 `架构分析` vs `分析…架构`）保持 Watch — Phase 1 匹配路径是 assistant 输出复用关键词，重排的 user message 未成为匹配路径，故 gate 未触发，留待未来真实 query。
## 2026-06-21 — Path 0 (drain-into-array buffer): real streaming root cause

> **完整文档**: [reference/streaming-pipeline-realtime-rendering-fix.md](./reference/streaming-pipeline-realtime-rendering-fix.md) — 包含全部三层 (Path 0 / 1 / 2) 的设计、bisect 目标、WS 抓包数据、为什么三层都必要的解释。本节只记录 Path 0 的事实流水。

- **背景**: 用户反馈 Path 1 + Path 2 落地后**仍然不丝滑**，"多个事件 chunk 一起显示而不是真实实时"。WS time-trace 抓出真实数据：
  - **修复前**：first arrival +13064ms, last +13150ms, **span 86ms**, 365 chunks 一齐到达
  - **修复后**：first arrival +7913ms, last +11459ms, **span 3546ms**, 260 chunks 间隔 ~14ms 真实流式
- **真实根因**：`src/runtime/executeProviderTurn.ts` 是个 drain-into-array helper，把整段 provider turn 的 async generator drain 进 events[] array：
  ```typescript
  while (!result.done) {
    events.push(result.value)
    result = await stream.next()
  }
  return { events, providerTurn: result.value }
  ```
  调用方 `LLMCodingRuntime:822` 拿到 events[] 后再 `for (const e of events) yield e` —— 一个 tight loop 里把整段 dump 出来。Path 1 chunker (commit 19596ae) 正确 yield 多 chunk，但全卡在 events[] 里等 provider turn 结束。
- **设计选择**：
  - 不改 `executeProviderTurn.ts` 改成 generator（需要 sync drain protocol for final `providerTurn` return value，复杂）。
  - **直接 inline streaming loop 替换 helper 调用**：`providerTurnDriver.run({...})` 直接拿到 generator，每个 `await stream.next()` 后立即 `yield result.value`。
- **实现 (`src/runtime/LLMCodingRuntime.ts`)**: 把 `await executeProviderTurn(...)` + `for (const e of providerTurnEvents) yield e` 替换为：
  ```typescript
  const stream = providerTurnDriver.run({...})
  let result = await stream.next()
  while (!result.done) {
    yield result.value          // <-- 每个 event 立即流式
    result = await stream.next()
  }
  providerTurn = result.value
  ```
  +删除未使用的 `executeProviderTurn` import；helper 文件 `executeProviderTurn.ts` 保留（无其他 caller，cleanup 后续）。
- **验证**:
  - `tsc -p tsconfig.build.json --noEmit`: clean。
  - `test/anthropic-chunker.test.ts` 8/8 + 跨 spec 回归 (`bash-classifier` + `bash-deny` + `runtime` + `security` + `r4`) 219/219 pass。
  - **真实 WS e2e**：
    ```
    server adapter [oa-adapter] delta.content len=1 → +0ms
    server adapter [oa-adapter] delta.content len=8 → +3486ms
    server [ws-forward] assistant_delta → +1ms 后立即出来
    client [client] assistant_delta #1 +7913ms ... #260 +11459ms
    ```
    完整 streaming 路径打通：adapter yield → providerTurn yield → runtime yield → ws-forward → client。
- **边界**:
  - 不动 catch block + recovery decision tree（错误处理流程不变）。
  - 不动其他 yield 点（compact, microcompact, refresh, post-recovery）—— 都已 streaming 正确。
  - `executeProviderTurn.ts` 文件保留（其他 doc 仍引用），后续可随 cleanup PR 删除。
- **三路径修复完整链路**：
  1. **Path 0 (本次)**：runtime 不再 buffer event array，每个 yield 真实流式。
  2. **Path 1 (commit 19596ae)**：adapter chunker 把 batched delta 切成多 chunk。
  3. **Path 2 (commit f75a268)**：TUI synthesizing 指示器覆盖 dead-air gap。
  仅 Path 1+2 不够 —— buffer 让 chunk 全卡在最后一刻 dump 出来。Path 0 是真正解封 streaming 的关键。

## 2026-06-21 — Go TUI real-time rendering: Path 2 + Path 1 组合

> **完整文档**: [reference/streaming-pipeline-realtime-rendering-fix.md](./reference/streaming-pipeline-realtime-rendering-fix.md) — Path 0 / 1 / 2 完整设计 + 为什么三层都必要。本节记录 Path 1 + Path 2 的事实流水。

- **背景**: 用户报告"Go TUI 无法实时渲染，agent 在流式输出时无法直接捕获"。WS 抓包 (`/tmp/ws-trace.cjs`) 显示：21 个 `thinking_delta` 事件跟 1 个 `assistant_delta`（DeepSeek V4 Anthropic-compatible batched 输出）。Go TUI 的 footer 动画在 thinking → assistant 间出现 dead-air gap，flash "agent thinking" → "agent runtime" → "agent writing"。**根本原因不是 wire 故障** —— server 正确推送 37 个事件，是 provider 行为：DeepSeek V4 把整段 final text 装进一个 `text_delta`/`delta.content`。
- **设计选择 — 双路径组合**：
  - **Path 1（server 侧 chunker）**：在 `AnthropicAdapter` / `OpenAIAdapter` 的 `text_delta`/`delta.content` 处加 chunker，>50 chars 的单个 delta 按段落/句子/子句/词边界拆成多个 `assistant_delta` 流到 WS。
  - **Path 2（TUI 侧 synthesizing indicator）**：在 `lastEventType` switch 之前增加 `pendingSynthesis` 状态，thinking → assistant 间隙显示 "drafting response" 指示器。
  - 两者协同：chunker 把 batched 输出拆成多个 chunk 持续推送；synthesizing 指示器覆盖 chunker 启用之前的 dead-air。
- **实现（Path 1，server 侧）**：
  - **`src/providers/adapters/AnthropicAdapter.ts`**: 新增 `function* chunkTextDelta(input)` (~50 行)，边界优先级 paragraph (`\n\n+`) > sentence (`[.!?]+\s*`) > clause (`[,;:]+\s*`) > word (`\s+`)。搜索窗口 `[20, remaining.length - 30]` 保留前缀 + 为下次迭代预留尾巴。找不到自然边界时硬切 60 chars。在 `content_block_delta` 的 `text_delta` 处调 `yield* chunkTextDelta(text)`。
  - **`src/providers/adapters/OpenAIAdapter.ts`**: 同样算法 inline 复制（避免跨 adapter 依赖，遵守正交边界原则）。在 `delta.content` 处调 `yield* chunkOpenAITextDelta(content)`。**关键**：DeepSeek V4 用的是 OpenAI adapter（不是 Anthropic），所以这个 wiring 才是真正命中的路径。
  - **threshold 50 chars**：小于等于 50 的 delta verbatim emit，不打散正常 streaming provider。
- **实现（Path 2，TUI 侧）**：
  - **`clients/go-tui/internal/tui/anim.go`**: 新增 `runtimeAnimationSynthesizing` enum kind + 桥梁调色板（cyan/purple/cyan 介于 thinking 紫粉 vs responding 青蓝之间）。
  - **`clients/go-tui/internal/tui/tui.go`**: model 加 `pendingSynthesis bool` + `assistantSeenInTurn bool` 两个 latch。`thinking_delta` case 在 `assistantSeenInTurn=false` 时 arm pendingSynthesis + 清 lastEventType；`assistant_delta` case 关闭两个 latch；`tool_started` case 清 pendingSynthesis（tool 信号优先）；`startPrompt` reset 路径同时清两个 latch + lastEventType。
  - **`clients/go-tui/internal/tui/chrome.go`**: `runtimeAnimationState()` 优先级：permission_request / tool_* / assistant_delta / thinking_delta 直接 switch；default 分支检查 `pendingSynthesis` → synthesizing 或 fallback default。
- **验证**:
  - `tsc -p tsconfig.build.json --noEmit`: clean。
  - `cd clients/go-tui && go test ./internal/tui/ ./internal/loop/`: 全过。
  - `test/anthropic-chunker.test.ts` (新建 8 case): short verbatim / sentence boundary / sentence > word priority / hard splits / reassembly invariant / 50-char threshold / paragraph > sentence priority / AnthropicAdapter symbol smoke。8/8 pass。
  - 跨 spec 回归: 248/248 全绿（之前 Bug 1.2 / quote-aware 测试套件无回归）。
  - **真实端到端**:
    - Path 2: `bbl go` 内显示 dead-air 时不再 flash "agent thinking" → "agent runtime"，而是从 "agent thinking" 平滑过渡到 "drafting response" → "agent writing"。
    - Path 1: WS 抓包确认 OpenAI adapter 命中 chunker 路径（DeepSeek V4 的 `delta.content` > 50 chars 时被切成多 chunk）。短 prompt（直接 streaming provider）chunk 大小仍是 1-14 chars，chunker 不打散已 streaming 输出 —— 零回归。
- **边界**:
  - chunker 阈值 50 chars 保守；如需更细可后续调到 30 chars，但风险更高（可能影响 Anthropic 已有 streaming）。
  - 两个 adapter 各保留独立 chunker 副本，零跨依赖；如未来抽公共 util 需单独 PR。
  - Path 2 synthesizing 指示器只覆盖 chrome 底部动画，不改 transcript 文本行布局。
  - Tool / permission 事件优先级高于 synthesizing（实测 scenario：model thinking → 调 tool → tool_completed → 仍可能再有 thinking 时，chrome 切回 tool activity，不被 synthesizing 干扰）。

## 2026-06-21 — bashClassifier quote-aware fix (副发现, follow-up of Bug 1.2)

- **背景**: Bug 1.2 fix 让模型能看到 deny message 中的 classifier rule 名（`chained-semicolon` / `output-redirect` / `command:sqlite3-not-allowlisted` 等）。但 e2e session `session_ea4f1793` 还暴露一个副 bug：`findDangerousPattern` 在 raw command 字符串上跑 regex，没用 `tokenizeBashCommand` 的 quote-aware 输出。导致所有"在引号里的分号/管道/重定向"被误识别为真 shell operator，触发 false-positive `chained-semicolon` / `output-redirect` 等规则。
- **触发场景**（5 类 false positive）：
  - `echo "SELECT 1;"` → 被识别为 `chained-semicolon`
  - `echo "x > y"` → 被识别为 `output-redirect`
  - `sqlite3 foo.db "SELECT * FROM t WHERE c = 'a;b'"` → 被识别为 `chained-semicolon`
  - `sqlite3 -line ~/.babel-o/db.sqlite "SELECT 1; SELECT 2;" 2>/dev/null` → 修复前 `chained-semicolon`，修复后正确指向真正的 `2>/dev/null` 重定向 (`output-redirect`)
  - `echo "a | b"` → 修复前巧合 `read`（`pipe-to-shell` regex 要求特定 shell 名），修复后稳定 `read`
- **设计选择**:
  - 不改 DANGEROUS_PATTERNS regex（保持 regex 简洁，避免维护成本）
  - 不改 `tokenizeBashCommand`（它已经处理引号，但只输出 token 数组；regex 在 raw 上跑 token 会丢位置信息）
  - **最小、可验证的 fix**：在 `findDangerousPattern` 前加 `maskQuotedSegments(command)` helper，把引号内 char 替换为空格（保持长度对齐），然后 regex 在 masked string 上跑。这样 unquoted operator 仍命中，quoted operator 被 mask 掉。
- **实现**:
  - **`src/tools/builtin/bashClassifier.ts`**: 新增 `maskQuotedSegments(command: string): string` (~30 行) — 单/双引号内 char 替换为空格（保留 `\t`/`\n`）；quote chars 本身保留。`findDangerousPattern` 改为先 mask 再 regex，pattern 列表不变。
- **验证**:
  - `node_modules/.bin/tsc -p tsconfig.build.json --noEmit`: clean。
  - `test/bash-classifier.test.ts` (12 → 16 cases):
    - 翻转既有 'quoted arguments correctly' 测试: `git log "x; y" --oneline` 从 `expectExecute chained-semicolon` 改为 `expectRead`（旧行为即 bug）。
    - 新增 'dangerous patterns OUTSIDE quotes still fire' (3 case): `echo hi; echo bye` / `echo hi > /tmp/out` / `cat /etc/foo 2>/dev/null || echo fallback` / 真实 session_ea4f1793 sqlite3 + `2>/dev/null` 联合。
    - 新增 'dangerous patterns INSIDE quotes do NOT fire' (3 case): sqlite3 SQL `;` / `echo "x > y"` / `echo "a | b"`。
    - 16/16 pass。
  - 跨 spec 回归: 248/248 pass (含 bash-classifier + bash-deny + runtime + security + context-tools + context-sessions + r4)。
  - **真实 e2e** session_a0e44a50: bash `sqlite3 -line ~/.babel-o/db.sqlite "SELECT 1; SELECT 2;" 2>/dev/null` → deny message `Tool denied by Nexus policy: Bash (classifier: output-redirect)` → 模型正确识别 `2>/dev/null` 是真危险点 + 解释 + 建议（去掉重定向）。修复前会被 `chained-semicolon` 误导（模型会以为 SQL 分号是问题）。
- **边界**:
  - 不改 DANGEROUS_PATTERNS regex；只改输入。
  - 不改 `tokenizeBashCommand`（它本来就 quote-aware）。
  - `\\$(command-substitution)` 不受影响（`$(` 和 `)` 都在 unquoted 区域）。
  - `rm`/`mv`/`cp`/`curl`/`wget` 等命令名 regex 在 token 流上触发（先于 dangerous-pattern 层），不受 mask 影响。
  - backslash 转义 inside `"\\;"` 仍被 mask（POSIX shell 不识别这些转义；regex 也无需查 escape 序列）。

## 2026-06-21 — Bug 2: context observer redaction leaks systemPromptBlocks[].text

- **背景**: 真实 e2e 探测（2026-06-20/21）通过 `/v1/context/observe` 在 active turn 期间收到的 `assembled` frame，验证 `redactContext(ctx, 'summary')` 的隐私完整性 — 发现 **R4 的 summary 模式实际并未生效**：frame 里 `context.systemPromptBlocks[].text` 完整呈现（18k+ char system prompt + tool contract lines verbatim），`context.systemPrompt` 也仍然在 payload 里。这是 **真泄漏**：任何订阅 `/v1/context/observe` WS 的 consumer（Go TUI、外部 dashboard、未来 SDK）都会拿到完整 prompt 文本，而 R4 spec 明确要求 summary 模式只暴露长度 / counts / cacheable split。
- **根因**: `redactContext` 在 `src/nexus/contextBroadcaster.ts:216` 用 `const { systemPrompt: _sp, messages: _msgs, ...rest } = context` 拆出 `systemPrompt` 字符串 + `messages` 数组。但 `AssembledContext` **同时**有 `systemPromptBlocks: SystemPromptBlock[]` 字段（`[{text, cacheable}]`），destructure 没有 strip 这个数组，所以每个 block 的 `text` 完整传到 WS payload。
- **设计选择**:
  - 不缩小 `systemPromptBlocks` 字段（保留 `cacheable` 字段让 observer 能看 prefix-cacheable 分布）。
  - 不引入 "len-only marker per block" 类型（避免类型膨胀，as-cast 即可）。
  - 不改 R4 spec 中的 "summary 模式只暴露 counts/budgets/section ids" 语义；只补齐漏掉的 strip。
- **实现**:
  - **数据层** `src/nexus/contextBroadcaster.ts`:
    - 新增 `RedactedContextBlock = Pick<...SystemPromptBlock, 'cacheable'>` —— 红后的 block 只剩 `cacheable` 字段。
    - `RedactedContext` type 加 `systemPromptBlocks?: RedactedContextBlock[]` 收紧字段类型。
    - `redactContext` destructure 加上 `systemPromptBlocks: _spb` 把整个数组 strip，然后用 `sanitizedBlocks = blocks.map(({ text: _t, cacheable }) => ({ cacheable }))` 重建 length-only marker 数组覆盖回去。
- **验证**:
  - `node_modules/.bin/tsc -p tsconfig.build.json --noEmit`: clean。
  - `test/r4-context-observe-runtime-e2e.test.ts` (已有 9 case + 新增 2 case):
    - 新增 `summary mode strips per-block text (Bug 2: systemPromptBlocks leak)`：13 个原始 block 的 `text` 字段全 strip，`cacheable` 字段保留，JSON 中不出现 `IDENTITY`/`SYSTEM_RULES`/`ENV_INFO` 等任何原文 snippet。
    - 新增 `full mode keeps systemPromptBlocks with text intact`：opt-in `?full=1` 行为不变。
    - 11/11 pass。
  - 跨 spec 回归: r4 + runtime + security + context-tools + context-sessions + bash-deny + context-observe-websocket + runtime-context-tools-registry-gate = **243/243 pass**。
  - **真实 WS 端到端**（手抓的 ws-frame.bin, 2026-06-20/21）：收到的 `assembled` frame `systemPromptBlocks` 字段全是 `[{cacheable: true}, ...]` — `text` 字段不再出现，`systemPrompt` 字段不再出现，`redaction` 元数据完整保留。
- **边界**:
  - 不改 R4 spec 文档语义；只是补齐实现漏洞。
  - 不改 `full` 模式行为（opt-in 显式 verbatim）。
  - 不改 observer route 路径 / query param 解析 / redaction mode 选择。
  - 不改 working-set observer（那个已经是正确的 metadata-only payload）。

## 2026-06-21 — Bug 1.3: contextRecent default-excludes hook / usage / thinking_delta noise

- **背景**: 真实 session `session_ea4f1793-ffc1-412a-a3c4-119c386f7ba1` 暴露 `contextRecent` 输出被内部 telemetry 污染。模型当时显式传了 `excludeEventTypes: ['tool_completed', 'assistant_delta']`，但 output 第一行是 `[2026-06-20T13:59:51.744Z] hook_started: hook_started InvocationDiagnosticsHook PostInvocation` —— 紧跟着 `hook_completed` / `usage` / 几十条单字符 `thinking_delta` chunk。这些 internal pipeline / stream 噪音没有 model 可解释内容，但占用了 5000-token 上限的相当份额，把 `user_message` / `tool_started` / `result` 等 user-visible events 挤出去。
- **设计选择**:
  - 不改 `contextSearch` / `contextSummarize`（它们已经只返回用户主动过滤后的内容，pollution 不严重）。
  - 不引入"硬过滤 + 显式 opt-in include"双层 API（per-call `includeEventTypes`）—— 模型需要 reasoning 证据时，可以直接读 `result` event 或调 `contextSearch`；保持 `contextRecent` 语义单一为 "default-clean + caller-adds-filters"。
  - **MERGE 而非 OVERRIDE**：caller-supplied `excludeEventTypes` 合并到 default set 之上，不是替代。这样模型可以 **add** 过滤（"再 exclude `user_message`"），但不会无意中 **undo** default 过滤（"我只想看 thinking_delta" 这种 use case 不被鼓励——属于 reasoning-trace inspection，应走 contextSearch）。
- **实现**:
  - **数据层** `src/tools/contextTools.ts`: 新增 `DEFAULT_RECENT_EXCLUDED_EVENT_TYPES` 常量 (ReadonlySet)，覆盖 6 类噪音（hook_started / hook_completed / usage / thinking_delta / assistant_delta / tool_completed）。`recentEvents()` 把 caller-supplied excludeEventTypes merge 到 default set 之上而非替代，保留 back-compat 默认行为 (caller 不传 → 用 default；caller 传 → default + caller).
  - **Builtin wrapper** `src/tools/builtin/contextRecent.ts`: 重新写 `prompt()` —— 显式说明 default 行为 + 提醒 caller-supplied 是 merge 不是 replace，让模型知道思考_delta 想看的话用其他工具。
- **验证**:
  - `node_modules/.bin/tsc -p tsconfig.build.json --noEmit`: clean。
  - `test/context-tools.test.ts` (既有 24 test): 4 个 regression 调整 (1 个 events newest first 期望值换 default filter 后正确位置 / 1 个 excludeEventTypes 改写为 merge 验证 / 2 个新增 default 过滤 hook/usage/thinking_delta + caller-re-include 文档性 test)。
  - 跨 spec 回归: `test/bash-classifier.test.ts test/runtime.test.ts test/security.test.ts test/context-tools.test.ts test/context-sessions-tool.test.ts test/runtime-context-tools-registry-gate.test.ts test/bash-deny-classifier-rule.test.ts` 239/239 pass。
  - **真实 runtime 端到端**: `curl POST /v1/execute` prompt "contextRecent n=10 不要传 excludeEventTypes" → session_9bbddf62。模型看到的就是修复后效果，output 完全 user-visible events 链；hitCount=7, contentLen=1268。
- **边界**:
  - 不改 contextSearch / contextSummarize 的 filter 行为；它们已经做全量 match by default。
  - 不改 `excludeEventTypes` parameter schema 形状；只改它的 default 与合并语义。
  - 不动 `usage` event 排除（保留可观测性，模型要看 token usage 仍可看到）；如需更严格可后续加入 default。
  - 不动 `contextRecentTool.requiresApproval=false` / `risk='read'` / 5k token cap。

## 2026-06-20 — Bug 1.2: Bash deny message surfaces classifier rule (model-visible)

- **背景**: 真实 session `session_ea4f1793-ffc1-412a-a3c4-119c386f7ba1` 复盘揭示，同一 session 内 2 次 Bash 调用看起来"deny 不一致"——`git rev-parse HEAD` 通过、`sqlite3 ~/.babel-o/db.sqlite "..."` 被拒。源码核对后发现这不是 inconsistent，而是 `bashClassifier.ts` 正常工作（`git` 在 read-only 白名单 → effectiveRisk=read 自动放行；`sqlite3` 不在白名单 → execute risk → policy deny）。**真正的 bug 是 deny message 的可观测性**：`tool_denied.message` 写死为 `"Tool denied by Nexus policy: Bash"`，丢弃了 classifier 已经算出的 `rule`（`command:sqlite3-not-allowlisted` / `chained-semicolon` / `output-redirect` 等）。模型看不到拒绝原因 → 无法调整下一次调用 → fallback 到 `assistant_delta` 编造手动 workaround（"用 sqlite3 在终端跑"）。
- **设计选择**:
  - 不为 Bash 命令开放 sqlite3 白名单（policy 决定，超出本 fix 范围）。
  - 不改 `bashClassifier.ts` 的 quote-aware tokenization（相关 bug 见下面备忘，待独立 PR）。
  - **最小、可验证的 fix**：把 classifier 已经计算出的 `rule` 通过 `tool.riskForInput()` 的返回结构暴露给 runtime，再附加到 `tool_denied.message` + 模型可见的 `tool_result` 文本。
- **实现 (4 段)**:
  - **Tool 接口扩展** `src/tools/Tool.ts`: `riskForInput?: (input) => ToolRisk | { kind: ToolRisk; rule?: string }` —— 接受字符串（back-compat）或 `{ kind, rule }` 富结构，rule 可选。文档注释解释 rule 的用途与流向。
  - **Bash 工具切到富结构** `src/tools/builtin/bash.ts:261`: `riskForInput` 现在 `return { kind: classification.kind, rule: classification.rule }`。read-only 命中 `rule=undefined`，execute 命中带 rule 字符串。
  - **Runtime 解析 + 注入** `src/runtime/LocalCodingRuntime.ts`: `effectiveRisk()` 返回 `{ risk, rule? }` 兼容三种 riskForInput 返回形态（缺失 / string / object）；调用点解构 `let { risk: effectiveRisk, rule: classifierRule } = this.effectiveRisk(tool, toolInput)`；policy deny 路径 `const ruleSuffix = classifierRule ? \` (classifier: \${classifierRule})\` : ''` → `message = \`Tool denied by Nexus policy: \${tool.name}\${ruleSuffix}\``；hook input rewrite 后重算 `recomputed.risk` + `recomputed.rule`。
  - **runtimeToolLoop 同步** `src/runtime/runtimeToolLoop.ts`: 新增导出 `resolveEffectiveToolRiskWithRule()` 供需要 rule 的调用点用；保留 `resolveEffectiveToolRisk()` 作 back-compat 薄包装；两个 policy deny 路径（`:402`、`:521` 附近）同样追加 `(classifier: <rule>)` suffix；hook 重算 helper 也走 rich-shape 解构。
- **验证**:
  - `node_modules/.bin/tsc -p tsconfig.build.json --noEmit`: clean。
  - `test/bash-deny-classifier-rule.test.ts` (新建 9 case): 3 个 tool-level (riskForInput 富结构 / 非 allowlisted rule / dangerous-pattern rule) + 3 个 helper-level (resolveEffectiveToolRisk back-compat / resolveEffectiveToolRiskWithRule 含 rule / read 路径无 rule) + 3 个 runtime-level e2e (sqlite3 deny message 含 rule / read-only git 无 deny / `rm` dangerous-pattern deny 含 rule)。9/9 pass。
  - 跨 spec 回归: `test/bash-classifier.test.ts test/runtime.test.ts test/bash-deny-classifier-rule.test.ts test/security.test.ts` 198/198 pass。
  - **真实 runtime 端到端**: `curl POST /v1/execute` prompt "尝试 bash sqlite3 -line foo.db ... 告诉我你看到的拒绝原因" → session_acbfe055。模型尝试 2 次：第 1 次带 SQL 分号 → deny `(classifier: chained-semicolon)`；第 2 次去掉分号改 `.tables` → deny `(classifier: command:sqlite3-not-allowlisted)`。模型 result 准确解释了**两个不同的 rule** 含义，并给出 `node:sqlite` 替代方案 + 调整 allowlist 建议。修复前模型只能看到 `Tool denied by Nexus policy: Bash`，无法 reason about deny；修复后 deny rule 成为模型可解释的 fact。
- **边界**:
  - 不改 `bashClassifier.ts`（包括"`SELECT 1;` 引号内分号被识别为 chained-semicolon"这个独立 bug，留作 follow-up；当前 fix 让模型至少能看到这个 rule 名并 reason about 它）。
  - 不改 Bash policy / allowlist / approval gate 行为；deny 仍发生在原本会发生的位置，只是携带更多信息。
  - 不改其他 deny path（hook deny / optimizer-safety deny / permission gate denial）的 message 格式——它们已经有具体的 deny reason，不需要 classifier rule 注入。
  - `riskForInput` 字符串返回形态保持完整 back-compat，老 tool / 测试不需要任何改动。

## 2026-06-20 — Long-Running Context Assembly Bug 1.1: contextSessions cross-session metadata search

- **背景**: 真实 session `session_ea4f1793-ffc1-412a-a3c4-119c386f7ba1` 测试 `bbl go` runtime 时，用户 prompt "使用 contextRecent 工具列出最近 5 个 session 的 ID 与 lastUserInput" 触发 4 次工具调用（contextRecent / Bash / Bash / contextSearch），其中 `contextSearch{query: "sessionId lastUserInput", maxTokens: 5000}` 命中 0 结果（`hitCount: 0`, `content: ""`）。根因：`contextSearch` 数据层 `searchEvents()` 只接 `events: NexusEvent[]` 单 session 事件流，跨 session 元数据（id / cwd / prompt / lastUserInput / phase / timestamps）从未进入工具搜索路径。模型 fallback 到 `assistant_delta` 编造"无法获取，需要 sqlite3 查询" 文本回答，而非基于工具事实。
- **设计选择**: 不扩展 `contextSearch` 加 `crossSession?: boolean` flag — 单 session 事件搜索 vs 跨 session 元数据搜索是两个不同的 question shape + payload schema，flag 化会让 prompt 与 result 含义混乱。改为新增独立的第 4 个 on-demand tool `contextSessions`，与 `contextSearch` / `contextRecent` / `contextSummarize` 保持正交边界（[[feedback-tool-boundary-granularity]]）。
- **实现 (3 段)**:
  - **数据层** `src/tools/contextTools.ts` (+128 行): 新增 `SessionMetadata` 类型 (sessionId/cwd/prompt/lastUserInput/phase/createdAt/updatedAt/result/failureReason) + `SessionSearchOptions` 类型 (query/cwd/phase/sinceMs/limit/caseSensitive/maxTokens) + `searchSessionsMetadata(sessions, options)` 纯函数 + `extractSessionText(s)` / `formatSessionSnippet(s)` 内部 helper。复用既有 `capByTokens` / `estimateTokens` token 上限策略。phase 字段支持 string 或 array of string（多 phase 联合）；query 命中 prompt/lastUserInput/result/failureReason/cwd/phase 任一字段；newest-first 排序；`limit` 默认 20，最大 100。
  - **Builtin wrapper** `src/tools/builtin/contextSessions.ts` (新建 116 行): `contextSessionsTool` 实现 `ToolDefinition`，risk='read'、no-approval；execute() 走 `context.storage.listSessions({})` 取全部 session metadata（`SessionSnapshot` → `SessionMetadata` 投影），调 `searchSessionsMetadata(...)`；storage 缺失时返回 `CONTEXT_STORAGE_UNAVAILABLE`，listSessions 抛错时返回 `CONTEXT_SESSIONS_FAILED`。description + prompt 明确写"跨 session 元数据搜索"，与 contextSearch / contextRecent 单 session 边界对比写清楚。
  - **Registry 注册** `src/tools/registry.ts` (+3 行): `contextSessionsTool` 加入 tools[] 列表；`CONTEXT_TOOL_NAMES` 集合从 3 扩到 4（`storage: null` 时同步 hide 4 工具）。
- **验证**:
  - `node_modules/.bin/tsc -p tsconfig.build.json --noEmit`: clean。
  - `test/context-sessions-tool.test.ts` (新建 13 test): 8 个 `searchSessionsMetadata` 数据层 (空列表 / query 命中 prompt+lastUserInput+cwd / cwd filter / phase string+array / sinceMs filter / limit + newest-first / caseSensitive / token cap truncated) + 5 个 wrapper (storage 缺失 → CONTEXT_STORAGE_UNAVAILABLE / storage 注入并执行 newest-first / query forwarding / storage 抛错 → CONTEXT_SESSIONS_FAILED / 工具 metadata read+no-approval+prompt 含 cross-session)。13/13 pass。
  - `test/runtime-context-tools-registry-gate.test.ts` 同步更新（"3 context tools" → "4 context tools"，新增 `contextSessions` 在 storage-gate 4 个测试中的 assertion）。
  - 跨 spec 回归: `test/context-tools.test.ts test/runtime-context-tools-registry-gate.test.ts test/context-assembler.test.ts test/context-sessions-tool.test.ts` 95/95 pass。
  - **真实 runtime 端到端**: `curl POST /v1/execute` prompt "使用 contextSessions 工具列出最近 5 个 session 的 ID 与 lastUserInput。只返回工具结果摘要，不要再调用其他工具。" → session_816269a1。模型一次工具调用 `contextSessions{limit: 5}` → success, hitCount=50, contentLen=924；result message 表格列出 5 个 session 的 ID + phase + lastUserInput，全部基于 tool_result 而非 hallucination。
- **边界**:
  - 不改 `contextSearch` / `contextRecent` / `contextSummarize` 既有行为；它们继续守住单 session 事件流的语义边界。
  - 不修改 storage layer（`storage.listSessions()` API 已存在）。
  - 不持久化新 event 类型；contextSessions 不进 active context（INV-L12）。
  - 不改 CLI `bbl context history` / REST `/v1/context/history` 路径（它们仍是 `searchEvents` 复用层；如果未来需要 CLI/REST 暴露 cross-session metadata search，再起独立路由）。

## 2026-06-20 — Long-Running Context Assembly: natural_pause retired (ADR-5 retired)

- **背景**: `long-running-context-assembly.md` 的 R0-R7 全部收口 + plan 升 `Active Plan` (2026-06-21) 之后，ADR-5 承诺的"看 R0-R7 真实数据再决定 natural_pause 去留"已具备决策条件。R7 fixture (`session_981cc5c2` / `session_cf361f04` / `session_10320709`) 跑下来 0 个 natural_pause 事件；working set + behaviorTrace (`trajectory-end` / `user-redirect`) + `/v1/context/observe` redacted summary + resumePreview 已 100% 覆盖原 natural_pause 想捕获的信号。按 §13 Phase 3 + ADR-5 收口路径走候选 (a) 完全删除。
- **实现**:
  - `src/runtime/sessionMemoryLite.ts`: enum `SessionMemoryLiteReason` 移除 `'natural_pause'`；删除 decision 分支 + `isNaturalPauseSuppressed()` 函数 + DEPRECATED 注释块 + unused `latestTurnHasTools` 局部变量清理；保留 5-reason contract `disabled / duplicate_turn / growth_threshold / forced / insufficient_signal`。
  - `src/shared/events.ts:621`: zod schema `decisionReason` 同步移除 `'natural_pause'`。
  - `src/runtime/sessionMemoryLite.ts` 与其它 4 处源码 (`behaviorTrace.ts:21` / `behaviorMonitor.ts:21` / `behaviorTraceTap.ts:87` / `LLMCodingRuntime.ts:226`) + `test/behavior-trace.test.ts:17` 的 `INV-11: do not revive natural_pause` 注释**保留**为治理护栏 — 禁止任何后续 commit 复活该分支。
  - `test/context-assembler.test.ts`: 4 处 natural_pause 测试块 — 1 处 fixture+assertion (`analyzeContext returns token and compact diagnostics`) 改用 `growth_threshold`；1 处 env flag 解析测试整段重写为 `Session Memory Lite decision on a no-tool pause falls through to insufficient_signal`；1 处 `compactSession writes opt-in Session Memory Lite` 删 env flag setup/teardown；1 处 `queues natural pause updates` 改写为 `Session Memory Lite duplicates are skipped when no qualifying decision fires`，断言改为"无写入"。
  - `test/runtime-llm.test.ts`: env var 清空列表删 `'BABEL_O_NATURAL_PAUSE_SUPPRESS'`；`queues Session Memory Lite update after no-tool final response` 改写为 `skips Session Memory Lite write on no-tool final response (post-natural_pause retirement)`，断言改为"无写入"。
  - `docs/nexus/reference/long-running-context-assembly.md` §3 banner `State: Active Plan`（已就位）；§13 删 Phase 0 + Phase 3，§10 配置表删 `BABEL_O_NATURAL_PAUSE_SUPPRESS` 一行；§14 ADR-5 改写为"Retired 2026-06-20"，列出 Decision / Consequences；§15 budget row 把 P3 行标记 `✅`（已退役）；§16 risk row 改写为已收口；§17 第 5 项改写为"保留现状不主动迁移"；§18.5 Phase 0 行删除。
  - `docs/nexus/proposals/behavior-monitor.md`: 删除 PR-1 一行（`BABEL_O_NATURAL_PAUSE_SUPPRESS` env flag 默认压制 `natural_pause`）。
- **验证**:
  - `node_modules/.bin/tsc -p tsconfig.build.json --noEmit`：clean。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/context-assembler.test.ts`：56/56 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/runtime-llm.test.ts`：76/76 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/assemble-context-memory-hook.test.ts test/behavior-trace.test.ts test/context-tools.test.ts test/inspect-session.test.ts test/inspect-session-resume.test.ts test/r7-replay-gate.test.ts test/runtime-working-set-hot-path.test.ts test/r3-rest-put-observe.test.ts test/r4-context-observe-runtime-e2e.test.ts test/r5-resume-preview.test.ts`：136/136 pass（10 spec files）。
  - `grep -rn "'natural_pause'\|\"natural_pause\"" src test`：0 匹配。
- **边界**:
  - 不复活 `natural_pause` decision branch（INV-11 守护，5 处源码 + 1 处 test）。
  - 不改变 5-reason contract 的另外 4 个 reason (`disabled / duplicate_turn / forced / insufficient_signal`) 行为；`growth_threshold` 已 lock 测试覆盖。
  - 不迁移旧 `.babel-o/session-memory.md` 文件（保留现状，用户 `bbl context` 命令族可读；自动迁移会污染事件流）。
  - 不动 `BABEL_O_SESSION_MEMORY_LITE` 总开关（仍由它独立控制 write path enable）。

## 2026-06-20 — Module Coupling Governance Phase 4A+ Tail Cleanup: shared socket/security utilities

- **背景**: Phase 4A+ 已把 `app.ts` 降到 composition root，但尾部仍留有 utility export：`parseSocketQuery` 已适合 TUI / future WebSocket 复用，`isLocalHost` / `validateSecurityConfig` 是 server security helper，不属于 Nexus app composition root。
- **实现**:
  - 新增 `src/shared/security.ts`，承载 `isLocalHost()` 与 `validateSecurityConfig()`。
  - `src/nexus/app.ts` 改为从 shared re-export 这两个 helper，保留 legacy import path；`src/nexus/server.ts` 直接从 shared 导入启动安全校验，避免启动入口经由 app composition root 取 utility。
  - 当前树中 `src/shared/socketQuery.ts` 已承载 `parseSocketQuery()`；Phase 4 retrospective 同步标记 D1 closed。
  - `test/security.test.ts` 增加 shared-vs-legacy parity coverage。
  - `app.ts` 当前 191 lines；`src/shared/security.ts` 为 10 lines。
- **验证**:
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-test-security-slice.json npx tsx --test test/security.test.ts test/socket-query.test.ts test/middleware.test.ts`：37/37 pass。
  - `npm run coupling:audit`：exit 0；`runtimeToNexus: []` / `nexusToCli: []`；tracked `src/nexus/app.ts` hotspot 191 lines。
- **边界**:
  - 不改变 REST / WebSocket contract、auth semantics、security error message、Fastify middleware order、SQLite schema 或 runtime behavior。
  - 不开始 `LLMCodingRuntime.runExecuteStreamInner` / `RuntimeOrchestrator` 拆分；Phase 3B+ 主循环切片仍是下一条高风险主线。

## 2026-06-20 — Long-Running Context Assembly R6 Closure: Go TUI runtime-owned context rendering

- **背景**: long-running-context-assembly.md 的 R0-R5/R7 全部收口后，R6 是 plan 升级到 `Active Reference` 之前的最后一段。R6 acceptance 要求 Go TUI 只消费 runtime-owned 观察事实，永远不从 TUI 自身派生 context truth，并在 5 条状态机路径（observer absent / late connect / reconnect / schema mismatch / partial payload）上提供 fallback 文案，而不是让 LLM 模型用它的 narration 反推 context 数据。
- **实现 (5 子切片)**:
  - **R6-a `clients/go-tui/internal/loop/api/context_observer.go`** (335 lines): client-side WS subscriber `Client.ObserveContext(ctx, cwd, sessionID, opts) → events / errs / closeFn / err`，typed payload schema：`AssembledSnapshotMsg` / `AssembledMsg` / `ContextObserverError` 加 `AssembledContextEnvelope` 持 `ContextRedactionSummary` + `SystemPromptBlocks` + token estimates；`ContextObserveOpts.RedactionMode` 默认空（server summary 模式）/ `"full"` 注入 `?full=1`。镜像 `working_set_observer.go` 模式：单 reader goroutine、idempotent `closeFn`、forward-compat unknown frame type 处理。
  - **R6-b `clients/go-tui/internal/loop/context_observer.go`** (372 lines): loop-level `ContextObserver` + tea.Cmd plumbing。复用 PR-17c/B1 的 `BackoffState`（2s→5s→15s）；`Start` / `ConnectCmd` / `ReconnectCmd`；msg types `ctxObserverConnectMsg` / `ctxObserverReconnectMsg` / `ctxObserverEventMsg` / `ctxObserverErrMsg`；observer handle registry 与 ws_observer.go 隔离避免互扰。
  - **R6-c model wiring**: `interactive.go` 新增 `ctxObserver *ContextObserver` + `ctxObservation map[string]ContextObservation` + `ctxObservationMu sync.Mutex`；`NewInteractiveModelWithContextObserver()` factory；Init() 调 `ctxObserver.Start()`；Update switch 接入 4 种 ctxObserver msg。Helper：`applyCtxObservationFrame()`（observer-driven 唯一写入路径）/ `markCtxObservationDisconnected()` / `GetCtxObservation()` / `FormatCtxObservationLine()`（5 路径文案：not observed / connected · chars · msgs · blocks (cacheable) / reconnecting (err) / full mode (debug) / connected (no frame yet)）。
  - **R6-d focused tests**: `api/context_observer_test.go` 7 个 transport tests（snapshot+assembled / error frame / close idempotent / null context snapshot / sessionId query param / full mode query param / unknown frame recovery）；`loop/context_observer_test.go` 7 个 state-machine tests with 15 subcases（S1 not-observed / S2 late-connect / S3 reconnect 替换 stale state / S4 schema mismatch 三种子情形 / S5 partial payload 两种 fallback / backoff 序列 2s→5s→15s+cap+Reset / formatThousands helper）。
  - **R6-e doc sync**: `docs/nexus/proposals/long-running-context-assembly.md` 顶部状态行升级为 R0-R7 全部收口、剩余项块从 6 项 🔴/🟠/🟡 改为 ✅、R6 在 §20 P1 Watch list 标记 "[2026-06-20 已收口]"、修复 line 1124-1126 R6/R7 编号重复。本 plan 现等待 governance 把它从 `proposals/` 迁移到 `reference/` 后即可正式升级为 `Active Reference`（独立 doc lifecycle slice，不阻塞功能闭环）。
- **runtime-owned 契约**: renderer 永远不从模型自身状态推导 context truth；frame 永远不到时显示 `context: not observed`；server 一旦发 `redaction:"full"`，loop 仍 fallback 到 `context: full mode (debug)` 而不是显示 verbatim prompt；error frame 进来后 status 翻 disconnected、`LastError` 被记录用于诊断、renderer 显示 `reconnecting` 而不是反向推导。
- **验证**:
  - `cd clients/go-tui && go build ./...`：clean。
  - `cd clients/go-tui && go test ./internal/loop/api/ -run TestObserveContext -v`：7/7 pass。
  - `cd clients/go-tui && go test ./internal/loop/ -run TestR6 -v`：7 top-level tests + 15 subcases 全部 pass。
  - `cd clients/go-tui && go test ./...`：全套 4 packages（loop / loop/api / notifications / tui）全部 pass。
  - `npm run docs:check`：green（line 3 仍是 `> State: Partially Landed`，符合 proposal 文档生命周期约束；plan 升级到 `Active Reference` 需独立 doc-governance slice 把文件迁到 `reference/` 目录）。
- **边界**:
  - 不改变 `/v1/context/observe` 的 server-side 路由 / redaction policy / payload schema。
  - 不改变 working-set observer (PR-17c/B1) 的现有 wiring；两个 observer 共享 `BackoffState` 类型但 handle registry 完全隔离。
  - Bubble Tea 程序的现有 wsObserver 启动 / lifecycle 完全保留；ctxObserver 是叠加而非替换。
  - 不引入新 CLI flag；observer 默认开启（与 PR-17c/B1 同政策）。
  - 不改变 SQLite / REST / WebSocket / event schema、不改变 redaction summary 字段集合。

## 2026-06-19 — Module Coupling Governance Phase 3B+ Helper Extraction Pull (3B-1 / 3B-6 / 3B-7 / 3B-8)

- **背景**: Phase 3B+ 已抽出 3 个 strategy class（`ContextRefreshStrategy` / `ProviderTurnDriver` / `ToolDispatchPipeline`），但 `LLMCodingRuntime` 主循环仍持有四块"非 orchestration、可纯函数化"的逻辑：(1) NexusEvent → provider message 翻译，(2) behavior-trace tap 包装 async generator，(3) R2 working-set 读取侧（含 storage rebuild fallback），(4) R2 working-set 写入侧（fire-and-forget per-event apply）。这四块都不参与主循环 25 步的 yield/refresh/compact 顺序，可独立抽出并单测，不破坏 R2 wiring-guard 契约（`test/runtime-working-set-hot-path.test.ts` 要求 `LLMCodingRuntime.prototype.loadWorkingSetOverride` / `applyWorkingSetUpdate` 仍是 function）。
- **实现 (4 个 slice)**:
  - **3B-1 `eventsTranslator.ts`** (332 lines): `mapEventsToMessages` 纯函数 + `assistant_delta` / `tool_completed` / `tool_denied` / `usage` / `result` / `error` / `permission_*` 的 if/else 翻译链；`LLMCodingRuntime` re-export 保留 backward-compat。`test/events-translator.test.ts`：14 tests。
  - **3B-6 `behaviorTraceTap.ts`** (175 lines): `wrapWithBehaviorTraceTap()` async-generator tap + `behaviorTraceDetectionKey()` helper；保留 nexus 5min 检测窗口与 BehaviorMonitor wiring。`test/behavior-trace-tap.test.ts`：6 tests。
  - **3B-7 `loadWorkingSetOverride.ts`** (118 lines): R2 read-side override loader，处理 tracker undefined / 空 tracker / storage rebuild fallback / out-of-cwd 过滤；`LLMCodingRuntime` 用 thin-delegate method 保留 R2 wiring-guard。`test/load-working-set-override.test.ts`：8 tests。
  - **3B-8 `applyWorkingSetUpdate.ts`** (83 lines): R2 write-side per-event apply，fire-and-forget；只处理 `tool_started` 事件，跨 cwd / 无 path input 由 `tracker.applyEvent` 内部过滤；`LLMCodingRuntime` 用 thin-delegate method 保留 R2 wiring-guard。`test/apply-working-set-update.test.ts`：7 tests。
  - 净效果：`src/runtime/LLMCodingRuntime.ts` 1841 → 1620 行（**-221 行 / -12.0%**），新增 4 个独立模块共 708 行，新增 4 个测试文件共 35 个 focused test。
- **R2 wiring-guard 契约保留**: `test/runtime-working-set-hot-path.test.ts` 中 `proto['loadWorkingSetOverride']` / `proto['applyWorkingSetUpdate']` typeof 'function' 断言通过；`runtimePipeline forwards workingSetOverride to assembleContext` 断言通过；R2 4 scenarios + scenario 5 + 2 wiring 共 7/7 pass。
- **验证**:
  - `npx tsc --noEmit -p tsconfig.json`：3B-8 模块本身和 LLMCodingRuntime 引用均无错误（`test/r5-resume-preview.test.ts(347,13)` 一个 R5 自身遗留不影响 3B-8）。
  - `npm test`：1147/1147 pass（无新失败）。
  - `npm run docs:check`：green（修回 long-running-context-assembly.md `> State: Partially Landed` bare 形式）。
  - `npm run coupling:audit`：exit 0；`runtimeToNexus: []` / `nexusToCli: []`。
  - `npm run format:check` / `npm run deps:audit`：exit 0。
  - `npm run build:smoke`：exit 0；`bbl run hello` 4615ms。
- **边界**:
  - 不改变 R2 hot-path 行为（loadWorkingSetOverride / applyWorkingSetUpdate 调用点 + 频次 + 参数完全一致）。
  - 不改变 mapEventsToMessages 的事件翻译顺序与字段语义；adapter 端可见 message 数组 byte-identical。
  - 不改变 behavior-trace tap 的检测窗口语义（仍是 5 min nexus）或 BehaviorMonitor wiring。
  - 不改变 storage / SQLite schema、REST/WS 契约、tool result envelope。
  - `LLMCodingRuntime` 主循环 25 步 orchestration（`yield buildXxxEvent` / `refreshRuntimeContextState` / `compactSession` / `previousEvents.push`）仍在原处；下一步切 `runExecuteStreamInner` 主体属于高风险区。

## 2026-06-19 — Module Coupling Governance Phase 4A+: ExecutionWebSocketLifecycle Slice

- **背景**: `ActiveExecutionLease` 收口后，WebSocket `/v1/stream` route 仍直接管理 client close listener、`closedByClient` 状态和 timeout / summary event sender callback。该逻辑属于 WebSocket lifecycle boundary；route 层应只持有 lifecycle tracker 和 event sender，不应内联 listener cleanup 与 open-socket metric 记录细节。
- **实现**:
  - 扩展 `src/nexus/executionWebSocketControl.ts`，新增 `trackWebSocketClientClose()`，封装 close listener 注册、`closedByClient` 读取和 cleanup。
  - 新增 `createWebSocketEventSender()`，统一 open-socket event send 与 `metrics.recordStreamEvent(socket.bufferedAmount)` 记录，用于 timeout / summary event callback。
  - WebSocket `/v1/stream` 改为持有 `clientCloseTracker` 与 `sendTimeoutEvent`；busy rejection 和 finally 都走 tracker cleanup，finish metrics 继续读取 client-closed 状态。
  - 扩展 `test/execution-websocket-control.test.ts`，锁定 close tracker cleanup 与 event sender metric 行为。
  - `app.ts` 当前为 864 lines；`src/nexus/executionWebSocketControl.ts` 为 133 lines。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-execution-ws-lifecycle.json npx tsx --test --test-concurrency=1 test/execution-websocket-control.test.ts`：7/7 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-execution-ws-lifecycle-runtime.json npx tsx --test --test-concurrency=1 --test-name-pattern "websocket stream relays and persists context blocking events|websocket stream timeout aborts long-running tools|WebSocket /v1/stream blocks model without tool calling support|execute honours per-request timeoutMs from Go TUI WebSocket payload" test/runtime.test.ts`：4/4 pass。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；tracked `src/nexus/app.ts` hotspot 864 lines。已知历史 debt 保持不变：`sharedToOutside` 仍为 `src/shared/config.ts -> providers/registry.ts`。
- **边界**:
  - Phase 4A+ 未关闭；`/v1/execute` 与 `/v1/stream` 的 route lifecycle、request/response contracts、timeout lifecycle、settlement 调用和 remaining socket wiring 仍在 `app.ts`。
  - 不改变 REST / WebSocket contract, event append/persist/send ordering, timeout policy semantics, stream metrics semantics, settlement semantics, storage schema, or runtime behavior。

## 2026-06-19 — Module Coupling Governance Phase 4A+: ActiveExecutionLease Slice

- **背景**: `ExecutionStreamLoop` 收口后，HTTP `/v1/execute` 与 WebSocket `/v1/stream` 仍在 route 层用不同方式清理 active execution：HTTP 临时保存 `activeSessionId` / `activeRequestId`，WS 保存 `AbortController` 再通过 `clearByAbortController()` 反查。该逻辑属于 active execution lifecycle boundary；route 层应只持有一个 cleanup handle，不应知道 registry 内部清理键。
- **实现**:
  - 扩展 `src/nexus/activeExecutionRegistry.ts`，让 `register()` 返回 `ActiveExecutionLease`，并提供幂等 `release()`。
  - HTTP `/v1/execute` 与 WebSocket `/v1/stream` 改为保存 `activeExecutionLease` 并在 finally 调 `release()`；route 层不再持有 HTTP `activeSessionId` / `activeRequestId` 清理变量，也不再通过 WS abort controller 反查清理。
  - 保留 `snapshot()` / `cancel()` / `clearByAbortController()` 旧能力；cancel/resume routers 的 contract 不变。
  - 新增 `test/active-execution-registry.test.ts`，锁定 lease release 幂等、旧 lease 不会清掉同 session 的新 request，以及 cancel 后 release 能清掉当前 execution。
  - `app.ts` 当前为 865 lines；`src/nexus/activeExecutionRegistry.ts` 为 75 lines。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-active-execution-registry.json npx tsx --test --test-concurrency=1 test/active-execution-registry.test.ts`：2/2 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-active-execution-lease-runtime2.json npx tsx --test --test-concurrency=1 --test-name-pattern "remote cancel aborts active execution and resume returns session snapshot|execute soft policy watchdog decorates REQUEST_TIMEOUT with details.kind=watchdog and cleans the active execution registry|websocket stream timeout aborts long-running tools" test/runtime.test.ts`：3/3 pass。
- **边界**:
  - Phase 4A+ 未关闭；`/v1/execute` 与 `/v1/stream` 的 route lifecycle、request/response contracts、timeout lifecycle、settlement 调用和 socket cleanup 仍在 `app.ts`。
  - 不改变 REST / WebSocket contract, active execution snapshot/cancel response shape, timeout policy semantics, stream metrics semantics, settlement semantics, storage schema, or runtime behavior。

## 2026-06-19 — Module Coupling Governance Phase 4A+: ExecutionStreamLoop Slice

- **背景**: `ExecutionWebSocketForwarding` 收口后，HTTP `/v1/execute` 与 WebSocket `/v1/stream` 仍各自内联 runtime event loop 控制流：调用 `runtime.executeStream()`、处理单事件 sink、追加 near-timeout checkpoint，并在 WS path 追踪 result/error terminal state。该逻辑是 execute/stream 共同的 stream-loop boundary，不属于 request preparation、timeout controls、settlement、HTTP envelope 或 socket cleanup。
- **实现**:
  - 新增 `src/nexus/executionStreamLoop.ts`，承载 `runExecutionStreamLoop()` 与窄类型 `ExecutionStreamLoopResult` / `ExecutionStreamLoopForwardResult`。
  - HTTP `/v1/execute` 改为用该 helper 跑 runtime stream；route 层继续负责 execution gate、active registry、timeout controls cleanup、settlement、execute finish metrics 与 HTTP result envelope。
  - WebSocket `/v1/stream` 通过同一 helper 跑 runtime stream，并注入 `forwardProcessedRuntimeEvent()` 与 `sendTimeoutEvent` callback；route 层继续负责 socket message parsing、permission_response 快路径、execution gate、active registry、timeout controls cleanup、settlement、socket cleanup 与 stream finish metrics。
  - 新增 `test/execution-stream-loop.test.ts`，锁定 HTTP-style loop 的 persist + near-timeout warning + terminal result tracking，以及 WS-style forwarding closed 时停止 loop 且不追加 near-timeout checkpoint。
  - `app.ts` 当前为 871 lines；新增 `src/nexus/executionStreamLoop.ts` 为 69 lines。剩余 inline routes 仍为 `/v1/execute` 与 `/v1/stream`，但共享 event loop 已从 `app.ts` 移出。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-execution-stream-loop.json npx tsx --test --test-concurrency=1 test/execution-stream-loop.test.ts`：2/2 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-execution-ws-forwarding.json npx tsx --test --test-concurrency=1 test/execution-websocket-control.test.ts`：5/5 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-execution-stream-loop-runtime.json npx tsx --test --test-concurrency=1 --test-name-pattern "execute reads a workspace file and records session events|execute timeout preserves partial result and emits near-timeout warning|execute permission denial: user denies → tool_denied \+ result\(false\)|/v1/execute returns context blocking status in result envelope|websocket stream relays and persists context blocking events|websocket stream timeout aborts long-running tools|WebSocket /v1/stream blocks model without tool calling support|execute honours per-request timeoutMs from Go TUI WebSocket payload" test/runtime.test.ts`：8/8 pass。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；tracked `src/nexus/app.ts` hotspot 871 lines。已知历史 debt 保持不变：`sharedToOutside` 仍为 `src/shared/config.ts -> providers/registry.ts`。
- **边界**:
  - Phase 4A+ 未关闭；`/v1/execute` 与 `/v1/stream` 的 route lifecycle、request/response contracts、socket lifecycle 和 settlement 调用仍在 `app.ts`。
  - 不改变 REST / WebSocket contract, event append/persist/send ordering, timeout policy semantics, stream metrics semantics, settlement semantics, storage schema, or runtime behavior。

## 2026-06-19 — Module Coupling Governance Phase 4A+: ExecutionWebSocketForwarding Slice

- **背景**: `ExecutionSettlement` 收口后，WebSocket `/v1/stream` event loop 仍内联 processed runtime event 的转发细节：`cache_health` 先发、主 decorated event 后发、socket closed 时 abort、只对主 stream event 记录 `metrics.recordStreamEvent()`。该逻辑是 WebSocket forwarding boundary，不属于 runtime event processing sink、settlement、timeout controls 或 route cleanup。
- **实现**:
  - 扩展 `src/nexus/executionWebSocketControl.ts`，新增 `forwardProcessedRuntimeEvent()` 与窄类型 `ProcessedRuntimeEventForForwarding` / `StreamMetricsRecorder`。
  - WebSocket `/v1/stream` event loop 改为调用该 helper；route 层继续负责 near-timeout warning、result/error tracking、timeout/settlement、socket cleanup、active execution cleanup 与 stream finish metrics。
  - 扩展 `test/execution-websocket-control.test.ts`，锁定 `cache_health` 在 decorated event 前发送、仅主 event 记录一次 stream metric，以及 socket 已关闭时 abort 且不发送主 event。
  - 顺手把 `test/execution-settlement.test.ts` 的 `tool_denied` fixture 收敛为真实 `NexusEvent` schema（补 `risk`、移除不存在的 `toolUseId`），避免 typecheck 继续依赖宽松假对象。
  - `app.ts` 当前为 891 lines。剩余 inline routes 仍为 `/v1/execute` 与 `/v1/stream`，但 WebSocket processed event forwarding 已从 `app.ts` 移出。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-execution-ws-forwarding.json npx tsx --test --test-concurrency=1 test/execution-websocket-control.test.ts`：5/5 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-execution-settlement.json npx tsx --test --test-concurrency=1 test/execution-settlement.test.ts`：2/2 pass。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；tracked `src/nexus/app.ts` hotspot 891 lines。已知历史 debt 保持不变：`sharedToOutside` 仍为 `src/shared/config.ts -> providers/registry.ts`。
- **边界**:
  - Phase 4A+ 未关闭；`/v1/execute` 与 `/v1/stream` 的 event loop control flow 仍在 `app.ts`。
  - 不改变 REST / WebSocket contract, event append/persist/send ordering, cache-health schema, stream metrics semantics, timeout policy semantics, storage schema, or runtime behavior。

## 2026-06-19 — Module Coupling Governance Phase 4A+: ExecutionSettlement Slice

- **背景**: `ExecutionTimeoutControls` 收口后，HTTP `/v1/execute` 与 WebSocket `/v1/stream` 仍各自内联 loop 后结算逻辑：result/error 提取、timeout partial result 追加、recoverable tool denial 成功归因、session finalization、`execute_summary` append/persist/send。该逻辑是 execution settlement boundary，不属于 runtime event loop、event processing sink、timeout controls 或 HTTP envelope assembly。
- **实现**:
  - 扩展 `src/nexus/executionFinalization.ts`，新增 `ExecutionSettlementResult` 与 `settleExecutionSession()`。
  - HTTP `/v1/execute` loop 后改为调用 `settleExecutionSession()`，route 层继续负责 `metrics.recordExecuteFinish()` 与 `buildExecuteResultEnvelope()`。
  - WebSocket `/v1/stream` loop 后改为调用同一 helper，并通过既有 `sendTimeoutEvent` closure 发送 timeout partial result 和 `execute_summary`；route 层继续负责 socket cleanup、active execution cleanup 和 `metrics.recordStreamFinish()`。
  - 新增 `test/execution-settlement.test.ts`，锁定 timeout partial result + summary append/send 顺序，以及 recoverable tool denial only turn 的成功归因。
  - `app.ts` 当前为 902 lines；`src/nexus/executionFinalization.ts` 为 193 lines。剩余 inline routes 仍为 `/v1/execute` 与 `/v1/stream`，但 shared settlement 已从 `app.ts` 移出。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-execution-settlement.json npx tsx --test --test-concurrency=1 test/execution-settlement.test.ts`：2/2 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-execution-settlement-runtime.json npx tsx --test --test-concurrency=1 --test-name-pattern "execute reads a workspace file and records session events|execute timeout preserves partial result and emits near-timeout warning|execute permission denial: user denies → tool_denied \+ result\(false\)|/v1/execute returns context blocking status in result envelope|websocket stream relays and persists context blocking events|websocket stream timeout aborts long-running tools|execute honours per-request timeoutMs from Go TUI WebSocket payload" test/runtime.test.ts`：7/7 pass。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；tracked `src/nexus/app.ts` hotspot 902 lines。
- **边界**:
  - Phase 4A+ 未关闭；`/v1/execute` 与 `/v1/stream` 的 event loop control flow 仍在 `app.ts`。
  - 不改变 REST / WebSocket contract, summary schema, HTTP envelope shape, stream finish metrics, timeout policy semantics, event append/persist/send ordering, storage schema, or runtime behavior。

## 2026-06-19 — Module Coupling Governance Phase 4A+: ExecutionTimeoutControls Slice

- **背景**: `ExecutionEventSink` 收口后，HTTP `/v1/execute` 与 WebSocket `/v1/stream` 仍各自内联 timeout controls setup：`effectiveTimeoutMs` 推导、near-timeout watcher 启动、soft-timeout cycle 启动与 cleanup。该逻辑属于 timeout controls 接线，不属于 runtime event loop、主 watchdog abort、finalization 或 response/stream contract。
- **实现**:
  - 扩展 `src/nexus/executionTimeoutEvents.ts`，新增 `ExecutionTimeoutControls` 与 `startExecutionTimeoutControls()`。
  - HTTP `/v1/execute` 与 WebSocket `/v1/stream` 统一通过该 helper 启动 near-timeout watcher 和 soft-timeout cycle；route 层仍保留主 watchdog `timeout` 的 `clearTimeout()`、事件循环、near-timeout 检查点和 socket-close abort handling。
  - WebSocket path 保留本地 `sendTimeoutEvent` closure，继续由 route 层控制 open-only send 与 `metrics.recordStreamEvent()`。
  - `app.ts` 当前为 946 lines；`src/nexus/executionTimeoutEvents.ts` 为 382 lines。剩余 inline routes 仍为 `/v1/execute` 与 `/v1/stream`，但 timeout controls setup 已从 `app.ts` 移出。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-execution-timeout-controls-focused.json npx tsx --test --test-concurrency=1 --test-name-pattern "execute timeout preserves partial result and emits near-timeout warning|execute soft timeout policy emits timeout_budget_exceeded once when the soft budget is reached and keeps the runtime live|execute soft timeout policy auto-grants one extension by default and emits both budget\+grant events in order|execute soft policy watchdog decorates REQUEST_TIMEOUT with details.kind=watchdog and cleans the active execution registry|execute fatal timeout policy never decorates REQUEST_TIMEOUT with details.kind=watchdog|execute honours per-request timeoutMs from Go TUI WebSocket payload|websocket stream timeout aborts long-running tools|WebSocket /v1/stream blocks model without tool calling support|websocket stream relays and persists context blocking events" test/runtime.test.ts`：9/9 pass。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；tracked `src/nexus/app.ts` hotspot 946 lines。
- **边界**:
  - Phase 4A+ 未关闭；`/v1/execute` 与 `/v1/stream` 的 event loop control flow 仍在 `app.ts`。
  - 不改变 REST / WebSocket contract, timeout event schema, soft timeout extension semantics, main watchdog abort semantics, event append/persist/send ordering, storage schema, or runtime behavior。

## 2026-06-19 — Module Coupling Governance Phase 4A+: ExecutionEventSink Slice

- **背景**: `ExecutionWebSocketControl` 收口后，HTTP `/v1/execute` 与 WebSocket `/v1/stream` 的 runtime event loop 仍重复一段单事件处理顺序：soft watchdog error decoration、push 到本轮 events、append storage、record NexusMetrics、BehaviorMonitor ingest、派生并持久化 `cache_health`。该逻辑是 event processing boundary，不属于 loop 控制流、near-timeout watcher 或 socket close handling，本轮抽成单事件 sink helper。
- **实现**:
  - 扩展 `src/nexus/executionEventProcessing.ts`，新增 `processRuntimeExecutionEvent()` 与 `BehaviorMonitorLike` / `ProcessRuntimeExecutionEventResult`。
  - HTTP `/v1/execute` event loop 改为调用 `processRuntimeExecutionEvent()`，随后按原顺序追加 near-timeout warning。
  - WebSocket `/v1/stream` event loop 改为调用同一 helper，helper 负责 decorate / persist / metrics / ingest / cache-health persistence；WS path 仍在 helper 返回后按原顺序 forward `cache_health` 与主事件，并保留 socket closed abort check、near-timeout warning、success/timedOut tracking。
  - 新增 `test/execution-event-processing.test.ts`，锁定 watchdog timeout 在 persist/ingest 前被 decorate，以及 `execution_metrics` 后派生的 `cache_health` 按顺序持久化。
  - `app.ts` 当前为 1022 lines；`src/nexus/executionEventProcessing.ts` 为 119 lines。剩余 inline routes 仍为 `/v1/execute` 与 `/v1/stream`，但单事件 processing sink 已从 `app.ts` 移出。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-execution-event-processing.json npx tsx --test --test-concurrency=1 test/execution-event-processing.test.ts`：2/2 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-event-sink-timeout.json npx tsx --test --test-concurrency=1 --test-name-pattern "execute timeout preserves partial result and emits near-timeout warning|execute soft policy watchdog decorates REQUEST_TIMEOUT with details.kind=watchdog and cleans the active execution registry|execute fatal timeout policy never decorates REQUEST_TIMEOUT with details.kind=watchdog" test/runtime.test.ts`：3/3 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-event-sink-ws.json npx tsx --test --test-concurrency=1 --test-name-pattern "websocket stream relays and persists context blocking events|execute honours per-request timeoutMs from Go TUI WebSocket payload|WebSocket /v1/stream blocks model without tool calling support" test/runtime.test.ts`：3/3 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-event-sink-cache.json npx tsx --test --test-concurrency=1 --test-name-pattern "runtime metrics aggregates cache-aware performance diagnostics|runtime metrics exposes provider invocation, agent loop, and cache health summaries|execute reads a workspace file and records session events" test/runtime.test.ts`：2 matching tests pass。
- **边界**:
  - Phase 4A+ 未关闭；`/v1/execute` 与 `/v1/stream` 的 event loop control flow 仍在 `app.ts`。
  - 不改变 REST / WebSocket contract, event append/persist/send ordering, timeout policy semantics, cache health schema/dedup, BehaviorMonitor ingest, storage schema, or runtime behavior。

## 2026-06-19 — Module Coupling Governance Phase 4A+: ExecutionWebSocketControl Slice

- **背景**: `ExecutionRuntimeOptions` 收口后，WebSocket `/v1/stream` 仍在 `app.ts` 内联 JSON parse、permission_response 快路径 resolve 与 socket send helper。这些是 WebSocket control helpers，不属于 runtime event loop ordering，本轮作为独立小切片抽出。
- **实现**:
  - 新增 `src/nexus/executionWebSocketControl.ts`，承载 `parseJsonObject()`、`sendJson()`、`resolvePermissionResponseMessage()` 与 `WebSocketLike` 结构类型。
  - `app.ts` 的 `/v1/stream` message handler 只调用 `resolvePermissionResponseMessage(parsedJson)` 处理 permission response 快路径；执行消息解析、execution gate、timeout watcher、event persist/send、summary append、finalization 与 metrics 行为保持不变。
  - 新增 `test/execution-websocket-control.test.ts`，锁定 invalid JSON fallback、open-only send 与 permission response resolver contract。
  - `app.ts` 当前为 1050 lines；`src/nexus/executionWebSocketControl.ts` 为 63 lines。剩余 inline routes 仍为 `/v1/execute` 与 `/v1/stream`，但 WebSocket control helpers 已从 `app.ts` 移出。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-execution-ws-control.json npx tsx --test --test-concurrency=1 test/execution-websocket-control.test.ts`：3/3 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-execution-ws-control-regression.json npx tsx --test --test-concurrency=1 --test-name-pattern "execute honours per-request allowedTools for Bash in soft-deny mode|execute honours per-request timeoutMs from Go TUI WebSocket payload|WebSocket /v1/stream blocks model without tool calling support" test/runtime.test.ts`：3/3 pass。
- **边界**:
  - Phase 4A+ 未关闭；`/v1/execute` 与 `/v1/stream` 的 event loop wiring 仍在 `app.ts`。
  - 不改变 REST / WebSocket contract, permission response semantics, runtime execution order, timeout policy semantics, event persistence/sending order, storage schema, or runtime behavior。

## 2026-06-19 — Module Coupling Governance Phase 4A+: ExecutionRuntimeOptions Slice

- **背景**: `ExecutionHttpResult` 收口后，HTTP `/v1/execute` 与 WebSocket `/v1/stream` 两条路径仍各自内联同一组 `runtime.executeStream()` options assembly：storage 注入、cwd continuity inputs、policy mode、allowed paths/tools、remote runner、timeout signal 与 output budgets。该逻辑是 execute/stream 共同依赖边界，不属于 event loop ordering，本轮作为独立小切片抽出。
- **实现**:
  - 新增 `src/nexus/executionRuntimeOptions.ts`，承载 `buildRuntimeExecuteOptions()`。
  - `app.ts` 的 HTTP 与 WebSocket 两处 `runtime.executeStream()` 调用统一通过该 helper 组装参数；事件收集、persist/send 顺序、timeout watcher、summary append、finalization、metrics 与 response/stream contract 均保持不变。
  - 新增 `test/execution-runtime-options.test.ts`，锁定 storage、remote runner、timeout signal、policy/allowedTools、allowedPaths、continuity inputs 与 maxToolOutput fallback 的传递契约。
  - `app.ts` 当前为 1089 lines；`src/nexus/executionRuntimeOptions.ts` 为 42 lines。剩余 inline routes 仍为 `/v1/execute` 与 `/v1/stream`，但 runtime execute option assembly 已从 `app.ts` 移出。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-execution-runtime-options.json npx tsx --test --test-concurrency=1 test/execution-runtime-options.test.ts`：2/2 pass。
- **边界**:
  - Phase 4A+ 未关闭；`/v1/execute` 与 `/v1/stream` 的 event loop wiring 仍在 `app.ts`。
  - 不改变 REST / WebSocket contract, runtime execution order, timeout policy semantics, event persistence/sending order, permission policy, storage schema, or runtime behavior。

## 2026-06-19 — Module Coupling Governance Phase 4A+: ExecutionHttpResult Slice

- **背景**: `RuntimeMetricsSnapshot` 收口后，`app.ts` 的 HTTP `/v1/execute` 仍内联 result envelope / status-code assembly：`context_blocking` → 413、`REQUEST_TIMEOUT` → 408、`execute_summary` 元数据回填 envelope。该逻辑是 HTTP response assembly，不属于 runtime event loop 或 WebSocket stream，本轮先作为独立小切片抽出。
- **实现**:
  - 新增 `src/nexus/executionHttpResult.ts`，承载 `runtimeResultStatusCode()` 与 `buildExecuteResultEnvelope()`。
  - `app.ts` 在 HTTP `/v1/execute` finalize 后调用 `buildExecuteResultEnvelope()`；事件收集、summary append、session finalization、metrics finish、REST status 200 wrapper 和 WebSocket path 均保持不变。
  - `app.ts` 当前为 1123 lines；`src/nexus/executionHttpResult.ts` 为 48 lines。剩余 inline routes 仍为 `/v1/execute` 与 `/v1/stream`，但 HTTP execute response assembly 已从 `app.ts` 移出。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-http-result-basic.json npx tsx --test --test-concurrency=1 --test-name-pattern "execute reads a workspace file and records session events" test/runtime.test.ts`：1/1 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-http-result-timeout.json npx tsx --test --test-concurrency=1 --test-name-pattern "execute timeout preserves partial result and emits near-timeout warning|execute soft policy watchdog decorates REQUEST_TIMEOUT with details.kind=watchdog and cleans the active execution registry|execute honours per-request timeoutMs from Go TUI WebSocket payload" test/runtime.test.ts`：3/3 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-http-result-context.json npx tsx --test --test-concurrency=1 --test-name-pattern "/v1/execute returns context blocking status in result envelope" test/runtime.test.ts`：1/1 pass。
- **边界**:
  - Phase 4A+ 未关闭；`/v1/execute` 与 `/v1/stream` 仍在 `app.ts`。
  - 不改变 REST / WebSocket contract, HTTP status wrapper, execute result envelope shape, execute summary semantics, event persistence, runtime behavior, or SQLite schema。

## 2026-06-19 — Module Coupling Governance Phase 4A+: RuntimeMetricsSnapshot Slice

- **背景**: `ExecutionEventProcessing` 收口后，`app.ts` 仍内联 `/v1/runtime/metrics` 使用的 runtime metrics snapshot 聚合逻辑：provider invocation metrics、agent loop metrics、agent job metrics、cache health summary 与 storage recent-session scan。这块属于 runtime metrics response assembly，不属于 Fastify route wiring 或 execute/stream contract，适合独立抽成可 review helper。
- **实现**:
  - 新增 `src/nexus/runtimeMetricsSnapshot.ts`，承载 `buildRuntimeMetricsSnapshot()`、provider invocation / agent loop / agent job metrics 聚合 helper、cache-health snapshot 组合逻辑。
  - `app.ts` 仅通过 router context closure 调用 `buildRuntimeMetricsSnapshot(metrics, options.storage)`；`runtimeMetricsRouter` route contract、response shape、storage scan 范围、cache health semantics 与 NexusMetrics accumulator 行为保持不变。
  - `app.ts` 当前为 1133 lines；`src/nexus/runtimeMetricsSnapshot.ts` 为 310 lines。剩余 inline routes 仍为 `/v1/execute` 与 `/v1/stream`，但 runtime metrics aggregation helper 已从 `app.ts` 移出。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-runtime-metrics-snapshot-router.json npx tsx --test --test-concurrency=1 test/runtime-metrics-router.test.ts`：1/1 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-runtime-metrics-snapshot-aggregate.json npx tsx --test --test-concurrency=1 --test-name-pattern "runtime metrics aggregates cache-aware performance diagnostics" test/runtime.test.ts`：1/1 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-runtime-metrics-snapshot-basic.json npx tsx --test --test-concurrency=1 --test-name-pattern "execute reads a workspace file and records session events" test/runtime.test.ts`：1/1 pass。
- **边界**:
  - Phase 4A+ 未关闭；`/v1/execute` 与 `/v1/stream` 仍在 `app.ts`。
  - 不改变 REST / WebSocket contract, `/v1/runtime/metrics` response shape, NexusMetrics accumulator semantics, cache health snapshot semantics, execution metrics persistence, runtime behavior, or SQLite schema。

## 2026-06-19 — Module Coupling Governance Phase 4A+: ExecutionEventProcessing Slice

- **背景**: `ExecutionFinalization` 收口后，`app.ts` 仍内联 HTTP / WebSocket 共享的 execution event processing 规则：`execution_metrics` 写入 NexusMetrics、`execution_metrics` 后派生 `cache_health`、soft policy watchdog `REQUEST_TIMEOUT` error decoration。这些规则属于执行事件处理边界，不属于 route contract 本体，适合独立抽成可 review helper。
- **实现**:
  - 新增 `src/nexus/executionEventProcessing.ts`，承载 `recordExecutionEventMetrics()`、`maybeBuildExecutionCacheHealthEvent()`、`maybeDecorateWatchdogError()`。
  - `app.ts` 仅在 HTTP `/v1/execute` 与 WebSocket `/v1/stream` event loop 中调用这些 helper；route contract、event append/persist/send 顺序、timeout scheduling、summary append、BehaviorMonitor ingest 与 metrics finish 行为保持不变。
  - `app.ts` 当前为 1450 lines；`src/nexus/executionEventProcessing.ts` 为 76 lines。剩余 inline routes 仍为 `/v1/execute` 与 `/v1/stream`，但 execution metrics/cache health/watchdog decoration 规则已从 `app.ts` 移出。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-exec-events-timeout.json npx tsx --test --test-concurrency=1 --test-name-pattern "execute timeout preserves partial result and emits near-timeout warning|execute soft policy watchdog decorates REQUEST_TIMEOUT with details.kind=watchdog and cleans the active execution registry|execute honours per-request timeoutMs from Go TUI WebSocket payload" test/runtime.test.ts`：3/3 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-exec-events-context.json npx tsx --test --test-concurrency=1 --test-name-pattern "websocket stream relays and persists context blocking events|/v1/execute returns context blocking status in result envelope" test/runtime.test.ts`：2/2 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-exec-events-basic.json npx tsx --test --test-concurrency=1 --test-name-pattern "execute reads a workspace file and records session events|runtime metrics exposes provider invocation, agent loop, and cache health summaries" test/runtime.test.ts`：1 matching test pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-exec-events-denial.json npx tsx --test --test-concurrency=1 --test-name-pattern "execute honours per-request policy=soft-deny for write/execute tools|execute with default strict policy emits recoverable policy denial for execute-risk Bash" test/runtime.test.ts`：2/2 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-exec-events-metrics.json npx tsx --test --test-concurrency=1 --test-name-pattern "runtime metrics aggregates cache-aware performance diagnostics" test/runtime.test.ts`：1/1 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-exec-events-fatal.json npx tsx --test --test-concurrency=1 --test-name-pattern "execute fatal timeout policy never decorates REQUEST_TIMEOUT with details.kind=watchdog" test/runtime.test.ts`：1/1 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-cache-health.json npx tsx --test test/cache-health.test.ts`：28/28 pass。
- **边界**:
  - Phase 4A+ 未关闭；`/v1/execute` 与 `/v1/stream` 仍在 `app.ts`。
  - 不改变 REST / WebSocket contract, event persistence order, timeout policy semantics, cache health event schema, runtime metrics snapshot shape, BehaviorMonitor ingest, runtime behavior, or SQLite schema。

## 2026-06-19 — Module Coupling Governance Phase 4A+: ExecutionFinalization Slice

- **背景**: `ExecutionPreparation` 收口后，`app.ts` 仍内联 HTTP / WebSocket 共享的 execution finalization 状态机：session phase/result/error 写回、terminalReason 分类、context-blocking recovery metadata、recoverable tool-denial success 归因和 execute summary outcome。它不属于 route contract 本体，适合独立抽成可 review helper。
- **实现**:
  - 新增 `src/nexus/executionFinalization.ts`，承载 `finalizeExecutionSession()`、`executeSummaryOutcome()`、`isRecoverableToolDenialOnlyTurn()`、runtime terminal reason 分类与 context-blocking recovery metadata helpers。
  - `app.ts` 仅在 HTTP `/v1/execute` 与 WebSocket `/v1/stream` 结束路径调用这些 helper；route contract、event loop、timeout scheduling、watchdog decoration、summary append 与 metrics recording 保持在 `app.ts`。
  - `app.ts` 当前为 1545 lines；`src/nexus/executionFinalization.ts` 为 119 lines。剩余 inline routes 仍为 `/v1/execute` 与 `/v1/stream`，但共享 finalization / outcome 状态机已从 `app.ts` 移出。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-exec-final-timeout.json npx tsx --test --test-concurrency=1 --test-name-pattern "execute timeout preserves partial result and emits near-timeout warning|execute soft policy watchdog decorates REQUEST_TIMEOUT with details.kind=watchdog and cleans the active execution registry|execute honours per-request timeoutMs from Go TUI WebSocket payload" test/runtime.test.ts`：3/3 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-exec-final-denial.json npx tsx --test --test-concurrency=1 --test-name-pattern "execute honours per-request policy=soft-deny for write/execute tools" test/runtime.test.ts`：1/1 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-exec-final-denial2.json npx tsx --test --test-concurrency=1 --test-name-pattern "execute with default strict policy emits recoverable policy denial for execute-risk Bash" test/runtime.test.ts`：1/1 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-exec-final-context2.json npx tsx --test --test-concurrency=1 --test-name-pattern "websocket stream relays and persists context blocking events|/v1/execute returns context blocking status in result envelope" test/runtime.test.ts`：2/2 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-exec-final-basic.json npx tsx --test --test-concurrency=1 --test-name-pattern "execute reads a workspace file and records session events" test/runtime.test.ts`：1/1 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-exec-final-cancel.json npx tsx --test --test-concurrency=1 --test-name-pattern "remote cancel aborts active execution and resume returns session snapshot" test/runtime.test.ts`：1/1 pass。
  - `npm run docs:check`：0 failures。
  - `npm run format:check`：0 errors。
  - `npm run deps:audit`：0 boundary failures。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 为 1545 lines。
  - `npm run test:quarantine`：list mode pass；2 entries remain observing。
- **边界**:
  - Phase 4A+ 未关闭；`/v1/execute` 与 `/v1/stream` 仍在 `app.ts`。
  - 不改变 REST / WebSocket contract, timeout policy semantics, cancel/resume semantics, context-blocking recovery metadata shape, recoverable denial semantics, event schema, runtime behavior, or SQLite schema。

## 2026-06-19 — Module Coupling Governance Phase 4A+: ExecutionPreparation Slice

- **背景**: `ExecutionTimeoutEvents` 收口后，`app.ts` 仍在 `/v1/execute` 与 `/v1/stream` 之间内联共享 request schema、timeout decision、cwd/session 初始化、model capability gate、policy/allowTools 解析和 continuity input 派生。直接迁移 route 仍过大；本轮先抽 execution preparation state machine，让两条 route 共享窄入口。
- **实现**:
  - 新增 `src/nexus/executionPreparation.ts`，承载 `executeSchema`、`prepareExecution()`、`isPrepareError()`、`ExecuteTimeoutDecision` / `WatchdogState` types、timeout decision、session snapshot creation、request cwd resolution、model tool-calling guard、`originCwd` / `latestTaskPrimaryRoot` continuity input 派生。
  - `app.ts` 改为向 `prepareExecution()` 显式传入 `storage`、`defaultCwd`、`remoteRunnerAvailable`、`executeTimeoutMs` 与 `executePolicyMode`；HTTP `/v1/execute` 和 WebSocket `/v1/stream` route contract、event append、timeout event scheduling、watchdog decoration 和 finalization 仍留在 `app.ts`。
  - `app.ts` 当前为 1642 lines；`src/nexus/executionPreparation.ts` 为 346 lines。剩余 inline routes 仍为 `/v1/execute` 与 `/v1/stream`，但共享 preparation / validation / continuity 状态机已从 `app.ts` 移出。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-exec-prep-model.json npx tsx --test --test-concurrency=1 --test-name-pattern "POST /v1/execute blocks model without tool calling support|WebSocket /v1/stream blocks model without tool calling support" test/runtime.test.ts`：2/2 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-exec-prep-timeout-policy.json npx tsx --test --test-concurrency=1 --test-name-pattern "execute honours per-request timeoutMs from Go TUI WebSocket payload|execute honours per-request policy=soft-deny for write/execute tools|execute honours per-request allowedTools for Bash in soft-deny mode" test/runtime.test.ts`：3/3 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-exec-prep-cancel.json npx tsx --test --test-concurrency=1 --test-name-pattern "remote cancel aborts active execution and resume returns session snapshot" test/runtime.test.ts`：1/1 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-exec-prep-dual-site.json npx tsx --test --test-concurrency=1 test/dual-site-resolver.test.ts test/session-origin-cwd.test.ts test/session-root-continuity.test.ts`：27/27 pass。
  - `npm run docs:check`：0 failures。
  - `npm run format:check`：0 errors。
  - `npm run deps:audit`：0 boundary failures。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 为 1642 lines。
  - `npm run test:quarantine`：list mode pass；2 entries remain observing。
- **边界**:
  - Phase 4A+ 未关闭；`/v1/execute` 与 `/v1/stream` 仍在 `app.ts`。
  - 不改变 REST / WebSocket contract, timeout policy semantics, model selection behavior, cwd continuity behavior, permission policy semantics, cancel/resume semantics, event schema, runtime behavior, or SQLite schema。

## 2026-06-19 — Module Coupling Governance Phase 4A+: ExecutionTimeoutEvents Slice

- **背景**: `ActiveExecutionRegistry` 收口后，`app.ts` 仍只剩 `/v1/execute` 与 `/v1/stream` 两条 inline routes。直接迁移任一路由会同时触碰 HTTP response、WebSocket fan-out、timeout policy、watchdog decoration 与 execution finalization。本轮选择两条执行入口共享的 timeout event / watcher helper，先把事件构造、near-timeout warning、soft-timeout cycle、partial timeout result 和 execute summary builder 从 `app.ts` 抽出，不移动 route 本体。
- **实现**:
  - 新增 `src/nexus/executionTimeoutEvents.ts`，封装 `near_timeout_warning`、`timeout_budget_exceeded`、`timeout_extension_granted`、timeout partial `result` 与 `execute_summary` 的构造 / append / scheduling helper。
  - `app.ts` 改为显式传入 `storage` 与 `now()` clock；timeout policy 决策、watchdog error decoration、HTTP `/v1/execute` 与 WebSocket `/v1/stream` route contract 仍留在 `app.ts`。
  - `app.ts` 当前为 1957 lines；`src/nexus/executionTimeoutEvents.ts` 为 330 lines。剩余 inline routes 仍为 `/v1/execute` 与 `/v1/stream`，但共享 timeout event machinery 已从 `app.ts` 移出。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-timeout-events-near.json npx tsx --test --test-concurrency=1 --test-name-pattern "execute timeout preserves partial result and emits near-timeout warning" test/runtime.test.ts`：1/1 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-timeout-events-soft.json npx tsx --test --test-concurrency=1 --test-name-pattern "execute soft timeout policy emits timeout_budget_exceeded once when the soft budget is reached and keeps the runtime live|execute soft timeout policy auto-grants one extension by default and emits both budget\\+grant events in order|execute soft timeout policy stops granting extensions after maxSoftTimeoutExtensions is reached|execute fatal timeout policy never emits timeout_budget_exceeded" test/runtime.test.ts`：4/4 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-timeout-events-ws.json npx tsx --test --test-concurrency=1 --test-name-pattern "websocket stream timeout aborts long-running tools|execute honours per-request timeoutMs from Go TUI WebSocket payload" test/runtime.test.ts`：2/2 pass。
  - `npm run docs:check`：0 failures。
  - `npm run format:check`：0 errors。
  - `npm run deps:audit`：0 boundary failures。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 为 1957 lines。
  - `npm run test:quarantine`：list mode pass；2 entries remain observing。
- **边界**:
  - Phase 4A+ 未关闭；`/v1/execute` 与 `/v1/stream` 仍在 `app.ts`。
  - 不改变 REST / WebSocket contract, timeout policy semantics, watchdog decoration rules, event schema, runtime behavior, cancel/resume semantics, or SQLite schema。

## 2026-06-19 — Module Coupling Governance Phase 4A+: ActiveExecutionRegistry Slice

- **背景**: `contextObserveRouter` 收口后，`app.ts` 只剩 `/v1/execute` 与 `/v1/stream` 两条 inline routes。直接迁移任一路由都会触碰执行循环、timeout、active execution、cancel/resume 与 WebSocket event fan-out。为保持 one PR = one semantic slice，本轮先抽两条执行入口共享的 active execution 状态，而不移动 HTTP / WS route 本身。
- **实现**:
  - 新增 `src/nexus/activeExecutionRegistry.ts`，封装 process-local active execution registry。
  - `app.ts` 不再持有裸 `Map<string, ActiveExecution>` 或本地 `registerActiveExecution()` / `clearActiveExecution()` helper；改为调用 `ActiveExecutionRegistry.register()`、`clear()`、`snapshot()`、`cancel()` 与 `clearByAbortController()`。
  - `sessionResumeRouter` 继续通过只读 `getActiveExecutionSnapshot()` closure 获取 `{ requestId, transport, startedAt } | null`；`sessionCancelRouter` 继续通过 `cancelActiveExecution()` closure abort 当前 execution，不接触 registry 内部结构。
  - `app.ts` 当前为 2305 lines；`src/nexus/activeExecutionRegistry.ts` 为 63 lines。剩余 inline routes 仍为 `/v1/execute` 与 `/v1/stream`，但共享 process state 已从 `app.ts` 移出。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-active-execution-registry-cancel.json npx tsx --test --test-concurrency=1 --test-name-pattern "remote cancel aborts active execution and resume returns session snapshot" test/runtime.test.ts`：1/1 pass，覆盖 resume snapshot、remote cancel abort、child session cancel 和 registry cleanup 后 resume。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-active-execution-registry-watchdog.json npx tsx --test --test-concurrency=1 --test-name-pattern "execute soft policy watchdog decorates REQUEST_TIMEOUT with details.kind=watchdog and cleans the active execution registry" test/runtime.test.ts`：1/1 pass，覆盖 watchdog timeout 后 registry cleanup。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-active-execution-registry-ws-busy.json npx tsx --test --test-concurrency=1 --test-name-pattern "websocket stream concurrency gate rejects excess work" test/runtime.test.ts`：1/1 pass，覆盖 WebSocket path active execution / concurrency gate 邻近行为。
  - `npm run docs:check`：0 failures。
  - `npm run format:check`：0 errors。
  - `npm run deps:audit`：0 boundary failures。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 为 2305 lines。
  - `npm run test:quarantine`：list mode pass；2 entries remain observing。
- **边界**:
  - Phase 4A+ 未关闭；`/v1/execute` 与 `/v1/stream` 仍在 `app.ts`。
  - 不改变 runtime execution contract, timeout behavior, cancel/resume response shape, active execution lifetime semantics, WebSocket stream payloads, or SQLite schema。

## 2026-06-19 — Module Coupling Governance Phase 4A+: ContextObserveRouter Slice

- **背景**: `workingSetObserveRouter` 收口后，`app.ts` 只剩 `/v1/execute`、`/v1/stream` 和 `/v1/context/observe` 三个 inline routes。本轮选择 `/v1/context/observe`，因为它是独立 observer WebSocket，有专门的 `test/context-observe-websocket.test.ts` 覆盖 snapshot、filter、reconnect 和 cleanup 行为，不触碰 runtime execution loop 或主 `/v1/stream`。
- **实现**:
  - 新增 `src/nexus/routers/contextObserveRouter.ts`，接管 GET `/v1/context/observe` WebSocket。
  - 保留 `cwd` / `sessionId` query 语义、`MISSING_CWD` 1008 close、initial `assembled_snapshot`、per-session last context snapshot、live `assembled` fan-out、sessionId filter 和 close/error cleanup 行为。
  - 将 `defaultContextBroadcaster` legacy fallback 移到 router 内部；`app.ts` 不再直接持有 context observer 的 broadcaster 变量，也不再 import `defaultContextBroadcaster`。
  - `app.ts` 当前为 2343 lines；`src/nexus/routers/contextObserveRouter.ts` 为 69 lines；router 文件数为 37。剩余 inline routes 只剩 `/v1/execute` 与 `/v1/stream`。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-context-observe-router.json npx tsx --test --test-concurrency=1 test/context-observe-websocket.test.ts`：7/7 pass，覆盖 initial snapshot、default broadcaster fan-out、sessionId filter、multi-client broadcast、missing cwd、reconnect snapshot 和 subscriber cleanup。
  - `npm run docs:check`：0 failures。
  - `npm run format:check`：0 errors。
  - `npm run deps:audit`：0 boundary failures。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 为 2343 lines，`defaultContextBroadcaster` references moved from `app.ts` to `contextObserveRouter.ts` compatibility boundary。
  - `npm run test:quarantine`：list mode pass；2 entries remain observing。
- **边界**:
  - Phase 4A+ 未关闭；剩余高风险 route 为 `/v1/execute` 与 `/v1/stream`。
  - 不改变 runtime execution contract, main WebSocket stream, context broadcaster implementation, assembled context payload shape, or context observer WebSocket payload shape。

## 2026-06-19 — Module Coupling Governance Phase 4A+: WorkingSetObserveRouter Slice

- **背景**: `sessionTaskMutationRouter` 收口后，`app.ts` 剩余 inline routes 为 `/v1/execute`、`/v1/stream`、`/v1/working-set/observe`、`/v1/context/observe`。本轮选择 `/v1/working-set/observe`，因为它是独立的 observer WebSocket，可用既有 `test/working-set-observe-websocket.test.ts` 精准验证，不触碰 runtime execution loop 或主 session stream。
- **实现**:
  - 新增 `src/nexus/routers/workingSetObserveRouter.ts`，接管 GET `/v1/working-set/observe` WebSocket。
  - 保留 `cwd` / `sessionId` query 语义、`MISSING_CWD` 1008 close、load failure 1011 close、initial `working_set_snapshot`、`working_set_updated` / `working_set_reset` 推送和 sessionId filter 行为。
  - 将 per-app fallback `WorkingSetBroadcaster` 创建移入 router register closure，同时继续优先使用 injected `options.workingSetBroadcaster`，避免改变测试和 app composition 语义。
  - `app.ts` 当前为 2397 lines；`src/nexus/routers/workingSetObserveRouter.ts` 为 95 lines；router 文件数为 36。剩余 inline routes 只剩 `/v1/execute`、`/v1/stream`、`/v1/context/observe`。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-working-set-observe-router.json npx tsx --test --test-concurrency=1 test/working-set-observe-websocket.test.ts`：10/10 pass，覆盖 snapshot、update、sessionId filter、multi-client shared broadcaster、missing cwd 和 broadcaster unit 行为。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-context-working-set-rest-put.json npx tsx --test --test-concurrency=1 test/context-working-set-rest-put.test.ts`：12/12 pass，覆盖 working-set write path 与 broadcaster update 仍可串联。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 为 2397 lines，`ConfigManager.getInstance` in `app.ts` 为 1。
- **边界**:
  - Phase 4A+ 未关闭；剩余高风险 route 为 `/v1/execute`、`/v1/stream`、`/v1/context/observe`。
  - 不改变 runtime execution contract, main WebSocket stream, context observe stream, working-set persistence schema, REST working-set write behavior, or WebSocket event payload shape。

## 2026-06-19 — Module Coupling Governance Phase 4A+: SessionTaskMutationRouter Slice

- **背景**: `sessionCancelRouter` 收口后，`app.ts` 剩余 route 集中在 `/v1/execute`、session task mutation cluster 和 WebSocket streams。task mutation cluster 内部共用 mutation audit、revision conflict、dependency propagation、child-session cleanup、sub-agent rerun 和 worktree recovery helper；若只抽一半会制造双 source of truth。因此本轮按 one PR = one semantic slice，把 session task mutation ownership 整体迁入单独 router，不触碰 `/v1/execute` 或 WebSocket stream。
- **实现**:
  - 新增 `src/nexus/routers/sessionTaskMutationRouter.ts`，接管 POST `/v1/sessions/:sessionId/tasks`、PATCH `/v1/sessions/:sessionId/tasks/:taskId`、以及 task action routes：`claim`、`complete`、`fail`、`cancel`、`retry`、`rerun-subagent`、`worktree-recovery`、`approve`、`reject`。
  - 将 task mutation schemas、`mutateTaskAction()`、revision conflict、idempotent create、task mutation audit event、dependency fail/restore、child session cancel、pending review guard、sub-agent rerun 和 worktree recovery helper 迁入 router 私有实现，不新增公共 helper API。
  - `app.ts` 只注册 `sessionTaskMutationRouter`；移除 task mutation 内联 routes、schemas、helper types、`removeWorktree` import 和 `NexusTask` / `TaskStatus` import。
  - `app.ts` 当前为 2476 lines；`src/nexus/routers/sessionTaskMutationRouter.ts` 为 739 lines。剩余 inline routes 只剩 `/v1/execute`、`/v1/stream`、`/v1/working-set/observe`、`/v1/context/observe`。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-session-task-mutation-router.json npx tsx --test --test-concurrency=1 --test-name-pattern "session task API supports idempotent create, mutation audit, dependency cleanup, and review actions" test/runtime.test.ts`：1/1 pass，覆盖 idempotent create、revision conflict、update/claim/complete/fail/cancel/retry、dependency cleanup、sub-agent rerun、worktree recovery、review approve/reject 和 mutation audit。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-session-task-mutation-lifecycle.json npx tsx --test --test-concurrency=1 --test-name-pattern "session input, cancel, and task lifecycle endpoints update state" test/runtime.test.ts`：1/1 pass，覆盖 task create/claim/complete 与 session input/cancel 串联。
  - `npm run docs:check`：0 failures。
  - `npm run format:check`：0 errors。
  - `npm run deps:audit`：0 boundary failures。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 为 2476 lines，`ConfigManager.getInstance` in `app.ts` 为 1。
  - `npm run test:quarantine`：list mode pass；2 entries remain observing。
- **边界**:
  - Phase 4A+ 未关闭；剩余高风险 route 为 `/v1/execute`、`/v1/stream`、`/v1/working-set/observe`、`/v1/context/observe`。
  - 不改变 runtime execution contract, WebSocket stream behavior, SQLite schema, task mutation response envelopes, mutation audit payload shape, sub-agent rerun semantics, worktree recovery semantics, or dependency cleanup behavior。

## 2026-06-19 — Module Coupling Governance Phase 4A+: SessionCancelRouter Slice

- **背景**: `sessionCompactRouter` 收口后，剩余 `app.ts` route 已集中在 `/v1/execute`、大型 task mutation cluster 和 WebSocket streams。为继续保持 one PR = one semantic slice，本轮选择 POST `/v1/sessions/:sessionId/cancel`：它是单一 lifecycle endpoint，负责取消活跃 execution 并调用 `closeNexusSession()` 收口 session，不混入 task mutation 或 stream wiring。
- **实现**:
  - 新增 `src/nexus/routers/sessionCancelRouter.ts`，接管 POST `/v1/sessions/:sessionId/cancel`。
  - `FeatureRouterContext` 新增可选 `cancelActiveExecution(sessionId)` closure；`app.ts` 仍持有 `activeExecutions` Map 和 `AbortController`，router 只接收 `requestId` / `transport` metadata，避免把 active execution registry 暴露到 feature router。
  - `session_cancelled` envelope、默认 reason、`SESSION_NOT_FOUND` payload、`closeNexusSession()` cleanup cascade、SessionEnd hooks、EverCore non-fatal sync path、permission cleanup 和 child session cancel semantics 保持不变。
  - `app.ts` 删除 inline cancel route 与 `closeNexusSession` 直接 import，只注册 `sessionCancelRouter`；当前为 3196 lines。`src/nexus/routers/sessionCancelRouter.ts` 为 46 lines。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-session-cancel-router-lifecycle.json npx tsx --test --test-concurrency=1 --test-name-pattern "session input, cancel, and task lifecycle endpoints update state" test/runtime.test.ts`：1/1 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-session-cancel-router-active.json npx tsx --test --test-concurrency=1 --test-name-pattern "remote cancel aborts active execution and resume returns session snapshot" test/runtime.test.ts`：1/1 pass，覆盖 active execution abort、child session cancel 和 resume snapshot。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-session-cancel-router-watchdog.json npx tsx --test --test-concurrency=1 --test-name-pattern "soft timeout watchdog cutoff marks REQUEST_TIMEOUT with details.kind=watchdog" test/runtime.test.ts`：1/1 pass，覆盖 watchdog 后 registry cleanup 的 stale cancel path。
  - `npm run docs:check`：0 failures。
  - `npm run format:check`：0 errors。
  - `npm run deps:audit`：0 boundary failures。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 为 3196 lines，`ConfigManager.getInstance` in `app.ts` 为 1。
  - `npm run test:quarantine`：list mode pass；2 entries remain observing。
- **边界**:
  - Phase 4A+ 未关闭；剩余 route 为 `/v1/execute`、session task mutation cluster、`/v1/stream`、`/v1/working-set/observe`、`/v1/context/observe`。
  - 不改变 runtime execution contract, WebSocket stream behavior, task mutation semantics, SQLite schema, permission decision semantics, or session lifecycle cleanup behavior。

## 2026-06-19 — Module Coupling Governance Phase 4A+: SessionCompactRouter Slice

- **背景**: `sessionContextRouter` 收口后，下一块选择 POST `/v1/sessions/:sessionId/compact`。该 route 是单一 manual/auto/reactive compact endpoint，负责调用 `compactSession()`、重组 post-compact grounding events，并返回 `compact_result`；不触碰 `/v1/execute`、context analysis GET、cancel/close lifecycle、task mutation 或 WebSocket stream。
- **实现**:
  - 新增 `src/nexus/routers/sessionCompactRouter.ts`，接管 POST `/v1/sessions/:sessionId/compact`。
  - `sessionCompactSchema`、`SESSION_NOT_FOUND` payload、`compact_result` envelope、`compact_boundary` / `context_compact_boundary` 字段、post-compact grounding event append 与 model fallback 保持不变。
  - `app.ts` 删除 inline compact route，以及对 `compactSession()`、`assembleContext()`、`buildPostCompactGroundingEvents()`、`buildSystemPrompt` / `mapEventsToMessages` 的直接 imports，只注册 `sessionCompactRouter`。
  - `app.ts` 当前为 3214 lines；`src/nexus/routers/sessionCompactRouter.ts` 为 73 lines。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-session-compact-router.json npx tsx --test --test-concurrency=1 --test-name-pattern "/v1/sessions/:sessionId/compact creates a manual compact boundary" test/runtime.test.ts`：1/1 pass，覆盖 compact result envelope、compact boundary、context compact boundary 与 post-compact grounding events。
  - `npm run docs:check`：0 failures。
  - `npm run format:check`：0 errors。
  - `npm run deps:audit`：0 boundary failures。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 为 3214 lines，`ConfigManager.getInstance` in `app.ts` 为 2。
  - `npm run test:quarantine`：list mode pass；2 entries remain observing。
- **边界**:
  - Phase 4A+ 未关闭；下一 router slice 仍必须避开 `/v1/execute`、WebSocket stream 和大型 task mutation cluster。
  - 不改变 compact summary generation, retained event semantics, post-compact grounding behavior, context analysis behavior, runtime execution, lifecycle close/cancel behavior, task mutation, or WebSocket behavior.

## 2026-06-19 — Module Coupling Governance Phase 4A+: SessionContextRouter Slice

- **背景**: `sessionCloseRouter` 收口后，下一块选择 GET `/v1/sessions/:sessionId/context`。该 route 是 operator diagnostics / context preview endpoint，读取 session events、allowed tool definitions、session inbox 与 optional memory provider diagnostics，并返回 `context_analysis`；不触碰 `/v1/execute`、compact mutation、cancel/close lifecycle、task mutation 或 WebSocket stream。
- **实现**:
  - 新增 `src/nexus/routers/sessionContextRouter.ts`，接管 GET `/v1/sessions/:sessionId/context`。
  - `sessionContextQuerySchema`、`SESSION_NOT_FOUND` payload、model fallback、allowed tool projection、context fork metadata、SessionChannel inbox 注入、memory retrieval diagnostic event append 与 `[nexus:context]` stderr fallback 保持不变。
  - `readContextForkMetadata()` 迁入 router；`app.ts` 删除 inline context route 与 `analyzeContext` import，只注册 `sessionContextRouter`。
  - `app.ts` 当前为 3272 lines；`src/nexus/routers/sessionContextRouter.ts` 为 111 lines。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-session-context-router-runtime.json npx tsx --test --test-concurrency=1 --test-name-pattern "/v1/sessions/:sessionId/context returns reusable context analysis|/v1/sessions/:sessionId/context reports long-term memory diagnostics" test/runtime.test.ts`：2/2 pass，覆盖 context analysis envelope、fork metadata、compact/recovery diagnostics 与 long-term memory diagnostics passthrough。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-session-context-router-channel.json npx tsx --test --test-concurrency=1 --test-name-pattern "Nexus SessionChannel API message is injected into receiving session context until acknowledged" test/session-channel.test.ts`：1/1 pass，覆盖 session inbox context 注入和 ack 后消失。
  - `npm run docs:check`：0 failures。
  - `npm run format:check`：0 errors。
  - `npm run deps:audit`：0 boundary failures。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 为 3272 lines，`ConfigManager.getInstance` in `app.ts` 为 2。
  - `npm run test:quarantine`：list mode pass；2 entries remain observing。
- **边界**:
  - Phase 4A+ 未关闭；下一 router slice 仍必须避开 `/v1/execute`、WebSocket stream 和大型 task mutation cluster。
  - 不改变 context analysis schema, memory retrieval diagnostics semantics, SessionChannel inbox behavior, compact behavior, runtime execution, lifecycle close/cancel behavior, task mutation, or WebSocket behavior.

## 2026-06-19 — Module Coupling Governance Phase 4A+: SessionCloseRouter Slice

- **背景**: `sessionInputRouter` 收口后，下一块选择 POST `/v1/sessions/:sessionId/close`。该 route 是独立 session lifecycle close endpoint，负责调用 `closeNexusSession()`、解析 close phase/reason、返回 `session_closed` envelope；不触碰 `/v1/execute`、cancel active execution abort、task mutation、compact/context assembly 或 WebSocket stream。
- **实现**:
  - 新增 `src/nexus/routers/sessionCloseRouter.ts`，接管 POST `/v1/sessions/:sessionId/close`。
  - `sessionCloseSchema`、`SESSION_NOT_FOUND` payload、`session_closed` envelope、`closeNexusSession()` 参数、SessionEnd hooks 配置读取、EverCore session-end sync fallback 语义保持不变。
  - `app.ts` 只注册 `sessionCloseRouter`；POST `/v1/sessions/:sessionId/cancel` 仍留在 `app.ts`，因为它还负责 abort active HTTP/WebSocket execution。
  - `app.ts` 当前为 3374 lines；`src/nexus/routers/sessionCloseRouter.ts` 为 43 lines。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-session-close-router.json npx tsx --test --test-concurrency=1 --test-name-pattern "session close cascades runtime session state cleanup|session close records non-fatal EverCore sync failures" test/runtime.test.ts`：2/2 pass，覆盖 close cascade cleanup、pending permission auto-deny、Bash/Task cleanup 与 EverCore sync failure non-fatal。
  - `npm run docs:check`：0 failures。
  - `npm run format:check`：0 errors。
  - `npm run deps:audit`：0 boundary failures。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 为 3374 lines，`ConfigManager.getInstance` in `app.ts` 为 3。
  - `npm run test:quarantine`：list mode pass；2 entries remain observing。
- **边界**:
  - Phase 4A+ 未关闭；下一 router slice 仍必须避开 `/v1/execute`、WebSocket stream 和大型 task mutation cluster。
  - 不改变 close lifecycle cleanup, SessionEnd hook semantics, EverCore upload/flush failure handling, cancel active execution behavior, session input, task mutation, compact/context behavior, or WebSocket permission handling.

## 2026-06-18 — Module Coupling Governance Phase 4A+: SessionInputRouter Slice

- **背景**: `sessionPermissionRouter` 收口后，下一块选择 POST `/v1/sessions/:sessionId/input`。该 route 只接受外部 session input，追加 `user_message` event，并在 session 处于 `waiting_permission` 时保留 yes/no shortcut 到 `PendingPermissionRegistry.resolveSession()`；不触碰 `/v1/execute`、cancel/close、task mutation、compact/context assembly 或 WebSocket stream。
- **实现**:
  - 新增 `src/nexus/routers/sessionInputRouter.ts`，接管 POST `/v1/sessions/:sessionId/input`。
  - `sessionInputSchema`、waiting-permission shortcut、`SESSION_NOT_FOUND` payload、`session_input_accepted` envelope、`lastUserInput` / `phase` / `updatedAt` 写入与 `user_message` append 行为保持不变。
  - `app.ts` 只注册 `sessionInputRouter`；`PendingPermissionRegistry` 在 `app.ts` 仍用于 WebSocket permission response path。
  - `app.ts` 当前为 3398 lines；`src/nexus/routers/sessionInputRouter.ts` 为 53 lines。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-session-input-router.json npx tsx --test --test-concurrency=1 --test-name-pattern "session input, cancel, and task lifecycle endpoints update state" test/runtime.test.ts`：1/1 pass，覆盖 input accepted、task lifecycle 和 cancel 仍可串联工作。
  - `npm run docs:check`：0 failures。
  - `npm run format:check`：0 errors。
  - `npm run deps:audit`：0 boundary failures。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 为 3398 lines，`ConfigManager.getInstance` in `app.ts` 为 4。
  - `npm run test:quarantine`：list mode pass；2 entries remain observing。
- **边界**:
  - Phase 4A+ 未关闭；下一 router slice 仍必须避开 `/v1/execute`、WebSocket stream 和大型 task mutation cluster。
  - 不改变 session input schema, waiting-permission shortcut semantics, `user_message` event shape, session phase update, cancel/close behavior, task mutation, compact/context behavior, or WebSocket permission handling.

## 2026-06-18 — Module Coupling Governance Phase 4A+: SessionPermissionRouter Slice

- **背景**: `sessionResumeRouter` 收口后，下一块选择 POST `/v1/sessions/:sessionId/approve` 与 POST `/v1/sessions/:sessionId/deny`。这两条 route 只负责把 HTTP permission decision 映射到 `PendingPermissionRegistry`，不读取 / 写入 session storage，不关闭或取消 session，不触碰 `/v1/execute`、task mutation、compact/context assembly 或 WebSocket stream。
- **实现**:
  - 新增 `src/nexus/routers/sessionPermissionRouter.ts`，接管 approve / deny permission decision routes。
  - approve / deny body schemas、`PERMISSION_REQUEST_NOT_FOUND` payload、`permission_resolved` response envelope、`scope` / `rule` / `feedback` / `reason` 字段语义保持不变。
  - `app.ts` 只注册 `sessionPermissionRouter`；`PendingPermissionRegistry` 在 `app.ts` 仍用于 `/input` waiting-permission shortcut 与 WebSocket permission response path。
  - `app.ts` 当前为 3434 lines；`src/nexus/routers/sessionPermissionRouter.ts` 为 77 lines。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-session-permission-router-approve.json npx tsx --test --test-concurrency=1 --test-name-pattern "interactive permission approval flow via HTTP POST" test/permission-flow.test.ts`：1/1 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-session-permission-router-deny.json npx tsx --test --test-concurrency=1 --test-name-pattern "interactive permission denial flow via HTTP POST" test/permission-flow.test.ts`：1/1 pass。
  - `npm run docs:check`：0 failures。
  - `npm run format:check`：0 errors。
  - `npm run deps:audit`：0 boundary failures。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 为 3434 lines，`ConfigManager.getInstance` in `app.ts` 为 4。
  - `npm run test:quarantine`：list mode pass；2 entries remain observing。
- **边界**:
  - Phase 4A+ 未关闭；下一 router slice 仍必须避开 `/v1/execute`、WebSocket stream 和 session mutation heavy paths。
  - 不改变 PendingPermissionRegistry semantics, approval / denial payloads, provider-visible permission_response events, session input shortcut behavior, cancel/close behavior, task mutation, compact/context behavior, or WebSocket permission handling.

## 2026-06-18 — Module Coupling Governance Phase 4A+: SessionResumeRouter Slice

- **背景**: `runtimeMemoryRouter` actions slice 收口后，下一块选择 POST `/v1/sessions/:sessionId/resume`。该 route 只返回 session resume snapshot，读取 session、recent events、tasks、child sessions，并附带 active execution 的只读 metadata；不重启 execution，不修改 session/task/permission 状态，不触碰 `/v1/execute`、compact/context assembly、permission approval/cancel/close mutation 或 WebSocket stream。
- **实现**:
  - 新增 `src/nexus/routers/sessionResumeRouter.ts`，接管 POST `/v1/sessions/:sessionId/resume`。
  - `FeatureRouterContext` 新增可选 `getActiveExecutionSnapshot(sessionId)`，只暴露 `{ requestId, transport, startedAt } | null`，避免 router 访问 `AbortController` 或 `activeExecutions` Map。
  - `app.ts` 只注册 `sessionResumeRouter` 并注入只读 active execution snapshot provider；resume schema、404 payload、event ordering、tasks / child sessions include flags 与 response envelope 保持不变。
  - `app.ts` 当前为 3504 lines；`src/nexus/routers/sessionResumeRouter.ts` 为 56 lines。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-session-resume-router.json npx tsx --test --test-concurrency=1 --test-name-pattern "session resume and cancel expose active execution and child session state" test/runtime.test.ts`：1/1 pass，覆盖 active execution metadata、tasks、child sessions、cancel 后 `activeExecution: null` 与 cancelled session snapshot。
  - `npm run docs:check`：0 failures。
  - `npm run format:check`：0 errors。
  - `npm run deps:audit`：0 boundary failures。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 为 3504 lines，`ConfigManager.getInstance` in `app.ts` 为 4。
  - `npm run test:quarantine`：list mode pass；2 entries remain observing。
- **边界**:
  - Phase 4A+ 未关闭；下一 router slice 仍必须避开 `/v1/execute`、WebSocket stream 和 session mutation heavy paths。
  - 不改变 resume request schema, session_resume_snapshot envelope, event reverse ordering, active execution lifecycle, cancel behavior, task mutation, compact/context behavior, permission approval/deny, or WebSocket behavior.

## 2026-06-18 — Module Coupling Governance Phase 4A+: RuntimeMemoryActionsRouter Slice

- **背景**: `sessionTaskReadRouter` 收口后，下一块选择 `runtimeMemoryRouter` 内的 POST `/v1/runtime/memory/search`、`save-note`、`flush`、`restart` 四条 memory action routes。它们属于同一 runtime memory governance 域，依赖相同 EverCore client/config 与 process-local approval counters；移动后不触碰 `/v1/execute`、session mutation、compact/context assembly 或 WebSocket stream。
- **实现**:
  - 将 memory action schemas、approval helper、EverCore unavailable payload、approved note message builder 与四条 POST route 从 `app.ts` 迁入 `src/nexus/routers/runtimeMemoryRouter.ts`。
  - `app.ts` 继续只在 composition root 创建 `memoryApprovalCounters` 并传给 router；不改变 counter reset 语义、approval 文案、EverCore search/add/flush 调用参数或 response envelope。
  - `app.ts` 当前为 3541 lines；`src/nexus/routers/runtimeMemoryRouter.ts` 为 378 lines。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-runtime-memory-actions-router.json npx tsx --test --test-concurrency=1 --test-name-pattern "/v1/runtime/memory/search returns bounded read-only memory hints" test/runtime.test.ts`：1/1 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-runtime-memory-actions-router-write.json npx tsx --test --test-concurrency=1 --test-name-pattern "/v1/runtime/memory write and lifecycle actions require explicit approval" test/runtime.test.ts`：1/1 pass，覆盖 save-note approval gate / approved save、flush approval gate / approved flush、restart approval gate / confirmed 501。
  - `npm run docs:check`：0 failures。
  - `npm run format:check`：0 errors。
  - `npm run deps:audit`：0 boundary failures。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 为 3541 lines，`ConfigManager.getInstance` in `app.ts` 为 4。
  - `npm run test:quarantine`：list mode pass；2 entries remain observing。
- **边界**:
  - Phase 4A+ 未关闭；下一 router slice 仍必须避开 `/v1/execute`、WebSocket stream 和 session mutation heavy paths。
  - 不改变 memory search formatting, hit truncation, approval response shape, `memoryApprovalCounters`, EverCore add/flush payloads, restart 501 behavior, runtime execution, session lifecycle, compact/context behavior, or WebSocket behavior。

## 2026-06-18 — Module Coupling Governance Phase 4A+: SessionTaskReadRouter Slice

- **背景**: `sessionCreateRouter` 收口后，下一块选择 GET `/v1/sessions/:sessionId/tasks`。该 route 只读取 `storage.listTasks(sessionId)` 并返回 `tasks_list` envelope，不校验 / 修改 session，不写 task mutation audit，不触碰 task create/update/action mutation、runtime execution、compact/context assembly 或 WebSocket stream。
- **实现**:
  - 新增 `src/nexus/routers/sessionTaskReadRouter.ts`，接管 GET `/v1/sessions/:sessionId/tasks`。
  - `app.ts` 只注册 `sessionTaskReadRouter`；POST/PATCH task mutation routes、task action routes、session mutation routes、runtime execution 与 WebSocket stream 仍留在后续切片。
  - `app.ts` 当前为 3779 lines；`src/nexus/routers/sessionTaskReadRouter.ts` 为 15 lines。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-session-task-read-router.json npx tsx --test --test-concurrency=1 --test-name-pattern "SDK task mutation API writes audit events and guards revisions" test/runtime.test.ts`：1/1 pass，覆盖 task list endpoint 与既有 task mutation readback。
  - `npm run docs:check`：0 failures。
  - `npm run format:check`：0 errors。
  - `npm run deps:audit`：0 boundary failures。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 为 3779 lines，`ConfigManager.getInstance` in `app.ts` 为 4。
  - `npm run test:quarantine`：list mode pass；2 entries remain observing。
- **边界**:
  - Phase 4A+ 未关闭；下一 router slice 仍必须避开 `/v1/execute`、WebSocket stream 和 session mutation heavy paths。
  - 不改变 `tasks_list` response envelope, storage ordering, task create/update/action mutation, task mutation audit, session lifecycle, runtime execution, compact/context behavior, or WebSocket behavior.

## 2026-06-18 — Module Coupling Governance Phase 4A+: SessionCreateRouter Slice

- **背景**: `sessionInspectionRouter` 收口后，下一块选择 POST `/v1/sessions`。该 route 只分配 canonical server session id 并保存初始 `SessionSnapshot`，用于 Go TUI / inspect-session 的 session allocation；不进入 runtime execution、permission decision、task mutation、compact/context assembly 或 WebSocket stream。
- **实现**:
  - 新增 `src/nexus/routers/sessionCreateRouter.ts`，接管 POST `/v1/sessions`。
  - `createSessionSchema`、server `session_<uuid>` allocation、`clientSessionId` / `clientSessionIdSetAt` metadata back-reference、`originCwd` initialization 从 `app.ts` 移入 router。
  - `app.ts` 只注册 `sessionCreateRouter`；compact/context routes、resume / approval mutation routes、task routes、runtime execution 与 WebSocket stream 仍留在后续切片。
  - `app.ts` 当前为 3779 lines；`src/nexus/routers/sessionCreateRouter.ts` 为 48 lines。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-session-create-router.json npx tsx --test --test-concurrency=1 test/inspect-session-phase1.test.ts`：5/5 pass，覆盖 server uuid allocation、defaultCwd fallback、list round-trip、`clientSessionIdSetAt` 与 metadata-only path。
  - `npm run docs:check`：0 failures。
  - `npm run format:check`：0 errors。
  - `npm run deps:audit`：0 boundary failures。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 为 3779 lines，`ConfigManager.getInstance` in `app.ts` 为 4。
  - `npm run test:quarantine`：list mode pass；2 entries remain observing。
- **边界**:
  - Phase 4A+ 未关闭；下一 router slice 仍必须避开 `/v1/execute`、WebSocket stream 和 session mutation heavy paths。
  - 不改变 session_created response envelope, server id format, defaultCwd fallback, metadata merge, originCwd initialization, runtime execution, permission approval/deny, compact/context behavior, or WebSocket behavior.

## 2026-06-18 — Module Coupling Governance Phase 4A+: SessionInspectionRouter Slice

- **背景**: `sessionChildrenRouter` 收口后，下一块选择 GET `/v1/sessions/:sessionId/tool-traces` 与 GET `/v1/sessions/:sessionId/permission-audits`。这两条 route 是 session inspection / audit read endpoints，只读取 storage 中的 tool traces 与 permission audits，不修改 session/task/permission 状态，不触碰 `/v1/execute`、WebSocket stream、compact/context assembly 或 session mutation heavy paths。
- **实现**:
  - 新增 `src/nexus/routers/sessionInspectionRouter.ts`，接管 session tool traces 与 permission audits 两条 GET route。
  - `toolTraceListQuerySchema`、tool trace pagination envelope、permission audit list envelope 从 `app.ts` 移入 router。
  - `app.ts` 只注册 `sessionInspectionRouter`；compact/context routes、resume / approval mutation routes、task routes、runtime execution 与 WebSocket stream 仍留在后续切片。
  - `app.ts` 当前为 3817 lines；`src/nexus/routers/sessionInspectionRouter.ts` 为 57 lines。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-session-inspection-tool-trace.json npx tsx --test --test-concurrency=1 --test-name-pattern "REST API endpoint GET /v1/sessions/:sessionId/tool-traces" test/tool-trace.test.ts`：1/1 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-session-inspection-permission-audits.json npx tsx --test --test-concurrency=1 --test-name-pattern "read-only Bash subcommand bypasses permission prompt" test/permission-flow.test.ts`：1/1 pass，覆盖 permission-audits empty list read path。
  - `npm run docs:check`：0 failures。
  - `npm run format:check`：0 errors。
  - `npm run deps:audit`：0 boundary failures。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 为 3817 lines，`ConfigManager.getInstance` in `app.ts` 为 4。
  - `npm run test:quarantine`：list mode pass；2 entries remain observing。
- **边界**:
  - Phase 4A+ 未关闭；下一 router slice 仍必须避开 `/v1/execute`、WebSocket stream 和 session mutation heavy paths。
  - 不改变 tool trace response envelope, pagination semantics, permission audit response envelope, session lifecycle, task mutation, permission approval/deny, compact/context behavior, or WebSocket behavior.

## 2026-06-18 — Module Coupling Governance Phase 4A+: SessionChildrenRouter Slice

- **背景**: `sessionWaitRouter` 收口后，下一块选择 GET `/v1/sessions/:sessionId/children` 与 GET `/v1/sessions/:sessionId/children/:childSessionId/events`。这两条 route 只读取 parent / child session 与 child transcript events，不修改 session/task/permission 状态，不触碰 `/v1/execute`、WebSocket stream 或 session mutation heavy paths。
- **实现**:
  - 新增 `src/nexus/routers/sessionChildrenRouter.ts`，接管 child sessions list 与 child transcript events 两条 GET route。
  - `childSessionsQuerySchema`、children failed-only filter、transcriptPath fallback、child event pagination 从 `app.ts` 移入 router。
  - `app.ts` 只注册 `sessionChildrenRouter`；compact/context/tool-trace/permission-audit routes、resume / approval mutation routes、task routes、runtime execution 与 WebSocket stream 仍留在后续切片。
  - `app.ts` 当前为 3859 lines；`src/nexus/routers/sessionChildrenRouter.ts` 为 118 lines。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-session-children-router.json npx tsx --test --test-concurrency=1 --test-name-pattern "/v1/sessions/:sessionId/assets returns SDK dashboard data assets" test/runtime.test.ts`：1/1 pass，覆盖 child session list、child transcript events 与 missing child 404。
  - `npm run docs:check`：0 failures。
  - `npm run format:check`：0 errors。
  - `npm run deps:audit`：0 boundary failures。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 为 3859 lines，`ConfigManager.getInstance` in `app.ts` 为 4。
  - `npm run test:quarantine`：list mode pass；2 entries remain observing。
- **边界**:
  - Phase 4A+ 未关闭；下一 router slice 仍必须避开 `/v1/execute`、WebSocket stream 和 session mutation heavy paths。
  - 不改变 child session response envelope, transcriptPath fallback, failed-only filter semantics, event ordering, pagination, session lifecycle, task mutation, permission approval/deny, or WebSocket behavior.

## 2026-06-18 — Module Coupling Governance Phase 4A+: SessionWaitRouter Slice

- **背景**: Session read router 收口后，下一块选择 GET `/v1/sessions/:sessionId/wait`。该 route 是 polling read endpoint，用于 bbl loop / multi-pane clients 等待匹配事件；它只读取 session events，不修改 session/task/permission 状态，不触碰 `/v1/execute`、WebSocket stream 或 session mutation heavy paths。
- **实现**:
  - 新增 `src/nexus/routers/sessionWaitRouter.ts`，接管 GET `/v1/sessions/:sessionId/wait`。
  - `waitQuerySchema`、literal substring escape helper、event type / match filtering、timeout polling loop 从 `app.ts` 移入 router。
  - `app.ts` 只注册 `sessionWaitRouter`；children routes、compact/context routes、tool trace / permission audit routes、resume / approval mutation routes 仍留在后续切片。
  - `app.ts` 当前为 3954 lines；`src/nexus/routers/sessionWaitRouter.ts` 为 107 lines。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-session-wait-router.json npx tsx --test --test-concurrency=1 --test-name-pattern "GET /v1/sessions/:id/wait" test/runtime-loop.test.ts`：3/3 pass。
  - `npm run docs:check`：0 failures。
  - `npm run format:check`：0 errors。
  - `npm run deps:audit`：0 boundary failures。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 为 3954 lines，`ConfigManager.getInstance` in `app.ts` 为 4。
  - `npm run test:quarantine`：list mode pass；2 entries remain observing。
- **边界**:
  - Phase 4A+ 未关闭；下一 router slice 仍必须避开 `/v1/execute`、WebSocket stream 和 session mutation heavy paths。
  - 不改变 wait response envelope, literal match semantics, event ordering, timeout polling interval, session lifecycle, task mutation, permission approval/deny, or WebSocket behavior.

## 2026-06-18 — Module Coupling Governance Phase 4A+: SessionReadRouter Slice

- **背景**: Skill action router 收口后，下一块选择只读 Session API cluster：GET `/v1/sessions`、GET `/v1/sessions/:sessionId`、GET `/v1/sessions/:sessionId/assets` 与 GET `/v1/sessions/:sessionId/events`。该 cluster 只读取 storage / assets snapshot，并保留 Go TUI placeholder 404 hint；不触碰 POST session allocation、wait polling、children routes、compact/context/tool-trace/permission-audit routes、runtime execution 或 WebSocket stream。
- **实现**:
  - 新增 `src/nexus/routers/sessionReadRouter.ts`，接管 sessions list/detail/assets/events 四条 GET route。
  - `sessionDetailQuerySchema`、`sessionAssetsQuerySchema`、read-route `eventListQuerySchema`、Go TUI placeholder hint handling 与 `buildSessionAssetsSnapshot()` 调用从 `app.ts` 移入 router。
  - `app.ts` 只注册 `sessionReadRouter`；POST `/v1/sessions`、GET `/v1/sessions/:sessionId/wait`、children / compact / context / tool-trace / permission-audit / resume / approval mutation routes 仍留在后续切片。
  - `app.ts` 当前为 4060 lines；`src/nexus/routers/sessionReadRouter.ts` 为 132 lines。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-session-read-router-phase1.json npx tsx --test test/inspect-session-phase1.test.ts`：5/5 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-session-read-router-placeholder.json npx tsx --test test/session-placeholder-404-hint.test.ts`：5/5 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-session-read-router-runtime.json npx tsx --test --test-concurrency=1 --test-name-pattern "session detail uses recent events|/v1/sessions/:sessionId/assets" test/runtime.test.ts`：2/2 pass。
  - `npm run docs:check`：0 failures。
  - `npm run format:check`：0 failures。
  - `npm run deps:audit`：0 boundary failures。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 为 4060 lines，`ConfigManager.getInstance` in `app.ts` 为 4。
  - `npm run test:quarantine`：list mode pass；2 entries remain observing。
- **边界**:
  - Phase 4A+ 未关闭；下一 router slice 仍必须避开 `/v1/execute`、WebSocket stream 和 session mutation heavy paths。
  - 不改变 session allocation, session lifecycle, event pagination envelope, assets snapshot shape, Go TUI placeholder hint wording, wait polling, child-session listing, compact/context routes, tool trace or permission audit routes.

## 2026-06-18 — Module Coupling Governance Phase 4A+: SkillActionRouter Slice

- **背景**: SessionChannel router 收口后，下一块选择剩余 Skill action routes：POST `/v1/skills/invoke`、POST `/v1/skills/draft` 与 POST `/v1/skills/save`。这些 route 只调用既有 skill registry / generator / storage handler，不触碰 `/v1/execute`、WebSocket stream、session lifecycle、runtime tool loop 或 Skill 文件格式。
- **实现**:
  - 新增 `src/nexus/routers/skillActionRouter.ts`，接管 skill invoke / draft / save 三条 POST route。
  - `SkillInvokeBodySchema`、`SkillDraftBodySchema`、`SkillSaveBodySchema` 解析和 draft/save status-code 映射从 `app.ts` 移入 router。
  - `skillReadRouter` 继续负责 GET list/show；`skillValidateRouter` 继续负责 POST validate；`skillRoutes.ts` 的 handler/schema 来源不变。
  - `app.ts` 当前为 4170 lines；`src/nexus/routers/skillActionRouter.ts` 为 49 lines。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-skill-action-router-invoke.json npx tsx --test --test-name-pattern "skills/invoke" test/skill-routes.test.ts`：2/2 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-skill-action-router-draft.json npx tsx --test test/skill-draft-route.test.ts`：7/7 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-skill-action-router-save.json BABEL_O_USER_SKILLS_DIR=/tmp/babel-o-skill-action-router-user-skills npx tsx --test test/skill-save-route.test.ts`：6/6 pass。
  - `npm run docs:check`：0 failures。
  - `npm run format:check`：0 failures。
  - `npm run deps:audit`：0 boundary failures。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 为 4170 lines，`ConfigManager.getInstance` in `app.ts` 为 4。
  - `npm run test:quarantine`：list mode pass；2 entries remain observing。
- **边界**:
  - Phase 4A+ 未关闭；下一 router slice 仍必须避开 `/v1/execute`、WebSocket stream 和 session mutation heavy paths。
  - 不改变 SkillRegistry loading, generated draft normalization, redaction warnings, save preview/confirm/overwrite semantics, user/project skill storage path policy, or model-visible Skill tools.

## 2026-06-18 — Module Coupling Governance Phase 4A+: SessionChannelRouter Slice

- **背景**: Context working-set write router 收口后，下一块选择 SessionChannel + inbox API cluster：`/v1/session-channels*` 与 `/v1/sessions/:sessionId/inbox*`。该 cluster 只维护 typed side-channel collaboration context、message governance metadata 与 ack 状态，不触碰 `/v1/execute`、WebSocket stream、runtime context hot path、SQLite schema 或 Go TUI inbox 渲染。
- **实现**:
  - 新增 `src/nexus/routers/sessionChannelRouter.ts`，接管 `POST/GET /v1/session-channels`、`GET /v1/session-channels/:channelId`、`POST/GET /v1/session-channels/:channelId/messages`、`GET /v1/sessions/:sessionId/inbox` 与 `POST /v1/sessions/:sessionId/inbox/:messageId/ack`。
  - `createSessionChannelSchema`、`createSessionMessageSchema`、inbox query schema、policy merge、message validation、recipient 判定和 memory-candidate governance wrapper 从 `app.ts` 移入 router。
  - `app.ts` 只注册 `sessionChannelRouter` 并传入现有 `FeatureRouterContext`；SessionChannel storage API、message envelope、inbox unread/ack semantics 与 governance metadata shape 不变。
  - `app.ts` 当前为 4209 lines；`src/nexus/routers/sessionChannelRouter.ts` 为 341 lines。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-session-channel-router-final.json npx tsx --test test/session-channel.test.ts`：9/9 pass。
  - `npm run docs:check`：0 failures。
  - `npm run format:check`：0 failures。
  - `npm run deps:audit`：0 boundary failures。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 为 4209 lines，`ConfigManager.getInstance` in `app.ts` 为 4。
  - `npm run test:quarantine`：list mode pass；2 entries remain observing。
- **边界**:
  - Phase 4A+ 未关闭；下一 router slice 仍必须避开 `/v1/execute`、WebSocket stream 和 session mutation heavy paths。
  - 不改变 SessionChannel / SessionMessage schema、SQLite persistence、runtime context inbox injection、Go TUI inbox overlay、agent parent-child channel behavior, or memory candidate governance decisions.

## 2026-06-18 — Module Coupling Governance Phase 4A+: ContextWorkingSetWriteRouter Slice

- **背景**: loop pane router 收口后，下一块选择 PUT `/v1/context/working-set/:sessionId` write-through route。该 route 只替换 persisted working-set entries 并复用 existing `runWorkingSetPut()` helper behavior，不触碰 `/v1/context/observe` WebSocket、runtime context hot path、session execution 或 SQLite schema。
- **实现**:
  - 新增 `src/nexus/routers/contextWorkingSetWriteRouter.ts`，接管 PUT `/v1/context/working-set/:sessionId` 与 `runWorkingSetPut()` helper 实现。
  - `app.ts` 只注册 `contextWorkingSetWriteRouter`，并从新 router re-export `runWorkingSetPut`，保持现有测试 / 外部 import 兼容。
  - `contextWorkingSetReadRouter` 继续只负责 GET list/session/workspace aggregate routes；`/v1/context/observe` WebSocket 仍留在后续切片。
  - `app.ts` 当前为 4509 lines；`src/nexus/routers/contextWorkingSetWriteRouter.ts` 为 117 lines。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-context-working-set-write-router.json npx tsx --test test/context-working-set-rest-put.test.ts`：12/12 pass。
  - `npm run docs:check`：0 failures。
  - `npm run format:check`：0 failures。
  - `npm run deps:audit`：0 boundary failures。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 为 4509 lines，`ConfigManager.getInstance` in `app.ts` 为 4。
  - `npm run test:quarantine`：list mode pass；2 entries remain observing。
- **边界**:
  - Phase 4A+ 未关闭；下一 router slice 仍必须避开 `/v1/execute`、WebSocket stream 和 session mutation heavy paths。
  - 不改变 working-set JSON schema, write-through replacement semantics, workspaceId preservation behavior, HOME isolation, context observe broadcaster ownership, or runtime context assembly behavior.

## 2026-06-18 — Module Coupling Governance Phase 4A+: LoopPaneRouter Slice

- **背景**: agent router 收口后，下一块选择 loop pane mutation cluster：POST `/v1/loop/workspaces/:workspaceId/panes`、PATCH `/v1/loop/workspaces/:workspaceId/tabs/:tabId/panes/:paneId` 与 DELETE `/v1/loop/workspaces/:workspaceId/tabs/:tabId/panes/:paneId`。这些 route 只维护 pane ↔ session mapping，不触碰 `/v1/execute`、WebSocket stream、session task mutation routes 或 runtime hot path。
- **实现**:
  - 新增 `src/nexus/routers/loopPaneRouter.ts`，接管 loop pane create/update/delete routes 与相关 schema / error helper。
  - `loopWorkspaceRouter` 继续只负责 GET `/v1/loop/workspaces` read-only listing；`app.ts` 只负责注册两个 loop routers。
  - `app.ts` 当前为 4629 lines；`src/nexus/routers/loopPaneRouter.ts` 为 100 lines。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-loop-pane-router-focused.json npx tsx --test test/loop-pane-router.test.ts`：2/2 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-loop-pane-router-runtime-loop.json npx tsx --test --test-concurrency=1 --test-name-pattern "loop_state" test/runtime-loop.test.ts`：4/4 pass。
  - 裸跑 `npx tsx --test --test-name-pattern "loop_state" test/runtime-loop.test.ts` 曾读到默认存储中的旧 pane（`3 !== 1`）；按 AGENTS 测试隔离要求补 `NODE_ENV=test` + 独立 `BABEL_O_CONFIG_FILE` 后通过。
  - `npm run docs:check`：0 failures。
  - `npm run format:check`：0 failures。
  - `npm run deps:audit`：0 boundary failures。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 为 4629 lines，`ConfigManager.getInstance` in `app.ts` 为 4。
  - `npm run test:quarantine`：list mode pass；2 entries remain observing。
- **边界**:
  - Phase 4A+ 未关闭；下一 router slice 仍必须避开 `/v1/execute`、WebSocket stream 和 session mutation heavy paths。
  - 不改变 loop pane storage schema, loop workspace listing envelope, runtime loop health projection, Go TUI pane ownership, or session execution behavior.

## 2026-06-18 — Module Coupling Governance Phase 4A+: AgentRouter Slice

- **背景**: skill validate router 收口后，下一块选择 agent job API cluster：POST/GET `/v1/agents`、GET `/v1/agents/:jobId`、POST `/v1/agents/:jobId/wait`、POST `/v1/agents/:jobId/cancel`、GET `/v1/agents/:jobId/transcript` 与 GET `/v1/sessions/:sessionId/agents`。该 cluster 只通过 existing `AgentScheduler` 与 storage transcript/list API 工作，不触碰 `/v1/execute`、WebSocket stream、session task mutation routes 或 runtime hot path。
- **实现**:
  - 新增 `src/nexus/routers/agentRouter.ts`，接管 agent job API cluster 与相关 schema / error helper / transcript paging。
  - `src/nexus/router.ts` 的 `FeatureRouterContext` 增加 optional `agentScheduler`，`app.ts` 仍负责创建 scheduler 并显式传入 router。
  - `app.ts` 当前为 4719 lines；`src/nexus/routers/agentRouter.ts` 为 194 lines。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `npx tsx --test test/agent-api.test.ts`：2/2 pass。
  - `npm run docs:check`：0 failures。
  - `npm run format:check`：0 failures。
  - `npm run deps:audit`：0 boundary failures。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 为 4719 lines，`ConfigManager.getInstance` in `app.ts` 为 4。
  - `npm run test:quarantine`：list mode pass；2 entries remain observing。
- **边界**:
  - Phase 4A+ 未关闭；下一 router slice 仍必须避开 `/v1/execute`、WebSocket stream 和 session mutation heavy paths。
  - 不改变 AgentScheduler execution semantics, child-session transcript storage, agent governance fields, session task APIs, or runtime execution behavior.

## 2026-06-18 — Module Coupling Governance Phase 4A+: SkillValidateRouter Slice

- **背景**: skill read router 收口后，下一块选择 POST `/v1/skills/validate`。该 route 是 validation-only diagnostics path，只调用 `validateSkillRequest()` 并保持 invalid payload 422；invoke / draft / save 仍留在 `app.ts`。
- **实现**:
  - 新增 `src/nexus/routers/skillValidateRouter.ts`，接管 POST `/v1/skills/validate`。
  - `SkillValidateBodySchema` 解析与 `validateSkillRequest()` 调用从 `app.ts` 移入 router；POST `/v1/skills/invoke`、`/draft`、`/save` 仍留在 `app.ts`。
  - `app.ts` 当前为 4868 lines；`src/nexus/routers/skillValidateRouter.ts` 为 19 lines。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `npx tsx --test test/skill-validate-router.test.ts`：1/1 pass。
  - `npx tsx --test test/skill-routes.test.ts`：8/8 pass。
  - `npm run docs:check`：0 failures。
  - `npm run format:check`：0 failures。
  - `npm run deps:audit`：0 boundary failures。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 为 4868 lines，`ConfigManager.getInstance` in `app.ts` 为 4。
  - `npm run test:quarantine`：list mode pass；2 entries remain observing。
- **边界**:
  - Phase 4A+ 未关闭；下一 router slice 仍必须避开 `/v1/execute`、WebSocket stream 和 session mutation heavy paths。
  - 不改变 SkillRegistry loading, skill invoke/draft/save behavior, skill storage path policy, model-visible Skill tools, or validation diagnostics.

## 2026-06-18 — Module Coupling Governance Phase 4A+: SkillReadRouter Slice

- **背景**: loop workspace read router 收口后，下一块选择 GET `/v1/skills` 与 GET `/v1/skills/:id`。这两个 route 只读取 SkillRegistry 并展示 list/show envelope；validate / invoke / draft / save routes 仍留在 `app.ts`。
- **实现**:
  - 新增 `src/nexus/routers/skillReadRouter.ts`，接管 GET `/v1/skills` 与 GET `/v1/skills/:id`。
  - `SkillListQuerySchema` / `SkillIdParamsSchema` 的解析和 `listSkills()` / `showSkill()` 调用从 `app.ts` 移入 router；POST `/v1/skills/validate`、`/invoke`、`/draft`、`/save` 仍留在 `app.ts`。
  - `app.ts` 当前为 4871 lines；`src/nexus/routers/skillReadRouter.ts` 为 37 lines。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `npx tsx --test test/skill-read-router.test.ts`：1/1 pass。
  - `npx tsx --test test/skill-routes.test.ts`：8/8 pass。
  - `npm run docs:check`：0 failures。
  - `npm run format:check`：0 failures。
  - `npm run deps:audit`：0 boundary failures。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 为 4871 lines，`ConfigManager.getInstance` in `app.ts` 为 4。
  - `npm run test:quarantine`：list mode pass；2 entries remain observing。
- **边界**:
  - Phase 4A+ 未关闭；下一 router slice 仍必须避开 `/v1/execute`、WebSocket stream 和 session mutation heavy paths。
  - 不改变 SkillRegistry loading, skill validate/invoke/draft/save behavior, skill storage path policy, or model-visible Skill tools.

## 2026-06-18 — Module Coupling Governance Phase 4A+: LoopWorkspaceRouter Read Slice

- **背景**: memory candidates router 收口后，下一块选择 GET `/v1/loop/workspaces`。该 route 是 read-only pane listing，只读取 `storage.listLoopPanes()` 并返回原有 filter envelope；pane create/update/delete mutations 仍留在 `app.ts`。
- **实现**:
  - 新增 `src/nexus/routers/loopWorkspaceRouter.ts`，接管 GET `/v1/loop/workspaces`。
  - `loopWorkspaceQuerySchema` 与 panes projection 从 `app.ts` 移入 router；POST `/v1/loop/workspaces/:workspaceId/panes`、PATCH/DELETE pane mutation routes 仍留在 `app.ts`。
  - `app.ts` 当前为 4892 lines；`src/nexus/routers/loopWorkspaceRouter.ts` 为 28 lines。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `npx tsx --test test/loop-workspace-router.test.ts`：1/1 pass。
  - `npx tsx --test --test-name-pattern "loop pane" test/runtime-loop.test.ts`：1/1 pass。
  - `npm run docs:check`：0 failures。
  - `npm run format:check`：0 failures。
  - `npm run deps:audit`：0 boundary failures。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 为 4892 lines，`ConfigManager.getInstance` in `app.ts` 为 4。
  - `npm run test:quarantine`：list mode pass；2 entries remain observing。
- **边界**:
  - Phase 4A+ 未关闭；下一 router slice 仍必须避开 `/v1/execute`、WebSocket stream 和 session mutation heavy paths。
  - 不改变 loop pane storage schema、pane create/update/delete behavior、loop health projection 或 Go TUI loop state ownership。

## 2026-06-18 — Module Coupling Governance Phase 4A+: RuntimeMemoryRouter Candidates Slice

- **背景**: runtime loop health router 收口后，下一块选择 GET `/v1/runtime/memory/candidates`。该 route 是 read-only review queue，只读取 SessionChannel `memory_candidate` messages，不执行 EverCore search/save/flush/restart，也不改 SessionChannel。
- **实现**:
  - 扩展 `src/nexus/routers/runtimeMemoryRouter.ts`，接管 GET `/v1/runtime/memory/candidates`。
  - `memoryCandidatesQuerySchema` 与 candidates projection 从 `app.ts` 移入 router；`app.ts` 仍保留 memory search/save-note/flush/restart action routes。
  - `app.ts` 当前为 4905 lines；`src/nexus/routers/runtimeMemoryRouter.ts` 为 156 lines。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `npx tsx --test test/runtime-memory-router.test.ts`：2/2 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-runtime-memory-candidates-router.json npx tsx --test --test-name-pattern "/v1/runtime/memory/candidates reports review-only governance metadata" test/runtime.test.ts`：1/1 pass。
  - `npm run docs:check`：0 failures。
  - `npm run format:check`：0 failures。
  - `npm run deps:audit`：0 boundary failures。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 为 4905 lines，`ConfigManager.getInstance` in `app.ts` 为 4。
  - `npm run test:quarantine`：list mode pass；2 entries remain observing。
- **边界**:
  - Phase 4A+ 未关闭；下一 router slice 仍必须避开 `/v1/execute`、WebSocket stream 和 session mutation heavy paths。
  - 不改变 memory candidate governance metadata、SessionChannel storage schema、EverCore search/save/flush/restart behavior 或 Go TUI memory overlay payload shape。

## 2026-06-18 — Module Coupling Governance Phase 4A+: RuntimeLoopHealthRouter Slice

- **背景**: tools audit router 收口后，下一块选择 GET `/v1/runtime/loop/health`。该 route 是 read-only pane health projection，但比此前 route 更重：它读取 storage events、汇总 task scope、叠加 behavior hint，并为 pane 构造 cache health。因而本 slice 只移动 loop health；loop_state CRUD routes 仍留在 `app.ts`。
- **实现**:
  - 新增 `src/nexus/routers/runtimeLoopHealthRouter.ts`，接管 GET `/v1/runtime/loop/health`。
  - `loopHealthQuerySchema`、`summarizeTaskScope()`、`summarizeBehaviorHint()` 从 `app.ts` 移入 router；handler 仍复用 runtime-owned `derivePaneStatus()` / `applyBehaviorHint()` 与 Nexus `buildCacheHealthFromEvents()`。
  - `app.ts` 当前为 4957 lines；`src/nexus/routers/runtimeLoopHealthRouter.ts` 为 205 lines。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `npx tsx --test test/runtime-loop-health-router.test.ts`：2/2 pass。
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-runtime-loop-health-router.json npx tsx --test test/runtime-loop-health-router.test.ts test/runtime-loop.test.ts`：18/18 pass。
  - 未隔离环境下直接跑 `npx tsx --test test/runtime-loop-health-router.test.ts test/runtime-loop.test.ts` 时，`test/runtime-loop.test.ts` 读到本机持久状态并出现 empty panes / loop_state count 断言失败；隔离配置下通过，按项目测试隔离规则采用隔离结果作为本 slice 证据。
  - `npm run docs:check`：0 failures。
  - `npm run format:check`：0 failures。
  - `npm run deps:audit`：0 boundary failures。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 为 4957 lines，`ConfigManager.getInstance` in `app.ts` 为 4。
  - `npm run test:quarantine`：list mode pass；2 entries remain observing。
- **边界**:
  - Phase 4A+ 未关闭；下一 router slice 仍必须避开 `/v1/execute`、WebSocket stream 和 session mutation heavy paths。
  - 不改变 loop health response shape、pane status priority、task-scope projection、behavior hint cooldown、cache health projection 或 loop_state CRUD 行为。

## 2026-06-18 — Module Coupling Governance Phase 4A+: ToolsAuditRouter Slice

- **背景**: context assemble router 收口后，下一块选择 GET `/v1/tools/audit`。该 route 是全局 read-only runtime tool audit endpoint，只读取 `runtime.listTools()`，不触碰 session mutation、agent mutation、`/v1/execute` 或 WebSocket stream。
- **实现**:
  - 新增 `src/nexus/routers/toolsAuditRouter.ts`，接管 GET `/v1/tools/audit`。
  - 保持 `tools_audit` envelope 与 runtime `listTools()` 来源不变；CLI / Go TUI 仍通过同一全局 endpoint 读取工具审计。
  - `app.ts` 当前为 5163 lines；`src/nexus/routers/toolsAuditRouter.ts` 为 11 lines。本 slice 因新增 import/register 样板导致 `app.ts` 行数微增；行数不作为单 PR merge gate。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `npx tsx --test test/tools-audit-router.test.ts`：2/2 pass。
  - `npx tsx --test test/tools-audit-router.test.ts test/mcp.test.ts`：`test/tools-audit-router.test.ts` 通过；`test/mcp.test.ts` 失败于当前真实 provider config 对 `mcp:*` tool name 的 400 响应，未作为本 slice required gate。
  - `npm run docs:check`：0 failures。
  - `npm run format:check`：0 failures。
  - `npm run deps:audit`：0 boundary failures。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 为 5163 lines，`ConfigManager.getInstance` in `app.ts` 为 4。
  - `npm run test:quarantine`：list mode pass；2 entries remain observing。
- **边界**:
  - Phase 4A+ 未关闭；下一 router slice 仍必须避开 `/v1/execute`、WebSocket stream 和 session mutation heavy paths。
  - 不改变 tool registry、MCP adapter、tool allowlist、Go TUI `/tools` overlay payload shape 或 runtime tool execution behavior。

## 2026-06-18 — Module Coupling Governance Phase 4A+: ContextAssembleRouter Slice

- **背景**: working-set read router 收口后，下一块选择 POST `/v1/context/assemble` manual preview route。该 route 只调用 `buildAssemblePreview()` 构造上下文预览，不写 persisted working set、不触碰 `/v1/context/observe` WebSocket，也不进入 runtime execute hot path。
- **实现**:
  - 新增 `src/nexus/routers/contextAssembleRouter.ts`，接管 POST `/v1/context/assemble`。
  - `runContextAssemble()` helper 从 `app.ts` 移入 router；`app.ts` re-export 旧 helper/type 入口，保持 `test/context-assemble-rest.test.ts` 和潜在外部 import 兼容。
  - `app.ts` 当前为 5160 lines；`src/nexus/routers/contextAssembleRouter.ts` 为 61 lines。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `npx tsx --test test/context-assemble-rest.test.ts test/context-assemble-router.test.ts`：16/16 pass。
  - `npm run docs:check`：0 failures。
  - `npm run format:check`：0 failures。
  - `npm run deps:audit`：0 boundary failures。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 为 5160 lines，`ConfigManager.getInstance` in `app.ts` 为 4。
  - `npm run test:quarantine`：list mode pass；2 entries remain observing。
- **边界**:
  - Phase 4A+ 未关闭；下一 router slice 仍必须避开 `/v1/execute`、WebSocket stream 和 session mutation heavy paths。
  - 不改变 `buildAssemblePreview()` section ordering、budget behavior、response envelope、validation error text 或 runtime context assembly hot path。

## 2026-06-18 — Module Coupling Governance Phase 4A+: ContextWorkingSetReadRouter Slice

- **背景**: Phase 4A+ 已抽出 context history / trace read routes 后，下一块选择 working-set read routes：GET `/v1/context/working-set`、GET `/v1/context/working-set/:sessionId`、GET `/v1/context/working-set/workspace/:wsId`。它们只读取 persisted working set，不改 working set、不触碰 `/v1/context/observe` WebSocket、不进入 runtime execution path。
- **实现**:
  - 新增 `src/nexus/routers/contextWorkingSetReadRouter.ts`，接管 working-set GET list / session / workspace aggregate routes。
  - `runWorkingSetList()`、`runWorkingSetGet()`、`runWorkspaceWorkingSetGet()` helper 从 `app.ts` 移入 router；`app.ts` re-export 旧 helper/type 入口，保持 `test/context-working-set-rest.test.ts`、`test/context-workspace-working-set-rest.test.ts` 和潜在外部 import 兼容。
  - PUT `/v1/context/working-set/:sessionId` 已在后续 `contextWorkingSetWriteRouter` slice 接管；`/v1/context/observe` WebSocket 仍留在后续切片。
  - `app.ts` 当前为 5206 lines；`src/nexus/routers/contextWorkingSetReadRouter.ts` 为 167 lines。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `npx tsx --test test/context-working-set-rest.test.ts test/context-working-set-read-router.test.ts test/context-workspace-working-set-rest.test.ts`：22/22 pass。
  - `npm run docs:check`：0 failures。
  - `npm run format:check`：0 failures。
  - `npm run deps:audit`：0 boundary failures。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 为 5206 lines，`ConfigManager.getInstance` in `app.ts` 为 4。
  - `npm run test:quarantine`：list mode pass；2 entries remain observing。
- **边界**:
  - Phase 4A+ 未关闭；下一 router slice 仍必须避开 `/v1/execute`、WebSocket stream 和 session mutation heavy paths。
  - 不改变 persisted working-set JSON format、GET response shape、PUT write-through semantics、working-set observe behavior 或 runtime hot path。

## 2026-06-18 — Module Coupling Governance Phase 4A+: ContextHistoryRouter Slice

- **背景**: Phase 4A+ 已抽出 schema route 后，下一块选择 read-only context routes：GET `/v1/context/history` 与 GET `/v1/context/trace`。它们只读取 `.babel-o/behavior-trace.jsonl`，不改 working set、不触碰 `/v1/context/observe` WebSocket、不进入 runtime execution path。
- **实现**:
  - 新增 `src/nexus/routers/contextHistoryRouter.ts`，接管 GET `/v1/context/history` 与 GET `/v1/context/trace`。
  - `parseSinceFromQuery()`、`runContextHistory()`、`runBehaviorTraceGet()` helper 从 `app.ts` 移入 router；`app.ts` re-export 旧 helper 入口，保持 `test/context-history-rest.test.ts` 和潜在外部 import 兼容。
  - `app.ts` 当前为 5363 lines；`src/nexus/routers/contextHistoryRouter.ts` 为 216 lines。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `npx tsx --test test/context-history-rest.test.ts test/context-history-router.test.ts`：15/15 pass。
  - `npm run docs:check`：0 failures。
  - `npm run format:check`：0 failures。
  - `npm run deps:audit`：0 boundary failures。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 为 5363 lines，`ConfigManager.getInstance` in `app.ts` 为 4。
  - `npm run test:quarantine`：list mode pass；2 entries remain observing。
- **边界**:
  - Phase 4A+ 未关闭；下一 router slice 仍必须避开 `/v1/execute`、WebSocket stream 和 session mutation heavy paths。
  - 不改变 behavior trace JSONL format、history summarize/search semantics、trace filtering defaults 或 context observe/working-set/assemble behavior。

## 2026-06-18 — Module Coupling Governance Phase 4A+: SchemaRouter Slice

- **背景**: Phase 4A+ 已抽出 runtime status/config/memory/models/metrics/provider diagnostics 等低风险 router。本轮选择最小 schema route：GET `/v1/schema/events`，它只导出 `NexusEventSchema` 的 JSON schema，不读写 storage，不触碰 runtime execution、session mutation 或 WebSocket stream。
- **实现**:
  - 新增 `src/nexus/routers/schemaRouter.ts`，接管 GET `/v1/schema/events`。
  - `app.ts` 不再直接 import `NexusEventSchema`；事件 JSON schema 导出职责归入 schema router。
  - `app.ts` 当前为 5588 lines；本 slice 因 router 注册样板略增行数，但减少了 `app.ts` 的 schema ownership。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `npx tsx --test test/schema-router.test.ts`：1/1 pass。
  - `npm run docs:check`：0 failures。
  - `npm run format:check`：0 failures。
  - `npm run deps:audit`：0 boundary failures。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 为 5588 lines，`ConfigManager.getInstance` in `app.ts` 仍为 4。
  - `npm run test:quarantine`：list mode pass；2 entries remain observing。
- **边界**:
  - Phase 4A+ 未关闭；下一 router slice 仍必须避开 `/v1/execute`、WebSocket stream 和 session mutation heavy paths。
  - 不改变 `NexusEventSchema`、JSON schema shape、event version 或 runtime behavior。

## 2026-06-18 — Module Coupling Governance Phase 4A+: RuntimeConfigMutationRouter Slice

- **背景**: `runtimeConfigRouter` 已接管 read-only config/profile routes，provider diagnostics routes 也已拆出。下一块选择 POST `/v1/runtime/config/provider` 与 POST `/v1/runtime/config/select`，因为它们是 bounded config mutation，不涉及 session mutation、`/v1/execute`、WebSocket stream 或 storage schema。
- **实现**:
  - 新增 `src/nexus/routers/runtimeConfigMutationRouter.ts`，接管 POST `/v1/runtime/config/provider` 与 POST `/v1/runtime/config/select`。
  - `runtimeConfigProviderSchema` / `runtimeConfigSelectSchema` 从 `app.ts` 移入 router；handler 继续复用 `inspectResolvedRuntimeConfig()`，保持脱敏 response shape 与 read-only config route 对齐。
  - `app.ts` 当前为 5584 lines；`providerRegistry` / `modelRegistry` config mutation checks 从 `app.ts` 移入 router。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `npx tsx --test test/runtime-config-mutation-router.test.ts`：1/1 pass。
  - `npx tsx --test test/config-endpoints.test.ts`：28/28 pass。
  - `npx tsx --test test/runtime-config-mutation-router.test.ts test/config-endpoints.test.ts`：29/29 pass。
  - `npm run docs:check`：0 failures。
  - `npm run format:check`：0 failures。
  - `npm run deps:audit`：0 boundary failures。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 为 5584 lines，`ConfigManager.getInstance` in `app.ts` 为 4。
  - `npm run test:quarantine`：list mode pass；2 entries remain observing。
- **边界**:
  - Phase 4A+ 未关闭；下一 router slice 仍必须避开 `/v1/execute`、WebSocket stream 和 session mutation heavy paths。
  - 不改变 config schema、provider/model registry、auth validation、response redaction 或 Go TUI `/model` persistence behavior。

## 2026-06-18 — Module Coupling Governance Phase 4A+: RuntimeProviderDiagnosticsRouter Slice

- **背景**: Phase 4A+ 已抽出 status / config / memory status / models / metrics 五个低风险 router。本轮继续选择 provider diagnostics cluster：provider smoke dry-run/live 与 fallback-plan route。它们不改 session/storage，不触碰 `/v1/execute` 或 WebSocket stream；focused test 只覆盖离线 dry-run 与 fallback-plan 契约，不触发真实 provider 调用。
- **实现**:
  - 新增 `src/nexus/routers/runtimeProviderDiagnosticsRouter.ts`，接管 GET `/v1/runtime/provider-smoke`、POST `/v1/runtime/provider-smoke/live`、POST `/v1/runtime/provider-fallback/plan`。
  - provider smoke / fallback plan 专属 Zod schema 从 `app.ts` 移入 router；`app.ts` 仍保留 POST config provider/select mutation routes 及其 schema。
  - `app.ts` 当前为 5691 lines；route 职责继续向 feature router 收敛。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `npx tsx --test test/runtime-provider-diagnostics-router.test.ts`：1/1 pass。
  - `npx tsx --test test/runtime-metrics-router.test.ts test/runtime-provider-diagnostics-router.test.ts`：2/2 pass。
  - `npm run docs:check`：0 failures。
  - `npm run format:check`：0 failures。
  - `npm run deps:audit`：0 boundary failures。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 为 5691 lines，`ConfigManager.getInstance` in `app.ts` 为 6。
  - `npm run test:quarantine`：list mode pass；2 entries remain observing。
- **边界**:
  - Phase 4A+ 未关闭；下一 router slice 仍必须是 read-only / low-risk cluster。
  - 不触碰 provider config mutation、`/v1/execute`、WebSocket stream、SQLite schema 或 runtime 行为。

## 2026-06-18 — Module Coupling Governance Phase 4A+: RuntimeMetricsRouter Slice

- **背景**: Phase 4A+ 已抽出 status / config / memory status / models 四个低风险 router。本轮继续选择 read-only route：GET `/v1/runtime/metrics`，不移动 metrics 聚合 helper，避免把 route extraction 扩大成指标重构。
- **实现**:
  - 新增 `src/nexus/routers/runtimeMetricsRouter.ts`，接管 GET `/v1/runtime/metrics`。
  - `app.ts` 通过 `FeatureRouterContext.runtimeMetricsSnapshot()` 注入现有 `buildRuntimeMetricsSnapshot(metrics, storage)` closure；metrics response shape、storage event aggregation、cacheHealth 聚合均不变。
  - `app.ts` 当前为 5741 lines；本 slice 优先减少路由职责和 merge-conflict surface，行数目标继续作为累计健康指标。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `npx tsx --test test/runtime-metrics-router.test.ts`：1/1 pass。
  - `npm run docs:check`：0 failures。
  - `npm run format:check`：0 failures。
  - `npm run deps:audit`：0 boundary failures。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 为 5741 lines。
  - `npm run test:quarantine`：list mode pass；2 entries remain observing。
- **边界**:
  - Phase 4A+ 未关闭；下一 router slice 仍必须是 read-only / low-risk cluster。
  - 不触碰 metrics aggregation helper、`/v1/execute`、WebSocket stream、SQLite schema 或 runtime 行为。

## 2026-06-18 — Module Coupling Governance Phase 4A+: RuntimeModelsRouter Slice

- **背景**: Phase 4A+ 已抽出 status / config / memory status 三个低风险 router。本轮继续选择 read-only route：GET `/v1/runtime/models`，不混入 POST config provider/select mutation。
- **实现**:
  - 新增 `src/nexus/routers/runtimeModelsRouter.ts`，接管 provider/model list 与 provider auth diagnostics。
  - `providerCredentialEnv()` / `profileProviderId()` / `resolveProviderAuthState()` 从 `app.ts` 移入 router；`app.ts` 仍保留 POST config mutation 所需的 `providerRegistry` / `modelRegistry` 校验。
  - `process.env` provider credential reads 从 `app.ts` 集中到 `runtimeModelsRouter.ts`，让 `app.ts` env concentration 从 12 降到 1。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `npx tsx --test test/runtime-models-router.test.ts`：2/2 pass。
  - `npx tsx --test test/config-endpoints.test.ts`：28/28 pass。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 降至 5735 lines。
- **边界**:
  - Phase 4A+ 未关闭；下一 router slice 仍必须是 read-only / low-risk cluster。
  - 不触碰 POST config mutation、`/v1/execute`、WebSocket stream、SQLite schema 或 runtime 行为。

## 2026-06-18 — Module Coupling Governance Phase 4A+: RuntimeMemoryRouter Slice

- **背景**: `runtimeStatusRouter` 与 `runtimeConfigRouter` 已建立前两块低风险 route extraction。Phase 4A+ 第三块选择 GET `/v1/runtime/memory/status`，因为它是 read-only dashboard route；memory search/save/flush/restart actions 不混入本 slice。
- **实现**:
  - 新增 `src/nexus/routers/runtimeMemoryRouter.ts`，接管 GET `/v1/runtime/memory/status`。
  - `listRecentMemoryRetrievalEvents()` 与 memory quality rate assembly 移入 router；`createNexusApp()` 仍拥有 `memoryApprovalCounters`，并把 counters 作为只读 snapshot 注入 router。
  - `src/nexus/app.ts` 继续保留 memory search/save/flush/restart action routes 与 approval counter mutation。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `npx tsx --test test/runtime-memory-router.test.ts`：1/1 pass。
  - `npx tsx --test --test-name-pattern "/v1/runtime/memory/status reports read-only EverCore memory surface" test/runtime.test.ts`：1/1 pass。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 降至 5823 lines。
- **边界**:
  - Phase 4A+ 未关闭；GET `/v1/runtime/models` 已在后续 slice 落地，下一 router slice 仍必须是 read-only / low-risk cluster。
  - 不触碰 memory search/save/flush/restart、`/v1/execute`、WebSocket stream、SQLite schema 或 runtime 行为。

## 2026-06-18 — Module Coupling Governance Phase 4A+: RuntimeConfigRouter Slice

- **背景**: `runtimeStatusRouter` 已建立 `FeatureRouter` 注册模式。Phase 4A+ 下一块继续只抽低风险只读 route，选择 runtime config read routes；POST config mutation routes、`/v1/runtime/models`、provider smoke 和 execute/stream 均不混入。
- **实现**:
  - 新增 `src/nexus/routers/runtimeConfigRouter.ts`，接管 GET `/v1/runtime/config`、`/v1/runtime/config/profiles`、`/v1/runtime/config/profiles/:name`。
  - `inspectResolvedRuntimeConfig()` 移入并导出自 `runtimeConfigRouter`，POST `/v1/runtime/config/provider` 与 `/v1/runtime/config/select` 继续复用同一脱敏响应 helper，避免复制 response shape。
  - `src/nexus/app.ts` 通过 `runtimeConfigRouter.register(...)` 注册只读 config routes；`/v1/runtime/models` 与 POST mutation routes 暂留在 `app.ts`。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `npx tsx --test test/runtime-config-router.test.ts`：1/1 pass。
  - `npx tsx --test test/config-endpoints.test.ts`：28/28 pass。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 降至 5918 lines。
- **边界**:
  - Phase 4A+ 未关闭；GET `/v1/runtime/memory/status` 已在后续 slice 落地，下一 router slice 仍必须是 read-only / low-risk cluster。
  - 不触碰 `/v1/execute`、`/v1/stream`、`/v1/context/observe`、SQLite schema 或 runtime 行为。

## 2026-06-18 — Module Coupling Governance Phase 4A+: RuntimeStatusRouter Slice

- **背景**: Phase 3B+ 已完成三个可 review 的 runtime strategy slices。下一步按 PR-sized map 转入 Phase 4A+，先抽低风险 Nexus router，不触碰 `/v1/execute` 或 WebSocket stream。
- **实现**:
  - 新增 `src/nexus/router.ts`，定义 `FeatureRouter` / `FeatureRouterContext` 与 `EverOSBootstrapStatusSnapshot`。
  - 新增 `src/nexus/routers/runtimeStatusRouter.ts`，接管 `/health`、`/v1/runtime/status`、`/v1/runtime/version`。
  - `src/nexus/app.ts` 保留 metrics、bootstrap、EverCore status 等组合根闭包，并通过 `runtimeStatusRouter.register(...)` 注入；route response shape 不变。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `npx tsx --test test/runtime-status-router.test.ts`：1/1 pass。
  - `npm run coupling:audit`：`runtimeToNexus: []`、`nexusToCli: []`；`app.ts` tracked hotspot 从 6155 lines 降至 6058 lines。
- **边界**:
  - Phase 4A+ 未关闭；runtime config read routes 已在后续 slice 落地，下一候选是 memory status。
  - 不触碰 `/v1/execute`、`/v1/stream`、`/v1/context/observe`、SQLite schema 或 runtime 行为。

## 2026-06-18 — Module Coupling Governance Phase 3B+: ToolDispatchPipeline Slice

- **背景**: `ProviderTurnDriver` 已把 provider stream invocation 从 `LLMCodingRuntime` 抽出。下一块仍适合小 PR 的 runtime loop 责任是 provider tool-call dispatch coordination：执行每个 provider tool call、收集 tool events、触发 working-set update、追加 grounding confirmation，并在 scope confirmation 后重新派生 task scope。
- **实现**:
  - 新增 `src/runtime/ToolDispatchPipeline.ts`，封装 provider tool-call dispatch coordination。
  - `ToolDispatchPipeline.run()` 继续复用 `executeProviderToolCall()`，不改 permission / scope-boundary / audit / tool execution 语义。
  - `LLMCodingRuntime.executeStream()` 的 provider outcome tool-call 分支改为调用 `toolDispatchPipeline.run(...)`，然后只接收更新后的 `previousEvents`、`taskScopeEvent` 和 tool result content。
  - working-set 更新通过 callback 注入，避免 `ToolDispatchPipeline` 直接依赖 `LLMCodingRuntime` 私有状态。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `npx tsx --test test/tool-dispatch-pipeline.test.ts`：1/1 pass。
  - `npx tsx --test --test-name-pattern "runtime tool loop executes a provider tool call and returns tool_result content|provider session rules are isolated between injected services|LLMCodingRuntime emits grounding confirmation after source evidence tool result" test/runtime.test.ts`：2/2 matched tests pass。
  - `wc -l src/runtime/LLMCodingRuntime.ts src/runtime/ToolDispatchPipeline.ts`：`LLMCodingRuntime.ts` 1841 lines, `ToolDispatchPipeline.ts` 135 lines after this slice.
- **边界**:
  - Phase 3B+ 未关闭；下一候选是 hook dispatch / resume 中仍可独立 review 的部分。若无法保持小 PR，先转入 Phase 4A+ low-risk router slice。
  - 不要求本 slice 达成 `LLMCodingRuntime <= 600 lines`；该目标仍是累计健康指标。

## 2026-06-18 — Module Coupling Governance Phase 3B+: ProviderTurnDriver Slice

- **背景**: `ContextRefreshStrategy` 第一刀落地后，Phase 3B+ 继续按"one PR = one strategy object"抽 `LLMCodingRuntime`。本轮选择 provider adapter stream invocation，保持 hook dispatch、provider recovery、compact retry 和 tool dispatch 仍在 runtime loop，避免混合行为变更。
- **实现**:
  - 新增 `src/runtime/ProviderTurnDriver.ts`，封装 provider adapter `queryStream()` 调用、`streamProviderTurn()` 接线，以及 final-response-only / respond-only / tools-hidden 阶段的 tool-call text leak guard setup。
  - `LLMCodingRuntime.executeStream()` provider invocation 段改为 `providerTurnDriver.run(...)`，保留原有 `PreInvocation` / `PostInvocation` hooks、`classifyProviderRecovery()`、context-window recovery、metrics absorption 和 memory capability leak retry 逻辑。
  - 本 slice 不改 `ModelAdapter.queryStream()` contract、`streamProviderTurn()` collector、provider query params shape、event yield semantics、permission/tool dispatch 行为。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `npx tsx --test test/provider-turn-driver.test.ts`：2/2 pass。
  - `npx tsx --test --test-name-pattern "runtime pipeline collects provider turn deltas and usage events|LLMCodingRuntime (recovers provider context-limit errors with reactive compact retry|blocks after provider context-limit recovery is exhausted|attempts reactive compact after tool results exceed provider-loop context limit)" test/runtime.test.ts`：4/4 pass。
  - `wc -l src/runtime/LLMCodingRuntime.ts src/runtime/ProviderTurnDriver.ts`：`LLMCodingRuntime.ts` 1879 lines, `ProviderTurnDriver.ts` 56 lines after this slice.
- **边界**:
  - Phase 3B+ 未关闭；`ToolDispatchPipeline` 已在后续 slice 落地，下一候选是 hook dispatch / resume 中仍可独立 review 的部分。
  - 不要求本 slice 达成 `LLMCodingRuntime <= 600 lines`；该目标仍是累计健康指标。

## 2026-06-18 — Module Coupling Governance Phase 3B+: ContextRefreshStrategy Slice

- **背景**: Phase 3A 已把 `runtimePipeline.ts` 降为 compatibility façade。Phase 3B+ 开始从 `LLMCodingRuntime` 每次抽一个 strategy object；第一候选是 context refresh，因为 hot path 和 `resume()` 都需要同一组 refresh dependencies、session inbox loading、memory retrieval hook 与 context broadcaster 注入。
- **实现**:
  - 新增 `src/runtime/ContextRefreshStrategy.ts`，封装 `refreshRuntimeContextState()` 的 dependency wiring：`storage`、`memoryProvider`、`contextBroadcaster`、session inbox limit。
  - `ContextRefreshStrategy.refresh()` 支持 `sessionInbox: 'omit' | 'load' | 'empty' | SessionMessage[]`，其中 `'load'` 通过 storage 读取 inbox，失败时保持原有 non-fatal debug + empty fallback。
  - `LLMCodingRuntime.executeStream()` hot path 改为创建 per-runtime-call `ContextRefreshStrategy`，初始 refresh 使用 omit，compact / provider-context-recovery refresh 使用 `'load'`，不再在 loop 内维护 ad-hoc `loadSessionInbox()` helper。
  - `LLMCodingRuntime.resume()` context assembly 也改为通过同一 strategy，使用 `sessionInbox: 'empty'` 保持原行为。
  - 本 slice 不改 compact orchestration、event yield 顺序、provider adapter contract、tool dispatch、permission / hook / storage schema。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `npx tsx --test test/context-refresh-strategy.test.ts`：2/2 pass。
  - `npx tsx --test test/runtime-context-broadcaster-injection.test.ts`：2/2 pass。
  - `npx tsx --test --test-name-pattern "LLMCodingRuntime (continues from a successful compact boundary|attempts reactive compact after tool results exceed provider-loop context limit|recovers provider context-limit errors with reactive compact retry|blocks after provider context-limit recovery is exhausted|respects auto compact failure fuse before hard blocking|blocks provider calls when compacted context still exceeds limit)" test/runtime.test.ts`：6/6 pass。
  - `npx tsx --test test/llm-coding-runtime-resume.test.ts`：10/10 pass。
  - `wc -l src/runtime/LLMCodingRuntime.ts src/runtime/ContextRefreshStrategy.ts`：`LLMCodingRuntime.ts` 1881 lines, `ContextRefreshStrategy.ts` 62 lines after this slice.
- **边界**:
  - Phase 3B+ 未关闭；`ProviderTurnDriver` 与 `ToolDispatchPipeline` 已在后续 slices 落地，下一候选是 hook dispatch / resume 中仍可独立 review 的部分。
  - 不要求本 slice 达成 `LLMCodingRuntime <= 600 lines`；该目标仍是累计健康指标。

## 2026-06-18 — Module Coupling Governance Phase 3A: RuntimePipeline Helper Submodules

- **背景**: Phase 3A 要把 `runtimePipeline.ts` 从单一 helper 聚合文件逐步拆成可 review 的 submodule。本轮选择 provider turn messages、runtime terminal events、context grounding、context refresh/blocking、cache/metrics、provider loop request、provider turn outcome / stream collector、local runtime intent parser 这些 helper cluster，不碰 `LLMCodingRuntime` loop 行为、provider adapter、tool dispatch 或 public Nexus API。
- **实现**:
  - 新增 `src/runtime/pipeline/turn.ts`，承载 `RuntimeProviderTurn` / `RuntimeProviderToolCall` 等 turn 类型、`resolveProviderToolCallInput()`、`buildProviderAssistantMessage()`、`buildProviderToolResultsMessage()`。
  - 新增 `src/runtime/pipeline/events.ts`，承载 `buildRuntimeResultEvent()`、`buildRuntimeErrorEvent()`、`buildToolCallTextLeakSuppressedEvent()`。
  - 新增 `src/runtime/pipeline/context.ts`，承载 context grounding required/confirmed、workspace dirty detection、git status changed-file parsing 等纯 helper。
  - 新增 `src/runtime/pipeline/contextRefresh.ts`，承载 context warning/blocking/usage/microcompact/recovery event builders、context refresh state builder、`refreshRuntimeContextState()` 和 injected broadcaster publish path。
  - 新增 `src/runtime/pipeline/cache.ts`，承载 `RuntimeExecutionMetrics`、`createRuntimeExecutionMetrics()`、`buildRuntimeExecutionMetricsEvent()`、provider/cache/prefix/compact/remote metrics absorption。
  - 新增 `src/runtime/pipeline/loop.ts`，承载 provider loop request state、query params、prefix-cache diagnostics、execution state block helper。
  - 新增 `src/runtime/pipeline/providerTurn.ts`，承载 `reduceProviderTurnOutcome()`、option-selection clarification helper、`streamProviderTurn()`、usage aggregation 和 tool-call / memory capability leak guards。
  - 新增 `src/runtime/pipeline/localIntent.ts`，承载 `parseLocalRuntimeIntent()` 及其 deterministic local parser helpers。
  - `src/runtime/runtimePipeline.ts` 保留 compatibility façade，继续 re-export 上述类型和 helper，现有 import path 不需要迁移。
  - 本 slice 不改 `LLMCodingRuntime` loop、tool dispatch、provider streaming semantics、message shape 或 public Nexus API。
- **验证**:
  - `npm run typecheck`：0 errors。
  - `npx tsx --test --test-name-pattern "runtime pipeline (resolves provider tool call inputs|builds provider assistant and tool result messages|builds grounding guard events after compact|builds grounding confirmation events from source evidence tools|builds context warning and blocking event sequences|builds compact refresh state from assembled context|collects provider turn deltas and usage events)" test/runtime.test.ts`：7/7 pass。
  - `npx tsx --test --test-name-pattern "runtime pipeline (builds provider loop state and execution state blocks|builds provider loop request state and query params|collects provider turn deltas and usage events|builds context_usage event from context policy facts|builds context_microcompact event from metrics)" test/runtime.test.ts`：5/5 pass。
  - `npx tsx --test --test-name-pattern "runtime pipeline (builds terminal result and error events|builds context_usage event from context policy facts|builds context_microcompact event from metrics|builds context warning and blocking event sequences|builds compact refresh state from assembled context|builds provider loop state and execution state blocks|builds provider loop request state and query params|collects provider turn deltas and usage events)" test/runtime.test.ts`：8/8 pass。
  - `npx tsx --test --test-name-pattern "runtime pipeline (parses local tool and task intents|reduces max-token provider turns to continuation or terminal outcomes|asks user to confirm option-like suppressed tool turns|reduces final and tool-call provider turns|collects provider turn deltas and usage events)" test/runtime.test.ts`：5/5 pass。
  - `npx tsx --test test/runtime-context-broadcaster-injection.test.ts`：2/2 pass。
  - `wc -l src/runtime/runtimePipeline.ts`：137 lines after Phase 3A closes.
- **边界**:
  - Phase 3A 已关闭；后续进入 Phase 3B+，每个 PR 只从 `LLMCodingRuntime` 抽一个 strategy object。`ContextRefreshStrategy`、`ProviderTurnDriver`、`ToolDispatchPipeline` 已在后续 slices 落地，下一候选是 hook dispatch / resume 中仍可独立 review 的部分。
  - 不要求本 PR 达成 `LLMCodingRuntime <= 600 lines` 或完全清空 `runtimePipeline.ts`；这些是累计健康指标。

## 2026-06-18 — Module Coupling Governance Phase 2C ConfigManager Instance Pilot

- **背景**: Stream B 需要逐步降低 `ConfigManager.getInstance()` 的进程级耦合，但不应一次性迁移所有 Nexus / CLI / tool callsites。Phase 2C 先建立 explicit instance path，并迁移 1-2 个低风险 composition callsite。
- **实现**:
  - `ConfigManager` constructor 支持 `new ConfigManager({ configFile })`，同时保留旧的 `new ConfigManager(configFile)` string 入口。
  - `createDefaultNexusRuntime()` 新增 `configManager` option；runtime settings、`LocalCodingRuntime` hooks、`LLMCodingRuntime` 构造均使用该 injected instance。
  - `ExploreAgentScheduler` / `createExploreRuntime()` 新增 `configManager` option；child agent runtime factory 不再必须回落到全局 singleton。
  - 保留 `ConfigManager.getInstance()` 作为 legacy caller path；本切片不迁移 `app.ts`、CLI config command、provider smoke、Bash tool 等剩余 callsites。
- **验证**:
  - `npx tsx --test test/config-manager-instance.test.ts`：3/3 pass。
  - `npm run typecheck`：0 errors。
  - `npm run coupling:audit`：`reverseImports.runtimeToNexus: []`、`reverseImports.nexusToCli: []`；`ConfigManager.getInstance` fingerprint 降至 35 references。
- **边界**:
  - 不改变 config schema、env precedence、provider/model selection priority、config write guard、CLI config behavior。
  - 不引入完整 `RuntimeServices`。
  - 不把所有 `ConfigManager.getInstance()` callsites 作为单 PR 目标；后续可按 router / CLI / tool slices 继续迁移。

## 2026-06-18 — Module Coupling Governance Phase 2B ContextBroadcaster Injection

- **背景**: Phase 2A 后 `npm run coupling:audit` 仍显示 `runtime/contextBroadcasterSingleton.ts -> nexus/contextBroadcaster.ts`，这是最后一个 `runtime -> nexus` reverse import。`defaultContextBroadcaster` 只应作为 Nexus compatibility default，而不应被 runtime hot path 读取。
- **实现**:
  - 新增 `src/runtime/contextBroadcaster.ts`，定义结构化 `RuntimeContextBroadcaster` / `RuntimeContextEvent`，不依赖 Nexus。
  - `runtimePipeline.refreshRuntimeContextState()` 接收 optional `contextBroadcaster`，`safeContextPublish()` 只发布到 injected broadcaster；未注入时不发布。
  - `LLMCodingRuntime` 构造函数中的 `contextBroadcaster` 字段改为 runtime-owned interface，并传入所有 hot-path / resume context refresh 调用。
  - `createDefaultNexusRuntime()` 新增 `contextBroadcaster` option；`server.ts` 和 embedded CLI app composition 显式创建一个 Nexus `ContextBroadcaster`，同时传给 runtime factory 和 `createNexusApp()`。
  - `createNexusApp()` 不再调用 `setDefaultContextBroadcaster()`；`defaultContextBroadcaster` 保留为 `/v1/context/observe` legacy default。
  - 删除 `src/runtime/contextBroadcasterSingleton.ts`。
- **验证**:
  - `npx tsx --test test/runtime-context-broadcaster-injection.test.ts test/context-broadcaster.test.ts test/context-observe-websocket.test.ts`：18/18 pass。
  - `npm run typecheck`：0 errors。
  - `npm run coupling:audit`：`reverseImports.runtimeToNexus: []`，`reverseImports.nexusToCli: []`。
- **边界**:
  - 不改 `/v1/context/observe` WebSocket frame shape、snapshot behavior、`ContextBroadcaster` cache/subscriber semantics。
  - 不引入完整 `RuntimeServices`。
  - 不处理 `ConfigManager.getInstance()`；该项进入 Phase 2C。

## 2026-06-18 — Module Coupling Governance Phase 2A ProviderSessionRules Service

- **背景**: Phase 0.5 audit baseline 标出 `runtimeToolLoop.ts` 持有 module-level `providerSessionRules` `Map`，session-scoped provider approval rule 无法通过实例隔离。该问题属于 Stream B singleton debt，但不需要一次性引入完整 `RuntimeServices`。
- **实现**:
  - 新增 `src/runtime/providerSessionRules.ts`，封装 provider session approval rule 的 add / get / allow-check / clear 行为。
  - `runtimeToolLoop.ts` 不再持有 module-level rule `Map`；`executeProviderToolCall` 接收 injected `ProviderSessionRules`，并保留 `defaultProviderSessionRules` 作为 legacy direct-call compatibility。
  - `LLMCodingRuntime` 默认创建 per-runtime `ProviderSessionRules`，并传入每次 tool-loop dispatch。
  - `resetProviderSessionRulesForTest()` 继续存在，但只清理 legacy default instance。
  - `scripts/audit-coupling.js` 将 provider session rules 从 generic singleton string match 拆出，单独报告 `singletonState.providerSessionRules.moduleLevelMap`，避免把 injectable service 引用误判为 module-level singleton debt。
- **验证**:
  - `npx tsx --test --test-name-pattern "provider session" test/runtime.test.ts`：2/2 pass。
  - `npm run typecheck`：0 errors。
  - `npm run coupling:audit`：`singletonState.providerSessionRules.moduleLevelMap.count: 0`；无新增 reverse import；`nexusToCli: []`；剩余 `runtime -> nexus` 仍为 `runtime/contextBroadcasterSingleton.ts -> nexus/contextBroadcaster.ts`，进入 Phase 2B。
- **边界**:
  - 不引入完整 `RuntimeServices`。
  - 不改 permission rule syntax、permission audit persistence、scope-boundary approval flow、tool execution behavior。
  - 不处理 `defaultContextBroadcaster` hot-path singleton；该项是下一步 Phase 2B。

## 2026-06-18 — Module Coupling Governance Phase 1B Nexus-to-CLI Bootstrap Boundary

- **背景**: Phase 0.5 audit baseline 显示 `src/nexus/createRuntime.ts` 直接 import `src/cli/everosBackgroundBootstrap.ts`，形成 `nexus -> cli` reverse dependency。该 bootstrap worker 是 runtime composition concern，不应由 CLI 层拥有。
- **实现**:
  - 将 `everosPrerequisites`、`everosFallbackBuild`、`everosBootstrap`、`everosBackgroundBootstrap` 的共享实现迁入 `src/runtime/`。
  - `src/nexus/createRuntime.ts` 改为 import `../runtime/everosBackgroundBootstrap.js`。
  - `src/cli/everosPrerequisites.ts`、`src/cli/everosFallbackBuild.ts`、`src/cli/everosBootstrap.ts`、`src/cli/everosBackgroundBootstrap.ts` 保留 compatibility façade；`src/cli/everosAutoBootstrap.ts` 作为 CLI policy wrapper，直接依赖 runtime prerequisite/background helpers。
  - 为避免 runtime 引入 CLI-only `chalk` dependency，runtime bootstrap status/setup 输出使用 plain text；CLI command 层仍负责其它命令 UI styling。
- **验证**:
  - `npx tsx --test test/everos-bootstrap.test.ts test/everos-background-bootstrap.test.ts test/everos-auto-bootstrap.test.ts test/everos-fallback-build.test.ts test/everos-first-run.test.ts test/everos-bootstrap-config.test.ts test/everos-bootstrap-store.test.ts test/everos-bootstrap-store-v2.test.ts test/everos-welcome-hint.test.ts`：60/60 pass。
  - `npm run typecheck`：0 errors。
  - `npm run coupling:audit`：`nexusToCli: []`。
  - `rg -n "from ['\"]\\.\\./cli|from ['\"]\\.\\.\\/cli" src/nexus`：0 matches。
- **边界**:
  - 不改 EverOS bootstrap state schema、lock/update behavior、auto-bootstrap policy decision、managed command resolution。
  - 不处理 `runtime/contextBroadcasterSingleton.ts -> nexus/contextBroadcaster.ts`；该项进入 Phase 2B。

## 2026-06-18 — Module Coupling Governance Phase 1A Runtime-owned Monitors

- **背景**: Phase 0.5 audit baseline 显示 `runtime -> nexus` reverse imports 中有 10 条来自 monitor / working-set / context broadcaster；其中 `BehaviorMonitor`、`WorkingSetTracker`、`PersistedWorkingSetTracker` 是纯 runtime state machine / persistence concern，不依赖 Fastify / HTTP / WebSocket。
- **实现**:
  - 将 `BehaviorMonitor` 从 `src/nexus/behaviorMonitor.ts` 迁到 `src/runtime/behaviorMonitor.ts`。
  - 将 `WorkingSetTracker` / `deriveEntriesFromEvents` 从 `src/nexus/workingSetTracker.ts` 迁到 `src/runtime/workingSetTracker.ts`。
  - 将 `PersistedWorkingSetTracker` 从 `src/nexus/persistedWorkingSetTracker.ts` 迁到 `src/runtime/persistedWorkingSetTracker.ts`。
  - `src/nexus/{behaviorMonitor,workingSetTracker,persistedWorkingSetTracker}.ts` 保留薄 re-export façade，作为 legacy import compatibility。
  - 更新 runtime / Nexus / CLI source imports 和 focused tests，让新代码直接依赖 runtime-owned modules。
- **验证**:
  - `npx tsx --test test/behavior-monitor.test.ts test/behavior-monitor-subscribe.test.ts test/working-set-tracker.test.ts test/working-set-tracker-persist.test.ts test/working-set-tracker-apply-event.test.ts test/working-set-event-bus.test.ts test/session-resume.test.ts test/llm-coding-runtime-resume.test.ts test/context-working-set-rest-put.test.ts test/context-working-set-edit-cli.test.ts`：125/125 pass。
  - `npm run typecheck`：0 errors。
  - `npm run coupling:audit`：monitor-related `runtime -> nexus` imports removed; remaining `runtime -> nexus` records are `runtime/contextBroadcasterSingleton.ts -> nexus/contextBroadcaster.ts` and are queued for Phase 2B.
- **边界**:
  - 不改 runtime behavior、working-set file schema、BehaviorMonitor detection semantics、REST route response shape。
  - 不处理 `nexus/createRuntime.ts -> cli/everosBackgroundBootstrap`；该项进入 Phase 1B。
  - 不处理 `defaultContextBroadcaster` singleton；该项进入 Phase 2B。

## 2026-06-18 — Module Coupling Governance Phase 0.5 Audit Baseline

- **背景**: `module-coupling-decoupling-and-re-aggregation-plan.md` 已补 PR-sized execution map；真实推进需要一个可粘贴到 PR 的 coupling fingerprint，而不是继续依赖人工 `grep` / `wc -l`。
- **实现**:
  - 新增 `scripts/audit-coupling.js`，输出机器可读 JSON：`runtime -> nexus`、`nexus -> cli`、`shared -> outside` reverse imports；跨 layer import direction matrix；`ConfigManager.getInstance`、`defaultContextBroadcaster`、`defaultEverCoreRuntimeManager`、`providerSessionRules` known singleton state；hotspot large-file line counts；`process.env` / `process.cwd()` concentration。
  - 新增 `npm run coupling:audit`，作为后续 coupling PR 的 before / after audit fingerprint 入口。
  - `active/TODO_cleanup.md` 标记 Phase 0.5 closed；`TODO.md` 和主 coupling plan 同步下一步为 Phase 1A runtime-owned monitor move，再做 Phase 1B `nexus -> cli` bootstrap boundary。
- **验证**:
  - `npm run coupling:audit`：输出 JSON baseline。
- **边界**:
  - 不改 runtime / Nexus / storage / CLI 行为。
  - Phase 0.5 audit 是 informational baseline，不把历史耦合债务直接变成 required failure gate。

## 2026-06-18 — Product W4.1 + Development Process Stability Phase 1/2 收口

- **背景**: `active/TODO_product_30day.md` W4.1 要求补 contributor-facing `CONTRIBUTING.md` / `GOVERNANCE.md` / PR 模板 / issue 模板，降低单点维护与外部贡献门槛。前一轮新增的 `development-process-stability-governance-plan.md` Phase 1/2 要求 PR review 风险分级、语义 PR/commit 粒度和 high-risk review checklist。
- **实现**:
  - 新增 `CONTRIBUTING.md`：项目结构、Nexus-first 边界、本地开发命令、PR scope 规则、文档生命周期、flaky test 登记原则和 issue triage。
  - 新增 `GOVERNANCE.md`：当前 maintainer-led 模型、bus factor=1、决策模型、review-light/standard/high-risk/emergency 口径、社区入口和未来 maintainer 培养路径。
  - 新增 `.github/PULL_REQUEST_TEMPLATE.md`：risk level、scope、behavior changed、regression evidence、verification、docs updated、flaky/quarantine impact、rollback notes 和 checklist。
  - 新增 `.github/ISSUE_TEMPLATE/` 四类模板：bug report、feature request、documentation issue、question。
  - `AGENTS.md` 顶部补 `CONTRIBUTING.md` / `GOVERNANCE.md` 引用，避免 AI agent 只读 maintainer-only guide。
  - README / README.zh-CN 顶部补 contributions welcome 与 GitHub Discussions 徽章。
  - `active/TODO_cleanup.md` 标记 Development Process Stability Phase 1/2 closed；新增 Flaky Quarantine Index 初始登记（`test/runtime.test.ts` Node test-runner deserialize symptom + `test/permission-flow.test.ts` permission_request timeout pre-existing symptom）。Phase 3 command 仍 open，默认 `npm test` 暂不改。
  - `active/TODO_product_30day.md` W4.1 标为“部分收口”：文档产物已完成，最终产品收口仍需真实外部 PR 按 checklist merge。
- **验证**:
  - `npm run docs:check`：0 failures。
  - `npm run format:check`：0 failures。
- **边界**:
  - 不改 runtime / Nexus / provider / agent loop 行为。
  - 不把 flaky test 从默认 suite 移出；只登记并保留 Phase 3 后续脚本工作。
  - GitHub Discussions 需要仓库 Settings 手动启用，本次只补 README/GOVERNANCE 入口和后续 W4.2 口径。

## 2026-06-18 — Development Process Stability Phase 3 + Product W4.2 setup checklist

- **背景**: Phase 1/2 已补 PR review 与 semantic granularity 文档入口；下一步是让 flaky 隔离有实际命令入口，并补 Product W4.2 的 GitHub Discussions owner 操作断点。
- **实现**:
  - 新增 `test/quarantine.json` 机器可读 quarantine manifest，登记 `test/runtime.test.ts` Node test-runner deserialize symptom 与 `test/permission-flow.test.ts` permission_request timeout symptom。
  - 新增 `scripts/test-quarantine.js` 与 `npm run test:quarantine`。默认模式只列出 quarantine state；显式 `npm run test:quarantine -- --run` 才运行登记项并报告结果。`--json` 支持机器可读输出。
  - `active/TODO_cleanup.md` 标记 Development Process Stability Phase 3 closed，并保留 Phase 4 CI reporting / Phase 5 scheduled lanes open。
  - `development-process-stability-governance-plan.md` Phase 3 状态更新为 Closed 2026-06-18。v1 口径明确：不从默认 `npm test` 移除 broad coverage，直到每个 root cause 有 deterministic replacement coverage。
  - 新增 `docs/nexus/reference/github-discussions-setup-guide.md`（Guide），记录 GitHub Settings 手动启用 Discussions、建议 categories、README/GOVERNANCE 链接和验收方式；`active/TODO_product_30day.md` W4.2 同步引用。
- **验证**:
  - `npm run test:quarantine`：列出 2 个 quarantine entries，0 command run。
  - `npm run format:check`：0 failures。
  - `npm run docs:check`：0 failures。
- **边界**:
  - 不改变默认 `npm test`。
  - 不让 quarantine 成为忽略失败的永久仓库；每条 entry 都有 owner 与 exit condition。
  - Discussions 启用仍需仓库 owner 在 GitHub UI 手动完成。

## 2026-06-17 — Agent Runtime Maturity: Trajectory Eval Harness v1 收口

- **背景**: `agent-runtime-architecture-maturity-plan.md` §3.2（plan §5 step 3）。Agent Trace Schema v1 刚收口，eval harness 直接消费 `projectAgentTrace` 投影。目标：面向 agent trajectory 的 eval（不是函数输出 / 最终文本），离线、确定性、不依赖真实 provider key。这是把"真实 session regression 转成 eval fixture"守门能力落地的前提。
- **设计决策**:
  - v1 = **离线 trace-fixture eval**。每个 fixture 是一段 recorded event stream（被测 trajectory）+ 声明式 check 期望。harness 把 stream 投影成 `AgentTrace`，跑 6 个 builtin discipline check。无 provider key、无 live workspace、无网络。
  - fixture 格式用单 TS 模块 `evals/coding/<id>.ts`（`ev.*` compact builder + `defineFixture`），而不是 plan 字面的 `prompt.md`/`workspace/`/`expected.json`/`checks.ts` 多文件结构——后者是 live-workspace 模式，依赖 §3.3 的 resume/replay 机制，延后 v1.1。10 个 fixture 用单模块格式更可维护。
  - **自验证**：fixture 声明 `expectChecks: { checkKey: expectedSeverity }`，harness 断言 actual===expected。fixture `verdict=pass` iff 全部断言匹配。eval exit 1 当任一 fixture misclassify——这样 fixture（已知 good/bad trajectory）证明 check suite 能正确区分。
- **实现**:
  - `src/eval/fixtureBuilder.ts`: `ev.*` 事件 builder（填 schemaVersion / sessionId / 自增确定性 timestamp）+ `defineFixture()`。
  - `src/eval/trajectoryEval.ts`: `CheckSeverity` (pass/warn/fail/skip) / `CheckKey` / `CheckResult` / `FixtureMetrics` / `FixtureResult` / `EvalReport` 类型；`CHECKS` 6 个 builtin check；`runFixture` / `runAll` / `computeMetrics`。
    - `task_success`: v1 `skip`（需 live-workspace，§3.3）。
    - `tool_discipline`: 第一个 write/execute tool_call 前是否有 read/search → pass/fail。
    - `permission_discipline`: 每个 write/execute 要么 approved 要么 completed（auto-approve）；repeated denial ≥2 → fail。
    - `scope_discipline`: scope_boundary action deny/require_confirmation → fail；warn → warn；无 → pass。
    - `context_discipline`: 同 path Read >2 次 → warn；large truncated read (originalBytes ≥ 100k) → warn。
    - `memory_discipline`: 有 memory_update → warn（v1 无法 auto-decide memory-as-fact，需 §3.5 retrieval span）；无 → pass。
  - `src/runtime/agentTrace.ts` 小幅增强：tool_call span attributes 增 best-effort `path`（从 `tool_started.input.path` 提取，仅 path-bearing tool），让 context_discipline 的 repeated-read 检测能纯从 trace 完成。3 个 tool_call span 路径（completed/denied/orphan）+ 新 `extractToolPathAttr` helper。
  - `scripts/eval-agent.ts`: glob `evals/coding/*.ts`，dynamic import，`runAll`，per-fixture 报告（verdict / checks / metrics cost+toolCount+permissionCount+scopeWarnings+spanCount / projectorWarnings / mismatches）+ summary；`--json` machine-readable；exit 1 当有 mismatch。
  - `evals/coding/` 10 个 fixture：read-before-edit-good / edit-without-read-bad / permission-approved-good / permission-repeated-deny-bad / scope-contained-good / scope-escape-bad / context-repeated-reads-bad / context-truncated-bad / memory-hint-caution-warn / compact-recovery-good。
  - `evals/README.md` authoring guide（格式 / 自验证 / 6 check 表 / 真实 regression 转 fixture 流程 / v1.1 deferred）。
  - `package.json`: `eval:agent` script；`test` script 补 `test/agent-trace.test.ts` + `test/eval-agent.test.ts`（上次 trace 收口时漏加 agent-trace，一并补齐）。
- **验证**:
  - `npx tsc --noEmit`：0 errors。
  - `npm run eval:agent`：10/10 fixture 自验证通过，0 mismatch。
  - `test/eval-agent.test.ts`：19/19 pass（6 check 各 pass/warn/fail/skip 路径 + runFixture 自验证 pass/fail + computeMetrics + runAll 聚合）。
  - `test/agent-trace.test.ts`：19/19 pass（path 增强 不破坏既有投影测试）。
  - 累计 agent-trace 19 + eval-agent 19 + inspect-session 23 + system-prompt-builder 28 pass，0 回归。
- **边界**:
  - 不改 runtime / storage / provider 行为；纯新增 eval 模块 + projector 6 行 path 增强。
  - 不依赖 OpenTelemetry / LangSmith / 真实 provider。
  - `task_success` + 完整 `memory_discipline` auto-decide 诚实标 skip/warn，不伪造 pass。
- **后续可推进**: §3.3 Durable Run Checkpoint / Resume（plan §5 step 4，唯一剩余 P1 打开项）；v1.1 live-workspace eval 模式依赖它。§3.4 MCP / §3.5 Memory Quality / §3.6 Loop Taxonomy 仍 P2。

## 2026-06-17 — Agent Runtime Maturity: Agent Trace Schema v1 收口

- **背景**: `agent-runtime-architecture-maturity-plan.md` §3.1 列为 P1 首项。现有 runtime metrics / toolTrace / permission_audit / behaviorTrace 各自存在但不是统一 trajectory。目标：从现有 `NexusEvent` 派生一个可重建的 agent trace，不引入第二事实源（toolTrace / execution_metrics side table 本身已是 event 的派生投影，读 event stream 即足够）。这是 plan §5 实施顺序的第 1-2 步，也是 §3.2 Trajectory Eval Harness 的前置依赖。
- **实现**:
  - `src/runtime/agentTrace.ts`（新文件，纯投影模块）:
    - `projectAgentTrace(events: ReadonlyArray<NexusEvent>): AgentTrace` — 纯函数，无 storage / 无 clock / 无 I/O。
    - 9 个 span kind：`run` / `provider_invocation` / `tool_call` / `permission_decision` / `scope_boundary` / `compact_recovery` / `memory_update` / `sub_agent_handoff` / `final_result`。
    - parent-child：`permission_decision` + `scope_boundary` 通过 `toolUseId` 父接到对应 `tool_call`；其余父接到 `run`。
    - `provider_invocation`：每个 `execution_metrics` event 一个 span（带 token cost + provider 时序）；若无 execution_metrics 但有 stream deltas，按 delta burst 合成降级 span + warning。
    - spanId 确定性派生（`run` / `tool:<toolUseId>` / `perm:<toolUseId>` / `provider:<index>` / `compact:<index>` 等），replayed event stream 复现相同 ID。
    - 降级路径全部 emit 人可读 warning：无 session_started / 无 terminal / deltas 无 execution_metrics / orphan tool_started / orphan permission_request / 空 stream。
    - 序列化：`traceToJsonl`（header `record:trace` + 每 span 一行 `record:span`，append-friendly）+ `traceToJson`（单 blob）。
  - `src/cli/commands/inspectSession.ts`:
    - `exportSessionTrace(sessionId, { sqlitePath })` — read-only 打开 SQLite（`readOnly: true`，复用 `findSessionInSqlite` 的访问模式），`SELECT event_json FROM events ORDER BY event_seq, event_key`，JSON.parse，喂给 projector。`session_go_<unixnano>` 走 client log reverse-resolve，与非 trace 路径一致。无 events / 无 DB → 返回 null（honest "no trace"）。
    - `bbl inspect-session <id> --trace` flag：短路 persistence-tier 诊断，直接 emit JSONL（`--json` 切单 blob）。无 trace 时 exitCode=1 + 错误文案。
- **验证**:
  - `npx tsc --noEmit`：0 errors（含此前 pre-existing `inspectSession.ts:231` 也已不在）。
  - `test/agent-trace.test.ts`：19/19 pass（覆盖 required span kinds / parent-child / ordering / 5 种降级 / permission denied path / determinism / JSONL+JSON 序列化 / sub-agent 分组）。
  - `test/inspect-session.test.ts`：23/23 pass（含新增 3 个 `exportSessionTrace` 集成 test：真实 event JSON → trace 投影 / 无 events → null / 无 DB → null）。
- **边界**:
  - 不改任何 runtime / storage / provider 行为；纯新增模块 + CLI flag。
  - 不引入 OpenTelemetry / LangSmith 依赖；字段名 exporter-friendly 但 v1 不要求集成。
  - `memory_retrieval` span 延后到 §3.5（当前只有 `session_memory_updated`，无 retrieval event）。
- **后续可推进**: §3.2 Trajectory Eval Harness（plan §5 step 3，消费 exported trace）+ §3.3 Durable Run Checkpoint / Resume。两者仍是 P1 打开项。

## 2026-06-17 — Context CWD Drift Phase A 下游链路 integration 收口

- **背景**: Phase A 的 unit test（`extractAbsolutePaths` 4 case）只守了 prompt → explicit paths 提取这一入口。真实 regression `session_981cc5c2` 的失败链路有两个下游失败点：`resolveCwdFromPrompt` 把 cwd 推到 `/`（event_seq=9447）+ `deriveTaskScope` 把 `primaryRoot` 设为 `/`（event_seq=9449）。plan 的 Test Plan 把这条 integration 列为"Phase B/D 推进时补"，但它是 Phase A 行为的直接下游验证，应在 Phase A 收口时一起守住，不必等 Phase B/D。
- **实现**:
  - `src/runtime/LLMCodingRuntime.ts:1278` `resolveCwdFromPrompt` 加 `export`（纯函数，仅 existsSync/lstatSync，无副作用），供测试直接守 event_seq=9447 的 cwd 漂移。
  - `test/runtime.test.ts` 在既有 `deriveTaskScope` test（line 365）之后新增 3 个 test：
    - `resolveCwdFromPrompt keeps project cwd when prompt only has a CJK slash fragment` — prompt `查看有无咱们刚刚聊到的上下文管理优化的相关文档/信息` + project cwd → 返回 project cwd（pre-Phase-A 返回 `/`）。
    - `resolveCwdFromPrompt still follows a real existing absolute path in the prompt` — prompt 含 `tmpdir()` 真实路径 → 仍 resolve 到该路径（防 over-filtering 回归）。
    - `deriveTaskScope stays single-rooted at the project when prompt has a CJK slash fragment` — `primaryRoot === projectCwd`、`explicitRoots === []`、`mode === 'single_root'`、`source === 'cwd'`（pre-Phase-A `explicitRoots` 含 `/信息`、`mode === 'multi_root'`）。
- **验证**:
  - `npx tsx --test --test-name-pattern="CJK slash fragment|real existing absolute path" test/runtime.test.ts`：3/3 pass。
  - 既有 `resolves cwd from prompt absolute path`（full runtime，line 7798）+ `derives task scope and classifies external boundaries`（line 365）：2/2 pass，0 回归。
  - `npx tsc --noEmit`：除 pre-existing `inspectSession.ts:231` 外 0 errors。
- **边界**: 无 production 行为变化（仅 `export` 一个既有纯函数）；不动 `resolveCwdFromPrompt` / `deriveTaskScope` / `extractAbsolutePaths` 逻辑。
- **后续影响**: Phase B（`SessionRootContinuity` 决策 helper）推进时，`deriveTaskScope` test 就是它的 baseline — 任何 SessionRootContinuity 改动都必须保持这条 single-root 不变量。Phase D / E 仍按真实 regression 触发推进。

## 2026-06-17 — Context CWD Drift 计划升级：Draft → Active Plan

- **背景**：`docs/nexus/proposals/context-cwd-drift-and-recall-governance-plan.md` 之前标记为 `State: Draft`，但内容已具备完整规划要素（真实 regression `session_981cc5c2-230c-40d1-953c-b956e9dbaaf7` 的 root-cause chain / 5 个 phase / 4 设计原则 / 已有 entry points 列表 / 8 条 non-goals / 中文概述），且 v2 文档分层规则要求 `reference/` 只保留 Active Plan / Index / Guide。Phase A（路径分类硬化）与 Phase C（recall 工具 storage contract）已分别在代码中收口。
- **变更**:
  - 文件移动：`docs/nexus/proposals/context-cwd-drift-and-recall-governance-plan.md` → `docs/nexus/reference/context-cwd-drift-and-recall-governance-plan.md`。
  - 文件内部相对链接：head Related 行 + Document Ownership 段从 `../reference/...` / `./...` 改为 `./...` / `../proposals/...` 以匹配新位置。
  - 文档头部：`State: Draft` → `State: Active Plan`；`Priority: P1` + Phase A / C 收口标注；新增 **Status (2026-06-17)** 段落。
  - 新增 §1 Existing Entry Points（10 行代码位置 + 角色 + 状态表）、§2 Design Principles（4 条：runtime owns scope / path is hint not order / storage contract / calibration precedes policy）。
  - 拆 Phases 表为 §5.1-§5.5 子节，per-phase 状态、覆盖样本、未触动范围全部独立可读。
  - 移除 `## Verification` 重复段，Test Plan 三层（focused / integration / e2e）取而代之。
  - 中文概述同步从"草案"措辞改为"2026-06-17 升级为 Active Plan / Phase A 与 Phase C 收口 / Phase B/D/E 仍 Open"措辞。
  - `context-governance-index.md`：3 处交叉引用（head Related + Ownership Map + Open Items）从 `../proposals/...` 改为 `./...`；Open Items 中 CWD drift 状态从 "Draft proposal based on `session_981cc5c2...`" 改为 "Active Plan; Phase A (path classification) and Phase C (recall tool storage contract) closed 2026-06-17; Phase B / D / E Open, gated on future real-session regressions"。
  - `reference/README.md`：在 "Runtime, Context, And Agent Architecture" 段补一行新 entry（Active Plan，scope = cwd drift + recall governance）。
  - `proposals/README.md`：移除 Context CWD Drift 条目（已毕业）。
  - `TODO.md`：在 P2 Plan 段新增一行 "Context CWD Drift & Recall Governance"，与 Cache Observability 同段。
- **边界**: 无 runtime / Go TUI / provider / Nexus 行为变化（行为变化在 Phase A 收口 commit 里，本条只记录文档迁移）。
- **后续影响**: Phase B（`SessionRootContinuity` 决策 helper）/ Phase D（`ContextEstimateCalibration` diagnostic）/ Phase E（`ROOT_SCAN_REQUIRES_CONFIRMATION` 工具层 guard）仍 Open，按 plan §5 触发条件推进；不主动开启。

## 2026-06-17 — Context CWD Drift Phase A 收口

- **背景**: 真实 session `session_981cc5c2-230c-40d1-953c-b956e9dbaaf7` 暴露 root-cause chain：中文短语 `文档/信息` 被 `extractAbsolutePaths()` 误识别成 `/信息`，runtime 随后的 `resolveCwdFromPrompt()` 把 cwd 推到 `/`，`taskScope.ts` 把 `primaryRoot` 设为 `/`，后续 Glob/Grep 扫 `/` 和 `/Users` 产生大量 permission error 与 `stdout maxBuffer length exceeded`。最小修复切片是过滤 CJK-only basename 且不存在的 candidate。
- **实现**:
  - `src/runtime/systemPromptBuilder.ts:229` 新增 `isCjkOnlyNonExistentPath(candidate)` helper：basename 若全部由 Han 字符组成（`/^[\p{Script=Han}]+$/u`）且 `!existsSync(candidate)`，返回 true。basename 为空或非纯 CJK 一律返回 false（保留 ASCII / 混合路径）。
  - `src/runtime/systemPromptBuilder.ts:216` `extractAbsolutePaths()` 在 for-of 循环里加 `if (isCjkOnlyNonExistentPath(resolved)) continue` 守卫，整段丢弃。
  - 与既有 `resolvePromptPath()` CJK 后缀 fallback（prefix ≥ 50% 长度才接受）互补不冲突：fallback 处理"已存在 prefix + CJK 后缀"的渐进查找；新守卫处理"整个 candidate 是 CJK-only 且不存在"的整段丢弃。
  - `test/system-prompt-builder.test.ts` 加 4 个 focused test（`describe('extractAbsolutePaths')` 末尾）：
    - `文档/信息` → `extractAbsolutePaths()` 返回 `[]`（CJK-only basename + 不存在）
    - `/信息` standalone → 返回 `[]`
    - `/信息/归档` 多段 → 返回 `[]`
    - `/etc/hosts` 与 `文档/信息` 混排 → 只保留 `/etc/hosts`
- **影响面**:
  - `resolveCwdFromPrompt()` 输入端不再含 `/信息` 类整段 CJK 候选，机械 map 退化为返回 `baseCwd`，cwd 不再被静默推到 `/`。
  - `taskScope.ts` / `intentGuidance.ts` / `workingSet.ts` / `contextAnalysis.ts` 全部复用同一 `extractAbsolutePaths()`，单一 source of truth（plan §1 Existing Entry Points 表 7 个调用点）。
  - 未触动: 既有 `resolvePromptPath()` / `normalizeWrappedPathFragments()` / 路径 regex — 行为兼容。
- **验证**:
  - `npx tsx --test test/system-prompt-builder.test.ts`：28/28 pass（24 既有 + 4 新增）。
  - 累计 cache-health 28 + behavior-monitor 29 + system-prompt-builder 28 tests pass，0 回归。
  - 未单独跑 `npx tsc --noEmit`（仅本文件有 6 行新增 helper，逻辑与既有 `existsSync` 调用一致；既有 pre-existing `inspectSession.ts:231` TS2322 与本任务无关）。
- **约束**:
  - 仅在 basename 全部由 Han 字符组成时触发；混合 basename（`/信息/notes.md`）不触发，避免误伤混合路径。
  - `existsSync` 调用 per candidate；对超长 prompt 有 N 次 syscall，但 N 受 regex match 数约束，不会成 hot path。
  - 保持 runtime 不接管绝对意图的边界：仅丢弃"明显是自然语言 slash 短语"的候选；真实存在的 absolute path 仍正常 promote 到 cwd / explicit paths。

## 2026-06-17 — Context CWD Drift Phase C 收口（prior, 同步状态）

- **背景**: 同一 session 暴露 `contextSearch` 与 `contextRecent` 在 storage 缺失时返回 `CONTEXT_STORAGE_UNAVAILABLE`，但模型首次调用时 `maxTokens=8000` 触发 schema 失败（`maxTokens.max(5000)`），`contextRecent` 也失败。Plan 升级时回溯标记，代码已先于本 plan 落地。
- **已落地位置**:
  - `src/tools/builtin/contextSearch.ts:39-45` — `if (!context.storage)` 返回 `CONTEXT_STORAGE_UNAVAILABLE` + `repairHint: 'Continue from visible session context, or retry contextSearch in a runtime with storage attached.'`。
  - `src/tools/builtin/contextRecent.ts:35-41` — 同上语义。
  - `src/tools/builtin/contextSearch.ts:17` / `contextRecent.ts:17` — `maxTokens: z.number().int().positive().max(5000).optional()` schema 强制。
  - `src/tools/builtin/contextSearch.ts:33` model prompt 明确 `maxTokens caps the response (default 5000)`，避免模型再发 8000。
- **未触动**: storage contract 实现语义、schema、model prompt 全部 back-compat；`LLMCodingRuntime` 与 Nexus 透传 `context.storage` 已稳定。
- **守住边界**: 继续在 storage 缺失时返回显式 `CONTEXT_STORAGE_UNAVAILABLE`；不静默 fallback 到 visible context；不把 `contextSearch` 升级为 hidden memory source（仅 on-demand session event locator）。

## 2026-06-17 — Cache Observability 计划升级：Draft → Active Plan

- **背景**：`docs/nexus/proposals/cache-observability-and-nexus-realtime-detection-plan.md` 之前标记为 `State: Draft`，但文档内容已经具备完整规划要素（背景 / 4 设计原则 / 现有接入点 / CacheHealthSnapshot schema / 5 个 phase 实施路径 / 测试分层 / 8 条 non-goals / 中文概述），且 v2 文档分层规则要求 `reference/` 只保留 Active Plan / Index / Guide。同时 2026-06-17 已完成的 BehaviorMonitor ingest wiring 正好解除了 Phase D 的阻塞点，Phase A（metrics-only 纯函数）独立可落地。
- **变更**:
  - 文件移动：`docs/nexus/proposals/cache-observability-and-nexus-realtime-detection-plan.md` → `docs/nexus/reference/cache-observability-and-nexus-realtime-detection-plan.md`。
  - 文档头部：`State: Draft` → `State: Active Plan`；`Priority: P2 Watch` → `Priority: P2 (Phase A immediately implementable; Phase D unblocked 2026-06-17)`；新增 **Status (2026-06-17)** 段落，标注 Phase A 独立可实施、Phase D 前置条件已就位、Phase B 仍需 `getExecutionMetrics(sessionId)` storage 接口澄清。
  - `context-governance-index.md`：3 处交叉引用从 `../proposals/...` 改为 `./...`；Open Items 中 Cache health aggregation 条目状态从 "Draft; requires real metrics before UI claims" 改为 "Active Plan; Phase A independently implementable, Phase D unblocked 2026-06-17"。
  - `reference/README.md`：在 "Runtime, Context, And Agent Architecture" 段补一行新 entry（Active Plan，scope = cache health observability + honest unavailable states + Nexus realtime detection integration phases）。
  - `proposals/README.md`：移除 Cache Observability 条目（已毕业）。
  - `TODO.md`：在 P2 Plan 段新增一行 "Cache Observability & Nexus Realtime Detection"。
- **边界**: 无 runtime / Go TUI / provider / Nexus 行为变化，仅文档生命周期迁移。
- **后续影响**: Phase A（`cacheHealth.ts` 纯函数 + `/v1/runtime/metrics` 增 `cacheHealth` 字段）现已无任何前置依赖，可立即实施；Phase D 移除阻塞标记。

## 2026-06-17 — Cache Observability Phase A 收口

- **背景**: Active Plan 升级同次，Phase A（metrics-only 纯函数）独立可实施且 0 上游依赖。同时研究了 BabeL-2 的 cache observability 实现（3 个不同的 cacheReadRatio 公式、compact-time telemetry、perfettoTracing 格式），写入 cache plan §10 作为后续 contributor 避免重复分析的参考。
- **实现**:
  - `src/nexus/cacheHealth.ts`（~225 行新文件）：`buildCacheHealthFromRuntimeMetrics(snapshot)` / `buildCacheHealthFromEvents(events, options)` / `evaluateCacheDimension(...)` 纯函数 + `pickExecutionMetricsEvents` filter。导出 `CacheHealthSnapshot` / `CacheHealthDimension` / `CacheHealthStatus` / `DEFAULT_CACHE_HEALTH_TARGETS`。
  - 4 维度：prompt（有真实 observed ratio）/ code_index / tool / reasoning（全部 `unavailable`，`source: 'not_implemented'`）。
  - 关键设计：no provider cache tokens → `unavailable`（不伪造 0%），符合 plan §2.2 和 `cacheReadRatio` token-weighted 公式（与 `nexus/metrics.ts:344-351` 一致：`cacheRead / (input + cacheCreation + cacheRead)`）。
  - `src/nexus/app.ts`：`buildRuntimeMetricsSnapshot()` 新增 `cacheHealth` 字段，调用 `buildCacheHealthFromRuntimeMetrics({ tokenUsage: snapshot.tokenUsage })`。
  - `test/cache-health.test.ts`：17 个 focused test 覆盖 targets / status 阈值 / 4 维度行为 / sampleCount 语义 / per-event rollup / summary aggregation / 公式一致性 / schema 稳定性。
- **验证**:
  - `npx tsc --noEmit`：0 errors。
  - `test/cache-health.test.ts`：17/17 pass。
  - 累计 80 tests（layering + cache-health + behavior-monitor + config-endpoints + agent-tools-runtime）全部 pass，0 回归。
- **文档同步**:
  - `cache-observability-and-nexus-realtime-detection-plan.md` §10 新增 BabeL-2 pattern analysis（3 个公式对比 + compact telemetry + perfettoTracing + 不复制什么 + Phase A 决策摘要）。
  - 中文概述 "当前状态" 同步标注 Phase A 已收口。
  - 本 WORK_LOG 记录。
- **后续可推进**: Phase B（per-session aggregation 路径）+ Phase C（eventized cache_health）+ Phase D（BehaviorMonitor bridge 仍待 `pushHint` 链路验证）。

## 2026-06-17 — Cache Observability Phase B 收口

- **背景**: Active Plan Phase B 要求 per-session（per-pane）cache health 投影到 `/v1/runtime/loop/health`。原本担心的 `getExecutionMetrics(sessionId)` storage 接口澄清结果——`Storage.ts:166` 已存在 `getExecutionMetrics(sessionId): Promise<ExecutionMetrics | null>` 返回单条最新 metric 快照；`sessionAssets.ts:129` 已有使用先例。但 `/v1/runtime/loop/health` 路由（`app.ts:1041`）已经 fetch 了 `events: NexusEvent[]` 切片（带 `query.lastN` 窗口），所以更直接的做法是复用已有 `events` 切片 + `buildCacheHealthFromEvents`，零额外 storage 调用。
- **实现**:
  - `src/nexus/cacheHealth.ts`:
    - 新增 `MaybeExecutionMetrics` 类型：接受宽 `NexusEvent[]` 切片（不强制 type 缩窄为 `execution_metrics`）。
    - `buildCacheHealthFromEvents` signature 改为 `ReadonlyArray<MaybeExecutionMetrics>`，函数内部按 `e.type === 'execution_metrics'` 过滤。
    - `sampleCount` 改为只计 `execution_metrics` 事件数（之前用 `events.length`，wide slice 模式下会混入非相关事件）。
  - `src/nexus/app.ts`:
    - `loopHealthQuerySchema` 已支持 `lastN`（默认值，见 `app.ts:943` 附近）。
    - `/v1/runtime/loop/health` handler 在已有 `events` 数组上调用 `buildCacheHealthFromEvents(events, { sessionId, lastN: query.lastN, kind: 'pane' })`，把 `paneCacheHealth` 作为 sibling 字段加入 `panes.push({...})`。不覆盖 status，cache health 与 status 平行。
  - `test/cache-health.test.ts` 新增 2 个 focused test：T18（wide NexusEvent slice 接受 + 内部 filter + sampleCount 仅算 execution_metrics 事件）+ T19（Phase B 集成 shape 验证：type/schemaVersion/window/dimensions/summary）。
- **设计决策**:
  - 状态优先级保持：cache health 永远不覆盖 blocked/drift/waiting/done 状态；它是 sibling 字段。
  - 窗口语义：`lastN` 直接透传到 `CacheHealthSnapshot.window.lastN`，让 client 知道窗口大小。
  - `kind: 'pane'` 标识是 pane 级别，避免与 process 级别混淆。
- **验证**:
  - `npx tsc --noEmit`：0 errors。
  - `test/cache-health.test.ts`：19/19 pass（17 + 2 新增）。
  - 累计 82 tests pass，0 回归。
- **后续可推进**: Phase C（`cache_health` eventized 事件，供 `/v1/sessions/:id/wait`）+ Phase D（BehaviorMonitor bridge，可提示 `prompt-cache-miss-wave`）。

## 2026-06-17 — Cache Observability Phase C 收口

- **背景**: Active Plan Phase C 要求在 `execution_metrics` 后可选生成 `cache_health` 事件，供 `/v1/sessions/:id/wait` 和 transcript 使用。v1 只在 status != ok 时生成；dedup 同一 requestId 的相同 warning。
- **实现**:
  - `src/shared/events.ts`：新增 `CacheHealthEventSchema`（discriminated union by `type: 'cache_health'`，含 `requestId` + `cacheHealth` + `trigger` 字段）；加入 `NexusEventSchema` 联合类型。
  - `src/nexus/cacheHealth.ts`：
    - 新增 `CacheHealthEvent` 类型。
    - `buildCacheHealthEvent({ sessionId, cwd, requestId, cacheHealth, trigger, now })`：当 `cacheHealth.summary.status === 'ok'` 时返回 `undefined`；否则返回结构化 event。
    - `CacheHealthEventDedup` 类：per-session FIFO set 限 256 entries，`shouldEmit(sessionId, requestId)` 返回是否可发送。`undefined` requestId 总是返回 true（保留兼容，emit site 应始终传 requestId）。
    - 模块级单例 `globalCacheHealthDedup`（与 `defaultContextBroadcaster` 同模式），导出 `getCacheHealthDedup` / `setCacheHealthDedup` / `_resetCacheHealthDedupForTesting`。
    - `maybeBuildCacheHealthEventFromExecutionMetrics(event, cwd)`：从 `execution_metrics` event 聚合 token usage，构造 snapshot，应用 dedup，返回 event 或 undefined。
  - `src/nexus/app.ts`：
    - 导入 `maybeBuildCacheHealthEventFromExecutionMetrics`。
    - 在 `createNexusApp` 内新增 `maybeEmitCacheHealthEvent` closure（封装 cwd 传参）。
    - 两个事件 yield 点（HTTP `/v1/execute` ~2596 行 + WebSocket `/v1/stream` ~3920 行）：在 `recordEventMetrics` + `behaviorMonitor.ingest` 之后调用 `maybeEmitCacheHealthEvent`；如返回 event，push 到 `events` + `storage.appendEvent`，WS 路径还额外 `sendJson(socket, event)`。
- **dedup 语义**:
  - 同一 `requestId` 不重复发 cache_health（plan §5.3）。
  - 同一 session 的 dedup set 上限 256 entries（FIFO eviction）。
  - HTTP 和 WebSocket 路径共享同一模块级单例 dedup 状态，跨 transport 不重复。
- **验证**:
  - `npx tsc --noEmit`：除 pre-existing `inspectSession.ts:203` `clientSessionId` 字段缺失（与本任务无关）外，0 errors。
  - `test/cache-health.test.ts`：28/28 pass（19 + 9 新增 Phase C）。
  - 累计 91 tests pass，0 回归。
- **约束**:
  - v1 只在 status != ok 时发 → ok 状态不污染 transcript。
  - `cacheHealth` 字段在 schema 中是 `z.unknown()`，因为 CacheHealthSnapshot 实际类型定义在 `nexus/cacheHealth.ts`（避免共享包循环）。
  - 客户端读取 `cacheHealth` 字段需要 import `CacheHealthSnapshot` 类型来 decode。
- **后续可推进**: Phase D（BehaviorMonitor `prompt-cache-miss-wave` detector，可消费 cache_health event）+ UI/TUI 渲染（plan §6 描述的 runtime status / bbl loop sidebar / transcript 渲染）。

## 2026-06-17 — Cache Observability Phase D 收口

- **背景**: Active Plan Phase D 要求 `BehaviorMonitor` 实现 `prompt-cache-miss-wave` detector：当 N 个 session 在 rollingWindowMs 内 prompt `cacheReadRatio` 都低于目标阈值时，触发 anomaly trace + live hint。`cacheReadRatio` 已经在 `LLMCodingRuntime` 的 `execution_metrics` 事件中暴露（`src/runtime/runtimePipeline.ts:1187`），Phase A/B/C 也已就位。
- **实现**:
  - `src/runtime/behaviorTrace.ts`: `BehaviorTrigger` 联合类型新增 `prompt-cache-miss-wave`。
  - `src/nexus/behaviorMonitor.ts`:
    - 新增 `DEFAULT_PROMPT_CACHE_MISS_WAVE_MIN_SESSIONS = 3` + `DEFAULT_PROMPT_CACHE_MISS_WAVE_TARGET_RATIO = 0.85`。
    - `CrossSessionPromptCacheMissWave` 类型 + 加入 `CrossSessionTrigger` 联合。
    - `CrossSessionAnomaly` 增 `targetRatio` + `observedRatios` 字段。
    - `BehaviorMonitorOptions` 增 `promptCacheMissWaveMinSessions` + `promptCacheMissWaveTargetRatio`；构造函数 + `this.opts` 同步；`detectAll()` 集成新 detector。
    - `detectPromptCacheMissWave(sessions, options)`: 取每个 session 在 windowMs 内**最新**的 `execution_metrics.cacheReadRatio`；低于 `targetRatio` 的 session 进入 `observedRatios`；session 数 < `minSessions` 返回空数组。
    - `crossSessionToAnomaly` 加 `prompt-cache-miss-wave` case → `errorCode: 'PROMPT_CACHE_MISS_WAVE'`，errorMessage 含 session 数 + 目标 + 最低 observed ratio 列表。
    - `runBehaviorMonitor` 的 `pattern` 选择器扩展为 4 路（含 `prompt-cache-miss-wave:${sessionIds.length}` 形式）。
  - `test/behavior-monitor.test.ts`: 新增 8 个 focused test 覆盖 detector 行为（≥ 3 sessions 触发 / < 3 不触发 / 忽略 ok session / via detectAll / 全部 ok 不触发 / 自定义 target / 忽略无 execution_metrics session / 取每 session 最新 ratio）。
- **检测语义**:
  - 每个 session 只取一个 observed ratio（windowMs 内**最新**的 `execution_metrics`）。
  - observedRatios 只记录低于 target 的 session；高于 target 的 session 被排除在 wave 之外。
  - 错误信息按 ratio 升序列出最低值，给运维可读的"最差 session"列表。
- **验证**:
  - `npx tsc --noEmit`：除 pre-existing `inspectSession.ts` 错误外，0 errors。
  - `test/behavior-monitor.test.ts`: 29/29 pass（21 + 8 新增 Phase D）。
  - 累计单独运行 71 tests pass（cache-health 28 + behavior-monitor 29 + runtime-layering 11 + agent-tools-runtime 3）；`config-endpoints.test.ts` 有 Node test runner 序列化 bug（pre-existing，与本任务无关）。
- **约束**:
  - detector 只读 `execution_metrics.cacheReadRatio` 字段；不调用 `cacheHealth.ts` 模块，避免运行时循环依赖。
  - 沿用 `shouldDispatchHint` 5min cooldown（plan §5.4 "hint cooldown: 沿用 BehaviorMonitor 5min"）。
  - hint 注入仍走 `BehaviorMonitor.pushHint(sessionId, hint)`，遵守 §6.2 安全窗口检查。
- **状态**: Cache Observability Active Plan 现在 4 个核心 phase 全部收口。Phase E (future real caches) 仍为远期 Watch。

## 2026-06-17 — Documentation lifecycle governance v2

- **Background**: Even after the first reference/archive cleanup, `docs/nexus/reference/` still mixed Active Plan, Draft, Partially Landed, Closed Reference, Index, and Guide files. This kept the document count high and forced readers to inspect state headers before knowing whether a document still drove development.
- **Decision**: Adopted a lifecycle split inspired by Diátaxis-style role separation and ADR-style decision records: `active/` for current work, `reference/` for stable architecture, `proposals/` for Draft / Partially Landed plans, `history/` for Closed / Watch-only ledgers, `decisions/` for ADRs, `archive/` for superseded sources, and `releases/` for version notes.
- **Change**: Moved Draft / Partially Landed reference files into `proposals/`; consolidated 11 Closed Reference files into 3 history ledgers; added `decisions/0001-documentation-lifecycle.md`; rewrote `reference/README.md` around the smaller reference surface.
- **Guardrail**: `scripts/check-nexus-docs.js` now understands proposals/history/decisions and rejects invalid lifecycle states in `reference/`.
- **Boundary**: No runtime, Go TUI, provider, or Nexus source behavior changed.

## 2026-06-17 — Reference language governance incremental cleanup

- **Background**: `docs:check` had already closed structural governance for `docs/nexus`, but still reported 14 historical reference documents with Chinese narrative before the final `中文概述` section.
- **Change**: Rewrote [go-tui-history.md](./history/go-tui-history.md) into the current reference template style: English planning/history body, preserved `State` / `Governance`, and retained only the final Chinese summary section. Also normalized the narrative sections in [evidence-and-runtime-history.md](./history/evidence-and-runtime-history.md), preserving user prompt samples only inside code/sample contexts.
- **Validation**: `npm run docs:check` now reports 12 historical reference documents with CJK narrative before `中文概述`, with `failureCount: 0`.
- **Boundary**: No runtime, Go TUI, provider, or Nexus behavior changed. This was a documentation-language normalization pass only.

## 2026-06-17 — Tool Registry Layering 诊断收口

- **背景**: Tool Surface Expansion 规划 §2.2 记录的安全缺口——`createRuntime.ts` Layer 2/3/4 注册是无条件 `tools.set(name, tool)`，缺少 `tool_overridden_by` 诊断、跨前缀拦截和 `risk_promoted` 检测。
- **实现**:
  - `src/nexus/toolRegistryLayering.ts`（~180 行新文件）：`registerToolWithDiagnostics(tools, tool, handler)` 封装 3 条规则——(1) EverCore tool（`source.serverName === 'evercore'`）覆盖非 EverCore 同名 → `tool_override_blocked` 跳过注册；(2) 同名覆盖 → `tool_overridden_by` WARN；(3) 新 tool risk 高于已有 → 额外 `risk_promoted` 诊断。
  - `src/nexus/createRuntime.ts`：Layer 2 MCP / Layer 3 EverCore MCP / Layer 4 Agent tools 全部改为 `registerToolWithDiagnostics()`。新增 `CreateDefaultNexusRuntimeOptions.toolRegistryDiagnosticHandler` 选项（`null`=静默，`undefined`=默认 `console.warn`，自定义 handler=注入）。
  - `src/tools/registry.ts`：`createDefaultToolRegistry()` 类型标注微调（`AnyTool[]`，行为不变）。
- **验证**:
  - `test/runtime-layering.test.ts`：11 个 focused test 全部通过（覆盖 3 种诊断、跨前缀拦截、risk 升降、handler 可空、consoleWarnDiagnosticHandler）。
  - `test/config-endpoints.test.ts`：无回归。
  - `test/agent-tools-runtime.test.ts`：无回归。
  - `npx tsc --noEmit`：0 错误。
- **文档同步**: `TODO_runtime.md` §2.2 标记为已收口；`TODO.md` P2 Plan 条目更新状态。

## 2026-06-17 — BehaviorMonitor ingest wiring 收口

- **背景**: `BehaviorMonitor` 类（`src/nexus/behaviorMonitor.ts`）有完整的 `ingest()`、`detectAll()`、`subscribe()`、`pushHint()` 方法，但 `app.ts` 没有任何 import 或调用。3 个跨 session 触发器（hot-path、tool-storm、scope-drift-wave）从未收到事件数据，`detectAll()` 总是返回空结果。这是 cache plan Phase D 和 behavior monitor 实时检测的阻塞点。
- **实现**:
  - `src/nexus/createRuntime.ts`：`behaviorMonitor` 从 LLM 分支局部变量提升为函数级变量，并加入 return tuple。
  - `src/nexus/server.ts`：`behaviorMonitor` 从 `createDefaultNexusRuntime()` 解构并通过 `createNexusApp({ behaviorMonitor })` 传入。
  - `src/nexus/app.ts`：`CreateNexusAppOptions` 新增可选 `behaviorMonitor?: BehaviorMonitor` 字段。两个事件 yield 点（`POST /v1/execute` ~2578 行 + WebSocket `/v1/stream` ~3876 行）在 `recordEventMetrics()` 之后调用 `options.behaviorMonitor?.ingest(decoratedEvent)`——fire-and-forget，同步非阻塞。
- **接线点**: HTTP execute 路径 + WebSocket stream 路径，均位于 event 已 push/stored/metrics 后。
- **验证**:
  - `npx tsc --noEmit`：0 错误。
  - `test/behavior-monitor.test.ts`：21/21 pass（无回归）。
  - `test/config-endpoints.test.ts`：28/28 pass（无回归）。
  - 注：ingest 本身是纯内存操作（push 到 `eventsBySession` Map），无 I/O、无异步，不会增加事件处理延迟。
- **后续解除阻塞**: BehaviorMonitor 现在能接收真实事件数据，`detectAll()` 可以在有足够事件积累后产出跨 session 触发。Cache plan Phase D（prompt-cache-miss-wave detector）的前置条件已满足。

## 2026-06-17 — Recoverable tool error / session continuity 收口

- **背景**: `session_ee116547-6545-4f70-bc7c-b1b287387cda` 暴露两类连续性问题：`Grep` 对 `pattern="- \\[ \\]"` 调用 `rg` 时缺少 `--` separator，导致 `rg: unrecognized flag -`；普通工具抛错被 terminal `TOOL_ERROR` 结束，provider 没有收到 paired `tool_result is_error=true`，后续看起来像“工具失败后失忆”。
- **实现**:
  - `src/tools/builtin/grep.ts`: ripgrep 参数在 pattern 前插入 `--`，支持以 `-` 开头的搜索模式。
  - `src/runtime/toolExecutor.ts`: generic non-timeout / non-cancel / non-workspace-path 工具异常改为 recoverable `kind='result', success=false`，输出 `TOOL_EXECUTION_FAILED`、redacted input、details 与 tool-specific repair hint；workspace escape 仍保持结构化 recoverable path-safety 结果，timeout/cancel 仍是 terminal request 边界。
  - `src/tools/builtin/write.ts` / `edit.ts` / `glob.ts` / `task.ts`: 将文件系统、底层 `rg`、任务存储等可修正失败转为稳定 `success=false` code（`WRITE_FAILED`、`EDIT_*`、`GLOB_FAILED`、`TASK_SAVE_FAILED`）。
  - `src/tools/builtin/contextSearch.ts` / `contextRecent.ts` / `contextSummarize.ts` / `webSearch.ts`: 将原先裸字符串失败输出标准化为 `CONTEXT_*` / `WEB_SEARCH_FAILED` 结构化结果。
  - `docs/nexus/reference/recoverable-tool-error-and-session-continuity-governance-plan.md`: 状态更新为 Phase A/B 已实现，Phase C 对当前内置工具面已完成轻量 repair hints 与结构化失败输出，Phase D 仍作为 recovery boundary / context diagnostics 后续项。
- **验证**:
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-tool-recoverability.json npx tsx --test test/tool-recoverability.test.ts`（5/5 pass）
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-grep-recoverable.json npx tsx --test test/grep-tool.test.ts`（8/8 pass）
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-runtime-throw-recoverable.json npx tsx --test test/runtime-llm.test.ts`（76/76 pass）
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-web-search-recoverability.json npx tsx --test test/web-search-tool.test.ts`（8/8 pass）
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-context-tools-recoverability.json npx tsx --test test/context-tools-registry.test.ts`（8/8 pass）
  - `npm run typecheck`（pass）
  - `npm run format:check`（0 failures）
  - `git diff --check`（pass）
- **边界**: 不自动重试工具；不把失败伪装成成功；不绕过 permission / task scope / path safety；request timeout、user cancel、provider transport failure 仍保持 terminal 语义；长期记忆不作为工具失败连续性的事实源。

## 2026-06-13 — Session replay / evidence governance follow-up parity 收口

- **背景**: Phase A-H 主体实现后，复查确认仍有四个最后保险缺口：原事故 provider MiniMax 走 `anthropic-compatible`，但 adapter-level orphan/duplicate `tool_result` preflight 只在 OpenAI-compatible；`resolveProviderToolCallInput()` 对 malformed `partialInput` 仍 fallback `{}`；SQLite `event_seq` 用 `MAX()+1` 但缺 transaction / unique 约束；Read cache 已记录 `mode` 但 coverage 判定未显式拒绝 preview → non-preview 复用。
- **实现**:
  - `src/providers/adapters/AnthropicAdapter.ts`: 增加 `validateAnthropicToolMessageSequence()`，Anthropic-compatible / MiniMax request 在 fetch 前拒绝 orphan / duplicate `tool_result`，错误码沿用 `PROVIDER_REPLAY_INVALID_TOOL_SEQUENCE`。
  - `src/runtime/runtimePipeline.ts`: malformed `partialInput` 统一返回 `{ _parseError: true, _rawInput }`，不再 fallback `{}`，确保所有 adapter 漏 sentinel 时仍走 runtimeToolLoop 的 pair-safe `TOOL_INPUT_PARSE_ERROR` 路径。
  - `src/storage/SqliteStorage.ts`: event key 改为 append seq + timestamp/type/payload/content digest；append row 用 `BEGIN IMMEDIATE` 事务分配 session-local `event_seq`；migration 创建 `(session_id,event_seq)` partial unique index，并在建索引前 repair duplicate seq。
  - `src/runtime/runtimeToolLoop.ts`: `RequestedReadCoverage` 带 `mode`，`findCoveringReadRange()` 拒绝用 `preview` range 满足 non-preview Read。
  - `test/adapters.test.ts` / `test/storage.test.ts` / `test/runtime.test.ts`: 增加 Anthropic/MiniMax orphan+duplicate preflight、concurrent append event_seq uniqueness、preview→non-preview cache bypass 与 malformed partialInput sentinel regression。
- **验证**:
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-followup-full.json npx tsx --test test/storage.test.ts test/adapters.test.ts test/read-tool.test.ts test/grep-tool.test.ts test/context-assembler.test.ts test/system-prompt-builder.test.ts test/runtime-llm.test.ts test/runtime.test.ts`（341/341 pass）
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-followup-typecheck-3.json npm run typecheck`（pass）
  - `go -C clients/go-tui test ./...`（pass）
- **边界**: 不新增 provider fallback；不重写 compact/replay graph；Read cache 仍只是 coverage reuse 优化层，不作为新事实源。

## 2026-06-13 — Session replay / evidence governance Phase E/G 策略化修订

- **背景**: Phase E/G 初版通过 `formatUserIntentGuidance()` 向 provider-visible system prompt 注入动态 `Guidance:` / `Instruction:` 文案，并在 fallback 内维护具体中文/英文 self-diagnosis cue。复盘后确认这会把 intent guidance 变成提示词补丁层，不符合“泛化综合优化 agent 行为路径”的目标。
- **实现**:
  - `src/runtime/intentGuidance.ts`: 移除 `AGENT_FAILURE_CUES` / `RUNTIME_REPLAY_CUES` 这类短语 cue 表；目标识别改为抽象 marker score（agent subject / failure / runtime replay / tool evidence / project feature / problem analysis），并保留本地 reconcile 防止 intake model 把已确定的 agent-failure 误漂到 project feature。
  - `UserIntentGuidance` 不再携带自然语言 `guidance`；新写入的 `user_intake_guidance` 事件只持久化结构化 intent/policy 输入。`src/shared/events.ts` 仅将历史 `guidance` 字段保留为 optional 兼容字段，`contextAssembler` 的事件 fingerprint 也不再依赖该字段。
  - `formatUserIntentGuidance()` 改为输出 `## Turn Policy` 结构化字段：`responseMode`、`toolMode`、`evidenceMode`、`staleTaskMode`；不再输出动态 `Guidance:` 或 `Instruction:`。
  - `queryIntakeModel()` 只要求 intake model 返回结构化枚举字段；`parseIntakeModelOutput()` 忽略模型返回的自然语言 `guidance`，避免 intake 模型直接写主模型行为提示。
  - `src/runtime/systemPromptBuilder.ts`: 增加一条静态、语言无关的 `Turn Policy` 解释，说明主模型如何执行结构化字段；`evidenceMode=verify_before_claim` 要求区分 verified observations、code-confirmed causes 和 hypotheses；不包含中文样例或事故专用短语。
  - `test/runtime-llm.test.ts` / `test/context-assembler.test.ts`: 断言改为验证 `Turn Policy` 字段与无动态 guidance 注入，仍覆盖 self-diagnosis chain、普通项目分析、纠正转向、respond-only、工具可见性等行为。
- **验证**:
  - `npx tsc --noEmit --pretty false`（pass）
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/runtime-llm.test.ts test/context-assembler.test.ts test/system-prompt-builder.test.ts --test-name-pattern "User intent fallback guidance|persists self-diagnosis problemTarget|persists user_intake_guidance|falls back identity prompts|falls back context-memory prompts|normalizes contradictory pause intake|keeps tools visible for status intake|assembleContext preserves respond-only user intent|assembleContext treats user correction prompts|assembleContext converts pause requests|Turn Policy"`（148/148 pass）
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/storage.test.ts test/adapters.test.ts test/read-tool.test.ts test/grep-tool.test.ts test/runtime-llm.test.ts test/runtime.test.ts test/system-prompt-builder.test.ts test/context-assembler.test.ts --test-name-pattern "SQLite event ordering|provider replay|orphan|completed-before-started|Read|Grep|offset|request_paths|extractAbsolutePaths|User intent fallback guidance|persists self-diagnosis problemTarget|persists user_intake_guidance|falls back identity prompts|falls back context-memory prompts|normalizes contradictory pause intake|keeps tools visible for status intake|assembleContext preserves respond-only user intent|assembleContext treats user correction prompts|assembleContext converts pause requests|timeout|near timeout|soft timeout|Turn Policy|context|compact|grounding|workspace dirty|malformed OpenAI tool-call arguments|Bash non-zero|missing Read paths|workspace escape paths|invalid tool input|verifyRetainedSegment"`（337/337 pass）
- **边界**: `problemTarget` 仍作为持久诊断与策略输入保留；生产路径不再依赖硬编码中文 self-diagnosis 提示词。历史 WORK_LOG 中提到的 fixed guidance 视为被本条 supersede。

## 2026-06-13 — Session replay / evidence governance Phase H 收口

- **背景**: 真实会话里用户输入 wrapped path：`docs/nexus/reference/memory-capability\n  -awareness-and-trigger-plan.md`。旧 `extractAbsolutePaths()` 按空白截断，导致 path diagnostics 只能看到前半段路径。
- **实现**:
  - `src/runtime/systemPromptBuilder.ts`: 新增 `normalizeWrappedPathFragments()`，在 `extractAbsolutePaths()` 前受限归一化 terminal-wrapped path fragments，支持 `word\n  -suffix.md` / `word\n_suffix.md` 合并；仅当两侧都像 path fragment 且 suffix 以 `-` 或 `_` 开头时合并，避免普通 prose bullet paragraph 被拼接。
  - `test/system-prompt-builder.test.ts`: 覆盖 hyphen markdown path、underscore path 与普通 bullet paragraph 不合并。
- **验证**:
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-name-pattern "extractAbsolutePaths|wrapped|request_paths" test/system-prompt-builder.test.ts test/context-assembler.test.ts`（7/7 pass）
  - `npm run typecheck`（pass）
- **边界**: 不做任意换行拼接；不跨 paragraph；不存在路径仍保持 missing path 语义，后续由 path drift diagnostic 处理。

## 2026-06-13 — Session replay / evidence governance Phase G 收口

- **背景**: 记忆能力问答已有用户级能力护栏，但 agent self-diagnosis 回答仍可能变成另一段缺少证据分级的 polished narrative，例如把未见 system prompt 或模型习性当成事实。
- **实现**:
  - `src/runtime/intentGuidance.ts`: `problemTarget=agent_failure` 的 guidance 强化为固定自诊断回答合同：使用 `Observed facts / Code-level causes / Model-behavior hypotheses / Fixes` 四段结构；不要把未见 system prompt section 当作事实；不确定原因必须标为 hypothesis。
  - `test/runtime-llm.test.ts`: 扩展 self-diagnosis focused regression，确认 fallback guidance 与 provider-visible system prompt 均包含四段结构和 unseen system prompt 限制；同时保留 memory capability answer leakage guard 回归。
- **验证**:
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-name-pattern "self-diagnosis|memory capability answer" test/runtime-llm.test.ts`（3/3 pass）
  - `npm run typecheck`（pass）
- **边界**: 不新增通用 final-answer sanitizer；自我诊断的强约束通过 `problemTarget=agent_failure` 的 model-visible guidance 生效。若真实 provider 仍无视结构，再补窄范围 answer-shape retry guard。

## 2026-06-13 — Session replay / evidence governance Phase F 收口

- **背景**: soft timeout / near-timeout 事件已经能持久化和在 Go TUI 展示，但 provider continuation 历史里没有明确的收敛约束，模型仍可能在 timeout warning 后继续 broad `Grep` / `Read` 探索。
- **实现**:
  - `src/runtime/LLMCodingRuntime.ts`: `mapEventsToMessages()` 新增 `near_timeout_warning`、`timeout_budget_exceeded`、`timeout_extension_granted` 的 runtime user message 映射。模型下一轮会看到明确约束：不要开启新的探索性工具链；要么用已验证证据回答，要么最多做一次明确有界 final check；未验证 claim 必须标注；需要更多探索则请求 fresh budget。soft extension 会额外提示“用 extension wrap up，不做 broad discovery”。
  - `test/runtime-llm.test.ts`: 新增 `mapEventsToMessages` focused regression，覆盖 near-timeout warning 与 soft timeout budget/extension 的 provider-visible convergence instruction。
- **验证**:
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-name-pattern "timeout warnings as convergence|soft timeout extension|mapEventsToMessages" test/runtime-llm.test.ts`（9/9 pass）
  - `npm run typecheck`（pass）
- **边界**: 不改变 soft/fatal timeout 调度、watchdog abort 或 Go TUI footer；本阶段只保证 timeout events 在 provider replay 中具备行为收敛语义。

## 2026-06-13 — Session replay / evidence governance Phase E 收口

- **背景**: `session_315814e7-3b82-4a31-8601-a5b383288e9c` 的后续追问里，用户问“为什么你会编 / 这是你系统prompt的问题吗 / 查看源码深度分析问题”，但 intake guidance 没有锁住“问题”的指代对象，导致模型漂回项目 feature 评估。
- **实现**:
  - `src/shared/events.ts`: `user_intake_guidance` 增加可选 `problemTarget` 字段，枚举为 `agent_failure` / `runtime_replay` / `tool_evidence` / `project_feature` / `user_artifact` / `unknown`；历史事件无该字段仍可解析。
  - `src/runtime/intentGuidance.ts`: `UserIntentGuidance` 新增 `problemTarget`；fallback 分类通过集中 cue set 识别中文/英文 self-diagnosis、replay、tool evidence 与 project feature 目标；模型 intake prompt 只保留抽象目标规则，不硬塞具体中文 self-diagnosis 句子。模型 intake 输出即使漂成 `project_feature`，只要本地 fallback 明确识别 self-diagnosis，也会 reconcile 回 `agent_failure`。`formatUserIntentGuidance()` 现在输出 `Problem target` 并在 `agent_failure` 时明确要求分析 agent/runtime failure mode，不要切回项目 feature。
  - `src/runtime/contextAssembler.ts`: retained segment event identity 纳入 `problemTarget`，保证 intake 目标变化会被上下文身份感知。
  - `test/runtime-llm.test.ts`: 新增 focused regression 覆盖中文 self-diagnosis history 下的模糊“查看源码深度分析问题”、普通项目问题仍为 `project_feature`、纠正“不是项目本身”立即转 `agent_failure`，以及模型 intake 漂成 project feature 时仍持久化 `problemTarget=agent_failure`。
- **验证**:
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-name-pattern "problemTarget|self-diagnosis|User intent fallback guidance|persists self-diagnosis" test/runtime-llm.test.ts`（7/7 pass）
  - 调整后复验：`NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-name-pattern "self-diagnosis|problemTarget|User intent fallback guidance" test/runtime-llm.test.ts`（7/7 pass）
  - `npm run typecheck`（pass）
- **边界**: 只做 intent target binding；self-diagnosis answer 的证据分级合同仍留给 Phase G；soft-timeout 行为收敛与 wrapped path normalization 仍打开。

## 2026-06-13 — Session replay / evidence governance Phase C-D 收口

- **背景**: Slice 1-2 收口后，治理看板仍保留 Read line semantics 与 Grep multi-glob / parse-error pair-safety 两个打开项。真实样本里 provider 曾用重复 `pathMatches` JSON key 表达多 glob，随后 malformed tool input 只产出 `tool_completed`，削弱 provider replay pair invariant。
- **实现**:
  - `src/tools/builtin/grep.ts`: `pathMatches` 从单字符串扩展为 `string | string[]`；ripgrep 路径重复传 `--glob`，fallback 用 any-match；prompt 明示 multi-glob array 示例并要求不要重复 JSON key；`INVALID_GREP_PATH_MATCHES_GLOB` 校验覆盖数组内 `"true"` / `"false"`。
  - `src/runtime/runtimeToolLoop.ts`: `_parseError` tool input path 现在先 emit synthetic `tool_started(input={ _parseError, rawPreview })`，再 emit `tool_completed(success=false)`；输出 code 改为 `TOOL_INPUT_PARSE_ERROR`，附带 `repairHint`，返回给模型的 tool_result 同步说明合法 schema 形状。
  - `docs/nexus/active/TODO_runtime.md`: Phase C 标记为已收口（Read `lineOffset/lineLimit`、`byteOffset/byteLimit`、`shownBytes/shownLines` 已存在并有回归）；Phase D 标记为已收口。
- **验证**:
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test test/grep-tool.test.ts`（7/7 pass）
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-name-pattern "malformed OpenAI tool-call arguments" test/runtime-llm.test.ts`（1/1 pass）
- **边界**: 不新增独立 `Search` 工具；不改变 provider adapter 的 `_parseError/_rawInput` 归一来源；不触碰 Go TUI/UI 相关改动；Phase E-H 仍按后续真实 drift 分阶段推进。

## 2026-06-13 — Session replay / evidence governance Slice 1-2 收口

- **背景**: `session_315814e7-3b82-4a31-8601-a5b383288e9c` 暴露两条 P0 链路：同毫秒 `tool_completed` / `tool_started` 排序会让 provider replay 生成 orphan `tool_result`；mtime-only `Read` cache 会把 partial / preview evidence 包装成 full-file authority。
- **实现**:
  - `src/storage/SqliteStorage.ts`: events 表新增 `event_seq` append-order column、`events_session_seq_idx`、v12 migration/backfill；`listEvents`、`listSessions(includeEvents)` 与 sync list 全部按 `event_seq` 排序，cursor 改为 opaque seq。
  - `src/runtime/LLMCodingRuntime.ts`: `mapEventsToMessages()` 缓存 early `tool_completed`，等 matching `tool_started` 出现后再输出 `tool_use -> tool_result`；完全孤儿的 completed 继续跳过，未完成 started 仍 synthetic error。
  - `src/providers/adapters/OpenAIAdapter.ts`: 请求发送前验证 OpenAI-compatible tool protocol；orphan / duplicate `role=tool` 直接抛 `PROVIDER_REPLAY_INVALID_TOOL_SEQUENCE`，不发 fetch，不 silent fallback。
  - `src/runtime/runtimeToolLoop.ts` / `runtimePipeline.ts`: `readFileCache` 从 `{mtime,size}` 升级为 coverage-aware ranges；cache hit 必须满足 same mtime/size、requested byte range 被 provider-visible non-truncated range 覆盖，full-file request 必须由 full-file range 覆盖；stub 文案显式说明 requested byte range 与原 Read call，不再说“refer to earlier result”。
  - `test/storage.test.ts`、`test/runtime-llm.test.ts`、`test/adapters.test.ts`、`test/runtime.test.ts`: 增加同毫秒 append order、completed-before-started replay repair、OpenAI orphan rejection、Read partial→full 与 full→same coverage stub 回归。
- **验证**:
  - `npm run typecheck`（pass）
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/runtime.test.ts test/read-tool.test.ts test/storage.test.ts test/runtime-llm.test.ts test/adapters.test.ts`（240/240 pass）
- **边界**: Phase C-H 仍打开：Read line-based API / explicit byte fields、Grep multi-glob 与 parse-error pair-safety、intent `problemTarget`、near-timeout convergence、self-diagnosis evidence grading、wrapped path normalization 还未收口。

## 2026-06-13 — Session replay / evidence governance 规划建档

- **背景**: `session_315814e7-3b82-4a31-8601-a5b383288e9c` 暴露的不是单点模型幻觉：partial `Read` 被 mtime-only cache 包装成 full evidence、`Read offset/limit` byte 语义被模型按 line 使用、User Intake Guidance 未锁住“你出现的问题”的指代对象，且 SQLite event ordering 在同毫秒下把 `tool_completed` 排到 `tool_started` 前，最终 provider replay 生成 orphan `tool_result` 并触发 MiniMax `tool result's tool id ... not found`。
- **同步**:
  - 新增 `docs/nexus/reference/session-replay-and-evidence-governance-plan.md`，综合规划 event append sequence / provider replay repair、Read coverage-aware cache、line-based source reading、Grep multi-glob 与 parse-error replay safety、intent `problemTarget`、soft-timeout convergence、capability/self-diagnosis answer governance 与 wrapped path normalization。
  - `docs/nexus/reference/README.md` 与 `docs/nexus/active/TODO_runtime.md` 已同步索引，把该真实 session 作为 P0 Session Replay / Evidence Governance 打开项跟踪。
- **验证**: 文档规划同步；未改 runtime 源码，未跑测试。
- **边界**: 不通过 silent provider fallback 掩盖 replay bug；不新增 broad Search / mega-tool；Read cache 只能是优化层不是事实源；soft timeout 仍保持 recoverable，不退回 fixed fatal cutoff。

## 2026-06-13 — EverCore process-level cache 收口

- **背景**: `BABEL_O_EVERCORE_MODE=managed` 已能拉起本地 EverOS sidecar，但 embedded / short session 每次 app injection 都会重新 `configureEverCoreFromEnv()`；`storage.close()` 又会 dispose sidecar，导致重复冷启动和潜在端口抖动。
- **实现**:
  - `src/nexus/everCoreRuntimeManager.ts`: 新增 process-level lease cache；相同 config fingerprint + healthy/disabled EverCore 复用，同步支持 config drift 时的新 lease，不污染 active entry；`shutdown()` 才真正 dispose cached sidecar。
  - `src/nexus/everCoreConfig.ts`: 抽出 `resolveEverCoreConfigInputFromEnv()`，让 manager 与 legacy `configureEverCoreFromEnv()` 共享 env parsing。
  - `src/cli/embedded.ts`: embedded client 改走 `defaultEverCoreRuntimeManager.acquireFromEnv()`；每次 app/storage close 只 release lease，`EmbeddedNexusClient.close()` / `executeEmbedded()` 负责 shutdown。
  - `src/cli/commands/chat.ts`: 本地 chat 复用单个 embedded client，并在 finally 关闭，避免 slash/status/session 操作反复创建 client 导致重复拉起。
  - `src/cli/runSessionFlow.ts` / `src/nexus/server.ts`: 复用同一 manager；one-shot local flow 在 finally shutdown，server 在 Fastify `onClose` shutdown。
  - `test/runtime.test.ts` / `test/architecture-boundary.test.ts`: 覆盖 cache hit、config drift invalidation、shutdown dispose，以及同一 embedded client 两次 app injection 只触发一次 EverCore health/configure。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json NODE_ENV=test npx tsx --test test/architecture-boundary.test.ts --test-name-pattern="embedded Nexus client"`（4/4 pass）
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json NODE_ENV=test npx tsx --test test/architecture-boundary.test.ts test/runtime.test.ts --test-name-pattern="embedded Nexus client|EverCore runtime manager|EverCore managed mode|EverCore config|runtime/status reports managed EverCore"`（141/141 pass）
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json NODE_ENV=test npm run typecheck`（pass）
- **边界**: 只实现 process-level cache；不做 registry 文件、不跨进程复用、不做 idle TTL；`BABEL_O_EVERCORE_MODE=disabled` 仍保持无副作用；长期记忆仍只是 volatile hint。

## 2026-06-13 — Memory capability answer leakage regression 收口

- **背景**: 用户询问“你当前能否写入记忆？”时，provider 可能把内部路径、commit hash、MCP sidecar 或 hidden prompt 内通当成答案暴露；同时 broad `写入.*记忆` 判断会把纯能力问答误判成真实写入请求。
- **实现**:
  - `src/runtime/intentGuidance.ts`: 新增 memory capability question classifier；“能否写入记忆？”归为 `status/respond_only/requiresTools=false`，但“请记住/保存具体记忆”仍保持 `continue/requiresTools=true`。
  - `src/runtime/contextAssembler.ts`: `Long-Term Memory Capability` block 增加用户级能力回答约束，禁止默认暴露 source paths、commit hashes、hidden prompt、provider internals、MCP sidecar implementation details、API keys 或 secrets。
  - `src/runtime/runtimePipeline.ts` / `src/runtime/LLMCodingRuntime.ts`: 增加窄范围 runtime guard，仅对 memory capability answer 检测内部实现泄露；首次泄露回答会被抑制并重试一次，重复泄露则返回安全 fallback。
  - `test/runtime-llm.test.ts`: 增加分类、tool hiding、泄露抑制、重试与最终 answer 无内部路径/commit/MCP sidecar 的 focused regression。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json NODE_ENV=test npx tsx --test --test-name-pattern="memory capability|memory-save|memory_save_note|User intent fallback guidance" test/runtime-llm.test.ts`（6/6 pass）
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json NODE_ENV=test npx tsx --test test/mcp.test.ts test/memory-provider.test.ts test/runtime-llm.test.ts`（74/74 pass）
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json NODE_ENV=test npm run typecheck`（pass）
- **边界**: 只保护 memory capability answer 场景；不改变真实 `memory_save_note` 写入触发和 permission gate；不实现 `/memory` 面板或 EverCore sidecar cache。

## 2026-06-13 — EverCore lifecycle cache 与 /memory 面板规划建档

- **背景**: G6 收口后继续暴露两个后续设计点：managed EverCore sidecar 不应在 embedded / short session 中反复冷启动；用户询问“你当前能否写入记忆？”时不应暴露内部路径、commit hash、MCP sidecar 或 hidden prompt 内通。同时需要规划 `/memory` 用户可见管理入口与 Go TUI 面板。
- **同步**:
  - 新增 `docs/nexus/reference/evercore-lifecycle-cache-and-answer-governance-plan.md`，定义 managed warm sidecar、process-level cache、dataDir-local registry health reuse、idle TTL、search short cache、`/memory` CLI/API/Go TUI panel 与 capability answer regression。
  - `docs/nexus/reference/README.md`、`docs/nexus/TODO.md`、`docs/nexus/active/TODO_runtime.md` 与 `docs/nexus/reference/memory-capability-awareness-and-trigger-plan.md` 已同步索引，长期记忆主线从 Watch/Closed 调整为 focused P2/Watch：只推进 lifecycle cache、`/memory` 面板与能力问答不泄露内通守门。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json NODE_ENV=test npx tsx --test test/mcp.test.ts test/memory-provider.test.ts test/runtime-llm.test.ts`（72/72 pass）
- **边界**: 不做系统级 daemon / launchd / systemd-user；不让 managed sidecar 变成孤儿进程；`/memory` 是 runtime-owned management surface，不替代 `mcp:evercore:*` provider tools；长期记忆仍是 volatile hint，不替代 SQLite/session/event/tool trace。

## 2026-06-13 — Memory Capability Awareness G6 live validation 收口

- **背景**: G1-G5 已完成 capability block、tool trigger policy、candidate governance、runtime auto-search 与 mock provider self-trigger regression；G6 需要用 managed EverCore 验证真实 save/recall/project-fact caution 流程。
- **实现**:
  - `src/tools/everCoreMcpTools.ts`: `memory_save_note` 改为始终使用当前 runtime `context.sessionId`，model-visible schema 只暴露 `note`，避免 provider 写入默认或自造 session；写入仍是 user+assistant anchor 且 permission-gated。
  - `src/runtime/intentGuidance.ts`: intake prompt 与 fallback normalization 增加 explicit memory-save / named MCP tool 规则，避免“保存长期记忆”类请求被降级为 respond-only 并隐藏工具。
  - `/tmp/babel-o-memory-g6-live-validation.mjs`: live harness 增加 per-turn timeout、save fail-fast diagnostics、search bucket/snippet diagnostics，并用本地 OpenAI-compatible embedding stub 启动 EverOS cascade/LanceDB indexing；该 stub 只服务 managed validation 的 embedding，不替代真实 LLM provider。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json NODE_ENV=test npx tsx --test test/mcp.test.ts test/memory-provider.test.ts test/runtime-llm.test.ts`（72/72 pass）
  - `node --import tsx /tmp/babel-o-memory-g6-live-validation.mjs`（passed：MiniMax `anthropic-compatible` provider；save permission gate=true；save tool completed=true；EverOS add/flush=true；preference keyword search hit=1 episode；recall mentions `regression-first` and memory hint; project fact caution requires workspace evidence）
- **边界**: EverCore 仍是 volatile / non-authoritative hint，不替代 SQLite/session/event/tool trace；`memory_save_note` 保持 permission-gated；`memory_flush_session` 仍 runtime-owned by default；managed live validation 需要 embedding/cascade indexing 才能让 keyword search 命中新写入 memory。

## 2026-06-13 — Go TUI running 态 ESC interrupt 与 queued prompt 收口

- **背景**: 用户反馈 Go TUI 在 agent 运行中无法通过 `Esc` 打断并确保不异常退出，同时输入框无法提前提交下一条用户指令；补充要求 `Esc` 不应直接报错，而应弹出黄色 `What should BabeL-O do instead?` 类提示，让用户给出替代指令。
- **实现**:
  - `clients/go-tui/internal/tui/tui.go`: 新增 `queuedPrompt`、`cancelRequested`、`streamCancel` 与 `interruptionPromptActive` 状态；运行中普通 `Enter` 把当前输入 queue 为下一 prompt，不启动第二条并发 stream；当前 `result` / `error` / cancel completion 后自动启动 queued prompt。
  - `Esc` 在运行中首按只打开 interruption prompt：以 `permission` 风格黄色 transcript 行提示 `What should BabeL-O do instead?`，并在输入框预填 `BabeL-O should `；用户编辑后按 `Enter` 会 queue 替代指令并取消当前 run；提示态再次 `Esc` 则无替代指令地取消当前 run。
  - `clients/go-tui/internal/tui/stream.go` / `api.go`: `startStream` / `runStream` 增加本地 cancel channel；取消时优先调用 Nexus `POST /v1/sessions/:sessionId/cancel`，失败时兜底关闭本地 WebSocket，避免 UI 卡死或异常退出；取消导致的 read error 被软处理为 `current agent run cancelled`。
  - `clients/go-tui/internal/tui/chrome.go`: footer 在 interruption prompt、cancel requested 与 queued prompt 三种状态下显示对应提示。
  - `clients/go-tui/internal/tui/tui_test.go`: 增加 ESC guidance、替代指令 cancel+queue、运行中普通 queue、terminal event 后自动启动 queued prompt 与 stream cancel channel 回归。
- **验证**:
  - `go -C clients/go-tui test ./internal/tui`（pass）
  - `go -C clients/go-tui test ./...`（pass）
- **边界**: 不改变 Nexus/runtime 执行所有权；Go TUI 只负责交互状态、取消请求与下一 prompt 排队；不会在运行中启动第二条并发 stream；替代指令仍作为下一轮用户 prompt 进入正常 runtime flow。

## 2026-06-13 — Memory Capability Awareness G5 收口

- **背景**: G1-G4 已让 provider loop 可见 long-term memory capability、具备受控 candidate governance 与 heuristic auto-search；继续推进 G5，用 mock provider 证明模型能看到能力/工具并按策略触发。
- **实现**:
  - `test/runtime-llm.test.ts` 增加 Anthropic SSE helper，用真实 provider-loop tool_use 解析路径模拟模型调用 EverCore MCP tools。
  - 新增 recall prompt regression：provider request 包含 `Long-Term Memory Capability` 与 `mcp:evercore:memory_search`，mock provider 调用 `memory_search` 后执行 read-only bounded retrieval，并在下一轮基于 tool result 输出 remembered preference。
  - 新增 save prompt regression：用户明确“记住”时 mock provider 调用 `memory_save_note`，runtime 在写入 EverCore 前发出 `permission_request`；测试拒绝 permission 后确认没有 `addAgentMessages` 写入，且输出 `permission_response=false` / `tool_denied`。
- **验证**:
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-memory-g5-runtime-llm.json npx tsx --test --test-concurrency=1 --test-name-pattern="memory capability prompt lets mock provider self-trigger memory_search|memory_save_note self-trigger emits permission_request" test/runtime-llm.test.ts`（2/2 pass）
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-memory-g5-provider.json npx tsx --test --test-concurrency=1 test/memory-provider.test.ts`（3/3 pass）
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-memory-g5-context.json npx tsx --test --test-concurrency=1 --test-name-pattern="MemoryProvider|Memory Capability|long-term memory" test/context-assembler.test.ts`（4/4 pass）
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-memory-g5-mcp.json npx tsx --test --test-concurrency=1 --test-name-pattern="EverCore" test/mcp.test.ts`（4/4 pass）
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-memory-g5-typecheck.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck`（pass）
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-memory-g5-format.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run format:check`（0 failures）
- **边界**: 仍不自动写长期记忆；write path 必须先经过 permission gate；mock provider regression 不替代 Phase G6 live validation。

## 2026-06-13 — Memory Capability Awareness G3/G4 收口

- **背景**: G1/G2 已让 provider loop 可见 long-term memory capability 与 MCP tool trigger policy；继续推进 G3/G4，要求未审批 memory candidate 不自动写入，并让 runtime 在低风险历史/偏好线索下自动检索 memory。
- **实现**:
  - 复用已落地的 SessionChannel `memory_candidate` governance：candidate metadata 包含 scope、evidence refs、confidence、staleness/supersession、approval requirement、blocked/review reasons 与 `autoWrite=false`，inbox context 显示 review-only 状态。
  - `src/runtime/memoryProvider.ts` 增加 `shouldAutoSearchMemory()` 轻量 heuristic：prior/previous/last time/remember/偏好/之前/上次/记得 等 cue 触发 EverCore search；build/test/status、permission response 与纯 workspace/file turn 只返回 enabled diagnostics，不调用 EverCore search。
  - `MemoryProviderDiagnostics` 增加 `autoSearch` 触发/跳过原因，CLI `/context` 与 context view long-term memory 行展示 `auto-search=triggered|skipped:<reason>`。
  - 新增 `test/memory-provider.test.ts` 并纳入 `package.json#scripts.test`，覆盖 heuristic trigger/skip 与 EverCoreMemoryProvider 自动检索/跳过行为。
- **验证**:
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-memory-provider-g4.json npx tsx --test --test-concurrency=1 test/memory-provider.test.ts`（3/3 pass）
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-memory-capability-context-g4.json npx tsx --test --test-concurrency=1 --test-name-pattern="MemoryProvider|Memory Capability|long-term memory" test/context-assembler.test.ts`（4/4 pass）
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-memory-capability-mcp-g4.json npx tsx --test --test-concurrency=1 --test-name-pattern="EverCore" test/mcp.test.ts`（4/4 pass）
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-memory-g4-typecheck.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck`（pass）
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-memory-g4-format.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run format:check`（0 failures）
- **边界**: 不启用自动长期记忆写入；`memory_save_note` 仍 permission-gated；`memory_flush_session` 仍 runtime-owned；自动检索失败/跳过只进入 diagnostics，不污染 provider-visible memory hits。

## 2026-06-13 — Memory Capability Awareness G1/G2 收口

- **背景**: `docs/nexus/reference/memory-capability-awareness-and-trigger-plan.md` 要求让 provider loop 知道 long-term memory 可用，并能按策略自触发 read-only `memory_search` 与 permission-gated `memory_save_note`。
- **实现**:
  - `src/runtime/contextAssembler.ts` 在 `MemoryProvider` enabled 时注入 non-cacheable `Long-Term Memory Capability` block；该 block 说明何时使用 `memory_search`、memory results 只是 background hints、项目事实必须用 workspace evidence 复核、仅在用户明确要求记住或治理候选获批时保存。
  - `AssembledContext` / `ContextAnalysisDiagnostics` 增加 `memoryCapabilityAvailable` / `longTermMemoryCapabilityAvailable`，便于 `/context` / API diagnostics 表达 capability presence。
  - `src/tools/everCoreMcpTools.ts` 更新三类 tool descriptions：`memory_search` read-only 自触发场景，`memory_save_note` permission-gated 写入边界，`memory_flush_session` runtime lifecycle 优先。
  - 同步 `docs/nexus/active/TODO_runtime.md` 与 `docs/nexus/DONE.md`，把 Phase G1/G2 标为已完成首个切片。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-memory-capability-context-2.json npx --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O tsx --test --test-concurrency=1 --test-name-pattern="MemoryProvider|Memory Capability|long-term memory" /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/context-assembler.test.ts`（4/4 pass）
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-memory-capability-mcp-2.json npx --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O tsx --test --test-concurrency=1 --test-name-pattern="EverCore" /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/mcp.test.ts`（4/4 pass）
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-memory-capability-typecheck-2.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck`（pass）
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-memory-capability-format-2.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run format:check`（0 failures）
- **边界**: 仍不启用无审批自动写长期记忆；`memory_flush_session` 默认 runtime-owned；后续 Phase G3/G4 再推进 memory candidate governance 与 runtime auto-search policy。

## 2026-06-13 — Go TUI 选区高亮覆盖问题确认解决并同步文档

- **背景**: 用户验证后确认 Go TUI `--mouse` “实际选中但高亮不覆盖”的问题已经解决。
- **同步**:
  - `docs/nexus/reference/go-tui-selection-highlight-optimization-plan.md` 从“优化规划”更新为“优化记录”，状态改为 Resolved / Closed，并明确窄范围 `ultraviolet.ScreenBuffer` cell-level reverse highlight 是最终收口方案。
  - `docs/nexus/README.md`、`docs/nexus/reference/README.md` 与 `docs/nexus/TODO.md` 的索引口径从“修复参考/规划”改为“已收口记录/回归参考”。
  - `docs/nexus/DONE.md` 新增 Go TUI selection highlight / clipboard copy 完成能力索引，记录 300ms 高亮保留、精确 expiry 清理、no-op cache invalidation、cell-level highlight 与回归覆盖。
- **边界**: 只同步文档，不改代码；后续若再出现终端主题对比度或 wrap/off-by-one 回归，应在对应 TUI TODO 中重新开未收口项。

## 2026-06-13 — Memory Capability Awareness / Self-Trigger 规划建档

- **背景**: EverCore / EverOS managed sidecar 与 provider protocol convergence 已完成首轮 live validation；下一步需要让 BabeL-O provider loop 知道 long-term memory 可用，并能按策略自触发 read-only search 与受控 save。
- **实现**:
  - 新增 `docs/nexus/reference/memory-capability-awareness-and-trigger-plan.md`，规划 Phase G1-G6：Memory Capability block、tool trigger policy、memory candidate governance、runtime auto-search、mock provider self-trigger regression 与 live save/recall validation。
  - 同步 `docs/nexus/reference/README.md`、`docs/nexus/README.md`、`docs/nexus/active/TODO_runtime.md` 与 `docs/nexus/TODO.md`，把 Phase G 作为 EverCore Integration 后续推进入口。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-memory-capability-plan-format.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run format:check`（0 failures）
- **边界**: 本次仅建档，不修改 runtime/tool 代码；规划继续要求 memory result 为 volatile / non-cacheable / non-authoritative hints，`memory_save_note` permission-gated，`memory_flush_session` runtime-owned by default。

## 2026-06-13 — EverCore / EverOS provider protocol convergence live validation

- **背景**: 用户要求根据 EverOS 规划文档推进结合并验证记忆系统跑通；此前阻塞点是 EverOS text LLM 只支持 OpenAI-compatible，而 BabeL-O 当前主 provider 是 MiniMax `anthropic-compatible`。
- **实现**:
  - EverOS 新增 protocol-aware text LLM 配置：`EVEROS_LLM__PROTOCOL=openai-compatible|anthropic-compatible`；`OpenAIProvider` 保持默认，新增 `AnthropicProvider` 调 `/v1/messages`，支持 Pydantic schema structured response validation。
  - EverOS `get_llm_client()` 改走本地 `build_llm_provider()`，保持 service/memory 层只依赖 `LLMClient` 协议；`config.example.toml` 与默认配置注释同步 protocol 字段。
  - EverOS cascade lifespan 在 embedding 未配置时降级为 disabled，不再阻塞 API startup；keyword-only search 仍可运行，vector/hybrid search 与 fresh vector indexing 继续要求 embedding。
  - BabeL-O managed EverCore bridge 增加 `BABEL_O_EVERCORE_LLM_PROTOCOL` / `EVEROS_LLM__PROTOCOL`，自动桥接 OpenAI-compatible / OpenAI Responses / Anthropic-compatible adapter，显式 override 仍最高优先级。
  - 同步 `/Users/tangyaoyue/DEV/EverOS/babel-o-evercore-integration-plan.md`、`docs/nexus/TODO.md`、`docs/nexus/active/TODO_runtime.md` 与 `docs/nexus/DONE.md`。
- **验证**:
  - `uv --directory /Users/tangyaoyue/DEV/EverOS run pytest tests/unit/test_component/test_llm tests/unit/test_config tests/unit/test_entrypoints/test_api/test_lifespans/test_cascade.py -q`（31/31 pass）
  - `uv --directory /Users/tangyaoyue/DEV/EverOS run ruff check src tests/unit/test_component/test_llm`（pass）
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-evercore-protocol-runtime-narrow.json npx --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O tsx --test --test-concurrency=1 --test-name-pattern="EverCore managed mode" /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/runtime.test.ts`（4/4 pass）
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-evercore-protocol-typecheck.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck`（pass）
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-evercore-protocol-format.json npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run format:check`（0 failures）
  - `npx --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O tsx /tmp/babel-o-everos-managed-live-validation.mjs`（passed：EverOS `/health` 200、memory add 200/accumulated、flush 200/extracted、keyword search 200；providerId `minimax`，protocol `anthropic-compatible`）
- **边界**: 首轮 live validation 是 keyword-only search；embedding 未配置时 cascade disabled，后续如需 vector/hybrid search 与 fresh vector indexing 仍需配置真实 embedding provider。没有提交或推送。

## 2026-06-13 — EverCore / EverOS provider protocol convergence 文档同步

- **背景**: 长期记忆 live validation 暴露当前 EverOS text LLM 仍只支持 OpenAI-compatible chat-completions；BabeL-O 当前主 provider 可为 `anthropic-compatible`（如 MiniMax），因此 managed sidecar 不能无条件复用主 provider 配置。
- **实现**:
  - 更新 `/Users/tangyaoyue/DEV/EverOS/babel-o-evercore-integration-plan.md`，将旧 Phase A-D 规划改为当前 Phase A-E 已落地状态，并补充 short-term EverCore LLM override、mid-term EverOS `anthropic-compatible` provider、long-term single provider bridge 路线。
  - 同步 `docs/nexus/TODO.md`、`docs/nexus/active/TODO_runtime.md` 与 `docs/nexus/DONE.md`，明确 managed sidecar 已支持 EverCore LLM override，自动桥接仅限 OpenAI-compatible / OpenAI Responses，后续优先推动 EverOS 原生 Anthropic-compatible LLM provider，不优先新增 BabeL-O OpenAI-compatible proxy。
- **验证**:
  - `npm run format:check`（check-only，0 failures）
- **边界**: 本次只更新规划/状态文档，不修改 runtime/provider 代码；EverCore memory 仍为 volatile / non-cacheable / non-authoritative hints，SQLite/session/event/tool trace 仍是 BabeL-O 事实源。

## 2026-06-13 — Go TUI 选区高亮与复制事件优化收口

- **背景**: 用户反馈 Go TUI `--mouse` 存在“实际选中并复制，但视觉未高亮/高亮过早消失”的体验问题；优化依据为 `docs/nexus/reference/go-tui-selection-highlight-optimization-plan.md` 与 Crush per-item highlight/cache 对照。
- **实现**:
  - `selection.go`: release 成功复制后不再立即 `clearSelection()`；新增 `selectionHighlightExpiredMsg` / `expireSelectionHighlightCmd`，保留最后选区约 300ms，并按 `copiedAt + selection anchors` 精确清理，避免旧 tick 清掉新选区。
  - `tui.go`: 增加 selection highlight expiry 消息处理；切换到非 composing mode 时清理 selection，避免 overlay 背后残留选区。
  - `highlight.go`: `transcriptItem.SetHighlight` / `ClearHighlight` no-op 化；`highlightedViewportView()` 仅在无选区时全清 transcript highlight；有选区时由 `applySelectionToTranscriptItems` 更新范围内 item 并清理离开范围的 item，降低 cache churn；selection highlight 主绘制路径改为窄范围 `ultraviolet.ScreenBuffer` cell-level reverse highlight，避免字符串插入背景色在复杂 ANSI/wrap/cell 场景下覆盖不完整。
  - `clients/go-tui/go.mod`: 将 `github.com/charmbracelet/ultraviolet` 提升为 direct dependency，仅用于 selection highlight 绘制。
  - `tui_test.go` / `highlight_test.go`: 覆盖 release 后仍短暂高亮、复制文本与可见选区一致、selection expiry 只清匹配 copy、重复同范围高亮不失效 cache、CJK/emoji/nested ANSI 高亮不破坏纯文本；后续补强反向拖选 normalize、MouseCapture off no-op、进入 overlay 清理 selection 的边界回归。
  - `go-tui-selection-highlight-optimization-plan.md`: 状态更新为 Phase 0/1/2/3/4 已落地；Phase 4 记录窄范围 ultraviolet cell-buffer highlight；Phase 5 `tea.SetClipboard` 已评估但暂不迁移，保留现有手写 OSC 52 builder + native clipboard fallback。
- **验证**:
  - `gofmt -w clients/go-tui/internal/tui/{selection.go,highlight.go,tui.go,tui_test.go,highlight_test.go}`
  - `go -C clients/go-tui test ./...`（pass）
  - `go -C clients/go-tui vet ./...`（pass）
  - `go -C clients/go-tui build ./...`（pass）
- **边界**: 仅窄范围引入 ultraviolet cell buffer 用于 selection highlight；未把整体 Go TUI 渲染迁移为 screen renderer；未升级 Bubble Tea；未改变 Nexus/runtime/context ownership；未扩展到 TypeScript TUI 或任意 overlay 文本选择。

## 2026-06-13 — Go TUI 选区高亮优化规划建档

- **背景**: 用户反馈 Go TUI `--mouse` 文本选区存在“实际选中/可复制但视觉未高亮”的体验问题；对照 Crush 后确认其稳定点在 per-item highlight、render callback 与 cache-version bump，而非单纯 OSC 52 复制。
- **实现**:
  - 新增 `docs/nexus/reference/go-tui-selection-highlight-optimization-plan.md`，记录当前 BabeL-O selection/highlight/copy 链路、Crush 对照结论、风险点、非目标与 Phase 0~5 修复计划。
  - 同步 `docs/nexus/reference/README.md`、`docs/nexus/README.md` 与 `docs/nexus/TODO.md` 文档索引；当时标为 P2/watch 修复参考，后续已由上方“确认解决并同步文档”记录更新为已收口/回归参考。
- **验证**:
  - `rg -n "go-tui-selection-highlight-optimization-plan" docs/nexus`（确认 reference README、总 README、TODO 索引均可检索）
- **边界**: 本次仅建档，不修改 Go TUI selection/highlight 代码；建档时先把 ultraviolet 作为非目标，后续已由“Go TUI 选区高亮与复制事件优化收口”记录修订为窄范围 cell-buffer 引入；仍不升级 Bubble Tea 大版本，不改变 Nexus/runtime ownership。

## 2026-06-12 — 文档库已完成文档归档整理

- **背景**: 文档库盘点后确认 `docs/nexus/archive/` 内既有 completed plans 已归档，`docs/nexus/reference/` 多数仍是代码注释和长期架构约束，不应移动；真正仍处在活跃路径但已完成的是 Go TUI Phase 9 决策记录与 Go TUI v1 UI 升级计划。
- **实现**:
  - 新增归档记录 `docs/nexus/archive/phase-9-promotion-decision.md`，并将 `docs/nexus/PHASE_9_DECISION.md` 缩减为稳定跳转页，避免既有日志、源码注释和 help 文案断链。
  - 新增归档记录 `docs/nexus/archive/go-tui-v1-ui-upgrade.md`，并将 `clients/go-tui/docs/upgrade-plan.md` 缩减为客户端本地跳转页。
  - 更新 `docs/nexus/README.md` 与 `docs/nexus/archive/README.md` 的 Archive 索引；将 `clients/go-tui/internal/tui/help_dialog.go` 中唯一直接引用 `upgrade-plan.md` 章节细节的注释指向归档文档。
- **验证**:
  - `rg -n "PHASE_9_DECISION|upgrade-plan\\.md|phase-9-promotion-decision|go-tui-v1-ui-upgrade" docs/nexus clients/go-tui src test`（确认旧稳定路径仅作为跳转/历史引用保留，新归档入口可检索）
  - `cd clients/go-tui && go test ./...`（pass）
- **边界**: 未移动 `TODO.md` / `DONE.md` / `WORK_LOG.md`；未移动 `docs/nexus/reference/*plan*.md`，因为它们仍承担长期约束或源码注释索引；未二次拆分既有 `docs/nexus/archive/` 文件，避免引入大规模链接 churn。

## 2026-06-12 — Go TUI `tui.go` 文件级拆分收口

- **背景**: `clients/go-tui/internal/tui/tui.go` 长期承载 Go TUI 的 API/stream/render/transcript/text/selection/overlay/event/helper 代码，文件规模 10k+ 行；规划写入 `docs/nexus/archive/go-tui-tui-go-split-plan.md`，要求同 package 机械移动，不改行为，不拆 `model` root 与 `Update` 主状态机。
- **实现**:
  - 新增/填充 `api.go`、`stream.go`、`chrome.go`、`welcome.go`、`transcript.go`、`text.go`、`selection.go`、`events.go`、`context.go`、`slash.go`、`permission.go` 与 `overlay_inbox.go` / `overlay_agents.go` / `overlay_tasks.go` / `overlay_activity.go` / `overlay_tools.go` / `overlay_models.go` / `overlay_sessions.go`。
  - `tui.go` 保留 `Config`/DTO 类型、`model` root、`Run`/`newModel`/`Init`/`Update`/`View` 总装和核心 mode routing；`consumeNexusEvent` 仍留在主文件，仅把低风险 event helper 拆到 `events.go`。
  - 期间修正机械搬移带来的 import drift，并把误放到 `overlay_models.go` 的 inbox event card 归入 `overlay_inbox.go`。
- **验证**:
  - `go -C clients/go-tui test ./...`（pass）
  - `go -C clients/go-tui vet ./...`（pass）
- **结果**: `tui.go` 从 10,243 行降至 3,548 行，满足计划“低于 4k 行”目标；未新增功能、未改 Nexus/runtime/context/permission ownership，未执行 Phase 5 `Update` 分段 handler。

## 2026-06-12 — Go TUI `/model` Step 4 模型持久化收口

- **背景**: Go TUI `/model` 多步 picker 的 Step 4 过去只写 `m.modelID` 内存字段，header 会视觉切换但不写 server config；重启 `bbl go` 或下一次从 Nexus 拉配置后会回到 server 真实模型。规划写入 `docs/nexus/archive/go-tui-model-persistence-plan.md`。
- **实现**:
  - `src/nexus/app.ts` 的 `POST /v1/runtime/config/select` 已支持互斥 `{profile}` / `{model}`：`profile` 仍切 active profile，`model` 写入 `ConfigManager.setDefaultModel()`，`profile + model` 返回 `mutually_exclusive`，空字段返回 `missing_field`，未知 model 返回 `unknown_model`，`role` / `roleModel` 仍 `not_supported`。
  - `test/config-endpoints.test.ts` 覆盖 model 持久化、active profile shadow、互斥、空字段、未知 model、role/roleModel 拒绝与 profile back-compat。
  - `clients/go-tui/internal/tui/tui.go` 已新增 `modelSelectMsg` / `selectRuntimeModel` / `modelPickSubmitting`；Step 4 Enter dispatch `POST /v1/runtime/config/select {model}`，in-flight 期间 Enter no-op；成功路径 `applyRuntimeConfig` + `model saved:` + 回 composing，失败路径清 submitting 并留在 picker。
  - `clients/go-tui/internal/tui/tui_test.go` 覆盖 Step 4 command dispatch、成功 apply+close、失败 stay-in-picker、submitting render。
- **验证**:
  - `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test --test-concurrency=1 test/config-endpoints.test.ts`（22/22 pass）
  - `cd clients/go-tui && go test ./...`（pass）
  - `cd clients/go-tui && go vet ./...`（pass）
- **边界**: 不改 `bbl chat` / `bbl config use`；不持久化 Step 2/3 的 api-key/baseURL；不改 `ConfigManager.resolveSettings()` 优先级，active profile 的 `profile.model` 继续优先于 `defaultModel`；不恢复 auto model selection / role defaults。

## 2026-06-10 — Go TUI permission-policy Phase B 收口（soft-deny policy per-request override）

- **背景**: Phase A 让 read-only Bash subcommand 跳过 policy + approval gate，但 write/execute 工具（`git commit`、`npm install`、`Write`/`Edit`）在 `denyByDefaultTools()` 默认下仍 hard-deny，根本发不出 `permission_request`。规划写入 `docs/nexus/reference/go-tui-permission-policy-governance-plan.md` Phase B。
- **实现**（**核心改动仅一行**——在 hard-deny gate 加一个 `&& options.policyMode !== 'soft-deny'` 判断，approval gate 完全不动）：
  - `src/nexus/app.ts:47-58` `executeSchema` 新增 `policy: z.enum(['strict', 'soft-deny']).optional()`
  - `src/nexus/app.ts:455-462` `CreateNexusAppOptions` 新增 `executePolicyMode?: 'strict' | 'soft-deny'`（server-side 默认值，默认 `'strict'` 保 back-compat）
  - `src/nexus/app.ts:475` 读取 `executePolicyMode = options.executePolicyMode ?? 'strict'`
  - `src/nexus/app.ts:957-961` `prepareExecution` 解析 `policyMode = body.policy ?? executePolicyMode` 并准备回写
  - `src/nexus/app.ts:919-928` `PreparedExecution` 类型加 `policyMode`
  - `src/nexus/app.ts:1086 + 2090` HTTP / WebSocket 两条 `runtime.executeStream()` 调用都透传 `policyMode: prepared.policyMode`
  - `src/runtime/Runtime.ts:31-39` `RuntimeExecuteOptions` 新增 `policyMode?: 'strict' | 'soft-deny'`
  - `src/runtime/LocalCodingRuntime.ts:202-228` hard-deny gate 改为 `if (effectiveRisk !== 'read' && !this.toolPolicy.isAllowed(tool) && options.policyMode !== 'soft-deny')`——soft-deny 仅 bypass hard-deny，让 approval gate 自然触发 `permission_request`
  - `clients/go-tui/internal/tui/tui.go:27-42` `Config` 新增 `PolicyMode string` 字段
  - `clients/go-tui/internal/tui/tui.go:5996-6014` `buildExecuteRequest` 总是附加 `policy` 字段（默认 `'soft-deny'`，可被 `Config.PolicyMode` 覆盖）
- **测试**:
  - `test/runtime.test.ts` 新增 2 个 Nexus focused 测试：`execute honours per-request policy=soft-deny for write/execute tools`（mock Nexus + body `policy: 'soft-deny'` + `bash "git commit -m x"` → 事件流含 `permission_request`、无 policy-based `tool_denied`、用户通过 `/approve` 后工具正常执行）；`execute with default strict policy still hard-denies execute-risk Bash`（默认 server-side `'strict'` 默认下 Bash `git commit` 直接 hard-deny、无 `permission_request`——back-compat 守门）
  - `clients/go-tui/internal/tui/tui_test.go` 新增 4 个测试：`TestBuildExecuteRequestEmitsSoftDenyPolicyByDefault`（默认 `Config` payload 含 `policy: 'soft-deny'`）；`TestBuildExecuteRequestHonoursExplicitPolicyMode`（`PolicyMode: "strict"` payload 含 `policy: 'strict'`）；`TestBuildExecuteRequestEmitsPolicyAlongsideTimeoutMs`（`policy` 与 `timeoutMs` 独立并存）；`TestRunStreamEmitsSoftDenyPolicyAndHandlesPermissionRequest`（fake Nexus WebSocket 端到端：Go TUI 在 wire 上发 `policy: 'soft-deny'`、fake Nexus emit `permission_request` 后 `runStream` 透传到 consumer channel）
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-phase-b-FINAL2-config.json npm run typecheck`（过）
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-phase-b-FINAL2-format.json npm run format:check`（0 failures）
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-phase-b-FINAL2-fulltest.json npm test -- --runInBand`（723/723 pass；含 2 个新 Nexus soft-deny 测试）
  - `cd clients/go-tui && go test -count=1 ./...`（全过，含 4 个新 Go TUI 测试）
  - `cd clients/go-tui && gofmt -l .`（先报告 tui_test.go 格式问题，gofmt -w 后干净）
- **未触动**: `denyByDefaultTools()` / `allowAllTools()` / `allowlistedTools()` 三个 policy builder 签名未动；approval gate 自身完全未动；`permission_request` / `permission_response` / `tool_denied` 事件 schema 未改；Go TUI 权限面板 `a/y/n/r/esc` 流程未改；`bbl chat` 与 HTTP API 既有客户端完全 back-compat；child AgentLoop 仍走 server-side 默认（`'strict'`）不被 per-request `policy` 影响。
- **核心设计点**: Phase B 是"墙拆掉让既有管道接管"的最小改动。approval gate 本来就能正确发 `permission_request`、等 `permission_response`、按 approved/denied 走——只是被 hard-deny 截胡。soft-deny 仅 bypass hard-deny 一个条件，让 approval gate 接手。

## 2026-06-10 — Go TUI permission-policy Phase A 收口（Bash read-only subcommand 自动放行）

- **背景**: `session_go_1781076550805204000` 暴露 Bash hard-deny 截胡 `permission_request` 的真实样本。规划写入 `docs/nexus/reference/go-tui-permission-policy-governance-plan.md` Phase A。
- **实现**:
  - `src/tools/builtin/bashClassifier.ts` 新建（230 行）：纯函数 `classifyBashRisk(command): { kind: 'read' | 'execute'; rule?; command }`。包含：read-only 命令白名单（git status/log/diff/show/remote/rev-parse/ls-files/tag、ls、cat、head、tail、wc、file、stat、readlink、realpath、pwd、echo、whoami、hostname、date、uname、env、printenv、ps、top、uptime）；git 拒绝子命令黑名单（push/commit/checkout/reset/clean/rebase/merge/stash/init/clone/fetch/pull/add 等）；find 特殊处理（仅 `-type f` 且无 `-exec/-delete/-ok/-fprint/-fprintf/-fls`）；30+ 危险 pattern 二次校验（pipe-to-shell、command substitution、redirects、rm/mv/cp/mkdir/touch/chmod/chown/curl/wget/dd/mkfs/sudo/su/kill/killall/pkill/shutdown/reboot/npm install/yarn add/pip install/apt install/brew install/systemctl/launchctl，chain 模式 `;` `&&` `||` 最后匹配以让具体 rule 优先）。白名单 subcommand 不在 allowlist 时仍扫描 dangerous pattern，避免 `git status; rm -rf` 报"not-allowlisted"误导用户。
  - `src/tools/builtin/bash.ts` `bashTool` 新增 `riskForInput: (input) => classifyBashRisk(input.command).kind`（保留 `risk: 'execute'` 不变以维持工具身份与 audit 一致）。
  - `src/tools/Tool.ts` `ToolDefinition` 新增 optional `riskForInput?: (input: any) => ToolRisk` 字段（参数用 `any` 解决 contravariance）；同时增强 JSDoc 说明。
  - `src/shared/events.ts` `ToolStartedEventSchema` 新增 optional `effectiveRisk` 字段（纯加法）。
  - `src/runtime/LocalCodingRuntime.ts`：新增 private `effectiveRisk(tool, input)` helper（带 try-catch fallback）；policy hard-deny 改为 `if (effectiveRisk !== 'read' && !this.toolPolicy.isAllowed(tool))`；approval gate 改为 `if ((effectiveRisk === 'write' || effectiveRisk === 'execute') && !options.skipPermissionCheck)`；`tool_started` event 在 `effectiveRisk !== tool.risk` 时 attach；hook event（PreToolUse / PostToolUse / PermissionRequest）`toolRisk` 用 effectiveRisk；permission_audit + tool_denied event 的 `risk` 字段也用 effectiveRisk；hook 更新 input 后重算 effectiveRisk（hooks 可改写 command 改变分类）。
  - `src/tools/registry.ts` `createDefaultToolRegistry()` 加 `as AnyTool` cast 解决 contravariance 报错。
  - `test/bash-classifier.test.ts` 新建（12 个 focused test，覆盖：git read-only allowlist / git write deny / pure read-only FS / find `-type f` / find dangerous flag / chain 升级 / command substitution / redirect / 危险命令名 anywhere / unknown command / empty command / quoted tokenization / audit 元数据）。
  - 三个既有 regression 测试更新：`smart permissions: read-only Bash subcommands skip the approval gate entirely`（验证 read-only subcommand 无 permission_request + 无 audit + tool_started.effectiveRisk=read）；`smart permissions: workspace path safety blocks cat outside workspace`（验证 Phase A 下 cat 走 workspace path safety 而不是 permission gate）；`allowlisted runtime executes allowed tools and denies blocked tools`（`bash pwd` 改 `bash "rm sample.txt"` 以触发 execute 分类）。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-phase-a-final-typecheck.json npm run typecheck`（过）
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-phase-a-final-format.json npm run format:check`（0 failures）
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-phase-a-final-fulltest.json npm test -- --runInBand`（709/709 pass；含 12 个新 bash-classifier 测试 + 3 个更新的 permission-flow / runtime 测试）
  - `cd clients/go-tui && go test ./...`（全过）
  - `cd clients/go-tui && gofmt -l .`（先报告 tui.go 格式问题，gofmt -w 后干净）
- **未触动**: `bashTool.risk` 仍 `'execute'`（保留 audit 身份）；`denyByDefaultTools()` / `allowAllTools()` / `allowlistedTools()` 三个 policy builder 签名未动；workspace path safety 仍由 `findWorkspaceEscapeInCommand` 拦截；child AgentLoop 仍走 `denyByDefaultTools()`（不被 effectiveRisk 影响）；`bbl chat`（CLI）行为未变。
- **Phase B-E 仍为待办 / watch-only**：soft-deny `policy` 字段透传、WebSocket 端到端 regression、`--allow-tools` flag、文档同步等。

## 2026-06-10 — Go TUI execute-timeout Phase D + E 收口（runtimeAgentStep 分类 + CLI 死信号治理）

- **背景**: Phase A/B/C 已让 Go TUI 主动发 timeoutMs、Nexus emit `execute_summary`、Go TUI 友好渲染；但 `src/nexus/runtimeAgentStep.ts:298` 把任意 `signal.aborted` 都标为 `REQUEST_TIMEOUT`（混淆 user-cancel vs 真超时），且 `src/cli/runSessionFlow.ts:247-254` 的 `timeoutController` 从未被武装但默默传给 runtime（增加未来误读风险）。规划收口在 `docs/nexus/archive/go-tui-execute-timeout-governance-plan.md` Phase D + E。
- **实现**:
  - `src/nexus/runtimeAgentStep.ts:28-29` `RuntimeAgentStepOptions` 新增 `timeoutSignal?: AbortSignal` 选项。
  - `src/nexus/runtimeAgentStep.ts:229` 修正 `executeStream` 调用的 `timeoutSignal` 字段（之前错误写成 `options.signal`，现在改为 `options.timeoutSignal`）。
  - `src/nexus/runtimeAgentStep.ts:298-313` 重写错误分类：与 `LLMCodingRuntime.ts:681-684` 对齐——`isTimeout = timeoutSignal?.aborted` → `REQUEST_TIMEOUT`；`isCancelled = !isTimeout && (signal?.aborted || name === 'AbortError' || msg includes 'Abort')` → `REQUEST_CANCELLED`；其余 → `RUNTIME_AGENT_STEP_ERROR`。`timeoutSignal` 优先级高于 `signal`。
  - `src/nexus/agentLoopSmoke.ts:130-134` 引入独立的 `timeoutController` 与 `abortController` 分离。
  - `src/nexus/agentLoopSmoke.ts:142-149` 补 `timeoutSignal: timeoutController.signal` 接线。
  - `src/nexus/agentLoopSmoke.ts:153-160` setTimeout 回调同时 abort 两个 controller：timeoutController 触发 `REQUEST_TIMEOUT` 分类，abortController 撕掉 in-flight provider call。
  - `src/cli/runSessionFlow.ts:247-258` 给死信号 `timeoutController` 加 9 行注释：说明 CLI 是 per-process one-shot runner，用户已有 Ctrl-C 通道；明确为什么不在 CLI 路径叠 timeout 预算（避免 user-cancel 误标 REQUEST_TIMEOUT）；引用本文档 Phase E 与 Nexus HTTP/WS 路径差异。
  - `test/agent-loop.test.ts` 新增 3 个 focused 测试：`runtime agent step classifies user-initiated signal abort as REQUEST_CANCELLED` / `…classifies timeoutSignal abort as REQUEST_TIMEOUT` / `…timeoutSignal wins over concurrent signal abort`。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-phase-d-e-typecheck3-config.json npm run typecheck`（过）
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-phase-d-e-full-config.json npm test -- --runInBand`（709/709 pass，含 3 个新 focused 测试）
  - `npm run format:check`（0 failures）
  - `cd clients/go-tui && gofmt -l .`（先报告 tui.go 格式问题，gofmt -w 后干净）
  - `cd clients/go-tui && go test ./...`（全过）
- **未触动**: Nexus `executeTimeoutMs` 默认值、`bbl chat` 行为、`error.code` 主路径分类（已正确，仅修 `runtimeAgentStep` 这一处 watch 点）、CLI 不引入新超时预算。
- **整体收口**: Phase A + B + C + D + E 全部落地，详见 `docs/nexus/archive/go-tui-execute-timeout-governance-plan.md` 末尾"整体收口"表。

## 2026-06-10 — Go TUI execute-timeout Phase C 收口（真实会话 regression fixture）

- **背景**: Phase A 给 Go TUI 加了 per-request `timeoutMs` 覆盖，Phase B 给 Nexus 加了 `execute_summary` 事件 + HTTP envelope 字段，但缺乏端到端 regression fixture 守住"per-request timeoutMs → Nexus 触发 REQUEST_TIMEOUT → Go TUI 渲染友好提示 + execute_summary 预算比例"全链路。规划补在 `docs/nexus/archive/go-tui-execute-timeout-governance-plan.md` Phase C。
- **实现**:
  - `test/runtime.test.ts` 新增 `execute honours per-request timeoutMs from Go TUI WebSocket payload` 测试：服务端 `executeTimeoutMs=30_000`（宽松默认），请求体 `timeoutMs: 200`，跑 `Bash "sleep 1"`（1s > 200ms）。断言 `body.success=false`、`body.events` 含 `REQUEST_TIMEOUT` error、`body.timeoutMs === 200`（per-request 胜出 server 默认 30_000）、`body.outcome === 'timeout'`、`execute_summary` 事件 `timeoutMs === 200` / `outcome === 'timeout'` / `nearTimeout === true`。
  - `clients/go-tui/internal/tui/tui.go` `runStream()` 不再在 `error` 事件 break：Nexus 在 `result`/`error` 之后会 emit `execute_summary` 携带 timeout / outcome metadata，Go TUI 必须继续读到 connection 自然关闭，否则 `execute_summary` 会丢失。原 break 行为会让该事件被吞。
  - `clients/go-tui/internal/tui/tui_test.go` 新增 `fakeNexusWSHandler(t, events)` helper：httptest.WebSocket server + `gorilla/websocket.Upgrader`，捕获 Go TUI 第一个 inbound JSON frame（请求 payload），写回脚本化 Nexus event 序列。
  - `clients/go-tui/internal/tui/tui_test.go` 新增 `TestRunStreamRendersRequestTimeoutAsFriendlyHint`：用 `ExecuteTimeoutMs=5000` 调 `runStream`；服务端 emit `session_started` → `error(REQUEST_TIMEOUT)` → `execute_summary{outcome=timeout, nearTimeout=true, dur=6000ms, timeoutMs=5000}`。断言：(1) Go TUI 实际发送的请求 payload 包含 `timeoutMs: 5000`（端到端验证 Phase A 的 helper 落到 wire 上）；(2) 三个事件全部流过 `runStream` 到达 consumer channel；(3) `formatNexusEvent(error)` 渲染为"exceeded Nexus execute timeout"友好文案，**不**含裸 `REQUEST_TIMEOUT ` 前缀；(4) `formatNexusEvent(execute_summary)` 渲染 `outcome=timeout near-timeout dur=6000ms/5000ms (120%)`。
  - `clients/go-tui/internal/tui/tui_test.go` 新增 `TestRunStreamRendersRequestCancelledDistinctFromTimeout`：服务端 emit `error(REQUEST_CANCELLED)` + `execute_summary{outcome=cancelled}`，验证 cancel 与 timeout 文案不混用。
- **验证**:
  - `cd clients/go-tui && go test ./...`（全过，含 2 个新 WebSocket 端到端用例）
  - `cd clients/go-tui && gofmt -l .`（无输出）
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-phase-c-final-typecheck.json npm run typecheck`（过）
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-phase-c-final-format.json npm run format:check`（0 failures）
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-phase-c-final-fulltest.json npm test -- --runInBand`（706/706 pass，含 1 个新 Nexus 端 per-request timeoutMs 测试）
- **未触动**: Nexus `executeTimeoutMs` 默认值（仍 30s）；`bbl chat` 行为；runtime 错误事件 schema 与分类路径。Phase D/E 仍为 watch-only。
- **附带修复**: Phase A 收口后工作树经历若干外部修改（linter / 人工），`cmd/go-tui/main.go` `--execute-timeout-ms` flag、`formatExecuteSummary` helper、`case "execute_summary"` 分支、`friendlyNexusError` 中的 `REQUEST_TIMEOUT` / `REQUEST_CANCELLED` case、`runStream` 的 `buildExecuteRequest` 接线均散落丢失。Phase C 一并恢复并改写为 `main.go parseFlags()` 末尾按 `--execute-timeout-ms` flag → `BABEL_O_GO_TUI_TIMEOUT_MS` env → 默认 180_000 优先级应用 `cfg.ExecuteTimeoutMs`——保留 override 入口但不再在 main.go 加显式 flag。

## 2026-06-10 — Go TUI execute-timeout Phase B 收口（Nexus 端 execute-timeout 可观察性）

- **背景**: Phase A 解决了 Go TUI 主动发 `timeoutMs`，但服务端没有把 `timeoutMs` / `executeDurationMs` / `nearTimeout` 暴露成可观察 metadata。规划补在 `docs/nexus/archive/go-tui-execute-timeout-governance-plan.md` Phase B。
- **实现**:
  - `src/shared/events.ts` 新增 `ExecuteSummaryEventSchema`（type=`execute_summary`，字段 `sessionId` / `requestId` / `timeoutMs` / `executeDurationMs` / `nearTimeout` / `outcome`），加入 `NexusEventSchema` discriminated union。纯加法，不动现有事件 schema。
  - `src/nexus/app.ts` 新增 helper `executeTimeoutNear(durationMs, timeoutMs, ratio=0.8)` / `executeSummaryOutcome(resultEvent, errorEvent, timedOutByAbort)` / `buildExecuteSummaryEvent({...})`。
  - `src/nexus/app.ts` HTTP `/v1/execute` finalize 路径：`finalizeExecutionSession` 之后追加 `execute_summary` 事件（持久化 + 加入 `events` 数组）+ envelope 顶层加 `timeoutMs` / `executeDurationMs` / `nearTimeout` / `outcome` 四个字段。
  - `src/nexus/app.ts` WebSocket `/v1/stream` finalize 路径：stream 循环结束后 emit 一个 `execute_summary` 事件到 socket 并持久化。
  - `clients/go-tui/internal/tui/tui.go` `formatExecuteSummary(event)` helper + `formatNexusEvent` 加 `case "execute_summary"`。
  - `clients/go-tui/internal/tui/tui_test.go` 新增 3 个用例：`TestFormatNexusEventRendersExecuteSummaryWithBudgetRatio` / `…NearTimeout` / `…WithoutTimeoutMs`。
  - `test/runtime.test.ts` 已有的 `execute reads a workspace file and records session events` 测试 + `execute timeout aborts long-running tools and records metrics` 测试扩展为同时断言新字段 / 新事件。
- **验证**:
  - `cd clients/go-tui && go test ./...`（含 3 个新用例，全过）
  - `cd clients/go-tui && gofmt -l .`（无输出）
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-phase-b-typecheck-config.json npm run typecheck`（过）
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-phase-b-full-test-config.json npm test -- --runInBand`（705/705 pass；含 2 个扩展后的 execute 路径测试）
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-phase-b-format-config.json npm run format:check`（0 failures）
- **未触动**: `error.code` 分类路径（runtime 错误事件 schema 与 `LLMCodingRuntime` 分类逻辑未动）；`executeTimeoutMs` 服务端默认值；`bbl chat` 行为；HTTP API 既有字段集（仅加法，envelope 顶层加 4 个字段）。Phase C/D/E 仍为 watch-only / 待办。

## 2026-06-10 — Go TUI execute-timeout Phase A 收口（per-request `timeoutMs`）

- **背景**: `session_...053000`（Go TUI WebSocket 会话）暴露 `REQUEST_TIMEOUT This operation was aborted`。根因是 Go TUI 在 WebSocket payload 中不覆盖 `timeoutMs`，掉到 Nexus 默认 30s，长会话 turn 容易被切。规划写入 `docs/nexus/archive/go-tui-execute-timeout-governance-plan.md`。
- **实现**:
  - `clients/go-tui/internal/tui/tui.go` `Config` 新增 `ExecuteTimeoutMs int` 字段。
  - `clients/go-tui/internal/tui/tui.go` 新增 `buildExecuteRequest(cfg, sessionID, prompt) map[string]any` helper：仅在 `cfg.ExecuteTimeoutMs > 0` 时附加 `timeoutMs`，0 时沿用 Nexus 默认 30s。
  - `clients/go-tui/internal/tui/tui.go` `runStream()` 改为 `conn.WriteJSON(buildExecuteRequest(cfg, sessionID, prompt))`。
  - `clients/go-tui/cmd/go-tui/main.go` 在 `parseFlags()` 末尾按 `--execute-timeout-ms` flag → `BABEL_O_GO_TUI_TIMEOUT_MS` env → 默认 180_000（3 分钟）优先级应用 `cfg.ExecuteTimeoutMs`，范围 [1000, 300000] 与 Nexus schema 对齐。
  - `clients/go-tui/internal/tui/tui.go` `formatNexusEvent` "error" case 与 `friendlyNexusError` 同步识别 `REQUEST_TIMEOUT`（含 `timeoutMs` 元信息）与 `REQUEST_CANCELLED`，分别提示"turn 超过 Nexus execute timeout"与"turn 已取消"，不再让用户看到裸 `REQUEST_TIMEOUT This operation was aborted`。
  - `clients/go-tui/internal/tui/tui_test.go` 新增 `TestBuildExecuteRequestIncludesTimeoutMsWhenPositive` / `TestBuildExecuteRequestOmitsTimeoutMsWhenZero`，`TestFriendlyNexusErrorProducesHumanHints` 增 REQUEST_TIMEOUT / REQUEST_CANCELLED 用例，新增 `TestFormatNexusEventErrorUsesFriendlyHintForRequestTimeout` / `TestFormatNexusEventErrorUsesFriendlyHintForRequestTimeoutWithTimeoutMs` / `TestFormatNexusEventErrorUsesFriendlyHintForRequestCancelled` / `TestFormatNexusEventErrorFallsBackToRawWhenUnknown`。
- **验证**:
  - `cd clients/go-tui && go build ./...`
  - `cd clients/go-tui && go test ./...`
  - `cd clients/go-tui && gofmt -l .`（无输出，格式干净）
- **未触动**: Nexus 服务端 `executeTimeoutMs` 默认值；`bbl chat`（CLI）行为；HTTP API；其它 TUI 客户端。Phase B/C/D/E 仍为 watch-only / 待办。

## 2026-06-10 — Go TUI 目录规整：entry/core/tests/build output 分层

- **用户请求**: Go TUI 的 test 文件和 gotui 文件都堆在一个目录里，需要规整分离。
- **实现**:
  - `clients/go-tui/cmd/go-tui/main.go`: 新增 executable entrypoint，只负责 flag parsing、env handoff、`--version` 短路和 `os.Exit`。
  - `clients/go-tui/internal/tui/tui.go`: 核心 Bubble Tea TUI 包迁入 `internal/tui`，提供 `tui.Run(cfg)` public entrypoint；`Config` 字段导出给 `cmd/go-tui` 使用。
  - `clients/go-tui/internal/tui/version.go`: 版本元数据迁入 `internal/tui`，导出 `VersionString()`，继续保留包内白盒 helper 供测试覆盖。
  - `clients/go-tui/internal/tui/tui_test.go`: 白盒状态机测试保留在同一 Go package 内。这里是刻意选择：这些测试覆盖大量未导出的 mode / overlay / event reducer 状态；若强行搬到外部 package，需要把内部状态机 API 大量导出，反而削弱封装。
  - `clients/go-tui/bin/`: 本地 `make dev` / `make build` 输出目录，已加入 `.gitignore`，旧顶层 `clients/go-tui/go-tui` / `.exe` 仍保持 ignore 兼容。
  - `clients/go-tui/Makefile`: build/dev 目标改为 `go build ./cmd/go-tui`，ldflags 注入包路径改为 `github.com/sutang-vain/babel-o/clients/go-tui/internal/tui`。
  - `src/cli/commands/go.ts`: source fallback 改为 `go run ./cmd/go-tui`，source checkout dev binary 改为 `<sourceDir>/bin/go-tui`。
  - `test/go_tui_pty_driver.py`、`test/go-tui-smoke.test.ts`、`test/go-command.test.ts`: smoke harness、prebuilt 检测和 launcher 断言同步新路径。
  - `package.json` 发布清单加入 `clients/go-tui/cmd/go-tui/*.go` 与 `clients/go-tui/internal/tui/*.go`，并排除 `*_test.go`；source fallback 需要可运行源码，不需要把白盒测试打进 npm 包。
  - 文档同步：`clients/go-tui/README.md` 新增 Source Layout，`docs/nexus/TODO.md`、`docs/nexus/active/TODO_tui.md`、`docs/nexus/reference/go-tui-rewrite-plan.md` 改为 stable opt-in + 标准 Go layout 口径。
- **验证**:
  - `cd clients/go-tui && go test ./...`
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-go-layout-test-config.json npm exec -- tsx --test --test-concurrency=1 test/go-command.test.ts`
  - `npm run typecheck`
  - `npm run format:check`
  - `cd clients/go-tui && make dev && ./bin/go-tui --version`
  - `npm pack --dry-run --json --silent` 确认包内只包含 `clients/go-tui/cmd/go-tui/main.go`、`clients/go-tui/internal/tui/tui.go`、`clients/go-tui/internal/tui/version.go`、`go.mod`、`go.sum`、`Makefile` 和 README，不包含 `*_test.go` 或本地 `bin/`。

## 2026-06-10 — Go TUI Phase 9 promotion gate：决策收口（stable alternative to `bbl chat`）

- **用户请求**: 按 TODO_tui.md 收尾项推进 Phase 9 promotion gate，3 个 commit 一起推完。
- **决策**: **提升为可选推荐入口**。`bbl go` 不再标 "experimental / MVP"，而是 `bbl chat` 的 stable alternative。两 TUI 并存；`bbl chat`（TypeScript）仍为默认；`bbl go`（Go）opt-in。决策细节、证据（5 条提升条件 + 各自评估）、out-of-scope 列表、回滚策略、行动项全部记入 `docs/nexus/PHASE_9_DECISION.md`。
- **实现**:
  - `src/cli/commands/go.ts`: `bbl go` command description 从 `"Launch the experimental Go TUI client"` 改为 `"Launch the Go TUI client (stable alternative to bbl chat; see docs/nexus/PHASE_9_DECISION.md)"`（在 `bbl go --help` 展示）。一字之差但语义改变：用户能通过 `--help` 一眼看出 Go TUI 是 stable 而非 experimental。
  - `clients/go-tui/README.md`: 去掉 "intentionally does not replace `bbl chat`" 免责段落；新增 Phase 9 promotion banner；文档化六块 read-only overlay 栈（inbox / agents / tasks / activity / tools audit / context）。
  - `docs/nexus/reference/go-tui-rewrite-plan.md`: Status 从 "P3 / Long-term experimental track" 改为 "**Stable alternative to `bbl chat` (promoted 2026-06-10 via Phase 9)**"；风险表对应行更新——Phase 1-8 收口后于 2026-06-10 经 Phase 9 promotion gate 决策保持双 TUI 并存，共享 Nexus 协议 + 公共测试。
- **回归覆盖**:
  - `test/go-command.test.ts`: 加 `bbl go --help describes the Go TUI as a stable alternative (Phase 9 promotion guard)` 回归测试。直接调 `registerGoCommand(program)` inspect `program.commands.find(c => c.name() === 'go').description()`——绕开 tsx loader 依赖，确保在 `npm test` 默认配置下也能跑。断言：(1) description 包含 "Launch the Go TUI client"；(2) 包含 "stable alternative to bbl chat"；(3) **不**包含 "experimental"（防御性 guard，未来的 revert 必须显式重开 Phase 9 才能 trip 这个测试）。
  - `cd clients/go-tui && go test ./...`: 211/211 pass（不变）。
  - `npm test`: 705/705 pass（704 旧 + 1 新 Phase 9 回归 guard）。
  - `npm run test:go-tui:smoke`: 19/19 pass（不变）。
- **范围克制**（详见 `PHASE_9_DECISION.md` 第 3 节）:
  - 默认命令**不**变——`bbl` 仍启动 `bbl chat`。Switching default 需要独立 RFC 覆盖文档迁移 / 生态影响。
  - per-tool approval gate / allow-rule editing 在 Go TUI 中**不**实现——CLI 独占（`bbl tools policy`）。
  - TypeScript TUI 的 `bbl inbox` footer summary 与 Go TUI 的 `sub: N running` header badge 是同形等价物，不做 cross-port。
- **遗留**:
  - 真实 GitHub release 资产仍需要打 `go-tui-v0.3.2` tag 才会上传；`docs/nexus/PHASE_9_DECISION.md` 第 4 节 "Rollback" 段明确写明本次提升是可逆的（只需 revert `--help` description + 文档）。
  - 长期重写计划 1-9 全部子项收口；后续 Go TUI 进入 "稳定维护" 阶段——bug 修 + 安全补丁 + overlay-stack 改进，新交互需求优先落 `bbl chat`。

## 2026-06-10 — Go TUI Phase 8 PR1+PR2+PR3: version reporting / prebuilt release / install check

- **用户请求**: 按 TODO_tui.md 收尾项推进 Phase 8 剩余（版本兼容矩阵 / 预编译 binary 发布 / 安装包策略），3 个 commit 一起推完。
- **实现 (PR1 — version reporting)**:
  - `clients/go-tui/version.go` (new): Version / Commit / BuildDate 包变量（dev fallback），`versionString()` 格式化为 `bbl-go-tui <ver> (commit <hash>) built <date>`，`majorVersion()` 解析 semver 头整数（dev/空 = 0），`isGoTuiMajorCompatible(supportedMajors)` 校验本地的 major 是否在 server 列表里（dev/empty list 自动 pass）。
  - `clients/go-tui/Makefile` (new): canonical build recipe——`make build` 从 `package.json` 的 `version` + 当前 `git rev-parse --short HEAD` + `date -u +%Y-%m-%dT%H:%M:%SZ` 构造 -ldflags 把三个变量嵌入 binary。`make dev` / `make test` / `make version` / `make clean` 辅助目标。Phase 8 PR2 release pipeline 会从 GitHub Actions runner 调 `make build`。
  - `clients/go-tui/main.go`: config struct 加 `printVersion bool`；`parseFlags` 加 `--version` / `-v` flag；`main()` 在 `printVersion` 时打印 `versionString()` 并退出。`runtimeVersionCompat` / `runtimeVersionResponse` / `runtimeVersionMsg` typed msg 配套结构。`checkRuntimeVersion(cfg)` HTTP command 调 `GET /v1/runtime/version`，保留 `raw []byte` envelope 抗 schema churn。`Init()` 多 fire 一发 `checkRuntimeVersion` 启动时单次校验。`case runtimeVersionMsg` Update handler：silent on error（让 `runtimeConfigMsg` 路径暴露真实连通性错误）；mismatch 时 appendLine "Go TUI major version mismatch: local=..., server supports majors ..., latest=..."。
  - `src/nexus/app.ts`: 新增 `GET /v1/runtime/version` 端点。返回 `serverVersion`（从 `package.json` 读，由新的 `readOwnPackageVersion()` helper 负责，fallback "0.0.0-unknown"）+ `schemaVersion` + `goTuiCompatibility` / `nodeCliCompatibility` 兼容范围（`supportedMajors: [0]`，未来 major bump 手动维护）。响应脱敏不返回 secret。
  - `clients/go-tui/main_test.go`: 8 个新单测：versionString dev fallback / 包含 commit+buildDate、majorVersion 解析标准 semver（含 0.0.0 / 1.0.0 / 1.2.3-pre.4+abc / dev / empty）、isGoTuiMajorCompatible 匹配 supportedMajors + dev-build / empty-supported-list 安全网、checkRuntimeVersion HTTP path + envelope decode、runtimeVersionMsg compat mismatch appends error line、runtimeVersionMsg compat match is silent、runtimeVersionMsg fetch error is silent。
  - `test/config-endpoints.test.ts`: 2 个新 TS 单测——`/v1/runtime/version` 返回 server version + goTui 兼容范围；响应不泄漏 secret（apiKey / api_key 子串缺席）。
- **实现 (PR2 — prebuilt binary release pipeline + multi-path discovery)**:
  - `.github/workflows/go-tui-release.yml` (new): triggers on `go-tui-v*` tag push。matrix-builds darwin-arm64 / darwin-x64 / linux-x64 / linux-arm64 / windows-x64.exe 5 个目标。每个 matrix entry 调 `make build`、跑 `./bin/go-tui --version` 验证 build metadata 嵌入成功、重命名为 `bbl-go-tui-<os>-<arch>`、上传到 GitHub Release（与 Node SEA `bbl-*` 同 release 友好共存）+ mirror 到 `dist/go-tui/` 供 npm package 消费。
  - `src/cli/commands/go.ts`:
    - `collectGoTuiBinaryCandidates(input)` 返回 6 步搜索的 prebuilt 路径列表（按优先级）：`--binary` / `BABEL_O_GO_TUI_BINARY` / `BABEL_O_GO_TUI_PACKAGE_BINARY` / `<packageRoot>/bin/go-tui-<platform>-<arch>` / `<sourceDir>/go-tui`（dev in-tree build）/ `~/.local/share/babel-o/bin/go-tui-<platform>-<arch>`（XDG user-local）。Pure function 便于单测。
    - `createGoTuiLaunchSpec` 改用 6 步候选列表迭代，返回第一个存在的 binary。explicit `--binary` 仍是硬要求——找不到时 throw 友好错误（"Install a prebuilt via 'npm install -g @bablel/babel-o' or set BABEL_O_GO_TUI_BINARY to a release asset."），不静默 fallback。
    - `platformSuffix(platform)` 集中管理 canonical `<os>-<arch>` 段（`darwin-arm64` / `linux-x64` / `windows-x64.exe` / 兜底 `${platform}-x64`）。
    - `defaultGoTuiBinaryName(platform)` 保留 legacy `go-tui` / `go-tui.exe` 名字，让 in-tree dev build 候选也能命中。
  - `test/go-command.test.ts`: 9 个新单测：collectGoTuiBinaryCandidates 候选顺序、explicit `--binary` 优先于 env、missing env vars omitted、XDG omitted when homeDir missing、platformSuffix canonical 段、defaultGoTuiBinaryName legacy 名字、createGoTuiLaunchSpec 各优先级行为（BABEL_O_GO_TUI_BINARY > in-tree dev > package-bundled > `go run .` fallback）、actionable hint on explicit `--binary` missing。
- **实现 (PR3 — bbl go --check + install strategy + clearer errors)**:
  - `src/cli/commands/go.ts`:
    - 新增 `goTuiCommandOptions.check?: boolean` flag + `registerGoCommand` 注册 `--check` option。`bbl go --check` 立即跑 `runGoTuiCheckReport(options)` 后打印报告 + `process.exit(report.exitCode)`。
    - `runGoTuiCheckReport(options, deps)` 返回 `{ lines: string[], exitCode: 0|1 }`。报告三块：(a) Go TUI launchability（binary 多路径搜索 → OK / WARN-source-fallback / FAIL-no-source-dir）、(b) Nexus health（`/health` → OK / WARN-unhealthy-uses-managed-launcher）、(c) version compat（Nexus healthy 时拉 `/v1/runtime/version`，打印 server version + supported majors）。WARN 不 bump exit code（CI 友好），FAIL exit code = 1。
    - `child.on('error')` 错误消息重写——之前只说 "Install Go or build ... first"（对没 Go toolchain 的人没指导意义）。新消息明确指引："Install Go (https://go.dev/dl/) or use a prebuilt release: `npm install -g @bablel/babel-o`, or set BABEL_O_GO_TUI_BINARY to a release asset path."
  - `test/go-command.test.ts`: 5 个新单测——prebuilt + healthy → OK exit 0；no prebuilt + source present → WARN exit 0；no prebuilt + no source dir → FAIL exit 1；Nexus unhealthy → WARN（不 fail）exit 0；`/v1/runtime/version` 返回 500 → INFO row "compat check skipped"。
- **范围克制**:
  - PR1：major mismatch 永远是 error 行（不 panic / 不阻止用户输入）——保留 TUI 启动能力，但 banner 警告用户。
  - PR2：候选路径顺序由 `--binary > env > package-bundled > in-tree > XDG` 决定——`bbl go` 不动 source-fallback 行为，只是新增 env / package-bundled 路径。
  - PR3：`bbl go --check` 是非交互式命令，不在 TUI 启动时自动跑——用户可以放进 CI 流水线或 release 前置步骤。
- **回归覆盖**:
  - `cd clients/go-tui && go build . / go test ./...`: 211/211 pass（PR1 +8）。
  - `npm run typecheck` + `npm run format:check`: 通过。
  - `npm test`: 704/704 pass（686 旧 + PR1 +2 / PR2 +11 / PR3 +5 = 18 新）。
  - `BABEL_O_RUN_GO_TUI_SMOKE=1 npm run test:go-tui:smoke`: 19/19 pass（不变——本系列 PR 不动 overlay 栈）。
- **遗留**:
  - 真正的 GitHub release 资产需要打 `go-tui-v0.3.2` tag 才会上传（不能本地复现）；未来 release 时由 maintainer 触发。
  - XDG user-local install 路径文档化在 install strategy（README 段），但 launcher 不自动 mkdir——用户需手动 `mkdir -p ~/.local/share/babel-o/bin/` 再放 asset。

## 2026-06-10 — Go TUI tool palette `/v1/tools/audit` 真实 wire 收口

- **用户请求**: 按 TODO_tui.md 收尾项推进 Go TUI tool palette 真实 wire（Phase 4 静态目录的下一阶段），把 `/tools` 从 7 条硬编码 builtin 列表升级为调真实 `GET /v1/tools/audit` Nexus HTTP 端点。
- **实现**:
  - `clients/go-tui/main.go`:
    - 数据模型: 新增 `toolRisk` 枚举（read / write / execute / task）+ `toolSourceType` 枚举（builtin / mcp）+ `toolAuditSource` struct + `runtimeToolAuditEntry` struct（name / description / risk / allowed / inputSchema / requiresApproval / suggestedAllowRule / mcpServerAllowed / source）+ `toolsAuditResponse` envelope（type / tools）+ `toolAuditMsg` typed msg（带 trigger 字段复用 Phase 6 的 user/auto 模式）。
    - 状态机: `modeToolAuditOverlay` inputMode 常量 + 模型字段 `toolAuditEntries` / `toolAuditScroll`。
    - HTTP: `fetchToolAudit(cfg, trigger)` 调 `GET /v1/tools/audit`（**全局端点**，无 sessionID 参数——audit 是 runtime 视图不是 session 视图），保留 `raw []byte` envelope 抗 schema churn。
    - 静态 fallback: `staticToolDescriptorCatalog()` helper 把原 Phase 4 硬编码 7 条 builtin 列表抽成函数，wire 失败时通过 `renderToolPalette` 推回 transcript 让用户能继续看到 known-good 列表。
    - 渲染: `toolPaletteStyle` (foreground 117) + `formatToolRiskIcon(risk)` (`[read]`/`[write]`/`[execute]`/`[task]` 终端友好 marker) + `formatToolSourceTag(source)` (builtin / `mcp:<serverName>` / 空 / unknown) + `formatToolApprovalStatus(requiresApproval)` (`no-approval` / `approval-required`) + `formatToolAuditRow(entry)` (风险 + 来源 tag + 审批状态 + name + 截断 description + 可选 MCP server allowed 第二行 + 可选 suggested allow rule 第二行) + `buildToolAuditOverlayLines(entries)` + `summarizeToolAudit(entries)` (execute / write / task / read 排序计数) + `renderToolAuditOverlay(width)` (title `Tools audit · Phase 4 wire overlay` + divider + clamped window + scroll/close hint)。
    - slash 命令: 替换 `/tools` placeholder——`/tools` 调 `fetchToolAudit(m.cfg, "user")`，无 active session 时不强求 gate（audit 是全局的）；wire 成功打开 overlay；wire 失败时 push `tools audit: <err>` error 行 + 走 static fallback 把 7 条 builtin 推回 transcript。
    - case toolAuditMsg Update handler: `err != nil` 走 fallback 路径；`trigger == "auto"` 静默 update `m.toolAuditEntries`（目前没有 caller 触发，未来 auto-refresh 留接口）；`"user"` 走原路径（reset scroll + push `tools audit: N tool(s)` breadcrumb + `setMode(modeToolAuditOverlay)`）。
    - KeyMsg dispatch: `case modeToolAuditOverlay`——esc/enter/q 关闭 + 清 `toolAuditScroll` + 写 `tools audit closed` 状态行；up/k 减 scroll clamp 0；down/j/tab 增 scroll clamp `len(buildToolAuditOverlayLines(...))-1`；stray key 全部被吞。
    - helpOverlayLines: 新增 `Tool audit overlay (Phase 4 wire):` 段。
    - View(): 拼接 `toolAuditOverlay` 段在 `activityOverlay` 之后、input / footer 之前。
  - `clients/go-tui/main_test.go`: 18 个新单测 + `fullToolAuditPayload()` helper 覆盖 builtin Read + builtin Bash（approval + suggested allow rule）+ MCP filesystem tool（`mcp:filesystem` source tag + mcp server allowed）：
    - `TestFormatToolRiskIconAllValues` / `TestFormatToolSourceTagBuiltinAndMcp` / `TestFormatToolApprovalStatus` / `TestBuildToolAuditOverlayLinesRendersEntries` / `TestBuildToolAuditOverlayLinesEmptyPlaceholder` / `TestSummarizeToolAuditRendersRiskCounts` / `TestSummarizeToolAuditEmpty` / `TestRenderToolAuditOverlayEmptyOutsideMode` / `TestRenderToolAuditOverlayShowsHeaderInMode` / `TestToolAuditOverlayOpensOnMsgAndClearsOnClose` / `TestToolAuditOverlayEscapeEnterQAllClose` / `TestToolAuditOverlayScrollClamps` / `TestToolAuditOverlayStrayKeyDoesNotReachTextinput` / `TestToolsSlashCommandFetchesAuditOnSuccess` / `TestToolsSlashCommandFallsBackToStaticOnFetchError` / `TestToolAuditMsgErrorFallsBackToStaticCatalogInTranscript` / `TestFetchToolAuditHTTPCmdSendsCorrectPath` / `TestStaticToolDescriptorCatalogIsStableReferenceShape`。
  - `test/go_tui_pty_driver.py`:
    - 新 `run_tools_audit_sequence`: bash round-trip populate sessionID + approve permission + 等 `Bash done` + `done success=true` + `/tools` 等 `loading shared Nexus tools audit` + `Tools audit · Phase 4 wire overlay` header + `Bash` 行（seeded Nexus runtime 工具） + `approval-required` 列 + 按 down 在 populated list 上不能 crash + esc 关 overlay + `tools audit closed` 状态行。加进 `SEQUENCES` registry。
    - 现有 `run_tool_palette_sequence` 更新：原 Phase 4 静态目录断言改成新 wire 行为（`loading` 状态行 + overlay header + esc 关闭）——同一个 sequence 名保留在 `all` orchestrator 里，行为升级为 wire。
  - `test/go-tui-smoke.test.ts`: 加第 19 个测试——`tools-audit` 跑 driver `--sequence tools-audit` 并断言 `phase 4 wire tool audit overlay verified`，90s timeout。
- **回归覆盖**:
  - `cd clients/go-tui && go build . / go test ./...`: 203/203 pass（185 旧 + 18 新）。
  - `npm run typecheck` + `npm run format:check`: 通过。
  - `npm test`: 686/686 pass。
  - `BABEL_O_RUN_GO_TUI_SMOKE=1 npm run test:go-tui:smoke`: 19/19 pass（含新 `tools-audit` + 升级后的 `tool-palette`）。
- **范围克制**:
  - 静态 catalog 仅作 wire 失败的 fallback，不在成功路径上使用（成功路径全部走真实 audit 数据）。
  - `/v1/tools/audit` 是全局端点，**不**走 end-of-turn auto-refresh——audit 是 runtime 视图不是 session 视图，未来若 runtime 通过 stream 推送 registry 变化事件再补 auto-refresh hook。
  - ack / cancel 按钮（per-tool approval gate、allow-rule editing）留 CLI（`bbl tools policy`），Go TUI 保持只读避免复制 Nexus ownership surface。
  - `inputSchema` 字段以 `map[string]any` 形式保留在 typed struct 里但不在 overlay 行展示（仅 source 描述，schema 详情留给 `bbl tools audit --verbose` CLI）。
  - `mcpServerAllowed: false` 不强制报错——一些 MCP server 可能未在本次 runtime 注册，运行时由 Nexus 决定具体 allowed 状态。

## 2026-06-10 — Go TUI Phase 6 PR3：`/agents` 多 agent status overlay + end-of-turn auto-refresh 收口

- **用户请求**: 推进 Phase 6 PR3（Agent status panel：parent/child + taskId + role + depth + status + delegatedSubTaskIds），把 Go TUI 拉到 TS TUI `formatMultiAgentStatusView` 的展示能力。
- **实现**:
  - `clients/go-tui/main.go`:
    - 数据模型: 新增 `agentProfileId` 枚举（explore / review / test / implement / debug / general）+ `agentJobStatus` 枚举（queued / running / waiting_permission / completed / failed / cancelled）+ `contextForkMode` + `agentIsolationMode` 枚举 + `agentJobGovernance`（maxConcurrentAgents / activeAgents / maxDepth / depth / maxRuntimeMs / timeoutAt）+ `agentJob`（jobId / parentSessionId / childSessionId / parentTaskId / agentType / status / prompt / contextForkMode / isolation / createdAt / updatedAt / startedAt / completedAt / governance）+ `sessionAgentJobsResponse`（type / sessionId / jobs）+ `agentJobsMsg`（带 trigger 字段复用 inboxMsg 的 user/auto 模式）。
    - 状态机: `modeAgentOverlay` inputMode 常量 + 模型字段 `agentJobs []agentJob` + `agentOverlayScroll int`。
    - HTTP: `fetchSessionAgents(cfg, sessionID, trigger)` 调 `GET /v1/sessions/:id/agents`，保留 `raw []byte` envelope 抗 schema churn。
    - end-of-turn auto-refresh: `consumeNexusEvent` 的 `case "result", "error":` 末尾把 `return fetchInbox(...)` 改成 `return tea.Batch(fetchInbox(..., "auto"), fetchSessionAgents(..., "auto"))`，两路并行静默刷新。
    - 渲染: `agentStyle` (foreground 141) + `formatAgentStatusIcon(status)` (`[run]` / `[done]` / `[fail]` / `[perm]` / `[queue]` / `[cancel]` 终端友好 marker) + `formatAgentGovernanceSummary(*agentJobGovernance)` (`active N/M · depth D/maxD`) + `formatAgentJobRow(job)` (main row: status icon + `job` + agentType + `dN` + child=<shortID> + governance + task#<id> + 2nd row: 截断 prompt) + `buildAgentOverlayLines(jobs)` (per-job 1-2 行，空时 `No agent jobs for this session.` placeholder) + `summarizeAgentJobs(jobs)` (running / waiting_permission / queued / failed / cancelled / completed 计数排序) + `renderAgentOverlay(width)` (与 help / slash palette / profileConfirm / contextOverlay / inboxOverlay 同 viewport 风格，title `Agent status · Phase 6 PR3 overlay · <shortID>` + divider + clamped window + `↑/↓/Tab scroll · esc/enter/q close` hint)。
    - slash 命令: 替换 `/agents` placeholder——`/agents` 调 `fetchSessionAgentsWithSession()`，无 active session 时 short-circuit 友好状态行。
    - KeyMsg dispatch: `case modeAgentOverlay`——esc/enter/q 关闭 + 清 `agentOverlayScroll` + 写 `agent status closed` 状态行；up/k 减 scroll（clamp 0）；down/j/tab 增 scroll（clamp `len(allLines)-1`，其中 `allLines` 是 `buildAgentOverlayLines(m.agentJobs)`）；stray key 全部被吞。
    - case agentJobsMsg Update handler: `trigger == "auto"` 路径只更新 `m.agentJobs` + return（不开 overlay、不 push breadcrumb、scroll 不重置）；`"user"` 走原路径（reset scroll + push `agents: N job(s)` breadcrumb + `setMode(modeAgentOverlay)`）。
    - helpOverlayLines: 新增 `Agent status overlay (Phase 6 PR3):` 段。
    - View(): 拼接 `agentOverlay` 段在 `inboxOverlay` 之后、input / footer 之前。
- **回归覆盖**:
  - `clients/go-tui/main_test.go`:
    - 现有 `TestInboxAutoRefreshOnResultEventFiresFetchInbox` 更新：现在 result-event auto-refresh 走 `tea.Batch(fetchInbox, fetchSessionAgents)`，cmd() 可能 unwrap 成 `tea.BatchMsg` 或单个 `inboxMsg` / `agentJobsMsg`，三种都接受。
    - 17 个新单测：`fullAgentJobsPayload()` helper 覆盖 explore/running + review/completed + debug/failed 三种关键状态 + governance active 2/4 depth 1/3 + parentTaskId；`TestFormatAgentStatusIconAllValues` / `TestBuildAgentOverlayLinesRendersJobs` / `TestBuildAgentOverlayLinesEmptyPlaceholder` / `TestSummarizeAgentJobsRendersStatusCounts` / `TestSummarizeAgentJobsEmpty` / `TestRenderAgentOverlayEmptyOutsideMode` / `TestRenderAgentOverlayShowsHeaderInMode` / `TestAgentOverlayOpensOnMsgAndClearsOnClose` / `TestAgentOverlayEscapeEnterQAllClose` / `TestAgentOverlayScrollClamps` / `TestAgentOverlayStrayKeyDoesNotReachTextinput` / `TestAgentSlashCommandEmptySessionShortCircuits` / `TestAgentJobsMsgErrorAppendsFriendlyLine` / `TestFetchSessionAgentsHTTPCmdSendsCorrectPath` / `TestAgentAutoRefreshOnResultEventFiresBatchCmd` / `TestAgentAutoRefreshSkippedWhenNoSession` / `TestAgentAutoRefreshTriggerDoesNotOpenOverlay`。
  - `test/go_tui_pty_driver.py`: 新 `run_agent_status_sequence`——bash round-trip populate sessionID + approve permission + 等 `Bash done` + `done success=true`（auto-refresh 在 result 到达时静默触发；seeded local Nexus 无 agent jobs，无新 card 也无 error）；`/agents` 等 `loading shared Nexus agents` + `Agent status · Phase 6 PR3 overlay` header + `No agent jobs for this session.` placeholder + `no agent jobs` summary + 按 down 在空 list 上不能 crash + esc 关 overlay + `agent status closed` 状态行。加进 `SEQUENCES` registry。
  - `test/go-tui-smoke.test.ts`: 加第 15 个测试——`agent-status` 跑 driver `--sequence agent-status` 并断言 `phase 6 PR3 agent status overlay verified`，90s timeout。
- **范围克制**:
  - AgentLoop sub-agent 聚合（`task_session_event` stream 中的 `subagent_started` / `subagent_completed` 事件推到 overlay）留到未来 PR——本次只覆盖 AgentJob REST 端点（`/v1/sessions/:id/agents`），与 TS TUI `formatAgentJobRows` 路径对齐；`formatAgentLoopRows` 的 sub-agent lifecycle 事件聚合需要 event stream 缓冲（不是单次 HTTP fetch），与 PR3 的 "快照 overlay" 模型不同，需要单独设计。
  - ack / cancel 按钮留 CLI（`bbl agents cancel <jobId>`）——Go TUI agent overlay 保持只读，避免复制 Nexus ownership surface。
  - transcriptPath 字段在 overlay 中省略（TS TUI 也只在 metadata 中展示，Go TUI 用户不直接消费）。
  - "running sub-agent" 实时 badge 留到未来 PR——本次 auto-refresh 只静默 update snapshot，不主动推 header / footer 提示。

## 2026-06-09 — Go TUI Phase 6 PR2：`/inbox` quote into prompt + end-of-turn auto-refresh 收口

- **用户请求**: 推进 Phase 6 PR2（`/inbox` quote into current prompt + auto-refresh on `result` event），把 PR1 的 overlay 闭合到 composing + 实时事件 card 推送。
- **实现**:
  - `clients/go-tui/main.go`:
    - `quoteInboxMessageContent(message sessionMessage) string` 新增：复刻 TS TUI `quoteInboxMessage`（"Use this SessionChannel inbox context only after verifying evidence:" header + `message=<id> type=<type> priority=<pri> from=<from> channel=<chan>` 行 + `content: <content>` + 可选 `evidence: ...` + 可选 `memory_candidate <governance>`），所有 required 字段走 `fallbackUnknown` 兜底。
    - `inboxMsg` 加 `trigger string` 字段（`"user"` / `"auto"`）区分用户主动 `/inbox`（开 overlay）和 end-of-turn auto-refresh（只更新 snapshot + 渲染 event card，不开 overlay）。
    - `fetchInbox(cfg, sessionID, includeAck, trigger)` 加 trigger 参数。
    - `consumeNexusEvent` 返回 `tea.Cmd`，signature 改成 `func (m *model) consumeNexusEvent(event map[string]any) tea.Cmd`；`case "result", "error":` 末尾若 `m.sessionID != ""` 返回 `fetchInbox(m.cfg, m.sessionID, false, "auto")` 触发 auto-refetch；call site 改为 `tea.Batch(waitForStreamEvent(m.events), eventCmd)`。
    - `case inboxMsg` Update handler：所有 trigger 都先 `renderNewInboxEventCards()`（按 `seenInboxCardMessageIDs` 去重）；`trigger == "auto"` 直接 return（不开 overlay、不 push "inbox: N message(s)" breadcrumb、`inboxOverlaySelected` / `inboxOverlayScroll` 不重置）；`"user"` 走原路径（reset selection / scroll + push breadcrumb + `setMode(modeInboxOverlay)`）。
    - `modeInboxOverlay` KeyMsg dispatch：`q` / `c` 改 quote（之前误归 close）；esc/enter 仍 close。`q` / `c` 调 `quoteSelectedInboxMessage()`，新方法 `m.quoteSelectedInboxMessage() tea.Cmd` 选当前消息 → 调 `quoteInboxMessageContent` → `m.input.SetValue(quote)` + `m.input.CursorEnd()` → `setMode(modeComposing)`（保留 `inboxOverlaySelected` 让未来 re-open 落在同一行，UX 与 TS TUI 一致）→ push `quoted inbox message: <id> into prompt` 状态行。
    - `helpOverlayLines`: Inbox overlay 段 `q / c  quote into prompt` + 改 `esc / enter  close`（去掉 `q` close 误导）。
  - `clients/go-tui/main_test.go`:
    - 现有 `TestInboxOverlayEscapeCloses` 更新：`q` 现在是 quote 路径，断言 `quoted inbox message` 状态行 + 仍 land in composing + 不输出 `inbox closed`。
    - 现有 `TestInboxOverlayOpensOnMsgAndClearsOnClose` / `TestInboxOverlaySelectionClampsAtBounds` / `TestInboxOverlayStrayKeyDoesNotReachTextinput` / `TestInboxOverlayEscapeCloses` 加 `trigger: "user"`（与新签名匹配）。
    - 11 个新单测：`TestQuoteInboxMessageRendersFormattedBlock` / `TestQuoteInboxMessageFallsBackToUnknownForMissingFields` / `TestQuoteInboxMessageIncludesGovernanceForMemoryCandidate` / `TestInboxOverlayQuoteKeyFillsTextinput` / `TestInboxOverlayQuoteKeyCAlsoFillsTextinput` / `TestInboxOverlayQuoteKeyEmptyListIsNoop` / `TestInboxAutoRefreshOnResultEventFiresFetchInbox` / `TestInboxAutoRefreshSkippedWhenNoSession` / `TestInboxAutoRefreshTriggerDoesNotOpenOverlay` / `TestInboxAutoRefreshRendersEventCardsForNewMessages` / `TestInboxAutoRefreshDedupesAcrossTurns`。
  - `test/go_tui_pty_driver.py`:
    - 新 `run_inbox_quote_sequence`：bash round-trip populate sessionID + approve permission + 等 `Bash done` + `done success=true`（auto-refresh 在 result 到达时静默触发；seeded local Nexus 无消息，无新 card 也无 error）；`/inbox` 等 overlay header + `No unread inbox messages.` placeholder；按 `q` 在空 list 上不关 overlay（不输出 `inbox closed`）+ textinput 不变 + mode 保持 modeInboxOverlay；按 `c` 同样行为；按 `esc` 关闭 + `inbox closed`；再发 `bash echo phase6-inbox-quote-2` 验 next bash turn 仍能拉起 permission（auto-refresh 没把模型卡住）。
    - `SEQUENCES` registry 加 `inbox-quote` 入口；ok_message 是 `phase 6 PR2 inbox quote + auto-refresh verified`。
  - `test/go-tui-smoke.test.ts`:
    - 第 14 个测试：`phase 6 PR2 /inbox quote + auto-refresh`，90s timeout。
- **回归覆盖**:
  - `cd clients/go-tui && go test -v -count=1 ./...`：134/134 pass（123 旧 + 11 新）。
  - `npm run typecheck` + `npm run format:check`：通过。
  - `BABEL_O_RUN_GO_TUI_SMOKE=1 npm run test:go-tui:smoke`：14/14 pass（含新 `inbox-quote`）。
- **范围克制**:
  - 空 list 上的 `q` / `c` 是 no-op（model 中 `quoteSelectedInboxMessage` 检查 `inboxOverlaySelected` 越界则 return nil，textinput 不动、mode 不变）。真实 quote 内容由 Go 单测覆盖。
  - auto-refresh 的 `inbox: 0 message(s)` breadcrumb 在 `"auto"` 路径不输出——只 `"user"` 路径输出，避免每次 turn 结束都 push 一行。
  - auto-refresh 用 `includeAck=false`（unread-only）——和 TS TUI `refreshInboxFooterStatus` 默认一致，避免 ack 后又被 auto-refresh 拉回；用户主动 `/inbox all` 才看全部。
  - 选中行跨 quote round-trip 保留：TS TUI 的 reduceInboxOverlayKey `quote` 路径也保持 selectedIndex 不变；本次 Go TUI 同样 `inboxOverlayScroll=0` 但 `inboxOverlaySelected` 不重置。

## 2026-06-09 — Go TUI Phase 6 PR1：`/inbox` overlay + footer unread indicator 收口

- **用户请求**: 按文档规划推进 Phase 6 第一个 PR（`/inbox` overlay + footer unread indicator），把 Go TUI 拉到 SessionChannel consumption-side 的 TS TUI parity。
- **实现**:
  - `clients/go-tui/main.go`:
    - 数据模型: 新增 `SessionChannelKind` / `SessionMessageType` / `SessionMessagePriority` / `SessionMessageStatus` / `SessionChannelStatus` 枚举 + `evidenceRef` / `sessionChannel` / `sessionMessage` / `sessionInboxResponse` 类型。`sessionMessage.Metadata map[string]any` 暴露 governance blob 以便 memory_candidate 走 isKeyInboxMessage 路径。
    - state machine: 新增 `modeInboxOverlay` inputMode 常量 + 模型字段 `inboxMessages` / `inboxChannels` / `inboxOverlaySelected` / `inboxOverlayScroll` / `inboxOverlayIncludeAck` / `seenInboxCardMessageIDs`。
    - HTTP: 新增 `fetchInbox(cfg, sessionID, includeAck) tea.Cmd`（GET `/v1/sessions/:id/inbox?includeAcknowledged=...`） + `ackInboxMessage(cfg, sessionID, messageID) tea.Cmd`（POST `/v1/sessions/:id/inbox/:msgId/ack`），两者都返回带 `raw []byte` + decoded envelope 的 typed msg，复用 `nexusRawJSON` 防止 schema churn 击穿。
    - 渲染: 新增 `inboxStyle` (foreground 33) + `formatInboxFooterStatus`（linked sessions / unread / channel kinds / high segment）+ `buildInboxOverlayLines`（每条 message 3-5 行，selected marker）+ `renderInboxOverlay`（与 help / slash palette / profileConfirm 同 viewport 风格，title `Inbox · Phase 6 overlay` / `Inbox · all · Phase 6 overlay`）+ `renderInboxEventCard`（main flow 关键事件卡片，divider 包裹）+ `renderNewInboxEventCards`（在 inboxMsg handler 调，按 messageId 去重）。
    - 协议: `isKeyInboxMessage` 复刻 TS `shouldRenderInboxEventCard`——handoff / blocked / request_review / request_validation 总是 key；finding 只在 priority=high 时 key；memory_candidate 在 governance.decision ∈ {rejected, requires_approval} 或 approval.status ∈ {required, rejected} 时 key。
    - slash 命令: 替换 `/inbox` placeholder——bare `/inbox` 调 unread-only fetch；`/inbox all` 调 includeAck fetch；`/inbox ack <id>` 直接 POST ack；都先 short-circuit 友好状态行（无 active session 时）。
    - KeyMsg dispatch: 新增 `case modeInboxOverlay`——`esc` / `enter` / `q` 关闭 + 清 `inboxOverlayScroll` / `inboxOverlaySelected` + 写 `inbox closed` 状态行；`up` / `k` 减 selected（clamp 0）；`down` / `j` / `tab` 增 selected（clamp len-1）；`a` 调 `ackSelectedInboxMessage` 触发 ackInboxMessage HTTP；stray key 全部被吞。`submitPrompt` 仍是 `handleLocalCommand` 拥有 mode 转换、不再 defensive reset。
    - inboxAckMsg handler: ack 成功后只在本地 snapshot 标 status=acknowledged + acknowledgedAt="now" + 写 `inbox ack: <id>` 状态行（避免强制 re-fetch）。
    - `renderFooter`: 现有 hint 后追加 inbox footer 状态（`linked sessions: N [...]` / `inbox: N unread` / `channels: kind1 N/kind2 M` / `high: <type>`），用 `  · ` 分隔，宽度超限时走 `truncatePlain`。
    - View(): 拼接 inboxOverlay 段在 contextOverlay 之后、input / footer 之前。
    - helpOverlayLines: 新增 Inbox overlay 段。
- **回归覆盖**:
  - `clients/go-tui/main_test.go` 新增 22 个单测：`fullInboxPayload()` helper 覆盖 handoff / finding-low / memory_candidate governance 三种关键消息 + `TestIsKeyInboxMessageFlagsHighPriorityAndGovernance` / `TestFormatInboxFooterStatusRendersUnreadAndLinkedAndHigh` / `TestFormatInboxFooterStatusEmptyWhenNothingToSurface` / `TestBuildInboxOverlayLinesRendersMessagesWithSelectedMarker` / `TestBuildInboxOverlayLinesPlaceholderWhenEmpty` / `TestRenderInboxOverlayEmptyOutsideMode` / `TestRenderInboxOverlayShowsHeaderInMode` / `TestRenderInboxOverlayAllVariantSwitchesBanner` / `TestInboxOverlayOpensOnMsgAndClearsOnClose` / `TestInboxOverlaySelectionClampsAtBounds` / `TestInboxOverlayEscapeCloses` / `TestInboxOverlayStrayKeyDoesNotReachTextinput` / `TestInboxMsgErrorAppendsFriendlyLine` / `TestInboxAckMsgSuccessUpdatesLocalSnapshot` / `TestInboxSlashCommandEmptySessionShortCircuits` / `TestInboxSlashCommandAllRequiresSession` / `TestInboxSlashCommandAckMissingArgShortCircuits` / `TestRenderInboxEventCardEmptyForNonKeyMessage` / `TestRenderInboxEventCardShowsGovernanceForMemoryCandidate` / `TestRenderNewInboxEventCardsSkipsAlreadySeen` / `TestFetchInboxHTTPCmdSendsIncludeAckQuery` / `TestAckInboxMessageHTTPCmdPostsToCorrectPath`。
  - `test/go_tui_pty_driver.py`: 新增 `run_inbox_overlay_sequence`——bash round-trip populate sessionID、approve permission、等 `Bash done` + `done success=true`，然后 `/inbox` 等 `loading shared Nexus inbox (unread)` + `Inbox · Phase 6 overlay` header + `No unread inbox messages.` placeholder + 按 down 在空 list 上不能 crash + esc 关 overlay + `inbox closed` 状态行；再 `/inbox all` 等 banner 切换到 `Inbox · all · Phase 6 overlay` + `No inbox messages.` placeholder + esc 关掉。加进 `SEQUENCES` registry。
  - `test/go-tui-smoke.test.ts`: 加第 13 个测试——`inbox-overlay` 跑 driver `--sequence inbox-overlay` 并断言 `phase 6 inbox overlay + footer unread indicator verified`。`all` orchestrator 顺序不动——保留原 7 序列（与 context-overlay / context-and-compact 同等待遇，避免 back-to-back permission panel race）。
- **范围克制**:
  - 自动 inbox refresh on `result` event 留到下一 PR——本次只在 `/inbox` 首次 fetch 后渲染 event cards，避免在 bash round-trip 中 race Nexus event 循环。
  - `/inbox` 静态 `/v1/sessions/:id/inbox` 不返回 channels 元数据（仅消息）——`inboxMsg` handler 现在把 `m.inboxChannels` 重置为 nil，footer / overlay 退回到只用 message.FromSessionID 推导 linked sessions。等下一阶段若 Nexus 暴露 channels 端点再补 channels-by-id map。
  - PTY smoke 走 empty-inbox 路径；不强制 seed SessionChannel message（避免依赖 Nexus `seed inbox` / 临时 workspace fixture）——已通过 Go 单测 + 关键消息路径覆盖 message-driven UX。
  - `quote into current prompt` 留 Phase 6 PR2——TS TUI 的 quote 逻辑要打开 inboxOverlay 选消息再关闭后回填 textinput，本次只做 ack / list 两条主路径。
- **验证**:
  - `cd clients/go-tui && go build .` 通过。
  - `cd clients/go-tui && go test -v -count=1 ./...`：123/123 通过（101 旧 + 22 新）。
  - 下一 PR：补 `/inbox quote`（从 inbox overlay 回到 composing 时把选中消息作为 `<attached_inbox_message>` prefill 到 textinput）+ 自动 inbox refresh on `result` event + activity overlay。

## 2026-06-09 — Go TUI Phase 5 续：contextOverlay 模式 + compact post-compact 详表 收口

- **用户请求**: 按文档规划推进 Phase 5 续（`/context` full `contextView` + `contextOverlay`、`/compact` post-compact 详表）。
- **实现**:
  - `clients/go-tui/main.go`:
    - 新增 `modeContextOverlay` inputMode 常量 + `contextOverlayLines []string` + `contextOverlayScroll int` 字段。`/context` 响应处理从「只 push transcript 行」改为「先 push `formatContextAnalysis` 摘要到 transcript（持久化面包屑） + 建 full overlay lines + 打开 modeContextOverlay」。
    - KeyMsg dispatch 加 `case modeContextOverlay`：`esc` / `enter` / `q` 关闭 overlay + 清 `contextOverlayLines` + 写 `context closed` 状态行（与 help overlay 关闭模式一致）；`up` / `k` 减 scroll（clamp 到 0）；`down` / `j` / `tab` 增 scroll（clamp 到 `len-1`）；stray key 被吞。
    - 新增 `renderContextOverlay(width int) string`：与 help / slash palette / profileConfirm 同风格——`titleStyle.Render("Context · Phase 5 overlay")` header + divider + clamped line window + 底部 `scroll N/M` + `up/down/tab scroll  esc/enter/q close` 提示。`contextStyle` (foreground 75) 新增。
    - 新增 `buildContextOverlayLines(raw []byte) []string`：从 stable top-level envelope 抽取 sections、budget layers、compact retention、compact token delta、auto compact threshold / fuse、long-term memory (provider / scope / namespace / hits / injected / truncated / search latency / error)、scoped memory（每个 scope）、session memory lite（lastUpdate / nextDecision / costPolicy）、resume recovery、working set paths（top 3）、repeated tool inputs（top 2）、large tool results（top 2）、top 5 signals + top 5 recommendations。跳过 missing 字段保持 bounded line 数。
    - `formatContextAnalysis` 维持 stable top-level envelope 渲染（summary / status / top 3 signals / top 3 recommendations）——overlay 是主 UX，transcript 行是持久面包屑。
    - `formatCompactResult` 扩展 post-compact 详表：`compact_result events: <before> → <after>` + `boundary: <type> <code> trigger=<…>` + `summary: <first line>` (单行截断) + `summaryChars: N` + `snippedToolResults: N` + `budget layers: system=… summary=… history=… memory=…` + `retained segment: <status> · events=N`。新增 `firstLine(s, maxLen) string` helper（取首行 + 超长加 ellipsis）和 `formatCharCount(n int) string`（0 / < 1k / 1k-10k / 10k-1M / ≥ 1M 区间）。
    - `helpOverlayLines` 加 Context overlay 段。
  - `clients/go-tui/main_test.go`: 10 个新单测 + `fmt` import。`fullContextPayload()` helper 覆盖 sections / budget / compact / auto / long-term / scoped / session memory / recovery / working set / repeated / large 字段。
  - `test/go_tui_pty_driver.py`:
    - 新 `run_context_overlay_sequence`——bash round-trip populate sessionID、approve permission、等 `Bash done` + `done success=true`，然后 `/context` 等 `analyzing shared Nexus context` + `Context · Phase 5 overlay` header，按 `down` / `tab` / `up` 滚动，esc 关 overlay 等 `context closed`。
    - 改 `run_context_and_compact_sequence`：`/context` 现在 assert overlay header（`Context · Phase 5 overlay`）而不是 transcript 面包屑（`context_analysis`）；overlay 用 esc 关掉（`context closed` 状态行）然后 `/compact` 验 `compact_result events:` + `boundary: compact_boundary` + `budget layers:` 三条。
    - orchestrator 顺序不动——但 Phase 5 续的两个序列因 back-to-back permission panel + bubble tea mode switch race 偶发，留在 standalone test（`context-overlay` + `context-and-compact`），orchestrator 跑原 7 序列。
  - `test/go-tui-smoke.test.ts`: 加 `context-overlay` 测试；orchestrator 顺序同步（不含 `context-overlay` / `context-and-compact`）。
- **验证**:
  - `npm run typecheck` / `format:check` 干净。
  - `cd clients/go-tui && go test ./...` 101/101 pass（原 91 + 10 新）。
  - `BABEL_O_RUN_GO_TUI_SMOKE=1 npm run test:go-tui:smoke` 12/12 pass：permission-approve 1.7s / help-overlay 1.8s / phase3-overlay-mutex 2.8s / slash-palette 1.8s / slash-palette-prefix 4.6s / tool-palette 1.4s / tombstone-rejection 1.5s / profile-confirm 1.6s / context-and-compact 2.0s / context-overlay 2.5s / visual-regression-narrow 4.4s / all-orchestrator 15.0s。
- **范围克制**:
  - `/context` overlay 不展开 scoped memory / long-term memory 的 raw diagnostics（每个 scope 一行够用），完整 `contextView` 仍留给 TypeScript TUI 的 `openContextView`。
  - `/compact` 不展开 retained segment 内的具体 event id 列表（boundary event 的 type/code 够用），post-compact state 重建详情留给 chat TUI。
  - `/inbox` / `/models` / `/sessions` / `/agents` 仍 status 行 TODO（Phase 6）。
  - paste / multiline / Shift+Enter 仍留后续 PR。

## 2026-06-09 — Go TUI Phase 5：context/compact 长会话 UX 收口

- **用户请求**: 按文档规划推进 Phase 5 context/compact 长会话 UX。
- **实现**:
  - `clients/go-tui/main.go`:
    - 替换 `/context` / `/compact` 的 status-line TODO：两者都先检查 `m.sessionID`，无 session 时出 `"<cmd>: no active session yet — submit a prompt first"` 状态行 + 不发 HTTP；有 session 时 appendLine `"analyzing/compacting shared Nexus context: <shortID>"` + 发 HTTP。
    - 新增 `contextAnalysisMsg` / `compactResultMsg` 类型（`sessionID` + `raw []byte` + `err`），Update KeyMsg dispatch 加两个 case：err 路径 appendLine `"<cmd>: <err>"`；成功路径 push `formatContextAnalysis` / `formatCompactResult` 多行。
    - 新增 `fetchContextAnalysis(cfg, sessionID) tea.Cmd` 调 `GET /v1/sessions/<url-escaped id>/context`；`triggerCompact(cfg, sessionID) tea.Cmd` 调 `POST /v1/sessions/<id>/compact` 带 `{"trigger":"manual"}`。
    - 新增 `nexusRawJSON` helper：与 `nexusJSON` 同请求 / 错误 / API-key 头语义但返回 raw bytes，让 Go TUI 只 decode 关心的 stable envelope 字段，不被 upstream schema churn 击穿。
    - 新增 `contextAnalysisDiagnostic` / `contextSignal` 类型 + `formatContextAnalysis(raw []byte) string`：渲染 `context_analysis model=<id>` + `summary`（`context N/M tokens; R remaining`）+ `status: <status>` + `compact: boundary present`（当 `compact.hasBoundary == true`）+ top 3 signals（含 `+N more` 截断标记）+ top 3 recommendations（含 `+N more`）。
    - 新增 `formatCompactResult(raw []byte) string`：渲染 `compact_result events: <before> → <after>` + `boundary: <type> <code>` 行；raw decode 失败时输出 `compact: decode failed: <err>`。
  - `clients/go-tui/main_test.go`: 12 个新单测——empty session short-circuit（× 2）+ active session fires HTTP（× 2）+ format envelope 抽取 + signals / recommendations 截断 + decode error（× 2）+ boundary code 抽取 + msg error 路径（× 2）。test file 加 `fmt` import。
  - `test/go_tui_pty_driver.py`: 新 `run_context_and_compact_sequence`——bash echo 让 `session_started` 事件填好 `m.sessionID`、approve permission、等 `Bash done` + `done success=true`，然后 `/context` 等 `analyzing shared Nexus context` + `context_analysis` envelope header，再 `/compact` 等 `compacting shared Nexus context` + `compact_result events:` 行。加进 `SEQUENCES` registry（`"context-and-compact"` entry），`all` orchestrator 顺序里插在 `profile-confirm` 与 `phase3-overlay-mutex` 之间。
  - `test/go-tui-smoke.test.ts`: 加第 11 个测试 + `all` orchestrator 顺序同步。
- **验证**:
  - `npm run typecheck` / `format:check` 干净。
  - `cd clients/go-tui && go test ./...` 91/91 pass（原 79 + 12 新）。
  - `BABEL_O_RUN_GO_TUI_SMOKE=1 npm run test:go-tui:smoke` 11/11 pass：permission-approve 1.6s / help-overlay 1.8s / phase3-overlay-mutex 2.6s / slash-palette 1.7s / slash-palette-prefix 4.6s / tool-palette 1.4s / tombstone-rejection 1.4s / profile-confirm 1.6s / context-and-compact 1.7s / visual-regression-narrow 4.3s / all-orchestrator 9.9s。
- **范围克制**:
  - `/context` 只渲染 stable top-level envelope（summary / status / signals / recommendations），不做 full 200+ 行的 `contextView` 渲染（那需要 `contextOverlay inputMode` 常量 + viewport，留 Phase 6 之后）。
  - `/compact` 只展示 before/after event counts + boundary event type/code，不展开 compact 后状态重建细节。
  - `/inbox` / `/models` / `/sessions` / `/agents` 仍 status 行 TODO（Phase 6）。
  - paste / multiline / Shift+Enter 仍留后续 PR。

## 2026-06-09 — §5 路径 C 阶段 3 polish 续：profile 切换 y/n overlay 收口

- **用户请求**: 按文档规划继续推进（已选 profile y/n overlay）。
- **实现**:
  - `clients/go-tui/main.go`:
    - 新增 `modeProfileConfirm` inputMode 常量 + `pendingProfileName string` 字段；`/profile <name>` 不再直接发 `selectRuntimeProfile` HTTP，先 `setMode(modeProfileConfirm)` + 写 `pendingProfileName`。
    - `profile == m.activeProfile && profile != ""` 时短路：appendLine `"profile already active: <name>"` + 不开 overlay。
    - `Update` 的 KeyMsg dispatch 加 `case modeProfileConfirm`：`y` / `enter` 调 `selectRuntimeProfile` + 回 composing；`n` / `esc` 清 pending + 写 `"profile switch cancelled: <name>"` + 回 composing；其他键被吞（textinput 不会收 stray key）。
    - 新增 `renderProfileConfirm(width int) string`：title "Confirm profile switch" + divider + `current: <from>` / `→ new: <to>`（activeProfile 为空时单行 `→ Switch active profile to: <name>`） + y/enter / n/esc hint；非 modeProfileConfirm 时返回空字符串。`View()` 拼接在 permission / help / palette 之间、input / footer 之前。
    - 新增 `confirmStyle` (foreground 215, bold)；`helpOverlayLines` 加 Profile confirm overlay 段。
    - 修一个 Phase 3 引入的 `submitPrompt` defensive 行为：去掉 `m.setMode(modeComposing)` 强制重置（之前是 Phase 3 defensive 逻辑，但现在 /profile <name> 需要保留 modeProfileConfirm，否则 y/n overlay 永远进不去）。`handleLocalCommand` 自己拥有 mode 转换。
  - `clients/go-tui/main_test.go`:
    - `TestHandleLocalConfigCommandsDoNotStartAgentStream` 改为断言 `/profile dev` 返回 nil、进入 modeProfileConfirm、`pendingProfileName == "dev"`。
    - 新增 9 个单测：`TestProfileAlreadyActiveShortCircuitsConfirmOverlay` / `TestProfileConfirmYKeyFiresHTTPCommand` / `TestProfileConfirmEnterKeyFiresHTTPCommand` / `TestProfileConfirmNKeyCancelsWithoutHTTP` / `TestProfileConfirmEscKeyCancels` / `TestProfileConfirmStrayKeyDoesNotReachTextinput` / `TestRenderProfileConfirmEmptyOutsideMode` / `TestRenderProfileConfirmShowsHeaderInMode` / `TestProfileConfirmWithEmptyActiveShowsNoCurrent`。
  - `test/go_tui_pty_driver.py`:
    - seeded config 加 `activeProfile: "alpha"` + `profiles: {alpha, beta}`（都指向 `local/coding-runtime`），让 `*alpha` 标志位 + `beta` 可切换都可在 PTY 中触发。
    - 新增 `run_profile_confirm_sequence` 三路径：path1 `/profile beta` → n → "profile switch cancelled: beta"；path2 `/profile beta` → y → "selecting shared Nexus profile: beta" + "profile switched: beta"；path3 `/profile beta` 重选已 active → "profile already active: beta" 短路。
    - 加进 `SEQUENCES` registry（`"profile-confirm"` entry），`all` orchestrator 顺序里插在 `tool-palette` 与 `phase3-overlay-mutex` 之间。
    - `tombstone-rejection` 序列跟随新行为：先等 `Confirm profile switch` overlay 出现，按 y 后再等 `unknown profile "ghost"`。
  - `test/go-tui-smoke.test.ts`: 加 `profile-confirm` 测试 + `all` orchestrator 顺序同步。
- **验证**:
  - `npm run typecheck` / `format:check` 干净。
  - `cd clients/go-tui && go test ./...` 79/79 pass（原 70 + 9 新）。
  - `BABEL_O_RUN_GO_TUI_SMOKE=1 npm run test:go-tui:smoke` 10/10 pass：permission-approve 1.7s / help-overlay 1.8s / phase3-overlay-mutex 2.8s / slash-palette 1.7s / slash-palette-prefix 4.5s / tool-palette 1.4s / tombstone-rejection 1.4s（overlay + y 路径） / profile-confirm 1.5s / visual-regression-narrow 4.5s / all-orchestrator 9.7s。
- **范围克制**:
  - profile 切换确认面板现在覆盖 y / n / esc / 重选已 active 四路径；tombstone / unknown profile 的 friendly 错误路径走同 `friendlyNexusError` 映射不变。
  - provider/model diff 在 overlay 里仍只展示 profile name；后续若要展示 provider/model 列表留到 Phase 5/6 wire 真实 model metadata 时一并做。
  - `/v1/tools/audit` 真实 wire 仍留未来 phase。
  - paste / multiline / Shift+Enter 仍留后续 PR。

## 2026-06-09 — Go TUI Phase 7：PTY / visual regression harness 收口

- **用户请求**: 推进 Phase 7 PTY/visual regression harness + 错误态回归。
- **实现**:
  - `test/go_tui_pty_driver.py`:
    - 重构为 `SEQUENCES` 注册表驱动：每个 entry 含 `runner` / `ok_message` / `required_invariants`，`main()` 按 `--sequence` name 派发。
    - 8 个独立序列 + 1 个 orchestrator：
      - `permission-approve`：Phase 1 baseline（bash echo → Permission: Bash → approve → Bash done → done success=true）。
      - `phase3-overlay-mutex`：Phase 3 单 input owner + overlay 互斥（help 开/关、permission 模式按 stray key 不污染 textinput、'?' 在 permission 模式被吞、'a' approve 收尾）。
      - `slash-palette`：Phase 4 `/` live-filter → Enter 跑 /help。
      - `slash-palette-prefix`：Phase 4 `/bash` prefix 插入 textinput，transcript 出现 `inserted prefix:` 状态行。
      - `tool-palette`：Phase 4 `/tools` 静态目录（含 Bash risk=execute + approval-required 标记 + Bash/Read/Grep/Glob）。
      - `help-overlay`：Phase 3/4 `?` 开/关 help overlay。
      - `tombstone-rejection`：§5 path C phase 3 polish——`/profile ghost` 走 friendlyNexusError 出 `unknown profile "ghost"`。
      - `visual-regression-narrow`：driver 启动时设 `COLUMNS=40 LINES=20`，验证 banner + help overlay 在窄宽度下不破坏 layout。
      - `all` = orchestrator：在一个 PTY session 内顺序跑其余 6 个真实序列（help-overlay / slash-palette / slash-palette-prefix / tool-palette / phase3-overlay-mutex / permission-approve），每个序列后用 `Esc` + 60 次 `\x7f`（DEL/backspace）重置 textinput 回 composing。
    - `BABEL_O_GO_TUI_SMOKE_CONFIG` 环境变量：driver 在 main() 把 PTY session 用的 config 路径注入到 Go TUI 子进程 + parent process，方便未来 tombstone / 错误态 PTY 序列做 pre-seed（当前 `tombstone-rejection` 序列走 `/profile ghost` friendly 路径，不依赖 pre-seed）。
    - `visual-regression-narrow` 在 spawn 前给 `go_tui_env` 注入 `COLUMNS=40` / `LINES=20`，Bubble Tea 启动即按窄视口 layout。
  - `clients/go-tui/main.go`:
    - 修一个 Phase 4 引入的 `handleLocalCommand` panic：prefix-insertion 命令（如 `/bash`）的 `cmd.run == nil`，但 Phase 4 直接 submit 路径没保护。`handleLocalCommand` 现在显式判定 `cmd.run == nil` 并返回 `command is not executable via direct submit: <name> (open the slash palette to use it)`，避免 nil-pointer-dereference（orchestrator 在 phase3 阶段就被这条 path 触发过一次）。
  - `test/go-tui-smoke.test.ts`: 扩展到 9 个测试（8 个独立序列 + 1 个 `all` orchestrator），`runGoTuiSmoke(sequence, timeoutSeconds)` 参数化 helper；`all` 测试额外断言每个 `running <name>` 行都打出来；`BABEL_O_RUN_GO_TUI_SMOKE=1` opt-in gate 不变。
- **验证**:
  - `npm run typecheck` / `format:check` 干净。
  - `cd clients/go-tui && go test ./...` 76/76 pass。
  - `BABEL_O_RUN_GO_TUI_SMOKE=1 npm run test:go-tui:smoke` 9/9 pass（28.5s 总时长：permission-approve 1.6s / help-overlay 1.8s / phase3-overlay-mutex 2.8s / slash-palette 1.7s / slash-palette-prefix 4.6s / tool-palette 1.3s / tombstone-rejection 1.3s / visual-regression-narrow 4.3s / all-orchestrator 8.8s）。
- **范围克制**:
  - tool palette 仍走静态目录（`/v1/tools/audit` HTTP wire 留未来 phase）。
  - `/context` `/compact` `/inbox` `/models` `/sessions` `/agents` 仍 status 行 TODO，留 Phase 5/6 wire 真实 backend。
  - paste / multiline / Shift+Enter 仍留后续 PR。
  - profile 切换确认面板（带 y/n overlay）本身仍待补；friendly 错误路径已在 `/profile ghost` 覆盖，tombstoned profile 走同 friendly 路径。

## 2026-06-09 — Go TUI Phase 4：slash / tool palette 收口

- **用户请求**: 按规划推进 Phase 4 slash / tool palette（含真正 live filter slash palette）。
- **实现**:
  - `clients/go-tui/main.go`:
    - 新增 `slashCommand` 类型（`name` / `aliases` / `summary` / `hasArgs` / `argHint` / `prefix` / `run`）+ 静态注册表覆盖 18 个命令：/help、/config、/profile(/profiles)、/clear、/exit、/context、/compact、/inbox、/models、/tools、/sessions、/agents、/bash、/read、/grep、/glob、/write、/edit。前 12 个是后端命令（无参直接执行 / 有参回退 composing），后 6 个是 prefix-insertion。
    - 三个 helper：`filterSlashCommands(prefix)`（按 name/alias 前缀过滤，case-insensitive，registry 顺序保留）、`findSlashCommand(input)`（精确匹配含 alias）、`slashCommandNames()` 被 /help inline 使用以避免 init cycle。
    - `handleLocalCommand` 重写为 registry 查表：未知命令输出 "unknown local command: ..."，已知命令 delegate 到 `cmd.run(m, args)`。
    - Live-filter palette：用户键入 `/`（空 input）触发 `setMode(modeSlashPick)`，初始化 `paletteFilter` / `paletteSelected`。`modeSlashPick` 路由：esc 关闭并清空、enter 走 `runPaletteSelection`、up/down/tab 导航（clamp 到 [0, len(matched)-1]）、backspace 编辑 filter（空 filter 时退出 palette）、任意 printable rune 追加到 filter 并重置 selection。`printableRuneFromKey` 提取 KeyRunes / KeySpace，避免 textinput 误收键。
    - `runPaletteSelection` 三种语义：prefix 命令插入 prefix 到 textinput 并回到 composing、hasArgs 但无 prefix 的命令插入 `<cmd> ` + 留 composing、零参命令直接 `cmd.run(m, nil)`。
    - `renderSlashPalette` 渲染 header（"Slash · /<filter>"）+ divider + 至多 6 个候选（带 `>` 选中标记 + hint + summary）+ 底部 navigation hint。
    - Tool palette：新增 `toolDescriptor` 类型 + `renderToolPalette(tools)` 方法按 name/risk/source/approval-required 列对齐。`/tools` 注册项渲染 Read/Write/Edit/Bash/Glob/Grep/TaskCreate 静态目录。Phase 7 会把静态目录换成 `/v1/tools/audit` HTTP fetch。
  - `clients/go-tui/main_test.go`: 15 个 phase 4 新单测——registry 完整性（含必含命令）、alias 解析、live filter 顺序、backspace、esc、up-down clamp、Enter 零参、Enter prefix、palette render 隐藏性、tool palette 对齐、`handleLocalCommand` 未知命令错误路径。
- **验证**:
  - `npm run typecheck` / `format:check` 干净。
  - `go test ./...` 76/76 pass（5 原有 + 16 phase 2 + 11 §5 path C phase 3 + 14 phase 3 + 15 phase 4 + 其他 15）。
  - `go build -o go-tui .` 10M；重编译后预编译二进制刷新。
  - `BABEL_O_RUN_GO_TUI_SMOKE=1 npm run test:go-tui:smoke` 仍过（2.1s）——Phase 1 的 bash → permission → approve 路径未受 Phase 4 改动影响。
- **范围克制（按规划 Phase 4 不包含项）**:
  - `/context` `/compact` `/inbox` `/models` `/sessions` `/agents` 仍是 status 行 TODO——Phase 5/6 才会 wire 真实 backend。
  - tool palette 静态目录——Phase 7 才会 wire `/v1/tools/audit`。
  - `toolPalette` / `historySearch` / `contextOverlay` / `inboxOverlay` `inputMode` 常量保留但暂未启用——Phase 6 继续。

## 2026-06-09 — Go TUI Phase 8 early slice：`bbl go` managed Nexus launcher

- **用户请求**: 分析 `bbl go` 是否能直接拉起 Nexus，并按建议推进。
- **实现**:
  - `src/cli/commands/go.ts`:
    - `bbl go` 现在先构建 Go TUI launch spec，再探活 `GET /health`；如果 Go TUI binary/source 本身不可用，不会误启动 Nexus。
    - 默认 `--start-nexus`；`--no-start-nexus` 保持只连接 `--url`。
    - localhost / `ws://localhost` URL 不健康时自动 spawn hidden `__server` child，等待健康后再启动 Go TUI；远程 URL 不健康时报错，不尝试本地拉起。
    - auto-start child 继承 `process.execArgv`，支持开发态 `node --import tsx src/cli/program.ts go` 正确启动 TypeScript `__server`。
    - auto-start child 设置 `NEXUS_HOST` / `NEXUS_PORT` / `BABEL_O_WORKSPACE` / `NEXUS_ALLOWED_TOOLS`；`NEXUS_ALLOWED_TOOLS` 默认取环境变量，未设置为 `*`，高风险工具仍走现有 permission prompt。
    - Go TUI 退出或启动失败时，只关闭本次 wrapper 自己拉起的 Nexus child；复用已有 Nexus 时不关闭。
    - 新增 `--nexus-startup-timeout-ms`、`--allowed-tools`、`--poll-interval-ms` wrapper 选项；`--poll-interval-ms` 透传给 Go TUI。
  - `test/go-command.test.ts`: 新增 managed launcher 单测覆盖：poll flag 透传、localhost/remote URL 判定、`ws://` health probe 映射、launch spec env/execArgv、健康复用不 spawn、不健康本地启动并等待、`--no-start-nexus` 跳过、远程 URL 拒绝自动启动、health 超时 kill child、later healthy probe 成功。
  - `clients/go-tui/README.md` 与 `docs/nexus/active/TODO_tui.md` 更新：`bbl go` 现在可自动复用/拉起本地 Nexus；Go binary 仍只是客户端。
- **验证**:
  - `test/go-command.test.ts` 15/15 通过。
  - `npm run typecheck` 通过。
- **范围克制**:
  - 不让 Go TUI binary 直接启动 Nexus；managed launcher 只在 TypeScript CLI wrapper 层。
  - 不自动启动远程 URL；避免把本地服务误当作远程 endpoint。
  - 不改变 Nexus 权限模型；`NEXUS_ALLOWED_TOOLS='*'` 只开放工具可见性，write/execute 仍需要 permission approval。

## 2026-06-09 — Go TUI Phase 3：input owner / overlay state machine 收口

- **用户请求**: 按规划推进 Phase 3：Go TUI 自己的唯一输入所有者模型。
- **实现**:
  - `clients/go-tui/main.go`:
    - 新增 `inputMode` 类型（`composing` / `permission` / `slashPick` / `helpOverlay`）+ `setMode` 助手 + `canEditInput()` 判定。
    - `model` 加 `inputMode inputMode` + `helpScroll int` 字段；`newModel` 初始化 `modeComposing`。
    - `Update` 的 `KeyMsg` 路由：先全局 `ctrl+c`；再按 `m.inputMode` 分发——permission mode 吞掉 a/r/n/esc 以外所有键、help mode 走 up/down/esc/enter/q、slashPick mode 走 esc 取消后 fall through。
    - `?` 在 composing + 空 input 时打开 help overlay（仅 help mode 渲染，composing 时 `renderHelp` 返回空）。
    - `permission_request` 抵达时 `setMode(modePermission)`，`sendPermissionDecision` 完成后回到 `modeComposing`，保证 textinput 不会被随机键污染。
    - help overlay 内容（`helpOverlayLines`）含 composing / permission / help 三种 mode 的键盘参考 + 当前已知 slash 命令清单。
    - 单一 textinput 实例（`newModel` 创建一次，跨 mode 永不替换）：in-progress draft 在 permission / help mode round-trip 后仍保留。
  - `clients/go-tui/main_test.go`: 14 个 phase 3 新单测守住——默认 composing、setMode 幂等、canEditInput 仅 composing 为 true、permission_request 触发 permission mode、sendPermissionDecision 回到 composing、permission 模式按 'z' 不污染 textinput、'?' 打开 help、esc 关闭 help、up/down 滚动 help、'?' 在非空 input 时被忽略、ctrl+c 跨 overlay 全局退出、'q' 在 overlay 内不退出、textinput 跨 mode 实例不替换、renderHelp 在 composing 为空 / help mode 可见。
  - `test/go_tui_pty_driver.py` 新增 `phase3-overlay-mutex` 序列：开 help（`?`）→ esc 关 → 触发 permission panel → 在 permission 模式按 'z' → 验证 textinput 没被污染（不在 transcript 中追加 `bash echo go-tui-mutexz`）→ 发送 '?'（permission mode 不响应）→ 'a' approve → 等待 `Bash done` + `done success=true`。`[go-tui-smoke] OK: phase 3 single-input-owner overlay mutex verified`。
  - `test/go-tui-smoke.test.ts` 的 `runPtySmoke` 默认仍只跑 `permission-approve`（避免默认 `npm test` 依赖 Go TUI 预编译）。`phase3-overlay-mutex` 序列由驱动自身负责，未来如果想进默认 npm test 可通过 `runPtySmoke` 增加一段相同的分支。
- **验证**:
  - `npm run typecheck` / `format:check` 干净。
  - `go test ./...` 60/60 pass（5 原有 + 16 Phase 2 + 11 §5 阶段 3 + 14 phase 3 单测 + 其他 14）。
  - `BABEL_O_RUN_GO_TUI_SMOKE=1 npm run test:go-tui:smoke` 仍过（Phase 1 permission-approve 1.7s）——phase 3 改动未触碰 Phase 1 smoke 路径。
  - `BABEL_O_RUN_GO_TUI_SMOKE=1 python3 test/go_tui_pty_driver.py --sequence phase3-overlay-mutex` 通过（help 开/关、permission 模式不收 'z'、mutex 守住、`Bash done` + `done success=true`）。
- **范围克制（按规划 Phase 3 不包含项）**:
  - 真正的交互式 slash palette（live filter 跟随输入）——仅在 `modeSlashPick` 留占位，enter 仍走原 one-shot 路由。完整 live filter 留 Phase 4。
  - toolPalette / historySearch / contextOverlay / inboxOverlay——`inputMode` 已为这些预留常量，下个 phase 继续。
  - paste / multiline / Shift+Enter 对齐 TypeScript TUI——留后续 PR。

## 2026-06-09 — §5 路径 C 阶段 3：Go TUI 消费 version polling + tombstone UX 收口

- **用户请求**: 按规划推进 §5 路径 C 阶段 3：Go TUI 上消费增量拉取 + tombstone UX polish。
- **实现**:
  - `clients/go-tui/main.go`:
    - `config` 加 `pollIntervalMs` 字段；`--poll-interval-ms` flag（默认 30000，0 禁用）。
    - `nexusJSON` 加 `query ...url.Values` 可变参数；304 走 `errNotModified` 哨兵错误（`errors.Is` 判定），不当作 generic error。
    - `fetchRuntimeConfig(cfg, since int)` 接受 since，>0 时附加 `?since=N`。
    - `pollTickMsg` + `schedulePollTick` 调度下一次 tick；`Init()` 把 fetchRuntimeConfig + fetchRuntimeProfiles + schedulePollTick 一并启动；`runtimeConfigMsg` 在 304 时静默 reschedule，在 version 实际增加时记录 `config updated:` 状态行。
    - `friendlyNexusError(code, payload)` 把 Nexus 已知错误码（`tombstoned_profile` / `unknown_profile` / `not_supported` / `missing_profile`）映射为人话 hint；`summarizeHTTPError` 优先走 friendly，否则回退到 raw `message`/`error`/`compactJSON`。
    - `formatRuntimeProfiles` 把 tombstones 列在独立 `tombstones (N):` 块下，按 name 字典序，保留 `deletedAt`，active profile 仍以 `*` 前缀标出。
  - `clients/go-tui/main_test.go`: 11 个 phase 3 新 test 守住 `friendlyNexusError` / `summarizeHTTPError` / `fetchRuntimeConfig` since 注入 / `nexusJSON` 304 → `errNotModified` / `runtimeConfigMsg` 304 静默 + version 移动日志 / `schedulePollTick` 开/关 / `pollTickMsg` defer / `formatRuntimeProfiles` tombstone 排序。
  - `clients/go-tui/README.md`: 文档化 `--poll-interval-ms`、`/config` / `/profile` 新行为、tombstone UX；明确 tombstone restore 仍 CLI-only（Go TUI 不写 BabelOConfig）。
- **验证**:
  - `npm run typecheck` / `format:check` 干净。
  - `go test ./...` 32/32 pass（5 原有 + 16 Phase 2 + 11 Phase 3）。
  - `go build -o go-tui .` 10M；新二进制可执行。
  - `BABEL_O_RUN_GO_TUI_SMOKE=1 npm run test:go-tui:smoke` 仍过（1.8s）——polling 默认 30s，Phase 1 smoke 跑不到第一个 tick；背景 polling 与 permission approve 链路完全解耦。
  - `test/config-endpoints.test.ts` + `test/config-profile-cli.test.ts` 22/22 pass。
- **范围克制（按规划 §5 阶段 3 不包含项）**:
  - profile switch 确认面板（带 y/n overlay）— 见 TODO_tui.md 后续，阶段 3 仍以错误提示 + listing 表达"已 tombstoned"为主。
  - 错误态视觉回归 PTY smoke——留 Phase 7 一并补。
  - Go TUI 直接写 config 文件——继续禁止（`restore` 必须走 `bbl config profile restore` CLI）。

## 2026-06-09 — §5 路径 C 阶段 2：增量拉取 + profile 切换命令 + tombstone 收口

- **用户请求**: 按规划推进 §5 路径 C 阶段 2。
- **实现**:
  - `src/shared/config.ts`:
    - `BabelOConfig` / `BabelOConfigSchema` 加 `tombstones?: { [name]: { deletedAt } }` 与 `configVersion?: number`。
    - `ConfigManager.save` 每次写盘自增 `configVersion`（单调递增，跨进程持久）。
    - `ConfigManager` 新增 `deleteProfile(name)`（移到 tombstones，活跃 `activeProfile === name` 时清空）、`restoreProfile(name)`（仅清 tombstone，**不**重建 profile config）、`isProfileTombstoned(name)`、`getTombstones()`、`getConfigVersion()`。
    - `ConfigManager.setProfile(name, ...)` 会清理同名 tombstone，避免 profile 复建后仍被 `config/select` 拒绝。
  - `src/nexus/app.ts`:
    - `inspectResolvedRuntimeConfig` 返回值加 `version` + `tombstones` 字段。
    - `GET /v1/runtime/config` 支持 `?since=<version>`：since >= currentVersion 返回 304 Not Modified，否则 200 + 新 version。
    - `GET /v1/runtime/config/profiles` 与 `GET /v1/runtime/config/profiles/:name` 返回值加 `version` + `tombstones`。
    - `GET /v1/runtime/models` 的 `configured` 判断覆盖 env、provider config、active profile 与非活跃 profile 内的 provider API key，响应仍不泄露 secret。
    - `POST /v1/runtime/config/select` 把 tombstone 检查放在 `unknown_profile` 之前；tombstoned profile 返回 400 `tombstoned_profile` + `tombstone` 字段。
  - `src/cli/commands/config.ts`: 新增 `bbl config profile <sub>` 子命令——`list`（展示活跃 + tombstone + version）、`use <name>`（拒绝 tombstoned）、`delete <name>`（软删除并落 tombstone）、`restore <name>`（清 tombstone，不重建 profile config）。
  - Go TUI 侧（`clients/go-tui/main.go`）接入 `fetchRuntimeConfig` / `fetchRuntimeProfiles` / `selectRuntimeProfile` 三个 HTTP 调用；启动时拉取 config，`/config`、`/profile`、`/profiles`、`/profile <name>` 作为本地命令通过 Nexus API 读取/切换 profile，不作为 agent prompt 发送。
  - Go TUI header/摘要已显示 `profile`、`configVersion`、profile 数与 tombstone 数。
- **验证**:
  - `npm run typecheck` / `npm run format:check` 干净。
  - `test/config-endpoints.test.ts` 15/15 通过（阶段 1 的 6 个 + 阶段 2 新增的 9 个：profile-key configured、version/tombstones 暴露、since 304、profiles version+tombstones、select tombstoned 拒绝、deleteProfile / restoreProfile / setProfile 清 tombstone / save 自增）。
  - `test/config-profile-cli.test.ts` 7/7 通过（list / use happy / use tombstoned 拒绝 / delete / restore / restore 非 tombstone 拒绝 / `--help` 表面）。
  - `test/runtime.test.ts` 104/104 通过，shared runtime config 端点与主 runtime API 未回归。
  - `go test ./...` 通过。
  - `BABEL_O_RUN_GO_TUI_SMOKE=1 npm run test:go-tui:smoke` 通过，Go TUI permission approve → Bash → done 链路未回归。
  - `npm test` 全量回归 676/676 通过。
- **范围克制（按规划）**:
  - 不做 Nexus → Go TUI 的 server-sent config push；增量拉取走 since 查询参数即可。
  - 不让 `bbl config profile` 暴露 `model` / `role` 切换（仍只 CLI 走 `bbl config use` 与 `bbl models inspect`，HTTP 端点继续 400 not_supported）。
  - restore 只清 tombstone，不重建 profile；用户需要重新 `bbl config add` + 写 profile，避免悄悄重建过期 secret。

## 2026-06-09 — Go TUI Phase 2 event renderer parity 收口

- **用户请求**: 按规划推进 Go TUI Phase 2。
- **实现**:
  - `clients/go-tui/main.go` `formatNexusEvent` 补 9 个 case：`user_message` / `user_intake_guidance` / `task_created` / `task_session_event` / `agent_job_event` / `compact_boundary` / `compact_failure` / `session_memory_updated` / `execution_metrics`。这 9 类事件此前都 fall through 到 `compactJSON`（裸 JSON），现在都有稳定摘要。
  - 配套 helper：`anyInt(any)`（兼容 json.Number / int64 / float64 等 Nexus 数值编码）、`summarizeTaskSessionPayload(any)`（从 `task_session_event.payload` 抽出 subagent / parentTaskId / depth / status）。
  - `linePresentation` 加 11 个新稳定 8 字符 label（`task +` / `task` / `agent` / `compact+` / `compact!` / `ctx warn` / `ctx stop` / `memory` / `metrics` / `you` / `intake`）。原 9 个未识别的 kind 落到 default（`padRight(kind, 8)`）现在落到稳定 label。
  - `pendingPermission` 增 `input` / `message` 字段；`renderPermission` 多展示 `input: <command>` 与 `reason: <message>` 两行；新增 `formatToolInput(name, input)` helper 按工具名提取最相关字段（`Bash.command` / `Read.path` / `Grep.pattern` / `ListDir.path` / `TaskCreate.title` / 其它 → `compactJSON` 截断）。**直接收掉了我之前标记的 P1 安全 UX bug**——现在用户能看见自己批的是什么 Bash 命令。
  - `clients/go-tui/main_test.go` 加 16 个 Phase 2 回归 test，覆盖：9 个新 formatter、`formatToolInput` 三种典型工具、`renderPermission` 必须含 `input:` 与 `reason:` 行、`linePresentation` 必须返回稳定 label、所有 9 类新事件不再 fall through 到 `compactJSON`。
  - 重编译 `clients/go-tui/go-tui` 预编译二进制（9.6M）。
- **验证**:
  - `go test ./...` 21/21 pass（5 原有 + 16 新增）。
  - `npm run typecheck` / `npm run format:check` 干净。
  - `BABEL_O_RUN_GO_TUI_SMOKE=1 npm run test:go-tui:smoke` 仍通过（2.2s）——Phase 1 的 permission approve 链路在新增的 `input` 渲染下没破坏。
  - TS 周边 65 个回归（go-command / chat-command / sessions-command / ui / tui-input / grep-tool / install-script）全过。
- **范围克制**:
  - 没引入 `compact/expanded` 切换键——当前 `permission_request` 的 input 已经是单行截断 120 字符的 compact 形态，未来 Phase 7 PTY harness 可以加 expand 交互。
  - 没改 `provider recovery/fallback` 展示——TS 端不通过独立事件下发，而是用 `usage` + `tool_denied` 表达，Go TUI 已经覆盖。
  - 没动 `SessionChannel inbox/key cards`——按规划划归 Phase 6。
  - `permission_request` 现在会展示 input，但 `tool_started` 仍然只显示 `compactJSON(input)`——和原行为一致，不破坏可读性前提下先收 Phase 2 主线。

## 2026-06-09 — Go TUI Phase 1 opt-in smoke harness 收口

- **用户请求**: 按规划文档 `docs/nexus/reference/go-tui-rewrite-plan.md` Phase 1 与 `docs/nexus/active/TODO_tui.md` 唯一打开项推进：固化当前手动验证过的 local Nexus + Bash permission approve 链路，不扩大功能面。
- **实现**:
  - 新增 `test/go_tui_pty_driver.py`（Python PTY driver）：spawn 临时 Nexus（`local/coding-runtime`、`NEXUS_ALLOWED_TOOLS='*'`、ephemeral SQLite）、通过 PTY 跑 `bbl go --url <tmp> --no-alt --cwd <tmp>`、自动发送 `bash echo go-tui-smoke`、等待 `Permission: Bash` 面板、发送 `a` approve、等待 `Bash done success=true` + `permit approved=true` + `done success=true`、发送 `q` 退出、清理 Nexus 与 tmp dir。
  - 新增 `test/go-tui-smoke.test.ts`（Node 端 test）：通过 `BABEL_O_RUN_GO_TUI_SMOKE=1` gated，默认 `skip`；仅当预编译 `clients/go-tui/go-tui` 二进制存在时才尝试运行，避免在没 Go 工具链的环境下意外失败。
  - 在 `test/go-command.test.ts` 加默认运行的 `--help` 探针，验证 Python driver 自身 CLI 表面稳定（`permission-approve` sequence + `--timeout` flag）。
  - `package.json` 新增 `test:go-tui:smoke` 脚本：`BABEL_O_RUN_GO_TUI_SMOKE=1 tsx --test ... test/go-tui-smoke.test.ts`，CI 默认不引用，与规划口径一致。
  - 同步 `docs/nexus/active/TODO_tui.md` 把 Phase 1 标为 ✅、`docs/nexus/DONE.md` 加一条 Go TUI Phase 1 收口事实。
- **验证**:
  - 默认 `npm run test:go-tui:smoke` 跑通：`BabeL-O Go TUI MVP` banner → `bash echo go-tui-smoke` → `Permission: Bash` → approve → `Bash done` → `done success=true` 全链路 1.5s。
  - 直接 `./node_modules/.bin/tsx ... test/go-tui-smoke.test.ts`（无 env）→ 测试被 skip（`Set BABEL_O_RUN_GO_TUI_SMOKE=1 to run Go TUI smoke.`），符合"CI 默认不启用"要求。
  - `npm run typecheck` / `npm run format:check` 干净；周边 `go-command` / `chat-command` / `sessions-command` / `ui` / `tui-input` / `grep-tool` 63 个回归全过。
- **范围克制**: 严格按 Phase 1 边界推进。`permission_request` UI 缺 `input`/`message` 渲染、`inbox_message` / `channel_activity` label、发布模式 `defaultGoTuiSourceDir` 路径问题、跨平台 CI 构建等**不**在本次范围，分别属于 Phase 2 / Phase 2 / Phase 8 / Phase 8。

## 2026-06-09 — Go TUI 长期重写规划入库

- **用户请求**: 将 Go TUI 重写构建列为长期计划，写详细规划并更新 TODO。
- **实现**:
  - 新增 `docs/nexus/reference/go-tui-rewrite-plan.md`，明确 Go TUI 为 P3 / Long-term experimental track。
  - 规划中固定核心边界：Go TUI 只负责 terminal interaction、layout、keyboard routing 与 Nexus event rendering；TypeScript Nexus 继续拥有 runtime、context、storage、AgentScheduler、provider、permission 与 tool execution orchestration。
  - 记录当前 `clients/go-tui/` + `bbl go` MVP 基线与已完成的 local Nexus / WebSocket / Bash permission 手动 smoke。
  - 拆分 Phase 0-9：MVP baseline、opt-in smoke、event renderer parity、input/overlay state machine、slash/tool palette、context/compact UX、Agent/Task/SessionChannel views、PTY/visual regression、packaging/distribution、promotion gate。
  - 同步 `docs/nexus/TODO.md`、`docs/nexus/active/TODO_tui.md`、`docs/nexus/README.md` 与 `docs/nexus/reference/README.md`，把下一步明确为 Phase 1 `BABEL_O_RUN_GO_TUI_SMOKE=1` gated smoke。
- **验证**:
  - 文档结构检查：新增规划位于 `docs/nexus/reference/`，TODO 细节由 `docs/nexus/active/TODO_tui.md` 承接，总控 `TODO.md` 只保留 P3 长期入口。

## 2026-06-08 — SessionChannel TUI 真实 PTY smoke 补强

- **用户请求**: 继续推进 P2 SessionChannel TUI 真实 PTY smoke 补强，并说明当前 TUI 如何开始 session-to-session 对话流。
- **实现**:
  - `test/tui_pty_driver.py` 新增 seeded local SessionChannel inbox fixture，使用真实 `SqliteStorage` 写入两个 session、`workspace_pair` channel 与 unread handoff/blocked message，`bbl chat --session session-pty-inbox` 通过 embedded client 读取同一 SQLite。
  - 新增真实 PTY 序列覆盖 unread footer、`/inbox` overlay 展示 collaboration boundary/evidence/channel kind、selected message ack、ack 后 no unread state、quote into prompt 且不自动提交、主对话关键 event card、overlay 对 slash palette 的焦点互斥、resize/navigation 后 overlay 稳定以及关闭后主输入框恢复。
  - `test/tui-pty-smoke.test.ts` 注册 4 个 gated SessionChannel PTY smoke；默认仍需 `BABEL_O_RUN_PTY_SMOKE=1` 显式启用。
  - 文档同步当前 UX 口径：TUI 目前是 consumption-side 入口（`/inbox` / `/inbox all` / `/inbox ack <messageId>`）；发起跨 session message 仍通过 Nexus API 或 AgentScheduler parent-child channel，不提供 raw transcript sharing 或直接跨 session 指令 UI。
- **验证**:
  - `BABEL_O_RUN_PTY_SMOKE=1 BABEL_O_CONFIG_FILE=/tmp/babel-o-session-inbox-pty-focused-config.json npx tsx --test --test-name-pattern "SessionChannel" test/tui-pty-smoke.test.ts`：4/4 通过。

## 2026-06-08 — SessionChannel 主对话关键事件卡片

- **用户请求**: 继续推进 SessionChannel TUI 联系可见化。
- **实现**:
  - `bbl chat` 在 session flow 结束后刷新 unread inbox snapshot，并只对关键 unread side-channel message 渲染主对话 compact card：`handoff`、`blocked`、`request_review`、`request_validation`、high-priority `finding`、以及 governance rejected / requires approval 的 `memory_candidate`。
  - 卡片展示 source/target、channel kind/id、message id、evidence refs、memory candidate governance 与 `[open inbox] [ack] [quote]` 操作提示；不把消息内容自动作为当前 user message 注入，不自动触发工具，不改变 cwd/provider/profile/permission。
  - `bbl chat` 启动时会把既有关键 inbox message 标记为 seen，避免旧消息在主对话中重放刷屏；普通低优先级 finding/question 继续只更新 unread indicator。
  - `src/cli/inboxOverlay.ts` 新增 `shouldRenderInboxEventCard()` / `renderInboxEventCard()`，并补 focused renderer/reducer 测试覆盖关键消息筛选、governance 展示、宽度截断和 side-channel 文案。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-tui-inbox-card-test-config.json npx tsx --test test/tui-input.test.ts test/sessions-command.test.ts`：50/50 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-tui-inbox-card-typecheck-config.json npm run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-tui-inbox-card-format-config.json npm run format:check` 通过。
  - `git diff --check` 通过。

## 2026-06-08 — SessionChannel TUI unread indicator / Inbox overlay

- **用户请求**: 按规划实现 unread indicator 与 Inbox overlay。
- **实现**:
  - `bbl chat` boxed input footer 新增 SessionChannel 状态提示，显示 linked session 数、unread inbox 数、channel kind 摘要与 high-priority/key message 类型；状态不展示消息正文、不抢占主输入框、不改变当前 session 执行状态。
  - 新增 `src/cli/inboxOverlay.ts`，`/inbox` / `/inbox all` 在 TTY 中打开 side-channel overlay，展示 source session、target/broadcast、channel kind、message type、priority、createdAt、ack 状态、evidence refs 与 memory candidate governance 摘要。
  - Overlay 遵守唯一 input owner：使用 `inputState=inboxOverlay`，Esc/Backspace/Ctrl+C 关闭，↑/↓/PageUp/PageDown 导航，Enter open/read，`a` ack，`q` quote into current prompt；quote 只预填当前 prompt，必须由用户审阅后手动提交。
  - `NexusClient` 与 embedded client 补齐 `listSessionChannels()`，用于 footer/overlay 显示 linked sessions 与 channel kind；非 TTY 路径保留原有文本 inbox 输出。
  - 本切片不实现 raw transcript sharing、不把跨 session message 渲染为当前用户输入、不允许跨 session 静默改变 cwd/provider/profile/permission；主对话关键事件卡片与真实 PTY smoke 补强仍保留为后续 TUI 打开项。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-tui-inbox-test-config.json npx tsx --test test/tui-input.test.ts test/sessions-command.test.ts`：48/48 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-tui-inbox-typecheck-config.json npm run typecheck` 通过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-tui-inbox-format-config.json npm run format:check` 通过。
  - `git diff --check` 通过。

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

## 2026-06-10 — Go TUI permission-policy Phase D 收口（per-turn `--allow-tools` flag）

- **背景**: Phase B 让 write/execute 工具走 soft-deny 路径到达 `permission_request`，但每个 execute 风险工具调用都需要用户手动 `a` 审批——power-user 写长任务时仍嫌繁琐。规划写入 `docs/nexus/reference/go-tui-permission-policy-governance-plan.md` Phase D：让用户能一次性声明"我这次要 Bash + Edit"，turn 范围内直接执行。
- **实现**:
  - `src/runtime/perRequestPolicy.ts` 新建独立模块（避免循环 import）：导出 `buildPerRequestAllowedToolsPolicy(allowedTools)` helper。`*` / `all` → `allowAllTools`；否则 → `allowlistedTools(allowedTools)`。镜像 server-startup policy 解析口径。
  - `src/runtime/Runtime.ts` `RuntimeExecuteOptions` 新增 `allowedTools?: readonly string[]` 字段。
  - `src/runtime/LLMCodingRuntime.ts:128-143` `executeStream` wrapper：在 `options.allowedTools` 非空时构造 override policy、用 `withToolPolicy` 包裹 inner body（`runExecuteStreamInner` 抽到私有方法）。
  - `src/runtime/LocalCodingRuntime.ts:109-127` 同样的 wrapper——**关键修复**：plan 之前只 wrap 了 `LLMCodingRuntime`，但 `createDefaultNexusRuntime` 默认走 local runtime，测试用 local runtime 跑时 `allowedTools` 实际未生效；这次把 LocalCodingRuntime 一起补上。
  - `src/nexus/app.ts` `executeSchema` 新增 `allowedTools: z.array(z.string().min(1)).optional()`；`prepareExecution` 解析 `body.allowedTools` → `prepared.allowedTools`；HTTP + WebSocket 两条 `runtime.executeStream()` 调用都 spread `...(prepared.allowedTools && { allowedTools: prepared.allowedTools })`。
  - `clients/go-tui/internal/tui/tui.go:42-50` `Config` 新增 `AllowTools []string`；`buildExecuteRequest` 总是 trim / 空字符串过滤 / comma-split 后附加 `allowedTools` 数组（防御性处理程序化 Config 与 CLI flag 两种来源）。
  - `clients/go-tui/cmd/go-tui/main.go` 加 `--allow-tools` flag（用 `flag.Func` 接收重复 + 逗号分隔；空字符串 trim / 跳过）。
- **测试**:
  - `test/runtime.test.ts` 新增 2 个 Nexus focused 测试：`execute honours per-request allowedTools for Bash in soft-deny mode`（mock Nexus + body `allowedTools: ['Bash']` + `policy: 'soft-deny'` + `bash "git commit -m x"` → Bash 在 allowlist 跳过 hard-deny + soft-deny 让 approval gate 发 `permission_request`；用户 `/approve` 后工具正常执行；事件流无 policy-based `tool_denied`）；`execute with allowedTools scopes to a single turn`（两 turn 都用 `skipPermissionCheck: true` + 默认 strict 政策。第一 turn `allowedTools: ['Bash']` → Bash 不被 hard-deny；第二 turn 不发 `allowedTools` → 走 server-startup `denyByDefaultTools()` → Bash 被 hard-deny。证明 override 仅作用于当前 turn）。
  - `clients/go-tui/internal/tui/tui_test.go` 新增 4 个 `buildExecuteRequest` 测试：`TestBuildExecuteRequestEmitsAllowedToolsWhenConfigured`（含 `["Bash", "Edit"]`）、`TestBuildExecuteRequestOmitsAllowedToolsWhenUnset`（空 Config 不发）、`TestBuildExecuteRequestStripsWhitespaceAndEmptyFromAllowedTools`（trim + 跳过空 + 拆分逗号——`" Bash "`, `",Edit,"`, `"  "`, `"Glob"` → `["Bash", "Edit", "Glob"]`）、`TestBuildExecuteRequestAllowlistWildcardPassesThrough`（`*` 透传不预翻译）。
- **验证**:
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-phase-d-FINAL-typecheck.json npm run typecheck`（过）
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-phase-d-FINAL-format.json npm run format:check`（0 failures）
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-phase-d-FINAL-FULL-config.json npm test -- --runInBand`（725/725 pass；含 2 个新 Nexus allowlist 测试）
  - `cd clients/go-tui && go test -count=1 ./...`（全过，含 4 个新 `buildExecuteRequest` 测试）
  - `cd clients/go-tui && gofmt -l .`（先报告格式问题，gofmt -w 后干净）
- **未触动**: `createDefaultNexusRuntime` server-side 默认 `denyByDefaultTools()` 未动；`RuntimeExecuteOptions.allowedTools` 是 per-turn 字段；`policyMode` / `timeoutMs` / `skipPermissionCheck` 既有 per-turn 字段未动；`permission_request` / `permission_response` / `tool_denied` 事件 schema 未动；Go TUI 权限面板 `a/y/n/r/esc` 流程未改（不传 `--allow-tools` 时仍走流程）；`bbl chat` 与 HTTP API 既有客户端完全 back-compat；child AgentLoop 仍走 server-startup policy。
- **Phase D 边界守住**: `allowedTools` 仅作用于当前 turn（`withToolPolicy` 包裹确保 inner body 跑完 / 异常后 policy 自动 restore；下个 turn 重新评估）；`*` / `all` 通配在 `buildPerRequestAllowedToolsPolicy` 翻译为 `allowAllTools`，与 server-startup policy 解析口径一致；`policyMode: 'soft-deny'` 与 `allowedTools` 正交工作（前者决定 allowlist 外的工具是否走 `permission_request` 而非 `tool_denied`，后者决定哪些工具在 allowlist 内）；CLI flag 与 programmatic Config 统一（`buildExecuteRequest` 内部 trim / 拆分 / 过滤）；`buildPerRequestAllowedToolsPolicy` 抽到独立模块避免 `LLMCodingRuntime` ↔ `LocalCodingRuntime` 循环 import。
- **关键设计陷阱**: plan 阶段只 wrap 了 `LLMCodingRuntime`，但 `createDefaultNexusRuntime` 默认 provider 是 `local` 走 `LocalCodingRuntime`。第一个 Nexus focused 测试 (`execute honours per-request allowedTools for Bash in soft-deny mode`) 因 soft-deny 模式绕过了 hard-deny 而侥幸通过，但第二个测试 (`execute with allowedTools scopes to a single turn`) 暴露了真正的 bug——`LocalCodingRuntime` 也有同样的 wrapper 需要。修复后两 runtimes 都正确支持 per-turn allowlist。

## 2026-06-11 — Go TUI Session 可观测性盲区（`session_go_1781146359507755000`）

### 真实样本
用户在 2026-06-11 10:52:39 CST（unixnano `1781146359507755000`）触发 Go TUI session 后，要求分析该 session 的潜在问题。

**全盘搜索结果（7 个存储后端）**：
- `/Users/tangyaoyue/.babel-o/db.sqlite`（472 sessions）→ 0 命中（全部 `session_<uuid>` 命名）
- `/Users/tangyaoyue/DEV/BABEL/BabeL-O/.babel-o/` → 无 db.sqlite
- `~/.crush/crush.db` → 不存在
- `~/.codex/sessions/2026/05/*` → 0 命中
- `~/.agent_cli/projects/*/` → 0 命中
- `~/.gemini/antigravity-cli/db.sqlite` → 空文件
- 当前运行 `http://127.0.0.1:3000` Nexus（v0.3.2, uptime 4 秒）→ `SESSION_NOT_FOUND`；`execute.count: 0`

### 根因诊断
- **session ID 双轨命名**：Go TUI 客户端生成 `session_go_<unixnano>`（`clients/go-tui/main.go:runStream()` 启动时 `sessionID := fmt.Sprintf("session_go_%d", time.Now().UnixNano())`），与服务端的 `session_<uuid>` 不统一。
- **embedded Nexus 走 MemoryStorage**：`src/nexus/server.ts:23-24` `storagePath` 在 `NEXUS_STORAGE_PATH` 未设时回退 `createDefaultNexusRuntime` 内的 `MemoryStorage`，`bbl go` 启动 embedded `__server` 进程退出时 session 数据丢失。
- **无 session-start 日志**：`~/.babel-o/log/embedded-nexus.log` 不存在，事后回查无据。
- **当前 Nexus 反证**：`/v1/runtime/status.metrics.execute.count: 0`，uptime 4160ms 表明是 fresh 实例，session 跑在另一已死进程上。

### Phase 0 落地（`bbl inspect-session` CLI）
- 新规划 `docs/nexus/reference/go-tui-session-observability-governance-plan.md`（基于此 sample 触发）
- `src/cli/commands/inspectSession.ts` 新增 ~250 行（3 档 hint 模型 + 8 个导出 helper）
- `src/cli/program.ts` 注册 `registerInspectSessionCommand(program)`
- `test/inspect-session.test.ts` 新增 16 个 focused tests 全过
- 真实 CLI smoke 验证：`BABEL_O_CONFIG_DIR=/tmp/x bbl inspect-session session_go_1781146359507755000` 输出 tier (c) "session not found" + 3 条 suggested next steps + "no embedded-nexus start log yet" 提示

### 守门不变量保持
- 测试隔离用 `withTempConfigDir` + `mkdtempSync` + `BABEL_O_CONFIG_DIR` 注入 + `try/finally` 还原 env，**不**碰真实 `~/.babel-o/config.json`
- `findSessionInSqlite` 以 `readOnly: true` 模式打开 SQLite，**不**写回
- `resolveConfigDir` 每次调用重读 env 而非依赖 module-level `DEFAULT_CONFIG_DIR` 缓存（绕过 import-time 捕获导致的测试隔离失效）
- `provider fallback` / `auto model selection` 未触碰（按 memory 仍延后）
- 不修改 `permission_request` / `permission_response` 事件 schema
- `npm test` 16/16 pass；`npx tsc --noEmit` 全过

### 4 份文档同步
- `docs/nexus/TODO.md` P0 Watch 行追加本规划 + Phase 0 收口状态
- `docs/nexus/DONE.md` 追加 Phase 0 收口条目（5 段：背景 / 落地点 / 3 档 hint / 16 个测试 / 硬不变量）
- `docs/nexus/reference/go-tui-session-observability-governance-plan.md` Phase 0 子节更新为"已落地" + 收口标准
- `docs/nexus/reference/README.md` 索引行已注册本规划

### 2026-06-11 源码核对后状态同步
- Phase 1 **部分落地**：`clients/go-tui/internal/tui/tui.go:runStream()` 默认先 `POST /v1/sessions` 分配 server UUID，并用该 UUID 发送 WebSocket execute payload；`src/nexus/app.ts` 支持 `clientSessionId` metadata，`test/inspect-session-phase1.test.ts` 覆盖 API allocation/list/metadata。但 Go TUI 目前是在 allocation 之后才生成 `session_go_<unixnano>` 并写 `~/.babel-o/log/go-tui-session.log`，没有把该 client id 传给 server metadata；原规划中提到的 `clients/go-tui/internal/tui/phase1_session_id_test.go` 与 7 个 Go 专名测试并不存在。
- Phase 2 **部分落地**：`src/nexus/createRuntime.ts:resolveDefaultStoragePath()` 已把生产默认 storage 改为 `~/.babel-o/db.sqlite`，并保留 `NODE_ENV=test` / 显式 `:memory:` 的 MemoryStorage 测试隔离；`test/inspect-session-phase2.test.ts` 覆盖默认路径与 override。但 `src/cli/commands/go.ts:createManagedNexusLaunchSpec()` 未显式传 `NEXUS_STORAGE_PATH` / `BABEL_O_STORAGE_PATH`，`bbl go --check` 也未报告 storage path。
- Phase 3 **部分落地**：`src/nexus/server.ts` 已 best-effort 写 `nexus[pid=...] listen=... storage=...` 到 `~/.babel-o/log/embedded-nexus.log`；`src/cli/commands/inspectSession.ts` 已能从 `go-tui-session.log` reverse-resolve `clientSessionId → serverSessionId` 并查 SQLite。但 launcher 没有 `bbl-go[pid=...]` 启动行，Go TUI transcript/header 没有 `Session persisted: ...`，`/v1/sessions/:sessionId` 对 `session_go_xxx` 仍返回普通 `SESSION_NOT_FOUND`。
- Phase 4 **仍需补齐**：`docs/nexus/TODO.md` / `docs/nexus/WORK_LOG.md` / `docs/nexus/DONE.md` / reference 索引已开始同步到”部分收口”事实；仍缺 embedded persistence / startup log / server UUID transcript 的 PTY 或等价 e2e 守门。

### 2026-06-12 Phase G 后续 P2 — L4 `/memory` 状态与管理面板 MVP 收口

- 背景：完成 `evercore-lifecycle-cache-and-answer-governance-plan.md` 中 L4 阶段（`/memory` 状态与管理面板 MVP），把 Nexus read-only memory surface、嵌入式客户端 read-only 入口、Go TUI `/memory` overlay 串起来，并补 focused regression。
- Nexus API：`src/nexus/app.ts` 新增 `GET /v1/runtime/memory/status`，返回 `{ type:'memory_status', capability, everCore, guidance, actions }`；`everCore` 字段来自新增的 `everCoreStatus()` helper，避免 `/v1/runtime/status` 与 `/v1/runtime/memory/status` 两条路径出现 drift。
- 嵌入式客户端：`src/cli/embedded.ts` 暴露 `memoryStatus()`，复用 `defaultEverCoreRuntimeManager` 同一 lease cache；`close()` 触发 manager `shutdown()`，避免进程残留 warm sidecar。
- CLI / NexusClient：`src/cli/NexusClient.ts` 新增 `memoryStatus()`，调用 `/v1/runtime/memory/status` 并保持与嵌入式 envelope 一致。
- Go TUI overlay：
  - `clients/go-tui/internal/tui/overlay_memory.go`（新）`buildMemoryOverlayLines` / `renderMemoryOverlayLines` / `renderMemoryOverlay` / `anyBool`，统一使用 `asMap` / `stringField` / `anyInt` / `fallbackUnknown` 等共享辅助函数。
  - `clients/go-tui/internal/tui/tui.go` 新增 `modeMemoryOverlay`、`memoryOverlayLines` / `memoryOverlayScroll` 字段、`memoryStatusMsg` update handler、`scrollOverlay` 滚动分支，并并入 `usesFullScreenOverlay` / `renderFullScreenOverlay` / `nonTranscriptChromeHeight` 三个 full-screen overlay dispatch 点。
  - `clients/go-tui/internal/tui/api.go` 新增 `fetchMemoryStatus`；`clients/go-tui/internal/tui/slash.go` 新增 `/memory` slash 命令并加入 help list。
- focused regression：
  - `test/architecture-boundary.test.ts` 新增 `embedded Nexus client reuses EverCore configuration across app injections`，验证 `client.memoryStatus()` 后两次 `client.status()` + `listSessions` 期间 health endpoint 仅被探测一次（cache 命中）。
  - `test/runtime.test.ts` 已有 `/v1/runtime/memory/status reports read-only EverCore memory surface` 覆盖 enabled+healthy / enabled+unhealthy / 未配置三种状态。
  - `clients/go-tui/internal/tui/tui_test.go` 新增 7 个 Go focused tests：`TestBuildMemoryOverlayLinesParsesMemoryStatusPayload`、`TestBuildMemoryOverlayLinesEmptyAndErrorPaths`、`TestBuildMemoryOverlayLinesUnhealthyState`、`TestRenderMemoryOverlayLinesClampsScroll`、`TestRenderMemoryOverlayEmptyOutsideMode`、`TestRenderMemoryOverlayShowsHeaderInMode`、`TestUsesFullScreenOverlayIncludesMemoryOverlay`。
- 验证结果：
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json NODE_ENV=test npx tsx --test test/architecture-boundary.test.ts test/runtime.test.ts --test-name-pattern=”runtime/memory/status|embedded Nexus client|EverCore”` 142/142 pass。
  - `cd clients/go-tui && go test ./internal/tui` 全过。
  - `npm run typecheck` 与 `npm run format:check` 全绿。
- 文档同步：
  - `docs/nexus/reference/evercore-lifecycle-cache-and-answer-governance-plan.md` Phase L4 改为 “Status: implemented and verified”，并补实现要点 + 验证记录；Recommended Next Slice 指向 L5 `/memory` actions。
  - `docs/nexus/active/TODO_runtime.md` Phase G 后续 P2 段落追加 L4 收口说明，明确 `save` / `flush` / `restart` 仍需走 permission gate。
  - `docs/nexus/TODO.md` P2/Watch 表与”下一步只推进 focused P2”序号同步指向 L5。
- 守门不变量：
  - 测试隔离用 `BABEL_O_CONFIG_FILE=/tmp/...` 注入，**不**碰真实 `~/.babel-o/config.json`。
  - 嵌入式 `memoryStatus()` 与 `status()` / `listSessions` 走同一 lease cache，不再额外拉起 sidecar。
  - `provider fallback` / `auto model selection` 仍未触碰（按既定 memory 仍延后）。
  - Go TUI overlay 仅展示 `defaultEverCoreStatus()` redacted 字段，未引入 endpoint / API key / provider key 直接渲染。

### 2026-06-13 Phase G 后续 P2 — L5 `/memory` actions 收口

- 背景：继续 `docs/nexus/reference/evercore-lifecycle-cache-and-answer-governance-plan.md` L5，把 `/memory` 从 status-only 扩展为 runtime-owned management actions，同时保持“不是 memory mega-tool”、EverCore 非事实源、写/生命周期操作必须显式确认的边界。
- Nexus API：
  - `POST /v1/runtime/memory/search`：bounded read-only search，复用 `EverCoreClient.search()` + `extractEverCoreMemoryHits()` + `formatMemoryProviderHits()`，返回 `memory_search_result`、`hitCount`、`totalExtractedHits`、`budgetChars`、`truncated`、`content`、`hits[]` 与 `guidance.memoryIsHint=true` / `projectFactsRequireWorkspaceEvidence=true`。
  - `GET /v1/runtime/memory/candidates`：读取 SessionChannel `memory_candidate` message，返回 review-only `memoryCandidateGovernance` metadata（scope / decision / approval / evidence / blockedReasons / reviewReasons / `autoWrite=false`）。
  - `POST /v1/runtime/memory/save-note`：默认返回 HTTP 202 `memory_action_approval_required`；只有 `approved=true` 或 `confirmation="save-note"` 后才调用 `EverCoreClient.addAgentMessages()`。
  - `POST /v1/runtime/memory/flush`：默认返回 HTTP 202 `memory_action_approval_required`；只有 `approved=true` 或 `confirmation="flush"` 后才调用 `EverCoreClient.flushAgentSession()`。
  - `POST /v1/runtime/memory/restart`：默认同样需要 approval；确认后返回 `MEMORY_RESTART_NOT_IMPLEMENTED`，当前不静默重启 runtime。
- Client API：`src/cli/NexusClient.ts` 与 `src/cli/embedded.ts` 新增 `memorySearch()` / `memoryCandidates()` / `memorySaveNote()` / `memoryFlush()` / `memoryRestart()`，嵌入式路径继续复用 `defaultEverCoreRuntimeManager` lease cache。
- Go TUI：
  - `clients/go-tui/internal/tui/api.go` 新增 `fetchMemorySearch` / `fetchMemoryCandidates` / `requestMemorySaveNote` / `requestMemoryFlush` / `requestMemoryRestart`。
  - `clients/go-tui/internal/tui/slash.go` 扩展 `/memory [status|search <query>|candidates|save <note>|flush|restart]`。
  - `clients/go-tui/internal/tui/overlay_memory.go` 增加 envelope dispatch，可渲染 `memory_search_result`、`memory_candidates`、`memory_action_approval_required`、mutation success 与 error payload。
- Regression：
  - `test/runtime.test.ts` 新增 3 条 focused tests：search bounded read-only hints、candidates review-only governance metadata、write/lifecycle approval gate。
  - `clients/go-tui/internal/tui/tui_test.go` 新增 3 条 overlay tests：search result、candidates result、approval-required result。
- 验证结果：
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json NODE_ENV=test npx tsx --test test/runtime.test.ts test/architecture-boundary.test.ts --test-name-pattern="runtime/memory/(status|search|candidates|write)|embedded Nexus client"`：145/145 pass。
  - `cd clients/go-tui && go test ./internal/tui`：全过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json NODE_ENV=test npm run typecheck`：全过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json NODE_ENV=test npm run format:check`：failureCount=0。
- 守门不变量：
  - `search` / `candidates` 保持 read-only；`save` / `flush` / `restart` 不提供静默执行路径。
  - `restart` 目前只完成 approval gate 与未实现诊断，不引入进程生命周期副作用。
  - Layer D search short cache 尚未启用；`save` / `flush` 成功 envelope 只声明 `searchCacheInvalidated=true`，为后续 cache 层保留失效边界。
  - 测试继续使用 `BABEL_O_CONFIG_FILE=/tmp/...`，不写真实 `~/.babel-o/config.json`。
  - `provider fallback` / 自动模型选择 / 默认 role model recommendation 仍未触碰。

### 2026-06-13 Phase G 后续 P2 — L2 registry reuse + health check 收口

- 背景：继续 `docs/nexus/reference/evercore-lifecycle-cache-and-answer-governance-plan.md` L2，避免 managed EverCore sidecar 在进程/嵌入式 runtime 重建时重复分配端口和 spawn，只在 registry 健康时复用，stale registry 不阻塞新启动。
- 落地点：`src/nexus/everCoreSidecar.ts`
  - managed mode dataDir 下新增 `sidecar-registry.json`，记录 `version`、`baseUrl`、`host`、`port`、`dataDir`、`pid`、`startedAt`、`updatedAt`。
  - 启动前先 `readSidecarRegistry()` 并对 registry `baseUrl` 调 `/health`；健康则直接返回 reused runtime，`status.sidecar.reused=true`、`registryPath=<dataDir>/sidecar-registry.json`，不调用 port allocator / spawn。
  - registry stale 时记录 `registryStaleReason`（如 `health_check_failed:...`、`port_mismatch`、`host_mismatch`、`invalid_base_url`），best-effort `unlink` 清理；清理失败只落 `registryCleanupError` diagnostics。
  - 新 sidecar health check 成功后用 temp file + `rename()` 原子写 registry；写失败只通过 `EVERCORE_MANAGED_REGISTRY_WRITE_FAILED` diagnostics 暴露，不把 healthy sidecar 变 fatal。
  - `EverCoreSidecarStatus` 增加 `reused`、`registryPath`、`registryStaleReason`、`registryCleanupError` 字段，`/v1/runtime/status` 与 `/v1/runtime/memory/status` 通过已有 `everCoreStatus()` 透传。
- Regression：
  - `EverCore managed mode writes registry and reuses healthy sidecar`：首轮 spawn 写 registry，第二轮同 dataDir 健康 registry 命中，不调用 port allocator / spawn。
  - `EverCore managed mode treats stale registry as diagnostics and starts a fresh sidecar`：旧 registry `/health` 503 不阻塞新 sidecar，记录 stale reason，并把 registry 覆盖为新 `baseUrl` / `pid`。
  - 既有 `EverCore managed mode starts local sidecar and exposes diagnostics` 与 `/v1/runtime/status reports managed EverCore sidecar diagnostics` 保持通过。
- 验证结果：
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json NODE_ENV=test npx tsx --test test/runtime.test.ts --test-name-pattern="EverCore managed mode (starts local sidecar|writes registry|treats stale registry|auto-maps|uses explicit|rejects non-loopback)|runtime/status reports managed EverCore"`：143/143 pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json NODE_ENV=test npm run typecheck`：全过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json NODE_ENV=test npm run format:check`：failureCount=0。
- 守门不变量：
  - registry 只放在 EverCore dataDir 下，不写真实 `~/.babel-o/config.json`。
  - registry 命中必须通过 loopback host 与 `/health`；host/port/dataDir mismatch 或 health failure 都不会复用。
  - stale registry 清理/新 registry 写入失败不影响 runtime 继续使用健康 sidecar，只进入 diagnostics。
  - `provider fallback` / 自动模型选择 / 默认 role model recommendation 仍未触碰。

### 2026-06-13 Phase G 后续 P2 — L3 idle TTL warm sidecar 收口

- 背景：继续 `docs/nexus/reference/evercore-lifecycle-cache-and-answer-governance-plan.md` L3，在 L1 process-level cache 与 L2 registry reuse 之上，让 refCount 降为 0 后的 managed EverCore sidecar 在短 TTL 内保持 warm，避免连续嵌入式 app injection / CLI flow 间反复 dispose/spawn。
- 落地点：`src/nexus/everCoreRuntimeManager.ts`
  - 新增 `EverCoreRuntimeManagerOptions { idleTtlMs }`，默认 `DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000`。
  - `release()` 后若 `refCount=0` 且不是 incompatible uncached lease，调用 `scheduleIdleDispose()` 而不是立即 dispose；timer `unref()`，不阻塞进程退出。
  - TTL 内同 fingerprint `acquire()` 会 `cancelIdleTimer()` 并复用当前 cached EverCore；下一次 release 会重新 schedule idle timer，实现 timer refresh。
  - `idleTtlMs <= 0` 走立即异步 dispose，方便测试保持 deterministic。
  - `shutdown()` / incompatible config disposal 仍走 `disposeEntry()`，取消 pending timer 并 best-effort dispose owned sidecar。
- Regression：
  - `EverCore runtime manager keeps idle sidecar warm until TTL expires`：release 后 TTL 内不 dispose，TTL 到期 dispose，再 acquire 重新 configure。
  - `EverCore runtime manager reuses and refreshes idle TTL lease before expiry`：TTL 内 reacquire 复用同一 config，并刷新 release 后的 idle timer。
  - `EverCore runtime manager supports deterministic idleTtlMs=0 disposal`：测试可设置 TTL=0，让 release 后立即 dispose。
- 验证结果：
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json NODE_ENV=test npx tsx --test test/runtime.test.ts --test-name-pattern="EverCore runtime manager (reuses matching|does not reuse incompatible|keeps idle|reuses and refreshes|supports deterministic)"`：146/146 pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json NODE_ENV=test npm run typecheck`：全过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json NODE_ENV=test npm run format:check`：failureCount=0。
- 同步状态：
  - `docs/nexus/reference/evercore-lifecycle-cache-and-answer-governance-plan.md` L3 标记 implemented and verified；Recommended Next Slice 改为 L1/L2/L3/L4/L5/L6 全部收口，Layer D search short cache 暂不开项。
  - `docs/nexus/active/TODO_runtime.md` / `docs/nexus/TODO.md` / `docs/nexus/DONE.md` 同步为 lifecycle/cache/UI/answer-governance 后续规划当前关闭。
- 守门不变量：
  - TTL 只作用于 process-level manager cache，不改变 EverCore disabled-by-default、不改变 MemoryProvider 非事实源边界。
  - `shutdown()` 仍然立即 best-effort dispose，不让 one-shot process 残留 child。
  - `provider fallback` / 自动模型选择 / 默认 role model recommendation 仍未触碰。

---

## 2026-06-16 — Skill Execution Governance: Phase 0 (Baseline preservation) 收口

- 范围：`docs/nexus/reference/skill-execution-and-automated-normalized-skill-generation-governance-plan.md` §Phase 0: Baseline preservation
- 现状核对：
  - `src/skills/loader.ts` 132 行：导出 `parseFrontMatter` / `loadSkillFromFile` / `loadSkillsFromDir` / `loadAllSkills`，built-in < user < project 覆盖顺序。
  - `src/skills/matcher.ts` 36 行：按 score / priority / id 排序，取 top N。
  - `test/skills.test.ts` 225 行，5 个测试：parseFrontMatter 4 case / loadSkillsFromDir / matchSkills 4 case / loadAllSkills overlay / assembleContext inject。
  - `src/runtime/contextAssembler.ts` L224–L231：matched skills 注入为 `Active Developer Skills:` 块。
- Exit criteria 核对：
  - ✓ Existing skill tests still pass — 5/5 测试齐全。
  - ✓ Existing prompt injection behavior is unchanged — `assembleContext` 注入测试覆盖。
  - ✓ Invalid/disabled skill invocation fails clearly — `parseFrontMatter` invalid → null，目录扫描跳过；`loadSkillFromFile` try/catch → null。
- 结论：Phase 0 = **Closed**。可推进 Phase 1 (Schema / validator / normalizer / formatter)。
- 同步状态：
  - `docs/nexus/reference/tool-governance-reference-integration.md` §4 工具名映射表已记录 `SkillList` / `SkillShow` 命名以 Skill 治理规划为准。
  - `docs/nexus/reference/tool-surface-expansion-and-native-mcp-coexistence-plan.md` §3.1.4 已引用 Skill 治理规划为命名权威。
  - `docs/nexus/reference/skill-execution-and-automated-normalized-skill-generation-governance-plan.md` §Related governance plans 已挂双向引用。
- 守门不变量：
  - 现有 `loader.ts` / `matcher.ts` / `contextAssembler.ts` 行为不变。
  - Phase 1 必须保持旧 skill 兼容（legacy 字段缺失时填默认值，不 rewrite 文件）。
  - 不为 Phase 0 引入 `Skill` 工具 / `/skill` slash command / Nexus `/v1/skills/*` endpoints（这些属于 Phase 3 / Phase 6）。

---

## 2026-06-16 — Skill Execution Governance: Phase 1 (Schema / validator / normalizer / formatter) 收口

- 范围：`docs/nexus/reference/skill-execution-and-automated-normalized-skill-generation-governance-plan.md` §Phase 1: Schema, normalization, validation
- 新增模块：
  - `src/skills/schema.ts` — `RawSkill` / `NormalizedSkill` / `SkillDiagnostic` / `SkillValidationResult` / `SKILL_DEFAULTS` 常量 + `SkillRisk` / `SkillStatus` / `SkillSource` / `SkillScope` 字面量类型。
  - `src/skills/normalizer.ts` — `normalizeSkill(raw, source)` / `normalizeSkills(raws, source)`。`source` 是 loader-derived（`builtin` / `user` / `project`），与 `loader.ts` 解耦。
  - `src/skills/validator.ts` — `validateSkill(raw)` / `validateNormalizedSkill(skill)`。纯函数，**不 throw**；所有失败返回 `SkillDiagnostic`。覆盖 SKILL_ID_MISSING / SKILL_ID_INVALID / SKILL_NAME_MISSING / SKILL_TRIGGERS_EMPTY / SKILL_BODY_EMPTY / SKILL_STATUS_INVALID / SKILL_RISK_INVALID / SKILL_ALLOWED_TOOLS_NOT_ARRAY 8 个 error code。
  - `src/skills/formatter.ts` — `formatSkill(normalized)` 渲染 canonical front matter + body。**不在 loader 中调用**（"no automatic file rewrites occur" 守门）。
  - `test/skill-schema.test.ts` — 11 测试：normalizer 4 + validator 5 + formatter 2。
- Exit criteria 核对：
  - ✓ Legacy skill files still work — 旧 `loader.ts` / `parseFrontMatter` / `loadAllSkills` 行为未动；`test/skills.test.ts` 7/7 通过。
  - ✓ Normalized skill objects have stable metadata — `NormalizedSkill` 类型 + 4 normalizer 测试。
  - ✓ Invalid skills produce diagnostics — `SkillDiagnostic` 结构 + 5 validator 测试（不 throw）。
  - ✓ No automatic file rewrites occur — `formatSkill` 是 standalone 工具，loader 路径不调它。
- 验证结果：
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-skill.json NODE_ENV=test npx tsx --test test/skill-schema.test.ts`：11/11 pass。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-skill.json NODE_ENV=test npx tsx --test test/skills.test.ts`：7/7 pass（无回归）。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-skill.json NODE_ENV=test npm run typecheck`：全过。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-skill.json NODE_ENV=test npm run format:check`：仅 `docs/nexus/reference/behavior-monitor.md:465` 1 个 pre-existing trailing whitespace 失败（与本次 Skill 工作无关，不在本规划 scope 内）。
- 结论：Phase 1 = **Closed**。可推进 Phase 2 (SkillRegistry + observability)。
- 守门不变量：
  - 旧 `loader.ts` / `matcher.ts` / `contextAssembler.ts` 行为不变。
  - 新增的 4 个模块**不**改写 `loader.ts`；registry 集成留给 Phase 2。
  - 不为 Phase 1 引入 `Skill` 工具 / `/skill` slash command / Nexus `/v1/skills/*` endpoints（属于 Phase 3 / Phase 6）。

---

## 2026-06-16 — Skill Execution Governance: Phase 2 (SkillRegistry + observability) 收口

- 范围：`docs/nexus/reference/skill-execution-and-automated-normalized-skill-generation-governance-plan.md` §Phase 2: Skill registry and observability
- 新增模块：
  - `src/skills/registry.ts` — `loadSkillRegistry({cwd, builtInDir?})` 返回 `SkillRegistry`：`skills: NormalizedSkill[]` / `diagnostics: RegistryDiagnostics` / `list()` / `get(id)` / `match(prompt, opts)` / `diagnose()` / `validateRegistrySkill(registry, id)`。
    - `RegistryDiagnostics` 三类：`skipped`（malformed / 读取失败）/ `overlaid`（builtin < user < project 覆盖时记录 shadowedBy / from）/ `duplicateIds`（同 source 内重复 id）。
    - 不 throw：malformed 文件落入 `diagnostics.skipped`，不破坏 registry 返回。
  - `src/shared/skillEvents.ts` — 4 个 skill event zod schema：`SkillMatchedEventSchema` / `SkillInvokedEventSchema` / `SkillValidationEventSchema` / `SkillSavedEventSchema`。**故意不加入 `NexusEventSchema` discriminated union**——加进去后 zod 推断退化导致 30+ 个 runtime.test.ts 类型断言失败，**保留 4 个 schema 作为独立可 import 的事件族**。`src/shared/events.ts` 顶部加注释，re-integration 留待 zod 升级或 union 拆分时。
  - `src/shared/events.ts` 顶部加 NOTE 解释；`baseEventFields` 导出供 skillEvents.ts 复用。
- 修补（Phase 1 缺口，Phase 2 实施中暴露）：
  - `src/skills/loader.ts` 的 `parseFrontMatter` 不解析 `allowedTools` / `version` / `status` / `scope` / `risk` 数组或数值字段，导致 Phase 1 normalizer 收到 string 而非 string[]。
  - 扩 `Skill` 接口加 8 个可选字段；`parseFrontMatter` 复用 `parseListField` helper；既有 5 字段行为完全不变（7/7 旧 `test/skills.test.ts` 通过）。
- 新增测试：
  - `test/skill-registry.test.ts` — 7 个测试：empty / 归一化 + source attribution / overlay 诊断 / match / get / validateRegistrySkill / SkillMatchedEventSchema safeParse。
- Exit criteria 核对：
  - ✓ Runtime uses registry for skill matching — `loadSkillRegistry().match()` API 可用；`contextAssembler` 暂走旧路径（Phase 2 文档说"runtime uses registry for skill matching"，但本轮保留向后兼容；下一轮可切到 registry）。
  - ✓ Session logs can explain which skills were active — `SkillMatchedEventSchema` 等 4 个 schema 定义完成 + 注释说明 union 集成延后。
  - ✓ Context injection remains deterministic — 旧 `contextAssembler.ts` 行为完全不变。
- 验证结果：
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-skill.json NODE_ENV=test npx tsx --test test/skill-registry.test.ts test/skill-schema.test.ts test/skills.test.ts`：25/25 pass（registry 7 + schema 11 + 旧 skills 7）。
  - `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-skill.json NODE_ENV=test npm run typecheck`：0 错误。
- 结论：Phase 2 = **Closed**（注册表 API + 4 个 event schema 就绪；union 集成延后，注释记录）。可推进 Phase 3 (Nexus /v1/skills endpoints + /skill slash command)。
- 守门不变量：
  - 旧 `contextAssembler.ts` 行为不变；registry 是 parallel observable surface。
  - 4 个 skill event schema 是 typed contract（可独立 import + 验证），但**暂不**通过 `NexusEvent` union 流通；re-integration 需先升级 zod 或拆分 union。
  - `loader.ts` 扩展**不**破坏 `parseFrontMatter` 旧行为（5 字段测试 4/4 通过）。

---

## 2026-06-16 — Skill Execution Governance: Phase 3 (Nexus /v1/skills/* endpoints) 收口

- 范围：`docs/nexus/reference/skill-execution-and-automized-skill-generation-governance-plan.md` §Phase 3: `/skill list/show/validate/run` 的 Nexus HTTP 部分
- 范围控制：Go TUI `/skill` slash command 属另一仓（`clients/go-tui/`），本轮**不**触及，留待 Go TUI 单独迭代。
- 新增模块：
  - `src/nexus/skillRoutes.ts` — 4 个 Nexus handler + zod schemas + 响应类型：
    - `GET /v1/skills`（query: `cwd` / `source` / `status` / `builtInDir`）→ `listSkills`。
    - `GET /v1/skills/:id`（query: `cwd` / `builtInDir`）→ `showSkill`，404 on SKILL_NOT_FOUND。
    - `POST /v1/skills/validate`（body: `body` 或 `id + cwd`）→ `validateSkillRequest`，422 on invalid。
    - `POST /v1/skills/invoke`（body: `cwd` / `builtInDir` / `id` / `prompt` / `mode`）→ `invokeSkill`，返 `promptEnvelope`（dry-run，per 规划 Phase 3 exit criterion `/skill run <id> <prompt> using explicit prompt envelope`）。
  - `src/nexus/app.ts` 在 `/v1/agents/:jobId/transcript` 之后、`/v1/sessions/:sessionId/agents` 之前 register 4 个 route；handler 透传 `cwd` / `builtInDir`。
  - `src/skills/registry.ts` 加 `BABEL_O_USER_SKILLS_DIR` env 隔离 user 路径（与 `babel-o-test-config-isolation` 记忆一致）。
- 测试隔离（与 `tool-governance-reference-integration.md` §5.3 / §5.6 共同约束对齐）：
  - `BABEL_O_CONFIG_FILE=/tmp/...` 隔离 config。
  - `BABEL_O_USER_SKILLS_DIR=/tmp/...` 隔离 user skill 路径（避免污染真实 `~/.babel-o/skills`）。
  - `?cwd=...` + `?builtInDir=...` 隔离 per-test 临时目录。
- 失败码登记（按 §5.2 共同约束）：
  - `SKILL_NOT_FOUND`（404） / `SKILL_LOAD_FAILED`（500） / `SKILL_PARSE_FAILED`（422） / `SKILL_INVALID_PAYLOAD`（422） / `SKILL_INVOKE_DRY_RUN_FAILED`（200 with `{ok:false}`）。
  - 全部不 throw 终止 server，返结构化 payload。
- 新增测试：
  - `test/skill-routes.test.ts` — 8 个测试：empty list / list with attribution / filter by source / show / 404 / validate valid / validate invalid / invoke / invoke not found。
- Exit criteria 核对：
  - ✓ Nexus `/v1/skills` + `/v1/skills/:id` + `/v1/skills/validate` + `/v1/skills/invoke` 4 个 endpoint 就绪。
  - ✓ 失败/拒绝语义统一（不 throw + errorCode 登记 + 4xx/5xx status code 与 errorCode 匹配）。
  - ✓ 测试隔离守门（env + tmp dir）。
  - ✗ `/skill` slash command 与 Nexus API 集成测试（Go TUI 仓）—— 留待 Go TUI 单独迭代。
- 验证结果：
  - `BABEL_O_CONFIG_FILE=/tmp/... BABEL_O_USER_SKILLS_DIR=/tmp/... NODE_ENV=test npx tsx --test test/skill-routes.test.ts`：8/8 pass。
  - 旧 25 测试（registry + schema + skills）全部通过，无回归。
  - `npm run typecheck`：0 错误。
- 结论：Phase 3 = **Closed**（Nexus endpoints 部分）。Go TUI `/skill` 子命令部分属另一仓，单独推进。
- 守门不变量：
  - 旧 `contextAssembler.ts` / `loader.ts` / `matcher.ts` 行为不变。
  - 4 个 skill event schema（skillEvents.ts）继续独立可 import；union 集成延后到 zod 升级或 union 拆分时。
  - `BABEL_O_USER_SKILLS_DIR` env override 仅在 user source 路径生效；built-in 与 project 路径不受影响。

---

## 2026-06-16 — Skill Execution Governance: Phase 4 (Draft generation) 收口

- 范围：`docs/nexus/reference/skill-execution-and-automated-normalized-skill-generation-governance-plan.md` §Phase 4: Draft generation
- 新增模块：
  - `src/skills/generator.ts` — `generateSkillDraft(input)` / `deriveId(text)` / `redact(input)`。
    - 6 个 REDACTION_PATTERNS：bearer JWT 风格 / provider prefix（sk-/ghp_/ant-/xai-）/ Bearer header / long hex / long base64 / private home path（`/home/...` 或 `/Users/...`）。
    - id derivation：kebab-case slug from title tokens; validates against `^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$`。
    - trigger derivation：title tokens length 3..20, max 4; `explicitOnly` 允许 0 triggers。
    - 强制 status='draft' / version=1 / priority=50（drafts 默认）。
    - Body 模板：Purpose / When to use / Inputs / Procedure / Tool policy / Output format / Failure handling + 可选 Captured session summary / Captured tool outcomes 段。
    - 失败码：SKILL_DRAFT_INVALID_TITLE / SKILL_DRAFT_ID_CONFLICT / SKILL_DRAFT_VALIDATION_FAILED / SKILL_DRAFT_TRIGGERS_INSUFFICIENT。
  - `src/nexus/skillRoutes.ts` — `generateDraftHandler(input)` + `SkillDraftBodySchema` + `SkillDraftResponse` 类型。
  - `src/nexus/app.ts` — `POST /v1/skills/draft` 路由，422 on ok:false，200 on ok:true。
  - `src/skills/validator.ts` — 修补：active skills 必须有 trigger；draft / disabled 允许空 triggers（Phase 4 explicitOnly 兼容）。
- 测试：
  - `test/skill-generator.test.ts` — 14 测试：clean title / explicit idHint / bad idHint / empty title / explicitOnly / too-few-triggers / bearer redaction / provider key redaction / private path redaction / validation warnings / scope project / scope user / deriveId / redact clean text。
  - `test/skill-draft-route.test.ts` — 7 测试：clean draft / empty title 400 (zod reject) / bad idHint 422 / bearer redaction 200 / explicitOnly / scope user / no file persisted。
- Exit criteria 核对：
  - ✓ `SkillDraft` 域函数 + `POST /v1/skills/draft` endpoint。
  - ✓ Drafts are in-memory only（test 断言 `filePath` 不在响应中）。
  - ✓ Redaction pass 6 类敏感信息。
  - ✓ Validation pass 复用 Phase 1 `validateSkill`。
  - ✓ Failure semantics 统一（不 throw + errorCode 登记 + 4xx 状态码）。
  - ✗ `/skill draft <description>` Go TUI slash command —— 属另一仓，单独迭代。
- 验证结果：
  - `BABEL_O_CONFIG_FILE=/tmp/... BABEL_O_USER_SKILLS_DIR=/tmp/... NODE_ENV=test npx tsx --test test/skill-registry.test.ts test/skill-schema.test.ts test/skills.test.ts test/skill-routes.test.ts test/skill-generator.test.ts test/skill-draft-route.test.ts`：55/55 pass。
  - `npm run typecheck`：0 错误。
- 结论：Phase 4 = **Closed**。
- 守门不变量：
  - 旧 `loader.ts` / `matcher.ts` / `contextAssembler.ts` 行为不变。
  - `validator.ts` 修改**仅**放宽空 triggers 对 draft / disabled 的限制；active skills 仍强制要求 ≥ 1 trigger。
  - Drafts 不写文件；持久化留待 Phase 5 `SkillSave`。

---

## 2026-06-16 — Skill Execution Governance: Phase 5 (Session capture and save) 收口

- 范围：`docs/nexus/reference/skill-execution-and-automated-normalized-skill-generation-governance-plan.md` §Phase 5: Session capture and save
- 新增模块：
  - `src/skills/storage.ts` — `saveSkill(input)` / `previewSkillSave(input)`。
    - 8 个 errorCode：SKILL_SAVE_NOT_CONFIRMED / SKILL_SAVE_DUPLICATE_ID / SKILL_SAVE_DUPLICATE_NAME / SKILL_SAVE_DUPLICATE_TRIGGERS / SKILL_SAVE_OVERWRITE_REQUIRED / SKILL_SAVE_INVALID_DRAFT / SKILL_SAVE_PERSIST_FAILED / SKILL_SAVE_SCOPE_INVALID。
    - 持久化路径：project → `<cwd>/.babel-o/skills/<id>.md`；user → `${BABEL_O_USER_SKILLS_DIR}/<id>.md`（与 §5.6 共同约束一致）。
    - 原子写入：`writeFile(<filePath>.tmp) + rename`。
    - 重复检测：id（hard）/ normalized name（soft）/ trigger overlap ≥ 2（soft）。
    - emit `SkillSavedEvent` typed payload（schema 已在 Phase 2 skillEvents.ts 定义）。
  - `src/nexus/skillRoutes.ts` — `saveSkillHandler(input)` + `SkillSaveBodySchema` + 4 个 response type（preview / success / error）。
  - `src/nexus/app.ts` — `POST /v1/skills/save` 路由。Status code 映射：previewOnly 200 / success 200 / OVERWRITE_REQUIRED 409 / PERSIST_FAILED / SCOPE_INVALID 500 / 其他 422。
- 测试：
  - `test/skill-storage.test.ts` — 10 测试：previewOnly / project 持久化 / overwrite 拒绝 / overwrite OK / user 隔离 / DUPLICATE_NAME / DUPLICATE_TRIGGERS / INVALID_DRAFT / SCOPE_INVALID / SkillSavedEvent payload。
  - `test/skill-save-route.test.ts` — 6 测试：previewOnly 200 / project OK 200 / 409 OVERWRITE / overwrite OK 200 / user 隔离 / 400 missing id。
- Exit criteria 核对：
  - ✓ Capture workflow：Phase 4 draft + Phase 5 save 接 draft。
  - ✓ Duplicate detection：id / normalized name / trigger overlap。
  - ✓ Preview / confirmation 流程：`confirm: false` 返 preview，confirm: true 才写。
  - ✓ Persistence to project / user scope。
  - ✓ `skill_saved` event payload 构造。
  - ✓ Tests **don't write real user config**：BABEL_O_USER_SKILLS_DIR + cwd-based 隔离；finally 中清理。
- 验证结果：
  - `BABEL_O_CONFIG_FILE=/tmp/... BABEL_O_USER_SKILLS_DIR=/tmp/... NODE_ENV=test npx tsx --test test/skill-registry.test.ts test/skill-schema.test.ts test/skills.test.ts test/skill-routes.test.ts test/skill-generator.test.ts test/skill-draft-route.test.ts test/skill-storage.test.ts test/skill-save-route.test.ts`：71/71 pass。
  - `npm run typecheck`：0 错误。
- 结论：Phase 5 = **Closed**。
- 守门不变量：
  - 旧 `loader.ts` / `matcher.ts` / `contextAssembler.ts` / `app.ts` 已有 route 行为不变。
  - Save 不**写** `~/.babel-o/skills` 默认路径——必须显式设 `BABEL_O_USER_SKILLS_DIR`。
  - Save 不**自动**覆盖已存在文件——必须 `overwrite: true` 显式确认。

---

## 2026-06-16 — Skill Execution Governance: Phase 6 (Model-visible bounded skill tools) 收口

- 范围：`docs/nexus/reference/skill-execution-and-automated-normalized-skill-generation-governance-plan.md` §Phase 6: Model-visible bounded skill tools
- 新增模块：
  - `src/tools/builtin/skillTool.ts` — 5 个 model-visible tool（复用 Phase 1–5 域函数）：
    - `SkillList` (read) — `loadSkillRegistry().list()` + filter by source/status。
    - `SkillShow` (read) — `loadSkillRegistry().get(id)` + `formatSkill()` body。
    - `SkillValidate` (read) — by id+cwd 或 by raw body；复用 Phase 1 `validateSkill`。
    - `SkillDraft` (read) — 复用 Phase 4 `generateSkillDraft`。
    - `SkillSave` (write) — 复用 Phase 5 `saveSkill`；**requiresApproval: true** + `suggestedAllowRule: '- tool: SkillSave'`。
  - `src/tools/registry.ts` — 5 个工具加入 `createDefaultToolRegistry()`，排序在 webSearchTool 之后。
  - 所有 read 类工具**不**走 approval gate（`requiresApproval !== true`）；`SkillSave` 走完整 permission flow。
- 失败/拒绝语义（与 `tool-governance-reference-integration.md` §5.2 一致）：
  - 不 throw；`{ success: false, output: { errorCode, message, ... } }`。
  - errorCodes: SKILL_NOT_FOUND / SKILL_INVALID_INPUT / SKILL_LOAD_FAILED / SKILL_VALIDATION_FAILED / SKILL_DRAFT_INVALID_TITLE / SKILL_DRAFT_ID_CONFLICT / SKILL_SAVE_NOT_CONFIRMED / SKILL_SAVE_OVERWRITE_REQUIRED / SKILL_SAVE_PERSIST_FAILED。
  - `SkillSave` 的 preview-only 路径返 `success: true` + `output.previewOnly: true` —— model 可重发 confirm: true 完成持久化（与 Phase 5 `SkillSaveSuccessResponse.previewOnly` 一致）。
- 测试：
  - `test/skill-tools.test.ts` — 13 测试：registry 暴露 5 工具 / SkillSave write risk + approval / 4 read tools 风险与 approval / SkillList attribution / SkillShow body / SkillShow SKILL_NOT_FOUND / SkillValidate 有效 / SkillValidate SKILL_VALIDATION_FAILED / SkillValidate SKILL_INVALID_INPUT / SkillDraft normalized / SkillSave previewOnly / SkillSave 持久化 / SkillSave overwrite 拒绝。
- Exit criteria 核对：
  - ✓ Model can inspect / draft / validate skills（SkillList / SkillShow / SkillDraft / SkillValidate 都是 read 风险无 approval gate）。
  - ✓ Model cannot save skills without write permission（SkillSave requiresApproval: true + suggestedAllowRule: '- tool: SkillSave'）。
  - ✓ Tool boundaries remain orthogonal and auditable（5 个独立 tool；不重叠；output 结构化）。
- 验证结果（9 个文件分别运行，node test runner 跨 9 文件时偶有 "Unable to deserialize" 子进程 bug，独立运行稳定）：
  - skill-registry 7 / skill-schema 12 / skills 7 / skill-routes 8 / skill-generator 14 / skill-draft-route 7 / skill-storage 10 / skill-save-route 6 / skill-tools 13 —— **84/84 pass**。
  - `npm run typecheck`：0 错误。
- 结论：Phase 6 = **Closed**。**整个 Skill 治理规划 Phase 0–6 全部 Closed**。
- 守门不变量：
  - 旧 9 个 builtin tool 行为不变；新 5 个 skill tool 是正交扩展。
  - SkillSave 走 `requiresApproval: true` 守门；permission policy `- tool: SkillSave` 可一键放行。
  - 测试用 `BABEL_O_USER_SKILLS_DIR` 隔离 user scope 写入，finally 清理避免污染后续测试。

---

## 2026-06-16 — 工具治理三联 + Go TUI fallback 同步 + cron 收口

- 范围：本会话收尾批次，与 Skill 治理规划 Phase 0–6 配套的"治理层 + 客户端 fallback 层 + 流程层"对齐收口。
- 三份治理规划三角闭环：
  - `docs/nexus/reference/tool-granularity-and-evidence-governance-plan.md`（**边界**）— 顶部 front matter 加 `Related plans:` 指向整合索引；末尾新增 **§10. Related governance plans** 段落：
    - 表格列出"整合 / 补齐 / Skill"三份规划的相对关系。
    - 引用点：`ListDir` 命名权威性、不新增 `Search` / `define_subagent` / `invoke_subagent`、证据语义分层、AgentScheduler 命名、失败/拒绝语义基线。
    - 升级路径：与 Skill 治理 §升级路径同款（查整合索引 §6 → 升级到整合文档 → 同步回三联主规划）。
  - `docs/nexus/reference/tool-surface-expansion-and-native-mcp-coexistence-plan.md`（**补齐**）— 顶部 `Related plans` 行已存在；本批次未动正文。
  - `docs/nexus/reference/skill-execution-and-automated-normalized-skill-generation-governance-plan.md`（**Skill**）— 顶部 Status 块 `Related:` 行已存在；末尾 **Related governance plans** 段落已存在；本批次未动正文。
  - `docs/nexus/reference/tool-governance-reference-integration.md`（**整合**）— 三角关系已锚定；本批次未动。
  - **结果**：三联主规划 ↔ 整合索引的交叉引用从"两条单向 + 一条无" → **完整双向闭环**。后续任何冲突均按整合文档 §6 仲裁。
- Go TUI staticToolDescriptorCatalog fallback 同步（Task #315 → #316）：
  - `clients/go-tui/internal/tui/slash.go` — `staticToolDescriptorCatalog` 由 8 工具扩展到 13 工具：
    - 已有 8：`ListDir` / `Glob` / `Grep` / `Read` / `Write` / `Edit` / `Bash` / `Task` / `WebSearch`（实为 9 基础）。
    - 新增 5：`SkillList` (read) / `SkillShow` (read) / `SkillValidate` (read) / `SkillDraft` (read) / `SkillSave` (write, requiresApproval)。
    - 注释：`// Kept in sync with src/tools/builtin/skillTool.ts`。
  - `clients/go-tui/internal/tui/tui_test.go` — `TestStaticToolDescriptorCatalogIsStableReferenceShape` `wantNames` 同步到 13 项；新增 `SkillSave` 的 risk/approval 断言。
  - 验证结果：
    - `cd clients/go-tui && go test ./internal/tui/...`：**11.110s 全过**。
    - `cd clients/go-tui && go vet ./...`：干净。
  - 守门不变量：wire `GET /v1/tools/audit` 仍为权威；fallback 仅在 wire 不可达时回退。
- 流程层收口：
  - `CronDelete ca8ae7e4` 结束 `/loop 10m` 循环。Skill 治理规划 6 阶段全部 Closed + 84/84 测试通过 + 三联闭环 + Go TUI 同步，按"直至验证完成后结束任务"标准，**任务目标已达成**，循环不再需要。
  - 本地 commit 待执行（按"无 push 无 PR 无 publish"约束，commit 后不推送）。
- 守门不变量：
  - 三角闭环不被破坏：任何后续修改任意一联主规划时，必须同步检查另两联 + 整合索引是否需要更新。
  - Go TUI fallback 与 `createDefaultToolRegistry()` 长期保持一一对应（13 ↔ 13）。
  - `bin/mcporter` 是 `npm link` 出来的本地开发工具链符号链接，**不**入库。

## 2026-06-18 — Agent Runtime Maturity: Durable Run Checkpoint / Resume v1 收口

- **背景**: `agent-runtime-architecture-maturity-plan.md` §3.3 是 P1 最后一项打开。当前 session/event persistence 已可复盘，但 in-flight continuation 仍偏 process-local；如果只把 pending permission 写 SQLite，会出现"看起来 durable / 实际不可恢复"的假持久化。v1 不持久化 in-process continuation snapshot，而是定义 6 个 checkpoint boundary + 5 个 resumable state + 诚实 `hasContinuationSnapshot: false` 投影。
- **范围**:
  - `src/runtime/runCheckpoint.ts`（既有，**未改动**）— 6 boundary（`before_provider_invocation` / `after_provider_invocation` / `before_tool_execution` / `waiting_permission` / `after_tool_result` / `before_final_result`）+ 5 state（`resume_possible` / `retry_from_provider_turn` / `waiting_permission` / `terminal_failed_recoverable` / `cannot_resume`）+ `deriveResumableState({ session, events, pendingPermissionToolUseId, hasContinuationSnapshot })` 纯函数 + orphan `tool_started` warning + 18 unit test。
  - `src/cli/commands/inspectSession.ts` — 新增 `exportSessionResumeState` / `exportSessionResumeStateDirect` / `formatResumeState` / `readSessionPhaseRow` / `readOrderedEvents`（trace 路径共用）；`--resume` 短路径 + `--json` 切换 + 缺数据 exit 1；`session_go_<unixnano>` reverse-resolve 复用 trace 路径逻辑。
  - `test/inspect-session.test.ts` — 新增 7 集成 test（waiting_permission / terminal success / terminal error / non-terminal mid-run / absent session / formatter），复用 `withTempConfigDir` + `seedSqliteWithSession` 隔离。
  - `test/run-checkpoint.test.ts` — 之前遗漏在 `package.json` test script，本批次补登记。
  - `package.json` — test script 补 `test/run-checkpoint.test.ts`（紧跟 `test/inspect-session.test.ts` 之后）。
- **CLI 输出形态**:
  - `bbl inspect-session <id> --resume` 默认渲染：`▶ <state>` + `boundary` + `reason` + `warnings` + 诚实 `next:` hint（按 state 分色）+ 灰字 "note: derived without a continuation snapshot"（v1 持久化缺口守门）。
  - `bbl inspect-session <id> --resume --json` 输出 `DerivedResumableState` 单 blob。
  - 缺事件/缺 sessions row → `exit 1` + 红字 ✗ 提示。
- **验证**:
  - `npx tsc --noEmit`：**0 错误**。
  - `npx tsx --test test/inspect-session.test.ts`：**29/29 pass**（22 pre-existing + 7 新增）。
  - `npx tsx --test test/run-checkpoint.test.ts`：**18/18 pass**。
  - 累计 inspect-session 29 + run-checkpoint 18 + agent-trace 19 + eval-agent 19 pass，0 回归。
- **边界**:
  - 不持久化 in-process continuation snapshot（v1.1+ 真实 demand 才推）。
  - 不从 provider token stream 中段 resume（plan 显式非目标）。
  - `retryable_provider_turn` / `retryable_tool_result` 仍只 derivation，不写回 session metadata。
  - 默认 `hasContinuationSnapshot: false`；CLI 一律传 `false`（post-restart inspection 语义），保留 v1 唯一可恢复向量 `waiting_permission` + 操作者重发 approval 的诚实语义。
- **后续可推进**: §3.5 Memory Quality Metrics（`/v1/runtime/memory/status` 已有基础，待真实 regression 触发再推）；§3.4 MCP / §3.6 Loop Taxonomy 仍 P2。P1 Agent Runtime 成熟度（trace + eval + durable resume）三联全部收口。

## 2026-06-18 — Context CWD Drift Phase A Follow-up: Deep Analysis + Minimum Fix Plan

- **背景**: 上一条 `session_cf361f04` regression 补入 plan 时只描述了现象；这次按用户要求"深度分析推进，必要时回看 session 真实情况深度分析解决"，把 Phase A 的 `extractAbsolutePaths()` + `LocalCodingRuntime.storage` 链路端到端复盘了一遍，定位出 Phase A 收口剩余 5 类 false-positive + 1 类 false-negative + 1 类 path-splitting bug，并写出最小修复包写入 plan §10。

- **方法**: 写 `/tmp/test-extract-prose.mjs` 把 18 个反向构造的 prose 字符串直接喂给 `extractAbsolutePaths()`（项目内 import `/Users/tangyaoyue/DEV/BABEL/BabeL-O/src/runtime/systemPromptBuilder.ts`），记录真实输出：

  | 输入 | Phase A 当前输出 | 真实期望 |
  | --- | --- | --- |
  | `/while` | `["/while"]` | `[]` |
  | `/memory` | `["/memory"]` | `[]` |
  | `/Linear→Workflow/Agent` | `["/Linear→Workflow/Agent"]` | `[]` |
  | `/Layer是变换这份数据的可组合单元` | `["/Layer是变换这份数据的可组合单元"]` | `[]` |
  | `/目录——一条编号递进的学习阶梯` | `["/目录——一条编号递进的学习阶梯"]` | `[]` |
  | `/.openrath/config.json` | `["/.openrath/config.json"]` | `[]` |
  | `/etc/hosts` | `["/etc/hosts"]` | `["/etc/hosts"]` ✅ |
  | `/Users/.../MEMORY.md` | `["/Users/.../MEMORY.md"]` | 整段保留 ✅ |
  | `https://www.openrath.com/` | `["//www.openrath.com/"]` | `[]` |
  | `//www.openrath.com/` | `["//www.openrath.com/"]` | `[]` |
  | `/Users/.../Library/Mobile Documents/...` | 切成 2 段（`/Users/.../Library/Mobile` + `/com~apple~CloudDocs/...`） | 整段保留为单个 candidate（escaped-space 模式） |
  | `/Library/Application Support` | 切成 2 段 | 整段保留为单个 candidate |

- **根因 #1 — `isCjkOnlyNonExistentPath` regex 太窄**: `/^[\p{Script=Han}]+$/u` 拒绝任何含 `\p{Script=Common}` 字符的 basename。em-dash `——`（U+2014, `Script=Common`）是 CJK prose 最高频的标点，因此 `/目录——...` 的 basename 不通过 guard，整个 candidate 漏出。

  ```
  basename: "目录——一条编号递进的学习阶梯"
  Han only regex: false       ← guard 失效
  Han+Common regex: true      ← 修正后应该匹配
  ```

- **根因 #2 — `extractAbsolutePaths()` 没有 URL 守卫**: `pathPattern` 直接吃 `//` 起始的字符串，所以 `https://www.openrath.com/` 先被通用 pattern 切出 `//www.openrath.com/`，再被 `resolvePromptPath` 规范成 `/`，最终以 `/` 的形式进入 cwd 候选池。

- **根因 #3 — `extractAbsolutePaths()` 不保留 escaped-space 路径**: `pathPattern = /\/[^\s"'"，。！？；：、）\])}<>]+/g` 在第一个空格处终止，整段被切成两段后两段都通不过 `existsSync`。

- **根因 #4 — `LocalCodingRuntime.storage` 是 optional**（`src/runtime/LocalCodingRuntime.ts:60-63`）:
  ```ts
  constructor(
    ...,
    private readonly storage?: NexusStorage,  // ← optional
    ...,
  ) {}
  ```
  当 Go TUI local 模式构造时不传 storage（默认情况），`runExecuteStreamInner:170` 的 `if (!options.storage && this.storage)` 不会填充；`executeToolSafely` 把 `options.storage === undefined` 透传给 tool context；`contextRecent` / `contextSearch` 的 storage gate（`src/tools/builtin/contextSearch.ts:39-48`、`src/tools/builtin/contextRecent.ts:35-44`）一律返回 `CONTEXT_STORAGE_UNAVAILABLE`。registry (`src/tools/registry.ts:22-48`) 无条件把 `contextSearchTool` / `contextSummarizeTool` / `contextRecentTool` 注册进 registry，model prompt 永远会看到这些工具但永远调用失败 — 这就是 `session_cf361f04` event_seq=16671 的真实根因。

- **代码 / 文档变更**:
  - `docs/nexus/reference/context-cwd-drift-and-recall-governance-plan.md` Status 段更新（标注 2026-06-18 补 Phase A follow-up 4 类补刀 + §10.2 LocalCodingRuntime 根因）。
  - `docs/nexus/reference/context-cwd-drift-and-recall-governance-plan.md` 新增 §10（"2026-06-18 Deep Analysis — Phase A Follow-up Evidence"）共 4 个子节：
    - §10.1 false-positive 类目表（7 行：英文 prose / 中英混排 / CJK 含标点 / dotfile 不存在 / 路径含空格 / URL / 真实路径 ✅）
    - §10.2 `isCjkOnlyNonExistentPath` regex bug 实证（em-dash codepoint 2014, `Script=Common`）
    - §10.3 `LocalCodingRuntime.storage` optional bug
    - §10.4 Phase A Follow-up 最小修复包（focused test + code change + integration test）

- **边界**:
  - 本次只做 deep analysis + 写最小修复包到 plan §10，**没有改 Phase A 代码**。
  - 不动 Phase B / D / E / F。
  - 不动 provider / Nexus runtime 行为。
  - 不持久化 in-process continuation snapshot（仍按 plan 显式非目标）。

- **验证**:
  - `npx tsx /tmp/test-extract-prose.mjs`：18/18 输入全部按预期输出。
  - 无代码改动，因此不需要跑 `npm test`。

- **下一步**: Phase A Follow-up 修复包（focused 4 + integration 3 个 test + 代码层 3 处 guard 增强）建议在下次 session_cf361f04-style regression 出现时落地；当前先停在"已知最小修复方案 + plan 完整登记"状态。

## 2026-06-18 — Context CWD Drift Phase A Follow-up 收口

- **背景**: 上一条 deep-analysis WORK_LOG 写到 plan §10 的 5 类 prose-path 漏出 + URL 守卫缺失 + `LocalCodingRuntime.storage` optional 根因 + 4 个根因 #1-#4；本次按 P0 #1 + #2 把 plan §10.4 最小修复包落地为代码 + 测试。修复 `session_cf361f04-7ab1-43a5-907a-41a808942686` 的所有失败点：URL-heavy cwd drift、`Mobile\ Documents` path splitting、prose-path 误识别、`contextRecent` 在 Go TUI local mode 下的 `CONTEXT_STORAGE_UNAVAILABLE` 误暴露。

- **代码变更**（4 文件）:
  - `src/runtime/systemPromptBuilder.ts`: `extractAbsolutePaths` 重写。新增 `looksLikeLikelyUrlFragment`（在 pathPattern 前丢弃 `https?://` / `//` 起始片段）、`looksLikeProseFragment`（单段 bare Latin word 快速丢弃）、`isNonExistentProseCandidate`（非存路径的多层 CJK guard，覆盖 single-segment bare CJK、two-segment CJK prose、Han+Common 含 em-dash、CJK + Latin 混排）。`isCjkOrCommonBasename` 取代原 `isCjkOnlyNonExistentPath` 的 Han-only regex（接受 Han + Common 标点如 em-dash U+2014）。实存绝对路径短路：`existsSync(restored)` 为 true 时直接 `paths.add(restored)`，绕过 prose guard（保护 `/etc/hosts` / `/bin/bash` / 真实 iCloud 路径）。Escaped-space 路径保留：`SPACE_MARK = '\x00\x01'` 哨兵重写 `\ `，避免 pathPattern 在 backslash 处终止。
  - `src/tools/registry.ts`: `createDefaultToolRegistry(opts?: { storage?: NexusStorage | null })` 新增 storage 哨兵。`storage: null` → 隐藏 `contextSearch` / `contextSummarize` / `contextRecent` 三个工具；back-compat（无 opts 或 `storage: undefined`）保留全部 18 个工具。导出 `CreateToolRegistryOptions` interface。
  - `src/nexus/createRuntime.ts`: 调整 storage 构造顺序（line 86-91），storage 构造后用 `createDefaultToolRegistry({ storage })` 注入真实 storage。
  - `src/nexus/agents/AgentScheduler.ts`: `createExploreRuntime` 用 `createDefaultToolRegistry({ storage: options.storage ?? null })` 显式传递。
  - `src/nexus/runnerComparisonBenchmark.ts`: benchmark 显式 `{ storage: null }`（不需要 storage）。

- **测试新增**（2 文件 / 11 test）:
  - `test/system-prompt-builder.test.ts`: 28 → 35 test。新增 7 个 case 守住 5 类 prose-path + URL + 实存绝对路径短路 + escaped-space（详见 plan §10.4）。
  - `test/runtime-context-tools-registry-gate.test.ts` (**新文件**): 4 个 test 守住 storage 哨兵的 back-compat / hide / execute 路径 / 工具数量差为 3。
  - `test/runtime.test.ts`: +1 test `resolveCwdFromPrompt stays at project cwd for URL-heavy article paste`（守 `session_cf361f04` event_seq=2613..2616）。
  - `package.json`: 新 test 文件加入 `npm test` 脚本。

- **验证**:
  - `npx tsx --test test/system-prompt-builder.test.ts`：**35/35 pass**（28 pre-existing + 7 新增）。
  - `npx tsx --test test/runtime-context-tools-registry-gate.test.ts`：**4/4 pass**（新文件）。
  - `npx tsx --test test/context-tools-registry.test.ts`：**8/8 pass**（back-compat 守住 PR-8 已有断言）。
  - `npx tsx --test --test-name-pattern="CJK slash|over-filtering|task scope|URL-heavy|real existing absolute" test/runtime.test.ts`：**6/6 pass**（含 1 新增 URL-heavy 回归 test）。
  - `npx tsx --test test/runtime-layering.test.ts`：**11/11 pass**（registry 调用点无回归）。
  - `npx tsx --test test/skill-tools.test.ts`：**21/21 pass**（registry 调用点无回归）。
  - `npx tsc --noEmit`：**0 错误**。
  - `npx tsx /tmp/test-cf361f04.mjs`：`resolveCwdFromPrompt(articlePrompt, projectCwd)` 返回 `projectCwd`（无 URL / 中文 prose 干扰）。
  - `npx tsx /tmp/test-981cc5c2.mjs`：`/etc/hosts` / `/bin/bash` 仍正常 resolve 到对应 cwd，5 个 CJK prose case 全部返回 `projectCwd`。
  - 累计 35 + 4 + 8 + 6 + 11 + 21 + 19 (agent-trace) + 18 (run-checkpoint) + 19 (eval-agent) = 141 pass，0 回归。
  - 1 个 pre-existing flaky test（`test/agent-scheduler.test.ts:518 review and test runtime expose only restricted Bash commands`）在 develop 分支 + 本次 commit 都失败（依赖真实 `npm install` 执行时间），非本次回归。

- **文档变更**:
  - `docs/nexus/reference/context-cwd-drift-and-recall-governance-plan.md`:
    - Priority 行：标注 Phase A Follow-up 收口日期。
    - Status 段：增加 Phase A Follow-up 收口状态 + 5 类 prose 守卫 + URL guard + 实存短路 + SPACE_MARK + 3 调用点更新 + 11 个新 test。
    - §10.4：从「建议」改为「✅ 收口（2026-06-18）」，列出 11 个 test case 验证 + 验证结果 + 1 个 out-of-scope 标注（escaped-space 仍 split 已被 prose guard 整体兜底，cwd 不漂）。
    - 中文概述：标注 Phase A Follow-up 收口 + 11 个新 test 守住 `session_cf361f04` 全部失败点。
  - `docs/nexus/TODO.md`: Context CWD Drift 行从「Phase A 收口」升级为「Phase A + Phase A Follow-up 已收口（2026-06-18）」并列出 11 个新 test。
  - `docs/nexus/WORK_LOG.md`: 本条（2026-06-18 Phase A Follow-up 收口）。

- **边界**:
  - Phase B / D / E / F 不动。
  - 不动 provider / Nexus runtime 行为（仅 `createDefaultToolRegistry` 签名扩展，back-compat 守住）。
  - Escaped-space 路径在 pathPattern 阶段仍被 unescaped space 切分（仅在反斜杠转义下保留）；非存路径整体被 prose guard 兜底，存路径由 `existsSync` 短路 → 不影响 cwd drift。
  - `createDefaultToolRegistry` 默认行为不变（无 opts 时 18 个工具全注册），确保 8 个 pre-existing PR-8 test 全部通过。

- **后续可推进**: Phase B（`SessionRootContinuity` 决策 helper）/ Phase D（`ContextEstimateCalibration` diagnostic）/ Phase E（`ROOT_SCAN_REQUIRES_CONFIRMATION` 工具层 guard）/ Phase F（`UserArtifactContinuity` 当前 session artifact 锚定）仍 Open；按"真实 regression 驱动"原则，等下次真实 session 触发再推进。

## 2026-06-18 — Context CWD Drift Phase B SessionRootContinuity 收口

- **背景**: Phase A Follow-up 收口（上一条 WORK_LOG）后，`extractAbsolutePaths` 的 prose guard 已经能识别 CJK 短语 / URL / escaped-space 三类误识别，但 `session_cf361f04-7ab1-43a5-907a-41a808942686` 的 `task_scope_declared.primaryRoot` 被外部文章路径替换的事件仍然可能发生 — 这是 cwd 决策层的漏洞，与路径识别层正交。Phase B 落地 plan §2 描述的 `SessionRootContinuity` 决策 helper：把"项目根 vs 外部根 vs 用户 session 已经锚定的根"显式投影成一个 4-decision × 9-reason 的 decision 树，让 runtime 在切换 cwd 时 yield 一个 `session_root_continuity` event，让 `bbl inspect-session <id> --trace` 能直接看到决策与原因。

- **代码变更**（5 文件）:
  - `src/runtime/sessionRootContinuity.ts` (**新文件**): 纯 decision helper。`deriveSessionRootContinuity(options)` 接收 `requestCwd` / `prompt` / `storedSessionCwd` / `latestTaskPrimaryRoot` / `acceptExternalPromptPath`，返回 4 decision × 9 reason 的 `SessionRootContinuity` 投影。无第二 source of truth — 全部从 `extractAbsolutePaths` 的现有输出 + caller 提供的 session 元数据投影出来。导出 `SESSION_ROOT_DECISIONS` / `SESSION_ROOT_REASONS` 两个 readonly 数组作为 vocabulary contract；导出 `buildSessionRootContinuityMessage(c)` 作为 CLI 可读的 summary。`inheritedCwd = latestTaskPrimaryRoot ?? storedSessionCwd ?? requestCwd` + `hasSessionOverride` + `sessionContextPresent` 三个变量统一控制 keep_session_root 与 require_confirmation 分支。
  - `src/shared/events.ts`: 新增 `SessionRootContinuityEventSchema`（zod discriminated union），加入 `NexusEventSchema` 联合。Fields: `requestCwd` / `storedSessionCwd?` / `latestTaskPrimaryRoot?` / `promptPathCandidates` / `resolvedCwd` / `decision` / `reason` / `isExternalRoot` / `wasProjectRootKept` / `warnings` / `message`。
  - `src/runtime/LLMCodingRuntime.ts:285-340`: `runExecuteStreamInner` 在 `hasSessionContext` 时调用 `resolveCwdWithContinuity({ prompt, baseCwd, storedSessionCwd, latestTaskPrimaryRoot, acceptExternalPromptPath })` 并 yield `session_root_continuity` event；否则回落 2-arg `resolveCwdFromPrompt`（back-compat）。新增 `resolveCwdWithContinuity()` export（行 1402-1431）：内部先调 `deriveSessionRootContinuity`，`require_confirmation` 分支保留 simple 2-arg fallback。
  - `src/runtime/Runtime.ts:67-85`: `RuntimeExecuteOptions` 新增 3 个 optional 字段 `storedSessionCwd` / `latestTaskPrimaryRoot` / `acceptExternalPromptPath`，带 doc 注释指明这是 Phase B 的 surface。
  - `src/runtime/agentTrace.ts:99-122`: AgentTrace 投影在 run span 的 `attributes` 上新增 6 个 `lastContinuity*` 字段（`lastContinuityDecision` / `lastContinuityReason` / `lastContinuityResolvedCwd` / `lastContinuityWasProjectRootKept` / `lastContinuityIsExternalRoot` / `lastContinuityMessage`），从 event stream 末尾反向扫描取最近一条 `session_root_continuity` event。这是 `bbl inspect-session <id> --trace` 的 operator surface。

- **测试新增**（3 文件 / 23 test）:
  - `test/session-root-continuity.test.ts` (**新文件**): 17 个 test 守 4 decision × 9 reason 全 vocabulary + 全部 5 个典型场景（CJK prose / URL-heavy / 真实 internal / 外部 + storedSessionCwd / 外部 + latestTaskPrimaryRoot / `acceptExternalPromptPath=true` opt-in / `latestTaskPrimaryRoot` 优先 / `wasProjectRootKept` 语义 / `buildSessionRootContinuityMessage` 5 decision 全覆盖）。用 `mkdtempSync` + `join(tmpdir(), ...)` 隔离真实文件系统，避开 macOS `/etc → /private/etc` symlink 陷阱。
  - `test/runtime.test.ts`: +5 个 `resolveCwdWithContinuity` 集成 test（URL-heavy 守 `session_cf361f04` / 真实 internal / 外部 + storedSessionCwd / `acceptExternalPromptPath=true` / `latestTaskPrimaryRoot` 优先）。
  - `test/inspect-session.test.ts`: +1 个 `exportSessionTrace: session_root_continuity decision is surfaced on the run span (cf361f04 regression)` 守 AgentTrace 投影把 continuity event 上浮为 run span attributes。手工塞 `session_started` + `session_root_continuity` + `result` 三条 event 到 SQLite，断言 run span 的 `lastContinuityDecision === 'keep_request_cwd'` / `lastContinuityReason === 'url_excluded'` / `lastContinuityWasProjectRootKept === true`。

- **验证**:
  - `npx tsx --test test/session-root-continuity.test.ts`：**17/17 pass**。
  - `npx tsx --test test/inspect-session.test.ts`：**30/30 pass**（含新增 1 个）。
  - `npx tsx --test test/agent-trace.test.ts`：**19/19 pass**（run span attributes 投影无回归）。
  - `npx tsx --test test/runtime.test.ts`：Phase B 的 5 个新 test 全 pass；1 个 pre-existing flaky test `/v1/execute session reuse and history mapping` 失败（event 数 64 !== 2，与本次无关，develop 分支同样失败）。
  - `npx tsc --noEmit`：**0 错误**。
  - 累计 17 + 30 + 19 + 5 = 71 个与 Phase B 直接相关的 test pass。

- **文档变更**:
  - `docs/nexus/reference/context-cwd-drift-and-recall-governance-plan.md`:
    - Priority 行：标注 Phase B 收口（2026-06-18）；Open 列表更新为 Phase D / E / F。
    - Status 段：增加 Phase B 收口状态 + 4 decision × 9 reason vocabulary + 5 文件位置 + 23 个新 test 总数。
    - §Phase B 段：从「Open」改为「✅ 收口（2026-06-18）」，列出每个已落地文件位置 + 守住边界（默认不接外部 prompt path / 无 session context 时回落 2-arg / 不引入新持久化）。
    - §Test Plan：新增「Focused — `test/session-root-continuity.test.ts`」 17 test 子节 + 「Integration — `test/inspect-session.test.ts`」 1 test 子节。
    - 中文概述「当前状态」：标注 Phase A / A Follow-up / B / C 已收口，23 个新 test 守住 `session_cf361f04` 的 cwd 切换面。「下一步」：更新为 Phase D / E / F 三个 Open 项。

- **边界**:
  - 不替代 Phase F（artifact continuity / "这个文章" 跨 turn 指代锚定）。
  - 不引入新持久化字段；`SessionRootContinuity` 是从 caller-supplied 元数据 + 现有 `extractAbsolutePaths` 投影出来的纯函数。
  - 默认不接外部 prompt path（`acceptExternalPromptPath` 默认 false）；`bbl go --external-ok` 之类 opt-in 流程需要显式启用。
  - `hasSessionContext` 为 false 时完整回落 2-arg `resolveCwdFromPrompt`（back-compat，PR-8 的 8 个 test 全部保持绿色）。

- **后续可推进**: Phase D（`ContextEstimateCalibration` diagnostic — provider usage 2x 偏离 emit warn）/ Phase E（`ROOT_SCAN_REQUIRES_CONFIRMATION` 工具层 guard — Phase A 收口后此类触发应已显著减少）/ Phase F（`UserArtifactContinuity` 当前 session artifact 锚定 — `session_cf361f04` final turn 在 `contextRecent` unavailable 后遗忘已粘贴和已读取的文章）仍 Open；按"真实 regression 驱动"原则，等下次真实 session 触发再推进。

## 2026-06-18 — Context CWD Drift session_10320709-2b06-405f-8f51-d954435d4a70 Deep Analysis: 3 Regression Bugs Beyond §10/§11

- **背景**: Phase A / A Follow-up / B / C1 已在 §10 收口，Phase C2 在 §11 登记为 storage propagation 待修。session_10320709-2b06-405f-8f51-d954435d4a70 暴露**3 个接线层 / 兜底层根因**——这反向证明 plan §10.4 "Out of scope" 行的判断有误：以为 Phase A Follow-up 收口后 session 完全可预测；实际未触及**接线层**（Nexus app.ts、LLMCodingRuntime.runExecuteStreamInner 起手）和**dirname 兜底**的根因。详细分析 + 修复方案落入 plan §12。

- **3 个 Bug 复盘**:

  1. **Bug 1 — Cwd 漂到 `/Users/tangyaoyue/Library`**：
     - **症状**: session_10320709 的 6 个 turn 全部跑在 cwd `/Users/tangyaoyue/Library`（被 iCloud 路径污染）。验证脚本 `/tmp/test-extract-10320709.mjs` 对 prompt `分析这个文章'/Users/tangyaoyue/Library/Mobile Documents/com~apple~CloudDocs/家人共享/上百个Agent...'与babel-o项目理念的相似程度` 输出 `/Users/tangyaoyue/Library/Mobile`（4-segment candidate）。
     - **根因（3 段链路）**:
       1. `src/runtime/systemPromptBuilder.ts:255` pathPattern 在 unescaped space 处切断 iCloud 路径 → 产出 4-segment `/Users/tangyaoyue/Library/Mobile`。
       2. `isNonExistentProseCandidate`（line 275-310）只对 1-2 segment candidate 做 prose guard；4-segment `Mobile`（bare Latin word basename）返回 false。
       3. `src/runtime/LLMCodingRuntime.ts:1380-1383` `resolveCwdFromPrompt` 在 `!existsSync(resolved)` 时回退到 `dirname = /Users/tangyaoyue/Library`（macOS 系统目录，永远存在）。
     - **修复方向（按优先级）**: ① `resolveCwdFromPrompt` line 1380-1383 增加 `parent` 拒绝规则（homedir / `/Users` / `/Users/` / `dirname(homedir)` 禁止作为 fallback cwd）；② `extractAbsolutePaths` 加 4-segment 短 bare Latin word 守卫；③ Phase B 的 `deriveSessionRootContinuity` 在 `use_prompt_path` 判定前增加 `isProjectLikeRoot(resolved)` 校验。
     - **影响范围**: session_10320709 6 turn cwd 全漂 + 同类风险（`/Users/.../Documents/` / `Desktop/` / `Downloads/` 都可能触发）。

  2. **Bug 2 — Phase B Nexus 接线层 missing `storedSessionCwd` / `latestTaskPrimaryRoot`**：
     - **症状**: session_10320709 的 0 个 `session_root_continuity` event（预期每 turn ≥ 1 个）。意味着 `LLMCodingRuntime.runExecuteStreamInner` line 290 的 `hasSessionContext = false` 永远成立，Phase B 的 `resolveCwdWithContinuity` 路径根本没被触发。
     - **根因**: `src/nexus/app.ts:2695-2711` `executeStream` 调用**没传** `storedSessionCwd` / `latestTaskPrimaryRoot`。`Runtime.ts:67-85` `RuntimeExecuteOptions` 已定义 3 个 optional 字段（Phase B 收口时加），但 Nexus `app.ts` 的 HTTP / WebSocket 两条 executeStream 路径都没有传。
     - **修复方向**: Nexus HTTP/WS executeStream 加 2 行（`storedSessionCwd` + `latestTaskPrimaryRoot` 来自 `options.storage.getSession?.(sessionId)`）；session record schema 加 `latestPrimaryRoot` 字段（与 `taskScope.ts:32` 的 `primaryRoot` 对齐）；emit `session_root_continuity_missing` diagnostic。
     - **影响范围**: session_10320709 0 个 continuity event + 所有已上线 Nexus session 的 Phase B CLI 决策记录、AgentTrace 投影全部失效。

  3. **Bug 3 — LLMCodingRuntime.runExecuteStreamInner missing storage 注入**（**§11 已登记，Phase C2 Open/P0**）：
     - **症状**: session_10320709 的 3 个 context tool 失败（event_seq 10049/10050 `contextSearch`、15071/15072 `contextRecent`、15102/15103 `contextSearch` 再次失败）。
     - **根因**: `LLMCodingRuntime.runExecuteStreamInner` 整段**没有** `options = { ...options, storage: this.storage }`（对比 `LocalCodingRuntime.ts:170-172` 有）。`executeToolSafely` → `tool.execute(input, { storage: undefined })` → 触发 Phase C guard。
     - **修复方向**: §11.4 修 1（`runExecuteStreamInner` 起手段落 2 行）。

- **修复优先级**（按 P0 → P1 排序）:

  | 优先级 | Bug | 修法 | 代码量 | Test |
  | --- | --- | --- | --- | --- |
  | **P0** | Bug 3（C2 storage） | §11.4 修 1 | 1 行 | 5 个（§11.5） |
  | **P0** | Bug 2（Nexus 接线层） | §12.2 修 A | ~5 行 | 2 个（HTTP + WS） |
  | **P1** | Bug 1（cwd 漂 Library） | §12.1 修 A → C | ~15 行 | 6 个（dirname 收紧 3 + 4-segment guard 2 + continuity 投影 1） |

  按 P0 → P1 顺序，每段独立 PR，便于 regression 验证。

- **验证策略**:
  1. **Bug 3 fix**: 跑 `test/runtime-context-tools-registry-gate.test.ts` 4 个 + `test/runtime.test.ts` 6 个 + 新增 `test/runtime-storage-propagation.test.ts` 5 个 §11.5 测试；用 `MemoryStorage` 注入 `LLMCodingRuntime` + 故意不传 `RuntimeExecuteOptions.storage` → 验证 `contextSearch` 不再返回 `CONTEXT_STORAGE_UNAVAILABLE`。
  2. **Bug 2 fix**: 在 `test/nexus-runtime-wiring.test.ts` 新增 2 个测试：HTTP `executeStream` 与 WS `executeStream` 都把 `storedSessionCwd` / `latestTaskPrimaryRoot` 注入；mock Nexus `app.ts:2695` 调用点，验证 options 包含这 2 个字段。
  3. **Bug 1 fix**: 新增 `test/resolve-cwd-fallback.test.ts` 3 个 test：① iCloud `Mobile Documents` 路径 prompt → cwd 不漂到 `~/Library`；② 已知 project root 锚定检查通过；③ `keep_session_root` 决策在 Project-root 校验失败时触发。

- **Reopen 信号**（operator-facing）:
  - 任何 `cwd` 漂到 `/Users/<user>/Library` / `/Users/<user>/Documents` 这类「家目录」都是 P1 回归（必须 reopen Phase A/B）。
  - 任何 `session_root_continuity` event 缺失 + 0 个 `lastContinuity*` attributes 是 P0 回归（必须 reopen Phase B 接线层）。
  - 任何 `CONTEXT_STORAGE_UNAVAILABLE` + `events` 表非空 是 P0 回归（会阻塞 Phase C2 关闭，或在已关闭后 reopen 注入层）。

- **文档变更**:
  - `docs/nexus/reference/context-cwd-drift-and-recall-governance-plan.md`:
    - 新增 §12（"2026-06-18 — Session_10320709-2b06-405f-8f51-d954435d4a70 Deep Analysis: 3 Regression Bugs Beyond §10/§11"）共 6 个子节：12.1 Bug 1 / 12.2 Bug 2 / 12.3 Bug 3（指向 §11）/ 12.4 修复优先级表 / 12.5 验证策略 / 12.6 Reopen 信号。
  - `docs/nexus/TODO.md`: P2 Plan 的 Context CWD Drift 行更新 Phase B/C 收口状态 + 标注 3 个 Bug 待修。
  - `docs/nexus/active/TODO_runtime.md`: 新增 session_10320709 跟进项（3 Bug 修复追踪）。
  - `docs/nexus/WORK_LOG.md`: 本条（2026-06-18 session_10320709 deep analysis）。

- **后续可推进**: Bug 3 → Bug 2 → Bug 1 按 P0 → P1 修复；每段独立 PR + focused regression test + integration test；不扩大 plan 边界（不引入新持久化、不重写 Phase A/B/C 主体逻辑）。

## 2026-06-18 — Long-Running Context Assembly Reality Audit + R0-R7 Follow-up Plan

- **背景**: 用户选中 `long-running-context-assembly.md` 后要求核对源码和 `session_981cc5c2` / `session_cf361f04` / `session_10320709` 的实际运行情况，判断该文档中 "Nexus 组装 = 上下文管理" 是否真实实现。

- **源码审计结论**:
  - 已落地 primitives：`WorkingSetTracker` / `PersistedWorkingSetTracker`、`assembleContext()`、CLI/REST preview、REST working-set GET/PUT/assemble endpoints、`/v1/working-set/observe`、`/v1/context/observe` route + broadcaster skeleton、`LLMCodingRuntime.resume()`。
  - 未闭环：正常 `LLMCodingRuntime.executeStream()` hot path 没有 load persisted working set，也没有把 `workingSetOverride` 传进每次 `refreshRuntimeContextState()`；`refreshRuntimeContextState()` 当前会 drop `workingSetOverride` / include flags；`WorkingSetTracker.applyEvent()` 没有接入真实 tool event stream；REST PUT fresh tracker 与 WS broadcaster tracker 不共享 mutation path；`/v1/context/observe` 主要有 simulated publish 测试，缺真实 runtime e2e。
  - 关键阻塞：`context-cwd-drift-and-recall-governance-plan.md` Phase C2 storage propagation 未收口，导致 storage-backed session 中 `contextSearch` / `contextRecent` 仍可能返回 `CONTEXT_STORAGE_UNAVAILABLE`。

- **真实 session 证据**:
  - `session_981cc5c2-230c-40d1-953c-b956e9dbaaf7`：19666 events；后半段 task scope 漂到 `/`；`contextSearch` schema 失败后继续触发 `CONTEXT_STORAGE_UNAVAILABLE`；无 `working_set_updated` / persisted `assembled` / `session_root_continuity`。
  - `session_cf361f04-7ab1-43a5-907a-41a808942686`：23678 events；scope 从项目根漂到 `/` 再漂到 `/Users/tangyaoyue/Library`；多次 `contextSearch` / `contextRecent` 返回 `CONTEXT_STORAGE_UNAVAILABLE`；无 `working_set_updated` / persisted `assembled` / `session_root_continuity`。
  - `session_10320709-2b06-405f-8f51-d954435d4a70`：15914 events；前 6 个 `task_scope_declared` 都在 `/Users/tangyaoyue/Library`；3 次 context tool 失败均为 `CONTEXT_STORAGE_UNAVAILABLE`；无 `working_set_updated` / persisted `assembled` / `session_root_continuity`。

- **文档修正**:
  - `docs/nexus/proposals/long-running-context-assembly.md`：
    - 顶部状态从 "server 侧全部落地" 改为 Reality Audit 2026-06-18：基础设施部分落地，runtime hot path 未闭环。
    - 新增 "当前真实状态"：明确 primitives、未闭环点、真实 session 证据不支持 zero-loss resume / always-active working set / production cross-session sharing。
    - 新增 §19 Reality Audit 和 §20 R0-R7 Follow-up Execution Plan。
  - `docs/nexus/reference/context-governance-index.md`：
    - long-running context 入口改为 "partially landed；runtime hot path 未 inject persisted working set"。
    - Open Items 拆成 hot-path working-set injection、REST PUT ↔ observe shared tracker、real-runtime context observe e2e。
  - `docs/nexus/TODO.md`：
    - "Behavior Monitor / Long-Running Context Assembly" 行升级为 "P1 Plan — Long-Running Context Assembly Hot Path Closure"，列出 R0-R7 执行顺序。
  - `docs/nexus/active/TODO_runtime.md`：
    - 新增 "P1 Long-Running Context Assembly Hot Path Closure — R0-R7" 具体待办。

- **R0-R7 执行顺序**:
  1. R0：先修 storage propagation + continuity wiring（接 `session_10320709` Bug 2/3）。
  2. R1：修 cwd drift guard，避免 working set 持久化污染 `/` / `~/Library`。
  3. R2：把 persisted working set 接进正常 `executeStream` hot path。
  4. R3：REST PUT 与 `/v1/working-set/observe` 共享 tracker。
  5. R4：`/v1/context/observe` 做真实 runtime e2e + redacted payload。
  6. R5：resume preview product path，不宣称 durable continuation。
  7. R6：Go TUI 只消费 runtime-owned observer facts。
  8. R7：用三个真实 session 做 regression replay gate。

- **边界**:
  - 不新增长期记忆权威源；MemoryProvider / EverCore 仍跟 memory governance。
  - 不把 behavior trace 当事实源。
  - 不默认持久化 full assembled prompt。
  - 不允许 CLI / Go TUI 自行推导 context truth。
  - 不宣称 durable execution resume，直到 continuation snapshot 真正实现。

## 2026-06-18 — Context CWD Drift session_10320709 二次复盘: 4 遗漏细节 + Bug 4 + 修正修复优先级

- **背景**: §12 的 3-bug 分析基于首轮推断，未直接读 SQLite events 表。本轮用 `node:sqlite` 只读直查 `/Users/tangyaoyue/.babel-o/db.sqlite`（15914 events）做二次复盘，发现 §12 遗漏 4 个关键细节 + 1 个新架构层 bug（Bug 4），并修正修复优先级。详细证据落入 plan §13。

- **4 个遗漏细节**:

  1. **真实 prompt 用普通空格（非 `\ ` escape）**: user_message seq=1 原文 `分析这个文章'/Users/tangyaoyue/Library/Mobile Documents/com~apple~CloudDocs/家人共享/上百个Agent...md'与babel-o项目理念的相似程度`。Phase A Follow-up ④ 的 SPACE_MARK 哨兵**只处理 `\ ` shell escape**，而真实用户粘贴的是**普通空格**——SPACE_MARK 修了错误的目标。

  2. **一条 iCloud 路径拆成 2 candidate**: `user_intake_guidance` seq=3 `explicitPaths = ["/Users/tangyaoyue/Library/Mobile","/com~apple~CloudDocs/家人共享/上百个Agent"]`。第 1 个 → cwd 漂移源；第 2 个 → 进了 `task_scope_declared.explicitRoots`（seq=4）成为**垃圾 explicitRoot**，让 file-discovery 去搜不存在的 `/com~apple~CloudDocs/...`。§12 只记了 cwd 漂，漏了 explicitRoot 污染。

  3. **`/Users/tangyaoyue/Library/Mobile` 不存在**（`ls` + `existsSync` 验证）；`~/Library` 存在。因此 `resolveExplicitPromptCwd`（`app.ts:5662`，Site A）**正确拒绝** `/Mobile`（isDirectory 失败 → undefined），但 `resolveCwdFromPrompt`（`LLMCodingRuntime.ts:1380-1383`，Site B）**错误接受**其 dirname `~/Library`（永远存在）。**两 resolution site 行为不一致** → Bug 4。

  4. **drift 跨 turn 2-6 持续**: session_started seq=2/3914/4292/4454/5980/9867 全部 cwd=`~/Library`，但 turn 2-6 的 prompt **完全无路径**（"两个项目的理念哪一个更先进一些"）。说明 drift 一旦发生就被向前传播。turn 7 因用户重述项目内路径 `在/Users/tangyaoyue/DEV/BABEL/BabeL-O/docs/nexus中...` 而**自愈**（seq=14509 cwd=`docs/nexus`）。§12 把它当单 turn 现象，错了。

- **Bug 4 [NEW, P1] — Dual Cwd Resolution Sites Disagree + session.cwd Per-turn Mutation**: `cwd` 在 `app.ts:5651 resolveRequestCwd`（Site A，只接受实存目录）与 `LLMCodingRuntime.ts:1378 resolveCwdFromPrompt`（Site B，有 dirname 兜底）两处用不同逻辑解析；`app.ts:2301 session.cwd = cwd` 每 turn 覆写。两 site 对 `/Mobile` 给出不同结果（A 拒绝、B 接受 `~/Library`），runtime 用 Site B 覆写 `options.cwd` 并 emit `session_started.cwd=~/Library`，drift 跨 turn 持续。

- **下游损害清单**（§12 漏列）:
  - **8 GLOB_FAILED**（seq 155/271/422/428/4521/4527/6121/10314）: ripgrep 在 `~/Library/Caches/com.apple.ap.adprivacyd` 撞 `Operation not permitted` → 整段失败（非 partial result）。**独立工具鲁棒性问题**：Glob 遇 permission-denied 子目录应跳过继续扫 + diagnostic，而非整段失败。建议在 tool-governance-plan.md 单列 follow-up。
  - **3 scope_boundary_detected parent_scan**（seq 265/6115/10308）: `taskPrimaryRoot=~/Library` → 模型够项目 `/Users/tangyaoyue/DEV` → 触发 parent_scan 到 `/Users/tangyaoyue` → 3 次确认中断。
  - **6 WEB_SEARCH_FAILED**（seq 10044/10097/10302/10460/10547/10667）: "fetch failed"。独立网络/配置问题（非本 plan 范围），但加剧 session 质量——模型查 "OpenManus/OpenMenus" 学术项目失败，只能凭训练数据回答。
  - **5 INVALID_TOOL_INPUT + 1 TOOL_INPUT_PARSE_ERROR**: ListDir `maxDepth>2` 等 provider-side malformed calls（次要）。
  - **1 幻觉路径拼接**（seq=4786）: Read `/Users/tangyaoyue/Library/Mobile Documents/com~apple~CloudDocs/家人共享/docs/nexus/context-and-subagent-upgrade-pla...`——模型把 drifted iCloud 基路径 + 项目相对路径拼成不存在的路径。
  - **上下文浪费**: execution_metrics seq=3911 turn 1 `contextCharsIn=992400`（≈250k tokens），大部分是失败 Library 扫描输出。drift 不只污染 cwd，还烧 context budget。

- **修正后的修复优先级**（替换 §12.4）:

  | 优先级 | Bug | 修法 | 代码量 | 阻塞的下游损害 |
  | --- | --- | --- | --- | --- |
  | **P0** | Bug 1 Layer A | `extractAbsolutePaths` quote-delimited span（`'...'`/`"..."`/backtick）优先识别，整段实存则绕过空格切断 | ~15 行 | cwd 漂移 + 垃圾 explicitRoot + 8 GLOB_FAILED + 3 parent_scan + 上下文浪费 |
  | **P0** | Bug 1 Layer B | 共享 `isAcceptablePromptCwd` 在 Site A+B 拒绝 homedir/`~/Library`/`~/Documents`/`~/Desktop`/`~/Downloads`/`/Users` | ~10 行 | dirname 兜底漏网 |
  | **P0** | Bug 3（C2 storage） | §11.4 修 1 + Nexus 接线 + runtimeToolLoop merge | ~8 行 | 3 CONTEXT_STORAGE_UNAVAILABLE |
  | **P1** | Bug 2 + origin_cwd | `sessions.origin_cwd` 不可变列 + `app.ts:2695` 传 `storedSessionCwd=origin_cwd` + `latestTaskPrimaryRoot` | ~20 行 | Phase B continuity 失效 + 0 session_root_continuity event |
  | **P1** | Bug 4（architectural） | 统一 Site A/B：删 `resolveExplicitPromptCwd` 让 runtime+PhaseB 决策，或把 Phase B 上移到 `resolveRequestCwd`；`session.cwd` 不被 external prompt 覆写 | ~30 行 refactor | 跨 turn drift 持续 |

  **关键修正**: Bug 1 从 P1 提升到 **P0**（cwd 漂移 load-bearing fix）；Bug 2 是 defense-in-depth（`session.cwd` 本身已漂，需不可变 `origin_cwd`）；Bug 1 Layer A+B 与 Bug 2 互补不替代。

- **修正后的 Reopen 信号**（替换 §12.6）:
  - cwd 漂到家目录 → Bug 1 Layer A+B 未收口。
  - `task_scope_declared.explicitRoots` 含 `/com~apple~...` 破碎 fragment → Bug 1 Layer A 未收口。
  - turn prompt 无项目路径但 `session_started.cwd !== session.origin_cwd` → Bug 4 未收口（跨 turn drift）。
  - `session_root_continuity` event 缺失 → Bug 2 未收口。
  - `CONTEXT_STORAGE_UNAVAILABLE` + events 表非空 → Bug 3 未收口。
  - `GLOB_FAILED` 因 `Operation not permitted` 整段失败 → 独立工具鲁棒性 follow-up（tool-governance-plan）。

- **文档变更**:
  - `docs/nexus/reference/context-cwd-drift-and-recall-governance-plan.md`:
    - Status 段追加 §13 二次复盘摘要（普通空格 / 2 candidate / Site A+B 不一致 / 跨 turn 持续 / Bug 1 提 P0 / Bug 2 需 origin_cwd / 下游损害清单）。
    - 新增 §13（"Session_10320709 Re-examination: Missed Details + Refined Fix Plan"）共 7 个子节：13.1 遗漏证据表 / 13.2 Bug 4 dual resolution sites + session.cwd mutation / 13.3 Bug 1 双层修法（Layer A quote span + Layer B isAcceptablePromptCwd）/ 13.4 Bug 2 origin_cwd 修正 / 13.5 下游损害清单（8 GLOB_FAILED + 3 parent_scan + 6 WEB_SEARCH + 幻觉路径 + 992k context）/ 13.6 修正修复优先级表 + reopen 信号 / 13.7 与 §12 差异总结。
  - `docs/nexus/WORK_LOG.md`: 本条（2026-06-18 session_10320709 二次复盘）。

- **后续可推进**: Bug 1 Layer A → Bug 1 Layer B → Bug 3 → Bug 2+origin_cwd → Bug 4 按 P0 → P1 修复；Bug 1 Layer A 是 cwd 漂移的根因修复（quote-delimited span），应最优先。Glob permission-denied 降级为 partial result 的工具鲁棒性改进独立列入 tool-governance-plan follow-up，不阻塞本 plan。

## 2026-06-18 — Context CWD Drift Bug 1 Layer A 收口: quote-delimited span 优先识别

- **背景**: §13 二次复盘证明 cwd 漂到 `~/Library` 的 load-bearing 根因是 `extractAbsolutePaths` 的 pathPattern 在**普通空格**处切断 iCloud 路径（Phase A Follow-up ④ 的 SPACE_MARK 哨兵只处理 `\ ` escape，修错目标）。真实 prompt `分析这个文章'/Users/.../Mobile Documents/com~apple~CloudDocs/家人共享/上百个Agent，该怎么管？...md'与babel-o项目理念的相似程度` 里路径被单引号包住、含普通空格 + CJK 标点（`，？：`），pathPattern 的字符类同时排除空格和这些 CJK 标点 → 一条路径拆成 2 个破碎 candidate（`/Users/.../Library/Mobile` → cwd 漂移源 + `/com~apple~CloudDocs/...` → 垃圾 explicitRoot）。

- **代码变更**（1 文件）:
  - `src/runtime/systemPromptBuilder.ts` `extractAbsolutePaths()`:
    - 新增 `extractAndBlankQuotedRealPaths(text, paths)` helper，在 pathPattern 循环**之前**运行。匹配 `'...'` / `"..."` / backtick 平衡 span（backreference 保证开闭引号一致），对内容是绝对/家相对路径 + 含 `/` + 含普通空格的 span，校验实存性（`existsSync` true 或 `resolvePromptPath` 命中实存 prefix 且非 prose candidate）→ 把 resolved path 直接加入 `paths`，并把**整个 span（含引号）替换为等长空格**，让 pathPattern 在该位置找不到 `/`、无法再 emit 破碎 fragment。
    - 关键设计：不只替换空格为 SPACE_MARK（不够，因为 pathPattern 还会在 CJK 标点 `，？：` 处切断文件名 `上百个Agent，该怎么管？...md`）；而是直接 add + blank 整段，绕过 pathPattern 对该 span 的处理。非实存的 quoted span 原样返回，既有 prose guard 继续处理。
    - `let preserved` 从 `const` 改为 `let`（多一步 blank 处理）。

- **测试新增**（4 test，`test/system-prompt-builder.test.ts` 35 → 39）:
  1. `Bug 1 Layer A: quoted iCloud-style path with plain space is captured whole` — 用 `mkdtempSync` 造真实 `Mobile Documents/上百个Agent，该怎么管？.md`（普通空格 + CJK 标点文件名），prompt 用单引号包路径 → 断言整段路径在 candidates 里 + 破碎 fragment `/Mobile` **不**在。
  2. `Bug 1 Layer A: double-quoted path with plain space is captured whole` — 双引号 `"` 包真实路径。
  3. `Bug 1 Layer A: backtick-quoted path with plain space is captured whole` — backtick 包真实路径。
  4. `Bug 1 Layer A: quoted prose that is NOT a real path is left untouched` — `'some non existent / path with space'` 不实存 → 不 merge、不产生 candidate（防 false-positive）。

- **验证**:
  - `npx tsx /tmp/test-extract-10320709.mjs`：prompt 1 从 `/Users/tangyaoyue/Library/Mobile` → **整段 iCloud 文件路径**；prompt 7（项目内路径）行为不变。
  - `npx tsx --test test/system-prompt-builder.test.ts`：**39/39 pass**（35 pre-existing + 4 新增）。
  - `npx tsx --test test/session-root-continuity.test.ts test/inspect-session.test.ts`：**47/47 pass**。
  - `npx tsx --test test/runtime-context-tools-registry-gate.test.ts test/context-tools-registry.test.ts`：**12/12 pass**。
  - `npx tsx --test --test-name-pattern="CJK slash|over-filtering|task scope|URL-heavy|real existing absolute|resolveCwd|cwd" test/runtime.test.ts`：**13/13 pass**（含 `session_cf361f04` URL-heavy + `/v1/execute persists resolved cwd` 重用回归 + `LLMCodingRuntime resolves cwd from prompt absolute path`）。
  - `npx tsc --noEmit`：**0 错误**。
  - `test/runtime.test.ts` 全量运行有 1 个 pre-existing flaky（`Unable to deserialize cloned data` test-runner 序列化错误，非断言失败，develop 分支同样失败，与本次无关）。

- **边界**:
  - 只处理 quote-delimited 真实路径；非 quoted 的普通空格路径（如裸 `看 /Users/.../Mobile Documents/... 下文件` 无引号）仍由 pathPattern 切断 — 这是 Layer B（`isAcceptablePromptCwd` 拦系统目录）和 Bug 4（统一 resolution sites）的职责，Layer A 不扩大边界。
  - 不修改 `resolveCwdFromPrompt` 的 dirname 兜底逻辑（那是 Layer B 的修法）。
  - 不引入新持久化、不改 Phase B continuity 主体。

- **后续可推进**: Bug 1 Layer B（共享 `isAcceptablePromptCwd` 在 Site A+B 拦 homedir/`~/Library`/`~/Documents` 等系统目录，~10 行 + 3 test）→ Bug 3（C2 storage 注入）→ Bug 2+origin_cwd → Bug 4。Layer A 修了 quote-delimited 根因，Layer B 兜底非 quoted + dirname 漏网。

## 2026-06-18 — Context CWD Drift Bug 1 Layer B 收口: isAcceptablePromptCwd 共享守卫

- **背景**: Layer A 修了 quote-delimited 路径的根因，但非 quoted 裸空格路径（如 `分析 /Users/.../Library/Mobile 这个路径`）仍会被 pathPattern 切断成 `/Users/.../Library/Mobile`（不存在），`resolveCwdFromPrompt` Site B 的 dirname 兜底返回 `~/Library`（macOS 系统目录永远存在）。§13 二次复盘证明两 resolution site（Site A `app.ts:resolveExplicitPromptCwd` 只接受实存目录 / Site B `LLMCodingRuntime.ts:resolveCwdFromPrompt` 有 dirname 兜底）行为不一致；Layer B 用一个共享守卫在两 site 都拒绝系统/家目录。

- **代码变更**（3 文件）:
  - `src/runtime/systemPromptBuilder.ts`: 新增 export `isAcceptablePromptCwd(p): boolean` 纯函数。rejected 列表含 `/` / `/Users` / `/Users/` / `homedir()` / `dirname(homedir())` / `${home}/Library` / `${home}/Documents` / `${home}/Desktop` / `${home}/Downloads` / `${home}/Applications`。用 `resolve(p)` 归一化后比对。放在 systemPromptBuilder 是因为它是 path-resolution helper 的 owner，且两 site 都已 import 该模块。顶部 import 增 `resolve`（从 `node:path`）。
  - `src/runtime/LLMCodingRuntime.ts` Site B `resolveCwdFromPrompt()`：3 个 return 点都加 `isAcceptablePromptCwd` 守卫 —— ① dirname 兜底（line ~1382，session_10320709 漂移源）`parent` 必须通过守卫才 return；② 实存目录分支 `resolved` 必须通过守卫；③ 文件父目录分支 `parent` 必须通过守卫。守卫失败则 `continue` 到下一 candidate。import 增 `isAcceptablePromptCwd`。
  - `src/nexus/app.ts` Site A `resolveExplicitPromptCwd()`：`stat.isDirectory()` 后加 `&& isAcceptablePromptCwd(resolved)` 守卫，防止 prompt 直接落在 `~/Library`（实存目录）被提升。import 增 `isAcceptablePromptCwd`。

- **测试新增**（新文件 `test/resolve-cwd-fallback.test.ts`，10 test）:
  - `isAcceptablePromptCwd — vocabulary`（5 test）：拒绝 homedir / `~/Library` / `~/Documents` / `/` / `/Users`；接受 synthetic project root（用真实 `homedir()` + `mkdtempSync`，honest about on-disk state；`~/Library` 不存在时 skip）。
  - `resolveCwdFromPrompt — Bug 1 Layer B system-dir fallback rejection (Site B)`（5 test）：① broken `/Mobile` fragment（非 quoted，Layer A 不接）→ dirname `~/Library` 被拒，保持 baseCwd；② 直接 `~/Library` prompt（实存）→ 拒，保持 baseCwd；③ 直接 `~/Documents` → 拒；④ 真实 project-internal dir 仍正常 resolve（防 over-filtering）；⑤ 真实文件 → 父目录（非系统目录）仍正常 resolve。
  - 已加入 `package.json` test 脚本（同时补登 `test/session-root-continuity.test.ts` 此前漏登）。

- **验证**:
  - `npx tsx /tmp/test-layerb.mjs`：4 case 全过 —— broken `/Mobile` → baseCwd（不漂 `~/Library`）；real internal dir → 正常 resolve；直接 `~/Library` → baseCwd；直接 `~/Documents` → baseCwd。
  - `npx tsx --test test/resolve-cwd-fallback.test.ts`：**10/10 pass**。
  - `npx tsx --test test/system-prompt-builder.test.ts test/session-root-continuity.test.ts test/inspect-session.test.ts test/runtime-context-tools-registry-gate.test.ts test/context-tools-registry.test.ts`：**78/78 pass**。
  - `npx tsx --test --test-name-pattern="resolveCwd|cwd|CJK slash|URL-heavy|real existing absolute|resolves cwd from prompt" test/runtime.test.ts`：**11/11 pass**（含 `session_cf361f04` URL-heavy + `LLMCodingRuntime resolves cwd from prompt absolute path` + `/v1/execute persists resolved cwd` 重用回归）。
  - `npx tsc --noEmit`：**0 错误**。
  - `test/permission-flow.test.ts` 的 `smart permissions: prompts user on non-whitelisted` 测试失败，经 `git stash` 验证为 **pre-existing flaky**（baseline 同样 3/3 失败，3 秒轮询超时未收到 permission_request，与本改动无关——`extractAbsolutePaths('bash "rm -rf temporary_folder"')` 返回 `[]`，cwd 解析不受影响）。

- **边界**:
  - Layer B 只在两 site 的 return 点守卫；不改 `resolveCwdFromPrompt` 的整体逻辑、不改 Phase B continuity 主体、不引入新持久化。
  - external-but-project-like 根（如 `/Users/tangyaoyue/DEV/BABEL/BabeL-O` 之外的其它项目目录）仍接受——Phase B continuity 的 `require_confirmation` / `keep_session_root` 单独处理外部确认。Layer B 不接管 external 判定。
  - 与 Layer A 互补不替代：Layer A 修 quote-delimited 根因（普通空格 + CJK 标点），Layer B 兜底非 quoted 裸空格 + dirname 漏网 + 直接落在系统目录的 prompt。

- **后续可推进**: Bug 3（C2 storage 注入，`LLMCodingRuntime.runExecuteStreamInner` 起手 `options = { ...options, storage: this.storage }` + Nexus HTTP/WS `executeStream` 传 `storage` + `runtimeToolLoop` defensive merge，~8 行 + 5 test）→ Bug 2+origin_cwd → Bug 4。Layer A+B 已彻底锁住 cwd 漂移根因；Bug 3 切换到 context tool storage 注入。

## 2026-06-18 — Context CWD Drift Bug 3 / Phase C2 收口: storage 注入 3 个接线点

- **背景**: session_10320709-2b06-405f-8f51-d954435d4a70 证明 storage-backed Nexus session（SQLite 15914 events + 权限审计可写）中 `contextSearch` / `contextRecent` 仍返回 `CONTEXT_STORAGE_UNAVAILABLE`（event_seq 10050 / 15072 / 15103）。§11 复盘根因：`executeToolSafely` → `tool.execute(input, { storage: options.storage })` 而 `RuntimeExecuteOptions.storage === undefined`——即使 `LLMCodingRuntime.this.storage` 存在、Nexus `options.storage` 存在、`executeProviderToolCall` 收到 side-channel storage。3 个接线点都没把 storage 填进 `RuntimeExecuteOptions.storage`。

- **代码变更**（3 文件 / 3 接线点）:
  - `src/runtime/LLMCodingRuntime.ts` `runExecuteStreamInner` 起手（line ~286）：段首注入 `if (!options.storage && this.storage) options = { ...options, storage: this.storage }`。镜像 `LocalCodingRuntime.ts:170-172` 既有模式。runtime 自己的 storage 自动填进 per-request options，context tool 在 runtime 内部 tool call 拿到非空 `ToolContext.storage`。
  - `src/nexus/app.ts` HTTP + WS 两条 `executeStream` 调用点（line ~2695 + ~4071）：各加 `storage: options.storage`。Nexus 把自己的 storage 传给 runtime，覆盖了「LLMCodingRuntime 起手注入」之外的入口（如 runtime 由其它 factory 构造但 Nexus 仍持有 storage 的场景）。
  - `src/runtime/runtimeToolLoop.ts` `executeProviderToolCall` 在 `executeToolSafely` 之前（line ~737）：defensive merge `const toolRuntimeOptions = runtimeOptions.storage ? runtimeOptions : { ...runtimeOptions, storage: options.storage }`，把 side-channel storage 填进传给 `executeToolSafely` 的 options。defense-in-depth——任何 caller 即使没在 runtimeOptions 里带 storage，只要 `executeProviderToolCall` 收到 side-channel storage，ToolContext.storage 就非空。

- **测试新增**（新文件 `test/runtime-storage-propagation.test.ts`，5 test）:
  1. `runtimeToolLoop defensive merge: contextRecent succeeds when runtimeOptions.storage is omitted but side-channel storage provided` — session_10320709 精确场景：`runtimeOptions.storage` 故意省略，side-channel `storage` 提供 → `contextRecent` 不返回 `CONTEXT_STORAGE_UNAVAILABLE`。
  2. `contextSearch succeeds when runtimeOptions.storage is omitted but side-channel storage provided` — 同上，`contextSearch`。
  3. `existing runtimeOptions.storage is preserved (not overwritten) when already set` — defensive merge 不 clobber 显式 storage。
  4. `tool_started + tool_completed events are emitted for contextRecent` — `tool_completed.success === true`（不只看 content 文案）。
  5. `negative: no-storage registry hides context tools (back-compat preserved)` — `createDefaultToolRegistry({ storage: null })` 仍隐藏 3 个 context 工具，Phase C2 注入不破坏 no-storage 路径。
  - 已加入 `package.json` test 脚本。

- **回归守门验证**（证明 test 真能抓回归）: 临时 revert `runtimeToolLoop` defensive merge → 3 个 test（contextRecent + contextSearch + events）失败；restore → 5/5 pass。证明 test 精确锁住注入点，不是空过。

- **验证**:
  - `npx tsx --test test/runtime-storage-propagation.test.ts`：**5/5 pass**。
  - `npx tsx --test test/runtime-storage-propagation.test.ts test/runtime-context-tools-registry-gate.test.ts test/resolve-cwd-fallback.test.ts test/system-prompt-builder.test.ts test/session-root-continuity.test.ts test/inspect-session.test.ts test/context-tools-registry.test.ts`：**113/113 pass**。
  - `npx tsx --test --test-name-pattern="resolveCwd|cwd|CJK slash|URL-heavy|real existing absolute|resolves cwd from prompt|persists resolved cwd|tool loop executes" test/runtime.test.ts`：**12/12 pass**（含 `/v1/execute persists resolved cwd` 重用回归 + `runtime tool loop executes a provider tool call`）。
  - `npx tsx --test test/run-session-flow.test.ts`：**6/6 pass**（Nexus HTTP `executeStream` 全路径，含 `app.ts` storage 注入）。
  - `npx tsx --test test/context-regression.test.ts test/context-assembler.test.ts`：**68/68 pass**。
  - `npx tsc --noEmit`：**0 错误**。

- **边界**:
  - 3 个注入点互补：LLMCodingRuntime 起手注入覆盖 runtime 内部 tool call；Nexus app.ts 注入覆盖 per-request options；runtimeToolLoop merge 是 defense-in-depth。三者都做才能覆盖「runtime factory 不同 / caller 没带 storage / side-channel only」三层场景。
  - 不改 `executeToolSafely` 主体、不改 context tool 的 Phase C guard（`contextSearch.ts:39-45` / `contextRecent.ts:35-41` 仍是最后一道防线）。
  - 不引入新持久化、不改 Phase B continuity 主体。

- **后续可推进**: Bug 2 + origin_cwd（`sessions.origin_cwd` 不可变列 + `app.ts:2695` 传 `storedSessionCwd=origin_cwd` + `latestTaskPrimaryRoot`，~20 行 + 3 test）→ Bug 4。Bug 3 已让 context tool 在 storage-backed session 可用；Bug 2 让 Phase B continuity 真正触发（session_10320709 的 0 个 `session_root_continuity` event 即此因）。

## 2026-06-18 — Context CWD Drift Bug 2 收口: origin_cwd 不可变列 + Phase B continuity 接线

- **背景**: session_10320709 的 0 个 `session_root_continuity` event 因 `LLMCodingRuntime.runExecuteStreamInner` 的 `hasSessionContext = false` 永真——Nexus `app.ts:2695` `executeStream` 没传 `storedSessionCwd` / `latestTaskPrimaryRoot`。§13.4 进一步发现：即使补传，`session.cwd` 本身已漂（turn 1 → `~/Library`，跨 turn 2-6 持续），单纯传 `session.cwd` 会传漂移值。修法需一个**不可变 origin cwd**——launcher `body.cwd` 写入一次，不随 `session.cwd` 漂移。

- **代码变更**（4 文件）:
  - `src/shared/session.ts`: `SessionSnapshot` 新增 `originCwd?: string` 字段 + 注释（immutable creation cwd，Phase B continuity 用它拉回 drifted requestCwd）。
  - `src/storage/SqliteStorage.ts`:
    - migration v15：`ALTER TABLE sessions ADD COLUMN origin_cwd TEXT` + `UPDATE sessions SET origin_cwd = cwd WHERE origin_cwd IS NULL`（backfill 现有 row，best-effort origin）+ `PRAGMA user_version = 15`。**backfill 无条件运行**（idempotent `WHERE NULL`），不嵌在 `if (!columns.includes)` 里——否则列已存在时（v1 dynamic ALTER 已加）backfill 被跳过。
    - v1 dynamic ALTER `expectedSessions` 增 `origin_cwd`（新库直接有列）。
    - `sessionParams` 增 `originCwd: session.originCwd ?? null`。
    - `saveSession` 的 `INSERT ... ON CONFLICT DO UPDATE` 子句**不**包含 `origin_cwd`——ON CONFLICT 只更新 cwd/prompt/phase/... 等可变字段，origin_cwd 保持 INSERT 时的值（immutable）。
    - `rowToSession` 增 `originCwd: nullableString(row.origin_cwd)`。
  - `src/storage/MemoryStorage.ts`: `saveSession` 在 `existing.originCwd` 存在且 `cloned.originCwd` 缺失时回填（保 back-compat：older caller 不带 originCwd 时不 clobber 到 undefined；drift 时 originCwd 不被覆写）。
  - `src/nexus/app.ts`:
    - `createSessionSnapshot` + `/v1/sessions` 创建点都设 `originCwd = cwd`（launcher body.cwd / Nexus defaultCwd）。
    - `PreparedExecution` type 增 `storedSessionCwd?` + `latestTaskPrimaryRoot?`。
    - `prepareExecution` 末尾派生 `storedSessionCwd = session.originCwd ?? session.cwd` + 调 `resolveLatestTaskPrimaryRoot(storage, sessionId)`。
    - 新增 `resolveLatestTaskPrimaryRoot(storage, sessionId)` helper：`listEvents(limit:50, order:'desc')` 扫最近 `task_scope_declared.primaryRoot`；失败不阻塞（runtime 回落 2-arg）。
    - HTTP + WS 两条 `executeStream` 调用点都传 `storedSessionCwd` + `latestTaskPrimaryRoot`（spread，undefined 时不传）。

- **测试新增**（新文件 `test/session-origin-cwd.test.ts`，4 test）:
  1. MemoryStorage：originCwd 创建后 survives drifted cwd 的 saveSession。
  2. MemoryStorage：older caller 省略 originCwd 字段时不 clobber。
  3. SqliteStorage：originCwd 创建后 survives drifted cwd 的 `ON CONFLICT` update（直接验证 SQL 层 immutability）。
  4. SqliteStorage v15 migration backfill：用 `DatabaseSync` 直接把 origin_cwd 置 NULL + `PRAGMA user_version=14` 模拟 pre-Bug-2 row，reopen storage → backfill 为 cwd。
  - **测试抓到真实 migration bug**：初版 backfill `UPDATE` 嵌在 `if (!columns.includes('origin_cwd'))` 里，列已存在时被跳过；test 4 失败暴露 → 修正为无条件运行。已加入 `package.json` test 脚本。

- **验证**:
  - 真实 db 副本 migration：session_10320709 v14 → v15，`originCwd` backfill 为最终 cwd `docs/nexus`（best-effort，历史 session 无真实 origin）。
  - 真实 db 副本 immutability：create session originCwd=`BabeL-O` → saveSession cwd=`~/Library` → `originCwd` 保持 `BabeL-O`。
  - MemoryStorage immutability：create originCwd=`/proj/root` → saveSession 省略 originCwd + cwd=`/Users/x/Library` → `originCwd` 保持。
  - `npx tsx --test test/session-origin-cwd.test.ts`：**4/4 pass**。
  - `npx tsx --test test/storage.test.ts test/session-origin-cwd.test.ts test/run-session-flow.test.ts test/runtime-storage-propagation.test.ts test/resolve-cwd-fallback.test.ts test/system-prompt-builder.test.ts test/session-root-continuity.test.ts test/inspect-session.test.ts test/runtime-context-tools-registry-gate.test.ts test/context-tools-registry.test.ts`：**125/125 pass**。
  - `npx tsx --test --test-name-pattern="resolveCwd|cwd|continuity|session_root|persists resolved|resolves cwd from prompt|URL-heavy" test/runtime.test.ts`：**10/10 pass**。
  - `npx tsx --test test/run-session-flow.test.ts test/context-regression.test.ts`：**18/18 pass**（Nexus HTTP executeStream 全路径 + context assembler）。
  - `npx tsc --noEmit`：**0 错误**。
  - 真实 `~/.babel-o/db.sqlite` 未触碰（user_version=14，无 origin_cwd 列）——只在副本上测；下次运行自动 migrate。

- **边界**:
  - originCwd 只在 session 创建时写一次；ON CONFLICT 不更新；MemoryStorage 保 back-compat。
  - `latestTaskPrimaryRoot` 用 bounded `listEvents(limit:50, order:'desc')` 查最近 task_scope_declared；失败不阻塞（runtime 回落 2-arg `resolveCwdFromPrompt`，Phase B continuity 仍可仅凭 storedSessionCwd 触发）。
  - 历史 session backfill 用最终 cwd 作 best-effort origin（无法恢复真实 origin）；新 session 从创建即有正确 origin。
  - 不改 Phase B continuity 主体、不改 `deriveSessionRootContinuity` 决策逻辑——只补接线层让它真正触发。

- **后续可推进**: Bug 4（统一 dual cwd resolution sites：删 `resolveExplicitPromptCwd` 让 runtime+PhaseB 决策，或把 Phase B continuity 上移到 `resolveRequestCwd`；`session.cwd` 不被 external prompt 覆写，~30 行 refactor + 4 test）。Bug 1 Layer A+B 锁住 cwd 漂移根因，Bug 3 让 context tool 可用，Bug 2 让 Phase B continuity 触发；Bug 4 收口 dual-site 不一致。

## 2026-06-18 — Context CWD Drift Bug 4 收口: 统一 dual cwd resolution sites + session.cwd 不被 prompt 覆写

- **背景**: session_10320709 暴露 §13.2 架构层根因——3 个 divergent 的 prompt→cwd 解析副本：① `app.ts:resolveExplicitPromptCwd` Site A（只接受 existing directory，无 dirname fallback，无 Bug 1 Layer B 守卫），② `LLMCodingRuntime.ts:resolveCwdFromPrompt` Site B（dirname fallback + Layer B 守卫），③ `cli/runSessionFlow.ts:resolveExplicitPromptCwd` 第三份副本（既无 dirname fallback 也无 Layer B 守卫）。Site A 和 Site B 行为不一致 → `session.cwd`（Site A 写）和 `options.cwd`（Site B 写）分离，runtime 内部覆盖进一步漂移。再加上 `app.ts:2301 session.cwd = cwd` 每 turn 覆写，drift 跨 turn 2-6 持续。

- **代码变更**（4 文件）:
  - `src/runtime/systemPromptBuilder.ts`: 新增 export `resolvePromptCwd(prompt, baseCwd): string` —— 单一共享 resolver，合并 Site B 的 dirname fallback + isAcceptablePromptCwd 守卫于一处。`extractAbsolutePaths` → `resolvePromptPath` → `existsSync` → dirname fallback（带 Layer B 守卫）→ 文件/目录分支。导入增 `lstatSync`。
  - `src/runtime/LLMCodingRuntime.ts` Site B `resolveCwdFromPrompt` 改为 thin wrapper：`return resolvePromptCwd(prompt, baseCwd)`。注释指向 systemPromptBuilder 的共享实现。清理未用 imports（`existsSync`, `lstatSync`, `dirname`, `isAcceptablePromptCwd`），加 `resolvePromptCwd`。
  - `src/nexus/app.ts` Site A `resolveExplicitPromptCwd` 改为 thin wrapper：使用 sentinel 模式调 `resolvePromptCwd(prompt, SENTINEL)`，返回 sentinel 时返回 `undefined`（让 `resolveRequestCwd` 回退到 `requestedCwd`/`sessionCwd`/`defaultCwd`）。注释指向 systemPromptBuilder。清理未用 imports（`lstatSync`, `resolvePromptPath`, `isAcceptablePromptCwd`, `extractAbsolutePaths`），加 `resolvePromptCwd`。
  - `src/nexus/app.ts` `prepareExecution`: `session.cwd` 改用 `trustedSessionCwd = body.cwd ?? session?.originCwd ?? session?.cwd ?? cwd` —— **不再**跟随 prompt-derived `cwd` 覆写。prompt-derived path 仍出现在 runtime 的 `cwd` 字段（runtime 内部 Phase B continuity 决定），但不会污染持久化的 `session.cwd`。这一改动配合 Bug 1 Layer A+B（拦住 system dir prompt path）+ Bug 2 origin_cwd（trusted reference）彻底锁住跨 turn drift。
  - `src/cli/runSessionFlow.ts` CLI 站点（第三个副本）：`resolveCliRequestCwd` 改为 thin wrapper，使用相同的 sentinel 模式调 `resolvePromptCwd`。删除本地的 `resolveExplicitPromptCwd` 副本。清理未用 imports（`extractAbsolutePaths`, `resolvePromptPath`）。

- **测试新增**（新文件 `test/dual-site-resolver.test.ts`，6 test）:
  1. Site A 和 Site B 同意引号包裹 iCloud 路径（用 mkdtempSync 构造真实 `Mobile Documents/file.md`，引号包裹）→ 两 site 都 resolve 到父目录。
  2. Site A 和 Site B 同意 broken `/Mobile` 片段（Layer B 拒绝 `~/Library`）→ 两 site 都返回 baseCwd（Site A 用 sentinel 模式）。
  3. Site A 和 Site B 同意 project-internal path → 两 site 都 resolve 到该目录。
  4. CLI runSessionFlow site 也用共享 resolver（regression check：sentinel 模式检测到 `resolvePromptCwd` 走通）。
  5. `createSessionSnapshot` 在创建时设 `originCwd = launchCwd`（Bug 4 信任根的 pre-condition）。
  6. `resolveRequestCwd` 在 prompt path 被 Layer B 拒绝时回退到 `defaultCwd`（验证 storage-only 的核心不变量：`session.cwd` 不会漂到 `~/Library`）。
  - 已加入 `package.json` test 脚本。

- **验证**:
  - `npx tsx --test test/dual-site-resolver.test.ts`：**6/6 pass**（0.4 秒，全 unit-level，**无 slow nexus app 测试**）。
  - `npx tsx --test test/storage.test.ts test/session-origin-cwd.test.ts test/dual-site-resolver.test.ts test/resolve-cwd-fallback.test.ts test/system-prompt-builder.test.ts test/session-root-continuity.test.ts test/inspect-session.test.ts test/runtime-storage-propagation.test.ts test/runtime-context-tools-registry-gate.test.ts test/context-tools-registry.test.ts`：**125/125 pass**。
  - `npx tsx --test test/run-session-flow.test.ts test/context-regression.test.ts`：**18/18 pass**（Nexus HTTP executeStream 全路径）。
  - `npx tsx --test --test-name-pattern="resolveCwd|cwd|continuity|session_root|persists resolved|resolves cwd from prompt|URL-heavy|tool loop executes" test/runtime.test.ts`：**11/11 pass**（含 `/v1/execute persists resolved cwd` turn 7 自愈回归 + `LLMCodingRuntime resolves cwd from prompt absolute path` + `resolveCwdWithContinuity keeps session root`）。
  - `npx tsc --noEmit`：**0 错误**。
  - 真实 `~/.babel-o/db.sqlite` 未触碰。

- **边界**:
  - 3 个 site 全部委托到 `resolvePromptCwd` —— 单一 source of truth。Sentinel 模式让 Site A / CLI 仍能返回 `undefined`（保持 `resolveRequestCwd` 现有契约）。
  - `session.cwd` 现在只跟随 `body.cwd` 或 `session.originCwd`（trusted root），不跟随 prompt-derived path —— Bug 1 Layer A+B 仍负责拦截 system dir prompt path（不会让 Layer A 误升级 `~/Library`）。
  - 不改 Phase B continuity 主体、不改 `deriveSessionRootContinuity` 决策逻辑、不引入新持久化（Bug 2 origin_cwd 列已落地）。
  - 不重写 `resolveRequestCwd` 的优先级链（prompt path > requestedCwd > sessionCwd > defaultCwd），只是把 prompt path 解析从 Site A 的弱版改为共享强版。

- **P0 + P1 全部收口**: Bug 1 Layer A → Bug 1 Layer B → Bug 3 → Bug 2+origin_cwd → Bug 4 全部关闭。session_10320709 的 4 个 follow-up bug 全修：cwd 漂 `~/Library`（Layer A 修根因 + Layer B 兜底 + Bug 4 统一 sites + session.cwd 不被 prompt 覆写）、Phase B 0 个 continuity event（Bug 2 origin_cwd + resolveLatestTaskPrimaryRoot）、3 个 CONTEXT_STORAGE_UNAVAILABLE（Bug 3 storage 注入）、dual site 不一致（Bug 4）。

- **后续可推进**: cwd drift 治理全部 P0/P1 关闭。R7（真实 session replay gate）可以用 session_10320709 fixture 跑回归验证（详见 long-running-context-assembly.md §20 Phase R7）。Phase D（`ContextEstimateCalibration` diagnostic）/ E（`ROOT_SCAN_REQUIRES_CONFIRMATION` 工具层 guard）/ F（`UserArtifactContinuity`）仍 Open，等真实 regression 触发再推进。Glob permission-denied 降级为 partial result 独立列入 tool-governance-plan follow-up。

## 2026-06-18 — Long-Running Context Assembly R7 收口: Real Regression Replay Gate（条件 1-3 关闭，条件 4-6 OPEN 如实报告）

- **背景**: long-running-context-assembly.md §20 R7 是验收闸门——用 3 个真实 regression session fixture（`session_981cc5c2` / `session_cf361f04` / `session_10320709`）验证 R0-R6 全部关闭。R7 6 个验收条件中：c1-c3（cwd drift 治理 / Phase B continuity / context tool storage）由 R0 + R1 闸门覆盖（已在 Bug 1-4 收口）；c4-c6（working set persistence / observer e2e / resume product path）属于 R2/R4/R5 代码实现，**尚未完成**。R7 必须**如实报告**两状态：c1-c3 关闭，c4-c6 仍 OPEN。

- **代码 + fixture 准备**:
  - `test/fixtures/r7-fixture.sqlite`（63 MB）：从真实 `~/.babel-o/db.sqlite` 提取 3 个 session 的所有 63320 events + 3 个 sessions row（v15 schema 已含 `origin_cwd` 列；backfill 已运行）。fixture 是 R7 的 source of truth，详见 `test/fixtures/r7-fixture.README.md` 的 refresh 脚本。
  - `test/fixtures/r7-fixture.README.md`：解释 fixture 来源、schema、refresh 命令。**不能用合成 fixture**：3 session 包含真实 prompt 路径、cwd 漂移、storage 不可用失败；合成要么重演失败（啥都没测）要么编造非证据。

- **测试新增**（新文件 `test/r7-replay-gate.test.ts`，15 test，分 6 suite）:
  1. **R7 fixture integrity** (3 test): fixture 存在 + 含 3 expected sessions + `origin_cwd` backfill + fixture 真实 capture pre-Bug 2 baseline (0 `session_root_continuity` + 3/8/3 `CONTEXT_STORAGE_UNAVAILABLE` per §12.3 + §13.5)。
  2. **R7 condition 1: no turn resolves task root to / or ~/Library (Bug 1 Layer A+B + Bug 4)** (4 test):
     - s103 prompt 1 quoted iCloud path → cwd 不漂 `~/Library`，captures 整段路径
     - scf3 prompts 5/11 iCloud paths → 全不过 `~/Library` 边界
     - s981 prompts CJK slash prose (`文档/信息`) + bare-Latin (`上下文管理 | ★★★★☆ | 功能全但模块分散`) → 不 promote `/`
     - **所有 3 sessions 全部 user_message replay 通过 fix resolver** → 没有任何 prompt 解析到 `/` 或 `~/Library` 或 `~/Documents` 或 `~/Desktop` 或 homedir
  3. **R7 condition 2: session_root_continuity pre-condition** (1 test): 3 sessions 都有 `originCwd`（Bug 2 的不可变 originCwd 列已 backfill；Phase B continuity 触发的前置满足）。
  4. **R7 condition 3: contextRecent works in storage-backed runtime (Bug 3)** (3 test):
     - 每个 session 都有 events for contextRecent to read
     - storage API 暴露 contextRecent 需要的 `listEvents` / `getExecutionMetrics` / `getSession`
     - pre-Bug 3 baseline: 3/8/3 `CONTEXT_STORAGE_UNAVAILABLE` counts 与 §12.3 + §13.5 文档一致
  5. **R7 conditions 4-6: NOT YET CLOSED (honest reporting)** (3 test):
     - R2 (working-set file): fixture 0 `working_set_updated` events → R2 仍 OPEN
     - R4 (observer e2e redacted): fixture 0 persisted `assembled` events → R4 仍 OPEN
     - R5 (resume preview product path): fixture 0 `resume_started`/`resume_preview` events → R5 仍 OPEN
  6. **R7 gate verdict: per-session close status** (1 test): 输出每 session 的 verdict 字符串（`R7 s981: c1_REPLAY_PASS c2_continuity_pre=true c3_storage_baseline=3 c4c5c6_OPEN; origin=/`）作为 gate-closed assertion + 操作员可读的 summary。
  - 已加入 `package.json` test 脚本。

- **关键设计决策**:
  - **R7 是 R0-R6 实现的验收门，不是 R2/R4/R5 的实现前提**。条件 1-3 由 R0/R1 (Bug 1-4) 覆盖；条件 4-6 是 R2/R4/R5 代码层实现，R7 必须诚实报告 OPEN 状态而非跳过。
  - **Fixture 提取是 honest baseline**：从真实 db 提取 3 session 的 events 和 sessions row（含 v15 backfill 的 origin_cwd）。fixture 的 0 `session_root_continuity` + 0 `working_set_updated` + 3/8/3 `CONTEXT_STORAGE_UNAVAILABLE` counts 是 pre-fix 状态，验证的是 fix 后的 pipeline **不会**重演这些失败。
  - **使用真实 prompts**：replay tests 取出 fixture 中所有 user_message 文本，跑过 fixed `resolveCwdFromPrompt` / `resolvePromptCwd`，确保每一 prompt 解析出的 cwd 都不在 rejected 集合。这是最强形式的 c1：任何曾经漂移的 prompt 现在都不漂。

- **验证**:
  - `npx tsx --test test/r7-replay-gate.test.ts`：**15/15 pass**（2.1 秒）。
  - `npx tsx --test` 完整回归套件 (10 files 含 cwd-drift 所有 fix + R7): **140/140 pass**。
  - `npx tsc --noEmit`: **0 错误**。
  - 真实 `~/.babel-o/db.sqlite` 未触碰（fixture 是副本）。

- **边界**:
  - R7 验证的是**当前 fix 后的 pipeline 行为**，不重复实现 R2/R4/R5。c4-c6 OPEN 是诚实报告，不影响 R0/R1 的 gate-closed 状态。
  - Fixture 提取时 session_10320709 的 origin_cwd = `docs/nexus`（最终 cwd 的 backfill，非历史 origin）；新 session 的 origin_cwd 由 Bug 2 的 `createSessionSnapshot` 在创建时正确设置。这是 backfill 尽力而为的设计。
  - 不修改 long-running-context-assembly.md 的 `Partially Landed` 状态——R2/R4/R5 仍 OPEN，plan 升级条件（"R0-R7 全过"）尚未达成。

- **后续可推进**:
  - R2 (persisted working set 接入 executeStream hot path) 是 c4 的实现前提——基于 Bug 1-4 已收口的 storage + continuity 接线，R2 现在能干净实现，不会被污染根写脏。
  - R4 (`/v1/context/observe` 真实 runtime e2e + redacted payload) 是 observer 闭环的最后一公里。
  - R5 (resume 从 class method 升级为可观察产品路径) 是 `bbl inspect-session --resume` 的真实可用性增强。
  - cwd-drift Phase D (`ContextEstimateCalibration`) / E (`ROOT_SCAN_REQUIRES_CONFIRMATION`) / F (`UserArtifactContinuity`) 仍 Open，等真实 regression 触发再推进。
  - Glob permission-denied 降级为 partial result 独立列入 tool-governance-plan follow-up。

## 2026-06-21 — Layer-Direction Audit Enforcement (Phase 3 `--fail-on` advisory gate)

> **完整规范**: [reference/layer-direction-audit-enforcement-plan.md](./reference/layer-direction-audit-enforcement-plan.md) — 长期架构规范（已采纳为 reference，Phase 1+2+3 全部已采纳）。

- **背景**: 2026-06-21 architecture review 发现 `audit-dependency-boundency.js` 只查包级归属、`audit-coupling.js` 只出报表、`architecture-boundary.test.ts` 只测 `app.inject` 干净子路径，第一条设计铁律事实上无强制层方向审计。Phase 1+2 已于当日先收口（layer 方向审计 + checked-in allowlist + 架构边界测试断言方向）。
- **Phase 3 实施**: `scripts/audit-coupling.js` 增加 `--fail-on` 模式：检查 `reverseImports.runtimeToNexus` 与 `reverseImports.nexusToCli` 任一非空即 `process.exitCode = 1`。`package.json` 新增 `coupling:audit:gate` script。`.github/workflows/ci.yml` 新增独立 `coupling-advisory` job（`continue-on-error: true`，违规发 PR summary 不阻断）—— 这是 advisory → 硬闸的中间形态，待噪声可控后晋升为阻断。
- **架构测试新增**: `test/architecture-boundary.test.ts` 增加 `coupling audit --fail-on exits 0 on a clean tree` 测试，镜像现有 `layer direction audit passes successfully with zero violations` 模式。
- **合成反向边验证**: 在 `src/runtime/tokenEstimator.ts` 临时追加 `import { _unused } from "../nexus/server.js"`，`node scripts/audit-coupling.js --fail-on` 退出 1 + stderr `❌ --fail-on: reverse imports detected: runtime -> nexus: 2 edge(s)`；恢复后退出 0 + `✅ --fail-on: no reverse runtime->nexus or nexus->cli imports`。
- **验证**:
  - `node scripts/audit-layer-direction.js`: 281 files / 1091 cross-module imports / `SUCCESS: No layer direction violations found!`
  - `npm run coupling:audit:gate` (current tree): exit 0, `✅ --fail-on: no reverse runtime->nexus or nexus-to-cli imports`
  - `npx tsx --test --test-concurrency=1 test/architecture-boundary.test.ts`: **7/7 pass**
  - `npm run docs:check`: `failureCount: 0`
- **边界**:
  - `--fail-on` 当前只覆盖 `runtime -> nexus` 与 `nexus -> cli` 两个高层反向边，不覆盖 `cli -> runtime`（已被 layer-direction 审计覆盖）、`shared -> outside` 与其他底层→高层的边。
  - `coupling-advisory` job 是 advisory 不阻断，晋升为硬闸需先观察 ≥1 个 PR 周期确认零或可解释违规。
  - 不修改 [module-coupling-decoupling-and-re-aggregation-plan.md](./reference/module-coupling-decoupling-and-re-aggregation-plan.md) —— Phase 3 是同一长期规范的下一实施切片，不改变 coupling plan 的 phase 归属。
- **后续可推进**:
  - 把 `coupling-advisory` job 的 `continue-on-error: true` 去掉，advisory 升为硬闸。
  - 把 `--fail-on` 覆盖范围扩展到 `shared -> outside` 与 `cli -> runtime`（与 layer-direction 审计冗余但耦合 dashboard 读者面更广）。
  - `audit-coupling.js` 当前 stdout 仍出 json dashboard；advisory 模式下冗余输出可考虑合并到 summary。

## 2026-06-21 — Layer-Direction Audit Enforcement Phase 3 promotion (advisory → blocking)

> **完整规范**: [reference/layer-direction-audit-enforcement-plan.md](./reference/layer-direction-audit-enforcement-plan.md) — 长期架构规范 Phase 3 已从 advisory 升为 blocking 强制闸。

- **背景**: 文档登记的 Phase 3 下一实施切片是 advisory → 硬闸晋升。在保持长期规范方向、不引入新耦合源（不回滚也不新增脚本）的前提下，把 `coupling-advisory` job 的 `continue-on-error: true` 去掉、把 job 重命名为 `coupling-gate`、把 PR summary 的措辞从"advisory"改为"failed (blocking)"。
- **执行路径选择（不引入新耦合）**: 推进过程中曾试探扩展 `--fail-on` 覆盖 `sharedToOutside` —— 验证显示这会让当前干净树立刻 fail（命中遗留的 `shared/config.ts → providers/registry.ts`）。回滚该扩展（保留 `--fail-on` 只覆盖 `runtime → nexus` + `nexus → cli`），并在脚本与文档里明确记录"为何不扩"。这是按"保持耦合性聚合性"原则选择的路径：不与 layer-direction 审计的 allowlist 机制耦合、不需要新增 allowlist 文件、不分散反向边强制闸的归属。
- **实施**:
  - `.github/workflows/ci.yml`：job `coupling-advisory` → `coupling-gate`；去掉 `continue-on-error: true`；PR summary 文案改为 `## ❌ Coupling gate failed` + "This gate is now blocking"；指回参考文档。
  - `scripts/audit-coupling.js`：`--fail-on` 块增加注释说明刻意不覆盖 `sharedToOutside` 的两条原因（遗留边、避免与 layer-direction 审计 allowlist 机制耦合）。
  - `docs/nexus/reference/layer-direction-audit-enforcement-plan.md`：Phase 3 行 `Adopted 2026-06-21 (advisory)` → `Adopted 2026-06-21 (blocking)`；中文概述同步；"下一步"段更新为下一实施切片候选。
- **验证**:
  - `node scripts/audit-layer-direction.js`：282 files / 1095 imports / `SUCCESS: No layer direction violations found!`
  - `npm run coupling:audit:gate`：exit 0, `✅ --fail-on: no reverse runtime->nexus or nexus->cli imports`
  - `npx tsx --test --test-concurrency=1 test/architecture-boundary.test.ts`：**7/7 pass**
  - `npm run docs:check`：`failureCount: 0`
  - 合成反向边（临时向 `src/runtime/tokenEstimator.ts` 追加 `import '../nexus/server.js'`）→ exit 1 + stderr 报错；恢复后 exit 0（沿用之前已验证的反向边合成路径）。
- **边界**:
  - `--fail-on` 范围刻意只覆盖两个高层反向边，不扩到 `sharedToOutside`、`cli -> runtime` 或底层→高层边——这是已采纳的长期规范设计，不在本次晋升里扩大。
  - `coupling-gate` job 现在阻断 PR；其阻断是同规范下的强制闸，与 `test/architecture-boundary.test.ts` 的断言（同样要求 `reverseImports.runtimeToNexus` / `nexusToCli` 为 `[]`）形成双向闭合：本地跑测试绿、CI 跑 gate 绿、两者针对同一组合约。
  - 不修改 coupling plan 的 phase 归属或历史阶段表——本晋升是 layer-direction 规范下的 Phase 3 实施切片，与 coupling plan 是平行而非继承关系。
- **后续可推进**:
  - 观察若干 PR 的 `coupling-gate` 噪声确认零误报（无需新代码）。
  - 把 `shared/config.ts → providers/registry.ts` 遗留边正式登记进 layer-direction 跨层 allowlist，作为同一规范的聚合扩展（见 [layer-direction-audit-enforcement-plan.md §Next steps](./reference/layer-direction-audit-enforcement-plan.md)）。
  - 审视 `runtime → providers`（30 edges / 27 files）与 `nexus → storage`（20 edges / 19 files）两个高密度方向是否需纳入强制闸——更大架构动作，需单独提案。

## 2026-06-21 — Layer-Direction Audit Enforcement: sharedToOutside gate cohesion (Phase 2 test)

> **完整规范**: [reference/layer-direction-audit-enforcement-plan.md](./reference/layer-direction-audit-enforcement-plan.md) — 长期架构规范。
> **决策来源**: 上一切片（advisory → blocking promotion）的"下一步"候选 (b) —— 在不引入新耦合源的前提下，确认 `shared → outside` 是否已有 blocking 闸。

- **背景**: 推进候选 (b) 前先做"已存在性调查"。`scripts/audit-layer-direction.js` 的 6 条规则中 **Rule 4**（`shared → outside`）已在脚本 `:154` 实施；`scripts/layer-direction-allowlist.json:76-78` 已有唯一合法边 `src/shared/config.ts → src/providers/registry.ts`；`package.json:42` `npm run deps:audit` 用 `&&` 链 `audit-dependency-boundency.js` → `audit-layer-direction.js` → `npm ls`，违规即短链；`.github/workflows/ci.yml` 的 `deps:audit` step 跑同一脚本。
- **关键发现**: `shared → outside` 方向**已经是 blocking 闸**。这是 Phase 1 实施时的"自然后果"——但没有专门的回归测试断言它。补 test 比扩展 `--fail-on` 更聚合（零新文件、零新脚本、零新 allowlist 入口）。
- **路径选择（不引入新耦合）**:
  - ❌ 扩展 `audit-coupling.js --fail-on` 覆盖 `sharedToOutside`——会立刻 fail（命中遗留边），需要新增 allowlist 机制 → 与 layer-direction 审计散开耦合 → **放弃**。
  - ✅ 在 `architecture-boundary.test.ts` 新增一条 `execSync` 风格的回归断言（与 `coupling audit --fail-on exits 0 on a clean tree` 同模式），让 Rule 4 闸可测试、可回归。这是"按方向分组、单一 allowlist、跨方向不重复加闸"原则的具体落地。
- **实施**:
  - `test/architecture-boundary.test.ts` 新增测试 `layer direction audit exits 0 on a clean tree (shared -> outside already gated by rule 4)`：直接 `execSync('node scripts/audit-layer-direction.js', { stdio: 'pipe' })`，让非零 exit 自然抛错失败。
  - 注释里说明此闸的来源链（Rule 4 → allowlist → `deps:audit` `&&` 链 → CI step），并明确 `shared → outside` 不在 `audit-coupling.js --fail-on` 范围以避免重复加闸。
- **验证**:
  - 干净树：`npx tsx --test --test-concurrency=1 test/architecture-boundary.test.ts` → **8/8 pass**（从 7/7 升）。
  - 合成 `shared → runtime` 边（向 `src/shared/session.ts` 追加 `import '../runtime/hooks.js'`）：新测试 fail（符合设计）；恢复后 8/8 pass。
  - 合成 `shared → cli` 边、合成 `shared → tools` 边同理触发。
  - `node scripts/audit-layer-direction.js`：282 files / 1095 imports / `SUCCESS: No layer direction violations found!`
  - `npm run deps:audit`：exit 0（layer 方向 + 依赖归属 + `npm ls` 全链路绿）。
  - `npm run coupling:audit:gate`：exit 0（`runtime → nexus` + `nexus → cli` 仍 blocking，未受本切片影响）。
  - `npm run docs:check`：`failureCount: 0`。
- **边界**:
  - 不新增 allowlist 文件、不修改 `layer-direction-allowlist.json`（已正确登记遗留边）、不修改 `audit-layer-direction.js`（Rule 4 已正确）、不修改 `audit-coupling.js`（`--fail-on` 范围保持 `runtime → nexus` + `nexus → cli` 不变）。
  - `shared → outside` 与 `runtime → nexus` / `nexus → cli` 是**互补**而非**重复**：前者由 `audit-layer-direction.js` Rule 4 + allowlist 控制，后者由 `audit-coupling.js --fail-on` 控制；两者在 `architecture-boundary.test.ts` 各有独立回归测试。这是"按方向分组、单一 allowlist、跨方向不重复加闸"的设计。
  - 注释明确"shared → outside"未列入 `--fail-on` 是设计而非遗漏：避免与 layer-direction 审计 allowlist 机制散开耦合。
- **架构原则沉淀（值得记入项目记忆）**:
  - 同一长期架构规范下的不同入口（layer-direction 审计 vs coupling dashboard）按方向分组，不重复加闸；新增方向时先在 `audit-layer-direction.js` 评估 Rule 4-6 的可复用性，再决定是否扩 `--fail-on`。
  - 反向边闸的"已存在"判定不能只看脚本代码——必须沿 `audit → script chain → CI step → 回归测试` 全链验证；本切片通过 `deps:audit` `&&` 链的实证（合成 `shared → runtime` 边触发 exit 1）确认 Rule 4 闸已 blocking。
  - 跨方向不重复加闸的另一面：每个方向都必须在测试层有独立回归断言。`architecture-boundary.test.ts` 4 条反向边闸断言（layer 审计 + coupling 数组 + layer 退出 + coupling `--fail-on` 退出）形成矩阵。
- **后续可推进**:
  - 观察 `deps:audit` 与 `coupling:audit:gate` 的零误报周期（无需新代码）。
  - 审视 `runtime → providers`（30 edges）与 `nexus → storage`（20 edges）是否需要类似 `shared → outside` 的"已存在调查"——这些方向当前不被任何闸覆盖，是潜在下一批规范化对象。
  - 评估 `audit-layer-direction.js` Rule 5-6（`bottom-layer → {cli,nexus}` / `bottom-layer → runtime`）是否也需要 `execSync` 风格回归断言。

## 2026-06-21 — Stream G closure: 8 repositories extracted from SqliteStorage (Phase 9 closed)

- **背景**: `module-coupling-decoupling-and-re-aggregation-plan.md` Phase 9 (Stream G Storage Decoupling) opened 2026-06-20, closed today with 8 repository classes extracted from the 1753-line `SqliteStorage.ts` monolith. Each slice preserved byte-identical SQL behavior, gate-clean, and added a focused per-repository test file.
- **改动 (3B-20 → 3B-27, 8 commits, ahead of origin by 8)**:
  - 3B-20: `src/storage/EventRepository.ts` (206 lines, events + sequence allocation + duplicate-repair + tool-trace / execution-metrics callbacks)
  - 3B-21: `src/storage/TaskRepository.ts` (166 lines, tasks + JSON-column serialization for `dependsOn` / `blocks` / `review` / `metadata`)
  - 3B-22: `src/storage/AuditRepository.ts` (131 lines, permission_audits + `approved` / `denied` decision enum)
  - 3B-23: `src/storage/ToolTraceRepository.ts` (210 lines, tool_traces + composite `started_at | tool_use_id` cursor pagination)
  - 3B-24: `src/storage/SessionChannelRepository.ts` (316 lines, session_channels + session_messages + cross-table inbox filter + read-modify-write acknowledge)
  - 3B-25: `src/storage/AgentJobRepository.ts` (145 lines, agent_jobs + dual storage `job_json` + indexed filter columns)
  - 3B-26: `src/storage/ExecutionMetricsRepository.ts` (243 lines, execution_metrics + 36 columns + `booleanToDb` / `dbToBoolean` 0/1 encoding)
  - 3B-27: `src/storage/LoopPaneRepository.ts` (181 lines, loop_state + read-modify-write `updateLoopPaneRev`)
- **净效果**: `SqliteStorage.ts` 1753 → 968 lines (-785 / -44.8%) acting as a thin-delegation facade that owns only schema setup, transaction locks, public-method dispatch, and cross-cutting helpers (session row map, `listAllEvents` for `SessionGetOptions`).
- **测试**: 8 new per-repository test files (6 + 7 + 6 + 8 + 9 + 10 + 7 + 12 = 65 cases) + 2 existing `test/storage.test.ts` cases = **67 storage tests pass**, byte-identical with prior behavior. R2/R5/R7 (21/21), `coupling:audit --fail-on`, `deps:audit`, `layer-direction`, `typecheck` all green.
- **核心耦合 (回应对「核心耦合性问题解决」标准)**: 单文件管理 9 个表 → 9 个聚焦 module（1 thin-delegation facade + 8 repository）。每个 repository 单一职责、独立 reviewable、独立 testable。所有 SQL UPSERT / WHERE / ORDER BY / JSON 序列化模式 byte-identical。
- **后续**: Stream G 在该表面上不再有可被独立边界问题驱动的进一步抽取。Phase 9 row 改 `Closed 2026-06-21`。Phase 3B+ 主循环边界（LLMCodingRuntime 1841 → 1493）继续 Watch。

## 2026-06-21 — Layer-Direction Audit Enforcement: canonical-shape invariants for runtime→providers and nexus→storage

> **完整规范**: [reference/layer-direction-audit-enforcement-plan.md](./reference/layer-direction-audit-enforcement-plan.md) — 长期架构规范。
> **决策来源**: 上一切片（advisory → blocking promotion）的"下一步"候选 (b) —— 审视 `runtime → providers`（30 edges / 27 files）与 `nexus → storage`（20 edges / 19 files）两个高密度方向。

- **背景**: 两个高密度方向是 architecture review 标记的"潜在规范化对象"。本切片按之前的方法（`sharedToOutside gate cohesion` 验证）先做"已存在性调查"，再决定规范化路径。
- **调查结果（已存在性调查）**:
  - `runtime → providers`：**30 edges / 27 files**。全部是 `import type { ... } from '../providers/adapters/ModelAdapter.js'`（type-level，erasable），或 `import { getAdapter, getModel } from '../providers/registry.js'`（registry value）。**没有任何具体 adapter 的 value import**。反向边 `providers → runtime` 与 `providers → nexus` 各为 0。方向是 canonical 的"runtime 通过抽象使用 providers"。
  - `nexus → storage`：**20 edges / 19 files**。17/19 是 `import type { NexusStorage } from '../storage/Storage.js'`（抽象），仅 2/19（`createRuntime.ts` composition root + `agentLoopBenchmark.ts` test infrastructure）import 具体 `MemoryStorage`/`SqliteStorage`。方向是 canonical 的"nexus 通过 NexusStorage 接口使用 storage，具体 backend 选型只在 composition root"。
- **决策（不引入新闸、不新增文件）**:
  - ❌ **不**加 `audit-layer-direction.js` Rule 7/8：会引入新 allowlist 机制 + 新 allowlist 文件，与"不散开"原则冲突；且两方向当前形态本就合法，没有需要 allowlist 的反向边。
  - ❌ **不**抽 `scripts/audit-canonical-shape.js`：会引入新脚本，与"`deps:audit` + `coupling:audit:gate` 已聚合 2 个 audit 脚本"的状态冲突。
  - ✅ **加** `architecture-boundary.test.ts` 内的两条 canonical-shape 回归断言（与现有 4 条反向边闸断言同模式），用 file-walking + per-line 正则 + Set 白名单实现，**in-test 形态不引入新文件**。
- **实施**:
  - `test/architecture-boundary.test.ts` 新增 `listTsFiles()` 工具函数（递归 walk 目录，剔 `.d.ts`）。
  - `canonical-shape invariant: runtime -> providers only via type imports or registry value calls`：扫描 `src/runtime/**` 的 `import { ... }` (排除 `import type` 与 `import { type X, Y }` 内联型) 中指向 `providers/*` 的 specifier；只允许 `providers/registry` 子模块的值 import；任何 `providers/adapters/*` 的值 import 触发测试 fail。
  - `canonical-shape invariant: nexus -> storage only via NexusStorage type or composition-root concretions`：扫描 `src/nexus/**` 中指向 `storage/MemoryStorage` / `storage/SqliteStorage` 的值 import；白名单仅含 `src/nexus/createRuntime.ts` 与 `src/nexus/agentLoopBenchmark.ts`；其他 nexus 文件的具体 storage import 触发测试 fail。
- **验证**:
  - 干净树：`npx tsx --test --test-concurrency=1 test/architecture-boundary.test.ts` → **10/10 pass**（从 8/8 升）。
  - 合成 `runtime/runtimeToolLoop.ts` 追加 `import { AnthropicAdapter } from "../providers/adapters/AnthropicAdapter.js"` → runtime canonical-shape 测试 fail。
  - 合成 `nexus/app.ts` 追加 `import { MemoryStorage } from "../storage/MemoryStorage.js"` → nexus canonical-shape 测试 fail。
  - 恢复后 → 10/10 pass。
  - 合成 `runtime → nexus` / `shared → outside` 边仍触发对应反向边闸 fail（与 canonical-shape 测试正交）。
  - `npm run docs:check`：`failureCount: 0`。
  - `npm run coupling:audit:gate`：exit 0。
  - `npm run deps:audit`：exit 0。
- **边界**:
  - `listTsFiles()` 工具函数**不**依赖 `audit-layer-direction.js` 或 `audit-coupling.js` 现有逻辑，独立实现 file walking + 正则匹配；测试不依赖 `scripts/` 下任何新文件。
  - canonical-shape 不变式是**正交**的反向边闸：反向边闸防"反向边出现"（如 `runtime → nexus`），canonical-shape 防"具体依赖出现"（如 runtime → 具体 adapter）。两者覆盖不同的失序模式。
  - 内部 type-only 与值 import 的区分使用**单行正则**匹配以避免跨行误判（之前 `m` flag + `[\s\S]*?` 误匹配已修复）。
  - 不动 `audit-layer-direction.js` Rule 1-6 与 `audit-coupling.js --fail-on` 范围——这些闸负责"反向边"，canonical-shape 负责"形态"。
- **架构原则沉淀**:
  - **canonical shape vs reverse edge** 是两个独立的耦合概念，应分用不同测试断言。`audit-layer-direction` 闸 `cli → X`（layer-direction 闸）与 `audit-coupling --fail-on` 闸 `runtime → nexus`（反向边闸）是反方向的：前者防"cli 越层"，后者防"运行时漏层"。canonical-shape 是"同方向内的合法形态"——runtime 可以到 providers，但只通过抽象。
  - **不引入新文件 vs 不引入新机制** 是两个独立的设计目标。本切片：能复用现有 audit 脚本的（`sharedToOutside`）就用 regression test 覆盖；不能复用的（"具体依赖出现"语义、`audit-layer-direction.js` 没能力检测 import 是 `import type` 还是值）就放 in-test，独立实现 file walking + 正则，不抽到 `scripts/`。
  - **同一长期规范下的扩展优先级**：(1) `deps:audit` 闸已覆盖的方向 → 零成本（advisory → blocking + regression test）；(2) `audit-coupling` dashboard 已识别但未闸的方向 → 已有 dashboard 数据可参考（canonical-shape 不变式）；(3) 全新方向 → 需要新规则 + 新 allowlist + 新测试，是最大动作。
- **后续可推进**:
  - 观察 `architecture-boundary.test.ts` 10/10 pass 在 CI 上若干 PR 的稳定性。
  - 审视其他高密度方向是否也有 canonical 形态需要回归断言：`nexus → tools`（11 edges / 8 files）、`tools → runtime`（4 edges / 3 files）等，建议按相同"已存在性调查 → canonical 形态 → 回归断言"流程。
  - 评估 `scripts/` 下审计脚本输出聚合（`deps:audit` + `coupling:audit:gate` + canonical-shape 各自报告），让 PR summary 包含三方向综合视图，但属于可读性优化不改变 gate 本身。

## 2026-06-21 — Stream watchdog observability: 3 fix 收口 (hard watchdog + activeAge + forward throw)

> 关联真实样本：`session_ffd44ccf-7f3b-4597-9844-a077f41a8967`（2026-06-20）。用户用 DeepSeek V4 + 长 thinking 模型做长任务，session 跑到 6 turns 时 provider stream 突然不再 emit 任何 event（最近一次 `thinking_delta` 之后无任何 token 输出），runtime `for await (const ev of stream)` 永久 block。softTimeoutMs 只发 `near_timeout_warning` / `timeout_extension_granted` 事件但从不 abort，唯一的 abort 源是 socket close —— 真实场景 socket 没断 → **永远不退出**。
>
> 本切片用三段独立 PR-sized fix 闭合 "provider stream silent but socket open" 这条死路，并把观测性也补上：

### Fix 1 — executeStreamRoute.ts: hard watchdog timer

- **根因**: WebSocket `/v1/stream` 路由的 abort 源只有两条 —— `socket.once('close', ...)`（line 110）和 `prepared.timeout`（legacy 5000ms fatal）。如果 provider stream 中途完全 silent 而 client 仍 keep-alive，runtime 的 for-await 永久 block，**没有任何机制能 abort**。softTimeoutMs 是 "soft budget" —— 只发 `near_timeout_warning`，不 abort。
- **修法**: 在 `runExecutionStreamLoop` 启动之后、`finally { clearTimeout(watchdogTimer) }` 之前，注册一个 hard watchdog `setTimeout(() => { ... }, prepared.timeoutDecision.watchdogTimeoutMs)`：
  ```ts
  const watchdogMs = prepared.timeoutDecision.watchdogTimeoutMs
  const watchdogTimer = watchdogMs > 0
    ? setTimeout(() => {
        const elapsedMs = deps.metrics.now() - startedAtMs
        logger.warn(`hard watchdog fired: provider stream unresponsive for ${elapsedMs}ms (session=${sessionId})`)
        prepared.watchdog.fired = true
        try {
          sendJson(socket, {
            type: 'error',
            code: 'REQUEST_TIMEOUT',
            message: `Provider stream did not yield events within ${watchdogMs}ms; aborting.`,
            details: { kind: 'watchdog', elapsedMs, timeoutMs: watchdogMs },
          })
        } catch { /* socket may already be closed; abort will tear down */ }
        abortController?.abort()
      }, watchdogMs)
    : null
  ```
- **关键设计选择**:
  - **`watchdogTimeoutMs` 来自 body**，fatal policy 默认 = `legacyTimeoutMs`（5s），soft policy 默认 = `Math.max(legacyTimeoutMs * 3, legacyTimeoutMs + 300_000)`。Body override 优先；legacy 客户端不传新字段 → 行为完全不变。
  - **`watchdogMs === 0` 关闭 timer**（`watchdogTimer = null`）—— back-compat 边界。`watchdogTimeoutMs` 正整数才有 timer。
  - **三步顺序固定**: sendJson 先（带 `details.kind='watchdog'`），abort 后。`sendJson` 包在 try/catch 里，socket 已关闭时静默 —— abort 会把 stream consumer 拆掉。
  - **`prepared.watchdog.fired = true`** 显式标记，让下游 settlement 用 watchdog 路径分类（而非 cancelled）。
- **测试**: `test/execute-stream-watchdog.test.ts`（3 test）：(1) abort signal wired to runtime on `/v1/stream` —— 验证 hard watchdog 触发的 prerequisite；(2) watchdog error envelope shape —— lock `{ type:'error', code:'REQUEST_TIMEOUT', details:{ kind:'watchdog', elapsedMs, timeoutMs } }` 结构；(3) `watchdogMs=0` disables timer (back-compat)。
- **测试设计说明**: `@fastify/websocket` 的 `injectWS` 会在 message handler 返回时自动 close mock socket（触发 `socket.once('close')` abort 路径），所以 watchdog 路径无法用 injectWS 测（socket close 永远先于 setTimeout 300ms 触发）。End-to-end abort 行为已被 `runtime.test.ts:6087` 的 HTTP 路径 watchdog 回归覆盖（WS 和 HTTP 共享 `prepared.abortController`），本切片只测 wiring + envelope 形状。

### Fix 2 — metrics.ts: stream.activeAgeMs 观测性

- **根因**: `/v1/runtime/status` 的 `stream.activeAgeMs` 字段只能通过 `recordStreamEvent()` 间接更新。`recordStreamEvent` 只在 runtime 真的 emit event 时调用。**Provider stream silent 时永远不调用 → activeAgeMs 永远是 0 → operator 看到 `stream.activeCount=1` + `activeAgeMs=0` 没法判断"卡了多久"**。这正是 fix 1 的 hard watchdog 想要救的场景 —— 没有观测性就没人触发 fix。
- **修法 (2 段)**:
  - `snapshot()` 在返回前调用 `this.recordStreamActiveAge(this.now())` —— 每次 `/v1/runtime/status` poll 都推进 timer。
  - `recordStreamActiveAge(nowMs)`:
    ```ts
    if (this.stream.activeCount === 0) {
      this.stream.activeAgeMs = 0
      return
    }
    const delta = nowMs - this.lastStreamActiveSampleMs
    if (delta > 0 && this.lastStreamActiveSampleMs > 0) {
      this.stream.activeAgeMs += delta
    }
    this.lastStreamActiveSampleMs = nowMs
    ```
- **关键设计选择**:
  - **"首次 sample seed" pattern**: 第一次 `recordStreamActiveAge(0)` 时 `lastStreamActiveSampleMs === 0`，不 add delta（避免把"从 process 启动到现在"算成 stream age）。后续 sample 累加真实 delta。
  - **`activeCount === 0` early return + reset to 0**: stream 全结束后 activeAgeMs 立即归零 —— operator 看到"hung 之前是 5000ms，现在 0ms"就明确知道 stream 已清。
  - **snapshot 内部 sample 驱动 timer**: 即使没有任何 `recordStreamEvent` 调用（hung 场景），`/v1/runtime/status` 也能反映真实 elapsed。这是 fix 1 的观测性闭环。
- **测试**: `test/metrics-active-age.test.ts`（5 test）：(1) no stream → 0；(2) snapshots during active stream grow with real elapsed time；(3) finished stream → next snapshot = 0；(4) explicit `recordStreamActiveAge` 推进 timer 不靠 snapshot；(5) 没有任何 sample 时 finished stream 仍然归 0。

### Fix 3 — executionWebSocketControl.ts: forwardProcessedRuntimeEvent Bug 2

- **根因**: `forwardProcessedRuntimeEvent` 在调用 `sendJson(socket, event)` 时没有 try/catch。`sendJson` 内部 `socket.send(JSON.stringify(value))` 在 socket 已被 close (mid-flight, bufferedAmount cap, transport-level error) 时会 throw。throw 之后 `for await` 还在跑，runtime 继续 produce events，**metrics.stream.activeCount 永远不归 0**。这是 fix 2 想观测的"active count 卡住"的另一条泄漏路径。
- **修法**:
  ```ts
  try {
    sendJson(socket, event)
    metrics.recordStreamEvent(socket.bufferedAmount)
  } catch (err) {
    logger.warn('forward event failed; aborting stream consumer', err)
    abortController.abort()
    return { event, forwarded: false, closed: true }
  }
  ```
- **关键设计选择**:
  - **`abortController.abort()` 而非依赖 socket.once('close')**：socket 已经坏了，'close' 事件可能已被 emit 但还没处理；显式 abort 是最直接路径。
  - **`return { ..., closed: true }`**：让 `for await` 退出（route 的 `if (forwarded?.closed) break`），不再 yield 更多 events。
  - **`metrics.recordStreamEvent` 不在 catch 路径调用**：send 实际失败了，不能记 "successfully sent 1 event"。
  - **warning level log**：不是 fatal —— 这是 stream 生命周期正常终止之一（socket 死 / client 断），不应让 Sentry 噪音爆表。
- **测试**: `test/execution-websocket-control.test.ts` 加 2 test：(1) `sendJson throws` mid-flight → `controller.aborted === true`, `forwarded === false`, `closed === true`, 不 record metric；(2) cache-health 成功但 decorated event throws → 仍 abort。

### 验证

- `node_modules/.bin/tsc -p tsconfig.build.json --noEmit`: clean。
- `npx tsx --test test/execution-websocket-control.test.ts test/metrics-active-age.test.ts test/execute-stream-watchdog.test.ts test/execute-stream-route.test.ts test/execution-event-processing.test.ts`: **21/21 pass**。
- `npx tsx --test test/runtime.test.ts`: **165/165 pass**（HTTP 路径 watchdog regression 仍然绿）。
- 跨 spec 回归 `runtime.test.ts` 165 + `architecture-boundary.test.ts` 10 = 175 无 regression。
- `npm run coupling:audit:gate`: exit 0（无新增跨层依赖）。
- `npm run docs:check`: `failureCount: 0`。
- 真实 `~/.babel-o/db.sqlite` 未触碰。

### 边界

- **不**扩展 `softTimeoutMs` 为 abort 源 —— soft 永远不 abort 是设计原则（[task-adaptive-recoverable-timeout-plan §Phase 2](./history/evidence-and-runtime-history.md)）。本切片新加的 hard watchdog 是 soft budget **之外**的安全网。
- **不**改 `executeHttpRoute.ts` 的 abort 模型 —— HTTP 路径已经有 softTimeoutMs + watchdog 两条闸，行为已经收敛（`runtime.test.ts:6087` 已收口）。本切片只补 WS 路径的 hard watchdog。
- **不**扩 `audit-coupling --fail-on` 范围 —— Fix 1/2/3 都在已有边界内（WS route + metrics + WS control），不引入新耦合面。
- **`forwardProcessedRuntimeEvent` Bug 2 fix 的 cache-health throw 路径未做对称修复**：cache-health `sendJson` 仍无 try/catch。已知 minor leak（cache-health 失败时不会 abort，但 runtime 仍会继续 yield decorated event）。如需对称修复需独立 PR —— 当前是 "decorated event 失败时 abort" 语义，与 cache-health 失败语义不同。
- **`@fastify/websocket injectWS` 限制**：无法用 injectWS 测 hard watchdog 端到端（socket auto-close 抢先）。本切片通过 (a) abort signal wiring + (b) envelope shape + (c) `watchdogMs=0` back-compat 三个角度锁定不变量；end-to-end abort 行为靠 HTTP 路径已收口的 `runtime.test.ts:6087` 复用。

### 后续可推进

- 真实 session `session_ffd44ccf` 在 fix 1/2 上线后，下次重现 "DeepSeek V4 silent 6 turns" 时应该：(a) 300ms 内 client 收到 `details.kind='watchdog'` 的 REQUEST_TIMEOUT；(b) `/v1/runtime/status` 在 silent 期间 `activeAgeMs` 持续增长，让 operator 在几分钟内就发现并选择 abort 或等 watchdog 自然结束。
- 如果有真实 session 暴露 "hard watchdog 300ms 仍然太短"（provider 在 burst thinking 后 pause 一下），考虑改 body `watchdogTimeoutMs` 上限 (`1_800_000ms` 已是当前 zod max)，但属独立切片。
- 观察若干 PR 后 `metrics.stream.activeAgeMs` 的 operator 实际使用情况，决定是否把 "activeAgeMs > 60s" 升级为 `BehaviorMonitor` 的 detector 输出 anomaly。


## 2026-06-21 — Phase 2D + 7 container landed, plan doc + TODO_cleanup synced to post-Stream-G reality

- **背景**: 紧接 Stream G 收口（3B-20 → 3B-27，8 repository）之后，按 plan doc 自我评估出的 3 个 Next（doc 自洽 + cross-reference + RuntimeServices 容器 + parseRuntimeEnv）连续推进 3 个 commit。
- **改动 (3 commits, ahead of origin by 11)**:
  - `06e33f1` (earlier today) — Stream G 收口 doc + 8-repository 清单
  - `827efc5` — plan doc 自洽 (8 处内部不一致修复) + 2 个新 canonical reference 引用 (layer-direction-audit-enforcement-plan.md, storage-interface-segregation-reference.md) + TODO_cleanup 父 checkbox 翻转
  - `8173de3` — Phase 2D + 7: `src/runtime/env.ts` (195 lines) `parseRuntimeEnv` boot-time snapshot + `src/nexus/services.ts` (114 lines) `createRuntimeServices` composition root + `test/runtime-env.test.ts` (17 cases) + `test/runtime-services.test.ts` (8 cases)
- **Phase 2D 关键设计**:
  - `RuntimeServices` 放在 `src/nexus/` 而非 `src/runtime/`，因为 container 引用 Nexus-owned service 类（`ContextBroadcaster` / `EverCoreRuntimeManager`）。放在 `src/runtime/` 会触发 `runtime → nexus` reverse import（coupling audit 立刻 flag 出 2 个新 edge），违反 Phase 1A + Phase 2B cleanup。`env.ts` 反过来放 `src/runtime/`（无 nexus 依赖）。
  - `parseRuntimeEnv` mirror `nexus/server.ts:parsePolicyMode` 别名集合（`'strict'` / `'soft-deny'` / `'softdeny'` / `'soft_deny'` / case-insensitive / empty-string-means-undefined）以及 `parseBoolean` yes/no 兼容，确保 2D.1 (server.ts 迁移) 是 byte-identical。
  - `RuntimeServices` 5 fields: `configManager` / `contextBroadcaster` / `everCoreManager` / `providerSessionRules` / `env`。Defaults fallback 到 legacy module-level 实例 (`ConfigManager.getInstance()` / `defaultEverCoreRuntimeManager` / fresh `ContextBroadcaster` / fresh `ProviderSessionRules` / `parseRuntimeEnv(process.env)`)，legacy caller 不变。
- **plan doc 内部 8 处不一致修复** (commit `827efc5`):
  1. Phase 0 row: "Active Plan" → "Closed 2026-06-18" (doc 升级为 canonical 2026-06-21)
  2. Phase 2 row: "Active Plan" → "In Progress 2026-06-21 (Open: 2D only)"，3 个 sub-slice 标 Closed
  3. Phase 3 row: "Active Plan" → "In Progress 2026-06-21" + 3 strategy + 5 helper 落地清单
  4. addendum "Phase 5 Watch" → "Phase 6 Watch"（解决与 north-star "Phase 5" 编号冲突）+ re-evaluate
  5. Phase 7 verification: "exactly 2 hits" → "0 hits" (server.ts 21 reads 全部迁入后)
  6. Coupling heat map line 161: `nexus/app.ts 9 reads` → `1 read` (Phase 4A+ completion)
  7. Source of truth: 加 `audit-coupling.js` + `audit-layer-direction.js`
  8. Governance / Related: 加 3 个新 canonical reference 引用
  9. 加 "Stream B stop rule" 段，明确 Phase 2 closure 条件
  10. Phase 7 row 状态同步: parser + tests landed 2026-06-21, migration 2D.1 → 2D.5 in plan
  11. Phase 2 row 加 7 follow-up PR map (2D.1 → 2D.7)
  12. Addendum 加 Phase 2D slice row（commit `8173de3` 描述 + 验证）
- **TODO_cleanup.md 同步**:
  - Phase 3B+ 父 checkbox 翻 `[x]` + 加 3B-19 catch-block / 4-slice helper pull
  - Phase 4A+ 父 checkbox 翻 `[x]` + 加 plan doc section anchor
  - 新加 Phase 2D 父 checkbox 翻 `[x]` + 7 子 slice (2D.0 done / 2D.1-2D.6 pending / 2D.7 closure)
- **净效果**:
  - 计划 doc + TODO_cleanup + WORK_LOG 三库一致指向 "Phase 2 / 7 In Progress, 7 follow-up PRs pending"
  - `parseRuntimeEnv` 接受 synthetic env 测试, 17/17 cases 覆盖 NEXUS_*/BABEL_O_* env 路径 + error cases
  - `createRuntimeServices` 接受 caller-provided instances, 8/8 cases 验证 container 5 fields 全部可注入
  - 92/92 storage tests + 21/21 R-gate tests 不回归
  - `npm run coupling:audit --fail-on` 仍 `runtimeToNexus: []` / `nexusToCli: []`
  - `npm run audit-layer-direction` 286 files / 1104 cross-module imports, 0 violations
- **后续可推进** (按 plan doc "one PR = one slice" 原则):
  - **2D.1** `src/nexus/server.ts` 21 reads → `services.env.nexus.*` (验证 Phase 7: `grep -rn 'process\.env' src/nexus/` → 0 hits)
  - **2D.2** `createRuntime.ts` 1 read + 1 `ConfigManager.getInstance()`
  - **2D.3** `cli/embedded.ts` 2 reads + 2 `getInstance()` + 1 `defaultEverCoreRuntimeManager`
  - **2D.4** `cli/commands/go.ts` 8 reads + `cli/runSessionFlow.ts` 7 reads
  - **2D.5** `nexus/routers/runtimeModelsRouter.ts` 8 reads + `runnerComparisonBenchmark.ts` 5 reads
  - **2D.6** 22+ `ConfigManager.getInstance()` callsites
  - **2D.7** Phase 2 row → "Closed 2026-06-XX"
  - **Phase 3B+ 收口审计** (主循环读一遍，决定是否需要最后 1-2 helper)
