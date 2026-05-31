# TODO Cleanup / Decoupling

## 目标

BabeL-O 是 clean rewrite，不应无选择地搬运 BabeL-X 的历史复杂度。Cleanup 的重点不是“删旧代码”，而是守住依赖边界、发布工程化和 BabeL-X 参考迁入纪律。已完成的重写能力见 [DONE.md](./DONE.md)。

## 当前状态

- 项目没有引入 BabeL-X 源码树、React/Ink runtime、Bun/Elysia、Anthropic 私有包或 telemetry/cloud service 依赖。
- Runtime 去重、结构化 logger、`docs/nexus` 文档中心、Hooks 最小内核、PromptInput 状态分层、多级 permission panel、Compact UX、MCP stdio client、Skill loader、Agent lifecycle metadata 等第一轮迁入/参考重写已完成。
- 当前 cleanup 重点是 package boundary、生产 build、lint/format、CI/coverage、配置兼容策略和后续迁入门禁。

## P1 Package Boundary

- [ ] 区分 runtime deps、CLI/UI deps、dev deps、optional-ui deps。
- [ ] 引入依赖前必须说明归属：runtime / cli / dev / optional-ui。
- [ ] 不允许 runtime core 依赖 terminal UI、desktop/browser/mobile integration。
- [ ] 不允许 provider adapter 泄漏 provider-specific event shape 到 Nexus API。
- [ ] 增加 dependency boundary audit。
  - 定期运行 `npm ls --depth=0`。
  - 输出 runtime reachable dependency report，确认 CLI/TUI 依赖不会进入 Nexus/runtime core。

## P1 Production Build

- [ ] 发布前将 `tsx` 从生产运行路径移出，使用 tsup/esbuild 或等价生产构建。
- [ ] 增加生产构建脚本与配置，产出 `dist/`。
- [ ] CLI bin 不再依赖 tsx 启动。
- [ ] Build smoke 覆盖 `bbl --help`、`bbl run "hello"`、`bbl chat --help` 或等价轻量入口。

## P1 Lint / Format / CI

- [ ] 增加 ESLint / Prettier 或等价格式检查。
- [ ] 建立 GitHub Actions 或等价 CI。
  - 至少运行 typecheck、test、lint/format。
  - 可选运行 benchmark smoke 和 provider/mock smoke。
- [ ] 覆盖率报告接入。
  - 先产出报告，不设置硬阈值。
  - 重点观察 runtime/context/provider/TUI/AgentLoop 关键路径。

## P1 BabeL-X Compatibility Strategy

- [ ] 明确是否兼容 BabeL-X `~/.babel/config.json`。
- [ ] 明确是否提供 BabeL-X transcript import。
- [ ] 若支持 import，需要只做一次性迁移工具，不让 BabeL-X 历史 schema 污染 Nexus runtime schema。

## P2 Future Migration Gate

后续从 BabeL-X 迁入能力时必须遵守：

- [ ] 先定义 Nexus-owned interface。
- [ ] 再写 adapter。
- [ ] 最后迁移实现。
- [ ] 优先“参考重写”，不直接复制 giant file。
- [ ] 不复制 feature flag dead code、cloud service stub、analytics/GrowthBook、React/Ink runtime 组件。
- [ ] 不迁移复杂 plugin system；优先通过 MCP 扩展能力。
- [ ] 所有迁入能力必须先写 TODO/接口/测试计划，再实现。

## P2 仍可参考但未迁入的 BabeL-X 能力

| BabeL-X 能力 | BabeL-O 方向 | 当前口径 |
| --- | --- | --- |
| QueryEngine 高阶 tool loop | Runtime pipeline / tool loop | 暂不搬迁，先完成 `LocalCodingRuntime` pipeline 化。 |
| Session transcript import | 一次性导入工具 | 等配置兼容策略确定后再做。 |
| LSPTool | MCP LSP server 或轻量 context picker | 排在 TUI P2。 |
| fork subagent / prompt cache | 子 Agent transcript + worktree 稳定后评估 | 暂不迁入复杂优化路径。 |
| remote/team/swarm agent | SDK/dashboard + remote runner protocol | 暂不迁入。 |

## 验证命令

- [x] `npm run typecheck`
- [x] `npm test`
- [ ] `npm ls --depth=0`
- [ ] production build smoke
- [ ] lint/format
- [ ] CI smoke
- [ ] coverage report

## 参考文件

- `package.json`
- `docs/nexus/README.md`
- `docs/nexus/TODO.md`
- `src/runtime`
- `src/nexus`
- `src/cli`
