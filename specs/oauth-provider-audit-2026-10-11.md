# OAuth登录、模型调用与额度核查

范围为ProviderAccounts当前25个注册渠道。基线：Magpie `93c5d846ca2b05ac8ca961956304104e5d112845`，固定插件 `da7e2f67a5c7c2fe2ca776156d08ce2f144e86dd`。本轮规则见`oauth-provider-details.md`；具体额度字段继续以`oauth-account-quotas.md`为准。用户自行构建。

## 核查结论

- 实际driver方法元数据25/25可读取，方法ID唯一；方法查询0网络请求，没有执行授权或读取真实账号凭据。所有渠道沿原native/fixed plugin模型及额度接口，不新增第二条调用路径。
- 已补齐Copilot editor模型API的版本头（GitHub额度接口与CLI/Auto保持各自协议）；Claude导入保留字符串及数组scopes。均先以失败fixture复现再修复。
- 其余渠道结合原生/固定插件实现及既有fixtures未发现本轮需要新增的登录、模型调用或额度处理。无可读额度契约的ChatGPT API明确不支持；Zed仅有账期信息时不能假造数值余额。
- 以下只覆盖登录、模型调用、额度；不将Magpie签到活动、余额预测或网关管理等操作宣称为本轮功能。自动化fixture与真实账号验证分开，尚未逐家真实账号联网验证。

| 渠道           | 登录与导入                         | 模型调用边界                                          | 额度                                    |
| -------------- | ---------------------------------- | ----------------------------------------------------- | --------------------------------------- |
| BigModel       | 浏览器、本机ZCode、Coding Plan Key | 区域/团队凭据与Messages；切身份需重新检测             | Coding/Team/Start/gift桶                |
| Z.AI           | 浏览器、本机ZCode、Coding Plan Key | 与BigModel站点及账号隔离                              | 同上，账号独立                          |
| Codex          | 浏览器、文件、本机Codex、JSON      | 专用Responses、账号ID、输入/工具历史、刷新写回        | 主/次窗口、Credits、重置券、花费限额    |
| ChatGPT API    | 浏览器、JSON                       | 动态客户端、Host安装身份、Responses                   | 明确不支持                              |
| Copilot        | 设备授权、本机编辑器/CLI、Token    | 三种模型协议与Auto；补editor版本头                    | Chat/Completion/Premium、SKU            |
| Gemini CLI     | 浏览器、文件、本机CLI、JSON        | 项目、层级、实验模型ID、Code Assist、Google工具Schema | 模型buckets与重置                       |
| Antigravity    | 浏览器、文件、JSON                 | 独立client、Code Assist、目录模型ID与工具Schema       | 模型/共享池分开、部分成功               |
| Claude Code    | 浏览器、本机CLI、文件、JSON        | 隔离CLI profile、MCP续接；补字符串scopes导入          | 本账号固定CLI `/usage`                  |
| Cline          | 浏览器、Key                        | 固定OpenRouter、会话头、工具转换、oneOf特例           | Pass窗口、Credits                       |
| Command Code   | 浏览器、本机CLI、Key               | 目录选Chat/Responses/Messages及Go原厂协议             | 5h/周、Credits                          |
| Cursor         | 浏览器、本机cursor-agent、Token    | 固定HTTP/2动态工具、错误与取消                        | Cursor/Other/Total、On-demand、Grok Bot |
| Devin          | 浏览器、本机CLI                    | 原厂protobuf、工具object根                            | 日/周、ACU、额外余额                    |
| Factory        | 浏览器、Key、文件                  | 原厂模型wire、精确工具包装/解包                       | Standard/Core窗口、额外余额             |
| Grok           | 浏览器、本机指定profile            | CLI签名与工具转换，profile隔离                        | Credits、On-demand、已观测限速          |
| Kiro           | 浏览器、本机CLI/IDE、凭据          | 原厂协议、刷新写回、每账号worker隔离                  | 月度Credits、Free trial                 |
| MiniMax CN     | 浏览器                             | 固定大陆授权/模型端点与工具wire                       | M Plan interval/week、积分              |
| MiniMax Global | 浏览器                             | 固定国际授权/模型端点与工具wire                       | 同上，区域隔离                          |
| MiMo           | 浏览器                             | App原厂请求与刷新                                     | 周额度、可用Token Plan                  |
| Qoder          | 浏览器                             | 全球区域请求与目录                                    | 个人/附加/组织/专用余额                 |
| Qoder CN       | 浏览器、企业VPC                    | 大陆及VPC表单/端点校验                                | 同上，企业未知数值不补零                |
| Trae CN        | 浏览器                             | 大陆请求与刷新                                        | 积分用量/限额/重置                      |
| Trae Global    | 浏览器                             | 原账号区域请求与刷新                                  | basic/bonus美元额度                     |
| WorkBuddy      | 浏览器、本机桌面                   | 大陆请求、目录及本机账号来源                          | 完整资源包Credits合计                   |
| WorkBuddy AI   | 浏览器、本机桌面                   | 国际请求与区域隔离                                    | 完整资源包Credits合计                   |
| Zed            | 浏览器RSA回调                      | Google/Messages/Responses各自wire与工具转换           | 已知套餐/账期，数值未知不造额度         |

## 交付边界

- 原生与固定插件兼容回归 **141/141通过**，包含本轮Copilot版本头和Claude scopes新用例；既有登录/本机/导入、刷新/多账号、目录/工具/实际vendor请求、额度/取消/并发fixtures继续通过。15个固定包21个源文件原始SHA与manifest一致，pin未改变。
- 统计SQLite/协议/服务 **12/12通过**，浏览器 **8/8通过**；根目录及CLI类型检查、Lint、架构检查通过。均为本地fixture，未读取真实用户授权文件或逐家真实账号联网调用。

删除供应商/账号不触碰CLI调用账本；历史连接ID和调用分析保留，实时额度只查询当前存在的账号。本轮不执行应用、Agent或固定worker构建。原生适配源码更新后，用户构建前应按现有流程执行`node scripts/licenses.mjs notices`更新来源清单；不手工改哈希绕过新鲜度检查。
