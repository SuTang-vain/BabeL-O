# TODO Cleanup / Decoupling

## 目标

BabeL-O 采用全新设计的干净架构，不应无选择地搬运 BabeL-X 的历史复杂度。Cleanup 的重点不是“删旧代码”，而是守住依赖边界、发布工程化和 BabeL-X 参考迁入纪律。已完成的重构能力见 [DONE.md](../DONE.md)。

## 当前状态

- 项目没有引入 BabeL-X 源码树、React/Ink runtime、Bun/Elysia、Anthropic 私有包或 telemetry/cloud service 依赖。
- Runtime 去重、结构化 logger、`docs/nexus` 文档中心、Hooks 最小内核、PromptInput 状态分层、多级 permission panel、Compact UX、MCP stdio client、Skill loader、Agent lifecycle metadata 等第一轮迁入/设计重构已完成。
- Dependency boundary audit、生产构建与 build smoke 已落地：`npm run deps:audit` 输出 direct dependency ownership、runtime reachable dependency report、CLI imports 和 failure diagnostics；`npm run build:smoke` 会 build `dist/` 并覆盖 `bbl --help`、`bbl chat --help`、`bbl run hello`。
- Check-only format/lint、GitHub Actions workflow 与 coverage report 已落地：`npm run format:check` 只检查不改写文件，`npm run lint` 串联 typecheck/format/deps audit，`npm run coverage` 产出 `coverage/coverage-summary.json` 且暂不设置硬阈值。
- BabeL-X compatibility strategy 已收口：BabeL-O 默认不读取 `~/.babel/config.json`，只提供显式一次性 `bbl config import-babel-x` dry-run/apply 入口；旧 transcript 不导入，Nexus session schema 不接纳 BabeL-X 历史 schema。
- 当前 cleanup 剩余项为 P2 后续迁入门禁。

## 已收口 Package Boundary

Dependency boundary audit 已接入 `npm run deps:audit`，详见 [DONE.md](../DONE.md) 与 [WORK_LOG.md](../WORK_LOG.md)。

这些规则已由 `scripts/audit-dependency-boundary.js` 与 `npm run deps:audit` 守门：新增依赖必须有 runtime / cli / dev / optional-ui 归属，runtime core 不允许依赖 terminal UI、desktop/browser/mobile integration，provider adapter 不允许把 provider-specific event shape 泄漏到 Nexus API。

## 已收口 Production Build

Production build 与 build smoke 已接入 `npm run build:smoke`：`npm run build` 产出 `dist/`，`bin/bbl.js` 在 `dist/cli/program.js` 存在时走生产 JS，不再经 `tsx` 启动；smoke 覆盖 `bbl --help`、`bbl run "hello"`、`bbl chat --help`。

## 已收口 Lint / Format / CI

Check-only format/lint、GitHub Actions workflow 与 coverage report 已接入，详见 [DONE.md](../DONE.md) 与 [WORK_LOG.md](../WORK_LOG.md)。当前 coverage 只产出报告，不设置硬阈值。

## 已收口 BabeL-X Compatibility Strategy

BabeL-X compatibility strategy 已收口：默认不自动读取 BabeL-X `~/.babel/config.json`；如需迁移配置，必须显式运行一次性 `bbl config import-babel-x --source <path>`，默认 dry-run 且输出只显示 profile/provider/model 与 hasApiKey/hasBaseUrl，不打印 secret；`--apply` 只把可映射 provider profile 合并写入 BabeL-O config。BabeL-X transcript import 当前不支持，Nexus runtime/session schema 不接纳旧 transcript schema。

## P2 Future Migration Gate

后续从 BabeL-X 迁入能力时必须遵守以下常驻门禁；这些是规则，不作为待办 checkbox 统计：

- 先定义 Nexus-owned interface。
- 再写 adapter。
- 最后迁移实现。
- 优先“设计重构”，不直接复制 giant file。
- 不复制 feature flag dead code、cloud service stub、analytics/GrowthBook、React/Ink runtime 组件。
- 不迁移复杂 plugin system；优先通过 MCP 扩展能力。
- 所有迁入能力必须先写 TODO/接口/测试计划，再实现。

## P2 Optional Go Runner Build Boundary

Go Runner 可以作为可选执行后端进入 `runners/go-runner/`，但不能改变 BabeL-O 的 TypeScript Nexus-first 主架构；以下为常驻 build boundary，不作为待办 checkbox 统计：

- Go 代码放在独立 subtree。
  - 建议路径：`runners/go-runner/`。
  - TypeScript runtime 只通过 `RemoteToolRunner` HTTP/JSON 协议依赖它，不从 runtime core 直接 import/exec Go 内部实现。
- 默认 Node/TypeScript 开发流不依赖 Go。
  - 默认 `npm test`、`npm run typecheck`、`npm run build:smoke` 不要求 Go binary。
  - Go smoke 使用显式 env gate，例如 `BABEL_O_RUN_GO_RUNNER_SMOKE=1`。
- 初期优先 build-from-source，不急于发布 npm optional package。
  - 等协议、Read/Grep/Glob、restricted Bash 与安全默认值稳定后，再评估预构建 binary、平台矩阵和 release packaging。
- Go Runner 不能引入新的架构所有权。
  - 不拥有 session storage、provider credentials、permission audit、AgentScheduler、Context Manager 或 CLI/TUI。
  - 任何 Bash/Write/Edit 能力都必须先在 TODO_runtime / TODO_agents 中完成权限、安全、测试计划登记。

## P2 仍可参考但未迁入的 BabeL-X 能力

| BabeL-X 能力 | BabeL-O 方向 | 当前口径 |
| --- | --- | --- |
| QueryEngine 高阶 tool loop | Runtime pipeline / tool loop | 暂不搬迁，先完成 `LocalCodingRuntime` pipeline 化。 |
| Session transcript import | 一次性导入工具 | 等配置兼容策略确定后再做。 |
| LSPTool | MCP LSP server 或轻量 context picker | 排在 TUI P2。 |
| fork subagent / prompt cache | 子 Agent transcript + worktree 稳定后评估 | 暂不迁入复杂优化路径。 |
| remote/team/swarm agent | SDK/dashboard + remote runner protocol | 暂不迁入；Go Runner 只作为单 runner 执行后端，不作为 remote/team/swarm agent 基础设施。 |

## 验证命令

历史验证覆盖：`npm run typecheck`、`npm test`、`npm run deps:audit`、`npm run build:smoke`、`npm run format:check`、`npm run lint`、`.github/workflows/ci.yml` 和 `npm run coverage`。后续 BabeL-X 能力迁入必须同时补接口/测试计划和 dependency boundary audit。

## 参考文件

- `package.json`
- `docs/nexus/README.md`
- `docs/nexus/TODO.md`
- `src/runtime`
- `src/nexus`
- `src/cli`
