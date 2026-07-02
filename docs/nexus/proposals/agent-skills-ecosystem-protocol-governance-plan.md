# Agent Skills Ecosystem Protocol Governance Plan

> State: Partially Landed
> Track: Skills / Protocol Compatibility / Marketplace Governance
> Priority: P1 — BabeL-O skills are internally usable but currently use a private single-file protocol. This plan makes Agent Skills the external interchange format while preserving `NormalizedSkill` as BabeL-O's internal IR.
> Source of truth: [../TODO.md](../TODO.md), [../active/TODO_runtime.md](../active/TODO_runtime.md), [../reference/agent-session-skill-governance-index.md](../reference/agent-session-skill-governance-index.md), [../reference/skill-execution-and-automated-normalized-skill-generation-governance-plan.md](../reference/skill-execution-and-automated-normalized-skill-generation-governance-plan.md), `src/skills/`, `src/tools/builtin/skillTool.ts`, `src/nexus/skillRoutes.ts`, `clients/go-tui/internal/tui/overlay_skills.go`
> Governance: Indexed by [README.md](./README.md) and [../reference/agent-session-skill-governance-index.md](../reference/agent-session-skill-governance-index.md). This document owns cross-ecosystem skill package compatibility; the existing Skill Execution plan continues to own BabeL-O's product loop.
> External references: [Agent Skills specification](https://agentskills.io/specification), [OpenAI API Skills](https://developers.openai.com/api/docs/guides/tools-skills), [OpenAI Codex Skills](https://developers.openai.com/codex/skills), [Anthropic Agent Skills overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview), [MCP Registry overview](https://modelcontextprotocol.io/registry/about)

## Purpose

BabeL-O's current skill implementation is functionally useful but ecosystem-private: skills are single Markdown files with BabeL-O-specific fields (`id`, `triggers`, `priority`, `risk`, `allowedTools`) and private APIs (`/v1/skills/*`, `SkillList`, `SkillShow`, `SkillValidate`, `SkillDraft`, `SkillSave`). This makes built-in/user/project skills work inside BabeL-O, but it does not make them interoperable with the broader Agent Skills ecosystem.

The external ecosystem has converged around a directory package anchored by `SKILL.md`. The public Agent Skills specification describes progressive disclosure: load `name` and `description` metadata at startup, load the full `SKILL.md` only when activated, and load bundled resources such as `scripts/`, `references/`, and `assets/` only when required. OpenAI's API docs describe skills as a versioned bundle of files plus a `SKILL.md` manifest compatible with the open Agent Skills standard. OpenAI Codex docs similarly define a skill as a directory with required `SKILL.md` plus optional scripts/references/assets. Anthropic docs show the same progressive loading shape.

This plan makes BabeL-O interoperable by adopting Agent Skills as the wire/package format and treating `NormalizedSkill` as an internal IR. BabeL-O-specific governance remains in `metadata.babel-o` or loader-derived fields, not as a competing top-level market protocol.

## Current State

Implemented today:

- Single-file legacy skills: `src/skills/built-in/*.md`, `~/.babel-o/skills/*.md`, `<cwd>/.babel-o/skills/*.md`.
- Legacy front matter parser: flat key/value parsing in `src/skills/loader.ts`.
- Internal normalized shape: `NormalizedSkill` in `src/skills/schema.ts`.
- Registry overlay: built-in < user < project in `src/skills/registry.ts`.
- Trigger matcher: substring scoring over `triggers`.
- Runtime prompt injection: `loadAllSkills()` + `matchSkills()` in `contextAssembler.ts`.
- Explicit product loop: Nexus routes and model-visible `Skill*` tools.

Gaps:

- No directory package support (`my-skill/SKILL.md`).
- No `scripts/`, `references/`, or `assets/` resource indexing.
- No standard `name` / `description`-first discovery path.
- No `metadata` parsing, therefore no clean place for BabeL-O-specific fields.
- No import/export path for external skill folders or zips.
- No lockfile, source origin, integrity hash, trusted/untrusted state, or update diff.
- No marketplace/registry metadata model.

## Protocol Decision

Use a two-layer model:

```text
External wire/package format: Agent Skills package
Internal execution/registry shape: BabeL-O NormalizedSkill IR
```

### External package

```text
my-skill/
├── SKILL.md
├── scripts/
├── references/
├── assets/
└── LICENSE.txt
```

`SKILL.md` should be accepted with at least:

```yaml
---
name: context-debugging
description: Debug context assembly, tool suppression, and runtime event flow.
license: MIT
compatibility: Requires BabeL-O 0.4+, Node.js 22+.
allowed-tools: Read Grep Glob Bash(git:*)
metadata:
  babel-o:
    schemaVersion: 2026-07-02.skill.v2
    displayName: Context Debugging
    status: active
    scope: project
    priority: 80
    risk: read
    triggers:
      - context assembly
      - tool suppression
---
```

### Internal IR

`NormalizedSkill` remains the product-facing contract. New compatibility fields are loader-derived and optional:

```ts
sourceFormat: 'babel-o-v1' | 'agent-skills-v1'
packageRoot?: string
manifestPath?: string
resources?: SkillResource[]
license?: string
compatibility?: string
metadata?: Record<string, unknown>
origin?: { type: 'local' | 'git' | 'registry' | 'url'; url?: string; revision?: string }
integrity?: { sha256: string }
```

## Goals

- Load both legacy BabeL-O single-file skills and Agent Skills directory packages.
- Preserve current built-in/user/project overlay behavior.
- Prefer standard `description` for discovery while preserving `metadata.babel-o.triggers` / legacy `triggers`.
- Keep all external skill resources inside their package root.
- Treat `allowed-tools` as advisory; runtime permission policy remains authoritative.
- Introduce import/export/lockfile later without changing the IR again.

## Non-goals

- Do not execute bundled scripts automatically.
- Do not bypass `SkillSave` confirmation or runtime permission gates.
- Do not introduce a central marketplace service in the first slice.
- Do not require all legacy `.md` skills to migrate immediately.
- Do not make MCP Registry a skill protocol; only borrow registry metadata/security patterns.

## Phases

| Phase | Status | Scope | Exit criteria |
| --- | --- | --- | --- |
| Phase 0 | Closed 2026-07-02 | Admit this proposal and implement minimal Agent Skills package loading (`*/SKILL.md`) into `NormalizedSkill`. | Legacy tests still pass; new tests prove package load, standard metadata mapping, and overlay compatibility. |
| Phase 1 | Closed 2026-07-02 | Replace ad hoc front matter parsing with a small YAML-compatible parser sufficient for nested `metadata.babel-o`. | Existing legacy fields parse identically; nested metadata maps to IR. |
| Phase 2 | Closed 2026-07-02 | Resource index hardening for `scripts/`, `references/`, `assets/`; path traversal / symlink guard; no execution. | `SkillShow` exposes resource metadata; resource paths cannot escape package root, including via symlink or realpath drift. |
| Phase 2.x | Closed 2026-07-02 | Top-level companion `.md` and non-canonical top-level asset dirs in `listPackageResources`. Skips `.git` / `node_modules` / hidden / `.*` dirs by name before any `lstat`. Realpath + symlink guard preserved. | Real Anthropic-published `pdf` exposes `forms.md` + `reference.md` as `kind: 'reference'`; `canvas-design` exposes all 81 `canvas-fonts/*` as `kind: 'asset'`; `.git/HEAD` and `node_modules/` are skipped; symlink escape from non-canonical dir still rejected. |
| Phase 3 | Closed 2026-07-02 | Discovery semantics: matcher uses explicit invocation > `metadata.babel-o.triggers` > `description` > `name`. | Prompt with description-only package can match without private triggers. |
| Phase 3.x | Closed 2026-07-02 | Matcher quality gate: description length cap (200 terms), long-description hit-ratio floor (0.05) with 0.25× penalty, length penalty (`max(0.5, 200/termCount)`), absolute description-only hit floor (2). Trigger precedence unchanged. | Real prompt "merge two PDF files together" no longer demotes explicit-trigger skill below a 785-char description-only match; single-substring coincidence description matches dropped; existing trigger-priority tests monotonic. |
| Phase 4 | Partially Landed 2026-07-02 | Import/export preview APIs and tools for folder/zip/git path. | Local directory import preview/install and export preview/write are landed; zip/git remain open. |
| Phase 4.x | Closed 2026-07-02 | `SkillShow` progressive disclosure surface: companion references (`kind: 'reference'`) and companion assets (`kind: 'asset'`) sorted by path; `formatSkill()` renders `## Companion Resources` / `## Companion Assets` sections deterministically. | Real Anthropic `pdf` `SkillShow` returns `companionReferences.length === 2`; `canvas-design` `SkillShow` returns `companionAssets.length === 81`; tool prompt updated to surface companion paths. |
| Phase 5 | Draft | `skills.lock.json` with origin, revision, sha256, format, installedAt. | Install/update are reproducible and auditable. |
| Phase 6 | Draft | Marketplace metadata model, borrowing MCP Registry-style namespace/integrity concepts. | Local registry JSON can list packages; no central server required. |
| Phase 7 | Draft | Go TUI / CLI UX: `/skill import`, `/skill export`, `/skill resources`, `/skill update`. | TUI displays package format, resources, trust, and conversion warnings. |

## Landed Slices

### Phase 0

Minimal compatible package loading:

- `loadSkillsFromDir(dir)` scans direct `*.md` legacy files and direct child directories containing `SKILL.md`.
- `parseFrontMatter()` accepts:
  - legacy `id`, `name`, `triggers`, `priority`,
  - standard `name`, `description`, `license`, `compatibility`, `allowed-tools`,
  - optional flat `metadata.babel-o.*` keys for migration compatibility.
- Agent Skills `name` maps to BabeL-O `id` by kebab-case normalization.
- `description` maps to `description`.
- `allowed-tools` maps to advisory `allowedTools`.
- Package fields populate `sourceFormat='agent-skills-v1'`, `packageRoot`, `manifestPath`, `filePath`, and `resources`.
- Existing `.md` skills keep `sourceFormat='babel-o-v1'`.

### Phase 1

The front matter parser now supports the small YAML subset needed by standard
Agent Skills manifests:

- top-level scalar fields (`name`, `description`, `license`, `compatibility`,
  `allowed-tools`);
- inline lists (`triggers: [context assembly, tool suppression]`);
- nested maps (`metadata:` -> `babel-o:`);
- nested list items for `metadata.babel-o.triggers`.

This is intentionally not a full YAML implementation. It keeps BabeL-O's
runtime dependency surface small while accepting the package shape needed for
ecosystem interoperability.

### Phase 2

Package resources are indexed recursively from `scripts/`, `references/`, and
`assets/`. The loader resolves the package root with `realpath`, skips symbolic
links at every level, and only exposes resources whose real path remains inside
the package root. Resources are still metadata only; no bundled script is
executed by package loading, listing, or showing.

### Phase 3

Implicit matching now keeps explicit triggers as the strongest discovery signal,
then falls back to `description`, then `name` / `id`. This allows standard Agent
Skills packages without BabeL-O-specific triggers to participate in discovery,
while legacy and governance-authored trigger matches remain higher confidence.

### Phase 4 Local Directory Preview And Install

`SkillImportPreview` and `POST /v1/skills/import/preview` now accept a local
Agent Skills package directory containing `SKILL.md`. The preview:

- loads and normalizes the package as `agent-skills-v1`;
- returns target scope/path, manifest path, resources, diagnostics, duplicate
  id/name warnings, and conversion metadata;
- warns when the source is outside the current cwd;
- never writes to `.babel-o/skills`;
- does not support zip/git sources yet.

`SkillImportInstall` and `POST /v1/skills/import/install` are the confirm-gated
write path. They:

- require `confirm: true` before copying anything;
- return the same preview shape when confirmation is missing;
- copy the Agent Skills package directory into the selected scope as
  `.babel-o/skills/<skill-id>/SKILL.md` plus bundled resources;
- skip symbolic links while copying;
- require `overwrite: true` if the target package already exists.

`SkillExportPreview` and `POST /v1/skills/export/preview` convert an existing
registry skill into a standard Agent Skills package preview. They:

- load a skill by id from the current registry;
- generate a standard `SKILL.md` manifest with top-level `name`,
  `description`, `allowed-tools`, and BabeL-O governance fields under
  `metadata.babel-o`;
- return the planned package root and manifest path;
- never create the export directory or write files.

`SkillExportWrite` and `POST /v1/skills/export/write` are the confirm-gated
write path. They:

- require `confirm: true` before writing;
- return the same preview shape when confirmation is missing;
- write `SKILL.md` into the target package directory;
- copy package resources when the source skill already has indexed resource
  paths;
- require `overwrite: true` if the target package already exists.

### Phase 2.x Resource Walk Hardening (real-public-sample follow-up)

Real Anthropic-published skill samples (`pdf`, `docx`, `pptx`, `canvas-design`)
surfaced three concrete gaps the canonical Phase 2 walker did not cover:

1. Top-level companion `.md` files (`pdf/forms.md`, `pdf/reference.md`,
   `pptx/editing.md`, `pptx/pptxgenjs.md`) ship alongside `SKILL.md` as the
   publisher's progressive-disclosure follow-up docs.
2. Non-canonical top-level asset directories (`canvas-design/canvas-fonts/`)
   contain the entire payload of generation-style skills.
3. Hidden directories (`.git`, `.github`, `.svn`, `.hg`, `node_modules`,
   `__pycache__`, `.venv`, `venv`, `.idea`, `.vscode`) and any name starting
   with `.` must be skipped before any `lstat` so a hostile package cannot
   blow up resource indexing on `.git/HEAD` or `node_modules/` walks.

`src/skills/loader.ts:listPackageResources()` now:

- walks the three canonical spec dirs (`scripts` → `script`,
  `references` → `reference`, `assets` → `asset`) with the existing
  realpath + symlink guard preserved verbatim;
- indexes direct top-level `*.md` children of the package root as
  `kind: 'reference'`, except `SKILL.md` itself and standard license / readme
  / changelog files (whitelist: `LICENSE`, `LICENSE.txt`, `LICENSE.md`,
  `NOTICE`, `NOTICE.txt`, `README`, `README.md`, `CHANGELOG`, `CHANGELOG.md`);
- walks any direct subdirectory of the package root that is not one of the
  three spec dirs and not on the skip-list, recursively, as `kind: 'asset'`;
- rejects symlink entries and any realpath that escapes the package root;
- is deterministic: sibling order follows `path.localeCompare`.

Existing `test/skills.test.ts:loadSkillsFromDir does not expose symlinked
package resources` continues to pass unchanged. Four new tests cover the
companion-Markdown path, the non-canonical-dir path, the skip-list path, and
symlink escape from a non-canonical top-level dir.

### Phase 3.x Matcher Quality Gate (real-public-sample follow-up)

Real Anthropic `docx` description (785 chars, packed with high-frequency
keywords Anthropic deliberately uses for their own matcher) was outscoring
focused short-description skills on tangential prompts ("merge two PDF files
together" returned `docx` in the top-3). The canonical Phase 3 declared
description fallback without a quality gate.

`src/skills/matcher.ts:matchSkills()` now applies a deterministic gate before
a description hit contributes to the score:

- `LONG_DESCRIPTION_THRESHOLD = 200` term-count: descriptions at or above
  this count are treated as "long-form";
- `LONG_DESCRIPTION_HIT_RATIO_FLOOR = 0.05`: when the description is long,
  the hit ratio (`hitCount / termCount`) must clear this floor; otherwise
  the description score is multiplied by `LONG_DESCRIPTION_HIT_RATIO_PENALTY`
  = `0.25`;
- `lengthPenalty = max(0.5, LONG_DESCRIPTION_THRESHOLD / termCount)`:
  long descriptions that *do* clear the ratio floor are additionally scaled
  down so a 1000-term description cannot out-score a 100-term description on
  equivalent hit ratios;
- `DESCRIPTION_ABSOLUTE_HIT_FLOOR = 2`: descriptions of any length must yield
  at least 2 absolute term hits to contribute; single-substring coincidence
  is dropped;
- name/id tier (no trigger, no description contribution) keeps the existing
  per-term additive rule with a 1-hit minimum;
- trigger tier is unchanged: explicit trigger hits always outrank description
  hits.

Five existing match tests (`matchSkills scores trigger matches and sorts
correctly`, `matchSkills can discover Agent Skills by description and name`,
`matchSkills keeps explicit triggers ahead of description-only matches`, ...)
continue to pass unchanged. Three new tests cover the long-description gate,
the absolute hit floor, and trigger-priority preservation under the gate.

### Phase 4.x SkillShow Progressive Disclosure (real-public-sample follow-up)

`SkillShow` now exposes the kind-sorted, deterministically-ordered companion
payload separately from the raw `resources` array:

- `companionReferences: SkillResource[]` — every `kind: 'reference'`
  resource, sorted by `path.localeCompare`;
- `companionAssets: SkillResource[]` — every `kind: 'asset'` resource, sorted
  by `path.localeCompare`;
- `formatSkill()` renders two new sections after the body, only when the
  matching companion array is non-empty:
  - `## Companion Resources` listing `[reference] <path>` entries;
  - `## Companion Assets` listing `[asset] <path>` entries.
- The model-visible `SkillShow.prompt()` gained a one-line progressive
  disclosure hint so the model knows to surface companion paths when the
  publisher shipped them next to `SKILL.md`.

The Nexus `SkillShowResponse` type was extended to declare the two new
optional fields so external clients (notably the Go TUI) get a typed
contract.

## Security Rules

- External packages are untrusted by default.
- `scripts/` are data until a future permission-gated execution path exists.
- Resource reads must resolve within `packageRoot`.
- `allowed-tools` never grants permission; it only narrows or describes expected tool use.
- Future install/update must be preview-first and confirm-gated.
- Future zip support must prevent zip-slip.
- Future marketplace entries must include source origin and integrity metadata.

## Verification

Phase 0-4.x:

- `NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-agent-skills-protocol.json BABEL_O_USER_SKILLS_DIR=/tmp/babel-o-agent-skills-user npx tsx --test --test-concurrency=1 test/skills.test.ts test/skill-registry.test.ts test/skill-tools.test.ts test/skill-schema.test.ts test/skill-read-router.test.ts test/skill-routes.test.ts test/skill-draft-route.test.ts test/skill-save-route.test.ts test/skill-validate-router.test.ts test/router-registrar.test.ts`
- `npm run typecheck`
- `npm run format:check`
- `npm run docs:check`
- `git diff --check`

Phase 2.x / 3.x / 4.x real-public-sample smoke:

- `git clone --depth 1 --filter=blob:none --sparse https://github.com/anthropics/skills.git /tmp/skills-e2e2/sources/skills && git -C /tmp/skills-e2e2/sources/skills sparse-checkout set skills/pdf skills/docx skills/pptx skills/canvas-design`
- `cp -R /tmp/skills-e2e2/sources/skills/skills/{pdf,docx,pptx,canvas-design} /tmp/skills-e2e2/.babel-o/skills/`
- `node /tmp/skills-e2e2/real-smoke.mjs` → 11 skills total; `pdf.resources.length === 10` (8 script + 2 reference: `forms.md`, `reference.md`); `pptx.resources.length === 57` (55 script + 2 reference: `editing.md`, `pptxgenjs.md`); `canvas-design.resources.length === 81` (all 81 `canvas-fonts/*` as `asset`); `docx.resources.length === 59` (no top-level companion MD).

Later phases add zip/git import source, lockfile, marketplace metadata, and TUI/CLI UX focused suites.

## 中文概述

### 背景

当前 BabeL-O skill 是内部可用的自有协议：单 Markdown 文件、私有 front matter、私有 `/v1/skills/*` API 和 `Skill*` 工具。它不能自然消费 Agent Skills / Claude / OpenAI/Codex 生态中流通的目录型 skill 包。

### 决策

外部流通格式采用 Agent Skills：目录 + `SKILL.md` + 可选 `scripts/` / `references/` / `assets/`。BabeL-O 自己保留 `NormalizedSkill` 作为内部 IR，自有字段放入 `metadata.babel-o` 或 loader-derived 字段，不再扩展一个竞争性的市场协议。

### 第一切片

Phase 0-4 本地目录切片已落地：`loadSkillsFromDir()` 能识别 `*/SKILL.md`，把标准 `name` / `description` / `allowed-tools` 映射到 `NormalizedSkill`，支持 `metadata.babel-o` 嵌套写法，对 `scripts/` / `references/` / `assets/` 资源做 realpath/symlink 防逃逸，并让 description/name 参与隐式发现，同时保留旧 `.md` 技能全部兼容。导入/导出已具备 preview-first、confirm-gated 的本地目录路径，并覆盖资源复制。后续重点是 zip/git 来源、`skills.lock.json`、marketplace 元数据和 TUI/CLI 体验。
