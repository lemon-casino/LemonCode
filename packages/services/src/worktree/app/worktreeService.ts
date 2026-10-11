import { resolve } from "node:path";
import type { IWorktreeHostService, WorktreeCommandRunner } from "../contract.js";
import { createWorktreeEnvironmentUpgrade } from "./upgrade.js";
import type { CheckoutCoordinator } from "../nodeTypes.js";
import type { WorktreeContext } from "./ports.js";
import { createWorktreeLifecycle } from "./lifecycle.js";
import { createWorktreeArchive } from "./archive.js";
import { createWorktreeIntegration } from "./integration.js";
import { createWorktreePublication } from "./publication.js";
import { createWorktreeManagement } from "./management.js";
import { createServiceLogger } from "../../logger/serviceLogger.js";

export function createWorktreeApplication(
  context: WorktreeContext,
  options: {
    coordinator: CheckoutCoordinator;
    validate: WorktreeCommandRunner;
  },
): IWorktreeHostService {
  const lifecycle = createWorktreeLifecycle(context, options.coordinator);
  const archive = createWorktreeArchive(context, options.coordinator, lifecycle.ready);
  const management = createWorktreeManagement(context, archive.archiveAutomatically);
  const logger = createServiceLogger("worktree-management");
  const integration = createWorktreeIntegration(context, options.coordinator, options.validate);
  async function enforceRetention(excludeId?: string) {
    try {
      const result = await management.cleanup(excludeId);
      if (result.archivedIds.length || result.skipped.length)
        logger.info(undefined, "Worktree retention completed", {
          archived: result.archivedIds.length,
          skipped: result.skipped.length,
        });
    } catch (error) {
      logger.warn(undefined, "Worktree retention failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    ...management,
    cleanup: () => management.cleanup(),
    async updateManagementSettings(patch) {
      const settings = await management.updateManagementSettings(patch);
      if (patch.autoDeleteEnabled !== undefined || patch.retainedCount !== undefined)
        await enforceRetention();
      return settings;
    },
    async assertExecutionAdmission(scope) {
      const binding = await context.store.findExecutionBinding(scope);
      // 内存 stop 标记会随 Host 重启丢失；持久删除状态是阻止后台只读请求重新 spawn 的唯一事实。
      if (binding && ["deleting", "deleted", "archived"].includes(binding.status))
        throw new Error("release-blocked: worktree execution admission is fenced");
    },
    async assertFileWatchAdmission(path) {
      const binding = await context.store.findExecutionBinding(
        { workspacePath: path },
        "file-watch",
      );
      // 一次性关闭 watcher 后，迟到的 UI 请求会重新占用目录；必须在创建原生句柄前读持久 fence。
      if (binding && ["deleting", "deleted", "archiving", "archived"].includes(binding.status))
        throw new Error("release-blocked: worktree file watch admission is fenced");
    },
    upgradeRuntimeEnvironment: createWorktreeEnvironmentUpgrade(
      context,
      options.coordinator,
      lifecycle.ready,
    ),
    getCapabilities: lifecycle.capability,
    async prepare(params) {
      const binding = await lifecycle.prepare(params);
      if (!params.parentBinding && !params.cancel && binding.status === "ready") {
        await enforceRetention(binding.id);
      }
      return binding;
    },
    getBinding: lifecycle.getBinding,
    async list(params) {
      const normalize = (path: string) =>
        process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
      const path = normalize(params.workspacePath);
      const identity = params.workspaceIdentity?.trim() || path;
      const matches = (workspacePath: string, workspaceIdentity?: string) =>
        normalize(workspacePath) === path &&
        (workspaceIdentity?.trim() || normalize(workspacePath)) === identity;
      return (await context.store.listBindings()).filter(
        (binding) =>
          binding.status !== "deleted" &&
          (matches(binding.originalWorkspacePath, binding.originalWorkspaceIdentity) ||
            matches(binding.workspacePath, binding.workspaceIdentity)),
      );
    },
    integrate: integration.integrate,
    getIntegrationPreflight: integration.preflight,
    continueIntegration: integration.continueIntegration,
    getIntegration: (params) => context.store.readOperation(params.operationId),
    publishIntegration: createWorktreePublication(context, {
      ...options,
      read: integration.read,
      save: integration.save,
    }),
    archive: archive.archive,
    restore: archive.restore,
    acquireCheckout: (params) => options.coordinator.acquire(params),
    releaseCheckout: (params) => options.coordinator.release(params),
  };
}
