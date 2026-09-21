# 内置终端 Shell 选择

## 产品规则

1. 常规设置中的终端 Shell 选项来自当前本地 Host 的真实可执行文件探测，不使用仅包含固定展示项的列表。
2. Windows 至少探测 PowerShell 7、Windows PowerShell、Git Bash、CMD 和 Nushell；macOS/Linux 至少探测环境变量 `SHELL` 及 PATH/常见目录中的 zsh、bash、fish、sh 和 Nushell。
3. 设置页在打开时自动探测，并提供手动刷新。不可执行或重复路径不进入列表。
4. 用户选择由 `settingService` 持久化为唯一事实来源；`systemService` 只负责按请求返回当前 Host 的探测结果，不保存第二份选择状态。
5. “自动选择”删除用户覆盖。显式选择仅对后续新建的内置终端和新建 Agent 会话生效，已有终端和会话不切换 Shell。
6. `terminalService` 创建终端时先验证已保存路径；路径失效时自动回退到当前平台可用的默认 Shell，不能导致终端无法打开。
7. Agent Bash 工具只接收其支持的 `cmd`、`git-bash` 或 `posix` 选择。PowerShell、fish、Nushell 等选择只控制内置终端，Bash 工具继续自动探测兼容 Shell。

## 状态与时序

```text
设置页打开/刷新
  -> local Host systemService 探测可执行文件
  -> UI 展示瞬时列表
  -> 用户选择
  -> settingService 持久化 integratedTerminalShell

新建内置终端
  -> terminalService 读取 settingService
  -> 校验显式路径
  -> 使用显式 Shell，失效则走平台默认探测
  -> node-pty 启动
```

- 选择状态所有者：`settingService`。
- 探测结果所有者：设置页当前加载周期；刷新结果覆盖旧列表。
- 失效边界：保存后的可执行文件被卸载或移动时，创建终端回退自动选择，设置页下一次刷新不再把它作为可用项，但保留已保存项供用户识别和重新选择。

## 验收场景

- Windows 安装了 `pwsh.exe`、Git Bash 和 CMD 时，列表展示三个真实可执行 Shell，选择 PowerShell 后新建终端返回 PowerShell Shell 名称。
- macOS/Linux 不再隐藏 Shell 选择，环境变量 `SHELL` 指向可执行文件时优先展示。
- PATH 中不存在的候选不会展示；同一路径通过环境变量和固定目录同时命中时只展示一次。
- 已选择路径失效后，新建终端仍能使用自动回退 Shell 启动。
- 选择 PowerShell、fish 或 Nushell 时，Agent Bash 工具不接收该不兼容覆盖。
