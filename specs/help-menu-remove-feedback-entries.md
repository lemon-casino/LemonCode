# 帮助菜单移除「问题上报」与「给产品提需求」入口

## 背景与目标

「点击帮助」在两个层面各有一套菜单：

- 工作区标题栏的帮助下拉菜单（`packages/ui/src/WorkspaceHelpMenuButton.tsx`，Desktop 与 Web 共用），含「问题上报」「给产品提需求」。
- 桌面原生应用菜单的帮助子菜单（`packages/desktop/src/main/desktopApplicationMenu.ts`），含「问题上报」（macOS 菜单栏可见）。

本次按产品要求删除这两个入口。

## 产品规则

1. 帮助下拉菜单不再出现「问题上报」「给产品提需求」。删除后保留：产品文档、用户社群；桌面端追加资源管理器、检查更新、关于 LCode。
2. 桌面原生应用菜单的帮助子菜单不再出现「问题上报」，其余项（更新日志、资源管理器、导出日志、清除所有数据等）与分隔符顺序不变。
3. 「给产品提需求」不再保留任何入口。它此前唯一来源就是帮助菜单（`feedback.featureRequest.source` 文案即「Workspace Header 帮助菜单 / 给产品提需求」），入口删除后 `FeatureRequestDialog`、`feedbackStore.featureRequestOpen` / `openFeatureRequest` 与 `feedback.featureRequest.*` 文案全部不可达，必须同步删除，不能留下不可达的第二条反馈路径。
4. 问题上报能力本身保留，删除的只是帮助菜单入口。反馈中心（提交表单 + 我的反馈）仍由这些既有入口打开：Quick Pick「问题上报」、侧栏与任务列表的反馈入口、错误提示条入口、桌面命令 `DesktopCommandIds.OpenFeedback`（经 `IPlatformService.openFeedback`）。原生菜单项删除后 `OpenFeedback` 命令仍被上述路径使用，命令与 IPC 通道保留。
5. 随之删除的文案键：`workspaceHeader.help.issueReport`、`workspaceHeader.help.productRequest`、`workspaceHeader.help.productRequestDraft`（该键本就无消费方）、`titleBar.menu.help.feedback`（UI 与 `desktopMenuMessageIds.helpFeedback` 两处）、`feedback.featureRequest.*`。
6. 不新增任何替代入口，也不改动反馈中心、Quick Pick 与其它反馈入口的行为。

## 状态所有权与影响面

- 反馈中心 UI 状态的唯一所有者仍是 `packages/ui/src/feedback/feedbackStore.ts`。本次只移除其中的 `featureRequestOpen` 字段与 `openFeatureRequest` 动作；`open`、`openSubmit`、`openTickets`、`openSubmissionJob`、`tab`、`submitDraft`、`submissionJobId`、`selectedTicketId` 与 `close` 的所有权和语义不变。
- 菜单是纯投影：`WorkspaceHelpMenuButton` 只读 `useFeedbackStore` 与 `IPlatformService`，不持有状态。删除两项后它只保留 `openProductDocs`、`openCommunity`、`openResourceManager`、更新检查与 `ShowAbout`。
- `createHelpMenuActionHandlers`（`packages/ui/src/lib/helpMenuActions.ts`）中 `openIssueReport` 的唯一调用方是本次删除的菜单项，一并删除，并去掉因此不再需要的 `openSubmit` 入参与 `FeedbackSubmitDraft` 导入；`openProductDocs` 与 `exportLogs` 保留。
- 原生菜单是 `desktopMenuMessageIds` 的投影：删除 `helpFeedback` 后 `DesktopMenuLocaleMessages` 的 `Record` 约束要求 zh-CN / en-US 两份 `desktopMenuMessages` 同步删除该键，否则类型检查失败。
- 无状态迁移、无持久化字段变更：`featureRequestOpen` 从未落盘，`feedbackStore` 不参与跨窗口广播，删除不需要数据迁移。
- 无时序/远端语义变化：不涉及 stream、snapshot、queue、重连或 `workspaceIdentity` 匹配。

## 验收

- 打开工作区帮助菜单：看不到「问题上报」「给产品提需求」；产品文档、用户社群仍在，桌面端资源管理器/检查更新/关于 LCode 仍在。
- macOS 原生菜单栏「帮助」：看不到「问题上报」，导出日志、资源管理器、清除所有数据等项与分隔符顺序不变。
- Quick Pick「问题上报」仍能打开反馈中心并聚焦提交表单；提交表单与「我的反馈」行为不变。
- 仓库中不再存在 `FeatureRequestDialog`、`openFeatureRequest`、`featureRequestOpen`、`feedback.featureRequest.` 的引用。
- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过。

## 事件顺序（删除后，问题上报入口）

```text
Quick Pick / 侧栏 / 任务列表 / 错误提示
  → feedbackStore.openSubmit(draft) → open=true, tab="submit", submissionJobId=null
  → FeedbackCenter 渲染提交表单

桌面原生菜单「问题上报」项（已删除）不再触发
  → DesktopCommandIds.OpenFeedback → PlatformChannels.OpenFeedbackDialog
  → App.tsx onOpenFeedbackDialog → openSubmit()      （该通道仍保留，供既有命令调用方使用）
```
