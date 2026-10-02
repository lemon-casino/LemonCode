# 高并发工作流性能与失败校验修复

## 请求与范围（2026-10-02）

用户要求修复前次 256 actor 持续负载性能不足及失败记录中的问题。历史结果与失败记录保留，补充本轮前后对照，不能覆盖失败或仅修改通过条件。当前工作区包含其他会话的头像、Git、模型与记忆改动，均不回退。本轮不安装、发布、提交、重启用户应用或调用真实供应商。

## 产品规则

1. 优化生产热点之前先以实际当前源码、CPU/分段耗时和可重复测试区分产品开销与基准开销。基准仍执行真实 driver、engine、journal、projection、publisher、wire 编解码与 shared reducer；浏览器仍渲染真实共享组件，不能换空函数、减少 actor、丢失事件或移除头像/交互来获得更好结果。
2. 256 actor、每 actor 每秒 20 个输入 delta、10 秒预热、至少 60 秒测量以及既有 RSS/墙钟安全预算保持。普通活动 1Hz 合并和请求/工具/生命周期即时边界不变；不改生产并发、模型、重试、超时或输入节流策略。
3. Engine/Scheduler/journal 继续拥有 run/ask/admission 事实；driver 拥有请求/工具观察，ProductProjection 与 shared reducer 只派生投影；Renderer 只派生显示。不得新增已接受队列、活动账本或另一条写入路径。
4. 增量计算必须保持 snapshot 不可变、未变分支的可复用引用、严格的输入校验、源时间、单调 sequence、attempt/owner/lease 隔离、同 actor FIFO 和终态后拒绝旧事件。缓存若有，只能是由不可变输入派生、可回收且有明确失效边界的索引，不能作为事实源。
5. 桌面 continuous 与手机 replayable 使用同一事实、不同投递恢复语义；旧 frame/reservation、重连、同订阅恢复、冷快照、256 节点窗口截断与活动节点保留都必须回归。不能用任意延时替代同步正确性。
6. UI 性能优化保持全部已有状态、文本、统计、最近交付、等待时长、详情入口、键盘/触摸、i18n、主题、390px 与当前 D2 动态头像。避免反复全量遍历和不必要重渲染，但不可隐藏有效内容或新增每 actor timer。

```text
actor runtime 事件 → driver 有界观察 → Engine / journal（唯一事实与顺序）
                                       ↓
                       ProductProjection / shared reducer（不可变派生）
                                       ↓
                Publisher reservation / sequence（既有投递所有者）
                   ├─ desktop-continuous 在线
                   └─ web-remote-replayable 恢复
                                       ↓
                 父 ConversationProjectionStore → 共享 React UI
```

## 已确认热点与实现边界

- shared reducer 在单调序号已改变时仍序列化整个旧/新 run 判断相等；序号不同已足以证明投影不同。仅在序号相同时保留既有 JSON 幂等兼容比较，无序号旧事件、无效/未知事件水位语义、终态与旧 attempt 防护不改变。新增测试用不可变无关分支的序列化探针验证单调事件不再整树遍历，不用墙钟阈值作单测。
- UI 当前 256 actor / 256 node 单次模型至少有 262,400 次重复访问，主要来自 per-pill 全窗口过滤与最近交付前缀扫描。按当前不可变 run 一次建立 site / actor 实例索引、原节点顺序和同 actor 成功交付前缀；同阶段多 site 候选仍按原投影次序选择 FIFO 当前节点，旧阶段不吸收未来交付，截断后不保存窗口外历史。索引只从输入派生并用弱引用或本次计算生命周期回收，不新建事实账本；display syncing/stale 单独参与派生，不被 run 缓存吞掉。
- UI transport/schema 会重建引用，因此不得假定 shared copy-on-write 自动带来跨帧 React memo 命中。本轮优先消除确定的重复扫描；历史 Profiler 不包含其父级模型计算的边界继续披露，不擅改计量边界后宣称同口径提升。
- Publisher 热点是每订阅重复 coalesce/full payload 字节计数与每事件 snapshot 字节预算；优化必须维持严格 UTF-8 字节阈值、相同 delta 合并语义、原子 candidate 接受/拒绝、reservation 的版本隔离及失败不提交。缓存只记录不可变对象或明确版本下的测量值，所有直接 buffer 替换、drain、recovery、rebase、unsubscribe 都必须失效或自然落入新 key。

## 失败记录修复

- Bash 命令注册表的 source hash 使用规范化的 POSIX 相对路径，不受运行平台路径分隔符影响。语义相同的 LF/CRLF checkout 不应误报生成内容陈旧；真实内容、版本或 source hash 差异仍必须失败。修复不能通过重生成 Windows 专属 hash 或忽略正文比较实现，前次生成正文保持。
- debug SSR 回归必须有持久且明确选择本包 `jsx=react-jsx` tsconfig 的测试入口，从任意 caller cwd 执行一致。不以全局 React 注入、测试 skip 或生产额外 import 规避测试启动问题。
- Web 活动弹层场景若等待失败，先记录具体 viewport/locale/theme/scenario 与打开、卸载、焦点事件。场景切换应在真实关闭动画和焦点归还完成后进行；测试不得把 open 属性消失当作资源卸载完成，不增加固定 sleep、重试次数或预算来掩盖时序。若生产交互缺陷被证实，需独立回归再修；单次隔离复跑通过不证明原因已解决。
- 已修的恢复 JSON 键序比较、部分压力结果保留和定时器让出问题继续保留正/负回归。原始失败数据只追加说明和本轮独立结果，不删除或写成成功。

## 实施约束与验收

- 根据定位结果再补本 spec 的具体数据结构与失效约束，先补回归后实现。跨包调用仍走现有公共入口，不扩大公共 API 或新依赖，除非现有边界确实无法表达。
- 固定逻辑回归覆盖：只更新目标节点/actor且旧 snapshot 不变；相同/陈旧事件 no-op；无效输入拒绝；重试/终态/窗口/冷恢复等价；派生缓存在引用变化时失效且不串 run/session；React props/selector 与显示语义一致。
- 执行根 `pnpm typecheck`、`pnpm lint`、架构检查、CLI 强制类型与 Lint、相关完整离线和 Web 交互套件、`registry:check` 与持久 debug 测试入口。新 diagnostics 不以已有问题掩盖；失败保留并继续修复已确认原因。
- 本轮记录当前 source/dist 指纹，正式复测期间冻结；Node 和浏览器分别测量并明确开销边界。256 档按原预算重新运行；12/64 与 64 五分钟长跑验证未退化。报告实际输入速率、CPU/RSS/heap、事件与传输计数、React commit 与 RAF、功能不变量、资源收尾，以及任何仍未达目标的项。开发构建结果不是生产安装包 SLO。
- 浏览器正式样本必须确认实际 actor/profile、预热完成、至少 60 秒测量、React commit 与 RAF 均有真实观测，且期间页面没有重载或热更新。无 RAF、启动未生效、切换丢失或页面复位只是环境/诊断记录，不作为性能成功；不能通过替换 requestAnimationFrame、可见性或假计时绕过。

## 实施与验收结果（2026-10-02）

- shared 单调序号快路径、Publisher 严格 UTF-8 字节派生缓存、UI 当前窗口索引已落地，均有先红后绿回归；不改变生产预算、调度、flush、1Hz观察或唯一事实来源。
- 256 actor ×20 delta/s 原预算测量完成 307,200 输入，实际 19.989 delta/s/actor、CPU 38.31%、RSS峰值755.27MiB；历史为6.556 delta/s/actor及超时。12/64一分钟与64五分钟档位亦完成，所有双profile恢复、窗口、旧事件、结算、资源清理通过。原负载/计量脚本不变，测量source/dist目录指纹稳定。
- 桌面256 actor浏览器样本为19.992 delta/s/actor，RAF >50ms比例1.64%（历史74.38%），恢复/旧帧/详情操作通过。小档位和390px复测已执行；首次窄屏出现27秒RAF异常保留，一次同参数约20分钟诊断复测达到19.999 delta/s/actor、未再现该异常，但最大RAF仍1016.6ms。该异常根因未定，不宣称所有设备或所有长帧已解决。
- registry跨平台hash/换行修复后`registry:check`通过、17项回归通过，生成正文原始hash未变；debug持久`test:debug`入口9项通过。新增Web关闭同步等待精确Portal卸载及原trigger还焦，不添加sleep/retry；单次E2E覆盖8组合26场景、142次完整关闭均通过，历史首轮超时保留。
- CLI强制类型27/27、Lint14/14（均0缓存）、根typecheck/Lint、架构及diff检查通过。整体验收233文件1201唯一case最新均通过，保留首轮1个Web失败及后续两次有区别的attempt；不重复计入去重总数。独立shared差分15,303例、UI等价1,800例及Publisher14项复核无阻断问题。
- 详细数据、测量局限、原始失败与复测链接：`docs/benchmarks/workflow-performance-repair-2026-10-02.md`。测试服务和标签页已关闭，未commit/push/安装/发布/重启用户应用。
