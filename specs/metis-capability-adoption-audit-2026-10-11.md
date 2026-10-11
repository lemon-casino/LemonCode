# Metis 方案全面复查与修复记录

- 日期：2026-10-11。
- 状态：**已按用户后续要求恢复验收，追加 attempt/head 修复已通过本轮验证**。随后新增的工作区记忆位置功能按[独立规格](workspace-memory-storage-location.md)实施，其结果单独记录。
- 范围：[Metis 落地方案](metis-capability-adoption-plan.md) 的 D0/D1/D2、B0/B1、L0/L1、V0/V1、H0/H1，以及这些改动经过的现有发送、队列、恢复和远控路径。
- 方法：逐条核对 spec、真实调用方与持久化边界；新增能复现遗漏的失败回归后修复，再运行相关新旧测试。保留上一轮未提交实现及与本次任务无关的文件。
- 工具链：Node 24.21.0、pnpm 10.34.6，与 mise.toml 一致；仅设置验证进程 PATH。首次复查 freshness 通过，相对 origin/main ahead 20 / behind 0；恢复验收时重新检查为 ahead 23 / behind 0，当前 L-GO 无远程跟踪项。

## 1. 方案核对与已确认问题

| 批次          | 复查边界                                               | 本轮修复与补强                                                                                                                                                                                                                            |
| ------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D0/D1         | 真实命令证据、版本新鲜度、严格完成、SQLite 条件更新    | 修复多文件 digest 的二进制拼接歧义；检查工作区根及祖先符号链接；执行结算前后重验 Goal revision；旧失败证据也随内容变化失效；满容量不能继续沿用旧 pass；完成条件由 SQLite UPDATE 自身原子执行。                                            |
| D1 接纳与界面 | 结构化命令、只读会话、持久输入、投影大小               | 新 strict 命令纳入真实 binder 的 durable admission 与只读边界；完整保存 acceptance、选型、mode/plan 与引用；createSession 按 firstInput 计入完整预算。桌面/Web 对本地 CLI 文件语法明确拒绝并保留草稿，避免降级为普通 Goal。               |
| D2            | world.run 与 actor 写入、最终集成证据、原有调度        | 核查执行两端的 actor 状态版本，检查进行期间启动或变更的 actor 即使已结算，也需要重新执行最终检查。非阻断 advice 不修改脚本、模型或调度默认值。                                                                                            |
| B0/B1         | SDK 物理调用边界、预算、取消、报告完整性               | 预留移至最后 gate/取消检查之后，未调用 provider 不计费；seal 后迟到事件不能改报告。预算不足/取消保留完整计划和 missing-arm，未完成返回非零；模型选型比较包含 speed 并规范集合顺序；维护 arm 必须确有 memory 请求。                        |
| L0/L1         | 观测上限、独立反馈与排序资格、scope 与版本             | 大文本命中计数按 schema 上限饱和，避免整轮观察丢失；重验 identity、内容版本、独立审核、显式反馈及默认关闭的有界排序路径。普通任务完成仍不能直接归因于记忆收益。                                                                           |
| V0/V1         | 目标执行环境、采样时间、字幕版本、资源预算与缓存       | 命令贯穿 workingDirectory；使用相对媒体起点的实际时间并显式选择视频流；不返回范围 end 以外的帧；保留请求/实际时间；科学计数 PTS 正确解析；字幕选择变化也令结果 stale；并发同 key 缓存替换按实际占用记账；注入处理器原图在解码前检查预算。 |
| H0/H1         | 原 Composer 草稿、稳定来源、accepted input、事务与恢复 | 修复代码缩进/错误围栏闭合引起的隐式摘要引用；提示和发送共用冻结原文。真实 binder 按 kind 区分 share 与 capsule 并持久化；attach 必须与已接纳引用同序完整匹配。补 SQLite 重开、fork 归属和冷历史回归。                                     |

冻结后的行为契约分别见 [Goal 验收](goal-evidence-verification.md)、[任务评测](agent-task-quality-benchmarks.md)、[记忆观测](workspace-memory-effect-observation.md)、[视频检查](video-inspection.md)、[分支回带](session-branch-handoff.md)。

追加故障注入：[真实 Runtime 与 SQLite 回归](../apps/lcode-cli/packages/bootstrap/src/app/goal-evidence-write-failure.integration.test.ts) 先记录一次 exit 0；下一次同命令真实 exit 1，注入一次可恢复的证据写入错误。初版仍读取旧 pass，并提交 complete。现已在原 SessionStore 增加持久检查开始与最新 head：单事务保存全部匹配验收项后才允许执行；terminal receipt 不可变，不能把旧 attempt 重新设为当前 head。读面只认当前 head 指向的结果，缺结算即 incomplete；最终 SQL 原子核对完整 head、attempt 和 passed receipt，不推进 Goal 业务 stateRevision。

Runtime 与 world.run 已同步执行前的错误传播，初次 Goal 读取失败也不能被观察器吞掉后继续执行。缺少持久化能力、来源不确定、容量不足、stale 或 duplicate admission 均阻断该匹配检查。此修复不重放已发生的外部副作用，不新增 UI/V4 状态所有者。

恢复后的正式验收组为 16 个测试文件、42/42 通过，覆盖真实写失败、[SQLite head 事务](../apps/lcode-cli/packages/adapters/src/storage/session-store/goal-evidence-head.test.ts)、Bash/world.run 开始失败阻断、冷恢复、乱序 terminal、并行验收项及暂停恢复。补充了第二 SQLite 连接在最终 UPDATE 前推进 head 的真实竞态回归；修正旧 CAS 测试遗漏完整 proof 前置及 world 引擎包装错误的断言。生产代码提取 entry 写守卫以满足文件行数限制。

本轮重新执行：contracts/adapters/core fresh build 通过；根 typecheck/lint 通过；CLI typecheck 27/27、lint 14/14；架构 0 violations / baseline 0 / new 0；CLI 定向格式 24 文件通过，标准 `git diff --check` 通过。freshness 相对 origin/main ahead 23 / behind 0，当前分支无远程跟踪项。计数与下表历史组有重叠，不累加。

## 2. 工作区记忆调查与位置选项

用户报告只显示 default 后，已只读核查指定的 profile、项目、安装目录、SQLite 和日志，结论见[调查记录](workspace-memory-investigation-2026-10-11.md)。目标项目根解析正确，但目录和治理账本均为空；日志存在正文为空的截断提取响应。没有发现目标项目的记忆迁入 default 的证据，也未找到可恢复的旧正文。新位置选项不能被描述成恢复了历史记忆。

按用户选择实现 profile / 项目主文件夹两种本机位置，切换时复制 Markdown 并保留原文件，同名冲突保留目标。设置页显示两处来源；新建或重新打开的会话使用新位置，已运行会话保留原位置。多源文件夹项目沿 `primaryFolderPath` 共用一份记忆，附加文件夹不会各自产生副本。远程 workspace 保持现有 profile 语义。

完整规则、状态所有者、事件顺序和失败边界见[位置规格](workspace-memory-storage-location.md)。修复了复制成功但设置提交失败后重试漏文件、context cwd 改变工作区根、冷恢复和证据读取根不一致，以及界面提交后读取晚到等问题。测试使用临时文件和确定性模型 fixture，没有改动用户个人记忆或调用真实模型。

最终复核又复现了旧 Runtime 延迟初始化回退迁移标记的时序缺陷：在新位置删除文件后，新 Runtime 会重新导入被保留的旧源。位置与单调版本现由 SettingService 同次持久化，准备器在原 writer 锁内拒绝旧命令、隔离旧 Runtime，并保留失败重试及较新版本的延迟迁移。通用设置接口也在原设置锁内拒绝缺版本、跳版本及版本回退，避免绕过内部所有者规则。

同时补齐 Main 的记忆位置失效通知：所有存活窗口沿既有 `SettingsChanged` 重新读取设置，提交前读取晚到时必须再读一次，不广播读回结果。Main 不持有记忆位置业务状态。相关失败回归均先红后绿，界面覆盖 1280px / 390px、中英文与 7 个主题。

最终分组结果：共享准备器 16/16，服务/设置/Host/协议 27/27，CLI 记忆与历史 scope 42/42，旧目录读取 1/1，SSR 3/3，真实 Main 通知入口 4/4，浏览器 11/11（10 个子场景及父测试）。最新 CLI 构建后 Goal 组再次 42/42。根及 CLI typecheck/lint 均通过，架构 0 violations / baseline 0 / new 0；具体边界和入口见[位置规格的执行记录](workspace-memory-storage-location.md#执行记录2026-10-11)。

最终定向格式检查：根 44 文件、CLI 45 文件通过；`git diff --check` 通过。验收期间另一路远程连接改动进入共享工作树，本任务未编辑或格式化其文件；定向统计排除该组改动。全仓历史格式失败仍按第 5 节记录，不以定向通过替代。

变更涉及 Shared、Services、Desktop、UI，以及 CLI contracts/adapters/core/bootstrap。位置与版本由原 SettingService 持有，复制复用共享准备器及原 writer 锁，Main 只通知、UI 只读回；净行数统计覆盖本任务未提交的 Goal 追加与记忆功能，排除并发远程连接改动：90 文件（含 27 个新文件），新增 5388 行、删除 655 行，净增 4733 行。

## 3. 追加持久化修复前的验证记录

以下结果在追加 attempt/head 持久化修复前取得，不能作为该最新变更已通过验收的证明。数量按独立执行组记录，部分组包含重叠测试，不相加冒充不重复覆盖数量。

| 检查                                   | 结果                                                                                                                                            |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 根工作区 pnpm typecheck / pnpm lint    | 通过。                                                                                                                                          |
| CLI typecheck / lint                   | 通过；typecheck 27/27 个任务，lint 14/14 个任务。                                                                                               |
| 当时的架构与格式检查                   | architecture 0 violations / baseline 0 / new 0；根 43 个、CLI 195 个改动文件定向格式通过；git diff --check 通过。                               |
| Goal / world / SQLite / 真实 binder    | 13 个测试文件，33/33 通过；新边界先复现失败后修复。含执行中启动/完成 writer 的失效、新 final-check、SQLite 双连接 CAS、严格接纳及首条输入预算。 |
| 记忆观测、排序、物理请求与 CLI         | 12 个测试文件，88/88 通过。                                                                                                                     |
| 评测 harness                           | 14/14 通过。                                                                                                                                    |
| 全套离线评测                           | 24/24 样本，complete=true，stopReason=null；Token unknown，配对效果未验证。产物位于 .tmp/task-quality-review-20261011。                         |
| 视频与 capsule 后端                    | 58/58，0 failed/skipped；包含实际 executor/artifact 恢复、SQLite 重开、fork 归属、原子 attach 和来源版本复核。                                  |
| UI 纯解析及 Goal 证据渲染              | strict slash 1/1；capsule parser 与 GoalEvidenceSummary 4/4。                                                                                   |
| Capsule live/cold 编辑重试             | 8/8；代码示例不重新接纳引用，新增/过期引用拒绝发生在 stop/rewind 前。                                                                           |
| 真实 Composer 引用与 strict 入口浏览器 | 7/7；新旧会话、1280px/390px、拒绝保留草稿。                                                                                                     |
| 既有完整发送浏览器                     | 36/36；新旧会话、多窗口、本地/工作树、回车/按钮、附件及失败恢复。                                                                               |
| 既有完整工作树浏览器                   | 38/38；目录与策略、审核、取消、冲突、分叉及窄屏。                                                                                               |
| 回带菜单浏览器                         | 6/6；scope、自引用、草稿、键盘、中英文与主题。                                                                                                  |
| 协议、接纳 FIFO、队列、冷恢复与选型    | 20/20；不替代后续新增的真实 binder 集成测试。                                                                                                   |
| pnpm test:remote-control               | 76/76；配对、设备隔离、重连、帧路由、撤销与 replayable attachment。                                                                             |

新增关键回归入口：[Goal 证据边界](../apps/lcode-cli/packages/core/src/goal/evidence-boundaries.test.ts)、[SQLite 条件提交](../apps/lcode-cli/packages/adapters/src/storage/session-store/goal-conditional-write.test.ts)、[strict 投影预算](../apps/lcode-cli/packages/bootstrap/src/lcode-protocol-v4/strict-goal-admission.test.ts)、[真实 gateway 与 SQLite 接纳](../apps/lcode-cli/packages/bootstrap/src/lcode-protocol/v4-strict-capsule-admission.test.ts)、[视频边界](../apps/lcode-cli/packages/adapters/src/video/video-regression.test.ts)、[摘要生命周期](../apps/lcode-cli/packages/adapters/src/storage/session-store/context-capsule-lifecycle.test.ts)。

初轮完整工作树浏览器运行期间同时修改 locale，Vite HMR 引发 Provider/重复 portal 错误；冻结 UI 文件后完整重跑 38/38，通过且无页面错误。没有通过放宽断言或延长等待掩盖该失败。

## 4. 恢复与兼容性说明

- 新 strict 命令保留独立身份，旧执行端应明确拒绝；普通 Goal 的 legacy 完成语义保持兼容。
- Goal 文件 digest 升级为 v2；之前已保存的旧 digest 会成为 stale，需要重新执行真实检查。账本达到 512 条时整体保持 incomplete，不沿用可能遗漏后续失败的旧 pass。
- 摘要 ledger 和已接纳引用持久化；context_capsule 模型背景只在引用当轮注入。冷恢复不自动重建之前轮次的临时背景；后续显式读取或重试必须重新核验来源。
- fork 可以保留来源历史引用，但不跨 target 迁移摘要 ledger。子会话不能直接复用父会话专属摘要；可编辑删除引用，或重新 handoff 生成属于自己的摘要。
- Desktop continuous 与 Web remote replayable 仍共享原 Runtime/Host attachment；未引入第二队列、手机 Agent 或新的业务状态 owner。
- 本轮修复没有启用默认关闭的记忆排序，没有把观察结果改成自动有益/有害判断，也没有扩大方案明确排除的自动技能激活、Whisper 下载或跨 identity 导入。

## 5. 验证边界

- 追加 attempt/head 修复已经恢复验收并转绿，结果见上文。未重新运行与追加持久化修复无关的全部历史浏览器组，下表保留其原执行时间边界。
- 未运行真实模型付费对照，离线成功不证明成功率、速度、费用或学习收益；单任务维护对照不能证明后续任务的学习效果。
- 验收只覆盖契约显式声明的 inputPaths/artifactPaths；exit 0 不证明未声明文件正确。Goal 集成测试使用 fake 语义核验器，不能替代真实模型语义效果测试。
- 本机无 FFmpeg/FFprobe，真实解码及跨操作系统行为未验证。新增参数、版本、时间、权限与预算回归使用确定性端口；媒体持久化/冷恢复和 SQLite 用例实际执行对应存储路径。
- 浏览器使用真实共享组件及确定性 Host fixture；远控用例不是手机实机、远程机器和网络断连联调。
- Turbo 提示部分 workspace 未出现在 lockfile 的传递闭包中；本轮全量 typecheck 与 lint 任务成功，该提示仍保留。
- Windows benchmark 异常父进程退出后的完整孤儿回收仍受 Job Object 缺失限制；无法确认清理时报告 harness-error。
- `pnpm fmt:check` 退出 1，报告 2522 个格式问题文件；包含未修改的 `.agents/skills/agent-browser/SKILL.md`、`packages/shared/tsconfig.json` 和 `tsconfig.base.json`。只整理本次改动，不批量改写存量文件；最终定向格式结果单独报告。原始日志保留在 `.tmp/metis-review-format-20261011.log`。

这份记录用于说明本轮确认并修复的缺陷和实际验证范围，不作所有运行环境绝无回归的保证。
