# 连接调度首批实现与验证

日期：2026-10-16。基线：`05c9d6e3`。本文件区分已落地功能、实际执行证据和仍未完成的完整 spec 门禁；不把目录里的 96 个计划场景整体标记为通过。

## 已落地的执行边界

| 部分     | 当前实现                                                                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 五种策略 | 可靠优选、主备接管、份额轮转、余量均衡、到期优先；显式 `routing.version: 1` 启用。                                                                                  |
| 兼容     | 缺省或 `routing: null` 继续原 OAuth 成功账号偏好与 API Key 轮换、冷却；策略保存不推进 Key 保存代次。                                                                |
| 配置     | 原 `ProviderSettingsFacade.setProviderRouting` → personal repository；View revision 与文件 membership CAS；全量旧表单保留独立保存的 routing。                       |
| 调度     | `RoutingScheduler.plan/reserve/setPolicy`；只读规划，同步多资源预留；`RoutingReservation.dispatch/cancel/finish/observeUsage`。                                     |
| 状态     | `RoutingLedger`、`RoutingBindings`、`RoutingHistory` 是原 owner 内部的派生状态；没有新增 accepted 队列或持久化用量账本。                                            |
| OAuth    | 原 `ProviderAccounts` 内持有渠道调度器；经能力审核的驱动在增强模式下一次 ticket attempt 至多一个推理 POST，三种协议沿原 loopback/relay 执行；未审核驱动派发前拒绝。 |
| API Key  | 原 `ApiKeyPool` 持有调度器；沿原 Runner admission、物理预算与 SDK 单次 fetch。修改策略继续共用同一 Key 代次的鉴权隔离状态。                                         |
| 用量反馈 | 原票据鉴权的私有 `/v1/routing/usage`；远端反馈绑定原物理 relay request，不能指定其他连接或 grant。                                                                  |
| 协商     | `interaction/providerRoutingCapabilities` 与私有 relay 的 `single-attempt-routing-v1`；旧 Host 收到原形状的 legacy auth 请求，增强配置遇到旧 peer 明确拒绝。        |
| 设置     | OAuth 与 API 详情复用 `ProviderRoutingEditor`；五策略、恢复旧行为、并发上限和缓存模式；中英文、宽屏与手机单列。                                                     |
| 诊断     | 纯计划返回实际策略、排除原因和 fallback；OAuth 响应提供安全策略/原因头；`RoutingError.code` 提供固定原因，不传播上游正文。                                          |

```mermaid
sequenceDiagram
    participant R as 原 Runner
    participant A as 原 API Pool / ProviderAccounts
    participant L as Owner 内部 Ledger + Bindings
    participant U as 上游
    R->>R: 原 admission 与物理许可
    R->>A: 已绑定身份的物理 attempt
    A->>L: 校验策略与全部相关窗口，同步 reserve
    L-->>A: 冻结连接与预留
    A->>U: 单次 dispatch
    U-->>A: 响应头与 body
    Note over A,L: 响应头不能释放槽；取消先关闭 pending read 也不代表底层取消已完成
    A->>L: body/底层取消真正结束，释放物理槽
    Note over A,L: HTTP 200 的逻辑结果仍可未知；未知消费不退回为零
    R->>A: SDK 归一成功/失败、可选 actual usage
    A->>L: 幂等确认结果，修正份额与已知消费
```

## 关键规则的实际实现

- 额度按 resource 与 instance 计量，所有相关窗口取交集；只有明确组织/共享资源 ID 才跨账号共用。显示名称 `pool` 不作为共享身份。
- 支持模型 include/exclude、窗口 kind、稳定 ID、reset mode 和 instance；排除优先。滚动重置提示不生成新账期；重置时间经过不补造 100% 余额。
- 新读数的时间不代表覆盖证明。只有 `coversThroughSeq` 能退休已确认包含的终态增量，在途预留不能被清掉。SDK 用量可先于或晚于物理结束到达，均只结算一次。
- token 轮换与授权身份代次分开：`routingEpoch` 由账号 owner 管理；重新授权或启停推进代次，普通 refresh 保留代次，不能借 token 轮换洗掉旧额度或硬绑定。
- 不可移植轮次从 reserve 起就有临时绑定；所有未派发引用取消后回滚。明确的首次无输出拒绝可以撤销临时绑定，已经形成的工具归属不会因此被清掉。服务端会话绑定跨用户轮保持；旧轮迟到结果不覆盖新轮。
- 没有可证明的 TTL，不假设五分钟或一小时缓存。`AuthModel.routingCacheTtlMs`、`routingPortability` 是驱动可选事实；缓存模式不解除硬绑定。
- 可靠优选无额度/近期样本时回退份额轮转，避免冷启动只使用第一连接；已知坏结果不优先于未探索候选。未知候选的有界探索不会被只读预览推进。
- 份额按工作量借记并接受实际用量修正；大请求产生债务，不成为永久不可分配。缺失用量保持估计，不把工作量子写为 actual Token。
- 到期预测只使用明确 `expiring-balance`、同单位实测消费和足够观测；窗口为 15 分钟、至少 8 个样本、至少 60 秒跨度，预测最长 1 小时。可用余量先扣除已有预留，无正收益时明确回退。
- 用户取消不计入上游失败率。物理 HTTP 完成与 SDK 逻辑结果分开；HTTP 200 JSON/SSE 业务错误不会提前生成成功样本或热缓存。
- 鉴权隔离绑定凭据 generation，额度、工具绑定和模型冷却绑定 routingEpoch/资源；刷新授权不得清洗其它状态。相关反例先失败，再修复通过。
- `AuthDriver.routingSingleAttempt` 与上下文标志共同约束真实驱动。OpenAI/Copilot 的增强请求关闭 401 重发，Copilot Auto 关闭拒绝后隐藏重选，owned-driver 保留能力；legacy 继续原恢复行为。Google 原推理出口只有一次 POST。Claude CLI 与未认证插件不冒充单次尝试支持。

## 测试先行证据

本轮先运行新增测试得到失败，再实现相应路径。除初始导出/配置失败外，实际反例包括：

| 反例                                   | 修复后断言                                          |
| -------------------------------------- | --------------------------------------------------- |
| 两次并发各取 60，余额只有 100          | 只允许一份预留；取消前不允许重复分配。              |
| 不同账号使用同一组织池                 | 不能绕过同一窗口余额。                              |
| 周窗充足、短窗为零                     | 短窗阻止准入，不能由周窗抵消。                      |
| 只有替代连接有新读数                   | 可在明确收益达到阈值后离开旧缓存。                  |
| 同一轮并发预留、旧轮迟到完成           | 不拆散硬绑定，不覆盖新轮缓存。                      |
| 保存策略、Key 曾经鉴权失败             | 保留失败隔离和原 Key 保存代次。                     |
| 同一个策略连续保存                     | 第二次使用已提交 revision，不制造自冲突。           |
| 其他窗口更新配置后提交旧草稿           | 显示冲突，未写入；重新载入后可保存。                |
| 取消与响应头同拍 / pending read 先关闭 | 仍等底层 cancel 完成后才归还槽。                    |
| HTTP 200 结束但 SDK 结果未知           | 不生成成功率或热缓存；晚到失败可确认原尝试。        |
| OAuth 驱动内部 401/Auto 重选重发       | 增强模式一份许可只有一次推理，legacy 恢复行为仍在。 |
| 冲突重载还留着旧并发与缓存字段         | 重载完整权威配置，防止新 revision 覆盖旧草稿。      |

可复现入口：

```text
pnpm test:provider-routing
pnpm test:provider-routing-ui
pnpm typecheck
pnpm lint
pnpm --dir apps/lcode-cli typecheck
pnpm --dir apps/lcode-cli lint
pnpm architecture:check --changed
```

实际结果以收尾记录为准，不读取真实凭据，不请求真实厂商推理。Node 测试包括真实 SDK generate/stream、真实 loopback HTTP、双向 RPC、quota/身份/取消回归以及原十万 Key 选择、Settings RPC 与冷启动回归。浏览器在 1280 中文暗色、390 英文亮色下验证五种策略、重复保存、冲突恢复和恢复 legacy；检查无横向溢出，截图保存在 `.tmp/provider-routing-ui/`，可由测试重建。

### 本轮执行结果

| 命令/检查                             | 本轮最近一次结果                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test:provider-routing`          | **269/269 通过**，包含策略/配置、真实 SDK 与 HTTP 请求计数、双向 RPC、原生驱动单次推理、额度、取消和原十万 Key 回归。                                                                                                                                                                                                                                                                   |
| `pnpm test:provider-routing-ui`       | **2/2 通过**，各场景实际操作五种策略、重复保存、revision 冲突与 legacy 恢复；截图已查看。                                                                                                                                                                                                                                                                                               |
| `pnpm lint`                           | **通过**；任务外的额外格式化已按 HEAD 的精确 formatter 输出比对撤销，保留并行代码改动。                                                                                                                                                                                                                                                                                                 |
| `pnpm --dir apps/lcode-cli lint`      | **通过**，14 个任务成功。                                                                                                                                                                                                                                                                                                                                                               |
| 路由改动文件的 root/CLI 格式检查      | **通过**，分别使用各自配置与 formatter。                                                                                                                                                                                                                                                                                                                                                |
| feature graph                         | **通过**，节点 ID 唯一、149 条边端点/rank 有效、5 个路由种子文件与符号存在。                                                                                                                                                                                                                                                                                                            |
| `pnpm typecheck`                      | **未通过**：并行 sidebar/project/worktree 代码的 executionSet 联合类型、i18n key 和可空 task ID 错误（`useSidebarOrganizationCatalog.ts`、`SidebarProjectEntry.tsx`、`SidebarUnavailableEntry.tsx`、`useUnifiedSidebarProjection.tsx`、`WorktreeSettingsProject.tsx`、`DraftWorktreePreparation.tsx`、`ProjectWorktreeList.tsx`）；详见当前日志。较早 archive.ts 错误已由后续改动消除。 |
| `pnpm --dir apps/lcode-cli typecheck` | **未通过**：并行新增 `admission-project-context.test.ts` 从 core 实现目录导入而越出 bootstrap rootDir；`protocol-execution-set.ts:32` 的协议方法尚未被类型接纳；`worktree-execution.test.ts:45/57` 的可空 binding owner。此前较早检查曾通过，不据此覆盖本次失败。                                                                                                                       |
| `pnpm architecture:check --changed`   | **通过**：violations 0、baseline 0、new 0；此前并行 worktree 循环边已由后续改动消除。                                                                                                                                                                                                                                                                                                   |

仓库级类型失败来自当前并行改动，保持原样；不能写成整仓全部检查通过。上述 TypeScript 错误路径及对应改动不属于本次路由提交。`provider-node` 与 CLI adapters 另行实际执行 `tsc --noEmit` 均通过。检查日志位于 `.tmp/provider-routing-*.log`。

浏览器回归在移动端曾有一次等待冲突提示超时；加入 fixture 调用记录诊断后，连续两次宽屏/手机回归均通过。未增加固定 sleep 或放宽原超时，保留诊断用于再次复现。

## 完整 spec 尚未达到的门禁

1. **大规模增强索引与 continuation**：原 legacy 十万 Key 路径保持原索引和常数时间选择；增强核心目前按候选快照计算、排序，尚不是完整 spec 要求的增量索引。不能宣称 PRS-091 的增强十万候选性能已通过。
2. **完整设置与诊断表面**：order、weights、soft/hard reserveRules 已有 schema、调度与保存契约；当前基础 UI 尚没有连接排序、份额、保留线编辑器和完整最近决策面板，不把这些 UI 场景标记为通过。
3. **更完整的策略质量模型**：当前余量使用瓶颈压力分档，未完成所有其余窗口向量、近期工作半衰期、预测范围和缓存经济成本的完整回放门禁；长期未覆盖增量与 attempt tombstone 的容量治理仍需专门验证。
4. **厂商事实与环境覆盖**：不臆造价格、缓存 TTL、扣减归属和覆盖水位；只有驱动实际提供相应事实时才使用。Claude CLI 与未声明单次推理能力的插件目前只能用 legacy，启用增强配置会明确拒绝。真实供应商与 macOS/Linux 未实测；Windows fixtures 与浏览器验证不能代替这些环境。

因此本次交付是五种策略的显式执行接入与基础设置，尚不等于 S4 全部完工或 96 个计划场景全部验收。后续应保持上述门禁，不通过删掉规格要求来掩盖缺口。
