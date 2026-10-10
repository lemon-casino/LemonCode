import type { ExecutionShellSelection } from "@lcode/contracts";

export function supportsPosixCommandAnalysis(selection?: ExecutionShellSelection): boolean {
  // PowerShell/fish/nu/custom 的别名、表达式及引号不满足 Bash parser 契约，不能据其结果免审批。
  const dialect = selection?.dialect;
  return (
    dialect === undefined ||
    dialect === "posix" ||
    dialect === "git-bash" ||
    dialect === "sh" ||
    dialect === "cmd" ||
    dialect === "legacy-shell"
  );
}
