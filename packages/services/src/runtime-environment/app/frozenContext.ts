import { randomUUID } from "node:crypto";
import { dirname, resolve, sep } from "node:path";
import type { RuntimeEnvironmentRecord } from "@lcode/shared";
import type { ResolvedProjectExecutionContext } from "../contract.js";
import { isConsumableStatus } from "../domain/state.js";
import type { RuntimeEnvironmentStore } from "./ports.js";

/**
 * 冻结上下文构建与 cwd 归属匹配（spec §9.2/§9.3，P2-03）。
 * 从 app service 抽出保持文件有界；纯查询：读 manifest 记录，不写状态、不创建资源。
 */

/**
 * 按 checkout cwd 匹配所属环境：环境记录 scope 即 checkout 路径，
 * 命中条件为路径相等或位于其下（分隔符边界），取最长前缀；非消费态跳过。
 */
export function matchEnvironmentForCwd(
  records: RuntimeEnvironmentRecord[],
  cwd: string,
): RuntimeEnvironmentRecord | null {
  const normalize = (value: string) =>
    process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
  const target = normalize(cwd);
  let best: RuntimeEnvironmentRecord | null = null;
  let bestLength = -1;
  for (const record of records) {
    if (!isConsumableStatus(record.status)) continue;
    const scopePath = normalize(record.scope.workspacePath);
    if (target !== scopePath && !target.startsWith(scopePath + sep)) continue;
    if (scopePath.length > bestLength) {
      best = record;
      bestLength = scopePath.length;
    }
  }
  return best;
}

/** 每命令一份不可变冻结上下文；resourceLeaseToken 仅内部，不进协议与 UI（spec §9.2）。 */
export async function buildFrozenContext(
  store: RuntimeEnvironmentStore,
  record: RuntimeEnvironmentRecord,
  executionScope: { workspacePath: string; workspaceIdentity?: string },
): Promise<ResolvedProjectExecutionContext> {
  if (!isConsumableStatus(record.status))
    throw new Error(
      `Runtime environment ${record.environmentId} is ${record.status}, not consumable`,
    );
  const manifest = await store.readManifest(record.environmentId, record.currentRevision);
  if (!manifest)
    throw new Error(`Runtime environment ${record.environmentId} has no frozen manifest`);
  const toolPaths: Record<string, string> = {};
  for (const tool of manifest.tools) {
    if (tool.toolPath) toolPaths[tool.key] = tool.toolPath;
  }
  // PATH 前缀 = 冻结工具目录（spec §9.2：实际 spawn 的工具版本与 manifest 一致）。
  // base:"inherit" 表示 spawn 时继承宿主环境；set.PATH 在其上叠加工具目录前缀，
  // 不修改 Host/Agent process.env（spec §16.1）。
  const toolDirs = [...new Set(Object.values(toolPaths).map((toolPath) => dirname(toolPath)))];
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  const delimiter = process.platform === "win32" ? ";" : ":";
  const hostPath = process.env[pathKey] ?? process.env.PATH ?? "";
  return {
    environmentId: record.environmentId,
    revision: record.currentRevision,
    manifestDigest: manifest.declarationDigest,
    executionScope,
    cwd: executionScope.workspacePath,
    toolPaths,
    envOverlay: {
      base: "inherit",
      set: toolDirs.length
        ? { [pathKey]: [...toolDirs, hostPath].filter(Boolean).join(delimiter) }
        : {},
      unset: [],
    },
    resourceLeaseToken: `lease-${randomUUID()}`,
  };
}
