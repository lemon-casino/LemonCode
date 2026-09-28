// 修复依据：Windows CMD 把 nul 当作空设备，命令普遍写成 `>nul`、`2>nul`；而 Git Bash
// 等 POSIX 系 shell 中 nul 只是普通文件名，重定向会在 cwd 创建名为 nul 的垃圾文件
// （会话工作区反复出现）。Bash 工具在 Windows 上默认自动探测 Git Bash（dialect
// "git-bash"），按 win32 习惯生成的 nul 重定向于是反复落盘。本模块在已确认目标
// shell 为 POSIX 系（git-bash/posix）的前提下，把重定向目标 nul 归一化为 /dev/null，
// 丢弃语义等价且不再产生文件；dialect "cmd" 下 nul 本就是空设备，调用方必须保持原样。
// 仅处理输出重定向（> / >>，含 1/2/& 前缀）；`<nul` 输入重定向不会创建文件，不处理。
// 已知局限：不做完整 shell 词法分析，引号字符串内的 `> nul` 字面量也会被改写，
// 属于换取确定性垃圾文件防护的可接受取舍。
const CMD_NUL_REDIRECTION_PATTERN = /([012&]?>>?)[ \t]*nul(?![A-Za-z0-9_./\\-])/gi;

export function normalizeCmdNulRedirectionForPosixShell(command: string): string {
  return command.replace(CMD_NUL_REDIRECTION_PATTERN, "$1/dev/null");
}
