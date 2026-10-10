# RuntimeEnvironmentService 合同

状态：公共合同已补齐 M4/M5 所需的最小形状；M1/M2/M3 有局部实现，M4 的 P4-02～P4-07 与 M5 的 P5-01～P5-06 尚未形成可放行的生产闭环。本文不是完成记录，实际能力以当前源码、公开 schema 和验收证据为准。

规格唯一来源：[worktree-runtime-environments.md](../../../../specs/worktree-runtime-environments.md)。实施任务见 [worktree-runtime-environments-plan.md](../../../../specs/worktree-runtime-environments-plan.md)。

## 身份与所有者

- 目标 Host 的 `RuntimeEnvironmentService` 是 `environmentId`、冻结 manifest、环境 revision、资源映射、准备/升级/释放 operation 和环境投影的唯一事实 owner。
- `WorktreeService` 继续拥有 binding、checkout、branch、Git candidate、snapshot、删除墓碑；它只经注入 port 调环境，不保存第二份环境事实。
- CLI `CommandInbox` 拥有输入接纳、turn、恢复和队列；环境服务不新增 accepted input queue。
- 既有执行/终端/MCP owner 拥有子进程、PTY、退出与停止证明；环境服务保存收据并协调，不按 PID、端口或进程名授权停止。
- 跨窗口环境锁、resource lease 和 fencing 由目标 Host 环境 owner 协调。Main、relay、Renderer、手机不保存环境业务队列、快照或租约。
- UI 只读投影；草稿、pending overlay、展开状态和诊断追加意图不构成环境事实。

身份规则固定为 `workspaceIdentity?.trim() || workspacePath`；`workspacePath` 只用于文件、cwd、Git 和展示。远端请求必须同时保留 `workspaceIdentity` 与 `remoteSessionId`，不能按路径单独授权。

公开查询与升级恢复使用 binding 的 `workspacePath` 执行作用域，仓库子目录不能替换为 `checkoutPath`。目标 Host 的授权 facade 核对 binding/identity 后统一转换为 checkout 根目录的环境存储作用域；UI、remote relay 和本机模式不另建映射或放宽授权。

绑定查询只能向 WorktreeService.list 传入路径与可选身份；环境 ID、绑定 ID、动作、版本、requestId 和预算不得透传到该严格合同。attachment scope 优先级与完整环境请求的后续 owner 校验保持原规则。能力与快照是独立查询结果：UI 保留各自成功事实，能力读取失败关闭动作授权，快照读取失败不得被解释为 Host 不支持或环境未准备成功。读取不产生环境/工作树迁移或执行副作用。

## 公共数据合同

公开 schema 的唯一出口是 `@lcode/shared`。新增字段均为 additive；旧端缺字段必须保持旧语义，但不能由缺字段推断具备托管能力。

| 形状                                 | 合同要求                                                                                                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RuntimeEnvironmentBindingReference` | 持久 binding 可暂存 `revision=0` 的准备中引用；不表示可消费。可带 `manifestDigest`，缺失时只能按旧引用兼容读取。                                                                            |
| `RuntimeEnvironmentReference`        | 执行/消费者引用的 `revision` 必须为正数；可带 `manifestDigest`。每次 resolve/acquire 都核对 environment、binding、scope、revision 和 digest。                                               |
| `FrozenManifest`                     | revision 内不可变；包含 backend、OS/arch、工具来源/路径、声明摘要和 manifest 摘要。锁文件内容必须参与摘要，不能只用 lockfile 名称。                                                         |
| `RuntimeEnvironmentRecord`           | `currentRevision` 表示冻结 manifest 代际；`stateRevision` 表示环境事实/事件代际，两者不可互换。记录损坏或未知版本不得修成 ready。                                                           |
| `RuntimeEnvironmentProjection`       | 只出状态、版本、工具来源、服务安全投影、资源概况、operation 和结构化错误；不出 token、lease、ownerId、完整 env overlay、凭据或内部路径收据。                                                |
| `ManagedServiceReceipt`              | `generation` 是服务进程代际；`stateRevision`/`operationId` 用于事实对账；running 必须有真实监听证据，stopped 必须有进程 owner 退出证明。PID 仅诊断。                                        |
| `WorktreeValidationReceipt`          | 必须关联 candidate HEAD/tree、环境引用或明确未托管事实、manifest/declaration 摘要、命令、exit code、有限输出和 verifiedAt。`skipped` 必须有明确确认；缺收据不得进入新发布 ready。           |
| `RuntimeEnvironmentDiagnostic`       | 只允许白名单字段：用途、环境/版本、工具来源、有限路径、命令摘要、退出码、stderr 尾部、日志引用、监听事实、安全阻塞标签和已发生副作用。不得传递 token、lease、envOverlay、凭据或未脱敏 URL。 |
| `RuntimeEnvironmentResourceSummary`  | 扫描带 `status=complete/partial/unavailable`、数量/时间预算和保护引用数。partial/unavailable 不等价于空闲、无引用或可删除。                                                                 |
| `RuntimeEnvironmentSnapshot/Event`   | 由环境 owner 产生，按单调 `stateRevision` 对账；旧帧、乱序帧和 pending overlay 不得覆盖较新事实。desktop-continuous 与 web-remote-replayable 只改变交付方式，不改变事实 owner。             |

## 能力协商与兼容

`lcodeRuntimeCapabilitiesSchema`、V4 `HostCapabilities` 和环境 capabilities 使用可选的 `runtimeEnvironment` 能力块。缺失该块表示旧 Host，不表示支持托管。能力块若声明协议版本，必须显式列出支持的 action；支持 action 的最小词表为 `prepare`、`resolveContext`、`retainSession`、`releaseConsumer`、`startService`、`stopService`、`resourceSummary`、`garbageCollect`。

- 旧会话没有 `environmentRef`：继续原本地执行，不发送环境反向请求。
- 显式 `environmentPolicy=managed` 或显式托管 action：先检查 Host capability；缺能力返回 `capability-unavailable`/method-not-found 语义，不静默沿用本机环境、不伪造 ready。
- `environmentPolicy=inherit` 只能沿用已经持久化的决定；不能因为新 Host 有能力就隐式升级旧 session。
- `environmentPolicy=local` 是用户明确的本机策略，必须记录为未托管，不显示为完整独立环境。
- 旧 binding/manifest 缺 `manifestDigest` 或 `stateRevision` 时可读，但不能满足新候选精确验证、恢复新环境或 GC 活引用证明；实现者应重新准备/对账，而不是补写猜测摘要。
- 旧 Host 对未知严格字段可能返回 method-not-found 或 schema error；调用方只在明确能力后发送新 action，不能重试到另一个 Host 或按路径回退。

## 方法与状态

当前已公开并部分接线：`getCapabilities`、`prepare`、`get`、`list`、`resolveContext`、`release`、`reconcile` 以及消费者 retain/release 反向方法。以下是 M4/M5 实现必须满足的最小扩展，不表示这些服务动作已经接入生产：

| 动作                              | 必需输入                                                                | 成功/失败语义                                                                                                                               |
| --------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepare` / `upgrade` / `restore` | requestId、scope、binding、purpose、expected revision/digest、operation | 同 requestId 复用原 operation；升级/恢复产生新不可变 revision/environmentRef；不能复活旧 PID、URL、running。                                |
| `resolveContext`                  | attached workspace、binding、正 revision 引用、consumer、cwd、identity  | 只返回冻结 cwd/tool paths/env overlay 摘要；非 ready、fence、scope/cwd/digest 不符均拒绝。内部 lease 不出 wire。                            |
| `startService`                    | requestId、environmentRef、serviceId、expected revision/generation      | 同环境同服务并发返回同一收据；代际不符返回 stale/needsRestart；真实 bind 健康后才 running。                                                 |
| `stopService`                     | requestId、environmentRef、serviceId、expected revision/generation      | 只允许对应进程 owner 停止；无退出证明保持 stopping/failed/blocked，不能伪造 stopped。                                                       |
| `resourceSummary`                 | scope、可选 environmentId、数量/时间预算                                | 返回 complete/partial/unavailable；扫描未完成不作删除依据。                                                                                 |
| `garbageCollect`                  | scope、requestId、预算、dryRun                                          | 只处理共享受管理工具和下载；活消费者、旧 revision 活服务、进行中下载和锁保护项必须保留；部分扫描返回 partial/blocked。                      |
| `release`                         | requestId、environmentId、expected revision/digest、生命周期 reason     | 持锁重读并 fence；先取得绑定进程真实停止证明。存在活消费者、未确认服务或清理失败返回 `releaseBlocked` 与有界诊断，继续同一 operation 重试。 |

环境状态与服务状态独立。`ready` 不代表服务 running；服务 stopped 不代表环境目录已物理删除；`released` 不代表聊天历史已永久删除，除非 Worktree 删除编排已经完成其明确的结算回调。

## 事件顺序与 fencing

### 准备/升级

1. Host capability、workspace identity、binding/purpose 和 requestId 校验。
2. 环境短锁内重读当前 record、operation、活消费者和服务收据；核对 expected revision/digest。
3. 读取声明和锁文件**内容**，生成 declaration/manifest digest；冲突、未知语法、缺能力和下载/完整性失败结构化结算。
4. 写入新的 immutable manifest/revision；`stateRevision` 单调推进，旧 revision 的在途命令和服务保持原上下文。
5. 按固定锁顺序取得工具/依赖/checkout writer 许可，安装与验证保存实际收据；失败记录已发生副作用并可从原 operation 重试。
6. owner 结算新环境 ready 和 environmentRef；下一条执行边界才重新 acquire/resolve，新请求不能覆盖在途上下文。
7. 服务需要新 revision 时返回 needsRestart；只有明确 stop 且取得旧代际退出证明后，才允许新 generation start。

### Worktree 删除/归档

删除编排的单一 owner 是 WorktreeService，环境 release 是其注入的环境 owner。固定顺序：

1. Worktree 持久化 `deleting`、拒绝新 checkout writer，并冻结首次删除的 branch HEAD/path。
2. 环境 owner 在同一环境锁内写 fence，拒绝新消费者；按 owner 停止本 binding 拥有的服务/进程树并等待真实退出证明。
3. 对账并关闭可关闭的 resident/process；**session consumer 引用不因 close、归档或 transport 断开释放**。
4. 通过 CLI SessionStore 先清理已 journal 的精确会话 entry/正文/parts/inputs/运行记录；失败保留 `deleting`，不伪造成功。
5. 清理结算确认后，WorktreeService 删除受管 checkout、refs 和可重建资源；目录/登记/branch 仍存在时不得写 deleted。
6. 删除确认回调按 binding+sessionIds 精确释放 session 引用；环境 owner 清理私有可重建资源并写最小 tombstone。其他 binding、identity、旧 revision 活引用和共享工具不受影响。
7. Host task index 最后清理投影并广播删除事实；重复请求继续同一 journal/operation，不新建第二次删除。

不得按 node.exe、Shell、端口或孤立 PID 泛杀；Windows 文件占用、未知进程、目录重定向和会话清理失败都保留可重试状态。

Worktree 生命周期的执行停止统一通过 Host 注入的 `stopWorktreeExecution(binding)`，覆盖 canonical checkout 子目录及已退休的受管实例，保留身份隔离；不在环境 release port 再维护一条仅按根 workspace key 释放的路径。进程树退出结算仍由原执行 owner 释放精确 lease；历史未知 owner 不能因当前进程池为空、PID 不存在或重启而被清除。

Host-only process acquire 可附带实际 client 的 `RuntimeConsumerProcessOwner`；owner 收据先于 consumer 持久化，使用实际 runtimeInstanceId 关联 ownerId。`confirmProcessExit` 只由真实进程树退出后的 bridge 调用，保存精确 lease 退出收据后再走原 release。删除/release 在同一环境锁下恢复有退出收据的精确引用结算，不认领仍活跃、缺失或旧版未知 owner。收据严格校验、私有保存，不修改公开 consumer schema，不泄漏 owner/lease/PID 到 UI。确认退出与引用写入之间的失败可跨 Host 重启恢复。

用户确认 Worktree discard 后，可由唯一删除 owner 自动退役严格旧桥接格式、属于已核验并永久清理的 sessionIds 且完全缺少 owner 收据的 process 引用。stop 只容许这些旧引用暂留；持有 exclusive checkout writer、复核原 journal、结算 session 引用后才调用 Host-only `retireLegacyProcessesForDeletion`。环境锁内核对 scope/binding/current revision/discard fence，先保存 `confirmed-worktree-discard` audit 再写精确引用墓碑；不生成退出证明，不放宽新 owner/服务/归档/升级/普通 release/GC 的保护。

### 快照恢复

代码 snapshot/index/HEAD 恢复与运行环境重建是两个事实。恢复顺序为：校验快照和目标目录 → 恢复 Git 文件/index → 以 `operation=restore` 按当前 Host 平台和声明准备新的 environmentId/revision → 持久化新的 binding/environmentRef → 对全部同树 session 重新对账绑定 → 从 stopped/not-running 初始状态开始。旧服务 receipt、PID、端口、running、私有数据不因 Git snapshot 自动恢复。不可重建私有数据必须在清理前由用户选择 save/export/discard；没有选择不得显示完整恢复成功。

## 失败语义

升级取消的恢复遵循主 spec §10.4：Worktree owner 持久化取消及原 expected reference；UI 从 binding 恢复原失败请求，明确的新请求才可接续已取消升级。环境 owner 不复活旧 cancelled operation。候选首次准备失败后的 revision=0 引用由 Integration owner 保存用于精确清理，取消/删除完成后环境记录结算为 released，不能遗留零代记录永久保护全部工具。

- `stale-reference`/`scope-mismatch`：只读当前事实，旧请求不得覆盖新代。
- `configuration-conflict`/`unsupported-declaration`：指出来源/字段；用户修正或明确覆盖后创建新 revision，不无限原样重试。
- `download-failed`/`integrity-failed`/`dependency-install-failed`：隔离坏产物，保留退出码、脱敏尾部和副作用，沿原 operation 显式重试。
- `port-bind-failed`：真实 bind 失败才结算；适配器不能安全重分配时保持失败，不显示虚假 URL。
- `process-unknown`/`release-blocked`：缺少停止证明或仍有引用，状态保持 blocked/unknown，reconcile 后继续同 operation。
- `environment-rebuild-failed`/`restore-data-required`：代码快照可恢复不代表环境/私有数据可恢复；binding 不得写 ready。
- `validation-stale`：candidate HEAD/tree、target HEAD、manifest/digest、revision 或命令收据任一变化即失效；必须重新验证。
- `gc-incomplete`：扫描预算耗尽、锁/活引用或下载进行中时返回 partial/blocked，不把未扫描当作可删除。
- `cancelled`：持久结算，不复活 firstInput、旧 operation 或旧资源。

错误 message 只作诊断，不是 UI 稳定分类；UI 使用 code/stage/retryable 和有界 diagnostic。诊断中的 owner 只能是安全 label/path 摘要，不能泄露内部 lease、ownerId、token、秘密环境变量或认证 URL。

## 当前边界与验收状态

Explicit Worktree discard also removes the validated environment-private resource root,
including data, after exact chat deletion and all consumer/service exit checks. Archive,
upgrade, candidate cancellation and ordinary release retain private data. Logical released
state does not skip an explicitly confirmed discard cleanup. The environment owner retains
minimal tombstones/audit; shared stores and other bindings are outside the removal scope.

Lifecycle `clearRebuildable` receives a trusted Host physical-directory removal port after
execution settlement. It validates only the fixed temp/cache/logs roots and their ancestors,
then removes each tree directly; scan/GC budgets do not govern this operation. Internal links
are removed as links. Redirected roots remain protected, private data/shared stores remain
outside rebuildable targets, and partial failure preserves retryable lifecycle state.

Host-only 的 `RuntimeProcessOwnerObserver` 由执行 Host 注入；完整 owner 收据的根 Agent 不存在也不生成退出证明。仅原确认 discard 在独占 writer 和精确历史清理后可复用 retirement authority，私有审计记录原 owner/观察时间。live/unknown owner、归档/升级/普通 release 继续阻塞；缺失观察能力时不恢复现代遗留引用。

- 当前源码已有消费者 lease/release fence、Git candidate HEAD/target 校验、目录删除/代码 snapshot 和 Git 诊断通路；这些不能替代 revision 升级、候选环境精确收据、物理环境回收、新环境恢复、GC 和环境失败草稿。
- 当前 `release` 已能在环境锁内检查活消费者/未确认服务并返回 releaseBlocked；逻辑引用结算不等于停止服务、删除目录、清理私有数据或工具缓存。
- Windows 本机已有局部静态/定向测试记录；macOS/Linux 实机、实体手机、完整 GUI 和三平台原生 ENV-30 未在本次合同修订中验证，不能写成已完成。
- 任何 P4/P5 任务只有在实现、定向/集成测试、平台证据和主文档验收矩阵均补齐后才可改为完成；新增 schema 本身不构成门禁通过。
