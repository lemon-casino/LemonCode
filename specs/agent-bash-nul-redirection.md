# Agent Bash 工具 nul 重定向兼容

## 产品规则

1. Windows CMD 将 `nul` 视为空设备（丢弃输出），而 POSIX 系 shell（Git Bash、bash、zsh）把 `nul` 当作普通文件名；会话命令中的 `>nul`、`2>nul` 在 POSIX 系 shell 下执行时会在 cwd 留下名为 `nul` 的垃圾文件。
2. 执行适配层在解析 spawn 命令时，若目标 shell dialect 为 `git-bash` 或 `posix`，必须把输出重定向目标 `nul` 归一化为 `/dev/null`，重定向语义保持不变；dialect 为 `cmd` 时 `nul` 本就是空设备，不改写。
3. 归一化覆盖 `>` 与 `>>` 及 `1`/`2`/`&` 前缀形式；输入重定向 `<nul` 不会创建文件，不在处理范围。
4. 归一化只发生在执行边界（执行适配层），是唯一写入点；不改写会话历史，不依赖模型侧配合，对 Bash 工具权限判定与输出处理透明。

## 状态与所有者

- 改写所有者：`apps/zcode-cli/packages/adapters` 执行适配层（`resolveExecutionCommand`、`applyResolvedShellCommand` 与 shell provider 命令构造）。
- 不引入第二份状态；所有 POSIX 系 shell 命令都经过同一漏斗改写，无并行写入路径。

## 验收场景

- Windows + Git Bash 下执行 `dir /s /b LICENSE* > nul 2>&1`，工作区不产生 `nul` 文件，stdout/stderr 丢弃语义不变。
- 用户显式选择 CMD 作为 Bash 工具 shell 时，`dir > nul` 保持 CMD 空设备语义，命令原样传递。
- `> null`、`> nul.txt`、heredoc 分隔符 `<<nul` 等非设备名用法不受影响。
- macOS/Linux 的 `posix` dialect 下同样归一化，防止平台混淆产生垃圾文件。
