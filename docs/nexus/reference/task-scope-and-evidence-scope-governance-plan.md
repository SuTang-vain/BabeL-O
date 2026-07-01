# Task Scope and Evidence Scope Governance Plan

> State: Closed Reference
> Status: Phase 0–4 Landed + Phase 5 Diagnostics Slice Landed (2026-06-13) — 基于真实 session `session_ef76f50a-92cc-4d72-a2bf-13b3ea36917d` 的 scope drift 复盘：用户要求查看 `BabeL-O` / `babel-omemory` 系统进展，agent 自动展开同级独立项目 `BabeL-2` / `BabeL-X` 并把它们作为报告证据。该问题不是危险写入或路径不存在，而是 read-only 工具读取了**任务范围外**的真实证据。
> Priority: P0 Guardrail — 在不削弱合法跨仓分析能力的前提下，让 Nexus/runtime 能区分“路径安全”与“证据在当前任务范围内”。
> Related: [context-and-agent-history.md](../history/context-and-agent-history.md), [evidence-and-runtime-history.md](../history/evidence-and-runtime-history.md), [tool-governance-plan.md](./tool-governance-plan.md)
> Governance: Indexed by [evidence-governance-index.md](./evidence-governance-index.md). This document owns task/evidence scope boundaries; path drift and replay validity stay in their own references.
> Graduation: 2026-06-24 — moved from `proposals/` to `reference/` per [decisions/0001-documentation-lifecycle.md](../decisions/0001-documentation-lifecycle.md) §Decision; canonical owner of task/evidence scope boundaries going forward.

---

## 0. 已落地基础（2026-06-13）

本轮已完成 Phase 0–4 的最小闭环，并落地 Phase 5 的 diagnostics 切片：

- `src/runtime/taskScope.ts`：新增 runtime-owned TaskScope 推导与工具目标 scope boundary 分类；覆盖 `Read` / `Grep` / `Glob` / `ListDir` / 常见 `Bash` 路径模式（`cd <path>`、`git -C <path>`、`find/ls/cat/head/tail`、`rg/grep <path>`）。
- `src/shared/events.ts`：新增 `task_scope_declared`、`scope_boundary_detected`、`scope_boundary_confirmed` 事件；`permission_request` 增加 `scopeRisk` / `targetRoot` / `taskPrimaryRoot` / `scopeReason`。
- `src/runtime/LLMCodingRuntime.ts`：每轮声明 task scope 并回放给 provider；工具执行携带当前 scope；scope boundary 确认后同一轮更新 `confirmedExternalRoots`，后续同 root 只读工具不重复打断。
- `src/runtime/runtimeToolLoop.ts`：工具执行前做 scope preflight；未确认 sibling repo / parent scan / external absolute path 会先发 `scope_boundary_detected` 和带语义风险的 `permission_request`；拒绝时返回 recoverable tool result。
- `src/runtime/contextAnalysis.ts`：`analyzeContext()` diagnostics 现在暴露 task scope 摘要、confirmed external roots、pending scope boundaries、confirmed boundary timeline，以及成功工具结果中的 out-of-scope evidence 信号。
- `src/cli/contextView.ts`、`src/cli/commands/chat.ts` 与 `clients/go-tui/internal/tui/context.go`：TS `/context` overlay、文本 formatter 和 Go TUI `/context` overlay 都展示 task scope、confirmed external roots、pending boundary 与 out-of-scope evidence 摘要。
- `src/cli/renderEvents.ts` 与 `clients/go-tui/internal/tui/`：TS CLI / Go TUI transcript 展示 scope 事件；Go TUI permission panel 显示 scope risk、target root、current root、scope reason；trusted Go TUI session 不再自动批准带 `scopeRisk` 的外部 root 请求。
- 验证：新增/相关 TS scope tests 通过；`npm run typecheck` 通过；`npm run format:check` 通过；`go test ./...` 通过；完整 `npm test` 通过（863/863）。

仍未展开完整 `evidence_scope_attached` 事件、final-answer evidence panel 或 durable session scope-drift timeline；当前 Phase 5 只承诺 context/session diagnostics 的最小 provenance 可见性。

---

## 1. 背景

真实 session `session_ef76f50a-92cc-4d72-a2bf-13b3ea36917d` 暴露了一个需要泛化治理的问题。

用户请求：

```text
查看当前babel-omemory系统进展
```

当前工作目录：

```text
/Users/tangyaoyue/DEV/BABEL/BabeL-O
```

agent 正确读取了 `BabeL-O` 内的 memory 相关材料：

- `docs/nexus/reference/memory-capability-awareness-and-trigger-plan.md`
- `src/runtime/memoryProvider.ts`
- `src/runtime/memory.ts`
- `src/runtime/memoryCandidateGovernance.ts`
- `test/memory-provider.test.ts`
- `docs/nexus/DONE.md`
- `docs/nexus/active/TODO_runtime.md`
- `src/cli/contextView.ts`

但随后自动执行了跨项目读取：

```text
cd /Users/tangyaoyue/DEV/BABEL/BabeL-2 && find ...
cd /Users/tangyaoyue/DEV/BABEL/BabeL-X && find ...
cd /Users/tangyaoyue/DEV/BABEL/BabeL-X && ls -la src/ && cat README.md ...
cd /Users/tangyaoyue/DEV/BABEL/BabeL-2 && ls -la src/ && cat README.md ...
```

这些命令本身是 read-only，且经过现有 `permission_request` / Go TUI approval 路径，但它们仍然是错误的：用户没有要求对比、集成、借鉴、迁移或审计 `BabeL-2` / `BabeL-X`。

这说明 BabeL-O 已有的 path safety / permission risk / context grounding 还缺少一层：**Task Scope / Evidence Scope Governance**。

---

## 2. 问题定义

### 2.1 不是路径安全问题

`BabeL-2` / `BabeL-X` 是用户机器上的真实目录，不是 symlink escape，也不是危险写入。传统 workspace path safety 只能回答：

```text
这个路径能不能安全读取/执行？
```

但本问题要回答：

```text
这个路径是否在本轮用户任务授权范围内？
```

两者不同。

### 2.2 不是 permission risk 足够表达的问题

该 session 中跨项目 Bash 命令触发了 `permission_request`，理由是：

```text
Shell operators require manual review
```

这只能说明命令语法需要审批，不能说明它正在访问当前项目外的 sibling repo。用户/操作者看到的是 Bash execute risk，而不是：

```text
scopeRisk=outside_current_project
root=/Users/tangyaoyue/DEV/BABEL/BabeL-X
reason=sibling repo not explicitly requested
```

因此当前 permission UI 缺少“语义越界”的可见性。

### 2.3 不是 context grounding 已经解决的问题

Phase 6A 的 post-compact grounding guard 解决的是：

```text
compact summary 不能直接当源码/测试/git/task 事实。
```

本问题进一步要求：

```text
即便证据来自真实工具结果，也必须在当前任务 scope 内，才能作为结论依据。
```

换句话说，事实来源需要两个维度：

```text
source truth: 是否来自真实 tool/event/file/test/git evidence
scope truth: 是否属于用户当前任务授权范围
```

### 2.4 不是“禁止跨仓分析”

跨仓分析是 BabeL-O 的合法能力，尤其是：

- 用户明确要求“对比 A 和 B”；
- 用户明确要求“借鉴 BabeL-2 的实现”；
- 用户给出多个路径作为输入；
- migration / integration / audit 任务天然跨 repo；
- 当前工作区本身就是 monorepo 或 multi-root workspace。

要治理的是**未授权自动展开**，不是禁用多项目能力。

---

## 3. 目标原则

1. **Read-only is not automatically in-scope.**
   - 只读命令仍可能越界。

2. **Path existence is not relevance.**
   - 路径存在、名字相似、同父目录、历史 session 出现过，都不能证明它与本轮任务相关。

3. **Historical evidence is not current authorization.**
   - session history / memory / search result 中出现过外部路径，只能作为候选线索，不能自动成为本轮可展开证据源。

4. **Current task scope should be runtime-owned.**
   - 当前任务范围应由 runtime 从 `cwd`、用户显式路径、已确认 external roots、任务类型推导并事件化。

5. **Scope boundary should be visible before execution.**
   - 如果工具目标越出当前 project root，permission UI 必须说明 scope risk，而不只是 Bash risk。

6. **Ask before broad sibling exploration.**
   - 发现 sibling repo 时，允许提示“发现 X，是否展开？”，但确认前不能 `find` / `grep` / `cat` 拉取内容。

7. **Evidence should carry provenance and scope.**
   - tool result / context item / final answer 应能追溯：来自哪个 root，是否用户确认过。

---

## 4. 核心概念

### 4.1 TaskScope

运行时每轮生成的任务范围声明。

```ts
type TaskScope = {
  sessionId: string
  requestId?: string
  cwd: string
  primaryRoot: string
  explicitRoots: string[]
  confirmedExternalRoots: string[]
  inferredCandidateRoots: string[]
  mode: 'single_root' | 'multi_root' | 'cross_project'
  source: 'cwd' | 'prompt_paths' | 'user_confirmation' | 'session_metadata'
}
```

默认规则：

- `primaryRoot` = 当前 repo/workspace root 或 `cwd`；
- 用户 prompt 显式给出的绝对/相对路径进入 `explicitRoots`；
- sibling repo、历史 session path、memory hit path 只能进入 `inferredCandidateRoots`；
- 只有用户确认后，candidate 才能进入 `confirmedExternalRoots`；
- 用户明确使用“对比/集成/迁移/借鉴/审计 A 和 B”等词时，可进入 `cross_project` 模式。

### 4.2 EvidenceScope

每个工具结果或 context item 的证据范围。

```ts
type EvidenceScope = {
  root: string
  relationToTask: 'primary' | 'explicit' | 'confirmed_external' | 'candidate_external' | 'out_of_scope'
  confirmationId?: string
  confidence: 'high' | 'medium' | 'low'
  reason: string
}
```

示例：

```text
Read(src/runtime/memoryProvider.ts)
  -> relationToTask=primary

Bash(cd /Users/.../BabeL-X && find ...)
  -> relationToTask=candidate_external or out_of_scope
  -> should require user confirmation before execution
```

### 4.3 ScopeBoundary

工具目标越过当前任务范围时，runtime 生成的边界诊断。

```ts
type ScopeBoundary = {
  targetRoot: string
  boundaryKind: 'parent_scan' | 'sibling_repo' | 'external_absolute_path' | 'historical_session_path' | 'memory_hit_path' | 'global_cache_path'
  toolName: string
  toolUseId: string
  action: 'warn' | 'require_confirmation' | 'deny'
  reason: string
}
```

---

## 5. 建议事件协议

### 5.1 `task_scope_declared`

每轮开始或 context assembly 后发出，说明 runtime 当前理解的任务范围。

```ts
task_scope_declared {
  type: 'task_scope_declared'
  requestId?: string
  cwd: string
  primaryRoot: string
  explicitRoots: string[]
  confirmedExternalRoots: string[]
  inferredCandidateRoots: string[]
  mode: 'single_root' | 'multi_root' | 'cross_project'
  message: string
}
```

用途：

- UI 可显示当前 scope；
- `/inspect-session` 可复盘 agent 当时是否理解错任务范围；
- final answer 可引用 scope facts，避免把外部项目混进当前项目结论。

### 5.2 `scope_boundary_detected`

工具执行前发现目标越过 scope 时发出。

```ts
scope_boundary_detected {
  type: 'scope_boundary_detected'
  requestId?: string
  toolUseId: string
  toolName: string
  targetRoot: string
  boundaryKind: 'parent_scan' | 'sibling_repo' | 'external_absolute_path' | 'historical_session_path' | 'memory_hit_path' | 'global_cache_path'
  action: 'warn' | 'require_confirmation' | 'deny'
  reason: string
  suggestedPrompt: string
}
```

示例 message：

```text
Tool target is a sibling repository outside the current task scope. The user asked about BabeL-O only. Ask for confirmation before inspecting /Users/tangyaoyue/DEV/BABEL/BabeL-X.
```

### 5.3 `scope_boundary_confirmed`

用户确认后写入。

```ts
scope_boundary_confirmed {
  type: 'scope_boundary_confirmed'
  requestId?: string
  targetRoot: string
  confirmationScope: 'once' | 'session' | 'task'
  confirmedBy: 'user' | 'policy'
  message: string
}
```

确认后该 root 可以进入 `confirmedExternalRoots`。

### 5.4 `evidence_scope_attached`

可选：当工具结果进入 context item 或 final-answer evidence 时附加 scope 元信息。

```ts
evidence_scope_attached {
  type: 'evidence_scope_attached'
  requestId?: string
  toolUseId: string
  root: string
  relationToTask: 'primary' | 'explicit' | 'confirmed_external' | 'candidate_external' | 'out_of_scope'
  message: string
}
```

---

## 6. Scope 判定规则

### 6.1 默认允许

- 当前 repo root 内的文件；
- 用户 prompt 明确给出的路径；
- 本轮已确认的 external root；
- runtime 自身配置/日志/db 读取，且用户明确要求 session/config/runtime 诊断；
- `~/.babel-o/db.sqlite` 在用户要求查询 session/history 时可作为 explicit diagnostic root。

### 6.2 需要确认

- sibling repo：`../BabeL-X`、`../BabeL-2`；
- parent directory broad scan：`cd .. && find .`、`cd /Users/.../DEV/BABEL && ls/find`；
- 历史 session 中出现过但本轮用户未点名的项目路径；
- memory search 命中里包含的外部 path；
- 全局缓存或 agent 旧工作区中的项目路径；
- bash 命令中 `cd <external-root> && ...`；
- `find` / `rg` / `grep` target 覆盖多个 sibling roots。

### 6.3 默认拒绝或强确认

- write/edit/delete 外部 root；
- `rm` / destructive 命令跨 root；
- secret/config/token 目录跨 scope；
- 自动读取 `.env`、credential、private key 等敏感文件；
- 供应链相关写入或发布命令。

本规划主要关注 read-only scope drift；更高风险动作继续由现有 security/permission policy 处理。

---

## 7. 模型行为约束

应加入 system/runtime guidance：

```text
Current task scope is defined by the user's latest request, cwd, explicit paths, and confirmed external roots.
Do not treat similar project names, sibling directories, historical session paths, or memory hits as authorization to inspect them.
If an external candidate appears relevant, mention it briefly and ask whether to expand. Do not read, grep, find, or summarize it before confirmation.
Evidence used in final answers must be both source-grounded and in-scope.
```

中文口径：

```text
当前任务范围由用户本轮请求、cwd、显式路径和已确认外部 root 决定。相似项目名、同级目录、历史 session 里出现过、memory 命中，都不能自动视为授权。若发现外部候选项目可能相关，只能提示“发现 X，是否展开？”，确认前不得读取、grep、find 或总结其内容。最终结论引用的证据必须既真实又在 scope 内。
```

---

## 8. 分阶段路线

### Phase 0：真实 session 回归与诊断

目标：固化 `session_ef76f50a-92cc-4d72-a2bf-13b3ea36917d` 的问题形状。

落地点：

- 新增 regression helper：扫描 session events 中的 tool targets，识别：
  - current root = `BabeL-O`；
  - user request 只包含 `babel-o` / `babel-omemory`；
  - tool command/read target 进入 `BabeL-2` / `BabeL-X`；
  - 没有用户确认外部 root。
- 输出 diagnostic：`SCOPE_DRIFT_EXTERNAL_SIBLING_REPO`。
- 不把 “用户明确要求对比 BabeL-O 与 BabeL-2” 的场景误报。

收口标准：

- 真实 session 样本能被诊断；
- cross-project explicit prompt 不误报。

### Phase 1：TaskScope 推导与 prompt guidance

目标：每轮 runtime 都能声明当前任务 scope。

落地点：

- 从 `cwd`、git root、用户显式路径、session metadata 推导 `TaskScope`；
- 增加 `task_scope_declared` runtime event；
- system prompt 注入 current task scope block；
- `mapEventsToMessages()` 将 scope boundary facts 回放给 provider。

收口标准：

- provider-visible context 明确当前 primary root；
- 模型规则明确 sibling dirs/history paths 不是授权。

### Phase 2：Tool preflight scope boundary

目标：工具执行前识别越界。

落地点：

- 对 `Read` / `Glob` / `Grep` / `ListDir` / `Bash` 提取 target paths/root；
- `Bash` 解析常见模式：`cd <path> && ...`、`git -C <path>`、`find <path>`、`rg <pattern> <path>`；
- 若 target root 不在 `primaryRoot | explicitRoots | confirmedExternalRoots` 内，发出 `scope_boundary_detected`；
- 对 sibling repo / parent scan 默认 `require_confirmation`。

收口标准：

- `cd ../BabeL-X && find ...` 在未确认时不会直接执行；
- 当前 repo 内 read/search 不受影响。

### Phase 3：Permission UI / Go TUI scope risk

目标：用户能看懂“这不是普通 Bash 审批，而是 scope 越界”。

落地点：

- `permission_request` 增加可选字段：
  - `scopeRisk?: 'none' | 'outside_current_project' | 'sibling_repo' | 'parent_scan' | 'historical_path' | 'memory_hit_path'`
  - `targetRoot?: string`
  - `taskPrimaryRoot?: string`
  - `scopeReason?: string`
- Go TUI permission panel 显示：

```text
Scope: sibling repo outside current task
Target: /Users/.../BabeL-X
Current: /Users/.../BabeL-O
Reason: user asked about BabeL-O only
```

收口标准：

- 用户审批时能准确判断是否允许跨项目；
- trusted Go TUI session 不再静默把所有 execute-risk approval 等价为 scope approval。

### Phase 4：Confirmed external roots

状态：已落地（2026-06-13）。

目标：允许合法跨仓任务顺畅执行。

落地点：

- 用户确认后写 `scope_boundary_confirmed`；
- 支持 once/session/task scope；
- 本轮或本任务后续工具可访问已确认 root；
- `/context` / `/inspect-session` 显示 confirmed external roots。

收口标准：

- 用户明确同意展开 `BabeL-X` 后，不重复打断每个 read-only 命令；
- 新 session 或新任务默认不继承上次 external root 授权，除非用户/配置明确允许。

### Phase 5：Evidence scope provenance

状态：diagnostics slice 已落地（2026-06-13）；完整 final-answer evidence panel / durable timeline 仍待后续。

目标：最终结论和 context diagnostics 能区分证据来源范围。

落地点：

- context items / tool traces 附带 `EvidenceScope`；
- final answer grounding diagnostics 可标出 out-of-scope evidence；
- `/context` visualization 增加 roots/boundary panel；
- session analysis 可输出 scope drift timeline。

收口标准：

- final answer 不会把 unconfirmed external evidence 当作当前项目事实；
- session 复盘能看到哪些 roots 被用作 evidence。

---

## 9. 验证建议

### Unit tests

- `deriveTaskScope()`：
  - cwd root only；
  - prompt explicit path；
  - prompt cross-project intent；
  - historical path candidate 不自动确认。
- `classifyToolScopeBoundary()`：
  - `Read(src/a.ts)` -> primary；
  - `Read(/Users/.../BabeL-X/README.md)` -> sibling_repo；
  - `Bash(cd ../BabeL-X && find .)` -> sibling_repo；
  - `Bash(cd .. && find .)` -> parent_scan；
  - `git -C /external status` -> external_absolute_path。

### Runtime tests

- 用户只问 `BabeL-O memory` 时，访问 `BabeL-2` / `BabeL-X` 触发 `scope_boundary_detected` + permission scope warning。
- 用户明确说“对比 BabeL-O 和 BabeL-X memory 系统”时，两个 roots 进入 `explicitRoots` 或 `cross_project`，不误阻断。
- trusted Go TUI session approval 不自动等价于 external-root session approval，除非 permission response 明确确认 scope boundary。

### Go TUI tests

- permission panel 展示 scope risk / target root / current root。
- transcript 渲染 `scope_boundary_detected` / `scope_boundary_confirmed`。
- `/context` overlay 展示 primary root 和 confirmed external roots。

### Real-session regression

重放 `session_ef76f50a-92cc-4d72-a2bf-13b3ea36917d` 的关键轮次：

```text
用户：查看当前babel-omemory系统进展
cwd: /Users/tangyaoyue/DEV/BABEL/BabeL-O
候选 sibling: BabeL-2, BabeL-X
```

期望行为：

```text
我会先只看 BabeL-O 内的 memory 系统。另发现同级项目 BabeL-2 / BabeL-X；除非你要对比或借鉴，否则不展开。
```

不应执行：

```text
cd /Users/tangyaoyue/DEV/BABEL/BabeL-2 && find ...
cd /Users/tangyaoyue/DEV/BABEL/BabeL-X && find ...
```

---

## 10. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| guard 太严影响合法跨仓分析 | 中 | 识别 explicit cross-project intent；确认后 root 加入 confirmedExternalRoots |
| permission 噪音过多 | 中 | 只对 root boundary 打一次确认；同 root 后续 read-only 复用确认 |
| Bash path 解析不完整 | 中 | 覆盖常见模式，未知时保守提示；不做 shell 全解释器 |
| monorepo 被误判 sibling repo | 高 | 优先识别 git root / package workspace / configured multi-root |
| 历史 session path 完全禁用导致记忆价值下降 | 中 | 历史 path 可作为 candidate hint，但读取前确认 |
| 用户信任 session approval 后仍被问 | 低 | 支持 task/session scope confirmation，但要在 UI 明确展示 target root |

---

## 11. 非目标

- 不禁止跨仓 / 多项目分析。
- 不把所有外部绝对路径都视为危险；用户显式给出的路径是合法 scope。
- 不替代 path safety / permission risk / security policy。
- 不要求模型停止使用 memory 或 historical session；只要求 historical evidence 不自动变成本轮授权。
- 不做完整 shell parser；只做高价值 path/root extraction 和 conservative fallback。
- 不让 Go TUI 拥有 scope truth；Go TUI 只展示 Nexus/runtime 计算出的 scope risk。

---

## 12. 推荐结论

BabeL-O 需要把 evidence governance 从“证据是否真实”扩展到“证据是否在当前任务范围内”。

成熟状态应满足：

1. **任务范围 runtime-owned**：每轮有可复盘的 `TaskScope`。
2. **工具执行前 scope preflight**：跨 sibling repo / parent scan 先确认。
3. **permission UI 展示语义风险**：用户知道审批的是“外部项目读取”，不是普通 Bash。
4. **证据带 scope provenance**：final answer 不混入未确认外部项目。
5. **跨仓能力保留**：用户明确要求后，confirmed external roots 让合法任务顺畅执行。

这样可以避免 `BabeL-O memory` 任务被相似目录名、历史 session path 或 memory hit 牵引到无关项目，同时保留 BabeL-O 作为多项目 coding agent 的能力。

## 中文概述

### 背景

真实会话暴露过证据来自错误项目或 sibling repo 的问题；权限审批只能说明命令风险，不能说明证据在当前任务范围内。

### 边界

BabeL-O 需要同时治理 task scope 和 evidence scope。模型使用外部证据前必须有明确范围诊断和必要确认。

### 当前状态

诊断切片已部分落地，final-answer evidence panel / durable timeline 仍需后续推进，因此保持 Partially Landed。
