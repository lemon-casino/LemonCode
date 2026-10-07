import type {
  RuntimeConsumerAcquireParams,
  RuntimeConsumerReference,
  RuntimeConsumerReleaseParams,
  RuntimeConsumerReleaseResult,
  RuntimeConsumerSessionDeletionParams,
  RuntimeEnvironmentScope,
} from "@lcode/shared";

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
export interface RuntimeEnvironmentConsumerAuthority {
  acquire(params: RuntimeConsumerAcquireParams): Promise<RuntimeConsumerReference>;
  release(params: RuntimeConsumerReleaseParams): Promise<RuntimeConsumerReleaseResult>;
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
