# OAuth 账号额度查询与展示

2026-10-11 用户在上一阶段完成后明确选择“完善各供应商额度查询与展示”。本规格补充 `oauth-usage-context-trends.md`，本轮聚焦额度读取与呈现。

## 产品规则

- 所有已登录账号沿用 `ProviderAccounts.getQuota`，按 connectionId 独立查询、缓存和刷新。现有 API 配置及本地 Token 账本保持原所有权。日期与模型筛选不改变当前套餐额度；供应商/账号筛选决定显示及批量刷新的账号范围。
- 概览总刷新必须显式刷新当前筛选的账号额度，额度区另提供独立的“刷新额度”操作。单卡刷新继续有效；统计查询失败不阻碍额度刷新。刷新期间显示各账号状态，一个账号失败不阻断其他账号。切换筛选或服务后，旧响应不得回填新范围。
- 额度窗口同时展示可用的百分比、厂商说明、数量/限额/单位与重置时间，不能因存在百分比就隐藏金额或数量。仅已用或仅限额已知也保留对应事实；已用与剩余明确标识。额度池和模型名可见，同名窗口不能丢失归属。
- 厂商原始缺失字段不解释为 0% 已用、100% 剩余或 $0。真实数值 0 必须保留。固定插件快照保持 pinned：Factory/Cline/Cursor、Grok/Kiro、WorkBuddy 双区域、BigModel/Z.AI、Trae 双区域的默认数字问题在本地 quota 兼容层修复，仅从同一次已知额度请求的响应读取白名单数字事实，不额外发送请求、读取授权响应或回传原始响应。BigModel/Z.AI 明确返回 usage=0 的无限额契约和 Devin protobuf 省略零值的耗尽契约保留，不能全局删除零值。
- Codex/Copilot/Gemini/Antigravity 使用已有厂商额度接口；修正有效重置时间 fallback，保留套餐与额度窗口信息。Antigravity 读取模型额度和共享池额度，单个接口失败时显示仍成功获取的部分并标明不完整；全部失败返回错误。不能把模型额度和共享池相加成总量。
- Codex 只读展示已返回的重置券数量、有效期和工作区个人花费限额，不增加兑换行为。Copilot 按真实 SKU 呈现套餐，token-based billing 不标为请求次数；unlimited 快照的 entitlement/quota_remaining 占位值不展示为真实数量或零限额。Antigravity 已识别 quotaInfo/bucket 中缺少 remainingFraction 表示耗尽的上游合同保留，不能扩大到 Gemini 或无额度结构的未知对象；共享池 bucket 须有有效窗口标识、额度比例或重置时间，空对象/非对象不能生成耗尽窗口。
- Claude 按本机 Magpie 的固定 CLI `/usage` 路径补齐订阅额度，复用本账号隔离 profile；只执行固定只读用量命令，不通过普通模型生成推算额度。解析失败、CLI 不可用或不支持时显示明确状态，不能显示零额度；操作须可取消、超时有界，输出不进入日志或 UI。刷新后的凭据仍由现有 CAS 接口提交。
- ChatGPT API、Zen Free 等没有可读额度契约的渠道保留“不支持”，不得为补齐界面伪造接口或余额。其余固定插件沿用自身 usage hook，经共同白名单投影。更新完整渠道支持矩阵并以本机源码与自动化 fixtures 为证据，真实账号验证另行注明。

## 所有权、接口与顺序

`ProviderAccounts` 继续唯一管理账号/凭据代次；`ProviderAccountQuotas` 唯一管理额度缓存和在途读取。Driver 只负责厂商读取与兼容，Host 负责标准化安全 DTO，UI hook 只保留请求状态和刷新信号。新增 DTO 字段必须 optional，保持旧服务快照兼容。批量刷新不建立第二份额度缓存。

共享窗口增加可选 `remaining` 数量、ISO `expiresAt`（额度或重置券有效期，与重置时间独立），额度快照增加可选 `partial` 标识、ISO `planExpiresAt`、`renewal: auto | off`。Host 在部分额度接口失败而另一部分成功时标记 partial，包括插件返回 error 且带当次有效额度的情况；更新失败时保留的旧数据继续独立标记 stale。套餐账期本身不代表已知额度，也不据此构造百分比。CLI 输出与私有账号标识不加入 DTO。

```text
筛选下的总刷新 / 单账号刷新
  → UI hook（服务实例 + connectionId + 刷新代次）
  → ProviderAccounts / ProviderAccountQuotas（账号锁、代次校验、同账号合并）
  → Driver quota（当前 grant；取消信号；固定额度接口或 CLI /usage）
  → 本次额度请求数字事实校验 → Host 白名单 DTO
  → 单账号卡片（完成/部分成功/未知/失败/过期）

删除/停用/换服务 → 旧读取取消或失去提交资格 → 晚到结果丢弃
```

继续保留现有 60 秒缓存、30 秒读取超时、失败时同代账号旧额度提示。Desktop 与 Web 通过同一服务/DTO读取，Main 和 relay 不增加业务状态。额度查询不改变会话运行、队列、模型选择或账号自动切换策略。

## 验收

1. 总刷新与额度区刷新向当前账号发送强制额度读取；统计失败仍可刷新。筛选外账号不额外查询，重复点击不会造成同账号并发上游读取。
2. 同名账号/额度池可区分；金额/数量和百分比同时可见；只有一个已知数量字段不会整体显示未知；手机不产生页面横向溢出。
3. 上述八组插件缺失、null、非法数字与真实零分别验证；不同账号和并发查询的数字事实不能串用，模型调用响应不进入修复路径。
4. Copilot 无效/零窗口时间正确使用根重置日期；Google 套餐、模型与池额度不重复求和，部分失败有提示，全部失败不显示为余额零。
5. Claude 固定命令、隔离账号、正常/未知输出、异常退出、取消/超时与进程释放均通过 fixture；不泄露 CLI 原文、凭据或账号私有字段。
6. 根目录 typecheck、lint、架构检查、额度相关测试与浏览器 E2E 必须实际执行；更新后的打包 worker 与复制代码清单哈希一致。

## 渠道支持矩阵

以下覆盖当前 `provider-auth/native.ts` 与 `plugins/catalog.mjs` 中全部 26 个渠道。能力来自本机 Magpie、固定插件源码与本地 fixtures；“可读”不表示已用真实账号在线验证。没有返回某字段时保持未知。

| 渠道 ID                               | 当前可读额度与说明                                                                                                                             |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `codex`                               | 主/次速率窗口、Credits 余额或无限额度；重置券数量及可用券最近有效期；上游返回时展示个人工作区花费限额。详情失败保留已有数量并标记部分成功。    |
| `chatgpt-api`                         | 暂无额度读取契约，明确显示不支持。                                                                                                             |
| `copilot`                             | Chat、Completions、Premium 窗口，套餐 SKU、重置时间与可用数量；支持共享 Premium 池耗尽语义；无限额度不显示占位零限额，Token 计费不标作请求数。 |
| `gemini`                              | Code Assist 模型 buckets、比例与重置时间、已知套餐；去重模型并排除 `_vertex` 条目。                                                            |
| `antigravity`                         | 模型 quotaInfo 与共享池 buckets 独立显示，附套餐；任一读取失败保留另一侧并标记不完整。                                                         |
| `claude`                              | 本账号隔离 Claude CLI 固定 `/usage`：当前会话、周及模型范围窗口与时区重置时间；CLI 不支持/无有效额度/失败分别呈现。                            |
| `bigmodel`、`zai`                     | Coding Plan、Team、Start Plan/gift 桶，比例或限额/剩余/已用，套餐到期与续订信息；明确 usage=0 表示无限额。                                     |
| `cline`                               | ClinePass 五小时、周、月窗口及 Credits 余额/用量；Pass 接口 404 表示无该计划。                                                                 |
| `commandcode-plan`                    | 五小时/周 used-cap 窗口、Credits 余额、套餐到期与续订；订阅读取沿用插件自身缓存。                                                              |
| `cursor`                              | Cursor/Other/Total 池、On-demand 美元用量/限额，以及接口可用时的 Grok Bot；缺失比例/金额不显示假零。                                           |
| `devin`                               | 日/周剩余比例、重置时间、ACU 数量与额外余额；保留 protobuf 省略零值的语义。                                                                    |
| `factory`                             | Standard/Core 五小时、周、月比例及额外用量余额。                                                                                               |
| `grok`                                | 周期 Credit 比例、On-demand 限额，以及已有 429 产生的限速窗口；依赖授权时指定的 CLI profile。                                                  |
| `kiro`                                | 月度 Credits 与有效 Free trial 的用量/限额。                                                                                                   |
| `minimax-code`、`minimax-code-global` | M Plan 模型组 interval/week 剩余比例或明确 status=2 耗尽、积分余额及到期。                                                                     |
| `mimo-app`                            | App 周额度与重置日；存在时展示 Token Plan 额度、到期和续订。                                                                                   |
| `qoder`、`qoder-cn`                   | 个人、附加、组织共享、专用余额池；Enterprise 仅套餐时不推导额度。                                                                              |
| `trae-cn`                             | 积分用量/限额与重置时间。                                                                                                                      |
| `trae-global`                         | basic + bonus 美元用量/额度，沿用账号区域。                                                                                                    |
| `workbuddy`、`workbuddy-ai`           | 所有资源包的 CycleUsedCapacity/CycleTotalCapacity Credits 合计；不能以窗口条数上限截断计费包。                                                 |
| `zed`                                 | 上游仅提供套餐/账期时显示这些事实，数值额度仍未知；无效或过期发票按读取错误处理。                                                              |
| `opencode-zen-free`                   | 暂无数值额度契约，明确显示不支持。                                                                                                             |

## 实施与验证记录（2026-10-11）

- Shared 保持同一个严格额度 DTO，新字段均可选。Host 仍是缓存与在途请求的唯一所有者，保留账号代次校验；部分成功替换为本次已知数据，后续整体失败回显这份数据及其账期、partial 标记，并独立标记 stale。
- 插件兼容层位于 `plugins/quota-facts.mjs`、`quota-fact-rules.mjs`，仅在当前 quota 操作的 AsyncLocalStorage 范围观察现有成功响应的读取，按精确端点白名单投影数字；不新增网络请求或改动 pinned vendor 源码。
- UI 通过既有 service hook 消费 DTO 和一次性刷新代次；总刷新、当前额度刷新和单卡刷新均覆盖，账号目录 revision 不会重复消费强刷。展示经过桌面深色、手机浅色截图检查。
- `pnpm typecheck` 最终通过；首次发现 Claude 输出解析使用 `findLast` 不兼容消费包的 ES lib，替换为保留相同语义的倒序查找后通过，未调整编译目标。
- `pnpm lint`、`pnpm architecture:check --changed` 通过，架构违规为 0；本轮相关文件定向格式与 diff 检查通过。
- Host 额度归一化与缓存测试 **24/24** 通过；原生授权模块含新增额度 fixtures **27/27** 通过；`packages/web/test/usage-analytics.test.mjs` **5/5** 通过，包含当前筛选强刷、统计失败/加载时独立额度刷新、真实零值、部分成功与手机布局。
- 插件测试 **48/48** 通过，包含固定 worker 的实际额度 hooks、缺失/null/非法/真实零、地区渠道、取消与并发隔离、超过 100 个资源包的完整合计。打包 worker 已重建，vendor manifest 校验通过；`node scripts/licenses.mjs notices` 全量生成成功，`readVerifiedNotices` 验证全部 2945 个输入，2696 个 copied 文件的原始字节 SHA 也逐项一致，新增原生源码均已进入清单。
- 自动化使用本地模拟 HTTP 服务、固定插件与模拟 CLI；尚未用真实供应商账号、真实 Claude CLI 版本在线实测。额度端点的账号权限或后续变动仍可能返回未知/不支持/错误状态。
