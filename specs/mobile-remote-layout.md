# 手机远控布局与输入可达性

## 目标、证据与边界

本规范先于本轮实现，承接 [移动端远程控制](./mobile-remote-control-cf-workers.md) 的完整客户端镜像规则。修复范围是 presentation、客户端局部显隐和焦点；不是另建手机客户端，也不是裁剪功能。本文验收均为待执行场景，不代表已取得浏览器、真机或软键盘通过证据。

本轮读取的当前源码确认了以下约束；诊断报告的静态宽度预算不能替代真实布局测量：

- `packages/ui/src/hooks/useAppPanels.ts:192-205` 拥有底部终端、右面板和侧栏显隐，侧栏初值为 `true`。`packages/ui/src/app-shell/WorkspaceShellLayout.tsx:440-526` 只在后续窗口 resize 后测量并自动收起；不能把该策略当首屏适配。侧栏 `max-w-[50%]` 与主区 `min-w-[320px]` 分别位于该文件 `1535`、`1638` 行。
- `packages/ui/src/DesktopTopOverlay.tsx:132-153` 的直接侧栏按钮仅由桌面平台条件渲染。命令中心仍有间接显隐路径，因此问题是手机缺少稳定直接入口，不是完全没有入口。
- `packages/ui/src/settings/SettingsPageParts.tsx:126-140` 默认设置行固定保留 192px 控件列；`packages/ui/src/SettingsPage.tsx:1371` 使用 `h-screen`，与 `packages/ui/src/root/RootShell.tsx:6-10` 已有的动态视口高度链不一致。
- `packages/ui/src/prompt-editor/useComposerToolbarFit.ts:15-51` 有逐级压缩但没有最终放不下时的可达策略。`packages/ui/src/v4/ConversationComposer.tsx:2366-2428` 把模型/推理/速度/用量与发送/停止放在同一个 trailing 控制簇，不能仅给 leading 区滚动就宣称所有入口可达。
- `packages/ui/src/LexicalChatInput.tsx:1457-1464` 实际 editable 使用可缩到 16px 以下的 UI token；`packages/ui/src/v4/ConversationComposer.tsx:1153-1162` 的自动聚焦判定把移动端参数固定为 `false`。已有粗指针判断在 `packages/ui/src/lib/pickerFocus.ts:1-16`。
- `packages/ui/src/chat-input-toolbar/contextUsage.tsx:375,964-969` 的 320px 用量浮层无局部高度边界，`packages/ui/src/components/ai-elements/context.tsx:153-160` 默认裁切溢出。`packages/ui/src/GitActionMenu.tsx:717-887` 的推送弹窗无高度上限；但同文件 `419-422` 的提交弹窗已有 `85dvh` 与纵向滚动，应保留其既有修复。
- `packages/ui/src/v4/ConversationRowView.tsx:1277-1283,1579` 和 `packages/ui/src/v4/ConversationTurnGroup.tsx:1429-1433` 的消息动作依赖 hover/focus。附件动作已有无 hover 时常显先例，见 `ConversationRowView.tsx:798`、`ConversationComposer.tsx:2274`。

### 不变量

1. 不修改 Host、Runtime、CommandInbox、owner/lease、鉴权、协议、服务写入或持久化格式/路径；不新增可同步的布局事实、已接受队列或视口偏好。现有显式用户动作仍调用原有命令和校验。
2. `workspaceIdentity?.trim() || workspacePath` 仍为隔离 key；远程调用继续携带 `workspaceIdentity` 与 `remoteSessionId`。布局变化不创建、重启、停止或重接 Agent/Host/会话。
3. Desktop 仍是 `desktop-continuous`；手机仍是 `web-remote-replayable`。权限镜像与已有真实平台能力门禁不变。Web 缺少 Electron BrowserView、桌面 CUA 的能力边界不因布局扩大或缩减。
4. 不把 `simplifyForNarrowRemote` 用作布局开关。它在 `WorkspaceHeaderSections/WorkspaceHeaderActionSection.tsx:57-68` 移除帮助与终端，并向任务菜单传递能力裁剪标志；不是无害的密度属性。
5. 不通过全页 `overflow-x-hidden`、缩小字号、截断全部标签或删除按钮来掩盖不可达区域。代码/表格/终端及工具条可以有明确的内部滚动边界，页面不能被它们撑宽。
6. 遵守 `DESIGN.md:9-16,511-534`，普通文字使用 `text-ui-*`，移动端 editable 兼容下限复用 `text-mobile-input-safe`，不更改根 `html` 字号。

## 断点与平台范围

- 窄屏工作区布局为 **Web 且 CSS 布局视口宽度 < 768px**，与 Tailwind `md` 对齐；768px 属于宽布局。判断使用 `matchMedia` 的布尔快照及 change 订阅，不依赖首次 resize、UA、物理分辨率或 `visualViewport` 键盘高度。
- App 从现有平台 props 得到原生 Desktop 身份。macOS、Windows、Linux 原生 Desktop 均不启用 Web 抽屉策略；原生标题栏、安全区、宽屏 split 与拖动行为保持现状。设置行和工具条的内容适配仍可在真正空间不足时生效，不改变桌面业务能力。
- Web 844px 横屏属于宽布局，沿用现有 split/自动收起策略，但 390px 等低高度仍受动态高度和浮层滚动规则保护。粗指针焦点与输入兼容策略独立于宽度，所以横屏手机仍不自动唤起输入。
- 浏览器环境首个可交互 render 就读取正确断点。SSR/没有 matchMedia 的环境不访问不存在的 DOM，采用宽布局安全默认；水合后只更新布局投影，不恢复草稿或重建会话。
- 布局订阅集中在 App 的一处 leaf hook，向 `useAppPanels` 与 `WorkspaceShellLayout` 透传同一布尔值；不为每个子组件订阅连续窗口像素。

## 单一所有者与事件顺序

| 状态                                                        | 唯一所有者                                  | 允许的消费者/写入口                                 |
| ----------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------- |
| `isSidebarVisible`、`isSidePaneCollapsed`、`isTerminalOpen` | `useAppPanels`                              | App/布局/触发按钮只读并发送显式打开、关闭或切换意图 |
| 右面板 tabs、active tab、scope、关闭授权与终端 release      | 原 `useAppPanels` 及现有 tab/terminal owner | 布局不复制、不过滤、不借关闭抽屉调用关闭 tab        |
| 窄屏布尔值                                                  | App 的单一视口订阅                          | 只影响本地展示；不是远端状态，也不决定功能权限      |
| 焦点返回目标、焦点约束、背景 inert                          | 抽屉展示 leaf 的 DOM/ref                    | 不维护第二套 open state，不接服务或会话命令         |
| 编辑器文本、附件、模型/推理/速度与待提交意图                | 现有 Composer draft/编辑器所有者            | 布局与 DOM fit 不写草稿，不重放 Submission          |
| 设置值、用量事实、Git 状态/错误                             | 现有设置与服务 hooks                        | 本轮只重排或滚动现有展示                            |

```text
首屏 / matchMedia 越过 768px
  -> App: 窄屏布尔快照（本地、无持久化）
  -> useAppPanels: 本地显隐的唯一所有者
  -> 同一棵 WorkspaceShellLayout / Panel / TabsContent / Composer 树
     -> CSS 几何 + inert + 焦点约束；不改身份、scope 或命令流

用户打开左/右抽屉
  -> 保存有效的触发器引用
  -> useAppPanels 显式打开目标，窄屏同时收起另一侧（不删除其内容）
  -> 背景 inert -> 焦点进入非文本导航/关闭控件
最顶层菜单 Escape -> 只关闭菜单
抽屉 Escape / 遮罩 / 关闭按钮
  -> 消费该关闭事件 -> useAppPanels 显式关闭（幂等）
  -> 解除背景 inert -> 焦点归还仍可见的触发器，否则归还主区的非编辑导航入口

未改变的业务边界：
Desktop continuous ----------┐
                            +-> 原 Host owner/lease -> 原 CommandInbox -> 原 Runtime
Web replayable + gap repair -┘                          （布局动作无此箭头）
```

- 首次进入窄 Web：侧栏和右面板默认收起，完整主会话可见；已恢复的右面板 tabs 仍保留，恢复 effect 不得把它们误当成用户刚发出的展开意图。终端仍按原规则首次显式打开后才初始化。
- 从宽 Web 进入窄 Web：只在断点变化时将左右显隐收敛到收起，保留 tabs、草稿、终端、上次宽布局尺寸。不能每次 render 或每次高度 resize 都收起用户刚开的抽屉。
- 窄 Web 同时最多一个侧向模态抽屉。打开右侧来源可以是 Header、文件预览、Git 或现有 side-pane intent，均复用既有 owner，不另存 `mobileDrawerOpen` 业务副本。打开目标只收起另一侧，不关闭其 tab。
- 回到宽 Web：去除遮罩、inert 和焦点约束，当前显隐继续由上述布尔值决定，不凭断点主动重开用户刚关闭的面板。沿用原宽布局存储 key/尺寸；不得把临时抽屉宽度写回宽布局偏好。
- 关闭抽屉不是关闭 tab、终端或会话。幂等 close 不能直接调用无条件 toggle 导致重开；嵌套浮层不能与抽屉、停止生成共用同一次 Escape。
- 断点收敛和左右互斥属于瞬时布局动作，只改上述本地显隐，不调用 `saveTaskSidePaneCollapsedPreference` 或设置服务；显式用户动作既有的偏好写入路径保持不变。viewport 判断不得写入现有宽布局 resize 存储。

## 工作区布局与保活

1. 窄 Web 主区使用可收缩的单列宽度，不与 50% sidebar 或 240px side-pane 最小宽度相加。左侧是任务/工作区导航抽屉，右侧是原 side pane 的受限全宽/近全宽抽屉；均限制在动态视口内，超高内容内部滚动。
2. 已选会话和新建草稿均有可见的直接侧栏入口；右面板、终端、任务菜单和帮助仍可触达。Header/顶部动作必须预留真实空间；可做局部重排或受限动作区，不能叠在标题/输入上，也不能只靠命令中心挽救失去的入口。
3. 窄屏关闭侧栏时，其内容不占主区宽度且不进入 Tab 顺序。抽屉有可访问名称、显式关闭按钮、受控展开状态；触发器用 `aria-expanded`/`aria-controls` 表达关系。打开时背景不可点、不可被程序聚焦，Tab/Shift+Tab 不落入背后 Composer。首尾键盘循环不仅要把焦点留在抽屉，还必须让目标进入其内部可见滚动区域：首项 Shift+Tab 到末项、末项 Tab 回首项使用原生 focus 滚入能力；初始非编辑聚焦、背景焦点收回和关闭回焦仍保留 preventScroll，不全局取消。
4. 左侧选择任务或新建草稿后，先执行原导航意图，再收起左抽屉；不得修改原导航参数的 `workspaceIdentity`/`remoteSessionId` 或把异步服务结果当作布局状态。已有导航失败处理不删。仅展开分组、打开文件树或展开菜单不自动关闭抽屉。
5. 初始焦点放在抽屉关闭按钮或首个导航控件，不自动放到搜索/contenteditable/终端输入。关闭后不把焦点直接送回 Composer，避免手机软键盘重弹。若触发器已卸载/隐藏/inert，使用仍可见的工作区导航入口，不聚焦 body 背后的编辑器。
6. 优先保持现有父树与组件 key，仅改变容器定位/宽高/显隐；复用 Radix 或平台模态能力时也必须保持生产内容的 DOM 父树和实例身份。必要的常驻展示 leaf 可沿用 `RootWorkspaceContent.tsx:104-126` 的 inert 模式，并补齐等价焦点限制、嵌套浮层顺序与回焦测试。
7. 禁止 `narrow ? Dialog(content) : ResizablePanel(content)`、跨断点切换 portal container 或复制两套内容树。也不能直接切 `AnimatedSidePanePanel` 的 `useResizablePanel` 分支：`animatedSidePanePanelModel.ts:52-59` 当前恒为 true，两条不同父树会重建 TabsContent。保留同一 `ResizablePanel`/内容层是优先方向；不能为抽屉重构整个通用 resizable primitive。
8. 打开/收起/跨断点都不重挂 Composer、TabsContent、PreviewPane、已初始化 TerminalSession；初次按需加载与原有按内容类型的 preview 重内容门控不扩展、不绕开。保护挂载要验证真实组件/节点身份与草稿，而不只是观察抽屉外壳是否还在。
9. 底部终端可继续使用同一列的上下分割，不强制改成第三个抽屉；最小高度、Header 与关闭按钮须在低高度内可达。终端关闭只收起，显式关闭终端 tab 的 PTY 回收不改（`Terminal.tsx:287-288`、`AnimatedTerminalPanel.tsx:59-65`）。TerminalSession 的打开/切换自动 focus 同样尊重粗指针与 inert，直接点终端仍可输入；不能先聚焦再由抽屉强制 blur。
10. 宽屏 Desktop 的外沿、窗控避让、resize、既有侧栏尺寸与入口不变。宽屏 Web 也必须有侧栏重新展开入口，不能因窄屏曾关闭侧栏而永久失去入口。

## 设置页、长浮层与输入

### 设置页

- <768px 时默认与 wide 设置行均为单列：说明在前，完整控件行在后；控件容器 `min-w-0`、最大宽度不超过实际内容列，按钮组按需换行。不能仍固定 192px/280px 把标签挤成一字一行，也不能仅调整 label 宽度。
- ≥768px 恢复现有双列密度；大字号与长英文仍可读。Settings 导航 rail 与返回入口保持可达，不以隐藏设置项换取空间。
- 设置页面服从 RootShell/窗口框架的 `h-full + min-h-0` 高度链；不再嵌套第二个 `100vh`。导航和内容各自能滚到末尾，地址栏/视口高度变化不把最后控件永久裁掉。
- 只改排版，不改设置保存、错误处理、platform 注册或值的所有者。复用现有组件，不重做所有设置 section。

### 用量与 Git 浮层

- 给具体 `ContextContent`/调用处设置基于 Radix available-height、available-width 与动态视口余量的上限，内容在受限容器内纵向滚动；320px 视口两侧仍保留安全余量。触摸打开、hover/focus 打开和原额度刷新/确认流程不变。
- 用量最多明细、子代理/工作流统计、额度信息同时存在时，最后一行及操作可滚到。错误信息不截断、不静默丢失。
- Git 推送正常态、未跟踪分支、长分支名和长错误态均有动态高度上限与内部滚动，关闭/取消/确认可达；保留已有提交弹窗高度、review/stale/fingerprint/身份校验和 mutationPending 防重复动作。
- 不全局重复修改 DropdownMenu/Select：它们已有 available-height 与纵向滚动（`components/ui/dropdown-menu.tsx:45`、`components/ui/select.tsx:106`）。不把所有通用 Dialog/Popover 加上统一滚动以掩盖个别调用方问题。

### Composer 工具条

- 延续 [模型推理与速度控制](./composer-model-reasoning-and-speed.md) 的单行规则。先压缩次要标签/provider/model 宽度，最后模型图标；不靠换行增加工具条高度。
- 完全紧凑后仍放不下时，**所有非主动作进入有界原生横向滚动区域，主发送/停止始终固定可见**；行内编辑的取消/保存等主提交动作也须可达。滚动区域提供可访问名称，可触控横扫，键盘 Tab 聚焦每个真实按钮时自动滚入视野，不拦截其 Enter/Space；不假造只剩部分动作的工具条。
- Web 工作区结构外壳不是滚动所有者：会话、设置、抽屉正文和工具条各自在其内部滚动。原生 Tab/Shift+Tab 或浮层关闭回焦不得把结构外壳纵向滚动，顶部直接导航与主动作须仍可见、可命中。结构外壳采用不可程序滚动的裁剪边界；保持内层原生滚动、Tab 顺序和焦点环，不用事件拦截、事后 blur 或延时 `scrollTop=0` 修正。原生 Desktop 的结构裁剪规则不因本次 Web 修复改变。
- 如当前 trailing 簇太宽，先在 `ConversationComposer` 的现有插槽接线上把配置控件与发送/停止分离，让非主动作纳入同一受限区域；不得继续把模型/推理/速度/用量藏在 `overflow-hidden` 内。没有可压缩 control/model 的组合也必须进入正确终态。
- 展宽后恢复既有几何与完整标签，语言、UI 字号、Plan 标记、后台任务或模型载入/错误的变化均重新适配。不为 fit 引入第二份 React 业务状态，不用任意超时掩盖测量循环。
- 手机宽度预算只包括实际渲染控件。`V4ComposerCuaEntry.tsx:36-44` 已有平台门禁；不能把桌面专有 CUA 计入手机，也不能为了腾空间更改其真实能力门禁。

### editable 与焦点

- 16px 安全 token 必须施加到真正的 Lexical contenteditable（非仅 placeholder）。粗指针/无 hover 的移动输入场景包括 844px 横屏；其它 UI 文字保持 `text-ui-*` 与用户字号缩放。不得用全局根字号、禁用浏览器缩放或 UA 解析修复。
- 挂载、切会话、切草稿、连接后解除 disabled 不在粗指针手机上自动聚焦 Composer。复用 `isCoarseTouchDevice()`，不根据 `<768px` 一概取消桌面键盘聚焦。精细指针 Desktop 保留 `focus-now/defer/skip` 与延迟可编辑后兑现一次的语义。
- 用户主动点输入框仍能编辑；已明确开始输入后的交互不应强行 blur。关闭 picker/抽屉不把焦点送进手机输入框；已有 picker 的 focus restore 门禁保留。延后的 focus callback 在执行帧再次检查粗指针、可编辑与 inert/隐藏状态，scope 变化/卸载取消旧帧。
- 草稿恢复的 `setText`、mention 预填和编辑器 state 恢复也会经 Lexical 选区同步触发焦点。手机且编辑器未被用户聚焦、或当前表面 inert/隐藏时，程序化更新复用已安装 Lexical 的 `SKIP_DOM_SELECTION_TAG` 保留内容更新但不写 DOM 选区；保留原 `PROGRAMMATIC_UPDATE_TAG`、草稿/mention 序列化与主动输入行为。不得用事后 blur 抵消已唤起的键盘。
- UI 字号常规验收取默认 14px 与支持上限 20px（`lib/uiFontSize.ts:3-5`）；安全 token 是固定 16px 的兼容例外，不另造字号尺度。可计算字号验证不等同于 iOS 无焦点缩放验证。

### 无 hover 消息动作

- 无 hover 输入设备上的用户复制/编辑、assistant 复制/fork/retry/反馈及 hook-only 动作，按其原资格条件常显；沿用附件的 `[@media(hover:none)]:opacity-100` 或等价局部样式。
- 精细指针 Desktop 继续 hover/focus 显示；不增加桌面噪声。不改变执行中/只读/可 retry 等业务门禁，不让无效操作为了凑布局变成可点击。
- 大字号和长文字时动作可布局在自己的区域，不遮正文；不得通过改虚拟列表、滚动锚点或消息投影来解决纯显隐问题。

## 验收矩阵（accepted，执行状态均待验证）

| 场景               | 准备与动作                                                                                                      | 必须断言与证据                                                                                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 首次手机进入       | 分别用 320×568、360×800、390×844、430×932 Web 首次加载；无手动 resize                                           | 主区单列，左右默认收起；实际 bounding rect 在视口内，页面 scrollWidth 不大于 clientWidth（容许 1px 舍入）；发送、左右入口与设置入口可点，不以截图裁切冒充通过                 |
| 左抽屉完整路径     | 新草稿/已有会话打开侧栏，选择任务、新建草稿；另测只展开任务组                                                   | 所有入口保留；选择/新建收起，展开分组不收起；打开有名称/焦点约束/背景 inert，关闭后恢复导航焦点                                                                               |
| 右抽屉完整路径     | 从 Header、文件预览或 Git 原入口打开；滚动、切 tab、关闭抽屉再打开                                              | active tab 和原实例保留；关闭抽屉不关闭 tab/PTY；同时不露出可交互的左抽屉                                                                                                     |
| Escape 与嵌套浮层  | 抽屉内再打开菜单/选择器；依次 Escape、遮罩、显式关闭；运行态计数 stop                                           | 第一次只关最顶层浮层，下一次才关抽屉；不触发停止生成、编辑取消或隐藏层动作；Tab/Shift+Tab 不穿透；焦点归还有效触发器                                                          |
| 跨断点保活         | 输入包含中文、mention 的草稿并准备附件；打开真实预览和 mock 终端；390→767→768→1280→390                          | 同一生产编辑器/PreviewPane/TabsContent/TerminalSession 实例与 DOM 身份保留，草稿、附件、配置、tab/终端内容不丢；无 create/close 会话/PTY 的额外调用；宽屏尺寸偏好不被抽屉污染 |
| 低高度             | 844×390 Web 横屏，另改变可用高度；打开设置、终端、最大用量和 Git 长错误                                         | 横屏按宽布局；内容区可滚到末尾，关闭/确认/发送可达；浮层边界不超动态视口，最后控件可真实点击                                                                                  |
| 设置列             | 320/390px，中文/长英文，各种 default/wide 控件；更改一个 mock 设置后返回                                        | 标签与完整控件分行、可读、不相互遮挡；导航和内容滚动到底；仅原设置回调执行一次，值不重置                                                                                      |
| 工具条终态         | 320/360px，长 provider/model、Plan、后台任务、用量/推理/速度齐全；无 model 或无 collapse control 的组合；再展宽 | 主动作 rect 固定可见；每一非主动作横扫/Tab 可达且可触发；工具条单行，不相互覆盖；展宽标签恢复；发送使用原草稿选择                                                             |
| editable/自动焦点  | 粗指针无 hover，首屏/切会话/新建/disabled→enabled/关闭 picker；主动点编辑器                                     | 自动阶段 editable 不成为 activeElement；主动编辑可用；computed font 使用 16px 安全 token；精细指针仍按 defer/focus-now 规则工作                                               |
| 消息触控动作       | 粗指针无 hover 的用户、assistant、turn 尾与 hook-only 行                                                        | 合格动作未 hover 即可见并可点；复制/编辑/重试等 mock 回调正确，不改变业务资格；精细指针 hover/focus 行为不退化                                                                |
| 语言、主题、大字号 | 中文与英文；Zai Light、Zai Dark；对其余已注册主题抽样；UI 字号 14/20px                                          | 不只检查类名：测几何、可点击性、焦点和滚动；语义色与焦点可辨，长标签不成为唯一布局支撑                                                                                        |
| 宽屏回归           | 1280×800 Web 与原生 Desktop 平台配置，打开左右与终端并拖动                                                      | Desktop 标题栏/窗控/宽度与原密度不变；Web 有侧栏再展开入口；已有桌面能力门禁保持；原生实际窗控需真实 Desktop 验证，不能用 Web flag 截图代替                                   |

- `bug-candidate`：静态源码已证明约束缺口，但修复前后的具体溢出/点击影响须由上述真实组件浏览器 fixture 记录；不能把静态算式描述成已浏览器复现。
- `pruned`：本轮不重新测试所有 Host/Runtime/协议组合，因为不修改其边界；仍审查 diff 确认身份、能力及 admission 校验未变化，不把该裁剪写成业务验证通过。
- 真机 Safari/Android 软键盘、地址栏实际收放、系统缩放和原生标题栏事件如无设备/环境均明确记为未验证。浏览器 viewport/touch 仿真只能证明 DOM/CSS 与本地交互，不能证明软键盘不遮挡或 iOS 不缩放。

### GUI 反馈：结构外壳不得参与焦点滚动

第一轮独立验收记录 `.lcode/workflow-artifacts/mobile-layout-gui-first-pass.md:17-27`：320×568、英文/Zai Dark/20px 时，从真实 Lexical textbox 按 Tab 到 Add context，顶部 Toggle sidebar 的 y 从 10 变成 -178；Web 结构外壳 `scrollTop=188`，而 `window.scrollY=0`、文档宽度仍是 320/320。Shift+Tab 到末尾速度入口和长浮层关闭也触发同类问题。记录者进一步按原始完整祖先链与当前 JSX 结构映射，定位为内层 `WorkspaceShellSurface`：relative/hidden 的该层滚动，外侧 relative/visible wrapper 与 static/hidden `DesktopWindowFrame` 均为 0；原始 evaluate 未采集 data 属性，不把结构映射写成直接读属性的证据。只修该 Web 内层，保留 DesktopWindowFrame 不动。造成额外纵向溢出的唯一后代未确定，不把它推定成业务代码调用 `scrollIntoView`。

回归必须保留该原始路径：精细指针（第一轮真实媒体条件）、320×568、英文暗20px，直接 textbox→Tab；另从 Send→Shift+Tab，逐个双向遍历工具条，并打开/关闭模型、Context 和 Git 浮层。每步检查结构外壳 `scrollTop=0`、导航 rect 仍在视口且中心命中、发送/停止可见；内部工具条仍能滚到最后控件、内部正文/浮层仍可纵向滚到底。不得只检查文档横向宽度，也不得阻止原生 Tab 或把焦点移走来通过。360/390/430、844×390及1280宽屏重复代表步骤。修复后 GUI 状态仍待独立复测，不继承第一轮的部分通过结论。

实际 fixture 为 `packages/web/test/fixtures/mobile-layout.html`，入口 `mobile-layout.tsx`，生产组件内容和虚拟服务分别在 `mobile-layout-content.tsx`、`mobile-layout-data.tsx`。测量探针 `mobile-layout-focus-scroll.tsx` 只观察真实 DOM 的焦点、滚动和导航命中，不写滚动位置、不制造输入；输出供独立浏览器断言。fixture 复用生产 `WorkspaceShellSurface`、面板和 Composer，不替代完整 App 路由/生产任务索引。

### 第二轮 GUI 反馈：抽屉首尾焦点必须可见

第二轮记录 `.lcode/workflow-artifacts/mobile-layout-gui-second-pass.md:7-23` 已实际关闭原结构壳滚动 P1；这不等于整体验收通过。该记录 `26-43` 在 390×844 中文/Zai Light/14px 重复确认：左抽屉导航 scrollTop=0，从初始“关闭”按 Shift+Tab 后末项成为 activeElement，却在 y1184/bottom1212、中心不可命中，导航没有滚动；手动内部滚到380后末项可見可点。原因与生产 handleKeyDown 的 wrap 分支 `focus({ preventScroll:true })` 对应。

仅首尾 wrap 分支改用允许原生滚入的 focus；不加 timeout/scrollTop 补偿、不改变用户按键顺序、不移除其它初始/回焦处 preventScroll。回归在真实 Drawer 长列表上执行关闭→Shift+Tab→末项、末项→Tab→关闭，并在中英/14与20px/390×844及320×568/右抽屉代表内容复测。目标需同时为 activeElement、rect 在对应抽屉可视区域、中心命中；内部正文允许滚动，结构壳和窗口框架 scrollTop 仍为0。嵌套菜单首个 Escape 与关闭后触发器回焦必须保持。probe 增加 activeRect/activeHit 和抽屉内滚动所有者读数作为辅助，不能代替真实按键与 DOM 断言。修后 GUI 仍待独立复测。

## 实现分工与验证接线

实现前各组读取目标现有内容、未暂存和已暂存 diff；保留任务无关改动。只新增必要 leaf，不建 architecture module、共享包出口或新依赖。

- **shell 组**：`App.tsx`、`hooks/useAppPanels.ts`、`app-shell/WorkspaceShellLayout.tsx`、其本地 `types.ts`、`DesktopTopOverlay.tsx`/ActionButton、`WorkspaceSidebar.tsx`、`WorkspaceHeader.tsx`/Sections、SidePane/Terminal 必要布局层、对应 toggle 展示件、必要窄屏 hook/常驻抽屉 leaf 与本组测试。两个 `i18n/locales` 仅此组可写；其它组如确需新文案给 shell 留键名/中英文，不并改 locale。不得写 styles.css。
- **settings 组**：`SettingsPage.tsx`、`settings/SettingsPageParts.tsx`、`GitActionMenu.tsx`、`chat-input-toolbar/contextUsage.tsx`、`components/ai-elements/context.tsx` 与本组测试。保留现有 Git review/stale 防护和用量刷新既有 diff。不写 Composer、styles.css、locale 或通用浮层 primitive。
- **composer 组**：`prompt-editor/ChatPromptEditor.tsx`、`useComposerToolbarFit.ts`、`LexicalChatInput.tsx`、`v4/ConversationComposer.tsx`、`v4/composer/composerAutoFocus.ts`、`ConversationRowView.tsx`、`ConversationTurnGroup.tsx`，确需时的 `ConversationTimeline.tsx`/`components/ai-elements/message.tsx` 与本组测试。`styles.css` 仅此组可写；优先局部 utility，不借本轮重写消息或提交逻辑。`pickerFocus.ts` 只复用，不另建 UA/移动端判定。
- **集成**：本规范及关联 spec、跨组 props 接线、最终 `packages/web/test/fixtures/mobile-layout*` 由集成员独占；并行编码员不修改 fixture、spec、共享包入口、package.json、AGENTS.md 或 architecture baseline。跨组文件改动先移交，不同时编辑。

### 测试层次

1. 各组先补最小回归再实现。沿用 `node:test`、`node:assert/strict`、`tsx` 与既有 React SSR；UI 无统一 test script，命令形态为 `node scripts/mise-run.mjs pnpm --dir packages/ui exec tsx --test <本组实际测试文件>`。记录真实红灯/绿灯；SSR/类名只能证明结构接线，不证明几何、焦点或保活。
2. shell 优先覆盖 767/768 与平台判定、窄屏初值/互斥/幂等关闭；composer 覆盖粗指针焦点决策和极小预算终态（含无 model、无 compact 控件）；settings 覆盖真实控件与浮层结构/动作保留。测试新文件不得与其它组重名或写入别组目录。
3. 集成 fixture 通过 Vite 已有 `@` 源码别名导入真实 App/WorkspaceShellLayout 或其生产 leaf、SettingsPage/SettingsRow、ChatPromptEditor/ConversationComposer、消息动作、ChatContextUsage、GitActionMenu；mock 只替代平台/服务数据与命令副作用，不复制生产 JSX/CSS。若只渲染生产 leaf，必须同时验证真实 App 接线，不能把替身 header/drawer 当完整壳层实测。
4. 仅启动 Web Vite 回环服务：`node scripts/mise-run.mjs pnpm --dir packages/web dev --host 127.0.0.1 --port 5173 --strictPort`（端口冲突时使用另一个已确认回环端口）。不运行根 `dev:web`，因为它会同时启动 server；不启动 Agent/Host，不连真实账户/仓库服务。临时服务在验证后结束。
5. 浏览器记录真实 bounds、scrollWidth/clientWidth、最末操作滚动后命中、activeElement、Tab 顺序、触控媒体查询与草稿/实例连续性，截图作为补充。fixture 可加 mount/unmount 与 mock 调用计数，但不能仅凭外壳计数推断生产编辑器保活。
6. 合并后由工作流统一执行 `node scripts/mise-run.mjs pnpm typecheck`、`node scripts/mise-run.mjs pnpm lint`、`node scripts/mise-run.mjs pnpm architecture:check --changed`、`node scripts/mise-run.mjs pnpm --dir packages/web test`、`node scripts/mise-run.mjs pnpm --dir packages/web build`，以及本轮新增 UI 测试。各组不重复根检查/Web suite/build；已有失败与本轮新增失败分别报告，不伪造通过。
7. 修改前目标文件及其 staged/unstaged 补丁保存在 `.lcode/workflow-artifacts/mobile-layout-repair-baseline/`；`manifest.json` 记录 SHA-256、原始 HEAD、缺失目标与快照路径。只含计划源文件/spec，不复制凭据、运行时配置或全仓；后续独立复核以快照对比本轮增量，不把 HEAD 的全部脏 diff 当作本轮修改。
