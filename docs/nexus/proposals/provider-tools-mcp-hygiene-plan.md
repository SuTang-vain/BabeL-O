# Provider / Tools / MCP Hygiene Plan

> State: Draft
> Track: Provider / Tools / MCP
> Priority: P2 — provider identity leaks into "compatible" adapters; duplicated chunker; dead `list_dir` key; eager MCP server spawn blocks registration
> Source of truth: [../TODO.md](../TODO.md), [../active/TODO_provider_registry.md](../active/TODO_provider_registry.md), [../active/TODO_cleanup.md](../active/TODO_cleanup.md), [../DONE.md](../DONE.md), [../WORK_LOG.md](../WORK_LOG.md), `src/providers/adapters/AnthropicAdapter.ts`, `src/providers/adapters/OpenAIAdapter.ts`, `src/runtime/taskScope.ts`, `src/mcp/McpToolAdapter.ts`, `src/mcp/McpRegistry.ts`
> Governance: Indexed by [README.md](../README.md) and [tool-governance-plan.md](../reference/tool-governance-plan.md). Canonical owner of "compatible adapters are provider-neutral, tools are orthogonal, MCP registration is lazy." Adapter robustness corpus stays in [../active/TODO_provider_registry.md](../active/TODO_provider_registry.md); tool orthogonality stays in [tool-governance-plan.md](../reference/tool-governance-plan.md).
> Related: [tool-governance-plan.md](../reference/tool-governance-plan.md), [task-scope-root-inference-reference.md](../reference/task-scope-root-inference-reference.md), [provider-recovery-and-model-catalog-governance-plan.md](./provider-recovery-and-model-catalog-governance-plan.md)

## Purpose

A set of small, independent hygiene fixes across providers, tools, and MCP that are individually low-risk but collectively remove drift sources and a hot-path block. Each is independently landable.

## Current State

- **Provider identity leaks into "compatible" adapters:**
  - `AnthropicAdapter.ts:85-135,502` carries a MiniMax-specific XML text-tool-call parser gated on `providerId === 'minimax'`.
  - `AnthropicAdapter.ts:20-42` has a `MODEL_MAPPING` table covering only 3 legacy Claude models; newer ids fall through to a naive `substring(slashIndex+1)` (`:59`).
  - `OpenAIAdapter.ts:60-68,112-117` injects DeepSeek-specific `reasoning_content` gated on `params.model.includes('deepseek')`.
- **Duplicated chunker:** `chunkTextDelta` (`AnthropicAdapter.ts:158-216`) and `chunkOpenAITextDelta` (`OpenAIAdapter.ts:342-381`) are byte-identical algorithms. `OpenAIAdapter.ts:339-341` admits the duplication is "to avoid a cross-adapter import dependency."
- **Dead `list_dir` key:** `taskScope.ts:20` lists `list_dir` in `TOOL_PATH_KEYS`, but `normalizeToolName` (`taskScope.ts:402-404`) strips `-_\s` and lowercases, so `ListDir`/`list_dir`/`list-dir` all collapse to `listdir`. The `list_dir` key is unreachable.
- **Eager MCP spawn:** `createMcpToolRegistry` (`McpToolAdapter.ts:21-36`) eagerly spawns every configured server and calls `listTools()` synchronously at registry construction — a slow server blocks all tool registration. `dispose()` is per-tool but `client.shutdown()` is shared per-server (idempotent); there is no aggregated `disposeAll`.

## Problem Statement

Provider-specific branches inside "compatible" adapters make the abstraction name false and create drift risk (a MiniMax or DeepSeek change touches the wrong file). A duplicated chunker can silently diverge. A dead key is misleading. Eager MCP spawn is a real startup-latency and robustness hazard (one slow/hung server blocks the whole registry).

## Goals

- "Compatible" adapters contain no `providerId`/model-substring branching; provider-specific parsing is factored into a per-provider strategy/hook.
- One shared text-delta chunker in `src/providers/`.
- `TOOL_PATH_KEYS` contains only reachable keys.
- MCP tool registration is lazy (servers spawn on first use or in parallel with a per-server timeout), not a blocking synchronous fan-out at construction; aggregated `disposeAll` exists.

## Non-goals

- Do not change the adapter wire-protocol translation or the `StreamDelta` shape.
- Do not change MCP JSON-RPC framing or the deny-by-default allowlist.
- Do not remove the MiniMax XML parser or DeepSeek `reasoning_content` support — relocate them, do not delete behavior.

## Design

### Phase 1 — Extract provider-specific adapter hooks

1. Define a small `AdapterProtocolHooks` surface (e.g. `parseTextToolCalls?(raw): ToolUse[]`, `injectReasoning?(payload, delta)`) in `ModelAdapter.ts`.
2. Move the MiniMax XML parser (`AnthropicAdapter.ts:85-135,502`) and the `MODEL_MAPPING` (`:20-42`) into a MiniMax-specific hook/config, keyed off the provider declaration rather than an in-adapter `providerId === 'minimax'` branch.
3. Move the DeepSeek `reasoning_content` injection (`OpenAIAdapter.ts:60-68,112-117`) into a provider hook keyed off the model/provider declaration.
4. The adapter bodies become provider-neutral; the registry wires the hook from the provider config.

### Phase 2 — Shared chunker

1. Move `chunkTextDelta` to `src/providers/textDeltaChunker.ts`. Both adapters import it. Delete `chunkOpenAITextDelta`.

### Phase 3 — Dead key cleanup

1. Remove `list_dir` from `TOOL_PATH_KEYS` (`taskScope.ts:20`). Add a test that every key in `TOOL_PATH_KEYS` survives `normalizeToolName` round-trip (so this cannot regress).

### Phase 4 — Lazy MCP registration

1. `createMcpToolRegistry` returns a registry that spawns each server lazily (on first tool invocation) or in parallel with a per-server `listTools` timeout (default 5s); a slow server degrades only its own tools, not the whole registry.
2. Add `disposeAll()` to the registry that iterates per-server `client.shutdown()`.

## Phases

| Phase | Status | Scope | Exit criteria |
| --- | --- | --- | --- |
| Phase 1 | Draft | Extract MiniMax/DeepSeek adapter hooks; adapters provider-neutral. | No `providerId ===` / `model.includes(...)` branching in adapter bodies; existing adapter + DeepSeek reasoning replay tests green. |
| Phase 2 | Draft | Shared text-delta chunker. | One chunker; both adapters import it; `npm test` green. |
| Phase 3 | Draft | Remove dead `list_dir` key + reachability test. | `TOOL_PATH_KEYS` reachability test green. |
| Phase 4 | Draft | Lazy/parallel MCP spawn + `disposeAll`. | A slow MCP server does not block registry construction; `test/mcp.test.ts` + new timeout test green. |

## Verification

- `npm test` (existing `test/adapters.test.ts`, `test/providers.test.ts`, `test/mcp.test.ts`, `test/bash-classifier.test.ts`, `test/classifier.test.ts` green).
- `npm run test:mcp:official`, `npm run test:providers:smoke`.
- `npm run build:smoke`.

## Document Ownership

- Current priority lives in [../TODO.md](../TODO.md), [../active/TODO_provider_registry.md](../active/TODO_provider_registry.md), and [../active/TODO_cleanup.md](../active/TODO_cleanup.md).
- Completed facts move to [../DONE.md](../DONE.md); factual history to [../WORK_LOG.md](../WORK_LOG.md).

## 中文概述

### 背景

"compatible" 适配器内嵌 provider 身份分支（MiniMax XML 解析、`MODEL_MAPPING`、DeepSeek `reasoning_content`），名不副实；`chunkTextDelta` 跨适配器逐字节重复；`taskScope.ts` 的 `list_dir` 键因 `normalizeToolName` 折叠而不可达；MCP registry 建期同步 spawn 全部 server + `listTools()`，慢 server 阻塞全部工具注册。

### 核心做法

Phase 1 把 provider 专属解析抽成 `AdapterProtocolHooks`，适配器体变 provider-neutral；Phase 2 抽共享 chunker；Phase 3 删死键 + 加可达性测试；Phase 4 MCP 注册改惰性/并行 + per-server 超时 + `disposeAll`。

### 当前状态

草案。四项互相独立、各自低风险，可分别小切片落地。P2 优先级。

### 下一步

最小切片：Phase 2 共享 chunker 或 Phase 3 删死键——零行为变更、最低风险，先消除漂移/误导源。
