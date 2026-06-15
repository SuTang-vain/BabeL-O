# Intent Guidance and Prompt Governance Optimization Plan

Status: proposed.

Primary sample: `session_b2e5660a-2669-4aec-a4a7-73ed65ed1f8e`.

Related samples / prior governance:

- `session_315814e7-3b82-4a31-8601-a5b383288e9c`: session replay、Read evidence coverage、intent target 与 self-diagnosis 治理。
- `docs/nexus/reference/session-replay-and-evidence-governance-plan.md`: 已明确 Phase E/G 方向：provider-visible intent routing 使用结构化 `Turn Policy` 字段，不再注入事故特定中文 guidance / Instruction block。
- `docs/nexus/reference/memory-capability-awareness-and-trigger-plan.md`: memory capability block、memory_search / memory_save_note / memory_flush_session 边界。

## 背景

`session_b2e5660a-2669-4aec-a4a7-73ed65ed1f8e` 暴露了一个新的 intent / prompt governance 问题：用户在连续上下文中先询问长期记忆能力，随后接受上一轮建议并说“执行一下长期记忆是否可用”。这句话从用户意图上是 **执行 / 检查当前能力可用性**，但 runtime intake guidance 将其判成：

```text
intent=status
actionHint=respond_only
requiresTools=false
problemTarget=agent_failure
```

随后 `normalizeGuidancePolicy()` 又通过 `isMemoryCapabilityQuestion()` 把该请求硬归一化为 respond-only。provider 在第一轮实际想调用 `Read` 读取源码 / 配置确认长期记忆行为，但 runtime 因 `shouldSuppressToolsForIntent()` 隐藏工具，触发：

```text
TOOL_CALL_SUPPRESSED_BY_USER_INTENT
Runtime suppressed provider tool calls for respond-only user intent: Read.
```

这不是单纯模型“不会理解中文”的问题，也不应该用“给这句话补一个更强提示词”来修。它是三层治理混合失效：

```text
用户自然语言动作意图
  ↓
intake classifier structured fields
  ↓
deterministic normalize / suppress policy
  ↓
provider-visible Turn Policy / execution-state guidance
```

当前系统已经从早期自然语言 dynamic guidance 迁移到 `Turn Policy` 字段，但仍存在两个缺口：一是 memory capability special-case 规则太宽，二是提示词引导和规则没有统一表达“纯能力问答”和“当前状态验证”的差异。

## 核心原则

### 1. 禁止事故特定硬编码提示词注入

本计划的第一原则是：**不能为某个 session、某个中文句子、某个模型误判，向主 provider prompt 动态注入硬编码自然语言提示词。**

禁止的做法包括：

```text
- 在主 system prompt 里追加“如果用户说‘执行一下长期记忆是否可用’，你必须调用 Read”。
- 在 runtimePipeline retry 中为某次事故写入中文特判 instruction。
- 在 contextAssembler 里根据 latestUserText 拼接事故专用 Guidance block。
- 在 provider adapter 层根据模型名注入隐藏修正提示。
- 在 memory capability block 中堆叠越来越多真实事故原句。
```

允许的做法是：

```text
- 用结构化字段表达 runtime policy，例如 responseMode / toolMode / evidenceMode / staleTaskMode。
- 用可测试的 rule predicate 识别语义类别，例如 capability_question、availability_check、action_request、explicit_save。
- 用稳定、短小、语言中立的系统规则说明类别边界。
- 在 intake classifier prompt 中加入少量代表性 few-shot，但 few-shot 只能服务类别学习，不能成为 runtime 依赖的唯一修复。
- 用 regression tests 固化类别行为，而不是靠 prompt 字面匹配固化事故句子。
```

换言之：**规则可以有 lexicon / cue；prompt 可以有通用原则；但不能把某个事故原句当成隐藏 instruction 注入模型。**

### 2. 规则拥有执行权，提示词只解释规则

provider-visible prompt 不应该成为 runtime policy 的唯一来源。真正决定工具是否可见、是否需要证据、是否 respond-only 的地方必须是 deterministic policy：

```text
latest user text + recent context + rule predicates + classifier output
  → normalized UserIntentGuidance
  → TurnPolicy
  → provider-visible fields + tool visibility
```

提示词的职责是让模型更好地配合 runtime policy，而不是在 runtime policy 错误时靠模型自行纠偏。

### 3. 区分“能力问答”和“当前状态验证”

必须明确区分三类 memory 相关请求：

```text
A. 纯能力问答
   用户想知道 BabeL-O 是否支持长期记忆、能否使用记忆、记忆能力如何工作。
   这类通常可以 direct_answer，且不需要暴露内部实现。

B. 当前状态 / 当前可用性验证
   用户要求查看当前 session / 当前配置 / 当前工具 / 当前 runtime 是否真的可用。
   这类需要 tool-backed verification。

C. 记忆写入 / 检索动作
   用户明确要求记住、保存、搜索历史偏好或过去决策。
   这类需要对应 memory tool / permission governance。
```

本次事故把 B 误归入 A。

### 4. 不把中文 prompt 修补做成二等路径

BabeL-O 的用户真实使用中有大量中文动作短语，例如“执行一下”“跑一下”“测一下”“检查当前”“查看一下”“确认是否可用”。这些不能靠英文 prompt 中的 `run/check/verify` 间接覆盖。规则层要支持多语言动作 cue，但实现上应保持类别化、可测试、可演进，而不是把中文整句塞进 system prompt。

### 5. Retry 是恢复机制，不是主路径

`TOOL_CALL_SUPPRESSED_BY_USER_INTENT` 的 retry 机制是安全兜底：当 respond-only 误抑制了 provider tool call 时，可以开放下一轮工具。但正确设计应让首轮 intent policy 就把工具可见性设置对。Retry 文案只能提升恢复率，不能替代 intent normalization 修复。

## 当前源码问题定位

### P0-1：`isMemoryCapabilityQuestion()` 语义过宽

当前位置：`src/runtime/intentGuidance.ts`。

当前规则把包含：

```text
记忆 / 长期记忆 + 是否 / 可用 / 启用
```

的中文请求归为 memory capability question。这会把以下请求混在一起：

```text
你能够使用长期记忆吗？          → 纯能力问答
长期记忆是否可用？              → 可能是能力问答，也可能是状态检查
查看当前长期记忆是否可用          → 当前状态验证
执行一下长期记忆是否可用          → 执行动作 / 验证请求
测试长期记忆读写是否可用          → 测试动作
```

该 predicate 当前承担了两个职责：

```text
1. 识别用户是否在问 memory capability。
2. 决定是否强制 respond_only / suppress tools。
```

这两个职责必须拆开。

### P0-2：`normalizeGuidancePolicy()` 对 memory capability 做硬覆盖

当前顺序是：先判断 `isMemoryCapabilityQuestion()`，若命中则直接：

```text
intent=status
actionHint=respond_only
requiresTools=false
```

这意味着即使 intake model 判断 `requiresTools=true`，后续也可能被 deterministic normalization 改回 false。Prompt 优化无法越过这一层。

### P0-3：`shouldSuppressToolsForIntent()` 对 memory capability 做硬抑制

当前 `shouldSuppressToolsForIntent()` 中 memory capability question 优先返回 true。普通 `status` 已经有 `toolMode=available_for_verification` 的治理方向，但 memory special-case 仍然绕过了这个治理。

### P1-1：主 system prompt 的 action / analysis 分类不足以表达 current-state verification

`systemPromptBuilder.ts` 当前把 start/run/build/test/execute/launch 归为 action，把 review/analyze/improve/optimize/check/examine 归为 analysis。这对代码审查任务合理，但对“检查当前是否可用”“查看当前配置是否生效”“确认当前 session 是否存在”不够精确。

需要新增一类：**current-state verification**。

### P1-2：memory capability block 没有区分 pure capability 与 availability check

`contextAssembler.ts` 的 `formatLongTermMemoryCapability()` 当前告诉模型：当用户问 memory capability 时，按 user-facing capability level 回答。这有助于避免暴露内部路径和 provider internals，但缺少“若用户要求检查当前可用性，应使用工具验证”的对应规则。

### P1-3：suppressed retry 文案太泛

`runtimePipeline.ts` 的 retry message 当前只说：如果真的需要执行命令或检查文件，就调用工具。它没有把“该请求可能被误归类为 respond-only”这个事实表达成结构化状态，也没有把 action cue / availability check 的类别传给模型。

## 目标

本计划目标是把本次事故收口为一套可测试、可维护、非事故特定硬编码的 prompt / rule governance：

```text
1. 让 pure capability question 继续安全地 direct_answer。
2. 让 current availability check / execution request 保持工具可见，并要求 evidence-backed answer。
3. 让 intake classifier、fallback heuristic、normalization、suppression、provider-visible prompt 使用同一套类别边界。
4. 禁止向主 prompt 注入事故专用自然语言修补。
5. 保持 provider prompt 短小、稳定、语言中立，避免越修越长。
6. 对中文真实请求建立 regression coverage。
7. 让 retry 成为可解释恢复路径，而不是用户看到的最终失败。
```

## 非目标

本计划明确不做：

```text
- 不恢复自动模型选择或 provider fallback 执行。
- 不把 memory result 当成 workspace / session trace 的事实源。
- 不新增 broad analyze / inspect / memory mega-tool。
- 不让模型自行决定是否忽略 runtime Turn Policy。
- 不为 MiniMax-M3 写 provider-specific hidden prompt。
- 不把所有 status 问题都改成 always tools。
- 不让 pure capability question 默认读取源码或暴露内部实现。
- 不把真实事故原句作为动态 hidden instruction 注入。
```

## 目标架构

### Intent taxonomy

新增或明确以下语义分类。它们不一定都要成为外部 enum，但必须在 rule / test / diagnostics 中可见：

```text
capability_question
  用户问系统是否具备某能力、能力如何工作、能否做某事。

availability_check
  用户要求确认当前 session / runtime / config / tool / service 是否可用。

action_request
  用户要求执行、运行、测试、构建、启动、检查当前状态。

memory_save_request
  用户要求保存长期偏好 / 规则 / 事实。

memory_retrieval_request
  用户要求回忆历史偏好、之前决策、上次内容。

self_diagnosis_request
  用户要求分析 agent/runtime/tool/session 出错原因。
```

这些分类映射到现有 `UserIntentGuidance`：

| Semantic category | intent | actionHint | requiresTools | evidenceMode | tool behavior |
| --- | --- | --- | --- | --- | --- |
| pure capability question | status | respond_only | false | none | tools suppressed or verification-only |
| availability check | status / continue | normal | true | verify_before_claim | tools visible |
| action request | continue | normal | true | standard / verify_before_claim | tools visible |
| memory save request | continue | normal | true | standard | memory_save permission gated |
| memory retrieval request | continue / status | normal | true | standard | memory_search visible |
| self diagnosis request | status / continue | normal if evidence needed | true when session/source evidence needed | verify_before_claim | tools visible |

### Two-layer policy model

```text
Layer 1: Semantic classification
  - classifier output
  - fallback heuristic
  - deterministic cue predicates
  - recent context continuity

Layer 2: Execution policy
  - responseMode
  - toolMode
  - evidenceMode
  - staleTaskMode
  - suppressTools boolean
```

禁止把 Layer 2 决策写成 provider-only natural language instruction。Provider prompt 只能看到结构化状态和稳定解释。

## Phase A — Rule Predicate Split

Priority: P0.

### Problem

`isMemoryCapabilityQuestion()` 同时做“识别能力问答”和“决定是否 suppress tools”。这导致可用性检查被错误归入 respond-only。

### Plan

拆分为至少三个 predicate：

```ts
isPureMemoryCapabilityQuestion(text)
isMemoryAvailabilityCheckRequest(text)
isExplicitMemorySavePrompt(text)
```

其中：

```text
isPureMemoryCapabilityQuestion
  只识别“你是否具备记忆能力 / 能否使用记忆 / 记忆能力是什么”这类问答。

isMemoryAvailabilityCheckRequest
  识别“查看当前 / 检查 / 测试 / 执行 / 验证 / 跑一下 / status / 当前是否可用”这类需要当前证据的请求。

isExplicitMemorySavePrompt
  识别明确写入记忆请求，并且优先级高于 pure capability。
```

### Rule design

不要写：

```ts
if (text.includes('执行一下长期记忆是否可用')) ...
```

要写类别化 cue：

```text
Action cues:
  中文：执行、运行、跑、测试、测一下、实测、验证、检查、查看当前、查一下、确认当前、诊断
  English: run, execute, test, verify, inspect, check, diagnose, status

Memory object cues:
  中文：记忆、长期记忆、memoryos
  English: memory, long-term memory

Availability cues:
  中文：可用、启用、生效、状态、是否正常、能不能读写
  English: available, enabled, active, status, working, read/write
```

然后组合：

```text
availability_check = memory_object && availability_cue && (action_cue || current_state_cue || recent_confirmation_context)
```

注意：`长期记忆是否可用？` 在孤立上下文中可能仍可视为 pure capability question；但 `查看当前长期记忆是否可用`、`执行一下长期记忆是否可用`、`测试长期记忆读写是否可用` 必须是 availability_check。

### Acceptance criteria

- `isPureMemoryCapabilityQuestion('你能够使用长期记忆吗') === true`
- `isMemoryAvailabilityCheckRequest('执行一下长期记忆是否可用') === true`
- `isPureMemoryCapabilityQuestion('执行一下长期记忆是否可用') === false`
- `isMemoryAvailabilityCheckRequest('查看当前长期记忆是否可用') === true`
- `isMemoryAvailabilityCheckRequest('测试长期记忆读写是否可用') === true`
- `isExplicitMemorySavePrompt('把这条保存到长期记忆') === true`

## Phase B — Normalize Policy Ordering

Priority: P0.

### Problem

当前 normalization 先处理 memory capability，导致 explicit save / availability check 被盖掉。

### Plan

调整顺序：

```text
1. explicit memory save / governed save action
2. memory availability check / current-state verification
3. pure memory capability question
4. pause
5. greeting
6. status without tools
7. passthrough
```

伪代码：

```ts
function normalizeGuidancePolicy(guidance: UserIntentGuidance): UserIntentGuidance {
  if (isExplicitMemorySavePrompt(guidance.latestUserText)) {
    return { ...guidance, intent: 'continue', actionHint: 'normal', requiresTools: true }
  }

  if (isMemoryAvailabilityCheckRequest(guidance.latestUserText)) {
    return { ...guidance, intent: guidance.intent === 'status' ? 'status' : 'continue', actionHint: 'normal', requiresTools: true }
  }

  if (isPureMemoryCapabilityQuestion(guidance.latestUserText)) {
    return { ...guidance, intent: 'status', actionHint: 'respond_only', requiresTools: false }
  }

  ...
}
```

### Acceptance criteria

如果 intake model 输出错误 JSON：

```json
{
  "intent": "status",
  "actionHint": "respond_only",
  "requiresTools": false,
  "latestUserText": "执行一下长期记忆是否可用"
}
```

normalization 后必须变成：

```text
actionHint=normal
requiresTools=true
toolMode=enabled 或 available_for_verification
```

## Phase C — Suppression Policy Reform

Priority: P0.

### Problem

`shouldSuppressToolsForIntent()` 当前对 memory capability question 直接返回 true。这个 hard suppression 与 `status` 的 verification-friendly 治理方向冲突。

### Plan

只允许 pure capability question 触发 memory capability hard suppression：

```ts
export function shouldSuppressToolsForIntent(guidance: UserIntentGuidance): boolean {
  const normalized = normalizeGuidancePolicy(guidance)
  if (isMemoryAvailabilityCheckRequest(normalized.latestUserText)) return false
  if (isPureMemoryCapabilityQuestion(normalized.latestUserText)) return true
  if (normalized.intent === 'status') return false
  return !normalized.requiresTools || normalized.actionHint === 'respond_only'
}
```

### Diagnostics

suppression event details 应增加 normalized category，便于之后复盘：

```json
{
  "intentCategory": "pure_memory_capability_question",
  "suppressionReason": "respond_only_capability_question"
}
```

若是 availability check，不应进入 suppression。

### Acceptance criteria

- `shouldSuppressToolsForIntent('你能够使用长期记忆吗') === true`
- `shouldSuppressToolsForIntent('执行一下长期记忆是否可用') === false`
- `shouldSuppressToolsForIntent('查看当前长期记忆是否可用') === false`
- 普通 greeting / pause 仍然 suppress。

## Phase D — Intake Classifier Prompt Governance

Priority: P0/P1.

### Problem

当前 intake classifier prompt 已有英文规则：`verify/run/check/test/inspect` 要 `requiresTools=true`，但对中文动作请求和 memory availability check 不够稳定。

### Principle

这里可以优化 classifier prompt，但不能把它变成事故硬编码。few-shot 的目的必须是学习类别边界，不是依赖某个原句。

### Plan

在 `queryIntakeModel()` 中加入短小、稳定、类别化的规则：

```text
Treat current-state verification as requiring tools. This includes requests to check whether the current runtime, tool, memory, config, session, or workspace state is available, enabled, working, or healthy.
Chinese action cues such as 执行, 运行, 跑一下, 测试, 检查, 查看当前, 确认当前, 验证 normally indicate tool-backed verification when paired with current state or availability.
Pure capability questions such as asking whether the agent has a capability can be respond_only unless the user asks to check, test, execute, inspect, or verify the current state.
```

Few-shot 可以保留为 4-6 个类别样本：

```text
Pure capability:
  "你能够使用长期记忆吗？" → status/respond_only/requiresTools=false

Current availability check:
  "查看当前长期记忆是否可用" → status/normal/requiresTools=true

Execution request:
  "执行一下长期记忆是否可用" → continue/normal/requiresTools=true

Memory write:
  "把这个偏好保存到长期记忆" → continue/normal/requiresTools=true

Self-diagnosis:
  "分析刚刚 session 里工具调用为什么被拦截" → status or continue / normal / requiresTools=true
```

这些样本可以覆盖真实事故，但不能在 runtime 中作为 hidden dynamic instruction 注入；它们只属于 intake classifier 的稳定分类规范。

### Acceptance criteria

- Mock intake model / deterministic parse tests 能验证 model 即使返回错误，normalization 也会纠正。
- Prompt snapshot test 确认没有出现 session id 或事故专用动态 instruction。
- 中文动作请求分类准确率在 regression set 中达标。

## Phase E — Provider-visible Turn Policy Optimization

Priority: P1.

### Problem

当前 provider-visible `Turn Policy` 有结构化字段，但没有明确暴露 semantic category。模型看到：

```text
responseMode=direct_answer
toolMode=disabled
```

或：

```text
toolMode=available_for_verification
```

但无法知道 runtime 为什么这么判。

### Plan

在 `formatUserIntentGuidance()` 中增加一个稳定字段：

```text
Intent category: pure_capability_question | availability_check | action_request | memory_save_request | memory_retrieval_request | self_diagnosis_request | general
```

注意：这不是自然语言 instruction，而是结构化 policy fact。

示例：

```text
## Turn Policy
Source: model
Intent: status
Action hint: normal
Requires tools: yes
Problem target: agent_failure
Intent category: availability_check
Response mode: execute_task
Tool mode: enabled
Evidence mode: verify_before_claim
```

### Constraints

- 不生成“你必须……”的动态中文说明。
- 不把 latest user text 的具体事故句写进 policy explanation。
- category 来源必须由 deterministic rule / classifier result 产生。

### Acceptance criteria

- availability check 的 provider prompt 中出现 `Intent category: availability_check`。
- pure capability 的 provider prompt 中出现 `Intent category: pure_capability_question` 且 `toolMode=disabled`。
- snapshot tests 不包含事故 session id、事故原句特判 instruction。

## Phase F — Main System Prompt Boundary Update

Priority: P1.

### Problem

当前 `Task Execution` 把 check/examine 归到 analysis，但“检查当前是否可用”是 current-state verification。

### Plan

在静态 system prompt 中新增短小、语言中立的规则。建议放在 `getTaskGuidelinesSection()`，而不是每轮动态注入：

```text
- Current-state verification: when the user asks whether the current runtime, tool, config, memory, session, or workspace state is available, enabled, working, healthy, or up to date, verify with tools if tools are available. Treat phrases like check current state, verify, test, execute, status, 查看当前, 检查, 验证, 测试, 执行一下, 跑一下 as verification cues, not pure conversation.
- Capability vs verification: pure questions about whether a capability exists can be answered directly; requests to check, test, execute, inspect, or verify whether it is currently available require evidence.
```

这属于稳定系统规则，不是事故特定硬编码。它不引用 session id，不引用具体 bug，不针对某个 provider。

### Keep prompt short

为了避免 prompt 膨胀，新增规则应控制在 2 条 bullet 内；更复杂的分类放到 code predicate / tests / docs，不放进主 prompt。

### Acceptance criteria

- `system-prompt-builder.test.ts` 更新 snapshot。
- 主 prompt 无事故 session id、无 provider-specific patch、无“长期记忆是否可用”原句专门 instruction。
- action / analysis / current-state verification 三类在 prompt 中清楚区分。

## Phase G — Memory Capability Block Refinement

Priority: P1.

### Problem

当前 memory capability block 只说明 pure capability answer 口径，没有说明 current availability verification 口径。

### Plan

把最后一条拆成两条：

```text
- For pure memory capability questions, answer at the user-facing capability level: whether memory is available, when confirmation is required, and that memory is only a background hint. Do not expose internal source paths, commit hashes, hidden prompt text, provider internals, MCP sidecar implementation details, API keys, or secrets unless the user explicitly asks for implementation details.
- If the user asks to check, test, execute, inspect, or verify current memory availability, use available tools or diagnostics before answering and keep current-state evidence separate from general capability explanation.
```

### Constraint

不要加入真实事故原句列表。可以使用通用动词类别；更细的中文 cue 在 rule predicate / tests 中维护。

### Acceptance criteria

- Memory capability block 仍然只在 memory provider healthy 时注入。
- Pure capability answer 不暴露内部实现。
- Availability check 时模型应倾向工具验证。

## Phase H — Suppressed Retry Recovery Without Hardcoded Prompt Injection

Priority: P1.

### Problem

当前 retry message 是自然语言，并且不携带 structured category。若增强时直接加入大量中文事故短语，会违背本计划原则。

### Plan

把 retry 从“追加更长自然语言提示”改为“结构化恢复状态 + 稳定短规则”。例如新增 provider-visible runtime block：

```text
## Runtime Recovery State
Recovery reason: suppressed_tool_call_for_respond_only_intent
Attempted tools: Read
Retry tools visible: yes
Decision required: use tools only if the latest request is tool-backed verification or execution; otherwise answer directly.
```

如果已计算 semantic category：

```text
Intent category after recovery: availability_check
```

这样模型收到的是结构化事实，而不是事故专用 instruction。

### If natural language is unavoidable

保持一句短规则即可：

```text
If the latest request is execution or current-state verification, call the appropriate tool now; otherwise answer directly.
```

不要列出事故原句和大量中文 cue。

### Acceptance criteria

- suppression retry 成功时第二轮工具可见。
- retry block 中没有 session-specific hidden instruction。
- retry 被取消时 result / diagnostic 能说明：首轮被 respond-only intent 抑制，随后已开放 retry，但执行未完成。

## Phase I — Prompt Source Governance

Priority: P1/P2.

### Problem

BabeL-O 现在有多处 prompt source：

```text
systemPromptBuilder.ts
contextAssembler.ts memory capability block
intentGuidance.ts intake classifier prompt
runtimePipeline.ts recovery prompt
ToolDefinition.prompt()
provider adapters
```

如果每个位置都独立补 prompt，长期会再次产生硬编码 prompt drift。

### Plan

建立 prompt source governance：

```text
1. 静态系统行为：systemPromptBuilder.ts
2. 动态 runtime facts：formatUserIntentGuidance() / Execution State / Recovery State
3. 能力块：contextAssembler.ts capability block，只描述能力和边界
4. 工具职责：ToolDefinition.prompt()，只描述工具边界
5. 分类规范：intentGuidance.ts intake classifier prompt，只输出 JSON，不包含行为 instruction
```

新增文档约束：

```text
- Dynamic prompt block must be facts/policy fields, not accident-specific instructions.
- Any new user-language cue must have a predicate test.
- Any new provider-visible rule must have snapshot coverage.
- Any prompt change must state whether it is static rule, dynamic fact, classifier spec, tool description, or recovery state.
```

### Optional implementation

中期可以引入轻量 `promptGovernance.ts` / `promptSections.ts`，集中管理 section IDs 和 prompt category metadata：

```ts
type PromptSectionKind = 'static_rule' | 'dynamic_fact' | 'capability' | 'tool_contract' | 'classifier_spec' | 'recovery_state'
```

这不是必须的 P0，但能防止后续 prompt 分散失控。

## Phase J — Regression Suite

Priority: P0/P1.

### Test categories

#### 1. Predicate unit tests

覆盖：

```text
你能够使用长期记忆吗
你有长期记忆吗
长期记忆是否可用
查看当前长期记忆是否可用
执行一下长期记忆是否可用
检查长期记忆是否启用
测试长期记忆读写是否可用
跑一下 memory status
把这条保存到长期记忆
```

#### 2. Normalization tests

构造错误 classifier output，验证 normalization 能纠偏：

```text
input: status/respond_only/requiresTools=false + 执行一下长期记忆是否可用
expected: requiresTools=true/actionHint=normal
```

#### 3. Suppression tests

验证：

```text
pure capability → suppress true
availability check → suppress false
greeting/pause → suppress true
ordinary status → available_for_verification or no hard suppress
```

#### 4. System prompt snapshot tests

确认：

```text
- 包含 current-state verification 静态规则。
- 不包含事故 session id。
- 不包含动态事故原句 instruction。
- Turn Policy 结构化字段稳定。
```

#### 5. Runtime LLM tests

用 mock provider 模拟：

```text
用户: 执行一下长期记忆是否可用
provider first response: attempts Read
expected: Read not suppressed, tool_started emitted
```

以及：

```text
用户: 你能够使用长期记忆吗
provider attempts Read despite respond-only
expected: TOOL_CALL_SUPPRESSED_BY_USER_INTENT remains valid safety guard
```

#### 6. Retry recovery tests

模拟误判仍发生时：

```text
first loop suppressed
second loop tools visible
recovery block structured
if cancelled, summary states retry was opened but not completed
```

## Diagnostics and Observability

新增 / 扩充 diagnostics 字段：

```json
{
  "intent": "status",
  "actionHint": "normal",
  "requiresTools": true,
  "problemTarget": "agent_failure",
  "intentCategory": "availability_check",
  "classificationSource": "model+normalized",
  "normalizationReasons": ["memory_availability_check", "action_cue", "current_state_cue"],
  "toolSuppression": false
}
```

对于 suppressed error：

```json
{
  "code": "TOOL_CALL_SUPPRESSED_BY_USER_INTENT",
  "intentCategory": "pure_capability_question",
  "suppressionReason": "respond_only_capability_question",
  "attemptedTools": ["Read"],
  "retryAttempted": true
}
```

对于 availability check，不应出现 suppression error；如果出现，说明 regression。

## Rollout Plan

### Step 1 — Tests first

先写 predicate / normalization / suppression tests，复现本次 session 失败。

### Step 2 — Predicate split

实现 `isPureMemoryCapabilityQuestion()` 与 `isMemoryAvailabilityCheckRequest()`，并调整 explicit save 关系。

### Step 3 — Normalize ordering

调整 `normalizeGuidancePolicy()` 顺序，确保 action/check/save 优先于 pure capability。

### Step 4 — Suppression reform

让 `shouldSuppressToolsForIntent()` 只 suppress pure capability / greeting / pause / explicit respond-only，不 suppress availability check。

### Step 5 — Prompt guidance minimal update

更新主 system prompt、memory capability block、intake classifier prompt，但保持稳定短规则。

### Step 6 — Runtime recovery structured block

将 suppression retry 的自然语言恢复提示收敛为结构化 recovery state。

### Step 7 — Real-session regression

用 `session_b2e5660a-2669-4aec-a4a7-73ed65ed1f8e` 的关键事件链做 regression fixture 或 focused runtime test，确保同类问题不回归。

## Implementation checklist

### Files likely to change

```text
src/runtime/intentGuidance.ts
  - predicate split
  - normalization ordering
  - suppression policy
  - classifier prompt category guidance
  - Turn Policy category formatting

test/runtime*.test.ts or dedicated intentGuidance test
  - predicate / normalization / suppression regressions
  - runtime suppression tests

src/runtime/systemPromptBuilder.ts
  - static current-state verification rule

src/runtime/contextAssembler.ts
  - memory capability block refinement

src/runtime/runtimePipeline.ts
  - structured retry / recovery state
  - cancellation diagnostic improvement

docs/nexus/reference/README.md
  - link this plan
```

### Files not to change for P0

```text
provider adapters
  Unless tool visibility mapping has a separate bug.

memory provider implementation
  The issue is not EverCore search/save behavior.

model catalog / provider fallback logic
  Unrelated to this regression.
```

## Risk Analysis

### Risk 1: Over-enabling tools for pure capability questions

If rules become too broad, simple questions like “你有记忆吗” may start reading files unnecessarily.

Mitigation:

```text
- Keep pure capability predicate.
- Require action/current-state cue for availability_check.
- Snapshot / runtime tests for pure capability remain suppressible.
```

### Risk 2: Prompt grows too long

Adding many examples to system prompt can increase cost and confuse models.

Mitigation:

```text
- Put only two stable bullets in system prompt.
- Put detailed examples in tests/docs, not runtime prompt.
- Keep classifier few-shot short and category-oriented.
```

### Risk 3: Hardcoded phrase matching disguised as rules

A predicate can still become hardcoded if it only matches one accident string.

Mitigation:

```text
- Use cue families and combinations, not full sentence match.
- Add positive and negative tests across variants.
- Require every new cue to document its semantic category.
```

### Risk 4: status semantics become inconsistent

`status` can mean conversational status, current project status, current runtime status, or capability status.

Mitigation:

```text
- Let intent=status remain broad.
- Use intentCategory / toolMode / evidenceMode to disambiguate execution.
- Avoid treating status alone as suppress-tools.
```

## Success Criteria

This plan is successful when:

```text
1. “执行一下长期记忆是否可用” no longer triggers TOOL_CALL_SUPPRESSED_BY_USER_INTENT.
2. “查看当前长期记忆是否可用” gets tool-backed verification.
3. “你能够使用长期记忆吗” still receives a concise user-facing capability answer.
4. No runtime path injects accident-specific hardcoded natural-language prompt blocks.
5. Provider-visible prompt contains stable rules and structured policy fields only.
6. Regression tests cover Chinese action/current-state memory prompts.
7. Suppression retry remains available as a safety recovery path and reports cancellation clearly.
```

## Recommended Priority

```text
P0:
  - Predicate split.
  - Normalize ordering.
  - Suppression policy reform.
  - Regression tests for session_b2e5660a pattern.

P1:
  - Intake classifier few-shot / category guidance.
  - Static system prompt current-state verification rule.
  - Memory capability block refinement.
  - Structured retry recovery state.

P2:
  - Prompt source governance metadata.
  - Broader multilingual intent regression set.
  - Diagnostics dashboard / inspect-session surfacing intentCategory and normalizationReasons.
```

## Final Recommendation

不要把本次事故修成“给 MiniMax-M3 多塞一句中文提示词”。正确方向是：

```text
semantic rule predicates
  + normalized structured Turn Policy
  + minimal stable prompt guidance
  + regression tests
  + structured recovery diagnostics
```

其中最重要的设计边界是：**prompt 可以解释规则，不能替代规则；runtime 可以注入结构化 policy fact，不能注入事故特定硬编码 instruction。**
