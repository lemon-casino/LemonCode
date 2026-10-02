# 工作流观察工具卡的会话协议兼容性

## 问题与产品规则

`ListWorkflowRuns` 的 CLI 输出与工具卡契约已包含修订关系 `resumedFrom`、
`supersededBy`，但 V4 shared 的 strict 卡片 schema 未声明它们。包含这类卡片的
在线帧、历史快照和强制恢复快照都会被拒绝，最终显示
`fault.subscription.recoveryFailed`；重复连接不能修复相同的非法快照。

1. V4 `list_workflow_runs` 卡片的 run 行接受两个可选、非空字符串字段，语义与
   CLI `ListWorkflowRunsRunSchema` 相同；行与卡片仍采用 strict 校验。
2. 保留修订关系，不丢弃工具卡、行或消息来换取恢复成功。
3. 旧记录缺少两个字段时继续有效；空值、错误类型和其他未知字段仍拒绝。
4. `ToolCallRow.display` 与 `ToolCallRow.output.display` 使用同一契约。
5. 读取历史时通过现有存储 codec、transcript 合成与 ProductProjection 路径恢复；
   无数据库迁移、历史重写、额外缓存或新的重试分支。
6. 工作流实时节点新增可选活动、等待摘要与结算源时间，CLI 观察工具的当前 ask 复用同一摘要。`node-activity` 仅是观察，不改变生命周期、预算或交付计数。`occurredAt` 来自同一条 journal 记录的 `timeCreated`，live 和冷回放一致；旧记录缺失时保持未知，不能用恢复时刻补齐。
7. 新摘要使用严格、有界字段校验，旧快照缺新字段有效；旧 strict 消费者不保证接受新增字段，需分别验证桌面和手机托管资源，不用未知字段剥离代替同步契约。
8. 连续与可重放投递均覆盖活动中、退避、成功恢复、停止、重试代次、迟到/重复以及完整/分片帧。恢复不重新统计已知用量，不刷新源活动时间，不静默恢复任务。
9. 准入 `queue` 与 provider `wait` 分开；CLI 当前 ask 增可选 `phase/queue`，扁平工具卡镜像为 `askPhase/queue`，actor 层可选 `lastDeliveredAt` 保留最近真实非缓存成功交付。coarse 七态不扩枚举，queued/dispatched/paused 用 waiting 并由具体 phase 解释；旧记录无 phase 时不能根据 journal running 推断 executing。
10. 新字段同步 CLI Zod 3、shared Zod 4、输出投影及模型文本/GUI 读面；验证交接包含缺字段旧记录、非法 blocker/时间、等待同时工具活动、连续 ask 交付、暂停重试和双交付模式。本轮用户自行验证，新增场景只补用例不执行。

## 所有者、边界与顺序

- DynamicWorkflowRunService / journal 仍唯一持有 run 与修订关系。
- CLI 工具契约声明输出；ProductProjection 唯一持有派生会话快照。
- shared V4 schema 是跨进程消费契约；renderer assembler 仍原子、严格接纳帧。
- 订阅 ownership、logEpoch、seq、revision、logical frame ordinal 与幂等语义不变。

```text
journal → ListWorkflowRuns → CLI display / persisted metadata
                                 ↓
live event ─────────────────── ProductProjection ← transcript hydration
                                 ↓
desktop: continuous → initial / online ──┐
                                         ├→ strict shared schema → client view
mobile: replayable → initial / recovery ─┘
```

## 手机端发布边界

手机页面由 Worker 的 `public` 静态资源独立托管，不使用桌面安装包内的 renderer。
因此桌面安装包升级不代表手机消费契约已经升级；同一任务在旧手机页面仍可能因
strict schema 缺少修订字段而恢复失败，重新连接不能替代静态资源更新。

共享协议修复后，以 `LCODE_ENV=production pnpm build:mobile-web` 重新构建
`packages/web/dist` 并同步到 `cfworker-remote/public`。本地验收检查实际打包的
run 行契约包含两个可选修订字段、仍保留 strict 校验，且 Worker 产物不包含
sourcemap。线上生效还需独立发布 Worker 静态资源；本地构建不得自动部署。

## 验收

1. CLI 合法卡片含前驱、后继或两者时，shared 行与 output 契约逐字段保留。
2. 不含修订字段的旧卡片有效；空字符串、非字符串、未知字段无效。
3. 工具完成 live delta 与含相同 metadata 的冷恢复快照均有效，修订字段不丢失。
4. 相同投影经 initial、online、recovery 编码/重组都有效，完整帧与分片均覆盖；
   桌面 continuous 和手机 replayable 使用同一事实，但不改变各自投递语义。
5. 用户问题会话的现有记录只读重建通过完整 snapshot 校验，无需修改数据。
