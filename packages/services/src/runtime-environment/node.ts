import { createRuntimeEnvironmentService } from "./app/runtimeEnvironmentService.js";
import { createRuntimeEnvironmentStore } from "./adapters/store.js";
import { createToolBackend } from "./adapters/toolBackend.js";
import { createDeclarationReader } from "./adapters/declarationsReader.js";
import { validateRuntimeEnvironmentRequests } from "./app/validatedService.js";
import { createRuntimeConsumerAuthority } from "./app/consumerLifecycle.js";
import type { IRuntimeEnvironmentService } from "./contract.js";

export type { RuntimeEnvironmentServiceOptions } from "./app/runtimeEnvironmentService.js";
export type {
  IRuntimeEnvironmentService,
  ResolvedProjectExecutionContext,
  RuntimeEnvironmentPrepareRequest,
} from "./contract.js";
export { environmentIdFor, operationIdFor } from "./app/ports.js";
export { runtimeEnvironmentDataDirs } from "./adapters/store.js";
export { MISE_ASSET_DIGESTS, MISE_BACKEND_VERSION } from "./adapters/toolBackend.js";
export type { ToolBackendPort } from "./app/ports.js";

/**
 * 组合根入口（spec §9.4）：数据目录放 HostDataRoot 下 runtime-environments/，
 * 与 worktrees/ 同级；不改变 WorktreeService 的 dataDir。
 */
export function createRuntimeEnvironmentHost(dataDir: string) {
  const store = createRuntimeEnvironmentStore(dataDir);
  const backend = createToolBackend({ dataDir });
  return {
    service: validateRuntimeEnvironmentRequests(
      createRuntimeEnvironmentService({ store, backend, declarations: createDeclarationReader() }),
    ),
    consumers: createRuntimeConsumerAuthority(store, () => new Date().toISOString()),
  };
}

export function createRuntimeEnvironmentServiceHost(dataDir: string): IRuntimeEnvironmentService {
  return createRuntimeEnvironmentHost(dataDir).service;
}

/** 测试/自定义装配：注入内存 store 与假后端。 */
export function createRuntimeEnvironmentServiceForTests(
  options: import("./app/runtimeEnvironmentService.js").RuntimeEnvironmentServiceOptions,
): IRuntimeEnvironmentService {
  return validateRuntimeEnvironmentRequests(createRuntimeEnvironmentService(options));
}
