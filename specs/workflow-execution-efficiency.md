# 工作流执行效率与等待原因可见性优化方案

- 日期：2026-10-01
- 状态：第二轮已补执行自动验证，插件分发夹具、UI 断言及 workflow-driver 行数问题均已修复并通过相关回归（§12–13）；全 CLI 仍有其他历史 Lint 问题，真实模型效率与持续压力评测不宣称完成。
- 范围：工作流生成指导、长任务的活动观察、等待原因展示、非阻断的编排建议。
- 最新交付：修复等待时间 SSR 断言，并提取既有 actor 会话身份校验以满足驱动行数限制；校验顺序和状态所有者不变，不创建、恢复、修订或停止已有用户工作流。

## 1. 结论与依据

**先改善任务拆分，随后补齐活动解释，最后用检查和对照评测防止退化。** 不以提高并发上限、缩短模型超时或自动切换模型作为第一步。

用户提供的调查结论是：工作流会话的首个接口冻结任务阻塞了后续执行，大量不返回文本的推理与断流重试进一步拉长等待；没有发现调度器死锁。普通会话复用了前一会话的部分调查，因此不能直接用两次总耗时证明框架性能差异。本方案采用这一背景，不重新计算原日志中的请求耗时和推理占比。

本次从当前检出源码核实了以下边界：

1. 原草稿 `.lcode/workflow-drafts/实施-Git-提交与发布增强.dwf.ts:127` 先 `await service.ask<Design>`，要求跨 shared/services/UI 冻结完整契约；UI 复核在第 131 行才调用，公开契约实现还要等到第 150 行。后续 actor 的声明不等于它的 ask 已启动。
2. `create-workflow-description.ts:64` 和内置 `dynamic-workflows/SKILL.md:203,313` 已要求适度验证、窄结果、尽早并行。因此优化不能只再增加一句“多并行”，而要补充明确的单次任务边界与完成条件。
3. `workflow-driver-helpers.ts:262` 的 `reportTurnObservations` 在一次 `executeTurn` 返回后报告进度和用量。一个 ask 内可以执行多次模型请求和工具调用，但 typed ask 要等结果被接受后才兑现；现有轮次进度不是请求级实时活动。
4. `workflow-driver-concurrency.ts:208` 已观察请求排队、启动、完成和重试，并具有默认 20 分钟的 run 级连续重试提示。已有 provider 准入、退避、恢复锚点与终态处理，不需要再造一套重试调度器。
5. 当前未提交改动已在补充请求均速和“等待用量”展示，见 `specs/conversation-session-token-statistics.md`。它改善速度可见性，但不能解释为什么其他分支尚未开始；本方案复用并保留这些改动。

## 2. 目标与非目标

### 目标

- 无真实依赖的调查尽早开始，不让一个“完整设计”任务占据整个前置阶段。
- 每次 ask 尽快返回一个下游可消费、可验证的交付，而不是反复扩大调查范围。
- 用户能区分未启动、模型请求处理中、工具执行、等并发槽位、退避重试及等待主代理答复。
- 隐藏推理没有实时证据时诚实显示不可观测，不伪造推理进度或 Token 速度。
- 用相同任务起点和验收标准衡量效率，不能以少做验证换速度。

### 非目标

- 不重写调度器，不修改默认并发、模型、推理档位或速度设置。
- 不按固定时长自动取消 ask、切模型、重跑工具或修订工作流。
- 不自动改写用户已经批准的脚本，不恢复用户已停止的任务。
- 不削弱接口、权限、发布安全、幂等和外部副作用校验。
- 不新增 Renderer 运行状态所有者、业务队列、用量账本或调试日志轮询。

## 3. 第一批：任务生成与交付边界（P0，优先实施）

### 3.1 单次 ask 的边界

在生成规则中要求每个非平凡 ask 交代以下内容；这是提示词约束，不是新增运行时 API：

| 项目     | 要求                                                                                 |
| -------- | ------------------------------------------------------------------------------------ |
| 本次目标 | 一个明确交付；调查、接口决定、实现和最终全量验收不塞进同一次 ask。                   |
| 输入     | 已有 spec、相关路径和必要结论；不反复附整份历史、全量源码和全部检查日志。            |
| 范围     | 负责的领域、允许修改的文件、禁止修改的共享部分。范围按行为切片，不按任意文件数硬切。 |
| 完成条件 | 哪些接口或事实确认后必须返回，不继续调查不影响当前决策的领域。                       |
| 结果     | 短结论、证据路径、下游所需契约、未解决阻塞；字段只保留下游真正使用的内容。           |
| 不完整时 | 返回阻塞及缺少的证据，不用假实现或猜测交付“已完成”；只阻塞依赖它的分支。             |

任务粒度以“可独立验收的行为”为单位，不要求一次工具调用一个代理，也不要求每几个文件强行返回。安全不变量属于本切片完成条件，不能因缩小交付而略过。

复用同一领域 actor 的后续 ask，保持已有上下文；独立调查使用不同 actor。同一 actor 的多个 ask 仍是 FIFO，不能把它误当作并行。

### 3.2 默认编排形状

```text
核对基线与文件所有权
    ├─ 服务侧只读调查：已有公开接口、缺口和约束 ─┐
    └─ UI 侧只读调查：消费者需求与测试入口 ─────┴─ 本批最小契约 + spec
                                                      单一写入者
                                                        │
                       ┌────────────────────────────────┴─────────────────────┐
                       │                                                      │
               服务切片：测试 → 实现 → 定向检查                      UI 切片：测试 → 实现 → 定向检查
                       │                                                      │
                       └──────────────── 所有相关写入完成 ────────────────────┘
                                               │
                                   必要的集成检查与独立复核
                                               │
                                   最终代码版本的统一验收
```

- “最小契约”包括本批实际需要的类型、错误语义、唯一状态所有者和安全边界，不是省略这些内容。暂时无关的未来接口不作为全部工作的前置条件。
- UI 可以先调查消费者、测试和布局约束；依赖新接口的实现仍须等待该接口确定。不能一边猜接口一边让两个代理改同一文件。
- shared/spec 等公共文件由一个写入者负责；其他分支返回需要的修改，不直接竞争写入。
- 基线检查统一运行。读取工作区的检查可与只读调查并行；必须在行为修改前记录完成，不能把修改中的检查输出称为原始基线。
- 每条独立分支就绪后即可进行其定向验证；全局集成检查必须等待相关写入结束，避免边写边测产生不可归属结果。
- 修复后重跑受影响检查，最终验收针对最后一次代码变更。由脚本执行的整套检查不要让每个 actor 重复跑；不取消必要的独立安全复核。
- 小任务只保留必要角色，不把这张示意图强制套成固定五阶段、固定多个代理。

### 3.3 修改入口与交付

先更新 `specs/workflow-script-submission-and-revision.md`，再调整：

- `apps/lcode-cli/packages/core/src/tool/handlers/create-workflow-description.ts`：仅保留短的单次任务边界与依赖自检规则，不膨胀常驻工具描述。
- `apps/lcode-cli/packages/lemon-workflow-plugin/skills/dynamic-workflows/SKILL.md`：增加大接口冻结的反例、按领域调查的正例、单写入者和就绪即验证的说明。
- `apps/lcode-cli/packages/core/src/tool/handlers/workflow-tool-description.test.ts`：保留描述长度预算和 facade 约束；补充必要规则的回归。

内置插件源码是维护入口；不直接修改用户目录下的插件缓存。后续需按现有插件构建与加载路径核实发布结果，不能仅修改仓库文档就声称安装版已采用新规则。

**P0 验收重点：** 在受控测试中，独立 UI 调查的 ask 在服务调查交付前已经入队；供应商是否同时准入由现有治理器决定。需要真实契约的实现不提前执行；不增改并发参数或降低检查强度。

## 4. 第二批：长 ask 的活动事实与等待解释（P1）

### 4.1 复用现有权威链路

```text
workflow 脚本调用 ask
    → Engine / Scheduler：ask 的入队、准入、attempt 与结算
    → child runtime / adapter：请求、可见流事件、工具与重试事实
    → workflow driver：按当前 ask 关联、限量汇总
    → 现有 report sink / journal：活动观察
    → ProductProjection：父会话工作流读面
        ├─ desktop-continuous
        └─ web-remote-replayable：快照与缺口恢复
    → 同一 UI 派生选择器：时间线、详情侧板、状态摘要
```

- Engine/journal 继续拥有 run、ask 与终态；adapter/runtime 拥有请求和工具执行事实。
- driver 只关联并汇总事实，不新增调度、终止或重试决策。
- ProductProjection 派生协议读面；Renderer 只解释事实，不把本地计时变成执行事实。
- 隔离继续使用 workspace identity、session、run、actor、ask、attempt；请求活动另按 request id 关联。旧 attempt、旧连接或已终态的迟到事件不能覆盖新状态。

### 4.2 活动摘要的语义

在现有工作流 observation/progress 契约上增量扩展可选活动摘要，不改变现有 `turn` 的口径，也不新增数据库表。

1. **最近观察到的活动**：请求启动/结束、非空文本或推理增量、工具开始/结束；保留源事件时间。网络静默时不凭空刷新。
2. **最近成功请求**：成功完成的请求时间与已有准确用量。请求数与 `executeTurn` 轮数分开命名，未知时不显示假计数。
3. **最近交付**：ask 的结果被接受或节点完成；工具调用、心跳和重试不冒充交付。
4. **权威等待**：已有 slot/backoff、等待起点、下一次重试时间、原因类别、请求尝试次数；能区分的 actor FIFO/run 准入等待沿用对应 owner 的事实。
5. **执行位置**：当前 ask、最近工具名称、已有工具调用次数。只显示必要名称和统计，不搬运工具参数、请求正文、推理内容或原始 provider metadata。

现有 `lastProgressAt` 不静默改名或改义。上述时钟须分别表达，不能用 run `updatedAt` 或 UI 接收快照的时间替代。

状态切换、重试开始/结束和终态立即更新；高频文本、推理和工具增量合并为有界摘要，目标为每个活动 ask 每秒最多一次普通活动更新。只合并展示事件，不延迟权限或控制命令，不每个 delta 广播完整 run；无源活动时不发送假 heartbeat。冷恢复缺少旧摘要时显示未知，不把恢复时刻当作刚刚活动。

### 4.3 本批实施契约

- 引擎新增纯观察 `askActivity(instance, activity)` / `node-activity`，其中 `activity` 是完整有界摘要：`kind: model | text | reasoning | tool | unknown`、源事件时间 `observedAt`、本状态开始时间 `since`、`requestsCompleted`、`toolCalls`，以及可选 `requestId`、`toolName`、`lastRequestCompletedAt`。它不改变生命周期、不增加已交付步数、不触发控制。`unknown` 表示当前没有足够证据确认在执行哪类活动，不表示失败。
- 请求完成数只数本 ask 内已观察启动且成功完成的物理请求，不从 turn 数推断。重复完成和旧请求不能重复计数或改变当前活动；有多个在飞请求/工具时摘要必须反映仍在飞的工作，不能由一个分支完成清空其他分支。
- driver 只接纳当前 ask/turn 的源事件；reset、取消和释放会撤销尚未发出的摘要，节流回调绑定原 ask/attempt，不能把旧活动写到新尝试。流事件缺少请求身份时只关联当前已观察到的主请求，归属不确定则不宣称正在输出思考。
- `DynamicWorkflowRunProgressPayload` / shared envelope 新增可选 `occurredAt`，取 journal `StoredEvent.timeCreated`，live 和 replay 使用同一来源，不调用 UI 当前时间补齐旧记录。
- live node 增加可选 `activity`、`wait: { cause: slot | backoff, reason?, attempt?, since?, nextRetryAt? }`、`settledAt`。wait 来自既有 `node-waiting`，`nextRetryAt = occurredAt + delayMs`；其他生命周期事件清除 wait。重排队、重试、缓存结算不继承上一世的活动。`settledAt` 是任意结算时间，只有 `outcome: ok` 才能称为最近交付。
- 活动事件在节点终态、暂停、旧 attempt、旧 sequence 时拒绝；等待/执行观察也不得越过这些门。节点生命周期仍只从原事件读取。run 终态保留历史统计但不展示成当前正在执行。
- CLI roster 按 actor FIFO 选取最早未结算 ask，不能把后入队的 `running` journal 行当作当前正在执行。入队即写 running 不等于获得执行槽位；主界面已按节点相位区分，观察卡不反向发明新运行状态。
- 工具 schema 的 Zod 3 与 shared V4 schema 的 Zod 4 使用各自边界定义，通过兼容测试核对形状；不得把两个版本的 schema 直接嵌套。
- 旧数据缺字段时保持可读和未知；新活动 schema 严格校验，不接受负数、非整数时间/计数、超长标识或未知字段。归约不为缺失节点创建假活动。

### 4.4 用户看到的含义

| 已确认事实               | 推荐展示                                                      |
| ------------------------ | ------------------------------------------------------------- |
| 脚本尚未调用后续 ask     | “此阶段尚未开始”；只有可靠依赖证据时才补充“等待某项交付”。    |
| 已请求模型，没有可见内容 | “模型请求处理中，尚无可见输出”；速度复用已有“等待用量”。      |
| 实际收到推理增量         | “正在输出思考”；不暗示能看到供应商的全部内部推理。            |
| 工具开始且尚未结束       | “正在执行工具：名称”，可附工具耗时。                          |
| 明确等待准入             | “等待并发槽位”；不得用它解释尚未调用的分支。                  |
| 明确退避重试             | “第 N 次重试，预计 X 秒后继续”，提供归一化原因。              |
| 待主代理回答问题         | “等待主代理答复”，复用现有问题行。                            |
| 连接正在恢复             | “同步中，当前为上次状态”，作为连接提示，不写成 run 等待原因。 |
| 没有足够证据             | “活动状态暂不可确认”，可展示最后观察时间，不显示“死锁”。      |

- 保留现有五态生命周期；上述信息是次级活动说明，不引入第六种状态图标。
- 重试从第一次起可以查看原因与下一次时间，不必等到第三次才解释；无限重试预算不能显示成“最多 0 次”。
- 胶囊保留紧凑摘要，详情提供完整原因；手机通过点击打开，不能只有 hover 才能看到。遵守现有字号、主题和中英文规范。
- 未启动 actor 不创建子会话订阅。工作流概览使用父投影，不能为每个 actor 增加长期调试订阅。
- 精确 reasoning Token 仅在供应商提供用量后展示；outputTokens 已包含推理分类时不得重复相加。均速与实时可见估算继续使用已有共享组件。

### 4.5 重试与兼容边界

P1 不改变现有 provider 重试、退避、stream recovery、AIMD 或默认超时。既有 20 分钟提示保留，不额外加入“超时自动拆分/恢复”策略。分支级健康告警只有在活动数据完备后再评估，不能先用计时器猜测卡死。

新增字段必须同步 CLI 契约、shared V4 strict schema、在线投影和冷恢复读取路径，并覆盖完整帧与分片。新消费者应继续接受缺字段的旧快照；**可选字段不等于旧 strict 消费者能接受新字段**。桌面和手机 Web 消费端需按现有发布边界分别验证，不能以桌面升级替代手机资源更新。

### 4.6 主要落点

- `apps/lcode-cli/packages/contracts/src/interfaces/dynamic-workflow-run.port.ts`
- `apps/lcode-cli/packages/contracts/src/interfaces/dynamic-workflow-run-roster.port.ts`
- `apps/lcode-cli/packages/bootstrap/src/app/workflow-driver-concurrency.ts`
- `apps/lcode-cli/packages/bootstrap/src/app/workflow-driver-tool-activity.ts`
- `apps/lcode-cli/packages/bootstrap/src/app/workflow-driver-helpers.ts`
- `apps/lcode-cli/packages/dynamic-workflow/src/engine/engine.ts` 及现有观察事件类型
- `apps/lcode-cli/packages/bootstrap/src/lcode-protocol-v4/product-projection.ts`
- `packages/shared/src/lcode-protocol-v4/workflow-runs.ts`
- `packages/ui/src/components/workflow-timeline/timeline-model.ts`
- `packages/ui/src/app-shell/WorkflowRunSidePane.tsx` 及其共享展示组件

实现前同步更新 `specs/workflow-run-status-presentation.md`、`specs/workflow-observation-display-compatibility.md`；速度口径继续由 `specs/conversation-session-token-statistics.md` 约束。上述为影响入口，不要求把所有文件都改一遍。

## 5. 第三批：非阻断编排建议（P2）

复用现有 `analyzeWorkflowScript`、因果图和控制流图，在确认前提示可观察到的等待结构。首批只考虑能精确定位的两类候选：

1. 某个 await 使当前路径后面的多个 actor 调用必须等待。
2. 一个全量 join 使后续工作等待所有分支，而作者可能只需要对应分支的结果。

提示包含源位置和已知控制依赖，用“检查能否提前开始独立工作”等措辞；不能因为没看到变量数据依赖就断言没有文件、权限、actor 上下文或外部副作用依赖。合法安全串行不应被要求改成并行。

- 新建议与阻断性的编译 `diagnostics` 分开。当前 `analysis/analyze.ts` 的任何 diagnostic 都会影响 `ok`，不能把性能偏好塞进该数组。
- 不自动重排、分裂 ask、添加 actor、改 phase 或提高并发上限。
- “任务太大”首先由 P0 的边界模板改善；不引入一个额外模型调用来审查每个脚本的大小。
- 若现有图无法给出可靠位置或候选关系，宁可不提示。先补误报测试，再决定是否向用户开放。

## 6. 验收场景

以下为实施验收场景；第二轮交付及待验证范围见 §8，第一轮历史执行结果见 §9。时间相关用例使用假时钟和受控事件，不真实等待数分钟。

| 场景             | 设置与动作                                      | 必须断言                                                           | 证据层                   |
| ---------------- | ----------------------------------------------- | ------------------------------------------------------------------ | ------------------------ |
| 独立调查尽早启动 | 服务调查延迟，UI 调查不依赖其结果               | 两个 ask 已入队；服务未交付不阻塞 UI 调查；供应商 cap=1 时合法排队 | 生成样例 + engine/driver |
| 真依赖保持串行   | UI 实现依赖公开契约                             | 契约未通过时不执行依赖实现；共享文件只有一个写入者                 | 脚本 + 隔离工作区        |
| 长 ask 多次活动  | 不返回 typed 结果，连续完成请求和工具           | 活动摘要更新，但交付数不增长；请求数不使用 turn 数代替             | driver + projection      |
| 完全隐藏输出     | 请求在途，没有正文、推理 delta 或实时 usage     | 显示请求处理中；速度未知，不显示正在推理或 0 token/s               | 协议 + UI/E2E            |
| 正常工具长执行   | 工具 started 后延迟 completed                   | 不误判模型断流；最近活动与执行耗时区分                             | runtime + UI             |
| 两次断流后成功   | 发出 retry、backoff、completed                  | 首次重试可解释，成功后清除旧等待；不从 UI 重执行工具               | driver + UI/E2E          |
| 排队和未启动     | 一个 ask 等槽位，另一个尚未被脚本调用           | 两者原因不同；未启动 actor 没有虚构子会话                          | engine + UI              |
| 迟到与重复事件   | 旧 attempt、重复完成、新请求已启动              | 不覆盖新状态，不重复统计；终态不被重新点亮                         | driver + projection      |
| 连接恢复         | continuous 在线及 replayable 恢复，完整帧与分片 | 同一运行事实，源活动时间不变；连接提示不污染 run 状态              | protocol + UI            |
| 冷恢复与旧数据   | 缺活动字段或未完成旧请求                        | 旧记录可读；未知不补零；不声称已在后台恢复执行                     | journal/projection       |
| 停止与修订       | 用户停止；后续显式恢复或修订                    | 不静默重启；保留缓存、lineage、attempt fence 和副作用边界          | lifecycle 回归           |
| 展示压力         | 大量 delta、多 actor、截断节点列表              | 有界节流，状态切换及时；不伪造全程百分比                           | projection + UI 性能用例 |
| 提示误报         | 安全串行、同 actor FIFO、条件分支和独立并行     | 不阻止合法脚本，不自动改写；依据不足不发性能结论                   | analysis 单测            |
| 窄屏与可访问性   | 1280/390px、中英文、亮暗主题                    | 原因可点击访问，不溢出，五态与原入口不退化                         | Web E2E                  |

禁止或不纳入的组合：按 elapsed 自动重跑有副作用操作、用隐藏 Token 估算速度、为了指标减少验收、让手机另建运行时。对应保护不变量分别是显式控制、用量来源真实、任务范围一致和复用同一 Host。

## 7. 验证入口与效率评测

### 7.1 实施时的验证

- 先按 `architecture-governance` 执行架构基线与目标模块受控上下文；spec 和失败用例先于行为修改。
- 现有可复用测试：`workflow-tool-description.test.ts`、`scheduler-controls.test.ts`、`workflow-driver-controls.test.ts`、`workflow-import-reuse.test.ts`、`dynamic-workflow-run-lifecycle.test.ts`。
- 当前工作区已有的 `workflow-observation-compatibility.test.ts`、`model-output-statistics.test.ts` 与 `sessionOutputSpeed.test.ts` 需保留回归，不能由新状态功能替代。
- 已新增活动观察、编排建议测试，以及 `packages/web/test/workflow-execution-progress.test.mjs` 和专用 fixture；测试挂载真实共享时间线、阶段清单、确认块与 ConversationProjectionStore，不调用真实模型或创建真实工作流。
- CLI 的 `node:test` 用例使用其现有 `tsx` 入口；UI 没有 test script，定向运行需以 `packages/ui` 为 cwd，不能假定有统一工作流测试命令。

实施后的统一检查包括：

```sh
pnpm --dir apps/lcode-cli typecheck
pnpm --dir apps/lcode-cli lint
pnpm typecheck
pnpm lint
pnpm architecture:check --changed
pnpm --dir packages/web test
```

根目录 `typecheck` 不覆盖 CLI 的全部项目，因此实施 CLI 改动不能只跑根命令。CLI typecheck 可能触发依赖构建，需记录实际耗时与环境限制。桌面安装版、手机托管资源发布和真实供应商负载不由 fixture 测试代替。

### 7.2 公平对照

先做受控 provider/假时钟测试证明依赖顺序，再做小样本真实模型试验；本次不调用真实模型开展评测。

对照必须固定：任务与验收清单、包含未提交内容的初始工作区快照、供应商、模型、`max/fast` 设置、工具权限及检查命令。旧/新脚本各从同一起点开始；不能让一组继承另一组的会话调查。冷/热缓存与供应商退避单独记录，按配对并交错顺序运行，避免把某段网络更快误算成优化收益。

记录：

- 第一个符合预先声明验收条件的交付时间，而不是第一次日志或文件编辑时间。
- 独立分支 ask 入队时间，以及真正获得 provider 准入的时间。
- 各 ask 的成功请求数、工具调用数、交付间隔与准确用量。
- 请求处理、准入等待、退避和工具执行各自耗时；不把重叠活动简单相加。
- 最终验收完成时间、成功率和未完成项。

建议先运行 5 对探索性样本，报告中位数、范围及异常原因；不以该规模宣称稳定 p95 或固定加速倍数。P0 必须消除样例中的非必要前置等待，P1 必须准确解释上述状态；总耗时改善需要真实对照数据后再下结论。所有检查强度和最终交付质量必须相同。

## 8. 补齐实施契约（2026-10-01 第二轮）

本轮补齐排队与执行状态、跨 ask 的最近交付、主会话状态摘要、等待时长和静态工具卡的一致性，并整理相关工作流模块。用户明确本轮验证由其自行执行：只修改实现与回归用例，不运行测试、类型检查、Lint、构建、压力评测或真实模型对照，不进行安装/发布。下列验证要求作为交接清单，不代表本轮已执行。

### 8.1 排队与交付的唯一事实来源

```text
脚本调用 ask → Scheduler 串行 admission
                    ├─ 同 actor 前项未结束：node-admission(actor-fifo, blockedBy)
                    ├─ 本 run 并发名额已满：node-admission(run-capacity)
                    └─ 实际派发：node-dispatched → 清除 queue
                             ↓
                driver: provider slot/backoff / request / tool
                             ↓
              原 journal → 同一个 shared reducer → UI / 工具卡
```

- Scheduler 只为已经入队的 ask 发可去重 `node-admission` 观察，载荷 `instance`、`cause: actor-fifo | run-capacity`、可选同 actor 的 `blockedBy: {siteId,ordinal,attempt?}`；只报告现有泵的判断，不改变调度顺序、名额或重试。获得名额但仍在创建 actor 会话的窗口，用 `cause: null`（不带 blocker）显式清除既有 queue；不提前发送 `node-dispatched`，首次没有旧原因时不增加 clear 事件。
- live node 新增可选 `queue: {cause: actor-fifo | run-capacity, since?, blockedBy?}`。`since` 来自 journal 的 `occurredAt`；原因变化开启新的等待段。派发、暂停、重试、结算清除；旧 sequence、旧 attempt 不回退。provider 等待仍是原 `wait.slot/backoff`，不能混为一种名额。
- CLI roster 的 coarse `state` 保持原闭集以避免旧 strict 枚举不兼容；有未完成 ask 但节点 `queued/dispatched/paused` 时读作 waiting，具体在 `currentAsk.phase`、`currentAsk.queue` 中明确说明，不再因 journal 行为 running 就说 executing。缺历史事实时保持未知，不伪造执行证据。
- 最近交付由成功、非缓存节点的真实 `settledAt` 推导，同 actor 新 ask 开始时仍保留上一次已观察交付；不把当前活动、失败结算、缓存重放或 unknown 当作新交付。阶段视图只读取当前绑定 ask 之前的同 actor 节点前缀，不把未来阶段的交付倒灌旧阶段；节点窗口被截断时只声明“已观察的最近交付”，不假定窗口覆盖全历史。CLI 名册可从本次已读的全量 journal 取 `lastDeliveredAt`，不增加 UI 持久化账本。
- 主会话状态面板、聊天时间线、详情和静态观察卡共用同一活动解释。状态面板从已有父投影读取，不额外订阅子会话；恢复时沿用现有 display-only syncing/stale 闸门。
- 详情展示等待起点和已等待时长。实时视图使用已有父级秒针；静态卡固定使用 `generatedAt`，显示并行工具、最近活动、最近成功请求、已知成功请求数和工具数，不因 waiting 分支丢弃这些事实。

### 8.2 本轮验收与外部边界

- 用受控 scheduler 测试分别覆盖 actor FIFO、run capacity、已派发未请求、provider slot/backoff、暂停、旧事件和冷回放。新增字段的 CLI Zod 3 与 shared Zod 4 契约同步验证。
- 用多 ask/多 actor 验证最近交付与当前活动独立；状态面板、详情、工具卡在中英文与 desktop/390px 一致；同步时不显示实时倒计时。
- 压力验证包含多 actor 持续 delta、节流事件数、投影更新、CPU/内存和真实浏览器渲染耗时；报告固定输入、规模、采样口径与实际结果，不设宽松断言把未知性能写成通过。
- 真实模型对照只使用隔离的合成任务和现有受支持配置，固定模型参数、任务、验收与起点，交错运行五对。配置或授权不可用时完成可复现的运行入口并保留明确未执行状态，不能用受控 provider 的结果冒充真实性能。
- 本地验证插件来源、打包资产、Web 产物及隔离应用加载；不覆盖当前用户插件缓存、不安装替换正在使用的应用、不替线上发布作隐式授权。无真手机或其他操作系统时不能声称相应实机验收完成。
- CLI Lint 不放宽阈值、不新增豁免；优先消除本任务涉及模块的既有超限。跨域大规模历史欠账如仍存在，列出真实结果与范围，不借“无新增”称全量通过。

### 8.3 第二轮代码交付记录

- 已补 Scheduler 准入原因观察与显式清除，shared reducer 同步处理 queue、代次与历史事件；没有修改实际派发顺序、并发名额或供应商策略。
- 已补 CLI 名册的 phase/queue 判断、跨 ask 最近交付及工具输出/schema/文本接线。等待、暂停、准备状态不再从 journal `running` 推导为 executing；summary 使用 observed/unsettled，区分未完成节点数和当前 actor 处境。
- UI 复用活动选择器补主状态面板、等待起点/时长、静态卡统计和连续交付。FIFO、容量、provider 等待和工具执行时长复用父视图秒针，静默期间仍更新，不为每个 actor 新建 timer；同步、暂停和终态不继续计时。静态卡以 `generatedAt` 为时钟；实时恢复提示沿已有父投影传递，不增加订阅或业务状态。
- 拆出 `workflow-driver-turn.ts`、`workflow-driver-cleanup.ts`、`workflow-actor-runtime.ts`，分别承载 turn 收尾、runtime 清理重试、actor runtime 构造；原 `workflow-driver.ts` 与 `dynamic-workflow-run-launch.ts` 保留入口和原状态所有权。不把本次拆分称为全 CLI 质量欠账清零。
- 新增/扩充回归覆盖 scheduler admission、shared queue 归约、观察卡严格字段、名册 phase/前次交付、双交付模式队列恢复、状态面板及静态/实时展示、turn/resume/cleanup 顺序。测试文件已写，未执行。

**本轮执行边界：** 开工完成了 freshness 与架构基线；收到用户由自己验证的指示后停止执行验证。一个只读调查代理在收到该指示前做过 3 文件的定向 Lint，不能算本轮最终验证。此后未执行测试、类型检查、Lint、构建、压力评测或真实模型对照，未安装、部署、更新插件缓存或重启用户应用。第一轮通过数和基线不代表本轮通过；完整验证入口仍见 §7.1。真实供应商效率、持续多 actor 压力、安装版和真手机发布均留给用户，不以编写用例替代运行结果。

建议用户优先覆盖本轮新增的 `scheduler-admission.test.ts`、`workflow-runs-admission.test.ts`、`workflow-driver-turns.test.ts`、`conversationStatusPanelModel.workflowActivity.test.ts`，以及已扩充的 `workflow-activity-roster.test.ts`、`workflow-activity-display.test.ts`、`workflow-activity-projection.test.ts`、`dynamic-workflow-run-launch-failover.test.ts`、活动选择器/SSR/静态卡和 `workflow-execution-progress.test.mjs`，再执行完整类型与架构检查。CLI 跨包测试依赖当前构建产物，避免旧 dist 造成误判。

## 9. 第一轮实施记录（2026-10-01）

以下仅为第一轮历史记录，不能作为第二轮新增改动已验证的证据。

### 9.1 已落实的行为

- **P0 完成。** 常驻工具描述增加单次 ask 的交付、范围和完成条件，内置技能补反例和可执行正例。实际受控执行验证独立调查先入队、cap=1 合法排队、契约阻塞不启动依赖实现、同 actor FIFO 不变。Create 描述为 14,466 字符，未突破 15,000 字符预算。
- **P1 完成。** 真实 driver 与 harness 接入 `askActivity`，基于请求/工具源事件报告有界活动；请求成功数不再等同 turn 数，同类高频更新合并为 1Hz。父投影、CLI 观察卡、聊天时间线、详情侧板和密排名册共用活动事实；第一次重试即可查看次数、具体原因及时间。隐藏输出保持不可观测语义，重连期间显示上次状态；并行工具与供应商等待可以同时解释。
- **P2 完成。** 当前分析 core 只对可靠的直接 await 与 tuple join 提供有源位置的非阻断提示。Create/Amend 确认前通过 host-only raw 字段展示；共享 reader 严格校验脚本指纹，丢弃陈旧/伪造提示，旧 display 形状不变，不自动重排脚本。
- **恢复边界保持。** journal 源时间贯穿 live/cold；同一 run 的旧 sequence 不回退状态；旧 attempt、暂停和终态后的观察被拒绝。后续排队 ask 不遮住当前 FIFO 队首，恢复/修订与副作用复用回归未退化。
- **维护边界保持。** 未修改并发上限、模型选择、推理档位、超时或重试策略，redrive 仅统一等待观察的下一次尝试编号。没有新运行状态所有者、数据库表、用户会话操作或长期子会话调试订阅。
- 新 Web fixture 与测试加入现有 `.gitignore` 精确白名单，避免用户全局 test 忽略规则导致验收文件遗漏；未 stage、commit 或 push。

### 9.2 第一轮实际检查结果

| 检查                                      | 结果                                                                                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 根 `pnpm typecheck`                       | 通过，退出码 0。                                                                                                                                                         |
| 根 `pnpm lint`                            | 通过，0 warnings / 0 errors。                                                                                                                                            |
| `pnpm architecture:check --changed`       | 通过，violations / baseline / new 全为 0。                                                                                                                               |
| CLI `pnpm --dir apps/lcode-cli typecheck` | 通过，27/27 tasks，包含依赖构建。                                                                                                                                        |
| CLI 工作流定向回归                        | 109/109 通过；含真实 driver→engine、真实临时 harness、受控编排、观察卡、live/cold 和协议分片。                                                                           |
| shared workflow 契约回归                  | 13/13 通过。                                                                                                                                                             |
| UI 定向回归                               | 27/27 通过；含选择器、SSR、确认提示和真实 projection store 的同步语义。                                                                                                  |
| `pnpm --dir packages/web test`            | 60/60 通过；真实共享组件，1280/390px、中英文、亮暗、触摸、两种恢复 profile、密排和原下钻。                                                                               |
| CLI 全量 `lint`                           | 退出码 1；仍有 89 个既有 max-lines 错误及 54 个警告，未弱化规则或扩大重构。                                                                                              |
| CLI 本次文件的基线对比                    | 排除开工前已脏的 CLI 文件后，40 个 tracked 与 19 个新增文件，当前/HEAD 诊断均为 4 个，无新增规则/文件诊断；两个原超限文件代码行分别 476→480、534→547，不能称该检查全绿。 |
| 新增文件定向格式检查                      | 通过；没有全仓批量格式化。                                                                                                                                               |
| `git diff --check`                        | 通过；Git 的 LF→CRLF 提示不是验证失败。                                                                                                                                  |

定向入口是现有 Node test runner，不新增 package test script：

```sh
pnpm --dir apps/lcode-cli exec node --import tsx --test <工作流定向测试文件>
pnpm --dir packages/shared exec tsx --test "src/lcode-protocol-v4/workflow*.test.ts"
pnpm --dir packages/ui exec tsx --test <UI 定向测试文件>
```

CLI 109 项文件集合覆盖 `workflow-tool-description`、`workflow-authoring-execution`、`workflow-script-advice`、`amend-workflow-source`、`orchestration-advice`、`scheduler-controls`、`engine-activity`、`harness-activity`、`workflow-driver-controls`、`workflow-driver-activity`、`workflow-driver-activity-wiring`、`workflow-driver-model-failure`、`dynamic-workflow-run-activity-time`、`workflow-activity-roster`、`workflow-import-reuse`、`workflow-model-progress`、`dynamic-workflow-run-lifecycle`、`workflow-activity-projection`、`workflow-observation-compatibility`、`model-output-statistics`、`workflow-activity-display`。

UI 27 项文件集合是 `timeline-execution-progress.test.ts`、`WorkflowExecutionActivity.test.tsx`、`timeline-large-run.test.ts`、`WorkflowRunPhaseList.test.tsx`、`WorkflowPermissionBlock.test.tsx`、`conversationProjectionStore.workflowSync.test.ts`、`get-workflow-run-activity.test.tsx`。

### 9.3 第一轮环境问题与修正记录

- 开工 freshness 的远端 fetch 发生连接重置；`--no-fetch` 缓存检查通过，未据此声称实时远端已同步。
- 本机 Node 为 `24.14.1`，`mise.toml` 指定 `24.14.0`；pnpm 为 `10.33.2`。CLI 缺本地 turbo bin，通过在命令 PATH 中使用已安装根 `node_modules/.bin` 执行，不修改系统 PATH、依赖或锁文件。Turbo 提示 CLI lockfile 缺部分 workspace 信息，实际类型检查最终完成 27/27 tasks。
- 首次 Web 套件 24 通过、4 失败：部分测试的 `Local:` 就绪判定被 Vite ANSI 颜色码打断，默认 Playwright headless 浏览器版本未安装。新增测试使用 Node 标准库 `stripVTControlCharacters` 修正判定；最终以 `NO_COLOR=1 FORCE_COLOR=0` 和既有 `LCODE_TEST_BROWSER_PATH` 指向本机已安装 Chrome 重跑全套通过，没有下载浏览器、跳过场景或放宽断言。
- 真实 harness 的活动 sink 漏接、同步测试不完整 snapshot、旧生命周期 sequence 回放清空新活动、runner 的 started 源时间可早于 admitted 均在验证中复现并补回归修复。源码最后一版才作为本表验收对象。
- 官方 Browser Use 另验证首次重试详情、主卡/详情同步门控和 390px 实际布局。手动主题按钮操作两次超时，没有将这部分记为手动通过；亮暗和触摸的验收来自最终 Web 自动套件。

### 9.4 第一轮变更规模与未验证范围

变更模块为 lcode-cli、shared、ui、web；状态所有者及事件顺序见 §4，未新增架构依赖。排除开工前脏文件及已有未跟踪 spec 后，可独立归属的 62 个 tracked 文件新增 796 行、删除 131 行；36 个新文件共 5,247 行（包含测试、fixtures 和文档，统计于收尾文档更新前）。已有 `.gitignore`、shared 观察 schema、头像容器、两种语言文件及两份已有未跟踪 spec 仅叠加本任务所需修改，未把它们完整 Git diff 算作本次贡献。其他已有 Git/模型/速度改动保持。

**未验证或未执行：** 真实供应商的五对效率对照、安装版 Electron、真手机网络/托管资源发布、macOS/Linux 实机、完整发布构建。内置技能源码已修改，但未覆盖当前安装插件缓存；需要后续正常构建/分发才会进入安装版。没有性能倍数结论，没有部署、安装、重启应用或恢复两个原任务。

## 10. 测试夹具行数治理（2026-10-01）

用户单独授权修复全仓 Lint 中工作流测试夹具的 `max-lines` 错误。本次仅做测试代码职责拆分，不改 §8 的实现行为或扩大到其他会话功能。

- 将受控传输、基础 snapshot、场景投递与恢复操作提取到 `workflow-execution-progress-runtime.ts`；原 TSX 保留共享组件挂载与交互控件，既有数据模块保持不变。
- 将 Web E2E 的 Vite/浏览器启动与清理提取到 `workflow-execution-progress-browser.mjs`；测试入口保留全部场景断言。进程仍由原测试的 `t.after` 负责结束，仅清理本测试启动的进程，不改变跨平台收尾顺序。
- 投影仍由原来的唯一 `ConversationProjectionStore` 与 lease 管理。场景投递、初始连接、同步完成、连接失败和陈旧帧的顺序与载荷保持一致，不新建订阅、运行队列或业务状态所有者。
- `sourceNow` 保留模块级事实及实时导入绑定；仅切换场景时更新，不因 UI 重绘或同步恢复重算静态观察时间。
- 不删测试场景或断言，不放宽 400 行规则；新增 fixture 文件加入已有精确 Git 白名单。
- 浏览器断言只定位 `data-state="open"` 的活动详情弹层，避免关闭动画期间旧内容与新弹层同时存在时的重复匹配；仍验证当前场景的完整内容，不用 `.first()` 掩盖目标歧义。
- 验证使用根目录 Lint、类型检查、架构检查和现有工作流 Web E2E（桌面/390px、中英文、亮暗主题、两种恢复 profile）。这些检查仅证明本次夹具拆分及其覆盖场景，不代替 §8 尚未执行的完整工作流验收、压力评测或实机测试；本次不打包、安装或发布。

### 10.1 本次实际结果

- 修改模块仅为 legacy Web 测试代码；生产组件、数据夹具和协议未变。TSX 从 448 行降至 310 行，投影模拟模块 191 行；E2E 入口为 369 行，浏览器启动模块 73 行。相对本轮开工的两个文件共 800 行，测试代码净增 143 行，包含规范格式化；不是新增业务逻辑规模。
- 最终根 `pnpm lint` 通过：2,666 个文件，0 warnings / 0 errors；根 `pnpm typecheck` 通过；架构检查通过，baseline 0 / new 0。
- 工作流 Web E2E 最终通过（1 个集成测试，约 36 秒），覆盖既有桌面/390px、中英文、亮暗主题、静态源时间、场景切换、连接失败和两种恢复 profile。首次运行曾因旧/新弹层重复匹配失败，收紧打开状态选择器后重跑通过，未删断言或放宽等待预算。
- 四个测试代码文件定向格式检查及 scoped `git diff --check` 通过；两个新增文件的精确 Git 白名单有效。未运行 CLI 全量 Lint、打包、安装、部署或真实模型调用；不宣称 macOS/Linux 或真手机实机通过。

## 11. 第二轮补执行测试（2026-10-02）

用户后续要求执行此前未测试的用例。本轮仅测试、定位失败并更新记录，没有修改生产实现、测试断言、依赖或规则，也没有提交、安装、发布或操作已有用户任务。结果针对本轮开始时当前工作区，包含其他会话已经留下的改动。

### 11.1 实际结果

| 检查                                | 结果                                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| freshness                           | 远端 fetch 及基线检查通过。                                                                                                                      |
| 根 `pnpm typecheck`                 | 通过，退出码 0。                                                                                                                                 |
| 根 `pnpm lint`                      | 通过，2,669 文件，0 warnings / 0 errors。                                                                                                        |
| `pnpm architecture:check --changed` | 通过，violations / baseline / new 全为 0。                                                                                                       |
| CLI 全链路类型检查                  | 普通入口命中缓存后，额外执行 `turbo run typecheck --force`，27/27 tasks 通过、0 cached，实际刷新依赖构建。                                       |
| CLI 工作流回归                      | 162/162 通过，含全部 bootstrap workflow/dynamic-workflow 用例、Scheduler admission、turn/cleanup/model binding、观察输出、提示分析和双投递恢复。 |
| shared workflow 回归                | 17/17 通过，含新准入原因与 clear 事件。                                                                                                          |
| UI 定向回归                         | 58 项，57 通过、1 失败；失败为等待起点 SSR 属性名断言，单独重跑仍失败。                                                                          |
| Web 全套                            | 61/61 通过，包含状态面板、静态卡、队列原因、跨 ask 交付、桌面/390px、中英文、亮暗与恢复场景。                                                    |
| 内置插件资源/分发测试               | 10 项，9 通过、1 失败；失败为 staging 测试临时仓库缺 CUA 插件资源，单独重跑仍失败。没有 skip。                                                   |
| CLI 全量 Lint                       | 未通过，输出合计 88 errors / 54 warnings。                                                                                                       |
| 工作流拆分/排队模块定向 Lint        | 未通过；`workflow-driver.ts` 有效代码行数 408，超过 400。所选其他 7 个相关文件未报诊断。                                                         |
| `git diff --check`                  | 通过；仅有 Git 换行提示。                                                                                                                        |

### 11.2 已定位的失败

1. `packages/ui/src/components/workflow-timeline/WorkflowExecutionActivity.test.tsx:185` 使用大小写敏感正则匹配 `datetime`，React `renderToStaticMarkup` 实际输出 `dateTime`。时间值同为 `1970-01-01T00:00:01.000Z`，已等待 5s 及统计字段也出现在实际输出中。本次证据指向测试期待不匹配，而非时间计算错误。该 case 在首次循环断言处中止，后续循环不能计为通过；未擅自修改断言。
2. `scripts/lemon-workflow-builtin.test.mjs:202` 的临时仓库只准备 lemon 插件，`stageAgentBundle` 现在还要求 `lcode-cua-plugin/.lcode-plugin/plugin.json` 等资产，因 fixture 缺失而失败。已有 desktop Agent 在隔离 HOME 中发现命令/技能的用例通过，但不是本轮新打包安装验收；未修改 fixture 或生产 staging。
3. `apps/lcode-cli/packages/bootstrap/src/app/workflow-driver.ts:595` 仍触发 max-lines，408/400；`dynamic-workflow-run-launch.ts` 及三个新拆分模块的本次定向 Lint 没有报错。全 CLI 仍存在其他跨域历史诊断，不能用根 Lint 通过替代 CLI Lint。

### 11.3 执行方式与边界

- CLI：现有 `pnpm --dir apps/lcode-cli exec node --import tsx --test`，覆盖 `bootstrap/src/app/workflow*.test.ts`、`dynamic-workflow*.test.ts` 及方案所列 core/engine/runtime/protocol 用例。类型检查以根 `node_modules/.bin` 补充命令级 PATH 后执行，未改系统 PATH；Node 仍为 24.14.1，与 mise 的 24.14.0 有 patch 差异。
- shared：`pnpm --dir packages/shared exec tsx --test "src/lcode-protocol-v4/workflow*.test.ts"`。
- UI：在 packages/ui 下运行活动选择器、活动组件、状态面板 model/mount、PhaseList、PermissionBlock、projection syncing、静态观察卡及既有速度回归。
- Web：沿用 `NO_COLOR=1 FORCE_COLOR=0` 和 `LCODE_TEST_BROWSER_PATH` 指向本机已安装 Chrome，执行完整 `pnpm --dir packages/web test`。测试自己的服务器、浏览器由测试 cleanup 收尾，未留常驻预览。
- 插件：`node --import tsx --test scripts/lemon-workflow-builtin.test.mjs`；临时 staging 与隔离 HOME 不覆盖用户目录。
- 未执行真实供应商五对效率对照、多 actor 持续负载的 CPU/内存/渲染基准、全量发行包构建、安装/部署、真手机链路或 macOS/Linux 实机。这些不能由本次受控回归通过推导为完成。

## 12. 自研 Computer Use 暂存夹具修复（2026-10-02）

用户要求核对并补齐 §11 的插件暂存失败。确认自研内容包 `apps/lcode-cli/packages/lcode-cua-plugin` 的 manifest、文档、SDK client、skill 均存在，缺的是 lemon 测试临时仓库中的完整 CUA 内容包，不是生产实现。

- lemon 测试从仓库源码递归复制两个必需插件，保留隐藏 manifest；不创建空文件、不读取用户缓存、不把 CUA 改成可选。
- CUA 暂存用例逐文件比较输出与源码，并分别缺失四项必需资源验证原 staging 的拒绝路径；为遵守行数规则，将此职责拆成由原测试入口导入的 `computer-use-plugin-staging-cases.mjs`，不删断言或新增规则豁免。
- 双插件完整测试 26/26 通过、0 skip；根类型检查、Lint、架构检查和定向格式检查通过。生产 SDK、Helper、插件启用状态、依赖和暂存实现未修改。
- §11 的 UI 属性名断言和 CLI max-lines 问题不属于本次 CUA 修复，未改动，也不以本次根 Lint 通过代替 CLI 全量 Lint。

## 13. UI 断言与工作流驱动行数收尾（2026-10-02）

用户要求修复剩余两个明确问题，本轮不扩展清理全 CLI 历史欠账。

- UI 用例按 HTML 属性名不区分大小写的语义匹配 `datetime/dateTime`，仍严格断言 ISO 源时间、5s/7s 等待时长、所有活动统计以及中英文/四类等待状态；不修改实际 JSX 或放宽时间值。
- 将 actor 会话身份的纯解析/一致性检查提取到现有 `workflow-driver-helpers.ts`，与唯一 `mintActorSessionId` 实现相邻。Driver 仍读取同一 journal 一次、持有 sessions 和生命周期，在构造 runtime、seed 或订阅前拒绝记录身份不匹配，错误 code/message/mismatch 保持不变。
- 依赖方向、owner/lease、创建/关闭顺序、缓存和 attempt 防护均不变；不通过压缩语句、删除校验、提高阈值或增加 Lint 豁免满足行数要求。

```text
driver 读取 actor journal → 纯解析并核对 run + actor 会话身份
                                  ├─ 不匹配：原 DriverError，factory 尚未执行
                                  └─ 匹配/无旧记录：原 runtimeFactory → seed → sessions owner
```

实际验收：

- 修复前复现 UI 单用例失败和 driver 的 408/400 行数错误；新增身份 helper 回归先失败（缺导出），实施后转绿。
- UI 定向回归 58/58 通过，原等待起点用例完整覆盖中英文及 FIFO/run capacity/slot/backoff 的 ISO 源时间、5s/7s 时长和统计。实际 JSX 未改。
- 驱动身份、控制、turn、活动接线、缓存复用和 launch/failover 相关回归 26/26 通过，其中新增 5 项身份用例，证明冲突在 runtimeFactory 调用前拒绝，保留结构化 DriverError。
- `pnpm --dir apps/lcode-cli --filter @lcode/bootstrap typecheck`、根 `pnpm typecheck`、根 `pnpm lint` 通过；驱动、helper 和新增身份测试的定向 Lint 为 0 warnings / 0 errors，未放宽 400 行规则。
- CLI 全量 Lint 实际执行仍失败，输出合计从 88 errors 降至 87 errors，54 warnings；不再报告 `workflow-driver.ts`，其余历史问题未纳入此次修复。
- 仅定向格式化两个测试文件，未重排其他生产文件；本轮无生产 UI 交互变化，因此沿用此前 Web 交互覆盖，未重跑 Web 全套、安装/发布或真实供应商效率对照。

## 14. CLI 质量与效率、压力评测闭环（2026-10-02）

用户明确授权完成此前未收尾的三项：CLI 全量 Lint 历史欠账、五对真实模型效率对照、多代理持续压力测试。质量治理的行为保持与零豁免约束见 `lint-clean-baseline.md`；合成数据边界、指标、时长、样本次序与结果口径见 `workflow-efficiency-benchmarks.md`。本轮不包含新版安装包、用户插件缓存更新或线上发布。

开工实际基线：CLI 按现有 package lint 范围逐包收集 87 errors / 54 warnings；架构 baseline/new 均为 0；选定工作流回归 99/99 通过。源代码公共声明入口与导出名字已经冻结作重构后兼容性核对，已有未提交的 Git、模型、头像等功能改动保留。

实施与验收记录：

- CLI 历史诊断已清零：强制执行现有 14 个 Lint 任务，0 warnings / 0 errors，未使用缓存，未改规则与输入范围。根 `pnpm typecheck`、`pnpm lint` 通过，架构 violations / baseline / new 均为 0。
- 完整 CLI 强制类型检查及依赖构建最终 27/27 tasks 通过、0 cached。验证中发现的 Worker/OAuth mock、测试 rest tuple 与两个抽取工厂的不可命名返回声明均已修复，再全量执行通过；不是只依赖定向语义检查。
- 五对真实模型对照全部完成：固定 `gpt-6-astra/max/fast`、相同三个合成任务与精确验收，AB/BA 交错；10/10 arms、30/30 任务成功，配对总加速中位数 1.701×、范围 1.265–2.285×。第 2 对首次交付轻微变慢也保留，不选择性重跑；结论只覆盖此合成编排。
- 运行时持续压力已完成：12/64 actor ×20 delta/s 的 60 秒以及 64 actor 的 5 分钟档位完成；256 actor 修正基准后的复测为 6.556 delta/s/actor、单核 CPU 94.80%，触及固定墙钟预算未完成。初始基准漏记部分字段与未让出事件循环的失败仍保留，未更改生产并发或预算；所有测试创建资源完成清理。
- 额外 `registry:check` 仍因 HEAD 既有 Windows 路径 hash 与 CRLF 字节差异失败；注册表正文不变，本轮未覆盖生成产物或扩大修复范围。该失败不能与已通过的类型/Lint 混写。
- 统一 CLI 离线回归去重后 155 文件、722/722 通过；首轮 debug 的 3 个 JSX 失败以该包现有 tsconfig 修正测试入口后通过，未改生产或跳过。另 shared 17/17、UI 58/58、Web 62/62、内置 lemon + CUA 26/26 通过。48 个公共声明入口、4,933 个原导出名字均保留，未把名称核对当作全部行为证明。
- 浏览器实际完成修正后的 12/64/256 actor 桌面及 64 actor、390px replayable 档位，每档预热 10 秒、测量超过 60 秒；恢复、陈旧帧、真实详情交互、截断和资源清理通过。256 档实际 16.208 delta/s/actor，RAF >50ms 占 74.38%，不能称性能通过。原 12 档 JSON 键顺序误报保留，基准规范化比较和 9 项正/负回归已完成，未修改产品恢复逻辑。
- 新增源码审计无空文件或新增 suppression，六处先前格式差异经 SHA/AST 等价门禁安全修正，66 项接缝再回归通过。最终根 typecheck/Lint、CLI 强制 typecheck/Lint、架构及 diff-check 通过，未把重复测试相加。
- 详细口径和最终结果集中记录于 `docs/benchmarks/workflow-efficiency-2026-10-02.md`，原始失败与成功样本分别保留。临时服务器与测试标签页已关闭；没有提交、推送、安装、发布或恢复原用户任务。
