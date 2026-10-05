import { resolve } from "node:path";
import { replaceRemoteWorkspaceIdentityPath } from "@lcode/shared";
import type { WorktreeBinding, WorktreePrepareRequest, WorktreeScope } from "../contract.js";
import type { WorktreeContext } from "./ports.js";
import { prepareWorktreeEnvironment } from "./setup.js";
import { registerWorktreeSessionAlias } from "./sessionAliases.js";
import type { CheckoutCoordinator } from "../nodeTypes.js";
import { assertPreparationActive, preparationProgress } from "./preparation.js";
import { captureForkSource } from "./forkSource.js";
import { reserveTaskBranch } from "./branchNaming.js";
import { worktreeCapability, mappedSourcePath } from "./capability.js";

export function bindingKey(context: WorktreeContext, scope: WorktreeScope & { taskId: string }) {
  return context.store.key(
    JSON.stringify([scope.workspaceIdentity?.trim() || resolve(scope.workspacePath), scope.taskId]),
  );
}

function mappedPath(root: string, checkout: string, path: string) {
  return mappedSourcePath(root, checkout, path);
}

export function createWorktreeLifecycle(
  context: WorktreeContext,
  coordinator: CheckoutCoordinator,
) {
  const { git, store } = context;
  const capability = (params: WorktreeScope & { sourceFolderPaths?: string[] }) =>
    worktreeCapability(git, params);
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
    if (params.cancel) {
      return store.lock(store.key(`preparation-claim:${id}`), async () => {
        const binding = await store.readBinding(id);
        if (!binding || binding.requestId !== params.requestId)
          throw new Error("Preparation request does not match its owner");
        if (binding.status === "ready" || binding.status === "cancelled") return binding;
        if (!["preparing", "failed"].includes(binding.status))
          throw new Error("Worktree cannot be cancelled in its current state");
        await store.cancelPreparation(id);
        if (binding.status === "failed") {
          try {
            await assertPreparationActive(context, binding);
          } catch {
            /* 已持久取消，返回事实而非再次失败。 */
          }
          return (await store.readBinding(id))!;
        }
        return {
          ...binding,
          preparation: binding.preparation
            ? { ...binding.preparation, cancelRequested: true }
            : undefined,
        };
      });
    }
    if (params.parentBinding) return registerWorktreeSessionAlias(context, params, id, ready);
    const creationFingerprint = store.key(
      JSON.stringify({
        workspacePath: resolve(params.workspacePath),
        workspaceIdentity: params.workspaceIdentity?.trim() || "",
        projectId: params.projectId ?? "",
        baseRef: params.baseRef?.trim() || "HEAD",
        sourceFolderPaths: (params.sourceFolderPaths ?? []).map((path) => resolve(path)),
        forkSource: params.forkSource,
      }),
    );
    return store.lock(id, async () => {
      let binding = await store.readBinding(id);
      if (binding && ["deleting", "deleted"].includes(binding.status))
        throw new Error("Worktree has been deleted; create a new task");
      // 归档恢复只能取回文件，不能把已取消的首条输入请求重新变成可执行请求。
      if (binding && (binding.status === "cancelled" || (await store.isPreparationCancelled(id))))
        throw new Error("Worktree preparation cancelled; submit a new request");
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
          preparation: {
            stage: "workspace",
            log: "Preparing workspace.\n",
            logTruncated: false,
            cancelRequested: false,
            environmentSource: params.setupCommands ? "explicit" : "none",
          },
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
        binding = await reserveTaskBranch(context, binding, params.taskName);
      }
      await store.savePreparationRequest(
        params.workspaceIdentity?.trim() || resolve(params.workspacePath),
        params.requestId,
        id,
      );
      try {
        await assertPreparationActive(context, binding);
        if (params.forkSource && !binding.forkSnapshot) {
          binding = await captureForkSource(context, coordinator, binding, params.forkSource);
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
          binding = await preparationProgress(
            context,
            binding,
            "checkout",
            `Checking out ${binding.baseCommit}.\n`,
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
        if (binding.forkSnapshot && !binding.forkFilesRestored) {
          await git.restoreFiles({ ...binding, snapshot: binding.forkSnapshot });
          binding = { ...binding, forkFilesRestored: true };
          await store.saveBinding(binding);
        }
        await ready(binding);
        await assertPreparationActive(context, binding);
        binding = await preparationProgress(
          context,
          binding,
          "environment",
          `Worktree created at ${binding.checkoutPath}.\n`,
        );
        // 托管运行环境：首次执行前持久化环境引用（spec §7 规则 3）。
        // 未注入 port = Host 不支持托管，保持现状语义；注入后失败则准备整体失败，
        // 不静默回退非托管执行（spec §9.5：缺能力明确报告，不伪造托管成功）。
        if (context.prepareRuntimeEnvironment && !binding.environmentRef) {
          const environment = await context.prepareRuntimeEnvironment({
            bindingId: binding.id,
            checkoutPath: binding.checkoutPath,
            requestId: params.requestId,
            purpose: "worktree",
          });
          binding = {
            ...binding,
            environmentRef: {
              environmentId: environment.environmentId,
              revision: environment.revision,
            },
          };
          await store.saveBinding(binding);
          binding = await preparationProgress(
            context,
            binding,
            "environment",
            `Managed runtime environment ${environment.environmentId} at revision ${environment.revision}.\n`,
          );
        }
        if (
          !params.setupCommands &&
          binding.setup?.status === "pending" &&
          !binding.setup.commands.length
        ) {
          const commands = await context.detectSetup(binding.checkoutPath);
          binding = {
            ...binding,
            setup: { ...binding.setup, commands },
            preparation: {
              ...binding.preparation!,
              environmentSource: commands.length ? "detected" : "none",
            },
          };
          await store.saveBinding(binding);
        }
        if (params.retrySetup && binding.setup && binding.setup.status !== "completed") {
          const commands = params.setupCommands ?? binding.setup.commands;
          const copyIgnoredPaths = params.copyIgnoredPaths ?? binding.setup.copyIgnoredPaths;
          const changedCommands =
            JSON.stringify(commands) !== JSON.stringify(binding.setup.commands);
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
          // 取消与就绪用同一短锁裁决，避免最后一步完成后取消仍被误认为可切回本地。
          binding = await store.lock(store.key(`preparation-claim:${id}`), async () => {
            await assertPreparationActive(context, binding!);
            return preparationProgress(
              context,
              { ...binding!, status: "ready", error: undefined },
              "ready",
              "Workspace ready. Task checks have not run.\n",
            );
          });
          return binding;
        } finally {
          await coordinator.release(setupLease);
        }
      } catch (error) {
        const latest = (await store.readBinding(id)) ?? binding;
        if (await store.isPreparationCancelled(id)) {
          await assertPreparationActive(context, latest);
        }
        if (latest.status !== "cancelled")
          await preparationProgress(
            context,
            {
              ...latest,
              status: "failed",
              error: error instanceof Error ? error.message : String(error),
            },
            "failed",
            `Preparation failed: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        throw error;
      }
    });
  }
  async function getBinding(params: WorktreeScope & { taskId?: string; requestId?: string }) {
    const identity = params.workspaceIdentity?.trim() || resolve(params.workspacePath);
    if (!params.taskId) {
      const id = params.requestId
        ? await store.readPreparationRequest(identity, params.requestId)
        : null;
      if (!id) return null;
      const binding = await store.readBinding(id);
      if (
        !binding ||
        binding.requestId !== params.requestId ||
        (binding.originalWorkspaceIdentity?.trim() || resolve(binding.originalWorkspacePath)) !==
          identity
      )
        throw new Error("Preparation request scope mismatch");
      return {
        ...binding,
        preparation: binding.preparation
          ? { ...binding.preparation, cancelRequested: await store.isPreparationCancelled(id) }
          : undefined,
      };
    }
    let binding =
      (await store.readBinding(bindingKey(context, { ...params, taskId: params.taskId }))) ??
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
    // 删除墓碑与归档同样不检查已释放的目录，仅实际执行状态需要校验 checkout。
    if (!binding || !["ready", "restoring", "missing"].includes(binding.status)) {
      if (binding?.preparation)
        binding = {
          ...binding,
          preparation: {
            ...binding.preparation,
            cancelRequested: await store.isPreparationCancelled(binding.id),
          },
        };
      return binding ?? null;
    }
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
