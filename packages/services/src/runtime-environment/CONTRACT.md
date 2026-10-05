# runtime-environment 服务合同

状态：M1 已实现（prepare/get/list/resolveContext/release/reconcile/capabilities 纵向）；
M2 起接入执行消费者与依赖安装。规格唯一来源：`specs/worktree-runtime-environments.md`；
实施任务对应 `specs/worktree-runtime-environments-plan.md` P1-01～P1-06。

## 服务身份

- 通道名 `runtime-environment`，descriptor 与接口同名（`IRuntimeEnvironmentService`）。
- 组合根：`packages/services/src/node.ts`，数据目录 `<HostDataRoot>/runtime-environments/`，
  与 `worktrees/` 同级；不改 WorktreeService 的 `dataDir`（主文档 §8.4）。
- 架构策略：`runtime-environment` managed 模块，layers domain→app→adapters，
  公开入口 `contract.ts` 与 `node.ts`。

## 所有者（主文档 §7）

| 事实 | 所有者 |
| --- | --- |
| environmentId/revision/状态机/manifest/操作收据 | 本服务 |
| 环境资源（tool-backends/tool-store/package-store） | 本服务资源层 |
| 绑定、checkout、分支 | WorktreeService（经注入 port 调用本服务，M2 接线） |
| 进程/PTY 事实与停止证明 | 既有执行/终端 owner |
| resourceLeaseToken | 仅内部；不进协议 schema、不进 UI 投影 |

## 接口（contract.ts）

| 方法 | 语义 |
| --- | --- |
| getCapabilities | 平台/后端可用性；`managedEnvironments=false` 必须给 missingReason |
| prepare | 同 requestId 幂等复用操作与环境；cancel 只结算不复活；声明冲突 → failed |
| get/list | 只读投影；查询不产生执行 |
| resolveContext | 每命令一份不可变冻结上下文；非 ready 抛错 |
| release | stale 修订检查；fence→released；不可释放状态返回 releaseBlocked |
| reconcile | 崩溃对账：读原操作，不重放安装 |

## 持久化（adapters/store.ts）

- `records/<envId>.json`、`operations/<opId>.json`、`manifests/<hash>.json`、`locks/<key>.lock`。
- 记录 schema 唯一事实源在 `@lcode/shared`（strict zod）；损坏/未知版本记录明确抛错不修成 ready。
- 幂等键：`operationId = sha256(["operation", identityKey, requestId]).slice(32)`；
  `environmentId = sha256(["environment", identityKey, bindingId, purpose]).slice(32)`。
- 身份 key 按 AGENTS.md：`workspaceIdentity?.trim() || workspacePath`。
- 原子写复用 `atomicWritePrivateTextFile`；跨进程锁复用 `withFileLock`（30s 上限，短锁）。

## 工具后端（adapters/toolBackend.ts）

- 固定 `mise v2026.10.2`，全平台 8 资产 sha256 固定（ADR：主文档 §5.4）。
- 所有 mise 调用带 `--no-config`（阻断项目/父级/全局配置注入，P0-03 实测）。
- 安装布局 `<store>/data/installs/<key>/<version>/<key>[.exe]`；
  `mise which` 在 `--no-config` 下不可用（P0 实测），因此直接拼路径并 stat 验证。
- 同 key-version 跨进程文件锁；下载 sha256 校验失败隔离不发布；离线明确失败不落 PATH 兜底。

## 声明解析（domain/declarations.ts）

- 来源：mise.toml tools（字符串约束）、.node-version/.nvmrc（单行）、
  package.json packageManager（精确版本）与 engines。
- 冲突不猜测：多来源版本冲突、多 manager 锁且无 packageManager → configuration-conflict issue。
- 未知语法（表/数组工具值、||、通配符）→ unsupported-declaration issue。
- 优先级：mise.toml 显式声明 > 应用默认；无声明冻结 app-default 并标注来源。
- engines 约束支持 精确/>=/<=/>/</=/^/~ 与空格 AND 组合；`||` 等未知语法显式报不支持。

## 状态机（domain/state.ts）

主文档 §10.1 图的纯函数实现：`advanceStatus(current, event)`。
非法迁移返回 `invalid: true` 且状态不变；cancelled 是结算态不复活；
`PreparationStage` 是排除释放三态后的窄联合（operation.stage 域）。

## 已知边界（M2 P2-02 起部分收口）

- `resolveContext.envOverlay.set` 已组合冻结工具目录的 PATH 前缀（Windows 键 `Path`、其余 `PATH`）；
  base="inherit" 保持宿主环境语义，不改 Host/Agent process.env。
- 组合根 `prepareRuntimeEnvironment` port 返回展平 `env`（= envOverlay.set），由 lifecycle 透传给
  setup 执行器（`runSetup(..., env)`）与 `runWorktreeValidation`（spawn 覆盖键值叠加）；
  重试/恢复路径按当前 revision 重新解析冻结覆盖。
- `preparingDependencies` 阶段仍直通 ready：依赖安装用例在 M2 P2-06 接入。
- release 未含进程停止证明（M3 P3-02 接线）；当前 fence 后直接结算 released。
- 协议方法族已注册（`runtimeEnvironment/*` 五方法 + 严格 schema），Host 桥接 strict parse
  在 M2 P2-01 随 binding environmentRef 一起接线（已实现：CLI restore 对账见
  `worktree-execution.ts`）。
