# OAuth 供应商细节与 Magpie 对齐

## 中文授权方式与登录操作（2026-10-12）

- 当前25个注册渠道的授权方式名称、来源说明、字段标签/占位提示及授权过程说明，在中文模式下使用UI翻译；品牌、CLI命令、文件名、域名、设备验证码和用户输入保留原值。英文模式保留驱动原文。以当前驱动返回的方法ID及kind为边界，不因翻译新增或隐藏供应商能力。
- 选择框标签为“授权方式”，使用常规288px宽度，不拉伸填满整行；与唯一提交按钮保持同一水平行，窄屏按可用空间收缩并允许选项文字截断。合并原本机快捷检测和下方提交按钮，不在选择方法时读取凭据；用户明确点击后才按当前methodId提交。浏览器/手动凭据显示“开始授权”，客户端入口显示“读取客户端登录”。需要字段时先填写；文件导入使用既有选文件/粘贴与“导入账号”按钮，不再显示第二个空文件提交入口。
- WorkBuddy/AI明确区分“通过浏览器授权”和“读取WorkBuddy/AI客户端登录”。浏览器凭据由Host独立保存，不依赖安装客户端；客户端入口读取该Host外部客户端的登录状态，不读取LCode已保存的浏览器账号。其他本机入口同样说明真正来源、跟随/快照及已有写回语义。
- UI汉化是纯显示投影：不改methodId、channelId、字段key/type/optional/condition/defaultValue、选项value、提交正文及授权URL。ProviderAccounts仍为attempt、连接与加密凭据唯一owner，保持取消和迟到结果防护。桌面continuous与手机replayable共用同一Host命令。
- 设备授权说明必须保留Copilot、Cline、Factory、MiniMax的完整动态验证码；命令、品牌和路径不可被泛化翻译吞掉。未知渠道/未知上游动态格式保留原文，不能猜测或丢失授权步骤。
- 验收：枚举当前25渠道真实methods验证中文覆盖与英文不变；检查显示投影不改变提交契约；中文桌面和手机Web验证按钮/选择框同一行、切换浏览器/客户端后只提交选中methodId、条件字段和文件导入、设备码保持；英文入口保持原文。

```text
Host methods/attempt（授权owner） → UI按当前语言投影文案
用户选择授权方式/填写字段 → 唯一提交按钮 → 原accounts.start(channelId, methodId, inputs)
  → Host原授权/持久化 → 原安全视图与attempt → UI中文/英文显示
```

- 同轮源码审计：共享非批量完成状态未投影added/updated/exists；WorkBuddy/AI、Cursor、Kiro、Command Code、Devin的客户端跟随路径缺少对旧连接身份的明确核对；部分固定插件将昵称/显示名用作accountId。列为独立修复候选，本轮汉化不修改其身份/持久化规则，也不将fixture覆盖描述为真实厂商登录验证。

### 本轮授权源码审计

| 范围                                            | 当前证据与结论                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 全部25渠道                                      | `ProviderAuthorizationForm`原先直出驱动英文；`providerAccountCompletion`非批量结果丢弃added/updated/exists，均投影completed。汉化与按钮职责本轮修正；完成结果细分仍为独立事项。                                                                                                                    |
| Codex、Claude Code、Copilot、Gemini CLI         | `native/local.ts:followLocal`核对稳定identityKey；客户端换账号后拒绝沿用旧connection。ChatGPT API与Antigravity未提供假客户端入口。                                                                                                                                                                 |
| BigModel、Z.AI                                  | `plugins/zcode-local.mjs:resolveZCodeLocal`检查账号、站点、组织与项目；重复读取相同本机来源只更新/复用原连接。浏览器与API Key可分别接入其他账号。                                                                                                                                                  |
| WorkBuddy/AI、Cursor、Kiro、Command Code、Devin | 分别在vendor的`current`、`tokenOf`/`cliTokenNow`、`credOf`、`liveKey`和`live`中重新读取外部客户端凭据，但未对原connection的稳定用户身份进行显式核对。客户端切换账号可能使旧连接代替新用户请求，应独立建立身份门禁；本轮没有向真实厂商请求验证此情形。                                              |
| WorkBuddy/AI、Trae CN/Global、MiniMax CN/Global | 固定插件的`success`、`toAuth`及授权回调优先把昵称/name作为accountId（MiniMax先email，缺失时name）。`admitProviderAccount`在无identityKey时只比较accountId，忽略这些grant已有的uid。假凭据复现：相同昵称、不同uid的两个账号，第二次返回updated且池中仍只有1个账号；应把厂商稳定身份与显示名称分开。 |
| Cline、Factory、Qoder/CN、MiMo、Zed、Grok       | 登录方法来自各自固定插件，未被统一替换成客户端入口；保留设备码、VPC、小米扫码及Grok CLI依赖等差异。Factory文件导入已有用户+组织identityKey；不将此事实推广为所有插件浏览器/API路径均已拥有复合身份。                                                                                               |

本轮使用真实methods枚举与fake browser/service验证显示和提交，使用纯内存admission复现去重风险；未读取/改写无关供应商的真实凭据，未自动重新授权已有账号。图索引现有OAuth节点可以找到owner，但缺少授权文案与来源语义的检索别名，记录为graph-drift-candidate，暂不改已有索引。

- Grok补充：浏览器登录使用独立CLI数据目录，本机入口使用当前CLI目录；`auth.refresh`及`remember`可将新读出的email写入旧grant，未拒绝本机目录换账号。属于同一客户端身份门禁候选，不把其浏览器隔离语义与本机来源混为一谈。
- Z.AI/BigModel浏览器及Zed也有显示名fallback（各自`who`函数）；上游没有提供email/唯一login时，不能据此宣称accountId一定是厂商稳定身份。此项为条件性风险，与本轮已用不同uid/同昵称复现的admission问题分别记录。

## 固定插件兼容层规则

### 本轮全渠道继续核查（2026-10-11 后续）

- 以当前25个ProviderAccounts注册渠道为产品范围，对照本机Magpie Go实现及当前固定插件逐项核查：可见登录方法、文件/本机来源、稳定账号身份与切换、刷新/续期、模型目录及协议、实际模型调用转换、额度端点及未知/部分成功语义。
- 复用原ProviderAccounts owner、原native driver与固定plugin兼容边界。确认缺口后先在spec记录规则并补失败fixture，再实现；没有厂商契约的能力保持明确不支持，不为齐表造接口/余额，不改固定vendor pin，不把模型调用响应用于修补额度。
- 用户自行构建：本轮不执行worker生成、桌面Agent或应用构建。若源文件需要重新生成嵌入worker/许可清单，在最终交付明确给出仓库已有命令和顺序；不手动改生成数据的哈希绕过新鲜度校验。
- 核查结果按供应商记录当前能力、确认遗漏、修复及证据；fixture不代表真实账号联网验证。已移除账号的历史统计不因登录或额度核查被清理。
- 确认两处遗漏：Copilot editor的模型API请求缺少Magpie `copilotAPIHeaders`的`X-GitHub-Api-Version=2026-01-09`，需用于目录与手选模型请求；GitHub令牌交换和额度接口沿Magpie使用不带此CAPI版本的原头部。CLI模式保留其2026-07-01版本、Auto分配/调用保留各自显式版本。Claude文件导入的scopes可能是空格分隔字符串，需像Magpie `loginEntry`同时接受字符串和数组，缺失时才用原默认权限，不静默覆盖明确的较窄scopes。测试仅使用假令牌及fake transport。

### Copilot Auto 与模型可用性

- Copilot目录总是提供Auto；手选列表过滤内部/Experimental模型和不可接受的禁用policy，保留可接受terms、上游推理档位、工具/视觉能力。没有supported_endpoints的旧模型仅使用chat completions；显式仅未知端点的模型不伪装成可调用。
- 每账号driver拥有Auto session和拒绝记录。请求先POST /auto（API版本2026-08-01，prompt+tier=balance）；不可用时尝试/models/session（2025-10-01）；无分配时使用该账号已启用的手选模型，依次偏好fallback/default/gpt-4.1/非premium。缓存遵循上游到期且最多1小时，提前2分钟刷新；手选备用最多10分钟。取消一个会话不能取消其他会话正在排队的分配。
- Auto统一呈现chat completions入口，但上游按selected_model.supported_endpoints真实选择chat/responses/messages，并转换文本、图像、工具历史、流式事件与用量。不能把Messages/Responses模型发到chat端点。每次请求最多3次选择；仅在输出前HTTP400明确model_not_supported或Auto session失效时重选；429、普通错误和已经流出的内容不重播。被拒模型仅当前账号排除6小时。
- Copilot编辑器token交换与CLI直连、本机跟随及账号owner保持现有路径；Auto及手选共享同一账号session、policy接受和生命周期信号，不另存凭据。

- 固定15个provider包保留原始pin。本机入口为CommandCode、Cursor、Devin、Grok、Kiro、WorkBuddy/AI、BigModel/Z.AI；描述区分持续跟随和快照回退。Kiro保持上游刷新写回原CLI/IDE的语义。仅用户选择本机入口后读取凭据，不在methods查询时读取。
- BigModel/Z.AI本机入口按当前channel读取该站个人或所选团队凭据；不得因另一站同时登录而串站。worker将选中站的当前状态传给固定插件，不修改全局文件读取、不改外部文件。每次实际使用重读同站，仅同账号、同组织与项目的凭据续期可跟随；切账号/组织/项目或个人与团队互切时返回expired并要求重新识别，不能把新身份调用归入旧connection。外部退出时仍保留原插件的快照回退。旧source=zcode同样受此门禁；缺少可确认身份的旧快照仅在站点/组织/项目和实际凭据一致时继续，不能把新发现的身份静默贴到旧显式身份或伪造identity。
- Factory文件导入接受正文、env和JSON中的fk-key，每项调用固定whoami地址验证，不使用WorkOS刷新；最多200个账号。匹配身份使用厂商userId与orgId组合，不向UI返回key片段或厂商错误原文。重复key只验证一次；失败项保留其他成功项。取消时网络请求和迟到结果均终止。
- 授权桥接保留placeholder、选项hint、optional、defaultValue与可序列化的等值条件；Host授权验证执行原插件的when/condition函数和validate。当前pin实际表单仅Qoder CN VPC与ZCode站点选择，站点由channel注入；不宣称当前pin使用了动态ask或其他尚未出现的提示契约。
- 模型桥接只输出已约定的安全能力DTO：推理variants白名单、effort枚举、service tiers、toolCall。保留magpie.fellBack事实，Host有既有目录时不以备用表覆盖；没有目录时可展示备用表并标注失败。认证expired/kept/renewed通过Host私有回调投影，删除外发私有标头。
- 附加签到/活动接口仅先盘点：Qoder活动查询/领取、Trae CN签到状态/领取、WorkBuddy签到；未有独立产品命令前不开放任意URL或把它们伪装成模型调用。

2026-10-11 用户要求逐供应商对齐 Magpie，特别是文件导入、本机已登录账号及点击供应商后的多账号管理弹窗。本规格补充 `oauth-provider-integration.md` 和 `oauth-account-quotas.md`；不能把仅有登录和模型调用的公共接口等同于各供应商完整行为。

## 产品与所有权

### Google 工具 Schema 兼容修复（2026-10-11）

- 用户实测 Antigravity `gemini-3.6-flash` 返回400：Google工具参数的嵌套Schema收到不支持的`propertyNames`、`exclusiveMinimum`。已确认`geminiRequest`当前清理器只移除两个关键字，未实现Magpie `internal/gateway/codeassist.go:plainSchema`的受控子集。
- Google wire adapter是唯一转换owner，原工具定义和执行期校验不改变。发送前把工具Schema投影为Code Assist可接受的OpenAPI子集；仅遍历Schema节点，不删除同名的用户参数（例如名为`propertyNames`或`additionalProperties`的属性）。保持原输入对象不变。
- 递归处理`properties`与`items`，内联本地JSON Pointer引用（`$defs`/`definitions`），32层上限及循环引用退回有界object。合并`allOf`的对象属性与必填成员；`anyOf`/`oneOf`沿Magpie选首个非null分支并保留nullable，类型数组同样投影。字符串const转enum；只保留Google接受的字符串enum。
- 未支持的验证/注释关键词不进入wire，包括`propertyNames`、`patternProperties`、`additionalProperties`、`exclusiveMinimum/Maximum`、`$ref/$defs`、`default/title/format`等。数值exclusive边界转为inclusive上下界并保持已有更严格边界；排他性及其他被弱化的约束仍由原工具执行校验，不能声称投影与完整JSON Schema完全等价。`required`与`propertyOrdering`只引用保留下来的属性。
- Antigravity与Gemini CLI复用转换；Zed Google模型使用同一helper，因此需重建固定插件worker。固定vendor不修改。更新原生来源说明、官方许可清单与桌面内置Agent。
- 回归用工具Schema复现用户两个字段的400，再验证真实driver发送的最终请求不含非法Schema关键词，参数名、工具调用/结果、取消与流式行为仍保持；使用fake transport，不将其描述为真实账号联网验证。

### 其他供应商工具参数核查与补齐

- Native Codex/ChatGPT API Responses与Copilot手选/Auto（Chat、Responses、Messages）的桥接缺少顶层object规则；按Magpie `provider.ObjectRoot`合并对象分支，allOf合并必填、anyOf/oneOf保留共同必填与所有分支属性，差异字段保留嵌套anyOf。本地引用保持有界；工具名称、历史调用/结果和嵌套原始数据不变。不增加400重播或按错误文本猜测能力。
- 固定插件所有Messages入口同样补齐object根；Factory保留固定插件已有的精确包装/解包实现，不能在前置桥接破坏它。Devin和Grok已有ObjectRoot，继续复用；Cursor工具通过原厂目录/动态调用，Claude通过原CLI/MCP桥，保持原协议行为。
- 固定插件的Responses入口（Command Code目录可明确返回此协议、Zed OpenAI模型和Factory等）也使用同一object根投影，包含namespace工具；不得把Responses工具当Chat工具读取。Factory的Messages包装例外不影响其Responses入口。
- Cline/OpenRouter特例：工具Schema位置的oneOf转换为anyOf；不是对整个请求进行文本替换，名为oneOf的参数以及const/default/examples中的普通数据保留。其余Chat渠道没有已确认的限制时保持原Schema，API Key路径不全局重写。
- 核查范围覆盖当前25个注册渠道；按实际协议及固定插件源码记录供应商分组、已有行为与本轮补齐项。DeepSeek/Kimi直连的其他特例若由现有CLI adapter处理，保留其原职责，不向无关OAuth渠道普遍套用。

| 注册渠道                                              | 工具请求兼容规则                                                              |
| ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| Antigravity、Gemini CLI                               | 本轮补受控Google Schema投影，复用原Code Assist转换与流式响应                  |
| Zed                                                   | Google模型复用同一投影；Messages及Responses模型补object根，固定请求封装不变   |
| Codex、ChatGPT API                                    | 本轮补Responses object根和namespace/additional_tools中的函数Schema            |
| Copilot                                               | 手选及Auto的Chat/Responses/Messages补object根，保留原模型分配和输出前重选     |
| BigModel、Z.AI、Command Code、MiniMax CN/Global、Kiro | Messages补object根；Command Code目录中的Responses走对应投影；Go及原厂封装保留 |
| Factory                                               | Messages复用原固定插件包装/解包；Responses补object根                          |
| Devin、Grok                                           | 复用固定插件已有object根与请求转换，不二次包装调用参数                        |
| Cline                                                 | 仅在Schema位置将oneOf转anyOf，保留参数名和普通数据                            |
| Cursor、Claude Code                                   | 分别保持原厂动态工具目录和原CLI/MCP执行边界                                   |
| Qoder/CN、Trae CN/Global、WorkBuddy/AI、MiMo          | 没有确认需要缩减Schema的Chat路径保持原始字段，保留各自原厂请求转换            |

```text
原工具定义（执行期校验 owner 保持）
  → SDK Messages 请求 → Google wire Schema 投影 → Code Assist / Zed Google endpoint
  → 现有模型响应和工具执行
desktop-continuous / web-remote-replayable：仅改变请求格式，不改变会话或凭据 owner
```

### 本机登录与正式发送修复（2026-10-11）

- 用户实测 Z.AI、Codex 能识别本机账号，但发送被 `parseAccountProviderConfigMap` 的旧 `zhipu-account` schema 拒绝。此入口同步整个账号池，因此任一 OAuth 配置可阻断其他账号发送；修复适用于全部渠道。
- Account Overlay 保持原有智谱成员/权益契约；另严格接受 OAuth 的 `group`、`access`、固定占位 `api` 和模型成员。不得通过放宽整个 Provider schema 接受 API Key、动态地址、headers 或个人编辑字段。旧账号载荷仍可解析，现有 API 配置不迁移。
- 账号目录的精确模型规则与同一 revision 的 Provider Overlay 一起序列化、校验和应用；包含容量、输入能力、推理选项与映射。只允许该 OAuth 供应商的目录模型，不接受跨供应商/全局规则。Registry 冻结快照保留这些规则，个人覆盖仍优先。
- 智能恢复的推荐配置同样包含 OAuth 目录规则；不能仅把目录用于执行而让编辑器恢复到缺失能力的通用值。
- UI 选择客户端授权方式后，由唯一“读取客户端登录”按钮调用现有 `accounts.start`。无需补充输入或已具备默认必填输入的方法直接识别；有额外必填字段的方法先填写再提交。读取只由明确点击触发，不在打开弹窗、选择供应商或选择方式时自动扫描。进行中禁用重复提交，取消、Host 切换和失败重试沿用既有 owner。
- 验收覆盖所有已注册渠道的 Host 投影→协议→进程 Registry→请求鉴权；至少包含 Z.AI 与 Codex 同池、旧智谱账号共存、秘密/未知字段拒绝、规则绑定、模型能力/个人覆盖保留以及一次点击读取的浏览器场景。厂商真实账号联网调用与模拟链路验收分别记录。

```text
点击本机登录 → 原 accounts.start → ProviderAccounts 保存连接/读取目录
  → 同一 Account revision（供应商 + 精确模型规则）
  → 原串行同步队列 → 协议校验 → 进程 Registry → 原 request-auth → 模型请求
Desktop continuous / 手机 replayable：均复用同一 Host owner，不另存凭据
```

- 点击添加页的 OAuth 供应商卡片，直接在当前视野打开该供应商专属账号管理弹窗。用户进一步要求已接入的“自定义供应商”点击后与 API 一致在右侧显示账号/模型编辑，不自动打开管理弹窗；两个界面复用同一账号和模型内容，授权表单不追加到添加页长列表底部。
- 弹窗展示供应商名、该渠道账号列表与添加入口；支持连续授权多个账号。成功后弹窗保持打开并刷新同一账号池，不重复创建供应商。已有 API 配置与入口保持。
- 弹窗复用现有 Dialog、移动端滚动区域与字号/主题规范。支持键盘/Escape，关闭或换供应商时先取消当前 pending 授权，取消失败可见且可重试；迟到事件不得创建或显示到另一供应商。关闭后还焦到触发入口。
- `ProviderAccounts` 仍是连接、授权 attempt、凭据代次的唯一 owner；UI 只保留弹窗、表单、选中文件及请求投影。Local Host 设置边界不改变，手机使用所连接 Host 的账号，不访问手机上的桌面应用凭据。
- 文件导入和本机登录是独立来源：前者读取用户所选文件/粘贴内容，后者由选定供应商 driver 在 Host 读取明确支持的应用/CLI位置。保持 Magpie 各渠道的快照或跟随语义，并在入口说明；不在展示渠道列表时批量读取秘密，不把凭据或原文回传 UI。
- 文件导入按渠道支持格式解析，支持多个文件和逐项结果（新增/更新/已存在/失败）；单个失败不吞掉其他成功。每文件不超过4MiB、合计不超过8MiB、最多200个账号；重复凭据去重，账号身份按渠道的稳定账号/组织/工作区组合，不按显示名或刷新 token 作为持久身份。导入继续进入同一个授权/加密持久化路径。
- 原生渠道与固定插件分别核查方法、字段说明、选项提示、默认/条件字段、导入、本机来源、账号身份、刷新、模型目录和正式请求转换；保留实际供应商特例。不能给没有能力的供应商显示假入口。
- OAuth 模型管理不能绕过现有模型测试/可见性编辑能力；多账号的模型权益、优先顺序、账号别名和额度必须有可访问的操作与明确归属。仅对 Magpie 源码实际提供的行为建立对齐项，不复制其整个网关或外部应用。
- 用户明确要求弹窗内可选择模型、重新拉取模型、配置上下文与最大输出；同窗展示账号区和模型区，不需要回到底层长页面。目录刷新更新上游能力，用户模型可见性/上下文/最大输出覆写走既有 Provider Settings 写队列且保留于刷新之后。推理档位从上游受控metadata进入现有选项map，不能只显示选项而实际请求仍使用默认值。
- OAuth 与 API Key 模型复用完整编辑体验：上下文窗口、最大输出Token、交互协议、输入类型、模型能力、按低到高排序的推理等级及推理参数映射。上游目录能确定的值自动填充，手动模型覆写始终优先；缺失能力不冒充已实测。上下文容量与实际输入/输出参数分别生效，跨协议账号池按每次实际目标模型协议做映射。
- 手动新增但尚未出现在上游目录的模型ID可沿当前供应商已授权账号的协议与固定地址调用，由上游验证权益；不得从用户输入构造新地址。已知目录模型仍只路由到声明该模型的账号，禁用账号不参与。协议选择与账号池执行复用同一解析规则。

## 事件顺序

批量导入复用 `startAuthorization`/`getAuthorization`/`cancelAuthorization`，不新增第二套任务owner。方法元数据增加可选 `kind`（browser/local/import/credentials）和 `description`；kind=import 的方法接收 `inputs.files` JSON（`{name,content}[]`），UI通过浏览器文件读取和hook提交，Host不接受客户端文件路径。driver 的可选 `AuthChallenge.completeMany` 返回私有逐项grant；Host逐项保存并将安全 `ProviderAuthorization.results` 投影给UI。新增字段均可选，保留原complete单账号流程。placeholder/defaultValue/condition及选项hint以纯数据进入表单，Host同样验证可见且必填的字段。

账号匹配优先 driver 明确的 `grant.identityKey`，其次有语义保证的 `accountId`；无稳定身份时仅以完全相同凭据识别已存在，不按名字合并。已有连接更新保留 connectionId、启停和用户别名，推进generation并清理旧driver/额度；不同组织或工作区必须由driver生成不同identityKey。

ChatGPT API 的机器 UUID 由 Host 在现有 CredentialService 内独立持久化，并沿用账号存储锁串行创建；授权时由 Host 注入 `inputs.hostId`，覆盖客户端传值，不进入公共账号视图。供应商名称始终来自渠道目录，账号邮箱或别名不得改写供应商名。旧授权没有稳定身份、后续导入补齐身份时，允许通过完全相同的私有凭据升级原连接；两侧已有不同稳定身份则不能合并。

```text
添加页/已接入供应商点击 → UI打开channel专属Dialog
  → hook提交授权/导入/本机方法 → ProviderAccounts创建attempt
  → driver解析与校验 → Host按账号身份保存/更新加密连接
  → 模型目录/账号池/额度派生视图 → 弹窗更新并保留继续添加入口

关闭/切渠道/切Host → 取消attempt → 拒绝迟到写入 → 关闭并还焦
desktop-continuous / mobile replayable → 同一Host owner与凭据代次
```

## 实施前核查记录与实施顺序

以下是源码核查出的差异，完成项须补充证据，不能隐去未完成项：

1. 专属弹窗：现 `ProviderAccountsPanel` 点击仅展开底部内联表单；已有 OAuth 详情同样内联。首先补齐弹窗和连续授权测试。
2. 文件与本机：原生仅单份JSON/token粘贴；缺多格式/批量结果和native本机入口。Codex/Claude/Gemini/Copilot与插件本机语义逐一核对；AG/ChatGPT API不凭空增加本机发现。BigModel/Z.AI原插件本机方法存在，但同时登录两站时无站点选择需要修正。
3. 插件桥接：现映射丢placeholder、选项hint等描述；保留各插件实际方法。vendor保持固定版本，改兼容层后重建worker及来源清单。
4. 原生模型/调用：核对Gemini CLI模型映射、Google tier/onboard回退、Claude目录及账号身份、Copilot CLI/Auto、Codex模板和请求规范、ChatGPT API机器标识与工具过滤。
5. 模型/多账号详情：核对目录编辑与测试、别名、优先顺序、账号范围、推理档位和套餐/并发特例。单个功能尚未接入时如实标记差异，不声称完全等价。

目录fallback不能覆盖先前成功目录；没有旧目录时可显示fallback模型但必须保留读取失败提示。插件sign-in报告只通过Host当前账号/凭据代次提交安全的expired/kept/renewed状态，不把私有响应header发给UI。导入更新已有账号时保留用户启停和别名；取消发生在保存IO期间时撤销新建连接，已轮换并保存的原账号凭据不回滚为失效旧token。

## 原生渠道实施清单（2026-10-11）

- 批量导入由 driver 内的纯解析器和受限并发执行器处理；Codex支持auth.json、CPA/Cockpit、Sub2API、codexbar及逐行refresh token，Claude支持credentials/CPA/Sub2API，Google支持Cockpit/Manager/CPA及逐行refresh token。先验证格式，再逐项通过对应账号登录验证（Claude依源码保留明确身份并由CLI首次使用时续期，不直接请求Anthropic）；单项45秒、总3分钟、4并发；总时限返回已成功项与剩余失败，用户取消拒绝整个未提交批次；重复输入不重复刷新。错误只返回固定安全描述，原始token、文件正文和上游错误不进入结果。
- 本机方法只在用户选择后读取Host上已知位置。Codex使用CODEX_HOME或~/.codex；Claude使用CLAUDE_CONFIG_DIR或~/.claude及macOS Keychain；Gemini使用~/.gemini；Copilot使用编辑器配置或CLI配置/系统钥匙串及正在运行的WSL。AG与ChatGPT API不提供虚构本机入口。每次使用重读当前本机来源，校验仍为授权时的稳定账号；原应用换账号或退出时当前连接明确失效，不把新账号调用归入旧连接。Codex刷新回写原文件，Claude由CLI管理原profile，其余本机源只读。
- 本机源路径由Host计算，客户端不能提交任意路径。跟随信息和凭据只在加密grant内。独立导入不持续跟随源文件；Codex导入会轮换refresh token，界面说明源应用可能需重新登录；不自动改写另一应用当前账号。
- 身份使用供应商的账号/邮箱与workspace、organization组合；Claude登录后从CLI auth status及profile读取身份。没有可确认身份的导入不能用随机bridgeId或token作为账号合并身份。
- Codex目录保留推理档位、service tiers、最大上下文与排序，模板优先instructions_template；请求应用上游支持的tier、工具和历史input规则。ChatGPT API使用Host稳定机器UUID，过滤上游不支持的hosted tools但保留本地工具。
- Google project解析区分current tier与待onboard，AG保留paid/current/无entitlement依次回退和已知project容错；Gemini实验开关统一驱动目录、额度名称及请求model映射。AG目录保留picker顺序、隐藏规则、能力与fallback；真实多档同族ID折叠为一个模型并按effort路由回原ID。公开models.dev补充Gemini窗口/输出及支持的推理元数据，AG自身maxTokens/maxOutputTokens优先且不套用Anthropic直连窗口。Gemini3显式关闭时使用最低合法low档，2.5使用budget=0，不把不支持的max/xhigh直接发成thinkingLevel。公开目录失败保留缓存，不捏造未知上下文或备用Claude alias的档位。
- Claude保留真实CLI桥及工具续接，模型目录从公开模型目录更新并保留离线可用目录；不伪装成账号权益验证。Copilot区分编辑器token交换与CLI直连，提供Auto模型及上游分配/拒绝后重选。
- 所有本机读取通过可注入异步平台适配测试，fixtures只使用临时目录/伪token/模拟命令。没有上游注销或CLI安装隐式副作用；这些如需提供必须独立可见动作。
- 公开目录缺失modalities时保留“未知”，不输出空inputModalities覆盖驱动已知视觉能力或关闭文本输入；只有上游明确给出数组时才投影该数组。

## 验收

- 桌面点击添加页任一OAuth卡片立即出现匹配供应商的dialog；不改变底层页面滚动位置。点击已添加OAuth自定义供应商在右侧展示同一账号池和完整模型配置，导航不弹窗；手机保持可用宽度和滚动区域。
- 同一弹窗连续新增两账号后，两账号均可管理且归于同一供应商；关闭不会删除已完成账号。授权中关闭/取消、取消失败重试、切Host晚到响应有测试。
- 文件多选、合法和非法混合、重复账号、供应商格式不符、文件大小边界、取消、账号身份合并均有fixture；秘密不出现在结果、UI、日志。
- 本机检测用临时目录/模拟OS凭据接口验证Windows/macOS/Linux差异，不能使用真实用户凭据作为自动化测试数据。
- 模型与请求差异用本机Magpie源码和fixtures验证，原有API和多账号回归保持。运行根typecheck/lint/架构、相关包测试和桌面/手机浏览器场景；真实账号未验证单列。

## UI 实现与验收记录（2026-10-11）

以下记录描述首轮弹窗实现；本机一键读取、已添加供应商右侧编辑与正式发送契约修复的最新验收见文末。

- `ProviderAccountsDialog` 统一承接添加页卡片、已有 OAuth 供应商导航和详情的管理入口。账号页连续添加、批量文件/粘贴导入、本机读取、启停、删除、额度展开及授权状态均复用账号服务；关闭 pending 授权要等待取消成功，失败保持弹窗并允许重试。文件内容仅在用户提交时读取，大小限制和固定安全错误在 UI 呈现，渠道格式解析仍由 Host 处理。
- 模型页复用 `InlineEditableProviderCard` 和完整模型配置弹窗；上下文、最大输出、交互协议、输入类型、能力、推理档位及参数映射由现有 Personal Model 保存路径管理。顶部刷新与编辑器的同步模型入口共用当前渠道账号的 `refreshModels` 和安全目录，不向 OAuth 占位地址发送 API key 目录查询。智能恢复与手动新增的生产接线已只读核验，未新增模型状态所有者。
- 服务替换时账号和 Provider Settings 旧视图立即隐藏，授权/导入表单与模型编辑器随之卸载；旧文件读取和旧服务提交函数不能向新 Host 提交凭据。账号事实、模型覆盖及迟到结果仍服从原服务的作用域和 revision 边界。
- 执行 `node --test packages/web/test/provider-accounts.test.mjs`：最终完整运行 **9/9 通过**（61.1 秒）。覆盖 API 入口保留、同窗多账号、已有供应商导航、手机英文布局、取消失败重试和还焦、批量导入混合/重复结果、单文件及总大小限制、读取失败、显式本机读取、切 Host 丢弃迟到文件、传输重试、安全错误、完整模型编辑保存/重开、刷新保留覆盖、模型启停、同步目录使用账号服务、额度入口及授权状态。
- 定向 UI/fixture lint、14 个相关文件格式检查和架构检查通过（0 违规）。实际查看手机授权/导入及手机、桌面模型编辑截图，位于 `.tmp/provider-accounts/`。本记录中的授权、额度与目录验证均使用模拟服务和假数据；未用真实账号登录或真实凭据验证厂商服务。全仓检查结果由集成验收统一记录。

## 集成验收记录（2026-10-11）

- Host账号相关测试48/48：批量部分成功、稳定身份升级、同凭据去重、不同组织及旧workspace身份隔离、取消期间写入、另一Host重新授权后的代次保护、目录fallback、额度与实际账号归属。供应商名称来自渠道，不使用账号邮箱命名。
- 模型映射测试4/4，CLI真实SDK请求测试1/1：默认目录的推理档位排序、Google参数转换、Responses服务档位，以及用户CEL映射/最大输出实际进入请求。账号目录与Personal Model覆盖解析证明刷新保持用户配置。
- 完整native测试64/64、固定插件测试63/63通过；这些是本机fake transport/临时目录验证，不等同于真实厂商账号验证。ZCode本机来源只跟随同一身份续期，跨用户/组织/项目及个人团队切换在上游请求和凭据写入之前拦截并提示重新识别。
- 根目录`pnpm typecheck`、`pnpm lint`通过；`pnpm --dir apps/lcode-cli typecheck`通过27个任务；`pnpm architecture:check --changed`为0违规、0基线、0新增。功能种子图的YAML、唯一ID、边端点/等级及本次源码符号校验通过。
- 最终运行`node scripts/build-auth-plugin-worker.mjs`（495793字节，固定vendor校验通过）及官方`node scripts/licenses.mjs notices`（1242个包版本、14个复制组件、18个原生归档）；`readVerifiedNotices`核验2969个输入通过，另逐项复算2720条复制文件引用/2711个唯一文件的原字节SHA-256全部匹配。最终worker源文件SHA-256为`0fce0c25f913343d43fa9ca6e799b0a9becb90b3a4155d9d0e3228f30b09afc3`。首次生成曾遇Windows文件打开错误，保留原产物并重新执行官方生成后通过；未手工伪造清单哈希。
- 完整供应商行为仍须区分已有公共授权/模型能力与辅助操作：Qoder/Trae/WorkBuddy签到活动、独立账号别名/手动优先级与每账号自选模型范围尚未提供产品命令；不能将本记录表述为Magpie所有界面和网关管理功能已完全等价。

## 本机登录、全渠道同步与右侧编辑验收（2026-10-11）

- 用 Z.AI/Codex 同池载荷复现用户完整 `zhipu-account`/未知 `channelId`、`group`、`api` 报错（红→绿）。补齐严格 OAuth 分支，仍拒绝 API Key、动态地址、headers、个人编辑字段及身份不匹配；旧智谱信封保持兼容。
- 新增真实 Agent `updateAccountProviderConfig` handler 测试及全部25个注册渠道的 Host→安全协议信封→Registry→回环鉴权请求测试，覆盖三种模型协议、模型能力、推理/输出映射、个人覆盖与智能推荐来源；非法目录规则不会提交。Registry 冻结快照和正式同步均保留 `modelRules`。
- 供应商、原生/固定插件、模型映射、SDK实际请求与上述回归合计 **218/218通过**。这些使用临时目录、假凭据和fake transport，不代表逐个真实厂商账号联网实测。
- 浏览器完整 **9/9通过**（79.4秒）；导航场景迁为独立用例文件后定向运行 **1/1通过**。添加页仍弹窗；已有供应商使用真实分栏布局在右侧连续添加账号、启停/删除、查看额度和编辑模型；一次点击本机登录即识别。手机390px布局截图已查看；未读取真实用户凭据。

## 本轮工具参数兼容验证（2026-10-11）

- 已按上表核查25个注册OAuth渠道。原生及固定插件测试 **139/139通过**，包括Antigravity/Gemini真实发送边界与Zed worker的Google Schema、Copilot三种协议、Codex/ChatGPT Responses、插件Messages与Responses namespace、Factory原包装和Cline语法限制。HTTP响应及凭据均为fixture，不代表25家真实账号均已联网实测。
- 根目录和`apps/lcode-cli`的类型检查、Lint通过；CLI类型检查27个任务成功。新增文件定向Lint使用`--deny-warnings`通过；架构检查基线0、新增违规0。
- 使用统计已移除套餐入口和旧回退；API仅统计API Key，OAuth账号分析和额度保留，验证见`oauth-usage-context-trends.md`本轮记录。
- 根`pnpm typecheck`/`pnpm lint`通过；CLI类型检查27任务、CLI lint14任务通过；架构0违规；相关文件格式检查通过。Lint发现浏览器测试超过400行后按场景拆分并复验，不扩大文件行数例外。
- `node scripts/build-desktop-agent-cli.mjs`成功重建并暂存本机win32-x64内置Agent；生成与暂存bundle SHA-256相同，含新增序列化/解析入口。已运行的Agent仍是启动时版本，重启本仓库桌面开发应用后加载新bundle。
- `node scripts/licenses.mjs check`成功（1742个实装包，构建依赖复核18项）；报告20项已登记材料债务，未声称strict零债务检查通过。本轮不修改固定vendor或授权worker。

## 2026-10-12 设置结构调整

OAuth 界面按登录授权 → 模型配置 → 已登录账号拆分；登录和导入只在登录授权页，账号页仅显示相应账号事实及操作。授权中的页签切换保留原 attempt，关闭仍先取消。供应商代理引用与认证出口统一在模型设置的供应商详情中配置，独立代理页只管理代理；模型弹窗随屏幕伸缩。按 [代理与模型设置联动](./provider-proxy-and-settings-layout.md) 验收。此规则替代早期两页签及账号页内含授权表单的布局要求。

三个页签靠左且整体最多 24rem；小屏按可用宽度等分，标签允许换行，以兼容中英文与较大 UI 字号。此项仅改变局部展示，不修改通用 Tabs 组件、授权 attempt 或账号状态所有者。
