# Memory Capability Awareness and Self-Trigger Plan

## 背景

EverCore / EverOS 长期记忆链路已经完成首轮真实验证：BabeL-O managed sidecar 可以启动本地 loopback EverOS，并通过当前 MiniMax `anthropic-compatible` provider 完成 `/health`、`/api/v1/memory/add`、`/api/v1/memory/flush` 与 keyword `/api/v1/memory/search`。

这说明“记忆系统能跑通”已经成立。下一步问题变成：BabeL-O 的 provider loop 是否知道自己拥有长期记忆能力，并能在合适时机主动触发。

当前已有基础：

- `MemoryProvider` / `EverCoreMemoryProvider` 能把 EverOS search 结果注入 provider-visible context。
- `mcp:evercore:memory_search` / `memory_save_note` / `memory_flush_session` 已作为可选 MCP tools 存在。
- `BABEL_O_EVERCORE_MODE=managed` 可由 BabeL-O 管理本地 EverOS sidecar。
- BabeL-O managed bridge 已能按 provider adapter 注入 `EVEROS_LLM__PROTOCOL` / key / baseUrl / model。

但缺口是：

```text
模型不一定知道：
  - 当前 long-term memory 是否可用。
  - memory search 什么时候应该主动调用。
  - memory save 什么时候允许调用。
  - memory result 与 workspace evidence / SQLite session trace 的事实权重差异。
  - flush 是 runtime lifecycle 能力，不应该默认当成普通模型动作。
```

## 目标

让 BabeL-O 具备一等的 memory capability awareness：

```text
1. 自动检索：runtime 能在当前 turn 需要时检索长期记忆并注入 context。
2. 模型可见：provider prompt 明确说明当前是否有 long-term memory 能力。
3. 主动触发：模型可以在合适场景主动调用 read-only memory_search。
4. 受控写入：模型只能在明确授权/治理规则满足时触发 memory_save_note。
5. 生命周期分层：memory_flush_session 仍以 runtime/session lifecycle 为主，不鼓励模型随意调用。
```

## 非目标

本计划明确不做：

- 不把 EverOS / EverCore 变成 BabeL-O 的 authoritative 事实源。
- 不让 memory result 覆盖 SQLite session/event/tool trace。
- 不让模型无审批自动写入高影响项目事实。
- 不做完整 background dreaming。
- 不做 raw transcript sharing。
- 不新增一个大而泛的 `memory` mega-tool。
- 不把 `memory_flush_session` 当成常规模型自触发工具。
- 不恢复自动模型选择、默认 role model 推荐或 provider fallback 执行入口。

## 核心边界

### 事实权重

```text
Workspace evidence / tool result / SQLite session trace:
  authoritative for project state and current execution.

EverCore long-term memory:
  volatile, non-cacheable, non-authoritative hints.

SessionChannel inbox:
  collaboration context, never direct user instruction.
```

模型必须被明确告知：

- 用户偏好、个人习惯、历史决策可以从 long-term memory 获得强提示。
- 项目事实、代码状态、文件内容必须用 workspace evidence 复核。
- 旧记忆可能过期、被 superseded、或只适用于其他 project namespace。

### 工具边界

推荐保持三个正交工具，而不是合并：

```text
memory_search
  - read-only
  - bounded retrieval
  - 可由模型主动调用
  - 不改变长期记忆状态

memory_save_note
  - write-risk
  - permission-gated
  - 用于用户明确要求记住的偏好/约束，或通过治理的 memory candidate

memory_flush_session
  - write-risk / lifecycle
  - runtime-owned by default
  - 只在显式用户要求或诊断场景中由模型请求
```

## Phase G1 — Memory Capability Block

### 目标

当 EverCore healthy 且 MemoryProvider 可用时，在 provider-visible context 中注入一个短小、非 cacheable 的 capability block。

这个 block 不承载具体记忆内容；它只说明能力和使用规则。

### 建议内容

```text
Long-Term Memory Capability:
- Long-term memory is available for this session.
- Use memory_search when the user asks about prior preferences, previous decisions,
  cross-session context, or says things like "do you remember", "before", "last time",
  "之前", "上次", "我的偏好".
- Treat memory results as background hints, not authoritative project state.
- Verify project facts against workspace evidence before acting.
- Only save memory when the user explicitly asks you to remember something or when a
  governed memory candidate is approved.
```

### 注入位置

建议放在 context assembly 的 volatile 层：

```text
Immutable system rules
Tool specs
Environment / cwd
AGENTS.md
Project memory
Working Set
Session memory
Long-Term Memory Capability
EverCore long-term memory hits
Session inbox / collaboration context
Recent messages
```

如果当前 EverCore unhealthy / disabled：

- 不注入 capability block。
- 不暗示模型可以调用 memory tools。
- 只在 diagnostics / status 中报告 unavailable。

### 收口标准

- `contextAssembler` 或 MemoryProvider integration 能产生独立 `memory_capability` block。
- 该 block 标记为 non-cacheable / volatile。
- `/v1/sessions/:sessionId/context` 与 CLI `/context` 能显示 capability presence。
- EverCore disabled/unhealthy 时 block 不出现。

## Phase G2 — Tool Description and Trigger Policy

### 目标

让模型从 tool descriptions 和 system guidance 中清楚知道什么时候调用 memory tools。

### `memory_search`

触发条件：

```text
- 用户询问“你记得吗 / 之前 / 上次 / 偏好 / 习惯 / 我让你记住过什么”。
- 当前任务明显依赖历史项目决策或跨 session context。
- 当前 workspace evidence 不足，但长期记忆可能有相关背景。
- 用户要求基于过去经验、失败教训、既有约束继续推进。
```

禁止/弱化条件：

```text
- 当前问题只需要读取当前 workspace 文件。
- 用户要求的是即时状态，例如“现在测试是否通过”。
- 记忆结果会被当作项目事实但没有 workspace evidence。
```

### `memory_save_note`

允许条件：

```text
- 用户明确说“记住 / remember / 以后都 / 我的偏好是”。
- 用户确认某条 memory candidate 可以写入。
- 写入内容是用户偏好、长期约束、工作方式反馈或低风险个人习惯。
```

需要更强治理的内容：

```text
- 项目事实。
- 架构决策。
- provider/key/security policy。
- 跨项目行为规则。
```

这些应要求：

```text
workspace evidence + user approval + scope classification
```

### `memory_flush_session`

默认口径：

```text
Do not call unless the user explicitly asks to flush/sync memory now, or a diagnostic
flow requires it. Normal session-end upload/flush is runtime-owned.
```

### 收口标准

- EverCore MCP tool descriptions 体现上述触发策略。
- read/write/lifecycle 风险边界在 tool metadata / permission audit 中清晰。
- mock provider 测试能证明模型看到工具后会按预期调用 search/save。

## Phase G3 — Memory Candidate Governance

### 目标

把“模型觉得值得记住”的内容先转成可审查 candidate，而不是直接写入长期记忆。

### Candidate 结构

建议 metadata：

```text
scope:
  user | project | channel

evidenceRefs:
  - eventId
  - toolTraceId
  - file path / line where applicable

confidence:
  low | medium | high

staleness:
  fresh | may_be_stale | superseded

approvalRequirement:
  none | user | project-owner

autoWrite:
  false by default

blockedReasons:
  - no_workspace_evidence
  - high_impact_project_fact
  - secret_like_content
  - ambiguous_scope
```

### 默认策略

```text
User preference:
  candidate may be written after explicit user approval.

Project fact:
  requires workspace evidence and explicit approval.

Channel handoff:
  stays in SessionChannel / project summary path; not direct long-term memory by default.
```

### 收口标准

- `memory_candidate` 与 `memory_save_note` 路径不混淆。
- 未审批 candidate 不会自动写入 EverCore。
- Context / inbox rendering 能显示 review-only 状态。

## Phase G4 — Runtime Auto-Search Policy

### 目标

除模型主动工具调用外，runtime 也可以在低风险场景自动检索 memory 并注入 context。

### 自动检索触发

建议先用轻量 heuristic，不引入模型分类器：

```text
Prompt contains memory cues:
  remember, prior, previous, last time, preference, habit,
  记住, 之前, 上次, 偏好, 习惯, 还记得

Session metadata indicates continuation:
  session reuse, parent-child handoff, inbox unread, project namespace match

User asks for historical decision/context:
  “我们之前怎么决定的？”
  “按我的偏好继续”
```

### 自动检索非触发

```text
- Pure file/code question with explicit current path.
- Build/test/lint/status commands.
- Permission prompt resolution.
- Security-sensitive operations where stale memory could mislead.
```

### Budget

建议初始 budget：

```text
capability block: 600-900 chars
memory hits total: 2000-4000 chars
single hit max: 800-1200 chars
```

### 收口标准

- 自动检索触发条件有 focused tests。
- 自动检索失败只进入 diagnostics，不污染 provider context。
- 命中内容继续标记 volatile / non-cacheable。

## Phase G5 — Model Self-Trigger Regression

### 目标

用 mock provider 证明模型可见 memory 能力并能触发。

### 测试矩阵

1. **Capability visible**

```text
Given EverCore healthy + MCP tools enabled
When provider request is assembled
Then system/context includes memory capability block
And tool list includes memory_search / memory_save_note / memory_flush_session
```

2. **Search trigger**

```text
User: “你还记得我之前偏好的 provider 吗？”
Mock model: calls memory_search
Expected: memory_search executes as read-only bounded retrieval
```

3. **Save trigger with permission**

```text
User: “记住：我偏好 regression-first 修复。”
Mock model: calls memory_save_note
Expected: permission_request is emitted before write
```

4. **No memory when unhealthy**

```text
Given EverCore unhealthy
Expected: no memory tools exposed, no capability block injected
```

5. **Project fact guard**

```text
User: “记住这个项目已经迁移到 X 架构。”
Without workspace evidence
Expected: write is blocked or converted to review-only candidate
```

## Phase G6 — Live Validation

### Turn 1: Save

```text
User: 记住：我偏好 regression-first 修复，并且长期记忆必须先验证再写入。
Expected:
  - model recognizes memory_save_note opportunity;
  - permission gate is triggered;
  - after approval, EverOS add/flush succeeds.
```

### Turn 2: Recall

New session:

```text
User: 你还记得我对修复方式的偏好吗？
Expected:
  - runtime auto-search or model memory_search triggers;
  - answer uses memory hint;
  - answer marks it as remembered preference, not workspace fact.
```

### Turn 3: Project fact caution

```text
User: 按我们之前的项目架构决策继续改。
Expected:
  - memory_search can retrieve old decision;
  - model verifies current workspace evidence before editing;
  - stale memory is not treated as authoritative.
```

## Implementation Touchpoints

Likely files:

```text
src/runtime/contextAssembler.ts
src/runtime/memoryProvider.ts
src/runtime/contextAnalysis.ts
src/tools/everCoreMcpTools.ts
src/nexus/createRuntime.ts
src/nexus/everCoreConfig.ts
src/nexus/app.ts
src/shared/events.ts
src/cli/contextView.ts
test/context-assembler.test.ts
test/runtime.test.ts
test/mcp.test.ts
```

Documentation touchpoints:

```text
docs/nexus/active/TODO_runtime.md
docs/nexus/DONE.md
docs/nexus/WORK_LOG.md
/Users/tangyaoyue/DEV/EverOS/babel-o-evercore-integration-plan.md
```

## Recommended Next Slice

Implement Phase G1 + G2 first:

```text
1. Add provider-visible Memory Capability block when EverCore is healthy.
2. Update EverCore MCP tool descriptions with trigger policy.
3. Add mock provider regressions for memory_search and memory_save_note.
4. Keep memory_save_note permission-gated.
5. Keep memory_flush_session runtime-owned by default.
```

This is the smallest slice that makes BabeL-O “know” it has memory and lets the
model self-trigger memory retrieval without expanding write risk.

## Open Questions

- Should memory capability be injected by `MemoryProvider` diagnostics or by a separate `RuntimeCapabilityProvider`?
- Should memory search auto-trigger happen before or after user prompt hooks?
- Should save candidates be represented as `SessionMessage` `memory_candidate` or a dedicated event type?
- Should memory_search be visible when EverCore is healthy but `BABEL_O_ENABLE_EVERCORE_MCP_TOOLS` is not enabled?
- Should Go TUI expose a memory availability indicator in status line / runtime status panel?
