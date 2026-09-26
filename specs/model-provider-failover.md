# 运行中模型平滑交接与供应商故障接管

## 目标与非目标

- 用户在任务运行时选择新模型后，新选择仍是 Composer 下一次提交的模型，同时成为当前主任务和子代理的故障接管目标。
- 健康的在途模型请求和已经开始的工具必须完成并持久化；若本轮继续，在下一 model-step 安全边界平滑交接，结构化白名单错误也可在恢复边界触发接管。
- 切换供应商不得静默降低推理档位、工具能力、上下文质量或重放已经完成的副作用。
- 本功能不做自动候选推荐、健康请求负载均衡、失败后自动切回，也不改变现有 `switchModelConfig` 的会话配置语义。

## 产品规则

1. 用户选中完整 `ModelSelection` 后，Renderer 先更新现有 Composer draft。即使接管命令失败，下一次提交选择也不回滚。
2. 若权威 snapshot 没有运行中的 foreground execution 或 background work，只更新 draft，不发送接管命令。
3. 若有活动目标，Renderer 发送 `setExecutionFailoverTarget`，携带选择瞬间看到的 execution/work ID。普通子代理只从 `backgroundWorks` 的 running subagent workId 采集；可继承切换的 Workflow actor 只从 Runtime 投影的 `executionFailoverEligibleBackgroundWorkIds` 采集，Renderer 不得根据 `workflowRuns`、actor status、session 目录或模型字段自行推断资格。若 foreground 已结束，Renderer 必须在 64 项协议上限内优先保留该权威列表，使 Runtime 仍能从 retained registration 恢复 lineage；foreground 活动时先保留普通 running subagent，再附加权威 actor ID，由 Runtime 按 foreground lineage 扩展同源 registration。旧 CLI 未提供该字段时，Renderer 不猜测 Workflow actor，只发送普通子代理 ID，并沿用 32 项兼容上限。
4. 命令把活动目标置为 `waitingSafeBoundary`。当前在途请求继续使用原供应商，已开始的工具/文件写入完整完成并持久化，不能为切换而 abort 或重放。若工具执行状态未知而 checkpoint 已被标记 unsafe，该 fence 绑定当前 execution target，后续 B→C 命令覆盖也不能解除；只有 reconcile 或 execution 终态才能清除。
5. 若本轮产生下一 model-step，Router 在发请求前激活目标选择，事件原因是 `userRequested` / `safeBoundaryActivated`。若原请求 final 且没有后续工具，本轮自然结束并清除策略，B 只用于未来提交。
6. 原供应商发生白名单错误时，Router 先完成本地恢复判断，再在稳定恢复边界改用目标选择。若错误已进入 retry/backoff，已经发出的 attempt 和 backoff 不被中断；真正让出只能发生在该失败的 backoff 完成后。backoff 结束后以及 attempt admission、header/model 解析、started 状态发布等异步准备完成后，Adapter 都必须在物理调用旧供应商前基于上一失败做最后一次让出检查，空 completion 的内部重试也不例外。让出闸门必须等待 policy mutation 队列到达稳定尾部，再按最新目标执行与真实安全边界相同的 unsafe fence、交接次数、visited model、身份、options、工具、媒体输入和上下文容量检查；任一条件不满足时保留/阻断目标但继续既有 A retry，不能先终止 A 再发现 B/C 不可用。命中时先释放 admission ticket，再把 retry 控制权交回 Router，由目标从该次 attempt 生效，不能再多请求一次旧供应商。让出 claim 必须携带旧请求已消耗的真实 retry attempt 数（off-peak 排队不消耗）；若 decision 后的新目标导致 Core 无法接管，下一次同 selection 且 provider-visible messages、tool contract 与 `maxOutputTokens` 身份均未改变的 A 请求，才可以用该值作为一次性 `retryAttemptOffset`，从原预算和退避进度继续。busy steer、compact、reminder 或工具契约变化都必须丢弃旧 offset；正常无 continuation 的请求不得为此无条件计算全量上下文指纹。若 B/C 成功接管或 selection 不同，也必须丢弃该 offset。
7. 一个目标成功接管后，在该逻辑执行剩余阶段（包括后来创建的新 Turn loop state）固定使用新选择，不自动回到启动模型，也不重复发布 transition。目标模型必须经过与普通 Turn `createTurnModel` 完全相同的 runtime invocation 包装，继续携带所属 Runtime 的 admission、任务类型 retry budget 和按 attempt 刷新的账号 header；当前 `RegularTurnLoopState` 在创建时固定持有本 execution 的 `requestDependencies`，Router 的 capability 预检、retry-yield 预检和真正激活使用同一完整 selection 与同一依赖。预检只允许构造惰性 Model，不得解析账号 token/header 或产生远端副作用；执行作用域的 off-peak auth source 只能在真正物理请求前解析。若 active 目标后来无法重新构造或不再兼容，先投影 blocked，再明确终止当前 Turn；禁止静默回到旧模型。每个逻辑请求最多允许两次目标交接（同模型 options 变化也计入）；耗尽后保留 checkpoint 并报告错误。
8. 主任务策略以 `foregroundExecutionId` 为 lineage 根。命令接受后新建的子代理继承同一 handoff/fallback；已运行子代理通过 `backgroundWorkIds` 精确加入。Workflow run 在首个 actor 尚未创建时，以 run-level lineage lease 在 Runtime 内保存该 lineage 已接受的 dormant intent；foreground 先结束时对外 policy 可归零，真实 `session-inherited` actor retain 后才原子物化为非空 background target。runId/lease 不得伪装成 workId、进入 eligibility 或投影成空 targets。无关会话、手动打开的 child session 和后续新主任务不继承。
9. 每个主任务/子代理独立交接：一个 child 激活不改变其他目标。尚未接管的目标不兼容时将该目标标记为 blocked 并继续当前模型；已经 active 的目标失效时 blocked 后终止该 Turn，不能静默降级。后台 work 进入 completed/failed/cancelled 终态时必须再次幂等清理 target，关闭 turn 与 registry 终态之间的竞态窗口。普通子代理的单个 child Turn 只负责 retain，不能自行 release；registry 终态之后的 policy cleanup 是唯一释放路径。普通子代理的 registry 终态先提交，policy release 失败不得把任务改写成 failed；端口内唯一终态清理所有者必须按本次执行代次保留句柄并确定性重试，父 Runtime 通过 residency 持有该未完成工作，显式 close 也必须等待 session-store-dependent owner 稳定 drain 成功。生产 retry 句柄在 cleanup 成功前必须保活，不能因 timer `unref` 在进程退出时丢失。只有 release 成功后才能移除句柄，同一终态代次不得重复释放；配置了 release 却没有可持有失败句柄的 owner 时必须在创建端口时失败，不能只记日志后吞错。`stopTask`、SendMessage resume 与重复 stop 必须经过同一个 taskId 串行 mutation；stop 和 provider finalizer 都只可用 execution span + nonterminal CAS 提交终态，CAS 失败的一方不得再通知、abort、发事件或清理。stop 提交后端口继续持有旧执行的完整 settlement；同 taskId 的 resume 必须依次等待旧执行 finalizer settlement 和旧代 policy cleanup，再注册新代次。background start/resume 在首次 admission 后、任何 metadata 或旧代 cleanup `await` 前必须同步登记 prelaunch owner；最后一个异步准备完成后再次检查 shutdown，并把 registry register、controller 创建、provider runner 调用与 settlement retain 放在同一同步片。第二次检查失败时不得调用 provider、不得留下 running registry，prelaunch 只能在 cleanup 已登记或确认无需 cleanup 后释放。终态提交后即使通知 enqueue 失败也不得回滚成 running；旧 finalizer 不得覆盖新 registry 或发布旧 completed/failed 事件。
10. 用户主动选择跨供应商模型即授权传递可移植上下文，不再弹隐私确认；凭据、供应商私有缓存、签名元数据和不可移植隐藏推理不得跨供应商传递。
11. 停止、取消、权限拒绝、工具失败、测试失败和安全拒绝不能作为故障原因触发接管；用户请求的安全边界交接不受此条影响。
12. Workflow 以模型绑定 provenance 裁决继承：显式 run 选择、script actor model、approved actor override、resume pin 都保持独立供应商，不进入父策略的 waiting/blocked targets；只有 `session-inherited` actor 在自己的下一 model-step 安全边界继承父 target。`run-launched.subagentSelection` 既可能是显式 run 选择，也可能只是无损的会话启动快照，不能单独作为显式 provenance；只有 `subagentModel` 在场才表示该 run 显式选择了默认模型。Ask revise、amend 和 resume 传播该 provenance 时也必须保留这一区分：导入 seed 的 `resolvedModel` 只是 continuation 起点，只有来源 provenance 本来就是 pin 时才能提升成 `resumePin`。普通 Amend 和 GUI settings 继承时使用完整结构化 `subagentSelection` 与 `actorModelOverrides`，不得经不可逆 picker 串重建后丢失 speed/options，也不得因只改脚本或并发度而清空已批准 actor override。Workflow actor 的 registration 和 active 选择属于可复用 actor runtime 生命周期，不得在每次 ask/Turn 结束时释放；actor runtime 关闭时才统一清理。actor journal 必须把完整 `resolvedModel` 与 `modelProvenance` 作为同一 actor 行的原子绑定事实持久化；engine、resume 与 amend/import seed 的整行替换都必须携带二者。成功接管的模型应用、actor journal 绑定与 registration `currentSelection` 必须在同一个 policy 串行 mutation 中按“journal 持久化成功，再提交 loop/session 与 registration”的顺序完成；journal 写失败时保留可重试 target 和原本地选择，下一安全边界继续接管，不能留下 active B / journal A 的 split-brain。旧 journal 行的 provenance 为 NULL 时，先按仍可证明的 approved/script/run 配置重建显式来源；没有显式证据时按 `sessionInherited` 解释，`resolvedModel` 只作为接续起点，禁止仅凭它猜成 `resumePin`。

- 新写入的 `run-launched` 必须用 `subagentModelProvenance: "runModel" | "sessionInherited"` 明确记录默认模型来源：显式选择写 `runModel`，未选择或用户显式清除写 `sessionInherited`，不得再用字段缺席承载清除语义。旧事件缺少该字段时继续以 `subagentModel` 在场作为 `runModel` 的兼容证据；两者都缺席时不虚构一次历史清除。
- actor 模型裁决顺序是 approved override > script model > 显式 run model > 同 run journal 绑定 > launch 的显式 `sessionInherited` > imported seed > 父会话基线。清除因此只屏蔽前驱导入的显式 seed；同 run 冷恢复仍从已经原子持久化的选择继续。Ask revise、普通 amend、GUI settings 后续修订与 resume 必须继续传播 launch provenance。
- 持久绑定中的 `selection:<JSON>` 必须通过共享 `modelSelectionSchema` 完整校验；未知或错误形状的 options 不得穿透到 provider runtime。

13. 在安全边界开始解析时，无策略后进入 B，或 B 被 C 覆盖时，最新命令都是当前请求边界的唯一权威目标。即使 Router 正在等待一次空解析，或 B 正在 model factory、能力校验、active reapply、模型应用或 blocked 写入门内，也必须等 policy 串行 mutation 队列到达稳定尾部，再在同一次安全边界重新解析并应用最新目标，不能先用 A 或 B 多发一次请求。同一安全边界内的中间候选只能 stage；仅稳定尾部的最终权威目标可以原子提交模型、context、visited、transition count、session、actor journal、registration 和 active 事件。若 journal/selection prepare 已成功而 active 事件 append 失败，必须先把 prepare 补偿回边界起点再返回失败，policy 保持 waiting；补偿失败则 fail closed。若最终 C 不兼容或不可用，则投影 C blocked、丢弃 B 的全部 stage 并保持边界起点 A；尚未发生物理请求的 B 不得被视作已接管，也不得用 B 发请求。若无法证明已完整回滚，必须在 provider 调用前 fail closed，不能暴露半提交状态。同一安全边界因 latest-wins 重解析多次时，失败恢复的持久化、checkpoint 和状态机推进回调最多成功执行一次。
14. Runtime 的 runtime-lifetime、session-inherited actor registration 是可复用 Workflow actor 接管资格的唯一所有者；run-level lineage lease 只保活 dormant intent，不进入资格投影，turn-lifetime 普通子代理继续由 `backgroundWorks` 表达。首次 retain、最终 release、lease acquire/release 和 SessionResumed 清理必须通过同一个 policy mutation 串行门；真实 actor membership 变化发布完整 `eligibleBackgroundWorkIds`，重复 retain 只刷新 current selection 时不发布资格事件。首次 retain 及 dormant intent 物化只有在组合事件 append 成功后才能同时提交 membership/target；release 的移除事件失败时保留旧 registration/lease，且 actor 或 run close 的所有者必须保留可重试句柄并在成功前继续 close，不能吞错后丢弃唯一调用方。actor close 的生产 retry timer 必须保持 Node 进程存活，不能复用面向普通 turn backoff 的 `unref` scheduler。release 与 target complete 合并为一次完整替换，不能让客户端看到“目标已移除但仍可选”或相反的中间态。普通子代理 background finalizer/cleanup 与 Workflow actor `disposeCompletion` 都属于父 Runtime 的 session-store-dependent close work；session close 必须先 `beginShutdown` 封闭准入并启动 execution/browser/MCP 等资源收口，再在各资源 deadline 之后无超时稳定 drain 该 owner，最后才关闭 session store。stable drain 中任一 retained work 失败时必须继续等待同批 sibling 和等待期间新增的 work 全部清空，再汇总抛错；不得因首个 rejection 提前越过仍可能写 store 的 sibling。协议全局 shutdown 即使对 server/app close 的有界等待超时，也必须先尝试其它独立资源，再无超时等待同一个幂等 server shutdown 完成，之后才能关闭共享 session store。资格 ID 投影最多公开 64 个 ID；在 lineage 数不超过 64 时先为每条 retained lineage 保留一个代表，再按注册顺序填充剩余配额，避免单一大型 workflow 挤掉其他 lineage。超过 64 条 lineage 时按首次注册顺序形成明确的产品上限，不能随机截断。failover state 的目标投影独立允许 65 项（一个 foreground 加命令允许的 64 个 background）；Runtime 的真实策略目标不受投影容量裁剪，超过公开上限时按 foreground 优先、其余按接受顺序稳定投影，并显式携带真实数量与截断标记。同 lineage 后建 child 即使未进入有界投影，也必须正常解析、激活、blocked 和完成，不能因 UI/协议容量降低执行行为。
15. Renderer 的切换状态文案必须展示完整选择中可见的 `reasoningLevel` 和 `speed`，不能只展示 provider/model。已知档位使用当前语言的既有标签，自定义值保留原值；未设置的 option 不显示。同一 provider/model 只改变推理档位或速度时，当前选择与目标选择必须仍可明确区分，不能呈现成“同模型 → 同模型”。

## 状态所有者

| 状态                                                | 唯一所有者                      | 读取/投影                                 |
| --------------------------------------------------- | ------------------------------- | ----------------------------------------- |
| 下一次提交的 `ModelSelection`                       | Renderer Composer draft         | Composer toolbar、提交冻结配置            |
| 活动执行与 work ID                                  | CLI Runtime / ProductProjection | `control.activeWorks`、`backgroundWorks`  |
| execution failover policy、lineage、attempt budget  | CLI Runtime                     | bootstrap 只调用 Runtime API              |
| 命令顺序与在线幂等                                  | `CommandInbox`                  | ACK、命令查询                             |
| 可选模型和能力校验                                  | 目标 Host Provider Registry     | Runtime Router                            |
| Workflow 模型绑定 provenance                        | Workflow run/actor Runtime      | failover inheritance guard                |
| Workflow run 默认模型 provenance                    | `run-launched` journal event    | amend/revise/resume 与 actor policy       |
| 可继承接管的 runtime-lifetime background work ID 集 | CLI Runtime registration        | snapshot/delta 完整替换；Renderer 只读取  |
| 首 actor 前的 Workflow lineage lease/dormant intent | CLI Runtime policy 串行门       | 不投影；真实 actor retain 时物化          |
| session-store-dependent close work 句柄             | Parent Runtime                  | 子代理/actor 登记；store close 稳定 drain |
| 普通子代理 run settlement / policy cleanup 句柄     | Explore subagent port           | resume/父 Runtime owner 等待至成功        |
| foreground execution policy cleanup 句柄            | Runtime command queue           | 当前 command 完成后重试，成功后继续出队   |
| 客户端可见接管状态                                  | `ProductProjection`             | snapshot/delta；Renderer 不自行推断       |

Main、Host 和 Relay 只负责连接、鉴权与转发，不保存接管策略。身份隔离继续使用 `workspaceIdentity?.trim() || workspacePath`。

```text
Amend/GUI clear             New run launch journal          Actor model policy
       | subagent model = null       |                              |
       |---------------------------->| provenance=sessionInherited   |
       |                             |----------------------------->| same-run binding first
       |                             |                              | suppress imported fixed seed
       |                             |                              | use parent current selection
Cold resume (same run)      |                              |
       |---------------------------->| replay the same launch marker |
       |                             |----------------------------->| journal binding still wins
```

```text
Workflow actor Turn         Parent Runtime              ProductProjection          Renderer
        | retain(runtime)        |                              |                       |
        |----------------------->| registration owner           |                       |
        |                        |-- Changed(policy + eligible)->| full replacement      |
        |                        |                              |---- snapshot/delta --->|
        | close runtime          |                              |                       |
        | release -------------> |-- Changed(remove + complete)->|                      |
        |                        |   one mutation / one revision |                       |
```

```text
Ordinary subagent       Runtime task registry      Terminal cleanup owner       Parent Runtime
       | terminal result       |                            |                         |
       |---------------------->| commit terminal            |                         |
       |                       |--------------------------->| release policy target   |
       |                       |                            |---- retain promise ---->|
       |                       |                            |<--- release failed -----|
       |                       |                            | keep handle + retry      |
       |                       |                            |<--- release success -----|
       |                       |                            | resolve/remove handle    |
       |                       |                            |<---- stable close drain -|
```

```text
Session/global owner       Resource closers       Store-dependent owner       Session store
       | beginShutdown            |                         |                         |
       |------------------------->| start abort/close       |                         |
       |--------------------------+------------------------>| stable drain            |
       |<-- bounded deadlines ----|                         |                         |
       |<========================== unbounded settlement ===|                         |
       |-------------------------------------------------------------------- close -->|
```

## 命令、事件与快照

### 命令

```ts
setExecutionFailoverTarget: {
  modelSelection: ModelSelection;
  observedTargets: {
    foregroundExecutionId?: string;
    backgroundWorkIds: string[]; // 去重，新协议最多 64 个；旧投影兼容 32 个
  };
}
```

- `foregroundExecutionId` 与 `backgroundWorkIds` 至少有一项；所有 ID 非空。
- 命令不带 `baseRevision`，不进入 `COMMANDS_REQUIRING_BASE_REVISION`。并发选择按 `CommandInbox.admissionSeq` 排序，最后接受的策略获胜。
- Handler 调用 `runtime.setExecutionFailoverTarget({ sourceCommandId, modelSelection, observedTargets, traceContext })`。没有任何 ID 仍活动时返回 `guard.activeExecutionChanged` no-op。
- 成功使用普通 accepted ACK；策略 revision 和目标状态由权威 snapshot/delta 发布。同一 `commandId` 重试返回同一 ACK。

### 事件

Runtime 只发一个持久事件 `ExecutionFailoverChanged`，payload 为：

```ts
{
  revision: number;
  cause: "userRequested" | "eligibleFailure" | "safeBoundaryActivated" | "targetBlocked" | "targetsCompleted" | "eligibleTargetsChanged";
  sourceCommandId?: string;
  state: ExecutionFailoverState | null;
  eligibleBackgroundWorkIds?: string[];
  transition?: {
    targetKind: "foregroundExecution" | "backgroundWork";
    targetId: string;
    from: ModelSelection;
    to: ModelSelection;
    reasonCode: ExecutionFailoverReasonCode;
    attempt: number;
    at: number;
  };
}
```

事件携带完整替换状态；新 Runtime 的每个事件同时携带当前完整资格列表。`sourceCommandId` 只允许在没有 policy 的资格变更事件中缺省；`state` 非空时它必须存在且与 state 一致。资格单独变化且 policy 非空时，同步克隆 state 并推进同一 revision，保证状态与资格列表原子投影。Projection 忽略 `revision` 不大于当前值的重复/乱序事件。不得另外写 command fact，再写 policy event，避免双写部分成功。

### 快照

`ConversationSnapshot` 新增兼容字段 `executionFailover?: ExecutionFailoverState | null` 和 `executionFailoverEligibleBackgroundWorkIds?: string[]`：

```ts
type ExecutionFailoverState = {
  revision: number;
  sourceCommandId: string;
  modelSelection: ModelSelection;
  foregroundExecutionId?: string;
  targets: Array<{
    kind: "foregroundExecution" | "backgroundWork";
    id: string;
    status: "waitingSafeBoundary" | "switching" | "active" | "blocked";
    currentSelection?: ModelSelection;
    reasonCode?: string;
  }>;
  lastTransition?: ExecutionFailoverTransition;
  updatedAt: number;
};
```

新客户端把旧 CLI 缺省 `executionFailover` 视为 `null`；新 CLI 初始 snapshot 显式发布空资格列表，旧 CLI 缺省资格字段时新客户端不推断 Workflow actor。`state.updated` 对两个字段整体替换，不深合并；同一事件使用同一 revision。策略状态不增加 conversation revision，只推进 topic seq。所有目标结束后 policy 投影为 `null`，registration 仍在时资格列表保留；`SessionResumed` 同时清空 policy、资格列表并重置 revision。

## 错误白名单

只使用 adapter/runtime 的结构化 attribution，不匹配错误文案。

| reason code                      | 可接管条件                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `userRequested`                  | 用户主动选择，等待当前请求和已开始工具结束后的下一 model-step                                             |
| `network.transport_unavailable`  | connect timeout、reset、DNS/网络不可达；已有目标时在下一旧供应商 attempt 前让出，无目标时沿既有短重试路径 |
| `provider.service_unavailable`   | 供应商 5xx、服务不可用或容量故障                                                                          |
| `provider.rate_limited`          | 429、并发/速率/额度限制                                                                                   |
| `provider.authentication_failed` | 原供应商凭据失效；目标凭据已验证                                                                          |
| `provider.stream_unrecoverable`  | stream 截断、协议解码失败，既有恢复耗尽且未提交部分输出                                                   |
| `provider.context_capacity`      | 本地 compact/reprojection 仍失败，且目标上下文能力满足请求                                                |

以下一律不接管：用户 stop/cancel、tool/test 失败、权限拒绝、政策/安全拒绝、无效 prompt/tool 参数、确定性的本地代码/校验错误、目标未配置或不兼容、总体预算/最大轮数/总超时耗尽。

账号供应商在物理请求前刷新 runtime header/auth 失败时，必须保留结构化 `model_request_auth_missing` / `provider.authentication_failed` 归因；它属于原供应商认证故障，可在已有兼容目标时接管。不得把 `headersApplied=false` 或 Host 的凭据解析失败包装成不可分类的通用本地错误。

## 上下文与质量

- 接管输入从 canonical conversation、会话引用 capsule、稳定 tool result、当前 system/developer instruction 和执行 checkpoint 重建，不复制供应商原始请求对象。历史消息缺少 source provider/model provenance 时，保留普通推理正文，但删除任何带 `providerOptions`、签名、redacted data 或 item reference 的私有 reasoning block。
- 失败 attempt 的未完成 text/reasoning 不进入 canonical history；已提交 assistant segment/tool result 是 checkpoint。
- 已完成的有副作用工具不得重放；结果不确定时先读取外部状态并 reconcile，再决定是否继续。
- 目标必须支持当前必需的工具、图片/附件、上下文窗口和 `ModelSelection.options`。不支持时 blocked，并保留用户 draft；禁止改成较低 reasoning/speed。

## 时序

```text
Renderer       CommandInbox          Runtime Router        Provider A/B       Projection
   | select B       |                      |                     |                 |
   | draft=B        |                      |                     |                 |
   | set target(ids)|-- serialize/dedupe ->| wait safe boundary   |                 |
   |<---- ACK ------|                      |-- Changed(waiting) ------------------->|
   |                |                      |<-- current request/tool completes -- A |
   |                |                      |-- next model-step ---> B               |
   |                |                      |-- Changed(active) -------------------->|
   |                |                      | (A final: clear, next submission=B)     |
   |                |                      |<-- eligible failure -- A               |
   |                |                      | checkpoint + validate B                |
   |                |                      |-- next stable attempt -> B             |
   |                |                      |-- Changed(active) -------------------->|
```

子代理 spawn 时，Runtime 从同一 foreground lineage 复制 handoff/fallback policy；child 在自己的下一安全 model-step 或白名单失败恢复边界使用 B。Workflow actor 还必须满足模型 provenance 为 `session-inherited`，显式绑定不得被父策略覆盖。

```text
Workflow actor 模型来源
  approved actor override  ─┐
  script actor model        ├─ explicit/fixed ── 不加入父 failover policy
  run subagentModel         ┤
  resume pin                ┘
  session launch snapshot ─── session-inherited ── 用 childSessionId 加入父 lineage
                                                     └─ 自己的安全边界切换
```

## 幂等、恢复与传输

- 在线重复由 `CommandInbox` 的 `commandId` 去重；Runtime 再以 `sourceCommandId + target IDs` 保证重复调用无副作用。
- 延迟命令只能命中 payload 中仍活动的 ID；旧执行结束或 CLI 重启后 ID 失效并 deterministic no-op，不能应用到下一次运行。
- 只有执行本身支持跨进程恢复并保留相同 lineage/ID 时才恢复 policy；policy 与执行 checkpoint 必须同事务持久化，否则清除 policy。
- Desktop `desktop-continuous` 可显示在线 toast，但事实来自 snapshot/delta。Web/mobile `web-remote-replayable` 只依赖可重放 snapshot/delta，重连不依赖 toast。

## 验收场景

1. idle 选择 B：只更新 draft，不发送命令；下一次提交使用 B。
2. A 正常请求时选择 B：A 请求和随后已经开始的工具完整完成；若再有 model-step 则用 B。
3. A final 且无工具时选择 B：本轮自然结束，无 B 请求，状态清除；下一次提交使用 B。
4. A 进入 retry/backoff 后选择 B：下一 attempt 使用 B；不会额外等待一次 A retry。
5. A 返回白名单错误：稳定 checkpoint 后由 B 接管，未完成输出不重复，后续固定 B。
6. tool/权限/安全拒绝不作为故障触发器，错误按原路径呈现。
7. 主任务与两个 child 运行时选择 B：各自安全交接；后来 spawn 的 child 继承，其他会话不继承。
8. B 缺工具、档位或上下文能力：目标 blocked，不降级；draft 仍为 B。
9. 快速选择 B 后 C：按 admission 顺序只保留 C；旧 B 事件不能覆盖较新 revision。
10. 命令在执行结束后到达：返回 `guard.activeExecutionChanged`，不得影响下一任务。
11. Desktop 在线、Web 断线重连得到相同 `executionFailover`；旧 snapshot/旧客户端均可解析。
12. 同一 command 重试不产生重复事件；目标完成后 snapshot 为 `null`。
13. 跨供应商传递 canonical 上下文和稳定工具结果，但不传凭据、私有缓存或隐藏推理。
14. 父任务切 B 时，session-inherited workflow actor 在自己的安全边界切 B；explicit run/script/approved override/resume pin actor 保持原选择，且不显示 waiting/blocked。
15. `run-launched` 只有 `subagentSelection` 会话快照、没有 `subagentModel`：actor 仍是 session-inherited；两者都存在时才按 explicit run 模型处理。对两种 run 分别执行 ask revise 后 provenance 保持不变。
16. 当前 foreground 已切到 B 后进入同一执行的后续 Turn：新 Turn 在首次请求前继续使用 B，不回退 A，不产生重复 transition。
17. active B 在重新构造或 apply gate 内被 C 覆盖：同一次安全边界直接使用 C；若 active 目标确实不可用且没有更新目标，则投影 blocked，不能每个 Turn 无限重试。
18. 冷恢复的旧 assistant 消息缺少 provider/model provenance：跨模型投影时删除带供应商私有元数据的 reasoning，保留 provider-neutral reasoning 和最终回答。
19. session-inherited workflow actor 在第一轮由 A 切到 B，父 foreground 随后结束：同一 actor 的下一次 ask 仍从 B 开始；后来创建且属于保留 lineage 的继承 actor 也用 B。journal `resolvedModel` 更新为完整 B 选择，进程恢复不得 pin 回 A；actor runtime 关闭后 target/registration 被清理。
20. 普通子代理在 Turn 结束、registry 尚未写终态的窗口收到切换命令：registry 写入 completed/failed/cancelled 后 target 必须被清理，不能永久停在 waiting。
21. active B 在后续 Turn 无法构造：投影 blocked 且该 Turn 明确失败，不得继续向 A 发请求；尚未 active 的 B 不兼容仍允许 A 完成当前逻辑执行。
22. 同一 provider/model 从 `high` 改为 `medium` 或切换 speed：完整 `ModelSelection` 作为新目标参与 latest-wins、visited 和 retry-yield；目标必须精确支持所选 options，不能因基础模型 ID 相同而忽略切换。
23. Router 在无策略状态进入安全边界后、第一次异步恢复前收到 B：必须在该边界继续解析并切到 B，不能先向 A 多发一次请求。
24. runtime-lifetime workflow actor 从 A 成功切到 B、旧 policy 清除后再选择 A：registration 必须以 B 为当前选择生成 A target，并在下一安全边界切回 A；模型 apply 尚未成功时不得提前把 registration 标成 B。
25. foreground 已结束且普通 running subagent work 数量很多：Renderer 在 64 项新协议上限内先携带 Runtime 权威资格列表，再补普通 work；显式 run/script/approved/resume actor 不在列表中，也不能被 `workflowRuns` 或 `subagents.running` 推断加入。旧 CLI 缺少资格字段时只发送普通 work，保持 32 项兼容上限。
26. runtime-lifetime session-inherited actor 首次 retain 发布资格 ID，turn-lifetime 普通子代理 retain 不改变列表；重复 retain 不发布重复事件；release 与 policy target 清理通过同一 revision 原子移除资格和目标。总 registration 超过 64、lineage 不超过 64 时每条 lineage至少有一个代表；SessionResumed 后 policy 为 null 且资格列表为空，旧乱序事件不能恢复任一字段。
27. B 的激活 mutation 尚未结束时，`beforeActivate`、模型 apply 或 selection sink 内又无等待地入队 C：Router 必须等待队列稳定并在当前调用返回前应用 C；调用方不得看到 B 后先发一次请求，且 `beforeActivate` 的恢复副作用只执行一次。
28. runtime-lifetime actor 从 A 接管 B 时 journal sink 首次失败：本次调用报错且 loop/session/registration 仍为 A，policy 保持可重试；下一安全边界 sink 恢复后原子落到 B，后续 ask 和崩溃恢复都不能回退 A。
29. session-inherited actor 经 ask revise 或 amend 导入了前驱 `resolvedModel=A`：创建 runtime 后 provenance 仍为 `sessionInherited` 并能继承父 B；只有原 provenance 为 explicit/resume pin 时 seed 才保持固定。
30. 前驱 run 使用完整选择（含 speed/options）和 approved actor override，仅修改脚本或并发度执行 AmendWorkflow/GUI settings：后继 launch 与 actor 解析完整保留两者；显式清除操作除外。
31. actor close 时 release 事件首次 append 失败：session/runtime 句柄不得从 driver map 丢失；生产默认 retry timer 保持进程存活，重试 close 成功后 eligibility 与 target 同 revision 移除，且不会重复关闭已成功的其他资源。
32. 用户选择 B 后 foreground 结束，而同 lineage workflow 尚未创建首个 actor：run 级保留使后创建的 session-inherited actor 第一轮直接使用 B；显式 actor 仍不继承，run 终态时保留项必须清理。
33. A 的 retry 已完成 backoff，但第二次 admission/header/status 等异步准备期间用户选择 B：generate 与 stream 都必须在真正调用 A 前让出，释放 admission ticket，A 的 provider 调用次数仍为一次。
34. 工具结果处于未知状态时 B 被标记 unsafe，用户随后选择 C：同一 execution/child 仍不得接管 C 或重放工具；其他独立 target 不受影响。
35. A 发生可重试失败但 B 缺少当前请求所需工具、媒体能力、options 或上下文容量：Adapter 不让出 A retry；Core 投影 B blocked，既不降级到 B，也不因一个不可用目标提前放弃可恢复的 A。
36. 同一 provider/model 从 `reasoningLevel=high, speed=standard` 切换到 `reasoningLevel=medium, speed=fast`：等待、切换中、已切换和 blocked 状态文案都同时显示两端的本地化 option，不能显示两个相同的基础模型标签；自定义 option 值不得被翻译键或占位文案替换。
37. 普通子代理写入 completed/failed/cancelled 后首次 policy release 失败：registry 终态保持不变，父 Runtime residency 仍持有唯一清理句柄；显式关闭父 Runtime 时 close 等待该句柄，生产 retry 保持进程存活，重试成功后 target/eligibility 被清理，已成功的 release 不重复调用。若接线提供 release 却未提供 cleanup owner，创建端口立即失败而不是在终态吞掉错误。
38. `stopTask` 提交旧子代理 cancelled/killed 后立即对同 taskId 执行 SendMessage resume，而旧 provider 忽略 abort 并迟到返回：resume 在旧 run settlement 前不注册新代次；旧 run settle 后新代次保持 running，registry 不被旧 completed/failed 覆盖，也不发布旧代 completed/failed 事件。
39. 同一 taskId 并发 stop 与 SendMessage 时，SendMessage 必须等待 stop 的终态提交、通知、abort、旧 finalizer settlement 和 policy cleanup 全部收口后才能 resume；旧 stop 不得命中新代 controller。两个并发 stop 只能有一个赢得终态 CAS、通知和 abort；若 provider finalizer 先赢得 completed/failed，stop 返回现有终态且不改写为 killed。
40. session close 时 Workflow actor `disposeCompletion` 或普通子代理 finalizer/cleanup 首次失败并跨过 browser/execution/MCP deadline：第一拍先封闭 Runtime 准入并启动这些资源的关闭，各资源在第一次 await 前同步登记可能写 store 的 work；所有资源都已启动并完成各自有界等待后才开始无 deadline 的 stable drain。资源 deadline 不阻止其它关闭；session-store-dependent work 中一个失败也必须等 sibling 和后续新增 work 全部 settle 后才向上抛错，session store 在 stable drain 成功前始终保持打开，成功后才最后关闭。
41. 协议全局 shutdown 的 server/app close 超过单步 budget：projection、MCP、provider 和 telemetry 等独立资源仍会被尝试；共享 session store 不得随 budget 超时关闭，必须等待同一个幂等 server shutdown 最终完成后再关闭。
42. foreground run / background start 在 metadata IO 中开始 shutdown，或 terminal SendMessage resume 在等待旧代 cleanup 时开始 shutdown：准备阶段已由 session-store-dependent owner 持有；异步准备返回后的第二次 admission 拒绝新代，不创建 controller、不调用 provider、不留下 running registry，也不会在 stable drain 返回后迟到登记 settlement。foreground 已启动后即使 abort guard 先返回，taskId settlement 与父 Runtime close 仍等待底层 child、artifacts 和 terminal side effects 真正退出，stop 后 resume 不得与旧 foreground 代次并发。
43. Workflow actor 的 `runtimeFactory` / seed 尚未返回时 run 进入 dispose：in-flight creation 必须阻止 `disposeCompletion` 提前完成；工厂返回的 runtime 即使 seed 随后失败、尚未成为正式 session，也必须转交同一 close/retry owner，直到 runtime-scope release 成功，父 session store 才允许关闭。
44. 一条命令同时观察到一个 foreground 和 64 个 background 时，65 个真实目标全部进入策略且协议状态可解析；随后同 lineage 新建 child 时，即使公开目标投影已满，该 child 仍能接管、blocked 或完成。公开 `targets` 始终不超过 65，顺序稳定，截断时公开真实 target 总数与 `targetsTruncated=true`，释放可见目标后先前被截断的真实目标可在后续投影中出现。
45. execution-scoped Turn 从 A 接管 B 时，B 的预检与激活都收到该 Turn 原始 `requestDependencies` 且预检不调用 auth source；激活后的普通请求和工具内部请求仍经过原 Runtime 的 admission，workflow actor 仍使用 unbounded retry budget，account-plan 仍按 attempt 刷新 runtime header，off-peak B 在真正请求时使用原 execution auth source，不能因接管改用空凭据或绕过治理。
46. A 的可重试错误发生时，当前目标已经被 unsafe fence 禁止、两次交接预算已耗尽或目标 selection 已在 visited 集合：Adapter 的 generate/stream 都不得让出原重试；Core 不能出现“A 已停止、目标又拒绝”的双空路径。
47. B 已可接管，但 C 的 policy event append 尚未完成：retry-yield 闸门必须等待 mutation 稳定后按 C 重新判断；C 不兼容时继续 A retry，C 兼容时直接把控制权交给 C，不能基于过期 B 先终止 A。
48. generate/stream 首次得到可重试的 zero-output completion，并在 empty-completion backoff 中选择 B：下一次物理调用前必须经过同一稳定让出闸门，A 的物理调用次数保持一次。
49. Account Plan A 在 attempt 前等待 runtime headers 时选择 B，随后 Host 返回 `headersApplied=false` 或结构化凭据解析失败：generate/stream 都把它归类为 `provider.authentication_failed`，关闭失败步骤后由 B 接管；不得直接以通用 RuntimeHeadersRefreshError 结束 Turn。
50. A 的 `maxAttempts=2` 在 attempt 1 失败并完成一次 backoff 后让出给 B，但 decision 返回后 C 覆盖且 C 不兼容：Core 必须恢复同一 selection 的 A attempt 2，A 总物理调用只能为两次且不得再次等待 attempt 1 的 backoff；off-peak 排队 claim 的 consumed attempt 为 0。若 B/C 成功接管，A 的 offset 不得污染目标模型的 attempt 编号或预算。
51. 健康 A 的同一安全边界里，B 分别在 `beforeActivate`、model factory、能力校验、selection sink 或模型应用窗口被不兼容/不可用/已访问/预算耗尽的 C 覆盖：B/C 的物理请求都不得发生；C 投影 blocked，loop model、context、visited、transition count、session selection、actor journal 与 registration 全部保持 A，且 `beforeActivate` 最多成功一次。若 C 兼容，则同一边界只提交 C 并直接请求 C，不能产生 B 的 active 事实或请求。
52. `sessionInherited` actor 从 A 接管 B 后，journal 原子保存 `{ resolvedModel: B, modelProvenance: sessionInherited }`；冷恢复以 B 为接续起点且仍可随父任务切到 C。approved/script/run/resumePin actor 冷恢复后仍固定；amend/import seed 同时传播 selection 与 provenance，inherited seed A 遇到父当前 B 时以 B 开始，pin seed A 仍固定 A。旧行 provenance 为 NULL 时，有显式配置可重建其来源，无显式证据不得提升成 pin；任一 journal 写失败时 selection 与 provenance 都保持旧值。
53. B 激活或 active reapply 期间仅有同一 policy source 下的 actor retain/release、资格投影或其它非目标替换 mutation 入队：旧 prepare 可以丢弃，但 Router 必须在同一安全边界重新解析并最终应用 B；不得把队列中“有后继 mutation”等同于 B→C，也不得因此向 A 多发一次请求。`beforeActivate` 和失败 step 关闭仍最多成功执行一次。
54. foreground command 已产出成功结果、但首次 policy complete 事件 append 失败，且下一条 command 已排队：当前 active execution 先从实时目标中移除，command queue 持有原 execution ID 并保活重试；失败不得形成 rejected drain 或覆盖已返回结果。重试成功后下一条 command 自动执行，旧 target 不残留，也不需要额外 enqueue 才能唤醒。
55. runtime-lifetime actor 从 A prepare 到 B 且 journal 已成功写 B，但 active policy 事件 append 失败：同一 mutation 先补偿 journal 回 A 再返回 append 错误；loop/session/registration 仍为 A，policy 仍 waiting B，下一安全边界可重试。若补偿失败则必须 fail closed，不能继续请求任一不确定模型。
56. 前驱 run 的 actor seed 为显式 `runModel=A`，用户通过 AmendWorkflow 或 GUI settings 显式清除默认子代理模型，父会话当前为 B：后继 `run-launched` 必须持久写入 `subagentModelProvenance=sessionInherited`，actor cache miss 时忽略 seed A、从 B 创建并获得父 failover 资格；后续 ask revise/amend 与冷回放继续携带该语义。同 run 已有 journal 绑定时仍从该绑定继续，不能因清除标记在冷恢复时跳到会话后来改成的 C。升级前没有 provenance 字段的 launch 保持兼容，不把普通缺席猜成一次历史清除。
57. actor journal 或 imported seed 的 `selection:<JSON>` 若 provider/model 为空、options 类型错误或含 schema 不接受的字段，actor 创建必须以 pinned-model 错误失败，不得把畸形 options 交给 provider runtime。
