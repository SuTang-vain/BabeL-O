# Providers

> Module reference · stable public contract · see linked governance docs for deep architecture

[简体中文](providers.zh-CN.md)

## Role

Providers owns the model provider registry, adapter factory, retry logic, and SSE
plumbing. It enumerates which LLM backends exist, how to authenticate with them,
how to convert between canonical `ModelQueryParams` and each provider's wire
format, and how to recover from transient failures — without the runtime or
nexus knowing the provider's protocol directly.

## Public contract

- **`ModelAdapter`** — the abstract streaming contract:
  `queryStream(params, options?) → AsyncIterable<StreamDelta>`. Three
  realizations exist: `AnthropicAdapter` (anthropic-compatible),
  `OpenAIAdapter` (openai-compatible), and `LocalAdapter` (deterministic mock).
  Adapters are selected by `getAdapter()` based on the provider's `adapter`
  type.
- **`providerRegistry`** — a `ProviderDefinition[]` of 8 known providers
  (`local`, `anthropic`, `openai`, `moonshot`, `ollama`, `deepseek`, `zhipu`,
  `minimax`). Each entry declares `id`, `displayName`, `adapter`, `authMode`
  (`api-key` / `bearer` / `none`), `defaultBaseUrl`, `defaultModel`, and
  `models[]`.
- **`modelRegistry`** — a `ModelDefinition[]` of ~60+ models. Model IDs follow
  `provider/model` format. Includes `contextWindow`, `defaultMaxTokens`, and
  capability flags (`toolCalling`, `jsonOutput`, `streaming`).
- **`getProvider(id)` / `getModel(id)`** — lookup functions that throw
  `UnknownProviderError` / `UnknownModelError` on miss.
- **`inspectModelCapabilities(modelId, providerIdOverride?)` →
  `ModelCapabilityDiagnostics`** — returns provider adapter, auth mode, model
  context window, declared or undeclared status, capability source, and
  suitability diagnostics for each agent-loop role.
- **`recommendModelForRole(role)`** — picks the best model from the registry
  for a given agent role (`planner` / `executor` / `critic` / `optimizer`). The
  runtime issues a warning but never performs automatic model switching.
- **`withRetry(fn, config?)`** — exponential-backoff wrapper. Retries only on
  `ProviderError` with status in `[429, 500, 502, 503, 529]`. Non-retryable
  statuses and non-`ProviderError` exceptions throw immediately.
- **`parseSSE(stream, signal?)`** — parses a `ReadableStream<Uint8Array>` into
  SSE events. Registers an active abort listener that cancels the stream reader,
  preventing silent or half-open connections from hanging indefinitely.

## Allowed dependencies

Providers depends only on `shared` (importing `ProviderError` from
`shared/errors.js`). It is a leaf module and must not import `cli`, `nexus`, or
`runtime`. The single reverse edge `shared → providers` (from
`src/shared/config.ts`) is allowlisted in CI.

## Extension points

- **Register a new provider** — add an entry to `providerRegistry` in
  `registry.ts`. Provide `id`, `displayName`, `adapter`, `authMode`,
  `defaultBaseUrl`, `defaultModel`, and model IDs. If the provider uses a new
  wire protocol, implement a new `ModelAdapter`.
- **Add a new adapter type** — implement the `ModelAdapter` interface and add
  its type to the `ProviderAdapter` union. Wire it in `getAdapter()`.
- **Add or adjust retry policy** — change `DEFAULT_RETRY_CONFIG` in `retry.ts`
  or extend `withRetry` for custom backoff strategies.
- **Custom SSE handling** — `parseSSE` accepts an optional `AbortSignal` that
  actively cancels the underlying stream. Subclass or replace it for
  non-standard SSE dialects.

## Related governance

- [Prompt-model governance index](../../nexus/reference/prompt-model-governance-index.md) — reader entry point for provider/model metadata, prompt contracts, and no-silent-switching boundaries.
- [Model catalog and context metadata governance](../../nexus/reference/model-catalog-and-context-metadata-governance-plan.md) — provider/model metadata design, context-window semantics, unknown-model fallback policy.
- [Provider stream silent-hang abort propagation](../../nexus/reference/provider-stream-silent-hang-abort-propagation-plan.md) — SSE reader cancellation, watchdog wiring, Nexus stream-loop abort race.
- [Runtime tool-loop governance](../../nexus/reference/runtime-tool-loop-governance-plan.md) — recoverable provider errors in the tool loop, loop budget thresholds.
- [Layer-direction audit](../../nexus/reference/layer-direction-audit-enforcement-plan.md) — direction-aware dependency gates with allowlist for the `shared → providers` reverse edge.
