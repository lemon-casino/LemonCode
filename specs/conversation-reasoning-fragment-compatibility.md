# 会话思考片段兼容

## 产品规则

供应商可能将一次连续思考输出为多个 reasoning start/delta/end block，甚至每个词、空格都各占一个 block。会话中同一 product turn、同一 assistant response 的相邻 reasoning block 应显示为一条持续增长的思考行，不重复显示标题或空卡片。

- 实时行合并由 CLI ProductProjection 执行；历史恢复在同一 CLI 投影链路的 transcript 合成入口先折叠相邻 reasoning parts，避免词级碎片放大为大量恢复事件。拼接保持原始 delta 的顺序、空格、换行与标点，不插入额外分隔符，也不按文本长度、模型或时间间隔猜测。
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

## 大量片段历史的切换性能

历史 UI 恢复不需要逐词再演示一次 start/delta/end。单个 assistant message 中连续相邻的 reasoning parts 合成为一组 start/delta/end，文本用一次 join 拼接。空 part 不生成事件；跨正文、工具、marker、其它 part 或 message 的边界不合并，仍交给原 ProductProjection 判断最终行语义。

- 只压缩展示用的派生恢复事件，不写回 transcript，不改变原 part id、metadata/signature、provider history、运行中 turn 的内存权威或 accepted command 队列。
- 每组沿用第一条非空 part 的身份。组内保留全部空格、换行、Unicode 和标点，不能截断长思考。
- 实际恢复事件的 id/sequence 保持紧密递增；独立的源事件序位记录一组所代表的旧事件数量，仅用于延续原有缺省 timestamp 口径。可见 rowId、entityId、createdAt、工具/marker 顺序和 command target 不因折叠改变。
- createdAtSeq 是当前恢复事件序列的创建位置，随紧密序列重新编号，不作为持久身份或跨恢复游标；保持行的相对顺序，且不得超过当前 snapshot.seq。比较旧恢复结果时仅允许这个派生序位不同。
- 相邻多块只需 3 个恢复事件，合成与归约成本随总字符量、实际片段扫描次数和可见组数增长；不得仍为每个词生成完整文本 upsert 供 publisher 反复编码。
- publisher 继续在候选投影内完成 payload 上限校验与 actions 收敛，成功后原子 adopt。沿用既有 snapshot recovery boundary；desktop-continuous 与 web-remote-replayable 的订阅、ownership、in-flight reservation 及 stale run 保护不变。

```text
原始 message/parts（持久 owner，保持不变）
 → transcript 合成（相邻 reasoning 展示组 + 源序位）
 → 少量紧密有序恢复事件 → ProductProjection 候选 → payload 校验/原子 adopt
                                                    ├→ 桌面 continuous
                                                    └→ 手机 replayable 快照/恢复
```

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
- 合成万级词片段时单组仅生成 3 个 reasoning 事件；与逐片段旧事件归约后的全部行（除恢复序位外，包括时间、身份、工具/marker、动作和 targets）一致，输入 parts 与签名保持原样。覆盖缺少创建时间的后续旧轮次，避免折叠使默认时间前移。
- 对指定大历史做只读全链路基准，分开记录数据库读取、事件合成和 publisher hydration；断言内容与可见行守恒，性能计时只作基准证据，不使用脆弱的墙钟阈值作为单测判定。
- 验证多次会话切换、旧订阅 resync、冷快照、历史分页和两种 delivery profile；浏览器中首屏与思考展开均可用。未实际测试正在运行的桌面实例时不能把合成基准称为实机切换耗时。

## 验证入口

从仓库根目录执行针对 `apps/lcode-cli/packages/bootstrap/src/lcode-protocol-v4/` 的 Node/tsx 测试，并执行 `pnpm typecheck`、`pnpm lint`、`pnpm --dir apps/lcode-cli typecheck`、`pnpm --dir apps/lcode-cli lint`、`pnpm architecture:check --changed`。浏览器场景使用实际共享时间线和合成投影数据，不发送真实模型请求。

## 大历史恢复验证记录（2026-10-14）

- 只读样本：361 条 message、34,210 个 reasoning part。恢复事件由 104,517 条减少到 2,310 条；publisher hydration 从约 2.3–3.7 秒降到 29–39 毫秒。数据库读取、JSON 解码和合成另计，此数值不代表实机整次切换耗时。
- 全量 810 行、136 条 reasoning 行逐字段对照；仅派生 createdAtSeq 随恢复序列重新编号，内容、身份、createdAt、动作和 command targets 保持一致。
- 73 项相关测试通过，涵盖大分组、空白/Unicode、边界、签名不变、旧时间 fallback、取消回归、两种订阅恢复和 payload 上限原子拒绝。
- 实际 ConversationTimeline + 合成万级片段：1280×900、390×844 各切换大小历史 6 次；分页、544 行全量加载、250 片段思考展开、虚拟化均通过，最终浏览器运行时和 console 错误均为 0。
- 根目录与 CLI 的 typecheck/lint、源文件格式检查和 changed 架构检查通过；架构 baseline/new 均为 0。未重启正在运行的桌面实例，未在该实例测量新版本切换耗时。
