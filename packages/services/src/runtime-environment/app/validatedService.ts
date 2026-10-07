import type { IRuntimeEnvironmentHostService } from "../contract.js";
import {
  runtimeEnvironmentScopeSchema,
  runtimeEnvironmentPrepareParamsSchema,
  runtimeEnvironmentGetParamsSchema,
  runtimeEnvironmentListParamsSchema,
  runtimeEnvironmentReleaseParamsSchema,
  runtimeEnvironmentSnapshotParamsSchema,
  runtimeEnvironmentReconcileParamsSchema,
  runtimeEnvironmentServiceActionParamsSchema,
  runtimeEnvironmentResourceScanParamsSchema,
  runtimeEnvironmentGarbageCollectionParamsSchema,
} from "@lcode/shared";

export function validateRuntimeEnvironmentRequests(
  service: IRuntimeEnvironmentHostService,
): IRuntimeEnvironmentHostService {
  return {
    ...(service.onDidChangeEnvironment
      ? { onDidChangeEnvironment: service.onDidChangeEnvironment }
      : {}),
    getCapabilities: (params) =>
      service.getCapabilities(runtimeEnvironmentScopeSchema.parse(params)),
    prepare: (params) => service.prepare(runtimeEnvironmentPrepareParamsSchema.parse(params)),
    get: (params) => service.get(runtimeEnvironmentGetParamsSchema.parse(params)),
    list: (params) => service.list(runtimeEnvironmentListParamsSchema.parse(params)),
    snapshot: (params) => service.snapshot(runtimeEnvironmentSnapshotParamsSchema.parse(params)),
    resolveContext: (params) => service.resolveContext(params),
    resolveContextForCwd: (params) => service.resolveContextForCwd(params),
    release: (params) => service.release(runtimeEnvironmentReleaseParamsSchema.parse(params)),
    reconcile: (params) => service.reconcile(runtimeEnvironmentReconcileParamsSchema.parse(params)),
    startService: (params) =>
      service.startService(runtimeEnvironmentServiceActionParamsSchema.parse(params)),
    stopService: (params) =>
      service.stopService(runtimeEnvironmentServiceActionParamsSchema.parse(params)),
    resourceSummary: (params) =>
      service.resourceSummary(runtimeEnvironmentResourceScanParamsSchema.parse(params)),
    garbageCollect: (params) =>
      service.garbageCollect(runtimeEnvironmentGarbageCollectionParamsSchema.parse(params)),
  };
}
