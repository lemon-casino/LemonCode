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
import { detectWorktreeSetup, detectWorktreeValidation } from "./adapters/environment.js";

export { createCheckoutCoordinator, CheckoutBusyError } from "./adapters/coordinator.js";
export function createWorktreeService(options: WorktreeServiceOptions): IWorktreeService {
  const store = createWorktreeStore(options.dataDir, options.removeDirectory);
  const git = createWorktreeGit(options.git);
  const coordinator = options.coordinator ?? createCheckoutCoordinator(options);
  return validateWorktreeRequests(
    createWorktreeApplication(
      {
        store,
        git,
        fault: options.fault ?? (async () => {}),
        commitSource: options.commitSource,
        collectDiscardSessions: options.collectDiscardSessions,
        discardSessions: options.discardSessions,
        prepareRuntimeEnvironment: options.prepareRuntimeEnvironment,
        runSetup: options.validate ?? runWorktreeValidation,
        detectSetup: detectWorktreeSetup,
        detectValidation: detectWorktreeValidation,
        copyIgnoredFiles: createSetupFileCopier(git),
      },
      {
        coordinator,
        validate: options.validate ?? runWorktreeValidation,
      },
    ),
  );
}
