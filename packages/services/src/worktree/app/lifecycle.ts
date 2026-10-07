import { resolve } from "node:path";
import { replaceRemoteWorkspaceIdentityPath, runtimeEnvironmentErrorSchema } from "@lcode/shared";
import type { CheckoutLease, WorktreeBinding, WorktreePrepareRequest, WorktreeScope } from "../contract.js";
import type { WorktreeContext } from "./ports.js";
import { prepareWorktreeEnvironment } from "./setup.js";
import { registerWorktreeSessionAlias } from "./sessionAliases.js";
import type { CheckoutCoordinator } from "../nodeTypes.js";
import { assertPreparationActive, preparationProgress } from "./preparation.js";
import { captureForkSource } from "./forkSource.js";
import { reserveTaskBranch } from "./branchNaming.js";
import { worktreeCapability, mappedSourcePath } from "./capability.js";
import { bindingKey, createWorktreeBindingLookup } from "./bindingLookup.js";
import { prepareBindingRuntime, resolveBindingRuntime, cancelBindingRuntime } from "./runtimeEnvironment.js";

export function createWorktreeLifecycle(context: WorktreeContext, coordinator: CheckoutCoordinator) {
  const { git, store } = context;
  const capability = (params: WorktreeScope & { sourceFolderPaths?: string[] }) => worktreeCapability(git, params);
  async function ready(binding: WorktreeBinding) {
    await store.assertManagedPath(binding.checkoutPath);
    if (!(await git.registered(binding.repositoryRoot, binding.checkoutPath))) throw new Error("Managed worktree registration is missing");
    const info = await git.inspect(binding.checkoutPath);
    if (info.root !== binding.checkoutPath || info.commonDirectory !== binding.commonDirectory || info.branch !== binding.branch)
      throw new Error("Worktree ownership or branch has changed");
  }
  async function prepare(params: WorktreePrepareRequest): Promise<WorktreeBinding> {
    if (!params.taskId.trim() || !params.requestId.trim()) throw new Error("Worktree request and task IDs are required");
    const id = bindingKey(context, params);
    if (params.cancel) {
      const cancelled = await store.lock(store.key(`preparation-claim:${id}`), async () => {
        const binding = await store.readBinding(id);
        if (!binding || binding.requestId !== params.requestId) throw new Error("Preparation request does not match its owner");
        if (binding.status === "ready" || binding.status === "cancelled") return binding;
        if (!["preparing", "failed"].includes(binding.status)) throw new Error("Worktree cannot be cancelled in its current state");
        await store.cancelPreparation(id);
        if (binding.status === "failed") {
          try { await assertPreparationActive(context, binding); } catch { /* 取消标记已持久化。 */ }
          return (await store.readBinding(id))!;
        }
        return { ...binding, preparation: binding.preparation ? { ...binding.preparation, cancelRequested: true } : undefined };
      });
      if (cancelled.status !== "ready") await cancelBindingRuntime(context, cancelled);
      return cancelled;
    }
    if (params.parentBinding) return registerWorktreeSessionAlias(context, params, id, async (binding) => {
      await ready(binding);
      await resolveBindingRuntime(context, binding);
    });
    const creationFingerprint = store.key(JSON.stringify({
      workspacePath: resolve(params.workspacePath), workspaceIdentity: params.workspaceIdentity?.trim() || "",
      projectId: params.projectId ?? "", baseRef: params.baseRef?.trim() || "HEAD",
      sourceFolderPaths: (params.sourceFolderPaths ?? []).map((path) => resolve(path)), forkSource: params.forkSource,
    }));
    return store.lock(id, async () => {
      let binding = await store.readBinding(id);
      if (binding && ["deleting", "deleted"].includes(binding.status)) throw new Error("Worktree has been deleted; create a new task");
      if (binding && (binding.status === "cancelled" || await store.isPreparationCancelled(id))) throw new Error("Worktree preparation cancelled; submit a new request");
      if (await store.readAlias(id)) throw new Error("Forked session already uses its parent worktree");
      if (binding && binding.creationFingerprint !== creationFingerprint) throw new Error("Worktree creation scope or base changed; use the original immutable binding");
      const policy = binding ? (binding.environmentRef ? "managed" : binding.environmentPolicy ?? "local") : params.environmentPolicy === "managed" ? "managed" : "local";
      if (binding && params.environmentPolicy && params.environmentPolicy !== "inherit" && params.environmentPolicy !== policy)
        throw new Error("Worktree environment policy cannot change on an existing binding");
      if (policy === "managed" && (!context.prepareRuntimeEnvironment || !context.resolveRuntimeEnvironment)) throw new Error("Managed runtime environment capability is unavailable");
      if (binding && ["archiving", "archived", "restoring", "updating"].includes(binding.status)) throw new Error("Worktree is archived or has a pending lifecycle operation; finish it before continuing");
      if (binding?.status === "ready") {
        await ready(binding);
        await resolveBindingRuntime(context, binding);
        return binding;
      }
      if (!binding) {
        const capabilities = await capability(params);
        if (!capabilities.supported) throw new Error(capabilities.reason);
        const info = await git.inspect(params.workspacePath);
        const checkoutPath = store.checkout(id);
        const baseRef = params.baseRef?.trim() || "HEAD";
        if (baseRef.startsWith("-") || [...baseRef].some((character) => character.charCodeAt(0) <= 32)) throw new Error("Invalid worktree base ref");
        const baseCommit = await git.command(info.root, ["rev-parse", "--verify", `${baseRef}^{commit}`]);
        const workspacePath = mappedSourcePath(info.root, checkoutPath, params.workspacePath);
        const workspaceIdentity = params.workspaceIdentity?.startsWith("remote:")
          ? replaceRemoteWorkspaceIdentityPath(params.workspaceIdentity, workspacePath) ?? undefined
          : params.workspaceIdentity?.trim() || undefined;
        if (params.workspaceIdentity?.startsWith("remote:") && !workspaceIdentity) throw new Error("Invalid remote workspace identity");
        const now = new Date().toISOString();
        binding = {
          id, creationFingerprint, taskId: params.taskId, requestId: params.requestId, projectId: params.projectId,
          environmentPolicy: policy, originalWorkspacePath: params.workspacePath, originalWorkspaceIdentity: params.workspaceIdentity,
          repositoryRoot: info.root, commonDirectory: info.commonDirectory, checkoutPath, workspacePath, workspaceIdentity,
          branch: `lcode/task-${id}`, baseCommit, targetBranch: info.branch,
          sourceFolderPaths: (params.sourceFolderPaths ?? []).map((path) => mappedSourcePath(info.root, checkoutPath, path)),
          status: "preparing", preparation: { stage: "workspace", log: "Preparing workspace.\n", logTruncated: false, cancelRequested: false, environmentSource: params.setupCommands ? "explicit" : "none" },
          setup: { commands: params.setupCommands ?? [], copyIgnoredPaths: params.copyIgnoredPaths ?? [], copied: false, status: "pending", nextCommand: 0, results: [] }, createdAt: now, updatedAt: now,
        };
        binding = await reserveTaskBranch(context, binding, params.taskName);
      }
      await store.savePreparationRequest(params.workspaceIdentity?.trim() || resolve(params.workspacePath), params.requestId, id);
      let setupLease: CheckoutLease | undefined;
      try {
        await assertPreparationActive(context, binding);
        if (params.forkSource && !binding.forkSnapshot) {
          binding = await captureForkSource(context, coordinator, binding, params.forkSource);
          await store.saveBinding(binding);
        }
        await store.assertManagedPath(binding.checkoutPath);
        const registered = await git.registered(binding.repositoryRoot, binding.checkoutPath);
        if (!registered) {
          if (await store.exists(binding.checkoutPath)) throw new Error("Worktree destination already exists and is not registered");
          if (binding.status !== "preparing") throw new Error("Worktree directory is missing; explicit recovery is required");
          const ref = await git.run({ cwd: binding.repositoryRoot, args: ["show-ref", "--verify", `refs/heads/${binding.branch}`] });
          if (ref.exitCode === 0) throw new Error("Task branch exists without its managed worktree; manual reconciliation required");
          binding = await preparationProgress(context, binding, "checkout", `Checking out ${binding.baseCommit}.\n`);
          await git.command(binding.repositoryRoot, ["worktree", "add", "-b", binding.branch, binding.checkoutPath, binding.baseCommit]);
          await context.fault("prepare.after-add");
        }
        // fork 文件、工具和 setup 共用唯一独占许可；可信环境 port 复用该 writer，避免二次获取锁。
        setupLease = await coordinator.acquire({ workspacePath: binding.checkoutPath, ownerId: `setup:${binding.id}` });
        if (binding.forkSnapshot && !binding.forkFilesRestored) {
          await git.restoreFiles({ ...binding, snapshot: binding.forkSnapshot });
          binding = { ...binding, forkFilesRestored: true };
          await store.saveBinding(binding);
        }
        await ready(binding);
        await assertPreparationActive(context, binding);
        binding = await preparationProgress(context, binding, "environment", `Worktree created at ${binding.checkoutPath}.\n`);
        const prepared = await prepareBindingRuntime(context, binding, setupLease);
        binding = prepared.binding;
        await assertPreparationActive(context, binding);
        if (params.setupCommands === undefined && binding.setup?.status === "pending" && !binding.setup.commands.length && binding.preparation?.environmentSource !== "explicit") {
          // 环境 owner 已提交依赖收据时仅去重自动检测，显式 setup（哪怕同一 install）仍执行。
          const commands = prepared.environment?.dependenciesPrepared ? [] : await context.detectSetup(binding.checkoutPath);
          binding = { ...binding, setup: { ...binding.setup, commands }, preparation: { ...binding.preparation!, environmentSource: commands.length ? "detected" : "none" } };
          await store.saveBinding(binding);
        }
        if (params.retrySetup && binding.setup && binding.setup.status !== "completed") {
          const commands = params.setupCommands ?? binding.setup.commands;
          const copyIgnoredPaths = params.copyIgnoredPaths ?? binding.setup.copyIgnoredPaths;
          const changedCommands = JSON.stringify(commands) !== JSON.stringify(binding.setup.commands);
          const changedPaths = JSON.stringify(copyIgnoredPaths) !== JSON.stringify(binding.setup.copyIgnoredPaths);
          binding = { ...binding, setup: { ...binding.setup, commands, copyIgnoredPaths, copied: binding.setup.copied && !changedPaths, nextCommand: changedCommands ? 0 : binding.setup.nextCommand, results: changedCommands ? [] : binding.setup.results } };
          await store.saveBinding(binding);
        }
        binding = await prepareWorktreeEnvironment(context, binding, Boolean(params.retrySetup), prepared.environment?.env);
        binding = await store.lock(store.key(`preparation-claim:${id}`), async () => {
          await assertPreparationActive(context, binding!);
          return preparationProgress(context, { ...binding!, status: "ready", error: undefined }, "ready", "Workspace ready. Task checks have not run.\n");
        });
        return binding;
      } catch (error) {
        let latest = (await store.readBinding(id)) ?? binding;
        const runtimeError = runtimeEnvironmentErrorSchema.safeParse(error && typeof error === "object" && "runtimeEnvironmentError" in error ? error.runtimeEnvironmentError : undefined);
        if (runtimeError.success && latest.preparation) {
          latest = { ...latest, preparation: { ...latest.preparation, runtimeError: runtimeError.data } };
          await store.saveBinding(latest);
        }
        if (await store.isPreparationCancelled(id)) await assertPreparationActive(context, latest);
        if (latest.status !== "cancelled") await preparationProgress(context, { ...latest, status: "failed", error: error instanceof Error ? error.message : String(error) }, "failed", `Preparation failed: ${error instanceof Error ? error.message : String(error)}\n`);
        throw error;
      } finally {
        if (setupLease) await coordinator.release(setupLease);
      }
    });
  }
  const getBinding = createWorktreeBindingLookup(context, ready);
  return { capability, prepare, getBinding, ready };
}
