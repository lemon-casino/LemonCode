import type {
  RuntimeConsumerAcquireParams,
  RuntimeConsumerReference,
  RuntimeConsumerReleaseParams,
  RuntimeConsumerReleaseResult,
  RuntimeConsumerSessionDeletionParams,
  RuntimeEnvironmentScope,
} from "@lcode/shared";

/** 可信 Host 的物理 fs port；调用前由资源 owner 限定固定根，不能作为公开目录删除 API。 */
export type RuntimeResourceDirectoryRemover = (path: string) => Promise<void>;

export interface RuntimeEnvironmentResolveRequest extends RuntimeEnvironmentScope {
  environmentId: string;
  consumer: string;
  expectedRevision?: number;
  expectedManifestDigest?: string;
  bindingId?: string;
  cwd?: string;
}
export interface ResolvedProjectExecutionContext {
  environmentId: string;
  revision: number;
  manifestDigest: string;
  executionScope: RuntimeEnvironmentScope;
  cwd: string;
  toolPaths: Readonly<Record<string, string>>;
  envOverlay: { base?: "inherit" | "empty"; set?: Record<string, string>; unset?: string[] };
  resourceLeaseToken: string;
}
/** 可信执行 port；不注册到公开 RPC。 */
export interface RuntimeEnvironmentExecutionResolver {
  resolveContext(
    params: RuntimeEnvironmentResolveRequest,
  ): Promise<ResolvedProjectExecutionContext>;
  resolveContextForCwd(params: {
    cwd: string;
    consumer: string;
    workspaceIdentity?: string;
  }): Promise<ResolvedProjectExecutionContext | null>;
}
/** 消费者事实由 Host 生命周期证明驱动；UI 不持有 lease 或 owner generation。 */
export interface RuntimeConsumerProcessOwner extends RuntimeEnvironmentScope {
  /** 实际执行 owner 的不透明身份；当前实现含 agent- 前缀，不得假定裸 UUID。 */
  runtimeInstanceId: string;
  runtimeGeneration: number;
  startedAt: number;
  /** 仅诊断；授权由实际 client/进程树退出回调提供。 */
  pid?: number;
}
export interface RuntimeConsumerOwnerReceipt extends Pick<
  RuntimeConsumerReference,
  "environmentId" | "revision" | "id" | "ownerId" | "ownerGeneration" | "lease"
> {
  kind: "process";
  processOwner: RuntimeConsumerProcessOwner;
  exitConfirmedAt?: string;
}
/** 执行 Host 的本机观察；absent 不是进程树退出证明，只用于已确认 discard 的行政退役。 */
export type RuntimeProcessOwnerObserver = (
  owner: RuntimeConsumerProcessOwner,
) => Promise<"present" | "absent" | "unknown"> | "present" | "absent" | "unknown";
export interface RuntimeConsumerRetirement extends Pick<
  RuntimeConsumerOwnerReceipt,
  "environmentId" | "revision" | "kind" | "id" | "ownerId" | "ownerGeneration" | "lease"
> {
  bindingId: string;
  requestId: string;
  reason: "confirmed-worktree-discard";
  retiredAt: string;
  orphanedOwner?: { processOwner: RuntimeConsumerProcessOwner; observedAt: string };
}
export interface RuntimeConsumerLegacyDeletionParams extends RuntimeConsumerSessionDeletionParams {
  requestId: string;
  expectedRevision: number;
  expectedManifestDigest?: string;
  repositoryRoot: string;
  writer: import("../worktree/contract.js").CheckoutLease;
}
export interface RuntimeEnvironmentConsumerAuthority {
  acquire(
    params: RuntimeConsumerAcquireParams,
    processOwner?: RuntimeConsumerProcessOwner,
  ): Promise<RuntimeConsumerReference>;
  confirmProcessExit?(
    params: RuntimeConsumerReleaseParams,
    owner: RuntimeConsumerProcessOwner,
  ): Promise<void>;
  release(params: RuntimeConsumerReleaseParams): Promise<RuntimeConsumerReleaseResult>;
  retireLegacyProcessesForDeletion?(
    params: RuntimeConsumerLegacyDeletionParams,
  ): Promise<RuntimeConsumerReleaseResult>;
  releaseSessionsAfterDeletion(
    params: RuntimeConsumerSessionDeletionParams,
  ): Promise<RuntimeConsumerReleaseResult>;
  migrateSessions?(
    params: RuntimeEnvironmentScope & {
      bindingId: string;
      fromEnvironmentId: string;
      toEnvironmentId: string;
      revision: number;
      oldRevision?: number;
      sessionIds: string[];
    },
  ): Promise<void>;
}
