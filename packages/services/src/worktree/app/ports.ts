import type { WorktreeGitPort } from "../nodeTypes.js";
import type {
  WorktreeBinding, WorktreeIntegration, WorktreeSnapshot, WorktreeRuntimePorts, WorktreeCommandRunner,
} from "../contract.js";

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
export interface WorktreeContext extends WorktreeRuntimePorts {
  collectDiscardSessions?: (binding: WorktreeBinding) => Promise<string[]>;
  discardSessions?: (binding: WorktreeBinding, sessionIds: string[]) => Promise<void>;
  commitSource?: (
    request: import("@lcode/shared").GitCommitRequest,
  ) => Promise<import("@lcode/shared").GitCommitResult>;
  store: WorktreeStore;
  git: WorktreeGit;
  fault(point: string): Promise<void>;
  runSetup: WorktreeCommandRunner;
  declarationDigest(checkout: string): Promise<string>;
  detectSetup(checkout: string): Promise<string[]>;
  detectValidation(checkout: string): Promise<string[]>;
  copyIgnoredFiles(source: string, checkout: string, paths: string[]): Promise<void>;
}
