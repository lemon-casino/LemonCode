import {
  runtimeEnvironmentResolveContextResultSchema,
  type RuntimeEnvironmentReference,
} from "@lcode/shared";
import type { ResolvedProjectExecutionContext } from "../runtime-environment/contract.js";

/** 冻结上下文交付前复验绑定引用；wire 只暴露执行值，不携带 Host 内部 owner/lease。 */
export function createRuntimeEnvironmentContextResult(
  context: ResolvedProjectExecutionContext,
  expected: RuntimeEnvironmentReference,
  workspaceIdentity?: string,
) {
  if (
    context.environmentId !== expected.environmentId ||
    context.revision !== expected.revision ||
    (expected.manifestDigest && context.manifestDigest !== expected.manifestDigest)
  )
    throw new Error("stale-reference: runtime resolved context differs from the bound reference");
  // 环境存储 scope 是 Host checkout，远程 execution identity 来自此前已授权的 binding。
  return runtimeEnvironmentResolveContextResultSchema.parse({
    context: {
      environmentId: context.environmentId,
      revision: context.revision,
      manifestDigest: context.manifestDigest,
      cwd: context.cwd,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      toolPaths: { ...context.toolPaths },
      envOverlay: context.envOverlay,
    },
  });
}
