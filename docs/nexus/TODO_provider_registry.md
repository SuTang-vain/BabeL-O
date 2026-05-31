# TODO Provider / Model Registry

## 目标

Provider / Model Registry 统一多厂商模型配置、认证方式、能力元数据、adapter 行为和 Agent role routing。本文只保留 provider/model 仍未收口的开发项；已完成 provider、adapter、diagnostics 与回归能力移入 [DONE.md](./DONE.md)。

## 当前状态

- Registry、config CLI、models CLI、Anthropic-compatible / OpenAI-compatible / Local adapter、Zhipu/MiniMax/DeepSeek/OpenAI/Anthropic seed、usage/error 归一、provider diagnostics、provider smoke、fallback plan API 已落地。
- MiniMax text-encoded tool call、DeepSeek reasoning replay、tool/structured capability gate、role model override、request model 优先级已落地并有测试覆盖。
- 当前主要缺口是默认 role model 推荐、显式 fallback 执行入口、models inspect 细节补齐和少量 provider seed。

## P1 Role Defaults / Capability Recommendation

- [ ] 根据 `modelPreference.capability` 增加未配置 roles 时的默认模型推荐策略。
  - Planner/Critic 优先 structured output、长上下文、推理稳定。
  - Executor/Optimizer 必须优先 tool calling + structured output。
  - 若当前 active profile 模型缺少 role 所需能力，CLI/API 只给出明确建议，不静默切换。
- [ ] 在 `/v1/runtime/status`、`/status` 或 provider diagnostics 中展示 role routing 结果。
  - 展示 planner/executor/critic/optimizer 的 resolved model、来源 request/env/role/profile/default、capability gap。
  - 不泄露 API key、credential 或完整 provider config。

## P1 Explicit Fallback Execution

- [ ] 与 runtime fallback policy 联动：当 provider recovery 建议切换模型/provider/profile 时，只生成可确认行动计划。
  - 保持 `allowSilentModelSwitch=false`。
  - 用户确认前不得自动修改 profile、provider、model 或重发请求。
  - 确认动作需要写入 session event 和配置审计。
- [ ] 增加 CLI 执行入口。
  - 可从 `/status`、provider error recovery、`bbl models inspect` 或专门命令进入。
  - 展示将要切换的 provider/model/profile、原因、风险、回滚方式。

## P1 Models Inspect Polish

- [ ] `bbl models inspect provider/model` 显示 provider auth mode 和 adapter。
- [ ] 输出 role 适配建议。
  - 例如：可作为 Planner、不可作为 Executor，因为缺 tool calling。
  - 对 context window、json/structured output、streaming、tool calling 给出同一套能力表。
- [ ] 对 unknown/custom OpenAI-compatible model 的能力声明给出“未声明，不做强拦截”的清晰提示。

## P2 Provider Seeds

- [ ] Moonshot seed。
- [ ] Ollama / local OpenAI-compatible seed。
- [ ] 为新增 seed 补最小 registry lookup、models list/inspect、mock adapter smoke。

## P2 Adapter Robustness

- [ ] 将真实 provider live/manual smoke 的失败样本沉淀成 adapter regression。
  - 覆盖 partial/malformed tool arguments、空响应、finish_reason 差异、provider-specific error body、structured output 包裹文本。
- [ ] 为 role structured output repair/retry 提供 provider-neutral error metadata。
  - Runtime/AgentLoop 需要知道是 provider 协议错误、JSON 解析错误、schema mismatch 还是 capability gate。

## 验证命令

- [x] `npm test` 中的 provider registry、adapter、runtime LLM、provider recovery、DeepSeek reasoning replay 回归。
- [x] `npm run cli -- models list`
- [x] `npm run cli -- models inspect local/coding-runtime`
- [ ] `npm run cli -- models inspect <real-provider/model>` 覆盖 auth mode、adapter、role recommendation。
- [ ] 显式 fallback execution smoke。

## 参考文件

- `src/providers/registry.ts`
- `src/providers/adapters/ModelAdapter.ts`
- `src/providers/adapters/AnthropicAdapter.ts`
- `src/providers/adapters/OpenAIAdapter.ts`
- `src/runtime/providerRecovery.ts`
- `src/runtime/LLMCodingRuntime.ts`
- `src/shared/config.ts`
