# 工具结果持久化与消息级预算规划

> 来源: session_e9fa6e3a 实战分析
> 优先级: P0
> 参考: BabeL-X `src/utils/toolResultStorage.ts`

## 问题

session_e9fa6e3a Turn 2 的 token 消耗明细：

```
Provider Call  input tokens   说明
───────────── ───────────── ──────────────
Call 1              3,533    首次请求
Call 2              9,733    Call 1 的工具结果 + 新 context
Call 3              9,941
Call 4             20,383    ← 大文件 Read 结果进入 context
Call 5             37,452    ← 翻倍
Call 6             37,996    ← 完整重发前 5 轮所有工具结果
Call 7             38,539    ← 完整重发
Call 8             39,098    ← 完整重发
───────────── ─────────────
合计             196,675    input tokens（仅 Turn 2）

全会话           362,988    input tokens
```

**核心问题**：工具循环中每次 provider call 都完整发送之前累积的所有工具结果。Call 5-8 每次重发 37-39K tokens，其中约 30K 是之前已经发送过的文件内容。117K tokens 重复消耗。

**根因**：`LLMCodingRuntime` 的 while 循环将工具结果 append 到 messages 数组，每次 provider call 发送完整数组。没有机制把已处理的大工具结果替换为预览。

## BabeL-X 解决方案摘要

BabeL-X 实现了两层预算：

### 层 1: 单条工具结果持久化（`maybePersistLargeToolResult`）

工具执行后立即检查结果大小：
- 阈值: `DEFAULT_MAX_RESULT_SIZE_CHARS = 50,000` chars
- 超限 → `persistToolResult()` 写入 `项目目录/sessionId/tool-results/{toolUseId}.txt`
- 上下文中替换为 `<persisted-output>` 标签 + 2KB 预览 + 文件路径
- Read 工具 `maxResultSizeChars = Infinity`，跳过持久化（避免循环）

### 层 2: 消息级聚合预算（`enforceToolResultBudget`）

每次 provider call 前执行：
- 阈值: `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200,000` chars
- 扫描每条 user message 中的所有 `tool_result` 块
- 按消息独立预算，超限的选择最大的几条替换为预览
- `ContentReplacementState` 跨轮追踪：`seenIds` 记录已检查的工具 ID，`replacements` 记录替换内容
- 已替换的结果在后续 call 中直接 re-apply（Map 查找，无文件 I/O），保证字节一致（prompt cache 友好）

## BabeL-O 实施方案

### 设计原则

1. **两层都要实现**：层 1 在工具执行后立即替换大结果；层 2 在 provider call 前清理累积膨胀
2. **不做 GrowthBook/Feature Flag**：BabeL-O 没有 analytics 基础设施，直接用常量和环境变量
3. **保留现有 per-turn 预算**：刚实现的 `toolResultBudgetChars` 作为层 2 的简化版，后续可升级
4. **Nexus-first 存储**：持久化文件放在 `.babel-o/tool-results/{sessionId}/` 而非 BabeL-X 的项目目录

### Step 1: 新建 `src/runtime/toolResultBudget.ts`（~150 行）

核心模块，4 个导出：

```ts
// 持久化结果元数据
export type PersistedToolResult = {
  filepath: string
  originalSize: number
  preview: string
  hasMore: boolean
}

// 跨轮替换状态
export type ToolResultReplacementState = {
  seenIds: Set<string>
  replacements: Map<string, string>
}

export function createReplacementState(): ToolResultReplacementState
```

**函数 1: `persistToolResult()`**

```ts
export async function persistToolResult(
  content: string,
  toolUseId: string,
  sessionId: string,
  cwd: string,
): Promise<PersistedToolResult | { error: string }>
```

- 目录: `{cwd}/.babel-o/tool-results/{sessionId}/`
- 文件名: `{toolUseId}.txt`
- `writeFile` 使用 `flag: 'wx'`（原子写入，防止重复）
- 返回 2KB 预览（按换行截断）

**函数 2: `buildPersistedMessage()`**

```ts
export function buildPersistedMessage(result: PersistedToolResult): string
```

格式：
```
<persisted-output>
Output too large (48KB). Full output saved to: .babel-o/tool-results/{id}.txt
Preview (first 2KB):
{preview}
</persisted-output>
```

**函数 3: `replaceLargeToolResult()` — 层 1 入口**

```ts
export async function replaceLargeToolResult(options: {
  content: string
  toolUseId: string
  toolName: string
  sessionId: string
  cwd: string
  threshold?: number  // 默认 50,000 chars
}): Promise<string>
```

- Read 工具跳过（threshold = Infinity）
- 内容 ≤ threshold → 原样返回
- 内容 > threshold → `persistToolResult()` → `buildPersistedMessage()`
- 持久化失败 → 原样返回（降级）

**函数 4: `enforceMessageBudget()` — 层 2 入口**

```ts
export async function enforceMessageBudget(
  messages: ModelMessage[],
  state: ToolResultReplacementState,
  budget: number,  // 默认 200,000 chars
): Promise<ModelMessage[]>
```

流程：
1. 遍历每条 user message 中的 `tool_result` content blocks
2. 对每个 `tool_result`，检查 `state.seenIds`：
   - 已见且在 `state.replacements` 中 → re-apply 替换内容（Map 查找，无 I/O）
   - 已见且不在 replacements 中 → 跳过（未替换的冻结决策）
   - 未见 → 标记为 fresh
3. 对 fresh 候选按消息独立计算总大小
4. 超预算 → 选择最大的几条 `persistToolResult()` 并替换
5. 所有候选标记为 seen
6. 返回修改后的 messages（替换是原地 clone 不影响原数组）

### Step 2: 修改 `src/runtime/LLMCodingRuntime.ts` — 集成两层预算

**2a: 初始化替换状态**

`executeStream()` 开始处新增：
```ts
const replacementState = createReplacementState()
```

**2b: 层 1 — 工具执行后立即替换大结果**

在 `toolResultsContent.push()` 之前（~line 960），对 `contentWithHints` 检查大小：

```ts
const persisted = await replaceLargeToolResult({
  content: contentWithHints,
  toolUseId: tc.id,
  toolName: tool.name,
  sessionId: options.sessionId,
  cwd: options.cwd,
})
```

替换后的内容才是实际 append 到 `toolResultsContent` 的内容。这一层确保单条超大结果（>50K chars）立即被替换为预览。

**2c: 层 2 — 每次 provider call 前清理累积膨胀**

在 while 循环顶部（`getContextWindowState` 之前），对当前 messages 应用聚合预算：

```ts
messages = await enforceMessageBudget(
  messages,
  replacementState,
  TOOL_RESULTS_PER_MESSAGE_CHARS,  // 200,000
)
```

这一层确保即使单条结果不大（<50K），但多条累积超过 200K 时，之前已处理的结果也会被替换为预览。

**2d: 移除现有 per-turn 预算**

现有的 `toolResultBudgetChars` / `toolBudgetExceeded` 逻辑被层 1 + 层 2 完全覆盖，移除以避免两套机制冲突。

### Step 3: 工具配置更新

在 `Tool` 类型或工具注册中添加 `maxResultSizeChars` 字段：

- Read: `Infinity`（跳过持久化）
- Bash: `50,000`
- Grep: `50,000`
- Glob: `50,000`
- 其他: `50,000`（默认）

### Step 4: 新建 `test/tool-result-budget.test.ts`（~15 个测试）

1. `persistToolResult` 写入文件并返回预览
2. `persistToolResult` 跳过已存在文件（wx flag）
3. `persistToolResult` 持久化失败时返回原内容
4. `buildPersistedMessage` 格式正确
5. `replaceLargeToolResult` 小结果原样返回
6. `replaceLargeToolResult` 大结果替换为预览
7. `replaceLargeToolResult` Read 工具跳过
8. `enforceMessageBudget` 空消息原样返回
9. `enforceMessageBudget` 单条大结果被替换
10. `enforceMessageBudget` 多条累积超预算时替换最大的
11. `enforceMessageBudget` 已替换的结果 re-apply 无 I/O
12. `enforceMessageBudget` seenIds 决策冻结（未替换的不被后续替换）
13. 集成测试：8 次 provider call 的累积 messages 从 37K→10K
14. 环境变量 `BABEL_O_TOOL_RESULT_THRESHOLD` 覆盖阈值
15. 非文本 tool_result 跳过

### Step 5: 测试更新 + 全量验证

- `runtime.test.ts`：更新 blocking guard 测试（移除 `toolBudgetExceeded` 相关断言）
- `context-assembler.test.ts`：无变化
- 全量测试通过

## 常量定义

```ts
// src/runtime/toolResultBudget.ts
const TOOL_RESULT_PERSIST_THRESHOLD = 50_000    // 单条结果持久化阈值（chars）
const TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000  // 单条消息聚合预算（chars）
const PREVIEW_CHARS = 2_000                      // 替换后预览大小（chars）
const TOOL_RESULTS_DIR = 'tool-results'          // 持久化目录名
```

环境变量覆盖：
- `BABEL_O_TOOL_RESULT_THRESHOLD`: 单条阈值（默认 50000）
- `BABEL_O_TOOL_RESULT_MESSAGE_BUDGET`: 消息预算（默认 200000）
- `BABEL_O_TOOL_RESULT_PREVIEW_CHARS`: 预览大小（默认 2000）

## 效果预估

以 session_e9fa6e3a Turn 2 为例：

```
                    改前          改后
Provider Call    input tokens  input tokens
─────────────── ──────────── ────────────
Call 1               3,533        3,533   (无变化)
Call 2               9,733        9,733   (无变化)
Call 3               9,941        9,941   (无变化)
Call 4              20,383       15,200   (48K Read 结果被替换为 2K 预览)
Call 5              37,452       12,100   (之前的大结果全部替换为预览)
Call 6              37,996       12,300
Call 7              38,539       12,500
Call 8              39,098       12,800
─────────────── ──────────── ────────────
合计              196,675       81,107   (-59%)

全会话 input      362,988      ~180,000  (-50%)
```

## 实施状态：✅ 已完成 (2026-05-28)

实际实施与原方案略有差异：
- Step 3 (maxResultSizeChars 字段) 未单独添加到 Tool.ts 类型，改为在 `replaceLargeToolResult` 中按 toolName === 'Read' 跳过，更简洁。
- 旧 per-turn 预算（toolResultBudgetChars / toolBudgetExceeded）已完全移除。
- 9 个测试覆盖：持久化写入、wx 去重、小结果跳过、大结果替换、Read 跳过、消息预算、re-apply、非 user 消息跳过。

```
Step 1  ✅ src/runtime/toolResultBudget.ts 新建
Step 2  ✅ LLMCodingRuntime.ts 集成两层预算 + 移除旧 per-turn 预算
Step 3  ✅ Read 工具跳过持久化（通过 toolName 判断，无需类型字段）
Step 4  ✅ test/tool-result-budget.test.ts 新建（9 个测试）
Step 5  ✅ 全量验证通过（259/261，2 个预先存在的 URL 配置失败）
```
