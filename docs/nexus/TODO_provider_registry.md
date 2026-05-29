# TODO Provider / Model Registry

## 目标

Provider / Model Registry 负责统一多厂商模型配置、认证方式、能力元数据和 adapter 行为。Nexus、CLI、AgentLoop 和未来 SDK 必须共享同一套 registry。

## 当前状态

- [x] `src/providers/registry.ts` 已存在。
- [x] 已有 `local` provider seed。
- [x] 已有 `anthropic-compatible` provider seed。
- [x] 已有 `openai-compatible` provider seed。
- [x] `LocalCodingRuntime` 作为无模型测试后端可用。
- [x] 已接入真实 provider adapter。
- [x] 已实现 `bbl config`。
- [x] 已实现 `bbl models`。

## P1 Registry v1

- [x] 定义 `ProviderDefinition` 完整字段：`id`、`displayName`、`adapter`、`authMode`、`defaultBaseUrl`、`models`。
- [x] 定义 `ModelDefinition`：`provider/model`、context window、tool calling、json output、streaming。
- [x] canonical model id 使用 `provider/model`。
- [x] 增加 registry lookup helper。
- [x] 增加 unknown provider/model 的错误类型。
- [x] 增加 provider options schema。
- [x] 增加 registry 单元测试。

## P1 Config CLI

- [x] 实现 `bbl config add`。
- [x] 实现 `bbl config list`。
- [x] 实现 `bbl config use`。
- [x] 配置文件使用 `~/.babel-o/config.json`。
- [x] 支持 env override：`BABEL_O_PROVIDER`、`BABEL_O_MODEL`、`BABEL_O_API_KEY`、`BABEL_O_BASE_URL`。
- [x] API key 不写入日志。

## P1 Model CLI

- [x] 实现 `bbl models list`。
- [x] 实现 `bbl models inspect provider/model`。
- [x] 显示能力矩阵：tool calling、json output、streaming、context window。
- [ ] 显示 provider auth mode 和 adapter。

## P1 Adapters

- [x] `anthropic-compatible` adapter。
- [x] `openai-compatible` adapter。
- [x] 流式 delta 归一为 Nexus events。
- [x] tool call 归一为 Nexus tool invocation。
- [x] MiniMax text-encoded `<minimax:tool_call>` 归一为 Nexus tool invocation，避免 raw provider XML 被当作助手文本渲染。
- [x] usage 归一。
- [x] provider error 归一为 Nexus `PROVIDER_ERROR`。
- [x] 保留 `local` adapter 作为 deterministic test backend。

## P2 Model Capability Routing

- [x] ProfileConfig 支持 `roles.planner/executor/critic/optimizer` 声明式角色模型。
- [x] Agent 步骤运行器按角色调用 `resolveSettings(role)`，支持 role model > active profile default 的解析。
- [x] Nexus 拒绝不支持工具调用的模型执行工具链。
- [x] 修正 `deepseek/deepseek-reasoner` 能力声明为 `toolCalling: false`。
- [x] request override 优先级：request model > env model > role model > active profile default。
- [x] Nexus/Agent 解析同一套 `resolveSettings({ model, role })` 口径；带 provider 前缀的 request model 不再被 profile provider 错配。
- [x] Nexus 拒绝不支持 structured output 的模型执行 structured role。
- [ ] Planner 默认使用长上下文模型。
- [ ] Executor 默认使用 tool calling 稳定模型。
- [ ] Critic 默认使用 structured output 稳定模型。
- [ ] 根据 `modelPreference.capability` 增加未配置 roles 时的默认模型推荐策略。

## Provider Seed

- [x] local: `local/coding-runtime`
- [x] Anthropic official
- [x] OpenAI
- [x] Zhipu / GLM
- [x] MiniMax
- [x] DeepSeek
- [ ] Moonshot
- [ ] Ollama / local OpenAI-compatible

## 验证命令

- [x] `npm test` (已包含新测试 `test/providers.test.ts` 和 `test/runtime-llm.test.ts`)
- [x] `npm run cli -- models list`
- [x] `npm run cli -- models inspect local/coding-runtime`
- [x] mocked provider smoke：simple text
- [x] mocked provider smoke：tool call
- [x] mocked provider smoke：structured output
- [x] 真实 provider smoke：simple text
- [x] 真实 provider smoke：tool call
- [x] 真实 provider smoke：structured output

## 参考文件

- `src/providers/registry.ts`
- `src/runtime/LocalCodingRuntime.ts`
- `src/runtime/LLMCodingRuntime.ts`
- `src/providers/adapters/ModelAdapter.ts`
- `src/providers/adapters/AnthropicAdapter.ts`
- `src/providers/adapters/OpenAIAdapter.ts`
