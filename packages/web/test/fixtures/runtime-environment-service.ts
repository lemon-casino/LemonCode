import type { IRuntimeEnvironmentService, WorktreeBinding } from "@lcode/services";
import type {
  RuntimeEnvironmentEvent,
  RuntimeEnvironmentProjection,
  RuntimeEnvironmentScope,
  RuntimeEnvironmentServiceActionParams,
  RuntimePreparationOperation,
} from "@lcode/shared";

export const origin = "/fixture/项目";
export const checkout = `${origin}/工作树/${"很长的中文工作目录-".repeat(12)}`;
export const environmentId = "a".repeat(32);
export const environmentBinding: WorktreeBinding = {
  id: "binding",
  requestId: "binding-request",
  taskId: "fixture-session",
  originalWorkspacePath: origin,
  workspacePath: checkout,
  checkoutPath: checkout,
  repositoryRoot: origin,
  commonDirectory: `${origin}/.git`,
  branch: "worktree/中文任务",
  targetBranch: "main",
  baseCommit: "base",
  sourceFolderPaths: [checkout],
  status: "ready",
  createdAt: "now",
  updatedAt: "now",
  environmentRef: { environmentId, revision: 2, manifestDigest: "manifest-2" },
};
export function createRuntimeEnvironmentFixture(subdirectory = false) {
  const calls: { method: string; params: unknown }[] = [];
  const listeners = new Set<(event: RuntimeEnvironmentEvent) => void>();
  let binding = structuredClone(environmentBinding);
  if (subdirectory)
    binding = {
      ...binding,
      workspacePath: `${checkout}/packages/app`,
      originalWorkspacePath: `${origin}/packages/app`,
    };
  let environment: RuntimeEnvironmentProjection = {
    environmentId,
    purpose: "worktree",
    status: "ready",
    currentRevision: 2,
    stateRevision: 2,
    manifestDigest: "manifest-2",
    declarationDigest: "declaration",
    installStrategy: "frozen",
    toolSource: "project-declaration",
    tools: [
      {
        key: "node",
        version: "24.14.0",
        source: "project-declaration",
        installStrategy: "managed-tool-store",
      },
    ],
    availableServices: [
      { serviceId: "dev:web", portIsolation: "managed" },
      { serviceId: "dev", portIsolation: "unmanaged" },
    ],
    services: [],
    updatedAt: "now",
  };
  const controller = {
    calls,
    failPrepare: false,
    holdPrepare: false,
    unsupported: false,
    holdSnapshot: false,
    releasePrepare: () => {},
    releaseSnapshot: () => {},
    chooseIdentity: (_identity?: string) => {},
    setConnected: (_connected: boolean) => {},
    lateHandoff: () => false,
    remountDetails: () => {},
    bindingFacts: () => structuredClone(binding),
    facts: () => structuredClone(environment),
    change: (patch: Partial<RuntimeEnvironmentProjection>) => {
      environment = {
        ...environment,
        ...patch,
        stateRevision: (environment.stateRevision ?? 0) + 1,
      };
      for (const listener of listeners)
        listener({
          environmentId,
          stateRevision: environment.stateRevision!,
          kind: "projection.updated",
        });
    },
  };
  const scope = (params: RuntimeEnvironmentScope) => ({
    workspacePath: params.workspacePath,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
  });
  const assertPublicScope = (params: RuntimeEnvironmentScope) => {
    if (params.workspacePath !== binding.workspacePath)
      throw new Error("scope-mismatch: runtime fixture expects the binding execution directory");
  };
  const serviceAction = async (params: RuntimeEnvironmentServiceActionParams, start: boolean) => {
    assertPublicScope(params);
    calls.push({ method: start ? "startService" : "stopService", params });
    const old = environment.services?.find((item) => item.serviceId === params.serviceId);
    const receipt = {
      environmentId,
      revision: environment.currentRevision,
      serviceId: params.serviceId,
      state: start ? ("running" as const) : ("stopped" as const),
      generation: start ? (old?.generation ?? 0) + 1 : (old?.generation ?? 1),
      urls: start ? ["http://127.0.0.1:5173"] : [],
      startedAt: "now",
      ...(start ? { healthCheckedAt: "now" } : { stoppedAt: "now" }),
    };
    controller.change({
      services: [
        ...(environment.services ?? []).filter((item) => item.serviceId !== params.serviceId),
        {
          serviceId: receipt.serviceId,
          state: receipt.state,
          generation: receipt.generation,
          urls: receipt.urls,
        },
      ],
    });
    return { status: start ? ("started" as const) : ("stopped" as const), receipt };
  };
  const service: IRuntimeEnvironmentService = {
    onDidChangeEnvironment: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    getCapabilities: async (params) => {
      assertPublicScope(params);
      calls.push({ method: "getCapabilities", params });
      return controller.unsupported
        ? { managedEnvironments: false, missingReason: "fixture: platform not verified" }
        : {
            managedEnvironments: true,
            protocolVersion: 1,
            actions: ["prepare", "startService", "stopService", "resourceSummary", "reconcile"],
          };
    },
    snapshot: async (params) => {
      assertPublicScope(params);
      calls.push({ method: "snapshot", params });
      const frozen = structuredClone(environment);
      if (controller.holdSnapshot) {
        controller.holdSnapshot = false;
        await new Promise<void>((resolve) => {
          controller.releaseSnapshot = resolve;
        });
      }
      return {
        protocolVersion: 1,
        scope: scope(params),
        stateRevision: frozen.stateRevision!,
        environment: frozen,
      };
    },
    get: async (params) => {
      calls.push({ method: "get", params });
      return structuredClone(environment);
    },
    list: async (params) => {
      calls.push({ method: "list", params });
      return [structuredClone(environment)];
    },
    prepare: async (params) => {
      assertPublicScope(params);
      calls.push({ method: "prepare", params });
      const operation: RuntimePreparationOperation = {
        operationId: "b".repeat(32),
        requestId: params.requestId,
        environmentId,
        status: "running",
        stage: "preparingDependencies",
        cancelRequested: false,
        createdAt: "now",
        updatedAt: "now",
      };
      if (params.cancel) {
        binding = {
          ...binding,
          status: "updating",
          environmentUpgrade: { requestId: params.requestId, cancelled: true },
        };
        controller.change({ status: "cancelled", error: undefined });
        controller.releasePrepare();
        return { ...operation, status: "cancelled", stage: "cancelled", cancelRequested: true };
      }
      if (
        binding.status === "updating" &&
        binding.environmentUpgrade?.requestId !== params.requestId &&
        !binding.environmentUpgrade?.cancelled
      )
        throw new Error("Finish the existing environment upgrade before starting another");
      if (
        binding.environmentUpgrade?.requestId !== params.requestId ||
        binding.status !== "updating"
      )
        binding = {
          ...binding,
          status: "updating",
          environmentUpgrade: { requestId: params.requestId },
          environmentRebuild: { oldEnvironmentRef: binding.environmentRef },
        };
      controller.change({ status: "preparingDependencies", error: undefined });
      if (controller.holdPrepare)
        await new Promise<void>((resolve) => {
          controller.releasePrepare = resolve;
        });
      if (environment.status === "cancelled")
        return { ...operation, status: "cancelled", stage: "cancelled", cancelRequested: true };
      if (controller.failPrepare) {
        const error = {
          code: "dependency-install-failed" as const,
          stage: "preparingDependencies" as const,
          message: "fixture-install-failed",
          retryable: true,
          diagnostic: {
            purpose: "worktree" as const,
            environmentId,
            revision: 2,
            manifestDigest: "manifest-2",
            command: "pnpm install",
            exitCode: 1,
            stderrTail: "token=private-fixture-token",
            paths: [checkout],
            sideEffects: ["environment-created" as const],
          },
        };
        controller.change({ status: "failed", error });
        return { ...operation, status: "failed", error };
      }
      controller.change({
        status: "ready",
        currentRevision: environment.currentRevision + 1,
        error: undefined,
      });
      binding = {
        ...binding,
        status: "ready",
        error: undefined,
        environmentRef: {
          environmentId,
          revision: environment.currentRevision,
          manifestDigest: environment.manifestDigest,
        },
      };
      return { ...operation, status: "succeeded", stage: "ready" };
    },
    startService: (params) => serviceAction(params, true),
    stopService: (params) => serviceAction(params, false),
    resourceSummary: async (params) => {
      assertPublicScope(params);
      calls.push({ method: "resourceSummary", params });
      const summary = {
        status: "partial" as const,
        bytes: 1024,
        fileCount: 3,
        reason: "fixture budget reached",
        scanBudget: params.budget,
      };
      controller.change({ resourceSummary: summary });
      return { environmentId, stateRevision: environment.stateRevision!, summary };
    },
    reconcile: async () => ({ operation: null, environment: structuredClone(environment) }),
    release: async () => ({ status: "releaseBlocked", reason: "fixture readonly" }),
    garbageCollect: async () => ({
      operationId: "gc",
      status: "blocked",
      deletedEntries: 0,
      protectedEntries: 1,
      summary: { status: "unavailable" },
    }),
  };
  return { service, controller };
}
