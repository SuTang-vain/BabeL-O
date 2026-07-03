# Providers

> 模块参考 · 稳定公开契约 · 深度架构见链接的治理文档

[English](providers.md)

## 角色

Providers 拥有模型 provider 注册表、adapter 工厂、重试逻辑与 SSE
管道。它枚举了哪些 LLM 后端可用、如何认证、如何在规范化
`ModelQueryParams` 与各 provider 的线缆格式之间转换，以及如何从瞬态故障中恢复——runtime
和 nexus 无需直接了解 provider 的协议细节。

## 公开契约

- **`ModelAdapter`** —— 抽象流式契约：
  `queryStream(params, options?) → AsyncIterable<StreamDelta>`。三个实现：
  `AnthropicAdapter`(anthropic-compatible)、`OpenAIAdapter`(openai-compatible)
  与 `LocalAdapter`(确定性 mock)。Adapter 由 `getAdapter()` 基于 provider 的
  `adapter` 类型选择。
- **`providerRegistry`** —— `ProviderDefinition[]`，包含 8 个已知
  provider（`local`、`anthropic`、`openai`、`moonshot`、`ollama`、`deepseek`、
  `zhipu`、`minimax`）。每个条目声明了 `id`、`displayName`、`adapter`、
  `authMode`（`api-key` / `bearer` / `none`）、`defaultBaseUrl`、`defaultModel`
  及 `models[]`。
- **`modelRegistry`** —— `ModelDefinition[]`，约 60+ 个模型。模型 ID 使用
  `provider/model` 格式。包含 `contextWindow`、`defaultMaxTokens` 及能力标记
  （`toolCalling`、`jsonOutput`、`streaming`）。
- **`getProvider(id)` / `getModel(id)`** —— 查找函数，未命中时抛出
  `UnknownProviderError` / `UnknownModelError`。
- **`inspectModelCapabilities(modelId, providerIdOverride?)` →
  `ModelCapabilityDiagnostics`** —— 返回 provider adapter、认证模式、模型
  context window、声明或未声明状态、能力来源及各 agent-loop 角色的适配性诊断。
- **`recommendModelForRole(role)`** —— 为给定 agent 角色（`planner` /
  `executor` / `critic` / `optimizer`）选择注册表中的最佳模型。runtime 会发出
  警告，但从不执行自动模型切换。
- **`withRetry(fn, config?)`** —— 指数退避封装器。仅在状态码为 `[429, 500,
  502, 503, 529]` 的 `ProviderError` 上重试。不可重试状态码及非
  `ProviderError` 异常直接抛出。
- **`parseSSE(stream, signal?)`** —— 将 `ReadableStream<Uint8Array>` 解析为
  SSE 事件。注册主动中止监听器以取消流 reader，防止静默或半开连接无限挂起。

## 允许的依赖

Providers 仅依赖 `shared`（从 `shared/errors.js` 导入 `ProviderError`）。它是
叶子模块，不得导入 `cli`、`nexus` 或 `runtime`。唯一反向边 `shared → providers`
（来自 `src/shared/config.ts`）在白名单中通过 CI 放行。

## 扩展点

- **注册新 provider** —— 在 `registry.ts` 的 `providerRegistry` 中添加条目。
  提供 `id`、`displayName`、`adapter`、`authMode`、`defaultBaseUrl`、
  `defaultModel` 及模型 ID。若 provider 使用新的线缆协议，实现新的
  `ModelAdapter`。
- **新增 adapter 类型** —— 实现 `ModelAdapter` 接口，将其类型加入
  `ProviderAdapter` 联合类型，并在 `getAdapter()` 中接线。
- **新增或调整重试策略** —— 修改 `retry.ts` 中的 `DEFAULT_RETRY_CONFIG`，
  或扩展 `withRetry` 以实现自定义退避策略。
- **自定义 SSE 处理** —— `parseSSE` 接受可选的 `AbortSignal`，可主动取消
  底层流。对于非标准 SSE 方言，可子类化或替换。

## 相关治理

- [Prompt-模型治理索引](../../nexus/reference/prompt-model-governance-index.md) —— provider/模型元数据、prompt 契约与禁止静默切换的读者入口。
- [模型目录与上下文元数据治理](../../nexus/reference/model-catalog-and-context-metadata-governance-plan.md) —— provider/模型元数据设计、context window 语义、未知模型回退策略。
- [Provider 流静默挂起中止传播](../../nexus/reference/provider-stream-silent-hang-abort-propagation-plan.md) —— SSE reader 取消、看门狗接线、Nexus 流循环中止竞态。
- [Runtime tool-loop 治理](../../nexus/reference/runtime-tool-loop-governance-plan.md) —— 工具循环中的可恢复 provider 错误、循环预算阈值。
- [层方向审计](../../nexus/reference/layer-direction-audit-enforcement-plan.md) —— 方向感知依赖门禁，含 `shared → providers` 反向边的白名单。
