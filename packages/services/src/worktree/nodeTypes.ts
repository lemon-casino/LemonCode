import type {
  CheckoutAccessMode,
  CheckoutLease,
  WorktreeScope,
  WorktreeRuntimePorts,
  WorktreeCommandRunner,
} from "./contract.js";

export interface WorktreeGitPort {
  run(params: {
    cwd: string;
    args: string[];
    stdin?: string;
    env?: Record<string, string>;
    maxOutputBytes?: number;
    timeoutMs?: number;
  }): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut?: boolean;
    outputTruncated?: boolean;
  }>;
}
export interface CheckoutCoordinator {
  acquire(
    params: WorktreeScope & { ownerId: string; waitMs?: number; mode?: CheckoutAccessMode },
  ): Promise<CheckoutLease>;
  release(params: { token: string; ownerId: string }): Promise<void>;
}
export interface WorktreeServiceOptions extends WorktreeRuntimePorts {
  /** 可信 Host 的等待/观察 port；只控制既有确认归档/删除的退避，不授予新的操作范围。 */
  transientRetryWait?: WorktreeTransientRetryWait;
  /** 宿主物理文件系统删除；Store 校验受管路径之后才允许调用。 */
  removeDirectory?: (path: string) => Promise<void>;
  collectDiscardSessions?: (binding: import("./contract.js").WorktreeBinding) => Promise<string[]>;
  discardSessions?: (
    binding: import("./contract.js").WorktreeBinding,
    sessionIds: string[],
    writer: CheckoutLease,
  ) => Promise<void>;
  commitSource?: (
    request: import("@lcode/shared").GitCommitRequest,
  ) => Promise<import("@lcode/shared").GitCommitResult>;
  dataDir: string;
  git: WorktreeGitPort;
  coordinator?: CheckoutCoordinator;
  validate?: WorktreeCommandRunner;
  fault?: (point: string) => Promise<void>;
}

export type WorktreeTransientRetryWait = (params: {
  bindingId: string;
  requestId: string;
  attempt: number;
  delayMs: number;
  errorCode: string;
}) => Promise<void>;
