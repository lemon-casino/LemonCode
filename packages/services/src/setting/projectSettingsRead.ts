import { readFile, writeFile } from "node:fs/promises";
import { appSettingsSchema } from "@lcode/shared";
import { migrateLegacyAccountConnectionSettings } from "./legacyAccountConnectionSettings.js";

/** 中文依据：项目 CAS 必须基于有效的完整设置，损坏时不能用默认值覆盖原文件。 */
export async function readProjectSettings(path: string) {
  let raw: string | undefined;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const settings = appSettingsSchema.parse(
    raw === undefined ? {} : migrateLegacyAccountConnectionSettings(JSON.parse(raw)),
  );
  return {
    settings,
    async backupBeforeMigration() {
      if (raw === undefined || settings.projectDefinitions) return;
      try {
        await writeFile(`${path}.before-project-definitions`, raw, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    },
  };
}
