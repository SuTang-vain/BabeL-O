# Tool Governance Plan

> State: Active Plan
> Track: Tools
> Priority: P2 unless promoted by a real-session regression or explicit user request
> Source of truth: [../TODO.md](../TODO.md), [../active/TODO_runtime.md](../active/TODO_runtime.md), [../DONE.md](../DONE.md), [../WORK_LOG.md](../WORK_LOG.md), `src/tools/`, `src/nexus/agents/`, `src/skills/`
> Governance: Canonical tool governance entry point, cross-linked from [agent-session-skill-governance-index.md](./agent-session-skill-governance-index.md) and [runtime-tool-loop-governance-plan.md](./runtime-tool-loop-governance-plan.md).
> Related: [skill-execution-and-automated-normalized-skill-generation-governance-plan.md](../proposals/skill-execution-and-automated-normalized-skill-generation-governance-plan.md), [task-scope-and-evidence-scope-governance-plan.md](../proposals/task-scope-and-evidence-scope-governance-plan.md), archived source documents in [../archive/](../archive/)

## Purpose

This document is the canonical reference for BabeL-O tool governance. It consolidates the previous tool-governance trilogy:

- [tool-governance-reference-integration.md](../archive/tool-governance-reference-integration.md)
- [tool-granularity-and-evidence-governance-plan.md](../archive/tool-granularity-and-evidence-governance-plan.md)
- [tool-surface-expansion-and-native-mcp-coexistence-plan.md](../archive/tool-surface-expansion-and-native-mcp-coexistence-plan.md)

The goal is to keep one authority for tool naming, evidence semantics, native vs MCP coexistence, skill-tool boundaries, and future tool admission gates.

## Current State

BabeL-O already has a broad model-visible tool surface:

- file and evidence tools: `ListDir`, `Glob`, `Grep`, `Read`
- mutation tools: `Write`, `Edit`
- execution tool: `Bash`
- task tool: `TaskCreate`
- context tools: `ContextSearch`, `ContextSummarize`, `ContextRecent`
- web tool: `WebSearch`
- skill tools: `SkillList`, `SkillShow`, `SkillValidate`, `SkillDraft`, `SkillSave`
- optional AgentScheduler tools when explicitly enabled: `AgentSpawn`, `AgentWait`, `AgentList`, `AgentCancel`

The current gap is not "missing all tools". The gap is governance:

- models can confuse locator evidence with full understanding;
- models can use `Bash` for read-only discovery when dedicated tools are safer;
- future native tools can collide with MCP tools or skill tools;
- tool registry layering can silently override a tool name if not guarded;
- new tools can be planned without a real regression or explicit user request.

## Tool Classes

| Class | Tools | Governance rule |
| --- | --- | --- |
| Directory inventory | `ListDir` | Bounded directory inventory only. It must not become recursive search. |
| File discovery | `Glob` | Path-pattern discovery only. It must not imply content understanding. |
| Content locator | `Grep` | Locator evidence only. It can identify where to read, not replace `Read`. |
| Source understanding | `Read` | Authoritative file content within preview/range/truncation limits. |
| Mutation | `Write`, `Edit`, `SkillSave` | Requires write-risk governance, permission/audit, and repairable failure semantics. |
| Execution | `Bash` | Requires command classification, execute-risk review, and strong fallback to dedicated tools for source inspection. |
| Task lifecycle | `TaskCreate` and future task tools | Must stay lifecycle-oriented and not become a hidden planner channel. |
| Context retrieval | `ContextSearch`, `ContextSummarize`, `ContextRecent` | Must be explicit on-demand context retrieval, not a hidden memory fact source. |
| Skill lifecycle | `SkillList`, `SkillShow`, `SkillValidate`, `SkillDraft`, `SkillSave` | Skill naming and persistence boundaries are owned by the skill governance plan. |
| Agent lifecycle | `AgentSpawn`, `AgentWait`, `AgentList`, `AgentCancel` | Must remain opt-in and profile-gated; write-capable child agents remain disabled. |
| MCP wrapped tools | `mcp:*` | Must retain source identity, risk classification, and native/MCP precedence diagnostics. |

## Evidence Semantics

Tool results must preserve what kind of evidence they provide:

- `ListDir` proves directory inventory under explicit bounds.
- `Glob` proves matching paths under explicit pattern semantics.
- `Grep` proves matching lines or absence under its search scope; it does not prove the surrounding code behavior.
- `Read` proves visible file bytes/lines only; preview/truncated/ranged reads must not be treated as full-file evidence.
- `Bash` output is execution output. If it is being used as source discovery, the runtime or prompt should prefer `ListDir`, `Glob`, `Grep`, or `Read`.
- Context and memory tools provide background hints unless the referenced workspace/session evidence is revalidated.

## Native vs MCP Coexistence

Native tools and MCP tools can coexist, but they need explicit layering:

1. native built-ins keep stable names;
2. MCP tools keep source-qualified identity;
3. skill tools keep the `Skill*` naming family;
4. agent lifecycle tools keep the `Agent*` naming family;
5. any cross-source name collision must emit diagnostics instead of silently overriding a tool.

The open governance gap is registry layering: a plain `tools.set(name, tool)` style override can hide an existing tool. The fix should introduce collision diagnostics such as `tool_overridden_by` and risk-promotion notes when a tool with the same provider-visible name changes source or risk.

## Admission Rules For New Tools

New native tools should pass at least one gate:

- a real session regression needs the capability;
- the user explicitly asks for the capability;
- a referenced architecture plan identifies a narrow, testable missing primitive;
- the tool reduces risk by replacing unsafe broad behavior, such as read-only Bash discovery.

Without one of those gates, keep the item as `Draft` or `Watch`.

## Current Expansion Candidates

| Candidate | State | Gate |
| --- | --- | --- |
| Task get/list/update/stop/output | Plan-only | Needs real workflow recovery or task lifecycle regression. |
| AskUserQuestion | Plan-only | Needs a concrete HITL drift where normal assistant text is insufficient. |
| MCP resource/prompt/root exposure | Plan-only | Needs integration demand and runtime-owned scope handling. |
| EnterPlanMode / ExitPlanMode | Plan-only | Needs planner UX or task-scope regression; must not become a hidden instruction override. |
| WorktreeCreate / WorktreeRemove | Plan-only | Needs isolated implementation workflow and parent review/merge governance. |
| ConfigGet / ConfigSet | Plan-only | Needs explicit config-management UX; must not silently switch providers/models. |
| Sleep / ScheduleCron* | Plan-only | Needs automation semantics, cancellation, and user-visible scheduling governance. |
| WebSearchProvider abstraction | Plan-only | Current `WebSearch` exists; provider abstraction needs real backend diversity or reliability pressure. |

## Failure Semantics

Tool failures should be recoverable whenever possible:

- do not terminate a session for ordinary tool execution failures;
- return provider-visible structured failure results with `success=false`, `errorCode`, and concise repair guidance;
- keep workspace escape, invalid input, missing file, ambiguous edit, no results, and non-zero Bash as model-correctable states;
- reserve terminal runtime errors for infrastructure, provider, cancellation, or hard safety failures.

## Verification

A tool governance change is not closed until it has:

- focused unit tests for registry/risk/name behavior;
- runtime regression tests when provider-visible behavior changes;
- TUI/rendering coverage when permission or event semantics change;
- documentation updates in [../TODO.md](../TODO.md), [../active/TODO_runtime.md](../active/TODO_runtime.md), [../DONE.md](../DONE.md), or [../WORK_LOG.md](../WORK_LOG.md) as appropriate.

## Archived Source Documents

The following documents are superseded by this plan and now live in `archive/` for historical detail:

- [tool-governance-reference-integration.md](../archive/tool-governance-reference-integration.md)
- [tool-granularity-and-evidence-governance-plan.md](../archive/tool-granularity-and-evidence-governance-plan.md)
- [tool-surface-expansion-and-native-mcp-coexistence-plan.md](../archive/tool-surface-expansion-and-native-mcp-coexistence-plan.md)

## 中文概述

### 背景

工具治理原本分散在三份文档里：一份做读者地图，一份讲既有工具边界，一份讲新工具和 MCP 共存。它们互相引用太多，容易让工具命名、Skill 边界和 native/MCP 优先级出现口径漂移。

### 核心做法

本文件把三条线收敛成一个权威入口：先定义现有工具类别和证据语义，再定义 native / MCP / Skill / Agent 工具的共存规则，最后给出新工具准入门槛和失败语义。

### 当前状态

这是新的 Active Plan。旧三份工具治理文档已经迁入 archive，历史细节仍可追溯，但当前口径以本文为准。

### 下一步

优先实现 registry layering 诊断，避免同名工具被静默覆盖；其余新工具继续遵守真实 regression 或用户明确请求的准入规则。
