import type { CheckoutLease, WorktreeScope } from "./contract.js";

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
  acquire(params: WorktreeScope & { ownerId: string; waitMs?: number }): Promise<CheckoutLease>;
  release(params: { token: string; ownerId: string }): Promise<void>;
}
export interface WorktreeServiceOptions {
  /** 宿主物理文件系统删除；Store 校验受管路径之后才允许调用。 */
  removeDirectory?: (path: string) => Promise<void>;
  collectDiscardSessions?: (binding: import("./contract.js").WorktreeBinding) => Promise<string[]>;
  discardSessions?: (
    binding: import("./contract.js").WorktreeBinding,
    sessionIds: string[],
  ) => Promise<void>;
  commitSource?: (
    request: import("@lcode/shared").GitCommitRequest,
  ) => Promise<import("@lcode/shared").GitCommitResult>;
  /**
   * 托管运行环境生命周期 port（spec: specs/worktree-runtime-environments.md §7）。
   * 未注入 = Host 不支持托管环境；注入后环境准备失败则工作树准备整体失败。
   */
  prepareRuntimeEnvironment?: (params: {
    bindingId: string;
    checkoutPath: string;
    requestId: string;
    purpose: "worktree";
  }) => Promise<{ environmentId: string; revision: number }>;
  dataDir: string;
  git: WorktreeGitPort;
  coordinator?: CheckoutCoordinator;
  validate?: (
    checkoutPath: string,
    command: string,
  ) => Promise<{ exitCode: number; output: string }>;
  fault?: (point: string) => Promise<void>;
}
