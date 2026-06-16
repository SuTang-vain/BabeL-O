# Tool Surface Expansion & Native vs MCP Coexistence Plan

> Status: Plan only — no implementation yet
> Priority: P2 unless promoted by a real-session regression
> Scope: native builtin tool surface for `src/tools/builtin/`, coexistence rules with `McpRegistry` / `EverCore MCP`, registry layering, and provider-visible tool naming governance
> Related plans: `tool-granularity-and-evidence-governance-plan.md` (this file is the *expansion* counterpart; that one is the *boundary* counterpart)
> Last updated: 2026-06-16
> Revision notes (2026-06-16): naming aligned with `skill-execution-and-automated-normalized-skill-generation-governance-plan.md`; `Config`/`Sleep` aligned with `babel-o-test-config-isolation` and `task-adaptive-recoverable-timeout-plan.md`; `Plan` mode wiring pointed at `LLMCodingRuntime`; failure semantics unified on `COMMAND_OUTPUT_LIMIT`-style recoverable diagnostics.

---

## 1. 背景

BabeL-O 当前模型可见的内置工具集是 9 个（`createDefaultToolRegistry()` in `src/tools/registry.ts`）：

| 名称 | 风险 | 备注 |
| --- | --- | --- |
| `ListDir` | read | bounded directory inventory（Phase D） |
| `Glob` | read | path pattern / substring file discovery |
| `Grep` | read | content locator（Phase B.5：fallback parity、no-result diagnostics） |
| `Read` | read | source understanding |
| `Write` | write | 新建 / 覆盖 |
| `Edit` | write | 精准编辑 |
| `Bash` | execute | 含 `riskForInput` + `bashClassifier.ts` |
| `Task` | task | **当前仅暴露 create**，`shared/task.ts` 的 `NexusTask` 全字段未对模型可见 |
| `WebSearch` | read | DuckDuckGo Lite 内置 fallback |

叠加 AgentScheduler 与 EverCore MCP：

- `AgentSpawn` / `AgentWait` / `AgentList` / `AgentCancel`（`createAgentToolRegistry()`）
- `mcp:evercore:memory_search` / `mcp:evercore:memory_save_note` / `mcp:evercore:memory_flush_session`（`createEverCoreMcpToolRegistry()`）
- 任何通过 `McpRegistry` 注册的 `mcp:<server>:<tool>` 工具（`createMcpToolRegistry()`，受 `BABEL_O_MCP_CONFIG` 控制）

`createDefaultNexusRuntime()` 的实际加载顺序是 **builtin → MCP → EverCore MCP → AgentScheduler**，后注册覆盖前者。

### 1.1 已发现的不足

1. **`Task` 工具只有 create 入口**：`shared/task.ts` 已经定义 `NexusTask` 完整生命周期字段（`status`、`ownerAgentId`、`dependsOn`、`blocks`、`review`、`retryCount`），但 `builtin/task.ts` 实际只实现了 `TaskCreate` 单入口。模型创建任务后无法 list / get / update / stop / 输出 task result，任务管理是断头路。
2. **没有 `AskUserQuestion` 工具**：CLI 是 commander 风格、`bbl chat` 是 inquirer 风格，但 LLM 没有官方途径发起多选 / 单选 / 澄清问题。当前若要澄清只能走 `Read` / `Write` 临时文件这种反模式。
3. **MCP 协议层工具未对模型可见**：`mcp/McpClient.ts` 存在，但 `mcp.listResources` / `mcp.readResource` / `mcp.callTool` 这三个 JSON-RPC 原语没有以独立 `ToolDefinition` 形式暴露到注册表。模型只能看到 MCP server 暴露的具体工具，看不到资源层。
4. **没有 `Skill` 工具**：`src/skills/loader.ts` + `skills/matcher.ts` 已存在，frontmatter-driven skill 文件也可被 `BabeL-O` 加载；但 LLM 没有显式 `load_skill` / `list_skills` 入口，只能依赖 system prompt 静态注入。
5. **没有 `Plan` 工具**：`nexus/runtimeAgentStep.ts` 内部已有 critic / planner / executor 三阶段评审流，但显式 `EnterPlanMode` / `ExitPlanMode` 工具未对外暴露。模型无法在长任务前声明"我先做计划"。
6. **没有 `Worktree` 工具**：`shared/agentJob.ts` 已定义 `AgentIsolationMode = 'worktree'`，但 `git worktree add/remove` 没包成 LLM 可调用工具。子 agent 隔离无法被模型主动开启。
7. **`WebSearch` 是单一内置实现**：缺 provider 抽象层；用户安装官方 `mcp:web_search` 后无法自动覆盖 DuckDuckGo Lite fallback。
8. **没有 `Cron` / `Sleep` 工具**：Babel-2 提供的 `ScheduleCron` / `Sleep` 在长期异步任务 / 反压场景常用；当前模型只能在 Bash 里 `sleep` 或退出 session。
9. **没有 `Config` 工具**：`shared/config.ts` 的 `ConfigManager.resolveSettings()` 已能读写运行期配置，但模型没有运行时改写 provider / docker / allowedPaths 的入口。
10. **没有 `NotebookEdit` / `PowerShell` / `LSP` 工具**：跨平台 notebook 场景、Windows shell、IDE-style 代码导航。这三项是 Babel-2 才有、BabeL-O 暂时不必的。

### 1.2 现状的双轨问题

BabeL-O 设计上把 LLM 可见工具分两类：

- **native builtin**（`src/tools/builtin/*.ts`）—— 进程内 TypeScript 实现，强类型、权限策略精细、recovery 完整。
- **MCP / EverCore MCP**（`src/mcp/*` + `src/tools/everCoreMcpTools.ts`）—— 外部进程 stdio JSON-RPC，命名 `mcp:<server>:<tool>`，带 `source.type: 'mcp'` 与 `mcpServerAllowed: true`。

**当前隐含规则（缺文档）**：MCP 后注册会覆盖同名的 builtin（`createDefaultNexusRuntime()` 里 `tools.set(name, ...)` 是无条件覆盖）。这意味着：

- 用户安装官方 `mcp:web_search` 后会无感接管 `WebSearch`（行为正确，但不易诊断）。
- 用户安装名字相同的恶意 MCP server 可以无声替换原生工具（`source.type` 仍会记录，但模型看到的只是工具名 + description）。

本规划补齐原生工具的同时，也把"原生 vs MCP 的双轨规则"明确写出来。

---

## 2. 设计原则

### 2.1 补齐的判定标准

新增 native builtin 必须满足至少一条：

1. **生态一致性**：Babel-2 / Agent-Reach / Codex CLI 都有，且缺失会让 LLM 在跨工具训练中产生预期错位（如 `AskUserQuestion`、`NotebookEdit`）。
2. **不可由现有工具表达**：Bash 模拟要么成本太高要么风险太大（如 `Sleep` 不能可靠跨 `node:child_process` 状态恢复）。
3. **治理需要**：Bash/MCP 内部行为对模型不可见，必须有显式入口（如 `EnterPlanMode`）。

新增 native builtin **不应**满足：

1. 与现有工具职责重叠（与 `tool-granularity-and-evidence-governance-plan.md` 的"不新增 Search"原则一致）。
2. 仅是给既有能力换名字。
3. 未经真实回归驱动，仅是"未来可能用到"。

### 2.2 native vs MCP 优先级

按 `createDefaultNexusRuntime()` 现有加载顺序扩展为**四层注册**：

```text
Layer 1 — Native builtin (createDefaultToolRegistry)
Layer 2 — MCP server registered tools (createMcpToolRegistry, BABEL_O_MCP_CONFIG)
Layer 3 — EverCore MCP tools (createEverCoreMcpToolRegistry, gated by everCore.config.mcpToolsEnabled)
Layer 4 — AgentScheduler tool registry (createAgentToolRegistry, gated by enableAgentTools)
```

**优先级规则**：

1. **后注册覆盖前注册**（保持现有语义）：MCP > native，Agent > MCP。
2. **同名工具必须出现在 `diagnostics` 中**：被覆盖的 builtin 在 `~/.babel-o/log/embedded-nexus.log` 输出 `tool_overridden_by: <layer>:<server>:<tool>` 一行 WARN，让运维可追因。
3. **layer 3（EverCore）覆盖 layer 2（MCP）时**只覆盖 `mcp:evercore:*` 同前缀工具；不发生跨前缀覆盖。
4. **风险提升检测**：若 MCP 工具声明的 `risk` 高于被覆盖的 builtin（`read → write`），Go TUI 必须在 `permission_request.source` 之外额外提示一次 `risk_promoted` 警告（参考 `go-tui-permission-policy-governance-plan.md`）。
5. **不启用 dynamic tool schema 注入**：MCP server 不允许运行时新增 / 删除 builtin 层工具；只允许替换（同名）以避免模型选择集合的运行时漂移。

### 2.3 命名规范

- native builtin：PascalCase 单字或 PascalCase 单词，如 `TaskCreate`、`AskUserQuestion`、`WebSearch`。与 `Tool.ts` 现有 9 个一致。
- MCP 工具：`mcp:<server>:<original>`，与 `everCoreMcpTools.ts` 已有的 `mcp:evercore:memory_search` 风格保持一致。
- AgentScheduler 工具：保留 `AgentSpawn` / `AgentWait` / `AgentList` / `AgentCancel` 命名，**不新增** `define_subagent` / `invoke_subagent` / `delegate`（与 `tool-granularity-and-evidence-governance-plan.md` Phase E 一致）。

### 2.4 风险 / 审批 / 持久化

- 复用现有 `risk: 'read' | 'write' | 'execute' | 'task'`。
- 复用 `requiresApproval` + `suggestedAllowRule` + `mcpServerAllowed`。
- 复用 `riskForInput`（Bash 已经用到）。
- 复用 `truncateToolOutput()`（`src/tools/output.ts`）。
- 复用 `ToolContext.storage`（`NexusStorage`）做持久化（仅 `task/*` / `cron/*` 工具需要）。
- 持久化文件路径由 `BABEL_O_CONFIG_FILE` / `BABEL_O_STORAGE_FILE` 等 env 控制；测试统一用 `:memory:` / 临时文件隔离，**严禁**读写真实 `~/.babel-o/config.json` 或 `~/.babel-o/db.sqlite`（参考 `babel-o-test-config-isolation` 记忆与 §5 Phase 0 收口标准）。

### 2.5 失败 / 拒绝语义（参考 COMMAND_OUTPUT_LIMIT 模式）

所有 native builtin 工具的失败 / 拒绝统一遵循以下语义（与 `task-adaptive-recoverable-timeout-plan.md` 的"可恢复超时"思路一致）：

1. **不 throw 终止 session**：失败必须返回 `{ success: false, errorCode, message, ... }` 形态的 `FailedToolResult` / `NexusDiagnostic`；模型可基于 `errorCode` 决定下一步。
2. **失败码必须在 `shared/errors.ts` 字典登记**：每个新工具的 `errorCode` 在落地前先在 `src/shared/errors.ts` 注册；测试断言 `errorCode` 出现在 registry。
3. **失败信息必须可恢复**：message 必须包含足够的引导（"如何调整输入 / 切换参数 / 等待资源"），而非"操作失败"这类无信息内容。参考 `src/tools/builtin/bash.ts` 的 `COMMAND_OUTPUT_LIMIT` 引导模式（commit `f369535`）。
4. **失败应当带原始上下文**：如 `stdoutTruncated` / `stdoutOriginalBytes` / `outputLimited: true` / `errorCode: 'COMMAND_OUTPUT_LIMIT'`。下游 hook（如 `BashFailureSummaryHook` / `RecoverInvalidToolInputHook`）能基于结构化字段生成 `retryHint` / `summary`。
5. **soft timeout**：所有工具接受 `signal: AbortSignal`；超时由调用方（`LLMCodingRuntime` / `runtimeAgentStep.ts`）通过 `AbortController` 触发，**不**在工具内部固定截断。`Sleep` 是例外：sleep 自身就是"等待"，但仍受 `signal` 控制，可被用户取消（返回 `SLEEP_ABORTED`）。
6. **failureKind 分类**：复用 `invocation.failureKind` 字段（已有：`loop_limit` / `context_overflow` / `tool_error` / `permission_denied` / `provider_unavailable`），新工具按实际情况归类。

---

## 3. 工具补齐清单

按 P0 / P1 / P2 排序，**每一项都需要真实回归驱动再实现**，本规划不强行交付。

### 3.1 P0：核心闭环（先做这五个）

#### 3.1.1 `Task` 工具族拆分

`src/tools/builtin/task.ts` 拆为子目录：

```
src/tools/builtin/task/
├── create.ts   # 现 TaskCreate
├── get.ts      # TaskGet     risk=read
├── list.ts     # TaskList    risk=read
├── update.ts   # TaskUpdate  risk=write
├── stop.ts     # TaskStop    risk=write
└── output.ts   # TaskOutput  risk=read
```

约束：

- 全部复用 `shared/task.ts` 的 `NexusTask` 类型作为输出。
- 全部走 `context.storage`（`NexusStorage`）做持久化；无 storage 时返回 `STORAGE_UNAVAILABLE` diagnostic（须在 `src/shared/errors.ts` 登记），不抛 throw。
- 名称沿用 Babel-2 习惯：`TaskCreate` / `TaskGet` / `TaskList` / `TaskUpdate` / `TaskStop` / `TaskOutput`，避免破坏跨工具训练的预期。
- 保留 `requiresApproval=false` 给 read（`get` / `list` / `output`），write（`update` / `stop`）保持 `requiresApproval=true`，让 permission policy 可以 `-` allowlist 通过。
- `TaskUpdate` 只接受 `status`、`ownerAgentId`、`metadata` 三个字段；**不**接受 `taskId` / `sessionId` / `createdAt` 改写（治理上禁止改写身份字段）。
- `TaskStop` 必须在执行前检查 `status in ['pending', 'in_progress', 'blocked']`，否则返回 `TASK_TERMINAL` diagnostic（须登记），不重复终止。
- **存储现状尽调**（Phase 1 启动前置）：`NexusStorage` 当前已支持 `task.create`；`get` / `list` / `update` / `stop` / `output` 5 个接口**未实现**，需在 Phase 1 同步完成。schema migration 守门见 §5 Phase 1 收口标准。
- **失败码必须登记**：本族新增的 `STORAGE_UNAVAILABLE` / `TASK_TERMINAL` / `TASK_NOT_FOUND` / `TASK_IDENTITY_FIELD_READONLY` 共 4 个错误码，落地前在 `src/shared/errors.ts` 注册。

#### 3.1.2 `AskUserQuestion` 工具

新增 `src/tools/builtin/askUserQuestion.ts`：

- input： `{ question: string, header?: string, options: Array<{ label: string, description?: string, preview?: string }>, multiSelect?: boolean }`
- CLI 端：复用 `src/cli/embedded.ts` 已有的 `@inquirer/prompts` 通道（`runSessionFlow` 已有 `rl: readline.Interface` 接入点）。
- Go TUI 端：参考 `go-tui-permission-policy-governance-plan.md` 的 scope-aware dialog，新增 `AskUserQuestionDialog`，与 `pendingPermission` 走同一条 `permissionDialog` 渲染通道。
- 风险：标为 `read`（"获取用户输入"），**`requiresApproval=false`**。但需要 session 中至少跑过 user turn（防止新 session 启动时冷启动调用）。

约束：

- 一次只问一个问题；多问题需要模型分多次调用（避免 session state 复杂化）。
- `options.length` 必须 2–4，少于 2 / 多于 4 返回 `ASK_QUESTION_OPTIONS_OUT_OF_RANGE` diagnostic（须在 `src/shared/errors.ts` 登记）。
- 冷启动调用（session 尚未收到 user turn）返回 `ASK_QUESTION_NOT_ALLOWED_COLD_START` diagnostic（须登记）。
- 答案以 `{ question, answer }` 形式注入到 session event，不写 storage。
- **Go TUI 依赖**：`AskUserQuestionDialog` 依赖 `go-tui-loop-multipane-plan.md` 的多面板通道先落地；Phase 2 收口前必须确认该依赖已 Closed。

#### 3.1.3 `MCPTool` + `ListMcpResources` + `ReadMcpResource`

把现有 `src/mcp/McpClient.ts` + `src/mcp/McpToolAdapter.ts` 暴露为 3 个独立 `ToolDefinition`：

- `MCPTool`（risk=execute）：input `{ server: string, tool: string, args?: Record<string, unknown> }`，调用 `mcpClient.callTool(server, tool, args)`。
- `ListMcpResources`（risk=read）：input `{ server?: string, cursor?: string }`。
- `ReadMcpResource`（risk=read）：input `{ server: string, uri: string }`。

约束：

- 三个工具**仅在 `enableMcp === true` 且 `McpRegistry` 至少注册了一个 server 时**注册到 `createDefaultToolRegistry()`；否则不暴露给 LLM（避免空指针和 prompt 噪音）。
- `MCPTool` 走 `requiresApproval=true`，因为它能间接调用任何 MCP server 的任意工具。
- `ListMcpResources` / `ReadMcpResource` 风险等同资源浏览，给 `requiresApproval=false`，但 Go TUI 仍可在 `permission_request.source === 'mcp'` 时附加风险提示（参考 `tool-granularity-and-evidence-governance-plan.md` 2.2 节的 MCP 路径）。
- 命名 **不**使用 `mcp:` 前缀（这是 native builtin，不是 MCP 工具），沿用 `MCPTool` / `ListMcpResources` / `ReadMcpResource`。
- **能力探测**：调用 `ListMcpResources` / `ReadMcpResource` 前，先通过 `mcpClient.listCapabilities(server)` 探测该 server 是否声明 `resources` 能力；未声明则返回 `MCP_RESOURCES_UNSUPPORTED` diagnostic（须登记），**不**返回误导性的 `RESOURCE_NOT_FOUND`。
- **跨前缀覆盖拦截**：本族工具注册到 Layer 2（MCP）前，必须先 check 当前 Layer 1（native）是否有同名工具；若同名 native 工具存在且 MCP server 工具 `risk` 更高，触发 `tool_overridden_by` 诊断日志（与 §2.2 一致）。
- **错误码**：`MCP_SERVER_NOT_FOUND` / `MCP_RESOURCES_UNSUPPORTED` / `MCP_RESOURCE_NOT_FOUND` / `MCP_TOOL_CALL_FAILED` 4 个 errorCode 须在 `src/shared/errors.ts` 登记。

#### 3.1.4 `Skill` 工具

新增 `src/tools/builtin/skillTool.ts`，封装 `src/skills/loader.ts`：

- `SkillList`（risk=read）：input `{ tag?: string }`，列出当前会话可见的 skill（基于 `Skills` 配置文件 + `skills/built-in/` 目录）。
- `SkillShow`（risk=read）：input `{ name: string }`，加载 skill body，返回前 N 字符 + metadata。命名与 `skill-execution-and-automated-normalized-skill-generation-governance-plan.md` 保持一致；本节不重开 Skill 工具族的完整生命周期（`SkillValidate` / `SkillDraft` / `SkillSave` 由那份规划定义）。

约束：

- **不**实现"执行 skill body 当作 prompt"这种语义；skill body 仍由 system prompt 注入 + `SkillShow` 显式展开，模型自己决定如何用。
- 名称沿用 `SkillList` / `SkillShow`，与 Babel-2 `SkillTool` 区分；不新建 `define_skill` / `invoke_skill` / `load_skill` 这种模糊命名。
- **错误码**：`SKILL_NOT_FOUND` / `SKILL_NAME_REQUIRED` 须在 `src/shared/errors.ts` 登记。

#### 3.1.5 `Plan` 工具

新增 `src/tools/builtin/planMode.ts`：

- `EnterPlanMode`（risk=read）：input `{ summary: string }`。让模型显式声明"我现在进入计划模式"，**装配点**在 `LLMCodingRuntime`（不是 `runtimeAgentStep.ts`）：进入 plan 模式后，下一个 LLM 调用的 `tools` 白名单由 `LLMCodingRuntime` 重新构建，仅含 `risk: 'read'` + `SkillShow` + `Plan` 三类。
- `ExitPlanMode`（risk=read）：input `{ plan: string, approved?: boolean }`。退出计划模式，写入 `shared/agentJob.ts` 的 `AgentJob.plan` 字段（如果是新字段，需要先扩 schema）。

约束：

- **不**是 permission gate（计划模式内不审批 Bash），而是**对模型可见的工具白名单约束**。
- `EnterPlanMode` 仅在 user prompt 中包含"计划 / 规划 / 拆解 / 方案 / 路线 / plan / roadmap"等强信号时被允许；其他场景返回 `PLAN_MODE_NOT_TRIGGERED` diagnostic（须在 `src/shared/errors.ts` 登记）。
- **Cue 函数归属**：`shouldEnterPlanMode(prompt)` 作为纯函数放到 `src/runtime/planModeCue.ts`，与 `src/runtime/memoryProvider.ts` 平级；**不**复用 `memoryProvider.ts` 内部代码（职责分离）。Cue 思路参考 `memory-capability-awareness-and-trigger-plan.md` 中 `shouldAutoSearchMemory()` 的写法（纯函数 + trigger 词表 + 可测试）。
- **Schema 扩展**：`shared/agentJob.ts` 的 `AgentJob` 需要新增可选字段 `plan?: { summary: string; createdAt: string; approved: boolean }`；schema migration 守门见 §5 Phase 4 收口标准。
- **错误码**：`PLAN_MODE_NOT_TRIGGERED` / `PLAN_MODE_ALREADY_ACTIVE` / `PLAN_MODE_NOT_ACTIVE` 须登记。

### 3.2 P1：生态对齐（二期）

#### 3.2.1 `Worktree` 工具

- `WorktreeCreate`（risk=execute）：input `{ branch: string, base?: string }`，调用 `git worktree add`。
- `WorktreeRemove`（risk=execute）：input `{ path: string, force?: boolean }`，调用 `git worktree remove`。
- 命名沿用 `EnterWorktree` / `ExitWorktree`（与 Babel-2 一致），但工具本身只做 worktree 增删，不绑死 AgentScheduler。

约束：

- 必须先 `git rev-parse --is-inside-work-tree` 通过，否则返回 `NOT_IN_GIT_REPO`（须登记）。
- `WorktreeCreate` 走 `requiresApproval=true`（execute 风险）。
- 不接管 `shared/agentJob.ts` 的 `AgentIsolationMode = 'worktree'` 内部流程，仅提供 LLM 可见入口；AgentScheduler 仍按既有 profile 配置决定是否走 worktree。
- **错误码**：`NOT_IN_GIT_REPO` / `WORKTREE_BRANCH_EXISTS` / `WORKTREE_PATH_NOT_FOUND` 须登记。

#### 3.2.2 `WebSearch` provider 抽象

`src/tools/builtin/webSearch.ts` 重构为：

```typescript
interface WebSearchProvider {
  name: string
  risk: 'read'
  search(query: string, topK: number, signal?: AbortSignal): Promise<WebSearchHit[]>
}

const builtinProviders = {
  ddgLite: new DuckDuckGoLiteProvider(),  // 现有实现
}

const mcpProviders = {
  web_search: new McpBackedWebSearchProvider(), // 通过 MCP 协议注入
}
```

约束：

- `createDefaultToolRegistry()` 注册 `WebSearch` 工具时，**只暴露一个 `WebSearch` 名称**；不暴露 provider 列表。
- provider 选择顺序：MCP `mcp:web_search` > MCP `mcp:brave_search` > builtin `ddgLite`。
- 用户安装官方 MCP 搜索后，**默认**走 MCP（与 2.2 节的"后注册覆盖"一致），同时在 `~/.babel-o/log/embedded-nexus.log` 输出 `web_search_provider=mcp:web_search` INFO 行。
- 缺 provider 时返回 `WEB_SEARCH_PROVIDER_UNAVAILABLE` diagnostic（须登记），**不**走 Bash `curl` 临时方案。
- **Provider 切换守门**：`mcp:web_search` / `mcp:brave_search` 切换走 §2.2 的"后注册覆盖 + 诊断日志"路径；切换必须在 `embedded-nexus.log` 留 INFO 行，**不**允许运行时静默切换。

#### 3.2.3 `Config` 工具

新增 `src/tools/builtin/configTool.ts`：

- `ConfigGet`（risk=read）：input `{ key: string }`，读取 `ConfigManager.resolveSettings()` 后的值。
- `ConfigSet`（risk=write）：input `{ key: string, value: string|number|boolean }`，写入并持久化到 `$BABEL_O_CONFIG_FILE`（默认 `~/.babel-o/config.json`）。

约束：

- **白名单 key**：`providerId` / `defaultModel` / `executionEnvironment` / `allowedPaths` / `permissionMode` / `mcp.enabled` / `everCore.mode`。其他 key 返回 `CONFIG_KEY_NOT_WRITABLE` diagnostic（须登记）。
- `ConfigSet` 走 `requiresApproval=true`。
- 写完后必须**重新加载** `ConfigManager` 并通过 `LLMCodingRuntime` 的"模型可见 settings 摘要"（装配点在 `LLMCodingRuntime`，不是 `runtimeAgentStep.ts`）把变化告诉 LLM（防止模型继续用过时的配置）。
- 写完后必须**重新解析 model metadata resolver**（`model-catalog-and-context-metadata-governance-plan.md`）：写入 `providerId` / `defaultModel` 时，重跑 user_config > builtin > undeclared 解析链，确保模型元数据与运行时一致。这与 `babel-o-model-catalog-governance` 记忆一致（不 auto-switch，但显式 set 后必须 reload）。
- 不动 `shared/config.ts` 的优先级链（CLI arg > env > file > default）。
- **测试隔离**：`ConfigSet` 测试必须用 `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-<pid>.json` 隔离；CI 守门同 `babel-o-test-config-isolation` 记忆。**严禁**写真实 `~/.babel-o/config.json`。
- **错误码**：`CONFIG_KEY_NOT_WRITABLE` / `CONFIG_KEY_NOT_FOUND` / `CONFIG_RELOAD_FAILED` 须登记。

#### 3.2.4 `Cron` / `Sleep` 工具

- `Sleep`（risk=read）：input `{ seconds: number, reason?: string }`，**软上限 60 秒**（可通过 `BABEL_O_SOFT_SLEEP_MAX_SECONDS` env 放宽），不阻塞事件循环，**仍受 `signal: AbortSignal` 控制**。
- `ScheduleCronCreate` / `ScheduleCronDelete` / `ScheduleCronList`（risk=write / write / read）：input 仿 Babel-2 风格 `cron` 表达式 + `command` / `toolCall`。

约束：

- `Sleep` 必须返回 `SleepCompleted` 事件；用户取消时立即返回 `SLEEP_ABORTED` diagnostic（须登记）。
- `Sleep` **不**是固定截断（与 `task-adaptive-recoverable-timeout-plan.md` / `babel-o-soft-recoverable-timeouts` 记忆一致）：上限是软阈值，env 可配；任务被 `signal: AbortSignal` 中断时立即返回。
- `ScheduleCron*` 持久化到 `NexusStorage.cronJobs`（如果不存在则需要新表 `cron_jobs`，schema migration 守门见 §5 Phase 5 收口标准）；必须在 session 关闭后仍能触发。
- cron 触发时启动**新** session，**不**是 current session；新 session 走 `task-scope-and-evidence-scope-governance-plan.md` 的 `task_scope_declared` 守门。
- 不实现 background dreaming / 长期 polling。
- **错误码**：`SLEEP_ABORTED` / `SLEEP_DURATION_OUT_OF_RANGE` / `CRON_EXPRESSION_INVALID` / `CRON_JOB_NOT_FOUND` / `CRON_PERSIST_FAILED` 须登记。

### 3.3 权限 / 审批矩阵

每个 native builtin 工具的 `risk` / `requiresApproval` / `mcpServerAllowed` / `suggestedAllowRule` 显式列表如下。`permission_policy.yaml` 的 `- tool: <name>` allowlist 行直接引用：

| 工具 | risk | requiresApproval | mcpServerAllowed | 备注 |
| --- | --- | --- | --- | --- |
| `TaskCreate` | task | false | false | 落 `task.created` event |
| `TaskGet` | read | false | false | |
| `TaskList` | read | false | false | 测试用 `:memory:` storage |
| `TaskUpdate` | write | true | false | 身份字段 readonly |
| `TaskStop` | write | true | false | 终态校验 |
| `TaskOutput` | read | false | false | |
| `AskUserQuestion` | read | false | false | 冷启动拒绝 |
| `MCPTool` | execute | true | true | 风险提升可触发 `risk_promoted` 提示 |
| `ListMcpResources` | read | false | true | 能力探测失败返 diagnostic |
| `ReadMcpResource` | read | false | true | 同上 |
| `SkillList` | read | false | false | |
| `SkillShow` | read | false | false | 替代原 `SkillLoad` 命名 |
| `EnterPlanMode` | read | false | false | 非 permission gate |
| `ExitPlanMode` | read | false | false | 同上 |
| `WorktreeCreate` | execute | true | false | |
| `WorktreeRemove` | execute | true | false | |
| `ConfigGet` | read | false | false | |
| `ConfigSet` | write | true | false | 白名单 key 守门 |
| `Sleep` | read | false | false | 软上限 + AbortSignal |
| `ScheduleCronCreate` | write | true | false | schema migration 守门 |
| `ScheduleCronDelete` | write | true | false | |
| `ScheduleCronList` | read | false | false | |

**注意**：`requiresApproval=true` 的工具在 Go TUI 走 `pendingPermission` 通道，在 CLI 走 `@inquirer/prompts`；allowlist 用户可以用 `- tool: <name>` 一键放行。**不**为任何工具绕过 policy —— 哪怕 `requiresApproval=false`，仍受 `tool_policy.global` 的 `risk: 'execute'` 等大规则约束。

### 3.4 会话事件矩阵

新工具 emit 的 NexusEvent 类型清单（参考 `src/shared/events.ts` 与 `src/runtime/hooks.ts` 已有的 event 列表）。**不**为新工具新增 event type，统一复用现有事件 + 工具级 `metadata` 字段：

| 工具 | emit event | metadata 关键字段 | 备注 |
| --- | --- | --- | --- |
| `TaskCreate` | `task_created` | `taskId, sessionId, ownerAgentId` | hook 接收后写 `task.created` 状态变更 |
| `TaskUpdate` | `task_status_changed` | `taskId, from, to, reason` | |
| `TaskStop` | `task_stopped` | `taskId, reason` | |
| `AskUserQuestion` | `user_question_asked` + `user_question_answered` | `questionId, options, answer` | 一次往返两个 event |
| `MCPTool` | `mcp_tool_call_started` + `mcp_tool_call_completed` | `server, tool, durationMs, success` | 失败时由 `mcp_tool_call_failed` 替代 |
| `SkillList` / `SkillShow` | `skill_inspected` | `skillId, source` (built-in/user/project) | 静态注入也有此 event，统一观测 |
| `EnterPlanMode` | `plan_mode_entered` | `summary, triggeredBy` (user/model) | |
| `ExitPlanMode` | `plan_mode_exited` | `approved, plan` | 退出后清空 `LLMCodingRuntime` 工具白名单 |
| `ScheduleCronCreate` | `cron_job_created` | `jobId, cron, command` | |
| `ScheduleCron*`（触发时）| `cron_job_triggered` | `jobId, newSessionId` | 新 session 走 `task_scope_declared` 守门 |
| `ConfigSet` | `config_changed` | `key, value (脱敏), source` | CLI 写、env 写、tool 写三种 source 区分 |

**新增 event type 守门**：本规划**不**为新工具新增 `NexusEvent` 类型；如需新类型，须先在 `shared/events.ts` 提 RFC + 在另一份 reference 规划登记。

### 3.5 P2：生态观察期（不做实现规划）

| 候选 | 现状 | 不做的原因 |
| --- | --- | --- |
| `NotebookEdit` | Babel-2 才有 | BabeL-O 定位 CLI，notebook 不是核心场景；保留 issue |
| `PowerShell` | Windows-only | 跨平台 CLI 默认不支持 Windows native shell |
| `LSPTool` | IDE 集成 | CLI 形态价值有限；Go Remote Runner 已有 LSP 间接能力 |
| `BriefTool` / 附件上传 | 绑死 Nexus HTTP 协议 | 看产品形态是否走 Nexus 协议再说 |
| `McpAuthTool` | 跟 `MCPTool` 一起实现 | 不单独做；OAuth 流程在 MCP 协议层处理 |
| `SendMessage` / `TeamCreate` / `TeamDelete` / `RemoteTrigger` / `REPL` | Babel-2 才有 | BabeL-O AgentScheduler 已具备对应能力（`AgentSpawn` 等），不重复 |

---

## 4. 目录结构调整

补齐后的 `src/tools/` 目录：

```text
src/tools/
├── Tool.ts                       # ToolDefinition (existing)
├── registry.ts                   # createDefaultToolRegistry (rewrite to support layering)
├── output.ts                     # truncateToolOutput (existing)
├── everCoreMcpTools.ts           # mcp:evercore:* (existing)
├── builtin/
│   ├── bash.ts                   # risk: execute (existing + riskForInput + COMMAND_OUTPUT_LIMIT)
│   ├── bashClassifier.ts         # pure-function classifier (existing)
│   ├── edit.ts                   # risk: write
│   ├── write.ts                  # risk: write
│   ├── read.ts                   # risk: read
│   ├── glob.ts                   # risk: read
│   ├── grep.ts                   # risk: read (with fallback parity)
│   ├── listDir.ts                # risk: read (bounded inventory) — canonical name
│   ├── pathDrift.ts              # diagnostic only
│   ├── pathSafety.ts             # utility
│   ├── webSearch.ts              # risk: read (rewrite as provider)
│   ├── task/                     # P0: split into 6 files
│   │   ├── create.ts
│   │   ├── get.ts
│   │   ├── list.ts
│   │   ├── update.ts
│   │   ├── stop.ts
│   │   └── output.ts
│   ├── askUserQuestion.ts        # P0
│   ├── mcp.ts                    # P0: MCPTool + ListMcpResources + ReadMcpResource
│   ├── skillTool.ts              # P0: SkillList + SkillShow (命名以 Skill 治理规划为准)
│   ├── planMode.ts               # P0: EnterPlanMode + ExitPlanMode
│   ├── worktree.ts               # P1: WorktreeCreate + WorktreeRemove
│   ├── configTool.ts             # P1: ConfigGet + ConfigSet
│   ├── sleep.ts                  # P1
│   └── cron.ts                   # P1: ScheduleCronCreate / Delete / List
└── mcp/                          # (existing) McpClient + McpToolAdapter
```

**注意**：

- `list_dir.ts`（旧 snake_case 重复文件）在 Phase 0 收口时**删除**并以 `listDir.ts` 为 canonical；如有 `import '.../list_dir'` 引用，改为 `import '.../listDir'`（grep 守门）。
- 新增 `src/runtime/planModeCue.ts`（与 §3.1.5 对应），不复用 `memoryProvider.ts` 内部代码。
- `src/shared/errors.ts` 须在每个 Phase 收口前补登记对应 errorCode 字典。

`registry.ts` 改造为分层 + 后注册覆盖 + 诊断日志：

```typescript
export function createDefaultToolRegistry(options?: {
  enableMcp?: boolean
  mcpServers?: McpServerConfig[]
  enableEverCore?: boolean
  everCoreClient?: EverCoreClient
  everCoreConfig?: EverCoreRuntimeConfig
  enableAgentTools?: boolean
  agentScheduler?: ExploreAgentScheduler
  diagnosticLogger?: DiagnosticLogger
}): Map<string, AnyTool> {
  const tools = new Map<string, AnyTool>()
  // Layer 1: native builtin
  for (const tool of createNativeBuiltinTools()) {
    tools.set(tool.name, tool)
  }
  // Layer 2: MCP
  if (options?.enableMcp) {
    const mcpTools = await createMcpToolRegistry(options.mcpServers ?? [])
    for (const [name, tool] of mcpTools) {
      const existing = tools.get(name)
      if (existing) options?.diagnosticLogger?.warn('tool_overridden_by', { builtin: name, by: `mcp:${tool.source?.serverName ?? '?'}:${tool.source?.originalName ?? '?'}` })
      tools.set(name, tool)
    }
  }
  // Layer 3: EverCore MCP
  if (options?.enableEverCore && options.everCoreClient && options.everCoreConfig) {
    const everCoreTools = createEverCoreMcpToolRegistry(options.everCoreClient, options.everCoreConfig)
    for (const [name, tool] of everCoreTools) {
      const existing = tools.get(name)
      if (existing && !name.startsWith('mcp:evercore:')) {
        // 跨前缀不允许覆盖
        options?.diagnosticLogger?.warn('tool_override_blocked', { name, attemptedBy: 'evercore' })
        continue
      }
      tools.set(name, tool)
    }
  }
  // Layer 4: AgentScheduler
  if (options?.enableAgentTools && options.agentScheduler) {
    for (const [name, tool] of createAgentToolRegistry(options.agentScheduler)) {
      tools.set(name, tool)
    }
  }
  return tools
}
```

---

## 5. 分阶段实施

### Phase 0: 文档口径与注册表分层文档化

状态：本规划承接。

目标：

- 明确 P0 工具清单（5 个：Task 族拆分 / AskUserQuestion / MCP 暴露 / Skill / Plan）。
- 明确 native vs MCP 的 4 层加载顺序与覆盖规则。
- 不新增 `Search` / `define_subagent` / `invoke_subagent`（与 `tool-granularity-and-evidence-governance-plan.md` 一致）。

收口标准：

- `docs/nexus/TODO.md` 增加本规划入口。
- `active/TODO_runtime.md` 增加 P2 工具补齐未收口项。
- `AGENTS.md` 第 9 节 reference 列表增加本文件。
- `src/tools/builtin/list_dir.ts` 重复文件删除 + 引用 grep 守门。
- 起草**前**验证：每个 P0 工具入口必须**有真实 session regression 引用**（session id 或 log 路径）才保留 P0 标记；否则降为 P1。守门对齐 `babel-o-p0-regression-focus` 记忆。
- `src/shared/errors.ts` 已登记本规划用到的所有 `errorCode`（§3.3 权限矩阵 + §3.4 事件矩阵 + 各 P0 段落已枚举）。

### Phase 1: Task 族拆分（最小风险，最高价值）

目标：

- `src/tools/builtin/task.ts` 拆分为 6 个文件。
- `createDefaultToolRegistry()` 改为引用 `task/create.ts` 等。
- `shared/task.ts` 的 `NexusTask` 字段全部走 storage（`get` / `list` 必须真读到数据）。
- 实施**中**验证：每完成一个子工具（`get` / `list` / `update` / `stop` / `output`）必须先跑通"创建→断言可读→断言不可写身份字段"三步，再开下一个。

收口标准：

- 6 个工具 schema 全部通过 `npm run typecheck` + `npm run format:check`。
- `test/task-tool.test.ts` 覆盖 create → get → update → list → output → stop 的全流程；`storage=:memory:` 隔离（`BABEL_O_STORAGE_FILE=:memory:`）。
- **schema migration 守门**：现有 storage schema 跑 `npm run db:migrate` 后无报错；现有 100+ 测试不回归。
- 旧 `Task` 单一入口用户如有 CLI 脚本依赖（`bbl run --task-only` 之类），保持单名别名由 `task/create.ts` 重导出。
- 4 个 errorCode 全部登记并被 `test/task-tool.test.ts` 断言覆盖。
- 实施**后**验证：引用真实 session 中"模型创建 task 后无法 list / get"的 regression log，关闭对应 issue。

### Phase 2: AskUserQuestion + Skill

目标：

- `src/tools/builtin/askUserQuestion.ts` + `src/tools/builtin/skillTool.ts`。
- CLI / Go TUI 双端接入。
- `runSessionFlow` 已有 `rl: readline.Interface`，不引入新依赖。

收口标准：

- 一次 e2e 真实 prompt 中能完成"模型问 1 题 → 用户答 → 模型继续"（CLI 走 inquirer，Go TUI 走新 dialog）。
- `test/ask-user-question.test.ts` 覆盖选项越界 / 重复 label / 用户取消 / 冷启动拒绝。
- `test/skill-tool.test.ts` 覆盖 `SkillList` 默认空 / `SkillShow` 命中 `skills/built-in/coding.md`。
- **Go TUI 依赖守门**：`go-tui-loop-multipane-plan.md` 必须先 Closed；如未 Closed，本 Phase 不开 Go TUI 端，仅做 CLI 端 + Go TUI 接口预留。
- 实施**前**验证：必须有真实 session 中"模型需要澄清问题但被迫写临时文件"的 regression log。

### Phase 3: MCP 工具暴露

目标：

- `src/tools/builtin/mcp.ts` 暴露 `MCPTool` / `ListMcpResources` / `ReadMcpResource`。
- `createMcpToolRegistry()` 与新 `mcp.ts` 共用 `McpClient`。
- Go TUI 端 `MCPTool` 走 `permission_request.source = 'mcp'`。

收口标准：

- `test/mcp-native-tool.test.ts` 覆盖 server 不可用 / resource 不存在 / 跨前缀覆盖拦截 / 能力探测失败。
- `~/.babel-o/log/embedded-nexus.log` 出现 `tool_overridden_by=mcp:web_search:web_search` 当且仅当用户注册了同名 MCP server。
- 4 个 errorCode 全部登记并被测试断言覆盖。
- 实施**中**验证：`createDefaultToolRegistry()` 的分层行为用 unit test 断言（先注册 native，再注册 MCP，断言 native 被覆盖并 log）。

### Phase 4: Plan 模式

目标：

- `src/tools/builtin/planMode.ts` + `LLMCodingRuntime` 新增 `mode='plan'` 信号。
- `src/runtime/planModeCue.ts` 纯函数 cue 检测（不复用 `memoryProvider.ts` 内部代码）。
- `shared/agentJob.ts` 新增可选 `plan` 字段，schema migration 守门。

收口标准：

- plan 模式下 `tools` 白名单由 `LLMCodingRuntime` 重新构建，仅含 `risk: 'read'` + `SkillShow` + `Plan`。
- `test/plan-mode.test.ts` 覆盖 cue 命中 / 误命中 / 退出后状态清理。
- `test/plan-cue.test.ts` 覆盖纯函数输入输出。
- 3 个 errorCode 全部登记。
- 实施**后**验证：真实 session 中"模型未走计划直接调 Bash 出错"的 regression log 关闭。

### Phase 5: Worktree / Config / Cron / Sleep

目标：

- P1 全部 4 个工具族落地。
- `NexusStorage.cronJobs` schema migration（如不存在则新加）。
- Go TUI `/config` overlay（MVP，与 `/memory` 走同一通道）。

收口标准：

- 5 个工具 schema + storage migration 跑通。
- `test/cron-tool.test.ts` 覆盖创建 / 触发 / 持久化 / 取消 / 触发新 session 走 `task_scope_declared`。
- `test/config-tool.test.ts` 覆盖白名单 key / 越界 key / `BABEL_O_CONFIG_FILE=/tmp/...` 隔离守门 / model metadata resolver 重跑。
- `test/sleep-tool.test.ts` 覆盖软上限（60s 默认） / `BABEL_O_SOFT_SLEEP_MAX_SECONDS=300` 放宽 / `signal: AbortSignal` 中断。
- 全部 errorCode 登记并被测试断言覆盖。
- 实施**前**验证：ConfigSet / Sleep / Cron 必须有真实 regression 引用，否则降为 P2（与 `babel-o-p0-regression-focus` 一致）。

### Phase 6: WebSearch provider 抽象

目标：

- `src/tools/builtin/webSearch.ts` 拆为 provider 接口 + 内置 DuckDuckGoLite + MCP 注入。
- `createMcpToolRegistry()` 检测到 `mcp:web_search` / `mcp:brave_search` 时自动调整 `WebSearch` 工具的 provider 引用。

收口标准：

- `test/web-search-tool.test.ts` 已存在（参考 2026-05 已有 fixture），新增 provider 切换 case。
- 用户**未**注册 MCP 搜索时，行为与现在完全一致（back-compat 守门）。
- 切换必须在 `embedded-nexus.log` 留 INFO 行（grep 守门）。
- 实施**后**验证：用户安装 `mcp:web_search` 后无感接管 DuckDuckGo Lite，behavior 一致。

### Phase 7: 真实回归驱动

P0 / P1 全部落地后，转为 Watch / Closed：

- 后续只在真实 session 暴露以下 drift 时按 regression-first 重新开项：
  - 工具选择分歧（模型挑错工具造成超时 / 失败）。
  - 同名 MCP 覆盖未被诊断日志记录。
  - Plan 模式被绕过（Bash 强声明但未审批）。
  - Cron 触发后 spawn 的新 session 没有走 `task_scope_declared`（参考 `task-scope-and-evidence-scope-governance-plan.md`）。
  - ConfigSet 写完后 model metadata resolver 未重跑，模型继续用过时配置。
  - Sleep 固定截断回潮（违反 `task-adaptive-recoverable-timeout-plan.md`）。
  - test fixture 写入真实 `~/.babel-o/config.json`（CI 守门失败）。

---

## 6. 与现有文档的关系

| 文档 | 关系 |
| --- | --- |
| `reference/tool-granularity-and-evidence-governance-plan.md` | **互补**：那个文件管"既有工具的边界治理"；本文件管"补齐哪些工具 + 与 MCP 双轨并存"。 |
| `reference/skill-execution-and-automated-normalized-skill-generation-governance-plan.md` | **Skill 工具族命名以那份为准**（`SkillList` / `SkillShow` / `SkillValidate` / `SkillDraft` / `SkillSave`）；本规划 §3.1.4 不重开完整生命周期，仅实现 `SkillList` / `SkillShow`。 |
| `reference/task-adaptive-recoverable-timeout-plan.md` | **失败/拒绝语义对齐**（`babel-o-soft-recoverable-timeouts` 记忆）：本规划 §2.5 软超时 + AbortSignal 模式与该规划一致；`Sleep` 软上限由此而来。 |
| `reference/go-tui-loop-multipane-plan.md` | **依赖**：本规划 §3.1.2 `AskUserQuestionDialog` 依赖该规划的多面板通道先落地；Phase 2 收口前必须确认 Closed。 |
| `reference/go-tui-permission-policy-governance-plan.md` | `MCPTool` / `AskUserQuestion` 走 `permission_request.source`；风险提升（`read → write`）需额外 `risk_promoted` 提示；**本规划新发现：需要在该规划里补"对话型工具"小节**（AskUserQuestion / SkillDraft preview），由本规划 Phase 2 触发。 |
| `reference/context-and-subagent-upgrade-plan.md` | Plan 模式（Phase 4）与 ContextForker 的关系见该文件 Section "Plan 模式"；本文件不重开。 |
| `reference/memory-capability-awareness-and-trigger-plan.md` | `shouldEnterPlanMode()` 思路参考 `shouldAutoSearchMemory()`；**本规划 §3.1.5 显式把纯函数拆到 `src/runtime/planModeCue.ts`，不复用 `memoryProvider.ts` 内部代码**。 |
| `reference/model-catalog-and-context-metadata-governance-plan.md` | `ConfigSet` 写 `providerId` / `defaultModel` 后必须重跑 model metadata resolver（与 `babel-o-model-catalog-governance` 记忆一致：不 auto-switch，但显式 set 后必须 reload）。 |
| `reference/task-scope-and-evidence-scope-governance-plan.md` | `EnterPlanMode` / `ExitPlanMode` 触发后必须 emit `task_scope_declared`；由本规划 Phase 4 守门。cron 触发的新 session 也走该守门。 |
| `active/TODO_runtime.md` | 承接 P2 工具补齐未收口项（与"工具粒度治理"分开成两个 subsection）。 |
| `active/TODO_agents.md` | AgentScheduler 工具命名（`AgentSpawn` / `AgentWait` / `AgentList` / `AgentCancel`）由本规划继承；不新增 subagent 命名。 |
| `src/tools/builtin/bash.ts` 的 `COMMAND_OUTPUT_LIMIT` | **本规划 §2.5 失败语义参考实现**（commit `f369535`）：Bash 输出超 `maxBuffer` 时返回 `outputLimited: true` + 部分 UTF-8 安全预览 + 原始字节数 + 引导信息。新工具按此模式实现。 |
| `DONE.md` | 归档已完成的 Phase X。 |
| `WORK_LOG.md` | 记录 Phase 1-6 的事实流水。 |
| `archive/TODO_tool_result_budget.md` | 历史工具结果预算；本规划不重开。 |

---

## 7. 当前推荐优先级

| 优先级 | 项目 | 判断 |
| --- | --- | --- |
| **P0 文档化** | Phase 0 同步到 `TODO.md` / `active/TODO_runtime.md` / `AGENTS.md` + 删 `list_dir.ts` 重复 + 登记 errorCode | 已开始 |
| **P0 实现** | Phase 1（Task 族拆分）+ Phase 2（AskUserQuestion / Skill） | 真实回归驱动，**不强行排期** |
| **P0 实现** | Phase 3（MCP 暴露） | 与现有 `mcp/` 基础设施强绑定，落地成本低 |
| **P1 实现** | Phase 4-6 | 视真实回归决定 |
| **P2 观察** | NotebookEdit / PowerShell / LSP / BriefTool / McpAuthTool / SendMessage | 不主动开项 |
| **不做** | `Search` / `define_subagent` / `invoke_subagent` / `delegate` | 与 `tool-granularity-and-evidence-governance-plan.md` 一致 |

### 7.1 三段验证守门

每个 Phase 都按"起草前 / 实施中 / 实施后"三段验证（与 `babel-o-p0-regression-focus` 记忆一致）：

1. **起草前**：每个 P0 工具入口必须在 `WORK_LOG.md` / session log 中有真实 regression 引用（session id 或 log 路径）；否则降为 P1。
2. **实施中**：每个子工具落地后立即跑对应 unit test + 与既有测试集合并跑（守门不回归）；不允许"全部完成后再一起测"。
3. **实施后**：引用 regression log 关闭对应 issue / TODO；若未关闭，Phase 不算 Closed。

---

## 8. 验证标准

### 8.1 通用守门（每个 Phase 都跑）

- `npm run typecheck` 通过。
- `npm run format:check` 通过。
- `npm run lint` 通过。
- `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-<pid>.json` 隔离守门（与 `babel-o-test-config-isolation` 记忆一致）：CI grep `~/.babel-o/config.json` 写入守门。
- `BABEL_O_STORAGE_FILE=:memory:` 隔离守门：list / get / task 工具测试不写真实 SQLite。
- `src/shared/errors.ts` 的 errorCode 字典在每个 Phase 收口前更新到当前已落地工具的全集。

### 8.2 Phase 0（文档同步）

- `docs/nexus/TODO.md` 出现本规划入口。
- `active/TODO_runtime.md` 增加 P2 工具补齐 subsection，与"工具粒度治理"并列。
- `AGENTS.md` 第 9 节 reference 列表出现本文件。
- `src/tools/builtin/list_dir.ts` 删除，`grep -r "list_dir" src/` 守门 0 命中。
- 现有 100+ 测试不回归。

### 8.3 Phase 1（Task 族拆分）

- `npm test` 新增 `test/task-tool.test.ts`，覆盖 6 个工具全流程（create / get / list / update / stop / output）。
- `storage=:memory:` 隔离守门通过。
- 4 个 errorCode（`STORAGE_UNAVAILABLE` / `TASK_TERMINAL` / `TASK_NOT_FOUND` / `TASK_IDENTITY_FIELD_READONLY`）在 `shared/errors.ts` 登记并被测试断言。
- schema migration 跑通（`npm run db:migrate` 报错数 = 0）。
- 现有 100+ 测试不回归。

### 8.4 Phase 2（AskUserQuestion + Skill）

- `test/ask-user-question.test.ts` 覆盖选项越界 / 重复 label / 用户取消 / 冷启动拒绝。
- `test/skill-tool.test.ts` 覆盖 `SkillList` 默认空 / `SkillShow` 命中 `skills/built-in/coding.md`。
- Go TUI 端：**仅当** `go-tui-loop-multipane-plan.md` 已 Closed 才验收；否则 Phase 2 仅做 CLI 端。

### 8.5 Phase 3（MCP 暴露）

- `test/mcp-native-tool.test.ts` 新增覆盖 server 不可用 / 资源不存在 / 跨前缀拦截 / 能力探测失败。
- `~/.babel-o/log/embedded-nexus.log` 出现 `tool_overridden_by` 一行（fixture 检查，路径由 `BABEL_O_LOG_DIR` 控制）。
- 4 个 errorCode（`MCP_SERVER_NOT_FOUND` / `MCP_RESOURCES_UNSUPPORTED` / `MCP_RESOURCE_NOT_FOUND` / `MCP_TOOL_CALL_FAILED`）登记。

### 8.6 Phase 4（Plan 模式）

- `test/plan-mode.test.ts` 新增 cue 命中 / 误命中 / 状态清理。
- `test/plan-cue.test.ts` 新增纯函数输入输出。
- `LLMCodingRuntime` 暴露 `mode='plan'` 时 `tools` 白名单收窄到 `risk: 'read'` + `SkillShow` + `Plan`。
- `shared/agentJob.ts` 新增可选 `plan` 字段，schema migration 守门。
- 3 个 errorCode（`PLAN_MODE_NOT_TRIGGERED` / `PLAN_MODE_ALREADY_ACTIVE` / `PLAN_MODE_NOT_ACTIVE`）登记。

### 8.7 Phase 5（Worktree / Config / Cron / Sleep）

- `test/cron-tool.test.ts` 覆盖 cron 表达式校验 / 触发 / 持久化 / 取消 / 触发新 session 走 `task_scope_declared`。
- `test/config-tool.test.ts` 覆盖白名单 key / 越界 key / `BABEL_O_CONFIG_FILE=/tmp/...` 隔离守门 / model metadata resolver 重跑。
- `test/sleep-tool.test.ts` 覆盖软上限（60s 默认） / `BABEL_O_SOFT_SLEEP_MAX_SECONDS=300` 放宽 / `signal: AbortSignal` 中断。
- `test/worktree-tool.test.ts` 覆盖 `NOT_IN_GIT_REPO` / `WORKTREE_BRANCH_EXISTS` 错误码。
- 全部 errorCode 登记。

### 8.8 Phase 6（WebSearch provider 抽象）

- `test/web-search-tool.test.ts` 新增 provider 切换 fixture（保持 DuckDuckGoLite back-compat）。
- 用户**未**注册 MCP 搜索时，行为与现在完全一致（回归测试断言）。
- 切换 INFO 行 grep 守门（`embedded-nexus.log`）。

---

## 9. 决策摘要

补齐路径 = **5 个 P0 工具族** + **native vs MCP 4 层注册表** + **3 个 P1 工具族** + **1 个 P2 观察清单**。

```text
核心约束（修订后）：
1. 不重复新增 Search / define_subagent / invoke_subagent。
2. native 与 MCP 双轨共存，后注册覆盖前注册，覆盖必须出现在 diagnostic log。
3. Plan 模式是 LLM 可见工具白名单约束（装配点在 LLMCodingRuntime），不是 permission gate。
4. P0 工具优先复用 shared/task.ts / mcp/ / skills/ / LLMCodingRuntime 的现有基础设施。
5. 真实回归驱动，不为"未来可能"提前开项（与 babel-o-p0-regression-focus 记忆一致）。
6. 失败/拒绝语义统一：不 throw 终止 session；errorCode 在 shared/errors.ts 登记；
   失败信息含可恢复引导；soft timeout 由 AbortSignal 控制，工具内部不固定截断
   （参考 COMMAND_OUTPUT_LIMIT 模式 + task-adaptive-recoverable-timeout-plan.md）。
7. 持久化路径由 BABEL_O_CONFIG_FILE / BABEL_O_STORAGE_FILE 控制；测试统一用
   :memory: / 临时文件隔离，严谨写真实 ~/.babel-o/*（与 babel-o-test-config-isolation 一致）。
8. Skill 工具族命名以 skill-execution-and-automated-normalized-skill-generation-governance-plan.md
   为准（SkillList / SkillShow），本规划不重开 Skill 完整生命周期。
9. Go TUI 对话型工具（AskUserQuestionDialog）依赖 go-tui-loop-multipane-plan.md 先落地。
```

完成 P0 后，本规划转为 Watch / Closed。后续真实样本暴露以下 drift 时按 regression-first 重新开项：

- 模型选择错工具造成超时 / 失败（候选：工具描述改写 / cue 检测增强）。
- 同名 MCP 覆盖未被诊断日志记录（候选：`diagnosticLogger` 接口收紧）。
- Plan 模式被绕过（候选：`shouldEnterPlanMode()` cue 集合扩展，纯函数位于 `src/runtime/planModeCue.ts`）。
- Cron 触发后 spawn 的新 session 没有走 `task_scope_declared`（候选：cron 触发路径加 `runtimeAgentStep` 接入）。
- ConfigSet 写完后 model metadata resolver 未重跑（候选：在 `LLMCodingRuntime` 装配点加 reload hook）。
- Sleep 固定截断回潮（候选：CI 加 `test/sleep-tool.test.ts` 守门，禁止出现固定 `setTimeout(seconds * 1000)` 而无 `AbortSignal`）。
- test fixture 写入真实 `~/.babel-o/config.json`（候选：CI grep `process.env.BABEL_O_CONFIG_FILE` 守门）。
