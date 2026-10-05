import type { DependencyReceipt } from "@lcode/shared";
import type { ProjectDeclarations } from "./declarations.js";

/**
 * 依赖安装计划与收据新鲜度（spec: specs/worktree-runtime-environments.md §11.1，P2-06）。
 * 只采用明确锁文件；多 manager 锁歧义在上游 declarations.issues 已拦截，不猜测。
 * 收据覆盖声明指纹/锁摘要/Node ABI（版本）/平台；不匹配即重装，不能因目录存在跳过。
 */

export interface DependencyInstallPlan {
  manager: "pnpm" | "npm" | "yarn" | "bun";
  command: string;
  lockDigest: string;
}

/** 从声明解析结果推导安装命令；无锁文件返回 null = 非冻结策略，不执行伪造 frozen 安装。 */
export function buildDependencyInstallPlan(
  declarations: ProjectDeclarations,
): DependencyInstallPlan | null {
  if (declarations.ambiguousLocks) return null;
  const digestOf = (name: string) =>
    declarations.lockfiles.find((lockfile) => lockfile.name === name)?.digest ?? "";
  if (declarations.lockfiles.some((lockfile) => lockfile.name === "pnpm-lock.yaml"))
    return {
      manager: "pnpm",
      command: "pnpm install --frozen-lockfile",
      lockDigest: digestOf("pnpm-lock.yaml"),
    };
  if (declarations.lockfiles.some((lockfile) => lockfile.name === "package-lock.json"))
    return { manager: "npm", command: "npm ci", lockDigest: digestOf("package-lock.json") };
  if (declarations.lockfiles.some((lockfile) => lockfile.name === "yarn.lock"))
    return {
      manager: "yarn",
      command: "yarn install --frozen-lockfile",
      lockDigest: digestOf("yarn.lock"),
    };
  if (
    declarations.lockfiles.some(
      (lockfile) => lockfile.name === "bun.lock" || lockfile.name === "bun.lockb",
    )
  )
    return {
      manager: "bun",
      command: "bun install --frozen-lockfile",
      lockDigest: digestOf("bun.lock"),
    };
  return null;
}

/** pnpm 显式 clone-or-copy，不依靠可能硬链接的 auto（spec §11.1）。 */
export const PNPM_IMPORT_METHOD_ENV: Readonly<Record<string, string>> = {
  npm_config_package_import_method: "clone-or-copy",
};

/** 收据仍是当前声明/ABI/平台的有效安装证明时返回 true（幂等重试复用已完成步骤）。 */
export function isReceiptFresh(
  receipt: DependencyReceipt | null,
  plan: DependencyInstallPlan,
  identity: { declarationDigest: string; nodeVersion: string; platform: string; arch: string },
): boolean {
  if (!receipt || receipt.strategy !== "frozen" || receipt.exitCode !== 0) return false;
  return (
    receipt.manager === plan.manager &&
    receipt.command === plan.command &&
    receipt.lockDigest === plan.lockDigest &&
    receipt.declarationDigest === identity.declarationDigest &&
    receipt.nodeVersion === identity.nodeVersion &&
    receipt.platform === identity.platform &&
    receipt.arch === identity.arch
  );
}
