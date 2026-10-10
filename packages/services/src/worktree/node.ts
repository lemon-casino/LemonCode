import type { IWorktreeHostService, IWorktreeService } from "./contract.js";
import type { WorktreeServiceOptions } from "./nodeTypes.js";
export type { WorktreeServiceOptions, WorktreeGitPort, CheckoutCoordinator } from "./nodeTypes.js";
export type {
  IWorktreeHostService,
  WorktreeRuntimePorts,
  PreparedWorktreeRuntime,
} from "./contract.js";
import { createWorktreeApplication } from "./app/worktreeService.js";
import { createWorktreeStore } from "./adapters/store.js";
import { createWorktreeTransientRetryWait } from "./adapters/transientRetry.js";
import { createWorktreeGit } from "./adapters/git.js";
import { createCheckoutCoordinator } from "./adapters/coordinator.js";
import { runWorktreeValidation } from "./adapters/validation.js";
import { createSetupFileCopier } from "./adapters/setupFiles.js";
import { validateWorktreeRequests } from "./app/validatedService.js";
import {
  detectWorktreeSetup,
  detectWorktreeValidation,
  worktreeDeclarationDigest,
} from "./adapters/environment.js";

export { createCheckoutCoordinator, CheckoutBusyError } from "./adapters/coordinator.js";
export { isCheckoutPathWithin, isOwnedCheckoutScope } from "./adapters/checkoutScope.js";
/** RPC 会枚举对象的方法，必须返回显式白名单，不能仅靠 TypeScript 隐藏 Host 能力。 */
export function createPublicWorktreeService(host: IWorktreeService): IWorktreeService {
  return validateWorktreeRequests(host);
}
export function createWorktreeService(options: WorktreeServiceOptions): IWorktreeHostService {
  const store = createWorktreeStore(options.dataDir, options.removeDirectory);
  const git = createWorktreeGit(options.git);
  const coordinator = options.coordinator ?? createCheckoutCoordinator(options);
  const host = createWorktreeApplication(
    {
      store,
      git,
      fault: options.fault ?? (async () => {}),
      transientRetryWait: options.transientRetryWait ?? createWorktreeTransientRetryWait(),
      commitSource: options.commitSource,
      collectDiscardSessions: options.collectDiscardSessions,
      discardSessions: options.discardSessions,
      stopWorktreeExecution: options.stopWorktreeExecution,
      prepareRuntimeEnvironment: options.prepareRuntimeEnvironment,
      resolveRuntimeEnvironment: options.resolveRuntimeEnvironment,
      releaseRuntimeEnvironment: options.releaseRuntimeEnvironment,
      retireLegacyRuntimeConsumers: options.retireLegacyRuntimeConsumers,
      rebindRuntimeEnvironmentSessions: options.rebindRuntimeEnvironmentSessions,
      runSetup: options.validate ?? runWorktreeValidation,
      declarationDigest: worktreeDeclarationDigest,
      detectSetup: detectWorktreeSetup,
      detectValidation: detectWorktreeValidation,
      copyIgnoredFiles: createSetupFileCopier(git),
    },
    { coordinator, validate: options.validate ?? runWorktreeValidation },
  );
  return {
    ...createPublicWorktreeService(host),
    upgradeRuntimeEnvironment: host.upgradeRuntimeEnvironment,
    assertExecutionAdmission: host.assertExecutionAdmission,
  };
}
