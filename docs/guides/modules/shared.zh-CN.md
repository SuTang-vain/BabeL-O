# Shared

> 模块参考 · 稳定公开契约 · 深层架构参见关联治理文档

[English](shared.md)

## 角色

Shared 是整个项目的叶子（leaf）基础模块。它定义了事件模式（41 个事件类型的
`NexusEvent` 受鉴别联合体，基于 Zod）、共享类型定义（`SessionSnapshot`、
`NexusTask`、`TaskStatus`、`AgentJob`、`SessionChannel`、`ToolTrace`、
`BabelOConfig`、`ErrorCodes`）、标识辅助函数（`createId`、`nowIso`）、错误
类（`NexusError`、`ProviderError`）和工具模块（`logger`、`parseSocketQuery`、
`validateSecurityConfig`、`getBashFileDiscoveryGuidance`）。所有其他模块
（`nexus`、`runtime`、`providers`、`tools`、`storage`、`mcp`、`skills`、
`cli`）都从 shared 导入；Shared 自身不得从任何项目内部模块导入——除下方
一条已允许列表的反向边之外。

## 公开契约

- **`NexusEventSchema` / `NexusEvent`** — 基于 Zod 的受鉴别联合体，包含
  41+ 个事件类型（`session_started`、`assistant_delta`、`thinking_delta`、
  `user_message`、`user_intake_guidance`、`usage`、`tool_started`、
  `tool_completed`、`tool_denied`、`task_created`、`result`、`error`、
  `execute_summary`、`near_timeout_warning`、`timeout_budget_exceeded`、
  `timeout_extension_granted`、`task_session_event`、`agent_job_event`、
  `permission_request`、`permission_response`、`hook_started`、
  `hook_completed`、`hook_failed`、`compact_boundary`、
  `context_compact_boundary`、`compact_failure`、`context_warning`、
  `context_blocking`、`context_usage`、`context_microcompact`、
  `context_recovery_attempted`、`context_grounding_required`、
  `context_grounding_confirmed`、`workspace_dirty_detected`、
  `task_scope_declared`、`session_root_continuity`、
  `scope_boundary_detected`、`scope_boundary_confirmed`、
  `session_memory_updated`、`memory_retrieval`、`execution_metrics`、
  `cache_health`）。Skill 事件（`skill_matched`、`skill_invoked`、
  `skill_validation`、`skill_saved`）在 `skillEvents.ts` 中并存类型定义，
  但有意排除在主联合体之外。`events.ts` 为手写（非代码生成）；代码生成
  为长期耦合债务跟踪项。

- **`SessionSnapshot`** — 会话状态形状，供存储、序列化和 HTTP/WS 响应使用。

- **`NexusTask` / `TaskStatus`** — Nexus 调度和 agent 循环使用的任务模型。

- **`BabelOConfig` / `ConfigManager`** — 配置类型和管理类
  （`ConfigManager.getInstance()` 单例 + 实例化路径）。`ConfigManager` 是
  唯一跨越叶子边界的 shared 模块：它导入 `providers/registry.ts` 用于
  provider/model ID 的 Zod 校验。该边已列入层方向审计的允许列表。

- **`NexusError` / `ProviderError` / `ErrorCodes`** — 跨所有模块共享的
  标准化错误类型和字符串码常量。

- **`AgentJob` / `AgentJobStatus`** — 子 agent 调度、工作树隔离和治理
  强制使用的 agent 任务模型。

- **`SessionChannel` / `SessionMessage`** — 会话间消息传递的类型模型。

- **`ToolTrace`** — 单次工具调用的执行记录形状。

- **`createId(prefix)` / `nowIso()`** — ID 生成和时间戳辅助函数。

- **`logger`** — 结构化日志器，支持 `silent | error | warn | info | debug`
  级别，由 `NEXUS_LOG_LEVEL` 控制。

- **`validateSecurityConfig`** — 主机 + API 密钥的安全校验。

- **`parseSocketQuery`** — 与框架无关的 WebSocket 查询字符串解析器。

- **`getBashFileDiscoveryGuidance`** — 启发式指引，将 `ls` / `find` /
  `grep` / `tree` 命令引导至原生工具。

## 允许的依赖

Shared 是叶子模块——除了唯一一条已列入允许列表的反向边外，不得从任何
项目内部模块导入：

- 允许所有第三方依赖（`zod`、`node:fs`、`node:path`、`node:os`、
  `node:crypto`）。
- `src/shared/config.ts` 导入 `src/providers/registry.ts`，用于 Zod 模式
  校验 provider/model ID。该反向边已明确列入
  `scripts/layer-direction-allowlist.json`，由层方向审计强制执行
  （规则 4：`shared → outside`）。
- 所有其他 shared 文件仅导入 `node:*` 模块、第三方包或 `src/shared/` 内
  的其他文件。

参见
[层方向审计](../../nexus/reference/layer-direction-audit-enforcement-plan.md)
了解允许列表细节和强制机制。

## 扩展点

- **添加新事件类型** — 在 `events.ts` 中创建新的 Zod 模式，使用不重复的
  `type` 字面量，将其加入 `NexusEventSchema` 的
  `z.discriminatedUnion('type', [...])`，并导出推断类型。更新
  `LLMCodingRuntime` 中手写的 `mapEventsToMessages` 翻译逻辑。Skill 域
  事件请将模式添加到 `skillEvents.ts`。

- **添加错误码** — 向 `ErrorCodes` 追加新常量并导出。所有消费模块通过
  现有 switch/case 模式处理新码。

- **添加共享工具** — 在 `src/shared/` 下创建新文件。确保仅导入 `node:*`
  模块、第三方包或其他 `src/shared/` 文件。任何向 `src/shared/` 外部的
  导入都需要层方向审计允许列表条目。

## 相关治理

- [模块耦合治理](../../nexus/reference/module-coupling-decoupling-and-re-aggregation-plan.md) —
  耦合热力图、`shared/events.ts` 代码生成计划、`ConfigManager` 单例转
  注入的路线图。
- [层方向审计](../../nexus/reference/layer-direction-audit-enforcement-plan.md) —
  方向感知的依赖闸门；shared 唯一一条已允许列表的反向边。
- [上下文治理索引](../../nexus/reference/context-governance-index.md) —
  上下文警告、上下文阻塞、上下文用量、紧凑边界和内存检索事件家族的事件
  分类法。
