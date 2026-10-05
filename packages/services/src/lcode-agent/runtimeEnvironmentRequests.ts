import {
  lcodeProtocolMethods,
  runtimeEnvironmentResolveContextParamsSchema,
  type ResolvedProjectContextWire,
} from "@lcode/shared";
import type {
  IRuntimeEnvironmentService,
  ResolvedProjectExecutionContext,
} from "../runtime-environment/contract.js";

/**
 * 运行环境反向请求桥接（spec: specs/worktree-runtime-environments.md §9.3，P2-03）。
 * 严格 parse + token 不出 Host；缺服务 = Host 不支持托管，明确报错（不静默忽略字段）。
 */

const RUNTIME_ENVIRONMENT_METHODS: readonly string[] = [
  lcodeProtocolMethods.runtimeEnvironmentResolveContext,
];

export function isRuntimeEnvironmentRequest(method: string): boolean {
  return RUNTIME_ENVIRONMENT_METHODS.includes(method);
}

/** wire 投影：resourceLeaseToken 仅内部，不进协议（spec §9.2）。 */
function toWire(context: ResolvedProjectExecutionContext): ResolvedProjectContextWire {
  return {
    environmentId: context.environmentId,
    revision: context.revision,
    manifestDigest: context.manifestDigest,
    cwd: context.cwd,
    toolPaths: { ...context.toolPaths },
    envOverlay: {
      ...(context.envOverlay.base ? { base: context.envOverlay.base } : {}),
      ...(context.envOverlay.set ? { set: { ...context.envOverlay.set } } : {}),
      ...(context.envOverlay.unset ? { unset: [...context.envOverlay.unset] } : {}),
    },
  };
}

export async function handleRuntimeEnvironmentRequest(
  method: string,
  params: unknown,
  service?: IRuntimeEnvironmentService,
): Promise<unknown> {
  if (!service) throw new Error("Managed runtime environments are not available on this Host.");
  if (method === lcodeProtocolMethods.runtimeEnvironmentResolveContext) {
    const request = runtimeEnvironmentResolveContextParamsSchema.parse(params);
    const context = await service.resolveContextForCwd(request);
    // 无命中 = 非托管 spawn，保持现有继承语义；不是错误（spec §9.3）。
    return { context: context ? toWire(context) : null };
  }
  throw new Error("Unknown runtime environment request.");
}
