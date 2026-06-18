# BabeL-O 常见问题（FAQ）

> 本文件面向用户和集成方，回答"装上 BabeL-O 之后，长期记忆 / MemoryOS 链路是
> 怎么启动和受控的"。所有结论对应 `src/nexus/everCoreConfig.ts`、
> `src/nexus/everCoreSidecar.ts`、`src/nexus/everCoreRuntimeManager.ts` 当前实现。
> 内部 `EverOS` / `EverCore` 模块名、`BABEL_O_EVERCORE_*` 环境变量、`everos-bootstrap.json`
> 等开发者表面继续保留;这里只展示用户能看到的"长期记忆"形态。

## Q1. 安装 BabeL-O 的时候，会自动安装长期记忆（MemoryOS）吗？

**不会。** BabeL-O 本身既不下载、也不打包、也不编译长期记忆服务。

- `npm install babel-o` / `pnpm add babel-o` 只安装 BabeL-O 自己的 JS 依赖。
- 仓库根目录没有 `scripts/install-*` 之类的引导脚本。
- `package.json` 的 `dependencies` / `optionalDependencies` 都不包含长期记忆后端
  二进制或 Python 运行时。

"长期记忆"链路是 **完全 opt-in** 的，默认行为是 `mode=disabled`，等价于"没有长期记
忆"。

## Q2. 如果我想要长期记忆，启动方式有几种？

`BABEL_O_EVERCORE_MODE` 决定模式，白名单取值见
`src/nexus/everCoreConfig.ts:418-425`：

| 模式 | 谁来启长期记忆 | 适用场景 |
|---|---|---|
| `disabled`（默认） | 不启 | 不需要长期记忆 / 想保持零外部依赖 |
| `external` | **你自己** 启好 | 你已经有常驻长期记忆（容器、systemd、远端） |
| `managed` | **BabeL-O runtime 启动那一刻** 拉起一个 loopback sidecar | 本地单机、想开箱即用 |

注意三种模式都要求长期记忆进程本身存在；BabeL-O **永远不会替你下载** 它。

## Q3. managed 模式下，"需要时启动记忆系统"具体在什么时候发生？

在 **每次 BabeL-O runtime 启动那一刻**（不是某个 turn 中途），由
`configureEverCore` → `startManagedEverCoreSidecar` 完成：

```text
CLI 启动 / bbl serve 启动 / npx babel-o ...
  └─ configureEverCoreFromEnv()         // src/nexus/everCoreConfig.ts:105
      └─ mode === 'managed' 时
          └─ startManagedEverCoreSidecar()  // src/nexus/everCoreSidecar.ts
              ├─ 读 dataDir/sidecar-registry.json 复用已有 sidecar（L2）
              ├─ 必要时 spawn BABEL_O_EVERCORE_MANAGED_COMMAND
              ├─ 等 /health 通过
              └─ 注册 dispose()，由 L3 idle-TTL 复用
```

启动失败 / health 不过时，runtime 不会崩，只会以 `healthy=false` 走降级路径：模型
看不到记忆写工具、不注入 capability block、`/v1/runtime/memory/status`
返回诊断。

## Q4. 我可以在安装 BabeL-O 的时候同时勾选下载长期记忆吗？

**当前版本：部分已实现。** BabeL-O **不会**在 `npm install` / `npm postinstall`
里替你下载（跨平台 TTY 不可靠，也不安全）。但 BabeL-O 已经在 **首次 `bbl` 启
动**（仅 TTY 交互环境）时提供 Crush 风格的 onboarding：

- 首次 `bbl chat`（无显式 `BABEL_O_EVERCORE_*` env、且无 bootstrap state）会提示：

  ```text
  本地长期记忆是可选功能。
  它会跑一个本地 MemoryOS sidecar,让 BabeL-O 在跨 session 时调用经你批准的笔记。
  记忆默认 disabled,永远不替代工作区事实。

  现在就启用本地长期记忆吗?
    1. 是 —— 本地 clone 并构建
    2. 否 —— 之后再说
    3. 我已经在别处跑
  ```

- 选 `[1]` 走 `git clone --depth 1` + `uv sync --frozen`,把 `managedCommand` 写进
  `~/.babel-o/everos-bootstrap.json`,`buildStatus: 'ready'`,后续 `bbl` 启动自动套
  managed 默认。
- 选 `[2]` 写 `optedOut: true`,**不再重复询问**(可手动 `bbl memory setup` 重启)。
- 选 `[3]` 写 `externalHintShown: true`,引导用户用 `BABEL_O_EVERCORE_MODE=external`
  接已部署的长期记忆。
- 缺依赖时,探测到 `brew` / `apt` 会显式提示 `brew install uv` 这种命令,**绝不**自
  动跑;非 TTY 直接跳过,绝不阻塞 `bbl chat` 启动。
- 失败不致命:写 `buildStatus: 'failed'` + `errorCode`,`bbl chat` 继续启动,后续
  `bbl memory setup --retry` 可重试。

新增 CLI:

```bash
bbl memory status                              # 打印 bootstrap + runtime memory 状态
bbl memory setup [--yes|--status|--retry|--reset|--auto-install-prerequisites]
bbl memory opt-out
bbl memory external
bbl memory reset
bbl memory auto [on|off|prompt]                # 后台自动 bootstrap 策略
bbl memory enable-tools | disable-tools        # 让模型可写/不可写
bbl memory doctor                              # 诊断
```

Go TUI `/memory` 面板新增 `Bootstrap:` 段,`/memory setup` 子命令指向 CLI 路径;
底部持久 `[m: ready]` / `[m: failed ⚠ …]` 指示器来自 `/v1/runtime/status` 轮询。

具体实现 + 验证命令见 [memory-governance-plan.md](./reference/memory-governance-plan.md) 和归档历史
[`everos-zero-friction-memory-startup-optimization-plan.md`](./archive/everos-zero-friction-memory-startup-optimization-plan.md),
相关产品线在
[`TODO_product_30day.md`](./active/TODO_product_30day.md) W2.5(状态:已实现并验证)。

> 仍 **未** 实现:`npm install` 阶段的勾选交互。`postinstall` 跨平台 TTY 不可靠,
> Crush 也是在 app 启动时询问,而不是在 install 阶段。如果未来要让"安装即拉取"
> 成为现实,正确路径是用 `bbl init` 取代当前 `bbl chat` 内的轻量 prompt,并在
> wizard 第 N 步把"是否拉取本地长期记忆 sidecar"作为可选分支。

## Q5. 我已经手动装好了长期记忆后端，怎么让 BabeL-O 用上？

最小 external 模式配置：

```bash
export BABEL_O_EVERCORE_MODE=external
export BABEL_O_EVERCORE_BASE_URL=http://127.0.0.1:<port>
export BABEL_O_EVERCORE_API_KEY=<everos-key>
# 可选：把 mcp:evercore:* 工具暴露给模型
export BABEL_O_ENABLE_EVERCORE_MCP_TOOLS=true
```

managed 模式最小配置（自备可执行文件）：

```bash
export BABEL_O_EVERCORE_MODE=managed
export BABEL_O_EVERCORE_MANAGED_COMMAND=/absolute/path/to/everos
export BABEL_O_EVERCORE_DATA_DIR=$HOME/.babel-o/everos-data
export BABEL_O_EVERCORE_LLM_PROTOCOL=anthropic-compatible   # 或 openai-compatible
export BABEL_O_EVERCORE_LLM_API_KEY=...
export BABEL_O_EVERCORE_LLM_BASE_URL=...
export BABEL_O_EVERCORE_LLM_MODEL=...
```

## Q6. 装上之后怎么确认记忆系统真的在跑？

两条最常用的路径：

- CLI / HTTP：`GET /v1/runtime/memory/status`，看 `status.healthy` 和
  `status.sidecar.reused` / `registryPath`。
- Go TUI：`/memory` slash 命令，sub-command 顺序为
  `status|search <query>|candidates|save <note>|flush|restart`（见
  `clients/go-tui/internal/tui/slash.go`），底部还有持久 `[m: …]` 指示器。

## Q7. 长期记忆的数据权威性是什么？

记忆结果 **不是事实源**。权重从高到低：

1. Workspace evidence / 工具返回 / SQLite session/event/tool trace —— 项目事实的
   权威来源。
2. MemoryOS 长期记忆 —— 背景提示，volatile、可能过期、可能 superseded、可能跨
   namespace 串味。
3. SessionChannel inbox —— 协作上下文，不是用户指令。

这条边界由 `docs/nexus/reference/memory-governance-plan.md`
和当前实现的 capability block 共同保障。
