# Model Catalog and Context Metadata Governance Plan

> State: Active Plan
> Status: Proposed — design reference for provider/model metadata evolution
> Priority: P1 for local user-declared model metadata; P2 for resolver/CLI polish; P3 for optional remote catalog
> Scope: provider/model registry, custom model metadata, context window semantics, cache-aware compact policy, diagnostics, and future Catwalk-like catalog governance
> Non-goal: automatic model selection, silent provider/model/profile switching, or default remote catalog auto-update
> Governance: Indexed by [prompt-model-governance-index.md](./prompt-model-governance-index.md). This document owns provider/model metadata facts; prompt text must not invent model capabilities or context-window limits.

---

## 1. 背景

BabeL-O 当前已经具备 provider / model registry、provider diagnostics、`bbl models inspect`、provider smoke、cache-aware compact policy 与多 provider adapter 回归。现有能力主要基于 `src/providers/registry.ts` 中的静态定义：

- `ProviderDefinition`：provider id、adapter、auth mode、default base URL、default model、model id 列表。
- `ModelDefinition`：model id、display name、`contextWindow`、`defaultMaxTokens`、tool/json/streaming capabilities。
- `inspectModelCapabilities()`：输出 provider adapter/auth、模型声明状态、context window、capabilities 与 AgentLoop role suitability。
- `cacheAwareCompactPolicy.ts`：基于 `getModel(modelId)` 返回的 context window/default max tokens 计算 warning、compact、blocking 与 long-context utilization policy。

这套静态 registry 已经解决了早期多 provider 能力不可见、context ceiling 诊断无来源、provider smoke 口径不一致的问题。但随着 MiniMax、Zhipu、Moonshot、Ollama、本地 OpenAI-compatible、OpenRouter-like gateway 与用户自定义 provider 增加，静态 registry 的边界开始变得明显：

1. 用户可以配置 registry 中不存在但 provider 可用的 model。
2. 未声明 model 当前会被视为 `undeclared`，能力使用保守占位。
3. context policy 对 unknown/custom model 只能 fallback 到 8192 context。
4. large-context mode 仍依赖 provider prefix 白名单，而不是纯 metadata。
5. `ProviderDefinition.models` 与 `modelRegistry` 双写，存在 drift 风险。
6. 未来如果引入 Catwalk-like 远程 catalog，需要先定义本地 metadata source、合并优先级、审计输出与失败回退策略。

本规划基于 Crush 对 Catwalk provider/model catalog 的使用方式进行对照分析，但不主张立即照搬 Crush 的远程 catalog 自动更新主路径。BabeL-O 更适合先建立 **本地可审计、可覆盖、可诊断的 Model Catalog resolver**，再在此基础上评估是否需要远程 catalog。

---

## 2. Crush / Catwalk 对照结论

Crush 的 provider/model 链路可以简化为：

```text
Catwalk remote catalog / embedded catalog / local cache
  -> []catwalk.Provider
  -> provider.Models[]catwalk.Model
  -> model.ContextWindow / DefaultMaxTokens / capabilities
  -> config.configureProviders()
  -> Config.Providers[providerID].Models
  -> Config.Models[large|small] stores selected provider/model id
  -> runtime resolves catwalk.Model by provider/model id
  -> UI context percentage / sidebar context info / auto summarize threshold
```

几个值得借鉴的设计点：

1. **模型能力是 catalog metadata，不依赖 provider `/models` 动态推断。**
   - 大多数 provider 的 `/models` 不稳定、不含 context window，或只返回 ID。
   - context window/default max tokens/capabilities 更适合作为 curated catalog metadata。

2. **known provider metadata 与用户配置 provider 分层。**
   - Catwalk 提供默认 provider/model catalog。
   - 用户 `crush.json` 提供 API key/base URL/custom models/override。
   - runtime 使用合并后的 provider config。

3. **context window unknown 有明确语义。**
   - Crush 在 `ContextWindow == 0` 时跳过 auto summarize，避免把未知 custom/local model 立即截断。
   - unknown 不是“小窗口”，而是“缺少声明”。

4. **远程 catalog 有 cache 与 embedded fallback。**
   - auto update 可禁用。
   - timeout/error/not-modified 均 fallback 到 cached/embedded。
   - 手动 update 命令与默认源分离。

BabeL-O 应优先借鉴的是 **metadata catalog 与 user override 机制**，而不是 Crush 的 large/small 默认模型选择，也不是默认联网更新 catalog。

---

## 3. BabeL-O 当前状态

### 3.1 已具备能力

- `src/providers/registry.ts`
  - 静态 provider registry。
  - 静态 model registry。
  - `inspectModelCapabilities()`。
  - undeclared model conservative placeholder。
  - provider adapter resolver。

- `src/shared/config.ts`
  - `ProviderConfig` 支持 `apiKey` / `baseUrl`。
  - `ProfileConfig` 支持 `model` / `provider` / role model override。
  - `ConfigManager.resolveSettings()` 统一解析 request/env/role/profile/default model。
  - `ConfigManager.getProviderDiagnostics()` 复用 `inspectModelCapabilities()`。

- `src/runtime/cacheAwareCompactPolicy.ts`
  - 基于 registry context window/default max tokens 计算 effective ceiling。
  - 透出 legacy ceiling、reserved output、provider safety buffer、env cap、warning/compact/blocking thresholds、cache preservation mode、long-context utilization mode。

- `src/cli/commands/models.ts`
  - `bbl models list` 展示静态 `modelRegistry`。
  - `bbl models inspect` 展示单 model diagnostics。

- `docs/nexus/active/TODO_provider_registry.md`
  - 已明确自动模型选择、默认 role recommendation 与 fallback execution 无限期 delay。
  - 当前不推进 silent switching。

### 3.2 当前关键缺口

#### 3.2.1 `ProviderConfig` 无法声明 models

当前 `ProviderConfig` 仅包含：

```ts
export interface ProviderConfig {
  apiKey?: string
  baseUrl?: string
}
```

用户无法为 custom provider / custom model 声明：

- model display name
- context window
- default max tokens
- tool calling capability
- JSON / structured output capability
- streaming capability

这导致 registry 未声明 model 只能走 conservative placeholder。

#### 3.2.2 undeclared model 被伪装成 8192 context

当前 undeclared model definition：

```ts
{
  id: modelId,
  name: modelId,
  contextWindow: 8192,
  defaultMaxTokens: 4096,
  capabilities: {
    toolCalling: false,
    jsonOutput: false,
    streaming: false,
  },
}
```

这有实际风险：

- 对真实 128k/200k custom model 过早 compact。
- `/context` 和 metrics 看起来像模型真实只有 8192，而不是 metadata unknown。
- 用户没有直接配置方式纠正。
- long-context policy 不会启用。

正确语义应是：

```text
undeclared model:
  contextWindowKnown = false
  modelContextWindow = unknown
  effectiveContextCeiling = conservative fallback
```

而不是：

```text
modelContextWindow = 8192
```

#### 3.2.3 large-context policy 依赖 provider prefix

当前 long-context 判断近似为：

```ts
contextWindow >= 180000 && (
  modelId startsWith anthropic/ || minimax/ || zhipu/
)
```

问题：

- custom-openai/my-200k-model 即使显式声明 200k，也无法进入 long-context mode。
- provider prefix 不是能力本身。
- 未来 OpenRouter、Moonshot、Ollama/local gateway 长上下文模型会继续扩大白名单。

应该改为：

```text
large-context = declared metadata contextWindow >= threshold
```

并通过 source / trust / provider error recovery 控制风险。

#### 3.2.4 provider model list 与 model registry 双写

`ProviderDefinition.models` 与 `modelRegistry` 同时维护 model ids。未来容易出现：

```text
provider.defaultModel 指向不存在的 model
provider.models 包含 modelRegistry 没有的 id
modelRegistry 有 provider/model，但 provider.models 忘记加入
重复 model id
```

需要 invariant tests 或生成式关系来治理。

#### 3.2.5 CLI 只展示 builtin registry

`bbl models list` 当前遍历 `modelRegistry`，不会展示未来用户在 config 中声明的 models。若引入 user model metadata，CLI 必须同步展示 source 与 merged result。

---

## 4. 治理目标

### 4.1 目标

1. **允许用户声明 custom model metadata。**
   - 支持 `providers.<providerId>.models[]`。
   - 支持 context window/default max tokens/capabilities。
   - 支持覆盖 builtin model metadata。

2. **建立 config-aware model resolver。**
   - 所有 diagnostics/context policy/CLI/provider smoke 使用同一 resolver。
   - resolver 输出 metadata source、warning、known/unknown context semantics。

3. **把 context window 与 effective context ceiling 分离。**
   - `model.contextWindow` 表示模型声明/已知能力。
   - `effectiveContextCeiling` 表示 BabeL-O 当前运行策略上限。
   - unknown context 不再伪装为真实 8192。

4. **large-context policy metadata-driven。**
   - 不再用 provider prefix 作为主要判断。
   - user-declared 200k model 可启用 long-context utilization。

5. **CLI 与 diagnostics 可审计。**
   - `bbl models list/inspect` 显示 builtin/user/undeclared source。
   - provider diagnostics 与 `/context` 统一显示 source、unknown、fallback reason。

6. **保持模型切换安全边界。**
   - 不自动推荐或切换模型。
   - 不静默修改 active profile/default model。
   - 不把 catalog metadata 当成授权凭据来源。

### 4.2 非目标

本规划明确不包含：

- 自动模型选择。
- 默认 role model recommendation 的恢复。
- provider recovery 自动切换 provider/model/profile。
- 默认联网拉取远程 catalog。
- 用 provider `/models` 动态推断 context window。
- 让 child agent 或 runtime 自动改写用户 provider config。
- 任何对真实 `~/.babel-o/config.json` 的测试写入。

---

## 5. 设计原则

### 5.1 Metadata 优先，provider API 次之

模型上下文窗口和能力不应依赖 runtime provider API 动态查询，因为：

- OpenAI-compatible `/models` 经常不返回 context window。
- Anthropic-compatible provider 可能没有统一 models endpoint。
- Gateway 可能隐藏真实模型能力。
- 在线查询会增加启动延迟与失败面。
- provider 返回列表不等于该 key 有调用权限。

因此 BabeL-O 的主路径应是：

```text
builtin catalog + user config override + future optional cached catalog
```

### 5.2 用户声明优先于 builtin

合并优先级建议：

```text
request selected model id
  -> user_config exact model metadata
  -> builtin registry exact model metadata
  -> undeclared placeholder
```

理由：

- 用户可能知道 builtin 未更新的新 context window。
- 用户可能接入同名代理模型。
- 用户本地配置是显式意图，应可覆盖内置 metadata。
- diagnostics 会显示 source，避免无审计覆盖。

### 5.3 Unknown 不能伪装成小窗口

Unknown model context 不等于 8192。正确表达应区分：

```text
modelContextWindowKnown = false
modelContextWindow = undefined / 0 / null display as unknown
effectiveContextCeiling = conservative fallback used by policy
```

CLI/metrics 可以显示：

```text
Context Window: unknown
Effective Ceiling: 8192 conservative fallback
```

### 5.4 不强拦截 undeclared custom model

BabeL-O 现有策略是 unknown/custom provider-scoped model 允许配置，但能力保守提示“不做强拦截”。该策略应保留：

- 不因为 metadata unknown 就阻断真实 provider 调用。
- 不因为 capability unknown 就禁止用户尝试。
- 但 tool/structured output diagnostics 应明确能力未声明，可能失败。

### 5.5 Catalog 不拥有 credential

无论 builtin/user/future remote catalog，都只描述模型 metadata。credential 仍由：

- env
- profile
- provider config

按现有 `ConfigManager.resolveSettings()` 优先级解析。

Catalog 不应保存：

- API key
- OAuth token
- cookies
- account/subscription 状态
- provider billing 信息

---

## 6. 建议配置结构

### 6.1 新增用户模型声明类型

建议新增：

```ts
export interface UserModelDefinition {
  id: string
  name?: string
  contextWindow?: number
  defaultMaxTokens?: number
  capabilities?: {
    toolCalling?: boolean
    jsonOutput?: boolean
    streaming?: boolean
  }
}
```

扩展 `ProviderConfig`：

```ts
export interface ProviderConfig {
  apiKey?: string
  baseUrl?: string
  models?: UserModelDefinition[]
}
```

### 6.2 Zod schema

建议 schema：

```ts
export const UserModelDefinitionSchema = z.object({
  id: z.string().min(1, 'Model ID cannot be empty'),
  name: z.string().min(1).optional(),
  contextWindow: z.number().int().positive().optional(),
  defaultMaxTokens: z.number().int().positive().optional(),
  capabilities: z.object({
    toolCalling: z.boolean().optional(),
    jsonOutput: z.boolean().optional(),
    streaming: z.boolean().optional(),
  }).optional(),
})

export const ProviderConfigSchema = z.object({
  apiKey: z.string().min(1, 'API key cannot be empty').optional(),
  baseUrl: z.string().url('Base URL must be a valid URL').optional(),
  models: z.array(UserModelDefinitionSchema).optional(),
})
```

### 6.3 Provider/model id 校验

建议在 `superRefine` 中增加：

1. `providers.<providerId>.models[].id` 若包含 `/`，prefix 必须等于 providerId。
2. 若不包含 `/`，normalize 为 `${providerId}/${id}` 仅用于 resolver，不直接改写 config。
3. 同一 provider 下 duplicate model id 报 warning 或 validation issue。
4. `contextWindow` 与 `defaultMaxTokens` 必须为正整数。
5. `defaultMaxTokens < contextWindow` 可作为 warning，不必 hard fail，因为部分 provider 的 output budget 定义可能特殊。

建议第一阶段只 hard fail：

- empty id
- non-positive numeric fields
- model id prefix 与 provider id 明显冲突

避免配置兼容性过度收紧。

### 6.4 示例配置

#### 6.4.1 覆盖 builtin model metadata

```json
{
  "providers": {
    "minimax": {
      "apiKey": "$MINIMAX_API_KEY",
      "models": [
        {
          "id": "minimax/MiniMax-M3",
          "contextWindow": 200000,
          "defaultMaxTokens": 16384,
          "capabilities": {
            "toolCalling": true,
            "jsonOutput": true,
            "streaming": true
          }
        }
      ]
    }
  },
  "defaultModel": "minimax/MiniMax-M3"
}
```

#### 6.4.2 自定义 OpenAI-compatible provider

```json
{
  "providers": {
    "custom-openai": {
      "apiKey": "$CUSTOM_OPENAI_API_KEY",
      "baseUrl": "https://example.com/v1",
      "models": [
        {
          "id": "custom-openai/my-200k-model",
          "name": "My 200K Model",
          "contextWindow": 200000,
          "defaultMaxTokens": 8192,
          "capabilities": {
            "toolCalling": true,
            "jsonOutput": true,
            "streaming": true
          }
        }
      ]
    }
  },
  "defaultModel": "custom-openai/my-200k-model"
}
```

> 注意：如果 provider id 不在 `providerRegistry` 中，当前 BabeL-O 仍会拒绝 unknown provider。支持完全自定义 provider adapter 是另一个议题。本规划第一阶段只支持 known provider 下的 custom/overridden models。

---

## 7. Model Catalog Resolver 设计

### 7.1 新文件建议

新增：

```text
src/providers/modelCatalog.ts
```

职责：

- 从 builtin registry 与 config provider models 合并 metadata。
- 根据 model id/provider id 解析最终 model definition。
- 输出 source 与 warning。
- 提供 list API 给 CLI。
- 避免 runtime/CLI/config 多处各自实现 fallback。

### 7.2 类型设计

建议将现有 `ModelCapabilitySource` 从：

```ts
export type ModelCapabilitySource = 'registry' | 'undeclared'
```

扩展为：

```ts
export type ModelCapabilitySource =
  | 'builtin'
  | 'user_config'
  | 'undeclared'
```

短期为兼容旧文案，也可保留 `'registry'`，但新文档与输出建议使用 `builtin`。

新增：

```ts
export type ResolvedModelDefinition = ModelDefinition & {
  source: ModelCapabilitySource
  declared: boolean
  contextWindowKnown: boolean
  capabilityWarning?: string
}
```

若不想立刻修改 `ModelDefinition.contextWindow: number`，可先采用：

```ts
contextWindow: number
contextWindowKnown: boolean
```

约定：

```text
contextWindowKnown=false 时 contextWindow 是 conservative fallback，不是模型真实 metadata。
```

更理想的长期类型：

```ts
contextWindow?: number
fallbackContextWindow: number
contextWindowKnown: boolean
```

但这会牵动较多调用点，建议分阶段演进。

### 7.3 Resolver API

建议 API：

```ts
export function resolveModelDefinition(options: {
  modelId: string
  providerIdOverride?: string
  config?: BabelOConfig
}): ResolvedModelDefinition
```

合并规则：

```text
1. 解析 provider id：
   - providerIdOverride 优先
   - modelId prefix 其次
   - 无 prefix 时按现有 resolveSettings 行为处理

2. 校验 providerRegistry 中存在 provider：
   - 不存在则抛 UnknownProviderError

3. 查找 user_config model exact id：
   - config.providers[providerId].models[]
   - id 可接受 full id 或 local id，经 normalize 后比较

4. 查找 builtin modelRegistry exact id。

5. 若都没有，返回 undeclared conservative placeholder。
```

### 7.4 User model normalize

建议 helper：

```ts
function normalizeModelId(providerId: string, modelId: string): string {
  return modelId.includes('/') ? modelId : `${providerId}/${modelId}`
}
```

注意：不要把 normalized id 写回 config，避免配置文件被隐式重写。

### 7.5 User model merge defaults

如果用户只声明局部 metadata：

```json
{ "id": "minimax/MiniMax-M3", "contextWindow": 200000 }
```

且 builtin model 存在，应 merge：

```text
builtin model as base
  + user override fields
  + source=user_config
```

如果 builtin model 不存在，则 base 为 conservative defaults：

```ts
{
  id,
  name: id,
  contextWindow: fallbackContextWindow,
  defaultMaxTokens: DEFAULT_RESERVED_OUTPUT_TOKENS,
  capabilities: {
    toolCalling: false,
    jsonOutput: false,
    streaming: false,
  }
}
```

然后应用 user fields。若用户提供 contextWindow，则 `contextWindowKnown=true`。

### 7.6 Source 与 warning

建议 warning 文案：

- user_config：

```text
Model metadata is user-declared in providers.<providerId>.models[]; BabeL-O trusts it for diagnostics and context policy, but provider errors can still trigger conservative recovery.
```

通常不必每次显示，可在 inspect 中显示 source 即可。

- undeclared：

```text
Model <id> is not declared in the built-in registry or user config; capabilities are conservative placeholders and context policy uses a fallback ceiling. Declare providers.<providerId>.models[] to enable accurate diagnostics.
```

---

## 8. Diagnostics 口径调整

### 8.1 `ModelCapabilityDiagnostics`

建议扩展：

```ts
export type ModelCapabilityDiagnostics = {
  ...
  modelDeclared: boolean
  capabilitySource: 'builtin' | 'user_config' | 'undeclared'
  capabilityWarning?: string
  contextWindowKnown: boolean
  contextWindow?: number
  fallbackContextWindow?: number
  defaultMaxTokens: number
  ...
}
```

短期兼容方案：保留 `contextWindow: number`，新增：

```ts
contextWindowKnown: boolean
contextWindowDisplay: string
```

例如：

```text
known:   contextWindow=200000, contextWindowDisplay="200000 tokens"
unknown: contextWindow=8192, contextWindowDisplay="unknown (fallback ceiling 8192)"
```

### 8.2 `ConfigManager.getProviderDiagnostics()`

当前 `getProviderDiagnostics()` 调用：

```ts
const modelDiagnostics = inspectModelCapabilities(settings.modelId, settings.providerId)
```

应改为传入 config：

```ts
const modelDiagnostics = inspectModelCapabilities({
  modelId: settings.modelId,
  providerIdOverride: settings.providerId,
  config: this.load(),
})
```

若为了兼容 API，可新增重载或新函数：

```ts
inspectModelCapabilities(modelId, providerIdOverride?)
inspectModelCapabilitiesWithConfig({ modelId, providerIdOverride, config })
```

但推荐直接把 `inspectModelCapabilities` 参数对象化，减少未来继续扩展 source/cache 时的 breaking surface。

### 8.3 `bbl models inspect`

输出建议：

```text
Model Details: My 200K Model
ID:                 custom-openai/my-200k-model
Provider:           Custom OpenAI-compatible (custom-openai)
Adapter:            openai-compatible
Auth Mode:          bearer
Metadata Source:    user_config
Registry Declared:  No
Context Window:     200000 tokens
Default Max Tokens: 8192 tokens
Capabilities:
  Long Context:      Yes
  Tool Calling:      Yes
  JSON Output:       Yes
  Structured Output: Yes
  Streaming:         Yes
```

undeclared 输出：

```text
Metadata Source:    undeclared
Context Window:     unknown
Effective Fallback: 8192 tokens
Note: Model custom-openai/foo is not declared in built-in registry or user config; declare providers.custom-openai.models[] for accurate diagnostics.
```

### 8.4 `bbl models list`

建议展示 merged list：

```text
ID                              SOURCE       CONTEXT    TOOL JSON STREAM
local/coding-runtime            builtin      8192       yes  yes  yes
minimax/MiniMax-M3              builtin      200000     yes  yes  yes
custom-openai/my-200k-model     user_config  200000     yes  yes  yes
```

排序建议：

1. provider id
2. source priority: user_config before builtin when same id? 或显示 merged only
3. model id

若 user_config 覆盖 builtin exact id，list 中只显示一条，source=`user_config`，可附加 `overrides builtin` 标记。

---

## 9. Context Policy 调整

### 9.1 当前问题

`cacheAwareCompactPolicy.ts` 当前有两层 fallback：

1. `getModel()` 失败 fallback 到 `DEFAULT_CONTEXT_WINDOW=8192`。
2. large-context mode 依赖 provider prefix 白名单。

这让 custom long-context model 被过度保守处理。

### 9.2 建议 policy input

`buildCacheAwareCompactPolicy()` 目前输入只有：

```ts
modelId: string
```

建议新增可选：

```ts
config?: BabelOConfig
providerId?: string
```

或者更干净：

```ts
model?: ResolvedModelDefinition
```

短期改动最小方案：

```ts
buildCacheAwareCompactPolicy({
  modelId,
  tokenEstimate,
  modelMetadata?: ResolvedModelDefinition,
})
```

runtime 已经通过 `ConfigManager` 解析 provider diagnostics，可以把 resolved model metadata 传入 context policy，避免 policy 自己读取 config。

### 9.3 Unknown context policy

建议策略：

```text
if contextWindowKnown=false:
  modelContextWindow = 0 or fallback display unknown
  policyCeiling = DEFAULT_UNKNOWN_MODEL_CONTEXT_CEILING (8192 initially)
  policySource = 'unknown_model_fallback'
  longContextUtilizationMode = false
  reason = 'Model context window is undeclared; using conservative fallback ceiling. Declare model metadata to enable accurate context policy.'
```

`CacheAwareCompactPolicy.policySource` 当前是：

```ts
'legacy' | 'large_context' | 'env_cap'
```

建议扩展：

```ts
'legacy' | 'large_context' | 'env_cap' | 'unknown_model_fallback'
```

若 env cap 约束 unknown fallback，则 source 可以是：

```text
env_cap
```

但 reason 应包含 unknown metadata。

### 9.4 Large-context 判断

从：

```ts
function isKnownLargeContextModel(modelId, contextWindow) {
  if (contextWindow < LARGE_CONTEXT_WINDOW_TOKENS) return false
  return modelId.startsWith('anthropic/') || modelId.startsWith('minimax/') || modelId.startsWith('zhipu/')
}
```

改为：

```ts
function isLargeContextModel(model: ResolvedModelDefinition): boolean {
  return model.contextWindowKnown
    && model.contextWindow >= LARGE_CONTEXT_WINDOW_TOKENS
    && model.source !== 'undeclared'
}
```

可选 guard：

```ts
&& !model.disableLongContextUtilization
```

暂不建议新增用户配置 `disableLongContextUtilization`，除非真实 provider 报错样本证明需要 per-model opt-out。

### 9.5 Provider context error recovery 保持兜底

如果用户配置 contextWindow 过大，provider 仍可能报 context length exceeded。现有 provider context recovery 应继续发挥作用：

- provider context error 后 conservative threshold。
- semantic compact retry。
- diagnostics 说明 provider rejected prompt too large。

这比静态 provider whitelist 更灵活。

---

## 10. Provider Smoke 与 Capability Gate

### 10.1 Smoke 解析

`providerSmoke.ts` 中若调用 `getModel(provider.modelId)` 判断 model 是否 resolved，应改用 model catalog resolver：

```text
builtin/user_config -> resolved
undeclared -> allowed but warning
```

Smoke 结果建议区分：

```text
modelResolved: true | false
modelMetadataSource: builtin | user_config | undeclared
modelContextWindowKnown: boolean
```

### 10.2 Capability gate

现有 tool/structured output capability gate 应保持保守：

- `toolCalling=false` 不代表 provider 一定不能 tool call，只代表 BabeL-O 未声明/未验证。
- 对 undeclared model 不强拦截，但 diagnostics 提示。
- 对 user_config 声明 `toolCalling=true` 的模型，可以按声明放行，但真实 provider 错误仍进入 adapter/provider regression。

### 10.3 Regression-first 原则

如果真实 provider session 暴露：

- model context window 与声明不符；
- tool call 支持声明不符；
- JSON/structured output 格式差异；
- streaming finish reason 差异；

应优先沉淀 adapter/provider regression，而不是扩大自动切换或 fallback execution 范围。

---

## 11. Registry Drift Governance

### 11.1 Invariant tests

建议新增 registry invariant 测试：

```text
- every provider.defaultModel exists in modelRegistry or generated model list
- every provider.models id exists in modelRegistry if ProviderDefinition.models retained
- every modelRegistry id has provider prefix
- every modelRegistry provider prefix exists in providerRegistry
- no duplicate modelRegistry ids
- every model contextWindow/defaultMaxTokens is positive integer
- every provider defaultModel belongs to provider id prefix
```

### 11.2 是否移除 ProviderDefinition.models

中期建议移除或弱化 `ProviderDefinition.models`，改为：

```ts
export function modelsForProvider(providerId: string): ModelDefinition[] {
  return modelRegistry.filter(model => providerIdFromModelId(model.id) === providerId)
}
```

如果短期保留 `models`，至少让测试保证其与 `modelRegistry` 一致。

### 11.3 Generated display list

`bbl models list` 不应直接遍历 `modelRegistry`，而应通过：

```ts
listResolvedModels({ config, includeBuiltin: true, includeUserConfig: true })
```

这样未来加入 cached remote catalog 也不需要改 CLI 主逻辑。

---

## 12. 未来 Remote Catalog 的边界

### 12.1 为什么不作为近期主路径

默认远程 catalog 会引入：

- 供应链信任问题。
- metadata 错误导致 context policy 错误。
- cache 污染与回滚问题。
- 离线/CI/企业网络环境失败。
- 测试隔离与 reproducibility 问题。
- 用户不预期的行为变化。

因此本规划建议：

```text
Phase A-D 只做 local config-aware catalog resolver。
Phase E 之后再评估 remote catalog。
```

### 12.2 若未来引入，必须满足

1. 默认可禁用：

```text
BABEL_O_DISABLE_MODEL_CATALOG_UPDATE=1
```

2. 有 embedded fallback。
3. 有 local cache。
4. 有 manual update command：

```text
bbl models update-catalog [path-or-url]
```

5. 有 source/version/etag/hash diagnostics。
6. 不包含 credential。
7. 不自动修改 `defaultModel` / `activeProfile`。
8. 不覆盖 user_config source，除非用户显式允许。
9. 所有测试使用临时 catalog/config，不能写真实 `~/.babel-o/config.json`。

### 12.3 Source precedence with future remote

未来 source 优先级建议：

```text
user_config
  > builtin_hotfix? (if introduced)
  > remote_cache
  > embedded_builtin
  > undeclared
```

但为降低认知负担，第一阶段只需要：

```text
user_config > builtin > undeclared
```

---

## 13. 实施路线图

## Phase A — User-declared Model Metadata

> Priority: P1
> Goal: 用户能为 known provider 下的 custom/overridden model 声明 context window/default max tokens/capabilities。

### A.1 修改配置类型

文件：`src/shared/config.ts`

- 新增 `UserModelDefinition`。
- 扩展 `ProviderConfig.models?: UserModelDefinition[]`。
- 扩展 zod schema。
- 增加 `superRefine` 校验 model id prefix / duplicate / numeric fields。

### A.2 不改变 provider 注册边界

第一阶段不支持任意 unknown provider id。也就是说：

```json
"providers": {
  "not-in-registry": { ... }
}
```

仍按现有逻辑报 unknown provider。完全自定义 provider adapter 是独立规划。

### A.3 测试

- Provider config accepts `models`.
- Rejects `contextWindow <= 0`.
- Rejects `defaultMaxTokens <= 0`.
- Rejects `providers.minimax.models[].id = "openai/foo"`.
- Does not write real `~/.babel-o/config.json`.

---

## Phase B — Config-aware Model Resolver

> Priority: P1
> Goal: 所有 model metadata 解析统一经过 resolver。

### B.1 新增 `src/providers/modelCatalog.ts`

API：

```ts
resolveModelDefinition({ modelId, providerIdOverride, config })
listModelDefinitions({ config })
normalizeModelId(providerId, modelId)
```

### B.2 修改 `inspectModelCapabilities()`

从直接查 `modelRegistry` 改为：

```text
resolveModelDefinition -> build diagnostics
```

### B.3 修改 `ConfigManager.getProviderDiagnostics()`

传入当前 config，确保 user_config metadata 生效。

### B.4 测试

- User-config model overrides builtin metadata.
- User-config custom model resolves as `user_config`.
- Unknown model resolves as `undeclared`.
- Unknown provider still errors.

---

## Phase C — Context Policy Unknown Semantics

> Priority: P1
> Goal: context policy 区分真实 context window 与 conservative fallback。

### C.1 扩展 policy output

`CacheAwareCompactPolicy` 建议新增：

```ts
modelContextWindowKnown: boolean
modelMetadataSource: 'builtin' | 'user_config' | 'undeclared'
fallbackContextWindow?: number
```

并扩展：

```ts
policySource: 'legacy' | 'large_context' | 'env_cap' | 'unknown_model_fallback'
```

### C.2 改造 fallback reason

Unknown model reason：

```text
Model context window is undeclared; using conservative fallback ceiling. Declare providers.<providerId>.models[] to enable accurate context policy.
```

### C.3 测试

- Undeclared model diagnostics display unknown context.
- Undeclared model uses fallback effective ceiling.
- User-config model contextWindow drives effective ceiling.
- Env cap still constrains user-config model.

---

## Phase D — Metadata-driven Large Context

> Priority: P1/P2
> Goal: large-context mode 不再依赖 provider prefix。

### D.1 替换 `isKnownLargeContextModel()`

从 provider prefix 改为 source/context metadata：

```text
contextWindowKnown && contextWindow >= LARGE_CONTEXT_WINDOW_TOKENS && source !== undeclared
```

### D.2 保留 provider context error conservative path

如果 provider 报 context length exceeded，仍走已有 conservative/retry 逻辑。

### D.3 测试

- `custom-openai/my-200k-model` with user_config enters large-context mode.
- `custom-openai/unknown` does not enter large-context mode.
- `minimax/MiniMax-M3` still enters large-context mode.
- Provider context error disables cache preservation/conservative threshold as before.

---

## Phase E — CLI / UX Polish

> Priority: P2
> Goal: 用户能看见 BabeL-O 使用的模型 metadata 来源。

### E.1 `bbl models list`

展示：

```text
id | source | context | default max tokens | tool | json | streaming
```

### E.2 `bbl models inspect`

支持 user_config model，并显示：

- metadata source
- context known/unknown
- fallback ceiling
- capabilities
- no automatic switch statement

### E.3 Chat `/provider` / `/context` 输出

若相关命令已有 provider/context diagnostics，应显示：

```text
model metadata source=user_config
contextWindow=200000
```

或：

```text
contextWindow=unknown fallback=8192
```

---

## Phase F — Registry Drift Tests

> Priority: P2
> Goal: 防止 builtin provider/model registry 漂移。

### F.1 新增 invariant test

覆盖第 11 节 listed invariants。

### F.2 决定是否移除 `ProviderDefinition.models`

如果保留：测试强约束一致性。

如果移除：更新 CLI/config import 等使用点，改用 `modelsForProvider()`。

---

## Phase G — Optional Remote Catalog Spike

> Priority: P3 / delayed until local resolver stable
> Goal: 只做可逆 spike，不默认启用。

### G.1 Spike 内容

- catalog JSON schema。
- cache path。
- manual update command。
- source/version diagnostics。
- disable env flag。
- embedded fallback。

### G.2 Explicitly not included

- 默认自动更新。
- 自动切换模型。
- remote source 覆盖 user_config。
- credential storage。

---

## 14. 验收标准

### 14.1 Phase A-D 最小验收

给定配置：

```json
{
  "providers": {
    "minimax": {
      "models": [
        {
          "id": "minimax/custom-200k",
          "name": "Custom 200K",
          "contextWindow": 200000,
          "defaultMaxTokens": 8192,
          "capabilities": {
            "toolCalling": true,
            "jsonOutput": true,
            "streaming": true
          }
        }
      ]
    }
  },
  "defaultModel": "minimax/custom-200k"
}
```

应满足：

- Config schema 通过。
- `ConfigManager.getProviderDiagnostics()` 输出 source=`user_config`。
- `contextWindow=200000`。
- `defaultMaxTokens=8192`。
- capabilities 与用户声明一致。
- cache-aware compact policy 使用 200k context 计算 long-context ceiling。
- 不发生自动模型切换。
- 不写真实用户 config。

### 14.2 Undeclared model 验收

给定：

```json
{
  "defaultModel": "minimax/not-declared-yet"
}
```

应满足：

- 配置仍可通过，因为 provider known。
- diagnostics source=`undeclared`。
- context window 显示 unknown 或 `contextWindowKnown=false`。
- effective ceiling 使用 conservative fallback。
- warning 提示声明 `providers.minimax.models[]`。
- runtime 不 hard-block。

### 14.3 Registry invariant 验收

测试必须保证：

- 无 duplicate model ids。
- 每个 builtin model 的 provider prefix 已注册。
- 每个 provider.defaultModel 已声明。
- 每个 model numeric metadata 为正整数。

---

## 15. 风险与缓解

### 15.1 用户声明错误 contextWindow

风险：用户把 32k model 声明为 200k，导致 provider context error。

缓解：

- provider context error recovery 保持 conservative compact retry。
- diagnostics 显示 source=user_config。
- 错误信息提示检查 user-declared contextWindow。

### 15.2 用户声明能力过度乐观

风险：用户声明 `toolCalling=true`，但 provider 不支持。

缓解：

- adapter/provider error 仍归一化。
- provider smoke 可暴露 capability mismatch。
- 后续真实失败沉淀 regression。

### 15.3 类型改动牵动面过大

风险：把 `contextWindow` 改成 optional 会影响很多调用点。

缓解：

- 第一阶段保留 `contextWindow: number`，新增 `contextWindowKnown`。
- 第二阶段再考虑 `contextWindow?: number`。

### 15.4 CLI 输出噪音过多

风险：source/warning 太多影响可读性。

缓解：

- list 只显示 source。
- inspect 显示详细 warning。
- provider/context diagnostics 只在 undeclared 或 user_config override 时显示 note。

### 15.5 远程 catalog 供应链风险

缓解：

- 不作为近期主路径。
- future remote catalog 默认不启用或可禁用。
- source/version/hash 可审计。
- user_config 永远优先。

---

## 16. 文件影响范围

预计涉及：

```text
src/shared/config.ts
src/providers/registry.ts
src/providers/modelCatalog.ts          # new
src/runtime/cacheAwareCompactPolicy.ts
src/runtime/providerSmoke.ts
src/cli/commands/models.ts
test/config.test.ts                    # exact file name to verify
test/provider-registry.test.ts         # exact file name to verify
test/cache-aware-compact-policy.test.ts# exact file name to verify
```

实际实现前需要用 search 确认 test 文件名，不应凭文档假定。

---

## 17. 推荐推进顺序

最推荐的最小闭环：

```text
1. ProviderConfig.models schema
2. modelCatalog resolver
3. getProviderDiagnostics uses resolver
4. cacheAwareCompactPolicy uses resolved metadata
5. bbl models inspect/list source output
6. registry invariant tests
```

不要在同一轮引入：

- remote catalog
- auto selection
- fallback execution
- arbitrary unknown provider adapter

这样可以保持改动边界清晰，符合“工具/能力边界正交、不要扩大 fuzzy responsibility”的既有治理口径。

---

## 18. 总结

Crush 的 Catwalk 方案说明：provider/model/context window 更适合作为 curated metadata catalog 来治理，而不是每次从 provider API 动态推断。BabeL-O 当前已经有静态 registry 与 context policy 基础，下一步最有价值的不是引入远程 catalog，而是补齐 **config-aware model metadata resolver**：

```text
user_config model metadata
  > builtin registry metadata
  > undeclared conservative placeholder
```

这能直接解决 custom model context window 不可声明、long-context policy provider prefix 白名单、CLI/diagnostics 不可审计等问题，同时保持：

- 不自动切换模型；
- 不恢复 auto model selection；
- 不默认联网；
- 不强拦截 undeclared model；
- 不让测试读写真实用户 config。

该路线风险小、收益直接，并为未来可选 Catwalk-like remote catalog 预留了正确边界。

## 中文概述

### 背景

模型 catalog 和 context metadata 决定上下文窗口、cache-aware compact、provider 选择和 no-silent-switching 等关键行为。

### 边界

远程 catalog 不能未经审计就覆盖本地事实；模型 metadata 必须可诊断、可覆盖、可回退。

### 当前状态

本文作为 Active Plan 保留。后续落地应以本地可审计 resolver 为先，再评估 cached remote catalog。
