# BabeL-O Documentation

This directory contains project documentation with separate ownership boundaries.

## Directory Map

| Path | Role |
| --- | --- |
| [nexus/](./nexus/) | Canonical planning, architecture, active TODO, reference, archive, DONE, and WORK_LOG center for Nexus-first implementation work. |
| [releases/](./releases/) | Public release notes, release checklist, and release operations docs. |
| [assets/](./assets/) | README and product documentation images. |
| [DEVELOPMENT.md](./DEVELOPMENT.md) | English contributor source-checkout guide. |
| [DEVELOPMENT.zh-CN.md](./DEVELOPMENT.zh-CN.md) | Chinese contributor source-checkout guide. |

## Governance

- Long-lived planning, audits, tuning notes, implementation plans, and walkthroughs belong under [nexus/](./nexus/), not in the docs root.
- Public version notes belong under [releases/](./releases/).
- Product and contributor guides may stay in the docs root only when they are not Nexus planning documents.
- New reference/planning docs should follow [nexus/reference/REFERENCE_TEMPLATE.md](./nexus/reference/REFERENCE_TEMPLATE.md).

## 中文概述

### 背景

`docs/` 根目录不再承载长期规划，但仍需要保留产品开发指南、发布说明和图片资源。

### 边界

长期规划统一进入 `docs/nexus/`；发布说明进入 `docs/releases/`；根目录只保留少量项目级指南和本索引。
