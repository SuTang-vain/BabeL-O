# Go TUI

> 模块参考 · 稳定公开契约 · 深度架构见链接的治理文档

[English](go-tui.md)

## 角色

Go TUI(`bbl go`)是 BabeL-O Nexus 的生产级交互客户端。它是一个独立 Go 二进制程序,
基于 Bubble Tea 构建,通过公开 HTTP 和 WebSocket API 连接 Nexus。Nexus 拥有执行、
上下文、权限、存储和会话状态;Go TUI 拥有终端布局、键盘路由、转录渲染、覆盖层、
本地输入状态、权限 UI 和本地斜杠命令。自 v0.3.7 起,它已成为唯一的生产 TUI
(TypeScript 版 `bbl chat` 已移除)。

配套二进制 `bbl loop` 提供多会话面板客户端,可同时可视化多个 Nexus 会话,但它
仍然是客户端——不得独立调度工作或成为第二个 AgentScheduler。

`bbl go` CLI 包装器可在目标 URL 不健康时自动启动本地 Nexus 进程。Go 二进制
程序本身只作为客户端运行,不直接读取 BabeL-O 配置文件。

## 公开契约

- **WebSocket `GET /v1/stream`** —— 核心执行流。Go TUI 将提示词提交为 JSON 载荷,
  并接收类型化事件(assistant、thinking、tool、permission、usage、result、error)。
  权限决定通过同一 WebSocket 通道返回。流式增量以稳定前缀渲染合并到当前转录行。

- **HTTP `GET /v1/runtime/config`** —— 后台轮询共享 Nexus 运行时配置变更
  (默认 30000 ms 间隔;`--poll-interval-ms=0` 可关闭)。支持 `?since=<version>`
  增量更新。

- **HTTP `POST /v1/runtime/config/select`** —— 在 TUI 中切换活动配置 profile
  或默认模型。

- **HTTP `GET /v1/sessions/:id/...`** —— 会话范围端点,用于 inbox、agents、
  tasks、context 分析和手动 compact。

- **HTTP `GET /v1/tools/audit`** —— 全局工具注册表快照,在工具审计覆盖层中渲染。

- **HTTP `GET /v1/skills`、`GET /v1/skills/:id`、`POST /v1/skills/validate`** ——
  从 TUI 执行技能列表、详情和验证。

- **本地斜杠命令**(`/config`、`/profile`、`/profiles`、`/context`、`/compact`、
  `/status`、`/tools`、`/tasks`、`/agents`、`/inbox`、`/skills`、`/model`、
  `/memory`)——由 Go TUI 客户端自身处理,绝不作为 agent 提示提交。

- **权限面板** —— 渲染 `permission_request` 事件,提供批准/拒绝键盘操作。
  通过 `--allow-tools` 实现每轮工具允许列表(权限策略治理规划的 Phase D)。

- **版本兼容性** —— 启动时检查 `GET /v1/runtime/version`,确保服务端/客户端
  契约对齐。

## 允许的依赖

Go TUI 是独立 Go 模块(`github.com/sutang-vain/babel-o/clients/go-tui`),对
Nexus 源码树无 TypeScript 导入依赖。其依赖均为终端渲染的 Go 库:

- **Bubble Tea v2**(`charm.land/bubbletea/v2`)—— 应用框架、事件循环、渲染。
- **Lip Gloss v2**(`charm.land/lipgloss/v2`)—— 样式定义。
- **Bubbles v2**(`charm.land/bubbles/v2`)—— 可复用组件(spinner、textarea、viewport)。
- **Gorilla WebSocket**(`github.com/gorilla/websocket`)—— 到 Nexus `/v1/stream`
  的 WebSocket 传输。
- **Ultraviolet**(`github.com/charmbracelet/ultraviolet`)—— 转录代码块的语法高亮。

TypeScript 的 `deps:audit` 层方向门禁不适用于 Go 代码。架构边界是行为上的:
Go TUI 不得拥有运行时真相。它不得抓取 SQLite、解析 provider 或工具内部实现,
也不得在客户端内重复运行时逻辑。所有运行时拥有的状态(会话、事件、工具、
provider、权限、存储、agent 编排)都仅通过 Nexus API 端点访问。

## 扩展点

- **新增覆盖层** —— 在 `internal/tui/` 中按现有覆盖层模式创建文件
  (如 `overlay_activity.go`、`overlay_tools.go`),并接入 model 的 update/view
  循环。

- **新增本地斜杠命令** —— 扩展 `internal/tui/tui.go` 中的命令路由器;保持
  其无状态且从 TUI 视角只读(写命令通过 Nexus API 调用)。

- **改进转录渲染** —— 渲染管线(`renderTranscript` / `formatLine` /
  `renderInlineMarkdown`)位于 `internal/tui/tui.go`。任何渲染改进不得改变
  事件语义。

- **新增 Nexus API 消费方** —— 在 `internal/tui/api.go` 中按 `nexusJSON` /
  `nexusRawJSON` 模式创建辅助函数。保持超时有界(默认 10 s),并通过现有友好
  错误管道显示错误。

- **扩展权限面板** —— 面板位于 `internal/tui/permission_dialog.go` 和
  `internal/tui/permission.go`。权限策略本身仍由运行时拥有。

## 相关治理

- [Go 客户端与分发治理索引](../../nexus/reference/go-client-distribution-governance-index.md) ——
  Go TUI、`bbl loop`、Go Runner 和分发治理的读者入口。
- [分发策略计划](../../nexus/reference/distribution-strategy-plan.md) ——
  发布渠道策略、便携式包、未来 Go launcher。
- [Go TUI 会话可观测性治理规划](../../nexus/proposals/go-tui-session-observability-governance-plan.md) ——
  会话可检查性、嵌入式 Nexus 持久化、session ID 映射。
- [Go TUI Markdown 渲染优化规划](../../nexus/proposals/go-tui-markdown-rendering-optimization-plan.md) ——
  转录 Markdown 和代码块渲染路线图。
- [Go TUI 历史记录](../../nexus/history/go-tui-history.md) ——
  已关闭的实现上下文、权限面板演化、回归记录。
