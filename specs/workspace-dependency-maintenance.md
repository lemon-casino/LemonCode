# Workspace 兼容依赖维护

> 本文记录第一轮、限现有版本范围的维护过程。用户随后允许必要的安全升级与代码适配，
> 当前工具链、版本边界和验收结果以 [依赖安全修复](workspace-dependency-security-repair.md) 为准。

## 范围与所有者

- 各 workspace 的 `package.json` 是直接依赖版本范围的唯一所有者；根目录 `pnpm-lock.yaml` 记录可重现的实际解析结果。
- 本次维护使用 `mise.toml` 指定的 Node 24.14.0 和 pnpm 10.33.2，覆盖根项目及当前 `pnpm-workspace.yaml` 中的 workspace。
- 通过 `pnpm update -r --no-save '!@ai-sdk/openai-compatible' '!@ai-sdk/anthropic' '!@arms/rum-electron' '!oxlint' '!@pierre/diffs'` 更新现有范围内的稳定版本及其传递依赖；保留所有 manifest 的版本声明，不使用 `--latest`。带本地补丁的依赖和已确认不兼容的升级从更新选择中排除。
- 精确版本、React overrides、`patchedDependencies` 及补丁文件保持原有约束。无法在这些约束内消除的审计问题单独记录，不扩大为主版本迁移。
- 带补丁依赖的直接版本保持不变；其传递依赖可以通过 `pnpm update -r --no-save <依赖名> --depth Infinity` 在原有范围内定向更新，同时复核补丁版本和 hash。

## 接口与失败规则

- 安装入口为 `pnpm install --frozen-lockfile`；升级入口只更新根 lockfile 和本地安装结果。
- 更新后再次执行 frozen 安装，验证 manifest 与 lockfile 一致及工作区链接完整。
- 可选原生加速模块构建失败且安装器明确提供 fallback 时，记录限制；必需模块安装失败、类型检查失败或回归失败不能报告为通过。
- 如兼容依赖暴露 API 或类型差异，先定位直接原因并补充对应行为 spec，再修改源码；不通过放宽类型或取消检查掩盖问题。
- 本次回归发现 Oxlint 1.87.0 不再接受仓库现有的 `eslint(max-lines)` 抑制注释写法，`@pierre/diffs` 1.5.2 要求新增泛型参数。两项保留更新前已验证的解析版本（根 Oxlint 1.60.0、CLI Oxlint 1.67.0、diffs 1.1.22），避免将依赖维护扩大为源码迁移。

## 验收场景

1. 更新前后所有 workspace 的 manifest、工具链固定版本、overrides 和 patches 一致。
2. frozen 安装成功，workspace 包解析到当前检出的源码。
3. 执行根项目 `pnpm typecheck`、`pnpm lint`，以及 CLI 的实际类型检查入口。
4. 执行此前 worktree/runtime-environment 修复的逻辑测试与 Web 交互回归，记录真实结果。
5. 对比更新前后 `pnpm audit --json`，区分已修复与受现有版本约束限制的剩余问题。

## 2026-10-08 验证结果

- 完成 35 个 workspace 的依赖安装，更新 68 个直接依赖名称、141 处直接依赖解析记录；所有 manifest、工具链配置、overrides 和补丁文件的 SHA256 与更新前一致。
- 直接依赖解析版本均满足原有版本范围。主要更新包括 Axios 1.13.6 → 1.20.0、业务包 Undici 6.24.1 → 6.29.0、Hono 4.12.12 → 4.13.13、Vite 8.0.8 → 8.3.3、Zustand 5.0.12 → 5.0.15。
- 根项目 `pnpm typecheck` 通过；`pnpm lint` 为 0 错误、5 条原有未使用声明/导入警告；`pnpm architecture:check --changed` 为 0 违规。
- 从根目录运行 `pnpm --filter lcode-cli typecheck --concurrency=2` 和 `pnpm --filter lcode-cli lint --concurrency=2` 均通过，分别完成 27 和 14 个 Turbo 任务。
- 安装后的真实 workspace 链接下运行 66 项 worktree/runtime-environment 逻辑测试和 18 项 Web 交互测试，全部通过；没有使用此前临时的源码解析映射。
- `node-pty`、`koffi`、`ssh2` 实际模块加载通过。`cpu-features` 和 SSH 可选 crypto binding 因缺少 Visual Studio C++ 工具未编译，SSH 使用安装器提供的 JS fallback。
- 进一步定向更新 RUM 链中的 PostCSS 和 source-map-js，消除该链 5 条审计问题；SDK 的固定版本和本地补丁保持不变。

### Windows 重复安装

正常并发的重复 frozen 安装两次在输出完成后以 `0xC0000005` 退出，根因尚未确认。使用以下临时参数完成最终 frozen 安装，包含 prepare/postinstall，退出码为 0；仓库工具链和并发默认配置未修改：

```powershell
$env:UV_THREADPOOL_SIZE = "1"
pnpm install --frozen-lockfile --child-concurrency=1 --network-concurrency=1
```

### 依赖审计

以下数字是 `pnpm audit --json` 的统计条目，不等同于已证明可利用的产品缺陷：

| 严重程度 | 更新前 | 更新后 |
| -------- | -----: | -----: |
| Critical |      5 |      3 |
| High     |    111 |     21 |
| Moderate |    137 |     26 |
| Low      |     31 |     10 |
| 合计     |    284 |     60 |

剩余 3 条 Critical 来自固定传递依赖：根 Oxfmt 0.41.0 固定 Tinypool 2.1.0（[公告一](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3)、[公告二](https://github.com/advisories/GHSA-85c8-ppgw-ccpr)），Concurrently 9.2.4 固定 shell-quote 1.9.0（[公告](https://github.com/advisories/GHSA-pqg4-j6r4-53mv)）。

其他剩余约束包括 Desktop 精确固定的 Electron 41.0.3、TUI 精确固定的 ws 8.18.0、release-it 固定的 Undici 6.23.0，以及需要跨主版本修复的 basic-ftp、file-type 等。审计仍以非零状态退出；本次未添加覆盖这些约束的 overrides 或扩展 manifest 范围。
