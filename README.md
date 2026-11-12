# dsh-plugin-task-ask

按 DeepSeek Harness **官方前端构造**接入：右侧栏 Page Tab（与「文件」同类），不是自造弹窗。

## 行为

- 会话标题栏 **「旁路询问」** → `ctx.sidebarRight.openTab('task-ask')`
- 在**当前界面右侧栏**打开询问面板（自动展开 rightbar）
- 实时只读任务阶段 / 待办 / 工具动态；独立 LLM 回答
- 已完成计划默认折叠隐藏；工具动态下拉折叠
- 旁路可调用主界面工具（结果不写回主会话）
- **不**写入主会话，**不** `followup` / `steer` / `prompt`

## 接入点

| 层 | 机制 |
| --- | --- |
| Host | `/api/task-ask/*` 只读快照 + 旁路 `llm.stream` |
| Client | `ctx.sidebarRightTabs.register` + `sidebar.right.pane.tab` |
| 入口 | `conversation.session.header.actions` |

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/task-ask/sessions` | 会话列表（容错，始终 JSON） |
| GET | `/api/task-ask/snapshot?sessionId=` | 点查快照 |
| GET | `/api/task-ask/events?sessionId=` | SSE 实时快照 |
| POST | `/api/task-ask/ask` | `{ sessionId, question }` → `{ answer }` |

Host 在 `apply()` 时固定 `sessions` / `agents` / `llm` 引用，避免 HTTP 回调里再次 `ctx.sessions` 触发 Cordis inactive context，导致空 400、前端 `json()` 报错。

## UI

右侧栏面板使用 `--dsw-*` 设计令牌，布局对齐 Files（38px 顶栏）与 Jobs（header action 按钮）。

## 安装

```powershell
Copy-Item -Recurse -Force D:\deepseek_harness\dsh-plugin-task-ask\* "$env:USERPROFILE\.dsh\profiles\desktop\plugins\dsh-plugin-task-ask\"
```

**Host 改动需完全退出并重启** DeepSeek Harness 后生效。

## Desktop profile 说明（崩溃恢复）

若 Harness 启动时报 `napi_throw` / exit 134，先检查 `~\.dsh\profiles\desktop`：

1. `package.json` 的 `bundles` 建议保持：`dsh-base`、`dsh-web-app`、`dsh-plugin-task-ask`（先不要挂 QQ / 未装齐的 experimental）
2. `cordis.patch.yml` 不要残留 `qq-bridge` MCP 配置
3. 清掉 `node_modules` 后执行：`dsh plugin --profile desktop install`
4. **完全退出**再开 DeepSeek Harness

已验证：`/api/task-ask/sessions` 与 `/task-ask` 返回 200；快照含 `openTurnText` / `liveText`。

## 更新记录

- **2026-11-12 0.1.9**：已完成计划默认折叠隐藏；工具动态改为下拉模块；旁路 ask 支持调用主界面工具（SSE `tool` 事件）；状态条/提示词同步实时上下文。
- **2026-10-25 0.1.8**：旁路回答改用主聊天官方 `MarkdownText`（`@deepseek-ai/dsh-client-ui-primitives`），去掉自研 HTML 渲染。
- **2026-10-25 0.1.7**：`session/disposed` + 孤儿 prune 回收 live；ask prompt 去掉 open-turn/live 重复；状态条展示最近动态预览；markdown 支持表格/标题/引用/嵌套列表。
- **2026-10-25 0.1.6**：修复 open-turn 读错事件字段（`tool/result` / `assistant/*` 在 `data.message`）；历史摘要改为保留最近片段；中止询问不再卡住「思考中」；默认模型服务在 apply 时固定。
- **2026-10-25 0.1.5**：旁路询问优先读取「进行中回合」全文（工具/消息）+ 未落盘流式回复；不再在每个 session 事件清空 live 缓冲。修复 desktop 启动崩溃：移除 QQ 插件与残留 link，精简 bundles 后 host 可正常起来。
- **2026-10-25 0.1.4**：状态条改用轻量快照（去掉巨型 historyText，修复一直「同步中」）；无真实数据时不显示占位文案。
- **2026-10-25 0.1.3**：输入框对齐主会话 InputBar（22px 卡片 + 圆形发送）；用户气泡 / 助手正文对齐主聊天；询问改为 SSE 流式输出。
- **2026-10-25 0.1.2**：修复空 400 / `Unexpected end of JSON input`；接口始终返回 JSON；UI 对齐官方 `--dsw-*` 令牌。
- **2026-10-25 0.1.1**：改为右侧栏 Page Tab + header 入口。
