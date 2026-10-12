import type {
  IMemoryService,
  IServiceAccessor,
  ProjectMemoryWorkspaceSummary,
} from "@lcode/services";
import type { AppSettings, IPlatformService } from "@lcode/shared";

type Location = Parameters<IMemoryService["changeStorageLocation"]>[0]["location"];
const projectLabel = "local-project-with-a-long-worktree-name";
const profileCatalog: ProjectMemoryWorkspaceSummary = {
  id: "profile-project",
  label: projectLabel,
  storageLocation: "profile",
  memoryRoot: "/fixture/user-profile/cli/memories/projects/project/memory",
  updatedAt: 1780000000000,
  files: [
    {
      name: "MEMORY.md",
      path: "/fixture/user-profile/cli/memories/projects/project/memory/MEMORY.md",
      kind: "index",
      size: 14,
      updatedAt: 1780000000000,
    },
  ],
};
const projectCatalog: ProjectMemoryWorkspaceSummary = {
  ...profileCatalog,
  id: "workspace-project",
  storageLocation: "workspace",
  memoryRoot: "/fixture/local project with spaces/.lcode/memory",
  files: [
    {
      ...profileCatalog.files[0]!,
      path: "/fixture/local project with spaces/.lcode/memory/MEMORY.md",
    },
  ],
};
const worktreeLabel = "local-project / lcode/task-memory-worktree";
const worktreeProfileCatalog: ProjectMemoryWorkspaceSummary = {
  ...profileCatalog,
  id: "worktree-profile",
  label: worktreeLabel,
  memoryRoot: "/fixture/user-profile/cli/memories/projects/checkout-hash/memory",
  files: [
    {
      ...profileCatalog.files[0]!,
      path: "/fixture/user-profile/cli/memories/projects/checkout-hash/memory/MEMORY.md",
    },
  ],
};
const worktreeWorkspaceCatalog: ProjectMemoryWorkspaceSummary = {
  ...worktreeProfileCatalog,
  id: "worktree-workspace",
  storageLocation: "workspace",
  memoryRoot: "/fixture/custom worktrees/checkout/.lcode/memory",
  files: [
    {
      ...profileCatalog.files[0]!,
      path: "/fixture/custom worktrees/checkout/.lcode/memory/MEMORY.md",
    },
  ],
};
const includeWorktreeCatalog = new URLSearchParams(window.location.search).has("worktree-memory");
let snapshot = {
  location: "profile" as Location,
  revision: 0,
  enabled: true,
  calls: 0,
  reads: 0,
  settingsReads: 0,
  syncs: 0,
  pending: false,
  pendingRead: false,
  projectCopied: false,
  catalog: "ready" as "ready" | "empty" | "error",
};
let held = false;
let failure = false;
let syncFailure = false;
let savedReadFailure = false;
let holdNextRead = false;
let releaseRead: (() => void) | undefined;
let releasePending: (() => void) | undefined;
const listeners = new Set<() => void>();
const settingsListeners = new Set<() => void>();
function emit(patch: Partial<typeof snapshot>) {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((listener) => listener());
}
const settingService = {
  get: async () => {
    emit({ settingsReads: snapshot.settingsReads + 1 });
    if (savedReadFailure && snapshot.location === "workspace")
      throw new Error("Fixture saved settings cannot be read");
    const captured = {
      memoryEnabled: snapshot.enabled,
      memoryStorageLocation: snapshot.location,
      memoryStorageRevision: snapshot.revision,
    } as AppSettings;
    if (holdNextRead) {
      holdNextRead = false;
      emit({ pendingRead: true });
      await new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      emit({ pendingRead: false });
    }
    return captured;
  },
  update: async (patch: Partial<AppSettings>) => {
    emit({
      enabled: patch.memoryEnabled ?? snapshot.enabled,
      location: patch.memoryStorageLocation ?? snapshot.location,
      revision: patch.memoryStorageRevision ?? snapshot.revision,
    });
  },
};
const memoryService: IMemoryService = {
  listProjectMemories: async () => {
    emit({ reads: snapshot.reads + 1 });
    if (snapshot.catalog === "error") throw new Error("Fixture catalog unavailable");
    if (snapshot.catalog === "empty") return [];
    const catalog = snapshot.projectCopied ? [profileCatalog, projectCatalog] : [profileCatalog];
    return includeWorktreeCatalog
      ? [...catalog, worktreeProfileCatalog, worktreeWorkspaceCatalog]
      : catalog;
  },
  readProjectMemoryFile: async () => ({ content: "fixture memory", updatedAt: 1780000000000 }),
  changeStorageLocation: async ({ location }) => {
    emit({ calls: snapshot.calls + 1, pending: true });
    try {
      if (held)
        await new Promise<void>((resolve) => {
          releasePending = resolve;
        });
      if (failure) {
        failure = false;
        throw new Error("Fixture target is read-only");
      }
      const copiedCount = location === "workspace" && !snapshot.projectCopied ? 1 : 0;
      emit({ projectCopied: snapshot.projectCopied || location === "workspace" });
      await settingService.update({
        memoryStorageLocation: location,
        memoryStorageRevision: snapshot.revision + (location === snapshot.location ? 0 : 1),
      });
      return { location, copiedCount, conflictCount: 1 };
    } finally {
      emit({ pending: false });
    }
  },
};
export const memoryFixture = {
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  snapshot: () => snapshot,
  setHeld: (value: boolean) => {
    held = value;
  },
  failNext: () => {
    failure = true;
  },
  failSync: () => {
    syncFailure = true;
  },
  failSavedReads: () => {
    savedReadFailure = true;
  },
  resumeReads: () => {
    savedReadFailure = false;
  },
  holdRead: () => {
    holdNextRead = true;
  },
  releaseRead: () => {
    releaseRead?.();
    releaseRead = undefined;
  },
  release: () => {
    releasePending?.();
    releasePending = undefined;
  },
  setCatalog: (catalog: typeof snapshot.catalog) => emit({ catalog }),
  externalLocation: (location: Location) => {
    emit({ location, revision: snapshot.revision + (location === snapshot.location ? 0 : 1) });
    settingsListeners.forEach((listener) => listener());
  },
  commitOtherWindowLocation: (location: Location) => {
    emit({ location, revision: snapshot.revision + (location === snapshot.location ? 0 : 1) });
  },
  notifySettingsChanged: () => {
    settingsListeners.forEach((listener) => listener());
  },
  memoryService,
  services: { memoryService, settingService } as IServiceAccessor,
  platform: {
    getInstalledEditors: async () => [],
    onSettingsChanged: (listener: () => void) => {
      settingsListeners.add(listener);
      return () => settingsListeners.delete(listener);
    },
    syncAppSettings: () => {
      emit({ syncs: snapshot.syncs + 1 });
      if (syncFailure) {
        syncFailure = false;
        throw new Error("Fixture postcommit broadcast failed");
      }
      settingsListeners.forEach((listener) => listener());
    },
  } as unknown as IPlatformService,
  setEnabled: async (memoryEnabled: boolean) => settingService.update({ memoryEnabled }),
};
