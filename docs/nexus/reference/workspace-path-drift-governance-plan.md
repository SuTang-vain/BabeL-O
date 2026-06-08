# Workspace Path Drift / Tool Failure Recovery 治理规划

> Status: P2 / Watch — minimal diagnostic implemented; repeated-root aggregation / final-answer downgrade remain watch-only
> Priority: 真实会话 regression 驱动；最小诊断与回归已收口，后续仅在重复复现时加强治理
> 真实样本: `session_1cf5362d-b33f-467f-b07e-f97356652662`

---

## 1. 背景

`session_1cf5362d-b33f-467f-b07e-f97356652662` 暴露了一类不同于单个工具失败的真实问题：模型在跨仓库任务中发生 workspace path drift，随后连续调用 `Read` / `ListDir` / `Glob` 访问不存在的绝对路径，工具按预期返回 recoverable failure，但模型没有把失败归因为路径根错误，而是在错误根目录下继续探索并最终输出分析。

该样本的关键路径差异：

```text
正确 cwd: /Users/tangyaoyue/DEV/BABEL/BabeL-O
错误路径: /Users/tangyaoyue/DEV/BabeL-O
```

会话中模型成功 clone 并读取 sibling repo：

```text
/Users/tangyaoyue/DEV/headroom
```

之后在需要回读 BabeL-O 源码时，把当前 workspace 的父级目录简化错写，导致：

- `Read /Users/tangyaoyue/DEV/BabeL-O/src/...` 返回 file not found。
- `ListDir /Users/tangyaoyue/DEV/BabeL-O/src/...` 返回 directory not found。
- `Glob path=/Users/tangyaoyue/DEV/BabeL-O` 返回空结果。
- session 没有 runtime fatal `error` event，最终仍继续产出回答，但证据链局部失真。

这不是 `Read` / `ListDir` / `Glob` 的实现崩溃，而是工具失败后的自我纠偏不足。

---

## 2. 泛化问题定义

### 2.1 Workspace Path Drift

定义：模型在长会话或跨仓库任务中，把当前 workspace root、sibling repo root、历史路径或用户给出的目标路径混淆，导致后续工具调用持续访问错误路径。

常见形态：

```text
/Users/me/DEV/BABEL/BabeL-O  → /Users/me/DEV/BabeL-O
/Users/me/project            → /Users/me/projects/project
/worktree/session-x/repo     → /repo
/tmp/agent-worktree/foo      → 原始 repo foo
```

该问题通常不会触发安全边界，因为路径仍可能在 allowed workspace 或允许读取范围内；它的风险主要是 evidence drift：模型把“没有找到”误读成“项目中不存在”。

### 2.2 Tool Failure Recovery Drift

定义：工具结果已经给出 recoverable failure 和纠错建议，但模型没有沿建议修正，而是重复同类错误或扩大错误路径范围。

典型表现：

- 同一不存在 root 下连续 `Read` / `ListDir` / `Glob` 失败。
- 工具提示 “use Glob” 后，模型仍在同一错误 `path` 下 `Glob`。
- Bash `ls` 已输出 `No such file or directory`，模型仍继续用该绝对根路径。
- schema validation 已提示范围限制，模型下一步没有用有效边界重试。

### 2.3 Evidence Degradation Without Fatal Error

定义：session 没有进入 failed phase，工具失败也都是 recoverable，但最终回答声称了超过实际证据覆盖范围的结论。

这类问题比 fatal error 难发现，因为用户看到的是完整回答，而不是 runtime 失败。

---

## 3. 与现有治理的关系

| 现有治理 | 已解决 | 仍缺口 |
| --- | --- | --- |
| Tool Granularity / Evidence-grounded Reading | 明确 `ListDir` / `Glob` / `Grep` / `Read` 职责边界，避免 locator 证据被过度解释。 | 不检测“连续失败是否源于路径根漂移”。 |
| Bash-as-file-discovery guidance | 对 `ls/find/tree/grep -r/rg` 给出替代工具提示。 | Bash 输出 `No such file` 后没有跨工具 path drift 归因。 |
| Working Set | 记录最近工具读写和显式路径。 | 不把当前 cwd / canonical workspace root 作为纠偏锚点反馈给失败工具。 |
| ContextForker | child session 可继承 active paths。 | sibling repo / worktree 切换时仍可能混淆 root。 |
| Source Coverage Ledger 候选 | 可记录证据覆盖。 | 太重，不适合作为本问题的第一步。 |

本规划是工具结果恢复治理的轻量补充，不替代 Source Coverage Ledger，也不新增新工具。

---

## 4. 设计目标

1. 让模型在路径不存在时优先检查当前 cwd / workspace root，而不是继续猜绝对路径。
2. 对连续同根路径失败输出明确 `PATH_DRIFT_SUSPECTED` 诊断。
3. 将工具失败从“单次错误”提升为“跨工具可见的恢复信号”。
4. 避免把 recoverable path failure 升级成 session fatal。
5. 限制最终回答的证据强度：如果关键源码读取失败，回答必须说明未确认范围。

---

## 5. 非目标

- 不新增 `PathResolve` / `Search` 等重复工具。
- 不允许模型绕过 path safety 或 allowed paths。
- 不自动改写用户提供的绝对路径并执行危险操作。
- 不做完整 Source Coverage Ledger 第一阶段实现。
- 不把 sibling repo 自动纳入当前 workspace ownership；跨仓库读取仍由现有 allowed path / permission 策略约束。
- 不在失败时静默切换 cwd。

---

## 6. 分阶段方案

### Phase A: 最小 regression fixture 与诊断口径

状态：已实现。

目标：用 `session_1cf5362d-b33f-467f-b07e-f97356652662` 抽象出最小回归，覆盖 cwd 包含额外 parent segment、模型误用 sibling-like root 的场景。

收口标准：

- 新增 fixture：当前 cwd 为 `/tmp/.../BABEL/BabeL-O`，工具调用访问 `/tmp/.../BabeL-O/src`。
- `Read` / `ListDir` / `Glob` 的 file-not-found 或 empty-result 能产生 path drift diagnostic。
- diagnostic 不改变工具 success/failure 语义；仍保持 recoverable failure。

### Phase B: Path Drift Detector

状态：已实现最小 helper。

建议新增轻量 helper，而不是复杂 runtime 状态系统：

```typescript
type PathDriftDiagnostic = {
  code: 'PATH_DRIFT_SUSPECTED'
  attemptedPath: string
  cwd: string
  candidatePath?: string
  reason: 'missing-workspace-parent-segment' | 'sibling-root-confusion' | 'repeated-missing-root'
  guidance: string
}
```

检测启发式：

1. attempted path 不存在。
2. attempted path basename 或后缀片段与 cwd basename / cwd suffix 相同。
3. attempted path 与 cwd 共享较长 prefix，但少了中间 segment。
4. 在同一 session 内，同一 missing root 连续失败达到阈值。
5. candidate path 存在且位于当前 cwd 或 allowed workspace 内。

示例输出：

```json
{
  "code": "PATH_DRIFT_SUSPECTED",
  "attemptedPath": "/Users/tangyaoyue/DEV/BabeL-O/src",
  "cwd": "/Users/tangyaoyue/DEV/BABEL/BabeL-O",
  "candidatePath": "/Users/tangyaoyue/DEV/BABEL/BabeL-O/src",
  "reason": "missing-workspace-parent-segment",
  "guidance": "The path does not exist, but a similar path exists under the current cwd. If you are inspecting the current project, retry with cwd-relative paths or the candidatePath."
}
```

### Phase C: Tool Result Guidance Integration

状态：已实现最小 `Read` / `ListDir` / `Glob` guidance。

适用工具：

- `Read`: file not found / expected file but directory。
- `ListDir`: directory not found。
- `Glob`: explicit `path` exists? false；或 path 不存在导致空结果。
- `Bash`: `ls` / `test -e` / `find` 等 read-only discovery 输出 `No such file or directory` 时，可附加同类 guidance。

输出原则：

- 不把 diagnostic 塞进 assistant 文本；作为 tool output structured guidance 或 runtime diagnostic。
- 保持原有错误信息可读。
- guidance 必须包含当前 cwd。
- 如果存在 safe candidate path，提供 candidate；否则只提示先 `ListDir` cwd 或用 cwd-relative path。

### Phase D: Repeated Missing Root Aggregation

状态：Watch，需真实复现再做。

如果 Phase B/C 后仍出现重复失败，可在 runtime tool loop 层维护短生命周期 ledger：

```typescript
type MissingRootRecord = {
  root: string
  count: number
  tools: string[]
  firstSeenAt: string
  lastSeenAt: string
}
```

当同一 root 连续失败超过阈值，下一次工具结果追加更强提示：

```text
Multiple recent tools failed under the same missing path root. Stop using this root and verify the current cwd before continuing.
```

该 ledger 只用于当前 request，不持久化为长期 session state。

### Phase E: Final Answer Evidence Downgrade

状态：Watch，避免过早复杂化。

如果最近 N 次工具失败包含 `PATH_DRIFT_SUSPECTED`，最终回答 guidance 可提示模型：

```text
Some attempted source reads failed due to suspected path drift. Do not claim those files were inspected. State the unverified area explicitly.
```

这可以作为 Source Coverage Ledger 的轻量前置，不记录完整 coverage，只处理失败证据边界。

---

## 7. 优先级判断

| 优先级 | 项目 | 判断 |
| --- | --- | --- |
| P2 | Phase A/B/C | 最小且直接对应真实会话；可提升工具失败恢复质量。 |
| P2 / Watch | Phase D | 只有连续 missing-root 仍复现时再做。 |
| P2 / Watch | Phase E | 只有最终回答继续过度声明时再做。 |
| 不做 | 新增路径搜索工具 | 与 `ListDir` / `Glob` 重叠。 |
| 不做 | 自动 cwd 切换 | 可能破坏用户意图和安全边界。 |

---

## 8. 验证标准

- `Read` missing file 回归覆盖：错误绝对根与 cwd 只差中间 parent segment 时输出 `PATH_DRIFT_SUSPECTED`。
- `ListDir` missing directory 回归覆盖：同上。
- `Glob` path 不存在或 empty-result 回归覆盖：提示优先验证 cwd / candidate path。
- 不存在 safe candidate 时不猜路径、不自动执行。
- workspace escape / symlink escape 仍由现有 path safety 拒绝，不因 candidate path 诊断绕过。
- `npm test` focused tool tests 通过。
- `npm run typecheck` 通过。

---

## 9. 决策摘要

BabeL-O 不需要为路径漂移新增工具，也不应把 recoverable file-not-found 升级为 fatal。正确方向是：

```text
现有工具 + 当前 cwd 锚点 + path drift diagnostic + 失败证据降级
```

`session_1cf5362d-b33f-467f-b07e-f97356652662` 的核心教训是：工具失败本身可恢复，但如果模型不能把连续失败归因为路径根漂移，最终回答会出现隐性证据退化。后续应优先补最小 path drift detector 和 tool result guidance。
