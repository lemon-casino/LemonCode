import type { IRuntimeEnvironmentService } from "../contract.js";
import {
  runtimeEnvironmentPrepareParamsSchema,
  runtimeEnvironmentGetParamsSchema,
  runtimeEnvironmentListParamsSchema,
  runtimeEnvironmentReleaseParamsSchema,
} from "@lcode/shared";

/**
 * 服务入口严格校验包装（spec §9.4；复用 worktree validatedService 惯例）。
 * 协议 schema（shared）→ 服务 contract → 这里 wrapping，三层同源，防"整体展开被拒"。
 */
export function validateRuntimeEnvironmentRequests(
  service: IRuntimeEnvironmentService,
): IRuntimeEnvironmentService {
  return {
    getCapabilities: (params) => service.getCapabilities(params),
    prepare: (params) => service.prepare(runtimeEnvironmentPrepareParamsSchema.parse(params)),
    get: (params) => service.get(runtimeEnvironmentGetParamsSchema.parse(params)),
    list: (params) => service.list(runtimeEnvironmentListParamsSchema.parse(params)),
    resolveContext: (params) => service.resolveContext(params),
    resolveContextForCwd: (params) => service.resolveContextForCwd(params),
    release: (params) => service.release(runtimeEnvironmentReleaseParamsSchema.parse(params)),
    reconcile: (params) => service.reconcile(params),
  };
}
