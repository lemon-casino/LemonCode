# 内置终端 Shell 选择

## 产品规则

1. 常规设置中的终端 Shell 选项来自当前本地 Host 的真实可执行文件探测，不使用仅包含固定展示项的列表。
2. Windows 至少探测 PowerShell 7、Windows PowerShell、Git Bash、CMD 和 Nushell；macOS/Linux 至少探测环境变量 `SHELL` 及 PATH/常见目录中的 zsh、bash、fish、sh 和 Nushell。
3. 设置页在打开时自动探测，并提供手动刷新。不可执行或重复路径不进入列表。
4. 用户选择由 `settingService` 持久化为唯一事实来源；`systemService` 只负责按请求返回当前 Host 的探测结果，不保存第二份选择状态。
5. “自动选择”删除用户覆盖。新建内置终端及 Agent 的新任务使用当前设置，包含新会话、继续已有会话、冷恢复及排队后开始的任务。正在执行的任务保持本次执行的 Shell；结束、取消或失败后的下一任务重新读取设置，不沿用会话创建时的 Shell。已启动的交互 PTY 不强行中断或重启，后续创建使用当前设置。
6. `terminalService` 创建终端时先验证已保存路径；路径失效时自动回退到当前平台可用的默认 Shell，不能导致终端无法打开。
7. Agent Bash 工具只接收其支持的 `cmd`、`git-bash` 或 `posix` 选择。PowerShell、fish、Nushell 等选择只控制内置终端，Bash 工具继续自动探测兼容 Shell。
8. Windows、macOS、Linux 桌面均提供“选择目录”和“选择可执行文件”，并允许输入 Host 的绝对路径；Web 使用绝对路径输入，不把浏览器上传文件当作 Host 可执行文件。
9. 文件路径必须指向可执行的普通文件（允许符号链接）；Windows 仅接受可直接启动的 `.exe`/`.com`，macOS/Linux 校验执行权限。不执行文件来探测类型，不接受命令参数、相对路径或目录作为 Shell。
10. 目录选择在该目录及 `bin`、`usr/bin`、`7` 中探测已知 Shell，使用当前 Host 的路径规则。只发现一个时保存该文件；多个时展示候选让用户明确选择，不能擅自保存第一项；没有可用 Shell 时显示错误并保留原设置。
11. 已知文件按文件名识别方言，其他用户指定的可执行文件保存为 `custom`，仅用于内置终端，不覆盖 Agent Bash 工具。保存具体可执行文件路径，不保存安装目录。
12. 取消选择不修改设置；探测或保存失败显示可理解的错误。一次选择/保存完成前禁用相关控件，刷新有请求版本防护，组件卸载后的结果不写回 UI。

## 界面结构

该设置占用常规设置行右侧的单个控件位，不再堆叠选择器、路径输入和多行按钮。

- 触发器是一个输入风格的控件外壳，与同页其他 Select/Input 使用相同的 `lg` 高度与圆角，宽度填满控件列；显示当前选择（“自动选择”或 Shell 名称）与已保存路径，路径过长时截断。
- 展开面板复用仓库既有的菜单式 Popover 语言（`bg-menu`、`rounded-lg`、`rounded-md` 选项），而不是新的视觉规范。
- 面板内只有一个输入框，同时承担“过滤已探测 Shell”和“输入绝对路径”两件事：输入包含路径分隔符时，面板只展示“应用路径”项，回车即按路径探测，使回车行为确定；否则按名称过滤 Shell。
- “自动选择”、已探测 Shell、目录候选、“应用路径”都以同一选项行呈现；目录候选单独分组，仍需用户明确选择。
- “选择可执行文件”“选择目录”“重新探测 Shell”作为面板底部操作，桌面可用原生选择器，Web 只保留路径输入。
- 面板关闭时清空草稿路径、候选与错误；错误以 `role="alert"` 呈现并保留面板，便于就地重试。
- 面板的 `cmdk` 必须 `shouldFilter={false}`，由控件自己做大小写无关的子串匹配。`cmdk` 内置模糊评分对含空格和中文的绝对路径（如 `/opt/自定义 Shell/my-shell`）会返回 0 分，把“应用路径”项判为不匹配而隐藏，使回车与点击同时失效。

## 接口与迁移边界

- 复用 `ISystemService.listIntegratedTerminalShells(path?: string)`：缺省参数保持原自动探测；传文件返回一个验证后的候选；传目录返回有界探测结果；无效路径返回空列表。该方法只读，不保存或启动 Shell。
- `IPlatformService.selectDirectory/selectFile` 只负责桌面原生选择。UI 通过平台 hook 访问，路径解析通过 `useIntegratedTerminalShellOptions` 访问本地 Host；不按浏览器操作系统推断 Host 路径。
- `IntegratedTerminalShellDialect` 和复用的 settings/Agent 协议运行时 schema 新增 `custom`。既有配置无需迁移，自动探测和原方言保持兼容。
- `settingService`、`systemService`、`terminalService` 的接口与状态所有者不变。Agent App 的 `resolveBashShellSelection` 通过既有 `session/requestRuntimePreferences` 的 `user-execution` scope 读取当前 Host 设置，不缓存首次结果；Runtime 通过注入的 resolver 在执行边界统一应用。
- Runtime 的 `prepareSessionShellEnvironment` 只允许空闲用户执行边界刷新；Runtime command owner 在已取得 foreground 所有权后、工具和模型执行前走同一刷新逻辑。普通 prompt、继续任务、队列 promotion、控制轮以及 workflow 的 App 执行边界均覆盖；当前任务内部的引导、工具和自动目标续跑不重新读取 Shell。
- `bash_shell_selection` entry 保持既有格式和稳定 ID，表示最近一次采用的执行 Shell，仅用于历史恢复/无当前候选时的 fallback，不再覆盖已解析的最新设置。新建子 runtime 继承父任务已采用的 Shell；独立 fork 后的新任务重新读 Host。
- resolver/协议读取失败阻止本次启动并保留旧 Shell，不把传输错误解释为“自动选择”。旧 Host 的 method-not-found 仍沿用既有兼容路径；显式路径失效仍由 adapter 回退。无需数据库迁移或新增协议消息。

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

Agent 新建/恢复/继续/排队任务
  -> CommandInbox / Runtime command owner 串行 admission
  -> 获取 foreground 执行所有权
  -> resolver 从 owner Host settingService 读取当前 user-execution 偏好
  -> 验证 foreground owner、branch generation、turn number 与读取 revision，丢弃失效异步结果
  -> Runtime 统一更新 Bash selection、工具视图和模型 Shell 上下文
  -> 覆盖最近采用的 Shell entry（已持久化会话）
  -> 本次任务执行，Shell 固定至 foreground 结束
  -> 下一任务开始时重新读取（运行中保存的设置在此生效）

desktop-continuous / web-remote-replayable
  -> 复用同一 Host attachment / Runtime command owner
  -> 同一 user-execution 偏好请求与执行边界
  -> 不增加客户端选择缓存、远端队列或独立 Runtime

面板内选择已探测 Shell 或“自动选择”
  -> settingService 持久化
  -> 成功后关闭面板并清空草稿；失败保留面板并显示错误

面板内输入路径
  -> 输入含分隔符：面板只保留“应用路径”项
  -> 回车或点击该项：local Host systemService 只读校验/有界目录探测
  -> 0 项：显示错误并保留面板；多项：候选分组等待明确选择
  -> 1 项或用户明确选择：settingService 持久化具体文件
  -> 保存成功后关闭面板

面板内选择文件/目录
  -> IPlatformService 返回路径（取消则不改设置）
  -> 走同一条路径解析时序
```

- 选择状态所有者：`settingService`。
- 探测结果所有者：设置页当前加载周期；刷新结果覆盖旧列表。
- 面板草稿所有者：控件本地状态（过滤词、候选、错误），关闭即丢弃，不写入 `settingService`。
- 执行 Shell 所有者：Agent Runtime；配置值只属于 `settingService`，执行快照与模型提示均是它在任务边界的派生结果。Shell 的实际路径/方言变化必须追加 provider-visible 提醒（包括相同展示名的不同路径）；A→B→A 每次都提示，不按整段历史去重。上下文前缀同时采用最新 Shell，保留已有对话。
- 失效边界：保存后的可执行文件被卸载或移动时，创建终端回退自动选择，设置页下一次刷新不再把它作为可用项，但保留已保存项供用户识别和重新选择。

## 验收场景

- Windows 安装了 `pwsh.exe`、Git Bash 和 CMD 时，列表展示三个真实可执行 Shell，选择 PowerShell 后新建终端返回 PowerShell Shell 名称。
- macOS/Linux 不再隐藏 Shell 选择，环境变量 `SHELL` 指向可执行文件时优先展示。
- PATH 中不存在的候选不会展示；同一路径通过环境变量和固定目录同时命中时只展示一次。
- 已选择路径失效后，新建终端仍能使用自动回退 Shell 启动。
- 选择 PowerShell、fish 或 Nushell 时，Agent Bash 工具不接收该不兼容覆盖。
- 已有会话使用 A 完成任务后选择 B，继续任务和冷恢复均使用 B；新建会话、独立 fork 也使用 B。选择“自动选择”后已有会话下一任务回到自动探测。
- A 正在执行时选择 B，当前任务全部 Bash 调用及派生子 runtime 继续使用 A；排队任务真正启动时使用最新选择（若此时已改为 C，则使用 C）。结束、取消或失败后的下一任务均覆盖，内部引导和目标自动续跑不在任务中途切换。
- 同名 Shell 路径 A→B 也切换并提醒模型；A→B→A 不因历史存在旧提醒而漏掉最后一次提醒。选择未变化时不重复刷新工具和追加提醒。
- 冷恢复遇到旧快照时当前设置优先；当前候选缺失时保留旧快照恢复规则。读取期间取消、关闭或 branch/owner 改变时，迟到结果不写回 Runtime。
- 三个平台均可选择安装目录或可执行文件；含空格、中文的绝对路径保持完整，不按 shell 命令拆分。
- Windows Git 安装根目录解析 `bin/bash.exe`；macOS/Linux 自定义安装目录解析 `bin/zsh`/`bin/fish`。目录内多个候选必须等待用户选择。
- 不存在路径、普通文本、无执行权限文件、Windows 批处理、相对路径、目录内没有 Shell：提示失败且不覆盖已保存设置。
- 自定义名称的可执行文件可保存为 `custom`，共享设置与 Agent 协议校验接受它，Bash 工具继续自动选择。
- 右侧控件在桌面与窄屏都只有一行触发器；触发器与同页其他设置控件的高度、圆角、边框和背景一致，窄屏不产生横向溢出。
- 面板内输入含分隔符的路径后回车，解析的是该路径本身，不会误选同屏的已探测 Shell。
- E2E：文件选择并保存、取消选择、目录多个候选后明确保存、无效路径反馈、自动选择重置、窄屏布局，以及刷新不丢失已保存自定义项。
