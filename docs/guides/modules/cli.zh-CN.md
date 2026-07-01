# CLI

> 模块参考 · 稳定公开契约 · 深层架构见治理文档

[English](cli.md)

## 角色

`cli` 模块（`src/cli/`）拥有所有注册在 Commander 框架上的 `bbl <command>`
入口。它是面向用户的 TypeScript 交互层。在项目的第一设计铁律
"Nexus owns execution, CLI owns interaction"下，CLI 的职责严格限定为命令派发、
参数解析、输出格式化以及启动生产级 Go TUI 二进制文件（`bbl go`）。每个执行路径
要么委托给 Nexus（通过 `NexusClient` 或嵌入式组合），要么委托给 Go TUI 二进制文件；
CLI 绝不拥有 provider 循环、运行时 harness 或 session 真值。

TypeScript TUI（`bbl chat`）已在 v0.3.7 中移除。`bbl go` 是唯一的生产级交互入口；
Go TUI 二进制文件通过多路径发现策略定位并以子进程方式启动。`bbl run` 保留为一次性
非交互式回退。

## 公开契约

- **`bbl run <prompt>`** — 通过 Nexus（嵌入式组合或远程 URL）执行一次性编码提示。
- **`bbl go`** — 启动 Go TUI 二进制文件。仅为包装器：解析二进制路径（预构建/源码/
  环境覆盖），必要时自动启动托管 Nexus，创建或复用 session，生成子进程。
- **`bbl loop`** — 启动多窗格 bbl-loop 驱动（Go 二进制包装器，同 `bbl go` 的发现策略）。
- **`bbl nexus start|status`** — 管理本地 Nexus 守护进程。
- **`bbl sessions list|tree|show|events|inbox|ack|children`** — 通过 HTTP 检查
  持久化的 Nexus sessions。
- **`bbl config import-babel-x|add|list|use|profile...`** — 管理 provider 凭据、
  活动 profile、默认模型及 BabeL-X 导入。
- **`bbl models list|inspect`** — 从 provider registry 读取模型能力矩阵。
- **`bbl agents spawn|list|show`** — 通过 HTTP 管理 Nexus 代理任务。
- **`bbl tools audit`** — 列出已注册工具及当前允许策略。
- **`bbl optimize`** — 针对目标文件或目录运行自优化代理。
- **`bbl memory status|setup|opt-out|external|reset|auto`** — 管理 MemoryOS
  本地长期记忆引导生命周期。
- **`bbl doctor`** — 运行时健康自检（provider、密钥、记忆、端口）。
- **`bbl context working-set|working-set-edit|history|resume|assemble`** —
  离线检查上下文状态（工作集、行为轨迹、恢复预览）。
- **`bbl inspect-session <id>`** — 单个 session 的诊断深度检查（SQLite + 客户端
  日志分类）。
- **`bbl __server`**（隐藏）— 以守护式子进程方式启动 Nexus 服务。
- **`NexusClient`** — Nexus REST + WebSocket API 的 HTTP 客户端（跨需要远程操作的
  命令共享）。
- **`runSessionFlow`** / **`embedded.ts`** — `bbl run` 的嵌入式 Nexus 组合路径
  （直接导入 Nexus，绕过 HTTP 服务器）。

## 允许的依赖

CLI 位于项目层叠栈的最顶层。它可以通过显式允许列表（由
`scripts/audit-layer-direction.js` 和检入的 `scripts/layer-direction-allowlist.json`
强制实施）导入 `nexus`、`runtime`、`providers`、`tools` 和 `shared`。反向 ——
任何层导入 `src/cli/` —— 是 **禁止的**。

派生规则（来自层方向审计）：

- `nexus` → `cli` — **禁止**（Nexus 不能依赖任何交互层）。
- `runtime` → `cli` — **禁止**（运行时引擎不能依赖交互层）。
- `cli` → `{nexus,runtime,providers,tools,storage}` — 仅通过允许列表中的文件路径
  允许，每个路径都有文档化的理由。

详见
[Layer-direction audit](../../nexus/reference/layer-direction-audit-enforcement-plan.md)
和
[Module coupling governance](../../nexus/reference/module-coupling-decoupling-and-re-aggregation-plan.md)
的完整允许列表和耦合热力图。

## 扩展点

- **新增 `bbl <command>`** — 在 `src/cli/commands/xxx.ts` 中创建
  `registerXxxCommand` 函数，并在 `program.ts` 中导入。保持命令体精简：
  将执行委托给 Nexus（通过 `NexusClient`）、嵌入式组合路径（`runSessionFlow`）
  或生成的二进制文件。
- **修改命令注册** — `src/cli/program.ts` 是单一组合根。命令文件应可独立测试，
  且不应共享可变 CLI 状态。
- **远程与 Nexus 交互** — `NexusClient` 封装了 REST + WebSocket 接口。新端点
  应作为 `NexusClient` 的方法添加并由命令处理器消费。
- **诊断命令** — `bbl doctor` 和 `bbl inspect-session` 展示了离线健康检查的模式，
  无需运行 Nexus 即可直接读取存储或日志。

## 相关治理文档

- [Layer-direction audit](../../nexus/reference/layer-direction-audit-enforcement-plan.md) —
  方向感知依赖门禁，CLI 专用允许列表条目。
- [Module coupling governance](../../nexus/reference/module-coupling-decoupling-and-re-aggregation-plan.md) —
  耦合热力图，嵌入式组合路径，CLI 单例清单。
- [Go client & distribution index](../../nexus/reference/go-client-distribution-governance-index.md) —
  `bbl go` 作为生产级 TUI 包装器，Go TUI 所有权边界。
- [Distribution strategy](../../nexus/reference/distribution-strategy-plan.md) —
  便携包分发渠道，`bbl go --check` 安装验证。
- [Development process stability](../../nexus/reference/development-process-stability-governance-plan.md) —
  CLI 及依赖边界变更的 PR 审查级别。
