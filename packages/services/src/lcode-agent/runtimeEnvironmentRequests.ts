import {
  lcodeProtocolMethods,
  runtimeEnvironmentCapabilitiesSchema,
  runtimeEnvironmentCapabilitiesResultSchema,
  runtimeEnvironmentProtocolCapabilitySchema,
  runtimeEnvironmentScopeSchema,
  runtimeEnvironmentPrepareParamsSchema,
  runtimeEnvironmentPrepareResultSchema,
  runtimeEnvironmentGetParamsSchema,
  runtimeEnvironmentGetResultSchema,
  runtimeEnvironmentListParamsSchema,
  runtimeEnvironmentListResultSchema,
  runtimeEnvironmentSnapshotParamsSchema,
  runtimeEnvironmentSnapshotSchema,
  runtimeEnvironmentReconcileParamsSchema,
  runtimeEnvironmentReconcileResultSchema,
  runtimeEnvironmentReleaseParamsSchema,
  runtimeEnvironmentReleaseResultSchema,
  runtimeEnvironmentServiceActionParamsSchema,
  runtimeEnvironmentServiceActionResultSchema,
  runtimeEnvironmentResourceScanParamsSchema,
  runtimeEnvironmentResourceScanResultSchema,
  runtimeEnvironmentGarbageCollectionParamsSchema,
  runtimeEnvironmentGarbageCollectionResultSchema,
  type RuntimeEnvironmentProtocolCapability,
  type RuntimeEnvironmentScope,
  runtimeEnvironmentReleaseConsumerParamsSchema,
  runtimeEnvironmentReleaseConsumerResultSchema,
  runtimeEnvironmentRetainSessionParamsSchema,
  runtimeEnvironmentRetainSessionResultSchema,
  runtimeEnvironmentResolveContextParamsSchema,
  runtimeEnvironmentResolveContextResultSchema,
  type RuntimeConsumerReleaseParams,
  type ResolvedProjectContextWire,
} from "@lcode/shared";
import type {
  IRuntimeEnvironmentHostService,
  IRuntimeEnvironmentService,
  RuntimeEnvironmentConsumerAuthority,
  ResolvedProjectExecutionContext,
} from "../runtime-environment/contract.js";
import type { IWorktreeService, WorktreeBinding } from "../worktree/contract.js";
import {
  assertRuntimeCwd,
  assertRuntimeWorkspacePath,
  authorizeRuntimeBinding,
  authorizeRuntimeBindingIdentity,
  runtimeStorageScope,
  sameRuntimeWorkspacePath,
  type RuntimeClientWorkspace,
} from "./runtimeEnvironmentAuthorization.js";

const publicMethods = new Set<string>([
  lcodeProtocolMethods.runtimeEnvironmentCapabilities,
  lcodeProtocolMethods.runtimeEnvironmentPrepare,
  lcodeProtocolMethods.runtimeEnvironmentGet,
  lcodeProtocolMethods.runtimeEnvironmentList,
  lcodeProtocolMethods.runtimeEnvironmentSnapshot,
  lcodeProtocolMethods.runtimeEnvironmentReconcile,
  lcodeProtocolMethods.runtimeEnvironmentRelease,
  lcodeProtocolMethods.runtimeEnvironmentStartService,
  lcodeProtocolMethods.runtimeEnvironmentStopService,
  lcodeProtocolMethods.runtimeEnvironmentResourceSummary,
  lcodeProtocolMethods.runtimeEnvironmentGarbageCollect,
]);
export function isRuntimeEnvironmentPublicRequest(method: string): boolean {
  return publicMethods.has(method);
}

/** 只投影真实服务能力；无服务/旧端无字段不等于托管支持。 */
export async function readRuntimeEnvironmentProtocolCapability(
  service: Pick<IRuntimeEnvironmentService, "getCapabilities"> | undefined,
  scope: RuntimeEnvironmentScope,
): Promise<RuntimeEnvironmentProtocolCapability | undefined> {
  if (!service) return undefined;
  try {
    const caps = runtimeEnvironmentCapabilitiesSchema.parse(await service.getCapabilities(scope));
    return runtimeEnvironmentProtocolCapabilitySchema.parse({
      managedEnvironments: caps.managedEnvironments,
      ...(caps.protocolVersion !== undefined ? { protocolVersion: caps.protocolVersion } : {}),
      ...(caps.actions ? { actions: caps.actions } : {}),
      ...(caps.platform ? { platform: caps.platform } : {}),
      ...(caps.missingReason ? { missingReason: caps.missingReason } : {}),
    });
  } catch {
    return {
      managedEnvironments: false,
      missingReason: "Runtime environment capability is unavailable on the target Host",
    };
  }
}

/** 反向管理请求与 UI 共用公开 facade；attachment 只授权 binding，不接受裸 cwd 推断。 */
export async function handleRuntimeEnvironmentPublicRequest(
  method: string,
  raw: unknown,
  workspace: RuntimeClientWorkspace,
  service: IRuntimeEnvironmentService | undefined,
  worktrees?: IWorktreeService,
): Promise<unknown> {
  const authorize = async <T extends RuntimeEnvironmentScope>(params: T): Promise<T> => {
    const same = (scope: RuntimeEnvironmentScope) =>
      (params.workspaceIdentity?.trim() || "") === (scope.workspaceIdentity?.trim() || "") &&
      sameRuntimeWorkspacePath(params.workspacePath, scope.workspacePath);
    if (same(workspace)) return params;
    const owned = await worktrees?.list({
      workspacePath: workspace.workspacePath,
      ...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
    });
    if (
      !owned?.some(
        (binding) =>
          binding.status !== "deleted" &&
          same(binding) &&
          (binding.originalWorkspaceIdentity?.trim() || "") ===
            (workspace.workspaceIdentity?.trim() || "") &&
          sameRuntimeWorkspacePath(binding.originalWorkspacePath, workspace.workspacePath),
      )
    )
      throw new Error(
        "scope-mismatch: runtime management request differs from the attached workspace",
      );
    return params;
  };
  if (!service)
    throw new Error(
      "capability-unavailable: managed runtime environments are unavailable on this Host",
    );
  switch (method) {
    case lcodeProtocolMethods.runtimeEnvironmentCapabilities:
      return runtimeEnvironmentCapabilitiesResultSchema.parse({
        capabilities: await service.getCapabilities(
          await authorize(runtimeEnvironmentScopeSchema.parse(raw)),
        ),
      });
    case lcodeProtocolMethods.runtimeEnvironmentPrepare:
      return runtimeEnvironmentPrepareResultSchema.parse({
        operation: await service.prepare(
          await authorize(runtimeEnvironmentPrepareParamsSchema.parse(raw)),
        ),
      });
    case lcodeProtocolMethods.runtimeEnvironmentGet:
      return runtimeEnvironmentGetResultSchema.parse({
        environment: await service.get(
          await authorize(runtimeEnvironmentGetParamsSchema.parse(raw)),
        ),
      });
    case lcodeProtocolMethods.runtimeEnvironmentList:
      return runtimeEnvironmentListResultSchema.parse({
        environments: await service.list(
          await authorize(runtimeEnvironmentListParamsSchema.parse(raw)),
        ),
      });
    case lcodeProtocolMethods.runtimeEnvironmentSnapshot:
      return runtimeEnvironmentSnapshotSchema.parse(
        await service.snapshot(await authorize(runtimeEnvironmentSnapshotParamsSchema.parse(raw))),
      );
    case lcodeProtocolMethods.runtimeEnvironmentReconcile:
      return runtimeEnvironmentReconcileResultSchema.parse(
        await service.reconcile(
          await authorize(runtimeEnvironmentReconcileParamsSchema.parse(raw)),
        ),
      );
    case lcodeProtocolMethods.runtimeEnvironmentRelease:
      return runtimeEnvironmentReleaseResultSchema.parse(
        await service.release(await authorize(runtimeEnvironmentReleaseParamsSchema.parse(raw))),
      );
    case lcodeProtocolMethods.runtimeEnvironmentStartService:
      return runtimeEnvironmentServiceActionResultSchema.parse(
        await service.startService(
          await authorize(runtimeEnvironmentServiceActionParamsSchema.parse(raw)),
        ),
      );
    case lcodeProtocolMethods.runtimeEnvironmentStopService:
      return runtimeEnvironmentServiceActionResultSchema.parse(
        await service.stopService(
          await authorize(runtimeEnvironmentServiceActionParamsSchema.parse(raw)),
        ),
      );
    case lcodeProtocolMethods.runtimeEnvironmentResourceSummary:
      return runtimeEnvironmentResourceScanResultSchema.parse(
        await service.resourceSummary(
          await authorize(runtimeEnvironmentResourceScanParamsSchema.parse(raw)),
        ),
      );
    case lcodeProtocolMethods.runtimeEnvironmentGarbageCollect:
      return runtimeEnvironmentGarbageCollectionResultSchema.parse(
        await service.garbageCollect(
          await authorize(runtimeEnvironmentGarbageCollectionParamsSchema.parse(raw)),
        ),
      );
    default:
      throw new Error("Unknown runtime environment request");
  }
}

export function isRuntimeEnvironmentRequest(method: string): boolean {
  return (
    isRuntimeEnvironmentPublicRequest(method) ||
    method === lcodeProtocolMethods.runtimeEnvironmentResolveContext ||
    method === lcodeProtocolMethods.runtimeEnvironmentRetainSession ||
    method === lcodeProtocolMethods.runtimeEnvironmentReleaseConsumer
  );
}
function toWire(
  context: ResolvedProjectExecutionContext,
  workspaceIdentity?: string,
): ResolvedProjectContextWire {
  return {
    environmentId: context.environmentId,
    revision: context.revision,
    manifestDigest: context.manifestDigest,
    cwd: context.cwd,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    toolPaths: { ...context.toolPaths },
    envOverlay: context.envOverlay,
  };
}
interface ClientOptions {
  workspace: RuntimeClientWorkspace;
  clientId: string;
  service: IRuntimeEnvironmentHostService;
  consumers: RuntimeEnvironmentConsumerAuthority;
  worktrees: IWorktreeService;
}
interface Ticket {
  sessionId: string;
  executionBindingId: string;
  remoteSessionId?: string;
  workspaceIdentity?: string;
  release: RuntimeConsumerReleaseParams;
}

/** client 代际是进程引用 owner；RPC 断开不清理，只有实际退出或明确 close 才结算。 */
export function createRuntimeEnvironmentClient(options: ClientOptions) {
  const tickets = new Map<string, Ticket>();
  const closed = new Set<string>();
  const pending = new Set<Promise<unknown>>();
  let exited = false;
  const keyOf = (environmentId: string, sessionId: string, consumer: string) =>
    JSON.stringify([environmentId, sessionId, consumer]);
  const session = async (binding: WorktreeBinding, sessionId: string) => {
    const ref = binding.environmentRef!;
    return options.consumers.acquire({
      ...runtimeStorageScope(binding),
      ...ref,
      kind: "session",
      id: sessionId,
      ownerId: `binding:${binding.id}`,
    });
  };
  const releaseTicket = async (key: string, ticket: Ticket) => {
    const result = await options.consumers.release(ticket.release);
    tickets.delete(key);
    return result;
  };

  async function dispatch(method: string, raw: unknown): Promise<unknown> {
    if (exited) throw new Error("runtime client process already exited");
    if (method === lcodeProtocolMethods.runtimeEnvironmentRetainSession) {
      const request = runtimeEnvironmentRetainSessionParamsSchema.parse(raw);
      const binding = await authorizeRuntimeBinding(
        options.worktrees,
        options.workspace,
        request,
        request.environmentRef,
      );
      assertRuntimeWorkspacePath(binding, request.workspacePath);
      if (exited) throw new Error("runtime client process already exited");
      await session(binding, request.sessionId);
      return runtimeEnvironmentRetainSessionResultSchema.parse({ retained: true });
    }
    if (method === lcodeProtocolMethods.runtimeEnvironmentReleaseConsumer) {
      const request = runtimeEnvironmentReleaseConsumerParamsSchema.parse(raw);
      const key = keyOf(request.environmentId, request.sessionId, request.consumer);
      const ticket = tickets.get(key);
      if ((request.remoteSessionId ?? "") !== (options.workspace.remoteSessionId ?? ""))
        throw new Error("scope-mismatch: runtime release attachment differs");
      if (!ticket) {
        // 无 ticket 的迟到 close 仍须绑定授权，否则错 identity 能抢先写 closed 墓碑阻断合法 app。
        const binding = await authorizeRuntimeBindingIdentity(
          options.worktrees,
          options.workspace,
          request,
        );
        if (binding.environmentRef?.environmentId !== request.environmentId)
          throw new Error("scope-mismatch: runtime release environment differs");
        closed.add(key);
        return { removed: 0, remaining: 0 };
      }
      if (
        ticket.sessionId !== request.sessionId ||
        ticket.executionBindingId !== request.executionBindingId ||
        (ticket.workspaceIdentity ?? "") !== (request.workspaceIdentity ?? "")
      )
        throw new Error("scope-mismatch: runtime release consumer differs");
      closed.add(key);
      return runtimeEnvironmentReleaseConsumerResultSchema.parse(await releaseTicket(key, ticket));
    }
    if (method !== lcodeProtocolMethods.runtimeEnvironmentResolveContext)
      throw new Error("Unknown runtime environment request");
    const request = runtimeEnvironmentResolveContextParamsSchema.parse(raw);
    const key = keyOf(request.environmentRef.environmentId, request.sessionId, request.consumer);
    if (closed.has(key)) throw new Error("stale-reference: app incarnation was already closed");
    const binding = await authorizeRuntimeBinding(
      options.worktrees,
      options.workspace,
      request,
      request.environmentRef,
    );
    await assertRuntimeCwd(binding, request.cwd);
    if (exited || closed.has(key)) throw new Error("runtime client closed before acquire");
    await session(binding, request.sessionId);
    const scope = runtimeStorageScope(binding);
    const reference = await options.consumers.acquire({
      ...scope,
      ...request.environmentRef,
      kind: "process",
      id: JSON.stringify([request.sessionId, request.consumer]),
      ownerId: options.clientId,
    });
    const ticket: Ticket = {
      sessionId: request.sessionId,
      executionBindingId: binding.id,
      workspaceIdentity: request.workspaceIdentity,
      remoteSessionId: request.remoteSessionId,
      release: {
        ...scope,
        environmentId: reference.environmentId,
        kind: reference.kind,
        id: reference.id,
        ownerId: reference.ownerId,
        ownerGeneration: reference.ownerGeneration,
        lease: reference.lease,
      },
    };
    const previous = tickets.get(key);
    if (previous && previous.sessionId !== request.sessionId)
      throw new Error("scope-mismatch: app incarnation belongs to another session");
    tickets.set(key, ticket);
    if (exited || closed.has(key)) {
      await releaseTicket(key, ticket);
      throw new Error("runtime client exited before context delivery");
    }
    const context = await options.service.resolveContext({
      ...scope,
      environmentId: reference.environmentId,
      expectedRevision: reference.revision,
      ...((request.environmentRef.manifestDigest ?? binding.environmentRef?.manifestDigest)
        ? {
            expectedManifestDigest:
              request.environmentRef.manifestDigest ?? binding.environmentRef?.manifestDigest,
          }
        : {}),
      bindingId: binding.id,
      consumer: request.consumer,
      cwd: request.cwd,
    });
    if (exited || closed.has(key)) throw new Error("runtime client closed before context delivery");
    if (
      context.environmentId !== request.environmentRef.environmentId ||
      context.revision !== request.environmentRef.revision ||
      (request.environmentRef.manifestDigest &&
        context.manifestDigest !== request.environmentRef.manifestDigest)
    )
      throw new Error("stale-reference: runtime resolved context differs from the bound reference");
    // storage scope 只有 Host 本地 checkoutPath，wire 必须恢复已授权的远端 execution identity。
    return runtimeEnvironmentResolveContextResultSchema.parse({
      context: toWire(context, request.workspaceIdentity),
    });
  }

  return {
    async handle(method: string, raw: unknown) {
      const operation = dispatch(method, raw);
      pending.add(operation);
      try {
        return await operation;
      } finally {
        pending.delete(operation);
      }
    },
    async disposeAfterProcessExit() {
      exited = true;
      await Promise.allSettled(pending);
      for (const [key, ticket] of tickets) await releaseTicket(key, ticket);
    },
  };
}
