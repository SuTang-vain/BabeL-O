# Intake 层保守性分析报告

**分析日期**: 2026-07-10
**更新日期**: 2026-07-10
**状态**: ✅ 主要问题已修复
**证据会话**: `session_1de7cf54`, `session_f482e61b`
**核心文件**: `src/runtime/intentGuidance.ts`

---

## 修复总结

### 已修复问题

| 问题 | 状态 | 修复内容 |
|------|------|---------|
| **2.1 第一层：默认值偏保守** | ✅ 已修复 | `isContinuationPhrase()` + `previousAuthorizationState` 继承机制 |
| **2.2 第二层：正向授权检测不够宽松** | ✅ 已修复 | 扩展 `isLocalChangeAuthorizationRequest()` 正则，覆盖更多动词和模式 |
| **2.3 第三层：授权继承缺失** | ✅ 已修复 | Session 级别 `authorization_state` 持久化 + intake 继承逻辑 |
| **3.1 正则不足** | ✅ 已修复 | 新增"继续"指令、"可写模式"、"修复"、"执行方案"、"就用...方案"等模式 |
| **3.2 isPreferenceOrOptionSelection 过度触发** | ✅ 已验证 | 当前实现合理：有执行动词时不会误判为偏好选择 |
| **3.3 isMetaBehaviorQuestion 范围过宽** | ✅ 已验证 | 当前实现合理：元行为问题确实是 `none`，后续"继续修改"会继承授权 |
| **3.4 requiresTools 判定不稳定** | ✅ 已修复 | 扩展正则覆盖"更改"、"改一下"等更多动作词 |

### 测试覆盖

- `test/authorization-continuity.test.ts`: 35 tests
- 覆盖延续指令、正则扩展、偏好选择边界、元行为问题、修正+动作等场景

---

## 一、当前 Intake 层设计理念

### 1.1 三层守卫结构

```
┌─────────────────────────────────────────────────────────────┐
│                     Model Intake Output                      │
│            (authorizationLevel, requiresTools, etc.)         │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│               normalizeGuidancePolicy()                      │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Tier 1: 硬守卫 (强制重写)                               │  │
│  │   - isMetaBehaviorQuestion → none, respond_only        │  │
│  │   - isPureMemoryCapabilityQuestion → none              │  │
│  │   - isPreferenceOrOptionSelection → none               │  │
│  └───────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Tier 2: 正向推导 (补全授权)                             │  │
│  │   - isDestructiveAuthorizationRequest → destructive    │  │
│  │   - isSharedChangeAuthorizationRequest → shared_change │  │
│  │   - isLocalChangeAuthorizationRequest → local_change   │  │
│  │   - isCurrentStateVerificationRequest → inspect        │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│               shouldSuppressToolsForIntent()                │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Tool Suppression Decision                              │  │
│  │   - authorization.level === 'none' → suppress          │  │
│  │   - pause / greeting → suppress                         │  │
│  │   - status + requiresTools=false → passthrough         │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 授权级别判定逻辑 (deriveDefaultAuthorizationLevel)

```typescript
function deriveDefaultAuthorizationLevel(options): AuthorizationLevel {
  // 1. 破坏性操作 → destructive
  if (isDestructiveAuthorizationRequest(text)) return 'destructive'

  // 2. 远程共享 → shared_change
  if (isSharedChangeAuthorizationRequest(text)) return 'shared_change'

  // 3. 元行为问题 → none
  if (isMetaBehaviorQuestion(text)) return 'none'

  // 4. 偏好选择 → none
  if (isPreferenceOrOptionSelection(text) && !hasExecutionAuthorizationCue(text)) return 'none'

  // 5. 本地修改 → local_change
  if (isLocalChangeAuthorizationRequest(text)) return 'local_change'

  // 6. 状态验证 → inspect
  if (isCurrentStateVerificationRequest(text)) return 'inspect'

  // 7. pause/greeting → none
  if (intent === 'pause' || intent === 'greeting') return 'none'

  // 8. status + !requiresTools → none
  if (intent === 'status' && !requiresTools) return 'none'

  // 9. 兜底：requiresTools ? inspect : none
  return requiresTools ? 'inspect' : 'none'
}
```

---

## 二、保守性分析：三层过度防御

### 2.1 第一层：默认值偏保守

**问题**: 兜底逻辑 `requiresTools ? 'inspect' : 'none'` 导致大多数普通请求被降级为 `inspect`。

**证据** (`session_1de7cf54`):

| 用户输入 | requiresTools | authLevel | 是否合理 |
|---------|--------------|-----------|---------|
| "嗨你是谁可以做什么" | 1 | inspect | ❌ 应为 `none` |
| "查看项目" | 1 | inspect | ✅ 合理 |
| "分析架构合理性" | 1 | inspect | ✅ 合理 |
| "写架构优化文档" | 1 | **local_change** | ✅ 正确识别 |
| "开始推进架构优化" | 1 | **local_change** | ✅ 正确识别 |
| **"继续任务"** | 1 | **inspect** | ❌ 应继承 `local_change` |
| **"进入可写模式并开始修复"** | 1 | **inspect** | ❌ 应为 `local_change` |

**分析**:
- Turn 1 "嗨你是谁" 被标记为 `requiresTools=true` + `inspect`，但模型只做了自我介绍，没有用工具
- 正确行为应该是 `requiresTools=false` + `none`（问候/能力问题）
- 当前 `isGreetingPrompt()` 只匹配极少数模式，"嗨你是谁可以做什么" 没被匹配

### 2.2 第二层：正向授权检测不够宽松

**问题**: `isLocalChangeAuthorizationRequest()` 正则过于严格，遗漏常见授权措辞。

**当前正则**:
```typescript
// isLocalChangeAuthorizationRequest
/(根据|按照|按).*(规划|计划|方案|建议|文档).*(推进|开始|实现|修改|处理)?/u
/(开始推进|继续推进|实现|修改|改成|应用|写入|提交当前|创建分支|新建分支)/u
```

**遗漏案例**:

| 用户输入 | 当前判定 | 应判定 | 原因 |
|---------|---------|--------|------|
| "继续任务" | ❌ inspect | local_change | "继续" + 已有 stated_plan 上下文 |
| "进入可写模式" | ❌ inspect | local_change | "可写模式" 明确请求写入权限 |
| "按这个改" | ❌ inspect | local_change | "按...改" 匹配缺失 |
| "就这样提交" | ❌ inspect | local_change | "提交" 但缺少 "当前" |
| "执行刚才的方案" | ❌ inspect | local_change | "方案" + "执行" 但不匹配正则 |
| "修复这个问题" | ❌ inspect | local_change | "修复" 不在正则中 |

**建议扩展**:

```typescript
const LOCAL_CHANGE_VERBS = [
  // 现有
  '实现', '修改', '改成', '应用', '写入', '提交',
  // 建议新增
  '修复', '改', '补', '加', '删', '重写', '重构', '优化',
  '创建', '新建', '移动', '重命名', '更新', '调整',
  // 英文
  'fix', 'patch', 'update', 'create', 'move', 'rename',
];

const LOCAL_CHANGE_PATTERNS = [
  // 现有
  /(开始推进|继续推进)/u,
  // 建议新增
  /(继续|接着).*(任务|工作|修改|推进)/u,  // "继续任务"
  /进入.*(可写|编辑|修改).*模式/u,        // "进入可写模式"
  /(就|直接|按).*(这样|这个|那个).*(改|提交|执行|做)/u,  // "就这样改"
  /(执行|实施|落实).*(方案|计划|建议)/u,  // "执行方案"
];
```

### 2.3 第三层：授权继承缺失

**问题**: 没有从 session 历史或上一轮 intake 继承授权状态的机制。

**证据**:

```
Turn 4: "写一篇架构优化文档"
  → authorizationLevel: local_change
  → consentScope: stated_plan
  → consentSource: explicit_user

Turn 5: "开始推进架构优化"
  → authorizationLevel: local_change ← 正确识别

Turn 6: "继续任务"
  → authorizationLevel: inspect ← 重置！
  → consentScope: current_step
  → consentSource: inferred_none
```

**根因**: `deriveDefaultAuthorizationLevel()` 每轮从零推导，不参考：
1. 上一轮的 `authorizationLevel`
2. Session 级别的 `consentScope: stated_plan` 状态
3. "继续" 类延续指令的特殊处理

---

## 三、具体保守性问题清单

### 3.1 `isLocalChangeAuthorizationRequest()` 正则不足

| 缺口 | 案例 | 影响 |
|------|------|------|
| 缺少"继续"指令处理 | "继续任务"、"继续推进" | 高 — 已有 stated_plan 被忽略 |
| 缺少"可写模式"措辞 | "进入可写模式" | 中 — 用户明确请求写入 |
| 缺少"修复"动词 | "修复这个问题" | 中 — 常见修改意图 |
| 缺少"执行方案"模式 | "执行刚才的方案" | 中 — 明确授权执行 |
| 缺少"就这样..."模式 | "就这样提交" | 低 — 口语化授权 |

### 3.2 `isPreferenceOrOptionSelection()` 过度触发

**当前逻辑**:

```typescript
function isPreferenceOrOptionSelection(text: string): boolean {
  if (trimmed.length > 48) return false
  if (hasActionVerbCue(...)) return false
  // ...
  if (/^[\w.-]+$/iu.test(token) && /(?:theme|forest|soft|dark|light|...)/iu.test(token)) return true
  return false
}
```

**问题**: 单个英文单词（如 "light"）被识别为偏好选择，强制 `authorizationLevel='none'`。

**风险**: 如果用户说 "light 主题吧"，模型无法执行任何工具调用。

### 3.3 `isMetaBehaviorQuestion()` 范围过宽

**当前逻辑**:

```typescript
function isMetaBehaviorQuestion(text: string): boolean {
  const asksWhy = /\bwhy\b/iu.test(normalized) || /(为什么|为啥|什么情况)/u.test(text)
  const agentBehavior = /\b(hesitat\w*|tool|tools|modify|modified|edit|changed|directly|permission|policy)\b/iu.test(normalized)
  return asksWhy && agentBehavior
}
```

**问题**: "为什么你修改了这个文件" → `authorizationLevel='none'`，但如果用户接着说 "继续修改"，需要重新获得授权。

### 3.4 `requiresTools` 判定不稳定

**证据** (`session_f482e61b`):

| 用户输入 | requiresTools | authLevel | 是否合理 |
|---------|--------------|-----------|---------|
| "所以本质上是因为当前babel-o的产品问题？" | 0 | inspect | ✅ 合理 |
| "太过于专业了，更改为更产品功能的版本..." | 0 | inspect | ❌ 应为 `local_change` |
| "我选择第三个解决方案" | 1 | inspect | ⚠️ 偏好选择，但后续可能需要执行 |
| "继续任务" | 1 | inspect | ❌ 应继承上一轮授权 |

**分析**:
- `requiresTools` 来自 model intake 输出，但模型可能不稳定
- `normalizeGuidancePolicy()` 只在 `continue + normal` 时强制 `requiresTools=true`
- "更改为更产品功能的版本" 触发了 `isCorrectionPrompt()` 但没有触发 `isLocalChangeAuthorizationRequest()`

---

## 四、保守性根因总结

### 4.1 架构层面

1. **无状态设计**: 每轮 intake 独立推导，无历史授权状态继承
2. **单向推导**: Model → Normalize → Suppression，缺少反馈修正
3. **正则驱动**: 依赖硬编码正则而非语义理解

### 4.2 设计哲学层面

当前设计遵循 **"默认拒绝，显式授权"** 原则：

```
用户: "继续任务"
  → 没有匹配授权正则
  → 兜底: inspect
  → TOOL_DENIED
```

**建议调整为** **"上下文感知，合理推断"**：

```
用户: "继续任务"
  → 检查上一轮授权: local_change
  → 检查 consentScope: stated_plan
  → 继承: local_change
  → 允许继续工作
```

---

## 五、修复建议

### 5.1 短期修复（优先级高）

#### 修复 1: 新增"继续"指令继承逻辑

**文件**: `src/runtime/intentGuidance.ts`

```typescript
// 在 normalizeGuidancePolicy() 开头新增
function normalizeGuidancePolicy(guidance: UserIntentGuidance): UserIntentGuidance {
  // NEW: 检查是否为延续指令
  if (isContinuationPhrase(guidance.latestUserText) && guidance.source === 'model') {
    // 让 model intake 决定授权，不要强制重写
    // 因为 model 可能已经从上下文继承了授权
    return withAuthorization(guidance)
  }
  // ... existing logic
}

// 新增函数
function isContinuationPhrase(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  return /^(继续|继续任务|继续推进|继续工作|继续执行|continue|keep going|proceed)$/iu.test(normalized)
}
```

#### 修复 2: 扩展 `isLocalChangeAuthorizationRequest()` 正则

```typescript
function isLocalChangeAuthorizationRequest(text: string): boolean {
  // ... existing checks ...

  // NEW: 扩展动词列表
  if (/(修复|改|补|加|重构|优化|创建|新建|更新|调整|fix|patch|update|create)/iu.test(text)) {
    return true
  }

  // NEW: 延续指令 + 已授权上下文暗示
  if (/(继续|接着).*(任务|工作|修改|推进|执行)/iu.test(text)) {
    return true
  }

  // NEW: 进入可写模式
  if (/进入.*(可写|编辑|修改).*模式/iu.test(text)) {
    return true
  }

  return false
}
```

#### 修复 3: 在 intake prompt 中明确"继续"指令处理

**文件**: `src/runtime/intentGuidance.ts:queryIntakeModel()`

```typescript
// 在 prompt 中新增
'If the latest message is a continuation phrase like "继续任务" or "continue", inherit the authorization level from the conversation context unless the user explicitly narrows scope.'
```

### 5.2 中期修复（需要 session 级别状态）

#### 修复 4: Session 级别授权状态持久化

（参见 `authorization-continuity-execution-plan.md` Phase 2）

#### 修复 5: Intake 调用时传入上一轮授权

（参见 `authorization-continuity-execution-plan.md` Phase 1.3）

### 5.3 长期改进

1. **语义化 intake**: 用小模型做语义分类而非正则匹配
2. **反馈修正**: 如果 model 尝试调用被拒绝的工具，动态调整授权
3. **用户画像**: 学习用户的授权习惯，个性化默认授权级别

---

## 六、测试用例建议

### 6.1 延续指令测试矩阵

| 用户输入 | 上一轮授权 | 预期授权 | 测试场景 |
|---------|-----------|---------|---------|
| "继续任务" | local_change | local_change | 核心修复 |
| "继续推进" | local_change | local_change | 核心修复 |
| "continue" | local_change | local_change | 英文延续 |
| "继续任务" | inspect | inspect | 无授权可继承 |
| "继续任务" | none | none | 偏好选择后 |
| "继续任务" | shared_change | shared_change | 远程操作延续 |

### 6.2 授权动词扩展测试

| 用户输入 | 当前判定 | 预期判定 |
|---------|---------|---------|
| "修复这个问题" | inspect | local_change |
| "进入可写模式" | inspect | local_change |
| "执行刚才的方案" | inspect | local_change |
| "就这样改" | inspect | local_change |
| "按这个提交" | inspect | local_change |

### 6.3 偏好选择边界测试

| 用户输入 | 当前判定 | 预期判定 |
|---------|---------|---------|
| "light" | none (偏好) | none ✅ |
| "light 主题吧" | none | local_change (有执行动词) |
| "用深色主题" | none ✅ | none ✅ |
| "就用第一个方案" | none | local_change (方案 + 执行暗示) |

---

## 七、风险评估

### 7.1 放宽授权的风险

| 风险 | 缓解措施 |
|------|---------|
| 误授权破坏性操作 | `destructive` 级别仍需显式确认 |
| 远程操作误触发 | `shared_change` 级别保持严格 |
| 偏好选择误判为授权 | 保留 `isPreferenceOrOptionSelection()` 但缩小范围 |
| "继续" 后用户意图改变 | 授权仍为 recoverable denial，用户可拒绝 |

### 7.2 不修复的风险

| 风险 | 影响 |
|------|------|
| 用户频繁遇到 TOOL_DENIED | 体验差，放弃使用 |
| 需要重复明确授权 | 效率低，对话冗余 |
| "继续任务" 变成陷阱 | 用户困惑，以为授权了实际没有 |

---

## 八、结论

**当前 Intake 层确实过于保守**，具体表现为：

1. **兜底逻辑**: `requiresTools ? 'inspect' : 'none'` 导致大多数请求降级
2. **正则不足**: `isLocalChangeAuthorizationRequest()` 遗漏常见授权措辞
3. **无状态设计**: 没有授权继承机制，"继续任务" 无法延续授权
4. **过度防御**: 宁可拒绝也不推断，导致用户需要反复明确授权

**建议优先级**:

1. **P0**: 修复"继续"指令继承 + 扩展授权动词正则（1-2 天）
2. **P1**: Session 级别授权状态持久化（参见 execution plan）
3. **P2**: 语义化 intake 改造（长期）

**核心原则调整**:

```
从: "默认拒绝，显式授权"
到: "上下文感知，合理推断，关键操作显式确认"
```
