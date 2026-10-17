# 侧边栏编辑与项目协作验收场景

对应方案：[侧边栏编辑与多目录项目协作增强方案](sidebar-project-collaboration-enhancement.md)。日期：2026-10-16。

本清单保留 98 项产品验收规则。分区／项目编辑、输入范围和同 Host 多仓库工作集已实现，并完成下述代表性自动化验证。accepted 表示规则已被方案采用；各节的 planned 表示该整组产品验收尚未逐项签收，不表示所有实现都未开始，也不表示已跑的测试失败。实际命令、查漏修复和环境限制见[实施验证记录](sidebar-project-collaboration-verification.md)。

## 1 证据与环境

| 证据层   | 必须证明的内容                                         | 测试材料                                           |
| -------- | ------------------------------------------------------ | -------------------------------------------------- |
| UI       | 入口、可访问名称、草稿、确认、行内错误、专注、右键目标 | 生产组件浏览器 fixture、桌面及触屏事件             |
| Owner    | revision、幂等、原子提交、事件顺序和输入 admission     | 服务测试、协议记录、持久操作收据                   |
| FS / Git | 真实目录、canonical root、分支、index、脏文件和恢复    | 独立临时目录与真实 Git 仓库                        |
| Remote   | identity、remoteSessionId、generation、重连和多端序列  | 同路径隔离 fixture、真实 SSH／WSL／Docker 能力验收 |
| Runtime  | AI 实际获得目录关系、文件／命令／MCP 目标一致          | 可观测测试模型与实际工具调用轨迹                   |

至少准备：同仓库 frontend/contracts；独立 backend 仓库；同路径不同远端 identity；一个非 Git 目录；缺失目录；包含未提交、ignored 和新文件的工作树；两个窗口；390px 触屏；七套主题；中英文；较大字号；无 filesystem MCP 与已配置 MCP 两种运行环境。

所有注入错误与目录均为测试数据。不得对用户真实配置、真实仓库和已连接生产服务进行破坏性验收。

## 2 分区编辑场景

状态：accepted / planned。阶段：S1。

| ID  | Setup                      | Action                         | Assertions                                               | 证据        |
| --- | -------------------------- | ------------------------------ | -------------------------------------------------------- | ----------- |
| G01 | 混合分区包含项目、树和会话 | 右键选择编辑分区               | 完整成员与名称正确；不切聊天、不创建草稿                 | UI + Owner  |
| G02 | 同一分区有修改草稿         | 修改名称和顺序后取消           | 无 apply 命令、持久快照和位置均不变                      | UI + Owner  |
| G03 | 分区名和成员均有变化       | 保存一次                       | 一个 operationId、一个原子批次，全部变化共同生效         | Owner + FS  |
| G04 | 项目在另一分区             | 编辑时添加该项目               | 预览原位置；保存后仅一个显式位置，不复制实体             | UI + Owner  |
| G05 | 分区有自然子会话及独立会话 | 打开成员编辑                   | 不把自然子会话再列为直接成员；独立会话保留               | UI          |
| G06 | 分区名称超限或为空         | 输入并尝试保存                 | 字段就地提示，80 字规则与 shared 一致，草稿不丢失        | UI + Owner  |
| G07 | 分区有默认目标             | 同批移出或跨区移动该目标       | 目标引用与成员变化同次提交；无悬空默认目标               | Owner       |
| G08 | 默认目标为离线远程项目     | 点击分区新建会话               | 具体目标不可用；无 connect、无回退当前项目、无草稿       | UI + Remote |
| G09 | 两窗口打开同一分区         | A 保存，B 再保存               | B 保留草稿并展示冲突；不覆盖 A 的内容                    | UI + Owner  |
| G10 | 服务已提交但回复丢失       | 原 key 重试；另以同 key 改内容 | 原请求幂等，改内容拒绝，不多建分区                       | Owner + FS  |
| G11 | 用户清空分区所有成员       | 保存后再撤销                   | 保留空分区；撤销只恢复组织，不删除业务对象               | UI + Owner  |
| G12 | 弹层打开期间分区被解散     | 本窗口尝试保存                 | 显示对象已移除，保留可读草稿，不复活原 sectionId         | UI + Owner  |
| G13 | 分区保存已发送但结果未返回 | 关闭视图并重开                 | 页面继续追踪原 key；不以关闭视图取消已发命令，不重复分区 | UI + Owner  |

## 3 项目编辑场景

状态：accepted / planned。阶段：S1，远程部分延伸到 S4。

| ID  | Setup                                      | Action                         | Assertions                                                                              | 证据          |
| --- | ------------------------------------------ | ------------------------------ | --------------------------------------------------------------------------------------- | ------------- |
| P01 | 已保存但未打开的多目录项目                 | 从项目三个点编辑               | 可读取完整定义，入口不依赖打开 tab                                                      | UI + Owner    |
| P02 | 本地前端项目                               | 添加后端，设置用途，保存并重启 | id 和主目录不变；成员与说明恢复；不自动开聊天                                           | UI + FS       |
| P03 | 编辑中存在未保存新增目录                   | 取消或确认放弃修改             | 不写设置，不改搜索和会话范围                                                            | UI + Owner    |
| P04 | 主目录位于首个源目录                       | 拖动显示顺序及尝试移除主目录   | 兼容数组的主目录规则保持；普通编辑不能改变身份锚点                                      | UI + Owner    |
| P05 | 主目录已有显式项目                         | 尝试用同主目录另建             | 显示冲突项目并提供编辑入口，不覆盖旧 id                                                 | UI + Owner    |
| P06 | 路径存在大小写、分隔符及尾斜杠变体         | 重复添加                       | 遵循平台规范化；不重复成员，不错误折叠 Linux 大小写路径                                 | Owner + FS    |
| P07 | 相同真实目录有 symlink/junction 别名       | 添加并保存                     | 真实路径校验，避免重复执行或越界；不按显示名判断                                        | Owner + FS    |
| P08 | 两个同名目录且路径不同                     | 添加为不同成员                 | 可区分来源，稳定 memberId 不依赖名称                                                    | UI + Owner    |
| P09 | 两个 project 共享同一 backend 目录         | 并行执行与 Git 管理            | 按实际 checkout 协调：普通会话共享文件并行，合并和生命周期操作独占，不按 projectId 绕过 | Runtime + Git |
| P10 | 一个 member 被已有工作集使用               | 从项目移除并保存               | 无文件删除、无 binding 删除；工作集保留冻结映射并显示依赖                               | UI + Owner    |
| P11 | 新增目录缺失或不可读                       | 保存                           | 错误对应新增行；取消该行后可保存其它合法变化                                            | UI + FS       |
| P12 | 旧成员暂时缺失                             | 编辑名称并保存                 | 可保留缺失成员，逐项标注；不自动删旧目录                                                | UI + Owner    |
| P13 | 两窗口编辑同一项目                         | A 更新成员，B 改名保存         | 冲突有原值、最新值和草稿，不全数组覆盖                                                  | Owner + FS    |
| P14 | 两窗口编辑不同项目及其它设置               | 交错保存                       | 各自变更均保留，未涉及字段不丢失                                                        | Owner + FS    |
| P15 | settings 写入失败或 ACK 丢失               | 保存、对账、原 key 重试        | 不伪成功、不清空草稿、不重复创建                                                        | UI + Owner    |
| P16 | 项目设置存在显式模型覆盖                   | 编辑成员和名称                 | 模型、审批、已有会话和手动草稿不被重置                                                  | UI + Owner    |
| P17 | 项目有 active binding 或独立会话依赖       | 点击移除本地项目               | 显示具体依赖并沿现有门禁；不释放仍被引用的 Host                                         | UI + Owner    |
| P18 | 选择更换主目录                             | 走独立新项目流程               | 明示历史留在原 scope；不把旧聊天、worktree 或 identity 改到新路径                       | UI + Owner    |
| P19 | 项目保存中关闭面板后应用重启               | 重新查看项目状态               | 读取 owner 事实，不以新 key 自动重发不明创建；草稿能力边界明确                          | UI + Owner    |
| P20 | recentProjects 隐式项目，无 localProjectId | 两窗口首次编辑保存             | 原子升级为一个稳定项目；主目录和历史 scope 不变，取消不升级，另一窗口不覆盖             | UI + Owner    |

## 4 会话范围与持续上下文场景

状态：accepted / planned。阶段：S2。

| ID  | Setup                                 | Action                       | Assertions                                                    | 证据             |
| --- | ------------------------------------- | ---------------------------- | ------------------------------------------------------------- | ---------------- |
| C01 | 项目包含前端与后端，无 filesystem MCP | 新建会话，询问项目结构       | 模型可见程序提供的成员和用途，原生工具可用正确范围            | Runtime          |
| C02 | 同项目配置 filesystem MCP             | 建立和恢复会话               | 与原生工具使用同一快照；不持久污染用户 MCP 配置               | Runtime + Owner  |
| C03 | 用户换一个全新会话                    | 不重复说明目录，发起跨端任务 | 新会话获得同一项目关系；不靠复制旧聊天正文                    | Runtime          |
| C04 | 普通会话空闲，项目增加成员            | 发起下一轮                   | 在 CLI 接受输入的确定点解析新版本并持久记录                   | Runtime + Owner  |
| C05 | 一轮已被接受或正在运行                | 项目移除成员或改用途         | 本轮映射不漂移；后续轮次按生效规则更新，UI 明示边界           | Runtime + Owner  |
| C06 | busy 会话已有接受输入                 | 修改项目后让队列继续         | 原输入的已冻结范围不改写，不新增 Host/Renderer accepted queue | Runtime + Owner  |
| C07 | 冷恢复工作树／工作集会话              | 原目录存在但 checkout 缺失   | 明确阻止续写，不回退原目录                                    | Runtime + Git    |
| C08 | 成员说明含指令样式文本                | 保存并建立会话               | 说明保持数据来源标签，不伪装成高优先级系统指令                | Runtime          |
| C09 | 项目成员中有不同目录指令              | 访问各目录                   | 指令按原作用域解析，不把一个仓库规则全局覆盖另一个            | Runtime          |
| C10 | 编辑名称期间异步目录探测返回          | 持续输入中文项目名           | 不抢焦点、不重置草稿、迟到结果不覆盖新候选                    | UI + Owner       |
| C11 | 项目被移除后仍有历史会话              | 打开历史并尝试继续           | 来源摘要保留；不借同名项目、同路径远端或裸 taskId 重新绑定    | Runtime + Remote |
| C12 | 不同工作树拥有独立记忆                | 新建同项目会话或工作集会话   | 目录关系可复用；记忆根和私密聊天不自动跨 scope 合并           | Runtime + FS     |
| C13 | 工作集准备失败且输入正文已填写        | 重试准备直到 ready           | 正文留在未提交草稿；资源重试不触发重复模型调用或重复正文提交  | UI + Runtime     |

## 5 多仓库协作工作集场景

状态：accepted / planned。阶段：S3。

| ID  | Setup                                     | Action                     | Assertions                                                           | 证据            |
| --- | ----------------------------------------- | -------------------------- | -------------------------------------------------------------------- | --------------- |
| W01 | frontend/contracts 同仓库，backend 独立库 | 预检并准备                 | 两个 Git 计划及两个 binding，三个目录映射正确                        | Owner + Git     |
| W02 | 两个独立 Git 仓库                         | 同需求修改文件和 index     | 两库各在自身 checkout；原目录内容及 index 不变                       | Runtime + Git   |
| W03 | 各仓库基线不同                            | 选择基线创建               | 固定各自 commit，不切原仓库分支，不用另一库 HEAD                     | Owner + Git     |
| W04 | 准备两库时后端失败                        | 查看并发送第一条输入       | 显示 1/2 及具体原因；第一条输入不运行，不仅执行前端                  | UI + Runtime    |
| W05 | 前端已成功、后端失败                      | 对原计划重试               | 复用前端 binding，只对账未完成项，不重复分支                         | Owner + Git     |
| W06 | 工作集提交成功但 ACK 丢失                 | 重发原操作                 | 返回原 executionSetId、binding 和状态；不同计划同 key 拒绝           | Owner + FS      |
| W07 | 进程在逐库准备任一边界崩溃                | 重启读取并重试             | 按 journal 和实际 Git 登记恢复，不凭 UI loading 猜测完成             | Owner + Git     |
| W08 | 某已准备 checkout 有用户修改              | 取消或清理失败计划         | 保留改动与快照失败说明，不自动删除该树                               | Owner + Git     |
| W09 | 两操作以相反成员顺序请求多库写许可        | 并行执行                   | 规范排序获取，无死锁，不持半组锁反复争用                             | Owner + Runtime |
| W10 | 同工作集两个会话                          | 同时操作同一 member        | 用户确认保留并行；共享文件提示明确；普通执行共享许可，Git 管理仍独占 | Runtime + Git   |
| W11 | 用户选择独立工作集分叉                    | 创建并修改相同文件         | 新绑定组完整，和原工作集文件及 index 隔离                            | Runtime + Git   |
| W12 | 原项目保存新 member                       | 继续旧工作集会话           | 旧集合不被热改；显式新建工作集才采用新范围                           | Runtime + Owner |
| W13 | 第一个库发布成功、第二个失败              | 查看整体进度和恢复         | 展示部分成功；不重发已成功库，不改写已发布历史                       | Owner + Git     |
| W14 | 工作集仍有会话、进程或 consumer           | 单独删除其中一个 binding   | 原 owner 明确拒绝，列出占用；无悬空工作集                            | Owner + Runtime |
| W15 | 需求中包含非 Git、submodule 或不支持根    | 预检准备                   | 具体行标出原因；无偷偷使用原目录的成员                               | UI + Git        |
| W16 | 归档后恢复一组工作树                      | 恢复、重建环境、打开聊天   | 每库完成对账与新鲜环境引用，全部必要成员 ready 才续写                | Owner + Runtime |
| W17 | 旧 task owner 与新工作集 owner 并存       | 创建和查询多库绑定         | 使用区分 owner 的新合同，无伪 task、隐藏 Agent 或旧 taskId 猜测      | Owner + Runtime |
| W18 | consumer 已登记、工作集收据未落盘时崩溃   | 重启并对账                 | 原消费者幂等保留，不能误删绑定；释放须有终止和停止证据               | Owner + FS      |
| W19 | 一条会话有两个仓库 binding                | 列表、搜索、恢复和事件回放 | 只出现一条原项目聊天；每成员执行位置完整，第二库不丢失               | Runtime + Owner |
| W20 | 新 set owner 请求到达旧 Host              | 能力协商和尝试操作         | 明确拒绝，不适配成单树，不填默认字段伪成功                           | Owner + Remote  |

## 6 远程与两种交付语义场景

状态：accepted / planned。阶段：S4；身份不串用作为 S1 起的不变量。

| ID  | Setup                                    | Action                     | Assertions                                              | 证据             |
| --- | ---------------------------------------- | -------------------------- | ------------------------------------------------------- | ---------------- |
| R01 | 本地与 SSH 都有 /data                    | 编辑及右键各自对象         | 请求携带正确 identity，远程不调用本地文件服务           | UI + Remote      |
| R02 | 历史远程项目未连接                       | 展开分区、编辑已保存名称   | 正常未连接状态，无全局读取告警、无自动连接              | UI + Remote      |
| R03 | 远端新增目录读取失败                     | 查看感叹号并重读           | 显示该目录及原因；只重读该来源，不调用 reconnect        | UI + Remote      |
| R04 | 同 SSH 目标两个目录                      | 建立普通会话和工作集       | 同环境原 owner 路由、两个路径完整传递                   | Runtime + Remote |
| R05 | 本地与远程或两个远程目标                 | 组合为执行范围             | 预检明确拒绝首版组合，无自动复制或静默剔除              | UI + Remote      |
| R06 | WSL 和 Docker 中存在同名目录             | 编辑和创建各自工作集       | 不串目标，不当作宿主机路径                              | Runtime + Remote |
| R07 | 原远程目录探测未返回                     | 断开并以新 generation 重连 | 旧成功和旧错误均不覆盖新来源状态                        | Owner + Remote   |
| R08 | 远端 prepare 后回复断开                  | 重连读取工作集并对账       | 原 key、原计划、原绑定，不按新 sessionId 重建工作集     | Owner + Remote   |
| R09 | Desktop continuous 活跃会话              | 项目改名和范围版本事件     | 单调事件，同步正确，不创建第二份 accepted input         | Runtime + Remote |
| R10 | 手机 replayable 断网丢事件               | 恢复 snapshot/cursor/gap   | 恢复同一工作集和版本，无重复准备或执行                  | Runtime + Remote |
| R11 | 手机请求目录选择或原生动作               | 查看项目菜单               | 不支持能力隐藏；支持远端浏览沿桌面 attachment           | UI + Remote      |
| R12 | 旧 Host 缺少范围／工作集方法             | 点击相关入口               | 正确能力禁用与升级说明，无本地降级和 fake ready         | UI + Remote      |
| R13 | hostname 相同但 authority 不明的两个连接 | 组合成员和访问项目注册表   | 不猜测同执行环境；profile 注册表不随远程 workspace 切换 | Owner + Remote   |

## 7 UI 与菜单场景

状态：accepted / planned。阶段：对应能力各阶段均需执行。

| ID  | Setup                                        | Action                       | Assertions                                           | 证据       |
| --- | -------------------------------------------- | ---------------------------- | ---------------------------------------------------- | ---------- |
| U01 | 七套主题、中英文、较大字号及短窗口           | 打开编辑面板和子菜单         | 语义颜色、字号、滚动和边界可读；主菜单不被子菜单推动 | UI         |
| U02 | 390px、软键盘、触屏                          | 添加目录、编辑用途并保存     | 按钮可达、滚动不穿透、三个点可操作，非只能右键       | UI         |
| U03 | 鼠标悬停后改用键盘                           | 上下键、Home/End、Escape     | 跳过隐藏按钮，子层返回原入口，再关闭回触发器         | UI         |
| U04 | 多选集合含项目及自然子会话                   | 在集合内外对象右键           | 集合内保留；集合外目标明确；不重复组织父子对象       | UI + Owner |
| U05 | 项目／工作树／会话专注                       | 编辑混合分区后保存           | 保存完整对象；专注未改变；不匹配内容有显示全部入口   | UI + Owner |
| U06 | 弹层有草稿且对象外部被重命名                 | 更新事件到达                 | 不覆盖本地输入，保留冲突说明，不抢焦点               | UI         |
| U07 | 筛选成员后移除可见一行                       | 清除搜索并保存               | 隐藏成员保留；不把搜索结果当作整体定义               | UI + Owner |
| U08 | 归档中操作后返回活动列表                     | 查看专注和展开               | 归档独立；原专注、位置和展开保留                     | UI         |
| U09 | 本地项目、远程项目、工作树、工作集、各类会话 | 右键与三个点逐一执行代表动作 | 动作目标及可用性一致；不以当前聊天代替菜单对象       | UI + Owner |
| U10 | 当前面板目标保存后被移出或删除               | 关闭弹层                     | 焦点回原入口或侧栏工具栏，无不可见焦点和键盘陷阱     | UI         |
| U11 | 只交付 S1 编辑能力                           | 查看项目和工作集入口         | 不宣称已解决 AI 范围；未通过门槛能力不显示可执行入口 | UI         |

## 8 迁移与跨 owner 场景

状态：accepted / planned。阶段：随数据版本升级放行。

| ID  | Setup                                  | Action               | Assertions                                     | 证据           |
| --- | -------------------------------------- | -------------------- | ---------------------------------------------- | -------------- |
| M01 | 旧 localProjects 与旧分区              | 首次升级后再次启动   | 稳定 id、主目录与位置保留，迁移幂等            | Owner + FS     |
| M02 | 迁移写入前后各注入崩溃                 | 冷启动               | 只出现完整旧版或完整新版；无空项目覆盖         | Owner + FS     |
| M03 | 启用 projectDefinitions 后旧客户端连接 | 读取和尝试旧字段写入 | 兼容读投影可用；不支持写入明确拒绝，无双 owner | Owner + Remote |
| M04 | 项目创建成功，分区放置冲突             | 点击重试             | 只重试位置命令，不重复创建项目、不回滚项目事实 | UI + Owner     |
| M05 | 旧单工作树、同树会话与工作树记忆       | 升级并恢复           | 不自动包装或收编，不变更绑定、环境和记忆根     | Runtime + FS   |
| M06 | 相同 taskId 存在于不同 identity        | 迁移及打开会话       | 不按裸 taskId 合并，全部关联保留正确 scope     | Owner + Remote |
| M07 | 新引用种类遇到旧 schema                | 读写组织服务         | 明确协议不支持；不丢弃未知引用后保存空快照     | Owner + Remote |
| M08 | 项目默认配置、provider 配置也并发修改  | 更新项目成员         | 只变目标项目；不误用账号 CAS 或回退其它设置    | Owner + FS     |

## 9 高风险组合与裁剪

| 组合                                    | 处理                   | 不变量与代表场景                                                  |
| --------------------------------------- | ---------------------- | ----------------------------------------------------------------- |
| 专注 × 编辑 × 搜索 × 混合分区           | accepted，重点覆盖     | 完整对象独立于显示投影：G01、U05、U07                             |
| 多目录 × 多仓库 × 准备半失败 × 重试     | accepted，真 Git       | 全部必要成员 ready 才执行：W01、W04、W05、W06                     |
| 项目更新 × busy 输入 × 冷恢复           | accepted，记录版本     | CLI 唯一接受事实：C04、C05、C06、C07                              |
| 远端同路径 × 重连代际 × 手机恢复        | accepted，协议与远端   | identity、代际和序列均隔离：R01、R07、R08、R10                    |
| 多 Host 同时写入、跨本地／远程执行      | pruned，首版明确拒绝   | 无跨 Host 执行合同，不伪装为支持：R05                             |
| 主目录身份原地迁移                      | pruned，独立新项目流程 | 不改变历史 scope：P04、P18                                        |
| submodule 或非 Git 混合作为已隔离工作集 | pruned，能力拒绝       | 不留原路径写入：W15                                               |
| 以复制旧聊天、共享所有记忆代替目录配置  | pruned                 | 配置事实与聊天证据分离：C03、C12                                  |
| 所有主题 × 所有 Git 故障的全笛卡尔积    | pruned                 | UI token 全主题验证；Git 故障在代表 UI 与服务层覆盖：U01、W04—W16 |

## 10 实际验证入口

以下既有文件继续提供回归入口；新增实现的证据独立记录，不能用旧测试替代新行为断言。

- [localProjects.test.ts](../packages/shared/src/localProjects.test.ts)：项目校验、规范化和查找。
- [mcpWorkspaceScope.test.ts](../packages/services/src/session/mcpWorkspaceScope.test.ts)：已存在源目录的临时 MCP 注入。
- [worktreeSafety.integration.test.ts](../packages/services/src/worktree/worktreeSafety.integration.test.ts)：真 Git 映射、外部目录拒绝、恢复与安全边界。
- [local-project-persistence.test.mjs](../packages/web/test/local-project-persistence.test.mjs)：真实 SettingService、创建和启动恢复。
- [sidebar-organization.test.mjs](../packages/web/test/sidebar-organization.test.mjs)：混合侧栏和主题／触屏入口。
- [sidebar-organization-transactions.test.mjs](../packages/web/test/sidebar-organization-transactions.test.mjs)：分区事务、拖放、撤销和动作能力。
- [sidebar-focus.test.mjs](../packages/web/test/sidebar-focus.test.mjs)：分类专注与完整位置语义。
- [sidebar-organize-position.test.mjs](../packages/web/test/sidebar-organize-position.test.mjs)：主子菜单定位与键盘。
- [sidebar-source-errors.test.mjs](../packages/web/test/sidebar-source-errors.test.mjs)：逐来源错误、重读与归档。
- [worktree-sidebar-menus.test.mjs](../packages/web/test/worktree-sidebar-menus.test.mjs)：工作树和其会话动作。

新增验证入口：

| 入口                                                                                                                                                                                                                     | 实际覆盖                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| [test-sidebar-collaboration.mjs](../scripts/test-sidebar-collaboration.mjs)                                                                                                                                              | 统一运行本功能的 57 项服务、协议和原有单树回归；`--ui` 追加 16 项浏览器场景      |
| [projectMutations.test.ts](../packages/services/src/setting/projectMutations.test.ts)、[projectSettingsRead.test.ts](../packages/services/src/setting/projectSettingsRead.test.ts)                                       | 项目 CAS、原 key 对账、局部更新、迁移备份与损坏保护                              |
| [executionSet.integration.test.ts](../packages/services/src/project-execution-set/executionSet.integration.test.ts)、[恢复测试](../packages/services/src/project-execution-set/executionSetRecovery.integration.test.ts) | 临时真 Git 多库、同库去重、分叉、停止失败、归档恢复、许可失败释放及 journal 恢复 |
| [CLI admission 测试](../scripts/sidebar-project-context-admission.test.ts)、[工作集协议测试](../scripts/sidebar-execution-set-protocol.test.ts)                                                                          | 固定版本随队列和恢复持久化，完整远程 identity、成员实际执行位置                  |
| [冷会话释放测试](../apps/lcode-cli/packages/bootstrap/src/lcode-protocol/resource-release-close.test.ts)                                                                                                                 | 普通关闭语义、显式停止回执、创建并发门禁、关闭失败不释放                         |
| [sidebar-project-editing.test.mjs](../packages/web/test/sidebar-project-editing.test.mjs)                                                                                                                                | 生产编辑组件、取消／保存／冲突、完整最新值、迟到 ACK、远程元数据与七主题布局     |
| [sidebar-execution-sets.test.mjs](../packages/web/test/sidebar-execution-sets.test.mjs)                                                                                                                                  | 生产工作集组件、逐仓库菜单、冻结范围、原 key 重试、归档恢复、离线及触屏菜单      |

补齐的验证入口：

- [协作基线及缺失目录 UI](../packages/web/test/sidebar-collaboration-completion.test.mjs)：本地／远端同库聚合、每库独立选择、冻结选择、具体成员错误及共享文件提示。
- [逐库审核收据](../packages/services/src/project-execution-set/executionSetPublication.integration.test.ts)：一库合入目标、另一库校验失败，重启/刷新不重复执行或切换分支。
- [真实 SSH 源码验收脚本](../scripts/sidebar-collaboration-ssh-acceptance.ts)：两仓库三成员、真实 checkout、identity、全部许可、幂等与归档恢复；脚本不含凭据。

最终项目编辑场景增加七主题 20px UI 字号、390px 操作按钮可见性和隐式项目重复升级冲突断言。W10/P09 按用户确认的并行共享文件规则验证，Git 管理继续独占。

以上不替代 98 项逐项全部签收。真实 SSH 已验证源码 owner，未启动模型 Runtime；安装版 UI/Agent、WSL／Docker、手机实机、两种交付链路完整故障恢复仍需对应环境。跨库进度证明的是逐库合入目标，不是远端 push 或跨库原子事务。

## 11 实施验证命令与放行

新增回归入口与原有基线入口：

```powershell
pnpm test:sidebar-collaboration
pnpm test:sidebar-collaboration --ui
pnpm exec tsx --tsconfig packages/ui/tsconfig.json --test packages/shared/src/localProjects.test.ts packages/services/src/session/mcpWorkspaceScope.test.ts packages/services/src/worktree/worktreeSafety.integration.test.ts
node --test --test-concurrency=1 packages/web/test/local-project-persistence.test.mjs packages/web/test/sidebar-organization.test.mjs packages/web/test/sidebar-organization-transactions.test.mjs packages/web/test/sidebar-focus.test.mjs packages/web/test/sidebar-organize-position.test.mjs packages/web/test/sidebar-source-errors.test.mjs packages/web/test/worktree-sidebar-menus.test.mjs
pnpm typecheck
pnpm lint
pnpm architecture:check --changed
```

实际运行结果：新增 runner 后端 57 项通过，完整侧栏浏览器 16 项通过；最终项目编辑／基线控件 3 项、工作集共享提示／菜单 1 项定向复跑通过。根类型和 Lint、CLI 类型和 Lint、架构检查通过。用户要求暂停安装包并自行构建，已停止本任务的打包进程，未安装替换。最新日志见实施验证记录；其它基线命令不因列出就视为已执行。

放行逐项记录 commit、客户端模式、服务版本、实际命令、通过／失败／未执行、截图或协议／磁盘证据。某阶段未满足门槛就保持能力禁用，不能用 UI 已出现、模型口头表示知道路径或旧测试通过替代实际执行证明。
