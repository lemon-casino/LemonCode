# OAuth 供应商接入

后续阶段已于 2026-10-11 获用户授权：按账号用量分析和会话上下文走势转入 `oauth-usage-context-trends.md` 实施；下文“后续范围”描述的是首轮交付边界。

## 范围与产品规则

用户于 2026-10-11 确认全量接入 magpie 当前授权渠道及实际模型调用。采用原生账号管理、统一适配器、受控插件执行器；不启动 magpie 桌面/Web 应用，不改写外部 Agent 配置。实现必须先有本规格和对应测试。

- 设置 → 模型设置 → 添加供应商提供 OAuth/API 两类。OAuth 包括浏览器、设备授权、厂商 CLI 登录和显式凭据导入。API 保留全部已有模板和自定义入口。默认显示 API 以保留现有操作路径，用户可切换 OAuth。
- OAuth 渠道：BigModel、Z.AI、Claude、Codex、ChatGPT API、GitHub Copilot、Gemini CLI、Antigravity、Factory、Cline、MiniMax Code（国内/国际）、Kiro、Cursor、Devin、Qoder（国内/国际）、Trae（国内/国际）、WorkBuddy（国内/国际）、MiMo、Zed、Command Code、Grok。OpenCode Zen Free 为 API 公共凭据。Vertex ADC 是高级凭据能力，不显示为浏览器 OAuth。
- 一家供应商可有多个账号，各供应商账号并存。连接使用稳定 connectionId；令牌、邮箱、短命 endpoint 不是身份 key。账号连接不调用应用 OAuth 的互斥清理/active provider 写入。
- 授权完成、模型可用和正在读取目录是独立状态。无套餐、无模型或目录读取失败仍可保留已授权账号并重试；不得显示虚假的调用成功。用户可重新授权、刷新模型、启停、删除连接。
- 仅在明确选择导入方法时读取其他 CLI/桌面凭据。外部 CLI 安装状态作为渠道依赖反馈；手机不会为此创建第二个 LCode Agent 或 Host。
- 旧 API 配置不迁移、不重写、不丢失 Key/模型/参数/排除记录/排序。已有应用登录不自动转为供应商账号。

## 所有权和接口

| 事实                     | 唯一 owner                                         | 派生读取者             |
| ------------------------ | -------------------------------------------------- | ---------------------- |
| OAuth 连接与授权 attempt | 当前 Environment 的 ProviderAccountService         | UI hook、安全状态 DTO  |
| 私有凭据与代次           | 加密 Credential Store，account-scoped 锁/CAS       | 授权驱动，正式请求鉴权 |
| 模型目录与可用范围       | Account Provider Source → 现有 Registry            | 设置与会话模型选择     |
| 用户模型编辑             | 现有 Provider 配置/写队列                          | Registry               |
| 调用身份                 | 每次请求开始冻结 provider/connection/account/model | CLI 用量记录           |
| 调用用量                 | 既有 UsageStore                                    | 使用统计               |

`packages/provider` 增加 `oauth-account` access（channelId、connectionId）；不保存 token 或运行时 URL。`packages/provider-node` 实现无 UI 的 driver 契约、固定版本插件兼容和原生协议。`packages/services` 负责账号生命周期与 Credential/Registry 装配。UI 通过 hooks 使用公开服务，跨进程 DTO 有运行时校验。

账号池以 channelId 发布；connectionId 为池中每个连接的独立标识，不把某个账号硬编码进会话供应商。请求响应保留实际 connectionId，后续统计需要继续接入持久化归因。

驱动的私有授权数据保留供应商自己的结构：refresh 可能是轮换 token、Cookie 状态或 CLI profile，不统一解释。插件只接受宿主提供的当前账号读写能力。异步文件/网络 IO，不让插件安装脚本在用户操作时执行。固定源码版本、许可与来源清单随发布构建携带；不得引用相邻 checkout 的绝对路径。

原生协议适配和固定插件源码须在 `third-party/copied-components.json` 登记精确来源 revision、适用文件范围、原始许可文件及 SHA-256。保留上游真实版权文本，不从作者字段推断版权，也不把依据源码适配的实现称为 clean-room。`node scripts/licenses.mjs notices` 统一生成发行声明和 inventory；现有 Desktop/CLI staging 携带这些声明。更新适配源码或插件 bundle 后重新生成并执行 `node scripts/licenses.mjs check`；`.gitattributes` 保持许可与 vendor manifest 所校验文件的原始字节。

正式 Model 执行仍使用现有 AI SDK/Adapter 和 request-auth 路径。若为插件 fetch 提供进程内 loopback transport，必须随机鉴权、仅回环监听、动态就绪、按请求 connection/代次绑定，在目标 Environment 内解析，绝不把端口写进持久 Provider 配置。关闭服务取消授权监听、关闭 transport，取消请求透传到上游。调用入口不能接受任意目标 URL 或任意账号 ID 越权代理。

## 授权和事件顺序

```text
UI 选择方法 → Host 创建 attemptId → driver 返回 URL/device code/输入要求
 → IPlatformService 打开浏览器 → 回调/轮询 → 当前 attempt 校验
 → 加密保存 connection 授权 → 查询套餐和模型 → Account Source → Registry → UI

CLI 请求 → 冻结 connection/model → Host 解析当前鉴权/受控 transport
 → 原生/插件/CLI driver → 流式模型结果 → 既有 UsageStore

desktop-continuous ─实时事件──────────┐
web-remote-replayable ─快照/恢复───────┴→ 同一 owner；UI 无凭据与独立 accepted 状态
```

- 取消、替换授权、删除账号、Host dispose 后旧结果不可写入；若关闭发生在凭据保存 IO 期间，保存返回后必须在存储锁内撤销该迟到连接。凭据刷新仅当前版本可提交；多个窗口不能同时消费同一个 refresh token。
- 登录失效、配额耗尽、网络故障分别处理。网络错误不得自动删除授权；空额度窗口不等于零用量。
- BigModel/Z.AI 复用 init/poll、业务 token 归一化、个人/团队 Key 解析语义。业务 token、Coding Plan Key 和 Start JWT 分开。获取不到有效 secret 不标记模型可调用。个人/团队/Start 的实际来源明确可见。
- 远端使用目标 Environment 的账号和 adapter；不把本机 localhost 或整个 Credential Store 同步过去。沿现有受控 provisioning 扩展允许的稳定连接字段；credential owner/lease 不能因远端同步变成双写。保持 workspaceIdentity?.trim() || workspacePath、remoteSessionId 与 stale run 防护。

本轮桌面设置沿用现有 LocalHost 作用域，先交付用户要求的本机使用。远端 Host 的服务/请求通路独立，但桌面内选择远端 OAuth 登录环境及 OAuth 凭据的受控 provisioning 留待独立扩展；不得声称本地新增账号自动可用于远端。模型高级推理档位先保留供应商默认行为，未做所有厂商 variants 的设置投影。

## 调用与兼容

原生渠道迁移登录、刷新、模型发现和实际请求协议。插件渠道兼容 auth.methods/authorize/callback、loader.fetch、provider.models、refresh、usage；保留不同协议的工具、图像、thinking/reasoning、流式 usage、stop reason、取消与错误。Claude/Grok 的 CLI 边界明确展示。

模型容量来源于目录，不冒充当前上下文消耗。后续统计按 providerId/connectionId/accountId/modelId/requestId/session/执行环境归因；未知归因保持未知，不归给当前账号。上游配额与本地调用账本分开，上下文采样与累计 token 分开。统计 UI 与上下文走势属于后续交付，不得因此阻塞本轮授权与调用。

## 验收矩阵

| 场景          | 断言                                                    | 验证                            |
| ------------- | ------------------------------------------------------- | ------------------------------- |
| 既有 API      | 切分类、添加 OAuth、重启后 API 原配置逐字段不变         | 配置回归 + UI E2E               |
| 两类入口      | 桌面/手机可切换、品牌正确、键盘和中英文可用             | UI E2E                          |
| 各渠道登录    | 真正执行该渠道协议，代码/device/导入输入可提交          | 协议 fixtures；真实账号实测单列 |
| BigModel/Z.AI | 并存、多账号、个人/团队/Start 分离，不清应用身份        | 服务集成                        |
| 竞态          | 取消、重登、删除、dispose 后迟到完成不写入              | 可控 deferred 测试              |
| 凭据          | 加密保存、冷恢复、刷新串行、CAS 防覆盖、UI/日志无 token | 仓库/驱动测试                   |
| 模型目录      | 授权后模型进入现有 Registry/选择器，失败能重试          | 服务/Registry 集成              |
| 模型执行      | 每渠道覆盖文本流、工具调用/结果、usage、取消和上游错误  | wire fixtures + 正式执行链测试  |
| 平台          | 本机与远端 endpoint 正确；手机复用原 Host；关窗清理     | Host/Web 回归                   |

存在实现/fixture 不等于真实厂商账号验证成功；报告分别列出已执行自动化、实际登录调用与环境限制。必须运行 typecheck、lint、架构检查；CLI 改动运行其实际 package 检查。全量功能完成前不将目录占位卡片当成已支持。

# 同供应商账号池补充

- 一个授权渠道可保存多个独立 connectionId；会话选择供应商和模型，Registry 按渠道合并为一个供应商，不要求用户在多个同名供应商中挑账号。同渠道混合模型协议由 Host 在每次请求时按目录解析，CLI 再绑定对应 SDK。
- 每次请求仅使用已启用且声明支持目标模型的账号，优先沿用上次成功账号；401/403/429 或上游 5xx 且尚未向客户端输出时按顺序尝试其他账号。已经输出的流不得拼接或切换。
- 禁用、删除和刷新不影响其他账号；所有账号失败时返回真实失败响应。账号池与 API Key 池独立，绝不把 OAuth 失败自动切到付费 API。
- 调用归属保留实际 connectionId，后续用量按实际账号聚合。多账号验收包含不同模型权益、失败切换、全部耗尽与取消。

## 本轮实现与验证记录（2026-10-11）

实现跨越 provider 配置/Registry、provider-node 驱动、services Host 账号 owner、shared 请求协议、CLI 模型适配器和 UI 设置/hooks。持久化写入由 Host 账号服务统一完成；运行时票据仅在当前 Host 的回环请求链中有效。原生渠道与固定插件合计提供 25 个账号渠道；同渠道多账号在模型选择器中合并为一个供应商。

已实际执行：

- 全仓 `pnpm typecheck`、`pnpm lint` 通过；CLI workspace 自身 typecheck、lint 通过。
- `pnpm architecture:check --changed`：0 violations、0 baseline、0 new。
- 原生授权/调用 fixtures 19/19，固定插件 fixtures 25/25。
- Host 账号生命周期、跨窗口观察、账号池及正式 CLI 请求鉴权回归合计 19/19。
- OAuth 浏览器 E2E 5/5；既有 API Key 批量身份、启停及失败/取消保存回归 1/1。

上述驱动验证使用可控本地端点与进程 fixtures，不代表已完成真实厂商账号的登录或生成验收。尚未逐渠道执行真实账号实测，亦未实测 macOS/Linux。Claude Code 与 Grok Build 保留外部 CLI 依赖；Claude 冷恢复使用历史 transcript，未移植 magpie 的磁盘 resume。远端登录环境选择/凭据 provisioning、完整推理 variants、按账号统计 UI 与上下文走势图仍属于后续范围。

当前环境 Node 为 24.14.1，低于仓库声明的 24.21.0；CLI 检查伴随既有 engine/lockfile workspace 警告。未因本功能重写 lockfile，也未改动本地其他功能的未提交变更。
