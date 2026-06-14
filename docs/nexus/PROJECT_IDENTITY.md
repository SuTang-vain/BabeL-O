# BabeL-O — 项目身份记忆

> 本文件是 BabeL-O 的**核心特性和长期目标**的持久化记忆。
> 由 Agent 写入于 2026-06-14。后续会话可通过查阅此文件快速对齐项目定位。

---

## 一、项目定位

**BabeL-O** 是一个 **Nexus-first 的终端 AI 编程智能体（Generalized AI Agent）**。

核心理念：**Nexus 拥有执行权，CLI 拥有交互权。**

- CLI (`bbl`) 是用户交互入口，通过 REST + WebSocket 与 Nexus daemon 通信
- Nexus (Fastify daemon) 持有运行时状态，管理 agent loop、工具调度、权限治理
- Runtimes 可插拔：`LocalCodingRuntime`（确定性执行）/ `LLMCodingRuntime`（任意 LLM 适配）
- Go TUI (`bbl go`) 是生产级交互客户端，~10MB 单文件二进制，零 Node 依赖

---

## 二、核心特性

### 2.1 多前端架构
- **TypeScript CLI**: 开发者 playground，`bbl chat dev`
- **Go TUI**: 生产界面，10MB 单文件二进制，可丢进容器运行
- **REST + WebSocket API**: 远程连接、headless 集成

### 2.2 Worktree 并行治理
- 后台 daemon 持有状态，客户端可掉线、可更换，任务不丢失
- 同时开多个 session 在不同 worktree 干活
- SessionChannel 实现跨 session 上下文共享和续传

### 2.3 工具权限风险模型
- 四级风险：`read < write < execute < task`
- Task scope 边界检测：工具调用超出 `primaryRoot | explicitRoots | confirmedExternalRoots` 时触发 scope boundary 确认
- Permission mode: `strict`（硬拒绝非白名单）/ `soft-deny`（Go TUI 弹窗确认）

### 2.4 长任务能力
- Context compaction：长对话自动压缩，避免上下文溢出
- Tool loop 边界治理
- Sub-agent 系统：并行执行子任务
- Go runner：远程工具执行

### 2.5 可插拔 Provider
- Anthropic-compatible、OpenAI-compatible、OpenAI-responses 适配器
- Provider recovery：失败自动切换备用 provider

### 2.6 长期记忆（EverCore）
- 可选的跨 session 语义记忆 sidecar
- Memory candidate 自动检测（cue-driven），写入需 permission-gated
- 长期记忆是 volatile context hint，不替代 SQLite / session events / workspace evidence
- 支持 `bbl memory setup` 本地引导部署

### 2.7 分发策略
- Portable 二进制包：`bbl-<platform>.tar.gz`
- npm global install
- 源码 clone 构建
- 中期补 Go launcher 降低体积

---

## 三、长期目标（30 天产品改造）

> 来源：`docs/nexus/active/TODO_product_30day.md`

**总目标**：把 BabeL-O 从"硬核开发者愿意读 600KB WORK_LOG 才能上手"提升到"路人 5 分钟能看到价值、30 分钟能跑通第一个真实任务"。**不动后端。**

### W1 — Make It Visible（可见性）
- README 顶部价值段重写（3 个差异化 bullet）
- 5 分钟快速开始指南
- 首页 demo gif / 截图（`bbl chat` + `bbl go`）
- "Try these prompts" 示例库

### W2 — Make It Trustworthy（可信度）
- 系统 keychain 接入 API key（macOS Keychain / Windows Credential Manager / Linux Secret Service）
- 错误文案统一 friendly 化（覆盖双 TUI）
- 安装三选一指引降级
- `bbl init` 引导式初始化 wizard
- 首启 MemoryOS 长期记忆 sidecar 引导（已实现）

### W3 — Make It Discoverable（可发现性）
- docs site 上线（VitePress + GitHub Pages / Cloudflare Pages）
- Demo 视频（对比视角：BabeL-O vs Claude Code）
- `examples/` 目录（5 个复现即跑通的子项目）
- README 视觉资产补全（架构图 + comparison matrix）

### W4 — Make It Sustainable（可持续性）
- CONTRIBUTING.md + 开发环境一键脚本
- GitHub Discussions 开启 + issue template
- Community 入口（Discord + Reddit + Twitter/X）
- Bus factor 治理：至少 3 个维护者可独立发布 + 发布清单自动化

---

## 四、关键差异化

| 维度 | BabeL-O | Claude Code / Aider |
|------|---------|---------------------|
| 架构 | Nexus daemon + 多前端 | 单进程 CLI |
| 客户端 | 10MB Go TUI + TypeScript CLI | Node/Python REPL |
| 多 session | Worktree 并行 + SessionChannel | 单 session |
| 断线续传 | Daemon 不掉线，TUI 重连续传 | 进程挂则任务丢 |
| 长任务 | Context compaction + sub-agent | 受限于单次 API 上下文 |
| 权限治理 | read/write/execute/task 四级 + scope boundary | 基础 allow/deny |
| 分布式 | Go runner 远程执行 | 本地执行 |

---

## 五、技术栈

- **Runtime**: Node.js >= 22 (ESM)
- **Daemon**: Fastify (REST + WebSocket)
- **Go TUI**: Go 1.23 + Bubble Tea
- **存储**: SQLite (WAL JSONL append log)
- **可选**: EverCore sidecar (Python, 长期记忆)

---

## 六、当前状态

- 版本：v0.3.6
- 分支：`develop`
- 活跃改造：30 天产品化计划 W2（部分已实现）
- 维护者：单点维护，"壳中客(KezhongKe)"
