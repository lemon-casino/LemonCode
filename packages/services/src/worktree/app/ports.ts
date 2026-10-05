import type { WorktreeGitPort } from "../nodeTypes.js";
import type { WorktreeBinding, WorktreeIntegration, WorktreeSnapshot } from "../contract.js";

export interface WorktreeStore {
  key(value: string): string;
  checkout(id: string): string;
  lock<T>(key: string, action: () => Promise<T>): Promise<T>;
  readBinding(id: string): Promise<WorktreeBinding | null>;
  saveBinding(binding: WorktreeBinding): Promise<void>;
  readPreparationRequest(scope: string, requestId: string): Promise<string | null>;
  savePreparationRequest(scope: string, requestId: string, bindingId: string): Promise<void>;
  isPreparationCancelled(id: string): Promise<boolean>;
  cancelPreparation(id: string): Promise<void>;
  listBindings(): Promise<WorktreeBinding[]>;
  readOperation(id: string): Promise<WorktreeIntegration | null>;
  saveOperation(operation: WorktreeIntegration): Promise<void>;
  assertManagedPath(path: string): Promise<void>;
  removeCheckout(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  readAlias(id: string): Promise<WorktreeSessionAlias | null>;
  saveAlias(alias: WorktreeSessionAlias): Promise<void>;
  listAliases(): Promise<WorktreeSessionAlias[]>;
}
export interface WorktreeSessionAlias {
  id: string;
  taskId: string;
  parentTaskId: string;
  bindingId: string;
  originalKey: string;
  executionKey: string;
}
export interface WorktreeGit extends WorktreeGitPort {
  command(
    cwd: string,
    args: string[],
    extra?: { stdin?: string; env?: Record<string, string> },
  ): Promise<string>;
  inspect(
    path: string,
  ): Promise<{ root: string; commonDirectory: string; head: string; branch: string }>;
  resolveTarget(root: string, branch: string): Promise<{ head: string; path?: string }>;
  registered(root: string, path: string): Promise<boolean>;
  assertIdle(path: string): Promise<void>;
  snapshot(
    binding: WorktreeBinding,
    acknowledgeIgnored: boolean,
    includeIgnored?: boolean,
  ): Promise<WorktreeSnapshot>;
  restoreFiles(binding: WorktreeBinding): Promise<void>;
  matchesSnapshot(binding: WorktreeBinding, checkIgnored?: boolean): Promise<boolean>;
}
export interface WorktreeContext {
  collectDiscardSessions?: (binding: WorktreeBinding) => Promise<string[]>;
  discardSessions?: (binding: WorktreeBinding, sessionIds: string[]) => Promise<void>;
  commitSource?: (
    request: import("@lcode/shared").GitCommitRequest,
  ) => Promise<import("@lcode/shared").GitCommitResult>;
  store: WorktreeStore;
  git: WorktreeGit;
  fault(point: string): Promise<void>;
  runSetup(
    checkout: string,
    command: string,
    onOutput?: (output: string) => Promise<void>,
    /** 冻结上下文覆盖键值（如 PATH 前缀）；spawn 时合并进宿主环境，不改 Host process.env。 */
    env?: Record<string, string>,
  ): Promise<{ exitCode: number; output: string }>;
  detectSetup(checkout: string): Promise<string[]>;
  detectValidation(checkout: string): Promise<string[]>;
  copyIgnoredFiles(source: string, checkout: string, paths: string[]): Promise<void>;
  /**
   * 托管运行环境生命周期 port（spec: specs/worktree-runtime-environments.md §7）。
   * 环境事实 owner = RuntimeEnvironmentService；WorktreeService 只经此 port 调用，
   * 不共享实现。未注入 = Host 不支持托管环境，保持现状语义。
   */
  prepareRuntimeEnvironment?: (params: {
    bindingId: string;
    checkoutPath: string;
    requestId: string;
    purpose: "worktree";
  }) => Promise<{
    environmentId: string;
    revision: number;
    /** setup/验证 spawn 用的冻结覆盖键值；来源 = resolveContext().envOverlay.set。 */
    env?: Record<string, string>;
    /** 工具来源标注（spec §15.1 P2-07a）：准备时点冻结，UI 只读投影。 */
    toolSource?: "project-declaration" | "app-default" | "user-override" | "partial-host";
  }>;
}
