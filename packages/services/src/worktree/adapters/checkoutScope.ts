import { realpath } from "node:fs/promises";
import { dirname, posix, relative, resolve, win32 } from "node:path";
import type { WorktreeBinding, WorktreeScope } from "../contract.js";

export function isCheckoutPathWithin(
  root: string,
  target: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const paths = platform === "win32" ? win32 : posix;
  const normalize = (path: string) =>
    platform === "win32" ? paths.resolve(path).toLowerCase() : paths.resolve(path);
  const child = paths.relative(normalize(root), normalize(target));
  return child !== ".." && !child.startsWith(`..${paths.sep}`) && !paths.isAbsolute(child);
}

/** 停止与重启 admission 共享实际目录/身份边界，防止后台读取重新占用正在删除的工作树。 */
export async function isOwnedCheckoutScope(
  binding: Pick<WorktreeBinding, "checkoutPath" | "workspaceIdentity">,
  scope: WorktreeScope,
): Promise<boolean> {
  if (
    (binding.workspaceIdentity?.trim() || "") !== (scope.workspaceIdentity?.trim() || "") ||
    !isCheckoutPathWithin(
      process.platform === "darwin" ? binding.checkoutPath.toLowerCase() : binding.checkoutPath,
      process.platform === "darwin" ? scope.workspacePath.toLowerCase() : scope.workspacePath,
    )
  )
    return false;
  const [root, target] = await Promise.all([
    canonicalPath(binding.checkoutPath),
    canonicalPath(scope.workspacePath),
  ]);
  return isCheckoutPathWithin(root, target);
}

async function canonicalPath(path: string): Promise<string> {
  const requested = resolve(path);
  let parent = requested;
  while (true) {
    try {
      return resolve(await realpath(parent), relative(parent, requested));
    } catch (error) {
      // 删除中及已删除路径可能不存在；仍验证最近的实际祖先，排除重定向到树外的链接。
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const next = dirname(parent);
      if (next === parent) throw error;
      parent = next;
    }
  }
}
