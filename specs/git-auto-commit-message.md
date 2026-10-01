# 任务完成后自动生成 Git 提交信息

## 产品行为

- 提供全局设置“任务完成后自动生成提交信息”，默认关闭，避免用户未授权的模型调用与额外 Token 成本。
- 仅当前聚焦、可写、非侧聊会话在本 renderer 观察到 `running -> completedSuccess` 后进入自动生成流程。
- 普通、计划、工作流任务均按同一规则处理：当前会话实时完成、子 Agent/工作流等会继续产出任务结果的后台工作结束，并且本次执行确实留下 Git 工作区文件改动时生成。后台 Bash 不阻塞弹窗：临时命令在完成边界由 Runtime 停止；只有经用户单次确认保留的预览服务继续运行，模型的 `keep_alive_after_task` 不是保留授权。详见 [预览生命周期](background-bash-lifecycle.md)。纯计划说明、只读工作流、预先存在但本次未改动的脏文件不触发。
- 完成轮的 `active fileChanges` 是主轮次改动的直接证据；工作流 actor、子 Agent 或 Bash 改动可能不在主轮次摘要中，须以执行开始和结束时目标仓库的 Git 文件差异补足，不得把“主轮次摘要缺席”当作“任务未改文件”。
- 自动流程生成提交信息草稿后，若 Git 状态指纹仍然匹配，则自动打开当前 Git 提交弹窗并预填草稿；不暂存、不提交、不推送。用户仍需在弹窗中检查并确认。
- 状态面板处于 mini 模式、Git 区块收起、仓库原本干净或 Git 文件行级增删数为零时，提交弹窗控制器仍须保持挂载；面板展示状态只能隐藏入口，不能阻断自动草稿的消费。
- Git 摘要加载晚于会话 `running` 边沿时，仍须记录本次运行；完成后等到仓库状态确认可用再生成，不能因异步摘要暂缺丢失唯一完成边沿。
- 后台结果进入父任务后，V4 必须移除对应 `backgroundWorks` 条目。结果在主 turn 内被消费、或多条结果合并启动 continuation，均须逐项结算；不能只更新工具卡或只消费批次代表任务。真实未消费的 `resultPending` 仍阻塞自动草稿。
- 手动“生成/重新生成”与提交信息留空后生成继续复用现有 `IGitService.generateCommitMessage` 路径。
- 发送/停止按钮之后提供“生成提交纪要”图标入口，同样受 `autoGenerateGitCommitMessage` 开关控制：关闭时不显示。开启后，仅可写主会话存在相关文件修改记录且当前 Git 仍有相应变更时显示；无变更、只读、侧聊和草稿不显示。普通、计划和工作流任务复用同一入口。
- 切换或重新打开已完成任务可恢复手动入口，但不补发自动生成。点击后立即打开原 Git 提交窗口，刷新当前会话文件范围并调用一次 AI 提交信息/冻结审核；生成中禁止重复点击。未完成的主任务、子 Agent 或工作流期间入口不可生成；保留的 Bash 预览不阻塞。
- 手动入口与自动入口共用 `GitActionMenu` 弹窗所有者、审核服务和输入状态，不另造提交窗口；已有输入不得被后来到达的自动结果覆盖。跨会话文件只能作为候选范围，归属仍由冻结审核处理。
- 弹窗记录打开请求、DOM 挂载/可见、数据就绪、失败、关闭原因及卸载等受控生命周期日志；“请求打开”不等同于“可见”。自动草稿仅在可见或用户主动关闭后消费，不能在打开请求前消费。加载失败保留窗口与可重试错误，不静默关闭；异步结果在关闭、卸载、切换会话或仓库后失效。
- 提交信息遵循现有 Conventional Commit、当前语言、当前模型与输出校验规则。
- 多会话共享文件的补丁拆分、AI 审核及冻结版本提交遵循 [多会话提交审核](git-session-commit-review.md)。文件路径与运行期 Git 差异只提供候选范围，不再被当作精确会话作者证明。

## 状态所有者与边界

| 状态 / 事实            | 唯一所有者                                                           | 说明                                                                                                                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 会话运行与完成态       | CLI V4 `ConversationSnapshot.control.phase`                          | Renderer 不从消息文本或计时器推测完成。                                                                                                                                                                                      |
| 后台 Bash 生命周期     | CLI Runtime `RuntimeTaskRegistry` 与 ExecutionPort                   | 每个 Bash 后台任务归属启动它的 turn；临时服务在本轮结束时停止，只有经用户 broker 确认的保留请求允许跨 turn 运行。停止请求及终态由 Runtime/ExecutionPort 负责，Renderer 不杀进程。旧任务不因新轮次完成被误停。                |
| 后台结果消费事实       | CLI Runtime 的既有通知持久化入口                                     | 单条/批量通知持久化成功后，逐任务发布 `BackgroundTaskResultConsumed`。V4 只归约该事实，不从主任务文本、子任务终态或超时推断结果已经消费。                                                                                    |
| 完成轮文件改动摘要     | CLI Runtime（`turn-model-step` 发射，bootstrap 投影落到 turnHeader） | CLI 仅在完成模型步（`toolCalls.length === 0`）的 `ModelComplete` 携带本轮跨步累积摘要；工具调用写入由 workspace checkpoint 记录进同一累积表。判断“轮内有文件改动”必须以该投影结果为准，不能按“轮内是否出现过工具调用”推断。  |
| 本次执行的 Git 差异    | 目标 Environment 的 `IGitService`；`SessionPane` 保存执行期基线快照  | 在实时 `running` 边沿读取仓库文件状态及 diff，完成并收尾后再读取；只选本次发生变化且当前仍脏的路径。基线为 UI 临时事实，不写入会话快照，不跨 workspace identity、remote session 或 logEpoch 复用。                           |
| 当前任务文件范围       | 完成轮次 `conversationFileChanges` 与执行期 Git 差异                 | `changeSummary` 可供展示，但不能单独作为自动触发证据，避免上一任务的范围把既有脏文件算进本次。                                                                                                                               |
| Git 工作区状态与 diff  | 目标 Environment 的 `IGitService`                                    | Desktop、本地 Web 与远程 workspace 均通过注入的 Host 服务执行。                                                                                                                                                              |
| 自动生成草稿           | 当前 `SessionPane`                                                   | 草稿是 UI 局部事实，不是 Git、CLI 或服务端事实；不进入 replay/snapshot。                                                                                                                                                     |
| 提交消息输入与提交动作 | `GitActionMenu`                                                      | 继续拥有弹窗状态；自动草稿只触发一次打开请求，不能覆盖已打开弹窗中的用户输入。                                                                                                                                               |
| 手动入口与请求绑定     | `SessionPane` / `GitActionMenu`                                      | Pane 派生开关、当前会话变更范围和可用性，冻结带 workspace identity、remote session、sessionId、logEpoch 的请求；Menu 接受一次请求并统一打开、生成、显示及关闭。当前请求完成前拒绝重复请求，旧 scope 的结果不能更新新 scope。 |
| 面板显示与折叠状态     | `ConversationStatusPanel`                                            | 只决定入口是否可见；不得卸载当前会话的 `GitActionMenu` 弹窗控制器。                                                                                                                                                          |
| 设置持久化             | `ISettingService` / `AppSettings`                                    | `autoGenerateGitCommitMessage` 缺失时按关闭处理。                                                                                                                                                                            |

## 事件顺序

```text
CLI session owner                         SessionPane / Git service
  running ──────────────────────────────> 捕获本执行 Git 基线（含现有脏文件 diff）
    -> 主 turn 收尾：Runtime 停止本 turn 非保留的后台 Bash，确认进程结算
    -> completedSuccess + terminal turn header
    -> 等待 subagents / workflowRuns 等任务结果结算；Bash（含保留预览）不参与闸门
    ────────────────────────────────────> conversationFileChanges(target turn，可为空)
    ────────────────────────────────────> IGitService 读取当前 Git 状态并与基线比较
    -> 合并本轮 fileChanges 与本次 Git 增量的有效文件范围
    -> IGitService.refresh (before fingerprint)
    -> IGitService.generateCommitMessage
    -> IGitService.refresh (after fingerprint)
    -> 指纹一致时发布 SessionPane 自动草稿
    -> GitActionMenu 消费新草稿 key，自动打开提交弹窗
    -> 按当前 Git 状态校验指纹并预填提交信息
    -> 用户确认
    -> 现有 stage -> commit -> optional push
```

不使用超时或 debounce 判定“代码写完”。Runtime 的 turn 完成事件是收尾边界；预览服务的运行状态不推迟自动生成。Bash 终态通知在因 turn 收尾而取消时不得再次唤醒模型开启新轮次。

```text
设置开启 + 当前会话候选文件仍有 Git 变更 -> Composer 发送按钮后显示手动入口
用户点击 -> Pane 冻结 scope / 会话上下文 / 候选文件 / request key
         -> 同一 Menu 打开 -> DOM 可见 -> Git refresh -> 一次 generateCommitMessage
         -> 当前请求仍有效才预填；失败留窗可重试；关闭/换会话使旧请求失效
切换已完成任务 -> 恢复入口，不生成、不自动弹框
```

```text
后台任务 owner -> 终态与通知入父 runtime CommandQueue
父 runtime     -> 持久化通知（active-loop 内联 / outer-drain 批量共用入口）
               -> 每条通知的 BackgroundTaskResultConsumed(workId, lifecycleId, messageId)
V4 projection  -> 移除该代 work，记录消费水位，拒绝迟到终态重新挂出 resultPending
               -> 新启动 / SendMessage resume 建立新代；旧通知不能移除新代 running work
Desktop        -> continuous 同一 state.updated delta
手机 Web       -> replayable 通过同一事件归约 / snapshot 恢复，无客户端第二份队列
```

`RuntimeTaskRegistry` 为每次后台生命周期保存唯一 `lifecycleId`（Agent 复用现有执行 span，其他任务由 registry 首次注册生成）。通知入队时固定该 id，生命周期事件与消费事件使用同一个 id；跨 resume 保持 workId / toolCallId，但更换 lifecycleId。消费幂等以 lifecycleId 为界，不按计时器或时间戳猜测代次。

消费事件区分 `activeLoop` 与 `continuation`。前者在运行中的主 turn 内直接结算；后者在 `TurnStarted` 的同一投影事务中移除已消费条目，同时进入 running，避免“后台清空但 continuation 尚未开始”的短暂 completedSuccess 被误当成最终完成。消费侧表随投影的 atomic clone / adopt 一起提交；拒绝发布的候选投影不得污染当前实例。

冷合并时以消费事件的持久 `messageId` 找到对应 hydration turn，把消费事实放在该轮起点。不能把 continuation 的消费追加到全部正文之后，否则重连又会留下假 `resultPending`。没有对应持久正文时按原内存事件顺序归约，保持在飞生命周期的权威。

## 幂等、隔离与失效

- 触发 key 包含 `workspaceIdentity?.trim() || workspacePath`、`remoteSessionId`、`sessionId`、`logEpoch`、`turnId`、`rowId` 与 `entityId`。
- 同一草稿 key 只自动打开一次；用户已经打开提交弹窗时不重新打开、不覆盖当前输入；用户关闭后不会因同一 key 再次弹出。新完成轮生成新 key 后才允许再次自动打开。
- 冷恢复直接落在 `completedSuccess` 时不生成；只有当前 renderer 先观察到 `running` 才武装触发器。
- 基线读取晚于完成边沿时，等待该次读取结束并用最终 Git 状态比较；不使用固定超时。基线读取失败时仍允许主轮次 `active fileChanges` 路径，不能把全部既有脏文件当成任务改动。
- 同一完成边沿只发起一次生成。切换 workspace/session/logEpoch、关闭设置、会话重新运行时清除旧 target 与草稿。
- 生成前后对当前任务范围内的 staged/unstaged 文件列表、状态与增删行数计算稳定指纹；调用期间发生变化则丢弃结果。
- 打开提交弹窗时按自动草稿的原文件范围再次计算指纹，不混入其它 task meta 路径；不一致时不预填旧草稿，显示过期原因，用户仍可手动生成。
- `workspacePath` 只用于 Git 文件操作；隔离 key 使用 workspace identity fallback，并包含远程 session。

## 失败语义

- 无文件改动、Git 不可用、非仓库、模型不可用、请求失败、输出不合规或指纹变化均不阻塞任务完成。
- 正式版的自动生成诊断使用受控生命周期日志；普通 `logger.info` 在生产 renderer 被禁用，不能作为现场可观察性依据。
- 无文件改动等未生成结果只记录可恢复诊断日志。冻结审核返回失败结果时仍使用同一实时 Git 弹窗显示原因，不阻塞任务完成；错误不能被当成草稿成功或被预填校验丢失，不清除已打开弹窗中用户输入的信息。
- 武装周期内到达 `completedSuccess` 却无可触发完成轮时（如完成轮缺 active 文件摘要、子 Agent 或工作流未收尾），记一次可恢复诊断日志并在下个 `running` 边沿重置，不重复刷屏。
- 手动生成继续使用现有错误提示与重试入口。
- 自动生成不会更改 Git index、HEAD、branch 或 remote。

## 验收场景

1. 设置开启，聚焦会话从 `running` 进入 `completedSuccess`，本轮有文件改动且无后台工作：只生成一次，自动打开 Git 提交弹窗并预填。
2. 设置关闭、冷恢复已完成会话、非聚焦会话、只读会话、侧聊、失败或中断：不自动调用模型。
3. 完成时仍有子 Agent 或工作流：保持已武装状态；它们结束后再生成，不使用定时等待。
   3a. 当前 turn 的普通后台 Bash 随成功完成自动停止；前一 turn、另一会话的 Bash 不受影响。取消产生终态但不额外唤醒模型。
   3b. 经用户确认 `keep_alive_after_task` 的 Web/服务端预览仍在运行时，本 turn 的 Git 修改照常生成中文草稿并自动弹窗；已有旧版未标记的运行中 Bash 也不能把弹窗永久卡住。未经确认不得常驻。
4. 本轮无文件改动或文件已回滚：不生成。
5. 完成轮次有文件详情或执行期 Git 差异：生成与提交弹窗只包含本次确有证据的文件；task meta 摘要仅供展示，不单独触发。
6. 生成期间文件、暂存状态或增删行数变化：丢弃生成结果。
7. 生成后 Git 状态变化：提交弹窗不预填过期草稿。
8. 用户已打开弹窗并编辑文本：之后到达的自动结果不覆盖输入。
9. 自动生成失败：任务保持完成，现有手动生成与手动输入可继续使用。
10. 本地与远程 workspace：均由当前 ServiceProvider 中的目标 Host Git 服务读取与生成，不直接调用 `window.lcode`。
11. 状态面板为 mini、窄屏 auto 或 Git 区块收起：本轮草稿仍自动打开并预填；恢复展开后手动入口仍正常。
12. 会话开始运行时 Git 摘要尚未加载，完成后才显示仓库可用：等待摘要就绪并只生成一次；确认非仓库时不生成。
13. 工作流 actor 或子 Agent 写 Git 文件而主轮次 `fileChanges` 为空：待所有工作结束，以执行期 Git 差异定位本次文件并自动打开中文提交信息草稿。
14. 普通、计划模式或工作流只读完成，仓库只有任务之前的脏文件：不生成、不弹窗。
15. 已有脏文件在任务中被再次修改，即使增删行数不变，只要 diff 内容变化仍算本次修改；任务写完又还原则不生成。
16. 后台 Agent / workflow 结果在主任务运行期间内联消费：对应 `resultPending` 消失，主任务实时成功完成后自动生成；运行中的保留预览服务不阻塞。
17. outer-drain 合并多条通知：每个 work 分别移除；尚未消费的其他 work 保持原状态。重复消费幂等，消费后迟到的终态不复活条目。
18. 同一 workId 恢复新生命周期：旧通知迟到不得移除新一代；新一代仍等待自己的终态与消费事实。continuous delta 与 replayable 冷合并 / 快照结果一致。
19. 大中文文本跨 Git 数据块读取保持准确；审核成功预填中文。审核失败或弹窗打开前过期显示明确原因，不出现无提示、可直接审核提交的空弹窗。
20. 开关关闭时发送按钮后无手动入口；开启后，两个已完成且仍有相关 Git 变更的会话切换均显示入口。无修改会话不能因另一会话的脏文件而出现入口；提交/还原相关变更后入口消失。
21. 手动点击立即显示窗口并只生成一次；重复点击、React effect 重跑、切换会话和生成中关闭均不能重复请求或串写。用户可显式重试；不会自动提交/推送。
22. mini、auto 窄屏、区块折叠及桌面/Web 使用相同手动请求与弹窗路径；日志区分请求、实际可见、失败、关闭与卸载。加载失败不消失，关闭后旧加载和 AI 结果不复活弹窗。

## 验证

### 2026-10-01 手动入口与生命周期验证

- 按 architecture-governance 保持 `GitActionMenu` 为唯一弹窗所有者：SessionPane 发带 workspace/remote/session/logEpoch 范围的手动请求，目标 Host 负责文件读取与纪要生成；关闭/卸载使旧代次失效。共享 UI 同时服务 Desktop continuous 与 Web replayable，无新增订阅、协议写接口或平台专用分支。
- 28 项定向 Node 测试通过，涵盖历史分页、回滚、宿主子任务范围、开关与权限、完成闸门、加载/生成代次和折叠面板接线。
- `packages/web/test/git-commit-dialog.test.mjs` 的 9 项浏览器测试通过，使用真实共享组件与桩 Host：冷切换不生成、无关脏文件不显示、只生成一次、不改输入草稿、工作流范围、关闭/切换后迟到结果失效、加载/生成失败显式重试、自动弹窗不覆盖编辑、桌面与 390px 窄屏浅/深色确认框首行中心偏差小于 1px。测试无真实模型调用、Git 提交或用户数据写入，浏览器与 Vite 服务在结束时关闭。
- 根 `pnpm typecheck`、`pnpm lint`（0 warnings/errors）、`pnpm architecture:check --changed`（0 violations）、`git diff --check` 通过；20 个触及文件格式检查通过。全仓 `pnpm fmt:check` 报告 2602 个既有未格式化文件，未批量修改无关文件。
- 影响模块为共享 UI，Web 仅新增测试夹具。当前这些 UI 受跟踪文件相对 HEAD 为 +1527/-417 行（净 +1110），包含本次开工前已有改动，不能把它作为本次补丁独立行数；新建源文件与测试另列在工作树中。未改变服务的 AI 审核或提交权限边界。
- 正式版 Windows x64 构建完成：`LCODE_ENV=production`、`LCODE_PREVIEW_IDENTITY=0`。首次完整 bundle 在重复准备 node-repl-host 时遇到 Windows TS5033；单独重建该插件成功，随后复用本轮已成功编译的 Agent/远端资源、重新暂存本地资源并执行 `build:no-runtime-assets`，最终以 `--skip-prepare --skip-build` 封装已完成步骤的产物。运行依赖、正式产品身份和包体积校验全部通过，未跳过最终校验。
- 新包 `packages/desktop/dist/LCode-3.16.5-win-x64.exe`，150347591 bytes，2026-10-01 07:21:30（Asia/Shanghai）；SHA256 `BEB845F2A7F96F8B03DF883864ACD55891DAD504BF3CACD471F7B11C938B87BF`。只读检查 app.asar 确认手动按钮、作用域请求、请求/已显示生命周期及确认框对齐均在新包内；包内 Agent 与本轮源产物 SHA256 相同。未安装或替用户运行真实任务，实际模型与安装版验收由用户继续测试。

以下为既有与新增验证入口：

- 纯状态机测试：武装、成功终态、冷恢复、后台阻塞、禁用与 scope 切换。
- 投影链路测试（bootstrap `turn-file-changes.test.ts`）：完成轮 `ModelComplete.fileChanges` 落 turnHeader 且满足闸门前置；中间工具步与 `files=0` 不投影。
- 文件指纹测试：任务范围过滤、顺序稳定、staged/unstaged/增删变化失效。
- AppSettings schema 测试：默认关闭，patch 接受布尔值。
- 交互场景：完成后自动生成、打开提交弹窗预填、用户编辑不被覆盖、Git 变化后草稿失效。
- 交互场景：mini / 窄屏 auto / Git 区块收起时完成任务，弹窗仍自动打开；Git 摘要晚于运行边沿加载时不漏触发。
- 交互场景：任务中启动预览服务，完成时服务仍运行，Git 提交弹窗照常打开且内容预填；用户仍可手动停止服务。
- 执行仓库提供的 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 与 `pnpm fmt:check`。
