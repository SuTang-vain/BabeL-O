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
- [ ] 增加 provider options schema。
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
- [ ] usage 归一。
- [ ] provider error 归一为 Nexus `PROVIDER_ERROR`。
- [x] 保留 `local` adapter 作为 deterministic test backend。

## P2 Model Capability Routing

- [ ] Planner 默认使用长上下文模型。
- [ ] Executor 默认使用 tool calling 稳定模型。
- [ ] Critic 默认使用 structured output 稳定模型。
- [ ] request override 优先级：request model > role model > active profile default。
- [ ] Nexus 拒绝不支持工具调用的模型执行工具链。
- [ ] Nexus 拒绝不支持 structured output 的模型执行 structured role。

## Provider Seed

- [x] local: `local/coding-runtime`
- [x] Anthropic official
- [x] OpenAI
- [ ] Zhipu / GLM
- [ ] MiniMax
- [ ] DeepSeek
- [ ] Moonshot
- [ ] Ollama / local OpenAI-compatible

## 验证命令

- [x] `npm test` (已包含新测试 `test/providers.test.ts` 和 `test/runtime-llm.test.ts`)
- [x] `npm run cli -- models list`
- [x] `npm run cli -- models inspect local/coding-runtime`
- [x] mocked provider smoke：simple text
- [x] mocked provider smoke：tool call
- [ ] mocked provider smoke：structured output
- [ ] 真实 provider smoke：simple text
- [ ] 真实 provider smoke：tool call
- [ ] 真实 provider smoke：structured output

## 参考文件

- `src/providers/registry.ts`
- `src/runtime/LocalCodingRuntime.ts`
- `src/runtime/LLMCodingRuntime.ts`
- `src/providers/adapters/ModelAdapter.ts`
- `src/providers/adapters/AnthropicAdapter.ts`
- `src/providers/adapters/OpenAIAdapter.ts`
