# Go TUI Permission Policy / Bash Hard-Deny 治理规划

> Status: Phase A + B + C + D + E 全部已落地（治理收口）；Phase A.1 增强权限面板 Round 1（多选项 + session scope）+ Round 2（inline rule / feedback editor）均已落地；Phase B 推进（CLI 软拒绝透传 `BABEL_O_CLI_POLICY_MODE`）已落地
> Priority: 真实会话 regression 驱动；现状是 Bash 在 `denyByDefaultTools()` 下 hard-deny 截胡 permission_request，Phase A 已让 read-only subcommand 跳过 policy + approval gate，后续按 regression-first 推进
> 真实样本: `session_go_1781076550805204000`（Go TUI WebSocket 会话，sessionId 末段 204000 来自 `session_go_<unixnano>` 命名）

---

## 1. 背景

`session_go_1781076550805204000` 暴露了一类与 execute-timeout 不同的真实问题：用户在 Go TUI 启动 code review 任务，模型在开场白决定先 `git status` 摸清 working tree 状态，Nexus policy 评估后直接 hard-deny `Bash`，**未发出 `permission_request`**。Go TUI 端的 `a/y/n/r/esc` 权限面板永远没机会弹出，session 在 8 秒内 failed，模型只输出了 131 tokens 的开场白就结束。

完整事件流（来自 `GET /v1/sessions/session_go_1781076550805204000?recentEventLimit=200`）：

```text
07:29:10.806  user_message:        "phase 9 重构的 diff 解读、Go runner / Go TUI 协议、超时   治理方案评审"
07:29:10.806  session_started
07:29:15.599  user_intake_guidance: intent=continue, requiresTools=true
07:29:15.711  PreInvocation hook
07:29:17.135  usage:               input=3782 output=0 cacheRead=114
07:29:18.212  assistant_delta:     "我先看 git status 和未追踪文"
07:29:18.980  usage:               input=0 output=131
07:29:18.980  assistant_delta:     "件以确认要评审的范围，然后并行读取关键文件。"
07:29:18.980  PostInvocation hook
07:29:18.980  tool_started:        Bash{command: "git status"}
07:29:18.980  tool_denied:         "Tool denied by Nexus policy: Bash"   ← 关键
07:29:18.980  result:              success=false
                                session.phase=failed
```

事件流里**没有** `permission_request`——这意味着 policy 评估阶段就 hard-deny 了，没走到 ask 通道。

---

## 2. 根因

### 2.1 默认 policy 是 hard-deny

`src/runtime/LocalCodingRuntime.ts:627-635`：

```ts
export function denyByDefaultTools(): ToolPolicy {
  return {
    isAllowed(tool) {
      return tool.risk === 'read' || tool.risk === 'task'
    },
    describe() {
      return { mode: 'allowlist', allowedTools: ['listdir', 'glob', 'grep', 'read', 'task'] }
    },
  }
}
```

`denyByDefaultTools()` 只放行 `risk === 'read'` 与 `risk === 'task'` 的工具。`Bash` 的 risk 是 `execute`，默认 hard-deny。

### 2.2 Hard-deny 路径跳过了 permission_request

`src/runtime/LocalCodingRuntime.ts:169-184`：

```ts
if (!this.toolPolicy.isAllowed(tool)) {
  const message = `Tool denied by Nexus policy: ${tool.name}`
  yield { type: 'tool_denied', ...eventBase(options.sessionId), name: tool.name, risk: tool.risk, message }
  yield { type: 'result', ...eventBase(options.sessionId), success: false, message }
  return
}
```

`isAllowed` 返回 false 时直接 `tool_denied` + `result(false)`，**没有**走 `permission_request` 流程。`permission_request`（`LocalCodingRuntime.ts:292`）只在工具已被 policy 放行、但被 runtime 的 approval gate 拦截时才发出。

### 2.3 Go TUI 用户没有 per-request tool policy override 入口

`src/nexus/app.ts` 的 `prepareExecution()` 路径（HTTP `app.ts:932+` / WebSocket `app.ts:2019+`）接收的 body schema：

```ts
{ prompt, cwd, sessionId, timeoutMs, skipPermissionCheck, maxToolOutputBytes, model, ... }
```

schema 里有 `skipPermissionCheck`（一次性绕过 approval gate），**没有** `allowedTools` 字段透传到 runtime policy。`createDefaultNexusRuntime`（`src/nexus/createRuntime.ts:90-100`）只在 Nexus 服务启动时根据 `options.allowedTools` 决定 policy，per-request 无法覆盖。

Go TUI 用户想跑 `git status` 唯一能做的就是：
- 重启 Nexus 改 server 启动配置（不现实）
- 在 Go TUI 端跳过整轮（UX 失败）

### 2.4 现状与"no silent permission changes"边界的关系

当前 hard-deny 行为**符合**"no silent permission changes"边界（用户没主动开 Bash 就不跑 Bash），但**违反了**"用户主动审批是开启 execute 工具的唯一路径"——因为 hard-deny 时用户连"审批"的机会都没有。这是边界字面遵守、实质未达成的灰区。

---

## 3. 泛化问题定义

### 3.1 Hard-deny vs Soft-deny vs Auto-allow

定义三种 permission gate 行为，按严格度从高到低：

| 行为 | 模型调工具时 | 用户体感 |
| --- | --- | --- |
| hard-deny | 立即 `tool_denied` + `result(false)` | 整轮 failed，模型看不到重试路径 |
| soft-deny | `permission_request` → 用户在面板 `a/n` | 用户主动决策；deny 时给工具返回 `tool_denied` + 友好 reason |
| auto-allow | 直接执行，不发 `permission_request` | 仅适用于 read-only 风险工具 |

当前 Nexus 政策：
- `risk === 'read'`（Read / ListDir / Glob / Grep）→ auto-allow
- `risk === 'task'`（Task / sub-agent）→ auto-allow
- `risk === 'execute'`（Bash）→ **hard-deny**（缺位）
- `risk === 'write'`（Write / Edit）→ soft-deny（走 approval gate）

### 3.2 三层心智模型错配

| 模型 | 谁配 policy | UX | 当前 Nexus 行为 |
| --- | --- | --- | --- |
| 运维式 | server 启动 `--allowed-tools` | 重启才能改 | `createDefaultNexusRuntime` 默认 `denyByDefaultTools()`，缺省配置 = hard-deny |
| 交互式 | 用户在面板 `a/n/r/esc` 即时决策 | 不离开终端 | 只对 `write` risk 工具走；`execute` 风险工具未启用 |
| 智能分级 | policy 自动识别 read-only vs write | 0 摩擦 | 当前**未实现**——Bash 不区分 `git status` 与 `rm -rf` |

Go TUI 是交互式客户端，最适合"智能分级 + soft-deny 兜底"模型。

---

## 4. 目标行为

1. **Read-only Bash subcommand 自动放行**：`git status` / `git log` / `git diff` / `git show` / `ls` / `cat` / `head` / `tail` / `wc` / `file` / `stat` / `find -type f` 等 read-only 命令不要求 `permission_request`。
2. **Write/Execute Bash 走 soft-deny + permission_request**：模型调 `rm` / `mv` / `git commit` / `npm install` 等命令时，发 `permission_request`，Go TUI 权限面板弹出供用户 `a/n/r/esc` 决策。**保留**用户拒绝时 `tool_denied` + 友好 reason，模型可继续后续推理。
3. **Per-request policy override**：Go TUI WebSocket body 支持 `policy: 'strict' | 'soft-deny'` 字段，默认 `'strict'`（保留 `bbl chat` 与 HTTP API 既有行为），Go TUI 启动时声明 `'soft-deny'`。
4. **CLI 路径不变**：`bbl chat`（CLI）继续走 `denyByDefaultTools()` + `skipPermissionCheck` flag，per-turn 不弹权限面板（per-process 一次性、用户已在终端前）。
5. **Bash 工具保留 Bash name 与 `execute` risk**：read-only subcommand 命中白名单时**不**改 `tool.name`，**不**降 `tool.risk`——审计日志与 transcript 仍能区分"用户跑了 bash 子命令"与"用户跑了 Read"，只是省了审批。

---

## 5. 非目标

- 不让 Go TUI 静默默认开启全部 execute 风险工具（与"write-capable child agent delayed"同口径）。
- 不让 per-request `policy` / `allowedTools` 升级为 session-global override（避免跨 turn 漂移）。
- 不在 Nexus 主路径上改变 `denyByDefaultTools` 默认 policy（避免影响 `bbl chat` 行为与 HTTP API 兼容）。
- 不引入 read-only subcommand 解析层到 `bbl chat`（CLI 路径保留 hard-deny；用户主动传 `--allow-tools Bash` 即可）。
- 不在本切片中实现 Bash 沙箱（`bwrap` / Docker / RemoteRunner）—— 那是更深一层的权限隔离，本规划只解决"为什么 Bash 调不出来"。
- 不让 child AgentLoop 继承 Go TUI 的 soft-deny policy（child agent 仍走 `denyByDefaultTools()`，与"write-capable child agent delayed"边界一致）。
- 不新增与现有工具重叠的新工具（不写 `BashRead` / `BashExec` 这种拆分工具）。
- 不把 permission_request 改成 batch / multi-select（保持一次一个，与现有 Go TUI 权限面板 UX 一致）。

---

## 6. 分阶段修复方案

### Phase A: Bash read-only subcommand 自动放行

状态：已实现。

落地点：

- `src/tools/builtin/bashClassifier.ts` 新建：纯函数 `classifyBashRisk(command)` 决定 `{ kind: 'read' | 'execute'; rule?; command }`。
  - 首 token + subcommand 解析（带 quote 处理的自写 tokenizer）
  - 允许的命令白名单：`git status/log/diff/show/remote/rev-parse/ls-files/tag`、`ls`、`cat`、`head`、`tail`、`wc`、`file`、`stat`、`readlink`、`realpath`、`pwd`、`echo`、`whoami`、`hostname`、`date`、`uname`、`env`、`printenv`、`ps`、`top`、`uptime`
  - git 拒绝的子命令黑名单：`push/commit/checkout/switch/reset/clean/rebase/merge/cherry-pick/revert/stash/apply/am/init/clone/fetch/pull/mv/rm/add`（注意 `branch` 故意**不在**白名单——`git branch -D` 是破坏性的，宁可强制 ask 也不要枚举所有 flag）
  - find 特殊处理：仅当含 `-type f` 且无 `-exec/-delete/-ok/-fprint/-fprintf/-fls` 时放行
  - 危险 pattern 二次校验（白名单 subcommand 命中后仍扫描）：`>>` 重定向、`>` 重定向、`<` 重定向、pipe-to-shell（`sh|bash|zsh|fish|ksh|ash|dash|python|python3|perl|ruby|node|php`）、command substitution（`$()` / `` ` ``）、`rm/mv/cp/mkdir/touch/chmod/chown/curl/wget/dd/mkfs/sudo/su/kill/killall/pkill/shutdown/reboot/npm install/yarn add/pnpm add/pip install/apt install/brew install/systemctl/launchctl`、最后才是 chain 模式（`;` `&&` `||`）—— 更具体的 pattern 排在前面以保证最具体的 rule 胜出
- `src/tools/builtin/bash.ts` `bashTool` 加 `riskForInput: (input) => classifyBashRisk(input.command).kind`——`bashTool.risk` 仍是 `'execute'`（保留审计身份），但 `riskForInput` 在白名单 subcommand 时返回 `'read'`
- `src/tools/Tool.ts` `ToolDefinition` 新增 `riskForInput?: (input: any) => ToolRisk` 字段（参数类型用 `any` 以解决 `ToolDefinition<TInput>` vs `AnyTool` 的函数参数 contravariance 问题；运行时 `effectiveRisk()` 内部 cast 回具体类型）
- `src/shared/events.ts` `ToolStartedEventSchema` 新增 optional `effectiveRisk` 字段（纯加法）；`ToolRisk` 用现有 `z.enum(['read', 'write', 'execute', 'task'])`
- `src/runtime/LocalCodingRuntime.ts`：
  - 新增 private `effectiveRisk(tool, input): ToolRisk` helper：调用 `tool.riskForInput?.(input)`，fallback 到 `tool.risk`；try-catch 包裹避免 override 抛错时炸 runtime
  - `if (!this.toolPolicy.isAllowed(tool))` hard-deny 路径改为 `if (effectiveRisk !== 'read' && !this.toolPolicy.isAllowed(tool))`——read-only subcommand 永远跳过 hard-deny
  - `if ((tool.risk === 'write' || tool.risk === 'execute') && !options.skipPermissionCheck)` approval gate 改为 `if ((effectiveRisk === 'write' || effectiveRisk === 'execute') && !options.skipPermissionCheck)`——read-only subcommand 永远跳过 approval gate
  - `tool_started` event 在 `effectiveRisk !== tool.risk` 时 attach `effectiveRisk` 字段
  - hook event（PreToolUse / PostToolUse / PostToolUseFailure / PermissionRequest）的 `toolRisk` 改用 `effectiveRisk`
  - permission_audit、tool_denied 事件的 `risk` 字段也用 `effectiveRisk`
  - hook 更新 input 后重算 `effectiveRisk`（hooks 可能改写 command 改变分类）
- `src/tools/registry.ts` `createDefaultToolRegistry()` 用 `tool as AnyTool` 解决 contravariance 报错

收口标准：

- ✓ focused test 覆盖白名单 subcommand（`git status` / `git log -5` / `ls -la` / `cat foo.txt` / `find . -type f` / `pwd` / `echo` / `whoami` / `date` / `uname` / `env`）放行且不触发 permission_request（`test/bash-classifier.test.ts`）
- ✓ focused test 覆盖黑名单擦边（`find . -type f -exec rm {} \;` / `find . -type f -delete` / `find . -type d`）升级回 execute 风险（`test/bash-classifier.test.ts`）
- ✓ focused test 覆盖白名单 subcommand 内的危险动作（`git status; rm -rf /` / `echo hello && curl http://evil`）通过 dangerous-pattern 二次校验拦截（`test/bash-classifier.test.ts`）
- ✓ 既有 regression 测试更新：`smart permissions: read-only Bash subcommands skip the approval gate entirely` / `smart permissions: workspace path safety blocks cat outside workspace` / `allowlisted runtime executes allowed tools and denies blocked tools` 三个测试改写以反映新语义

**Phase A 边界守住**：
- `bashTool.risk` 仍为 `'execute'`（不变），工具身份与 audit 日志保持一致
- `denyByDefaultTools()` / `allowAllTools()` / `allowlistedTools()` 三个 policy builder 签名未动
- workspace path safety 仍然在 bash tool 内部用 `findWorkspaceEscapeInCommand` 拦截，与 permission policy 是两层独立机制
- child AgentLoop 仍走 `denyByDefaultTools()`（不被 effectiveRisk 影响）
- `bbl chat`（CLI）行为未变——`denyByDefaultTools()` 默认值保留，per-process 一次性 CLI 用户走 `--allow-tools` flag

### Phase B: Soft-deny policy for Go TUI WebSocket

状态：Round 1 已落地（Go TUI 总是发 `policy: 'soft-deny'`，server 接受并透传到 runtime）。**Phase B 推进**（CLI 透传 `BABEL_O_CLI_POLICY_MODE`）已落地，详见本节末尾。

落地点（Round 1 — Go TUI WebSocket）：

- `src/nexus/app.ts:47-58` `executeSchema` 新增 `policy: z.enum(['strict', 'soft-deny']).optional()`（HTTP 与 WebSocket 共用 body schema）
- `src/nexus/app.ts:455-462` `CreateNexusAppOptions` 新增 `executePolicyMode?: 'strict' | 'soft-deny'`（server-side 默认值，per-turn 不发 policy 时兜底，默认 `'strict'` 保 back-compat）
- `src/nexus/app.ts:475` 读取 `executePolicyMode = options.executePolicyMode ?? 'strict'`
- `src/nexus/app.ts:957-961` `prepareExecution` 解析 `policyMode = body.policy ?? executePolicyMode`，准备回写
- `src/nexus/app.ts:919-928` `PreparedExecution` 类型加 `policyMode: 'strict' | 'soft-deny'`
- `src/nexus/app.ts:1086 + 2090` HTTP / WebSocket 两条 `runtime.executeStream()` 调用都透传 `policyMode: prepared.policyMode`
- `src/runtime/Runtime.ts:31-39` `RuntimeExecuteOptions` 新增 `policyMode?: 'strict' | 'soft-deny'`
- `src/runtime/LocalCodingRuntime.ts:202-228` hard-deny gate 改为 `if (effectiveRisk !== 'read' && !this.toolPolicy.isAllowed(tool) && options.policyMode !== 'soft-deny')`——`policyMode === 'soft-deny'` 时**仅 bypass** hard-deny，让 approval gate 自然触发 `permission_request`；approval gate 自身**不动**（既有 write/execute 风险工具已经走 permission_request 流程）
- `clients/go-tui/internal/tui/tui.go:27-42` `Config` 新增 `PolicyMode string` 字段
- `clients/go-tui/internal/tui/tui.go:5996-6014` `buildExecuteRequest` 总是附加 `policy` 字段（默认 `'soft-deny'`，可被 `Config.PolicyMode` 覆盖）

**核心设计点**：soft-deny 的实现**仅一行**——在 hard-deny gate 加一个 `&& options.policyMode !== 'soft-deny'`。approval gate 完全不动，因为它本来就会发 `permission_request`。这是"墙拆掉让既有管道接管"的最小改动设计。

收口标准（Round 1）：

- ✓ `test/runtime.test.ts` 新增 `execute honours per-request policy=soft-deny for write/execute tools`：mock Nexus，body 发 `policy: 'soft-deny'` + `bash "git commit -m x"`，断言事件流含 `permission_request`、无 policy-based `tool_denied`、用户通过 `/approve` 后工具正常执行
- ✓ `test/runtime.test.ts` 新增 `execute with default strict policy still hard-denies execute-risk Bash`：body 不发 `policy`（用 server-side `'strict'` 默认），Bash `git commit` 直接 hard-deny，无 `permission_request`（back-compat 守门）
- ✓ `clients/go-tui/internal/tui/tui_test.go` 新增 `TestBuildExecuteRequestEmitsSoftDenyPolicyByDefault`：默认 `Config` 调 `buildExecuteRequest` 含 `policy: 'soft-deny'`
- ✓ `TestBuildExecuteRequestHonoursExplicitPolicyMode`：`Config{PolicyMode: "strict"}` 时 payload 含 `policy: 'strict'`
- ✓ `TestBuildExecuteRequestEmitsPolicyAlongsideTimeoutMs`：`policy` 与 `timeoutMs` 独立字段并存
- ✓ `TestRunStreamEmitsSoftDenyPolicyAndHandlesPermissionRequest`：fake Nexus WebSocket，端到端验证 Go TUI 在 wire 上发 `policy: 'soft-deny'`、fake Nexus emit `permission_request` 后 `runStream` 透传到 consumer channel

**Phase B 边界守住**：
- server-side 默认 `'strict'`，`bbl chat` 与 HTTP API 既有客户端**完全 back-compat**（不发 `policy` → 走 `'strict'` → 行为与 Phase B 之前完全一致）
- Go TUI 默认发 `'soft-deny'`，但**只在 `policy: 'soft-deny'` 路径上**让 hard-deny bypass；既有 approval gate 行为完全不动
- approval gate 的事件 schema（`permission_request` / `permission_response` / `tool_denied`）**完全未改**——Go TUI 权限面板的 `a/y/n/r/esc` 流程零改动即可响应
- child AgentLoop 仍走 server 启动的 `executePolicyMode` 默认（默认 `'strict'`），不被 per-request `policy` 字段影响
- workspace path safety 仍由 `findWorkspaceEscapeInCommand` 拦截，与 permission policy 独立
- `bbl chat`（CLI）per-process 一次性行为未变

### Phase A.1: 增强权限面板（多选项 + session scope，Round 1 已落地；Round 2 编辑规则编辑器待推进）

状态：Round 1 已落地（多选项面板 + session-scope 规则累积 + wire format 扩展）。Round 2（"Approve with editable rule" 与 "Reject, tell the model what to do instead" 的内联文本编辑器）延后。

真实需求来自 Go TUI 端审批体验：原 a/y/n/r/esc 单按钮面板无法表达"放行本会话"和"放行特定子命令"两类典型诉求；用户实际工作流是「这次只跑一次」「这一类都跑」「这一类都跑但我改一下规则」「拒绝并改用 X」四类。Round 1 把 1-5 数字键 + 上下方向键 + Enter 确认 + Esc 取消 全部跑通；session-scope 选项把规则累积到 per-session map，下一次自动放行匹配的工具调用；不引入持久化、用户文件、provider 切换，规则进程内不跨重启。

落地点：

#### A.1.1 wire format 扩展（src/shared/events.ts）

- `PermissionRequestEventSchema` 增加 `suggestedRule?: string`，runtime 端在 `permission_request` 事件里 surface 来自 `deriveBashSuggestedRule(input)`（或工具自身的 `suggestedAllowRule`）的建议规则，例如 `git:status`、`cd:*`、`bash:*`。
- `PermissionResponseEventSchema` 增加 `scope?: 'once' | 'session' | 'rule'`、`rule?: string`、`feedback?: string`。三字段均 optional，**完全向后兼容**已有 HTTP/WS 消费者。
- `PermissionResolution` 类型（`src/shared/session.ts`）增加同名三字段，作为 `pendingPermission.resolve()` 的 payload。

#### A.1.2 runtime session-rules 累积（src/runtime/LocalCodingRuntime.ts）

- 类内新增 `private readonly sessionRules = new Map<string, string[]>()`。
- 公开方法 `addSessionRule(sessionId, rule)`：trim 后去重追加，空字符串丢弃。
- 测试 accessor `getSessionRulesForTest(sessionId)`：返回只读视图。
- `executeStream` 在派发前若 `sessionRules.get(sessionId)` 非空，wrap 一层 `buildSessionRulesPolicy(rules)` policy；该 policy 在 `isAllowed(tool, input)` 内做工具名+输入子串匹配：`git:status` → `tool.suggestedAllowRule==='bash'` 且输入含 `git status`。
- 审批 gate 拿到决策后判断：`approved && decision.scope === 'session' && decision.rule`，是则 `this.addSessionRule(...)`。
- `permission_response` 事件 yield 时把 `scope` / `rule` / `feedback` 透传（用 `...(value && {...})` 形式避免 undefined 序列化）。

**硬不变量：**

- 累积规则只能从 user-issued approvals 走；`policy: 'soft-deny'` 触发的隐式放行、`--allow-tools` 的 turn-boundary 放行、`skipPermissionCheck` 的 hard-bypass 一律不写 session rules。
- session rules **进程内不跨重启**（用 `Map<sessionId, string[]>`，不写 `~/.babel-o/` 也不进 storage）。
- 不修改 `denyByDefaultTools` / `allowAllTools` / `allowlistedTools` 的语义；新模式 `session_rules` 是独立的 `ToolPolicy.describe().mode`。
- `ToolPolicy.isAllowed` 签名扩展为 `(tool: AnyTool, input?: unknown): boolean`（旧 allow-all / allowlist 忽略 input 参数，行为不变）。

#### A.1.3 HTTP /approve 与 /deny（src/nexus/app.ts）

- `POST /v1/sessions/:sessionId/approve`：body schema 增加 `scope?: 'once' | 'session' | 'rule'`、`rule?: string`、`feedback?: string`；registry.resolve 调用的 `PermissionResolution` 透传。
- `POST /v1/sessions/:sessionId/deny`：body schema 增加 `scope` / `rule` / `feedback`（语义与 approve 一致，scope 通常省略）。
- 响应体 echo scope/rule/feedback（与请求对称）。

#### A.1.4 Go TUI 5 选项权限面板（clients/go-tui/internal/tui/tui.go）

- `pendingPermission` 增加 `suggestedRule string`；`permissionDecision` 增加 `scope / rule / feedback string`。
- 模型增加 `permissionChoice int` 字段；`consumeNexusEvent` 收到 `permission_request` 时重置为 0（避免上一轮遗留光标）。
- `modePermission` 键路由：
  - 数字键 `1`..`5` 直接跳到对应选项并确认。
  - `↑`/`↓` / `j`/`k` 移动光标（0..4 循环）。
  - `enter` 确认当前光标。
  - `esc` 维持旧语义（拒绝，无 feedback）。
  - 旧 `a`/`y`/`r`/`n` 保留为选项 1 / 4 的别名（肌肉记忆兼容）。
- `confirmPermissionChoice()` 把光标索引映射到 scope/rule/feedback 组合：
  - 0 → `scope: 'once'`，rule 空。
  - 1 → `scope: 'session'`，rule 取 `pending.suggestedRule`（无建议规则时回退 `'once'`，避免 `addSessionRule` 累积空串）。
  - 2 → `scope: 'rule'`，rule 同上（Round 1 与选项 1 等价；Round 2 接 inline textinput）。
  - 3 → `approved: false`，scope `'once'`，无 feedback。
  - 4 → `approved: false`，scope `'once'`，feedback 空（Round 1；Round 2 接 inline textinput）。
- `runStream` 的 WS `permission_response` payload 包含 `scope` / `rule` / `feedback`（omitempty）。
- `renderPermission` 渲染 5 行 `~ [N] <label>` 形式，header `Waiting for permission...`，新增 `Suggested rule: <rule>` 行（无规则时整行隐藏），底部 `▲/▼ select  1/2/3/4/5 choose  ↵ confirm  esc cancel`。

**硬不变量：**

- 选项 2 / 3 强制要求 runtime 提供了非空 `suggestedRule`；否则降级为 `scope: 'once'`，**绝不** 累积空规则。
- 选项 4 / 5 永远 `approved: false`；feedback 字段 Round 1 为空字符串（wire format 仍带 `feedback: ''` 字段，便于 Round 2 接入时零变更）。
- 旧 a/y/r/n 单击路径行为完全兼容（按键别名），旧 a/y 仍 `scope: 'once'`。
- 不引入额外依赖；不修改 `modeComposing` / `modeHelpOverlay` 等无关 mode。

#### A.1.5 测试矩阵

Nexus 端（`test/runtime.test.ts`）：

- `permission_request` 事件携带 `suggestedRule === 'git:status'`（Bash `git status` 命令）。
- turn 1 软拒绝通过 `POST /approve { scope: 'session', rule: 'git:status' }` → `getSessionRulesForTest(sessionId)` 包含 `'git:status'`；turn 2 不传 `allowedTools` 也 auto-allow 通过 `tool_completed`。
- `POST /approve { scope: 'once', rule: 'should-not-stick' }` 不写 session rules。

Go TUI 端（`clients/go-tui/internal/tui/tui_test.go`）：

- `TestPermissionPanelRendersFiveOptionsWithCursor` 验证 view 含 5 行 `~ [N] <label>` + `Suggested rule:` + 键盘提示。
- `TestPermissionChoiceArrowKeysCycleCursor` 验证 ↑/↓ 在 0..4 之间循环 wrap。
- `TestPermissionChoiceNumberKeysJumpAndConfirm` 验证 1-5 各自 confirm 走对的 scope/rule 组合。
- `TestPermissionRequestResetsChoiceCursor` 验证连续两次 `permission_request` 之间光标重置为 0。
- `TestPermissionPanelEscCancelsAsReject` 验证 esc 仍为 reject 且不累积 session rule。

收口标准（Round 1）：

- 5 选项面板渲染、键盘路由、scope/rule 字段透传全部回归通过。
- session rules 进程内不跨重启、不进 storage、不跨 session。
- wire format 增量字段全部 optional，旧 HTTP / 旧 WS 消费者零变更兼容。
- Round 2 收口标准（待推进）："Approve with editable rule" 与 "Reject, tell the model what to do instead" 两条路径分别挂 inline textinput，editor 退出后用编辑过的 rule / feedback 走 confirmPermissionChoice 同一分发路径。

#### A.1.6 Round 2 — Go TUI inline rule / feedback editor（已落地）

状态：已落地。Round 2 把"Approve with editable rule"与"Reject, tell the model what to do instead"两条路径从 Round 1 的「直接用 suggestedRule / 空 feedback 提交」升级为「内联文本编辑器：operator 编辑完再 confirm」。wire format 已经在 Round 1 准备好（`scope: 'rule'`、`feedback: string`），所以 Round 2 是纯 Go TUI 端改造，runtime 端零变更。

落地点（`clients/go-tui/internal/tui/tui.go`）：

- 新增两个 `inputMode`：`modePermissionEditRule`（选项 3 编辑规则）、`modePermissionEditFeedback`（选项 5 编辑反馈）。
- `enterPermissionRuleEditor()`：把 `pending.suggestedRule` 预填到 `m.input`，光标移到末尾，setMode 到 `modePermissionEditRule`。
- `enterPermissionFeedbackEditor()`：把 `m.input` 置空，setMode 到 `modePermissionEditFeedback`。
- `exitPermissionEditor(confirm bool)`：editor 退出唯一出口。
  - `confirm=true`（Enter）：规则编辑器走 `scope: 'rule'` + 编辑过的 rule（若清空则降级 `scope: 'once'`）；反馈编辑器走 `approved: false` + 编辑过的 feedback（若清空则降级纯 reject）。`m.input.SetValue("")` 始终清空避免泄漏。
  - `confirm=false`（Esc）：把光标恢复到 2/4（编辑前的位置），回到 5 选项面板；**不发**决策。
- `case modePermission:` 路由调整：键 `3` 与 `5` 不再 jump-and-confirm，改为进入对应 editor；光标 2 / 4 上的 `enter` 同样进入 editor。
- `case modePermissionEditRule, modePermissionEditFeedback:` 仅拦截 `esc` / `enter`；其余键 fall through 到 `m.input.Update(msg)`，由 textarea 自身处理字符插入与光标移动。
- 新增 `renderPermissionEditor(width)` overlay：标题 `Editing rule for <tool>` / `Editing feedback for <tool>`，重放工具 input 与 reason（让 operator 仍有上下文），规则编辑器多渲染一行 `Suggested rule: <rule>` 作为编辑参考，输入行 `  > <m.input.View()>`，底部 `↵ confirm   esc back to options`。
- `renderInput` 在 `modePermissionEditRule` / `modePermissionEditFeedback` 下隐藏底栏（与 `modeModelPickApiKey` / `modeModelPickBaseURL` 同模式），避免两层 input box 叠加。

**硬不变量：**

- 编辑器内 Esc **不**发决策（与 5 选项面板 Esc 行为不同——那里 Esc 是 reject，编辑器里 Esc 是"返回选项"）。
- 编辑器提交时 `m.input.SetValue("")` 永远先执行（避免下一条 composing 提示带上 editor 残留文本）。
- 编辑过的 rule 为空 → 降级 `scope: 'once'` 而 **不**累积空规则（与 Round 1 `addSessionRule` 行为一致）。
- 编辑过的 feedback 为空 → 降级纯 reject（模型仍收到 `permission_response` 拒绝，但 `feedback: ''` 不带任何"做什么替代"提示）。
- 不修改 `modePermission` 之外任何 mode；不修改 `modeComposing` / `modeHelpOverlay` / 任何 overlay 渲染。
- wire format 零变更：Round 1 已经把 `scope: 'rule'` 与 `feedback: string` 准备好，Round 2 只是在 TUI 端把这两个字段从"空 / 默认"升级为"operator 主动编辑"。

收口标准（Round 2，已落地）：

- 选项 3 / 选项 5 分别打开 inline rule / feedback editor；editor 内的 Esc 返回 5 选项面板（不发决策）；Enter 提交（编辑过的 rule / feedback 走 wire format 的对应字段）。
- editor 提交后 `m.input.Value()` 必须为空（防止下一条 prompt 残留）。
- 规则编辑清空 → 降级 `scope: 'once'`；反馈编辑清空 → 降级纯 reject。
- Go TUI 8 个新增 Round 2 测试全部通过：`TestPermissionOption3OpensRuleEditor` / `TestPermissionRuleEditorEnterCommitsEditedRule` / `TestPermissionRuleEditorEscReturnsToFiveOptionPanel` / `TestPermissionRuleEditorEmptyValueFallsBackToApproveOnce` / `TestPermissionOption5OpensFeedbackEditor` / `TestPermissionFeedbackEditorEnterCommitsFeedback` / `TestPermissionFeedbackEditorEmptyValueFallsBackToPlainReject` / `TestPermissionFeedbackEditorEscReturnsToFiveOptionPanel` / `TestPermissionEditorClearsInputOnExit`。
- Round 1 测试 0 回归（`TestPermissionChoiceNumberKeysJumpAndConfirm` 已更新为同时覆盖 1/2/4 jump-and-confirm 与 3/5 editor-open 两类语义）。

#### Phase B 推进：CLI 软拒绝透传（已落地）

状态：已落地。Round 1 让 Go TUI 写/执行工具走完 `permission_request`，但 `bbl chat` 嵌入模式（`LocalCodingRuntime.executeStream`）和 `bbl chat --url` 服务模式（WS payload）都不带 `policy` 字段，server-side 默认 `'strict'` 兜底，写/执行工具被 hard-deny 截胡——这正是用户报"Bash 仍然会有权限报错"的根因。Phase B 推进让 `bbl chat` 默认行为对齐 Go TUI（总是软拒绝），同时不改变 server-side 默认（HTTP API 既有客户端行为不变）。

落地点（仅 CLI 一侧，server.ts / `createNexusApp` 不动）：

- `src/cli/runSessionFlow.ts`：
  - **嵌入模式**（`runtime.executeStream` 调用，约 line 257）：`executeStream` options 显式带 `policyMode: resolveCliPolicyMode() ?? 'soft-deny'`，与 Go TUI 行为对齐。
  - **服务模式**（WS `socket.send` payload，约 line 86）：payload 显式带 `policy: cliPolicyMode`，行为对齐。
  - 新增 `resolveCliPolicyMode()` 纯函数：默认 `'soft-deny'`（对齐 Go TUI）；接受 `BABEL_O_CLI_POLICY_MODE=strict` 显式 opt-back-in 旧 hard-deny 行为；接受 `soft-deny` / `softdeny` / `soft_deny` / `SOFT-DENY` 大小写变体；未知值（含 typo）静默回退 `'soft-deny'`，**不**静默降级到 strict（避免 typo 误关软拒绝）。
- `test/run-session-flow.test.ts` 新增 3 个 focused 测试：
  - `resolveCliPolicyMode defaults to soft-deny to match Go TUI (Phase B 推进)`：env unset → `'soft-deny'`。
  - `resolveCliPolicyMode honours explicit strict opt-in`：`BABEL_O_CLI_POLICY_MODE=strict` → `'strict'`。
  - `resolveCliPolicyMode tolerates soft-deny variants and typos`：`SOFT-DENY` / `softdeny` / `soft_deny` 全部接受；`soft`（typo）静默回退 `'soft-deny'`。

收口标准（Phase B 推进）：

- `bbl chat` 嵌入模式（无 `--url`）写/执行工具能走完 `permission_request` 流程，不再被 `LocalCodingRuntime` hard-deny gate 截胡。
- `bbl chat --url <service>` 服务模式 WS payload 携带 `policy: 'soft-deny'`，与 Go TUI 行为对齐。
- server-side `executePolicyMode` 默认值仍为 `'strict'`，HTTP API 既有客户端行为不变（back-compat 守门）。
- `BABEL_O_CLI_POLICY_MODE=strict` 显式 opt-back-in 旧 hard-deny 行为（power-user 入口）。
- `npx tsc --noEmit` + `npm test` 全部回归通过；`test/run-session-flow.test.ts` 6/6 pass（3 旧 + 3 新）。

**未触动**：

- server.ts / `createNexusApp` / `executePolicyMode` server-side 字段未动 → server-side 默认仍 `'strict'`，HTTP API 既有客户端行为 back-compat。
- `LocalCodingRuntime` / `LLMCodingRuntime` 既有 hard-deny + approval gate 逻辑未动。
- `permission_request` / `permission_response` 事件 schema 未改。
- `provider fallback` / `auto model selection` 未触碰（按 memory `feedback-provider-quota-priority.md` + `babel-o-auto-model-selection-delayed.md` 仍延后）。
- `~/.babel-o/config.json` 测试污染守门未触碰（env var 读取用 `process.env.BABEL_O_CLI_POLICY_MODE`，test 用 `try/finally` 还原原值）。

### Phase C: 真实会话 regression fixture

状态：待实现。

落地点：

- `test/nexus-execute.test.ts`（或新建 `test/nexus-policy.test.ts`）新增：
  - `nexus execute with policy=soft-deny emits permission_request for Bash and continues on approval`：mock runtime emit Bash 调 `git status`，断言事件流含 `permission_request`，模拟 `permission_response: { approved: true }` 后 `tool_completed` 事件正常出现，session 终态 success。
  - `nexus execute with policy=soft-deny reports tool_denied on Bash denial`：同上但模拟 `permission_response: { approved: false, reason: 'no' }`，断言 `tool_denied` 事件 + `result(false)` + 模型后续 turn 可继续。
  - `nexus execute with policy=strict back-compat denies Bash without permission_request`：mock runtime emit Bash，断言 `tool_denied` 立即出现，无 `permission_request`。
- `clients/go-tui/internal/tui/tui_test.go` 新增：
  - `TestRunStreamRendersPermissionRequestWithRiskAndInput`：fake Nexus WebSocket emit `permission_request` 事件（`{type, toolName, risk, input, ...}`），断言 `formatNexusEvent` 渲染为 `Bash (execute risk)` 风格；eventually emit `permission_response` payload 验证 `sendPermissionDecision` 调用链（已有 Phase A 测试覆盖）。
  - `TestRunStreamDistinguishesToolDeniedFromPermissionRequest`：fake Nexus 在 `permission_request` 后 emit `tool_denied` 事件，断言 Go TUI 把 `tool_denied` 与"等待审批"清晰区分（避免面板被 deny 事件误关闭）。

收口标准：

- 端到端覆盖 `deny → ask → approve → execute` 与 `deny → ask → deny → tool_denied` 两条路径。
- Go TUI 端在 `permission_request` 抵达时正确进入 `modePermission`；在 `tool_denied` 后正确返回 `modeComposing`（不能误以为仍在审批中）。
- 不影响现有 `permission_request` 渲染与 `a/y/n/r/esc` 行为。

### Phase D: Go TUI `--allow-tools` flag（power-user opt-in）

状态：已实现。

落地点：

- `src/runtime/perRequestPolicy.ts` 新建独立模块（避免与 `LLMCodingRuntime` / `LocalCodingRuntime` 形成循环 import）：导出 `buildPerRequestAllowedToolsPolicy(allowedTools)`。镜像 server-startup policy 解析：`*` / `all` → `allowAllTools`；否则 → `allowlistedTools(allowedTools)`。
- `src/runtime/Runtime.ts:31-46` `RuntimeExecuteOptions` 新增 `allowedTools?: readonly string[]` 字段。
- `src/runtime/LLMCodingRuntime.ts:128-143` `executeStream` 在 `options.allowedTools` 非空时构造 override policy、用 `withToolPolicy` 包裹 inner body；body 抽到 `runExecuteStreamInner` 私有方法。
- `src/runtime/LocalCodingRuntime.ts:109-127` 同样的 wrapper 模式——**关键**：plan 之前只 wrap 了 `LLMCodingRuntime`，但 `createDefaultNexusRuntime` 默认走 local runtime，测试用 local runtime 跑时 `allowedTools` 实际未生效；这次把 LocalCodingRuntime 一起补上。
- `src/nexus/app.ts` `executeSchema` 新增 `allowedTools: z.array(z.string().min(1)).optional()`；`prepareExecution` 解析 `body.allowedTools` → `prepared.allowedTools`；HTTP + WebSocket 两条 `runtime.executeStream()` 调用都 spread `...(prepared.allowedTools && { allowedTools: prepared.allowedTools })`。
- `clients/go-tui/internal/tui/tui.go:42-50` `Config` 新增 `AllowTools []string` 字段；`buildExecuteRequest` 总是 trim / 空字符串过滤 / comma-split 后附加 `allowedTools` 数组（防御性处理程序化 Config 与 CLI flag 两种来源）。
- `clients/go-tui/cmd/go-tui/main.go` 加 `--allow-tools` flag（用 `flag.Func` 接收重复 + 逗号分隔；空字符串 trim / 跳过）。

收口标准：

- ✓ `test/runtime.test.ts` 新增 `execute honours per-request allowedTools for Bash in soft-deny mode`：mock Nexus + body `allowedTools: ['Bash']` + `policy: 'soft-deny'` + `bash "git commit -m x"` → Bash 在 allowlist 跳过 hard-deny + soft-deny 让 approval gate 发 `permission_request`；用户 `/approve` 后工具正常执行；事件流无 policy-based `tool_denied`。
- ✓ `test/runtime.test.ts` 新增 `execute with allowedTools scopes to a single turn`：两 turn 都用 `skipPermissionCheck: true` + 默认 strict 政策。第一 turn `allowedTools: ['Bash']` → Bash 不被 hard-deny（事件流无 policy `tool_denied`）。第二 turn 不发 `allowedTools` → 走 server-startup `denyByDefaultTools()` → Bash 被 hard-deny。证明 override 仅作用于当前 turn。
- ✓ `clients/go-tui/internal/tui/tui_test.go` 新增 4 个 `buildExecuteRequest` 测试：`TestBuildExecuteRequestEmitsAllowedToolsWhenConfigured`（含 `["Bash", "Edit"]`）、`TestBuildExecuteRequestOmitsAllowedToolsWhenUnset`（空 Config 不发）、`TestBuildExecuteRequestStripsWhitespaceAndEmptyFromAllowedTools`（trim + 跳过空 + 拆分逗号——"` Bash `", `",Edit,"`, `"  "`, `"Glob"` → `["Bash", "Edit", "Glob"]`）、`TestBuildExecuteRequestAllowlistWildcardPassesThrough`（`*` 透传不预翻译）。

**Phase D 边界守住**：
- `allowedTools` 仅作用于**当前 turn**：`withToolPolicy` 包裹确保 inner body 跑完 / 异常后 policy 自动 restore；下个 turn 重新评估
- **`*` / `all` 通配**：在 `buildPerRequestAllowedToolsPolicy` 翻译为 `allowAllTools`；与 server-startup policy 解析口径一致
- **`policyMode: 'soft-deny'` 与 `allowedTools` 正交工作**：`allowedTools` 决定哪些工具 *isAllowed*；`policyMode: 'soft-deny'` 决定不在 allowlist 的工具是否走 `permission_request` 而非 `tool_denied`（Phase B 行为）。两者组合：allowlist 内的工具跑（无 approval gate），allowlist 外的 execute 工具走 approval gate。
- **CLI flag 与 programmatic Config 统一**：`buildExecuteRequest` 内部 trim / 拆分 / 过滤空字符串，Go TUI 的 `--allow-tools` flag 解析与程序化 `Config{AllowTools: [...]}` 都产生同样的 wire payload。
- **`createDefaultNexusRuntime` server-side 默认未动**：所有 per-turn 改动都走 per-request 字段，与 `--execute-timeout-ms` / `policy` 既有模式对齐。
- **child AgentLoop 不受影响**：`runtimeAgentStep` 仍走 server-startup policy，不接受 per-request `allowedTools`。
- **避免循环 import**：`buildPerRequestAllowedToolsPolicy` 抽到 `src/runtime/perRequestPolicy.ts` 独立文件，不与 `LLMCodingRuntime` / `LocalCodingRuntime` 互相 import。

### Phase E: 文档与守门标准更新

状态：待实现。

落地点：

- `docs/nexus/TODO.md` 与 `docs/nexus/active/TODO_runtime.md` / `TODO_tui.md` 把 Bash policy 治理作为新 watch 项登记，状态标注 "Phase A-E 收口" / "watch-only"。
- `docs/nexus/DONE.md` 追加 Phase A + B + C 收口条目（Phase D / E 视落地情况）。
- `docs/nexus/WORK_LOG.md` 记录 2026-06-10 真实样本 `session_go_1781076550805204000` 的修复流水。
- `docs/nexus/reference/README.md` 把本文件登记到索引。

收口标准：

- TODO / DONE / WORK_LOG / reference/README 四份文档同步。
- 不引入新 reference 规划文件之外的文档（避免规划文件碎片化）。

---

## 7. 验证命令

```bash
# TypeScript 类型检查
npm run typecheck

# Bash policy 单元测试
npm test -- --runInBand test/nexus-policy.test.ts
npm test -- --runInBand test/agent-loop.test.ts

# Nexus execute 端到端
npm test -- --runInBand test/nexus-execute.test.ts
npm test -- --runInBand test/runtime.test.ts

# Phase A.1 增强权限面板 Nexus 回归（suggestedRule + session-scope 累积）
npx tsx --test --test-only test/runtime.test.ts -t "Phase A.1"

# Go TUI 端到端
cd clients/go-tui && go test ./internal/tui/...

# Phase A.1 增强权限面板 Go TUI 回归（5 选项渲染 + 键盘路由）
cd clients/go-tui && go test ./internal/tui/ -run "TestPermission" -v

# Phase A.1 Round 2 增强权限面板 Go TUI 回归（inline rule / feedback editor）
cd clients/go-tui && go test ./internal/tui/ -run "TestPermissionOption[35]Opens|TestPermissionRuleEditor|TestPermissionFeedbackEditor|TestPermissionEditor" -v

# Format check（只跑 check-only，不跑 auto-formatter）
npm run format:check
cd clients/go-tui && gofmt -l .

# 真实 Go TUI 慢 / Bash deny regression
BABEL_O_CONFIG_FILE=/tmp/babel-o-permission-policy-regression.json \
  npm run --silent dev -- go --check
```

注意：

- 只跑 check-only format 验证，不跑 broad auto-formatter。
- 真实 regression 必须用 `BABEL_O_CONFIG_FILE` 隔离 config，避免污染 `~/.babel-o/config.json`。
- 不在测试中调用真实 provider / 真实 LLM API；使用 mock runtime / mock provider。

---

## 8. 收口标准

Phase A + Phase B + Phase C 收口必须满足：

- Bash `git status` / `git log` / `git diff` / `ls` / `cat` / `head` / `tail` / `wc` / `file` / `stat` / `find -type f` 在 Go TUI `policy: 'soft-deny'` 下直接执行不弹权限面板。
- Bash `rm` / `mv` / `git commit` / `npm install` / `find -exec` / `dangerousPatterns` 命中时在 Go TUI `policy: 'soft-deny'` 下走 `permission_request` 流程。
- 用户拒绝时 yield `tool_denied` + reason，模型后续 turn 可继续（不破坏 turn 终态）。
- Go TUI `--allow-tools` opt-in 工作，turn 边界严格生效。
- `policy: 'strict'`（默认）下 Bash 行为与现状一致（back-compat）。
- `bbl chat`（CLI）行为未变；HTTP API schema 仅加法（`policy` / `allowedTools` 可选字段）。
- 主 Nexus 路径默认 policy mode 未改（保留 server 启动配置）。
- `denyByDefaultTools` / `allowAllTools` / `allowlistedTools` 三个 policy builder 签名不变。

Phase D / Phase E 收口必须满足：

- power-user `--allow-tools` flag + body 透传端到端可用。
- TODO / DONE / WORK_LOG / reference/README 四份文档同步。

Phase A.1 收口必须满足（Round 1）：

- Go TUI 权限面板渲染 5 行 `~ [N] <label>` 选项 + `Suggested rule: <rule>` 行（无规则时整行隐藏）+ 键盘提示行 `▲/▼ select  1/2/3/4/5 choose  ↵ confirm  esc cancel`。
- 数字键 1-5 跳转到对应选项并确认；↑/↓ 在 0..4 循环 wrap；enter 确认；esc 仍为 reject 路径。
- `permission_request` 事件携带 `suggestedRule` 字段（Bash 命令场景至少 `git:status` / `cd:*` / `bash:*`）；Go TUI 解析后正确填充 `pending.suggestedRule`。
- `POST /v1/sessions/:sessionId/approve` 接受 `scope: 'session'` + `rule: '<rule>'`，runtime 把规则写入 `sessionRules` map；下一次同 session turn 命中该规则时**不再弹权限面板**（auto-allow），即使 body 不传 `allowedTools`。
- `scope: 'once'` 永远不写 session rules；`feedback` 字段 wire format 透传（Round 1 留空字符串）。
- 旧 a/y/r/n/esc 行为完全保留（肌肉记忆兼容）；旧 HTTP / 旧 WS 消费者零变更。
- session rules **进程内不跨重启**（`Map<sessionId, string[]>`，不写 `~/.babel-o/`，不进 storage）。

Phase A.1 收口必须满足（Round 2 — inline rule / feedback editor）：

- 选项 3 / 选项 5 键按下时进入对应 inline editor（不直接 confirm）；editor 内的 `enter` 提交编辑过的 rule / feedback，`esc` 返回 5 选项面板（**不发**决策，光标恢复到 2 / 4）。
- 规则编辑器预填 `pending.suggestedRule`；反馈编辑器为空。`m.input` 在 editor 退出（无论 Enter / Esc）时 `SetValue("")`。
- 规则编辑器提交空值 → `scope: 'once'`（不累积空规则）；反馈编辑器提交空值 → 纯 reject（无 follow-up hint）。
- 提交后 `permissionDecision` 字段：rule 编辑 → `scope: 'rule'` + `rule: <edited>` + `feedback: ''`；feedback 编辑 → `approved: false` + `scope: 'once'` + `rule: ''` + `feedback: <typed>`。
- wire format 零变更（Round 1 已备好）；runtime 端零变更；HTTP / Nexus API 零变更。
- 8 个新增 Round 2 Go TUI 测试全部通过；Round 1 测试 0 回归。

---

## 9. 与其它 reference 文档的关系

- [go-tui-execute-timeout-governance-plan.md](./go-tui-execute-timeout-governance-plan.md)：本规划的下游。timeout 治理已收口（Phase A-E），本规划是"timeout 之外的另一类 Bash 拦截"——不重叠。
- [session-channel-tui-relationship-visibility-plan.md](./session-channel-tui-relationship-visibility-plan.md)：本规划不涉及 SessionChannel 关系可见化。
- [tool-granularity-and-evidence-governance-plan.md](./tool-granularity-and-evidence-governance-plan.md)：本规划不新增工具，不修改现有工具职责。
- [workspace-path-drift-governance-plan.md](./workspace-path-drift-governance-plan.md)：本规划不涉及工具失败归因。
- [go-runner-plan.md](./go-runner-plan.md)：本规划不涉及 Go RemoteRunner 切换；`policy: 'soft-deny'` 仅作用于 user-driven Go TUI session，不影响 server-side runner。

完成事实按 [../README.md 维护规则](../README.md) 写入 [../DONE.md](../DONE.md)。
