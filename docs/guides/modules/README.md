# Module Reference

Stable, contributor-facing reference for each BabeL-O source module. One page
per module, kept thin on purpose: it documents the **public contract** and
**boundaries** that other modules and contributors depend on, not implementation
detail that drifts with every refactor.

For the deep architecture, governance, and open design questions behind a
module, follow the *Related governance* links on each page into the internal
[../../nexus/reference/](../../nexus/reference/) library.

## Pages

| Module | Role | Languages |
| --- | --- | --- |
| nexus | Execution host: Fastify REST + WebSocket API, session/storage orchestration, runtime harness, agent scheduling. | [EN](./nexus.md) · [中文](./nexus.zh-CN.md) |
| runtime | Execution engine: streaming loop, context assembly/compaction, tool dispatch, provider interaction, hooks. | [EN](./runtime.md) · [中文](./runtime.zh-CN.md) |
| providers | Model provider registry and adapters; retry; no-silent-switching. | [EN](./providers.md) · [中文](./providers.zh-CN.md) |
| tools | Tool interface, registry, builtin tools, risk classification, path safety. | [EN](./tools.md) · [中文](./tools.zh-CN.md) |
| mcp | MCP client + tool adapter; tools/list + tools/call only, no resources/prompts/roots. | [EN](./mcp.md) · [中文](./mcp.zh-CN.md) |
| storage | SQLite + in-memory storage; repository pattern; async WAL bridge. | [EN](./storage.md) · [中文](./storage.zh-CN.md) |
| shared | Leaf foundation: NexusEvent schema, shared types, IDs, errors, config. | [EN](./shared.md) · [中文](./shared.zh-CN.md) |
| cli | Commander commands (bbl run/go/config/sessions/doctor/...); one-shot flow. | [EN](./cli.md) · [中文](./cli.zh-CN.md) |
| skills | Skill registry, schema, validator, generator; SkillList/Show/Validate/Draft/Save tools. | [EN](./skills.md) · [中文](./skills.zh-CN.md) |
| go-tui | Production Go TUI (Bubble Tea); Nexus HTTP/WS client; interaction only. | [EN](./go-tui.md) · [中文](./go-tui.zh-CN.md) |
| go-runner | Optional Go RemoteToolRunner; approved-tools-only execution backend. | [EN](./go-runner.md) · [中文](./go-runner.zh-CN.md) |
| eval | Offline trajectory eval harness; builtin checks over agent traces. | [EN](./eval.md) · [中文](./eval.zh-CN.md) |

## Template

Each module page contains:

- **Role** — what this module owns, in plain terms.
- **Public contract** — the exported types, functions, and interfaces that
  consumers depend on. This is the stable surface; changing it is a breaking
  change.
- **Allowed dependencies** — what this module may import, aligned with the
  `deps:audit` layer-direction gates. The reverse direction is forbidden.
- **Extension points** — how to extend the module (register a router, add a
  tool, add a provider adapter, hook execution, …).
- **Related governance** — links to the internal reference docs that own the
  deep architecture for this area.
- **中文概述** — a concise Chinese summary.

## Authoring rules

- Each page is bilingual: `<name>.md` (English) and `<name>.zh-CN.md` (Chinese),
  mirroring the README convention. Cross-link the two at the top of each file.
- Keep the page about boundaries and contracts, not step-by-step build logs
  (those live in [../../nexus/history/](../../nexus/history/)).
- Do not duplicate content from the internal reference docs — link to them.
- When a module's public contract changes, update both language pages in the
  same PR.
- Pages are external and published; they must stay valid against the current
  codebase.
