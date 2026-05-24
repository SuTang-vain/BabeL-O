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
- [ ] 增加生产构建脚本与配置（tsup/esbuild），产出 `dist/`，CLI bin 不再依赖 tsx 启动。
- [ ] 增加 ESLint / Prettier 或等价格式检查，避免类型断言、行尾空格和风格漂移继续累积。

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
- [ ] 优先“参考重写”，不直接复制 giant file。
- [ ] 不复制 feature flag dead code。
- [ ] 不复制云服务 stub。
- [ ] 不复制 UI state 到 runtime core。
- [ ] 不迁移 React/Ink 组件到 runtime；CLI 需要增强时优先使用轻量 ANSI/readline/chalk。
- [ ] 不迁移 telemetry / analytics / GrowthBook；只保留本地 metrics。
- [ ] 不迁移复杂 plugin system；优先通过 MCP 扩展能力。
- [ ] 不迁移 BabeL-X `src/utils/hooks.ts` 巨型实现；只参考事件语义，在 BabeL-O 内按 Nexus event schema 重写最小 Hook executor。
- [ ] 不迁移 BabeL-X `PromptInput` React/Ink 组件；只参考输入状态分层、overlay 键盘路由和 footer/status 信息架构。
- [ ] 不迁移 BabeL-X AgentTool 的完整 background/team/swarm/remote 体系；只迁移 agent lifecycle metadata、transcript、permission inheritance、worktree notice 等可验证机制。
- [ ] 不迁移 prompt-cache/fork subagent 的复杂优化路径，除非 AgentLoop 的子 session、transcript 和 worktree 默认隔离先稳定。
- [ ] 所有 BabeL-X 迁入能力必须先写 TODO/接口/测试计划，再实现；不得用“复制后再删”的方式引入未知依赖。

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
- [ ] Hooks lifecycle：审计 `src/utils/hooks.ts` 中的 `PreToolUse`、`PostToolUseFailure`、`PermissionRequest`、`SubagentStart`、`SessionEnd`，抽取事件语义和 timeout/error isolation 策略。
- [ ] PromptInput state machine：审计 `src/components/PromptInput/*` 中输入缓冲、history、slash/typeahead、modal overlay、footer/status 的分层方式。
- [ ] Permission option model：审计 `src/components/permissions/*` 中 once/session/always allow/editable rule/reject feedback 的选项建模。
- [ ] Compact UX：审计 `src/services/compact/autoCompact.ts`、`TokenWarning.tsx`、`commands/compact`，抽取 threshold、warning、manual compact、failure circuit breaker。
- [ ] Agent transcript/lifecycle：审计 `src/tools/AgentTool/runAgent.ts`、`forkSubagent.ts`、`agentDisplay.ts`、`tasks/LocalAgentTask/*`，抽取 metadata、transcript、background status 和 worktree notice。

## RECOMMENDATIONS 文件映射

来自 `docs/RECOMMENDATIONS.md`，作为从 BabeL-X 迁入能力时的优先参考。

| BabeL-X 文件 | BabeL-O 目标 | 策略 |
| --- | --- | --- |
| `src/services/mcp/mcpClient.ts` | `src/mcp/McpClient.ts` | 参考重写，只保留 stdio |
| `src/services/mcp/mcpRegistry.ts` | `src/mcp/McpRegistry.ts` | 参考重写，简化认证 |
| `src/services/compact/snipCompact.ts` | `src/runtime/compactors/snipCompactor.ts` | 参考重写，字符驱动 |
| `src/services/compact/autoCompact.ts` | `src/runtime/contextAssembler.ts` / compact command | 参考 threshold、warning、failure circuit breaker；不迁移 ML/后台压缩 |
| `src/components/TokenWarning.tsx` | `src/cli/renderEvents.ts` / footer status | 参考用户可见 context warning；不迁移 React 组件 |
| `src/skills/loadSkill.ts` | `src/skills/loader.ts` | 参考重写，只保留 inline 模式 |
| `src/skills/bundled/*` | `src/skills/built-in/*` | 迁移内容，改格式 |
| `src/utils/claudemd.ts` | `src/runtime/memory.ts` | 参考重写，简化为 markdown 加载 |
| `src/utils/permissions/yoloClassifier.ts` | `src/runtime/classifier.ts` | 参考重写，规则替代 ML |
| `src/utils/hooks.ts` | `src/nexus/hooks/*` 或 `src/runtime/hooks/*` | 只抽取生命周期事件语义，重写最小内核 |
| `src/tools/AgentTool/AgentTool.tsx` | `src/nexus/agentLoop.ts` / task session | 参考 agent lifecycle、permission inheritance、transcript、worktree notice；不迁移 React UI/team/remote 复杂度 |
| `src/tools/AgentTool/runAgent.ts` | `src/nexus/agentLoop.ts` | 参考子 Agent MCP/skill/context 继承和 cleanup；重写为 Nexus TaskSession 语义 |
| `src/tools/AgentTool/forkSubagent.ts` | 延后 | 只参考 worktree notice 和防递归规则；暂不迁移 fork prompt-cache 优化 |
| `src/components/PromptInput/*` | `src/cli/ui.ts` / `src/cli/completer.ts` | 参考状态分层和键盘路由；不迁移 React/Ink |
| `src/components/permissions/*` | CLI approval panel | 参考多级审批选项、editable rule、reject feedback |
| `src/tools/LSPTool/LSPTool.ts` | 延后 | 优先通过 MCP LSP server 替代 |
| `src/components/*` | 不迁移 | 与 clean rewrite 原则冲突 |
| `src/services/analytics/*` | 不迁移 | 与纯本地原则冲突 |

## 验证命令

- [x] `npm run typecheck`
- [x] `npm test`
- [ ] `npm ls --depth=0` 定期审计。
- [ ] bundle size / dependency count report。
- [ ] GitHub Actions 或等价 CI：至少运行 typecheck、test、lint/format、可选 benchmark smoke。
- [ ] 覆盖率报告接入（c8/nyc 或 Node 原生覆盖率），先产出报告，不设置硬阈值。

## 参考文件

- `package.json`
- `docs/ARCHITECTURE.md`
- `docs/nexus/TODO.md`
