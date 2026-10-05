import type {
  RuntimeEnvironmentCapabilities,
  RuntimeEnvironmentError,
  RuntimeEnvironmentProjection,
  RuntimeEnvironmentScope,
  FrozenManifest,
  RuntimePreparationOperation,
} from "@lcode/shared";

import { createServiceDescriptor } from "../descriptors.js";

/**
 * 运行环境服务公开契约（spec: specs/worktree-runtime-environments.md §9.1）。
 * 环境事实唯一 owner；WorktreeService 经注入 port 调用，不共享实现。
 */
export interface RuntimeEnvironmentScopeRef extends RuntimeEnvironmentScope {}

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

export interface IRuntimeEnvironmentService {
  /** 平台/后端/工具类别与缺失原因；缺能力不伪造托管成功。 */
  getCapabilities(params: RuntimeEnvironmentScopeRef): Promise<RuntimeEnvironmentCapabilities>;
  /**
   * prepare/retry/cancel：同 requestId 幂等复用操作与环境。
   * cancel=true 只结算是当前操作，不复活首次输入。
   */
  prepare(params: RuntimeEnvironmentPrepareRequest): Promise<RuntimePreparationOperation>;
  /** 按 environmentId 或 requestId 查询投影；查询不产生执行。 */
  get(params: RuntimeEnvironmentScopeRef & {
    environmentId?: string;
    requestId?: string;
  }): Promise<RuntimeEnvironmentProjection | null>;
  list(params: RuntimeEnvironmentScopeRef): Promise<RuntimeEnvironmentProjection[]>;
  /** 每命令一份不可变冻结上下文；resourceLeaseToken 仅内部。 */
  resolveContext(params: RuntimeEnvironmentScopeRef & {
    environmentId: string;
    /** 消费者标识（session/terminal/mcp/service/candidate），用于引用结算与诊断。 */
    consumer: string;
  }): Promise<ResolvedProjectExecutionContext>;
  /**
   * release：回收收据或阻塞证据；重试指向原 environmentId，不新建资源。
   * expectedRevision 不匹配返回 stale-reference，不覆盖新代。
   */
  release(params: RuntimeEnvironmentReleaseRequest): Promise<{
    status: "released" | "releaseBlocked";
    reason?: string;
  }>;
  /** 崩溃/重启后对账：读原操作与环境记录，不重放安装、不新建任务。 */
  reconcile(params: RuntimeEnvironmentScopeRef & { requestId: string }): Promise<{
    operation: RuntimePreparationOperation | null;
    environment: RuntimeEnvironmentProjection | null;
  }>;
}

/**
 * 冻结执行上下文（spec §9.2 ResolvedProjectExecutionContext）。
 * 一命令一份不可变值；resourceLeaseToken 仅内部，不能发送给 UI。
 */
export interface ResolvedProjectExecutionContext {
  environmentId: string;
  revision: number;
  manifestDigest: string;
  executionScope: { workspacePath: string; workspaceIdentity?: string };
  cwd: string;
  toolPaths: Readonly<Record<string, string>>;
  envOverlay: {
    base?: "inherit" | "empty";
    set?: Record<string, string>;
    unset?: string[];
  };
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
