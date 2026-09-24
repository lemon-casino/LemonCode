# 拖拽会话引用

## 产品规则

1. 用户可以从侧栏可读的历史会话行拖拽到当前聚焦且可编辑的对话 Pane。普通列表使用原生 HTML5 drag，分组列表继续使用现有 `@dnd-kit` pointer drag；两条路径都输出同一 renderer-only 会话引用 payload。
2. 拖拽进入目标 Pane 后先进入候选态。指针连续停留 1500ms 且源会话与目标 Pane 属于同一 Agent service authority 时，目标进入 armed 态：Pane 显示玻璃蒙层、低幅度呼吸边框和“松开以引用会话”提示。停留不足、离开、失焦、取消或目标不可用时不写入草稿。
3. armed 状态松开后，在拖拽开始前保存的当前光标位置插入一个原子化 `sessions` Mention；markdown 的 destination 是 canonical `#sess_<id>`，带标题的链接 label 只用于展示。不复制源会话 transcript，不自动发送，不清空已有文字、文件引用或其他 Mention；同一 session id 已存在时不重复插入。
4. 拖拽 payload 只包含版本、renderer authority、session id、源 workspace identity/remote route 和可选展示标题。标题只用于 UI，不能参与身份、权限或读取。payload 使用独立的 `application/x-zcode-session-reference` MIME，不能复用 Workbench split 的 fallback payload。
5. Renderer 在 dragover 和 drop 时都校验 session id、renderer authority、Agent service route、目标 Pane 的 focused/readOnly/connection 状态；远程 scope 要求 identity 与 endpoint 成对存在，并遵循现有 # mention 的同 Agent service 规则。HTML DnD protected mode 下，dragover 只允许使用当前 renderer 正在拖拽的活动 payload 建立候选态；drop 必须重新解析 MIME 正文并与候选 nonce 一致。Core 仍以现有 `#sess_*` parser 和 `ReadSessionContext` 作为最终读取边界。跨 renderer window/Agent Host 的引用在 V1 拒绝，不按 workspace path 猜测 Host。
6. Draft 继续由现有 Lexical editor state 和 composer draft store 持久化，身份 key 使用 `workspaceIdentity?.trim() || workspacePath`。拖拽不会新增 Runtime、IPC、RPC 或 shared protocol 字段。
7. Mention 提交后只注入引用提醒；模型按需调用 `ReadSessionContext`，工具结果受既有 token 上限约束并视为不可信背景。父会话、子代理、provider/model selection 和 compaction 语义不改变。
8. 当前会话自身、只读 Pane、未连接远程 Pane、payload 无效或 authority 不匹配时拒绝 drop；手机/remote web 不开启原生 HTML5 会话拖拽，继续使用已有 Mention Picker。

## 所有者与时序

```text
sidebar row -> SessionReferenceDragCoordinator -> focused SessionPane
                                      |              |
                                      | 1500ms       | armed overlay
                                      v              v
                               reference payload -> Lexical insertMention
                                                       |
                                                       v
                                             composer draft persistence
                                                       |
                                                       v
                                             send text with #sess_id
                                                       |
                                                       v
                                      Core reminder -> ReadSessionContext (on demand)
```

- 当前 drag 的 renderer coordinator 持有 source payload/target registry；每个可编辑 Pane 的 Composer 只持有自己的 candidate/armed timer 和 draft selection，timer 清理必须由 dragleave、drop、dragend、blur、Escape、Pane unmount 和 scope 变化触发。
- SessionPane 只投影目标状态和蒙层；ConversationComposer/Lexical 是草稿写入唯一入口；Core/SessionStore 是会话历史唯一事实源。
- 每个 drop 使用当前 drag nonce 和 session id 二次校验；module-level 活动 payload 只服务 dragover 预热，drop 阶段禁止 fallback。
- 分组 pointer drag 在提交前必须用 pointerup tracker 的最终坐标重新解析目标；最后一次 dnd move 的旧坐标不能决定 drop，快速移出 Pane 后松开不得引用旧目标。
- Desktop continuous 和 web-remote-replayable 的运行链路不变；本功能只改变 renderer 草稿投影。

## 视觉和可访问性

- candidate 态只显示轻微 target ring，不遮挡输入框。
- armed 态复用现有 Pane glass overlay：semantic popover/accent colors、`backdrop-blur-sm`、紧凑 pill、`MessagesSquare`/`Hand` 图标；不使用渐变、装饰性光球或大面积卡片。
- `prefers-reduced-motion` 下保留静态高亮，关闭呼吸动画。
- 目标文案和错误使用 i18n；长标题单行截断，不改变 Pane 尺寸。
- drop 后保持输入框 focus；非桌面 surface 继续使用既有 Mention Picker。

## 验收场景

- 普通、时间线、置顶和分组会话都能生成引用；分组排序、Workbench split 和文件 drop 不回归。
- 1500ms 前松开无插入；持续停留后出现蒙层和呼吸态；离开/失焦/取消会清理 timer 和视觉状态。
- 原生 dragover 在浏览器只暴露 MIME type 时仍可进入候选态，但缺少/损坏的 drop 正文不得提交；分组拖拽 armed 后快速移出 Pane 再松开不得按旧坐标插入。
- 插入保留正文、文件 Mention、会话 Mention 和 editorStateJson；重复引用 no-op；不自动发送。
- 本地同 authority 跨 workspace 可引用；同一 remote Agent service 的已解析 workspace scope 可引用；跨 renderer/Host、错误 remote route 和只读目标拒绝。
- 提交后文本的 Mention destination 是 canonical `#sess_*`；不在 Renderer 预读取 transcript；模型可按需读取且结果 bounded。
- 子代理仍拥有独立历史；切换 provider/model 只影响既有提交边界，不改变拖拽引用。
