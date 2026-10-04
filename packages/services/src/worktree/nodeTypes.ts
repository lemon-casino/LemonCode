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
  commitSource?: (
    request: import("@lcode/shared").GitCommitRequest,
  ) => Promise<import("@lcode/shared").GitCommitResult>;
  dataDir: string;
  git: WorktreeGitPort;
  coordinator?: CheckoutCoordinator;
  validate?: (
    checkoutPath: string,
    command: string,
  ) => Promise<{ exitCode: number; output: string }>;
  fault?: (point: string) => Promise<void>;
}
