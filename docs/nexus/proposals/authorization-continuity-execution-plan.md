# Session Authorization Continuity Bug — Execution Plan

**Status**: ✅ Landed (2026-07-10)
**Created**: 2026-07-10
**Landed**: 2026-07-10
**Evidence Session**: `session_1de7cf54-3e73-4a1e-9e36-94e48b0fd661`
**Related Plan**: [strategy-authorization-and-consent-governance-plan.md](./strategy-authorization-and-consent-governance-plan.md)
**Blocking Issues**: Resolved — Turn-level authorization now persists across continuation phrases

---

## 实现总结

### 已完成的修改

| Phase | 内容 | 文件 | 状态 |
|-------|------|------|------|
| **Phase 0** | Regression fixture + baseline test | `test/authorization-continuity.test.ts` | ✅ 25 tests |
| **Phase 1** | Intake 层继承逻辑 | `src/runtime/intentGuidance.ts` | ✅ |
| **Phase 1** | 扩展正则 + prompt 更新 | `src/runtime/intentGuidance.ts` | ✅ |
| **Phase 2** | Session authorization_state 列 | `src/storage/SqliteStorage.ts`, `src/shared/session.ts` | ✅ v16 migration |
| **Phase 2** | Intake 后更新 session | `src/nexus/executionFinalization.ts` | ✅ |
| **Phase 2** | 传入 previousPolicy | `src/runtime/prepareRuntimeStart.ts` | ✅ |
| **Phase 3** | Integration tests | `test/authorization-state-persistence.test.ts` | ✅ 10 tests |
| **Phase 4.1** | bbl inspect-session 显示 | `src/cli/commands/inspectSession.ts` | ✅ |
| **Phase 4.2** | Go TUI 状态栏显示 | `clients/go-tui/internal/tui/*.go` | ✅ |

### 核心修复流程

```
Turn N:
  用户: "写一篇架构优化文档"
  → intake: authorizationLevel=local_change
  → finalize: session.authorizationState={level:'local_change',...}
  → Go TUI 显示: "auth:local_change"

Turn N+1:
  用户: "继续任务"
  → prepareRuntimeStart: 加载 previousAuthorizationState
  → intake: 继承 authorizationLevel=local_change ✅
  → Go TUI 显示: "auth:local_change" (保持)
```

### 设计原则调整

```
从: "默认拒绝，显式授权"
到: "上下文感知，合理推断，关键操作显式确认"
```

### 测试覆盖

- `test/authorization-continuity.test.ts`: 25 tests
- `test/authorization-state-persistence.test.ts`: 10 tests
- `test/inspect-session.test.ts`: 32 tests (更新表结构)
- **Total**: 67 tests pass

---

## 问题描述（历史记录）

### 证据会话时序

Session `session_1de7cf54` 在 Turn 4-5 已获得用户明确授权执行本地修改：

| Turn | 用户输入 | authorizationLevel | consentScope | 结果 |
|------|---------|---------------------|--------------|------|
| 1 | "嗨你是谁可以做什么" | `inspect` | `current_step` | ✅ 自我介绍 |
| 2 | "查看BabeL-O项目" | `inspect` | `current_step` | ✅ Read/ListDir |
| 3 | "分析项目架构合理性" | `inspect` | `current_step` | ✅ 大量 Read |
| **4** | **"写一篇架构优化文档到文档库"** | **`local_change`** | **`stated_plan`** | ✅ Write/Edit 成功 |
| **5** | **"开始推进架构优化"** | **`local_change`** | **`stated_plan`** | ✅ Edit 成功 |
| ERROR | final_check 阶段 Edit | — | — | ❌ TOOL_DENIED_FINAL_CHECK |
| **6** | **"继续任务"** | **`inspect`** ⚠️ | `current_step` | ❌ 授权重置 |
| ERROR | 尝试 Edit | — | — | ❌ TOOL_DENIED (需要 local_change) |

### 根因

**核心断裂**：`"继续任务"` 被重新推导为 `inspect` + `inferred_none`，而不是继承 Turn 4-5 的 `local_change` + `stated_plan`。

现有 `deriveTurnPolicy()` 每轮从 intake 重新推导授权，缺少：
1. 跨轮授权状态继承逻辑
2. 对"继续"/"继续任务"/"继续推进"等延续指令的识别
3. Session 级别 `authorizationLevel` 持久化

---

## 目标

### 收口标准

1. **"继续任务" 继承授权**：简短延续指令能继承上一轮 `local_change` + `stated_plan`
2. **Replay 测试覆盖**：真实 session replay 验证授权连续性
3. **不引入新误判**：纯偏好/元问题/状态查询仍保持 `none`/`inspect`
4. **Go TUI 授权可见**：`bbl inspect-session` 显示授权状态变化轨迹

---

## Phase 规划

### Phase 0 — 文档和回归基准（1 天）

#### 0.1 创建 replay fixture

**文件**: `test/fixtures/session_1de7cf54-auth-continuity-fixture.json`

- 从 SQLite 导出关键事件段（Turn 4 intake → Turn 6 intake → TOOL_DENIED）
- 标记需要 replay 的断点
- 预期：Turn 6 intake 应输出 `local_change` + `stated_plan` 继承

#### 0.2 定义 baseline test

**文件**: `test/intent-guidance-auth-continuity.test.ts`

```typescript
describe('Authorization continuity', () => {
  it('should inherit local_change authorization when user says "继续任务"', async () => {
    // Setup: previous turn had authorizationLevel=local_change, consentScope=stated_plan
    const prevPolicy = { level: 'local_change', scope: 'stated_plan', source: 'explicit_user' };
    const intake = await deriveTurnPolicy('继续任务', { previousPolicy: prevPolicy });
    assert.strictEqual(intake.authorizationLevel, 'local_change');
    assert.strictEqual(intake.consentScope, 'stated_plan');
    assert.strictEqual(intake.authorizationSource, 'inherited'); // NEW field
  });

  it('should NOT inherit when previous turn was inspect and user says new plan', async () => {
    const prevPolicy = { level: 'inspect', scope: 'current_step', source: 'inferred_none' };
    const intake = await deriveTurnPolicy('重写 README 文件', { previousPolicy: prevPolicy });
    assert.strictEqual(intake.authorizationLevel, 'local_change');
    assert.strictEqual(intake.authorizationSource, 'inferred');
  });

  it('should reset to inspect when user says "只看看当前状态"', async () => {
    const prevPolicy = { level: 'local_change', scope: 'stated_plan', source: 'explicit_user' };
    const intake = await deriveTurnPolicy('只看看当前状态', { previousPolicy: prevPolicy });
    assert.strictEqual(intake.authorizationLevel, 'inspect');
    assert.strictEqual(intake.authorizationSource, 'inferred');
  });
});
```

#### 0.3 更新 strategy-authorization-and-consent plan

在 `proposals/strategy-authorization-and-consent-governance-plan.md` 新增 Phase 6：

```markdown
## Phase 6 — Authorization Continuity and Inheritance (Draft, 2026-07-10)

### Evidence
- session_1de7cf54-3e73-4a1e-9e36-94e48b0fd661: "继续任务" → authorization reset → TOOL_DENIED

### Goals
1. 简短延续指令继承上一轮授权
2. Session 级别授权状态持久化
3. 不引入新的误判（纯偏好/元问题仍保持 none/inspect）

### Key Changes
(详见本 execution plan)
```

---

### Phase 1 — Intake 层授权继承逻辑（2 天）

#### 1.1 扩展 intake schema

**文件**: `src/shared/events.ts`

```typescript
export type UserIntentGuidance = {
  // ... existing fields ...
  authorizationLevel: AuthorizationLevel;
  consentScope: ConsentScope;
  authorizationSource: 'explicit_user' | 'inferred' | 'inherited'; // NEW
  inheritedFrom?: { turnIndex: number; timestamp: string }; // NEW
};

export type AuthorizationLevel =
  | 'none'
  | 'inspect'
  | 'local_change'
  | 'shared_change'
  | 'destructive';

export type ConsentScope =
  | 'current_step'
  | 'stated_plan'
  | 'session_workflow';
```

#### 1.2 创建 AuthorizationStateTracker

**文件**: `src/runtime/authorizationStateTracker.ts`

```typescript
/**
 * Tracks session-level authorization state for inheritance.
 * Stored in session metadata, not per-turn.
 */
export type SessionAuthorizationState = {
  currentLevel: AuthorizationLevel;
  currentScope: ConsentScope;
  source: 'explicit_user' | 'inferred' | 'inherited';
  establishedAt: string; // timestamp
  establishedByTurn?: number;
  lastConfirmedAt: string;
};

export class AuthorizationStateTracker {
  private state: SessionAuthorizationState | null = null;

  /**
   * Update state from new intake guidance.
   * Only updates when source is explicit_user or inferred (not inherited).
   */
  update(intake: UserIntentGuidance, turnIndex: number): void;

  /**
   * Get current state for inheritance.
   * Returns null if state expired or was reset by explicit downgrade.
   */
  get(): SessionAuthorizationState | null;

  /**
   * Check if a continuation phrase should inherit.
   */
  shouldInherit(userText: string): boolean;
}
```

#### 1.3 定义延续指令词汇表

**文件**: `src/runtime/continuationVocabulary.ts`

```typescript
/**
 * Phrases that indicate user wants to continue previous authorized work.
 * These should inherit previous authorization state.
 */
export const CONTINUATION_PHRASES = [
  // Chinese
  '继续',
  '继续任务',
  '继续推进',
  '继续做',
  '继续执行',
  '继续完成',
  '继续改',
  '继续写',
  '继续修改',
  '按刚才的方案继续',
  '按之前说的继续',
  '继续刚才的工作',
  // English
  'continue',
  'continue the task',
  'continue working',
  'continue with the plan',
  'keep going',
  'proceed',
  'go ahead',
  'carry on',
];

/**
 * Phrases that explicitly reset authorization to inspect/none.
 */
export const RESET_PHRASES = [
  '只看看',
  '只是看看',
  '只是分析',
  '只是验证',
  '只检查',
  '看看当前状态',
  'show me',
  'just check',
  'just look',
  'just verify',
];
```

#### 1.4 更新 deriveTurnPolicy

**文件**: `src/runtime/intentGuidance.ts`

```typescript
export async function deriveTurnPolicy(
  userText: string,
  options: {
    previousPolicy?: SessionAuthorizationState;
    conversationHistory?: ConversationTurn[];
    // ... existing options ...
  }
): Promise<UserIntentGuidance> {
  const tracker = new AuthorizationStateTracker();
  tracker.restore(options.previousPolicy);

  // Step 1: Check for continuation phrases
  if (tracker.shouldInherit(userText)) {
    const inherited = tracker.get();
    if (inherited && inherited.currentLevel !== 'none' && inherited.currentLevel !== 'inspect') {
      return {
        // ... intake fields ...
        authorizationLevel: inherited.currentLevel,
        consentScope: inherited.currentScope,
        authorizationSource: 'inherited',
        inheritedFrom: {
          turnIndex: inherited.establishedByTurn ?? 0,
          timestamp: inherited.establishedAt,
        },
      };
    }
  }

  // Step 2: Check for explicit reset phrases
  if (isResetPhrase(userText)) {
    tracker.reset();
    return {
      // ... intake fields ...
      authorizationLevel: 'inspect',
      consentScope: 'current_step',
      authorizationSource: 'inferred',
    };
  }

  // Step 3: Normal intake classification
  const intake = await classifyIntake(userText, options);

  // Step 4: Update tracker if explicit authorization
  if (intake.authorizationSource === 'explicit_user' || intake.authorizationLevel !== 'inspect') {
    tracker.update(intake, options.turnIndex ?? 0);
  }

  return intake;
}
```

---

### Phase 2 — Runtime 层授权状态持久化（1 天）

#### 2.1 在 session metadata 中存储授权状态

**文件**: `src/storage/SqliteStorage.ts`

```sql
-- Add authorization_state column to sessions table
ALTER TABLE sessions ADD COLUMN authorization_state TEXT;

-- authorization_state is JSON: {
--   currentLevel: string,
--   currentScope: string,
--   source: string,
--   establishedAt: string,
--   establishedByTurn: number,
--   lastConfirmedAt: string
-- }
```

#### 2.2 在 session 创建和 intake 时更新

**文件**: `src/nexus/sessionCreateRouter.ts`

```typescript
// On session creation, initialize authorization_state as null
const session = await storage.createSession({
  // ... existing fields ...
  authorization_state: null,
});
```

**文件**: `src/runtime/executionPreparation.ts`

```typescript
// After intake guidance is derived, update authorization_state
if (intake.authorizationSource !== 'inherited') {
  await storage.updateSession(sessionId, {
    authorization_state: JSON.stringify({
      currentLevel: intake.authorizationLevel,
      currentScope: intake.consentScope,
      source: intake.authorizationSource,
      establishedAt: intake.timestamp,
      establishedByTurn: currentTurnIndex,
      lastConfirmedAt: intake.timestamp,
    }),
  });
}
```

#### 2.3 在 intake 调用时传入 previousPolicy

**文件**: `src/runtime/intentGuidanceCaller.ts`

```typescript
export async function callIntakeGuidance(
  userText: string,
  sessionId: string,
  storage: Storage,
  // ...
): Promise<UserIntentGuidance> {
  // Fetch previous authorization state from session
  const session = await storage.getSession(sessionId);
  const previousPolicy = session.authorization_state
    ? JSON.parse(session.authorization_state)
    : null;

  return deriveTurnPolicy(userText, {
    previousPolicy,
    // ... other options ...
  });
}
```

---

### Phase 3 — 测试和 Replay（1 天）

#### 3.1 Authorization continuity unit tests

**文件**: `test/authorization-continuity.test.ts`

测试矩阵：

| 场景 | prevLevel | 用户输入 | expectedLevel | expectedSource |
|------|-----------|---------|---------------|----------------|
| 继承 local_change | `local_change` | "继续任务" | `local_change` | `inherited` |
| 继承 shared_change | `shared_change` | "continue" | `shared_change` | `inherited` |
| 不继承 inspect | `inspect` | "继续" | `inspect` | `inferred` |
| 明确重置 | `local_change` | "只看看状态" | `inspect` | `inferred` |
| 新授权覆盖 | `inspect` | "改这个文件" | `local_change` | `inferred` |
| 偏好不继承 | `local_change` | "用深色主题" | `none` | `inferred` |

#### 3.2 Replay fixture test

**文件**: `test/replay/session_1de7cf54-replay.test.ts`

```typescript
describe('Replay: session_1de7cf54 authorization continuity', () => {
  it('should replay Turn 4 → Turn 6 with authorization inheritance', async () => {
    const fixture = loadFixture('session_1de7cf54-auth-continuity-fixture.json');

    // Simulate Turn 4 intake
    const intake4 = await replayIntake(fixture.turns[4]);
    assert.strictEqual(intake4.authorizationLevel, 'local_change');
    assert.strictEqual(intake4.authorizationSource, 'explicit_user');

    // Simulate Turn 6 intake with previous policy
    const intake6 = await replayIntake(fixture.turns[6], {
      previousPolicy: {
        currentLevel: intake4.authorizationLevel,
        currentScope: intake4.consentScope,
        source: intake4.authorizationSource,
        establishedAt: intake4.timestamp,
      },
    });

    // EXPECTED: inheritance, not reset
    assert.strictEqual(intake6.authorizationLevel, 'local_change');
    assert.strictEqual(intake6.authorizationSource, 'inherited');
    assert.ok(intake6.inheritedFrom);
  });
});
```

---

### Phase 4 — Go TUI 和 CLI 可见性（0.5 天）

#### 4.1 bbl inspect-session 显示授权轨迹

**文件**: `src/cli/commands/inspect-session.ts`

```typescript
// Add authorization history section
if (events.some(e => e.type === 'user_intake_guidance')) {
  console.log('\n--- Authorization History ---');
  for (const ev of events.filter(e => e.type === 'user_intake_guidance')) {
    const p = ev.payload;
    console.log(`Turn ${ev.turn_index}:`);
    console.log(`  Level: ${p.authorizationLevel}`);
    console.log(`  Scope: ${p.consentScope}`);
    console.log(`  Source: ${p.authorizationSource}`);
    if (p.inheritedFrom) {
      console.log(`  Inherited from: Turn ${p.inheritedFrom.turnIndex}`);
    }
  }
}
```

#### 4.2 Go TUI 授权状态栏

**文件**: `clients/go-tui/internal/ui/status_bar.go`

显示当前授权级别：

```
[Auth: local_change] ← 绿色
[Auth: inspect] ← 黄色
[Auth: none] ← 灰色
```

---

### Phase 5 — 收口和迁移（0.5 天）

#### 5.1 验证和 lint

```bash
npm run typecheck
npm run format:check
npm test -- test/authorization-continuity.test.ts test/intent-guidance-auth-continuity.test.ts
npm run docs:check
```

#### 5.2 更新 strategy-authorization plan 状态

将 Phase 6 标记为 Closed，迁移到 `reference/`。

#### 5.3 更新 DONE.md

```markdown
- Authorization continuity bug 已收口（2026-07-XX）：
  "继续任务" 等延续指令继承上一轮 local_change 授权，不再重置为 inspect。
  Session 级别 authorization_state 持久化 + intake 继承逻辑 + replay 测试。
  详见 [authorization-continuity-execution-plan.md](./archive/authorization-continuity-execution-plan.md)。
```

---

## 边界和风险

### 边界

- **不动 provider 调用逻辑**：只在 intake → policy → runtime gate 层修改
- **不引入 permission 请求膨胀**：继承授权不触发新 permission 请求
- **不修改 tool risk 分类**：Write/Edit 仍为 write，远程 Bash 仍为 shared

### 风险

| 风险 | 缓解措施 |
|------|---------|
| 偏好选择误继承 | 重置短语列表 + 偏好动词检测（"用"/"选"/"prefer"） |
| 长时间间隔后继承过期 | `lastConfirmedAt` 超过 10 分钟 → 自动重置为 `inspect` |
| 用户实际意图改变但措辞简短 | 继承授权仍为 recoverable denial → 用户明确拒绝后重置 |

---

## 后续建议

### 立即推进（本次 PR）

Phase 0-3（约 3-4 天）：核心继承逻辑 + replay 测试

### 后续 PR

Phase 4（Go TUI 可见性）+ Phase 5（收口迁移）

### 长期方向

考虑 `AuthorizationLevel` 细化：
- `local_change` → 拆分为 `local_edit` / `local_commit` / `local_branch`
- `destructive` → 拆分为 `force_overwrite` / `delete_unrecoverable`

---

## 参考

- [strategy-authorization-and-consent-governance-plan.md](./strategy-authorization-and-consent-governance-plan.md) — 主提案
- [docs/nexus/active/TODO_runtime.md](../active/TODO_runtime.md) — P1 Intake Classifier
- Session `session_1de7cf54-3e73-4a1e-9e36-94e48b0fd661` — 证据会话
- Session `session_354525cf-8775-4daa-a7ec-5c0ccb302239` — 另一个授权断裂证据
