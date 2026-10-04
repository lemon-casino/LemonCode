# 内置终端 Shell 选择

## 产品规则

1. 常规设置中的终端 Shell 选项来自当前本地 Host 的真实可执行文件探测，不使用仅包含固定展示项的列表。
2. Windows 至少探测 PowerShell 7、Windows PowerShell、Git Bash、CMD 和 Nushell；macOS/Linux 至少探测环境变量 `SHELL` 及 PATH/常见目录中的 zsh、bash、fish、sh 和 Nushell。
3. 设置页在打开时自动探测，并提供手动刷新。不可执行或重复路径不进入列表。
4. 用户选择由 `settingService` 持久化为唯一事实来源；`systemService` 只负责按请求返回当前 Host 的探测结果，不保存第二份选择状态。
5. “自动选择”删除用户覆盖。显式选择仅对后续新建的内置终端和新建 Agent 会话生效，已有终端和会话不切换 Shell。
6. `terminalService` 创建终端时先验证已保存路径；路径失效时自动回退到当前平台可用的默认 Shell，不能导致终端无法打开。
7. Agent Bash 工具只接收其支持的 `cmd`、`git-bash` 或 `posix` 选择。PowerShell、fish、Nushell 等选择只控制内置终端，Bash 工具继续自动探测兼容 Shell。
8. Windows、macOS、Linux 桌面均提供“选择目录”和“选择可执行文件”，并允许输入 Host 的绝对路径；Web 使用绝对路径输入，不把浏览器上传文件当作 Host 可执行文件。
9. 文件路径必须指向可执行的普通文件（允许符号链接）；Windows 仅接受可直接启动的 `.exe`/`.com`，macOS/Linux 校验执行权限。不执行文件来探测类型，不接受命令参数、相对路径或目录作为 Shell。
10. 目录选择在该目录及 `bin`、`usr/bin`、`7` 中探测已知 Shell，使用当前 Host 的路径规则。只发现一个时保存该文件；多个时展示候选让用户明确选择，不能擅自保存第一项；没有可用 Shell 时显示错误并保留原设置。
11. 已知文件按文件名识别方言，其他用户指定的可执行文件保存为 `custom`，仅用于内置终端，不覆盖 Agent Bash 工具。保存具体可执行文件路径，不保存安装目录。
12. 取消选择不修改设置；探测或保存失败显示可理解的错误。一次选择/保存完成前禁用相关控件，刷新有请求版本防护，组件卸载后的结果不写回 UI。

## 接口与迁移边界

- 复用 `ISystemService.listIntegratedTerminalShells(path?: string)`：缺省参数保持原自动探测；传文件返回一个验证后的候选；传目录返回有界探测结果；无效路径返回空列表。该方法只读，不保存或启动 Shell。
- `IPlatformService.selectDirectory/selectFile` 只负责桌面原生选择。UI 通过平台 hook 访问，路径解析通过 `useIntegratedTerminalShellOptions` 访问本地 Host；不按浏览器操作系统推断 Host 路径。
- `IntegratedTerminalShellDialect` 和复用的 settings/Agent 协议运行时 schema 新增 `custom`。既有配置无需迁移，自动探测和原方言保持兼容。

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

选择文件/目录或输入路径
  -> IPlatformService 返回路径（手输则直接使用 Host 路径）
  -> local Host systemService 只读校验/有界目录探测
  -> 0 项：显示错误；多项：UI 候选草稿等待选择
  -> 1 项或用户明确选择：settingService 持久化具体文件
  -> 保存成功后 UI 更新选择投影
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
- 三个平台均可选择安装目录或可执行文件；含空格、中文的绝对路径保持完整，不按 shell 命令拆分。
- Windows Git 安装根目录解析 `bin/bash.exe`；macOS/Linux 自定义安装目录解析 `bin/zsh`/`bin/fish`。目录内多个候选必须等待用户选择。
- 不存在路径、普通文本、无执行权限文件、Windows 批处理、相对路径、目录内没有 Shell：提示失败且不覆盖已保存设置。
- 自定义名称的可执行文件可保存为 `custom`，共享设置与 Agent 协议校验接受它，Bash 工具继续自动选择。
- E2E：文件选择并保存、取消选择、目录多个候选后明确保存、无效路径反馈、自动选择重置、窄屏布局，以及刷新不丢失已保存自定义项。
