# Metis 方案全面复查与修复记录

- 日期：2026-10-11。
- 状态：**代码修复完成，验收已按用户要求暂停**。追加 attempt/head 修复已落盘并冻结；最新版本未运行测试、构建、类型、Lint、格式或架构检查，不能声称已通过验收。
- 范围：[Metis 落地方案](metis-capability-adoption-plan.md) 的 D0/D1/D2、B0/B1、L0/L1、V0/V1、H0/H1，以及这些改动经过的现有发送、队列、恢复和远控路径。
- 方法：逐条核对 spec、真实调用方与持久化边界；新增能复现遗漏的失败回归后修复，再运行相关新旧测试。保留上一轮未提交实现及与本次任务无关的文件。
- 工具链：Node 24.21.0、pnpm 10.34.6，与 mise.toml 一致；仅设置验证进程 PATH。freshness 检查通过，L-GO 与 origin/L-GO 同步，相对 origin/main ahead 20 / behind 0。

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

最新待验收项包括：上述真实写失败回归、[SQLite head 事务回归](../apps/lcode-cli/packages/adapters/src/storage/session-store/goal-evidence-head.test.ts)、Bash/world.run 开始失败阻断、冷恢复、乱序 terminal、并行验收项及暂停恢复。真实 Runtime 用例与 5 个 SQLite 用例只有修复前的失败记录；修复后的用例未执行。恢复验收后还需重新构建并运行类型、Lint、架构及相关回归检查。

## 2. 追加持久化修复前的验证记录

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

## 3. 恢复与兼容性说明

- 新 strict 命令保留独立身份，旧执行端应明确拒绝；普通 Goal 的 legacy 完成语义保持兼容。
- Goal 文件 digest 升级为 v2；之前已保存的旧 digest 会成为 stale，需要重新执行真实检查。账本达到 512 条时整体保持 incomplete，不沿用可能遗漏后续失败的旧 pass。
- 摘要 ledger 和已接纳引用持久化；context_capsule 模型背景只在引用当轮注入。冷恢复不自动重建之前轮次的临时背景；后续显式读取或重试必须重新核验来源。
- fork 可以保留来源历史引用，但不跨 target 迁移摘要 ledger。子会话不能直接复用父会话专属摘要；可编辑删除引用，或重新 handoff 生成属于自己的摘要。
- Desktop continuous 与 Web remote replayable 仍共享原 Runtime/Host attachment；未引入第二队列、手机 Agent 或新的业务状态 owner。
- 本轮修复没有启用默认关闭的记忆排序，没有把观察结果改成自动有益/有害判断，也没有扩大方案明确排除的自动技能激活、Whisper 下载或跨 identity 导入。

## 4. 验证边界

- 按用户最新要求，追加 attempt/head 修复完成后暂停验收；相应真实故障注入回归已先复现失败，修复后的转绿、类型、Lint、架构与回归验证留待恢复验收。
- 未运行真实模型付费对照，离线成功不证明成功率、速度、费用或学习收益；单任务维护对照不能证明后续任务的学习效果。
- 验收只覆盖契约显式声明的 inputPaths/artifactPaths；exit 0 不证明未声明文件正确。Goal 集成测试使用 fake 语义核验器，不能替代真实模型语义效果测试。
- 本机无 FFmpeg/FFprobe，真实解码及跨操作系统行为未验证。新增参数、版本、时间、权限与预算回归使用确定性端口；媒体持久化/冷恢复和 SQLite 用例实际执行对应存储路径。
- 浏览器使用真实共享组件及确定性 Host fixture；远控用例不是手机实机、远程机器和网络断连联调。
- Turbo 提示部分 workspace 未出现在 lockfile 的传递闭包中；本轮全量 typecheck 与 lint 任务成功，该提示仍保留。
- Windows benchmark 异常父进程退出后的完整孤儿回收仍受 Job Object 缺失限制；无法确认清理时报告 harness-error。
- `pnpm fmt:check` 退出 1，报告 2522 个格式问题文件；包含未修改的 `.agents/skills/agent-browser/SKILL.md`、`packages/shared/tsconfig.json` 和 `tsconfig.base.json`。只整理本次改动，不批量改写存量文件；最终定向格式结果单独报告。原始日志保留在 `.tmp/metis-review-format-20261011.log`。

这份记录用于说明本轮确认并修复的缺陷和实际验证范围，不作所有运行环境绝无回归的保证。
