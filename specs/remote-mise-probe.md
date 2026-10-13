# 远端 mise 版本探测

## 已确认的问题

2026-10-13 本机真实的 mise v2026.10.2：`--version` 返回版本并退出 0，
`--no-config --version` 输出帮助并退出 1（stderr 为空），
`--no-config version` 返回版本并退出 0。远端校验器恰好组合了失败的两项。
因此退出 1 本身不能作为“mise 资源缺失或损坏”的证据。

本机日志显示 18:58 远端下载后失败，19:00 本地上传 100% 后同样失败。
本机缓存的四个 mise 必需文件都存在，binarySha256 校验通过。
尚未直接执行用户 SSH 主机上的校验命令；远端实际 stdout/stderr 未由旧版日志保留。

## 产品规则与所有者

- 版本探测使用 `mise --no-config version`，保持冻结配置和版本/平台校验。
- 后端 manifest、普通文件、归档和 binary SHA 校验继续有效，不能通过跳过校验放行。
- mise 是 runtime-environment 的 Node/pnpm 管理后端，不是 SSH、解压或 SHA 工具。
  当前部署器无条件把 mise 作为 SSH 前置是另一个能力边界问题；探测修复不冒充完成该解耦。
- SSH 运行资源必须在 SSH 主机执行，本机 Windows 可执行文件不能代替 Linux 运行时。
  本地构建不依赖 tag 的资源分发要求保留，不把上线发布视为本地构建的必需步骤。
- 组件部署、pinned manifest 和 install-root lock 仍由既有 remote deploy owner 管理；
  不改变 workspaceIdentity、lease、业务队列或 Desktop/mobile 交付语义。

## 验收

1. POSIX fixture 拒绝 `--no-config --version`，只接受 `--no-config version`，
   原测试先复现失败，再在四个平台安装、cache 复用、缺件修复和错误摘要场景中通过。
2. 使用本机真实固定 mise 验证两个参数组合的退出码与输出；不把 fixture 当成真实二进制验证。
3. 根 typecheck、lint 和 changed architecture check 通过；实际 SSH 验证单独报告。

## 验证记录（2026-10-13）

真实本机固定 mise 的参数对照已执行；先修改 fixture 拒绝错误组合，复现原部署测试失败，
再修正生产命令，`runtimeToolDeploy.test.ts` 的 21 项全部通过。根类型、Lint 和架构检查通过。
四个平台部署测试中的 mise 是明确标记的 POSIX 假程序，本机真实程序为 Windows x64；
未声称已执行 Linux 二进制或完成用户 SSH 主机的重连验收。
