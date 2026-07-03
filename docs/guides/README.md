# BabeL-O User Guides

External, user-facing documentation for BabeL-O. These documents are kept
separate from the internal Nexus planning library in [../nexus/](../nexus/).

## User guides

Task-oriented docs for running BabeL-O.

| Document | Audience | Role |
| --- | --- | --- |
| [quickstart.md](./quickstart.md) | Users | Five-minute path from install to first coding session. |
| [providers.md](./providers.md) | Users | Configure providers, models, base URLs, and profiles. |
| [session-and-context.md](./session-and-context.md) | Users | Manage sessions, inspect context, compaction, and resume work. |
| [permissions.md](./permissions.md) | Users | Tool risk levels, approvals, policies, and auditing. |
| [mcp.md](./mcp.md) | Users | Configure MCP servers and use MCP tools under the permission model. |
| [troubleshooting.md](./troubleshooting.md) | Users | Common issues and diagnostic commands. |
| [examples.md](./examples.md) | Users | Cookbook of usage patterns and prompts. |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Users and contributors | Public architecture overview: Client, Nexus, Runtime, tools, agents, memory, storage, and observability boundaries. |
| [FAQ.md](./FAQ.md) | Users | Frequently asked questions, focused on MemoryOS / long-term memory. |
| [distribution-guide.md](./distribution-guide.md) | Operators and users | Lightweight portable packages, install script behavior, release assets, and user-side checks. |

New user guides are bilingual: an English `<name>.md` and a Chinese
`<name>.zh-CN.md` (see [providers.zh-CN.md](./providers.zh-CN.md)).

## Module reference

Stable per-module reference for contributors, one page per source module. See
[modules/](./modules/).

## Boundary

These guides describe the product as users and contributors experience it.
Internal planning, active TODOs, proposals, and work history live under
[../nexus/](../nexus/); release notes live under [../releases/](../releases/).
Do not add Nexus planning documents here — they belong in [../nexus/](../nexus/).

## 中文概述

### 作用

`docs/guides/` 存放面向外部的用户文档,与 `docs/nexus/` 内部规划库分开维护。

### 收录

用户指南(providers 等)、架构总览(ARCHITECTURE)、常见问题(FAQ)、分发指南(distribution-guide),以及贡献者模块参考(modules/)。

### 边界

内部规划、active TODO、提案和工作流水仍在 `docs/nexus/`;发布说明在 `docs/releases/`。本目录不放置 Nexus 规划文档。
