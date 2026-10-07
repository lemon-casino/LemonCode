# 工作树运行环境受信维护（P4-05 / M5-01）

## 所有者与边界

Host worktree owner 唯一拥有 binding 状态及 restore 编排；runtime-environment owner 唯一拥有环境和 consumer。CLI SessionStore 唯一拥有持久 session binding，resident pool 只持运行态。维护不 hydrate、不调用模型、不改 session identity、parent、bindingOwnerTaskId、remoteSessionId、消息或历史 binding。

`session/worktreeRebind` 只由受信 Host maintenance 通道调用。公开参数为 `LCodeSessionWorktreeRebindParams`：executionBindingId、originWorkspacePath/Identity、workspacePath/Identity、完整 oldEnvironmentRef/newEnvironmentRef；结果为 `{ sessionIds }`。服务入口为 `rebindWorktreeSessions({ ...hostTarget, rebind })`；Host routing 字段不得进入严格 wire scope。

```text
Host binding.restoring（禁止 writer）
  → CLI 查询所有 matching latest runtime/worktree_binding（含 archived / hidden / fork）
  → 校验全部 resident scope / ref / idle，关闭并失效 resident
  → SessionStore BEGIN IMMEDIATE，重新查询并整批 CAS oldRef → newRef
  → Host authority.migrateSessions(sessionIds)
  → Host binding.ready
```

查询同时核对 binding、源 scope identity 和执行 scope identity；identity key 始终 `identity?.trim() || path`。相同路径的其它远端 identity 不得迁移。最新 binding 依照 time_created、rowid 排序；旧 entry 保持不变。完整引用按 environmentId、revision、manifestDigest 比较。已 new 为幂等成功；同 scope 的缺引用、未知引用或 session 行与 binding identity 不一致均拒绝，事务全部回滚。只更新最新 entry 的 environmentRef，不放宽普通 restore 的 stale 检查。查询与 CAS 之间出现新记录须拒绝整批提交，以免漏关 resident。无需数据库 schema migration。

resident 全部预检后才关闭；running/待确认/收尾/已接受 command 任一阻塞则不关闭、不写库。关闭完成前不得将旧对象继续留给 restore。SQL 再次校验消除预检与提交之间的持久化竞态；维护可用同参数重试。维护没有 conversation stream；desktop-continuous 与 web-remote-replayable 均从同一持久 owner 冷恢复新引用，不重放旧 resident。

## 准备与恢复

显式 managed worktree 请求在 worktree/prepareExecution 之前调用 Host runtimeEnvironment/capabilities，要求 managedEnvironments、protocolVersion=1，及 prepare/resolveContext/retainSession/releaseConsumer actions。缺能力或方法即失败，无 inherit/local fallback。已冻结 execution.environmentPolicy 原样传给 worktree prepare。CLI runtime/capabilities 只报告 CLI 自身能力，不宣称自己是 Host 环境 owner。

普通 restore 校验 binding ID、原 scope、执行 scope、完整环境引用；不允许将 stale 引用改成 Host 最新引用。旧记录无 environmentRef 时即使 Host binding 有新引用也不能隐式升级，不发送 resolve/retain。

Host checkout writer 的 attached 执行 scope 与请求路径相同也须校验 binding.ready；deleting/restoring 均拒绝。无 binding 的普通 local checkout 保持现有行为。

## 验收

- 真实 SQLite：多会话/archived/hidden/fork 一次迁移，保留 child owner 与全部 identity，已 new 重试幂等，latest-only。
- 同路径不同 identity 隔离，session 行与 latest binding scope 不一致失败，缺/旧第三方 ref 或摘要不符整批回滚；模拟提交中失败仍回滚。
- resident：busy/交互/accepted command 拒绝且无部分 close；idle 先 close 后 CAS；无 hydrate/model；query/CAS session 集合竞态失败。
- prepare：managed capability 调用先于 prepare、冻结 policy 透传、缺协议/缺 action/缺方法拒绝；inherit 不查询能力。
- restore：错原 identity、错执行 identity、stale digest 拒绝；旧无 ref 不 retain、不升级。
- 严格 maintenance/runtime schemas 拒绝未知字段；Host writer 同路径 binding 非 ready 拒绝，普通 local 不受影响。

## MCP stdio 冻结环境（M2）

App 复用同一 Host overlay resolver 与 process consumer，不创建第二个 MCP pool。McpPort 装饰器位于 bootstrap 装配边界，覆盖默认 adapter、直接注入端口及 factory 返回的 session lease。每个启用的项目 stdio 配置以实际绝对 cwd（配置 cwd 相对本次 workingDirectory）向 Host 查询；路径包含关系、binding/identity、完整环境引用与 maintenance fence 仍由 Host 唯一裁决，失败不回退宿主环境。HTTP/SSE 不注入项目环境，官方鉴权保持原链路。宿主声明 builtin 且使用固定绝对 executable 的运行器属于应用工具，保留其内部 Helper Node 与独立环境。

冻结 overlay 随宿主内部配置进入真实 adapter/pool，并在每次 transport.start（包含 auto probe sibling、正式握手、断连重连/恢复）之前重新授权；不能只装饰正常 connect。请求 env 可增加普通插件变量，但不可覆盖冻结 set、恢复冻结 unset，Windows key 按大小写无关规范化，PATH 只有一个有效值。overlay.base/unset 在最终 spawn 环境生效，SDK 默认继承也不能复活已删除变量，不修改 process.env。连接身份含冻结配置、environmentId/revision/manifestDigest；绑定 app consumer 的托管 stdio 不跨 app 共享其授权闭包，仍使用既有 pool。

```text
McpPort.connect/configure → 每配置实际 cwd → Host resolver / app consumer
  → 带冻结引用与 overlay 的配置 → 既有 MCP owner / pool session lease
  → 每次 transport.start → Host 再授权 + admission fence → stdio child
App close → execution owner 实际完成 ─┐
          → MCP owner 实际完成 ──────┴→ 同一 resolver.close → Host releaseConsumer（一次）
```

Session resource close 当前并行启动 execution/MCP；不改成串行、不用 timeout 伪造退出。bootstrap 为共享 resolver 设置 owner 完成屏障：每个使用者真实关闭成功后才 release；pending resolve 在关闭后不能 spawn。pool 的托管 lease 关闭必须等待最后所属进程真实关闭，不能把 idle grace 排程当作退出证明；关闭失败或借用 owner 的关闭状态未知时保留 consumer。借用端口由原 owner 负责，不从 app 关闭共享 pool。

验收：真实本地 stdio child 验证 executable、env、cwd，并覆盖 auto probe/正式握手/重连；不同环境引用或 manifestDigest 不复用连接；Windows PATH 大小写、TEMP/resources/unset 不被 request env 覆盖；非托管与 HTTP/SSE 保持原行为且 host env 不变；Host fence/error、abort/close 竞态不 spawn；任一 owner 未确认退出不 release，双 owner 完成后只 release 一次。
