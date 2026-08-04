# LLM Gateway Service Plan

> State: Draft (spike-validated on `feat/chat-completions-gateway`)
> Status: 2026-08-04 feasibility spike landed — OpenAI-compatible `POST /v1/chat/completions` verified end-to-end (non-stream, SSE stream, `response_format`, model defaulting, error mapping, concurrency). This plan admits the gateway as a first-class BabeL-O service and defines its product shape, boundary, and phases.

## Purpose

Turn BabeL-O's internal LLM pipeline (provider registry, adapters, retry, config center) into a **first-class inbound service**: an OpenAI-compatible LLM gateway that any external client can call. First consumer: **AetheL** (sibling KezhongKe product, `docs/babel-ai-engine.md`), which currently duplicates provider/retry/config management and wants a stable, rich AI engine.

## Current State

- Nexus daemon (Fastify + WS, 37 routers) is an **agent-execution service**: `/v1/execute`, `/v1/stream` (WS), sessions, agents, context, memory. There is **no inbound LLM endpoint** (`/v1/chat/completions` did not exist before the spike).
- The word "gateway" in BabeL-O docs is **outbound-only**: `docs/guides/providers.md` documents pointing BabeL-O's providers *at* external gateways (`bbl config add openai KEY https://my-gateway.example.com/v1`); `model-catalog-and-context-metadata-governance-plan.md` treats "OpenRouter-like gateway" as a connectable provider category.
- The LLM pipeline (`src/providers/registry.ts`, `src/providers/adapters/`, `src/providers/retry.ts`, `ConfigManager`) is fully built and internal-only.
- Spike evidence (2026-08-04, `feat/chat-completions-gateway` branch):
  - `src/nexus/chatCompletionsRoute.ts` (~250 lines): OpenAI-compatible request schema (zod), model defaulting via `resolveSettings` (model ownership stays in BabeL-O config — ADR-B2), `getModel` guard (`400 MODEL_NOT_FOUND`), stream + non-stream responses, OpenAI-style error mapping, `Connection: close` for SSE (node-fetch client compatibility).
  - `ModelQueryParams.responseFormat` added; `OpenAIAdapter` passes `response_format` through.
  - Measured (deepseek, local): BabeL-O gateway adds ~+67ms total (5%) over direct streaming; local processing 2-3ms; JSON mode 5/5; concurrency 5/5; unknown model → 400. **Known gap: non-stream consumers pay streaming latency** (direct non-stream 175ms vs via gateway 1135ms — upstream streaming itself takes 1246ms; the adapter layer is streaming-only by design). TTFT via gateway ~460-575ms vs 201ms direct (root cause not yet profiled).

## Problem Statement

1. Without a formal gateway service, every consumer either duplicates provider/retry/config logic or depends on ad-hoc endpoints.
2. AetheL's integration currently relies on a spike endpoint; it needs a contract-stable, documented, tested service to build M1/M2 against.
3. The streaming-only adapter architecture imposes latency on non-streaming consumers (AetheL's `fast-json` tasks: categorize / snapshot / workshop).

## Goals

- First-class OpenAI-compatible inbound endpoint: `POST /v1/chat/completions` (stream + non-stream) and `GET /v1/models` (catalog for consumer model pickers).
- `response_format` passthrough: `json_object` (phase 1) and `json_schema` (evaluated).
- Auth: inherit `NEXUS_API_KEY` middleware (`x-nexus-api-key` / `Bearer`), fail-closed when bound non-localhost.
- Model ownership stays in BabeL-O config (`activeProfile` / `defaultModel`; per-request `model` override allowed).
- Contract documented (OpenAPI section) + integration tests with the deterministic `local` provider (no real keys).
- **Performance (phase 1): non-streaming fast path** so non-stream consumers' latency approaches direct non-stream calls (target < +20%); profile the +300ms TTFT delta.

## Non-goals

- No tool/agent semantics in the gateway: no tool loop, permission gates, or session persistence (that is `/v1/execute`'s job).
- No embedding endpoint in phase 1 (evaluated separately; EverCore sidecar exists internally but is not exposed as a generic API).
- No silent model fallback — consistent with BabeL-O's existing `allowSilentModelSwitch: false` policy; consumers keep their own fallback chains.
- Not an alternative to `/v1/execute` / `/v1/stream` for agent workloads.

## Design

### Boundary: gateway vs agent-execution service

```text
External OpenAI-compatible client (AetheL, scripts, tools)
        │  POST /v1/chat/completions  (OpenAI format)
        ▼
LLM Gateway (chatCompletionsRoute)          ← pure LLM transport
        │  ModelQueryParams → getAdapter().queryStream()
        ▼
provider registry / adapters / withRetry / ConfigManager   (unchanged internals)

Agent workloads keep using /v1/execute + /v1/stream (LLMCodingRuntime) — untouched.
```

### Endpoint contract (as landed in the spike)

Request: `{ model?, messages[], stream?, temperature?, max_tokens?, response_format?, thinking? }`

| OpenAI field | Mapping |
| --- | --- |
| `model` (empty/absent → activeProfile/defaultModel) | `ModelQueryParams.model`; unknown → `400 MODEL_NOT_FOUND` |
| `messages[role=system]` | `systemPrompt` |
| other messages | `messages` (user/assistant) |
| `temperature` / `max_tokens` | passthrough; max_tokens default = registry `defaultMaxTokens` |
| `response_format` | new `ModelQueryParams.responseFormat` → `OpenAIAdapter` body |
| `stream` | true → SSE chunks; false → single `chat.completion` |

Errors: OpenAI-style `{ error: { message, type, code, status } }` — `400` invalid body / unknown model, `401` auth, `408` timeout, `502` provider failure.

### Phase 1 additions

- `GET /v1/models`: list `modelRegistry` entries (id, provider, contextWindow, capabilities) — feeds consumer model pickers (AetheL Settings).
- **Non-streaming fast path**: extend `ModelAdapter` with an optional non-stream mode (e.g. `query(params, options): Promise<{content, reasoning?, usage?}>` or a `stream: false` param); `OpenAIAdapter` implements direct completion (no SSE round-trip); other adapters fall back to collect-from-stream. Non-stream endpoint path uses it when `stream: false`.
- TTFT profiling: connection reuse / `parseSSE` buffering in the daemon's outbound path.
- Contract doc: OpenAPI snippet in `docs/nexus/reference/` (or this plan graduates with it).

## Phases

| Phase | Scope | Exit criteria |
| --- | --- | --- |
| 0 (landed) | Minimal `POST /v1/chat/completions` + `response_format` + model defaulting + `MODEL_NOT_FOUND` guard | Spike verified: T1-T7 (non-stream, JSON mode, SSE, OpenAI SDK, AetheL routes) |
| 1 | `GET /v1/models`; non-stream fast path in adapters; TTFT profiling; OpenAPI contract snippet; `local`-provider integration tests | `local` provider e2e green; non-stream latency within +20% of direct; contract doc landed |
| 2 | Auth fail-closed verification; optional in-flight cap; concurrency/rate tests; `json_schema` evaluation | Security + load verification; consumer (AetheL M1) regression green |
| 3 | Graduation: proposal → `reference/` Active Plan; AetheL M2 (memory via `/v1/runtime/memory`, Settings model picker) | Gateway canonical; second consumer onboarded |

## Verification

- `local` provider deterministic e2e (no real API keys) for the full endpoint surface.
- Real-provider smoke: non-stream latency ≈ direct non-stream (target < +20% after Phase 1); stream TTFT within +100ms of direct.
- Contract tests for error mapping (400/401/408/502) and SSE framing (`[DONE]`, usage chunk).
- AetheL regression: chat (non-stream + SSE), categorize (JSON mode), snapshot/workshop once M1 lands.
- Existing suites stay green: `npm run typecheck`, `npm test`, format/CI.

## Document Ownership

- Owner: BabeL-O maintainer (gateway feature owner TBD — initial spike by AetheL-side engineer).
- Consumer contract: AetheL `docs/babel-ai-engine.md` (mirrors this plan's endpoint contract).
- This plan follows the proposals lifecycle: graduates to `reference/` on Phase 3, or moves to `archive/` if the gateway direction is dropped.

## 中文概述

### 背景

BabeL-O 的 LLM 管线（provider 注册表 / 适配器 / 重试 / 配置中心）已完整，但只服务自身 agent 运行时；对外没有任何 LLM 网关端点（"gateway" 一词在文档中仅指"出站连接外部网关"）。同品牌产品 AetheL 需要稳定的 AI 引擎，2026-08-04 的可行性 spike 已在 `feat/chat-completions-gateway` 分支验证了 OpenAI 兼容端点全链路（非流式 / SSE 流式 / `response_format` / 模型缺省 / 错误映射 / 并发 5/5），并修复了未知模型 400 缺陷。

### 目标

把网关服务做成 BabeL-O 一等能力：`POST /v1/chat/completions` + `GET /v1/models`，鉴权复用 `NEXUS_API_KEY`，模型选择权留在 BabeL-O 配置（ADR-B2），契约文档化 + `local` provider 集成测试。Phase 1 重点补**非流式快路径**（当前非流式消费者会承担流式延迟：直连非流式 175ms vs 经网关 1135ms，其中上游流式本身即 1246ms）并剖析 TTFT +300ms。

### 边界

网关 = 纯 LLM 传输层，绕过 `LLMCodingRuntime`：无工具循环 / 权限门 / 会话持久化（那是 `/v1/execute` 的职责）；不做 embedding（Phase 1）；不做静默模型切换（与现有策略一致）。

### 里程碑

Phase 0 已落地（spike）；Phase 1 模型列表 + 非流式快路径 + 契约文档 + local 集成测试；Phase 2 鉴权/并发验证；Phase 3 毕业进 `reference/` 并支撑 AetheL M1/M2。首个消费者是 AetheL（`feature/babel-ai-engine` 分支），其 M1 依赖 Phase 1 的契约稳定。
