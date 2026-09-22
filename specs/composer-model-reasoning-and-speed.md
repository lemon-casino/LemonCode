# Composer 模型推理与速度控制

## 产品规则

1. 首页 Composer 对所有内置供应商和自定义供应商展示模型推理档位与速度选项。自定义供应商按其选择的 API 类型继承请求映射，不能另建一套 UI 状态。
2. 模型注册表拥有推理能力。已知模型使用精确规则；没有精确规则的模型使用通用档位 `disabled`、`low`、`medium`、`high`、`xhigh`，不能退化成只有“开启/关闭”。已知不支持关闭的模型可以由精确规则移除 `disabled`。
3. 速度是统一模型选项，公开值为 `standard` 与 `fast`，产品显示为“标准”与“快速”。运行时及工作流主动选模沿用 `standard` 默认；新会话 Composer 的默认速度使用模型声明的最高档（目前为 `fast`）。
4. 速度必须真实进入请求，不能只保存 UI 状态：
   - Anthropic Messages 把 `fast` 映射为请求体 `speed: "fast"`，并发送 `anthropic-beta: fast-mode-2026-02-01`；`standard` 不添加速度字段，保持兼容端点的默认行为。
   - OpenAI Chat Completions 与 Responses 把 `fast` 映射为 `service_tier: "priority"`，`standard` 不添加服务层字段。xAI 和使用相同 API 类型的自定义供应商复用该映射。
5. API 账号没有快速档位权限、模型不支持快速模式或兼容端点不接受对应字段时，保留供应商原始错误并停止请求；不能静默谎报为快速。用户可以改回“标准”。
6. 新会话 Composer 初始化或主动选模时，推理和速度都使用该模型声明顺序的最后一项。最近一次提交只决定新任务的模型身份，不继承上一任务的推理档位和速度；当前新任务草稿内用户明确改选的档位保持到提交，不被重渲染或恢复覆盖。切换模型后，旧模型不支持的推理或速度值不得泄漏到新模型。
7. Composer 草稿是下一次提交选择的唯一 UI 所有者。提交时冻结完整 `ModelSelection`，其中 `reasoningLevel` 与 `speed` 一起进入命令、队列、运行时和会话持久化；滚动、重渲染和预热投影不得重置它们。
8. 运行时按模型注册表校验两类选项。模型声明速度时，缺少或不支持的 `speed` 均在网络请求前拒绝执行。历史选择缺少速度时只保留模型身份并要求重新补全，不能在恢复路径静默改变历史意图。
9. 旧字符串选模型命令表示主动选择新模型，应按目标模型补齐默认推理与标准速度；结构化 `createSession.config.modelSelection` 必须原样校验并保留已选档位。`ModelSelected` 发布运行时实际生效的完整选择，不能把速度从投影中丢掉。
10. 子代理继承父模型时保留父模型速度。工作流的模型引用是主动选择，提交后从当前模型目录补齐目标模型的标准速度；历史选择的缺失字段仍按第 8 条处理。
11. 草稿改选触发 Host 有效选择重新读取期间，同一目标的独立模型目录读取继续供工具条展示推理和速度菜单；不得拿旧输入的有效选择覆盖新草稿。目标工作区或服务变更时目录读取须重新绑定，提交仍需等待当前输入的有效选择确认。读失败时保留草稿和可见控件，但阻止未经校验的提交。

## 所有者与接口

- Built-in Provider Config 拥有推理与速度 Option Specs，以及按 API 类型定义的 Option Map。
- Provider Registry 发布完整、只读的模型 Option Specs，并校验 `ModelSelection.options`。
- Composer draft 拥有用户尚未提交的 `reasoningLevel` 与 `speed`。
- 最近提交偏好仍保存完整的 `ModelSelection.options` 供审计/恢复；新任务只用模型身份初始化最高档。草稿记录是否由用户显式改选，避免旧版已初始化的空 Root 草稿把“标准”带回默认值。
- ModelSelectionService 拥有模型目录和有效选择；Renderer 通过无输入目录读取作展示，通过带草稿输入的读取校验，前者不能当作提交已校验的凭据。
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
```

- 用户在请求运行期间修改控件只影响下一次 Submission，不修改已经冻结的请求。
- 自定义供应商的身份、模型目录和 API Key 不拥有速度状态；其模型选择通过所选 API 类型映射。
- UI 不根据供应商名称猜测请求字段，也不直接调用平台 API。

## 验收

- 选择 `grok-4.7` 后，推理菜单显示“低 / 中 / 高 / 极高”，不再只有“关闭 / 开启”。
- OpenAI、Anthropic、xAI、其他内置供应商以及自定义供应商的模型均显示“标准 / 快速”速度菜单；新会话的空草稿和主动选模默认最高推理档与“快速”，上一任务即便使用“标准”，也只继承模型身份。当前草稿手动切成“标准”后重渲染仍保持“标准”。
- 未命中精确模型规则的自定义模型显示通用推理档位；命中精确规则时按精确档位展示。
- Anthropic 选择“快速”后，请求体包含 `speed: "fast"`，请求头包含 Fast mode beta；选择“标准”后不添加 `speed`。
- OpenAI Chat Completions、OpenAI Responses 及相同类型的自定义供应商选择“快速”后，请求体包含 `service_tier: "priority"`；选择“标准”后不添加 `service_tier`。
- Composer 重渲染、草稿恢复及消息排队后，已选推理与速度均不丢失；每次排队输入使用其提交瞬间冻结的值。
- 新会话连续切换推理和速度时控件不闪退；Host 读较慢或失败时仍能看到同目标目录提供的菜单，异工作区切换不显示旧目录，校验未完成时不可提交。
- 最近提交的速度写入与读取对称；创建新会话时不复用最近的速度，已有会话缺失速度仍要求手动选择。
- 旧字符串切换模型得到有效默认速度；新会话预热和已有会话的模型切换投影均保留已提交的速度。
- 子代理继承与动态工作流指定模型均携带完整速度选项，不能在创建模型时因缺失速度失败。
- 非法或缺失速度在发出网络请求前失败，并报告模型不支持或未选择该档位。
