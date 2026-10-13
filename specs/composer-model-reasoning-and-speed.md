# Composer 模型推理与速度控制

## 产品规则

1. 首页 Composer 按模型目录展示推理档位与速度选项。自定义中转按其选择的 API 类型继承速度请求映射，不能另建一套 UI 状态；兼容某个协议不代表官方端点支持该协议原厂的快速服务。
2. 模型注册表拥有推理能力。已知模型使用精确规则；没有精确规则的模型使用通用档位 `disabled`、`low`、`medium`、`high`、`xhigh`，不能退化成只有“开启/关闭”。已知不支持关闭的模型可以由精确规则移除 `disabled`。
3. 速度是统一模型选项，公开值为 `standard` 与 `fast`，产品显示为“标准”与“快速”。运行时及工作流主动选模沿用 `standard` 默认；新会话 Composer 的默认速度使用模型声明的最高档（目前为 `fast`）。
4. 速度必须真实进入请求，不能只保存 UI 状态：
   - Anthropic Messages 把 `fast` 映射为请求体 `speed: "fast"`，并发送 `anthropic-beta: fast-mode-2026-02-01`；`standard` 不添加速度字段，保持兼容端点的默认行为。
   - OpenAI Chat Completions 与 Responses 把 `fast` 映射为 `service_tier: "priority"`。xAI、Gemini OpenAI 兼容接口和使用相同 API 类型的自定义中转复用该映射。
   - Groq 官方 Chat Completions 仅为 `openai/gpt-oss-120b`、`openai/gpt-oss-20b`、`llama-3.3-70b-versatile` 开放快速档，映射为 `service_tier: "performance"`，不能发送 OpenAI 的 `priority`。账号需开通 Enterprise Performance，未缓存上下文须小于 8192 tokens；不满足时保留服务端错误，不擅自改为 `auto`。OpenAI 官方微调模型（`ft:` 前缀）只开放标准档。
   - 标准档清除 SDK/调用者残留的速度字段；OpenAI 官方端点显式发送 `service_tier: "default"`，避免项目默认快速档覆盖会话选择。自定义中转仍省略字段以兼容既有端点。
   - Anthropic 官方端点只为当前支持 Fast mode 的 Opus 4.8、5、5.5（含日期后缀）开放快速档；其他模型只声明标准档。Z.ai、BigModel、Moonshot、MiniMax、DeepSeek、Qwen、MiMo 的内置官方端点未声明本项目可用的同模型快速请求参数，只声明标准档，不发送 Anthropic Fast mode beta。自定义中转保留原有可选档位，不根据展示名称或第三方域名猜测其权限。
5. API 账号没有快速档位权限、模型不支持快速模式或兼容端点不接受对应字段时，保留供应商原始错误并停止请求；不能静默谎报为快速。用户可以改回“标准”。
6. 新会话 Composer 初始化或主动选模时，推理和速度都使用该模型声明顺序的最后一项。最近一次提交只决定新任务的模型身份，不继承上一任务的推理档位和速度；当前新任务草稿内用户明确改选的档位保持到提交，不被重渲染或恢复覆盖。切换模型后，旧模型不支持的推理或速度值不得泄漏到新模型。
7. Composer 草稿是下一次提交选择的唯一 UI 所有者。提交时冻结完整 `ModelSelection`，其中 `reasoningLevel` 与 `speed` 一起进入命令、队列、运行时和会话持久化；滚动、重渲染和预热投影不得重置它们。
8. 运行时按模型注册表校验两类选项。模型声明速度时，缺少或不支持的 `speed` 均在网络请求前拒绝执行。历史选择缺少速度时只保留模型身份并要求重新补全，不能在恢复路径静默改变历史意图。
9. 旧字符串选模型命令表示主动选择新模型，应按目标模型补齐默认推理与标准速度；结构化 `createSession.config.modelSelection` 必须原样校验并保留已选档位。`ModelSelected` 发布运行时实际生效的完整选择，不能把速度从投影中丢掉。
10. 子代理继承父模型时保留父模型速度。工作流的模型引用是主动选择，提交后从当前模型目录补齐目标模型的标准速度；历史选择的缺失字段仍按第 8 条处理。
11. 草稿改选触发 Host 有效选择重新读取期间，同一目标的独立模型目录读取继续供工具条展示推理和速度菜单；不得拿旧输入的有效选择覆盖新草稿。目标工作区或服务变更时目录读取须重新绑定，提交仍需等待当前输入的有效选择确认。读失败时保留草稿和可见控件，但阻止未经校验的提交。
12. Composer 模型触发器在同一行显示 provider 与 model。空间充足时应展示完整名称；空间不足时由工具条布局投影依次隐藏 provider、约束 model 宽度，最后退化为模型图标，不能通过换行增加工具条高度。系统“减少动态效果”设置只关闭滚动动画，不得改变标签几何或截断策略。

13. 选择快速仅代表请求意图。每个物理请求由 Adapter 观察响应：OpenAI/兼容接口读取 `service_tier`（Responses SSE 读取 `response.service_tier`），Anthropic 读取 `usage.speed`（包括 SSE `message.usage.speed`）。记录 `confirmed`、`downgraded`、`unconfirmed`，缺失字段不能判定快速已生效，也不能凭耗时猜测。服务端降档或缺失回传时保留成功输出，不自动重发收费请求、不改写用户选择。
14. 速度诊断记录到现有请求完成日志，携带既有 request/trace/session 标识、选择档位、实际发送字段和回传档位；不记录正文、密钥或端点。Composer 菜单继续表示请求档位，不表示响应确认结果。本次不新增持久化字段或协议事件。
15. Composer 思考入口使用离散滑块浮层，档位仍来自同一模型目录，交互、主题、状态边界及验收见 [Composer 思考档位滑块](composer-thought-slider.md)。快捷键继续按目录顺序循环；自动化、子代理及工作流配置保留既有选择控件。

## 所有者与接口

- Built-in Provider Config 拥有推理与速度 Option Specs，以及按 API 类型定义的 Option Map。
- Provider Registry 发布完整、只读的模型 Option Specs，并校验 `ModelSelection.options`。
- Composer draft 拥有用户尚未提交的 `reasoningLevel` 与 `speed`。
- 最近提交偏好仍保存完整的 `ModelSelection.options` 供审计/恢复；新任务只用模型身份初始化最高档。草稿记录是否由用户显式改选，避免旧版已初始化的空 Root 草稿把“标准”带回默认值。
- ModelSelectionService 拥有模型目录和有效选择；Renderer 通过无输入目录读取作展示，通过带草稿输入的读取校验，前者不能当作提交已校验的凭据。
- Composer 工具条的 DOM fit 投影只拥有可见密度（provider 是否隐藏、model 最大宽度、图标降级）；它不拥有模型选择，也不能改写 Composer draft。
- Agent runtime 拥有已接受的会话 `ModelSelection`；Model Adapter 只消费冻结后的 Option 值并把映射结果合并到请求体。
- 公共接口为 `ModelSelection.options.speed?: string` 与可选迁移字段 `ModelOptionSpecs.speed`。新内置配置为所有模型补齐速度声明；可选类型只用于读取旧配置和旧快照。

## 状态与事件顺序

```text
Built-in/API-type rules
          -> Provider Registry (reasoning + speed specs)
          -> Composer draft 选择 reasoningLevel / speed
          -> 用户改选时按 draft 输入重读 Host View（等待期间沿用同目标目录展示控件）
          -> Submission 冻结完整 ModelSelection
          -> Command admission / queue 持有同一 Selection
          -> Runtime 校验并持久化 Selection
          -> Model Option Map 合并 reasoning + speed wire fields
          -> API-type transport 补充必要 Header
          -> Provider HTTP 请求
          -> Adapter 按物理请求观察响应实际速度（不累积正文、不另起消费链）
          -> 既有完成日志：已确认 / 服务端降档 / 未确认
```

- 用户在请求运行期间修改控件只影响下一次 Submission，不修改已经冻结的请求。
- 自定义供应商的身份、模型目录和 API Key 不拥有速度状态；其模型选择通过所选 API 类型映射。
- UI 不根据供应商名称猜测请求字段，也不直接调用平台 API。

## 验收

- 选择 `grok-4.7` 后，推理菜单显示“低 / 中 / 高 / 极高”，不再只有“关闭 / 开启”。
- 支持或允许透传快速档的模型显示“标准 / 快速”；已知不支持的官方模型只显示“标准”。新会话的空草稿和主动选模默认模型声明的最高档，上一任务即便使用“标准”，也只继承模型身份。当前草稿手动切成“标准”后重渲染仍保持“标准”。
- 未命中精确模型规则的自定义模型显示通用推理档位；命中精确规则时按精确档位展示。
- Anthropic 选择“快速”后，请求体包含 `speed: "fast"`，请求头包含 Fast mode beta；选择“标准”后不添加 `speed`。
- OpenAI Chat Completions、OpenAI Responses、xAI、Gemini 及相同类型的自定义中转选择“快速”后，请求体包含 `service_tier: "priority"`；自定义中转选择“标准”后移除 `service_tier`，OpenAI 官方显式使用 `default`。Groq 使用 `performance` / `on_demand`。
- Composer 重渲染、草稿恢复及消息排队后，已选推理与速度均不丢失；每次排队输入使用其提交瞬间冻结的值。
- 新会话连续切换推理和速度时控件不闪退；Host 读较慢或失败时仍能看到同目标目录提供的菜单，异工作区切换不显示旧目录，校验未完成时不可提交。
- 最近提交的速度写入与读取对称；创建新会话时不复用最近的速度，已有会话缺失速度仍要求手动选择。
- 旧字符串切换模型得到有效默认速度；新会话预热和已有会话的模型切换投影均保留已提交的速度。
- 子代理继承与动态工作流指定模型均携带完整速度选项，不能在创建模型时因缺失速度失败。
- 非法或缺失速度在发出网络请求前失败，并报告模型不支持或未选择该档位。
- 实际 SDK 流式和非流式请求均验证传输层正文与响应档位；覆盖回传快速、标准、无字段、未知字段、Responses 后续事件覆盖初始事件、Anthropic message_start、重试隔离、取消传播以及原有 raw chunk 消费者。返回标准/缺失字段时不能重试或丢失输出。
- 目录更新通过递增 Built-in revision 发布；旧 `fast` 选择在收窄的官方模型上按原有选择校验要求重新选档，不能静默降档。Desktop continuous 与手机 replayable 仍由同一 Runtime 持有选择，诊断在同一 Adapter 执行，不改变 owner/lease、队列、恢复和事件顺序。
- 宽 Composer 中，长 provider/model 名称保持单行并在可用空间内完整显示；开启系统“减少动态效果”后几何保持一致。收窄 Composer 时按 provider → model 宽度 → 图标的顺序降级，模型名不换行，发送按钮不被挤出或遮挡。

## 厂商依据（2026-10-11 核对）

- [OpenAI Fast mode](https://developers.openai.com/api/docs/guides/fast-mode)：`priority` 与 `fast` 均有效；回包可能为 `default`。
- [Anthropic Fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode)：当前支持模型、beta header 与 `usage.speed`；Opus 4.6 会静默回落标准档。
- [xAI Priority Processing](https://docs.x.ai/developers/advanced-api-usage/priority-processing)：`priority`，回包确认实际档位。
- [Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai#flex-and-priority-inference)：兼容接口接受 `service_tier: priority`。
- [Groq Service Tiers](https://console.groq.com/docs/service-tiers)、[Performance Tier](https://console.groq.com/docs/performance-tier)：快速档为 `performance`，标准档为 `on_demand`；支持模型、账号及上下文限制。

## 本次修复验证（2026-10-11）

- 已确认缺陷：通用协议映射把所有官方模型都宣告为支持快速；Groq 错用 `priority`；标准档空 Patch 未清除已存在的快速字段；请求路径缺少响应速度确认。自定义 OpenAI 中转未联机测试，不能把中转忽略参数或上游降档写成已确认原因。
- 速度相关 Adapter/模型选择/诊断测试 50/50；API Key 轮换、运行时 Header、草稿与提交回归 16/16；桌面/手机宽度速度 E2E 9/9；完整 Composer 发送 E2E 36/36。SDK 测试使用注入的虚构 HTTP/SSE 响应，不使用真实账号或产生模型费用。
- 根目录 `pnpm typecheck`、`pnpm lint` 与 CLI `pnpm --dir apps/lcode-cli typecheck`、`pnpm --dir apps/lcode-cli lint` 均曾通过；最终 Adapter 包级 typecheck 与本次文件定向 lint 通过。后续包级 lint 受到并行出现的非本次修改阻挡：`src/storage/session-store/sqlite-session-store.ts` 超过 400 行（当次报 412 行），未修改或提交该文件。架构检查：0 violations / 0 baseline / 0 new；本次 13 个可格式化文件检查通过。涉及模块为 lcode-cli 与 Web 测试夹具，Provider 规则只修改数据，不引入跨模块依赖。
- 验证环境为 Windows、Node 24.14.1、pnpm 10.34.6；Node 与 `mise.toml` 的 24.21.0 不同，CLI 工具报告 engine 警告及已有 workspace lockfile 解析警告。未验证真实供应商权益、加速幅度、macOS/Linux 或手机远控断线恢复。
- 生产诊断检索 `model.speed.observed`：`requestedSpeed` 是会话意图，`sentServiceTier` / `sentSpeed` 是实际发出的档位字段，`responseTier` 是回包档位，`speedResult=unconfirmed` 表示中转未提供可识别的确认。升级/重启加载 Built-in revision 33 后规则生效。
