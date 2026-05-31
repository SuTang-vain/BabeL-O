# BabeL-O / Nexus 已完成能力索引

## 口径

本文件用于把各 TODO 文档中的已完成大项移出待办清单，避免 `[x]` 历史堆叠干扰优先级判断。事实流水、验证命令和真实会话复盘仍以 [WORK_LOG.md](./WORK_LOG.md) 为准；本文件只保留可检索的完成能力索引。

完成项进入本文件的条件：

- 能对应到源码、测试、命令验证或明确工作记录。
- 已不再需要作为下一步开发任务持续跟踪。
- 若后续发现回归，应在对应 TODO 中重新开一个未收口项，而不是修改旧完成记录。

## Runtime / Nexus

- Nexus API、WebSocket stream、embedded/service runtime、sessions/tasks/events 基础接口已落地。
- `LocalCodingRuntime` 与 `LLMCodingRuntime` 已支持工具循环、provider stream、usage/error 归一、max loop 保护和失败 `result` 输出。
- SQLite / Memory storage 已支持 session、events、tasks、tool traces、permission audits、execution metrics、child sessions。
- `storageBridge` 已具备 retry、JSONL WAL、batch flush、replay 与 compact。
- `PendingPermissionRegistry`、Bash CWD、TaskQueue、TaskSession 已具备 TTL/prune/close cascade 生命周期清理。
- WebSocket 快速 `permission_response` 竞态已修复：runtime 在发送 `permission_request` 前先注册 pending permission entry，避免快客户端审批被丢弃。
- Workspace path escape、invalid tool input、Bash non-zero exit、provider empty response、max loops、context limit 等错误已改为可恢复或可诊断边界。
- Docker execution environment 第一版已实现 local container lifecycle、workspace mount、network/memory/cpu 配置；remote runner protocol 仍未做。

## Context / Compact / 指令跟随

- Context budget、token estimator、blocking limit、manual/auto compact、compact failure fuse、retained tail、retained segment verification 已落地。
- `/compact`、`/context`、Context Analysis API、Post-Compact State、Compact Capability Reminder 已落地。
- 工具结果持久化与消息级预算专项已完成，详见 [TODO_tool_result_budget.md](./TODO_tool_result_budget.md) 的历史设计。
- User Intake Guidance 事件管线已替代早期硬 pivot / regex 主分类，短问候、暂停、状态追问、纠错、显式路径切换均有回归覆盖。
- `session_321c48be`、`session_3ba2d788`、workspace escape 后“继续”、cancel 后状态追问、provider empty response、invalid tool input/schema failure 等真实漂移样本已进入 regression corpus。
- Session Memory Lite opt-in 第一版已实现：`BABEL_O_SESSION_MEMORY_LITE=1` 时维护 `.babel-o/session-memory.md` 并产出审计事件。

## Provider / Model

- Provider registry、config CLI、models CLI、Anthropic-compatible / OpenAI-compatible / Local adapter、retry、usage/error 归一已落地。
- Zhipu、MiniMax、DeepSeek、OpenAI、Anthropic official provider seed 已落地。
- MiniMax text-encoded `<minimax:tool_call>` 已归一为标准 Nexus tool invocation。
- Provider protocol regression 已覆盖标准 tool call、partial/malformed tool arguments、multi-tool arguments、MiniMax XML-like tool call、Anthropic malformed delta 与 OpenAI malformed function arguments。
- Provider diagnostics、`/v1/runtime/status`、`/status`、provider smoke dry-run、显式 simple-text/tool-call live smoke、fallback policy 诊断与 fallback plan API 已落地。
- DeepSeek `reasoning_content` replay 已有 adapter 与 runtime 回归，能在 tool result 续轮中回放真实 reasoning，不伪造缺失 reasoning。

## Agents / Optimize

- TaskSession、TaskQueue、Planner/Executor/Critic、Optimizer、自优化 CLI、Planner human-in-the-loop 已落地。
- SubTasks、受控 sub-agent 委派、max depth/max subTasks、父任务 blocked/resume、重复委派检测、成本控制、`--no-critic` 等已落地。
- Worktree isolation、nested worktree merge-back、cherry-pick 范围回传、冲突诊断、in-place Git hardening 与 per-cwd Git lock 已落地。
- 跨 session 子 Agent、child transcript 引用、permission inheritance 审计、child cancel/resume、父 session close 级联取消已落地。
- `bbl optimize --provider-smoke-live` 入口已落地，使用固定临时 workspace、固定 read-only fixture、固定 planner review task，不执行任意用户任务。
- SDK/dashboard session assets query API 已落地：`GET /v1/sessions/:sessionId/assets` 聚合 session、tasks、child sessions、events page、tool traces、permission audits、critic reviews、usage summary 与 execution metrics。

## CLI / TUI

- `bbl run`、`bbl chat`、`bbl nexus`、`bbl sessions`、`bbl tools audit`、`bbl config`、`bbl models` 已落地。
- Local runtime 已支持自然语言文件问答，同时显式 `read/write/edit/grep/glob/bash/task` 工具命令保持最高解析优先级。
- Slash palette、tool palette、history search、model wizard、status/smoke/context/compact 命令已落地。
- 多级 permission panel 已落地，支持 once/session/editable rule/reject/reject with instruction，Esc/Backspace 不误批准。
- 类 Claude/Gemini 的层级事件渲染、工具状态原地更新、compact/expanded 工具详情、agent running indicator、context warning、task status panel 已落地。
- 无外框 welcome header、boxed input prompt、长输入软换行、paste placeholder 压缩/展开、唯一 input owner、原生滚动恢复已落地。
- 最小 PTY smoke 已覆盖 slash palette、permission panel、compact Read 渲染、input placeholder、read/edit/diff/Grep/Glob/TaskCreate、resume session 和 paste/input 基线。

## MCP / Skills / Permissions / Hooks

- MCP stdio client、registry、tool adapter、risk classification、input schema validation、tools audit 与官方 MCP smoke 已落地。
- Markdown inline skills loader、project/user/built-in 三层目录、trigger/priority 匹配与内置 coding/debugging/testing/git/optimization skills 已落地。
- Smart permission classifier、Bash lexical scan、read-only auto approve、危险命令 deny/manual review、cat workspace preflight、permission audit 已落地。
- Runtime hooks 最小内核已落地：`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`PermissionRequest`、`SubagentStart`、`SubagentStop`、`SessionEnd` 的 typed event、内置 hook、timeout/error isolation 和审计事件。

## Cleanup / Performance

- `docs/nexus` 已成为唯一长期文档中心。
- Runtime 去重已完成：共享 `toolExecutor.ts`、`app.ts` 执行准备/metrics helpers、Git helpers、结构化 logger。
- `npm run typecheck`、`npm test`、`npm run benchmark`、核心 storage/context/provider/TUI smoke 已建立。
- `README.md` 与 `README.zh-CN.md` 已拆分英文/中文入口。

## 仍需守住的底线

- TODO 文件只写未完成项；完成后移动到本文件并在 WORK_LOG 追加事实。
- 新增真实会话回归时，先补最小 regression corpus，再调整 runtime/adapter/TUI。
- Provider fallback 不能 silent model switch；任何模型/profile 切换必须用户显式确认。
- 子 Agent / optimizer 默认优先隔离执行；in-place Git 操作不能纳入无关未跟踪文件或删除用户文件。
- TUI 权限面板、slash/tool palette 和 input owner 的键盘路由不能退回多输入框或 `y/N` 单行审批。
