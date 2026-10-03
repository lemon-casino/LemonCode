import type { WorktreeBinding } from "@lcode/services";
import { replaceRemoteWorkspaceIdentityPath } from "@lcode/shared";
import { joinFilePath } from "./lib/path.js";

export function resolveWorktreeFileTarget<
  T extends { workspacePath: string; workspaceIdentity?: string; revealPath?: string },
>(target: T, binding?: WorktreeBinding): T {
  if (
    !binding ||
    (target.workspaceIdentity?.trim() || "") !== (binding.originalWorkspaceIdentity?.trim() || "")
  )
    return target;
  const normal = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");
  const root = normal(binding.repositoryRoot);
  const relative = (path: string) => {
    const value = normal(path);
    const comparableRoot = /^[A-Za-z]:/.test(root) ? root.toLowerCase() : root;
    const comparableValue = /^[A-Za-z]:/.test(root) ? value.toLowerCase() : value;
    if (comparableValue !== comparableRoot && !comparableValue.startsWith(`${comparableRoot}/`))
      return null;
    const suffix = value.slice(root.length).replace(/^\//, "");
    return suffix.split("/").some((segment) => segment === ".." || segment === ".") ? null : suffix;
  };
  const suffix = relative(target.workspacePath);
  if (suffix === null) return target;
  const mapPath = (path?: string) => {
    if (!path) return path;
    const child = relative(path);
    return child === null ? path : joinFilePath(binding.checkoutPath, child);
  };
  const workspacePath = joinFilePath(binding.checkoutPath, suffix);
  const workspaceIdentity = binding.workspaceIdentity
    ? (replaceRemoteWorkspaceIdentityPath(binding.workspaceIdentity, workspacePath) ??
      binding.workspaceIdentity)
    : undefined;
  return { ...target, workspacePath, workspaceIdentity, revealPath: mapPath(target.revealPath) };
}
