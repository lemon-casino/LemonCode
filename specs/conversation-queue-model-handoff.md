# 队列消息与模型切换交接

## 产品规则

- 已接受的消息仍由 CLI CommandInbox / Core pending input 唯一拥有。点击“立即”复用 `sendQueuedNow`，空闲时直接提升，运行中先取消旧执行；不在 Renderer 重建或重发文本。
- 队列消息使用入队时冻结的完整 ModelSelection（供应商、模型、推理、速度），不能被旧会话模型或之后的草稿改选覆盖。需要改变已排队消息的选型时仍通过撤回编辑后重新提交。
- Core 与 Bootstrap 同时持有取消域时，两者都必须收到取消。取消不等于执行权释放；只在旧执行真实释放后启动提升消息，不伪造 idle，也不延长现有安全超时。
- Core promotion lease 精确绑定原消息 inputId。持有匹配 lease 且旧执行已空闲时，待处理的后台通知不能挡住提升消息；普通输入或另一条消息不能借用 lease 抢跑。
- Core 提供只读 `isForegroundExecutionIdleForPromotion()`，同时检查 foreground execution、command drain、active turn 与 start reservation。Bootstrap 不能只凭实时 executionId 消失判定 idle，因为 durable policy 清理尚可能占有 command drain；不把 lease 或排队通知计入此谓词。
- 明确提交的新选型继续在 Core 执行入口校验并应用，不为队列引入第二套选型写入。无显式选型的旧输入沿用既有会话选择；启动前失败保留原项，已启动后的模型错误走既有 Turn 终态，不静默换回旧模型。
- “立即”显示处理中状态、同一行防重入，结束后恢复；ACK failed/rejected/stale 和传输失败都必须显示提示。消息只有实际 admission 成功后才从权威队列移除。

## 所有者与时序

```text
Desktop continuous ── sendQueuedNow ──┐
Web replayable ────── sendQueuedNow ──┴─ CommandInbox（串行 / commandId 幂等）
  -> 原项 reservation -> Core promotion lease（原 sourceCommandId）
  -> 取消 Core + Bootstrap -> 旧执行 finally 释放
  -> Core admission 校验冻结选型 -> 新轮 -> remove(promoted)
  └─ 启动前失败：释放 lease / reservation，原项原位保留，UI 明示失败
```

不更改 wire schema、持久化格式、workspaceIdentity / remoteSessionId / owner-lease 路由或恢复边界。UI 只拥有一次按钮点击的 pending 状态，不保存第二份已接受队列。跨会话迟到的失败反馈不得写到新 pane。生产日志只记录命令/状态/原因，不记录消息正文、凭据或服务地址。

## 验收

1. A 运行中选择 B 后入队，点击立即；两层取消域均结束，只启动一次 B，原文本、附件、来源和推理/速度均保留。
2. A 结束时仍有 Bash 后台通知排队；匹配 promotion lease 的 B 优先启动，通知不丢失且不能先抢占 B。其他 inputId 无法借用 B 的 lease。
3. completed / interrupted 下保留的消息也能立即提升；失败回滚，重试不重复执行。
4. 旧会话选型 A 与冻结的新选型 B 不同时，输入意图完整传入 Core；无选型的历史消息仍沿用 A，B 不可用时明确报错、不静默回退。
5. 桌面与手机浏览器点击立即都有 pending 和失败反馈；连续点击只发送一次。切换会话后旧 ACK 不污染新会话。

## 验证范围

使用隔离的 Runtime/Host 桩测试双取消域、promotion lease 与冻结选型；浏览器用真实共享队列组件验证 pending、失败、重试及窄屏。测试不发送用户现有队列消息，不调用真实模型、不改用户数据库。
