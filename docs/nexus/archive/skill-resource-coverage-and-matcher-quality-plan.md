# Skill Resource Coverage And Matcher Quality Plan

> State: Archived 2026-07-02 — folded into the Agent Skills ecosystem protocol governance plan as Phase 2.x + Phase 3.x. See [../DONE.md](../DONE.md) for the implementation record and [../WORK_LOG.md](../WORK_LOG.md) for the verification trail.
> Track: Skills / Resource Indexing / Implicit Discovery
> Priority: P1 (closed)
> Source of truth: [../TODO.md](../TODO.md), [../active/TODO_runtime.md](../active/TODO_runtime.md), [agent-session-skill-governance-index.md](../reference/agent-session-skill-governance-index.md), [agent-skills-ecosystem-protocol-governance-plan.md](../proposals/agent-skills-ecosystem-protocol-governance-plan.md), `src/skills/loader.ts`, `src/skills/matcher.ts`, `src/skills/registry.ts`, `src/skills/validator.ts`, `src/tools/builtin/skillTool.ts`
> Governance: Targeted follow-up to the Agent Skills ecosystem compatibility proposal. This plan closes the loader/resource-indexing and matcher noise gaps surfaced by real-public-sample smoke testing. It must not weaken Agent Skills package wire format, alter `NormalizedSkill` IR, or relax permission/resource-traversal rules. It also must not promote the package to a marketplace product.
> Related: [skill-execution-and-automated-normalized-skill-generation-governance-plan.md](../reference/skill-execution-and-automated-normalized-skill-generation-governance-plan.md)

## Goal

Make BabeL-O genuinely "drop-in compatible" with public Agent Skills packages — not only the canonical three-dir layout (`scripts/`, `references/`, `assets/`) but also:

1. **Top-level companion Markdown** (e.g. `reference.md`, `forms.md`, `editing.md`, `pptxgenjs.md`) that real publishers ship next to `SKILL.md` for progressive disclosure.
2. **Non-canonical asset directories at package root** (e.g. `canvas-fonts/`, `templates/`, `schemas/`, `examples/`) that real publishers use when their resource shape is not aligned with the three spec dirs.
3. **Matcher quality** so implicit discovery is not dominated by length-biased description hits. The current matcher scores per-term hits without description-length normalization, so a 785-char description outranks a 60-char description on tangential prompts.

The end-state is: a real upstream Agent Skills package dropped into `.babel-o/skills/<id>/` produces a registry entry whose resource list and match score reflect what the publisher actually shipped, and that entry is exposed to the model with the same fidelity the publisher intended.

## Relationship To The Canonical Proposal

[agent-skills-ecosystem-protocol-governance-plan.md](../proposals/agent-skills-ecosystem-protocol-governance-plan.md) (State: Partially Landed) owns:

- Phase 0-3: legacy `.md` + `*/SKILL.md` directory load, standard field mapping, `metadata.babel-o` nested parsing, `scripts|references|assets` resource walk, symlink/realpath traversal guard.
- Phase 4: local-directory import/export preview/write paths.

This proposal does **not** duplicate those phases. It closes three concrete gaps that the canonical proposal's Phase 2 (resource index hardening) intentionally deferred:

| Gap | Where the canonical proposal parked it |
| --- | --- |
| Top-level companion `.md` outside the three spec dirs | Not addressed; Phase 2 scoped to `scripts/`, `references/`, `assets/` only |
| Non-canonical asset directories at package root | Not addressed; Phase 2 explicit whitelist |
| Matcher description-length bias | Not addressed; Phase 3 declared "description fallback" without a quality gate |

On graduation, this proposal folds into the canonical proposal as a Phase 2.x + Phase 3.x extension and is archived here.

## Reproduction (2026-07-02 real-sample smoke)

`/tmp/skills-e2e2/real-smoke.mjs` loaded four real Anthropic-published skills (`pdf`, `docx`, `pptx`, `canvas-design`) via sparse-checkout of `https://github.com/anthropics/skills`. Each is a real upstream package with the canonical `SKILL.md` layout, no `metadata.babel-o`, and no `triggers` / `allowed-tools` fields.

### Symptom 1: top-level companion Markdown is invisible

```
pdf/        LICENSE.txt, SKILL.md, forms.md, reference.md, scripts/
pptx/       LICENSE.txt, SKILL.md, editing.md, pptxgenjs.md, scripts/
```

`pdf/SKILL.md` is the 8 KB entry point. Anthropic's progressive-disclosure design pushes the *real* content into `forms.md` (12 KB) and `reference.md` (17 KB). BabeL-O's loader (`src/skills/loader.ts:206-243`) only walks `scripts/`, `references/`, `assets/` and treats all top-level `.md` files other than `SKILL.md` as opaque filesystem noise. Consequence: a model that calls `SkillShow("pdf")` gets 8 KB of body and 0 indexed companion docs, even though the publisher shipped 28 KB alongside.

### Symptom 2: non-canonical asset directories are invisible

```
canvas-design/canvas-fonts/    81 files (ArsenalSC-OFL.txt, BigShoulders-Bold.ttf, …)
```

`canvas-design` is a real Anthropic-published package whose entire resource payload lives in `canvas-fonts/`. BabeL-O surfaces `resources.length === 0` for it, which fails the import preview's `SKILL_IMPORT_NO_RESOURCES` warning and the user-visible `SkillShow` body shows zero scripts/references/assets. The package is essentially invisible to the agent beyond its `SKILL.md` body.

### Symptom 3: matcher noise from length-biased description hits

Match call: `reg.match("merge two PDF files together")`.

Returned order:

```
1. pdf-report-analyzer   (trig=[pdf,report], desc=67)
2. pdf                   (trig=[], desc=437)
3. docx                  (trig=[], desc=785)   ← noise
4. pptx                  (trig=[], desc=694)   ← noise
5. canvas-design         (trig=[], desc=289)
```

The `docx` description begins with "Use this skill whenever the user wants to create, read, edit, or manipulate Word documents. Triggers include: any mention of 'Word doc', 'word document', '.docx', or requests to produce professional documents with formatting like tables of contents, headings, page numbers, or letterheads." — Anthropic deliberately packs high-frequency keywords into the description for their own matcher. BabeL-O's per-term hit scoring (`src/skills/matcher.ts:36-44`) treats every hit equally, so `docx`'s 785-char description collects tangential hits ("PDF", "files", "produce") on unrelated prompts and outranks `canvas-design` (289-char description, semantically closer to "design a brutalist poster") on `make a poster` calls.

The 62/62 unit-test suite passes because the test fixtures are short, hand-crafted descriptions — the bug only surfaces on real-world long descriptions.

## Root Cause (source-verified)

### RC-1 — limited resource walk in `listPackageResources`

`src/skills/loader.ts:206-243` defines:

```ts
const collect = async (kind: SkillResource['kind'], dirName: string) => { … }
await collect('script', 'scripts')
await collect('reference', 'references')
await collect('asset', 'assets')
```

The hardcoded triple covers the Agent Skills spec but not real-publisher top-level companion Markdown and not real-publisher non-canonical asset directories. No allowance is made for `*.md` siblings of `SKILL.md` at the package root, and no allowance is made for `*/` directories at the package root that are not the three spec names.

### RC-2 — symmetric matcher scoring without description-length gate

`src/skills/matcher.ts:23-44` awards `+1` per description term whose 3+ character token is a substring of the prompt, summed across all description terms. Description length is unbounded; the function does not normalize by total description term count, nor does it penalize descriptions whose `description.length` exceeds some bound. Long-form descriptions — exactly what Anthropic ships — disproportionately win on noisy prompts.

### RC-3 — no quality gating on description-only matches

The matcher treats description hits as a free tier below explicit triggers, but does not require a minimum hit ratio before promoting a description match into the top-3 list. A 0.05 hit-ratio match from a 785-char description outranks a 0.5 hit-ratio match from a 60-char description.

## Proposed Changes

### Phase A — resource walk hardening (P1)

**Scope**: extend `listPackageResources()` in `src/skills/loader.ts:194-244` without weakening the existing symlink/realpath traversal guard or the `isInsidePackage(realPath)` invariant.

1. **Top-level companion Markdown**: walk the package root for direct `*.md` children that are not `SKILL.md` itself; index them as `kind: 'reference'` with `path: '<basename>.md'`. Recursion beyond top-level is intentionally out of scope to avoid runaway scanning.
2. **Top-level non-canonical asset directories**: walk any direct subdirectory of the package root that is not one of `scripts`, `references`, `assets`, `references/` (typo guard), and not a dotfile (`.git`, `.DS_Store`). Index each file inside recursively as `kind: 'asset'` with a relative path under the directory name.
3. **Resource kind inference**: keep the existing `scripts → script`, `references → reference`, `assets → asset` mapping for the three spec dirs; use `'reference'` for top-level companion `.md` and `'asset'` for non-canonical top-level dirs. The `SkillResource.kind` union widens from `'script' | 'reference' | 'asset'` to the same three values — no schema migration needed.
4. **Traversal guard**: keep `realpath` + `isInsidePackage` checks on every entry, including the new top-level walks. The `.git`, `.github`, `node_modules` directories must be skipped before any `lstat` to bound I/O on hostile packages.

**Exit criteria**:
- `pdf.resources` includes `reference.md` and `forms.md` as `kind: 'reference'`.
- `canvas-design.resources` includes all 81 `canvas-fonts/*` entries as `kind: 'asset'`.
- `loader.ts:listPackageResources()` exposes a unit test that asserts a hostile package with `packageRoot/../../../etc/passwd` symlink is still rejected (`isInsidePackage` still gates).
- `loader.ts:listPackageResources()` exposes a unit test that asserts `.git/HEAD` and `node_modules/` are skipped.

### Phase B — matcher quality gate (P1)

**Scope**: extend `matchSkills()` in `src/skills/matcher.ts` to neutralize description-length bias without changing the trigger > description > name/id priority order.

1. **Description length cap**: when a description match is the only signal (no trigger hit), compute `hitRatio = hits / descriptionTermCount`. If `hitRatio < 0.05` for descriptions ≥ 200 chars, demote the score to a fraction of its current value (e.g. multiply by `0.25`). Short descriptions (< 200 chars) keep the existing per-term-hit scoring.
2. **Description length penalty**: apply a `lengthPenalty = max(0.5, 200 / description.length)` so a 1000-char description cannot out-score a 100-char description on tangential hits even if both reach the same hit ratio.
3. **Description-only minimum hit floor**: drop description-only matches whose absolute hit count is below a small floor (e.g. 2 hits) before the trigger tier. This is a per-prompt floor, not a per-skill floor, and prevents single-substring-coincidence matches from polluting the top-3.
4. **Precedence preserved**: explicit trigger hits always outrank description hits. Name/id hits always rank below description hits. The new penalties only affect ordering *within* the description tier.

**Exit criteria**:
- `matchSkills` exposes a regression test that asserts `match("merge two PDF files together")` does not return `docx` in the top-3 when no trigger is present.
- `matchSkills` exposes a regression test that asserts explicit triggers always outrank description hits regardless of description length.
- Existing `matchSkills` tests in `test/skills.test.ts` continue to pass with the new scoring (penalty values chosen so the existing fixture scores are monotonically equivalent).

### Phase C — `SkillShow` progressive disclosure (P2)

**Scope**: extend `SkillShow` tool output and `formatSkill()` formatter so the model can opt into companion resources without re-walking the registry.

1. `SkillShow` output grows an optional `companionReferences: SkillResource[]` array that is the union of `kind: 'reference'` resources, **sorted by path** for determinism. Same for `companionAssets: SkillResource[]`.
2. `formatSkill()` renders companion references under a new `## Companion Resources` heading and companion assets under `## Companion Assets`. Both sections list relative paths and a short kind tag.
3. The model-visible `prompt()` for `SkillShow` grows a one-line hint: "If the body is short, check `companionReferences` and `companionAssets` for progressive-disclosure follow-up docs the publisher shipped next to SKILL.md."

**Exit criteria**:
- `SkillShow('pdf')` returns `companionReferences.length === 2` (`forms.md`, `reference.md`).
- `SkillShow('canvas-design')` returns `companionAssets.length === 81`.
- `formatSkill('canvas-design')` body contains a `## Companion Assets` heading with at least one entry per asset kind.

## Security Rules (unchanged)

- External packages remain untrusted by default.
- `scripts/` are data until a future permission-gated execution path exists; this plan does not change that.
- New top-level resource walks re-use the existing `realpath` + `isInsidePackage` invariant and the symlink skip at `src/skills/loader.ts:217-229`.
- `.git`, `.github`, `node_modules`, hidden directories (`.*`) are skipped by name before any `lstat` to bound I/O on hostile packages.
- `allowed-tools` remains advisory only.
- No script execution path opens in this plan.

## Phases

| Phase | Status | Scope | Exit criteria |
| --- | --- | --- | --- |
| Phase A | Draft | Resource walk hardening: top-level companion `.md` and top-level non-canonical asset dirs. | Real Anthropic sample exposes companion refs/assets; traversal guard test still rejects symlink escape; `.git` / `node_modules` skipped. |
| Phase B | Draft | Matcher quality gate: description-length cap, length penalty, description-only hit floor. | Real-prompt noise regression test prevents `docx` from appearing on `merge PDF`; explicit-trigger precedence preserved; existing tests monotonic. |
| Phase C | Draft | `SkillShow` progressive disclosure surface for companion resources. | `companionReferences` / `companionAssets` surfaced in tool output and rendered by `formatSkill`. |

## Verification

```bash
NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-skill-quality.json BABEL_O_USER_SKILLS_DIR=/tmp/babel-o-skill-quality-user npx tsx --test --test-concurrency=1 \
  test/skills.test.ts \
  test/skill-registry.test.ts \
  test/skill-tools.test.ts \
  test/skill-routes.test.ts \
  test/skill-schema.test.ts
npm run typecheck
npm run format:check
npm run docs:check
```

End-to-end smoke after Phase A:

```bash
# Real Anthropic samples at /tmp/skills-e2e2/.babel-o/skills/{pdf,docx,pptx,canvas-design}
node -e "
import('/Users/tangyaoyue/DEV/BABEL/BabeL-O/dist/skills/registry.js').then(async m => {
  const reg = await m.loadSkillRegistry({ cwd: '/tmp/skills-e2e2', builtInDir: '/Users/tangyaoyue/DEV/BABEL/BabeL-O/src/skills/built-in' })
  for (const id of ['pdf', 'canvas-design']) {
    const s = reg.get(id)
    console.log(id, 'resources:', s.resources.length, 'kinds:', [...new Set(s.resources.map(r => r.kind))])
  }
})
"
```

Expected after Phase A:

- `pdf` resources include `forms.md`, `reference.md` (kind `reference`).
- `canvas-design` resources include all 81 `canvas-fonts/*` entries (kind `asset`).

## Out Of Scope

- **Phase 5 `skills.lock.json`** remains the canonical proposal's Phase 5 (origin / revision / sha256 / installedAt). This plan does not introduce a lockfile.
- **Phase 6 marketplace metadata** remains the canonical proposal's Phase 6. This plan does not introduce a registry service.
- **Phase 7 Go TUI `/skill` UX** remains the canonical proposal's Phase 7. This plan does not add CLI commands.
- **Phase 4 zip/git import sources** remain the canonical proposal's residual Phase 4. This plan does not unzip or clone.
- **Matcher tokenization changes** (e.g. CJK tokenization, stopword lists) are not part of this plan; the matcher already has a basic `[\u4e00-\u9fff]` block. Further tokenization tuning belongs in a separate proposal.

## Graduation Plan

When all three phases close and verification passes:

1. Move this file to `../archive/` and replace with a one-paragraph summary that points to the canonical proposal's amended Phase 2.x / Phase 3.x sections.
2. Update `agent-skills-ecosystem-protocol-governance-plan.md` so its Phase 2 table includes the new top-level companion / non-canonical asset row, and its Phase 3 table includes the new length-penalty row.
3. Add a row to [../DONE.md](../DONE.md) with the implementation commit hash, the verification commands actually run, and the real-sample smoke output (`pdf` resources count, `canvas-design` resources count, matcher-noise regression test status).
4. Update [../reference/agent-session-skill-governance-index.md](../reference/agent-session-skill-governance-index.md) if the open-watch-item for "Agent Skills ecosystem compatibility" can move from Partially landed to Landed.

## 中文概述

### 背景

BabeL-O 已经按 Agent Skills 协议加载 Anthropic 公开仓库里的 `pdf` / `docx` / `pptx` / `canvas-design` 四个真实 skill，全部通过 `loadSkillRegistry` + 验证 + 匹配 + 导入导出往返。但发现三类生态真实世界缺陷：

1. **顶层 companion `.md` 看不见**：`pdf/forms.md` (12K)、`pdf/reference.md` (17K) 等 28 KB 真实二级披露文档不被索引，模型只能拿到 8 KB 的入口。
2. **非标资源目录看不见**：`canvas-design/canvas-fonts/` 81 个字体文件全部丢失，import 预览报 `SKILL_IMPORT_NO_RESOURCES`。
3. **匹配器 description 长度偏置**：`docx` 785 字符的 description 在 `merge two PDF files together` 上噪声命中。

### 决策

继承 [agent-skills-ecosystem-protocol-governance-plan.md](../proposals/agent-skills-ecosystem-protocol-governance-plan.md) 的 Phase 0-4，不重起炉。补 3 个 Phase（A 资源加固、B 匹配器质量、C SkillShow 渐进披露）。

### 落地

- Phase A 把 `listPackageResources` 扩展到顶层 `.md` + 顶层非标目录，保留 `realpath` 防逃逸和 symlink 跳过。
- Phase B 给 description 加长度归一化和最小命中下界，trigger 优先级不变。
- Phase C `SkillShow` 输出 `companionReferences` / `companionAssets`，让模型能 progressive disclosure。

### 收尾

三 Phase 全部落地且真实样本 smoke 通过后，本提案归档到 `../archive/`，更新主提案的 Phase 2/3 表格，并更新 [../reference/agent-session-skill-governance-index.md](../reference/agent-session-skill-governance-index.md) 中"Agent Skills ecosystem compatibility"行从 Partially landed 升为 Landed。
