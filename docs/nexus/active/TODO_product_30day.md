# TODO Product / UX 30-Day Lift

> **范围**:产品视角(不是开发视角)的 30 天可执行改造清单。
> **方法**:从真实用户路径反推,按 ROI 排序,只动 README / docs / 错误文案 / 安装链路 / 凭证管理 / examples 这些"产品表层"的东西,**不**触碰 Nexus / runtime / provider / agent loop。
> **节奏**:4 周,每周一个主题;每条都是 1-2 人天可交付的、能在 PR 里 review 完的。
> **完成口径**:每条任务都有"判定可验收的产物",无产物则视为未做。

## 目标

把 BabeL-O 从"硬核开发者愿意读 600KB WORK_LOG 才能上手"提升到"路人 5 分钟能看到价值、30 分钟能跑通第一个真实任务"。**不动后端**。

## 当前状态(为什么需要这份清单)

- 工程成熟度第一梯队,但**产品语言停留在"如果你懂,你就会知道它好"**。
- 差异化是真实的(worktree 治理 / 多前端 / 跨 session 上下文 / Go runner / 10MB 客户端),但**全部埋在技术名词里**。
- 用户痛点集中在 7 个表层:安装门槛、首次配置、wow moment 缺失、错误体验、CLI/GUI 切换路径模糊、版本故事断裂、零 web 触点。
- 单点维护者、零 community、零商业模式——**不补用户增长,差异化也是遗产**。

## 优先级总览

| 周次 | 主题 | 关键交付 | 对应痛点 |
| --- | --- | --- | --- |
| W1 | Make It Visible | 首页 gif / 5 分钟快速开始 / 价值段 | 痛点 3 |
| W2 | Make It Trustworthy | 系统 keychain 接入 / friendly 错误统一 / 安装三选一指引 | 痛点 1, 2, 4 |
| W3 | Make It Discoverable | docs site / demo video / examples 目录 | 痛点 7 |
| W4 | Make It Sustainable | CONTRIBUTING / Discussions / 社区入口 / bus factor 治理 | 痛点 5, 6, 风险 |

---

## W1 — Make It Visible(可见性)

> **判定**:路人在 GitHub 仓库首页停留 30 秒后,**能说出一句"BabeL-O 跟 Claude Code 有什么不一样"**。

### W1.1 README 顶部价值段重写[P0]
- **现状**:`## What is BabeL-O?` 段 80% 是技术叙事,0 个"用户能拿来做什么"。
- **改动**:
  - 在 `What is BabeL-O?` 之前新增 `## Why BabeL-O?` 段,**3 个 bullet**,每个 bullet 一句话人话 + 一句技术对照。
  - 推荐措辞方向(待维护者审定):
    - "**同时开多个 session 在不同 worktree 干活**——后台 daemon 持有状态,客户端可以掉线、可以换,任务不会丢。"
    - "**10MB 单文件二进制客户端**——`bbl` 是 Node daemon,`bbl go` 是 Go TUI,后者 ~10MB 无 Node 依赖,丢到容器里就能跑。"
    - "**真正能完成长任务**——context compaction、tool loop 边界、权限治理、sub-agent 协作,不是 demo 级玩具。"
- **不**做的事:不删原 `What is BabeL-O?` 段,只是把价值段前置。
- **产物**:`README.md` + `README.zh-CN.md` 同步改完,PR review 通过。
- **收口**:路人测试 5 个非维护者用户,4 个能在 30 秒内复述 3 个 bullet 之一。

### W1.2 README 5 分钟快速开始[P0]
- **现状**:"CLI Usage Guide" 第一行 `bbl go` 然后呢?没有"我从这复制粘贴 5 行,就能看到效果"。
- **改动**:
  - 新增 `## Quick Start (5 minutes)` 段,**只有一种推荐路径**(npm/pnpm global install),不再展示 3 种安装方法并列。
  - 内容:`npm i -g babel-o` → `bbl init my-app` → `bbl go` → 跑一个内置 demo prompt(如 "explain this repo's entry point")。
  - 顶部加 ⚠️ 框:"如果你的 Node < 22,先升级;详细安装备选见 `docs/INSTALLATION.md`。"
- **产物**:`README.md` 中英双版 + 新文件 `docs/INSTALLATION.md`(把当前 3 种安装方法从 README 搬过去,作为兜底)。
- **收口**:`bbl init` 命令可被零基础用户复现到第一次成功提示。

### W1.3 首页 demo gif / 截图[P0]
- **现状**:`docs/assets/` 只有两个 logo,0 张产品截图。
- **改动**:
  - 录 30-45 秒的 `bbl go` 跑通"读本地文件 + 改 + 跑测试"全流程屏录,转 gif(目标 < 8MB),放 README 顶部。
  - 录同样流程的 `bbl go` 版,放 README 末"Want a lighter client? Try `bbl go`"段。
  - gif 上加 3 行字幕标注关键步骤,不要裸屏录。
- **产物**:`docs/assets/quickstart-bbl-chat.gif` + `docs/assets/quickstart-bbl-go.gif`,README 引用。
- **收口**:gif 在 GitHub 移动端可加载、桌面端 < 2s 出现。

### W1.4 "Try this prompt" 示例库[P1]
- **现状**:没有"试试这个 prompt"的快速例子。
- **改动**:
  - README 新增 `## Try these prompts` 段,3-5 个真实可跑的 prompt,覆盖差异化场景:
    - "在 `/tmp/demo` 里建一个 Python 项目,跑通 pytest,提交到新 branch。"
    - "同时启动 3 个 worktree,分别修 `TODO_runtime.md` 里的 P0 项,完成后合并回 main。"
    - "用 `bbl go` 客户端连远程 Nexus,跑一个长任务,断网 30 秒,恢复后看任务续传。"
  - 每个 prompt 附"预期输出"截图或文字描述。
- **产物**:README 中英双版同步。
- **收口**:5 个 prompt 全部能在干净环境跑通(走 CI 冒烟)。

---

## W2 — Make It Trustworthy(可信度)

> **判定**:首次用户从安装到第一次成功,**不需要碰任何 JSON 配置文件、不需要 export 环境变量**;遇到任何错误,**看到的是人话不是 JSON**。

### W2.1 系统 keychain 接入 API key[P0]
- **现状**:API key 直接落盘 `~/.babel-o/config.json`,**和 OpenAI / Anthropic 凭据管理常识冲突**;企业用户 100% 被安全团队拦下。
- **改动**:
  - 新增 `src/cli/secrets/` 模块,提供 `getSecret(provider) / setSecret(provider, key) / deleteSecret(provider)`,按平台走:
    - macOS:Keychain(`security add-generic-password`)
    - Windows:Windows Credential Manager(`wincred` npm 包)
    - Linux:Secret Service(`secret-service` / `libsecret`)
  - `bbl config set <provider>.apiKey <key>` 默认写 keychain,不写明文配置文件;只在显式 `--plain` flag 下才写盘。
  - 老用户迁移:启动时检测到明文 apiKey,提示并提供 `bbl config migrate` 一键迁移到 keychain。
  - CLI fallback:无 GUI 环境的容器/CI,自动降级到 `BABEL_O_<PROVIDER>_API_KEY` 环境变量,且**只读、不写盘**。
- **不**做的事:不引入完整 OAuth flow(留作 W5+),只做 keychain;不破坏现有 `BABEL_O_CONFIG_FILE` 路径。
- **产物**:`src/cli/secrets/` 模块 + 平台分支 + 老用户迁移命令 + `test/secrets.test.ts` 跨平台冒烟 + README `docs/INSTALLATION.md` 更新。
- **收口**:在 macOS / Ubuntu(GUI)/ Ubuntu(无 GUI)/ Windows 四个环境全部通过冒烟;`bbl config audit` 命令能列出"3 个 keychain,2 个环境变量,0 个明文落盘"。

### W2.2 错误文案统一 friendly 化[P0]
- **现状**:`friendlyNexusErrorWithContext()` 在 Go TUI 已实现(见 `active/TODO_tui.md`),但 **TypeScript TUI 和 Nexus REST 错误响应都没接**;用户看到的是 raw JSON + error code。
- **改动**:
  - 把 friendly 化下推到 Nexus 错误响应层:`src/nexus/errorResponse.ts` 新增 `humanizeError(err): { code, message, hint, docsUrl }`,所有 `app.errorHandler` 出口统一走它。
  - TypeScript TUI 的事件渲染管线消费 `hint / docsUrl` 字段,在错误气泡下加灰字 hint + "Learn more" 链接(链到 `docs/troubleshooting/<code>.md`)。
  - Go TUI 已有的 `friendlyNexusErrorWithContext` 重构成消费 Nexus 响应的 `hint` 字段,**不**自己重写人话,避免双源漂移。
- **产物**:`src/nexus/errorResponse.ts` + 双 TUI 接入 + `docs/troubleshooting/` 目录(至少覆盖:REQUEST_TIMEOUT / CONTEXT_BLOCKING / PROVIDER_AUTH_FAILED / WORKTREE_CONFLICT / TOOL_RESULT_BUDGET_EXCEEDED)。
- **收口**:录 5 个真实错误场景的 30s 屏录对比 before/after,放 `docs/troubleshooting/`。

### W2.3 安装三选一指引降级[P1]
- **现状**:README 顶部并排 3 种安装方法(Installer / Source / Clone),用户不知道该选哪个。
- **改动**(承接 W1.2):
  - README 只留 npm global 作为默认;`docs/INSTALLATION.md` 列全部 3 种,**带场景描述**:
    - "大多数用户 → npm"
    - "想跑最新 commit → Source"
    - "要贡献代码 → Clone"
  - **撤掉** `curl | bash` 这种企业拦截项,改造成"下载 binary → 校验 SHA256 → 移动到 PATH"3 步,带 SHA256 验证命令。
- **产物**:`docs/INSTALLATION.md` + README 简化。
- **收口**:新用户问卷 10 人,8 个能正确说出"我应该用哪个"。

### W2.4 `bbl init` 引导式初始化[P0]
- **现状**:用户需要手工建 `~/.babel-o/config.json`、手工选 provider、手工填 key。
- **改动**:
  - 新增 `bbl init` 命令,首次运行进入交互式 wizard(在 TTY 下才触发,CI 走 `--non-interactive`):
    1. 选 provider(下拉,带"我还没有 API key" 选项 → 跳到对应申请页)。
    2. 输 key(直接写 keychain,见 W2.1)。
    3. 选 default model(根据 provider 动态拉可用列表)。
    4. 选 working dir(默认 cwd,可改)。
    5. 写一条 smoke prompt 自检(如 "echo hello from babel-o")。
  - 全部走现有 CLI 交互,不需要新 UI。
  - `--non-interactive --provider anthropic --model claude-3-5-sonnet-latest` 走 CI/脚本。
- **产物**:`src/cli/commands/init.ts` + wizard 模块 + `test/init.test.ts` + README Quick Start 段引用。
- **收口**:`bbl init` 在 4 个平台零配置跑通;非交互模式 0 提问直接完成。

---

## W3 — Make It Discoverable(可发现性)

> **判定**:**有人在 Google 搜 "AI agent worktree governance" 能搜到 BabeL-O 的页面**;**有人在 YouTube 搜 "BabeL-O vs Claude Code" 能找到对比视频**。

### W3.1 docs site 上线[P0]
- **现状**:`docs/` 全部 markdown,在 GitHub 渲染;**没有公网落地页、没有 SEO、没有品牌化体验**。
- **改动**:
  - 选 VitePress(轻、Vue 生态、MD 原生支持、自动侧栏/搜索/暗色主题)或 Docusaurus。
  - 部署到 GitHub Pages / Cloudflare Pages,域名用 `babel-o.dev` 或 `babelo.dev`(维护者自定)。
  - 内容直接消费 `docs/`(迁移成本低),**不改写**,只配置 `docs/.vitepress/config.ts`。
  - 必须有的页面:首页 / Quick Start / Why BabeL-O / Features / Comparison / FAQ / Changelog 聚合。
- **产物**:`docs-site/` 子目录(或独立 `site/` repo)+ CI 自动部署 + 域名指向。
- **收口**:`site:babel-o.dev` 在 Google 能搜到首页 + Quick Start + 至少 3 个 feature 页。

### W3.2 demo 视频(对比视角)[P0]
- **现状**:0 个视频;**BabeL-O 跟 Claude Code / Aider 的差异化在视频里看才明显**。
- **改动**:
  - 录 5-7 分钟主视频:"BabeL-O vs Claude Code:5 个差异化场景"——同 prompt 同任务,左 BabeL-O 右 Claude Code,字幕标差异点。
  - 必含场景:
    1. 多 session 跨 worktree 并行(差异化最强)。
    2. `bbl go` 10MB 客户端冷启动(< 200ms)。
    3. 跨 session 上下文共享(SessionChannel)。
    4. 后台 daemon 不掉线(关掉 TUI 重连,任务续传)。
    5. Go runner 远程执行。
  - 上 YouTube + B 站(中英双语),README + docs site + Twitter/X 同步。
- **产物**:1 个主视频 + 1 个 60s 短视频(用于社交媒体)+ README 嵌入。
- **收口**:视频 7 天内 YouTube 播放 > 200,留资 > 20。

### W3.3 `examples/` 目录[P0]
- **现状**:`examples/` 目录不存在;**用户没有"复现即跑通"的入口**。
- **改动**:
  - 新建 `examples/` 根目录,5 个独立子项目,每个自带 README + 复现命令:
    - `examples/01-monorepo-fix/`:在 monorepo 里修一个真实 lint 错误,看多 file 工具循环。
    - `examples/02-worktree-parallel/`:同时开 3 个 worktree 改 3 个文件,演示 worktree 治理。
    - `examples/03-long-task-resume/`:启动一个 30 分钟的 migration 任务,中途断网,看 SessionChannel 续传。
    - `examples/04-go-tui-remote/`:在远端机跑 Nexus,本地用 `bbl go` 连,演示 10MB 客户端。
    - `examples/05-evercore-memory/`:跨 session 长期记忆演示(如果 EverCore 还没 GA 就先占位)。
  - 每个 example 的 README 必须有"5 分钟复现步骤"段。
- **产物**:`examples/` 目录 + 5 个子项目 + 顶层 `examples/README.md` 索引。
- **收口**:CI 加 `examples-smoke` job,5 个 example 全部跑通(用 mock provider)。

### W3.4 README 视觉资产补全[P1]
- **现状**:docs/assets/ 只有 logo。
- **改动**:
  - 加架构图(Nexus <-> TUI <-> Runtime 关系),用 mermaid 渲染,README + docs site 都能用。
  - 加 "client 矩阵" 图:TS TUI / Go TUI / (未来)Web 三列,各列能力对比。
  - 加 provider 支持矩阵图标(Anthropic / OpenAI / Google / Mistral / DeepSeek / xAI / Ollama)。
- **产物**:`docs/assets/architecture.svg` + `docs/assets/client-matrix.svg` + `docs/assets/providers.svg` + README 引用。
- **收口**:3 张图在 README 暗色/亮色下都清晰。

---

## W4 — Make It Sustainable(可持续性)

> **判定**:**有 1 个非维护者提交了第一个 PR 并被 merge**;**GitHub Discussions 出现 5 个真实用户问题并被回答**。

### W4.1 CONTRIBUTING.md + 治理文档[P0] ✅ 部分收口（2026-06-18）
- **现状**:贡献者没有任何引导;`AGENTS.md` 是给 AI agent 看的(且维护者专属)。2026-06-18 已补 contributor-facing 入口，首个外部 PR merge 仍待真实社区验证。
- **改动**:
  - 新增 `CONTRIBUTING.md`,覆盖:
    - 仓库布局 + 模块边界(把 `docs/nexus/README.md` 摘要搬过去)。
    - 本地开发流程(`npm i` / `npm test` / `npm run smoke` / `npm run build`)。
    - PR 模板(checklist:测试 / changelog / 文档同步 / 行为不破坏 `bbl go` 默认路径)。
    - Issue 模板(bug / feature / docs / question 四种)。
    - 决策机制(谁来 merge / 什么是 RFC / 怎么升级 Phase)。
  - 新增 `GOVERNANCE.md`(简短):维护者名单 + 决策权 + bus factor 当前值(诚实标注) + 招募 maintainer 的明确渠道。
  - 同步 `AGENTS.md` 加 "AI agent 提交前先读 CONTRIBUTING.md" 的引用。
- **产物**:`CONTRIBUTING.md` + `GOVERNANCE.md` + `.github/ISSUE_TEMPLATE/` + `.github/PULL_REQUEST_TEMPLATE.md` 已落地；`AGENTS.md` 已引用 contributor-facing 文档；README / README.zh-CN 顶部已补贡献与 Discussions 徽章。
- **收口**:文档产物已完成；最终产品收口仍需首个外部 PR 按 checklist 走完并被 merge。

### W4.2 GitHub Discussions 启用 + 社区入口[P0]
- **现状**:社区入口 0;用户问题全部塞进 issue,污染 bug tracker。2026-06-18 已补 README/GOVERNANCE 入口和 owner 手动启用清单，GitHub Settings 开关仍需仓库 owner 执行。
- **改动**:
  - GitHub 仓库 Settings → 启用 Discussions,预置 4 个 category:Q&A / Show and tell / Ideas / General（操作清单见 [github-discussions-setup-guide.md](../reference/github-discussions-setup-guide.md)）。
  - README 顶部加 Discussion 徽章和链接,中英双版。
  - 维护者承诺:每个工作日回复一次 Discussions(写在 GOVERNANCE.md)。
  - 短期:**不**做 Discord/Slack(单点维护者维护不过来),只做 GitHub Discussions。
- **产物**:README / README.zh-CN 链接 + GOVERNANCE.md 承诺 + [github-discussions-setup-guide.md](../reference/github-discussions-setup-guide.md) 已落地；Discussions 启用仍需 owner 在 GitHub Settings 执行。
- **收口**:启用 30 天内,至少 5 个真实用户问题被回答。

### W4.3 版本故事聚合 + 升级引导[P1]
- **现状**:`docs/releases/v0.X.Y.md` 是单文件,GitHub Releases 和 docs/releases 关系没说;用户不知道该不该升。
- **改动**:
  - 新增 `docs/releases/README.md`(已存在,需重写),作为 changelog 聚合页:按版本倒序,每版"3 个 bullet 写给人看 + 1 个升级必读 + 1 个破坏性变更(如有)"。
  - GitHub Releases 发布时强制引用对应的 `docs/releases/vX.Y.Z.md`,避免双源漂移。
  - `bbl` 启动时检测到版本升级 ≥ minor,显示 1 行 "what's new" 提示,链到对应 release notes。
  - 加 `bbl changelog [from..to]` 子命令。
- **产物**:`docs/releases/README.md` 重写 + `bbl` 启动 banner + `bbl changelog` 命令 + release 流程文档化。
- **收口**:连续 2 个 minor 版本升级引导有数据(看 banner 展示 → release notes 点击率)。

### W4.4 `bbl go` 客户端指南[P1]

> v0.3.7 已移除旧 TS TUI `bbl chat`，`bbl go` 为唯一生产交互入口；原"`bbl chat` vs `bbl go` 选型"已无意义，本节改为单一客户端指南。
- **现状**:`PHASE_9_DECISION` 是给开发者读的决策记录,用户不知道该用哪个。
- **改动**:
  - 新增 `docs/CLIENTS.md`,给用户讲人话:`bbl go`(Go TUI,portable 包复用系统 Node >= 22)是唯一生产交互入口,`bbl run` 用于一次性自动化;未来终端外使用关注 roadmap。
  - 表格说明:启动方式 / 内存占用 / 功能完整度 / 平台 / 安装方式(portable 包 + npm global + 源码)。
  - `bbl go --help` description 改成 "Launch the Go TUI client (production interactive entrypoint; run `bbl docs clients` for guidance)",并真的接入 `bbl docs` 子命令(可列出 `docs/*.md` 的精简目录)。
- **产物**:`docs/CLIENTS.md` + `bbl docs` 子命令 + `bbl go --help` 文案更新 + Phase 9 decision 已落地的 action item 收口。
- **收口**:路人问卷"你刚装好,会选哪个",8/10 答对。

---

## 不在本期范围(显式不做)

> 把这些写下来,避免 PR 期间 scope creep。

- ❌ **不做 web UI**——Phase 9 决策刚稳定 Go TUI,再开新战线是灾难;docs site 是阅读,不是应用。
- ❌ **不做云 SaaS / 多用户 / 团队协作**——单点维护者做云是过载,差异化也不在 SaaS。
- ❌ **不重写 CLI parser / 不重做 TUI 框架**——技术债最低的部分,先做用户增长。
- ❌ **不动 Nexus / runtime / provider / agent loop / scheduler**——后端正在 Phase 9-10 收敛,产品层叠加风险大于收益。
- ❌ **不做完整 OAuth flow**——留作 W5+;W2.1 的 keychain 已覆盖 80% 体验。
- ❌ **不引入 Discord / Slack**——单点维护者维护不过来,GitHub Discussions 够用。
- ❌ **不做 paid tier / 商业化**——先验证用户增长,商业化在 > 1000 MAU 后再说。

---

## 风险与回滚

| 风险 | 触发条件 | 回滚 |
| --- | --- | --- |
| W2.1 keychain 在某个 Linux 发行版崩溃 | `secret-service` 包依赖 libsecret 不在 base image | 降级到"env-var-only 提示",跳过 keychain,不阻塞启动 |
| W3.1 docs site 域名/部署链路 | 域名 ICP / 部署配置拖延 | 先部署到 `*.github.io/babel-o`,域名后置 |
| W4.2 Discussions 启用后无人维护 | 30 天内 0 个外部问题 | 改回 issue-only,但保留 Q&A 标签机制 |
| W2.4 `bbl init` wizard 跟现有 readline 冲突 | 在窄终端 / 非 TTY 行为异常 | 维持 `bbl config set` 旧命令,wizard 作为推荐路径而非唯一路径 |

---

## 收口与交付物

- 每周末维护者过一次本文件,把已完成条目标 `[x]` 并把"产物"链接补到对应行;未完成条目迁入下一周或归档到本文件末尾的"Backlog"段。
- 4 周结束后整体回顾:README 顶部转化率、demo 视频播放量、Discussions 活跃度、外部 PR 数量,4 个指标任一没动就说明产品层还没穿透,继续 W5+。
- 本文件不替代 [TODO.md](../TODO.md) 的优先级表;W1 / W2 主线应在 [TODO.md](../TODO.md) 里挂 P0 入口链接,本文件作为详情落地页。

## Backlog(W5+ 候选,本期不启动)

- 完整 OAuth flow(至少 Anthropic / OpenAI 走浏览器回调)。
- 国际化扩展:日文 / 韩文 README。
- 用户案例采集(征集 5 个真实用户使用故事,放 docs site)。
- 性能预算与 telemetry opt-in(`bbl stats` 命令,本地 only,默认关闭)。
- 招募 1-2 名 co-maintainer,降低 bus factor 到 ≥ 2。
- `bbl doctor` 命令(自检:Node 版本 / 端口占用 / keychain 可达 / provider 连通性 / 工作目录权限)。
