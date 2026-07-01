# Skills

> 模块参考·稳定公开契约·深层架构请参见关联治理文档

[English](skills.md)

## 角色定位

Skills 是技能编写与注册子系统。它拥有规范化技能 schema、带有来源归属（builtin / user / project）的加载时注册表、返回结构化诊断信息的纯校验器、用于规范序列化的 Markdown 格式化器、仅限内存的草稿生成器，以及要求显式确认后才保存的持久化层。本模块不执行技能——技能调用属于调用方职责（Nexus 工具层或模型的隐式触发匹配）。

## 公开契约

- **`NormalizedSkill`** — 规范化技能形状：`id`、`name`、`triggers`、`priority`、`content`、`version`、`status`、`description`、`source`、`scope`、`risk`、`allowedTools`。无论前置元数据提供了哪些字段，每个技能都携带规范化视图。
- **`loadSkillRegistry({ cwd })` → `SkillRegistry`** — 加载内置、用户和项目技能，执行覆盖解析（project > user > builtin）、重复检测和逐文件诊断（失败文件不会抛出异常）。返回 `list()`、`get(id)`、`match(prompt)` 和 `diagnose()`。
- **`validateSkill(raw)` → `SkillValidationResult`** — 纯函数、不抛异常的校验。返回结构化 `SkillDiagnostic[]`，覆盖必填字段、id 格式、status、risk、allowedTools 形状和内容为空等情况。
- **`formatSkill(normalized)` → `string`** — 规范化的 Markdown 序列化（前置元数据 + 正文）。文件仅通过显式的 format/save 操作才会重写；规范化仅在内存中进行。
- **`generateSkillDraft(input)` → `SkillDraftResult`** — 生成状态为 `draft` 的内存中 `NormalizedSkill`，从不写入磁盘。包含令牌和私有路径的脱敏处理、触发词推导和校验。
- **`saveSkill({ draft, confirm, ... })` → `SkillSaveResult`** — 仅在显式 `confirm: true` 且可选 `overwrite: true` 后才持久化。通过 `shared/skillEvents.ts` 发出类型化 `SkillSavedEvent`。重复检测（id、名称、触发词重叠）为建议性质，不会阻止保存。

## 允许的依赖

Skills 是一个叶子模块。它导入 `shared`（`skillEvents.ts`）和标准 Node 包（`fs/promises`、`path`、`os`）。层方向门禁允许来自 `nexus`（路由）、`tools`（模型可见工具层）和 `runtime`（上下文组装）的反向导入：

- `nexus/skillRoutes.ts` → skills — 由完整产品循环支撑的 `/v1/skill/{list,show,validate,draft,save}` Fastify 路由。
- `tools/builtin/skillTool.ts` → skills — 模型可见的 `SkillList`、`SkillShow`、`SkillValidate`、`SkillDraft`、`SkillSave` 工具。
- `runtime/contextAssembler.ts` → skills — 用于基于触发词的系统提示注入的旧版 `loadAllSkills` + `matchSkills`。

禁止从 `skills` 到任何非 shared 模块的反向导入。

## 扩展点

- **添加技能风险等级** — 在 `schema.ts` 中扩展 `SkillRisk` 联合类型，在 `validator.ts` 中扩展 `VALID_RISK` 集合。运行时权限策略（位于 `src/runtime`）将风险作为建议性提示使用。
- **添加前置元数据字段** — 在 `schema.ts` 中扩展 `RawSkillExtensions`，在 `normalizer.ts` 中扩展规范化器，在 `formatter.ts` 中扩展格式化器。校验器会自动透传未知字段。
- **替换触发词匹配器** — 实现新的 `matcher.ts` 接口并替换 `registry.ts` 中的导入。当前匹配器使用基于子串计数的评分和正则转义。
- **添加存储后端** — `storage.ts` 中的 `saveSkill` / `previewSkillSave` 表面当前将 `.md` 文件写入磁盘；未来后端可通过相同的 `SkillSaveInput` 契约路由到数据库或远程存储。

## 关联治理

- [技能执行与生成治理](../../nexus/reference/skill-execution-and-automated-normalized-skill-generation-governance-plan.md) — 完整产品循环：schema、注册表、显式工具、草稿/保存、生成约束。P0-P3 已于 2026-06-22 关闭。
- [智能体/会话/技能治理索引](../../nexus/reference/agent-session-skill-governance-index.md) — 连接技能治理与智能体运行时成熟度和会话协作的读者入口。
- [工具治理](../../nexus/reference/tool-governance-plan.md) — 技能-工具边界、工具准入门禁和规范的工具分类体系。
- [运行时工具循环治理](../../nexus/reference/runtime-tool-loop-governance-plan.md) — 适用于技能调用的工具循环连续性和有界最终检查。
- [层方向审计](../../nexus/reference/layer-direction-audit-enforcement-plan.md) — 针对 `nexus` 和 `runtime` 反向导入 `skills` 的方向感知依赖门禁。
