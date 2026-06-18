# Tool Governance Reference Integration

> Superseded by [tool-governance-plan.md](../reference/tool-governance-plan.md). Keep this file for one cleanup cycle as a historical reader map; do not use it as the current tool governance source of truth.
>
> Status: Reference index — no implementation. This document is a **reader's map** for the three tool-governance plans in `docs/nexus/reference/`. It does not introduce new governance; it consolidates, cross-references, and arbitrates.
> Scope: cross-document consistency between the three tool-governance plans, naming arbitration, shared term alignment, and shared exit-gate aggregation.
> Last updated: 2026-06-16
> Audience: maintainers, prompt/agent architecture contributors, and reviewers touching any of the three plans.

---

## 1. 一句话定位

| 规划 | 一句话定位 | 治理对象 |
| --- | --- | --- |
| `tool-granularity-and-evidence-governance-plan.md` | **边界治理** | 既有工具的职责分层、证据语义、locator/理解/验证分层、Agent 命名 |
| `tool-surface-expansion-and-native-mcp-coexistence-plan.md` | **补齐治理** | 新增 native builtin 工具 + native vs MCP 双轨注册表 + 4 层优先级 |
| `skill-execution-and-automated-normalized-skill-generation-governance-plan.md` | **Skill 治理** | Skill 文件的规范化 schema / 显式调用 / 自动生成 / 持久化 |

三角关系（ASCII）：

```text
            ┌────────────────────────────────────────────┐
            │  边界治理（既有工具职责分层 / 证据语义）     │
            │  tool-granularity-and-evidence-governance  │
            └────────────────────┬───────────────────────┘
                                 │
            ┌────────────────────┴───────────────────────┐
            │                                            │
            ▼                                            ▼
┌──────────────────────────────┐         ┌──────────────────────────────┐
│  补齐治理                     │         │  Skill 治理                   │
│  tool-surface-expansion-     │         │  skill-execution-and-        │
│  and-native-mcp-coexistence  │         │  automated-normalized-skill- │
│                              │         │  generation-governance       │
│  • 5 个 P0 工具族             │         │  • SkillList / Show          │
│  • 4 层注册表                 │         │  • Validate / Draft / Save   │
│  • 22 个工具权限矩阵           │         │  • /skill 子命令             │
│  • 28 个 errorCode            │         │  • 4 类 session event        │
└──────────────────────────────┘         └──────────────────────────────┘
                                 │
                                 ▼
            ┌────────────────────────────────────────────┐
            │  共同约束（所有三份规划都遵守）                │
            │  • 不新增 Search / define_subagent 等        │
            │  • 失败/拒绝语义统一（COMMAND_OUTPUT_LIMIT） │
            │  • soft timeout + AbortSignal               │
            │  • errorCode 在 shared/errors.ts 登记       │
            │  • 测试隔离：BABEL_O_CONFIG_FILE / :memory: │
            │  • Skill 命名以 Skill 治理规划为准            │
            │  • P0 真实回归驱动                           │
            └────────────────────────────────────────────┘
```

---

## 2. 三份规划的关键节号索引

| 规划文件 | 关键节号 | 主题 |
| --- | --- | --- |
| `tool-granularity-and-evidence-governance-plan.md` | §1 背景 | 9 个 builtin + 4 个 Agent 工具 |
| | §2 当前判断 | 2.1 不新增 `Search` / 2.2 `ListDir` 落地 / 2.3 不新增 `define_subagent` |
| | §3 治理泛化问题 | 3.1 Evidence Scope Drift / 3.2 Bash-as-discovery / 3.3 Locator fallback / 3.4 Grep parameter drift / 3.5 Tool Name Fragmentation |
| | §4 工具分层原则 | 4.1 定位/理解/验证分层 / 4.2 强声明约束表 |
| | §5 分阶段优化 | Phase A–D（已完成 A/B.5/D） |
| | §9 决策摘要 | "不新增 Search / define_subagent" |
| `tool-surface-expansion-and-native-mcp-coexistence-plan.md` | §1 背景 | 9 个 builtin 缺口 + 4 层注册表 |
| | §2 设计原则 | 2.1 补齐判定 / 2.2 4 层注册表 / 2.3 命名 / 2.4 持久化 / **2.5 失败/拒绝语义** |
| | §3 工具补齐 | 3.1 P0（5 族） / 3.2 P1（4 族） / **3.3 权限矩阵** / **3.4 事件矩阵** / 3.5 P2 观察期 |
| | §4 目录树 | `src/tools/builtin/task/` 等 |
| | §5 分阶段 | Phase 0–7 |
| | §7 优先级 + **7.1 三段验证** | |
| | §8 验证标准 | 8.1 通用守门 + 8.2–8.8 Phase 守门 |
| `skill-execution-and-automated-normalized-skill-generation-governance-plan.md` | §Status / Executive summary | |
| | §Current state | 已有 loader / matcher / contextAssembler / systemPromptBuilder |
| | §Goals / Non-goals / Design principles | "Skill as instruction, not bypass" |
| | §Proposed target capability | `/skill list/show/run/validate/draft/capture/save` |
| | §Proposed skill schema | normalized front matter 字段表 |
| | §Recommended body template | 7 段模板 |
| | §Architecture proposal | Layer 1 skill domain / Layer 2 runtime / Layer 3 Nexus API / Layer 4 Go TUI |
| | §Session events | `skill_matched` / `skill_invoked` / `skill_validation` / `skill_saved` |
| | §Permission model | skill metadata is advisory / SkillSave is write-risk |
| | §Implementation phases | Phase 0–6 |
| | §Migration plan | 5 个 built-in skill 迁移顺序 |
| | §Acceptance criteria | 8 条 |

---

## 3. 共同术语表（三份规划统一口径）

| 术语 | 共同定义 | 引用 |
| --- | --- | --- |
| `risk` | `'read' \| 'write' \| 'execute' \| 'task' \| 'network'` | 补齐治理 §2.4 / 边界治理 §4 / Skill 治理 §Proposed schema (`risk` 字段) |
| `requiresApproval` | bool，permission gate | 补齐治理 §3.3 权限矩阵 |
| `tool policy` | runtime authoritative；skill `allowedTools` 是 advisory | Skill 治理 §Permission model |
| `soft timeout` | `signal: AbortSignal` 控制；工具内部不固定截断 | 补齐治理 §2.5（参考 `task-adaptive-recoverable-timeout-plan.md`） |
| `errorCode` | 必须在 `src/shared/errors.ts` 登记；测试断言 | 补齐治理 §2.5 / 边界治理 §3.3（recoverable diagnostic） |
| `failureKind` | `loop_limit` / `context_overflow` / `tool_error` / `permission_denied` / `provider_unavailable` | 补齐治理 §2.5 |
| `evidence scope` | 实际证据 < 强声明时降级回答 | 边界治理 §3.1 / §4.2 强声明约束表 |
| `registry layer` | Layer 1 native → Layer 2 MCP → Layer 3 EverCore → Layer 4 AgentScheduler | 补齐治理 §2.2 / §4 |
| `mcp:evercore:*` | Layer 3 只能覆盖同前缀；不跨前缀 | 补齐治理 §2.2 |
| `tool_overridden_by` | 同名覆盖必须出现在 `embedded-nexus.log` | 补齐治理 §2.2 / §8.5 |
| `active developer skills` | system prompt 注入的隐式 skill 块 | Skill 治理 §Current state / 边界治理（注入层） |
| `explicit vs implicit` | `/skill run` / `SkillRun` 是 explicit；trigger match 是 implicit | Skill 治理 §Explicit skill invocation semantics |
| `Babel-2 兼容性` | 命名沿用 Babel-2（`TaskCreate` / `TaskStop` 等），避免破坏跨工具训练预期 | 补齐治理 §3.1.1 / 边界治理 §3.5 |
| `task_scope_declared` | Plan 模式 / cron 触发的新 session 必须 emit | 补齐治理 §3.1.5 / §3.2.4 |

---

## 4. 工具名映射表

下表列出三份规划中**同名 / 近义 / 互斥**的工具名映射。**冲突时**按"谁定 primary name"列仲裁。

| 工具名 | 出处 | 类别 | 仲裁结果（primary name + 备注） |
| --- | --- | --- | --- |
| `Task` | 边界治理 §1（既有）/ 补齐治理 §3.1.1（拆分） | 同名 | 补齐治理治理范围：拆为 `TaskCreate` / `TaskGet` / `TaskList` / `TaskUpdate` / `TaskStop` / `TaskOutput`；旧 `Task` 单名仅作 alias 保留。 |
| `ListDir` | 边界治理 §2.2（已落地）/ 补齐治理 §4（canonical） | 同名 | 补齐治理 §4 决定：`listDir.ts` 为 canonical；旧 `list_dir.ts` 重复文件在 Phase 0 删除。 |
| `SkillLoad` | 补齐治理 §3.1.4（旧版草稿） | 旧命名 | **已修订为 `SkillShow`**（与 Skill 治理 §Architecture proposal Layer 1 + Phase 6 命名一致）。 |
| `SkillList` / `SkillShow` / `SkillValidate` / `SkillDraft` / `SkillSave` | Skill 治理 §Design principles / Phase 6 | primary | 补齐治理 §3.1.4 标注"以 Skill 治理为准"，不重开完整生命周期。 |
| `Search` | 边界治理 §2.1（不新增） | 互斥 | **不新增**；`Grep` 承担内容搜索。 |
| `define_subagent` / `invoke_subagent` | 边界治理 §2.3（不新增）/ 补齐治理 §7（不做） | 互斥 | **不新增**；Agent 生命周期由 `AgentSpawn` / `AgentWait` / `AgentList` / `AgentCancel` 承担。 |
| `AgentSpawn` / `AgentWait` / `AgentList` / `AgentCancel` | 边界治理 §1 / 补齐治理 §4 Layer 4 | 同名 | primary name；不引入 `delegate` / `SubagentStart` 等别名（边界治理 §3.5）。 |
| `Bash` | 边界治理 §4.1 / 补齐治理 §1 | 同名 | 一致；`COMMAND_OUTPUT_LIMIT` 失败模式是 §2.5 失败语义的参考实现。 |
| `Grep` | 边界治理 §3.3 / §3.4 / §4.1 | 同名 | 边界治理主导；`pathMatches` 只接受 file glob，禁止 boolean string。 |
| `Glob` / `Read` / `Write` / `Edit` | 三份规划都引用 | 同名 | 一致；无歧义。 |
| `WebSearch` | 补齐治理 §3.2.2 | provider 抽象 | 唯一名称 `WebSearch`；不暴露 provider 列表（`mcp:web_search` / `mcp:brave_search` / `ddgLite` 内部切换）。 |
| `MCPTool` / `ListMcpResources` / `ReadMcpResource` | 补齐治理 §3.1.3 | primary | 命名 **不**使用 `mcp:` 前缀（这是 native builtin，不是 MCP 工具）。 |
| `EnterPlanMode` / `ExitPlanMode` | 补齐治理 §3.1.5 | primary | 装配点在 `LLMCodingRuntime`，非 `runtimeAgentStep.ts`。 |
| `WorktreeCreate` / `WorktreeRemove` | 补齐治理 §3.2.1 | primary | 命名沿用 Babel-2 `EnterWorktree` / `ExitWorktree`，但工具本身不绑死 AgentScheduler。 |
| `ConfigGet` / `ConfigSet` | 补齐治理 §3.2.3 | primary | 路径由 `$BABEL_O_CONFIG_FILE` 控制；测试用 `BABEL_O_CONFIG_FILE=/tmp/...` 隔离。 |
| `Sleep` / `ScheduleCronCreate` / `ScheduleCronDelete` / `ScheduleCronList` | 补齐治理 §3.2.4 | primary | `Sleep` 软上限 60s + `BABEL_O_SOFT_SLEEP_MAX_SECONDS` env；trigger 新 session 走 `task_scope_declared`。 |

---

## 5. 共同约束（七条）

所有三份规划都遵守的硬约束。任何一份的子规划**不得**违反。

### 5.1 不新增重复 / 模糊命名

参考边界治理 §2 / §3.5、Skill 治理 §Design principles 4（"Orthogonal tools"）、补齐治理 §7 决策摘要 1：

- 不新增 `Search` / `define_subagent` / `invoke_subagent` / `delegate`。
- Skill 工具族以正交、bounded 子工具（`SkillList` / `SkillShow` / `SkillValidate` / `SkillDraft` / `SkillSave`）为准，**不**用单一 `Skill` 工具。
- 新增 native builtin 必须满足 §2.1 判定标准（生态一致性 / 不可由现有工具表达 / 治理需要），且必须有真实 regression 引用（`babel-o-p0-regression-focus` 记忆）。

### 5.2 失败 / 拒绝语义统一（不 throw 终止 session）

参考补齐治理 §2.5（参考实现：`src/tools/builtin/bash.ts` 的 `COMMAND_OUTPUT_LIMIT`，commit `f369535`）、边界治理 §3.3（recoverable diagnostic）、Skill 治理 §Permission model（skill metadata is advisory）：

- 失败必须返回 `{ success: false, errorCode, message, ... }`，**不** throw。
- `errorCode` 必须在 `src/shared/errors.ts` 字典登记。
- message 必须含可恢复引导（参考 COMMAND_OUTPUT_LIMIT 模式）。
- soft timeout：所有工具接受 `signal: AbortSignal`；超时由调用方（`LLMCodingRuntime` / `runtimeAgentStep.ts`）通过 `AbortController` 触发。
- 失败码语义：`loop_limit` / `context_overflow` / `tool_error` / `permission_denied` / `provider_unavailable`。

### 5.3 测试隔离守门

参考 `babel-o-test-config-isolation` 记忆 + 补齐治理 §2.4 / §8.1 + Skill 治理 §Security and persistence tests：

- 配置写入：`BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-<pid>.json`；CI grep `~/.babel-o/config.json` 写入守门。
- SQLite / storage：`BABEL_O_STORAGE_FILE=:memory:`；list / get / task 工具测试不写真实库。
- Skill save：user-scope save 永不写真实 `~/.babel-o/skills`；project-scope save 用 test temp cwd。
- WebSearch provider 切换：`BABEL_O_LOG_DIR` 控制 log 路径，避免污染真实 `~/.babel-o/log/`。

### 5.4 Skill 治理为准的命名 / 行为优先

- 任何关于 `Skill*` 工具的命名 / 行为，**以** `skill-execution-and-automated-normalized-skill-generation-governance-plan.md` 为准。
- 补齐治理 §3.1.4 仅实现 `SkillList` / `SkillShow` 两子工具；`SkillValidate` / `SkillDraft` / `SkillSave` 由 Skill 治理 §Phase 6 主导。
- Skill 治理 §Permission model 明确 "skill metadata is advisory"：skill 的 `risk` / `allowedTools` **不能绕过** runtime tool policy。

### 5.5 P0 真实回归驱动（起草前 / 实施中 / 实施后三段验证）

参考 `babel-o-p0-regression-focus` 记忆 + 补齐治理 §7.1：

- 起草前：每个 P0 工具入口必须在 `WORK_LOG.md` / session log 中有真实 regression 引用（session id 或 log 路径）；否则降为 P1。
- 实施中：每个子工具落地后立即跑对应 unit test + 与既有测试集合并跑；不允许"全部完成后再一起测"。
- 实施后：引用 regression log 关闭对应 issue / TODO；若未关闭，Phase 不算 Closed。

### 5.6 持久化路径由 env 控制（不绑死 ~/.babel-o）

参考补齐治理 §2.4 / §3.2.3 / §3.2.4 + Skill 治理 §Permission model：

- 配置文件：`$BABEL_O_CONFIG_FILE`（默认 `~/.babel-o/config.json`）。
- Storage：`$BABEL_O_STORAGE_FILE`（默认 `~/.babel-o/db.sqlite`）。
- Skill 保存：project `<cwd>/.babel-o/skills/<id>.md` / user `$BABEL_O_USER_SKILLS_DIR/<id>.md`。
- 测试统一用临时文件 / `:memory:` 隔离（见 §5.3）。

### 5.7 装配点治理（避免改写职责）

- 工具白名单收窄（如 `mode='plan'`）：装配点在 `LLMCodingRuntime`，**不是** `runtimeAgentStep.ts`（补齐治理 §3.1.5 修订）。
- settings 摘要注入：装配点在 `LLMCodingRuntime`（补齐治理 §3.2.3 修订）。
- Skill 注入：装配点在 `runtime/contextAssembler.ts` + `systemPromptBuilder.ts`（Skill 治理 §Layer 2）。
- Agent loop 与 skill 集成：planner/executor/critic 把 skill 当作 task guidance，**不**拉独立 session（Skill 治理 §Interaction with agent loop）。

---

## 6. 冲突与仲裁

下面列出三份规划**潜在冲突点**与仲裁规则。仲裁原则：**谁的范围更具体，谁的结论胜出；但共同约束（§5）永远胜出**。

### 6.1 `SkillLoad` vs `SkillShow`

- **冲突点**：补齐治理 §3.1.4 旧版用 `SkillLoad`；Skill 治理 §Architecture proposal Layer 1 + Phase 6 用 `SkillShow`。
- **仲裁**：以 Skill 治理为准（`SkillShow`），已在补齐治理 §3.1.4 修订。共同约束 §5.4 兜底。

### 6.2 工具白名单装配点：`runtimeAgentStep.ts` vs `LLMCodingRuntime`

- **冲突点**：补齐治理 §3.1.5 旧版写"runtimeAgentStep.ts 的 critic 评审流获得 mode='plan' 信号"；实际装配点在 `LLMCodingRuntime`。
- **仲裁**：以 `LLMCodingRuntime` 为准。共同约束 §5.7 兜底。已在补齐治理 §3.1.5 / §3.2.3 修订。

### 6.3 `shouldEnterPlanMode` cue 函数归属

- **冲突点**：补齐治理 §3.1.5 旧版写"复用 `runtime/memoryProvider.ts` 的 cue 思路"；Skill 治理中类似纯函数（`shouldAutoSearchMemory`）属于 `memoryProvider.ts`。
- **仲裁**：拆为 `src/runtime/planModeCue.ts` 纯函数，**不**复用 `memoryProvider.ts` 内部代码（职责分离）。已在补齐治理 §3.1.5 / §4 修订。

### 6.4 `ListDir` 命名

- **冲突点**：边界治理 §2.2 一直用 `ListDir`；补齐治理 §4 目录树同时出现 `listDir.ts` 和 `list_dir.ts`。
- **仲裁**：`listDir.ts` 为 canonical；`list_dir.ts` 重复文件在 Phase 0 删除。已在补齐治理 §4 / §8.2 修订。

### 6.5 同名 native vs MCP 覆盖行为

- **冲突点**：补齐治理 §2.2 规定"后注册覆盖前注册 + 诊断日志"；边界治理 §3.5 关心"工具越多选择负担越大"。
- **仲裁**：补齐治理的覆盖规则胜出（更具体），但边界治理的"不新增"原则仍适用——新工具的 native 形态**优先**于 MCP 形态暴露，避免 fallback 后漂移。共同约束 §5.1 兜底。

### 6.6 Skill `allowedTools` 与 `requiresApproval`

- **冲突点**：Skill 治理 §Permission model 写 "skill metadata is advisory"，但允许 `allowedTools` 出现在 front matter；补齐治理 §3.3 权限矩阵规定 `requiresApproval` 是 hard gate。
- **仲裁**：`allowedTools` 是治理 hint（advisory），`requiresApproval` 是 hard gate。**两套系统并行**，但 runtime policy 始终权威。共同约束 §5.2 / §5.4 兜底。

### 6.7 WebSearch 切换 provider 的语义

- **冲突点**：补齐治理 §3.2.2 写 "provider 切换走 §2.2 的后注册覆盖 + 诊断日志"；用户可能期望 `WebSearch` 是单名稳定工具。
- **仲裁**：`WebSearch` 名称稳定（用户侧无感），但底层 provider 切换必须出现在 `embedded-nexus.log` INFO 行 + 测试 fixture 守门。已在补齐治理 §3.2.2 修订。

### 6.8 Cron 触发新 session 的会话事件

- **冲突点**：补齐治理 §3.2.4 写 "cron 触发时启动新 session"；task-scope-and-evidence-scope-governance-plan 规定 "Plan / cron 触发的新 session 必须 emit `task_scope_declared`"。
- **仲裁**：两套约束**叠加**——cron 触发的新 session 走 `task_scope_declared` 守门。已在补齐治理 §3.2.4 / §8.7 修订。

---

## 7. 三段验证守门汇总

| 阶段 | 边界治理 | 补齐治理 | Skill 治理 |
| --- | --- | --- | --- |
| **起草前** | 每个 P0 工具入口有真实 regression 引用 | §5 Phase 0 收口 + §7.1 | §Recommended immediate next steps + §Acceptance criteria |
| **实施中** | 每子工具落地后立即跑对应 unit test | §5 Phase 1–6 收口标准 | §Testing strategy（unit / runtime / Nexus API / Go TUI / security） |
| **实施后** | 引用 regression log 关闭 issue | §5 Phase 7 + §8 验证标准 | §Acceptance criteria（8 条） |

**通用守门（所有 Phase 都跑）**：

- `npm run typecheck` / `npm run format:check` / `npm run lint` 通过。
- `BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config-<pid>.json` 隔离守门。
- `BABEL_O_STORAGE_FILE=:memory:` 隔离守门。
- `src/shared/errors.ts` 的 errorCode 字典在每个 Phase 收口前更新。
- 现有 100+ 测试不回归。

---

## 8. 引用索引

### 8.1 内部 reference 规划

| 规划 | 路径 | 关系 |
| --- | --- | --- |
| 边界治理 | `docs/nexus/reference/tool-granularity-and-evidence-governance-plan.md` | "既有工具"主规划 |
| 补齐治理 | `docs/nexus/reference/tool-surface-expansion-and-native-mcp-coexistence-plan.md` | "新工具 + MCP"主规划 |
| Skill 治理 | `docs/nexus/reference/skill-execution-and-automated-normalized-skill-generation-governance-plan.md` | "Skill 文件 / 工具族"主规划 |
| Task scope | `docs/nexus/reference/task-scope-and-evidence-scope-governance-plan.md` | Plan / cron 触发新 session 守门 |
| Soft timeout | `docs/nexus/reference/task-adaptive-recoverable-timeout-plan.md` | §2.5 失败语义对齐 |
| Model catalog | `docs/nexus/reference/model-catalog-and-context-metadata-governance-plan.md` | ConfigSet 后 model metadata resolver reload |
| Memory cue | `docs/nexus/reference/memory-capability-awareness-and-trigger-plan.md` | `shouldEnterPlanMode` 思路参考 |
| Go TUI 权限 | `docs/nexus/reference/go-tui-permission-policy-governance-plan.md` | `MCPTool` / `AskUserQuestion` 走 `permission_request.source` |
| Go TUI 多面板 | `docs/nexus/reference/go-tui-loop-multipane-plan.md` | `AskUserQuestionDialog` 依赖 |

### 8.2 失败/拒绝语义的参考实现

- `src/tools/builtin/bash.ts` 的 `COMMAND_OUTPUT_LIMIT`（commit `f369535`）：Bash 输出超 `maxBuffer` 时返回 `outputLimited: true` + 部分 UTF-8 安全预览 + 原始字节数 + 引导信息。所有新工具按此模式实现（补齐治理 §2.5）。

### 8.3 实施 / 跟踪

- `docs/nexus/TODO.md`：三份规划的入口登记。
- `active/TODO_runtime.md`：P0/P1/P2 工具补齐未收口项。
- `active/TODO_agents.md`：AgentScheduler 工具命名继承。
- `DONE.md`：归档已完成的 Phase。
- `WORK_LOG.md`：Phase 1–6 事实流水。

---

## 9. 决策摘要

```text
三角关系：
1. 边界治理 = "既有工具职责分层 / 证据语义"（不新增 Search / define_subagent）。
2. 补齐治理 = "新工具 + native vs MCP 双轨注册表"（5 个 P0 + 3 个 P1 + 1 个 P2 观察）。
3. Skill 治理 = "Skill 文件 / 工具族"（SkillList/Show/Validate/Draft/Save）。

共同约束（全部胜出）：
- 不新增重复 / 模糊命名。
- 失败/拒绝语义统一（不 throw + errorCode 登记 + 可恢复引导 + soft timeout）。
- 测试隔离守门（BABEL_O_CONFIG_FILE / :memory:）。
- Skill 治理命名 / 行为优先。
- P0 真实回归驱动（三段验证）。
- 持久化路径由 env 控制。
- 装配点治理（避免改写职责）。

冲突仲裁原则：
- 谁的范围更具体，谁胜出。
- 共同约束（§5）永远胜出。
```

---

## 10. 维护说明

- 本文档**不**引入新治理规则；任何治理变更必须落到三份主规划之一，本文档只更新引用 / 仲裁 / 共同约束摘要。
- 三份主规划的 §6 "与现有文档的关系" 都应引用本文件作为整合索引。
- 当三份主规划出现新的冲突时，先按 §6 仲裁流程解决；如新冲突无法用 §6 覆盖，升级到本文档新增一条仲裁规则。
