# Skill Execution and Automated Normalized Skill Generation Governance Plan

## Status

- Status: Proposed
- Scope: Nexus runtime, Go TUI slash commands, skill loader/matcher, context assembly, session events, tests, and documentation
- Intended audience: BabeL-O runtime maintainers and prompt/agent architecture contributors
- Last updated: 2026-06-15

## Executive summary

BabeL-O currently has a useful but limited skill substrate: Markdown skill files are loaded from built-in, user, and project directories, matched against the current prompt via trigger strings, and injected into the system prompt as `Active Developer Skills`. This gives the model reusable behavioral context, but it does not yet provide a complete skill product loop.

The missing loop has two major parts:

1. **Executable skill capability** — a user or model should be able to explicitly list, inspect, invoke, and observe a skill, instead of relying only on implicit trigger matching.
2. **Automated normalized skill generation** — a successful task/session should be capturable into a validated, normalized, reusable skill file with clear metadata, permission boundaries, and review before persistence.

This document proposes a staged design that preserves the existing lightweight skill system while adding governance, observability, explicit execution, validation, and eventually automatic skill capture/save.

## Current state

### Implemented today

Current skill implementation is centered on these files:

- `src/skills/loader.ts`
- `src/skills/matcher.ts`
- `src/runtime/contextAssembler.ts`
- `src/runtime/systemPromptBuilder.ts`
- `src/runtime/contextManager.ts`
- `src/runtime/compactPostRestore.ts`
- `src/skills/built-in/*.md`
- `test/skills.test.ts`
- `test/system-prompt-builder.test.ts`

Current implemented behavior:

1. Skill files are Markdown files with minimal front matter.
2. Built-in skills are loaded from `src/skills/built-in` or SEA assets.
3. User skills are loaded from `~/.babel-o/skills`.
4. Project skills are loaded from `<cwd>/.babel-o/skills`.
5. Skills with the same `id` are overlaid in this order:
   - built-in
   - user
   - project
6. Matching uses trigger substring occurrences against the current prompt.
7. Matched skills are sorted by score, priority, and id.
8. Up to three matched skills are injected into the system prompt as `Active Developer Skills`.
9. Active skills are retained through context and compaction-related state.

Current minimal skill shape:

```ts
export interface Skill {
  id: string
  name: string
  triggers: string[]
  priority: number
  content: string
}
```

Current front matter example:

```markdown
---
id: testing
name: Testing
triggers: [test, tests, coverage]
priority: 10
---

Skill body...
```

### Not implemented today

The following are not currently implemented as runtime/product capabilities:

1. Dynamic slash-command registration from skill files.
2. `/skill` or `/skills` commands for listing, showing, validating, invoking, or saving skills.
3. Model-callable skill tools such as `SkillRun`, `SkillList`, `SkillCreate`, or `SkillValidate`.
4. Session events for skill lifecycle, such as `skill_matched`, `skill_invoked`, or `skill_saved`.
5. Strict skill schema validation.
6. Skill normalization/formatting.
7. Skill diagnostics for duplicate ids, invalid triggers, malformed metadata, or source conflicts.
8. Automatic generation of reusable skill files from current work/session history.
9. Permission/governance metadata for generated skills.
10. Human review flow before persisting generated skills.

### Important distinction

Current BabeL-O skills are **prompt-context modules**, not executable commands.

The current slash command system is separate. The Go TUI keeps a static slash command registry in `clients/go-tui/internal/tui/slash.go`. Commands such as `/help`, `/context`, `/compact`, `/memory`, `/tools`, and `/agents` are hardcoded and do not dynamically map to skill files.

## Goals

### Primary goals

1. Make skills explicit, observable, and invokable.
2. Preserve current trigger-based automatic skill activation.
3. Add normalized skill schema and validation before enabling automatic skill generation.
4. Allow high-value session knowledge to be captured into project/user reusable skills.
5. Keep skill execution bounded, auditable, and compatible with current permission and tool-policy architecture.
6. Avoid turning skills into broad, fuzzy tools with unclear boundaries.

### Non-goals

1. Do not make skills equivalent to arbitrary shell scripts.
2. Do not allow generated skills to silently gain write/execute/network authority.
3. Do not auto-save generated skills without user confirmation.
4. Do not replace existing tool permission gates with skill metadata.
5. Do not introduce write-capable child agent behavior as part of initial skill work.
6. Do not auto-switch models based on skill metadata.
7. Do not store project facts in skills when they are already derivable from code, tests, docs, or git history.

## Design principles

1. **Skill as instruction, not bypass**
   - A skill may guide model behavior, but it must not bypass tool permissions, policy mode, or user approval.

2. **Explicit beats invisible**
   - Trigger-based activation remains useful, but users need `/skill show`, `/skill run`, and session events to understand what happened.

3. **Validate before generate**
   - Automatic generation must not precede schema validation and normalization. Otherwise the skill library will accumulate low-quality artifacts.

4. **Orthogonal tools**
   - Prefer bounded operations like `SkillList`, `SkillShow`, `SkillValidate`, `SkillDraft`, and `SkillSave` over one broad `Skill` tool with ambiguous behavior.

5. **Project skills are reviewable assets**
   - Project skills should live in `<cwd>/.babel-o/skills` and be treated as source-like artifacts that can be reviewed.

6. **User skills are personal policy/instruction assets**
   - User skills in `~/.babel-o/skills` should require explicit confirmation before writes.

7. **Generation should produce drafts first**
   - Capturing a session should produce a preview/draft, then validate, then ask for confirmation, then persist.

## Proposed target capability

At the end state, BabeL-O should support:

```text
/skill list
/skill show testing
/skill run testing write tests for src/runtime/runtimeToolLoop.ts
/skill validate
/skill doctor
/skill draft "permission-denial recovery workflow"
/skill save --scope project permission-denial-recovery
/skill capture --scope project "turn this session's successful workflow into a reusable skill"
```

And model-visible capabilities should eventually be able to perform bounded skill operations, for example:

- list available skills
- inspect a specific skill
- draft a normalized skill
- validate a draft
- request permission to save a skill

These operations should remain separate and auditable.

## Proposed skill schema

### Normalized front matter

The normalized schema should extend the existing minimal schema while remaining compatible with existing skills.

```yaml
---
id: babel-o-permission-denial-recovery
name: BabeL-O Permission Denial Recovery
description: Recover from denied tool calls by feeding actionable feedback back to the model.
version: 1
status: active
source: project
scope: project
triggers:
  - permission denial
  - tool denied
  - soft-deny
  - permission_request
priority: 80
risk: read
allowedTools:
  - Read
  - Grep
  - Glob
  - TaskCreate
createdAt: 2026-06-15
updatedAt: 2026-06-15
owner: project
---
```

### Field definitions

| Field | Required | Description |
|---|---:|---|
| `id` | yes | Stable lowercase kebab-case identifier. |
| `name` | yes | Human-readable name. |
| `description` | yes | One-line summary used in listing, diagnostics, and generation review. |
| `version` | yes | Integer schema/content version. Initial value should be `1`. |
| `status` | yes | `active`, `draft`, or `disabled`. |
| `source` | no | Resolved source after load: `builtin`, `user`, or `project`. Usually loader-derived, not author-provided. |
| `scope` | yes | Intended persistence scope: `builtin`, `user`, or `project`. |
| `triggers` | yes | Non-empty list of prompt trigger strings. |
| `priority` | yes | Integer matching priority. Recommended range: `0..100`. |
| `risk` | yes | Maximum expected risk: `read`, `write`, `execute`, `network`, or `task`. Informational and governance-oriented; not a permission bypass. |
| `allowedTools` | no | Advisory allow-list of tool names the skill expects to use. Runtime policy remains authoritative. |
| `createdAt` | no | ISO date for generated skills. |
| `updatedAt` | no | ISO date for generated or modified skills. |
| `owner` | no | `builtin`, `user`, `project`, or a maintainer label. |

### Backward compatibility

Existing skills with only `id`, `name`, `triggers`, and `priority` should continue to load. The loader should normalize missing fields to safe defaults:

```ts
{
  version: 1,
  status: 'active',
  description: name,
  scope: source,
  risk: 'read',
  allowedTools: [],
}
```

Normalization should not rewrite files automatically. Rewrites should occur only through an explicit format/save action.

## Recommended skill body template

Generated and normalized skills should follow a stable Markdown body layout:

```markdown
# Purpose

Explain what this skill helps with.

# When to use

- Trigger condition 1
- Trigger condition 2

# Inputs

- Required context
- Optional context

# Procedure

1. Step one
2. Step two
3. Step three

# Tool policy

- Preferred read-only tools
- Write/execute tools that may be needed
- Approval expectations

# Output format

Describe how the assistant should respond or what artifact should be produced.

# Failure handling

Describe how to recover from missing context, tool failure, permission denial, invalid inputs, or test failure.

# Examples

## Example 1

Input and expected behavior.
```

## Architecture proposal

### Layer 1: Skill domain module

Create or refactor into a more complete skill domain:

```text
src/skills/
  loader.ts
  matcher.ts
  schema.ts
  validator.ts
  normalizer.ts
  formatter.ts
  registry.ts
  generator.ts
  index.ts
```

Responsibilities:

- `schema.ts`
  - TypeScript types for raw, normalized, validation, diagnostics, and source metadata.
- `validator.ts`
  - Validate front matter and body sections.
  - Return structured diagnostics instead of throwing for user-authored files.
- `normalizer.ts`
  - Convert legacy/minimal skills into normalized in-memory shape.
- `formatter.ts`
  - Format normalized skill back into canonical Markdown.
- `registry.ts`
  - Load built-in/user/project sources.
  - Preserve source provenance.
  - Detect overlays and conflicts.
  - Provide `list`, `get`, `match`, and `diagnose` APIs.
- `generator.ts`
  - Draft skills from structured inputs or session summaries.
  - Never persist directly.

### Layer 2: Runtime integration

Current integration in `contextAssembler.ts` should be updated from direct `loadAllSkills + matchSkills` to a registry API:

```ts
const registry = await SkillRegistry.load({ cwd })
const matched = registry.match(prompt, { maxCount: 3 })
```

The context assembler should emit or attach diagnostics for:

- matched skill ids
- skipped disabled skills
- invalid skill files
- overlay source resolution

Skill injection should include metadata useful to the model but avoid excessive token use:

```text
Active Developer Skills:
## Skill: Testing (id: testing, source: builtin, risk: read)
...
```

### Layer 3: Nexus API

Add backend endpoints for Go TUI and future clients.

Proposed endpoints:

```text
GET  /v1/skills
GET  /v1/skills/:id
POST /v1/skills/match
POST /v1/skills/validate
POST /v1/skills/draft
POST /v1/skills/save
POST /v1/skills/invoke
```

Minimum P1 endpoints can be smaller:

```text
GET  /v1/skills
GET  /v1/skills/:id
POST /v1/skills/invoke
POST /v1/skills/validate
```

Endpoint expectations:

- `GET /v1/skills`
  - Returns normalized metadata, not full bodies by default.
- `GET /v1/skills/:id`
  - Returns metadata, body, source, and diagnostics.
- `POST /v1/skills/match`
  - Given prompt and cwd, returns matched skill ids and reasons.
- `POST /v1/skills/validate`
  - Validates raw Markdown or loaded skill id.
- `POST /v1/skills/draft`
  - Returns a generated draft and validation diagnostics.
- `POST /v1/skills/save`
  - Persists a validated skill to user/project scope after client confirmation.
- `POST /v1/skills/invoke`
  - Returns an execution prompt envelope or starts an execution stream with explicit skill context.

### Layer 4: Go TUI slash command integration

Extend the static slash registry with a single bounded command family:

```text
/skill
/skills
```

Suggested subcommands:

```text
/skill list
/skill show <id>
/skill run <id> <prompt>
/skill validate [id]
/skill doctor
/skill draft <description>
/skill capture <description>
/skill save --scope project|user <id>
```

P1 should implement only:

```text
/skill list
/skill show <id>
/skill run <id> <prompt>
/skill validate [id]
```

`/skill run` can initially submit a normal runtime prompt with explicit skill context, rather than introducing a new tool loop concept.

Example expansion:

```text
Use the following developer skill explicitly for this task.

<skill metadata and body>

User task:
<user prompt>
```

Later versions can use a dedicated runtime flag:

```json
{
  "prompt": "...",
  "skillIds": ["testing"],
  "skillMode": "explicit"
}
```

### Layer 5: Model-visible tools

Model-visible skill tools should be added only after validation, slash invocation, and events are stable.

Recommended tool boundary:

1. `SkillList`
   - read-only
   - returns metadata only
2. `SkillShow`
   - read-only
   - returns selected skill body and diagnostics
3. `SkillValidate`
   - read-only
   - validates a raw draft or existing skill
4. `SkillDraft`
   - task/write-adjacent but does not write files
   - generates normalized Markdown draft from structured input
5. `SkillSave`
   - write risk
   - writes to user/project skill directory after permission approval

Avoid a single broad `Skill` tool with many modes. Each operation should be independently permissioned and testable.

## Explicit skill invocation semantics

### Implicit match

Implicit match is the current behavior:

```text
User prompt -> match triggers -> inject active skills -> model responds
```

The user may not know which skills were active unless UI/session events expose them.

### Explicit invocation

Explicit invocation should mean:

```text
User chooses skill id -> runtime includes that skill regardless of trigger score -> event logs invocation -> model receives explicit instruction
```

Explicit invocation should not mean:

- execute arbitrary code from the skill
- bypass policy
- auto-run tools
- auto-save artifacts

### Conflict behavior

If a user explicitly invokes a disabled or invalid skill:

- return a clear error
- show validation diagnostics
- do not silently fall back to trigger matching

If an explicit skill conflicts with matched skills:

- explicit skill should take precedence in ordering
- matched skills may still be included if within token budget
- session event should record both explicit and matched skill ids

## Session events and observability

Add session events for skill lifecycle.

Recommended events:

```ts
type SkillMatchedEvent = {
  type: 'skill_matched'
  sessionId: string
  skillIds: string[]
  matches: Array<{
    id: string
    name: string
    source: 'builtin' | 'user' | 'project'
    score: number
    priority: number
    triggers: string[]
  }>
}
```

```ts
type SkillInvokedEvent = {
  type: 'skill_invoked'
  sessionId: string
  skillId: string
  source: 'builtin' | 'user' | 'project'
  invocationMode: 'explicit' | 'implicit'
}
```

```ts
type SkillValidationEvent = {
  type: 'skill_validation'
  sessionId: string
  skillId?: string
  success: boolean
  diagnostics: SkillDiagnostic[]
}
```

```ts
type SkillSavedEvent = {
  type: 'skill_saved'
  sessionId: string
  skillId: string
  scope: 'user' | 'project'
  filePath: string
}
```

These events are important for debugging why a session behaved a certain way.

## Permission and policy model

### Skill metadata is advisory

`risk` and `allowedTools` in skill front matter are governance hints. They must not override runtime tool policy.

Example:

```yaml
risk: write
allowedTools:
  - Edit
```

This means the skill may guide the model to use `Edit`, but actual `Edit` execution still goes through normal policy, permission request, soft-deny, and user approval flow.

### Skill save is write-risk

Saving a generated skill writes to disk and should be treated as write-risk.

Save targets:

- project scope: `<cwd>/.babel-o/skills/<id>.md`
- user scope: `~/.babel-o/skills/<id>.md`

Rules:

1. Always preview before save.
2. Always validate before save.
3. Ask confirmation before save.
4. If target exists, show conflict and require explicit overwrite/merge decision.
5. Do not auto-create user-level persistent behavior without clear user intent.

### Skill generation must not include secrets

Generated skills should not include:

- credentials
- tokens
- private API keys
- exact private session contents not needed for reuse
- provider responses containing confidential payloads
- user personal data unless explicitly intended for user-level instruction

A redaction pass should run before preview.

## Automated skill generation design

### Input sources

Skill generation can draw from:

1. Current user request.
2. Current session summary.
3. Relevant session events.
4. Tool outcomes and tests run.
5. User-provided title/description.
6. Existing skill library for duplicate detection.

It should not blindly dump the transcript.

### Draft workflow

```text
User: /skill capture --scope project "permission denial recovery"

1. Gather current session summary and relevant events.
2. Extract reusable workflow pattern.
3. Remove project facts that are already documented elsewhere unless needed as triggers/procedure.
4. Generate normalized front matter.
5. Generate body using standard template.
6. Validate draft.
7. Show preview with diagnostics.
8. Ask user to save, edit, or discard.
9. Save only after confirmation.
```

### Duplicate detection

Before saving, compare against existing skills by:

- exact id
- normalized name
- trigger overlap
- description similarity
- body heading similarity

If a likely duplicate exists, offer:

1. update existing skill
2. save as new skill
3. discard draft

### Draft quality requirements

A generated skill should pass these checks:

1. Has stable `id`.
2. Has clear `description`.
3. Has at least two meaningful triggers unless intentionally explicit-only.
4. Has `When to use` and `Procedure` sections.
5. Includes failure handling.
6. States tool policy expectations.
7. Does not include raw secrets or irrelevant transcript details.
8. Does not claim authority to bypass permissions.
9. Does not prescribe outdated file paths unless those paths are genuinely stable and verified.

## Validator design

### Validation result

```ts
type SkillDiagnosticSeverity = 'error' | 'warning' | 'info'

type SkillDiagnostic = {
  severity: SkillDiagnosticSeverity
  code: string
  message: string
  field?: string
  line?: number
  suggestion?: string
}

type SkillValidationResult = {
  ok: boolean
  diagnostics: SkillDiagnostic[]
  normalized?: NormalizedSkill
}
```

### Recommended validation rules

Errors:

- missing front matter
- missing `id`
- invalid `id` format
- missing `name`
- missing `description` for normalized schema
- empty `triggers` for active implicit skills
- invalid `status`
- invalid `scope`
- invalid `risk`
- malformed front matter
- body is empty

Warnings:

- too many triggers
- trigger too short
- priority outside recommended range
- missing `Tool policy` section
- missing `Failure handling` section
- `allowedTools` references unknown tools
- duplicate id exists in lower-priority source
- project skill shadows user/builtin skill
- body includes absolute local paths
- body appears to include credentials or tokens

Info:

- legacy skill normalized with default fields
- skill is explicit-only
- generated skill requires user review before save

## Formatter design

Formatter should produce stable Markdown:

1. Front matter fields in canonical order.
2. Lists as YAML block arrays, not inline arrays.
3. One blank line after front matter.
4. Standard heading order for generated skills.
5. Preserve body content when formatting existing user-authored skills unless `--normalize-body` is requested.

Canonical field order:

```text
id
name
description
version
status
scope
triggers
priority
risk
allowedTools
createdAt
updatedAt
owner
```

`source` should generally be loader-derived and not written unless needed for built-in packaging metadata.

## Storage layout

Existing directories should remain authoritative:

```text
src/skills/built-in/
~/.babel-o/skills/
<cwd>/.babel-o/skills/
```

Generated project skills:

```text
<cwd>/.babel-o/skills/<id>.md
```

Generated user skills:

```text
~/.babel-o/skills/<id>.md
```

Drafts should not be silently persisted. If draft persistence is needed, use an explicit draft location:

```text
<cwd>/.babel-o/skills/drafts/<id>.md
```

or keep draft content only in session state until saved.

## Runtime prompt integration

### Existing implicit injection

Keep existing behavior but enhance metadata:

```text
Active Developer Skills:
## Skill: Testing (id: testing, source: builtin, mode: implicit)
...
```

### Explicit invocation injection

For `/skill run testing <task>`:

```text
Explicit Developer Skill:
## Skill: Testing (id: testing, source: builtin, mode: explicit)
...

User task:
<task>
```

The system prompt should make explicit skills higher priority than matched skills, while preserving user instruction hierarchy and tool policy.

### Token budget behavior

If skill content exceeds budget:

1. Prefer explicit skills over implicit matches.
2. Include metadata for omitted matched skills.
3. Emit a diagnostic/session event explaining omission.
4. Do not truncate in the middle of critical policy sections if avoidable.

## Interaction with agent loop

The planner/executor/critic loop should treat skill context as task guidance, not as separate agent identity.

Potential integration:

- Planner can see active skills and may reference them in task planning.
- Executor can use skill procedure as implementation guidance.
- Critic can verify whether skill constraints were followed.

Do not make planner/executor/critic pull separate skill-specific sessions by default.

If future sub-agent delegation uses skills, it should be explicit:

```text
Spawn sub-agent with skillIds: ['testing']
```

and should emit clear session events.

## Interaction with memoryos

Generated skills and memoryos serve different purposes.

Use skill when:

- the content is a reusable procedure
- it guides future task execution
- it contains tool policy/failure handling
- it should be invoked by triggers or `/skill run`

Use memoryos when:

- the content is a durable user/project fact
- it is not a procedural workflow
- it should be recalled as background context

Do not duplicate ordinary project facts into skills when they already exist in docs or code. If a generated skill depends on a project-specific non-obvious constraint, reference the constraint briefly and link to the authoritative doc when possible.

## CLI/TUI user experience

### `/skill list`

Example output:

```text
Skills
- testing [builtin] active priority=10 risk=read
  Triggers: test, tests, coverage
  Test planning and coverage workflow.
- babel-o-permission-denial-recovery [project] active priority=80 risk=read
  Triggers: permission denial, soft-deny, tool denied
  Recover denied tool calls as model-visible feedback.
```

### `/skill show <id>`

Example output:

```text
Skill: babel-o-permission-denial-recovery
Source: project
Path: .babel-o/skills/babel-o-permission-denial-recovery.md
Status: active
Risk: read
Allowed tools: Read, Grep, Glob, TaskCreate
Diagnostics: ok

<rendered body>
```

### `/skill validate`

Example output:

```text
Skill validation
✓ builtin/testing
✓ builtin/git
⚠ project/legacy-tool-permissions: missing Failure handling section
✗ user/debug-flow: invalid id "Debug Flow"
```

### `/skill run <id> <prompt>`

Should submit a normal runtime request with explicit skill context and show a status line:

```text
running skill testing on current prompt
```

### `/skill capture`

Should show a preview and require confirmation:

```text
Draft skill generated: babel-o-permission-denial-recovery
Diagnostics: 0 errors, 2 warnings
Save to project scope? [y/N]
```

## Implementation phases

### Phase 0: Baseline preservation

Objective: Ensure existing skill behavior remains stable before refactor.

Tasks:

1. Add regression tests around current `loadAllSkills`, overlay order, trigger matching, and prompt injection.
2. Add tests for malformed skill files being skipped without crashing.
3. Add tests for built-in/user/project overlay diagnostics if introduced.

Exit criteria:

- Existing skill tests still pass.
- Existing prompt injection behavior is unchanged unless intentionally enhanced.

### Phase 1: Schema, normalization, validation

Objective: Create a normalized skill domain without changing user-facing behavior.

Tasks:

1. Add `src/skills/schema.ts`.
2. Add `src/skills/validator.ts`.
3. Add `src/skills/normalizer.ts`.
4. Add `src/skills/formatter.ts`.
5. Extend loader to return source-aware normalized skill records internally.
6. Preserve backward compatibility for existing built-in skills.
7. Add diagnostics for invalid files and overlays.
8. Add tests for validation and normalization.

Exit criteria:

- Legacy skill files still work.
- Normalized skill objects have stable metadata.
- Invalid skills produce diagnostics.
- No automatic file rewrites occur.

### Phase 2: Skill registry and observability

Objective: Replace ad hoc loading with a registry API and emit useful events.

Tasks:

1. Add `SkillRegistry` with `load`, `list`, `get`, `match`, and `diagnose`.
2. Update `contextAssembler.ts` to use registry.
3. Add skill source/match metadata.
4. Add session events for `skill_matched` and possibly `skill_injected`.
5. Include active skill metadata in context analysis if useful.
6. Add tests for registry overlay and diagnostics.

Exit criteria:

- Runtime uses registry for skill matching.
- Session logs can explain which skills were active.
- Context injection remains deterministic.

### Phase 3: `/skill list/show/validate/run`

Objective: Give users explicit skill visibility and invocation.

Tasks:

1. Add Nexus skill endpoints:
   - `GET /v1/skills`
   - `GET /v1/skills/:id`
   - `POST /v1/skills/validate`
   - `POST /v1/skills/invoke` or equivalent request expansion.
2. Add Go TUI `/skill` and `/skills` command family.
3. Implement `/skill list`.
4. Implement `/skill show <id>`.
5. Implement `/skill validate [id]`.
6. Implement `/skill run <id> <prompt>` using explicit prompt envelope.
7. Add `skill_invoked` event.
8. Add Go TUI tests for slash parsing and API calls.
9. Add Nexus route tests.

Exit criteria:

- Users can list, inspect, validate, and explicitly run skills.
- Explicit invocation is observable in session events.
- Invalid/disabled skill invocation fails clearly.

### Phase 4: Draft generation

Objective: Generate normalized skill drafts without writing files.

Tasks:

1. Add `SkillDraft` domain function.
2. Add `POST /v1/skills/draft`.
3. Add `/skill draft <description>`.
4. Draft from user-provided description first.
5. Validate generated draft.
6. Return preview and diagnostics.
7. Add redaction checks for secrets and irrelevant transcript dumping.
8. Add tests using deterministic/fake model output where needed.

Exit criteria:

- BabeL-O can produce a normalized skill draft.
- Drafts are validated.
- No files are written by draft generation.

### Phase 5: Session capture and save

Objective: Convert successful work into reusable skills with review and persistence.

Tasks:

1. Add session summarization input for skill capture.
2. Add `/skill capture <description>`.
3. Extract reusable pattern from session, not raw transcript.
4. Run duplicate detection.
5. Run validation and redaction.
6. Preview draft.
7. Confirm target scope.
8. Save to project/user directory only after explicit approval.
9. Add conflict handling for existing files.
10. Emit `skill_saved` event.
11. Add tests for save path isolation and overwrite behavior.

Exit criteria:

- User can capture a session workflow into a validated skill.
- Saving requires confirmation.
- Existing files are not overwritten silently.
- Tests do not write real user config or uncontrolled user directories.

### Phase 6: Model-visible bounded skill tools

Objective: Allow the model to use skill operations in a governed way.

Tasks:

1. Add `SkillList` tool.
2. Add `SkillShow` tool.
3. Add `SkillValidate` tool.
4. Add `SkillDraft` tool.
5. Add `SkillSave` tool with write risk.
6. Ensure `SkillSave` goes through permission flow.
7. Add tool loop tests for permission denial and recoverable feedback.
8. Expose tools only when appropriate under policy mode.

Exit criteria:

- Model can inspect/draft/validate skills.
- Model cannot save skills without write permission.
- Tool boundaries remain orthogonal and auditable.

## Testing strategy

### Unit tests

Add or extend tests for:

- front matter parsing
- YAML/list parsing
- legacy normalization
- schema validation
- formatter stability
- registry load order
- duplicate id diagnostics
- trigger matching with normalized skills
- disabled/draft skill behavior
- explicit-only skill behavior

### Runtime tests

Add tests for:

- implicit skill match events
- explicit skill invocation context injection
- invalid skill invocation failure
- context budget behavior with explicit and implicit skills
- compaction preserve/restore of active skill metadata

### Nexus API tests

Add tests for:

- list skills
- show skill
- validate skill
- invoke skill
- draft skill
- save skill with fake filesystem path
- save conflict handling

### Go TUI tests

Add tests for:

- `/skill` command parsing
- `/skills` alias
- `/skill list` rendering
- `/skill show <id>` rendering
- `/skill validate` result rendering
- `/skill run <id> <prompt>` request construction
- capture/save confirmation overlay if implemented

### Security and persistence tests

Add tests for:

- user-scope save never writes real `~/.babel-o/skills` in tests
- project-scope save uses test temp cwd
- overwrite requires explicit flag/confirmation
- generated drafts redact obvious token patterns
- skill metadata cannot bypass tool policy

## Migration plan for existing built-in skills

Existing built-in skills can remain in legacy minimal format initially. After validator/formatter is available:

1. Run formatter in check mode.
2. Add `description`, `version`, `status`, `scope`, and `risk` to built-ins.
3. Keep content short to avoid prompt bloat.
4. Add tests asserting built-ins pass strict validation.

Suggested built-in migration order:

1. `testing.md`
2. `debugging.md`
3. `coding.md`
4. `git.md`
5. `optimization.md`

## Open design questions

1. Should explicit `/skill run` start a new session event group or remain a normal prompt with metadata?
2. Should `source` be author-written front matter or always loader-derived?
3. Should generated drafts be kept only in memory, saved under `drafts/`, or attached to session state?
4. Should skill matching move from substring triggers to word-boundary/semantic matching?
5. Should disabled skills be hidden from list by default or shown with status?
6. Should project skills be included in release packaging or remain local-only?
7. Should there be a max body size for skill injection?
8. Should skill capture be available in non-interactive CLI flows?

## Risks and mitigations

### Risk: Skill library pollution

Automatic generation may create too many low-value skills.

Mitigation:

- Generate drafts only.
- Validate strictly.
- Require user confirmation.
- Detect duplicates.
- Prefer project scope for project-specific procedures.

### Risk: Permission confusion

Users may think `allowedTools` grants permissions.

Mitigation:

- Document that metadata is advisory.
- Keep runtime policy authoritative.
- Show permission requests normally.
- Use write risk for `SkillSave`.

### Risk: Prompt bloat

Too many or too-large skills may degrade context quality.

Mitigation:

- Preserve max matched skill count.
- Prefer explicit skill over implicit matches.
- Add size warnings.
- Include metadata for omitted skills.

### Risk: Invisible behavior changes

Implicit skill injection may alter model behavior without clear user visibility.

Mitigation:

- Emit `skill_matched` events.
- Show active skills in context analysis.
- Provide `/skill match <prompt>` or diagnostics if needed.

### Risk: Secrets in generated skills

Session capture could accidentally persist sensitive data.

Mitigation:

- Redaction pass.
- Preview before save.
- No auto-save.
- Warn on token-like strings and absolute private paths.

## Recommended immediate next steps

1. Implement normalized schema and validator.
2. Add a `SkillRegistry` wrapper while preserving current loader behavior.
3. Add skill diagnostics tests.
4. Add `/skill list/show/validate` before `/skill run`.
5. Add explicit invocation and session events.
6. Only then implement `/skill draft/capture/save`.

## Acceptance criteria for the full capability

BabeL-O should be considered to have complete skill execution and automated normalized skill generation when all of the following are true:

1. Existing built-in/user/project skills still load and match.
2. Skills can be listed, inspected, validated, and explicitly invoked.
3. Active and invoked skills are visible in session events or diagnostics.
4. Skill schema supports normalized metadata with backward compatibility.
5. Skill validation reports structured diagnostics.
6. Skill generation creates drafts first and validates them.
7. Skill saving requires explicit confirmation and respects user/project scope.
8. Existing skill files are not overwritten silently.
9. Skill metadata never bypasses tool policy.
10. Tests cover loader, registry, validator, runtime injection, TUI commands, API endpoints, and persistence isolation.
