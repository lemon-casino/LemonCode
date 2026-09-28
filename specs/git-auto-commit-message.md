# 任务完成后自动生成 Git 提交信息

## 产品行为

- 提供全局设置“任务完成后自动生成提交信息”，默认关闭，避免用户未授权的模型调用与额外 Token 成本。
- 仅当前聚焦、可写、非侧聊会话在本 renderer 观察到 `running -> completedSuccess` 后进入自动生成流程。
- 仅当完成轮次包含仍为 `active` 的文件改动，且后台工作、子 Agent 与工作流均已结束时生成。
- 自动流程只生成提交信息草稿，不暂存、不提交、不推送。用户仍通过现有 Git 提交弹窗检查并确认。
- 手动“生成/重新生成”与提交信息留空后生成继续复用现有 `IGitService.generateCommitMessage` 路径。
- 提交信息遵循现有 Conventional Commit、当前语言、当前模型与输出校验规则。

## 状态所有者与边界

| 状态 / 事实            | 唯一所有者                                                              | 说明                                                                     |
| ---------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 会话运行与完成态       | CLI V4 `ConversationSnapshot.control.phase`                             | Renderer 不从消息文本或计时器推测完成。                                  |
| 当前任务文件范围       | task meta `changeSummary`；缺失时使用完成轮次 `conversationFileChanges` | 不把 workspace 全部脏文件误算成当前任务。                                |
| Git 工作区状态与 diff  | 目标 Environment 的 `IGitService`                                       | Desktop、本地 Web 与远程 workspace 均通过注入的 Host 服务执行。          |
| 自动生成草稿           | 当前 `SessionPane`                                                      | 草稿是 UI 局部事实，不是 Git、CLI 或服务端事实；不进入 replay/snapshot。 |
| 提交消息输入与提交动作 | `GitActionMenu`                                                         | 只在打开弹窗时接收仍然新鲜的自动草稿；用户编辑后不被后台结果覆盖。       |
| 设置持久化             | `ISettingService` / `AppSettings`                                       | `autoGenerateGitCommitMessage` 缺失时按关闭处理。                        |

## 事件顺序

```text
CLI session owner
  running
    -> completedSuccess + terminal turn header
    -> 等待 backgroundWorks / subagents / workflowRuns 全部结束
    -> conversationFileChanges(target turn)
    -> 合并 task changeSummary 文件范围
    -> IGitService.refresh (before fingerprint)
    -> IGitService.generateCommitMessage
    -> IGitService.refresh (after fingerprint)
    -> 指纹一致时发布 SessionPane 自动草稿
    -> GitActionMenu 打开时再次按当前 Git 状态校验指纹
    -> 预填提交信息
    -> 用户确认
    -> 现有 stage -> commit -> optional push
```

不使用超时或 debounce 判定“代码写完”。完成态、后台工作终态和轮次文件摘要共同构成触发边界。

## 幂等、隔离与失效

- 触发 key 包含 `workspaceIdentity?.trim() || workspacePath`、`remoteSessionId`、`sessionId`、`logEpoch`、`turnId`、`rowId` 与 `entityId`。
- 冷恢复直接落在 `completedSuccess` 时不生成；只有当前 renderer 先观察到 `running` 才武装触发器。
- 同一完成边沿只发起一次生成。切换 workspace/session/logEpoch、关闭设置、会话重新运行时清除旧 target 与草稿。
- 生成前后对当前任务范围内的 staged/unstaged 文件列表、状态与增删行数计算稳定指纹；调用期间发生变化则丢弃结果。
- 打开提交弹窗时再次计算指纹；不一致时不预填旧草稿，用户仍可手动生成。
- `workspacePath` 只用于 Git 文件操作；隔离 key 使用 workspace identity fallback，并包含远程 session。

## 失败语义

- 无文件改动、Git 不可用、非仓库、模型不可用、请求失败、输出不合规或指纹变化均不阻塞任务完成。
- 自动失败只记录可恢复诊断日志，不弹出阻塞对话框，不清除用户已经输入的提交信息。
- 手动生成继续使用现有错误提示与重试入口。
- 自动生成不会更改 Git index、HEAD、branch 或 remote。

## 验收场景

1. 设置开启，聚焦会话从 `running` 进入 `completedSuccess`，本轮有文件改动且无后台工作：只生成一次，并在打开提交弹窗时预填。
2. 设置关闭、冷恢复已完成会话、非聚焦会话、只读会话、侧聊、失败或中断：不自动调用模型。
3. 完成时仍有后台工作：保持已武装状态；全部结束后再生成，不使用定时等待。
4. 本轮无文件改动或文件已回滚：不生成。
5. task meta 有文件摘要：生成与提交弹窗只包含该任务范围；meta 缺失时回落到完成轮次文件详情。
6. 生成期间文件、暂存状态或增删行数变化：丢弃生成结果。
7. 生成后 Git 状态变化：提交弹窗不预填过期草稿。
8. 用户已打开弹窗并编辑文本：之后到达的自动结果不覆盖输入。
9. 自动生成失败：任务保持完成，现有手动生成与手动输入可继续使用。
10. 本地与远程 workspace：均由当前 ServiceProvider 中的目标 Host Git 服务读取与生成，不直接调用 `window.lcode`。

## 验证

- 纯状态机测试：武装、成功终态、冷恢复、后台阻塞、禁用与 scope 切换。
- 文件指纹测试：任务范围过滤、顺序稳定、staged/unstaged/增删变化失效。
- AppSettings schema 测试：默认关闭，patch 接受布尔值。
- 交互场景：完成后自动生成、打开提交弹窗预填、用户编辑不被覆盖、Git 变化后草稿失效。
- 执行仓库提供的 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 与 `pnpm fmt:check`。
