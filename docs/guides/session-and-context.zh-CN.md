# 会话与上下文

[English](session-and-context.md)

BabeL-O 将每一次编码对话建模为一个持久、可检查的工作单元。
你在 `bbl go` 内的每一条消息都属于一个会话。会话通过 SQLite 持久化,
关闭 TUI 也不会丢失,你可以后续继续、检查或回放。

## 会话

### 创建

提交第一条消息时自动创建。若要在下一条消息前强制新建: `/session new`。

### 列出

```bash
bbl sessions list                   # 列出所有已持久化的会话(阶段 + 工作目录)
bbl sessions tree                   # 父子会话层级(子 agent 场景)
bbl sessions tree <rootSessionId>   # 从指定根会话开始的子树
```

### 检查

```bash
bbl sessions show <sessionId>              # 完整元数据(JSON)
bbl sessions events <sessionId>            # 分页事件记录
bbl inspect-session <sessionId>             # 本地 SQLite 诊断 + 压缩历史
bbl inspect-session <sessionId> --trace    # 导出为 agent 轨迹
bbl inspect-session <sessionId> --resume   # 查看能否恢复
```

`bbl inspect-session` 是主要诊断工具:在本地 SQLite 中查找会话,
报告阶段(phase)、事件数、压缩边界和原始 prompt。`--trace` 导出
完整事件流;`--resume` 显示运行停在哪里以及能否继续。

### 切换与恢复

在 TUI 内: `/session use <sessionId>`。从 CLI:

```bash
bbl sessions resume <sessionId> "continue with the refactor"
```

向已有会话追加消息,让 Nexus 继续执行。

### 取消

```bash
bbl sessions cancel <sessionId>
```

### 子会话与收件箱

agent 派生子 agent 时,每个子 agent 有自己的会话:

```bash
bbl sessions children <parentSessionId>
bbl sessions child-events <parentSessionId> <childSessionId>
```

会话可通过 SessionChannel 接收协作上下文:

```bash
bbl sessions inbox <sessionId>           # 未读消息
bbl sessions inbox <sessionId> --include-acknowledged
bbl sessions ack <sessionId> <messageId>
```

TUI 内使用 `/inbox`。

## 持久化会话

会话在 TUI 重启后依然存在。Nexus 持久化到 `~/.babel-o/db.sqlite`。
重启后:

1. `bbl sessions list` 查找会话。
2. TUI 内 `/session use <sessionId>`。
3. 模型加载历史并从中断处继续。

若会话丢失(内存存储未持久化),`bbl inspect-session <sessionId>`
会报告原因并显示客户端日志线索。

## 上下文检查

### `/context` 面板

`bbl go` 内输入 `/context` 打开上下文分析面板。它读取
`GET /v1/sessions/:id/context`,展示模型"看到"的实时快照:

- **Token 预算**:用量 vs 上限,含分段进度条。
- **容量**:剩余 token、压缩余量、阻塞余量。
- **状态**:selected/omitted 事件计数、压缩边界、恢复边界、下一阈值。
- **任务范围**:主根目录、已确认外部根目录、待处理范围边界、范围外证据。
- **各段落**:系统提示词、项目记忆、会话摘要、活跃技能的字符数。
- **压缩保留**:是否存在边界、保留事件数。
- **压缩增量**:折叠事件数与预估释放 token。
- **记忆**:长期记忆命中次数、注入字符、延迟。
- **工作集路径**:最常访问的文件。
- **信号与建议**:警告、通知和可操作建议(如"立即压缩")。

### 解读压缩段落

```
compact boundary yes · retained=42
compact delta: events 156 -> 18 · saved~8400 tokens
```

- **retained=N**:压缩后保留的最近事件数。
- **before/after**:压缩前后的事件计数。
- **saved**:预估释放的 token 数。

### 自动压缩

当估算 token 超过上下文窗口约 70% 时,自动触发:

```
auto compact: threshold reached at 85%
```

当 `shouldCompact` 为 `true` 时,下一次模型调用先压缩再调用 provider。

### 手动压缩

TUI 内输入 `/compact`:

```
compact_result events: 156 -> 18
```

响应包含边界类型、触发原因、摘要和保留段落详情。

## 长会话与交接

1. **关闭前**:无需保存。用 `/session current` 查看当前 ID。
2. **重启后**:`bbl sessions list` 查找,然后 `/session use <id>`。
3. **验证恢复**:`bbl inspect-session <id> --resume`。
4. **检查轨迹**:`bbl inspect-session <id> --trace` 导出机器可读回放。
5. **工作集**:`bbl context working-set` 查看跟踪的文件。

会话存储保持历史记录完整,跨越终端重启、网络中断和 provider 切换。
