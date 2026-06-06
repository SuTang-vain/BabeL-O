# TODO Provider / Model Registry

## 目标

Provider / Model Registry 统一多厂商模型配置、认证方式、能力元数据、adapter 行为和 Agent role routing。本文只保留 provider/model 仍未收口的开发项；已完成 provider、adapter、diagnostics 与回归能力移入 [DONE.md](../DONE.md)。

## 当前状态

- Registry、config CLI、models CLI、Anthropic-compatible / OpenAI-compatible / Local adapter、Zhipu/MiniMax/DeepSeek/OpenAI/Anthropic seed、usage/error 归一、provider diagnostics、provider smoke、fallback plan API 已落地。
- MiniMax text-encoded tool call、DeepSeek reasoning replay、tool/structured capability gate、role model override、request model 优先级已落地并有测试覆盖。
- Runtime/provider diagnostics 与 `bbl models inspect` 已复用 registry 模型能力口径，展示 provider adapter/auth mode、context/default max tokens、tool/json/structured/streaming、long-context、AgentLoop role suitability 与 undeclared custom model 提示。
- 自动模型选择、默认 role model 推荐与显式 fallback 执行入口已无限期 delay；需要时再恢复，当前不作为 P1/P2 开发目标。
- Provider seed 已补齐 Moonshot 与 Ollama/local OpenAI-compatible；当前主要缺口只剩后续从真实 smoke 样本继续沉淀 adapter regression。provider-specific error body 与 role structured output provider-neutral failure metadata 已收口，自适应上下文上限诊断已对齐 registry 模型窗口和 cache-aware policy。

## Delayed Indefinitely: Auto Model Selection / Fallback Execution

- [ ] 自动模型选择、默认 role model 推荐与显式 fallback 执行入口无限期 delay；需要时再恢复。
  - 不继续推进未配置 roles 时的 Planner/Executor/Critic/Optimizer 默认模型推荐。
  - 不继续推进 provider recovery 的自动/半自动模型、provider、profile 切换执行入口。
  - 保持现有安全底线：不得静默切换模型/provider/profile，`allowSilentModelSwitch=false`。
  - 若未来恢复，本项必须重新进入总控优先级，并先明确用户确认 UX 与配置审计口径。

## 已收口 Runtime Model Capability Diagnostics

基于 `registry.ts` 的 `contextWindow` / `defaultMaxTokens` / capabilities 输出 runtime 模型差异诊断已落地：`inspectModelCapabilities()` 输出 provider adapter/auth mode、registry declaration、capability source、context window、default max tokens、tool/json/structured/streaming、long-context 与 AgentLoop role suitability；`ConfigManager.getProviderDiagnostics()`、runtime status/provider smoke 与 `bbl models inspect` 复用同一口径。unknown/custom provider-scoped model 允许通过配置，但能力声明为 `undeclared` 保守占位并提示“不做强拦截”。

## 已收口 Context Ceiling Diagnostics Follow-up

自适应上下文上限诊断已统一使用 registry 模型窗口与 cache-aware policy：context analysis、CLI `/context`、context warning/blocking events、execution_metrics side table 与 `/v1/runtime/metrics` 都会透出 `model.contextWindow`、reserved output、provider safety buffer、legacy/effective ceiling、`BABEL_O_MAX_CONTEXT_TOKENS` hard cap、policy source、warning/compact/blocking threshold 与 cache-preserving/long-context 模式。legacy 120k ceiling 仍作为兼容/保守策略常量保留，但用户可见诊断不再只暴露无来源的 120k/180k 魔法数。

## 已收口 Models Inspect Polish

`bbl models inspect provider/model` 已显示 provider auth mode、adapter、context window、default max tokens、json/structured output、streaming、tool calling、long-context 与 AgentLoop roles；unknown/custom OpenAI-compatible model 会显示“未声明，不做强拦截”。不输出自动 role model 推荐；该方向已无限期 delay，需要时再恢复。

## 已收口 P2 Provider Seeds

Moonshot 与 Ollama / local OpenAI-compatible seed 已落地：registry 新增 provider/model declaration，`bbl models list/inspect` 可展示 adapter/auth/capability/AgentLoop role suitability；OpenAI-compatible adapter mock smoke 覆盖 Moonshot 默认 base URL/Bearer auth 与 Ollama 默认 local base URL/no-auth；BabeL-X legacy Moonshot profile 可导入到新 registry。

## 已收口 P2 Adapter Robustness — Error Metadata Slice

Provider-specific error body 与 role structured output provider-neutral failure metadata 已收口：`ProviderError` 会解析 provider error code/type/message/request id，OpenAI-compatible adapter non-200 回归覆盖 provider-specific JSON body；Agent role structured output diagnostics 会区分 provider protocol、JSON parse、schema mismatch 与 capability gate，并覆盖 structured output wrapped in text 的 provider error 样本。

## Watch: Adapter Robustness Regression Corpus

- [ ] 后续继续把真实 provider live/manual smoke 的新增失败样本沉淀成 adapter regression。
  - 已覆盖 partial/malformed tool arguments、provider-specific error body、structured output wrapped provider error 与 provider-neutral structured output failure metadata。
  - 后续若真实样本暴露空响应、finish_reason 差异或新的 provider-specific error body，再按最小 regression-first 补齐。

## 验证命令

历史验证覆盖：`npm test` 中的 provider registry、adapter、runtime LLM、provider recovery、DeepSeek reasoning replay 回归；`npm run cli -- models list`；`npm run cli -- models inspect local/coding-runtime`；以及真实/自定义模型 inspect smoke，覆盖 auth mode、adapter、静态 capability table 与 undeclared custom model 提示。

## 参考文件

- `src/providers/registry.ts`
- `src/providers/adapters/ModelAdapter.ts`
- `src/providers/adapters/AnthropicAdapter.ts`
- `src/providers/adapters/OpenAIAdapter.ts`
- `src/runtime/providerRecovery.ts`
- `src/runtime/LLMCodingRuntime.ts`
- `src/shared/config.ts`
