# Go TUI `/model` 模型持久化规划

> Status: 规划中（协议层 + 客户端 state machine + 测试均未落 commit）
> Priority: P1 — 与 §5 路径 C 阶段 2 持久化主题同档，但当前没有"真实会话 regression"驱动，按规划先行、regression-first 验证
> 关联: §5 路径 C 阶段 2（`POST /v1/runtime/config/select` profile 切换落地）— 本规划在同一端点上扩展 `model` 字段

---

## 1. 背景

Go TUI 通过 `/model` 多步流程（commit `5012d98`）让操作员在终端内挑选 provider / api-key / base-URL / model 四步组合，**视觉上**立刻把 `m.modelID` 切到新模型并在 header 反映出来。但视觉切换背后是 in-memory only 写入：

- `clients/go-tui/internal/tui/tui.go:2135-2144`（`case modeModelPickModel` Enter 分支）：

  ```go
  case "enter":
      if provider != nil && m.modelPickSelectedIdx >= 0 && m.modelPickSelectedIdx < len(provider.Models) {
          selectedModel := provider.Models[m.modelPickSelectedIdx]
          m.appendLine("status", fmt.Sprintf(
              "selected model: %s (provider %s, model writeback is CLI-only in Phase 1; "
              "run `bbl config use %s` or `bbl chat /model` to persist)",
              selectedModel.ID, provider.ID, selectedModel.ID))
          m.modelID = selectedModel.ID
          m.setMode(modeComposing)
      }
  ```

- `m.modelID = selectedModel.ID` 只改了 struct 字段，**没有**任何 HTTP 调用、**没有**磁盘写入
- transcript 状态行文案自己写明 `"model writeback is CLI-only in Phase 1"` —— 这是设计文案，不是 bug

TUI 启动时 `m.modelID` 的来源是 `fetchRuntimeConfig(m.cfg, 0)`（`GET /v1/runtime/config`），server 把 `resolveSettings()` 的结果回过来、`applyRuntimeConfig(msg.config)` 里 `m.modelID = config.ModelID`。所以**服务器说什么就是什么**；TUI 内的 `/model` 选择从来没回写过 server。

### 1.1 用户体感

操作员在 `bbl go` 内跑了 `/model` → 选了一个新模型，看到 header 立刻切过去了。下一个 turn 真去调 LLM 时，server 端用的还是 `defaultModel` / `activeProfile.model` 解析出来的那个，跟 header 不一致。重启 `bbl go` → TUI 重新走 `fetchRuntimeConfig` → header 退回 server 真相。

具体表现：
- "我刚刚切到 `anthropic/claude-3-5-sonnet` 了，怎么还是 `openai/gpt-4o` 在回"
- "切完关掉 `bbl go` 重开，又变回原来那个"
- "我懒得切回 `bbl chat` 跑 `bbl config use`，能不能在 Go TUI 里直接切了落盘"

### 1.2 当前三条切换路径对比

| 路径 | 视觉切换 | 持久化 | 跨 `bbl go` 重启保留 |
|------|---------|--------|---------------------|
| `bbl config use <model-id>`（CLI） | ❌ TUI 端不感知 | ✅ 写 `~/.babel-o/config.json` 的 `defaultModel` | ✅ |
| `bbl chat /model <model-id>`（TypeScript chat TUI） | ✅ | ✅ 走同一份 config | ✅ |
| `bbl go` 内部 `/model` → Step 4 | ✅ header 立刻变 | ❌ 仅 `m.modelID` 内存字段 | ❌ |

> 备注：操作员在 Step 2 / Step 3 临时输入的 `apiKey` / `baseURL` **同样**不落盘，只在 `m.modelPickProviderDraft` 内存字段里，commit `5012d98` 阶段就是按"视觉切换 + 持久化走 CLI"做的。本规划**只**解决 `model` 字段持久化，api-key / base-URL 留待后续单独 PR（涉及加密落盘、env 优先级合并，更广的合约面）。

---

## 2. 根因

### 2.1 Nexus 端 `/v1/runtime/config/select` 当前契约

`src/nexus/app.ts:765-787`（HEAD = `ea61d41`）：

```ts
app.post('/v1/runtime/config/select', async (request, reply) => {
  const body = runtimeConfigSelectSchema.parse(request.body ?? {})
  const manager = ConfigManager.getInstance()

  if (body.model || body.role || body.roleModel) {
    return reply.code(400).send({
      error: 'not_supported',
      message: 'model / role / roleModel switching is not supported in this endpoint; use `bbl config` CLI',
    })
  }
  ...
}
```

`model` 字段被无条件拒。Zod schema `runtimeConfigSelectSchema`（`app.ts:97-101`）原本就接受 `model: z.string().optional()`、只是 handler 强拒。

§5 路径 C 阶段 2 commit（`DONE.md:196` 收口说明）当时的边界是：
> "避免远程 TUI 绕过 CLI 配置治理"

这条边界**仍然有效** —— 远程客户端不应静默修改 profile / role 治理面。但 `defaultModel` 是另一类状态：
- `defaultModel` 已经在 `config.ts:572-576` 暴露 `setDefaultModel(model: string)` 给 `bbl config use` 走
- 它是**单值**切换，不涉及 profile 治理 / tombstone / role 路由
- 切换 `defaultModel` 与 `bbl config use` 在 CLI 路径上的行为完全等价

所以扩展 `config/select` 接受 `model` 字段是**单值状态切换**，与"profile / role 治理"不是同一类约束。

### 2.2 TUI 端缺 Step 4 提交 state machine

`modeModelPickModel` Enter 分支（`tui.go:2135`）是**同步**路径：本地 `m.modelID = ...` + `setMode(composing)` + return `nil, nil` 退出 picker。要让它发 HTTP 请求，需要：
- 一个**异步** Cmd 工厂（参考 `selectRuntimeProfile`，`tui.go:6388+`）
- 一个**响应 msg** 类型（参考 `profileSelectMsg`，`tui.go:213-218`）
- 一个**in-flight 锁**防止双击 / 双键入重复发请求
- 渲染层在 in-flight 期间**不显示列表**（picker 选完就进入 saving 态），esc 仍允许退出当前 step（server 请求 fire-and-forget 后通常 < 50ms 落盘）

参考既有 profile 切换的实现是 `modeProfileConfirm` + `pendingProfileName` + `selectRuntimeProfile`，与 model switch 在 state machine 形态上完全平行。

### 2.3 `resolveSettings()` 优先级：active profile shadow

`src/shared/config.ts:578-720` 的 resolve 链：

```text
1. options.model  (per-request override)
2. BABEL_O_MODEL env
3. profile.roles[role]
4. profile.model
5. conf.defaultModel
6. 'local/coding-runtime' 兜底
```

`setDefaultModel(model)` 写入 `conf.defaultModel`（`config.ts:572-576`），**不影响** `conf.profiles[active].model`。

也就是说：

| active profile 是否存在 | `defaultModel` 切换后实际生效于 |
|------------------------|-------------------------------|
| 无 active profile | ✅ 下一个 turn 用新 model |
| 有 active profile（model 字段被 profile 锁住） | ❌ 下一个 turn 仍用 `profile.model` |

这是**已存在**的 server 端行为，commit `5012d98` 之前的 `bbl config use` 也走这条路径 —— 操作员在有 active profile 的前提下 `bbl config use <new-model>` 同样不会"自动切走"。这不是本规划引入的 regression，但本规划**必须**在 UI 上明确呈现，否则操作员切完 model 后看到 header 没变（或下一次 fetchRuntimeConfig 拉回的 modelId 不是新选的）会困惑。

Go TUI 启动 / poll 时 `GET /v1/runtime/config` 走 `resolveSettings()`，response 是 server 的真实决议结果；UI 显示这个真实值就不会撒谎。

---

## 3. 目标行为

1. **Step 4 提交真持久化**：Go TUI `modeModelPickModel` Enter → `POST /v1/runtime/config/select {model: <id>}`，server 调 `manager.setDefaultModel(<id>)`、落 `~/.babel-o/config.json`、返回 `inspectResolvedRuntimeConfig(manager)`。
2. **失败可视化**：网络 / 4xx / 5xx / 未知 model → transcript 报错、留在 picker（不让操作员误以为已切）、esc 退回 baseURL step。
3. **In-flight 锁**：picker 期间 Enter 第二次按 → no-op（避免双 POST）。esc 仍允许退出 step。
4. **Header 真实反映**：响应里的 `modelId` / `providerId` 通过 `applyRuntimeConfig` 落 `m.modelID` / `m.providerID`，下一次 `fetchRuntimeConfig` 也带回同一值。**不**做 header 假象。
5. **路径互斥**：`/v1/runtime/config/select` 同时接 `profile` 和 `model` → 400 `mutually_exclusive`；`role` / `roleModel` 仍走 `not_supported`（CLI-only）；`model` 不在 `modelRegistry` → 400 `unknown_model`。
6. **三层视觉反馈**：进入 in-flight → spinner + "saving model: …"；成功 → "model saved: <display> → <id> (provider <id>)" + 回 composing；失败 → "<err>" + 留 picker。

---

## 4. 非目标

- **不**改 `bbl chat` 或 `bbl config use` 行为；新协议路径与 CLI 路径语义完全等价
- **不**新增独立 `POST /v1/runtime/model/select` 端点；复用 `config/select`，让"make this active"是单一动词
- **不**改 `resolveSettings()` 优先级；`activeProfile.model` shadow `defaultModel` 是既有 server 行为，本规划**不**为此引入"切 model 时自动清 active profile"逻辑（避免越权改 profile 治理面）
- **不**触碰 auto model selection / provider fallback / role default；按 memory `feedback-provider-quota-priority.md` + `babel-o-auto-model-selection-delayed.md` 仍延后
- **不**在本切片中持久化 Step 2 / Step 3 输入的 api-key / base-URL；`modelPickProviderDraft` 继续 in-memory only，落到磁盘走 `bbl config profile` / env 优先级
- **不**让 Go TUI 直接读 / 写 `~/.babel-o/config.json`；所有持久化继续走 Nexus HTTP
- **不**改 `runtimeConfigSelectSchema`（已接受 `model: z.string().optional()`）；只在 handler 拆 `profile` / `model` 互斥分支
- **不**写自动重试 / 离线队列；操作员重启 `bbl go` 后再选一次即可

---

## 5. 协议层修复（Phase 1）

### 5.1 Nexus handler 拆三态

`src/nexus/app.ts`（handler at line 765）改为：

```text
输入 = {}                                          → 400 missing_field
输入 = { profile }   + active profile 是 tombstoned → 400 tombstoned_profile (已有)
输入 = { profile }   + profile 不存在              → 400 unknown_profile (已有)
输入 = { profile }                                → manager.setActiveProfile(profile)  (已有)
输入 = { model }    + model 不在 modelRegistry    → 400 unknown_model
输入 = { model }                                  → manager.setDefaultModel(model)
输入 = { profile, model }                         → 400 mutually_exclusive
输入 = { role | roleModel }                       → 400 not_supported (已有)
```

收口标准：

- `POST /v1/runtime/config/select` 接受 `model`，调用 `manager.setDefaultModel`
- role / roleModel 仍拒
- profile 与 model 互斥
- 未知 model 报 `unknown_model`，错误体里回传 `model` 字段供客户端诊断
- 已存在 profile 路径不变（back-compat）

### 5.1.1 当前 handler 摘录（`app.ts:765-787`）

```ts
app.post('/v1/runtime/config/select', async (request, reply) => {
  const body = runtimeConfigSelectSchema.parse(request.body ?? {})
  const manager = ConfigManager.getInstance()

  if (body.model || body.role || body.roleModel) {
    return reply.code(400).send({
      error: 'not_supported',
      message: 'model / role / roleModel switching is not supported in this endpoint; use `bbl config` CLI',
    })
  }

  if (!body.profile) {
    return reply.code(400).send({ error: 'missing_profile' })
  }

  if (manager.isProfileTombstoned(body.profile)) {
    return reply.code(400).send({
      error: 'tombstoned_profile',
      profile: body.profile,
      tombstone: manager.getTombstones()[body.profile],
    })
  }

  if (!manager.hasProfile(body.profile)) {
    return reply.code(400).send({ error: 'unknown_profile', profile: body.profile })
  }

  manager.setActiveProfile(body.profile)
  return inspectResolvedRuntimeConfig(manager)
})
```

### 5.2 配套测试 (`test/config-endpoints.test.ts`)

- 改 `rejects model / role switching (CLI-only)` → 改名 `rejects role / roleModel switching (CLI-only)`，只验 `role` / `roleModel`
- 加 `rejects empty / missing field with 400`：`{}` 与 `{model: ''}` 走 `missing_field`
- 加 `rejects profile + model at the same time`：互斥
- 加 `switches default model and persists`：无 active profile → resolved `modelId == new`；fresh `ConfigManager` 读同一文件 `getDefaultModel() == new`
- 加 `model switch preserves an active profile binding`：有 active profile → resolved `modelId == profile.model`（**不**被新 model 覆盖），`getDefaultModel() == new` 持久化
- 加 `rejects unknown model with 400`：`{model: 'definitely/not-a-model'}` → 400 `unknown_model`

---

## 6. TUI 客户端修复（Phase 2）

### 6.1 数据 + Cmd

`clients/go-tui/internal/tui/tui.go`：

- `model` struct 加 `modelPickSubmitting bool` 字段（in-flight 锁）
- 加 `modelSelectMsg{ modelID string; config runtimeConfig; err error }` 响应类型（与 `profileSelectMsg` 对偶，`tui.go:213-218`）
- 加 `selectRuntimeModel(cfg Config, modelID string) tea.Cmd`（`tui.go:6388` 旁边）：
  ```go
  func selectRuntimeModel(cfg Config, modelID string) tea.Cmd {
      return func() tea.Msg {
          var payload runtimeConfig
          err := nexusJSON(cfg, http.MethodPost, "/v1/runtime/config/select",
              map[string]string{"model": modelID}, &payload)
          return modelSelectMsg{modelID: modelID, config: payload, err: err}
      }
  }
  ```

### 6.2 Step 4 Enter 分支

`case modeModelPickModel` / `case "enter"`（tui.go:2135）改为：

```go
case modeModelPickModel:
    provider := m.currentModelProvider()
    ...
    // in-flight 期间锁 picker：esc 仍允许退出当前 step
    if m.modelPickSubmitting {
        if key == "esc" {
            m.setMode(modeModelPickBaseURL)
        }
        return m, nil
    }
    switch key {
    ...
    case "enter":
        if provider == nil || m.modelPickSelectedIdx < 0 || m.modelPickSelectedIdx >= len(provider.Models) {
            return m, nil
        }
        selectedModel := provider.Models[m.modelPickSelectedIdx]
        m.modelPickSubmitting = true
        m.appendLine("status", fmt.Sprintf("saving model: %s (provider %s)…", selectedModel.ID, provider.ID))
        return m, selectRuntimeModel(m.cfg, selectedModel.ID)
    }
```

注意：`selectedModel.ID` 来自 `GET /v1/runtime/models` 响应，Nexus 端用 `provider/models[i].id` 直接透出 `modelRegistry` 里的 canonical `provider/model` 字符串，所以**不需要**在 TUI 端做 `provider.ID + "/" + model.ID` 拼装。

### 6.3 `case modelSelectMsg` Update handler

```go
case modelSelectMsg:
    m.modelPickSubmitting = false
    if msg.err != nil {
        m.appendLine("error", "model select: "+msg.err.Error())
        return m, nil   // 留 picker，操作员可重选 / esc
    }
    m.applyRuntimeConfig(msg.config)
    display := firstNonEmpty(msg.config.ModelName, msg.modelID)
    m.appendLine("status", fmt.Sprintf(
        "model saved: %s → %s (provider %s)",
        display, msg.config.ModelID, firstNonEmpty(msg.config.ProviderID, "?")))
    // 重置 picker 临时状态，下一次 /model 从 provider list 开始
    m.modelPickSelectedIdx = 0
    m.modelPickSelectedID = ""
    m.modelPickProviderIdx = 0
    m.modelPickProviderDraft = ""
    m.modelPickerLive = nil
    m.setMode(modeComposing)
    return m, nil
```

`applyRuntimeConfig`（`tui.go:4874+`）会做 `m.modelID = config.ModelID` / `m.providerID = config.ProviderID` / `m.configVersion = config.Version` / header chrome 重算等，下一次 `fetchRuntimeConfig` poll 会带回同一值（version 不变则 304，变则更新）。

### 6.4 渲染：in-flight 期间

`renderModelPickModel` 紧贴 `modelPickerLoading` 分支后加：

```go
if m.modelPickSubmitting {
    lines = append(lines, "  "+m.spinner.View()+"  saving model…")
    lines = append(lines, "")
    lines = append(lines, mutedStyle.Render("  esc back to base URL (request still in flight)"))
    return renderOverlayFrame(width, strings.Join(lines, "\n"))
}
```

### 6.5 配套测试 (`tui_test.go`)

3 个新 Go test：

- `TestModelPickStep4EnterFiresSelectCommand` — Enter 返回 `tea.Cmd` 非 nil、`modelPickSubmitting=true`、`m.modelID` **不**变、transcript 含 `saving model:`；再按 Enter cmd 为 nil（picker 已锁）
- `TestModelSelectMsgAppliesConfigAndClosesPicker` — 喂成功 `modelSelectMsg{config: {ModelID, ModelName, ProviderID, Version: 7}}` → `modelPickSubmitting` 清零、`m.modelID` 切到新值、`configVersion=7`、`inputMode=modeComposing`、transcript 含 `model saved:` + `provider <id>`
- `TestModelSelectMsgErrorStaysInPicker` — 喂 `modelSelectMsg{err}` → `modelPickSubmitting` 清零、`m.modelID` **不**变、`inputMode` 不变、transcript 含错误文本

---

## 7. UX Caveat：active profile shadow

> 必须在 Go TUI 的 transcript / overlay 文案里点明，否则操作员困惑。

当操作员有 active profile（CLI 创建、`bbl config profile use <name>`、或 `bbl go` 启动时 server 返回的 `activeProfile`），并且该 profile 的 `model` 与 TUI `/model` Step 4 选的不一致时：

- **真实行为**：server `resolveSettings()` 在有 active profile 时优先用 `profile.model`，新写入的 `defaultModel` **不**生效
- **header 反映**：下一次 `fetchRuntimeConfig` 拉回的 `modelId` 是 `profile.model`，**不是** Step 4 选的；header 文字会从"刚才选的新模型"回到"profile 锁住的模型"
- **解决路径**（不进本切片）：
  1. 操作员 `/profile <other>` 切到一个不锁 model 的 profile（或 `bbl config profile use` 切回 default profile）
  2. 操作员 `bbl config profile delete <name>` 删除锁住 model 的 profile
  3. 未来扩展：`/model` 检测到 active profile 且 `profile.model != selected` 时弹 y/n overlay，选项"clear active profile too"（Phase 3+，不属本切片）

**收口底线**：本切片不做 y/n overlay、不自动清 profile、不改 `resolveSettings()`。操作员看到 header 退回时通过 transcript 状态行 `model saved: <selected>`（已是事实）+ 下一次 poll 回 `modelId: <profile.model>`（也是事实）自我理解。如果觉得这是 P1 的 UX 阻断，则升级为 P0 单独 PR。

---

## 8. 分阶段推进

### Phase 1：Nexus 协议层
状态：未启动

- 改 `src/nexus/app.ts:765` handler 拆三态
- 改 `test/config-endpoints.test.ts` 6 条测试
- `npx tsc --noEmit` 干净
- `node --import tsx --test test/config-endpoints.test.ts` 22/22

### Phase 2：TUI 客户端
状态：未启动（依赖 Phase 1）

- `tui.go` 加 `modelSelectMsg` / `selectRuntimeModel` / `modelPickSubmitting`
- Step 4 Enter 分支 dispatch cmd
- `case modelSelectMsg` Update handler
- `renderModelPickModel` 加 saving 态
- `tui_test.go` 3 个新单测
- `go test ./...` 干净
- `go vet ./...` 干净
- 重编 binary

### Phase 3：PTY smoke（可选）
状态：未启动（依赖 Phase 2）

- `test/go_tui_pty_driver.py` 新 `run_model_persistence_sequence`：bash echo 触发 `session_started` → `/model` → 选 provider → 选 model → 等 `model saved:` → 重启 TUI → 验 header modelId 是新选的
- 挑战：PTY 序列里需要 pre-seed `BABEL_O_CONFIG_FILE` 让 default model 与新选不同（避免"`local/coding-runtime` → `local/coding-runtime`"这种 no-op）
- 评估成本后再决定是否入 `all` orchestrator（避免长 orchestrator 不稳定）

### Phase 4：DONE 收口
状态：未启动

- 写 `docs/nexus/DONE.md` 收口条目（commit hash + 文件列表 + 测试覆盖 + 验证命令）
- 同步 `docs/nexus/reference/README.md` 索引（本 doc 仍在 reference，但加一句"implementation slice landed 2026-XX-XX, see DONE.md:NNN"）
- 同步 `docs/nexus/active/TODO_tui.md` 把 "P2 / model persistence" 从未收口项移到"已收口"

---

## 9. 风险与对策

| 风险 | 概率 | 影响 | 对策 |
|------|------|------|------|
| 协议改动破坏 §5 路径 C 阶段 2 既有 `bbl config use` / `bbl chat /model` 路径 | 低 | 高 | 阶段 1 测试套件不删旧 case，profile 路径完全 back-compat；`setDefaultModel` 是 `ConfigManager` 既有 API |
| 操作员在有 active profile 时 `/model` 切了但下次 poll header 退回 | 中 | 中 | 7 节 UX caveat：transcript 显式声明 `model saved:`，文档化，不进本切片解决 |
| 双 Enter 触发双 POST | 低 | 低 | 6.2 节 in-flight 锁（`modelPickSubmitting` 期间 Enter → no-op） |
| Network 5xx → picker 永久卡在 saving 态 | 低 | 中 | `case modelSelectMsg` err 路径**先**清 `modelPickSubmitting`、再 appendLine error；picker 重回可操作 |
| 未知 model 漏到 Nexus | 低 | 低 | 5.1 节 handler 5 行查表（`modelRegistry.some(entry => entry.id === modelId)`），test 覆盖 |
| 远程 TUI 借此绕过 profile 治理 | 低 | 高 | 4 节非目标：`{profile, model}` 互斥；role / roleModel 仍 `not_supported`；active profile shadow 仍由 server 侧 `resolveSettings()` 守住 |
| Step 2/3 输入的 api-key / base-URL 落盘需求被顺带提出 | 中 | 中 | 4 节非目标：本切片只切 model，credentials 走单独 PR |

---

## 10. 验证命令

实施完成后预期：

```bash
# Nexus 协议层
npx tsc --noEmit
node --import tsx --test test/config-endpoints.test.ts   # 22/22
npm test                                                  # 既有 727/727

# TUI 客户端
cd clients/go-tui
go test ./...                                             # 既有 + 3 新 = 154+/154+
go vet ./...
go build -o bin/go-tui ./cmd/go-tui

# PTY smoke (Phase 3, 可选)
BABEL_O_RUN_GO_TUI_SMOKE=1 npm run test:go-tui:smoke      # 19/19 + model-persistence
```

操作员手动验收（`bbl go`）：

```text
/model                                  # 进 picker
# Step 1 选 openai（假设已 configured）
# Step 3 接受默认 baseURL
# Step 4 选 gpt-4o → Enter
→ "saving model: openai/gpt-4o (provider openai)…"
→ "model saved: gpt-4o → openai/gpt-4o (provider openai)"
→ 回 composing，header 立即显示 gpt-4o

# 重启验证
Ctrl-C → bbl go
→ 启动时 header modelId = openai/gpt-4o  ← 持久化生效
```

---

## 11. 关联文件

- `src/nexus/app.ts:765-807` — 当前 handler（拒 model）
- `src/nexus/app.ts:97-101` — `runtimeConfigSelectSchema`（已接受 `model` 字段）
- `src/shared/config.ts:572-576` — `ConfigManager.setDefaultModel`
- `src/shared/config.ts:578-720` — `resolveSettings` 链（决定 profile shadow 行为）
- `src/providers/registry.ts:92-190` — `providerRegistry`（model id canonical 形式）
- `clients/go-tui/internal/tui/tui.go:2135` — Step 4 Enter 分支
- `clients/go-tui/internal/tui/tui.go:6388` — `selectRuntimeProfile` 模板
- `clients/go-tui/internal/tui/tui.go:213-218` — `profileSelectMsg` 模板
- `clients/go-tui/internal/tui/tui.go:4874+` — `applyRuntimeConfig`（响应里 modelId 落点）
- `clients/go-tui/internal/tui/tui.go:6576` — `nexusJSON` HTTP helper
- `test/config-endpoints.test.ts:154-172` — 既有 "rejects model / role" 测试
- `docs/nexus/reference/session-finalization-and-evidence-governance-plan.md` — 类似的"现状 + 根因 + 阶段 + 测试"叙事模板
- `docs/nexus/reference/go-tui-permission-policy-governance-plan.md` — 类似的"协议 + 客户端联合修复"先例
- `docs/nexus/DONE.md:196` — §5 路径 C 阶段 2 收口说明（既有的 profile 切换落地）
- `docs/nexus/active/TODO_tui.md:81` — `P2 Advanced CLI/TUI` 段落（`provider role defaults/fallback` 延后项的位置）

---

## 12. 维护规则

- 实施切片 commit 时拆 `feat(nexus): ...` + `feat(go-tui): ...` 两个 commit，与既有 §5 路径 C 阶段 2 的多 commit 模式一致
- 测试 commit 单独走 `test(nexus): ...` / `test(go-tui): ...`，便于 bisect
- 实施完成后按 [DONE.md 维护规则](../DONE.md) 写入收口条目，并把本 doc 的 Status 改为 "Phase 1+2+3 全部已落地（治理收口）"
- 7 节 UX caveat 若 Phase 3+ 决定做"切 model 时清 active profile" y/n overlay，**另起**本 reference doc 的姊妹 doc，不在本 doc 内增量
