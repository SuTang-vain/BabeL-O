# MCP

> Module reference · stable public contract · see linked governance docs for deep architecture

[简体中文](mcp.zh-CN.md)

## Role

MCP (Model Context Protocol) wraps external tool servers as BabeL-O tools. It
owns the stdio-based JSON-RPC 2.0 client (`McpClient`), the server config
registry (`McpRegistry`), and the tool adapter (`McpToolAdapter`) that converts
remote MCP tool definitions into `ToolDefinition` instances consumable by the
Nexus runtime.

MCP is a **leaf domain** — it exposes a narrow tool-wrapping surface and neither
depends on nor needs awareness of the execution engine, agent loop, or
interaction layer. All MCP tools registered by `createMcpToolRegistry` carry the
`mcp:<serverName>:<originalName>` naming prefix and a `source.type: 'mcp'`
identity so the runtime and permission system can distinguish them from native
builtins.

## Public contract

- **`McpClient(command, args?, env?, cwd?, framing?)`** — a stdio child-process
  client that speaks JSON-RPC 2.0 with `Content-Length` or `\n`-delimited
  framing. It supports `tools/list` and `tools/call` **only**. No resources,
  prompts, roots, or other MCP protocol capabilities are implemented. The client
  is pre-connected, initialized with protocol version `2024-11-05`, and
  identified to the server as `BabeL-O`.
- **`McpRegistry`** — loads merged server config from
  `~/.babel-o/mcp.json` → `<cwd>/.babel-o/mcp.json` (project overrides user).
  Each server entry specifies `command`, `args`, `env`, `cwd`, `allowedTools`,
  and `toolRisk` (read / write / execute / task). Tools not in `allowedTools`
  are registered but gate their `execute` with a rejection message.
- **`createMcpToolRegistry(cwd)` → `Map<string, AnyTool>`** — iterates every
  configured server, initializes a `McpClient` per server, calls `tools/list`,
  wraps each remote tool as a `ToolDefinition` with `jsonSchemaToZod` input
  validation, risk classification, and `mcpServerAllowed` gating. The tools are
  then merged into the global tool map by `createDefaultNexusRuntime` in Nexus
  (via `registerToolWithDiagnostics`).

## Allowed dependencies

MCP sits at the bottom of the module graph and may import `shared` (version
constants) and `tools` (the `ToolDefinition`, `AnyTool`, and `ToolRisk` types).
The layer-direction gates (`deps:audit`, enforced in CI) forbid the reverse:

- `runtime` → `mcp` is **forbidden** (runtime must not depend on the leaf MCP
  module directly; MCP tools are injected at harness time by Nexus).
- `nexus` → `mcp` is **allowed** only through the narrow entry point
  `createMcpToolRegistry` called from `nexus/createRuntime.ts`.
- `mcp` → `nexus` / `mcp` → `cli` is **forbidden** (MCP is a leaf domain and
  must not depend on any execution or interaction layer).

See
[Layer-direction audit](../../nexus/reference/layer-direction-audit-enforcement-plan.md)
and
[Module coupling governance](../../nexus/reference/module-coupling-decoupling-and-re-aggregation-plan.md)
for the full leaf-domain rules and coupling heat map.

## Extension points

- **Add an MCP server** — add a JSON entry to `~/.babel-o/mcp.json` (user-wide)
  or `<cwd>/.babel-o/mcp.json` (project-local) with `command`, optional `args`
  / `env` / `cwd`, an `allowedTools` allowlist, and per-tool `toolRisk`
  classification. No code change is required.
- **Configure tool risk and allowlist** — the `toolRisk` map per server
  overrides the default `read` risk level; the `allowedTools` array restricts
  which tools are callable. A tool not in `allowedTools` will be registered but
  its `execute` will reject with an `MCP_INPUT_SCHEMA_VALIDATION_FAILED`-style
  message.
- **Future protocol expansion** — MCP resources, prompts, and roots are not
  currently supported. If a real integration demands them, they must go through
  the same runtime-owned scope handling and permission flow as native tools,
  not become a bypass of `Read` or the project-root gate. This is tracked as a
  plan-only candidate in the tool governance plan.

## Related governance

- [Tool governance](../../nexus/reference/tool-governance-plan.md) — native/MCP coexistence rules, `mcp:*` tool class, source-qualified identity, naming collision diagnostics.
- [Agent runtime maturity](../../nexus/reference/agent-runtime-architecture-maturity-plan.md) — MCP context primitives gap (resources/prompts/roots) and future expansion governance.
- [Runtime tool-loop governance](../../nexus/reference/runtime-tool-loop-governance-plan.md) — MCP write tools excluded from `final_check` scope.
- [Layer-direction audit](../../nexus/reference/layer-direction-audit-enforcement-plan.md) — `src/mcp/` classified as a leaf domain with direction-aware import gates.
- [Module coupling governance](../../nexus/reference/module-coupling-decoupling-and-re-aggregation-plan.md) — coupling heat map for `mcp/` (2 outbound edges: `tools/Tool.js`, `shared/version.js`).
