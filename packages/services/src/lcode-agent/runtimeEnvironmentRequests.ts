import {
  lcodeProtocolMethods,
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
  IRuntimeEnvironmentService,
  RuntimeEnvironmentConsumerAuthority,
  ResolvedProjectExecutionContext,
} from "../runtime-environment/contract.js";
import type { IWorktreeService, WorktreeBinding } from "../worktree/contract.js";
import {
  assertRuntimeCwd,
  assertRuntimeWorkspacePath,
  authorizeRuntimeBinding,
  runtimeStorageScope,
  type RuntimeClientWorkspace,
} from "./runtimeEnvironmentAuthorization.js";

export function isRuntimeEnvironmentRequest(method: string): boolean {
  return (
    method === lcodeProtocolMethods.runtimeEnvironmentResolveContext ||
    method === lcodeProtocolMethods.runtimeEnvironmentRetainSession ||
    method === lcodeProtocolMethods.runtimeEnvironmentReleaseConsumer
  );
}
function toWire(context: ResolvedProjectExecutionContext): ResolvedProjectContextWire {
  return {
    environmentId: context.environmentId,
    revision: context.revision,
    manifestDigest: context.manifestDigest,
    cwd: context.cwd,
    ...(context.executionScope.workspaceIdentity
      ? { workspaceIdentity: context.executionScope.workspaceIdentity }
      : {}),
    toolPaths: { ...context.toolPaths },
    envOverlay: context.envOverlay,
  };
}
interface ClientOptions {
  workspace: RuntimeClientWorkspace;
  clientId: string;
  service: IRuntimeEnvironmentService;
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
      bindingId: binding.id,
      consumer: request.consumer,
      cwd: request.cwd,
    });
    if (exited || closed.has(key)) throw new Error("runtime client closed before context delivery");
    return runtimeEnvironmentResolveContextResultSchema.parse({ context: toWire(context) });
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
