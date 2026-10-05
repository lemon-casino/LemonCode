import type {
  FrozenManifest,
  RuntimeConsumerAcquireParams,
  RuntimeConsumerReference,
  RuntimeConsumerReleaseParams,
  RuntimeConsumerReleaseResult,
  RuntimeConsumerSessionDeletionParams,
  RuntimeEnvironmentCapabilities,
  RuntimeEnvironmentError,
  RuntimeEnvironmentProjection,
  RuntimeEnvironmentScope,
  RuntimePreparationOperation,
} from "@lcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export type RuntimeEnvironmentScopeRef = RuntimeEnvironmentScope;
export interface RuntimeEnvironmentPrepareRequest extends RuntimeEnvironmentScopeRef {
  requestId: string;
  purpose: "worktree" | "integration-candidate";
  bindingId?: string;
  expectedRevision?: number;
  cancel?: boolean;
}
export interface RuntimeEnvironmentReleaseRequest extends RuntimeEnvironmentScopeRef {
  requestId: string;
  environmentId: string;
  expectedRevision?: number;
}
export interface RuntimeEnvironmentResolveRequest extends RuntimeEnvironmentScopeRef {
  environmentId: string;
  consumer: string;
  expectedRevision?: number;
  bindingId?: string;
  cwd?: string;
}

export interface IRuntimeEnvironmentService {
  getCapabilities(params: RuntimeEnvironmentScopeRef): Promise<RuntimeEnvironmentCapabilities>;
  prepare(params: RuntimeEnvironmentPrepareRequest): Promise<RuntimePreparationOperation>;
  get(
    params: RuntimeEnvironmentScopeRef & { environmentId?: string; requestId?: string },
  ): Promise<RuntimeEnvironmentProjection | null>;
  list(params: RuntimeEnvironmentScopeRef): Promise<RuntimeEnvironmentProjection[]>;
  /** 只读冻结上下文；消费者必须由实际生命周期 owner 显式登记和结算。 */
  resolveContext(
    params: RuntimeEnvironmentResolveRequest,
  ): Promise<ResolvedProjectExecutionContext>;
  /** 仅本地受信调用可查询；协议授权必须先验证绑定，不能据 cwd 推断授权。 */
  resolveContextForCwd(params: {
    cwd: string;
    consumer: string;
    workspaceIdentity?: string;
  }): Promise<ResolvedProjectExecutionContext | null>;
  release(params: RuntimeEnvironmentReleaseRequest): Promise<{
    status: "released" | "releaseBlocked";
    reason?: string;
  }>;
  reconcile(params: RuntimeEnvironmentScopeRef & { requestId: string }): Promise<{
    operation: RuntimePreparationOperation | null;
    environment: RuntimeEnvironmentProjection | null;
  }>;
}

/** 仅组合根注入给可信生命周期 owner，不注册为 UI RPC 服务。 */
export interface RuntimeEnvironmentConsumerAuthority {
  acquire(params: RuntimeConsumerAcquireParams): Promise<RuntimeConsumerReference>;
  release(params: RuntimeConsumerReleaseParams): Promise<RuntimeConsumerReleaseResult>;
  releaseSessionsAfterDeletion(
    params: RuntimeConsumerSessionDeletionParams,
  ): Promise<RuntimeConsumerReleaseResult>;
}

export interface ResolvedProjectExecutionContext {
  environmentId: string;
  revision: number;
  manifestDigest: string;
  executionScope: RuntimeEnvironmentScope;
  cwd: string;
  toolPaths: Readonly<Record<string, string>>;
  envOverlay: {
    base?: "inherit" | "empty";
    set?: Record<string, string>;
    unset?: string[];
  };
  /** 内部执行载体；UI 投影不返回此字段。 */
  resourceLeaseToken: string;
}
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
