# 使用示例

[English](examples.md)

在 `bbl go` 中使用 BabeL-O 的真实场景模式。

---

## 1. 探索陌生仓库

**提示语：**

```
explain this repository and point me to the entry points
```

**过程：** Agent 调用 Glob、Grep 和 Read 了解项目布局，读取 `package.json`、入口文件和关键配置，然后在对话记录中合成一份结构化概览。

**后续追问：** 可以接着问 "how does the build pipeline work?" 或 "what tests exist for the auth module?" 逐步深入。Agent 已拥有仓库结构上下文。

**提示：** 每个仓库建议用 `/session new` 新建会话，避免上下文混入之前的干扰信息。

---

## 2. Bug 修复流程

启动一个会话，粘贴失败的测试输出，然后输入：

```
read the failing test output, patch the bug, and rerun the smallest useful test
```

**过程：** Agent 读取测试文件并运行一次以捕获完整错误栈（Bash 工具），然后溯源到源码（Read、Grep），编辑文件（Edit）并重新运行测试。首次使用 Write/Edit/Bash 时会弹出权限确认。按 **`A`**（大写）可批准 Bash 整个会话免确认。

**提示：** 如果测试运行较慢，可以要求 Agent 先提取一个最小复现场景："find the minimal reproduction and only rerun that one."

---

## 3. 跨会话的长迁移

大型重构不可能在一个会话内完成。利用持久化会话分阶段进行。

**会话 A —— 规划和探索：**

```
migrate the config loader from YAML to JSON. start by mapping the public API surface
```

让 Agent 探索并生成计划。上下文快满时运行 `/compact` 或等待自动压缩。结束时记下会话 ID：

```
/session current
```

**会话 B —— 恢复（第二天或重启后）：**

```bash
bbl sessions list                          # 查找会话
bbl inspect-session <会话ID> --resume     # 验证可恢复性
```

然后在 `bbl go` 中：

```
/session use <会话ID>
```

模型加载压缩后的历史并继续执行。用 `/context` 检查上下文状态，查看工作集和压缩情况。

**提示：** 关闭 TUI 前运行 `/compact` 完成历史摘要，下次恢复时会更快。

---

## 4. 多会话交接

当任务包含一个明确的子任务时，创建独立子会话进行交接。

在父会话中开始探索：

```
/session new migration-prep
```

完成探索后切回主会话：

```
/session use main
```

在 TUI 中输入交接提示语，引用另一个会话：

```
check /session/migration-prep for the dependency list, then implement the changes here
```

如需在终端（无需 TUI）检查某会话：

```bash
bbl sessions show <会话ID>                # 完整元数据（JSON）
bbl sessions events <会话ID>              # 分页事件记录
bbl inspect-session <会话ID>              # 诊断 + 压缩历史
bbl inspect-session <会话ID> --trace      # 导出为机器可读轨迹
```

**提示：** 涉及子 Agent 时，可用 `bbl sessions tree` 查看父子层级关系。

---

## 5. 上下文检查

**提示语：**

```
inspect the current context budget and tell me whether we should compact
```

**过程：** Agent 查看 `/context`（或利用自身上下文感知），然后解读数据：token 用量 vs 上限、压缩余量、工作集文件路径，以及是否建议立即压缩。

手动查看上下文面板：

- 在输入栏输入 **`/context`** 并按 Enter。
- 关注压缩段落：`compact delta: events 156 -> 18 · saved~8400 tokens`。
- 运行 **`/compact`** 手动触发压缩。
- 再次运行 `/context` 验证释放后的余量。

**提示：** 上下文窗口用到约 70% 时自动压缩。如果发现频繁自动压缩，建议在自然停顿处手动 `/compact`，让摘要按你的节奏进行。

---

## 6. 会话中切换模型

在 `bbl go` 中切换活跃模型，不会丢失会话状态：

- 输入 **`/model`** 并按 Enter（或按 **Ctrl+L**）。
- 模型配置面板打开，选择不同的 provider 档案或模型 ID。
- 会话保持完好，后续轮次使用新模型。

常见切换场景：

| 时机 | 切换到 |
| --- | --- |
| 需要深度推理 | 更大的模型（如 `claude-opus-4-5`） |
| 快速便宜的编辑 | 更小的模型（如 `claude-haiku-4-5`） |
| 尝试不同提供商 | 切换整个 provider 档案 |

会话的工具轨迹、上下文和权限规则均保持不变。

**提示：** 进入 TUI 前先运行 `bbl config list` 查看已配置的档案，这样就知道 `/model` 面板下有哪些可选。

---

## 7. 无需 TUI 的一次性提示

对于快速问题或自动化脚本，完全跳过 TUI：

```bash
bbl run "summarize the changes in the last three commits"
```

BabeL-O 使用默认会话运行该提示，返回结果后退出。不经 TUI，不持久化。

**提示：** 任何需要多轮交互的场景，请使用 `bbl go`。TUI 专为多轮会话设计。
