# Strategy Authorization and Consent Governance Plan

> State: Partially Landed
> Priority: P0
> Created: 2026-07-06
> Owner: Nexus Runtime / Intent Governance
> Evidence Sessions:
> - `session_354525cf-8775-4daa-a7ec-5c0ccb302239`
> - `session_dc2c15a4-51cd-4d7b-b27e-2304e6929ed5`
> Related:
> - `docs/nexus/reference/intent-guidance-and-prompt-governance-optimization-plan.md`
> - `docs/nexus/reference/tool-governance-reference-integration.md`
> - `docs/nexus/reference/go-tui-permission-policy-governance-plan.md`
> - `docs/nexus/proposals/provider-unavailable-auto-retry-governance-plan.md`

## 1. Problem Statement

Recent real sessions exposed a strategy-layer failure mode: Nexus can correctly
detect that a turn may need tools, but it does not separately model whether the
user has authorized execution. The current intake and policy pipeline compresses
several distinct states into `requiresTools`:

- the answer may need workspace evidence,
- the user is selecting an option,
- the user is asking a meta-behavior question,
- the user has authorized local edits,
- the user has authorized shared remote side effects,
- the user has authorized destructive operations.

This compression causes two opposite behaviors in the same workflow:

1. Over-execution: a preference-like reply such as `light-soft吧` can be treated
   as tool-capable continuation and lead to direct repo edits.
2. Over-hesitation: after the user corrects the agent, later branch, commit, and
   push operations are repeatedly re-confirmed even when the user has already
   authorized a bounded workflow.

The required fix is not only prompt wording. The runtime needs a first-class
authorization and consent model that is computed at intake time, visible to the
provider, enforced before tool execution, and audited in session evidence.

## 2. Evidence From Sessions

### 2.1 Theme Workflow Over-Execution

Session: `session_354525cf-8775-4daa-a7ec-5c0ccb302239`

| User turn | Observed intake shape | Runtime behavior | Defect |
| --- | --- | --- | --- |
| `everforest` | `continue`, `prioritize_latest`, `requiresTools=true` | The turn became tool-capable. | A theme name can be a preference selection, not execution consent. |
| `light-soft吧` | `continue`, `normal`, `requiresTools=true` | Edit tools ran on project files. | Preference selection was upgraded into local modification. |
| `你等一下你怎么直接修改这个项目的主题了` | Correction after unwanted edits | Agent switched into high caution. | Caution was reactive, not governed by a stable authorization model. |
| `？为什么你会这么犹豫` | Classified as `continue`, `normal`, `requiresTools=true` | Agent continued the operational workflow instead of explaining behavior. | Meta-behavior question was not forced to respond-only. |

The key source-level cause is that `normalizeGuidancePolicy()` currently upgrades
`continue + normal` into `requiresTools=true`. After the direction-2 change,
`shouldSuppressToolsForIntent()` only suppresses Tier-1 terminal intents, so a
misclassified preference or meta question can pass into the provider loop with
tool access.

### 2.2 Clone Workflow Status Ambiguity

Session: `session_dc2c15a4-51cd-4d7b-b27e-2304e6929ed5`

The user asked short status questions such as `什么情况` and `？`. These were
classified more safely as status/respond-only turns. However, after a long
`git clone`, the runtime surfaced a `REQUEST_TIMEOUT` while the response
described the result as denied or interrupted.

This is a related but narrower settlement problem: timeout, permission denial,
user cancellation, provider failure, and successful partial execution must remain
distinct in finalization language and recovery hints.

## 3. Source Diagnosis

The relevant current surfaces are:

- `src/runtime/intentGuidance.ts`
  - `buildUserIntakeGuidanceEvent()` builds provider-visible guidance.
  - `deriveTurnPolicy()` derives response/tool/evidence/staleness policy from
    `requiresTools`.
  - `normalizeGuidancePolicy()` upgrades `continue + normal` to
    `requiresTools=true`.
  - `shouldSuppressToolsForIntent()` only blocks terminal respond-only intents.
- `src/runtime/pipeline/providerTurn.ts`
  - final-response-only and must-respond guards are late loop backstops.
  - option-confirmation handling only catches narrow option-choice forms.
  - intent suppression no longer blocks non-terminal continuation turns.
- `src/runtime/runtimeToolLoop.ts`
  - permission checks reason about tool risk and session rules.
  - the loop does not receive a turn-level authorization contract.
- `src/runtime/classifier.ts`
  - static tool risk handles read/write/execute/task risk.
  - it does not know whether a write was authorized by this turn or a stated
    plan.
- `src/runtime/toolExecutor.ts`
  - timeout classification returns `REQUEST_TIMEOUT`, but final response
    settlement can still merge timeout with denial or interruption.

The missing abstraction is a policy layer between intent classification and
tool-risk permission. Tool risk answers "how dangerous is this tool input?"
Authorization answers "did the user consent to this class of action now?"

## 4. Goals

- Separate tool need from execution authorization.
- Treat option and preference selection as first-class intake outcomes.
- Force meta-behavior questions and short status questions to respond-only
  unless they also include explicit action language.
- Allow bounded workflows to proceed without repetitive hesitation once the
  user has authorized a stated plan.
- Require explicit confirmation for shared remote side effects and destructive
  operations even inside a broader workflow.
- Preserve the existing runtime ownership boundary: Nexus runtime owns policy;
  CLI and TUI render events and permission requests.
- Produce auditable session evidence for authorization decisions.

## 5. Non-Goals

- Do not weaken existing tool-risk permissions.
- Do not let the CLI or Go TUI re-derive authorization independently.
- Do not introduce new broad tool names or bypass the tool-governance reference.
- Do not make long-term memory a source of authorization.
- Do not auto-approve destructive operations based on prior conversation.

## 6. Proposed Policy Model

Extend `UserIntentGuidance` with an explicit authorization contract:

```ts
export type AuthorizationLevel =
  | 'none'
  | 'inspect'
  | 'local_change'
  | 'shared_change'
  | 'destructive';

export type ConsentScope =
  | 'current_step'
  | 'stated_plan'
  | 'session_workflow';

export type ConsentSource =
  | 'explicit_user'
  | 'stated_plan_confirmation'
  | 'trusted_session_rule'
  | 'inferred_none';

export type SelectionKind =
  | 'none'
  | 'preference'
  | 'option'
  | 'path'
  | 'workflow_step';
```

Add these fields to the guidance payload:

```ts
authorization: {
  level: AuthorizationLevel;
  consentScope: ConsentScope;
  source: ConsentSource;
  selectionKind?: SelectionKind;
  rationale: string;
  allowedActionSummary: string;
  blockedActionSummary: string;
}
```

### 6.1 Authorization Levels

| Level | Meaning | Examples | Tool effect |
| --- | --- | --- | --- |
| `none` | No execution consent. | Meta question, preference selection, casual status. | No write/execute. Read tools only if final answer genuinely needs inspection and intent is not respond-only. |
| `inspect` | User authorized evidence gathering only. | `查看`, `分析`, `验证`, `看看哪里有问题`. | Read-only tools allowed. Write/Edit/execute blocked or clarified. |
| `local_change` | User authorized local reversible project work. | `根据规划开始推进`, `按这个方案改`, `提交当前更改`. | Edit/Write and local git operations allowed when aligned with plan. |
| `shared_change` | User authorized remote/shared side effects. | `推送到远端`, `合并到 main`, `发布 release`. | Push, PR, release, remote branch operations allowed if explicit. |
| `destructive` | User explicitly authorized destructive operations. | `删除这个目录`, `覆盖现有 clone`, `强制删除分支`. | Requires explicit current-step confirmation every time. |

### 6.2 Consent Scope

| Scope | Meaning | Example |
| --- | --- | --- |
| `current_step` | Consent applies only to the immediate action. | `先运行测试`. |
| `stated_plan` | Consent applies to steps already shown in an accepted plan. | `根据你的建议开始推进`. |
| `session_workflow` | Consent applies to a named workflow until completion, excluding shared or destructive escalations. | `都要保留，先统一合并到 develop 并做验证`. |

### 6.3 Selection Kinds

Option and preference selection must not imply execution on their own.

Examples:

- `everforest`
- `light-soft吧`
- `选第二个`
- `就这个`
- `用 A`

These should be classified as `selectionKind='preference' | 'option'` and
`authorization.level='none'` unless nearby language explicitly authorizes action:

- `用这个直接改`
- `就按 light-soft 实现`
- `选择第二个并提交`
- `按这个方案推进`

## 7. Policy Matrix

| User input shape | Intent | Authorization | Default tool policy |
| --- | --- | --- | --- |
| `为什么你会这么犹豫` | Meta-behavior question | `none` | Respond only. |
| `你怎么直接修改了` | Correction / governance question | `none` | Respond only; summarize cause and proposed guard. |
| `什么情况` after running command | Status check | `none` or `inspect` | Respond from known session events; no new tools unless needed to inspect current state. |
| `查看分支情况` | Inspection | `inspect` | Read-only git/status commands allowed. |
| `根据文档规划开始推进` | Execute accepted plan | `local_change`, `stated_plan` | Local edits and validation allowed if within plan. |
| `创建分支并提交` | Local git workflow | `local_change`, `current_step` | Branch and commit allowed. |
| `推送到远端` | Shared side effect | `shared_change`, `current_step` | Push allowed for current branch only. |
| `合并到 main 并发布 release` | Shared release workflow | `shared_change`, `stated_plan` | Merge/release allowed after state verification. |
| `删掉旧目录重新 clone` | Destructive local operation | `destructive`, `current_step` | Must confirm exact target. |

## 8. Runtime Enforcement Design

### 8.1 Intake Classification

Update the intake classifier schema and prompt to produce:

- `authorization.level`
- `authorization.consentScope`
- `authorization.source`
- `authorization.selectionKind`
- a short rationale

Deterministic post-classifier guards should override weak model outputs:

- If the turn is a meta-behavior question, force `respond_only` and
  `authorization.level='none'`.
- If the turn is a short option/preference selection without action verbs, force
  `selectionKind` and `authorization.level='none'`.
- If the turn contains remote verbs such as push, publish, release, merge to
  main, or close PR, require `shared_change`.
- If the turn contains destructive verbs or dangerous overwrite/delete patterns,
  require `destructive` and `current_step`.

### 8.2 Provider-Visible Guidance

`buildUserIntakeGuidanceEvent()` should include the authorization block in the
message mapped by `mapEventsToMessages()`. The provider should see both:

- what kind of answer is expected,
- what kinds of tools are authorized.

Example provider-visible text:

```text
Turn authorization:
- level: none
- selection: preference
- allowed: answer the user's selection/status question
- blocked: editing files, running mutating git commands, pushing remote changes
```

### 8.3 Pre-Tool Authorization Gate

Add a deterministic gate before dispatching provider tool calls:

```ts
type ToolAuthorizationDecision =
  | { action: 'allow' }
  | { action: 'deny_recoverable'; reason: string }
  | { action: 'clarify'; question: string }
  | { action: 'require_permission'; reason: string };
```

The gate should combine:

- current `authorization.level`,
- tool risk from `classifyAction()`,
- Bash input risk from `bashClassifier.ts`,
- task-scope boundary classification,
- session policy rules,
- explicit shared/destructive operation detection.

This gate should run before the current normal write/execute permission gate, so
authorization mismatch is surfaced as a strategy failure, not merely as generic
tool risk.

### 8.4 Tool-Loop Behavior

Expected behavior by level:

- `none`: reject Edit/Write and mutating Bash as recoverable denied tool result;
  ask or answer instead of executing.
- `inspect`: allow read-only tools; reject writes and mutating commands.
- `local_change`: allow Edit/Write and local git operations when aligned with the
  accepted plan; require permission for ambiguous mutations.
- `shared_change`: allow explicit remote/shared actions after current state
  verification.
- `destructive`: always require exact-target confirmation, even when the tool is
  otherwise policy-allowed.

### 8.5 Permission Request Enrichment

When a tool is blocked because authorization is insufficient, enrich
`permission_request` or the recoverable denial with:

- `authorizationLevel`
- `requiredAuthorizationLevel`
- `consentScope`
- `authorizationReason`
- `suggestedUserWording`

The Go TUI should render these fields but must not derive them.

## 9. Timeout And Outcome Settlement

Final responses must preserve outcome categories:

| Runtime outcome | User-facing language |
| --- | --- |
| `REQUEST_TIMEOUT` | The command timed out after the configured limit. State whether partial output exists and whether retry/resume is reasonable. |
| permission denial | The action was not approved or was blocked by policy. |
| user cancellation | The user interrupted the current run. |
| provider error | The model/provider call failed. Use retry policy if configured. |
| tool error | The command ran and failed with its own error. |

For `git clone`-like long commands, do not describe a timeout as denied or
interrupted. Recommended recovery actions are:

- inspect whether the target directory exists,
- inspect partial clone state,
- retry with a longer timeout only if safe,
- ask before deleting or overwriting the partial directory.

## 10. Implementation Phases

### Phase 0 - Document And Fixtures

Status: Landed 2026-07-06.

- Admit this proposal to `docs/nexus/proposals/`.
- Add replay notes for the two evidence sessions.
- Define expected classifications for key user turns:
  - `everforest`
  - `light-soft吧`
  - `？为什么你会这么犹豫`
  - `什么情况`
  - `根据你的建议开始推进`
  - `推送到远端`

Exit criteria:

- Proposal indexed.
- Regression fixture list approved.

### Phase 1 - Intake Schema And Deterministic Guards

Status: Partially landed 2026-07-06. The intake schema, provider-visible
authorization block, deterministic preference/meta/current-state/shared/local
guards, and `light-soft吧` no-execution regression are landed.

- Extend `UserIntentGuidance` types.
- Update normalization to stop converting every `continue + normal` into
  `requiresTools=true`.
- Add deterministic guards for:
  - meta-behavior questions,
  - short status questions,
  - option/preference selection,
  - remote/shared verbs,
  - destructive verbs.

Exit criteria:

- Unit tests prove preference and meta turns are respond-only or no-execution.

### Phase 2 - Provider-Visible Authorization

Status: Partially landed 2026-07-06. The authorization block is included in
`user_intake_guidance` and provider-visible guidance. Dedicated session inspect
rendering remains Phase 4.

- Add authorization block to provider-visible guidance.
- Add diagnostics in runtime events.
- Keep enforcement in warn-only mode initially.

Exit criteria:

- Session traces show authorization decisions before provider tool calls.

### Phase 3 - Enforcement In Tool Loop

Status: Partially landed 2026-07-06. A runtime pre-tool authorization gate now
receives `UserIntentGuidance` in the tool dispatch path and blocks mismatched
`Write` / `Edit` / shared Bash / destructive Bash calls before execution.
Authorization mismatch denials emit structured authorization fields on
`tool_denied`; destructive authorization confirmations enrich
`permission_request`.

- Add pre-tool authorization gate.
- Return recoverable denied tool results for unauthorized writes.
- Route destructive operations to exact-target confirmation.
- Preserve existing permission and task-scope gates.

Exit criteria:

- Unauthorized Edit/Write/Bash calls are blocked before execution.
- Existing allowed local workflows still proceed after explicit authorization.

### Phase 4 - TUI And CLI Visibility

Status: Partially landed 2026-07-06. Go TUI permission request projection and
the single-pane permission dialog now render runtime-provided authorization
mismatch fields. `bbl inspect-session` now summarizes authorization intake,
authorization mismatch denials, and authorization-enriched permission requests;
`--trace` also preserves those fields. CLI one-shot final-output wording now
surfaces `AUTHORIZATION_MISMATCH` outcomes and renders current authorization,
required authorization, consent scope, runtime reason, and suggested user
wording for authorization-enriched permission prompts.

- Render authorization mismatch in permission dialogs.
- Add inspect/session diagnostics for authorization decisions.
- Ensure CLI one-shot output can explain why a tool was not run.

Exit criteria:

- Users can distinguish "not authorized by this turn" from "tool risk needs
  permission".

### Phase 5 - Replay And Behavior Evaluation

- Add replay-style tests for the two evidence sessions.
- Add expected final-response language for timeout vs denied vs cancelled.
- Run full lint, tests, and build smoke before promotion from Draft.

Exit criteria:

- The theme workflow no longer edits on bare preference selection.
- Meta-behavior questions receive explanatory answers.
- Authorized workflows no longer over-confirm local bounded steps.
- Shared and destructive operations remain explicitly gated.

## 11. Regression Test Plan

Recommended test targets:

- `test/intent-guidance.test.ts`
  - classification and normalization for preference, option, meta, status, local
    execution, shared execution, destructive turns.
- `test/runtime-llm.test.ts`
  - mock provider attempts Edit after `light-soft吧`; runtime blocks it.
  - mock provider attempts Bash push without `shared_change`; runtime blocks it.
- `test/runtime.test.ts`
  - authorization events appear before provider tool calls.
  - current-step and stated-plan consent scopes are preserved.
- `test/tool-permission-policy.test.ts`
  - authorization mismatch is distinct from normal permission denial.
- `test/tool-executor.test.ts`
  - timeout finalization remains `REQUEST_TIMEOUT`.
- Go TUI tests
  - permission dialog renders authorization mismatch fields when present.

## 12. Acceptance Criteria

- `requiresTools` is no longer used as a proxy for execution consent.
- Preference-only turns cannot trigger Edit/Write or mutating Bash.
- Meta-behavior questions are respond-only by default.
- Read-only inspection remains ergonomic.
- Local plan execution remains smooth after explicit plan authorization.
- Push, release, PR close, and merge-to-main require `shared_change`.
- Destructive operations require exact current-step confirmation.
- Timeout, denial, cancellation, provider error, and tool error are never merged
  in user-facing finalization.
- Authorization decisions are visible in session evidence and diagnostics.

## 13. Risks And Mitigations

| Risk | Mitigation |
| --- | --- |
| Too much friction for normal coding tasks. | Use `stated_plan` and `session_workflow` scopes for bounded local work. |
| Model ignores provider-visible guidance. | Enforce deterministic pre-tool gate in runtime. |
| Existing tests expect `continue + normal` to imply tools. | Migrate tests to assert explicit authorization instead. |
| Shared operation detection misses provider-specific commands. | Start with common git/npm/release verbs and expand through regressions. |
| Destructive detection becomes over-broad. | Require exact-target confirmation rather than hard denial. |

## 14. Promotion Path

This proposal is `Partially Landed` because Phase 0 and the intake/visibility
parts of Phase 1 have shipped. It should move to `Active Plan` under
`docs/nexus/reference/` only after Phase 3 enforcement ships and replay tests
cover the two evidence sessions.

## 15. Chinese Summary

当前问题不是单纯的提示词问题，而是策略层缺少“用户是否授权执行”的独立模型。
`requiresTools` 只能表示“可能需要工具”，不能表示“用户同意修改、提交、推送或删除”。

本方案建议新增 `authorization.level` 和 `consentScope`，把“查看”“选择偏好”
“本地修改”“远端共享变更”“破坏性操作”拆开治理。这样可以避免 `light-soft吧`
这类偏好选择直接触发 Edit，也可以避免用户已经授权的本地计划在每一步都反复犹豫。
同时，推送、发布、合并主分支和删除覆盖等高影响动作仍必须显式确认。
