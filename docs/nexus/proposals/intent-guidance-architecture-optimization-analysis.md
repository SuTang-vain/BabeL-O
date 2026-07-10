# Intent Guidance 架构优化分析

**分析日期**: 2026-07-10
**背景**: intake-conservatism-analysis.md 修复完成后，审视三层架构的必要性
**核心问题**: 从 token 节省性价比角度，Intent Guidance 层是否必要？

---

## 一、学术研究关键发现

### 1.1 分层分类的必要性

| 研究 | 结论 | 对 BabeL-O 的启示 |
|------|------|------------------|
| **"Less is More" (2024)** | 减少工具数量 → 70% 效率提升 | 多层推断增加了复杂度，降低效率 |
| **NTILC (2025)** | 学习式压缩 → 95% context 减少 | Intent 层可以用更轻量的方式实现 |
| **CLAI (2025)** | 减少认知负载 → 45% token 节省 | 多层正则匹配增加认知负载 |
| **"Forecasting Live Chat Intent" (2024)** | 粗→细分层在大意图空间有效 | 我们的意图空间很小（6 intent × 5 auth level） |

### 1.2 安全与授权的关键洞察

> **"Simple Prompt Injection Attacks Can Leak Personal Data" (2025)**
> 
> 攻击成功率 20% → LLM 的授权判断不可靠，授权层必须在 LLM 之外执行

**结论**: 权限守门必须保留，但 Intent 推断可以简化。

### 1.3 Token 成本 vs 准确率权衡

| 方法 | Token 减少 | 准确率影响 |
|------|-----------|-----------|
| MOPrompt (2025) | 31% | 无损失 |
| CLAI (2025) | 45% | 无损失 |
| 5C Prompt (2025) | 显著减少 | 更好 |
| APE-OPRO (2025) | 18% 成本优化 | 无损失 |

**结论**: 简化 prompt 通常不会降低准确率，反而可能提升。

---

## 二、当前架构成本分析

### 2.1 代码复杂度

```
intentGuidance.ts: 58KB, 54 functions
- isContinuationPhrase()      # 延续指令
- isLocalChangeAuthorizationRequest()  # 本地修改
- isSharedChangeAuthorizationRequest() # 远程操作
- isDestructiveAuthorizationRequest()  # 破坏性
- isMetaBehaviorQuestion()    # 元行为问题
- isPreferenceOrOptionSelection()  # 偏好选择
- isCurrentStateVerificationRequest()  # 状态验证
- isPureMemoryCapabilityQuestion()  # 记忆能力
- isGreetingPrompt()          # 问候
- isStatusPrompt()            # 状态
- isCorrectionPrompt()        # 修正
- ... (40+ more)
```

### 2.2 Token 消耗估算

每轮 Intake:
```
System prompt: ~20 tokens
User prompt: ~800-1000 tokens (分类规则、枚举、示例)
Model output: ~150-200 tokens (JSON)
Fallback 正则匹配: CPU 开销
------------------------------------------
总计: ~1000-1200 tokens/turn
```

对比简化方案:
```
System prompt: ~20 tokens
User prompt: ~200-300 tokens (最小规则 + 继承上下文)
Model output: ~100 tokens
------------------------------------------
总计: ~300-400 tokens/turn
```

**节省潜力: 60-70% tokens**

### 2.3 维护成本

每新增一个措辞：
1. 修改 `isLocalChangeAuthorizationRequest` 正则
2. 可能修改 `deriveDefaultAuthorizationLevel`
3. 可能修改 `normalizeGuidancePolicy`
4. 添加测试用例
5. 验证不引入误判

---

## 三、根本问题：Intent Guidance 的角色

### 3.1 当前设计的隐含假设

```
假设 1: Model Intake 不够可靠 → 需要 normalizeGuidancePolicy 修正
假设 2: 正则匹配比模型判断更准确
假设 3: 多层兜底能覆盖更多边界情况
```

### 3.2 实际情况

| 假设 | 现实 |
|------|------|
| Model 不可靠 | 实际上 Model 有完整上下文，判断比正则更准确 |
| 正则更准确 | 正则覆盖率有限，维护成本高 |
| 多层兜底有效 | 三层都在解决同一问题，存在冗余 |

### 3.3 真正需要的决策点

1. **继承检查**: 延续指令是否应该继承上一轮授权？
2. **破坏性边界**: 是否需要显式确认？
3. **权限守门**: 工具调用时检查权限

**Intent 分类本身** (continue/new_focus/correction/pause/greeting/status) 对授权判断的价值有限。

---

## 四、简化方案对比

### 方案 A: 完全移除 Intent Guidance 层

```typescript
// 不预先判断授权级别
// 让工具调用时检查权限
// 用户说"修改文件" → Write 调用 → 权限检查 → 批准/拒绝

优点:
- 代码简化 95%
- Token 消耗接近 0
- 维护成本极低

缺点:
- 每次工具调用都需要权限确认
- 用户体验差（频繁弹窗）
- 无法提前告知用户授权范围
```

**评估: 不推荐** — 体验差，但思路正确（信任权限守门）

### 方案 B: 最小化 Intent 层（推荐）

```typescript
function deriveAuthorization(text: string, context: TurnContext): AuthLevel {
  // 1. 继承检查（最优先，token 成本最低）
  if (isContinuationPhrase(text) && context.previousAuth) {
    return context.previousAuth.level
  }
  
  // 2. 破坏性边界（必须显式）
  if (isDestructiveRequest(text)) return 'destructive'
  
  // 3. 远程操作边界
  if (isRemoteOperation(text)) return 'shared_change'
  
  // 4. 信任模型的判断（传入上下文）
  // 不再做大正则推断
  return context.modelAuthLevel ?? 'inspect'
}

// Token 成本: ~50 tokens/turn（只传最小上下文）
// 代码复杂度: ~500 lines（减少 90%）
```

**评估: 推荐** — 平衡体验、token 成本、维护成本

### 方案 C: 小模型分类器

```typescript
// 使用 ~400M 参数模型专门做授权分类
// 参考 JavelinGuard 论文

const authLevel = await smallClassifier.classify(text, context)

优点:
- 比 main LLM 更便宜
- 专门训练，准确率可能更高

缺点:
- 需要额外模型部署
- 增加系统复杂度
- 延迟增加
```

**评估: 中期考虑** — 需要更多基础设施投入

---

## 五、推荐的分阶段优化路径

### Phase 1: 合并冗余层（立即）

**目标**: 将三层合并为一层

**做法**:
1. 移除 `normalizeGuidancePolicy` 中的正向推导
2. 保留：继承检查 + 破坏性边界
3. 信任 Model Intake 的授权判断

**预期收益**:
- Token 减少 40-50%
- 代码减少 60%
- 维护成本降低

### Phase 2: 简化 Model Intake Prompt（短期）

**目标**: 减少传给模型的分类规则

**做法**:
1. 移除详细的枚举值描述
2. 移除大量示例
3. 只传递：用户输入 + 上一轮授权 + 破坏性边界提醒

**预期收益**:
- Token 再减少 30-40%
- 推理延迟降低

### Phase 3: 考虑小模型分类器（中期）

**目标**: 用专门的小模型替代 main LLM 做授权分类

**做法**:
1. 训练或微调 ~400M 模型
2. 部署为独立服务
3. 缓存常见模式

**预期收益**:
- Token 成本降低 90%+
- 延迟降低
- 准确率可能提升

---

## 六、与论文建议的对齐

| 论文建议 | 当前状态 | 优化方向 |
|---------|---------|---------|
| "Fewer tools = better" | 多层推断增加复杂度 | 简化为单层 |
| "External authorization" | 权限守门已存在 | 保留，信任它 |
| "Token attribution" | 大量低价值 token | 移除冗余规则 |
| "Cognitive load aware" | 三层增加负载 | 合并为单层 |

---

## 七、结论

### 核心判断

**Intent Guidance 层的三层设计确实冗余**，主要问题：

1. **Token 成本过高**: ~1000 tokens/turn 可减少到 ~300
2. **代码复杂度高**: 54 functions 可减少到 ~10
3. **维护成本高**: 每次新增措辞需要修改多处
4. **准确率未提升**: 多层兜底并未显著改善判断

### 推荐行动

1. **立即**: 合并三层为一层，只保留继承检查 + 破坏性边界
2. **短期**: 简化 Model Intake Prompt
3. **中期**: 考虑小模型分类器

### 风险评估

| 风险 | 缓解 |
|------|------|
| 授权判断不准确 | 权限守门作为最终防线 |
| 用户措辞不被识别 | 继承机制覆盖延续指令 |
| Model 判断不稳定 | 破坏性操作必须显式确认 |

---

## 附录：相关论文

1. "Less is More: Optimizing Function Calling for LLM Execution on Edge Devices" (2024)
2. "NTILC: Neural Tool Invocation via Learned Compression" (2025)
3. "Cognitive Load-Aware Inference" (2025)
4. "Simple Prompt Injection Attacks Can Leak Personal Data Observed by LLM Agents" (2025)
5. "JavelinGuard: Low-Cost Transformer Architectures for LLM Security" (2025)
5. "MOPrompt: Multi-objective Semantic Evolution for Prompt Optimization" (2025)