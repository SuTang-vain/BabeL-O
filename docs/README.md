# BabeL-O Documentation

This directory contains project documentation with separate ownership boundaries.

## Directory Map

| Path | Role |
| --- | --- |
| [nexus/](./nexus/) | Canonical planning, active TODO, reference, archive, DONE, and WORK_LOG center for Nexus-first implementation work. |
| [guides/](./guides/) | External user-facing documentation: architecture overview, FAQ, and distribution guide. |
| [releases/](./releases/) | Public release notes, release checklist, and release operations docs. |
| [assets/](./assets/) | README and product documentation images. |
| [DEVELOPMENT.md](./DEVELOPMENT.md) | English contributor source-checkout guide. |
| [DEVELOPMENT.zh-CN.md](./DEVELOPMENT.zh-CN.md) | Chinese contributor source-checkout guide. |

## Governance

- Long-lived planning, audits, tuning notes, implementation plans, and walkthroughs belong under [nexus/](./nexus/), not in the docs root.
- Public version notes belong under [releases/](./releases/).
- External user-facing product documentation (architecture, FAQ, distribution) lives in [guides/](./guides/); contributor source-checkout guides stay at the docs root.
- New reference/planning docs should follow [nexus/reference/REFERENCE_TEMPLATE.md](./nexus/reference/REFERENCE_TEMPLATE.md).

## 中文概述

### 背景

`docs/` 根目录不再承载长期规划，但仍需要保留产品开发指南、发布说明和图片资源。

### 边界

长期规划统一进入 `docs/nexus/`；发布说明进入 `docs/releases/`；外部用户文档进入 `docs/guides/`；根目录只保留少量项目级指南和本索引。
