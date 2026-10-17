import type { ExecutionSetSnapshot } from "@lcode/shared";
import type { IWorktreeHostService } from "../../worktree/contract.js";
export interface ExecutionSetStore {
  key(value: string): string;
  lock<T>(id: string, action: () => Promise<T>): Promise<T>;
  read(id: string): Promise<ExecutionSetSnapshot | null>;
  write(snapshot: ExecutionSetSnapshot): Promise<void>;
  list(): Promise<ExecutionSetSnapshot[]>;
}
export interface ExecutionSetPorts {
  store: ExecutionSetStore;
  worktrees: IWorktreeHostService;
  changed(snapshot: ExecutionSetSnapshot): void;
  now(): string;
  /** 必须等目标会话与子进程实际停止，不能把断连或读取不到进程当成 true。 */
  stopSessions(snapshot: ExecutionSetSnapshot): Promise<{ stopped: true; sessionIds: string[] }>;
  selectArchiveSessions?(snapshot: ExecutionSetSnapshot): Promise<string[]>;
  setSessionsArchived?(snapshot: ExecutionSetSnapshot, archived: boolean): Promise<void>;
}
