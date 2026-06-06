# Intake Classifier 升级规划

> Status: Phase 1/2/3/4 completed
> Priority: P1 (真实会话 regression 驱动)
> 真实样本: `session_a30306de-0933-455a-8263-d14fab1edd24` — "验证当前未提交改动是否健康" 被误分类为 `intent=status, requiresTools=false`，导致工具被隐藏，模型无法执行 `npm test`。

---

## 问题诊断

### 当前架构

```
用户消息 → queryIntakeModel() [模型分类]
                │ 失败 fallback ↓
         deriveFallbackUserIntentGuidance() [regex]
                │
                ▼
         normalizeGuidancePolicy() [硬覆盖]
         → if intent ∈ {status, greeting, pause}: 强制 respond_only + requiresTools=false
                │
                ▼
         shouldSuppressToolsForIntent() → 隐藏工具
```

### 核心缺陷

1. **`normalizeGuidancePolicy()` 对 `status` intent 硬覆盖 `requiresTools=false`**
   - 模型即使判断 `requiresTools=true`，也会被覆盖
   - 等于 `status` 类别下模型的 `requiresTools` 维度完全失效

2. **模型 prompt 缺 few-shot 消歧示例**
   - "验证" 在中文里既可以是"确认一下"（信息类）也可以是"跑一遍"（执行类）
   - 模型无法区分 status-query vs status-verify

3. **抑制不可逆**
   - 一旦分类器判定 respond_only，工具被完全隐藏
   - 模型没有 retry 或自我修正的机会
   - 对比 Codex：工具始终可见，靠 prompt 引导模型自行决定是否调用

4. **六分类 intent 中 `status` 语义过宽**
   - "你在干什么" → 不需要工具
   - "验证改动是否健康" → 需要工具
   - 两者被归入同一 intent 并受同一策略强制

---

## 设计目标

1. 消除"分类器误判 → 工具不可用 → 不可逆体验断裂"的问题
2. 保留分类器对上下文管理的价值（旧工具链不被短追问触发、省 token）
3. 保留 pause/greeting 的安全兜底
4. 与 Codex 策略对齐：信任模型判断 > 预判用户意图

---

## 改进方案

### Phase 1: 放松 `normalizeGuidancePolicy()` 硬覆盖

**变更**: `status` intent 不再强制 `requiresTools=false`

```typescript
function normalizeGuidancePolicy(guidance: UserIntentGuidance): UserIntentGuidance {
  if (guidance.intent === 'pause') {
    return { ...guidance, contextScope: 'recent', actionHint: 'respond_only', requiresTools: false }
  }
  if (guidance.intent === 'greeting') {
    return { ...guidance, actionHint: 'respond_only', requiresTools: false }
  }
  // status: 尊重模型的 requiresTools 判断
  if (guidance.intent === 'status' && !guidance.requiresTools) {
    return { ...guidance, actionHint: 'respond_only' }
  }
  return guidance
}
```

**效果**: 模型判断 `intent=status, requiresTools=true` 时不再被覆盖，工具保持可见。

**回归风险**: pause/greeting 不受影响；status 类别可能偶尔多一次工具调用，但这本身是正确行为。

### Phase 2: 补强模型 prompt few-shot

在 `queryIntakeModel()` 的 prompt 中增加中英文消歧示例：

```
Examples:
- "你在干什么" → intent:status, requiresTools:false
- "当前什么状态" → intent:status, requiresTools:false
- "验证当前改动是否健康" → intent:continue, requiresTools:true
- "检查一下测试能不能过" → intent:continue, requiresTools:true
- "跑一下lint" → intent:continue, requiresTools:true
- "run the tests" → intent:continue, requiresTools:true
- "what are you doing" → intent:status, requiresTools:false
- "check if tests pass" → intent:continue, requiresTools:true
```

**原则**: 含执行动词（验证/跑/运行/检查/测试/check/run/verify）+ 工程对象（改动/测试/lint/build）的组合 → `requiresTools=true`。

### Phase 3: 工具抑制降级为 prompt guidance

**当前**: respond_only → 完全隐藏工具定义
**改进**: respond_only → 工具仍可见，但注入 context guidance：

```
The user appears to be asking a status/greeting question.
Answer from existing context unless you genuinely need to run a command to verify.
Do not start multi-step tool chains for this message.
```

**适用范围**: 仅对 `status` intent 生效；`pause` 和 `greeting` 仍可隐藏工具（用户明确不想继续）。

**效果**: 模型有工具但被引导优先不用；如果确实需要，模型可以自主决定调用。

### Phase 4: suppress 可恢复 retry

将 `TOOL_CALL_SUPPRESSED_BY_USER_INTENT` 也接入一次 retry：

- 当 respond_only 场景下模型尝试调用工具时，不直接丢弃
- 注入 retry prompt："如果你确实需要执行命令来回答用户，可以调用工具；否则直接回答。"
- 一次 retry 后仍调用工具 → 允许执行

**状态**: 已落地。Phase 4 作为最终安全网保留，正常 status 短问仍优先通过 Phase 3 prompt guidance 避免工具链。

---

## 实现优先级

| Phase | 改动量 | 风险 | 依赖 |
|-------|--------|------|------|
| Phase 1 | ~10 行 | 低 | 无 |
| Phase 2 | ~20 行 prompt | 低 | 无 |
| Phase 3 | ~30 行 runtime | 中 | Phase 1 |
| Phase 4 | ~40 行 runtime | 中 | Phase 3 |

Phase 1/2/3/4 已全部落地；后续只在真实 provider 漂移暴露新样本时按 regression-first 补最小回归。

---

## 验证标准

Phase 1/2/3/4 已验证：

1. `"验证当前未提交改动是否健康"` → `requiresTools=true`，工具可见，模型可执行 `npm test`
2. `"你在干什么"` / `"还记得我刚刚问什么吗"` → `requiresTools=false`，status guidance，工具可见但提示优先从现有上下文回答
3. `"跑一下 lint"` → `requiresTools=true`，normal
4. `"hi"` / `"你是谁"` → `requiresTools=false`，respond_only，首轮工具隐藏
5. `"先停"` → `requiresTools=false`，respond_only，首轮工具隐藏
6. respond-only 场景下 provider 首次尝试工具调用 → `TOOL_CALL_SUPPRESSED_BY_USER_INTENT` + retry prompt
7. retry 后 provider 仍调用工具 → 工具重新可见并允许执行
8. 现有 intake regression corpus 全部通过

验证命令：

- `cd "/Users/tangyaoyue/DEV/BABEL/BabeL-O" && BABEL_O_CONFIG_FILE="/tmp/babel-o-intake-phase4-runtime-test-config.json" node --import tsx --test "test/runtime.test.ts"`
- `cd "/Users/tangyaoyue/DEV/BABEL/BabeL-O" && BABEL_O_CONFIG_FILE="/tmp/babel-o-intake-phase4-llm-test-config.json" node --import tsx --test "test/runtime-llm.test.ts"`
- `cd "/Users/tangyaoyue/DEV/BABEL/BabeL-O" && BABEL_O_CONFIG_FILE="/tmp/babel-o-intake-phase4-context-test-config.json" node --import tsx --test "test/context-regression.test.ts"`
- `npm --prefix "/Users/tangyaoyue/DEV/BABEL/BabeL-O" run typecheck`
- `npm --prefix "/Users/tangyaoyue/DEV/BABEL/BabeL-O" run format:check`
- `git -C "/Users/tangyaoyue/DEV/BABEL/BabeL-O" diff --check`

---

## 与 Codex 方案的对齐

| Codex 策略 | BabeL-O 改进后 |
|------------|---------------|
| 工具始终可见 | status 类别工具保持可见（Phase 3） |
| prompt 引导不调用 | context guidance 引导优先不调用（Phase 3） |
| 未知工具 → 返回错误让模型修正 | suppress → retry prompt（Phase 4） |
| 无预分类器 | 保留分类器用于上下文管理，但降级其工具可见性权力 |

---

## 文档索引

- 真实回归样本: `session_a30306de-0933-455a-8263-d14fab1edd24`
- 源码: `src/runtime/intentGuidance.ts`
- 事件 schema: `src/shared/events.ts` → `UserIntakeGuidanceEventSchema`
- 对比项目: `/Users/tangyaoyue/DEV/codex` (Codex 无 intake 分类器，信任模型判断)
