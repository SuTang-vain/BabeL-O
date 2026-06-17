# Agent Runtime Architecture Maturity Plan

> 状态：v1 草案（2026-06-17）
> 范围：把对 BabeL-O 当前架构先进性评估中暴露的补齐项，收敛成可执行的 runtime / observability / eval / durability 路线。
> 相关：[../ARCHITECTURE.md](../ARCHITECTURE.md), [../TODO.md](../TODO.md), [../active/TODO_runtime.md](../active/TODO_runtime.md), [../active/TODO_performance.md](../active/TODO_performance.md)

## 1. 背景

BabeL-O 当前已经具备现代 agent runtime 的核心分层：

- Client owns interaction.
- Nexus owns orchestration and session state.
- Runtime owns model/tool execution, permissions, task scope, and evidence validation.
- Harness wires tools, MCP, agents, memory, storage, and policy.
- Observability exists through Nexus events, runtime metrics, tool traces, behavior traces, and benchmarks.

外部对照（LangGraph / Deep Agents / OpenAI Agents SDK / Anthropic agent engineering / MCP）后的判断是：

```text
架构方向先进；runtime-owned governance 是强项；
trace/eval/durable resume/memory quality/MCP context primitives 是下一阶段缺口。
```

本规划不要求立即大重构。目标是把架构先进性补齐项拆成小的、可验证的演进层。

## 2. 非目标

- 不把 BabeL-O 改写成 LangGraph、OpenAI Agents SDK 或 LangChain 项目。
- 不引入云端 telemetry 默认上传。
- 不把 LangSmith 作为强依赖。
- 不用外部 memory hit 替代 workspace evidence、session events、tool results 或 SQLite。
- 不让 Go TUI / `bbl loop` 拥有 runtime truth。
- 不在没有真实需求或 eval 证明前启用 write-capable child agent。

## 3. 目标架构增量

### 3.1 Agent Trace Schema

新增统一的 agent trace 口径，把一次 run 表达为可复盘的 trajectory：

```text
run
  -> provider invocation span
  -> stream deltas / usage
  -> tool call span
  -> permission decision span
  -> scope boundary span
  -> memory retrieval span
  -> compact / recovery span
  -> sub-agent handoff span
  -> final result
```

v1 要求：

- trace 从现有 `NexusEvent` / `execution_metrics` / `toolTrace` / `permission_audit` 派生，不先新增一套事实源。
- trace schema 可导出 JSONL。
- trace ID / span ID 稳定，可从 session replay 重建。
- 不要求首版 OpenTelemetry 或 LangSmith 兼容，但字段命名预留 exporter。

验收：

- 对同一个 session，`bbl inspect-session` 可输出 machine-readable trace。
- 至少覆盖 provider invocation、tool call、permission、scope boundary、runtime result 五类 span。
- 单元测试覆盖 event -> trace projection 的顺序、parent-child span、缺失事件降级。

### 3.2 Trajectory Eval Harness

新增面向 agent trajectory 的 eval harness，而不是只测函数或最终文本。

v1 fixture 结构：

```text
evals/
  coding/
    task-id/
      prompt.md
      workspace/
      expected.json
      checks.ts
```

v1 check 类型：

- task success：文件是否被正确修改，测试是否通过；
- tool discipline：是否先 search/list/read，再 edit/write；
- permission discipline：write/execute 是否产生审批或 auto-approve reason；
- scope discipline：是否越出 task primary root；
- context discipline：是否触发不必要 broad read 或重复大文件 read；
- memory discipline：是否把 memory hint 当事实源。

验收：

- `npm run eval:agent` 或等价脚本可跑最小 fixture 集。
- 至少 10 个小型 coding trajectory fixture。
- eval 输出包含 success、cost、tool count、permission count、scope warnings、trace path。

### 3.3 Durable Run Checkpoint / Resume

当前 session/event persistence 已存在，但 in-flight continuation 仍偏 process-local。下一阶段要定义可恢复执行语义，而不是只把 pending permission 写 SQLite。

v1 只定义 checkpoint boundary：

- before provider invocation,
- after provider invocation finished,
- before tool execution,
- waiting for permission,
- after tool result persisted,
- before final result.

v1 不要求完全恢复 provider stream 中间 token，但必须能在可恢复边界给出明确状态：

- resume possible,
- retry from provider turn,
- waiting for permission,
- terminal failed with recoverable state,
- cannot resume because continuation snapshot is missing.

验收：

- session metadata 或 task state 能表达 `waiting_permission` / `retryable_tool_result` / `retryable_provider_turn`。
- pending permission 不再被误导性描述为 durable，除非有 tool call snapshot 和 continuation state。
- restart 后 `inspect-session` 能说明 run 停在哪里、是否可恢复、下一步是什么。

### 3.4 MCP Context Primitives

现有 MCP 主要作为 tool wrapping。后续可以按真实需求扩展到 MCP resources / prompts / roots / elicitation，但必须保持 runtime-owned scope。

v1 目标：

- `ListMcpResources` / `ReadMcpResource` 如果落地，必须和 task scope / evidence scope 协议对齐。
- MCP resource 不得绕过 `Read` / evidence grounding / permission flow。
- MCP roots 不得覆盖 Nexus primaryRoot；只能作为 explicitRoots 或 confirmedExternalRoots。

验收：

- MCP resource read 触发和文件 read 同级别的 scope diagnostics。
- Go TUI 只渲染 MCP source，不推导 MCP scope。

### 3.5 Memory Quality Metrics

MemoryOS/EverCore 当前边界正确，但需要质量指标来证明“提示有用且不过度自信”。

v1 指标：

- auto-search triggered / skipped reason 分布；
- hit count / injected chars / truncation rate；
- memory-derived answer revalidation rate；
- stale or contradicted memory count；
- user-denied memory save rate；
- memory write approval rate；
- memory hint used in final answer count。

验收：

- `/v1/runtime/memory/status` 或 `/context` 诊断能展示最近窗口 memory quality summary。
- eval harness 能断言 memory hint 不被当作 workspace fact。

### 3.6 Loop Taxonomy

统一文档和代码注释中的 loop 命名：

| 名称 | 含义 |
| --- | --- |
| runtime loop | provider/tool loop inside `LLMCodingRuntime` |
| tool loop | a single provider-requested tool call lifecycle |
| agent loop | planner/executor/critic/optimizer task loop |
| interaction loop | Go TUI / `bbl loop` UI event loop |

验收：

- `docs/nexus/ARCHITECTURE.md`、`TODO.md`、`active/TODO_*` 使用同一组术语。
- 新增 loop 文档必须声明它是否拥有 runtime truth；默认不拥有。

## 4. 优先级

| 优先级 | 项目 | 承接文档 |
| --- | --- | --- |
| P1 | Agent Trace Schema | `active/TODO_performance.md` |
| P1 | Trajectory Eval Harness | `active/TODO_performance.md` |
| P1 | Durable Run Checkpoint / Resume | `active/TODO_runtime.md` |
| P2 | Memory Quality Metrics | `active/TODO_runtime.md`, memory reference docs |
| P2 | MCP Context Primitives | `active/TODO_runtime.md`, tool/MCP reference docs |
| P2 | Loop Taxonomy Cleanup | `ARCHITECTURE.md`, `TODO.md`, TUI/loop reference docs |

## 5. Implementation Order

1. Define trace projection from existing events.
2. Add CLI/debug export for a session trace.
3. Build a small trajectory eval harness using exported traces.
4. Define resumable execution states and checkpoint boundaries.
5. Add memory quality summary using existing diagnostics.
6. Extend MCP context primitives only after a real resource-use regression or integration need.

## 6. Success Criteria

BabeL-O can claim production-grade agent runtime maturity when:

- every run has a reconstructable trace,
- core coding behaviors have trajectory eval coverage,
- interrupted sessions report exact resumability state,
- memory quality is visible and testable,
- MCP context is scope-governed,
- all loop layers are named consistently and only Nexus/runtime own execution truth.
