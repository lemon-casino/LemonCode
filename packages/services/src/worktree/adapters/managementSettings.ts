import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { atomicWritePrivateTextFile, withFileLock } from "@lcode/shared/node";
import {
  DEFAULT_WORKTREE_MANAGEMENT_SETTINGS,
  worktreeManagementSettingsSchema,
} from "@lcode/shared";
import type { WorktreeManagementSettings } from "@lcode/shared";

export function createWorktreeManagementSettings(dataDir: string) {
  const path = join(dataDir, "management.json");
  async function getManagementSettings(): Promise<WorktreeManagementSettings> {
    try {
      return worktreeManagementSettingsSchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { ...DEFAULT_WORKTREE_MANAGEMENT_SETTINGS };
      throw error;
    }
  }
  return {
    getManagementSettings,
    updateManagementSettings: (patch: Partial<WorktreeManagementSettings>) =>
      withFileLock(path, async () => {
        const next = worktreeManagementSettingsSchema.parse({
          ...(await getManagementSettings()),
          ...patch,
        });
        if (
          next.rootDirectory &&
          (!isAbsolute(next.rootDirectory) || /[\0\r\n]/.test(next.rootDirectory))
        )
          throw new Error("Worktree root must be an absolute path without control characters");
        await atomicWritePrivateTextFile(path, `${JSON.stringify(next)}\n`);
        return next;
      }),
  };
}
