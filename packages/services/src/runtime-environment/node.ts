import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { Emitter } from "@lcode/rpc";
import {
  runtimeEnvironmentEventSchema,
  runtimeEnvironmentPrepareParamsSchema,
  type RuntimeEnvironmentEvent,
} from "@lcode/shared";
import {
  createRuntimeEnvironmentService,
  type RuntimeEnvironmentServiceOptions,
} from "./app/runtimeEnvironmentService.js";
import { createRuntimeEnvironmentStore } from "./adapters/store.js";
import { createToolBackend } from "./adapters/toolBackend.js";
import { bundledMisePath } from "./adapters/bundledBackend.js";
import { createDeclarationReader } from "./adapters/declarationsReader.js";
import { createDependencyInstaller } from "./adapters/dependencyInstall.js";
import { createRuntimeResources } from "./adapters/resources.js";
import { createResourceControl } from "./app/resourceControl.js";
import { createManagedServiceProcesses } from "./adapters/managedServices.js";
import { createServiceControl } from "./app/serviceControl.js";
import { createServiceOwnerChannel } from "./adapters/serviceOwnerChannel.js";
import {
  BUILTIN_SERVICE_PROCESSES,
  listProjectServices,
  resolveProjectService,
} from "./adapters/serviceDefinitions.js";
import { validateRuntimeEnvironmentRequests } from "./app/validatedService.js";
import { createRuntimeConsumerAuthority } from "./app/consumerLifecycle.js";
import { createWorktreeEnvironmentRelease } from "./app/worktreeRelease.js";
import { createNativeProcessOwnerObserver } from "./adapters/processOwnerObservation.js";
import { acquireResourceLease } from "./app/ports.js";
import type {
  IRuntimeEnvironmentHostService,
  RuntimeEnvironmentPrepareRequest,
  RuntimeConsumerProcessOwner,
  RuntimeResourceDirectoryRemover,
} from "./contract.js";

export type { RuntimeEnvironmentServiceOptions } from "./app/runtimeEnvironmentService.js";
export type {
  IRuntimeEnvironmentService,
  IRuntimeEnvironmentHostService,
  ResolvedProjectExecutionContext,
  RuntimeEnvironmentPrepareRequest,
} from "./contract.js";
export { environmentIdFor, operationIdFor } from "./app/ports.js";
export { runtimeEnvironmentDataDirs } from "./adapters/store.js";
export { MISE_ASSET_DIGESTS, MISE_BACKEND_VERSION } from "./adapters/toolBackend.js";
export type { ToolBackendPort } from "./app/ports.js";
export { createPublicRuntimeEnvironmentService } from "./publicService.js";
export { createWorktreeRuntimePorts, prepareBoundRuntime } from "./worktreeWiring.js";
export { createRuntimeTerminalEnvironment } from "./terminalWiring.js";

export interface RuntimeEnvironmentHostOptions {
  backendPath?: string;
  resourcesPath?: string;
  serverRuntimeRoot?: string;
  resolveEnv?: () => Promise<NodeJS.ProcessEnv>;
  acquireWriter?: RuntimeEnvironmentServiceOptions["acquireWriter"];
  publishInvalidation?: (event: RuntimeEnvironmentEvent) => void;
  /** 仅执行 Host 的完整 owner 注册表；包含退出后尚未结算的实例。 */
  hasProcessOwner?: (owner: RuntimeConsumerProcessOwner) => boolean;
  /** Desktop 注入 original-fs；其余 Host 默认使用 Node fs。 */
  removeResourceDirectory?: RuntimeResourceDirectoryRemover;
}
/** HostDataRoot/runtime-environments 是唯一环境根，不改变 WorktreeService 的 checkout 根。 */
export function createRuntimeEnvironmentHost(
  dataDir: string,
  options: RuntimeEnvironmentHostOptions = {},
) {
  const events = new Emitter<RuntimeEnvironmentEvent>();
  const store = createRuntimeEnvironmentStore(dataDir, (record) => {
    const event: RuntimeEnvironmentEvent = {
      environmentId: record.environmentId,
      stateRevision: record.stateRevision ?? 0,
      kind: "projection.updated",
    };
    events.fire(event);
    options.publishInvalidation?.(event);
  });
  const backend = createToolBackend({
    dataDir,
    backendPath:
      options.backendPath ??
      bundledMisePath({
        resourcesPath: options.resourcesPath,
        serverRuntimeRoot: options.serverRuntimeRoot,
      }),
    resolveEnv: options.resolveEnv,
  });
  const resources = createRuntimeResources(dataDir, options.removeResourceDirectory);
  const processes = createManagedServiceProcesses({ definitions: BUILTIN_SERVICE_PROCESSES });
  const stamp = () => new Date().toISOString();
  const frozen = (record: import("@lcode/shared").RuntimeEnvironmentRecord) =>
    implementation.resolveContext({
      ...record.scope,
      environmentId: record.environmentId,
      bindingId: record.bindingId,
      expectedRevision: record.currentRevision,
      expectedManifestDigest: record.manifestDigest,
      consumer: "managed-service",
    });
  const dependencies = createDependencyInstaller({ resolveEnv: options.resolveEnv });
  const serviceControl = createServiceControl({
    store,
    beforeStart: async (record, definition, signal) => {
      if (definition.serviceId !== "dev:desktop") return;
      if (!options.acquireWriter)
        throw new Error("capability-unavailable: desktop preparation requires a checkout writer");
      const release = await options.acquireWriter({
        workspacePath: record.scope.workspacePath,
        ownerId: `desktop-prepare:${record.environmentId}:${record.currentRevision}`,
      });
      try {
        const context = await frozen(record);
        const result = await dependencies.runApprovedCommand({
          executable: context.toolPaths.node!,
          args: [
            join(record.scope.workspacePath, "scripts", "dev-desktop-env.mjs"),
            "production",
            "--prepare-only",
          ],
          cwd: record.scope.workspacePath,
          toolPaths: context.toolPaths,
          env: context.envOverlay.set,
          signal,
        });
        if (result.exitCode !== 0)
          throw new Error("desktop preparation failed before service launch");
      } finally {
        await release();
      }
    },
    processes,
    stamp,
    resolveDefinition: async (params, record) =>
      resolveProjectService(record, params.serviceId, await frozen(record)),
    resolveContext: frozen,
    acquireLease: async (params) => {
      const locksRoot = join(dataDir, "service-leases");
      await mkdir(locksRoot, { recursive: true });
      return acquireResourceLease({ ...params, locksRoot, waitMs: 200 });
    },
  });
  const ownerChannel = createServiceOwnerChannel(dataDir, {
    owns: serviceControl.owns,
    handle: serviceControl.handleOwnerRequest,
  });
  serviceControl.attachOwnerChannel(ownerChannel);
  const implementation = createRuntimeEnvironmentService({
    store,
    backend,
    declarations: createDeclarationReader(),
    dependencies,
    ensureResources: (id) => resources.ensure(id),
    dependencyResourceRoot: join(dataDir, "resources"),
    acquireWriter: options.acquireWriter,
    services: serviceControl,
    resources: createResourceControl({ store, resources, stamp }),
    onDidChangeEnvironment: events.event,
    listServices: listProjectServices,
    reconcileReceipt: serviceControl.reconcileReceipt,
  });
  const service = validateRuntimeEnvironmentRequests(implementation);
  const observeProcessOwner = createNativeProcessOwnerObserver(options.hasProcessOwner);
  return {
    service,
    consumers: createRuntimeConsumerAuthority(store, stamp, observeProcessOwner),
    prepareUnderWriter: (params: RuntimeEnvironmentPrepareRequest) =>
      implementation.prepareUnderWriter(runtimeEnvironmentPrepareParamsSchema.parse(params)),
    releaseForWorktree: createWorktreeEnvironmentRelease({
      store,
      stamp,
      stopAll: serviceControl.stopAll,
      clearRebuildable: (id) => resources.clearRebuildable(id),
      discardResources: (id) => resources.discard(id),
      observeProcessOwner,
    }),
    acceptInvalidation(value: unknown) {
      const event = runtimeEnvironmentEventSchema.safeParse(value);
      if (event.success) events.fire(event.data);
    },
    async disposeAndWait() {
      await implementation.disposeAndWait();
      await processes.disposeAndWait();
      await ownerChannel.disposeAndWait();
      events.dispose();
    },
  };
}
export function createRuntimeEnvironmentServiceHost(
  dataDir: string,
): IRuntimeEnvironmentHostService {
  return createRuntimeEnvironmentHost(dataDir).service;
}
export function createRuntimeEnvironmentServiceForTests(
  options: RuntimeEnvironmentServiceOptions,
): IRuntimeEnvironmentHostService {
  return validateRuntimeEnvironmentRequests(createRuntimeEnvironmentService(options));
}
