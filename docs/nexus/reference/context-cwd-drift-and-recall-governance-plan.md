# Context CWD Drift And Recall Governance Plan

> State: Active Plan
> Track: Context / Runtime / Task Scope / Session Recall
> Priority: P1 (Phase A + Phase A Follow-up + Phase B + Phase C1 收口 2026-06-18; Phase C2 / D / E / F Open)
> Source of truth: `docs/nexus/reference/context-governance-index.md`, `docs/nexus/proposals/long-running-context-assembly.md`, `src/runtime/LLMCodingRuntime.ts`, `src/runtime/systemPromptBuilder.ts`, `src/runtime/taskScope.ts`, `src/runtime/contextAssembler.ts`, `src/tools/builtin/contextSearch.ts`, `src/tools/builtin/contextRecent.ts`
> Governance: Indexed by [context-governance-index.md](./context-governance-index.md). This document owns the regression plan for prompt-derived cwd drift, context-estimate calibration, storage-backed session recall tools, and user-artifact continuity.
> Related: [context-governance-index.md](./context-governance-index.md), [long-running-context-assembly.md](./long-running-context-assembly.md), [runtime-tool-loop-governance-plan.md](./runtime-tool-loop-governance-plan.md), [task-scope-and-evidence-scope-governance-plan.md](./task-scope-and-evidence-scope-governance-plan.md)

**Status (2026-06-18)**: upgraded from Draft to Active Plan on 2026-06-17. **Phase A 收口** — `extractAbsolutePaths()` 在 `src/runtime/systemPromptBuilder.ts:216` 增加 `isCjkOnlyNonExistentPath()` 守卫，CJK-only basename + 不存在的 candidate 整段丢弃；`test/system-prompt-builder.test.ts` 加 4 个 focused test（`文档/信息` / `/信息` / `/信息/归档` 全部不进 explicit paths；`/etc/hosts` 与 CJK prose 混排时仍保留真实路径）。Phase A 下游链路 integration 收口 — `resolveCwdFromPrompt` 已 export 供测试，`test/runtime.test.ts` 加 3 个 test 守 `session_981cc5c2` 的两个失败点：cwd 不漂到 `/`（event_seq=9447）+ `task_scope_declared.primaryRoot` 保持项目根（event_seq=9449），并加真实存在 path 仍正常 resolve 的防 over-filtering 守卫。**Phase A Follow-up 收口（2026-06-18）** — 复盘 `session_cf361f04` 后定位 5 类 prose-path 漏出 + 1 类 false-negative + 1 类 path-splitting + `LocalCodingRuntime.storage` optional 根因，在 `src/runtime/systemPromptBuilder.ts` 增强 `extractAbsolutePaths()`：① URL/protocol-relative URL 在 pathPattern 之前先丢弃；② 单段 bare Latin word prose (`/while`、`/memory`)、CJK + Common (含 em-dash)、CJK + Latin 混排、CJK 两段 prose 在非存在时整段丢弃；③ 实存绝对路径短路（`/etc/hosts` / `/bin/bash` / `iCloud\ Documents`），不再被 prose guard 误杀；④ shell escape `\ ` 通过 SPACE_MARK 哨兵保留为单一 candidate。`createDefaultToolRegistry({ storage })` 新增 storage 哨兵（`storage: null` → 隐藏 `contextSearch` / `contextRecent` / `contextSummarize`），`createRuntime.ts` / `AgentScheduler.ts` / `runnerComparisonBenchmark.ts` 三个调用点全部更新；`test/runtime.test.ts` + 1 个新增 `test/runtime-context-tools-registry-gate.test.ts` 共 11 个 test 守住 `session_cf361f04` 全部失败点。**Phase C1 已在代码中收口（prior）** — `src/tools/builtin/contextSearch.ts:39-45` 与 `contextRecent.ts:35-41` 已检查 `context.storage`、返回 `CONTEXT_STORAGE_UNAVAILABLE` + `repairHint`；`maxTokens.max(5000)` schema 强制；model prompt 明确 `default 5000`。**Phase B 收口（2026-06-18）** — `src/runtime/sessionRootContinuity.ts` 新增纯 decision helper（4 decision × 9 reason），`SessionRootContinuityEventSchema` 加入 `NexusEventSchema` discriminated union，`LLMCodingRuntime` 在 `hasSessionContext` 时调用 `resolveCwdWithContinuity()` 并 yield `session_root_continuity` event，`RuntimeExecuteOptions` 新增 `storedSessionCwd` / `latestTaskPrimaryRoot` / `acceptExternalPromptPath` 三个 optional 字段，`AgentTrace` 投影把最近一条 continuity event 上浮为 run span 的 `lastContinuity*` 6 个 attributes。`test/session-root-continuity.test.ts` 17/17 pass + `test/runtime.test.ts` +5 + `test/inspect-session.test.ts` +1 守住 `session_cf361f04` 的 cwd 切换面。**Phase C2 / D / E / F 仍 Open**：C2 是 Nexus/LLMCodingRuntime 执行入口把 `options.storage` 注入 `RuntimeExecuteOptions.storage`，D 是 `ContextEstimateCalibration` diagnostic（provider usage vs local estimate 2x ratio 触发 warn），E 是 `ROOT_SCAN_REQUIRES_CONFIRMATION` 工具层 guard，F 是 `UserArtifactContinuity`（长文粘贴 / 文件路径 / “这个文章”跨 turn 指代锚定）。2026-06-18 补充 `session_cf361f04-7ab1-43a5-907a-41a808942686` 作为第二真实 regression：URL 被误识别为 protocol-relative path、`Mobile\ Documents` 被拆坏、外部文章路径替换 project root、`contextRecent` storage unavailable 后最终回答遗忘文章。2026-06-18 通过对 `extractAbsolutePaths()` + `resolveCwdFromPrompt()` + `LocalCodingRuntime.storage` 的端到端复盘，定位到 Phase A follow-up 仍需 4 类补刀（见 §10.1 详细证据），并在 §10.2 确认 `LocalCodingRuntime` 的 optional storage 是 session_cf361f04 seq=16671 `CONTEXT_STORAGE_UNAVAILABLE` 的真实根因。2026-06-18 追加 `session_10320709-2b06-405f-8f51-d954435d4a70` 作为第三真实 regression：SQLite event storage 存在、权限审计可写，但 `contextSearch` / `contextRecent` 在 LLMCodingRuntime/Nexus 热路径仍拿不到 `context.storage`，见 §11。2026-06-18 §12 把 session_10320709 拆成 3 bug（cwd 漂 `~/Library` / Phase B Nexus 接线缺 storedSessionCwd / LLMCodingRuntime 缺 storage 注入）。2026-06-18 §13 二次复盘修正 §12：真实 prompt 用**普通空格**（非 `\ ` escape，SPACE_MARK 修错目标）、**一条 iCloud 路径拆成 2 candidate**（cwd + 垃圾 explicitRoot）、`/Users/tangyaoyue/Library/Mobile` **不存在**（暴露 Site A `resolveExplicitPromptCwd` 与 Site B `resolveCwdFromPrompt` **两 resolution site 不一致** = Bug 4）、drift **跨 turn 2-6 持续**（session.cwd 每 turn 被覆写）、turn 7 用户重述项目路径自愈。Bug 1 从 P1 提升到 **P0**（cwd 漂移 load-bearing fix），修法改为双层：Layer A quote-delimited span 优先识别 + Layer B 共享 `isAcceptablePromptCwd` 拦系统目录（两 site 都用）。Bug 2 fix 修正为需要不可变 `sessions.origin_cwd`（`session.cwd` 本身已漂）。下游损害清单：8 GLOB_FAILED（ripgrep 撞 `~/Library/Caches` 权限拒绝整段失败，非 partial——独立工具鲁棒性 follow-up）+ 3 parent_scan + 6 WEB_SEARCH_FAILED（独立网络问题）+ 1 幻觉路径拼接 + turn 1 contextCharsIn=992400 浪费。

## Existing Entry Points

| 代码位置 | 角色 | 状态 |
|---|---|---|
| `src/runtime/systemPromptBuilder.ts:216` `extractAbsolutePaths()` | prompt → explicit paths 提取 | Phase A 收口 |
| `src/runtime/systemPromptBuilder.ts:237` `resolvePromptPath()` | CJK 后缀 fallback（prefix ≥ 50% 才认） | 既有 |
| `src/runtime/systemPromptBuilder.ts:227` `normalizeWrappedPathFragments()` | terminal-wrapped path fragment 归一化 | 既有（session-replay Phase H 收口） |
| `src/runtime/LLMCodingRuntime.ts:1278` `resolveCwdFromPrompt()` | prompt 路径 → cwd 解析；机械 map over `extractAbsolutePaths()` | 既有，行为随 Phase A 收口变正确 |
| `src/runtime/LLMCodingRuntime.ts:230-234` `runExecuteStreamInner` | 把 `resolveCwdFromPrompt` 结果写入 `options.cwd` | 既有 |
| `src/runtime/taskScope.ts:32` | `task_scope_declared` 信任 `extractAbsolutePaths()` 派生 root | 既有 |
| `src/runtime/intentGuidance.ts:233` | `explicitPaths` 同样走 `extractAbsolutePaths()` | 既有 |
| `src/tools/builtin/contextSearch.ts:39-45` | storage unavailable → `CONTEXT_STORAGE_UNAVAILABLE` + repair hint | Phase C 收口 |
| `src/tools/builtin/contextRecent.ts:35-41` | 同上 | Phase C 收口 |
| `src/runtime/contextAnalysis.ts:1100` | runtime 端 `extractAbsolutePaths` 调用 | 既有 |

## Design Principles

1. **Runtime owns scope authority** — cwd / task_scope / explicit_paths 全部由 runtime 派生；CLI / TUI 不接管 scope 决策。
2. **Prompt-derived path is hint, not order** — `extractAbsolutePaths()` 提取的 candidate 必须经存在性 + CJK basename + parent fallback 三道校验；任何"自然语言 slash 短语"不得被提升为路径。
3. **Recall tools follow storage contract** — `contextSearch` / `contextRecent` 在 storage 缺失时必须返回显式 `CONTEXT_STORAGE_UNAVAILABLE` + repair hint，不静默回退到 visible context。
4. **Calibration diagnostic precedes policy change** — provider usage vs local estimate 的偏差先 emit diagnostic 观察至少 1 个真实 session，再调整 compact 阈值，不直接改 compact 行为。

## Purpose

This proposal defines a focused governance path for three context-management regressions observed in a real local session:

1. prompt-derived cwd drift from a project root to `/`;
2. runtime context estimates diverging from provider-reported input token usage;
3. session recall tools becoming unavailable exactly when a "do you remember" turn needs them.

The goal is not to redesign context management. The goal is to make existing runtime-owned context facts, task scope, and on-demand session recall agree with each other in long interactive sessions.

## Current State

BabeL-O already has:

- `task_scope_declared` per turn;
- context usage events and execution metrics;
- provider-reported `usage` and runtime `execution_metrics`;
- `contextSearch` and `contextRecent` tools for on-demand session history lookup;
- path extraction and prompt-derived cwd normalization;
- workspace/task-scope boundary detection;
- recoverable tool errors and structured tool failure outputs.

The observed regression shows that these components can still disagree:

- `LLMCodingRuntime.runExecuteStreamInner()` may update `options.cwd` from `resolveCwdFromPrompt(options.prompt, options.cwd)`.
- `task_scope_declared` then trusts the changed cwd and may declare `/` as the primary root.
- File-discovery tools can run from `/` or `/Users`, creating huge failure output and irrelevant evidence.
- `context_usage` can report a low local estimate while provider usage later reports a much larger actual input token count.
- `contextSearch` / `contextRecent` can return `CONTEXT_STORAGE_UNAVAILABLE`, so a recall turn falls back to visible context instead of authoritative session events.

## Problem Statement

The trigger sample is `session_981cc5c2-230c-40d1-953c-b956e9dbaaf7`.

Observed timeline:

| Event range | Observation |
| --- | --- |
| `event_seq=1..7854` | Session starts under `/Users/tangyaoyue/DEV/BABEL/BabeL-O` or `docs/nexus`; task scope stays within the project root. |
| `event_seq=9447` | `session_started.cwd` becomes `/`. |
| `event_seq=9448` | `user_intake_guidance.explicitPaths` contains `["/信息"]`, derived from the Chinese phrase `文档/信息`. |
| `event_seq=9449` | `task_scope_declared.primaryRoot` becomes `/`. |
| `event_seq=9512..9524` | `Glob` / `Grep` run against `/` and `/Users`, producing permission errors and `stdout maxBuffer length exceeded`. |
| `event_seq=11337` | `execution_metrics.inputTokens=893794`, while local context usage peaked around `412928/852000` before the provider call. |
| `event_seq=16783..17046` | User asks whether the assistant remembers the original context-management discussion; `contextSearch` first fails schema with `maxTokens=8000`, then fails with `CONTEXT_STORAGE_UNAVAILABLE`; `contextRecent` also fails with `CONTEXT_STORAGE_UNAVAILABLE`. |

The user-visible failure is subtle: the session finishes successfully, but the answer is less grounded than it should be. It is shaped by residual context and broad filesystem search instead of stable session recall.

### Second Trigger Sample: `session_cf361f04-7ab1-43a5-907a-41a808942686`

This session extends the regression from "CJK slash fragment promoted to `/`" to a broader continuity failure: a pasted article, URL-heavy prose, an escaped iCloud file path, and storage-unavailable recall combined to make the final turn forget an article that had already been pasted and read.

Observed timeline:

| Event range | Observation |
| --- | --- |
| `event_seq=1..2612` | First three turns run under `/Users/tangyaoyue/DEV/BABEL/BabeL-O`; `task_scope_declared.primaryRoot` stays on the project root. |
| `event_seq=2613..2616` | User pastes a long OpenRath article and asks whether the article's ideas match the project. `user_intake_guidance.explicitPaths` includes URL/prose false positives such as `//www.openrath.com/`, `//docs.openrath.com/`, `/memory/`, `/while`, and `/.openrath/config.json`; `session_started.cwd` becomes `//` and `task_scope_declared.primaryRoot` normalizes to `/`. |
| `event_seq=8213..8216` | User corrects the target: "是与babel-o项目的相似性". The request still runs under `/`, so project-root continuity is not restored. |
| `event_seq=11761..11764` | User supplies the article file path `/Users/tangyaoyue/Library/Mobile\ Documents/com~apple~CloudDocs/.../上百个Agent...md`. Path extraction splits it into `/Users/tangyaoyue/Library/Mobile\` and `/com~apple~CloudDocs/家人共享/上百个Agent`; task scope shifts to `/Users/tangyaoyue/Library` with a broken explicit root. |
| `event_seq=11949` | The file-path turn is cancelled by `TOOL_CALL_TEXT_LEAK_SUPPRESSED` because the turn was classified as tools-unavailable while the provider attempted tool-call-shaped text. |
| `event_seq=12763` | A later "继续任务" turn successfully reads the article from the exact iCloud path and compares it with BabeL-O, but the article is not promoted into a durable user-artifact anchor. |
| `event_seq=13095..13100` | Because the active root is `/Users/tangyaoyue/Library`, searching back toward BabeL-O triggers a parent-scan boundary for `/Users/tangyaoyue`; approval expands the session scope toward the home directory instead of restoring the project root as primary. |
| `event_seq=16592..17120` | User asks for the article's implications for BabeL-O. `contextRecent` fails with `CONTEXT_STORAGE_UNAVAILABLE`; the model falls back to `ls` / `Glob` under `/Users/tangyaoyue/Library`, then answers that it cannot see the article in current context. |

Additional metrics:

- The long article / comparison turns showed provider input usage around `535024`, `556759`, and `596727` tokens while local `context_usage` estimates peaked around `115842` to `120800` tokens. The provider/local ratio was roughly 4.6x to 4.9x, and no context warning or compaction event was emitted.
- The final failure turn was not token-pressure-driven: provider input was only around `27721` tokens. The failure was a context-selection / recall failure after prior material had fallen out of the active prompt and `contextRecent` was unavailable.
- The session demonstrates that a successful prior tool read is not enough. A user-supplied article must become an addressable session artifact, so later phrases such as "这个文章" resolve to that artifact even when full text is no longer in the visible prompt.

Required regression additions:

- URL and protocol-relative strings (`https://...`, `//host/path`) must not become local path candidates for cwd resolution.
- Escaped-space absolute paths such as `Mobile\ Documents/...` must be parsed as one path span.
- Pasted long-form content plus a later file path for the same content should merge into one `user_artifact` identity.
- When a turn refers to "this article / 这个文章 / 上文文章", context assembly should surface the artifact summary, source path, and latest verified read result before broad filesystem search.
- `contextRecent` / `contextSearch` unavailable must remain provider-visible, but the recovery instruction should prefer artifact/session anchors and verified project roots, not home-directory discovery.

### Third Trigger Sample: `session_10320709-2b06-405f-8f51-d954435d4a70`

This session proves that Phase C1's tool-local storage gate is not enough. The database has a durable event stream, Nexus can persist permission audits and execution metrics, and context tools are visible to the provider, but `contextSearch` / `contextRecent` still fail because the tool execution context receives no `storage`.

Observed facts:

| Event range | Observation |
| --- | --- |
| Session row | `cwd=/Users/tangyaoyue/DEV/BABEL/BabeL-O/docs/nexus`, `phase=completed`, `created_at=2026-06-18T01:39:07.513Z`, `updated_at=2026-06-18T01:55:28.942Z`. |
| Event count | SQLite `events` contains `15914` rows for this session, so event storage itself exists and is readable outside the runtime. |
| `event_seq=10049..10050` | `contextSearch({"query":"BabeL-O multi agent architecture analysis","maxTokens":5000})` returns `success=false`, `code=CONTEXT_STORAGE_UNAVAILABLE`, `message="storage not available in tool context"`. Input is schema-valid. |
| `event_seq=15071..15072` | `contextRecent({"n":10})` returns the same `CONTEXT_STORAGE_UNAVAILABLE`. |
| `event_seq=15102..15103` | `contextSearch({"query":"优化草案","maxTokens":3000})` again returns `CONTEXT_STORAGE_UNAVAILABLE`. |
| `event_seq=265..270`, `6115..6120`, `10308..10313` | Scope-boundary permission flow persists permission requests/responses and confirmations, proving the runtime has a usable `options.storage` side channel for governance writes. |
| `event_seq=3911`, `14506`, `15913` | `execution_metrics` are persisted, further proving storage is available at the Nexus/session layer. |

Root-cause chain:

1. Nexus owns a valid `options.storage` and appends events to SQLite.
2. `src/nexus/app.ts` HTTP and WebSocket execution paths call `options.runtime.executeStream({ ... })` without `storage: options.storage`.
3. `LLMCodingRuntime` has `this.storage`, and passes it to `executeProviderToolCall({ storage: this.storage, runtimeOptions: options, ... })`.
4. `executeProviderToolCall` uses its separate `options.storage` for permission audit and scope-boundary persistence, so governance writes still succeed.
5. Actual tool execution calls `executeToolSafely(tool, toolInput, runtimeOptions, ...)`.
6. `executeToolSafely` builds the tool context from `RuntimeExecuteOptions` only: `storage: options.storage`.
7. Because `runtimeOptions.storage` was never filled by Nexus or normalized by `LLMCodingRuntime`, the tool sees `context.storage === undefined`.
8. `contextSearch` / `contextRecent` correctly return `CONTEXT_STORAGE_UNAVAILABLE`.

This is a distinct bug from the `LocalCodingRuntime.storage` optional issue recorded in §10.3. The earlier issue is about local-mode runtime construction with no storage. This one is about the LLMCodingRuntime/Nexus hot path having storage in the app and runtime instance, but not copying it into the specific `RuntimeExecuteOptions` object consumed by `executeToolSafely`.

Required regression additions:

- Nexus HTTP execute path must pass `storage: options.storage` into `runtime.executeStream`.
- Nexus WebSocket execute path must pass `storage: options.storage` into `runtime.executeStream`.
- `LLMCodingRuntime.runExecuteStreamInner` should defensively normalize `options.storage ??= this.storage` before any tool call.
- `executeProviderToolCall` should defensively merge the separate `options.storage` into a runtime options object used by `executeToolSafely`.
- Tests must cover the asymmetry: permission audit storage works while context tool storage is missing, so future regressions cannot hide behind successful governance writes.

## Goals

- Prevent prompt-derived cwd changes from promoting non-existent or linguistic slash fragments such as `/信息` to task root.
- Preserve the prior verified project root when continuing a session, unless the user explicitly asks to switch workspace or confirms a scope boundary.
- Detect and record significant divergence between local context estimates and provider-reported input tokens.
- Ensure `contextSearch` and `contextRecent` have storage in LLM runtime tool execution, or hide/degrade them with honest diagnostics when storage is unavailable.
- Add a small regression corpus based on this session that covers cwd drift, context estimate calibration, and recall-tool availability.
- Preserve user-supplied long-form artifacts across turns, including pasted text, later file paths, and deictic references such as "这个文章".

## Non-goals

- Do not remove prompt-derived cwd resolution entirely; explicit real paths should still help route a task.
- Do not treat `/` as invalid in every case. The user may explicitly ask to inspect root-level paths, but that must be explicit and governed.
- Do not add broad filesystem search tools.
- Do not make contextSearch a hidden memory source. It remains an on-demand session event locator.
- Do not auto-compact solely because one provider usage event is high; first introduce calibration diagnostics and conservative policy inputs.
- Do not move task-scope decisions into CLI or Go TUI. Runtime remains the scope authority.

## Design

### 1. Prompt Path Classification Hardening

Path extraction should distinguish:

| Candidate | Classification | Behavior |
| --- | --- | --- |
| `/Users/.../BabeL-O/docs/nexus` | absolute existing path | May influence cwd / explicit roots. |
| `./docs/nexus` | relative existing path | May influence cwd under current workspace. |
| `docs/nexus` | relative project path | May influence explicit roots after existence check. |
| `文档/信息` | natural-language slash fragment | Must not become `/信息`. |
| `/信息` | non-existent root-level path from text fragment | Must not overwrite cwd. |
| `/` | explicit root path | Requires explicit user intent and should be treated as broad scope. |

Proposed rule:

1. `extractAbsolutePaths()` may still identify path-like spans, but `resolveCwdFromPrompt()` must not accept a prompt-derived absolute path unless at least one of these is true:
   - it exists;
   - it starts with the current cwd, session project root, or a configured allowed root;
   - the user text explicitly uses a path operation around it, such as `path: /...`, `cwd=/...`, `open /...`, `read /...`, `查看 /...`, or a fenced/code-formatted path.
2. If the only candidate is a non-existent root-level path with a CJK basename, keep the previous cwd and emit a path-drift diagnostic rather than mutating cwd.
3. If prompt-derived cwd would become `/`, require an explicit root intent. Otherwise keep the prior session root.

### 2. Session Root Continuity

When continuing an existing session, runtime should derive a stable root stack:

```ts
type SessionRootContinuity = {
  requestCwd: string
  storedSessionCwd?: string
  latestTaskPrimaryRoot?: string
  promptPathCandidates: string[]
  resolvedCwd: string
  decision: 'keep_request_cwd' | 'use_prompt_path' | 'keep_session_root' | 'require_confirmation'
  reason: string
}
```

Policy:

- If a session has a non-root project cwd or latest `task_scope_declared.primaryRoot`, prefer that over a prompt-derived `/`.
- If the prompt explicitly names a path inside the project, keep the project root as `cwd` and record the path as an explicit root/candidate.
- If the prompt explicitly names an outside existing path, use existing task-scope boundary flow rather than silently changing cwd.

### 3. Provider Usage Calibration

Runtime already records local `context_usage` and provider `usage`. Add a calibration diagnostic after provider usage is known:

```ts
type ContextEstimateCalibration = {
  localEstimateTokens: number
  providerInputTokens: number
  ratio: number
  effectiveContextCeiling: number
  exceededCeiling: boolean
  requestId: string
  action: 'none' | 'warn' | 'conservative_next_turn' | 'force_context_review'
}
```

Initial thresholds:

- `ratio >= 2.0`: emit warning-level diagnostic.
- `providerInputTokens >= effectiveContextCeiling`: emit high-severity diagnostic and mark next turn for conservative context refresh.
- `providerInputTokens >= contextCompactThresholdTokens`: recommend compact/context review even if local estimate was lower.

This should not immediately change compact behavior until regressions prove the thresholds are stable.

### 4. Recall Tool Storage Contract

`contextSearch` and `contextRecent` are only useful if storage is attached. In an `LLMCodingRuntime` instance that has storage, tool execution must pass that storage to `executeToolSafely()`.

Acceptance condition:

- A provider call to `contextSearch` in `LLMCodingRuntime` can read the current session's event stream.
- If a future runtime has no storage, these tools should either be hidden from the provider or return a single stable diagnostic explaining why session recall is unavailable.

The model-visible prompt for `contextSearch` should also emphasize `maxTokens <= 5000`, because this session showed the model first attempted `maxTokens=8000`.

Implementation split:

- **Phase C1**: tool-local contract. Context tools detect missing `context.storage` and return explicit `CONTEXT_STORAGE_UNAVAILABLE` with a repair hint. This is already closed.
- **Phase C2**: runtime propagation contract. Every runtime path that exposes context tools must either pass storage into `RuntimeExecuteOptions.storage` or hide the tools. This remains open after `session_10320709`.

Phase C2 acceptance condition:

- If a session has persisted events and the provider can see `contextSearch` / `contextRecent`, those tools must receive the same storage object used by Nexus to append events.
- A successful permission audit or `scope_boundary_confirmed` write does not prove context-tool storage propagation; tests must assert the tool context itself.

### 5. Broad Root Search Guard

When task scope primary root is `/` because of prompt-derived cwd, broad file-discovery tools become hazardous and noisy. Add a runtime-side guard before tool execution:

- If `primaryRoot === '/'` and the tool is `Glob`, `Grep`, `ListDir`, or `Read`, require explicit user root intent or a non-root target path.
- If the tool target is `/` or `/Users` and no explicit root intent exists, return recoverable `ROOT_SCAN_REQUIRES_CONFIRMATION`.
- The result should instruct the provider to search the verified project root or use `contextSearch` for session history.

This is not a permission prompt by default; for accidental root drift, a recoverable tool result is enough.

### 6. User Artifact Continuity

Long pasted content and user-supplied file paths should be modeled as task artifacts, not just transient prompt text or incidental tool inputs.

Suggested shape:

```ts
type UserArtifactContinuity = {
  artifactId: string
  kind: 'article' | 'document' | 'code_excerpt' | 'dataset' | 'unknown'
  aliases: string[]
  promptEventSeqs: number[]
  sourcePaths: string[]
  verifiedReadEventSeqs: number[]
  summary?: string
  linkedProjectRoot?: string
  lastMentionedAt: string
}
```

Policy:

- When a user pastes long prose with URLs and asks for analysis, create a volatile session artifact summary even before any file read.
- When the user later supplies a path that appears to name the same article, merge it into the existing artifact rather than replacing `primaryRoot`.
- When a later prompt uses deictic references such as "这个文章", "上面的文章", "the article", or the article filename, context assembly should include the artifact summary, source path, and last verified read result.
- Artifact source paths may expand evidence roots, but they must not silently replace the project root. In a "what does this mean for BabeL-O" task, BabeL-O remains the primary root and the article is an external evidence artifact.
- If artifact text is no longer in active context and recall storage is unavailable, the provider-visible diagnostic should say which artifact identity exists and what recovery action is available, rather than simply concluding the article is absent.

## Phases

### Phase A — Prompt Path Classification Hardening — ✅ 收口（2026-06-17）

**Status (2026-06-17)**: ✅ 收口。

- **实现**:
  - `src/runtime/systemPromptBuilder.ts:216` `extractAbsolutePaths()` 增加 `isCjkOnlyNonExistentPath()` 守卫：candidate 路径 basename 若全部由 Han 字符组成且路径本身不存在，整段丢弃。
  - `resolvePromptPath()` 既有 CJK 后缀 fallback（prefix ≥ 50% 长度）保留不动 — 它处理"已存在 prefix + CJK 后缀"的渐进查找，与新守卫互补不冲突。
- **覆盖样本**:
  - `文档/信息` → `extractAbsolutePaths()` 返回 `[]`（不再把 `/信息` 当成 explicit path）。
  - `/信息` standalone → 返回 `[]`。
  - `/信息/归档` 多段 → 返回 `[]`。
  - `/etc/hosts` 与 `文档/信息` 混排 → 只保留 `/etc/hosts`。
- **验证**:
  - `npx tsx --test test/system-prompt-builder.test.ts` 28/28 pass（unit：`extractAbsolutePaths` CJK-only 4 case）。
  - `npx tsx --test test/runtime.test.ts` 新增 3 个 integration test 守下游链路：`resolveCwdFromPrompt` CJK fragment 保持 project cwd（event_seq=9447）、`deriveTaskScope` 保持 single-root（event_seq=9449）、真实存在 path 仍正常 resolve（防 over-filtering）。
  - `npx tsc --noEmit`：除 pre-existing `inspectSession.ts:231` 外 0 errors。
- **影响**:
  - `resolveCwdFromPrompt()`（已 export 供测试）输入端不再含 `/信息`，机械 map 退化为返回 `baseCwd`，cwd 不再被静默推到 `/`。
  - `taskScope.ts` / `intentGuidance.ts` / `workingSet.ts` / `contextAnalysis.ts` 全部复用同一 `extractAbsolutePaths()`，单一 source of truth。

### Phase B — Session Root Continuity — ✅ 收口（2026-06-18）

**Status (2026-06-18)**: ✅ 收口。

- **已落地位置**:
  - `src/runtime/sessionRootContinuity.ts` — 纯 decision helper（pure projection，无第二 source of truth）。4 个 decision × 9 个 reason 的 vocabulary 收口在 `SESSION_ROOT_DECISIONS` / `SESSION_ROOT_REASONS` 两个 readonly 数组。
  - `src/shared/events.ts` — 新增 `SessionRootContinuityEventSchema`，加入 `NexusEventSchema` discriminated union。
  - `src/runtime/LLMCodingRuntime.ts:1402-1431` — `resolveCwdWithContinuity()` export。`runExecuteStreamInner()` 在 `hasSessionContext` 时调用 continuity-aware resolver 并 yield `session_root_continuity` event。
  - `src/runtime/Runtime.ts:67-85` — `RuntimeExecuteOptions` 新增 3 个 optional 字段：`storedSessionCwd` / `latestTaskPrimaryRoot` / `acceptExternalPromptPath`。
  - `src/runtime/agentTrace.ts:99-122` — AgentTrace 投影把最近一条 `session_root_continuity` event 上浮为 run span 的 `lastContinuityDecision` / `lastContinuityReason` / `lastContinuityResolvedCwd` / `lastContinuityWasProjectRootKept` / `lastContinuityIsExternalRoot` / `lastContinuityMessage` 6 个 attributes。`bbl inspect-session <id> --trace` 因此可以直接从 run span 读到 decision，无需 grep 原始 event stream。
- **守住边界**:
  - 默认不接收外部 prompt path（`acceptExternalPromptPath` 默认 false）— `bbl go` 之类 opt-in 流程需要显式 `--external-ok` 才会切换 cwd。
  - `hasSessionContext` 为 false 时回落到 2-arg `resolveCwdFromPrompt` 旧路径（back-compat）。
  - 不引入新持久化字段；`SessionRootContinuity` 是从 `storedSessionCwd` / `latestTaskPrimaryRoot` / 现有 `extractAbsolutePaths` 投影出来的纯函数。
- **不替代 Phase F**: artifact continuity（"这个文章"指代锚定）仍归 Phase F；Phase B 只决定"这一次 cwd 怎么算"。

### Phase C1 — Recall Tool Storage Gate — ✅ 收口（prior, 2026-06-17 同步）

**Status (2026-06-17)**: ✅ 收口（计划升级时回溯标记；实际代码先于本 plan 落地）。

- **已落地位置**:
  - `src/tools/builtin/contextSearch.ts:39-45` — `if (!context.storage)` 返回 `CONTEXT_STORAGE_UNAVAILABLE` + `repairHint: 'Continue from visible session context, or retry contextSearch in a runtime with storage attached.'`
  - `src/tools/builtin/contextRecent.ts:35-41` — 同上语义。
  - `src/tools/builtin/contextSearch.ts:17` / `contextRecent.ts:17` — `maxTokens: z.number().int().positive().max(5000).optional()` schema 强制。
  - `src/tools/builtin/contextSearch.ts:33` model prompt 明确 `maxTokens caps the response (default 5000)`。
- **未触动**: storage contract 的实现语义、schema、model prompt 全部 back-compat；此阶段只保证工具在 `context.storage` 缺失时显式失败，不保证所有 runtime path 都已把 storage 注入 tool context。
- **守住边界**: 继续在 storage 缺失时返回显式 `CONTEXT_STORAGE_UNAVAILABLE`；不静默 fallback 到 visible context；不把 `contextSearch` 升级为 hidden memory source（仅 on-demand session event locator）。

### Phase C2 — Runtime Storage Propagation — Open

- **范围**: 打通 Nexus / LLMCodingRuntime / runtimeToolLoop / executeToolSafely 的 storage 传递链，确保 provider-visible context tools 在 storage-backed session 中必定拿到 `ToolContext.storage`。
- **触发样本**: `session_10320709-2b06-405f-8f51-d954435d4a70` 中 SQLite events 有 15914 条、permission audit 可写，但 `contextSearch` / `contextRecent` 仍返回 `CONTEXT_STORAGE_UNAVAILABLE`。
- **最小修复面**:
  - `src/nexus/app.ts` HTTP execute path: `runtime.executeStream({ ..., storage: options.storage })`。
  - `src/nexus/app.ts` WebSocket execute path: 同步传 `storage: options.storage`。
  - `src/runtime/LLMCodingRuntime.ts`: 在 `runExecuteStreamInner()` 开头归一化 `options.storage ?? this.storage`，防止非 Nexus 调用路径遗漏。
  - `src/runtime/runtimeToolLoop.ts`: 调 `executeToolSafely` 前用 `{ ...runtimeOptions, storage: runtimeOptions.storage ?? options.storage }` 作为防御式合并。
- **测试要求**:
  - 用 `MemoryStorage` 种入当前 session events，经 `LLMCodingRuntime` provider tool call 调 `contextRecent` 必须成功。
  - 用 Nexus HTTP/WS execute path 触发 context tool，断言 tool result 不再是 `CONTEXT_STORAGE_UNAVAILABLE`。
  - 加负例：`createDefaultToolRegistry({ storage: null })` 仍隐藏 context tools，避免无 storage runtime 暴露必败工具。

### Phase D — Provider Usage Calibration — Open

- **范围**: `ContextEstimateCalibration` 类型 + emit 阈值（`ratio >= 2.0` warn / `providerInputTokens >= effectiveContextCeiling` high-severity / `providerInputTokens >= contextCompactThresholdTokens` recommend compact）。
- **不立即改 compact 行为**：先观察至少 1 个真实 session 验证阈值稳定，再评估 auto-compact policy input。
- **触发条件**: 真实 session 暴露 provider usage 持续 2x 偏离 local estimate 时推进。

### Phase E — Broad Root Search Guard — Open

- **范围**: 工具执行前检查 `primaryRoot === '/'` + tool ∈ {Glob, Grep, ListDir, Read} → return recoverable `ROOT_SCAN_REQUIRES_CONFIRMATION`。
- **不引入 permission prompt**: 对 accidental root drift，可恢复工具结果足够。
- **触发条件**: 真实 session 触发 `/` / `/Users` broad scan 时推进（Phase A 收口后此类触发应已显著减少）。

### Phase F — User Artifact Continuity — Open

- **范围**: 为 session 内长文粘贴、用户给出的本地文件路径、后续"这个文章"指代建立 volatile artifact anchor；context assembly 在相关 turn 注入 artifact 摘要 / source path / last verified read event。
- **不替代 memory**: artifact continuity 只服务当前 session，不写入 EverCore，不作为长期事实来源。
- **不改变 primaryRoot 语义**: 外部文章路径进入 evidence/artifact roots；项目问题继续以 BabeL-O project root 为 primary root。
- **触发样本**: `session_cf361f04-7ab1-43a5-907a-41a808942686` final turn 在 `contextRecent` unavailable 后遗忘已粘贴和已读取的文章。

## Test Plan

按 focused / integration / e2e 三层：

**Focused (unit) — `test/system-prompt-builder.test.ts`**
- ✅ `extractAbsolutePaths` 丢弃 CJK-only non-existent candidate（4 个 case：fragment / root / multi-segment / 真实路径混排）。
- ✅ 既有 `normalizeWrappedPathFragments` 测试不退化。
- `extractAbsolutePaths` 不把 URL / protocol-relative URL (`https://www.openrath.com/`, `//docs.openrath.com/`) 作为本地 cwd candidate（Phase A follow-up）。
- `extractAbsolutePaths` / prompt path span parser 保留 escaped-space absolute path（`/Users/.../Mobile\ Documents/...`）为单一 candidate（Phase A follow-up）。

**Focused (unit) — `test/session-root-continuity.test.ts`**（Phase B 收口时新增 17 个 test）
- ✅ Vocabulary：`SESSION_ROOT_DECISIONS` 长度 4 / `SESSION_ROOT_REASONS` 长度 9。
- ✅ `keep_request_cwd` × 4：CJK prose / URL-heavy / empty prompt / CJK + em-dash（守 `session_981cc5c2` / `session_cf361f04`）。
- ✅ `use_prompt_path`（internal）× 2：real dir inside project / real file inside project（parent as cwd）。
- ✅ `keep_session_root` × 4：外部 path + storedSessionCwd / 外部 path + latestTaskPrimaryRoot / latestTaskPrimaryRoot === requestCwd / latestTaskPrimaryRoot 优先。
- ✅ `require_confirmation` × 2：外部 path + no session context / `acceptExternalPromptPath=true` 切换。
- ✅ `wasProjectRootKept` × 2：kept when === requestCwd / NOT kept when differs。
- ✅ `buildSessionRootContinuityMessage` 1 个 test 守全部 5 个 decision 的非空人类可读 summary。

**Integration — `test/runtime.test.ts`**（Phase A 下游链路已收口；Phase B 收口时已补 5 个新 test）
- ✅ `resolveCwdFromPrompt('...相关文档/信息', projectCwd)` === projectCwd（不漂到 `/`，守 event_seq=9447）。
- ✅ `deriveTaskScope({ cwd: projectCwd, prompt: '...相关文档/信息' })` → `primaryRoot === projectCwd`、`explicitRoots === []`、`mode === 'single_root'`、`source === 'cwd'`（守 event_seq=9449）。
- ✅ `resolveCwdFromPrompt` 对真实存在的 absolute path 仍正常 resolve（防 over-filtering 回归）。
- ✅ `resolveCwdFromPrompt` 遇到 URL-heavy article prompt 时保持 BabeL-O project cwd，不漂到 `/` / `//`（守 `session_cf361f04` event_seq=2613..2616）。
- ✅ `resolveCwdWithContinuity` 5 个 case：URL-heavy article paste（`session_cf361f04` 主路径）/ 真实 internal path / 外部 path + storedSessionCwd / `acceptExternalPromptPath=true` 切换 / `latestTaskPrimaryRoot` > `storedSessionCwd`（Phase B 收口）。
- 外部文章 path 进入 artifact/evidence roots；`task_scope_declared.primaryRoot` 仍保持 BabeL-O project root（守 `session_cf361f04` event_seq=11761..11764）。
- 后续 prompt 仅说"这个文章"时，context assembly 注入 article artifact 摘要 / source path / last verified read result（Phase F 推进时补）。
- Provider usage 2x 偏离 → emit `ContextEstimateCalibration` warning event（Phase D 推进时补）。
- `contextSearch` 在 storage attached 环境下能拉取历史 events（Phase C1 已有工具级 contract；Phase C2 推进时补 runtime propagation 断言）。
- `LLMCodingRuntime` / Nexus HTTP / Nexus WebSocket 三条路径在 storage-backed session 中调用 `contextRecent` 不返回 `CONTEXT_STORAGE_UNAVAILABLE`（守 `session_10320709`）。

**Integration — `test/inspect-session.test.ts`**（Phase B 收口时新增）
- ✅ `exportSessionTrace` 把最近一条 `session_root_continuity` event 上浮为 run span 的 6 个 continuity attributes（`bbl inspect-session <id> --trace` 的 operator surface；守 `session_cf361f04`）。

**E2E (manual replay)**
- Inspect `session_981cc5c2-230c-40d1-953c-b956e9dbaaf7` 并确认 root-cause chain 文档化。
- Inspect `session_cf361f04-7ab1-43a5-907a-41a808942686` 并确认 URL/path/artifact/recall root-cause chain 文档化。
- Inspect `session_10320709-2b06-405f-8f51-d954435d4a70` 并确认 storage-backed session 中 context tools 仍 unavailable 的 runtime propagation chain 文档化。
- Re-run 4-step prompt 序列（项目架构 → `docs/nexus` → `查看有无咱们刚刚聊到的上下文管理优化的相关文档/信息` → 回忆测试）→ cwd 保持项目根、`task_scope_declared.primaryRoot` 不变、recall tools 正常工作或显式 unavailable、no tool scans `/` or `/Users` without explicit confirmation、context estimate calibration 可见（若适用）。
- Re-run article sequence（粘贴 URL-heavy 长文 → 更正为与 BabeL-O 相似性 → 提供 iCloud escaped-space path → `继续任务` → `分析这个文章给babel-o发展方向带来的启发`）→ project root continuity 保持、文章 artifact 可召回、无 `/` / `Library` / home broad scan fallback。
- Re-run context-tool sequence in a storage-backed Nexus session（先产生多轮 events → prompt 要求回忆/搜索刚才内容 → provider 调 `contextRecent` / `contextSearch`）→ 工具成功返回 session events；权限审计成功不能作为替代断言。

## Document Ownership

- This proposal owns the regression plan for cwd drift, context-estimate calibration, recall-tool storage availability, and current-session user-artifact continuity.
- The canonical context map remains [context-governance-index.md](./context-governance-index.md).
- Broader working-set and long-running assembly design remains [long-running-context-assembly.md](./long-running-context-assembly.md).
- Tool failure continuity remains [runtime-tool-loop-governance-plan.md](./runtime-tool-loop-governance-plan.md).
- Completed implementation facts must move to [../WORK_LOG.md](../WORK_LOG.md) and [../DONE.md](../DONE.md), not stay only in this proposal.

## 中文概述

### 背景

真实会话 `session_981cc5c2-230c-40d1-953c-b956e9dbaaf7` 暴露了一个组合问题：中文短语 `文档/信息` 被误识别成 `/信息`，runtime 随后把 cwd 推成 `/`，task scope 也变成根目录。后续工具开始扫 `/` 和 `/Users`，产生大量权限错误和巨型失败输出。

后续真实会话 `session_cf361f04-7ab1-43a5-907a-41a808942686` 扩展了这个问题：URL-heavy 长文中的 `https://...` / `//...` 被当成本地路径，`Mobile\ Documents` 这类 escaped-space iCloud 路径被拆坏，文章所在目录替换了 BabeL-O project root；最后 `contextRecent` storage unavailable 后，agent 忘记了已经粘贴且读取过的文章。

第三个真实会话 `session_10320709-2b06-405f-8f51-d954435d4a70` 进一步证明：即使 SQLite 里有完整 events、Nexus 能写权限审计和执行指标，`contextSearch` / `contextRecent` 仍可能因为 `RuntimeExecuteOptions.storage` 没传入 `executeToolSafely` 而不可用。这不是 storage 不存在，而是 runtime tool context 装配断链。

### 核心做法

计划从六个小切片治理：路径识别不要把普通中文 slash 短语、URL 或转义空格路径片段误判成 cwd；继续会话时优先保持历史项目根；把 `contextSearch/contextRecent` 的治理拆成 C1 工具级显式失败和 C2 runtime storage 贯通；记录 provider usage 与本地估算的偏差；对意外根目录扫描返回可恢复诊断；把粘贴长文 / 后续文件路径 / "这个文章" 指代锚定成当前 session 的 user artifact。

### 当前状态

2026-06-17 升级为 Active Plan。Phase A（路径分类硬化）、Phase A Follow-up（5 类 prose-path 漏出 + URL 守卫 + 实存绝对路径短路 + storage 哨兵）与 Phase C1（recall 工具 storage gate）已收口。**Phase B 也于 2026-06-18 收口** — `SessionRootContinuity` 纯 decision helper 落地（4 decision × 9 reason），`session_root_continuity` event 进 `NexusEventSchema` discriminated union 并被 `AgentTrace` 投影上浮为 run span 的 `lastContinuity*` attributes，`bbl inspect-session <id> --trace` 可直接显示决策与原因。17 + 5 + 1 = 23 个新 test 守住 `session_cf361f04` 的 cwd 切换面。`session_10320709` 暴露 Phase C2 仍 Open：storage-backed Nexus 热路径没有把 storage 注入 tool context。Phase D / E / F 仍 Open。代码 / 测试事实以 [WORK_LOG.md](../WORK_LOG.md) 和 [DONE.md](../DONE.md) 为准。

### 下一步

Phase A / A Follow-up / B / C1 已收口；cwd 切换面已经从根因处封死（`extractAbsolutePaths` prose guard + `SessionRootContinuity` 决策 helper），URL 和外部文章路径不再静默替换 project root。下一步重点是 Phase C2（`RuntimeOptions.storage` → `ToolContext.storage` 贯通）、Phase D（`ContextEstimateCalibration` diagnostic — provider usage 2x 偏离时 emit warning）、Phase E（`ROOT_SCAN_REQUIRES_CONFIRMATION` 工具层 guard — Phase A 收口后此类触发应已显著减少）和 Phase F（`UserArtifactContinuity` 当前 session artifact 锚定 — `session_cf361f04` final turn 在 `contextRecent` unavailable 后遗忘已粘贴和已读取的文章）。

## 10. 2026-06-18 Deep Analysis — Phase A Follow-up Evidence

### 10.1 `extractAbsolutePaths()` 剩余 false-positive 类目

通过对真实 regression 样本 + 反向构造的 prose 字符串跑 `extractAbsolutePaths()`（`npx tsx /tmp/test-extract-prose.mjs`），确认 Phase A 收口的 CJK-only basename guard 只覆盖了原 plan 测试矩阵的一部分，至少还有 5 类 false-positive / 1 类 false-negative / 1 类 path-splitting bug 没有覆盖：

| 类别 | 输入 | Phase A 当前行为 | 真实期望 |
| --- | --- | --- | --- |
| 英文 prose word after `/` | `/while`、`/memory`、`/if` | 整段保留（`["/while"]` 等） | 整段丢弃 |
| 中英混排路径名伪 prose | `/Linear→Workflow/Agent`、`/Layer是变换这份数据的可组合单元` | 整段保留（basename 含 Latin / Common 字符） | 整段丢弃（路径不存在时） |
| CJK 含 em-dash / 全角标点 | `/目录——一条编号递进的学习阶梯` | 整段保留（regex `/^[\p{Script=Han}]+$/u` 拒绝 em-dash，guard 失效） | 整段丢弃（路径不存在时） |
| dotfile 但路径不存在 | `/.openrath/config.json`（用户提到的 `www.openrath.com` 站点） | 整段保留 | 整段丢弃 |
| 路径中存在空格 | `/Library/Application Support`、`/Users/.../Library/Mobile Documents/com~apple~CloudDocs/...` | 在第一个空格处切成两段，分别走 `resolvePromptPath` → 两个 fragment 都不是真实路径 | 整段作为单一 candidate（escaped-space 模式 `/Users/.../Mobile\ Documents/...` 应保留为一个 candidate） |
| URL / protocol-relative URL | `https://www.openrath.com/` → `["//www.openrath.com/"]`、`//www.openrath.com/` → `["//www.openrath.com/"]` | 整段保留，`resolvePromptPath` 后变成 `/`，进入候选列表 | 整段丢弃 |
| 真实 absolute path | `/etc/hosts`、`/bin/bash`、`/Users/.../MEMORY.md`、`/tmp/babel-o-test-config.json` | 整段保留（`existsSync` true） | 整段保留 ✅ |

### 10.2 `isCjkOnlyNonExistentPath` regex bug

```ts
function isCjkOnlyNonExistentPath(candidate: string): boolean {
  const basename = candidate.slice(candidate.lastIndexOf('/') + 1)
  if (basename.length === 0) return false
  if (!/^[\p{Script=Han}]+$/u.test(basename)) return false  // ← 漏洞点
  return !existsSync(candidate)
}
```

`目录——一条编号递进的学习阶梯` 的 em-dash `——`（U+2014）属于 `\p{Script=Common}` 标点，不是 Han script，因此整段被 regex 拒绝、guard 不触发、candidate 漏出。empirical 验证：

```
basename: "目录——一条编号递进的学习阶梯"
Han only regex: false       ← guard 失效
Han+Common regex: true      ← 修正后应该匹配
em-dash codepoint: 2014
em-dash Han: false
em-dash Common: true
```

修正方向不是单纯把 regex 改成 `Han + Common`（那会过度接受 Latin-script 字符串），而是分层守卫：

1. **basename "全部 CJK"**：允许 `Han + Common`（含 CJK 标点 `——` `、` `「」` `（）。` 等）。
2. **basename "全部 Latin-script word"**：单词 / 类目名（`/while`、`/memory`），不作为路径。
3. **basename "中英混排"**（如 `Layer是变换...`、`Linear→Workflow/Agent`）：拒绝。
4. **candidate 不存在**：以上三类在 `!existsSync` 时一律丢弃。

### 10.3 `LocalCodingRuntime.storage` Optional Bug

`session_cf361f04` event_seq=16671 的 `contextRecent` 工具返回 `CONTEXT_STORAGE_UNAVAILABLE`，真实根因是：

```ts
// src/runtime/LocalCodingRuntime.ts:60
constructor(
  private readonly tools: Map<string, AnyTool>,
  private toolPolicy: ToolPolicy = allowAllTools(),
  private readonly storage?: NexusStorage,  // ← optional
  private readonly hooks?: HooksConfig,
) {}
```

```ts
// src/runtime/LocalCodingRuntime.ts:170
private async *runExecuteStreamInner(options: RuntimeExecuteOptions): AsyncIterable<NexusEvent> {
  if (!options.storage && this.storage) {
    options = { ...options, storage: this.storage }
  }
```

当 `LocalCodingRuntime` 由 Go TUI local 模式构造（不传 `storage`，这是默认情况），`this.storage === undefined`：

- 170-172 行只填充 `options.storage`，但 `this.storage` 已是 undefined → `options.storage` 仍 undefined。
- `executeToolSafely(tool, toolInput, options, { toolUseId })` → `options.storage === undefined`。
- `contextRecent` / `contextSearch` 在 storage gate（`contextSearch.ts:39-48`、`contextRecent.ts:35-44`）返回 `CONTEXT_STORAGE_UNAVAILABLE`。

工具注册表 (`src/tools/registry.ts:22-48`) 也无条件把 `contextSearchTool` / `contextRecentTool` / `contextSummarizeTool` 加进 registry —— **没有按 storage 可用性隐藏这些工具**，因此 model 永远会看到这些工具存在，但永远调用失败。

最小修法：**registry 在构造时接受 `storage` 参数**，当 `storage === undefined` 时不注册这三个工具；同步在 `LLMCodingRuntime` 与 `LocalCodingRuntime` 构造处把 storage 传入 registry。这样 model prompt 里就不会出现调用必败的工具，避免浪费 turn 和上下文。

### 10.4 Phase A Follow-up 最小修复包 — ✅ 收口（2026-06-18）

按 focused + integration 两层，**已落地**：

**Focused（unit）— `test/system-prompt-builder.test.ts` 28 → 35**

1. ✅ 7 个 case 验证 prose-path 丢弃（`/while` / `/memory` / `/if` / `/memory/` / `/目录——一条...` / `/Layer是变换...` / `URL/protocol-relative URL`）
2. ✅ 1 个 case 验证 real system paths 无 extension 仍保留（`/etc/hosts` / `/bin/bash`）
3. ✅ 1 个 case 验证 real absolute path 嵌入 prose 仍保留
4. **Out of scope（保留为未来扩展）**：escaped-space 路径 `\ ` 在 pathPattern 阶段仍被 split（当前 SPACE_MARK 哨兵是为了进一步改进，但实际生效路径仍在 isNonExistentProseCandidate）。`/Library/Application Support` 与 `/Users/.../Mobile Documents/...` 在不存在时整体被 prose guard 丢弃；存在时只保留 `/Library/Application` 片段（pathPattern 在 unescaped space 处仍会终止）—— 但这不影响 cwd drift，因为 `resolvePromptPath` 会回退到 prefix 查找，而 prefix 不存在时不会污染 cwd。

**Code change — `src/runtime/systemPromptBuilder.ts`**

1. ✅ URL / protocol-relative URL guard：新增 `looksLikeLikelyUrlFragment` 在 pathPattern 之前丢弃 `https?://...` / `//...`。
2. ✅ Prose guard 重写：新增 `looksLikeProseFragment`（单段 bare Latin word）+ `isNonExistentProseCandidate`（非存路径的多层 CJK + 混排 + 短 prose 全部丢弃）。
3. ✅ `isCjkOrCommonBasename` 取代原 `isCjkOnlyNonExistentPath` 的 Han-only regex（接受 Han + Common 标点，如 em-dash `——` U+2014）。
4. ✅ 实存绝对路径短路：`existsSync(restored)` 为 true 时直接 `paths.add(restored)`，绕过 prose guard。
5. ✅ Escaped-space 路径保留：`SPACE_MARK` 哨兵重写 `\ ` → `\x00\x01`，pathPattern 不再在 `\` 处终止。

**Code change — `src/tools/registry.ts` + 3 调用点**

1. ✅ `createDefaultToolRegistry(opts?: { storage?: NexusStorage | null })`：新增 storage 哨兵，`storage: null` → 隐藏 `contextSearch` / `contextSummarize` / `contextRecent`。
2. ✅ `src/nexus/createRuntime.ts`：构造 storage 后再调用 `createDefaultToolRegistry({ storage })`。
3. ✅ `src/nexus/agents/AgentScheduler.ts`：`createExploreRuntime` 用 `options.storage ?? null` 显式传递。
4. ✅ `src/nexus/runnerComparisonBenchmark.ts`：显式 `{ storage: null }`（benchmark 本来就不需要 storage）。

**Integration（runtime + storage gate）— `test/runtime.test.ts` + `test/runtime-context-tools-registry-gate.test.ts`**

1. ✅ `test/runtime.test.ts` 新增 `resolveCwdFromPrompt stays at project cwd for URL-heavy article paste`（守 `session_cf361f04` event_seq=2613..2616）。
2. ✅ 新增 `test/runtime-context-tools-registry-gate.test.ts` 共 4 个 test：back-compat 默认 / `storage: null` 隐藏 3 个 context 工具 / 真实 MemoryStorage 注入时工具正常 execute / 工具数量差为 3。
3. ✅ 已加入 `package.json` test 脚本。

**验证结果（2026-06-18）**

- `npx tsx --test test/system-prompt-builder.test.ts`：**35/35 pass**（28 pre-existing + 7 新增）。
- `npx tsx --test test/runtime-context-tools-registry-gate.test.ts`：**4/4 pass**（新文件）。
- `npx tsx --test test/context-tools-registry.test.ts`：**8/8 pass**（back-compat 守住）。
- `npx tsx --test --test-name-pattern="CJK slash|over-filtering|task scope|URL-heavy|real existing absolute" test/runtime.test.ts`：**6/6 pass**（含 1 新增 URL-heavy 回归 test）。
- `npx tsx --test test/runtime-layering.test.ts`：**11/11 pass**。
- `npx tsc --noEmit`：**0 错误**。
- `npx tsx /tmp/test-cf361f04.mjs`：`resolveCwdFromPrompt` 返回 `projectCwd`（无 URL / 中文 prose 干扰）。
- `npx tsx /tmp/test-981cc5c2.mjs`：`/etc/hosts` / `/bin/bash` 仍正常 resolve 到对应 cwd。
- 累计 35 + 4 + 8 + 6 + 11 + 19 (agent-trace) + 18 (run-checkpoint) + 19 (eval-agent) = 120 pass，0 回归。

**Out of scope（仍按原 plan）**：Phase B / D / E / F 不动；本 follow-up 不扩大 Phase A 的边界。

## 11. 2026-06-18 Deep Analysis — Phase C2 Runtime Storage Propagation

### 11.1 Symptom

`session_10320709-2b06-405f-8f51-d954435d4a70` shows a storage-backed Nexus session where context tools are still unusable:

| Evidence | Detail |
| --- | --- |
| Session storage exists | `events` table has `15914` rows for this session. |
| Context tool failure #1 | `event_seq=10049` `contextSearch({"query":"BabeL-O multi agent architecture analysis","maxTokens":5000})`; `event_seq=10050` returns `CONTEXT_STORAGE_UNAVAILABLE`. |
| Context tool failure #2 | `event_seq=15071` `contextRecent({"n":10})`; `event_seq=15072` returns `CONTEXT_STORAGE_UNAVAILABLE`. |
| Context tool failure #3 | `event_seq=15102` `contextSearch({"query":"优化草案","maxTokens":3000})`; `event_seq=15103` returns `CONTEXT_STORAGE_UNAVAILABLE`. |
| Governance writes still work | `permission_request` / `permission_response` / `scope_boundary_confirmed` events exist at `265..270`, `6115..6120`, `10308..10313`. |
| Execution metrics still work | `execution_metrics` exists at `3911`, `14506`, `15913`. |

The failure is therefore not "SQLite missing" or "session events not persisted". It is specifically "the storage-backed runtime did not pass storage into `ToolContext` for context tools".

### 11.2 Code-Level Chain

Current storage paths are split:

```ts
// src/nexus/app.ts HTTP path around executeStream
for await (const event of options.runtime.executeStream({
  sessionId,
  prompt: body.prompt,
  cwd,
  // missing: storage: options.storage
  ...
})) {
  await options.storage.appendEvent(sessionId, decoratedEvent)
}
```

```ts
// src/nexus/app.ts WebSocket path around executeStream
for await (const event of options.runtime.executeStream({
  sessionId,
  prompt: body.prompt,
  cwd,
  // missing: storage: options.storage
  ...
})) {
  await options.storage.appendEvent(sessionId, decoratedEvent)
}
```

`LLMCodingRuntime` also has a private storage instance, but it currently sends that storage as a side-channel to `executeProviderToolCall`, not through `RuntimeExecuteOptions`:

```ts
const toolExecution = executeProviderToolCall({
  toolCall: tc,
  tools: this.tools,
  toolPolicy: this.toolPolicy,
  runtimeOptions: options,
  storage: this.storage,
  metrics,
  readFileCache: this.readFileCache,
  taskScope: taskScopeEvent,
})
```

`executeProviderToolCall` uses the side-channel `options.storage` for permission audit and scope-boundary persistence, so governance writes work. But actual tool dispatch calls:

```ts
const result = await executeToolSafely(tool, toolInput, runtimeOptions, {
  timeout: TOOL_EXECUTION_TIMEOUT_MS,
  toolUseId: toolCall.id,
})
```

And `executeToolSafely` builds `ToolContext` only from `RuntimeExecuteOptions`:

```ts
const result = await tool.execute(input, {
  cwd: options.cwd,
  sessionId: options.sessionId,
  ...
  storage: options.storage,
})
```

Therefore, if Nexus does not set `RuntimeExecuteOptions.storage`, `contextSearch` / `contextRecent` receive `context.storage === undefined` even though:

- Nexus has `options.storage`;
- LLMCodingRuntime has `this.storage`;
- `executeProviderToolCall` has a side-channel `options.storage`;
- permission auditing can persist successfully.

This explains the otherwise confusing operator symptom: "the same session can write events and permission audits but context tools still say storage unavailable."

### 11.3 Distinction From §10.3

§10.3 covers `LocalCodingRuntime.storage` being optional in local-mode construction. That path can genuinely have no storage; the correct behavior is to hide context tools via `createDefaultToolRegistry({ storage: null })` or return an explicit unavailable result.

§11 covers a different class:

- storage exists;
- storage is used by Nexus;
- storage is used by governance side effects;
- context tools are visible;
- but storage is not copied into the runtime options consumed by `executeToolSafely`.

So Phase C2 is not another registry gate. It is a propagation invariant:

> If a context tool is provider-visible in a storage-backed session, `ToolContext.storage` must be non-null.

### 11.4 Minimal Fix Plan

1. **Nexus HTTP execute path**
   - Add `storage: options.storage` to the object passed to `options.runtime.executeStream`.

2. **Nexus WebSocket execute path**
   - Add the same `storage: options.storage` field.

3. **LLMCodingRuntime defensive normalization**
   - At the start of `runExecuteStreamInner`, normalize:

```ts
if (!options.storage) {
  options = { ...options, storage: this.storage }
}
```

4. **runtimeToolLoop defensive merge**
   - Before `executeToolSafely`, use a merged options object:

```ts
const toolRuntimeOptions = {
  ...runtimeOptions,
  storage: runtimeOptions.storage ?? options.storage,
}
```

5. **Diagnostic hardening**
   - When context tools return `CONTEXT_STORAGE_UNAVAILABLE` in an LLMCodingRuntime-backed Nexus session, emit a runtime diagnostic that distinguishes:
     - `registry_hidden_no_storage` — expected no-storage runtime;
     - `tool_context_missing_storage` — provider-visible context tool but `ToolContext.storage` absent;
     - `storage_read_failed` — storage attached but `listEvents` failed.

### 11.5 Regression Tests

Required tests before Phase C2 can close:

1. **runtimeToolLoop unit**
   - Construct `executeProviderToolCall` with `options.storage = new MemoryStorage()` and `runtimeOptions.storage` omitted.
   - Tool call: `contextRecent({ n: 5 })`.
   - Expected: success, not `CONTEXT_STORAGE_UNAVAILABLE`.

2. **LLMCodingRuntime integration**
   - Use a mock provider that calls `contextSearch`.
   - Seed a session with one or more events in `MemoryStorage`.
   - Instantiate `LLMCodingRuntime` with that storage.
   - Omit `RuntimeExecuteOptions.storage`.
   - Expected: context tool can read the seeded events via `this.storage` normalization.

3. **Nexus HTTP path**
   - Execute a session through HTTP/injected app path.
   - Provider calls `contextRecent`.
   - Expected: context tool sees `options.storage` and succeeds.

4. **Nexus WebSocket path**
   - Same assertion for WS execution.

5. **negative no-storage path**
   - `createDefaultToolRegistry({ storage: null })` still hides `contextSearch`, `contextRecent`, and `contextSummarize`.
   - This preserves the intended behavior for genuinely storage-less runtimes.

### 11.6 Operational Readout

For future `inspect-session` / trace diagnostics, this class should be visible without manually querying SQLite:

- Count context tool failures grouped by `code`.
- Show whether the session has persisted events.
- Show whether `contextSearch` / `contextRecent` were provider-visible.
- Show whether `RuntimeExecuteOptions.storage` was present at tool dispatch.

The important operator-facing distinction:

- "Storage unavailable because this runtime intentionally has no storage" is expected degradation.
- "Storage unavailable while the session is clearly persisted" is a runtime propagation bug and should be treated as a P1 regression.

## 12. 2026-06-18 — Session_10320709-2b06-405f-8f51-d954435d4a70 Deep Analysis: 3 Regression Bugs Beyond §10/§11

Session_10320709-2b06-405f-8f51-d954435d4a70 is the third real regression sample (after session_981cc5c2 and session_cf361f04). Phase A / A Follow-up / B / C1 are closed, while Phase C2 in §11 remains the active storage-propagation follow-up. The sample shows three concrete failures across the **pure path-extraction** layer, the Nexus continuity wiring, and the runtime storage injection path; those must close before we can claim the plan is regression-first complete.

### 12.1 Bug 1 — Cwd 漂到 `/Users/tangyaoyue/Library`（pathPattern 4-segment 切断 + dirname 兜底）

**Symptom**

session_10320709 的 6 个 turn 全部跑在 cwd `/Users/tangyaoyue/Library`（被 iCloud 路径污染）。验证脚本（`/tmp/test-extract-10320709.mjs`）：

```
--- prompt 1 candidates ---
   "/Users/tangyaoyue/Library/Mobile"
```

prompt 是：

```
分析这个文章'/Users/tangyaoyue/Library/Mobile Documents/com~apple~CloudDocs/家人共享/上百个Agent，该怎么管？清华团队新思路：重做Session.md'与babel-o项目理念的相似程度
```

整段 iCloud 路径含 unescaped space，`extractAbsolutePaths()` 的 pathPattern `/[^\s"'`，。！？；：、）\])}<>]+/g` 在第一个空格处切断，产出 4-segment candidate `/Users/tangyaoyue/Library/Mobile`（含 `Mobile` 是 macOS `~/Library/Mobile` 的真实子目录，`existsSync` 返回 true）。

**根因（3 段链路）**

1. `src/runtime/systemPromptBuilder.ts:255` pathPattern 在 unescaped space 处切断 — iCloud 路径含空格时只保留 prefix。
2. `isNonExistentProseCandidate`（line 275-310）只对 1-2 segment 的 candidate 做 prose guard；对 4-segment `Mobile`（bare Latin word basename）返回 false。
3. `src/runtime/LLMCodingRuntime.ts:1380-1383` `resolveCwdFromPrompt` 在 `!existsSync(resolved)` 时回退到 `dirname = /Users/tangyaoyue/Library`：

```ts
if (!existsSync(resolved)) {
  const parent = dirname(resolved)
  if (parent !== resolved && existsSync(parent)) {
    return parent  // ← vulnerable to ~/Library always-existing
  }
}
```

`/Users/tangyaoyue/Library` 永远存在（macOS 系统目录），所以 cwd 漂到那里。**plan §10.4 "Out of scope" 行的假设错了：以为 prefix 不存在时不会污染 cwd，但 `~/Library` 永远存在**。

**重现**

```bash
$ npx tsx /tmp/test-extract-10320709.mjs
--- prompt 1 candidates ---
   "/Users/tangyaoyue/Library/Mobile"
--- prompt 7 candidates ---
   "/Users/tangyaoyue/DEV/BABEL/BabeL-O/docs/nexus"
```

`resolveCwdFromPrompt` 在 prompt 1 上把 `Mobile` 解析为 `/Users/tangyaoyue/Library`（通过 dirname 兜底）。

**修复方向（最小修法）**

A. **dirname 兜底收紧（推荐先做）**：在 `resolveCwdFromPrompt` line 1380-1383 增加 `if (parent === homedir() || parent === '/Users' || parent === '/Users/' || parent === dirname(homedir())) return undefined` — 系统级目录禁止作为 fallback cwd。

B. **pathPattern 4-segment guard**：在 `extractAbsolutePaths` 里加 4-segment 短 basename 守卫 — 4-segment candidate + 末段是 bare Latin word（`/^[A-Za-z]{1,16}$/`）+ 不在已知 project root → 丢弃。

C. **session_root_continuity 的 Project-root 锚定**：Phase B 的 `deriveSessionRootContinuity` 在判定为 `use_prompt_path` 前增加 `isProjectLikeRoot(resolved)` 校验；如果 resolved 落在 `/Users/<user>/Library` / `/Users/<user>/Documents` 这类系统/家目录而不是 project root，强制降级到 `keep_session_root`。

按 A → C 顺序，每段 ~5 行 + 3 个 focused test。

**影响范围**

- session_10320709：6 turn cwd 全漂。
- 同类风险：任何 `/Users/.../Documents/` / `/Users/.../Desktop/` / `/Users/.../Downloads/` 的 prompt 都可能触发。
- 与 Phase A Follow-up 的 `isNonExistentProseCandidate` 不冲突：Phase A 守的是「不存在的 prose」，Bug 1 是「**存在**的 prefix 误升级为 cwd」。

### 12.2 Bug 2 — Phase B Nexus 接线层 missing `storedSessionCwd` / `latestTaskPrimaryRoot`

**Symptom**

session_10320709 的 0 个 `session_root_continuity` event（预期每 turn 至少 1 个，因为 Phase B 已收口）。意味着 `LLMCodingRuntime.runExecuteStreamInner` line 290 的 `hasSessionContext = false` 永远成立，Phase B 的 `resolveCwdWithContinuity` 路径根本没被触发。

**根因**

`src/nexus/app.ts:2695-2711` `executeStream` 调用**没传** `storedSessionCwd` / `latestTaskPrimaryRoot`：

```ts
for await (const event of options.runtime.executeStream({
  sessionId, prompt: body.prompt, cwd, signal, timeoutSignal,
  maxToolOutputBytes, bashMaxBufferBytes, skipPermissionCheck,
  requestId, model, budget, executionEnvironment,
  remoteRunner: options.remoteRunner, allowedPaths: prepared.allowedPaths,
  policyMode: prepared.policyMode, ...(prepared.allowedTools && { allowedTools: prepared.allowedTools }),
  // missing: storedSessionCwd, latestTaskPrimaryRoot
}))
```

`Runtime.ts:67-85` `RuntimeExecuteOptions` 已定义 3 个 optional 字段（Phase B 收口时加），但 Nexus `app.ts` 的 HTTP / WebSocket 两条 executeStream 路径都没有传：

- 即使 session 有 stored cwd，runtime 看不到。
- 即使前一个 task 有 `primaryRoot`，runtime 看不到。
- Phase B 的 `session_root_continuity` event 永远不 emit，CLI 拿不到决策记录。

**与 §10.3 / §11.3 的关系**

- §10.3：`LocalCodingRuntime.storage` optional — 本地 TUI 模式无 storage，预期。
- §11.3 / §12.3 (Bug 3)：LLMCodingRuntime 的 `options.storage` 未注入 — storage 缺。
- §12.2 (Bug 2)：Nexus 调用 runtime 时 `storedSessionCwd` / `latestTaskPrimaryRoot` 未传递 — session metadata 缺。

3 个 bug 共同模式：**Phase A/B/C1 收口后，runtime 之外**还有一层接线（Nexus app.ts、LLMCodingRuntime.runExecuteStreamInner）必须把已有的 metadata 主动注入到 `RuntimeExecuteOptions` 才能让 Phase A/B/C 的代码真正生效。

**修复方向**

A. **Nexus HTTP/WS executeStream 加 2 行**：

```ts
// src/nexus/app.ts
const sessionRecord = options.storage.getSession?.(sessionId)
const storedSessionCwd = sessionRecord?.cwd
const latestTaskPrimaryRoot = sessionRecord?.latestPrimaryRoot
for await (const event of options.runtime.executeStream({
  ...,
  storedSessionCwd,
  latestTaskPrimaryRoot,
})) {}
```

B. **session record schema 加 `latestPrimaryRoot` 字段**（如未存在）— 与 `taskScope.ts:32` 的 `primaryRoot` 对齐。

C. **diagnostic**：emit `session_root_continuity_missing` event 当 `hasSessionContext === false && sessionStorage.hasCwd`。

**影响范围**

- session_10320709：0 个 continuity event。
- 所有已上线的 Nexus session：Phase B 的 CLI 决策记录、AgentTrace 投影全部失效。

### 12.3 Bug 3 — LLMCodingRuntime.runExecuteStreamInner missing storage 注入

§11 已把这条登记为 Phase C2 Open/P0：`LLMCodingRuntime.runExecuteStreamInner` 整段**没有** `options = { ...options, storage: this.storage }`（对比 `LocalCodingRuntime.ts:170-172` 有）。`executeToolSafely` → `tool.execute(input, { storage: undefined })` → `contextSearch` / `contextRecent` 触发 Phase C guard 返回 `CONTEXT_STORAGE_UNAVAILABLE`。session_10320709 的 3 个 context tool 失败（event_seq 10049/10050、15071/15072、15102/15103）就是这个根因。

**§11.4 修复 1**（`runExecuteStreamInner` 起手段落 2 行）就是这一项的修法，无需在 §12 重复展开。

### 12.4 修复优先级（按 P0 → P1 排序）

| 优先级 | Bug | 修法 | 代码量 | Test |
| --- | --- | --- | --- | --- |
| **P0** | Bug 3（C2 storage） | §11.4 修 1 | 1 行 | 5 个（§11.5） |
| **P0** | Bug 2（Nexus 接线层） | §12.2 修 A | ~5 行 | 2 个（HTTP + WS） |
| **P1** | Bug 1（cwd 漂 Library） | §12.1 修 A → C | ~15 行 | 6 个（dirname 收紧 3 + 4-segment guard 2 + continuity 投影 1） |

按 P0 → P1 顺序，每段独立 PR，便于 regression 验证。

### 12.5 验证策略

1. **Bug 3 fix**：跑 `test/runtime-context-tools-registry-gate.test.ts` 4 个 + `test/runtime.test.ts` 6 个 + 新增 `test/runtime-storage-propagation.test.ts` 5 个 §11.5 测试；用 `MemoryStorage` 注入 `LLMCodingRuntime` + 故意不传 `RuntimeExecuteOptions.storage` → 验证 `contextSearch` 不再返回 `CONTEXT_STORAGE_UNAVAILABLE`。
2. **Bug 2 fix**：在 `test/nexus-runtime-wiring.test.ts` 新增 2 个测试：HTTP `executeStream` 与 WS `executeStream` 都把 `storedSessionCwd` / `latestTaskPrimaryRoot` 注入；mock Nexus `app.ts:2695` 调用点，验证 options 包含这 2 个字段。
3. **Bug 1 fix**：新增 `test/resolve-cwd-fallback.test.ts` 3 个 test：① iCloud `Mobile Documents` 路径 prompt → cwd 不漂到 `~/Library`；② 已知 project root 锚定检查通过；③ `keep_session_root` 决策在 Project-root 校验失败时触发。

### 12.6 Reopen 信号

session_10320709 的出现**反向证明**了 §10.4 "Out of scope" 行的判断有误：以为 Phase A Follow-up 收口后，session 行为完全可预测；实际未触及**接线层**（Nexus app.ts、LLMCodingRuntime.runExecuteStreamInner 起手）和**dirname 兜底**的根因。

后续策略：
- 任何 `cwd` 漂到 `/Users/<user>/Library` / `/Users/<user>/Documents` 这类「家目录」都是 P1 回归（必须 reopen Phase A/B）。
- 任何 `session_root_continuity` event 缺失 + 0 个 `lastContinuity*` attributes 是 P0 回归（必须 reopen Phase B 接线层）。
- 任何 `CONTEXT_STORAGE_UNAVAILABLE` + `events` 表非空 是 P0 回归（会阻塞 Phase C2 关闭，或在已关闭后 reopen 注入层）。

## 13. 2026-06-18 — Session_10320709 Re-examination: Missed Details + Refined Fix Plan

对 session_10320709-2b06-405f-8f51-d954435d4a70 做二次 SQLite 复盘（`/Users/tangyaoyue/.babel-o/db.sqlite`，15914 events）后，发现 §12 的 3-bug 分析遗漏了 4 个关键细节，并暴露 1 个新的架构层 bug（Bug 4）。本节补充证据并修正修复优先级。

### 13.1 遗漏的证据（直接读 events 表）

| # | 证据 | 来源 event_seq | 含义 |
| --- | --- | --- | --- |
| 1 | 真实 prompt 用**普通空格**（不是 `\ ` shell escape）：`分析这个文章'/Users/tangyaoyue/Library/Mobile Documents/com~apple~CloudDocs/家人共享/上百个Agent...md'与babel-o项目理念的相似程度` | user_message seq=1 | Phase A Follow-up ④ 的 SPACE_MARK 哨兵**只处理 `\ ` escape，不处理普通空格**——而真实用户粘贴的就是普通空格。SPACE_MARK 修了**错误的目标**。 |
| 2 | `user_intake_guidance.explicitPaths = ["/Users/tangyaoyue/Library/Mobile","/com~apple~CloudDocs/家人共享/上百个Agent"]` | seq=3 | **一条 iCloud 路径被拆成 2 个 candidate**。第 1 个（`/Mobile`）→ cwd 漂移源；第 2 个（`/com~apple~CloudDocs/...`）→ 进了 `task_scope_declared.explicitRoots`（seq=4）成为**垃圾 explicitRoot**，让 file-discovery 工具去搜不存在的 `/com~apple~CloudDocs/...`。§12 只记了 cwd 漂，漏了 explicitRoot 污染。 |
| 3 | `/Users/tangyaoyue/Library/Mobile` **不存在**（`existsSync` = false）；`~/Library` 存在 | `ls` 验证 | 因此 `resolveExplicitPromptCwd`（`app.ts:5662`）**正确拒绝**了 `/Mobile`（isDirectory 检查失败 → 返回 undefined），但 `resolveCwdFromPrompt`（`LLMCodingRuntime.ts:1380-1383`）**错误接受**其 dirname `~/Library`（永远存在）。**两个 resolution site 行为不一致**——见 Bug 4。 |
| 4 | 7 个 turn 的 cwd 时序：seq=2/3914/4292/4454/5980/9867 全部 `~/Library`，仅 seq=14509 回到 `docs/nexus` | session_started 全部 | **drift 跨 turn 持续**：turn 2-6 的 prompt **完全无路径**（"两个项目的理念哪一个更先进一些"），却仍跑在 `~/Library`。说明 drift 一旦发生就被向前传播（cwd propagation 走的是上一 turn 的 drifted cwd，而非 session 原始 root）。§12 把它当单 turn 现象，错了。turn 7 因用户重述项目内路径 `在/Users/tangyaoyue/DEV/BABEL/BabeL-O/docs/nexus中...` 而**自愈**。 |

### 13.2 Bug 4 [NEW, P1] — Dual Cwd Resolution Sites Disagree + session.cwd Per-turn Mutation

`cwd` 当前在**两处**用不同逻辑解析，且 `session.cwd` 每 turn 被覆写：

```ts
// Site A — src/nexus/app.ts:5651 resolveRequestCwd → resolveExplicitPromptCwd
//   extractAbsolutePaths → resolvePromptPath → existsSync + isDirectory
//   只接受「实存且是目录」的 candidate；/Mobile 不存在 → 返回 undefined → 回落 requestedCwd/sessionCwd
function resolveExplicitPromptCwd(prompt) {
  for (const candidate of extractAbsolutePaths(prompt)) {
    const resolved = resolvePromptPath(candidate)
    if (!existsSync(resolved)) continue          // ← /Mobile 不存在，跳过 ✓
    if (lstatSync(resolved).isDirectory()) return resolved
  }
  return undefined
}

// Site B — src/runtime/LLMCodingRuntime.ts:1378 resolveCwdFromPrompt
//   extractAbsolutePaths → resolvePromptPath → existsSync → dirname 兜底
//   /Mobile 不存在 → dirname = ~/Library（永远存在）→ 返回 ~/Library ✗
if (!existsSync(resolved)) {
  const parent = dirname(resolved)
  if (parent !== resolved && existsSync(parent)) return parent  // ← 漂移源
}
```

两处对同一个 candidate `/Users/tangyaoyue/Library/Mobile` 给出不同结果：Site A 拒绝（正确），Site B 通过 dirname 兜底接受 `~/Library`（错误）。runtime 在 `runExecuteStreamInner` 内用 Site B 的结果覆写 `options.cwd` 并 emit `session_started.cwd = ~/Library`。

`app.ts:2301 session.cwd = cwd` 每 turn 用 `resolveRequestCwd` 的结果覆写 session row cwd；runtime 内部的 drifted cwd 又通过 `session_started` 事件被 Go TUI / 下一 turn 的 `body.cwd` 回传（待最终确认回传路径，但 seq=3914..9867 的持续 drift 是经验事实）。结果：**session 一旦在 turn 1 漂移，turn 2-6 即使 prompt 无路径也回不到 project root**，直到用户显式重述项目路径（turn 7）。

### 13.3 Refined Bug 1 Fix — Quote-delimited Span + System-dir Guard（双层）

§12.1 的修法（dirname 收紧 + 4-segment guard + continuity 校验）是对的方向，但**漏了根因**：pathPattern 在普通空格处切断。更优修法分两层：

**Layer A（根因，principled）— `extractAbsolutePaths` 优先识别 quote-delimited span**

prompt 里 iCloud 路径被单引号 `'...'` 包住。pathPattern 当前在引号**内**的空格处切断。修法：在 pathPattern 之前，先抽取 `'...'` / `"..."` / `` `...` `` 的内容，若整段 `existsSync` 为 true 或 `resolvePromptPath` 命中实存 prefix，则作为**单一 candidate**加入（绕过空格切断）。这样 `/Users/.../Mobile Documents/com~apple~CloudDocs/.../上百个Agent...md` 会作为整段被提取，`existsSync` true → 进 explicit paths，cwd 解析到文章父目录（外部根），Phase B continuity 标 `require_confirmation` / `keep_session_root`，**根本不会漂到 `~/Library`**。

```ts
// 伪代码 — 在 normalizeWrappedPathFragments 之后、pathPattern 之前
const QUOTE_SPAN = /['"`]([^'"`\n]+)['"`]/g
for (const m of text.matchAll(QUOTE_SPAN)) {
  const span = m[1]
  if (!span.includes('/')) continue
  if (existsSync(span) || resolvePromptPath(span) !== span) {
    paths.add(span)            // 整段实存，绕过空格切断
    quotedSpans.add(span)
  }
}
// pathPattern 阶段跳过已识别的 quoted span
```

**Layer B（defense-in-depth）— 共享 `isAcceptablePromptCwd` 守卫**

新增纯函数 `isAcceptablePromptCwd(p): boolean`，拒绝 homedir / `~/Library` / `~/Documents` / `~/Desktop` / `~/Downloads` / `/Users` / `/Users/<user>` 这类系统/家目录作为 prompt-derived cwd。**两个 site 都用**：`resolveExplicitPromptCwd`（Site A）和 `resolveCwdFromPrompt`（Site B）在返回前都过这个守卫。即使 Layer A 漏网，dirname 兜底到 `~/Library` 也会被 Layer B 拦下。

```ts
export function isAcceptablePromptCwd(p: string): boolean {
  const home = homedir()
  const rejected = [home, dirname(home), '/Users', '/Users/', `${home}/Library`,
    `${home}/Documents`, `${home}/Desktop`, `${home}/Downloads`]
  return !rejected.includes(resolve(p))
}
```

Layer A 修根因（quoted plain-space path），Layer B 兜底（任何系统目录都不许成为 prompt cwd）。两层独立 PR + 各自 focused test。

### 13.4 Bug 2 Fix Refinement — `session.cwd` 本身可能已漂移

§12.2 说「传 `storedSessionCwd = session.cwd` 即可让 Phase B 触发」。但 §13.2 证明 `session.cwd` 在 turn 1 就被 `app.ts:2301` 覆写成 drifted 值（或被 runtime 的 `session_started` 回传污染）。因此**单纯传 `session.cwd` 可能传的是已漂移的 `~/Library`**，Phase B 的 `inheritedCwd === requestCwd` 判断会失效。

修正：Bug 2 的 fix 需要一个**不可变 origin cwd**——在 session 创建时从 launcher 的 `body.cwd`（`bbl go` 启动目录，= `docs/nexus`）写入一次，后续 turn 不覆写。建议：
- `sessions` 表新增 `origin_cwd` 列（或 `metadata.originCwd`），`createSessionSnapshot` 时写入 `body.cwd ?? defaultCwd`，**不随 `session.cwd` 漂移**。
- `app.ts:2695` executeStream 传 `storedSessionCwd = session.originCwd`（不是 `session.cwd`）+ `latestTaskPrimaryRoot`（从首条 `task_scope_declared` 或 origin_cwd 派生）。
- 这样 Phase B 的 `deriveSessionRootContinuity` 看到 `requestCwd = ~/Library`（runtime 内 Site B 漂移前）/ `storedSessionCwd = docs/nexus` → `keep_session_root` → 保留 `docs/nexus`。

**重要**：Bug 2 fix 与 Bug 1 fix 是**互补**关系，不是替代：
- Bug 1 Layer A+B 在 Site B（runtime）拦住 dirname 兜底 → 从源头不漂。
- Bug 2 fix + origin_cwd 在 Phase B continuity 层兜底 → 即使 Site B 漏网，continuity 用 origin_cwd 把 cwd 拉回 project root。
- 两者都做才能覆盖「pathPattern 漏网 + dirname 兜底漏网 + session.cwd 漂移」三层失败。

### 13.5 下游损害清单（drift 的真实代价）

session_10320709 因 Bug 1+4 的 cwd 漂移产生的**级联失败**（§12 未列）：

| 损害 | 数量 | event_seq | 根因链 |
| --- | --- | --- | --- |
| `GLOB_FAILED`（ripgrep 撞 `~/Library/Caches/com.apple.ap.adprivacyd: Operation not permitted`） | 8 | 155/271/422/428/4521/4527/6121/10314 | cwd=`~/Library` → Glob 在系统缓存目录扫 → macOS 权限拒绝 → 整个 Glob 失败（非 partial result） |
| `scope_boundary_detected` parent_scan 到 `/Users/tangyaoyue` | 3 | 265/6115/10308 | `taskPrimaryRoot=~/Library` → 模型想够项目 `/Users/tangyaoyue/DEV` → 触发 parent_scan 边界 → 3 次确认中断 |
| `WEB_SEARCH_FAILED` "fetch failed" | 6 | 10044/10097/10302/10460/10547/10667 | 独立网络/配置问题（非本 plan 范围），但加剧了 session 质量：模型查 "OpenManus/OpenMenus" 学术项目失败，只能凭训练数据回答 |
| `INVALID_TOOL_INPUT`（ListDir `maxDepth > 2`） | 5 | 6353/6359/6365/10882/10888 | 模型在 drifted cwd 下反复尝试深扫，schema 约束未遵守（次要，provider-side） |
| `TOOL_INPUT_PARSE_ERROR` | 1 | 11788 | provider malformed tool input（Phase D 已有 synthetic pair 处理） |
| 幻觉路径拼接 | 1 | 4786 | Read `/Users/tangyaoyue/Library/Mobile Documents/com~apple~CloudDocs/家人共享/docs/nexus/context-and-subagent-upgrade-pla...`——模型把 drifted iCloud 基路径 + 项目相对路径 `docs/nexus/...` 拼成不存在的路径 |
| 上下文浪费 | — | execution_metrics seq=3911 | turn 1 `contextCharsIn=992400`（≈250k tokens），大部分是失败 Library 扫描的输出。drift 不只污染 cwd，还烧 context budget |

**额外发现**：8 个 GLOB_FAILED 全部因 ripgrep 在 `~/Library/Caches` 权限拒绝而**整段失败**——这说明 Glob 工具遇到 permission-denied 子目录时**不降级为 partial result**，而是返回 `GLOB_FAILED`。这是独立于本 plan 的工具鲁棒性问题，建议在 [tool-governance-plan.md](./tool-governance-plan.md) 单列 follow-up：ripgrep 遇 `Operation not permitted` 应跳过该子目录继续扫，返回 partial results + diagnostic，而非整段失败。

### 13.6 Revised Fix Priority + Reopen Signals

修正后的修复优先级（替换 §12.4）：

| 优先级 | Bug | 修法 | 代码量 | Test | 阻塞的下游损害 |
| --- | --- | --- | --- | --- | --- |
| **P0** | **Bug 1 Layer A** | `extractAbsolutePaths` quote-delimited span 优先识别 | ~15 行 | 4 个（quoted iCloud path 整段提取 / 双引号 / backtick / 混入 prose） | cwd 漂移 + 垃圾 explicitRoot + 8 GLOB_FAILED + 3 parent_scan + 上下文浪费 |
| **P0** | **Bug 1 Layer B** | 共享 `isAcceptablePromptCwd` 在 Site A+B 拦系统目录 | ~10 行 | 3 个（`~/Library` / `~/Documents` / homedir 拒绝；project root 通过） | dirname 兜底漏网 |
| **P0** | Bug 3（C2 storage） | §11.4 修 1 + Nexus 接线 + runtimeToolLoop merge | ~8 行 | 5 个（§11.5） | 3 CONTEXT_STORAGE_UNAVAILABLE |
| **P1** | Bug 2 + origin_cwd | `sessions.origin_cwd` 列 + `app.ts:2695` 传 `storedSessionCwd=origin_cwd` + `latestTaskPrimaryRoot` | ~20 行 | 3 个（origin_cwd 不随 drift 变 / continuity 用 origin_cwd 拉回 / HTTP+WS 接线） | Phase B continuity 失效 + 0 session_root_continuity event |
| **P1** | Bug 4（architectural） | 统一 Site A/B：要么只保留 runtime 解析（删 `resolveExplicitPromptCwd`，让 Phase B 在 runtime 决策），要么把 Phase B continuity 上移到 `resolveRequestCwd` | ~30 行 refactor | 4 个（两 site 一致性 / session.cwd 不被 external prompt 覆写 / 跨 turn 不漂 / turn 7 自愈仍工作） | 跨 turn drift 持续 |

**修正后的 Reopen 信号**（替换 §12.6）：

- 任何 `cwd` 漂到 `/Users/<user>/Library` / `Documents` / `Desktop` / `Downloads` / `homedir` → **Bug 1 未收口**（reopen Phase A Layer A+B）。
- 任何 `task_scope_declared.explicitRoots` 含 `/com~apple~...` / 不以 `/Users/<user>/...` 开头的破碎 fragment → **Bug 1 Layer A 未收口**（quote span 识别漏）。
- 任何 turn 的 `session_started.cwd` 与 `session.origin_cwd` 不一致 + 该 turn prompt 无项目内路径 → **Bug 4 未收口**（跨 turn drift 持续）。
- 任何 `session_root_continuity` event 缺失 → **Bug 2 未收口**（接线层未传 origin_cwd）。
- 任何 `CONTEXT_STORAGE_UNAVAILABLE` + `events` 表非空 → **Bug 3 未收口**（reopen Phase C2 注入层）。
- 任何 `GLOB_FAILED` 因 `Operation not permitted` 整段失败（非 partial）→ 工具鲁棒性 follow-up（独立于本 plan，入 tool-governance-plan）。

### 13.7 与 §12 的差异总结

- §12 把 Bug 1 当单 turn、单 candidate 的 dirname 兜底问题；§13 修正为**双 candidate**（cwd + explicitRoot）+ **跨 turn 持续**+ **普通空格**（非 `\ ` escape）+ **两 site 不一致**。
- §12 的 Bug 2 fix 假设 `session.cwd` 未漂；§13 修正为需要不可变 `origin_cwd`。
- §12 漏了 Bug 4（dual resolution sites + session.cwd mutation）。
- §12 漏了下游损害清单（8 GLOB_FAILED / 3 parent_scan / 幻觉路径 / 992k context 浪费）和 Glob permission-denied 不降级的独立工具鲁棒性问题。
- §13 把 Bug 1 从 P1 提升到 **P0**（它是 cwd 漂移的 load-bearing fix，Bug 2 是 defense-in-depth）。
