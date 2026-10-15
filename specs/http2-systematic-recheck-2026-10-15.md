# HTTP/2、崩溃清理和诊断的二次系统复核

基线 `5b954768`，范围仅 zcode-full。上轮验收不能代替本轮执行；保留工作区已有远控重连改动。本轮不升级外部仓库、不请求真实供应商、不重跑原业务、不替换安装包。

## 复核发现与规则

1. **发送前请求体取消缺口**：transport 的 `request.arrayBuffer()` 不受其租约 controller 控制；无限等待的上传源可在 caller 取消后继续读取。改由原租约注册上传 reader，取消立即结束业务等待、取消原 reader，物理 cancel Promise 仍登记原 NetworkCleanup。EOF 后释放上传 reader，不影响响应 reader；发送前再次核对取消，零发送。不新增上传队列或超时。继续核对调用链发现 model cache 会额外构造中间 Request、插件入口在 worker call 前自行读取 body；cache 直接传递原输入/配置，插件序列化收回原 PluginWorkerTransport，通过同一个读取 helper 和它自己的原资源账本处理 caller/context/driver 关闭。worker 退出与上传清理均受原关闭预算约束，不能把 worker exit 当作上传源已关闭。
2. **worker reader 清理遗失**：cancel/finally 使用 fire-and-forget cancel，operation 随即被删除；真实清理失败无法进入 dispose 结果。由 worker 内唯一 reader 清理账本保存原 reader 的一次 cancel Promise；重复 cancel 合并，成功删除，失败留到退出汇总。取消仍立即结束业务；退出同时等待原 operation 与该账本，不把同一次 signal reason 当清理故障，不吞掉其它错误。无需跨进程新增业务协议。
3. **清理诊断的迟到结果缺失**：Protocol 的单步 budget 只给其它资源关闭机会，不能吞掉之后的失败。原 step 持有唯一结果对象，实际 Promise settle 时更新状态；pending 后补发 correlated completed/failed 事件，最终 summary 使用当时的实际状态。仍等待同一个 session shutdown，失败保留共享 store，不续原 deadline，不重复报失败。
4. **聚合错误原因遗漏**：进程 v2 诊断复用现有有界 causes，按确定顺序遍历 Error.cause 与 AggregateError.errors，去重、防环、最多四项，超限/环标记裁剪；保留错误 code 和独立 frames。读取异常对象字段失败时保留可校验的降级事件，不能整条 fatal 诊断消失。保持 v1/v2 schema，不引入 v3。
5. **worker 退出的证据边界**：独立探针证明 `Worker.unref()` 不能保证捕获 stdout/stderr 后父进程自然退出；Node 的 stdio MessagePort 有独立 ref。保留日志隔离和公开 API，不访问 Node 私有字段，不把 unref 当物理关闭。unref 移到 listener 注册之后；关闭始终经原 owner 的 dispose 等真实 exit，补独立父进程自然退出测试（显式关闭原 worker 及其 stdio 后），不能声称未关闭 worker 的探针通过。
6. **账号 driver 构造/发布跨 await 的关闭竞态**：原账号清理 owner 同时跟踪授权及账号 driver 的构造工作；关闭等待原构造 Promise 与原 driver 清理，不另建账号缓存。每次异步凭据读取之后检查 owner，再发布原 driver。构造晚到、读取失败或 owner 已关闭时，原 driver 交回同一个 cleanup owner；成功关闭幂等，失败保留原句柄/原因并在关闭汇总中失败，后续显式重试。构造失败没有创建资源时不虚构清理故障。清理等待不阻止已存在的 driver 开始关闭。

构造门与退出进度收敛到现有 ProviderAccountDriverCleanup。为遵守 400 行门禁，将原授权输入的纯校验从 ProviderAccounts 提取到同模块 helper，默认值、条件字段、必填及 select 规则保持不变，由现有账号授权回归验证；不在大文件继续堆叠生命周期逻辑。

Network transport、worker scope、Protocol cleanup step、CLI diagnostic producer 分别仍为对应事实的唯一所有者，Host/Main 仅消费原诊断。关闭错误不上升为自动业务重试权限。Desktop continuous 与手机 replayable 复用原 owner/lease 和命令准入，未改变传输恢复语义。

```mermaid
sequenceDiagram
    participant C as caller / lifecycle
    participant N as 原 network / worker / driver owner
    participant R as 原 reader / session
    participant P as 原 Protocol cleanup step
    participant L as 诊断出口
    C->>N: cancel / close（原 signal 与 deadline）
    N-->>C: 业务取消一次
    N->>R: cancel / close 原句柄
    N->>N: 保留原物理完成 Promise
    P->>N: 同一个关闭操作
    opt 单步预算先到
        P->>L: pending（原 closeId / errorId）
    end
    R-->>N: 实际 completed / failed
    N-->>P: 原 Promise settle
    P->>L: 更新结果并记录迟到终态
    P->>L: summary（当时状态）
```

## 必须执行的验收

- 流式上传在 caller cancel / owner dispose 时零发送、停止读取、业务不悬挂；关闭等待被 gate 阻塞的 cancel，真实 cancel 错误可见；普通上传字节不变。
- reader 重复取消只调用一次；异步清理未完成、失败、正常 EOF 与 abort reason 分别验证；worker 生成后跑真实插件 fixture/强制退出回归。
- pending 后成功与失败各有且只有一个终态事件；summary 与最终结果一致，首个 closeId/errorId 不变，session 失败仍不关 store。
- AggregateError 多原因、混合 cause、防环、超限、异常 getter 均生成可通过 Host schema 的有界事件。
- 真实 TLS H2 八路未消费 SSE 在 owner 退出后全部 socket/session 关闭；另一 owner 的流仍可读。保留八路乱序、peer SETTINGS、GOAWAY、RST、代理和 Electron 内嵌 Node 回归。
- 执行 root 与 CLI typecheck/lint、changed 架构检查、相关格式检查；重建 worker/许可与 Desktop Agent 后校验 staging 和 smoke。报告实际执行、失败及未验证范围。

## 结果

本轮发现的上传、worker reader、账号 driver 构造、迟到清理诊断及聚合原因缺口均已修复。H2 的正常乱序并发、对端 SETTINGS 限制、单流取消、session 故障和无 POST 重放回归通过；新增八路长 SSE 关闭断言在 fixture 清理前确认原 session 已关闭，另一 owner 保持健康。

执行环境：Windows，Node 24.21.0、pnpm 10.34.6；隔离 Electron 41.10.7 / Node 24.18.0。本机日志目录 `.artifacts/http2-systematic-recheck-20261015/`。没有沿用上轮 1,098 项数字作为本轮执行结果。

| 验证                           | 本轮实际结果与证据                                                                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Provider 全部 TS/mjs 测试      | 248 项通过，`provider-final.log`；含 32 轮/256 个乱序 POST、Electron 内嵌 Node、真实代理及插件 fixture。最后修改的 context 类型夹具另外重跑 6 项通过，去重不再加计。                                         |
| 账号、Host、CLI 及 model cache | 112 项通过，`services-cli-host-final.log`；含真实 uncaught / strict unhandled rejection 的 H2 进程、首次 errorId、stderr 分片、原构建身份、账号 CAS/锁/构造关闭。纯校验提取后相关 8 项再通过，去重不再加计。 |
| Model adapter/Runner           | 226 项通过，`model-final.log`。                                                                                                                                                                              |
| Bootstrap 全部 src 测试        | 537 项通过，`bootstrap.log`；原 store 保护、Browser/checkout、continuous/replayable 和 CommandInbox 保持回归。                                                                                               |
| 打包与实际 staging             | 16 项通过，`packaging.log`；包括当前 Agent 字节进入实际 staging、公开网络入口和 Desktop 外置依赖。                                                                                                           |
| 隔离 Electron / Web            | 各 1 项通过，`electron-web.log`；独立 Host 实际关闭及停止归因的宽屏/手机、主题和语言。                                                                                                                       |
| 根 / CLI typecheck             | 最终均退出 0；CLI 27 项任务通过，命中 Turbo 缓存如实保留。                                                                                                                                                   |
| 根 / CLI lint、pre-push        | 最终均退出 0；CLI 14 项任务通过；pre-push 的 changed 架构检查违规/基线/新增均 0。                                                                                                                            |
| 架构边界                       | 已在修改前运行检查、读取 provider-node/services/shared/lcode-cli 上下文；这些主要区域仍是 unmanaged，不把 0 违规等同于全覆盖。未新增跨包实现导入。                                                           |
| worker、许可与构建             | 原生成器重建成功，vendor SHA 校验保留；notices 生成及 check 均退出 0，1,746 个实装包检查通过。现有 20 项材料复核债务仍按基线管理，不宣称 strict 零债务。                                                     |
| Agent smoke                    | `build:desktop-agent` 退出 0，约 17.3 MiB；`--version` 为现有 0.16.9，`--licenses` 退出 0。                                                                                                                  |

去重共 **1,141 项测试通过**，其中本轮新增 23 项；重复的定向验证和 Electron 重装配不重复计数。未修改 UI 交互，但运行了原 Web/Electron 端到端回归。没有把真实供应商吞吐、长期 RSS 或跨平台真机效果写成已验证。

构建身份：

- Agent：`353263fc96b917163647c9e0fc1b36f1ab2d4c36f0ebba8b9d8c156e9f06fceb`。
- 生成 `worker-source.ts`：`43e4ba51e3c83fa8d5c300d6284c639612d807339a4e6aa42af1f9b6f652a476`，inventory 同步该字节 hash。
- 固定 vendor manifest：`c0ce379a746de3ca094552c2b334f1fed585fe88a7369b6c2ac8d841a37ba348`，revision 未更换。

本轮失败记录与边界：新增上传、聚合原因、迟到失败及账号构造测试曾先失败，修复后实际重跑通过；类型检查发现夹具类型/可选输入问题，Lint 发现 400 行超限，均修正后再通过。formatter 在 Windows 曾遇到文件映射占用，改为单线程后完成。独立 idle worker 探针没有自然退出，原因是捕获 stdio 的独立 ref；验收使用显式 dispose 与真实 exit，不谎报 unref 探针成功。子进程 fixture 一度继承 `--input-type=module` 导致 CJS require 失败，明确清空该夹具的 execArgv 后重跑通过。原复现挂起的测试进程已仅按确认的自有 PID 回收。

代码按功能本地提交：`c42b9bd1` 网络与 worker 上传/reader，`6bdb91d6` 账号构造与退休，`40ca8aa5` 迟到清理及聚合诊断。三个实现提交共 23 个文件，新增 1,156 / 删除 119 行，净增 1,037 行（含测试、生成 worker 单行与 inventory）；文档另计。格式检查实际匹配根 18、CLI 6 个文件通过，生成 worker 由原构建器格式化。已有远控重连改动、原业务与外部仓库均未混入。未推送或发布，未替换用户安装包；macOS/Linux、手机真机和真实供应商仍未在本轮实测。
