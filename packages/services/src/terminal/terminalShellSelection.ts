import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import type { IntegratedTerminalShellSelection } from "@zcode/shared";

export async function resolveConfiguredTerminalShell(
  selection: IntegratedTerminalShellSelection | undefined,
  autoShell: string,
  isExecutable: (path: string) => Promise<boolean> = async (path) => {
    try {
      await access(path, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
): Promise<string> {
  if (selection?.mode !== "shell" || !(await isExecutable(selection.path))) return autoShell;
  return selection.path;
}
