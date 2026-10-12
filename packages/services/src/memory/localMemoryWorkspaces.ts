import { lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, isAbsolute, resolve } from "node:path";
import { isRemoteWorkspaceIdentity, localProjectPathKey, type AppSettings } from "@lcode/shared";
import type { IWorktreeService, WorktreeBinding } from "../worktree/contract.js";
import { prepareProjectMemoryStorage } from "@lcode/shared/node";
import { getConversationWorkspaceDir } from "../paths.js";
import { isMemoryNotFound } from "./projectMemoryCatalog.js";

export interface LocalMemoryWorkspace {
  workspacePath: string;
  workspaceIdentity?: string;
  label: string;
  worktreeBinding?: WorktreeBinding;
}

export type MemoryWorktreeService = Pick<
  IWorktreeService,
  "list" | "acquireCheckout" | "releaseCheckout"
>;

function isLocalPath(path: string): boolean {
  return (
    isAbsolute(path) &&
    !/^[\\/]{2}/u.test(path) &&
    (process.platform !== "win32" || /^[A-Za-z]:[\\/]/u.test(path))
  );
}

function localProjectPaths(settings?: AppSettings): string[] {
  const explicit = [
    getConversationWorkspaceDir(),
    ...(settings?.localProjects ?? []).map((project) => project.primaryFolderPath),
    ...(settings?.lastWorkspaceSession ?? []).flatMap((entry) =>
      entry.kind === "local" ? [entry.workspacePath] : [],
    ),
  ];
  const remote = new Set(
    (settings?.lastWorkspaceSession ?? []).flatMap((entry) =>
      entry.kind === "remote" ? [localProjectPathKey(entry.workspacePath)] : [],
    ),
  );
  const explicitKeys = new Set(explicit.map(localProjectPathKey));
  const paths = [
    ...explicit,
    ...(settings?.recentProjects ?? []).filter(
      (path) =>
        !remote.has(localProjectPathKey(path)) || explicitKeys.has(localProjectPathKey(path)),
    ),
  ];
  const unique = new Map<string, string>();
  for (const path of paths) {
    // 最近项目可以包含远端标识；本地服务只接受本机绝对路径，不解析远端路径做 IO。
    if (isLocalPath(path)) unique.set(localProjectPathKey(resolve(path)), resolve(path));
  }
  return [...unique.values()];
}

const UNAVAILABLE_WORKTREE_STATUSES = new Set<WorktreeBinding["status"]>([
  "archived",
  "missing",
  "cancelled",
  "deleting",
  "deleted",
]);

function isAvailableLocalWorktree(binding: WorktreeBinding): boolean {
  return (
    !UNAVAILABLE_WORKTREE_STATUSES.has(binding.status) &&
    isLocalPath(binding.workspacePath) &&
    !isRemoteWorkspaceIdentity(binding.workspaceIdentity?.trim() || "") &&
    !isRemoteWorkspaceIdentity(binding.originalWorkspaceIdentity?.trim() || "")
  );
}

export async function listLocalMemoryWorkspaces(
  settings?: AppSettings,
  worktreeService?: Pick<IWorktreeService, "list">,
): Promise<LocalMemoryWorkspace[]> {
  const projects = localProjectPaths(settings);
  const unique = new Map<string, LocalMemoryWorkspace>();
  const unavailable = new Set<string>();
  function scopeKey(scope: { workspacePath: string; workspaceIdentity?: string }) {
    return JSON.stringify([
      localProjectPathKey(resolve(scope.workspacePath)),
      scope.workspaceIdentity?.trim() || "",
    ]);
  }
  function add(scope: LocalMemoryWorkspace) {
    const path = resolve(scope.workspacePath);
    // identity 保持共享 resolver 的归属；项目内文件仍位于实际执行路径，同一路径不同 identity 不合并。
    const key = scopeKey(scope);
    unique.set(key, { ...scope, workspacePath: path });
  }
  for (const path of projects) add({ workspacePath: path, label: basename(path) });
  if (worktreeService) {
    for (const workspacePath of projects) {
      for (const binding of await worktreeService.list({ workspacePath })) {
        if (UNAVAILABLE_WORKTREE_STATUSES.has(binding.status)) unavailable.add(scopeKey(binding));
        if (!isAvailableLocalWorktree(binding)) continue;
        // 原因：工作树不一定进最近项目，固定 checkout 根也可能已更改；必须从绑定 owner 读执行项目路径。
        // 嵌套项目的 workspacePath 与 checkoutPath 不同，记忆归属须与 Runtime 的初始项目根一致。
        add({
          workspacePath: binding.workspacePath,
          workspaceIdentity: binding.workspaceIdentity,
          label: `${basename(binding.originalWorkspacePath)} / ${binding.displayName ?? binding.branch}`,
          worktreeBinding: binding,
        });
      }
    }
  }
  // 旧 recentProjects 可能仍留着正在删除的 checkout，不能绕过绑定生命周期重新作为普通项目迁移。
  for (const key of unavailable) unique.delete(key);
  const existing: LocalMemoryWorkspace[] = [];
  for (const scope of unique.values()) {
    try {
      const stat = await lstat(scope.workspacePath);
      if (stat.isSymbolicLink())
        throw new Error("Project Memory workspace directory cannot be a link");
      if (stat.isDirectory()) existing.push(scope);
    } catch (error) {
      if (!isMemoryNotFound(error)) throw error;
    }
  }
  return existing;
}

const MEMORY_CHECKOUT_LEASE_WAIT_MS = 1;

export async function prepareLocalMemoryStorage(
  workspace: LocalMemoryWorkspace,
  input: Parameters<typeof prepareProjectMemoryStorage>[0],
  worktreeService?: MemoryWorktreeService,
) {
  const binding = workspace.worktreeBinding;
  if (!binding) return prepareProjectMemoryStorage(input);
  if (!worktreeService) throw new Error("Project Memory worktree owner is unavailable");
  // 原因：发现与复制之间可能已开始归档/删除，单次 lstat 不能保护工作树目录生命周期。
  // 复用原 checkout shared lease 并在锁内重读 owner，防止复制创建已删除目录；不等待独占 writer。
  const lease = await worktreeService.acquireCheckout({
    workspacePath: binding.checkoutPath,
    workspaceIdentity: binding.workspaceIdentity,
    ownerId: `memory-storage:${randomUUID()}`,
    mode: "shared",
    waitMs: MEMORY_CHECKOUT_LEASE_WAIT_MS,
  });
  try {
    const current = (
      await worktreeService.list({
        workspacePath: binding.originalWorkspacePath,
        workspaceIdentity: binding.originalWorkspaceIdentity,
      })
    ).find((candidate) => candidate.id === binding.id);
    if (
      !current ||
      !isAvailableLocalWorktree(current) ||
      localProjectPathKey(current.workspacePath) !== localProjectPathKey(binding.workspacePath) ||
      localProjectPathKey(current.checkoutPath) !== localProjectPathKey(binding.checkoutPath) ||
      (current.workspaceIdentity?.trim() || "") !== (binding.workspaceIdentity?.trim() || "")
    )
      throw new Error("Project Memory worktree scope changed before storage preparation");
    return await prepareProjectMemoryStorage(input);
  } finally {
    await worktreeService.releaseCheckout({ token: lease.token, ownerId: lease.ownerId });
  }
}
