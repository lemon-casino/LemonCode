import type { Event } from "@lcode/rpc";
import type {
  FrozenManifest,
  RuntimeEnvironmentEvent,
  RuntimeEnvironmentCapabilities,
  RuntimeEnvironmentError,
  RuntimeEnvironmentGarbageCollectionParams,
  RuntimeEnvironmentGarbageCollectionResult,
  RuntimeEnvironmentPrepareParams,
  RuntimeEnvironmentProjection,
  RuntimeEnvironmentReleaseParams,
  RuntimeEnvironmentReleaseResult,
  RuntimeEnvironmentResourceScanParams,
  RuntimeEnvironmentResourceScanResult,
  RuntimeEnvironmentScope,
  RuntimeEnvironmentServiceActionParams,
  RuntimeEnvironmentServiceActionResult,
  RuntimeEnvironmentSnapshot,
  RuntimePreparationOperation,
} from "@lcode/shared";
import type { RuntimeEnvironmentExecutionResolver } from "./hostContract.js";
import { createServiceDescriptor } from "../descriptors.js";

export type {
  RuntimeEnvironmentConsumerAuthority,
  RuntimeConsumerProcessOwner,
  RuntimeProcessOwnerObserver,
  RuntimeResourceDirectoryRemover,
  RuntimeConsumerOwnerReceipt,
  RuntimeConsumerRetirement,
  RuntimeConsumerLegacyDeletionParams,
  RuntimeEnvironmentExecutionResolver,
  RuntimeEnvironmentResolveRequest,
  ResolvedProjectExecutionContext,
} from "./hostContract.js";
export type RuntimeEnvironmentScopeRef = RuntimeEnvironmentScope;
export type RuntimeEnvironmentPrepareRequest = RuntimeEnvironmentPrepareParams;
export type RuntimeEnvironmentReleaseRequest = RuntimeEnvironmentReleaseParams;
export interface IRuntimeEnvironmentService {
  readonly onDidChangeEnvironment?: Event<RuntimeEnvironmentEvent>;
  getCapabilities(params: RuntimeEnvironmentScopeRef): Promise<RuntimeEnvironmentCapabilities>;
  prepare(params: RuntimeEnvironmentPrepareRequest): Promise<RuntimePreparationOperation>;
  get(
    params: RuntimeEnvironmentScopeRef & { environmentId?: string; requestId?: string },
  ): Promise<RuntimeEnvironmentProjection | null>;
  list(params: RuntimeEnvironmentScopeRef): Promise<RuntimeEnvironmentProjection[]>;
  snapshot(
    params: RuntimeEnvironmentScopeRef & { environmentId: string },
  ): Promise<RuntimeEnvironmentSnapshot>;
  release(params: RuntimeEnvironmentReleaseRequest): Promise<RuntimeEnvironmentReleaseResult>;
  reconcile(params: RuntimeEnvironmentScopeRef & { requestId: string }): Promise<{
    operation: RuntimePreparationOperation | null;
    environment: RuntimeEnvironmentProjection | null;
  }>;
  startService(
    params: RuntimeEnvironmentServiceActionParams,
  ): Promise<RuntimeEnvironmentServiceActionResult>;
  stopService(
    params: RuntimeEnvironmentServiceActionParams,
  ): Promise<RuntimeEnvironmentServiceActionResult>;
  resourceSummary(
    params: RuntimeEnvironmentResourceScanParams,
  ): Promise<RuntimeEnvironmentResourceScanResult>;
  garbageCollect(
    params: RuntimeEnvironmentGarbageCollectionParams,
  ): Promise<RuntimeEnvironmentGarbageCollectionResult>;
}
/** 组合根保存完整 Host 能力；只将上面的公开管理合同注册到 RPC。 */
export type IRuntimeEnvironmentHostService = IRuntimeEnvironmentService &
  RuntimeEnvironmentExecutionResolver;
export interface RuntimeEnvironmentManifestRecord {
  environmentId: string;
  revision: number;
  manifest: FrozenManifest;
}
export type {
  RuntimeEnvironmentCapabilities,
  RuntimeEnvironmentError,
  RuntimeEnvironmentProjection,
  FrozenManifest,
  RuntimePreparationOperation,
};
export const IRuntimeEnvironmentService =
  createServiceDescriptor<IRuntimeEnvironmentService>("runtime-environment");
