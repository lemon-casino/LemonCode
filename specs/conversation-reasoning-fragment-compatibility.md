# 会话思考片段兼容

## 产品规则

供应商可能将一次连续思考输出为多个 reasoning start/delta/end block，甚至每个词、空格都各占一个 block。会话中同一 product turn、同一 assistant response 的相邻 reasoning block 应显示为一条持续增长的思考行，不重复显示标题或空卡片。

- 合并只在 CLI ProductProjection 中执行。拼接保持原始 delta 的顺序、空格、换行与标点，不插入额外分隔符，也不按文本长度、模型或时间间隔猜测。
- 合并要求非空且相同的 assistantResponseId，以及相同的 product turn；缺少明确回复身份的旧事件保留原分段。
- 只复用投影末尾紧邻的 reasoning row。正文、工具、用户输入、可见 marker、新回复、新轮和中断行都是边界，不跨越或重排行。
- 重复 start、不含文字的 block、缺少 start 的 delta 均复用符合条件的行。后续片段沿用首行 rowId、entityId 和 createdAt；完成后保留完整内容，可按现有规则展开、选择和复制。
- reasoning_end 收口当前片段；下一相邻片段 start/delta 可重新打开同一 complete 行。中断行不得重新打开，终态后的迟到事件继续拒收。

## 停止生成的及时反馈

模型取消已生效后，持久化大量思考片段仍可能需要时间，界面不能等待 TurnComplete 才结束思考。当前会话、当前 runtime turn、当前请求的 `ModelNetworkStatus(model_request_failed, reason=cancelled)` 是请求停止的权威边界。

- ProductProjection 在取消边界立即把活动正文和思考行标为 interrupted，并把既有 control.stopState 更新为 stopping；phase 和 activeWorks 保持真实收尾状态，最终 TurnComplete 再结束整轮。
- 停止期间不显示思考动画或轮尾 ChatLoading。UI 从既有 control.stopState 派生展示，不创建停止状态副本或通过计时器猜测终态。
- 取消边界前已进入 runtime 有序写队列的 stream 事件仍按原序交付和保存；它们只追加 interrupted 内容，start/end 不重新激活行或拆出词级卡片。终态后的新流仍拒收。
- 网络失败、可重试断流、其它 turn、其它 session、旧 request 的取消以及记忆/标题等附属请求，不得停止当前前台思考。
- 显式模型切换会取消旧请求但保留 turn；相同 turn 的新前台 model_request_started 恢复 stoppable，新 response 独立建行。取消请求不等于整轮已完成，不提前开放 idle admission 或更改队列/owner/lease。
- 原始 reasoning block、签名、history 和持久化时序保持不变。

```text
Stop → Runtime 取消当前 execution → 模型取消事实
                                    → ProductProjection：interrupted rows + stopping
                                      ├→ desktop-continuous：即时 delta
                                      └→ web-remote-replayable：同状态快照/重连
已入队的旧 stream → interrupted 内容追加 → 持久化收尾 → TurnComplete(cancelled)
显式模型切换取消 → 新 request_started → stoppable + 新 response
```

## 所有者、接口与事件顺序

ProductProjection 是唯一可变投影 owner；直接从既有 snapshot 的末尾行判断复用，不新增缓存、接受队列或 UI 合并状态。复用既有 ModelStreamingPayload、ReasoningRow 和 ConversationDelta，不改变协议 schema 或底层 ModelReasoningContentBlock/providerOptions。

```text
provider start/delta/end ────────────────┐
已持久化的相邻 reasoning parts → hydration ├→ ProductProjection（唯一 owner）
                                        │   start/delta → 校验 turn/response/末行 → append 或 upsert 同一行
                                        │   delta → row.delta 原样追加
                                        │   end → complete；取消 → interrupted
                                        └→ 同一 snapshot / rowId / sequence
                                             ├→ desktop-continuous：实时 delta
                                             └→ web-remote-replayable：快照 + gap repair
```

沿用已有 publisher 的原子提交、sequence 去重和 stale run 防护；拒绝的候选不能改变行或流式索引。合并不修改 runtime 的原始思考块、签名、工具回放、持久化或 workspace/owner/lease 路由。已有碎片历史在下次 hydration 时自动按相同规则显示，无数据库迁移。

## 验收场景

- 合成多个词级、空白和空 block，实时消费每个事件后仍最多一条 reasoning 行；最终文字与所有 delta 拼接完全相同，首行身份不变。
- 重复 start、缺 start delta、带不同 partId 的相邻块均兼容；不同 response/turn、正文或工具插入、缺回复身份、中断后再次输出均不合并。
- 从持久化的多个 reasoning part 做 cold hydration，与 live 事件产生相同内容和分组。
- 桌面 continuous 客户端逐事件应用 delta；手机在任意片段结束后用 snapshot 恢复并接后续 delta，均与 owner snapshot 一致。
- 原子候选拒绝再接受，内容不重复、行身份不变化；终态迟到事件不复活。
- 浏览器场景覆盖桌面和手机宽度：同一回复只有一个思考标题，展开显示完整段落，后续更新和收口不重置已展开交互；不同回复的思考保持独立。
- 将 TurnComplete 延迟到保存收尾完成，取消事件到达时即可断言思考行 interrupted、ChatLoading 隐藏；后续入队片段不复活动画，完整内容仍保留。桌面 delta 和手机中途快照恢复一致。
- 覆盖新请求、旧请求迟到取消、旧轮/附属请求、普通网络失败与模型切换续跑；不误停新运行。

## 验证入口

从仓库根目录执行针对 `apps/lcode-cli/packages/bootstrap/src/lcode-protocol-v4/` 的 Node/tsx 测试，并执行 `pnpm typecheck`、`pnpm lint`、`pnpm --dir apps/lcode-cli typecheck`、`pnpm --dir apps/lcode-cli lint`、`pnpm architecture:check --changed`。浏览器场景使用实际共享时间线和合成投影数据，不发送真实模型请求。
