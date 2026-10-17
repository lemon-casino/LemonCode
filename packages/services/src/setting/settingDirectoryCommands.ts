import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { copyDataDirectory, getDataBaseDir, validateDataBaseDirTarget } from "../paths.js";
import { maybeThrowInjectedFsFault } from "../fs/fsFaultInjection.js";
import type { ISettingService } from "./setting.js";

/** 目录命令仍通过同一个设置 owner 提交，不另行写设置文件。 */
export function settingDirectoryCommands(
  update: ISettingService["update"],
): Pick<ISettingService, "updateDataBaseDir" | "ensureDefaultProject"> {
  return {
    async updateDataBaseDir(newDir) {
      const currentBaseDir = getDataBaseDir();
      const targetBaseDir = newDir?.trim() || homedir();
      const validation = validateDataBaseDirTarget(targetBaseDir);
      if (!validation.ok) {
        // 中文依据：安装器管理的目录不能保存应用数据，否则升级可能覆盖数据。
        throw Object.assign(new Error(`${validation.code}: ${validation.forbiddenDir}`), {
          code: validation.code,
        });
      }
      if (currentBaseDir !== targetBaseDir) await copyDataDirectory(currentBaseDir, targetBaseDir);
      await update({ dataBaseDir: newDir });
    },
    async ensureDefaultProject(userHomeDir) {
      const path = join(userHomeDir, "LCodeProject");
      let existedBefore = true;
      await access(path).catch(() => {
        existedBefore = false;
      });
      maybeThrowInjectedFsFault({ operation: "mkdir", path });
      await mkdir(path, { recursive: true });
      return { path, created: !existedBefore };
    },
  };
}
