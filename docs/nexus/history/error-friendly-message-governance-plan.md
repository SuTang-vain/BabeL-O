# Error Friendly Message Governance Plan

> State: Draft
> Governance: This document defines the execution plan for humanizing error messages across Nexus, runtime, and Go TUI layers.

## Problem Statement

BabeL-O currently exposes raw JSON error responses to users. When an error occurs, users see:

\`\`\`json
{
  "type": "error",
  "code": "REQUEST_TIMEOUT",
  "message": "turn exceeded 180000ms execute timeout"
}
\`\`\`

This is machine-centric, not user-centric. The Go TUI has implemented \`friendlyNexusErrorWithContext()\` (Phase 4 variant) for limited error codes, but:

1. **Nexus server-side returns raw errors** — The error events emitted by runtime do not include \`hint\` or \`docsUrl\` fields.
2. **Double-source drift risk** — Go TUI maintains its own error message mapping; future changes to error semantics require synchronizing both client and server.
3. **No troubleshooting documentation** — Users cannot find detailed guidance when encountering errors.
4. **Limited error code coverage** — Only a handful of error codes have friendly messages in Go TUI.

## Goal

Transform error responses from machine-centric to user-centric:

\`\`\`
Before: { code: "REQUEST_TIMEOUT", message: "turn exceeded 180000ms execute timeout" }
After:  { code: "REQUEST_TIMEOUT", message: "...", hint: "The task took too long. Ask the model to summarize, narrow scope, or split the task.", docsUrl: "https://babel-o.dev/troubleshooting/REQUEST_TIMEOUT" }
\`\`\`

**Principles**:

1. **Nexus owns error definition** — Server provides canonical \`hint\` and \`docsUrl\`.
2. **Client consumes server hints** — Go TUI prefers server-provided hints; only handles client-specific context (e.g., soft-timeout snapshot).
3. **No breaking changes** — New fields are optional; existing error events remain compatible.
4. **Documentation-first** — Every error code must have a corresponding troubleshooting document.

## Scope

### In Scope

- Extend \`ErrorEventSchema\` with \`hint\` and \`docsUrl\` fields.
- Create \`src/nexus/errorRegistry.ts\` for centralized error code management.
- Integrate \`humanizeError()\` into Nexus runtime error event generation.
- Refactor Go TUI \`friendlyNexusErrorWithContext()\` to consume server hints.
- Create \`docs/troubleshooting/\` directory with error-specific guides.

### Out of Scope

- OAuth flow or authentication UX improvements (separate W5+ item).
- Web UI error handling (Web UI is not in current roadmap).
- Non-English error messages (i18n is a future item).
- Automatic error recovery (handled by separate recovery governance plans).

## Architecture

### Current Flow

\`\`\`
Runtime Error → ErrorEvent { code, message, details } → Nexus WebSocket/HTTP → Go TUI
                                                                          ↓
                                                            friendlyNexusErrorWithContext() → User sees hint
\`\`\`

### Target Flow

\`\`\`
Runtime Error → humanizeError(code, message, details)
                      ↓
              ErrorEvent { code, message, details, hint, docsUrl }
                      ↓
               Nexus WebSocket/HTTP
                      ↓
          Go TUI consumes hint (or client-specific override)
                      ↓
               User sees friendly message
\`\`\`

### Error Code Registry Structure

\`\`\`typescript
// src/nexus/errorRegistry.ts
export type ErrorDefinition = {
  code: string
  hint: string
  docsUrl?: string
  requiresContext?: boolean  // Whether to extract context from details
}

export const ERROR_REGISTRY: Record<string, ErrorDefinition> = {
  REQUEST_TIMEOUT: {
    code: 'REQUEST_TIMEOUT',
    hint: 'The task took too long. Ask the model to summarize, narrow scope, or split the task.',
    docsUrl: 'https://babel-o.dev/troubleshooting/REQUEST_TIMEOUT',
  },
  // ... more error codes
}
\`\`\`

## Execution Phases

### Phase 1: Extend ErrorEvent Schema

**Duration**: 0.5 day

**Objective**: Add \`hint\` and \`docsUrl\` optional fields to \`ErrorEventSchema\`.

**Changes**:

| File | Change |
|------|--------|
| \`src/shared/events.ts\` | Add \`hint: z.string().optional()\` and \`docsUrl: z.string().optional()\` to \`ErrorEventSchema\` |

**Schema Change**:

\`\`\`typescript
export const ErrorEventSchema = z.object({
  type: z.literal('error'),
  ...baseEventFields,
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
  hint: z.string().optional(),        // NEW
  docsUrl: z.string().optional(),     // NEW
})
\`\`\`

**Verification**:

- \`npm run typecheck\` passes.
- Existing error events remain compatible (new fields are optional).
- No changes to error event consumers required in this phase.

**Deliverable**: Schema extension PR with type check verification.

---

### Phase 2: Create Error Registry

**Duration**: 1 day

**Objective**: Establish centralized error code management with hint/docsUrl mapping.

**New File**: \`src/nexus/errorRegistry.ts\`

**Initial Error Codes** (based on \`TODO_product_30day.md\` requirements):

| Error Code | Hint | Docs URL |
|------------|------|----------|
| \`REQUEST_TIMEOUT\` | The task took too long. Ask the model to summarize, narrow scope, or split the task. | \`/troubleshooting/REQUEST_TIMEOUT\` |
| \`CONTEXT_BLOCKING\` | Context is too large. The runtime will compact automatically, or run \`/compact\` manually. | \`/troubleshooting/CONTEXT_BLOCKING\` |
| \`PROVIDER_AUTH_FAILED\` | API key is invalid or expired. Run \`bbl config audit\` to check your credentials. | \`/troubleshooting/PROVIDER_AUTH_FAILED\` |
| \`WORKTREE_CONFLICT\` | Worktree merge conflict detected. Use \`bbl sessions worktree-recovery\` to resolve. | \`/troubleshooting/WORKTREE_CONFLICT\` |
| \`TOOL_RESULT_BUDGET_EXCEEDED\` | Tool output too large. The runtime will truncate automatically, or use more specific paths. | \`/troubleshooting/TOOL_RESULT_BUDGET_EXCEEDED\` |

**Additional Error Codes** (from Go TUI \`friendlyNexusErrorWithContext\`):

| Error Code | Hint |
|------------|------|
| \`tombstoned_profile\` | Profile is tombstoned; restore via \`bbl config profile restore <name>\`. |
| \`unknown_profile\` | Unknown profile name. |
| \`not_supported\` | Model/role switching is not supported via HTTP; use \`bbl config use <modelId>\` CLI. |
| \`missing_profile\` | Missing profile name in request body. |
| \`missing_provider_api_key\` | Provider needs an API key; run \`/model\` to configure or use \`bbl config add <provider> <KEY>\`. |
| \`unknown_provider\` | Unknown provider name. |

**API**:

\`\`\`typescript
export function humanizeError(
  code: string,
  message: string,
  details?: unknown
): { code: string; message: string; hint?: string; docsUrl?: string }
\`\`\`

**Verification**:

- Unit tests for \`humanizeError()\` covering all registered error codes.
- Test context injection for \`requiresContext\` error codes.
- Test fallback behavior for unregistered error codes.

**Deliverable**: \`src/nexus/errorRegistry.ts\` + \`test/error-registry.test.ts\`.

---

### Phase 3: Integrate into Nexus Runtime

**Duration**: 1 day

**Objective**: Apply \`humanizeError()\` to all error event generation points.

**Integration Points**:

| File | Location | Change |
|------|----------|--------|
| \`src/nexus/sessionLifecycle.ts\` | Line 171 \`errorEvent\` | Wrap with \`humanizeError()\` |
| \`src/nexus/runtimeAgentStep.ts\` | Line 154 \`errorEvent\` | Wrap with \`humanizeError()\` |
| \`src/nexus/executionFinalization.ts\` | Line 38-39 \`errorEvent\` lookup | Ensure hint/docsUrl preserved |
| \`src/runtime/LLMCodingRuntime.ts\` | Error event yields | Wrap with \`humanizeError()\` |
| \`src/runtime/LocalCodingRuntime.ts\` | Error event yields | Wrap with \`humanizeError()\` |

**Example Integration**:

\`\`\`typescript
// Before
yield {
  type: 'error',
  code,
  message,
  details,
}

// After
import { humanizeError } from './errorRegistry.js'

yield {
  type: 'error',
  ...humanizeError(code, message, details),
}
\`\`\`

**Verification**:

- Integration test: trigger error in runtime, verify \`hint\` and \`docsUrl\` in event.
- Smoke test: \`bbl run\` with error scenario, verify friendly message in output.
- Go TUI test: verify error event with \`hint\` is rendered correctly.

**Deliverable**: Runtime integration PR with focused regression tests.

---

### Phase 4: Refactor Go TUI

**Duration**: 1 day

**Objective**: Make Go TUI consume server-provided hints instead of maintaining its own mapping.

**Changes**:

| File | Change |
|------|--------|
| \`clients/go-tui/internal/tui/api.go\` | Refactor \`friendlyNexusErrorWithContext()\` to prefer server \`hint\` |

**Refactored Logic**:

\`\`\`go
func friendlyNexusErrorWithContext(code string, payload map[string]any, soft *softTimeoutSnapshot) (string, bool) {
    // Priority 1: Use server-provided hint
    if hint, ok := payload["hint"].(string); ok && hint != "" {
        return hint, true
    }
    
    // Priority 2: Handle client-specific context (soft-timeout)
    // This logic MUST remain in client because it depends on local softTimeoutSnapshot
    if code == "REQUEST_TIMEOUT" {
        // Keep existing soft-timeout watchdog logic
        // (requires client-side softTimeoutSnapshot state)
        // ...
    }
    
    // Priority 3: Fallback to raw message
    return "", false
}
\`\`\`

**Client-Specific Logic to Retain**:

- \`REQUEST_TIMEOUT\` with soft-timeout snapshot (client state not available on server)
- Any future client-specific error context

**Verification**:

- Unit tests: verify server hint takes precedence.
- Integration test: verify soft-timeout watchdog message still works.
- Compare before/after output for error scenarios.

**Deliverable**: Go TUI refactor PR with updated tests.

---

### Phase 5: Create Troubleshooting Documentation

**Duration**: 2 days

**Objective**: Establish \`docs/troubleshooting/\` directory with error-specific guides.

**Directory Structure**:

\`\`\`
docs/troubleshooting/
├── README.md                        # Index of all error codes
├── REQUEST_TIMEOUT.md               # Timeout handling
├── CONTEXT_BLOCKING.md              # Context blocking
├── PROVIDER_AUTH_FAILED.md          # Credential issues
├── WORKTREE_CONFLICT.md             # Worktree conflicts
└── TOOL_RESULT_BUDGET_EXCEEDED.md   # Tool output limits
\`\`\`

**Template for Each Error Document**:

\`\`\`markdown
# Error Code: REQUEST_TIMEOUT

## What Happened

The task exceeded the execute timeout limit.

## Why It Happened

- The task is too complex and requires multiple tool calls.
- The context is too large, causing slow LLM responses.
- Network latency between Nexus and provider.

## How to Fix It

1. **Ask the model to summarize and narrow scope**
   - Request a summary of current progress.
   - Ask to focus on a specific subtask.
   
2. **Reduce context size**
   - Run \`/compact\` to trigger manual compaction.
   - Use \`/context\` to inspect current context usage.
   
3. **Split the task**
   - Break into smaller, independent subtasks.
   - Use worktrees for parallel execution.
   
4. **Adjust timeout (advanced)**
   - Run with \`--execute-timeout-ms 300000\` for longer tasks.
   - This is a last resort; prefer other solutions first.

## Related Commands

- \`bbl config get executeTimeoutMs\` — Check current timeout setting.
- \`bbl run --execute-timeout-ms 300000\` — Run with extended timeout.
- \`/compact\` — Trigger manual context compaction.
- \`/context\` — Inspect context usage.

## See Also

- [Context Management Guide](../guides/context-management.md)
- [Task-adaptive Timeout Plan](../nexus/reference/task-adaptive-recoverable-timeout-plan.md)
\`\`\`

**Verification**:

- All 5 error codes have corresponding documents.
- Each document includes: What Happened, Why, How to Fix, Related Commands, See Also.
- Links between documents are valid.

**Deliverable**: \`docs/troubleshooting/\` directory with 5+ documents.

---

## Timeline

| Phase | Task | Duration | Dependencies |
|-------|------|----------|--------------|
| Phase 1 | Extend ErrorEvent Schema | 0.5 day | None |
| Phase 2 | Create Error Registry | 1 day | Phase 1 |
| Phase 3 | Integrate into Nexus Runtime | 1 day | Phase 2 |
| Phase 4 | Refactor Go TUI | 1 day | Phase 3 |
| Phase 5 | Create Troubleshooting Docs | 2 days | Phase 2 |
| **Total** | | **5.5 days** | |

## Verification Checklist

### Schema Verification

- [ ] \`ErrorEventSchema\` includes \`hint\` and \`docsUrl\` optional fields.
- [ ] \`npm run typecheck\` passes.
- [ ] Existing error events remain compatible.

### Registry Verification

- [ ] \`src/nexus/errorRegistry.ts\` exists with \`ERROR_REGISTRY\` map.
- [ ] All target error codes have \`hint\` and \`docsUrl\`.
- [ ] \`humanizeError()\` handles unregistered error codes gracefully.
- [ ] Unit tests cover all registered error codes.

### Integration Verification

- [ ] Nexus runtime yields error events with \`hint\` and \`docsUrl\`.
- [ ] Go TUI consumes server-provided hints.
- [ ] Client-specific logic (soft-timeout) still works.
- [ ] Smoke test with real error scenario passes.

### Documentation Verification

- [ ] \`docs/troubleshooting/\` directory exists.
- [ ] At least 5 error-specific documents exist.
- [ ] Each document follows the template.
- [ ] Cross-links between documents are valid.

### Regression Verification

- [ ] \`npm test\` passes.
- [ ] Go TUI tests pass: \`cd clients/go-tui && go test ./...\`.
- [ ] No breaking changes to error event consumers.

## Risks and Mitigations

| Risk | Trigger | Mitigation |
|------|---------|------------|
| Incomplete error registry | New error codes lack hints | Fallback to raw message; add to registry incrementally. |
| Go TUI soft-timeout complexity | Client state dependency | Retain soft-timeout logic in client; only refactor other error codes. |
| Documentation link 404 | Docs site not yet launched | Use relative paths; migrate to absolute URLs after docs site launch. |
| Double-source drift | Client and server maintain separate hints | Client MUST prefer server hint; only override for client-specific context. |

## Success Criteria

1. **User-facing**: When an error occurs, users see a friendly hint with actionable guidance.
2. **Developer-facing**: Adding a new error code requires only updating \`errorRegistry.ts\`.
3. **Maintainer-facing**: Error semantics changes are centralized in one place.
4. **Documentation**: Every registered error code has a troubleshooting guide.

## Future Work

- **Phase 6**: i18n support for error hints.
- **Phase 7**: Error analytics and frequency tracking.
- **Phase 8**: Automatic error reporting and user feedback collection.

## 中文概述

### 问题

BabeL-O 当前向用户暴露原始 JSON 错误响应，缺乏人话提示和文档链接。Go TUI 已实现部分错误码的 friendly 化，但服务端仍返回原始错误，存在双源漂移风险。

### 目标

1. 在 \`ErrorEventSchema\` 中新增 \`hint\` 和 \`docsUrl\` 字段。
2. 建立中心化错误码注册表 \`errorRegistry.ts\`。
3. Nexus runtime 生成错误事件时自动调用 \`humanizeError()\`。
4. Go TUI 优先消费服务端返回的 \`hint\`。
5. 建立 \`docs/troubleshooting/\` 文档目录。

### 规则

- Nexus owns error definition（服务端拥有错误定义权）。
- Client consumes server hints（客户端优先消费服务端提示）。
- No breaking changes（新增字段为可选，保持兼容性）。
- Documentation-first（每个错误码必须有对应的故障排查文档）。

### 执行阶段

- Phase 1: 扩展 ErrorEvent Schema（0.5 天）
- Phase 2: 创建错误码注册表（1 天）
- Phase 3: 集成到 Nexus Runtime（1 天）
- Phase 4: 重构 Go TUI（1 天）
- Phase 5: 创建故障排查文档（2 天）

### 收口标准

- 用户遇到错误时看到友好提示和可执行建议。
- 新增错误码只需更新 \`errorRegistry.ts\`。
- 每个注册的错误码都有故障排查文档。
