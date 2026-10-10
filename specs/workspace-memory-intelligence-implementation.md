# 工作区记忆、索引与无感复盘：首版实施契约

日期：2026-10-02。状态：**首版已实施，定向回归与类型/Lint/架构检查已完成**。实际模型质量与平均费用尚未实测；验证记录和限制见文末。

2026-10-10 增量：[效果观测与排序实验](workspace-memory-effect-observation.md) 增加默认关闭的无正文观测账本与有界排序开关。观察不新增模型请求；原自动提取/独立核验/CAS、外部编辑器和关闭语义不变。明确反馈的用户应答仅用于反馈本身，不成为逐条记忆审批。

本契约是 `workspace-memory-governance.md`、`workspace-retrospective.md` 的首版实施切片，且优先于其中旧的逐条用户审批设计。按用户最新要求依次完成记忆治理、索引、无感复盘：**继续外部编辑器，不新增应用内正文/来源/类型详情页；AI生成候选、独立AI校验、自动安全应用，不逐条弹窗。** 不实施机器人、Worker、自动创建cron/OffPeak、跨机同步或归档/恢复第二阶段。

## 1. 最小正确实现与所有者

1. Markdown仍是当前事实；`MEMORY.md`仍是原有有界指针。显式注册的Project Memory根由现有resolver产生，不按目录名猜测。
2. 受控写入复用 `FileSystemPort`，Node adapter提供可选 `projectMemory` 能力。runtime初始化/恢复解析根后登记，主代理、普通子代理及workflow子runtime复用同一端口。
3. 根内受控Markdown写入：共享跨进程锁、完整原始字节hash比较、预期不存在语义、严格临时文件替换、日志前像与恢复判断。根外沿用既有文件工具行为。
4. `memory-state` 是根的同级控制目录；不在召回目录中。只持有有界提交/候选记录，不复制一份“当前记忆数据库”。
5. 索引仍为runtime派生BM25；每次有界召回读取候选内容核验新版本，不能仅凭mtime复用。加入扫描/跳过/截断信息和匹配解释。
6. 复盘复用当前轮后extraction scheduler，成功会话轮次后后台执行、单runtime串行、pending合并；不新建Agent/Host/session或定时服务。现有memory/extractionEnabled开关仍是用户总开关。
7. 每轮复盘最多两次无工具辅助请求：生成候选一次，独立上下文审核一次。审核者实际重读同scope来源，不只看生成者结论。模型自身输出approved不等于通过；结构校验、身份、路径、来源版本、CAS是不可绕过的硬边界。
8. 校验失败、冲突、取消、预算不足都保留原文；正常拒绝候选静默跳过，不要求用户处理。异常留脱敏诊断和可查询记录，不用toast/弹窗打断。已有全权限shell/外部编辑器属于非协作边界，不宣称OS沙箱。

```text
现有根解析 → FileSystemPort.projectMemory登记
主Write/Edit → 同一adapter协调 → Markdown事实 + 有界journal/条件撤销
真实用户query → 有界内容核验 → BM25 → 当前turn overlay
成功会话轮结束 → 既有提取scheduler → 冻结同scope证据
 → 无工具AI生成候选 → 独立无工具AI逐项验证
 → 硬规则/来源/hash再次校验 → 统一CAS写入 → 下一轮索引自动更新
```

## 2. 治理能力

- `FileSystemWriteTextRequest.expectedMissing?: boolean` 明确区分新建与未提供前置条件；与expectedRevision互斥。
- `FileSystemPort.projectMemory?` 提供registerRoot、listChanges、previewUndo/undoChange、saveReview/readReview/listReviews/applyReview。可信core传递root，模型不能指定绝对根或存储路径。
- journal/review使用严格schema、版本1、随机ID；读/列举有数量与字节上限。目标限定根内普通Markdown，拒路径逃逸、symlink/junction、控制目录、绝对路径。
- 完整原始字节hash取自完整read；不能对LF正文伪造原始CRLF hash。已有文件缺完整hash拒绝受控覆盖；新建携带expectedMissing。
- 主Write/Edit完整Read之后，即使外部修改保持mtime/size，也必须通过正文一致性校验，不能先重读新hash再用模型未见的新版本覆盖。
- 跨adapter/进程共享已有withFileLock，只回收已退出owner或既有锁协议允许的无owner残留；不靠租约超时强抢活进程。Node无openat/renameat，外部恶意替换可能在系统调用间造成TOCTOU，锁元数据也可能有短窗口；业务提交锁前后复核并fail closed。
- prepared恢复：after hash在目标则补committed；仍为before则not-committed；其余需恢复且不覆盖。原子替换失败不走O_TRUNC退路。
- 首版undo仅replace，且当前after hash必须相同；不自动删除新建条目，不开放archive/restore。所有变更可追溯，任何回滚不猜测用户新内容。
- 最多100条journal、100条review、单记忆/前像256KiB、单record1MiB、前像总20MiB；新增inspectCapacity在首个模型请求前核查可写空间（预留最坏单项前像）、恢复状态和review额度。满额返回具体skippedReason并零模型请求，不持续花token后才失败；提交时重复检查防并发变化。保留既有文件、不自动删历史。这是首版明确容量边界，未提供无限留存或自动清理承诺。

## 3. 索引

- 保持原文件/目录/bytes/top-k预算，不增加向量服务。
- 每次有界读取候选内容；变更重新解析，删除/权限失败移除，旧正文不能永久缓存。
- 有效 `metadata.lcode.validUntil` 到期条目不自动召回；稳定偏好不统一衰减；旧/非法字段兼容。
- 新增只读 `MemorySearch` 返回命中文件、匹配词、分数、完整读取时的原始revision和健康计数。用户继续在外部编辑器看全文。
- `MEMORY.md`每个新turn开始前有界刷新；不在同一模型请求中途改prefix，overlay不进入canonical history或compact摘要。

## 4. 无感自我修正

### 触发与成本

沿用既有成功turn后的提取准入，不为每次工具chunk再触发，不在automation/OffPeak递归启动。每runtime至多一条后台复盘，正在运行时只保留最新pending；既有关闭/取消会真正abort。工具直接成功写入已有记忆时不重复提取，失败Write不能被当成成功。

每轮最多1次生成+1次独立校验。自动增量档仅1个刚完成真实用户轮（最多6000字符）、最多2条相关记忆（合计4000字符）；每请求最多6000估算输入tokens/20000字符，生成与核验输出分别最多1536/768 tokens。空来源零模型请求、空候选不发第二次请求。显式跨会话复盘才使用完整档的8会话、32k输入上限与4096/2048输出上限，不能把完整档每轮自动执行。provider自身重试不等于应用额外复盘循环，估算与provider计数可能不同。费用属于用户当前模型，不称免费闲时额度；关闭已有提取开关后零新后台请求。

### 来源与审核

- 只读当前workspace identity的有界有效分支session snapshots和活动memory。手动跨会话使用既有prefix snapshot；自动增量使用新增 `SessionStorePort.readTranscriptWindow({sessionID,throughMessageID,limits})` 的截至完成锚点的最近窗口：按确定顺序从锚点向前以完整message及其全部parts的联合预算选择最近后缀（最多256条/1024parts/262144字节）、升序返回；更早巨大工具输出只截去prefix，不能先消耗预算让刚完成的小turn失去parts；锚点自身超额才报告窗口内部truncated，核心仍须验证后缀包含完整真实用户轮；`boundaryFound=false`不退回旧prefix，`prefixTruncated`只表示省略更早历史，`truncated`表示窗口内部缺材料。当前snapshot metadata在同savepoint读取，未来消息不进入窗口。核心按有效分支与最后真实用户轮投影，窗口内无真实边界则跳过。旧readTranscriptSnapshot语义不变，无DB migration；缺window能力自动路径跳过，不全量messages兜底。
- 来源ID、scope/version由core建立，模型不能自报hash、路径权限或审核身份。真实用户文字、助手结论、过期事实明确区分；不将助手“测试通过”当工具实证。
- 每候选至少一个实际读取source ID；existing目标必须在冻结材料中完整读取，新目标必须确认不存在。限制10候选/总64k字符，拒MEMORY.md/AGENTS.md/skills/隐藏控制目录等模型目标。
- 第二次AI请求使用新messages，不包含生成者隐藏推理，仅含候选、实际来源材料、目标before和审核规则；必须对每个候选给唯一accept/reject及理由。未知ID、重复/缺失决策、toolCalls、非法JSON整体拒绝。
- 自动接受只限有直接来源支持的持久用户偏好、项目约束、可复用经验，不能存秘密、授权规则、临时任务进度、对人的无依据推断，也不能把失败尝试提炼成成功规律。AI审核不是绝对正确性保证，故仍保留审计/undo与有界作用范围。
- 最终apply前再验证来源和目标hash。记忆来源的原始hash随apply传入，adapter持同一root锁后再次核验引用的全部memory来源，防止排队时来源被另一writer修正却固化旧事实。会话来源在commit前核对scope/有效分支及固定完成边界；SessionStore与文件不是同一事务，不宣称消除跨存储即时竞态，发现后续branch失效应在后续复盘重新评估。冲突逐项跳过，不强行重试覆盖；审核拒绝项不应用。相同冻结正文候选在调用核验前被剔除，不产生重复写记录。
- 自动候选/工具返回不会经原memory loop再次固化。涉及显式review create/read/list的对话轮从后台证据中隔离，冷恢复也从持久ToolPart重算；当前正在生成的精确callID仅在当前调用取证时豁免，旧结果一律隔离。生成者summary没有经过逐项核验，持久摘要改用可信数量统计，list不传播原始未审摘要。

### 可选对话诊断入口

用户不必调用工具完成自动维护。保留 `MemoryReview` 用于显式立即复盘、列举/读取记录；它也走同一独立AI校验与自动应用路径，不弹逐条确认。`MemoryHistory`只用于按需查看记录；手动条件撤销按既有受控入口，不建立内置正文页。

原计划的 `MemoryReviewApply` 用户审批工具不作为首版注册入口，不能暴露一个仅凭模型approved字段就写入的旁路。复盘工具可执行hooks跳过，辅助模型请求不触发SessionStart/Stop或工具hook；原用户主会话的生命周期规则不变。

## 5. 分阶段测试与边界

1. 受控磁盘：同mtime内容变化、两个adapter/进程竞争、新建竞争、路径逃逸、rename失败无truncate、journal崩溃恢复、条件undo、容量满额不删。
2. 索引：同mtime外部编辑、删除/不可读、目录预算/unknown、到期vs稳定偏好、匹配解释、字节/并发上限、root隔离、overlay历史隔离。
3. 自动复盘：一次生成+一次独立核实，tools=[]，未知来源/非法JSON/toolCalls拒绝，校验reject不写，接受仅通过CAS，取消/错误/冲突保留原文，已有开关关闭不运行，提案不回流，重启不重复应用。
4. 真实模型与用户记忆不用于测试；用fake ports/models和临时目录。必须运行根typecheck/lint/architecture、CLI typecheck/lint、相关node:test并报告真实失败。
5. 不新增UI交互，因此删除本轮尚未交付的逐条审批页面接线/fixture，只保留原有外部编辑器。GUI真机不冒充已验证。

cron/OffPeak平台级定期策略、跨Host编辑、归档恢复、知识图谱仍为后续功能，不能因为本轮自动复盘完成而标记已交付。

## 6. 完成记录与真实验证

本轮完成：显式根登记与跨runtime端口复用；原始hash/expectedMissing写入；同mtime编辑防覆盖；有界journal与条件撤销；锁内memory来源校验；容量前置；BM25失效/健康/解释/到期；下一turn索引页刷新；有界完成轮SQLite窗口；生成与独立AI核验后的无感自动应用；可选MemorySearch/MemoryReview/MemoryHistory诊断工具。逐条人工审批工具与新增UI测试夹具已移除，原外部编辑器入口未修改。

验证使用Windows、Node 24.14.1（仓库指定24.14.0）、临时磁盘/SQLite和fake model，不接真实provider、不读取真实用户memory。结果：

- 根 `pnpm typecheck`、`pnpm lint`：通过，Lint零警告/错误。
- CLI `pnpm --dir apps/lcode-cli typecheck`、`pnpm --dir apps/lcode-cli lint`：通过。因CLI目录缺局部Turbo可执行入口，运行时仅为该子进程PATH加入已有根 `node_modules/.bin`，未安装依赖或改系统配置；Turbo提示局部安装/lockfile工作区信息不完整。
- 另外直接执行 `pnpm --dir apps/lcode-cli -r --if-present typecheck` 与 `lint`：所有定义脚本的包通过，不依赖Turbo缓存。
- `@lcode/contracts`、`@lcode/adapters`、`@lcode/core`、`@lcode/bootstrap` 构建：通过。
- 核心记忆/召回/复盘/runtime/权限回归：188/188通过。
- 真实FS、跨Node进程锁、SQLite snapshot/window、Write/Edit/context/workflow端口接线回归：92/92通过；两组共280个独立测试。测试夹具拆分后追加复测25项通过，属于重跑而非额外计数。
- `pnpm architecture:check --changed`：0 violations / 0 baseline / 0 new。
- 只对本轮文件运行oxfmt；未运行全仓格式自动修复。
- `pnpm --dir apps/lcode-cli check`：**仍失败**，已有 `Generated Bash command registry is stale` 阻止脚本后半段。本轮未重生成无关registry；不能把上面的单独类型检查通过写成该聚合命令通过。

核心回归可从仓库根重跑：

```bash
pnpm exec node --import tsx --test apps/lcode-cli/packages/core/src/memory/*.test.ts apps/lcode-cli/packages/core/src/memory/recall/*.test.ts apps/lcode-cli/packages/core/src/runtime/helpers/project-memory-extraction.test.ts apps/lcode-cli/packages/core/src/runtime/helpers/project-memory-index-refresh.test.ts apps/lcode-cli/packages/core/src/runtime/methods/turn-complete-memory.test.ts apps/lcode-cli/packages/core/src/runtime/methods/turn-memory-recall.test.ts apps/lcode-cli/packages/core/src/tool/executor/memory-maintenance.test.ts
pnpm exec node --import tsx --test apps/lcode-cli/packages/adapters/src/fs/*.test.ts apps/lcode-cli/packages/adapters/src/storage/session-store/transcript-snapshot.test.ts apps/lcode-cli/packages/adapters/src/storage/session-store/transcript-window.test.ts apps/lcode-cli/packages/adapters/src/storage/session-store/transcript-window-budget.test.ts apps/lcode-cli/packages/core/src/tool/handlers/write-project-memory.test.ts apps/lcode-cli/packages/core/src/tool/handlers/edit-project-memory.test.ts apps/lcode-cli/packages/core/src/runtime/methods/context-project-memory.test.ts apps/lcode-cli/packages/bootstrap/src/app/workflow-project-memory-wiring.test.ts
```

## 7. 使用与限制

- 已开启工作区记忆且允许自动提取的本地会话，成功完成符合条件的真实用户轮后后台维护；沿用会话配置物化语义，不承诺设置变化立刻热更新所有现存runtime。
- 日常无需手动调用工具。需要排查时可请求“搜索工作区记忆”“立即复盘工作区记忆”“查看最近记忆变更”，模型通过上述工具执行；不是新增slash命令。
- 内容仍在原Markdown目录，用户可继续用外部编辑器更改，下一轮检索核验实际内容。外部变更不能由journal保证可撤销。
- 第一版保留100条journal/100条review/20MiB前像的硬上限，满额暂停自动写且不调用AI；没有自动清理/迁移UI。外部编辑仍可使用，不建议直接删除未决恢复记录。
- AI核验可能误判，同模型新上下文不是不同模型仲裁；真实长期质量、平均token和费用尚未实测。自动请求预算是上限不是平均值，provider内部重试与实际计费可能有差别。
- 跨session数据库与文件存储没有分布式原子事务；程序在提交前重验来源、root锁内核验memory来源，不能宣称杜绝所有非合作进程或跨存储竞态。
- 未执行真实provider端到端、macOS/Linux、真实手机GUI或量产性能bench；本轮没有UI新行为，也未打包新安装程序、提交或推送Git。

Claude Code/Codex官方依据与本轮取舍见 [记忆设计参考](./memory-design-references.md)。
