# Intent Guidance 架构简化执行计划

**Status**: Implemented - default simplified path under fallback flag
**Created**: 2026-07-10
**Updated**: 2026-07-11
**Source**: [intent-guidance-architecture-optimization-analysis.md](./intent-guidance-architecture-optimization-analysis.md)
**Priority**: P2 (Architecture Optimization)
**Estimated Effort**: 5-7 days (revised from 3-5)
**Token Savings**: 87-89% provider-visible intent guidance chars in measured prompts

---

## 状态更新

### 2026-07-11 实施记录

**已落地**:
- 新增 `intentGuidanceSelector.ts` 作为统一门面，默认启用 simplified path；`BABEL_O_INTENT_GUIDANCE=default` 保留旧实现回退。
- `contextAssembler.ts`、`prepareRuntimeStart.ts`、`LLMCodingRuntime.ts`、`providerTurn.ts`、`contextAnalysis.ts` 已切换到 selector，避免提示词、intake event、工具抑制和 diagnostics 各自走不同策略。
- simplified provider-visible guidance 压缩为 5 行控制字段：`I`、`A`、`T`、`Auth`、`Why`。
- 工具抑制收敛为硬 respond-only 场景：pause、greeting、纯记忆能力问答、无授权的选择/元行为问题；普通 inspect/status/continue 请求保持工具可见。
- `/context` diagnostics 新增 `intentGuidance` 块，记录 mode、provider-visible 字符数、旧格式 baseline、估算节省量、工具可见性与抑制原因。

**实测样本**:

| Prompt | Old chars | New chars | Saved |
| --- | ---: | ---: | ---: |
| `继续任务` | 599 | 65 | 89% |
| `just stop it and waite for me other require` | 609 | 71 | 88% |
| `呃让你分析的就是babel-X项目` | 629 | 81 | 87% |
| `请查看当前项目分支情况` | 607 | 65 | 89% |

**验证**:
- `npm run typecheck`
- `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-intent-further-context.json npx tsx --test test/context-assembler.test.ts`
- `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-intent-further-prepare.json npx tsx --test test/prepare-runtime-start.test.ts`
- `npm run build`
- `bbl go --check --no-start-nexus`

**保留风险**:
- `default` 旧实现至少保留一个版本周期，便于生产回滚。
- 需要继续用真实 session replay 观察 simplified path 的 pause/correction/status 边界。

### Phase 1 进展

**已完成**:
- 创建 `deriveSimplifiedAuthorization()` 新函数
- 简化 `normalizeGuidancePolicy()` 只保留破坏性边界

**发现的关键问题**:

1. **双重路径问题**:
   - `normalizeGuidancePolicy()` (Model 路径)
   - `deriveFallbackUserIntentGuidance()` (Fallback 路径)
   - 两者都有大量正则检查，需要同步简化

2. **测试依赖正则硬守卫**:
   - `test/runtime-llm.test.ts` 有 3 个测试依赖正则纠正 Model 错误判断
   - 这些测试验证的是"正则硬守卫能纠正 Model 误判"的场景
   - 简化后需要决定：保留硬守卫还是信任 Model + 权限守门

3. **设计决策点**:

   | 场景 | 旧方案 | 新方案 | 风险 |
   |------|--------|--------|------|
   | 偏好选择误判 | 正则强制 none | 信任 Model | 工具可能执行 |
   | 元行为问题误判 | 正则强制 none | 信任 Model | 工具可能执行 |
   | 破坏性操作 | 正则强制 destructive | 保留 ✅ | 无 |

---

## 一、背景与目标

### 1.1 问题陈述

当前 Intent Guidance 层采用三层架构：

```
Model Intake Output → normalizeGuidancePolicy() → shouldSuppressToolsForIntent()
```

**核心问题**：
1. **Token 成本高**: ~1000-1200 tokens/turn
2. **代码复杂度高**: 54 functions, 58KB
3. **维护成本高**: 每新增措辞修改多处
4. **冗余设计**: 三层都在回答同一问题

### 1.2 目标

| 指标 | 当前 | 目标 |
|------|------|------|
| Token 消耗 | ~1000-1200/turn | ~300-400/turn |
| 代码行数 | ~1500 lines | ~200 lines |
| 函数数量 | 54 | ~10 |
| 正则数量 | 20+ | ~5 |

### 1.3 约束

1. **不降低授权准确性**: 权限守门作为最终防线
2. **不破坏用户体验**: 继承机制保留
3. **向后兼容**: 已有 session 行为不变

---

## 二、学术依据

### 2.1 关键论文结论

| 论文 | 发现 | 应用 |
|------|------|------|
| "Less is More" (2024) | 减少工具数量 → 70% 效率提升 | 简化推断层 |
| NTILC (2025) | 学习式压缩 → 95% context 减少 | 轻量化 intent |
| CLAI (2025) | 认知负载优化 → 45% token 节省 | 合并冗余层 |
| Prompt Injection (2025) | LLM 授权判断不可靠 | 信任权限守门 |

### 2.2 行业实践

- **OpenAI Function Calling**: 单阶段分类，授权外部执行
- **Anthropic Claude Tool Use**: 单阶段分类，权限守门独立
- **共识**: Intent 分类单层足够，授权守门必须在 LLM 外

---

## 三、当前架构分析

### 3.1 三层职责重叠

```typescript
// Tier 1: 硬守卫
if (isMetaBehaviorQuestion(text)) return 'none'
if (isPreferenceOrOptionSelection(text)) return 'none'

// Tier 2: 正向推导
if (isLocalChangeAuthorizationRequest(text)) return 'local_change'
if (isDestructiveAuthorizationRequest(text)) return 'destructive'

// Tier 3: 兜底
return requiresTools ? 'inspect' : 'none'

// 问题: 三层都在推断 authorizationLevel
```

### 3.2 冗余证据

| 决策点 | Tier 1 | Tier 2 | Tier 3 |
|--------|--------|--------|--------|
| "继续任务" | ❌ 不处理 | ❌ 不处理 | ⚠️ 兜底 inspect |
| "修改文件" | ❌ 不处理 | ✅ local_change | - |
| "为什么你改了" | ✅ none | - | - |

**发现**: 继承机制（Phase 1 修复）已经解决了最核心的问题，三层推断变得冗余。

### 3.3 Token 消耗明细

```
queryIntakeModel prompt:
- System prompt: ~20 tokens
- 分类规则描述: ~300 tokens
- 枚举值定义: ~200 tokens
- 示例: ~300 tokens
- 上下文: ~100 tokens
- 用户输入: ~50 tokens
------------------------------------------
Total: ~970 tokens (input only)

Output: ~150-200 tokens (JSON)
```

---

## 四、简化方案设计

### 4.1 新架构

```
用户输入 + 上下文
      ↓
┌─────────────────────────────────┐
│  deriveAuthorization()          │  ← 单层决策
│  1. 继承检查                     │
│  2. 破坏性边界                   │
│  3. 远程操作边界                 │
│  4. 信任模型判断                 │
└─────────────────────────────────┘
      ↓
┌─────────────────────────────────┐
│  Permission Gate                │  ← 权限守门（已存在）
│  工具调用时检查权限              │
└─────────────────────────────────┘
```

### 4.2 核心函数

```typescript
/**
 * 简化后的授权决策函数
 *
 * 设计原则：
 * 1. 继承优先 - 延续指令继承上一轮授权
 * 2. 边界明确 - 破坏性/远程操作必须显式
 * 3. 信任模型 - Model Intake 有完整上下文
 * 4. 守门兜底 - 权限检查作为最终防线
 */
function deriveAuthorization(
  text: string,
  context: {
    previousAuth?: SessionAuthorizationState
    modelAuthLevel?: AuthorizationLevel
  }
): AuthorizationLevel {
  // 1. 继承检查（最优先，token 成本最低）
  if (isContinuationPhrase(text) && context.previousAuth) {
    return context.previousAuth.level
  }

  // 2. 破坏性边界（必须显式确认）
  if (isDestructiveRequest(text)) return 'destructive'

  // 3. 远程操作边界
  if (isRemoteOperation(text)) return 'shared_change'

  // 4. 信任模型的判断
  // Model Intake 已经有完整上下文，判断比正则更准确
  return context.modelAuthLevel ?? 'inspect'
}
```

### 4.3 保留的函数

| 函数 | 用途 | 保留原因 |
|------|------|---------|
| `isContinuationPhrase()` | 延续指令识别 | 继承机制核心 |
| `isDestructiveRequest()` | 破坏性操作检测 | 安全边界 |
| `isRemoteOperation()` | 远程操作检测 | 安全边界 |
| `deriveAuthorization()` | 授权决策 | 新核心函数 |

### 4.4 移除的函数

| 函数 | 移除原因 |
|------|---------|
| `isLocalChangeAuthorizationRequest()` | 信任 Model Intake |
| `isMetaBehaviorQuestion()` | 简化为 Model 判断 |
| `isPreferenceOrOptionSelection()` | 简化为 Model 判断 |
| `isCurrentStateVerificationRequest()` | 简化为 Model 判断 |
| `normalizeGuidancePolicy()` | 合并到 `deriveAuthorization()` |
| `shouldSuppressToolsForIntent()` | 合并到权限守门 |
| `deriveDefaultAuthorizationLevel()` | 合并到 `deriveAuthorization()` |
| ... (40+ more) | 冗余 |

---

## 五、执行计划（修订版）

### Phase 1: 设计决策（需要确认）

**关键问题**: 简化程度的选择

**方案 A: 完全信任 Model**
- 移除所有正则硬守卫
- 只保留破坏性边界
- 权限守门作为最终防线
- Token 节省最大（60-70%）
- 风险：依赖 Model 准确性

**方案 B: 保留安全硬守卫**
- 保留：破坏性边界、偏好选择、元行为问题
- 移除：正向推导（`isLocalChangeAuthorizationRequest` 等）
- Token 节省中等（40-50%）
- 风险较低

**方案 C: 仅简化正向推导**
- 保留所有硬守卫
- 只移除 `isLocalChangeAuthorizationRequest` 正向推导
- Token 节省较小（20-30%）
- 风险最低

**推荐**: 方案 B（折中）

理由：
1. 论文 "Prompt Injection Attacks" 指出 LLM 判断不可靠
2. 权限守门虽然能兜底，但用户体验差（频繁弹窗）
3. 偏好选择误判会导致不必要的工具执行

### Phase 2: 简化 normalizeGuidancePolicy（1 天，修订）

**目标**: 采用方案 B，保留安全硬守卫

**保留的正则**:
- `isDestructiveAuthorizationRequest()` - 破坏性边界
- `isSharedChangeAuthorizationRequest()` - 远程操作边界
- `isMetaBehaviorQuestion()` - 元行为问题
- `isPreferenceOrOptionSelection()` - 偏好选择

**移除的正则**:
- `isLocalChangeAuthorizationRequest()` - 正向推导
- `isCurrentStateVerificationRequest()` - 正向推导
- `isExplicitMemorySavePrompt()` - 正向推导
- `isMemoryAvailabilityCheckRequest()` - 正向推导

### Phase 3: 简化 Model Intake Prompt（1 天）

**目标**: 移除正向推导逻辑，只保留继承检查

**步骤**:
1. 创建 `deriveAuthorization()` 新函数
2. 移除 `isLocalChangeAuthorizationRequest()` 等正则函数
3. 修改 `normalizeGuidancePolicy()` 调用新函数
4. 更新测试

**验证**:
- [ ] 所有现有测试通过
- [ ] `session_1de7cf54` 场景仍然正确

### Phase 2: 简化 Model Intake Prompt（1 天）

**目标**: 减少传给模型的分类规则

**当前 prompt**:
```
Return only compact JSON with keys: intent, confidence, continuity,
contextScope, actionHint, requiresTools, problemTarget,
authorizationLevel, consentScope, consentSource, selectionKind,
authorizationReason, reason, explicitPaths.
intent must be one of: continue, new_focus, correction, pause, greeting, status.
contextScope must be one of: full, recent, new_focus.
... (大量规则)
```

**简化后 prompt**:
```
Analyze the user message. Return JSON with:
- authorizationLevel: none | inspect | local_change | shared_change | destructive
- requiresTools: boolean

Rules:
- Destructive operations (delete, force) → destructive
- Remote operations (push, merge) → shared_change
- Local edits → local_change
- Read-only → inspect
- Pure questions → none

Previous authorization: {level, scope} (inherit if continuation)
```

**验证**:
- [ ] Token 减少 60%+
- [ ] 授权判断准确率不降低

### Phase 3: 移除冗余函数（1 天）

**目标**: 清理不再使用的代码

**步骤**:
1. 移除 `isMetaBehaviorQuestion()`
2. 移除 `isPreferenceOrOptionSelection()`
3. 移除 `isCurrentStateVerificationRequest()`
4. 移除 `isPureMemoryCapabilityQuestion()`
5. 更新测试

**验证**:
- [ ] 代码行数减少 80%+
- [ ] 测试覆盖率保持

### Phase 4: 集成测试（1 天）

**目标**: 确保整体行为正确

**测试场景**:
1. "继续任务" 继承授权 ✅
2. "删除所有文件" → destructive ✅
3. "push to main" → shared_change ✅
4. "修改这个文件" → local_change (Model 判断) ✅
5. "为什么你改了" → none (Model 判断) ✅

### Phase 5: 文档更新（0.5 天）

**目标**: 更新相关文档

**步骤**:
1. 更新 `intent-guidance-architecture-optimization-analysis.md`
2. 更新 `intake-conservatism-analysis.md`
3. 更新 `authorization-continuity-execution-plan.md`
4. 添加本计划到 DONE.md

---

## 六、风险评估

### 6.1 风险矩阵

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| Model 判断不准确 | 中 | 高 | 权限守门作为最终防线 |
| 授权级别降低 | 低 | 高 | 破坏性操作必须显式 |
| 用户措辞不被识别 | 低 | 中 | 继承机制覆盖延续指令 |
| 测试覆盖不足 | 中 | 中 | 保留核心测试场景 |

### 6.2 回滚策略

如果简化后出现问题：
1. 恢复 `normalizeGuidancePolicy()` 原逻辑
2. 恢复被移除的正则函数
3. 增加 Model Intake prompt 的规则

---

## 七、成功指标

### 7.1 定量指标

| 指标 | 基线 | 目标 |
|------|------|------|
| Token/turn | ~1000 | ~400 |
| 代码行数 | ~1500 | ~300 |
| 函数数量 | 54 | ~10 |
| 测试通过率 | 100% | 100% |

### 7.2 定性指标

- [ ] 新开发者能在 10 分钟内理解授权逻辑
- [ ] 授权判断延迟降低
- [ ] 维护成本显著降低

---

## 八、后续优化（可选）

### 8.1 小模型分类器（中期）

参考 JavelinGuard 论文，使用 ~400M 参数模型专门做授权分类。

**优点**:
- Token 成本降低 90%+
- 专门训练，准确率可能更高
- 推理延迟更低

**需要**:
- 训练数据收集
- 模型微调
- 独立部署

### 8.2 缓存机制

对常见模式缓存授权判断结果。

---

## 九、参考文献

1. "Less is More: Optimizing Function Calling for LLM Execution on Edge Devices" (2024)
2. "NTILC: Neural Tool Invocation via Learned Compression" (2025)
3. "Cognitive Load-Aware Inference" (CLAI, 2025)
4. "Simple Prompt Injection Attacks Can Leak Personal Data" (2025)
5. "JavelinGuard: Low-Cost Transformer Architectures for LLM Security" (2025)
6. "MOPrompt: Multi-objective Semantic Evolution for Prompt Optimization" (2025)
7. "5C Prompt Contracts: A Minimalist, Token-Efficient Design Framework" (2025)

---

## 中文概述

### 背景

当前 Intent Guidance 层采用三层架构，Token 成本高、代码复杂、维护困难。学术研究表明单层分类足够，且 Token 优化通常不降低准确率。

### 核心改动

1. 合并三层为一层
2. 保留继承检查 + 破坏性边界
3. 信任 Model Intake 判断
4. 权限守门作为最终防线

### 预期收益

- Token 减少 60-70%
- 代码减少 80%
- 维护成本显著降低
