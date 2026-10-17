import type { ExecutionSetSnapshot } from "@lcode/shared";
import type { IWorktreeHostService } from "../worktree/contract.js";
import type { IProjectExecutionSetService, ProjectExecutionSetHostService } from "./contract.js";
import { createExecutionSetStore } from "./adapters/store.js";
import { createExecutionSetApplication } from "./app/service.js";
import { executionSetEvents } from "./adapters/events.js";
import type { ExecutionSetPorts } from "./app/ports.js";
export function createProjectExecutionSetService(options: {
  dataDir: string;
  worktrees: IWorktreeHostService;
  stopSessions?: (
    snapshot: ExecutionSetSnapshot,
  ) => Promise<{ stopped: true; sessionIds: string[] }>;
  selectArchiveSessions?: ExecutionSetPorts["selectArchiveSessions"];
  setSessionsArchived?: ExecutionSetPorts["setSessionsArchived"];
}): ProjectExecutionSetHostService {
  const store = createExecutionSetStore(options.dataDir);
  const events = executionSetEvents(options.dataDir, store);
  const application = createExecutionSetApplication({
    store,
    worktrees: options.worktrees,
    selectArchiveSessions: options.selectArchiveSessions,
    setSessionsArchived: options.setSessionsArchived,
    changed: events.publish,
    now: () => new Date().toISOString(),
    stopSessions:
      options.stopSessions ??
      (async () => {
        throw new Error("Execution set stop capability is unavailable");
      }),
  });
  return { ...application, onDidChange: events.subscribe };
}
export function createPublicProjectExecutionSetService(
  host: ProjectExecutionSetHostService,
): IProjectExecutionSetService {
  return {
    capabilities: () => host.capabilities(),
    get: (request) => host.get(request),
    list: (request) => host.list(request),
    bindings: (request) => host.bindings(request),
    retry: (request) => host.retry(request),
    rename: (request) => host.rename(request),
    archive: (request) => host.archive(request),
    restore: (request) => host.restore(request),
    onDidChange: host.onDidChange,
  };
}
