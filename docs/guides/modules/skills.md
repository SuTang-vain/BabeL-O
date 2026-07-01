# Skills

> Module reference · stable public contract · see linked governance docs for deep architecture

[简体中文](skills.zh-CN.md)

## Role

Skills is the skill-authoring and skill-registry subsystem. It owns the normalized skill schema, a load-time registry with source provenance (builtin / user / project), a pure validator that returns structured diagnostics, a Markdown formatter for canonical serialization, an in-memory draft generator, and a persistence layer with explicit confirm-before-save. The module does not host execution — skill invocation is the caller's responsibility (Nexus tool layer or model-level implicit trigger matching).

## Public contract

- **`NormalizedSkill`** — the canonical skill shape: `id`, `name`, `triggers`, `priority`, `content`, `version`, `status`, `description`, `source`, `scope`, `risk`, `allowedTools`. Every skill carries a normalized view regardless of which fields the front matter provides.
- **`loadSkillRegistry({ cwd })` → `SkillRegistry`** — loads built-in, user, and project skills with overlay resolution (project > user > builtin), duplicate detection, and per-file diagnostics (skipped files do not throw). Returns `list()`, `get(id)`, `match(prompt)`, and `diagnose()`.
- **`validateSkill(raw)` → `SkillValidationResult`** — pure, non-throwing validation. Returns structured `SkillDiagnostic[]` covering required fields, id format, status, risk, allowedTools shape, and body emptiness.
- **`formatSkill(normalized)` → `string`** — canonical Markdown serialization (front matter + body). Files are rewritten only through explicit format/save; normalization is in-memory only.
- **`generateSkillDraft(input)` → `SkillDraftResult`** — produces an in-memory `NormalizedSkill` with status `draft`, never writes disk. Includes redaction of tokens and private paths, trigger derivation, and validation.
- **`saveSkill({ draft, confirm, ... })` → `SkillSaveResult`** — persisted only after explicit `confirm: true` and optional `overwrite: true`. Emits a typed `SkillSavedEvent` via `shared/skillEvents.ts`. Duplicate detection (id, name, trigger overlap) is advisory and does not block save.

## Allowed dependencies

Skills is a leaf module. It imports `shared` (`skillEvents.ts`) and standard Node packages (`fs/promises`, `path`, `os`). The layer-direction gates allow reverse imports from `nexus` (routes), `tools` (model-visible tool surface), and `runtime` (context assembly):

- `nexus/skillRoutes.ts` → skills — Fastify routes for `/v1/skill/{list,show,validate,draft,save}` backed by the full product loop.
- `tools/builtin/skillTool.ts` → skills — model-visible `SkillList`, `SkillShow`, `SkillValidate`, `SkillDraft`, `SkillSave` tools.
- `runtime/contextAssembler.ts` → skills — legacy `loadAllSkills` + `matchSkills` for trigger-based system-prompt injection.

Reverse imports from `skills` to any non-shared module are forbidden.

## Extension points

- **Add a skill risk level** — extend the `SkillRisk` union type in `schema.ts` and `VALID_RISK` set in `validator.ts`. Runtime permission policy (in `src/runtime`) consumes risk as an advisory hint.
- **Add a front-matter field** — extend `RawSkillExtensions` in `schema.ts`, the normalizer in `normalizer.ts`, and the formatter in `formatter.ts`. The validator automatically passes unknown fields through.
- **Replace the trigger matcher** — implement a new `matcher.ts` interface and swap the import in `registry.ts`. The current matcher uses substring-count scoring with regex escaping.
- **Add a storage backend** — the `saveSkill` / `previewSkillSave` surface in `storage.ts` currently writes `.md` files to disk; a future backend could route to a database or remote store through the same `SkillSaveInput` contract.

## Related governance

- [Skill execution and generation governance](../../nexus/reference/skill-execution-and-automated-normalized-skill-generation-governance-plan.md) — full product loop: schema, registry, explicit tools, draft/save, generation constraints. P0-P3 closed 2026-06-22.
- [Agent/session/skill governance index](../../nexus/reference/agent-session-skill-governance-index.md) — reader entry point connecting skill governance with agent runtime maturity and session collaboration.
- [Tool governance](../../nexus/reference/tool-governance-plan.md) — skill-tool boundaries, tool admission gates, and the canonical tool-class taxonomy.
- [Runtime tool-loop governance](../../nexus/reference/runtime-tool-loop-governance-plan.md) — tool-loop continuity and bounded final checks that apply to skill invocation.
- [Layer-direction audit](../../nexus/reference/layer-direction-audit-enforcement-plan.md) — direction-aware dependency gates for `nexus` and `runtime` reverse imports of `skills`.
