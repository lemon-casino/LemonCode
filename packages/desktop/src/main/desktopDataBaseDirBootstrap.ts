import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { app } from "electron";
import { migrateDirCopyStyleSync } from "@lcode/shared/node";
import { setDataBaseDir } from "@lcode/services/node";
import { runtimeApplicationName, runtimeUserDataPath } from "./desktopRuntimeEnv.js";

function resolveBootstrapSettingsFile(homePath: string = homedir()): string {
  return join(homePath, ".lcode", "v2", "setting.json");
}

function extractBootstrapDataBaseDir(rawValue: unknown): string | null {
  if (!rawValue || typeof rawValue !== "object") {
    return null;
  }

  const dataBaseDir = (rawValue as { dataBaseDir?: unknown }).dataBaseDir;
  if (typeof dataBaseDir !== "string") {
    return null;
  }

  const trimmed = dataBaseDir.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readBootstrapDataBaseDirFromDisk(
  settingsFile: string = resolveBootstrapSettingsFile(),
): string | null {
  if (!existsSync(settingsFile)) {
    return null;
  }

  try {
    const raw = readFileSync(settingsFile, "utf-8");
    return extractBootstrapDataBaseDir(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function applyEarlyDataBaseDirBootstrap(): string | null {
  const dataBaseDir = readBootstrapDataBaseDirFromDisk();
  if (dataBaseDir) {
    // 启动早期就把 dataBaseDir 注入进来，避免 logger / crashReporter 先按默认 HOME 建目录，
    // 导致后续再切换到自定义目录时，日志和 crash dump 落在两套路径里。
    setDataBaseDir(dataBaseDir);
  }
  return dataBaseDir;
}

// 品牌迁移（复制式、幂等）：旧 appData/<ZCode 系身份> → 新 appData/<LCode 系身份>，
// 并把旧 Chromium 分区目录迁到新分区名，避免丢嵌入式浏览器会话与 Coding Plan 登录态。
// 旧目录保留（并列安装形态下旧版应用继续读旧 appData，数据不受影响）。
export function migrateDesktopIdentityDataSync(): void {
  const appData = app.getPath("appData");
  // runtimeApplicationName 取 "LCode" | "LCode Preview" | "LCode Dev"；旧身份仅前缀不同。
  const legacyUserData = join(appData, runtimeApplicationName.replace(/^LCode/, "ZCode"));
  migrateDirCopyStyleSync(legacyUserData, runtimeUserDataPath);
  for (const [legacyPartition, partition] of [
    ["persist:zcode-embedded-browser", "persist:lcode-embedded-browser"],
    ["persist:zcode-coding-plan", "persist:lcode-coding-plan"],
  ] as const) {
    migrateDirCopyStyleSync(join(legacyUserData, "Partitions", legacyPartition), join(runtimeUserDataPath, "Partitions", partition));
  }
}
