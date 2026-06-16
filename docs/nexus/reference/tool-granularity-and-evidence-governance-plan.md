# Tool Granularity and Evidence-grounded Reading Plan

> Status: P2 partially implemented — `ListDir` landed; TypeScript `Grep` fallback regex/no-result diagnostics landed
> Priority: P2 unless promoted by a real-session regression
> Scope: built-in tool granularity, `ListDir` / `Glob` / `Grep` / `Read` evidence semantics, and AgentScheduler tool naming governance
> Related plans: `tool-governance-reference-integration.md` is the reader's map for the three tool-governance plans (granularity / expansion / skill); this file is the *boundary* counterpart to `tool-surface-expansion-and-native-mcp-coexistence-plan.md` (the *expansion* counterpart) and is the granularity basis that `skill-execution-and-automated-normalized-skill-generation-governance-plan.md` §5 Layer 5 tool boundary inherits. Any cross-document conflict on `ListDir` / `Glob` / `Grep` / `Read` boundaries, `Search` rejection rationale, or AgentScheduler naming should be arbitrated in the integration document.

---

## 1. 背景

BabeL-O 当前已经具备一套较完整的模型可见工具：

- `ListDir`
- `Glob`
- `Grep`
- `Read`
- `Write`
- `Edit`
- `Bash`
- `Task`

AgentScheduler 侧也已经具备模型可见 Agent job 生命周期工具：

- `AgentSpawn`
- `AgentWait`
- `AgentList`
- `AgentCancel`

因此当前问题不是“缺少所有细分工具”，而是：

1. 模型是否会把 `Grep` 命中当成完整理解。
2. 模型是否会把 truncated `Read` 当成完整读取。
3. 模型是否会为了目录发现而使用 `Bash ls/find`，造成不必要的权限噪音。
4. 专用 locator 工具失败或 fallback 能力不足时，模型是否会退回 broad Bash scan 并触发 timeout / fatal failure。
5. 是否应该把 `Search`、`ListDir`、`define_subagent`、`invoke_subagent` 这类更细名称加入工具表。
6. 如何避免工具越加越多，反而增加模型选择负担和 schema token 成本。

本规划的核心结论是：**工具职责应该正交细分，但不应重复命名；`ListDir` 已作为目录 inventory 结果契约落地，`Search` 这类与 `Grep` 重叠的工具仍不新增，`define_subagent` / `invoke_subagent` 仍不新增。**

---

## 2. 当前判断

### 2.1 不新增 `Search`

`Search` 与现有 `Grep` 语义高度重叠。当前 `Grep` 已经承担内容搜索、符号定位、错误定位、文件候选发现等职责。

如果新增 `Search`，主要风险是：

- 模型在 `Search` / `Grep` 之间产生不必要选择分歧。
- 工具 schema 增加 token 成本。
- 回归测试需要覆盖两套近似语义。
- 未来一旦两者输出格式或预算策略不同，会引入新的治理分叉。

正确方向是让 `Grep` 更明确地表达：**Grep 只定位候选，不代表已经理解文件内容。**

### 2.2 `ListDir` 已作为目录 inventory 工具落地

`ListDir` 已从候选项转为一阶内置工具，用于表达 `Glob` 不应承担的结构化目录 inventory 结果契约：目录形状、直接子项、类型、counts、truncated 与 skipped diagnostics。

它的边界是：

- `ListDir`：目录 inventory，不做 pattern matching，不读取文件内容。
- `Glob`：跨路径 pattern / substring file discovery，不表达目录层级完整性。
- `Grep`：文件内容 locator，不代表源码理解。
- `Read`：已知文件路径上的 source understanding。
- `Bash`：执行测试、构建、运行或无法由安全内置工具表达的命令。

实现约束：`ListDir` 是 read-only、workspace-safe、默认 `maxDepth=1`、最多 `maxDepth=2`、stable directories-first ordering、跳过 dependency/build/cache 目录，并同时在 TypeScript runtime 与 Go Remote Runner read-only backend 中保持能力一致。

### 2.3 不新增 `define_subagent` / `invoke_subagent`

BabeL-O 已经通过 AgentScheduler 暴露 agent job 生命周期：

- `AgentSpawn` = 创建 / 启动 child agent job。
- `AgentWait` = 等待 child agent 结果。
- `AgentList` = 查看当前 agent jobs。
- `AgentCancel` = 取消 agent job。

`define_subagent` 和 `invoke_subagent` 这类命名会与现有 AgentScheduler 体系重复，且容易让模型以为可以动态定义任意 agent 能力、权限或角色。

当前正确口径是：

- Agent 类型、权限、上下文 fork、可用工具由 Nexus / AgentScheduler profile 控制。
- 模型只能选择已治理的 `agentType` 与 `contextForkMode`。
- 不允许模型在普通对话中动态创建未治理的 agent profile。

---

## 3. 需要治理的泛化问题

### 3.1 Evidence Scope Drift

定义：

```text
实际证据覆盖范围 < 最终回答声称的确定性或覆盖范围
```

典型表现：

- 把 `Grep` 命中当成完整源码理解。
- 把 `Read` preview / truncated result 当成完整文件读取。
- 把局部 diff 当成完整变更动机。
- 把诊断指标当成 runtime 行为事实。
- 在没有读完整相关实现前声称“已经全面确认”。

这类问题不应通过简单新增工具名解决，而应通过工具输出语义、prompt guidance 和强声明约束共同治理。

### 3.2 Bash-as-discovery 权限噪音

当模型想做只读目录探索时，如果默认选择 `Bash ls/find/tree`，会带来三个问题：

1. 只读探索触发不必要审批。
2. shell 输出预算和目录跳过策略不可控。
3. 模型可能绕过 `Glob` / `Read` 的路径安全、预算和重复读取提示。

治理优先级：

1. `ListDir` 已作为 bounded directory inventory 工具落地，目录结构探索不再依赖 shell。
2. 强化 `Glob` / `Grep` 作为 path/content locator 的提示与失败诊断。
3. 不把 shell discovery 作为默认推荐路径。
4. 对 `grep -r` / `find` / `ls -R` 这类 broad file-search shell 命令，优先通过 permission explanation、classifier hint 或 runtime recoverable failure 引导模型缩小 scope 或改用专用工具。

### 3.3 Locator fallback degradation

真实样本 `session_122f07b9-8ed5-4b2a-a949-e0de0b9fcb91` 暴露了一个比“模型偏好 Bash”更具体的链路：

1. 用户要求深入分析 `ContextForker`。
2. 模型先使用 `Read` 和内置 `Grep`。
3. 内置 `Grep` 对 `ContextForker|forkContext|contextFork` 返回空结果。
4. 模型退回 `Bash grep -rln -E ...`，第一次限定 `src/test` 成功，第二次扩大到整个 repo 后因 SIGTERM timeout 导致 session fatal failed。

该链路说明：专用 locator 工具如果 fallback 能力不足或 no-result 诊断不清，会把模型推向更高风险、更不可控的 shell discovery。

治理口径：

- `Grep` fallback 必须尽量保持与 ripgrep 的基础 regex parity，至少支持 alternation 这类常见定位表达。
- 如果 fallback 不能完全等价，输出必须标注 fallback mode / capability limit，不能只返回空字符串。
- Bash timeout / SIGTERM 对普通命令应返回结构化失败 tool result，而不是直接让 session fatal。
- Broad workspace shell scan 应提示缩小目录或改用 `ListDir` / `Glob` / `Grep`。

### 3.4 Grep parameter contract drift

真实样本 `session_303c7221-8cc3-4251-9436-4215244120e4` 暴露了 Grep 参数语义缺口：provider 先多次生成重复 `pathMatches` 字段导致 tool input JSON parse error，随后把 `pathMatches` 修正为字符串 `"true"`。该值满足 schema 的 string 约束，但 `pathMatches` 的真实语义是 file glob filter，会被 ripgrep 当作 `--glob true`，从而返回空结果。

治理口径：

- `pathMatches` 只接受 file glob 意图，例如 `**/*.ts`、`**/package.json`。
- boolean-string `"true"` / `"false"` 不是有效 glob 意图，应返回 recoverable diagnostic，而不是执行一个极易误导的空搜索。
- 如果要搜索所有文件，应省略 `pathMatches`，而不是传 `true`。
- malformed tool JSON 仍属于 provider tool-call generation drift；runtime parse error 已可恢复，后续只在重复复现时考虑更强 repair diagnostics。

### 3.5 Tool Name Fragmentation

工具名越多，不一定越好。过细工具会带来：

- 模型选择负担。
- prompt/schema 成本增加。
- 近似工具间行为漂移。
- 权限策略重复。
- 测试矩阵膨胀。

因此新增工具必须满足：

```text
新增工具解决的是现有工具无法表达的边界，而不是给既有能力换一个名字。
```

---

## 4. 工具分层原则

### 4.1 定位 / 理解 / 验证分层

```text
ListDir = inspect bounded directory inventory and hierarchy
Glob    = discover candidate files by path pattern or substring
Grep    = locate candidate lines or symbols inside files
Read    = understand source content within explicit ranges
Bash    = execute commands or validations that cannot be represented by safer tools
Agent   = delegate bounded child jobs with governed profiles
```

模型可见 guidance 应持续强化：

- `ListDir` 是目录 inventory 证据。
- `Glob` / `Grep` 是 locator。
- `Read` 才是 source understanding 的证据。
- 测试 / lint / build 结果才是 validation evidence。
- `Bash` 不应用于能由 `ListDir` / `Glob` / `Grep` / `Read` 表达的只读发现。

### 4.2 强声明约束

当模型给出以下强声明时，必须有对应证据：

| 强声明 | 最低证据 |
| --- | --- |
| “完整读取了文件” | `Read` 未截断，或明确读取了覆盖范围 |
| “没有其他引用” | 有 targeted `Grep` / `Glob` 结果，且说明搜索范围 |
| “这个路径不存在” | 有路径发现或读取失败证据 |
| “测试通过” | 有实际测试命令结果 |
| “工具链不需要改” | 已读取相关注册、执行和权限路径 |

如果证据不足，回答必须降级为：

- “我只确认了……”
- “当前证据显示……”
- “还需要读取/运行 X 才能确认……”

---

## 5. 分阶段优化方案

### Phase A: 文档口径与工具命名治理

状态：本规划承接。

目标：

- 明确不新增重复 `Search`。
- 明确不新增重复 `define_subagent` / `invoke_subagent`。
- 记录 bounded `ListDir` 已作为正交细分工具落地。
- 将 Evidence Scope Drift 纳入工具治理，而不是作为单一会话事故处理。

收口标准：

- `TODO.md` 增加本规划入口。
- `active/TODO_runtime.md` 增加 P2 工具粒度 / evidence-grounded reading 未收口项。
- 已完成 Tool Discovery / Targeted Reading 第一阶段归档到 `DONE.md`。

### Phase B: `ListDir` / `Glob` / `Grep` / `Read` prompt 与输出语义增强

状态：第一片已实现。

已落地：

1. `ListDir` prompt 明确 directory inventory-only。
2. `Glob` prompt 明确 path-pattern file discovery，不再承担目录 inventory。
3. `Grep` prompt 明确 locator-only：命中只代表候选位置，不能替代 `Read` 对源码行为的理解。
4. `Read` prompt 明确 source-understanding-only，并在目录错误提示中引导使用 `ListDir`。
5. Runtime system prompt 已要求只读目录探索优先 `ListDir`，pattern discovery 用 `Glob`，content locating 用 `Grep`，source understanding 用 `Read`。

仍可评估：

- 工具结果显示中增加 lightweight evidence hint：`directory-inventory`、`locator-only`、`partial-read`、`full-read`、`validation-result`。

### Phase B.5: `Grep` fallback regex parity / no-result diagnostics

状态：已实现。

样本：`session_122f07b9-8ed5-4b2a-a949-e0de0b9fcb91`。

已落地：`Grep` 优先使用可选安装的 bundled ripgrep（`@vscode/ripgrep`），其次使用系统 PATH 中的 `rg`，最后才使用 JavaScript `RegExp` fallback；工具 schema 显式支持 `pathMatches` glob 过滤，避免模型把该字段当成非正式输入。TypeScript fallback 在 ripgrep 不可用时支持 `ContextForker|forkContext|contextFork` 这类基础 regex alternation；fallback 命中结果会标注 fallback mode / locator-only guidance，no-result 与 invalid-regex 也返回明确 diagnostics，不再用空字符串伪装完整 locator 证据。

验证：`test/runtime.test.ts` 覆盖 `rg` unavailable fixture、direct `grepTool` fallback alternation 命中与 no-result diagnostics；`test/grep-tool.test.ts` 覆盖 bundled/system/fallback-capable execution 下的 `pathMatches` 与 alternation 查询。

### Phase B.6: Bash timeout recoverability / broad file-search 降级

状态：已实现。

样本：`session_122f07b9-8ed5-4b2a-a949-e0de0b9fcb91`。

问题：模型执行全仓库 `grep -rln ... | head -50` 后被 SIGTERM，Bash 工具当前把 signal timeout 作为 throw，runtime 产出 `TOOL_ERROR` 并把 session 标记为 failed。

已落地：

- 普通 Bash command timeout / SIGTERM 返回 `tool_completed(success=false)`，输出结构化 `COMMAND_TIMEOUT`、`timedOut`、`signal`、stdout/stderr 摘要与 command summary，而不是 session fatal。
- 外部 request abort 仍保留 runtime cancellation path，不被 Bash timeout recovery 吞掉。
- 对 `ls` / `ls -R` / `find` / `tree` / `grep -r` / `rg` 等 read-only discovery 命令输出 `BASH_AS_FILE_DISCOVERY` guidance，提示缩小 path 或改用 `ListDir` / `Glob` / `Grep` / `Read`。

### Phase C: Source Coverage Ledger / Strong Claim Guard

状态：候选项，需真实回归继续驱动。

目标：让 runtime 或 context diagnostics 记录模型本轮实际掌握的证据范围。

可选设计：

```typescript
type SourceCoverageRecord = {
  path: string
  ranges: Array<{ startLine?: number; endLine?: number }>
  fullFile: boolean
  truncated: boolean
  evidenceSource: 'Read' | 'Grep' | 'Glob' | 'Bash' | 'AgentResult'
}
```

用途：

- `/context` 展示本轮读取覆盖。
- final answer guidance 提醒模型不要过度声明。
- AgentResult 汇总 child agent 的 evidence coverage。

风险：

- 容易演化成复杂审计系统。
- 如果没有真实回归驱动，可能过早增加 runtime 状态复杂度。

因此本阶段只作为 P2 候选，不作为立即实现项。

### Phase D: bounded `ListDir`

状态：已实现。

已实现 schema：

```typescript
type ListDirInput = {
  path: string
  maxEntries?: number
  includeHidden?: boolean
  includeFiles?: boolean
  includeDirectories?: boolean
  maxDepth?: 1 | 2
}
```

已落实硬约束：

- read-only。
- workspace path safety。
- 默认 depth=1，最大 depth=2。
- 默认跳过 dependency/build/cache 目录。
- stable directories-first sorted output。
- 输出 entries、counts、truncated、skippedDirs 与 guidance。
- 不执行 shell。
- 不替代 `Glob` 的 pattern matching，也不替代 `Read` source understanding。
- Agent Explore/Review/Test 默认工具白名单与 Go Remote Runner read-only capabilities 均已同步。

### Phase E: Agent tool naming stability

状态：持续治理。

当前保留：

- `AgentSpawn`
- `AgentWait`
- `AgentList`
- `AgentCancel`

不新增：

- `define_subagent`
- `invoke_subagent`
- `delegate`

原因：

- 当前命名已经覆盖 job lifecycle。
- `define_subagent` 会误导模型动态创建未治理 profile。
- `invoke_subagent` 与 `AgentSpawn` 重复。

未来如需 child transcript 工具，应沿用 AgentScheduler 命名体系，例如：

- `AgentTranscript`

而不是新建一套 subagent vocabulary。

---

## 6. 与现有文档的关系

| 文档 | 关系 |
| --- | --- |
| `active/TODO_runtime.md` | 承接 P2 工具粒度、Evidence Scope Drift 与 `ListDir` 已落地后的证据治理 follow-up。 |
| `active/TODO_agents.md` | 保持 AgentScheduler 工具命名，不新增 `define_subagent` / `invoke_subagent`。 |
| `reference/context-and-subagent-upgrade-plan.md` | AgentScheduler / AgentJob / ContextForker 的主规划；本文件只处理工具命名和 evidence 语义。 |
| `DONE.md` | 归档已完成的 Tool Discovery / Targeted Reading 第一阶段。 |
| `archive/TODO_tool_result_budget.md` | 历史工具结果预算设计；本文件不重开该已完成专项。 |

---

## 7. 当前推荐优先级

| 优先级 | 项目 | 判断 |
| --- | --- | --- |
| P2 已落地 | bounded `ListDir` + tool boundary prompt polish | `ListDir` / `Glob` / `Grep` / `Read` 职责已拆分。 |
| P2 | Source Coverage Ledger 轻量诊断 | 观察真实回归后再做。 |
| P2 / Watch | evidence hint in tool display/results | 如继续出现强声明漂移，再增加 lightweight evidence labels。 |
| 不做 | `Search` | 与 `Grep` 重复。 |
| 不做 | `define_subagent` / `invoke_subagent` | 与 AgentScheduler 工具体系重复。 |

---

## 8. 验证标准

若只做文档同步：

- `TODO.md` 能索引本文件。
- `active/TODO_runtime.md` 只保留未收口 P2 项，不把已完成 Tool Discovery 第一阶段继续作为待办。
- `DONE.md` 有已完成第一阶段归档。

若未来实现 Phase B：

- `npm test` 覆盖 `Grep` / `Glob` / `Read` prompt 或 output hint 回归。
- `npm run typecheck` 通过。
- `npm run format:check` 通过。

bounded `ListDir` 已实现并验证：

- TypeScript tool tests 覆盖 workspace escape、hidden entries、dependency/build 目录跳过、maxDepth、maxEntries、truncated output、文件/目录错误边界。
- Go Runner tests 覆盖 read-only capabilities、HTTP execute、workspace-safe structured inventory 和 Explore Agent remote smoke 预期。
- 默认工具指导不再鼓励 Bash `ls/find/tree` 做只读发现。

---

## 9. 决策摘要

当前只新增正交的 `ListDir`，不新增重复命名工具。BabeL-O 的正确方向是：

```text
少量稳定工具 + 清晰证据边界 + AgentScheduler 治理命名 + 真实回归驱动新增工具
```

`Search`、`define_subagent`、`invoke_subagent` 不进入实现；bounded `ListDir` 已进入实现。后续优先观察 `ListDir` / `Glob` / `Grep` / `Read` 的证据语义是否足以降低 evidence scope drift 和 Bash discovery 权限噪音。

---

## 10. Related governance plans

本规划是 `docs/nexus/reference/` 工具治理三联中的"边界治理"侧：

| 规划 | 路径 | 关系 |
| --- | --- | --- |
| **整合索引** | `tool-governance-reference-integration.md` | 读者地图：三角关系、共同术语、工具名映射、共同约束、冲突仲裁。任何跨文档冲突先查这里。 |
| **补齐治理** | `tool-surface-expansion-and-native-mcp-coexistence-plan.md` | "新工具 + native vs MCP 双轨注册表"：§3.1 任务族拆分 / AskUserQuestion / MCPTool / Skill / Plan 工具族均建立在**本规划 §2 既定边界**之上；§2.5 失败/拒绝语义（COMMAND_OUTPUT_LIMIT 模式）反向引用本规划 §2 不 throw 终止 session 的基线。 |
| **Skill 治理** | `skill-execution-and-automated-normalized-skill-generation-governance-plan.md` | Skill 域 5 个 model-visible 工具（`SkillList` / `SkillShow` / `SkillValidate` / `SkillDraft` / `SkillSave`）的工具边界（read / write / requiresApproval）**继承本规划 §2 的不新增重复/模糊命名约束**。 |

### 与本规划直接相关的引用点

- **`ListDir` 命名权威性**：本规划 §2.2 是 `ListDir` 作为目录 inventory 工具的命名权威；补齐治理 §6 "与现有文档的关系" 与 Skill 治理 §Layer 5 都引用本规划 §2.2 的 ListDir 边界。
- **不新增 `Search` / `define_subagent` / `invoke_subagent`**：本规划 §2.1 / §2.3 的拒绝理由是**整套工具治理的基线**；补齐治理在新增工具族前必须先回查本规划以避免重叠。
- **证据语义分层**（ListDir 定位 / Glob 发现 / Grep 候选 / Read 理解 / Bash 执行 / Agent 调度）：本规划 §4 是补齐治理与 Skill 治理共享的"职责分层"基础。
- **AgentScheduler 工具命名**（`AgentSpawn` / `AgentWait` / `AgentList` / `AgentCancel`）：本规划 §2.3 是补齐治理中所有 agent-related 工具命名的基线；不引入 `define_subagent` / `invoke_subagent`。
- **失败/拒绝语义基线**：本规划 §2 隐含"工具不 throw 终止 session"基线；补齐治理 §2.5 与 Skill 治理所有 Skill 工具失败路径都建立在此基线之上。

### 升级路径

- 任何本规划与其他两份主规划的新冲突，按 `tool-governance-reference-integration.md` §6 的仲裁流程解决。
- 仲裁无法覆盖时，先升级到整合文档新增仲裁规则；本规划 §10 同步更新。
- 本规划**不**重开整合文档的三角关系或共同约束摘要；如需修订共同约束，必须先在整合文档 §5 落地，再回灌到本规划与另两份主规划。
