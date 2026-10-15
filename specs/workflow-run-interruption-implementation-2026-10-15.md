# 工作流中断修复增强实施报告

已完成 A → B/C → D → E 及后续复核缺口的系统修复。父回合结束和常驻池回收读取同一组运行事实；真正关闭时保留首次原因、封闭业务准入并排水；共享 journal 的执行权受到代际校验保护。本次补齐关闭失败丢失 owner、失败 close 无法重试、跨父会话 Resume 三项缺口，并解决同链路新发现问题。此前 Browser 作用域与子代理创建事务修复保留并参加回归。**本次去重 713 项测试通过，根与 CLI 类型/Lint、新 Agent 构建及 staging 均通过；源码和隔离环境验收完成。**

实施起点为 `e1e1acfc`，应用版本仍为 3.18.8。当前源码与隔离 Host 验证通过；没有安装发布包、升级运行中的原应用或自动重跑原失败业务。原日志能确认 Protocol 关闭后发生工作流取消，仍不能确定最早关闭调用者，也不能据此认定供应商不稳定或模型主动停止。

## 本次补齐结果（2026-10-15）

本次以复核提交 `2eccaf4b` 为起点，先更新方案第 10 节，再补失败测试和实现。原始关闭原因仍未知的历史事实不变，不把资源关闭缺陷和供应商网络异常混为一谈。

| 已确认缺口                                                | 修复后的行为                                                                                                                                | 正式证据                                                                                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| workflow owner 退休失败被 App 关闭吞掉                    | 关闭实际拒绝保留原 App、lease 和共享 store；独立资源仍尝试清理，成功后才退休和关库                                                          | `session-close-retry.test.ts` 真实 SQLite + Core + service + SessionFacade + Protocol 资源组合；`runtime-cleanup.test.ts`    |
| SessionFacade 缓存 rejected close，重试无效               | 每个 facade 只有一个关闭进度 owner；在途/成功复用，失败项重试，已成功资源不再关闭；首次 close 上下文不变                                    | 并发 close、drain/Execution/MCP/store 失败及重试测试                                                                         |
| B 会话使用自己的 lease 恢复 A 的 run，先接受后 fence 失败 | 从 journal 读取原 parent；通过既有 Protocol registry、resume flight 和 pool gate 复用/恢复 A，在 A 登记后才返回接受；wait/cancel 继续委托 A | `workflow-run-owner-routing.test.ts`、`workflow-run-owner-router.test.ts`、`workflow-run-owner-protocol.integration.test.ts` |

同链路新增问题也已纳入：

- 构造尚未发布 App 时，退休 lease 抛错曾跳过后续资源清理、覆盖原错误。现在保留原始错误及精确重试句柄，ProtocolRuntimeResources 持有它；同 session 下次构造及进程关闭先重试。资源清理成功后才能退休，退休后才能关闭自建 store；借用资源不被关闭。
- 有界等待结束后，Execution/MCP 的原 close 可能在关键 drain 期间迟到拒绝。现在检查原 Promise 的失败事实，不能因为先超时就误报成功；不重复启动尚在途的 close。
- 两个 Resume 都越过异步缓存重建时可能重复启动同 ID 引擎；关闭与 Resume/Amend 也存在等待后的旧预检。现在在真正登记/launch 的同步片复核运行、关闭和 lease；B 在等待 A 冷恢复期间关闭也不能继续代发执行。
- fenced submit 省略可选 parent 时沿用本 service 的 parent；显式其它 parent 在接受前拒绝。无 durable lease 的瞬态内存装配保留原有本地读能力，不因缺省 parent 被误判为跨会话。
- 跨会话长时间 wait 不再一直占用全局 resident operation gate；读取原端口后释放 gate，真实 run 仍由原 App 的运行事实保活。冷恢复的 resume gate 则保持到准入完成。
- `owner_unavailable` 纳入 shared 运行时 schema，经既有协议公开入口供 CLI contracts 和 UI 共用。工具、TUI、V4 ACK 和中英文界面均返回可操作拒绝；修复类型检查发现的 TUI 漏分支，不发布虚假的后台接受。

未删除 parent/token fence，未改写 run parent、lineage 或 Browser authority；未新增执行宿主、客户端可设置的 owner 权限、数据库 migration 或环境变量。状态所有者和事件顺序见[方案第 10 节](workflow-run-interruption-repair-plan-2026-10-14.md#10-复核缺口补齐契约2026-10-15)。

| 本次提交               | 内容                                                             |
| ---------------------- | ---------------------------------------------------------------- |
| `3a7a7059`、`0a9d5add` | 先定义关闭重试、原 owner 路由、构造失败清理与异步准入契约        |
| `19075702`             | SessionFacade 资源关闭进度、失败重试及共享 store 保护            |
| `03d411e7`             | 迟到资源关闭拒绝保留及回归                                       |
| `976eee2e`             | 未发布 App 构造失败的清理事务与精确重试                          |
| `81a9afa5`             | 原执行 owner 路由、异步准入复核、统一拒绝契约和工具/TUI/Web 验证 |

截至 `81a9afa5`，相对 `2eccaf4b` 共 41 个文件、增加 1,779 行、删除 187 行，含先行方案更新；不含本报告收尾与无关本地改动。

## 本次实际验证

本次日志统一位于 `.artifacts/workflow-interruption-followup/`；下表各组互不重复计数。全部使用临时目录、合成会话和固定模型结果，未读写原业务数据或请求真实供应商。

| 验证                                                          | 实际结果                                                                         | 日志                                               |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------- |
| freshness                                                     | 通过，相对 origin/main behind 1，低于阈值 50；当前分支无 tracking upstream       | `freshness-final.log`                              |
| 根 typecheck / lint                                           | 均通过                                                                           | `root-typecheck.log`、`root-lint.log`              |
| CLI typecheck / lint                                          | 27 / 14 个任务成功                                                               | `cli-typecheck.log`、`cli-lint.log`、`checks.json` |
| verify:pre-push                                               | Lint 与架构检查通过；违规、基线、新违规均 0                                      | `pre-push.log`                                     |
| 本次源码/测试格式                                             | CLI 30 个、根 10 个文件通过                                                      | `format-check-cli.log`、`format-check.log`         |
| 关系图                                                        | 93 节点、137 边有效；本轮 3 节点、6 源码 seed 可解析                             | `feature-graph.log`                                |
| Bootstrap 全部 src 测试                                       | 535 通过，0 失败/跳过；新增 26 项                                                | `bootstrap-tests.log`                              |
| SessionStore / trust store / process owner                    | 87 通过，含真实多进程 SQLite fencing                                             | `storage-tests.log`                                |
| Core 子代理 / snippet / rewind / close / Resume 工具          | 57 通过                                                                          | `core-tests.log`                                   |
| 模型 runner / CLI 生命周期 / schema / shared / Browser bridge | 20 通过，分别为 8 / 6 / 4 / 1 / 1                                                | `model-schema-cli-shared-bridge.log`               |
| TUI 原 owner 不可用提示                                       | 1 通过                                                                           | `tui-tests.log`                                    |
| Web 浏览器 E2E                                                | 11 通过，覆盖实际工作流状态组件、宽屏/手机、中英文和明暗主题；含 Resume 拒绝提示 | `web-e2e.log`                                      |
| 隔离 Electron Host                                            | 1 通过，父回合结束保活、状态 lane 隔离、显式关闭归因                             | `electron-host.log`                                |
| Desktop Agent 构建 / 实际 staging                             | 构建通过；staging 测试 1 通过                                                    | `build-agent.log`、`bundle-staging.log`            |

合计 **713 个测试通过**；相对上一轮增加 29 项正式测试，不把临时缺陷复现和定向重复运行计入总数。旧实现失败证据保留在 `close-before.log`、`cleanup-before.log`、`routing-before.log`、`resume-race-before.log`、`parent-admission-before.log`、`late-close-before.log`、`tui-before.log` 等本机日志中。本次没有声称全仓格式基线通过；只检查修改范围。

使用 Node 24.21.0、pnpm 10.34.6。当前 Agent `apps/lcode-cli/packages/cli/dist/lcode.cjs` SHA-256 为 `e626a49ef418c8b02f621c39070b2b042071ac13944a17edfb53de6649867f9a`，已实际 staging。隔离 Electron 41.10.7（内嵌 Node 24.18.0）的后端夹具 SHA-256 为 `c7e5528d4eef6a279aa1e08f869e3607f789f4636d91442d37e1f798987efe85`；最新 Host 元数据仍由现有测试写入 `.artifacts/workflow-interruption/electron-host-latest.json`。两个 hash 分属完整 Agent 与生命周期夹具。

两种客户端模式在真实 V4 gateway + CommandInbox + 原 session 冷恢复链路分别通过：首次 Resume 使用原 A service、相同 commandId 返回 duplicate 且不重复执行；Protocol registry 外的活 owner 在返回接受前得到 `owner_unavailable`，原 lease 保持。该测试的 App factory 使用轻量装配，但 Core、workflow service、SessionFacade、SQLite、Protocol registry 和 gateway 均为真实实现。构造失败测试使用真实 SQLite 与 Protocol 资源 owner，未做完整生产 createLCodeApp 的逐分配点故障注入。

架构工具把 CLI、services、shared 识别为 unmanaged，已读取对应受控上下文；通过仅表示当前策略覆盖范围内无违规。macOS/Linux 实机、手机真机、跨 Host 联机、原安装包、真实供应商和原业务未验证。当前已完成源码和隔离环境修复验证，原安装包尚未替换。保留全部无关远控重连改动；本次无 push、发布、升级或业务重跑。

本次关键复核入口（从根目录运行）：

```text
node --import tsx --test apps/lcode-cli/packages/bootstrap/src/app/session-close-retry.test.ts apps/lcode-cli/packages/bootstrap/src/app/failed-app-startup.test.ts apps/lcode-cli/packages/bootstrap/src/app/workflow-run-owner-routing.test.ts apps/lcode-cli/packages/bootstrap/src/lcode-protocol/workflow-run-owner-router.test.ts apps/lcode-cli/packages/bootstrap/src/lcode-protocol/workflow-run-owner-protocol.integration.test.ts
node --import tsx --test apps/lcode-cli/packages/core/src/tool/handlers/resume-workflow-run.test.ts apps/lcode-cli/packages/cli/src/command-center/handlers/dwf.test.ts packages/shared/src/workflow-run-resume.test.ts
node --test packages/web/test/workflow-stop-reasons.test.mjs packages/desktop/scripts/workflow-lifetime-electron.test.mjs scripts/workflow-snippet-bundle.test.mjs
```

## 修复前复核结论（历史基线，2026-10-15）

复核基线为 `2f74b11e`。本次没有修改生产代码，保留原有无关本地改动。重新执行根仓库及 CLI 的 typecheck、lint，四项均通过；重跑关键后端测试 39 项、隔离 Electron 1 项、停止原因 Web E2E 1 项，合计 41 项正常回归通过。

另外新增三个临时最小复现，均确认以下缺口存在；它们的通过表示缺陷成功复现，不计作修复成功，也不与上一轮 684 项通过相加。

| 优先级 | 尚未闭环的问题                                                 | 复现和影响                                                                                                                                                                                                                                                                                                        | 源码位置                                                                                                                                        |
| ------ | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| P1     | 执行 owner 退休失败被 App 关闭吞掉                             | 对真实 SQLite lease 的 release 注入一次持久化失败。run service.close 拒绝，但 closeSessionFacadeResources 只记 warn 后返回成功；再次认领仍报 owner_active。Protocol 资源 owner 随后会将成功关闭的 App 从集合删除，原进程仍活着时会话无法正常接代。                                                                | `bootstrap/src/app/session-resource-close.ts:48`、`dynamic-workflow-run-service.ts:248`、`bootstrap/src/lcode-protocol/runtime-resources.ts:39` |
| P2     | SessionFacade 永久缓存失败的 close Promise，关闭重试未到达底层 | 注入首次 durable drain 失败，第二次调用 close 仍返回第一次 rejection，drain 实际只调用一次。外层虽然保留了失败 App 并允许再次 close，内层缓存使重试不能生效。此行为已有遗留，本轮资源句柄保留仍未消除它。                                                                                                         | `bootstrap/src/app/session-facade.ts:19`                                                                                                        |
| P2     | 跨父会话 Resume 缺少原 owner 路由，先接受后失败                | 同一项目中 A 会话留下 stopped/interrupted 的 run，A 已退休；从 B 服务调用 resume 返回 ok:true，随后快照变 errored/owner_changed，持久 run 仍 stopped。对照不带新 fence 的同一恢复路径可完成；新 fence 正确保护 A 的记录，但调用侧尚未将执行送回 A 的 owner。现有项目级枚举和工具指引仍会把这些 run 暴露为可恢复。 | `bootstrap/src/app/dynamic-workflow-run-submit.ts:391`、`adapters/src/storage/session-store/repositories/workflow-journal-owner.ts:125`         |

位置相对 `apps/lcode-cli/packages/`；上表第一行的 `dynamic-workflow-run-service.ts` 同样位于 `bootstrap/src/app/`。

建议的补齐边界：

- owner 退休失败必须成为未确认关闭事实，保留原句柄和重试能力，不能记成成功关闭或先关 store；其它独立资源仍应获得关闭尝试。
- close 在途时复用同一个 Promise，失败后允许原 owner 重试；保持首次关闭上下文，已完成清理不重复产生副作用。仅在外层保存资源句柄还不够，需要覆盖真实 facade 链路。
- 跨会话恢复先校验 workspace/attachment 与原 parent，路由或恢复原执行 owner，再发布接受结果；不能通过删除 parent/token 校验、改写原 parent 或使用 B 的 lease 绕过。无法获得原 owner 时给明确拒绝，避免先成功再后台失败。

以上记录的是 `2eccaf4b` 复核时的缺口，现已按本文开头的补齐结果实施。正式回归覆盖真实 SessionFacade + Protocol 资源 owner + SQLite lease 的失败恢复组合，以及 continuous/replayable 跨会话恢复；原 owner 活跃时不得产生第二执行者。

复核日志位于 `.artifacts/workflow-interruption-recheck/`：`critical-tests.log`、`electron-host.log`、`web-stop-reasons.log`、四项类型/Lint 日志；三个缺陷的复现脚本为 `owner-retirement.repro.test.ts`，运行结果为 `owner-retirement-repro.log`。全部使用临时目录与合成数据，未操作原会话、原安装包或真实供应商。

## 阶段结果与提交

| 阶段         | 实际完成                                                                                                                  | 提交       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- | ---------- |
| A            | 首次 ProtocolShutdownContext、IO/信号分类、绝对 deadline、Host 原实例清理意图；pending 与 failed 分开；移除入口遗留监听器 | `f18b3be9` |
| B/C          | 权威 residency snapshot、实际去激活同步复核、重入 gate；关闭时保留原资源 cleanup RPC 与 ACK；在途 App 构造纳入 drain      | `88031fa8` |
| D            | SQLite 现有 KV 中的执行 owner、完整值 CAS、事务内 journal fencing、带证明的孤儿收敛；启动失败回收未发布 lease             | `c6073acf` |
| 新发现问题   | 迁移测试核对当前目录完整 ID 集合，消除历史固定数量断言失效                                                                | `0ed54242` |
| E            | undefined 编译错误增加字段修复提示；取消与 HTTP/2 清理异常回归；真实状态组件的停止原因 E2E                                | `ac2cdb81` |
| 运行装配验收 | 隔离 Electron 主进程、真实 Host manager、stdio Agent 夹具、真实 Core/引擎/SQLite/Protocol                                 | `437794a0` |

实现详情及接口契约见[修复方案第 9 节](workflow-run-interruption-repair-plan-2026-10-14.md#9-实施契约2026-10-15)。

截至 `437794a0`，本轮实现与测试提交涉及 64 个文件，新增 2,264 行、删除 195 行；不含本报告及最终文档收尾。代码主要位于 CLI contracts、bootstrap、adapters、dynamic-workflow 和 services 的 Host 进程管理；Web 与 Desktop 新增内容用于验证。

## 所有者与事件顺序

```mermaid
sequenceDiagram
    participant H as Host 进程 owner
    participant P as Protocol 与常驻池
    participant A as 原 App / Workflow owner
    participant J as SQLite owner / journal
    participant R as 原资源端口
    A->>J: CAS 认领 parent + workspace + generation
    A->>A: 同步登记运行和 cleanup 阻塞
    P->>A: 父回合结束后读取权威事实
    A-->>P: 有 live / cleanup，拒绝去激活
    H->>P: 实例关闭，入口保存首次原因与 deadline
    P->>P: 拒绝新业务，保留原 cleanup 响应
    P->>A: interrupted 停止并等待构造及清理
    A->>R: 连接可用时按原 token / route 收尾
    A->>J: 同一事务校验 owner 后写终态
    A->>J: 实际 cleanup 完成后退休 owner
    P->>P: 排水后断开；真实 EOF 则立即撤销通信
    P->>J: session shutdown 真正 settle 后关闭 store
    H->>H: 确认进程退出后退休原实例外部资源
```

Host 记录其已有 pid、runtimeInstanceId、generation 和首次 termination reason。CLI 自己持有 closeId；当前协议没有可信的跨进程 closeId 握手，因此不强行拼接两个 ID。未知来源继续标为 unknown，不能用时间接近替代身份关联。

Desktop 的 continuous 与手机的 replayable 继续使用原投递边界、CommandInbox 和 attachment owner。本轮没有增加第二份运行计数、任务队列或自动恢复通道。

## 新发现并处理的问题

| 问题与原因                                                                  | 修复及依据                                                                                       |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 宿主 deactivate 可同步发事件；此前 gate 在调用后安装，重入 admission 有空隙 | 调用前安装临时 gate，blocked/同步失败撤销，started 延伸到实际 completion；确定性重入测试覆盖     |
| shutdown 只枚举已返回 App，遗漏尚在构造的候选                               | 资源 owner 同步登记 construction flight，关闭等待晚返回 App 清理，不能提前关闭共享 store         |
| 本机进程启动时间曾使用 os.uptime，得到系统启动时间                          | 改为 process.uptime；OS 查询限制执行时间，无法证明则保持 unknown；避免把活 owner 当旧实例        |
| journal 已写终态、本地 settlement 尚未更新，被日志称为 foreign writer       | 改为一次性 debug 观测事件，不据此宣称跨进程冲突；执行权由 owner/CAS 判断                         |
| owner 准入失败发生在 runtime 构造前，存在自建 store 泄漏风险                | 失败时只关闭当前 App 自建 store，借用的 Protocol store 保留；清理再失败时保留两份原因            |
| 两处迁移测试仍写死 23 条，当前基线已有 25 条                                | 比对当前迁移 ID 全集，保留失败后连接关闭及重试完成迁移的断言；没有修改 migration                 |
| CLI complete 残留入口信号/IO 监听器                                         | complete 幂等移除监听器并解除输入绑定，测试验证数量恢复                                          |
| Electron 验收夹具最初进入生产 src，跨 CLI 入口导入导致 rootDir 类型检查失败 | 迁入 bootstrap/scripts；不扩大生产 rootDir 或公开 API，重新执行 CLI 类型检查及 Electron 验收通过 |

Bug 的原因和修复依据已在相关实现中补充中文注释。

## 上一轮验证结果（历史记录）

实际使用 Node 24.21.0、pnpm 10.34.6，与 mise.toml 一致。隔离 Electron 为 41.10.7，其内嵌 Node 为 24.18.0；stdio 后端由固定 Node 24.21.0 启动。当前 Windows 环境没有 mise 命令，调用时显式选用固定版本运行时。

| 验证                                                 | 结果                                                                         | 本机证据                                                               |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 工作区 freshness                                     | 通过；无跟踪分支而跳过该项比较，相对 origin/main 落后 1 个提交，低于阈值 50  | `freshness-final.log`                                                  |
| 根 pnpm typecheck / pnpm lint                        | 均通过                                                                       | `.artifacts/workflow-interruption/root-typecheck.log`、`root-lint.log` |
| CLI typecheck                                        | 27 个任务成功，夹具越界已修复                                                | `cli-typecheck.log`                                                    |
| CLI lint                                             | 14 个任务成功，无错误和警告                                                  | `cli-lint.log`                                                         |
| pnpm verify:pre-push                                 | Lint 与架构检查通过                                                          | `pre-push.log`                                                         |
| architecture:check --changed                         | 违规 0、基线违规 0、新违规 0                                                 | `architecture.log`                                                     |
| 本轮修改文件格式检查                                 | 61 个源码/测试文件通过                                                       | `format-check.log`                                                     |
| 关系图校验                                           | 93 个节点、137 条边；ID、边端点和 rank 有效；本轮 3 节点、6 源码 seed 可解析 | `feature-graph.log`                                                    |
| Bootstrap 全部 src 测试                              | 509 通过，0 失败/跳过                                                        | `bootstrap-tests.log`                                                  |
| SessionStore、trust store、process owner             | 87 通过，含真实多进程共享 SQLite 与旧代写入拦截                              | `storage-tests.log`                                                    |
| Core 子代理、snippet、rewind、runtime close 定向回归 | 56 通过                                                                      | `core-tests.log`                                                       |
| 模型 runner、CLI 生命周期、schema 诊断               | 去重后另计 18 通过；同次运行的 6 个 storage/probe 测试已计入上一组           | `owner-model-schema-cli-tests.log`                                     |
| Browser broker 跨桥装配                              | 1 通过                                                                       | `browser-bridge.log`                                                   |
| Web 真实组件 E2E                                     | 11 通过；含宽屏/手机、中英文、明暗主题                                       | `web-e2e.log`                                                          |
| 隔离 Electron Host                                   | 1 通过；主回合完成仍保活、状态 lane 独立退休、显式关闭归因                   | `electron-host.log`、`electron-host-latest.json`                       |
| Desktop Agent 构建                                   | 通过，约 17 MiB                                                              | `desktop-agent-build.log`                                              |
| 新 bundle 实际 staging                               | 1 通过，校验字节一致及当前 authoring 指引                                    | `bundle-staging.log`                                                   |

去重计数为 670 个后端测试；另外 Browser bridge、bundle staging、Web、Electron 合计 14 个，共 684 个测试通过。重复定向执行没有重复计数。没有以全仓格式检查替代本轮文件检查，也没有把未执行的全平台或原业务测试计为通过。

架构工具将 CLI 与 services 识别为 unmanaged；已生成和读取对应受控上下文，但“检查通过”只代表当前策略覆盖范围内无违规，不代表它已扫描所有 CLI 依赖边。

### 运行验收的证据边界

Electron 测试加载当前 LCodeAgentProcessManager，后端夹具使用真实 Core、工作流引擎、SQLite owner、Protocol server、常驻池及 NDJSON connection。父模型返回固定文本，文件读取由显式 deferred 控制；不访问真实供应商，不执行原业务脚本。

实际验收过程：父回合完成 → 后台 run 等待文件读取且仍 running → 独立 MCP 状态进程因 idle-timeout 退出 → 主 run 继续 → 放行后完成 → 再启动 run → 显式 disposeWorkspace → 后端收到 stdin_eof → journal 收口 stopped/interrupted，service.closing 与入口 closeId 一致。

- 验收夹具 bundle SHA-256：`906701ef43b3faed3b0ec1885c31c995cd4108b10fcc4e5b092dcaba8c151ee0`。
- 实际 Desktop Agent 构建产物 `apps/lcode-cli/packages/cli/dist/lcode.cjs` SHA-256：`ebeda51a56fedaf146c0239b4de6f2620154c3f0df6691c4118e014d4af16144`。

两个 hash 对应不同用途。前者运行了隔离生命周期夹具；后者完成构建和 staging 检验，尚未替换运行中的安装包。

## 验收场景对应

| 方案场景        | 实际证据和层级                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| LI01–LI03、LI05 | Core + workflow lifecycle + pool 装配；将 TTL/水位设为立即触发，两个 run 逐个完成，仍有 run 时无关闭副作用；Electron 验证真实父回合结束           |
| LI04            | lifecycle 测试让 lineage release 首次失败；终态可读、cleanup 保留 pin，重试完成后释放                                                             |
| LI06–LI07       | 构造失败回滚、失败资源句柄、在途构造 drain、新 blocker/App 替换、blocked 不扣容量、同步重入 gate                                                  |
| LI08–LI10       | shutdown-drain、transport-shutdown、runtime-cleanup、CLI lifecycle；新业务拒绝、原 cleanup ACK 接收、IO 原因分类、budget pending 不提前关闭 store |
| LI11            | 原 Browser route/generation 的迟到 ACK、旧 turn 结果、原连接清理及 storage 旧 owner 写入拦截回归                                                  |
| LI12            | Electron 中真实独立状态 Host manager 退出后主 lane 的 run 保持 running                                                                            |
| LI13            | 现有 owner/attachment 路径保留；新增多进程共享 journal 证明第二执行者被拒。没有把此项写成真实两个窗口的全链路验收                                 |
| LI14–LI16       | 独立 Node 进程共享 SQLite：活 owner 拒绝第二方；退休后两方竞争只一方成功；旧写者被 fence；未知、损坏、旧行缺元数据不被标死                        |
| LI17            | 原 stop/Amend 语义与投影回归、四类停止原因真实 UI 组件 E2E；Electron 退出写 interrupted                                                           |
| LI18            | caller abort + HTTP/2 异常只生成 cancelled，无 provider retry；iterator.return 错误只记清理事件                                                   |
| LI19            | Bootstrap 中 continuous/replayable、分片、冷恢复、ACK、CommandInbox FIFO 与重复 admission 回归；没有连接真实手机设备                              |
| LI20            | 同路径异 identity 的 child observation、worktree attachment/reference 与 owner workspace key 拒绝场景；没有跨真实远端 Host 的联机演练             |
| LI21            | Web 11 项浏览器 E2E，1280/390 宽度、中英文、明暗主题，停止原因与 resumable 标记正确                                                               |
| LI22            | 不合法 undefined 保留编译拦截，含行列与字段路径、可选字段提示；合法省略、合法值和 nullable 分开通过                                               |
| LI23            | 既有 import-reuse 测试：冷恢复复用已完成 occurrence，world.run 副作用不重放；同 run 的 lineage lease 不复用旧实例                                 |
| LI24            | 隔离真实 Electron Host 验收通过，版本与夹具 hash 已记录；原安装包和真实模型不在此断言内                                                           |
| LI25            | journal 先终态、本地 settlement 后到的确定性测试，不产生 foreign writer 警告、不提前撤销 live 事实                                                |

## 兼容与剩余边界

数据库没有新增表、列或 migration；新执行元数据使用现有 local_setting。已知旧 owner 退休后，新 owner 通过 CAS 接代；journal 写入在同一事务校验 token 和 parent，迟到旧写者不能覆盖新代。

缺 owner 元数据且存在非终态旧 run、跨主机无法证明退出、元数据损坏/未知版本时，执行认领返回 owner_unknown 并保留历史。当前没有自动绕过该限制的恢复入口；这类旧会话需要另行确认退休证据后处理，不能直接批量改成 interrupted。旧二进制不具备新 fencing，回退须先停止并退休新 owner，不能并行运行新旧 writer。

本机验证为 Windows；没有运行 macOS/Linux 真实进程探测、手机真机、跨 Host 联机、原安装包或真实供应商请求。既有两条 server_error 仍是独立网络问题证据，不因取消回归通过而宣称供应商故障已经消除。

保留了任务开始前的远控重连本地改动和已有 artifacts；提交只包含本轮工作。没有改动依赖锁文件、发布版本、原会话数据或用户业务脚本。

## 复核入口

从仓库根目录使用固定版本运行时执行检查。测试文件清单应以当前 rg --files 结果为准；当前本轮关键新增入口如下：

```text
node --import tsx --test apps/lcode-cli/packages/bootstrap/src/lcode-protocol/workflow-residency.test.ts apps/lcode-cli/packages/bootstrap/src/lcode-protocol/shutdown-drain.test.ts apps/lcode-cli/packages/bootstrap/src/lcode-protocol/runtime-resources-drain.test.ts apps/lcode-cli/packages/bootstrap/src/lcode-protocol/transport-shutdown.test.ts
node --import tsx --test apps/lcode-cli/packages/adapters/src/storage/session-store/workflow-owner.test.ts apps/lcode-cli/packages/adapters/src/storage/workflow-process-owner.test.ts
node --import tsx --test apps/lcode-cli/packages/cli/src/protocol-lifecycle.test.ts apps/lcode-cli/packages/dynamic-workflow/src/schema/diagnostics.test.ts apps/lcode-cli/packages/adapters/src/model/runner-event-order.test.ts
node --test packages/web/test/workflow-stop-reasons.test.mjs
node --test packages/desktop/scripts/workflow-lifetime-electron.test.mjs
node --test scripts/workflow-snippet-bundle.test.mjs
```

完整分组日志位于本机 `.artifacts/workflow-interruption/`，不提交测试数据库、临时 bundle、内部诊断或运行日志。
