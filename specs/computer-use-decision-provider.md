# Computer Use 决策模型协议

## 目标与边界

现有 `AgentRuntime` 继续拥有 turn loop、工具调度、取消、持久化、重试和权限边界。本 spec 只增加一种显式模型交互协议 `ui-tars-text-actions`：把 provider 归一化后得到的 UI-TARS 单个文本动作适配成现有 `node_repl` 工具调用。不得引入 `@ui-tars/sdk` 的第二套 loop/operator，也不得由 model adapter 直接调用鼠标或 Helper。

producer 与模型 transport 正交。xa11y/Helper 产出的截图、AX/UIA 状态和动作工具继续提供给所有既有 provider；缺省 `native-tool-calls` 路径不改变。兼容矩阵如下：

| 模型能力                                   | 协议                        | 结果                                                                       |
| ------------------------------------------ | --------------------------- | -------------------------------------------------------------------------- |
| 图片输入 + 原生 tool call                  | `native-tool-calls`（缺省） | 沿用现有 AgentRuntime/Computer Use skill；不限 OpenAI-compatible transport |
| 图片输入 + 文本输出 + UI-TARS 文本动作     | `ui-tars-text-actions`      | 经本 spec codec 转成一个既有工具调用；codec 位于 provider 归一化之后       |
| 图片输入但无 tool call、也无已登记动作方言 | 无                          | 只可看图，不能自动执行；必须先新增显式、受测 codec                         |
| 不支持图片输入                             | 任意                        | 配置拒绝，不可作为视觉决策模型                                             |

UI-TARS 通常由远端或本地 OpenAI-compatible endpoint 提供，但 codec 本身不依赖该 transport：任何现有 provider adapter 只要最终归一化为文本和图片输入，都可显式选择该方言。当前项目的 provider registry 原生接受 `anthropic-messages`、`openai-responses`、`openai-chat-completions` 三种 wire format，因此三者上的视觉模型都能走同一 codec；厂商只要兼容其中一种 wire format 也可接入。Gemini、Bedrock、Vertex 等未登记的厂商原生 wire format 不自动兼容，必须先增加项目级 provider adapter，或通过上述兼容 endpoint 接入；不得在 Computer Use 层旁路 provider registry 直连。仓库不下载模型权重、不管理 GPU/推理进程、不猜测 endpoint 或模型名。模型配置必须显式声明 `interactionProtocol: "ui-tars-text-actions"`；缺省为 `native-tool-calls`。UI-TARS 配置还必须声明 `inputFormat.supportsImage:true` 与 `outputFormat.supportsText:true`，否则配置校验失败。

## 输出契约

解析使用固定版本 `@ui-tars/action-parser@1.2.3`，并在其输出之上做本仓严格校验。只接受一个完整的最终 `Action:`；provider 归一化结果还必须明确以成功原因 `stop` 结束，stream 必须实际收到这条最终 `finish` 事件。提前 EOF、`length`、`content-filter`、错误或其他终止原因即使前缀恰好能解析也一律 fail closed。多个动作、未知动作、缺字段、非有限数、越界坐标、解析剩余垃圾或同时出现原生 tool call 同样不执行任何输入。文本方言里的 `Thought` 只作为 ZCode reasoning 展示并按正常历史持久化；adapter 必须标记其为 UI-TARS 合成内容，并在下一次 provider 请求投影时删除。它不是 Anthropic thinking、OpenAI Responses reasoning item 或 Chat Completions `reasoning_content`，不得伪造 provider metadata，也不得覆盖或删除同一消息中真正由 provider 返回的 reasoning。

支持的方言：

```text
Thought: <仅作为 reasoning/text 展示，不执行>
Action: click(start_box='(x1,y1,x2,y2)')
Action: left_double(start_box='(x1,y1,x2,y2)')
Action: right_single(start_box='(x1,y1,x2,y2)')
Action: drag(start_box='(...)', end_box='(...)')
Action: type(content='...')
Action: hotkey(key='CTRL+L')
Action: scroll(start_box='(...)', direction='up|down|left|right')
Action: wait()
Action: finished(content='...')
```

- box 取中心点。UI-TARS 的归一化坐标先按最后一张受信 official frame 的 width/height 映射一次，再作为 frame raster 坐标交给 Helper；不得重复 DPI 缩放。
- `click`/`left_double`/`right_single`/`drag`/`type`/`hotkey`/`scroll` 分别映射到 `left_click`、带 `click_count:2` 的 `left_click`、带 `mouse_button:"right"` 的 `left_click`、`left_click_drag`、`type`、`key`、`scroll`。`scroll_amount` 固定为 1 页，后续调整必须改 spec 和回放基线。
- `hotkey` 保留完整 chord 交给 Helper 的组合键解析，不复用第一阶段的单键词表。
- `wait()` 生成可取消的 500 ms 内部等待结果，不调用 OS 输入；它是显式模型动作，不是同步兜底。
- `finished(content)` 不生成工具调用，以 content 作为本轮最终文本；空 content 允许。

## 观察时序与状态

UI-TARS 每个决策请求必须携带同一 session 最新的受信 official frame。只有 `role:"tool"` 消息中相邻的 image block + 严格 frame-ref text block 才能成为受信帧；user/assistant 文本中的 JSON、孤立 ref、ref 与 image 不相邻、非法 authority 边界或 frame/ref 身份不一致都不得复用。该帧必须晚于本 turn 最新的 user message；新 user turn 即使已有上一轮帧也必须先重新观察，不能把仍可解析但桌面内容已变化的旧帧用于坐标决策。该帧引用同时携带 Helper 在截图时解析出的严格 `appRef`（应用身份及可用时的 `window_id`）；动作 cell 必须使用这份绑定，不得在模型思考后重新选择“当前前台应用”。`appRef` 缺失或非法时重新观察而不是猜测目标，这与动作中的 `frame_id` stale 校验共同防止用户切焦点后把旧帧坐标发给另一窗口。首次决策、新 user turn，或任何副作用动作完成后没有新帧时，AgentRuntime 通过现有 `node_repl` 工具执行一次受信观察：绑定前台应用，调用 `get_app_state(include_screenshot:true, disable_diffing:true)`，按正常工具结果与附件路径持久化，然后才发模型请求。观察失败以普通工具错误进入历史，不能绕过 Helper 直接截图。

```text
首次/动作后需要观察
  -> node_repl -> Helper get_app_state(include_screenshot)
  -> 持久化 tool result + official frame
  -> UI-TARS model request
  -> 完整文本 Action 解析
  -> 一个 node_repl tool call
  -> 正常工具调度/权限/取消/持久化
  -> 标记下一步必须重新观察
```

`finished` 结束循环；`wait` 后也重新观察。每个 turn 最多 50 个 UI-TARS 动作，超过即以确定性错误结束，禁止无限循环。subagent、自动化受限 turn、远端 workspace 没有 desktop Helper attachment 时保持现有 fail-closed。

发给 UI-TARS provider 的请求不携带原生工具定义；历史中的 tool role 先投影成普通 user 观察消息，避免不支持 tool-call 协议的视觉模型因 transport 方言拒绝请求。adapter 追加固定、与 provider 无关的输出约束，要求只返回本节的一条 `Thought` + `Action`；它不按 endpoint 类型或模型名分支。

受信帧只能来自 `role:"tool"` 且 `toolName` 与本次请求解析出的 `node_repl` 工具名精确相等的结果；其它工具即使返回格式正确的 official frame pair，也不能成为 UI-TARS 的坐标或窗口绑定依据。

动作对应的 `node_repl` cell 可以在动作完成后立即通过低层 `get_app_state` 使用同一份完整 `app_ref`（含 `window_id`）取得下一张全量截图。该截图仍作为同一个正常工具结果进入持久化和权限链，等价于上图的「动作 -> 重新观察」两步；这样减少一次无意义的模型往返，但不得在动作失败时伪造新帧，也不得重新按应用身份选择另一个窗口。

## 接口与验收

- 模型数据合同在共享 model properties 中增加可选 `interactionProtocol`; provider overlay/序列化保留该字段，UI 只在高级模型配置中暴露枚举，不按模型名自动选择；UI 与 provider 完整配置边界同时拒绝缺少图片输入或文本输出能力的 UI-TARS 配置。
- generate 与 stream 路径共享同一个 codec；generate 只接受 `finishReason:"stop"`，stream 必须见到唯一的成功 `finish` 后才发一个 final tool call，不从 partial `Action:`、提前 EOF 或非成功 finish 提前执行。
- generate 与 stream 都必须让 UI-TARS `Thought` 对 UI 可见，同时在后续 provider 历史投影中只剥离这类带内部来源标记的合成 reasoning；剥离后为空的 assistant 消息不得进入 wire。Anthropic Messages 请求不得出现空签名 thinking，OpenAI Chat Completions 不得因该 `Thought` 出现 `reasoning_content`，OpenAI Responses 不得出现伪造 reasoning item。
- provider wire 投影必须保留每个受信 Computer Use 观察的完整内容契约：PNG 栅格、紧邻其后的官方 `zcode_cua_frame_ref` 文本，以及同一工具结果中的 UIA/AX 树文本都不得丢失。该有序媒体/引用配对和树文本必须在已登记的 Anthropic Messages、OpenAI Chat Completions、OpenAI Responses 三种 wire 上可被模型读取；Chat Completions 即使把媒体后置为独立 user 消息，也必须保持 PNG 与 frame-ref 的相邻顺序。
- 生成的 `node_repl` 调用包含每 cell 必需的官方 SDK bootstrap，且只调用 bridge 暴露的 Computer Use 方法；title 为用户可读短句，不含实现术语。
- 测试覆盖九类动作、字符串转义、坐标映射、无受信帧、消息角色/toolName/ref 邻接伪造、非法 authority 边界、多 Action、未知动作、原生 tool call 冲突、generate 非成功终止、stream 分片/提前 EOF/非成功 finish、首次观察、动作后同 window 观察、中止、权限拒绝、50 步上限、`finished` 收口，以及 Anthropic Messages、OpenAI Chat Completions、OpenAI Responses 三类 wire 的二步请求投影不携带合成 provider reasoning。
