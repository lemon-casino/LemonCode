import { resolve } from "node:path";
import type { IWorktreeService } from "../contract.js";
import type { CheckoutCoordinator } from "../nodeTypes.js";
import type { WorktreeContext } from "./ports.js";
import { createWorktreeLifecycle } from "./lifecycle.js";
import { createWorktreeArchive } from "./archive.js";
import { createWorktreeIntegration } from "./integration.js";
import { createWorktreePublication } from "./publication.js";

export function createWorktreeApplication(
  context: WorktreeContext,
  options: {
    coordinator: CheckoutCoordinator;
    validate(checkout: string, command: string): Promise<{ exitCode: number; output: string }>;
  },
): IWorktreeService {
  const lifecycle = createWorktreeLifecycle(context, options.coordinator);
  const archive = createWorktreeArchive(context, options.coordinator, lifecycle.ready);
  const integration = createWorktreeIntegration(context, options.coordinator, options.validate);
  return {
    getCapabilities: lifecycle.capability,
    prepare: lifecycle.prepare,
    getBinding: lifecycle.getBinding,
    async list(params) {
      const identity = params.workspaceIdentity?.trim() || resolve(params.workspacePath);
      return (await context.store.listBindings()).filter(
        (binding) =>
          binding.status !== "deleted" &&
          (binding.originalWorkspaceIdentity?.trim() || resolve(binding.originalWorkspacePath)) ===
            identity,
      );
    },
    integrate: integration.integrate,
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
