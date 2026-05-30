# BabeL-O Nexus 工作记录

本文件只记录事实、验证和重要决策。不承载长期规划，长期规划写入各 TODO 文档。

## 2026-05-30 — P1 TUI 无外框 welcome 与 boxed input prompt

- **用户决策**: 去掉 welcome 最外层框，保留 logo/身份信息；主输入框改为上下分隔线、裸 `>` 输入行和底部 `? for shortcuts` + 当前模型状态。
- **处理**:
  - `src/cli/welcome.ts` 移除 welcome header 的 `┌/│/└` 外框与独立快捷 hint，只保留 logo、`❖ BABEL-O`、版本、用户、工作区、模型和运行模式信息。
  - `src/cli/inputBox.ts` 新增 boxed input renderer：顶部/底部 `─` 分隔线、`>` 输入行、footer 左侧快捷提示、右侧当前模型 label；未知模型会从 model id 生成可读名称，registry 内模型优先使用 display name。
  - `src/cli/ui.ts` 只对主 chat prompt 使用 boxed input；二级 readline prompt（editable rule / reject instruction 等）继续使用原单行渲染，并在多行主输入刷新后把光标移回 `>` 行。
  - `src/cli/ui.ts` 记录上一帧文本和光标位置，刷新前按当前终端列宽重算旧输入块的视觉光标行，修复 resize 后旧长分隔线残留/错位。
  - `src/cli/inputBox.ts` 的 boxed separator 使用 `columns - 1` 安全宽度，避免刚好铺满终端宽度时被终端自动折到下一行。
  - `src/cli/ui.ts` 暴露 `clearCurrentInputBlock()` 和 `renderSubmittedPrompt()`；`src/cli/commands/chat.ts` 在提交后按 readline 已换到下一行的真实光标位置清理整个 boxed input，再用紫色文本渲染用户消息，避免上分隔线、输入框 chrome 或 placeholder tail 残留到 agent 输出前。
  - `src/cli/commands/chat.ts` 的首字符 ghost 清理改为调用 `_refreshLine()`，避免重新写入旧单行 prompt。
  - `test/tui-input.test.ts` 覆盖无外框 welcome header、boxed input prompt/footer、主输入多行光标回移、resize 后旧 boxed rows 清理、二级 prompt 保持单行和 wrapped row 清理，以及发送后紫色用户消息不带输入框 chrome。
- **验证**:
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O exec tsx -- --test --test-concurrency=1 /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/tui-renderer.test.ts /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/tui-input.test.ts /Users/tangyaoyue/DEV/BABEL/BabeL-O/test/completer.test.ts`：57/57 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run typecheck` 通过。
  - `npm --prefix /Users/tangyaoyue/DEV/BABEL/BabeL-O run test:tui:pty`：11/11 通过。
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
