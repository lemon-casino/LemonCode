import { randomUUID } from "node:crypto";
import {
  lcodeProtocolMethods,
  runtimeEnvironmentReleaseConsumerResultSchema,
  runtimeEnvironmentResolveContextResultSchema,
  type LCodeWorkspaceRef,
} from "@lcode/shared";
import type { LCodeProtocolAgentServerContext } from "./server-types.js";
import type { ProjectEnvironmentOverlayResolver } from "../app/project-environment-execution.js";

/** 此闭包属于一个 app incarnation；托管请求不能失败后切回系统环境。 */
export function createProjectEnvironmentOverlayResolver(
  context: Pick<LCodeProtocolAgentServerContext, "requestClient">,
  workspace: LCodeWorkspaceRef,
  sessionId: string,
): ProjectEnvironmentOverlayResolver {
  const ref = workspace.environmentRef;
  if (!ref) return async () => undefined;
  const bindingId = workspace.executionBindingId;
  if (!bindingId) throw new Error("Managed execution is missing its binding reference");
  const consumer = randomUUID();
  const identity = {
    sessionId, executionBindingId: bindingId,
    ...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
    ...(workspace.remoteSessionId ? { remoteSessionId: workspace.remoteSessionId } : {}),
  };
  let closed = false;
  let requested = false;
  const pending = new Set<Promise<unknown>>();
  const resolver: ProjectEnvironmentOverlayResolver = async (cwd) => {
    if (closed) throw new Error("Runtime environment consumer is closed");
    requested = true;
    const operation = context.requestClient(
      lcodeProtocolMethods.runtimeEnvironmentResolveContext,
      { ...identity, cwd: cwd ?? workspace.workspacePath, consumer, environmentRef: ref },
      runtimeEnvironmentResolveContextResultSchema,
    );
    pending.add(operation);
    try {
      const { context: frozen } = await operation;
      if (closed) throw new Error("Runtime environment closed before context delivery");
      if (frozen.environmentId !== ref.environmentId || frozen.revision !== ref.revision)
        throw new Error("stale-reference: Host returned a different environment");
      return frozen.envOverlay;
    } finally { pending.delete(operation); }
  };
  resolver.close = async () => {
    closed = true;
    await Promise.allSettled(pending);
    if (!requested) return;
    await context.requestClient(
      lcodeProtocolMethods.runtimeEnvironmentReleaseConsumer,
      { ...identity, environmentId: ref.environmentId, consumer },
      runtimeEnvironmentReleaseConsumerResultSchema,
    );
    requested = false;
  };
  return resolver;
}
