/**
 * ZCode → LCode 品牌迁移的用户/工作区数据目录迁移（复制式）。
 *
 * 依据 specs/brand-migration-lcode.md 第 0 步决策与报告注意事项第 1 节的安全约束：
 * - 首次启动自动触发；以「新目录已存在」为完成标记，重复调用幂等跳过；
 * - 整目录复制到临时目录 → 校验 → 原子切换 → 保留源目录（回滚无损）；
 * - 失败即清理临时目录并保持源数据原样，严禁删除或改写源目录；
 * - 不引入额外目录锁：并发迁移靠 rename 的 EEXIST 竞争裁决，输家清理临时目录，
 *   最坏情况只是重复一次复制工作量，结果仍一致。
 *
 * 同步变体供启动最早期的引导路径使用（desktop 早期引导必须在读取 setting.json
 * 之前完成迁移，无法等待异步 IO）；异步变体只是同步实现的包装。
 */
import { join } from "node:path";
import { cpSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";

export const LEGACY_HOME_DATA_DIR = ".zcode";
export const HOME_DATA_DIR = ".lcode";
export const LEGACY_WORKSPACE_PLUGIN_DIR = ".zcode-plugin";
export const WORKSPACE_PLUGIN_DIR = ".lcode-plugin";

export type BrandDirMigrationStatus = "migrated" | "skipped" | "missing" | "failed";

export interface BrandDirMigrationOutcome {
  source: string;
  target: string;
  status: BrandDirMigrationStatus;
  /** status === "failed" 时的一句话原因 */
  error?: string;
}

export interface BrandDataMigrationSummary {
  outcomes: BrandDirMigrationOutcome[];
}

function describeMismatch(
  source: Map<string, number>,
  copy: Map<string, number>,
): string {
  const missing: string[] = [];
  let checked = 0;
  for (const [path, size] of source) {
    checked += 1;
    if (copy.get(path) !== size) missing.push(path);
    if (missing.length >= 3) break;
  }
  if (checked === 0) return "source tree is empty";
  return missing.length > 0
    ? `copied files differ: ${missing.join(", ")}`
    : "entry sets differ";
}

/** 同步核心：把 sourceDir 复制式迁移到 targetDir（见模块头注释的安全约束）。 */
export function migrateDirCopyStyleSync(
  sourceDir: string,
  targetDir: string,
): BrandDirMigrationOutcome {
  const isDirectory = (path: string): boolean => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  };
  const collectFileSizes = (root: string): Map<string, number> => {
    const sizes = new Map<string, number>();
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const absolute = join(entry.parentPath, entry.name);
      sizes.set(absolute.slice(root.length + 1), statSync(absolute).size);
    }
    return sizes;
  };

  if (isDirectory(targetDir)) {
    return { source: sourceDir, target: targetDir, status: "skipped" };
  }
  if (!isDirectory(sourceDir)) {
    return { source: sourceDir, target: targetDir, status: "missing" };
  }
  const tempDir = `${targetDir}.migrating-${process.pid}-${Date.now()}`;
  try {
    cpSync(sourceDir, tempDir, {
      recursive: true,
      preserveTimestamps: true,
      // 符号链接按链接本身复制（默认行为），避免把链接目标复制成实体导致体积膨胀。
      dereference: false,
      errorOnExist: true,
      force: false,
    });
    const sourceSizes = collectFileSizes(sourceDir);
    const copySizes = collectFileSizes(tempDir);
    if (
      sourceSizes.size !== copySizes.size ||
      [...sourceSizes].some(([path, size]) => copySizes.get(path) !== size)
    ) {
      throw new Error(`copy validation failed: ${describeMismatch(sourceSizes, copySizes)}`);
    }
    try {
      renameSync(tempDir, targetDir);
      return { source: sourceDir, target: targetDir, status: "migrated" };
    } catch (error) {
      // 竞争输家：目标已被并发迁移创建。按幂等语义视为 skipped。
      if (isDirectory(targetDir)) {
        return { source: sourceDir, target: targetDir, status: "skipped" };
      }
      throw error;
    }
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    return {
      source: sourceDir,
      target: targetDir,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 对迁移副本内的 JSON 文件做旧品牌键 → 新品牌键的别名补写（add-if-absent，幂等）。
 * 只改写目标副本；凭据/设置读取端按新键取值，老用户数据因此无缝可见。
 * 尽力而为：单个文件失败不影响迁移结果（源目录仍原样保留，可重登录恢复）。
 */
function aliasJsonKeysInPlace(filePath: string, aliases: readonly (readonly [string, string])[]): void {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const record = parsed as Record<string, unknown>;
    let changed = false;
    for (const [legacyKey, newKey] of aliases) {
      if (legacyKey in record && !(newKey in record)) {
        record[newKey] = record[legacyKey];
        changed = true;
      }
    }
    if (changed) writeFileSync(filePath, JSON.stringify(record, null, 2));
  } catch {
    // 非致命：别名补写失败时用户最多需要重新登录一次；源目录数据不受影响。
  }
}

/** 用户级数据根迁移（同步）：~/.zcode → ~/.lcode。幂等。 */
export function migrateHomeBrandDataRootSync(homeDir: string): BrandDirMigrationOutcome {
  const outcome = migrateDirCopyStyleSync(join(homeDir, LEGACY_HOME_DATA_DIR), join(homeDir, HOME_DATA_DIR));
  if (outcome.status === "migrated") {
    // 旧键别名补写：凭据与设置读取端按新键取值（specs/brand-migration-lcode.md 兼容读取清单）。
    aliasJsonKeysInPlace(join(homeDir, HOME_DATA_DIR, "v2", "credentials.json"), [
      ["zcodejwttoken", "lcodejwttoken"],
    ] as const);
    aliasJsonKeysInPlace(join(homeDir, HOME_DATA_DIR, "v2", "setting.json"), [
      ["zcodeEndpointOrigin", "lcodeEndpointOrigin"],
    ] as const);
  }
  return outcome;
}

/** 工作区级目录迁移（同步）：<workspace>/.zcode → .lcode、.zcode-plugin → .lcode-plugin。幂等。 */
export function migrateWorkspaceBrandDirsSync(workspacePath: string): BrandDataMigrationSummary {
  return {
    outcomes: [
      migrateDirCopyStyleSync(join(workspacePath, LEGACY_HOME_DATA_DIR), join(workspacePath, HOME_DATA_DIR)),
      migrateDirCopyStyleSync(join(workspacePath, LEGACY_WORKSPACE_PLUGIN_DIR), join(workspacePath, WORKSPACE_PLUGIN_DIR)),
    ],
  };
}

/** 把 sourceDir 复制式迁移到 targetDir（异步包装；语义与同步变体一致）。 */
export async function migrateDirCopyStyle(
  sourceDir: string,
  targetDir: string,
): Promise<BrandDirMigrationOutcome> {
  return migrateDirCopyStyleSync(sourceDir, targetDir);
}

/** 用户级数据根迁移（异步包装）：~/.zcode → ~/.lcode。幂等。 */
export async function migrateHomeBrandDataRoot(homeDir: string): Promise<BrandDirMigrationOutcome> {
  return migrateHomeBrandDataRootSync(homeDir);
}

/** 工作区级目录迁移（异步包装）：见 migrateWorkspaceBrandDirsSync。 */
export async function migrateWorkspaceBrandDirs(workspacePath: string): Promise<BrandDataMigrationSummary> {
  return migrateWorkspaceBrandDirsSync(workspacePath);
}
