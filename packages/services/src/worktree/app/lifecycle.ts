import { isAbsolute, relative, resolve, sep } from "node:path";
import { replaceRemoteWorkspaceIdentityPath } from "@lcode/shared";
import type {
  WorktreeBinding,
  WorktreeCapabilities,
  WorktreePrepareRequest,
  WorktreeScope,
} from "../contract.js";
import type { WorktreeContext } from "./ports.js";
import { prepareWorktreeEnvironment } from "./setup.js";
import { registerWorktreeSessionAlias } from "./sessionAliases.js";
import type { CheckoutCoordinator } from "../nodeTypes.js";

export function bindingKey(context: WorktreeContext, scope: WorktreeScope & { taskId: string }) {
  return context.store.key(
    JSON.stringify([scope.workspaceIdentity?.trim() || resolve(scope.workspacePath), scope.taskId]),
  );
}

function mappedPath(root: string, checkout: string, path: string) {
  const child = relative(root, resolve(path));
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child))
    throw new Error("Source folders outside the Git repository cannot use a worktree");
  return resolve(checkout, child);
}

export function createWorktreeLifecycle(
  context: WorktreeContext,
  coordinator: CheckoutCoordinator,
) {
  const { git, store } = context;
  async function capability(
    params: WorktreeScope & { sourceFolderPaths?: string[] },
  ): Promise<WorktreeCapabilities> {
    try {
      const info = await git.inspect(params.workspacePath);
      for (const path of params.sourceFolderPaths ?? []) {
        mappedPath(info.root, info.root, path);
        const source = await git.inspect(path);
        if (source.commonDirectory !== info.commonDirectory)
          throw new Error("Source folders must belong to one Git repository");
      }
      const superproject = await git.command(info.root, [
        "rev-parse",
        "--show-superproject-working-tree",
      ]);
      if (superproject) throw new Error("Submodule worktrees are not supported");
      return {
        supported: true,
        create: true,
        integrate: Boolean(info.branch),
        archive: true,
        restore: true,
        repositoryRoot: info.root,
        currentBranch: info.branch,
        head: info.head,
      };
    } catch (error) {
      return {
        supported: false,
        create: false,
        integrate: false,
        archive: false,
        restore: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  async function ready(binding: WorktreeBinding) {
    await store.assertManagedPath(binding.checkoutPath);
    if (!(await git.registered(binding.repositoryRoot, binding.checkoutPath)))
      throw new Error("Managed worktree registration is missing");
    const info = await git.inspect(binding.checkoutPath);
    if (
      info.root !== binding.checkoutPath ||
      info.commonDirectory !== binding.commonDirectory ||
      info.branch !== binding.branch
    )
      throw new Error("Worktree ownership or branch has changed");
  }
  async function prepare(params: WorktreePrepareRequest): Promise<WorktreeBinding> {
    if (!params.taskId.trim() || !params.requestId.trim())
      throw new Error("Worktree request and task IDs are required");
    const id = bindingKey(context, params);
    if (params.parentBinding) return registerWorktreeSessionAlias(context, params, id, ready);
    const creationFingerprint = store.key(
      JSON.stringify({
        workspacePath: resolve(params.workspacePath),
        workspaceIdentity: params.workspaceIdentity?.trim() || "",
        projectId: params.projectId ?? "",
        baseRef: params.baseRef?.trim() || "HEAD",
        sourceFolderPaths: (params.sourceFolderPaths ?? []).map((path) => resolve(path)),
      }),
    );
    return store.lock(id, async () => {
      let binding = await store.readBinding(id);
      if (await store.readAlias(id))
        throw new Error("Forked session already uses its parent worktree");
      if (binding && binding.creationFingerprint !== creationFingerprint)
        throw new Error(
          "Worktree creation scope or base changed; use the original immutable binding",
        );
      if (binding?.status === "archived")
        throw new Error("Worktree is archived; restore it before continuing");
      if (binding?.status === "ready") {
        await ready(binding);
        return binding;
      }
      if (!binding) {
        const capabilities = await capability(params);
        if (!capabilities.supported) throw new Error(capabilities.reason);
        const info = await git.inspect(params.workspacePath);
        const checkoutPath = store.checkout(id);
        const baseRef = params.baseRef?.trim() || "HEAD";
        if (
          baseRef.startsWith("-") ||
          [...baseRef].some((character) => character.charCodeAt(0) <= 32)
        )
          throw new Error("Invalid worktree base ref");
        const baseCommit = await git.command(info.root, [
          "rev-parse",
          "--verify",
          `${baseRef}^{commit}`,
        ]);
        const workspacePath = mappedPath(info.root, checkoutPath, params.workspacePath);
        const workspaceIdentity = params.workspaceIdentity?.startsWith("remote:")
          ? (replaceRemoteWorkspaceIdentityPath(params.workspaceIdentity, workspacePath) ??
            undefined)
          : undefined;
        if (params.workspaceIdentity?.startsWith("remote:") && !workspaceIdentity)
          throw new Error("Invalid remote workspace identity");
        const now = new Date().toISOString();
        binding = {
          id,
          creationFingerprint,
          taskId: params.taskId,
          requestId: params.requestId,
          projectId: params.projectId,
          originalWorkspacePath: params.workspacePath,
          originalWorkspaceIdentity: params.workspaceIdentity,
          repositoryRoot: info.root,
          commonDirectory: info.commonDirectory,
          checkoutPath,
          workspacePath,
          workspaceIdentity,
          branch: `lcode/task-${id}`,
          baseCommit,
          targetBranch: info.branch,
          sourceFolderPaths: (params.sourceFolderPaths ?? []).map((path) =>
            mappedPath(info.root, checkoutPath, path),
          ),
          status: "preparing",
          setup: {
            commands: params.setupCommands ?? [],
            copyIgnoredPaths: params.copyIgnoredPaths ?? [],
            copied: false,
            status: "pending",
            nextCommand: 0,
            results: [],
          },
          createdAt: now,
          updatedAt: now,
        };
        await store.saveBinding(binding);
      }
      await store.assertManagedPath(binding.checkoutPath);
      const registered = await git.registered(binding.repositoryRoot, binding.checkoutPath);
      if (!registered) {
        if (await store.exists(binding.checkoutPath))
          throw new Error("Worktree destination already exists and is not registered");
        if (binding.status !== "preparing")
          throw new Error("Worktree directory is missing; explicit recovery is required");
        const ref = await git.run({
          cwd: binding.repositoryRoot,
          args: ["show-ref", "--verify", `refs/heads/${binding.branch}`],
        });
        if (ref.exitCode === 0)
          throw new Error(
            "Task branch exists without its managed worktree; manual reconciliation required",
          );
        await git.command(binding.repositoryRoot, [
          "worktree",
          "add",
          "-b",
          binding.branch,
          binding.checkoutPath,
          binding.baseCommit,
        ]);
        await context.fault("prepare.after-add");
      }
      await ready(binding);
      if (params.retrySetup && binding.setup && binding.setup.status !== "completed") {
        const commands = params.setupCommands ?? binding.setup.commands;
        const copyIgnoredPaths = params.copyIgnoredPaths ?? binding.setup.copyIgnoredPaths;
        const changedCommands = JSON.stringify(commands) !== JSON.stringify(binding.setup.commands);
        const changedPaths =
          JSON.stringify(copyIgnoredPaths) !== JSON.stringify(binding.setup.copyIgnoredPaths);
        binding = {
          ...binding,
          setup: {
            ...binding.setup,
            commands,
            copyIgnoredPaths,
            copied: binding.setup.copied && !changedPaths,
            nextCommand: changedCommands ? 0 : binding.setup.nextCommand,
            results: changedCommands ? [] : binding.setup.results,
          },
        };
        await store.saveBinding(binding);
      }
      const setupLease = await coordinator.acquire({
        workspacePath: binding.checkoutPath,
        ownerId: `setup:${binding.id}`,
      });
      try {
        binding = await prepareWorktreeEnvironment(context, binding, Boolean(params.retrySetup));
        binding = {
          ...binding,
          status: "ready",
          updatedAt: new Date().toISOString(),
          error: undefined,
        };
        await store.saveBinding(binding);
        return binding;
      } finally {
        await coordinator.release(setupLease);
      }
    });
  }
  async function getBinding(params: WorktreeScope & { taskId: string }) {
    const identity = params.workspaceIdentity?.trim() || resolve(params.workspacePath);
    let binding =
      (await store.readBinding(bindingKey(context, params))) ??
      (await store.listBindings()).find(
        (candidate) =>
          candidate.taskId === params.taskId &&
          (candidate.workspaceIdentity?.trim() || resolve(candidate.workspacePath)) === identity,
      );
    if (!binding) {
      const alias = (await store.listAliases()).find(
        (entry) =>
          entry.taskId === params.taskId &&
          [entry.originalKey, entry.executionKey].includes(identity),
      );
      if (alias) binding = (await store.readBinding(alias.bindingId)) ?? undefined;
    }
    if (!binding || binding.status === "archived") return binding ?? null;
    try {
      await ready(binding);
      return binding;
    } catch (error) {
      return {
        ...binding,
        status: "missing" as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return { capability, prepare, getBinding, ready };
}
