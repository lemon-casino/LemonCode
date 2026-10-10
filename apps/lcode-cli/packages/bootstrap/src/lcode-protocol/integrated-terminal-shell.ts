import type { ExecutionShellSelection } from "@lcode/contracts";
import type { IntegratedTerminalShellSelection } from "@lcode/shared";

export function integratedTerminalShellToExecutionSelection(
  selection: IntegratedTerminalShellSelection | undefined,
): ExecutionShellSelection | undefined {
  // 设置协议已经验证方言；再做兼容白名单会丢失用户选择并静默切到 Git Bash。
  if (!selection || selection.mode === "auto") return undefined;
  return {
    display: { name: selection.label },
    dialect: selection.dialect,
    id: selection.id,
    label: selection.label,
    path: selection.path,
    source: "user-config",
  };
}
