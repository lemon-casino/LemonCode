import type { WorktreeGitPort } from "../nodeTypes.js";
import type { WorktreeBinding, WorktreeIntegration, WorktreeSnapshot } from "../contract.js";

export interface WorktreeStore {
  key(value: string): string;
  checkout(id: string): string;
  lock<T>(key: string, action: () => Promise<T>): Promise<T>;
  readBinding(id: string): Promise<WorktreeBinding | null>;
  saveBinding(binding: WorktreeBinding): Promise<void>;
  listBindings(): Promise<WorktreeBinding[]>;
  readOperation(id: string): Promise<WorktreeIntegration | null>;
  saveOperation(operation: WorktreeIntegration): Promise<void>;
  assertManagedPath(path: string): Promise<void>;
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
  registered(root: string, path: string): Promise<boolean>;
  assertIdle(path: string): Promise<void>;
  snapshot(binding: WorktreeBinding, acknowledgeIgnored: boolean): Promise<WorktreeSnapshot>;
  restoreFiles(binding: WorktreeBinding): Promise<void>;
  matchesSnapshot(binding: WorktreeBinding, checkIgnored?: boolean): Promise<boolean>;
}
export interface WorktreeContext {
  commitSource?: (
    request: import("@lcode/shared").GitCommitRequest,
  ) => Promise<import("@lcode/shared").GitCommitResult>;
  store: WorktreeStore;
  git: WorktreeGit;
  fault(point: string): Promise<void>;
  runSetup(checkout: string, command: string): Promise<{ exitCode: number; output: string }>;
  copyIgnoredFiles(source: string, checkout: string, paths: string[]): Promise<void>;
}
