# TODO Cleanup / Decoupling

## 目标

BabeL-O 是 clean rewrite，不应无选择地搬运 BabeL-X 的历史复杂度。Cleanup 的重点不是“删旧代码”，而是防止旧复杂度重新长回来。

## 当前状态

- [x] 新项目没有引入 BabeL-X 源码树。
- [x] 新项目没有引入 React/Ink 到 runtime core。
- [x] 新项目没有引入 Bun/Elysia。
- [x] 新项目没有引入 Anthropic 私有包。
- [x] 新项目没有引入 telemetry/cloud service 依赖。
- [x] 新项目使用 Fastify + Commander + Zod + TypeScript。
- [ ] 尚未区分 runtime deps 和 CLI/UI deps 的 package boundary。

## 依赖治理

- [x] 使用 Node.js。
- [x] 使用 Fastify。
- [x] 使用 Commander。
- [x] 使用 Zod。
- [x] 使用 `@fastify/websocket`。
- [ ] 引入依赖前必须说明归属：runtime / cli / dev / optional-ui。
- [ ] 不允许 runtime core 依赖 terminal UI。
- [ ] 不允许 runtime core 依赖 desktop/browser/mobile integrations。
- [ ] 不允许 provider adapter 泄漏 provider-specific event shape 到 Nexus API。
- [ ] 发布前将 `tsx` 从生产运行路径移出，使用 tsup/esbuild。

## 命名和兼容

- [x] 项目名使用 BabeL-O。
- [x] CLI binary 使用 `bbl`。
- [x] 配置目录使用 `~/.babel-o`。
- [x] env 使用 `BABEL_O_*` 和 `NEXUS_*`。
- [ ] 明确是否兼容 BabeL-X `~/.babel/config.json`。
- [ ] 明确是否提供 BabeL-X transcript import。

## 旧能力迁入规则

从 BabeL-X 迁入能力时必须遵守：

- [ ] 先定义 Nexus-owned interface。
- [ ] 再写 adapter。
- [ ] 最后迁移实现。
- [ ] 不直接复制 giant file。
- [ ] 不复制 feature flag dead code。
- [ ] 不复制云服务 stub。
- [ ] 不复制 UI state 到 runtime core。

## 待审计迁入能力

- [ ] QueryEngine 核心 tool loop。
- [ ] Tool definitions 中稳定的 input schema。
- [ ] Permission classifier。
- [ ] Diff rendering。
- [ ] File/path suggestions。
- [ ] Session transcript import。
- [ ] MCP client。
- [ ] SkillTool。
- [ ] AgentTool。
- [ ] LSPTool。

## 验证命令

- [x] `npm run typecheck`
- [x] `npm test`
- [ ] `npm ls --depth=0` 定期审计。
- [ ] bundle size / dependency count report。

## 参考文件

- `package.json`
- `docs/ARCHITECTURE.md`
- `docs/nexus/TODO.md`
