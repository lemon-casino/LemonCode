import type {
  IWorktreeHostService,
  WorktreeBinding,
  WorktreeRuntimePorts,
} from "../worktree/contract.js";
import type { ILCodeAgentService } from "../lcode-agent/lcodeAgent.js";
import type { CheckoutCoordinator } from "../worktree/node.js";
import type {
  IRuntimeEnvironmentHostService,
  RuntimeEnvironmentConsumerAuthority,
  RuntimeEnvironmentPrepareRequest,
} from "./contract.js";
import type { createWorktreeEnvironmentRelease } from "./app/worktreeRelease.js";

interface RuntimeHost {
  service: IRuntimeEnvironmentHostService;
  consumers: RuntimeEnvironmentConsumerAuthority;
  prepareUnderWriter(
    params: RuntimeEnvironmentPrepareRequest,
  ): ReturnType<IRuntimeEnvironmentHostService["prepare"]>;
  releaseForWorktree: ReturnType<typeof createWorktreeEnvironmentRelease>;
}
export function createWorktreeRuntimePorts(options: {
  host: RuntimeHost;
  coordinator: CheckoutCoordinator;
  worktrees: () => IWorktreeHostService;
  agents: () => ILCodeAgentService;
  stopWorktreeExecution: (binding: WorktreeBinding) => Promise<void>;
}): WorktreeRuntimePorts {
  const { host } = options;
  const resolve: NonNullable<WorktreeRuntimePorts["resolveRuntimeEnvironment"]> = async (
    params,
  ) => {
    const scope = { workspacePath: params.checkoutPath };
    const environment = await host.service.get({
      ...scope,
      environmentId: params.environmentRef.environmentId,
    });
    if (!environment || environment.status !== "ready")
      throw new Error(
        "stale-reference: environment needs preparation before execution or validation",
      );
    const context = await host.service.resolveContext({
      ...scope,
      bindingId: params.bindingId,
      environmentId: params.environmentRef.environmentId,
      expectedRevision: params.environmentRef.revision,
      expectedManifestDigest: params.environmentRef.manifestDigest,
      consumer: "worktree-runtime",
    });
    return {
      environmentId: context.environmentId,
      revision: context.revision,
      manifestDigest: context.manifestDigest,
      declarationDigest: environment.declarationDigest,
      env: context.envOverlay.set,
      dependenciesPrepared: environment.installStrategy === "frozen",
      toolSource: environment.toolSource,
    };
  };
  return {
    stopWorktreeExecution: options.stopWorktreeExecution,
    async prepareRuntimeEnvironment(params, writer) {
      if (writer && writer.workspacePath !== params.checkoutPath)
        throw new Error("scope-mismatch: borrowed checkout writer differs from runtime checkout");
      const request: RuntimeEnvironmentPrepareRequest = {
        workspacePath: params.checkoutPath,
        bindingId: params.bindingId,
        requestId: params.requestId,
        purpose: params.purpose,
        operation: params.operation,
        cancel: params.cancel,
        environmentId: params.environmentId,
        expectedRevision: params.expectedRevision,
        expectedManifestDigest: params.expectedManifestDigest,
      };
      const operation = await (writer
        ? host.prepareUnderWriter(request)
        : host.service.prepare(request));
      if (operation.status !== "succeeded")
        throw Object.assign(
          new Error(
            `Runtime environment preparation ${operation.status}: ${operation.error?.message ?? operation.stage}`,
          ),
          {
            code: operation.error?.code,
            runtimeEnvironmentError: operation.error,
            operation,
          },
        );
      const environment = await host.service.get({
        workspacePath: params.checkoutPath,
        environmentId: operation.environmentId,
      });
      if (!environment || environment.currentRevision < 1)
        throw new Error("stale-reference: prepared environment is unavailable");
      return resolve({
        bindingId: params.bindingId,
        checkoutPath: params.checkoutPath,
        environmentRef: {
          environmentId: operation.environmentId,
          revision: environment.currentRevision,
          manifestDigest: environment.manifestDigest,
        },
      });
    },
    resolveRuntimeEnvironment: resolve,
    async releaseRuntimeEnvironment(params) {
      const canRetire =
        params.intent === "discard" &&
        params.phase === "stop" &&
        Boolean(host.consumers.retireLegacyProcessesForDeletion);
      if (
        canRetire &&
        params.legacyDiscardSessionIds &&
        (!params.binding ||
          params.binding.id !== params.bindingId ||
          params.binding.status !== "deleting" ||
          params.binding.checkoutPath !== params.checkoutPath ||
          params.binding.deletion?.requestId !== params.requestId)
      )
        throw new Error(
          "scope-mismatch: legacy pending references require the original discard binding",
        );
      return host.releaseForWorktree({
        workspacePath: params.checkoutPath,
        bindingId: params.bindingId,
        requestId: params.requestId,
        environmentId: params.environmentRef.environmentId,
        expectedRevision: params.environmentRef.revision,
        expectedManifestDigest: params.environmentRef.manifestDigest,
        intent: params.intent,
        phase: params.phase,
        ...(canRetire ? { legacyDiscardSessionIds: params.legacyDiscardSessionIds } : {}),
      });
    },
    ...(host.consumers.retireLegacyProcessesForDeletion
      ? {
          async retireLegacyRuntimeConsumers({
            binding,
            sessionIds,
            writer,
          }: Parameters<NonNullable<WorktreeRuntimePorts["retireLegacyRuntimeConsumers"]>>[0]) {
            if (!binding.environmentRef) return;
            const current = await options.worktrees().getBinding({
              workspacePath: binding.originalWorkspacePath,
              workspaceIdentity: binding.originalWorkspaceIdentity,
              taskId: binding.taskId,
            });
            if (
              !current ||
              current.id !== binding.id ||
              current.status !== "deleting" ||
              current.checkoutPath !== binding.checkoutPath ||
              current.deletion?.requestId !== binding.deletion?.requestId ||
              current.deletion?.branchHead !== binding.deletion?.branchHead ||
              current.environmentRef?.environmentId !== binding.environmentRef.environmentId ||
              current.environmentRef.revision !== binding.environmentRef.revision ||
              current.environmentRef.manifestDigest !== binding.environmentRef.manifestDigest ||
              JSON.stringify(current.deletion?.sessionIds) !== JSON.stringify(sessionIds)
            )
              throw new Error(
                "stale-reference: legacy retirement requires the persisted discard journal",
              );
            if (!host.consumers.retireLegacyProcessesForDeletion)
              throw new Error("capability-unavailable: legacy discard retirement is unavailable");
            await host.consumers.retireLegacyProcessesForDeletion({
              workspacePath: current.checkoutPath,
              environmentId: binding.environmentRef.environmentId,
              expectedRevision: binding.environmentRef.revision,
              expectedManifestDigest: binding.environmentRef.manifestDigest,
              bindingId: current.id,
              requestId: current.deletion!.requestId,
              sessionIds,
              writer,
              repositoryRoot: current.repositoryRoot,
            });
          },
        }
      : {}),
    async rebindRuntimeEnvironmentSessions(params) {
      const binding = params.binding;
      if (params.oldEnvironmentRef.revision < 1) {
        const existing = await options.agents().cleanupWorktreeSessions({
          workspacePath: binding.originalWorkspacePath,
          workspaceIdentity: binding.originalWorkspaceIdentity,
          cleanup: {
            executionBindingId: binding.id,
            originWorkspacePath: binding.originalWorkspacePath,
            originWorkspaceIdentity: binding.originalWorkspaceIdentity,
            workspacePath: binding.workspacePath,
            workspaceIdentity: binding.workspaceIdentity,
            closeSessions: true,
          },
        });
        if (existing.sessionIds.length)
          throw new Error(
            "stale-reference: unprepared environment unexpectedly owns persisted sessions",
          );
        return existing;
      }
      const result = await options.agents().rebindWorktreeSessions({
        workspacePath: binding.originalWorkspacePath,
        workspaceIdentity: binding.originalWorkspaceIdentity,
        rebind: {
          executionBindingId: binding.id,
          originWorkspacePath: binding.originalWorkspacePath,
          originWorkspaceIdentity: binding.originalWorkspaceIdentity,
          workspacePath: binding.workspacePath,
          workspaceIdentity: binding.workspaceIdentity,
          oldEnvironmentRef: params.oldEnvironmentRef,
          newEnvironmentRef: params.newEnvironmentRef,
        },
      });
      await host.consumers.migrateSessions!({
        workspacePath: binding.checkoutPath,
        bindingId: binding.id,
        fromEnvironmentId: params.oldEnvironmentRef.environmentId,
        toEnvironmentId: params.newEnvironmentRef.environmentId,
        oldRevision: params.oldEnvironmentRef.revision,
        revision: params.newEnvironmentRef.revision,
        sessionIds: result.sessionIds,
      });
      if (params.oldEnvironmentRef.environmentId !== params.newEnvironmentRef.environmentId) {
        const released = await host.service.release({
          workspacePath: binding.checkoutPath,
          requestId: params.requestId,
          environmentId: params.oldEnvironmentRef.environmentId,
          expectedRevision: params.oldEnvironmentRef.revision,
          expectedManifestDigest: params.oldEnvironmentRef.manifestDigest,
          reason: "consumer-release",
        });
        if (released.status !== "released")
          throw new Error(
            `release-blocked: ${released.reason ?? "old environment still has live references"}`,
          );
      }
      return result;
    },
  };
}
export async function prepareBoundRuntime(options: {
  host: RuntimeHost;
  worktrees: IWorktreeHostService;
  params: RuntimeEnvironmentPrepareRequest;
  binding: WorktreeBinding;
}) {
  const { params, binding, host, worktrees } = options;
  if (params.operation !== "upgrade" || !binding.environmentRef)
    throw new Error(
      "capability-unavailable: managed preparation must enter through worktree creation or explicit update",
    );
  const expected =
    binding.environmentUpgrade?.requestId === params.requestId
      ? (binding.environmentRebuild?.oldEnvironmentRef ?? binding.environmentRef)
      : binding.environmentRef;
  if (
    params.environmentId !== expected.environmentId ||
    params.expectedRevision !== expected.revision ||
    (params.expectedManifestDigest !== undefined &&
      params.expectedManifestDigest !== expected.manifestDigest)
  )
    throw new Error("stale-reference: worktree environment changed before update");
  await worktrees.upgradeRuntimeEnvironment({
    bindingId: binding.id,
    requestId: params.requestId,
    expectedEnvironmentRef: expected,
    cancel: params.cancel,
  });
  const reconciled = await host.service.reconcile({
    workspacePath: binding.checkoutPath,
    requestId: params.requestId,
  });
  if (!reconciled.operation)
    throw new Error("process-unknown: environment update has no operation receipt");
  return reconciled.operation;
}
