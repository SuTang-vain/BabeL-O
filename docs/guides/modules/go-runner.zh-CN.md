# Go Runner

> 模块参考 · 稳定的公开契约 · 深层架构详见关联治理文档

[English](go-runner.md)

## 角色定位

Go Runner 是用 Go 实现的可选 `RemoteToolRunner` 执行后端。它在 TypeScript Nexus
的委托下执行已经过批准的工具调用——它**不**取代 Nexus 的执行宿主、上下文管理器、
权限策略、Agent 调度器、Provider 循环或 CLI。Go Runner 由环境变量开关控制，
在默认用户路径中完全不存在。

权限划分原则：

- **TypeScript Nexus** 决定哪个工具被允许、哪个 Session 拥有该调用、适用哪些权限、
  以及结果如何存储和回放。
- **Go Runner** 安全地执行 Nexus 已批准的内容：进程创建、超时/取消、输出配额强制执行、
  路径安全防御纵深，以及结构化结果指标。

## 公开契约

- **协议版本** `2026-06-04.babel-o.remote-runner.v1`——每个执行请求都必须携带协议版本；
  版本不匹配的请求会被拒绝并返回结构化 `REMOTE_RUNNER_PROTOCOL_MISMATCH` 错误。
- **`GET /v1/remote-runner/capabilities`**——返回 Runner 标识、已启用的工具集、
  只读状态以及服务端控制的限制（并发数、输出字节数、截止时间）。除非显式启用，
  Bash 和 Write/Edit 能力不会出现在返回结果中。
- **`POST /v1/remote-runner/execute`**——接收工具名称、工具输入（JSON）、
  session/request/tool-use 标识、`cwd`、`allowedPaths` 和执行边界参数。
  返回结构化的 `RunnerResult`，附带指标元数据（耗时、截断状态、退出码、信号、
  取消/超时标志）。
- **`POST /v1/remote-runner/cancel`**——尽力而为、幂等的取消操作，以
  `sessionId:requestId:toolUseId` 为键。针对活跃的 Bash 请求会杀死整个进程组。
- **工具面**——默认暴露 `ListDir`、`Glob`、`Grep`、`Read`。
  `GO_RUNNER_ENABLE_BASH=1` 启用 `Bash`；`GO_RUNNER_ENABLE_WRITE=1` 启用
  `Write` 和 `Edit`。所有工具执行在运行前都会校验能力集。
- **安全默认值**——绑定到 `127.0.0.1:3897`；没有 `GO_RUNNER_ALLOW_NON_LOCAL_BIND=1`
  时拒绝非回环地址绑定；服务端强制执行并发数硬上限（最大 16）、输出字节数硬上限
  （最大 1,000,000）和截止时间硬上限（最大 600,000 ms）。
- **Nexus 侧开关**——TypeScript `HttpRemoteToolRunner` 在配置了 `NEXUS_REMOTE_RUNNER_URL`
  时连接。`NEXUS_REMOTE_RUNNER_REQUIRED=0`（默认值）使 Runner 成为可选项；
  `NEXUS_REMOTE_RUNNER_REQUIRED=1` 在 Runner 不可达或能力不兼容时快速失败。

## 允许的依赖

Go Runner 是一个独立的 Go 模块（`github.com/babel-o/go-runner`，Go 1.22），
零外部运行时依赖。TypeScript 的 `deps:audit` 层级方向门禁不适用——这里的边界是
架构层面的，而非构建工具强制执行：

- Go Runner 依赖 Nexus 的 `RemoteToolRunner` 协议契约（HTTP/JSON 请求模式、
  响应格式、错误码、协议版本）。
- Go Runner **不得**导入 TypeScript 运行时包、调用 LLM Provider、读写 Nexus 存储、
  或组装 Session 上下文。
- Nexus 侧**不得**将执行权、权限决策、Session 所有权或存储事实委托给 Go Runner。
- 携带 Provider 凭证的环境变量（`BABEL_O_PROVIDER_*`）会通过显式的白名单
 （仅 `PATH`、`HOME`、`SHELL`、`TMPDIR`、`LANG`、`LC_ALL`）从 Bash 执行环境中
  过滤掉。

## 扩展点

- **添加新工具**——在 `internal/tools/` 中实现工具函数，在 `Execute` 分发
  switch 和 `SupportedTools`/`IsSupportedTool` 辅助函数中注册，然后在
  `internal/runner/server_test.go` 中添加处理器级别的测试。
- **添加 HTTP 路由**——在 `Server` 上新增 handler 方法，并在
  `internal/runner/server.go` 的 `Handler()` mux 中注册。
- **修改安全限制**——调整 `internal/runner/server.go` 中的 `ServerOptions` 默认值
  或硬上限常量（`hardMaxConcurrentTools`、`hardMaxOutputBytes`、`hardMaxDeadlineMs`）。
  对应的环境变量绑定在 `cmd/go-runner/main.go` 中。
- **接入新的执行环境**——协议已携带 `cwd`、`allowedPaths`、`maxOutputBytes`、
  `BashMaxBufferBytes` 和 `deadlineMs`。如需新字段，扩展
  `internal/protocol/types.go` 中的 `ExecuteRequest` 结构体。

## 关联治理

- [Go 客户端与分发治理索引](../../nexus/reference/go-client-distribution-governance-index.md) ——
  区分 Go TUI、Go Runner 与分发的所有权地图和治理规则。
- [Go Runner 计划](../../nexus/proposals/go-runner-plan.md) ——
  架构定位、分阶段发布（只读工具、受限 Bash、Worktree Write/Edit）、安全模型。
- [分发策略计划](../../nexus/reference/distribution-strategy-plan.md) ——
  发布渠道策略与长期 Go Launcher 方向。
- [工具治理计划](../../nexus/reference/tool-governance-plan.md) ——
  标准的工具分类与证据语义参考（Go Runner 执行已批准的工具类型；工具治理负责决定
  哪些工具存在及其所属类别）。
- [Runtime 工具循环治理](../../nexus/reference/runtime-tool-loop-governance-plan.md) ——
  Nexus 运行时层中向远程 Runner 分发的工具循环连续性和边界终结检查。
