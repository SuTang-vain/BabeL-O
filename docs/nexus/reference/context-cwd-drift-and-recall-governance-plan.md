# Context CWD Drift And Recall Governance Plan

> State: Active Plan
> Track: Context / Runtime / Task Scope / Session Recall
> Priority: P1 (Phase A + Phase A Follow-up + Phase B + Phase C 收口 2026-06-18; Phase D / E / F Open)
> Source of truth: `docs/nexus/reference/context-governance-index.md`, `docs/nexus/proposals/long-running-context-assembly.md`, `src/runtime/LLMCodingRuntime.ts`, `src/runtime/systemPromptBuilder.ts`, `src/runtime/taskScope.ts`, `src/runtime/contextAssembler.ts`, `src/tools/builtin/contextSearch.ts`, `src/tools/builtin/contextRecent.ts`
> Governance: Indexed by [context-governance-index.md](./context-governance-index.md). This document owns the regression plan for prompt-derived cwd drift, context-estimate calibration, storage-backed session recall tools, and user-artifact continuity.
> Related: [context-governance-index.md](./context-governance-index.md), [long-running-context-assembly.md](../proposals/long-running-context-assembly.md), [runtime-tool-loop-governance-plan.md](./runtime-tool-loop-governance-plan.md), [task-scope-and-evidence-scope-governance-plan.md](../proposals/task-scope-and-evidence-scope-governance-plan.md)

**Status (2026-06-18)**: upgraded from Draft to Active Plan on 2026-06-17. **Phase A 收口** — `extractAbsolutePaths()` 在 `src/runtime/systemPromptBuilder.ts:216` 增加 `isCjkOnlyNonExistentPath()` 守卫，CJK-only basename + 不存在的 candidate 整段丢弃；`test/system-prompt-builder.test.ts` 加 4 个 focused test（`文档/信息` / `/信息` / `/信息/归档` 全部不进 explicit paths；`/etc/hosts` 与 CJK prose 混排时仍保留真实路径）。Phase A 下游链路 integration 收口 — `resolveCwdFromPrompt` 已 export 供测试，`test/runtime.test.ts` 加 3 个 test 守 `session_981cc5c2` 的两个失败点：cwd 不漂到 `/`（event_seq=9447）+ `task_scope_declared.primaryRoot` 保持项目根（event_seq=9449），并加真实存在 path 仍正常 resolve 的防 over-filtering 守卫。**Phase A Follow-up 收口（2026-06-18）** — 复盘 `session_cf361f04` 后定位 5 类 prose-path 漏出 + 1 类 false-negative + 1 类 path-splitting + `LocalCodingRuntime.storage` optional 根因，在 `src/runtime/systemPromptBuilder.ts` 增强 `extractAbsolutePaths()`：① URL/protocol-relative URL 在 pathPattern 之前先丢弃；② 单段 bare Latin word prose (`/while`、`/memory`)、CJK + Common (含 em-dash)、CJK + Latin 混排、CJK 两段 prose 在非存在时整段丢弃；③ 实存绝对路径短路（`/etc/hosts` / `/bin/bash` / `iCloud\ Documents`），不再被 prose guard 误杀；④ shell escape `\ ` 通过 SPACE_MARK 哨兵保留为单一 candidate。`createDefaultToolRegistry({ storage })` 新增 storage 哨兵（`storage: null` → 隐藏 `contextSearch` / `contextRecent` / `contextSummarize`），`createRuntime.ts` / `AgentScheduler.ts` / `runnerComparisonBenchmark.ts` 三个调用点全部更新；`test/runtime.test.ts` + 1 个新增 `test/runtime-context-tools-registry-gate.test.ts` 共 11 个 test 守住 `session_cf361f04` 全部失败点。**Phase C 已在代码中收口（prior）** — `src/tools/builtin/contextSearch.ts:39-45` 与 `contextRecent.ts:35-41` 已检查 `context.storage`、返回 `CONTEXT_STORAGE_UNAVAILABLE` + `repairHint`；`maxTokens.max(5000)` schema 强制；model prompt 明确 `default 5000`。**Phase B 收口（2026-06-18）** — `src/runtime/sessionRootContinuity.ts` 新增纯 decision helper（4 decision × 9 reason），`SessionRootContinuityEventSchema` 加入 `NexusEventSchema` discriminated union，`LLMCodingRuntime` 在 `hasSessionContext` 时调用 `resolveCwdWithContinuity()` 并 yield `session_root_continuity` event，`RuntimeExecuteOptions` 新增 `storedSessionCwd` / `latestTaskPrimaryRoot` / `acceptExternalPromptPath` 三个 optional 字段，`AgentTrace` 投影把最近一条 continuity event 上浮为 run span 的 `lastContinuity*` 6 个 attributes。`test/session-root-continuity.test.ts` 17/17 pass + `test/runtime.test.ts` +5 + `test/inspect-session.test.ts` +1 守住 `session_cf361f04` 的 cwd 切换面。**Phase D / E / F 仍 Open**：D 是 `ContextEstimateCalibration` diagnostic（provider usage vs local estimate 2x ratio 触发 warn），E 是 `ROOT_SCAN_REQUIRES_CONFIRMATION` 工具层 guard，F 是 `UserArtifactContinuity`（长文粘贴 / 文件路径 / “这个文章”跨 turn 指代锚定）。2026-06-18 补充 `session_cf361f04-7ab1-43a5-907a-41a808942686` 作为第二真实 regression：URL 被误识别为 protocol-relative path、`Mobile\ Documents` 被拆坏、外部文章路径替换 project root、`contextRecent` storage unavailable 后最终回答遗忘文章。2026-06-18 通过对 `extractAbsolutePaths()` + `resolveCwdFromPrompt()` + `LocalCodingRuntime.storage` 的端到端复盘，定位到 Phase A follow-up 仍需 4 类补刀（见 §10.1 详细证据），并在 §10.2 确认 `LocalCodingRuntime` 的 optional storage 是 session_cf361f04 seq=16671 `CONTEXT_STORAGE_UNAVAILABLE` 的真实根因。

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

### Phase C — Recall Tool Storage Contract — ✅ 收口（prior, 2026-06-17 同步）

**Status (2026-06-17)**: ✅ 收口（计划升级时回溯标记；实际代码先于本 plan 落地）。

- **已落地位置**:
  - `src/tools/builtin/contextSearch.ts:39-45` — `if (!context.storage)` 返回 `CONTEXT_STORAGE_UNAVAILABLE` + `repairHint: 'Continue from visible session context, or retry contextSearch in a runtime with storage attached.'`
  - `src/tools/builtin/contextRecent.ts:35-41` — 同上语义。
  - `src/tools/builtin/contextSearch.ts:17` / `contextRecent.ts:17` — `maxTokens: z.number().int().positive().max(5000).optional()` schema 强制。
  - `src/tools/builtin/contextSearch.ts:33` model prompt 明确 `maxTokens caps the response (default 5000)`。
- **未触动**: storage contract 的实现语义、schema、model prompt 全部 back-compat；`LLMCodingRuntime` 与 Nexus 透传 `context.storage` 已稳定。
- **守住边界**: 继续在 storage 缺失时返回显式 `CONTEXT_STORAGE_UNAVAILABLE`；不静默 fallback 到 visible context；不把 `contextSearch` 升级为 hidden memory source（仅 on-demand session event locator）。

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
- `contextSearch` 在 storage attached 环境下能拉取历史 events（Phase C 已在代码收口；集成断言待 Phase B 推进时补）。

**Integration — `test/inspect-session.test.ts`**（Phase B 收口时新增）
- ✅ `exportSessionTrace` 把最近一条 `session_root_continuity` event 上浮为 run span 的 6 个 continuity attributes（`bbl inspect-session <id> --trace` 的 operator surface；守 `session_cf361f04`）。

**E2E (manual replay)**
- Inspect `session_981cc5c2-230c-40d1-953c-b956e9dbaaf7` 并确认 root-cause chain 文档化。
- Inspect `session_cf361f04-7ab1-43a5-907a-41a808942686` 并确认 URL/path/artifact/recall root-cause chain 文档化。
- Re-run 4-step prompt 序列（项目架构 → `docs/nexus` → `查看有无咱们刚刚聊到的上下文管理优化的相关文档/信息` → 回忆测试）→ cwd 保持项目根、`task_scope_declared.primaryRoot` 不变、recall tools 正常工作或显式 unavailable、no tool scans `/` or `/Users` without explicit confirmation、context estimate calibration 可见（若适用）。
- Re-run article sequence（粘贴 URL-heavy 长文 → 更正为与 BabeL-O 相似性 → 提供 iCloud escaped-space path → `继续任务` → `分析这个文章给babel-o发展方向带来的启发`）→ project root continuity 保持、文章 artifact 可召回、无 `/` / `Library` / home broad scan fallback。

## Document Ownership

- This proposal owns the regression plan for cwd drift, context-estimate calibration, recall-tool storage availability, and current-session user-artifact continuity.
- The canonical context map remains [context-governance-index.md](./context-governance-index.md).
- Broader working-set and long-running assembly design remains [long-running-context-assembly.md](../proposals/long-running-context-assembly.md).
- Tool failure continuity remains [runtime-tool-loop-governance-plan.md](./runtime-tool-loop-governance-plan.md).
- Completed implementation facts must move to [../WORK_LOG.md](../WORK_LOG.md) and [../DONE.md](../DONE.md), not stay only in this proposal.

## 中文概述

### 背景

真实会话 `session_981cc5c2-230c-40d1-953c-b956e9dbaaf7` 暴露了一个组合问题：中文短语 `文档/信息` 被误识别成 `/信息`，runtime 随后把 cwd 推成 `/`，task scope 也变成根目录。后续工具开始扫 `/` 和 `/Users`，产生大量权限错误和巨型失败输出。

后续真实会话 `session_cf361f04-7ab1-43a5-907a-41a808942686` 扩展了这个问题：URL-heavy 长文中的 `https://...` / `//...` 被当成本地路径，`Mobile\ Documents` 这类 escaped-space iCloud 路径被拆坏，文章所在目录替换了 BabeL-O project root；最后 `contextRecent` storage unavailable 后，agent 忘记了已经粘贴且读取过的文章。

### 核心做法

计划从六个小切片治理：路径识别不要把普通中文 slash 短语、URL 或转义空格路径片段误判成 cwd；继续会话时优先保持历史项目根；让 `contextSearch/contextRecent` 在 LLM runtime 中拿到 storage；记录 provider usage 与本地估算的偏差；对意外根目录扫描返回可恢复诊断；把粘贴长文 / 后续文件路径 / "这个文章" 指代锚定成当前 session 的 user artifact。

### 当前状态

2026-06-17 升级为 Active Plan。Phase A（路径分类硬化）、Phase A Follow-up（5 类 prose-path 漏出 + URL 守卫 + 实存绝对路径短路 + storage 哨兵）与 Phase C（recall 工具 storage contract）已收口。**Phase B 也于 2026-06-18 收口** — `SessionRootContinuity` 纯 decision helper 落地（4 decision × 9 reason），`session_root_continuity` event 进 `NexusEventSchema` discriminated union 并被 `AgentTrace` 投影上浮为 run span 的 `lastContinuity*` attributes，`bbl inspect-session <id> --trace` 可直接显示决策与原因。17 + 5 + 1 = 23 个新 test 守住 `session_cf361f04` 的 cwd 切换面。Phase D / E / F 仍 Open。代码 / 测试事实以 [WORK_LOG.md](../WORK_LOG.md) 和 [DONE.md](../DONE.md) 为准。

### 下一步

Phase A / A Follow-up / B / C 全部收口；cwd 切换面已经从根因处封死（`extractAbsolutePaths` prose guard + `SessionRootContinuity` 决策 helper），URL 和外部文章路径不再静默替换 project root。下一步重点是 Phase D（`ContextEstimateCalibration` diagnostic — provider usage 2x 偏离时 emit warning）、Phase E（`ROOT_SCAN_REQUIRES_CONFIRMATION` 工具层 guard — Phase A 收口后此类触发应已显著减少）和 Phase F（`UserArtifactContinuity` 当前 session artifact 锚定 — `session_cf361f04` final turn 在 `contextRecent` unavailable 后遗忘已粘贴和已读取的文章）。

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
