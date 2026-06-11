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

- `src/nexus/app.ts` `executeSchema` / WebSocket body schema 新增 `policy: z.enum(['strict', 'soft-deny']).optional()`，默认 `undefined`（按 `executeTimeoutMs` 同口径走 server-side default）。
- `src/nexus/app.ts` `prepareExecution()` 把 `body.policy` 透传到 runtime 构造参数。
- `src/runtime/Runtime.ts` `RuntimeExecuteOptions` 新增 `policyMode?: 'strict' | 'soft-deny'` 选项。
- `src/nexus/createRuntime.ts` 新增 `softDenyWithRequest()` policy 实现：当 `isAllowed()` 返回 false 且 `risk === 'execute'` 时，**不**直接 `tool_denied`，而是 yield `permission_request`（带工具名 / 输入 / reason），等待 Go TUI 发送 `permission_response` 后再决定：
  - 收到 `approved: true` → 正常执行工具
  - 收到 `approved: false` → yield `tool_denied` + reason，模型继续后续推理
  - 超时（10s） → 默认 deny，`tool_denied` + reason
- 默认 server-side policy mode = `'strict'`（保留 `bbl chat` / HTTP API 既有 hard-deny 行为）；Nexus 启动时可通过 `executePolicyMode` 构造选项改默认值。
- Go TUI 启动时按 `client: 'go-tui'` 自动声明 `policy: 'soft-deny'`（`cmd/go-tui/main.go` 与 `runStream()` 接线，见 Phase A 既有 `--execute-timeout-ms` 模式）。
- 注意：soft-deny 仅作用于 `risk === 'execute'`；`risk === 'write'` 已有软拒绝流程，不变。

收口标准（Round 1）：

- focused test 覆盖 `policy: 'soft-deny'` 下 Bash 调 `git status` 走到 `permission_request` 事件而非 `tool_denied`；Go TUI 模拟 `permission_response: { approved: true }` 后工具正常执行。
- focused test 覆盖 `policy: 'soft-deny'` 下 Bash 调 `git status` 后用户拒绝：yield `tool_denied` + reason，模型可继续后续 turn。
- focused test 覆盖 `policy: 'strict'`（默认）下 Bash 仍走 `tool_denied` 路径（back-compat）。
- focused test 覆盖 `policy: 'soft-deny'` 下 `Write` / `Edit` 工具仍走既有 approval gate 路径（不变）。

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

### Phase D: Go TUI `--allow-tools` flag（可选 opt-in）

状态：待实现（power-user 场景，非首要）。

落地点：

- `clients/go-tui/cmd/go-tui/main.go` 加 `--allow-tools` flag（多值，逗号或多次传入），默认空。
- 透传到 WebSocket body `allowedTools: string[]` 字段。
- `src/nexus/app.ts` `executeSchema` / WebSocket body schema 接受 `allowedTools: z.array(z.string()).optional()`。
- `src/nexus/createRuntime.ts` `createDefaultNexusRuntime` 在 per-request 路径上识别 `allowedTools`，临时构造 `allowlistedTools(allowedTools)` 覆盖默认 `denyByDefaultTools()` policy。
- **强约束**：`allowedTools` 仅对**当前 turn** 生效，下一轮 turn 重新评估（避免跨 turn 漂移，与 Phase A 既有 `--execute-timeout-ms` 模式对齐）。
- Go TUI `--allow-tools Bash,Edit` 用户体验：用户预先声明"我这次要 Bash + Edit 全部跳过审批"，模型调这些工具时直接执行不弹面板。

收口标准：

- focused test 覆盖 `--allow-tools Bash` 时 Bash 走 auto-allow（无 `permission_request`），其它工具（Write）仍走既有 approval gate。
- focused test 覆盖 turn 边界：第一次 turn 传 `--allow-tools Bash`，第二次 turn 不传，第二次 turn 的 Bash 重新走 policy 评估。
- focused test 覆盖 `--allow-tools` 与 `policy: 'soft-deny'` 共存：前者优先，allow-list 内的工具直接执行，allow-list 外的 execute 风险工具走 `permission_request`。

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

# Go TUI 端到端
cd clients/go-tui && go test ./internal/tui/...

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

---

## 9. 与其它 reference 文档的关系

- [go-tui-execute-timeout-governance-plan.md](./go-tui-execute-timeout-governance-plan.md)：本规划的下游。timeout 治理已收口（Phase A-E），本规划是"timeout 之外的另一类 Bash 拦截"——不重叠。
- [session-channel-tui-relationship-visibility-plan.md](./session-channel-tui-relationship-visibility-plan.md)：本规划不涉及 SessionChannel 关系可见化。
- [tool-granularity-and-evidence-governance-plan.md](./tool-granularity-and-evidence-governance-plan.md)：本规划不新增工具，不修改现有工具职责。
- [workspace-path-drift-governance-plan.md](./workspace-path-drift-governance-plan.md)：本规划不涉及工具失败归因。
- [go-runner-plan.md](./go-runner-plan.md)：本规划不涉及 Go RemoteRunner 切换；`policy: 'soft-deny'` 仅作用于 user-driven Go TUI session，不影响 server-side runner。

完成事实按 [../README.md 维护规则](../README.md) 写入 [../DONE.md](../DONE.md)。
