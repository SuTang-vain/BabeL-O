# Go TUI 工具调用 / 权限审批 / Timeout 优化规划

> Status: **Phase 0 + Phase 1 + Phase 2 + Phase 3 + Phase 4 + Phase 5 landed**
> Priority: P1 Watch；基于真实 session `session_dcf7e34e-bc59-41e4-b802-e4d03d32b48d` 的失败链路，优先减少只读源码分析中的 Bash 权限噪音与 180s 顶层 timeout 风险。
> 真实样本: `session_dcf7e34e-bc59-41e4-b802-e4d03d32b48d`（Go TUI session，用户请求“查看并分析go tui状态机”；184 events；19 tools 全成功；10 次 Bash permission 全 approved；最终 `REQUEST_TIMEOUT`）。
>
> **范围拆分提示**：本规划解决“权限/工具噪音 + near-timeout warning + Bash read-only classifier + adaptive Go TUI timeout”这层局部降噪；它没有改变 180s 顶层 cutoff 的语义。`session_791b10ce-0d41-409d-b2de-1e5d14eb19b3` 真实样本暴露的“仍在推进时被 fatal cutoff 直接 abort”这个更底层产品语义已由 [evidence-and-runtime-history.md](../history/evidence-and-runtime-history.md) 接手并 Phase 0~6 全部落地（soft policy + soft cycle + auto extension + Go TUI 软超时可见化 + hard watchdog `details.kind='watchdog'` 标记与清理 + DONE 同步），两份规划是“降噪” vs “fatal timeout 语义”的互补关系，不应再把本规划用于追加 fatal timeout 行为变更。

---

## 1. 背景

用户要求查看并分析 `session_dcf7e34e-bc59-41e4-b802-e4d03d32b48d` 中的工具调用、权限允许机制和潜在问题。SQLite 复盘显示该 session 已完整持久化，但最终状态为 `failed`：

| 指标 | 结果 |
|---|---:|
| session phase | `failed` |
| user prompt | `查看并分析go tui状态机` |
| event count | 184 |
| tool calls | 19 |
| `permission_request` / `permission_response` | 10 / 10 |
| permission audit | 10 条，全部 `Bash` / `execute` / `approved` |
| failed tools | 0 |
| timeout | `REQUEST_TIMEOUT` |
| `timeoutMs` | 180000 |
| `executeDurationMs` | 180011 |
| provider request duration | ~125.4s |
| tool execution duration | ~32.5s |
| approval wait duration | ~31.5s |
| input tokens | 149378 |
| output tokens | 1799 |

关键事实：**工具全部成功，权限全部批准，最终失败来自顶层 180s request timeout。**

这不是权限拒绝或工具执行失败，而是长上下文 provider 时间、只读源码分析误用 Bash、Go TUI 人工审批串行等待三者叠加导致的真实失败样本。

---

## 2. 失败链路

### 2.1 时间线

1. `2026-06-11T07:35:22.910Z` 用户输入：`查看并分析go tui状态机`。
2. `2026-06-11T07:35:22.914Z` session started，cwd `/Users/tangyaoyue`。
3. `2026-06-11T07:35:33Z` 起，模型开始读取 Go TUI 代码：`ListDir`、`Read`、`Grep`、`Bash sed`、`Bash grep` 混用。
4. `2026-06-11T07:36:59Z` 起，连续出现 10 次 `Bash` permission request，全部由 Go TUI approve。
5. `2026-06-11T07:38:22.891Z` 顶层请求超时：`REQUEST_TIMEOUT This operation was aborted`。
6. `execute_summary.outcome = timeout`，`nearTimeout = true`，session failed。

### 2.2 工具调用分布

| Tool | Count | Success | Failed | Total duration |
|---|---:|---:|---:|---:|
| `ListDir` | 3 | 3 | 0 | ~5ms |
| `Read` | 2 | 2 | 0 | ~13ms |
| `Grep` | 4 | 4 | 0 | ~48ms |
| `Bash` | 10 | 10 | 0 | ~32.4s |

Bash 命令均为源码查看/定位用途，例如：

```text
sed -n '2200,2650p' .../clients/go-tui/internal/tui/tui.go | head -c 30000
grep -n "permission_request\|streamEvent\|events\s*<-\|sendPermissionDecision\|pending =" .../tui.go | head -80
sed -n '5820,6000p' .../tui.go
grep -nE "Test[A-Z][a-zA-Z_]+" .../tui_test.go | head -40
```

这些行为本质上是 read-only source inspection，但因为走 `Bash` 且包含 shell operator / pipe，被当作 `execute` 风险并触发权限面板。

### 2.3 权限审批分布

- 10 次 `permission_request`，10 次 `permission_response`。
- 10 条 `permission_audits` 全部为：`decision=approved`，`reason=Approved from Go TUI`。
- 所有 response 都没有有效复用信息：`scope=null` / `rule=null`。
- 所有 request 的 `suggestedRule=null`。
- 审批等待总计约 `31.5s`，平均 `3.15s`，最长 `17.998s`。

结论：权限机制**没有阻止任务**，但造成了高频人工打断；session-scope approval 没有被使用，重复审批无法自动收敛。

---

## 3. 根因分析

### 3.1 模型工具选择偏离工具边界

模型可以使用 `Read` / `Grep` / `ListDir` 完成源码分析，却频繁改用 `Bash sed`、`Bash grep | head`。

这违反了工具粒度边界：

- `Read`：source understanding / 定点读取。
- `Grep`：content locating。
- `ListDir`：bounded inventory。
- `Bash`：执行 shell 命令；即使只读，也存在 shell syntax / pipe / redirect / substitution 风险。

真实影响：只读源码分析进入权限审批路径，吞掉约 31.5s 人工等待预算。

### 3.2 Bash read-only classifier 覆盖不足

`src/tools/builtin/bashClassifier.ts` 当前 read-only allowlist 包含 `cat/head/tail/git status/...` 等，但没有覆盖：

- `sed -n <range> <file>`
- 普通 `grep -n/-E <pattern> <file>`
- 安全 `head -c/-n` 管道组合

同时，危险 pattern 对 `|` 的保守处理会把 `sed ... | head -c ...` 归入 manual review。该保守策略在安全上合理，但在源码阅读场景中会产生明显噪音。

### 3.3 `classifyAction` 与 `riskForInput` 双层分类不一致

runtime 有两层判断：

1. `tool.riskForInput()` 决定 `effectiveRisk`，影响 hard-deny 与 permission gate。
2. `classifyAction()` 决定 write/execute 风险下是否 auto approve。

对 Bash 来说，即使某些命令可被 `riskForInput` 视为 read-only，如果 `classifyAction` 对 shell operators 仍返回 “Shell operators require manual review”，也会在 execute-risk 路径上继续弹权限。

优化必须同时处理两层，否则容易出现“effectiveRisk 变 read 但审批仍弹”或“auto approve 但 audit 不一致”的漂移。

### 3.4 `suggestedRule` 缺失导致 session approval 失效

当前源码中 `LocalCodingRuntime.deriveBashSuggestedRule()` 理论上可 fallback 到 `bash:*`，但本 session 的 `permission_request.suggestedRule` 全部为空。

可能原因：

- 运行中的 Nexus 版本早于当前源码。
- 事件生成路径没有带上 `suggestedRule`。
- Bash tool definition 未提供 `suggestedAllowRule` 且 deriver 未覆盖这些 input。
- Go TUI 展示/决策路径未保留该字段。

真实影响：Go TUI 的 “Approve for this session” / “Approve with editable rule” 没有默认规则可用，operator 很容易只走 approve-once，导致 10 次重复审批。

### 3.5 Timeout 缺少 partial-result 韧性

session 在 180s 顶层 timeout 时已经产出大量分析内容，但最终 `result` 只有 `This operation was aborted`。

当前体验问题：

- 用户看到 failed，难以确认已完成了多少分析。
- assistant 的 partial reasoning / partial answer 没有被提升为可复用结果。
- `nearTimeout=true` 已记录，但没有触发提前收口策略。

---

## 4. 目标行为

1. **源码阅读优先使用 Read/Grep/ListDir**：普通源码分析不应默认走 `Bash sed/grep/head`。
2. **安全只读 Bash 自动降噪**：`sed -n`、安全 `grep`、安全 `head/tail` 可被 classified 为 read-only 或 auto-approved。
3. **权限审批可复用**：Bash permission request 必须带可用 `suggestedRule`；用户选择 session scope 后，同类命令不再重复弹窗。
4. **长任务接近 timeout 前可保留部分成果**：near-timeout 时主动输出 partial summary / diagnostics，而不是只留下 aborted result。
5. **回归可量化**：类似该 session 的源码分析任务，`permission_request` 数量、approval wait、timeout outcome 都有测试/指标守门。

---

## 5. 非目标

- 不把所有 Bash 默认放行。
- 不放行写命令、重定向、pipe-to-shell、command substitution、`sed -i`、`grep ... > file` 等风险模式。
- 不绕过 Go TUI 用户审批机制。
- 不把 `timeoutMs` 单纯提高当作根治。
- 不修改 `permission_request` / `permission_response` schema 的已存在字段语义；新增字段必须 optional。
- 不污染真实 `~/.babel-o/config.json`；测试继续用 env/temp storage 隔离。

---

## 6. 分阶段优化方案

### Phase 0: 回归样本与指标守门（0.5-1 天）

状态：已落地。

落地点：

- `test/go-tui-tool-permission-timeout-regression.test.ts` 新增 synthetic SQLite fixture，固化 `session_dcf7e34e-bc59-41e4-b802-e4d03d32b48d` 的核心失败形状：
  - session phase = failed
  - outcome = timeout
  - request timeout = `REQUEST_TIMEOUT`
  - tool traces 全部 success
  - Bash permission audits 全部 approved
  - approval wait 是 material cost
- `package.json` 的 `npm test` 列表已接入该 focused regression。
- 测试使用 `mkdtempSync` + temp SQLite，不读写真实 `~/.babel-o/db.sqlite`。

收口标准：

- `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test test/go-tui-tool-permission-timeout-regression.test.ts` 通过。
- 摘要区分 tool success、permission approved、request timeout，避免未来误判为工具失败或权限拒绝。

### Phase 1: 工具选择 guidance 降噪（1-2 天）

状态：已落地。

落地点：

- `src/runtime/systemPromptBuilder.ts` 的 `Tool Usage` 已明确：普通源码查看禁止优先使用 `Bash sed/head/grep/rg` 或 shell pipelines，除非用户明确要求 shell syntax 或任务需要 shell-only 行为。
- `src/tools/builtin/bash.ts` 的 Bash prompt 已补强边界：Bash 保留给 build/test/install/git/shell-only workflows；源码片段读取用 `Read`，文本定位用 `Grep`，目录清点用 `ListDir`，路径发现用 `Glob`。
- `src/tools/builtin/read.ts`、`src/tools/builtin/grep.ts`、`src/tools/builtin/listDir.ts` 已分别强调源码阅读、文本定位、目录 inventory 的首选工具边界，避免模型退回 `Bash sed/head/grep` 管道。
- `test/tool-prompt.test.ts` 已新增 Phase 1 prompt regression，锁定 system prompt 与工具 prompt 中的源码查看降噪 guidance。

收口标准：

- `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-test-config.json npx tsx --test test/tool-prompt.test.ts test/system-prompt-builder.test.ts` 通过。
- 后续真实/LLM smoke 中，针对“分析 Go TUI 状态机”的源码分析首选路径应为 `ListDir` / `Grep` / `Read`，不再把 `Bash sed` / `Bash grep | head` 作为默认源码阅读方式。
- 结合 Phase 2 / Phase 3，`Bash` permission request 数量目标仍为 `<= 2`。

### Phase 2: Bash read-only classifier 扩展（2-3 天）

状态：已落地。

落地点：

- `src/tools/builtin/bashClassifier.ts` 已扩展窄口径源码查看分类：
  - `sed -n '<start>,<end>p' <file>` → read
  - `grep -n/-E/-F/-i <pattern> <file>` → read
  - 安全 `| head -n/-c <N>` / `| tail -n/-c <N>` 截断管道 → read
- 严格拒绝仍保留：
  - `sed -i`
  - output redirect / append redirect
  - input redirect（除非后续专门建模）
  - pipe-to-shell
  - command substitution
  - chained `;`, `&&`, `||`
  - `grep ... | xargs rm` 等链式执行
- `src/runtime/classifier.ts` 已同步窄口径 `sed` / `grep` auto-approve，避免 safe Bash 仍因 shell operator 进入 manual review。
- `test/bash-classifier.test.ts`、`test/classifier.test.ts`、`test/runtime.test.ts` 已补回归，覆盖安全 `sed`/`grep`、危险变体、safe Bash 不产生 `permission_request`。

收口标准：

- `bash-classifier.test.ts` 用例：安全 `sed -n` / `grep` classified read。
- 危险变体仍 classified execute。
- runtime 测试证明 safe Bash 不产生 `permission_request`。

### Phase 3: `suggestedRule` 与 session approval 修复（2-3 天）

状态：已落地。

落地点：

- `src/runtime/LocalCodingRuntime.ts` 已确保 Bash permission request 有稳定 `suggestedRule`：
  - safe `sed -n ...` → `bash:sed-read`
  - safe `grep ...` → `bash:grep-read`
  - unknown / unsafe Bash → `bash:*` fallback
- `deriveBashSuggestedRule()` 已从简单 whitespace split 改为复用 `tokenizeBashCommand()`，避免 quoted command / flags 解析偏差。
- `buildSessionRulesPolicy()` 已新增结构化匹配：
  - `bash:grep-read` 只匹配 classifier 仍认定为 read 的安全 grep；不匹配 `grep -r` 等 broad/unsafe 变体。
  - `bash:sed-read` 只匹配 classifier 仍认定为 read 的安全 sed；不匹配 `sed -i` 等写入变体。
  - `bash:*` 仍作为显式 broad Bash fallback。
  - 旧 substring match 保留为 legacy fallback。
- `test/runtime.test.ts` 已补回归：Bash suggestedRule 派生、结构化 session rule 匹配、session-rule auto approval audit reason。
- `clients/go-tui/internal/tui/` 已补短窗口重复 `suggestedRule` 计数：同类权限请求短时间重复出现时，权限面板突出 “Approve for this session” 并显示 session approval 建议。
- `clients/go-tui/internal/tui/tui_test.go` 已补 Go TUI 回归：重复 suggestedRule 高亮、无 suggestedRule 不误提示、permission_request 消费路径累计 repeatedRuleCount。

收口标准：

- permission_request 事件里 Bash 必有合理 suggestedRule。
- Go TUI 选择 session approval 后，下一次同类 Bash 不再弹 permission。
- permission audit reason 明确显示 `Approved by session rule`。

### Phase 4: Near-timeout partial result 韧性（2-4 天）

状态：已落地。

落地点：

- `src/shared/events.ts` 新增 optional `near_timeout_warning` 事件 schema，用于非 breaking 地提示执行接近 timeout 预算。
- `src/nexus/app.ts` 在 HTTP `/v1/execute` 与 WebSocket `/v1/stream` 两条路径共用 near-timeout watcher：
  - 当执行耗时达到 `timeoutMs * 0.8` 且已有 `assistant_delta` / tool evidence 时，追加并持久化 `near_timeout_warning`。
  - WebSocket 路径会即时推送该 warning 给 Go TUI。
- timeout 发生时，如果已有 partial assistant/tool evidence，会追加一个失败 `result`，message 包含 `Partial result preserved before timeout` 和压缩后的 partial summary，避免最终结果只有 `This operation was aborted`。
- `src/cli/renderEvents.ts` 与 `clients/go-tui/internal/tui/tui.go` 已补 `near_timeout_warning` 渲染，避免终端里退化成 raw JSON。
- `test/runtime.test.ts` 已补 focused regression：long-running mock timeout 后产生 `near_timeout_warning`，并且最终 `result.message` / session.result 保留 partial analysis。

收口标准：

- 真实 long-running mock session timeout 后，用户仍能看到 partial analysis。
- `result.success=false` 仍保留，但 message 不再只有 `This operation was aborted`。

### Phase 5: Go TUI timeout 自适应兜底（1-2 天）

状态：已落地。

落地点：

- `clients/go-tui/internal/tui/tui.go` 保持默认 `180s`，并抽出 `resolveGoTuiTimeout()` 作为纯决策函数。
- 当 Go TUI 识别到 long-context 信号时自动提高到 `300s`：
  - 当前 prompt 明确包含 long-context / 大上下文 / 深度分析等标记；或
  - 最近 usage snapshot 的 input tokens > `100k`。
- 显式非默认 timeout（例如 env / CLI 配置为 240s）不被自动覆盖，避免破坏用户意图。
- `buildExecuteRequestWithTimeout()` 将决策后的 timeout 写入 WebSocket `/v1/stream` payload。
- Go TUI header 在运行中显示 `timeout=300s (long-context)`；adaptive 提升也追加 status transcript 行，避免静默改变预算。
- `clients/go-tui/internal/tui/tui_test.go` 已补回归：普通 turn 仍为 180s、long-context 提升 300s、显式 timeout 不被覆盖、payload 写入 300s、header 可见。

收口标准：

- long-context Go TUI regression 不因固定 180s 失败。
- timeout 提升必须可观测，不静默改变。

---

## 7. 建议优先级

1. **P0**：Phase 0 + Phase 1。先固化回归样本，并减少模型误用 Bash。
2. **P0/P1**：Phase 2。扩展安全只读 Bash 分类，直接减少 permission noise。
3. **P1**：Phase 3。修复 `suggestedRule` 与 session-scope 复用，降低重复审批。
4. **P1/P2**：Phase 4。让 timeout 前有 partial result。
5. **P2**：Phase 5。timeout 自适应作为兜底，不作为根治。

---

## 8. 回归守门建议

### Unit tests

- `bashClassifier`：
  - `sed -n '2200,2650p' file.go` → read
  - `grep -nE "pattern" file.go` → read
  - `sed -i 's/a/b/' file.go` → execute
  - `sed -n '1,20p' file.go | sh` → execute
  - `grep pattern file.go > out.txt` → execute

### Runtime tests

- safe Bash effectiveRisk = read 时不产生 `permission_request`。
- unsafe Bash 仍产生 `permission_request`。
- Bash permission_request 必带 `suggestedRule`。
- `scope=session` approval 后，同类 Bash 下一次 auto-approved。

### Go TUI tests

- permission panel 渲染 suggestedRule。
- 选择 “Approve for this session” 后发送 `scope=session` + `rule`。
- 没有 suggestedRule 时不允许累积空规则。

### E2E / smoke

- 复现“查看并分析 Go TUI 状态机”任务：
  - `permission_request <= 2`
  - `outcome=success`
  - `nearTimeout=false` 或至少有 partial result
  - no failed tools

---

## 9. 与既有规划关系

- [go-tui-history.md](../history/go-tui-history.md)：本文件是其后续优化。既有规划解决 Bash hard-deny 截胡 permission panel；本文件解决 permission panel 过度触发与 session-scope 复用不足。
- [go-tui-execute-timeout-governance-plan.md](../archive/go-tui-execute-timeout-governance-plan.md)：本文件复用其 timeout 可观测性成果，但不把提高 timeout 当根治；重点是减少 tool/approval 耗时和补 partial-result 韧性。
- [tool-granularity-and-evidence-governance-plan.md](./tool-granularity-and-evidence-governance-plan.md)：本文件落实其中的工具边界：源码阅读优先 `Read` / `Grep` / `ListDir`，避免用 Bash 代替专用读工具。
- [go-tui-session-observability-governance-plan.md](../proposals/go-tui-session-observability-governance-plan.md)：本文件依赖其 session 可复盘能力；`session_dcf7e34e-bc59-41e4-b802-e4d03d32b48d` 能被 SQLite 复盘，才暴露出该链路。

---

## 10. 当前结论

`session_dcf7e34e-bc59-41e4-b802-e4d03d32b48d` 的问题不是“工具失败”或“权限拒绝”，而是：

1. 模型把普通源码阅读转成 Bash shell 操作；
2. Bash classifier / action classifier 对安全只读 shell 覆盖不足；
3. Go TUI 权限审批没有 session-scope 复用；
4. 长上下文 provider 时间 + 工具时间 + 审批等待共同撞上 180s timeout；
5. timeout 后没有足够好的 partial result 保留。

优化应优先降低无意义 Bash 权限噪音，再补 timeout 韧性。
