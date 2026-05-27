# BabeL-O vs BabeL-X 上下文管理深度对比分析

> 生成时间：2026-05-25
> 更新口径：基于当前工作树，已纳入 `compact_boundary.retainedEvents`、auto-compact benchmark、显式路径锚定和 recovery boundary 修复后的状态。
> 分析范围：BabeL-O `src/runtime/contextAssembler.ts`、`compact.ts`、`LLMCodingRuntime.ts`、`hooks.ts`、`shared/events.ts` vs BabeL-X `src/services/compact/`、`src/services/SessionMemory/`、`src/query.ts`、`src/components/TokenWarning.tsx`、`src/utils/analyzeContext.ts`。
> 方法：逐行源码阅读 + 架构行为推演。

---

## 一、当前结论

BabeL-O 的上下文管理已经不是早期“硬截断 + summary”的状态。当前已经具备：

- persisted `compact_boundary`。
- `compact_boundary.retainedEvents` 保留最近 tail。
- `contextAssembler` 用 `retainedEvents + boundary 后续事件` 恢复上下文。
- repeated compact 继承上一轮 retained tail。
- recovery boundary，避免取消/超时/失败后继续旧任务。
- 显式路径锚定和 focus project，降低旧上下文带偏。
- manual/auto compact smoke 与 benchmark。

因此，BabeL-O 当前约处于 BabeL-X 上下文管理能力的 **65%-70%**。核心差距已经从“有没有 compact / boundary 是否持久化”，转移到：

1. token 估算精度和阻塞阈值；
2. compact 后结构化状态重建；
3. Session Memory / microcompact 这类低成本降级层；
4. `/context` 诊断与用户可见预警；
5. preserved segment / resume verification；
6. context-window provider error 的 fallback recovery。

---

## 二、架构总览对比

| 维度 | BabeL-X | BabeL-O 当前状态 |
|------|---------|------------------|
| 预算体系 | 精确 token 计数（API count → Haiku fallback → 本地估算），动态阈值 | 字符/JSON 粗估为主，分层预算仍偏名义化；中文、JSON、tool schema 容易低估 |
| 触发阈值 | `effectiveContextWindow - 13K`，并有 warning/error/blocking limit | `maxTokens * thresholdPercent`，有 warning 和 auto threshold，但缺 blocking hard stop |
| 压缩层级 | Microcompact → Session Memory → Traditional Compact → Reactive/Blocking | Snip tool output → compact boundary + retainedEvents → recovery boundary；无 Session Memory / microcompact |
| 压缩后结构 | boundary + summary + messagesToKeep + attachments + hooks | boundary + summary + retainedEvents；缺 attachments/hooks/MCP/tool delta 重建 |
| 持久化恢复 | preservedSegment + tail→head UUID walk 验证 | latest boundary + retainedEvents；无链式验证和完整性哈希 |
| 后台记忆 | Session Memory forked agent 持续提取 `.session-memory.md` | 无会话内持续记忆；只有 project memory 与规则摘要 |
| UI/诊断 | TokenWarning + `/context` 可视化网格 + compact 进度 | `context_warning` 事件和 renderer 文本展示；缺 `/context` 诊断命令 |
| 熔断机制 | 3 次连续失败熔断，manual compact 可作为恢复信号 | failure limit 可配，默认 2；manual compact 重置语义仍待修正 |
| 模型恢复 | `max_output_tokens` 可 fallback model / escalation | 无 context-window/provider max-output 恢复链 |

---

## 三、逐项差距

### 3.1 Token 估算与阈值控制（当前 P0）

BabeL-X 的 `tokenCountWithEstimation()` 会优先复用最近 API usage，再对 usage 后的增量消息做 rough estimation；API count / Haiku fallback / local rough estimation 分层存在。它还对 image/document/tool_use/tool_result/thinking 等 block 分别估算。

BabeL-O 当前仍主要以 JSON 字符长度推 token，并用 `contextWindow * 0.8` 推出 maxTokens。这个策略对英文短对话尚可，但对中文、多工具结果、JSON schema、MCP/tool definitions 和代码块不够稳。

影响：

- 中文长会话可能 2-4 倍低估；
- auto-compact 触发偏晚；
- provider 先报 `prompt_too_long`，runtime 才知道超限；
- `/context` 诊断无法解释真实 token 消耗。

首要任务：新增 `src/runtime/tokenEstimator.ts`，用 provider-neutral 的保守估算替代 `chars / 4`。

### 3.2 Blocking Limit 缺失（当前 P0）

BabeL-X 在 `calculateTokenWarningState()` 中同时计算 warning/error/auto/blocking 状态，blocking limit 默认是 effective window 减去 manual compact buffer。

BabeL-O 有 `context_warning` 和 auto-compact decision，但缺少 provider call 前硬拦截。正确行为应该是：

1. warning threshold：发 `context_warning`；
2. auto threshold：尝试 auto compact；
3. blocking limit：compact 后仍超限则阻断 provider call，提示 `/context` / `/compact`，避免把必失败请求发出去。

### 3.3 Compact 后结构化状态重建（当前 P1）

BabeL-X 的 `buildPostCompactMessages()` 顺序是：boundary、summary、messagesToKeep、attachments、hookResults。compact 后还会恢复最近文件、plan、skill、MCP/tool delta、agent listing 和 session start hooks。

BabeL-O 目前通过 `retainedEvents` 保留最近 tail，已经解决“恢复后最近轮次丢失”的关键问题，但还没有重建：

- 最近 Read 成功的文件内容或引用；
- active skills 的内容摘要；
- MCP tools / tool instructions；
- 当前 planner/task/sub-agent 状态；
- hook result / session-start 类上下文。

这会导致 compact 后模型仍可能“知道最近对话”，但忘记刚才读过哪些文件、可用哪些 MCP/tool、当前 agent/task 处于什么状态。

### 3.4 Session Memory 缺失（当前 P2，待前置能力稳定）

BabeL-X 的 Session Memory 是低成本后台层：按 token growth + tool calls + 自然停顿触发，forked agent 只允许编辑 session memory 文件，并用 sequential 避免并发写冲突。

BabeL-O 目前没有这层。短期不建议直接迁移完整 BabeL-X 实现，应先完成 token estimator、hooks timeout/error isolation、post-compact rebuild 和成本控制，再做 `Session Memory Lite`：

- 文件：`.babel-o/session-memory.md`；
- 触发：token growth + tool calls + last assistant no tool calls；
- 权限：只能读写 session-memory 文件；
- 默认：先 opt-in；
- 输出：作为 `Session Memory` block 注入 system prompt，并可供 compact 优先使用。

### 3.5 `/context` 诊断缺失（当前 P1）

BabeL-X 有 `/context` 和 `analyzeContext`，能看到工具、附件、技能、消息、系统提示各自占用。

BabeL-O 目前只有 context metrics 和 `context_warning` 文本，无法回答这些问题：

- 是 system prompt 太大，还是 tool results 太大？
- compact retainedEvents 保留了哪些？
- active skills/MCP tool schema 占了多少？
- 当前离 warning/auto/blocking 还剩多少？
- 为什么模型被旧上下文带偏？

下一步应新增 runtime-level `analyzeContext()`，CLI `/context` 只是展示层。

### 3.6 API invariant / microcompact 缺口（当前 P1）

BabeL-X 有 `adjustIndexToPreserveAPIInvariants()` 和 microcompact，避免截断破坏 `tool_use/tool_result` 配对，也能清理旧 tool output 而不是整段丢弃。

BabeL-O 已经在 `mapEventsToMessages()` 处理了一些 orphan tool result 和 grouped tool calls，但上下文选择阶段还缺一个 invariant guard。当前如果 `tool_started` 被保留而 `tool_completed` 被截断，可能合成“denied or interrupted”，这对模型是误导。

建议：select recent events 后执行 normalize/guard：

- 尽量成对保留 `tool_started/tool_completed`；
- 被截断的工具明确标注 `truncated_by_context_compaction`；
- 旧大输出先 snip/microcompact，再决定是否丢弃；
- 不让 synthetic failure 混淆真实 permission denial / cancellation。

### 3.7 Preserved Segment / Resume Verification（当前 P2/P3）

BabeL-X 会在 compact boundary 中记录 preserved segment 的 head/anchor/tail UUID，并在 resume 时验证链路。

BabeL-O 当前 `retainedEvents` 是实用修复，但没有完整性证明。后续可用更轻量的 event identity：

- boundary id；
- retained head/tail identity；
- retained count；
- retained hash；
- events-after-boundary first identity。

恢复时校验失败则：

- 回退完整历史；或
- 输出 context integrity warning；或
- 禁用该 boundary。

---

## 四、当前开发优先级

### Phase 1：立即推进（P0）

1. **Context Token Estimator**
   - 新增 `src/runtime/tokenEstimator.ts`。
   - 替换 runtime 中 `estimateMessagesChars()/4`。
   - 覆盖 CJK、JSON/tool schema、tool_use/tool_result、thinking/image/document、MCP/tool overhead。
   - 增加中文长会话 benchmark。

2. **Context Blocking Limit**
   - 计算 warning / auto / blocking 三层阈值。
   - provider call 前硬拦截必失败请求。
   - compact 后仍超限时返回可恢复 error，并提示 `/context` / `/compact`。

3. **System Prompt 分层硬截断**
   - project memory、session summary、skills、focus/path block 各自有预算。
   - 截断状态进入 context analysis 和 system prompt 提示。

### Phase 2：可诊断与结构化恢复（P1）

4. **`/context` 诊断命令 + analyzeContext API**
   - 输出 context window、估算 token、阈值、各层占用和建议动作。
   - 支持 JSON 结果用于测试和 benchmark。

5. **Post-Compact State Rebuild**
   - 重建最近 Read 文件引用、active skills、MCP/tool instructions、task/agent status、hook results。
   - 第一版可以用 system prompt block，不必迁移 BabeL-X attachment message 全套。

6. **API Invariant Guard / Microcompact**
   - 保护 tool pair；
   - 清理旧 tool output；
   - 标注 context truncation，不伪装成 denial/interruption。

7. **manual compact 重置 auto-compact fuse**
   - 用户手动 compact 成功后应作为恢复信号，清空连续 auto failure。

### Phase 3：低成本长期记忆（P2）

8. **Session Memory Lite**
   - opt-in；
   - sequential；
   - 只读写 `.babel-o/session-memory.md`；
   - 触发条件参考 BabeL-X，但用 BabeL-O hook/event 实现。

9. **Preserved Segment / Resume Verification**
   - 给 compact boundary 增加 retained segment identity/hash；
   - resume 时验证；
   - 异常时回退完整历史或产出 warning。

10. **Model Fallback / Max Output Recovery**
    - context-window/provider max-output 错误进入恢复链；
    - 与 provider registry role routing 联动。

---

## 五、文档同步结论

- `persist:false` / boundary 不持久化已经不是当前 P0，应保留为已修复历史。
- 当前首要 P0 是 token estimator、blocking limit 和 system prompt budget。
- `retainedEvents` 是正确的 BabeL-O 化方向，但不能等同于 BabeL-X 的 `messagesToKeep + attachments + hooks`。
- 近期不应直接迁移 BabeL-X Session Memory 全套；应先补 token estimator、diagnostics、post-compact rebuild 和 API invariant guard。
