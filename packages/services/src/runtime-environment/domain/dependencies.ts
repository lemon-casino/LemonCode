import type { DependencyReceipt } from "@lcode/shared";
import { isSha256Digest, LOCKFILE_MANAGERS, type ProjectDeclarations } from "./declarations.js";

/** 依赖安装计划与收据新鲜度（spec §11.1）：只采用明确锁文件，不猜 manager 或伪造内容摘要。 */
export interface DependencyInstallPlan {
  manager: "pnpm" | "npm";
  managerVersion?: string;
  command: string;
  lockDigest: string;
}

/** 无锁返回 null = 非冻结策略；声明无效仍由 app 按 issues 结算，不能当作成功跳过。 */
export function buildDependencyInstallPlan(
  declarations: ProjectDeclarations,
): DependencyInstallPlan | null {
  if (declarations.ambiguousLocks || declarations.issues.length) return null;
  const declared = declarations.packageManager;
  const managers = new Set(declarations.lockfiles.map(({ name }) => LOCKFILE_MANAGERS[name]));
  if (!declared && managers.size !== 1) return null;
  const manager = declared?.key ?? managers.values().next().value;
  if (manager !== "pnpm" && manager !== "npm") return null;
  // 不能按数组顺序优先 pnpm；显式 npm 项目混有其它锁时只使用 npm 的安装命令与字节摘要。
  const name = manager === "pnpm" ? "pnpm-lock.yaml" : "package-lock.json";
  const lockfile = declarations.lockfiles.find((entry) => entry.name === name);
  if (!lockfile || !isSha256Digest(lockfile.digest)) return null;
  return {
    manager,
    ...(declared ? { managerVersion: declared.version } : {}),
    command: manager === "pnpm" ? "pnpm install --frozen-lockfile" : "npm ci",
    lockDigest: lockfile.digest,
  };
}

/** pnpm 显式 clone-or-copy，不依靠可能硬链接的 auto（spec §11.1）。 */
export const PNPM_IMPORT_METHOD_ENV: Readonly<Record<string, string>> = {
  npm_config_package_import_method: "clone-or-copy",
};

/** 实际工具/manifest 证据缺失或不匹配时重装；旧内存调用未传扩展身份时保留原接口。 */
export function isReceiptFresh(
  receipt: DependencyReceipt | null,
  plan: DependencyInstallPlan,
  identity: {
    declarationDigest: string;
    nodeVersion: string;
    platform: string;
    arch: string;
    managerVersion?: string;
    manifestDigest?: string;
  },
): boolean {
  if (!receipt || receipt.strategy !== "frozen" || receipt.exitCode !== 0) return false;
  return (
    receipt.manager === plan.manager &&
    receipt.command === plan.command &&
    receipt.lockDigest === plan.lockDigest &&
    receipt.declarationDigest === identity.declarationDigest &&
    receipt.nodeVersion === identity.nodeVersion &&
    receipt.platform === identity.platform &&
    receipt.arch === identity.arch &&
    (identity.managerVersion === undefined || receipt.managerVersion === identity.managerVersion) &&
    (identity.manifestDigest === undefined || receipt.manifestDigest === identity.manifestDigest)
  );
}
