# Session Replay and Evidence Governance Plan

Status: implemented and verified.

Primary sample: `session_315814e7-3b82-4a31-8601-a5b383288e9c`.

Implementation status as of 2026-06-13:

- Phase A-H are implemented with focused regressions.
- Follow-up parity fixes are closed: Anthropic-compatible / MiniMax adapter preflight now rejects orphan / duplicate tool results before fetch; malformed `partialInput` is normalized to `_parseError`; SQLite event append uses `event_seq` with transaction + unique index + content-digest event keys; Read cache coverage is mode-aware and preview ranges cannot satisfy non-preview reads.
- Phase E/G supersede the earlier dynamic guidance wording: provider-visible intent routing now uses structured `Turn Policy` fields (`responseMode`, `toolMode`, `evidenceMode`, `staleTaskMode`) plus a static, language-neutral system rule. The runtime no longer injects hardcoded Chinese self-diagnosis prompts, dynamic `Guidance:` text, accident-specific `Instruction:` blocks, or new natural-language `guidance` event payloads into the main provider prompt.
- Verification evidence is recorded in `docs/nexus/WORK_LOG.md` and summarized in `docs/nexus/active/TODO_runtime.md`.

## 背景

`session_315814e7-3b82-4a31-8601-a5b383288e9c` 最初看似只是一次模型把 `docs/nexus/reference/memory-capability-awareness-and-trigger-plan.md` 的真实结构 **G1-G6** 错答成 **L0-L7** 的幻觉事故。但复盘完整 event stream、runtime 源码、tool contract 与 provider replay 后，可以看到它不是单点模型错误，而是多条治理链路同时失效：

```text
证据链路：Read partial / cache / byte offset 语义错误
       ↓
行为链路：intent guidance 未锁住“问题”的指代对象，模型过度自信输出
       ↓
运行链路：SQLite event ordering / provider replay 乱序，最终 provider 协议崩溃
```

这类问题必须作为 runtime governance 处理，而不是只把结论归因到“模型会编”。BabeL-O 已经有“长期记忆不是事实源”“项目事实必须由 workspace evidence 复核”“真实会话 regression-first”的治理原则；本计划把这些原则扩展到 **session replay、tool evidence、Read contract、intent target、timeout behavior 与 self-diagnosis answer**。

## 事故摘要

### 用户可见现象

1. 用户要求查看当前文档是否已经收口。
2. 模型读取了目标文档，但只拿到 partial / truncated content。
3. 模型仍然生成了一个看似完整的 L0-L7 收口评估。
4. 用户追问为什么不重新查看。
5. 模型尝试 full Read，但 runtime cache 返回 `File unchanged since last read... refer to that instead of re-reading.`。
6. 模型随后用 Bash / Grep 才重新确认文档真实结构是 G1-G6。
7. 用户继续要求分析“你出现的问题”，模型又误转向分析项目本身。
8. 下一轮 provider replay 因 tool result / tool use 乱序被 MiniMax 拒绝，报 `tool result's tool id ... not found`。

### 关键事件证据

```text
08:48:41 Read docs/.../memory-capability-awareness-and-trigger-plan.md
         input: { maxBytes: 5000, offset: 1, limit: 60, mode: "auto" }
         output: <read-truncated bytes="15423" shownRange="1-61">...

08:49:03 assistant result
         错误输出 L0-L7 框架，并声称“核心字段已确认在缓存中”。

08:49:21 Read same file
         input: { maxBytes: 200000, mode: "full" }
         output: File unchanged since last read. The content from the earlier Read tool_result...

08:49:32 Grep headings
         output: Phase G1 / G2 / G3 / G4 / G5 / G6...

08:57:51 same timestamp events
         tool_completed call_function_l1rfnihfpdg5_1
         tool_started   call_function_l1rfnihfpdg5_1

08:59:04 provider error
         invalid params, tool result's tool id(call_function_l1rfnihfpdg5_1) not found
```

## 目标

本计划目标是把真实 session 暴露出的系统性问题收口为可测试、可维护、可解释的治理机制：

```text
1. Provider replay 必须 protocol-safe：历史 event 乱序也不能生成非法 tool_result。
2. Read 必须表达真实证据覆盖范围：partial result 不能被当成 full evidence。
3. Source reading API 必须匹配模型和用户的行号心智：避免 byte offset 被误用为 line offset。
4. Tool input parse failure 必须可 replay、可诊断、可恢复。
5. Intent guidance 必须锁住“问题”的指代对象，尤其是 agent self-diagnosis 场景。
6. Soft timeout 必须促进行为收敛，而不是允许无限探索。
7. Memory / capability / self-diagnosis 回答必须区分用户级能力、源码事实和推测。
```

## 非目标

本计划明确不做：

- 不把 provider replay 错误通过 silent model fallback 掩盖。
- 不把所有模型幻觉都改造成重型 verifier。
- 不新增一个 broad `Search` 或 `analyze` mega-tool。
- 不让 Read cache 继续承担“事实权威”角色。
- 不把 EverCore / long-term memory 作为当前文件状态或 session trace 的事实源。
- 不把 soft timeout 退回 fixed fatal cutoff。
- 不改变 Go TUI / CLI / Nexus 的 ownership：Nexus owns execution, clients own interaction。
- 不启用 write-capable child agent 或 provider auto model selection / fallback execution。

## 核心边界

### 事实权重

```text
SQLite event trace / current tool result / workspace file content
  authoritative for what happened and what exists now.

Read cache / microcompacted output / prior assistant memory
  optimization hints only; never authoritative if coverage is partial or invisible.

Long-term memory / compact summary / session summary
  background hints; must be revalidated before project-state claims.
```

### Provider protocol 边界

Provider-visible messages must satisfy:

```text
Every tool_result must have a preceding assistant tool_use with the same id.
A tool_result cannot appear before its matching tool_use.
A synthetic repair must be explicit and diagnostic-backed.
No provider request should be sent if replay normalization cannot produce a valid protocol sequence.
```

### Tool evidence 边界

```text
ListDir: directory inventory only.
Glob: path pattern discovery only.
Grep: content locator only; must Read before source-level claims.
Read partial: evidence for exactly the returned range only.
Read full: evidence for full file only if not truncated and coverage == file size.
Bash discovery: fallback / explicit command evidence, not a substitute for bounded source tools.
```

## Root Cause Map

| ID | Severity | Root cause | Source area | Symptom |
| --- | --- | --- | --- | --- |
| R1 | P0 | Event ordering relies on `timestamp + event_type` lexicographic order | `SqliteStorage.appendEvent`, `listEventsSync`, `listEvents` | `tool_completed` can sort before same-id `tool_started` |
| R2 | P0 | Provider replay does not repair completed-before-started history | `LLMCodingRuntime.mapEventsToMessages` | OpenAI-compatible provider rejects orphan `tool_result` |
| R3 | P0 | `Read` cache only checks mtime/size, not actual byte coverage | `runtimeToolLoop.ts` | full Read blocked by partial prior result |
| R4 | P0/P1 | `Read offset/limit` are byte-based but look line-based | `read.ts` schema / prompt | model reads wrong ranges, sometimes mid-token |
| R5 | P1 | cache stub wording overclaims authority | `runtimeToolLoop.ts` | model says “缓存里的内容就是权威” |
| R6 | P1 | microcompact can remove or shrink evidence while cache says refer to earlier result | `microCompact.ts`, context assembly, read cache | hidden / partial “ghost evidence” |
| R7 | P1 | Grep only supports single `pathMatches` string | `grep.ts` schema | model emits duplicate JSON keys / malformed tool input |
| R8 | P1 | parse-error tool_completed can exist without paired tool_started | `runtimeToolLoop.ts` parse error path | replay/debugging weaker; protocol pairing harder |
| R9 | P1 | intent guidance lacks target binding for “问题” | `intentGuidance.ts` | user asks agent self-failure analysis; model analyzes project feature |
| R10 | P1 | near-timeout warning is advisory but not behavioral | timeout scheduler / runtime guidance | model keeps exploratory tool calls near budget |
| R11 | P2 | memory capability answer guard too narrow / not fully regression-covered in Chinese real prompts | `intentGuidance.ts`, `runtimePipeline.ts`, `LLMCodingRuntime.ts` | capability answers expose source paths / MCP / commit hashes |
| R12 | P2 | self-diagnosis answers do not separate evidence from speculation | prompt / runtime guidance | explanation can become another polished but weakly grounded narrative |

## Phase A — P0 Event Ordering and Provider Replay Safety

Status: implemented and verified.

### Problem

`SqliteStorage.appendEvent()` builds event keys as:

```ts
`${sessionId}:${event.timestamp}:${event.type}:${eventIndexPayload(event)}`
```

History is read with:

```sql
ORDER BY timestamp ASC, event_key ASC
```

When `tool_started` and `tool_completed` share the same millisecond timestamp and tool id, lexical ordering puts `tool_completed` before `tool_started`:

```text
tool_completed < tool_started
```

`mapEventsToMessages()` then can emit provider messages in invalid order:

```text
role=tool tool_call_id=X
role=assistant tool_calls=[X]
```

OpenAI-compatible providers correctly reject this with `tool result's tool id ... not found`.

### Required changes

1. Add a monotonic event sequence for persisted event ordering.

Recommended schema:

```sql
ALTER TABLE events ADD COLUMN event_seq INTEGER;
CREATE INDEX events_session_seq_idx ON events(session_id, event_seq ASC);
```

For new rows, assign sequence from an atomic in-process counter or SQLite monotonic source. For existing rows, backfill by current best-effort order:

```sql
ORDER BY timestamp ASC,
  CASE event_type
    WHEN 'session_started' THEN 10
    WHEN 'user_message' THEN 20
    WHEN 'user_intake_guidance' THEN 30
    WHEN 'task_scope_declared' THEN 40
    WHEN 'assistant_delta' THEN 50
    WHEN 'tool_started' THEN 60
    WHEN 'permission_request' THEN 70
    WHEN 'permission_response' THEN 80
    WHEN 'tool_completed' THEN 90
    WHEN 'context_grounding_confirmed' THEN 100
    WHEN 'result' THEN 200
    WHEN 'error' THEN 210
    ELSE 150
  END,
  event_key ASC
```

The backfill is only a migration heuristic; all new correctness must come from sequence, not event type ordering.

2. Update all event listing paths to order by sequence:

```sql
ORDER BY event_seq ASC
```

Touchpoints:

```text
src/storage/SqliteStorage.ts
  - appendEvent
  - listEvents
  - listSessions(includeEvents)
  - listAllEvents / listEventsSync
```

3. Add provider replay normalization guard.

`mapEventsToMessages()` should not directly trust persisted order for tool pairs. It should either:

- construct paired groups by `toolUseId`, then emit `tool_use -> tool_result`; or
- while iterating, buffer early `tool_completed` until matching `tool_started` appears; or
- emit a `PROVIDER_REPLAY_REPAIRED` diagnostic and repair order.

If repair is impossible, fail before provider call with a runtime diagnostic:

```text
PROVIDER_REPLAY_INVALID_TOOL_SEQUENCE
```

4. Add provider adapter validation before sending request.

Before `OpenAIAdapter` sends `messages`, validate:

```text
- every role=tool message has a previous assistant message with matching tool_calls id;
- tool result ids are not duplicated unless provider protocol allows it;
- no role=tool appears after a non-tool user message without matching assistant tool_use context.
```

Do not silently delete invalid messages; surface a runtime error with replay diagnostics.

### Acceptance criteria

- Same-millisecond `tool_started` / `tool_completed` persists and replays in correct order.
- Historical corrupted ordering can be repaired or fails before provider request with actionable diagnostic.
- MiniMax / OpenAI-compatible request never contains orphan tool results.
- `bbl inspect-session` can show ordering diagnostics for repaired sessions.

### Regression tests

```text
test/storage.test.ts
  - sqlite event sequence preserves append order for same timestamp events.

test/runtime-llm.test.ts
  - mapEventsToMessages repairs same-id completed-before-started order.
  - provider request validation rejects orphan tool_result before adapter fetch.

test/provider-adapter.test.ts
  - OpenAIAdapter message validation catches role=tool without prior tool_call.
```

## Phase B — P0 Read Evidence Coverage and Cache Contract

Status: implemented and verified.

### Problem

`runtimeToolLoop.ts` caches Read by path and mtime only:

```ts
readFileCache.set(readPath, { mtime: stat.mtimeMs, size: stat.size })
```

On later Read with matching mtime:

```text
File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.
```

This is invalid when the prior result was:

- partial due to `maxBytes`;
- partial due to `offset/limit`;
- a preview;
- microcompacted / snipped;
- no longer provider-visible.

### Required changes

1. Replace mtime-only cache value with evidence coverage.

Recommended type:

```ts
type ReadFileCacheEntry = {
  mtime: number
  size: number
  ranges: Array<{
    startByte: number
    endByte: number
    completeFile: boolean
    truncated: boolean
    mode: 'auto' | 'full' | 'preview'
    maxBytes: number
    offset?: number
    limit?: number
    toolUseId: string
    providerVisible: boolean
    compacted?: boolean
  }>
}
```

2. Compute requested coverage before cache hit.

```ts
type RequestedReadCoverage = {
  startByte: number
  requestedEndByte: number
  requiresFullFile: boolean
}
```

A cache hit may return a stub only when:

```text
same mtime
same size
requested range is fully covered by previous visible non-compacted range
previous range was not truncated for the requested need
```

3. If requested range is not covered, execute the actual Read.

Do not tell the model to refer to an earlier partial result.

4. Change stub wording from authority to coverage diagnostic.

Good:

```text
File unchanged. The requested byte range 0-15423 was already returned in full by Read call <id>; use that earlier full-file result instead of re-reading.
```

Partial case:

```text
File unchanged, but the previous Read only covered bytes 1-5001 of 15423 and was truncated. Re-reading the requested range now because the earlier result is not full-file evidence.
```

Bad:

```text
File unchanged since last read... refer to that instead.
```

5. Clear / downgrade cache entries after microcompact when visibility changes.

`LLMCodingRuntime.postCompactGroundingEvents()` already clears `readFileCache` after compact. Microcompact happens during context assembly without necessarily clearing the runtime cache. Either:

- feed microcompact metrics back into read cache visibility; or
- disallow cache stub unless the prior result exists in the current `messages` payload; or
- only cache full-file reads that are small enough not to be microcompacted.

### Acceptance criteria

- A partial `Read(maxBytes=5000)` followed by `Read(mode='full', maxBytes=200000)` executes the full Read.
- A partial `Read(offset/limit)` does not block a later full Read.
- A full small file Read may still be deduplicated safely.
- Stub output explicitly names coverage and never implies partial evidence is full evidence.

### Regression tests

```text
test/runtime.test.ts
  - Read partial then full does not return unchanged stub.
  - Read full then same full may return unchanged stub.
  - Read partial line/range then overlapping uncovered range executes tool.
  - cache is invalidated or bypassed after microcompact visibility loss.
```

## Phase C — P0/P1 Read Line Semantics and Targeted Source Evidence

Status: implemented and verified.

### Problem

`Read` input exposes:

```ts
offset?: number
limit?: number
```

But implementation treats them as bytes:

```ts
const start = input.offset ?? 0
const requestedBytes = input.limit ?? input.maxBytes
const output = file.subarray(start, end).toString('utf8')
```

Model and users naturally treat offset / limit as line numbers when discussing source or markdown line references. The session showed calls like:

```json
{ "offset": 95, "limit": 230 }
{ "offset": 420, "limit": 55 }
```

These were intended as line ranges but executed as byte ranges, producing wrong snippets or mid-token output.

### Required changes

Preferred API:

```ts
const inputSchema = z.object({
  path: z.string().min(1),
  maxBytes: z.number().int().positive().max(1_000_000).default(DEFAULT_MAX_BYTES),
  lineOffset: z.number().int().positive().optional(),
  lineLimit: z.number().int().positive().max(10_000).optional(),
  byteOffset: z.number().int().nonnegative().optional(),
  byteLimit: z.number().int().positive().max(1_000_000).optional(),
  mode: z.enum(['auto', 'full', 'preview']).default('auto'),
})
```

Back-compat option:

- keep `offset` / `limit` temporarily;
- mark them as deprecated byte aliases;
- if both are present with source-like files, return diagnostic asking for `lineOffset/lineLimit` or `byteOffset/byteLimit`.

Tool prompt must say:

```text
Use lineOffset/lineLimit for source or markdown line ranges. byteOffset/byteLimit are for binary-safe byte windows only.
```

Output tags must be explicit:

```text
<read-truncated path="..." bytes="15423" shownBytes="0-5000" shownLines="1-143">
```

### Acceptance criteria

- `Read(path, lineOffset=95, lineLimit=60)` returns lines 95-154.
- byte fields remain available for large file continuation and precise budget windows.
- old `offset/limit` does not silently behave as line numbers.
- output always shows both byte and line coverage.

### Regression tests

```text
test/read-tool.test.ts
  - lineOffset/lineLimit returns expected lines.
  - byteOffset/byteLimit returns expected bytes.
  - output tags include shownBytes and shownLines.
  - deprecated offset/limit emits diagnostic or maps only under explicit compatibility mode.
```

## Phase D — P1 Tool Input Parse and Schema Ergonomics

Status: implemented and verified.

### Problem

The session had repeated Grep parse errors. The model attempted multiple `pathMatches` keys to express multiple globs:

```json
{
  "pattern": "MemoryProvider|memoryProvider",
  "path": ".",
  "pathMatches": "src/**/*.ts",
  "pathMatches": "test/**/*.ts",
  "pathMatches": "docs/**/*.md"
}
```

Current Grep schema accepts only one string:

```ts
pathMatches: z.string().optional()
```

Also, parse-error path emits `tool_completed(success=false)` without a normal preceding `tool_started`, weakening replay invariants.

### Required changes

1. Expand Grep schema:

```ts
pathMatches: z.union([z.string(), z.array(z.string()).max(20)]).optional()
```

or introduce clearer names:

```ts
includeGlobs?: string[]
excludeGlobs?: string[]
```

2. Tool prompt examples must show valid multi-glob usage.

3. Parse error path must be protocol-pair-safe.

When `resolveProviderToolCallInput()` returns parse error:

- emit `tool_started` with `input: { _parseError: true, rawPreview }`; then
- emit `tool_completed(success=false)`; and
- return a tool_result tied to the same id.

If the actual provider did not emit a valid tool_use input, provider replay must still have a matching synthetic assistant tool_use block for that id, or the event should be represented by a separate non-tool diagnostic not replayed as provider tool_result.

4. Add structured repair hint:

```json
{
  "code": "TOOL_INPUT_PARSE_ERROR",
  "message": "Tool input was not valid JSON.",
  "repairHint": "Use a single pathMatches string or includeGlobs array; do not repeat JSON keys."
}
```

### Acceptance criteria

- Multi-glob Grep calls no longer require duplicate JSON keys.
- Parse errors are replay-safe.
- Parse errors teach the model the valid schema shape.

## Phase E — P1 Intent Target Binding and Agent Self-Diagnosis Routing

Status: implemented and verified.

### Problem

The user asked:

```text
查看项目源码，深度分析问题
```

Given prior turns:

```text
为什么你会编？
这是你系统prompt的问题吗？
```

The object under analysis was the agent/runtime failure, not the memory system feature. Intake guidance said only:

```text
Deeply analyze the project source code to identify and diagnose the underlying issue.
```

It did not bind the target. The model drifted back into evaluating the project/document itself.

### Required changes

Add target classification to user intake guidance:

```ts
type ProblemTarget =
  | 'agent_failure'
  | 'runtime_replay'
  | 'tool_evidence'
  | 'project_feature'
  | 'user_artifact'
  | 'unknown'
```

The intake classifier should identify the target semantically rather than by matching a fixed phrase list. The production path must not inject hardcoded Chinese/English self-diagnosis examples into the main provider prompt.

If `problemTarget='agent_failure'`, provider-visible routing is expressed as structured `Turn Policy`:

```text
Problem target: agent_failure
Evidence mode: verify_before_claim
Stale task mode: background_only
```

The static system prompt explains how to interpret `Turn Policy`; the per-turn guidance block must not include dynamic `Guidance:` text or accident-specific `Instruction:` prose.

For correction turns, `prioritize_latest` should not erase the target; it should preserve the correction object.

### Acceptance criteria

- After “为什么你会编 / 系统prompt的问题吗”, a follow-up “查看源码深度分析问题” routes to agent/runtime failure analysis.
- User correction “不是项目本身” immediately pivots without needing another provider call that can fail.
- Intake diagnostics expose `problemTarget` for debugging.

### Regression tests

```text
test/runtime-llm.test.ts
  - self-diagnosis chain classifies problemTarget=agent_failure.
  - feature analysis chain classifies problemTarget=project_feature.
  - correction preserves target and changes action hint appropriately.
  - provider-visible prompt contains Turn Policy fields, not dynamic Guidance/Instruction text.

test/context-assembler.test.ts
  - correction and pause turns render structured Turn Policy fields.
```

## Phase F — P1 Soft Timeout Behavior Governance

Status: implemented and verified.

### Problem

Soft timeout events worked mechanically, but near-timeout warning did not force behavior to converge. In the session, after near-timeout warning, the model continued exploratory Grep / Read calls before returning a broad answer.

### Required changes

When `near_timeout_warning` fires, inject a model-visible constraint for the next provider continuation:

```text
You are near the execution budget.
Do not start new exploratory tool calls.
Either answer with verified evidence already collected, or run at most one explicitly bounded final check.
Mark unverified claims as unverified.
If the task needs more exploration, ask to continue with a fresh budget.
```

Runtime may track:

```ts
timeoutMode: 'normal' | 'near_timeout' | 'extension_final'
remainingExploratoryToolBudget: number
```

For soft timeout extension, enforce:

```text
extension 1/1 means wrap up; no broad discovery.
```

### Acceptance criteria

- Near-timeout turns no longer start multiple new exploratory tools.
- Final answer after timeout warning distinguishes verified evidence from missing checks.
- Soft timeout remains recoverable and does not become a fatal fixed cutoff.

## Phase G — P2 Capability and Self-Diagnosis Answer Governance

Status: implemented and verified.

### Problem

Capability questions such as:

```text
你当前能否写入记忆？
```

should get user-facing capability answers. They should not expose:

- `src/...` paths;
- commit hashes;
- MCP sidecar implementation details;
- provider internals;
- hidden prompt / tool wiring.

The session included over-detailed internal claims, including a wrong `src/everCore/` location.

Self-diagnosis answers also need evidence grading. A polished explanation of “why I failed” can itself become another ungrounded narrative if it cites unseen system prompt sections or training tendencies as fact.

### Required changes

1. Add Chinese-focused memory capability regression:

```text
Prompt: 你当前能否写入记忆？
Expected: no src/, no commit hash, no MCP, no sidecar, no MemoryProvider.
```

2. Add generic capability-answer answer contract:

```text
Answer at user-facing capability level unless user explicitly asks for implementation details and tools have verified them.
```

3. Add self-diagnosis answer contract:

The static task-execution rule handles evidence separation generically: `evidenceMode=verify_before_claim` requires verified observations, code-confirmed causes, and hypotheses to remain distinct. This is intentionally a general policy interpretation rule, not a per-turn fixed answer template.

4. Runtime provides self-diagnosis governance through structured `Turn Policy` rather than dynamic fixed prose:

```text
problemTarget=agent_failure
evidenceMode=verify_before_claim
staleTaskMode=background_only
```

The static `Turn Policy` system rule tells the model to verify claims against current session, source, or tool evidence before presenting them as fact. New `user_intake_guidance` events persist structured fields only; historical events with a `guidance` field remain readable for compatibility but do not influence provider-visible routing.

### Acceptance criteria

- Capability answers stay user-facing by default.
- Implementation details appear only after explicit implementation-analysis request and tool verification.
- Self-diagnosis outputs evidence levels.

## Phase H — P2 Path Normalization for Split / Wrapped Paths

Status: implemented and verified.

### Problem

The user typed a wrapped path:

```text
docs/nexus/reference/memory-capability
  -awareness-and-trigger-plan.md
```

Intake extracted:

```json
"/nexus/reference/memory-capability"
```

The model eventually used the right path from context, but path extraction diagnostics were degraded.

### Required changes

Add path normalization for common terminal wrapping:

```text
word\n  -suffix.md  -> word-suffix.md
word\n-suffix.md   -> word-suffix.md
```

Only apply when:

- both sides look like path fragments;
- suffix starts with `-` or `_`;
- resulting path exists or has strong workspace candidate.

### Acceptance criteria

- Wrapped hyphenated markdown paths normalize to actual file path.
- No normalization across paragraph boundaries or arbitrary prose.

## Cross-Phase Validation Matrix

| Scenario | Expected guard |
| --- | --- |
| Same timestamp tool_completed before tool_started | replay repair or pre-provider diagnostic |
| Partial Read then full Read | actual full Read executes |
| Full Read then same full Read | safe coverage stub allowed |
| Read lineOffset/lineLimit | correct source lines returned |
| Grep multiple globs | valid schema and execution |
| Malformed tool JSON | paired diagnostic, replay-safe |
| Agent self-failure follow-up | `problemTarget=agent_failure` |
| Near timeout + broad search | constrained to answer / one bounded check |
| Memory capability Chinese prompt | no internal implementation leakage |
| Wrapped hyphenated path | normalized or diagnostic candidate shown |

## Implementation Touchpoints

Likely files:

```text
src/storage/SqliteStorage.ts
src/storage/Storage.ts
src/runtime/LLMCodingRuntime.ts
src/runtime/runtimePipeline.ts
src/runtime/runtimeToolLoop.ts
src/runtime/intentGuidance.ts
src/runtime/compactors/microCompact.ts
src/tools/builtin/read.ts
src/tools/builtin/grep.ts
src/providers/adapters/OpenAIAdapter.ts
src/cli/commands/inspectSession.ts
src/nexus/app.ts
src/shared/events.ts
test/runtime.test.ts
test/runtime-llm.test.ts
test/storage.test.ts
test/mcp.test.ts
test/read-tool.test.ts
test/intent-guidance.test.ts
```

Documentation touchpoints:

```text
docs/nexus/TODO.md
docs/nexus/active/TODO_runtime.md
docs/nexus/reference/README.md
docs/nexus/WORK_LOG.md
```

## Implemented Slices

Implementation followed this order because provider replay errors can permanently break a live session:

```text
Slice 1 — P0 replay safety
  A1. Add event sequence or equivalent deterministic append order.
  A2. Update list events ordering.
  A3. Add mapEventsToMessages repair / validation.
  A4. Regression for same-ms tool pair.

Slice 2 — P0 Read evidence contract
  B1. Make readFileCache range-aware.
  B2. Prevent partial -> full stub.
  B3. Rewrite stub wording.
  B4. Regression from session_315814e7.

Slice 3 — P1 Read line API + Grep ergonomics
  C1. Add lineOffset/lineLimit or explicit byteOffset/byteLimit.
  C2. Expand Grep multi-glob schema.
  C3. Make parse errors replay-safe.

Slice 4 — P1/P2 behavior governance
  D1. Add problemTarget to intent guidance.
  D2. Add near-timeout behavior constraint.
  D3. Add capability/self-diagnosis answer contracts and regressions.
```

## Closure Criteria

This plan is closed. Current evidence:

1. Same-millisecond `tool_completed` / `tool_started` is protected by `event_seq`, replay repair, and OpenAI-compatible pre-fetch validation.
2. Partial Read -> full Read executes the full Read; safe cache stubs require full requested coverage and explicitly name byte coverage.
3. Tool replay validation rejects orphan / duplicate `tool_result` before provider fetch.
4. `Read` supports `lineOffset` / `lineLimit` and explicit `byteOffset` / `byteLimit`, and output exposes `shownBytes` / `shownLines`.
5. Self-diagnosis and capability prompts have focused regressions; provider-visible routing uses structured `Turn Policy` rather than hardcoded prompt text.
6. `docs/nexus/active/TODO_runtime.md`, `docs/nexus/reference/README.md`, and `docs/nexus/WORK_LOG.md` reflect the implemented governance boundary.

## Closed Decisions / Guardrails

- Runtime must not hide provider protocol replay bugs by switching providers.
- Read cache is an optimization layer, not a fact source.
- Partial Read is evidence only for its returned range.
- Grep remains locator evidence; Read remains source-understanding evidence.
- Soft timeout remains recoverable, but near-timeout behavior must converge.
- Agent self-diagnosis must be evidence-graded.
- Long-term memory remains volatile and non-authoritative.
