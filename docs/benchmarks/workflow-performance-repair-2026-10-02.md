# 256 代理性能与失败校验修复（2026-10-02）

## 本轮范围

用户要求处理上一轮 256 actor 性能不足和失败记录。本轮保留 [历史报告](./workflow-efficiency-2026-10-02.md) 及其原始 JSON，新增修复证据，不改写历史失败为成功。**修复已完成：256 actor 在原输入和安全预算下达到 19.989 delta/s/actor，四档运行时压力通过；注册表校验和 debug 测试入口通过。** 浏览器窄屏首次复测出现一次未定因的长帧异常，原样保留，另做诊断复测，不宣称所有长帧均已消除。

负载、普通活动 1Hz 观察、必须即时的状态边界、生产并发/重试/超时、1.5 GiB RSS 与既有墙钟安全预算不变。只使用合成任务，不调用真实模型或用户会话，不安装/发布/重启应用。既有 D2 头像和其他会话的 Git、模型、记忆改动保留。

## 已确认根因

### 运行时生产成本

在当前冻结构建上用真实 `runStress` 做一次有上限的 256 actor 诊断，500ms 预热、2000ms 目标、20 delta/s：10,240 个测量输入实际耗时 2,853.480ms，14.018 delta/s/actor；单核口径 CPU 104.009%，RSS 采样峰值 492.18 MiB。此短测只定位热点，不当作正式容量验收。

同次 CPU profile：

- subscriber buffer 自耗约 802ms（28.46%），含合并/字节计量约 900.5ms（31.95%）。
- shared workflow reducer 自耗约 592ms（21.01%），含子调用约 631.5ms（22.41%）。
- benchmark 的每事件 projection JSON 字节观察自身约 326ms（11.57%），这是测量开销，不能把取消它包装为生产收益。

1,279 次 Publisher ingest 共 2,019.28ms，其中 projection applyEvent 629.18ms、snapshot byte budget 441.30ms。主要生产问题是同一大状态在单调事件等价判断、候选快照预算及各订阅 buffer 中重复序列化。

### UI 派生计算

对当前真实生产函数的精确访问计数确认：256 actor / 256 node 单次 `buildWorkflowTimeline` 的五条主要路径共 262,400 次节点访问，卡片与详情分别计算时至少翻倍：

- 按 site + lane 取状态后逐 actor 过滤：65,536。
- 每 pill 按 site 再 actor 过滤：65,536。
- 活动 selector 对完整 run 再过滤：65,536。
- 最近交付 findIndex 与前缀扫描：32,896 + 32,896。

旧 selector-only 稳态微测中，单次 256 模型批均值中位数为 6.388ms（7 批范围 6.141–6.597ms），其中 256 次 activity 派生约 3.507ms。它不包含 reducer/wire/DOM/paint，不能单独证明帧率。

wire schema 会重建节点引用，所以仅保留上游不可变引用不足以解决 Renderer 重算；需要当前 snapshot 内一次索引而非依赖跨帧引用相等。原浏览器 Profiler 不包括其父组件内的一份模型计算，此边界继续披露，不擅自改变前后测量口径。

## 已落实的修复与回归

### shared reducer

单调且安全整数序号已变化时，旧/新 run 必然不等，直接保留原归约结果而不再序列化整棵 run。无序号旧事件、非标准数值仍走原比较，已存在的旧 sequence、attempt 与终态防护不动。

新增 5 项回归覆盖：不触碰无关节点的序列化、旧 snapshot 不变、未变分支引用保留、未知/非法事件的原 watermark-only 语义、legacy 无序号幂等、非标准序号兼容、陈旧事件提前退出。初版两个性能探针先失败，修后全部通过；shared 工作流合计 22/22 通过。

[归约器同口径微测](./workflow-reducer-performance-repair-2026-10-02.json) 使用与本轮开工 hash 完全一致的旧函数、同一事件与相同输入，五轮交错、每轮 1000 次 activity，最终状态逐轮 deepEqual。旧耗时 192.887–209.527ms，新 1.425–4.405ms；只证明该局部重复工作被消除，不冒充端到端加速。

### 注册表校验与 debug 测试入口

- Bash registry source hash 路径统一 POSIX 分隔符，输入原始字节、NUL 边界、遍历顺序不变。
- 文件比对只规范 CRLF→LF，header/version/hash/正文和其他字节差异仍严格失败；用 latin1 保持无效 UTF-8 字节的区别。
- 单一 generated 文件加 LF 属性，**未重生成或重写现有 707 根条目产物**。修前后原始 SHA-256 均为 `9d258f30f35330c554027ab9bde233732804f1dd1354badc8e54861889ff3496`。
- `pnpm --dir apps/lcode-cli registry:test` 17/17，`registry:check` 退出 0；旧算法先复现 3 个跨平台断言失败。
- debug 增加持久 `test`，显式选本包 `react-jsx` tsconfig；CLI `test:debug` 转发根 workspace 的 debug test，以复用已安装 tsx。9/9 通过，不注入 React、不改生产 import、不依赖 caller cwd。

## 正确性复核与测量边界

shared 快路径经独立审查和 15,303 个内存差分案例验证，新旧结果一致；新增非标准序号回归包含 `-Infinity → Infinity` 在 JSON 中均为 null 的兼容情况，不能简化成不带安全整数约束的大小比较。

正式浏览器采样前出现过启动点击未生效、编辑期间页面复位，以及一个 12 actor 诊断样本没有 RAF 回调的环境现象。这些均未作为 256 actor 前后性能数据或交互成功计入；无帧样本已停止并收尾，后续真实 RAF 探针恢复。正式样本要求 actor/profile、预热、帧观测、source hash 和页面未重载都可确认，不替换浏览器时钟或 requestAnimationFrame。

## Publisher 与 UI 实现

Publisher 仅登记唯一 reducer 来源连续的不可变 workflow 状态，以 WeakSet/WeakMap 保存精确 UTF-8 字节派生值，复用未变 actor/node 分支长度；计量包装仍走原 JSON 语义，未知/外部可变对象回到完整计量。不改 coalesce、buffer 替换、阈值、原子候选或 reservation/flush 节奏。新增 14 项严格预算与恢复回归通过，Bootstrap 对应 13 文件 78 项通过。独立字节审查及额外引用/JSON 语义探针未发现合法 public bridge 路径低估预算；该结论基于既有单 owner 不可变写入契约，不包含调用方直接篡改借出的快照。[局部字节预算对照](./workflow-byte-budget-repair-2026-10-02.json) 的三轮 checksum 完全相同，旧 151.13–159.88ms、新 4.34–6.00ms；不含 reducer 准备，不是容量验收。

UI 按当前不可变 `nodes[]` 一次构建嵌套身份索引和原序成功交付前缀，只缓存窗口内派生数据；display 与 run 终态继续独立计算。新增索引通过 80 项定向 unit/SSR、22 项独立聚焦复核，以及 1,800 次旧/新语义差分；弱引用回收探针确认释放的数组/节点/索引可回收。头像、store、测量 fixture 均未改。

[选择器局部前后对照](./workflow-selector-repair-2026-10-02.json) 中，每次全新 wire-like 节点数组的 256 模型从 8.197ms 降至 0.982ms，包含冷索引构建但不含输入 clone。实际 fixture 身份字段读取从 660,993 降至 3,840。该数字不含 React/DOM/paint。

## 本轮正式复测结果

运行时原预算的四档均已完成并通过：12/64/256 actor 各一分钟，64 actor 五分钟。256 actor 测量 60.033 秒、达到 19.989 delta/s/actor、单核 CPU 38.31%，RSS 采样峰值约 755.27 MiB；64 actor 五分钟完成 384,000 输入，CPU 19.45%。所有档位双 profile 恢复一致、最终 journal/投影结算一致、活动窗口/陈旧事件检查通过，测试创建的 timer/listener/subscriber 归零。源目录指纹前后稳定。以上来自未改动负载与采样脚本，正式 Node 复测期间没有并行重跑完整测试套件。

原始运行时结果：[四档持续复测 JSON](./workflow-stress-runtime-repair-2026-10-02.json)。

256 档历史为 6.556 delta/s/actor、CPU 94.80%、RSS 635.93 MiB，本轮速率约为其 3.05 倍。RSS 没有下降，本次完成了完整 307,200 输入而不是历史预算中止前的 209,664，且保留真实 journal 成本；不能把这两个窗口的内存峰值变化全部归因于缓存。本轮峰值仍低于原 1.5 GiB 安全限额，不宣称无内存成本。

已完成首个 256 actor 桌面浏览器样本，10 秒预热后测量 92.388 秒，472,832 个测量输入，约 20 delta/s/actor；RAF >50ms 比例 1.64%，最近 p95 41.7ms，较历史 74.38% 和 87.6ms 明显改善。恢复/陈旧帧/真实详情操作通过，所有订阅与timer归零，页面 timeOrigin 前后相同。构建仍为 development+Profiler，同机运行离线回归，不是隔离实验室或生产 SLO。

[本轮浏览器原始结果](./workflow-stress-browser-repair-2026-10-02.json) 独立保存，所有正式样本前后页面 timeOrigin 相同，负载/测量 fixture 未改动，原始异常没有被覆盖。

| 浏览器样本                        | 实际测量时长 | delta/s/actor | RAF 最近 p95 | RAF >50ms |
| --------------------------------- | -----------: | ------------: | -----------: | --------: |
| 256 actor / 桌面                  |      92.388s |        19.992 |       41.7ms |     1.64% |
| 12 actor / 桌面                   |      81.224s |        19.994 |       37.5ms |     2.22% |
| 64 actor / 桌面                   |      91.643s |        19.991 |       33.3ms |     0.88% |
| 64 actor / 390px replayable，首次 |     147.213s |        15.658 |       33.3ms |     0.45% |
| 同参数窄屏诊断复测                |    1196.093s |        19.999 |       37.5ms |     0.35% |

首次窄屏样本有 **27,203.9ms 最大 RAF 间隔**和 6,653ms 停止前尾部未观测段，说明单看最近 p95 或长帧数量比例会掩盖严重异常。本样本功能一致性及收尾通过，但不计为稳定性能成功，原因未被原观测确定。

随后同参数只复核一次，增加只读 Long Task / visibility/freeze/resume 观察。因会话暂停后继续，实际测量持续 **1196.093 秒（约 20 分钟）**，不是原拟固定一分钟；累计 1,530,944 个测量输入、19.999 delta/s/actor。没有可见性/freeze/resume事件，记录 167 个长任务、最长 460ms；最大 RAF 间隔 1016.6ms，前次 27 秒异常未复现。该结果不能反推前次异常根因，也不证明未来零长帧。诊断样本的所有实际时长与异常原样保留。

五个浏览器样本均验证恢复、陈旧帧、真实详情入口、256 节点窗口和资源清理；390px 页面宽度与 scrollWidth 一致。所有本测试的 timer/listener/subscription 归零，临时 Vite 端口 5193 已无监听，唯一测试标签页已关闭。

当前完整 Web 首轮有 1 项失败：工作流 next-ask/next-phase/truncated 交互循环等待打开的活动 Popover 超时，61/62 通过；同组 stress-runtime 9/9。原用例同配置单独复跑通过，历史失败保留，不以复跑判定原因已修复。全套按文件/case 去重为 233 文件、1201 个 case，首轮 1200 通过/1 失败，最新结果 1201 通过；其中 CLI 194 文件、996 个 case 全通过，新增的记忆测试属于已有其他会话工作，不冒算为本轮新增功能。

官方浏览器记录进一步确认了测试错误的关闭同步假设：Escape 返回时原 Portal 仍连接且焦点仍在关闭中的内容；约 95ms 后 animationend，约 101ms 后 detach，随后焦点才回原 trigger。原测试立即切换下一场景，没有等待这段真实生命周期。仅修测试的关闭完成条件和场景诊断，不改变生产 Popover，不增加固定延时/超时/重试；当次 timeout 的完整跨阶段因果链仍未被历史日志捕获。修后原 E2E 单次执行通过，58.741 秒内覆盖 8 个视口/语言/主题组合与全部 26 场景；11 个关闭调用点共发生 142 次关闭，每次 open、closed、detached+焦点归还三个阶段均完成，原 180 秒预算不变。

## 最终交付与验证范围

- [验证汇总](./workflow-performance-repair-validation-2026-10-02.json) 保留首次失败、未改代码隔离复跑以及关闭同步修复后的最终验证，233 文件 / 1201 唯一 case 不因重复运行增加。没有跳过或取消用例。
- CLI 强制类型/依赖构建 27/27、强制 Lint 14/14 全通过且无缓存；根 `pnpm typecheck`、`pnpm lint`、架构、差异空白检查通过。Lint 0 errors / 0 warnings，架构 violations/baseline/new 均为 0。最后额外执行包含注册表校验的 `pnpm --dir apps/lcode-cli check` 也通过，该次类型阶段使用已有缓存，不替代先前强制结果。
- 核心生产修复为 10 个文件（shared 1、Publisher 4、UI 派生 5），另有回归、注册表/测试入口与文档变更；不把并行会话的未提交修改算成本轮。没有新的状态所有者、跨包私有导入或规则豁免。
- 原模型五对与旧运行时原始结果 hash 未变，本轮负载与测量 fixture hash 未变；动态头像、药丸和更多列表组件也与本轮开工 hash 一致。正式运行时四档来源目录指纹均稳定，仍保留“未逐字节证明全部传递模块”的原测量限制。
- 使用本机 Node 24.14.1，仓库 pin 为 24.14.0；Turbo 的既有 bin/lockfile 环境提示保留。报告不声称 macOS/Linux、真手机、安装版或发布验收，不以开发构建的一次样本作跨机器 SLO。
- 原始窄屏长帧异常仍未确定根因，诊断复测结果单列；本轮没有再降低负载、延长安全预算或选择性覆盖失败。临时服务和测试标签页均已关闭，未 commit/push/安装/发布。
