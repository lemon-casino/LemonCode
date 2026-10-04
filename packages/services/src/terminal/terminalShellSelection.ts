import type { IntegratedTerminalShellSelection } from "@lcode/shared";
import { isIntegratedTerminalShellExecutable } from "../system/integratedTerminalShellPath.js";

export async function resolveConfiguredTerminalShell(
  selection: IntegratedTerminalShellSelection | undefined,
  autoShell: string,
  isExecutable: (path: string) => Promise<boolean> = (path) =>
    isIntegratedTerminalShellExecutable(path, { platform: process.platform }),
): Promise<string> {
  if (selection?.mode !== "shell" || !(await isExecutable(selection.path))) return autoShell;
  return selection.path;
}
