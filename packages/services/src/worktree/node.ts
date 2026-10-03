import type { IWorktreeService } from "./contract.js";
import type { WorktreeServiceOptions } from "./nodeTypes.js";
export type { WorktreeServiceOptions, WorktreeGitPort, CheckoutCoordinator } from "./nodeTypes.js";
import { createWorktreeApplication } from "./app/worktreeService.js";
import { createWorktreeStore } from "./adapters/store.js";
import { createWorktreeGit } from "./adapters/git.js";
import { createCheckoutCoordinator } from "./adapters/coordinator.js";
import { runWorktreeValidation } from "./adapters/validation.js";
import { createSetupFileCopier } from "./adapters/setupFiles.js";
import { validateWorktreeRequests } from "./app/validatedService.js";

export { createCheckoutCoordinator, CheckoutBusyError } from "./adapters/coordinator.js";
export function createWorktreeService(options: WorktreeServiceOptions): IWorktreeService {
  const store = createWorktreeStore(options.dataDir);
  const git = createWorktreeGit(options.git);
  const coordinator = options.coordinator ?? createCheckoutCoordinator(options);
  return validateWorktreeRequests(
    createWorktreeApplication(
      {
        store,
        git,
        fault: options.fault ?? (async () => {}),
        commitSource: options.commitSource,
        runSetup: options.validate ?? runWorktreeValidation,
        copyIgnoredFiles: createSetupFileCopier(git),
      },
      {
        coordinator,
        validate: options.validate ?? runWorktreeValidation,
      },
    ),
  );
}
