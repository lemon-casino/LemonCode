# 远端运行时内存回归记录

日期：2026-10-17。行为合同见 [remote-runtime-memory-budget.md](./remote-runtime-memory-budget.md)。

## 实际环境与方法

- Linux 局域网测试机，Node 24.21.0；使用独立 HOME、工作目录和 systemd 临时单元，未调整原有服务或会话的资源限制。
- `MemoryMax=1073741824`、`MemorySwapMax=0`、`CPUQuota=200%`、`AllowedCPUs=0-1`。运行时读取的 `memory.max`、`memory.swap.max`、`cpu.max`、`cpuset.cpus.effective` 均与限制一致。
- 运行本次构建的 Server、CLI、REPL 三个固定产物。资源数值来自 cgroup，包含测试驱动与被测进程，不能等同于单个 Agent 的 RSS。
- 构建测试入口：`node scripts/build-memory-regression.mjs`。组件/压力入口为 `packages/server/test/runtime-memory.fixture.ts`；完整 Server RPC 入口为 `packages/server/test/runtime-memory-rpc.fixture.ts`。

## 实测结果

| 场景                               | cgroup 当前内存 | 断言与结果                                                           |
| ---------------------------------- | --------------: | -------------------------------------------------------------------- |
| 真实 Server 冷连接与被动订阅       |       214.9 MiB | 只有驱动和 Server，无 Agent/REPL                                     |
| Agent 会话已创建、两项官方能力注册 |       413.4 MiB | REPL 工具可发现，尚未启动进程                                        |
| 第 20 次 JS 调用完成               |       473.1 MiB | 调用成功，Worker 已退出                                              |
| 第 100 次 JS 调用完成              |       486.1 MiB | 未出现按调用累积的 Worker 进程                                       |
| 堆上限与取消恢复                   |       490.8 MiB | 同步堆耗尽被限制在 Worker；取消后同一会话立即再调用成功              |
| 堆外缓冲区压力恢复                 |       496.1 MiB | 触发内存预算中止后可继续调用；整轮压力峰值约 919.0 MiB               |
| 组件全部回收                       |       114.8 MiB | 只剩测试驱动；新工作区可以再次启动 Agent                             |
| 完整 Server+Agent+REPL 同时存活    |       600.0 MiB | 真实 Server RPC 并发需求只启动一个 Agent；普通调用整轮峰值 614.2 MiB |
| 完整链路释放工作区                 |       245.4 MiB | Agent/REPL 已退出，Server 保持在线；随后可启动另一工作区             |

两套受限回归均退出成功；`memory.events` 中 `max=0`、`oom=0`、`oom_kill=0`。最后校验 cgroup 只剩驱动 PID，无被测进程残留。

组件数值取最终一轮回归，其中取消后直接在同一会话再次调用，不插入恢复等待。另一轮 100 次测试的第 20→100 次增长约 0.5 MiB；最终一轮约 13 MiB，包含驱动与分配器波动，不能据此声称长期零内存增长。完整 Server RPC 行取独立整链路回归。

覆盖了同工作区并发首次启动、第二工作区预算不足、静态 MCP 发现、跨会话 Worker 并发拒绝、100 次串行调用、取消、Worker 堆耗尽、原生 Buffer 压力、异常后的下一次调用、实际进程树回收和回收后重新启动。SSH 缓存下的共享 owner、运行任务保留和重新挂载等待回收，由连接注册表回归补充验证。

## 仓库验证

- 根目录与 CLI 的 typecheck、lint 通过。
- 运行时、预算、连接注册表与 MCP 定向测试：38 项通过。
- 远控回归：137 项通过；远端资产回归：37 项通过。
- 发送与远端草稿浏览器回归：41 项通过，覆盖桌面/手机尺寸及主动请求命令目录。
- 已选择的打包/发布合同测试：65 项通过。命令使用 `--test-skip-pattern='legacy --strict'` 排除了许可全量扫描用例；该额外扫描进入本机依赖图拆包路径后长时间未结束，已停止。本次未修改依赖，现有 notice 输入与保留的 20 项材料记录单独校验通过。
- Web、Server、CLI、独立 REPL 与 Desktop `build:no-runtime-assets` 生产构建成功。Web/Renderer 仍有原有预览模块静态/动态导入和 bundle 大小提示；本次没有创建新安装包或移动发布 tag。

旧发送夹具仍等待已移除的工作树弹窗，本次仅把断言改为当前管理按钮与设置导航 owner；最终 41 项全部通过，没有恢复旧产品 UI。

## 验证边界

真实 MCP JS 已执行，Server/Agent 的 stdio/RPC 与工作区回收使用真实实现。未调用线上模型，也未以普通 JS 冒充真实浏览器或桌面设备操作。设备能力的鉴权保留/原始凭据清理由定向测试覆盖。

预算使用当前可用内存并保留系统余量；已有其他服务占用过高时，新增执行会明确失败并允许稍后重试。V8 堆上限与堆外采样保护不等同于任意瞬时原生分配的操作系统硬隔离；本次硬上限由 cgroup 实施。
